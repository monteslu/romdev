// Test support for the SNES recompiler's S-DD1 / SPC7110 / CX4 tests: byte
// helpers for the few 65816 instructions the synthetic programs use, a
// headered cart image builder and an in-process cart runner. Synthetic
// programs and data only (never commercial code).
//
// Plain JS ESM.

import { emitWat, describe } from "../src/analysis/recompile/wat/snes/index.js";
import { assembleWat } from "../src/analysis/recompile/wat/assemble.js";

const lo = (v) => v & 0xff, hi = (v) => (v >> 8) & 0xff, bk = (v) => (v >> 16) & 0xff;

/** Native mode, A 8-bit and X/Y 16-bit unless the program changes them. */
export const A = {
  sei: () => [0x78], clc: () => [0x18], xce: () => [0xfb], rep: (v) => [0xc2, v], sep: (v) => [0xe2, v],
  ldaI: (v) => [0xa9, lo(v)], ldaI16: (v) => [0xa9, lo(v), hi(v)], ldxI: (v) => [0xa2, lo(v), hi(v)],
  lda: (a) => [0xad, lo(a), hi(a)], sta: (a) => [0x8d, lo(a), hi(a)], stz: (a) => [0x9c, lo(a), hi(a)],
  ldaL: (a) => [0xaf, lo(a), hi(a), bk(a)], staL: (a) => [0x8f, lo(a), hi(a), bk(a)],
  ldaLX: (a) => [0xbf, lo(a), hi(a), bk(a)], staLX: (a) => [0x9f, lo(a), hi(a), bk(a)],
  inx: () => [0xe8], cpxI: (v) => [0xe0, lo(v), hi(v)], bne: (r) => [0xd0, lo(r)], bra: (r) => [0x80, lo(r)],
  ldyI: (v) => [0xa0, lo(v), hi(v)], iny: () => [0xc8], cpyI: (v) => [0xc0, lo(v), hi(v)],
  ldaDY: (dp) => [0xb7, dp], staDY: (dp) => [0x97, dp], ldaY: (a) => [0xb9, lo(a), hi(a)], staY: (a) => [0x99, lo(a), hi(a)],
  ldaD: (dp) => [0xa5, dp], staD: (dp) => [0x85, dp], decD: (dp) => [0xc6, dp], adcI16: (v) => [0x69, lo(v), hi(v)],
  dex: () => [0xca], dey: () => [0x88],
};

/** Copy `n` bytes from 24-bit `src` to 24-bit `dst` (lda long,x / sta long,x, X 16-bit). */
export function copyLoop(src, dst, n) {
  const body = [...A.ldaLX(src), ...A.staLX(dst), ...A.inx(), ...A.cpxI(n)];
  return [...A.ldxI(0), ...body, ...A.bne(-(body.length + 2))];
}

/** A general DMA on channel 0 ($4300-$4306), started by $420B = 1. */
export function dma0({ ctrl, bport, src, count }) {
  return [
    ...A.ldaI(ctrl), ...A.sta(0x4300), ...A.ldaI(bport), ...A.sta(0x4301),
    ...A.ldaI(lo(src)), ...A.sta(0x4302), ...A.ldaI(hi(src)), ...A.sta(0x4303), ...A.ldaI(bk(src)), ...A.sta(0x4304),
    ...A.ldaI(lo(count)), ...A.sta(0x4305), ...A.ldaI(hi(count)), ...A.sta(0x4306),
    ...A.ldaI(1), ...A.sta(0x420b),
  ];
}

/** The WRAM port address ($2181-$2183). */
export const wramAddr = (a) => [...A.ldaI(lo(a)), ...A.sta(0x2181), ...A.ldaI(hi(a)), ...A.sta(0x2182), ...A.ldaI(bk(a) & 1), ...A.sta(0x2183)];

/** Deterministic bytes (xorshift32). */
export function rand(n, seed = 1) {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}

/**
 * A cart image with a header (LoROM at $7FC0 or HiROM at $FFC0) and the
 * reset / NMI / IRQ vectors on `entry`; `code` goes at file offset `codeAt`.
 * The checksum pair is left complementary, not summed.
 */
