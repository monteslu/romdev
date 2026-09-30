// shift-plan.js - `shift plan`: merge a `shift audit` report and any number
// of `shift rehearse` reports into one ranked, gated remediation queue.
// Every item carries the reports that asked for it, one evidence line per
// routing rule, and the concrete command lines that prove the fix
// (convictions before suspicions, then class order, exemplars, section
// locality and address). `--markdown` renders the same queue as a work
// order grouped by remediation class.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ValueError, sorted, strRepr, pyStr, minBy } from "./py.js";
import { comma, hexw, toInt, isInt } from "./shift-util.js";

export const SHIFT_PLAN_SCHEMA = "decomp-workbench-shift-plan-v1";
export const AUDIT_SCHEMA = "decomp-workbench-shift-audit-v1";
export const REHEARSE_SCHEMA = "decomp-workbench-shift-rehearse-v1";

export const DELETE_REDUNDANT_PIN = "delete-redundant-pin";
export const DERIVE_PIN = "derive-pin";
export const MIGRATE_SYMBOL = "migrate-symbol";
export const INVESTIGATE = "investigate";
export const DUAL_SPELLING_RISK = "dual-spelling-risk";
export const WHITELIST_CANDIDATE = "whitelist-candidate";
export const STRUCTURAL = "structural";

/** One published remediation class: what the fix is, and how it is gated. */
export class Remediation {
  constructor(name, rank, kind, evidence, gate) { Object.assign(this, { name, rank, kind, evidence, gate }); Object.freeze(this); }
}

export const REMEDIATION_CLASSES = Object.freeze([
  new Remediation(DELETE_REDUNDANT_PIN, 0, "match-preserving",
    "an object in this link already defines the symbol and the linker "
    + "script's assignment silently overrode it. Deleting the assignment "
    + "restores a definition that follows the layout for free -- and "
    + "changes no bytes at the current layout, proved on "
    + "the reference campaign by ablating all ten and rebuilding to the same sha1",
    "rebuild and prove byte- and symbol-identity (`shift config verify`), then re-audit and watch pins_shadowing fall by one"),
  new Remediation(DERIVE_PIN, 1, "match-preserving",
    "the pinned value is one the linker already computes: it lands "
    + "exactly on a section's own ROM or VRAM boundary, so the script can "
    + "name that boundary instead of writing the number down. Measured "
    + "on the reference campaign -- five of its asset-table pins are, "
    + "byte for byte, the AT() load addresses of the five sections they "
    + "point at",
    "rebuild and prove byte- and symbol-identity (`shift config verify`), then re-audit and watch pins_rom_offset fall by one"),
  new Remediation(MIGRATE_SYMBOL, 2, "match-preserving",
    "a kseg0 address written down for content this link actually places. "
    + "The symbol needs a home in the section that owns its address -- a "
    + "data or bss migration, which is real decompilation work and is still "
    + "match-preserving: the bytes do not move, only who names them",
    "rebuild and prove byte- and symbol-identity (`shift config verify`), then re-run the rehearsal and watch symbol_stale fall by one"),
  new Remediation(INVESTIGATE, 3, "conviction",
    "the evidence names a word or a symbol but not a remediation: a "
    + "high-confidence address-shaped word the scan ranked, or an unmoved "
    + "symbol that lands on no boundary and inside no section. Read the "
    + "coordinates before deciding what class it is",
    "re-run the rehearsal at two independent deltas; a finding that survives both is not a coincidence of one layout"),
  new Remediation(DUAL_SPELLING_RISK, 4, "conviction",
    "references this instrumentation structurally cannot judge. A MIPS "
    + "address is split across a lui/%lo (or lui/ori) pair and never exists "
    + "as one word, so a data-side value test cannot see it and a linked "
    + "ROM keeps no relocation to read instead. The cost, measured on "
    + "the reference campaign: seven RSP-microcode pins and the boot stack pointer "
    + "were invisible to stale_confirmed and were found by the symbol side. "
    + "Whether the original source spelled one lui/addiu or lui/ori is "
    + "itself evidence about what it meant, and is per-compiler behaviour "
    + "to calibrate rather than assume",
    "run the symbol-side census (`shift rehearse analyze --base-elf --shifted-elf`), which does not depend on reading text at all"),
  new Remediation(WHITELIST_CANDIDATE, 5, "declaration",
    "an address the console fixes rather than this layout: a "
    + "memory-mapped register, or a boot global below the movable window's "
    + "own floor. The fix is a whitelist line with a reason on it, not a "
    + "code change -- and the reason is the whole point, because an address "
    + "with no reason is one somebody re-derives later",
    "add the line to your whitelist file and re-audit with --whitelist; pins_authentic rises by one and the entry stops being a suspect"),
  new Remediation(STRUCTURAL, 6, "parked",
    "a layout decision rather than a pin: an overlay window several "
    + "sections share, or a DMA'd blob whose link-time VMA is a load target "
    + "and not a place anything lives. Named and set aside on purpose -- "
    + "these are not fixed by editing a symbol file, and a queue that mixed "
    + "them in with the free wins would be a queue nobody finishes",
    "none. Parked with a named reason; revisit only with a segment-model change, and re-derive the queue afterwards"),
]);

