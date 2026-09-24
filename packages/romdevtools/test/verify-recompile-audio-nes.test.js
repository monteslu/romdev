// frame({op:'verifyRecompile', audio:'required'}) against the REAL fceumm core:
// a tiny hand-assembled NROM program that starts all four tone channels, built
// into a wasmcart by the NES WAT backend (whose APU ports fceumm's low-quality
// renderer), then verified through the MCP op glue with the reference core
// loaded by romdev. Proves the per-frame capture, the pairing on the frame
// axis and the controls on a real libretro stream; a cart with a channel
// muted at build time is the must-fail control.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recompileToWasmcart } from "../src/analysis/recompile/wat/build.js";
import { runVerifyRecompile, runRecompileDiverge } from "../src/mcp/tools/verify-recompile-op.js";
import { resolveCore } from "../src/cores/registry.js";
import { clearHost } from "../src/mcp/state.js";

// $C000: sei; cld; $4015=$0F; square 1 $9F/$00/$80/$08; triangle $FF/$40/$08;
// noise $3F/$05/$08; loop: inc $10; jmp loop. Every other vector at $C000.
function apuRom() {
  const w = (a, v) => [0xA9, v, 0x8D, a & 0xFF, a >> 8];
  const code = [0x78, 0xD8, ...w(0x4015, 0x0F),
    ...w(0x4000, 0x9F), ...w(0x4001, 0x00), ...w(0x4002, 0x80), ...w(0x4003, 0x08),
    ...w(0x4008, 0xFF), ...w(0x400A, 0x40), ...w(0x400B, 0x08),
    ...w(0x400C, 0x3F), ...w(0x400E, 0x05), ...w(0x400F, 0x08)];
  const loop = 0xC000 + code.length;
  code.push(0xE6, 0x10, 0x4C, loop & 0xFF, loop >> 8);
  const prg = new Uint8Array(0x4000).fill(0xEA);
  prg.set(code, 0);
  prg.set([0x00, 0xC0, 0x00, 0xC0, 0x00, 0xC0], 0x3FFA);
  const rom = new Uint8Array(16 + 0x4000 + 0x2000);
  rom.set([0x4E, 0x45, 0x53, 0x1A, 1, 1, 0x01, 0]);
  rom.set(prg, 16);
  return rom;
}

const haveCore = (() => { const c = resolveCore("nes"); return !!c && existsSync(c.wasmPath); })();

test("a recompiled NES cart's audio is sample-exact with fceumm through the op; a cart with a muted channel is not", { skip: !haveCore && "fceumm wasm not built", timeout: 300000 }, async () => {
  const dir = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", ".audio-nes-"));
  try {
    const romPath = path.join(dir, "apu.nes");
    writeFileSync(romPath, apuRom());
    const good = path.join(dir, "apu.wasc"), muted = path.join(dir, "apu-muted.wasc");
    await recompileToWasmcart({ platform: "nes", romPath, outputPath: good });
    await recompileToWasmcart({ platform: "nes", romPath, outputPath: muted, options: { muteChannels: ["sq1"] } });

    const key = "audio-nes-e2e";
    const r = await runVerifyRecompile(key, { cart: good, reference: romPath, atFrames: [60, 120], controls: [], audio: "required", audioWav: true, outputDir: dir, tag: "apu" });
    const a = r.audio;
    assert.equal(a.mode, "exact");
    assert.equal(a.refRate, 48000);
    assert.equal(a.cartRate, 48000);
    assert.equal(a.verdict, "AUDIO VERIFIED", JSON.stringify({ reasons: a.reasons, first: a.firstMismatch, count: a.firstCountMismatch }));
    assert.equal(a.exactPct, 100);
    assert.equal(a.countMismatchFrames, 0);
    assert.equal(a.xcorr.lag, 0);
    assert.equal(a.ref.silent, false);
    for (const c of ["silence", "shift", "stereoDrop", "channelDrop"]) assert.equal(a.controls[c].failed, true, `${c}: ${JSON.stringify(a.controls[c])}`);
    assert.ok(existsSync(a.wavs.diff));

    const bad = await runVerifyRecompile(key, { cart: muted, reference: romPath, atFrames: [60, 120], controls: [], audio: "required", audioControls: [] });
    assert.equal(bad.audio.verdict, "AUDIO DIFFERS");
    assert.ok(bad.audio.exactPct < 50, `a muted square is most of the stream: ${bad.audio.exactPct}`);
    assert.equal(bad.verdict, "NOT VERIFIED");

    const d = await runRecompileDiverge(key, { cart: muted, reference: romPath, audio: true, regions: {}, maxFrames: 60 });
    assert.equal(d.diverged, true);
    assert.ok(d.audio && d.audio.refFrame >= 1, JSON.stringify(d.audio));
    const ok = await runRecompileDiverge(key, { cart: good, reference: romPath, audio: true, maxFrames: 120 });
    assert.equal(ok.diverged, false, JSON.stringify(ok));
    assert.equal(ok.audio.referenceSilent, false);
    clearHost?.(key);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
