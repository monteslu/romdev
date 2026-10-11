// SNES WAT backend: statically recompile a whole LoROM or HiROM SNES
// cartridge into one WAT module (a wasmcart), ported from the earlier
// Python emitter. The cart carries snes9x's bus (memmap.js), CPU timing and
// DMA/HDMA (cpu-wat.js, frame-wat.js), PPU (ppu-wat.js) and a port of its
// SPC700 + S-DSP (apu-wat.js) whose output goes to the wasmcart audio ring.
//
// SHAPE. One dispatch ARM PER ROM FILE OFFSET (every byte, not just the ones
// a static walk reaches), 1024 arms per br_table shard, and a binary search
// over shards. A packed (offset, arm) table expands into PCTAB at wc_init;
// $step maps the 24-bit pc through the cart's memory map to a file offset
// and dispatches. PCs outside ROM (work RAM, SRAM, I/O) go to a small
// interpreter that shares every register and memory routine with the arms.
//
// M/X WIDTH IS DECIDED AT RUNTIME. Only the nine immediate forms whose
// length depends on M or X are ambiguous statically, and each such arm is
// emitted with BOTH readings, selected on the live flag. No block map, no
// flag walk: a new ROM needs nothing but its bytes.
//
// RELATIVE BRANCH TARGETS are computed in file-offset space (where they are
// exact) and converted back through the instruction's own bank, since a
// relative branch cannot leave its bank.
//
// STREAMING. A 3MB ROM emits ~2.1GB of WAT text, so emitWat yields chunks
// (module prologue, one chunk per shard, data segments in pieces) and never
// builds the module as one string. The concatenation of the chunks is the
// module text, byte-identical to the Python emitter's output.
//
// Plain JS ESM + JSDoc.

import { decode, lowerArm, oplen, interpCostTable, interpWat as interpGenWat } from "./lower.js";
import {
  computeLayout, FB_W, FB_H, WRAM, VRAM, CGRAM, OAM, PROBE,
  PROBE_FIELDS, INPUT, INPUT_SZ, ROM, PCRING, PCRING_N, MAPTAB, APUST, ICOST,
} from "./layout.js";
import { buildMemMap, sramMaskFor } from "./memmap.js";
import { loadRom } from "./loader.js";
import { romFixes } from "./romfixes.js";
import { globalsWat, memWat, interpWat } from "./cpu-wat.js";
import { ppuDataWat, ppuWat, renderWat } from "./ppu-wat.js";
import { apuWat, apuDataWat, apuGlobalsWat, APU_OFF } from "./apu-wat.js";
import { regwatchWat, stepHeadWat, frameWat } from "./frame-wat.js";
import { chipFor, chipWat, chipNeedsFirmware } from "./coproc.js";
import { ARES_FIRMWARE } from "./chips-ares.js";
import { hleDataFor, hleDataHint, readHleData } from "./hle-data.js";
import { findMsuPack, msuPages, msuDataWat } from "./msu1.js";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/** Platform ids this backend accepts. */
export const platforms = ["snes"];

/** Arms per br_table shard. */
const SH = 1024;

/**
 * Ranges (16-bit ROM addresses, inclusive) the ROM pc ring never records:
 * tight boot loops that would fill it by themselves. These three came from a
 * LoROM cart's boot ($8034-$8048 the $7F8000 OAM-clear builder, $8079-$80E7 the
 * APU upload loop, $8A4E-$8A64 its RAM clear); `options.pcSkip` appends more.
 * Emitted into every cart so the output matches the Python emitter's.
 */
const PCRING_SKIP_DEFAULT = [[0x8034, 0x8048], [0x8079, 0x80e7], [0x8a4e, 0x8a64]];



/** options.traceEntries: the register ring's entry size and maximum length. */
const REGRING_STRIDE = 32;
const REGRING_MAX = 1 << 18;

