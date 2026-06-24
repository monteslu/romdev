// disasm({target:'references'}) pointer-table (trampoline) scan. The operand scan
// only finds DIRECT control-flow (jsr/jmp/branch naming the address). When a
// handler is reached ONLY through an inline word table (computed jump / RTS-trick
// dispatcher), no instruction names it — so references now also scans the raw ROM
// for the address as a 16-bit pointer (LE/BE, + the 6502 addr-1 RTS-trick), the
// exact case the v0.41.0 feedback hit (note 164014 #1 / 185811).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findReferencesCore } from "../src/mcp/tools/find-references.js";

/** A 32KB NROM with the given bytes placed at a PRG offset, reset → $8000. */
function nrom(placements) {
  const prg = new Uint8Array(0x8000);
  for (const { off, bytes } of placements) prg.set(bytes, off);
  prg[0x7ffc] = 0x00; prg[0x7ffd] = 0x80; // reset → $8000
  const header = new Uint8Array(16); header.set([0x4e, 0x45, 0x53, 0x1a, 2, 0]);
  const rom = new Uint8Array(16 + 0x8000); rom.set(header); rom.set(prg, 16);
  return rom;
}

async function refs(bytes, address, extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reftbl-"));
  try {
    const p = path.join(dir, "t.nes");
    await writeFile(p, bytes);
    return await findReferencesCore({ path: p, platform: "nes", address, ...extra });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("RTS-trick inline table entry (addr-1) is found when no direct ref names it", async () => {
  // handler $8590 reached only via an inline word table holding $858F (= addr-1).
  const rom = nrom([{ off: 0x100, bytes: [0x8f, 0x85, 0x77, 0x80] }]); // $858F, $8077 (LE)
  const r = await refs(rom, 0x8590);
  assert.equal(r.refsFound, 0, "no direct jsr/jmp/branch names $8590");
  assert.equal(r.tableHitsFound, 1, "one pointer-table hit");
  const h = r.tableHits[0];
  assert.equal(h.word, "$858F");
  assert.equal(h.endian, "LE");
  assert.equal(h.convention, "rts+1", "table holds addr-1 (the 6502 RTS trick)");
  assert.equal(h.fileOffset, "0x110", "iNES header (16) + PRG offset 0x100");
  assert.match(r.notes, /pointer-table hit/i);
});

test("direct LE pointer (computed jump, no RTS trick) is found too", async () => {
  const rom = nrom([{ off: 0x200, bytes: [0x34, 0x82] }]); // $8234 (LE)
  const r = await refs(rom, 0x8234);
  assert.ok(r.tableHitsFound >= 1);
  const direct = r.tableHits.find((h) => h.convention === "direct");
  assert.ok(direct, "the exact address appears as a direct LE word");
  assert.equal(direct.word, "$8234");
});

test("includeTableHits surfaces hits ALONGSIDE direct refs", async () => {
  // $8400 is both jsr-ed (direct) AND sits in a word table.
  const rom = nrom([
    { off: 0x000, bytes: [0x20, 0x00, 0x84] },   // $8000: jsr $8400 (direct ref)
    { off: 0x300, bytes: [0x00, 0x84] },         // $8300: word $8400 in a table
  ]);
  const withFlag = await refs(rom, 0x8400, { includeTableHits: true });
  assert.ok(withFlag.refsFound >= 1, "the jsr is a direct ref");
  assert.ok(withFlag.tableHitsFound >= 1, "the table entry is also surfaced");
  // Without the flag and WITH direct refs, tableHits aren't auto-scanned.
  const withoutFlag = await refs(rom, 0x8400);
  assert.ok(withoutFlag.refsFound >= 1);
  assert.equal(withoutFlag.tableHitsFound, undefined, "no auto table scan when direct refs exist");
});

test("a truly unreached address reports neither refs nor table hits, clearly", async () => {
  const rom = nrom([{ off: 0x100, bytes: [0xea, 0xea] }]); // nops, no $9ABC anywhere
  const r = await refs(rom, 0x9abc);
  assert.equal(r.refsFound, 0);
  assert.ok(!r.tableHitsFound);
  assert.match(r.notes, /No pointer-table hits either/i);
});
