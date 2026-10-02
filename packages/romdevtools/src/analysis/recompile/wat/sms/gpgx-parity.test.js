// SMS / Game Gear behaviours checked against genesis_plus_gx itself: each
// synthetic cart is built through the real build path and compared with the
// reference core frame by frame (RAM, VRAM, CRAM, VDP registers, the Z80
// registers), see gpgx-parity.js. Tiny synthetic ROMs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText, forgeCrc32 } from "./gpgx-parity.js";

/**
 * A few-line Z80 assembler for the test programs: each item is a byte array,
 * a label string ("name:"), or ["jr", cond|null, "label"] / ["djnz", "label"]
 * / ["jp", "label"] / ["call", "label"].
 */
function z80(items, org = 0) {
  const labels = {}, fix = [];
  const out = [];
  for (const it of items) {
    if (typeof it === "string") { labels[it.replace(/:$/, "")] = org + out.length; continue; }
    if (Array.isArray(it) && typeof it[0] === "string") {
      const [op, a, b] = it;
      if (op === "jr") { out.push(a ? { nz: 0x20, z: 0x28, nc: 0x30, c: 0x38 }[a] : 0x18, 0); fix.push([out.length - 1, b, "rel"]); }
      else if (op === "djnz") { out.push(0x10, 0); fix.push([out.length - 1, a, "rel"]); }
      else if (op === "jp" || op === "call") { out.push(op === "jp" ? 0xC3 : 0xCD, 0, 0); fix.push([out.length - 2, a, "abs"]); }
      continue;
    }
    out.push(...it);
  }
  for (const [at, l, kind] of fix) {
    if (!(l in labels)) throw new Error(`label ${l}`);
    if (kind === "rel") out[at] = (labels[l] - (org + at + 1)) & 0xFF;
    else { out[at] = labels[l] & 0xFF; out[at + 1] = labels[l] >> 8; }
  }
  return out;
}

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