/**
 * @typedef {object} SnesOptions
 * @property {number} [regwatchPc]  16-bit ROM address for the REGISTER WATCH probe (0/absent = off)
 * @property {Array<[number, number]>|string} [pcSkip]  extra pc-ring skip ranges, [[lo,hi],...] or "806B-806D,9A74-9A8A"
 * @property {number} [limit]  emit arms only for ROM offsets below this (tests / debugging)
 * @property {Array<[number, number]>} [armRanges]  emit arms only for ROM offsets in these
 *   [lo, hi) ranges (tests of large images; other ROM pcs run in the interpreter)
 * @property {number} [traceEntries]  ALSO record a ring WITH the 65816 registers for findDiverge
 *   level:'instruction' (a power of two, 1024 to 262144; the entries are the ROM pc ring's, so
 *   the same filter applies): 32 bytes {pc24, A | X<<16, Y | S<<16, D | DB<<16, P | E<<8}
 *   above the cart's other memory. Off by default: the default module is unchanged.
 * @property {number|string} [breakArm]  DEBUG / MUST-FAIL CONTROL: the arm at this 24-bit ROM
 *   address (the $80 mirror is the same) also flips bit 0 of A after it runs, so an
 *   instruction-level differ must name exactly this instruction
 * @property {string} [saveRam]  a battery save (.srm) the cart powers on with, as a frontend
 *   restores one before the game first runs: copied over the power-on SRAM fill at wc_init, and
 *   named in the section (saveRam: {name, sha1, length}) so the verifier gives the reference the
 *   same bytes (the file must sit beside the reference ROM under the same name)
 * @property {string} [saveRtc]  the saved registers of a battery-backed clock (S-RTC, SPC7110 +
 *   RTC-4513): RTCData.reg, the 20-byte .rtc file a frontend keeps and restores after the load
 *   (libretro RETRO_MEMORY_RTC); restored after the chip's reset and named in the section
 *   (saveRtc) so the verifier writes the same bytes into the reference's rtc region
 * @property {boolean} [breakChip]  DEBUG / MUST-FAIL CONTROL: every byte read from the
 *   coprocessor (CPU reads, B-bus registers, chip DMA) has bit 0 flipped; a cart without a
 *   coprocessor refuses it
 * @property {object} [stats]  filled with {arms, lowered, interpreted, dual, reasons}
 */

/** @param {Uint8Array} rom */
function toBytes(rom) {
  if (rom instanceof Uint8Array) return rom;
  if (ArrayBuffer.isView(rom)) return new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength);
  if (rom instanceof ArrayBuffer) return new Uint8Array(rom);
  throw new TypeError("snes: rom must be a Uint8Array/Buffer");
}

/**
 * options.armRanges as a sorted offset list (null = one arm per offset).
 * @param {number} len
 * @param {SnesOptions} opts
 */
function armOffsetsFor(len, opts) {
  if (!opts.armRanges) return null;
  const set = new Set();
  for (const [lo, hi] of opts.armRanges) for (let a = Math.max(0, lo); a < Math.min(len, hi); a++) set.add(a);
  return [...set].sort((x, y) => x - y);
}

