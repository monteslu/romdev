// phase.js - ring phase as a vector over named row slots, with its coset
// always declared. A quotiented count is never printed bare: it carries the
// coset that produced it and the positional count beside it, slots are
// checked to partition the row space exactly, and a slot whose rows carry no
// evidence about its phase reports `no-evidence`. Rows are paired through
// shift-align, so an inserted instruction moves the comparison instead of
// destroying it.
//
// Plain JS ESM + JSDoc.

import { mismatchRanges } from "./compare.js";
import { comparableText, relocationRows } from "./shift-align.js";
import { ValueError, strRepr, sorted, fullmatch, reEscape } from "./py.js";

export const PHASE_SCHEMA = "decomp-workbench-phase-v1";
export const DEFAULT_RING = Object.freeze(["$f4", "$f6", "$f8", "$f10"]);
export const COSET_FAMILIES = Object.freeze(["all", "paired"]);
export const MAX_ALL_RING = 7;
export const DETAIL_RUNS = 20;

const RING_REGISTER_RE = /^\$(?:f\d+|zero|at|v[01]|a[0-3]|t\d|s[0-8]|k[01]|gp|sp|fp|ra)$/;
const SLOT_RE = /^(?<name>[A-Za-z0-9_][A-Za-z0-9_.-]*)=(?<start>\d+)\.\.(?<stop>\d+)$/;

export class PhaseError extends ValueError {}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));
const listRepr = (xs) => `[${xs.join(", ")}]`;

export class Slot {
  constructor({ name, start, stop }) { Object.assign(this, { name, start, stop }); Object.freeze(this); }
  get rows() { return this.stop - this.start + 1; }
  contains(row) { return this.start <= row && row <= this.stop; }
  asDict() { return { name: this.name, start: this.start, stop: this.stop }; }
}

/** Parse `NAME=LO..HI,NAME=LO..HI` into slots, in the order given. */
export function parseSlots(text) {
  const slots = [];
  for (const item of text.split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const m = SLOT_RE.exec(entry);
    if (!m) throw new PhaseError(`invalid slot ${strRepr(entry)}; write each slot as NAME=LO..HI, for example --slots 'head=0..1573,body=1574..4640'`);
    const start = parseInt(m.groups.start, 10), stop = parseInt(m.groups.stop, 10);
    if (stop < start) throw new PhaseError(`slot ${strRepr(m.groups.name)} ends before it starts (${start}..${stop}); write the lower row first`);
    slots.push(new Slot({ name: m.groups.name, start, stop }));
  }
  if (!slots.length) throw new PhaseError("--slots was empty; pass at least one NAME=LO..HI, or omit the option to score the whole object as one slot");
  const names = slots.map((s) => s.name);
  const dups = sorted([...new Set(names.filter((n) => names.filter((x) => x === n).length > 1))]);
  if (dups.length) throw new PhaseError("slot names must be unique; repeated: " + dups.join(", "));
  return slots;
}

/** Throw unless `slots` covers `first..last` exactly once each. */
export function validatePartition(slots, { first, last }) {
  const ordered = sorted(slots, (s) => [s.start, s.stop]);
  const problems = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const e = ordered[i], l = ordered[i + 1];
    if (l.start <= e.stop) problems.push(`${e.name} (${e.start}..${e.stop}) and ${l.name} (${l.start}..${l.stop}) overlap at rows ${l.start}..${Math.min(e.stop, l.stop)}`);
  }
  const covered = [];
  for (const s of ordered) {
    if (s.start > last || s.stop < first) { problems.push(`${s.name} (${s.start}..${s.stop}) lies outside the object's rows ${first}..${last}`); continue; }
    covered.push([Math.max(s.start, first), Math.min(s.stop, last)]);
  }
  const holes = [];
  let cursor = first;
  for (const [start, stop] of sorted(covered)) {
    if (start > cursor) holes.push([cursor, start - 1]);
    cursor = Math.max(cursor, stop + 1);
  }
  if (cursor <= last) holes.push([cursor, last]);
  if (holes.length) {
    problems.push(`these rows belong to no slot, so a mismatch there would be absent from every total: ${holes.map(([a, b]) => `${a}..${b} (${b - a + 1} row(s))`).join(", ")}`);
  }
  if (problems.length) throw new PhaseError(`the slot table does not partition rows ${first}..${last}:\n  - ` + problems.join("\n  - "));
}

