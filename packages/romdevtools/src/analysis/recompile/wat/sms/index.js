// SMS / Game Gear WAT backend: statically recompile a whole Sega Master
// System or Game Gear ROM into a wasmcart whose machine model follows
// genesis_plus_gx (the core the carts are verified against through romdev).
//
//   CPU    z80.js    every ROM byte offset is an entry point: one dispatch
//                    arm per (bank, address) in the paged windows, so a
//                    computed jump can never land somewhere uncompiled.
//                    Instructions come from romdev's own Z80 IR decode
//                    (irRecords, all alignments), in process.
//   TIMING cycles.js per-instruction T-states; a scanline is 228 T and the
//                    frame starts at line 192 as gpgx's system_frame_sms does.
//   VIDEO  hw.js     Mode 4 VDP, rendered line by line between CPU runs.
//   AUDIO  hw.js     SN76489 into the wasmcart ring at 48 kHz.
//
// Mapper, slot-1 paging and RAM-resident code are derived from the ROM where
// possible (see describe()); the rest are documented options.
//
// Ported from sms-wat src/emit_bank.py (the path its verified SMS and GG
// carts are built with) plus the modules it imports. The emitted WAT equals
// the Python emitter's after comment/whitespace normalisation.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { cost, costExact } from "./cycles.js";
import { lower, flagHelpersWat, m1Count, rIncWat } from "./z80.js";
import { hwWat, renderWat, psgWat, miscWat, cramBody, startBody, ggLutBytes, hcounterBytes, hcolBytes, VRAM, CRAM, VREG, GGLUT, PROBE, PCWATCH, SMSFB, LINEPROBE, HCTAB, HCOLTAB } from "./hw.js";
import { watBytes } from "../cart-abi.js";
import { emitFlatWat } from "./flat.js";

export const platforms = ["sms", "gg"];
export const REFERENCE_CORE = "genesis_plus_gx";

/** Register file mirrored into the probe block at the end of each frame (bytes from PROBE+48). */
const REG_PROBE = ["a", "f", "b", "c", "d", "e", "h", "l", "ixh", "ixl", "iyh", "iyl", "rreg", "ireg", "iff", "halted"];
const REG_PROBE_BASE = 48;

/** Z80 T-states genesis_plus_gx lets pass in frame 1 before the first instruction (NTSC hard reset). */
const RESET_T = Math.floor(Math.floor(((262 - 192 + 159) * 3420 + 1004) / 7) * 7 / 15);

/** Arms per dispatch shard (a single giant br_table blows V8's compiler zone). */
const SHARD_SZ = 1024;
/** options.traceEntries: the register ring's entry size, its maximum length, and where its base is published. */
const BIGRING_STRIDE = 32;
const BIGRING_MAX = 65536;
const BIGRING_BASE_PROBE = 112;

// ---------------------------------------------------------------------------
// ROM facts

function toBytes(rom) {
  if (rom instanceof Uint8Array) return rom;
  if (Buffer.isBuffer(rom)) return new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength);
  return new Uint8Array(rom);
}

function countPattern(img, pat, end = img.length) {
  let n = 0;
  outer: for (let i = 0; i + pat.length <= end; i++) {
    for (let k = 0; k < pat.length; k++) if (img[i + k] !== pat[k]) continue outer;
    n++;
  }
  return n;
}

/** The 'TMR SEGA' header, if present: {offset, regionCode}. */
function segaHeader(img) {
  for (const base of [0x7FF0, 0x3FF0, 0x1FF0]) {
    if (base + 16 > img.length) continue;
    if (Buffer.from(img.subarray(base, base + 8)).toString("latin1") === "TMR SEGA") {
      return { offset: base, regionCode: img[base + 15] >> 4 };
    }
  }
  return null;
}

/**
 * Header-derived configuration. Every per-game fact the Python pipeline kept
 * in a config file is derived here, and each can be overridden in `opts`.
 *
 *   platform     opts.platform, else the .gg/.sms extension of opts.romPath,
 *                else the header region code (5-7 = Game Gear).
 *   mapper       'codemasters' when the Codemasters header checksum pair at
 *                $7FE6/$7FE8 sums to $10000; 'korean-a000' when bank 0
 *                stores to $A000 and never to $FFFF; else 'sega'.
 *   pagesSlot1   whether the ROM contains a direct store to the slot-1 page
 *                register $FFFE (ld ($FFFE),a / ld ($FFFE),hl /
 *                ld ($FFFD),hl, ED and DD/FD 16-bit forms). A cart that pages
 *                slot 1 needs per-bank arms for $4000-$7FFF. A false
 *                positive only costs arms (bank 1 stays mapped); a false
 *                negative runs the wrong bank's code, so the scan errs wide.
 *
 * Options (all optional):
 *   platform: 'sms'|'gg'
 *   mapper: 'sega'|'codemasters'|'korean-a000'
 *   pagesSlot1: boolean
 *   slot1Bank: number        bank in slot 1 before the cart writes $FFFE (1)
 *   ramRegions: [{cpu, bytes, bank?, romOffset?, src?}]
 *                            RAM-resident code compiled as arms. src:'snapshot'
 *                            takes the bytes from a RAM snapshot; otherwise
 *                            they are relocated ROM bytes at romOffset.
 *   ramSnapshot: path | Uint8Array
 *                            8KB system RAM dump for snapshot regions
 *   ramSnapshotFrame: number capture the snapshot from the reference core
 *                            itself: loadMedia + this many frames, then
 *                            system_ram. Implies a whole-RAM snapshot region
 *                            ($C000, 8KB) when ramRegions is not given.
 *   probeRegs: boolean      mirror the Z80 register file into the probe block
 *                            each frame (default true)
 *   region: 'export'|'japan' console region (GG port $00 bit 6, SMS I/O port
 *                            mirrors); default from the header region code
 *   legacy: boolean          reproduce sms-wat's emit_bank.py module exactly
 *                            (interrupts sampled only at scanline starts, no
 *                            register probe); for the differential gate.
 *   ramCode: true | false | {frames, input}
 *                            DEFAULT (option absent, banked emitter, ROM on
 *                            disk, no ramRegions / ramSnapshot*): AUTOMATIC.
 *                            The reference runs 3000 frames from power-on
 *                            with no input; if it executes any RAM pc, the
 *                            cart is built as with ramCode:true, otherwise
 *                            exactly as without it. false turns that off.
 *                            true / {frames, input}:
 *                            DISCOVER RAM-resident code from the reference
 *                            itself: run it `frames` frames from power-on
 *                            (default 3000) on the `input` schedule, record
 *                            every RAM pc it executes and every encoding seen
 *                            there, and compile each as a guarded variant (a
 *                            RAM instruction the discovery never saw traps
 *                            instead of running stale bytes). Implies a
 *                            whole-RAM region ($C000, 8KB).
 *   traceEntries: number     ALSO record a whole-frame instruction ring WITH
 *                            the Z80 registers for findDiverge
 *                            level:'instruction' (a power of two, 1024 to
 *                            65536; a frame runs ~5,000-15,000 instructions,
 *                            so 16384 or more holds one): 32 bytes per
 *                            instruction {pc | line<<16, AF | BC<<16,
 *                            DE | HL<<16, IX | IY<<16, SP | R<<16,
 *                            AF' | BC'<<16, DE' | HL'<<16, I} after the ring
 *                            the default build keeps, base at probe +112.
 *                            Off by default: the default module is unchanged.
 *                            Banked emitter only.
 *   breakArm: number         DEBUG / MUST-FAIL CONTROL: every arm at this Z80
 *                            address also flips bit 0 of A after it runs, so
 *                            an instruction-level differ must name exactly
 *                            this instruction. Pick a straight-line
 *                            instruction; the section carries a warning.
 *   emitter: 'banked'|'flat' 'banked' (default) is the full model: paged
 *                            windows, scanline budget carry, line interrupts.
 *                            'flat' is sms-wat's older emitter for carts of
 *                            32KB or less (no mapper, IRQ at line 192 only),
 *                            kept so a cart built with it can be reproduced.
 *
 * @param {Uint8Array} rom
 * @param {object} [opts]
 */
