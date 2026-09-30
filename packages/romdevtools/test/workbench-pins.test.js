// The linker-pin catalogue: parsing every assignment shape, window
// classification, the ROM-offset and shadowing-pin classes, whitelist files
// and the drafted whitelist template. Ported from the workbench's own
// tests; fixtures are handcrafted excerpts. The upstream conformance
// classes read a commercial project's symbol files and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SHN_ABS, parseElfSymbols } from "../src/decomp/workbench/ldmap.js";
import { NamedRange, RangeModel, WhitelistEntry } from "../src/decomp/workbench/mips-refs.js";
import { ARTIFACT_SUSPECT, AUTHENTIC_FIXED, CLASSIFICATIONS, DERIVED, ROM_OFFSET, SHADOWING_PIN, UNCLASSIFIED, WHITELIST_REVIEW_MARKER,
  WHITELIST_TEMPLATE_RULES, PinCatalogue, bootGlobalsWhitelist, classifyAbsolute, defaultPinModel, parsePinText, parseWhitelistText, readPinFiles,
  reclassifyRomOffsets, reclassifyShadowingPins, whitelistCandidates, whitelistTemplateText } from "../src/decomp/workbench/pins.js";
import { ValueError } from "../src/decomp/workbench/py.js";
import { buildElf } from "./fixtures/workbench/elf-symtab.js";

const UNDEFINED_SYMS = `/* Fake symbols until things are matched */

D_B0000574 = 0xB0000574;
D_B0000578 = 0xB0000578;

/* Symbols related to the end of the ROM */

gMainMemoryPool = main_BSS_END;   /* available at the end of BSS */
__RAM_TO_ROM = main_VRAM - 0x1000; /* used by calc_func_checksums.py */
__SIZE = ABSOLUTE (0x40 + 0x10);

osTvType = 0x80000300;
entrypoint = 0x80000400;
SP_STATUS_REG = 0xA4040010;
. = ALIGN (0x10);
`;

const SYMBOL_ADDRS = `// audio.c .text
audio_init = 0x80000450;
aspMainTextStart = 0x800D7600; // size:0xEC0 name_end:aspMainTextEnd
thread30_bgload = 0x800C74A0; // type:func
D_DD138 = 0xDD138;
`;

const catalogue = (text, model = null) => new PinCatalogue({ entries: parsePinText(text, { path: "fixture.txt", model: model ?? defaultPinModel() }), sources: ["fixture.txt"] });
const byName = (cat) => Object.fromEntries(cat.entries.map((e) => [e.name, e]));

test("parsing: the location counter is not a pin; absolute, derived, arithmetic and folded shapes", () => {
  const p = byName(catalogue(UNDEFINED_SYMS));
  assert.ok(!("." in p));
  assert.equal(Object.keys(p).length, 8);
  assert.deepEqual([p.D_B0000574.form, p.D_B0000574.value, p.D_B0000574.references], ["absolute", 0xB0000574, []]);
  assert.deepEqual([p.gMainMemoryPool.form, p.gMainMemoryPool.value, p.gMainMemoryPool.references, p.gMainMemoryPool.classification], ["derived", null, ["main_BSS_END"], DERIVED]);
  assert.deepEqual([p.__RAM_TO_ROM.form, p.__RAM_TO_ROM.references, p.__RAM_TO_ROM.expression], ["derived", ["main_VRAM"], "main_VRAM - 0x1000"]);
  assert.deepEqual([p.__SIZE.form, p.__SIZE.value, p.__SIZE.references], ["absolute", 0x50, []]);
});

test("parsing: trailing comments are context, standalone comments head what follows, lines are recorded", () => {
  const p = byName(catalogue(UNDEFINED_SYMS));
  assert.equal(p.gMainMemoryPool.comment, "available at the end of BSS");
  assert.equal(p.gMainMemoryPool.context, "Symbols related to the end of the ROM");
  assert.equal(p.D_B0000574.context, "Fake symbols until things are matched");
  assert.deepEqual([p.D_B0000574.source, p.D_B0000574.line, p.osTvType.line], ["fixture.txt", 3, 12]);
});

