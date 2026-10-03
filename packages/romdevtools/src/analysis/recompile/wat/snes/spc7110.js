// The SPC7110 (with its RTC-4513 on $F9 carts) of a recompiled SNES cart, as
// snes9x runs it: the chip is snes9x's spc7110.cpp with byuu and neviksti's
// spc7110emu.cpp / spc7110dec.cpp compiled (the "spc7110" unit of
// snes9x-chips.json, scripts/recompile-gen/snes9x-chips.mjs):
//   - $4800-$4842 (S9xGetCPU / S9xSetCPU's default case at $4800 and up:
//     S9xGetSPC7110 / S9xSetSPC7110; past $483F only with the RTC): the
//     decompressor, the data ROM port, the multiply / divide unit, the bank
//     registers and the RTC;
//   - bank $50 (MAP_SPC7110_DRAM) reads the decompressor ($4800);
//   - banks $D0-$FF (MAP_SPC7110_ROM) are 1MB windows on the data ROM set by
//     $4831-$4833 (dx/ex/fx_offset); the cart keeps them as ROM blocks in its
//     block table, rewritten after a bank write, so reads and code follow;
//   - dma.cpp: a DMA from $4800 (any bank) or bank $50 takes TransferBytes
//     bytes from the decompressor, lowers the length at $4809/$480A by them,
//     and moves the A address back by the count first (then +1 per byte);
//   - memmap.cpp Map_SPC7110HiROMMap.
// The RTC reads time() (emscripten: trunc(Date.now() / 1000)); the cart's
// time() is the wasmcart host's frame clock from RTC_CLOCK.baseMs, and the
// recompile section's `clock` has the verifier pin snes9x's Date.now() to the
// same clock, as the GB MBC3 and GBA GPIO RTCs do.
//
// Linear memory: the chip block lay.CHIP
//   +0x00000  a 4KB zero page (windows past the image read snes9x's zeroed
//             ROM buffer)
//   +0x01000  the compiled unit
//   +0x10000  the 64KB DMA buffer
//   +0x20000  the chip's state for the verifier (chip-unit.js chipstateWat),
//             its last 32 bytes the options.saveRtc image
//
// Plain JS ESM + JSDoc.

import { ROM, MAPTAB } from "./layout.js";
import { mapMirror } from "./memmap.js";
import { unitWat, unitFn, unitStart, unitSize, chipstateWat, chipstateRegion, rtcRestoreWat } from "./chip-unit.js";
import { chipRegions, chipTimeWat } from "./chips-snes9x.js";
import { RTC_CLOCK } from "../../recompile-section.js";

const ZERO = 0x0000, UNIT = 0x1000, DMABUF = 0x10000, STATE = 0x20000, RTCSLOT = STATE + 0xffe0;
if (UNIT + unitSize("spc7110") > DMABUF) throw new Error("spc7110: the compiled unit outgrew its slot");


/** Map_SPC7110HiROMMap (map_System and map_WRAM are memmap.js's). */
function buildMap(api, lay) {
  const { each, set, hirom, size, MAP_TYPE } = api;
  each(0x00, 0x00, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
  hirom(0x00, 0x0f, 0x8000, 0xffff, size);
  each(0x30, 0x30, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.HISRAM));
  // map_hirom_offset(0x40, 0x4f, 0, 0xffff, CalculatedSize, 0x600000) when ROMSize >= 13
  if (api.romSizeByte >= 13) {
    each(0x40, 0x4f, 0x0000, 0xffff, (c, i, p) => {
      const pos = 0x600000 + mapMirror(size, (c - 0x40) << 16) + i;
      set(p, MAP_TYPE.ROM, pos + 0x1000 <= size ? ROM + pos : lay.CHIP + ZERO);
    });
  }
  each(0x50, 0x50, 0x0000, 0xffff, (c, i, p) => set(p, MAP_TYPE.CHIP));
  hirom(0x80, 0x8f, 0x8000, 0xffff, size);
  hirom(0xc0, 0xcf, 0x0000, 0xffff, size, 0);
  // $D0-$FF: filled by $spc7110_map at reset
}

/**
 * @param {any} lay
 * @param {any} d  describe() of the cart
 */
