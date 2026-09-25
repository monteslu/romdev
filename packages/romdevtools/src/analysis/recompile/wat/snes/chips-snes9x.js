// The SNES coprocessors snes9x emulates at a high level, in a recompiled
// cart: DSP-1 / DSP-2 / DSP-3 / DSP-4, ST010 / ST011, ST018, OBC1 and the
// S-RTC. The chip code is snes9x's own (dsp1-4.cpp, seta010/011/018.cpp,
// obc1.cpp, srtc.cpp compiled to WAT, chip-unit.js); this file wires each
// unit to the cart where snes9x wires it:
//
//   memmap.cpp InitROM            the chip choice, SRAMSize / SRAMInitialValue
//                                 (sramSize / sramInit), and the board (board / buildMap:
//                                 map_DSP, map_SetaDSP, map_SetaRISC, map_OBC1)
//   getset.h MAP_DSP / MAP_SETA_DSP / MAP_SETA_RISC / MAP_OBC_RAM
//                                 $chip_rd / $chip_wr on the CHIP blocks
//   ppu.cpp S9xGetPPU / S9xSetPPU the S-RTC's $2800 / $2801 ($chip_b_rd / $chip_b_wr)
//   cpu.cpp S9xReset              S9xResetDSP / S9xResetOBC1 / S9xResetSRTC ($chip_reset)
//
// Each chip object follows coproc.js's contract.
//
// Plain JS ESM + JSDoc.

import { unitWat, unitSize, unitFn, unitStart } from "./chip-unit.js";
import { sramMaskFor } from "./memmap.js";
import { RTC_CLOCK } from "../../recompile-section.js";

const pagesFor = (bytes) => Math.ceil(bytes / 0x10000);
/** The cart's clock (wasmcart timePtr, ABI + 0x180): timeMs since power-on as f64. */
const timeAddr = (lay) => lay.ABI + 0x180;

/**
 * emscripten's time(): trunc(Date.now() / 1000), the reference's clock
 * pinned to the host's frame clock (recompile-section.js RTC_CLOCK), as
 * the unit's `time` import (param time_t *, returns time_t).
 * @param {any} lay
 */
export function chipTimeWat(lay) {
  return `
  ;; time(): the reference core's wall clock is Date.now(), pinned by the
  ;; verifier to baseMs + frames * stepMs; the cart reads the same frame
  ;; clock from the wasmcart host (RTC_CLOCK).
  (func $chip_time (param $p i32) (result i64)
    (local $t i64)
    (local.set $t (i64.trunc_f64_s (f64.div (f64.add (f64.const ${RTC_CLOCK.baseMs}) (f64.load (i32.const ${timeAddr(lay)}))) (f64.const 1000))))
    (if (local.get $p) (then (i64.store (local.get $p) (local.get $t))))
    (local.get $t))`;
}

/** Map_LoROMMap / Map_HiROMMap are the only boards that call map_DSP / map_OBC1 / map_SetaRISC. */
const plainBoard = (d, want) => d.board === want;

// ---------------------------------------------------------------- DSP-1..4
/**
 * memmap.cpp map_DSP for DSP0.maptype (chosen by InitROM from the DSP
 * number, HiROM and CalculatedSize).
 */
function dspWindows(api, dsp, d) {
  const { each, set, MAP_TYPE } = api;
  const chip = (b0, b1, a0, a1) => each(b0, b1, a0, a1, (c, i, p) => set(p, MAP_TYPE.CHIP));
  switch (dsp) {
    case 1:
      if (d.mapping === "hirom") { chip(0x00, 0x1f, 0x6000, 0x7fff); chip(0x80, 0x9f, 0x6000, 0x7fff); }
      else if (d.romSize > 0x100000) { chip(0x60, 0x6f, 0x0000, 0x7fff); chip(0xe0, 0xef, 0x0000, 0x7fff); }
      else { chip(0x20, 0x3f, 0x8000, 0xffff); chip(0xa0, 0xbf, 0x8000, 0xffff); }
      break;
    case 2:
      chip(0x20, 0x3f, 0x6000, 0x6fff); chip(0x20, 0x3f, 0x8000, 0xbfff);
      chip(0xa0, 0xbf, 0x6000, 0x6fff); chip(0xa0, 0xbf, 0x8000, 0xbfff);
      break;
    case 3:
      chip(0x20, 0x3f, 0x8000, 0xffff); chip(0xa0, 0xbf, 0x8000, 0xffff);
      break;
    case 4:
      chip(0x30, 0x3f, 0x8000, 0xffff); chip(0xb0, 0xbf, 0x8000, 0xffff);
      break;
  }
}

