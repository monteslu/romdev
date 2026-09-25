// The S-DD1 in a recompiled SNES cart against snes9x (romdev's pinned core),
// on a synthetic cart (test/snes-coproc-synth.js sdd1Rom). The expected
// values were read back from snes9x through romdev (loadMedia platform snes
// + frame step 10 + memory read of system_ram / video_ram); the cart runs
// 15 frames (its settle frame, then frame F + 4 is snes9x's frame F).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom } from "../src/analysis/recompile/wat/snes/index.js";
import { WRAM, VRAM } from "../src/analysis/recompile/wat/snes/layout.js";
import { sdd1Rom, runCart } from "./snes-coproc-synth.js";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");

test("S-DD1: an S-DD1 cart is accepted on snes9x's SDD1 LoROM board", () => {
  const d = describeRom(sdd1Rom());
  assert.equal(d.coprocessor, "S-DD1");
  assert.equal(d.supported, true, d.refusal);
  assert.equal(d.board, "SDD1LoROM");
});

test("S-DD1: registers, bank windows and DMA decompression match snes9x byte for byte", async () => {
  const rom = sdd1Rom();
  // arms for the program only; the rest of the 2MB is data
  const { mem, ex } = await runCart(rom, 15, { armRanges: [[0, 0x1000]] });
  assert.equal(ex.dbg_trapped(), 0);
  const w = mem.subarray(WRAM, WRAM + 0x20000);
  const hex = (o, n) => [...w.subarray(o, o + n)].map((v) => v.toString(16).padStart(2, "0")).join(" ");
  // power-on $4800-$4807 (S9xResetSDD1), then open bus at $4808 / $4900
  assert.equal(hex(0x100, 11), "00 00 00 00 00 01 02 03 48 49 55");
  // written bytes read back whole; $4805 = 1 put 1MB 1 at $D0, $4807 = 9 maps 1MB 1 at $F0
  assert.equal(hex(0x110, 8), "a5 00 5a 33 00 01 00 09");
  // reads through the windows, the one past the image (zeros), $60-$6F and $00-$3F
  assert.equal(hex(0x120, 11), "00 05 01 eb 78 10 00 00 00 ae c9");
  // $4801 cleared by a plain transfer; fixed + decrement walks $4302 down;
  // count 0 moves 64KB; the last store ran
  assert.equal(hex(0x300, 1), "00");
  assert.equal(hex(0x310, 5), "00 ff c2 00 00");
  assert.equal(hex(0x320, 5), "00 00 ca 00 00");
  assert.equal(hex(0x330, 1), "77");
  // every stream's $43x2-$43x6 (the address moved by the length) and $4801
  assert.equal(hex(0x200, 6), "00 02 c1 00 00 00");
  assert.equal(hex(0x250, 6), "23 81 13 00 00 00");
  assert.equal(hex(0x258, 6), "77 07 d5 00 00 00");
  // all of WRAM (the decoded streams at $7F0000+) and VRAM (64KB decoded), as snes9x
  assert.equal(sha1(w), "0bbd60b1060bffc85652c9491a39ab77e615824a");
  assert.equal(sha1(mem.subarray(VRAM, VRAM + 0x10000)), "acdcb8663888dead86cd02c0f2fe48b6e07f0cea");
});
