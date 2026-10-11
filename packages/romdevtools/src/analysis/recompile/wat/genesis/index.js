// Genesis / Mega Drive WAT backend: a whole commercial 68000 cart statically
// recompiled into one wasmcart module, verified against genesis_plus_gx.
//
// Every even ROM offset becomes one arm of a sharded br_table dispatch over
// $pc, so a computed jump cannot land on uncompiled code. Each arm's body is
// gpgx's own Musashi opcode handler partially evaluated for that opcode at
// that address (ctrans.js over gpgx-derived.json.gz); the machine around it
// (memory map, VDP, Z80, frame loop) is runtime.js; an SVP cart also carries
// gpgx's own SSP1601 code compiled to WAT (svp.js). All follow gpgx
// function for function because the carts are verified against gpgx's
// picture and memory at the same frame.
//
// Ported from the earlier Python emitter; the WAT text is identical to what
// it produced for the verified carts.
//
// Any pc with no compiled arm (code the game builds or copies into work RAM,
// RAM code whose words changed, a re-based cartridge bank) runs in the 68000
// interpreter (interp.js): the same gpgx handlers, one per opcode word, with
// the extension words and the address read at run time. Nothing has to be
// declared or discovered for such code to run exactly. As a SPEED
// OPTIMISATION, RAM code is also compiled at its RAM address where it can be
// found up front: a static scan for ROM->RAM copy loops (discoverRamCode),
// the reference's own trace (discoverRamCodeTrace, when the ROM is on disk)
// and options.ramCode:[{romOffset, ramAddress, length}].
// options.ramInterpreter:false (a MUST-FAIL CONTROL only) traps instead:
// trapped=1, trappc=<the pc>.
//
// LICENSE: carts built by this backend contain code transpiled from Genesis
// Plus GX and are NON-COMMERCIAL (see NOTICE and gpgx-derived.json.gz).
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadGpgxData } from "./gpgx-data.js";
import { translateM68k, translateZ80, z80HandlerNames, TrError, ZREGS } from "./ctrans.js";
import * as RT from "./runtime.js";
import { assertHostSpans, padAddr, WC_ABI_VERSION } from "../cart-abi.js";
import { m68kInterpWat } from "./interp.js";
import { ymWat, mdSoundInfo, hookZ80Wat, hookVdpWat, hookFrameWat, hookMemWat, deltasLayout } from "./ym2612.js";
import { hasSvp, svpUnitSize, svpWat, svpRegions, SVP_DRAM, SVP_CELL } from "./svp.js";

export const platforms = ["genesis", "md", "megadrive"];

const { R, CYCTAB, FIFO, ABI, FB, FB_W, FB_H, PIXEL } = RT;
// The wasmcart ABI block: audio cursor +256, 4 x 20-byte pads (ABI v4) at
// +288..+368, the clock at +0x180. Checked at import, so at every build.
const INPUT = ABI + 288;
assertHostSpans({ who: "genesis", info: ABI, input: INPUT, time: ABI + 0x180, audioWrite: ABI + 256,
  others: [["FB", FB, FB_W * FB_H * 4], ["CARTMAP", RT.CARTMAP, 0x100], ["JPADS", RT.JPADS, 32], ["ZT", RT.ZT, 0x1000]] });
const ROMIMG = 0x160000;
// ym2612.js / ../sms/psg.js sound state, tables and the audio ring (free
// space between the ABI block and the Z80 tables)
const SND = 0xed000;
// sound.c's fm_buffer (after the per-line composed codes)
const FMBUF = 0x155000;
// options.audioDeltas (debug): every blip delta, compared with gpgx_blip_deltas
const DELTAS = deltasLayout(0x3000000);
const RAMWORDS = 0x8000;
const STATE = RT.TRACE; // per-frame CPU/VDP state block for the differ
const TRACEN = 1 << 18; // instruction ring entries (enabled by STATE+0xF8)
/** options.traceEntries: the ring with the 68000 registers (d0-d7, a0-a7, sr) per entry. */
const REGRING_STRIDE = 128;
const REGRING_MAX = 1 << 18;

/**
 * The instruction ring for these options: the default 2^18 x 16 bytes
 * {pc, mc, refresh, mcend}, or options.traceEntries entries (a power of two,
 * 1024 to 2^18) of 128 bytes that add d0-d7 and a0-a7 at +16 and sr at +80.
 * A frame runs ~10,000-20,000 68000 instructions, so 32768 holds one.
 * @param {object} [opts]
 */
export function traceRingFor(opts = {}) {
  const n = opts.traceEntries;
  if (n == null) return { entries: TRACEN, stride: 16, regs: false };
  if (!Number.isInteger(n) || n < 1024 || n > REGRING_MAX || (n & (n - 1))) {
    throw new Error(`genesis recompile: options.traceEntries must be a power of two from 1024 to ${REGRING_MAX}, got ${n}`);
  }
  return { entries: n, stride: REGRING_STRIDE, regs: true };
}
const SH = 1024; // arms per dispatch shard

/**
 * SVP carts: the SVP unit's memory (svp.js) sits right after the ROM image
 * (the pc tables follow it), so its regions' offsets depend on the ROM alone.
 * @param {Uint8Array} img normalised ROM
 * @returns {{base:number, size:number}|null}
 */
function svpPlacement(img) {
  if (!hasSvp(img)) return null;
  return { base: ROMIMG + padRom(img).length, size: (svpUnitSize() + 0xffff) & ~0xffff };
}

/**
 * gpgx pads the ROM to a power of two of at least 64KB with $FF and mirrors
 * it (md_cart_init: cart.mask); the lock-on cart is not mirrored.
 * @param {Uint8Array} img
 */
function padRom(img) {
  let size = 0x10000;
  while (size < img.length) size <<= 1;
  if (headerText(img, 0x150, 0x180).includes("SONIC & KNUCKLES")) size = Math.max(size, 0x400000);
  const rom = new Uint8Array(size).fill(0xff);
  rom.set(img);
  return rom;
}

/**
 * gpgx getrominfo/input_init: 6-button pads when any of the 14 I/O support
 * bytes at $190 is '6'.
 * @param {Uint8Array} img
 */
export function sixButtonPads(img) {
  for (let i = 0; i < 14; i++) if (img[0x190 + i] === 0x36) return true;
  return false;
}

const headerText = (img, a, b) => String.fromCharCode(...img.subarray(a, Math.min(b, img.length)));

/**
 * The ROM as gpgx's load_rom leaves it: byte-swapped dumps swapped back, and
 * a 512-byte copier header (no "SEGA" at $100, an odd number of 512-byte
 * blocks) removed with the .smd 16KB blocks de-interleaved.
 * @param {Uint8Array} raw
 * @returns {Uint8Array}
 */
export function normalizeRom(raw) {
  let img = raw;
  const at = (o, s) => o + s.length <= img.length && headerText(img, o, o + s.length) === s;
  if (at(0x100, "ESAGM GE ARDVI E") || at(0x100, "ESAGG NESESI") || at(0x80100, "ESAGM GE ARDVI E") || at(0x80100, "ESAGG NESESI")) {
    img = new Uint8Array(img);
    for (let i = 0; i + 1 < img.length; i += 2) { const x = img[i]; img[i] = img[i + 1]; img[i + 1] = x; }
  }
  if (!at(0x100, "SEGA") && ((img.length / 512) & 1) && !(img.length % 512)) {
    const body = img.subarray(512);
    const out = new Uint8Array(body.length);
    out.set(body);
    for (let b = 0; b + 0x4000 <= out.length; b += 0x4000) {
      const blk = body.subarray(b, b + 0x4000);
      for (let i = 0; i < 0x2000; i++) { out[b + i * 2] = blk[0x2000 + i]; out[b + i * 2 + 1] = blk[i]; }
    }
    img = out;
  }
  return img;
}

/** getrominfo's name fields: runs of spaces collapsed to one. */
const romName = (img, off) => headerText(img, off, off + 48).replace(/ {2,}/g, " ");
/** loadrom.c getchecksum: 16-bit sum of the words from $200. */
function realChecksum(img) {
  let s = 0;
  for (let i = 0x200; i + 1 < img.length; i += 2) s = (s + ((img[i] << 8) | img[i + 1])) & 0xffff;
  return s;
}

/**
 * Backup RAM as gpgx's sram_init + md_cart_init set it up: from the "RA"
 * header block, the product-code fixes, or by default 64KB at $200000 for a
 * ROM of 2MB or less; mapped at power-on when it does not overlap the ROM
 * (one product-code exception), otherwise switched in by $A130F1.
 * @param {Uint8Array} img normalised ROM
 */
export function sramConfig(img) {
  const product = headerText(img, 0x182, 0x18e);
  const international = romName(img, 0x150);
  const checksum = (img[0x18e] << 8) | img[0x18f];
  const u32 = (o) => ((img[o] << 24) | (img[o + 1] << 16) | (img[o + 2] << 8) | img[o + 3]) >>> 0;
  let on = false, start = 0, end = 0, detected = false, note = null;
  if (img[0x1b0] === 0x52 && img[0x1b1] === 0x41) {
    detected = on = true;
    start = u32(0x1b4); end = u32(0x1b8);
    const real = realChecksum(img);
    if (product.includes("T-26013")) { start = 0x200001; end = 0x203fff; }
    else if (product.includes("00000000-00") && ((checksum === 0xcdf5 && real === 0x603a) || (checksum === 0x6bd5 && real === 0x1fea) || (checksum === 0x45c1 && real === 0xc613))) { start = 0x3f0000; end = 0x3fffff; }
    else if (start === 0xff0000) on = false;
    else if (start >= 0x800000) { start = 0x200000; end = 0x20ffff; }
    else if (start > end || end - start >= 0x10000) end = start + 0xffff;
  } else {
    const real = realChecksum(img);
    if (product.includes("T-50086") || product.includes("T-50286")) { on = true; start = 0x200001; end = 0x203fff; }
    else if (product.includes("ACLD007")) { on = true; start = 0x200001; end = 0x200fff; }
    else if ((real === 0xaeaa || real === 0x8dba) && checksum === 0x8104) { on = true; start = 0x400001; end = 0x40ffff; }
    else if (checksum === 0 && real === 0x1f7f && img.length > 0x801b1 && img[0x801b0] === 0x52 && img[0x801b1] === 0x41) { on = true; start = 0x200001; end = 0x203fff; }
    else if (international.includes("SONIC & KNUCKLES")) { if (img.length === 0x400000) { on = true; start = 0x200001; end = 0x203fff; } }
    else if (product.includes("T-113016") || international.includes("SONIC THE HEDGEHOG 2")) on = false;
    else if (img.length <= 0x200000) { on = true; start = 0x200000; end = 0x20ffff; }
  }
  const mapped = on && start >= img.length && !international.includes("SONIC THE HEDGEHOG 3") && start < 0x400000;
  if (on && start >= 0x400000) note = `backup RAM at $${start.toString(16)} (outside the cartridge area) is not modelled`;
  // md_cart_init: one cart wants backup RAM in the whole upper 2MB, two
  // others at $200000-$2FFFFF with ROM re-based above it
  const extraBanks = [], remap = [];
  if (on && start >= img.length && product.includes("T-119186")) for (let i = 0x21; i < 0x40; i++) extraBanks.push(i);
  else if (on && start < img.length && (product.includes("T-172026") || product.includes("T-172116"))) {
    for (let i = 0x20; i < 0x30; i++) extraBanks.push(i);
    if (img.length > 0x200000 && img[0x200000] !== 0xff) for (let i = 0x30; i < 0x40; i++) remap.push([i, (i - 0x10) << 16]);
  }
  return { on, detected, start, end, bank: mapped ? start >>> 16 : null, extraBanks, remap, note };
}

