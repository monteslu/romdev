// The static shiftability inventory (`shift audit`): region derivation,
// blob suggestion, the movable window, map/image consistency, the ranked
// word scan, pins, shadowing, missing pin sources, and the command. Ported
// from the workbench's own tests; every fixture is a handcrafted map and a
// small hand-built image. The upstream conformance classes replay
// commercial projects' artifacts and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SHN_ABS, parseElfSymbols, parseLdMap } from "../src/decomp/workbench/ldmap.js";
import { WhitelistEntry } from "../src/decomp/workbench/mips-refs.js";
import { ARTIFACT_SUSPECT, AUTHENTIC_FIXED, DERIVED, ROM_OFFSET, SHADOWING_PIN, UNCLASSIFIED, PinCatalogue, bootGlobalsWhitelist, defaultPinModel,
  parsePinText, parseWhitelistText, readPinFiles } from "../src/decomp/workbench/pins.js";
import { SHIFT_CENSUS_KEYS, SHIFT_METRICS_BY_KEY, explainKeysText } from "../src/decomp/workbench/schema.js";
import { BLOB_OBJECT_RULES, BLOB_SOURCE_AUTO, BLOB_SOURCE_EXPLICIT, BLOB_SOURCE_NONE, CLUSTER_MINIMUM, MAP_SNIFF_BYTES, MOVABLE_FLOOR_MIN, NON_ALLOC_KIND,
  NON_ALLOC_ROM_SOURCE, NON_ALLOC_SECTION_FAMILIES, REPEAT_MINIMUM, RESIDENCE_SCORES, TIER_RULES, ConsistencyCheck, MovableWindow, Region, ShiftAudit,
  buildRegionTable, buildShiftAudit, checkMapImageConsistency, findMissingPinSources, movableWindow, requireParsedMap, resolveBlobs, shiftAuditLines,
  suggestBlobs } from "../src/decomp/workbench/shift-audit.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { ValueError } from "../src/decomp/workbench/py.js";
import { buildElf } from "./fixtures/workbench/elf-symtab.js";
import { SYNTHETIC_IMAGE, NON_ALLOC_MAP, NON_ALLOC_WITH_AT_MAP, OVERLAY_SIBLING_MAP, BLOB_INPUT_IMAGE, blobInputMap, syntheticMap, emptyPins,
  readPinText, blobAudit, audit, tiers, hitAt, words, zeros, SYNTHETIC_MAP } from "./fixtures/workbench/shift-fixtures.js";

const region = (output_section, kind, { vram = 0, size, rom, rom_source = "load-address" }) => new Region({ output_section, kind, vram, size, rom, rom_source });
const raisesValue = (fn, check = () => true) => assert.throws(fn, (e) => (e instanceof ValueError || e.name === "ValueError") && check(e.message));

// WB-140 rule A: a map that parsed to nothing

test("require parsed map: accepted, bounded sniff, refused, swap hint only for binary", () => {
  requireParsedMap(syntheticMap(), { path: "synthetic.map" });
  assert.ok(MAP_SNIFF_BYTES > 0 && MAP_SNIFF_BYTES < 1_000_000);
  const empty = parseLdMap("not a linker map, just some prose\n");
  assert.deepEqual(empty.sections, []);
  raisesValue(() => requireParsedMap(empty, { path: "game.z64" }), (m) => m.includes("game.z64") && m.includes("parsed as no linker map"));
  raisesValue(() => requireParsedMap(parseLdMap(""), { path: "game.z64", sample: Buffer.from([0x80, 0x37, 0x12, 0x40, 0]) }), (m) => m.includes("--map and --image may be swapped"));
  raisesValue(() => requireParsedMap(parseLdMap(""), { path: "notes.txt", sample: Buffer.from("just some unrelated text\n") }), (m) => !m.includes("swapped"));
  raisesValue(() => requireParsedMap(parseLdMap(""), { path: "whatever" }), (m) => !m.includes("swapped"));
});

// WB-140 rule C: a typo'd --blob

test("blob names must be output sections the map has; lists are capped", () => {
  buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot"] });
  raisesValue(() => buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot1"] }),
    (m) => m.includes("--blob names a section this map does not have: .boot1") && m.includes("map sections: .header, .boot, .main, .main_bss"));
  raisesValue(() => buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot", ".nope", ".alsonope"] }),
    (m) => m.includes(".nope") && m.includes(".alsonope") && !m.includes("map does not have: .boot,"));
  const text = "Linker script and memory map\n\n" + Array.from({ length: 30 }, (_, i) => `.sec${String(i).padStart(3, "0")}      0x${(i * 0x10).toString(16).padStart(8, "0")}       0x10\n`).join("");
  raisesValue(() => buildRegionTable(parseLdMap(text), { image_size: 0x300, blobs: [".missing"] }), (m) => m.includes("more)"));
});