export function describe(rom, opts = {}) {
  const img = toBytes(rom);
  const hdr = segaHeader(img);
  let platform = opts.platform === "gg" || opts.platform === "sms" ? opts.platform : null;
  if (!platform && typeof opts.romPath === "string") {
    if (/\.gg$/i.test(opts.romPath)) platform = "gg";
    else if (/\.sms$/i.test(opts.romPath)) platform = "sms";
  }
  if (!platform) platform = hdr && hdr.regionCode >= 5 && hdr.regionCode <= 7 ? "gg" : "sms";

  const supported = img.length >= 0x2000 && img.length % 0x2000 === 0 && img.length <= 0x400000;
  const nbank = Math.floor(img.length / 0x4000);

  const cmHeader = img.length >= 0x8000 &&
    ((img[0x7FE6] | (img[0x7FE7] << 8)) + (img[0x7FE8] | (img[0x7FE9] << 8))) === 0x10000;
  const bank0 = img.subarray(0, Math.min(0x4000, img.length));
  const koreanStores = countPattern(bank0, [0x32, 0x00, 0xA0]);
  const segaStores = countPattern(bank0, [0x32, 0xFF, 0xFF]);
  let mapper = cmHeader ? "codemasters" : (koreanStores > 0 && segaStores === 0) ? "korean-a000" : "sega";
  const mapperEvidence = { codemastersHeader: cmHeader, bank0StoresA000: koreanStores, bank0StoresFFFF: segaStores };
  if (opts.mapper) mapper = opts.mapper;
  if (!["sega", "codemasters", "korean-a000"].includes(mapper)) throw new Error(`sms recompile: unknown mapper '${mapper}' (sega, codemasters, korean-a000)`);

  const slot1Pats = [[0x32, 0xFE, 0xFF], [0x22, 0xFE, 0xFF], [0x22, 0xFD, 0xFF]];
  for (const o of [0x43, 0x53, 0x63, 0x73]) slot1Pats.push([0xED, o, 0xFE, 0xFF], [0xED, o, 0xFD, 0xFF]);
  for (const p of [0xDD, 0xFD]) slot1Pats.push([p, 0x22, 0xFE, 0xFF], [p, 0x22, 0xFD, 0xFF]);
  const slot1Stores = slot1Pats.reduce((a, p) => a + countPattern(img, p), 0);
  const pagesSlot1 = typeof opts.pagesSlot1 === "boolean" ? opts.pagesSlot1 : slot1Stores > 0;

  let ramRegions = Array.isArray(opts.ramRegions) ? opts.ramRegions.map((r) => ({ bank: 0, romOffset: 0, ...r })) : [];
  if (!ramRegions.length && (Number.isInteger(opts.ramSnapshotFrame) || opts.ramCode)) {
    ramRegions = [{ cpu: 0xC000, bytes: 0x2000, bank: 0, romOffset: 0, src: "snapshot" }];
  }
  for (const r of ramRegions) {
    if (!(Number.isInteger(r.cpu) && r.cpu >= 0xC000 && r.cpu <= 0xFFFF && Number.isInteger(r.bytes) && r.bytes > 0)) {
      throw new Error(`sms recompile: ramRegions entry needs cpu in $C000-$FFFF and a positive byte count: ${JSON.stringify(r)}`);
    }
  }

  // Region as genesis_plus_gx picks it for a cart missing from its database:
  // a missing header or a Japanese region code runs as a Japanese console.
  const region = opts.region === "japan" || opts.region === "export" ? opts.region
    : (!hdr || hdr.regionCode === 3 || hdr.regionCode === 5) ? "japan" : "export";
  const emitter = opts.emitter || "banked";
  if (emitter !== "banked" && emitter !== "flat") throw new Error(`sms recompile: emitter must be 'banked' or 'flat', got '${emitter}'`);
  if (emitter === "flat" && (img.length > 0x8000 || ramRegions.length)) throw new Error("sms recompile: emitter 'flat' handles unbanked carts of 32KB or less with no RAM code");
  const traceEntries = opts.traceEntries == null ? null : opts.traceEntries;
  if (traceEntries != null) {
    if (!Number.isInteger(traceEntries) || traceEntries < 1024 || traceEntries > BIGRING_MAX || (traceEntries & (traceEntries - 1))) {
      throw new Error(`sms recompile: options.traceEntries must be a power of two from 1024 to ${BIGRING_MAX}, got ${opts.traceEntries}`);
    }
    if (emitter === "flat") throw new Error("sms recompile: options.traceEntries needs the banked emitter");
  }

  return {
    platform,
    referenceCore: REFERENCE_CORE,
    emitter,
    region,
    legacy: opts.legacy === true,
    traceEntries,
    breakArm: parseBreakArm(opts.breakArm),
    probeRegs: opts.probeRegs !== false && opts.legacy !== true,
    supported,
    unsupportedReason: supported ? null : `ROM size ${img.length} is not a multiple of 8KB up to 4MB`,
    romBytes: img.length,
    banks: nbank,
    header: hdr,
    mapper,
    mapperEvidence,
    pagesSlot1,
    slot1StoreSites: slot1Stores,
    slot1Bank: Number.isInteger(opts.slot1Bank) ? opts.slot1Bank : 1,
    ramRegions,
    ramSnapshot: typeof opts.ramSnapshot === "string" ? opts.ramSnapshot
      : opts.ramSnapshot ? `${opts.ramSnapshot.length} bytes` : Number.isInteger(opts.ramSnapshotFrame) ? `reference frame ${opts.ramSnapshotFrame}` : null,
    screen: platform === "gg" ? { width: 160, height: 144, origin: [48, 24] } : { width: 256, height: 192, origin: [0, 0] },
  };
}

// ---------------------------------------------------------------------------
// Instruction index: file offset -> [length, "mnemonic ops"] from romdev's own
// Z80 IR decode (every byte offset, all alignments).

const HEXOP = /0x([0-9a-fA-F]+)/g;

/** Operand spelling the lowering expects: $XXXX/$XX data, Lxxxxxx for control-flow targets. */
function normOps(ops, r) {
  if (!ops) return ops;
  const ctrl = r.kind === "branch" || r.kind === "call" || r.kind === "jump" || r.kind === "ret" ||
    (Array.isArray(r.targets) && r.targets.length > 0) || r.mnemonic === "rst";
  return ops.replace(HEXOP, (_m, h) => {
    const v = parseInt(h, 16);
    if (ctrl) return "L" + v.toString(16).toUpperCase().padStart(6, "0");
    return "$" + v.toString(16).toUpperCase().padStart(h.length > 2 ? 4 : 2, "0");
  });
}

/**
 * @param {Uint8Array} bytes
 * @param {'sms'|'gg'} platform
 * @returns {Promise<Map<number, [number, string]>>}
 */
export async function instructionIndex(bytes, platform) {
  const { irPlan, irRecords, newIrStats } = await import("../../export-z80-ir.js");
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { isa, windows } = irPlan(buf, { platform, allOffsets: true });
  const st = newIrStats();
  const idx = new Map();
  for await (const r of irRecords(buf, isa, windows, { wantAllAlignments: true, st })) {
    if (r.decodeStatus !== "decoded") {
      const b = r.bytes || [];
      idx.set(r.off, [Math.max(1, b.length), b.length ? "defb $" + b[0].toString(16).toUpperCase().padStart(2, "0") : "defb $00"]);
      continue;
    }
    const ops = normOps(r.ops || "", r);
    idx.set(r.off, [r.len, ops ? `${r.mnemonic} ${ops}`.trim() : r.mnemonic]);
  }
  if (idx.size < bytes.length - st.unresolvedOffsets) {
    throw new Error(`sms recompile: IR decode left ${bytes.length - idx.size} offsets without a record; refusing a partial index (each hole would be a silent trap)`);
  }
  return { idx, stats: st };
}

// ---------------------------------------------------------------------------
// Instruction length (block sizes), from genesis_plus_gx's cycle tables' shape.

const MAIN_EXTRA = new Uint8Array(256);
const XY_EXTRA = new Uint8Array(256);
for (let o = 0; o < 256; o++) {
  const x = o >> 6, y = (o >> 3) & 7, z = o & 7, q = y & 1, p = y >> 1;
  let n = 0;
  if (x === 0) {
    if (z === 0 && y >= 2) n = 1;
    else if (z === 1 && q === 0) n = 2;
    else if (z === 2 && p >= 2) n = 2;
    else if (z === 6) n = 1;
  } else if (x === 3) {
    if (z === 2 || z === 4) n = 2;
    else if (z === 3 && y === 0) n = 2;
    else if (z === 3 && (y === 2 || y === 3)) n = 1;
    else if (z === 5 && q === 1 && p === 0) n = 2;
    else if (z === 6) n = 1;
  }
  MAIN_EXTRA[o] = n;
  n = 0;
  if (x === 0) {
    if (z === 1 && q === 0 && p === 2) n = 2;
    else if (z === 2 && p === 2) n = 2;
    else if ((z === 4 || z === 5) && y === 6) n = 1;
    else if (z === 6 && y === 6) n = 2;
    else if (z === 6) n = 1;
  } else if (x === 1 && (y === 6 || z === 6)) n = 1;
  else if (x === 2 && z === 6) n = 1;
  XY_EXTRA[o] = n;
}

/** Length of the instruction at img[i], or -1 when its opcode bytes run past the end. */
export function z80Length(img, i) {
  const n = img.length;
  const op = img[i];
  if (op === 0xCB) return i + 1 < n ? 2 : -1;
  if (op === 0xED) {
    if (i + 1 >= n) return -1;
    return (img[i + 1] & 0xC7) === 0x43 ? 4 : 2;
  }
  if (op === 0xDD || op === 0xFD) {
    if (i + 1 >= n) return -1;
    const op2 = img[i + 1];
    if (op2 === 0xCB) return i + 3 < n ? 4 : -1;
    return 2 + XY_EXTRA[op2];
  }
  return 1 + MAIN_EXTRA[op];
}

/**
 * Every arm: [key, cpuAddress, bank, size], sorted by key, where key is the
 * address for slot 0 (and slot 1 when it is not paged) and
 * bank*0x10000+address for the paged windows.
 */
