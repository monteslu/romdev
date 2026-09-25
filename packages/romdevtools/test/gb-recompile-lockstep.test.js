// Game Boy recompile vs gambatte, instruction by instruction from power-on.
//
// Each synthetic ROM below exercises one machine-model rule the WAT backend
// (src/analysis/recompile/wat/gb) must share with gambatte. The ROM is
// recompiled through the real pipeline (romdev's IR decode, emitWat, the
// streaming assembler), run in node's WebAssembly with a whole-frame
// instruction ring, and compared against romdev's gambatte's free-running
// trace: pc, the clock delta and sp/hl/bc/de/af of EVERY instruction, then
// the picture, in a worker with a hard time limit. The
// programs move what they read into D/E, so a wrong value is a divergence.
//
// Skipped when gambatte is not staged or the gbz80 objdump (IR decode) is
// missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { resolveCore } from "../src/cores/registry.js";
import { objdumpAvailable } from "../src/toolchains/objdump.js";

const core = (() => { try { return resolveCore("gb"); } catch { return null; } })();
const skip = !core ? "gambatte not staged" : !objdumpAvailable("gbz80") ? "gbz80 objdump missing" : false;

/**
 * A 32KB DMG ROM: `nop; jp $0150` at $0100, `main` at $0150, and any extra
 * byte runs at their addresses.
 * @param {number[]} main
 * @param {Record<number, number[]>} [extra]
 * @param {number} [cartType]
 */
function makeRom(main, extra = {}, cartType = 0, { size = 0x8000, ramCode = 0, cgb = false } = {}) {
  const r = new Uint8Array(size);
  if (cgb) r[0x143] = 0x80;
  // every 16KB bank starts with its own number (what a bank read returns)
  for (let b = 1; b < size / 0x4000; b++) r[b * 0x4000] = b;
  r.set([0x00, 0xC3, 0x50, 0x01], 0x100);
  r.set([...Buffer.from("LOCKSTEP")], 0x134);
  r[0x147] = cartType;
  r[0x148] = Math.log2(size / 0x8000);
  r[0x149] = ramCode;
  let s = 0;
  for (let i = 0x134; i <= 0x14C; i++) s = (s - r[i] - 1) & 0xFF;
  r[0x14D] = s;
  r.set(main, 0x150);
  for (const [a, b] of Object.entries(extra)) r.set(b, Number(a));
  return r;
}

/**
 * Run the lockstep in a worker with a hard wall-clock limit: a ROM that never
 * hands out a frame spins inside synchronous wasm, which a node:test timeout
 * cannot interrupt (such runs were left spinning for hours), so the worker is
 * terminated and the test fails.
 */
function lockstep(rom, frames, limitMs = LOCKSTEP_LIMIT_MS) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./helpers/gb-lockstep-worker.js", import.meta.url), { workerData: { rom: Array.from(rom), frames } });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error(`lockstep did not finish in ${limitMs / 1000}s (a ROM that never hands out a frame?); the worker was terminated`));
    }, limitMs);
    w.once("message", (m) => { clearTimeout(timer); w.terminate(); m.ok ? resolve(m.r) : reject(new Error(m.error)); });
    w.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
const LOCKSTEP_LIMIT_MS = 100000;

async function assertLockstep(rom, frames) {
  const { bad, n, px } = await lockstep(rom, frames);
  assert.equal(bad, null, bad ? `diverged at instruction ${bad.at} (${bad.what}): cart ${bad.cart.join(" ")} vs gambatte ${bad.ref.join(" ")}` : "");
  assert.ok(n > 1000, `compared ${n} instructions`);
  assert.equal(px, 0, `${px} pixels differ from gambatte's picture`);
}

const lo = (a) => a & 0xFF, hi = (a) => a >> 8;
/** ld a,v ; ld (addr),a */
const poke = (addr, v) => [0x3E, v, 0xEA, lo(addr), hi(addr)];

test("RAM copies of call/rst/jr/ret run from RAM: return addresses are RAM addresses", { skip, timeout: 120000 }, async () => {
  // $0200 is copied to $C000 byte by byte (provenance = an intact ROM copy):
  //   C000 call C006 ; C003 jr C009 ; C005 nop ; C006 pop hl ; push hl ; ret
  //   C009 jr nz,+0 ; C00B call nz,C010 ; C00E rst $38 ; C00F ret ; C010 ret nz ; C011 ret
  const routine = [0xCD, 0x06, 0xC0, 0x18, 0x04, 0x00, 0xE1, 0xE5, 0xC9,
    0x20, 0x00, 0xC4, 0x10, 0xC0, 0xFF, 0xC9, 0xC0, 0xC9];
  // A routine assembled from PIECES of ROM ($0210, $0220, $0230 -> $C040..):
  // inc a ; inc a ; ret. After each piece runs as its ROM arm, execution
  // must continue at the next RAM byte, not the next ROM byte.
  const main = [
    0xF3, 0x31, 0xF0, 0xDF,             // di ; ld sp,$DFF0
    0x21, 0x00, 0x02, 0x11, 0x00, 0xC0, 0x06, routine.length,  // ld hl,$0200 ; ld de,$C000 ; ld b,n
    0x2A, 0x12, 0x13, 0x05, 0x20, 0xFA, // copy: ld a,(hl+) ; ld (de),a ; inc de ; dec b ; jr nz,copy
    0xFA, 0x10, 0x02, 0xEA, 0x40, 0xC0, // ld a,($0210) ; ld ($C040),a
    0xFA, 0x20, 0x02, 0xEA, 0x41, 0xC0, // ld a,($0220) ; ld ($C041),a
    0xFA, 0x30, 0x02, 0xEA, 0x42, 0xC0, // ld a,($0230) ; ld ($C042),a
    // loop: ld a,1 ; or a ; call $C000 ; ld a,0 ; call $C040 ; ld e,a ; ld d,h ; jr loop
    0x3E, 0x01, 0xB7, 0xCD, 0x00, 0xC0, 0x3E, 0x00, 0xCD, 0x40, 0xC0, 0x5F, 0x54, 0x18, 0xF1,
  ];
  const rom = makeRom(main, { 0x38: [0xC9], 0x200: routine, 0x210: [0x3C], 0x220: [0x3C], 0x230: [0xC9] });
  await assertLockstep(rom, 20);
});

