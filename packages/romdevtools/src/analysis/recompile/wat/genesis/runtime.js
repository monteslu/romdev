// Genesis runtime for recompiled carts: memory map, I/O, VDP, renderer and
// the Z80/YM2612 bus side, each a port of the genesis_plus_gx function named
// beside it. Ported from the earlier verified Python emitter;
// the WAT text is kept identical to what it produced.
//
// Why a port and not a model: the verification target is gpgx's own picture
// at the same frame, and a demo or a game's RNG only tracks it if the 68000
// sees every interrupt, status bit and DMA stall at the same master cycle. So
// the structure here is gpgx's, function for function:
//
//     system_frame_gen   -> $frame        (frame starts at VBLANK, per-line runs)
//     m68k_run           -> $m68k_run     (interrupt check on entry, bus refresh)
//     vdp_68k_ctrl_w     -> $vdp_ctrl_w   (pending flag, DMA trigger)
//     vdp_68k_data_w_m5  -> $vdp_data_w   (FIFO timing, DMA fill trigger)
//     vdp_68k_ctrl_r     -> $vdp_ctrl_r   (cycle-accurate VINT/HBLANK/FIFO bits)
//     vdp_hvc_r          -> $vdp_hvc_r
//     vdp_reg_w          -> $vdp_reg_w    (irq line updates, mid-line re-render)
//     vdp_dma_update     -> $dma_update   (68k frozen for the transfer)
//     render_line & co   -> $render_line  (Mode 5 only)
//
// VRAM/CRAM/VSRAM use gpgx's own layout (little-endian 16-bit words), so
// romdev's video_ram/genesis_cram/genesis_vsram regions compare byte for byte
// with the cart's. Work RAM is kept in 68000 byte order, which is how romdev
// presents system_ram.
//
// LICENSE: this is a port of Genesis Plus GX code and is NON-COMMERCIAL like
// the data in gpgx-derived.json.gz (see NOTICE).
//
// Plain JS ESM + JSDoc.

import { ZREGS } from "./ctrans.js";

// ---- linear memory map ------------------------------------------------------
export const WRAM = 0x00000; // 64KB, 68000 byte order
export const VRAM = 0x10000; // 64KB, gpgx word layout (little-endian words)
export const CRAM = 0x20000; // 128B, gpgx packed 9-bit words
export const VSRAM = 0x20080; // 128B
export const VREG = 0x20100; // 32 registers
export const PROBE = 0x20200; // 64 bytes of liveness counters
export const FIFO = 0x20240; // fifo[4] u16 at +0, fifo_cycles[4] u32 at +16
export const OBJ = 0x20280; // obj_info[2][20] x 8 bytes
export const OBJCNT = 0x203c0; // object_count[2]
export const CLIP = 0x203d0; // clip[2] x {left,right,enable} u8
export const SMALLT = 0x203e0; // hscroll_mask[4], shift_table[4], col_mask_table[4]
export const SAT = 0x20400; // internal SAT cache, 1KB
export const ZRAM = 0x20800; // Z80 RAM 8KB
export const LINEBUF = 0x22800; // linebuf[2][0x200]
export const PIXEL = 0x22c00; // pixel[256] as RGBA u32
export const NAMELUT = 0x23000; // name_lut[0x400]
export const HC32 = 0x23400; // cycle2hc32[3420]
export const HC40 = 0x24200; // cycle2hc40[3420]
export const PIXLUT = 0x25000; // pixel_lut[3][0x200] RGBA u32 (6KB)
export const CYCTAB = 0x28000; // m68ki_cycles[0x10000] / 7 as bytes (64KB)
export const SHIFT = 0x38000; // m68ki_shift_{8,16,32}_table as u32 (3 x 65)
export const TRACE = 0x39000; // CPU state block + trace ring control (differ)
export const LUT = 0x50000; // lut[0..4][0x10000]
export const FB = 0xa0000; // RGBA 320x240
export const ABI = 0xec000;
export const FB_W = 320, FB_H = 240;
export const ZT = 0x100000; // Z80 flag tables + cycle tables (see z80Layout)
export const LINEPIX = 0x142000; // per-line composed codes, 240 x 320
export const CARTMAP = 0x3f000; // 64 x i32: what each 64KB bank of $000000-$3FFFFF maps (ROM offset, or -1/-2 = backup RAM)
export const SRAMBUF = 0x40000; // backup RAM, 64KB, 68000 byte order (gpgx sram.sram)
export const CARTR = 0x3f100; // 64 x u8: cartridge-bank read handler (0 = memory_map base, 1 = I2C EEPROM, 2 = J-Cart + EEPROM)
export const CARTW = 0x3f140; // 64 x u8: write handler (0 = base, 1 = I2C byte/word, 2 = I2C word only, 3 = Acclaim 32M PAL, 4 = J-Cart, 5 = unused)
export const PIXLUT_M4 = 0x3f200; // pixel_lut_m4[0x40] as RGBA u32
export const JPADS = 0x3f180; // J-Cart pads (gpgx devices 5 and 6): 2 x {state, latency, counter, timeout} i32
const LB0 = LINEBUF, LB1 = LINEBUF + 0x200;
const FIFOT32 = 0x26800; // 28 x i32 (after PIXLUT)
const FIFOT40 = 0x26880; // 32 x i32

/** gpgx VREG byte n as a WAT load. */
export const R = (n) => `(i32.load8_u (i32.const ${VREG + n}))`;
const RS = (n, v) => `(i32.store8 (i32.const ${VREG + n}) ${v})`;

// ---- lookup tables (vdp_render.c make_lut_*) ---------------------------------
function makeLutBg(bx, ax) {
  const bf = bx & 0x7f, bp = bx & 0x40, b = bx & 0x0f;
  const af = ax & 0x7f, ap = ax & 0x40, a = ax & 0x0f;
  let c = ap ? (a ? af : bf) : bp ? (b ? bf : af) : a ? af : bf;
  if ((c & 0x0f) === 0) c &= 0x80;
  return c;
}
function makeLutBgSte(bx, ax) {
  const bf = bx & 0x7f, bp = bx & 0x40, b = bx & 0x0f;
  const af = ax & 0x7f, ap = ax & 0x40, a = ax & 0x0f;
  let c = ap ? (a ? af : bf) : bp ? (b ? bf : af) : a ? af : bf;
  c |= (ap | bp) << 1;
  if ((c & 0x0f) === 0) c &= 0x80;
  return c & 0xff;
}
function makeLutObj(bx, sx) {
  const bf = bx & 0x7f, bs = bx & 0x80, sf = sx & 0x7f;
  if ((sx & 0x0f) === 0) return bx;
  let c = bs ? bf : sf;
  if ((c & 0x0f) === 0) c &= 0xc0;
  return c | 0x80;
}
function makeLutBgObj(bx, sx) {
  const bf = bx & 0x3f, bs = bx & 0x80, bp = bx & 0x40, b = bx & 0x0f;
  const sf = sx & 0x3f, sp = sx & 0x40, s = sx & 0x0f;
  if (s === 0) return bx;
  if (bs) return bx;
  let c = sp ? sf : bp ? (b ? bf : sf) : sf;
  if ((c & 0x0f) === 0) c &= 0x80;
  return c | 0x80;
}
function makeLutBgObjSte(bx, sx) {
  const bf = bx & 0x3f, bp = bx & 0x40, b = bx & 0x0f;
  const bi = (bx & 0x80) >> 1;
  const sf = sx & 0x3f, sp = sx & 0x40, s = sx & 0x0f;
  const si = sp | bi;
  const spr = () => {
    if ((sf & 0x3e) === 0x3e) {
      if (sf & 1) return bf | 0x00;
      return bx & 0x80 ? bf | 0x80 : bf | 0x40;
    }
    if (sf === 0x0e || sf === 0x1e || sf === 0x2e) return sf | 0x40;
    return sf | si;
  };
  let c;
  if (sp) c = s ? spr() : bf | bi;
  else if (bp) c = b ? bf | bi : s ? spr() : bf | bi;
  else c = s ? spr() : bf | bi;
  if ((c & 0x0f) === 0) c &= 0xc0;
  return c & 0xff;
}
function luts() {
  const out = new Uint8Array(5 * 0x10000);
  [makeLutBg, makeLutBgObj, makeLutBgSte, makeLutObj, makeLutBgObjSte].forEach((f, k) => {
    const base = k * 0x10000;
    for (let bx = 0; bx < 256; bx++) for (let ax = 0; ax < 256; ax++) out[base + ((bx << 8) | ax)] = f(bx, ax) & 0xff;
  });
  return out;
}
function nameLut() {
  const out = new Uint8Array(0x400);
  for (let i = 0; i < 0x400; i++) {
    let vcol = i & 3, vrow = (i >> 2) & 3;
    const height = (i >> 4) & 3, width = (i >> 6) & 3;
    const flipx = (i >> 8) & 1, flipy = (i >> 9) & 1;
    if (vrow > height || vcol > width) {
      out[i] = 0xff;
    } else {
      if (flipx) vcol = width - vcol;
      if (flipy) vrow = height - vrow;
      out[i] = (vrow + vcol * (height + 1)) & 0xff;
    }
  }
  return out;
}
/** gpgx USE_16BPP_RENDERING pixel -> the 0xAARRGGBB word romdev presents. */
function rgba565(p) {
  const R5 = (p >> 11) & 0x1f, G6 = (p >> 5) & 0x3f, B5 = p & 0x1f;
  const r = (R5 << 3) | (R5 >> 2), g = (G6 << 2) | (G6 >> 4), b = (B5 << 3) | (B5 >> 2);
  return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
}
const makePixel = (r, g, b) => (r << 12) | ((r >> 3) << 11) | (g << 7) | ((g >> 2) << 5) | (b << 1) | (b >> 3);
function pixelLuts() {
  const out = new Uint8Array(3 * 0x200 * 4);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 0x200; i++) {
      const r = i & 7, g = (i >> 3) & 7, b = (i >> 6) & 7;
      const p = k === 0 ? makePixel(r, g, b) : k === 1 ? makePixel(r << 1, g << 1, b << 1) : makePixel(r + 7, g + 7, b + 7);
      dv.setUint32(o, rgba565(p), true);
      o += 4;
    }
  }
  return out;
}

const u32le = (vals) => {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v >>> 0, true));
  return out;
};

/**
 * [offset, bytes] pairs for every constant table the runtime reads.
 * @param {number[]} cycTable  m68ki_cycles (x7 master-clock values)
 * @param {number[][]} shiftTables  m68ki_shift_{8,16,32}_table
 * @param {{cycle2hc32:number[], cycle2hc40:number[]}} hvc
 */
export function dataSegments(cycTable, shiftTables, hvc) {
  const segs = [
    [NAMELUT, nameLut()],
    [HC32, Uint8Array.from(hvc.cycle2hc32)],
    [HC40, Uint8Array.from(hvc.cycle2hc40)],
    [PIXLUT, pixelLuts()],
    // Mode 4: CRAM 00BBGGRR, each 2-bit value expanded to 4 bits
    [PIXLUT_M4, u32le(Array.from({ length: 0x40 }, (_, i) => {
      const x = (v) => (v << 2) | v;
      return rgba565(makePixel(x(i & 3), x((i >> 2) & 3), x((i >> 4) & 3)));
    }))],
    [CYCTAB, Uint8Array.from(cycTable, (c) => Math.floor(c / 7))],
    [LUT, luts()],
  ];
  const sh = [];
  for (const t of shiftTables) {
    if (t.length !== 65) throw new Error("shift table length");
    sh.push(...t);
  }
  segs.push([SHIFT, u32le(sh)]);
  return segs;
}

// ---- VDP FIFO slot timing (vdp_ctrl.c) -----------------------------------------
const FIFO_H32 = [230, 510, 810, 970, 1130, 1450, 1610, 1770, 2090, 2250, 2410, 2730, 2890, 3050, 3350, 3370,
  ...[230, 510, 810, 970, 1130, 1450, 1610, 1770, 2090, 2250, 2410, 2730].map((x) => 3420 + x)];
const FIFO_H40 = [352, 820, 948, 1076, 1332, 1460, 1588, 1844, 1972, 2100, 2356, 2484, 2612, 2868, 2996, 3124, 3364, 3380,
  ...[352, 820, 948, 1076, 1332, 1460, 1588, 1844, 1972, 2100, 2356, 2484, 2612, 2868].map((x) => 3420 + x)];

export function fifoSegments() {
  const b32 = u32le(FIFO_H32.concat([0x7fffffff, 0x7fffffff, 0x7fffffff, 0x7fffffff])).slice(0, 0x80);
  const b40 = u32le(FIFO_H40);
  if (b40.length > 0x80) throw new Error("FIFO_H40 overflows its slot");
  return [[FIFOT32, b32], [FIFOT40, b40]];
}

/** hscroll_mask[4], shift_table[4], col_mask_table[4] read by vdp_reg_w. */
export function smallTables() {
  return [[SMALLT, Uint8Array.from([0x00, 0x07, 0xf8, 0xff, 6, 7, 0, 8, 0x0f, 0x1f, 0x0f, 0x3f])]];
}

// ---- Z80 flag tables (z80.c z80_init) -------------------------------------------
/** SZ/SZ_BIT/SZP/SZHV_inc/SZHV_dec/SZHVC_add/SZHVC_sub exactly as z80_init builds them. */
export function z80FlagTables() {
  const SF = 0x80, ZF = 0x40, YF = 0x20, XF = 0x08, HF = 0x10, PF = 0x04, VF = 0x04, NF = 0x02, CF = 0x01;
  const add = new Uint8Array(2 * 256 * 256), sub = new Uint8Array(2 * 256 * 256);
  let ia = 0;
  for (let old = 0; old < 256; old++) {
    for (let nw = 0; nw < 256; nw++) {
      let val = nw - old;
      let f = nw ? (nw & 0x80 ? SF : 0) : ZF;
      f |= nw & (YF | XF);
      if ((nw & 0x0f) < (old & 0x0f)) f |= HF;
      if (nw < old) f |= CF;
      if ((val ^ old ^ 0x80) & (val ^ nw) & 0x80) f |= VF;
      add[ia] = f;
      val = nw - old - 1;
      f = nw ? (nw & 0x80 ? SF : 0) : ZF;
      f |= nw & (YF | XF);
      if ((nw & 0x0f) <= (old & 0x0f)) f |= HF;
      if (nw <= old) f |= CF;
      if ((val ^ old ^ 0x80) & (val ^ nw) & 0x80) f |= VF;
      add[65536 + ia] = f;
      val = old - nw;
      f = NF | (nw ? (nw & 0x80 ? SF : 0) : ZF);
      f |= nw & (YF | XF);
      if ((nw & 0x0f) > (old & 0x0f)) f |= HF;
      if (nw > old) f |= CF;
      if ((val ^ old) & (old ^ nw) & 0x80) f |= VF;
      sub[ia] = f;
      val = old - nw - 1;
      f = NF | (nw ? (nw & 0x80 ? SF : 0) : ZF);
      f |= nw & (YF | XF);
      if ((nw & 0x0f) >= (old & 0x0f)) f |= HF;
      if (nw >= old) f |= CF;
      if ((val ^ old) & (old ^ nw) & 0x80) f |= VF;
      sub[65536 + ia] = f;
      ia++;
    }
  }
  const SZ = new Uint8Array(256), SZ_BIT = new Uint8Array(256), SZP = new Uint8Array(256);
  const INC = new Uint8Array(256), DEC = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let p = 0;
    for (let b = i; b; b >>= 1) p += b & 1;
    SZ[i] = i ? i & SF : ZF;
    SZ[i] |= i & (YF | XF);
    SZ_BIT[i] = i ? i & SF : ZF | PF;
    SZ_BIT[i] |= i & (YF | XF);
    SZP[i] = SZ[i] | (p & 1 ? 0 : PF);
    INC[i] = SZ[i];
    if (i === 0x80) INC[i] |= VF;
    if ((i & 0x0f) === 0) INC[i] |= HF;
    DEC[i] = SZ[i] | NF;
    if (i === 0x7f) DEC[i] |= VF;
    if ((i & 0x0f) === 0x0f) DEC[i] |= HF;
  }
  return { SZ, SZ_BIT, SZP, SZHV_inc: INC, SZHV_dec: DEC, SZHVC_add: add, SZHVC_sub: sub };
}

/** Where the Z80 handlers find their tables in linear memory. */
export function z80Layout() {
  const tabs = {
    SZHVC_add: ZT, SZHVC_sub: ZT + 0x20000, SZ: ZT + 0x40000, SZ_BIT: ZT + 0x40100,
    SZP: ZT + 0x40200, SZHV_inc: ZT + 0x40300, SZHV_dec: ZT + 0x40400,
  };
  const cc = {};
  ["cc_op", "cc_cb", "cc_ed", "cc_xy", "cc_xycb", "cc_ex"].forEach((n, k) => { cc[n] = ZT + 0x41000 + 0x200 * k; });
  return { ZREGS, tabs, cc, tbase: 0 };
}

export function z80Segments(layout, ccTables) {
  const ft = z80FlagTables();
  const segs = Object.entries(ft).map(([k, v]) => [layout.tabs[k], v]);
  for (const [n, off] of Object.entries(layout.cc)) {
    const b = new Uint8Array(512);
    ccTables[n].forEach((v, i) => { b[2 * i] = v & 0xff; b[2 * i + 1] = (v >> 8) & 0xff; });
    segs.push([off, b]);
  }
  return segs;
}

// =============================================================================
// WAT
// =============================================================================

const GLOBAL_NAMES = ["sp0", "sp4", "pc", "fx", "fn", "fz", "fv", "fc", "fs", "ft1", "imask", "ilevel",
  "stopped", "mc", "refresh", "mcend", "ir", "dummy", "trapped", "trappc",
  "curpc", "steps", "irqlat", "irqdelay", "irqdelay_lv",
  // VDP
  "v_status", "v_pending", "v_code", "v_addr", "v_addr_latch", "v_hint_pending",
  "v_vint_pending", "v_dma_length", "v_dma_end", "v_dma_type", "v_dma_src",
  "v_dmafill", "v_fifo_idx", "v_fifo_byte_access", "v_border",
  "v_sat_base_mask", "v_sat_addr_mask", "v_satb", "v_ntab", "v_ntbb", "v_ntwb",
  "v_hscb", "v_hscroll_mask", "v_pf_shift", "v_pf_col_mask", "v_pf_row_mask",
  "v_odd_frame", "v_interlaced", "v_im2", "v_h_counter", "v_v_counter",
  "v_vc_max", "v_hvc_latch", "v_vint_cycle", "v_hblank_start", "v_hblank_end",
  "v_h40", "v_max_sprite_pixels", "vp_w", "vp_h", "vp_changed", "vp_ow", "vp_oh",
  "mcvdp", "spr_ovr", "v_mode4data", "v_cached_write",
  // io / z80 bus
  "zstate", "pad0", "pad1", "th0_state", "th0_lat", "th1_state", "th1_lat",
  "region", "frames", "nvint", "nhint", "ndma", "nz80r", "z80rpc", "nlock",
  "lockpc", "ymread", "fm_busy", "ym_status", "z80irq", "nredraw", "nm4", "nim2",
  // 6-button pads (gamepad.c Counter / Timeout per port)
  "th0_cnt", "th0_to", "th1_cnt", "th1_to",
  // m68ki_cpu.instr_mode / run_mode (address error frames)
  "instrmode", "runmode", "pad2", "pad3"];

export function globalsWat() {
  const g = [];
  for (let i = 0; i < 16; i++) g.push(`(global $r${i} (mut i32) (i32.const 0))`);
  for (const n of GLOBAL_NAMES) g.push(`(global $${n} (mut i32) (i32.const 0))`);
  return g.join("\n  ");
}

function _tile_unrolled(order) {
  return order.map((nib, p) => `(i32.store8 (i32.add (local.get $dst) (i32.const ${p})) ` +
    `(i32.or (i32.and (i32.shr_u (local.get $bp) (i32.const ${nib * 4})) (i32.const 15)) (local.get $atex)))`).join("\n        ");
}

// CPU runtime (hand-transcribed from m68kcpu.h / m68kops.h helpers)
export function cpuWat() {
  return `
  (func $trap (global.set $trapped (i32.const 1)) (global.set $trappc (global.get $curpc)))

  ;; m68ki_set_s_flag: sp[s_flag] = A7; s_flag = v; A7 = sp[s_flag]
  (func $set_s_flag (param $v i32)
    (if (global.get $fs) (then (global.set $sp4 (global.get $r15)))
                         (else (global.set $sp0 (global.get $r15))))
    (global.set $fs (local.get $v))
    (if (global.get $fs) (then (global.set $r15 (global.get $sp4)))
                         (else (global.set $r15 (global.get $sp0)))))

  (func $get_sr (result i32)
    (i32.or (i32.or (i32.or (global.get $ft1) (i32.shl (global.get $fs) (i32.const 11)))
                    (global.get $imask))
      (i32.or (i32.or (i32.or (i32.or
        (i32.shr_u (i32.and (global.get $fx) (i32.const 0x100)) (i32.const 4))
        (i32.shr_u (i32.and (global.get $fn) (i32.const 0x80)) (i32.const 4)))
        (i32.shl (i32.eqz (global.get $fz)) (i32.const 2)))
        (i32.shr_u (i32.and (global.get $fv) (i32.const 0x80)) (i32.const 6)))
        (i32.shr_u (i32.and (global.get $fc) (i32.const 0x100)) (i32.const 8)))))

  (func $set_sr (param $v i32)
    (global.set $ft1 (i32.and (local.get $v) (i32.const 0x8000)))
    (global.set $imask (i32.and (local.get $v) (i32.const 0x0700)))
    (global.set $fx (i32.shl (i32.and (local.get $v) (i32.const 0x10)) (i32.const 4)))
    (global.set $fn (i32.shl (i32.and (local.get $v) (i32.const 0x08)) (i32.const 4)))
    (global.set $fz (i32.eqz (i32.and (local.get $v) (i32.const 0x04))))
    (global.set $fv (i32.shl (i32.and (local.get $v) (i32.const 0x02)) (i32.const 6)))
    (global.set $fc (i32.shl (i32.and (local.get $v) (i32.const 0x01)) (i32.const 8)))
    (call $set_s_flag (i32.and (i32.shr_u (local.get $v) (i32.const 11)) (i32.const 4)))
    (call $check_int))

  (func $check_int
    (if (i32.gt_u (global.get $ilevel) (global.get $imask))
      (then (call $exception_interrupt (i32.shr_u (global.get $ilevel) (i32.const 8))))))

  ;; m68ki_exception_address_error, entered from an arm (see ctrans) in place
  ;; of the handler's longjmp: fc is FLAG_S | FUNCTION_CODE_USER_DATA as the
  ;; access saw it. A second address error before rte halts the CPU.
  (func $address_error (param $a i32) (param $mode i32)
    (local $sr i32) (local $fc i32)
    (local.set $fc (i32.or (global.get $fs) (i32.const 1)))
    (local.set $sr (call $get_sr))
    (global.set $ft1 (i32.const 0))
    (call $set_s_flag (i32.const 4))
    (if (global.get $runmode)
      (then (global.set $stopped (i32.const 2))
            (global.set $mc (i32.sub (global.get $mcend)
              (i32.mul (i32.load8_u (i32.add (i32.const ${CYCTAB}) (global.get $ir))) (i32.const 7))))
            (return)))
    (global.set $runmode (i32.const 1))
    ;; m68ki_stack_frame_buserr
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 4)))
    (call $wr32 (global.get $r15) (global.get $pc))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 2)))
    (call $wr16 (global.get $r15) (local.get $sr))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 2)))
    (call $wr16 (global.get $r15) (global.get $ir))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 4)))
    (call $wr32 (global.get $r15) (local.get $a))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 2)))
    (call $wr16 (global.get $r15) (i32.or (i32.or (local.get $mode) (global.get $instrmode)) (local.get $fc)))
    (global.set $pc (call $rd32 (i32.const 12)))
    ;; CYC_EXCEPTION[3] - CYC_INSTRUCTION[ir] (the handler's own cycles never ran)
    (global.set $mc (i32.add (global.get $mc) (i32.sub (i32.const 350)
      (i32.mul (i32.load8_u (i32.add (i32.const ${CYCTAB}) (global.get $ir))) (i32.const 7))))))

  ;; m68ki_exception_interrupt
  (func $exception_interrupt (param $lv i32)
    (local $sr i32) (local $npc i32) (local $vec i32)
    (global.set $instrmode (i32.const 8))
    (global.set $stopped (i32.and (global.get $stopped) (i32.const 6)))
    (if (global.get $stopped) (then (return)))
    (call $trace (i32.or (i32.const 0x80000000) (local.get $lv)))
    (local.set $vec (i32.add (i32.const 24) (local.get $lv)))
    (local.set $sr (call $get_sr))
    (global.set $ft1 (i32.const 0))
    (call $set_s_flag (i32.const 4))
    (global.set $imask (i32.shl (local.get $lv) (i32.const 8)))
    (call $vdp_68k_irq_ack (local.get $lv))
    (local.set $npc (call $rd32 (i32.shl (local.get $vec) (i32.const 2))))
    (if (i32.eqz (local.get $npc)) (then (local.set $npc (call $rd32 (i32.const 60)))))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 4)))
    (call $wr32 (global.get $r15) (global.get $pc))
    (global.set $r15 (i32.sub (global.get $r15) (i32.const 2)))
    (call $wr16 (global.get $r15) (local.get $sr))
    (global.set $pc (local.get $npc))
    ;; m68ki_cycle_interrupts[(cycles / 7) % 10] = {50,59,58,...,51} * 7
    (local.set $vec (i32.rem_s (i32.div_s (global.get $mc) (i32.const 7)) (i32.const 10)))
    (global.set $mc (i32.add (global.get $mc)
      (i32.mul (i32.const 7)
        (select (i32.const 50) (i32.sub (i32.const 60) (local.get $vec))
                (i32.eqz (local.get $vec)))))))

  (func $use_divu (param $dst i32) (param $src i32)
    (local $i i32) (local $mc i32)
    (local.set $mc (i32.const ${76 * 7}))
    (local.set $src (i32.shl (local.get $src) (i32.const 16)))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $i) (i32.const 15)))
      (if (i32.lt_s (local.get $dst) (i32.const 0))
        (then (local.set $dst (i32.shl (local.get $dst) (i32.const 1)))
              (local.set $dst (i32.sub (local.get $dst) (local.get $src))))
        (else (local.set $dst (i32.shl (local.get $dst) (i32.const 1)))
              (local.set $mc (i32.add (local.get $mc) (i32.const 28)))
              (if (i32.ge_u (local.get $dst) (local.get $src))
                (then (local.set $dst (i32.sub (local.get $dst) (local.get $src)))
                      (local.set $mc (i32.sub (local.get $mc) (i32.const 14)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (global.set $mc (i32.add (global.get $mc) (local.get $mc)))
    (if (i32.ge_s (global.get $mc) (global.get $refresh))
      (then (global.set $refresh (i32.add (global.get $refresh) (i32.const 896))))))

  (func $iabs (param $v i32) (result i32)
    (select (i32.sub (i32.const 0) (local.get $v)) (local.get $v)
            (i32.lt_s (local.get $v) (i32.const 0))))

  (func $use_divs (param $dst i32) (param $src i32)
    (local $i i32) (local $mc i32) (local $q i32)
    ;; src arrives as the (sint16) value already sign-extended by the caller
    (local.set $mc (i32.const ${12 * 7}))
    (if (i32.lt_s (local.get $dst) (i32.const 0))
      (then (local.set $mc (i32.add (local.get $mc) (i32.const 14)))))
    (if (i32.lt_s (i32.shr_s (call $iabs (local.get $dst)) (i32.const 16)) (call $iabs (local.get $src)))
      (then
        (local.set $q (i32.div_u (call $iabs (local.get $dst)) (call $iabs (local.get $src))))
        (local.set $mc (i32.add (local.get $mc) (i32.const ${110 * 7})))
        (if (i32.ge_s (local.get $src) (i32.const 0))
          (then (if (i32.ge_s (local.get $dst) (i32.const 0))
                  (then (local.set $mc (i32.sub (local.get $mc) (i32.const 14))))
                  (else (local.set $mc (i32.add (local.get $mc) (i32.const 14)))))))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (i32.const 15)))
          (local.set $q (i32.shr_u (local.get $q) (i32.const 1)))
          (if (i32.eqz (i32.and (local.get $q) (i32.const 1)))
            (then (local.set $mc (i32.add (local.get $mc) (i32.const 14)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l))))
      (else (local.set $mc (i32.add (local.get $mc) (i32.const 28)))))
    (global.set $mc (i32.add (global.get $mc) (local.get $mc)))
    (if (i32.ge_s (global.get $mc) (global.get $refresh))
      (then (global.set $refresh (i32.add (global.get $refresh) (i32.const 896))))))

  (func $use_mulu (param $src i32)
    (local $mc i32)
    (local.set $src (i32.and (local.get $src) (i32.const 0xFFFF)))
    (local.set $mc (i32.add (i32.const ${38 * 7})
      (i32.mul (i32.popcnt (local.get $src)) (i32.const 14))))
    (global.set $mc (i32.add (global.get $mc) (local.get $mc))))

  (func $use_muls (param $src i32)
    (local $t i32)
    ;; tmp = src << 1 (as sint16 promoted); tmp = (tmp ^ src) & 0xFFFF
    (local.set $src (i32.extend16_s (local.get $src)))
    (local.set $t (i32.and (i32.xor (i32.shl (local.get $src) (i32.const 1)) (local.get $src))
                           (i32.const 0xFFFF)))
    (global.set $mc (i32.add (global.get $mc)
      (i32.add (i32.const ${38 * 7}) (i32.mul (i32.popcnt (local.get $t)) (i32.const 14))))))

  (func $tab_m68ki_shift_8_table (param $i i32) (result i32)
    (i32.load (i32.add (i32.const ${SHIFT}) (i32.shl (local.get $i) (i32.const 2)))))
  (func $tab_m68ki_shift_16_table (param $i i32) (result i32)
    (i32.load (i32.add (i32.const ${SHIFT + 65 * 4}) (i32.shl (local.get $i) (i32.const 2)))))
  (func $tab_m68ki_shift_32_table (param $i i32) (result i32)
    (i32.load (i32.add (i32.const ${SHIFT + 130 * 4}) (i32.shl (local.get $i) (i32.const 2)))))
`;
}