export function cartImage({ size, hiRom = false, mapMode, chipset, romSizeByte, sramSizeByte = 0, name, code, codeAt = 0, entry = 0x8000, data = [] }) {
  const img = new Uint8Array(size);
  for (const [at, bytes] of data) img.set(bytes, at);
  img.set(code, codeAt);
  const h = hiRom ? 0xffc0 : 0x7fc0;
  const title = name.padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  Object.assign(img, { [h + 0x15]: mapMode, [h + 0x16]: chipset, [h + 0x17]: romSizeByte, [h + 0x18]: sramSizeByte, [h + 0x19]: 1, [h + 0x1a]: 0x33 });
  img[h + 0x1c] = 0xff; img[h + 0x1d] = 0xff; img[h + 0x1e] = 0; img[h + 0x1f] = 0;
  for (const v of [0xfc, 0xea, 0xee]) { img[h - 0xc0 + v] = lo(entry); img[h - 0xc0 + v + 1] = hi(entry); }
  return img;
}

/**
 * Recompile `rom`, run wc_init and `frames` wc_renders in-process. With
 * `clock` (RTC_CLOCK's stepMs) the host's frame clock is written the way the
 * wasmcart host writes it: render i (from 0) sees timeMs = i * stepMs.
 * @returns {Promise<{mem: Uint8Array, ex: any, lay: any, d: any}>}
 */
export async function runCart(rom, frames, opts = {}, clock = null) {
  const d = describe(rom, opts);
  if (!d.supported) throw new Error(`refused: ${d.refusal}`);
  const { bytes } = await assembleWat(emitWat(rom, opts));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const timePtr = clock ? new Uint32Array(ex.memory.buffer, ex.wc_get_info(), 18)[10] : 0;
  for (let i = 0; i < frames; i++) {
    if (clock) new Float64Array(ex.memory.buffer, timePtr, 1)[0] = i * clock.stepMs;
    ex.wc_render();
  }
  return { mem: new Uint8Array(ex.memory.buffer), ex, lay: d.memory, d };
}

/**
 * The S-DD1 test cart (2MB LoROM, chipset $43 / map $32): the $4800-$4807
 * registers, the $C0-$FF windows (one past the image), and DMA decompression
 * of random streams (every bitplane type and context mode) into WRAM through
 * $2180, a plain transfer with $4801 set, a fixed + decrement one, and 64KB
 * (count 0) into VRAM.
 */