const patternCache = new Map();

/** The substitution pattern for one ring (word boundary: $f1 never matches inside $f10). */
export function ringPattern(ring) {
  const key = ring.join("\u0000");
  if (!patternCache.has(key)) {
    patternCache.set(key, new RegExp(sorted(ring, (n) => n.length, true).map((n) => reEscape(n) + "\\b").join("|"), "g"));
  }
  return patternCache.get(key);
}

export class Coset {
  constructor({ ring, image }) { this.ring = [...ring]; this.image = [...image]; Object.freeze(this); }
  get is_identity() { return this.ring.length === this.image.length && this.ring.every((r, i) => r === this.image[i]); }
  get label() { return this.is_identity ? "id" : this.image.map((n) => n.replace(/^\$+/, "")).join("/"); }
  get mapping() { return Object.fromEntries(this.ring.map((r, i) => [r, this.image[i]])); }
  apply(text) {
    if (this.is_identity) return text;
    const table = this.mapping;
    return text.replace(ringPattern(this.ring), (m) => table[m]);
  }
  asDict() { return { label: this.label, identity: this.is_identity, ring: [...this.ring], image: [...this.image] }; }
}

/** Parse a comma-separated ring such as `$f4,$f6,$f8,$f10`. */
export function parseRing(text) {
  const names = [];
  for (const item of text.split(",")) {
    const entry = item.trim();
    if (!entry) continue;
    const register = entry.startsWith("$") ? entry : `$${entry}`;
    if (!RING_REGISTER_RE.test(register)) {
      throw new PhaseError(`invalid ring register ${strRepr(entry)}; the ring is a list of MIPS registers, for example --ring '$f4,$f6,$f8,$f10' for the float scratch ring, or --ring '$t6,$t7,$t8,$t9' for the integer temporaries`);
    }
    names.push(register);
  }
  if (names.length < 2) throw new PhaseError("--ring needs at least two registers; a one-register ring has only the identity coset and nothing to report");
  if (new Set(names).size !== names.length) throw new PhaseError("--ring must not repeat a register");
  return names;
}

function pairedImages(ring) {
  const images = [[...ring]];
  if (ring.length % 2) return images;
  const pairings = (remaining) => {
    if (!remaining.length) return [[]];
    const [first, ...rest] = remaining;
    const result = [];
    rest.forEach((other, position) => {
      const tail = [...rest.slice(0, position), ...rest.slice(position + 1)];
      for (const item of pairings(tail)) result.push([[first, other], ...item]);
    });
    return result;
  };
  const same = (a, b) => a.every((x, i) => x === b[i]);
  for (const pairing of pairings(ring.map((_, i) => i))) {
    const image = [...ring];
    for (const [l, r] of pairing) { image[l] = ring[r]; image[r] = ring[l]; }
    if (!images.some((x) => same(x, image))) images.push(image);
  }
  return images;
}

function* permutations(items) {
  // itertools.permutations order: lexicographic by input position.
  const n = items.length;
  const idx = [...Array(n).keys()];
  const cycles = [...Array(n).keys()].map((i) => n - i);
  yield idx.map((i) => items[i]);
  while (n) {
    let i = n - 1;
    for (; i >= 0; i--) {
      cycles[i] -= 1;
      if (cycles[i] === 0) { idx.push(...idx.splice(i, 1)); cycles[i] = n - i; }
      else { const j = n - cycles[i]; [idx[i], idx[j]] = [idx[j], idx[i]]; yield idx.map((k) => items[k]); break; }
    }
    if (i < 0) return;
  }
}

/** The cosets to search, identity first. */
export function ringCosets(ring, { family = "all" } = {}) {
  if (!COSET_FAMILIES.includes(family)) throw new PhaseError(`unknown coset family ${strRepr(family)}; expected one of ` + COSET_FAMILIES.join(", "));
  let images;
  if (family === "paired") images = pairedImages(ring);
  else {
    if (ring.length > MAX_ALL_RING) {
      throw new PhaseError(`--cosets all searches every permutation of the ring, which is ${ring.length}! for this ring; pass --cosets paired, or a ring of at most ${MAX_ALL_RING} registers`);
    }
    images = [[...ring]];
    for (const p of permutations(ring)) if (!p.every((x, i) => x === ring[i])) images.push(p);
  }
  return images.map((image) => new Coset({ ring, image }));
}

