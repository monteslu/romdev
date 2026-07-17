// v0.94.0 feedback round (ActRaiser annotation agent, 2026-07-16):
//   #1 disasm({target:'rom'}) runs the 0.94.0 per-instruction M/X width
//      dataflow on 65816 (in-window rep/sep followed + entry-width inference),
//      so one range can be re-decoded under corrected widths without
//      regenerating a hand-annotated project.
//   #2 breakpoint({on:'write'}) conditionWidth:16 — 'equals' watches the HIGH
//      byte + verifies the low byte host-side (no useless $00-low matches);
//      'increase'/'decrease' compare the WORD host-side (a byte delta lies on
//      carry). Width auto-inferred when conditionValue > 255.
//   #3 memory({op:'read', offsets, compact:true}) — one {"0xOFF":"hex"} map
//      for the sample-N-flags pattern (~4x fewer tokens).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerMemoryTools } from "../src/mcp/tools/memory.js";
import { registerWatchMemoryTools } from "../src/mcp/tools/watch-memory.js";
import { _setHostForTest } from "../src/mcp/state.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

// ── #1 target:'rom' M/X width dataflow ──────────────────────────────────────

test("#1 disasm rom on 65816 follows an in-window rep #$30 (16-bit immediates decode full-width)", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-mx-rom-"));
  try {
    // clc/xce boilerplate skipped — straight to the width flip:
    //   sep #$30      ; 8-bit (redundant with the 8/8 entry — realistic anchor)
    //   lda #$56      ; 8-bit immediate
    //   rep #$30      ; 16-bit A + X/Y
    //   lda #$1234    ; 16-bit immediate — the 0.94.0 fix target
    //   ldx #$0002    ; 16-bit X immediate
    //   rts
    const code = [0xE2, 0x30, 0xA9, 0x56, 0xC2, 0x30, 0xA9, 0x34, 0x12, 0xA2, 0x02, 0x00, 0x60];
    const rom = new Uint8Array(0x8000).fill(0xEA);
    rom.set(code, 0);
    const romPath = path.join(dir, "mx.sfc");
    await writeFile(romPath, rom);
    const disasm = toolHandler(registerDisasmTools, "disasm", "mx1");
    const r = parse(await disasm({ target: "rom", path: romPath, startAddress: 0x8000, length: code.length, inline: true }));
    const asm = r.asm ?? r.source ?? "";
    assert.match(asm, /#\$1234/i, "lda #$1234 decodes at 16-bit width after the in-window rep");
    assert.match(asm, /#\$0002/i, "ldx #$0002 decodes at 16-bit X width");
    assert.doesNotMatch(asm, /\bbrk\b/i, "no desync fingerprint");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#1 disasm rom infers a 16-bit ENTRY width (no leading rep/sep to re-sync from)", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-mx-entry-"));
  try {
    // Window starts ALREADY in 16-bit mode (the caller set it): at the default
    // 8/8 seed this decodes lda #$34 + brk + garbage — entry inference must
    // pick the mM/xX entry that removes the symptoms.
    //   lda #$1234 / ldx #$0002 / sta $06A0 / rts
    const code = [0xA9, 0x34, 0x12, 0xA2, 0x02, 0x00, 0x8D, 0xA0, 0x06, 0x60];
    const rom = new Uint8Array(0x8000).fill(0xEA);
    rom.set(code, 0);
    const romPath = path.join(dir, "entry.sfc");
    await writeFile(romPath, rom);
    const disasm = toolHandler(registerDisasmTools, "disasm", "mx2");
    const r = parse(await disasm({ target: "rom", path: romPath, startAddress: 0x8000, length: code.length, inline: true }));
    const asm = r.asm ?? r.source ?? "";
    assert.match(asm, /#\$1234/i, "16-bit entry inferred — lda #$1234 decodes full-width");
    assert.doesNotMatch(asm, /\bbrk\b/i, "no desync fingerprint");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── #2 conditionWidth:16 ────────────────────────────────────────────────────

/** Fake SNES host: 8KB low RAM as system_ram, scripted watchpoint behavior. */
function fakeSnesHost({ ram = new Uint8Array(0x2000), onStep } = {}) {
  const h = {
    status: { platform: "snes", loaded: true, frameCount: 0 },
    _armed: null,
    _wp: { hits: 0 },
    watchpointSupported: () => true,
    setWatchpoint(addr, enabled, opts) {
      h._armed = enabled ? { addr, opts: opts ?? null } : null;
      if (!enabled) return { conditionApplied: false };
      return { conditionApplied: !!opts };
    },
    stepFrames() { h.frame = (h.frame ?? 0) + 1; if (onStep) onStep(h, h.frame); },
    getWatchpoint(clear) {
      const w = { ...h._wp };
      if (clear) h._wp = { ...h._wp, hits: 0 };
      return w;
    },
    readMemory(_region, offset, length) { return ram.slice(offset, offset + length); },
    getRegSnapshot: () => null,
  };
  h.ram = ram;
  return h;
}

test("#2 conditionWidth:16 equals — arms the HIGH byte, verifies the low byte host-side", async () => {
  const ram = new Uint8Array(0x2000);
  const host = fakeSnesHost({
    ram,
    onStep(h, frame) {
      if (frame === 2) {
        // frame 2: the game writes the word $2000 to $06A0/$06A1
        ram[0x6A0] = 0x00; ram[0x6A1] = 0x20;
        h._wp = { hits: 1, lastPC: 0x92CB, lastValue: 0x20, lastOldValue: 0x00 };
      }
    },
  });
  _setHostForTest("w16a", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "w16a");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0x06A0, condition: "equals", conditionValue: 0x2000, conditionWidth: 16, maxFrames: 5 }));
  assert.equal(r.found, true);
  assert.equal(r.conditionWidth, 16);
  assert.equal(host._armed?.addr ?? null, null, "disarmed after the run");
  assert.equal(r.watchedByte, "$6A1 (word's high byte, little-endian)", "the core watch sat on address+1");
  assert.equal(r.valueWord, "0x2000", "the WORD is reported, not just the byte");
  assert.match(r.note, /HIGH byte/, "note explains the high-byte arming");
});

test("#2 conditionWidth:16 equals keeps waiting when only the high byte matches", async () => {
  const ram = new Uint8Array(0x2000);
  const host = fakeSnesHost({
    ram,
    onStep(h, frame) {
      if (frame === 1) {
        // $2077 lands — high byte matches $20, low byte doesn't
        ram[0x6A0] = 0x77; ram[0x6A1] = 0x20;
        h._wp = { hits: 1, lastPC: 0x1111, lastValue: 0x20 };
      }
    },
  });
  _setHostForTest("w16b", host);
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "w16b");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0x06A0, condition: "equals", conditionValue: 0x2000, conditionWidth: 16, maxFrames: 3 }));
  assert.equal(r.found, false, "a $2077 write must NOT satisfy word == $2000");
});

