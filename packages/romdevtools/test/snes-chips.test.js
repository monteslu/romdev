// The SNES recompiler's snes9x HLE chips and the MSU-1 on synthetic carts:
// each case drives a chip's registers (snes-chips-synth.js) and the bytes it
// reads back must be the ones snes9x (romdev's pinned core) leaves in work
// RAM after the same frames. The expected strings were read from snes9x
// with the same images; before the chips were modelled every one of these
// carts was refused by describe().
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitWat, describe as describeRom } from "../src/analysis/recompile/wat/snes/index.js";
import { assembleWat } from "../src/analysis/recompile/wat/assemble.js";
import { AUDIO, AUDIO_FRAMES } from "../src/analysis/recompile/wat/snes/layout.js";
import { RTC_CLOCK } from "../src/analysis/recompile/recompile-section.js";
import { chipProgram, chipImage, CHIP_CASES, writeMsuTestPack, bsxTestBios, sufamiTestPair, srtcShowcase, msuShowcase } from "./snes-chips-synth.js";
import { createHash } from "node:crypto";

/** snes9x's bytes at $7E0100 onward (one per read), after the case's frames. */
const EXPECTED = {
  "DSP-1": "80804c0c412d412d827000000101f8010103808080808080808000000000090100ff8080808000000000090100ff",
  "DSP-1 HiROM": "808d04f0210fde80c44e02fe",
  "DSP-2": "60002606ea4636e43c6e9c4636ec344e9cc4b6ec344f1418f96d43b0a4e71e92d1cf6b1806166078058765432112346786ff",
  "DSP-3": "8484a700840000036000801f0000800040002004000200",
  "DSP-4": "80600026060000ffffffff000000000000600080",
  "ST010": "8000c0004c0c510008001000000020000093f81058fa0000",
  "ST011": "ff0044007700000000",
  "ST018": "00818181810081818181818181810000",
  "OBC1": "ffffffffffff11223344fb11223344fb99ff99ff5a99ff",
  "S-RTC": "0f00020301020204010a030500050f0f05040905030208020c090909020f0f06040905030208020c090909020f0f060409",
};

/**
 * Run a cart the way the wasmcart host does: wc_init, its settle frame,
 * then one wc_render per frame with the host's frame clock (timeMs = frame
 * * 1000/60) at the cart's time pointer. snes9x frame F (frames stepped
 * after loadMedia) is cart frame F + 4 after the settle frame: render F + 5.
 */
async function runCart(rom, refFrames, opts = {}, onFrame = null) {
  const { bytes } = await assembleWat(emitWat(rom, opts));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  const abi = ex.wc_get_info();
  ex.wc_init();
  const mem = () => new DataView(ex.memory.buffer);
  const timePtr = mem().getUint32(abi + 40, true);
  for (let f = 1; f <= refFrames + 5; f++) {
    mem().setFloat64(timePtr, (f - 1) * RTC_CLOCK.stepMs, true);
    ex.wc_render();
    onFrame?.(f, ex, abi);
  }
  return new Uint8Array(ex.memory.buffer);
}

const hex = (a) => Array.from(a, (v) => v.toString(16).padStart(2, "0")).join("");

for (const [name, c] of Object.entries(CHIP_CASES)) {
  test(`${name}: the chip's register traffic reads back what snes9x reads`, async () => {
    const { code, reads } = chipProgram(c.ops);
    const rom = chipImage({ code, ...c.image });
    const d = describeRom(rom);
    assert.equal(d.supported, true, d.refusal ?? "");
    assert.equal(d.coprocessor, name.split(" ")[0]);
    // arms only for the program's bank (the rest of the image is filler)
    const at = c.image.hirom ? 0x8000 : 0;
    const mem = await runCart(rom, c.frames ?? 3, { armRanges: [[at, at + 0x8000]] });
    assert.equal(mem[0xff], 0xa5, "the program ran to its end");
    assert.equal(hex(mem.subarray(0x100, 0x100 + reads)), EXPECTED[name]);
  });
}

test("ST018: snes9x only stubs the chip, and so does the cart (plain LoROM + map_SetaRISC at $3000-$3FFF)", () => {
  const { code } = chipProgram([]);
  const d = describeRom(chipImage({ code, mapMode: 0x30, romType: 0xf5 }));
  assert.equal(d.coprocessor, "ST018");
  assert.equal(d.board, "LoROM");
  // InitROM case 0xF530: SRAMSize = 2 whatever the header says
  assert.equal(d.sramSizeByte, 2);
});

