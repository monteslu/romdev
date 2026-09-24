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

test("VDP control port: the first byte updates the address LSB at once", T, async () => {
  // ctrl $00,$40 (VRAM write @0); ctrl $05 (first byte only); data $AA -> VRAM $0005 on gpgx
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xD3, 0xBF, 0x3E, 0x40, 0xD3, 0xBF,
    0x3E, 0x05, 0xD3, 0xBF, 0x3E, 0xAA, 0xD3, 0xBE, 0x18, 0xFE];
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main), maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("Game Gear CRAM: an even byte is latched and written with the odd one", T, async () => {
  // ctrl $00,$C0 (CRAM @0); data $12 (latched only); ctrl $03,$C0 (CRAM @3); data $5A (odd: writes $02-$03 from the latch)
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xD3, 0xBF, 0x3E, 0xC0, 0xD3, 0xBF, 0x3E, 0x12, 0xD3, 0xBE,
    0x3E, 0x03, 0xD3, 0xBF, 0x3E, 0xC0, 0xD3, 0xBF, 0x3E, 0x5A, 0xD3, 0xBE, 0x18, 0xFE];
  const r = await gpgxParity({ platform: "gg", rom: smsImage(main, { region: 6 }), maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("Sega mapper \$FFFC: bit 3 puts cart RAM at \$8000 (bit 2 = upper 16KB), bit 4 at \$C000", T, async () => {
  const main = [0xF3, 0x31, 0xF0, 0xDF,
    0x3E, 0x08, 0x32, 0xFC, 0xFF, // ld a,$08; ld ($FFFC),a   cart RAM (lower) at $8000
    0x3E, 0x5A, 0x32, 0x00, 0x80, // ld a,$5A; ld ($8000),a
    0x3E, 0xA5, 0x32, 0x00, 0xC1, // ld a,$A5; ld ($C100),a   still system RAM
    0x3A, 0x00, 0x80, 0x32, 0x01, 0xC1, // ld a,($8000); ld ($C101),a
    0x3E, 0x0C, 0x32, 0xFC, 0xFF, // cart RAM upper 16KB at $8000
    0x3A, 0x00, 0x80, 0x32, 0x02, 0xC1, // ld a,($8000); ld ($C102),a   ($FF: never written)
    0x3E, 0x10, 0x32, 0xFC, 0xFF, // ROM at $8000, cart RAM at $C000
    0x3E, 0x77, 0x32, 0x00, 0xC2, // ld a,$77; ld ($C200),a   -> cart RAM $0200
    0x3A, 0x00, 0xC2, 0x47,       // ld a,($C200); ld b,a
    0xAF, 0x32, 0xFC, 0xFF,       // xor a; ld ($FFFC),a      system RAM back
    0x78, 0x32, 0x03, 0xC1,       // ld a,b; ld ($C103),a
    0x3A, 0x00, 0xC2, 0x32, 0x04, 0xC1, // ld a,($C200); ld ($C104),a (system RAM, untouched)
    0x3A, 0x00, 0x80, 0x32, 0x05, 0xC1, // ld a,($8000); ld ($C105),a (ROM page 2)
    0x18, 0xFE];
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main, { size: 0x10000, at: [[0x8000, [0x42]]] }), maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("Sega mapper \$FFFD pages slot 0 above its first 1KB (code runs from the paged bank); \$FFFC bits 0-1 shift the page", T, async () => {
  const size = 0x80000;
  // bank k holds k+$10 at $0510 and, at $0500, `ld a,k+$20; ld ($C120),a; ret`
  const at = [];
  for (let k = 0; k < size / 0x4000; k++) at.push([k * 0x4000 + 0x510, [k + 0x10]], [k * 0x4000 + 0x500, [0x3E, k + 0x20, 0x32, 0x20, 0xC1, 0xC9]]);
  const main = [0xF3, 0x31, 0xF0, 0xDF,
    0x3E, 0x03, 0x32, 0xFD, 0xFF, // ld a,3; ld ($FFFD),a
    0x3A, 0x10, 0x05, 0x32, 0x10, 0xC1, // ld a,($0510); ld ($C110),a
    0xCD, 0x00, 0x05,             // call $0500 (bank 3's routine)
    0x3A, 0x10, 0x81, 0x32, 0x11, 0xC1, // ld a,($8110); ld ($C111),a (page 2)
    0x3E, 0x01, 0x32, 0xFC, 0xFF, // ld a,1; ld ($FFFC),a    shift: page 2 + 24
    0x3A, 0x10, 0x85, 0x32, 0x12, 0xC1, // ld a,($8510); ld ($C112),a
    0xAF, 0x32, 0xFD, 0xFF,       // xor a; ld ($FFFD),a (with the shift: page 24)
    0x3A, 0x10, 0x05, 0x32, 0x13, 0xC1, // ld a,($0510); ld ($C113),a
    0x18, 0xFE];
  const rom = smsImage([], { size, at });
  rom.set(main, 0);
  const r = await gpgxParity({ platform: "sms", rom, maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("a cart of 48KB or less has no mapper: \$FFFC-\$FFFF are plain RAM and \$8000-\$BFFF reads open bus up to 32KB", T, async () => {
  const main = [0xF3, 0x31, 0xF0, 0xDF,
    0x3E, 0x01, 0x32, 0xFF, 0xFF, // ld a,1; ld ($FFFF),a (RAM only)
    0x3A, 0x00, 0x80, 0x32, 0x00, 0xC1, // ld a,($8000); ld ($C100),a
    0x3A, 0x00, 0x40, 0x32, 0x01, 0xC1, // ld a,($4000); ld ($C101),a
    0x18, 0xFE];
  const r32 = await gpgxParity({ platform: "sms", rom: smsImage(main, { size: 0x8000, at: [[0x4000, [0x44]]] }), maxFrames: 5 });
  assert.equal(r32.diverged, false, divergenceText(r32));
  const r16 = await gpgxParity({ platform: "sms", rom: smsImage(main, { size: 0x8000 }).subarray(0, 0x4000).map((b, i, a) => b), maxFrames: 5 });
  assert.equal(r16.diverged, false, divergenceText(r16));
});
