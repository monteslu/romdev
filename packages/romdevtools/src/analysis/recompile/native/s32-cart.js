// The recompile descriptor of a natively recompiled sync32 cart.
//
// A .s32 has no custom sections, so the native Genesis runtime carries its
// verification layout in the image itself: `rd_desc` (runtime/s32/main.c,
// magic "RDMDS32\0", in .data so its initial bytes sit in the image and its
// live copy in SRAM) holds the SRAM addresses of the emulated machine's work
// RAM, VRAM, CRAM, VSRAM, Z80 RAM, VDP registers, sprite cache, CPU cores and
// counters, plus a pointer to a JSON string (rd_meta.c) with the build facts
// (platform, reference core, ROM sha1, timing profile, frame conventions).
// This reads both straight from the file and returns the same layout shape a
// wasmcart's romdev.recompile section gives, so verifyRecompile and
// findDiverge treat the two kinds of cart alike.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { SRAM_BASE } from "../../../host/S32CartHost.js";

const XIP_BASE = 0x10100000, RAM_BASE = 0x20030000;
const MAGIC = [0x52, 0x44, 0x4d, 0x44, 0x53, 0x33, 0x32, 0x00]; // "RDMDS32\0"

/** True for a sync32 cart (raw .s32 header). */
export function isS32(bytes) {
  return bytes.length >= 64 && bytes[0] === 0x53 && bytes[1] === 0x59 && bytes[2] === 0x33 && bytes[3] === 0x32;
}

function find(bytes, pat, from = 0) {
  outer: for (let i = from; i + pat.length <= bytes.length; i++) {
    for (let j = 0; j < pat.length; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return i;
  }
  return -1;
}

// gpgx's m68ki_cpu_core field offsets (identical in the reference core's
// genesis_m68k region and in the cart's struct: same source, ILP32 both)
const M68K = { dar: 5144, pc: 5208, cycles: 5132, refresh: 5136, sp: 5280, s_flag: 5308, x_flag: 5312, n_flag: 5316,
  not_z_flag: 5320, v_flag: 5324, c_flag: 5328, int_mask: 5332, int_level: 5336, stopped: 5340 };

/**
 * @param {Uint8Array|string} cart bytes or path of a .s32
 * @returns {object|null} a romdev.recompile-shaped layout, or null when the cart has no descriptor
 */
export function readS32RecompileLayout(cart) {
  const bytes = typeof cart === "string" ? new Uint8Array(readFileSync(cart)) : cart;
  if (!isS32(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codeOff = dv.getUint32(0x10, true), loadMode = bytes[0x1c];
  const at = find(bytes, MAGIC, codeOff);
  if (at < 0) return null;
  const u = (k) => dv.getUint32(at + k, true);
  const ver = u(8);
  if (ver !== 1) throw new Error(`sync32 cart descriptor version ${ver} is not supported`);
  const ptr = (k) => u(k) - SRAM_BASE;
  const d = {
    wram: [ptr(16), u(20)], vram: [ptr(24), u(28)], cram: [ptr(32), u(36)], vsram: [ptr(40), u(44)],
    zram: [ptr(48), u(52)], vdpReg: [ptr(56), u(60)], sat: [ptr(64), u(68)], m68k: [ptr(72), u(76)],
    z80: [ptr(80), u(84)], stats: [ptr(88), u(92)],
  };
  const metaAddr = u(96);
  const imageBase = loadMode === 1 ? XIP_BASE : RAM_BASE;
  let meta = {};
  const mo = metaAddr - imageBase + codeOff;
  if (mo > 0 && mo < bytes.length) {
    let e = mo;
    while (e < bytes.length && bytes[e]) e++;
    try { meta = JSON.parse(new TextDecoder().decode(bytes.subarray(mo, e))); } catch { meta = {}; }
  }
  const canvasY = dv.getInt32(at + 100, true);
  const m = d.m68k[0];
  const field = (name, off) => [name, { offset: m + off, size: 4, ref: { region: "genesis_m68k", offset: off } }];
  const st = d.stats[0];
  return {
    version: 1,
    platform: meta.platform ?? "genesis",
    reference: meta.reference ?? "genesis",
    referenceCore: meta.referenceCore,
    romSha1: meta.romSha1,
    warmupFrames: meta.warmupFrames ?? 0,
    screen: { origin: [0, canvasY] },
    regions: {
      // gpgx keeps work RAM in 16-bit host order and romdev's system_ram
      // region shows it in 68000 order; the cart holds gpgx's own array
      wram: { offset: d.wram[0], length: d.wram[1], ref: "system_ram", transform: "swap16" },
      vram: { offset: d.vram[0], length: d.vram[1], ref: "video_ram" },
      cram: { offset: d.cram[0], length: d.cram[1], ref: "genesis_cram" },
      vsram: { offset: d.vsram[0], length: d.vsram[1], ref: "genesis_vsram" },
      zram: { offset: d.zram[0], length: d.zram[1], ref: "genesis_z80_ram" },
    },
    fields: Object.fromEntries([
      ...Array.from({ length: 8 }, (_, i) => field(`d${i}`, M68K.dar + 4 * i)),
      ...Array.from({ length: 8 }, (_, i) => field(`a${i}`, M68K.dar + 32 + 4 * i)),
      field("pc", M68K.pc), field("cycles", M68K.cycles), field("refresh", M68K.refresh),
      field("int_level", M68K.int_level), field("stopped", M68K.stopped), field("sp0", M68K.sp), field("sp4", M68K.sp + 16),
      field("s_flag", M68K.s_flag), field("x_flag", M68K.x_flag), field("n_flag", M68K.n_flag),
      field("not_z_flag", M68K.not_z_flag), field("v_flag", M68K.v_flag), field("c_flag", M68K.c_flag), field("int_mask", M68K.int_mask),
    ]),
    probe: {
      frames: { offset: st + 0, size: 4 },
      trapped: { offset: st + 4, size: 4 },
      audioFrames: { offset: st + 8, size: 4 },
      audioDropped: { offset: st + 12, size: 4 },
      blockInsns: { offset: st + 20, size: 4 },
      interpInsns: { offset: st + 24, size: 4 },
      lookups: { offset: st + 28, size: 4 },
      lookupMiss: { offset: st + 32, size: 4 },
      irqDelayAborts: { offset: st + 44, size: 4 },
      // per-line palette banks (main.c): last frame, frames over four, most in a frame
      palBanks: { offset: st + 52, size: 4 },
      palOverflowFrames: { offset: st + 56, size: 4 },
      palMaxBanks: { offset: st + 60, size: 4 },
    },
    vramZero: ["vram"],
    // the console ring's 48 kHz, or the reference core's 44100 Hz in an
    // audioRate:'reference' test build
    audio: { sampleRate: meta.audioRate === "reference" ? 44100 : 48000 },
    conventions: meta.conventions,
    native: { target: "sync32", profile: meta.profile, blocks: meta.blocks, descriptorFileOffset: at, stats: st, vdpReg: d.vdpReg, sat: d.sat, z80: d.z80 },
    license: meta.license,
    licence: meta.licence,
  };
}
