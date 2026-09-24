// NES WAT backend: hardware rules checked by RUNNING tiny synthetic ROMs in
// the recompiled cart. Every expected value below was measured on fceumm
// (the reference core) through romdev with the same ROM and the same total
// frame count (5 settle frames + N stepped), so these are the reference's
// answers, not the backend's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { describe as describeRom, emitWat, PROBE_FIELDS } from "./index.js";
import { OPS, LEN } from "./cpu.js";
import { assembleWat } from "../assemble.js";

// ---- a tiny 6502 assembler over cpu.js's own opcode table ------------------
const BY = new Map();
for (const [op, [m, mode]] of OPS) BY.set(`${m} ${mode}`, op);
const num = (s) => (s.startsWith("$") ? parseInt(s.slice(1), 16) : parseInt(s, 10));
const BR = new Set(["bpl", "bmi", "bvc", "bvs", "bcc", "bcs", "bne", "beq"]);

/** @param {string} src @param {number} org */
function asm(src, org) {
  const lines = src.split("\n").map((l) => l.trim()).filter(Boolean);
  const labels = {};
  const pass = (final) => {
    let pc = org;
    const out = [];
    for (const l of lines) {
      if (l.endsWith(":")) { labels[l.slice(0, -1)] = pc; continue; }
      if (l.startsWith(".byte")) { const b = l.slice(5).split(",").map((t) => num(t.trim())); out.push(...b); pc += b.length; continue; }
      const [m, ...rest] = l.split(/\s+/);
      const arg = rest.join("");
      const val = (t) => (/^[a-z_]\w*$/i.test(t) ? (labels[t] ?? (final ? NaN : 0)) : num(t));
      let mode, v = 0;
      if (!arg) mode = ["asl", "lsr", "rol", "ror"].includes(m) ? "acc" : "imp";
      else if (arg[0] === "#") { mode = "imm"; v = val(arg.slice(1)); }
      else if (/^\(.*\),y$/.test(arg)) { mode = "izy"; v = val(arg.slice(1, -3)); }
      else if (/^\(.*\)$/.test(arg)) { mode = "ind"; v = val(arg.slice(1, -1)); }
      else {
        const mm = arg.match(/^(.*),([xy])$/);
        const base = mm ? mm[1] : arg, idx = mm ? mm[2] : "";
        v = val(base);
        if (BR.has(m)) mode = "rel";
        else {
          const zp = v < 0x100 && /^\$?[0-9a-f]+$/i.test(base) && m !== "jmp" && m !== "jsr";
          mode = zp ? "zp" + idx : (idx ? "ab" + idx : "abs");
          if (zp && !BY.has(`${m} ${mode}`)) mode = idx ? "ab" + idx : "abs";
        }
      }
      const op = BY.get(`${m} ${mode}`);
      if (op === undefined) throw new Error(`no opcode for '${l}'`);
      out.push(op);
      if (mode === "rel") out.push((v - (pc + 2)) & 0xFF);
      else if (LEN[mode] === 2) out.push(v & 0xFF);
      else if (LEN[mode] === 3) out.push(v & 0xFF, (v >> 8) & 0xFF);
      if (final && Number.isNaN(v)) throw new Error(`undefined label in '${l}'`);
      pc += LEN[mode];
    }
    return out;
  };
  pass(false);
  return { bytes: pass(true), labels };
}

/** 16KB NROM: `main` at $C000, NMI/IRQ handlers after it. */
function rom({ main, nmi = "rti", irq = "rti", flags6 = 0x01, flags7 = 0, prgBanks = 1 }) {
  const prg = new Uint8Array(prgBanks * 0x4000).fill(0xEA);
  const { bytes, labels } = asm(`${main}\nnmi_h:\n${nmi}\nirq_h:\n${irq}`, 0xC000);
  const base = prg.length - 0x4000;
  prg.set(bytes, base);
  const vec = (o, a) => { prg[o] = a & 0xFF; prg[o + 1] = a >> 8; };
  vec(prg.length - 6, labels.nmi_h); vec(prg.length - 4, 0xC000); vec(prg.length - 2, labels.irq_h);
  const chr = new Uint8Array(0x2000).map((_, i) => (i * 7) & 0xFF);
  const out = new Uint8Array(16 + prg.length + chr.length);
  out.set([0x4E, 0x45, 0x53, 0x1A, prgBanks, 1, flags6, flags7]);
  out.set(prg, 16); out.set(chr, 16 + prg.length);
  return out;
}