const BY_NAME = new Map(REMEDIATION_CLASSES.map((r) => [r.name, r]));

/** One published reason a finding entered the queue in the class it did. */
export class PlanRule {
  constructor(name, source, remediation, conviction, evidence) { Object.assign(this, { name, source, remediation, conviction, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, source: this.source, remediation: this.remediation, conviction: this.conviction, evidence: this.evidence }; }
}

export const PLAN_RULES = Object.freeze([
  new PlanRule("audit-shadowing-pin", "audit-pin", DELETE_REDUNDANT_PIN, false, "`shift audit --elf` classed the pin shadowing-pin: the linked ELF's "
    + "symbol of that name is absolute and carries a non-zero size, which is the overridden object definition's own size"),
  new PlanRule("rehearse-shadowing-pin", "shadowing", DELETE_REDUNDANT_PIN, false, "the symbol-side census found the same shape across two links: an "
    + "absolute symbol with an inherited size that did not move"),
  new PlanRule("rehearse-stale-shadowing", "rehearse-stale", DELETE_REDUNDANT_PIN, true, "a relink left this word unmoved and the symbol it points at is a "
    + "shadowing pin: the strongest form of the finding, because the remediation is both free and demonstrated"),
  new PlanRule("rehearse-stale-confirmed", "rehearse-stale", INVESTIGATE, true, "a relink left a high-tier address word exactly where it was: the "
    + "strongest available evidence for a hardcoded pointer, with no remediation class the reports can derive on their own"),
  new PlanRule("rehearse-symbol-boundary", "rehearse-symbol", DERIVE_PIN, true, "a symbol the relink left behind whose value lands exactly on a "
    + "section boundary the linker already computes"),
  new PlanRule("rehearse-symbol-resident", "rehearse-symbol", MIGRATE_SYMBOL, true, "a symbol the relink left behind whose value lands inside a section "
    + "that moved: it names content this link places and needs a home there"),
  new PlanRule("rehearse-symbol-residue", "rehearse-symbol", INVESTIGATE, true, "a symbol the relink left behind that lands on no boundary and inside "
    + "no section: residue, or a window this model does not name"),
  new PlanRule("audit-rom-offset-pin", "audit-pin", DERIVE_PIN, false, "a raw cartridge offset, which the linker's own "
    + "<segment>_ROM_START/_ROM_END symbols already name"),
  new PlanRule("audit-artifact-pin", "audit-pin", MIGRATE_SYMBOL, false, "a kseg0 constant in a window the project itself owns, pointing "
    + "inside a section this link places"),
  new PlanRule("audit-whitelist-pin", "audit-pin", WHITELIST_CANDIDATE, false, "a hardware-window address, or a kseg0 constant below the movable "
    + "window's floor: fixed by the console, not by this layout"),
  new PlanRule("audit-scan-hit", "audit-scan", INVESTIGATE, false, "a high-tier scan hit: compiled data landing exactly on a symbol's "
    + "start. Static confidence only -- a linked ROM keeps no relocations, so only a relink convicts"),
  new PlanRule("audit-text-coverage", "audit-scan", DUAL_SPELLING_RISK, false, "the audit counted text words it deliberately did not scan; every "
    + "reference consumed only from a lui/%lo pair lives in them"),
  new PlanRule("rehearse-unattributed", "rehearse-stale", DUAL_SPELLING_RISK, true, "the word census found stale candidates the static scan never saw, "
    + "because they sit in a region it does not read"),
  new PlanRule("audit-shared-vram", "audit-scan", STRUCTURAL, false, "two or more output sections share one VMA. Extents alone cannot tell "
    + "a nested placement from an N64 overlay group, and either way the window is a layout decision"),
  new PlanRule("audit-blob-segment", "audit-scan", STRUCTURAL, false, "sections treated as opaque bytes: DMA'd from cart, so their "
    + "link-time VMA is a load target rather than a place code lives"),
]);

const RULES_BY_NAME = new Map(PLAN_RULES.map((r) => [r.name, r]));

/** Read one JSON report and refuse anything that is not `expected`. */
export function readReport(p, { expected }) {
  const text = readFileSync(p, "utf8");
  let payload;
  try { payload = JSON.parse(text); } catch (e) { throw new ValueError(`${p} is not JSON: ${e.message}`); }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    const t = payload === null ? "NoneType" : Array.isArray(payload) ? "list" : typeof payload === "string" ? "str" : typeof payload === "boolean" ? "bool" : Number.isInteger(payload) ? "int" : "float";
    throw new ValueError(`${p} is a JSON ${t}, not a report object`);
  }
  const schema = payload.schema ?? null;
  if (schema !== expected) throw new ValueError(`${p} carries schema ${strRepr(schema)}, not ${strRepr(expected)}: pass the report the matching command wrote with --json`);
  return payload;
}

