// shift-audit.js - `shift audit`: a project's static shiftability
// inventory, before anything is relinked. From the linker map, the image
// and the project's pin files it derives the region table (which bytes are
// text, data, blob, header, bss or non-alloc, and where each sits in ROM),
// the movable VRAM window an insertion would move, and a ranked scan of every
// data word whose value lands inside that window: a hardcoded-pointer
// suspect list, with published suppressors (whitelisted, misaligned,
// progression clusters, repeated values, round constants) instead of a raw
// count. Pins are catalogued and classified; with the linked ELF, pins an
// object already defines (shadowing) and absolute symbols no pin file names
// (missing sources) are reported too.
//
// Text is placed and counted but never scanned: an instruction's address
// arithmetic is split across a lui/%lo pair and only a relink resolves it
// (`shift rehearse`).
//
// Plain JS ESM + JSDoc.

import { ValueError, sorted, minBy, maxBy } from "./py.js";
import { alignment } from "./mips-refs.js";
import { ARTIFACT_SUSPECT, AUTHENTIC_FIXED, DERIVED, ROM_OFFSET, SHADOWING_PIN, UNCLASSIFIED, PinCatalogue,
  reclassifyRomOffsets, reclassifyShadowingPins, whitelistTemplateText } from "./pins.js";
import { comma, hexw, table } from "./shift-util.js";

export const SHIFT_AUDIT_SCHEMA = "decomp-workbench-shift-audit-v1";
export const SCANNED_KINDS = Object.freeze(["data", "blob", "header"]);
export const NON_ALLOC_KIND = "non-alloc";
export const NON_ALLOC_ROM_SOURCE = "excluded-non-alloc";
export const NON_ALLOC_SECTION_FAMILIES = Object.freeze([
  [".mdebug", "prefix"], [".pdr", "exact"], [".comment", "exact"], [".gptab", "prefix"], [".reginfo", "exact"],
  [".options", "exact"], [".debug", "prefix"], [".line", "exact"], [".rel.", "prefix"],
]);

const familyMatch = (families, name) => families.some(([p, k]) => (k === "exact" ? name === p : name.startsWith(p)));
export const isNonAllocSection = (name) => familyMatch(NON_ALLOC_SECTION_FAMILIES, name);

export const CLUSTER_MINIMUM = 3;
export const REPEAT_MINIMUM = 4;
export const RESIDENCE_SCORES = Object.freeze({ data: 2, header: 1, blob: 0 });
export const SYMBOL_START_BONUS = 2;
export const TIER_THRESHOLDS = Object.freeze({ high: 3, medium: 2 });