function dspChip(n) {
  return {
    id: `DSP-${n}`,
    pages: pagesFor(unitSize("dsp")),
    buildMap(api, lay, d) {
      if (plainBoard(d, "LoROM") || plainBoard(d, "HiROM")) dspWindows(api, n, d);
    },
    wat(lay, d) {
      const start = unitStart("dsp");
      return unitWat("dsp", lay.CHIP) + `
  ;; getset.h MAP_DSP: S9xGetDSP(Address & 0xffff) / S9xSetDSP(Byte, Address & 0xffff)
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("dsp", "romdev_dsp_get")} (i32.and (local.get $a) (i32.const 0xFFFF))))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("dsp", "romdev_dsp_set")} (local.get $v) (i32.and (local.get $a) (i32.const 0xFFFF))))
  ;; memmap.cpp InitROM (Settings.DSP = ${n}), then cpu.cpp S9xReset's S9xResetDSP
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("dsp", "romdev_dsp_init")} (i32.const ${n}) (i32.const ${d.mapping === "hirom" ? 1 : 0}) (i32.const ${d.romSize}))
    (call ${unitFn("dsp", "romdev_dsp_reset")}))`;
    },
  };
}

// ---------------------------------------------------------------- ST010 / ST011
const ST_010 = 1, ST_011 = 2;
/** memmap.cpp InitROM case 0xF630 / 0xF530: SRAMSize = 2, SRAMInitialValue = 0x00. */
const setaSram = { sramSize: () => 2, sramInit: 0x00 };