const isDict = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const list = (x) => (Array.isArray(x) ? x : []);

function analysesOf(report) {
  if (report.mode === "orchestrate") return list(report.analyses).filter(isDict);
  return [report];
}

/** One thing to do, with every report that asked for it. */
export class PlanItem {
  constructor({ subject, remediation, title }) {
    Object.assign(this, { subject, remediation, title, sources: [], rules: [], _evidence: new Map(), _gates: new Map(), deltas: [],
      conviction: false, exemplar: false, section: null, value: null });
  }
  get rank() { return BY_NAME.get(this.remediation); }
  order() {
    return [this.conviction ? 0 : 1, this.rank.rank, this.exemplar ? 0 : 1, this.section || "~", this.value !== null ? this.value : 2 ** 32, this.subject];
  }
  get evidence() {
    const lines = [...this._evidence.values()];
    if (this.deltas.length > 1) {
      lines.push("confirmed at deltas " + this.deltas.map((d) => `0x${hexw(d)}`).join(", ")
        + " -- a reference can encode correctly at one shift by coincidence and cannot at two");
    }
    return lines;
  }
  get gates() { return [...this._gates.values()]; }
  merge({ source, rule, evidence, conviction, gates = {}, section = null, value = null, delta = null, exemplar = false }) {
    if (!this.sources.includes(source)) this.sources.push(source);
    if (!this.rules.includes(rule)) this.rules.push(rule);
    if (!this._evidence.has(rule)) this._evidence.set(rule, evidence);
    for (const [kind, command] of Object.entries(gates)) if (!this._gates.has(kind)) this._gates.set(kind, command);
    if (delta !== null && !this.deltas.includes(delta)) this.deltas.push(delta);
    this.conviction = this.conviction || conviction;
    this.exemplar = this.exemplar || exemplar;
    if (this.section === null) this.section = section;
    if (this.value === null) this.value = value;
  }
  asDict() {
    return { subject: this.subject, title: this.title, remediation: this.remediation, remediation_kind: this.rank.kind, conviction: this.conviction,
      exemplar: this.exemplar, sources: [...this.sources], matched_rules: [...this.rules], evidence: this.evidence, gates: this.gates,
      deltas: this.deltas.map((d) => `0x${hexw(d)}`), section: this.section, value: this.value };
  }
}

class Queue {
  constructor() { this.items = new Map(); }
  add({ subject, remediation, title, rule, evidence, gates = {}, section = null, value = null, delta = null, exemplar = false }) {
    const published = RULES_BY_NAME.get(rule);
    const key = JSON.stringify([remediation, subject]);
    let item = this.items.get(key);
    if (!item) { item = new PlanItem({ subject, remediation, title }); this.items.set(key, item); }
    item.merge({ source: published.source, rule, evidence, conviction: published.conviction, gates, section, value, delta, exemplar });
    return item;
  }
  ranked() { return sorted([...this.items.values()], (i) => i.order()); }
}

const quote = (p) => (p ? pyStr(p) : "<path>");

function identityGate(audit) {
  if (audit === null) return "decomp-workbench shift config verify --pinned-map <before>.map --candidate-map <after>.map --pinned-image <before>.z64 --candidate-image <after>.z64";
  return `decomp-workbench shift config verify --pinned-map ${quote(audit.map)} --candidate-map <rebuilt>.map --pinned-image ${quote(audit.image)} --candidate-image <rebuilt>.z64`;
}

function auditGate(audit, { census }) {
  if (audit === null) return `decomp-workbench shift audit ... --census ${census}`;
  const parts = ["decomp-workbench shift audit", "--map <rebuilt>.map", "--image <rebuilt>.z64"];
  if (audit.elf) parts.push("--elf <rebuilt>.elf");
  for (const s of list(audit.pin_sources)) parts.push(`--pins ${pyStr(s)}`);
  for (const b of list(audit.blobs)) parts.push(`--blob ${pyStr(b)}`);
  parts.push(`--census ${census}`);
  return parts.join(" ");
}

function rehearseGate(analysis, { census }) {
  if (analysis === null) return `decomp-workbench shift rehearse analyze ... --census ${census}`;
  const parts = ["decomp-workbench shift rehearse analyze", "--base-map <rebuilt-base>.map", "--base-image <rebuilt-base>.z64",
    "--shifted-map <rebuilt-shifted>.map", "--shifted-image <rebuilt-shifted>.z64", `--delta 0x${hexw(toInt(analysis.delta ?? 0))}`];
  if (analysis.base_elf) parts.push("--base-elf <rebuilt-base>.elf", "--shifted-elf <rebuilt-shifted>.elf");
  parts.push(`--census ${census}`);
  return parts.join(" ");
}

const EDGE_ORDER = ["ROM start", "VRAM start", "ROM end", "VRAM end"];
const EDGE_SUFFIX = { "ROM start": "_ROM_START", "ROM end": "_ROM_END", "VRAM start": "_VRAM", "VRAM end": "_VRAM_END" };