export function sdd1Rom() {
  const SIZE = 0x200000;
  const streams = [
    [0x10000, 0x00, 0x200, 0xc10000], [0x12345, 0x10, 0x155, 0xc12345], [0x20000, 0x20, 0x400, 0xc20000],
    [0x30000, 0x30, 0x301, 0xc30000], [0x40000, 0x40, 0x800, 0xc40000], [0x50000, 0x50, 0x3ff, 0xc50000],
    [0x60000, 0x80, 0x1000, 0xc60000], [0x70000, 0xb0, 0x7ff, 0xc70000], [0x80000, 0xc0, 0x6a1, 0xc80000],
    [0x90000, 0xf0, 0x1001, 0xc90000],
    [0x98000, 0xe5, 0x123, 0x138000],     // through LoROM bank $13 ($13:8000 = file $98000)
    [0x150000, 0x70, 0x777, 0xd50000],    // through $D0-$DF after $4805 = 1
  ];
  const c = [];
  const emit = (...p) => c.push(...p.flat());
  emit(A.sei(), A.clc(), A.xce(), A.rep(0x10), A.sep(0x20));
  emit(copyLoop(0x004800, 0x7e0100, 8), A.lda(0x4808), A.staL(0x7e0108), A.lda(0x4900), A.staL(0x7e0109));
  emit(A.ldaI(0xa5), A.sta(0x4800), A.ldaI(0x5a), A.sta(0x4802), A.ldaI(0x33), A.sta(0x4803));
  emit(A.ldaI(0x01), A.sta(0x4805), A.ldaI(0x00), A.sta(0x4806), A.ldaI(0x09), A.sta(0x4807));
  emit(copyLoop(0x004800, 0x7e0110, 8));
  emit(A.ldaL(0xd00000), A.staL(0x7e0120), A.ldaL(0xd12345), A.staL(0x7e0121), A.ldaL(0xe00010), A.staL(0x7e0122));
  emit(A.ldaL(0xf0ffff), A.staL(0x7e0123), A.ldaL(0xc00000), A.staL(0x7e0124), A.ldaL(0xcfffff), A.staL(0x7e0125));
  emit(A.ldaI(0x03), A.sta(0x4804), A.ldaL(0xc00000), A.staL(0x7e0126), A.ldaL(0xc12345), A.staL(0x7e0127), A.ldaI(0x00), A.sta(0x4804));
  emit(A.ldaL(0x601234), A.staL(0x7e0128), A.ldaL(0x3fffff), A.staL(0x7e0129), A.ldaL(0x7d9000), A.staL(0x7e012a));
  streams.forEach(([, , len, src], k) => {
    emit(wramAddr(0x7f0000 + k * 0x1100), A.ldaI(0x01), A.sta(0x4801), dma0({ ctrl: 0x08, bport: 0x80, src, count: len }));
    emit(copyLoop(0x004302, 0x7e0200 + k * 8, 5), A.lda(0x4801), A.staL(0x7e0205 + k * 8));
  });
  emit(wramAddr(0x7fe000), A.ldaI(0x02), A.sta(0x4801), dma0({ ctrl: 0x00, bport: 0x80, src: 0xc10000, count: 0x40 }));
  emit(A.lda(0x4801), A.staL(0x7e0300));
  emit(wramAddr(0x7fe100), A.ldaI(0x80), A.sta(0x4801), dma0({ ctrl: 0x18, bport: 0x80, src: 0xc20000, count: 0x100 }));
  emit(copyLoop(0x004302, 0x7e0310, 5));
  emit(A.ldaI(0x80), A.sta(0x2115), A.stz(0x2116), A.stz(0x2117), A.ldaI(0x01), A.sta(0x4801));
  emit(dma0({ ctrl: 0x09, bport: 0x18, src: 0xca0000, count: 0 }));
  emit(copyLoop(0x004302, 0x7e0320, 5), A.ldaI(0x77), A.staL(0x7e0330), A.bra(-2));
  const data = rand(SIZE - 0x10000, 7);
  for (const [off, b0] of streams) data[off - 0x10000] = b0;
  return cartImage({ size: SIZE, mapMode: 0x32, chipset: 0x43, romSizeByte: 0x0b, name: "SDD1 SYNTH TEST", code: c, data: [[0x10000, data]] });
}

/**
 * The CX4 arithmetic test cart (1MB LoROM, chipset $F3 / map $20): for each
 * command in `CX4_MATH` and each of 64 random parameter blocks, the block
 * goes to $7F80-$7F9F, $7F4D = 2, the command to $7F4F, and $7F80-$7F9F is
 * copied out to WRAM $7E:2000 + 32 per run (the trigonometry, square roots
 * and products in doubles).
 */
export const CX4_MATH = [0x05, 0x0d, 0x10, 0x13, 0x15, 0x1f, 0x25, 0x2d, 0x54];
export function cx4MathRom() {
  const SIZE = 0x100000, N = 64;
  const c = [];
  const emit = (...p) => c.push(...p.flat());
  emit(A.sei(), A.clc(), A.xce(), A.rep(0x10), A.sep(0x20));
  // dp $10-$12 = source (ROM $01:8000 onwards = file $8000), $14-$16 = dest $7E:2000
  emit(A.ldaI(0x00), A.staD(0x10), A.ldaI(0x80), A.staD(0x11), A.ldaI(0x01), A.staD(0x12));
  emit(A.ldaI(0x00), A.staD(0x14), A.ldaI(0x20), A.staD(0x15), A.ldaI(0x7e), A.staD(0x16));
  for (const cmd of CX4_MATH) {
    emit(A.ldaI(N), A.staD(0x1a));
    const outer = c.length;
    const cp1 = [...A.ldaDY(0x10), ...A.staY(0x7f80), ...A.iny(), ...A.cpyI(32)];
    emit(A.ldyI(0), cp1, A.bne(-(cp1.length + 2)));
    emit(A.ldaI(2), A.sta(0x7f4d), A.ldaI(cmd), A.sta(0x7f4f));
    const cp2 = [...A.ldaY(0x7f80), ...A.staDY(0x14), ...A.iny(), ...A.cpyI(32)];
    emit(A.ldyI(0), cp2, A.bne(-(cp2.length + 2)));
    emit(A.rep(0x20), A.ldaD(0x10), A.clc(), A.adcI16(32), A.staD(0x10), A.ldaD(0x14), A.clc(), A.adcI16(32), A.staD(0x14), A.sep(0x20));
    emit(A.decD(0x1a));
    const back = outer - (c.length + 2);
    if (back < -128) emit([0xf0, 3], [0x4c, lo(0x8000 + outer), hi(0x8000 + outer)]);
    else emit(A.bne(back));
  }
  emit(A.ldaI(0x77), A.staL(0x7e0010), A.bra(-2));
  const data = rand(SIZE - 0x8000, 11);
  return cartImage({ size: SIZE, mapMode: 0x20, chipset: 0xf3, romSizeByte: 0x0a, name: "CX4 MATH TEST", code: c, data: [[0x8000, data]] });
}

