// SNES WAT backend: statically recompile a whole LoROM or HiROM SNES
// cartridge into one WAT module (a wasmcart), ported from sms-wat's
// emit_snes.py. The cart carries snes9x's bus (memmap.js), CPU timing and
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

import { decode, lower, oplen, isopTable, modeTable, interpCostTable, pcRel, IO1 } from "./lower.js";
import {
  computeLayout, FB_W, FB_H, WRAM, VRAM, CGRAM, OAM, SRAMB, OPTAB, MODTAB, PROBE,
  PROBE_FIELDS, INPUT, ROM, PCRING, PCRING_N, MAPTAB, APUST, ICOST,
} from "./layout.js";
import { buildMemMap, sramMaskFor } from "./memmap.js";
import { globalsWat, memWat, interpWat, interpTablesWat } from "./cpu-wat.js";
import { ppuDataWat, ppuWat, renderWat } from "./ppu-wat.js";
import { apuWat, apuDataWat, apuGlobalsWat, APU_OFF } from "./apu-wat.js";
import { regwatchWat, stepHeadWat, frameWat } from "./frame-wat.js";

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

// Coprocessor type by the chipset byte's high nibble (when the low nibble
// says a coprocessor is present).
const COPROCESSORS = {
  0x0: "DSP", 0x1: "SuperFX (GSU)", 0x2: "OBC1", 0x3: "SA-1", 0x4: "S-DD1",
  0x5: "S-RTC", 0xe: "Super Game Boy / Satellaview", 0xf: "custom (SPC7110 / ST01x / CX4)",
};

const MAPPINGS = { lorom: 0x7fc0, hirom: 0xffc0, exhirom: 0x40ffc0 };

/** options.traceEntries: the register ring's entry size and maximum length. */
const REGRING_STRIDE = 32;
const REGRING_MAX = 1 << 18;

/**
 * @typedef {object} SnesOptions
 * @property {number} [regwatchPc]  16-bit ROM address for the REGISTER WATCH probe (0/absent = off)
 * @property {Array<[number, number]>|string} [pcSkip]  extra pc-ring skip ranges, [[lo,hi],...] or "806B-806D,9A74-9A8A"
 * @property {number} [limit]  emit arms only for ROM offsets below this (tests / debugging)
 * @property {number} [traceEntries]  ALSO record a ring WITH the 65816 registers for findDiverge
 *   level:'instruction' (a power of two, 1024 to 262144; the entries are the ROM pc ring's, so
 *   the same filter applies): 32 bytes {pc24, A | X<<16, Y | S<<16, D | DB<<16, P | E<<8}
 *   above the cart's other memory. Off by default: the default module is unchanged.
 * @property {number|string} [breakArm]  DEBUG / MUST-FAIL CONTROL: the arm at this 24-bit ROM
 *   address (the $80 mirror is the same) also flips bit 0 of A after it runs, so an
 *   instruction-level differ must name exactly this instruction
 * @property {object} [stats]  filled with {arms, lowered, interpreted, dual, reasons}
 */

/** @param {Uint8Array} rom */
function toBytes(rom) {
  if (rom instanceof Uint8Array) return rom;
  if (ArrayBuffer.isView(rom)) return new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength);
  if (rom instanceof ArrayBuffer) return new Uint8Array(rom);
  throw new TypeError("snes: rom must be a Uint8Array/Buffer");
}

/** Score how plausible a header at `base` is (higher is better). */
function scoreHeader(img, base, mapping) {
  if (img.length < base + 0x40) return -1;
  let s = 0;
  const mapMode = img[base + 0x15];
  const want = { lorom: [0x20, 0x30, 0x23, 0x32], hirom: [0x21, 0x31, 0x35], exhirom: [0x25, 0x35] }[mapping];
  if (want.includes(mapMode)) s += 4;
  const ck = img[base + 0x1e] | (img[base + 0x1f] << 8);
  const cm = img[base + 0x1c] | (img[base + 0x1d] << 8);
  if (((ck + cm) & 0xffff) === 0xffff && ck !== 0 && cm !== 0) s += 4;
  const reset = img[base + 0x3c] | (img[base + 0x3d] << 8);
  if (reset >= 0x8000) s += 2;
  let printable = 0;
  for (let i = 0; i < 21; i++) { const c = img[base + i]; if (c >= 0x20 && c < 0x7f) printable++; }
  if (printable >= 18) s += 1;
  if (img[base + 0x17] >= 0x07 && img[base + 0x17] <= 0x0d) s += 1;   // ROM size byte
  return s;
}

