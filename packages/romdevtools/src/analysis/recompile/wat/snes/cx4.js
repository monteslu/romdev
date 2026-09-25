// The CX4 (C4) of a recompiled SNES cart, as snes9x runs it: its
// high-level command set is snes9x's c4.cpp + c4emu.cpp compiled (the "cx4"
// unit of snes9x-chips.json, scripts/recompile-gen/snes9x-chips.mjs), with
// the sin / cos / atan it calls taken from emscripten's libc the way the
// reference core links them, so the wireframe, trigonometry and square-root
// commands give the reference's doubles bit for bit.
//
// memmap.cpp map_C4 (inside Map_LoROMMap): $6000-$7FFF of banks $00-$3F and
// $80-$BF are the chip (getset.h MAP_C4: S9xGetC4 / S9xSetC4). A write to
// $7F4F runs a command, a write to $7F47 copies ROM into the chip's RAM; the
// C4's ROM reads (C4GetMemPointer) index the cart's image the way snes9x
// indexes Memory.ROM. The chip's 8KB lives in the unit (Memory.C4RAM).
//
// Linear memory: the chip block lay.CHIP is the compiled unit.
//
// Plain JS ESM + JSDoc.

import { ROM } from "./layout.js";
import { unitWat, unitFn, unitStart, unitSize } from "./chip-unit.js";

/** map_C4 on Map_LoROMMap (the only board snes9x maps it on). */
function buildMap(api) {
  const { each, set, MAP_TYPE } = api;
  if (api.map !== "LoROM") return;
  each(0x00, 0x3f, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
  each(0x80, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
}

/**
 * @param {import("./layout.js").SnesLayout & {CHIP: number}} lay
 */
function wat(lay) {
  const start = unitStart("cx4");
  return `
${unitWat("cx4", lay.CHIP)}
  ;; cpu.cpp S9xReset: S9xInitC4 (the 8KB cleared); the C4 reads Memory.ROM = the cart's image
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("cx4", "romdev_c4_init")} (i32.const ${ROM})))
  ;; getset.h MAP_C4
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("cx4", "romdev_c4_get")} (i32.and (local.get $a) (i32.const 0xFFFF))))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("cx4", "romdev_c4_set")} (local.get $v) (i32.and (local.get $a) (i32.const 0xFFFF))))
`;
}

export const cx4 = {
  id: "CX4",
  buildMap,
  pages: Math.ceil(unitSize("cx4") / 0x10000),
  wat,
};