class Boundary {
  constructor(edges) { this.edges = edges; Object.freeze(this); }
  get edge() { return this.edges[0][0]; }
  get sections() { return this.edges[0][1]; }
  get section() { return this.sections[0]; }
  phrase(edge, sections) {
    const shared = sections.length > 1 ? ` (${sections.length} sections share it)` : "";
    return `the ${edge} of ${sections.join(", ")}${shared}`;
  }
  describe(value) {
    const primary = this.phrase(...this.edges[0]);
    const alternates = this.edges.slice(1).map(([e, s]) => `; and ${this.phrase(e, s)}`).join("");
    return `0x${hexw(value, 8)} is exactly ${primary}${alternates} -- an address this `
      + "link already computes, so the linker script can name that boundary "
      + `(splat spells it ${boundarySymbol(this)}) instead of writing the number down`;
  }
}

function boundarySymbol(b) { return `<${b.section.replace(/^\.+/, "")}>${EDGE_SUFFIX[b.edge]}`; }

function boundaries(regions) {
  const edges = new Map();
  const note = (address, edge, section) => {
    const key = JSON.stringify([address, edge]);
    if (!edges.has(key)) edges.set(key, { address, edge, names: [] });
    const e = edges.get(key);
    if (!e.names.includes(section)) e.names.push(section);
  };
  for (const r of regions) {
    const section = pyStr(r.output_section ?? "?");
    const size = toInt(r.size ?? 0);
    if (isInt(r.rom)) { note(Number(r.rom), "ROM start", section); note(Number(r.rom) + size, "ROM end", section); }
    if (isInt(r.vram)) { note(Number(r.vram), "VRAM start", section); note(Number(r.vram) + size, "VRAM end", section); }
  }
  const collected = new Map();
  for (const e of sorted([...edges.values()], (x) => [x.address, EDGE_ORDER.indexOf(x.edge)])) {
    if (!collected.has(e.address)) collected.set(e.address, []);
    collected.get(e.address).push([e.edge, [...e.names]]);
  }
  return new Map([...collected.entries()].map(([a, rows]) => [a, new Boundary(rows)]));
}

function owningSection(regions, value) {
  const c = regions.filter((r) => isInt(r.vram) && Number(r.vram) <= value && value < Number(r.vram) + toInt(r.size ?? 0));
  if (!c.length) return null;
  return pyStr(minBy(c, (r) => toInt(r.size ?? 0)).output_section ?? null);
}

/** One ranked, gated remediation queue and where every item came from. */
export class ShiftPlan {
  constructor({ audit_path, rehearse_paths, deltas, items, capped }) { Object.assign(this, { audit_path, rehearse_paths, deltas, items, capped }); Object.freeze(this); }
  byClass() {
    const found = Object.fromEntries(REMEDIATION_CLASSES.map((r) => [r.name, 0]));
    for (const i of this.items) found[i.remediation] = (found[i.remediation] ?? 0) + 1;
    return found;
  }
  bySource() {
    const m = new Map();
    for (const i of this.items) for (const s of i.sources) m.set(s, (m.get(s) ?? 0) + 1);
    return Object.fromEntries(sorted([...m.entries()], (e) => e[0]));
  }
  sections() {
    const m = new Map();
    for (const i of this.items) { if (i.section === null || i.rank.kind !== "match-preserving") continue; m.set(i.section, (m.get(i.section) ?? 0) + 1); }
    return Object.fromEntries(sorted([...m.entries()], (e) => e[0]));
  }
  get total() { return this.items.length; }
  get convictions() { return this.items.filter((i) => i.conviction).length; }
  get free_wins() { return this.items.filter((i) => i.remediation === DELETE_REDUNDANT_PIN).length; }
  get structural() { return this.items.filter((i) => i.remediation === STRUCTURAL).length; }
  asDict({ limit }) {
    const cap = Math.max(0, limit);
    const shown = this.items.slice(0, cap);
    const counts = this.byClass();
    return {
      schema: SHIFT_PLAN_SCHEMA, audit_report: this.audit_path, rehearse_reports: [...this.rehearse_paths], deltas: this.deltas.map((d) => `0x${hexw(d)}`),
      plan_total: this.total, plan_convictions: this.convictions, plan_free_wins: this.free_wins, plan_derive_pin: counts[DERIVE_PIN],
      plan_migrate_symbol: counts[MIGRATE_SYMBOL], plan_investigate: counts[INVESTIGATE], plan_dual_spelling: counts[DUAL_SPELLING_RISK],
      plan_whitelist: counts[WHITELIST_CANDIDATE], plan_structural: this.structural, plan_by_class: counts, plan_by_source: this.bySource(),
      plan_sections: this.sections(), plan_capped: [...this.capped], plan_shown: shown.length, plan_items: shown.map((i) => i.asDict()),
      remediation_classes: REMEDIATION_CLASSES.map((r) => ({ name: r.name, rank: r.rank, kind: r.kind, evidence: r.evidence, gate: r.gate })),
      plan_rules: PLAN_RULES.map((r) => r.asDict()), limit: cap,
    };
  }
}

