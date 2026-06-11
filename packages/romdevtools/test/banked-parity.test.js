// Banked-cart parity: the 0.27.0 feedback round fixed per-bank reference
// scanning + one-call banked rebuild glue for NES. This suite proves the same
// treatment on every other banked-cart platform:
//   refs per-bank (romBank tag): SMS/GG (Sega mapper), GB/GBC (MBC),
//     Atari 2600 (F8/F6/F4), Atari 7800 (SuperGame), MSX (megaROM),
//     PCE (>32KB HuCard), SNES (multi-bank LoROM)
//   one-call build() rebuild (cc65/ca65 toolchain match): Atari 7800
//     SuperGame, PCE (flat AND banked — planRegions no longer pad-trims or
//     mis-orgs HuCards)
//   per-bank native recipes (build:null, byte-exact regions): SMS banked,
//     MSX megaROM, 2600 banked

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerToolchainTools } from "../src/mcp/tools/toolchain.js";

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

/** A bank of `size` bytes starting with `code`, padded with `pad`. */
function bank(size, code, pad = 0x00) {
  const b = new Uint8Array(size).fill(pad);
  b.set(code, 0);
  return b;
}

function concat(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function refs(dir, name, bytes, args) {
  const romPath = path.join(dir, name);
  await writeFile(romPath, bytes);
  const disasm = toolHandler(registerDisasmTools, "disasm");
  return parse(await disasm({ target: "references", path: romPath, maxRefsReturned: 128, ...args }));
}

// ── per-bank reference scanning ─────────────────────────────────────────────

test("SMS banked (64KB Sega mapper): references found in slot-2 banks, romBank-tagged", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-sms-"));
  try {
    // Every bank: ld a,($C005) / ld ($C005),a / jp <bank org>
    const code = (org) => [0x3A, 0x05, 0xC0, 0x32, 0x05, 0xC0, 0xC3, org & 0xFF, org >> 8];
    const rom = concat(
      bank(0x4000, code(0x0000)),
      bank(0x4000, code(0x4000)),
      bank(0x4000, code(0x8000)),
      bank(0x4000, code(0x8000)),
    );
    const r = await refs(dir, "banked.sms", rom, { address: 0xC005 });
    assert.ok(r.refsFound >= 8, `expected ld refs in all 4 banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(2) && banks.has(3),
      `refs must span fixed AND slot-2 banks, got banks ${[...banks]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GB banked (64KB MBC): references found past bank 1, romBank-tagged", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-gb-"));
  try {
    // Every bank: ld a,($C005) / ld ($C005),a / jp <org>
    const code = (org) => [0xFA, 0x05, 0xC0, 0xEA, 0x05, 0xC0, 0xC3, org & 0xFF, org >> 8];
    const rom = concat(
      bank(0x4000, code(0x0000)),
      bank(0x4000, code(0x4000)),
      bank(0x4000, code(0x4000)),
      bank(0x4000, code(0x4000)),
    );
    const r = await refs(dir, "banked.gb", rom, { address: 0xC005 });
    assert.ok(r.refsFound >= 8, `expected refs in all 4 banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(3), `refs must span banks 0..3, got ${[...banks]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Atari 2600 banked (8KB F8): both 4KB banks scanned at $F000", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-a26-"));
  try {
    // Every bank: lda $80 / sta $80 / jmp $F000, nop-padded, vectors at top.
    const mk = () => {
      const b = bank(0x1000, [0xA5, 0x80, 0x85, 0x80, 0x4C, 0x00, 0xF0], 0xEA);
      b[0xFFA] = 0x00; b[0xFFB] = 0xF0; // NMI
      b[0xFFC] = 0x00; b[0xFFD] = 0xF0; // RESET
      b[0xFFE] = 0x00; b[0xFFF] = 0xF0; // IRQ
      return b;
    };
    const rom = concat(mk(), mk());
    const r = await refs(dir, "banked.a26", rom, { address: 0x80 });
    assert.ok(r.refsFound >= 4, `expected zp refs in both banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(1), `refs must span both banks, got ${[...banks]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MSX megaROM (64KB): references found past the first 32KB, romBank-tagged", { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-msx-"));
  try {
    const header = new Uint8Array(16);
    header[0] = 0x41; header[1] = 0x42; // "AB"
    header[2] = 0x10; header[3] = 0x40; // INIT = $4010
    const code = [0x3A, 0x05, 0xC0, 0x32, 0x05, 0xC0, 0xC9]; // ld a,(C005)/ld (C005),a/ret
    const rom = concat(
      header, bank(0x4000 - 16, code),
      bank(0x4000, code), bank(0x4000, code), bank(0x4000, code),
    );
    const r = await refs(dir, "mega.rom", rom, { address: 0xC005, platform: "msx" });
    assert.ok(r.refsFound >= 8, `expected refs in all 4 banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(3), `refs must span banks 0..3, got ${[...banks]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SNES multi-bank LoROM (64KB): references found in bank 1, romBank-tagged", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-snes-"));
  try {
    // Every bank: lda $0205 / sta $0205 / jmp $8000, nop-padded.
    const code = [0xAD, 0x05, 0x02, 0x8D, 0x05, 0x02, 0x4C, 0x00, 0x80];
    const rom = concat(bank(0x8000, code, 0xEA), bank(0x8000, code, 0xEA));
    const r = await refs(dir, "banked.sfc", rom, { address: 0x0205 });
    assert.ok(r.refsFound >= 4, `expected refs in both banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(1), `refs must span both 32KB banks, got ${[...banks]}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── synthetic banked carts for the project/rebuild tests ────────────────────

function makeA78SuperGame(nBanks) {
  const header = new Uint8Array(128);
  header[0] = 1;
  header.set(Array.from("ATARI7800").map((c) => c.charCodeAt(0)), 1);
  const banks = [];
  for (let b = 0; b < nBanks; b++) {
    const org = b === nBanks - 1 ? 0xC000 : 0x8000;
    const bk = bank(0x4000, [0xA5, 0x02, 0x85, 0x02, 0x4C, org & 0xFF, org >> 8], 0xEA);
    if (b === nBanks - 1) {
      bk[0x3FFA] = 0x00; bk[0x3FFB] = 0xC0;
      bk[0x3FFC] = 0x00; bk[0x3FFD] = 0xC0;
      bk[0x3FFE] = 0x00; bk[0x3FFF] = 0xC0;
    }
    banks.push(bk);
  }
  return concat(header, ...banks);
}

function makePceBanked(nPages) {
  const pages = [];
  for (let b = 0; b < nPages; b++) {
    const org = b === 0 ? 0xE000 : 0x8000;
    const pg = bank(0x2000, [0xA5, 0x02, 0x85, 0x02, 0x4C, org & 0xFF, org >> 8], 0xEA);
    if (b === 0) { pg[0x1FFE] = 0x00; pg[0x1FFF] = 0xE0; } // reset vector @$FFFE
    pages.push(pg);
  }
  return concat(...pages);
}

test("Atari 7800 SuperGame (64KB): refs span banks; one-call rebuild is byte-identical", { timeout: 240000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-a78-"));
  try {
    const orig = makeA78SuperGame(4);
    const romPath = path.join(dir, "supergame.a78");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");

    const r = parse(await disasm({ target: "references", path: romPath, address: 0x02, maxRefsReturned: 128 }));
    assert.ok(r.refsFound >= 8, `expected zp refs in all banks, got ${r.refsFound}`);
    const banks = new Set(r.refs.map((x) => x.romBank));
    assert.ok(banks.has(0) && banks.has(3), `refs must span switchable + fixed banks, got ${[...banks]}`);

    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj") }));
    assert.equal(proj.roundTrip.allByteExact, true, "all regions must round-trip byte-exact");
    const call = proj.rebuild.buildCall;
    assert.ok(call && call.linkerConfigPath, "banked 7800 must emit a one-call rebuild via linkerConfigPath");
    const build = toolHandler(registerToolchainTools, "build", "banked-a78");
    const outPath = path.join(dir, "rebuilt.a78");
    const b = parse(await build({ ...call, outputPath: outPath }));
    assert.equal(b.ok, true, "rebuild build failed: " + (b.logTail || b.log || "").slice(-300));
    const rebuilt = await readFile(outPath);
    assert.equal(Buffer.compare(Buffer.from(orig), rebuilt), 0, "rebuilt .a78 must be byte-identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PCE banked HuCard (64KB): refs span pages; one-call rebuild is byte-identical", { timeout: 240000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-pce-"));
  try {
    const orig = makePceBanked(8);
    const romPath = path.join(dir, "banked.pce");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");

    const r = parse(await disasm({ target: "references", path: romPath, address: 0x02, platform: "pce", maxRefsReturned: 128 }));
    assert.ok(r.refsFound >= 12, `expected zp refs across the 8 pages, got ${r.refsFound}`);
    const pages = new Set(r.refs.map((x) => x.romBank));
    assert.ok(pages.has(0) && pages.has(7), `refs must span page 0 and the last page, got ${[...pages]}`);

    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj"), platform: "pce" }));
    assert.equal(proj.roundTrip.allByteExact, true, "all pages must round-trip byte-exact");
    const call = proj.rebuild.buildCall;
    assert.ok(call && call.linkerConfigPath, "banked PCE must emit a one-call rebuild via linkerConfigPath");
    assert.equal(proj.rebuild.verifiable, true, "PCE rebuild must now be verifiable (was the lossy planRegions case)");
    const build = toolHandler(registerToolchainTools, "build", "banked-pce");
    const outPath = path.join(dir, "rebuilt.pce");
    const b = parse(await build({ ...call, outputPath: outPath }));
    assert.equal(b.ok, true, "rebuild build failed: " + (b.logTail || b.log || "").slice(-300));
    const rebuilt = await readFile(outPath);
    assert.equal(Buffer.compare(Buffer.from(orig), rebuilt), 0, "rebuilt .pce must be byte-identical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PCE flat HuCard (8KB, with REAL trailing $FF pad): faithful one-call rebuild", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-flat-pce-"));
  try {
    // Code at the front, REAL $FF padding to the cart size — the exact shape
    // the old planRegions pad-trim made lossy.
    const orig = bank(0x2000, [0xA9, 0x01, 0x85, 0x10, 0x4C, 0x00, 0xE0], 0xFF);
    orig[0x1FFE] = 0x00; orig[0x1FFF] = 0xE0;
    const romPath = path.join(dir, "flat.pce");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj"), platform: "pce" }));
    assert.equal(proj.roundTrip.allByteExact, true);
    assert.equal(proj.rebuild.verifiable, true);
    const call = proj.rebuild.buildCall;
    assert.ok(call, "flat PCE must now have a one-call rebuild");
    const build = toolHandler(registerToolchainTools, "build", "flat-pce");
    const outPath = path.join(dir, "rebuilt.pce");
    const b = parse(await build({ ...call, outputPath: outPath }));
    assert.equal(b.ok, true, "rebuild build failed: " + (b.logTail || b.log || "").slice(-300));
    const rebuilt = await readFile(outPath);
    assert.equal(Buffer.compare(Buffer.from(orig), rebuilt), 0,
      "rebuilt flat .pce must be byte-identical INCLUDING the trailing $FF pad");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SMS banked project: per-bank regions round-trip byte-exact with a per-bank native recipe", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-sms-proj-"));
  try {
    const code = (org) => [0x3A, 0x05, 0xC0, 0xC3, org & 0xFF, org >> 8];
    const orig = concat(
      bank(0x4000, code(0x0000)), bank(0x4000, code(0x4000)),
      bank(0x4000, code(0x8000)), bank(0x4000, code(0x8000)),
    );
    const romPath = path.join(dir, "banked.sms");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj") }));
    assert.equal(proj.regions.length, 4, "one region per 16KB bank");
    assert.equal(proj.roundTrip.allByteExact, true, "all banks must round-trip byte-exact");
    assert.equal(proj.rebuild.verifiable, true);
    assert.match(proj.rebuild.notes, /bank3/, "native recipe must cover every bank");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MSX megaROM project: header + per-bank regions round-trip byte-exact", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-msx-proj-"));
  try {
    const header = new Uint8Array(16);
    header[0] = 0x41; header[1] = 0x42; header[2] = 0x10; header[3] = 0x40;
    const code = [0x3A, 0x05, 0xC0, 0xC9];
    const orig = concat(header, bank(0x4000 - 16, code), bank(0x4000, code), bank(0x4000, code), bank(0x4000, code));
    const romPath = path.join(dir, "mega.rom");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj"), platform: "msx" }));
    assert.ok(proj.regions.some((r) => r.region === "ab_header" && r.kind === "data"), "AB header must be its own data region");
    assert.equal(proj.regions.filter((r) => r.region.startsWith("bank")).length, 4);
    assert.equal(proj.roundTrip.allByteExact, true);
    assert.equal(proj.rebuild.verifiable, true);
    assert.match(proj.rebuild.notes, /bank3/, "native recipe must cover every bank");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Atari 2600 banked project: per-bank regions + per-bank cfg blob", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-banked-a26-proj-"));
  try {
    const mk = () => {
      const b = bank(0x1000, [0xA5, 0x80, 0x4C, 0x00, 0xF0], 0xEA);
      b[0xFFC] = 0x00; b[0xFFD] = 0xF0;
      return b;
    };
    const orig = concat(mk(), mk());
    const romPath = path.join(dir, "banked.a26");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj") }));
    assert.equal(proj.regions.length, 2, "one region per 4KB bank");
    assert.equal(proj.roundTrip.allByteExact, true);
    assert.equal(proj.rebuild.verifiable, true);
    assert.ok(proj.rebuild.blobs.some((b) => b.file === "atari2600_rebuild.cfg"), "banked cfg blob must ship");
    assert.ok(proj.rebuild.blobs.some((b) => b.file === "bank1_seg.asm"), "per-bank wrappers must ship");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