test("the H counter reads the value a TH low-to-high write latched (0 from power-on); TH/TR read back only as outputs", T, async () => {
  const main = z80([
    [0xF3, 0x31, 0xF0, 0xDF],
    [0xDB, 0x7F, 0x32, 0x00, 0xC1],   // in a,($7F); ld ($C100),a   (latched 0 since reset)
    [0xDB, 0xDD, 0x32, 0x01, 0xC1],   // in a,($DD)                 (TH/TR inputs)
    [0x3E, 0x55, 0xD3, 0x3F],         // TH/TR outputs, low
    [0xDB, 0xDD, 0x32, 0x02, 0xC1, 0xDB, 0xDC, 0x32, 0x03, 0xC1],
    [0x00, 0x00, 0x00],
    [0x3E, 0xF5, 0xD3, 0x3F],         // TH high: latch
    [0xDB, 0x7F, 0x32, 0x04, 0xC1, 0x00, 0xDB, 0x7F, 0x32, 0x05, 0xC1],
    [0xDB, 0xDD, 0x32, 0x06, 0xC1],
    [0x3E, 0x0F, 0xD3, 0x3F],         // inputs again, levels low: reads the pad's (high) TH
    [0xDB, 0xDD, 0x32, 0x07, 0xC1],
    "loop:", [0xDB, 0x7F, 0x32, 0x08, 0xC1], ["jr", null, "loop"]]);
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main), maxFrames: 10 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("a Japanese console decodes the I/O ports by address, has the FM control register at \$F2 and masks TH/TR outputs", T, async () => {
  const main = z80([
    [0xF3, 0x31, 0xF0, 0xDF],
    [0x3E, 0x01, 0xD3, 0xF2, 0xDB, 0xF2, 0x32, 0x00, 0xC1],   // out ($F2),1; in a,($F2)
    [0xDB, 0xC2, 0x32, 0x01, 0xC1],                            // $C2: not decoded on a Japanese console
    [0xDB, 0xC0, 0x32, 0x02, 0xC1, 0xDB, 0xC1, 0x32, 0x03, 0xC1],
    [0x3E, 0xF5, 0xD3, 0x3F, 0xDB, 0xDD, 0x32, 0x04, 0xC1],   // TH outputs high read 0 here
    ["jr", null, "end"], "end:", [0x18, 0xFE]]);
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main, { region: 3 }), maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("a PAL cart from gpgx's database runs 313 lines with the V counter folded at \$F2", T, async () => {
  const main = z80([
    [0xF3, 0x31, 0xF0, 0xDF, 0xED, 0x56],                     // di; ld sp; im 1
    [0x3E, 0xA0, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF, 0xFB],   // R1 = $A0 (frame interrupt); ei
    "loop:", [0xDB, 0x7E, 0x47, 0x3A, 0x20, 0xC0, 0xB8],     // in a,($7E); ld b,a; ld a,($C020); cp b
    ["jr", "nc", "loop"], [0x78, 0x32, 0x20, 0xC0], ["jr", null, "loop"]]);
  const rom = smsImage(main, { size: 0x10000, at: [[0x38, [0xF5, 0xDB, 0xBF, 0x2A, 0x10, 0xC0, 0x23, 0x22, 0x10, 0xC0, 0xDB, 0x7E, 0x32, 0x12, 0xC0, 0xF1, 0xFB, 0xED, 0x4D]]] });
  // CRC of a European entry (MAPPER_SEGA, SYSTEM_SMS2, REGION_EUROPE) in gpgx's database
  const pal = await forgeCrc32(rom, 0x4000, 0xD6F2BFCA);
  const r = await gpgxParity({ platform: "sms", rom: pal, maxFrames: 20 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("vertical scroll is latched once a frame: an R9 write mid-frame shows from the next frame", T, async () => {
  const main = z80([
    [0xF3, 0x31, 0xF0, 0xDF, 0xED, 0x56],
    [0x3E, 0x20, 0xD3, 0xBF, 0x3E, 0x40, 0xD3, 0xBF, 0x06, 0x20, 0x3E, 0xFF], "t1:", [0xD3, 0xBE], ["djnz", "t1"],   // tile 1: colour 15
    [0xAF, 0xD3, 0xBF, 0x3E, 0x78, 0xD3, 0xBF, 0x0E, 0x1C],                                                        // name table @ $3800, 28 rows
    "row:", [0x79, 0xE6, 0x01, 0x5F, 0x06, 0x20], "col:", [0x7B, 0xD3, 0xBE, 0xAF, 0xD3, 0xBE], ["djnz", "col"], [0x0D], ["jr", "nz", "row"],
    [0x3E, 0x0F, 0xD3, 0xBF, 0x3E, 0xC0, 0xD3, 0xBF, 0x3E, 0x3F, 0xD3, 0xBE],                                    // CRAM 15 = white
    [0x3E, 0xE0, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF, 0xFB],                                                        // display + frame interrupt
    "main:", [0x76], "wv:", [0xDB, 0x7E, 0xFE, 0x64], ["jr", "nz", "wv"],                                           // wait for line 100
    [0x3A, 0x30, 0xC0, 0xC6, 0x08, 0x32, 0x30, 0xC0, 0xD3, 0xBF, 0x3E, 0x89, 0xD3, 0xBF], ["jr", null, "main"]], 0x100);  // R9 += 8
  const rom = smsImage([0xC3, 0x00, 0x01], { at: [[0x38, [0xF5, 0xDB, 0xBF, 0xF1, 0xFB, 0xED, 0x4D]], [0x100, main]] });
  const r = await gpgxParity({ platform: "sms", rom, maxFrames: 12, picture: true });
  assert.equal(r.diverged, false, divergenceText(r));
  assert.equal(r.picture.status, "OK", JSON.stringify(r.picture));
  assert.equal(r.picture.exactPct, 100, JSON.stringify(r.picture));
});

test("BIT n,(HL) copies the high byte of WZ (MEMPTR) into F bits 5 and 3, WZ set as gpgx sets it", T, async () => {
  const B = [0xCB, 0x46, 0xF5]; // bit 0,(hl); push af
  const HL = [0x21, 0x00, 0xC2]; // ld hl,$C200
  const main = z80([
    [0xF3, 0x31, 0xF0, 0xDF, 0x21, 0x00, 0xC2, 0x36, 0x81],             // di; ld sp; ld hl,$C200; ld (hl),$81
    [0x3A, 0x00, 0x2A], B,                                                // ld a,($2A00)
    [0x3E, 0x5A, 0x32, 0x34, 0x12], B,                                    // ld ($1234),a
    [0x01, 0x00, 0x3F, 0x0A], B,                                          // ld bc,$3F00; ld a,(bc)
    [0x11, 0x00, 0x08, 0x12], B,                                          // ld de,$0800; ld (de),a
    ["jp", "s5"], "s5:", B,
    ["jr", null, "s6"], "s6:", B,
    ["call", "sub"], B,
    [0x21, 0x00, 0x28, 0x11, 0x08, 0x08, 0x19], HL, B,                    // add hl,de
    [0xDB, 0x7E], B,                                                      // in a,($7E)
    [0x3E, 0x9F, 0xD3, 0x7F], B,                                          // out ($7F),a
    [0xDD, 0x21, 0x00, 0xC3, 0xDD, 0x77, 0x05], B,                        // ld (ix+5),a
    [0xED, 0x5B, 0x00, 0x10], B,                                          // ld de,($1000)
    [0xED, 0x6F], B,                                                      // rld
    [0xED, 0xA1], HL, B,                                                  // cpi
    [0x11, 0x10, 0xC2, 0x01, 0x02, 0x00, 0xED, 0xB0], HL, B,              // ldir x2
    [0xEF], B,                                                            // rst $28
    [0xE3, 0xE3], B,                                                      // ex (sp),hl x2
    [0x06, 0x02], "dj:", ["djnz", "dj"], B,                              // djnz taken once
    "end:", ["jr", null, "end"],
    "sub:", [0xC9]], 0x100);
  const rom = smsImage([0xC3, 0x00, 0x01], { at: [[0x28, [0xC9]], [0x100, main]] });
  const r = await gpgxParity({ platform: "sms", rom, maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("the second pad reads on \$DC bits 6-7 and \$DD bits 0-3", T, async () => {
  const main = z80([[0xF3, 0x31, 0xF0, 0xDF], "loop:", [0xDB, 0xDC, 0x32, 0x00, 0xC1, 0xDB, 0xDD, 0x32, 0x01, 0xC1], ["jr", null, "loop"]]);
  const r = await gpgxParity({ platform: "sms", rom: smsImage(main), maxFrames: 12, input: "1:p2up+p2left+p2b:4,6:p2down+p2right+p2a:4" });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("the 224- and 240-line modes: height, V counter, name table at \$3700 with a 256-line wrap, sprites", T, async () => {
  const prog = (r1, gg, r0) => z80([
    [0xF3, 0x31, 0xF0, 0xDF, 0xED, 0x56],
    [0x3E, 0x20, 0xD3, 0xBF, 0x3E, 0x40, 0xD3, 0xBF, 0x06, 0x20, 0x3E, 0xFF], "t1:", [0xD3, 0xBE], ["djnz", "t1"],   // tile 1
    [0xAF, 0xD3, 0xBF, 0x3E, 0x77, 0xD3, 0xBF, 0x0E, 0x20],                                                        // $3700: 32 rows
    "row:", [0x79, 0xE6, 0x03, 0x5F, 0x06, 0x20], "col:", [0x7B, 0xD3, 0xBE, 0xAF, 0xD3, 0xBE], ["djnz", "col"], [0x0D], ["jr", "nz", "row"],
    gg ? [0x3E, 0x1E, 0xD3, 0xBF, 0x3E, 0xC0, 0xD3, 0xBF, 0x3E, 0xFF, 0xD3, 0xBE, 0x3E, 0x0F, 0xD3, 0xBE]        // GG colour 15 = white
      : [0x3E, 0x0F, 0xD3, 0xBF, 0x3E, 0xC0, 0xD3, 0xBF, 0x3E, 0x3F, 0xD3, 0xBE],                                // CRAM 15 = white
    [0x3E, 0x00, 0xD3, 0xBF, 0x3E, 0x7F, 0xD3, 0xBF, 0x3E, 0xC8, 0xD3, 0xBE, 0x3E, 0xD0, 0xD3, 0xBE],              // SAT: y 200, then 208
    [0x3E, 0x80, 0xD3, 0xBF, 0x3E, 0x7F, 0xD3, 0xBF, 0x3E, 0x40, 0xD3, 0xBE, 0x3E, 0x01, 0xD3, 0xBE],              // x 64, tile 1
    r0 ? [0x3E, r0, 0xD3, 0xBF, 0x3E, 0x80, 0xD3, 0xBF] : [],   // R0: the GG powers on with R0 = 0 (not Mode 4)
    [0x3E, r1, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF, 0xFB],
    "main:", [0xDB, 0x7E, 0x47, 0x3A, 0x20, 0xC0, 0xB8], ["jr", "nc", "main"], [0x78, 0x32, 0x20, 0xC0],
    [0x3A, 0x21, 0xC0, 0x3C, 0x32, 0x21, 0xC0, 0xD3, 0xBF, 0x3E, 0x89, 0xD3, 0xBF], ["jr", null, "main"]], 0x100);   // R9 scrolls
  // an R0 write in the same frame as the mode change: gpgx's libretro frontend
  // drops the pending height change (the 192-line picture stays)
  for (const [platform, r1, r0] of [["sms", 0xF0, 0], ["sms", 0xE8, 0], ["sms", 0xF0, 0x06], ["gg", 0xF0, 0x06]]) {
    const rom = smsImage([0xC3, 0x00, 0x01], { region: platform === "gg" ? 6 : 4, at: [[0x38, [0xF5, 0xDB, 0xBF, 0xF1, 0xFB, 0xED, 0x4D]], [0x100, prog(r1, platform === "gg", r0)]] });
    const r = await gpgxParity({ platform, rom, maxFrames: 8, picture: true });
    assert.equal(r.diverged, false, `${platform} R0=${r0} R1=${r1.toString(16)}: ${divergenceText(r)}`);
    assert.equal(r.picture.status, "OK", JSON.stringify(r.picture));
    assert.equal(r.picture.exactPct, 100, `${platform} R1=${r1.toString(16)}: ${JSON.stringify(r.picture)}`);
  }
});

// ---- VDP picture helpers for the renderer tests (display on, no interrupts) ----
const vaddr = (a, code = 1) => [0x3E, a & 0xFF, 0xD3, 0xBF, 0x3E, ((a >> 8) & 0x3F) | (code << 6), 0xD3, 0xBF];
const vreg = (r, v) => [0x3E, v, 0xD3, 0xBF, 0x3E, 0x80 | r, 0xD3, 0xBF];
const outA = (v) => [0x3E, v, 0xD3, 0xBE];
/** 8 rows of the same 4 bitplane bytes (a Mode 4 tile) at VRAM `at`. */
const tile4 = (at, p, lbl) => [vaddr(at), [0x06, 0x08], `${lbl}:`, [...outA(p[0]), ...outA(p[1]), ...outA(p[2]), ...outA(p[3])], ["djnz", lbl]];

test("315-5124 (SMS1) VDP: R3/R4 mask the tile index per bitplane pair, R6 bits 0-1 mask sprite patterns, only the first sprites zoom", T, async () => {
  // BG tile $61 everywhere. On the 315-5124, bitplanes 0-1 come from tile
  // $61 & (1 | R3 << 1) and 2-3 from $61 & ($3F | (R4 & 7) << 6); a sprite's
  // pattern is (tile | $100) & (~$1C0 ^ R6 << 6). With zoom (R1 bit 0) only
  // all but the last four sprites of a line are doubled.
  const prog = z80([
    [0xF3, 0x31, 0xF0, 0xDF],
    ...tile4(0x0020, [0xFF, 0, 0, 0], "a"), ...tile4(0x0420, [0, 0, 0xFF, 0], "b"), ...tile4(0x0C20, [0xFF, 0xFF, 0xFF, 0xFF], "c"),
    ...tile4(0x20A0, [0xFF, 0xFF, 0, 0], "d"), ...tile4(0x38A0, [0xFF, 0xFF, 0xFF, 0xFF], "e"),
    vaddr(0x3800), [0x0E, 0x1C], "row:", [0x06, 0x20], "col:", [...outA(0x61), 0xAF, 0xD3, 0xBE], ["djnz", "col"], [0x0D], ["jr", "nz", "row"],
    vaddr(0, 3), [0x06, 0x20, 0xAF], "cr:", [0xD3, 0xBE, 0xC6, 0x04, 0xE6, 0x3F], ["djnz", "cr"],
    vaddr(0x3F00), outA(50), outA(50), outA(50), outA(50), outA(50), outA(208),
    vaddr(0x3F80), ...[20, 60, 100, 140, 180].map((x) => [...outA(x), ...outA(0xC5)]),
    vreg(3, 0x00), vreg(4, 0xF8), vreg(6, 0xFC), vreg(1, 0xC1),
    "end:", ["jr", null, "end"]], 0x100);
  const rom = smsImage([0xC3, 0x00, 0x01], { at: [[0x100, prog]] });
  // a USA SYSTEM_SMS (315-5124) entry of gpgx's database, and the same cart as
  // an unlisted one (315-5246: no masking, every sprite zoomed)
  for (const img of [await forgeCrc32(rom, 0x4000, 0x1C951F8E), rom]) {
    const r = await gpgxParity({ platform: "sms", rom: img, maxFrames: 4, picture: true });
    assert.equal(r.diverged, false, divergenceText(r));
    assert.equal(r.picture.status, "OK", JSON.stringify(r.picture));
    assert.equal(r.picture.exactPct, 100, JSON.stringify(r.picture));
  }
});

test("TMS9918 modes (Graphics I/II, Text, Multicolor, extended tables, invalid) and TMS sprites, on the SMS and the GG", T, async () => {
  // Fill VRAM with an address-derived pattern (every table the mode picks has
  // content), write CRAM, then show the mode. Sprites: four on one line plus a
  // fifth (overflow, fifth-sprite number), an early-clock one, 16x16, zoom,
  // and overlapping ones (collision).
  const sat = [[40, 20, 1, 0x0F], [40, 28, 2, 0x06], [40, 60, 3, 0x8A], [40, 100, 4, 0x03], [40, 140, 5, 0x0C], [90, 250, 6, 0x05], [0xD0, 0, 0, 0]];
  const prog = (r0, r1, gg) => z80([
    [0xF3, 0x31, 0xF0, 0xDF],
    vaddr(0), [0x21, 0x00, 0x00, 0x01, 0x00, 0x40], "fill:", [0x7D, 0xAC, 0xD3, 0xBE, 0x23, 0x0B, 0x78, 0xB1], ["jr", "nz", "fill"],   // VRAM[a] = lo ^ hi
    vaddr(0x1B00), ...sat.map((e) => e.flatMap((b) => outA(b))),
    vaddr(0, 3), [0x06, gg ? 0x40 : 0x20, 0xAF], "cr:", [0xD3, 0xBE, 0xC6, 0x07], ["djnz", "cr"],
    vreg(2, 0x06), vreg(3, 0xFF), vreg(4, 0x03), vreg(5, 0x36), vreg(6, 0x07), vreg(7, 0xF4),
    vreg(0, r0), vreg(1, r1),
    // poll the status: the last value and every flag seen (overflow, collision, fifth-sprite number)
    "end:", [0xDB, 0xBF, 0x32, 0x10, 0xC0, 0x47, 0x3A, 0x11, 0xC0, 0xB0, 0x32, 0x11, 0xC0], ["jr", null, "end"]], 0x100);
  // [R0, R1]: G1, G1 16x16 zoom, G2, Text, Text + extended PG, Multicolor, Multicolor + ext, invalid, left column blank, display off
  const modes = [[0x00, 0xC0], [0x00, 0xC3], [0x02, 0xC2], [0x00, 0xD0], [0x02, 0xD0], [0x00, 0xC8], [0x02, 0xC9], [0x00, 0xD8], [0x22, 0xC0], [0x00, 0x80]];
  for (const platform of ["sms", "gg"]) {
    for (const [r0, r1] of modes) {
      const rom = smsImage([0xC3, 0x00, 0x01], { region: platform === "gg" ? 6 : 4, at: [[0x100, prog(r0, r1, platform === "gg")]] });
      const r = await gpgxParity({ platform, rom, maxFrames: 20, picture: true });   // the VRAM fill takes ~14 frames
      const what = `${platform} R0=${r0.toString(16)} R1=${r1.toString(16)}`;
      assert.equal(r.diverged, false, `${what}: ${divergenceText(r)}`);
      // display off: the whole picture is the backdrop (no content to score, every pixel still compared)
      if (r1 & 0x40) assert.equal(r.picture.status, "OK", `${what}: ${JSON.stringify(r.picture)}`);
      assert.equal(r.picture.exactPct, 100, `${what}: ${JSON.stringify(r.picture)}`);
    }
  }
});

test("a Game Gear cart gpgx runs in Master System mode (SYSTEM_GGMS): SMS CRAM and colours, 256x192, no GG registers, START is PAUSE", T, async () => {
  const prog = (r0) => z80([
    [0xF3, 0x31, 0xF0, 0xDF, 0xED, 0x56],
    [0xDB, 0x00, 0x32, 0x00, 0xC0, 0xDB, 0x01, 0x32, 0x01, 0xC0, 0xDB, 0x05, 0x32, 0x02, 0xC0, 0x3E, 0x55, 0xD3, 0x06],   // $00/$01/$05 reads, a $06 write
    ...tile4(0x0020, [0xFF, 0x0F, 0xF0, 0x3C], "a"),
    vaddr(0x3800), [0x0E, 0x1C], "row:", [0x06, 0x20], "col:", [0x78, 0xD3, 0xBE, 0xAF, 0xD3, 0xBE], ["djnz", "col"], [0x0D], ["jr", "nz", "row"],
    vaddr(0x0000), [0x06, 0x00], "g1:", [0x78, 0xD3, 0xBE], ["djnz", "g1"],     // Graphics I tables at $0000 (colour/pattern bytes)
    vaddr(0, 3), [0x06, 0x20, 0xAF], "cr:", [0xD3, 0xBE, 0xC6, 0x03, 0xE6, 0x3F], ["djnz", "cr"],   // SMS CRAM: 32 single bytes
    vreg(2, 0x0E), vreg(3, 0x00), vreg(4, 0x00), vreg(7, 0x03), vreg(0, r0), vreg(1, 0xC0),
    "end:", ["jr", null, "end"]], 0x100);
  for (const r0 of [0x06, 0x00]) {   // Mode 4, and the TMS Graphics I mode the GG powers on in
    const rom = smsImage([0xC3, 0x00, 0x01], { region: 6, at: [[0x66, [0xF5, 0x3A, 0x20, 0xC0, 0x3C, 0x32, 0x20, 0xC0, 0xF1, 0xED, 0x45]], [0x100, prog(r0)]] });
    // a USA SYSTEM_GGMS / MAPPER_SEGA entry of gpgx's database
    const img = await forgeCrc32(rom, 0x4000, 0x59840FD6);
    const r = await gpgxParity({ platform: "gg", rom: img, maxFrames: 12, input: "4:start:2,8:start:2", picture: true });
    assert.equal(r.diverged, false, `R0=${r0}: ${divergenceText(r)}`);
    assert.equal(r.picture.status, "OK", `R0=${r0}: ${JSON.stringify(r.picture)}`);
    assert.equal(r.picture.exactPct, 100, `R0=${r0}: ${JSON.stringify(r.picture)}`);
  }
});

test("the Korean 16K v2 mapper: $4000 / $8000 page slots 1 / 2, SEGA registers without the page increment or the fixed first 1KB", T, async () => {
  const st = (a) => [0x32, a & 0xFF, a >> 8];          // ld (a),a
  const ld = (a) => [0x3A, a & 0xFF, a >> 8];          // ld a,(a)
  const w = (addr, v) => [0x3E, v, ...st(addr)];
  let n = 0;
  const probe = (addr) => [...ld(addr), ...st(0xC000 + n++)];
  const prog = z80([
    [0xF3, 0x31, 0xF0, 0xDF],
    probe(0x3F00), probe(0x7F00), probe(0xBF00), probe(0x0010),       // power-on pages
    w(0x8000, 3), probe(0xBF00),                                       // $8000 pages slot 2
    w(0x4000, 2), probe(0x7F00),                                       // $4000 pages slot 1
    w(0xFFFD, 1), probe(0x3F00), probe(0x0010),                        // slot 0, its first 1KB too
    w(0xFFFE, 2), probe(0x7F00), w(0xFFFF, 1), probe(0xBF00),
    w(0xFFFC, 0x01), w(0xFFFF, 1), probe(0xBF00),                      // no SEGA page increment
    w(0xFFFC, 0x08), w(0x8001, 0x5A), probe(0x8001), w(0xFFFC, 0x00), probe(0xBF00),   // cart RAM at $8000
    "end:", ["jr", null, "end"]], 0x100);
  const rom = new Uint8Array(0x40000);
  for (let k = 0; k < 16; k++) {
    rom.set([0xC3, 0x00, 0x01], k * 0x4000);
    rom.set(prog, k * 0x4000 + 0x100);
    rom[k * 0x4000 + 0x10] = 0x20 + k;
    rom[k * 0x4000 + 0x3F00] = 0x40 + k;
  }
  const img = smsImage([], { size: 0x40000, region: 6, at: [[0, rom.subarray(0, 0x7FF0)], [0x8000, rom.subarray(0x8000)]] });
  // a USA SYSTEM_GGMS / MAPPER_KOREA_16K_V2 entry of gpgx's database
  const r = await gpgxParity({ platform: "gg", rom: await forgeCrc32(img, 0x3F80, 0x01A2D595), maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("VDP R1 bit 2 (the Mega Drive's Mode 5 select) is cleared when written on SMS / GG VDPs", T, async () => {
  // di; ld sp,$DFF0; R1 = $E4 (bit 2 set); ld a,1; ld ($C000),a; R1 = $AE; jr $
  // gpgx vdp_reg_w clears R1 bit 2 outside Mega Drive hardware, so R1 reads $E0 then $AA.
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0x3E, 0xE4, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF,
    0x3E, 0x01, 0x32, 0x00, 0xC0, 0x3E, 0xAE, 0xD3, 0xBF, 0x3E, 0x81, 0xD3, 0xBF, 0x18, 0xFE];
  for (const [platform, region] of [["sms", 4], ["gg", 6]]) {
    const r = await gpgxParity({ platform, rom: smsImage(main, { region }), maxFrames: 5 });
    assert.equal(r.diverged, false, `${platform}: ${divergenceText(r)}`);
  }
});
