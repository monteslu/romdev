// Genesis behaviours checked against genesis_plus_gx itself: each synthetic
// cart is built through the real build path and compared with the reference
// core frame by frame (work RAM, VRAM, CRAM, VSRAM, Z80 RAM and the 68000
// state block), see ../sms/gpgx-parity.js. Tiny synthetic ROMs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "../sms/gpgx-parity.js";

/** 68000 words -> bytes (big-endian). */
export const W = (...ws) => ws.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
export const L = (v) => W((v >>> 16) & 0xffff, v & 0xffff);

/**
 * A Genesis image: vectors (SSP $FFFE00, reset $200), a header and `code` at
 * $200. Every other exception vector points at an `rte` near the end.
 * @param {number[]} code
 * @param {{region?: string, size?: number, io?: string, at?: Array<[number, number[]]>, header?: Record<number, string|number[]>}} [o]
 */
export function mdImage(code, { region = "JUE", size = 0x10000, io = "J", at = [], header = {} } = {}) {
  const rom = new Uint8Array(size);
  rom.set(L(0x00fffe00), 0);
  rom.set(L(0x200), 4);
  const rte = size - 0x10;
  for (let v = 2; v < 64; v++) rom.set(L(rte), v * 4);
  rom.set(W(0x4e73), rte);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) rom[off + i] = s.charCodeAt(i); };
  text(0x100, "SEGA MEGA DRIVE ");
  text(0x150, "SYNTHETIC TEST CART");
  text(0x190, io.padEnd(16, " "));
  text(0x1f0, region.padEnd(16, " "));
  for (const [off, v] of Object.entries(header)) typeof v === "string" ? text(Number(off), v) : rom.set(v, Number(off));
  rom.set(code, 0x200);
  for (const [off, bytes] of at) rom.set(bytes, off);
  return rom;
}

const T = { timeout: 240000 };

/** move.b #v,abs.l / move.b abs.l,(a0)+ / move.w abs.l,(a0)+ */
const moveBImm = (v, a) => [...W(0x13fc, v & 0xff), ...L(a)];
const readB = (a) => [...W(0x10f9), ...L(a)];
const readW = (a) => [...W(0x30f9), ...L(a)];

test("a pad the header declares 6-button ('6' in \$190) answers the TH-count protocol; the second pad is read too", T, async () => {
  // TH output on both ports; once a frame, 4 x (TH=1 read, TH=0 read) on
  // each port: the 3rd low shows the 6-button signature, the 4th high
  // X/Y/Z/MODE (gpgx gamepad.c). Then wait a frame (the counter times out).
  const burst = (data) => {
    const b = [];
    for (let k = 0; k < 4; k++) b.push(...moveBImm(0x40, data), ...readB(data), ...moveBImm(0x00, data), ...readB(data));
    return b;
  };
  const head = [...moveBImm(0x40, 0xa10009), ...moveBImm(0x40, 0xa1000b)];
  const loop = [...W(0x41f9), ...L(0xff0000), ...burst(0xa10003), ...burst(0xa10005),
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x66f4),   // w1: wait until out of vblank
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x67f4)];  // w2: wait until vblank
  const prog = [...head, ...loop, ...W(0x6000, (-(loop.length + 2)) & 0xffff)];
  const input = "3:l:10,20:x:10,30:r+select:10,40:y+b:10,6:down:30,8:p2right+p2a+p2l:30,45:p2start+p2x:10";
  for (const io of ["J6", "J"]) {
    const r = await gpgxParity({ platform: "genesis", rom: mdImage(prog, { io }), input, maxFrames: 60 });
    assert.equal(r.diverged, false, `${io}: ${divergenceText(r)}`);
  }
});

test("ROM loading as gpgx's load_rom: .smd copier header and interleave, byte-swapped dumps, 64KB minimum mirror", T, async () => {
  // reads $8000 (above a 32KB ROM: $FF padding up to 64KB on gpgx) and a word of ROM
  const code = [...W(0x41f9), ...L(0xff0000), ...readB(0x8000), ...readB(0x00c000), ...readW(0x200), ...W(0x60fe)];
  const small = mdImage(code, { size: 0x8000 });
  const r0 = await gpgxParity({ platform: "genesis", rom: small, maxFrames: 3 });
  assert.equal(r0.diverged, false, `32KB: ${divergenceText(r0)}`);
  const plain = mdImage(code);
  // .smd: 512-byte header, then each 16KB block as odd bytes followed by even bytes
  const smd = new Uint8Array(512 + plain.length);
  for (let b = 0; b < plain.length; b += 0x4000) {
    for (let i = 0; i < 0x2000; i++) { smd[512 + b + i] = plain[b + i * 2 + 1]; smd[512 + b + 0x2000 + i] = plain[b + i * 2]; }
  }
  const r1 = await gpgxParity({ platform: "genesis", rom: smd, maxFrames: 3 });
  assert.equal(r1.diverged, false, `smd: ${divergenceText(r1)}`);
  const swapped = Uint8Array.from(plain, (_, i) => plain[i ^ 1]);
  const r2 = await gpgxParity({ platform: "genesis", rom: swapped, maxFrames: 3 });
  assert.equal(r2.diverged, false, `byte-swapped: ${divergenceText(r2)}`);
});

const writeB = (a, v) => [...W(0x13fc, v & 0xff), ...L(a)];
const writeW = (a, v) => [...W(0x33fc, v & 0xffff), ...L(a)];