export function fullBlocks(img, pagesSlot1) {
  const nbank = Math.floor(img.length / 0x4000);
  const blocks = new Map();
  for (let addr = 0; addr < 0x4000; addr++) {
    if (addr >= img.length) break;
    const ln = z80Length(img, addr);
    if (ln > 0) blocks.set(addr, [addr, addr, 0, ln]);
  }
  if (pagesSlot1) {
    for (let bank = 0; bank < nbank; bank++) {
      for (let addr = 0x4000; addr < 0x8000; addr++) {
        const off = bank * 0x4000 + (addr - 0x4000);
        if (off >= img.length) continue;
        const ln = z80Length(img, off);
        if (ln > 0) blocks.set(bank * 0x10000 + addr, [bank * 0x10000 + addr, addr, bank, ln]);
      }
    }
  } else {
    for (let addr = 0x4000; addr < 0x8000; addr++) {
      if (addr >= img.length) break;
      const ln = z80Length(img, addr);
      if (ln > 0) blocks.set(addr, [addr, addr, 0, ln]);
    }
  }
  for (let bank = 0; bank < nbank; bank++) {
    for (let addr = 0x8000; addr < 0xC000; addr++) {
      const off = bank * 0x4000 + (addr - 0x8000);
      if (off >= img.length) continue;
      const ln = z80Length(img, off);
      if (ln > 0) blocks.set(bank * 0x10000 + addr, [bank * 0x10000 + addr, addr, bank, ln]);
    }
  }
  return [...blocks.values()].sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------
// Linear memory layout, computed from the arm count, ROM size and bank count
// so growth cannot silently alias one region into another.

function align(x, a = 0x10000) { return Math.ceil(x / a) * a; }

/**
 * @param {number} narms
 * @param {number} romLen
 * @param {number} nbank
 * @param {boolean} pagesSlot1
 */
export function computeLayout(narms, romLen, nbank, pagesSlot1) {
  const g = {};
  g.ABI = 0xA0000;
  g.FB = 0xA1000;
  g.TRACE = g.FB + 0x30000;
  g.AUDIO = g.TRACE + 0x8000;
  g.ROMIMG = align(g.AUDIO + 0xB000);
  // Cart SRAM: two 16KB banks, mapped over $8000-$BFFF or $C000-$FFFF by the
  // $FFFC control byte (bit 3 replaces system RAM at $C000).
  g.CARTRAM = align(g.ROMIMG + romLen);
  g.BTAB = align(g.CARTRAM + 0x8000);
  g.BMAP0 = align(g.BTAB + narms * 4);
  // BMAP0 serves $0000-$7FFF when slot 1 is not paged, so it needs 0x8000
  // entries then.
  g.BMAPP = align(g.BMAP0 + (pagesSlot1 ? 0x4000 : 0x8000) * 4);
  g.BMAP1 = align(g.BMAPP + nbank * 0x4000 * 4);
  g.BMAPR = align(g.BMAP1 + (pagesSlot1 ? nbank * 0x4000 * 4 : 4));
  g.TOP = align(g.BMAPR + 0x2000 * 4);
  return g;
}

// ---------------------------------------------------------------------------
// The module

/**
 * Automatic RAM-code discovery applies when the caller said nothing about RAM
 * code (ramCode absent, no ramRegions / ramSnapshot / ramSnapshotFrame), the
 * ROM is on disk, and the build is the default banked, non-legacy model.
 * @param {object} opts
 * @param {ReturnType<typeof describe>} cfg
 */
function autoRamEligible(opts, cfg) {
  return opts.ramCode === undefined && !opts.ramRegions && opts.ramSnapshot == null && opts.ramSnapshotFrame == null
    && typeof opts.romPath === "string" && cfg.emitter === "banked" && !cfg.legacy;
}

/**
 * options.breakArm as a Z80 address (a number or "$1234" / "0x1234" / "1234" hex).
 * @param {unknown} v
 * @returns {number|null}
 */
function parseBreakArm(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/^\$|^0x/i, ""), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFF) throw new Error(`sms recompile: options.breakArm must be a Z80 address, got ${JSON.stringify(v)}`);
  return n;
}

/**
 * options.traceEntries: one 32-byte entry per dispatched instruction, at the
 * same point as the default ring (after the interrupt check, before the arm
 * runs), so the registers are the state the instruction starts from - what
 * genesis_plus_gx's trace records at its dispatch hook.
 * @param {number} base
 * @param {number} entries
 * @returns {string[]}
 */
function bigRingWat(base, entries) {
  const pair = (hi, lo) => `(i32.or (i32.shl (global.get $${hi}) (i32.const 8)) (global.get $${lo}))`;
  const two = (lo, hi) => `(i32.or ${lo} (i32.shl ${hi} (i32.const 16)))`;
  const st = (off, v) => `      (i32.store (i32.add (local.get $tr) (i32.const ${off})) ${v})`;
  return [
    `      (local.set $tr (i32.add (i32.const ${base}) (i32.shl (i32.and (global.get $tracei) (i32.const ${entries - 1})) (i32.const 5))))`,
    "      (i32.store (local.get $tr) (i32.or (global.get $pc) (i32.shl (global.get $line) (i32.const 16))))",
    st(4, two(pair("a", "f"), pair("b", "c"))),
    st(8, two(pair("d", "e"), pair("h", "l"))),
    st(12, two(pair("ixh", "ixl"), pair("iyh", "iyl"))),
    st(16, two("(global.get $sp)", "(global.get $rreg)")),
    st(20, two(pair("a2", "f2"), pair("b2", "c2"))),
    st(24, two(pair("d2", "e2"), pair("h2", "l2"))),
    st(28, "(global.get $ireg)"),
  ];
}

/** Mapper / paging / RAM-code WAT pieces for the memory accessors. */
function bankHelpersWat(G, cfg, nbank) {
  const { ROMIMG, CARTRAM, BMAP0, BMAPP, BMAP1, BMAPR } = G;
  const NBANK = nbank;
  const SLOT1_BANK = cfg.slot1Bank;
  const SLOT1_LOOKUP = cfg.pagesSlot1
    ? `(i32.load (i32.add (i32.const ${BMAP1}) ` +
      "(i32.mul (i32.add (i32.mul (global.get $bank1) (i32.const 0x4000)) " +
      "(i32.sub (local.get $a) (i32.const 0x4000))) (i32.const 4))))"
    : `(i32.load (i32.add (i32.const ${BMAP0}) ` +
      "(i32.mul (local.get $a) (i32.const 4))))";
  // Korean A000: a write to $A000 selects the page at $8000-$BFFF. Below $C000,
  // so it is handled before the "ROM is read-only" early return.
  const KOREAN_A000_WAT = cfg.mapper === "korean-a000" ? `    (if (i32.eq (local.get $a) (i32.const 0xA000))
      (then (global.set $bank2
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))
            (return)))
` : "";
  // RAM PCs resolve through their own 8KB map, only when the cart has RAM code.
  const RAMMAP_LOOKUP = cfg.ramRegions.length ? `    (if (i32.ge_u (local.get $a) (i32.const 0xC000))
      (then (return (i32.load (i32.add (i32.const ${BMAPR})
        (i32.mul (i32.and (local.get $a) (i32.const 0x1FFF)) (i32.const 4)))))))
` : "";
  let CODEMASTERS_WAT = "", SLOT0_READ;
  if (cfg.mapper === "codemasters") {
    // Codemasters: page registers at $0000/$4000/$8000 select slots 0/1/2,
    // and the first 1KB of slot 0 stays pinned to bank 0 (the vectors).
    CODEMASTERS_WAT = `    (if (i32.eq (local.get $a) (i32.const 0x0000))
      (then (global.set $bank0
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))
            (return)))
    (if (i32.eq (local.get $a) (i32.const 0x4000))
      (then (global.set $bank1
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))
            (return)))
    (if (i32.eq (local.get $a) (i32.const 0x8000))
      (then (global.set $bank2
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))
            (return)))
`;
    SLOT0_READ = `    (if (i32.ge_u (local.get $a) (i32.const 0x400))
      (then (return (i32.load8_u (i32.add (i32.const ${ROMIMG})
        (i32.add (i32.mul (global.get $bank0) (i32.const 0x4000))
                 (local.get $a)))))))
    (i32.load8_u (i32.add (i32.const ${ROMIMG}) (local.get $a))))`;
  } else {
    SLOT0_READ = `    (i32.load8_u (i32.add (i32.const ${ROMIMG}) (local.get $a))))`;
  }
  return `
  (global $bank2 (mut i32) (i32.const 0))
  (global $bank1 (mut i32) (i32.const ${SLOT1_BANK}))
  (global $bank0 (mut i32) (i32.const 0))
  (global $carry (mut i32) (i32.const 0))
  (global $eiarm (mut i32) (i32.const 0))${cfg.legacy ? "" : "\n  (global $eidelay (mut i32) (i32.const 0))"}
  (global $ctl (mut i32) (i32.const 0))

  (func $rd8 (param $addr i32) (result i32)
    (local $a i32)
    (local.set $a (i32.and (local.get $addr) (i32.const 0xFFFF)))
    (if (i32.ge_u (local.get $a) (i32.const 0xC000))
      (then
        (if (i32.and (global.get $ctl) (i32.const 0x08))
          (then (return (i32.load8_u (i32.add (i32.const ${CARTRAM})
            (i32.or (i32.and (local.get $a) (i32.const 0x3FFF))
                    (i32.shl (i32.and (i32.shr_u (global.get $ctl) (i32.const 2))
                                      (i32.const 1)) (i32.const 14))))))))
        (return (i32.load8_u
          (i32.or (i32.and (local.get $a) (i32.const 0x1FFF)) (i32.const 0xC000))))))
    (if (i32.ge_u (local.get $a) (i32.const 0x8000))
      (then (return (i32.load8_u (i32.add (i32.const ${ROMIMG})
        (i32.add (i32.mul (global.get $bank2) (i32.const 0x4000))
                 (i32.sub (local.get $a) (i32.const 0x8000))))))))
    (if (i32.ge_u (local.get $a) (i32.const 0x4000))
      (then (return (i32.load8_u (i32.add (i32.const ${ROMIMG})
        (i32.add (i32.mul (global.get $bank1) (i32.const 0x4000))
                 (i32.sub (local.get $a) (i32.const 0x4000))))))))
${SLOT0_READ}

  (func $wr8 (param $addr i32) (param $v i32)
    (local $a i32)
    (local.set $a (i32.and (local.get $addr) (i32.const 0xFFFF)))
${KOREAN_A000_WAT}${CODEMASTERS_WAT}
    (if (i32.lt_u (local.get $a) (i32.const 0xC000)) (then (return)))
    (if (i32.eq (local.get $a) (i32.const 0xFFFF))
      (then (global.set $bank2
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))))
    (if (i32.eq (local.get $a) (i32.const 0xFFFE))
      (then (global.set $bank1
              (i32.rem_u (i32.and (local.get $v) (i32.const 0xFF))
                         (i32.const ${NBANK})))))
    (if (i32.eq (local.get $a) (i32.const 0xFFFC))
      (then (global.set $ctl (i32.and (local.get $v) (i32.const 0xFF)))))
    (if (i32.and (global.get $ctl) (i32.const 0x08))
      (then
        (i32.store8 (i32.add (i32.const ${CARTRAM})
          (i32.or (i32.and (local.get $a) (i32.const 0x3FFF))
                  (i32.shl (i32.and (i32.shr_u (global.get $ctl) (i32.const 2))
                                    (i32.const 1)) (i32.const 14))))
                    (i32.and (local.get $v) (i32.const 0xFF)))
        (return)))
    (i32.store8 (i32.or (i32.and (local.get $a) (i32.const 0x1FFF)) (i32.const 0xC000))
                (i32.and (local.get $v) (i32.const 0xFF))))

  (func $rd16 (param $addr i32) (result i32)
    (i32.or (call $rd8 (local.get $addr))
            (i32.shl (call $rd8 (i32.add (local.get $addr) (i32.const 1))) (i32.const 8))))
  (func $wr16 (param $addr i32) (param $v i32)
    (call $wr8 (local.get $addr) (i32.and (local.get $v) (i32.const 0xFF)))
    (call $wr8 (i32.add (local.get $addr) (i32.const 1)) (i32.shr_u (local.get $v) (i32.const 8))))

  (func $push16 (param $v i32)
    (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (call $wr16 (global.get $sp) (local.get $v)))
  (func $pop16 (result i32)
    (local $v i32)
    (local.set $v (call $rd16 (global.get $sp)))
    (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (local.get $v))

  (func $pop16_logged (param $frompc i32) (result i32) (call $pop16))

  (func $blockid (param $pc i32) (result i32)
    (local $a i32)
    (local.set $a (i32.and (local.get $pc) (i32.const 0xFFFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0x4000))
      (then (return (i32.load
        (i32.add (i32.const ${BMAP0}) (i32.mul (local.get $a) (i32.const 4)))))))
    (if (i32.lt_u (local.get $a) (i32.const 0x8000))
      (then (return ${SLOT1_LOOKUP})))
    (if (i32.lt_u (local.get $a) (i32.const 0xC000))
      (then (return (i32.load (i32.add (i32.const ${BMAPP})
        (i32.mul (i32.add (i32.mul (global.get $bank2) (i32.const 0x4000))
                          (i32.sub (local.get $a) (i32.const 0x8000)))
                 (i32.const 4)))))))
${RAMMAP_LOOKUP}    (i32.const 0))
`;
}

