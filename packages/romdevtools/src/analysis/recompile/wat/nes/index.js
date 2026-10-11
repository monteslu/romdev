// NES WAT backend: statically recompile an iNES ROM into a wasmcart whose
// machine model is fceumm's, because fceumm is what the cart is verified
// against through romdev.
//
//   CPU   cpu.js   - decoded from PRG bytes, fceumm x6502.c cycle rules.
//   PPU   ppu.js   - a port of fceumm ppu.c (lazy RefreshLine, sprite fetch
//                    at end of line, CheckSpriteHit).
//   FRAME wc_render - FCEUPPU_Loop: a frame STARTS at line 240, then vblank
//                    (flag set, 12 dots, NMI), then the pre-render line, then
//                    lines 0-239. Two "ppudead" frames at power run the CPU
//                    with no vblank at all, as fceumm does after PowerNES.
//   X6502_Run(dots) adds dots*16 to a signed budget and runs whole
//   instructions while it is positive; each cycle costs 48. Instructions that
//   overrun carry the debt into the next Run, exactly as fceumm's _count does.
//   APU   only the parts the CPU can observe: DMC DMA cycle steals (4 per
//         sample byte), the frame sequencer, length counters and $4015
//         status, the frame and DMC IRQs, and the $4016/$4017 pads. No audio.
//   IRQ   X6502_Run's order (NMI2, NMI, maskable IRQ gated by _PI).
//   MAP   mappers.js: NROM, UxROM, CNROM, MMC1 (fceumm boards/).
//
// Every PRG offset gets an arm (data bytes included) so any entry point the
// game reaches is covered; only the twelve KIL/JAM bytes become traps (pc and
// opcode recorded in the probe block). Code BELOW $8000 (copied into RAM or
// WRAM) and instructions straddling a bank window run through $dynop: the
// same lowering with the operand bytes read at run time.
//
// Ported from the earlier Python emitter (8 mapper-0
// carts cycle-exact against fceumm through frame 2905 with input). The WAT
// text is kept identical to the Python emitter's so the two can be diffed;
// the one intended difference is that emit_nes.py's wr8 carried the
// $4010/$4012/$4013/$4015 block twice (idempotent), and it is emitted once
// here.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lower, cyc, PACK_P, Unsupported, OPS, LEN } from "./cpu.js";
import {
  FB_W, FB_H, NESFB, WRAM, CHR, APUREG, RGBTAB, CYCTAB, DMCTAB,
  NTRAM, PAL, OAM, EMPH, luts, globalsWat, ppuWat,
} from "./ppu.js";
import { MAPPERS, ntSelFixed } from "./mappers.js";
import { assertHostSpans, padAddr, WC_ABI_VERSION } from "../cart-abi.js";
import { AUDIO, AUDIO_CAP, AUDIO_CURSOR, WAVE, WL1, WL2, NOISETAB, MUTE, MUTE_CHANNELS, soundConstants, apuGlobalsWat, apuWat } from "./apu.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FCEUMM = JSON.parse(readFileSync(path.join(__dirname, "fceumm-tables.json"), "utf8"));
const CYCLES = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "m6502-cycles.json"), "utf8"));
/** RectDuties[4] as bytes, next to the other audio tables. */
const DUTIES = NOISETAB + 0x60; // 0xF6CA0, 4 bytes (apu.js MUTE is at 0xF6CC0)
/** fceumm's sound constants (sound.c SetSoundVariables, filter.c SexyFilter) + table addresses. */
const SOUND = { ...soundConstants(FCEUMM.audio), WAVE, WL1, WL2, NOISETAB, DUTIES };

export const platforms = ["nes"];

/** Reference core the cart is verified against. */
export const REFERENCE_CORE = "fceumm";

// ---- linear-memory probe block (host-readable via wasm({op:'read'})) -------
// Cart GLOBALS are invisible to the host, so everything worth reading from
// outside is mirrored here.
/** fceumm SetSoundVariables: fhinc = 14915 * 24 (NTSC), in 1/48 CPU cycles. */
const FHINC = 14915 * 24;
/** sound.c lengthtable[0x20], 32 bytes. */
export const LENTAB = 0x06C40;

export const PROBE = 0x08000;   // PROBE_FIELDS, u32 each
export const PCRING = 0x09000;  // 1024 x (pc u16 | opcode<<16, ts): last instructions
/** options.traceEntries rings live above the ABI block (memory is 1MB). */
export const BIGRING = 0xB0000;
export const BIGRING_MAX = 16384; // x 16 bytes = 256KB, ends at 0xF0000
export const INPUT = 0x08400;   // 80 bytes host pad state (inputPtr, 4 x 20-byte wc_pad_t, ABI v4) - MUST NOT be 0
export const TIME = 0x08480;    // 20 bytes host clock (timePtr) - MUST NOT be 0, 8-aligned
export const FB = 0x70000;
export const ABI = FB + FB_W * FB_H * 4 + 0x1000;
// Every host-written span checked against each other and the cart state
// around them, at import (so at every build). Under ABI v3 TIME sat at
// INPUT+64; the v4 pad block is 80 bytes and would have run into it.
assertHostSpans({
  who: "nes", info: ABI, input: INPUT, time: TIME, audio: AUDIO, audioBytes: AUDIO_CAP * 4, audioWrite: AUDIO_CURSOR,
  others: [["RAM", 0, 0x800], ["PROBE", PROBE, 0x400], ["PCRING", PCRING, 1024 * 8], ["FB", FB, FB_W * FB_H * 4],
    ["BIGRING", BIGRING, BIGRING_MAX * 16], ["NTRAM", NTRAM, 0x800], ["OAM", OAM, 256], ["WRAM", WRAM, 0x2000], ["CHR", CHR, 0x2000]],
});

export const PROBE_FIELDS = ["steps", "trapped", "trappc", "pc", "frame", "nnmi", "ts",
  "a", "x", "y", "s", "p", "ppu0", "ppu1", "ppustatus",
  "refaddr", "tmpaddr", "xoff", "joy", "trapop", "nvram",
  "ringi", "nbrk", "nemph", "cnt", "apu4017", "dmcsize", "dmcirq", "nirq", "sirq", "mapwarn", "ndyn", "sndframes", "ndmcout"];

/**
 * The cart's `romdev.recompile` layout (schema: recompile/recompile-section.js):
 * linear-memory regions byte-compared against fceumm's memory regions, CPU
 * fields compared against cpu({op:'read'}), cart-only probe fields. Static
 * for every NES cart.
 */
const p4 = (f) => PROBE + 4 * PROBE_FIELDS.indexOf(f);
export const layout = {
  regions: {
    ram: { offset: 0x0000, length: 0x800, ref: "system_ram" },
    nametables: { offset: NTRAM, length: 0x800, ref: "nes_nametables" },
    palette: { offset: PAL, length: 32, ref: "nes_palette" },
    oam: { offset: OAM, length: 256, ref: "nes_oam" },
    chr: { offset: CHR, length: 0x2000, ref: "nes_chr" },
  },
  // P is compared without bits 4-5 (B and the unused bit are not flags).
  // `cycles` is fceumm's internal X.count: equal only when both sides are on
  // the same CPU cycle, which registers alone cannot show.
  fields: {
    pc: { offset: p4("pc"), size: 2, ref: "cpu:pc" },
    a: { offset: p4("a"), size: 1, ref: "cpu:registers.A" },
    x: { offset: p4("x"), size: 1, ref: "cpu:registers.X" },
    y: { offset: p4("y"), size: 1, ref: "cpu:registers.Y" },
    s: { offset: p4("s"), size: 1, ref: "cpu:registers.S" },
    p: { offset: p4("p"), size: 1, ref: "cpu:registers.P", mask: 0xCF },
    cycles: { offset: p4("cnt"), size: 4, signed: true, ref: "cpu:coreInternal.count" },
  },
  probe: Object.fromEntries(["trapped", "trappc", "trapop", "steps", "frame", "nnmi", "nbrk", "dmcirq", "nirq", "mapwarn", "ndyn"]
    .map((f) => [f, { offset: p4(f), size: 4 }])),
  // The Python verifier's VRAM-zero control wiped nametables + CHR.
  vramZero: ["nametables", "chr"],
  // fceumm's audio_batch_cb stream: 48 kHz s16, mono as L = R (apu.js)
  audio: { sampleRate: 48000, channels: 2, format: "s16", reference: "output",
    muteMask: { offset: MUTE, size: 1, channels: MUTE_CHANNELS } },
};