test("backup RAM as sram_init maps it: 64KB at \$200000 by default, switched and write-protected by \$A130F1", T, async () => {
  const readB = (a) => [...W(0x10f9), ...L(a), ...W(0x5248)]; // move.b abs.l,(a0)+; addq.w #1,a0 (keep a0 even)
  const code = [...W(0x41f9), ...L(0xff0000),
    ...writeB(0x200001, 0x5a), ...writeW(0x200010, 0x1234), ...readB(0x200001), ...readW(0x200010),
    ...writeB(0xa130f1, 0), ...readW(0x200000),                      // ROM mirror back
    ...writeB(0xa130f1, 3), ...writeB(0x200001, 0x77), ...readB(0x200001),   // write-protected
    ...writeB(0xa130f1, 1), ...writeB(0x200001, 0x66), ...readB(0x200001), ...readB(0x200003),
    ...W(0x60fe)];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(code), maxFrames: 3 });
  assert.equal(r.diverged, false, `default: ${divergenceText(r)}`);
  // header "RA": odd-byte backup RAM $200001-$203FFF
  const ra = mdImage(code, { header: { 0x1b0: [0x52, 0x41, 0xf8, 0x20, ...L(0x200001), ...L(0x203fff)] } });
  const r2 = await gpgxParity({ platform: "genesis", rom: ra, maxFrames: 3 });
  assert.equal(r2.diverged, false, `header: ${divergenceText(r2)}`);
});

test("the \$A130F3-\$A130FF bank registers re-map 512KB windows (mapper_512k_w)", T, async () => {
  const size = 0x100000;
  const at = [[0x80000, [0xca, 0xfe, 0xba, 0xbe]], [0x100000 - 0x100, [0x11, 0x22]]];
  const code = [...W(0x41f9), ...L(0xff0000), ...readW(0x100000), ...writeB(0xa130f5, 1), ...readW(0x100000), ...readW(0x100002),
    ...writeB(0xa130f5, 2), ...readW(0x100000), ...W(0x60fe)];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(code, { size, at }), maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("the Z80 reads the VDP through \$7Fxx and the 68000 bus (VDP, I/O, backup RAM) through its bank", T, async () => {
  // bank = $A10000: address bits 15..23, least significant first
  const bankBits = [0, 1, 0, 0, 0, 0, 1, 0, 1];
  const z80 = [0x3a, 0x08, 0x7f, 0x32, 0x00, 0x10,      // ld a,($7F08) (V counter); ld ($1000),a
    0x3a, 0x04, 0x7f, 0x32, 0x01, 0x10,                   // ld a,($7F04) (status high); ld ($1001),a
    0x3a, 0x05, 0x7f, 0x32, 0x02, 0x10,                   // ld a,($7F05) (status low)
    ...bankBits.flatMap((b) => [0x3e, b, 0x32, 0x00, 0x60]),
    0x3a, 0x01, 0x80, 0x32, 0x03, 0x10,                   // ld a,($8001): version register
    0x3a, 0x03, 0x80, 0x32, 0x04, 0x10,                   // ld a,($8003): port A data
    0x18, 0xfe];
  const code = [...writeW(0xa11100, 0x100), ...writeW(0xa11200, 0x100),   // $200: bus request, reset released
    ...W(0x41f9), ...L(0xa00000),                                          // $210: lea $A00000,a0
    ...W(0x43fa, 0x0028),                                                  // $216: lea $240(pc),a1
    ...W(0x303c, z80.length - 1),                                          // $21A: move.w #n-1,d0
    ...W(0x10d9, 0x51c8, 0xfffc),                                          // $21E: copy loop
    ...writeW(0xa11200, 0), ...writeW(0xa11100, 0), ...writeW(0xa11200, 0x100),   // $224: reset pulse, bus back
    ...W(0x60fe)];                                                         // $23C
  const rom = mdImage(code, { at: [[0x240, z80]] });
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("a European cart runs PAL: 313 lines, the PAL V counter, the status PAL bit and V30 mode", T, async () => {
  // record the V counter peak, the status register and frame count; switch to V30 (R1 = $7C) midway
  const code = [...W(0x41f9), ...L(0xff0000), ...W(0x4280, 0x4281),          // clr.l d0; clr.l d1
    ...W(0x33fc, 0x8174), ...L(0xc00004),                                       // R1 = $74: display, V28, Mode 5
    "loop", ...W(0x3039), ...L(0xc00008), ...W(0xe048),                        // move.w $C00008,d0; lsr.w #8,d0
    ...W(0xb240, 0x6c02, 0x3200),                                               // cmp.w d0,d1; bge.s +2; move.w d0,d1
    ...W(0x33c1), ...L(0xff0000), ...W(0x33f9), ...L(0xc00004), ...L(0xff0002),
    ...W(0x5279), ...L(0xff0004),                                               // addq.w #1,$FF0004
    ...W(0x0c79, 0x2000), ...L(0xff0004), ...W(0x6608), ...W(0x33fc, 0x817c), ...L(0xc00004), "back"];
  const li = code.indexOf("loop"), bi = code.indexOf("back");
  const body = code.slice(li + 1, bi);
  const prog = [...code.slice(0, li), ...body, ...W(0x6000, (-(body.length + 2)) & 0xffff)];
  for (const region of ["E", "JUE"]) {
    const r = await gpgxParity({ platform: "genesis", rom: mdImage(prog, { region }), maxFrames: 30, picture: true });
    assert.equal(r.diverged, false, `${region}: ${divergenceText(r)}`);
  }
});