// memory map (genesis.c gen_init, md_cart.c, mem68k.c). romsize is the
// power-of-two mirror size (cart.mask + 1).
export function memWat(romimg, romsize, hw = null) {
  const rmask = romsize - 1;
  // rom_database register banks (md_cart_init: memory_map[bank_start..bank_end])
  const inRegs = (p) => `(i32.and (i32.ge_u ${p} (i32.const ${hw ? hw.bankStart : 0})) (i32.le_u ${p} (i32.const ${hw ? hw.bankEnd : 0})))`;
  const regsR8 = hw && hw.regsR ? `
    (if ${inRegs("(local.get $p)")} (then (return (call $regs_r (local.get $a)))))` : "";
  const regsR16 = hw && hw.regsR ? `
    (if ${inRegs("(local.get $p)")} (then (return (call $regs_r (local.get $a)))))` : "";
  const regsW = hw && hw.regsW ? `
    (if ${inRegs("(local.get $p)")} (then (call $regs_w (local.get $a) (local.get $v)) (return)))` : "";
  const ZCYC = ZREGS + 64;
  return `
  ;; raw 16-bit read of whatever a memory_map base points at: the prefetch /
  ;; open-bus source. ROM mirrors inside $000000-$3FFFFF; $400000-$7FFFFF is
  ;; cart.rom + offset in gpgx (beyond the ROM, 0xFF padding); RAM elsewhere.
  (func $raw16 (param $a i32) (result i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFE)))
    (if (i32.lt_u (local.get $a) (i32.const 0x400000)) (then (return (call $cart_rd16 (local.get $a)))))
    (if (i32.lt_u (local.get $a) (i32.const 0x800000))
      (then (if (i32.lt_u (local.get $a) (i32.const ${romsize}))
              (then (return (i32.or
                (i32.shl (i32.load8_u (i32.add (i32.const ${romimg}) (local.get $a))) (i32.const 8))
                (i32.load8_u (i32.add (i32.const ${romimg}) (i32.add (local.get $a) (i32.const 1))))))))
            (return (i32.const 0xFFFF))))
    (i32.or (i32.shl (i32.load8_u (i32.and (local.get $a) (i32.const 0xFFFF))) (i32.const 8))
            (i32.load8_u (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFFFF)))))
  (func $raw8 (param $a i32) (result i32)
    (if (result i32) (i32.and (local.get $a) (i32.const 1))
      (then (i32.and (call $raw16 (local.get $a)) (i32.const 0xFF)))
      (else (i32.shr_u (call $raw16 (local.get $a)) (i32.const 8)))))

  ;; m68k_read_bus_8/16: the prefetched instruction stream at m68k.pc
  (func $bus8 (param $a i32) (result i32)
    (call $raw8 (i32.or (global.get $pc) (i32.and (local.get $a) (i32.const 1)))))
  (func $bus16 (result i32) (call $raw16 (global.get $pc)))

  ;; m68k_lockup_*: the 68000 is halted for good (no DTACK). A trap here is the
  ;; visible version of that and names the address.
  (func $lockup (param $a i32)
    (global.set $nlock (i32.add (global.get $nlock) (i32.const 1)))
    (global.set $lockpc (local.get $a))
    (global.set $stopped (i32.or (global.get $stopped) (i32.const 2)))
    (global.set $mc (global.get $mcend)))

  (func $rd8 (param $a i32) (result i32)
    (local $p i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $p (i32.shr_u (local.get $a) (i32.const 16)))
    (if (i32.ge_u (local.get $p) (i32.const 0xE0))
      (then (return (i32.load8_u (i32.and (local.get $a) (i32.const 0xFFFF))))))
    (if (i32.lt_u (local.get $p) (i32.const 0x40)) (then (return (call $cart_rd8 (local.get $a)))))${regsR8}
    (if (i32.lt_u (local.get $p) (i32.const 0x80)) (then (return (call $bus8 (local.get $a)))))
    (if (i32.eq (local.get $p) (i32.const 0xA0)) (then (return (call $z80_rd8 (local.get $a)))))
    (if (i32.eq (local.get $p) (i32.const 0xA1)) (then (return (call $io_rd8 (local.get $a)))))
    (if (i32.and (i32.ge_u (local.get $p) (i32.const 0xC0))
                 (i32.eqz (i32.and (local.get $p) (i32.const 7))))
      (then (return (call $vdp_rd8 (local.get $a)))))
    (call $lockup (local.get $a))
    (call $bus8 (local.get $a)))

  (func $rd16 (param $a i32) (result i32)
    (local $p i32)
    (if (i32.and (local.get $a) (i32.const 1)) (then (call $trap)))
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $p (i32.shr_u (local.get $a) (i32.const 16)))
    (if (i32.ge_u (local.get $p) (i32.const 0xE0))
      (then (return (i32.or
        (i32.shl (i32.load8_u (i32.and (local.get $a) (i32.const 0xFFFF))) (i32.const 8))
        (i32.load8_u (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFFFF)))))))
    (if (i32.lt_u (local.get $p) (i32.const 0x40)) (then (return (call $cart_rd16 (local.get $a)))))${regsR16}
    (if (i32.lt_u (local.get $p) (i32.const 0x80)) (then (return (call $bus16))))
    (if (i32.eq (local.get $p) (i32.const 0xA0))
      (then (return (i32.mul (call $z80_rd8 (local.get $a)) (i32.const 0x101)))))
    (if (i32.eq (local.get $p) (i32.const 0xA1)) (then (return (call $io_rd16 (local.get $a)))))
    (if (i32.and (i32.ge_u (local.get $p) (i32.const 0xC0))
                 (i32.eqz (i32.and (local.get $p) (i32.const 7))))
      (then (return (call $vdp_rd16 (local.get $a)))))
    (call $lockup (local.get $a))
    (call $bus16))

  (func $rd32 (param $a i32) (result i32)
    (local $h i32)
    (if (i32.and (local.get $a) (i32.const 1)) (then (call $trap)))
    (local.set $h (call $rd16 (local.get $a)))
    (i32.or (i32.shl (local.get $h) (i32.const 16)) (call $rd16 (i32.add (local.get $a) (i32.const 2)))))

  (func $wr8 (param $a i32) (param $v i32)
    (local $p i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $p (i32.shr_u (local.get $a) (i32.const 16)))
    (if (i32.ge_u (local.get $p) (i32.const 0xE0))
      (then (i32.store8 (i32.and (local.get $a) (i32.const 0xFFFF)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $p) (i32.const 0x40)) (then (call $cart_wr8 (local.get $a) (local.get $v)) (return)))${regsW}
    (if (i32.lt_u (local.get $p) (i32.const 0x80)) (then (return)))
    (if (i32.eq (local.get $p) (i32.const 0xA0)) (then (call $z80_wr8 (local.get $a) (local.get $v)) (return)))
    (if (i32.eq (local.get $p) (i32.const 0xA1)) (then (call $io_wr8 (local.get $a) (local.get $v)) (return)))
    (if (i32.and (i32.ge_u (local.get $p) (i32.const 0xC0))
                 (i32.eqz (i32.and (local.get $p) (i32.const 7))))
      (then (call $vdp_wr8 (local.get $a) (i32.and (local.get $v) (i32.const 0xFF))) (return)))
    (call $lockup (local.get $a)))

  (func $wr16 (param $a i32) (param $v i32)
    (local $p i32)
    (if (i32.and (local.get $a) (i32.const 1)) (then (call $trap)))
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFFFF)))
    (local.set $p (i32.shr_u (local.get $a) (i32.const 16)))
    (if (i32.ge_u (local.get $p) (i32.const 0xE0))
      (then (i32.store8 (i32.and (local.get $a) (i32.const 0xFFFF)) (i32.shr_u (local.get $v) (i32.const 8)))
            (i32.store8 (i32.and (i32.add (local.get $a) (i32.const 1)) (i32.const 0xFFFF)) (local.get $v))
            (return)))
    (if (i32.lt_u (local.get $p) (i32.const 0x40)) (then (call $cart_wr16 (local.get $a) (local.get $v)) (return)))${regsW}
    (if (i32.lt_u (local.get $p) (i32.const 0x80)) (then (return)))
    (if (i32.eq (local.get $p) (i32.const 0xA0))
      (then (call $z80_wr8 (local.get $a) (i32.shr_u (local.get $v) (i32.const 8))) (return)))
    (if (i32.eq (local.get $p) (i32.const 0xA1)) (then (call $io_wr16 (local.get $a) (local.get $v)) (return)))
    (if (i32.and (i32.ge_u (local.get $p) (i32.const 0xC0))
                 (i32.eqz (i32.and (local.get $p) (i32.const 7))))
      (then (call $vdp_wr16 (local.get $a) (local.get $v)) (return)))
    (call $lockup (local.get $a)))

  (func $wr32 (param $a i32) (param $v i32)
    (if (i32.and (local.get $a) (i32.const 1)) (then (call $trap)))
    (call $wr16 (local.get $a) (i32.shr_u (local.get $v) (i32.const 16)))
    (call $wr16 (i32.add (local.get $a) (i32.const 2)) (i32.and (local.get $v) (i32.const 0xFFFF))))

  ;; ---- Z80 bus (memz80 / genesis.c) -------------------------------------
  ;; The 68000 sees Z80 space only while it holds the bus with the Z80 out of
  ;; reset (zstate == 3); otherwise the map is open bus / ignored writes.
  (func $z80_rd8 (param $a i32) (result i32)
    (if (i32.eqz (global.get $zmap)) (then (return (call $bus8 (local.get $a)))))
    (global.set $mc (i32.add (global.get $mc) (i32.const 7)))
    (global.set $nz80r (i32.add (global.get $nz80r) (i32.const 1)))
    (global.set $z80rpc (global.get $curpc))
    (block $sw
      (br_if $sw (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 3)) (i32.const 2)))
      (global.set $ymread (i32.add (global.get $ymread) (i32.const 1)))
      (return (call $fm_read (global.get $mc) (i32.and (local.get $a) (i32.const 3)))))
    (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 3)) (i32.const 3))
      (then
        (if (i32.eq (i32.and (local.get $a) (i32.const 0xFF00)) (i32.const 0x7F00))
          (then (call $lockup (local.get $a)) (return (call $bus8 (local.get $a)))))
        (return (i32.or (call $bus8 (local.get $a)) (i32.const 0xFF)))))
    (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (local.get $a) (i32.const 0x1FFF)))))

  (func $z80_wr8 (param $a i32) (param $v i32)
    (if (i32.eqz (global.get $zmap)) (then (return)))
    (global.set $mc (i32.add (global.get $mc) (i32.const 7)))
    (block $sw
      (br_if $sw (i32.ne (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 3)) (i32.const 2)))
      (call $fm_write (global.get $mc) (i32.and (local.get $a) (i32.const 3)) (local.get $v))
      (return))
    (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 3)) (i32.const 3))
      (then
        (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0x7F)) (i32.const 0x60))
          (then (global.set $zbank (i32.and (i32.or (i32.shr_u (global.get $zbank) (i32.const 1))
                                                    (i32.shl (i32.and (local.get $v) (i32.const 1)) (i32.const 23)))
                                            (i32.const 0xFF8000)))
                (return)))
        (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0x7F)) (i32.const 0x7F))
          (then (call $lockup (local.get $a))))
        (return)))
    (i32.store8 (i32.add (i32.const ${ZRAM}) (i32.and (local.get $a) (i32.const 0x1FFF))) (local.get $v)))

  ;; gen_zbusreq_w / gen_zreset_w (the cycles argument is m68k.cycles)
  (func $zbusreq_w (param $d i32)
    (if (local.get $d)
      (then (if (i32.eq (global.get $zstate) (i32.const 1))
              (then (call $z80_run (global.get $mc)) (global.set $zmap (i32.const 1))))
            (global.set $zstate (i32.or (global.get $zstate) (i32.const 2))))
      (else (if (i32.eq (global.get $zstate) (i32.const 3))
              (then (call $z80_sync) (global.set $zmap (i32.const 0))))
            (global.set $zstate (i32.and (global.get $zstate) (i32.const 1))))))
  (func $zreset_w (param $d i32)
    (if (local.get $d)
      (then (if (i32.eqz (global.get $zstate))
              (then (call $z80_sync) (call $z80_reset) (call $fm_reset (global.get $mc)))
              (else (if (i32.eq (global.get $zstate) (i32.const 2))
                      (then (global.set $zmap (i32.const 1)) (call $z80_reset) (call $fm_reset (global.get $mc))))))
            (global.set $zstate (i32.or (global.get $zstate) (i32.const 1))))
      (else (if (i32.eq (global.get $zstate) (i32.const 1))
              (then (call $z80_run (global.get $mc)))
              (else (if (i32.eq (global.get $zstate) (i32.const 3)) (then (global.set $zmap (i32.const 0))))))
            (global.set $zstate (i32.and (global.get $zstate) (i32.const 2))))))
  ;; Z80 cycles should remain a multiple of 15 master clocks
  (func $z80_sync
    (i32.store (i32.const ${ZCYC}) (i32.mul (i32.div_u (i32.add (global.get $mc) (i32.const 14)) (i32.const 15)) (i32.const 15))))
`;
}

// I/O chip (io_ctrl.c) + 3- or 6-button pads (input_hw/gamepad.c). gpgx
// connects 6-button pads when the header's I/O field lists '6'
// (input_init: rominfo.peripherals & 2), 3-button ones otherwise.
export function ioWat(opts = {}) {
  const six = !!opts.sixButton;
  const IOR = PROBE + 0x30; // io_reg[16]
  return `
  (func $ioreg (param $i i32) (result i32) (i32.load8_u (i32.add (i32.const ${IOR}) (local.get $i))))
  (func $ioreg_set (param $i i32) (param $v i32) (i32.store8 (i32.add (i32.const ${IOR}) (local.get $i)) (local.get $v)))

  (func $io_reset
    (call $ioreg_set (i32.const 0) (i32.or (global.get $region) (i32.const 0x20)))
    (call $ioreg_set (i32.const 1) (i32.const 0)) (call $ioreg_set (i32.const 2) (i32.const 0))
    (call $ioreg_set (i32.const 3) (i32.const 0)) (call $ioreg_set (i32.const 4) (i32.const 0))
    (call $ioreg_set (i32.const 5) (i32.const 0)) (call $ioreg_set (i32.const 6) (i32.const 0))
    (call $ioreg_set (i32.const 7) (i32.const 0xFF)) (call $ioreg_set (i32.const 8) (i32.const 0))
    (call $ioreg_set (i32.const 9) (i32.const 0)) (call $ioreg_set (i32.const 10) (i32.const 0xFF))
    (call $ioreg_set (i32.const 11) (i32.const 0)) (call $ioreg_set (i32.const 12) (i32.const 0))
    (call $ioreg_set (i32.const 13) (i32.const 0xFB)) (call $ioreg_set (i32.const 14) (i32.const 0))
    (call $ioreg_set (i32.const 15) (i32.const 0))
    (global.set $th0_state (i32.const 0x40)) (global.set $th1_state (i32.const 0x40)))

  ;; gamepad_read. pad bits: UP 1 DOWN 2 LEFT 4 RIGHT 8 B 0x10 C 0x20
  ;; A 0x40 START 0x80 Z 0x100 Y 0x200 X 0x400 MODE 0x800 (gpgx INPUT_*).
  (func $gamepad_read (param $port i32) (result i32)
    (local $data i32) (local $pad i32) (local $step i32) (local $st i32) (local $lat i32)
    (local.set $st (select (global.get $th1_state) (global.get $th0_state) (local.get $port)))
    (local.set $lat (select (global.get $th1_lat) (global.get $th0_lat) (local.get $port)))
    (local.set $pad (select (global.get $pad1) (global.get $pad0) (local.get $port)))
    (local.set $data (i32.or (local.get $st) (i32.const 0x3F)))
    (local.set $step (i32.or (select (global.get $th1_cnt) (global.get $th0_cnt) (local.get $port))
                             (i32.shr_u (local.get $data) (i32.const 6))))
    (if (i32.lt_s (global.get $mc) (local.get $lat))
      (then (local.set $step (i32.and (local.get $step) (i32.const -2)))))
    ;; 6-button sequence: 3rd low = signature, 4th high = MXYZ, 4th low = 1111
    (if (i32.eq (local.get $step) (i32.const 4))
      (then (return (i32.and (local.get $data) (i32.xor (i32.or (i32.and (i32.shr_u (local.get $pad) (i32.const 2)) (i32.const 0x30)) (i32.const 0x0F)) (i32.const -1))))))
    (if (i32.eq (local.get $step) (i32.const 7))
      (then (return (i32.and (local.get $data) (i32.xor (i32.or (i32.and (local.get $pad) (i32.const 0x30)) (i32.and (i32.shr_u (local.get $pad) (i32.const 8)) (i32.const 0x0F))) (i32.const -1))))))
    (if (i32.eq (local.get $step) (i32.const 6))
      (then (return (i32.and (local.get $data) (i32.xor (i32.and (i32.shr_u (local.get $pad) (i32.const 2)) (i32.const 0x30)) (i32.const -1))))))
    (if (i32.and (local.get $step) (i32.const 1))
      (then (local.set $data (i32.and (local.get $data)
              (i32.xor (i32.and (local.get $pad) (i32.const 0x3F)) (i32.const -1)))))
      (else (local.set $data (i32.and (local.get $data)
              (i32.xor (i32.or (i32.or (i32.and (local.get $pad) (i32.const 3))
                                       (i32.and (i32.shr_u (local.get $pad) (i32.const 2)) (i32.const 0x30)))
                               (i32.const 0x0C)) (i32.const -1))))))
    (local.get $data))

  (func $gamepad_write (param $port i32) (param $data i32) (param $mask i32)
    (if (i32.and (local.get $mask) (i32.const 0x40))
      (then (local.set $data (i32.and (local.get $data) (i32.const 0x40)))
            (if (local.get $port) (then (global.set $th1_lat (i32.const 0)))
                                  (else (global.set $th0_lat (i32.const 0))))${six ? `
            ;; 6-button pad: count TH 0->1 transitions (up to 4)
            (if (i32.and (i32.ne (local.get $data) (i32.const 0)) (i32.eqz (select (global.get $th1_state) (global.get $th0_state) (local.get $port))))
              (then (if (local.get $port)
                      (then (if (i32.lt_u (global.get $th1_cnt) (i32.const 8))
                              (then (global.set $th1_cnt (i32.add (global.get $th1_cnt) (i32.const 2))) (global.set $th1_to (i32.const 0)))))
                      (else (if (i32.lt_u (global.get $th0_cnt) (i32.const 8))
                              (then (global.set $th0_cnt (i32.add (global.get $th0_cnt) (i32.const 2))) (global.set $th0_to (i32.const 0))))))))` : ""})
      (else
        (local.set $data (i32.const 0x40))
        (if (local.get $port)
          (then (if (i32.eqz (global.get $th1_state))
                  (then (global.set $th1_lat (i32.add (global.get $mc) (i32.const 172))))))
          (else (if (i32.eqz (global.get $th0_state))
                  (then (global.set $th0_lat (i32.add (global.get $mc) (i32.const 172)))))))))
    (if (local.get $port) (then (global.set $th1_state (local.get $data)))
                          (else (global.set $th0_state (local.get $data)))))

  ;; input_refresh -> gamepad_refresh, once a line: a 6-button pad drops
  ;; back to the start of its sequence when TH stops toggling
  (func $input_refresh${six ? `
    (if (i32.gt_u (global.get $th0_to) (i32.const 25)) (then (global.set $th0_cnt (i32.const 0)) (global.set $th0_to (i32.const 0)))
      (else (global.set $th0_to (i32.add (global.get $th0_to) (i32.const 1)))))
    (if (i32.gt_u (global.get $th1_to) (i32.const 25)) (then (global.set $th1_cnt (i32.const 0)) (global.set $th1_to (i32.const 0)))
      (else (global.set $th1_to (i32.add (global.get $th1_to) (i32.const 1)))))` : ""})

  (func $port_data_r (param $i i32) (result i32)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (return (call $gamepad_read (i32.const 0)))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (return (call $gamepad_read (i32.const 1)))))
    (i32.const 0x7F))
  (func $port_data_w (param $i i32) (param $d i32) (param $m i32)
    (if (i32.lt_u (local.get $i) (i32.const 2))
      (then (call $gamepad_write (local.get $i) (local.get $d) (local.get $m)))))

  (func $io_68k_read (param $o i32) (result i32)
    (local $mask i32)
    (if (i32.and (i32.ge_u (local.get $o) (i32.const 1)) (i32.le_u (local.get $o) (i32.const 3)))
      (then
        (local.set $mask (i32.or (i32.const 0x80) (call $ioreg (i32.add (local.get $o) (i32.const 3)))))
        (return (i32.or (i32.and (call $ioreg (local.get $o)) (local.get $mask))
                        (i32.and (call $port_data_r (i32.sub (local.get $o) (i32.const 1)))
                                 (i32.xor (local.get $mask) (i32.const -1)))))))
    (call $ioreg (local.get $o)))

  (func $io_68k_write (param $o i32) (param $d i32)
    (if (i32.and (i32.ge_u (local.get $o) (i32.const 1)) (i32.le_u (local.get $o) (i32.const 3)))
      (then (call $ioreg_set (local.get $o) (local.get $d))
            (call $port_data_w (i32.sub (local.get $o) (i32.const 1)) (local.get $d)
                  (call $ioreg (i32.add (local.get $o) (i32.const 3))))
            (return)))
    (if (i32.and (i32.ge_u (local.get $o) (i32.const 4)) (i32.le_u (local.get $o) (i32.const 6)))
      (then (if (i32.ne (local.get $d) (call $ioreg (local.get $o)))
              (then (call $ioreg_set (local.get $o) (local.get $d))
                    (call $port_data_w (i32.sub (local.get $o) (i32.const 4))
                          (call $ioreg (i32.sub (local.get $o) (i32.const 3))) (local.get $d))))
            (return)))
    (if (i32.or (i32.or (i32.eq (local.get $o) (i32.const 7)) (i32.eq (local.get $o) (i32.const 10)))
                (i32.eq (local.get $o) (i32.const 13)))
      (then (call $ioreg_set (local.get $o) (local.get $d)) (return)))
    (if (i32.or (i32.or (i32.eq (local.get $o) (i32.const 9)) (i32.eq (local.get $o) (i32.const 12)))
                (i32.eq (local.get $o) (i32.const 15)))
      (then (call $ioreg_set (local.get $o) (i32.and (local.get $d) (i32.const 0xF8))) (return))))

  (func $io_rd8 (param $a i32) (result i32)
    (local $s i32) (local $d i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))${opts.timeR ? `
    ;; cart.hw.time_r (the byte of the word it returns)
    (if (i32.eq (local.get $s) (i32.const 0x30))
      (then (local.set $d (call $${opts.timeR} (local.get $a)))
            (return (select (i32.and (local.get $d) (i32.const 0xFF)) (i32.and (i32.shr_u (local.get $d) (i32.const 8)) (i32.const 0xFF)) (i32.and (local.get $a) (i32.const 1))))))` : ""}
    (if (i32.eqz (local.get $s))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 0xE0)))
              (then (return (call $io_68k_read (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xF))))))
            (return (call $bus8 (local.get $a)))))
    (if (i32.eq (local.get $s) (i32.const 0x11))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 1)))
              (then (local.set $d (call $raw8 (global.get $pc)))
                    (if (i32.eq (global.get $zstate) (i32.const 3))
                      (then (return (i32.and (local.get $d) (i32.const 0xFE)))))
                    (return (i32.or (local.get $d) (i32.const 1)))))
            (return (call $bus8 (local.get $a)))))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x12)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x13)) (i32.eq (local.get $s) (i32.const 0x40)))
                        (i32.or (i32.eq (local.get $s) (i32.const 0x44)) (i32.or (i32.eq (local.get $s) (i32.const 0x30))
                                                                                (i32.eq (local.get $s) (i32.const 0x41))))))
      (then (return (call $bus8 (local.get $a)))))
    (if (i32.eq (local.get $s) (i32.const 0x20)) (then (return (call $bus8 (local.get $a)))))
    (if (i32.eq (local.get $s) (i32.const 0x50)) (then${opts.svp ? `
      ;; SVP: XST / PM0 status (mem68k.c case 0x50)
      (local.set $d (call $svp_ctrl_r8 (local.get $a)))
      (if (i32.ge_s (local.get $d) (i32.const 0)) (then (return (local.get $d))))` : ""} (return (call $bus8 (local.get $a)))))
    (call $lockup (local.get $a))
    (call $bus8 (local.get $a)))

  (func $io_rd16 (param $a i32) (result i32)
    (local $s i32) (local $d i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))${opts.timeR ? `
    (if (i32.eq (local.get $s) (i32.const 0x30)) (then (return (call $${opts.timeR} (local.get $a)))))` : ""}
    (if (i32.eqz (local.get $s))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 0xE0)))
              (then (local.set $d (call $io_68k_read (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xF))))
                    (return (i32.or (i32.shl (local.get $d) (i32.const 8)) (local.get $d)))))
            (return (call $bus16))))
    (if (i32.eq (local.get $s) (i32.const 0x11))
      (then (local.set $d (call $raw16 (global.get $pc)))
            (if (i32.eq (global.get $zstate) (i32.const 3))
              (then (return (i32.and (local.get $d) (i32.const 0xFEFF)))))
            (return (i32.or (local.get $d) (i32.const 0x0100)))))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x12)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x13)) (i32.eq (local.get $s) (i32.const 0x40)))
                        (i32.or (i32.eq (local.get $s) (i32.const 0x44)) (i32.or (i32.eq (local.get $s) (i32.const 0x30))
                                                                                (i32.eq (local.get $s) (i32.const 0x41))))))
      (then (return (call $bus16))))
${opts.svp ? `    (if (i32.eq (local.get $s) (i32.const 0x50))
      (then (local.set $d (call $svp_ctrl_r16 (local.get $a)))
            (if (i32.ge_s (local.get $d) (i32.const 0)) (then (return (local.get $d))))))
` : ""}    (if (i32.or (i32.eq (local.get $s) (i32.const 0x20)) (i32.eq (local.get $s) (i32.const 0x50)))
      (then (return (call $bus16))))
    (call $lockup (local.get $a))
    (call $bus16))

  (func $io_wr8 (param $a i32) (param $v i32)
    (local $s i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.eq (local.get $s) (i32.const 0x30)) (then (call $time_w (local.get $a) (local.get $v)) (return)))
    (if (i32.eqz (local.get $s))
      (then (if (i32.eq (i32.and (local.get $a) (i32.const 0xE1)) (i32.const 1))
              (then (call $io_68k_write (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xF)) (local.get $v))))
            (return)))
    (if (i32.eq (local.get $s) (i32.const 0x11))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 1)))
              (then (call $zbusreq_w (i32.and (local.get $v) (i32.const 1)))))
            (return)))
    (if (i32.eq (local.get $s) (i32.const 0x12))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 1)))
              (then (call $zreset_w (i32.and (local.get $v) (i32.const 1)))))
            (return)))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x13)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x40)) (i32.eq (local.get $s) (i32.const 0x44)))
                        (i32.or (i32.eq (local.get $s) (i32.const 0x50)) (i32.or (i32.eq (local.get $s) (i32.const 0x30))
                                                                                (i32.eq (local.get $s) (i32.const 0x41))))))
      (then (return)))
    (if (i32.eq (local.get $s) (i32.const 0x20)) (then (return)))
    (call $lockup (local.get $a)))

  (func $io_wr16 (param $a i32) (param $v i32)
    (local $s i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))
    (if (i32.eq (local.get $s) (i32.const 0x30)) (then (call $time_w (local.get $a) (local.get $v)) (return)))
    (if (i32.eqz (local.get $s))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 0xE0)))
              (then (call $io_68k_write (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0xF))
                                        (i32.and (local.get $v) (i32.const 0xFF)))))
            (return)))
    (if (i32.eq (local.get $s) (i32.const 0x11))
      (then (call $zbusreq_w (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 1))) (return)))
    (if (i32.eq (local.get $s) (i32.const 0x12))
      (then (call $zreset_w (i32.and (i32.shr_u (local.get $v) (i32.const 8)) (i32.const 1))) (return)))${opts.svp ? `
    ;; SVP: XST written by the 68000 (mem68k.c ctrl_io_write_word case 0x50)
    (if (i32.eq (local.get $s) (i32.const 0x50)) (then (drop (call $svp_ctrl_w16 (local.get $a) (local.get $v))) (return)))` : ""}
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x13)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x40)) (i32.eq (local.get $s) (i32.const 0x44)))
                        (i32.or (i32.eq (local.get $s) (i32.const 0x50)) (i32.or (i32.eq (local.get $s) (i32.const 0x30))
                                                                                (i32.eq (local.get $s) (i32.const 0x41))))))
      (then (return)))
    (if (i32.eq (local.get $s) (i32.const 0x20)) (then (return)))
    (call $lockup (local.get $a)))
`;
}