/** One published reason a hit is ranked where it is. */
export class TierRule {
  constructor(name, tier, evidence) { Object.assign(this, { name, tier, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, tier: this.tier, evidence: this.evidence }; }
}

export const TIER_RULES = Object.freeze([
  new TierRule("whitelisted", "low", "the caller declared this address authentic, with a reason attached"),
  new TierRule("misaligned", "low", "the value is not a multiple of 4 and cannot be a MIPS data pointer "
    + "(S0: build-machine leftovers in the retail data image)"),
  new TierRule("progression-cluster", "low", `${CLUSTER_MINIMUM} or more hits at one constant stride whose values `
    + "form an arithmetic progression: packed fields, not pointers "
    + "(S0: gTrackSelectBgData)"),
  new TierRule("repeated-value", "low", `the same value at ${REPEAT_MINIMUM} or more hits anywhere, or at `
    + `${CLUSTER_MINIMUM} or more in one constant-stride run: one struct `
    + "constant counted many times, not that many references "
    + "(S0: 0x80020c00 across the TextElements arrays)"),
  new TierRule("round-constant", "low", "the low half of the value is 0x0000 or 0x8000 and no symbol starts "
    + "there: a fixed-point or packed constant (S0: gSineTable+0x7fc)"),
]);

export const SCORED = "scored";
export const MAP_SNIFF_BYTES = 4096;

/** Refuse a map that parsed to zero output sections. */
export function requireParsedMap(ldmap, { path, sample = Buffer.alloc(0) }) {
  if (ldmap.sections.length) return;
  const hint = sample.includes(0) ? " Is this a linker map? --map and --image may be swapped." : "";
  throw new ValueError(`${path} parsed as no linker map: 0 output sections were found.${hint}`);
}

function kindForInput(name) {
  if (name.startsWith(".text")) return "text";
  if (name.includes("bss")) return "bss";
  return "data";
}

/** One contiguous run of image bytes and how its words should be read. */
export class Region {
  constructor({ output_section, kind, vram, size, rom, rom_source }) { Object.assign(this, { output_section, kind, vram, size, rom, rom_source }); Object.freeze(this); }
  get words() { return Math.floor(this.size / 4); }
  get scanned() { return SCANNED_KINDS.includes(this.kind) && this.rom !== null; }
  asDict() {
    return { output_section: this.output_section, kind: this.kind, vram: this.vram, size: this.size, rom: this.rom,
      rom_source: this.rom_source, words: this.words, scanned: this.scanned };
  }
}

function placement(section, vma, kind, { image_size }) {
  if (kind === "bss") return [null, "not-resident"];
  let offset, source;
  if (section.load_address !== null) { offset = section.load_address + (vma - section.vma); source = "load-address"; }
  else { offset = vma; source = "vma-as-rom"; }
  if (!(offset >= 0 && offset < image_size)) return [null, "unplaced"];
  return [offset, source];
}

export const BLOB_ERROR_SECTION_LIMIT = 20;

/** One published shape that makes an input object a raw binary. */
export class BlobRule {
  constructor(name, pattern, match, evidence) { Object.assign(this, { name, pattern, match, evidence }); Object.freeze(this); }
  matches(objectPath) {
    if (this.match === "suffix") return objectPath.endsWith(this.pattern);
    return objectPath.replace(/\\/g, "/").split("/").slice(0, -1).includes(this.pattern);
  }
  asDict() { return { name: this.name, pattern: this.pattern, match: this.match, evidence: this.evidence }; }
}

export const BLOB_OBJECT_RULES = Object.freeze([
  new BlobRule("bin-object-suffix", ".bin.o", "suffix", "the object is named after a `.bin` file (splat's convention, "
    + "e.g. build/assets/boot.bin.o): objcopy'd raw bytes, never compiled code"),
  new BlobRule("bin-directory", "bin", "directory", "the object was built in a `bin/` directory "
    + "(e.g. build/bin/filesys.o): the same objcopy'd raw bytes under a build "
    + "that drops the `.bin` from the object name"),
]);

const blobRuleFor = (p) => BLOB_OBJECT_RULES.find((r) => r.matches(p)) ?? null;

/** One output section the map's own inputs say is opaque, and why. */
export class BlobSuggestion {
  constructor({ output_section, rule, objects, input_records, vram, size }) { Object.assign(this, { output_section, rule, objects, input_records, vram, size }); Object.freeze(this); }
  asDict() { return { output_section: this.output_section, rule: this.rule, objects: [...this.objects], input_records: this.input_records, vram: this.vram, size: this.size }; }
}

function groupByOutput(ldmap) {
  const by = new Map();
  for (const r of ldmap.input_sections) { if (!by.has(r.output_section)) by.set(r.output_section, []); by.get(r.output_section).push(r); }
  return by;
}

/** Derive the blob set from the map's input records, in map order. */
export function suggestBlobs(ldmap) {
  const by = groupByOutput(ldmap);
  const found = [];
  const order = new Map(BLOB_OBJECT_RULES.map((r, i) => [r.name, i]));
  for (const section of ldmap.sectionsSorted()) {
    const records = by.get(section.name) ?? [];
    if (!records.length) continue;
    const rules = records.map((r) => blobRuleFor(r.object_path));
    if (rules.some((r) => r === null)) continue;
    const named = sorted([...new Set(rules.map((r) => r.name))], (n) => order.get(n));
    found.push(new BlobSuggestion({ output_section: section.name, rule: named[0], objects: sorted([...new Set(records.map((r) => r.object_path))]),
      input_records: records.length, vram: section.vma, size: section.size }));
  }
  return found;
}

export const BLOB_SOURCE_EXPLICIT = "explicit";
export const BLOB_SOURCE_AUTO = "auto";
export const BLOB_SOURCE_NONE = "none";

/** Which sections a run treats as opaque, and where that came from. */
export class BlobPlan {
  constructor({ applied, source, suggestions, excluded }) { Object.assign(this, { applied, source, suggestions, excluded }); Object.freeze(this); }
  get suggested() { return this.suggestions.map((s) => s.output_section); }
  get unadopted() { const a = new Set(this.applied); return this.suggested.filter((n) => !a.has(n)); }
  asDict() {
    return { blobs: [...this.applied], blob_source: this.source, blobs_excluded: [...this.excluded], suggested_blobs: this.suggested,
      blob_suggestions: this.suggestions.map((s) => s.asDict()), blob_rules: BLOB_OBJECT_RULES.map((r) => r.asDict()) };
  }
}

function sectionNameList(names) {
  const shown = names.slice(0, BLOB_ERROR_SECTION_LIMIT);
  const remainder = names.length - shown.length;
  const joined = shown.length ? shown.join(", ") : "no sections at all";
  return remainder > 0 ? `${joined}, ... (+${remainder} more)` : joined;
}

/** Turn the caller's blob arguments and the map's suggestion into one set. */
export function resolveBlobs(ldmap, { blobs = [], auto = false, excluded = [] } = {}) {
  const suggestions = suggestBlobs(ldmap);
  const named = [...new Set(blobs)], removed = [...new Set(excluded)];
  const removedSet = new Set(removed);
  const both = named.filter((n) => removedSet.has(n));
  if (both.length) throw new ValueError(`--blob and --no-blob name the same section: ${sorted(both).join(", ")}`);
  const known = ldmap.sectionsSorted().map((s) => s.name);
  const unknown = sorted([...removedSet].filter((n) => !known.includes(n)));
  if (unknown.length) throw new ValueError(`--no-blob names a section this map does not have: ${unknown.join(", ")} (map sections: ${sectionNameList(known)})`);
  let applied = [...named];
  if (auto) for (const s of suggestions) if (!applied.includes(s.output_section)) applied.push(s.output_section);
  applied = applied.filter((n) => !removedSet.has(n));
  const source = !applied.length ? BLOB_SOURCE_NONE : auto ? BLOB_SOURCE_AUTO : BLOB_SOURCE_EXPLICIT;
  return new BlobPlan({ applied, source, suggestions, excluded: removed });
}

/** Derive the region table from the map, with the caller's overrides. */
export function buildRegionTable(ldmap, { image_size, blobs = [], header_sections = [".header"] }) {
  const blobNames = new Set(blobs);
  const known = ldmap.sectionsSorted().map((s) => s.name);
  const unknownBlobs = sorted([...blobNames].filter((n) => !known.includes(n)));
  if (unknownBlobs.length) throw new ValueError(`--blob names a section this map does not have: ${unknownBlobs.join(", ")} (map sections: ${sectionNameList(known)})`);
  const headerNames = new Set(header_sections);
  const by = groupByOutput(ldmap);
  const regions = [];
  for (const section of ldmap.sectionsSorted()) {
    if (section.load_address === null && isNonAllocSection(section.name)) {
      regions.push(new Region({ output_section: section.name, kind: NON_ALLOC_KIND, vram: section.vma, size: section.size, rom: null, rom_source: NON_ALLOC_ROM_SOURCE }));
      continue;
    }
    const records = sorted((by.get(section.name) ?? []).filter((r) => r.size), (r) => r.vma);
    if (blobNames.has(section.name) || headerNames.has(section.name)) {
      const kind = blobNames.has(section.name) ? "blob" : "header";
      const [rom, source] = placement(section, section.vma, kind, { image_size });
      regions.push(new Region({ output_section: section.name, kind, vram: section.vma, size: section.size, rom, rom_source: source }));
      continue;
    }
    if (!records.length) {
      const [rom, source] = placement(section, section.vma, "data", { image_size });
      regions.push(new Region({ output_section: section.name, kind: "data", vram: section.vma, size: section.size, rom, rom_source: source }));
      continue;
    }
    const runs = [];
    for (const r of records) {
      const kind = kindForInput(r.name);
      const last = runs[runs.length - 1];
      if (last && last[0] === kind && r.vma >= last[2]) { last[2] = r.end; continue; }
      runs.push([kind, r.vma, r.end]);
    }
    runs[runs.length - 1][2] = Math.max(runs[runs.length - 1][2], section.end);
    for (const [kind, start, end] of runs) {
      const [rom, source] = placement(section, start, kind, { image_size });
      regions.push(new Region({ output_section: section.name, kind, vram: start, size: end - start, rom, rom_source: source }));
    }
  }
  return regions;
}

/** The VRAM extent an insertion would move, and where it came from. */
export class MovableWindow {
  constructor({ lo, hi, lo_section, hi_section }) { Object.assign(this, { lo, hi, lo_section, hi_section }); Object.freeze(this); }
  contains(value) { return this.lo <= value && value < this.hi; }
  asDict() { return { window_lo: this.lo, window_hi: this.hi, window_lo_section: this.lo_section, window_hi_section: this.hi_section }; }
}

export const MOVABLE_FLOOR_MIN = 0x80000000;

/** [first RAM-resident movable start, last bss end) from the region table. */
export function movableWindow(regions) {
  const movable = regions.filter((r) => ["text", "data", "bss"].includes(r.kind));
  if (!movable.length) return new MovableWindow({ lo: 0, hi: 0, lo_section: null, hi_section: null });
  const resident = movable.filter((r) => r.vram >= MOVABLE_FLOOR_MIN);
  const low = minBy(resident.length ? resident : movable, (r) => r.vram);
  const bss = movable.filter((r) => r.kind === "bss");
  const high = maxBy(bss.length ? bss : movable, (r) => r.vram + r.size);
  return new MovableWindow({ lo: low.vram, hi: high.vram + high.size, lo_section: low.output_section, hi_section: high.output_section });
}

export const PADDING_PATTERN_MAX_PERIOD = 16;

function isUniformPadding(data) {
  if (!data.length) return true;
  const first = data[0];
  let uniform = true;
  for (let i = 1; i < data.length; i++) if (data[i] !== first) { uniform = false; break; }
  if (uniform) return true;
  for (let period = 2; period <= Math.min(PADDING_PATTERN_MAX_PERIOD, Math.floor(data.length / 2)); period++) {
    if (data.length % period) continue;
    let ok = true;
    for (let i = period; i < data.length && ok; i++) if (data[i] !== data[i % period]) ok = false;
    if (ok) return true;
  }
  return false;
}

/** Is this image really the one the map describes? */
export class ConsistencyCheck {
  constructor({ max_placed_extent, padding_bytes, regions_unplaced_past_eof }) { Object.assign(this, { max_placed_extent, padding_bytes, regions_unplaced_past_eof }); Object.freeze(this); }
  asDict() { return { max_placed_extent: this.max_placed_extent, padding_bytes: this.padding_bytes, regions_unplaced_past_eof: this.regions_unplaced_past_eof }; }
}

/** Refuse an image that does not match the map. */
export function checkMapImageConsistency(regions, image, { map_path = null, image_path = null } = {}) {
  const placed = regions.filter((r) => r.rom !== null).map((r) => r.rom + r.size);
  const maxExtent = placed.length ? Math.max(...placed) : 0;
  const imageBytes = image.length;
  const placeable = regions.filter((r) => r.kind !== "bss" && r.kind !== NON_ALLOC_KIND);
  const pastEof = placeable.filter((r) => r.rom === null || r.rom + r.size > imageBytes).length;
  if (imageBytes > maxExtent) {
    const excess = image.subarray(maxExtent);
    if (!isUniformPadding(excess)) {
      const details = [`image_bytes=${comma(imageBytes)}`, `map_placed_extent=${comma(maxExtent)}`];
      if (map_path) details.push(`map=${map_path}`);
      if (image_path) details.push(`image=${image_path}`);
      throw new ValueError(`image extends ${comma(excess.length)} bytes past the map's placed extent and the excess is not uniform padding `
        + `-- the map and image are likely from different builds (${details.join(", ")})`);
    }
    return new ConsistencyCheck({ max_placed_extent: maxExtent, padding_bytes: excess.length, regions_unplaced_past_eof: pastEof });
  }
  if (imageBytes < maxExtent) {
    if (placeable.length && pastEof * 2 > placeable.length) {
      const details = [`regions_unplaced_past_eof=${pastEof}`, `placed_regions=${placeable.length}`, `image_bytes=${comma(imageBytes)}`, `map_placed_extent=${comma(maxExtent)}`];
      if (map_path) details.push(`map=${map_path}`);
      if (image_path) details.push(`image=${image_path}`);
      throw new ValueError(`${pastEof} of ${placeable.length} placed regions land past the end of the image -- that is not an overlay quirk, that is the wrong image (${details.join(", ")})`);
    }
    return new ConsistencyCheck({ max_placed_extent: maxExtent, padding_bytes: null, regions_unplaced_past_eof: pastEof });
  }
  return new ConsistencyCheck({ max_placed_extent: maxExtent, padding_bytes: 0, regions_unplaced_past_eof: pastEof });
}

/** One word holding a value inside the movable window, with its features. */
export class Hit {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    const k = ["rom", "vram", "value", "region", "residence", "resident_symbol", "resident_offset", "target_symbol", "target_offset", "alignment",
      "points_at_symbol_start", "repeats", "cluster", "window", "whitelisted", "reason", "score", "rule", "tier"];
    return Object.fromEntries(k.map((x) => [x, this[x]]));
  }
}