function wat(lay, d) {
  const C = lay.CHIP;
  const fn = (n) => unitFn("spc7110", n);
  const start = unitStart("spc7110");
  const rtc = d.chipset === 0xf9 ? 1 : 0;
  const restore = rtcRestoreWat("spc7110", "romdev_spc7110_rtcdata", d.saveRtcBytes, C + RTCSLOT);
  return restore.data + chipstateWat("spc7110", "romdev_spc7110_chipstate", C + STATE) + `
${unitWat("spc7110", C + UNIT)}
  ;; time(): the host's frame clock, lagged to snes9x's settle frames as every
  ;; snes9x chip clock is (chips-snes9x.js chipTimeWat; RTC_CLOCK pins the reference)${chipTimeWat(lay)}

  ;; $D0-$FF from dx/ex/fx_offset: block b of window w reads Memory.ROM[offset + b * 4KB]
  (func $spc7110_map
    (local $w i32) (local $b i32) (local $off i32) (local $e i32)
    (local.set $e (i32.add (i32.const ${MAPTAB}) (i32.const ${0xd00 * 8})))
    (block $dw (loop $lw
      (br_if $dw (i32.ge_u (local.get $w) (i32.const 3)))
      (local.set $b (i32.const 0))
      (block $d (loop $l
        (br_if $d (i32.ge_u (local.get $b) (i32.const 256)))
        (local.set $off (i32.add (call ${fn("romdev_spc7110_offset")} (local.get $w)) (i32.shl (local.get $b) (i32.const 12))))
        (i32.store (local.get $e) (i32.const 1))
        (i32.store offset=4 (local.get $e)
          (if (result i32) (i32.le_u (i32.add (local.get $off) (i32.const 0x1000)) (i32.const ${lay.romlen}))
            (then (i32.add (i32.const ${ROM}) (local.get $off)))
            (else (i32.const ${C + ZERO}))))
        (local.set $e (i32.add (local.get $e) (i32.const 8)))
        (local.set $b (i32.add (local.get $b) (i32.const 1)))
        (br $l)))
      (local.set $w (i32.add (local.get $w) (i32.const 1)))
      (br $lw))))

  ;; InitROM: S9xInitSPC7110 (after the image is loaded), then S9xReset's S9xResetSPC7110
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${fn("romdev_spc7110_init")} (i32.const ${ROM}) (i32.const ${lay.romlen}) (i32.const ${rtc}))
    (call ${fn("romdev_spc7110_reset")})
    ${restore.call}
    (call $spc7110_map))

  ;; S9xGetCPU: at $4800 and up S9xGetSPC7110 (its unknown addresses read OpenBus)
  (func $chip_io_rd (param $x i32) (result i32)
    (if (i32.lt_u (local.get $x) (i32.const 0x4800)) (then (return (global.get $ob))))
    (call ${fn("romdev_set_openbus")} (global.get $ob))
    (call ${fn("romdev_spc7110_get")} (local.get $x)))
  ;; S9xSetCPU: at $4800 and up S9xSetSPC7110; a bank register moves $D0-$FF
  (func $chip_io_wr (param $x i32) (param $v i32)
    (if (i32.lt_u (local.get $x) (i32.const 0x4800)) (then (return)))
    (call ${fn("romdev_spc7110_set")} (local.get $v) (local.get $x))
    (if (i32.lt_u (i32.sub (local.get $x) (i32.const 0x4831)) (i32.const 3)) (then (call $spc7110_map))))

  ;; MAP_SPC7110_DRAM (bank $50): S9xGetSPC7110(0x4800); writes go nowhere (a ROM block)
  (func $chip_rd (param $a i32) (result i32)
    (call ${fn("romdev_set_openbus")} (global.get $ob))
    (call ${fn("romdev_spc7110_get")} (i32.const 0x4800)))

  ;; dma.cpp S9xDoDMA, "SPC7110"
  (func $chip_dma (param $ch i32) (param $p i32) (param $src i32) (param $cnt i32) (result i32)
    (if (i32.eqz (i32.or (i32.eq (i32.and (local.get $src) (i32.const 0xFFFF)) (i32.const 0x4800))
                         (i32.eq (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 0xFF)) (i32.const 0x50))))
      (then (return (i32.const 0))))
    ;; d->TransferBytes bytes from the decompressor, $4809/$480A lowered by them
    (call ${fn("romdev_spc7110_dma")} (i32.const ${C + DMABUF}) (i32.and (local.get $cnt) (i32.const 0xFFFF)))
    ;; inc = 1; d->AAddress -= count
    (global.set $cdma_step (i32.const 1))
    (global.set $cdma_src (i32.or (i32.and (local.get $src) (i32.const 0xFF0000))
                                  (i32.and (i32.sub (local.get $src) (local.get $cnt)) (i32.const 0xFFFF))))
    (i32.const 1))
  (func $chip_dma_byte (param $i i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${C + DMABUF}) (i32.and (local.get $i) (i32.const 0xFFFF)))))
`;
}

export const spc7110 = {
  id: "SPC7110",
  /** InitROM: Map_SPC7110HiROMMap in the HiROM branch. */
  board: ({ hiRom }) => (hiRom ? "SPC7110HiROM" : null),
  boards: ["SPC7110HiROM"],
  buildMap: (api, lay) => { if (api.map === "SPC7110HiROM") buildMap(api, lay); },
  pages: (STATE + 0x10000) / 0x10000,
  // getset.h: S9xGetWord reads MAP_SPC7110_ROM ($D0-$FF, kept as ROM blocks
  // by $spc7110_map) byte by byte; bank $50 (MAP_SPC7110_DRAM) is mapped
  // MAP_TYPE_ROM, so a word written there is MAP_NONE: one grouped access.
  wordBus: { readByByte: [[0xd0, 0xff]], writeGrouped: [[0x50, 0x50]] },
  wat,
  /** the RTC-4513 ($F9 carts) reads the host's frame clock; the verifier pins snes9x's time() to it */
  // its registers, decompressor and RTC (chipstate) and the battery SRAM the
  // games keep their state in are compared
  section: (d) => ({ ...(d.chipset === 0xf9 ? { clock: { ...RTC_CLOCK } } : {}), ...chipRegions(d, chipstateRegion("spc7110", "romdev_spc7110_chipstate", d.memory.CHIP + STATE), true) }),
  rtc: (d) => d.chipset === 0xf9,
};