export class SlotScore {
  constructor({ slot, compared, masked, unpaired, informative, coset, coset_evidence, tied, quotiented, positional, quotiented_rows, positional_rows,
    healed = 0, broken = 0, healed_rows = [], broken_rows = [] }) {
    Object.assign(this, { slot, compared, masked, unpaired, informative, coset, coset_evidence, tied, quotiented, positional, quotiented_rows,
      positional_rows, healed, broken, healed_rows, broken_rows });
    Object.freeze(this);
  }
  get diverges() { return this.quotiented !== this.positional; }
  asDict() {
    return { slot: this.slot.name, start: this.slot.start, stop: this.slot.stop, compared: this.compared, masked: this.masked, unpaired: this.unpaired,
      informative: this.informative, coset: this.coset.asDict(), coset_evidence: this.coset_evidence, tied_cosets: [...this.tied],
      quotiented: this.quotiented, positional: this.positional, quotiented_rows: [...this.quotiented_rows], positional_rows: [...this.positional_rows],
      healed: this.healed, broken: this.broken, healed_rows: [...this.healed_rows], broken_rows: [...this.broken_rows] };
  }
}

const sumOf = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

export class PhaseReport {
  constructor({ target_name, candidate_name, symbol, ring, coset_family, target_rows, candidate_rows, slots, shift, base_source = null,
    base_sha256 = null, context_name = null, context_slots = [], baseline_name = null, cache_notes = [] }) {
    Object.assign(this, { target_name, candidate_name, symbol, ring, coset_family, target_rows, candidate_rows, slots, shift, base_source,
      base_sha256, context_name, context_slots, baseline_name, cache_notes });
    Object.freeze(this);
  }
  get quotiented() { return sumOf(this.slots, (s) => s.quotiented); }
  get positional() { return sumOf(this.slots, (s) => s.positional); }
  get healed() { return sumOf(this.slots, (s) => s.healed); }
  get broken() { return sumOf(this.slots, (s) => s.broken); }
  get instruction_delta() { return this.candidate_rows - this.target_rows; }
  get non_identity_slots() { return this.slots.filter((s) => !s.coset.is_identity); }
  get quotiented_is_bare() { return !this.non_identity_slots.length; }
  get phase_vector() { return this.slots.map((s) => s.coset.label); }
  asDict() {
    return { schema: PHASE_SCHEMA, target: this.target_name, candidate: this.candidate_name, symbol: this.symbol, ring: [...this.ring],
      coset_family: this.coset_family, target_rows: this.target_rows, candidate_rows: this.candidate_rows, instruction_delta: this.instruction_delta,
      phase_vector: [...this.phase_vector], quotiented: this.quotiented, positional: this.positional, quotiented_is_bare: this.quotiented_is_bare,
      slots: this.slots.map((s) => s.asDict()), shift: this.shift.asDict(), base_source: this.base_source, base_sha256: this.base_sha256,
      context: this.context_name, context_slots: this.context_slots.map((s) => s.asDict()), baseline: this.baseline_name,
      healed: this.baseline_name ? this.healed : null, broken: this.baseline_name ? this.broken : null, cache_notes: [...this.cache_notes] };
  }
}

function rowEvidence(target, candidate, { shift, cosets, ring }) {
  const tRel = relocationRows(target), cRel = relocationRows(candidate);
  const inverse = shift.pairing.target_of_candidate;
  const candidateAddresses = new Map();
  candidate.forEach((item, i) => { if (inverse.has(i)) candidateAddresses.set(item.address, inverse.get(i)); });
  const pattern = ringPattern(ring);
  const test = (s) => { pattern.lastIndex = 0; const hit = pattern.test(s); pattern.lastIndex = 0; return hit; };
  const fixed = new Map(), ringRows = new Set(), masked = new Set(), unpaired = new Set(), pending = new Map();
  for (let tr = 0; tr < target.length; tr++) {
    const cr = shift.pairing.candidateRow(tr);
    if (cr === null) { unpaired.add(tr); continue; }
    if (tRel.has(tr) || cRel.has(cr)) { masked.add(tr); continue; }
    const left = comparableText(target[tr]);
    const right = comparableText(candidate[cr], { row_of_address: candidateAddresses });
    if (test(left) || test(right)) { ringRows.add(tr); pending.set(tr, [left, right]); }
    else fixed.set(tr, left === right);
  }
  const matches = cosets.map((coset) => new Set([...pending].filter(([, [l, r]]) => coset.apply(r) === l).map(([row]) => row)));
  return { fixed, matches, ring_rows: ringRows, masked, unpaired };
}

