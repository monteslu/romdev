// build({output:'reassemble'}) — the UNIFORM byte-exact round-trip.
//
// disasm({target:'project'}) now writes a reassemble.json manifest + an
// original.rom template for EVERY platform. build({output:'reassemble', path})
// reads them, ASSEMBLES each region .asm with the platform's native assembler,
// splices the result into a copy of the original at its file offset, and returns
// a byte-identical ROM. This is the one-call "cmp before commit" rebuild the
// disassemble/annotate skills need — and unlike rebuild.json it works across all
// CPU families, not just the cc65-native subset.
//
// This suite drives the REAL registered disasm + build handlers end-to-end on a
// synthetic ROM per CPU family (fast — no SDK builds) plus the real nestest.nes
// fixture, and asserts the rebuilt ROM equals the original byte-for-byte. It also
// covers the edit path (a same-length region edit rebuilds a modified-but-valid
// ROM) and the refusal path (a length-changing edit is reported, not silently
// corrupted).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerDisasmTools } from "../src/mcp/tools/disasm.js";
import { registerToolchainTools } from "../src/mcp/tools/toolchain.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NESTEST = path.join(__dirname, "roms", "nestest.nes");

const parse = (res) => JSON.parse(res.content.find((c) => c.type === "text").text);

function toolHandler(registerFn, toolName, sessionKey) {
  const map = {};
  registerFn({ tool: (n, _d, _s, h) => { map[n] = h; } }, z, sessionKey);
  return map[toolName];
}

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

/** Full disasm({target:'project'}) → build({output:'reassemble'}) round-trip. */
async function roundtrip(dir, name, orig, platform) {
  const romPath = path.join(dir, name);
  await writeFile(romPath, orig);
  const disasm = toolHandler(registerDisasmTools, "disasm");
  const build = toolHandler(registerToolchainTools, "build", "reassemble-" + platform);

  const projDir = path.join(dir, "proj");
  const proj = parse(await disasm({ target: "project", path: romPath, outputDir: projDir, platform }));

  // The manifest + template must exist for the uniform rebuild.
  const manifest = JSON.parse(await readFile(path.join(projDir, "reassemble.json"), "utf8"));
  assert.equal(manifest.platform, platform);
  assert.ok(manifest.regions.length >= 1, "manifest must list regions");
  await readFile(path.join(projDir, "original.rom")); // template present

  const re = parse(await build({ output: "reassemble", platform, path: projDir }));
  return { proj, re, projDir, orig };
}

// ── one CPU family per test (synthetic ROMs — no SDK builds) ─────────────────