function planAudit(queue, audit, capped) {
  const regions = list(audit.regions).filter(isDict);
  const bounds = boundaries(regions);
  const windowLo = toInt(audit.window_lo ?? 0);
  for (const pin of list(audit.pins)) {
    if (!isDict(pin)) continue;
    const name = pyStr(pin.name ?? "?");
    const value = pin.value ?? null;
    const vi = isInt(value);
    const classification = pin.classification ?? null;
    const section = vi ? owningSection(regions, value) : null;
    if (classification === "shadowing-pin") {
      queue.add({ subject: name, remediation: DELETE_REDUNDANT_PIN, title: `delete the pin ${name}`, rule: "audit-shadowing-pin",
        evidence: vi ? `${name} = 0x${hexw(value, 8)} in ${pyStr(pin.source ?? null)}:${pyStr(pin.line ?? null)} -- an object in this link already `
          + "defines it (the surviving absolute symbol carries that definition's own size)" : `${name}: an object in this link already defines it`,
        gates: { identity: identityGate(audit), audit: auditGate(audit, { census: "pins_shadowing=<one less>" }) }, section, value: vi ? value : null });
      continue;
    }
    if (classification === "rom-offset") {
      const boundary = vi ? bounds.get(value) ?? null : null;
      queue.add({ subject: name, remediation: DERIVE_PIN, title: `symbolize the ROM offset ${name}`, rule: "audit-rom-offset-pin",
        evidence: boundary !== null && vi ? boundary.describe(value) : vi ? `${name} = 0x${hexw(value, 8)} is a raw cartridge offset, `
          + "below every run-time RAM window and inside the extent this map places" : `${name} is a raw cartridge offset`,
        gates: { identity: identityGate(audit), audit: auditGate(audit, { census: "pins_rom_offset=<one less>" }) },
        section: boundary !== null ? boundary.section : section, value: vi ? value : null, exemplar: boundary !== null });
      continue;
    }
    if (classification === "artifact-suspect") {
      if (["kseg1", "cart"].includes(pin.window) || (vi && value < windowLo)) {
        queue.add({ subject: name, remediation: WHITELIST_CANDIDATE, title: `declare ${name} authentic, with a reason`, rule: "audit-whitelist-pin",
          evidence: vi ? `${name} = 0x${hexw(value, 8)} sits in the ${pyStr(pin.window ?? null)} window` : `${name} sits in the ${pyStr(pin.window ?? null)} window`,
          gates: { audit: auditGate(audit, { census: "pins_authentic=<one more>" }) }, value: vi ? value : null });
        continue;
      }
      const boundary = vi ? bounds.get(value) ?? null : null;
      if (boundary !== null && vi) {
        queue.add({ subject: name, remediation: DERIVE_PIN, title: `name the boundary ${name} points at`, rule: "audit-rom-offset-pin",
          evidence: boundary.describe(value), gates: { identity: identityGate(audit), audit: auditGate(audit, { census: "pins_artifact=<one less>" }) },
          section: boundary.section, value, exemplar: true });
        continue;
      }
      queue.add({ subject: name, remediation: MIGRATE_SYMBOL, title: `give ${name} a home in ${section || "its own section"}`, rule: "audit-artifact-pin",
        evidence: vi ? `${name} = 0x${hexw(value, 8)} is a kseg0 constant` + (section ? ` inside ${section}` : ", inside no section") : `${name} is a kseg0 constant`,
        gates: { identity: identityGate(audit), audit: auditGate(audit, { census: "pins_artifact=<one less>" }) }, section, value: vi ? value : null });
      continue;
    }
  }
  if (toInt(audit.pins_shown ?? 0) < toInt(audit.pins_total ?? 0)) {
    capped.push(`pins (${pyStr(audit.pins_shown ?? null)} of ${pyStr(audit.pins_total ?? null)} carried by the audit report)`);
  }
  for (const hit of list(audit.hits)) {
    if (!isDict(hit) || hit.tier !== "high") continue;
    const rom = toInt(hit.rom ?? 0);
    const target = hit.target_symbol ?? null;
    queue.add({ subject: `rom:0x${hexw(rom, 6)}`, remediation: INVESTIGATE, title: `triage the word at ROM 0x${hexw(rom, 6)}` + (target ? ` -> ${pyStr(target)}` : ""),
      rule: "audit-scan-hit",
      evidence: `0x${hexw(toInt(hit.value ?? 0), 8)} in ${pyStr(hit.region ?? null)} at ${hit.resident_symbol ? pyStr(hit.resident_symbol) : "no named symbol"}, landing on `
        + `${target ? pyStr(target) : "no symbol start"} -- ranked high by the static scan, which cannot say whether a relink moves it`,
      gates: { rehearse: "decomp-workbench shift rehearse analyze ... --census stale_confirmed=0" },
      section: hit.region ? pyStr(hit.region) : null, value: rom });
  }
  if (toInt(audit.hits_shown ?? 0) < toInt(audit.scan_high ?? 0)) {
    capped.push(`scan hits (${pyStr(audit.hits_shown ?? null)} rows carried, scan_high=${pyStr(audit.scan_high ?? null)})`);
  }
  const textWords = toInt(audit.text_words ?? 0);
  if (textWords) {
    queue.add({ subject: "text-regions", remediation: DUAL_SPELLING_RISK, title: "the text side is not covered by any value test", rule: "audit-text-coverage",
      evidence: `${comma(textWords)} instruction words in ${pyStr(audit.text_regions ?? null)} text region(s) were counted and `
        + "not scanned: a MIPS address is split across a lui/%lo pair and never exists as one word",
      gates: { rehearse: "decomp-workbench shift rehearse analyze --base-elf <base>.elf --shifted-elf <shifted>.elf ... --census symbol_stale=0" } });
  }
  const shared = new Map();
  for (const r of regions) {
    const name = pyStr(r.output_section ?? "?");
    if (r.kind === "non-alloc" || !toInt(r.size ?? 0)) continue;
    if (isInt(r.vram)) {
      const v = Number(r.vram);
      if (!shared.has(v)) shared.set(v, []);
      if (!shared.get(v).includes(name)) shared.get(v).push(name);
    }
  }
  for (const [vram, names] of sorted([...shared.entries()], (e) => e[0])) {
    if (names.length < 2) continue;
    queue.add({ subject: `vram:0x${hexw(vram, 8)}`, remediation: STRUCTURAL, title: `${names.length} output sections share VRAM 0x${hexw(vram, 8)}`, rule: "audit-shared-vram",
      evidence: `${names.join(", ")} all start at 0x${hexw(vram, 8)}. Extents alone cannot tell a nested placement from an N64 overlay group of `
        + "mutually exclusive alternatives, and either shape is a layout decision rather than a pin", value: vram });
  }
  const blobs = list(audit.blobs).map((b) => pyStr(b));
  if (blobs.length) {
    queue.add({ subject: "blob-segments", remediation: STRUCTURAL, title: `${blobs.length} section(s) are opaque blobs`, rule: "audit-blob-segment",
      evidence: `${blobs.join(", ")} are treated as opaque bytes: DMA'd from cart, so their link-time VMA is a load target and not a place `
        + "anything lives. Their contents are not attributable to symbols by any static means this command has" });
  }
}