function scoreSlot(slot, evidence, { cosets, minimum_evidence, fixed_coset = null }) {
  const rows = [];
  for (let r = slot.start; r <= slot.stop; r++) rows.push(r);
  const masked = rows.filter((r) => evidence.masked.has(r)).length;
  const unpaired = rows.filter((r) => evidence.unpaired.has(r)).length;
  const fixedBad = rows.filter((r) => evidence.fixed.get(r) === false);
  const ringRows = rows.filter((r) => evidence.ring_rows.has(r));
  const compared = rows.filter((r) => evidence.fixed.has(r)).length + ringRows.length;
  const informative = ringRows.filter((r) => new Set(evidence.matches.map((m) => m.has(r))).size > 1).length;
  const mismatches = (i) => { const m = evidence.matches[i]; return sorted([...fixedBad, ...ringRows.filter((r) => !m.has(r))]); };
  const positionalRows = mismatches(0);
  let chosen, tied, kind;
  if (fixed_coset !== null && fixed_coset !== undefined) { chosen = fixed_coset; tied = []; kind = "fixed-by-context"; }
  else if (informative < Math.max(minimum_evidence, 1)) { chosen = 0; tied = []; kind = "no-evidence"; }
  else {
    const scores = cosets.map((_, i) => mismatches(i).length);
    const best = Math.min(...scores);
    const winners = scores.map((v, i) => [v, i]).filter(([v]) => v === best).map(([, i]) => i);
    chosen = winners.includes(0) ? 0 : winners[0];
    tied = winners.length > 1 ? winners.map((i) => cosets[i].label) : [];
    kind = tied.length ? "ambiguous" : "measured";
  }
  const q = mismatches(chosen);
  return new SlotScore({ slot, compared, masked, unpaired, informative, coset: cosets[chosen], coset_evidence: kind, tied, quotiented: q.length,
    positional: positionalRows.length, quotiented_rows: q, positional_rows: positionalRows });
}

function withBaseline(score, baseline) {
  const before = new Set(baseline.positional_rows), after = new Set(score.positional_rows);
  const healed = sorted([...before].filter((r) => !after.has(r)));
  const broken = sorted([...after].filter((r) => !before.has(r)));
  return new SlotScore({ ...score, healed: healed.length, broken: broken.length, healed_rows: healed, broken_rows: broken });
}

/** Read one candidate's phase vector against a target, slot by slot. */
export function buildPhaseReport(target, candidate, { shift, slots = null, ring = DEFAULT_RING, coset_family = "all", minimum_evidence = 1,
  target_name = "target", candidate_name = "candidate", symbol = null, context = null, context_shift = null, context_name = null,
  baseline = null, baseline_shift = null, baseline_name = null, base_source = null, base_sha256 = null, cache_notes = [] }) {
  if (!target.length) throw new PhaseError("the target has no instruction rows to score against");
  const last = target.length - 1;
  const table = slots && slots.length ? [...slots] : [new Slot({ name: "all", start: 0, stop: last })];
  validatePartition(table, { first: 0, last });
  const cosets = ringCosets(ring, { family: coset_family });
  const evidence = rowEvidence(target, candidate, { shift, cosets, ring });
  let contextScores = [];
  const fixed = new Map();
  if (context !== null && context_shift !== null) {
    const ce = rowEvidence(target, context, { shift: context_shift, cosets, ring });
    contextScores = table.map((s) => scoreSlot(s, ce, { cosets, minimum_evidence }));
    for (const item of contextScores) {
      if (item.coset_evidence === "measured") fixed.set(item.slot.name, cosets.findIndex((c) => c.label === item.coset.label && c.image.every((x, i) => x === item.coset.image[i])));
    }
  }
  let scores = table.map((s) => scoreSlot(s, evidence, { cosets, minimum_evidence, fixed_coset: fixed.has(s.name) ? fixed.get(s.name) : null }));
  if (baseline !== null && baseline_shift !== null) {
    const be = rowEvidence(target, baseline, { shift: baseline_shift, cosets, ring });
    const bs = table.map((s) => scoreSlot(s, be, { cosets, minimum_evidence }));
    scores = scores.map((s, i) => withBaseline(s, bs[i]));
  }
  return new PhaseReport({ target_name, candidate_name, symbol, ring, coset_family, target_rows: target.length, candidate_rows: candidate.length,
    slots: scores, shift, base_source, base_sha256, context_name, context_slots: contextScores, baseline_name, cache_notes: [...cache_notes] });
}