// eeprom_i2c.c i2c_specs: address bits, array size mask, page write mask
const I2C_SPECS = {
  X24C01: [7, 0x7f, 0x03], X24C02: [8, 0xff, 0x03], "24C01": [8, 0x7f, 0x07], "24C02": [8, 0xff, 0x07],
  "24C04": [8, 0x1ff, 0x0f], "24C08": [8, 0x3ff, 0x0f], "24C16": [8, 0x7ff, 0x0f], "24C32": [16, 0xfff, 0x1f],
  "24C64": [16, 0x1fff, 0x1f], "24C65": [16, 0x1fff, 0x3f], "24C128": [16, 0x3fff, 0x3f], "24C256": [16, 0x7fff, 0x3f],
  "24C512": [16, 0xffff, 0x7f],
};
// eeprom_i2c.c i2c_database: [product id, initial SSP (0 = any), header checksum (0 = any), board, EEPROM]
const I2C_GAMES = [
  ["T-50176", 0, 0, "ea", "X24C01"], ["T-50396", 0, 0, "ea", "X24C01"], ["T-50446", 0, 0, "ea", "X24C01"],
  ["T-50516", 0, 0, "ea", "X24C01"], ["T-50606", 0, 0, "ea", "X24C01"],
  [" T-12046", 0, 0, "sega", "X24C01"], [" T-12053", 0, 0, "sega", "X24C01"], ["MK-1215", 0, 0, "sega", "X24C01"],
  ["MK-1228", 0, 0, "sega", "X24C01"], ["G-5538", 0, 0, "sega", "X24C01"], ["PR-1993", 0, 0, "sega", "X24C01"],
  [" G-4060", 0, 0, "sega", "X24C01"], ["00001211", 0, 0, "sega", "X24C01"], ["00004076", 0, 0, "sega", "X24C01"],
  ["G-4524", 0, 0, "sega", "X24C01"], ["00054503", 0, 0, "sega", "X24C01"],
  ["T-81033", 0, 0, "acclaim16", "X24C02"], ["T-081326", 0, 0, "acclaim16", "X24C02"],
  ["T-081276", 0, 0, "acclaim32", "24C02"], ["T-81406", 0, 0, "acclaim32", "24C04"], ["T-081586", 0, 0, "acclaim32", "24C16"],
  ["T-81476", 0, 0, "acclaim32", "24C65"], ["T-81576", 0, 0, "acclaim32", "24C65"],
  ["T-120106", 0, 0, "jcart", "24C08"], ["00000000", 0x444e4c44, 0x168b, "jcart", "24C08"],
  ["00000000", 0x444e4c44, 0x165e, "jcart", "24C16"], ["T-120096", 0, 0, "jcart", "24C16"],
  ["T-120146", 0, 0, "jcart", "24C65"], ["00000000", 0xfffffffc, 0x168b, "jcart", null],
  ["00000000", 0xfffffffc, 0x165e, "jcart", null], ["T-120066", 0, 0, "jcart", null], ["T-123456", 0, 0, "jcart", null],
  ["XXXXXXXX", 0, 0xdf39, "jcart", null],
];
// board wiring: [SCL in bit, SDA in bit, SDA out bit]
const I2C_BITS = { ea: [6, 7, 7], sega: [1, 0, 0], acclaim16: [1, 0, 1], acclaim32: [0, 0, 0], jcart: [1, 0, 7] };

/**
 * eeprom_i2c_init: the serial EEPROM (and J-Cart) boards gpgx recognises,
 * by product code (with the initial SSP / header checksum for the
 * Codemasters carts), else a header whose backup RAM field says EEPROM.
 * @param {Uint8Array} img
 * @returns {null | {mapper:string, eeprom:boolean, jcart:boolean, jcartReads:boolean, addressBits:number, sizeMask:number, pagewriteMask:number, sclIn:number, sdaIn:number, sdaOut:number, sixButton:boolean, chip:string|null}}
 */
export function eepromConfig(img) {
  const product = headerText(img, 0x182, 0x18e);
  const checksum = (img[0x18e] << 8) | img[0x18f];
  const sp = ((img[0] << 24) | (img[1] << 16) | (img[2] << 8) | img[3]) >>> 0;
  const sram = sramConfig(img);
  const make = (mapper, chip) => {
    const [addressBits, sizeMask, pagewriteMask] = chip ? I2C_SPECS[chip] : [0, 0, 0];
    const [sclIn, sdaIn, sdaOut] = I2C_BITS[mapper];
    const jcart = mapper === "jcart" && !product.includes("T-120106") && !product.includes("T-120146");
    return { mapper, chip, eeprom: !!chip, jcart, jcartReads: jcart, addressBits, sizeMask, pagewriteMask, sclIn, sdaIn, sdaOut, sixButton: sixButtonPads(img) };
  };
  for (let i = I2C_GAMES.length - 1; i >= 0; i--) {
    const [id, gsp, chk, mapper, chip] = I2C_GAMES[i];
    if (!product.includes(id)) continue;
    if (id[0] === " " && sram.end - sram.start > 2) break;
    if ((chk === 0 || chk === checksum) && (gsp === 0 || gsp === sp)) return make(mapper, chip);
  }
  if (sram.detected && (img[0x1b2] === 0xe8 || sram.end - sram.start < 2)) return make("sega", "X24C01");
  return null;
}

// md_cart.c rom_database (scripts/recompile-gen/md-gpgx-db.mjs)
let MD_DB = null;
const mdDb = () => (MD_DB ??= JSON.parse(readFileSync(new URL("./gpgx-md-db.json", import.meta.url), "utf8")));
// the rom_database handlers this backend models (runtime.js cartHwWat)
const HW_MODELLED = new Set(["default_regs_r", "default_regs_r_16", "default_regs_w", "custom_regs_r", "custom_regs_w",
  "custom_alt_regs_w", "m68k_unused_8_w", "mapper_realtec_w"]);

/**
 * md_cart_init's rom_database lookup (header checksum + real checksum, first
 * match): protection / bank registers in $400000-$7FFFFF, the !TIME handlers
 * and the Realtec mapper, with the handlers this backend does not model.
 * @param {Uint8Array} img
 */
export function cartHardware(img) {
  const checksum = (img[0x18e] << 8) | img[0x18f];
  const real = realChecksum(img);
  const g = mdDb().games.find((e) => e.chk === checksum && e.realChk === real);
  if (!g) return null;
  return { ...g, unmodelled: [g.timeR, g.timeW, g.regsR, g.regsW].filter((h) => h && !HW_MODELLED.has(h)) };
}

/**
 * md_cart_init's mapper choice, for the ones this backend models ('default'
 * = default_time_w, 'ssf2' = mapper_ssf2_w) or the reason it refuses.
 * @param {Uint8Array} img
 */
export function cartMapper(img) {
  const consoleType = headerText(img, 0x100, 0x110), romType = headerText(img, 0x180, 0x182), product = headerText(img, 0x182, 0x18e);
  const international = romName(img, 0x150), domestic = romName(img, 0x120);
  if (international.includes("DEMONS OF ASTEBORG") || international.includes("ASTEBROS") || domestic.includes("DAEMON CLAW")) return { kind: "default" };
  const hw = cartHardware(img);
  if (hw && hw.unmodelled.length) return { kind: null, reason: `its rom_database entry's ${hw.unmodelled.join(" / ")} hardware` };
  if (hw && hw.realtec) return { kind: "realtec" };
  if (consoleType.includes("SEGA SSF")) return { kind: null, reason: "the Everdrive extended SSF mapper (\"SEGA SSF\" console type)" };
  if (domestic.includes("SUPER STREET FIGHTER2")) return { kind: "ssf2" };
  if (product.includes("T-5740")) return { kind: null, reason: "the T-5740 mapper with its SPI EEPROM" };
  if (romType.includes("SF") && (product.includes("001") || product.includes("002") || product.includes("004"))) return { kind: null, reason: "an SF-00x mapper" };
  if (img.length > 0x400000) return { kind: "default", note: "ROM beyond 4MB: linear at $400000-$9FFFFF as gpgx maps it; code run from a remapped bank traps" };
  return { kind: "default" };
}

/** loadrom.c: USA > JAPAN > EUROPE from the header country field. */
export function regionCode(img) {
  const s = String.fromCharCode(...img.subarray(0x1f0, 0x1f4));
  let country = 0;
  const h3 = s.slice(0, 3).toUpperCase();
  if (h3 === "EUR") country |= 8;
  else if (h3 === "JAP") country |= 1;
  else if (h3 === "USA") country |= 4;
  else {
    for (const ch of s.slice(0, 4)) {
      const u = ch.toUpperCase();
      const o = ch.charCodeAt(0);
      if (u === "U") country |= 4;
      else if (u === "J") country |= 1;
      else if (u === "E") country |= 8;
      else if (u === "K") country |= 1;
      else if (o < 16) country |= o;
      else if (u >= "0" && u <= "9") country |= u.charCodeAt(0) - 48;
      else if (u >= "A" && u <= "F") country |= u.charCodeAt(0) - 55;
    }
  }
  // get_region: carts whose header region is wrong
  const product = String.fromCharCode(...img.subarray(0x182, 0x18e));
  const checksum = (img[0x18e] << 8) | img[0x18f];
  if ((product.includes("T-45033") && checksum === 0x0f81) || product.includes("T-69046-50") || product.includes("T-120106-00")
    || product.includes("T-97126 -50") || product.includes("T-113026-50") || product.includes("T-70096 -00")
    || (checksum === 0 && realChecksum(img) === 0x1f7f)) return 0xc0;
  if (realChecksum(img) === 0x532e && product.includes("1011-00")) return 0x00;
  if (country & 4) return 0x80;
  if (country & 1) return 0x00;
  if (country & 8) return 0xc0;
  if (country & 2) return 0x40;
  return 0x80;
}

/**
 * gpgx get_region: vdp_pal = (region_code >> 6) & 1, i.e. PAL timing for a
 * European (or Japanese PAL) cart.
 * @param {Uint8Array} img
 */
export function palTiming(img) {
  return ((regionCode(img) >> 6) & 1) === 1;
}

// ---------------------------------------------------------------------------
// RAM-resident code discovery
// ---------------------------------------------------------------------------

/**
 * Find ROM -> work-RAM code copies by scanning for the copy loop games use:
 *
 *     lea    src(pc)|src.l, An
 *     lea    dst.w|dst.l, Am        ; dst in work RAM ($E00000-$FFFFFF)
 *     moveq  #n, Dk   | move.w #n, Dk
 *     move.l (An)+,(Am)+ | move.w (An)+,(Am)+
 *     dbf    Dk, *-2
 *
 * A copy counts as code only when some jsr/jmp (abs.w or abs.l) in the ROM
 * targets the copied range; data tables copied the same way are skipped.
 * The routine is decoded at the 32-bit address the game uses for the
 * destination (`lea $F200.w` sign-extends to $FFFFF200), because that is the
 * PC the reference pushes and compares. Only copies whose source is inside
 * the ROM image are reported.
 * @param {Uint8Array} img  unpadded ROM
 * @returns {{romOffset:number, ramAddress:number, length:number, foundAt:number, callers:number[]}[]}
 */