function planRehearse(queue, analysis, audit, capped) {
  let regions = list(analysis.regions).filter(isDict);
  if (!regions.length && audit !== null) regions = list(audit.regions).filter(isDict);
  const bounds = boundaries(regions);
  const shadowing = new Set(list(analysis.symbol_findings).filter((i) => isDict(i) && i.classification === "shadowing-pin").map((i) => pyStr(i.name ?? null)));
  const delta = toInt(analysis.delta ?? 0);
  for (const row of list(analysis.stale)) {
    if (!isDict(row) || row.outcome !== "stale-confirmed") continue;
    const rom = toInt(row.rom ?? 0);
    const target = row.target_symbol ?? null;
    const evidence = `ROM 0x${hexw(rom, 6)} holds 0x${hexw(toInt(row.value ?? 0), 8)} in ${pyStr(row.region ?? null)} and a 0x${hexw(delta)} relink did not move it; it `
      + `points at ${target ? pyStr(target) : "no named symbol"}`;
    if (target && shadowing.has(pyStr(target))) {
      queue.add({ subject: pyStr(target), remediation: DELETE_REDUNDANT_PIN, title: `delete the pin ${pyStr(target)}`, rule: "rehearse-stale-shadowing", evidence,
        gates: { identity: identityGate(audit), rehearse: rehearseGate(analysis, { census: "stale_confirmed=<one less>" }) },
        section: row.region ? pyStr(row.region) : null, value: toInt(row.value ?? 0), delta });
      continue;
    }
    queue.add({ subject: `rom:0x${hexw(rom, 6)}`, remediation: INVESTIGATE, title: `convicted word at ROM 0x${hexw(rom, 6)}`, rule: "rehearse-stale-confirmed", evidence,
      gates: { rehearse: rehearseGate(analysis, { census: "stale_confirmed=<one less>" }) }, section: row.region ? pyStr(row.region) : null, value: rom, delta });
  }
  if (toInt(analysis.stale_shown ?? 0) < toInt(analysis.stale_confirmed ?? 0)) {
    capped.push(`stale rows (${pyStr(analysis.stale_shown ?? null)} carried, stale_confirmed=${pyStr(analysis.stale_confirmed ?? null)})`);
  }
  for (const row of list(analysis.symbol_findings)) {
    if (!isDict(row)) continue;
    const name = pyStr(row.name ?? "?");
    const value = toInt(row.value ?? 0);
    const owner = row.owning_section ?? null;
    if (row.classification === "shadowing-pin") {
      queue.add({ subject: name, remediation: DELETE_REDUNDANT_PIN, title: `delete the pin ${name}`, rule: "rehearse-shadowing-pin",
        evidence: `${name} = 0x${hexw(value, 8)} is absolute and carries a ${pyStr(row.size ?? null)}-byte size inherited from the object `
          + `definition it overrode; a 0x${hexw(delta)} relink left it behind while ${owner ? pyStr(owner) : "its content"} moved`,
        gates: { identity: identityGate(audit), rehearse: rehearseGate(analysis, { census: "shadowing_pins=<one less>" }) },
        section: owner ? pyStr(owner) : null, value, delta });
      continue;
    }
    const boundary = bounds.get(value) ?? null;
    if (boundary !== null) {
      queue.add({ subject: name, remediation: DERIVE_PIN, title: `name the boundary ${name} points at`, rule: "rehearse-symbol-boundary",
        evidence: boundary.describe(value) + `; a 0x${hexw(delta)} relink moved that boundary and left ${name} behind`,
        gates: { identity: identityGate(audit), rehearse: rehearseGate(analysis, { census: "symbol_stale=<one less>" }) },
        section: boundary.section, value, delta, exemplar: true });
      continue;
    }
    if (owner) {
      queue.add({ subject: name, remediation: MIGRATE_SYMBOL, title: `give ${name} a home in ${pyStr(owner)}`, rule: "rehearse-symbol-resident",
        evidence: `${name} = 0x${hexw(value, 8)} lands inside ${pyStr(owner)}, which a 0x${hexw(delta)} relink moved by 0x${hexw(delta)} while ${name} stayed put`,
        gates: { identity: identityGate(audit), rehearse: rehearseGate(analysis, { census: "symbol_stale=<one less>" }) }, section: pyStr(owner), value, delta });
      continue;
    }
    queue.add({ subject: name, remediation: INVESTIGATE, title: `triage the unmoved symbol ${name}`, rule: "rehearse-symbol-residue",
      evidence: `${name} = 0x${hexw(value, 8)} did not move under a 0x${hexw(delta)} relink and lands on no section boundary and inside no section`,
      gates: { rehearse: rehearseGate(analysis, { census: "symbol_stale=<one less>" }) }, value, delta });
  }
  if (toInt(analysis.symbol_findings_shown ?? 0) < toInt(analysis.symbol_stale ?? 0) + toInt(analysis.shadowing_pins ?? 0)) {
    capped.push(`symbol findings (${pyStr(analysis.symbol_findings_shown ?? null)} carried, symbol_stale=${pyStr(analysis.symbol_stale ?? null)} `
      + `shadowing_pins=${pyStr(analysis.shadowing_pins ?? null)})`);
  }
  const unattributed = toInt(analysis.stale_unattributed ?? 0);
  if (unattributed) {
    queue.add({ subject: "stale-unattributed", remediation: DUAL_SPELLING_RISK, title: `${comma(unattributed)} stale candidates the scan never saw`,
      rule: "rehearse-unattributed", evidence: `the word census counted ${comma(unattributed)} unmoved address-shaped words the static scan never read, `
        + "because they sit in a region it does not scan", gates: { rehearse: rehearseGate(analysis, { census: "symbol_stale=0" }) }, delta });
  }
  if (!analysis.symbol_census) capped.push("symbol census (off in this rehearse report -- re-run with --base-elf/--shifted-elf)");
}