const TIER_ORDER = { high: 0, medium: 1, low: 2 };

function clusters(rows) {
  const found = new Map();
  let index = 0, identifier = 0;
  const count = rows.length;
  while (index + CLUSTER_MINIMUM - 1 < count) {
    const os = rows[index + 1][0] - rows[index][0];
    const vs = rows[index + 1][1] - rows[index][1];
    let last = index + 1;
    while (last + 1 < count && rows[last + 1][0] - rows[last][0] === os && rows[last + 1][1] - rows[last][1] === vs) last += 1;
    if (last - index + 1 >= CLUSTER_MINIMUM) {
      for (let p = index; p <= last; p++) found.set(rows[p][0], [identifier, vs]);
      identifier += 1;
      index = last;
      continue;
    }
    index += 1;
  }
  return found;
}

/** Read every scannable region's words and rank the in-window ones. */
export function scanRegions(image, regions, { window, ldmap, model }) {
  let raw = [];
  for (const region of regions) {
    if (!region.scanned) continue;
    for (let i = 0; i < region.words; i++) {
      const offset = region.rom + i * 4;
      if (offset + 4 > image.length) break;
      const value = image.readUInt32BE(offset);
      if (window.contains(value)) raw.push([offset, value, region]);
    }
  }
  raw = sorted(raw, (r) => r[0]);
  const fam = clusters(raw.map(([o, v]) => [o, v]));
  const repeats = new Map();
  for (const [, v] of raw) repeats.set(v, (repeats.get(v) ?? 0) + 1);
  const hits = [];
  for (const [offset, value, region] of raw) {
    const vram = region.vram + (offset - (region.rom || 0));
    const target = ldmap.symbolContaining(value);
    const starts = target !== null && target[1] === 0;
    let residentSymbol = null, residentOffset = null;
    if (region.kind === "data" || region.kind === "text") {
      const resident = ldmap.symbolContaining(vram);
      if (resident) [residentSymbol, residentOffset] = [resident[0].name, resident[1]];
    }
    const [name, whitelisted, reason] = model.classifyValue(value);
    const family = fam.get(offset) ?? null;
    const cluster = family !== null && family[1] ? family[0] : null;
    const repeated = repeats.get(value);
    let score = 0, rule;
    if (whitelisted) rule = "whitelisted";
    else if (alignment(value)) rule = "misaligned";
    else if (cluster !== null) rule = "progression-cluster";
    else if (repeated >= REPEAT_MINIMUM || family !== null) rule = "repeated-value";
    else if (((value & 0xFFFF) === 0 || (value & 0xFFFF) === 0x8000) && !starts) rule = "round-constant";
    else { rule = SCORED; score = (RESIDENCE_SCORES[region.kind] ?? 0) + (starts ? SYMBOL_START_BONUS : 0); }
    const tier = rule !== SCORED ? "low" : score >= TIER_THRESHOLDS.high ? "high" : score >= TIER_THRESHOLDS.medium ? "medium" : "low";
    hits.push(new Hit({ rom: offset, vram, value, region: region.output_section, residence: region.kind, resident_symbol: residentSymbol,
      resident_offset: residentOffset, target_symbol: target ? target[0].name : null, target_offset: target ? target[1] : null,
      alignment: alignment(value), points_at_symbol_start: starts, repeats: repeated, cluster: rule === "progression-cluster" ? cluster : null,
      window: name, whitelisted: !!whitelisted, reason, score, rule, tier }));
  }
  return hits;
}