/**
 * Frame / input conventions. romdev's wasmcart host settles 1 frame at load,
 * fceumm 5; the cart models fceumm's frame loop exactly (including the two
 * ppudead frames), so the same TOTAL frame count is the same picture and the
 * cart needs no warm-up frames. The pad is read POSITIONALLY: the east face
 * button (WC_BTN_B, RetroPad 'a') is NES A, south (WC_BTN_A) is NES B.
 */
export const conventions = { warmupFrames: 0, buttons: "positional" };

/** Diagnostic spans that are not compared (probe block, pc ring, framebuffer). */
export const diagnostics = {
  probeBlock: { offset: PROBE, fields: PROBE_FIELDS, stride: 4 },
  pcRing: { offset: PCRING, entries: 1024, stride: 8, format: "u32 pc|opcode<<16, u32 ts" },
  framebuffer: { offset: FB, width: FB_W, height: FB_H, format: "u32 0xAABBGGRR" },
};

/**
 * Where the pc ring is for these options: the default 1024 entries of
 * {pc|opcode<<16, ts} at PCRING, or options.traceEntries (a power of two up
 * to 16384) at BIGRING with the registers as well: {pc|opcode<<16, ts,
 * A|X<<8|Y<<16|S<<24, P}. A frame runs ~7,500-15,000 instructions, so only
 * a ring of 16384+ holds a whole frame for findDiverge level:'instruction'.
 * @param {object} [opts]
 */
export function pcRingFor(opts = {}) {
  const n = opts.traceEntries;
  if (n == null) return { offset: PCRING, entries: 1024, stride: 8 };
  if (!Number.isInteger(n) || n < 1024 || n > BIGRING_MAX || (n & (n - 1))) {
    throw new Error(`nes recompile: options.traceEntries must be a power of two from 1024 to ${BIGRING_MAX}, got ${n}`);
  }
  return { offset: BIGRING, entries: n, stride: 16 };
}

/**
 * The instruction trace declaration (recompile-section.js `trace`): every
 * executed instruction's pc, opcode and CPU cycle timestamp (fceumm's
 * `timestamp`, which the core's instruction trace records as its clock).
 * @param {object} [opts]
 */
export function traceFor(opts = {}) {
  const r = pcRingFor(opts);
  const regs = r.stride === 16 ? {
    a: { offset: 8, mask: 0xFF }, x: { offset: 8, shift: 8, mask: 0xFF }, y: { offset: 8, shift: 16, mask: 0xFF },
    s: { offset: 8, shift: 24, mask: 0xFF }, p: { offset: 12, mask: 0xCF, note: "B and bit 5 are not flags" },
  } : {};
  return {
    offset: r.offset, entries: r.entries, stride: r.stride,
    cursor: { offset: PROBE + 4 * PROBE_FIELDS.indexOf("ringi"), mode: "count", note: "written by $probe at the end of every wc_render" },
    pc: { offset: 0, mask: 0xFFFF }, clock: { offset: 4, unit: "cpu cycles (fceumm timestamp)" },
    fields: { opcode: { offset: 0, shift: 16, mask: 0xFF }, ...regs },
  };
}

/**
 * Parse the iNES header and derive everything the emitter needs.
 * @param {Uint8Array} rom  the whole .nes file
 * @param {object} [_opts]
 */
export function describe(rom, opts = {}) {
  rom = toBytes(rom);
  if (rom.length < 16 || rom[0] !== 0x4E || rom[1] !== 0x45 || rom[2] !== 0x53 || rom[3] !== 0x1A) {
    throw new Error("nes recompile: not an iNES image (missing 'NES\\x1A' header)");
  }
  rom = cleanHeader(rom);
  // ines.c iNES_get_mapper_id / iNES_read_header_info: byte 7 bits 2-3 pick
  // the header version. NES 2.0 adds byte 8's mapper bits and byte 9's size
  // nibbles; "archaic" iNES (01 or 11) ignores byte 7 entirely, because old
  // dumpers left junk there.
  const ver = rom[7] & 0x0C;
  let nes2 = ver === 0x08;
  let mapper = nes2 ? ((rom[8] << 8) & 0xF00) | (rom[7] & 0xF0) | (rom[6] >> 4)
    : ver === 0 ? (rom[7] & 0xF0) | (rom[6] >> 4) : rom[6] >> 4;
  let prgBanks = rom[4], chrBanks = rom[5];
  if (nes2) {
    if ((rom[9] & 0x0F) === 0x0F || (rom[9] & 0xF0) === 0xF0) throw new Error("nes recompile: NES 2.0 exponent-multiplier ROM sizes are not supported");
    prgBanks |= (rom[9] & 0x0F) << 8;
    chrBanks |= (rom[9] & 0xF0) << 4;
  }
  const trainer = (rom[6] & 4) ? 512 : 0;
  const prgStart = 16 + trainer;
  const prgSize = prgBanks * 0x4000;
  let chrSize = chrBanks * 0x2000;
  if (prgSize === 0) throw new Error("nes recompile: header declares 0 PRG banks");
  if (rom.length < prgStart + prgSize + chrSize) {
    throw new Error(`nes recompile: file is ${rom.length} bytes, header needs ${prgStart + prgSize + chrSize}`);
  }
  // iNESCart.mirror: 2 = four-screen, else flags6 bit 0 (1 = vertical)
  let mirror = (rom[6] & 8) ? 2 : (rom[6] & 1);
  let submapper = nes2 ? rom[8] >> 4 : 0;
  let region = nes2 ? rom[12] & 3 : 0;
  let battery = !!(rom[6] & 2);
  // NES 2.0 byte 10: PRG RAM (low nibble) + battery PRG RAM (high nibble), 64 << n
  let prgRam = nes2 ? ((rom[10] & 0x0F) ? 64 << (rom[10] & 0xF) : 0) + ((rom[10] & 0xF0) ? 64 << (rom[10] >> 4) : 0) : null;
  // ines.c: an iNES 1.0 file whose NAME carries a PAL-country tag runs as PAL.
  if (!nes2 && opts.romPath && PAL_NAME_TAGS.some((t) => String(opts.romPath).includes(t))) region = 1;
  let headerFix = null;
  if (!nes2) {
    // ines.c CheckHInfo(): the CRC32 (PRG+CHR) keyed correction table.
    const crc = crc32(rom.subarray(prgStart, prgStart + prgSize + chrSize)) >>> 0;
    const row = INES_CORRECT.get(crc);
    if (row) {
      const [, fMapper, fSub, fMirror, fBattery, fPrgRam, , fRegion, fExtra] = row;
      headerFix = { crc32: crc.toString(16).padStart(8, "0"), mapper: fMapper, submapper: fSub, mirror: fMirror, battery: fBattery, prgram: fPrgRam, region: fRegion, extra: fExtra };
      if (fMapper >= 0) {
        if (fExtra === 0x800 && chrSize) chrSize = 0; // the dump's CHR is really CHR RAM
        mapper = fMapper & 0xFFF;
      }
      if (fSub >= 0) { nes2 = true; submapper = fSub; }
      if (fMirror >= 0) {
        if (fMirror === 8) { if (mirror === 2) mirror = 0; }
        else mirror = fMirror;
      }
      if (fBattery > 0) battery = true;
      if (fRegion >= 0) region = fRegion;
      if (fPrgRam >= 0) prgRam = ((fPrgRam & 0x0F) ? 64 << (fPrgRam & 0xF) : 0) + ((fPrgRam & 0xF0) ? 64 << ((fPrgRam >> 4) & 0xF) : 0);
    }
    if ((mapper === 118 || mapper === 24 || mapper === 26) && mirror === 2) mirror = 0;
    if (mapper === 99) mirror = 2;
  }
  // SetupCartMirroring: 2 = four-screen, >= 0x10 one-screen (hard-wired),
  // else H/V with bit 2 = hard-wired (the mapper cannot change it).
  const mirroring = mirror === 2 ? "four-screen" : mirror >= 0x10 ? ((mirror & 1) ? "one-screen-b" : "one-screen-a")
    : ((mirror & 1) ? "vertical" : "horizontal");
  const mirrorHard = mirror >= 0x10 || !!(mirror & 4);
  // ines.c SetInput(): byte 15 (ExpDevice) or the CRC32 table assigns the
  // controllers; the cart models two standard pads only.
  const crcAll = crc32(rom.subarray(prgStart, prgStart + prgSize + (chrBanks * 0x2000))) >>> 0;
  let input = INPUT_DEV.expDevice[rom[15]] || null;
  if (!input) { const r = INPUT_DEV.byCrc.get(crcAll); if (r) input = r.slice(1); }
  const inputOk = !input || ((input[0] === -1 || input[0] === 1) && (input[1] === -1 || input[1] === 1) && (input[2] === -1 || input[2] === 0));
  const m = MAPPERS[mapper];
  let unsupportedReason = null;
  const facts = { prgSize, chrSize, submapper, nes2, prgRam, mirroring, mirrorHard, crc32: crcAll };
  if (!m) unsupportedReason = `mapper ${mapper} has no WAT backend yet (supported: ${Object.keys(MAPPERS).join(", ")})`;
  else if (m.supports && m.supports(facts)) unsupportedReason = m.supports(facts);
  else if (mirroring === "four-screen") unsupportedReason = "four-screen nametables (4KB of cart VRAM) are not modelled";
  else if (!inputOk) unsupportedReason = `fceumm attaches a non-gamepad input device (ports ${input[0]}/${input[1]}, expansion ${input[2]}; driver.h SI_*/SIFC_*)`;
  else if (region === 1) unsupportedReason = "PAL timing (fceumm runs this cart as PAL: NES 2.0 region, ines-correct.h, or a PAL tag in the file name)";
  else if (region === 3) unsupportedReason = "Dendy timing (fceumm runs this cart as a Dendy)";
  return {
    platform: "nes",
    referenceCore: REFERENCE_CORE,
    mapper,
    mapperName: m ? m.name : null,
    submapper,
    supported: unsupportedReason === null,
    unsupportedReason,
    nes2,
    prgBanks, chrBanks: chrSize / 0x2000, prgSize, chrSize,
    prgOffset: prgStart,
    chrOffset: prgStart + prgSize,
    trainer: trainer > 0,
    chrRam: chrSize === 0,
    mirroring,
    mirrorHard,
    region,
    battery,
    prgRam,
    headerFix,
    crc32: crcAll,
    inputDevices: input,
    arms: prgSize,
    layout: m && m.layout ? m.layout(layout) : layout,
    conventions,
  };
}

