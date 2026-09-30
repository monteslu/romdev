// shift-rehearse.js - `shift rehearse`: the empirical referee. Relink the
// same objects with a pad inserted and explain every word that changed:
// where the pad went in (the anchor), which shared symbols moved by a value
// other than 0 or the delta, a decode-first census of every differing word,
// the static audit's hits judged against the relink (stale-confirmed is the
// headline), checksum-consistency for named FUNCTION=VARIABLE pairs, and,
// with both ELFs, the symbol-side census that sees references only code
// consumes. `orchestrate` generates the padded scripts, runs the project's
// relink wrapper for the base and every delta, analyzes each, and reports
// the counts the deltas did not agree on.
//
// Plain JS ESM + JSDoc.

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { runProgramSync } from "./proc.js";
import { ValueError, sorted, splitlines, strip, lstrip, pyInt, strRepr, osErrorText, minBy } from "./py.js";
import { auditSymbolMovement } from "./ldmap.js";
import { GeneratedSpec, RegionSpec, buildWordCensus, checkImageDelta } from "./mips-refs.js";
import { defaultPinModel } from "./pins.js";
import { buildRegionTable, movableWindow, scanRegions } from "./shift-audit.js";
import { comma, signedHex, hexw } from "./shift-util.js";

export const SHIFT_REHEARSE_SCHEMA = "decomp-workbench-shift-rehearse-v1";
export const MERGE_TIERS = Object.freeze({ high: "stale-confirmed", medium: "stale-review", low: "noise" });
export const TRACKS = "tracks";
export const CHANGED_OTHER = "changed-other";

export class ChecksumRule {
  constructor(name, evidence) { Object.assign(this, { name, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, evidence: this.evidence }; }
}

export const CHECKSUM_RULES = Object.freeze([
  new ChecksumRule("pass", "the body and the checksum word agree: either the shift touched "
    + "neither (basis inert) or it changed both (basis tracked)"),
  new ChecksumRule("checksum-stale", "the function's body changed and its checksum word did not -- the "
    + "2021 cursed-audio class, where a protected function was left off "
    + "the post-link patcher's allowlist and the game's own runtime "
    + "self-check failed"),
  new ChecksumRule("checksum-orphan", "the checksum word changed while the function's body did not: the "
    + "patcher wrote a value the body does not explain, so either the "
    + "extent read from the map is wrong or the word is not what it is "
    + "named"),
  new ChecksumRule("unresolved", "a named symbol is missing from the map, has no ROM placement, or "
    + "has no extent the map can bound -- reported rather than skipped"),
]);

/** The insertion point, and the evidence it was derived from. */
export class Anchor {
  constructor({ vram, rom, source, symbol, highest_unmoved, lowest_moved }) { Object.assign(this, { vram, rom, source, symbol, highest_unmoved, lowest_moved }); Object.freeze(this); }
  asDict() {
    return { anchor_vram: this.vram, anchor_rom: this.rom, anchor_source: this.source, anchor_symbol: this.symbol,
      anchor_highest_unmoved: this.highest_unmoved, anchor_lowest_moved: this.lowest_moved };
  }
}

/** Locate the insertion point, from a named symbol or from the two maps. */
export function deriveAnchor(base, shifted, { delta, window_lo, window_hi, symbol = null }) {
  const sn = shifted.symbolNames();
  const shared = [...base.symbolNames()].filter((n) => sn.has(n));
  const moved = [], unmoved = [];
  for (const name of shared) {
    const placed = base.symbol(name), relinked = shifted.symbol(name);
    if (!(window_lo <= placed.address && placed.address < window_hi)) continue;
    const movement = relinked.address - placed.address;
    if (movement === delta && !placed.is_assignment) moved.push(placed.address);
    else if (movement === 0) unmoved.push(placed.address);
  }
  const highestUnmoved = unmoved.length ? Math.max(...unmoved) : null;
  const lowestMoved = moved.length ? Math.min(...moved) : null;
  let vram, source, named;
  if (symbol !== null) {
    const placed = base.symbol(symbol);
    if (!placed) throw new ValueError(`--anchor ${strRepr(symbol)} is not a symbol the base map places`);
    [vram, source, named] = [placed.address, "symbol", symbol];
  } else {
    if (lowestMoved === null) {
      throw new ValueError(`no object-backed symbol inside the movable window [0x${hexw(window_lo, 8)}, 0x${hexw(window_hi, 8)}) moved by the declared `
        + `delta 0x${hexw(delta)}: either the delta is wrong, the two maps do not describe the same relink, or this map places nothing `
        + "but linker-script assignments in its own window (pass --anchor <symbol> to name the insertion point yourself)");
    }
    [vram, source] = [lowestMoved, "auto"];
    named = sorted(shared.filter((n) => {
      const p = base.symbol(n), r = shifted.symbol(n);
      return p && !p.is_assignment && p.address === lowestMoved && r && r.address - p.address === delta;
    }))[0];
  }
  const rom = base.romForVram(vram);
  if (rom === null) throw new ValueError(`the anchor VRAM 0x${hexw(vram, 8)} has no ROM placement in the base map: only a section that declared AT() can be translated`);
  return new Anchor({ vram, rom, source, symbol: named, highest_unmoved: highestUnmoved, lowest_moved: lowestMoved });
}

function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x < arr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}

