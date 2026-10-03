// The Satellaview (BS-X) in a recompiled cart: snes9x's bsx.cpp (compiled,
// chip-unit.js 'bsx') owns the whole memory map, as it does in snes9x:
// BSX_Map rebuilds Memory.Map[] on reset and whenever the program writes
// the MMC's $0E:5000 with registers changed, and the unit's glue writes it
// into the cart's block table (MAPTAB) as it goes. The image is laid out as
// snes9x's ROM buffer (addon-carts.js): flash at 0, BIOSROM at $300000,
// PSRAM at $400000. Only the BIOS (and a BS cart's own bytes) get arms;
// flash and PSRAM run in the RAM interpreter, as their bytes can change.
//
//   getset.h MAP_BSX          $chip_rd / $chip_wr (S9xGetBSX / S9xSetBSX)
//   ppu.cpp $2188-$219F       $chip_b_rd / $chip_b_wr (S9xGetBSXPPU / S9xSetBSXPPU)
//   InitROM / S9xReset        S9xInitBSX, then S9xResetBSX ($chip_reset)
//   the satellite clock       S9xBSXGetRTC's time() on the host frame clock
//
// Plain JS ESM + JSDoc.

import { unitWat, unitSize, unitFn, unitStart, chipstateWat, chipstateRegion } from "./chip-unit.js";
import { chipTimeWat, chipRegions } from "./chips-snes9x.js";
import { ROM, WRAM, MAPTAB } from "./layout.js";
import { RTC_CLOCK } from "../../recompile-section.js";

/** The page after the unit, where the cart keeps the chip's state. */
const bsxState = (lay) => lay.CHIP + Math.ceil(unitSize("bsx") / 0x10000) * 0x10000;

export const bsxChip = {
  id: "BS-X",
  // InitROM: if (Settings.BS) no Map_* call; S9xResetBSX's BSX_Map fills it
  board: () => "BSX",
  boards: ["BSX"],
  buildMap() {},
  // the unit, then a page for its state (chip-unit.js chipstateWat)
  pages: Math.ceil(unitSize("bsx") / 0x10000) + 1,
  wat(lay, d) {
    const m = d.multi ?? { cartType: 0, offsetA: 0, sizeA: 0, offsetB: 0, sizeB: 0 };
    const fn = (n) => unitFn("bsx", n);
    const start = unitStart("bsx");
    return unitWat("bsx", lay.CHIP) + chipTimeWat(lay) + `
  ;; getset.h MAP_BSX: S9xGetBSX(Address) / S9xSetBSX(Byte, Address)
  (func $chip_rd (param $a i32) (result i32)
    (call ${fn("romdev_bsx_get")} (local.get $a)))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${fn("romdev_bsx_set")} (local.get $v) (local.get $a)))
  ;; ppu.cpp: if (Settings.BS && Address >= 0x2188 && Address <= 0x219f),
  ;; past the PPU's own registers (the B-bus side of a DMA reaches it too)
  (func $chip_b_rd (param $x i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2188)) (i32.le_u (local.get $x) (i32.const 0x219F)))
      (then (return (call ${fn("romdev_bsx_ppu_get")} (local.get $x) (global.get $ob)))))
    (i32.const -1))
  (func $chip_b_wr (param $x i32) (param $v i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $x) (i32.const 0x2188)) (i32.le_u (local.get $x) (i32.const 0x219F)))
      (then (call ${fn("romdev_bsx_ppu_set")} (local.get $v) (local.get $x)) (return (i32.const 1))))
    (i32.const 0))
  ;; InitROM's S9xInitBSX over the image (Memory.ROM at 0x${ROM.toString(16)}), then S9xReset's S9xResetBSX
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${fn("romdev_bsx_init")} (i32.const ${ROM}) (i32.const ${d.calculatedSize}) (i32.const ${lay.SRAM})
      (i32.const ${WRAM}) (i32.const ${MAPTAB}) (i32.const ${m.cartType}) (i32.const ${m.offsetA}) (i32.const ${m.sizeA})
      (i32.const ${m.offsetB}) (i32.const ${m.sizeB}))
    (call ${fn("romdev_bsx_reset")}))` + chipstateWat("bsx", "romdev_bsx_chipstate", bsxState(lay));
  },
  // the satellite clock reads time(); the verifier pins snes9x's to the frames.
  // The MMC / flash / PPU-port registers (chipstate) and the PSRAM a BS
  // program is loaded into and runs from are compared.
  section: (d) => ({ clock: { ...RTC_CLOCK }, ...chipRegions(d, {
    ...chipstateRegion("bsx", "romdev_bsx_chipstate", bsxState(d.memory)),
    psram: { offset: ROM + 0x400000, length: 0x80000, ref: "snes_bsx_psram" },
  }, false) }),
};