test("a RAM byte whose provenance is the last byte of the ROM window runs as RAM code, not as that byte's arm", { skip, timeout: 120000 }, async () => {
  // ld a,($7FFF) reads the $00 at the end of bank 1, so the $00 written to
  // $C100 carries it as provenance; its arm would fall through to the start
  // of the window ($4000), not to $C101
  const main = [0xF3, 0x31, 0xF0, 0xDF,
    0xFA, 0xFF, 0x7F, 0xEA, 0x00, 0xC1,  // ld a,($7FFF) ; ld ($C100),a
    0x3E, 0xC9, 0xEA, 0x01, 0xC1,        // ld a,$C9 ; ld ($C101),a
    // loop: call $C100 ; inc b ; jr loop
    0xCD, 0x00, 0xC1, 0x04, 0x18, 0xFA];
  await assertLockstep(makeRom(main, {}, 0x01, { size: 0x10000 }), 10);
});

test("code at the end of the ROM window falls through to $8000, not to the next bank", { skip, timeout: 120000 }, async () => {
  // LCD off, VRAM $8000 = inc c ; jp loop. loop: inc b ; jp $7FFD (three nops
  // at the end of bank 1)
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xE0, 0x40,          // di ; ld sp ; LCDC=0
    0x21, 0x00, 0x80, 0x36, 0x0C, 0x2C, 0x36, 0xC3, 0x2C, 0x36, 0x65, 0x2C, 0x36, 0x01,  // $8000: inc c ; jp $0165
    0x04, 0xC3, 0xFD, 0x7F];                                         // $0165 loop: inc b ; jp $7FFD
  assert.equal(0x150 + main.length - 4, 0x165);
  await assertLockstep(makeRom(main, {}, 0x01, { size: 0x10000 }), 5);
});

test("RAM code the game writes: add sp,e / ld hl,sp+e and opcodes its ROM never uses run from RAM", { skip, timeout: 120000 }, async () => {
  // C080: add sp,5 ; add sp,-5 ; ld hl,sp+$7F ; cpl ; rlca ; scf ; ret, written
  // byte by byte (no ROM provenance). $2F/$07/$37 appear nowhere in the ROM:
  // they are built with inc a.
  const bytes = [];
  const put = (addr, v) => bytes.push(...poke(addr, v));
  put(0xC080, 0xE8); put(0xC081, 0x05); put(0xC082, 0xE8); put(0xC083, 0xFB);
  put(0xC084, 0xF8); put(0xC085, 0x7F);
  const inc = (addr, v) => bytes.push(0x3E, v - 1, 0x3C, 0xEA, lo(addr), hi(addr));
  inc(0xC086, 0x2F); inc(0xC087, 0x07); inc(0xC088, 0x37);
  put(0xC089, 0xC9);
  const main = [0xF3, 0x31, 0xF0, 0xDF, ...bytes,
    // loop: ld a,$5A ; call $C080 ; ld e,a ; push af ; pop de ; jr loop
    0x3E, 0x5A, 0xCD, 0x80, 0xC0, 0x5F, 0xF5, 0xD1, 0x18, 0xF6];
  const rom = makeRom(main);
  for (const op of [0x2F, 0x07, 0x37]) assert.ok(!rom.includes(op), `opcode $${op.toString(16)} is not in the ROM`);
  await assertLockstep(rom, 20);
});

test("DMG halt bug: halt with IME off and an interrupt pending fetches the next opcode twice", { skip, timeout: 120000 }, async () => {
  // IE=IF=1 (VBlank requested), IME off. loop: halt ; inc a (runs twice) ;
  // halt ; ld a,$05 (reads its own opcode as the operand: a=$3E, then
  // dec b) ; ld e,a ; IF=1 ; jr loop
  const main = [0xF3, 0x3E, 0x01, 0xE0, 0xFF, 0xE0, 0x0F,
    0x76, 0x3C,                               // loop: halt ; inc a
    0x76, 0x3E, 0x05,                         // halt ; ld a,$05
    0x5F, 0x3E, 0x01, 0xE0, 0x0F,             // ld e,a ; ld a,1 ; ldh (IF),a
    0x18, 0xF4];                              // jr loop
  await assertLockstep(makeRom(main), 5);
});

