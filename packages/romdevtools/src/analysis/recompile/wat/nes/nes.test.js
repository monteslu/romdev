// NES WAT backend tests on tiny synthetic ROMs (never commercial ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as describeRom, emitWat, emitWatString, layout, recompileSection, platforms, PROBE_FIELDS } from "./index.js";
import { lower, Unsupported, OPS } from "./cpu.js";
import { backendFor } from "../index.js";

/**
 * Build an iNES image. `code` is placed at the start of the LAST 16KB bank
 * ($C000) with the reset vector pointing at it; NMI and IRQ point at an RTI.
 */
function synthRom({ code = [0x4C, 0x00, 0xC0], prgBanks = 1, chrBanks = 1, flags6 = 0x01, flags7 = 0, trainer = false } = {}) {
  const prg = new Uint8Array(prgBanks * 0x4000).fill(0xEA);
  const base = prg.length - 0x4000;
  prg.set(code, base);
  const rti = base + 0x3F00;
  prg[rti] = 0x40;
  const vec = (off, addr) => { prg[off] = addr & 0xFF; prg[off + 1] = addr >> 8; };
  vec(prg.length - 6, 0xFF00); // NMI -> RTI at $FF00
  vec(prg.length - 4, 0xC000); // RESET
  vec(prg.length - 2, 0xFF00); // IRQ
  const chr = new Uint8Array(chrBanks * 0x2000);
  for (let i = 0; i < chr.length; i++) chr[i] = (i * 7) & 0xFF;
  const hdr = new Uint8Array(16);
  hdr.set([0x4E, 0x45, 0x53, 0x1A, prgBanks, chrBanks, flags6 | (trainer ? 4 : 0), flags7]);
  const parts = [hdr];
  if (trainer) parts.push(new Uint8Array(512));
  parts.push(prg, chr);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Paren balance outside strings and ;; comments; returns the max depth or throws. */
function checkBalanced(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ";" && s[i + 1] === ";") { while (i < s.length && s[i] !== "\n") i++; }
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth < 0) throw new Error(`unbalanced ')' at ${i}`); }
  }
  assert.equal(depth, 0, "unclosed '('");
}

test("registry resolves nes to this backend", async () => {
  const b = await backendFor("nes");
  assert.deepEqual(b.platforms, ["nes"]);
  assert.equal(typeof b.emitWat, "function");
  assert.equal(typeof b.describe, "function");
  assert.deepEqual(platforms, ["nes"]);
});

test("describe parses the iNES header", () => {
  const d = describeRom(synthRom({ flags6: 0x01 }));
  assert.equal(d.mapper, 0);
  assert.equal(d.mapperName, "NROM");
  assert.equal(d.supported, true);
  assert.equal(d.mirroring, "vertical");
  assert.equal(d.chrRam, false);
  assert.equal(d.prgSize, 0x4000);
  assert.equal(d.chrSize, 0x2000);
  assert.equal(d.prgOffset, 16);
  assert.equal(d.arms, 0x4000);

  const h = describeRom(synthRom({ flags6: 0x00, chrBanks: 0, prgBanks: 2, trainer: true }));
  assert.equal(h.mirroring, "horizontal");
  assert.equal(h.chrRam, true);
  assert.equal(h.trainer, true);
  assert.equal(h.prgOffset, 16 + 512);
  assert.equal(h.prgSize, 0x8000);
});

test("describe reports unsupported mappers and rejects bad images", async () => {
  const m2 = describeRom(synthRom({ flags6: 0x21 }));      // mapper 2 (UxROM)
  assert.equal(m2.mapper, 2);
  assert.equal(m2.supported, false);
  assert.match(m2.unsupportedReason, /mapper 2/);
  await assert.rejects(emitWatString(synthRom({ flags6: 0x21 })), /mapper 2/);
  const m1 = describeRom(synthRom({ flags6: 0x10, flags7: 0x00 }));
  assert.equal(m1.mapper, 1);
  const hi = describeRom(synthRom({ flags6: 0x00, flags7: 0x40 })); // high nibble in flags7
  assert.equal(hi.mapper, 0x40);
  assert.throws(() => describeRom(new Uint8Array(32)), /not an iNES/);
  assert.throws(() => describeRom(synthRom().subarray(0, 100)), /header needs/);
});

test("cpu: taken-branch cost includes the page cross, from the arm's address", () => {
  const view = { fixedByte: () => 0 };
  // BNE +1 at $C0FD: next pc $C0FF, target $C100 -> other page, +2
  assert.match(lower(0xD0, 0x01, 0, view, 0xC0FD), /\(i32\.const 96\)\)\)\(global\.set \$ts \(i32\.add \(global\.get \$ts\) \(i32\.const 2\)\)\)/);
  // BNE +1 at $C000: same page, +1
  assert.match(lower(0xD0, 0x01, 0, view, 0xC000), /\(i32\.const 48\)\)\)/);
  // the displacement is relative to the RUNTIME pc
  assert.match(lower(0xD0, 0xFE, 0, view, 0xC000), /\(global\.get \$pc\) \(i32\.const 0\)/);
});

test("cpu: JMP (ind) keeps the 6502 page-wrap bug", () => {
  const s = lower(0x6C, 0xFF, 0x12, { fixedByte: () => 0 }, 0xC000);
  assert.match(s, /\(call \$rd8 \(i32\.const 4863\)\)/);  // $12FF
  assert.match(s, /\(call \$rd8 \(i32\.const 4608\)\)/);  // $1200, not $1300
});

