// SA-1 tests on synthetic ROMs (test/snes-sa1-synth.js, never commercial
// ones). Each program runs on the recompiled cart and its state is compared
// with snes9x's after the same frames: the expected hashes were read from
// romdev's snes9x core (loadMedia + frame step N + memory read of
// system_ram, snes_fillram $3000-$37FF / $2200-$23FF, save_ram, video_ram);
// the cart runs N + 5 frames (snes9x's 5 settle frames against the cart's 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom, emitWat, emitWatString, recompileSection } from "./index.js";
import { assembleWat } from "../assemble.js";
import { sa1Regions, SA1_BOARD } from "./sa1.js";
import { VRAM } from "./layout.js";
import { sa1Programs } from "../../../../../test/snes-sa1-synth.js";

const sha1 = (b) => createHash("sha1").update(b).digest("hex");

async function runCart(rom, frames, opts = {}) {
  const { bytes } = await assembleWat(emitWat(rom, opts));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  for (let i = 0; i < frames; i++) ex.wc_render();
  const mem = new Uint8Array(ex.memory.buffer);
  const lay = describeRom(rom, opts).memory;
  const { FILL } = sa1Regions(lay.CHIP);
  return {
    ex, mem, lay, FILL,
    hashes: {
      wram: sha1(mem.subarray(0, 0x20000)),
      iram: sha1(mem.subarray(FILL + 0x3000, FILL + 0x3800)),
      sa1reg: sha1(mem.subarray(FILL + 0x2200, FILL + 0x2400)),
      bwram: sha1(mem.subarray(lay.SRAM, lay.SRAM + 0x2000)),
      vram: sha1(mem.subarray(VRAM, VRAM + 0x10000)),
    },
  };
}

/** snes9x's state after N frames (hashes of the regions above). */
const SNES9X = {
  basic: {
    frames: 3,
    wram: "6d883b8204e887cf418ce8195882e943854296a7", iram: "a68b39e8de4fbb692c843420fc01816ffeae90ec",
    sa1reg: "70abb0c58b98f6999fec36fb2a6bd67ea916335b", bwram: "2c5a3b45359dcb7c0412a7fa083911f664ebd73c",
    vram: "1adc95bebe9eea8c112d40cd04ab7a8d75c4f961",
  },
  irq: {
    frames: 5,
    wram: "cc25844c82b3af23f70603915150fd8021e1b77f", iram: "9efa98a62b445a996d889791a5e736ca844b64d4",
    sa1reg: "cffd5dd57e8cc4e2b7e97e6b30bdb7745a908364", bwram: "825dfb6f776e74179e08afee93e56e8faf6a61c0",
    vram: "1adc95bebe9eea8c112d40cd04ab7a8d75c4f961",
  },
  units: {
    frames: 4,
    wram: "7b06415920d8f5ce1d6dfadc1d37a0c04317ddd7", iram: "0fc5f9c77a88ae2604f5f38e966ccc89ba73a2cc",
    sa1reg: "b215995880f10f1eeaa160e9328adcd3788974bc", bwram: "e499da56a99024f88c07a4c490956669dc5afb82",
    vram: "680d890f11c06952a44b063e45b57ec79b4fc57d",
  },
};

function assertSnes9x(name, got) {
  const want = SNES9X[name];
  for (const k of ["wram", "iram", "sa1reg", "bwram", "vram"]) assert.equal(got[k], want[k], `${name}: ${k} differs from snes9x`);
}

test("an SA-1 cart is accepted on snes9x's SA-1 board; the section compares I-RAM, the SA-1 registers and BW-RAM", async () => {
  const rom = sa1Programs.basic();
  const d = describeRom(rom);
  assert.equal(d.supported, true, d.refusal);
  assert.equal(d.coprocessor, "SA-1");
  assert.equal(d.board, SA1_BOARD);
  const { json } = recompileSection(rom);
  const { FILL } = sa1Regions(d.memory.CHIP);
  assert.deepEqual(json.regions.iram, { offset: FILL + 0x3000, length: 0x800, ref: "snes_fillram", refOffset: 0x3000 });
  assert.deepEqual(json.regions.sa1reg, { offset: FILL + 0x2200, length: 0x200, ref: "snes_fillram", refOffset: 0x2200 });
  assert.equal(json.regions.bwram.ref, "save_ram");
  assert.equal(json.regions.bwram.length, 0x2000);
  assert.equal(json.diagnosticRegions.sram, undefined);
});

test("a plain cart carries none of the SA-1's code", async () => {
  const img = sa1Programs.basic();
  img[0x7fd6] = 0x00;          // ROM type: no coprocessor
  img[0x7fd5] = 0x20;
  const wat = await emitWatString(img);
  assert.doesNotMatch(wat, /\$sacpu|\$sa1_/);
});

test("SA-1 arithmetic, variable-length reads, BW-RAM / I-RAM / MMC views and both CPUs' clocks match snes9x", async () => {
  const r = await runCart(sa1Programs.basic(), SNES9X.basic.frames + 5);
  assert.equal(r.ex.dbg_trapped(), 0);
  const w = (a) => r.mem[a] | (r.mem[a + 1] << 8);
  // the two free-running counters (the SA-1's in I-RAM, the S-CPU's in WRAM)
  assert.equal(w(r.FILL + 0x3100), 0x9268, "SA-1 loop count (snes9x)");
  assert.equal(w(0x200), 0xd401, "S-CPU loop count (snes9x)");
  assertSnes9x("basic", r.hashes);
});

test("SA-1 <-> S-CPU interrupts: vector overrides, WAI on both CPUs, the SA-1 timer and H/V latch match snes9x", async () => {
  const r = await runCart(sa1Programs.irq(), SNES9X.irq.frames + 5);
  assert.equal(r.ex.dbg_trapped(), 0);
  assertSnes9x("irq", r.hashes);
});

test("SA-1 DMA, character conversion 1 and 2, bitmap views, BW-RAM banking, MMC and code in I-RAM / BW-RAM match snes9x", async () => {
  const opts = { armRanges: [[0, 0x8000]] };
  const r = await runCart(sa1Programs.units(), SNES9X.units.frames + 5, opts);
  assert.equal(r.ex.dbg_trapped(), 0);
  assert.equal(r.mem[r.FILL + 0x3000], 0x33, "the SA-1 finished");
  assertSnes9x("units", r.hashes);
});

test("must-fail control: one broken SA-1 instruction (options.breakArm) no longer matches snes9x", async () => {
  const rom = sa1Programs.basic();
  // the SA-1's `lda $2306` (the product's low byte): its arm also flips A
  let off = -1;
  for (let i = 0x200; i < 0x400; i++) if (rom[i] === 0xad && rom[i + 1] === 0x06 && rom[i + 2] === 0x23) { off = i; break; }
  assert.ok(off > 0);
  const r = await runCart(rom, SNES9X.basic.frames + 5, { breakArm: 0x8000 + off });
  assert.notEqual(r.hashes.iram, SNES9X.basic.iram);
  assert.equal(r.mem[r.FILL + 0x3010], 0x01, "the product's low byte, flipped");
});