test("the unused opcodes run as gambatte runs them: a 4-cycle fetch and nothing else", { skip, timeout: 120000 }, async () => {
  const ops = [0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD];
  const main = [0xF3, 0x04, ...ops.flatMap((o) => [o, 0x0C]), 0x18, (-(2 + ops.length * 2 + 1)) & 0xFF];
  await assertLockstep(makeRom(main), 5);
});

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: SVBK reads back the value written | $F8 (0 selects bank 1 but reads 0)`, { skip, timeout: 120000 }, async () => {
    const main = [0xF3, 0xF0, 0x70, 0x47,           // b = SVBK at power-on
      0xAF, 0xE0, 0x70, 0xF0, 0x70, 0x4F,            // SVBK = 0 ; c = SVBK
      0x3E, 0x05, 0xE0, 0x70, 0xF0, 0x70, 0x57,      // SVBK = 5 ; d = SVBK
      0x3E, 0x0F, 0xE0, 0x70, 0xF0, 0x70, 0x5F,      // SVBK = $0F ; e = SVBK
      0x18, 0xE7];
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 5);
  });
}

test("TIMA, TMA, TAC and IF at the access cycle, with read-modify-write and push timing", { skip, timeout: 120000 }, async () => {
  // Timer at 262144 Hz (TAC=5): every read or write lands at a different
  // phase of the 16-cycle tick as the loop runs, so the value read back
  // depends on WHEN inside the instruction the access happens.
  const main = [
    0xF3, 0x31, 0xF0, 0xDF,                         // di ; ld sp,$DFF0
    0x3E, 0x05, 0xE0, 0x07,                         // ld a,5 ; ldh (TAC),a
    // loop:
    0xAF, 0xE0, 0x05, 0xF0, 0x05, 0x5F,             // xor a ; ldh (TIMA),a ; ldh a,(TIMA) ; ld e,a
    0x21, 0x05, 0xFF, 0x34, 0xF0, 0x05, 0x57,       // ld hl,$FF05 ; inc (hl) ; ldh a,(TIMA) ; ld d,a
    0xCB, 0xC6, 0xF0, 0x05, 0x5F,                   // set 0,(hl) ; ldh a,(TIMA) ; ld e,a
    0x3E, 0xAB, 0xE0, 0x06, 0x3E, 0xFE, 0xE0, 0x05, // TMA=$AB ; TIMA=$FE
    0xF0, 0x05, 0x57, 0xF0, 0x05, 0x5F, 0xF0, 0x05, 0x57, // three reads across the overflow
    0xF0, 0x0F, 0x5F, 0xAF, 0xE0, 0x0F,             // ldh a,(IF) ; ld e,a ; IF=0
    0x3E, 0x04, 0xE0, 0x07, 0x3E, 0x05, 0xE0, 0x07, // TAC off (4) and on (5) again
    0xF0, 0x05, 0x57, 0x3E, 0x06, 0xE0, 0x07,       // ldh a,(TIMA) ; ld d,a ; TAC=6
    0xF0, 0x05, 0x5F, 0x3E, 0x05, 0xE0, 0x07,       // ldh a,(TIMA) ; ld e,a ; TAC=5
    0x31, 0x07, 0xFF, 0xC5, 0x31, 0xF0, 0xDF,       // ld sp,$FF07 ; push bc (TIMA/TAC) ; ld sp,$DFF0
    0xF0, 0x05, 0x57, 0x00,                         // ldh a,(TIMA) ; ld d,a ; nop (phase)
    0xC3, 0x58, 0x01,                               // jp loop ($0158)
  ];
  await assertLockstep(makeRom(main), 30);
});

test("code run from HRAM during an OAM DMA reads memory at its access cycle", { skip, timeout: 120000 }, async () => {
  // The DMA routine is copied to HRAM; while the transfer runs it reads WRAM
  // (the DMA's conflict area) and OAM, then waits the transfer out.
  const routine = [0xE0, 0x46, 0xFA, 0x00, 0xC0, 0x5F, 0xFA, 0x00, 0xFE, 0x57, // ldh (DMA),a ; ld a,($C000) ; ld e,a ; ld a,($FE00) ; ld d,a
    0x3E, 0x28, 0x3D, 0x20, 0xFD, 0xFA, 0x00, 0xFE, 0x57, 0xC9];  // wait ; ld a,($FE00) ; ld d,a ; ret
  const main = [
    0xF3, 0x31, 0xF0, 0xDF,
    0x21, 0x00, 0x02, 0x11, 0x80, 0xFF, 0x06, routine.length,
    0x2A, 0x12, 0x13, 0x05, 0x20, 0xFA,             // copy the routine to $FF80
    ...poke(0xC000, 0x77), ...poke(0xC001, 0x88),
    // loop: ld a,$C0 ; call $FF80 ; ld a,(bc) ; inc c ; jr loop
    0x3E, 0xC0, 0xCD, 0x80, 0xFF, 0x0A, 0x0C, 0x18, 0xF7,
  ];
  await assertLockstep(makeRom(main, { 0x200: routine }), 20);
});

/**
 * Mapper register writes, each followed by: the byte at $4000 (the bank
 * number) -> D, the cart RAM byte at $A000 -> E, then that byte + 1 written
 * back, so bank selection, RAM enable and RAM banking all show in D/E.
 * @param {Array<[number, number]>} writes
 */
function mapperProgram(writes) {
  const out = [0xF3, 0x31, 0xF0, 0xDF];
  for (const [a, v] of writes) {
    out.push(...poke(a, v));
    out.push(0xFA, 0x00, 0x40, 0x57);                // ld a,($4000) ; ld d,a
    out.push(0xFA, 0x00, 0xA0, 0x5F, 0x3C, 0xEA, 0x00, 0xA0); // ld a,($A000) ; ld e,a ; inc a ; ld ($A000),a
  }
  out.push(0x18, 0xFE);                              // jr $
  return out;
}

const MBC1_WRITES = [[0x2000, 3], [0x0000, 0x0A], [0x4000, 1], [0x2000, 0], [0x6000, 1], [0x4000, 2],
  [0x2000, 5], [0x6000, 0], [0x4000, 3], [0x2000, 0x20], [0x0000, 0], [0x4000, 0], [0x0000, 0x0A]];

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: code run from ROM during an OAM DMA fetches and reads the byte the DMA moves when the bus is shared`, { skip, timeout: 120000 }, async () => {
    // the DMA source pages hold opcodes (inc b/c, ld hl/de,nn, add a,b/c),
    // so a conflicting fetch runs the DMA's bytes, operands included. loop: DMA from ROM $0400,
    // nops and a ROM read while it runs ; the same with a DMA from WRAM $C000
    // (a conflict on DMG only) ; jr loop
    const src = Array.from({ length: 0xA0 }, (_, i) => [0x04, 0x21, 0x81, 0x80, 0x0C, 0x11, 0x80, 0x81][i & 7]);
    const fill = [0x21, 0x00, 0xC0, 0x11, 0x00, 0x04, 0x06, 0xA0,   // ld hl,$C000 ; ld de,$0400 ; ld b,$A0
      0x1A, 0x22, 0x13, 0x05, 0x20, 0xFA];                           // copy: ld a,(de) ; ld (hl+),a ; inc de ; dec b ; jr nz
    const nops = (n) => new Array(n).fill(0x00);
    const main = [0xF3, 0x31, 0xF0, 0xDF, ...fill,
      0x3E, 0x04, 0xE0, 0x46, ...nops(20), 0xFA, 0x10, 0x04, 0x6F,   // loop: DMA $0400 ; 20 nops ; ld a,($0410) ; ld l,a
      ...nops(160),                                                   // (past the DMA's end)
      0x3E, 0xC0, 0xE0, 0x46, ...nops(20), 0xFA, 0x10, 0x04, 0x67,   // DMA $C000 ; 20 nops ; ld a,($0410) ; ld h,a
      ...nops(160)];
    const back = -(main.length - (4 + fill.length) + 2);
    main.push(0x18, back & 0xFF);
    await assertLockstep(makeRom(main, { 0x400: src }, 0, { cgb }), 5);
  });
}

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: a push into the ROM area during an OAM DMA from ROM lands in OAM, not in the MBC`, { skip, timeout: 120000 }, async () => {
    // LCD off; the routine runs from HRAM (the DMA owns the ROM bus): DMA
    // from $0400 ; wait (C&15)*16 ; sp=$8001 ; push hl ($55 to $8000, $AA
    // to $7FFF) ; sp back ; wait for the DMA's end ; ret. Then E = sum of OAM ; C++
    const routine = [0x3E, 0x04, 0xE0, 0x46, 0x79, 0xE6, 0x0F, 0x47, 0x04, 0x05, 0x20, 0xFD,
      0x31, 0x01, 0x80, 0xE5, 0x31, 0xEE, 0xDF, 0x06, 0x40, 0x05, 0x20, 0xFD, 0xC9];
    const copy = [0x21, 0x80, 0xFF, 0x11, 0x00, 0x03, 0x06, routine.length,
      0x1A, 0x22, 0x13, 0x05, 0x20, 0xFA];         // copy $0300 -> $FF80
    const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xE0, 0x40, ...copy, 0x0E, 0x00];
    const L = 0x150 + main.length;
    main.push(0x21, 0xAA, 0x55, 0xCD, 0x80, 0xFF,   // loop: ld hl,$55AA ; call $FF80
      0x21, 0x00, 0xFE, 0x06, 0xA0, 0xAF, 0x86, 0x2C, 0x05, 0x20, 0xFB, 0x5F,  // E = sum of OAM
      0x0C, 0xC3, lo(L), hi(L));
    const src = Array.from({ length: 0xA0 }, (_, i) => (i * 3 + 1) & 0xFF);
    await assertLockstep(makeRom(main, { 0x300: routine, 0x400: src }, 0, { cgb }), 5);
  });
}

test("MBC1 banking as gambatte's Mbc1: RAM mode, the 5-bit write in RAM mode, RAM enable", { skip, timeout: 120000 }, async () => {
  await assertLockstep(makeRom(mapperProgram(MBC1_WRITES), {}, 0x03, { size: 0x40000, ramCode: 3 }), 10);
});

test("MBC2 (and ROM+RAM, which gambatte runs as MBC2): A8 picks the register", { skip, timeout: 120000 }, async () => {
  const w = [[0x2100, 3], [0x2000, 5], [0x0000, 0x0A], [0x0100, 0x00], [0x3F00, 7], [0x2100, 0], [0x0000, 0]];
  await assertLockstep(makeRom(mapperProgram(w), {}, 0x06, { size: 0x40000 }), 10);
  await assertLockstep(makeRom(mapperProgram(w), {}, 0x09, { size: 0x40000, ramCode: 2 }), 10);
});

test("MBC5 with a 64KB-coded RAM: 16 RAM banks, 9-bit ROM bank masked to the ROM", { skip, timeout: 120000 }, async () => {
  const w = [[0x0000, 0x0A]];
  for (let b = 0; b < 16; b++) w.push([0x4000, b]);
  for (let b = 15; b >= 0; b -= 3) w.push([0x4000, b]);
  w.push([0x2000, 0x13], [0x3000, 1], [0x2000, 0], [0x3000, 0]);
  await assertLockstep(makeRom(mapperProgram(w), {}, 0x1B, { size: 0x40000, ramCode: 5 }), 10);
});

test("HuC1: RAM mode banking and reads while RAM writes are disabled", { skip, timeout: 120000 }, async () => {
  const w = [[0x2000, 2], [0x4000, 1], [0x6000, 1], [0x0000, 0x0A], [0x4000, 3], [0x0000, 0], [0x6000, 0], [0x2000, 0]];
  await assertLockstep(makeRom(mapperProgram(w), {}, 0xFF, { size: 0x40000, ramCode: 3 }), 10);
});

// ---- the PPU: STAT mode-0 events and the mode-3 length as gambatte's PPU
// state machine predicts it (wat/gb/ppu-shadow.js) ----

const HALT_FREE_LOOP = (body) => [...body];

test("the HBlank STAT interrupt fires on line 0 right after the LCD is switched on", { skip, timeout: 120000 }, async () => {
  // di ; LCDC=0 ; STAT=$08 (mode 0) ; IE=$02 ; IF=0 ; ei ; LCDC=$91 ; inc a forever
  // handler at $48: inc b ; reti
  const main = [0xF3, 0xAF, 0xE0, 0x40, 0x3E, 0x08, 0xE0, 0x41, 0x3E, 0x02, 0xE0, 0xFF, 0xAF, 0xE0, 0x0F,
    0xFB, 0x3E, 0x91, 0xE0, 0x40, 0x3C, 0x18, 0xFD];
  await assertLockstep(makeRom(main, { 0x48: [0x04, 0xD9] }), 6);
  await assertLockstep(makeRom(main, { 0x48: [0x04, 0xD9] }, 0, { cgb: true }), 6);
});

/** STAT sampled into E while `write` (a register store of D) moves the mode-3 end, D counting up. */
function midLineRom(reg, cgb, extra = []) {
  const main = [0xF3, 0x31, 0xF0, 0xDF, ...extra,
    // loop: ldh a,(STAT) ; ld e,a ; ld a,d ; ldh (reg),a ; ldh a,(STAT) ; ld e,a ; inc d ; nop x n ; jr loop
    0xF0, 0x41, 0x5F, 0x7A, 0xE0, reg, 0xF0, 0x41, 0x5F, 0x14, 0x00, 0x18, 0xF3];
  return makeRom(main, {}, 0, { cgb });
}

/**
 * A scene with every PPU feature showing (patterned tiles and maps in both
 * banks, CGB palettes, 40 sprites, the window), then `loop` forever. The
 * picture after the frames is compared with gambatte's pixel for pixel.
 */
function sceneRom(cgb, loop) {
  const fill = [0x21, 0x00, 0x80, 0x7D, 0xAC, 0x07, 0x22, 0x7C, 0xFE, 0xA0, 0x20, 0xF7];   // [hl+] = rlc(l ^ h) up to $A000
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xE0, 0x40];
  if (cgb) {
    main.push(0x3E, 0x01, 0xE0, 0x4F, ...fill, 0xAF, 0xE0, 0x4F);          // VBK=1: tiles and attributes
    for (const idx of [0x68, 0x6A]) main.push(0x3E, 0x80, 0xE0, idx, 0x06, 0x40,
      0x78, 0xEE, idx === 0x68 ? 0x5A : 0x93, 0xE0, idx + 1, 0x05, 0x20, 0xF8);   // 64 palette bytes
  }
  main.push(...fill,
    0x21, 0x00, 0xFE, 0x06, 0x28,                                         // OAM: 40 sprites
    0x78, 0x07, 0x07, 0x22, 0x78, 0x07, 0x07, 0x07, 0x22, 0x78, 0x22, 0x78, 0x0F, 0x22, 0x05, 0x20, 0xEF,
    0x3E, 0xE4, 0xE0, 0x47, 0x3E, 0xD2, 0xE0, 0x48, 0x3E, 0x1B, 0xE0, 0x49,
    0x3E, 0x40, 0xE0, 0x4A, 0x3E, 0x50, 0xE0, 0x4B,                        // WY=$40, WX=$50
    0x3E, 0xE7, 0xE0, 0x40, 0x16, 0x00, 0x21, 0x00, 0x80);                 // LCDC=$E7 ; d=0 ; hl=$8000
  const L = main.length;
  main.push(...loop);
  main.push(0x18, (L - (main.length + 2)) & 0xFF);
  return makeRom(main, {}, 0, { cgb });
}

for (const cgb of [false, true]) {
  const m = cgb ? "CGB" : "DMG";
  test(`${m}: the scene drawn as gambatte's PPU draws it (tiles, maps, attributes, sprites, window)`, { skip, timeout: 180000 }, async () => {
    await assertLockstep(sceneRom(cgb, [0x00]), 12);
  });
  test(`${m}: the frame handed out has line 143 drawn even when no write asked the PPU for it`, { skip, timeout: 180000 }, async () => {
    // SCY stepped at line 50 only, so the last line differs every frame and
    // nothing touches the PPU between line 143 and the blit
    await assertLockstep(sceneRom(cgb, [0xF0, 0x44, 0xFE, 0x32, 0x20, 0xFA, 0xF0, 0x42, 0x3C, 0xE0, 0x42,
      0xF0, 0x44, 0xFE, 0x33, 0x20, 0xFA]), 12);
  });
  test(`${m}: palettes written during mode 3 change the picture at gambatte's pixel`, { skip, timeout: 180000 }, async () => {
    // BGP/OBP0 (DMG) or BCPD/OCPD (CGB) rewritten every few dots
    const loop = cgb ? [0x7A, 0xE0, 0x69, 0x2F, 0xE0, 0x6B, 0x14, 0x14] : [0x7A, 0xE0, 0x47, 0x2F, 0xE0, 0x48, 0x14];
    await assertLockstep(sceneRom(cgb, loop), 12);
  });
  test(`${m}: SCY, SCX and WX written during mode 3 move the rest of the line's pixels`, { skip, timeout: 180000 }, async () => {
    // d steps SCY, SCX (rotated) and WX (masked into 0..$A7)
    await assertLockstep(sceneRom(cgb, [0x7A, 0xE0, 0x42, 0x07, 0xE0, 0x43, 0xE6, 0x7F, 0xE0, 0x4B, 0x14]), 12);
  });
  test(`${m}: VRAM tile data and map writes during the frame show from the dot gambatte fetches them`, { skip, timeout: 180000 }, async () => {
    // [hl+] = d over $8000-$9FFF (dropped in mode 3), wrapping
    await assertLockstep(sceneRom(cgb, [0x7A, 0x22, 0x14, 0x7C, 0xE6, 0x1F, 0xF6, 0x80, 0x67]), 12);
  });
  test(`${m}: LCDC written during mode 3 (BG, window, OBJ, OBJ size, map and tile-data selects)`, { skip, timeout: 180000 }, async () => {
    await assertLockstep(sceneRom(cgb, [0x7A, 0xF6, 0x80, 0xE0, 0x40, 0x14, 0x00, 0x00]), 12);
  });
}