/** One symbol's [start, end) VRAM extent, or null. */
export function symbolExtent(ldmap, name) {
  const symbol = ldmap.symbol(name);
  if (!symbol) return null;
  const addresses = ldmap.symbolsSorted().map((s) => s.address);
  const index = bisectRight(addresses, symbol.address);
  let end = index < addresses.length ? addresses[index] : null;
  const record = ldmap.inputSectionContaining(symbol.address);
  if (record && record.size) end = end === null ? record.end : Math.min(end, record.end);
  if (end === null || end <= symbol.address) return null;
  return [symbol.address, end];
}

/** One FUNCTION=VARIABLE pair, checked against the shift. */
export class ChecksumVerdict {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    const k = ["function", "variable", "function_vram", "function_rom", "function_size", "body_words", "body_changed", "variable_rom",
      "variable_base", "variable_shifted", "variable_changed", "status", "basis", "note"];
    return Object.fromEntries(k.map((x) => [x, this[x]]));
  }
}

function paired(base, shifted, offset, { insertion, delta }) {
  const other = offset >= insertion ? offset + delta : offset;
  if (offset + 4 > base.length || other + 4 > shifted.length || offset < 0 || other < 0) return null;
  return [base.readUInt32BE(offset), shifted.readUInt32BE(other)];
}

/** Apply the checksum-consistency rule to every named pair. */
export function checksumVerdicts(pairs, { base_ldmap, base_image, shifted_image, insertion, delta }) {
  const found = [];
  for (const [fn, variable] of pairs) {
    const extent = symbolExtent(base_ldmap, fn);
    const vs = base_ldmap.symbol(variable);
    const variableRom = vs ? base_ldmap.romForVram(vs.address) : null;
    const base = { function: fn, variable };
    if (extent === null || variableRom === null) {
      const missing = [];
      if (extent === null) missing.push(`${fn} has no bounded extent in the base map`);
      if (!vs) missing.push(`${variable} is not a symbol the base map places`);
      else if (variableRom === null) missing.push(`${variable} has no ROM placement in the base map`);
      found.push(new ChecksumVerdict({ ...base, function_vram: extent ? extent[0] : null, function_rom: null, function_size: extent ? extent[1] - extent[0] : null,
        body_words: 0, body_changed: 0, variable_rom: variableRom, variable_base: null, variable_shifted: null, variable_changed: false,
        status: "unresolved", basis: "-", note: missing.join("; ") }));
      continue;
    }
    const [start, end] = extent;
    const functionRom = base_ldmap.romForVram(start);
    if (functionRom === null) {
      found.push(new ChecksumVerdict({ ...base, function_vram: start, function_rom: null, function_size: end - start, body_words: 0, body_changed: 0,
        variable_rom: variableRom, variable_base: null, variable_shifted: null, variable_changed: false, status: "unresolved", basis: "-",
        note: `${fn} has no ROM placement in the base map` }));
      continue;
    }
    let bodyWords = 0, bodyChanged = 0;
    for (let offset = functionRom; offset < functionRom + (end - start); offset += 4) {
      const w = paired(base_image, shifted_image, offset, { insertion, delta });
      if (w === null) break;
      bodyWords += 1;
      if (w[0] !== w[1]) bodyChanged += 1;
    }
    const vw = paired(base_image, shifted_image, variableRom, { insertion, delta });
    if (vw === null) {
      found.push(new ChecksumVerdict({ ...base, function_vram: start, function_rom: functionRom, function_size: end - start, body_words: bodyWords,
        body_changed: bodyChanged, variable_rom: variableRom, variable_base: null, variable_shifted: null, variable_changed: false,
        status: "unresolved", basis: "-", note: `${variable} lies past the end of one of the images` }));
      continue;
    }
    const [vb, vsh] = vw;
    const variableChanged = vb !== vsh;
    let status, basis;
    if (bodyChanged && !variableChanged) [status, basis] = ["checksum-stale", "-"];
    else if (variableChanged && !bodyChanged) [status, basis] = ["checksum-orphan", "-"];
    else [status, basis] = ["pass", bodyChanged ? "tracked" : "inert"];
    found.push(new ChecksumVerdict({ ...base, function_vram: start, function_rom: functionRom, function_size: end - start, body_words: bodyWords,
      body_changed: bodyChanged, variable_rom: variableRom, variable_base: vb, variable_shifted: vsh, variable_changed: variableChanged, status, basis, note: null }));
  }
  return found;
}

/** One statically-ranked word, judged by whether the shift moved it. */
export class StaleVerdict {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    const k = ["rom", "vram", "value", "shifted_value", "region", "residence", "resident_symbol", "resident_offset", "target_symbol",
      "target_offset", "tier", "rule", "verdict", "outcome"];
    return Object.fromEntries(k.map((x) => [x, this[x]]));
  }
}