/** ines.c: iNES 1.0 file-name tags that make fceumm pick PAL. */
const PAL_NAME_TAGS = ["(E)", "(e)", "(Europe)", "(PAL)", "(F)", "(f)", "(G)", "(g)", "(I)", "(i)", "(S)", "(s)",
  "(France)", "(Germany)", "(Italy)", "(Spain)", "(Sweden)", "(Sw)", "(Australia)", "(A)", "(a)"];

/** ines-correct.h rows by CRC32; CheckHInfo takes the FIRST match. */
const INES_CORRECT = new Map();
const INES_JSON = JSON.parse(readFileSync(path.join(__dirname, "fceumm-ines-correct.json"), "utf8"));
for (const r of INES_JSON.rows) {
  if (!INES_CORRECT.has(r[0] >>> 0)) INES_CORRECT.set(r[0] >>> 0, r);
}
/** SetInput(): CRC32 -> [crc, input0, input1, inputfc] (first match), ExpDevice -> triple. */
const INPUT_DEV = { byCrc: new Map(), expDevice: INES_JSON.inputDevices.expDevice };
for (const r of INES_JSON.inputDevices.rows) if (!INPUT_DEV.byCrc.has(r[0] >>> 0)) INPUT_DEV.byCrc.set(r[0] >>> 0, r);

/**
 * fceumm ines.c's header clean-up: old dumpers wrote a signature over bytes
 * 7-15 ("DiskDude!", "demiforce", "Ni03"), which would otherwise read as a
 * mapper high nibble. Returns a copy with those bytes zeroed, as fceumm does.
 * @param {Uint8Array} rom
 */
function cleanHeader(rom) {
  const at = (o, str) => [...str].every((c, i) => rom[o + i] === c.charCodeAt(0));
  let from = -1, len = 0;
  if (at(7, "DiskDude") || at(7, "demiforce")) { from = 7; len = 9; }
  else if (at(0xA, "Ni03")) { if (at(7, "Dis")) { from = 7; len = 9; } else { from = 0xA; len = 6; } }
  if (from < 0) return rom;
  const h = Uint8Array.from(rom.subarray(0, 16));
  h.fill(0, from, from + len);
  const out = new Uint8Array(rom.length);
  out.set(rom);
  out.set(h, 0);
  return out;
}

/**
 * fceumm's palette[512] as the libretro blit indexes it: entry d*64+c is
 * colour c under emphasis bits d, built by ApplyDeemphasisComplete /
 * ApplyDeemphasisClassic: each channel is `(int)(ch * mul[d-1])` in C float
 * (float32) arithmetic, clamped to 255.
 * @returns {number[]} 0xRRGGBB
 */
export function palette512() {
  const { rtmul, gtmul, btmul } = FCEUMM.deemphasis;
  const f = Math.fround;
  const ch = (v, m) => Math.min(255, Math.trunc(f(f(v) * f(m))));
  const out = [];
  for (let d = 0; d < 8; d++) {
    for (const c of FCEUMM.paletteRgb) {
      let r = c >> 16, g = (c >> 8) & 0xFF, b = c & 0xFF;
      if (d) { r = ch(r, rtmul[d - 1]); g = ch(g, gtmul[d - 1]); b = ch(b, btmul[d - 1]); }
      out.push((r << 16) | (g << 8) | b);
    }
  }
  return out;
}

/** @param {Uint8Array|ArrayBuffer|Buffer} b */
function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  throw new TypeError("nes recompile: rom must be a Uint8Array/Buffer");
}

/** @param {Uint8Array} b */
function watBytes(b) {
  let s = "";
  for (let i = 0; i < b.length; i++) s += "\\" + (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}

/** @param {number[]} arr */
function u32le(arr) {
  const b = new Uint8Array(arr.length * 4);
  const dv = new DataView(b.buffer);
  arr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return b;
}

/**
 * The `romdev.recompile` custom section: everything the verify op needs to
 * compare this cart with the reference, so no sidecar file is required.
 * @param {Uint8Array} rom
 * @param {string} [sha1]  sha1 of the ROM file (hex), if the caller has it
 */
export function recompileSection(rom, sha1, opts = {}) {
  const d = describe(rom, opts);
  const ring = pcRingFor(opts);
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: "nes",
      reference: "nes",
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || null,
      mapper: d.mapper,
      mirroring: d.mirroring,
      ...conventions,
      ...d.layout,
      diagnostics: { ...diagnostics, pcRing: { ...diagnostics.pcRing, offset: ring.offset, entries: ring.entries, stride: ring.stride,
        ...(ring.stride === 16 ? { format: "u32 pc|opcode<<16, u32 ts, u32 A|X<<8|Y<<16|S<<24, u32 P" } : {}) } },
      trace: traceFor(opts),
      ...(opts.breakArm != null ? { debugBreakArm: opts.breakArm, warning: "built with options.breakArm: one arm is a deliberate no-op (a must-fail control), NOT a faithful cart" } : {}),
    },
  };
}