/** Merge every report into one ranked queue. */
export function buildPlan({ audit = null, rehearsals = [], audit_path = null, rehearse_paths = [] } = {}) {
  const queue = new Queue();
  const capped = [];
  if (audit !== null) planAudit(queue, audit, capped);
  const analyses = [];
  for (const r of rehearsals) analyses.push(...analysesOf(r));
  for (const a of analyses) planRehearse(queue, a, audit, capped);
  return new ShiftPlan({ audit_path, rehearse_paths: [...rehearse_paths], deltas: analyses.map((a) => toInt(a.delta ?? 0)), items: queue.ranked(),
    capped: [...new Set(capped)] });
}

export const CAMPAIGN_LOOP = "fix one item -> rebuild -> prove the ROM is byte- and symbol-identical "
  + "(`shift config verify`) -> re-run the instrument that found it and watch "
  + "its census key fall by one. A fix that cannot pass its own gate is not a "
  + "fix; a fix with no gate is a hope.";

export const GATE_PLACEHOLDER_NOTE = "**Placeholders.** `<rebuilt>` marks a path this fix's rebuild produces "
  + "-- the map, image, or ELF the gate command re-reads, never the one the "
  + "report above was built from. `shift rehearse analyze` rebuilds two "
  + "links, so its gates say `<rebuilt-base>` and `<rebuilt-shifted>`. "
  + "Everything else in a gate command -- pin files, blob names, the delta, "
  + "the census expression -- is copy-paste literal.";