const TIER_ORDER = { high: 0, medium: 1, low: 2 };

/** Judge every static hit inside the moved range against the relink. */
export function reconcile(hits, { base_image, shifted_image, insertion, delta, moved_range }) {
  const found = [];
  for (const h of hits) {
    if (!(moved_range[0] <= h.value && h.value < moved_range[1])) continue;
    const w = paired(base_image, shifted_image, h.rom, { insertion, delta });
    if (w === null) continue;
    const [old, nw] = w;
    let verdict, outcome;
    if (old === nw) [verdict, outcome] = ["unmoved", MERGE_TIERS[h.tier] ?? "noise"];
    else if (nw - old === delta) [verdict, outcome] = ["moved", TRACKS];
    else [verdict, outcome] = [CHANGED_OTHER, CHANGED_OTHER];
    found.push(new StaleVerdict({ rom: h.rom, vram: h.vram, value: h.value, shifted_value: nw, region: h.region, residence: h.residence,
      resident_symbol: h.resident_symbol, resident_offset: h.resident_offset, target_symbol: h.target_symbol, target_offset: h.target_offset,
      tier: h.tier, rule: h.rule, verdict, outcome }));
  }
  return found;
}

export const SYMBOL_STALE = "symbol-stale";
export const SHADOWING_PIN = "shadowing-pin";

