// shift-config.js - `shift config verify`: is a configuration edit (a new
// linker script, a regenerated splat config) FAITHFUL to the pinned build?
// Three identity checks in strength order: every shared symbol at the same
// address, every shared output section at the same VMA/size/AT() address,
// and (optionally) byte-identical images. Exit 0 faithful, 3 not, 2 when the
// question could not be asked.
//
// Plain JS ESM + JSDoc.

import { ValueError, sorted } from "./py.js";
import { auditSymbolMovement } from "./ldmap.js";
import { comma, signedHex, hexw, intList, table } from "./shift-util.js";

export const CONFIG_VERIFY_SCHEMA = "decomp-workbench-shift-config-v1";
export const FAITHFUL_DELTAS = Object.freeze(new Set([0]));

export class FaithfulCheck {
  constructor(name, evidence) { Object.assign(this, { name, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, evidence: this.evidence }; }
}

export const FAITHFUL_CHECKS = Object.freeze([
  new FaithfulCheck("symbols", "every symbol both maps define is at the same address. The strongest "
    + "of the three: a byte-identical image can still coexist with a symbol "
    + "that moved into a hole, and only this check sees that"),
  new FaithfulCheck("sections", "every output section both maps place lands at the same VMA, with the "
    + "same size and the same AT() load address. Two layouts can share a "
    + "symbol table and still place their sections differently"),
  new FaithfulCheck("image", "the two linked images are byte-identical. The cheapest check and the "
    + "weakest; optional, because a config experiment compares maps before "
    + "it has images"),
]);

/** One output section the two maps did not place identically. */
export class SectionDivergence {
  constructor({ name, field, pinned, candidate }) { Object.assign(this, { name, field, pinned, candidate }); Object.freeze(this); }
  asDict() { return { section: this.name, field: this.field, pinned: this.pinned, candidate: this.candidate }; }
}

function sectionDivergences(pinned, candidate) {
  const byName = new Map(candidate.map((s) => [s.name, s]));
  const pinnedNames = new Set(pinned.map((s) => s.name));
  const found = [];
  let shared = 0;
  for (const section of sorted(pinned, (s) => [s.vma, s.name])) {
    const other = byName.get(section.name);
    if (!other) continue;
    shared += 1;
    for (const field of ["vma", "size", "load_address"]) {
      if (section[field] !== other[field]) { found.push(new SectionDivergence({ name: section.name, field, pinned: section[field], candidate: other[field] })); break; }
    }
  }
  return [found, sorted([...pinnedNames].filter((n) => !byName.has(n))), sorted([...byName.keys()].filter((n) => !pinnedNames.has(n))), shared];
}

function firstDifference(a, b) {
  if (a.length === b.length && Buffer.compare(a, b) === 0) return null;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

/** One pinned/candidate pair, judged against all three identity checks. */
export class ConfigVerification {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get symbols_moved() { return this.moved_symbols.length; }
  get sections_diverged() { return this.section_divergences.length; }
  get image_identical() {
    if (!this.image_checked) return null;
    return this.image_first_difference === null && this.image_bytes === this.candidate_image_bytes;
  }
  get first_moved_symbol() { return this.moved_symbols.length ? this.moved_symbols[0] : null; }
  get first_section_divergence() { return this.section_divergences.length ? this.section_divergences[0] : null; }
  get differences() {
    return this.symbols_moved + this.symbols_only_in_pinned.length + this.symbols_only_in_candidate.length
      + this.sections_diverged + this.sections_only_in_pinned.length + this.sections_only_in_candidate.length
      + (this.image_identical === null || this.image_identical === true ? 0 : 1);
  }
  get faithful() { return this.differences === 0; }
  asDict({ limit }) {
    const cap = Math.max(0, limit);
    return {
      schema: CONFIG_VERIFY_SCHEMA, pinned_map: this.pinned_map_path, candidate_map: this.candidate_map_path,
      pinned_image: this.pinned_image_path, candidate_image: this.candidate_image_path, allowed_deltas: sorted([...FAITHFUL_DELTAS]),
      shared_symbols: this.shared_symbols, symbols_moved: this.symbols_moved,
      symbols_only_in_pinned: this.symbols_only_in_pinned.length, symbols_only_in_candidate: this.symbols_only_in_candidate.length,
      moved_symbols_shown: this.moved_symbols.slice(0, cap).length,
      moved_symbols: this.moved_symbols.slice(0, cap).map(([name, pinned, candidate]) => ({ name, pinned, candidate })),
      shared_sections: this.shared_sections, sections_diverged: this.sections_diverged,
      sections_only_in_pinned: this.sections_only_in_pinned.slice(0, cap), sections_only_in_candidate: this.sections_only_in_candidate.slice(0, cap),
      section_divergences: this.section_divergences.slice(0, cap).map((d) => d.asDict()),
      image_checked: this.image_checked, image_identical: this.image_identical, image_bytes: this.image_bytes,
      candidate_image_bytes: this.candidate_image_bytes, image_first_difference: this.image_first_difference,
      differences: this.differences, faithful: this.faithful, faithful_checks: FAITHFUL_CHECKS.map((c) => c.asDict()), limit: cap,
    };
  }
}

/** Run all three identity checks over one pinned/candidate pair. */
export function verifyFaithful({ pinned, candidate, pinned_image = null, candidate_image = null, pinned_image_path = null, candidate_image_path = null }) {
  if ((pinned_image === null) !== (candidate_image === null)) {
    throw new ValueError("--pinned-image and --candidate-image go together: byte-identity is a question about two images, and one of them cannot answer it");
  }
  const movement = auditSymbolMovement(pinned, candidate, { allowed_deltas: FAITHFUL_DELTAS });
  const moved = movement.anomalies.map((m) => [m.name, m.base_address, m.shifted_address]);
  const [divergences, onlyPinned, onlyCandidate, sharedSections] = sectionDivergences(pinned.sections, candidate.sections);
  const first = pinned_image !== null && candidate_image !== null ? firstDifference(pinned_image, candidate_image) : null;
  return new ConfigVerification({
    pinned_map_path: pinned.path, candidate_map_path: candidate.path, pinned_image_path, candidate_image_path,
    shared_symbols: movement.movements.length, moved_symbols: moved, symbols_only_in_pinned: movement.only_in_base,
    symbols_only_in_candidate: movement.only_in_shifted, shared_sections: sharedSections, section_divergences: divergences,
    sections_only_in_pinned: onlyPinned, sections_only_in_candidate: onlyCandidate, image_checked: pinned_image !== null,
    image_bytes: pinned_image !== null ? pinned_image.length : null, candidate_image_bytes: candidate_image !== null ? candidate_image.length : null,
    image_first_difference: first,
  });
}

/** The human report: the same numbers asDict carries. */
export function verifyLines(found, { limit }) {
  const imageState = found.image_identical === null ? "not-checked" : found.image_identical ? "identical" : "differs";
  const cap = Math.max(0, limit);
  const lines = [
    `shift config verify  pinned=${found.pinned_map_path || "-"}  candidate=${found.candidate_map_path || "-"}`,
    "",
    `faithful=${found.faithful ? "yes" : "NO"}  differences=${comma(found.differences)}  allowed_deltas=${intList(sorted([...FAITHFUL_DELTAS]))}`,
    "",
    `shared_symbols=${comma(found.shared_symbols)}  symbols_moved=${comma(found.symbols_moved)}  `
      + `symbols_only_in_pinned=${comma(found.symbols_only_in_pinned.length)}  symbols_only_in_candidate=${comma(found.symbols_only_in_candidate.length)}`,
    `shared_sections=${comma(found.shared_sections)}  sections_diverged=${comma(found.sections_diverged)}  `
      + `sections_only_in_pinned=${comma(found.sections_only_in_pinned.length)}  sections_only_in_candidate=${comma(found.sections_only_in_candidate.length)}`,
    `image=${imageState}  pinned_image_bytes=` + (found.image_bytes === null ? "-" : comma(found.image_bytes))
      + "  candidate_image_bytes=" + (found.candidate_image_bytes === null ? "-" : comma(found.candidate_image_bytes))
      + "  image_first_difference=" + (found.image_first_difference === null ? "-" : `0x${hexw(found.image_first_difference, 6)}`),
  ];
  const fs = found.first_moved_symbol;
  if (fs) {
    const [name, p, c] = fs;
    lines.push("", `first divergent symbol: ${name} 0x${hexw(p, 8)} -> 0x${hexw(c, 8)} (${signedHex(c - p)})`);
  }
  const sec = found.first_section_divergence;
  if (sec) {
    lines.push(`first divergent section: ${sec.name}.${sec.field} ` + (sec.pinned === null ? "-" : `0x${hexw(sec.pinned)}`)
      + " -> " + (sec.candidate === null ? "-" : `0x${hexw(sec.candidate)}`));
  }
  lines.push("", `moved symbols (${Math.min(found.symbols_moved, cap)} of ${comma(found.symbols_moved)}, --limit)`);
  lines.push(...table(["name", "pinned", "candidate", "delta"], found.moved_symbols.slice(0, cap).map(([n, p, c]) => [n, `0x${hexw(p, 8)}`, `0x${hexw(c, 8)}`, signedHex(c - p)])));
  lines.push("", `section divergences (${Math.min(found.sections_diverged, cap)} of ${comma(found.sections_diverged)}, --limit)`);
  lines.push(...table(["section", "field", "pinned", "candidate"], found.section_divergences.slice(0, cap).map((d) => [d.name, d.field,
    d.pinned === null ? "-" : `0x${hexw(d.pinned)}`, d.candidate === null ? "-" : `0x${hexw(d.candidate)}`])));
  lines.push("", "checks");
  for (const check of FAITHFUL_CHECKS) lines.push(`  ${check.name}: ${check.evidence}`);
  lines.push("", "a faithful pair is one where a configuration edit changed the "
    + "linker script and nothing else -- the gate to pass before "
    + "rehearsing any shift; on the reference campaign it passed byte-exactly on "
    + "the first try. A pair that is genuinely shifted fails every one "
    + "of these checks by construction: that is `shift rehearse`'s "
    + "question, not this one's.");
  return lines;
}
