// findDiverge level:'instruction' - the instruction-level recompile differ.
//
// 1. The stream walker and aligner on synthetic pc streams, including the
//    controls that MUST report a divergence (a differ that cannot report
//    nonzero has proved nothing by reporting zero).
// 2. End to end on a SYNTHETIC NES ROM: recompiled by the NES backend with a
//    whole-frame trace ring, run against fceumm's free-running instruction
//    trace. The clean cart matches instruction for instruction (pc, cycle
//    cost, A/X/Y/S/P); the same cart built with options.breakArm (one arm a
//    deliberate no-op) is named at exactly that instruction.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { walkStreams, alignStreams, traceDescriptor, REFERENCE_PC, collapseHaltRepeats } from "../src/host/instruction-diverge.js";
import { validateRecompileLayout } from "../src/analysis/recompile/recompile-section.js";
import { recompileToWasmcart } from "../src/analysis/recompile/wat/build.js";
import { runInstructionDiverge } from "../src/mcp/tools/verify-recompile-op.js";
import { resolveCore } from "../src/cores/registry.js";

// ─── the walker ──────────────────────────────────────────────────────────────

const loop = (n, start = 0x8000) => Array.from({ length: n }, (_, k) => start + ((k * 3) % 200));

test("walk: identical streams match to the end and report nothing", () => {
  const a = loop(5000);
  const w = walkStreams(a, [...a]);
  assert.equal(w.matched, 5000);
  assert.equal(w.firstDivergence, null);
  assert.equal(w.exhausted, "both");
});

test("walk: a divergent tail is REPORTED at its first instruction (must-fail control)", () => {
  const a = loop(3000), b = [...loop(2000), ...loop(1000, 0x9000)];
  const w = walkStreams(a, b);
  assert.ok(w.firstDivergence, "the differ must be able to report a divergence");
  assert.equal(w.firstDivergence.cart, 2000);
  assert.equal(w.firstLogicDivergence.kind, "pc");
  assert.equal(w.matched, 2000);
});

test("walk: an interrupt taken at a different instruction is reported, then stripped", () => {
  const body = loop(400);
  const handler = [0xff00, 0xff02, 0xff04, 0xff06];
  // reference takes the handler before instruction 100, the cart before 103
  const b = [...body.slice(0, 100), ...handler, ...body.slice(100)];
  const a = [...body.slice(0, 103), ...handler, ...body.slice(103)];
  const w = walkStreams(a, b, { vectors: new Set([0xff00]) });
  assert.equal(w.firstDivergence.kind, "interrupt-timing");
  assert.equal(w.firstDivergence.ref, 100);
  assert.equal(w.strippedRef.length + w.strippedCart.length, 2, "both handler runs are cut");
  assert.equal(w.firstLogicDivergence, null, "no logic divergence once the handlers are stripped");
  assert.equal(w.exhausted, "both");
});

test("walk: same pcs, different cycle cost -> firstClockDivergence names the instruction", () => {
  const a = loop(50), b = [...a];
  const ca = a.map((_, k) => k * 4), cb = a.map((_, k) => k * 4 + (k > 20 ? 2 : 0));
  const w = walkStreams(a, b, { aClock: ca, bClock: cb });
  assert.equal(w.firstDivergence, null);
  assert.deepEqual([w.firstClockDivergence.cart, w.firstClockDivergence.cartCycles, w.firstClockDivergence.refCycles], [20, 4, 6]);
});

test("walk: registers that differ after an instruction name that instruction", () => {
  const a = loop(40), b = [...a];
  const w = walkStreams(a, b, { regDiff: (i) => (i >= 17 ? [{ reg: "a", cart: 1, ref: 2 }] : null) });
  assert.equal(w.firstRegisterDivergence.cart, 17);
  assert.deepEqual(w.firstRegisterDivergence.afterPair, [16, 16]);
});

test("align: direct at the frame start, unique window otherwise, ambiguity refused", () => {
  const body = Array.from({ length: 600 }, (_, k) => 0x8000 + ((k * 7919) % 4093));
  assert.equal(alignStreams(body, body).method, "frame-start");
  const shifted = alignStreams(body.slice(50), body);
  assert.equal(shifted.method, "window");
  assert.equal(shifted.ib - shifted.ia, 50);
  const spin = Array.from({ length: 600 }, (_, k) => 0x8000 + (k % 3));
  const amb = alignStreams(spin.slice(1), spin, { direct: false });
  assert.ok(amb.error && amb.ambiguous, "a tight loop matches everywhere: refuse, do not guess");
  assert.ok(alignStreams([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], { direct: false }).error);
});