function cpuGlobals() {
  const g = ["a", "x", "y", "pc", "fn", "fv", "fd", "fz", "fc", "t", "t2", "t3",
    "ea", "trapped", "trappc", "trapop", "curpc", "cnt", "ts", "steps",
    "irqlow", "nframe", "nnmi", "nvram", "joy", "joy2", "joybit", "joybit2", "laststrobe",
    "ringi", "nbrk", "nemph", "apu4017", "lastts", "dmcbitcount",
    "dmcaddrlatch", "dmcsizelatch", "dmcformat", "dmcaddress", "dmcsize",
    "dmcshift", "dmchavedma", "dmcdmabuf", "dmchavesample", "dmcirq",
    "nirq", "fcnt", "sirq", "ench", "len0", "len1", "len2", "len3", "mapwarn", "d1", "d2", "ndyn"];
  let s = g.map((n) => `  (global $${n} (mut i32) (i32.const 0))\n`).join("");
  s += "  (global $s (mut i32) (i32.const 0xFD))\n";
  s += "  (global $fi (mut i32) (i32.const 1))\n";
  s += "  (global $dmcacc (mut i32) (i32.const 1))\n";
  s += "  (global $dmcperiod (mut i32) (i32.const 0x1AC))\n";
  // fceumm _PI (I flag before the previous instruction), the frame sequencer
  // (FCEUSND_Reset: fhcnt = fhinc; FCEUSND_Power: IRQFrameMode = 1, i.e.
  // the frame IRQ starts inhibited).
  s += "  (global $pi (mut i32) (i32.const 1))\n";
  s += `  (global $fhcnt (mut i32) (i32.const ${FHINC}))\n`;
  s += "  (global $irqfm (mut i32) (i32.const 1))\n";
  return s;
}

/**
 * Memory map, pads, APU DMC, OAM DMA, trap.
 * @param {object} mapper  MAPPERS[id].make(d, prg)
 */
