// IR export, alignments:'all': a SECONDARY record's pc-relative operands are
// computed from its OWN address, not the batch slot objdump decoded it at.
//
// Regression (feedback 2026-09-22, m68k-ir-secondary-pcrel-targets-wrong): on
// two commercial Genesis carts every primary short branch was right and every
// secondary one was wrong (0 of 3,074), each off by exactly the distance to
// its 0x20-byte batch slot. A recompiler trusting `targets` jumped into
// compressed art ~440 frames later. The same batch path decodes Z80 jr/djnz
// and ARM/Thumb branches and literal loads, so those are checked too.
//
// Each case hides an instruction INSIDE a primary instruction's immediate,
// so the only record starting there is secondary, and asserts the target the
// ENCODING fixes: a pure function of the bytes and the offset, no oracle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportZ80IR, rebaseOps } from "../src/analysis/recompile/export-z80-ir.js";
import { ISAS } from "../src/analysis/recompile/isa.js";

async function exportAll(platform, rom, name) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "romdev-irsec-"));
  try {
    const p = path.join(dir, name), out = path.join(dir, "ir.jsonl");
    writeFileSync(p, rom);
    await exportZ80IR({ platform, path: p, outputPath: out, allOffsets: true, alignments: "all" });
    return readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const s16 = (v) => (v >= 0x8000 ? v - 0x10000 : v);

test("m68k: secondary Bcc, DBcc, BSR.W and (d16,PC) targets come from the record's own address", { timeout: 120000 }, async () => {
  const rom = new Uint8Array(0x10000).fill(0);
  for (let i = 0; i < rom.length; i += 2) { rom[i] = 0x4e; rom[i + 1] = 0x71; } // nop
  // immediates hiding: beq.s +$10 | lea (d16,pc),a0 | dbf d0,-4 | bsr.w +$100
  rom.set([0x30, 0x3c, 0x67, 0x10], 0x6000);             // move.w #$6710,d0
  rom.set([0x20, 0x3c, 0x41, 0xfa, 0x00, 0x10], 0x6010); // move.l #$41FA0010,d0
  rom.set([0x20, 0x3c, 0x51, 0xc8, 0xff, 0xfc], 0x6020); // move.l #$51C8FFFC,d0
  rom.set([0x20, 0x3c, 0x61, 0x00, 0x01, 0x00], 0x6030); // move.l #$61000100,d0
  const recs = await exportAll("genesis", rom, "t.md");
  const at = (off) => recs.find((r) => r.off === off && r.alignment === "secondary");
  const beq = at(0x6002), lea = at(0x6012), dbf = at(0x6022), bsr = at(0x6032);
  for (const r of [beq, lea, dbf, bsr]) assert.ok(r, "each hidden instruction has a secondary record");
  assert.equal(beq.targets[0], 0x6002 + 2 + 0x10, `beq.s: ${beq.ops}`);
  assert.equal(dbf.targets[0], 0x6022 + 2 + s16(0xfffc), `dbf: ${dbf.ops}`);
  assert.equal(bsr.targets[0], 0x6032 + 2 + 0x100, `bsr.w: ${bsr.ops}`);
  assert.equal(parseInt(/%pc@\(0x([0-9a-f]+)/.exec(lea.ops)[1], 16), 0x6012 + 2 + 0x10, `lea: ${lea.ops}`);
  // and every unambiguous short branch in the image agrees with its encoding
  let checked = 0;
  for (const r of recs) {
    if (r.len !== 2 || !r.bytes || (r.bytes[0] & 0xf0) !== 0x60 || r.bytes[1] === 0 || r.bytes[1] === 0xff) continue;
    const disp = r.bytes[1] >= 128 ? r.bytes[1] - 256 : r.bytes[1];
    assert.equal(r.targets[0], r.addr + 2 + disp, `${r.alignment} ${r.mnemonic} at ${r.off}`);
    checked++;
  }
  assert.ok(checked >= 1);
});

test("rebaseOps: only pc-relative tokens move (control: absolute operands must not)", () => {
  const d = 0x100;
  assert.equal(rebaseOps(ISAS.m68k, "beqs", "0x1016", d), "0x1116");
  assert.equal(rebaseOps(ISAS.m68k, "dbf", "%d0,0x1004", d), "%d0,0x1104");
  assert.equal(rebaseOps(ISAS.m68k, "movew", "%pc@(0x1016,%d0:w),%d0", d), "%pc@(0x1116,%d0:w),%d0");
  assert.equal(rebaseOps(ISAS.m68k, "movew", "0x1234,%d0", d), "0x1234,%d0", "abs.w operand is not pc-relative");
  assert.equal(rebaseOps(ISAS.m68k, "btst", "#3,0x1234", d), "#3,0x1234", "btst is not a branch");
  assert.equal(rebaseOps(ISAS.z80, "jr", "nz,0x1009", d), "nz,0x1109");
  assert.equal(rebaseOps(ISAS.z80, "jp", "0x1234", d), "0x1234", "jp nn is absolute");
  assert.equal(rebaseOps(ISAS.gbaThumb, "bl", "0x1028", d), "0x1128");
  assert.equal(rebaseOps(ISAS.gbaThumb, "ldr", "r0, [pc, #4]\t@ (0x1010)", d), "r0, [pc, #4]\t@ (0x1110)");
  assert.equal(rebaseOps(ISAS.gba, "ldr", "r1, [pc, #4]\t@ 0x1014", d), "r1, [pc, #4]\t@ 0x1114");
  assert.equal(rebaseOps(ISAS.gba, "bx", "lr", d), "lr");
  assert.equal(rebaseOps(ISAS.m68k, "beqs", "0x1016", 0), "0x1016", "a primary record (delta 0) is untouched");
});

test("z80: a secondary jr target comes from the record's own address", { timeout: 60000 }, async () => {
  const rom = new Uint8Array(0x8000).fill(0);
  rom.set([0x21, 0x18, 0x10], 0x1000); // ld hl,$1018 ; hides `jr +$10` at $1001
  const recs = await exportAll("sms", rom, "t.sms");
  const jr = recs.find((r) => r.off === 0x1001 && r.alignment === "secondary");
  assert.ok(jr, "the hidden jr has a secondary record");
  assert.equal(jr.targets[0], jr.addr + 2 + 0x10, `jr: ${jr.ops}`);
});