export class SymbolRule {
  constructor(name, evidence) { Object.assign(this, { name, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, evidence: this.evidence }; }
}

export const SYMBOL_RULES = Object.freeze([
  new SymbolRule(SHADOWING_PIN, "an absolute (SHN_ABS) symbol carrying a non-zero st_size: GNU ld "
    + "let a linker-script assignment override an object's definition of "
    + "the same name, silently, and kept the overridden definition's size "
    + "and type on the surviving symbol. The object still defines it, so "
    + "deleting the assignment is byte-identical at the current layout -- "
    + "proved by ablation on the reference campaign's ten, which rebuilt to the same "
    + "sha1"),
  new SymbolRule(SYMBOL_STALE, "a symbol naming an address inside the range this shift moved, which "
    + "did not move by the delta. Every reference resolved through it now "
    + "points at whatever the relink put in its place"),
]);

/** One symbol the shift left behind, with the evidence it was judged on. */
export class SymbolFinding {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get movement() { return this.shifted_value - this.value; }
  asDict() {
    return { name: this.name, value: this.value, shifted_value: this.shifted_value, delta: this.movement, kind: this.kind, binding: this.binding,
      size: this.size, absolute: this.absolute, symbol_section: this.symbol_section, owning_section: this.owning_section, classification: this.classification };
  }
}

/** Every shared symbol above the insertion, judged against the relink. */
export class SymbolCensus {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  byClassification(c) { return this.findings.filter((f) => f.classification === c); }
  get symbol_stale() { return this.byClassification(SYMBOL_STALE).length; }
  get shadowing_pins() { return this.byClassification(SHADOWING_PIN).length; }
  asDict({ limit }) {
    const shown = this.findings.slice(0, Math.max(0, limit));
    return { base_elf: this.base_path, shifted_elf: this.shifted_path, symbol_range_lo: this.range_lo, symbol_range_hi: this.range_hi,
      symbol_checked: this.checked, symbol_moved: this.moved, symbol_stale: this.symbol_stale, shadowing_pins: this.shadowing_pins,
      symbol_boundary: this.boundary_symbols, symbol_only_in_base: this.only_in_base, symbol_only_in_shifted: this.only_in_shifted,
      symbol_findings_shown: shown.length, symbol_findings: shown.map((f) => f.asDict()), symbol_rules: SYMBOL_RULES.map((r) => r.asDict()) };
  }
}

/** Require every symbol in (anchor_vram, window_hi] to move by delta. */
export function symbolCensus(base, shifted, { delta, anchor_vram, window_hi }) {
  const bn = base.names(), sn = shifted.names();
  let checked = 0, moved = 0, boundary = 0;
  let findings = [];
  for (const name of sorted([...bn].filter((n) => sn.has(n)))) {
    const placed = base.symbol(name), relinked = shifted.symbol(name);
    if (placed.value === anchor_vram) { boundary += 1; continue; }
    if (!(anchor_vram < placed.value && placed.value <= window_hi)) continue;
    checked += 1;
    if (relinked.value - placed.value === delta) { moved += 1; continue; }
    const owner = base.sectionAt(placed.value);
    findings.push(new SymbolFinding({ name, value: placed.value, shifted_value: relinked.value, kind: placed.kind, binding: placed.binding,
      size: placed.size, absolute: placed.is_absolute, symbol_section: placed.section, owning_section: owner ? owner.name : null,
      classification: placed.shadows_definition ? SHADOWING_PIN : SYMBOL_STALE }));
  }
  const order = new Map(SYMBOL_RULES.map((r, i) => [r.name, i]));
  findings = sorted(findings, (f) => [order.get(f.classification) ?? order.size, f.value]);
  return new SymbolCensus({ base_path: base.path, shifted_path: shifted.path, delta, range_lo: anchor_vram, range_hi: window_hi, checked, moved,
    findings, boundary_symbols: boundary, only_in_base: [...bn].filter((n) => !sn.has(n)).length, only_in_shifted: [...sn].filter((n) => !bn.has(n)).length });
}

/** One base/shifted pair, fully explained. */
export class Rehearsal {
  constructor(f) { Object.assign(this, { symbols: null, ...f }); Object.freeze(this); }
  get movement_anomalies() { return this.movement.anomalies; }
  get unexplained_changed() { return this.census.unexplained_total; }
  get tier_verdicts() {
    const matrix = {};
    for (const tier of Object.keys(MERGE_TIERS)) matrix[tier] = { moved: 0, unmoved: 0, [CHANGED_OTHER]: 0 };
    for (const item of this.reconciliation) {
      const row = (matrix[item.tier] ??= { moved: 0, unmoved: 0, [CHANGED_OTHER]: 0 });
      row[item.verdict] = (row[item.verdict] ?? 0) + 1;
    }
    return matrix;
  }
  outcomeTotal(o) { return this.reconciliation.filter((r) => r.outcome === o).length; }
  get stale_confirmed() { return this.outcomeTotal("stale-confirmed"); }
  get stale_review() { return this.outcomeTotal("stale-review"); }
  get stale_noise() { return this.outcomeTotal("noise"); }
  get reconciled_total() { return this.reconciliation.length; }
  get moved_total() { return this.reconciliation.filter((r) => r.verdict === "moved").length; }
  get unmoved_total() { return this.reconciliation.filter((r) => r.verdict === "unmoved").length; }
  get changed_other_total() { return this.reconciliation.filter((r) => r.verdict === CHANGED_OTHER).length; }
  get stale_unattributed() { return this.census.stale_total - this.unmoved_total; }
  get checksum_pass() { return this.checksums.filter((c) => c.status === "pass").length; }
  get checksum_findings() { return this.checksums.filter((c) => c.status !== "pass").length; }
  get symbol_stale() { return this.symbols === null ? 0 : this.symbols.symbol_stale; }
  get shadowing_pins() { return this.symbols === null ? 0 : this.symbols.shadowing_pins; }
  get findings() {
    return this.unexplained_changed + this.stale_confirmed + this.movement_anomalies.length + this.checksum_findings + this.symbol_stale + this.shadowing_pins;
  }
  rankedStale() { return sorted(this.reconciliation.filter((r) => r.verdict === "unmoved"), (r) => [TIER_ORDER[r.tier] ?? 3, r.rom]); }
  asDict({ limit }) {
    const cap = Math.max(0, limit);
    const stale = this.rankedStale().slice(0, cap);
    const unexplained = this.census.unexplained.slice(0, cap);
    const anomalies = this.movement_anomalies.slice(0, cap);
    const payload = {
      schema: SHIFT_REHEARSE_SCHEMA, mode: "analyze", base_map: this.base_map_path, base_image: this.base_image_path,
      shifted_map: this.shifted_map_path, shifted_image: this.shifted_image_path, delta: this.delta,
      base_image_bytes: this.base_image_bytes, shifted_image_bytes: this.shifted_image_bytes, region_count: this.regions.length,
      regions: this.regions.map((r) => r.asDict()), generated_spans: this.generated.map((g) => ({ start: g.start, end: g.end, label: g.label })),
      total_words: this.census.total_words, differing_total: this.census.differing_total, classes: { ...this.census.counts },
      unexplained_changed: this.unexplained_changed, unexplained_shown: unexplained.length, unexplained: unexplained.map((u) => u.asDict()),
      stale_total: this.census.stale_total, stale_confirmed: this.stale_confirmed, stale_review: this.stale_review, stale_noise: this.stale_noise,
      stale_unattributed: this.stale_unattributed, stale_shown: stale.length, stale: stale.map((s) => s.asDict()), merge_tiers: { ...MERGE_TIERS },
      tier_verdicts: this.tier_verdicts, reconciled_total: this.reconciled_total, moved_total: this.moved_total, unmoved_total: this.unmoved_total,
      changed_other_total: this.changed_other_total, movement_shared: this.movement.movements.length,
      movement_anomaly_total: this.movement_anomalies.length, movement_anomaly_shown: anomalies.length, movement: anomalies.map((m) => m.asDict()),
      movement_only_in_base: this.movement.only_in_base.length, movement_only_in_shifted: this.movement.only_in_shifted.length,
      checksum_total: this.checksums.length, checksum_pass: this.checksum_pass, checksum_findings: this.checksum_findings,
      checksums: this.checksums.map((c) => c.asDict()), checksum_rules: CHECKSUM_RULES.map((r) => r.asDict()), findings: this.findings, limit,
    };
    Object.assign(payload, this.anchor.asDict(), this.window.asDict());
    payload.symbol_census = this.symbols !== null;
    if (this.symbols !== null) Object.assign(payload, this.symbols.asDict({ limit: cap }));
    return payload;
  }
}

/** Explain one relink: movement, census, reconciliation, checksums. */
export function buildRehearsal({ base_ldmap, base_image, shifted_ldmap, shifted_image, delta, anchor = null, blobs = [], header_sections = [".header"],
  crc_words = [], checksum_pairs = [], base_elf = null, shifted_elf = null, model = null, detail_cap = 200,
  base_map_path = null, base_image_path = null, shifted_map_path = null, shifted_image_path = null }) {
  checkImageDelta(base_image, shifted_image, { delta });
  const rangeModel = model !== null ? model : defaultPinModel();
  const regions = buildRegionTable(base_ldmap, { image_size: base_image.length, blobs, header_sections });
  const window = movableWindow(regions);
  const found = deriveAnchor(base_ldmap, shifted_ldmap, { delta, window_lo: window.lo, window_hi: window.hi, symbol: anchor });
  const movement = auditSymbolMovement(base_ldmap, shifted_ldmap, { allowed_deltas: [0, delta] });
  const specs = regions.filter((r) => r.rom !== null && r.kind !== "bss").map((r) => new RegionSpec({ start: r.rom, end: r.rom + r.size, kind: r.kind }));
  const generated = sorted([...new Set(crc_words)]).map((o) => new GeneratedSpec({ start: o, end: o + 4, label: "crc-header" }));
  for (const [, variable] of checksum_pairs) {
    const s = base_ldmap.symbol(variable);
    const p = s ? base_ldmap.romForVram(s.address) : null;
    if (p !== null) generated.push(new GeneratedSpec({ start: p, end: p + 4, label: "checksum-gen" }));
  }
  const census = buildWordCensus(base_image, shifted_image, { insertion_offset: found.rom, delta, regions: specs, generated,
    moved_range: [found.vram, window.hi], range_model: rangeModel, detail_cap });
  const hits = scanRegions(base_image, regions, { window, ldmap: base_ldmap, model: rangeModel });
  const reconciliation = reconcile(hits, { base_image, shifted_image, insertion: found.rom, delta, moved_range: [found.vram, window.hi] });
  const checksums = checksumVerdicts(checksum_pairs, { base_ldmap, base_image, shifted_image, insertion: found.rom, delta });
  if ((base_elf === null) !== (shifted_elf === null)) {
    throw new ValueError("--base-elf and --shifted-elf go together: whether a symbol moved is a question about two links, and one of them cannot answer it");
  }
  const symbols = base_elf !== null && shifted_elf !== null ? symbolCensus(base_elf, shifted_elf, { delta, anchor_vram: found.vram, window_hi: window.hi }) : null;
  return new Rehearsal({ base_map_path, base_image_path, shifted_map_path, shifted_image_path, delta, base_image_bytes: base_image.length,
    shifted_image_bytes: shifted_image.length, anchor: found, window, regions, generated: sorted(generated, (g) => g.start), movement, census,
    reconciliation, checksums, symbols });
}

/** One number two deltas did not agree on. */
export class Disagreement {
  constructor({ name, values }) { Object.assign(this, { name, values }); Object.freeze(this); }
  asDict() { return { name: this.name, values: { ...this.values } }; }
}

export const CONSISTENCY_KEYS = Object.freeze(["differing_total", "unexplained_changed", "stale_total", "stale_confirmed", "stale_review",
  "stale_noise", "movement_anomaly_total", "checksum_findings", "anchor_vram"]);

/** Report every count two or more deltas did not agree on. */
export function crossDeltaDisagreements(analyses) {
  if (analyses.length < 2) return [];
  const labels = analyses.map((a) => `0x${hexw(a.delta)}`);
  const rows = new Map();
  for (const name of sorted([...new Set(analyses.flatMap((a) => Object.keys(a.census.counts)))])) {
    rows.set(name, Object.fromEntries(labels.map((l, i) => [l, analyses[i].census.counts[name] ?? 0])));
  }
  const scalars = {
    differing_total: (a) => a.census.differing_total, unexplained_changed: (a) => a.unexplained_changed, stale_total: (a) => a.census.stale_total,
    stale_confirmed: (a) => a.stale_confirmed, stale_review: (a) => a.stale_review, stale_noise: (a) => a.stale_noise,
    movement_anomaly_total: (a) => a.movement_anomalies.length, checksum_findings: (a) => a.checksum_findings, anchor_vram: (a) => a.anchor.vram,
  };
  for (const name of CONSISTENCY_KEYS) rows.set(name, Object.fromEntries(labels.map((l, i) => [l, scalars[name](analyses[i])])));
  return [...rows.entries()].filter(([, v]) => new Set(Object.values(v)).size > 1).map(([name, values]) => new Disagreement({ name, values }));
}

/** One linker script with `. += DELTA;` inserted after an anchor line. */
export class PaddedScript {
  constructor({ text, line, anchor_line }) { Object.assign(this, { text, line, anchor_line }); Object.freeze(this); }
  asDict() { return { line: this.line, anchor_line: this.anchor_line }; }
}

/** Insert `. += DELTA;` directly after the anchor object's line. */
export function padLdScript(text, { anchor_object, delta }) {
  const lines = splitlines(text);
  const matches = lines.map((l, i) => (l.includes(anchor_object) ? i : -1)).filter((i) => i >= 0);
  if (!matches.length) throw new ValueError(`no line of the linker script mentions the anchor object ${strRepr(anchor_object)}; the pad has nowhere to go`);
  if (matches.length > 1) {
    throw new ValueError(`the anchor object ${strRepr(anchor_object)} matches ${matches.length} lines (${matches.map((i) => i + 1).join(", ")}); name one that appears exactly once, `
      + "because a pad in the wrong input section moves the wrong half of the image");
  }
  const index = matches[0];
  const anchorLine = lines[index];
  const indent = anchorLine.slice(0, anchorLine.length - lstrip(anchorLine).length);
  const padded = [...lines.slice(0, index + 1), `${indent}. += 0x${hexw(delta)};`, ...lines.slice(index + 1)];
  return new PaddedScript({ text: padded.join("\n") + "\n", line: index + 1, anchor_line: strip(anchorLine) });
}

/** One invocation of the caller's relink wrapper. */
export class RunRecord {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() { return { label: this.label, delta: this.delta, ld_script: this.ld_script, out_dir: this.out_dir, image: this.image, map: this.map, exit_status: this.exit_status }; }
}

export const WRAPPER_CONTRACT = "the wrapper is invoked as `SCRIPT LDSCRIPT_PATH OUT_DIR` and must leave "
  + "the linked image and its `ld -Map` file in OUT_DIR under the names given "
  + "by --image-name and --map-name. It should relink only -- the objects are "
  + "the controlled constant of this experiment, and rebuilding them changes "
  + "the question.";

function lastLine(completed) {
  const text = strip(completed.stderr || completed.stdout || "");
  if (!text) return "no diagnostic";
  const ls = splitlines(text);
  return ls[ls.length - 1];
}

function runWrapper(wrapper, ldScript, outDir, { label, cwd, env }) {
  mkdirSync(outDir, { recursive: true });
  const r = runProgramSync([wrapper, ldScript, outDir], { encoding: "utf8", cwd, env });
  if (r.error) throw new ValueError(`cannot run the wrapper for ${label}: ${osErrorText(Object.assign(r.error, { path: r.error.path ?? wrapper }))}`);
  return { returncode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** One base build, N shifted builds, and the comparison between them. */
export class Orchestration {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get findings() { return this.analyses.reduce((s, a) => s + a.findings, 0) + this.disagreements.length; }
  asDict({ limit }) {
    return { schema: SHIFT_REHEARSE_SCHEMA, mode: "orchestrate", wrapper: this.wrapper, ld_script: this.ld_script, anchor_object: this.anchor_object,
      workdir: this.workdir, image_name: this.image_name, map_name: this.map_name, deltas: this.analyses.map((a) => `0x${hexw(a.delta)}`),
      runs: this.runs.map((r) => r.asDict()), analyses: this.analyses.map((a) => a.asDict({ limit })), classes_agree: !this.disagreements.length,
      disagreements: this.disagreements.map((d) => d.asDict()), findings: this.findings, limit };
  }
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

/** Generate, relink, analyze, and compare -- in that order. */
export function orchestrate({ wrapper, ld_script, anchor_object, deltas, workdir, image_name, map_name, analyze, cwd = process.cwd(), env = process.env }) {
  const text = readFileSync(path.resolve(cwd, ld_script), "utf8");
  const padded = new Map(deltas.map((d) => [d, padLdScript(text, { anchor_object, delta: d })]));
  mkdirSync(path.resolve(cwd, workdir), { recursive: true });
  const runs = [];
  const build = (label, delta, script) => {
    const outDir = path.join(workdir, delta === 0 ? "base" : `delta-${label}`);
    const completed = runWrapper(wrapper, script, outDir, { label, cwd, env });
    if (completed.returncode !== 0) throw new ValueError(`the wrapper failed for ${label} with exit ${completed.returncode}: ${lastLine(completed)}`);
    const image = path.join(outDir, image_name), mapping = path.join(outDir, map_name);
    for (const produced of [image, mapping]) {
      if (!isFile(path.resolve(cwd, produced))) throw new ValueError(`the wrapper for ${label} left no ${path.basename(produced)} in ${outDir}: ${WRAPPER_CONTRACT}`);
    }
    return new RunRecord({ label, delta, ld_script: String(script), out_dir: outDir, image, map: mapping, exit_status: completed.returncode });
  };
  runs.push(build("base", 0, ld_script));
  for (const d of deltas) {
    const script = path.join(workdir, `shifted-0x${hexw(d)}.ld`);
    writeFileSync(path.resolve(cwd, script), padded.get(d).text, "utf8");
    runs.push(build(`0x${hexw(d)}`, d, script));
  }
  const base = runs[0];
  const analyses = runs.slice(1).map((run) => analyze({ base_map: base.map, base_image: base.image, shifted_map: run.map, shifted_image: run.image, delta: run.delta }));
  return new Orchestration({ wrapper, ld_script: String(ld_script), anchor_object, workdir: String(workdir), image_name, map_name, runs, analyses,
    disagreements: crossDeltaDisagreements(analyses) });
}

function table(header, rows) {
  if (!rows.length) return [header.join(" "), "none"];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const out = [header.map((h, c) => h.padEnd(widths[c])).join("  ").replace(/\s+$/, "")];
  for (const row of rows) out.push(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").replace(/\s+$/, ""));
  return out;
}

const named = (symbol, offset) => (symbol === null ? "-" : !offset ? symbol : `${symbol}+0x${hexw(offset)}`);

function symbolCensusLines(found, { limit }) {
  if (found === null) {
    return ["", "symbol_census=off -- pass --base-elf and --shifted-elf to run it. "
      + "The data-side referee above can only judge words the static scan "
      + "read, and it does not read text: a reference consumed only from "
      + "a lui/%lo pair is invisible to it. The symbol census answers "
      + "that half, and on the reference campaign it found 13x more blockers than "
      + "the data side did."];
  }
  const cap = Math.max(0, limit);
  const lines = ["",
    `symbol_census=on  symbol_checked=${comma(found.checked)}  symbol_moved=${comma(found.moved)}  symbol_stale=${comma(found.symbol_stale)}  shadowing_pins=${comma(found.shadowing_pins)}`,
    `symbol_range=(0x${hexw(found.range_lo, 8)}, 0x${hexw(found.range_hi, 8)}]  symbol_boundary=${comma(found.boundary_symbols)}  `
      + `symbol_only_in_base=${comma(found.only_in_base)}  symbol_only_in_shifted=${comma(found.only_in_shifted)}`,
    "", `symbol findings (${Math.min(found.findings.length, cap)} of ${comma(found.findings.length)}, --limit)`];
  lines.push(...table(["name", "value", "shifted", "class", "kind", "size", "owning_section"], found.findings.slice(0, cap).map((f) => [f.name,
    `0x${hexw(f.value, 8)}`, `0x${hexw(f.shifted_value, 8)}`, f.classification, f.kind, comma(f.size), f.owning_section || "-"])));
  lines.push("");
  for (const r of SYMBOL_RULES) lines.push(`  ${r.name}: ${r.evidence}`);
  return lines;
}

/** Render the human report: the same numbers asDict carries. */
export function rehearseLines(found, { limit }) {
  const a = found.anchor, w = found.window, cap = Math.max(0, limit);
  const lines = [
    `shift rehearse  base=${found.base_map_path || "-"}  shifted=${found.shifted_map_path || "-"}  delta=0x${hexw(found.delta)}`,
    "",
    `unexplained_changed=${comma(found.unexplained_changed)}  stale_confirmed=${comma(found.stale_confirmed)}  `
      + (found.symbols === null ? "" : `symbol_stale=${comma(found.symbol_stale)}  shadowing_pins=${comma(found.shadowing_pins)}  `)
      + `findings=${comma(found.findings)}`,
    "",
    `anchor_vram=0x${hexw(a.vram, 8)}  anchor_rom=0x${hexw(a.rom, 6)}  anchor_source=${a.source}  anchor_symbol=${a.symbol || "-"}  anchor_highest_unmoved=`
      + (a.highest_unmoved === null ? "-" : `0x${hexw(a.highest_unmoved, 8)}`),
    `window_lo=0x${hexw(w.lo, 8)}  window_hi=0x${hexw(w.hi, 8)}  base_image_bytes=${comma(found.base_image_bytes)}  `
      + `shifted_image_bytes=${comma(found.shifted_image_bytes)}  total_words=${comma(found.census.total_words)}`,
    "",
    `movement_shared=${comma(found.movement.movements.length)}  movement_anomaly_total=${comma(found.movement_anomalies.length)}  `
      + `movement_only_in_base=${comma(found.movement.only_in_base.length)}  movement_only_in_shifted=${comma(found.movement.only_in_shifted.length)}`,
    "",
    `movement anomalies (${Math.min(found.movement_anomalies.length, cap)} of ${comma(found.movement_anomalies.length)}, --limit)`,
  ];
  lines.push(...table(["name", "base_address", "shifted_address", "delta"], found.movement_anomalies.slice(0, cap).map((m) => [m.name,
    `0x${hexw(m.base_address, 8)}`, `0x${hexw(m.shifted_address, 8)}`, signedHex(m.delta)])));
  lines.push("", `differing_total=${comma(found.census.differing_total)}`, "", "classes");
  lines.push(...table(["label", "count"], Object.entries(found.census.counts).map(([n, c]) => [n, comma(c)])));
  lines.push("", "generated_spans");
  lines.push(...table(["start", "end", "label"], found.generated.map((g) => [`0x${hexw(g.start, 6)}`, `0x${hexw(g.end, 6)}`, g.label])));
  const unexplained = found.census.unexplained.slice(0, cap);
  lines.push("", `unexplained (${unexplained.length} of ${comma(found.unexplained_changed)}, --limit)`);
  lines.push(...table(["offset", "old", "new", "label"], unexplained.map((u) => [`0x${hexw(u.offset, 6)}`, hexw(u.old, 8), hexw(u.new, 8), u.label])));
  lines.push("", `checksum_total=${found.checksums.length}  checksum_pass=${found.checksum_pass}  checksum_findings=${found.checksum_findings}`, "", "checksums");
  lines.push(...table(["function", "variable", "status", "basis", "body_words", "body_changed"], found.checksums.map((c) => [c.function, c.variable,
    c.status, c.basis, comma(c.body_words), comma(c.body_changed)])));
  for (const c of found.checksums) if (c.note) lines.push(`  ${c.function}: ${c.note}`);
  lines.push("", `reconciled_total=${comma(found.reconciled_total)}  moved_total=${comma(found.moved_total)}  unmoved_total=${comma(found.unmoved_total)}  `
    + `changed_other_total=${comma(found.changed_other_total)}  stale_total=${comma(found.census.stale_total)}  stale_unattributed=${comma(found.stale_unattributed)}`,
  "", "tier_verdicts");
  const rows = [];
  for (const [tier, row] of Object.entries(found.tier_verdicts)) {
    for (const [verdict, count] of Object.entries(row)) {
      rows.push([tier, verdict, comma(count), verdict === "moved" ? TRACKS : verdict === CHANGED_OTHER ? CHANGED_OTHER : MERGE_TIERS[tier] ?? "noise"]);
    }
  }
  lines.push(...table(["tier", "verdict", "count", "outcome"], rows));
  if (found.stale_confirmed === 0 && found.unmoved_total) {
    const breakdown = found.stale_review === 0 ? "all noise" : `none confirmed (${comma(found.stale_review)} review, ${comma(found.stale_noise)} noise)`;
    lines.push("", `stale candidates: ${comma(found.unmoved_total)}, ${breakdown} -- pass --limit ${comma(found.unmoved_total)} to list them`);
  } else {
    const stale = found.rankedStale().slice(0, cap);
    lines.push("", `stale (${stale.length} of ${comma(found.unmoved_total)}, --limit)`);
    lines.push(...table(["rom", "value", "tier", "rule", "outcome", "region", "target_symbol"], stale.map((s) => [`0x${hexw(s.rom, 6)}`,
      `0x${hexw(s.value, 8)}`, s.tier, s.rule, s.outcome, s.region, named(s.target_symbol, s.target_offset)])));
  }
  lines.push(...symbolCensusLines(found.symbols, { limit }));
  lines.push("", "a stale-confirmed word is one the static audit ranked high -- "
    + "compiled data landing exactly on a symbol's start -- that this "
    + "relink did not move. It is the strongest available evidence for "
    + "a hardcoded pointer, and still evidence rather than a verdict: "
    + "read the coordinates, not the label.",
  "", "checksum-stale means a protected function's body changed and its "
    + "checksum word did not. That is the 2021 cursed-audio class: the "
    + "post-link patcher's allowlist missed the function, the frozen "
    + "value stopped describing the code, and the game's own runtime "
    + "self-check failed.");
  return lines;
}

/** Render the driver's own report, with each analysis under it. */
export function orchestrateLines(found, { limit }) {
  const lines = [
    `shift rehearse orchestrate  wrapper=${found.wrapper}  ld_script=${found.ld_script}  anchor_object=${found.anchor_object}`,
    "",
    `workdir=${found.workdir}  image_name=${found.image_name}  map_name=${found.map_name}  findings=${comma(found.findings)}`,
    "",
    "runs",
  ];
  lines.push(...table(["label", "delta", "exit_status", "out_dir"], found.runs.map((r) => [r.label, `0x${hexw(r.delta)}`, String(r.exit_status), r.out_dir])));
  lines.push("", `classes_agree=${!found.disagreements.length ? "yes" : "no"}  disagreements=${found.disagreements.length}`, "", "disagreements");
  lines.push(...table(["name", "values"], found.disagreements.map((d) => [d.name, Object.entries(d.values).map(([l, c]) => `${l}=${comma(c)}`).join(" ")])));
  for (const a of found.analyses) { lines.push("", "-".repeat(8), ""); lines.push(...rehearseLines(a, { limit })); }
  return lines;
}

/** Parse one FUNCTION=VARIABLE argument. */
export function parseChecksumPair(value) {
  const at = value.indexOf("=");
  const fn = at < 0 ? value : value.slice(0, at), variable = at < 0 ? "" : value.slice(at + 1);
  if (at < 0 || !strip(fn) || !strip(variable)) {
    throw new ValueError(`--checksum-pair ${strRepr(value)} is not FUNCTION=VARIABLE: name the protected function and the variable its byte-sum is patched into`);
  }
  return [strip(fn), strip(variable)];
}

/** Parse a comma-separated list of ROM offsets or deltas. */
export function parseOffsets(value) {
  const found = [];
  for (const item of value.split(",")) {
    const text = strip(item);
    if (!text) continue;
    try { found.push(pyInt(text, 0)); } catch { throw new ValueError(`${strRepr(text)} is not a number`); }
  }
  return found;
}

/** Parse every FUNCTION=VARIABLE argument, in the order given. */
export function parseMapping(rows) { return rows.map(parseChecksumPair); }