/** The divergence warning when quotienting changed the answer. */
export function cosetWarning(report) {
  const rotated = report.non_identity_slots.filter((s) => s.diverges);
  if (!rotated.length) return null;
  const named = rotated.map((s) => `${s.slot.name}=${s.coset.label}`).join(", ");
  return `COSET: ${rotated.length} slot(s) sit at a non-identity ring coset (${named}), so the quotiented total (${report.quotiented}) and the `
    + `positional total (${report.positional}) are answers to different questions. Quotiented is what the object would score if the whole `
    + "ring were renamed -- which it has not been. Rank candidates on positional; read quotiented to size the renaming.";
}

export function shiftLines(report) {
  const shift = report.shift;
  if (report.instruction_delta === 0 && shift.edit_distance === 0) return ["shift: none -- the two streams align row for row"];
  const lines = [`ni: target ${report.target_rows} candidate ${report.candidate_rows} (${signed(report.instruction_delta)})` + (report.instruction_delta ? " SHIFTED" : "")];
  if (report.instruction_delta) lines.push("  a row-for-row scorer would compare every row after the first insertion against its neighbour; rows below are paired through the alignment instead");
  if (shift.insertion_only && shift.cuts.length) {
    lines.push(`shift: insertion-only, ${shift.cuts.length} cut(s) at target row(s) ${listRepr(sorted([...new Set(shift.cuts)]))} -- slot scores are shift-compensated`);
  } else if (shift.blocks.length) {
    lines.push(`shift: not insertion-only (${shift.replaced} replaced, ${shift.deleted} deleted) -- rows inside those blocks are genuinely different instructions, not displaced ones`);
  }
  return lines;
}

const p = (v, n) => String(v).padStart(n);