export const ELF_BUILTIN_ABSOLUTES = Object.freeze([["_MACRO_INC_GUARD", "exact"], ["_binary_", "prefix"]]);
export const LD_SCRIPT_BOUNDARY_SUFFIXES = Object.freeze(["_ROM_START", "_ROM_END", "_TEXT_SIZE", "_DATA_SIZE", "_RODATA_SIZE", "_BSS_SIZE"]);

/** One ELF absolute symbol the supplied pin inventory does not name. */
export class MissingPin {
  constructor({ name, value, size }) { Object.assign(this, { name, value, size }); Object.freeze(this); }
  asDict() { return { name: this.name, value: this.value, size: this.size }; }
}

/** Which ELF absolute symbols does pin_names not account for? */
export function findMissingPinSources({ elf, ldmap, window, rom_extent, pin_names }) {
  const found = [];
  for (const name of sorted([...elf.names()])) {
    const symbol = elf.symbol(name);
    if (!symbol.is_absolute || pin_names.has(name)) continue;
    if (!(window.contains(symbol.value) || (symbol.value >= 0 && symbol.value < rom_extent))) continue;
    if (familyMatch(ELF_BUILTIN_ABSOLUTES, name)) continue;
    const ms = ldmap.symbol(name);
    if (ms && ms.is_assignment && LD_SCRIPT_BOUNDARY_SUFFIXES.some((s) => name.endsWith(s))) continue;
    found.push(new MissingPin({ name, value: symbol.value, size: symbol.size }));
  }
  return found;
}