// VDP (vdp_ctrl.c, Mode 5 / 68k side). opts.pal: vdp_pal (313 lines, the
// PAL column of vc_table, the PAL bit in the status register).
export function vdpWat(opts = {}) {
  const hw = opts.hw || null;
  const LINES = opts.pal ? 313 : 262;
  const VC = opts.pal ? [0xF2, 0x102, 0xF2, 0x10A] : [0xDA, 0xEA, 0xDA, 0x106];
  const ZCYC = ZREGS + 64;
  return `
  (func $reg (param $n i32) (result i32) (i32.load8_u (i32.add (i32.const ${VREG}) (local.get $n))))
  (func $fifo_cyc (param $i i32) (result i32)
    (i32.load (i32.add (i32.const ${FIFO + 16}) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 2)))))
  (func $fifo_cyc_set (param $i i32) (param $v i32)
    (i32.store (i32.add (i32.const ${FIFO + 16}) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 2))) (local.get $v)))
  (func $fifo_get (param $i i32) (result i32)
    (i32.load16_u (i32.add (i32.const ${FIFO}) (i32.shl (i32.and (local.get $i) (i32.const 3)) (i32.const 1)))))
  (func $fifo_timing (param $i i32) (result i32)
    (i32.load (i32.add (select (i32.const ${FIFOT40}) (i32.const ${FIFOT32}) (global.get $v_h40))
                       (i32.shl (local.get $i) (i32.const 2)))))
  (func $cram16 (param $i i32) (result i32)
    (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.shl (i32.and (local.get $i) (i32.const 0x3F)) (i32.const 1)))))

  (func $set_irq (param $l i32) (global.set $ilevel (i32.shl (local.get $l) (i32.const 8))))
  (func $update_irq (param $l i32)
    (global.set $ilevel (i32.or (global.get $ilevel) (i32.shl (local.get $l) (i32.const 8)))))

  ;; m68k_set_irq_delay. The one-instruction latency is applied by the run
  ;; loop right after the current instruction (see $m68k_run): it executes the
  ;; next instruction, then raises the level and checks. MOVE.L skips the delay.
  (func $set_irq_delay (param $l i32)
    (if (global.get $irqlat)
      (then (call $set_irq (local.get $l)) (call $check_int) (return)))
    (if (i32.eq (i32.and (global.get $ir) (i32.const 0xF000)) (i32.const 0x2000))
      (then (call $set_irq (local.get $l)) (call $check_int) (return)))
    (global.set $irqdelay (i32.const 1))
    (global.set $irqdelay_lv (local.get $l)))

  ;; vdp_68k_irq_ack
  (func $vdp_68k_irq_ack (param $lv i32)
    (if (i32.and ${R(1)} (global.get $v_vint_pending))
      (then (global.set $v_vint_pending (i32.const 0))
            (global.set $v_status (i32.and (global.get $v_status) (i32.const 0xFF7F)))
            (if (i32.and ${R(0)} (global.get $v_hint_pending))
              (then (call $set_irq (i32.const 4)))
              (else (call $set_irq (i32.const 0)))))
      (else (global.set $v_hint_pending (i32.const 0))
            (call $set_irq (i32.const 0)))))

  ;; color_update_m5
  (func $color_update (param $i i32) (param $d i32)
    (if (i32.eqz (i32.and ${R(0)} (i32.const 4))) (then (local.set $d (i32.and (local.get $d) (i32.const 0x49)))))
    (local.set $d (i32.and (local.get $d) (i32.const 0x1FF)))
    (if (i32.and ${R(12)} (i32.const 8))
      (then
        (i32.store (i32.add (i32.const ${PIXEL}) (i32.shl (local.get $i) (i32.const 2)))
          (i32.load (i32.add (i32.const ${PIXLUT}) (i32.shl (local.get $d) (i32.const 2)))))
        (i32.store (i32.add (i32.const ${PIXEL + 0x100}) (i32.shl (local.get $i) (i32.const 2)))
          (i32.load (i32.add (i32.const ${PIXLUT + 0x800}) (i32.shl (local.get $d) (i32.const 2)))))
        (i32.store (i32.add (i32.const ${PIXEL + 0x200}) (i32.shl (local.get $i) (i32.const 2)))
          (i32.load (i32.add (i32.const ${PIXLUT + 0x1000}) (i32.shl (local.get $d) (i32.const 2))))))
      (else
        (local.set $d (i32.load (i32.add (i32.const ${PIXLUT + 0x800}) (i32.shl (local.get $d) (i32.const 2)))))
        (i32.store (i32.add (i32.const ${PIXEL}) (i32.shl (local.get $i) (i32.const 2))) (local.get $d))
        (i32.store (i32.add (i32.const ${PIXEL + 0x100}) (i32.shl (local.get $i) (i32.const 2))) (local.get $d))
        (i32.store (i32.add (i32.const ${PIXEL + 0x200}) (i32.shl (local.get $i) (i32.const 2))) (local.get $d)))))

  (func $palette_reset
    (local $i i32)
    (call $color_update (i32.const 0) (call $cram16 (global.get $v_border)))
    (local.set $i (i32.const 1))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x40)))
      (call $color_update (local.get $i) (call $cram16 (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; window_clip
  (func $window_clip (param $data i32) (param $sw i32)
    (local $hp i32) (local $hf i32) (local $a i32) (local $w i32)
    (local.set $hp (i32.and (local.get $data) (i32.const 0x1F)))
    (local.set $hf (i32.and (i32.shr_u (local.get $data) (i32.const 7)) (i32.const 1)))
    (local.set $a (local.get $hf))
    (local.set $w (i32.xor (local.get $hf) (i32.const 1)))
    (local.set $sw (i32.add (i32.const 16) (i32.shl (local.get $sw) (i32.const 2))))
    (if (local.get $hp)
      (then
        (if (i32.gt_u (local.get $hp) (local.get $sw))
          (then
            (call $clip_set (local.get $w) (i32.const 0) (i32.const 0))
            (call $clip_set (local.get $w) (i32.const 1) (local.get $sw))
            (call $clip_set (local.get $w) (i32.const 2) (i32.const 1))
            (call $clip_set (local.get $a) (i32.const 2) (i32.const 0)))
          (else
            (call $clip_set (local.get $w) (i32.const 0) (i32.const 0))
            (call $clip_set (local.get $a) (i32.const 1) (local.get $sw))
            (call $clip_set (local.get $a) (i32.const 0) (local.get $hp))
            (call $clip_set (local.get $w) (i32.const 1) (local.get $hp))
            (call $clip_set (i32.const 0) (i32.const 2) (i32.const 1))
            (call $clip_set (i32.const 1) (i32.const 2) (i32.const 1)))))
      (else
        (call $clip_set (local.get $a) (i32.const 0) (i32.const 0))
        (call $clip_set (local.get $a) (i32.const 1) (local.get $sw))
        (call $clip_set (local.get $a) (i32.const 2) (i32.const 1))
        (call $clip_set (local.get $w) (i32.const 2) (i32.const 0)))))
  (func $clip_set (param $k i32) (param $f i32) (param $v i32)
    (i32.store8 (i32.add (i32.const ${CLIP}) (i32.add (i32.mul (local.get $k) (i32.const 3)) (local.get $f))) (local.get $v)))
  (func $clip (param $k i32) (param $f i32) (result i32)
    (i32.load8_u (i32.add (i32.const ${CLIP}) (i32.add (i32.mul (local.get $k) (i32.const 3)) (local.get $f)))))

  (func $vdp_reset
    ;; registers cleared; H-INT is disabled on startup (reg[10] = $FF)
    (memory.fill (i32.const ${VREG}) (i32.const 0) (i32.const 32))
    (i32.store8 (i32.const ${VREG + 10}) (i32.const 0xFF))
    (global.set $v_pending (i32.const 0)) (global.set $v_code (i32.const 0))
    (global.set $v_addr (i32.const 0)) (global.set $v_addr_latch (i32.const 0))
    (global.set $v_border (i32.const 0)) (global.set $v_hint_pending (i32.const 0))
    (global.set $v_vint_pending (i32.const 0)) (global.set $v_dmafill (i32.const 0))
    (global.set $v_dma_src (i32.const 0)) (global.set $v_dma_type (i32.const 0))
    (global.set $v_dma_length (i32.const 0)) (global.set $v_dma_end (i32.const 0))
    (global.set $v_odd_frame (i32.const 0)) (global.set $v_im2 (i32.const 0))
    (global.set $v_interlaced (i32.const 0)) (global.set $v_fifo_idx (i32.const 0))
    (global.set $v_cached_write (i32.const -1)) (global.set $v_fifo_byte_access (i32.const 1))
    (global.set $v_ntab (i32.const 0)) (global.set $v_ntbb (i32.const 0)) (global.set $v_ntwb (i32.const 0))
    (global.set $v_satb (i32.const 0)) (global.set $v_hscb (i32.const 0))
    (global.set $v_hscroll_mask (i32.const 0)) (global.set $v_pf_shift (i32.const 6))
    (global.set $v_pf_col_mask (i32.const 0x0F)) (global.set $v_pf_row_mask (i32.const 0xFF))
    (global.set $v_sat_base_mask (i32.const 0xFE00)) (global.set $v_sat_addr_mask (i32.const 0x1FF))
    (call $window_clip (i32.const 0) (i32.const 0))
    (global.set $v_status (i32.const ${opts.pal ? 1 : 0}))
    (global.set $vp_w (i32.const 256)) (global.set $vp_h (i32.const 192))
    (global.set $vp_ow (i32.const 256)) (global.set $vp_oh (i32.const 192))
    (global.set $v_hvc_latch (i32.const 0x10000)) (global.set $v_h40 (i32.const 0))
    (global.set $v_vc_max (i32.const ${VC[0]})) (global.set $v_v_counter (i32.const 192))
    (global.set $v_h_counter (i32.const 0xFF)) (global.set $v_max_sprite_pixels (i32.const 256))
    (global.set $v_vint_cycle (i32.const 770))
    (global.set $v_hblank_start (i32.const 280)) (global.set $v_hblank_end (i32.const 860))
    ;; vdp_reset: the Mode 4 palette entries start black
    (call $palette_zero_m4))
  (func $palette_zero_m4
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x20)))
      (call $color_update_m4 (local.get $i) (i32.const 0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $color_update_m4 (i32.const 0x40) (i32.const 0)))

  ;; ---- DMA ------------------------------------------------------------------
  ;; vdp_bus_w: one 16-bit word to VRAM/CRAM/VSRAM through the FIFO
  (func $vdp_bus_w (param $data i32)
    (local $idx i32) (local $p i32) (local $cd i32)
    (i32.store16 (i32.add (i32.const ${FIFO}) (i32.shl (global.get $v_fifo_idx) (i32.const 1))) (local.get $data))
    (global.set $v_fifo_idx (i32.and (i32.add (global.get $v_fifo_idx) (i32.const 1)) (i32.const 3)))
    (local.set $cd (i32.and (global.get $v_code) (i32.const 0xF)))
    (block $sw
      (if (i32.eq (local.get $cd) (i32.const 1))
        (then
          (local.set $idx (i32.and (global.get $v_addr) (i32.const 0xFFFE)))
          (if (i32.and (global.get $v_addr) (i32.const 1))
            (then (local.set $data (i32.and (i32.or (i32.shr_u (local.get $data) (i32.const 8))
                                                    (i32.shl (local.get $data) (i32.const 8))) (i32.const 0xFFFF)))))
          (if (i32.eq (i32.and (local.get $idx) (global.get $v_sat_base_mask)) (global.get $v_satb))
            (then (i32.store16 (i32.add (i32.const ${SAT}) (i32.and (local.get $idx) (global.get $v_sat_addr_mask)))
                               (local.get $data))))
          (i32.store16 (i32.add (i32.const ${VRAM}) (local.get $idx)) (local.get $data))
          (br $sw)))
      (if (i32.eq (local.get $cd) (i32.const 3))
        (then
          (local.set $p (i32.add (i32.const ${CRAM}) (i32.and (global.get $v_addr) (i32.const 0x7E))))
          (local.set $data (i32.or (i32.or
            (i32.shr_u (i32.and (local.get $data) (i32.const 0xE00)) (i32.const 3))
            (i32.shr_u (i32.and (local.get $data) (i32.const 0x0E0)) (i32.const 2)))
            (i32.shr_u (i32.and (local.get $data) (i32.const 0x00E)) (i32.const 1))))
          (if (i32.ne (local.get $data) (i32.load16_u (local.get $p)))
            (then
              (local.set $idx (i32.and (i32.shr_u (global.get $v_addr) (i32.const 1)) (i32.const 0x3F)))
              (i32.store16 (local.get $p) (local.get $data))
              (if (i32.and (local.get $idx) (i32.const 0x0F))
                (then (call $color_update (local.get $idx) (local.get $data))))
              (if (i32.eq (local.get $idx) (global.get $v_border))
                (then (call $color_update (i32.const 0) (local.get $data))))
              (if (i32.and (i32.and (i32.lt_u (global.get $v_v_counter) (global.get $vp_h))
                                    (i32.le_u (global.get $mc) (i32.add (global.get $mcvdp) (i32.const 860))))
                           (i32.or (i32.ne (i32.and ${R(1)} (i32.const 0x40)) (i32.const 0))
                                   (i32.eq (local.get $idx) (global.get $v_border))))
                (then (call $remap_line (global.get $v_v_counter))))))
          (br $sw)))
      (if (i32.eq (local.get $cd) (i32.const 5))
        (then
          (i32.store16 (i32.add (i32.const ${VSRAM}) (i32.and (global.get $v_addr) (i32.const 0x7E))) (local.get $data))
          (if (i32.and ${R(11)} (i32.const 4))
            (then (if (i32.and (i32.and (i32.lt_u (global.get $v_v_counter) (global.get $vp_h))
                                        (i32.ne (i32.and ${R(1)} (i32.const 0x40)) (i32.const 0)))
                               (i32.le_u (global.get $mc) (i32.add (global.get $mcvdp) (i32.const 860))))
                    (then (call $render_line (global.get $v_v_counter))))))
          (br $sw))))
    (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF))))

  (func $dma_68k (param $len i32)
    (local $src i32) (local $data i32) (local $hi i32)
    (local.set $hi (i32.shl ${R(23)} (i32.const 17)))
    (local.set $src (i32.or (local.get $hi) (i32.shl (global.get $v_dma_src) (i32.const 1))))
    (block $d (loop $l
      (local.set $src (i32.and (local.get $src) (i32.const 0xFFFFFF)))
      ;; vdp_dma_68k_ext: the bank's read16 handler when it has one (backup
      ;; RAM, serial EEPROM, rom_database registers), else its memory
      (if (i32.lt_u (local.get $src) (i32.const 0x800000))
        (then (if (i32.lt_u (local.get $src) (i32.const 0x400000))
                (then (local.set $data (call $cart_rd16 (local.get $src))))
                (else ${hw && hw.regsR ? `(if (i32.and (i32.ge_u (i32.shr_u (local.get $src) (i32.const 16)) (i32.const ${hw.bankStart}))
                                (i32.le_u (i32.shr_u (local.get $src) (i32.const 16)) (i32.const ${hw.bankEnd})))
                        (then (local.set $data (i32.and (call $regs_r (local.get $src)) (i32.const 0xFFFF))))
                        (else (local.set $data (call $bus16))))` : "(local.set $data (call $bus16))"})))
        (else
          (if (i32.eq (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 0xA1))
            (then (local.set $data (call $io_68k_read (i32.and (i32.shr_u (local.get $src) (i32.const 1)) (i32.const 0xF))))
                  (local.set $data (i32.or (i32.shl (local.get $data) (i32.const 8)) (local.get $data))))
            (else (local.set $data (i32.or
                     (i32.shl (i32.load8_u (i32.and (local.get $src) (i32.const 0xFFFF))) (i32.const 8))
                     (i32.load8_u (i32.and (i32.add (local.get $src) (i32.const 1)) (i32.const 0xFFFF)))))))))
      (local.set $src (i32.add (local.get $src) (i32.const 2)))
      (local.set $src (i32.or (local.get $hi) (i32.and (local.get $src) (i32.const 0x1FFFF))))
      (call $vdp_bus_w (local.get $data))
      (local.set $len (i32.sub (local.get $len) (i32.const 1)))
      (br_if $l (local.get $len))))
    (global.set $v_dma_src (i32.and (i32.shr_u (local.get $src) (i32.const 1)) (i32.const 0xFFFF))))

  (func $dma_copy (param $len i32)
    (local $src i32) (local $data i32)
    (if (i32.eqz (i32.and (global.get $v_code) (i32.const 0x10))) (then (return)))
    (local.set $src (global.get $v_dma_src))
    (block $d (loop $l
      ;; READ_BYTE(vram, source ^ 1) / WRITE_BYTE(vram, addr ^ 1): LSB_FIRST's ^1 cancels both
      (local.set $data (i32.load8_u (i32.add (i32.const ${VRAM}) (i32.and (local.get $src) (i32.const 0xFFFF)))))
      (if (i32.eq (i32.and (global.get $v_addr) (global.get $v_sat_base_mask)) (global.get $v_satb))
        (then (i32.store8 (i32.add (i32.const ${SAT}) (i32.and (global.get $v_addr) (global.get $v_sat_addr_mask)))
                          (local.get $data))))
      (i32.store8 (i32.add (i32.const ${VRAM}) (global.get $v_addr)) (local.get $data))
      (local.set $src (i32.and (i32.add (local.get $src) (i32.const 1)) (i32.const 0xFFFF)))
      (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
      (local.set $len (i32.sub (local.get $len) (i32.const 1)))
      (br_if $l (local.get $len))))
    (global.set $v_dma_src (local.get $src)))

  (func $dma_fill (param $len i32)
    (local $data i32) (local $cd i32) (local $p i32)
    (local.set $cd (i32.and (global.get $v_code) (i32.const 0xF)))
    (if (i32.eq (local.get $cd) (i32.const 1))
      (then
        (local.set $data (i32.shr_u (call $fifo_get (i32.add (global.get $v_fifo_idx) (i32.const 3))) (i32.const 8)))
        ;; WRITE_BYTE(vram, addr ^ 1): with LSB_FIRST's own ^1 that is byte addr of the array
        (block $d (loop $l
          (if (i32.eq (i32.and (global.get $v_addr) (global.get $v_sat_base_mask)) (global.get $v_satb))
            (then (i32.store8 (i32.add (i32.const ${SAT}) (i32.and (global.get $v_addr) (global.get $v_sat_addr_mask)))
                              (local.get $data))))
          (i32.store8 (i32.add (i32.const ${VRAM}) (global.get $v_addr)) (local.get $data))
          (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
          (local.set $len (i32.sub (local.get $len) (i32.const 1)))
          (br_if $l (local.get $len))))
        (return)))
    (if (i32.eq (local.get $cd) (i32.const 3))
      (then
        (local.set $data (call $fifo_get (global.get $v_fifo_idx)))
        (local.set $data (i32.or (i32.or
          (i32.shr_u (i32.and (local.get $data) (i32.const 0xE00)) (i32.const 3))
          (i32.shr_u (i32.and (local.get $data) (i32.const 0x0E0)) (i32.const 2)))
          (i32.shr_u (i32.and (local.get $data) (i32.const 0x00E)) (i32.const 1))))
        (block $d (loop $l
          (local.set $p (i32.add (i32.const ${CRAM}) (i32.and (global.get $v_addr) (i32.const 0x7E))))
          (if (i32.ne (local.get $data) (i32.load16_u (local.get $p)))
            (then (i32.store16 (local.get $p) (local.get $data))
                  (if (i32.and (i32.shr_u (global.get $v_addr) (i32.const 1)) (i32.const 0x0F))
                    (then (call $color_update (i32.and (i32.shr_u (global.get $v_addr) (i32.const 1)) (i32.const 0x3F)) (local.get $data))))
                  (if (i32.eq (i32.and (i32.shr_u (global.get $v_addr) (i32.const 1)) (i32.const 0x3F)) (global.get $v_border))
                    (then (call $color_update (i32.const 0) (local.get $data))))))
          (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
          (local.set $len (i32.sub (local.get $len) (i32.const 1)))
          (br_if $l (local.get $len))))
        (return)))
    (if (i32.eq (local.get $cd) (i32.const 5))
      (then
        (local.set $data (call $fifo_get (global.get $v_fifo_idx)))
        (block $d (loop $l
          (i32.store16 (i32.add (i32.const ${VSRAM}) (i32.and (global.get $v_addr) (i32.const 0x7E))) (local.get $data))
          (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
          (local.set $len (i32.sub (local.get $len) (i32.const 1)))
          (br_if $l (local.get $len))))
        (return)))
    (global.set $v_addr (i32.and (i32.add (global.get $v_addr) (i32.mul ${R(15)} (local.get $len))) (i32.const 0xFFFF))))

  ;; vdp_dma_update
  (func $dma_update (param $cycles i32)
    (local $rate i32) (local $dcyc i32) (local $dbytes i32) (local $end i32)
    (local.set $rate
      (if (result i32) (i32.or (i32.ne (i32.and (global.get $v_status) (i32.const 8)) (i32.const 0))
                               (i32.eqz (i32.and ${R(1)} (i32.const 0x40))))
        (then (select (i32.const 204) (i32.const 166) (i32.and ${R(12)} (i32.const 1))))
        (else (select (i32.const 18) (i32.const 16) (i32.and ${R(12)} (i32.const 1))))))
    (local.set $rate (i32.shr_u (local.get $rate) (i32.and (global.get $v_dma_type) (i32.const 1))))
    (if (i32.eqz (global.get $v_dma_type))
      (then (if (i32.eq (local.get $rate) (i32.const 166)) (then (local.set $rate (i32.const 161)))
              (else (if (i32.eq (local.get $rate) (i32.const 204)) (then (local.set $rate (i32.const 198)))))))
      (else (if (global.get $v_dmafill)
              (then (local.set $cycles (i32.add (local.get $cycles)
                      (i32.mul (i32.const 2) (i32.div_s (i32.const 3420) (local.get $rate)))))))))
    (if (i32.and (global.get $v_status) (i32.const 8))
      (then (local.set $dcyc (i32.sub (i32.mul (i32.sub (i32.sub (i32.const ${LINES}) (global.get $vp_h)) (i32.const 1))
                                               (i32.const 3420)) (local.get $cycles))))
      (else (local.set $dcyc (i32.sub (i32.add (global.get $mcvdp) (i32.const 3420)) (local.get $cycles)))))
    ;; dma_cycles (int) * rate (unsigned) is unsigned arithmetic in C: a
    ;; trigger past the end of the line (the DMA fill start adjustment) gives
    ;; a huge byte budget, and the whole DMA completes there
    (local.set $dbytes (i32.div_u (i32.mul (local.get $dcyc) (local.get $rate)) (i32.const 3420)))
    (if (i32.lt_u (global.get $v_dma_length) (local.get $dbytes))
      (then (local.set $dbytes (global.get $v_dma_length))
            (local.set $dcyc (i32.div_s (i32.mul (local.get $dbytes) (i32.const 3420)) (local.get $rate)))))
    (global.set $v_dma_end (i32.add (local.get $cycles) (local.get $dcyc)))
    (if (i32.lt_u (global.get $v_dma_type) (i32.const 2))
      (then (global.set $mc (global.get $v_dma_end))
            (if (i32.and (global.get $zstate) (i32.const 4))
              (then (i32.store (i32.const ${ZCYC}) (global.get $v_dma_end)))))
      (else (global.set $v_status (i32.or (global.get $v_status) (i32.const 2)))))
    (if (i32.gt_s (local.get $dbytes) (i32.const 0))
      (then
        (global.set $ndma (i32.add (global.get $ndma) (i32.const 1)))
        (global.set $v_dma_length (i32.sub (global.get $v_dma_length) (local.get $dbytes)))
        (block $f
          (if (i32.lt_u ${R(23)} (i32.const 0x80)) (then (call $dma_68k (local.get $dbytes)) (br $f)))
          (if (i32.lt_u ${R(23)} (i32.const 0xC0)) (then (call $dma_fill (local.get $dbytes)) (br $f)))
          (call $dma_copy (local.get $dbytes)))
        (if (i32.eqz (global.get $v_dma_length))
          (then
            (local.set $end (i32.and (i32.add (i32.add ${R(21)} (i32.shl ${R(22)} (i32.const 8)))
                                              (i32.add ${R(19)} (i32.shl ${R(20)} (i32.const 8)))) (i32.const 0xFFFF)))
            ${RS(21, '(local.get $end)')}
            ${RS(22, '(i32.shr_u (local.get $end) (i32.const 8))')}
            ${RS(19, '(i32.const 0)')} ${RS(20, '(i32.const 0)')}
            (if (i32.ge_s (global.get $v_cached_write) (i32.const 0))
              (then (local.set $end (global.get $v_cached_write))
                    (global.set $v_cached_write (i32.const -1))
                    (call $vdp_ctrl_w (local.get $end))))
            (global.set $zstate (i32.and (global.get $zstate) (i32.const -5))))))))

  ;; vdp_68k_ctrl_w
  (func $vdp_ctrl_w (param $data i32)
    (local $len i32)
    (if (i32.eqz (global.get $v_pending))
      (then
        (if (global.get $v_dma_length)
          (then (if (i32.lt_u (global.get $v_dma_type) (i32.const 2))
                  (then (global.set $v_cached_write (local.get $data)) (return)))))
        (global.set $v_addr (i32.or (global.get $v_addr_latch) (i32.and (local.get $data) (i32.const 0x3FFF))))
        (global.set $v_code (i32.or (i32.and (global.get $v_code) (i32.const 0x3C))
                                    (i32.and (i32.shr_u (local.get $data) (i32.const 14)) (i32.const 3))))
        (if (i32.eq (i32.and (local.get $data) (i32.const 0xC000)) (i32.const 0x8000))
          (then (call $vdp_reg_w (i32.and (i32.shr_u (local.get $data) (i32.const 8)) (i32.const 0x1F))
                                 (i32.and (local.get $data) (i32.const 0xFF)) (global.get $mc)))
          (else (global.set $v_pending (i32.and ${R(1)} (i32.const 4))))))
      (else
        (global.set $v_pending (i32.const 0))
        (global.set $v_addr_latch (i32.shl (i32.and (local.get $data) (i32.const 3)) (i32.const 14)))
        (global.set $v_addr (i32.or (global.get $v_addr_latch) (i32.and (global.get $v_addr) (i32.const 0x3FFF))))
        (global.set $v_code (i32.or (i32.and (global.get $v_code) (i32.const 0x03))
                                    (i32.and (i32.shr_u (local.get $data) (i32.const 2)) (i32.const 0x3C))))
        (if (i32.and (global.get $v_code) (i32.const 0x20))
          (then (if (i32.and ${R(1)} (i32.const 0x10))
            (then
              (local.set $len (i32.shr_u ${R(23)} (i32.const 6)))
              (if (i32.eq (local.get $len) (i32.const 2))
                (then (global.set $v_dma_type (i32.const 2)) (global.set $v_dmafill (i32.const 1))
                      (global.set $v_status (i32.or (global.get $v_status) (i32.const 2)))
                      (global.set $v_dma_end (i32.const -1)))
                (else (if (i32.eq (local.get $len) (i32.const 3))
                  (then (global.set $v_dma_type (i32.const 3))
                        (global.set $v_dma_length (i32.or (i32.shl ${R(20)} (i32.const 8)) ${R(19)}))
                        (if (i32.eqz (global.get $v_dma_length)) (then (global.set $v_dma_length (i32.const 0x10000))))
                        (global.set $v_dma_src (i32.or (i32.shl ${R(22)} (i32.const 8)) ${R(21)}))
                        (call $dma_update (global.get $mc)))
                  (else
                        (global.set $v_dma_type (select (i32.const 0) (i32.const 1)
                                                        (i32.and (global.get $v_code) (i32.const 6))))
                        (global.set $v_dma_length (i32.or (i32.shl ${R(20)} (i32.const 8)) ${R(19)}))
                        (if (i32.eqz (global.get $v_dma_length)) (then (global.set $v_dma_length (i32.const 0x10000))))
                        (global.set $v_dma_src (i32.or (i32.shl ${R(22)} (i32.const 8)) ${R(21)}))${opts.svp ? `
                        ;; SVP ROM/RAM source ($000000-$3FFFFF): the first word is the bus's
                        ;; previous data, so the transfer starts one slot later, one word shorter
                        (if (i32.eqz (i32.and ${R(23)} (i32.const 0x60)))
                          (then (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
                                (global.set $v_dma_length (i32.sub (global.get $v_dma_length) (i32.const 1)))))` : ""}
                        (call $dma_update (global.get $mc))))))))))))
    (global.set $v_fifo_byte_access (select (i32.const 0) (i32.const 1) (i32.and (global.get $v_code) (i32.const 6)))))

  ;; restricted VDP writes during active display: the FIFO slot the write
  ;; takes (the 68000 waits when the FIFO is full)
  (func $fifo_wait
    (local $slot i32) (local $cyc i32)
    (if (i32.and (i32.eqz (i32.and (global.get $v_status) (i32.const 8))) (i32.ne (i32.and ${R(1)} (i32.const 0x40)) (i32.const 0)))
      (then
        (local.set $cyc (global.get $mc))
        (if (i32.lt_u (local.get $cyc) (call $fifo_cyc (i32.add (global.get $v_fifo_idx) (i32.const 3))))
          (then
            (if (i32.lt_u (local.get $cyc) (call $fifo_cyc (global.get $v_fifo_idx)))
              (then (global.set $mc (i32.mul (i32.div_u (i32.add (call $fifo_cyc (global.get $v_fifo_idx)) (i32.const 6)) (i32.const 7)) (i32.const 7)))))
            (local.set $cyc (call $fifo_cyc (i32.add (global.get $v_fifo_idx) (i32.const 3))))))
        (local.set $cyc (i32.sub (local.get $cyc) (global.get $mcvdp)))
        (block $d (loop $l
          (br_if $d (i32.lt_s (local.get $cyc) (call $fifo_timing (local.get $slot))))
          (br_if $d (i32.ge_u (local.get $slot) (i32.const 27)))
          (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
          (br $l)))
        (call $fifo_cyc_set (global.get $v_fifo_idx)
          (i32.add (global.get $mcvdp) (call $fifo_timing (i32.add (local.get $slot) (global.get $v_fifo_byte_access)))))))
  )

  ;; vdp_68k_data_w_m4: CRAM (32 x 6-bit colours) or VRAM words, address + R15 + 1
  (func $vdp_data_w_m4 (param $data i32)
    (local $i i32) (local $p i32)
    (global.set $nm4 (i32.add (global.get $nm4) (i32.const 1)))
    (global.set $v_pending (i32.const 0))
    (call $fifo_wait)
    (if (i32.and (global.get $v_code) (i32.const 2))
      (then
        (local.set $i (i32.and (global.get $v_addr) (i32.const 0x1F)))
        (local.set $data (i32.or (i32.shr_u (i32.and (local.get $data) (i32.const 0xE00)) (i32.const 3)) (i32.and (local.get $data) (i32.const 0x3F))))
        (if (i32.ne (local.get $data) (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.shl (local.get $i) (i32.const 1)))))
          (then (i32.store16 (i32.add (i32.const ${CRAM}) (i32.shl (local.get $i) (i32.const 1))) (local.get $data))
                (call $color_update_m4 (local.get $i) (local.get $data))
                (if (i32.eq (local.get $i) (i32.or (i32.const 0x10) (i32.and (global.get $v_border) (i32.const 0x0F))))
                  (then (call $color_update_m4 (i32.const 0x40) (local.get $data)))))))
      (else
        (local.set $p (i32.add (i32.const ${VRAM}) (i32.and (global.get $v_addr) (i32.const 0x3FFE))))
        (if (i32.and (global.get $v_addr) (i32.const 1))
          (then (local.set $data (i32.and (i32.or (i32.shr_u (local.get $data) (i32.const 8)) (i32.shl (local.get $data) (i32.const 8))) (i32.const 0xFFFF)))))
        (i32.store16 (local.get $p) (local.get $data))))
    (global.set $v_addr (i32.and (i32.add (global.get $v_addr) (i32.add ${R(15)} (i32.const 1))) (i32.const 0xFFFF))))

  ;; vdp_68k_data_r_m4: the interleaved 16KB VRAM
  (func $vdp_data_r_m4 (result i32)
    (local $i i32)
    (local.set $i (i32.or (i32.or (i32.and (i32.shl (global.get $v_addr) (i32.const 1)) (i32.const 0x3FC))
                                  (i32.shr_u (i32.and (global.get $v_addr) (i32.const 0x200)) (i32.const 8)))
                          (i32.and (global.get $v_addr) (i32.const 0x3C00))))
    (global.set $v_pending (i32.const 0))
    (global.set $v_addr (i32.and (i32.add (global.get $v_addr) (i32.add ${R(15)} (i32.const 1))) (i32.const 0xFFFF)))
    (i32.load16_u (i32.add (i32.const ${VRAM}) (local.get $i))))

  ;; color_update_m4 on the Mega Drive VDP (black when R0's M4 bit is clear)
  (func $color_update_m4 (param $i i32) (param $d i32)
    (local.set $d (select (i32.load (i32.add (i32.const ${PIXLUT_M4}) (i32.shl (i32.and (local.get $d) (i32.const 0x3F)) (i32.const 2))))
                          (i32.const 0xFF000000) (i32.and ${R(0)} (i32.const 4))))
    (if (i32.and ${R(0)} (i32.const 4))
      (then (call $pixel_set (local.get $i) (local.get $d)) (call $pixel_set (i32.or (local.get $i) (i32.const 0x20)) (local.get $d))
            (call $pixel_set (i32.or (local.get $i) (i32.const 0x80)) (local.get $d)) (call $pixel_set (i32.or (local.get $i) (i32.const 0xA0)) (local.get $d)))
      (else
        (if (i32.or (i32.eq (local.get $i) (i32.const 0x40)) (i32.eq (local.get $i) (i32.or (i32.const 0x10) (i32.and ${R(7)} (i32.const 0x0F)))))
          (then (call $pixel_set (i32.const 0x40) (local.get $d)) (call $pixel_set (i32.const 0x10) (local.get $d)) (call $pixel_set (i32.const 0x30) (local.get $d))
                (call $pixel_set (i32.const 0x90) (local.get $d)) (call $pixel_set (i32.const 0xB0) (local.get $d))))
        (if (i32.and (local.get $i) (i32.const 0x0F))
          (then (call $pixel_set (local.get $i) (local.get $d)) (call $pixel_set (i32.or (local.get $i) (i32.const 0x20)) (local.get $d))
                (call $pixel_set (i32.or (local.get $i) (i32.const 0x80)) (local.get $d)) (call $pixel_set (i32.or (local.get $i) (i32.const 0xA0)) (local.get $d)))))))
  (func $pixel_set (param $i i32) (param $d i32)
    (i32.store (i32.add (i32.const ${PIXEL}) (i32.shl (i32.and (local.get $i) (i32.const 0xFF)) (i32.const 2))) (local.get $d)))
  ;; the Mode 4 palette from CRAM (mode switch, R0 palette bit)
  (func $palette_reset_m4
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x20)))
      (call $color_update_m4 (local.get $i) (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.shl (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (call $color_update_m4 (i32.const 0x40)
      (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.shl (i32.or (i32.const 0x10) (i32.and (global.get $v_border) (i32.const 0x0F))) (i32.const 1))))))

  ;; vdp_68k_data_w_m5
  (func $vdp_data_w (param $data i32)
    (if (i32.eqz (i32.and ${R(1)} (i32.const 4)))
      (then (call $vdp_data_w_m4 (local.get $data)) (return)))
    (global.set $v_pending (i32.const 0))
    (call $fifo_wait)
    (call $vdp_bus_w (local.get $data))
    (if (global.get $v_dmafill)
      (then
        (global.set $v_dma_length (i32.or (i32.shl ${R(20)} (i32.const 8)) ${R(19)}))
        (if (i32.eqz (global.get $v_dma_length)) (then (global.set $v_dma_length (i32.const 0x10000))))
        (call $dma_update (global.get $mc))
        (global.set $v_dmafill (i32.const 0)))))

  ;; vdp_68k_data_r_m5
  (func $vdp_data_r (result i32)
    (local $d i32) (local $i i32) (local $c i32)
    (if (i32.eqz (i32.and ${R(1)} (i32.const 4))) (then (return (call $vdp_data_r_m4))))
    (global.set $v_pending (i32.const 0))
    (local.set $c (i32.and (global.get $v_code) (i32.const 0x1F)))
    (block $sw
      (if (i32.eqz (local.get $c))
        (then (local.set $d (i32.load16_u (i32.add (i32.const ${VRAM}) (i32.and (global.get $v_addr) (i32.const 0xFFFE)))))
              (br $sw)))
      (if (i32.eq (local.get $c) (i32.const 4))
        (then (local.set $i (i32.and (global.get $v_addr) (i32.const 0x7E)))
              (if (i32.ge_u (local.get $i) (i32.const 0x50)) (then (local.set $i (i32.const 0))))
              (local.set $d (i32.or (i32.and (i32.load16_u (i32.add (i32.const ${VSRAM}) (local.get $i))) (i32.const 0x7FF))
                                    (i32.and (call $fifo_get (global.get $v_fifo_idx)) (i32.const 0xF800))))
              (br $sw)))
      (if (i32.eq (local.get $c) (i32.const 8))
        (then (local.set $d (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.and (global.get $v_addr) (i32.const 0x7E)))))
              (local.set $d (i32.or (i32.or (i32.shl (i32.and (local.get $d) (i32.const 0x1C0)) (i32.const 3))
                                            (i32.shl (i32.and (local.get $d) (i32.const 0x038)) (i32.const 2)))
                                    (i32.shl (i32.and (local.get $d) (i32.const 0x007)) (i32.const 1))))
              (local.set $d (i32.or (local.get $d) (i32.and (call $fifo_get (global.get $v_fifo_idx)) (i32.const 0xF111))))
              (br $sw)))
      (if (i32.eq (local.get $c) (i32.const 0xC))
        (then (local.set $d (i32.or (i32.load8_u (i32.add (i32.const ${VRAM}) (i32.and (global.get $v_addr) (i32.const 0xFFFF))))
                                    (i32.and (call $fifo_get (global.get $v_fifo_idx)) (i32.const 0xFF00))))
              (br $sw))))
    (global.set $v_addr (i32.and (i32.add (global.get $v_addr) ${R(15)}) (i32.const 0xFFFF)))
    (i32.and (local.get $d) (i32.const 0xFFFF)))

  ;; vdp_68k_ctrl_r
  (func $vdp_ctrl_r (param $cycles i32) (result i32)
    (local $t i32)
    (local.set $cycles (i32.add (local.get $cycles)
      (i32.mul (i32.load8_u (i32.add (i32.const ${CYCTAB}) (global.get $ir))) (i32.const 7))))
    (if (i32.and (global.get $v_status) (i32.const 2))
      (then (if (i32.and (i32.eqz (global.get $v_dma_length)) (i32.ge_u (local.get $cycles) (global.get $v_dma_end)))
              (then (global.set $v_status (i32.and (global.get $v_status) (i32.const 0xFFFD)))))))
    (local.set $t (global.get $v_status))
    (global.set $v_pending (i32.const 0))
    (global.set $v_status (i32.and (global.get $v_status) (i32.const 0xFF9F)))
    (if (i32.ge_u (local.get $cycles) (call $fifo_cyc (i32.add (global.get $v_fifo_idx) (i32.const 3))))
      (then (local.set $t (i32.or (local.get $t) (i32.const 0x200))))
      (else (if (i32.lt_u (local.get $cycles) (call $fifo_cyc (global.get $v_fifo_idx)))
              (then (local.set $t (i32.or (local.get $t) (i32.const 0x100)))))))
    (if (i32.eqz (i32.and ${R(1)} (i32.const 0x40))) (then (local.set $t (i32.or (local.get $t) (i32.const 8)))))
    (local.set $cycles (i32.sub (local.get $cycles) (global.get $mcvdp)))
    (if (i32.and (i32.eq (global.get $v_v_counter) (global.get $vp_h))
                 (i32.ge_u (local.get $cycles) (global.get $v_vint_cycle)))
      (then (if (i32.eqz (i32.load8_u (i32.const ${ZCYC - 3}))) (then (local.set $t (i32.or (local.get $t) (i32.const 0x80)))))))
    (if (i32.and (i32.ge_u (local.get $cycles) (global.get $v_hblank_start))
                 (i32.lt_u (local.get $cycles) (global.get $v_hblank_end)))
      (then (local.set $t (i32.or (local.get $t) (i32.const 4)))))
    (local.get $t))

  ;; vdp_hvc_r
  (func $vdp_hvc_r (param $cycles i32) (result i32)
    (local $d i32) (local $vc i32)
    (local.set $d (global.get $v_hvc_latch))
    (if (local.get $d)
      (then (if (i32.and ${R(1)} (i32.const 4)) (then (return (i32.and (local.get $d) (i32.const 0xFFFF)))))
            (local.set $d (i32.and (local.get $d) (i32.const 0xFF))))
      (else (local.set $d (i32.load8_u (i32.add (select (i32.const ${HC40}) (i32.const ${HC32}) (global.get $v_h40))
                                                (i32.rem_u (local.get $cycles) (i32.const 3420)))))))
    (local.set $vc (global.get $v_v_counter))
    (if (i32.ge_u (i32.sub (local.get $cycles) (global.get $mcvdp)) (i32.const 3420))
      (then (local.set $vc (i32.rem_u (i32.add (local.get $vc) (i32.const 1)) (i32.const ${LINES})))))
    (if (i32.gt_s (local.get $vc) (global.get $v_vc_max)) (then (local.set $vc (i32.sub (local.get $vc) (i32.const ${LINES})))))
    (if (global.get $v_interlaced)
      (then (local.set $vc (i32.shl (local.get $vc) (global.get $v_im2)))
            (local.set $vc (i32.or (i32.and (local.get $vc) (i32.const -2))
                                   (i32.and (i32.shr_s (local.get $vc) (i32.const 8)) (i32.const 1))))))
    (i32.or (local.get $d) (i32.shl (i32.and (local.get $vc) (i32.const 0xFF)) (i32.const 8))))

  (func $in_hblank_redraw (param $cycles i32) (result i32)
    (i32.and (i32.and (i32.lt_u (global.get $v_v_counter) (global.get $vp_h))
                      (i32.ne (i32.and ${R(1)} (i32.const 0x40)) (i32.const 0)))
             (i32.le_u (local.get $cycles) (i32.add (global.get $mcvdp) (i32.const 860)))))

  ;; vdp_reg_w
  (func $vdp_reg_w (param $r i32) (param $d i32) (param $cycles i32)
    (local $x i32) (local $off i32) (local $i i32) (local $j i32) (local $w i32)
    (if (i32.and (i32.eqz (i32.and ${R(1)} (i32.const 4))) (i32.gt_u (local.get $r) (i32.const 10)))
      (then (return)))
    (block $sw
      (if (i32.eqz (local.get $r))
        (then
          (local.set $x (i32.xor (local.get $d) ${R(0)}))
          ${RS(0, '(local.get $d)')}
          (if (i32.and (local.get $x) (global.get $v_hint_pending))
            (then (if (i32.and ${R(1)} (global.get $v_vint_pending))
                    (then (call $set_irq (i32.const 6)))
                    (else (if (i32.and (local.get $d) (i32.const 0x10))
                            (then (call $set_irq_delay (i32.const 4)))
                            (else (call $set_irq (i32.const 0))))))))
          (if (i32.and (local.get $x) (i32.const 4)) (then (if (i32.and ${R(1)} (i32.const 4)) (then (call $palette_reset)) (else (call $palette_reset_m4)))))
          (if (i32.and (local.get $x) (i32.const 2))
            (then (if (i32.and ${R(1)} (i32.const 4))
              (then (if (i32.and (local.get $d) (i32.const 2))
                      (then (global.set $v_hvc_latch (i32.or (call $vdp_hvc_r (local.get $cycles)) (i32.const 0x10000))))
                      (else (global.set $v_hvc_latch (i32.const 0))))))))
          (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 1))
        (then
          (local.set $x (i32.xor (local.get $d) ${R(1)}))
          ${RS(1, '(local.get $d)')}
          (if (i32.and (i32.ne (i32.and (local.get $x) (i32.const 0x40)) (i32.const 0))
                       (i32.lt_u (global.get $v_v_counter) (global.get $vp_h)))
            (then
              (local.set $off (i32.sub (local.get $cycles) (global.get $mcvdp)))
              (if (i32.le_s (local.get $off) (i32.const 860))
                (then
                  (if (i32.and (local.get $d) (i32.const 0x40))
                    (then (if (i32.gt_s (local.get $off) (i32.const 360))
                            (then (global.set $v_max_sprite_pixels (i32.const 128))))))
                  (call $render_line (global.get $v_v_counter))
                  (global.set $v_max_sprite_pixels (i32.add (i32.const 256) (i32.shl (i32.and ${R(12)} (i32.const 1)) (i32.const 6)))))
                (else
                  (local.set $off (i32.add (i32.div_s (i32.sub (local.get $off) (i32.const 860))
                                                     (select (i32.const 8) (i32.const 10) (i32.and ${R(12)} (i32.const 1))))
                                           (i32.const 16)))
                  (if (i32.lt_s (local.get $off) (global.get $vp_w))
                    (then (if (i32.and (local.get $d) (i32.const 0x40))
                            (then (call $render_line (global.get $v_v_counter))
                                  (call $blank_line (global.get $v_v_counter) (i32.const 0) (local.get $off)))
                            (else (call $blank_line (global.get $v_v_counter) (local.get $off)
                                                    (i32.sub (global.get $vp_w) (local.get $off)))))))))))
          (if (i32.and (local.get $x) (global.get $v_vint_pending))
            (then (if (i32.and (local.get $d) (i32.const 0x20))
                    (then (call $set_irq_delay (i32.const 6)))
                    (else (if (i32.and ${R(0)} (global.get $v_hint_pending))
                            (then (call $set_irq (i32.const 4)))
                            (else (call $set_irq (i32.const 0))))))))
          (if (i32.and (local.get $x) (i32.const 8))
            (then (if (i32.and (local.get $d) (i32.const 4))
                    (then (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 2)))
                          (call $set_vc_max (local.get $d))))))
          (if (i32.and (local.get $x) (i32.const 4))
            (then
              (if (i32.and (local.get $d) (i32.const 4))
                (then (call $vram_m4_to_m5)
                      (call $palette_reset)
                      (global.set $v_hvc_latch (i32.const 0))
                      (if (i32.and ${R(0)} (i32.const 2))
                        (then (global.set $v_hvc_latch (i32.or (call $vdp_hvc_r (local.get $cycles)) (i32.const 0x10000))))))
                (else (call $vram_m5_to_m4)
                      (call $palette_reset_m4)
                      (global.set $v_hvc_latch (i32.or (call $vdp_hvc_r (local.get $cycles)) (i32.const 0x10000)))))
              (call $set_vc_max (local.get $d))
              (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 2)))))
          (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 2))
        (then ${RS(2, '(local.get $d)')}
              (global.set $v_ntab (i32.and (i32.shl (local.get $d) (i32.const 10)) (i32.const 0xE000)))
              (if (call $in_hblank_redraw (local.get $cycles)) (then (call $render_line (global.get $v_v_counter))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 3))
        (then ${RS(3, '(local.get $d)')}
              (global.set $v_ntwb (i32.and (i32.shl (local.get $d) (i32.const 10))
                                           (select (i32.const 0xF000) (i32.const 0xF800) (i32.and ${R(12)} (i32.const 1)))))
              (if (call $in_hblank_redraw (local.get $cycles)) (then (call $render_line (global.get $v_v_counter))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 4))
        (then ${RS(4, '(local.get $d)')}
              (global.set $v_ntbb (i32.and (i32.shl (local.get $d) (i32.const 13)) (i32.const 0xE000)))
              (if (call $in_hblank_redraw (local.get $cycles)) (then (call $render_line (global.get $v_v_counter))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 5))
        (then ${RS(5, '(local.get $d)')}
              (global.set $v_satb (i32.and (i32.shl (local.get $d) (i32.const 9)) (global.get $v_sat_base_mask)))
              (if (call $in_hblank_redraw (local.get $cycles)) (then (call $parse_satb_any (global.get $v_v_counter))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 7))
        (then ${RS(7, '(local.get $d)')}
              (local.set $d (i32.and (local.get $d) (i32.const 0x3F)))
              (if (i32.ne (local.get $d) (global.get $v_border))
                (then (global.set $v_border (local.get $d))
                      (if (i32.and ${R(1)} (i32.const 4))
                        (then (call $color_update (i32.const 0) (call $cram16 (local.get $d))))
                        (else (call $color_update_m4 (i32.const 0x40)
                          (i32.load16_u (i32.add (i32.const ${CRAM}) (i32.shl (i32.or (i32.const 0x10) (i32.and (local.get $d) (i32.const 0x0F))) (i32.const 1)))))))
                      (if (i32.and (i32.lt_u (global.get $v_v_counter) (global.get $vp_h))
                                   (i32.le_u (local.get $cycles) (i32.add (global.get $mcvdp) (i32.const 860))))
                        (then (call $remap_line (global.get $v_v_counter))))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 8))
        (then (if (i32.ge_u (i32.sub (local.get $cycles) (global.get $mcvdp)) (i32.const 3420))
                (then (local.set $i (i32.rem_u (i32.add (global.get $v_v_counter) (i32.const 1)) (i32.const ${LINES})))
                      (if (i32.lt_u (local.get $i) (global.get $vp_h))
                        (then (global.set $v_v_counter (local.get $i)) (call $render_line (local.get $i))))))
              ${RS(8, '(local.get $d)')}
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 11))
        (then ${RS(11, '(local.get $d)')}
              (global.set $v_hscroll_mask (i32.load8_u (i32.add (i32.const ${SMALLT + 0}) (i32.and (local.get $d) (i32.const 3)))))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 12))
        (then
          (local.set $x (i32.xor (local.get $d) ${R(12)}))
          ${RS(12, '(local.get $d)')}
          (if (i32.and (local.get $x) (i32.const 8)) (then (call $palette_reset)))
          (if (i32.and (local.get $x) (i32.const 6))
            (then (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 2)))))
          (if (i32.and (local.get $x) (i32.const 1))
            (then
              (if (i32.and (local.get $d) (i32.const 1))
                (then (global.set $v_ntwb (i32.and (i32.shl ${R(3)} (i32.const 10)) (i32.const 0xF000)))
                      (global.set $v_satb (i32.and (i32.shl ${R(5)} (i32.const 9)) (i32.const 0xFC00)))
                      (global.set $v_sat_base_mask (i32.const 0xFC00)) (global.set $v_sat_addr_mask (i32.const 0x3FF))
                      (global.set $v_h40 (i32.const 1))
                      (call $window_clip ${R(17)} (i32.const 1))
                      (global.set $v_max_sprite_pixels (i32.const 320))
                      (global.set $v_vint_cycle (i32.const 788))
                      (global.set $v_hblank_start (i32.const 228)) (global.set $v_hblank_end (i32.const 872)))
                (else (global.set $v_ntwb (i32.and (i32.shl ${R(3)} (i32.const 10)) (i32.const 0xF800)))
                      (global.set $v_satb (i32.and (i32.shl ${R(5)} (i32.const 9)) (i32.const 0xFE00)))
                      (global.set $v_sat_base_mask (i32.const 0xFE00)) (global.set $v_sat_addr_mask (i32.const 0x1FF))
                      (global.set $v_h40 (i32.const 0))
                      (call $window_clip ${R(17)} (i32.const 0))
                      (global.set $v_max_sprite_pixels (i32.const 256))
                      (global.set $v_vint_cycle (i32.const 770))
                      (global.set $v_hblank_start (i32.const 280)) (global.set $v_hblank_end (i32.const 860))))
              (if (i32.ge_u (global.get $v_v_counter) (global.get $vp_h))
                (then (global.set $vp_w (global.get $v_max_sprite_pixels)))
                (else (if (i32.le_u (global.get $v_v_counter) (i32.const 1))
                  (then (global.set $vp_w (global.get $v_max_sprite_pixels))
                        (call $render_line (i32.const 0))
                        (if (global.get $v_v_counter) (then (call $render_line (i32.const 1)))))
                  (else (global.set $vp_changed (i32.or (global.get $vp_changed) (i32.const 2)))))))))
          (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 13))
        (then ${RS(13, '(local.get $d)')}
              (global.set $v_hscb (i32.and (i32.shl (local.get $d) (i32.const 10)) (i32.const 0xFC00)))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 16))
        (then ${RS(16, '(local.get $d)')}
              (global.set $v_pf_shift (i32.load8_u (i32.add (i32.const ${SMALLT + 4}) (i32.and (local.get $d) (i32.const 3)))))
              (global.set $v_pf_col_mask (i32.load8_u (i32.add (i32.const ${SMALLT + 8}) (i32.and (local.get $d) (i32.const 3)))))
              (global.set $v_pf_row_mask (i32.or (i32.shl (i32.and (i32.shr_u (local.get $d) (i32.const 4)) (i32.const 3)) (i32.const 8))
                                                 (i32.const 0xFF)))
              (br $sw)))
      (if (i32.eq (local.get $r) (i32.const 17))
        (then ${RS(17, '(local.get $d)')}
              (call $window_clip (local.get $d) (i32.and ${R(12)} (i32.const 1)))
              (br $sw)))
      (i32.store8 (i32.add (i32.const ${VREG}) (local.get $r)) (local.get $d))))

  (func $set_vc_max (param $d i32)
    (local.set $d (i32.and (i32.shr_u (local.get $d) (i32.const 2)) (i32.const 3)))
    (global.set $v_vc_max (select (i32.const ${VC[3]}) (select (i32.const ${VC[1]}) (i32.const ${VC[0]}) (i32.eq (local.get $d) (i32.const 1)))
                                  (i32.eq (local.get $d) (i32.const 3)))))

  ;; the 16K <-> 64K VRAM address re-arrangement done when Mode 5 toggles
  (func $vram_m4_to_m5
    (local $i i32) (local $j i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x4000)))
      (memory.copy (i32.const ${LINEBUF}) (i32.add (i32.const ${VRAM}) (local.get $i)) (i32.const 0x400))
      (local.set $j (i32.const 2))
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_u (local.get $j) (i32.const 0x3FE)))
        (i32.store16 (i32.add (i32.add (i32.const ${VRAM}) (local.get $i))
                              (i32.add (i32.and (i32.shl (local.get $j) (i32.const 1)) (i32.const 0x3FC))
                                       (i32.and (i32.shr_u (local.get $j) (i32.const 8)) (i32.const 2))))
                     (i32.load16_u (i32.add (i32.const ${LINEBUF}) (local.get $j))))
        (local.set $j (i32.add (local.get $j) (i32.const 2)))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 0x400)))
      (br $l))))
  (func $vram_m5_to_m4
    (local $i i32) (local $j i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 0x4000)))
      (memory.copy (i32.const ${LINEBUF}) (i32.add (i32.const ${VRAM}) (local.get $i)) (i32.const 0x400))
      (local.set $j (i32.const 2))
      (block $d2 (loop $l2
        (br_if $d2 (i32.ge_u (local.get $j) (i32.const 0x3FE)))
        (i32.store16 (i32.add (i32.add (i32.const ${VRAM}) (local.get $i))
                              (i32.add (i32.and (i32.shr_u (local.get $j) (i32.const 1)) (i32.const 0x1FE))
                                       (i32.and (i32.shl (local.get $j) (i32.const 8)) (i32.const 0x200))))
                     (i32.load16_u (i32.add (i32.const ${LINEBUF}) (local.get $j))))
        (local.set $j (i32.add (local.get $j) (i32.const 2)))
        (br $l2)))
      (local.set $i (i32.add (local.get $i) (i32.const 0x400)))
      (br $l))))

  ;; ---- 68k bus side (mem68k.c vdp_read/write_byte/word) ----------------------
  (func $vdp_rd8 (param $a i32) (result i32)
    (local $s i32)
    (local.set $s (i32.and (local.get $a) (i32.const 0xFD)))
    (if (i32.eqz (local.get $s)) (then (return (i32.shr_u (call $vdp_data_r) (i32.const 8)))))
    (if (i32.eq (local.get $s) (i32.const 1)) (then (return (i32.and (call $vdp_data_r) (i32.const 0xFF)))))
    (if (i32.eq (local.get $s) (i32.const 4))
      (then (return (i32.or (i32.and (i32.shr_u (call $vdp_ctrl_r (global.get $mc)) (i32.const 8)) (i32.const 3))
                            (i32.and (call $raw8 (global.get $pc)) (i32.const 0xFC))))))
    (if (i32.eq (local.get $s) (i32.const 5)) (then (return (i32.and (call $vdp_ctrl_r (global.get $mc)) (i32.const 0xFF)))))
    (if (i32.or (i32.eq (local.get $s) (i32.const 8)) (i32.eq (local.get $s) (i32.const 0xC)))
      (then (return (i32.shr_u (call $vdp_hvc_r (global.get $mc)) (i32.const 8)))))
    (if (i32.or (i32.eq (local.get $s) (i32.const 9)) (i32.eq (local.get $s) (i32.const 0xD)))
      (then (return (i32.and (call $vdp_hvc_r (global.get $mc)) (i32.const 0xFF)))))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x18)) (i32.eq (local.get $s) (i32.const 0x19)))
                (i32.or (i32.eq (local.get $s) (i32.const 0x1C)) (i32.eq (local.get $s) (i32.const 0x1D))))
      (then (return (call $bus8 (local.get $a)))))
    (call $lockup (local.get $a))
    (call $bus8 (local.get $a)))

  (func $vdp_rd16 (param $a i32) (result i32)
    (local $s i32)
    (local.set $s (i32.and (local.get $a) (i32.const 0xFC)))
    (if (i32.eqz (local.get $s)) (then (return (call $vdp_data_r))))
    (if (i32.eq (local.get $s) (i32.const 4))
      (then (return (i32.or (i32.and (call $vdp_ctrl_r (global.get $mc)) (i32.const 0x3FF))
                            (i32.and (call $raw16 (global.get $pc)) (i32.const 0xFC00))))))
    (if (i32.or (i32.eq (local.get $s) (i32.const 8)) (i32.eq (local.get $s) (i32.const 0xC)))
      (then (return (call $vdp_hvc_r (global.get $mc)))))
    (if (i32.or (i32.eq (local.get $s) (i32.const 0x18)) (i32.eq (local.get $s) (i32.const 0x1C)))
      (then (return (call $bus16))))
    (call $lockup (local.get $a))
    (call $bus16))

  (func $vdp_wr8 (param $a i32) (param $v i32)
    (local $s i32)
    (local.set $s (i32.and (local.get $a) (i32.const 0xFC)))
    (if (i32.eqz (local.get $s)) (then (call $vdp_data_w (i32.or (i32.shl (local.get $v) (i32.const 8)) (local.get $v))) (return)))
    (if (i32.eq (local.get $s) (i32.const 4)) (then (call $vdp_ctrl_w (i32.or (i32.shl (local.get $v) (i32.const 8)) (local.get $v))) (return)))
    (if (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x14))) (then (return)))
    (if (i32.or (i32.eq (local.get $s) (i32.const 0x18)) (i32.eq (local.get $s) (i32.const 0x1C))) (then (return)))
    (call $lockup (local.get $a)))

  (func $vdp_wr16 (param $a i32) (param $v i32)
    (local $s i32)
    (local.set $s (i32.and (local.get $a) (i32.const 0xFC)))
    (if (i32.eqz (local.get $s)) (then (call $vdp_data_w (local.get $v)) (return)))
    (if (i32.eq (local.get $s) (i32.const 4)) (then (call $vdp_ctrl_w (local.get $v)) (return)))
    (if (i32.or (i32.eq (local.get $s) (i32.const 0x10)) (i32.eq (local.get $s) (i32.const 0x14))) (then (return)))
    (if (i32.or (i32.eq (local.get $s) (i32.const 0x18)) (i32.eq (local.get $s) (i32.const 0x1C))) (then (return)))
    (call $lockup (local.get $a)))
`;
}

// renderer (vdp_render.c, Mode 5, non-interlaced)
export function renderWat() {
  const base = `
  ;; one 8-pixel pattern row, as bg_pattern_cache would hold it: pixel p of a
  ;; row is nibble (p ^ 3) of the little-endian u32, (p ^ 4) when h-flipped.
  (func $draw_tile (param $dst i32) (param $attr i32) (param $vline i32)
    (local $atex i32) (local $bp i32) (local $row i32)
    (local.set $atex (i32.shl (i32.and (i32.shr_u (local.get $attr) (i32.const 13)) (i32.const 7)) (i32.const 4)))
    (local.set $row (i32.shr_u (local.get $vline) (i32.const 3)))
    (if (i32.and (local.get $attr) (i32.const 0x1000))
      (then (local.set $row (i32.xor (local.get $row) (i32.const 7)))))
    (local.set $bp (i32.load (i32.add (i32.const ${VRAM})
      (i32.or (i32.shl (i32.and (local.get $attr) (i32.const 0x7FF)) (i32.const 5)) (i32.shl (local.get $row) (i32.const 2))))))
    (if (i32.and (local.get $attr) (i32.const 0x800))
      (then
        ${_tile_unrolled([4, 5, 6, 7, 0, 1, 2, 3])})
      (else
        ${_tile_unrolled([3, 2, 1, 0, 7, 6, 5, 4])})))

  (func $draw_col (param $dst i32) (param $at i32) (param $vline i32)
    (call $draw_tile (local.get $dst) (i32.and (local.get $at) (i32.const 0xFFFF)) (local.get $vline))
    (call $draw_tile (i32.add (local.get $dst) (i32.const 8)) (i32.shr_u (local.get $at) (i32.const 16)) (local.get $vline)))

  (func $nt (param $base i32) (param $i i32) (result i32)
    (i32.load (i32.add (i32.const ${VRAM}) (i32.and (i32.add (local.get $base) (i32.shl (local.get $i) (i32.const 2))) (i32.const 0xFFFF)))))

  (func $merge (param $lut i32)
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (global.get $vp_w)))
      (i32.store8 (i32.add (i32.const ${LB0 + 0x20}) (local.get $i))
        (i32.load8_u (i32.add (local.get $lut)
          (i32.or (i32.shl (i32.load8_u (i32.add (i32.const ${LB0 + 0x20}) (local.get $i))) (i32.const 8))
                  (i32.load8_u (i32.add (i32.const ${LB1 + 0x20}) (local.get $i)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; render_bg_m5 / render_bg_m5_vs (vs = 2-cell vertical scroll, reg11 bit 2)
  (func $render_bg (param $line i32)
    (local $xs i32) (local $ys i32) (local $a i32) (local $w i32) (local $start i32) (local $end i32)
    (local $shift i32) (local $index i32) (local $vl i32) (local $nt i32) (local $dst i32) (local $col i32)
    (local $vs i32) (local $cm i32) (local $rm i32) (local $ps i32) (local $vsm i32)
    (local.set $vsm (i32.and ${R(11)} (i32.const 4)))
    (local.set $cm (global.get $v_pf_col_mask))
    (local.set $rm (global.get $v_pf_row_mask))
    (local.set $ps (global.get $v_pf_shift))
    (local.set $xs (i32.load (i32.add (i32.const ${VRAM})
      (i32.and (i32.add (global.get $v_hscb) (i32.shl (i32.and (local.get $line) (global.get $v_hscroll_mask)) (i32.const 2)))
               (i32.const 0xFFFF)))))
    (if (local.get $vsm)
      (then (if (i32.and ${R(12)} (i32.const 1))
              (then (local.set $vs (i32.load (i32.const ${VSRAM + 19 * 4})))
                    (local.set $ys (i32.and (local.get $vs) (i32.shr_u (local.get $vs) (i32.const 16)))))))
      (else (local.set $ys (i32.load (i32.const ${VSRAM})))))
    (local.set $a (i32.shl (i32.and ${R(18)} (i32.const 0x1F)) (i32.const 3)))
    (local.set $w (i32.and (i32.shr_u ${R(18)} (i32.const 7)) (i32.const 1)))
    (local.set $end (i32.shr_u (global.get $vp_w) (i32.const 4)))
    ;; ---- plane B
    (local.set $shift (i32.and (i32.shr_u (local.get $xs) (i32.const 16)) (i32.const 0xF)))
    (local.set $index (i32.sub (i32.add (local.get $cm) (i32.const 1))
                               (i32.and (i32.shr_u (local.get $xs) (i32.const 20)) (local.get $cm))))
    (if (local.get $shift)
      (then
        (local.set $vl (i32.and (i32.add (local.get $line)
                                         (select (local.get $ys) (i32.shr_u (local.get $ys) (i32.const 16)) (local.get $vsm)))
                                (local.get $rm)))
        (local.set $nt (i32.add (global.get $v_ntbb)
          (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
        (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))
        (local.set $dst (i32.add (i32.const ${LB0 + 0x10}) (local.get $shift)))
        (call $draw_col (local.get $dst)
          (call $nt (local.get $nt) (i32.and (i32.sub (local.get $index) (i32.const 1)) (local.get $cm))) (local.get $vl))
        (local.set $dst (i32.add (local.get $dst) (i32.const 16))))
      (else (local.set $dst (i32.const ${LB0 + 0x20}))))
    (if (i32.eqz (local.get $vsm))
      (then
        (local.set $vl (i32.and (i32.add (local.get $line) (i32.shr_u (local.get $ys) (i32.const 16))) (local.get $rm)))
        (local.set $nt (i32.add (global.get $v_ntbb)
          (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
        (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))))
    (local.set $col (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_s (local.get $col) (local.get $end)))
      (if (local.get $vsm)
        (then
          (local.set $vl (i32.and (i32.add (local.get $line)
            (i32.shr_u (i32.load (i32.add (i32.const ${VSRAM}) (i32.shl (local.get $col) (i32.const 2)))) (i32.const 16)))
            (local.get $rm)))
          (local.set $nt (i32.add (global.get $v_ntbb)
            (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
          (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))))
      (call $draw_col (local.get $dst) (call $nt (local.get $nt) (i32.and (local.get $index) (local.get $cm))) (local.get $vl))
      (local.set $dst (i32.add (local.get $dst) (i32.const 16)))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (br $l)))
    ;; ---- window / plane A split
    (if (i32.eq (local.get $w) (i32.ge_s (local.get $line) (local.get $a)))
      (then (local.set $a (i32.const 0)) (local.set $w (i32.const 1)))
      (else (local.set $a (call $clip (i32.const 0) (i32.const 2)))
            (local.set $w (call $clip (i32.const 1) (i32.const 2)))))
    (if (local.get $a)
      (then
        (local.set $start (call $clip (i32.const 0) (i32.const 0)))
        (local.set $end (call $clip (i32.const 0) (i32.const 1)))
        (local.set $shift (i32.and (local.get $xs) (i32.const 0xF)))
        (local.set $index (i32.sub (i32.add (i32.add (local.get $cm) (local.get $start)) (i32.const 1))
                                   (i32.and (i32.shr_u (local.get $xs) (i32.const 4)) (local.get $cm))))
        (if (local.get $shift)
          (then
            (local.set $vl (i32.and (i32.add (local.get $line) (local.get $ys)) (local.get $rm)))
            (local.set $nt (i32.add (global.get $v_ntab)
              (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
            (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))
            (local.set $dst (i32.add (i32.add (i32.const ${LB1 + 0x10}) (local.get $shift)) (i32.shl (local.get $start) (i32.const 4))))
            (call $draw_col (local.get $dst)
              (call $nt (local.get $nt)
                (i32.and (select (local.get $index) (i32.sub (local.get $index) (i32.const 1)) (local.get $start))
                         (local.get $cm)))
              (local.get $vl))
            (local.set $dst (i32.add (local.get $dst) (i32.const 16))))
          (else (local.set $dst (i32.add (i32.const ${LB1 + 0x20}) (i32.shl (local.get $start) (i32.const 4))))))
        (if (i32.eqz (local.get $vsm))
          (then
            (local.set $vl (i32.and (i32.add (local.get $line) (local.get $ys)) (local.get $rm)))
            (local.set $nt (i32.add (global.get $v_ntab)
              (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
            (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))))
        (local.set $col (local.get $start))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $col) (local.get $end)))
          (if (local.get $vsm)
            (then
              (local.set $vl (i32.and (i32.add (local.get $line)
                (i32.load (i32.add (i32.const ${VSRAM}) (i32.shl (local.get $col) (i32.const 2)))))
                (local.get $rm)))
              (local.set $nt (i32.add (global.get $v_ntab)
                (i32.and (i32.shl (i32.shr_u (local.get $vl) (i32.const 3)) (local.get $ps)) (i32.const 0x1FC0))))
              (local.set $vl (i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3)))))
          (call $draw_col (local.get $dst) (call $nt (local.get $nt) (i32.and (local.get $index) (local.get $cm))) (local.get $vl))
          (local.set $dst (i32.add (local.get $dst) (i32.const 16)))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (local.set $index (i32.add (local.get $index) (i32.const 1)))
          (br $l)))
        (local.set $start (call $clip (i32.const 1) (i32.const 0)))
        (local.set $end (call $clip (i32.const 1) (i32.const 1)))))
    (if (local.get $w)
      (then
        (local.set $nt (i32.or (global.get $v_ntwb)
          (i32.shl (i32.shr_u (local.get $line) (i32.const 3)) (i32.add (i32.const 6) (i32.and ${R(12)} (i32.const 1))))))
        (local.set $vl (i32.shl (i32.and (local.get $line) (i32.const 7)) (i32.const 3)))
        (local.set $dst (i32.add (i32.const ${LB1 + 0x20}) (i32.shl (local.get $start) (i32.const 4))))
        (local.set $col (local.get $start))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $col) (local.get $end)))
          (call $draw_col (local.get $dst) (call $nt (local.get $nt) (local.get $col)) (local.get $vl))
          (local.set $dst (i32.add (local.get $dst) (i32.const 16)))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $l)))))
    (call $merge (i32.add (i32.const ${LUT}) (i32.shl (i32.shr_u (i32.and ${R(12)} (i32.const 8)) (i32.const 2)) (i32.const 16)))))

  ;; parse_satb_m5
  (func $parse_satb (param $line i32)
    (local $ypos i32) (local $height i32) (local $size i32) (local $link i32) (local $count i32)
    (local $max i32) (local $total i32) (local $obj i32) (local $par i32)
    (local.set $max (i32.shr_u (global.get $vp_w) (i32.const 4)))
    (local.set $total (i32.shr_u (global.get $v_max_sprite_pixels) (i32.const 2)))
    (local.set $par (i32.and (i32.add (local.get $line) (i32.const 1)) (i32.const 1)))
    (local.set $obj (i32.add (i32.const ${OBJ}) (i32.mul (local.get $par) (i32.const 160))))
    (local.set $line (i32.add (local.get $line) (i32.const 0x81)))
    (block $d (loop $l
      (local.set $ypos (i32.and (i32.load16_u (i32.add (i32.const ${SAT}) (i32.shl (local.get $link) (i32.const 1)))) (i32.const 0x1FF)))
      (if (i32.ge_s (local.get $line) (local.get $ypos))
        (then
          (local.set $size (i32.shr_u (i32.load16_u (i32.add (i32.const ${SAT}) (i32.shl (i32.add (local.get $link) (i32.const 1)) (i32.const 1)))) (i32.const 8)))
          (local.set $height (i32.add (i32.const 8) (i32.shl (i32.and (local.get $size) (i32.const 3)) (i32.const 3))))
          (local.set $ypos (i32.sub (local.get $line) (local.get $ypos)))
          (if (i32.lt_s (local.get $ypos) (local.get $height))
            (then
              (if (i32.eq (local.get $count) (local.get $max))
                (then (global.set $v_status (i32.or (global.get $v_status) (i32.const 0x40))) (br $d)))
              (i32.store16 (local.get $obj) (local.get $ypos))
              (i32.store16 (i32.add (local.get $obj) (i32.const 2))
                (i32.and (i32.load16_u (i32.add (i32.const ${VRAM}) (i32.and (i32.add (global.get $v_satb) (i32.shl (i32.add (local.get $link) (i32.const 3)) (i32.const 1))) (i32.const 0xFFFF))))
                         (i32.const 0x1FF)))
              (i32.store16 (i32.add (local.get $obj) (i32.const 4))
                (i32.load16_u (i32.add (i32.const ${VRAM}) (i32.and (i32.add (global.get $v_satb) (i32.shl (i32.add (local.get $link) (i32.const 2)) (i32.const 1))) (i32.const 0xFFFF)))))
              (i32.store16 (i32.add (local.get $obj) (i32.const 6)) (i32.and (local.get $size) (i32.const 0xF)))
              (local.set $count (i32.add (local.get $count) (i32.const 1)))
              (local.set $obj (i32.add (local.get $obj) (i32.const 8)))))))
      (local.set $link (i32.shl (i32.and (i32.load16_u (i32.add (i32.const ${SAT}) (i32.shl (i32.add (local.get $link) (i32.const 1)) (i32.const 1))))
                                         (i32.const 0x7F)) (i32.const 2)))
      (br_if $d (i32.eqz (local.get $link)))
      (br_if $d (i32.ge_u (local.get $link) (global.get $vp_w)))
      (local.set $total (i32.sub (local.get $total) (i32.const 1)))
      (br_if $l (local.get $total))))
    (i32.store8 (i32.add (i32.const ${OBJCNT}) (i32.and (local.get $line) (i32.const 1))) (local.get $count)))

  ;; render_obj_m5 / render_obj_m5_ste (ste: sprites into linebuf[1], then merged)
  (func $render_obj (param $par i32)
    (local $obj i32) (local $count i32) (local $xpos i32) (local $width i32) (local $pixelcount i32)
    (local $masked i32) (local $maxp i32) (local $attr i32) (local $vline i32) (local $atex i32)
    (local $name i32) (local $s i32) (local $lb i32) (local $col i32) (local $ste i32) (local $lut i32)
    (local $t i32) (local $i i32) (local $px i32) (local $bp i32) (local $row i32) (local $tmp i32)
    (local.set $ste (i32.ne (i32.and ${R(12)} (i32.const 8)) (i32.const 0)))
    (local.set $lut (select (i32.const ${LUT + 3 * 0x10000}) (i32.const ${LUT + 1 * 0x10000}) (local.get $ste)))
    (local.set $maxp (global.get $v_max_sprite_pixels))
    (local.set $obj (i32.add (i32.const ${OBJ}) (i32.mul (local.get $par) (i32.const 160))))
    (local.set $count (i32.load8_u (i32.add (i32.const ${OBJCNT}) (local.get $par))))
    (if (local.get $ste)
      (then (memory.fill (i32.const ${LB1}) (i32.const 0) (i32.add (global.get $vp_w) (i32.const 0x40)))))
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $count)))
      (local.set $count (i32.sub (local.get $count) (i32.const 1)))
      (local.set $xpos (i32.load16_u (i32.add (local.get $obj) (i32.const 2))))
      (if (local.get $xpos)
        (then (global.set $spr_ovr (i32.const 1)))
        (else (if (global.get $spr_ovr) (then (local.set $masked (i32.const 1))))))
      (local.set $xpos (i32.sub (local.get $xpos) (i32.const 0x80)))
      (local.set $t (i32.load16_u (i32.add (local.get $obj) (i32.const 6))))
      (local.set $width (i32.add (i32.const 8) (i32.shl (i32.and (local.get $t) (i32.const 0xC)) (i32.const 1))))
      (local.set $pixelcount (i32.add (local.get $pixelcount) (local.get $width)))
      (if (i32.and (i32.and (i32.gt_s (i32.add (local.get $xpos) (local.get $width)) (i32.const 0))
                            (i32.lt_s (local.get $xpos) (global.get $vp_w)))
                   (i32.eqz (local.get $masked)))
        (then
          (local.set $attr (i32.load16_u (i32.add (local.get $obj) (i32.const 4))))
          (local.set $vline (i32.load16_u (local.get $obj)))
          (local.set $atex (i32.and (i32.shr_u (local.get $attr) (i32.const 9)) (i32.const 0x70)))
          (local.set $name (i32.and (local.get $attr) (i32.const 0x7FF)))
          (local.set $attr (i32.and (local.get $attr) (i32.const 0x1800)))
          (local.set $s (i32.add (i32.const ${NAMELUT})
            (i32.or (i32.or (i32.and (i32.shr_u (local.get $attr) (i32.const 3)) (i32.const 0x300))
                            (i32.shl (local.get $t) (i32.const 4)))
                    (i32.shr_u (i32.and (local.get $vline) (i32.const 0x18)) (i32.const 1)))))
          (local.set $lb (i32.add (select (i32.const ${LB1 + 0x20}) (i32.const ${LB0 + 0x20}) (local.get $ste)) (local.get $xpos)))
          (if (i32.gt_s (local.get $pixelcount) (local.get $maxp))
            (then (local.set $width (i32.sub (local.get $width) (i32.sub (local.get $pixelcount) (local.get $maxp))))))
          (local.set $width (i32.shr_s (local.get $width) (i32.const 3)))
          (local.set $vline (i32.and (local.get $vline) (i32.const 7)))
          (local.set $col (i32.const 0))
          (block $cd (loop $cl
            (br_if $cd (i32.ge_s (local.get $col) (local.get $width)))
            (local.set $tmp (i32.or (local.get $attr)
              (i32.and (i32.add (local.get $name) (i32.load8_u (i32.add (local.get $s) (local.get $col)))) (i32.const 0x7FF))))
            ;; pattern row: v-flip picks row ^ 7, h-flip reverses nibble order
            (local.set $row (local.get $vline))
            (if (i32.and (local.get $tmp) (i32.const 0x1000)) (then (local.set $row (i32.xor (local.get $row) (i32.const 7)))))
            (local.set $bp (i32.load (i32.add (i32.const ${VRAM})
              (i32.or (i32.shl (i32.and (local.get $tmp) (i32.const 0x7FF)) (i32.const 5)) (i32.shl (local.get $row) (i32.const 2))))))
            (local.set $i (i32.const 0))
            (block $pd (loop $pl
              (br_if $pd (i32.ge_u (local.get $i) (i32.const 8)))
              (local.set $px (i32.and (i32.shr_u (local.get $bp)
                (i32.shl (i32.xor (local.get $i) (select (i32.const 4) (i32.const 3) (i32.and (local.get $tmp) (i32.const 0x800))))
                         (i32.const 2))) (i32.const 15)))
              (if (local.get $px)
                (then
                  (local.set $px (i32.or (local.get $px)
                    (i32.shl (i32.load8_u (i32.add (local.get $lb) (local.get $i))) (i32.const 8))))
                  (i32.store8 (i32.add (local.get $lb) (local.get $i))
                    (i32.load8_u (i32.add (local.get $lut) (i32.or (local.get $px) (local.get $atex)))))
                  (global.set $v_status (i32.or (global.get $v_status)
                    (i32.shr_u (i32.and (local.get $px) (i32.const 0x8000)) (i32.const 10))))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $pl)))
            (local.set $lb (i32.add (local.get $lb) (i32.const 8)))
            (local.set $col (i32.add (local.get $col) (i32.const 1)))
            (br $cl)))))
      (if (i32.ge_s (local.get $pixelcount) (local.get $maxp))
        (then (global.set $spr_ovr (i32.ge_s (local.get $pixelcount) (global.get $vp_w)))
              (if (local.get $ste) (then (call $merge (i32.const ${LUT + 4 * 0x10000}))))
              (return)))
      (local.set $obj (i32.add (local.get $obj) (i32.const 8)))
      (br $l)))
    (global.set $spr_ovr (i32.const 0))
    (if (local.get $ste) (then (call $merge (i32.const ${LUT + 4 * 0x10000})))))

  (func $remap_line (param $line i32)
    (local $i i32) (local $dst i32)
    (if (i32.ge_u (local.get $line) (i32.const ${FB_H})) (then (return)))
    (memory.copy (i32.add (i32.const ${0x142000}) (i32.mul (local.get $line) (i32.const 320)))
                 (i32.const ${LB0 + 0x20}) (global.get $vp_w))
    (local.set $dst (i32.add (i32.const ${FB}) (i32.mul (local.get $line) (i32.const ${FB_W * 4}))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (global.get $vp_w)))
      (i32.store (i32.add (local.get $dst) (i32.shl (local.get $i) (i32.const 2)))
        (i32.load (i32.add (i32.const ${PIXEL})
          (i32.shl (i32.load8_u (i32.add (i32.const ${LB0 + 0x20}) (local.get $i))) (i32.const 2)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $blank_line (param $line i32) (param $off i32) (param $width i32)
    (memory.fill (i32.add (i32.const ${LB0 + 0x20}) (local.get $off)) (i32.const 0x40) (local.get $width))
    (call $remap_line (local.get $line)))

  (func $render_line (param $line i32)
    (global.set $nredraw (i32.add (global.get $nredraw) (i32.const 1)))
    (if (i32.and ${R(1)} (i32.const 0x40))
      (then
        (if (i32.eqz (i32.and ${R(1)} (i32.const 4)))
          (then (global.set $nm4 (i32.add (global.get $nm4) (i32.const 1)))
                (call $render_bg_m4 (local.get $line))
                (call $render_obj_m4 (i32.and (local.get $line) (i32.const 1)))
                (if (i32.and ${R(0)} (i32.const 0x20))
                  (then (memory.fill (i32.const ${LB0 + 0x20}) (i32.const 0x40) (i32.const 8))))
                (if (i32.lt_s (local.get $line) (i32.sub (global.get $vp_h) (i32.const 1)))
                  (then (call $parse_satb_m4 (local.get $line))))
                (call $remap_line (local.get $line)) (return)))
        (if (global.get $v_im2)
          (then (global.set $nim2 (i32.add (global.get $nim2) (i32.const 1)))
                (call $render_bg_im2 (local.get $line))
                (call $render_obj_im2 (i32.and (local.get $line) (i32.const 1))))
          (else (call $render_bg (local.get $line))
                (call $render_obj (i32.and (local.get $line) (i32.const 1)))))
        (if (i32.and ${R(0)} (i32.const 0x20))
          (then (memory.fill (i32.const ${LB0 + 0x20}) (i32.const 0x40) (i32.const 8))))
        (if (i32.lt_s (local.get $line) (i32.sub (global.get $vp_h) (i32.const 1)))
          (then (call $parse_satb_any (local.get $line)))))
      (else (memory.fill (i32.const ${LB0 + 0x20}) (i32.const 0x40) (global.get $vp_w))))
    (call $remap_line (local.get $line)))
`;
  return base + im2Wat(base) + mode4Wat();
}

/**
 * Mode 4 on the Mega Drive VDP (vdp_render.c render_bg_m4 / parse_satb_m4 /
 * render_obj_m4 with system_hw = SYSTEM_MD: no 315-5124 masks, no sprite
 * zoom, and the latched vertical scroll never updated by the Mega Drive
 * frame, so it stays 0). Patterns are decoded from the 16KB VRAM as
 * update_bg_pattern_cache_m4 does.
 */
function mode4Wat() {
  const vb = (e) => `(i32.load8_u (i32.add (i32.const ${VRAM}) ${e}))`;
  return `
  ;; pixel x (0 = left) of row y of Mode 4 pattern n (4 bitplane bytes per row)
  (func $m4_px (param $n i32) (param $y i32) (param $x i32) (result i32)
    (local $a i32) (local $s i32)
    (local.set $a (i32.add (i32.const ${VRAM}) (i32.and (i32.or (i32.shl (local.get $n) (i32.const 5)) (i32.shl (local.get $y) (i32.const 2))) (i32.const 0x3FFF))))
    (local.set $s (i32.sub (i32.const 7) (local.get $x)))
    (i32.or (i32.or (i32.and (i32.shr_u (i32.load8_u (local.get $a)) (local.get $s)) (i32.const 1))
                    (i32.shl (i32.and (i32.shr_u (i32.load8_u offset=1 (local.get $a)) (local.get $s)) (i32.const 1)) (i32.const 1)))
            (i32.or (i32.shl (i32.and (i32.shr_u (i32.load8_u offset=2 (local.get $a)) (local.get $s)) (i32.const 1)) (i32.const 2))
                    (i32.shl (i32.and (i32.shr_u (i32.load8_u offset=3 (local.get $a)) (local.get $s)) (i32.const 1)) (i32.const 3)))))

  (func $render_bg_m4 (param $line i32)
    (local $index i32) (local $shift i32) (local $v i32) (local $mask i32) (local $nt i32) (local $row i32)
    (local $col i32) (local $attr i32) (local $atex i32) (local $dst i32) (local $x i32) (local $r i32)
    (local.set $index (select (i32.const 0x100) ${R(8)} (i32.and (i32.ne (i32.and ${R(0)} (i32.const 0x40)) (i32.const 0)) (i32.lt_s (local.get $line) (i32.const 0x10)))))
    (local.set $shift (i32.and (local.get $index) (i32.const 7)))
    (local.set $dst (i32.add (i32.const ${LB0 + 0x20}) (local.get $shift)))
    (local.set $v (i32.rem_s (local.get $line) (i32.const 224)))
    (local.set $mask (i32.and (i32.or (i32.xor (i32.const 0xFFFFC3FF) (i32.shl ${R(2)} (i32.const 10))) (i32.const 0x400)) (i32.const 0xFFFF)))
    (local.set $nt (i32.and (i32.add (i32.const 0x3800) (i32.shl (i32.shr_u (local.get $v) (i32.const 3)) (i32.const 6))) (local.get $mask)))
    (local.set $row (i32.and (local.get $v) (i32.const 7)))
    (local.set $index (i32.shr_u (i32.sub (i32.const 0x100) (local.get $index)) (i32.const 3)))
    (if (local.get $shift)
      (then (memory.fill (i32.const ${LB0 + 0x20}) (i32.const 0) (local.get $shift))
            (local.set $index (i32.add (local.get $index) (i32.const 1)))))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $col) (i32.const 32)))
      (if (i32.and (i32.eq (local.get $col) (i32.const 24)) (i32.ne (i32.and ${R(0)} (i32.const 0x80)) (i32.const 0)))
        (then (local.set $nt (i32.and (i32.add (i32.const 0x3800) (i32.shl (i32.shr_u (local.get $line) (i32.const 3)) (i32.const 6))) (local.get $mask)))
              (local.set $row (i32.and (local.get $line) (i32.const 7)))))
      (local.set $attr (i32.load16_u (i32.add (i32.const ${VRAM}) (i32.and (i32.add (local.get $nt) (i32.shl (i32.and (local.get $index) (i32.const 0x1F)) (i32.const 1))) (i32.const 0xFFFF)))))
      (local.set $atex (i32.shl (i32.and (i32.shr_u (local.get $attr) (i32.const 11)) (i32.const 3)) (i32.const 4)))
      (local.set $r (select (i32.xor (local.get $row) (i32.const 7)) (local.get $row) (i32.and (local.get $attr) (i32.const 0x400))))
      (local.set $x (i32.const 0))
      (block $pd (loop $pl
        (br_if $pd (i32.ge_u (local.get $x) (i32.const 8)))
        (i32.store8 (i32.add (local.get $dst) (local.get $x))
          (i32.or (call $m4_px (i32.and (local.get $attr) (i32.const 0x1FF)) (local.get $r)
                    (select (i32.xor (local.get $x) (i32.const 7)) (local.get $x) (i32.and (local.get $attr) (i32.const 0x200))))
                  (local.get $atex)))
        (local.set $x (i32.add (local.get $x) (i32.const 1)))
        (br $pl)))
      (local.set $dst (i32.add (local.get $dst) (i32.const 8)))
      (local.set $index (i32.add (local.get $index) (i32.const 1)))
      (local.set $col (i32.add (local.get $col) (i32.const 1)))
      (br $l))))

  ;; parse_satb_m4: up to 8 sprites a line (obj_info: ypos, xpos, attr)
  (func $parse_satb_m4 (param $line i32)
    (local $i i32) (local $count i32) (local $ypos i32) (local $obj i32) (local $height i32) (local $mask i32) (local $st i32) (local $attr i32)
    (local.set $obj (i32.add (i32.const ${OBJ}) (i32.mul (i32.and (i32.add (local.get $line) (i32.const 1)) (i32.const 1)) (i32.const 160))))
    (local.set $height (i32.add (i32.const 8) (i32.shl (i32.and ${R(1)} (i32.const 2)) (i32.const 2))))
    (local.set $mask (i32.and (i32.or (i32.xor (i32.const 0xFFFFC07F) (i32.shl ${R(5)} (i32.const 7))) (i32.const 0x80)) (i32.const 0xFFFF)))
    (local.set $st (i32.and (local.get $mask) (i32.const 0x3F00)))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 64)))
      (local.set $ypos ${vb("(i32.add (local.get $st) (local.get $i))")})
      (br_if $d (i32.and (i32.eq (local.get $ypos) (i32.const 208)) (i32.eq (global.get $vp_h) (i32.const 192))))
      (if (i32.gt_s (local.get $ypos) (i32.add (global.get $vp_h) (i32.const 16))) (then (local.set $ypos (i32.sub (local.get $ypos) (i32.const 256)))))
      (local.set $ypos (i32.sub (local.get $line) (local.get $ypos)))
      (if (i32.and (i32.ge_s (local.get $ypos) (i32.const 0)) (i32.lt_s (local.get $ypos) (local.get $height)))
        (then
          (if (i32.eq (local.get $count) (i32.const 8))
            (then (if (i32.and (i32.ge_s (local.get $line) (i32.const 0)) (i32.lt_s (local.get $line) (global.get $vp_h)))
                    (then (global.set $spr_ovr (i32.const 0x40))))
                  (br $d)))
          (i32.store16 (local.get $obj) (local.get $ypos))
          (i32.store16 offset=2 (local.get $obj) ${vb("(i32.add (local.get $st) (i32.and (i32.add (i32.const 0x80) (i32.shl (local.get $i) (i32.const 1))) (local.get $mask)))")})
          (local.set $attr ${vb("(i32.add (local.get $st) (i32.and (i32.add (i32.const 0x81) (i32.shl (local.get $i) (i32.const 1))) (local.get $mask)))")})
          (if (i32.and ${R(1)} (i32.const 2)) (then (local.set $attr (i32.and (local.get $attr) (i32.const 0xFE)))))
          (i32.store16 offset=4 (local.get $obj) (local.get $attr))
          (local.set $count (i32.add (local.get $count) (i32.const 1)))
          (local.set $obj (i32.add (local.get $obj) (i32.const 8)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)))
    (i32.store8 (i32.add (i32.const ${OBJCNT}) (i32.and (i32.add (local.get $line) (i32.const 1)) (i32.const 1))) (local.get $count)))

  ;; render_obj_m4 (DRAW_SPRITE_TILE_ACCURATE through make_lut_bgobj_m4)
  (func $render_obj_m4 (param $par i32)
    (local $obj i32) (local $count i32) (local $mask i32) (local $n i32) (local $xpos i32) (local $skip i32) (local $end i32)
    (local $i i32) (local $c i32) (local $b i32) (local $lb i32) (local $y i32)
    (local.set $obj (i32.add (i32.const ${OBJ}) (i32.mul (local.get $par) (i32.const 160))))
    (local.set $count (i32.load8_u (i32.add (i32.const ${OBJCNT}) (local.get $par))))
    (local.set $mask (i32.and (i32.or (i32.xor (i32.const 0xFFFFFE3F) (i32.shl ${R(6)} (i32.const 6))) (i32.const 0xC0)) (i32.const 0xFFFF)))
    (global.set $v_status (i32.or (global.get $v_status) (global.get $spr_ovr)))
    (global.set $spr_ovr (i32.const 0))
    (block $done (loop $l
      (br_if $done (i32.eqz (local.get $count)))
      (local.set $count (i32.sub (local.get $count) (i32.const 1)))
      (local.set $y (i32.load16_u (local.get $obj)))
      (local.set $n (i32.or (i32.and (i32.or (i32.load16_u offset=4 (local.get $obj)) (i32.const 0x100)) (local.get $mask)) (i32.shr_u (local.get $y) (i32.const 3))))
      (local.set $xpos (i32.sub (i32.load16_u offset=2 (local.get $obj)) (i32.and ${R(0)} (i32.const 8))))
      (local.set $skip (i32.const 0))
      (if (i32.lt_s (local.get $xpos) (i32.const 0))
        (then (local.set $skip (i32.sub (i32.const 0) (local.get $xpos)))
              (local.set $end (i32.add (local.get $xpos) (i32.const 8)))
              (local.set $xpos (i32.const 0)))
        (else (local.set $end (select (i32.sub (i32.const 256) (local.get $xpos)) (i32.const 8) (i32.gt_s (i32.add (local.get $xpos) (i32.const 8)) (i32.const 256))))))
      (local.set $lb (i32.add (i32.const ${LB0 + 0x20}) (local.get $xpos)))
      (local.set $i (i32.const 0))
      (block $pd (loop $pl
        (br_if $pd (i32.ge_s (local.get $i) (local.get $end)))
        (local.set $c (call $m4_px (local.get $n) (i32.and (local.get $y) (i32.const 7)) (i32.add (local.get $i) (local.get $skip))))
        (if (local.get $c)
          (then
            (local.set $b (i32.load8_u (i32.add (local.get $lb) (local.get $i))))
            ;; make_lut_bgobj_m4: an earlier sprite pixel, or a high-priority
            ;; non-zero background pixel, stays
            (if (i32.eqz (i32.and (local.get $b) (i32.const 0x80)))
              (then (i32.store8 (i32.add (local.get $lb) (local.get $i))
                      (i32.or (select (i32.and (local.get $b) (i32.const 0x3F)) (i32.or (local.get $c) (i32.const 0x10))
                                      (i32.and (i32.ne (i32.and (local.get $b) (i32.const 0x20)) (i32.const 0)) (i32.ne (i32.and (local.get $b) (i32.const 0x0F)) (i32.const 0))))
                              (i32.const 0x80)))))
            (if (i32.and (i32.ne (i32.and (local.get $b) (i32.const 0x80)) (i32.const 0)) (i32.eqz (i32.and (global.get $v_status) (i32.const 0x20))))
              (then (global.set $v_status (i32.or (global.get $v_status) (i32.const 0x20)))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $pl)))
      (local.set $obj (i32.add (local.get $obj) (i32.const 8)))
      (br $l))))
`;
}

/** The text of one `(func $name ...)` in `wat` (balanced parentheses). */
function funcText(wat, name) {
  const i = wat.indexOf(`(func ${name} `);
  if (i < 0) throw new Error(`renderWat: no ${name}`);
  let d = 0;
  for (let j = i; j < wat.length; j++) {
    if (wat[j] === "(") d++;
    else if (wat[j] === ")" && --d === 0) return wat.slice(i, j + 1);
  }
  throw new Error(`renderWat: ${name} unbalanced`);
}

/** Replace `from` (which must occur, `n` times when given) in `s`. */
function must(s, from, to, n) {
  const k = s.split(from).length - 1;
  if (!k || (n !== undefined && k !== n)) throw new Error(`renderWat im2: '${from.slice(0, 60)}' found ${k} times`);
  return s.split(from).join(to);
}

/**
 * Interlace mode 2 (reg12 bits 1-2 = 3): render_bg_m5_im2(_vs),
 * render_obj_m5_im2(_ste) and parse_satb_m5_im2 are the Mode 5 functions on
 * the doubled line ((line << 1) + odd_frame) with 8x16 patterns: pattern
 * row 0-15 of a 10-bit pattern number N is 8x8 pattern 2N + half at row & 7,
 * half = (row >> 3) ^ vflip (the cache's GET_*_TILE_IM2 index). Derived from
 * the Mode 5 text so the two cannot drift.
 * @param {string} base renderWat's Mode 5 functions
 */
function im2Wat(base) {
  let bg = funcText(base, "$render_bg");
  bg = must(bg, "(func $render_bg ", "(func $render_bg_im2 ", 1);
  bg = must(bg, "(local.set $rm (global.get $v_pf_row_mask))", "(local.set $rm (i32.or (i32.shl (global.get $v_pf_row_mask) (i32.const 1)) (i32.const 1)))", 1);
  bg = must(bg, `(local.set $a (i32.shl (i32.and ${R(18)} (i32.const 0x1F)) (i32.const 3)))`,
    `(local.set $line (i32.add (i32.shl (local.get $line) (i32.const 1)) (global.get $v_odd_frame)))
    (local.set $a (i32.shl (i32.and ${R(18)} (i32.const 0x1F)) (i32.const 4)))`, 1);
  bg = must(bg, "(i32.shr_u (local.get $vl) (i32.const 3))", "(i32.shr_u (local.get $vl) (i32.const 4))");
  bg = must(bg, "(i32.shl (i32.and (local.get $vl) (i32.const 7)) (i32.const 3))", "(i32.shl (i32.and (local.get $vl) (i32.const 15)) (i32.const 3))");
  bg = must(bg, "(i32.shl (i32.shr_u (local.get $line) (i32.const 3)) (i32.add (i32.const 6)", "(i32.shl (i32.shr_u (local.get $line) (i32.const 4)) (i32.add (i32.const 6)", 1);
  bg = must(bg, "(local.set $vl (i32.shl (i32.and (local.get $line) (i32.const 7)) (i32.const 3)))", "(local.set $vl (i32.shl (i32.and (local.get $line) (i32.const 15)) (i32.const 3)))", 1);
  bg = must(bg, "(call $draw_col ", "(call $draw_col_im2 ");
  let ps = funcText(base, "$parse_satb");
  ps = must(ps, "(func $parse_satb ", "(func $parse_satb_im2 ", 1);
  ps = must(ps, "(local.set $line (i32.add (local.get $line) (i32.const 0x81)))",
    "(local.set $line (i32.add (i32.shl (i32.add (local.get $line) (i32.const 0x81)) (i32.const 1)) (global.get $v_odd_frame)))", 1);
  ps = must(ps, "(i32.shl (local.get $link) (i32.const 1)))) (i32.const 0x1FF)))", "(i32.shl (local.get $link) (i32.const 1)))) (i32.const 0x3FF)))", 1);
  ps = must(ps, "(local.set $height (i32.add (i32.const 8) (i32.shl (i32.and (local.get $size) (i32.const 3)) (i32.const 3))))",
    "(local.set $height (i32.add (i32.const 16) (i32.shl (i32.and (local.get $size) (i32.const 3)) (i32.const 4))))", 1);
  ps = must(ps, `(i32.store8 (i32.add (i32.const ${OBJCNT}) (i32.and (local.get $line) (i32.const 1))) (local.get $count))`,
    `(i32.store8 (i32.add (i32.const ${OBJCNT}) (i32.and (i32.shr_u (local.get $line) (i32.const 1)) (i32.const 1))) (local.get $count))`, 1);
  let ob = funcText(base, "$render_obj");
  ob = must(ob, "(func $render_obj ", "(func $render_obj_im2 ", 1);
  ob = must(ob, "(local.set $name (i32.and (local.get $attr) (i32.const 0x7FF)))", "(local.set $name (i32.and (local.get $attr) (i32.const 0x3FF)))", 1);
  ob = must(ob, "(i32.shr_u (i32.and (local.get $vline) (i32.const 0x18)) (i32.const 1))", "(i32.shr_u (i32.and (local.get $vline) (i32.const 0x30)) (i32.const 2))", 1);
  ob = must(ob, "(local.set $vline (i32.and (local.get $vline) (i32.const 7)))", "(local.set $vline (i32.and (local.get $vline) (i32.const 15)))", 1);
  ob = must(ob, `(local.set $tmp (i32.or (local.get $attr)
              (i32.and (i32.add (local.get $name) (i32.load8_u (i32.add (local.get $s) (local.get $col)))) (i32.const 0x7FF))))`,
    `(local.set $tmp (i32.or (local.get $attr) (i32.or
              (i32.shl (i32.and (i32.add (local.get $name) (i32.load8_u (i32.add (local.get $s) (local.get $col)))) (i32.const 0x3FF)) (i32.const 1))
              (i32.xor (i32.shr_u (local.get $vline) (i32.const 3)) (i32.shr_u (i32.and (local.get $attr) (i32.const 0x1000)) (i32.const 12))))))`, 1);
  ob = must(ob, "(local.set $row (local.get $vline))", "(local.set $row (i32.and (local.get $vline) (i32.const 7)))", 1);
  return `
  ;; ---- interlace mode 2 (see im2Wat) ----
  (func $parse_satb_any (param $line i32)
    (if (i32.eqz (i32.and ${R(1)} (i32.const 4))) (then (call $parse_satb_m4 (local.get $line)) (return)))
    (if (global.get $v_im2) (then (call $parse_satb_im2 (local.get $line))) (else (call $parse_satb (local.get $line)))))
  (func $draw_col_im2 (param $dst i32) (param $at i32) (param $vline i32)
    (call $draw_tile_im2 (local.get $dst) (i32.and (local.get $at) (i32.const 0xFFFF)) (local.get $vline))
    (call $draw_tile_im2 (i32.add (local.get $dst) (i32.const 8)) (i32.shr_u (local.get $at) (i32.const 16)) (local.get $vline)))
  (func $draw_tile_im2 (param $dst i32) (param $attr i32) (param $vline i32)
    (call $draw_tile (local.get $dst)
      (i32.or (i32.and (local.get $attr) (i32.const 0xF800))
        (i32.or (i32.shl (i32.and (local.get $attr) (i32.const 0x3FF)) (i32.const 1))
                (i32.xor (i32.shr_u (local.get $vline) (i32.const 6)) (i32.shr_u (i32.and (local.get $attr) (i32.const 0x1000)) (i32.const 12)))))
      (i32.and (local.get $vline) (i32.const 0x3F))))
  ${bg}
  ${ps}
  ${ob}
`;
}

// Z80 sound CPU runtime (memz80.c, genesis.c bus arbitration, z80.c run loop)
// and the YM2612 status side (sound.c busy flag, ym2612.c timers).
// The returned text still holds {romimg}/{rmask}/{ztbase}; the emitter fills them.
export function z80Wat(layout, ccTables, hw = null) {
  // rom_database register banks through the Z80's bank window (zbank_memory_map)
  const zin = (b) => `(i32.and (i32.ge_u ${b} (i32.const ${hw ? hw.bankStart : 0})) (i32.le_u ${b} (i32.const ${hw ? hw.bankEnd : 0})))`;
  const Z = layout.ZREGS;
  const PC = Z + 0, SP = Z + 4, AF = Z + 8, WZ = Z + 32;
  const R_ = Z + 52, IFF1 = Z + 54, IFF2 = Z + 55, HALT = Z + 56, IM = Z + 57, I_ = Z + 58;
  const IRQ = Z + 61, AFTER_EI = Z + 62, CYC = Z + 64;
  const cc = layout.cc;
  const IMCOST1 = ccTables.cc_op[0xff] + ccTables.cc_ex[0xff];
  const IMCOST2 = ccTables.cc_op[0xcd] + ccTables.cc_ex[0xff];
  return `
  (global $zEA (mut i32) (i32.const 0))
  (global $z80_last_fetch (mut i32) (i32.const 0))
  (global $zbank (mut i32) (i32.const 0))
  (global $zmap (mut i32) (i32.const 0))
  (global $fm_count (mut i32) (i32.const 0))
  (global $ym_addr (mut i32) (i32.const 0))
  (global $ym_ta (mut i32) (i32.const 0)) (global $ym_tal (mut i32) (i32.const 1024))
  (global $ym_tac (mut i32) (i32.const 0)) (global $ym_tb (mut i32) (i32.const 0))
  (global $ym_tbl (mut i32) (i32.const 4096)) (global $ym_tbc (mut i32) (i32.const 0))
  (global $ym_mode (mut i32) (i32.const 0x30))
  (global $nz80bad (mut i32) (i32.const 0))
  (global $nz80bank (mut i32) (i32.const 0))

  ;; ---- YM2612: busy flag + timers (the parts either CPU can observe) ----
  (func $fm_update (param $cycles i32)
    (local $n i32) (local $i i32)
    (if (i32.gt_s (local.get $cycles) (global.get $fm_count))
      (then
        (local.set $n (i32.div_s (i32.add (i32.sub (local.get $cycles) (global.get $fm_count)) (i32.const 1007)) (i32.const 1008)))
        (local.set $i (i32.const 0))
        (block $d (loop $l
          (br_if $d (i32.ge_s (local.get $i) (local.get $n)))
          ;; INTERNAL_TIMER_A, once per sample
          (if (i32.and (global.get $ym_mode) (i32.const 1))
            (then (global.set $ym_tac (i32.sub (global.get $ym_tac) (i32.const 1)))
                  (if (i32.le_s (global.get $ym_tac) (i32.const 0))
                    (then (if (i32.and (global.get $ym_mode) (i32.const 4))
                            (then (global.set $ym_status (i32.or (global.get $ym_status) (i32.const 1)))))
                          (global.set $ym_tac (global.get $ym_tal))))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
        ;; INTERNAL_TIMER_B(length)
        (if (i32.and (global.get $ym_mode) (i32.const 2))
          (then (global.set $ym_tbc (i32.sub (global.get $ym_tbc) (local.get $n)))
                (if (i32.le_s (global.get $ym_tbc) (i32.const 0))
                  (then (if (i32.and (global.get $ym_mode) (i32.const 8))
                          (then (global.set $ym_status (i32.or (global.get $ym_status) (i32.const 2)))))
                        (block $d2 (loop $l2
                          (global.set $ym_tbc (i32.add (global.get $ym_tbc) (global.get $ym_tbl)))
                          (br_if $l2 (i32.le_s (global.get $ym_tbc) (i32.const 0)))))))))
        (global.set $fm_count (i32.add (global.get $fm_count) (i32.mul (local.get $n) (i32.const 1008)))))))

  (func $ym_set_timers (param $v i32)
    (if (i32.and (i32.and (local.get $v) (i32.const 1)) (i32.eqz (i32.and (global.get $ym_mode) (i32.const 1))))
      (then (global.set $ym_tac (global.get $ym_tal))))
    (if (i32.and (i32.ne (i32.and (local.get $v) (i32.const 2)) (i32.const 0)) (i32.eqz (i32.and (global.get $ym_mode) (i32.const 2))))
      (then (global.set $ym_tbc (global.get $ym_tbl))))
    (global.set $ym_status (i32.and (global.get $ym_status) (i32.shr_u (i32.xor (local.get $v) (i32.const -1)) (i32.const 4))))
    (global.set $ym_mode (local.get $v)))

  (func $fm_write (param $cycles i32) (param $a i32) (param $v i32)
    (local $r i32)
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.and (local.get $a) (i32.const 1))
      (then (call $fm_update (local.get $cycles))
            (global.set $fm_busy (i32.mul (i32.add (i32.div_u (i32.add (local.get $cycles) (i32.const 41)) (i32.const 42))
                                                   (i32.const 32)) (i32.const 42)))))
    (if (i32.eqz (local.get $a)) (then (global.set $ym_addr (local.get $v)) (return)))
    (if (i32.eq (local.get $a) (i32.const 2)) (then (global.set $ym_addr (i32.or (local.get $v) (i32.const 0x100))) (return)))
    (local.set $r (global.get $ym_addr))
    (if (i32.eq (local.get $r) (i32.const 0x24))
      (then (global.set $ym_ta (i32.or (i32.and (global.get $ym_ta) (i32.const 3)) (i32.shl (local.get $v) (i32.const 2))))
            (global.set $ym_tal (i32.sub (i32.const 1024) (global.get $ym_ta))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x25))
      (then (global.set $ym_ta (i32.or (i32.and (global.get $ym_ta) (i32.const 0x3FC)) (i32.and (local.get $v) (i32.const 3))))
            (global.set $ym_tal (i32.sub (i32.const 1024) (global.get $ym_ta))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x26))
      (then (global.set $ym_tb (local.get $v))
            (global.set $ym_tbl (i32.shl (i32.sub (i32.const 256) (local.get $v)) (i32.const 4))) (return)))
    (if (i32.eq (local.get $r) (i32.const 0x27)) (then (call $ym_set_timers (local.get $v)))))

  (func $fm_read (param $cycles i32) (param $a i32) (result i32)
    (if (i32.and (local.get $a) (i32.const 3)) (then (return (i32.const 0))))
    (call $fm_update (local.get $cycles))
    (if (i32.ge_u (local.get $cycles) (global.get $fm_busy)) (then (return (global.get $ym_status))))
    (i32.or (global.get $ym_status) (i32.const 0x80)))

  (func $fm_reset (param $cycles i32)
    (call $fm_update (local.get $cycles))
    (global.set $ym_tac (i32.const 0)) (global.set $ym_tbc (i32.const 0))
    (call $ym_set_timers (i32.const 0x30))
    (global.set $ym_tb (i32.const 0)) (global.set $ym_tbl (i32.const 4096))
    (global.set $ym_ta (i32.const 0)) (global.set $ym_tal (i32.const 1024))
    (global.set $fm_busy (i32.const 0)))

  ;; ---- Z80 memory (memz80.c) ----------------------------------------------
  (func $z80_rop (result i32)
    (local $pc i32)
    (local.set $pc (i32.load (i32.const ${PC})))
    (i32.store16 (i32.const ${PC}) (i32.add (local.get $pc) (i32.const 1)))
    (global.set $z80_last_fetch (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (local.get $pc) (i32.const 0x1FFF)))))
    (global.get $z80_last_fetch))
  (func $z80_arg (result i32)
    (local $pc i32)
    (local.set $pc (i32.load (i32.const ${PC})))
    (i32.store16 (i32.const ${PC}) (i32.add (local.get $pc) (i32.const 1)))
    (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (local.get $pc) (i32.const 0x1FFF)))))
  (func $z80_arg16 (result i32)
    (local $pc i32)
    (local.set $pc (i32.load (i32.const ${PC})))
    (i32.store16 (i32.const ${PC}) (i32.add (local.get $pc) (i32.const 2)))
    (i32.or (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (local.get $pc) (i32.const 0x1FFF))))
            (i32.shl (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (i32.add (local.get $pc) (i32.const 1)) (i32.const 0x1FFF))))
                     (i32.const 8))))

  ;; z80_request_68k_bus_access: the 68000 pays for every Z80 bus access
  (func $z80_bus_access
    (if (i32.and (i32.lt_u (i32.load (i32.const ${CYC})) (global.get $v_dma_end))
                 (i32.lt_u (global.get $v_dma_type) (i32.const 2)))
      (then (i32.store (i32.const ${CYC}) (global.get $v_dma_end))
            (if (global.get $v_dma_length) (then (global.set $zstate (i32.or (global.get $zstate) (i32.const 4)))))))
    (global.set $mc (i32.add (global.get $mc)
      (i32.mul (i32.div_u (i32.add (i32.rem_u (i32.load (i32.const ${CYC})) (i32.const 7)) (i32.const 72)) (i32.const 7)) (i32.const 7))))
    (i32.store (i32.const ${CYC}) (i32.add (i32.load (i32.const ${CYC})) (i32.const 45)))
    (global.set $nz80bank (i32.add (global.get $nz80bank) (i32.const 1))))

  ;; zbank_lockup_r/w: a Z80 access the 68000 bus never acknowledges stops
  ;; the Z80 for good (no config.force_dtack)
  (func $zbank_lockup
    (global.set $nz80bad (i32.add (global.get $nz80bad) (i32.const 1)))
    (i32.store (i32.const ${CYC}) (i32.const -1))
    (global.set $zstate (i32.const 0)))

  ;; zbank_read_vdp / zbank_write_vdp: the VDP seen from the Z80 (its $7Fxx
  ;; window or the 68000 bank), byte-wide, timed on the Z80 clock
  (func $zbank_read_vdp (param $a i32) (result i32)
    (local $o i32)
    (local.set $o (i32.and (local.get $a) (i32.const 0xFD)))
    (if (i32.eqz (local.get $o)) (then (return (i32.shr_u (call $vdp_data_r) (i32.const 8)))))
    (if (i32.eq (local.get $o) (i32.const 0x01)) (then (return (i32.and (call $vdp_data_r) (i32.const 0xFF)))))
    (if (i32.eq (local.get $o) (i32.const 0x04))
      (then (return (i32.or (i32.and (i32.shr_u (call $vdp_ctrl_r (i32.load (i32.const ${CYC}))) (i32.const 8)) (i32.const 3)) (i32.const 0xFC)))))
    (if (i32.eq (local.get $o) (i32.const 0x05)) (then (return (i32.and (call $vdp_ctrl_r (i32.load (i32.const ${CYC}))) (i32.const 0xFF)))))
    (if (i32.or (i32.eq (local.get $o) (i32.const 0x08)) (i32.eq (local.get $o) (i32.const 0x0C)))
      (then (return (i32.and (i32.shr_u (call $vdp_hvc_r (i32.load (i32.const ${CYC}))) (i32.const 8)) (i32.const 0xFF)))))
    (if (i32.or (i32.eq (local.get $o) (i32.const 0x09)) (i32.eq (local.get $o) (i32.const 0x0D)))
      (then (return (i32.and (call $vdp_hvc_r (i32.load (i32.const ${CYC}))) (i32.const 0xFF)))))
    (if (i32.or (i32.eq (local.get $o) (i32.const 0x18)) (i32.eq (local.get $o) (i32.const 0x1C))) (then (return (i32.const 0xFF))))
    (call $zbank_lockup)
    (i32.const 0xFF))
  (func $zbank_write_vdp (param $a i32) (param $v i32)
    (local $o i32)
    (local.set $o (i32.and (local.get $a) (i32.const 0xFC)))
    (if (i32.eqz (local.get $o)) (then (call $vdp_data_w (i32.mul (local.get $v) (i32.const 0x101))) (return)))
    (if (i32.eq (local.get $o) (i32.const 0x04)) (then (call $vdp_ctrl_w (i32.mul (local.get $v) (i32.const 0x101))) (return)))
    ;; $10/$14 PSG (audio is not produced), $18 unused, $1C the VDP test register
    (if (i32.or (i32.or (i32.eq (local.get $o) (i32.const 0x10)) (i32.eq (local.get $o) (i32.const 0x14)))
                (i32.or (i32.eq (local.get $o) (i32.const 0x18)) (i32.eq (local.get $o) (i32.const 0x1C)))) (then (return)))
    (call $zbank_lockup))

  ;; zbank_read_ctrl_io / zbank_write_ctrl_io: the I/O area ($A1xxxx) via the bank
  (func $zbank_read_ctrl_io (param $a i32) (result i32)
    (local $s i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))
    (if (i32.eqz (local.get $s))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 0xE0)))
              (then (return (call $io_68k_read (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0x0F))))))
            (return (i32.const 0xFF))))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x11)) (i32.eq (local.get $s) (i32.const 0x30)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x41)) (i32.eq (local.get $s) (i32.const 0x10)))
                        (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x12)) (i32.eq (local.get $s) (i32.const 0x20)))
                                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x40)) (i32.eq (local.get $s) (i32.const 0x44)))
                                        (i32.eq (local.get $s) (i32.const 0x50))))))
      (then (return (i32.const 0xFF))))
    (call $zbank_lockup)
    (i32.const 0xFF))
  (func $zbank_write_ctrl_io (param $a i32) (param $v i32)
    (local $s i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)))
    (if (i32.eqz (local.get $s))
      (then (if (i32.eq (i32.and (local.get $a) (i32.const 0xE1)) (i32.const 1))
              (then (call $io_68k_write (i32.and (i32.shr_u (local.get $a) (i32.const 1)) (i32.const 0x0F)) (local.get $v))))
            (return)))
    (if (i32.eq (local.get $s) (i32.const 0x11))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 1))) (then (call $zbusreq_w (i32.and (local.get $v) (i32.const 1))))) (return)))
    (if (i32.eq (local.get $s) (i32.const 0x12))
      (then (if (i32.eqz (i32.and (local.get $a) (i32.const 1))) (then (call $zreset_w (i32.and (local.get $v) (i32.const 1))))) (return)))
    (if (i32.eq (local.get $s) (i32.const 0x30)) (then (call $time_w (local.get $a) (local.get $v)) (return)))
    (if (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x41)) (i32.eq (local.get $s) (i32.const 0x10)))
                (i32.or (i32.or (i32.eq (local.get $s) (i32.const 0x20)) (i32.eq (local.get $s) (i32.const 0x40)))
                        (i32.or (i32.eq (local.get $s) (i32.const 0x44)) (i32.eq (local.get $s) (i32.const 0x50)))))
      (then (return)))
    (call $zbank_lockup))

  (func $z80_rm (param $a i32) (result i32)
    (local $s i32) (local $x i32) (local $b i32)
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 7)))
    (if (i32.lt_u (local.get $s) (i32.const 2))
      (then (return (i32.load8_u (i32.add (i32.const ${ZRAM}) (i32.and (local.get $a) (i32.const 0x1FFF)))))))
    (if (i32.eq (local.get $s) (i32.const 2))
      (then (return (call $fm_read (i32.load (i32.const ${CYC})) (i32.and (local.get $a) (i32.const 3))))))
    (if (i32.eq (local.get $s) (i32.const 3))
      (then (if (i32.eq (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0x7F))
              (then (call $z80_bus_access)
                    (return (call $zbank_read_vdp (local.get $a)))))
            (return (i32.const 0xFF))))
    (call $z80_bus_access)
    (local.set $x (i32.or (global.get $zbank) (i32.and (local.get $a) (i32.const 0x7FFF))))
    (local.set $b (i32.shr_u (local.get $x) (i32.const 16)))
    (if (i32.lt_u (local.get $b) (i32.const 0x40)) (then (return (call $cart_rd8 (local.get $x)))))
    ;; $400000-$7FFFFF unused; $E00000+ work RAM (the Z80 can only WRITE it)${hw && hw.regsR ? `
    (if ${zin("(local.get $b)")} (then (return (i32.and (call $regs_r (local.get $x)) (i32.const 0xFF)))))` : ""}
    (if (i32.or (i32.lt_u (local.get $b) (i32.const 0x80)) (i32.ge_u (local.get $b) (i32.const 0xE0))) (then (return (i32.const 0xFF))))
    (if (i32.eqz (i32.and (local.get $b) (i32.const 7)))
      (then (if (i32.ge_u (local.get $b) (i32.const 0xC0)) (then (return (call $zbank_read_vdp (local.get $x)))))))
    (if (i32.eq (local.get $b) (i32.const 0xA1)) (then (return (call $zbank_read_ctrl_io (local.get $x)))))
    (call $zbank_lockup)
    (i32.const 0xFF))

  (func $z80_wm (param $a i32) (param $v i32)
    (local $s i32) (local $x i32)
    (local.set $v (i32.and (local.get $v) (i32.const 0xFF)))
    (local.set $s (i32.and (i32.shr_u (local.get $a) (i32.const 13)) (i32.const 7)))
    (if (i32.lt_u (local.get $s) (i32.const 2))
      (then (i32.store8 (i32.add (i32.const ${ZRAM}) (i32.and (local.get $a) (i32.const 0x1FFF))) (local.get $v)) (return)))
    (if (i32.eq (local.get $s) (i32.const 2))
      (then (call $fm_write (i32.load (i32.const ${CYC})) (i32.and (local.get $a) (i32.const 3)) (local.get $v)) (return)))
    (if (i32.eq (local.get $s) (i32.const 3))
      (then (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)) (i32.const 0x60))
              (then (global.set $zbank (i32.and (i32.or (i32.shr_u (global.get $zbank) (i32.const 1))
                                                        (i32.shl (i32.and (local.get $v) (i32.const 1)) (i32.const 23)))
                                                (i32.const 0xFF8000)))
                    (return)))
            (if (i32.eq (i32.and (i32.shr_u (local.get $a) (i32.const 8)) (i32.const 0xFF)) (i32.const 0x7F))
              (then (call $z80_bus_access)
                    (call $zbank_write_vdp (local.get $a) (local.get $v))))
            (return)))
    (call $z80_bus_access)
    (local.set $x (i32.or (global.get $zbank) (i32.and (local.get $a) (i32.const 0x7FFF))))
    (if (i32.ge_u (local.get $x) (i32.const 0xE00000))
      (then (i32.store8 (i32.and (local.get $x) (i32.const 0xFFFF)) (local.get $v)) (return)))
    (if (i32.lt_u (local.get $x) (i32.const 0x400000)) (then (call $cart_wr8 (local.get $x) (local.get $v)) (return)))${hw && hw.regsW ? `
    (if ${zin("(i32.shr_u (local.get $x) (i32.const 16))")} (then (call $regs_w (local.get $x) (local.get $v)) (return)))` : ""}
    (if (i32.lt_u (local.get $x) (i32.const 0x800000)) (then (return)))
    (if (i32.eqz (i32.and (i32.shr_u (local.get $x) (i32.const 16)) (i32.const 7)))
      (then (if (i32.ge_u (local.get $x) (i32.const 0xC00000)) (then (call $zbank_write_vdp (local.get $x) (local.get $v)) (return)))))
    (if (i32.eq (i32.shr_u (local.get $x) (i32.const 16)) (i32.const 0xA1)) (then (call $zbank_write_ctrl_io (local.get $x) (local.get $v)) (return)))
    (call $zbank_lockup))

  (func $z80_port_r (param $p i32) (result i32) (i32.const 0xFF))
  (func $z80_port_w (param $p i32) (param $v i32))

  (func $z80_reset
    (i32.store (i32.const ${PC}) (i32.and (i32.load (i32.const ${PC})) (i32.const 0xFFFF0000)))
    (i32.store8 (i32.const ${I_}) (i32.const 0))
    (i32.store8 (i32.const ${R_}) (i32.const 0)) (i32.store8 (i32.const ${R_ + 1}) (i32.const 0))
    (i32.store8 (i32.const ${IM}) (i32.const 0))
    (i32.store8 (i32.const ${IFF1}) (i32.const 0)) (i32.store8 (i32.const ${IFF2}) (i32.const 0))
    (i32.store8 (i32.const ${HALT}) (i32.const 0))
    (i32.store8 (i32.const ${AFTER_EI}) (i32.const 0))
    (i32.store16 (i32.const ${WZ}) (i32.load (i32.const ${PC}))))

  (func $z80_init
    (memory.fill (i32.const ${Z}) (i32.const 0) (i32.const 72))
    (i32.store8 (i32.const ${AF}) (i32.const 0x40)))

  (func $z80_push_pc
    (local $sp i32)
    (local.set $sp (i32.and (i32.sub (i32.load16_u (i32.const ${SP})) (i32.const 2)) (i32.const 0xFFFF)))
    (i32.store16 (i32.const ${SP}) (local.get $sp))
    (call $z80_wm (i32.load (i32.const ${SP})) (i32.load8_u (i32.const ${PC})))
    (call $z80_wm (i32.and (i32.add (i32.load (i32.const ${SP})) (i32.const 1)) (i32.const 0xFFFF)) (i32.load8_u (i32.const ${PC + 1}))))

  ;; take_interrupt (irq_callback returns -1 on the Genesis)
  (func $z80_take_int
    (local $v i32)
    (if (i32.load8_u (i32.const ${HALT}))
      (then (i32.store8 (i32.const ${HALT}) (i32.const 0))
            (i32.store16 (i32.const ${PC}) (i32.add (i32.load16_u (i32.const ${PC})) (i32.const 1)))))
    (i32.store8 (i32.const ${IFF1}) (i32.const 0)) (i32.store8 (i32.const ${IFF2}) (i32.const 0))
    (if (i32.eq (i32.load8_u (i32.const ${IM})) (i32.const 1))
      (then (call $z80_push_pc)
            (i32.store (i32.const ${PC}) (i32.const 0x38))
            (i32.store (i32.const ${CYC}) (i32.add (i32.load (i32.const ${CYC})) (i32.const ${IMCOST1}))))
      (else
        (if (i32.eq (i32.load8_u (i32.const ${IM})) (i32.const 2))
          (then
            (local.set $v (i32.or (i32.const 0xFF) (i32.shl (i32.load8_u (i32.const ${I_})) (i32.const 8))))
            (call $z80_push_pc)
            (i32.store8 (i32.const ${PC}) (call $z80_rm (local.get $v)))
            (i32.store8 (i32.const ${PC + 1}) (call $z80_rm (i32.and (i32.add (local.get $v) (i32.const 1)) (i32.const 0xFFFF))))
            (i32.store (i32.const ${CYC}) (i32.add (i32.load (i32.const ${CYC})) (i32.const ${IMCOST2}))))
          (else
            (call $z80_push_pc)
            (i32.store (i32.const ${PC}) (i32.const 0x38))
            (i32.store (i32.const ${CYC}) (i32.add (i32.load (i32.const ${CYC})) (i32.const ${IMCOST1})))))))
    (i32.store16 (i32.const ${WZ}) (i32.load (i32.const ${PC}))))

  (func $z80_run (param $cycles i32)
    (local $op i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (i32.load (i32.const ${CYC})) (local.get $cycles)))
      (if (i32.and (i32.and (i32.load8_u (i32.const ${IRQ})) (i32.load8_u (i32.const ${IFF1})))
                   (i32.eqz (i32.load8_u (i32.const ${AFTER_EI}))))
        (then (call $z80_take_int)
              (br_if $d (i32.ge_u (i32.load (i32.const ${CYC})) (local.get $cycles)))))
      (i32.store8 (i32.const ${AFTER_EI}) (i32.const 0))
      (i32.store8 (i32.const ${R_}) (i32.add (i32.load8_u (i32.const ${R_})) (i32.const 1)))
      (local.set $op (call $z80_rop))
      (i32.store (i32.const ${CYC}) (i32.add (i32.load (i32.const ${CYC}))
        (i32.load16_u (i32.add (i32.const ${cc.cc_op}) (i32.shl (local.get $op) (i32.const 1))))))
      (call_indirect (type $voidT) (i32.add (i32.const {ztbase}) (local.get $op)))
      (br $l))))
`;
}

/**
 * The cartridge area $000000-$3FFFFF as md_cart.c maps it: 64 banks of 64KB
 * (CARTMAP: a ROM offset, the mirror by default, or -1 / -2 = backup RAM
 * read-write / write-protected), backup RAM from sram_init, and the !TIME
 * writes ($A130xx) of default_time_w: below $A13060 the multi-game 64KB
 * mapper, $A130F2-$A130FF the 512KB bank registers (mapper_512k_w), the rest
 * the SRAM switch (mapper_sega_w: bit 0 maps backup RAM at $200000, bit 1
 * write-protects it). `ssf2` = mapper_ssf2_w (bank 0 fixed).
 * @param {number} romimg
 * @param {number} romsize power of two
 * @param {{sramOn:boolean, ssf2?:boolean}} o
 */
export function cartWat(romimg, romsize, o) {
  const rmask = romsize - 1;
  const m32 = !!(o.hw && o.hw.regsW === "custom_regs_w");
  const rt = !!(o.hw && o.hw.realtec);
  const romAt = (e) => `(if (result i32) (i32.lt_u ${e} (i32.const ${romsize})) (then (i32.load8_u (i32.add (i32.const ${romimg}) ${e}))) (else (i32.const 0xFF)))`;
  return `
  (global $sramreg0 (mut i32) (i32.const 0))
  (global $remapped (mut i32) (i32.const 0))
  (func $cartmap (param $a i32) (result i32)
    (i32.load (i32.add (i32.const ${CARTMAP}) (i32.shl (i32.and (i32.shr_u (local.get $a) (i32.const 16)) (i32.const 0x3F)) (i32.const 2)))))
${o.eeprom ? eepromWat(o.eeprom) : ""}  (func ${o.eeprom ? "$cart_b8" : "$cart_rd8"} (param $a i32) (result i32)
    (local $e i32) (local $o i32)
    (local.set $e (call $cartmap (local.get $a)))${o.svp ? `
    ;; svp_init: DRAM ($30-$31) and the cell arrange windows ($39-$3A)
    (if (i32.le_s (local.get $e) (i32.const -8)) (then (return (call $svp_rd8 (local.get $a)))))` : ""}${m32 ? `
    (if (i32.eq (local.get $e) (i32.const -3)) (then (return ${romAt("(call $m32k_off (local.get $a))")})))` : ""}${rt ? `
    (if (i32.eq (local.get $e) (i32.const -4)) (then (return ${romAt("(i32.or (i32.const 0x7E000) (i32.and (local.get $a) (i32.const 0x1FFF)))")})))` : ""}
    (if (i32.lt_s (local.get $e) (i32.const 0))
      (then (return (i32.load8_u (i32.add (i32.const ${SRAMBUF}) (i32.and (local.get $a) (i32.const 0xFFFF)))))))
    (local.set $o (i32.add (local.get $e) (i32.and (local.get $a) (i32.const 0xFFFF))))
    ${romAt("(local.get $o)")})
  (func ${o.eeprom ? "$cart_b16" : "$cart_rd16"} (param $a i32) (result i32)
    (local $e i32) (local $o i32)
    (local.set $e (call $cartmap (local.get $a)))${o.svp ? `
    (if (i32.le_s (local.get $e) (i32.const -8)) (then (return (call $svp_rd16 (local.get $a)))))` : ""}${m32 ? `
    (if (i32.eq (local.get $e) (i32.const -3))
      (then (local.set $o (call $m32k_off (i32.and (local.get $a) (i32.const -2))))
            (return (i32.or (i32.shl ${romAt("(local.get $o)")} (i32.const 8)) ${romAt("(i32.add (local.get $o) (i32.const 1))")}))))` : ""}${rt ? `
    ;; Realtec: the 8KB boot ROM ($7E000) in every bank until ROM access is enabled
    (if (i32.eq (local.get $e) (i32.const -4))
      (then (local.set $o (i32.or (i32.const 0x7E000) (i32.and (local.get $a) (i32.const 0x1FFE))))
            (return (i32.or (i32.shl ${romAt("(local.get $o)")} (i32.const 8)) ${romAt("(i32.add (local.get $o) (i32.const 1))")}))))` : ""}
    (if (i32.lt_s (local.get $e) (i32.const 0))
      (then (local.set $o (i32.add (i32.const ${SRAMBUF}) (i32.and (local.get $a) (i32.const 0xFFFE))))
            (return (i32.or (i32.shl (i32.load8_u (local.get $o)) (i32.const 8)) (i32.load8_u offset=1 (local.get $o))))))
    (local.set $o (i32.add (local.get $e) (i32.and (local.get $a) (i32.const 0xFFFE))))
    (i32.or (i32.shl ${romAt("(local.get $o)")} (i32.const 8))
            ${romAt("(i32.add (local.get $o) (i32.const 1))")}))
  (func ${o.eeprom ? "$cart_wb8" : "$cart_wr8"} (param $a i32) (param $v i32)${o.svp ? `
    ;; DRAM takes writes; the cell arrange windows keep the ROM banks' m68k_unused_w
    (if (i32.eq (call $cartmap (local.get $a)) (i32.const -8)) (then (call $svp_wr8 (local.get $a) (local.get $v)) (return)))` : ""}
    (if (i32.eq (call $cartmap (local.get $a)) (i32.const -1))
      (then (i32.store8 (i32.add (i32.const ${SRAMBUF}) (i32.and (local.get $a) (i32.const 0xFFFF))) (local.get $v)))))
  (func ${o.eeprom ? "$cart_wb16" : "$cart_wr16"} (param $a i32) (param $v i32)
    (local $o i32)${o.svp ? `
    (if (i32.eq (call $cartmap (local.get $a)) (i32.const -8)) (then (call $svp_wr16 (local.get $a) (local.get $v)) (return)))` : ""}
    (if (i32.eq (call $cartmap (local.get $a)) (i32.const -1))
      (then (local.set $o (i32.add (i32.const ${SRAMBUF}) (i32.and (local.get $a) (i32.const 0xFFFE))))
            (i32.store8 (local.get $o) (i32.shr_u (local.get $v) (i32.const 8)))
            (i32.store8 offset=1 (local.get $o) (local.get $v)))))

  ;; a bank that no longer holds its own mirror means code there is not the
  ;; code the ROM arms were compiled for ($step looks for the arms compiled
  ;; for what the reference ran there)
  (func $cart_setbank (param $i i32) (param $e i32)
    (i32.store (i32.add (i32.const ${CARTMAP}) (i32.shl (local.get $i) (i32.const 2))) (local.get $e))
    (if (i32.and (i32.ge_s (local.get $e) (i32.const 0))
                 (i32.ne (local.get $e) (i32.and (i32.shl (local.get $i) (i32.const 16)) (i32.const ${rmask}))))
      (then (global.set $remapped (i32.const 1)))))

  ;; mapper_sega_w
  (func $mapper_sega_w (param $d i32)
${o.sramOn ? `    (if (i32.and (local.get $d) (i32.const 1))
      (then
        (if (i32.ge_s (call $cartmap (i32.const 0x200000)) (i32.const 0))
          (then (global.set $sramreg0 (i32.and (i32.shr_u (call $cartmap (i32.const 0x200000)) (i32.const 16)) (i32.const 0xFF)))))
        (i32.store (i32.const ${CARTMAP + 0x20 * 4}) (select (i32.const -2) (i32.const -1) (i32.and (local.get $d) (i32.const 2))))
        (global.set $remapped (i32.const 1))${o.eeprom ? `
        (i32.store8 (i32.const ${CARTR + 0x20}) (i32.const 0)) (i32.store8 (i32.const ${CARTW + 0x20}) (i32.const 0))` : ""})
      (else
        (if (i32.lt_s (call $cartmap (i32.const 0x200000)) (i32.const 0))
          (then (call $cart_setbank (i32.const 0x20) (i32.shl (global.get $sramreg0) (i32.const 16)))${o.eeprom ? `
                (i32.store8 (i32.const ${CARTR + 0x20}) (i32.const 0)) (i32.store8 (i32.const ${CARTW + 0x20}) (i32.const 0))` : ""}))))` : "    (drop (local.get $d))"})

  ;; mapper_512k_w: eight 512KB windows over $000000-$3FFFFF
  (func $mapper_512k_w (param $a i32) (param $d i32)
    (local $src i32) (local $slot i32) (local $i i32)
    (local.set $src (i32.and (i32.shl (local.get $d) (i32.const 19)) (i32.const ${rmask})))
    (local.set $slot (i32.and (i32.shl (local.get $a) (i32.const 2)) (i32.const 0x38)))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 8)))
      (call $cart_setbank (i32.add (local.get $slot) (local.get $i)) (i32.add (local.get $src) (i32.shl (local.get $i) (i32.const 16))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  ;; mapper_64k_multi_w: all 64 banks re-based by the written address
  (func $mapper_64k_multi_w (param $a i32)
    (local $i i32)
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 64)))
      (call $cart_setbank (local.get $i) (i32.shl (i32.and (i32.add (local.get $a) (local.get $i)) (i32.const 0x3F)) (i32.const 16)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

${o.hw ? cartHwWat(o.hw, romsize) : ""}
  ;; cart.hw.time_w: default_time_w (or mapper_ssf2_w, or a rom_database entry's)
  (func $time_w (param $a i32) (param $d i32)
${o.hw && !o.ssf2 ? (o.hw.timeW === "default_regs_w" ? "    (call $default_regs_w (local.get $a) (local.get $d))" : "    (drop (local.get $a)) (drop (local.get $d))") : o.ssf2 ? `    (if (i32.and (local.get $a) (i32.const 0x0E)) (then (call $mapper_512k_w (local.get $a) (local.get $d))))` : `    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (if (i32.lt_u (local.get $a) (i32.const 0xA13060)) (then (call $mapper_64k_multi_w (local.get $a)) (return)))
    (if (i32.gt_u (local.get $a) (i32.const 0xA130F1)) (then (call $mapper_512k_w (local.get $a) (local.get $d)) (return)))
    (call $mapper_sega_w (local.get $d))`})
`;
}

/**
 * md_cart.c rom_database hardware: the 4 registers with their address
 * masks, the register handlers (default_regs_r(_16)/w, custom_regs_r/w with
 * its bit-swapping and mapper_32k_w, custom_alt_regs_w with mapper_64k_w)
 * and the Realtec mapper. `hw` is index.js cartHardware().
 * @param {{regs:number[], mask:number[], addr:number[], regsR:string|null, regsW:string|null, timeR:string|null, realtec:number}} hw
 * @param {number} romsize
 */
function cartHwWat(hw, romsize) {
  const rmask = romsize - 1;
  const match = (i) => `(i32.eq (i32.and (local.get $a) (i32.const ${hw.mask[i]})) (i32.const ${hw.addr[i]}))`;
  const each = (body) => [0, 1, 2, 3].map((i) => `
    (if ${match(i)} (then ${body(i)}))`).join("");
  return `
  (global $hwr0 (mut i32) (i32.const ${hw.regs[0]})) (global $hwr1 (mut i32) (i32.const ${hw.regs[1]}))
  (global $hwr2 (mut i32) (i32.const ${hw.regs[2]})) (global $hwr3 (mut i32) (i32.const ${hw.regs[3]}))
  (global $m32k (mut i32) (i32.const 0))
  ;; default_regs_r
  (func $default_regs_r (param $a i32) (result i32)${each((i) => `(return (global.get $hwr${i}))`)}
    (call $bus8 (local.get $a)))
  ;; default_regs_r_16
  (func $default_regs_r_16 (param $a i32) (result i32)${each((i) => `(return (i32.shl (global.get $hwr${i}) (i32.const 8)))`)}
    (call $bus16))
  ;; custom_regs_r
  (func $custom_regs_r (param $a i32) (result i32)${each((i) => `(return (i32.shr_u (global.get $hwr${i}) (i32.const 1)))`)}
    (call $bus8 (local.get $a)))
  ;; default_regs_w
  (func $default_regs_w (param $a i32) (param $d i32)${each((i) => `(global.set $hwr${i} (i32.and (local.get $d) (i32.const 0xFF))) (return)`)})
  ;; custom_regs_w: $700000+ is mapper_32k_w, below it a register write and the bit-swapped copy
  (func $custom_regs_w (param $a i32) (param $d i32)
    (local $t i32)
    (if (i32.gt_u (i32.shr_u (i32.and (local.get $a) (i32.const 0xFFFFFF)) (i32.const 16)) (i32.const 0x6F))
      (then (call $mapper_32k_w (local.get $d)) (return)))
    (call $default_regs_w (local.get $a) (local.get $d))
    (local.set $t (global.get $hwr0))
    (block $s (block $c3 (block $c2 (block $c1 (block $c0
      (br_table $c0 $c1 $c2 $c3 (i32.and (global.get $hwr1) (i32.const 3))))
      (global.set $hwr2 (i32.and (i32.shl (local.get $t) (i32.const 1)) (i32.const 0xFF))) (br $s))
      (global.set $hwr2 (i32.shr_u (local.get $t) (i32.const 1))) (br $s))
      (global.set $hwr2 (i32.and (i32.or (i32.shr_u (local.get $t) (i32.const 4)) (i32.shl (i32.and (local.get $t) (i32.const 0x0F)) (i32.const 4))) (i32.const 0xFF))) (br $s))
      ;; bit reversal
      (global.set $hwr2 (i32.and (i32.or (i32.or (i32.or (i32.and (i32.shr_u (local.get $t) (i32.const 7)) (i32.const 1)) (i32.and (i32.shr_u (local.get $t) (i32.const 5)) (i32.const 2)))
                                                (i32.or (i32.and (i32.shr_u (local.get $t) (i32.const 3)) (i32.const 4)) (i32.and (i32.shr_u (local.get $t) (i32.const 1)) (i32.const 8))))
                                         (i32.or (i32.or (i32.and (i32.shl (local.get $t) (i32.const 1)) (i32.const 0x10)) (i32.and (i32.shl (local.get $t) (i32.const 3)) (i32.const 0x20)))
                                                 (i32.or (i32.and (i32.shl (local.get $t) (i32.const 5)) (i32.const 0x40)) (i32.and (i32.shl (local.get $t) (i32.const 7)) (i32.const 0x80)))))
                                 (i32.const 0xFF)))))
  ;; custom_alt_regs_w: $600000+ is mapper_64k_w
  (func $custom_alt_regs_w (param $a i32) (param $d i32)
    (if (i32.gt_u (i32.shr_u (i32.and (local.get $a) (i32.const 0xFFFFFF)) (i32.const 16)) (i32.const 0x5F))
      (then (call $mapper_64k_w (local.get $d)) (return)))
    (call $default_regs_w (local.get $a) (local.get $d)))
  ;; mapper_64k_w: one 64KB bank in all of $000000-$0FFFFF, or the default map back
  (func $mapper_64k_w (param $d i32)
    (local $i i32)
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 16)))
      (call $cart_setbank (local.get $i) (i32.and (i32.shl (select (i32.and (local.get $d) (i32.const 0xF)) (local.get $i) (local.get $d)) (i32.const 16)) (i32.const ${rmask})))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))
  ;; mapper_32k_w: each 64KB bank of $000000-$0FFFFF gets two 32KB halves,
  ;; (bank << 16) | (data << 15) and | ((data | 1) << 15); data 0 = default map
  (func $mapper_32k_w (param $d i32)
    (local $i i32)
    (global.set $m32k (local.get $d))
    (if (local.get $d) (then (global.set $remapped (i32.const 1))))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $i) (i32.const 16)))
      (call $cart_setbank (local.get $i) (select (i32.const -3) (i32.and (i32.shl (local.get $i) (i32.const 16)) (i32.const ${rmask})) (global.get $m32k)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))
  (func $m32k_off (param $a i32) (result i32)
    (i32.or (i32.or (i32.and (local.get $a) (i32.const 0xF0000))
                    (i32.shl (i32.and (select (i32.or (global.get $m32k) (i32.const 1)) (global.get $m32k) (i32.and (local.get $a) (i32.const 0x8000))) (i32.const 0x3F)) (i32.const 15)))
            (i32.and (local.get $a) (i32.const 0x7FFF))))
  (func $regs_r (param $a i32) (result i32)
    ${hw.regsR ? `(call $${hw.regsR} (local.get $a))` : "(call $bus8 (local.get $a))"})
  (func $regs_w (param $a i32) (param $v i32)
    ${hw.regsW ? `(call $${hw.regsW} (local.get $a) (local.get $v))` : "(drop (local.get $a)) (drop (local.get $v))"})${hw.realtec ? realtecWat(rmask) : ""}
`;
}

/** mapper_realtec_w: ROM access enable locks the 64KB pages ($000000-$07FFFF mirrored over 4MB). */
function realtecWat(rmask) {
  return `
  (func $mapper_realtec_w (param $a i32) (param $d i32)
    (local $i i32) (local $b i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFF)))
    (if (i32.eq (local.get $a) (i32.const 0x402000)) (then (global.set $hwr1 (i32.shl (i32.and (local.get $d) (i32.const 3)) (i32.const 1))) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x404000)) (then (global.set $hwr2 (i32.shl (i32.and (local.get $d) (i32.const 3)) (i32.const 1))) (return)))
    (if (i32.eq (local.get $a) (i32.const 0x400000))
      (then (if (i32.and (i32.and (local.get $d) (i32.const 1)) (i32.eqz (global.get $hwr0)))
        (then
          (block $done (loop $l
            (br_if $done (i32.ge_u (local.get $i) (i32.const 0x40)))
            (local.set $b (i32.and (local.get $i) (i32.const 7)))
            (local.set $b (i32.or (i32.and (local.get $b) (i32.xor (global.get $hwr1) (i32.const -1))) (i32.and (global.get $hwr2) (global.get $hwr1))))
            (call $cart_setbank (local.get $i) (i32.and (i32.shl (local.get $b) (i32.const 16)) (i32.const ${rmask})))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $l)))
          (global.set $hwr0 (i32.and (local.get $d) (i32.const 0xFF))))))))`;
}

/**
 * Serial EEPROM boards (gpgx cart_hw/eeprom_i2c.c): the 24Cxx state machine
 * clocked by SCL/SDA writes, and the board wirings (EA, SEGA, Acclaim 16M
 * and 32M, Codemasters J-Cart) as per-bank read/write handlers (CARTR /
 * CARTW) in front of the memory_map base reads. The array is sram.sram.
 * @param {{mapper:string, addressBits:number, sizeMask:number, pagewriteMask:number, sclIn:number, sdaIn:number, sdaOut:number, eeprom:boolean, jcart:boolean, sixButton:boolean}} e
 */
export function eepromWat(e) {
  const G = (n) => `(global.get $e_${n})`;
  const S = (n, v) => `(global.set $e_${n} ${v})`;
  const c = (v) => `(i32.const ${v})`;
  const fall = `(i32.and (i32.ne ${G("oscl")} ${c(0)}) (i32.eqz ${G("scl")}))`;
  const rise = `(i32.and (i32.eqz ${G("oscl")}) (i32.ne ${G("scl")} ${c(0)}))`;
  const inc9 = (then) => `(if (i32.lt_u ${G("cyc")} ${c(9)}) (then ${S("cyc", `(i32.add ${G("cyc")} ${c(1)})`)}) (else ${S("cyc", c(1))} ${then}))`;
  const arr = `(i32.add ${c(SRAMBUF)} (i32.and (i32.or ${G("dev")} ${G("word")}) ${c(0xffff)}))`;
  const jpad = (k, f) => `${JPADS + k * 16 + f}`;
  return `
  (global $e_sda (mut i32) (i32.const 1)) (global $e_scl (mut i32) (i32.const 1))
  (global $e_osda (mut i32) (i32.const 1)) (global $e_oscl (mut i32) (i32.const 1))
  (global $e_cyc (mut i32) (i32.const 0)) (global $e_rw (mut i32) (i32.const 0))
  (global $e_dev (mut i32) (i32.const 0)) (global $e_word (mut i32) (i32.const 0))
  (global $e_buf (mut i32) (i32.const 0)) (global $e_state (mut i32) (i32.const 0))
  (func $eep_start
    (if (i32.and (i32.and (i32.ne ${G("oscl")} ${c(0)}) (i32.ne ${G("scl")} ${c(0)}))
                 (i32.and (i32.ne ${G("osda")} ${c(0)}) (i32.eqz ${G("sda")})))
      (then ${S("cyc", c(0))} ${e.addressBits === 7 ? `${S("word", c(0))} ${S("state", c(3))}` : `${S("dev", c(0))} ${S("state", c(2))}`})))
  (func $eep_stop
    (if (i32.and (i32.and (i32.ne ${G("oscl")} ${c(0)}) (i32.ne ${G("scl")} ${c(0)}))
                 (i32.and (i32.eqz ${G("osda")}) (i32.ne ${G("sda")} ${c(0)})))
      (then ${S("state", c(0))})))
  ;; eeprom_i2c_update
  (func $eep_update
    (local $s i32)
    (local.set $s ${G("state")})
    (block $done
      (if (i32.eqz (local.get $s)) (then (call $eep_start) (br $done)))
      (if (i32.eq (local.get $s) ${c(1)}) (then (call $eep_stop) (br $done)))
      (call $eep_start) (call $eep_stop)
      (if (i32.eq (local.get $s) ${c(3)}) (then
        (if ${fall} (then ${inc9(`${S("state", `(select ${c(7)} ${c(6)} ${G("rw")})`)} ${S("buf", c(0))}`)})
          (else (if ${rise} (then
            (if (i32.lt_u ${G("cyc")} ${c(8)})
              (then ${S("word", `(i32.or ${G("word")} (i32.shl ${G("sda")} (i32.sub ${c(7)} ${G("cyc")})))`)})
              (else (if (i32.eq ${G("cyc")} ${c(8)}) (then ${S("rw", G("sda"))}))))))))
        (br $done)))
      (if (i32.eq (local.get $s) ${c(2)}) (then
        (if ${fall} (then ${inc9(`${S("dev", `(i32.shl ${G("dev")} ${c(e.addressBits)})`)}
              (if ${G("rw")} (then ${S("state", c(7))})
                (else ${S("word", c(0))} ${S("state", c(e.addressBits === 16 ? 4 : 5))}))`)})
          (else (if ${rise} (then
            (if (i32.and (i32.gt_u ${G("cyc")} ${c(4)}) (i32.lt_u ${G("cyc")} ${c(8)}))
              (then ${S("dev", `(i32.or ${G("dev")} (i32.shl ${G("sda")} (i32.sub ${c(7)} ${G("cyc")})))`)})
              (else (if (i32.eq ${G("cyc")} ${c(8)}) (then ${S("rw", G("sda"))}))))))))
        (br $done)))
      (if (i32.eq (local.get $s) ${c(4)}) (then
        (if ${fall} (then ${inc9(S("state", c(5)))})
          (else (if ${rise} (then
            (if (i32.lt_u ${G("cyc")} ${c(9)}) (then
              (if (i32.lt_u ${c(e.sizeMask)} (i32.shl ${c(1)} (i32.sub ${c(16)} ${G("cyc")})))
                (then ${S("dev", `(i32.shr_u ${G("dev")} ${c(1)})`)})
                (else ${S("word", `(i32.or ${G("word")} (i32.shl ${G("sda")} (i32.sub ${c(16)} ${G("cyc")})))`)}))))))))
        (br $done)))
      (if (i32.eq (local.get $s) ${c(5)}) (then
        (if ${fall} (then ${inc9(`${S("state", c(6))} ${S("buf", c(0))}`)})
          (else (if ${rise} (then
            (if (i32.lt_u ${G("cyc")} ${c(9)}) (then
              (if (i32.lt_u ${c(e.sizeMask)} (i32.shl ${c(1)} (i32.sub ${c(8)} ${G("cyc")})))
                (then ${S("dev", `(i32.shr_u ${G("dev")} ${c(1)})`)})
                (else ${S("word", `(i32.or ${G("word")} (i32.shl ${G("sda")} (i32.sub ${c(8)} ${G("cyc")})))`)}))))))))
        (br $done)))
      (if (i32.eq (local.get $s) ${c(7)}) (then
        (if ${fall} (then ${inc9("")})
          (else (if ${rise} (then
            (if (i32.eq ${G("cyc")} ${c(9)}) (then
              (if ${G("sda")} (then ${S("state", c(1))})
                (else ${S("word", `(i32.and (i32.add ${G("word")} ${c(1)}) ${c(e.sizeMask)})`)}))))))))
        (br $done)))
      (if (i32.eq (local.get $s) ${c(6)}) (then
        (if ${fall} (then ${inc9("")})
          (else (if ${rise} (then
            (if (i32.lt_u ${G("cyc")} ${c(9)})
              (then ${S("buf", `(i32.or ${G("buf")} (i32.shl ${G("sda")} (i32.sub ${c(8)} ${G("cyc")})))`)})
              (else (i32.store8 ${arr} ${G("buf")}) ${S("buf", c(0))}
                    ${S("word", `(i32.or (i32.and ${G("word")} ${c(~e.pagewriteMask)}) (i32.and (i32.add ${G("word")} ${c(1)}) ${c(e.pagewriteMask)}))`)})))))))))
    ${S("oscl", G("scl"))} ${S("osda", G("sda"))})
  ;; eeprom_i2c_out
  (func $eep_out (result i32)
    (if (i32.eq ${G("state")} ${c(7)})
      (then (if (i32.lt_u ${G("cyc")} ${c(9)})
              (then (return (i32.and (i32.shr_u (i32.load8_u ${arr}) (i32.sub ${c(8)} ${G("cyc")})) ${c(1)}))))
            (return ${G("sda")})))
    (if (i32.eq ${G("cyc")} ${c(9)}) (then (return ${c(0)})))
    ${G("sda")})
  (func $eep_w (param $d i32)
    ${S("sda", `(i32.and (i32.shr_u (local.get $d) ${c(e.sdaIn)}) ${c(1)})`)}
    ${S("scl", `(i32.and (i32.shr_u (local.get $d) ${c(e.sclIn)}) ${c(1)})`)}
    (call $eep_update))
${e.mapper === "acclaim32" ? `
  ;; mapper_acclaim_32M_write8/16: /LWR -> SDA, /UWR -> SCL; a word write
  ;; with D0 set gives $200000-$2FFFFF back to the ROM, clear to the EEPROM
  (func $acc32_w8 (param $a i32) (param $d i32)
    (if (i32.and (local.get $a) ${c(1)}) (then ${S("sda", `(i32.and (local.get $d) ${c(1)})`)})
      (else ${S("scl", `(i32.and (local.get $d) ${c(1)})`)}))
    (call $eep_update))
  (func $acc32_w16 (param $d i32)
    (memory.fill ${c(CARTR + 0x20)} (select ${c(0)} ${c(1)} (i32.and (local.get $d) ${c(1)})) ${c(16)}))` : ""}${e.jcart ? `
  ;; J-Cart pads 3 and 4 (gpgx gamepad devices 5 and 6: gamepad_read /
  ;; gamepad_write with this port's state), pad bits from the ABI's pads 2/3
  (func $jpad_read (param $k i32) (result i32)
    (local $p i32) (local $data i32) (local $pad i32) (local $step i32)
    (local.set $p (i32.add ${c(JPADS)} (i32.shl (local.get $k) ${c(4)})))
    (local.set $pad (select (global.get $pad3) (global.get $pad2) (local.get $k)))
    (local.set $data (i32.or (i32.load (local.get $p)) ${c(0x3F)}))
    (local.set $step (i32.or (i32.load offset=8 (local.get $p)) (i32.shr_u (local.get $data) ${c(6)})))
    (if (i32.lt_s (global.get $mc) (i32.load offset=4 (local.get $p)))
      (then (local.set $step (i32.and (local.get $step) ${c(-2)}))))
    (if (i32.eq (local.get $step) ${c(4)})
      (then (return (i32.and (local.get $data) (i32.xor (i32.or (i32.and (i32.shr_u (local.get $pad) ${c(2)}) ${c(0x30)}) ${c(0x0F)}) ${c(-1)})))))
    (if (i32.eq (local.get $step) ${c(7)})
      (then (return (i32.and (local.get $data) (i32.xor (i32.or (i32.and (local.get $pad) ${c(0x30)}) (i32.and (i32.shr_u (local.get $pad) ${c(8)}) ${c(0x0F)})) ${c(-1)})))))
    (if (i32.eq (local.get $step) ${c(6)})
      (then (return (i32.and (local.get $data) (i32.xor (i32.and (i32.shr_u (local.get $pad) ${c(2)}) ${c(0x30)}) ${c(-1)})))))
    (if (i32.and (local.get $step) ${c(1)})
      (then (local.set $data (i32.and (local.get $data) (i32.xor (i32.and (local.get $pad) ${c(0x3F)}) ${c(-1)}))))
      (else (local.set $data (i32.and (local.get $data)
              (i32.xor (i32.or (i32.or (i32.and (local.get $pad) ${c(3)}) (i32.and (i32.shr_u (local.get $pad) ${c(2)}) ${c(0x30)})) ${c(0x0C)}) ${c(-1)})))))
    (local.get $data))
  (func $jpad_write (param $k i32) (param $data i32)
    (local $p i32)
    (local.set $p (i32.add ${c(JPADS)} (i32.shl (local.get $k) ${c(4)})))
    (i32.store offset=4 (local.get $p) ${c(0)})${e.sixButton ? `
    (if (i32.and (i32.ne (local.get $data) ${c(0)}) (i32.eqz (i32.load (local.get $p))))
      (then (if (i32.lt_u (i32.load offset=8 (local.get $p)) ${c(8)})
              (then (i32.store offset=8 (local.get $p) (i32.add (i32.load offset=8 (local.get $p)) ${c(2)}))
                    (i32.store offset=12 (local.get $p) ${c(0)})))))` : ""}
    (i32.store (local.get $p) (local.get $data)))
  (func $jpad_refresh${e.sixButton ? `
    (local $p i32) (local $k i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $k) ${c(2)}))
      (local.set $p (i32.add ${c(JPADS)} (i32.shl (local.get $k) ${c(4)})))
      (if (i32.gt_u (i32.load offset=12 (local.get $p)) ${c(25)})
        (then (i32.store offset=8 (local.get $p) ${c(0)}) (i32.store offset=12 (local.get $p) ${c(0)}))
        (else (i32.store offset=12 (local.get $p) (i32.add (i32.load offset=12 (local.get $p)) ${c(1)}))))
      (local.set $k (i32.add (local.get $k) ${c(1)}))
      (br $l)))` : ""})
  ;; jcart_read: D6 = TH, D14 fixed low
  (func $jcart_read (result i32)
    (i32.or (call $jpad_read ${c(0)}) (i32.shl (i32.and (call $jpad_read ${c(1)}) ${c(0x3F)}) ${c(8)})))
  (func $jcart_write (param $d i32)
    (local.set $d (i32.shl (i32.and (local.get $d) ${c(1)}) ${c(6)}))
    (call $jpad_write ${c(0)} (local.get $d))
    (call $jpad_write ${c(1)} (local.get $d)))` : ""}
  (func $cart_rd8 (param $a i32) (result i32)
    (local $h i32)
    (local.set $h (i32.load8_u (i32.add ${c(CARTR)} (i32.and (i32.shr_u (local.get $a) ${c(16)}) ${c(0x3F)}))))
    (if (i32.eq (local.get $h) ${c(1)})
      (then (if (i32.and (local.get $a) ${c(1)}) (then (return (i32.shl (call $eep_out) ${c(e.sdaOut)}))))
            (return (call $bus8 (local.get $a)))))${e.jcart ? `
    (if (i32.eq (local.get $h) ${c(2)})
      (then (if (i32.and (local.get $a) ${c(1)})
              (then (return (i32.or (i32.shl (call $eep_out) ${c(7)}) (i32.and (call $jcart_read) ${c(0x7F)})))))
            (return (i32.shr_u (call $jcart_read) ${c(8)}))))` : ""}
    (call $cart_b8 (local.get $a)))
  (func $cart_rd16 (param $a i32) (result i32)
    (local $h i32)
    (local.set $h (i32.load8_u (i32.add ${c(CARTR)} (i32.and (i32.shr_u (local.get $a) ${c(16)}) ${c(0x3F)}))))
    (if (i32.eq (local.get $h) ${c(1)}) (then (return (i32.shl (call $eep_out) ${c(e.sdaOut)}))))${e.jcart ? `
    (if (i32.eq (local.get $h) ${c(2)}) (then (return (i32.or (i32.shl (call $eep_out) ${c(7)}) (call $jcart_read)))))` : ""}
    (call $cart_b16 (local.get $a)))
  (func $cart_wr8 (param $a i32) (param $v i32)
    (local $h i32)
    (local.set $h (i32.load8_u (i32.add ${c(CARTW)} (i32.and (i32.shr_u (local.get $a) ${c(16)}) ${c(0x3F)}))))
    (if (i32.eqz (local.get $h)) (then (call $cart_wb8 (local.get $a) (local.get $v)) (return)))
    (if (i32.eq (local.get $h) ${c(1)}) (then (if (i32.and (local.get $a) ${c(1)}) (then (call $eep_w (local.get $v)))) (return)))
    (if (i32.eq (local.get $h) ${c(2)}) (then (call $eep_w (local.get $v)) (return)))${e.mapper === "acclaim32" ? `
    (if (i32.eq (local.get $h) ${c(3)}) (then (call $acc32_w8 (local.get $a) (local.get $v)) (return)))` : ""}${e.jcart ? `
    (if (i32.eq (local.get $h) ${c(4)}) (then (call $jcart_write (local.get $v)) (return)))` : ""})
  (func $cart_wr16 (param $a i32) (param $v i32)
    (local $h i32)
    (local.set $h (i32.load8_u (i32.add ${c(CARTW)} (i32.and (i32.shr_u (local.get $a) ${c(16)}) ${c(0x3F)}))))
    (if (i32.eqz (local.get $h)) (then (call $cart_wb16 (local.get $a) (local.get $v)) (return)))
    (if (i32.le_u (local.get $h) ${c(2)}) (then (call $eep_w (local.get $v)) (return)))${e.mapper === "acclaim32" ? `
    (if (i32.eq (local.get $h) ${c(3)}) (then (call $acc32_w16 (local.get $v)) (return)))` : ""}${e.jcart ? `
    (if (i32.eq (local.get $h) ${c(4)}) (then (call $jcart_write (local.get $v)) (return)))` : ""})
`;
}

/**
 * Power-on handler tables for an EEPROM board (the *_init functions of
 * eeprom_i2c.c), as WAT statements.
 * @param {{mapper:string, eeprom:boolean, jcart:boolean, jcartReads:boolean}} e
 */
export function eepromInitWat(e) {
  const fill = (t, from, to, v) => `    (memory.fill (i32.const ${t + from}) (i32.const ${v}) (i32.const ${to - from}))\n`;
  let s = fill(CARTR, 0, 0x40, 0) + fill(CARTW, 0, 0x40, 0);
  if (e.mapper === "ea" || e.mapper === "sega") s += fill(CARTR, 0x20, 0x40, 1) + fill(CARTW, 0x20, 0x40, 1);
  else if (e.mapper === "acclaim16") s += fill(CARTR, 0x20, 0x40, 1) + fill(CARTW, 0x20, 0x40, 2);
  else if (e.mapper === "acclaim32") s += fill(CARTW, 0x20, 0x30, 3);
  else if (e.mapper === "jcart") {
    if (e.eeprom) s += fill(CARTW, 0x30, 0x38, 2);
    if (e.jcartReads) s += fill(CARTR, 0x38, 0x40, 2) + fill(CARTW, 0x38, 0x40, 4);
    else s += fill(CARTR, 0x38, 0x40, 1) + fill(CARTW, 0x38, 0x40, 5);
  }
  s += `    (global.set $e_sda (i32.const 1)) (global.set $e_osda (i32.const 1)) (global.set $e_scl (i32.const 1)) (global.set $e_oscl (i32.const 1))
    (global.set $e_state (i32.const 0)) (global.set $e_cyc (i32.const 0)) (global.set $e_rw (i32.const 0))
    (global.set $e_dev (i32.const 0)) (global.set $e_word (i32.const 0)) (global.set $e_buf (i32.const 0))\n`;
  if (e.jcart) s += `    (memory.fill (i32.const ${JPADS}) (i32.const 0) (i32.const 32))
    (i32.store (i32.const ${JPADS}) (i32.const 0x40)) (i32.store (i32.const ${JPADS + 16}) (i32.const 0x40))\n`;
  return s;
}

/**
 * The power-on cartridge map (md_cart_init): every bank its own mirror,
 * backup RAM at `sramBank` if sram_init mapped it there, backup RAM $FF.
 * @param {number} romsize
 * @param {number|null} sramBank
 */
export function cartInitWat(romsize, sramBank, sx = null, realtec = false) {
  const rmask = romsize - 1;
  return `    (local.set $i (i32.const 0))
    (block $cd (loop $cl
      (br_if $cd (i32.ge_u (local.get $i) (i32.const 64)))
      (i32.store (i32.add (i32.const ${CARTMAP}) (i32.shl (local.get $i) (i32.const 2))) (i32.and (i32.shl (local.get $i) (i32.const 16)) (i32.const ${rmask})))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl)))
    (global.set $remapped (i32.const 0))
    (memory.fill (i32.const ${SRAMBUF}) (i32.const 0xFF) (i32.const 0x10000))
${sramBank != null ? `    (i32.store (i32.const ${CARTMAP + sramBank * 4}) (i32.const -1))
    (global.set $remapped (i32.const 1))
${sramBank === 0x20 ? `    (global.set $sramreg0 (i32.const ${(0x200000 & rmask) >> 16}))\n` : ""}` : ""}${sx ? sx.extraBanks.map((b) => `    (i32.store (i32.const ${CARTMAP + b * 4}) (i32.const -1)) (global.set $remapped (i32.const 1))\n`).join("") +
    sx.remap.map(([b, off]) => `    (i32.store (i32.const ${CARTMAP + b * 4}) (i32.const ${off})) (global.set $remapped (i32.const 1))\n`).join("") +
    (sx.extraBanks.includes(0x20) ? `    (global.set $sramreg0 (i32.const ${(0x200000 & rmask) >> 16}))\n` : "") : ""}${realtec ? `    ;; md_cart_reset: the Realtec boot ROM (8KB mirrored) in $000000-$3FFFFF
${Array.from({ length: 64 }, (_, i) => `    (i32.store (i32.const ${CARTMAP + i * 4}) (i32.const -4))`).join("\n")}
    (global.set $remapped (i32.const 1))
    (global.set $hwr0 (i32.const 0)) (global.set $hwr1 (i32.const 0)) (global.set $hwr2 (i32.const 0))\n` : ""}`;
}
