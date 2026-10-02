// The S-DD1 of a recompiled SNES cart, as snes9x runs it:
//   - the decompressor is snes9x's sdd1emu.cpp compiled (the "sdd1" unit of
//     snes9x-chips.json, scripts/recompile-gen/snes9x-chips.mjs);
//   - dma.cpp's custom-chip block: a general DMA whose source address is
//     FIXED while $4801 is non-zero decompresses TransferBytes bytes from
//     the source's place in the cart into the unit's 64KB buffer and sends
//     those instead, with the A address stepping by +1 (or -1 with the
//     decrement bit) all the same; every DMA clears $4801;
//   - sdd1.cpp: $4800-$4807 read back what was written (S9xGetCPU returns
//     FillRAM there), and a write to $4804-$4807 maps 1MB (value & 7) of the
//     image at $C0-$CF / $D0-$DF / $E0-$EF / $F0-$FF (S9xSetSDD1MemoryMap);
//     reset maps 0-3 in order;
//   - memmap.cpp Map_SDD1LoROMMap (a LoROM board with HiROM banks $60-$7F
//     and $C0-$FF and LoROM SRAM at $70-$7F and $A0-$BF:$6000).
//
// A bank switch rewrites the cart's block table (MAPTAB) the way snes9x
// rewrites Memory.Map, so reads AND code in $C0-$FF follow it (the arms are
// per file offset). 1MB windows past the image read snes9x's zero-filled
// ROM buffer: here a 4KB zero page.
//
// Linear memory: the chip block lay.CHIP
//   +0x0000  FillRAM $4800-$4807
//   +0x1000  the zero page
//   +0x2000  the compiled unit (its statics, the decode buffer, its stack)
//
// Plain JS ESM + JSDoc.

import { ROM, MAPTAB } from "./layout.js";
import { unitWat, unitFn, unitStart, unitSize } from "./chip-unit.js";
import { chipRegions } from "./chips-snes9x.js";

const REGS = 0x0000, ZERO = 0x1000, UNIT = 0x2000;

/** Map_SDD1LoROMMap (map_System and map_WRAM are memmap.js's). */
function buildMap(api) {
  const { lorom, hirom, each, set, size, MAP_TYPE } = api;
  if (api.map !== "SDD1LoROM") return;   // a HiROM S-DD1 image keeps snes9x's Map_HiROMMap
  lorom(0x00, 0x3f, 0x8000, 0xffff, size);
  lorom(0x80, 0xbf, 0x8000, 0xffff, size);
  hirom(0x60, 0x7f, 0x0000, 0xffff, size, 0);
  hirom(0xc0, 0xff, 0x0000, 0xffff, size, 0);   // S9xResetSDD1 remaps these at power-on
  each(0x70, 0x7f, 0x0000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
  each(0xa0, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.LOSRAM));
}

/**
 * @param {import("./layout.js").SnesLayout & {CHIP: number}} lay
 */