test("splat attributes parse into pairs; prose is not attributes; line comments end at the line", () => {
  const p = byName(catalogue(SYMBOL_ADDRS));
  assert.deepEqual(Object.fromEntries(p.aspMainTextStart.attributes), { size: "0xEC0", name_end: "aspMainTextEnd" });
  assert.equal(p.aspMainTextStart.comment, null);
  assert.deepEqual(Object.fromEntries(p.thread30_bgload.attributes), { type: "func" });
  assert.equal(p.audio_init.context, "audio.c .text");
  assert.deepEqual(p.audio_init.attributes, []);
  assert.equal(p.D_DD138.value, 0xDD138);
  assert.equal(p.D_DD138.comment, null);
});

const classify = (value, model = null) => catalogue(`NAME = 0x${value.toString(16).toUpperCase()};\n`, model).entries[0];

test("window classification: cart, hardware, kseg0, whitelisted boot globals, unnamed windows", () => {
  let p = classify(0xB0000574);
  assert.deepEqual([p.classification, p.window], [ARTIFACT_SUSPECT, "cart"]);
  assert.ok(String(p.reason).includes("cart"));
  p = classify(0xA4040010);
  assert.deepEqual([p.classification, p.window], [AUTHENTIC_FIXED, "kseg1"]);
  p = classify(0x800D7600);
  assert.deepEqual([p.classification, p.window], [ARTIFACT_SUSPECT, "kseg0"]);
  const model = defaultPinModel({ whitelist: [bootGlobalsWhitelist()] });
  for (const v of [0x80000300, 0x8000031C, 0x80000400]) {
    p = classify(v, model);
    assert.equal(p.classification, AUTHENTIC_FIXED);
    assert.ok(String(p.reason).includes("boot"));
  }
  assert.equal(bootGlobalsWhitelist().hi, 0x80000404);
  p = classify(0x0FFFFFFF);
  assert.deepEqual([p.classification, p.window], [UNCLASSIFIED, null]);
});

test("unresolved expressions are reported, never guessed; builtins are not references", () => {
  let p = catalogue("NAME = . + 0x10;\n").entries[0];
  assert.deepEqual([p.form, p.classification, p.value, p.expression], ["unresolved", UNCLASSIFIED, null, ". + 0x10"]);
  p = catalogue("NAME = DATA_SEGMENT_ALIGN(0x1000, 0x100);\n").entries[0];
  assert.deepEqual([p.form, p.references], ["unresolved", []]);
  assert.deepEqual(catalogue("NAME = ALIGN(0x10);\n").entries[0].references, []);
  p = catalogue("NAME = ABSOLUTE (main_BSS_END - main_BSS_START);\n").entries[0];
  assert.deepEqual([p.form, p.references], ["derived", ["main_BSS_END", "main_BSS_START"]]);
});

test("whitelist files: exact and range entries parse; a reason is required; backwards ranges refused", () => {
  const e = parseWhitelistText("# comment\n0x80100400 CIC-6103 boot address\n0x80000300-0x80000400 boot globals\n\n");
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], new WhitelistEntry({ lo: 0x80100400, hi: 0x80100401, reason: "CIC-6103 boot address" }));
  assert.deepEqual(e[1], new WhitelistEntry({ lo: 0x80000300, hi: 0x80000401, reason: "boot globals" }));
  assert.throws(() => parseWhitelistText("0x80100400\n"), (x) => x instanceof ValueError && x.message.includes("reason"));
  assert.throws(() => parseWhitelistText("0x80000400-0x80000300 backwards\n"), ValueError);
});