/** Run the cart for 5 + frames wc_render calls; return RAM, probe, framebuffer. */
async function run(romBytes, frames) {
  const { bytes } = await assembleWat(emitWat(romBytes));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  e.wc_get_info(); e.wc_init();
  for (let i = 0; i < 5 + frames; i++) e.wc_render();
  const mem = new Uint8Array(e.memory.buffer);
  const dv = new DataView(e.memory.buffer);
  const p = Object.fromEntries(PROBE_FIELDS.map((f, i) => [f, dv.getInt32(0x8000 + 4 * i, true)]));
  /** @param {number} x @param {number} y */
  const rgb = (x, y) => { const v = dv.getUint32(0x70000 + (y * 256 + x) * 4, true); return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF]; };
  return { ram: mem.slice(0, 0x800), p, rgb };
}

/** fceumm's cpu({op:'read'}) for the same run: pc, A, X, Y, S, P (masked 0xCF), X.count. */
function assertCpu(r, want) {
  assert.deepEqual(
    { pc: r.p.pc, a: r.p.a, x: r.p.x, y: r.p.y, s: r.p.s, p: r.p.p & 0xCF, count: r.p.cnt },
    { ...want, p: want.p & 0xCF });
  assert.equal(r.p.trapped, 0);
}

const PRO = "sei\ncld\nldx #$FF\ntxs\n";
const LOOP = "loop:\ninc $10\njmp loop\n";
const WAIT = "ldx #$40\nw1:\nldy #0\nw2:\ndey\nbne w2\ndex\nbne w1\n";

test("$4015 reads the length counters: loaded by $4003/7/B/F, clocked by the 4-step sequencer, held by the halt bit", async () => {
  const r = await run(rom({
    main: PRO + "lda #$0F\nsta $4015\nlda #$20\nsta $4000\nlda #$00\nsta $4004\nsta $4008\nsta $400C\n" +
      "lda #$08\nsta $4003\nlda #$18\nsta $4007\nlda #$28\nsta $400B\nlda #$00\nsta $400F\nldy #0\nlda #$80\nsta $2000\n" + LOOP,
    nmi: "lda $4015\nsta $0300,y\niny\nrti",
  }), 40);
  assert.deepEqual([...r.ram.slice(0x300, 0x300 + 43)], [9, 9, 9, ...new Array(40).fill(1)]);
  assertCpu(r, { pc: 49207, a: 1, x: 255, y: 43, s: 255, p: 164, count: -192 });
});

test("$4017 bit 7: 5-step sequencing clocks at the write and changes the length timing", async () => {
  const r = await run(rom({
    main: PRO + "lda #$0F\nsta $4015\nlda #$00\nsta $4000\nsta $4004\nsta $4008\nsta $400C\nlda #$C0\nsta $4017\n" +
      "lda #$10\nsta $4003\nlda #$20\nsta $4007\nlda #$30\nsta $400B\nlda #$40\nsta $400F\nldy #0\nlda #$80\nsta $2000\n" + LOOP,
    nmi: "lda $4015\nsta $0300,y\niny\nrti",
  }), 60);
  assert.deepEqual([...r.ram.slice(0x300, 0x300 + 63)],
    [...new Array(11).fill(15), ...new Array(13).fill(14), ...new Array(25).fill(12), ...new Array(14).fill(8)]);
  assertCpu(r, { pc: 49208, a: 8, x: 255, y: 63, s: 255, p: 36, count: -48 });
});