function memWat(mapper) {
  return `
  (func $addcyc1
    (global.set $cnt (i32.sub (global.get $cnt) (i32.const 48)))
    (global.set $ts (i32.add (global.get $ts) (i32.const 1))))

  ;; Dummy read (uncarried address of an indexed access). Only I/O has
  ;; read side effects, so anything else is skipped.
  (func $dummyrd (param $a i32)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x2000))
                 (i32.lt_u (local.get $a) (i32.const 0x4018)))
      (then (drop (call $rd8 (local.get $a))))))

  ;; A read that can hit open bus, with X.DB (the last byte the bus carried)
  ;; supplied by the caller: fceumm's ANull returns X.DB for $4000-$4014 and
  ;; $4018-$5FFF. $rd8's own fallback (the operand's high byte) is X.DB for
  ;; every non-indexed read; indexed reads come through here.
  (func $rd8i (param $a i32) (param $db i32) (result i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (if (i32.or
          (i32.and (i32.ge_u (local.get $a) (i32.const 0x4000)) (i32.le_u (local.get $a) (i32.const 0x4014)))
          (i32.and (i32.ge_u (local.get $a) (i32.const 0x4018)) (i32.lt_u (local.get $a) (i32.const 0x6000))))
      (then (return (i32.and (local.get $db) (i32.const 0xFF)))))
    (call $rd8 (local.get $a)))

  ;; Page-cross dummy read that also reports X.DB after it: only I/O has side
  ;; effects or can change what an open-bus target then returns.
  (func $dummyrdb (param $a i32) (param $db i32) (result i32)
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x2000))
                 (i32.lt_u (local.get $a) (i32.const 0x4018)))
      (then (return (call $rd8i (local.get $a) (local.get $db)))))
    (local.get $db))

  ;; ReadGP with FSDisable=1 (fceumm libretro default): bits past 8 read 1.
  (func $joyread (param $w i32) (result i32)
    (local $ret i32)
    (if (local.get $w)
      (then
        ;; port 2: fceumm attaches a gamepad there too (wasmcart pad 1)
        (if (i32.ge_u (global.get $joybit2) (i32.const 8))
          (then (local.set $ret (i32.const 1)))
          (else (local.set $ret (i32.and (i32.shr_u (global.get $joy2) (global.get $joybit2)) (i32.const 1)))))
        (global.set $joybit2 (i32.and (i32.add (global.get $joybit2) (i32.const 1)) (i32.const 0xFF)))
        (return (i32.or (local.get $ret) (i32.const 0x40)))))
    (if (i32.ge_u (global.get $joybit) (i32.const 8))
      (then (local.set $ret (i32.const 1)))
      (else (local.set $ret (i32.and (i32.shr_u (global.get $joy) (global.get $joybit)) (i32.const 1)))))
    (global.set $joybit (i32.and (i32.add (global.get $joybit) (i32.const 1)) (i32.const 0xFF)))
    ;; JPRead: ret |= X.DB & 0xC0; DB is the operand's high byte, $40.
    (i32.or (local.get $ret) (i32.const 0x40)))

  (func $rd8 (param $a i32) (result i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0x2000))
      (then (return (i32.load8_u (i32.and (local.get $a) (i32.const 0x7FF))))))
    (if (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (return (call $ppu_read (i32.and (local.get $a) (i32.const 7))))))
    (if (i32.ge_u (local.get $a) (i32.const 0x8000))
      (then (return ${mapper.prgRead})))
    (if (i32.ge_u (local.get $a) (i32.const 0x6000))
      (then ${mapper.wramGate ? `(if (i32.eqz ${mapper.wramGate}) (then (return (i32.shr_u (local.get $a) (i32.const 8)))))
        ` : ""}(return (i32.load8_u (i32.add (i32.const ${WRAM - 0x6000}) (local.get $a))))))
    (if (i32.eq (local.get $a) (i32.const 0x4016)) (then (return (call $joyread (i32.const 0)))))
    (if (i32.eq (local.get $a) (i32.const 0x4017)) (then (return (call $joyread (i32.const 1)))))
    (if (i32.eq (local.get $a) (i32.const 0x4015)) (then (return (call $status_read))))
    ;; open bus: the last byte on the bus was the operand's high byte
    (i32.shr_u (local.get $a) (i32.const 8)))

  (func $wr8 (param $a i32) (param $v i32)
    (local $m i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0x2000))
      (then (i32.store8 (i32.and (local.get $a) (i32.const 0x7FF)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (call $ppu_write (i32.and (local.get $a) (i32.const 7)) (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4014))
      (then (call $oamdma (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4016))
      (then
        (if (i32.and (i32.ne (global.get $laststrobe) (i32.const 0))
                     (i32.eqz (i32.and (local.get $v) (i32.const 1))))
          (then (global.set $joybit (i32.const 0)) (global.set $joybit2 (i32.const 0))))
        (global.set $laststrobe (i32.and (local.get $v) (i32.const 1)))
        (return)))
    ;; audio: fceumm's Do* flushes and the audio-only register state first
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x4000)) (i32.le_u (local.get $a) (i32.const 0x4015)))
      (then (call $snd_write (local.get $a) (local.get $v))))
    ;; Write_PSG: $4003/$4007/$400B/$400F load an ENABLED channel's length
    (if (i32.eq (i32.and (local.get $a) (i32.const 0xFFF3)) (i32.const 0x4003))
      (then (call $len_load (i32.shr_u (i32.and (local.get $a) (i32.const 0xC)) (i32.const 2)) (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4010))
      (then
        (global.set $dmcperiod (i32.load (i32.add (i32.const ${DMCTAB})
          (i32.shl (i32.and (local.get $v) (i32.const 0xF)) (i32.const 2)))))
        ;; Write_DMCRegs: clearing bit 7 acks a pending DMC IRQ; setting it re-asserts it
        (if (i32.and (global.get $sirq) (i32.const 0x80))
          (then (if (i32.and (local.get $v) (i32.const 0x80))
            (then (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 0x100))))
            (else
              (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -257)))
              (global.set $sirq (i32.and (global.get $sirq) (i32.const 0x7F)))))))
        (global.set $dmcformat (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4012)) (then (global.set $dmcaddrlatch (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4013)) (then (global.set $dmcsizelatch (local.get $v))))
    (if (i32.eq (local.get $a) (i32.const 0x4015))
      (then
        ;; StatusWrite: disabled channels' length counters are forced to 0
        (if (i32.eqz (i32.and (local.get $v) (i32.const 1))) (then (global.set $len0 (i32.const 0))))
        (if (i32.eqz (i32.and (local.get $v) (i32.const 2))) (then (global.set $len1 (i32.const 0))))
        (if (i32.eqz (i32.and (local.get $v) (i32.const 4))) (then (global.set $len2 (i32.const 0))))
        (if (i32.eqz (i32.and (local.get $v) (i32.const 8))) (then (global.set $len3 (i32.const 0))))
        (if (i32.and (local.get $v) (i32.const 0x10))
          (then (if (i32.eqz (global.get $dmcsize)) (then (call $prep_dpcm))))
          (else (global.set $dmcsize (i32.const 0))))
        (global.set $sirq (i32.and (global.get $sirq) (i32.const 0x7F)))
        (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -257)))
        (global.set $ench (i32.and (local.get $v) (i32.const 0x1F)))))
    (if (i32.eq (local.get $a) (i32.const 0x4017))
      (then
        (global.set $apu4017 (i32.or (local.get $v) (i32.const 0x100)))
        ;; Write_IRQFM
        (local.set $m (i32.shr_u (i32.and (local.get $v) (i32.const 0xC0)) (i32.const 6)))
        (global.set $fcnt (i32.const 0))
        (if (i32.and (local.get $m) (i32.const 2)) (then (call $frame_update)))
        (global.set $fhcnt (i32.const ${FHINC}))
        (if (i32.and (local.get $m) (i32.const 1))
          (then
            (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -513)))
            (global.set $sirq (i32.and (global.get $sirq) (i32.const 0xBF)))))
        (global.set $irqfm (local.get $m))))
    (if (i32.lt_u (local.get $a) (i32.const 0x4018))
      (then (i32.store8 (i32.add (i32.const ${APUREG}) (i32.sub (local.get $a) (i32.const 0x4000)))
                        (local.get $v)) (return)))
    (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x6000)) (i32.lt_u (local.get $a) (i32.const 0x8000)))
      (then ${mapper.wramGate ? `(if ${mapper.wramGate} (then ` : ""}(i32.store8 (i32.add (i32.const ${WRAM - 0x6000}) (local.get $a)) (local.get $v))${mapper.wramGate ? "))" : ""}))${mapper.romWrite})

  (func $len_load (param $ch i32) (param $v i32)
    (local $n i32)
    (if (i32.eqz (i32.and (global.get $ench) (i32.shl (i32.const 1) (local.get $ch)))) (then (return)))
    (local.set $n (i32.load8_u (i32.add (i32.const ${LENTAB}) (i32.shr_u (local.get $v) (i32.const 3)))))
    (if (i32.eq (local.get $ch) (i32.const 0)) (then (global.set $len0 (local.get $n))))
    (if (i32.eq (local.get $ch) (i32.const 1)) (then (global.set $len1 (local.get $n))))
    (if (i32.eq (local.get $ch) (i32.const 2)) (then (global.set $len2 (local.get $n))))
    (if (i32.eq (local.get $ch) (i32.const 3)) (then (global.set $len3 (local.get $n)))))

  ;; StatusRead: SIRQStat | length counters running | DMC active; clears the
  ;; frame IRQ flag and line. (No open-bus bits: fceumm returns exactly this.)
  (func $status_read (result i32)
    (local $r i32)
    (local.set $r (i32.or (global.get $sirq) (i32.or
      (i32.or (i32.ne (global.get $len0) (i32.const 0)) (i32.shl (i32.ne (global.get $len1) (i32.const 0)) (i32.const 1)))
      (i32.or (i32.shl (i32.ne (global.get $len2) (i32.const 0)) (i32.const 2)) (i32.shl (i32.ne (global.get $len3) (i32.const 0)) (i32.const 3))))))
    (if (global.get $dmcsize) (then (local.set $r (i32.or (local.get $r) (i32.const 0x10)))))
    (global.set $sirq (i32.and (global.get $sirq) (i32.const 0xBF)))
    (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -513)))
    (local.get $r))

  ;; FrameSoundUpdate. Only what the CPU can observe is kept: the length
  ;; counters (FrameSoundStuff on even steps, unless the channel's halt bit is
  ;; set in PSG, i.e. the $4000-$400F write shadow) and the frame IRQ.
  (func $frame_update
    (if (i32.and (i32.eq (global.get $fcnt) (i32.const 3)) (i32.ne (i32.and (global.get $irqfm) (i32.const 2)) (i32.const 0)))
      (then (global.set $fhcnt (i32.add (global.get $fhcnt) (i32.const ${FHINC})))))
    ;; FrameSoundStuff(fcnt): DoSQ1/DoSQ2/DoNoise/DoTriangle first
    (call $snd_frame_stuff_pre)
    (if (i32.eqz (i32.and (global.get $fcnt) (i32.const 1)))
      (then
        (if (i32.and (i32.eqz (i32.and (i32.load8_u (i32.const ${APUREG + 8})) (i32.const 0x80))) (i32.gt_s (global.get $len2) (i32.const 0)))
          (then (global.set $len2 (i32.sub (global.get $len2) (i32.const 1)))))
        (if (i32.and (i32.eqz (i32.and (i32.load8_u (i32.const ${APUREG + 0xC})) (i32.const 0x20))) (i32.gt_s (global.get $len3) (i32.const 0)))
          (then (global.set $len3 (i32.sub (global.get $len3) (i32.const 1)))))
        (if (i32.and (i32.eqz (i32.and (i32.load8_u (i32.const ${APUREG})) (i32.const 0x20))) (i32.gt_s (global.get $len0) (i32.const 0)))
          (then (global.set $len0 (i32.sub (global.get $len0) (i32.const 1)))))
        (if (i32.and (i32.eqz (i32.and (i32.load8_u (i32.const ${APUREG + 4})) (i32.const 0x20))) (i32.gt_s (global.get $len1) (i32.const 0)))
          (then (global.set $len1 (i32.sub (global.get $len1) (i32.const 1)))))))
    (call $snd_frame_stuff (i32.eqz (i32.and (global.get $fcnt) (i32.const 1))))
    (global.set $fcnt (i32.and (i32.add (global.get $fcnt) (i32.const 1)) (i32.const 3)))
    (if (i32.and (i32.eqz (global.get $fcnt)) (i32.eqz (i32.and (global.get $irqfm) (i32.const 3))))
      (then
        (global.set $sirq (i32.or (global.get $sirq) (i32.const 0x40)))
        (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 0x200))))))

  (func $prep_dpcm
    (global.set $dmcaddress (i32.add (i32.const 0x4000) (i32.shl (global.get $dmcaddrlatch) (i32.const 6))))
    (global.set $dmcsize (i32.add (i32.shl (global.get $dmcsizelatch) (i32.const 4)) (i32.const 1))))

  ;; FCEU_SoundCPUHook: the frame sequencer, then DMC DMA, then the DMC
  ;; output unit's bit clock (only what moves the CPU or $4015 is modelled).
  (func $apu_hook (param $cycles i32)
    (global.set $fhcnt (i32.sub (global.get $fhcnt) (i32.mul (local.get $cycles) (i32.const 48))))
    (if (i32.le_s (global.get $fhcnt) (i32.const 0))
      (then
        (call $frame_update)
        (global.set $fhcnt (i32.add (global.get $fhcnt) (i32.const ${FHINC})))))
    ;; DMCDMA: four X6502_DMR, i.e. 4 stolen cycles per sample byte
    (if (i32.and (i32.ne (global.get $dmcsize) (i32.const 0)) (i32.eqz (global.get $dmchavedma)))
      (then
        (call $addcyc1) (call $addcyc1) (call $addcyc1) (call $addcyc1)
        (global.set $dmcdmabuf (call $rd8 (i32.add (i32.const 0x8000) (global.get $dmcaddress))))
        (global.set $dmchavedma (i32.const 1))
        (global.set $dmcaddress (i32.and (i32.add (global.get $dmcaddress) (i32.const 1)) (i32.const 0x7FFF)))
        (global.set $dmcsize (i32.sub (global.get $dmcsize) (i32.const 1)))
        (if (i32.eqz (global.get $dmcsize))
          (then
            (if (i32.and (global.get $dmcformat) (i32.const 0x40))
              (then (call $prep_dpcm))
              (else (if (i32.and (global.get $dmcformat) (i32.const 0x80))
                (then
                  (global.set $sirq (i32.or (global.get $sirq) (i32.const 0x80)))
                  (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 0x100)))
                  (global.set $dmcirq (i32.add (global.get $dmcirq) (i32.const 1)))))))))))
    (global.set $dmcacc (i32.sub (global.get $dmcacc) (local.get $cycles)))
    (block $d (loop $l
      (br_if $d (i32.gt_s (global.get $dmcacc) (i32.const 0)))
      (if (global.get $dmchavesample) (then (call $snd_dmc_step)))
      (global.set $dmcacc (i32.add (global.get $dmcacc) (global.get $dmcperiod)))
      (global.set $dmcbitcount (i32.and (i32.add (global.get $dmcbitcount) (i32.const 1)) (i32.const 7)))
      (global.set $dmcshift (i32.shr_u (global.get $dmcshift) (i32.const 1)))
      ;; tester()
      (if (i32.eqz (global.get $dmcbitcount))
        (then
          (if (i32.eqz (global.get $dmchavedma))
            (then (global.set $dmchavesample (i32.const 0)))
            (else
              (global.set $dmchavesample (i32.const 1))
              (global.set $dmcshift (global.get $dmcdmabuf))
              (global.set $dmchavedma (i32.const 0))))))
      (br $l))))

  ;; B4014: 256 x (X6502_DMR + X6502_DMW), each ADDCYC(1): 512 cycles.
  (func $oamdma (param $page i32)
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 256)))
      (call $addcyc1)
      (global.set $t3 (call $rd8 (i32.or (i32.shl (local.get $page) (i32.const 8)) (local.get $i))))
      (call $addcyc1)
      (call $w2004 (global.get $t3))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $trap (param $op i32)
    (if (i32.eqz (global.get $trapped))
      (then
        (global.set $trapped (i32.const 1))
        (global.set $trappc (global.get $curpc))
        (global.set $trapop (local.get $op))
        (call $probe))))
`;
}

/**
 * Two-level dispatch: br_table on the 1KB shard, then the shard's own
 * br_table on the low bits.
 * @param {number} nsh
 * @param {number} SH
 */
function dispatch(nsh, SH) {
  let out = "    ";
  for (let si = nsh - 1; si >= 0; si--) out += `(block $b${si} `;
  const labels = [];
  for (let si = 0; si < nsh; si++) labels.push(`$b${si}`);
  out += "(br_table " + labels.join(" ") + " $b0 (i32.shr_u (local.get $o) (i32.const 10)))";
  for (let si = 0; si < nsh; si++) {
    out += `)\n    (call $shard${si} (i32.and (local.get $o) (i32.const ${SH - 1}))) (return)`;
  }
  return out;
}

/**
 * $probe and $step (fetch, cycle charge, sound hook, dispatch).
 * @param {import("./mappers.js").NesMapper} mapper
 * @param {number} n
 * @param {string} probeStores
 * @param {string} disp
 */
function stepWat(mapper, probeStores, disp, ring = { offset: PCRING, entries: 1024, stride: 8 }) {
  const shift = ring.stride === 16 ? 4 : 3;
  const regStores = ring.stride === 16 ? `
    (i32.store (i32.add (local.get $r) (i32.const 8)) (i32.or (i32.or (global.get $a) (i32.shl (global.get $x) (i32.const 8)))
      (i32.or (i32.shl (global.get $y) (i32.const 16)) (i32.shl (global.get $s) (i32.const 24)))))
    (i32.store (i32.add (local.get $r) (i32.const 12)) ${PACK_P})` : "";
  return `
  (func $probe
${probeStores})

  (func $step
    (local $o i32) (local $r i32) (local $op i32)
    (global.set $pi (global.get $fi))
    (global.set $curpc (global.get $pc))
    ;; b1 = RdMem(_PC): code below $8000 (RAM, WRAM) is fetched through the
    ;; bus and run by $dynop, which reads its operands at run time too
    (if (i32.lt_u (global.get $pc) (i32.const 0x8000))
      (then (local.set $op (call $rd8 (global.get $pc))))
      (else
        (local.set $o ${mapper.pcOffset})
        (local.set $op (i32.load8_u (i32.add (i32.const ${mapper.prgBase}) (local.get $o))))))
    (local.set $r (i32.add (i32.const ${ring.offset})
      (i32.shl (i32.and (global.get $ringi) (i32.const ${ring.entries - 1})) (i32.const ${shift}))))
    (i32.store (local.get $r) (i32.or (global.get $pc)
      (i32.shl (local.get $op) (i32.const 16))))
    (i32.store (i32.add (local.get $r) (i32.const 4)) (global.get $ts))${regStores}
    (global.set $ringi (i32.add (global.get $ringi) (i32.const 1)))
    (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
    ;; X6502_Run: ADDCYC(CycTable[op]) at fetch, then the sound hook with
    ;; every cycle since the previous hook (this one's base, the previous
    ;; instruction's extras, DMA, NMI, and the hook's own DMC steals).
    (local.set $r (i32.load8_u (i32.add (i32.const ${CYCTAB}) (local.get $op))))
    (global.set $cnt (i32.sub (global.get $cnt) (i32.mul (local.get $r) (i32.const 48))))
    (global.set $ts (i32.add (global.get $ts) (local.get $r)))
    (local.set $r (i32.sub (global.get $ts) (global.get $lastts)))
    (global.set $lastts (global.get $ts))
    (call $apu_hook (local.get $r))
    (if (i32.lt_u (global.get $pc) (i32.const 0x8000))
      (then (call $dynop (local.get $op)) (return)))
` + disp + ")";
}

/**
 * $dynop(op): one arm per opcode with the operand bytes fetched at run time
 * (cpu.js lower() with dynamic: true). Runs code outside ROM ($pc < $8000:
 * RAM, WRAM) and instructions that straddle a bank window. The prologue in
 * $step has already fetched the opcode, charged its base cycles and run the
 * sound hook, exactly as for a ROM arm.
 * @param {object} mapper
 */
function dynopWat(mapper) {
  const view = { dynamic: true, romWritesMatter: mapper.romWritesMatter, fixedByte: () => null };
  const parts = ["  (func $dynop (param $op i32)", "    (global.set $ndyn (i32.add (global.get $ndyn) (i32.const 1)))"];
  for (let i = 255; i >= 0; i--) parts.push(`    (block $o${i}`);
  parts.push("      (br_table " + Array.from({ length: 256 }, (_, i) => `$o${i}`).join(" ") + " (local.get $op))");
  for (let i = 0; i < 256; i++) {
    let body;
    try { body = lower(i, 0, 0, view, 0); } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      body = `(call $trap (i32.const ${i}))`;
    }
    parts.push(`    ) ;; ${i.toString(16).toUpperCase().padStart(2, "0")}`);
    parts.push(`    ${body} (return)`);
  }
  parts.push("  )");
  return parts.join("\n");
}

/** $run, $do_irq, pads, the wasmcart ABI exports and FCEUPPU_Loop. */
function frameWat(mapper) {
  return `
  ;; X6502_Run(dots)
  (func $run (param $dots i32)
    (global.set $cnt (i32.add (global.get $cnt) (i32.shl (local.get $dots) (i32.const 4))))
    (if (global.get $trapped) (then (global.set $cnt (i32.const 0)) (return)))
    (block $out (loop $l
      (br_if $out (i32.le_s (global.get $cnt) (i32.const 0)))
      (if (global.get $irqlow)
        (then
          (call $do_irq)
          (if (i32.le_s (global.get $cnt) (i32.const 0))
            (then (global.set $pi (global.get $fi)) (br $out)))))
      (call $step)
      (if (global.get $trapped) (then (global.set $cnt (i32.const 0)) (br $out)))
      (br $l))))

  ;; irqlow bits are fceumm's FCEU_IQ* (x6502.h): 0x80 NMI, 0x40 NMI2 (B2000
  ;; enabling NMI inside vblank: becomes a real NMI one instruction later),
  ;; 0x100 DPCM, 0x200 FCOUNT, 0x001 EXT (mapper). X6502_Run's order: NMI2,
  ;; then NMI, else a maskable IRQ, which is taken only if the I flag was
  ;; clear BEFORE the previous instruction ($pi = fceumm's _PI), so CLI and
  ;; PLP let one more instruction run first; RTI sets _PI itself.
  (func $do_irq
    (if (i32.and (global.get $irqlow) (i32.const 0x40))
      (then
        (global.set $irqlow (i32.or (i32.and (global.get $irqlow) (i32.const -65)) (i32.const 0x80)))
        (return)))
    (if (i32.and (global.get $irqlow) (i32.const 0x80))
      (then
        ${cyc(7)}
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.shr_u (global.get $pc) (i32.const 8)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.and (global.get $pc) (i32.const 0xFF)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) ${PACK_P})
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (global.set $fi (i32.const 1))
        (global.set $pc (i32.or (call $rd8 (i32.const 0xFFFA))
                                (i32.shl (call $rd8 (i32.const 0xFFFB)) (i32.const 8))))
        (global.set $nnmi (i32.add (global.get $nnmi) (i32.const 1)))
        (global.set $irqlow (i32.and (global.get $irqlow) (i32.const -129)))
        (return)))
    (if (i32.eqz (global.get $pi))
      (then
        ${cyc(7)}
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.shr_u (global.get $pc) (i32.const 8)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) (i32.and (global.get $pc) (i32.const 0xFF)))
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (i32.store8 (i32.or (i32.const 0x100) (global.get $s)) ${PACK_P})
        (global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))
        (global.set $fi (i32.const 1))
        (global.set $pc (i32.or (call $rd8 (i32.const 0xFFFE))
                                (i32.shl (call $rd8 (i32.const 0xFFFF)) (i32.const 8))))
        (global.set $nirq (i32.add (global.get $nirq) (i32.const 1))))))

  (func $read_pad
    (global.set $joy (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 0)}))))
    ;; wasmcart pad 1 (ABI v4 stride: 20 bytes) is fceumm's port 2 gamepad
    (global.set $joy2 (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 1)})))))

  (func $pad_bits (param $b i32) (result i32)
    (local $j i32)
    ;; wasmcart buttons are POSITIONAL (W3C): the east face button is
    ;; WC_BTN_B, which is where the NES A button sits; south (WC_BTN_A) is
    ;; NES B. NES bit order: A B Select Start Up Down Left Right.
    (if (i32.and (local.get $b) (i32.const 2))    (then (local.set $j (i32.or (local.get $j) (i32.const 0x01)))))
    (if (i32.and (local.get $b) (i32.const 1))    (then (local.set $j (i32.or (local.get $j) (i32.const 0x02)))))
    (if (i32.and (local.get $b) (i32.const 128))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x04)))))
    (if (i32.and (local.get $b) (i32.const 64))   (then (local.set $j (i32.or (local.get $j) (i32.const 0x08)))))
    (if (i32.and (local.get $b) (i32.const 256))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x10)))))
    (if (i32.and (local.get $b) (i32.const 512))  (then (local.set $j (i32.or (local.get $j) (i32.const 0x20)))))
    (if (i32.and (local.get $b) (i32.const 1024)) (then (local.set $j (i32.or (local.get $j) (i32.const 0x40)))))
    (if (i32.and (local.get $b) (i32.const 2048)) (then (local.set $j (i32.or (local.get $j) (i32.const 0x80)))))
    (local.get $j))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const ${WC_ABI_VERSION}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const ${FB_W}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const ${FB_H}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    ;; inputPtr (field 7) and timePtr (field 10) are written by the host
    ;; every frame with NO zero check: both must point somewhere harmless.
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 28)) (i32.const ${INPUT}))
    ;; audio: int16 stereo ring (flags bit 0 clear), cursor in frames, 48 kHz
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 16)) (i32.const ${AUDIO}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 20)) (i32.const ${AUDIO_CAP}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 24)) (i32.const ${AUDIO_CURSOR}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 48)) (i32.const 0))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 52)) (i32.const 48000))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 40)) (i32.const ${TIME}))
    (i32.const ${ABI}))

  (func (export "wc_init")
    ;; fceumm_ramstate default "fill $ff"
    (memory.fill (i32.const 0) (i32.const 0xFF) (i32.const 0x800))
    (global.set $s (i32.const 0xFD))
    (global.set $fi (i32.const 1))${mapper.chrRamFill ? `
    ;; iNES_Init: CHR RAM is FCEU_MemoryRand-filled like work RAM ($FF)
    ${mapper.chrRamFill}` : ""}${mapper.init ? `
    ;; the mapper's power-on mapping
    ${mapper.init}` : ""}
    (global.set $pc (i32.or (call $rd8 (i32.const 0xFFFC))
                            (i32.shl (call $rd8 (i32.const 0xFFFD)) (i32.const 8)))))

  ;; FCEUPPU_Loop
  (func (export "wc_render")
    (local $i i32)
    (call $read_pad)
    (if (global.get $ppudead)
      (then
        (memory.fill (i32.const ${NESFB}) (i32.const 0) (i32.const ${256 * 240}))
        (call $run (i32.const ${262 * 341}))
        (global.set $ppudead (i32.sub (global.get $ppudead) (i32.const 1))))
      (else
        (call $run (i32.const 341))
        (global.set $ppustatus (i32.or (global.get $ppustatus) (i32.const 0x80)))
        (global.set $ppu3 (i32.const 0))
        (global.set $ppuspl (i32.const 0))
        (call $run (i32.const 12))
        (if (i32.and (global.get $ppu0) (i32.const 0x80))
          (then (global.set $irqlow (i32.or (global.get $irqlow) (i32.const 0x80)))))
        (call $run (i32.const ${20 * 341 - 12}))
        (global.set $ppustatus (i32.and (global.get $ppustatus) (i32.const 0x1F)))
        (call $run (i32.const 256))${mapper.hbHook ? `
        ;; FCEUPPU_Loop: the pre-render line clocks GameHBIRQHook too
        (if (i32.and (i32.ne (i32.and (global.get $ppu1) (i32.const 0x18)) (i32.const 0))
                     (i32.ne (i32.and (global.get $ppu0) (i32.const 0x38)) (i32.const 0x18)))
          (then ${mapper.hbHook}))` : ""}
        (call $run (i32.const ${85 - 16}))
        (if (i32.and (global.get $ppu1) (i32.const 0x18))
          (then (global.set $refaddr (global.get $tmpaddr))))
        (global.set $spork (i32.const 0))
        (global.set $numsprites (i32.const 0))
        (call $reset_rl (i32.const ${NESFB}))
        (call $run (i32.sub (i32.const 16) (global.get $kook)))
        (global.set $kook (i32.xor (global.get $kook) (i32.const 1)))
        (global.set $scanline (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (global.get $scanline) (i32.const 240)))
          (call $do_line)
          (br $l)))))
    (local.set $i (i32.const 0))
    (block $pd (loop $pl
      (br_if $pd (i32.ge_u (local.get $i) (i32.const ${256 * 240})))
      (i32.store (i32.add (i32.const ${FB}) (i32.shl (local.get $i) (i32.const 2)))
        (i32.load (i32.add (i32.const ${RGBTAB}) (i32.shl (i32.or
          (i32.and (i32.load8_u (i32.add (i32.const ${NESFB}) (local.get $i))) (i32.const 0x3F))
          (i32.shl (i32.and (i32.load8_u (i32.add (i32.const ${EMPH}) (i32.shr_u (local.get $i) (i32.const 8))))
            (i32.const 7)) (i32.const 6)))
          (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $pl)))
    ;; FCEUI_Emulate: FlushEmulateSound after FCEUPPU_Loop
    (call $snd_flush)
    (global.set $nframe (i32.add (global.get $nframe) (i32.const 1)))
    (call $probe))
`;
}

const SHARD = 1024;

/**
 * Emit the whole cart as WAT, one (module ...) in text chunks.
 * @param {Uint8Array} rom  the whole .nes file
 * @param {object} [opts]
 * @param {{arms?: number, lowered?: number, trapped?: number}} [opts.stats]  filled in
 * @returns {AsyncGenerator<string>}
 */
export async function* emitWat(rom, opts = {}) {
  rom = toBytes(rom);
  const d = describe(rom, opts);
  if (!d.supported) throw new Error(`nes recompile: ${d.unsupportedReason}`);
  const prg = rom.subarray(d.prgOffset, d.prgOffset + d.prgSize);
  const chr = rom.subarray(d.chrOffset, d.chrOffset + d.chrSize);
  const mapper = MAPPERS[d.mapper].make(d, prg);
  if (d.chrRam) {
    mapper.chrRamFill = `(memory.fill (i32.const ${CHR}) (i32.const 0xFF) (i32.const 0x2000))` +
      (mapper.chrStore ? ` (memory.fill (i32.const ${mapper.chrStore}) (i32.const 0xFF) (i32.const 0x2000))` : "");
  }
  const n = prg.length;
  const view = { fixedByte: mapper.fixedByte, romWritesMatter: mapper.romWritesMatter };

  const bodies = new Array(n);
  let ok = 0, bad = 0;
  for (let off = 0; off < n; off++) {
    const op = prg[off];
    try {
      const ent = OPS.get(op);
      const w = mapper.window || 0x10000;
      if (ent && (mapper.armBase(off) & (w - 1)) + LEN[ent[1]] - 1 >= w) {
        // the operand lies in the NEXT window, whose bank is only known at run time
        lower(op, 0, 0, { dynamic: true }, 0);
        bodies[off] = `(call $dynop (i32.const ${op}))`;
      } else {
        bodies[off] = lower(op, mapper.operand(off, 1), mapper.operand(off, 2), view, mapper.armBase(off));
      }
      ok++;
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      bodies[off] = `(call $trap (i32.const ${op}))`;
      bad++;
    }
  }
  if (opts.breakArm != null) {
    // DEBUG / MUST-FAIL CONTROL: the arm(s) at this CPU address only step
    // the pc past the instruction, so a differ must name exactly this one.
    const at = typeof opts.breakArm === "number" ? opts.breakArm : parseInt(String(opts.breakArm).replace(/^\$/, ""), 16);
    let hit = 0;
    for (let off = 0; off < n; off++) {
      if (mapper.armBase(off) !== at) continue;
      const ent = OPS.get(prg[off]);
      if (!ent) throw new Error(`nes recompile: options.breakArm $${at.toString(16)} is not an instruction (byte $${prg[off].toString(16)})`);
      bodies[off] = `(global.set $pc (i32.and (i32.add (global.get $pc) (i32.const ${LEN[ent[1]]})) (i32.const 0xFFFF)))`;
      hit++;
    }
    if (!hit) throw new Error(`nes recompile: options.breakArm $${at.toString(16)} is not a PRG address of this cart`);
    if (opts.stats) opts.stats.brokenArms = hit;
  }
  if (opts.stats) Object.assign(opts.stats, { arms: n, lowered: ok, trapped: bad });


  yield "(module\n";
  yield `  (memory (export "memory") ${mapper.pages})\n`;
  yield cpuGlobals() + mapper.globals + apuGlobalsWat(SOUND) + "\n";
  yield globalsWat() + "\n";
  yield memWat(mapper) + "\n";
  yield apuWat({ k: SOUND, APUREG }) + "\n";
  if (opts.muteChannels && opts.muteChannels.length) {
    // DEBUG / MUST-FAIL CONTROL: channels silenced from power-on
    yield `  (data (i32.const ${MUTE}) "${watBytes(Uint8Array.of(opts.muteChannels.reduce((m, c) => m | (1 << (typeof c === "number" ? c : MUTE_CHANNELS.indexOf(c))), 0)))}")\n`;
  }
  if (mapper.funcs) yield mapper.funcs + "\n";
  yield dynopWat(mapper) + "\n";
  yield ppuWat({
    NTSEL: mapper.ntSel || ntSelFixed(d.mirroring),
    HBHOOK: mapper.hbHook || "",
    CHRWRITE: d.chrRam ? `(i32.store8 (i32.add (i32.const ${CHR}) (local.get $tmp)) (local.get $v))` : "",
  }) + "\n";
  yield `  (data (i32.const ${RGBTAB}) "${watBytes(u32le(palette512().map((c) => (0xFF000000 | c) >>> 0)))}")\n`;
  yield `  (data (i32.const ${CYCTAB}) "${watBytes(Uint8Array.from(CYCLES.base))}")\n`;
  yield `  (data (i32.const ${DMCTAB}) "${watBytes(u32le(FCEUMM.ntscDmcPeriod))}")\n`;
  yield `  (data (i32.const ${LENTAB}) "${watBytes(Uint8Array.from(FCEUMM.lengthTable))}")\n`;
  yield `  (data (i32.const ${WL1}) "${watBytes(u32le(SOUND.wlookup1))}")\n`;
  yield `  (data (i32.const ${WL2}) "${watBytes(u32le(SOUND.wlookup2))}")\n`;
  yield `  (data (i32.const ${NOISETAB}) "${watBytes(u32le(FCEUMM.audio.noiseFreq))}")\n`;
  yield `  (data (i32.const ${DUTIES}) "${watBytes(Uint8Array.from(FCEUMM.audio.rectDuties))}")\n`;
  for (const [addr, data] of luts()) yield `  (data (i32.const ${addr}) "${watBytes(data)}")\n`;

  const nsh = Math.ceil(n / SHARD);
  for (let si = 0; si < nsh; si++) {
    const sh = bodies.slice(si * SHARD, (si + 1) * SHARD);
    const parts = [`  (func $shard${si} (param $id i32)`];
    for (let i = sh.length - 1; i >= 0; i--) parts.push(`    (block $s${i}`);
    parts.push("    (block $sdef");
    parts.push("      (br_table " + sh.map((_, i) => `$s${i}`).join(" ") + " $sdef (local.get $id))");
    parts.push("    ) (return)");
    for (let i = 0; i < sh.length; i++) {
      const cpu = mapper.armBase(si * SHARD + i);
      parts.push(`    ) ;; ${cpu.toString(16).toUpperCase().padStart(4, "0")}`);
      parts.push(`    ${sh[i]} (return)`);
    }
    parts.push("  )");
    yield parts.join("\n") + "\n";
  }

  const probeStores = PROBE_FIELDS.map((f, i) => {
    const v = f === "p" ? PACK_P : f === "frame" ? "(global.get $nframe)" : `(global.get $${f})`;
    return `    (i32.store (i32.const ${PROBE + 4 * i}) ${v})`;
  }).join("\n");
  yield stepWat(mapper, probeStores, dispatch(nsh, SHARD), pcRingFor(opts)) + "\n";
  yield frameWat(mapper) + "\n";
  yield `  (data (i32.const ${mapper.prgBase}) "${watBytes(prg)}")\n`;
  // the 8KB window starts as the first 8KB (every supported mapper powers up on bank 0)
  if (chr.length) yield `  (data (i32.const ${CHR}) "${watBytes(chr.subarray(0, 0x2000))}")\n`;
  if (chr.length && mapper.chrStore) yield `  (data (i32.const ${mapper.chrStore}) "${watBytes(chr)}")\n`;
  yield ")";
}

/**
 * Convenience: the whole module as one string (small carts, tests, debugging).
 * @param {Uint8Array} rom
 * @param {object} [opts]
 */
export async function emitWatString(rom, opts) {
  let s = "";
  for await (const c of emitWat(rom, opts)) s += c;
  return s;
}