test("catalogue: counts partition, suspects first, the JSON names its cap, entries round-trip", () => {
  const cat = catalogue(UNDEFINED_SYMS, defaultPinModel({ whitelist: [bootGlobalsWhitelist()] }));
  const c = cat.counts;
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), cat.entries.length);
  assert.deepEqual([c[DERIVED], c[ARTIFACT_SUSPECT], c[AUTHENTIC_FIXED], c[UNCLASSIFIED]], [2, 2, 3, 1]);
  const ordered = cat.ranked().map((e) => e.classification);
  assert.deepEqual(ordered.slice(0, 2), [ARTIFACT_SUSPECT, ARTIFACT_SUSPECT]);
  assert.deepEqual(ordered.slice(-2), [DERIVED, DERIVED]);
  const p = cat.asDict({ limit: 3 });
  assert.deepEqual([p.pins_total, p.pins_shown, p.limit, p.pins.length, p.pins_artifact, p.pins_derived, p.pins_authentic, p.pins_unclassified, p.pin_sources],
    [8, 3, 3, 3, 2, 2, 3, 1, ["fixture.txt"]]);
  const d = cat.entries.find((x) => x.name === "gMainMemoryPool").asDict();
  assert.deepEqual([d.name, d.form, d.references, d.value, d.attributes], ["gMainMemoryPool", "derived", ["main_BSS_END"], null, {}]);
});

const ROM_OFFSET_PINS = "boot_core1_rzip_ROM_START = 0xF19250;\nboot_core1_rzip_ROM_END = 0xF55960;\nD_5E90 = 0x5E90;\npast_the_end = 0x2000000;\ngHeapBase = 0x80280000;\n";
const EXTENT = 0x10BCD40;

test("ROM offsets: inside the placed extent only, never over a RAM window, whitelist wins, floor from the model", () => {
  const m = defaultPinModel();
  const cls = (v, extent) => classifyAbsolute(v, { model: m, rom_extent: extent })[0];
  assert.equal(cls(0xF19250, EXTENT), ROM_OFFSET);
  assert.equal(cls(0x5E90, EXTENT), ROM_OFFSET);
  assert.equal(cls(0x2000000, EXTENT), UNCLASSIFIED);
  assert.equal(cls(0xF19250, null), UNCLASSIFIED);
  assert.equal(cls(0x80280000, 0xFFFFFFFF), ARTIFACT_SUSPECT);
  assert.equal(cls(0xA4040010, 0xFFFFFFFF), AUTHENTIC_FIXED);
  assert.equal(cls(0xB0000574, 0xFFFFFFFF), ARTIFACT_SUSPECT);
  const [c, , reason] = classifyAbsolute(0x5E90, { model: defaultPinModel({ whitelist: [new WhitelistEntry({ lo: 0x5E90, hi: 0x5E91, reason: "the caller says so" })] }), rom_extent: EXTENT });
  assert.deepEqual([c, reason], [AUTHENTIC_FIXED, "the caller says so"]);
  const high = new RangeModel({ windows: [new NamedRange("high", 0x90000000, 0xA0000000)] });
  assert.equal(classifyAbsolute(0x88000000, { model: high, rom_extent: 0xFFFFFFFF })[0], ROM_OFFSET);
  const r = classifyAbsolute(0xF19250, { model: m, rom_extent: EXTENT })[2];
  assert.ok(r.includes("_ROM_START") && r.includes("raw ROM offset"));
  assert.ok(CLASSIFICATIONS.indexOf(ARTIFACT_SUSPECT) < CLASSIFICATIONS.indexOf(ROM_OFFSET) && CLASSIFICATIONS.indexOf(ROM_OFFSET) < CLASSIFICATIONS.indexOf(UNCLASSIFIED));
  const by = Object.fromEntries(parsePinText(ROM_OFFSET_PINS, { path: "pins.txt", model: m, rom_extent: EXTENT }).map((e) => [e.name, e.classification]));
  assert.deepEqual(by, { boot_core1_rzip_ROM_START: ROM_OFFSET, boot_core1_rzip_ROM_END: ROM_OFFSET, D_5E90: ROM_OFFSET, past_the_end: UNCLASSIFIED, gHeapBase: ARTIFACT_SUSPECT });
});