test("region derivation: one region per kind run, data runs merge, placements say how", () => {
  const regions = buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot"] });
  assert.deepEqual(regions.map((r) => [r.output_section, r.kind]), [[".header", "header"], [".boot", "blob"], [".main", "text"], [".main", "data"], [".main_bss", "bss"]]);
  const text = regions.find((r) => r.kind === "text"), data = regions.find((r) => r.kind === "data");
  assert.deepEqual([text.vram, text.size], [0x80000400, 0x30]);
  assert.deepEqual([data.vram, data.size], [0x80000430, 0x50]);
  assert.deepEqual([data.rom, data.rom_source], [0x50, "load-address"]);
  assert.deepEqual([regions[0].rom, regions[0].rom_source], [0, "vma-as-rom"]);
  const bss = regions.find((r) => r.kind === "bss");
  assert.equal(bss.scanned, false);
  assert.equal(bss.rom_source, "not-resident");
  assert.equal(text.rom, 0x20);
  assert.equal(text.scanned, false);
  assert.equal(buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [] })[1].kind, "data");
  assert.equal(regions[1].kind, "blob");
  const short = buildRegionTable(syntheticMap(), { image_size: 0x30, blobs: [] });
  const unplaced = short.filter((r) => r.rom_source === "unplaced");
  assert.ok(unplaced.length && unplaced.every((r) => !r.scanned));
});