/**
 * The CX4 graphics test cart (1MB LoROM): each case fills the chip's RAM from
 * random ROM data ($6000-$7F3F and $7F50-$7FFF, not the $7F47 / $7F4F
 * triggers), sets the case's parameters in range, runs it, and copies all
 * 8KB ($6000-$7FFF, through S9xGetC4) to WRAM $7E:2000 + 8KB * case.
 * ROM: bank $04 sprite descriptors, bank $05 wireframe lines and points.
 */
export function cx4GfxRom() {
  const SIZE = 0x100000;
  const data = rand(SIZE - 0x8000, 23);
  const put = (file, bytes) => data.set(bytes, file - 0x8000);
  // $04:8000 + $40 * i: sprite descriptor i = count (1-6), then 4 bytes per piece
  for (let i = 0; i < 32; i++) put(0x20000 + i * 0x40, [1 + (i % 6)]);
  // $05:8000: six lines [p1 hi, p1 lo, p2 hi, p2 lo, colour], points in bank 5
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(0x80 + i, 0x10 * i, 0x90 + i, 0x08 * i, i & 3);
  lines.splice(15, 2, 0xff, 0xff);   // line 3 reuses the previous line's end point
  put(0x28000, lines);
  const c = [];
  const emit = (...p) => c.push(...p.flat());
  const w8 = (a, v) => [...A.ldaI(v), ...A.staL(a)];
  const w16 = (a, v) => [...w8(a, v & 0xff), ...w8(a + 1, (v >> 8) & 0xff)];
  const w24 = (a, v) => [...w16(a, v & 0xffff), ...w8(a + 2, (v >> 16) & 0xff)];
  let k = 0, src = 0x018000;
  const kase = (params, run) => {
    emit(copyLoop(src, 0x006000, 0x1f40));
    emit(copyLoop(src + 0x1f50, 0x007f50, 0xb0));
    src += 0x2000;
    for (const p of params) emit(p);
    emit(run);
    emit(copyLoop(0x006000, 0x7e2000 + k * 0x2000, 0x2000));
    k++;
  };
  emit(A.sei(), A.clc(), A.xce(), A.rep(0x10), A.sep(0x20));
  // $7F47: copy $400 bytes of ROM ($02:8123) to chip RAM $0100
  kase([w24(0x7f40, 0x028123), w16(0x7f43, 0x400), w16(0x7f45, 0x6100)], w8(0x7f47, 0));
  // $5C, $89, the $0E test command, $40 sum ($7F5E reads 0 in the copy)
  kase([], [...w8(0x7f4f, 0x5c), ...w8(0x7f4f, 0x89), ...w8(0x7f4d, 0x0e), ...w8(0x7f4f, 0x24), ...w8(0x7f4f, 0x40)]);
  // $22 trapezoid
  kase([w8(0x7f4d, 2), w16(0x7f8c, 0x0123), w16(0x7f8f, 0x0077), w16(0x7f83, 0x0040), w16(0x7f89, 0x0010), w16(0x7f80, 0x0020), w16(0x7f86, 0x0080), w16(0x7f93, 0x0030)], w8(0x7f4f, 0x22));
  // sprite command 0: build OAM (20 sprites, descriptors in bank $04)
  const oam = [w8(0x7f4d, 0), w8(0x6626, 0x10), w8(0x6620, 20), w16(0x6621, 0x0030), w16(0x6623, 0x0020)];
  for (let i = 0; i < 20; i++) {
    oam.push(w16(0x6220 + i * 16, 0x40 + i * 9), w16(0x6222 + i * 16, 0x30 + i * 7), w24(0x6227 + i * 16, 0x048000 + i * 0x40));
  }
  oam.push(w24(0x6227 + 5 * 16, 0x04ffff));   // a descriptor whose count byte is 0 (a single sprite)
  kase(oam, w8(0x7f4f, 0));
  // sprite commands 3 / 7: scale and rotate (a random angle, 90 degrees, row padding)
  const sr = (angle, w, h, xs, ys) => [w8(0x7f89, w), w8(0x7f8c, h), w16(0x7f80, angle), w16(0x7f8f, xs), w16(0x7f92, ys), w16(0x7f83, w >> 1), w16(0x7f86, h >> 1)];
  kase([w8(0x7f4d, 3), ...sr(0x37, 0x40, 0x40, 0x1234, 0x0e00)], w8(0x7f4f, 0));
  kase([w8(0x7f4d, 3), ...sr(0x80, 0x40, 0x40, 0x0800, 0x9000)], w8(0x7f4f, 0));
  kase([w8(0x7f4d, 7), ...sr(0x1a5, 0x20, 0x20, 0x1000, 0x1100)], w8(0x7f4f, 0));
  // sprite command 5: transform lines (8 vertices, 8 lines)
  const tl = [w8(0x7f4d, 5), w16(0x7f80, 8), w16(0x6b00, 8), w8(0x7f83, 0x21), w8(0x7f86, 0x47), w8(0x7f89, 0x13), w8(0x7f8c, 0x90)];
  for (let i = 0; i < 8; i++) tl.push(w8(0x6b02 + i * 2, i), w8(0x6b03 + i * 2, (i * 3 + 1) & 7));
  kase(tl, w8(0x7f4f, 0));
  // sprite command 8 and command 1: draw the wireframe (lines at $05:8000)
  const wf = [w8(0x7f4d, 8), w24(0x7f80, 0x058000), w8(0x6295, 6), w8(0x7f90, 0x40), w8(0x7f86, 0x10), w8(0x7f87, 0x20), w8(0x7f88, 0x30)];
  kase(wf, w8(0x7f4f, 0));
  kase(wf, w8(0x7f4f, 1));
  // sprite command $0B: disintegrate; $0C: wave
  kase([w8(0x7f4d, 0x0b), w8(0x7f89, 0x40), w8(0x7f8c, 0x40), w16(0x7f80, 0x20), w16(0x7f83, 0x20), w16(0x7f86, 0x0180), w16(0x7f8f, 0x0140)], w8(0x7f4f, 0));
  kase([w8(0x7f4d, 0x0c), w8(0x7f83, 0x35)], w8(0x7f4f, 0));
  emit(A.ldaI(0x77), A.staL(0x7e0010), A.bra(-2));
  return cartImage({ size: SIZE, mapMode: 0x20, chipset: 0xf3, romSizeByte: 0x0a, name: "CX4 GFX TEST", code: c, data: [[0x8000, data]] });
}