test("MSU-1: a data file and PCM tracks beside the ROM, read, DMA'd and mixed as snes9x does", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-msu1-"));
  try {
    const romPath = writeMsuTestPack((p, b) => writeFileSync(p, b), path.join(dir, "msutest"));
    const rom = new Uint8Array((await import("node:fs")).readFileSync(romPath));
    const d = describeRom(rom, { romPath });
    assert.deepEqual(d.msu, { dataBytes: 4096, tracks: [1, 2] });
    // without the pack beside it the same ROM is a plain cart
    assert.equal(describeRom(rom).msu, null);
    // the published audio of snes9x frames 1-300 (renders 6-305), FNV-1a over the s16 samples
    let h = 0x811c9dc5, n = 0, pub = 0;
    const mem = await runCart(rom, 300, { romPath }, (f, ex, abi) => {
      const dv = new DataView(ex.memory.buffer);
      const w = dv.getUint32(dv.getUint32(abi + 24, true), true);
      if (f >= 6) {
        for (let i = pub; i !== w; i = (i + 1) & (AUDIO_FRAMES - 1)) {
          for (const o of [0, 2]) {
            const u = dv.getUint16(AUDIO + i * 4 + o, true);
            h = Math.imul(h ^ (u & 0xff), 0x01000193) >>> 0;
            h = Math.imul(h ^ (u >> 8), 0x01000193) >>> 0;
            n++;
          }
        }
      }
      pub = w;
    });
    assert.equal(hex(mem.subarray(0x100, 0x110)), "02532d4d535531f6fd040b0a02325555", "ID, data reads and status");
    assert.equal(hex(mem.subarray(0x200, 0x240)), "121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4ebf2f900070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cb", "DMA from $2001");
    assert.equal(hex(mem.subarray(0x10, 0x13)), "855632");
    assert.equal(n, 319874, "snes9x's sample count (S9xGetSampleCount with the MSU-1)");
    assert.equal(h.toString(16), "4ec960ed", "snes9x's samples, DSP and MSU-1 mixed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BS-X: a BIOS run by itself gets snes9x's MMC, PSRAM, flash commands, remap and satellite clock (bsx.cpp)", async () => {
  const { img, reads } = bsxTestBios();
  const d = describeRom(img);
  assert.equal(d.coprocessor, "BS-X");
  assert.equal(d.board, "BSX");
  assert.ok(d.layout && d.supported, d.refusal ?? "");
  // the BIOS runs from BIOSROM (ROM + $300000): only it gets arms
  const mem = await runCart(img, 3);
  assert.equal(mem[0xff], 0xa5, "the program ran to its end");
  assert.equal(hex(mem.subarray(0x100, 0x100 + reads)),
    "000080800080808080800080000080123400000000000000000000001212780010800001909000000000100101000000140d16030e0be70700000f");
});

test("Sufami Turbo: the BIOS by itself (Map_SufamiTurboPseudoLoROMMap) and a cart in slot A (Map_SufamiTurboLoROMMap)", async () => {
  const { bios, cart, reads } = sufamiTestPair();
  const d = describeRom(bios);
  assert.equal(d.board, "SufamiTurboPseudoLoROM");
  assert.equal(d.sramSizeByte, 5, "InitROM: SRAMSize = 5");
  let mem = await runCart(bios, 3);
  assert.equal(mem[0xff], 0xa5);
  assert.equal(hex(mem.subarray(0x100, 0x100 + reads)), "0000000000000022222233443344");
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-sufami-"));
  try {
    const romPath = path.join(dir, "cart.st");
    writeFileSync(romPath, cart);
    // snes9x (libretro LoadBIOS) needs STBIOS.bin beside the cart
    assert.match(describeRom(cart, { romPath }).refusal, /STBIOS\.bin/);
    writeFileSync(path.join(dir, "STBIOS.bin"), bios);
    const dc = describeRom(cart, { romPath });
    assert.equal(dc.board, "SufamiTurboLoROM");
    assert.deepEqual(dc.companionFiles, ["/STBIOS.bin"]);
    mem = await runCart(cart, 3, { romPath });
    assert.equal(mem[0xff], 0xa5);
    assert.equal(hex(mem.subarray(0x100, 0x100 + reads)), "42530841424142222222707022f0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a BS cart without BS-X.bin beside it is refused with the file named", () => {
  const c = new Uint8Array(0x100000);
  c.set(Array.from("SYNTH BS CART   ", (x) => x.charCodeAt(0)), 0x7fc0);
  c[0x7fd5] = 0x80; c[0x7fd6] = 0x10; c[0x7fd7] = 0x01; c[0x7fd8] = 0x20; c[0x7fda] = 0x33;
  const d = describeRom(c);
  assert.equal(d.supported, false);
  assert.match(d.refusal, /BS-X\.bin/);
});

// The showcase carts draw their chip's state (work RAM $0100-$01FF as tiles,
// scrolled) and play a tone, so verifyRecompile can score them; here their
// state and map after snes9x frame 300 are snes9x's.
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
test("S-RTC showcase: the running clock in the picture, on the reference's frame clock", async () => {
  const mem = await runCart(srtcShowcase(), 300);
  assert.equal(sha1(mem.subarray(0x100, 0x200)), "2061414a4a391d428992adc8f97ba4d24dbc892c");
  assert.equal(sha1(mem.subarray(0x20800, 0x20c00)), "969a9745be052f95f10a05ab4bccb5debfe4103f", "BG1 map in VRAM");
});
test("MSU-1 showcase: the data stream and status in the picture", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-msu1s-"));
  try {
    const stem = path.join(dir, "show");
    writeMsuTestPack((p, b) => writeFileSync(p, b), stem);
    writeFileSync(stem + ".sfc", msuShowcase());
    const mem = await runCart(msuShowcase(), 300, { romPath: stem + ".sfc" });
    assert.equal(sha1(mem.subarray(0x100, 0x200)), "fc42f8c33ae26cf4fa2d919228155aa1c908409c");
    assert.equal(sha1(mem.subarray(0x20800, 0x20c00)), "e21dec71cd42060a5cd05851d626d817d7f3c1f5", "BG1 map in VRAM");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