test("frame IRQ: $4017=0 enables it, it vectors through $FFFE, a $4015 read acks it", async () => {
  const r = await run(rom({ main: PRO + "lda #$00\nsta $4017\nldy #0\ncli\n" + LOOP, irq: "inc $20\nlda $4015\nsta $0300,y\niny\nrti" }), 30);
  assert.equal(r.ram[0x20], 33);
  assert.deepEqual([...r.ram.slice(0x300, 0x300 + 34)], new Array(34).fill(0x40));
  assert.deepEqual([...r.ram.slice(0x1FD, 0x200)], [160, 15, 192], "the interrupted pc and P on the stack");
  assertCpu(r, { pc: 49167, a: 64, x: 255, y: 34, s: 255, p: 32, count: -144 });
});

test("an IRQ nobody acknowledges is level-triggered: re-taken right after RTI", async () => {
  const r = await run(rom({ main: PRO + "lda #$00\nsta $4017\ncli\n" + LOOP, irq: "inc $20\nbne irqx\ninc $21\nirqx:\nrti" }), 8);
  assert.deepEqual([r.ram[0x10], r.ram[0x20], r.ram[0x21]], [144, 105, 66]);
  assertCpu(r, { pc: 49175, a: 0, x: 255, y: 0, s: 252, p: 36, count: -96 });
});

test("DMC IRQ at the end of a sample: $4015 bit 7, acked and restarted by a $4015 write", async () => {
  const r = await run(rom({
    main: PRO + "lda #$8F\nsta $4010\nlda #$00\nsta $4012\nlda #$01\nsta $4013\nlda #$10\nsta $4015\nldy #0\ncli\n" + LOOP,
    irq: "inc $20\nlda $4015\nsta $0300,y\niny\nlda #$10\nsta $4015\nrti",
  }), 20);
  assert.equal(r.ram[0x20], 100);
  assert.deepEqual([...r.ram.slice(0x300, 0x300 + 101)], new Array(101).fill(0x80));
  assertCpu(r, { pc: 49182, a: 16, x: 255, y: 101, s: 255, p: 32, count: -144 });
});

test("CLI and PLP: a pending IRQ waits one more instruction (fceumm's _PI)", async () => {
  const body = "lda #1\nsta $30\nlda #2\nsta $31\nsei\n";
  const irq = "lda $30\nsta $40\nlda $31\nsta $41\nlda $4015\nsta $42\ninc $20\nrti";
  const c = await run(rom({ main: PRO + "lda #$00\nsta $4017\n" + WAIT + "cli\n" + body + "lda #3\nsta $32\n" + LOOP, irq }), 30);
  // taken after `lda #1`: the handler saw $30 unwritten and left A = $40 for `sta $30`
  assert.deepEqual([...c.ram.slice(0x30, 0x33)], [0x40, 2, 3]);
  assert.deepEqual([...c.ram.slice(0x40, 0x43)], [0xFF, 0xFF, 0x40]);
  assert.deepEqual([...c.ram.slice(0x1FD, 0x200)], [32, 23, 192]);
  assertCpu(c, { pc: 49186, a: 3, x: 0, y: 0, s: 255, p: 164, count: -48 });
  const p = await run(rom({ main: PRO + "lda #$00\nsta $4017\n" + WAIT + "lda #$00\npha\nplp\n" + body + LOOP, irq }), 30);
  assert.deepEqual([...p.ram.slice(0x30, 0x32)], [0x40, 2]);
  assert.deepEqual([...p.ram.slice(0x1FD, 0x200)], [32, 26, 192]);
  assertCpu(p, { pc: 49187, a: 2, x: 0, y: 0, s: 255, p: 164, count: 0 });
});

test("open bus: an indexed read that crosses into unmapped space returns the base's high byte (X.DB)", async () => {
  const r = await run(rom({
    main: PRO + "ldx #$20\nlda $40F0,x\nsta $30\nlda #$F0\nsta $10\nlda #$40\nsta $11\nldy #$20\nlda ($10),y\nsta $31\n" +
      "lda $4110\nsta $32\nldx #$05\nlda $4000,x\nsta $33\nlda $5000\nsta $34\nldx #$10\nlda $4FF8,x\nsta $35\n" + LOOP,
  }), 4);
  assert.deepEqual([...r.ram.slice(0x30, 0x36)], [0x40, 0x40, 0x41, 0x40, 0x50, 0x4F]);
});