/**
 * The SPC7110 test cart (4MB HiROM: 1MB program, 3MB data ROM; map $3A, chipset $F5, or $F9 with the
 * RTC): the math unit, the data ROM port in its modes, the $D0-$FF windows,
 * decompression (modes 0-2, CPU reads of $4800, DMA from $4800 and bank $50),
 * HiROM SRAM, and with `rtc` the RTC-4513 read before and after a write and
 * about two seconds of frames. Results go to WRAM ($7E:0100-$0FFF, $7F:0000+).
 */
export function spc7110Rom({ rtc = false } = {}) {
  const SIZE = 0x400000;
  const data = rand(0x300000, 31);
  // decompression table at data ROM 0: [mode, offset (big-endian 24-bit)]
  const table = [[0, 0x001000], [1, 0x003000], [2, 0x005000], [0, 0x007123], [2, 0x00a000]];
  table.forEach(([m, o], i) => data.set([m, (o >> 16) & 0xff, (o >> 8) & 0xff, o & 0xff], i * 4));
  const c = [];
  const emit = (...p) => c.push(...p.flat());
  const w8 = (a, v) => [...A.ldaI(v), ...A.sta(a)];
  const rd = (a, dst) => [...A.lda(a), ...A.staL(dst)];
  const rdn = (a, dst, n) => { const r = []; for (let i = 0; i < n; i++) r.push(...rd(a, dst + i)); return r; };
  emit(A.sei(), A.clc(), A.xce(), A.rep(0x10), A.sep(0x20));
  // math unit: unsigned / signed multiply, unsigned / signed divide, divide by zero
  const math = (ctl, regs, trig, dst) => [w8(0x482e, ctl), ...regs.map(([a, v]) => w8(a, v)), w8(trig, regs.find(([a]) => a === trig)?.[1] ?? 0), copyLoop(0x004820, dst, 16)];
  emit(math(0, [[0x4820, 0x34], [0x4821, 0x12], [0x4824, 0x56]], 0x4825, 0x7e0100).flat());
  emit(math(1, [[0x4820, 0x34], [0x4821, 0xf2], [0x4824, 0x65]], 0x4825, 0x7e0110).flat());
  emit(math(0, [[0x4820, 0xef], [0x4821, 0xcd], [0x4822, 0xab], [0x4823, 0x89], [0x4826, 0x34]], 0x4827, 0x7e0120).flat());
  emit(math(1, [[0x4820, 0xef], [0x4821, 0xcd], [0x4822, 0xab], [0x4823, 0x89], [0x4826, 0x34]], 0x4827, 0x7e0130).flat());
  emit(math(0, [[0x4820, 0x11], [0x4821, 0x22], [0x4822, 0x33], [0x4823, 0x44], [0x4826, 0x00]], 0x4827, 0x7e0140).flat());
  emit(rd(0x482f, 0x7e0150), rd(0x482f, 0x7e0151));
  // data port: $4818 before the pointer is complete is ignored, then each mode
  emit(w8(0x4818, 0x01), w8(0x4811, 0x00), w8(0x4812, 0x10), w8(0x4813, 0x00), rd(0x4818, 0x7e01ff));
  emit(w8(0x4818, 0x00), rdn(0x4810, 0x7e0200, 16), copyLoop(0x004811, 0x7e0210, 8));
  emit(w8(0x4816, 0x03), w8(0x4817, 0x00), w8(0x4818, 0x01), rdn(0x4810, 0x7e0218, 8), copyLoop(0x004811, 0x7e0220, 8));
  emit(w8(0x4818, 0x02), w8(0x4814, 0x10), w8(0x4815, 0x00), rdn(0x4810, 0x7e0228, 8), copyLoop(0x004811, 0x7e0230, 8));
  emit(w8(0x4818, 0x0a), w8(0x4814, 0xf0), w8(0x4815, 0xff), rdn(0x4810, 0x7e0238, 4), copyLoop(0x004811, 0x7e0240, 8));
  emit(w8(0x4818, 0x60), w8(0x4814, 0x21), w8(0x4815, 0x00), rdn(0x481a, 0x7e0248, 4), copyLoop(0x004811, 0x7e0250, 8));
  emit(w8(0x4818, 0x22), w8(0x4814, 0x81), w8(0x4815, 0x00), copyLoop(0x004811, 0x7e0258, 8));
  emit(w8(0x4818, 0x42), w8(0x4815, 0x80), w8(0x4814, 0x02), copyLoop(0x004811, 0x7e0260, 8));
  emit(w8(0x4818, 0x2a), w8(0x4814, 0x90), w8(0x4815, 0x00), copyLoop(0x004811, 0x7e0268, 8));
  emit(w8(0x4818, 0x15), w8(0x4816, 0x05), w8(0x4817, 0x80), rdn(0x4810, 0x7e0270, 4), copyLoop(0x004811, 0x7e0278, 8));
  emit(w8(0x4818, 0x70), rdn(0x481a, 0x7e0280, 4), copyLoop(0x004811, 0x7e0288, 8));
  // data ROM windows, before and after the bank registers move
  const win = (dst) => [A.ldaL(0xd00000), A.staL(dst), A.ldaL(0xd12345), A.staL(dst + 1), A.ldaL(0xe00000), A.staL(dst + 2),
    A.ldaL(0xe7ffff), A.staL(dst + 3), A.ldaL(0xf00000), A.staL(dst + 4), A.ldaL(0xfabcde), A.staL(dst + 5)].flat();
  emit(win(0x7e0300), copyLoop(0x004830, 0x7e0308, 5));
  emit(w8(0x4831, 0x01), w8(0x4832, 0x05), w8(0x4833, 0x0f), win(0x7e0310), copyLoop(0x004830, 0x7e0318, 5));
  emit(w8(0x4831, 0x00), w8(0x4832, 0x01), w8(0x4833, 0x02));
  // program ROM through the HiROM banks
  emit(A.ldaL(0x0fffff), A.staL(0x7e0320), A.ldaL(0xc01234), A.staL(0x7e0321), A.ldaL(0x8f8000), A.staL(0x7e0322), A.ldaL(0x401234), A.staL(0x7e0323));
  // decompression: each table entry, 64 CPU reads, then DMA from $4800 and from $50:1234
  table.forEach((_, k) => {
    emit(w8(0x4801, 0), w8(0x4802, 0), w8(0x4803, 0), w8(0x4804, k), w8(0x4809, 0x00), w8(0x480a, 0x02));
    emit(w8(0x4805, k === 4 ? 0x13 : 0), w8(0x4806, 0), rd(0x480c, 0x7e0400 + k * 0x100), rd(0x480c, 0x7e0401 + k * 0x100));
    emit(rdn(0x4800, 0x7e0410 + k * 0x100, 0x40), copyLoop(0x004801, 0x7e0402 + k * 0x100, 12));
    emit(wramAddr(0x7f0000 + k * 0x200), dma0({ ctrl: 0x08, bport: 0x80, src: 0x004800, count: 0x80 }), copyLoop(0x004302, 0x7e0450 + k * 0x100, 5));
    emit(wramAddr(0x7f0100 + k * 0x200), dma0({ ctrl: 0x00, bport: 0x80, src: 0x501234, count: 0x40 }), copyLoop(0x004302, 0x7e0458 + k * 0x100, 5));
    emit(copyLoop(0x004809, 0x7e0460 + k * 0x100, 2));
  });
  // HiROM SRAM at $00:6000 and $30:6000, with $4830 off and on
  emit(w8(0x4830, 0x00), A.ldaI(0x5a), A.staL(0x006000), A.ldaI(0xa5), A.staL(0x307fff), w8(0x4830, 0x80), A.ldaI(0x3c), A.staL(0x006001));
  emit(A.ldaL(0x006000), A.staL(0x7e0a00), A.ldaL(0x006001), A.staL(0x7e0a01), A.ldaL(0x307fff), A.staL(0x7e0a02), A.ldaL(0x306000), A.staL(0x7e0a03));
  if (rtc) {
    const rtcRead = (dst) => [w8(0x4840, 0x01), rd(0x4842, dst), rd(0x4842, dst + 1), w8(0x4841, 0x03), w8(0x4841, 0x00),
      rdn(0x4841, dst + 2, 16), rd(0x4842, dst + 18), w8(0x4840, 0x00)].flat();
    emit(rd(0x4842, 0x7e0e00), rd(0x4841, 0x7e0e01), rtcRead(0x7e0e10));
    // set 1999-12-31 23:59:57, weekday 5
    const regs = [7, 5, 9, 5, 3, 2, 1, 3, 2, 1, 9, 9, 5, 0, 0, 0];
    emit(w8(0x4840, 0x01), w8(0x4841, 0x03), w8(0x4841, 0x00), regs.map((v) => w8(0x4841, v)).flat(), w8(0x4840, 0x00));
    emit(rtcRead(0x7e0e30));
    // about two seconds of frames, then read again
    const inner = [...A.dex(), ...A.bne(-3)];
    emit(A.ldyI(40), A.ldxI(0), inner, A.dey(), A.bne(-(inner.length + 3 + 1 + 2)));
    emit(rtcRead(0x7e0e50));
    // control register 2 (bit 0 stops the clock and clears the seconds), 13 (bit 1 adds a second)
    emit(w8(0x4840, 0x01), w8(0x4841, 0x03), w8(0x4841, 0x0f), w8(0x4841, 0x01), w8(0x4840, 0x00), rtcRead(0x7e0e70));
    emit(w8(0x4840, 0x01), w8(0x4841, 0x03), w8(0x4841, 0x0f), w8(0x4841, 0x00), w8(0x4840, 0x00));
    emit(w8(0x4840, 0x01), w8(0x4841, 0x03), w8(0x4841, 0x0d), w8(0x4841, 0x02), w8(0x4840, 0x00), rtcRead(0x7e0e90));
    emit(w8(0x4840, 0x01), w8(0x4841, 0x0c), w8(0x4841, 0x04), rdn(0x4841, 0x7e0eb0, 4), rd(0x4842, 0x7e0eb4), w8(0x4840, 0x00));
  } else {
    // past $483F the chip answers only with the RTC: open bus
    emit(rd(0x4840, 0x7e0e00), rd(0x4842, 0x7e0e01));
  }
  emit(A.ldaI(0x77), A.staL(0x7e0010), A.bra(-2));
  return cartImage({ size: SIZE, hiRom: true, mapMode: 0x3a, chipset: rtc ? 0xf9 : 0xf5, romSizeByte: 0x0c, sramSizeByte: 0x01,
    name: "SPC7110 SYNTH TEST", code: c, codeAt: 0x8000, data: [[0x100000, data], [0x10000, rand(0xf0000, 5)]] });
}
export const spc7110RtcRom = () => spc7110Rom({ rtc: true });