for (const cgb of [false, true]) {
  const m = cgb ? "CGB" : "DMG";
  test(`${m}: SCX written mid-line moves the rest of mode 3 (LCD::scxChange -> mode3CyclesChange)`, { skip, timeout: 180000 }, async () => {
    await assertLockstep(midLineRom(0x43, cgb), 30);
  });
  test(`${m}: WX written mid-line with the window on moves the rest of mode 3`, { skip, timeout: 180000 }, async () => {
    // LCDC=$F3 (window on, map $9C00), WY=0, OBJ on with sprites on every line
    const sprites = [];
    for (let i = 0; i < 10; i++) sprites.push(0x3E, 16 + i * 14, 0xEA, (i * 4) & 0xFF, 0xFE, 0x3E, 8 + i * 13, 0xEA, (i * 4 + 1) & 0xFF, 0xFE);
    await assertLockstep(midLineRom(0x4B, cgb, [0xAF, 0xE0, 0x40, ...sprites, 0xAF, 0xE0, 0x4A, 0x3E, 0xF3, 0xE0, 0x40]), 30);
  });
  test(`${m}: LCDC window/OBJ bits toggled mid-line move the rest of mode 3`, { skip, timeout: 180000 }, async () => {
    // D cycles through LCDC values with bit 7 set: $80|d (window, OBJ, OBJ size, BG all toggling)
    const main = [0xF3, 0x31, 0xF0, 0xDF, 0x3E, 0x07, 0xE0, 0x4B, 0xAF, 0xE0, 0x4A,
      0xF0, 0x41, 0x5F, 0x7A, 0xF6, 0x80, 0xE0, 0x40, 0xF0, 0x41, 0x5F, 0x14, 0x18, 0xF3];
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 30);
  });
  test(`${m}: OAM written and copied by DMA during the frame: the sprite map as gambatte's SpriteMapper reads it`, { skip, timeout: 180000 }, async () => {
    // loop: OAM[e & $9F] = d (y and x bytes change while the PPU scans),
    // STAT into E, an OAM DMA from $8000 every 256 passes, LCDC OBJ size toggling
    const main = [0xF3, 0x31, 0xF0, 0xDF, 0x3E, 0x83, 0xE0, 0x40,
      0x7B, 0xE6, 0x9F, 0x6F, 0x26, 0xFE, 0x72,   // loop: ld a,e ; and $9F ; ld l,a ; ld h,$FE ; ld (hl),d
      0xF0, 0x41, 0x5F, 0x14,                     // ldh a,(STAT) ; ld e,a ; inc d
      0x20, 0x0A,                                 // jr nz,+10 (skip the DMA/LCDC part)
      0x3E, 0x80, 0xE0, 0x46,                     // ldh (DMA),$80 (VRAM: the CPU keeps the ROM bus)
      0xF0, 0x40, 0xEE, 0x04, 0xE0, 0x40,         // LCDC ^= 4
      0x18, 0xE8];                                // jr loop
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 30);
  });
}