export function discoverRamCode(img) {
  const n = img.length & ~1;
  const w = (p) => (p + 1 < n ? (img[p] << 8) | img[p + 1] : -1);
  const sx16 = (v) => (v & 0x8000 ? v - 0x10000 : v);
  const out = [];
  const seen = new Set();
  for (let p = 0; p + 18 <= n; p += 2) {
    const op1 = w(p);
    // lea <ea>,An : 0100 aaa1 11 mmm rrr
    if ((op1 & 0xf1c0) !== 0x41c0) continue;
    const srcReg = (op1 >> 9) & 7;
    let q = p + 2, src;
    if ((op1 & 0x3f) === 0x3a) { src = p + 2 + sx16(w(q)); q += 2; } // d16(pc)
    else if ((op1 & 0x3f) === 0x39) { src = (w(q) << 16 | w(q + 2)) >>> 0; q += 4; } // abs.l
    else continue;
    const op2 = w(q);
    if ((op2 & 0xf1c0) !== 0x41c0) continue;
    const dstReg = (op2 >> 9) & 7;
    if (dstReg === srcReg) continue;
    let dst;
    if ((op2 & 0x3f) === 0x38) { dst = sx16(w(q + 2)) >>> 0; q += 4; } // abs.w
    else if ((op2 & 0x3f) === 0x39) { dst = (w(q + 2) << 16 | w(q + 4)) >>> 0; q += 6; } // abs.l
    else continue;
    const op3 = w(q);
    let cnt, dreg;
    if ((op3 & 0xf100) === 0x7000) { cnt = op3 & 0xff; dreg = (op3 >> 9) & 7; q += 2; } // moveq
    else if ((op3 & 0xf1ff) === 0x303c) { cnt = w(q + 2); dreg = (op3 >> 9) & 7; q += 4; } // move.w #imm,Dn
    else continue;
    const op4 = w(q);
    // move.l (An)+,(Am)+ = 0010 mmm0 1101 1nnn ; move.w = 0011 ...
    const size = (op4 >> 12) === 2 ? 4 : (op4 >> 12) === 3 ? 2 : 0;
    if (!size || (op4 & 0x0fc0) !== ((dstReg << 9) | 0x00c0) || (op4 & 0x3f) !== (0x18 | srcReg)) continue;
    // dbf Dk,*-2 : 0101 0001 1100 1kkk, disp -4
    if (w(q + 2) !== (0x51c8 | dreg) || w(q + 4) !== 0xfffc) continue;
    const length = ((cnt & 0xffff) + 1) * size;
    if ((dst & 0xffffff) < 0xe00000) continue;
    if (src < 0 || src + length > img.length) continue;
    const key = `${src}:${dst}:${length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A copy is CODE only if something calls or jumps into it: tables copied
    // to RAM the same way (one cart copies one to $FE30) must not become arms.
    const callers = jumpsInto(dst & 0xffff, length);
    if (!callers.length) continue;
    out.push({ romOffset: src, ramAddress: dst, length, foundAt: p, callers });
  }
  return out;

  /** ROM offsets of jsr/jmp abs.w|abs.l whose target lands in work RAM [lo, lo+len). */
  function jumpsInto(lo, len) {
    const hits = [];
    for (let p = 0; p + 4 <= n; p += 2) {
      const op = w(p);
      if (op === 0x4eb8 || op === 0x4ef8) {
        const t = w(p + 2);
        if ((t & 0x8000) && t >= lo && t < lo + len) hits.push(p);
      } else if ((op === 0x4eb9 || op === 0x4ef9) && p + 6 <= n) {
        const t = (w(p + 2) << 16 | w(p + 4)) >>> 0;
        if ((t & 0xffffff) >= 0xe00000 && (t & 0xffff) >= lo && (t & 0xffff) < lo + len) hits.push(p);
      }
    }
    return hits;
  }
}

/**
 * Code in work RAM found by RUNNING the reference: genesis_plus_gx from power-on
 * (no settle frames) for `frames` frames on the `input` schedule (reference
 * frames, loadMedia's usual 5 settle frames added), its free-running
 * instruction trace read every frame. Every 68000 pc in $E00000-$FFFFFF it
 * executed is recorded with each distinct 10-byte window of work RAM at that
 * pc seen at the end of a frame it ran in (a 68000 instruction is at most 10
 * bytes). This finds what the copy-loop scan cannot: routines built or
 * patched in RAM, trampolines written at run time (a `jmp` the game stores
 * into its interrupt stub), code copied by other loops or decompressed.
 * @param {string} romPath
 * @param {{frames?: number, input?: string|object[]}} [o]
 * @returns {Promise<{windows: Map<number, Set<string>>, frames: number, instructions: number}>}
 */
export async function discoverRamCodeTrace(romPath, o = {}) {
  const frames = Number.isInteger(o.frames) && o.frames > 0 ? o.frames : 3000;
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { resolveCore } = await import("../../../../cores/registry.js");
  const { ScheduleDriver, parseInputSchedule } = await import("../../../../host/verify-recompile.js");
  const resolved = resolveCore("genesis");
  if (!resolved) throw new Error("genesis recompile: no reference core for genesis");
  const host = new LibretroHost();
  try {
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    host.status.paused = true;
    await host.loadMedia({ platform: "genesis", path: romPath });
    host.status.paused = false;
    if (!host.traceSupported()) throw new Error("genesis recompile: the reference core records no instruction trace");
    host.setTrace({ capacity: 1 << 20 });
    const settle = 5;
    const driver = new ScheduleDriver(host, parseInputSchedule(o.input ?? ""));
    const windows = new Map();
    // cartridge banks a mapper re-based (or gave to backup RAM) while code ran
    // there: gpgx's memory_map[bank].base against cart.rom (bank 0's base at
    // power-on), read before and after every frame
    const { readFileSync } = await import("node:fs");
    const cmask = padRom(normalizeRom(new Uint8Array(readFileSync(romPath)))).length - 1;
    const bases = () => {
      const b = host.readMemory("genesis_m68k", 0, 0x40 * 20);
      return Array.from({ length: 0x40 }, (_, i) => (b[i * 20] | (b[i * 20 + 1] << 8) | (b[i * 20 + 2] << 16) | (b[i * 20 + 3] << 24)) >>> 0);
    };
    const realtec0 = !!cartHardware(normalizeRom(new Uint8Array(readFileSync(romPath))))?.realtec;
    // bank 0 holds cart.rom at power-on, except on a Realtec board (its boot ROM copy at cart.rom + $400000)
    const cartRom = bases()[0] - (realtec0 ? 0x400000 : 0);
    const remap = new Map();
    // the mapper writes ($A130xx) of each frame, with the writing pc, replayed
    // against the trace so each pc gets the mapping it ran under
    const mod = host.mod;
    const watch = host.rangeWatchSupported();
    const img0 = normalizeRom(new Uint8Array(readFileSync(romPath)));
    const ssf2 = cartMapper(img0).kind === "ssf2";
    const sramOn = sramConfig(img0).on || !!(eepromConfig(img0)?.eeprom);
    const realtec = !!cartHardware(img0)?.realtec;
    // mapper registers carried across frames (default_time_w's saved bank, the Realtec registers)
    const saved = { sram: sramOn, reg0: undefined, rt: [0, 0, 0] };
    // mapper_realtec_w on the table
    const realtecW = (m, a, v, s) => {
      if (a === 0x402000) s.rt[1] = (v & 3) << 1;
      else if (a === 0x404000) s.rt[2] = (v & 3) << 1;
      else if (a === 0x400000 && (v & 1) && !s.rt[0]) {
        for (let i = 0; i < 0x40; i++) m[i] = ((((i & 7) & ~s.rt[1]) | (s.rt[2] & s.rt[1])) << 16) & cmask;
        s.rt[0] = v;
      }
    };
    const evbuf = watch ? mod._malloc(4096 * 12 + 8) : 0;
    const timeWrites = () => {
      const n = mod._romdev_range_get(evbuf, 4096, evbuf + 4096 * 12);
      const u = new Uint32Array(mod.HEAPU8.buffer, evbuf, n * 3);
      const ev = [];
      for (let i = 0; i < n; i++) {
        const a = u[i * 3 + 1] & 0xffffff, v = u[i * 3 + 2] & 0xff, pc = u[i * 3] & 0xffffff;
        // a word write shows as its two bytes: one time_w call, even address
        const last = ev[ev.length - 1];
        if (last && !(last.a & 1) && a === last.a + 1 && pc === last.pc && !last.word) { last.v = (last.v << 8) | v; last.word = true; continue; }
        ev.push({ pc, a, v, word: false });
      }
      return ev;
    };
    // gpgx default_time_w / mapper_ssf2_w on a copy of the bank table
    // (offsets from cart.rom; -1 = backup RAM)
    const timeW = (m, a, v, saved) => {
      if (ssf2) { if (a & 0x0e) for (let i = 0; i < 8; i++) m[((a << 2) & 0x38) + i] = ((v << 19) & cmask) + (i << 16); return; }
      if (a < 0xa13060) { for (let i = 0; i < 64; i++) m[i] = ((a + i) & 0x3f) << 16; return; }
      if (a > 0xa130f1) { for (let i = 0; i < 8; i++) m[((a << 2) & 0x38) + i] = ((v << 19) & cmask) + (i << 16); return; }
      if (v & 1) { if (m[0x20] !== -1 && saved.sram) { saved.reg0 = m[0x20]; m[0x20] = -1; } }
      else if (m[0x20] === -1) m[0x20] = saved.reg0;
    };
    let from = 0, instructions = 0, recaptured = 0;
    const canBreak = host.pcBreakSupported?.() ?? false;
    const suspects = new Map();
    for (let f = 1; f <= frames + settle; f++) {
      const rf = f - settle;
      if (rf >= 0) driver._apply(driver._want(rf));
      const before = bases();
      const ramBefore = host.readMemory("system_ram", 0, 0x10000).slice();
      const state0 = canBreak ? host.serializeState() : null;
      // (a Realtec board's mapper is its $400000-$404000 registers instead)
      if (watch) mod._romdev_range_set(realtec ? 0x400000 : 0xa13000, realtec ? 0x404001 : 0xa130ff, 2, 1);
      await host.stepFrames(1);
      const after = bases();
      const ev = watch ? timeWrites() : [];
      const tr = host.readTrace(from);
      if (tr.lost) throw new Error(`genesis recompile: the reference trace overflowed (${tr.lost} instructions lost in one frame)`);
      from = tr.to;
      instructions += tr.pc.length;
      let ram = null, sram = null;
      // the replayed table: offsets from cart.rom, or -1 for backup RAM
      // the Realtec boot ROM copies (cart.rom + $400000) are -4, as the cart's bank table has them
      const rel = (m) => m.map((b) => { const o = b - cartRom; return o >= 0 && o <= cmask ? o : realtec && o >= 0x400000 && o < 0x410000 ? -4 : -1; });
      const cur = rel(before), relAfter = rel(after);
      saved.reg0 ??= (0x20 << 16) & cmask;
      let e = 0;
      for (const pc of tr.pc) {
        const pa = pc & 0xffffff;
        let tables = null;
        if (pa < 0x400000) {
          const bank = pa >>> 16, own = (pa & 0x3f0000) & cmask;
          // no mapper write this frame: the frame's two ends
          // (a pc in a mirror of a smaller ROM counts too: the ROM arms
          // were compiled at the ROM offset, not at the mirror's address)
          const mirror = pa > cmask;
          if (cur[bank] !== own || mirror) tables = [[cur[bank], bank < 0x3f ? cur[bank + 1] : -1]];
          if (!ev.length && (relAfter[bank] !== own || mirror)) (tables ??= []).push([relAfter[bank], bank < 0x3f ? relAfter[bank + 1] : -1]);
        }
        while (e < ev.length && ev[e].pc === pa) { (realtec ? realtecW : timeW)(cur, ev[e].a, ev[e].v, saved); e++; }
        if (tables) {
          for (const [off, next] of tables) {
            let key;
            if (off >= 0) key = `rom:${off}:${next}`;
            else if (realtec && off === -4) key = "boot";
            else {
              // not the ROM: backup RAM (sram.sram), read through save_ram
              // (libretro sizes it to the last byte that is not $FF while running)
              if (!sram) {
                sram = new Uint8Array(0x10000).fill(0xff);
                try { const n = host.regionSize("save_ram"); if (n > 0) sram.set(host.readMemory("save_ram", 0, Math.min(n, 0x10000))); } catch { /* no backup RAM */ }
              }
              key = "sram:";
              for (let k = 0; k < 10; k++) key += sram[(pa + k) & 0xffff].toString(16).padStart(2, "0");
            }
            let set = remap.get(pc >>> 0);
            if (!set) remap.set(pc >>> 0, (set = new Set()));
            set.add(key);
          }
          continue;
        }
        if (pa < 0xe00000) continue;
        if (!ram) ram = host.readMemory("system_ram", 0, 0x10000);
        const a = pc & 0xffff;
        let set = windows.get(pc >>> 0);
        if (!set) windows.set(pc >>> 0, (set = new Set()));
        // what the frame ran may be what was there when it began (the game
        // rewrites the routine later in the frame) or what it left
        const keys = [ramBefore, ram].map((m) => { let key = ""; for (let k = 0; k < 10; k++) key += m[(a + k) & 0xffff].toString(16).padStart(2, "0"); return key; });
        for (const key of keys) set.add(key);
        // code written and gone within the frame (or rewritten while it
        // ran) is in neither: re-run the frame to a breakpoint at it
        if (canBreak && (keys[0] !== keys[1] || keys[0].startsWith("0000") || keys[0].startsWith("ffff")) && !suspects.has(pc >>> 0)) suspects.set(pc >>> 0, set);
      }
      if (suspects.size) {
        // up to 16 breakpoints spread over the suspects in the order they ran;
        // each one's RAM gives every suspect a candidate (a routine is
        // usually written whole before it runs)
        const end = host.serializeState();
        const list = [...suspects];
        const stride = Math.ceil(list.length / 16);
        for (let i = 0; i < list.length; i += stride) {
          host.unserializeState(state0);
          const r = host.runUntilPC(list[i][0], 1);
          if (!r.hit) continue;
          const m = host.readMemory("system_ram", 0, 0x10000);
          for (const [pc, set] of list) {
            let key = "";
            for (let k = 0; k < 10; k++) key += m[(pc + k) & 0xffff].toString(16).padStart(2, "0");
            set.add(key);
          }
          recaptured++;
        }
        host.unserializeState(end);
        from = host.traceInfo().count;
        suspects.clear();
      }
    }
    if (evbuf) { mod._romdev_range_set(0, 0, 0, 0); mod._free(evbuf); }
    return { windows, remap, frames, instructions, recaptured };
  } finally {
    try { host.dispose?.(); } catch { /* best effort */ }
  }
}

/** Normalise options.ramCode (plus discovery unless options.discoverRamCode === false). */
function ramCodeList(img, opts) {
  const list = [];
  if (opts.discoverRamCode !== false) {
    for (const r of discoverRamCode(img)) list.push({ romOffset: r.romOffset, ramAddress: r.ramAddress, length: r.length, source: "discovered" });
  }
  for (const r of opts.ramCode || []) {
    const e = { romOffset: Number(r.romOffset), ramAddress: Number(r.ramAddress) >>> 0, length: Number(r.length), source: "options.ramCode" };
    if (!(e.length > 0) || e.romOffset < 0 || e.romOffset + e.length > img.length) {
      throw new Error(`options.ramCode entry out of range: ${JSON.stringify(r)}`);
    }
    if ((e.ramAddress & 0xffffff) < 0xe00000) throw new Error(`options.ramCode ramAddress must be in work RAM ($E00000-$FFFFFF): ${JSON.stringify(r)}`);
    const i = list.findIndex((x) => x.ramAddress === e.ramAddress);
    if (i >= 0) list[i] = e;
    else list.push(e);
  }
  return list;
}

// ---------------------------------------------------------------------------
// describe / layout
// ---------------------------------------------------------------------------

// The cart's state block (written at the end of every wc_render, all LE u32)
// against gpgx's m68ki_cpu_core as romdev's genesis_m68k region exposes it.
const M68K_REF = 5120; // offset of the core struct fields inside genesis_m68k
const m68kField = (offset, refOffset) => ({ offset, size: 4, ref: { region: "genesis_m68k", offset: M68K_REF + refOffset } });

/**
 * What the verify op compares (romdev.recompile schema, see
 * src/analysis/recompile/recompile-section.js): linear-memory regions against
 * gpgx's memory regions, the 68000 state block against genesis_m68k, and the
 * cart-only probe counters.
 */
export const layout = {
  regions: {
    wram: { offset: RT.WRAM, length: 0x10000, ref: "system_ram" },
    vram: { offset: RT.VRAM, length: 0x10000, ref: "video_ram" },
    cram: { offset: RT.CRAM, length: 128, ref: "genesis_cram" },
    vsram: { offset: RT.VSRAM, length: 128, ref: "genesis_vsram" },
    zram: { offset: RT.ZRAM, length: 0x2000, ref: "genesis_z80_ram" },
  },
  fields: {
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`d${i}`, m68kField(STATE + 4 * i, 4 * (6 + i))])),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, m68kField(STATE + 32 + 4 * i, 4 * (14 + i))])),
    pc: m68kField(STATE + 64, 88),
    cycles: m68kField(STATE + 72, 12),
    refresh: m68kField(STATE + 76, 16),
    int_level: m68kField(STATE + 80, 216),
    stopped: m68kField(STATE + 84, 220),
    sp0: m68kField(STATE + 156, 160),
    sp4: m68kField(STATE + 160, 176),
    s_flag: m68kField(STATE + 188, 188),
    x_flag: m68kField(STATE + 164, 192),
    n_flag: m68kField(STATE + 168, 196),
    not_z_flag: m68kField(STATE + 172, 200),
    v_flag: m68kField(STATE + 176, 204),
    c_flag: m68kField(STATE + 180, 208),
    int_mask: m68kField(STATE + 184, 212),
  },
  // cart-only diagnostics (no reference counterpart); trapped != 0 fails a verify
  probe: {
    trapped: { offset: STATE + 96, size: 4 },
    trappc: { offset: STATE + 100, size: 4 },
    sr: { offset: STATE + 68, size: 4 },
    v_status: { offset: STATE + 88, size: 4 },
    frames: { offset: STATE + 92, size: 4 },
    lockups: { offset: STATE + 104, size: 4 },
    lockpc: { offset: STATE + 108, size: 4 },
    steps: { offset: STATE + 132, size: 4 },
    nvint: { offset: STATE + 136, size: 4 },
    nhint: { offset: STATE + 140, size: 4 },
    zstate: { offset: STATE + 148, size: 4 },
    v_counter: { offset: STATE + 152, size: 4 },
  },
  vramZero: ["vram"],
};

/**
 * Header-derived configuration for one ROM.
 * @param {Uint8Array} rom
 * @param {{ramCode?:{romOffset:number, ramAddress:number, length:number}[], discoverRamCode?:boolean}} [opts]
 */
export function describe(rom, opts = {}) {
  const raw = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
  const img = normalizeRom(raw);
  if (img.length < 0x200) throw new Error("genesis recompile: ROM smaller than its 512-byte header");
  const padded = padRom(img);
  const txt = (a, b) => Array.from(img.subarray(a, b), (c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ")).join("").replace(/\s+/g, " ").trim();
  const ramCode = ramCodeList(img, opts);
  const narms = Math.ceil(img.length / 2) + ramCode.reduce((s, r) => s + Math.ceil(r.length / 2), 0);
  const data = loadGpgxData();
  return {
    platform: "genesis",
    referenceCore: REFERENCE_CORE,
    supported: cartMapper(img).kind !== null,
    unsupportedReason: cartMapper(img).kind === null ? `genesis_plus_gx runs this cart with ${cartMapper(img).reason}, which this backend does not model` : null,
    romSha1: createHash("sha1").update(raw).digest("hex"),
    ...(img !== raw ? { romFormat: raw.length !== img.length ? "smd (512-byte header, interleaved): de-interleaved as gpgx loads it" : "byte-swapped: swapped back as gpgx loads it" } : {}),
    romBytes: img.length,
    romMirrorSize: padded.length,
    system: txt(0x100, 0x110),
    title: txt(0x150, 0x180) || txt(0x120, 0x150), // overseas name, else domestic (ASCII only)
    regionField: txt(0x1f0, 0x1f4),
    regionCode: regionCode(img),
    pal: palTiming(img),
    // gpgx input_init: a '6' in the header's I/O support field ($190-$19D)
    // connects 6-button pads, anything else 3-button ones
    sixButton: sixButtonPads(img),
    sram: sramConfig(img),
    // eeprom_i2c_init: serial EEPROM / J-Cart boards (the backup RAM is then not memory-mapped)
    eeprom: eepromConfig(img),
    mapper: cartMapper(img),
    // md_cart_init: 'SV' at $1C8 = the SVP chip (gpgx cart_hw/svp, svp.js)
    svp: hasSvp(img),
    ramCode,
    arms: narms,
    shards: Math.ceil(narms / SH),
    layout,
    conventions,
    license: data.meta.license,
    licenseNote: hasSvp(img)
      ? "carts built by this backend contain code transpiled from Genesis Plus GX, and this SVP cart its SVP chip code (svp.c / ssp16.c, free for non-commercial use only): non-commercial"
      : "carts built by this backend contain code transpiled from Genesis Plus GX: non-commercial",
    derivedFrom: { gpgxCommit: data.meta.provenance.commit, generatorVersion: data.meta.generatorVersion },
  };
}

export const REFERENCE_CORE = "genesis_plus_gx";

/**
 * Frame / input conventions: romdev's wasmcart host runs 1 settle frame in
 * loadMedia and the gpgx core 5, so reference frame F is cart frame F+4; the
 * cart does no warm-up of its own. The pad is read positionally (wasmcart A =
 * south = Genesis B, B = east = Genesis C, X = west = Genesis A), which is the
 * same physical button gpgx's libretro B/A/Y name.
 */
export const conventions = { settleFrames: { cart: 1, reference: 5 }, cartFrameOffset: 4, warmupFrames: 0, buttons: "positional" };

/**
 * The cart's `romdev.recompile` custom section.
 * @param {Uint8Array} rom
 * @param {string} [sha1]
 * @param {object} [opts]
 */
export function recompileSection(rom, sha1, opts = {}) {
  const d = describe(rom, opts);
  const ring = traceRingFor(opts);
  const svpAt = svpPlacement(normalizeRom(rom instanceof Uint8Array ? rom : new Uint8Array(rom)));
  const regFields = ring.regs ? {
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`d${i}`, { offset: 16 + 4 * i }])),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, { offset: 48 + 4 * i }])),
    sr: { offset: 80, mask: 0xffff },
  } : {};
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: "genesis",
      reference: "genesis",
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || d.romSha1,
      warmupFrames: 0,
      buttons: "positional",
      // the picture is drawn from the framebuffer's left edge at the active
      // width (256 in H32, 320 in H40), which is where gpgx's frame starts
      screen: { origin: [0, 0] },
      // SVP carts add the chip's DRAM, IRAM and SSP1601 state (svp.js)
      regions: svpAt ? { ...layout.regions, ...svpRegions(svpAt.base) } : layout.regions,
      fields: layout.fields,
      probe: layout.probe,
      vramZero: layout.vramZero,
      conventions,
      // the instruction ring $trace writes (findDiverge level:'instruction')
      trace: {
        baseField: { offset: STATE + 0xf4 }, entries: ring.entries, stride: ring.stride,
        cursor: { offset: STATE + 0xfc, mode: "index", writable: true, note: "wraps at entries" },
        enable: { offset: STATE + 0xf8 },
        pc: { offset: 0, mask: 0xffffff }, skipIf: { offset: 0, bit: 31, note: "interrupt-entry event records" },
        // $mc is the frame's master cycle count, but it is not charged at the
        // same point of an instruction as gpgx's m68k.cycles at dispatch (the
        // two differ by up to ~130 cycles mid-frame and agree again), so it is
        // reported as a field, not compared as a per-instruction clock
        fields: { mc: { offset: 4 }, refresh: { offset: 8 }, cycleEnd: { offset: 12 }, ...regFields },
        ...(ring.regs ? { note: "options.traceEntries: d0-d7, a0-a7 (a7 = the active stack pointer) and sr before each instruction, compared with genesis_plus_gx's per-instruction 68000 columns" } : {}),
      },
      ramCode: d.ramCode.map(({ romOffset, ramAddress, length, source }) => ({ romOffset, ramAddress, length, source })),
      trapHint: "probe trapped=1 means the cart reached something this backend does not model (trappc = the 68000 pc); code with no compiled arm runs in the interpreter, so RAM code alone never traps unless the cart was built with options.ramInterpreter:false",
      license: d.licenseNote,
      // genesis_plus_gx's libretro output (ym2612.js): s16 stereo 44100 Hz
      ...(opts.audio !== false ? { audio: mdSoundInfo(SND, opts.audioDeltas ? DELTAS : undefined).section } : {}),
      ...(opts.svpBreak ? { debugSvpBreak: "mpya: A += P ^ 1", warning: "built with options.svpBreak: the SVP chip's mpya opcode adds P xor 1 (a must-fail control), NOT a faithful cart" } : {}),
      ...(opts.breakArm != null ? { debugBreakArm: parseBreakArm(opts.breakArm), warning: "built with options.breakArm: one instruction also flips bit 0 of d0 (a must-fail control), NOT a faithful cart" } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// WAT emission
// ---------------------------------------------------------------------------

const ESC = (() => {
  const t = new Array(256);
  for (let x = 0; x < 256; x++) {
    if (x === 0x22) t[x] = "\\22";
    else if (x === 0x5c) t[x] = "\\5c";
    else if (x >= 0x20 && x < 0x7f) t[x] = String.fromCharCode(x);
    else t[x] = "\\" + x.toString(16).padStart(2, "0");
  }
  return t;
})();

/** Bytes as a WAT string body. */
function watBytes(b) {
  const parts = [];
  const CH = 65536;
  for (let i = 0; i < b.length; i += CH) {
    const end = Math.min(b.length, i + CH);
    let s = "";
    for (let j = i; j < end; j++) s += ESC[b[j]];
    parts.push(s);
  }
  return parts.join("");
}

const hex6 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(6, "0");

/**
 * Emit the whole cart as WAT text chunks of ONE (module ...).
 * @param {Uint8Array} rom
 * @param {{ramCode?:object[], discoverRamCode?:boolean, traceEntries?:number, breakArm?:number|string, onProgress?:(s:string)=>void}} [opts]
 *   traceEntries: record d0-d7/a0-a7/sr per instruction (see traceRingFor); breakArm: see parseBreakArm
 */
export async function* emitWat(rom, opts = {}) {
  const img = normalizeRom(rom instanceof Uint8Array ? rom : new Uint8Array(rom));
  const D = loadGpgxData();
  const ROMDATA = padRom(img);
  const ROMSIZE = ROMDATA.length;
  const ROMWORDS = ROMSIZE / 2;
  const SVPAT = svpPlacement(img);
  if (opts.svpBreak && !SVPAT) throw new Error("genesis recompile: options.svpBreak needs an SVP cart ('SV' at $1C8)");
  const PCTAB = ROMIMG + ROMSIZE + (SVPAT ? SVPAT.size : 0);
  let PACKED = PCTAB + (ROMWORDS + RAMWORDS) * 4;
  const fetchRom = (p) => {
    p &= ROMSIZE - 1;
    return (ROMDATA[p] << 8) | ROMDATA[(p + 1) & (ROMSIZE - 1)];
  };

  // arm list: [index, pc, fetch16, variants?]; ROM arms first, then the
  // RAM-resident code: copies the scan found (ROM bytes at their RAM
  // address) and, from the reference's own trace, every RAM pc it ran with
  // each encoding seen there. An index with more than one candidate becomes
  // a guarded arm: each variant runs only while the work RAM words it was
  // compiled from are still there (and at the pc form it was compiled for);
  // anything else traps, with trappc = the RAM pc.
  const arms = [];
  for (let off = 0; off < img.length; off += 2) arms.push([off >> 1, off, fetchRom]);
  const ramArms = new Map(); // index -> [{pc, f16, source}]
  const addRam = (pc, f16, source) => {
    const idx = ROMWORDS + ((pc & 0xffff) >> 1);
    let v = ramArms.get(idx);
    if (!v) ramArms.set(idx, (v = []));
    v.push({ pc: pc >>> 0, f16, source });
  };
  for (const { romOffset, ramAddress, length } of ramCodeList(img, opts)) {
    const f16 = (p) => {
      const d = (p - ramAddress) >>> 0;
      if (d < 0x10000) return fetchRom(romOffset + d);
      return fetchRom(p);
    };
    for (let k = 0; k < length; k += 2) addRam((ramAddress + k) >>> 0, f16, "copy");
  }
  let traced = null;
  if (opts.ramTrace !== false && typeof opts.romPath === "string") {
    const o = opts.ramTrace && typeof opts.ramTrace === "object" ? opts.ramTrace : {};
    traced = await discoverRamCodeTrace(opts.romPath, o);
    for (const [pc, keys] of traced.windows) {
      for (const key of keys) {
        const bytes = Uint8Array.from(key.match(/../g), (h) => parseInt(h, 16));
        const f16 = (p) => {
          const d = (p - pc) >>> 0;
          if (d + 1 < bytes.length) return (bytes[d] << 8) | bytes[d + 1];
          return 0x10000; // never a word: a guard on it always fails
        };
        addRam(pc, f16, "trace");
      }
    }
  }
  for (const [idx, vs] of ramArms) {
    // one copy-scan variant alone keeps the unguarded arm it always had
    if (vs.length === 1 && vs[0].source === "copy") arms.push([idx, vs[0].pc, vs[0].f16]);
    else arms.push([idx, vs[0].pc, vs[0].f16, vs]);
  }
  // code the reference ran from a cartridge bank a mapper re-based or gave to
  // backup RAM: one guarded arm per pc (arm index ROMWORDS + RAMWORDS + j,
  // j = rank of the pc in ALTTAB), each variant guarded by what that bank
  // maps to (and, for backup RAM, the words it was compiled from)
  const altPcs = [];
  if (traced && traced.remap.size) {
    const pcs = [...traced.remap.keys()].sort((x, y) => (x & 0xffffff) - (y & 0xffffff));
    for (const pc of pcs) {
      const bank = (pc >>> 16) & 0x3f;
      const vs = [];
      for (const key of traced.remap.get(pc)) {
        if (key === "boot") {
          // the Realtec boot ROM: ROM $7E000-$7FFFF mirrored every 8KB
          vs.push({ pc, f16: (p) => fetchRom(0x7e000 | (p & 0x1fff)), source: "boot", bank });
        } else if (key.startsWith("rom:")) {
          const [b, n] = key.slice(4).split(":").map(Number);
          const f16 = (p) => {
            const pb = (p >>> 16) & 0x3f;
            const base = pb === bank ? b : pb === bank + 1 && n >= 0 && n < ROMSIZE ? n : -1;
            return base < 0 ? 0x10000 : fetchRom(base + (p & 0xffff));
          };
          vs.push({ pc, f16, source: "remap", bank, b, n });
        } else {
          // gpgx fetches instructions as host-order words of the memory_map
          // base: sram.sram holds 68000-order bytes, so code run from backup
          // RAM is fetched byte-swapped (data reads are not)
          const bytes = Uint8Array.from(key.slice(5).match(/../g), (h) => parseInt(h, 16));
          const f16 = (p) => {
            const d = (p - pc) >>> 0;
            return d + 1 < bytes.length ? bytes[d] | (bytes[d + 1] << 8) : 0x10000;
          };
          vs.push({ pc, f16, source: "sram", bank });
        }
      }
      arms.push([ROMWORDS + RAMWORDS + altPcs.length, pc, vs[0].f16, vs, "alt"]);
      altPcs.push(pc & 0xffffff);
    }
    PACKED += altPcs.length * 4;
  }
  const narms = arms.length;
  const nsh = Math.ceil(narms / SH);
  const M = D.m68k.tables;
  const tabsegs = [
    ...RT.dataSegments(M.m68ki_cycles, [M.m68ki_shift_8_table, M.m68ki_shift_16_table, M.m68ki_shift_32_table], D.hvc),
    ...RT.fifoSegments(),
    ...RT.smallTables(),
  ];
  const zlay = RT.z80Layout();
  tabsegs.push(...RT.z80Segments(zlay, D.z80.cc));
  const ring = traceRingFor(opts);
  const ALTTAB = PACKED + narms * 8;
  const tracebuf = (ALTTAB + altPcs.length * 4 + 0xffff) & ~0xffff;
  let pages = Math.floor((tracebuf + ring.entries * ring.stride) / 0x10000) + 1;
  if (opts.audioDeltas && opts.audio !== false) {
    if (pages * 0x10000 > DELTAS.countOffset) throw new Error("genesis recompile: options.audioDeltas: the cart is too large for the debug stream at 0x3000000");
    pages = Math.floor(DELTAS.end / 0x10000) + 1;
  }

  yield `(module\n  (memory (export "memory") ${pages})\n  `;
  yield RT.globalsWat();
  yield RT.cpuWat();
  const HW = cartHardware(img);
  yield opts.audio !== false ? hookMemWat(RT.memWat(ROMIMG, ROMSIZE, HW)) : RT.memWat(ROMIMG, ROMSIZE, HW);
  const SRAM = sramConfig(img), MAPPER = cartMapper(img), EEP = eepromConfig(img);
  // a serial EEPROM is sram.custom: the backup RAM is not memory-mapped
  if (EEP && EEP.eeprom) SRAM.bank = null;
  yield RT.cartWat(ROMIMG, ROMSIZE, { sramOn: (SRAM.on || !!(EEP && EEP.eeprom)) && SRAM.start < 0x400000, ssf2: MAPPER.kind === "ssf2", eeprom: EEP, hw: HW, svp: !!SVPAT });
  yield RT.ioWat({ sixButton: sixButtonPads(img), timeR: HW && HW.timeR, svp: !!SVPAT });
  const PAL = palTiming(img);
  // options.audio (default on): genesis_plus_gx's YM2612 + PSG output (ym2612.js)
  const AUDIO = opts.audio !== false;
  if (AUDIO && mdSoundInfo(SND).end > RT.ZT) throw new Error("genesis recompile: the sound state overlaps the Z80 tables");
  yield AUDIO ? hookVdpWat(RT.vdpWat({ pal: PAL, hw: HW, svp: !!SVPAT })) : RT.vdpWat({ pal: PAL, hw: HW, svp: !!SVPAT });
  if (AUDIO) yield ymWat({ base: SND, cursorAddr: ABI + 256, fmBuf: FMBUF, pal: PAL, deltas: opts.audioDeltas ? DELTAS : undefined });
  yield RT.renderWat();
  // the Z80: one function per opcode handler, dispatched via the table
  zlay.tbase = nsh;
  const znames = z80HandlerNames();
  const z80text = RT.z80Wat(zlay, D.z80.cc, HW).replaceAll("{romimg}", String(ROMIMG)).replaceAll("{rmask}", String(ROMSIZE - 1))
    .replaceAll("{ztbase}", String(nsh));
  yield AUDIO ? hookZ80Wat(z80text, zlay.ZREGS + 64) : z80text;
  {
    let buf = [];
    for (const zn of znames) buf.push(translateZ80(D.z80, zn, zlay));
    yield buf.join("");
  }
  // the 68000 interpreter for every pc with no compiled arm (interp.js)
  const INTERP = opts.ramInterpreter !== false;
  if (INTERP) yield* m68kInterpWat(D);
  const FALLBACK = INTERP ? "(call $m68k_interp)" : "(call $trap)";
  // the 68000 arms, one br_table shard per SH arms
  let bad = 0, broken = 0, ramVariantCount = 0;
  const breakAt = parseBreakArm(opts.breakArm);
  for (let si = 0; si < nsh; si++) {
    const sh = arms.slice(si * SH, (si + 1) * SH);
    const bodies = [];
    let nl = 1;
    for (const [, pc, f16, variants, kind] of sh) {
      let body, nloc;
      if (variants) {
        ({ body, nlocals: nloc } = kind === "alt" ? guardedAltArm(D, variants, FALLBACK) : guardedRamArm(D, variants, FALLBACK));
        ramVariantCount += variants.length;
      } else {
        try {
          ({ body, nlocals: nloc } = translateM68k(D.m68k, f16(pc), pc, f16));
        } catch (e) {
          if (!(e instanceof TrError)) throw e;
          body = "(call $trap)";
          nloc = 0;
          bad++;
        }
      }
      if (nloc > nl) nl = nloc;
      if (breakAt !== null && (pc & 0xffffff) === breakAt) {
        // DEBUG / MUST-FAIL CONTROL (options.breakArm)
        body += " (global.set $r0 (i32.xor (global.get $r0) (i32.const 1)))";
        broken++;
      }
      bodies.push(`      ) ;; $${hex6(pc)}\n    ${body} (return)\n`);
    }
    const parts = [`  (func $shard${si} (param $id i32)\n`];
    const locs = [];
    for (let i = 1; i <= nl; i++) locs.push(`(local $t${i} i32)`);
    parts.push("    " + locs.join(" ") + "\n");
    let open = "    (block $sdef ";
    for (let i = sh.length - 1; i >= 0; i--) open += `(block $s${i} `;
    parts.push(open + "\n");
    const labels = [];
    for (let i = 0; i < sh.length; i++) labels.push(`$s${i}`);
    parts.push("      (br_table " + labels.join(" ") + " $sdef (local.get $id))\n");
    parts.push("      (call $trap) (return)\n");
    parts.push(bodies.join(""));
    parts.push("    ) (call $trap))\n");
    yield parts.join("");
    if (opts.onProgress && si % 32 === 31) opts.onProgress(`genesis: ${Math.min((si + 1) * SH, narms)}/${narms} arms`);
  }
  // ---- dispatch
  yield `
  ;; instruction ring for the differ: (pc, master cycle) per step, plus
  ;; events with bit 31 set (interrupt entry). Off unless STATE+0xF8 != 0.
  (func $trace (param $p i32)${ring.regs ? regTraceWat(tracebuf, ring.entries) : `
    (if (i32.load (i32.const ${STATE + 0xF8}))
      (then
        (i32.store (i32.add (i32.const ${tracebuf}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (local.get $p))
        (i32.store (i32.add (i32.const ${tracebuf + 4}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $mc))
        (i32.store (i32.add (i32.const ${tracebuf + 8}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $refresh))
        (i32.store (i32.add (i32.const ${tracebuf + 12}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $mcend))
        (i32.store (i32.const ${STATE + 0xFC}) (i32.and (i32.add (i32.load (i32.const ${STATE + 0xFC})) (i32.const 1)) (i32.const ${TRACEN - 1}))))))`}
  (func (export "dbg_tracebuf") (result i32) (i32.const ${tracebuf}))
  ;; binary search of the ${altPcs.length} re-based-bank pcs (ALTTAB, sorted): their arm id, or 0
  (func $alt_id (param $p i32) (result i32)
    (local $lo i32) (local $hi i32) (local $mid i32) (local $v i32)
    (local.set $hi (i32.const ${altPcs.length}))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $lo) (local.get $hi)))
      (local.set $mid (i32.shr_u (i32.add (local.get $lo) (local.get $hi)) (i32.const 1)))
      (local.set $v (i32.load (i32.add (i32.const ${ALTTAB}) (i32.shl (local.get $mid) (i32.const 2)))))
      (if (i32.eq (local.get $v) (local.get $p))
        (then (return (i32.load (i32.add (i32.const ${PCTAB + (ROMWORDS + RAMWORDS) * 4}) (i32.shl (local.get $mid) (i32.const 2)))))))
      (if (i32.lt_u (local.get $v) (local.get $p)) (then (local.set $lo (i32.add (local.get $mid) (i32.const 1))))
        (else (local.set $hi (local.get $mid))))
      (br $l)))
    (i32.const 0))
  (func $step
    (local $id i32) (local $p i32)
    (local.set $p (global.get $pc))
    (global.set $curpc (local.get $p))
    (call $trace (local.get $p))
    (if (i32.and (local.get $p) (i32.const 1)) (then (call $trap) (return)))
    (local.set $p (i32.and (local.get $p) (i32.const 0xFFFFFF)))
    ;; a bank a mapper re-based (or gave to backup RAM) no longer holds the
    ;; code the ROM arms were compiled from: the arms compiled for what the
    ;; reference ran there, else the interpreter
    (block $alt
    (if (i32.and (i32.or (global.get $remapped) (i32.ge_u (local.get $p) (i32.const ${ROMSIZE}))) (i32.lt_u (local.get $p) (i32.const 0x400000)))
      (then (if (i32.or (i32.ge_u (local.get $p) (i32.const ${ROMSIZE}))
                        (i32.ne (call $cartmap (local.get $p)) (i32.and (i32.and (local.get $p) (i32.const 0x3F0000)) (i32.const ${ROMSIZE - 1}))))
              (then${cartHardware(img)?.realtec ? `
                ;; the Realtec boot ROM is ROM $7E000-$7FFFF: code at those pcs is the ROM's own
                (if (i32.eqz (i32.and (i32.eq (call $cartmap (local.get $p)) (i32.const -4))
                                      (i32.eq (i32.and (local.get $p) (i32.const ${(ROMSIZE - 1) & ~0x1fff})) (i32.const 0x7E000))))
                  (then (local.set $id (call $alt_id (local.get $p))) (br $alt)))` : `
                ;; a mirror pc the reference was not seen running falls back to the ROM arm
                (local.set $id (call $alt_id (local.get $p)))
                (br_if $alt (i32.or (local.get $id) (i32.ne (call $cartmap (local.get $p)) (i32.and (i32.and (local.get $p) (i32.const 0x3F0000)) (i32.const ${ROMSIZE - 1})))))`}))))
    (if (i32.lt_u (local.get $p) (i32.const ${Math.max(0x400000, ROMSIZE > 0x400000 ? Math.min(ROMSIZE, 0xa00000) : 0x400000)}))
      (then (local.set $id (i32.load (i32.add (i32.const ${PCTAB})
              (i32.shl (i32.shr_u (i32.and (local.get $p) (i32.const ${ROMSIZE - 1})) (i32.const 1)) (i32.const 2))))))
      (else (if (i32.ge_u (local.get $p) (i32.const 0xE00000))
        (then (local.set $id (i32.load (i32.add (i32.const ${PCTAB + ROMWORDS * 4})
                (i32.shl (i32.shr_u (i32.and (local.get $p) (i32.const 0xFFFF)) (i32.const 1)) (i32.const 2))))))))))
    (if (i32.eqz (local.get $id)) (then${INTERP ? " (global.set $steps (i32.add (global.get $steps) (i32.const 1)))" : ""} ${FALLBACK} (return)))
    (local.set $id (i32.sub (local.get $id) (i32.const 1)))
    (global.set $steps (i32.add (global.get $steps) (i32.const 1)))
`;
  yield `    (call_indirect (type $shardT) (i32.and (local.get $id) (i32.const ${SH - 1})) ` +
    `(i32.shr_u (local.get $id) (i32.const ${Math.log2(SH)}))))\n`;
  yield `  (type $shardT (func (param i32)))\n  (type $voidT (func))\n  (table ${nsh + znames.length} funcref)\n` +
    `  (elem (i32.const 0) ` + Array.from({ length: nsh }, (_, i) => `$shard${i}`).join(" ") + ")\n" +
    `  (elem (i32.const ${nsh}) ` + znames.map((n) => `$z_${n}`).join(" ") + ")\n";
  // ---- packed pc -> arm id table
  const ents = new Uint8Array(narms * 8);
  const dv = new DataView(ents.buffer);
  arms.forEach(([idx], k) => {
    dv.setUint32(k * 8, idx, true);
    dv.setUint32(k * 8 + 4, k + 1, true);
  });
  yield `  (data (i32.const ${PACKED}) "${watBytes(ents)}")\n`;
  if (altPcs.length) {
    const at = new Uint8Array(altPcs.length * 4);
    const adv = new DataView(at.buffer);
    altPcs.forEach((pc, j) => adv.setUint32(j * 4, pc, true));
    yield `  (data (i32.const ${ALTTAB}) "${watBytes(at)}")\n`;
  }
  for (const [off, b] of tabsegs) yield `  (data (i32.const ${off}) "${watBytes(b)}")\n`;
  yield `  (data (i32.const ${ROMIMG}) "${watBytes(ROMDATA)}")\n`;
  const frameText = frameWat(narms, PACKED, PCTAB, img, ROMSIZE, SRAM.bank, EEP, !!SVPAT).replace("(call $initmap)", `(call $initmap) (i32.store (i32.const ${STATE + 0xf4}) (i32.const ${tracebuf}))`);
  yield AUDIO ? hookFrameWat(frameText, { abi: ABI, base: SND }) : frameText;
  // the SVP unit last: its table follows the dispatch table (index 0)
  if (SVPAT) yield svpWat(SVPAT.base, { romimg: ROMIMG, romsize: ROMSIZE, broken: !!opts.svpBreak }) + "\n";
  yield ")\n";
  if (breakAt !== null && !broken) throw new Error(`genesis recompile: options.breakArm $${breakAt.toString(16)} is not an instruction address of this cart`);
  if (opts.stats) Object.assign(opts.stats, { arms: narms, lowered: narms - bad, trapped: bad, shards: nsh, ramCodeArms: narms - Math.ceil(img.length / 2), ramInterpreter: INTERP,
    ...(traced ? { ramTrace: { frames: traced.frames, instructions: traced.instructions, executedRamPcs: traced.windows.size, guardedVariants: ramVariantCount, recaptured: traced.recaptured, remappedPcs: traced.remap.size } } : {}),
    ...(broken ? { brokenArms: broken } : {}) });
  if (opts.onProgress) opts.onProgress(`genesis: ${narms} arms (${bad} untranslated)`);
}

/**
 * options.breakArm (DEBUG / MUST-FAIL CONTROL): the arm at this 68000 address
 * also flips bit 0 of d0 after it runs, so an instruction-level differ must
 * name exactly this instruction. Pick a straight-line instruction.
 * @param {unknown} v  a number or "$1234" / "0x1234" / "1234" hex
 * @returns {number|null}
 */
function parseBreakArm(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/^\$|^0x/i, ""), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff || (n & 1)) throw new Error(`genesis recompile: options.breakArm must be an even 68000 address, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * One arm for a work RAM word with several candidate encodings (see emitWat):
 * each variant is guarded by the RAM words its translation fetched and, when
 * the candidates disagree on it, the full 32-bit pc; the first match runs.
 * Duplicate encodings collapse; no match runs `fallback` (the interpreter).
 * @param {object} D gpgx data
 * @param {{pc:number, f16:(p:number)=>number, source:string}[]} variants
 * @param {string} [fallback]
 */
function guardedRamArm(D, variants, fallback = "(call $trap)") {
  const pcs = new Set(variants.map((v) => v.pc));
  const seen = new Set();
  const parts = [];
  let nlocals = 0;
  const ramWord = (p) => `(i32.or (i32.shl (i32.load8_u (i32.const ${p & 0xffff})) (i32.const 8)) (i32.load8_u (i32.const ${(p + 1) & 0xffff})))`;
  for (const v of variants) {
    const fetched = new Map();
    const fx = (p) => { const w = v.f16(p); fetched.set(p >>> 0, w); return w; };
    let body;
    // first with the extension words read from work RAM when the arm runs
    // (routines whose operands the game patches between calls): guarded by
    // the opcode word alone; if the handler needs one of them constant, the
    // words it was compiled from guard it instead
    const op = v.f16(v.pc);
    if (op <= 0xffff) {
      try {
        const r = translateM68k(D.m68k, op, v.pc, (p) => ((p >>> 0) === (v.pc >>> 0) ? op : ramWord(p)));
        if (r.nlocals > nlocals) nlocals = r.nlocals;
        const key = `${pcs.size > 1 ? v.pc : ""}|op:${op}`;
        if (!seen.has(key)) {
          seen.add(key);
          const conds = [`(i32.eq ${ramWord(v.pc)} (i32.const ${op}))`];
          if (pcs.size > 1) conds.unshift(`(i32.eq (global.get $curpc) (i32.const ${v.pc | 0}))`);
          parts.push(`(if ${conds.reduce((acc, c) => (acc ? `(i32.and ${acc} ${c})` : c), "")} (then ${r.body} (return)))`);
        }
        continue;
      } catch (e) {
        if (!(e instanceof TrError)) throw e;
      }
    }
    try {
      const r = translateM68k(D.m68k, fx(v.pc), v.pc, fx);
      body = r.body;
      if (r.nlocals > nlocals) nlocals = r.nlocals;
    } catch (e) {
      if (!(e instanceof TrError)) throw e;
      continue;
    }
    if ([...fetched.values()].some((w) => w > 0xffff)) continue;
    const key = `${pcs.size > 1 ? v.pc : ""}|${[...fetched].sort((a, b) => a[0] - b[0]).map(([p, w]) => `${p & 0xffff}:${w}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const word = (p) => `(i32.or (i32.shl (i32.load8_u (i32.const ${p & 0xffff})) (i32.const 8)) (i32.load8_u (i32.const ${(p + 1) & 0xffff})))`;
    const conds = [...fetched].map(([p, w]) => `(i32.eq ${word(p)} (i32.const ${w}))`);
    if (pcs.size > 1) conds.unshift(`(i32.eq (global.get $curpc) (i32.const ${v.pc | 0}))`);
    const guard = conds.reduce((acc, c) => (acc ? `(i32.and ${acc} ${c})` : c), "");
    parts.push(`(if ${guard} (then ${body} (return)))`);
  }
  parts.push(fallback);
  return { body: parts.join("\n    "), nlocals };
}

/**
 * One arm for a pc in a cartridge bank the reference ran re-based: each
 * variant is guarded by what the banks it fetched from map to now ($cartmap:
 * the ROM offset it was compiled from) or, for backup RAM, by the backup RAM
 * words it was compiled from. No match runs `fallback` (the interpreter).
 * @param {object} D gpgx data
 * @param {{pc:number, f16:(p:number)=>number, source:string, bank:number, b?:number, n?:number}[]} variants
 * @param {string} [fallback]
 */
function guardedAltArm(D, variants, fallback = "(call $trap)") {
  const seen = new Set();
  const parts = [];
  let nlocals = 0;
  for (const v of variants) {
    const fetched = new Map();
    const fx = (p) => { const w = v.f16(p); fetched.set(p >>> 0, w); return w; };
    let body;
    try {
      const r = translateM68k(D.m68k, fx(v.pc), v.pc, fx);
      body = r.body;
      if (r.nlocals > nlocals) nlocals = r.nlocals;
    } catch (e) {
      if (!(e instanceof TrError)) throw e;
      continue;
    }
    if ([...fetched.values()].some((w) => w > 0xffff)) continue;
    const banks = new Set([...fetched.keys()].map((p) => (p >>> 16) & 0x3f));
    let conds;
    if (v.source === "boot") {
      conds = [...banks].map((bk) => `(i32.eq (i32.load (i32.const ${RT.CARTMAP + bk * 4})) (i32.const -4))`);
    } else if (v.source === "remap") {
      conds = [...banks].map((bk) => `(i32.eq (i32.load (i32.const ${RT.CARTMAP + bk * 4})) (i32.const ${bk === v.bank ? v.b : v.n}))`);
    } else {
      const word = (p) => `(i32.or (i32.load8_u (i32.const ${RT.SRAMBUF + (p & 0xffff)})) (i32.shl (i32.load8_u (i32.const ${RT.SRAMBUF + ((p + 1) & 0xffff)})) (i32.const 8)))`;
      conds = [...[...banks].map((bk) => `(i32.lt_s (i32.load (i32.const ${RT.CARTMAP + bk * 4})) (i32.const 0))`),
        ...[...fetched].map(([p, w]) => `(i32.eq ${word(p)} (i32.const ${w}))`)];
    }
    const key = conds.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const guard = conds.reduce((acc, c) => (acc ? `(i32.and ${acc} ${c})` : c), "");
    parts.push(`(if ${guard} (then ${body} (return)))`);
  }
  parts.push(fallback);
  return { body: parts.join("\n    "), nlocals };
}

/**
 * options.traceEntries: the $trace body with the registers. Called at the top
 * of $step (the state the instruction starts from, as gpgx's dispatch hook
 * sees it) and for interrupt-entry events (bit 31, skipped by the reader).
 * @param {number} tracebuf
 * @param {number} entries
 */
function regTraceWat(tracebuf, entries) {
  const regs = Array.from({ length: 16 }, (_, i) => `
        (i32.store offset=${16 + 4 * i} (local.get $e) (global.get $r${i}))`).join("");
  return ` (local $e i32)
    (if (i32.load (i32.const ${STATE + 0xF8}))
      (then
        (local.set $e (i32.add (i32.const ${tracebuf}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 7))))
        (i32.store (local.get $e) (local.get $p))
        (i32.store offset=4 (local.get $e) (global.get $mc))
        (i32.store offset=8 (local.get $e) (global.get $refresh))
        (i32.store offset=12 (local.get $e) (global.get $mcend))${regs}
        (i32.store offset=80 (local.get $e) (call $get_sr))
        (i32.store (i32.const ${STATE + 0xFC}) (i32.and (i32.add (i32.load (i32.const ${STATE + 0xFC})) (i32.const 1)) (i32.const ${entries - 1}))))))`;
}

function frameWat(narms, PACKED, PCTAB, img, ROMSIZE, sramBank, eep, svp = false) {
  // system_frame_gen runs the SVP after each line's 68000 and Z80
  const SVPL = svp ? "\n    (call $svp_line)" : "";
  return `
  ;; m68k_run: interrupt check on entry, bus refresh before each instruction,
  ;; and the one-instruction IRQ latency of m68k_set_irq_delay.
  (func $m68k_run (param $target i32)
    (local $ir2 i32) (local $b2 i32)
    (if (i32.ge_u (global.get $mc) (local.get $target)) (then (return)))
    (call $check_int)
    (if (global.get $stopped) (then (global.set $mc (local.get $target)) (return)))
    (global.set $mcend (local.get $target))
    (block $d (loop $l
      (br_if $d (i32.ge_u (global.get $mc) (local.get $target)))
      (br_if $d (global.get $trapped))
      (if (i32.ge_s (global.get $mc) (global.get $refresh))
        (then (global.set $refresh (i32.add (global.get $mc) (i32.const 896)))
              (global.set $mc (i32.add (global.get $mc) (i32.const 14)))))
      (call $step)
      (if (global.get $irqdelay)
        (then
          (global.set $irqdelay (i32.const 0))
          (global.set $irqlat (i32.const 1))
          (local.set $ir2 (call $raw16 (global.get $pc)))
          (local.set $b2 (i32.mul (i32.load8_u (i32.add (i32.const ${CYCTAB}) (local.get $ir2))) (i32.const 7)))
          (call $step)
          (global.set $mc (i32.sub (global.get $mc) (local.get $b2)))
          (global.set $irqlat (i32.const 0))
          (call $set_irq (global.get $irqdelay_lv))
          (call $check_int)
          (global.set $mc (i32.add (global.get $mc) (local.get $b2)))))
      (br $l))))

  ;; system_frame_gen
  (func $frame
    (local $line i32) (local $old i32) (local $b i32) (local $p i32)
    (global.set $mcvdp (i32.const 0))
    (i32.store (i32.const ${FIFO + 16}) (i32.const 0)) (i32.store (i32.const ${FIFO + 20}) (i32.const 0))
    (i32.store (i32.const ${FIFO + 24}) (i32.const 0)) (i32.store (i32.const ${FIFO + 28}) (i32.const 0))
    (if (i32.and (global.get $vp_changed) (i32.const 2))
      (then
        (local.set $old (global.get $v_interlaced))
        (global.set $v_interlaced (i32.shr_u (i32.and ${R(12)} (i32.const 2)) (i32.const 1)))
        (if (i32.ne (local.get $old) (global.get $v_interlaced))
          (then (global.set $v_im2 (i32.eq (i32.and ${R(12)} (i32.const 6)) (i32.const 6)))
                (global.set $v_odd_frame (global.get $v_interlaced))
                (global.set $vp_changed (i32.const 5)))
          (else (global.set $vp_changed (i32.and (global.get $vp_changed) (i32.const -3)))))
        (if (i32.and ${R(1)} (i32.const 4))
          (then (global.set $vp_h (select (i32.const 240) (i32.const 224) (i32.and ${R(1)} (i32.const 8)))))
          (else (global.set $vp_h (i32.const 192))))
        (global.set $vp_w (i32.add (i32.const 256) (i32.shl (i32.and ${R(12)} (i32.const 1)) (i32.const 6))))
        (if (i32.ne (global.get $vp_h) (global.get $vp_oh))
          (then (global.set $vp_oh (global.get $vp_h))
                (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 1)))))))
    (global.set $v_status (i32.and (global.get $v_status) (i32.const 0xFEED)))
    (global.set $v_status (i32.or (global.get $v_status) (i32.const 8)))
    (if (global.get $v_interlaced)
      (then (global.set $v_odd_frame (i32.xor (global.get $v_odd_frame) (i32.const 1)))
            (global.set $v_status (i32.or (global.get $v_status) (i32.shl (global.get $v_odd_frame) (i32.const 4))))))
    (if (global.get $v_dma_length) (then (call $dma_update (i32.const 0))))
    (if (i32.eqz (global.get $v_h_counter))
      (then (global.set $v_hint_pending (i32.const 0x10))
            (if (i32.and ${R(0)} (i32.const 0x10)) (then (call $update_irq (i32.const 4))))))
    (call $input_refresh)${eep && eep.jcart ? " (call $jpad_refresh)" : ""}
    ;; osd_input_update: the pad state the game sees for this whole frame,
    ;; both ports (wasmcart pads 0 and 1)
    (global.set $pad0 (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 0)}))))
    (global.set $pad1 (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 1)}))))${eep && eep.jcart ? `
    ;; J-Cart pads 3 and 4: wasmcart pads 2 and 3
    (global.set $pad2 (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 2)}))))
    (global.set $pad3 (call $pad_bits (i32.load16_u (i32.const ${padAddr(INPUT, 3)}))))` : ""}
    (if (i32.ne (global.get $v_v_counter) (global.get $vp_h))
      (then
        (global.set $v_v_counter (global.get $vp_h))
        (call $m68k_run (global.get $v_vint_cycle))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (global.get $v_vint_cycle))))
        (global.set $v_status (i32.or (global.get $v_status) (i32.const 0x80)))
        (global.set $v_vint_pending (i32.const 0x20))
        (if (i32.and ${R(1)} (i32.const 0x20))
          (then (call $set_irq (i32.const 6))
                (global.set $nvint (i32.add (global.get $nvint) (i32.const 1)))))
        (i32.store8 (i32.const ${ZREGS + 61}) (i32.const 1))))
    (call $m68k_run (i32.const 3420))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.const 3420))))${SVPL}
    (i32.store8 (i32.const ${ZREGS + 61}) (i32.const 0))
    (global.set $mcvdp (i32.const 3420))
    (local.set $line (i32.add (global.get $vp_h) (i32.const 1)))
    (block $d (loop $l
      (global.set $v_v_counter (local.get $line))
      (call $input_refresh)${eep && eep.jcart ? " (call $jpad_refresh)" : ""}
      (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))${SVPL}
      (global.set $mcvdp (i32.add (global.get $mcvdp) (i32.const 3420)))
      (local.set $line (i32.add (local.get $line) (i32.const 1)))
      (br_if $l (i32.lt_s (local.get $line) (i32.const ${(palTiming(img) ? 313 : 262) - 1})))))
    (global.set $v_v_counter (local.get $line))
    (global.set $v_h_counter ${R(10)})
    (global.set $v_status (i32.and (global.get $v_status) (i32.const -9)))
    (if (global.get $v_dma_length) (then (call $dma_update (global.get $mcvdp))))
    (if (i32.and ${R(1)} (i32.const 0x40)) (then (call $parse_satb_any (i32.const -1))))
    (call $input_refresh)${eep && eep.jcart ? " (call $jpad_refresh)" : ""}
    (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))${SVPL}
    (global.set $mcvdp (i32.add (global.get $mcvdp) (i32.const 3420)))
    (local.set $line (i32.const 0))
    (block $d (loop $l
      (global.set $v_v_counter (local.get $line))
      (if (global.get $v_dma_length) (then (call $dma_update (global.get $mcvdp))))
      (call $render_line (local.get $line))
      (call $input_refresh)${eep && eep.jcart ? " (call $jpad_refresh)" : ""}
      (if (i32.eqz (global.get $v_h_counter))
        (then (global.set $v_h_counter ${R(10)})
              (global.set $v_hint_pending (i32.const 0x10))
              (if (i32.and ${R(0)} (i32.const 0x10))
                (then (call $update_irq (i32.const 4))
                      (global.set $nhint (i32.add (global.get $nhint) (i32.const 1))))))
        (else (global.set $v_h_counter (i32.sub (global.get $v_h_counter) (i32.const 1)))))
      (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))${SVPL}
      (global.set $mcvdp (i32.add (global.get $mcvdp) (i32.const 3420)))
      (local.set $line (i32.add (local.get $line) (i32.const 1)))
      (br_if $l (i32.lt_s (local.get $line) (global.get $vp_h)))))
    (if (i32.ne (global.get $vp_w) (global.get $vp_ow))
      (then (global.set $vp_ow (global.get $vp_w))
            (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 1)))))
    ;; input_end_frame: TH switching latency carries into the next frame
    (if (i32.gt_s (global.get $th0_lat) (global.get $mcvdp))
      (then (global.set $th0_lat (i32.sub (global.get $th0_lat) (global.get $mcvdp))))
      (else (global.set $th0_lat (i32.const 0))))
    (if (i32.gt_s (global.get $th1_lat) (global.get $mcvdp))
      (then (global.set $th1_lat (i32.sub (global.get $th1_lat) (global.get $mcvdp))))
      (else (global.set $th1_lat (i32.const 0))))${eep && eep.jcart ? `
    (if (i32.gt_s (i32.load (i32.const ${RT.JPADS + 4})) (global.get $mcvdp))
      (then (i32.store (i32.const ${RT.JPADS + 4}) (i32.sub (i32.load (i32.const ${RT.JPADS + 4})) (global.get $mcvdp))))
      (else (i32.store (i32.const ${RT.JPADS + 4}) (i32.const 0))))
    (if (i32.gt_s (i32.load (i32.const ${RT.JPADS + 20})) (global.get $mcvdp))
      (then (i32.store (i32.const ${RT.JPADS + 20}) (i32.sub (i32.load (i32.const ${RT.JPADS + 20})) (global.get $mcvdp))))
      (else (i32.store (i32.const ${RT.JPADS + 20}) (i32.const 0))))` : ""}
    (i32.store (i32.const ${ZREGS + 64}) (i32.sub (i32.load (i32.const ${ZREGS + 64})) (global.get $mcvdp)))
    ;; sound_update: run FM to the frame end; timers and BUSY carry over
    (call $fm_update (global.get $mcvdp))
    (global.set $fm_count (i32.sub (global.get $fm_count) (global.get $mcvdp)))
    (if (i32.gt_u (global.get $fm_busy) (global.get $mcvdp))
      (then (global.set $fm_busy (i32.sub (global.get $fm_busy) (global.get $mcvdp))))
      (else (global.set $fm_busy (i32.const 0))))
    (global.set $refresh (i32.sub (global.get $refresh) (global.get $mcvdp)))
    (global.set $mc (i32.sub (global.get $mc) (global.get $mcvdp)))
    (global.set $v_dma_end (i32.const 0))
    (global.set $frames (i32.add (global.get $frames) (i32.const 1))))

  ;; wasmcart buttons (by position) -> gpgx INPUT_* as its libretro port maps
  ;; the RetroPad: south B, east C, west A; 6-button pads add L X, north Y,
  ;; R Z, SELECT MODE
  (func $pad_bits (param $b i32) (result i32)
    (local $p i32)
    (if (i32.and (local.get $b) (i32.const 0x100)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x01)))))
    (if (i32.and (local.get $b) (i32.const 0x200)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x02)))))
    (if (i32.and (local.get $b) (i32.const 0x400)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x04)))))
    (if (i32.and (local.get $b) (i32.const 0x800)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x08)))))
    (if (i32.and (local.get $b) (i32.const 0x001)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x10)))))
    (if (i32.and (local.get $b) (i32.const 0x002)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x20)))))
    (if (i32.and (local.get $b) (i32.const 0x004)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x40)))))
    (if (i32.and (local.get $b) (i32.const 0x040)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x80)))))${sixButtonPads(img) ? `
    (if (i32.and (local.get $b) (i32.const 0x010)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x400)))))
    (if (i32.and (local.get $b) (i32.const 0x008)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x200)))))
    (if (i32.and (local.get $b) (i32.const 0x020)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x100)))))
    (if (i32.and (local.get $b) (i32.const 0x080)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x800)))))` : ""}
    (local.get $p))

  (func $initmap
    (local $i i32) (local $p i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${narms})))
      (local.set $p (i32.add (i32.const ${PACKED}) (i32.shl (local.get $i) (i32.const 3))))
      (i32.store (i32.add (i32.const ${PCTAB}) (i32.shl (i32.load (local.get $p)) (i32.const 2)))
                 (i32.load (i32.add (local.get $p) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.const ${ABI + 0}) (i32.const ${WC_ABI_VERSION}))
    (i32.store (i32.const ${ABI + 4}) (i32.const ${FB_W}))
    (i32.store (i32.const ${ABI + 8}) (i32.const 224))
    (i32.store (i32.const ${ABI + 12}) (i32.const ${FB}))
    (i32.store (i32.const ${ABI + 16}) (i32.const 0))
    (i32.store (i32.const ${ABI + 20}) (i32.const 0))
    (i32.store (i32.const ${ABI + 24}) (i32.const ${ABI + 256}))
    (i32.store (i32.const ${ABI + 28}) (i32.const ${INPUT}))
    (i32.store (i32.const ${ABI + 40}) (i32.const ${ABI + 0x180}))
    (i32.const ${ABI}))

  ;; power on: gen_reset(1) + vdp_reset + io_reset + m68k_pulse_reset
  (func (export "wc_init")
    (local $i i32)
    (call $initmap)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${FB_W * FB_H})))
      (i32.store (i32.add (i32.const ${FB}) (i32.shl (local.get $i) (i32.const 2))) (i32.const 0xFF000000))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 256)))
      (i32.store (i32.add (i32.const ${PIXEL}) (i32.shl (local.get $i) (i32.const 2))) (i32.const 0xFF000000))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $region (i32.const ${regionCode(img)}))
${RT.cartInitWat(ROMSIZE, sramBank, eep && eep.eeprom ? null : sramConfig(img), !!cartHardware(img)?.realtec)}${eep ? RT.eepromInitWat(eep) : ""}${svp ? `    ;; svp_init: DRAM in banks $30-$31, the cell arrange reads in $39-$3A; svp_reset
    (i32.store (i32.const ${RT.CARTMAP + 0x30 * 4}) (i32.const ${SVP_DRAM})) (i32.store (i32.const ${RT.CARTMAP + 0x31 * 4}) (i32.const ${SVP_DRAM}))
    (i32.store (i32.const ${RT.CARTMAP + 0x39 * 4}) (i32.const ${SVP_CELL})) (i32.store (i32.const ${RT.CARTMAP + 0x3a * 4}) (i32.const ${SVP_CELL}))
    (call $svp_power_on)
