// SMS / Game Gear behaviours checked against genesis_plus_gx itself: each
// synthetic cart is built through the real build path and compared with the
// reference core frame by frame (RAM, VRAM, CRAM, VDP registers, the Z80
// registers), see gpgx-parity.js. Tiny synthetic ROMs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "./gpgx-parity.js";

/**
 * A Master System / Game Gear image with a TMR SEGA header.
 * @param {number[]} code  bytes at $0000
 * @param {{size?: number, region?: number, at?: Array<[number, number[]]>}} [o]
 *   region: header region nibble (4 = SMS export, 3 = SMS Japan, 6 = GG export)
 */
export function smsImage(code, { size = 0x8000, region = 4, at = [] } = {}) {
  const rom = new Uint8Array(size);
  rom.set(code, 0);
  for (const [off, bytes] of at) rom.set(bytes, off);
  const hdr = 0x7FF0;
  for (const [i, ch] of [..."TMR SEGA"].entries()) rom[hdr + i] = ch.charCodeAt(0);
  rom[0x7FFF] = (region << 4) | (size >= 0x40000 ? 0x0 : size >= 0x20000 ? 0xF : size >= 0x10000 ? 0xE : 0xC);
  return rom;
}

const T = { timeout: 120000 };

test("PAUSE is an edge-triggered NMI to $0066 that keeps IFF2 for RETN", T, async () => {
  // main: di; ld sp,$DFF0; ei; loop { ld a,i; push af; pop hl; ld ($C002),hl }
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xFB, 0xED, 0x57, 0xF5, 0xE1, 0x22, 0x02, 0xC0, 0x18, 0xF7];
  // NMI: push af; ld a,i; push af; pop hl; ld ($C000),hl; ld a,($C010); inc a; ld ($C010),a; pop af; retn
  const nmi = [0xF5, 0xED, 0x57, 0xF5, 0xE1, 0x22, 0x00, 0xC0, 0x3A, 0x10, 0xC0, 0x3C, 0x32, 0x10, 0xC0, 0xF1, 0xED, 0x45];
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main, { at: [[0x66, nmi]] }), input: "10:start:5,30:start:20", maxFrames: 60 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("IM 2 takes the vector at (I << 8) | $FF; IM 0 behaves as RST $38", T, async () => {
  // di; ld sp,$DFF0; ld hl,$0200; ld ($C1FF),hl; ld a,$C1; ld i,a; im 2;
  // R1 = $A0 (frame interrupt on); ei; jr $
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0x21, 0x00, 0x02, 0x22, 0xFF, 0xC1, 0x3E, 0xC1, 0xED, 0x47, 0xED, 0x5E,
    0x3E, 0xA0, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF, 0xFB, 0x18, 0xFE];
  // $0200 (IM 2): in a,($BF); ld a,($C010); inc a; ld ($C010),a; ei; reti
  const im2 = [0xDB, 0xBF, 0x3A, 0x10, 0xC0, 0x3C, 0x32, 0x10, 0xC0, 0xFB, 0xED, 0x4D];
  // $0038 (IM 1 / IM 0): in a,($BF); ld a,($C020); inc a; ld ($C020),a; ei; reti
  const rst38 = [0xDB, 0xBF, 0x3A, 0x20, 0xC0, 0x3C, 0x32, 0x20, 0xC0, 0xFB, 0xED, 0x4D];
  const r2 = await gpgxParity({ platform: "sms", rom: smsImage(main, { at: [[0x38, rst38], [0x200, im2]] }), maxFrames: 30 });
  assert.equal(r2.diverged, false, divergenceText(r2));
  const im0 = main.slice(); im0[15] = 0x46; // im 0
  const r0 = await gpgxParity({ platform: "sms", rom: smsImage(im0, { at: [[0x38, rst38], [0x200, im2]] }), maxFrames: 30 });
  assert.equal(r0.diverged, false, divergenceText(r0));
});