test("an IF write on the cycle of a line's LYC event sees it (LCD::update before IF is written)", { skip, timeout: 180000 }, async () => {
  // STAT=$40 (LYC), IE=0. loop: LYC = LY+1 ; wait C*4 cycles ; IF=0 ; E=IF ; C++
  const main = [0xF3, 0x3E, 0x40, 0xE0, 0x41, 0xAF, 0xE0, 0xFF,
    0xF0, 0x44, 0x3C, 0xE0, 0x45,            // loop: ldh a,(LY) ; inc a ; ldh (LYC),a
    0x41, 0x05, 0x20, 0xFD,                  // ld b,c ; w: dec b ; jr nz,w
    0xAF, 0xE0, 0x0F, 0xF0, 0x0F, 0x5F,      // xor a ; ldh (IF),a ; ldh a,(IF) ; ld e,a
    0x0C, 0x18, 0xEE];                       // inc c ; jr loop
  await assertLockstep(makeRom(main), 30);
});

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: an LYC or STAT write on the cycle of a line's LYC event sees it (LCD::update before the write)`, { skip, timeout: 180000 }, async () => {
    // STAT=$40 (LYC), IE=0. loop: IF=0 ; LYC = LY+1 ; wait C*4 cycles ;
    // LYC = $90 (or STAT = $40 on odd passes) ; E=IF ; C++
    const main = [0xF3, 0x3E, 0x40, 0xE0, 0x41, 0xAF, 0xE0, 0xFF,
      0xAF, 0xE0, 0x0F,                        // loop: xor a ; ldh (IF),a
      0xF0, 0x44, 0x3C, 0xE0, 0x45,            // ldh a,(LY) ; inc a ; ldh (LYC),a
      0x41, 0x05, 0x20, 0xFD,                  // ld b,c ; w: dec b ; jr nz,w
      0xCB, 0x41, 0x20, 0x06,                  // bit 0,c ; jr nz,stat
      0x3E, 0x90, 0xE0, 0x45, 0x18, 0x04,      // ld a,$90 ; ldh (LYC),a ; jr done
      0x3E, 0x40, 0xE0, 0x41,                  // stat: ld a,$40 ; ldh (STAT),a
      0xF0, 0x0F, 0x5F,                        // done: ldh a,(IF) ; ld e,a
      0x0C, 0x18, 0xE0];                       // inc c ; jr loop
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 30);
  });
}