` : ""}    (call $vdp_reset)
    (call $io_reset)
    (global.set $zstate (i32.const 0))
    (global.set $zmap (i32.const 0))
    (global.set $zbank (i32.const 0))
    (call $z80_init)
    (call $z80_reset)
    ;; gen_reset: ((lines - 192 + 159 - 27 on PAL) lines + 1004) master cycles, rounded to 7
    (global.set $mc (i32.const ${Math.floor((((palTiming(img) ? 313 : 262) - 192 + 159 - (palTiming(img) ? 27 : 0)) * 3420 + 1004) / 7) * 7}))
    (global.set $stopped (i32.const 0))
    (global.set $ft1 (i32.const 0))
    (global.set $imask (i32.const 0x700))
    (global.set $ilevel (i32.const 0))
    (call $set_s_flag (i32.const 4))
    (global.set $r15 (call $rd32 (i32.const 0)))
    (global.set $pc (call $rd32 (i32.const 4)))
    (global.set $mc (i32.add (global.get $mc) (i32.const 280)))
    (global.set $refresh (i32.add (i32.mul (i32.div_s (global.get $mc) (i32.const 896)) (i32.const 896)) (i32.const 896)))
    (global.set $trapped (i32.const 0)))

  (func (export "wc_render")
    (local $i i32)
    (call $frame)
    ;; the picture is as tall as the active display (224, or 240 in V30 mode)
    ;; the active height: 224 or 240 (Mode 5), 192 (Mode 4)
    (i32.store (i32.const ${ABI + 8}) (global.get $vp_h))
    ;; state block for the differ (all little-endian u32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 16)))
      (i32.store (i32.add (i32.const ${STATE}) (i32.shl (local.get $i) (i32.const 2)))
        (call $getreg (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store (i32.const ${STATE + 64}) (global.get $pc))
    (i32.store (i32.const ${STATE + 68}) (call $get_sr))
    (i32.store (i32.const ${STATE + 72}) (global.get $mc))
    (i32.store (i32.const ${STATE + 76}) (global.get $refresh))
    (i32.store (i32.const ${STATE + 80}) (global.get $ilevel))
    (i32.store (i32.const ${STATE + 84}) (global.get $stopped))
    (i32.store (i32.const ${STATE + 88}) (global.get $v_status))
    (i32.store (i32.const ${STATE + 92}) (global.get $frames))
    (i32.store (i32.const ${STATE + 96}) (global.get $trapped))
    (i32.store (i32.const ${STATE + 100}) (global.get $trappc))
    (i32.store (i32.const ${STATE + 104}) (global.get $nlock))
    (i32.store (i32.const ${STATE + 108}) (global.get $lockpc))
    (i32.store (i32.const ${STATE + 112}) (global.get $nz80r))
    (i32.store (i32.const ${STATE + 116}) (global.get $z80rpc))
    (i32.store (i32.const ${STATE + 120}) (global.get $ymread))
    (i32.store (i32.const ${STATE + 124}) (global.get $nm4))
    (i32.store (i32.const ${STATE + 128}) (global.get $nim2))
    (i32.store (i32.const ${STATE + 132}) (global.get $steps))
    (i32.store (i32.const ${STATE + 136}) (global.get $nvint))
    (i32.store (i32.const ${STATE + 140}) (global.get $nhint))
    (i32.store (i32.const ${STATE + 144}) (global.get $ndma))
    (i32.store (i32.const ${STATE + 148}) (global.get $zstate))
    (i32.store (i32.const ${STATE + 152}) (global.get $v_v_counter))
    (i32.store (i32.const ${STATE + 156}) (global.get $sp0))
    (i32.store (i32.const ${STATE + 160}) (global.get $sp4))
    (i32.store (i32.const ${STATE + 164}) (global.get $fx))
    (i32.store (i32.const ${STATE + 168}) (global.get $fn))
    (i32.store (i32.const ${STATE + 172}) (global.get $fz))
    (i32.store (i32.const ${STATE + 176}) (global.get $fv))
    (i32.store (i32.const ${STATE + 180}) (global.get $fc))
    (i32.store (i32.const ${STATE + 184}) (global.get $imask))
    (i32.store (i32.const ${STATE + 188}) (global.get $fs)))

  (func $getreg (param $i i32) (result i32)
    (block $b15 (block $b14 (block $b13 (block $b12 (block $b11 (block $b10 (block $b9 (block $b8
    (block $b7 (block $b6 (block $b5 (block $b4 (block $b3 (block $b2 (block $b1 (block $b0
      (br_table $b0 $b1 $b2 $b3 $b4 $b5 $b6 $b7 $b8 $b9 $b10 $b11 $b12 $b13 $b14 $b15 (local.get $i)))
      (return (global.get $r0))) (return (global.get $r1))) (return (global.get $r2))) (return (global.get $r3)))
      (return (global.get $r4))) (return (global.get $r5))) (return (global.get $r6))) (return (global.get $r7)))
      (return (global.get $r8))) (return (global.get $r9))) (return (global.get $r10))) (return (global.get $r11)))
      (return (global.get $r12))) (return (global.get $r13))) (return (global.get $r14))) (global.get $r15))
`;
}
