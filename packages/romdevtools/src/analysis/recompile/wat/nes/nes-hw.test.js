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
for (const [op, [m, mode]] of OPS) if (!BY.has(`${m} ${mode}`)) BY.set(`${m} ${mode}`, op);
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
      const one = (t) => (/^[a-z_]\w*$/i.test(t) ? (labels[t] ?? (final ? NaN : 0)) : num(t));
      const val = (t) => {
        if (t[0] === "<") return val(t.slice(1)) & 0xFF;
        if (t[0] === ">") return (val(t.slice(1)) >> 8) & 0xFF;
        const mm = t.match(/^([a-z_]\w*)-([a-z_]\w*)$/i);
        return mm ? (one(mm[1]) - one(mm[2])) & 0xFFFF : one(t);
      };
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
function romMap({ main, prgBanks, chrBanks, flags6, irq = "rti", tag8 = false, chr1k = false }) {
  const prg = new Uint8Array(prgBanks * 0x4000).fill(0xEA);
  const { bytes, labels } = asm(`${main}\nnmi_h:\nrti\nirq_h:\n${irq}`, 0xC000);
  for (let b = 0; b < prgBanks; b++) {
    const base = b * 0x4000;
    prg.set(bytes, base);
    const vec = (o, a) => { prg[base + o] = a & 0xFF; prg[base + o + 1] = a >> 8; };
    vec(0x3FFA, labels.nmi_h); vec(0x3FFC, 0xC000); vec(0x3FFE, labels.irq_h);
    prg[base + 0x3000] = b; prg[base + 0x3001] = 0xA0 | b;
  }
  // tag8: every 8KB bank k holds $C0|k at its offset $1F00 (MMC3 windows)
  if (tag8) for (let k = 0; k < prgBanks * 2; k++) prg[k * 0x2000 + 0x1F00] = 0xC0 | k;
  // CHR: byte 0 of each 4KB = $40|index (chr1k: of each 1KB = $80|index)
  const chr = new Uint8Array(chrBanks * 0x2000).map((_, i) => (chr1k ? ((i & 0x3FF) === 0 ? (i >> 10) | 0x80 : (i * 7) & 0xFF)
    : ((i & 0xFFF) === 0 ? (i >> 12) | 0x40 : (i * 7) & 0xFF)));
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

test("CHR RAM powers up filled like work RAM ($FF, fceumm FCEU_MemoryRand ramstate 0)", async () => {
  const r = rom({ main: PRO + chrRead(0x30) + "lda #$0E\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $32\n" + LOOP });
  r[5] = 0; // CHR RAM
  const x = await run(r.subarray(0, 16 + 0x4000), 2);
  assert.deepEqual([...x.ram.slice(0x30, 0x33)], [0xFF, 0xFF, 0xFF]);
  assertCpu(x, { pc: 49214, a: 255, x: 255, y: 0, s: 255, p: 132, count: -192 });
});

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

test("mapper 1: an instruction straddling the 16KB windows reads its operand through the CURRENT mapping ($dynop)", async () => {
  const r = rom({
    prgBanks: 4, flags6: 0x10,
    main: "sei\nsta $51\ncld\nldx #$FF\ntxs\nlda $50\ncmp #$42\nbeq done\nlda #$42\nsta $50\njmp $BFFF\ndone:\n" + LOOP,
  });
  r[5] = 1;
  const img = new Uint8Array(16 + 0x10000 + 0x2000);
  img.set(r.subarray(0, 16)); img.set(r.subarray(16, 16 + 0x10000), 16);
  img[16 + 0x3FFF] = 0xA9; img[16 + 0x4000] = 0x55; // bank 1's first byte is NOT mapped at $C000
  const x = await run(img, 2);
  assert.deepEqual([x.ram[0x50], x.ram[0x51]], [0x42, 0x78]);
  assert.ok(x.p.ndyn > 0);
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

// ---- undocumented opcodes (fceumm ops.h), from ROM and from RAM ------------------

const UNOFF = {
  anc: [[0x0B, "imm"], [0x2B, "imm"]], sax: [[0x87, "zp"], [0x97, "zpy"], [0x8F, "abs"], [0x83, "izx"]],
  arr: [[0x6B, "imm"]], alr: [[0x4B, "imm"]], atx: [[0xAB, "imm"]], axs: [[0xCB, "imm"]], xaa: [[0x8B, "imm"]], sbc: [[0xEB, "imm"]],
  lax: [[0xA7, "zp"], [0xB7, "zpy"], [0xAF, "abs"], [0xBF, "aby"], [0xA3, "izx"], [0xB3, "izy"]],
  las: [[0xBB, "aby"]], sha: [[0x93, "izy"], [0x9F, "aby"]], shy: [[0x9C, "abx"]], shx: [[0x9E, "aby"]], tas: [[0x9B, "aby"]],
  skb: [[0x04, "zp"], [0x14, "zpx"], [0x80, "imm"], [0x89, "imm"], [0xE2, "imm"], [0xF4, "zpx"]],
  nop: [[0x1A, "imp"], [0xFA, "imp"]], top: [[0x0C, "abs"], [0x1C, "abx"], [0xFC, "abx"]],
};
for (const [m, base] of [["slo", 0x00], ["rla", 0x20], ["sre", 0x40], ["rra", 0x60], ["dcp", 0xC0], ["isb", 0xE0]]) {
  UNOFF[m] = [[base + 7, "zp"], [base + 0x17, "zpx"], [base + 0xF, "abs"], [base + 0x1F, "abx"], [base + 0x1B, "aby"], [base + 3, "izx"], [base + 0x13, "izy"]];
}

/**
 * Two cases per opcode (pseudo-random A/X/Y/P/operand, indexed modes both
 * crossing and not crossing pages); each records A, X, Y, P, S and the operand
 * byte. `ram`: each case is copied to $0200 and JSR'd, so it runs through the
 * run-time executor ($dynop).
 */
let unoffSeed = 12345;
function unoffRom(names, ram) {
  const rnd = () => { unoffSeed = (unoffSeed * 1103515245 + 12345) & 0x7FFFFFFF; return (unoffSeed >> 8) & 0xFF; };
  const h = (v) => "$" + v.toString(16);
  const caseAsm = (op, mode, R) => {
    const A = rnd(), X = rnd(), Y = rnd(), M = rnd(), P = (rnd() & 0xCB) | 0x24;
    const idx = mode === "zpy" || mode === "aby" || mode === "izy" ? Y : X;
    let ea = 0x20, ops = [], pre = "";
    if (mode === "imm") ops = [M];
    else if (mode === "zp") ops = [0x20];
    else if (mode === "zpx" || mode === "zpy") ops = [(0x20 - idx) & 0xFF];
    else if (mode === "abs") { ea = 0x0320; ops = [0x20, 0x03]; }
    else if (mode === "abx" || mode === "aby") { ea = 0x0320; const b = (0x0320 - idx) & 0xFFFF; ops = [b & 0xFF, b >> 8]; }
    else if (mode === "izx") { ea = 0x0320; ops = [(0x30 - X) & 0xFF]; pre = "lda #$20\nsta $30\nlda #$03\nsta $31\n"; }
    else if (mode === "izy") { ea = 0x0320; const b = (0x0320 - Y) & 0xFFFF; ops = [0x30]; pre = `lda #${h(b & 0xFF)}\nsta $30\nlda #${h(b >> 8)}\nsta $31\n`; }
    const E = ea === 0x20 ? "$20" : "$0320";
    return `lda #${h(M)}\nsta ${E}\n${pre}tsx\nstx $43\nlda #${h(P)}\npha\nldx #${h(X)}\nldy #${h(Y)}\nlda #${h(A)}\nplp
.byte ${[op, ...ops].map(h).join(",")}
php\nsta ${h(R)}\nstx ${h(R + 1)}\nsty ${h(R + 2)}\npla\nsta ${h(R + 3)}\ntsx\nstx ${h(R + 4)}\nlda ${E}\nsta ${h(R + 5)}\nldx $43\ntxs\n`;
  };
  let main = "", snippets = "", k = 0;
  for (const n of names) for (const [op, mode] of UNOFF[n]) for (let c = 0; c < 2; c++) {
    const body = caseAsm(op, mode, 0x0400 + k * 6); k++;
    if (ram) snippets += `sn${k}:\n${body}rts\nsn${k}_end:\n`; else main += body;
  }
  if (ram) {
    for (let i = 1; i <= k; i++) main += `lda #<sn${i}\nsta $40\nlda #>sn${i}\nsta $41\nlda #sn${i}_end-sn${i}\nsta $42\njsr copyrun\n`;
    main += "loop:\ninc $10\njmp loop\ncopyrun:\nldy #0\ncp:\nlda ($40),y\nsta $0200,y\niny\ncpy $42\nbne cp\njmp $0200\n" + snippets;
  } else main += LOOP;
  return rom({ main: PRO + main, prgBanks: 2 });
}

test("undocumented opcodes: all 93 that fceumm runs, from ROM arms and from RAM (the run-time executor)", async () => {
  const names = Object.keys(UNOFF), half = Math.ceil(names.length / 2);
  const want = {
    rom0: ["69aeef2c65cfa7015fc486dcbe63c2ec87e33b8ae6db3b94cebdd55ebc9d9bdb", { pc: 51253, a: 0, x: 255, y: 200, s: 255, p: 101, count: -48 }],
    ram0: ["3aeda3307eaf6a59f34371d481d3e22b0effa16ffe479ec1d93b11534c05ae60", { pc: 49817, a: 3, x: 253, y: 179, s: 255, p: 173, count: -96 }],
    rom1: ["e8299adb423a9d721286d727ee7baeea14964f3faefb71d08879fa30523158c2", { pc: 54483, a: 24, x: 255, y: 35, s: 255, p: 172, count: -48 }],
    ram1: ["2510aef7c76dde4e6b566e63cde5a7f4167cf560ad92c1e44841fd409de50883", { pc: 50807, a: 31, x: 253, y: 191, s: 255, p: 45, count: -48 }],
  };
  const { createHash } = await import("node:crypto");
  unoffSeed = 12345; // the four images are generated in this order from one seed
  for (const [key, [sha, cpu]] of Object.entries(want)) {
    const part = key.endsWith("0") ? names.slice(0, half) : names.slice(half);
    const r = await run(unoffRom(part, key.startsWith("ram")), 4);
    assert.equal(createHash("sha256").update(r.ram).digest("hex"), sha, `${key}: RAM (2KB) differs from fceumm's`);
    assertCpu(r, cpu);
    if (key.startsWith("ram")) assert.ok(r.p.ndyn > 1000, "the cases ran through $dynop");
  }
});

test("code in RAM: a routine copied to $0300 runs (branches, JSR/RTS, JMP (ind) and a self-modified operand)", async () => {
  // $0300: ldx #5 ; l: inc $50 ; dex ; bne l ; jsr $0320 ; jmp ($0330)   $0320: inc $51 ; rts
  // $0340 (via $0330): lda #$99 ; sta $0341 (patches its own operand) ; lda #$00 ; sta $52 ; rts-less: jmp done
  const r = await run(rom({
    main: PRO + `ldx #0
cp:
lda code,x
sta $0300,x
inx
cpx #$60
bne cp
lda #$40
sta $0330
lda #$03
sta $0331
jsr $0300
lda #$77
sta $55
` + LOOP + `code:
.byte $A2,$05,$E6,$50,$CA,$D0,$FB,$20,$20,$03,$6C,$30,$03,$00,$00,$00
.byte $00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00
.byte $E6,$51,$60,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00
.byte $00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00
.byte $A9,$11,$8D,$46,$03,$A9,$00,$85,$52,$A9,$99,$8D,$41,$03,$A5,$50
.byte $85,$53,$60,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00,$00`,
  }), 2);
  // $0340: lda #$11 ; sta $0346 ; lda #$00(->$11) ; sta $52 ; lda #$99 ; sta $0341 ; lda $50 ; sta $53 ; rts
  assert.deepEqual([...r.ram.slice(0x50, 0x56)], [4, 0, 0x11, 4, 0xFF, 0x77]);
  assert.equal(r.ram[0x341], 0x99);
  assert.ok(r.p.ndyn > 0);
  assert.equal(r.p.trapped, 0);
});

// ---- mapper 4 (MMC3, fceumm boards/mmc3.c) --------------------------------------

const m3 = (r, v) => `lda #$${r.toString(16)}\nsta $8000\nlda #$${v.toString(16)}\nsta $8001\n`;
const chr1kRead = (zz, hi) => `lda $2002\nlda #$${hi.toString(16)}\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $${zz.toString(16)}\n`;

test("mapper 4 (MMC3): 8KB PRG windows in both PRG modes, 2KB/1KB CHR banks with the A12 inversion, mirroring", async () => {
  const r = await run(romMap({
    prgBanks: 8, chrBanks: 4, flags6: 0x40, tag8: true, chr1k: true,
    main: PRO + m3(6, 4) + m3(7, 5) + "lda $9F00\nsta $30\nlda $BF00\nsta $31\nlda $DF00\nsta $32\nlda $FF00\nsta $33\n" +
      "lda #$46\nsta $8000\nlda $9F00\nsta $34\nlda $DF00\nsta $35\n" +
      m3(0x40, 0x0A) + m3(0x42, 9) + m3(0x45, 0x0D) + m3(0x41, 0x13) +
      chr1kRead(0x36, 0x00) + chr1kRead(0x37, 0x04) + chr1kRead(0x38, 0x0C) + chr1kRead(0x39, 0x10) + chr1kRead(0x3A, 0x1C) +
      "lda #$80\nsta $8000\n" + chr1kRead(0x3E, 0x00) + chr1kRead(0x3F, 0x10) + chr1kRead(0x40, 0x14) +
      "lda #$81\nsta $8000\nlda #$FE\nsta $8001\n" + chr1kRead(0x41, 0x18) +
      "lda #$01\nsta $A000\nlda #$20\nsta $2006\nlda #$00\nsta $2006\nlda #$5A\nsta $2007\nlda #$24\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $3C\n" +
      "lda #$00\nsta $A000\nlda #$28\nsta $2006\nlda #$00\nsta $2006\nlda $2007\nlda $2007\nsta $3D\n" + LOOP,
  }), 3);
  assert.deepEqual([...r.ram.slice(0x30, 0x42)], [196, 197, 206, 207, 206, 196, 138, 139, 147, 137, 141, 255, 90, 90, 137, 138, 139, 158]);
  assertCpu(r, { pc: 49519, a: 90, x: 255, y: 0, s: 255, p: 4, count: -80 });
});

test("mapper 4 (MMC3): the scanline IRQ counter (latch, reload, ack/enable) fires on fceumm's lines", async () => {
  const r = await run(romMap({
    prgBanks: 2, chrBanks: 1, flags6: 0x40,
    main: PRO + "lda #$40\nsta $4017\nldx #0\nvw:\nbit $2002\nbpl vw\nlda #$1E\nsta $2001\nlda #$21\nsta $C000\nsta $C001\nsta $E001\nldy #0\ncli\n" + LOOP,
    irq: "pha\nlda $10\nsta $0300,y\nlda $2002\nsta $0340,y\niny\nsta $E000\nlda $0400\nsta $C000\nclc\nadc #7\nsta $0400\nsta $E001\ninc $20\npla\nrti",
  }), 12);
  assert.deepEqual([...r.ram.slice(0x300, 0x320)], [248, 79, 170, 104, 138, 15, 248, 68, 30, 50, 168, 130, 234, 139, 144, 34, 237, 71, 217, 249, 82, 57, 89, 7, 25, 99, 59, 119, 22, 239, 85, 31]);
  assert.equal(r.ram[0x20], 31);
  assert.deepEqual([...r.ram.slice(0x1FC, 0x200)], [33, 32, 38, 192]);
  assertCpu(r, { pc: 49190, a: 33, x: 0, y: 32, s: 255, p: 160, count: -144 });
});

// ---- audio (fceumm sound.c low-quality renderer + SexyFilter, apu.js) ------------

/** Run 5 settle frames, then `frames` frames, returning the int16 stereo stream after the settle. */
async function runAudio(romBytes, frames, opts = {}) {
  const { bytes } = await assembleWat(emitWat(romBytes, opts));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const e = instance.exports;
  const info = e.wc_get_info(); e.wc_init();
  const dv = () => new DataView(e.memory.buffer);
  const u32 = (a) => dv().getUint32(a, true);
  const aptr = u32(info + 16), cap = u32(info + 20), wptr = u32(info + 24);
  assert.equal(u32(info + 52), 48000);
  assert.equal(u32(info + 48) & 1, 0, "s16 ring");
  let read = 0; const out = [];
  const drain = (keep) => { const w = u32(wptr); while (read !== w) { if (keep) out.push(dv().getInt16(aptr + read * 4, true), dv().getInt16(aptr + read * 4 + 2, true)); read = (read + 1) % cap; } };
  for (let i = 0; i < 5; i++) { e.wc_render(); drain(false); }
  for (let i = 0; i < frames; i++) { e.wc_render(); drain(true); }
  const s = Int16Array.from(out);
  const { createHash } = await import("node:crypto");
  return { n: s.length, sha: createHash("sha256").update(Buffer.from(s.buffer)).digest("hex"), s };
}

const APU_MAIN = `sei
cld
ldx #$FF
txs
lda #$1F
sta $4015
lda #$9A
sta $4000
lda #$A1
sta $4001
lda #$80
sta $4002
lda #$18
sta $4003
lda #$5F
sta $4004
lda #$00
sta $4005
lda #$20
sta $4006
lda #$41
sta $4007
lda #$7F
sta $4008
lda #$40
sta $400A
lda #$40
sta $400B
lda #$1C
sta $400C
lda #$85
sta $400E
lda #$58
sta $400F
lda #$0F
sta $4010
lda #$40
sta $4011
lda #$00
sta $4012
lda #$10
sta $4013
lda #$1F
sta $4015
lda #$80
sta $2000
loop:
inc $10
jmp loop`;
const APU_NMI = `inc $20
lda $20
and #$0F
bne n1
lda #$18
sta $4003
lda $20
sta $4011
lda #$1F
sta $4015
n1:
lda $20
and #$1F
bne n2
lda $400E
lda #$05
sta $400E
lda #$C0
sta $4017
lda #$28
sta $400F
n2:
lda $20
and #$3F
bne n3
lda #$40
sta $4017
lda #$D3
sta $4004
lda #$19
sta $4007
n3:
rti`;

test("audio: every channel, envelope, sweep, linear counter, noise mode, DMC and $4011 write is sample-exact with fceumm's stream", async () => {
  const r = rom({ main: APU_MAIN, nmi: APU_NMI });
  const a = await runAudio(r, 150);
  // fceumm through romdev audioDebug({op:'record'}) over the same 150 frames after loadMedia:
  // 119795 stereo frames, sha256 of the s16 stream
  assert.equal(a.n, 239590);
  assert.equal(a.sha, "c4fe7ce5fb1042f421054a7494ac4a3a57756b6d8c68ed26d9417ed635531429");
  for (let i = 0; i < a.n; i += 2) if (a.s[i] !== a.s[i + 1]) assert.fail(`L != R at ${i}`);
  // must-fail controls: dropping any one channel changes the stream
  for (const ch of ["sq1", "sq2", "tri", "noise", "dmc"]) {
    const m = await runAudio(r, 150, { muteChannels: [ch] });
    assert.equal(m.n, 239590);
    assert.notEqual(m.sha, a.sha, `muting ${ch} left the stream unchanged`);
  }
});
