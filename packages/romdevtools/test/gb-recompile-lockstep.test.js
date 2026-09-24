// Game Boy recompile vs gambatte, instruction by instruction from power-on.
//
// Each synthetic ROM below exercises one machine-model rule the WAT backend
// (src/analysis/recompile/wat/gb) must share with gambatte. The ROM is
// recompiled through the real pipeline (romdev's IR decode, emitWat, the
// streaming assembler), run in node's WebAssembly with a whole-frame
// instruction ring, and compared against romdev's gambatte's free-running
// trace: pc, the clock delta and sp/hl/bc/de of EVERY instruction. The
// programs move what they read into D/E, so a wrong value is a divergence.
//
// Skipped when gambatte is not staged or the gbz80 objdump (IR decode) is
// missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { emitWat, recompileSection } from "../src/analysis/recompile/wat/gb/index.js";
import { assembleWatSync } from "../src/analysis/recompile/wat/assemble.js";
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
 * Run the cart and gambatte side by side for `frames` frames and return the
 * first instruction that differs (null when none does).
 * @param {Uint8Array} rom
 * @param {number} frames
 */
async function lockstep(rom, frames) {
  const chunks = [];
  for await (const c of emitWat(rom, { traceEntries: 32768 })) chunks.push(c);
  const { instance } = await WebAssembly.instantiate(assembleWatSync(chunks.join("")), {});
  const x = instance.exports;
  const t = recompileSection(rom, "", { traceEntries: 32768 }).json.trace;
  x.wc_init();
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-gblock-"));
  const ref = new LibretroHost();
  try {
    const romPath = path.join(dir, "t.gb");
    writeFileSync(romPath, rom);
    await ref.loadCore(core.jsPath, core.wasmPath, { hwRender: core.hwRender, noderawfs: core.noderawfs });
    ref.setTrace({ capacity: 1 << 20, registers: true });
    await ref.loadMedia({ platform: rom[0x143] & 0x80 ? "gbc" : "gb", path: romPath });
    const cq = [], rq = [];
    let cgot = 0, rgot = 0, n = 0, off0 = null;
    const pull = () => {
      const dv = new DataView(x.memory.buffer);
      const cnt = dv.getUint32(t.cursor.offset, true);
      assert.ok(cnt - cgot <= t.entries, "the cart ring holds a whole frame");
      for (let i = cgot; i < cnt; i++) {
        const o = t.offset + (i % t.entries) * t.stride;
        cq.push([dv.getUint32(o, true) & 0xffff, dv.getUint32(o + 28, true), dv.getUint32(o + 8, true) & 0xffff,
          dv.getUint32(o + 12, true) & 0xffff, dv.getUint32(o + 16, true) & 0xffff, dv.getUint32(o + 20, true) & 0xffff]);
      }
      cgot = cnt;
      const r = ref.readTrace(rgot);
      assert.equal(r.lost, 0, "the reference trace lost nothing");
      for (let k = 0; k < r.pc.length; k++) rq.push([r.pc[k] & 0xffff, r.clock[k], r.regs.sp[k] & 0xffff, r.regs.hl[k] & 0xffff, r.regs.bc[k] & 0xffff, r.regs.de[k] & 0xffff]);
      rgot = r.to;
      while (cq.length && rq.length) {
        const c = cq.shift(), e = rq.shift();
        const d = (c[1] - e[1]) | 0;
        if (off0 === null) off0 = d;
        const names = ["pc", "clock", "sp", "hl", "bc", "de"];
        for (let k = 0; k < 6; k++) {
          const bad = k === 1 ? d !== off0 : c[k] !== e[k];
          if (bad) return { at: n, what: names[k], cart: c.map((v) => v.toString(16)), ref: e.map((v) => v.toString(16)) };
        }
        n++;
      }
      return null;
    };
    // the reference's settle frames are the cart's first renders
    let bad = null;
    for (let k = 0; k < ref.status.settleFramesUsed && !bad; k++) { x.wc_render(); bad = pull(); }
    for (let f = 0; f < frames && !bad; f++) { ref.stepFrames(1); x.wc_render(); bad = pull(); }
    return { bad, n };
  } finally {
    ref.dispose?.();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function assertLockstep(rom, frames) {
  const { bad, n } = await lockstep(rom, frames);
  assert.equal(bad, null, bad ? `diverged at instruction ${bad.at} (${bad.what}): cart ${bad.cart.join(" ")} vs gambatte ${bad.ref.join(" ")}` : "");
  assert.ok(n > 1000, `compared ${n} instructions`);
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

test("CGB: the line after a speed switch predicts mode 0 from where the PPU is", { skip, timeout: 180000 }, async () => {
  // KEY1=1 ; stop ; then STAT into E, switch again every 64 samples
  const main = [0xF3, 0xAF, 0xE0, 0xFF,
    0x3E, 0x01, 0xE0, 0x4D, 0x10, 0x00,      // loop: KEY1=1 ; stop
    0x06, 0x40, 0xF0, 0x41, 0x5F, 0x05, 0x20, 0xFA, // 64 x (ldh a,(STAT) ; ld e,a)
    0x14, 0x18, 0xF0];                        // inc d ; jr loop
  await assertLockstep(makeRom(main, {}, 0, { cgb: true }), 30);
});
