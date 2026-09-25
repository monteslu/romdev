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
import { WRAM } from "../src/analysis/recompile/wat/snes/layout.js";
import { RTC_CLOCK } from "../src/analysis/recompile/recompile-section.js";
import { spc7110Rom, spc7110RtcRom, runCart } from "./snes-coproc-synth.js";

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