/**
 * Header-derived configuration: mapping, copier header, sizes, SRAM mask,
 * coprocessor refusal, and the cart layout the verify op compares.
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 */
export function describe(rom, opts = {}) {
  const raw = toBytes(rom);
  // A copier .smc carries 512 bytes in front of the image; the test is the
  // file size, there is no magic number.
  const copierHeader = raw.length % 1024 === 512 ? 512 : 0;
  const img = raw.subarray(copierHeader);
  let best = null;
  for (const [mapping, base] of Object.entries(MAPPINGS)) {
    const sc = scoreHeader(img, base, mapping);
    if (sc >= 0 && (!best || sc > best.score)) best = { mapping, base, score: sc };
  }
  if (!best) best = { mapping: "lorom", base: 0x7fc0, score: 0 };
  const h = best.base;
  const byte = (o) => (img.length > h + o ? img[h + o] : 0);
  const title = Array.from(img.subarray(h, Math.min(img.length, h + 21)), (c) =>
    c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ").join("").trimEnd();
  const mapMode = byte(0x15);
  const chipset = byte(0x16);
  const sramByte = byte(0x18);
  // snes9x Memory.SRAMMask from the header's SRAM size byte: the SRAM
  // decodes only log2(size) address lines, so it MIRRORS through its window.
  // No SRAM: mask 0, reads see byte 0 of the (0x60-filled) buffer and writes
  // are dropped, as in snes9x. The cart keeps 32KB, so the mask is capped.
  const sramMask = sramMaskFor(sramByte);
  const sramSize = sramByte === 0 || sramByte > 7 ? 0 : 1024 << sramByte;
  const hasCoproc = (chipset & 0x0f) >= 3;
  const coprocessor = hasCoproc ? (COPROCESSORS[chipset >> 4] ?? `unknown (chipset $${chipset.toString(16)})`) : null;
  const vec = best.mapping === "hirom" ? 0xfffc : 0x7ffc;
  const reset = img.length > vec + 1 ? img[vec] | (img[vec + 1] << 8) : 0;

  let refusal = null;
  if (img.length < 0x8000) refusal = `ROM image is ${img.length} bytes; a cart needs at least one 32KB bank`;
  else if (best.mapping === "hirom" && img.length < 0x10000) refusal = `ROM image is ${img.length} bytes; a HiROM cart needs at least one 64KB bank`;
  else if (coprocessor) refusal = `cart uses the ${coprocessor} coprocessor (chipset byte $${chipset.toString(16).padStart(2, "0")}); the SNES recompiler models the base console only`;
  else if (best.mapping === "exhirom" || img.length > 0x400000) refusal = `cart is ExHiROM / over 4MB (map mode $${mapMode.toString(16)}); the SNES recompiler implements the LoROM and HiROM memory maps only`;

  const layout = computeLayout(img.length, sramMask, Math.max(1, opts.limit ? Math.min(opts.limit, img.length) : img.length));
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
  return {
    platform: "snes",
    referenceCore: "snes9x",
    supported: !refusal,
    refusal,
    title,
    mapping: best.mapping,
    headerOffset: h,
    fastRom: (mapMode & 0x10) !== 0,
    romSizeByte: byte(0x17),
    sramSizeByte: sramByte,
    mapMode,
    chipset,
    coprocessor,
    romSize: img.length,
    copierHeader,
    sramSize,
    sramMask,
    region: byte(0x19),
    resetVector: reset,
    layout: cartLayout(layout, sramSize),
    memory: layout,
    conventions,
    options: {
      regwatchPc: "16-bit ROM address: record (A, X, Y, P, $8D, D, [$00]) each time execution reaches it (REGWATCH probe)",
      pcSkip: "extra 16-bit pc ranges the ROM pc ring skips, [[lo,hi],...] or \"806B-806D,9A74-9A8A\"; \"none\" also drops the built-in boot-loop ranges",
      limit: "emit arms only below this ROM offset (debugging)",
      breakArm: "DEBUG / must-fail control: 24-bit ROM address whose arm also flips bit 0 of A",
      traceEntries: "power of two 1024-262144: also record the 65816 registers per ROM instruction for findDiverge level:'instruction' (off by default)",
    },
  };
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
  if (sramSize) diagnosticRegions.sram = { offset: SRAMB, length: Math.min(sramSize, 0x8000), ref: "save_ram" };
  return {
    regions,
    diagnosticRegions,
    probe: {
      offset: PROBE,
      fields: Object.fromEntries(Object.entries(PROBE_FIELDS).map(([k, o]) => [k, { offset: PROBE + o, size: 4 }])),
    },
    trap: { flag: "trapped", pc: "trappc" },
    pcRing: { offset: PCRING, entries: PCRING_N, stride: 4, cursorField: "npc", format: "u32 pc24, circular" },
    framebuffer: { offset: lay.FB, width: FB_W, height: FB_H, format: "bgra8888", note: "u32 words 0xAARRGGBB" },
    input: { offset: INPUT, length: 64 },
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
  const img = toBytes(rom).subarray(d.copierHeader);
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
  yield "\n" + `  (data (i32.const ${MAPTAB}) "` + [...escChunks(buildMemMap({ mapping: d.mapping, romSize: img.length, romSizeByte: d.romSizeByte, sramSizeByte: d.sramSizeByte }))].join("") + '")';
  // The interpreter's opcode tables come from the same decoder table the
  // arms are lowered from, so the two cannot drift.
  yield "\n" + `  (data (i32.const ${OPTAB}) "` + [...escChunks(isopTable())].join("") + '")';
  yield "\n" + `  (data (i32.const ${MODTAB}) "` + [...escChunks(modeTable())].join("") + '")';
  yield "\n" + `  (data (i32.const ${ICOST}) "` + [...escChunks(interpCostTable())].join("") + '")';
  yield "\n" + interpTablesWat(lay, OPTAB, MODTAB);
  yield "\n" + interpWat(lay);
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
      const a = lo + i;
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
      dv.setUint32((k - i) * 8, k, true);
      dv.setUint32((k - i) * 8 + 4, k + 1, true);
    }
    yield* escChunks(tab);
  }
  yield '")';
  yield "\n" + frameWat(lay);
  yield "\n" + `  (data (i32.const ${ROM}) "`;
  yield* escChunks(img);
  yield '")';
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
  const [body, flow, cyc] = lower(img, a, n, pb, pc16);
  // Every pc the tail computes stays in the RUNNING program bank (the live
  // $pc's bank), except a long jump, which names its own.
  let tail;
  if (flow === null) tail = `(global.set $pc ${pcRel(n)})`;
  else if (flow.kind === "jp") tail = `(global.set $pc (i32.const ${((flow.bank & 0xff) << 16) | (flow.addr & 0xffff)}))`;
  else if (flow.kind === "jp_bank") tail = `(global.set $pc (i32.or (i32.and (global.get $pc) (i32.const 0xFF0000)) (i32.const ${flow.addr & 0xffff})))`;
  else if (flow.kind === "jp_expr") tail = "(global.set $pc (global.get $t))";
  else {
    // A relative branch cannot leave its bank.
    // A taken branch costs one more internal cycle, two in emulation mode
    // when it lands in another page (snes9x bOP).
    const taken = `${IO1} (if (i32.and (global.get $fe) (i32.ne (i32.and ${pcRel(n)} (i32.const 0xFF00)) (i32.and ${pcRel(flow.delta)} (i32.const 0xFF00)))) (then ${IO1}))`;
    tail = flow.kind === "jp_file"
      ? `${flow.noTakenIo ? "" : taken} (global.set $pc ${pcRel(flow.delta)})`
      : `(if ${flow.cond} (then ${taken} (global.set $pc ${pcRel(flow.delta)})) (else (global.set $pc ${pcRel(n)})))`;
  }
  // n program bytes at the code region's speed plus the static internal
  // cycles, charged BEFORE the body: snes9x has fetched the instruction and
  // (mostly) done its internal cycles by the time the data access happens,
  // and an access observes the clock before its own cost is added.
  return `(global.set $cyc (i32.sub (global.get $cyc) (i32.add (i32.mul (global.get $ms) (i32.const ${n})) (i32.const ${cyc * 6})))) ${body} ${tail}`;
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