test("colour emphasis: each line's PPUMASK bits 5-7 pick fceumm's deemphasised palette", async () => {
  const setup = (mask) => PRO + `vw1:\nbit $2002\nbpl vw1\nvw2:\nbit $2002\nbpl vw2\nlda #$3F\nsta $2006\nlda #$00\nsta $2006
ldx #0\npal:\nlda paldata,x\nsta $2007\ninx\ncpx #16\nbne pal\nlda #$20\nsta $2006\nlda #$00\nsta $2006
ldx #0\nldy #4\nnt:\nstx $2007\ninx\nbne nt\ndey\nbne nt\nlda #0\nsta $2005\nsta $2005\nsta $2000\nlda #${mask}\nsta $2001
loop:\njmp loop\npaldata:\n.byte $0F,$16,$2A,$12,$0F,$21,$30,$27,$0F,$06,$1A,$3C,$0F,$00,$10,$20`;
  const px = async (mask, x) => (await run(rom({ main: setup(mask) }), 10)).rgb(x, 8);
  assert.deepEqual(await px("$0A", 2), [77, 223, 73]);
  assert.deepEqual(await px("$2A", 2), [95, 204, 54]);
  assert.deepEqual(await px("$CA", 2), [57, 220, 7]);
  assert.deepEqual(await px("$EA", 2), [57, 167, 54]);
  assert.deepEqual(await px("$4B", 0), [92, 127, 103], "greyscale and emphasis together");
});

// ---- header handling (ines.c) ------------------------------------------------

/** Overwrite the last 4 CHR bytes so crc32(PRG+CHR) == target (CRC is affine over GF(2)). */
function forgeCrc(romBytes, target) {
  const body = romBytes.subarray(16);
  const at = body.length - 4;
  const crcWith = (v) => { const b = Uint8Array.from(body); b[at] = v & 0xFF; b[at + 1] = (v >>> 8) & 0xFF; b[at + 2] = (v >>> 16) & 0xFF; b[at + 3] = v >>> 24; return crc32(b) >>> 0; };
  const c0 = crcWith(0);
  const cols = [];
  for (let i = 0; i < 32; i++) cols.push((crcWith((1 << i) >>> 0) ^ c0) >>> 0);
  // solve sum(x_i * cols[i]) = target ^ c0 by Gaussian elimination
  const rows = cols.map((c, i) => [c, (1 << i) >>> 0]);
  let want = (target ^ c0) >>> 0, x = 0;
  for (let bit = 31; bit >= 0; bit--) {
    const m = (1 << bit) >>> 0;
    const pi = rows.findIndex((r, k) => k >= 31 - bit && (r[0] & m));
    if (pi < 0) throw new Error("singular");
    [rows[31 - bit], rows[pi]] = [rows[pi], rows[31 - bit]];
    for (let k = 0; k < 32; k++) if (k !== 31 - bit && (rows[k][0] & m)) { rows[k][0] = (rows[k][0] ^ rows[31 - bit][0]) >>> 0; rows[k][1] = (rows[k][1] ^ rows[31 - bit][1]) >>> 0; }
  }
  for (let bit = 31; bit >= 0; bit--) if (want & ((1 << bit) >>> 0)) x = (x ^ rows[31 - bit][1]) >>> 0;
  const out = Uint8Array.from(romBytes);
  out.set([x & 0xFF, (x >>> 8) & 0xFF, (x >>> 16) & 0xFF, x >>> 24], 16 + at);
  assert.equal(crc32(out.subarray(16)) >>> 0, target);
  return out;
}

