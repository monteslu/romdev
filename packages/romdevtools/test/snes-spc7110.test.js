// The SPC7110 in a recompiled SNES cart against snes9x (romdev's pinned core),
// on synthetic carts (test/snes-coproc-synth.js spc7110Rom / spc7110RtcRom).
// The expected WRAM hash of the chip cart is snes9x's after loadMedia + 60
// frame steps (memory read of system_ram); the cart runs 65 frames (its
// settle frame, then frame F + 4 is snes9x's frame F). The RTC cart's hash
// is the cart's own, which frame({op:'findDiverge'}) found equal to snes9x's
// WRAM at every one of 420 frames with snes9x's clock pinned to the cart's
// (the recompile section's `clock`), and which the must-differ check below
// shows depends on that clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom, recompileSection } from "../src/analysis/recompile/wat/snes/index.js";
import { WRAM, PROBE, PROBE_FIELDS } from "../src/analysis/recompile/wat/snes/layout.js";
import { emitWat } from "../src/analysis/recompile/wat/snes/index.js";
import { assembleWat } from "../src/analysis/recompile/wat/assemble.js";
import { RTC_CLOCK } from "../src/analysis/recompile/recompile-section.js";
import { spc7110Rom, spc7110RtcRom, runCart, spc7110WordRom } from "./snes-coproc-synth.js";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const ARMS = { armRanges: [[0x8000, 0xb000]] };

test("SPC7110: accepted on snes9x's SPC7110 HiROM board; the RTC variant declares the pinned clock", () => {
  const d = describeRom(spc7110Rom());
  assert.equal(d.coprocessor, "SPC7110");
  assert.equal(d.supported, true, d.refusal);
  assert.equal(d.board, "SPC7110HiROM");
  assert.equal(recompileSection(spc7110Rom()).json.clock, undefined);
  assert.deepEqual(recompileSection(spc7110RtcRom()).json.clock, { ...RTC_CLOCK });
});

test("SPC7110: math unit, data port, windows, decompression (CPU and DMA) and SRAM match snes9x byte for byte", async () => {
  const { mem, ex } = await runCart(spc7110Rom(), 65, ARMS);
  assert.equal(ex.dbg_trapped(), 0);
  const w = mem.subarray(WRAM, WRAM + 0x20000);
  const hex = (o, n) => [...w.subarray(o, o + n)].map((v) => v.toString(16).padStart(2, "0")).join(" ");
  assert.equal(w[0x10], 0x77, "the program ran to its end");
  // 0x1234 * 0x0056 unsigned; $4828-$482B, then the status bit
  assert.equal(hex(0x100, 16), "34 12 00 00 56 00 00 00 78 1d 06 00 00 00 00 80");
  // $D0 / $E0 / $F0 windows before and after $4831-$4833 move them
  assert.equal(hex(0x300, 6), "00 60 e9 2a f2 ee");
  assert.equal(hex(0x310, 6), "e9 1b f2 ef e9 08");
  // decompression: mode 0, first bytes from $4800
  assert.equal(hex(0x410, 4), "19 12 5a 00");
  // DMA from $4800 leaves $4302 at $4800; the length at $4809 dropped by every byte read
  assert.equal(hex(0x450, 3), "00 48 00");
  assert.equal(hex(0x460, 2), "00 01");
  assert.equal(sha1(w), "3d56c908d25b67a3dd43e25df8f3885ec2e6cffa");
});

test("SPC7110 RTC-4513: reads, writes, control registers and a midnight rollover on the host's frame clock", async () => {
  const { mem, ex } = await runCart(spc7110RtcRom(), 405, ARMS, RTC_CLOCK);
  assert.equal(ex.dbg_trapped(), 0);
  const w = mem.subarray(WRAM, WRAM + 0x20000);
  const hex = (o, n) => [...w.subarray(o, o + n)].map((v) => v.toString(16).padStart(2, "0")).join(" ");
  assert.equal(w[0x10], 0x77, "the program ran to its end");
  // 1999-12-31 23:59:57 written; about 2.7 s of frames later the clock is past
  // midnight, then control register 2 clears the seconds
  assert.equal(hex(0xe30, 19), "80 00 07 05 09 05 03 02 01 03 02 01 09 09 05 00 00 00 80");
  assert.equal(hex(0xe70, 19), "80 00 00 00 00 00 00 00 01 00 01 00 00 00 06 00 00 01 80");
  assert.equal(sha1(w), "a912e92840d36332914dc535ab914b7a0dbf1d35");
  // must differ: the same cart with the clock stopped never reaches midnight
  const stopped = await runCart(spc7110RtcRom(), 405, ARMS, { stepMs: 0 });
  assert.notEqual(sha1(stopped.mem.subarray(WRAM, WRAM + 0x20000)), sha1(w));
});

test("SPC7110: 16-bit accesses group their cycles by snes9x's map types, so the APU catches up where snes9x's does", async () => {
  // S9xGetWord reads MAP_SPC7110_ROM ($D0-$FF) byte by byte although the cart
  // keeps those blocks as ROM; bank $50 is MAP_SPC7110_DRAM mapped as ROM, so
  // a word written there is MAP_NONE (one grouped access); HiROM SRAM words
  // are grouped. Where the vblank line end inside each loop instruction is
  // processed (offsets from the instruction start), and the SPC700's count
  // at every frame end, are snes9x's (romdev's pinned core, the same image,
  // frames 1-600 after loadMedia; the cart's frame F + 5).
  const { rom, loopAt } = spc7110WordRom();
  assert.equal(sha1(rom), "1ee86af0e93e93757e931daa460494eaf1d3bea9", "the image snes9x was run with");
  const points = { [loopAt]: [32, 40, 48], [loopAt + 4]: [32, 48], [loopAt + 8]: [24, 40], [loopAt + 11]: [24, 40], [loopAt + 14]: [16, 22] };
  const d = describeRom(rom, ARMS);
  const { bytes } = await assembleWat(emitWat(rom, ARMS));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const seen = new Set();
  const counts = [];
  for (let f = 1; f <= 605; f++) {
    ex.wc_render();
    const mem = new Uint8Array(ex.memory.buffer);
    if (f > 5) counts.push(mem[d.memory.ARAM + 0x10], mem[d.memory.ARAM + 0x11]);
    const dv = new DataView(ex.memory.buffer);
    const pc = dv.getUint32(PROBE + PROBE_FIELDS.vblankpc, true) & 0xffff;
    const pts = points[pc];
    if (!pts) continue;
    const p = dv.getInt32(PROBE + PROBE_FIELDS.vblankpos, true);
    const st = dv.getInt32(PROBE + PROBE_FIELDS.vblankistart, true);
    assert.equal(p, st + pts.find((o) => st + o >= 1364), `frame ${f}: $${pc.toString(16)} from ${st}, line end at +${1364 - st}`);
    seen.add(pc);
  }
  assert.equal(seen.size, 5, "the line end fell inside every instruction of the loop");
  assert.equal(ex.dbg_trapped(), 0);
  assert.equal(sha1(Uint8Array.from(counts)), "1f8500e89bd06837806eeedcc85583ba69e9e86f");
});