test("the movable window runs from the first movable start to the last bss end, ignoring blobs and the header", () => {
  const w = movableWindow(buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot"] }));
  assert.deepEqual([w.lo, w.hi, w.lo_section, w.hi_section], [0x80000400, 0x800104A0, ".main", ".main_bss"]);
  assert.equal(movableWindow(buildRegionTable(syntheticMap(), { image_size: SYNTHETIC_IMAGE.length, blobs: [".boot", ".header"] })).lo, 0x80000400);
});

// S7: the map already knows which sections are opaque

test("blob rules: suffix and directory component matching, evidence on every rule", () => {
  const rule = (n) => BLOB_OBJECT_RULES.find((r) => r.name === n);
  assert.ok(rule("bin-object-suffix").matches("build/assets/boot.bin.o") && !rule("bin-object-suffix").matches("build/src/boot.c.o"));
  const d = rule("bin-directory");
  assert.ok(d.matches("build/bin/filesys.o") && d.matches("build/us.v10/bin/core2/data_DC600.bin.o"));
  assert.ok(!d.matches("build/binaries/filesys.o") && !d.matches("build/src/bin"));
  for (const r of BLOB_OBJECT_RULES) {
    assert.ok(["suffix", "directory"].includes(r.match) && r.evidence);
    assert.deepEqual(new Set(Object.keys(r.asDict())), new Set(["name", "pattern", "match", "evidence"]));
  }
});

test("blob suggestion: all-raw-binary sections in map order, with evidence; never mixed, compiled or empty", () => {
  const s = suggestBlobs(blobInputMap());
  assert.deepEqual(s.map((x) => x.output_section), [".boot", ".assets", ".filesys"]);
  assert.ok(!s.some((x) => x.output_section === ".main" || x.output_section === ".header"));
  assert.deepEqual(suggestBlobs(parseLdMap("Linker script and memory map\n\n.nothing        0x00000000       0x10\n", { path: "empty.map" })), []);
  const by = Object.fromEntries(s.map((x) => [x.output_section, x]));
  assert.equal(by[".boot"].rule, "bin-object-suffix");
  assert.deepEqual(by[".boot"].objects, ["build/assets/boot.bin.o"]);
  assert.equal(by[".filesys"].rule, "bin-directory");
  assert.deepEqual(by[".filesys"].objects, ["build/bin/filesys.o"]);
  assert.deepEqual([by[".filesys"].input_records, by[".filesys"].vram, by[".filesys"].size], [1, 0x30, 0x10]);
});

test("resolve blobs: none, explicit, auto, add on top, subtract, refusals, empty result, JSON", () => {
  const m = blobInputMap();
  let p = resolveBlobs(m);
  assert.deepEqual([p.applied, p.source, p.suggested, p.unadopted], [[], BLOB_SOURCE_NONE, [".boot", ".assets", ".filesys"], [".boot", ".assets", ".filesys"]]);
  p = resolveBlobs(m, { blobs: [".assets"] });
  assert.deepEqual([p.applied, p.source, p.unadopted], [[".assets"], BLOB_SOURCE_EXPLICIT, [".boot", ".filesys"]]);
  p = resolveBlobs(m, { auto: true });
  assert.deepEqual([p.applied, p.source, p.unadopted], [[".boot", ".assets", ".filesys"], BLOB_SOURCE_AUTO, []]);
  p = resolveBlobs(m, { blobs: [".header"], auto: true });
  assert.deepEqual([p.applied, p.source], [[".header", ".boot", ".assets", ".filesys"], BLOB_SOURCE_AUTO]);
  p = resolveBlobs(m, { auto: true, excluded: [".boot"] });
  assert.deepEqual([p.applied, p.excluded, p.unadopted], [[".assets", ".filesys"], [".boot"], [".boot"]]);
  raisesValue(() => resolveBlobs(m, { blobs: [".assets"], excluded: [".assets"] }), (x) => x.includes("--blob and --no-blob name the same section") && x.includes(".assets"));
  raisesValue(() => resolveBlobs(m, { auto: true, excluded: [".asset"] }), (x) => x.includes("--no-blob names a section this map does not have: .asset"));
  p = resolveBlobs(m, { auto: true, excluded: [".boot", ".assets", ".filesys"] });
  assert.deepEqual([p.applied, p.source], [[], BLOB_SOURCE_NONE]);
  const j = resolveBlobs(m, { auto: true }).asDict();
  assert.deepEqual([j.blobs, j.blob_source, j.suggested_blobs, j.blobs_excluded], [[".boot", ".assets", ".filesys"], BLOB_SOURCE_AUTO, [".boot", ".assets", ".filesys"], []]);
  assert.deepEqual(j.blob_rules.map((r) => r.name), BLOB_OBJECT_RULES.map((r) => r.name));
  assert.deepEqual(new Set(Object.keys(j.blob_suggestions[0])), new Set(["output_section", "rule", "objects", "input_records", "vram", "size"]));
  JSON.stringify(j);
});

test("auto blobs agree with the explicit flags on every number, and demote the word inside the blob", () => {
  const a = blobAudit({ auto_blobs: true }).asDict({ limit: 10 }), e = blobAudit({ blobs: [".boot", ".assets", ".filesys"] }).asDict({ limit: 10 });
  delete a.blob_source; delete e.blob_source;
  assert.deepEqual([...a.blobs].sort(), [...e.blobs].sort());
  delete a.blobs; delete e.blobs;
  assert.deepEqual(a, e);
  assert.equal(hitAt(blobAudit(), 0x30).tier, "medium");
  assert.equal(hitAt(blobAudit({ auto_blobs: true }), 0x30).tier, "low");
  assert.equal(hitAt(blobAudit({ auto_blobs: true }), 0x60).tier, "medium");
});

test("movable window floor: residence, not the caller's blob list; high bound untouched; no RAM region keeps the old answer", () => {
  const w = movableWindow(buildRegionTable(blobInputMap(), { image_size: 0x80 }));
  assert.deepEqual([w.lo, w.lo_section, w.hi, w.hi_section], [0x80000400, ".main", 0x80000460, ".main_bss"]);
  const named = movableWindow(buildRegionTable(blobInputMap(), { image_size: 0x80, blobs: [".boot", ".assets", ".filesys"] }));
  assert.deepEqual([named.lo, named.lo_section], [w.lo, w.lo_section]);
  const low = movableWindow([region(".low", "data", { vram: 0x40, size: 0x10, rom: 0x40 }), region(".lower", "data", { vram: 0x20, size: 0x10, rom: 0x20 })]);
  assert.deepEqual([low.lo, low.lo_section], [0x20, ".lower"]);
  assert.equal(MOVABLE_FLOOR_MIN, 0x80000000);
  const found = blobAudit();
  assert.equal(found.scan_total, 2);
  assert.deepEqual(found.hits.map((h) => h.rom), [0x30, 0x60]);
});

const NAMES = [".mdebug", ".mdebug.abi32", ".pdr", ".comment", ".gptab.sdata", ".reginfo", ".options", ".debug_info", ".line", ".rel.text"];

test("non-alloc sections are recognized, excluded, never placed by VMA, still listed, and outside the window", () => {
  const regions = buildRegionTable(parseLdMap(NON_ALLOC_MAP), { image_size: 0x200, blobs: [] });
  const by = Object.fromEntries(regions.map((r) => [r.output_section, r]));
  assert.deepEqual(new Set(NON_ALLOC_SECTION_FAMILIES.map(([n]) => n)), new Set([".mdebug", ".pdr", ".comment", ".gptab", ".reginfo", ".options", ".debug", ".line", ".rel."]));
  for (const n of NAMES) {
    const r = by[n];
    assert.deepEqual([r.kind, r.rom, r.rom_source, r.scanned], [NON_ALLOC_KIND, null, NON_ALLOC_ROM_SOURCE, false], n);
  }
  assert.equal(by[".mdebug"].vram, 0);
  assert.notEqual(by[".mdebug"].rom_source, "vma-as-rom");
  const w = movableWindow(regions);
  assert.deepEqual([w.lo, w.lo_section], [0x80000400, ".main"]);
  const withAt = buildRegionTable(parseLdMap(NON_ALLOC_WITH_AT_MAP), { image_size: 0x300, blobs: [] }).find((r) => r.output_section === ".comment");
  assert.notEqual(withAt.kind, NON_ALLOC_KIND);
  assert.deepEqual([withAt.rom, withAt.rom_source], [0x200, "load-address"]);
});

test("overlay siblings each resolve through their own load address", () => {
  const regions = buildRegionTable(parseLdMap(OVERLAY_SIBLING_MAP), { image_size: 0x300000, blobs: [] });
  const by = Object.fromEntries(regions.map((r) => [`${r.output_section}|${r.kind}`, r]));
  assert.deepEqual([by[".overlay_a|text"].rom, by[".overlay_b|text"].rom], [0x100000, 0x200000]);
  assert.equal(by[".overlay_a|text"].rom_source, "load-address");
  assert.deepEqual([by[".overlay_a|data"].rom, by[".overlay_a|data"].rom_source], [0x100010, "load-address"]);
});

// WB-140 rule B: does this image match this map?

test("consistency: exact match, zero/0xFF/pattern padding accepted", () => {
  const one = [region(".data", "data", { size: 0x40, rom: 0 })];
  let f = checkMapImageConsistency(one, Buffer.alloc(0x40));
  assert.deepEqual([f.max_placed_extent, f.padding_bytes, f.regions_unplaced_past_eof], [0x40, 0, 0]);
  assert.equal(checkMapImageConsistency(one, Buffer.alloc(0x50)).padding_bytes, 0x10);
  assert.equal(checkMapImageConsistency(one, Buffer.concat([Buffer.alloc(0x40), Buffer.alloc(0x10, 0xFF)])).padding_bytes, 0x10);
  const pattern = Buffer.concat([Buffer.alloc(0x40), Buffer.from(Array(8).fill([0xAB, 0xCD]).flat())]);
  assert.equal(checkMapImageConsistency(one, pattern).padding_bytes, 0x10);
});

test("consistency: a non-uniform excess is a hard error naming both numbers and both paths", () => {
  const one = [region(".data", "data", { size: 0x40, rom: 0 })];
  raisesValue(() => checkMapImageConsistency(one, Buffer.concat([Buffer.alloc(0x40), Buffer.from("030f05ac0fee028c15f0007402fb0c13", "hex")])),
    (m) => m.includes("extends 16 bytes past the map's placed extent") && m.includes("not uniform padding") && m.includes("different builds")
      && m.includes("image_bytes=80") && m.includes("map_placed_extent=64"));
  raisesValue(() => checkMapImageConsistency(one, Buffer.concat([Buffer.alloc(0x40), Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex")]), { map_path: "game.map", image_path: "game.z64" }),
    (m) => m.includes("game.map") && m.includes("game.z64"));
});

test("consistency: a minority past EOF is reported, a majority is the wrong image, tails count, bss/non-alloc never do", () => {
  const three = [region(".a", "data", { size: 0x10, rom: 0 }), region(".b", "data", { size: 0x10, rom: 0x10 }), region(".c", "data", { size: 0x10, rom: 0x20 })];
  const f = checkMapImageConsistency(three, Buffer.alloc(0x28));
  assert.deepEqual([f.max_placed_extent, f.padding_bytes, f.regions_unplaced_past_eof], [0x30, null, 1]);
  raisesValue(() => checkMapImageConsistency(three, Buffer.alloc(0x18)), (m) => m.includes("2 of 3 placed regions land past the end") && m.includes("not an overlay quirk") && m.includes("that is the wrong image"));
  assert.equal(checkMapImageConsistency([region(".a", "data", { size: 0x10, rom: 0 }), region(".b", "data", { size: 0x20, rom: 0x10 })], Buffer.alloc(0x18)).regions_unplaced_past_eof, 1);
  const g = checkMapImageConsistency([region(".a", "data", { size: 0x10, rom: 0 }), region(".bss", "bss", { size: 0x1000, rom: null, rom_source: "not-resident" }),
    region(".mdebug", NON_ALLOC_KIND, { size: 0x2000, rom: null, rom_source: NON_ALLOC_ROM_SOURCE })], Buffer.alloc(0x10));
  assert.deepEqual([g.max_placed_extent, g.regions_unplaced_past_eof, g.padding_bytes], [0x10, 0, 0]);
  assert.deepEqual(new ConsistencyCheck({ max_placed_extent: 0x10, padding_bytes: 4, regions_unplaced_past_eof: 0 }).asDict(), { max_placed_extent: 0x10, padding_bytes: 4, regions_unplaced_past_eof: 0 });
});

// The scan: every confidence feature, one word each

test("scan: text counted not scanned; data, blob and header covered", () => {
  const a = audit();
  assert.deepEqual([a.text_words, a.text_regions], [12, 1]);
  assert.deepEqual(a.hits.filter((h) => h.rom < 0x50).map((h) => h.rom), [0x04, 0x10, 0x14]);
  assert.deepEqual([a.scanned_words, a.scan_total], [28, 15]);
});

test("scan features: alignment, symbol start, mid-symbol, residence, attribution", () => {
  const a = audit();
  let h = hitAt(a, 0x54);
  assert.deepEqual([h.alignment, h.rule, h.tier], [3, "misaligned", "low"]);
  h = hitAt(a, 0x50);
  assert.deepEqual([h.points_at_symbol_start, h.target_symbol, h.target_offset, h.tier], [true, "gTarget", 0, "high"]);
  h = hitAt(a, 0x5C);
  assert.deepEqual([h.points_at_symbol_start, h.target_symbol, h.target_offset, h.tier], [false, "gOther", 4, "medium"]);
  assert.equal(hitAt(a, 0x10).value, hitAt(a, 0x50).value);
  assert.deepEqual([hitAt(a, 0x10).tier, hitAt(a, 0x50).tier], ["medium", "high"]);
  assert.equal(hitAt(a, 0x10).resident_symbol, null);
  assert.equal(hitAt(a, 0x10).region, ".boot");
  assert.equal(hitAt(a, 0x50).resident_symbol, "gData");
  assert.equal(hitAt(a, 0x54).resident_offset, 4);
});

test("scan features: progression cluster, repeated value, round constant, whitelist", () => {
  const a = audit();
  const members = a.hits.filter((h) => h.cluster !== null);
  assert.deepEqual(members.map((h) => h.rom), [0x60, 0x64, 0x68]);
  assert.deepEqual(new Set(members.map((h) => h.cluster)), new Set([0]));
  assert.deepEqual(new Set(members.map((h) => h.rule)), new Set(["progression-cluster"]));
  assert.deepEqual(new Set(members.map((h) => h.tier)), new Set(["low"]));
  assert.ok(members.length >= CLUSTER_MINIMUM);
  const reps = a.hits.filter((h) => h.value === 0x80000474);
  assert.equal(reps.length, REPEAT_MINIMUM);
  assert.deepEqual(new Set(reps.map((h) => h.repeats)), new Set([REPEAT_MINIMUM]));
  assert.deepEqual(new Set(reps.map((h) => h.rule)), new Set(["repeated-value"]));
  assert.deepEqual(new Set(reps.map((h) => h.tier)), new Set(["low"]));
  assert.ok(a.hits.filter((h) => h.repeats > 1).every((h) => h.cluster === null));
  assert.deepEqual([hitAt(a, 0x58).rule, hitAt(a, 0x58).tier], ["round-constant", "low"]);
  const w = hitAt(audit({ whitelist: [new WhitelistEntry({ lo: 0x80000480, hi: 0x80000481, reason: "the caller says so" })] }), 0x80);
  assert.deepEqual([w.rule, w.tier, w.whitelisted, w.reason], ["whitelisted", "low", true, "the caller says so"]);
  assert.equal(hitAt(audit(), 0x80).tier, "medium");
});

test("tier totals are readable by hand; the rule tally partitions the scan", () => {
  const a = audit();
  assert.deepEqual(tiers(a), { high: 1, medium: 3, low: 11 });
  assert.equal(a.scan_high + a.scan_medium + a.scan_low, a.scan_total);
  assert.deepEqual(tiers(audit({ blobs: [] })), { high: 2, medium: 3, low: 10 });
  assert.equal(Object.values(a.scan_rules).reduce((x, y) => x + y, 0), a.scan_total);
  assert.deepEqual(a.scan_rules, { misaligned: 1, "progression-cluster": 3, "repeated-value": 4, "round-constant": 1, scored: 6 });
  const published = new Set([...TIER_RULES.map((r) => r.name), "scored"]);
  const w = audit({ whitelist: [new WhitelistEntry({ lo: 0x80000480, hi: 0x80000481, reason: "the caller says so" })] });
  for (const h of w.hits) assert.ok(published.has(h.rule));
  assert.deepEqual(new Set(Object.keys(RESIDENCE_SCORES)), new Set(["data", "header", "blob"]));
});

function allKeys(v) {
  const out = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { out.add(k); walk(y); }
  };
  walk(v);
  return out;
}

test("report shape: census scalars, capped ranked detail, rules and regions travel, plain JSON", () => {
  const a = audit(), p = a.asDict({ limit: 4 });
  for (const k of ["pins_total", "pins_derived", "pins_authentic", "pins_artifact", "pins_unclassified", "scan_total", "scan_high", "scan_medium", "scan_low",
    "scanned_words", "text_words", "text_regions", "region_count", "image_bytes", "window_lo", "window_hi"]) {
    assert.ok(k in p && (typeof p[k] === "number" || typeof p[k] === "string"), k);
  }
  assert.deepEqual([p.limit, p.hits_shown, p.hits.length, p.scan_total], [4, 4, 4, 15]);
  assert.deepEqual(p.hits.map((h) => h.tier), ["high", "medium", "medium", "medium"]);
  const names = p.rules.map((r) => r.name);
  assert.ok(names.includes("misaligned") && names.includes("progression-cluster"));
  for (const r of p.rules) assert.deepEqual(new Set(Object.keys(r)), new Set(["name", "tier", "evidence"]));
  assert.equal(p.residence_scores.blob, 0);
  assert.equal(p.tier_thresholds.high, 3);
  const regs = p.regions.map((r) => `${r.output_section}|${r.kind}`);
  assert.ok(regs.includes(".main|text") && regs.includes(".main_bss|bss"));
  assert.equal(p.region_count, 5);
  JSON.stringify(p);
});

test("every JSON key the report emits is registered and explained", () => {
  const p = audit().asDict({ limit: 4 });
  const emitted = allKeys(p);
  emitted.delete("schema");
  for (const group of [p.scan_rules, p.scan_by_region, p.residence_scores, p.tier_thresholds]) for (const k of Object.keys(group)) emitted.delete(k);
  const text = explainKeysText();
  for (const k of emitted) {
    assert.ok(k in SHIFT_METRICS_BY_KEY, `unregistered ${k}`);
    assert.ok(text.includes(k), `unexplained ${k}`);
  }
});

test("every printed label is a registered key; the census registry is the shift vocabulary", () => {
  const headers = ["output_section kind vram size rom rom_source words scanned", "name value window source line", "rule count", "region count",
    "rom value tier rule region resident_symbol target_symbol"];
  for (const row of headers) for (const label of row.split(" ")) assert.ok(label in SHIFT_METRICS_BY_KEY, label);
  const withPins = buildShiftAudit({ ldmap: syntheticMap(), image: SYNTHETIC_IMAGE, pins: readPinText("D_B0000574 = 0xB0000574;\n"), model: defaultPinModel(), blobs: [".boot"] });
  const lines = shiftAuditLines(withPins, { limit: 4 });
  for (const row of headers) assert.ok(lines.some((l) => l.split(/\s+/).filter(Boolean).join(" ") === row), `no table with header ${row}`);
  assert.deepEqual(new Set(Object.keys(SHIFT_CENSUS_KEYS)), new Set(Object.keys(SHIFT_METRICS_BY_KEY)));
});

test("the human report prints the same numbers and says what text words are for", () => {
  const text = shiftAuditLines(audit(), { limit: 4 }).join("\n");
  for (const s of ["scan_total", "15", "0x80000400", "shift rehearse", "4 of 15", "12", "not scanned"]) assert.ok(text.includes(s), s);
});

test("blob report: the cold-start line, adoption, exclusions, registered suggestion keys", () => {
  let text = shiftAuditLines(blobAudit(), { limit: 4 }).join("\n");
  assert.ok(text.includes("blobs=-  blob_source=none") && text.includes("suggested_blobs (from .bin.o inputs): .boot, .assets, .filesys") && text.includes("--blobs auto"));
  text = shiftAuditLines(blobAudit({ auto_blobs: true }), { limit: 4 }).join("\n");
  assert.ok(text.includes("blobs=.boot, .assets, .filesys  blob_source=auto") && !text.includes("suggested_blobs (from"));
  text = shiftAuditLines(blobAudit({ auto_blobs: true, excluded_blobs: [".boot"] }), { limit: 4 }).join("\n");
  assert.ok(text.includes("blobs_excluded=.boot") && text.includes("suggested_blobs (from .bin.o inputs): .boot"));
  const p = blobAudit({ auto_blobs: true }).asDict({ limit: 4 });
  const emitted = new Set([...p.blob_suggestions, ...p.blob_rules].flatMap((r) => Object.keys(r)));
  assert.ok(emitted.size);
  const explained = explainKeysText();
  for (const k of emitted) assert.ok(k in SHIFT_METRICS_BY_KEY, k);
  for (const k of [...emitted, "blobs", "blob_source", "blobs_excluded"]) assert.ok(explained.includes(k), k);
});

// Command

function tempRoot(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-shiftaudit-"));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(root, n), c);
  return root;
}
async function withRoot(files, fn) { const root = tempRoot(files); try { return await fn((n) => path.join(root, n)); } finally { rmSync(root, { recursive: true, force: true }); } }
const synth = { "synthetic.map": SYNTHETIC_MAP, "synthetic.z64": SYNTHETIC_IMAGE };
const baseArgs = (p) => ["shift", "audit", "--map", p("synthetic.map"), "--image", p("synthetic.z64"), "--blob", ".boot"];

test("command: group spelling runs; JSON carries the schema identity; blob changes the answer", () => withRoot(synth, async (p) => {
  let r = await runCommand(baseArgs(p));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("shift audit"));
  r = await runCommand([...baseArgs(p), "--json"]);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.schema, j.scan_total, j.scan_high], [0, "decomp-workbench-shift-audit-v1", 15, 1]);
  r = await runCommand(["shift", "audit", "--map", p("synthetic.map"), "--image", p("synthetic.z64"), "--json"]);
  assert.equal(JSON.parse(r.stdout).scan_high, 2);
}));

