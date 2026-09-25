// The CX4 in a recompiled SNES cart against snes9x (romdev's pinned core),
// on synthetic carts (test/snes-coproc-synth.js cx4MathRom / cx4GfxRom).
// Expected hashes are snes9x's WRAM after loadMedia + N frame steps, read
// back through romdev; the cart runs N + 5 frames (its settle frame, then
// frame F + 4 is snes9x's frame F).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom } from "../src/analysis/recompile/wat/snes/index.js";
import { WRAM } from "../src/analysis/recompile/wat/snes/layout.js";
import { cx4MathRom, cx4GfxRom, runCart } from "./snes-coproc-synth.js";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");

test("CX4: a CX4 cart is accepted on snes9x's LoROM board with the chip at $6000-$7FFF", () => {
  const d = describeRom(cx4MathRom());
  assert.equal(d.coprocessor, "CX4");
  assert.equal(d.supported, true, d.refusal);
  assert.equal(d.board, "LoROM");
});

test("CX4: 576 arithmetic commands (sin/cos/atan/sqrt in doubles, products, polar) match snes9x bit for bit", async () => {
  // snes9x: frame 30
  const { mem, ex } = await runCart(cx4MathRom(), 35, { armRanges: [[0, 0x1000]] });
  assert.equal(ex.dbg_trapped(), 0);
  const w = mem.subarray(WRAM, WRAM + 0x20000);
  assert.equal(w[0x10], 0x77, "the program ran to its end");
  // the first run of command $05 (propulsion) on the first random block
  assert.equal([...w.subarray(0x2000, 0x2004)].map((v) => v.toString(16).padStart(2, "0")).join(" "), "4a 01 6e 33");
  assert.equal(sha1(w), "c8c2b65dec3556d8a24512ae24b607e3cd6524d9");
});

test("CX4: OAM build, scale/rotate, lines, wireframe, disintegrate, wave, ROM copy and test commands match snes9x", async () => {
  const rom = cx4GfxRom();
  // mid-run (snes9x frame 20) and at the end (frame 300): the timing of the
  // copies around the commands, then every case's 8KB
  const mid = await runCart(rom, 25, { armRanges: [[0, 0x1000]] });
  assert.equal(sha1(mid.mem.subarray(WRAM, WRAM + 0x20000)), "c35a55bf7ff3dff4d6c919c2f77b46e65d7d403f");
  const { mem, ex } = await runCart(rom, 305, { armRanges: [[0, 0x1000]] });
  assert.equal(ex.dbg_trapped(), 0);
  const w = mem.subarray(WRAM, WRAM + 0x20000);
  assert.equal(w[0x10], 0x77, "the program ran to its end");
  // $5C's test pattern, then $89's three bytes at $7F80 in the second case
  assert.equal([...w.subarray(0x4000, 0x4004)].map((v) => v.toString(16)).join(" "), "0 0 0 ff");
  assert.equal(sha1(w), "eee49a4754a9c5971e4a93710489ed69d168a574");
});