/**
 * Header-derived configuration: the image as snes9x loads it (loader.js),
 * its board map, SRAM, snes9x's per-title fixes (romfixes.js), the
 * refusals, and the cart layout the verify op compares.
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 */
export function describe(rom, opts = {}) {
  const raw = toBytes(rom);
  const L = loadRom(raw, opts);
  const img = L.img;
  const fixes = romFixes(L);
  // SRAMSize (header byte, or a per-title override) -> snes9x SRAMMask;
  // the board with 512KB of SRAM maps it whole.
  const sramByte = fixes.sramSize ?? L.sramSize;
  const sramMask = L.map === "SRAM512KLoROM" ? 0x1ffff : sramMaskFor(sramByte);
  const sramSize = sramMask ? sramMask + 1 : 0;
  const mapping = L.hiRom ? "hirom" : "lorom";
  const h = L.header + 0x10;
  const byte = (o) => img[h + o] ?? 0;
  const title = Array.from(img.subarray(h, h + 21), (c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ")).join("").trimEnd();
  const vec = (L.hiRom ? 0xfffc : 0x7ffc) + (L.extended === "bigfirst" ? 0x400000 : 0);
  const reset = img[vec] | (img[vec + 1] << 8);

  let refusal = L.refusal;
  if (!refusal && raw.length < 0x8000) refusal = `ROM image is ${raw.length} bytes; a cart needs at least one 32KB bank`;

  // an add-on BIOS image (addon-carts.js) names the ranges that hold code
  const armOffsets = armOffsetsFor(img.length, opts.armRanges || !L.armRanges ? opts : { armRanges: L.armRanges });
  const layout = computeLayout(img.length, sramMask, Math.max(1, armOffsets ? armOffsets.length : opts.limit ? Math.min(opts.limit, img.length) : img.length));
  layout.armOffsets = armOffsets;
  layout.fixes = fixes;
  layout.map = L.map;
  // PAL by region byte (snes9x Settings.PAL): 312 lines, the PAL APU clock
  // ratio, $213F bit 4.
  layout.pal = L.pal;
  // A chip that runs firmware snes9x cannot run (the ST011, ST018) runs on
  // ares's code from the firmware the build is given (options.firmware,
  // chips-ares.js); without it the cart is refused.
  let firmware = null, chipImpl = null;
  if (chipNeedsFirmware(L.coprocessor)) {
    const need = ARES_FIRMWARE[L.coprocessor];
    if (opts.firmware == null) {
      if (!refusal) refusal = `cart uses the ${L.coprocessor}, which runs firmware snes9x does not emulate (its ${L.coprocessor === "ST018" ? "ST018 is a command stub" : "ST011 is an HLE that stops after the opening"}); build it with options.firmware: '<path to ${need.file}>' (${need.length} bytes: ${need.what}) to run the chip on ares's code`;
    } else {
      const f = String(opts.firmware);
      if (!existsSync(f)) throw new Error(`snes recompile: options.firmware: no file at ${f}`);
      const bytes = new Uint8Array(readFileSync(f));
      if (bytes.length !== need.length) throw new Error(`snes recompile: options.firmware ${f} is ${bytes.length} bytes; the ${L.coprocessor}'s firmware (${need.file}) is ${need.length}: ${need.what}`);
      firmware = { chip: L.coprocessor, name: need.file, sha1: createHash("sha1").update(bytes).digest("hex"), length: bytes.length, bytes };
      chipImpl = "ares";
    }
  } else if (hleDataFor(L.coprocessor)) {
    // A chip snes9x emulates at a high level from its data ROM (the DSP-1,
    // DSP-3, ST010; hle-data.js): romdev does not ship that data, the build
    // is given it.
    if (opts.firmware == null) {
      if (!refusal) refusal = `cart uses the ${L.coprocessor}, whose emulation reads the chip's data ROM, which romdev does not ship; build it with options.firmware: '<path to ${hleDataFor(L.coprocessor).data}>', the user's own copy: ${hleDataHint(L.coprocessor)}`;
    } else {
      firmware = readHleData(L.coprocessor, String(opts.firmware));
    }
  } else if (opts.firmware != null) {
    throw new Error(`snes recompile: options.firmware given, but this cart's ${L.coprocessor ? L.coprocessor : "board"} runs no firmware or data ROM the recompiler loads (only the DSP-1, DSP-3, ST010, ST011 and ST018 do)`);
  }
  // A coprocessor's state (coproc.js), above everything computeLayout placed.
  const chip = chipFor(L.coprocessor, chipImpl);
  // where its snes9x map types group 16-bit accesses differently from its
  // cart block types (cpu-wat.js $fast2)
  layout.wordBus = chip?.wordBus ?? null;
  if (chip?.pages) {
    layout.CHIP = layout.pages * 0x10000;
    layout.pages += chip.pages;
  }
  // An MSU-1 pack beside the ROM (msu1.js): snes9x's S9xMSU1ROMExists.
  const msu = findMsuPack(opts.romPath);
  if (msu) {
    layout.MSU = layout.pages * 0x10000;
    layout.pages += msuPages(msu);
    if (!refusal && fixes.apuSpeedup) refusal = "MSU-1 pack on a title with snes9x's APU speedup: the resampled DSP stream plus the MSU-1 mix is not modelled";
  }
  // A battery save the cart powers on with (options.saveRam), above the rest.
  let saveRam = null;
  if (opts.saveRam != null) {
    const f = String(opts.saveRam);
    if (!existsSync(f)) throw new Error(`snes recompile: options.saveRam: no file at ${f}`);
    const bytes = new Uint8Array(readFileSync(f));
    if (!sramSize) throw new Error("snes recompile: options.saveRam given, but this cart has no SRAM (header SRAM size 0)");
    if (!bytes.length || bytes.length > sramSize) throw new Error(`snes recompile: options.saveRam ${f} is ${bytes.length} bytes; this cart's SRAM is ${sramSize} bytes`);
    saveRam = { name: path.basename(f), sha1: createHash("sha1").update(bytes).digest("hex"), length: bytes.length, bytes };
    layout.SRAMINIT = layout.pages * 0x10000;
    layout.SRAMINIT_LEN = bytes.length;
    layout.pages += Math.ceil(bytes.length / 0x10000);
  }
  // A battery-backed clock's saved registers (options.saveRtc).
  let saveRtc = null;
  if (opts.saveRtc != null) {
    const f = String(opts.saveRtc);
    if (!existsSync(f)) throw new Error(`snes recompile: options.saveRtc: no file at ${f}`);
    const bytes = new Uint8Array(readFileSync(f));
    const hasRtc = chip?.rtc === true || (typeof chip?.rtc === "function" && chip.rtc({ chipset: L.romType }));
    if (!hasRtc) throw new Error("snes recompile: options.saveRtc given, but this cart has no battery-backed clock (S-RTC, or SPC7110 with the RTC-4513)");
    if (bytes.length !== 20) throw new Error(`snes recompile: options.saveRtc ${f} is ${bytes.length} bytes; RTCData is 20`);
    saveRtc = { name: path.basename(f), sha1: createHash("sha1").update(bytes).digest("hex"), length: 20, bytes };
  }
  if (opts.breakChip && !chip) throw new Error("snes recompile: options.breakChip needs a cart with a coprocessor");
  const tn = opts.traceEntries;
  if (tn != null) {
    if (!Number.isInteger(tn) || tn < 1024 || tn > REGRING_MAX || (tn & (tn - 1))) {
      throw new Error(`snes recompile: options.traceEntries must be a power of two from 1024 to ${REGRING_MAX}, got ${tn}`);
    }
    // above everything computeLayout placed, so the default map is untouched
    layout.REGRING = layout.pages * 0x10000;
    layout.REGRING_N = tn;
    layout.pages += Math.ceil((tn * REGRING_STRIDE) / 0x10000);
  }
  const res = {
    platform: "snes",
    referenceCore: "snes9x",
    supported: !refusal,
    refusal,
    title,
    mapping,
    board: L.map,
    extended: L.extended,
    interleaved: L.interleaved,
    headerOffset: h,
    fastRom: (byte(0x15) & 0x10) !== 0,
    romSizeByte: L.romSize,
    sramSizeByte: sramByte,
    mapMode: byte(0x15),
    chipset: L.romType,
    coprocessor: L.coprocessor,
    // "ares" when the chip runs on ares's code (options.firmware)
    chipImpl,
    romSize: img.length,
    copierHeader: L.headerStripped ? 512 : 0,
    sramSize,
    sramMask,
    region: L.region,
    pal: L.pal,
    resetVector: reset,
    romFixes: fixes.applied,
    layout: cartLayout(layout, sramSize),
    memory: layout,
    conventions,
    options: {
      regwatchPc: "16-bit ROM address: record (A, X, Y, P, $8D, D, [$00]) each time execution reaches it (REGWATCH probe)",
      pcSkip: "extra 16-bit pc ranges the ROM pc ring skips, [[lo,hi],...] or \"806B-806D,9A74-9A8A\"; \"none\" also drops the built-in boot-loop ranges",
      limit: "emit arms only below this ROM offset (debugging)",
      armRanges: "[[lo, hi), ...] ROM offset ranges to emit arms for (tests of large images; other ROM pcs run in the interpreter)",
      breakArm: "DEBUG / must-fail control: 24-bit ROM address whose arm also flips bit 0 of A",
      traceEntries: "power of two 1024-262144: also record the 65816 registers per ROM instruction for findDiverge level:'instruction' (off by default)",
      breakChip: "DEBUG / must-fail control: true flips bit 0 of every byte read from the coprocessor (CPU, B-bus, chip DMA)",
      saveRtc: "path to a battery-backed clock's saved registers (the 20-byte .rtc, RTCData) for an S-RTC or SPC7110+RTC cart; restored after the chip's reset, and the verifier writes it into the reference's rtc region (keep it beside the reference ROM)",
      saveRam: "path to a battery save (.srm, at most the cart's SRAM size) the cart powers on with; the verifier writes the same file into the reference's save_ram before its first frame (keep it beside the reference ROM under the same name)",
      firmware: "path to the chip's firmware, REQUIRED for these carts (romdev ships no chip firmware or data): an ST011 (st011.rom, 53248 bytes) or ST018 (st018.rom, 163840 bytes) runs on ares's code (ISC-licensed) from it; a DSP-1 (dsp1b.data.rom, 2048 bytes, the DSP-1B's data ROM, or dsp1b.rom, 8192), DSP-3 (dsp3.data.rom, 2048, or dsp3.rom, 8192) or ST010 (st010.data.rom, 4096, or st010.rom, 53248) runs snes9x's emulation with the tables it reads from the chip's data ROM. The verifier gives the reference core the same file (keep it beside the reference ROM, or in a firmware/ directory there)",
    },
    saveRam: saveRam ? { name: saveRam.name, sha1: saveRam.sha1, length: saveRam.length } : null,
    saveRtc: saveRtc ? { name: saveRtc.name, sha1: saveRtc.sha1, length: saveRtc.length } : null,
    firmware: firmware ? { chip: firmware.chip, name: firmware.name, sha1: firmware.sha1, length: firmware.length } : null,
    msu: msu ? { dataBytes: msu.data.length, tracks: msu.tracks.map((t) => t.num) } : null,
    // a multi-cart's slots and snes9x's CalculatedSize (addon-carts.js)
    multi: L.multi ?? null,
    calculatedSize: L.calculatedSize,
    // files the reference core opens beside its ROM: a BIOS, an MSU-1 pack
    companionFiles: [...(L.companionFiles ?? []), ...(msu ? msu.companions : [])],
  };
  // the pack's bytes, for emitWat (kept out of the JSON the tool returns)
  Object.defineProperty(res, "msu1", { value: msu, enumerable: false });
  Object.defineProperty(res, "saveRamBytes", { value: saveRam?.bytes ?? null, enumerable: false });
  if (opts.breakChip) res.breakChip = true;
  Object.defineProperty(res, "saveRtcBytes", { value: saveRtc?.bytes ?? null, enumerable: false });
  Object.defineProperty(res, "firmwareBytes", { value: firmware?.bytes ?? null, enumerable: false });
  // the data ROM part of it, for a chip snes9x emulates from its data ROM (hle-data.js)
  Object.defineProperty(res, "hleDataBytes", { value: firmware?.data ?? null, enumerable: false });
  return res;
}

/** loadMedia platform id of the reference core. */
export const REFERENCE_CORE = "snes9x";

/**
 * Frame / input conventions the verify op needs. The cart keeps snes9x's
 * clock (per-access memory speeds, internal cycles, DRAM refresh, (H)DMA
 * time, the APU at 15664/328125 of the master clock) and ends each
 * wc_render where retro_run ends, at the start of vblank, so cart frame
 * F + 4 is reference frame F (5 settle frames against 1): the computed
 * alignment, no search. The pads are read POSITIONALLY (wasmcart south =
 * SNES B, east = SNES A), through the automatic read and $4016/$4017.
 */
export const conventions = {
  frameAxis: "total",
  settleFrames: { cart: 1, reference: 5 },
  warmupFrames: 0,
  input: true,
  buttons: "positional",
};

/**
 * The region map + probe fields the verify op reads (the cart's
 * `romdev.recompile` custom section carries it).
 * @param {import("./layout.js").SnesLayout} lay
 * @param {number} sramSize
 */
function cartLayout(lay, sramSize) {
  const regions = {
    wram: { offset: WRAM, length: 0x20000, ref: "system_ram" },
    vram: { offset: VRAM, length: 0x10000, ref: "video_ram" },
    cgram: { offset: CGRAM, length: 0x200, ref: "snes_cgram" },
    oam: { offset: OAM, length: 0x220, ref: "snes_oam" },
  };
  // ARAM: the SPC700 and S-DSP run in the cart on snes9x's clock, so the
  // audio RAM (driver, sequence data, echo buffer) is compared too.
  regions.aram = { offset: lay.ARAM, length: 0x10000, ref: "snes_aram" };
  // SRAM is diagnostic: a reference core may load a save the cart never sees.
  const diagnosticRegions = {};
  if (sramSize) diagnosticRegions.sram = { offset: lay.SRAM, length: sramSize, ref: "save_ram" };
  return {
    regions,
    diagnosticRegions,
    probe: {
      offset: PROBE,
      fields: Object.fromEntries(Object.entries(PROBE_FIELDS).map(([k, o]) => [k, { offset: PROBE + o, size: 4 }])),
    },
    trap: { flag: "trapped", pc: "trappc" },
    pcRing: { offset: PCRING, entries: PCRING_N, stride: 4, cursorField: "npc", format: "u32 pc24, circular" },
    framebuffer: { offset: lay.FB, width: FB_W, height: FB_H, format: "bgra8888", note: "u32 words 0xAARRGGBB; the region is the largest frame (512 x 478), each frame's size is in wc_info (256 or 512 wide, 224 or 448 tall after snes9x's overscan crop)" },
    input: { offset: INPUT, length: INPUT_SZ },
  };
}

/**
 * The `romdev.recompile` custom section (schema in ../../recompile-section.js).
 * @param {Uint8Array} rom
 * @param {string} [sha1]  sha1 of the ROM file (hex), if the caller has it
 * @param {SnesOptions} [opts]
 */
export function recompileSection(rom, sha1, opts = {}) {
  const d = describe(rom, opts);
  const L = d.layout;
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: "snes",
      reference: "snes",
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || null,
      mapping: d.mapping,
      warmupFrames: 0,
      regions: L.regions,
      diagnosticRegions: L.diagnosticRegions,
      // The S-DSP's output ring: snes9x hands libretro the DSP's 32040 Hz
      // samples unresampled (SoundInputRate = SoundPlaybackRate = 32040), so
      // the ring can equal the core's output sample for sample. muteMask is
      // SPC_DSP::mute_voices (a voice keyed off every sample).
      audio: {
        sampleRate: 32040, channels: 2, format: "s16", reference: "output",
        muteMask: { offset: APUST + APU_OFF.MUTE, size: 1, channels: ["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"] },
      },
      probe: L.probe.fields,
      trap: L.trap,
      pcRing: L.pcRing,
      ...(chipFor(d.coprocessor, d.chipImpl)?.section?.(d) ?? {}),
      // a Sufami Turbo cart's SRAM (the cart's own battery RAM in its slot) is compared
      ...(d.board === "SufamiTurboLoROM" && L.diagnosticRegions.sram
        ? { regions: { ...L.regions, sram: L.diagnosticRegions.sram }, diagnosticRegions: {} } : {}),
      // the MSU-1 pack's files the reference core must find beside its ROM
      ...(d.companionFiles.length ? { companionFiles: d.companionFiles } : {}),
      // the chip firmware or data ROM both sides run with (options.firmware)
      ...(d.firmware ? { firmware: d.firmware } : {}),
      // the battery save both sides power on with (options.saveRam)
      ...(d.saveRam ? { saveRam: d.saveRam } : {}),
      ...(d.saveRtc ? { saveRtc: d.saveRtc } : {}),
      ...(opts.breakChip ? { debugBreakChip: true, warning: "built with options.breakChip: every coprocessor read has bit 0 flipped (a must-fail control), NOT a faithful cart" } : {}),
      ...(opts.breakArm != null ? { debugBreakArm: parseBreakArm(opts.breakArm), warning: "built with options.breakArm: one instruction also flips bit 0 of A (a must-fail control), NOT a faithful cart" } : {}),
      // the ROM pc ring in recompile-section.js's `trace` schema: it records
      // ROM pcs only (bank < $7E, offset >= $8000) minus the skip ranges, so
      // the differ filters the reference the same way
      trace: {
        offset: L.pcRing.offset, entries: L.pcRing.entries, stride: L.pcRing.stride,
        cursor: { offset: L.probe.fields.npc.offset, mode: "count" },
        pc: { offset: 0, mask: 0xffffff },
        filter: { romOnly: "snesLoRom", skip: pcSkipRanges(opts.pcSkip) },
        ...(d.memory.REGRING != null ? {
          offset: d.memory.REGRING, entries: d.memory.REGRING_N, stride: REGRING_STRIDE,
          // master clock of the frame (line x 1364 + position) as the
          // instruction starts, like snes9x's V_Counter * H_Max + Cycles
          clock: { offset: 20 },
          fields: {
            a: { offset: 4, mask: 0xffff }, x: { offset: 4, shift: 16, mask: 0xffff },
            y: { offset: 8, mask: 0xffff }, s: { offset: 8, shift: 16, mask: 0xffff },
            d: { offset: 12, mask: 0xffff }, db: { offset: 12, shift: 16, mask: 0xff },
            p: { offset: 16, mask: 0x1ff },
          },
          note: "options.traceEntries: registers and the master clock before each ROM instruction (p = the status byte, emulation flag at bit 8), compared with snes9x's per-instruction columns",
        } : {}),
      },
      framebuffer: L.framebuffer,
      vramZero: ["vram"],
      conventions,
    },
  };
}