const tally = (items) => { const m = new Map(); for (const k of items) m.set(k, (m.get(k) ?? 0) + 1); return Object.fromEntries(sorted([...m.entries()], (e) => e[0])); };

/** One project's static shiftability inventory. */
export class ShiftAudit {
  constructor({ map_path, image_path, image_bytes, regions, window, pins, hits, consistency,
    blobs = new BlobPlan({ applied: [], source: BLOB_SOURCE_NONE, suggestions: [], excluded: [] }), elf_path = null, missing_pins = [] }) {
    Object.assign(this, { map_path, image_path, image_bytes, regions, window, pins, hits, consistency, blobs, elf_path, missing_pins });
    Object.freeze(this);
  }
  whitelistTemplate() { return whitelistTemplateText(this.pins, { window_lo: this.window.lo, window_lo_section: this.window.lo_section }); }
  get scan_total() { return this.hits.length; }
  get scan_high() { return this.hits.filter((h) => h.tier === "high").length; }
  get scan_medium() { return this.hits.filter((h) => h.tier === "medium").length; }
  get scan_low() { return this.hits.filter((h) => h.tier === "low").length; }
  get scanned_words() { return this.regions.filter((r) => r.scanned).reduce((s, r) => s + r.words, 0); }
  get text_words() { return this.regions.filter((r) => r.kind === "text").reduce((s, r) => s + r.words, 0); }
  get text_regions() { return this.regions.filter((r) => r.kind === "text").length; }
  get scan_rules() { return tally(this.hits.map((h) => h.rule)); }
  get scan_by_region() { return tally(this.hits.map((h) => h.region)); }
  get pins_missing_sources() { return this.missing_pins.length; }
  ranked() { return sorted(this.hits, (h) => [TIER_ORDER[h.tier] ?? 3, -h.score, h.rom]); }
  asDict({ limit }) {
    const shown = this.ranked().slice(0, Math.max(0, limit));
    const payload = {
      schema: SHIFT_AUDIT_SCHEMA, map: this.map_path, image: this.image_path, elf: this.elf_path, image_bytes: this.image_bytes,
      region_count: this.regions.length, regions: this.regions.map((r) => r.asDict()), scanned_words: this.scanned_words,
      text_words: this.text_words, text_regions: this.text_regions, scan_total: this.scan_total, scan_high: this.scan_high,
      scan_medium: this.scan_medium, scan_low: this.scan_low, scan_rules: this.scan_rules, scan_by_region: this.scan_by_region,
      hits_shown: shown.length, hits: shown.map((h) => h.asDict()), rules: TIER_RULES.map((r) => r.asDict()),
      residence_scores: { ...RESIDENCE_SCORES }, tier_thresholds: { ...TIER_THRESHOLDS }, symbol_start_bonus: SYMBOL_START_BONUS,
    };
    Object.assign(payload, this.window.asDict(), this.consistency.asDict(), this.blobs.asDict(), this.pins.asDict({ limit }));
    const shownMissing = this.missing_pins.slice(0, Math.max(0, limit));
    payload.pins_missing_sources = this.pins_missing_sources;
    payload.pins_missing_sources_shown = shownMissing.length;
    payload.pins_missing_sources_list = shownMissing.map((m) => m.asDict());
    return payload;
  }
}

