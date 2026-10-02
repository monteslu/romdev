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

test("code the game builds in work RAM at run time is found by running the reference (guarded per encoding)", T, async () => {
  // each frame: write `moveq #(n & 3),d1; move.w d1,$FF0020; rts` to $FFE000 and call it
  const loop = [
    ...W(0x5279), ...L(0xff0010),                       // addq.w #1,$FF0010
    ...W(0x3039), ...L(0xff0010), ...W(0x0240, 3),      // move.w $FF0010,d0; andi.w #3,d0
    ...W(0x0040, 0x7200),                               // ori.w #$7200,d0  (moveq #n,d1)
    ...W(0x33c0), ...L(0xffe000),                       // move.w d0,$FFE000
    ...writeW(0xffe002, 0x33c1), ...writeW(0xffe004, 0x00ff), ...writeW(0xffe006, 0x0020), ...writeW(0xffe008, 0x4e75),
    ...W(0x4eb9), ...L(0xffe000),                       // jsr $FFE000
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x66f4),
    ...W(0x3039), ...L(0xc00004), ...W(0x0800, 3, 0x67f4)];
  const prog = [...loop, ...W(0x6000, (-(loop.length + 2)) & 0xffff)];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(prog), maxFrames: 40 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("address errors: an odd word/long access takes vector 3 with gpgx's bus-error frame; a second one before rte halts", T, async () => {
  // faults: postincrement read, predecrement write, abs.l read (pc past the
  // extension words), movem, one inside the vblank handler (instruction bit
  // of the frame set), one in user mode, then one in the handler (halt)
  const main = [
    ...W(0x41f9), ...L(0xff0001), ...W(0x3018),            // lea $FF0001,a0; move.w (a0)+,d0
    ...W(0x43f9), ...L(0xff0011), ...W(0x2301),            // lea $FF0011,a1; move.l d1,-(a1)
    ...W(0x3439), ...L(0xff0103),                          // move.w $FF0103,d2
    ...W(0x45f9), ...L(0xff0021), ...W(0x48d2, 0x000f),    // lea $FF0021,a2; movem.l d0-d3,(a2)
    ...W(0x33fc, 0x8004), ...L(0xc00004), ...W(0x33fc, 0x8164), ...L(0xc00004),
    ...W(0x46fc, 0x2000),                                  // interrupts on
    ...W(0x0c87), ...L(5), ...W(0x66f8),                   // wait for the vblank fault
    ...W(0x267c), ...L(0xff8000), ...W(0x4e63, 0x027c, 0xdfff), // usp; user mode
    ...W(0x3839), ...L(0xff0005),                          // user-mode fault
    ...W(0x3839), ...L(0xff0007),                          // the handler faults again: halt
    ...W(0x60fe),
  ];
  const vint = [...W(0x4a39), ...L(0xff0100), ...W(0x660c, 0x50f9), ...L(0xff0100), ...W(0x3639), ...L(0xff0009), ...W(0x4e73)];
  const aeh = [...W(0x5287, 0x0c87), ...L(7), ...W(0x6d06, 0x3839), ...L(0xff000b), ...W(0x508f, 0x4e73)];
  const rom = mdImage(main, { at: [[0x0c, L(0x380)], [0x78, L(0x300)], [0x300, vint], [0x380, aeh]] });
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 12 });
  assert.equal(r.diverged, false, divergenceText(r));
});

/**
 * Bit-banged I2C on one EEPROM board, one line change per bus write: a page
 * write that wraps at the chip's page size, then a random read of the page
 * back into work RAM ($FF0000+, one bus read per bit and per ack).
 * @param {{set:(sda:number, scl:number, which:'sda'|'scl')=>number[], read:number[], bits:number, pre?:number[]}} b
 */