/**
 * ROM offset -> [bank, 16-bit address] under the cart's map: LoROM puts 32KB
 * at $8000 of banks $00-$7F, HiROM a whole 64KB bank at $40-$7F (the
 * $C0-$FF and $00-$3F:$8000 mirrors run the same bytes). The arm's code does
 * not depend on the bank: every pc it computes follows the live $pc.
 */
const romAddr = (mapping, off) => (mapping === "hirom"
  ? [0x40 | (off >> 16), off & 0xffff]
  : [off >> 15, 0x8000 + (off & 0x7fff)]);
/** ROM offset -> 24-bit address with the bank's $80 mirror folded. */
const armAddr = (mapping, off) => { const [b, a] = romAddr(mapping, off); return ((b & 0x7f) << 16) | a; };

/**
 * options.breakArm as a 24-bit address with the $80 mirror folded.
 * @param {unknown} v  a number or "$808123" / "0x808123" / "808123" hex
 * @returns {number|null}
 */
function parseBreakArm(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/^\$|^0x/i, ""), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) throw new Error(`snes recompile: options.breakArm must be a 24-bit address, got ${JSON.stringify(v)}`);
  return (((n >>> 16) & 0x7f) << 16) | (n & 0xffff);
}
/** @param {any} stats */
function breakFlip(stats) {
  stats.brokenArms = (stats.brokenArms ?? 0) + 1;
  return " (global.set $a (i32.xor (global.get $a) (i32.const 1)))";
}


