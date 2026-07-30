// accessScan bank filtering + density rollup.
//
// The problem: a cart's DATA banks decode as fiction. Arbitrary tile/level
// bytes disassemble into plausible instructions, and on 6502 a ZERO-PAGE target
// makes that fiction hit constantly, because the two-byte encodings are ordinary
// byte pairs in graphics data (`C6 C0` = dec $C0, `01 C0` = ora ($C0,x)). A
// reported scan of $C0 returned 249 sites across ~58.7 KB, nearly all from one
// data bank, and the whole result was thrown away in favour of grepping the
// project's own source.
//
// Per-bank disassembly does NOT solve this, and claiming it does has misled
// people: a data bank has a per-bank decode, it is simply fiction, and fiction
// boundary-verifies fine. The fix is to let the caller name the code banks, and
// to report density so they can tell which those are without reading the rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findReferencesCore } from "../src/mcp/tools/find-references.js";

const PRG_BANKS = 4;
const BANK = 16384;

/**
 * A 4-bank NES ROM where bank 0 is real code touching $C0 a handful of times and
 * banks 1-3 are "graphics data" saturated with byte pairs that happen to decode
 * as $C0 accesses. This is the reported situation in miniature.
 */
function makeBankedRom() {
  const prg = new Uint8Array(PRG_BANKS * BANK);

  // Bank 0: sparse, deliberate accesses to $C0 in otherwise inert filler.
  // 0xEA is NOP, so the decode stream stays sane between the real hits.
  prg.fill(0xEA, 0, BANK);
  const code = [
    0xA5, 0xC0,        // lda $C0
    0x85, 0xC0,        // sta $C0
    0xE6, 0xC0,        // inc $C0
  ];
  prg.set(code, 0x100);

  // Banks 1-3: dense fiction. `C6 C0` (dec $C0) repeated is what tile data
  // routinely looks like to a disassembler.
  for (let b = 1; b < PRG_BANKS; b++) {
    for (let i = 0; i < BANK; i += 2) {
      prg[b * BANK + i] = 0xC6;
      prg[b * BANK + i + 1] = 0xC0;
    }
  }

  const header = new Uint8Array(16);
  header.set([0x4E, 0x45, 0x53, 0x1A]);   // "NES\x1a"
  header[4] = PRG_BANKS;                   // PRG in 16KB units
  header[5] = 0;                           // no CHR
  header[6] = 0x20;                        // mapper 2 (UNROM) low nibble
  const rom = new Uint8Array(header.length + prg.length);
  rom.set(header, 0);
  rom.set(prg, header.length);

  const dir = mkdtempSync(path.join(tmpdir(), "accessscan-banks-"));
  const file = path.join(dir, "banked.nes");
  writeFileSync(file, rom);
  return file;
}

const ROM = makeBankedRom();

/**
 * The same cart with the layout REVERSED: data banks first, the real code last.
 * That is the reported arrangement (data in 0-5, code in 6-7), and it is the one
 * a global row cap gets wrong -- the flood is scanned first and eats the budget
 * before the code bank is ever reached.
 */
function makeCodeLastRom() {
  const prg = new Uint8Array(PRG_BANKS * BANK);
  for (let b = 0; b < PRG_BANKS - 1; b++) {
    for (let i = 0; i < BANK; i += 2) {
      prg[b * BANK + i] = 0xC6;
      prg[b * BANK + i + 1] = 0xC0;
    }
  }
  const last = (PRG_BANKS - 1) * BANK;
  prg.fill(0xEA, last, last + BANK);
  prg.set([0xA5, 0xC0, 0x85, 0xC0, 0xE6, 0xC0], last + 0x100);

  const header = new Uint8Array(16);
  header.set([0x4E, 0x45, 0x53, 0x1A]);
  header[4] = PRG_BANKS;
  header[5] = 0;
  header[6] = 0x20;
  const rom = new Uint8Array(header.length + prg.length);
  rom.set(header, 0);
  rom.set(prg, header.length);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "accessscan-codelast-")), "banked.nes");
  writeFileSync(file, rom);
  return file;
}

const CODE_LAST_ROM = makeCodeLastRom();

test("an unfiltered scan floods from the data banks (the reported failure)", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxRefsReturned: 4096,
  });
  assert.ok(r.sitesFound > 100, `expected a flood, got ${r.sitesFound}`);
  // The junk dwarfs the real hits, which is exactly why the result was useless.
  const inBank0 = r.sites.filter((s) => s.prgBank === 0).length;
  assert.ok(inBank0 < r.sitesFound / 10, "bank 0's real hits are a rounding error next to the fiction");
});

test("banks:[0] restricts the scan to the code bank", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2, banks: [0] },
  });
  assert.ok(r.sitesFound > 0, "the real accesses are still found");
  assert.ok(r.sitesFound < 20, `expected a usable count, got ${r.sitesFound}`);
  assert.ok(r.sites.every((s) => s.prgBank === 0), "only bank 0 sites returned");
  assert.deepEqual(r.banksScanned, [0]);
  assert.deepEqual(r.banksSkipped, [1, 2, 3]);
});

