// Genesis / Mega Drive WAT backend: a whole commercial 68000 cart statically
// recompiled into one wasmcart module, verified against genesis_plus_gx.
//
// Every even ROM offset becomes one arm of a sharded br_table dispatch over
// $pc, so a computed jump cannot land on uncompiled code. Each arm's body is
// gpgx's own Musashi opcode handler partially evaluated for that opcode at
// that address (ctrans.js over gpgx-derived.json.gz); the machine around it
// (memory map, VDP, Z80, frame loop) is runtime.js. Both follow gpgx
// function for function because the carts are verified against gpgx's
// picture and memory at the same frame.
//
// Ported from sms-wat's emit_md.py; the WAT text is identical to what the
// Python emitter produced for the verified carts (see the differential under
// sms-wat/work/romdev-port/).
//
// Code the game copies from ROM into work RAM and runs there is compiled at
// its RAM address. Such routines are found automatically by a static scan
// for the copy loop (discoverRamCode); options.ramCode overrides/extends it.
// A cart that jumps to RAM code nobody declared traps: its state block then
// holds trapped=1 and trappc=<the RAM PC>, and the fix is
// options.ramCode:[{romOffset, ramAddress, length}].
//
// LICENSE: carts built by this backend contain code transpiled from Genesis
// Plus GX and are NON-COMMERCIAL (see NOTICE and gpgx-derived.json.gz).
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { loadGpgxData } from "./gpgx-data.js";
import { translateM68k, translateZ80, z80HandlerNames, TrError, ZREGS } from "./ctrans.js";
import * as RT from "./runtime.js";

export const platforms = ["genesis", "md", "megadrive"];

const { R, CYCTAB, FIFO, ABI, FB, FB_W, FB_H, PIXEL } = RT;
const ROMIMG = 0x160000;
const RAMWORDS = 0x8000;
const STATE = RT.TRACE; // per-frame CPU/VDP state block for the differ
const TRACEN = 1 << 18; // instruction ring entries (enabled by STATE+0xF8)
const SH = 1024; // arms per dispatch shard

/**
 * gpgx pads the ROM to a power of two and mirrors it (md_cart.c: cart.mask).
 * @param {Uint8Array} img
 */