/**
 * Yield a WAT string literal's escaped bytes in pieces.
 * @param {Uint8Array} bytes
 */
function* escChunks(bytes, piece = 1 << 20) {
  for (let i = 0; i < bytes.length; i += piece) {
    const end = Math.min(bytes.length, i + piece);
    const buf = Buffer.allocUnsafe((end - i) * 3);
    let o = 0;
    for (let j = i; j < end; j++) {
      const v = bytes[j];
      buf[o++] = 0x5c;
      const hi = v >> 4, lo = v & 15;
      buf[o++] = hi < 10 ? 0x30 + hi : 0x57 + hi;
      buf[o++] = lo < 10 ? 0x30 + lo : 0x57 + lo;
    }
    yield buf.toString("latin1");
  }
}

/**
 * The pc ranges the ring skips: the built-in boot loops plus options.pcSkip,
 * or none at all for pcSkip "none".
 * @param {SnesOptions["pcSkip"]} v
 */
function pcSkipRanges(v) {
  if (v === "none") return [];
  return [...PCRING_SKIP_DEFAULT, ...parsePcSkip(v)];
}

/** @param {SnesOptions["pcSkip"]} v */
function parsePcSkip(v) {
  if (!v) return [];
  if (typeof v === "string") {
    return v.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const [lo, hi] = p.split("-");
      return [parseInt(lo, 16), parseInt(hi || lo, 16)];
    });
  }
  return v.map(([lo, hi]) => [lo, hi ?? lo]);
}