function i2cProgram(b, addr, page, data) {
  const out = [...W(0x41f9), ...L(0xff0000), ...(b.pre || [])];
  let sda = 1, scl = 1;
  const line = (which, v) => { if (which === "sda") sda = v; else scl = v; out.push(...b.set(sda, scl, which)); };
  const start = () => { if (!sda) { line("scl", 0); line("sda", 1); } if (!scl) line("scl", 1); line("sda", 0); line("scl", 0); };
  const stop = () => { line("scl", 0); line("sda", 0); line("scl", 1); line("sda", 1); };
  const byte = (v) => {
    for (let i = 7; i >= 0; i--) { line("sda", (v >> i) & 1); line("scl", 1); line("scl", 0); }
    line("sda", 1); line("scl", 1); out.push(...b.read); line("scl", 0); // slave ack
  };
  const readByte = (last) => {
    line("sda", 1);
    for (let i = 0; i < 8; i++) { line("scl", 1); out.push(...b.read); line("scl", 0); }
    line("sda", last ? 1 : 0); line("scl", 1); line("scl", 0);
  };
  const header = (rw, a) => {
    if (b.bits === 7) byte(((a & 0x7f) << 1) | rw);
    else if (b.bits === 8) byte(0xa0 | (((a >> 8) & 7) << 1) | rw);
    else byte(0xa0 | rw);
  };
  const address = (a) => { if (b.bits === 16) byte((a >> 8) & 0xff); if (b.bits !== 7) byte(a & 0xff); };
  start(); header(0, addr); address(addr);
  for (const d of data) byte(d);
  stop();
  const base = addr & ~page;
  start();
  if (b.bits !== 7) { header(0, base); address(base); start(); }
  header(1, base);
  for (let i = 0; i <= page; i++) readByte(i === page);
  stop();
  out.push(...W(0x60fe));
  return out;
}

test("serial EEPROM boards (eeprom_i2c.c): EA, SEGA, Acclaim 16M/32M and Codemasters wirings, 7-, 8- and 16-bit addressing, page wrap", T, async () => {
  const mb = (v, a) => [...W(0x13fc, v), ...L(a)];
  const mw = (v, a) => [...W(0x33fc, v), ...L(a)];
  const boards = [
    { product: "T-50176 -00", bits: 7, page: 3, set: (d, c) => mb((c << 6) | (d << 7), 0x200001), read: [...W(0x10f9), ...L(0x200001)] },
    { product: "MK-1215 -00", bits: 7, page: 3, set: (d, c) => mb((c << 1) | d, 0x200001), read: [...W(0x10f9), ...L(0x200001)] },
    { product: "T-081326 00", bits: 8, page: 3, set: (d, c) => mw((c << 1) | d, 0x200000), read: [...W(0x30f9), ...L(0x200000)] },
    { product: "T-81476 -00", bits: 16, page: 0x3f, set: (d, c, w) => (w === "sda" ? mb(d, 0x200001) : mb(c, 0x200000)),
      read: [...W(0x30f9), ...L(0x200000)], pre: mw(0, 0x200000) },
    { product: "T-120106-50", bits: 8, page: 15, set: (d, c) => mw((c << 1) | d, 0x300000), read: [...W(0x10f9), ...L(0x380001)] },
  ];
  for (const b of boards) {
    const addr = b.bits === 16 ? 0x1234 & ~b.page | (b.page - 1) : b.bits === 8 ? 0x2f5 & ~b.page | (b.page - 1) : 0x46 & ~b.page | (b.page - 1);
    const rom = mdImage(i2cProgram(b, addr, b.page, [0x5a, 0xc3, 0x81]), { header: { 0x182: b.product } });
    const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 4 });
    assert.equal(r.diverged, false, `${b.product}: ${divergenceText(r)}`);
  }
});