test("#2 width 16 is INFERRED from conditionValue > 255", async () => {
  const host = fakeSnesHost({});
  _setHostForTest("w16c", host);
  let armedAddr = null, armedVal = null;
  const origSet = host.setWatchpoint;
  host.setWatchpoint = (addr, enabled, opts) => { if (enabled) { armedAddr = addr; armedVal = opts?.value; } return origSet(addr, enabled, opts); };
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "w16c");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0x06A0, condition: "equals", conditionValue: 0x2000, maxFrames: 2 }));
  assert.equal(r.found, false);
  assert.equal(armedAddr, 0x06A1, "no explicit conditionWidth — >255 value still arms the high byte");
  assert.equal(armedVal, 0x20, "core condition byte is the value's HIGH byte");
});

test("#2 conditionWidth:16 increase — word compare catches the carry a byte delta lies about", async () => {
  const ram = new Uint8Array(0x2000);
  ram[0x100] = 0xFF; ram[0x101] = 0x00; // word $00FF
  const host = fakeSnesHost({
    ram,
    onStep(h, frame) {
      if (frame === 2) {
        // $00FF -> $0100: LOW BYTE DECREASED (FF->00) — a byte-level 'increase'
        // condition on the low byte would call this a decrease and miss it.
        ram[0x100] = 0x00; ram[0x101] = 0x01;
        h._wp = { hits: 2, lastPC: 0xABCD, lastValue: 0x00 };
      }
    },
  });
  _setHostForTest("w16d", host);
  let armedOpts = "never-armed";
  const origSet = host.setWatchpoint;
  host.setWatchpoint = (addr, enabled, opts) => { if (enabled) armedOpts = opts ?? null; return origSet(addr, enabled, opts); };
  const bp = toolHandler(registerWatchMemoryTools, "breakpoint", "w16d");
  const r = parse(await bp({ on: "write", precision: "exact", address: 0x0100, condition: "increase", conditionWidth: 16, maxFrames: 5 }));
  assert.equal(r.found, true);
  assert.equal(r.oldValueWord, "0x00FF");
  assert.equal(r.valueWord, "0x0100", "the word increased across the carry");
  assert.equal(armedOpts, null, "plain (unconditioned) core watch — the word compare is host-side");
});

// ── #3 memory compact batched reads ─────────────────────────────────────────

test("#3 memory op:'read' offsets + compact:true returns one {\"0xOFF\":\"hex\"} map", async () => {
  const ram = new Uint8Array(0x1000);
  ram[0x6A0] = 0x00; ram[0x6A1] = 0x20; ram[0x10] = 0xAB;
  const host = {
    status: { platform: "snes", loaded: true, frameCount: 0 },
    readMemory: (_r, off, len) => ram.slice(off, off + (len ?? 1)),
  };
  _setHostForTest("cmp", host);
  const memory = toolHandler(registerMemoryTools, "memory", "cmp");
  const r = parse(await memory({ op: "read", region: "system_ram", offsets: [{ offset: 0x6A0, length: 2 }, 0x10], compact: true }));
  assert.deepEqual(r.reads, { "0x6a0": "0020", "0x10": "ab" });
  assert.equal(r.region, "system_ram");
  assert.ok(!Array.isArray(r.reads), "compact is a map, not the per-read object array");
});