/**
 * Emit the whole module as WAT text chunks.
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* emitWat(rom, opts = {}) {
  const d = describe(rom, opts);
  if (!d.supported) throw new Error(`snes recompile refused: ${d.refusal}`);
  // the image as snes9x holds it (copier header gone, halves in place, padded)
  const img = loadRom(toBytes(rom), opts).img;
  const lay = d.memory;
  const narms = lay.narms;
  const stats = opts.stats ?? {};
  const breakAt = parseBreakArm(opts.breakArm);
  Object.assign(stats, { arms: narms, lowered: 0, interpreted: 0, trapped: 0, dual: 0, reasons: {} });

  yield `(module\n  (memory (export "memory") ${lay.pages})`;
  yield "\n" + globalsWat(lay);
  yield apuGlobalsWat();
  yield "\n" + memWat(lay);
  // The CPU bus map (snes9x Memory.Map), 4096 blocks x {type, base}.
  const chip = chipFor(d.coprocessor, d.chipImpl);
  const chipMap = chip?.buildMap ? (api) => chip.buildMap(api, lay, d) : undefined;
  yield "\n" + `  (data (i32.const ${MAPTAB}) "` + [...escChunks(buildMemMap({ map: d.board, romSize: img.length, romSizeByte: d.romSizeByte, sramSizeByte: d.sramSizeByte, sramBase: lay.SRAM, chipMap, multi: d.multi }))].join("") + '")';
  // the coprocessor, or the no-chip bodies of its hooks (coproc.js)
  yield "\n" + chipWat(d, lay);
  // an MSU-1 pack's data file and tracks (msu1.js)
  if (d.msu1) yield* msuDataWat(lay.MSU, d.msu1);
  yield "\n" + `  (data (i32.const ${ICOST}) "` + [...escChunks(interpCostTable())].join("") + '")';
  yield "\n" + interpWat(lay);
  // the RAM interpreter: every opcode lowered exactly as an arm is
  yield "\n" + interpGenWat();
  yield "\n" + apuWat(lay);
  yield "\n" + apuDataWat();
  yield "\n" + ppuDataWat();
  yield "\n" + ppuWat(lay);
  yield "\n" + renderWat(lay);

  const nshards = Math.ceil(narms / SH);
  for (let si = 0; si < nshards; si++) {
    const lo = si * SH, hi = Math.min(narms, lo + SH), cnt = hi - lo;
    const lines = [`  (func $shard${si} (param $id i32)`];
    for (let i = cnt - 1; i >= 0; i--) lines.push(`    (block $s${i}`);
    lines.push("    (block $sdef");
    const labels = new Array(cnt);
    for (let i = 0; i < cnt; i++) labels[i] = `$s${i}`;
    lines.push("      (br_table " + labels.join(" ") + " $sdef (local.get $id))");
    // $sdef's body comes FIRST: `br $sN` resumes just after $sN closes.
    lines.push("    ) (call $trap) (return)");
    for (let i = 0; i < cnt; i++) {
      const a = lay.armOffsets ? lay.armOffsets[lo + i] : lo + i;
      lines.push(`    ) ;; $s${i} @ ${a.toString(16).toUpperCase().padStart(6, "0")}`);
      lines.push(`    ${armCode(img, a, stats, d.mapping)}${breakAt !== null && armAddr(d.mapping, a) === breakAt ? breakFlip(stats) : ""} (return)`);
    }
    lines.push("    (call $trap))");
    yield "\n" + lines.join("\n");
  }
  if (breakAt !== null) {
    if (!stats.brokenArms) throw new Error(`snes recompile: options.breakArm $${breakAt.toString(16)} is not a ROM address of this cart`);
  }

  const skip = pcSkipRanges(opts.pcSkip);
  const pcv = "(i32.and (global.get $pc) (i32.const 0xFFFF))";
  const h4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");
  const terms = skip.map(([lo, hi]) =>
    `(i32.or (i32.lt_u ${pcv} (i32.const 0x${h4(lo)}))` +
    ` (i32.gt_u ${pcv} (i32.const 0x${h4(hi)})))`);
  let excl = terms.length ? terms[0] : "(i32.const 1)";
  for (const t of terms.slice(1)) excl = `(i32.and ${excl} ${t})`;
  const rw = opts.regwatchPc ? regwatchWat(opts.regwatchPc) : "";
  yield "\n" + stepHeadWat(rw, excl, lay) + shardDispatch(nshards) + "\n    (call $trap))";

  // PACKED: (offset, arm + 1) pairs, little-endian i32s. Arm i IS offset i.
  yield "\n" + `  (data (i32.const ${lay.PACKED}) "`;
  const PER = 1 << 17;
  for (let i = 0; i < narms; i += PER) {
    const end = Math.min(narms, i + PER);
    const tab = new Uint8Array((end - i) * 8);
    const dv = new DataView(tab.buffer);
    for (let k = i; k < end; k++) {
      dv.setUint32((k - i) * 8, lay.armOffsets ? lay.armOffsets[k] : k, true);
      dv.setUint32((k - i) * 8 + 4, k + 1, true);
    }
    yield* escChunks(tab);
  }
  yield '")';
  yield "\n" + frameWat(lay);
  yield "\n" + `  (data (i32.const ${ROM}) "`;
  yield* escChunks(img);
  yield '")';
  if (d.saveRamBytes) yield "\n" + `  (data (i32.const ${lay.SRAMINIT}) "` + [...escChunks(d.saveRamBytes)].join("") + '")';
  yield "\n)";
}

/**
 * One arm body: the lowered instruction plus its pc/cycle tail, or a call
 * into the RAM interpreter for bytes the lowerer refuses (brk/cop/stp).
 * The nine M/X-dependent immediates carry BOTH readings.
 * @param {Uint8Array} img
 * @param {number} a
 * @param {any} stats
 */