test("header: 'archaic' iNES (byte 7 bits 2-3 = 01/11) ignores byte 7, NES 2.0 reads byte 8", () => {
  assert.equal(describeRom(rom({ main: LOOP, flags6: 0x01, flags7: 0x44 })).mapper, 0);
  assert.equal(describeRom(rom({ main: LOOP, flags6: 0x01, flags7: 0x4C })).mapper, 0);
  assert.equal(describeRom(rom({ main: LOOP, flags6: 0x01, flags7: 0x40 })).mapper, 0x40);
  const n2 = rom({ main: LOOP, flags6: 0x01, flags7: 0x08 });
  n2[8] = 0x01; // mapper bits 8-11
  assert.equal(describeRom(n2).mapper, 0x100);
  assert.equal(describeRom(n2).nes2, true);
});

test("header: the ines-correct.h CRC32 table fixes mirroring and region as fceumm's CheckHInfo does", () => {
  // a mapper-0 row that forces HORIZONTAL; the header says vertical
  const fixedH = forgeCrc(rom({ main: LOOP, flags6: 0x01 }), 0xAF5D7AA2);
  const d = describeRom(fixedH);
  assert.equal(d.mirroring, "horizontal");
  assert.equal(d.headerFix.crc32, "af5d7aa2");
  assert.equal(d.supported, true);
  // a row that says mapper 3, vertical, region PAL
  const pal = describeRom(forgeCrc(rom({ main: LOOP, flags6: 0x00 }), 1669047560));
  assert.equal(pal.mapper, 3);
  assert.equal(pal.mirroring, "vertical");
  assert.equal(pal.region, 1);
  assert.equal(pal.supported, false);
  // NES 2.0 images skip the table
  const n2 = forgeCrc(rom({ main: LOOP, flags6: 0x01, flags7: 0x08 }), 0xAF5D7AA2);
  assert.equal(describeRom(n2).headerFix, null);
});

test("header: an iNES 1.0 file named with a PAL tag runs as PAL in fceumm, so it is refused", () => {
  const r = rom({ main: LOOP });
  assert.equal(describeRom(r, { romPath: "/x/Some Game (U).nes" }).supported, true);
  const e = describeRom(r, { romPath: "/x/Some Game (E).nes" });
  assert.equal(e.region, 1);
  assert.equal(e.supported, false);
  assert.match(e.unsupportedReason, /PAL/);
});

// ---- mappers 1/2/3 (fceumm boards/datalatch.c, boards/mmc1.c) ------------------

/**
 * Banked test image: the code (and vectors) in EVERY 16KB bank so any mapping
 * of $C000 keeps running it; bank b has b at offset $3000 and $A0|b at $3001.
 * CHR: byte 0 of each 4KB = $40 | its 4KB index.
 */
function romMap({ main, prgBanks, chrBanks, flags6 }) {
  const prg = new Uint8Array(prgBanks * 0x4000).fill(0xEA);
  const { bytes, labels } = asm(`${main}\nnmi_h:\nrti\nirq_h:\nrti`, 0xC000);
  for (let b = 0; b < prgBanks; b++) {
    const base = b * 0x4000;
    prg.set(bytes, base);
    const vec = (o, a) => { prg[base + o] = a & 0xFF; prg[base + o + 1] = a >> 8; };
    vec(0x3FFA, labels.nmi_h); vec(0x3FFC, 0xC000); vec(0x3FFE, labels.irq_h);
    prg[base + 0x3000] = b; prg[base + 0x3001] = 0xA0 | b;
  }
  const chr = new Uint8Array(chrBanks * 0x2000).map((_, i) => ((i & 0xFFF) === 0 ? (i >> 12) | 0x40 : (i * 7) & 0xFF));
  const out = new Uint8Array(16 + prg.length + chr.length);
  out.set([0x4E, 0x45, 0x53, 0x1A, prgBanks, chrBanks, flags6, 0]);
  out.set(prg, 16); out.set(chr, 16 + prg.length);
  return out;
}
/** read CHR $0000 and $1000 through $2007 into zz, zz+1 */
const chrRead = (zz) => `lda $2002\nlda #$00\nsta $2006\nsta $2006\nlda $2007\nlda $2007\nsta $${zz.toString(16)}
lda #$10\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $${(zz + 1).toString(16)}\n`;
/** MMC1 serial write: 5 x (sta reg, lsr) */
const mmc1 = (reg, v) => `lda #$${v.toString(16)}\n` + Array.from({ length: 5 }, (_, i) => `sta $${reg.toString(16)}\n${i < 4 ? "lsr\n" : ""}`).join("");