test("the ROM-offset reclassification pass moves exactly the offsets", () => {
  const m = defaultPinModel();
  const cat = new PinCatalogue({ entries: parsePinText(ROM_OFFSET_PINS + UNDEFINED_SYMS, { path: "pins.txt", model: m }), sources: ["pins.txt"] });
  assert.deepEqual([cat.counts[ROM_OFFSET], cat.counts[UNCLASSIFIED]], [0, 5]);
  const found = reclassifyRomOffsets(cat, { model: m, rom_extent: EXTENT });
  assert.deepEqual([found.counts[ROM_OFFSET], found.counts[UNCLASSIFIED]], [4, 1]);
  assert.equal(Object.values(found.counts).reduce((a, b) => a + b, 0), found.entries.length);
  const size = found.entries.find((e) => e.name === "__SIZE");
  assert.deepEqual([size.classification, size.value], [ROM_OFFSET, 0x50]);
  const before = Object.fromEntries(cat.entries.map((e) => [e.name, e.classification]));
  const after = Object.fromEntries(reclassifyRomOffsets(cat, { model: m, rom_extent: 0xFFFFFFFF }).entries.map((e) => [e.name, e.classification]));
  for (const n of Object.keys(before)) if (before[n] !== after[n]) assert.equal(before[n], UNCLASSIFIED);
  const mystery = new PinCatalogue({ entries: parsePinText("mystery = 1 ? 2 : 3;\n", { path: "pins.txt", model: m }), sources: ["pins.txt"] });
  assert.deepEqual(mystery.entries.map((e) => e.form), ["unresolved"]);
  const r = reclassifyRomOffsets(mystery, { model: m, rom_extent: 0x1000 });
  assert.equal(r.counts[UNCLASSIFIED], r.entries.length);
  assert.deepEqual(found.sources, cat.sources);
  const p = found.asDict({ limit: 2 });
  assert.deepEqual([p.pins_rom_offset, p.pins_unclassified], [4, 1]);
});

const TEMPLATE_PINS = "SP_STATUS_REG = 0xA4040010;\nosTvType = 0x80000300;\ngameLoop = 0x80005000;\ngMainMemoryPool = main_BSS_END;\n";
const templateCatalogue = (m) => new PinCatalogue({ entries: parsePinText(TEMPLATE_PINS, { path: "pins.txt", model: m }), sources: ["pins.txt"] });

test("whitelist template: both evidence families drafted, owned addresses and covered pins not drafted", () => {
  const m = defaultPinModel(), cat = templateCatalogue(m);
  assert.deepEqual(whitelistCandidates(cat, { window_lo: 0x80000400 }).map((c) => [c.name, c.rule]), [["osTvType", "below-window-floor"], ["SP_STATUS_REG", "hardware-window"]]);
  const low = new Set(whitelistCandidates(cat, { window_lo: 0x400 }).map((c) => c.name));
  assert.ok(!low.has("gameLoop") && !low.has("osTvType"));
  const covered = new Set(whitelistCandidates(templateCatalogue(defaultPinModel({ whitelist: [bootGlobalsWhitelist()] })), { window_lo: 0x80000400 }).map((c) => c.name));
  assert.ok(!covered.has("osTvType") && covered.has("SP_STATUS_REG"));
});