function padRom(img) {
  let size = 1;
  while (size < img.length) size <<= 1;
  const rom = new Uint8Array(size).fill(0xff);
  rom.set(img);
  return rom;
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
  if (country & 4) return 0x80;
  if (country & 1) return 0x00;
  if (country & 8) return 0xc0;
  if (country & 2) return 0x40;
  return 0x80;
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
    // to RAM the same way (Sonic 1 copies one to $FE30) must not become arms.
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
  const img = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
  if (img.length < 0x200) throw new Error("genesis recompile: ROM smaller than its 512-byte header");
  const padded = padRom(img);
  const txt = (a, b) => Array.from(img.subarray(a, b), (c) => (c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ")).join("").replace(/\s+/g, " ").trim();
  const ramCode = ramCodeList(img, opts);
  const narms = Math.ceil(img.length / 2) + ramCode.reduce((s, r) => s + Math.ceil(r.length / 2), 0);
  const data = loadGpgxData();
  return {
    platform: "genesis",
    referenceCore: REFERENCE_CORE,
    supported: true,
    romSha1: createHash("sha1").update(img).digest("hex"),
    romBytes: img.length,
    romMirrorSize: padded.length,
    system: txt(0x100, 0x110),
    title: txt(0x150, 0x180) || txt(0x120, 0x150), // overseas name, else domestic (ASCII only)
    regionField: txt(0x1f0, 0x1f4),
    regionCode: regionCode(img),
    ramCode,
    arms: narms,
    shards: Math.ceil(narms / SH),
    layout,
    conventions,
    license: data.meta.license,
    licenseNote: "carts built by this backend contain code transpiled from Genesis Plus GX: non-commercial",
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
      regions: layout.regions,
      fields: layout.fields,
      probe: layout.probe,
      vramZero: layout.vramZero,
      conventions,
      ramCode: d.ramCode.map(({ romOffset, ramAddress, length, source }) => ({ romOffset, ramAddress, length, source })),
      trapHint: "probe trapped=1 with trappc in work RAM ($FFxxxxxx) means the game ran code it copied to RAM that discovery missed: rebuild with options.ramCode:[{romOffset, ramAddress, length}]",
      license: d.licenseNote,
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

/** Bytes as a WAT string body (sms-wat's _wat_bytes). */
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
 * @param {{ramCode?:object[], discoverRamCode?:boolean, onProgress?:(s:string)=>void}} [opts]
 */
export async function* emitWat(rom, opts = {}) {
  const img = rom instanceof Uint8Array ? rom : new Uint8Array(rom);
  const D = loadGpgxData();
  const ROMDATA = padRom(img);
  const ROMSIZE = ROMDATA.length;
  const ROMWORDS = ROMSIZE / 2;
  const PCTAB = ROMIMG + ROMSIZE;
  const PACKED = PCTAB + (ROMWORDS + RAMWORDS) * 4;
  const fetchRom = (p) => {
    p &= ROMSIZE - 1;
    return (ROMDATA[p] << 8) | ROMDATA[(p + 1) & (ROMSIZE - 1)];
  };

  // arm list: [index, pc, fetch16]; ROM arms first, then RAM-resident copies
  const arms = [];
  for (let off = 0; off < img.length; off += 2) arms.push([off >> 1, off, fetchRom]);
  for (const { romOffset, ramAddress, length } of ramCodeList(img, opts)) {
    const f16 = (p) => {
      const d = (p - ramAddress) >>> 0;
      if (d < 0x10000) return fetchRom(romOffset + d);
      return fetchRom(p);
    };
    for (let k = 0; k < length; k += 2) {
      const pc = (ramAddress + k) >>> 0;
      arms.push([ROMWORDS + ((pc & 0xffff) >> 1), pc, f16]);
    }
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
  const tracebuf = (PACKED + narms * 8 + 0xffff) & ~0xffff;
  const pages = Math.floor((tracebuf + TRACEN * 16) / 0x10000) + 1;

  yield `(module\n  (memory (export "memory") ${pages})\n  `;
  yield RT.globalsWat();
  yield RT.cpuWat();
  yield RT.memWat(ROMIMG, ROMSIZE);
  yield RT.ioWat();
  yield RT.vdpWat();
  yield RT.renderWat();
  // the Z80: one function per opcode handler, dispatched via the table
  zlay.tbase = nsh;
  const znames = z80HandlerNames();
  yield RT.z80Wat(zlay, D.z80.cc).replaceAll("{romimg}", String(ROMIMG)).replaceAll("{rmask}", String(ROMSIZE - 1))
    .replaceAll("{ztbase}", String(nsh));
  {
    let buf = [];
    for (const zn of znames) buf.push(translateZ80(D.z80, zn, zlay));
    yield buf.join("");
  }
  // the 68000 arms, one br_table shard per SH arms
  let bad = 0;
  for (let si = 0; si < nsh; si++) {
    const sh = arms.slice(si * SH, (si + 1) * SH);
    const bodies = [];
    let nl = 1;
    for (const [, pc, f16] of sh) {
      let body, nloc;
      try {
        ({ body, nlocals: nloc } = translateM68k(D.m68k, f16(pc), pc, f16));
      } catch (e) {
        if (!(e instanceof TrError)) throw e;
        body = "(call $trap)";
        nloc = 0;
        bad++;
      }
      if (nloc > nl) nl = nloc;
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
  (func $trace (param $p i32)
    (if (i32.load (i32.const ${STATE + 0xF8}))
      (then
        (i32.store (i32.add (i32.const ${tracebuf}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (local.get $p))
        (i32.store (i32.add (i32.const ${tracebuf + 4}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $mc))
        (i32.store (i32.add (i32.const ${tracebuf + 8}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $refresh))
        (i32.store (i32.add (i32.const ${tracebuf + 12}) (i32.shl (i32.load (i32.const ${STATE + 0xFC})) (i32.const 4))) (global.get $mcend))
        (i32.store (i32.const ${STATE + 0xFC}) (i32.and (i32.add (i32.load (i32.const ${STATE + 0xFC})) (i32.const 1)) (i32.const ${TRACEN - 1}))))))
  (func (export "dbg_tracebuf") (result i32) (i32.const ${tracebuf}))
  (func $step
    (local $id i32) (local $p i32)
    (local.set $p (global.get $pc))
    (global.set $curpc (local.get $p))
    (call $trace (local.get $p))
    (if (i32.and (local.get $p) (i32.const 1)) (then (call $trap) (return)))
    (local.set $p (i32.and (local.get $p) (i32.const 0xFFFFFF)))
    (if (i32.lt_u (local.get $p) (i32.const 0x400000))
      (then (local.set $id (i32.load (i32.add (i32.const ${PCTAB})
              (i32.shl (i32.shr_u (i32.and (local.get $p) (i32.const ${ROMSIZE - 1})) (i32.const 1)) (i32.const 2))))))
      (else (if (i32.ge_u (local.get $p) (i32.const 0xE00000))
        (then (local.set $id (i32.load (i32.add (i32.const ${PCTAB + ROMWORDS * 4})
                (i32.shl (i32.shr_u (i32.and (local.get $p) (i32.const 0xFFFF)) (i32.const 1)) (i32.const 2)))))))))
    (if (i32.eqz (local.get $id)) (then (call $trap) (return)))
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
  for (const [off, b] of tabsegs) yield `  (data (i32.const ${off}) "${watBytes(b)}")\n`;
  yield `  (data (i32.const ${ROMIMG}) "${watBytes(ROMDATA)}")\n`;
  yield frameWat(narms, PACKED, PCTAB, img).replace("(call $initmap)", `(call $initmap) (i32.store (i32.const ${STATE + 0xf4}) (i32.const ${tracebuf}))`);
  yield ")\n";
  if (opts.stats) Object.assign(opts.stats, { arms: narms, lowered: narms - bad, trapped: bad, shards: nsh, ramCodeArms: narms - Math.ceil(img.length / 2) });
  if (opts.onProgress) opts.onProgress(`genesis: ${narms} arms (${bad} untranslated)`);
}

function frameWat(narms, PACKED, PCTAB, img) {
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
    ;; osd_input_update: the pad state the game sees for this whole frame
    (local.set $b (i32.load16_u (i32.const ${ABI + 288})))
    (local.set $p (i32.const 0))
    (if (i32.and (local.get $b) (i32.const 0x100)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x01)))))
    (if (i32.and (local.get $b) (i32.const 0x200)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x02)))))
    (if (i32.and (local.get $b) (i32.const 0x400)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x04)))))
    (if (i32.and (local.get $b) (i32.const 0x800)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x08)))))
    (if (i32.and (local.get $b) (i32.const 0x001)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x10)))))
    (if (i32.and (local.get $b) (i32.const 0x002)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x20)))))
    (if (i32.and (local.get $b) (i32.const 0x004)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x40)))))
    (if (i32.and (local.get $b) (i32.const 0x040)) (then (local.set $p (i32.or (local.get $p) (i32.const 0x80)))))
    (global.set $pad0 (local.get $p))
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
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.const 3420))))
    (i32.store8 (i32.const ${ZREGS + 61}) (i32.const 0))
    (global.set $mcvdp (i32.const 3420))
    (local.set $line (i32.add (global.get $vp_h) (i32.const 1)))
    (block $d (loop $l
      (global.set $v_v_counter (local.get $line))
      (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))
      (global.set $mcvdp (i32.add (global.get $mcvdp) (i32.const 3420)))
      (local.set $line (i32.add (local.get $line) (i32.const 1)))
      (br_if $l (i32.lt_s (local.get $line) (i32.const 261)))))
    (global.set $v_v_counter (local.get $line))
    (global.set $v_h_counter ${R(10)})
    (global.set $v_status (i32.and (global.get $v_status) (i32.const -9)))
    (if (global.get $v_dma_length) (then (call $dma_update (global.get $mcvdp))))
    (if (i32.and ${R(1)} (i32.const 0x40)) (then (if (i32.and ${R(1)} (i32.const 4)) (then (call $parse_satb (i32.const -1))))))
    (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))
    (global.set $mcvdp (i32.add (global.get $mcvdp) (i32.const 3420)))
    (local.set $line (i32.const 0))
    (block $d (loop $l
      (global.set $v_v_counter (local.get $line))
      (if (global.get $v_dma_length) (then (call $dma_update (global.get $mcvdp))))
      (call $render_line (local.get $line))
      (if (i32.eqz (global.get $v_h_counter))
        (then (global.set $v_h_counter ${R(10)})
              (global.set $v_hint_pending (i32.const 0x10))
              (if (i32.and ${R(0)} (i32.const 0x10))
                (then (call $update_irq (i32.const 4))
                      (global.set $nhint (i32.add (global.get $nhint) (i32.const 1))))))
        (else (global.set $v_h_counter (i32.sub (global.get $v_h_counter) (i32.const 1)))))
      (call $m68k_run (i32.add (global.get $mcvdp) (i32.const 3420)))
    (if (i32.eq (global.get $zstate) (i32.const 1)) (then (call $z80_run (i32.add (global.get $mcvdp) (i32.const 3420)))))
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
      (else (global.set $th1_lat (i32.const 0))))
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
    (i32.store (i32.const ${ABI + 0}) (i32.const 3))
    (i32.store (i32.const ${ABI + 4}) (i32.const ${FB_W}))
    (i32.store (i32.const ${ABI + 8}) (i32.const 224))
    (i32.store (i32.const ${ABI + 12}) (i32.const ${FB}))
    (i32.store (i32.const ${ABI + 16}) (i32.const 0))
    (i32.store (i32.const ${ABI + 20}) (i32.const 0))
    (i32.store (i32.const ${ABI + 24}) (i32.const ${ABI + 256}))
    (i32.store (i32.const ${ABI + 28}) (i32.const ${ABI + 288}))
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
    (call $vdp_reset)
    (call $io_reset)
    (global.set $zstate (i32.const 0))
    (global.set $zmap (i32.const 0))
    (global.set $zbank (i32.const 0))
    (call $z80_init)
    (call $z80_reset)
    (global.set $mc (i32.const ${Math.floor(((262 - 192 + 159) * 3420 + 1004) / 7) * 7}))
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