test("cpu: ROM operands are folded only when the mapper says they are fixed", () => {
  const fixed = lower(0xAD, 0x05, 0xC0, { fixedByte: (a) => (a === 0xC005 ? 0x77 : null) }, 0xC000);
  assert.match(fixed, /\(global\.set \$a \(i32\.const 119\)\)/);
  const banked = lower(0xAD, 0x05, 0x80, { fixedByte: () => null }, 0xC000);
  assert.match(banked, /\(call \$rd8 \(i32\.const 32773\)\)/);
});

test("cpu: indexed I/O access does the dummy read, RAM access does not", () => {
  const io = lower(0xBD, 0x02, 0x20, { fixedByte: () => null }, 0xC000);  // LDA $2002,X
  assert.match(io, /\(drop \(call \$rd8 \(i32\.or \(i32\.const 8192\)/);
  const ram = lower(0xBD, 0x00, 0x03, { fixedByte: () => null }, 0xC000); // LDA $0300,X
  assert.doesNotMatch(ram, /drop/);
  assert.match(ram, /i32\.const 0x7FF/);
});

test("cpu: every official opcode lowers, every other byte is Unsupported", () => {
  const view = { fixedByte: () => 0 };
  let n = 0;
  for (let op = 0; op < 256; op++) {
    if (OPS.has(op)) {
      const s = lower(op, 0x34, 0x12, view, 0xC000);
      assert.match(s, /\$pc/, `opcode ${op.toString(16)} never sets $pc`);
      checkBalanced(s);
      n++;
    } else {
      assert.throws(() => lower(op, 0, 0, view, 0xC000), Unsupported);
    }
  }
  assert.equal(n, 151);
});

test("emitWat: one arm per PRG byte, traps for non-opcodes, balanced module", async () => {
  const rom = synthRom({ code: [0x78, 0xD8, 0xA2, 0xFF, 0x9A, 0x02, 0x4C, 0x00, 0xC0] }); // 0x02 is not official
  const stats = {};
  const chunks = [];
  for await (const c of emitWat(rom, { stats })) chunks.push(c);
  assert.ok(chunks.length > 10, "emitted as a stream of chunks");
  const wat = chunks.join("");
  checkBalanced(wat);
  assert.ok(wat.startsWith("(module"));
  assert.equal(stats.arms, 0x4000);
  assert.equal(stats.lowered + stats.trapped, 0x4000);
  // 0xEA fill (NOP) lowers; the 0x02 at $C005, and the vector bytes that are
  // not opcodes, trap
  assert.ok(stats.trapped >= 1);
  assert.match(wat, /\) ;; C005\n {4}\(call \$trap \(i32\.const 2\)\) \(return\)/);
  assert.equal((wat.match(/\(func \$shard\d+ /g) || []).length, 16);
  for (const f of ["wc_get_info", "wc_init", "wc_render"]) assert.match(wat, new RegExp(`\\(export "${f}"\\)`));
  // vertical mirroring picks CIRAM page by slot bit 0; CHR ROM has a data segment
  assert.match(wat, /\(i32\.and \(local\.get \$slot\) \(i32\.const 1\)\)/);
  assert.match(wat, /\(data \(i32\.const 393216\) "/);
});

test("emitWat: horizontal mirroring and CHR RAM change only their hooks", async () => {
  const wat = await emitWatString(synthRom({ flags6: 0x00, chrBanks: 0 }));
  checkBalanced(wat);
  assert.match(wat, /\(i32\.shr_u \(local\.get \$slot\) \(i32\.const 1\)\)/);
  assert.match(wat, /\(i32\.store8 \(i32\.add \(i32\.const 393216\) \(local\.get \$tmp\)\) \(local\.get \$v\)\)/);
  assert.doesNotMatch(wat, /\(data \(i32\.const 393216\) "/);
});

test("32KB NROM-256: arm addresses run $8000-$FFFF", async () => {
  const wat = await emitWatString(synthRom({ prgBanks: 2 }));
  checkBalanced(wat);
  assert.match(wat, /\) ;; 8000\n/);
  assert.match(wat, /\) ;; FFFF\n/);
  assert.equal((wat.match(/\(func \$shard\d+ /g) || []).length, 32);
});

test("layout and the romdev.recompile section describe the compared regions", () => {
  assert.deepEqual(Object.keys(layout.regions), ["ram", "nametables", "palette", "oam"]);
  assert.equal(layout.regions.ram.ref, "system_ram");
  assert.equal(layout.probe.fields.cnt.type, "i32");
  assert.equal(Object.keys(layout.probe.fields).length, PROBE_FIELDS.length);
  const sec = recompileSection(synthRom(), "ab".repeat(20));
  assert.equal(sec.name, "romdev.recompile");
  const j = JSON.parse(JSON.stringify(sec.json));
  assert.equal(j.platform, "nes");
  assert.equal(j.referenceCore, "fceumm");
  assert.equal(j.regions.oam.offset, 0x5100);
  assert.equal(j.conventions.totalFrameOffset, 0);
});

test("describe zeroes a 'DiskDude!' header tail as fceumm does", () => {
  const rom = synthRom({ flags6: 0x01 });
  rom.set([..."DiskDude!"].map((c) => c.charCodeAt(0)), 7);
  const d = describeRom(rom);
  assert.equal(d.mapper, 0);
  assert.equal(d.supported, true);
});