/**
 * 65816 code that uploads the SPC700 program at CPU `progAt` (`len` bytes)
 * to ARAM $0200 through the IPL boot protocol, starts it and waits for its
 * $77 on $2141 (native mode, A 8-bit, X 16-bit), then runs `tail`.
 */
export function spcUploadCode(len, progAt, tail) {
  return [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0xa9, 0xaa, 0xcd, 0x40, 0x21, 0xd0, 0xfb,
    0xa9, 0xbb, 0xcd, 0x41, 0x21, 0xd0, 0xfb,
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21,
    0xa9, 0x01, 0x8d, 0x41, 0x21, 0xa9, 0xcc, 0x8d, 0x40, 0x21,
    0xcd, 0x40, 0x21, 0xd0, 0xfb,
    0xa2, 0x00, 0x00,
    0xbd, lo(progAt), hi(progAt), 0x8d, 0x41, 0x21, 0x8a, 0x8d, 0x40, 0x21,
    0xcd, 0x40, 0x21, 0xd0, 0xfb,
    0xe8, 0xe0, lo(len), hi(len), 0xd0, 0xeb,
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21, 0x9c, 0x41, 0x21,
    0xa9, lo(len + 1), 0x8d, 0x40, 0x21,
    0xa9, 0x77, 0xcd, 0x41, 0x21, 0xd0, 0xfb,
    ...tail,
  ];
}