test("trace descriptor: section `trace` validates; older carts derive theirs", () => {
  const good = validateRecompileLayout({ regions: {}, trace: { offset: 4096, entries: 1024, stride: 8, cursor: { offset: 64, mode: "count" }, pc: { offset: 0, mask: 0xffff } } });
  assert.equal(traceDescriptor(good, "nes").source, "section");
  assert.throws(() => validateRecompileLayout({ regions: {}, trace: { offset: 0, entries: 8, stride: 8, cursor: { offset: 0, mode: "index" } } }), /writable/);
  assert.throws(() => validateRecompileLayout({ regions: {}, trace: { offset: 0, entries: 8, stride: 8, cursor: { offset: 0 }, fields: { x: { offset: 8 } } } }), /inside/);
  const gb = traceDescriptor({ platform: "gb", regions: {} }, "gb");
  assert.equal(gb.source, "derived");
  assert.equal(gb.fields.sp.mask, 0xffff);
  assert.throws(() => traceDescriptor({ platform: "c64", regions: {} }, "c64"), /declares no instruction trace/);
  assert.equal(REFERENCE_PC.snes.ref(0x80b139), 0x00b139, "the $80 bank mirror normalises to the cart's bank 0");
  assert.equal(REFERENCE_PC.gba.cart({ pc: 0x08000100, fields: { thumb: 1 } }), 0x08000104, "the GBA core's pc is the Thumb pipeline pc");
});

test("halt repeats: a re-dispatched HALT collapses to one entry; loops and other repeats are kept", () => {
  const feed = (pcs, clk, step = 60) => { const h = collapseHaltRepeats(step); const kept = pcs.filter((p, k) => !h.repeat(p, clk[k])); return { kept, h }; };
  // HALT at $105 re-dispatched every 60 units, then the handler
  const { kept, h } = feed([0x104, 0x105, 0x105, 0x105, 0x105, 0x38, 0x3a], [0, 50, 110, 170, 230, 290, 400]);
  assert.deepEqual(kept, [0x104, 0x105, 0x38, 0x3a]);
  assert.equal(h.collapsed, 3);
  assert.equal(h.startedInRun(), false);
  // a self-loop (jr $, 12 T = 180 units) repeats on the cart too: kept
  assert.deepEqual(feed([0x200, 0x200, 0x200], [0, 180, 360]).kept, [0x200, 0x200, 0x200]);
  // the run survives a frame boundary (clock reset) once it has started
  assert.deepEqual(feed([0x105, 0x105, 0x105, 0x38], [3000, 3060, 20, 80]).kept, [0x105, 0x38]);
  assert.equal(feed([0x105, 0x105, 0x38], [0, 60, 120]).h.startedInRun(), true);
  // no step (a platform without the convention): nothing collapses
  assert.deepEqual(feed([0x105, 0x105], [0, 60], null).kept, [0x105, 0x105]);
});

// ─── end to end: synthetic NES cart vs fceumm ────────────────────────────────

/**
 * NROM-128. $C000: sei cld ldx #$FF txs lda #$80 sta $2000 (NMI on);
 * loop $C00A: lda $20 clc adc #7 sta $30 cmp #$10 bcc +2 inc $31 inc $10 jmp loop.
 * NMI $FF00: inc $20 rti.
 */
function synthNes() {
  const prg = new Uint8Array(0x4000).fill(0xea);
  prg.set([0x78, 0xd8, 0xa2, 0xff, 0x9a, 0xa9, 0x80, 0x8d, 0x00, 0x20,
    0xa5, 0x20, 0x18, 0x69, 0x07, 0x85, 0x30, 0xc9, 0x10, 0x90, 0x02, 0xe6, 0x31, 0xe6, 0x10, 0x4c, 0x0a, 0xc0], 0);
  prg.set([0xe6, 0x20, 0x40], 0x3f00);
  prg.set([0x00, 0xff, 0x00, 0xc0, 0x00, 0xff], 0x3ffa);
  const rom = new Uint8Array(16 + 0x4000 + 0x2000);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 1, 0]);
  rom.set(prg, 16);
  return rom;
}

const haveFceumm = (() => { try { return !!resolveCore("nes"); } catch { return false; } })();