/** Read one project's map, image, and pins into a single inventory. */
export function buildShiftAudit({ ldmap, image, pins, model, blobs = [], auto_blobs = false, excluded_blobs = [], header_sections = [".header"],
  elf = null, map_path = null, image_path = null, elf_path = null }) {
  const plan = resolveBlobs(ldmap, { blobs, auto: auto_blobs, excluded: excluded_blobs });
  const regions = buildRegionTable(ldmap, { image_size: image.length, blobs: plan.applied, header_sections });
  const consistency = checkMapImageConsistency(regions, image, { map_path, image_path });
  const window = movableWindow(regions);
  const hits = scanRegions(image, regions, { window, ldmap, model });
  let classified = reclassifyRomOffsets(pins, { model, rom_extent: consistency.max_placed_extent });
  let missing = [];
  if (elf !== null) {
    classified = reclassifyShadowingPins(classified, { elf });
    missing = findMissingPinSources({ elf, ldmap, window, rom_extent: consistency.max_placed_extent, pin_names: new Set(classified.entries.map((e) => e.name)) });
  }
  return new ShiftAudit({ map_path, image_path, image_bytes: image.length, regions, window, pins: classified, hits, consistency, blobs: plan,
    elf_path: elf_path !== null ? elf_path : elf ? elf.path : null, missing_pins: missing });
}

