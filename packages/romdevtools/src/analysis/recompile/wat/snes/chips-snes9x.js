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

import { unitWat, unitSize, unitFn, unitStart, chipstateWat, chipstateRegion, rtcRestoreWat } from "./chip-unit.js";
import { sramMaskFor } from "./memmap.js";
import { RTC_CLOCK } from "../../recompile-section.js";
import { HLE_DATA, hleDataHint } from "./hle-data.js";

const pagesFor = (bytes) => Math.ceil(bytes / 0x10000);
/** The 64KB page after a unit where the cart keeps the chip's state (chip-unit.js chipstateWat). */
const stateAddr = (lay, unit) => lay.CHIP + pagesFor(unitSize(unit)) * 0x10000;
/** Its last 32 bytes: the options.saveRtc image (no chipstate here is near that long). */
const rtcSlot = (lay, unit) => stateAddr(lay, unit) + 0xffe0;

/**
 * The section's regions with a chip's own state added: its chipstate
 * region, and the cart SRAM moved from diagnostic to compared when the chip
 * works in it (the SETA chips) or the game keeps its state there.
 * @param {any} d  describe()
 * @param {object} add  regions to add
 * @param {boolean} sram  compare the SRAM
 */
export function chipRegions(d, add, sram) {
  const regions = { ...d.layout.regions, ...add };
  const diagnosticRegions = { ...d.layout.diagnosticRegions };
  if (sram && diagnosticRegions.sram) { regions.sram = diagnosticRegions.sram; delete diagnosticRegions.sram; }
  return { regions, diagnosticRegions };
}
/** The cart's clock (wasmcart timePtr, ABI + 0x180): timeMs since power-on as f64. */
const timeAddr = (lay) => lay.ABI + 0x180;
/** Reference settle frames minus the cart's (index.js conventions): 5 - 1. */
const SETTLE_LEAD = 4;

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
  ;; The host's clock starts at the cart's first frame; the reference's
  ;; starts after its settle frames, which the cart reaches ${SETTLE_LEAD}
  ;; frames later (conventions.settleFrames), so the cart's reading lags the
  ;; host by that many frames, held at baseMs before them as snes9x's is.
  (func $chip_time (param $p i32) (result i64)
    (local $t i64) (local $ms f64)
    (local.set $ms (f64.sub (f64.load (i32.const ${timeAddr(lay)})) (f64.const ${SETTLE_LEAD * RTC_CLOCK.stepMs})))
    (if (f64.lt (local.get $ms) (f64.const 0)) (then (local.set $ms (f64.const 0))))
    (local.set $t (i64.trunc_f64_s (f64.div (f64.add (f64.const ${RTC_CLOCK.baseMs}) (local.get $ms)) (f64.const 1000))))
    (if (local.get $p) (then (i64.store (local.get $p) (local.get $t))))
    (local.get $t))`;
}

/**
 * A chip snes9x emulates from its data ROM (the DSP-1, DSP-3, ST010;
 * hle-data.js): romdev ships none of that data. The cart keeps the data ROM
 * the build was given (options.firmware) in its own page after the unit's
 * (and the chip state page, when there is one), and its reset fills the
 * unit's tables from it (glue/romdev_hledata.h) before the chip starts.
 * @param {string} id  loader.js coprocessor name
 * @param {any} lay
 * @param {any} d  describe()
 * @param {string} unit
 * @param {number} statePages  pages between the unit and the data
 * @returns {{data: string, call: (fn: string, args?: string) => string}}
 */
function hleDataWat(id, lay, d, unit, statePages) {
  const h = HLE_DATA[id];
  if (!d.hleDataBytes) throw new Error(`snes recompile: the ${id} cart needs the chip's data ROM (options.firmware: ${hleDataHint(id)})`);
  const at = lay.CHIP + (pagesFor(unitSize(unit)) + statePages) * 0x10000;
  let s = "";
  for (const v of d.hleDataBytes) s += "\\" + (v < 16 ? "0" : "") + v.toString(16);
  return {
    data: `
  ;; the ${id}'s data ROM (options.firmware ${d.firmware.name}: ${h.what}), the user's copy
  (data (i32.const ${at}) "${s}")`,
    call: (fn, args = "") => `(drop (call ${fn}${args} (i32.const ${at})))`,
  };
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
  const id = `DSP-${n}`;
  // the DSP-1 and DSP-3 read their data ROM (hle-data.js): one more page
  const hle = !!HLE_DATA[id];
  return {
    id,
    // the DSP-3 also keeps its state for the verifier (the page after the unit)
    pages: pagesFor(unitSize("dsp")) + (n === 3 ? 1 : 0) + (hle ? 1 : 0),
    buildMap(api, lay, d) {
      if (plainBoard(d, "LoROM") || plainBoard(d, "HiROM")) dspWindows(api, n, d);
    },
    wat(lay, d) {
      const start = unitStart("dsp");
      const data = hle ? hleDataWat(id, lay, d, "dsp", n === 3 ? 1 : 0) : null;
      return unitWat("dsp", lay.CHIP) + (data ? data.data : "") + `
  ;; getset.h MAP_DSP: S9xGetDSP(Address & 0xffff) / S9xSetDSP(Byte, Address & 0xffff)
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("dsp", "romdev_dsp_get")} (i32.and (local.get $a) (i32.const 0xFFFF))))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("dsp", "romdev_dsp_set")} (local.get $v) (i32.and (local.get $a) (i32.const 0xFFFF))))
  ;; memmap.cpp InitROM (Settings.DSP = ${n}), then cpu.cpp S9xReset's S9xResetDSP
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    ${data ? `;; the data ROM tables (romdev_hledata.h)
    ${data.call(unitFn("dsp", "romdev_dsp_hledata"), ` (i32.const ${n})`)}` : ""}
    (call ${unitFn("dsp", "romdev_dsp_init")} (i32.const ${n}) (i32.const ${d.mapping === "hirom" ? 1 : 0}) (i32.const ${d.romSize}))
    (call ${unitFn("dsp", "romdev_dsp_reset")}))` + (n === 3 ? chipstateWat("dsp", "romdev_dsp3_chipstate", stateAddr(lay, "dsp")) : "");
    },
    ...(n === 3 ? { section: (d) => chipRegions(d, chipstateRegion("dsp", "romdev_dsp3_chipstate", stateAddr(d.memory, "dsp")), false) } : {}),
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
    // the ST011 also keeps its state for the verifier (the page after the
    // unit); the ST010 its data ROM (hle-data.js)
    pages: pagesFor(unitSize("seta")) + (which === ST_011 || which === ST_010 ? 1 : 0),
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
      const data = which === ST_010 ? hleDataWat(id, lay, d, "seta", 0) : null;
      return unitWat("seta", lay.CHIP) + (data ? data.data : "") + `
  ;; getset.h MAP_SETA_DSP: S9xGetSetaDSP(Address) / S9xSetSetaDSP(Byte, Address)
  (func $chip_rd (param $a i32) (result i32)
    (call ${unitFn("seta", "romdev_seta_get")} (local.get $a)))
  (func $chip_wr (param $a i32) (param $v i32)
    (call ${unitFn("seta", "romdev_seta_set")} (local.get $v) (local.get $a)))
  ;; memmap.cpp InitROM case 0xF630 (${id}); S9xReset resets no SETA chip
  (func $chip_reset
    ${start ? `(call ${start})` : ""}
    ${data ? `;; the data ROM tables (romdev_hledata.h)
    ${data.call(unitFn("seta", "romdev_seta_hledata"))}` : ""}
    (call ${unitFn("seta", "romdev_seta_init")} (i32.const ${which}) (i32.const ${lay.SRAM}) (i32.const ${sramMaskFor(d.sramSizeByte)})))` +
        (which === ST_011 ? chipstateWat("seta", "romdev_st011_chipstate", stateAddr(lay, "seta")) : "");
    },
    // the ST011 works in the cart's SRAM: compared, with its command state
    ...(which === ST_011 ? { section: (d) => chipRegions(d, chipstateRegion("seta", "romdev_st011_chipstate", stateAddr(d.memory, "seta")), true) } : {}),
  };
}