test("NES end to end: clean cart matches fceumm instruction for instruction; a broken arm is named exactly", { skip: !haveFceumm && "fceumm not staged", timeout: 180000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-idiff-"));
  try {
    const romPath = path.join(dir, "synth.nes");
    writeFileSync(romPath, synthNes());
    const clean = path.join(dir, "clean.wasc"), broken = path.join(dir, "broken.wasc");
    await recompileToWasmcart({ platform: "nes", romPath, outputPath: clean, options: { traceEntries: 16384 } });
    await recompileToWasmcart({ platform: "nes", romPath, outputPath: broken, options: { traceEntries: 16384, breakArm: "C00D" } });

    const ok = await runInstructionDiverge("idiff-test-clean", { cart: clean, reference: romPath, atFrame: 20 });
    assert.equal(ok.trace.source, "section");
    assert.equal(ok.trace.cart.truncated, false);
    assert.ok(ok.matched > 1000, `a whole frame is compared (matched ${ok.matched})`);
    assert.equal(ok.diverged, false, JSON.stringify(ok.note));
    assert.equal(ok.conclusion, "no-divergence");
    assert.deepEqual(ok.registers.compared, ["a", "x", "y", "s", "p"]);
    assert.equal(ok.firstClockDivergence, null, "cycle costs agree");

    // default atFrame: the per-frame differ finds the first differing frame first
    const bad = await runInstructionDiverge("idiff-test-broken", { cart: broken, reference: romPath, maxFrames: 60 });
    assert.equal(bad.diverged, true);
    assert.ok(bad.frameLevel, "the frame was found by the per-frame differ");
    assert.equal(bad.registers.producedBy.pc, "$C00D", `names the broken adc: ${JSON.stringify(bad.registers)}`);
    assert.equal(bad.conclusion, "registers");
    assert.ok(bad.registers.firstDiffering.diffs.some((x) => x.reg === "a"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── end to end: a HALT-idle SMS cart vs genesis_plus_gx ─────────────────────

/**
 * $0000 jp $0100. $0038: in a,($BF); inc b; ld a,b; ei; reti.
 * $0100: di; im 1; R1 = $E0 (display, frame interrupt); ei; loop: halt; jr loop.
 * The reference re-dispatches the HALT every 4 T until the interrupt; the
 * cart records it once.
 */
function synthSmsHalt() {
  const rom = new Uint8Array(0x8000);
  rom.set([0xc3, 0x00, 0x01], 0);
  rom.set([0xdb, 0xbf, 0x04, 0x78, 0xfb, 0xed, 0x4d], 0x38);
  rom.set([0xf3, 0xed, 0x56, 0x3e, 0xe0, 0xd3, 0xbf, 0x3e, 0x81, 0xd3, 0xbf, 0xfb, 0x76, 0x18, 0xfd], 0x100);
  rom.set([..."TMR SEGA"].map((c) => c.charCodeAt(0)), 0x7ff0);
  rom[0x7fff] = 0x4c;
  return rom;
}

const haveGpgx = (() => { try { return !!resolveCore("sms"); } catch { return false; } })();

test("SMS end to end: a halted Z80 is compared through the whole frame; a broken handler arm is still named", { skip: !haveGpgx && "genesis_plus_gx not staged", timeout: 240000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-idiff-sms-"));
  try {
    const romPath = path.join(dir, "halt.sms");
    writeFileSync(romPath, synthSmsHalt());
    const clean = path.join(dir, "clean.wasc"), broken = path.join(dir, "broken.wasc");
    await recompileToWasmcart({ platform: "sms", romPath, outputPath: clean, options: { traceEntries: 4096 } });
    await recompileToWasmcart({ platform: "sms", romPath, outputPath: broken, options: { traceEntries: 4096, breakArm: "0038" } });
    const ok = await runInstructionDiverge("idiff-test-sms-halt", { cart: clean, reference: romPath, platform: "sms", atFrame: 12 });
    assert.ok(ok.trace.ref.haltRepeatsCollapsed > 1000, `the reference's HALT re-dispatches collapse (${JSON.stringify(ok.trace.ref)})`);
    assert.equal(ok.diverged, false, JSON.stringify(ok.note));
    assert.equal(ok.conclusion, "no-divergence", "compared to the end of BOTH streams, not only the cart's few entries");
    assert.ok(ok.matched >= 7, `the handler and the HALT are compared (matched ${ok.matched})`);
    const bad = await runInstructionDiverge("idiff-test-sms-halt-broken", { cart: broken, reference: romPath, platform: "sms", atFrame: 12 });
    assert.equal(bad.diverged, true, "the must-fail control diverges");
    assert.equal(bad.registers?.producedBy?.pc, "$0038", JSON.stringify(bad.registers ?? bad.firstDivergence));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