/** An SPC700 program: answer $77 on $F5, then count in ARAM $10/$11 (incw $10, 6 clocks each). */
export const SPC_COUNTER = [0x8f, 0x77, 0xf5, ...Array.from({ length: 60 }, () => [0x3a, 0x10]).flat(), 0x2f, 0x100 - 122];

/**
 * The SPC7110 word-access cart: the SPC700 counts while the 65816 loops over
 * 16-bit accesses whose snes9x map types group them differently from their
 * cart block types: a $D0 data ROM read (MAP_SPC7110_ROM, byte by byte), a
 * bank $50 write (MAP_SPC7110_DRAM mapped as ROM: MAP_NONE on writes, one
 * grouped access) and HiROM SRAM at $00:6000 (MAP_HIROM_SRAM, grouped).
 * `loopAt` is the CPU address of the loop's first instruction.
 */
export function spc7110WordRom() {
  const loop = [
    ...A.ldaL(0xd00010),    // MAP_SPC7110_ROM word read
    ...A.staL(0x500000),    // MAP_SPC7110_DRAM word write (write side MAP_NONE)
    ...A.lda(0x6000),       // MAP_HIROM_SRAM word read
    ...A.sta(0x6002),       // MAP_HIROM_SRAM word write
  ];
  const code = spcUploadCode(SPC_COUNTER.length, 0x8200, [...A.rep(0x20), ...loop, ...A.bra(-(loop.length + 2))]);
  if (code.length > 0x200) throw new Error("spc7110WordRom: code overruns the program at $8200");
  const loopAt = 0x8000 + code.length - loop.length - 2;
  const rom = cartImage({ size: 0x400000, hiRom: true, mapMode: 0x3a, chipset: 0xf5, romSizeByte: 0x0c, sramSizeByte: 0x01,
    name: "SPC7110 WORD TEST", code, codeAt: 0x8000, data: [[0x8200, SPC_COUNTER], [0x100000, rand(0x1000, 7)]] });
  return { rom, loopAt };
}