/** Render one phase report for a terminal. */
export function phaseLines(report, { detail = false } = {}) {
  const lines = [`phase: ${report.candidate_name} against ${report.target_name}` + (report.symbol ? ` (${report.symbol})` : "")];
  if (report.base_sha256) lines.push(`base: ${report.base_source} sha256=${report.base_sha256.slice(0, 16)}`);
  lines.push(...shiftLines(report));
  const searched = ringCosets(report.ring, { family: report.coset_family }).length;
  lines.push(`ring: ${report.ring.join(" ")} (${report.coset_family}; ${searched} coset(s) searched)`);
  lines.push(`slots: ${report.slots.length} named, partitioning target rows 0..${report.target_rows - 1} with no holes`);
  if (report.context_name) lines.push(`context: ${report.context_name} -- each slot is scored at the coset the context measures, not at its own best fit`);
  lines.push("");
  const nw = Math.max(6, ...report.slots.map((s) => s.slot.name.length));
  const cw = Math.max("no-evidence".length, ...report.slots.map((s) => s.coset.label.length + 1));
  let header = `${"slot".padEnd(nw)}  ${p("rows", 6)} ${p("masked", 6)} ${p("info", 6)}  ${"coset".padEnd(cw)}  ${p("quotiented", 10)} ${p("positional", 10)}`;
  if (report.baseline_name) header += ` ${p("healed", 7)} ${p("broken", 7)}`;
  lines.push(header);
  for (const item of report.slots) {
    let label = item.coset.label;
    if (item.coset_evidence === "no-evidence") label = "no-evidence";
    else if (item.coset_evidence === "ambiguous") label = `${label}?`;
    let row = `${item.slot.name.padEnd(nw)}  ${p(item.slot.rows, 6)} ${p(item.masked, 6)} ${p(item.informative, 6)}  ${label.padEnd(cw)}  ${p(item.quotiented, 10)} ${p(item.positional, 10)}`;
    if (report.baseline_name) row += ` ${p(item.healed, 7)} ${p(item.broken, 7)}`;
    lines.push(row);
  }
  const blindAll = report.slots.every((s) => s.coset_evidence === "no-evidence");
  const totalLabel = blindAll ? "no-evidence" : report.quotiented_is_bare ? "identity" : "MIXED";
  let total = `${"total".padEnd(nw)}  ${p(report.target_rows, 6)} ${p(sumOf(report.slots, (s) => s.masked), 6)} ${p(sumOf(report.slots, (s) => s.informative), 6)}  `
    + `${totalLabel.padEnd(cw)}  ${p(report.quotiented, 10)} ${p(report.positional, 10)}`;
  if (report.baseline_name) total += ` ${p(report.healed, 7)} ${p(report.broken, 7)}`;
  lines.push(total, "");
  lines.push("phase vector: " + report.slots.map((s) => `${s.slot.name}=` + (s.coset_evidence === "no-evidence" ? "?" : s.coset.label)).join(" "));
  if (report.quotiented_is_bare) lines.push(`free=${report.quotiented} (every slot at the identity coset, so this is also the positional count)`);
  else lines.push(`free=${report.quotiented} [COSET ${report.non_identity_slots.map((s) => `${s.slot.name}=${s.coset.label}`).join(", ")}; positional ${report.positional}]`);
  const warning = cosetWarning(report);
  if (warning) lines.push("", warning);
  const ambiguous = report.slots.filter((s) => s.coset_evidence === "ambiguous");
  if (ambiguous.length) {
    lines.push("");
    for (const s of ambiguous) lines.push(`AMBIGUOUS: slot ${s.slot.name} scores the same under ${s.tied.length} cosets (${s.tied.join(", ")}); its label is the identity of that tie, not a measurement`);
  }
  const blind = report.slots.filter((s) => s.coset_evidence === "no-evidence");
  if (blind.length) {
    lines.push("");
    for (const s of blind) lines.push(`NO EVIDENCE: slot ${s.slot.name} has ${s.informative} row(s) whose match depends on the coset, so its phase is not measured here. Score it in a composition that uses the ring, or widen the slot -- do not record it as identity.`);
  }
  if (report.context_slots.length) {
    report.slots.forEach((item, i) => {
      const other = report.context_slots[i];
      if (item.coset_evidence === "fixed-by-context" && other.coset.label !== item.coset.label) lines.push(`CONTEXT: slot ${item.slot.name} reads ${item.coset.label} in context and ${other.coset.label} in isolation`);
    });
  }
  if (report.baseline_name) {
    lines.push("", `against ${report.baseline_name}: healed ${report.healed} row(s), broke ${report.broken} row(s), net ${signed(report.broken - report.healed)} positional row(s)`);
  }
  if (report.cache_notes.length) lines.push("", ...report.cache_notes);
  if (detail) lines.push(...detailLines(report));
  return lines;
}

function detailLines(report) {
  const lines = ["", "residual by slot (quotiented rows, collapsed into runs):"];
  for (const item of report.slots) {
    if (!item.quotiented_rows.length) { lines.push(`  ${item.slot.name}: clean`); continue; }
    const runs = mismatchRanges([...item.quotiented_rows]);
    let rendered = runs.slice(0, DETAIL_RUNS).map(([a, b]) => (a === b ? `${a}` : `${a}..${b} (${b - a + 1})`)).join(", ");
    if (runs.length > DETAIL_RUNS) rendered += `, ... ${runs.length - DETAIL_RUNS} more run(s)`;
    lines.push(`  ${item.slot.name}: ${item.quotiented} row(s) in ${runs.length} run(s): ${rendered}`);
  }
  if (report.baseline_name) {
    lines.push("", "healed and broken rows by slot, collapsed into runs:");
    for (const item of report.slots) {
      if (!item.healed_rows.length && !item.broken_rows.length) continue;
      lines.push(`  ${item.slot.name}: healed ${runsText(item.healed_rows)}; broke ${runsText(item.broken_rows)}`);
    }
  }
  return lines;
}

function runsText(rows) {
  if (!rows.length) return "none";
  const ranges = mismatchRanges([...rows]);
  let rendered = ranges.slice(0, DETAIL_RUNS).map(([a, b]) => (a === b ? `${a}` : `${a}..${b}`)).join(", ");
  if (ranges.length > DETAIL_RUNS) rendered += `, ... ${ranges.length - DETAIL_RUNS} more run(s)`;
  return `${rows.length} row(s): ${rendered}`;
}