/**
 * CGB: an HBlank DMA started on line $40 and, C*4 + (C>>4)*16 + 128 cycles
 * later, `action`; then E = $FF55 and D = VRAM $8000, and C++. The fine
 * delay is a jump into a 16-nop slide at $0300.
 * @param {number[]} action
 */
function hdmaSweepRom(action, start = [0x3E, 0x81, 0xE0, 0x55]) {
  const main = [0xF3, 0x31, 0xF0, 0xDF,
    0x3E, 0x40, 0xE0, 0x51, 0xAF, 0xE0, 0x52,   // source $4000
    0x3E, 0x80, 0xE0, 0x53, 0xAF, 0xE0, 0x54,   // destination $8000
    0x0E, 0x00];                                // ld c,0
  const L = 0x150 + main.length;
  main.push(0xF0, 0x44, 0xFE, 0x40, 0x20, 0xFA,  // loop: wait LY=$40
    ...start,
    0x79, 0xE6, 0x0F, 0x6F, 0x26, 0x03, 0xE9);  // ld a,c ; and $0F ; ld l,a ; ld h,$03 ; jp (hl)
  const after = [0x79, 0x1F, 0x1F, 0x1F, 0x1F, 0xE6, 0x0F, 0xC6, 0x08, 0x47,  // b = 8 + (c >> 4)
    0x05, 0x20, 0xFD,                           // w: dec b ; jr nz,w
    ...action,
    0xF0, 0x55, 0x5F,                           // ldh a,($55) ; ld e,a
    0x0C, 0xC3, lo(L), hi(L)];                  // inc c ; jp loop
  const bank1 = Array.from({ length: 0x100 }, (_, i) => (i * 7 + 1) & 0xFF);
  return makeRom(main, { 0x300: [...new Array(16).fill(0x00), ...after], 0x4000: bank1 }, 0, { cgb: true });
}