/** Block maps init, CRAM->RGBA present, the wasmcart ABI exports and wc_render's frame loop. */
function abiWat(G, cfg, n, platform) {
  const { ABI, FB, AUDIO, TRACE, BTAB, BMAP0, BMAPP, BMAP1, BMAPR } = G;
  const CRAMBODY = cramBody(platform, CRAM);
  const STARTBTN = startBody(platform);
  const RAMMAP_STORE = cfg.ramRegions.length ? `      (if (i32.ge_u (local.get $a) (i32.const 0xC000))
        (then (i32.store (i32.add (i32.const ${BMAPR})
                 (i32.mul (i32.and (local.get $a) (i32.const 0x1FFF)) (i32.const 4)))
                           (i32.add (local.get $i) (i32.const 1)))))
` : "";
  const SLOT1_STORE = cfg.pagesSlot1
    ? `(i32.store (i32.add (i32.const ${BMAP1}) ` +
      "(i32.mul (i32.add (i32.mul (local.get $bk) (i32.const 0x4000)) " +
      "(i32.sub (local.get $a) (i32.const 0x4000))) (i32.const 4))) " +
      "(i32.add (local.get $i) (i32.const 1)))"
    : `(i32.store (i32.add (i32.const ${BMAP0}) ` +
      "(i32.mul (local.get $a) (i32.const 4))) " +
      "(i32.add (local.get $i) (i32.const 1)))";
  // Z80 register file + unspent line budget at the end of each frame, so a
  // per-frame differ can compare the CPU against the reference core's.
  // gpgx latches a line interrupt that falls exactly on an instruction
  // boundary (no overshoot carried into the line) after the NEXT instruction.
  const HINT_EDGE = cfg.legacy ? "" : `              (if (i32.and (i32.eqz (global.get $carry))
                           (i32.ne (i32.and (call $vreg (i32.const 0)) (i32.const 0x10)) (i32.const 0)))
                (then (global.set $carry (i32.sub (call $run (i32.const 1)) (i32.const 1)))))
`;
  // Legacy model: interrupts sampled only here, at the start of each line.
  // Otherwise $run samples them before every instruction.
  // gpgx: a status read in the overshoot past line 192 already took the flag.
  const VINT_SET = cfg.legacy ? `      (if (i32.eq (local.get $ln) (i32.const 192))
        (then (global.set $vdp_status
                (i32.or (global.get $vdp_status) (i32.const 0x80)))))` : `      (if (i32.and (i32.eq (local.get $ln) (i32.const 192)) (i32.eqz (global.get $vintdone)))
        (then (global.set $vdp_status
                (i32.or (global.get $vdp_status) (i32.const 0x80)))))`;
  const FRAME_START = cfg.legacy ? "" : "    (global.set $vintdone (i32.const 0))\n";
  // Power-on VDP state gpgx sets without a BIOS: R10 = $FF (line interrupt
  // off), the line counter $FF, and R0-R6 as its boot-ROM stand-in writes.
  const POWER_ON = cfg.legacy ? "" : [
    ...(platform === "gg" ? [] : [[0, 0x36], [1, 0x80]]),
    [2, 0xFF], [3, 0xFF], [4, 0xFF], [5, 0xFF], [6, 0xFF], [10, 0xFF],
  ].map(([r, v]) => `    (i32.store8 (i32.const ${VREG + r}) (i32.const ${v}))\n`).join("") + "    (global.set $linectr (i32.const 0xFF))\n" +
    // gpgx hard reset (gen_reset): the CPU starts ((262 - 192 + 159) lines +
    // 1004) master cycles into the first frame, rounded to 7 then 15 master
    // cycles: 784170 = 52278 T after the frame's line-192 start. Carried as
    // debt so the first instruction runs at that point of frame 1.
    `    (global.set $carry (i32.const ${-RESET_T}))\n` +
    // Sega mapper reset (gpgx sms_cart_reset): slot 2 holds page 2 until the
    // cart writes $FFFF. Without a BIOS gpgx also leaves the memory-control
    // value $A8 at $C000 on a Master System, as the BIOS would.
    (cfg.mapper === "sega" ? `    (global.set $bank2 (i32.const ${2 % cfg.banks}))\n` : "") +
    (platform === "gg" ? "" : "    (i32.store8 (i32.const 0xC000) (i32.const 0xA8))\n");
  // gpgx reloads the line counter from R10 BEFORE line 261's CPU run, so a
  // write to R10 during that line takes effect a frame later.
  const RELOAD = `      (if (i32.eq (local.get $ln) (i32.const 261))
        (then (global.set $linectr (call $vreg (i32.const 10)))))
`;
  // ...and parses the sprites for line 0 then too (parse_satb(-1)).
  const RELOAD_BEFORE = cfg.legacy ? "" : RELOAD.replace("(then (global.set $linectr (call $vreg (i32.const 10)))))", "(then (global.set $linectr (call $vreg (i32.const 10))) (call $parse_satb (i32.const -1))))");
  const RELOAD_AFTER = cfg.legacy ? RELOAD : "";
  const RENDER_LINE = cfg.legacy ? `      (if (i32.lt_u (local.get $ln) (i32.const 192))
        (then (call $render_line (local.get $ln))))` : `      (if (i32.and (i32.lt_u (local.get $ln) (i32.const 192)) (i32.ne (local.get $ln) (global.get $earlyline)))
        (then (call $render_line (local.get $ln))))
      (global.set $earlyline (i32.const -1))`;
  const LINE_IRQ = cfg.legacy ? "      (call $irq_check)\n" : "";
  const REGPROBE = cfg.probeRegs === false ? "" : REG_PROBE.map((g, i) =>
    `    (i32.store8 (i32.const ${PROBE + REG_PROBE_BASE + i}) (global.get $${g}))\n`).join("") +
    `    (i32.store (i32.const ${PROBE + REG_PROBE_BASE + 16}) (global.get $carry))\n`;
  return `
  (func $blockmap_init
    (local $i i32) (local $a i32) (local $bk i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${n})))
      (local.set $a  (i32.load16_u (i32.add (i32.const ${BTAB}) (i32.mul (local.get $i) (i32.const 4)))))
      (local.set $bk (i32.load8_u  (i32.add (i32.const ${BTAB + 2}) (i32.mul (local.get $i) (i32.const 4)))))
      (if (i32.lt_u (local.get $a) (i32.const 0x4000))
        (then (i32.store (i32.add (i32.const ${BMAP0}) (i32.mul (local.get $a) (i32.const 4)))
                           (i32.add (local.get $i) (i32.const 1)))))
      (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x4000))
                   (i32.lt_u (local.get $a) (i32.const 0x8000)))
        (then ${SLOT1_STORE}))
${RAMMAP_STORE}      (if (i32.and (i32.ge_u (local.get $a) (i32.const 0x8000))
                   (i32.lt_u (local.get $a) (i32.const 0xC000)))
        (then (i32.store (i32.add (i32.const ${BMAPP})
                 (i32.mul (i32.add (i32.mul (local.get $bk) (i32.const 0x4000))
                                   (i32.sub (local.get $a) (i32.const 0x8000)))
                          (i32.const 4)))
                           (i32.add (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $cram_rgba (param $i i32) (result i32)
    (local $c i32) (local $r i32) (local $g i32) (local $b i32)
${CRAMBODY}
    (i32.or (i32.const 0xFF000000)
      (i32.or (i32.shl (local.get $r) (i32.const 16))
        (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))

  (func $present
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 49152)))
      (i32.store (i32.add (i32.const ${FB}) (i32.mul (local.get $i) (i32.const 4)))
        (call $cram_rgba (i32.load8_u (i32.add (i32.const ${SMSFB}) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const 3))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const 256))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const 192))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 16)) (i32.const ${AUDIO}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 20)) (i32.const 4096))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 24)) (i32.add (i32.const ${ABI}) (i32.const 256)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 28)) (i32.add (i32.const ${ABI}) (i32.const 288)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 32)) (i32.const 0))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 36)) (i32.const 0))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 40)) (i32.add (i32.const ${ABI}) (i32.const 320)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 44)) (i32.add (i32.const ${ABI}) (i32.const 352)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 48)) (i32.const 1))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 52)) (i32.const 48000))
    (i32.const ${ABI}))

  (func (export "wc_init")
    (call $blockmap_init)
    (global.set $bank2 (i32.const 0))
    (global.set $pc (i32.const 0))
    (global.set $sp (i32.const 0xDFF0))
${POWER_ON})

  (func $irq_line (result i32)
    (i32.and
      ${cfg.legacy ? `(i32.and (i32.ne (global.get $iff) (i32.const 0))
               (i32.ne (global.get $vdp_first) (i32.const 0)))` : "(i32.ne (global.get $iff) (i32.const 0))"}
      (i32.or
        (i32.and (i32.ne (i32.and (call $vreg (i32.const 1)) (i32.const 0x20)) (i32.const 0))
                 (i32.ne (i32.and (global.get $vdp_status) (i32.const 0x80)) (i32.const 0)))
        (i32.and (i32.ne (i32.and (call $vreg (i32.const 0)) (i32.const 0x10)) (i32.const 0))
                 (i32.ne (global.get $hintpend) (i32.const 0))))))
  (func $irq_check
    (if (call $irq_line)
      (then
        (global.set $irqs (i32.add (global.get $irqs) (i32.const 1)))
        (global.set $iff (i32.const 0))
        (global.set $halted (i32.const 0))
        (call $push16 (global.get $pc))
        (global.set $carry (i32.sub (global.get $carry) (i32.const 13)))
        (global.set $pc (i32.const 0x38)))))

  (func (export "wc_render")
    (local $ln i32) (local $btn i32) (local $k i32)
    (global.set $frames (i32.add (global.get $frames) (i32.const 1)))
    (local.set $btn (i32.load16_u (i32.add (i32.const ${ABI}) (i32.const 288))))
    (global.set $joy1 (i32.const 0xFF))
    (if (i32.and (local.get $btn) (i32.const 256))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFE)))))
    (if (i32.and (local.get $btn) (i32.const 512))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFD)))))
    (if (i32.and (local.get $btn) (i32.const 1024))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFB)))))
    (if (i32.and (local.get $btn) (i32.const 2048))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xF7)))))
    (if (i32.and (local.get $btn) (i32.const 1))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xEF)))))
    (if (i32.and (local.get $btn) (i32.const 2))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xDF)))))
${STARTBTN}
${FRAME_START}    (local.set $k (i32.const 0))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_u (local.get $k) (i32.const 262)))
      (local.set $ln (i32.rem_u (i32.add (local.get $k) (i32.const 192)) (i32.const 262)))
      (global.set $line (local.get $ln))
${RENDER_LINE}
      (if (i32.le_u (local.get $ln) (i32.const 192))
        (then
          (if (i32.eqz (global.get $linectr))
            (then
              (if (i32.lt_u (local.get $ln) (i32.const 192))
                (then (global.set $linectr (call $vreg (i32.const 10)))))
${HINT_EDGE}              (global.set $hintpend (i32.const 1)))
            (else
              (if (i32.lt_u (local.get $ln) (i32.const 192))
                (then (global.set $linectr
                        (i32.sub (global.get $linectr) (i32.const 1)))))))))
${LINE_IRQ}${RELOAD_BEFORE}      (global.set $carry (call $run (i32.add (i32.const 228) (global.get $carry))))
${RELOAD_AFTER}${VINT_SET}
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $fl)))
    (call $present)
    (call $psg_render)
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 0))  (global.get $frames))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 4))  (global.get $trapped))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 8))  (global.get $trappc))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 12)) (global.get $pc))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 16)) (global.get $vdpwn))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 20)) (global.get $irqs))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 24)) (global.get $vdp_status))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 28)) (global.get $sp))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 32)) (i32.const ${TRACE}))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 36)) (global.get $tracei))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 40)) (global.get $bank2))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 44)) (global.get $bank1))
${REGPROBE}${cfg.traceEntries ? `    (i32.store (i32.const ${PROBE + BIGRING_BASE_PROBE}) (i32.const ${G.BIGRING}))\n` : ""}  )

  (export "dbg_pc" (global $pc))
  (export "dbg_trapped" (global $trapped))
  (export "dbg_joy1" (global $joy1))
  (export "dbg_trappc" (global $trappc))
  (export "dbg_bank" (global $bank2))
  (export "dbg_irqs" (global $irqs))
  (export "dbg_iff" (global $iff))
  (export "dbg_ctl" (global $ctl))
  (export "dbg_line" (global $line))
  (export "dbg_vdpstatus" (global $vdp_status))
  (export "dbg_vdpfirst" (global $vdp_first))
  (export "dbg_vdplatch" (global $vdp_latch))
  (export "dbg_vdpwn" (global $vdpwn))
  (export "dbg_vdpcode" (global $vdp_code))
  (export "dbg_vdpaddr" (global $vdp_addr))
  (export "dbg_r1pc" (global $dbg_r1pc))
  (export "dbg_r1val" (global $dbg_r1val))
  (export "dbg_r1d" (global $dbg_r1d))
  (export "dbg_r1e" (global $dbg_r1e))
  (export "dbg_tracei" (global $tracei))
  (export "dbg_iyh" (global $iyh))
  (export "dbg_iyl" (global $iyl))
  (export "dbg_ixh" (global $ixh))
  (export "dbg_ixl" (global $ixl))
  (export "dbg_h" (global $h))
  (export "dbg_l" (global $l))
  (export "dbg_a" (global $a))
  (export "dbg_sp" (global $sp))
`;
}