test("SNES (65816/ca65): reassemble is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-snes-"));
  try {
    // Two LoROM 32KB banks: lda $0205 / sta $0205 / jmp $8000, nop-padded.
    const code = [0xAD, 0x05, 0x02, 0x8D, 0x05, 0x02, 0x4C, 0x00, 0x80];
    const orig = concat(bank(0x8000, code, 0xEA), bank(0x8000, code, 0xEA));
    const { re } = await roundtrip(dir, "game.sfc", orig, "snes");
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "SNES rebuild must be byte-identical");
    assert.equal(re.romLength, orig.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Genesis (m68k/GNU-as): reassemble is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-gen-"));
  try {
    // Header up to the reset PC (disasm treats <reset as data) + a small code
    // region. Reset vector ($4..$7) points at 0x0208. move.w #$2700,sr; bra .
    const rom = new Uint8Array(0x400);
    // reset PC = 0x0208
    rom[4] = 0x00; rom[5] = 0x00; rom[6] = 0x02; rom[7] = 0x08;
    // code @0x208: move #$2700,sr (46 fc 27 00) ; bra.s * (60 fe)
    rom.set([0x46, 0xFC, 0x27, 0x00, 0x60, 0xFE], 0x208);
    const { re } = await roundtrip(dir, "game.md", rom, "genesis");
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "Genesis rebuild must be byte-identical (SUBALIGN fix)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("GB (sm83/GNU-as): reassemble is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-gb-"));
  try {
    // Two 16KB banks. ld a,($C005) / ld ($C005),a / jp $0000 style code.
    const code = [0xFA, 0x05, 0xC0, 0xEA, 0x05, 0xC0, 0xC3, 0x00, 0x00];
    const orig = concat(bank(0x4000, code), bank(0x4000, code));
    const { re } = await roundtrip(dir, "game.gb", orig, "gb");
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "GB rebuild must be byte-identical");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SMS (z80/GNU-as): reassemble is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-sms-"));
  try {
    // ≤48KB flat: ld a,($C005) / jp $0000.
    const orig = bank(0x4000, [0x3A, 0x05, 0xC0, 0xC3, 0x00, 0x00]);
    const { re } = await roundtrip(dir, "game.sms", orig, "sms");
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "SMS rebuild must be byte-identical");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("GameTank (W65C02/ca65): reassemble is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-gt-"));
  try {
    // 32KB flat EEPROM32K cart mapped at $8000; reset vector ($FFFC) → $8000.
    const orig = bank(0x8000, [0xA5, 0x02, 0x85, 0x02, 0x4C, 0x00, 0x80], 0xEA);
    orig[0x7FFC] = 0x00; orig[0x7FFD] = 0x80;
    const { re, proj } = await roundtrip(dir, "game.gtr", orig, "gametank");
    assert.equal(proj.regions[0].startAddress, "$8000", "32KB cart maps at $8000");
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "GameTank rebuild must be byte-identical");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("NES (6502/ca65): reassemble a real ROM (nestest.nes) is byte-identical", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-nes-"));
  try {
    const orig = new Uint8Array(await readFile(NESTEST));
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const build = toolHandler(registerToolchainTools, "build", "reassemble-nes");
    const projDir = path.join(dir, "proj");
    await disasm({ target: "project", path: NESTEST, outputDir: projDir, platform: "nes" });
    const re = parse(await build({ output: "reassemble", platform: "nes", path: projDir }));
    assert.equal(re.ok, true, "reassemble failed: " + JSON.stringify(re.regions));
    assert.equal(re.byteExact, true, "NES rebuild must be byte-identical");
    assert.equal(re.romLength, orig.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── edit + refusal paths (the annotation "cmp before commit" gate) ───────────

test("edit path: a same-length region edit rebuilds a modified-but-valid ROM (byteExact=false)", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-edit-"));
  try {
    const orig = bank(0x4000, [0x3A, 0x05, 0xC0, 0xC3, 0x00, 0x00]); // SMS z80
    const romPath = path.join(dir, "game.sms");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const build = toolHandler(registerToolchainTools, "build", "reassemble-edit");
    const projDir = path.join(dir, "proj");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: projDir, platform: "sms" }));

    // Edit ONE data byte in the region .asm (same length), then rebuild.
    const regFile = path.join(projDir, proj.regions[0].file);
    let asm = await readFile(regFile, "utf8");
    // The region floors to .byte data; flip the first 0x3a to 0x00 (both valid).
    const edited = asm.replace(/0x3a/i, "0x00");
    assert.notEqual(edited, asm, "test edit must apply");
    await writeFile(regFile, edited);

    const re = parse(await build({ output: "reassemble", platform: "sms", path: projDir }));
    assert.equal(re.ok, true, "edited rebuild must still succeed");
    assert.equal(re.byteExact, false, "an edited region must NOT be byte-identical to the original");
    assert.ok(re.outputPath, "a valid edited ROM must be written");
    const rebuilt = new Uint8Array(await readFile(re.outputPath));
    assert.equal(rebuilt.length, orig.length, "length preserved");
    let diffs = 0;
    for (let i = 0; i < orig.length; i++) if (rebuilt[i] !== orig[i]) diffs++;
    assert.equal(diffs, 1, "exactly the one edited byte should differ");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("refusal path: a length-changing region edit is reported, not silently corrupted", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-badlen-"));
  try {
    const orig = bank(0x4000, [0x3A, 0x05, 0xC0, 0xC3, 0x00, 0x00]); // SMS z80
    const romPath = path.join(dir, "game.sms");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const build = toolHandler(registerToolchainTools, "build", "reassemble-badlen");
    const projDir = path.join(dir, "proj");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: projDir, platform: "sms" }));

    // Append a byte to the region → longer than byteLength → must be refused.
    const regFile = path.join(projDir, proj.regions[0].file);
    const asm = await readFile(regFile, "utf8");
    await writeFile(regFile, asm.replace(/(\n)$/, "\n\t.byte 0x99\n"));

    const re = parse(await build({ output: "reassemble", platform: "sms", path: projDir }));
    assert.equal(re.ok, false, "a length-changing edit must fail the rebuild");
    assert.equal(re.outputPath, null, "no ROM may be written when a region is wrong-length");
    const bad = re.regions.find((r) => !r.ok);
    assert.ok(bad && /length/i.test(bad.error), "the error must name the length mismatch: " + JSON.stringify(bad));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("missing manifest: a clear error, not a crash", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-nomanifest-"));
  try {
    const build = toolHandler(registerToolchainTools, "build", "reassemble-nomanifest");
    const res = await build({ output: "reassemble", platform: "nes", path: dir });
    // safeTool turns the throw into { isError:true, content:[{text: message}] }.
    assert.equal(res.isError, true, "missing manifest must be an error result");
    const text = res.content.find((c) => c.type === "text").text;
    assert.ok(/reassemble\.json/.test(text), "must point at the missing reassemble.json: " + text);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── field-feedback fixes (Jay's 1MB ActRaiser run, 0.88.x) ───────────────────

test("ROM data can't be committed: disasm writes a .gitignore for original.rom", { timeout: 120000 }, async () => {
  const { mkdir } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-gitignore-"));
  try {
    const projDir = path.join(dir, "proj");
    // Pre-existing .gitignore (Jay's case: repo already had `*.sfc`) — must be
    // preserved + appended-to, not clobbered or duplicated.
    await mkdir(projDir, { recursive: true });
    await writeFile(path.join(projDir, ".gitignore"), "*.sfc\n");
    const orig = bank(0x8000, [0xAD, 0x05, 0x02, 0x8D, 0x05, 0x02, 0x4C, 0x00, 0x80], 0xEA);
    const romPath = path.join(dir, "game.sfc");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: projDir, platform: "snes" }));
    assert.equal(proj.romProtected, ".gitignore", "payload must advertise the .gitignore protection");
    const gi = await readFile(path.join(projDir, ".gitignore"), "utf8");
    const lines = gi.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert.ok(lines.includes("original.rom"), "original.rom must be ignored: " + gi);
    assert.ok(lines.includes("*.sfc"), "pre-existing rule must be preserved");
    assert.equal(lines.filter((l) => l === "*.sfc").length, 1, "no duplicate of the existing rule");
    assert.ok(!lines.includes("*.md"), "must NOT ignore *.md (collides with Markdown / BUILD.md)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("padding is honest: an all-$FF fill bank is flagged, not reported ~100% readable", { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "romdev-reasm-fill-"));
  try {
    // Two SNES banks: bank0 = real code, bank1 = 32KB of $FF padding (the trap
    // that used to disassemble into junk `sbc $FFFFFF,x` and report ~100%).
    const code = bank(0x8000, [0xAD, 0x05, 0x02, 0x8D, 0x05, 0x02, 0x4C, 0x00, 0x80], 0xEA);
    const pad = new Uint8Array(0x8000).fill(0xFF);
    const orig = concat(code, pad);
    const romPath = path.join(dir, "game.sfc");
    await writeFile(romPath, orig);
    const disasm = toolHandler(registerDisasmTools, "disasm");
    const proj = parse(await disasm({ target: "project", path: romPath, outputDir: path.join(dir, "proj"), platform: "snes" }));

    assert.equal(proj.fillRegions, 1, "exactly the one padding bank must be flagged as fill");
    const fill = proj.regions.find((r) => r.fill);
    assert.ok(fill, "a fill region must be present");
    assert.equal(fill.readablePercent, null, "a fill region's readablePercent must be null, never a bogus %");
    assert.equal(fill.fillByte, "$FF", "the fill byte must be reported");
    // The avg must reflect CODE only — not skewed by the padding bank.
    const code0 = proj.regions.find((r) => !r.fill);
    assert.ok(code0.readablePercent != null, "the code bank keeps a real readablePercent");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