function wat(lay) {
  const C = lay.CHIP;
  const decompress = unitFn("sdd1", "romdev_sdd1_decompress");
  const buffer = unitFn("sdd1", "romdev_sdd1_buffer");
  const start = unitStart("sdd1");
  return `
${unitWat("sdd1", C + UNIT)}
  ;; the unit's 64KB decode buffer (dma.cpp sdd1_decode_buffer)
  (global $sdd1_buf (mut i32) (i32.const 0))

  ;; S9xSetSDD1MemoryMap: 1MB of the image (value & 7) at bank $C0 + $10 * bank.
  ;; Block b of the 256 reads Memory.ROM + value * 1MB + b * 4KB.
  (func $sdd1_map (param $bank i32) (param $value i32)
    (local $b i32) (local $off i32) (local $e i32)
    (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.add (i32.const 0xC00) (i32.shl (local.get $bank) (i32.const 8))) (i32.const 3))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $b) (i32.const 256)))
      (local.set $off (i32.add (i32.shl (local.get $value) (i32.const 20)) (i32.shl (local.get $b) (i32.const 12))))
      (i32.store (local.get $e) (i32.const 1))
      (i32.store offset=4 (local.get $e)
        (if (result i32) (i32.le_u (i32.add (local.get $off) (i32.const 0x1000)) (i32.const ${lay.romlen}))
          (then (i32.add (i32.const ${ROM}) (local.get $off)))
          (else (i32.const ${C + ZERO}))))
      (local.set $e (i32.add (local.get $e) (i32.const 8)))
      (local.set $b (i32.add (local.get $b) (i32.const 1)))
      (br $l))))

  ;; S9xResetSDD1: $4800-$4803 = 0, $4804 + i = i and bank i maps 1MB i
  (func $chip_reset
    (local $i i32)
    ${start ? `(call ${start})` : ""}
    (global.set $sdd1_buf (call ${buffer}))
    (i32.store (i32.const ${C + REGS}) (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 4)))
      (i32.store8 (i32.add (i32.const ${C + REGS + 4}) (local.get $i)) (local.get $i))
      (call $sdd1_map (local.get $i) (local.get $i))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; S9xGetCPU: $4800-$4807 read FillRAM; the rest of the default case is open bus
  (func $chip_io_rd (param $x i32) (result i32)
    (if (i32.lt_u (i32.sub (local.get $x) (i32.const 0x4800)) (i32.const 8))
      (then (return (i32.load8_u (i32.add (i32.const ${C + REGS - 0x4800}) (local.get $x))))))
    (global.get $ob))

  ;; S9xSetCPU: $4804-$4807 switch a bank window (Byte & 7); FillRAM keeps the byte
  (func $chip_io_wr (param $x i32) (param $v i32)
    (if (i32.lt_u (i32.sub (local.get $x) (i32.const 0x4800)) (i32.const 8))
      (then
        (if (i32.ge_u (local.get $x) (i32.const 0x4804))
          (then (call $sdd1_map (i32.sub (local.get $x) (i32.const 0x4804)) (i32.and (local.get $v) (i32.const 7)))))
        (i32.store8 (i32.add (i32.const ${C + REGS - 0x4800}) (local.get $x)) (local.get $v)))))

  ;; dma.cpp S9xDoDMA, "S-DD1": a fixed source with $4801 non-zero decodes
  ;; into the buffer from S9xGetBasePointer(source) + AAddress (a ROM or RAM
  ;; block; anything else leaves the buffer as it was) and walks the address
  ;; by +1 / -1. $4801 is cleared by every DMA.
  (func $chip_dma (param $ch i32) (param $p i32) (param $src i32) (param $cnt i32) (result i32)
    (local $r i32) (local $e i32) (local $t i32)
    (if (i32.and (i32.ne (i32.and (local.get $p) (i32.const 0x08)) (i32.const 0))
                 (i32.ne (i32.load8_u (i32.const ${C + REGS + 1})) (i32.const 0)))
      (then
        (global.set $cdma_step (if (result i32) (i32.and (local.get $p) (i32.const 0x10)) (then (i32.const -1)) (else (i32.const 1))))
        (global.set $cdma_src (local.get $src))
        (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.shl (i32.shr_u (i32.and (local.get $src) (i32.const 0xFFFFFF)) (i32.const 12)) (i32.const 3))))
        (local.set $t (i32.load (local.get $e)))
        (if (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2)))
          (then (call ${decompress}
                  (i32.add (i32.load offset=4 (local.get $e)) (i32.and (local.get $src) (i32.const 0xFFF)))
                  ;; d->TransferBytes (0 decodes 64KB)
                  (i32.and (local.get $cnt) (i32.const 0xFFFF)))))
        (local.set $r (i32.const 1))))
    (i32.store8 (i32.const ${C + REGS + 1}) (i32.const 0))
    (local.get $r))
  ;; the transfer reads base[p] with p (uint16) stepping as the A address
  ;; does, so a decrementing one reads the buffer backwards from its end
  (func $chip_dma_byte (param $i i32) (result i32)
    (i32.load8_u (i32.add (global.get $sdd1_buf)
      (i32.and (i32.mul (local.get $i) (global.get $cdma_step)) (i32.const 0xFFFF)))))
`;
}

export const sdd1 = {
  id: "S-DD1",
  /** InitROM: Map_SDD1LoROMMap in the LoROM branch. */
  board: ({ hiRom }) => (hiRom ? null : "SDD1LoROM"),
  boards: ["SDD1LoROM"],
  buildMap,
  pages: Math.ceil((UNIT + unitSize("sdd1")) / 0x10000),
  wat,
  /** the chip's registers ($4800-$4807, snes9x keeps them in FillRAM) are compared */
  section: (d) => chipRegions(d, { sdd1reg: { offset: d.memory.CHIP + REGS, length: 8, ref: "snes_fillram", refOffset: 0x4800 } }, false),
};