// ---------------------------------------------------------------------------
// Arms

function charge(n) {
  return n ? `(local.set $budget (i32.sub (local.get $budget) (i32.const ${n})))` : "";
}

/** How control leaves an arm. `extra` = taken-minus-not-taken cost, charged on the branching path. */
function emitFlow(f, extra = 0) {
  switch (f.kind) {
    case "jp": return `    (global.set $pc (i32.const ${f.target}))`;
    case "jp_ind": return `    (global.set $pc ${f.expr})`;
    case "jp_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (global.set $pc (i32.const ${f.target})))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "call": return `    (call $push16 (i32.const ${f.ret}))\n` +
      `    (global.set $pc (i32.const ${f.target}))`;
    case "call_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (call $push16 (i32.const ${f.ret}))\n` +
      `            (global.set $pc (i32.const ${f.target})))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "ret": return "    (global.set $pc (call $pop16))";
    case "ret_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (global.set $pc (call $pop16)))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "halt": return `    (global.set $pc (i32.const ${f.target !== undefined ? f.target : f.next}))`;
    default: throw new Error(`sms recompile: unknown flow kind ${f.kind}`);
  }
}

/** Python str.split(None, 1): first whitespace-separated token and the rest. */
function splitMnem(s) {
  const t = s.replace(/^\s+/, "");
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  return m ? [m[1], m[2] || ""] : ["", ""];
}

const IN_OPS = new Set(["in", "ini", "ind", "inir", "indr"]);
const REL_OP = /(L[0-9A-Fa-f]{6}|\$[0-9A-Fa-f]{4})/g;
const ED_TEXT = new Set(["ldir", "lddr", "cpir", "cpdr", "otir", "otdr", "inir", "indr", "ldi", "ldd", "cpi", "cpd",
  "outi", "outd", "ini", "ind", "neg", "im", "reti", "retn", "rld", "rrd"]);

/** Snapshot operand (pseudo-ROM at 0) -> its RAM address. */
function rebaseSnap(ops) {
  ops = ops.replace(/L([0-9A-Fa-f]{6})/g, (m, h) => { const v = parseInt(h, 16); return v < 0x2000 ? "L" + (v + 0xC000).toString(16).toUpperCase().padStart(6, "0") : m; });
  return ops.replace(/\$([0-9A-Fa-f]{4})/g, (m, h) => { const v = parseInt(h, 16); return v < 0x2000 ? "$" + (v + 0xC000).toString(16).toUpperCase().padStart(4, "0") : m; });
}

class Emitter {
  /**
   * @param {Uint8Array} img
   * @param {object} cfg describe() result
   * @param {Map<number, [number, string]>} idx ROM instruction index
   * @param {{bytes: Uint8Array, idx: Map<number, [number, string]>}[]} snaps RAM snapshots, decoded
   * @param {Set<number>|null} executed RAM pcs the reference executed (ramCode discovery)
   */
  constructor(img, cfg, idx, snaps, executed) {
    this.img = img;
    this.cfg = cfg;
    this.idx = idx;
    this.snaps = snaps;
    this.snapIdx = snaps.length ? snaps[0].idx : new Map();
    this.ramSnap = snaps.length ? snaps[0].bytes : null;
    this.executed = executed;
    this.unsupported = 0;
    this.missing = 0;
    this.ramVariants = 0;
  }

  /** Z80 address + bank -> ROM file offset, or null when unmappable. */
  fileOff(addr, bank) {
    if (addr >= 0xC000) {
      // RAM-resident code: through the region table (first match).
      for (const r of this.cfg.ramRegions) {
        if (r.cpu <= addr && addr < r.cpu + r.bytes) return r.romOffset + (addr - r.cpu);
      }
      return null;
    }
    if (addr < 0x4000) return addr;
    if (addr < 0x8000) return this.cfg.pagesSlot1 ? bank * 0x4000 + (addr - 0x4000) : this.cfg.slot1Bank * 0x4000 + (addr - 0x4000);
    return bank * 0x4000 + (addr - 0x8000);
  }

  romByte(addr, bank, k) {
    const f = this.fileOff(addr, bank);
    if (f === null) return null;
    const off = f + k;
    return off >= 0 && off < this.img.length ? this.img[off] : null;
  }

  /**
   * RAM-resident code (exact mode): one guarded variant per distinct
   * encoding the reference was seen executing at this address (or the
   * snapshot's, for an address never executed during discovery). The guard
   * compares the live RAM bytes with the variant's; code the discovery never
   * saw traps loudly instead of running stale bytes.
   */
  ramArm(addr, bank, snapoff) {
    const off = snapoff & 0x1FFF;
    const which = this.executed && this.executed.has(addr) ? this.snaps : this.snaps.slice(0, 1);
    const seen = new Set();
    const variants = [];
    for (const sn of which) {
      const ent = sn.idx.get(off);
      if (!ent) continue;
      const n = ent[0];
      const bytes = Array.from({ length: n }, (_, k) => (off + k < sn.bytes.length ? sn.bytes[off + k] : 0));
      const key = bytes.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({ n, text: ent[1], bytes });
    }
    if (!variants.length) { this.missing++; return "    (call $trap)"; }
    this.ramVariants += variants.length;
    const parts = [];
    for (const v of variants) {
      const mn0 = splitMnem(v.text)[0];
      const txt = (mn0 === "jr" || mn0 === "djnz") ? rebaseSnap(v.text) : v.text;
      const guard = v.bytes.map((b, k) => `(i32.eq (call $rd8 (i32.const ${(addr + k) & 0xFFFF})) (i32.const ${b}))`)
        .reduce((acc, g) => (acc ? `(i32.and ${acc} ${g})` : g), "");
      const body = this.body(addr, bank, v.n, [[addr, v.n, txt]], (k) => v.bytes[k] ?? null, v.bytes[0]);
      parts.push(`    (if ${guard}\n      (then\n${body}\n      (return (local.get $budget))))`);
    }
    parts.push("    (call $trap)");
    return parts.join("\n");
  }

  /** WAT body of the arm at (addr, bank). */
  arm(addr, bank, size) {
    let snapoff = null;
    if (addr >= 0xC000 && this.ramSnap) {
      for (const r of this.cfg.ramRegions) {
        if (r.src === "snapshot" && r.cpu <= addr && addr < r.cpu + r.bytes) { snapoff = addr - 0xC000; break; }
      }
    }
    if (snapoff !== null && !this.cfg.legacy) return this.ramArm(addr, bank, snapoff);
    let ins;
    if (snapoff !== null) {
      const ent = this.snapIdx.get(snapoff);
      if (!ent) { this.missing++; return "    (call $trap)"; }
      const mn0 = splitMnem(ent[1])[0];
      // The pseudo-ROM decodes at 0, so relative targets are rebased into RAM;
      // absolute operands are real CPU addresses in the bytes already.
      const txt = (mn0 === "jr" || mn0 === "djnz") ? rebaseSnap(ent[1]) : ent[1];
      ins = [[addr, ent[0], txt]];
    } else {
      const off = this.fileOff(addr, bank);
      const ent = off === null ? undefined : this.idx.get(off);
      if (!ent) { this.missing++; return "    (call $trap)"; }
      ins = [[off, ent[0], ent[1]]];
    }
    return this.body(addr, bank, size, ins, (k) => this.romByte(addr, bank, k), snapoff === null ? undefined : null);
  }

  /**
   * Lower `ins` ([[fileOffset|addr, length, text]]) as one arm.
   * @param {(k: number) => number|null} byteAt  byte k of the instruction (relative-branch displacement, prefix)
   * @param {number|null|undefined} b0  first opcode byte when known (null = judge the prefix from the text)
   */
  body(addr, bank, size, ins, byteAt, b0Known) {
    const base = ins[0][0];
    const parts = [];
    for (const [a, n, s] of ins) {
      const za = addr + (a - base);
      let [mn, ops] = splitMnem(s);
      // Relative branches: the target is (next instruction) + the displacement
      // byte, recomputed from the encoding rather than trusting any window base.
      if ((mn === "jr" || mn === "djnz") && n >= 2) {
        const d = byteAt(n - 1);
        if (d !== null) {
          const t = (za + n + (d > 127 ? d - 256 : d)) & 0xFFFF;
          ops = ops.replace(REL_OP, "L" + t.toString(16).toUpperCase().padStart(6, "0"));
        }
      }
      const costOf = this.cfg.legacy ? cost : costExact;
      const ci = Math.max(1, costOf(mn, ops)[1]);
      if (parts.length) {
        parts.push("    (if (i32.le_s (local.get $budget) (i32.const 0)) " +
          `(then (global.set $pc (i32.const ${za & 0xFFFF})) ` +
          "(return (local.get $budget))))");
      }
      parts.push(`    (local.set $budget (i32.sub (local.get $budget) (i32.const ${ci})))`);
      let b0 = b0Known === undefined ? byteAt(a - base) : b0Known;
      if (b0 === null) b0 = ED_TEXT.has(mn) ? 0xED : (/\bi[xy]/.test(ops) ? 0xDD : 0);
      parts.push("    " + rIncWat(m1Count(b0)));
      let wat, flow;
      try {
        [wat, flow] = lower(mn, ops, za, n, { exact: !this.cfg.legacy });
      } catch {
        this.unsupported++;
        parts.push(`    ;; UNSUPPORTED ${s}`);
        parts.push("    (call $trap)");
        return parts.join("\n");
      }
      // An IN samples the V/H counters and the VINT flag at the cycle it
      // completes: publish the line budget left after its own cost.
      // INI/IND read the port before their extra 4 T are charged.
      if (!this.cfg.legacy && IN_OPS.has(mn)) parts.push(`    (global.set $curbudget ${mn === "in" ? "(local.get $budget)" : "(i32.add (local.get $budget) (i32.const 4))"})`);
      if (wat) parts.push("    " + wat);
      if (this.cfg.breakArm === za) {
        parts.push("    (global.set $a (i32.xor (global.get $a) (i32.const 1))) ;; options.breakArm (must-fail control)");
        this.broken = (this.broken ?? 0) + 1;
      }
      if (flow) {
        const [tk, nt] = costOf(mn, ops);
        parts.push(emitFlow(flow, tk - nt));
        return parts.join("\n");
      }
    }
    parts.push(`    (global.set $pc (i32.const ${(addr + size) & 0xFFFF}))`);
    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// RAM snapshot (RAM-resident code with no ROM origin)

/**
 * Capture system RAM from the reference core: loadMedia (with its settle
 * frames) and then `frames` frames, exactly what memory({op:'read',
 * region:'system_ram'}) returns at that point.
 */
export async function captureReferenceRam(romPath, platform, frames) {
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { resolveCore } = await import("../../../../cores/registry.js");
  const resolved = resolveCore(platform);
  if (!resolved) throw new Error(`sms recompile: no reference core for ${platform}`);
  const host = new LibretroHost();
  try {
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    await host.loadMedia({ platform, path: romPath });
    if (frames > 0) await host.stepFrames(frames);
    return new Uint8Array(host.readMemory("system_ram", 0, 0x2000));
  } finally {
    try { host.dispose?.(); } catch { /* best effort */ }
  }
}

/**
 * Run the reference core from power-on and collect the RAM code it executes:
 * every frame, the RAM pcs executed that frame (the core's exact PC bitmap)
 * and, whenever the bytes at any of those pcs change, a copy of system RAM.
 * @param {string} romPath
 * @param {'sms'|'gg'} platform
 * @param {{frames?: number, input?: string|Array<object>}} o
 * @returns {Promise<{snapshots: Uint8Array[], executed: Set<number>, frames: number}>}
 */
export async function discoverRamCode(romPath, platform, o = {}) {
  if (!romPath) throw new Error("sms recompile: ramCode needs the ROM on disk (romPath) to run the reference core");
  const frames = Number.isInteger(o.frames) && o.frames > 0 ? o.frames : 3000;
  const { LibretroHost } = await import("romdev-core-host/index.js");
  const { resolveCore } = await import("../../../../cores/registry.js");
  const { ScheduleDriver, parseInputSchedule } = await import("../../../../host/verify-recompile.js");
  const resolved = resolveCore(platform);
  if (!resolved) throw new Error(`sms recompile: no reference core for ${platform}`);
  const host = new LibretroHost();
  try {
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    // From power-on: no settle frames, so boot-time RAM code is seen too. The
    // input schedule is in frames after loadMedia's usual 5 settle frames.
    host.status.paused = true;
    await host.loadMedia({ platform, path: romPath });
    host.status.paused = false;
    const settle = 5;
    const driver = new ScheduleDriver(host, parseInputSchedule(o.input ?? ""));
    const executed = new Set();
    const windows = new Map();
    const snapshots = [];
    for (let f = 1; f <= frames + settle; f++) {
      const rf = f - settle;
      if (rf >= 0) driver._apply(driver._want(rf));
      const { pcs } = host.logPCBitmap(0xC000, 0x10000, 1);
      if (!pcs.length) continue;
      const ram = Uint8Array.from(host.readMemory("system_ram", 0, 0x2000));
      let changed = false;
      for (const pc of pcs) {
        executed.add(pc);
        const off = pc & 0x1FFF;
        const key = `${ram[off]},${ram[(off + 1) & 0x1FFF]},${ram[(off + 2) & 0x1FFF]},${ram[(off + 3) & 0x1FFF]}`;
        let set = windows.get(pc);
        if (!set) windows.set(pc, (set = new Set()));
        if (!set.has(key)) { set.add(key); changed = true; }
      }
      if (changed) snapshots.push(ram);
      if (snapshots.length > 256) throw new Error("sms recompile: ramCode saw more than 256 distinct RAM code states; this cart generates code at run time and cannot be compiled statically");
    }
    return { snapshots, executed, frames };
  } finally {
    try { host.dispose?.(); } catch { /* best effort */ }
  }
}

async function loadRamSnapshot(opts, platform) {
  if (opts.ramSnapshot instanceof Uint8Array) return opts.ramSnapshot;
  if (typeof opts.ramSnapshot === "string") return new Uint8Array(readFileSync(opts.ramSnapshot));
  if (Number.isInteger(opts.ramSnapshotFrame)) {
    if (!opts.romPath) throw new Error("sms recompile: ramSnapshotFrame needs the ROM on disk (romPath) to load the reference core");
    return captureReferenceRam(opts.romPath, platform, opts.ramSnapshotFrame);
  }
  return null;
}

// ---------------------------------------------------------------------------
// romdev.recompile section

/**
 * Where the machine lives in the cart's linear memory, for the verify op.
 * @param {ReturnType<typeof describe>} d
 */
export function layoutFor(d) {
  const gg = d.platform === "gg";
  return {
    regions: {
      ram: { offset: 0xC000, length: 0x2000, ref: "system_ram" },
      vram: { offset: VRAM, length: 0x4000, ref: gg ? "gg_vram" : "sms_vram" },
      // gpgx keeps CRAM as 16-bit words; an SMS colour is the low byte.
      cram: gg ? { offset: CRAM, length: 64, ref: "gg_cram" } : { offset: CRAM, length: 32, ref: "sms_cram", transform: "lowbyte16", mask: 0x3F },
      // R0-R9. R10 (line counter reload) powers on $FF in gpgx and 0 here;
      // it only matters once a game enables line interrupts, and every game
      // that does writes it first.
      vdpRegs: { offset: VREG, length: 10, ref: "sms_vdp_regs" },
    },
    fields: {
      pc: { offset: PROBE + 12, size: 2, ref: "cpu:pc" },
      sp: { offset: PROBE + 28, size: 2, ref: "cpu:sp" },
      ...(d.emitter === "flat" || d.probeRegs === false ? {} : Object.fromEntries(
        [["a", "A"], ["f", "F"], ["b", "B"], ["c", "C"], ["d", "D"], ["e", "E"], ["h", "H"], ["l", "L"], ["r", "R"], ["i", "I"]]
          .map(([k, ref]) => [k, { offset: PROBE + REG_PROBE_BASE + ["a", "f", "b", "c", "d", "e", "h", "l", "ixh", "ixl", "iyh", "iyl", "r", "i"].indexOf(k), size: 1, ref: `cpu:registers.${ref}` }]))),
    },
    probe: {
      frames: { offset: PROBE + 0, size: 4 },
      trapped: { offset: PROBE + 4, size: 4 },
      trappc: { offset: PROBE + 8, size: 4 },
      irqs: { offset: PROBE + 20, size: 4 },
      vdpWrites: { offset: PROBE + 16, size: 4 },
      ...(d.emitter === "flat" ? {} : { bank2: { offset: PROBE + 40, size: 4 }, bank1: { offset: PROBE + 44, size: 4 } }),
      ...(d.emitter === "flat" || d.probeRegs === false ? {} : { iff: { offset: PROBE + REG_PROBE_BASE + 14, size: 1 }, halted: { offset: PROBE + REG_PROBE_BASE + 15, size: 1 }, lineCarry: { offset: PROBE + REG_PROBE_BASE + 16, size: 4 } }),
    },
    vramZero: ["vram"],
    warmupFrames: 0,
    buttons: "positional",
    screen: { origin: d.screen.origin },
  };
}

/**
 * The options.traceEntries ring in recompile-section.js's `trace` schema. A
 * cart built without the option declares none: findDiverge derives the
 * default pc-only ring from the probe block.
 * @param {number} entries
 */
export function traceFor(entries) {
  const lo = (offset) => ({ offset, mask: 0xFFFF });
  const hi = (offset) => ({ offset, shift: 16, mask: 0xFFFF });
  return {
    baseField: { offset: PROBE + BIGRING_BASE_PROBE, note: "written by wc_render at every frame end" },
    entries, stride: BIGRING_STRIDE,
    cursor: { offset: PROBE + 36, mode: "count", note: "probe tracei, mirrored at every frame end" },
    pc: lo(0),
    fields: {
      line: hi(0), af: lo(4), bc: hi(4), de: lo(8), hl: hi(8), ix: lo(12), iy: hi(12),
      sp: lo(16), r: { offset: 16, shift: 16, mask: 0xFF }, af2: lo(20), bc2: hi(20), de2: lo(24), hl2: hi(24),
      i: { offset: 28, mask: 0xFF },
    },
    note: "registers before the instruction runs, compared with genesis_plus_gx's per-instruction Z80 columns",
  };
}

/**
 * @param {Uint8Array} rom
 * @param {string|null} sha1
 * @param {object} [opts]
 */
export function recompileSection(rom, sha1, opts = {}) {
  const d = describe(rom, opts);
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: d.platform,
      reference: d.platform,
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || null,
      emitter: d.emitter,
      mapper: d.mapper,
      pagesSlot1: d.pagesSlot1,
      ...layoutFor(d),
      diagnostics: {
        probeBlock: { offset: PROBE, fields: ["frames", "trapped", "trappc", "pc", "vdpWrites", "irqs", "vdpStatus", "sp", "traceBase", "tracei", "bank2", "bank1"], stride: 4 },
        lineProbe: { offset: LINEPROBE, lines: 192, stride: 8 },
        pcWatch: { offset: PCWATCH, slots: 4, stride: 8, note: "write a Z80 pc into a slot's first u32; the second counts hits" },
        pcRing: { note: "base at probe traceBase, 8192 x u32 (line<<16 | pc), write index at probe tracei" },
        frameBuffer: { note: "wc_get_info fbPtr, 256x192 RGBA" },
      },
      ...(d.traceEntries ? { trace: traceFor(d.traceEntries) } : {}),
      ...(d.breakArm != null ? { debugBreakArm: d.breakArm, warning: "built with options.breakArm: one instruction also flips bit 0 of A (a must-fail control), NOT a faithful cart" } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// emitWat

/**
 * Emit the whole cart as WAT text chunks (one (module ...)).
 * Fills opts.stats with {arms, lowered, trapped, missing, layout, ...}.
 * @param {Uint8Array} rom
 * @param {object} [opts] see describe()
 * @returns {AsyncGenerator<string>}
 */
export async function* emitWat(rom, opts = {}) {
  const IMG = toBytes(rom);
  let cfg = describe(IMG, opts);
  if (!cfg.supported) throw new Error(`sms recompile: ${cfg.unsupportedReason}`);
  const PLATFORM = cfg.platform;
  const NBANK = cfg.banks;
  const stats = opts.stats || {};

  // RAM code, automatically: a cart whose reference executes RAM code with
  // no input gets the discovery; any other builds exactly as before.
  let autoRam = null;
  if (autoRamEligible(opts, cfg)) {
    autoRam = await discoverRamCode(opts.romPath, PLATFORM, {});
    if (autoRam.executed.size) {
      opts = { ...opts, ramCode: { frames: autoRam.frames } };
      cfg = describe(IMG, opts);
    }
  }
  const { idx, stats: irStats } = await instructionIndex(IMG, PLATFORM);
  if (cfg.emitter === "flat") {
    yield* emitFlatWat(IMG, cfg, idx, stats);
    Object.assign(stats, { platform: PLATFORM, irUnresolvedOffsets: irStats.unresolvedOffsets });
    return;
  }
  // RAM snapshots, each decoded as a 16KB pseudo-ROM at 0 (RAM offset =
  // pseudo-ROM offset). ramCode discovery supplies several plus the set of
  // RAM pcs the reference executed.
  const snaps = [];
  let executed = null, discovery = null;
  if (cfg.ramRegions.some((r) => r.src === "snapshot")) {
    let raws;
    if (opts.ramCode) {
      discovery = autoRam && autoRam.executed.size ? autoRam : await discoverRamCode(opts.romPath, PLATFORM, opts.ramCode === true ? {} : opts.ramCode);
      raws = discovery.snapshots;
      executed = discovery.executed;
    } else {
      const one = await loadRamSnapshot(opts, PLATFORM);
      if (!one) throw new Error("sms recompile: a ramRegions entry has src:'snapshot' but no ramSnapshot / ramSnapshotFrame / ramCode was given");
      raws = [one];
    }
    for (const raw of raws) {
      const pad = new Uint8Array(0x4000);
      pad.set(raw.subarray(0, Math.min(raw.length, 0x4000)));
      snaps.push({ bytes: raw, idx: (await instructionIndex(pad, "sms")).idx });
    }
  }
  const snapIdx = snaps.length ? snaps[0].idx : new Map();

  let items = fullBlocks(IMG, cfg.pagesSlot1);
  if (cfg.ramRegions.length) {
    for (const r of cfg.ramRegions) {
      for (let off = 0; off < r.bytes; off++) {
        const cpu = r.cpu + off;
        if (cpu > 0xFFFF) break;
        // Keep the TRUE instruction length per arm (one arm per byte, each
        // advancing the pc by its own instruction).
        const ent = r.src === "snapshot" ? snapIdx.get(cpu - 0xC000) : idx.get(r.romOffset + off);
        items.push([cpu, cpu, r.bank, ent ? ent[0] : 1]);
      }
    }
    items = items.map((t, i) => [t, i]).sort((a, b) => (a[0][0] - b[0][0]) || (a[1] - b[1])).map((x) => x[0]);
  }
  const n = items.length;
  const G = computeLayout(n, IMG.length, NBANK, cfg.pagesSlot1);
  const { ABI, TRACE, AUDIO, ROMIMG, BTAB } = G;
  // options.traceEntries: the register ring goes above everything else.
  if (cfg.traceEntries) G.BIGRING = G.TOP;
  const pages = Math.floor((G.TOP + (cfg.traceEntries ? cfg.traceEntries * BIGRING_STRIDE : 0) + 0xFFFF) / 0x10000) + 1;

  const head = ["(module", `  (memory (export "memory") ${pages})`];
  for (const g of ["a", "f", "b", "c", "d", "e", "h", "l", "ixh", "ixl", "iyh", "iyl", "rreg", "ireg",
    "a2", "f2", "b2", "c2", "d2", "e2", "h2", "l2"]) head.push(`  (global $${g} (mut i32) (i32.const 0))`);
  head.push("  (global $sp (mut i32) (i32.const 0xDFF0))",
    "  (global $pc (mut i32) (i32.const 0))",
    "  (global $iff (mut i32) (i32.const 0))",
    "  (global $halted (mut i32) (i32.const 0))",
    "  (global $joy1 (mut i32) (i32.const 0xFF))",
    "  (global $joy2 (mut i32) (i32.const 0xFF))",
    "  (global $trapped (mut i32) (i32.const 0))",
    "  (global $trappc (mut i32) (i32.const 0))",
    "  (global $retn (mut i32) (i32.const 0))",
    "  (global $frames (mut i32) (i32.const 0))",
    "  (global $irqs (mut i32) (i32.const 0))",
    "  (global $tracei (mut i32) (i32.const 0))",
    "  (global $linectr (mut i32) (i32.const 0))");
  head.push(bankHelpersWat(G, cfg, NBANK));
  head.push(flagHelpersWat({ exact: !cfg.legacy }));
  head.push(hwWat(PLATFORM, { exact: !cfg.legacy, region: cfg.region }));
  head.push(renderWat({ exact: !cfg.legacy }));
  head.push(psgWat(AUDIO, ABI));
  head.push(miscWat({ exact: !cfg.legacy }));
  head.push("  (func $trap (global.set $trapped (i32.const 1)) (global.set $trappc (global.get $pc)))");
  yield head.join("\n") + "\n";

  const em = new Emitter(IMG, cfg, idx, snaps, executed);
  const nshard = Math.ceil(n / SHARD_SZ);
  for (let sh = 0; sh < nshard; sh++) {
    const lo = sh * SHARD_SZ, hi = Math.min(n, lo + SHARD_SZ), cnt = hi - lo;
    const p = [`  (func $shard${sh} (param $id i32) (param $budget i32) (result i32)`,
      "    (local $t i32) (local $t2 i32) (local $cf i32)"];
    for (let i = cnt - 1; i >= 0; i--) p.push(`      (block $s${i}`);
    p.push("        (block $sdef");
    const labels = [];
    for (let i = 0; i < cnt; i++) labels.push(`$s${i}`);
    p.push("          (br_table " + labels.join(" ") + " $sdef (local.get $id)))");
    p.push("        (call $trap) (return (local.get $budget))");
    for (let i = 0; i < cnt; i++) {
      const [, addr, bank, size] = items[lo + i];
      p.push(`      ) ;; ---- arm ${lo + i} @ $${addr.toString(16).toUpperCase().padStart(4, "0")} bank ${bank}`);
      p.push(em.arm(addr, bank, size));
      p.push("      (return (local.get $budget))");
    }
    p.push("    (local.get $budget))");
    yield p.join("\n") + "\n";
  }

  // $run: the dispatch loop for one scanline's budget. Returns what is LEFT
  // (normally <= 0); the caller carries it into the next line so an
  // overshooting block is paid for, not forgiven.
  const r = ["  (func $run (param $budget i32) (result i32)",
    "    (local $id i32) (local $sh i32)" + (cfg.traceEntries ? " (local $tr i32)" : ""),
    "    (block $exit (loop $next",
    "      (br_if $exit (i32.le_s (local.get $budget) (i32.const 0)))",
    "      (br_if $exit (global.get $trapped))",
    // Interrupts are sampled before EVERY instruction, as genesis_plus_gx's
    // z80_run does, except the one right after EI. Acceptance (IM1) costs
    // 13 T; a line whose budget that exhausts ends before the handler runs.
    ...(cfg.legacy ? [] : [
      "      (if (i32.and (i32.ne (global.get $iff) (i32.const 0)) (i32.eqz (global.get $eidelay)))",
      "        (then (if (call $irq_line)",
      "          (then (global.set $irqs (i32.add (global.get $irqs) (i32.const 1)))",
      "                (global.set $iff (i32.const 0))",
      "                (global.set $halted (i32.const 0))",
      "                (call $push16 (global.get $pc))",
      "                (local.set $budget (i32.sub (local.get $budget) (i32.const 13)))",
      "                (global.set $pc (i32.const 0x38))",
      "                (br_if $exit (i32.le_s (local.get $budget) (i32.const 0)))))))",
      "      (global.set $eidelay (i32.const 0))"]),
    // A halted Z80 still burns the line as 4 T re-executions, each an opcode
    // fetch that R counts.
    "      (if (global.get $halted) (then",
    "        (if (i32.gt_s (local.get $budget) (i32.const 0)) (then",
    "          (global.set $rreg (i32.or (i32.and (global.get $rreg) (i32.const 0x80)) (i32.and (i32.add (global.get $rreg)",
    "            (i32.shr_u (i32.add (local.get $budget) (i32.const 3)) (i32.const 2))) (i32.const 0x7F))))))",
    "        (if (i32.gt_s (local.get $budget) (i32.const 0)) (then (local.set $budget",
    "          (i32.sub (i32.const 0) (i32.and (i32.sub (i32.const 4) (i32.and (local.get $budget) (i32.const 3))) (i32.const 3))))))",
    "        (br $exit)))",
    // PC ring: line<<16 | pc per dispatched block.
    `      (i32.store (i32.add (i32.const ${TRACE}) ` +
    "(i32.mul (i32.and (global.get $tracei) (i32.const 8191)) (i32.const 4))) " +
    "(i32.or (global.get $pc) " +
    "(i32.shl (global.get $line) (i32.const 16))))",
    ...(cfg.traceEntries ? bigRingWat(G.BIGRING, cfg.traceEntries) : []),
    "      (global.set $tracei (i32.add (global.get $tracei) (i32.const 1)))"];
  // Host-settable PC watches (0 = slot off).
  for (let w = 0; w < 4; w++) {
    const b = PCWATCH + w * 8;
    // Slot 0 also snapshots the machine at its FIRST hit (hit count 0 ->
    // 1): line, line budget left, R, A F B C D E H L, at PCWATCH+32. Re-arm
    // by zeroing the count. Lets a per-instruction divergence be located
    // against the reference's own PC breakpoint snapshot.
    const snap = w === 0 && !cfg.legacy ? `(if (i32.eqz (i32.load (i32.const ${b + 4}))) (then ` +
      `(i32.store16 (i32.const ${PCWATCH + 32}) (global.get $line)) ` +
      `(i32.store (i32.const ${PCWATCH + 36}) (local.get $budget)) ` +
      ["rreg", "a", "f", "b", "c", "d", "e", "h", "l"].map((g, i) => `(i32.store8 (i32.const ${PCWATCH + 40 + i}) (global.get $${g}))`).join(" ") +
      ")) " : "";
    r.push(`      (if (i32.eq (global.get $pc) (i32.load (i32.const ${b}))) ` +
      `(then ${snap}(i32.store (i32.const ${b + 4}) ` +
      `(i32.add (i32.load (i32.const ${b + 4})) (i32.const 1)))))`);
  }
  r.push("      (local.set $id (call $blockid (global.get $pc)))",
    "      (if (i32.eqz (local.get $id)) (then (call $trap) (br $exit)))",
    "      (local.set $id (i32.sub (local.get $id) (i32.const 1)))",
    `      (local.set $sh (i32.div_u (local.get $id) (i32.const ${SHARD_SZ})))`,
    `      (local.set $id (i32.rem_u (local.get $id) (i32.const ${SHARD_SZ})))`);
  for (let sh = nshard - 1; sh >= 0; sh--) r.push(`      (block $k${sh}`);
  r.push("        (block $kdef");
  const klabels = [];
  for (let i = 0; i < nshard; i++) klabels.push(`$k${i}`);
  r.push("          (br_table " + klabels.join(" ") + " $kdef (local.get $sh)))");
  r.push("        (call $trap) (br $exit)");
  for (let sh = 0; sh < nshard; sh++) {
    r.push(`      ) ;; shard ${sh}`);
    r.push(`      (local.set $budget (call $shard${sh} (local.get $id) (local.get $budget)))`);
    // A pending interrupt armed by `ei` is taken at the next instruction
    // boundary (eiarm counts the one-instruction EI delay), with the same
    // /INT condition as the scanline path, never mid VDP write pair.
    if (cfg.legacy) r.push("      (if (i32.and (i32.eq (global.get $eiarm) (i32.const 1)) (call $irq_line))",
      "        (then (global.set $eiarm (i32.const 0))",
      "              (global.set $irqs (i32.add (global.get $irqs) (i32.const 1)))",
      "              (global.set $iff (i32.const 0))",
      "              (global.set $halted (i32.const 0))",
      "              (call $push16 (global.get $pc))",
      "              (local.set $budget (i32.sub (local.get $budget) (i32.const 13)))",
      "              (global.set $pc (i32.const 0x38))))",
      "      (if (i32.gt_u (global.get $eiarm) (i32.const 1))",
      "        (then (global.set $eiarm (i32.sub (global.get $eiarm) (i32.const 1)))))");
    r.push("      (br $next)");
  }
  r.push("    ))", "    (local.get $budget)", "  )");
  r.push(abiWat(G, cfg, n, PLATFORM));
  yield r.join("\n") + "\n";

  // Arm table (addr lo/hi, bank, 0) that wc_init expands into the block maps.
  const btab = new Uint8Array(n * 4);
  items.forEach(([, a, bk], i) => { btab[i * 4] = a & 0xFF; btab[i * 4 + 1] = (a >> 8) & 0xFF; btab[i * 4 + 2] = bk & 0xFF; });
  yield `  (data (i32.const ${BTAB}) "${watBytes(btab)}")\n`;
  yield `  (data (i32.const ${GGLUT}) "${watBytes(ggLutBytes())}")\n`;
  if (!cfg.legacy) yield `  (data (i32.const ${HCTAB}) "${watBytes(hcounterBytes())}")\n  (data (i32.const ${HCOLTAB}) "${watBytes(hcolBytes())}")\n`;
  yield `  (data (i32.const ${ROMIMG}) "${watBytes(IMG)}")\n`;
  yield ")";

  const trapped = em.unsupported + em.missing;
  Object.assign(stats, {
    emitter: "banked",
    arms: n,
    lowered: n - trapped,
    trapped,
    unsupported: em.unsupported,
    noInstruction: em.missing,
    shards: nshard,
    platform: PLATFORM,
    mapper: cfg.mapper,
    pagesSlot1: cfg.pagesSlot1,
    ramArms: cfg.ramRegions.reduce((a, rr) => a + Math.min(rr.bytes, 0x10000 - rr.cpu), 0),
    ramVariants: em.ramVariants,
    ...(discovery ? { ramCode: { frames: discovery.frames, snapshots: discovery.snapshots.length, executedRamPcs: discovery.executed.size, ...(autoRam ? { automatic: true } : {}) } }
      : autoRam ? { ramCode: { automatic: true, frames: autoRam.frames, executedRamPcs: 0, note: "the reference executed no RAM code with no input; pass ramCode:{input} if gameplay reaches some" } } : {}),
    irUnresolvedOffsets: irStats.unresolvedOffsets,
    memory: { pages, ...G },
  });
  if (cfg.breakArm != null) {
    if (!em.broken) throw new Error(`sms recompile: options.breakArm $${cfg.breakArm.toString(16)} is not the start of any compiled instruction`);
    stats.brokenArms = em.broken;
  }
}

/**
 * Convenience: the whole module as one string (small carts, tests, debugging).
 * @param {Uint8Array} rom
 * @param {object} [opts]
 */
export async function emitWatString(rom, opts) {
  const parts = [];
  for await (const c of emitWat(rom, opts)) parts.push(c);
  return parts.join("");
}