function setaChip(id, which) {
  return {
    id,
    board: () => "SetaDSPLoROM",
    boards: ["SetaDSPLoROM"],
    ...setaSram,
    pages: pagesFor(unitSize("seta")),
    // memmap.cpp Map_SetaDSPLoROMMap
    buildMap(api) {
      const { each, set, lorom, loSram, size, MAP_TYPE } = api;
      lorom(0x00, 0x3f, 0x8000, 0xffff, size);
      lorom(0x40, 0x7f, 0x8000, 0xffff, size);
      lorom(0x80, 0xbf, 0x8000, 0xffff, size);
      lorom(0xc0, 0xff, 0x8000, 0xffff, size);
      // map_SetaDSP
      each(0x68, 0x6f, 0x0000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
      each(0x60, 0x67, 0x0000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
      loSram();
    },
    wat(lay, d) {
      const start = unitStart("seta");
      return unitWat("seta", lay.CHIP) + `
  ;; getset.h MAP_SETA_DSP: S9xGetSetaDSP(Address) / S9xSetSetaDSP(Byte, Address)
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("seta", "romdev_seta_get")} (local.get $a)))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("seta", "romdev_seta_set")} (local.get $v) (local.get $a)))
  ;; memmap.cpp InitROM case 0xF630 (${id}); S9xReset resets no SETA chip
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("seta", "romdev_seta_init")} (i32.const ${which}) (i32.const ${lay.SRAM}) (i32.const ${sramMaskFor(d.sramSizeByte)})))`;
    },
  };
}

// ---------------------------------------------------------------- ST018
const st018Chip = {
  id: "ST018",
  ...setaSram,
  pages: pagesFor(unitSize("st018")),
  // Map_LoROMMap: else if (Settings.SETA == ST_018) map_SetaRISC();
  buildMap(api, lay, d) {
    if (!plainBoard(d, "LoROM")) return;
    const { each, set, MAP_TYPE } = api;
    each(0x00, 0x3f, 0x3000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
    each(0x80, 0xbf, 0x3000, 0x3fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
  },
  wat(lay) {
    const start = unitStart("st018");
    return unitWat("st018", lay.CHIP) + `
  ;; getset.h MAP_SETA_RISC: S9xGetST018(Address) / S9xSetST018(Byte, Address).
  ;; snes9x does not emulate the ST018's ARM core: seta018.cpp is a command
  ;; stub, and this is that stub.
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("st018", "romdev_st018_get")} (local.get $a)))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("st018", "romdev_st018_set")} (local.get $v) (local.get $a)))
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("st018", "romdev_st018_bind")} (i32.const ${lay.SRAM})))`;
  },
};

// ---------------------------------------------------------------- OBC1
const OBC1_RAM = 0x2000;
const obc1Chip = {
  id: "OBC1",
  // the unit, then snes9x's 8KB Memory.OBC1RAM
  pages: pagesFor(((unitSize("obc1") + 0xfff) & ~0xfff) + OBC1_RAM),
  // Map_LoROMMap: else if (Settings.OBC1) map_OBC1();
  buildMap(api, lay, d) {
    if (!plainBoard(d, "LoROM")) return;
    const { each, set, MAP_TYPE } = api;
    each(0x00, 0x3f, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
    each(0x80, 0xbf, 0x6000, 0x7fff, (c, i, p) => set(p, MAP_TYPE.CHIP));
  },
  wat(lay) {
    const start = unitStart("obc1");
    const ram = lay.CHIP + ((unitSize("obc1") + 0xfff) & ~0xfff);
    return unitWat("obc1", lay.CHIP) + `
  ;; getset.h MAP_OBC_RAM: S9xGetOBC1(Address & 0xffff) / S9xSetOBC1(Byte, Address & 0xffff)
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("obc1", "romdev_obc1_get")} (i32.and (local.get $a) (i32.const 0xFFFF))))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("obc1", "romdev_obc1_set")} (local.get $v) (i32.and (local.get $a) (i32.const 0xFFFF))))
  ;; Memory.OBC1RAM at 0x${ram.toString(16)}; cpu.cpp S9xReset: S9xResetOBC1()
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("obc1", "romdev_obc1_bind")} (i32.const ${ram}))
    (call ${unitFn("obc1", "romdev_obc1_reset")}))`;
  },
  /** The OBC1 RAM for the verifier (snes9x keeps it outside SRAM). */
  obc1Ram: (lay) => lay.CHIP + ((unitSize("obc1") + 0xfff) & ~0xfff),
};

// ---------------------------------------------------------------- S-RTC
const srtcChip = {
  id: "S-RTC",
  pages: pagesFor(unitSize("srtc")),
  wat(lay) {
    const start = unitStart("srtc");
    return unitWat("srtc", lay.CHIP) + chipTimeWat(lay) + `
  ;; ppu.cpp: $2800 reads S9xGetSRTC, $2801 writes S9xSetSRTC (the else
  ;; branch past $2183, not reachable from a (H)DMA A-bus access, which
  ;; S9xGetPPU / S9xSetPPU turn away first)
  (func $chip_b_rd (param $x i32) (result i32)
    (if (i32.and (i32.eq (local.get $x) (i32.const 0x2800)) (i32.eqz (global.get $indma)))
      (then (return (call ${unitFn("srtc", "romdev_srtc_get")} (local.get $x)))))
    (i32.const -1))
  (func $chip_b_wr (param $x i32) (param $v i32) (result i32)
    (if (i32.and (i32.eq (local.get $x) (i32.const 0x2801)) (i32.eqz (global.get $indma)))
      (then (call ${unitFn("srtc", "romdev_srtc_set")} (local.get $v) (local.get $x))
            (return (i32.const 1))))
    (i32.const 0))
  ;; memmap.cpp InitROM (S9xInitSRTC), then cpu.cpp S9xReset (S9xResetSRTC)
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    (call ${unitFn("srtc", "romdev_srtc_init")})
    (call ${unitFn("srtc", "romdev_srtc_reset")}))`;
  },
  // the chip reads the host's frame clock; the verifier pins snes9x's time() to it
  section: () => ({ clock: { ...RTC_CLOCK } }),
};

/** Every chip this file provides, for coproc.js's registry. */
export const SNES9X_HLE_CHIPS = [
  dspChip(1), dspChip(2), dspChip(3), dspChip(4),
  setaChip("ST010", ST_010), setaChip("ST011", ST_011),
  st018Chip, obc1Chip, srtcChip,
];