test("command: pins are read and counted; a whitelist reaches both pins and scan; malformed whitelist refused", () => withRoot({ ...synth,
  "undefined_syms.txt": "/* fake */\nD_B0000574 = 0xB0000574;\ngPool = main_BSS_END;\n", "tv.txt": "osTvType = 0x80000300;\n",
  "whitelist.txt": "# the caller's claim, with its reason\n0x80000300-0x80000400 boot globals\n0x80000480 a fixed thing\n", "bad.txt": "0x80000300\n" }, async (p) => {
  let r = await runCommand([...baseArgs(p), "--pins", p("undefined_syms.txt"), "--json"]);
  let j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.pins_total, j.pins_artifact, j.pins_derived], [0, 2, 1, 1]);
  r = await runCommand([...baseArgs(p), "--pins", p("tv.txt"), "--whitelist", p("whitelist.txt"), "--json"]);
  j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.pins_authentic, j.scan_medium], [0, 1, 2]);
  r = await runCommand([...baseArgs(p), "--whitelist", p("bad.txt")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
}));

test("command refusals: missing image, zero-section map with swap hint, mismatched image, unknown blob", () => withRoot({ ...synth,
  "not-a-map.z64": Buffer.from(Array(4).fill([...Array(256).keys()]).flat()), "mismatched.z64": Buffer.concat([SYNTHETIC_IMAGE, Buffer.from("0102030405060708", "hex")]) }, async (p) => {
  let r = await runCommand(["shift", "audit", "--map", p("synthetic.map"), "--image", p("absent.z64")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
  r = await runCommand(["shift", "audit", "--map", p("not-a-map.z64"), "--image", p("synthetic.z64")]);
  assert.equal(r.code, 2);
  for (const s of ["error:", p("not-a-map.z64"), "parsed as no linker map", "--map and --image may be swapped"]) assert.ok(r.stderr.includes(s), s);
  r = await runCommand(["shift", "audit", "--map", p("synthetic.map"), "--image", p("mismatched.z64"), "--blob", ".boot"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("not uniform padding") && r.stderr.includes("different builds"));
  r = await runCommand(["shift", "audit", "--map", p("synthetic.map"), "--image", p("synthetic.z64"), "--blob", ".nope"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--blob names a section this map does not have: .nope"));
}));

test("command: census exit codes, unknown and near-miss keys refused before reading, explain-keys, group listing, limit", () => withRoot(synth, async (p) => {
  assert.equal((await runCommand([...baseArgs(p), "--census", "scan_high=1"])).code, 0);
  let r = await runCommand([...baseArgs(p), "--census", "scan_high=99"]);
  assert.equal(r.code, 3);
  assert.ok(r.stdout.includes("census: FAIL"));
  r = await runCommand(["shift", "audit", "--map", "absent.map", "--image", "absent.z64", "--census", "x=1"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("unknown census key 'x'"));
  r = await runCommand(["shift", "audit", "--map", "absent.map", "--image", "absent.z64", "--census", "pins_shadowingg=0"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("did you mean 'pins_shadowing'?"));
  r = await runCommand(["shift", "audit", "--explain-keys"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("scan_total"));
  r = await runCommand(["shift"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("audit"));
  r = await runCommand([...baseArgs(p), "--limit", "2"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("2 of 15"));
}));

const blobFiles = { "blobs.map": (await import("./fixtures/workbench/shift-fixtures.js")).BLOB_INPUT_MAP, "blobs.z64": BLOB_INPUT_IMAGE };
const blobJson = async (p, extra) => { const r = await runCommand(["shift", "audit", "--map", p("blobs.map"), "--image", p("blobs.z64"), "--json", ...extra]); return [r.code, r.code === 0 ? JSON.parse(r.stdout) : {}, r]; };

test("blob commands: suggestion travels, auto adopts, auto equals explicit, no-blob subtracts, refusals", () => withRoot(blobFiles, async (p) => {
  let [code, j] = await blobJson(p, []);
  assert.deepEqual([code, j.blobs, j.blob_source, j.suggested_blobs], [0, [], "none", [".boot", ".assets", ".filesys"]]);
  [code, j] = await blobJson(p, ["--blobs", "auto"]);
  assert.deepEqual([code, j.blobs, j.blob_source], [0, [".boot", ".assets", ".filesys"], "auto"]);
  const [, explicit] = await blobJson(p, ["--blob", ".boot", "--blob", ".assets", "--blob", ".filesys"]);
  for (const k of ["scan_total", "scan_high", "scan_medium", "scan_low"]) assert.equal(j[k], explicit[k], k);
  [code, j] = await blobJson(p, ["--blobs", "auto", "--no-blob", ".boot"]);
  assert.deepEqual([code, j.blobs, j.blobs_excluded], [0, [".assets", ".filesys"], [".boot"]]);
  [code] = await blobJson(p, ["--blob", ".assets", "--no-blob", ".assets"]);
  assert.equal(code, 2);
  const r = await runCommand(["shift", "audit", "--map", p("blobs.map"), "--image", p("blobs.z64"), "--blobs", "auto", "--no-blob", ".asset"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--no-blob names a section this map does not have: .asset"));
}));

const emitFiles = { ...synth, "undefined_syms.txt": "SP_STATUS_REG = 0xA4040010;\nosTvType = 0x80000300;\ngameLoop = 0x80000420;\n" };
const emitRun = (p, extra) => runCommand([...baseArgs(p), "--pins", p("undefined_syms.txt"), ...extra]);

test("emit whitelist: written beside the report, declares nothing until edited, edits change the next run, never overwrites", () => withRoot(emitFiles, async (p) => {
  const dest = p("whitelist.txt");
  let r = await emitRun(p, ["--emit-whitelist", dest]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("shift audit") && r.stderr.includes("wrote whitelist skeleton"));
  const text = readFileSync(dest, "utf8");
  assert.ok(text.includes("# REVIEW: SP_STATUS_REG") && text.includes("# REVIEW: osTvType") && text.includes("movable window floor: 0x80000400 (.main)"));
  r = await emitRun(p, ["--whitelist", dest, "--json"]);
  let j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.pins_authentic, j.pins_artifact], [0, 1, 2]);
  writeFileSync(dest, readFileSync(dest, "utf8").replace("# 0x80000300 ", "0x80000300 "));
  r = await emitRun(p, ["--whitelist", dest, "--json"]);
  j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.pins_authentic, j.pins_artifact], [0, 2, 1]);
  writeFileSync(dest, "0x80000300 reviewed, by a person\n");
  r = await emitRun(p, ["--emit-whitelist", dest]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("refuses to overwrite"));
  assert.equal(readFileSync(dest, "utf8"), "0x80000300 reviewed, by a person\n");
}));

// WB-143b: --elf, the class only the linked ELF can name

const wiringAudit = (elf = null) => {
  const model = defaultPinModel();
  return buildShiftAudit({ ldmap: parseLdMap(SYNTHETIC_MAP), image: SYNTHETIC_IMAGE, model, elf, elf_path: elf ? "game.elf" : null,
    pins: new PinCatalogue({ entries: parsePinText("D_80000440 = 0x80000440;\n", { path: "syms.txt", model }), sources: ["syms.txt"] }) });
};

test("elf wiring: no ELF leaves the class empty and the path null; a shadowing ELF reclassifies", () => {
  const off = wiringAudit();
  assert.equal(off.elf_path, null);
  assert.equal(off.pins.counts[SHADOWING_PIN], 0);
  assert.equal(off.asDict({ limit: 5 }).elf, null);
  const elf = parseElfSymbols(buildElf([[".main", 0x80000400, 0x80, 6]], [["D_80000440", 0x80000440, 4, 1, 1, SHN_ABS]]), { path: "game.elf" });
  const on = wiringAudit(elf);
  assert.equal(on.pins.counts[SHADOWING_PIN], 1);
  assert.equal(on.asDict({ limit: 5 }).pins_shadowing, 1);
  assert.equal(on.elf_path, "game.elf");
});

test("elf wiring: a bad ELF is refused by the command", () => withRoot({ "game.map": SYNTHETIC_MAP, "game.z64": SYNTHETIC_IMAGE,
  "not.elf": Buffer.concat([Buffer.from([0x80, 0x37, 0x12, 0x40]), Buffer.alloc(64)]) }, async (p) => {
  const r = await runCommand(["shift", "audit", "--map", p("game.map"), "--image", p("game.z64"), "--elf", p("not.elf")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("not an ELF file"));
}));

// WB-144: pin-inventory completeness

const MISSING_PIN_MAP = SYNTHETIC_MAP + `
                0x80000000                app_ROM_START = __romPos
                0x10  app_TEXT_SIZE = ABSOLUTE ((app_TEXT_END - app_TEXT_START))
                0x80000470                D_803571F0 = 0x80000470
                0x80000430                D_ALREADY_PINNED = 0x80000430
`;
const missingLdmap = () => parseLdMap(MISSING_PIN_MAP, { path: "missing.map" });
const missingElf = () => buildElf([[".main", 0x80000400, 0x80, 6]], [
  ["D_803571F0", 0x80000470, 0, 1, 1, SHN_ABS], ["app_ROM_START", 0x80000420, 0, 1, 1, SHN_ABS], ["app_TEXT_SIZE", 0x40, 0, 1, 1, SHN_ABS],
  ["_MACRO_INC_GUARD", 1, 0, 0, 0, SHN_ABS], ["_binary_bin_foo_bin_size", 0x20, 0, 0, 1, SHN_ABS], ["D_ALREADY_PINNED", 0x80000430, 0, 1, 1, SHN_ABS],
  ["HW_REG", 0xA4040010, 0, 1, 1, SHN_ABS], ["gData", 0x80000430, 0x10, 1, 1, 1]]);
function windowAndExtent() {
  const ldmap = missingLdmap();
  const regions = buildRegionTable(ldmap, { image_size: SYNTHETIC_IMAGE.length });
  return [ldmap, movableWindow(regions), checkMapImageConsistency(regions, SYNTHETIC_IMAGE).max_placed_extent];
}
const findMissing = (pinNames) => {
  const [ldmap, window, rom_extent] = windowAndExtent();
  return findMissingPinSources({ elf: parseElfSymbols(missingElf(), { path: "game.elf" }), ldmap, window, rom_extent, pin_names: new Set(pinNames) });
};

test("missing pin sources: only the true miss survives every exclusion", () => {
  let found = findMissing(["D_ALREADY_PINNED"]);
  assert.deepEqual(found.map((m) => m.name), ["D_803571F0"]);
  assert.deepEqual([found[0].value, found[0].size], [0x80000470, 0]);
  assert.deepEqual(findMissing(["D_ALREADY_PINNED", "D_803571F0"]), []);
  const names = new Set(found.map((m) => m.name));
  for (const n of ["app_ROM_START", "app_TEXT_SIZE", "_MACRO_INC_GUARD", "_binary_bin_foo_bin_size", "HW_REG"]) assert.ok(!names.has(n), n);
  assert.ok(!findMissing([]).some((m) => m.name === "gData"));
  const noElf = buildShiftAudit({ ldmap: missingLdmap(), image: SYNTHETIC_IMAGE, pins: emptyPins(), model: defaultPinModel() });
  assert.deepEqual([noElf.missing_pins, noElf.pins_missing_sources, noElf.elf_path], [[], 0, null]);
});

const missingAudit = (pins = null) => buildShiftAudit({ ldmap: missingLdmap(), image: SYNTHETIC_IMAGE, pins: pins ?? readPinText("D_ALREADY_PINNED = 0x80000430;\n"),
  model: defaultPinModel(), elf: parseElfSymbols(missingElf(), { path: "game.elf" }), elf_path: "game.elf", map_path: "missing.map", image_path: "synthetic.z64" });

test("missing pin report: headline, capped list, zero and off shapes, JSON, registered keys", () => {
  const f = missingAudit();
  assert.equal(f.pins_missing_sources, 1);
  assert.deepEqual(f.missing_pins.map((m) => m.name), ["D_803571F0"]);
  let text = shiftAuditLines(f, { limit: 10 }).join("\n");
  for (const s of ["pins_missing_sources=1", "missing pin sources (1 of 1, --limit)", "D_803571F0", "read your link's -T list", "splat's auto files count"]) assert.ok(text.includes(s), s);
  const zero = missingAudit(readPinText("D_ALREADY_PINNED = 0x80000430;\nD_803571F0 = 0x80000470;\n"));
  assert.equal(zero.pins_missing_sources, 0);
  text = shiftAuditLines(zero, { limit: 10 }).join("\n");
  assert.ok(text.includes("pins_missing_sources=0") && !text.includes("missing pin sources"));
  text = shiftAuditLines(buildShiftAudit({ ldmap: missingLdmap(), image: SYNTHETIC_IMAGE, pins: emptyPins(), model: defaultPinModel() }), { limit: 10 }).join("\n");
  assert.ok(text.includes("pins_missing_sources=off") && text.includes("pins_missing_sources is off") && text.includes("--elf"));
  let p = f.asDict({ limit: 10 });
  assert.deepEqual([p.pins_missing_sources, p.pins_missing_sources_shown, p.pins_missing_sources_list], [1, 1, [{ name: "D_803571F0", value: 0x80000470, size: 0 }]]);
  p = f.asDict({ limit: 0 });
  assert.deepEqual([p.pins_missing_sources, p.pins_missing_sources_shown, p.pins_missing_sources_list], [1, 0, []]);
  for (const k of ["pins_missing_sources", "pins_missing_sources_shown", "pins_missing_sources_list", "name", "value", "size"]) assert.ok(k in SHIFT_METRICS_BY_KEY, k);
});

test("missing pin sources end to end with census", () => withRoot({ "game.map": MISSING_PIN_MAP, "game.z64": SYNTHETIC_IMAGE, "game.elf": missingElf(),
  "pins.txt": "D_ALREADY_PINNED = 0x80000430;\n" }, async (p) => {
  const r = await runCommand(["shift", "audit", "--map", p("game.map"), "--image", p("game.z64"), "--elf", p("game.elf"), "--pins", p("pins.txt"), "--json", "--census", "pins_missing_sources=1"]);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.pins_missing_sources, 1);
  assert.deepEqual(j.pins_missing_sources_list.map((m) => m.name), ["D_803571F0"]);
}));