function table(header, rows) {
  if (!rows.length) return [header.join(" ")];
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const out = [header.map((h, c) => h.padEnd(widths[c])).join("  ").replace(/\s+$/, "")];
  for (const row of rows) out.push(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").replace(/\s+$/, ""));
  return out;
}

/** Render the human report: the same numbers asDict carries. */
export function planLines(found, { limit }) {
  const counts = found.byClass();
  const lines = [
    `shift plan  audit=${found.audit_path || "-"}  rehearse=${found.rehearse_paths.join(", ") || "-"}`,
    "",
    `plan_total=${comma(found.total)}  plan_convictions=${comma(found.convictions)}  plan_free_wins=${comma(found.free_wins)}  plan_structural=${comma(found.structural)}`,
    "",
    "plan_by_class",
  ];
  lines.push(...table(["remediation", "kind", "count"], REMEDIATION_CLASSES.map((r) => [r.name, r.kind, comma(counts[r.name])])));
  lines.push("", "plan_by_source");
  lines.push(...table(["source", "items"], Object.entries(found.bySource()).map(([n, c]) => [n, comma(c)])));
  const sections = found.sections();
  if (Object.keys(sections).length) {
    lines.push("", "plan_sections (working items per owning section)");
    lines.push(...table(["section", "items"], Object.entries(sections).map(([n, c]) => [n, comma(c)])));
  }
  const shown = found.items.slice(0, Math.max(0, limit));
  lines.push("", `queue (${shown.length} of ${comma(found.total)}, --limit)`);
  lines.push(...table(["#", "remediation", "conviction", "section", "subject", "sources"], shown.map((i, n) => [String(n + 1), i.remediation,
    i.conviction ? "yes" : "-", i.section || "-", i.subject, i.sources.join(",")])));
  shown.forEach((item, n) => {
    lines.push("", `${n + 1}. ${item.title}  [${item.remediation}]`);
    for (const e of item.evidence) lines.push(`     evidence: ${e}`);
    for (const g of item.gates) lines.push(`     gate: ${g}`);
  });
  if (found.capped.length) {
    lines.push("", "plan_capped -- this plan is built from capped reports");
    for (const c of found.capped) lines.push(`  ${c}`);
    lines.push("  Re-run the reports with a larger --limit to plan the rest. A detail list that stopped at --limit cannot describe what came "
      + "after it, and neither can this queue.");
  }
  lines.push("", "remediation classes");
  for (const r of REMEDIATION_CLASSES) { lines.push(`  ${r.name} (${r.kind}): ${r.evidence}`); lines.push(`    gate: ${r.gate}`); }
  lines.push("", `the loop: ${CAMPAIGN_LOOP}`);
  return lines;
}

/** Render the work order: a grouped checklist a maintainer works through. */
export function planMarkdown(found) {
  const lines = [
    "# Shift remediation work order", "", `**The loop.** ${CAMPAIGN_LOOP}`, "", GATE_PLACEHOLDER_NOTE, "", "| | |", "|---|---|",
    `| audit report | \`${found.audit_path || "-"}\` |`,
    `| rehearse reports | ${found.rehearse_paths.map((p) => `\`${p}\``).join(", ") || "-"} |`,
    `| deltas rehearsed | ${found.deltas.map((d) => `\`0x${hexw(d)}\``).join(", ") || "-"} |`,
    `| items | ${found.total} |`, `| convictions (a relink demonstrated these) | ${found.convictions} |`,
    `| free wins (byte-identical to fix) | ${found.free_wins} |`, `| parked as structural | ${found.structural} |`, "",
  ];
  if (found.capped.length) {
    lines.push("> **This plan is built from capped reports.** A detail list that stopped at `--limit` cannot describe what came after "
      + "it, and neither can this queue. Re-run with a larger `--limit` to plan the rest.", "");
    for (const c of found.capped) lines.push(`> - ${c}`);
    lines.push("");
  }
  const position = new Map();
  found.items.forEach((i, n) => position.set(i.subject, n + 1));
  for (const r of REMEDIATION_CLASSES) {
    const group = found.items.filter((i) => i.remediation === r.name);
    if (!group.length) continue;
    lines.push(`## ${r.name} (${group.length})`, "", `*${r.kind}.* ${r.evidence}`, "", `**Gate:** ${r.gate}`, "");
    let heading = null;
    for (const item of group) {
      if (r.name === MIGRATE_SYMBOL) {
        const owner = item.section || "no owning section";
        if (owner !== heading) { heading = owner; lines.push(`### ${owner}`, ""); }
      }
      const rank = position.get(item.subject) ?? 0;
      lines.push(`- [ ] **#${rank} ${item.title}**${item.conviction ? " **(conviction)**" : ""}`);
      for (const e of item.evidence) lines.push(`  - evidence: ${e}`);
      for (const g of item.gates) lines.push(`  - gate: \`${g}\``);
      lines.push(`  - sources: ${item.sources.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("---", "", "Every line above is evidence with coordinates attached, not a "
    + "verdict about this project. The instrumentation reports what it "
    + "measured and names what it structurally cannot see; the fixes, "
    + "and the judgement about which of these addresses are authentic, "
    + "remain the maintainer's.", "");
  return lines.join("\n");
}