test("CGB: an HBlank DMA disabled on the cycle its block is requested still moves it (LCD::disableHdma runs update first)", { skip, timeout: 180000 }, async () => {
  await assertLockstep(hdmaSweepRom([0xAF, 0xE0, 0x55]), 140);
});

test("CGB: $FF55 written with bit 7 while an HBlank DMA runs only changes its length", { skip, timeout: 180000 }, async () => {
  await assertLockstep(hdmaSweepRom([0x3E, 0x80, 0xE0, 0x55]), 140);
});

test("CGB: the LCD switched off during an HBlank DMA moves one block at once (flagHdmaReq) and ends it", { skip, timeout: 180000 }, async () => {
  // LCD off and on again, then two VBlanks so frames are handed out
  const vbl = [0xF0, 0x44, 0xFE, 0x90, 0x20, 0xFA];
  await assertLockstep(hdmaSweepRom([0xAF, 0xE0, 0x40, 0x3E, 0x91, 0xE0, 0x40, ...vbl,
    0xF0, 0x44, 0xFE, 0x90, 0x28, 0xFA, ...vbl]), 140);
});

test("CGB: an HBlank DMA due inside STOP's speed-switch stall does not lengthen it", { skip, timeout: 180000 }, async () => {
  // HDMA of one block, then KEY1=1 ; stop at the sweeping delay
  await assertLockstep(hdmaSweepRom([0x3E, 0x01, 0xE0, 0x4D, 0x10, 0x00], [0x3E, 0x80, 0xE0, 0x55]), 140);
});

test("CGB: HBlank DMA enabled after a mid-line SCX write predicts mode 0 from the PPU state (LCD::enableHdma)", { skip, timeout: 180000 }, async () => {
  // SCX = C & 7 written just before the enable
  const scx = [0x79, 0xE6, 0x07, 0xE0, 0x43, 0x3E, 0x80, 0xE0, 0x55];
  await assertLockstep(hdmaSweepRom([], scx), 140);
});

test("CGB: an HBlank DMA block requested before a timer interrupt is moved before the interrupt pushes", { skip, timeout: 180000 }, async () => {
  // the DMA copies the stack ($CFF0) where the interrupt pushes its return
  // address. loop: wait LY=$40 ; [$CFF0] = $1234 ; HDMA $CFF0 -> $8000 ;
  // C>>4 nops ; TIMA overflows in (16 - C&15) * 16 cycles (TAC=5) ; ei ; wait ;
  // di ; DE = VRAM $8000 ; C++. The timer vector is reti.
  const main = [0xF3, 0x31, 0xF2, 0xCF, 0xAF, 0xE0, 0x06, 0x3E, 0x05, 0xE0, 0x07, 0x3E, 0x04, 0xE0, 0xFF,
    0x0E, 0x00];
  const L = 0x150 + main.length;
  main.push(0xF0, 0x44, 0xFE, 0x40, 0x20, 0xFA,   // loop: wait LY=$40
    0x21, 0x34, 0x12, 0xE5, 0xE1,                 // ld hl,$1234 ; push hl ; pop hl
    0x3E, 0xCF, 0xE0, 0x51, 0x3E, 0xF0, 0xE0, 0x52, 0x3E, 0x80, 0xE0, 0x53, 0xAF, 0xE0, 0x54,
    0x3E, 0x80, 0xE0, 0x55,                       // HDMA one block
    0x79, 0x1F, 0x1F, 0x1F, 0x1F, 0xE6, 0x0F, 0x6F, 0x26, 0x03, 0xE9);  // slide by c >> 4
  const after = [0x79, 0xE6, 0x0F, 0xF6, 0xF0, 0xE0, 0x05,   // TIMA = $F0 | (c & 15)
    0xAF, 0xE0, 0x0F, 0xFB,                       // IF=0 ; ei
    0x06, 0x30, 0x05, 0x20, 0xFD, 0xF3,           // wait ; di
    0xFA, 0x00, 0x80, 0x5F, 0xFA, 0x01, 0x80, 0x57,    // e = [$8000] ; d = [$8001]
    0x0C, 0xC3, lo(L), hi(L)];
  const rom = makeRom(main, { 0x50: [0xD9], 0x300: [...new Array(16).fill(0x00), ...after] }, 0, { cgb: true });
  await assertLockstep(rom, 280);
});