const named = (symbol, offset) => (symbol === null ? "-" : !offset ? symbol : `${symbol}+0x${hexw(offset)}`);

/** Render the human report: the same numbers asDict carries. */
export function shiftAuditLines(found, { limit }) {
  const w = found.window, c = found.consistency;
  const padding = c.padding_bytes === null ? "-" : comma(c.padding_bytes);
  const lines = [
    `shift audit  map=${found.map_path || "-"}  image=${found.image_path || "-"}  elf=${found.elf_path || "-"}`,
    "",
    `image_bytes=${comma(found.image_bytes)}  region_count=${found.regions.length}  scanned_words=${comma(found.scanned_words)}  `
      + `text_words=${comma(found.text_words)}  text_regions=${found.text_regions}`,
    `window_lo=0x${hexw(w.lo, 8)}  window_hi=0x${hexw(w.hi, 8)}  window_lo_section=${w.lo_section === null ? "None" : w.lo_section}  `
      + `window_hi_section=${w.hi_section === null ? "None" : w.hi_section}`,
    `max_placed_extent=0x${hexw(c.max_placed_extent, 8)}  padding_bytes=${padding}  regions_unplaced_past_eof=${comma(c.regions_unplaced_past_eof)}`,
    "",
    "regions",
  ];
  lines.push(...table(["output_section", "kind", "vram", "size", "rom", "rom_source", "words", "scanned"],
    found.regions.map((r) => [r.output_section, r.kind, `0x${hexw(r.vram, 8)}`, `0x${hexw(r.size)}`, r.rom === null ? "-" : `0x${hexw(r.rom, 6)}`,
      r.rom_source, comma(r.words), r.scanned ? "yes" : "no"])));
  const plan = found.blobs;
  lines.push("", `blobs=${plan.applied.length ? plan.applied.join(", ") : "-"}  blob_source=${plan.source}`
    + (plan.excluded.length ? `  blobs_excluded=${plan.excluded.join(", ")}` : ""));
  if (plan.unadopted.length) lines.push(`suggested_blobs (from .bin.o inputs): ${plan.unadopted.join(", ")}  -- adopt with \`--blobs auto\``);
  const counts = found.pins.counts;
  lines.push("", `pins_total=${comma(found.pins.entries.length)}  pins_derived=${comma(counts[DERIVED])}  pins_authentic=${comma(counts[AUTHENTIC_FIXED])}  `
    + `pins_artifact=${comma(counts[ARTIFACT_SUSPECT])}  pins_rom_offset=${comma(counts[ROM_OFFSET])}  pins_shadowing=`
    + (found.elf_path === null ? "off" : comma(counts[SHADOWING_PIN]))
    + `  pins_unclassified=${comma(counts[UNCLASSIFIED])}  pins_missing_sources=`
    + (found.elf_path === null ? "off" : comma(found.pins_missing_sources)));
  for (const s of found.pins.sources) lines.push(`  pin_sources: ${s}`);
  if (found.elf_path === null) {
    lines.push("  pins_shadowing is off: pass --elf <linked ELF> to find pins an "
      + "object already defines. GNU ld lets a script assignment override "
      + "an object's definition silently, and the surviving absolute "
      + "symbol keeps the losing definition's size -- which is what makes "
      + "the check exact, and free.");
    lines.push("  pins_missing_sources is off: pass --elf <linked ELF> to check "
      + "whether --pins/--symbol-addrs named every absolute symbol the "
      + "link actually carries. An incomplete inventory exits "
      + "clean and reports every other number with the pins stated "
      + "it *was* given -- this is the only check that catches a pin "
      + "file nobody handed it.");
  }
  for (const [cls, heading] of [[SHADOWING_PIN, "shadowing pins"], [ARTIFACT_SUSPECT, "artifact-suspect pins"], [ROM_OFFSET, "rom-offset pins"]]) {
    const selected = found.pins.byClassification(cls);
    if (!selected.length) continue;
    const shownPins = selected.slice(0, Math.max(0, limit));
    lines.push("", `${heading} (${shownPins.length} of ${selected.length}, --limit)`);
    lines.push(...table(["name", "value", "window", "source", "line"], shownPins.map((p) => [p.name, p.value === null ? "-" : `0x${hexw(p.value, 8)}`,
      p.window || "-", p.source || "-", String(p.line)])));
  }
  if (found.pins.byClassification(ROM_OFFSET).length) {
    lines.push("  rom-offset pins address the cartridge image, not memory. Symbolize them against the linker's own "
      + "<segment>_ROM_START/_ROM_END symbols and they follow the layout.");
  }
  if (found.pins.byClassification(SHADOWING_PIN).length) {
    lines.push("  shadowing pins are already defined by an object in this link: "
      + "the script's assignment overrode that definition silently. "
      + "Deleting the pin is byte-identical at this layout and the "
      + "object's own definition then follows the layout for free.");
  }
  if (found.missing_pins.length) {
    const shownMissing = found.missing_pins.slice(0, Math.max(0, limit));
    lines.push("", `missing pin sources (${shownMissing.length} of ${found.missing_pins.length}, --limit)`);
    lines.push(...table(["name", "value", "size"], shownMissing.map((m) => [m.name, `0x${hexw(m.value, 8)}`, comma(m.size)])));
    lines.push("  pins the link knows but your inventory does not -- read your link's -T list; splat's auto files count.");
  }
  lines.push("", `scan_total=${comma(found.scan_total)}  scan_high=${comma(found.scan_high)}  scan_medium=${comma(found.scan_medium)}  scan_low=${comma(found.scan_low)}`,
    "", "scan_rules");
  lines.push(...table(["rule", "count"], Object.entries(found.scan_rules).map(([n, k]) => [n, comma(k)])));
  lines.push("", "scan_by_region");
  lines.push(...table(["region", "count"], Object.entries(found.scan_by_region).map(([n, k]) => [n, comma(k)])));
  const shown = found.ranked().slice(0, Math.max(0, limit));
  lines.push("", `hits (${shown.length} of ${comma(found.scan_total)}, --limit)`);
  lines.push(...table(["rom", "value", "tier", "rule", "region", "resident_symbol", "target_symbol"], shown.map((h) => [`0x${hexw(h.rom, 6)}`,
    `0x${hexw(h.value, 8)}`, h.tier, h.rule, h.region, named(h.resident_symbol, h.resident_offset), named(h.target_symbol, h.target_offset)])));
  lines.push("", `text: ${comma(found.text_words)} words in ${found.text_regions} text `
    + "region(s) were not scanned. An instruction's address arithmetic "
    + "is split across a lui/%lo pair and only a relink resolves it: "
    + "`shift rehearse` is the empirical referee for "
    + "those, and for which of the words above actually move.",
  "", "tiers rank how confidently a word is an address reference, not "
    + "how dangerous it is. A linked ROM keeps no relocations, so a "
    + "resolved pointer and a typed-in constant are the same four "
    + "bytes; only a shifted relink tells them apart.");
  return lines;
}

export { PinCatalogue };