test("whitelist template: commented out and marked, parses to nothing until edited, names its floor and rules", () => {
  const cat = templateCatalogue(defaultPinModel());
  const text = whitelistTemplateText(cat, { window_lo: 0x80000400, window_lo_section: ".main" });
  assert.ok(text.includes(`${WHITELIST_REVIEW_MARKER} osTvType (pins.txt:2)`));
  assert.ok(text.includes("# 0x80000300 osTvType:") && text.includes("# 0xA4040010 SP_STATUS_REG:"));
  assert.deepEqual(parseWhitelistText(text), []);
  const entries = parseWhitelistText(text.replace("# 0x80000300 ", "0x80000300 "));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lo, 0x80000300);
  assert.ok(entries[0].reason.includes("boot-globals shaped"));
  assert.ok(text.includes("movable window floor: 0x80000400 (.main)") && text.includes("pin_sources: pins.txt"));
  const flat = text.split(/\s+/).join(" ");
  for (const r of WHITELIST_TEMPLATE_RULES) assert.ok(text.includes(r.name) && flat.includes(r.evidence), r.name);
  assert.ok(text.includes("hardware-window (1)") && text.includes("below-window-floor (1)"));
  const empty = new PinCatalogue({ entries: parsePinText("gMainMemoryPool = main_BSS_END;\n", { path: "pins.txt", model: defaultPinModel() }), sources: ["pins.txt"] });
  const et = whitelistTemplateText(empty, { window_lo: 0x80000400 });
  assert.ok(et.includes("No pin in these files has either shape"));
  assert.deepEqual(parseWhitelistText(et), []);
});

test("two files merge into one catalogue that names both", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-pins-"));
  try {
    const first = path.join(root, "undefined_syms.txt"), second = path.join(root, "symbol_addrs.txt");
    writeFileSync(first, UNDEFINED_SYMS);
    writeFileSync(second, SYMBOL_ADDRS);
    const found = readPinFiles([first, second], { model: defaultPinModel() });
    assert.deepEqual(found.sources, [first, second]);
    assert.equal(found.entries.length, 12);
    assert.deepEqual(new Set(found.entries.map((e) => e.source)), new Set([first, second]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const SHADOW_LINK = buildElf([[".text", 0x80000400, 0x100, 6], [".bss", 0x80000500, 0x80, 3]], [["gCounter", 0x80000500, 4, 1, 1, 2],
  ["D_80000540", 0x80000540, 8, 1, 1, SHN_ABS], ["D_B0000574", 0xB0000574, 0, 0, 1, SHN_ABS], ["gMainMemoryPool", 0x80000560, 0, 0, 1, SHN_ABS]]);
const SHADOW_PINS = "\nD_80000540 = 0x80000540;\nD_B0000574 = 0xB0000574;\ngCounter = 0x80000500;\ngMainMemoryPool = main_BSS_END;\nD_C0DEC0DE = 0xC0DEC0DE;\n";

test("shadowing pins: only the inherited size reclassifies; object-backed, derived and unknown pins are left alone", () => {
  const m = defaultPinModel();
  const cat = new PinCatalogue({ entries: parsePinText(SHADOW_PINS, { path: "syms.txt", model: m }), sources: ["syms.txt"] });
  const elf = parseElfSymbols(SHADOW_LINK, { path: "game.elf" });
  const before = Object.fromEntries(cat.entries.map((e) => [e.name, e.classification]));
  assert.deepEqual([before.D_80000540, before.D_B0000574], [ARTIFACT_SUSPECT, ARTIFACT_SUSPECT]);
  const re = reclassifyShadowingPins(cat, { elf });
  const after = Object.fromEntries(re.entries.map((e) => [e.name, e.classification]));
  assert.deepEqual([after.D_80000540, after.D_B0000574, after.gCounter, after.gMainMemoryPool, after.D_C0DEC0DE],
    [SHADOWING_PIN, ARTIFACT_SUSPECT, ARTIFACT_SUSPECT, DERIVED, UNCLASSIFIED]);
  const pin = re.entries.find((e) => e.name === "D_80000540");
  assert.ok(pin.reason.includes("already defines") && pin.reason.includes("byte-identical"));
  assert.ok(SHADOWING_PIN in cat.counts);
  assert.equal(cat.counts[SHADOWING_PIN], 0);
  assert.ok("pins_shadowing" in cat.asDict({ limit: 5 }));
  assert.equal(CLASSIFICATIONS[0], SHADOWING_PIN);
  assert.equal(re.ranked()[0].name, "D_80000540");
  assert.deepEqual(re.sources, ["syms.txt"]);
});