test("code run from a re-based bank (mapper_512k_w) and from backup RAM runs what the reference ran there", T, async () => {
  const main = [
    ...W(0x41fa, 0x00fe), ...W(0x43f9), ...L(0x200000), ...W(0x7003, 0x32d8, 0x51c8, 0xfffc), // copy R to backup RAM
    ...W(0x4eb9), ...L(0x200000),                                              // jsr $200000
    ...W(0x13fc, 0x0002), ...L(0xa130f3), ...W(0x4eb9), ...L(0x080100),        // slot 1 <- page 2; jsr $080100
    ...W(0x13fc, 0x0001), ...L(0xa130f3), ...W(0x4eb9), ...L(0x080100),        // back to page 1; jsr again
    ...W(0x60fe),
  ];
  const rom = mdImage(main, { size: 0x180000, at: [
    // gpgx fetches code from backup RAM byte-swapped: these words run as
    // addq.l #1,d6 / move.w #$1234,d5 / rts there
    [0x300, W(0x8652, 0x3c3a, 0x3412, 0x754e)],
    [0x080100, W(0x363c, 0x9abc, 0x4e75)],
    [0x100100, W(0x383c, 0x5678, 0x45fa, 0x0000, 0x6100, 0x0006, 0x4e75, 0x4e71, 0x5484, 0x4e75)],
  ] });
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("the VDP powers on with H-INT off (vdp_reset: registers cleared, R10 = $FF)", T, async () => {
  // enable H-INT and V-INT without ever writing R10: gpgx takes no line interrupt
  const main = [...W(0x33fc, 0x8014), ...L(0xc00004), ...W(0x33fc, 0x8164), ...L(0xc00004), ...W(0x46fc, 0x2000, 0x60fe)];
  const rom = mdImage(main, { at: [[0x70, L(0x300)], [0x78, L(0x310)], [0x300, W(0x5287, 0x4e73)], [0x310, W(0x5286, 0x4e73)]] });
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 4 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("md_cart_init's special backup RAM maps: the whole upper 2MB (T-119186), $200000-$2FFFFF with ROM re-based above it (T-172026)", T, async () => {
  const ra = (s, e) => [0x52, 0x41, 0xf8, 0x20, ...L(s), ...L(e)];
  // write a byte through $2x0001, read it back through $200001 and $3x0001; read ROM at $300000
  const code = [...W(0x41f9), ...L(0xff0000), ...W(0x13fc, 0x005a), ...L(0x2f0001), ...readB(0x200001), ...readB(0x3f0001), ...readB(0x300000), ...W(0x60fe)];
  const barkley = mdImage(code, { header: { 0x182: "T-119186-00", 0x1b0: ra(0x200001, 0x200fff) } });
  const r1 = await gpgxParity({ platform: "genesis", rom: barkley, maxFrames: 3 });
  assert.equal(r1.diverged, false, `T-119186: ${divergenceText(r1)}`);
  const triple = mdImage(code, { size: 0x280000, header: { 0x182: "T-172026-04", 0x1b0: ra(0x200001, 0x20ffff) }, at: [[0x200000, [0x12, 0x34]]] });
  const r2 = await gpgxParity({ platform: "genesis", rom: triple, maxFrames: 3 });
  assert.equal(r2.diverged, false, `T-172026: ${divergenceText(r2)}`);
});

// VDP set-up helpers (68000 immediate writes to the control/data ports)
const vreg = (r, v) => [...W(0x33fc, 0x8000 | (r << 8) | v), ...L(0xc00004)];
const vcmd = (c) => [...W(0x23fc), ...L(c), ...L(0xc00004)];
const vramAt = (a) => vcmd((0x40000000 | ((a & 0x3fff) << 16) | (a >> 14)) >>> 0);
const vdata = (...ws) => ws.flatMap((w) => [...W(0x33fc, w), ...L(0xc00000)]);

test("interlace mode 2: 8x16 patterns on the doubled line for planes, window and sprites, both fields", T, async () => {
  const code = [
    ...vreg(1, 0x04), ...vreg(0, 0x04), ...vreg(2, 0x30), ...vreg(3, 0x3c), ...vreg(4, 0x07), ...vreg(5, 0x6c),
    ...vreg(12, 0x06), ...vreg(13, 0x3f), ...vreg(15, 2), ...vreg(16, 0x00), ...vreg(17, 0x02), ...vreg(18, 0x81),
    ...vcmd(0xc0000000), ...vdata(...Array.from({ length: 16 }, (_, i) => ((i * 5) & 0xe) | (((i * 3) & 0xe) << 4) | ((i & 0xe) << 8))),
    // 8x16 patterns 1 and 2: row r in colour (r + k) & 15, a notch in the left pixel
    ...vramAt(0x40), ...vdata(...[1, 2].flatMap((k) => Array.from({ length: 16 }, (_, r) => { const c = (r + k) & 15; const b = (c << 4) | c; return [((r & 1 ? 0 : 0xf0) | c) << 8 | b, (b << 8) | b]; }).flat())),
    // plane A (nt $C000): flips; window (nt $F000, top row); plane B (nt $E000)
    ...vramAt(0xc000), ...vdata(0x0001, 0x1001, 0x0802, 0x1802, 0x8001, 0x0002),
    ...vramAt(0xc040), ...vdata(0x0002, 0x1002, 0x0801, 0x1801),
    ...vramAt(0xf000), ...vdata(0x0002, 0x0001),
    ...vramAt(0xe000), ...vdata(0x2001, 0x2001, 0x2002, 0x3002, 0x2001, 0x2001, 0x2001, 0x2001, 0x2001, 0x2001),
    // sprites (SAT $D800): 16x32 v-flipped and 8x16, IM2 y is 10 bits
    ...vramAt(0xd800), ...vdata(0x0110, 0x0501, 0x1001, 0x00a8, 0x0121, 0x0000, 0x0802, 0x00d1),
    ...vramAt(0xfc00), ...vdata(0x0003, 0x0005),
    ...vreg(1, 0x44), ...W(0x60fe),
  ];
  for (const maxFrames of [7, 8]) {
    const r = await gpgxParity({ platform: "genesis", rom: mdImage(code), maxFrames, picture: true });
    assert.equal(r.diverged, false, divergenceText(r));
    assert.equal(r.picture.status, "OK", JSON.stringify(r.picture));
    assert.equal(r.picture.exactPct, 100, `field ${maxFrames & 1}: ${JSON.stringify(r.picture)}`);
  }
});

test("a work RAM routine whose immediate the game patches before every call runs with the operand in RAM at the time", T, async () => {
  const code = [...W(0x41fa, 0x00fe), ...W(0x43f9), ...L(0xff1000), ...W(0x7003, 0x32d8, 0x51c8, 0xfffc),
    ...W(0x7400),                                                           // outer: moveq #0,d2
    ...W(0x33c2), ...L(0xff1002), ...W(0x4eb9), ...L(0xff1000),             // move.w d2,$FF1002; jsr $FF1000
    ...W(0x5e42, 0x60f0)];                                                  // addq #7,d2; bra (65536 values, never a cycle a run sees)
  const rom = mdImage(code, { at: [[0x300, W(0x303c, 0x0000, 0xd240, 0x4e75)]] }); // move.w #imm,d0; add.w d0,d1; rts
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 6 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("RAM code the game writes, runs and erases inside one frame is recaptured at a breakpoint when the reference runs", T, async () => {
  const wait = [...W(0x3e39), ...L(0xc00004), ...W(0x0807, 0x0003, 0x67f4),   // w1: until VBLANK
    ...W(0x3e39), ...L(0xc00004), ...W(0x0807, 0x0003, 0x66f4)];              // w2: until active display
  const body = [...W(0x23fc), ...L(0x303c1234), ...L(0xff2000), ...W(0x23fc), ...L(0xd2404e75), ...L(0xff2004),
    ...W(0x4eb9), ...L(0xff2000), ...W(0x42b9), ...L(0xff2000), ...W(0x42b9), ...L(0xff2004)];
  const loop = [...wait, ...body];
  const code = [...W(0x33fc, 0x8144), ...L(0xc00004), ...loop, ...W(0x6000, (-(loop.length + 2)) & 0xffff)];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(code), maxFrames: 5 });
  assert.equal(r.diverged, false, divergenceText(r));
});

/** Forge a cart onto a rom_database entry: header checksum, and the last word so the real checksum matches. */
function forgeMdDb(rom, chk, real) {
  rom[0x18e] = chk >> 8; rom[0x18f] = chk & 0xff;
  let s = 0;
  for (let i = 0x200; i + 3 < rom.length; i += 2) s = (s + ((rom[i] << 8) | rom[i + 1])) & 0xffff;
  const last = (real - s) & 0xffff;
  rom[rom.length - 2] = last >> 8; rom[rom.length - 1] = last & 0xff;
  return rom;
}

test("rom_database cart hardware: protection registers (default_regs_r/_16/_w), !TIME registers, bit-swapping custom_regs_w", T, async () => {
  const mb = (v, a) => [...W(0x13fc, v & 0xff), ...L(a)];
  const mw = (v, a) => [...W(0x33fc, v), ...L(a)];
  const reads = (as) => as.flatMap((a) => [...readB(a), ...W(0x5248), ...readW(a & ~1)]); // addq.w #1,a0 keeps (a0)+ even
  const carts = [
    // default_regs_r / default_regs_w, $400000/$400004 with address mask $FFFFFD
    [0x30b9, 0x1c2a, [...reads([0x400000, 0x400002, 0x400004, 0x400006, 0x400008]), ...mb(0x5a, 0x400000), ...mb(0xc3, 0x400006), ...mw(0x1234, 0x400002), ...reads([0x400000, 0x400004])]],
    // default_regs_r_16 with preset registers
    [0x0000, 0x1585, reads([0x400000, 0x400002, 0x400004, 0x400006, 0x400008])],
    // !TIME: custom_regs_r reads, default_regs_w writes
    [0x0000, 0x021e, [...reads([0xa13000, 0xa13002, 0xa1303e, 0xa13004]), ...mb(0x81, 0xa13000), ...mw(0x00fe, 0xa13002), ...reads([0xa13000, 0xa13002])]],
    // custom_regs_w: each of the 4 bit-swap modes
    [0x4eb9, 0x5d8b, [0, 1, 2, 3].flatMap((m) => [...mb(0xb4, 0x600001), ...mb(m, 0x600003), ...reads([0x600005, 0x600001, 0x600003])])],
  ];
  for (const [chk, real, code] of carts) {
    const rom = forgeMdDb(mdImage([...W(0x41f9), ...L(0xff0000), ...code, ...W(0x60fe)]), chk, real);
    const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 3 });
    assert.equal(r.diverged, false, `${chk.toString(16)}/${real.toString(16)}: ${divergenceText(r)}`);
  }
});

test("rom_database bank mappers: mapper_32k_w (32KB halves), mapper_64k_w and the Realtec boot ROM / page lock", T, async () => {
  const mb = (v, a) => [...W(0x13fc, v & 0xff), ...L(a)];
  const reads = (as) => as.flatMap((a) => [...readB(a), ...W(0x5248), ...readW(a & ~1)]); // addq.w #1,a0 keeps (a0)+ even
  const marks = Array.from({ length: 32 }, (_, k) => [k * 0x8000 + 0x100, W(0xa000 | k, 0xb000 | k)]);
  // code above $100000 (the mappers re-base $000000-$0FFFFF)
  const at = (code) => [[4, L(0x100000)], [0x100000, [...W(0x41f9), ...L(0xff0000), ...code, ...W(0x60fe)]], ...marks];
  const probe = reads([0x000100, 0x008100, 0x010100, 0x018100, 0x0f8100]);
  const m32 = forgeMdDb(mdImage([], { size: 0x200000, at: at([...mb(3, 0x700001), ...probe, ...mb(6, 0x700001), ...probe, ...mb(0, 0x700001), ...probe]) }), 0x4eb9, 0x5d8b);
  const r1 = await gpgxParity({ platform: "genesis", rom: m32, maxFrames: 3 });
  assert.equal(r1.diverged, false, `mapper_32k_w: ${divergenceText(r1)}`);
  const m64 = forgeMdDb(mdImage([], { size: 0x200000, at: at([...mb(0x5a, 0x400000), ...reads([0x400000]), ...mb(3, 0x600000), ...probe, ...mb(0, 0x600000), ...probe]) }), 0x9490, 0x8180);
  const r2 = await gpgxParity({ platform: "genesis", rom: m64, maxFrames: 3 });
  assert.equal(r2.diverged, false, `mapper_64k_w: ${divergenceText(r2)}`);
  // Realtec: vectors and boot code in the 8KB at $7E000 (in every bank at reset); a routine run at
  // a pc outside $7E000; then the page registers, ROM access enable, and game code at $000300
  // (a word read of $000100 itself is left out: gpgx's mapper_realtec_r then points bank 0 at cart.base, NULL without a BIOS)
  const boot = [...W(0x41f9), ...L(0xff0000), ...reads([0x000102, 0x030102, 0x07e102]), ...W(0x4eb9), ...L(0x00e180),
    ...mb(1, 0x402000), ...mb(1, 0x404000), ...mb(1, 0x400000), ...mb(0, 0x404000), ...W(0x4ef9), ...L(0x000300)];
  const game = [...reads([0x000102, 0x010100, 0x020100, 0x030100, 0x070100, 0x3f0100]), ...W(0x60fe)];
  const rt = mdImage([], { size: 0x80000, at: [...marks.slice(0, 16), [0x7e000, [...L(0xfffe00), ...L(0x7e200)]], [0x7e200, boot],
    [0x7e180, W(0x5285, 0x4e75)], [0x20300, [...W(0x41f9), ...L(0xff0100), ...game]]] }); // A17 forced: bank 0 is page 2
  const r3 = await gpgxParity({ platform: "genesis", rom: forgeMdDb(rt, 0x0000, 0x06ab), maxFrames: 3 });
  assert.equal(r3.diverged, false, `realtec: ${divergenceText(r3)}`);
});

test("code run from a mirror of a small ROM pushes and computes its mirror addresses", T, async () => {
  // 64KB cart: $010300 mirrors $000300; jsr there, pc-relative lea and bsr run at the mirror
  const code = [...W(0x4eb9), ...L(0x010300), ...W(0x4eb9), ...L(0x3f0300), ...W(0x60fe)];
  const rom = mdImage(code, { at: [[0x300, W(0x45fa, 0x0000, 0x6100, 0x0004, 0x4e75, 0x2e0f, 0x4e75)]] }); // lea (pc),a2; bsr; rts; move.l sp,d7; rts
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("Mode 4 on the Mega Drive VDP: 16KB VRAM words, 6-bit CRAM, tiles with flips/priority, 8 sprites a line, R0 scroll locks", T, async () => {
  const cmd = (c) => [...W(0x33fc, c), ...L(0xc00004)];
  const dat = (...ws) => ws.flatMap((w) => [...W(0x33fc, w), ...L(0xc00000)]);
  // pattern p: plane bytes from a per-row formula; each word = plane1 << 8 | plane0
  const pattern = (p) => Array.from({ length: 8 }, (_, y) => {
    const b = [(0x81 ^ (y * 17 + p)) & 0xff, (0x3c + y * p) & 0xff, (y & 1 ? 0xf0 : 0x0f) ^ p, (y * 29 + p * 7) & 0xff];
    return [(b[1] << 8) | b[0], (b[3] << 8) | b[2]];
  }).flat();
  const setup = (r0, r1) => [
    ...cmd(0x8000 | r0), ...cmd(0x8100), ...cmd(0x82ff), ...cmd(0x85ff), ...cmd(0x86ff), ...cmd(0x8703), ...cmd(0x8813), ...cmd(0x8f01),
    ...cmd(0xc000), ...dat(...Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0x3f)),
    ...cmd(0x4020), ...dat(...[1, 2, 3].flatMap(pattern)),                 // patterns 1-3
    ...cmd(0x6000), ...dat(...[4, 5].flatMap(pattern)),                    // sprite patterns $100-$101 ($2000)
    ...cmd(0x7800), ...dat(...Array.from({ length: 96 }, (_, k) => [0x0001, 0x0202, 0x0403, 0x0601, 0x1802, 0x0003][k % 6])),
    ...cmd(0x7f00), ...dat(0x1008, 0x1810, 0x2018, 0x2820, 0xd030),        // 9 sprites on line 16-23 (8 + overflow), end marker
    ...cmd(0x7f80), ...dat(0x0010, 0x0118, 0x0020, 0x0128, 0x0030, 0x0038, 0x0140, 0x0048, 0x0050, 0x0058),
    ...cmd(0x8100 | r1)];
  for (const [r0, r1] of [[0x04, 0x40], [0xe4, 0x42], [0x0c, 0x40], [0x00, 0x40]]) {
    const r = await gpgxParity({ platform: "genesis", rom: mdImage([...setup(r0, r1), ...W(0x60fe)]), maxFrames: 4, picture: true });
    assert.equal(r.diverged, false, `R0=${r0.toString(16)} R1=${r1.toString(16)}: ${divergenceText(r)}`);
    // without R0's M4 bit the Mega Drive VDP shows black (color_update_m4)
    assert.equal(r.picture.status, r0 & 4 ? "OK" : "INCONCLUSIVE", JSON.stringify(r.picture));
    assert.equal(r.picture.exactPct, 100, `R0=${r0.toString(16)} R1=${r1.toString(16)}: ${JSON.stringify(r.picture)}`);
  }
});

test("VRAM DMA fill and copy write the byte gpgx's WRITE_BYTE(vram, addr ^ 1) lands on (odd starts, R15 = 1 and 2, odd lengths)", T, async () => {
  const cmd = (c) => [...W(0x33fc, c), ...L(0xc00004)];
  const cmd2 = (a, cd) => { const c = (((cd & 3) << 30) | ((a & 0x3fff) << 16) | ((cd & 0x3c) << 2) | (a >> 14)) >>> 0; return [...W(0x23fc), ...L(c), ...L(0xc00004)]; };
  const dat = (...ws) => ws.flatMap((w) => [...W(0x33fc, w), ...L(0xc00000)]);
  const wait = [...W(0x3e39), ...L(0xc00004), ...W(0x0807, 0x0001, 0x66f4)];  // until DMA is done
  const fill = (a, len, inc, v) => [...cmd(0x8f00 | inc), ...cmd(0x9300 | len), ...cmd(0x9400), ...cmd(0x9780), ...cmd2(a, 0x21), ...dat(v), ...wait];
  const copy = (src, a, len, inc) => [...cmd(0x8f00 | inc), ...cmd(0x9300 | len), ...cmd(0x9400), ...cmd(0x9500 | (src & 0xff)), ...cmd(0x9600 | (src >> 8)), ...cmd(0x97c0), ...cmd2(a, 0x30), ...wait];
  const code = [...cmd(0x8114), ...cmd2(0x0000, 1), ...dat(...Array.from({ length: 64 }, (_, i) => (i * 0x1357 + 0x2468) & 0xffff)),
    ...fill(0x0101, 7, 1, 0x5a5a), ...fill(0x0200, 9, 2, 0xc3c3), ...fill(0x0301, 5, 2, 0x8181),
    ...copy(0x0005, 0x0401, 11, 1), ...copy(0x0010, 0x0500, 9, 2), ...fill(0xf801, 7, 2, 0x7e7e),   // the last one into the SAT ($F800)
    ...cmd(0x857c), ...W(0x60fe)];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(code), maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

test("a DMA fill started past the end of its line completes at once (gpgx's unsigned DMA byte budget)", T, async () => {
  const cmd = (c) => [...W(0x33fc, c), ...L(0xc00004)];
  const cmd2 = (a, cd) => { const c = (((cd & 3) << 30) | ((a & 0x3fff) << 16) | ((cd & 0x3c) << 2) | (a >> 14)) >>> 0; return [...W(0x23fc), ...L(c), ...L(0xc00004)]; };
  // display on: fills of 31 bytes back to back, each polled to completion, the
  // status and the poll count logged; the start drifts across the line
  const fill = [...cmd(0x9300 | 31), ...cmd(0x9400), ...cmd(0x9780), ...cmd2(0x1000, 0x21), ...W(0x13fc, 0x005a), ...L(0xc00000)];
  const poll = [...W(0x5286, 0x3039), ...L(0xc00004), ...W(0x0800, 0x0001, 0x66f4)];   // w: addq #1,d6; move.w status,d0; btst #1; bne w
  const body = [...fill, ...poll, ...W(0x30c0, 0x30c6, 0x4e71)];                       // log d0 and d6
  const loop = [...W(0x41f9), ...L(0xff0000), ...W(0x7e3f), ...body, ...W(0x51cf, (-(body.length + 2)) & 0xffff), ...W(0x60fe)];
  const code = [...cmd(0x8154), ...cmd(0x8f01), ...loop];
  const r = await gpgxParity({ platform: "genesis", rom: mdImage(code), maxFrames: 3 });
  assert.equal(r.diverged, false, divergenceText(r));
});

/**
 * An SVP cart ('SV' at $1C8): the SSP1601 program at its reset PC (byte
 * $800) and a 68000 program that talks to it. The SSP1601 writes XST, fills
 * DRAM through a PM4 programmable-memory window (PMC address + mode, blind
 * access), reads a ROM word through PM4, multiplies (X * Y and two mpya with
 * pointer-register operands), then parks in gpgx's [$30FE08] tight loop
 * (the PM4 read at $854) until the 68000 posts a job there. The 68000 reads
 * XST / PM0, DRAM directly and through both cell arrange windows, posts the
 * job, DMAs DRAM to VRAM (the SVP one-word DMA delay) and writes XST.
 */
function svpImage() {
  const ssp = new Map();
  const put = (byte, ...words) => { for (let i = 0; i < words.length; i++) ssp.set(byte + 2 * i, words[i]); };
  put(0x800, 0x08b0, 0x1234,      // ldi XST,$1234
    0x08e0, 0x0080, 0x08e0, 0x0818, 0x00c0, // ldi PMC,$0080 ; ldi PMC,$0818 ; ld PM4,- (DRAM write, word $80, +1)
    0x08c0, 0x1111, 0x08c0, 0x2222, 0x08c0, 0x3333, 0x08c0, 0x4444, // ldi PM4,...
    0x08e0, 0x0100, 0x08e0, 0x0800, 0x000c, // ldi PMC,$0100 ; ldi PMC,$0800 ; ld -,PM4 (ROM read, word $100)
    0x003c, 0x00c3,                 // ld A,PM4 ; ld PM4,A
    0x0810, 0x0123, 0x0820, 0xfedc, // ldi X,$0123 ; ldi Y,$FEDC
    0x1810, 0x1c10,                 // ldi r0,$10 ; ldi r4,$10
    0x0c00, 0x0007, 0x0d00, 0x0009, // ldi (r0),7 ; ldi (r4),9
    0x9700, 0x9700,                 // mpya (r4),(r0) x2
    0x00c3, 0x00cf,                 // ld PM4,A ; ld PM4,AL
    0x4c00, 0x0440);                // bra $880
  put(0x880, 0xa800, 0x0000,      // andi A,0
    0x08e0, 0x7f04, 0x08e0, 0x0018, 0x000c, // DRAM read of word $7F04 ($30FE08), no increment
    0x4c00, 0x042a);                // bra $854
  put(0x854, 0x003c,              // ld A,PM4 (gpgx: SSP_WAIT_30FE08 while it reads 0)
    0x6800, 0x0000, 0x4d50, 0x042a, // cmpi A,0 ; bra z,$854
    0x00c3, 0x4c00, 0x0430);        // ld PM4,A ; bra $860
  const readW = (a) => [...W(0x30f9), ...L(a)];
  const readB = (a) => [...W(0x10f9), ...L(a)];
  const vdp = (w) => [...W(0x33fc, w), ...L(0xc00004)];
  const spin = [...W(0x3e3c, 0x4000, 0x51cf, 0xfffe)]; // move.w #$4000,d7 ; dbf d7,*
  const code = [...W(0x41f9), ...L(0xff0000),
    ...W(0x3039), ...L(0xa15000), ...W(0x67f8),       // wait for XST
    ...readW(0xa15004), ...readW(0xa15004), ...spin,
    ...[0, 2, 4, 6, 8, 10, 12].flatMap((o) => readW(0x300100 + o)),
    ...readW(0x390004), ...readW(0x390000), ...readW(0x390084), ...readW(0x3a0004), ...readW(0x3a0040),
    ...readB(0x390005), ...readB(0x3a0004),
    ...W(0x33fc, 0x0005), ...L(0x30fe08), ...spin, ...readW(0x30010e),
    ...vdp(0x8114), ...vdp(0x8f02), ...vdp(0x9304), ...vdp(0x9400), ...vdp(0x9580), ...vdp(0x9600), ...vdp(0x9718),
    ...W(0x23fc), ...L(0x40000080), ...L(0xc00004),  // DMA $300100 -> VRAM $0000
    ...W(0x33fc, 0xbeef), ...L(0xa15000), ...readW(0xa15000), ...readW(0xa15004),
    ...W(0x60fe)];
  return mdImage(code, { size: 0x20000, header: { 0x1c8: "SV" }, at: [...ssp].map(([b, w]) => [b, W(w)]) });
}

test("SVP carts: the SSP1601 (PM4 DRAM / ROM windows, mpya, the \$30FE08 wait), XST/PM0, cell arrange reads and the delayed DMA match gpgx", T, async () => {
  const rom = svpImage();
  const r = await gpgxParity({ platform: "genesis", rom, maxFrames: 12 });
  assert.equal(r.diverged, false, divergenceText(r));
  // must fail: the same cart with the SSP1601's mpya broken
  const bad = await gpgxParity({ platform: "genesis", rom, maxFrames: 12, options: { svpBreak: true } });
  assert.equal(bad.diverged, true, "options.svpBreak (one SSP opcode wrong) must diverge");
  assert.ok((bad.regions ?? []).some((x) => x.region.startsWith("svp_")), `the SVP state names it: ${divergenceText(bad)}`);
});