test("excludeBanks is the inverse and reaches the same answer", async () => {
  const only = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0, accessScan: { window: 2, banks: [0] },
  });
  const excl = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0, accessScan: { window: 2, excludeBanks: [1, 2, 3] },
  });
  assert.equal(excl.sitesFound, only.sitesFound);
  assert.deepEqual(excl.banksScanned, [0]);
});

test("perBank density is reported even with no filter, ranking the data banks first", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxRefsReturned: 4096,
  });
  assert.ok(r.perBank, "perBank present without being asked for");
  assert.equal(r.perBank.length, PRG_BANKS);
  // Sorted by site count, so the fiction floats to the top where it can be seen
  // and discarded without reading 249 rows.
  assert.ok(r.perBank[0].sites > r.perBank[r.perBank.length - 1].sites);
  assert.equal(r.perBank[r.perBank.length - 1].bank, 0, "the sparse code bank ranks last");
  assert.ok(r.perBank[0].per1kLines > r.perBank[r.perBank.length - 1].per1kLines,
    "density separates data from code");
});

test("a lopsided scan names the bank filter as the static fix", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxRefsReturned: 4096,
  });
  assert.match(r.notes, /banks:\[/, "points at the static fix, not only the dynamic backstop");
  assert.match(r.notes, /perBank/);
});

test("a filtered scan omits the density advice it no longer needs", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0, accessScan: { window: 2, banks: [0] },
  });
  assert.doesNotMatch(r.notes, /rerun with banks:/i);
  // The standing caveat about indirect access must survive regardless.
  assert.match(r.notes, /watch\(\{on:'range'/);
});

// ── Per-bank row cap ────────────────────────────────────────────────────────
//
// The third ask in the field report, and the one that matters when the caller
// does NOT already know which banks are code: "cap or summarize per bank rather
// than emitting every row."
//
// The old slice took the first maxRefsReturned sites GLOBALLY. Because sites are
// collected bank-by-bank, a flooded data bank early in the scan consumed the
// entire budget and the real hits from later code banks were truncated away
// entirely -- so an unfiltered scan returned hundreds of rows of fiction and
// none of the answer.

test("a flooded bank cannot consume the whole row budget", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxSitesPerBank: 5,
  });
  const perBankCounts = new Map();
  for (const s of r.sites) perBankCounts.set(s.prgBank, (perBankCounts.get(s.prgBank) ?? 0) + 1);
  for (const [bank, n] of perBankCounts) {
    assert.ok(n <= 5, `bank ${bank} returned ${n} rows, over the cap`);
  }
  // The true totals are still reported -- the cap bounds ROWS, not the count.
  assert.ok(r.sitesFound > 100, "sitesFound still reports every site found");
});

test("a code bank scanned AFTER the flood still gets its rows", async () => {
  // Bank ORDER is what makes this bite. Banks are scanned in order and sites are
  // appended, so a global slice keeps whatever came first. In the main fixture
  // the code bank is bank 0 -- it survives a global slice by luck, which would
  // make this test pass for the wrong reason.
  //
  // The reported layout is the opposite way round: data in the low banks, code
  // in banks 6-7. So this fixture puts the real hits LAST, where a global slice
  // truncates them away entirely and only a per-bank budget saves them.
  const r = await findReferencesCore({
    path: CODE_LAST_ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxSitesPerBank: 4, maxRefsReturned: 64,
  });
  const fromCodeBank = r.sites.filter((s) => s.prgBank === PRG_BANKS - 1);
  assert.ok(fromCodeBank.length > 0,
    "the real hits in the LAST bank survived the flood in the earlier ones");
});

test("the truncation note names the capped banks and both escape hatches", async () => {
  const r = await findReferencesCore({
    path: ROM, platform: "nes", address: 0xC0,
    accessScan: { window: 2 }, maxSitesPerBank: 3,
  });
  assert.match(r.truncated, /capped at 3 of/, "says which banks were capped, and out of how many");
  assert.match(r.truncated, /maxSitesPerBank/, "names the row-cap knob");
  assert.match(r.truncated, /banks:\[/, "names the better fix — scan only the code banks");
});

test("an unbanked ROM is unaffected by the per-bank cap", async () => {
  // nestest is a single 16KB bank; the per-bank path must not change its
  // long-standing global-slice behaviour.
  const NESTEST = new URL("./roms/nestest.nes", import.meta.url).pathname;
  const r = await findReferencesCore({
    path: NESTEST, platform: "nes", address: 0x0002,
    accessScan: { window: 2 }, maxSitesPerBank: 1,
  });
  assert.ok(r.sitesFound > 1, "nestest writes $0002 constantly");
  assert.ok(r.sites.length > 1, "a flat ROM is not capped per-bank");
});
