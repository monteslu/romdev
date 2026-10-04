// The ST011 and ST018 run on ares's chips, in a recompiled cart built with
// the chip's firmware (options.firmware). snes9x cannot run either chip (its
// ST011 is an HLE that stops after the opening, its ST018 a command stub);
// ares runs the firmware on its uPD96050 and ARM cores. The chip code is
// ares's own, compiled to WAT by scripts/recompile-gen/ares-chips.mjs
// (ares-chips.json: units necdsp and armdsp); the snes9x reference core runs
// the same files when the firmware is in its system directory
// (scripts/patches/snes9x-ares-chips.patch), so the cart and the reference
// agree on the chip to the bit. Everything around the chip stays the snes9x
// machine: the board, map and SRAM are snes9x's (chips-snes9x.js SETA_BOARDS).
//
// Wiring (the reference's call sites in scripts/patches/snes9x/romdev_fwchip.cpp):
//   getset.h MAP_SETA_DSP / MAP_SETA_RISC   $chip_rd / $chip_wr with the S-CPU's
//                                           master clock in the line ($hnow,
//                                           snes9x CPU.Cycles before the access)
//   cpuexec.cpp line end                    $chip_line: the chip's clock base
//                                           moves by the line (Timings.H_Max)
//   cpu.cpp S9xReset                        $chip_reset: the chip powers on
//   the end of a frame                      $chip_frame: romdev_ares_chipstate.h
//
// Cart memory at lay.CHIP: the unit, then the firmware image, then the chip
// state page. Licence: the units are ares code, ISC-licensed (Copyright (c)
// 2004-2025 ares team, Near et al); a cart built with one carries ares's
// notice (romdev's NOTICE).
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { placeUnit } from "../wasm-unit.js";
import { SETA_BOARDS, chipRegions } from "./chips-snes9x.js";

let UNITS = null;
function units() {
  if (!UNITS) UNITS = JSON.parse(readFileSync(new URL("./ares-chips.json", import.meta.url), "utf8")).units;
  return UNITS;
}
/** @param {string} name */
function unit(name) {
  const u = units()[name];
  if (!u) throw new Error(`snes chips: no compiled unit ${name} in ares-chips.json`);
  return u;
}
/** @param {string} name @param {string} fn */
function fnOf(name, fn) {
  const f = unit(name).exports[fn];
  if (!f) throw new Error(`snes chips: ares unit ${name} exports no ${fn}`);
  return f;
}

const pagesFor = (bytes) => Math.ceil(bytes / 0x10000);

/**
 * The chips this file runs, by loader.js coprocessor name: the unit, the
 * firmware it needs (the file the reference core finds in its system
 * directory) and the init call.
 */
export const ARES_FIRMWARE = {
  ST011: { unit: "necdsp", file: "st011.rom", length: 0xd000, init: (fw) => `(call ${fnOf("necdsp", "romdev_necdsp_init")} (i32.const 11) (i32.const ${fw}))`,
    what: "the uPD96050's 0xC000-byte program ROM then its 0x1000-byte data ROM" },
  ST018: { unit: "armdsp", file: "st018.rom", length: 0x28000, init: (fw) => `(call ${fnOf("armdsp", "romdev_armdsp_init")} (i32.const ${fw}))`,
    what: "the ARM's 0x20000-byte program ROM then its 0x8000-byte data ROM" },
};

/** Where the unit, the firmware and the chip state sit in the cart. */
function places(lay, id) {
  const f = ARES_FIRMWARE[id];
  const u = unit(f.unit);
  const fw = lay.CHIP + pagesFor(u.size) * 0x10000;
  const state = fw + pagesFor(f.length) * 0x10000;
  return { u, fw, state };
}

/** @param {"ST011"|"ST018"} id */
function aresChip(id) {
  const f = ARES_FIRMWARE[id];
  const name = f.unit;
  const fn = (x) => fnOf(name, `romdev_${name}_${x}`);
  const csLen = () => unit(name).chipstate?.[`romdev_${name}_chipstate`];
  return {
    id,
    impl: "ares",
    ...SETA_BOARDS[id],
    pages: pagesFor(unit(name).size) + pagesFor(f.length) + 1,
    wat(lay, d) {
      if (!d.firmwareBytes) throw new Error(`snes recompile: the ${id} cart needs its firmware (options.firmware)`);
      const { u, fw, state } = places(lay, id);
      let s = "";
      for (const v of d.firmwareBytes) s += "\\" + (v < 16 ? "0" : "") + v.toString(16);
      return placeUnit(u, lay.CHIP, `ares chip unit '${name}' (ares-chips.json, ISC)`) + `
  ;; the ${id}'s firmware (options.firmware ${d.firmware.name}: ${f.what})
  (data (i32.const ${fw}) "${s}")
  ;; the S-CPU's access at its master clock in the line (snes9x CPU.Cycles
  ;; before the access): the chip catches up to it, then answers. A chip
  ;; window address that is not the chip's reads open bus (the unit says -1).
  (func $chip_rd (param $a i32) (result i32)
    (local $v i32)
    (local.set $v (call ${fn("read")} (local.get $a) (call $hnow)))
    (if (result i32) (i32.lt_s (local.get $v) (i32.const 0)) (then (global.get $ob)) (else (local.get $v))))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${fn("write")} (local.get $a) (local.get $v) (call $hnow)))
  ;; the line end, before the clock goes back by the line (Timings.H_Max)
  (func $chip_line
    (call ${fn("line")} (global.get $hmax)))
  ;; S9xReset: the chip powers on with the system
  (func $chip_reset
    ${f.init(fw)})
  ;; the chip's state for the verifier (romdev_ares_chipstate.h; the reference's snes_chipstate)
  (func $chip_frame (drop (call ${fn("chipstate")} (i32.const ${state}))))`;
    },
    // the chip state (registers, its RAM, its clock) and the cart SRAM are compared
    section: (d) => ({
      ...chipRegions(d, { chipstate: { offset: places(d.memory, id).state, length: csLen(), ref: "snes_chipstate" } }, true),
      firmware: d.firmware,
    }),
  };
}

/** The chips coproc.js uses when a cart is built with options.firmware. */
export const ARES_CHIPS = [aresChip("ST011"), aresChip("ST018")];