test("mapper 2 (UxROM): $8000 window follows the latch, $C000 is the last bank, 8KB WRAM", async () => {
  const r = await run(romMap({
    prgBanks: 8, chrBanks: 0, flags6: 0x21,
    main: PRO + "ldx #0\nb1:\nstx $8000\nlda $B000\nsta $30,x\nlda $B001\nsta $38,x\ninx\ncpx #8\nbne b1\n" +
      "lda #$5A\nsta $6000\nlda $6000\nsta $40\nlda $F000\nsta $41\nlda #$13\nsta $8000\nlda $B000\nsta $42\n" + LOOP,
  }), 4);
  assert.deepEqual([...r.ram.slice(0x30, 0x43)], [0, 1, 2, 3, 4, 5, 6, 7, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0x5A, 7, 3]);
  assertCpu(r, { pc: 49202, a: 3, x: 8, y: 0, s: 255, p: 133, count: -48 });
});

test("mapper 2: an instruction at the end of a switchable bank reads its operand from $C000", async () => {
  // only the last bank holds code; bank 0 ends with `lda #imm` whose operand
  // byte is $C000's `sei` ($78), not bank 1's first byte
  const r = rom({
    prgBanks: 4, flags6: 0x21,
    main: "sei\nsta $51\ncld\nldx #$FF\ntxs\nlda $50\ncmp #$42\nbeq done\nlda #$42\nsta $50\nlda #0\nsta $8000\njmp $BFFF\ndone:\n" + LOOP,
  });
  r[4] = 4; r[5] = 0; // PRG 64KB, CHR RAM
  const img = new Uint8Array(16 + 0x10000);
  img.set(r.subarray(0, 16)); img.set(r.subarray(16, 16 + 0x10000), 16);
  img[16 + 0x3FFF] = 0xA9;
  const x = await run(img, 2);
  assert.deepEqual([x.ram[0x50], x.ram[0x51]], [0x42, 0x78]);
});

test("mapper 3 (CNROM): the latch picks the 8KB CHR bank the PPU sees (masked by the CHR size)", async () => {
  const r = await run(romMap({
    prgBanks: 2, chrBanks: 4, flags6: 0x31,
    main: PRO + "lda #0\nsta $8000\n" + chrRead(0x30) + "lda #2\nsta $8000\n" + chrRead(0x32) + "lda #7\nsta $8000\n" + chrRead(0x34) + LOOP,
  }), 4);
  assert.deepEqual([...r.ram.slice(0x30, 0x36)], [0x40, 0x41, 0x44, 0x45, 0x46, 0x47]);
  assertCpu(r, { pc: 49283, a: 71, x: 255, y: 0, s: 255, p: 132, count: -48 });
});

test("mapper 1 (MMC1): PRG modes, 4/8KB CHR, WRAM enable bit", async () => {
  const r = await run(romMap({
    prgBanks: 8, chrBanks: 4, flags6: 0x10,
    main: PRO + "lda #$80\nsta $8000\n" + mmc1(0x8000, 0x1E) + mmc1(0xE000, 2) + "lda $B000\nsta $30\n" +
      mmc1(0xE000, 5) + "lda $B000\nsta $31\n" + mmc1(0x8000, 0x12) + mmc1(0xE000, 3) + "lda $B000\nsta $32\nlda $F000\nsta $33\n" +
      mmc1(0x8000, 0x0E) + mmc1(0xE000, 6) + "lda $B000\nsta $34\nlda $F000\nsta $35\n" +
      mmc1(0x8000, 0x1C) + mmc1(0xA000, 5) + mmc1(0xC000, 2) + chrRead(0x36) + mmc1(0x8000, 0x0C) + mmc1(0xA000, 5) + chrRead(0x38) +
      "lda #$77\nsta $6000\nlda $6000\nsta $3A\n" + mmc1(0xE000, 0x10) + "lda $6000\nsta $3B\nlda #$11\nsta $6001\n" +
      mmc1(0xE000, 0x00) + "lda $6001\nsta $3C\n" + LOOP,
  }), 4);
  assert.deepEqual([...r.ram.slice(0x30, 0x3D)], [2, 5, 2, 3, 6, 7, 0x45, 0x42, 0x44, 0x45, 0x77, 0x60, 0]);
  assertCpu(r, { pc: 49587, a: 0, x: 255, y: 0, s: 255, p: 132, count: -48 });
});

