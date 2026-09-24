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