test("CGB: a general DMA during an OAM DMA hands its bytes to the OAM DMA, and one reaching $10000 stops there", { skip, timeout: 180000 }, async () => {
  // LCD off. WRAM $C000.. = $11,$12,... loop: OAM DMA from $C000 ; C&15 nops
  // (slide) ; GDMA of one block $4100 -> $8000 ; wait ; E = sum of OAM ;
  // GDMA of 2 blocks to $FFF0 (wraps after one) ; D = $FF55 ; C++
  const main = [0xF3, 0x31, 0xF0, 0xDF, 0xAF, 0xE0, 0x40,
    0x21, 0x00, 0xC0, 0x06, 0xA0, 0x3E, 0x11, 0x22, 0x3C, 0x05, 0x20, 0xFB,   // fill $C000
    0x3E, 0x41, 0xE0, 0x51, 0xAF, 0xE0, 0x52,
    0x0E, 0x00];
  const L = 0x150 + main.length;
  main.push(0x3E, 0x80, 0xE0, 0x53, 0xAF, 0xE0, 0x54,   // loop: destination $8000
    0x3E, 0xC0, 0xE0, 0x46,                     // OAM DMA from $C000
    0x79, 0xE6, 0x0F, 0x6F, 0x26, 0x03, 0xE9);  // slide
  const after = [0xAF, 0xE0, 0x55,              // GDMA one block
    0x06, 0x40, 0x05, 0x20, 0xFD,               // wait
    0x21, 0x00, 0xFE, 0x06, 0xA0, 0xAF, 0x86, 0x2C, 0x05, 0x20, 0xFB, 0x5F,   // E = sum of OAM
    0x3E, 0xFF, 0xE0, 0x53, 0x3E, 0xF0, 0xE0, 0x54, 0x3E, 0x01, 0xE0, 0x55,   // GDMA 2 blocks to $FFF0
    0xF0, 0x55, 0x57,                           // D = $FF55
    0x0C, 0xC3, lo(L), hi(L)];
  const bank1 = Array.from({ length: 0x200 }, (_, i) => (i * 5 + 3) & 0xFF);
  const rom = makeRom(main, { 0x300: [...new Array(16).fill(0x00), ...after], 0x4000: bank1 }, 0, { cgb: true });
  await assertLockstep(rom, 10);
});

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: mode 0 enabled in STAT after the line's mode 0 arms the next line's event, not this one`, { skip, timeout: 180000 }, async () => {
    // LYC=$40, STAT=$40. loop: wait LY=$40 ; IF=0 ; wait (C&31)*16 ;
    // STAT=$08 ; E=IF ; STAT=$40 ; C++
    const main = [0xF3, 0x3E, 0x40, 0xE0, 0x45, 0xE0, 0x41, 0xAF, 0xE0, 0xFF, 0x0E, 0x00];
    const L = main.length;
    main.push(0xF0, 0x44, 0xFE, 0x40, 0x20, 0xFA,   // loop: wait LY=$40
      0xAF, 0xE0, 0x0F,                             // IF=0
      0x79, 0xE6, 0x1F, 0x47, 0x04, 0x05, 0x20, 0xFD,   // b = (c & 31) + 1 ; w: dec b ; jr nz
      0x3E, 0x08, 0xE0, 0x41, 0xF0, 0x0F, 0x5F,     // STAT=$08 ; E=IF
      0x3E, 0x40, 0xE0, 0x41, 0x0C);                // STAT=$40 ; inc c
    main.push(0x18, (L - (main.length + 2)) & 0xFF);  // jr loop
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 40);
  });
}

for (const cgb of [false, true]) {
  test(`${cgb ? "CGB" : "DMG"}: the LCD switched off on the cycle of a line's LYC event still requests it (lcdcChange updates first)`, { skip, timeout: 180000 }, async () => {
    // STAT=$40, LYC=$41, IE=0. loop: wait LY=$40 ; IF=0 ; wait C*4 ;
    // LCD off ; E = IF ; LCD on ; C++ ; three frames (after re-enabling the
    // LCD both cores hand the next frame out at the second VBlank; toggling
    // sooner, neither ever returns from a frame)
    const main = [0xF3, 0x3E, 0x40, 0xE0, 0x41, 0x3E, 0x41, 0xE0, 0x45, 0xAF, 0xE0, 0xFF, 0x0E, 0x00];
    const L = main.length;
    main.push(0xF0, 0x44, 0xFE, 0x40, 0x20, 0xFA,      // loop: wait LY=$40
      0xAF, 0xE0, 0x0F,                                // IF=0
      0x41, 0x05, 0x20, 0xFD,                          // ld b,c ; w: dec b ; jr nz,w
      0xAF, 0xE0, 0x40, 0xF0, 0x0F, 0x5F,              // LCD off ; E = IF
      0x3E, 0x91, 0xE0, 0x40, 0x0C,                    // LCD on ; inc c
      0x16, 0x03,                                      // ld d,3 ; v: wait LY=$90 then LY=0, d times
      0xF0, 0x44, 0xFE, 0x90, 0x20, 0xFA, 0xF0, 0x44, 0xB7, 0x20, 0xFB, 0x15, 0x20, 0xF3);
    main.push(0x18, (L - (main.length + 2)) & 0xFF);
    await assertLockstep(makeRom(main, {}, 0, { cgb }), 120);
  });
}

test("A and F are compared per instruction: an IF read into A that nothing else sees still has to match", { skip, timeout: 180000 }, async () => {
  // the LCD-off LYC sweep with the IF value kept only in A (no ld e,a):
  // before gambatte's trace carried af this divergence was invisible
  const main = [0xF3, 0x3E, 0x40, 0xE0, 0x41, 0x3E, 0x41, 0xE0, 0x45, 0xAF, 0xE0, 0xFF, 0x0E, 0x00];
  const L = main.length;
  main.push(0xF0, 0x44, 0xFE, 0x40, 0x20, 0xFA, 0xAF, 0xE0, 0x0F,
    0x41, 0x05, 0x20, 0xFD,
    0xAF, 0xE0, 0x40, 0xF0, 0x0F,                    // LCD off ; A = IF (and F from the cp below)
    0xFE, 0x02,                                      // cp 2
    0x3E, 0x91, 0xE0, 0x40, 0x0C,
    0x16, 0x03, 0xF0, 0x44, 0xFE, 0x90, 0x20, 0xFA, 0xF0, 0x44, 0xB7, 0x20, 0xFB, 0x15, 0x20, 0xF3);
  main.push(0x18, (L - (main.length + 2)) & 0xFF);
  await assertLockstep(makeRom(main), 120);
});

test("CGB: the line after a speed switch predicts mode 0 from where the PPU is", { skip, timeout: 180000 }, async () => {
  // KEY1=1 ; stop ; then STAT into E, switch again every 64 samples
  const main = [0xF3, 0xAF, 0xE0, 0xFF,
    0x3E, 0x01, 0xE0, 0x4D, 0x10, 0x00,      // loop: KEY1=1 ; stop
    0x06, 0x40, 0xF0, 0x41, 0x5F, 0x05, 0x20, 0xFA, // 64 x (ldh a,(STAT) ; ld e,a)
    0x14, 0x18, 0xF0];                        // inc d ; jr loop
  await assertLockstep(makeRom(main, {}, 0, { cgb: true }), 30);
});