// ---------------------------------------------------------------- ST018
const st018Chip = {
  id: "ST018",
  ...setaSram,
  pages: pagesFor(unitSize("st018")) + 1,
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
    (call ${unitFn("st018", "romdev_st018_bind")} (i32.const ${lay.SRAM})))` + chipstateWat("st018", "romdev_st018_chipstate", stateAddr(lay, "st018"));
  },
  // the stub's writes land in SRAM: compared, with its command state
  section: (d) => chipRegions(d, chipstateRegion("st018", "romdev_st018_chipstate", stateAddr(d.memory, "st018")), true),
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
  pages: pagesFor(unitSize("srtc")) + 1,
  wat(lay, d) {
    const start = unitStart("srtc");
    const rtc = rtcRestoreWat("srtc", "romdev_srtc_rtcdata", d.saveRtcBytes, rtcSlot(lay, "srtc"));
    return unitWat("srtc", lay.CHIP) + chipTimeWat(lay) + rtc.data + chipstateWat("srtc", "romdev_srtc_chipstate", stateAddr(lay, "srtc")) + `
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
    (call ${unitFn("srtc", "romdev_srtc_reset")})
    ${rtc.call})`;
  },
  // the chip reads the host's frame clock; the verifier pins snes9x's time() to it.
  // Its registers (mode, index, RTCData) are compared, and the battery SRAM
  // (the game's save) is too.
  section: (d) => ({ clock: { ...RTC_CLOCK }, ...chipRegions(d, chipstateRegion("srtc", "romdev_srtc_chipstate", stateAddr(d.memory, "srtc")), true) }),
  rtc: true,
};

/** Every chip this file provides, for coproc.js's registry. */
export const SNES9X_HLE_CHIPS = [
  dspChip(1), dspChip(2), dspChip(3), dspChip(4),
  setaChip("ST010", ST_010), setaChip("ST011", ST_011),
  st018Chip, obc1Chip, srtcChip,
];

/**
 * The boards snes9x gives the ST011 and ST018 (InitROM's SRAM size and
 * initial value, the board name and map), for chips-ares.js, which runs
 * those chips on ares's code inside the same snes9x machine.
 */
export const SETA_BOARDS = {
  ST011: (({ board, boards, sramSize, sramInit, buildMap }) => ({ board, boards, sramSize, sramInit, buildMap }))(setaChip("ST011", ST_011)),
  ST018: (({ sramSize, sramInit, buildMap }) => ({ sramSize, sramInit, buildMap }))(st018Chip),
};