test("mapper 1: a RMW's double write reaches the register and the busy window drops the second one", async () => {
  const r = await run(romMap({
    prgBanks: 8, chrBanks: 1, flags6: 0x10,
    main: PRO + mmc1(0x8000, 0x0E) + "inc ffbyte\n" + mmc1(0xE000, 3) + "lda $B000\nsta $30\nlda $F000\nsta $31\nldx #0\ninc ffbyte,x\n" +
      mmc1(0xE000, 5) + "lda $B000\nsta $32\n" + LOOP + "ffbyte:\n.byte $FF",
  }), 4);
  assert.deepEqual([...r.ram.slice(0x30, 0x33)], [3, 7, 5]);
  assertCpu(r, { pc: 49245, a: 5, x: 0, y: 0, s: 255, p: 132, count: -96 });
});

test("mapper 1: mirroring register (one-screen A/B, vertical, horizontal) and CHR RAM 4KB swaps", async () => {
  const w = (i) => `lda #$20\nsta $2006\nlda #$00\nsta $2006\nlda #$${(0x10 + i).toString(16)}\nsta $2007
lda #$24\nsta $2006\nlda #$00\nsta $2006\nlda #$${(0x20 + i).toString(16)}\nsta $2007\n` +
    [[0x20, 0], [0x24, 1], [0x28, 2]].map(([hi, k]) => `lda #$${hi.toString(16)}\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $${(0x30 + i * 3 + k).toString(16)}\n`).join("");
  const m = await run(romMap({ prgBanks: 2, chrBanks: 1, flags6: 0x10, main: PRO + [2, 3, 0, 1].map((mm, i) => mmc1(0x8000, mm | 0x0C) + w(i)).join("") + LOOP }), 4);
  assert.deepEqual([...m.ram.slice(0x30, 0x3C)], [0x10, 0x20, 0x10, 0x21, 0x21, 0x20, 0x22, 0x22, 0x22, 0x23, 0x23, 0x23]);
  assertCpu(m, { pc: 49579, a: 35, x: 255, y: 0, s: 255, p: 133, count: 0 });
  const c = await run(romMap({
    prgBanks: 2, chrBanks: 0, flags6: 0x10,
    main: PRO + mmc1(0x8000, 0x1C) + mmc1(0xA000, 0) + mmc1(0xC000, 1) + "lda #$00\nsta $2006\nsta $2006\nlda #$AA\nsta $2007\n" +
      "lda #$10\nsta $2006\nlda #$00\nsta $2006\nlda #$BB\nsta $2007\n" + mmc1(0xA000, 1) + mmc1(0xC000, 0) + chrRead(0x30) + LOOP,
  }), 4);
  assert.deepEqual([...c.ram.slice(0x30, 0x32)], [0xBB, 0xAA]);
  assertCpu(c, { pc: 49329, a: 170, x: 255, y: 0, s: 255, p: 132, count: -192 });
});

test("input devices: a cart fceumm gives a non-gamepad controller (ines.c SetInput) is refused", () => {
  const r = rom({ main: LOOP, flags6: 0x01 });
  r[15] = 0x08; // NES 2.0 default expansion device: Zapper in port 2
  const d = describeRom(r);
  assert.equal(d.supported, false);
  assert.match(d.unsupportedReason, /non-gamepad/);
  assert.deepEqual(d.inputDevices, [1, 2, 0]);
  r[15] = 0;
  assert.equal(describeRom(r).supported, true);
});