function armCode(img, a, stats, mapping) {
  const [pb, pc16] = romAddr(mapping, a);
  let mode = null;
  try { mode = decode(img, a).mode; } catch { mode = null; }
  try {
    let code;
    if ((mode === "immM" || mode === "immX") && a + 3 <= img.length) {
      const fl = mode === "immM" ? "fm" : "fx";
      code = `(if (global.get $${fl}) (then ${arm(img, a, 2, pb, pc16)}) (else ${arm(img, a, 3, pb, pc16)}))`;
      stats.dual++;
    } else {
      code = arm(img, a, mode ? oplen(mode, 1, 1) : 1, pb, pc16);
    }
    stats.lowered++;
    return code;
  } catch (e) {
    const r = String(e.message);
    stats.reasons[r] = (stats.reasons[r] ?? 0) + 1;
    stats.interpreted++;
    stats.trapped = stats.interpreted;   // "trapped" in the shared stats vocabulary: not lowered
    return "(call $istep)";
  }
}

/** Lower one instruction of length n and append its pc/cycle tail. */
function arm(img, a, n, pb, pc16) {
  return lowerArm(img, a, n, pb, pc16);
}

/**
 * Binary search over shard index (a linear `if` chain cost ~137M compares
 * per frame at a 3MB cart's 3,072 shards and looked like a hang).
 */
function shardDispatch(nshards, lo = 0, hi = nshards, indent = 4) {
  const pad = " ".repeat(indent);
  if (hi - lo === 1) return `${pad}(call $shard${lo} (i32.sub (local.get $id) (i32.const ${lo * SH}))) (return)`;
  const mid = (lo + hi) >> 1;
  return `${pad}(if (i32.lt_u (local.get $id) (i32.const ${mid * SH}))\n` +
    `${pad}  (then\n` +
    shardDispatch(nshards, lo, mid, indent + 4) + `\n${pad}  )\n` +
    `${pad}  (else\n` +
    shardDispatch(nshards, mid, hi, indent + 4) + `\n${pad}  ))`;
}

/**
 * Convenience: the whole module as one string (small carts, tests, debugging;
 * a commercial ROM's module is hundreds of MB to GBs, stream it instead).
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 */
export async function emitWatString(rom, opts) {
  const parts = [];
  for await (const c of emitWat(rom, opts)) parts.push(c);
  return parts.join("");
}
