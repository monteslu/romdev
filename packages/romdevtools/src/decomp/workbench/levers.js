// levers.js - the source edit a residual's evidence supports, or the proof
// there is none. `diagnose` names the mechanism, the owning pass and how
// close a source edit gets to it; this module does the arithmetic from that
// evidence to the edit class an analyst actually types:
//
//   stack-home      frame pair (+ declared-local count from a CDX ladder)
//   temp-ring       DKWB_UGEN_TRACE free-list pops per source line
//   line-order      DKWB-EMIT-V1 line-order conflicts
//   pool-rotation / pool-population   the two pool lanes' sequences
//   unreachable     the catalogued proofs, or an as1 -R readiness measurement
//
// The evidence rule is the whole design: a class is named from evidence or not
// at all. Where the deciding input is a trace nobody captured, the report
// says which trace and leaves `edit_family` null.
//
// Citations name the measured function and date; the retail title they were
// measured on is referred to as "the reference campaign".
//
// Plain JS ESM + JSDoc.

import { ValueError, sorted, strip, floatRepr, pyStr, pyEq, counter } from "./py.js";
import { lineOrderConflicts } from "./emit-provenance.js";
import { colorForRegister, optionalInteger } from "./globalcolor.js";
import { allocationBank, allocationIssues, registerName, replayFifo } from "./trace.js";
import { OWNING_PASS_CFE, OWNING_PASS_G0_SCHEDULER, OWNING_PASS_STACK_HOME, OWNING_PASS_UGEN_RING, OWNING_PASS_UOPT_COLOR, STACK_HOME_RE } from "./view.js";

export const LEVER_SCHEMA = "decomp-workbench-lever-v1";
export const LEVER_STACK_HOME = "stack-home";
export const LEVER_TEMP_RING = "temp-ring";
export const LEVER_LINE_ORDER = "line-order";
export const LEVER_POOL_ROTATION = "pool-rotation";
export const LEVER_POOL_POPULATION = "pool-population";
export const LEVER_UNREACHABLE = "unreachable";
export const LEVER_NONE_KNOWN = "none-known";
export const LEVER_CLASS_VALUES = Object.freeze([LEVER_UNREACHABLE, LEVER_STACK_HOME, LEVER_TEMP_RING, LEVER_LINE_ORDER, LEVER_POOL_POPULATION, LEVER_POOL_ROTATION, LEVER_NONE_KNOWN]);
export const REACHABILITY_PROVEN = "proven";
export const REACHABILITY_UNREACHABLE = "unreachable";
export const FORCE_REACHABILITY_VALUES = Object.freeze([REACHABILITY_PROVEN, REACHABILITY_UNREACHABLE]);

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);
const has = (o, k) => (o instanceof Map ? o.has(k) : o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k));
const dget = (o, k, d = null) => {
  if (o === null || o === undefined) return d;
  if (typeof o.get === "function") { const v = o.get(k); return v === undefined ? d : v; }
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d;
};
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

/** One source edit, when it applies, and the target that proved it. */
export class EditFamily {
  constructor({ name, edit, discriminator, citation }) { Object.assign(this, { name, edit, discriminator, citation }); Object.freeze(this); }
  asDict() { return { family: this.name, edit: this.edit, discriminator: this.discriminator, citation: this.citation }; }
}

/** Why a residual is not a source edit, and what would reopen it. */
export class UnreachableProof {
  constructor({ name, proof, citation, reopens_when, precondition = "" }) { Object.assign(this, { name, proof, citation, reopens_when, precondition }); Object.freeze(this); }
  asDict() { return { unreachable_class: this.name, proof: this.proof, citation: this.citation, reopens_when: this.reopens_when, precondition: this.precondition }; }
}

export const CONSTRUCT_FIELD_THROUGH_LOCAL = "field-through-local";
export const CONSTRUCT_SCALED_INDEX = "scaled-index";
export const CONSTRUCT_FUSED_ACCUMULATE = "fused-accumulate";
export const CONSTRUCT_CONSTANT = "constant";
export const CONSTRUCT_UNCLASSIFIED = "unclassified";
export const CONSTRUCT_VALUES = Object.freeze([CONSTRUCT_FIELD_THROUGH_LOCAL, CONSTRUCT_SCALED_INDEX, CONSTRUCT_FUSED_ACCUMULATE, CONSTRUCT_CONSTANT, CONSTRUCT_UNCLASSIFIED]);

const COMMENT_RE = /\/\*.*?\*\/|\/\/.*$/g;
const ASSIGN_RE = /(?<![=!<>+\-*/%&|^])=(?!=)/;
const CAST_RE = /\(\s*[A-Za-z_][A-Za-z0-9_ *]*\)/g;
const LITERAL_RE = /^[-+~()\s]*(?:0[xX][0-9a-fA-F]+|\d+)[uUlLfF]*[-+*/|&^()\s0-9xXa-fA-FuUlL]*$/;
const SUBSCRIPT_RE = /\[([^\]]*)\]/g;
const MULTIPLY_RE = /[A-Za-z0-9_)\]]\s*\*/;

/** Name the construct on one line of C, for the pop-cost rules only. */
export function classifyConstruct(line) {
  let text = strip(line.replace(COMMENT_RE, ""));
  text = strip(text.replace(/;+$/, ""));
  if (!text) return CONSTRUCT_UNCLASSIFIED;
  const m = ASSIGN_RE.exec(text);
  const right = m ? strip(text.slice(m.index + m[0].length)) : text;
  if (!right) return CONSTRUCT_UNCLASSIFIED;
  for (const sm of right.matchAll(SUBSCRIPT_RE)) {
    if (sm[1].includes("*") || sm[1].includes("<<")) return CONSTRUCT_SCALED_INDEX;
  }
  const bare = strip(right.replace(CAST_RE, ""));
  if (MULTIPLY_RE.test(bare) && /[+\-]/.test(bare)) return CONSTRUCT_FUSED_ACCUMULATE;
  if (right.includes("->") || /[A-Za-z_0-9\])]\s*\.\s*[A-Za-z_]/.test(right)) return CONSTRUCT_FIELD_THROUGH_LOCAL;
  if (LITERAL_RE.test(bare)) return CONSTRUCT_CONSTANT;
  return CONSTRUCT_UNCLASSIFIED;
}

export const STACK_HOME_FAMILIES = Object.freeze([
  new EditFamily({
    name: "drop-a-declared-local",
    edit: "stop naming the value and repeat its expression at both uses, so it becomes a call-crossing common subexpression and is homed in the compiler-temp region instead of the declared one",
    discriminator: "the candidate frame is larger than the target's, or one homed value sits one word from the target's home with the frame equal",
    citation: "overlay34InitStorage, the reference campaign, 2026-09-03: 46/50 words to exact; the home moves sp+0x18 to sp+0x1C",
  }),
  new EditFamily({
    name: "reuse-an-existing-local-as-carrier",
    edit: "carry the value in a local that is already dead at that point instead of declaring a second one; the declared count falls by one and a later spill moves one slot, at an unchanged instruction count",
    discriminator: "the frames are equal and the displaced home moves by exactly one word while the instruction counts agree",
    citation: "func_overlay_026_F0000B18_187AF10, the reference campaign, 2026-09-03: 129/131 words to exact, 131 words on both sides; the spill moves sp+0x40 to sp+0x44",
  }),
  new EditFamily({
    name: "declare-the-pair-later",
    edit: "move the displaced declarations below the local whose slots they must follow; homes descend from the frame top in declaration order, so the fix is a position in the list and not a property of the values",
    discriminator: "the frames are equal and two or more adjacent homes are displaced by the same amount",
    citation: "overlay84InitializeAndUpdate, the reference campaign, 2026-09-03: 172/179 words to exact; the pair moves sp+0x4C/0x48 to sp+0x44/0x40",
  }),
]);

export const TEMP_RING_FAMILIES = Object.freeze([
  new EditFamily({
    name: "read-the-field-directly",
    edit: "read the struct field at its use instead of through a named local: a field read through a local costs one ring pop that a direct read does not",
    discriminator: "a source line whose pops exceed the target's ring advance names a local that only carries a field",
    citation: "overlay20UpdateObjectResource, the reference campaign, 2026-09-03: 90/98 words to exact, composed with the second family",
  }),
  new EditFamily({
    name: "scale-the-index-twice",
    edit: "type the table as pairs and index the pair, so the index is scaled twice; the second scale burns an invisible temp between the base load and the shift and costs one more pop than a single scale, at an unchanged instruction count",
    discriminator: "the candidate is one pop short of the target's ring advance at an indexed table read",
    citation: "overlay20UpdateObjectResource and func_overlay_070_F00000D8, the reference campaign, 2026-09-03: 165/171 words to exact on the second",
  }),
  new EditFamily({
    name: "split-the-accumulate",
    edit: "split a fused expression into a pool-carried accumulate -- `x = a;` then `x += b * c;` -- so the field stays in the coloured web instead of being loaded into a ring temp; the pop count moves with it",
    discriminator: "the pool lane differs in length as well as in content, so the residual is a web population difference and not a rotation",
    citation: "func_overlay_070_F00000D8, the reference campaign, 2026-09-03: the split makes the pool and fp lanes exact",
  }),
]);

export const CONSTRUCT_FAMILIES = Object.freeze({
  [CONSTRUCT_FIELD_THROUGH_LOCAL]: "read-the-field-directly",
  [CONSTRUCT_SCALED_INDEX]: "scale-the-index-twice",
  [CONSTRUCT_FUSED_ACCUMULATE]: "split-the-accumulate",
});

export const LINE_ORDER_FAMILIES = Object.freeze([
  new EditFamily({
    name: "join-the-initialiser-to-the-loop-header",
    edit: "put the initialiser on the loop header's physical line -- `count = 7; do {`, `entry = &table; do {` -- so the hoisted invariant, which carries the header's line, stops losing as1's minimised line key to a statement written above it",
    discriminator: "a line-order conflict whose earlier record is an initialiser and whose later record is a loop-invariant address",
    citation: "overlay40UpdateEntries, the reference campaign, 2026-09-02: 44/46 words to exact; func_overlay_047_F00009D0, 2026-09-03: 10 to 6 words, one join per loop",
  }),
  new EditFamily({
    name: "change-the-hoist-birth-order",
    edit: "spell the bound inline in the loop test instead of keeping it in a local, so it is hoisted after the count rather than before it; hoisted addresses are materialised in ugen's birth order and birth order follows source statement order",
    discriminator: "the preheader materialises several invariant addresses and the conflict is between two of them, not between an initialiser and one of them",
    citation: "func_overlay_014_F0000000, the reference campaign, 2026-09-03: 4 words to exact, composed with the line join",
  }),
]);

export const UNREACHABLE_PROOFS = Object.freeze({
  "as1-readiness": new UnreachableProof({
    name: "as1-readiness",
    proof: "the two instructions are separated by as1's readiness keys, not by their source lines. In a block of N pre-branch nodes whose branch becomes ready at cycle N-1, exactly one node is left over and a leftover node always wins the delay slot; reaching the target's fill needs one fewer or one more node in the block, which is an instruction-count change and not a placement change",
    citation: "overlay1FindNextAngle and its twin overlay1FindPreviousAngle (2 words each, 7 as1 traces and 3 full builds), overlay11UpdateMenu (every node in the block stamped with one line, so the line key has nothing to discriminate on), overlay33InitializeBuffers (the two nodes differ on aftercycles), overlay1ResolvePathPoint (equal aftercycles, decided on besttime) -- the reference campaign, 2026-09-02/03",
    reopens_when: "as1's besttime derivation is modelled, so a candidate's release order can be predicted instead of only observed",
    precondition: "an as1 trace in which every selection in scope is decided above the line key",
  }),
  "uopt-address-folding": new UnreachableProof({
    name: "uopt-address-folding",
    proof: "uopt reassociates an induction base against whichever live pointer it folds with, and the fold is insensitive to where the definition is written: moving the definition below the field stores, into the loop's init clause, and removing the local entirely all leave it intact, and one of those compiled byte-identically to the form it replaced",
    citation: "func_overlay_038_F0000000, the reference campaign, 2026-09-03: 7 words, of which 6 are the emission order that follows from the base",
    reopens_when: "a source shape exists in which the target pointer is not a constant offset from a live base at the point the induction variable is formed",
    precondition: "the two sides form one address from different base pointers, which two disassemblies do not distinguish from a colour difference -- check it by hand",
  }),
  "uopt-coalescing-tie-break": new UnreachableProof({
    name: "uopt-coalescing-tie-break",
    proof: "the web is coloured on a tie between the call's argument register and the return register, and the two locals the pool lane suggests merging are already coalesced -- merging them by hand produced a byte-identical object -- so no source form expresses the choice",
    citation: "overlay59PrepareEntry, the reference campaign, 2026-09-03: 9 words, one web at 7 sites",
    reopens_when: "a forced-colour oracle is available: an instrumented uopt carrying the CDX globalcolor profile, which decides the tie directly",
    precondition: "the colourer owns the residual and it is one consistent web substitution across its sites, between the registers a call takes its argument in and returns in",
  }),
  "cfe-pointer-add-order": new UnreachableProof({
    name: "cfe-pointer-add-order",
    proof: "at the mismatching pointer-add expression the shard records typed-pointer commutations, casts and assignment forms as exhausted. Byte-offset arithmetic is the one spelling that did move the temp order, and it is already retained: it takes the baseline's pointer/mask/scale to mask/scale/pointer, where the target wants mask/pointer/scale",
    citation: "levelFreeAll, the reference campaign, undated triage shard: 114/117 words after the retained rewrite, up from 112/117; 36/36 relocation offsets, types and identities exact; a fidelity-gated ugen source-line trace supplied the order. A resident function, not part of the overlay lever cohort",
    reopens_when: "a source form yields mask, pointer, scale -- the one order no tried spelling produced",
    precondition: "the residual is the temp order at a pointer add, which needs the expression in front of you -- check it by hand",
  }),
});

export const ARGUMENT_RETURN_REGISTERS = new Set(["v0", "v1", "a0", "a1", "a2", "a3"]);

function coalescingTieApplies(view) {
  if (view.webs.length !== 1) return false;
  const web = view.webs[0];
  return ARGUMENT_RETURN_REGISTERS.has(web.target) && ARGUMENT_RETURN_REGISTERS.has(web.candidate);
}

export const PROOF_PRECONDITIONS = Object.freeze({ "uopt-coalescing-tie-break": coalescingTieApplies });

export const PASS_PROOFS = Object.freeze({
  [OWNING_PASS_CFE]: ["cfe-pointer-add-order"],
  [OWNING_PASS_UOPT_COLOR]: ["uopt-coalescing-tie-break", "uopt-address-folding"],
  [OWNING_PASS_G0_SCHEDULER]: ["as1-readiness"],
});

export const CAPTURE_LADDER = "declared-local count: rebuild with CDX_SYMTAB=1 on the instrumented uopt and pass the log as --ladder (decomp-workbench frame-ladder reads the same file)";
export const CAPTURE_RING = "pops per source line: rebuild with DKWB_UGEN_TRACE=1 on a cc carrying instrument-ugen's free-list hooks and pass the log as --ring-trace";
export const CAPTURE_SOURCE = "the traced line's construct: pass the candidate's C with --source, so the pop-cost rule a line qualifies for is checked rather than assumed";
export const CAPTURE_EMIT = "line-order conflicts: rebuild with DKWB_UGEN_SCHED=1 on a cc carrying instrument-ugen --emit-provenance and pass the log as --emit-trace";
export const CAPTURE_AS1 = "as1 selection keys: rebuild the same compile with cc -Wa,-R and pass the assembler's trace as --as1-trace (no patched compiler; the object is byte-identical with -R on)";

export const POOL_ROTATION_FAMILIES = Object.freeze([
  new EditFamily({
    name: "store-site-truncation",
    edit: "declare the truncated local at its narrow type and drop the explicit cast, so the truncation happens at the STORE rather than in the expression: uopt numbers the synthetic truncation temp where the truncation is written, and a store is numbered LHS before RHS. Preconditions, both required and both measured: the value must not be passed on after the narrowing store (on `overlay4UpdateObjectMotion` the else-branch store to the local was dropped and the call result passed directly, an edit already proved byte-identical, so the `s16` store could not truncate a value the call still needed), and the truncation must survive cfe -- confirm it with a second capture",
    discriminator: "one of the webs in the residual is the synthetic intermediate of a two-step narrowing cast, which `CDX_DETAIL_WEB` reports as a type=4 expression web with no symbol",
    citation: "overlay4UpdateObjectMotion, the reference campaign, 2026-09-03: 8 differing words to 3, seven builds. Declaring `delta` as `s16` renumbered the truncation temp 48 -> 49 and closed both threshold webs, frame unchanged at -0x60, and the result reproduced byte-identically under the stock toolchain (sha1 8f11fe39ee5d)",
  }),
  new EditFamily({
    name: "change-the-save-cost",
    edit: "change the web's use count or its loop depth so its save crosses the boundary that orders it -- and expect the instruction stream to move with it, which is why this is ranked last",
    discriminator: "the two webs are NOT tied on save: p1 takes the largest save first and reads the web number only inside a tie group, so nothing that renumbers reorders them",
    citation: "overlay4UpdateObjectMotion, the reference campaign, 2026-09-03: the p1 selection order is saves 7.0, 4.0, 3.0, 2.0, 1.714 and then five webs tied at 1.5 taken in ascending web number, so a pair either side of a save boundary is out of numbering's reach",
  }),
]);

export const POOL_ROTATION_INERT = Object.freeze([
  "declaration order, for register-resident locals: swapping two `s32` declarations on overlay4UpdateObjectMotion was byte-identical",
  "relational operand order: cfe canonicalises it, so writing `threshold >= delta` for `delta <= threshold` was byte-identical and LHS-before-RHS does not apply at a comparison",
  "an added local: it shifts every downstream web number by a constant (22 -> 25, 48 -> 51, 50 -> 53) and never reorders a pair -- and it cost a stack home, 8 words to 22",
]);

export const CAPTURE_CDX = "the owning sweep: rebuild the TU with CDX_LOG=1 CDX_OUT=<file> on the instrumented uopt, scoped with CDX_PROC=<ordinal>, and pass the log as --ladder. p1 and p2 order their webs differently and take different levers, and two disassemblies do not say which owns a colour";
export const CAPTURE_FORCE = "reachability: pin the residual's webs with CDX_FORCE=p1:w<web>=c<colour> (comma-separated for a set) over the same compile, compare with the project's own comparison, and pass the resulting oracle sweep JSON as --force-result. words=0 proves every colour in the residual is legal in this web graph";
export const CONFIRM_CAPTURE = "a CONFIRMING second capture after the edit: re-run CDX_LOG=1 and check that the web numbers, or the saves, actually moved. Two spellings chosen from the numbering model on overlay4UpdateObjectMotion compiled byte-identically because cfe had already coalesced the store the model depended on, and one upstream web number shifted while none of the four in the residual did";

/** One coloured web, as the sweep that coloured it recorded it. */
export class SweepRecord {
  constructor({ phase, web, save, color, register, interference, forbidden, web_type = null, block = null }) {
    Object.assign(this, { phase, web, save, color, register, interference, forbidden, web_type, block });
    Object.freeze(this);
  }
  asDict() {
    return { phase: this.phase, web: this.web, save: this.save, color: this.color, register: this.register, interference: this.interference,
      forbidden: [...this.forbidden], web_type: this.web_type, block: this.block };
  }
}

function recordRegister(decision) {
  for (const key of ["actualreg", "bestreg"]) {
    const value = dget(decision.fields, key);
    if (value && value !== "?" && value !== "-") return value.startsWith("$") ? value.slice(1) : value;
  }
  return decision.assigned_register ?? null;
}

/** float(text) with the original's accepted spellings, null otherwise. */
function pyFloat(text) {
  const s = strip(String(text)).replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(s)) return Number(s);
  return null;
}

function floatField(decision, key) {
  const value = dget(decision.fields, key);
  if (value === null) return null;
  return pyFloat(value);
}

/** Read every coloured web out of a CDX log, in decision order. */
export function sweepRecords(log, { proc = null } = {}) {
  const records = [];
  for (const d of log.trace.allocatorWebs({ proc })) {
    const phase = d.phase_tag;
    if (phase !== "p1" && phase !== "p2") continue;
    records.push(new SweepRecord({ phase, web: d.web, save: floatField(d, "save"), color: d.assigned_color, register: recordRegister(d),
      interference: optionalInteger(dget(d.fields, "numintf")), forbidden: [...d.forbidden_colors],
      web_type: optionalInteger(dget(d.detail, "type")), block: optionalInteger(dget(d.detail, "bb")) }));
  }
  return records;
}

/** Group p1 webs by save: [[save, [webs...]], ...] ascending by save. */
export function tieGroups(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.phase !== "p1" || r.save === null) continue;
    if (!groups.has(r.save)) groups.set(r.save, []);
    groups.get(r.save).push(r.web);
  }
  return sorted([...groups.entries()], (e) => e[0]).map(([save, webs]) => [save, sorted(webs)]);
}

/** Read a recorded force experiment as a statement about the web graph. */
export function forceReachability(payload) {
  const rows = dget(payload, "results");
  if (!Array.isArray(rows) || !rows.length) return [null, []];
  const baseline = dget(payload, "baseline");
  let baselineInstructions = null;
  if (baseline && typeof baseline === "object" && !Array.isArray(baseline) && dget(baseline, "comparison") && typeof dget(baseline, "comparison") === "object" && !Array.isArray(dget(baseline, "comparison"))) {
    baselineInstructions = dget(dget(baseline, "comparison"), "candidate_instructions");
  }
  const notes = [];
  let best = null, declined = 0, added = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const force = dget(row, "force");
    const comparison = dget(row, "comparison");
    if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) { declined += 1; continue; }
    const words = dget(comparison, "words");
    const instructions = dget(comparison, "candidate_instructions");
    if (baselineInstructions !== null && isInt(instructions) && instructions > baselineInstructions) { added += 1; continue; }
    if (isInt(words)) {
      if (words === 0) {
        notes.push(`force ${pyStr(force)} reached words=0: every colour in the residual is legal in this web graph and the pass added no instruction`);
        return [REACHABILITY_PROVEN, notes];
      }
      best = best === null ? words : Math.min(best, words);
    }
  }
  if (declined || added) {
    notes.push(`${declined} force(s) declined by the pass and ${added} paid for in extra instructions, and none reached words=0`);
    return [REACHABILITY_UNREACHABLE, notes];
  }
  if (best !== null) notes.push(`${rows.length} force(s) recorded, best residual ${best} word(s): a measurement, not a proof -- neither words=0 nor a declined force`);
  return [null, notes];
}

export const FORCE_REACHABILITY_ADVICE = Object.freeze({
  [REACHABILITY_PROVEN]: "a recorded force reached words=0, so the whole residual is colours and every one of them is legal: what is missing is a source spelling, not a different web graph",
  [REACHABILITY_UNREACHABLE]: "the pass declined the force or paid for it in instructions, so the target's assignment is not available in this web graph and no renumbering reaches it -- a different web STRUCTURE is required",
});

export const READINESS_KEYS = new Set(["start-time", "besttime", "aftercycles", "latency"]);

/** The edit class one residual's evidence supports, and what it rests on. */
export class Lever {
  constructor({ lever_class, reason, family = null, unreachable = null, evidence = [], needs = [], measurements = {}, alternatives = [], see_also = [], reachability = null }) {
    Object.assign(this, { lever_class, reason, family, unreachable, evidence, needs, measurements, alternatives, see_also, reachability });
    Object.freeze(this);
  }
  asDict() {
    return {
      lever_class: this.lever_class, reason: this.reason, reachability: this.reachability,
      edit_family: this.family === null ? null : this.family.name,
      edit: this.family === null ? null : this.family.edit,
      citation: this.family === null ? null : this.family.citation,
      evidence: [...this.evidence], needs: [...this.needs], measurements: { ...this.measurements },
      alternatives: this.alternatives.map((a) => a.asDict()), see_also: this.see_also.map((p) => p.asDict()),
      unreachable: this.unreachable === null ? null : this.unreachable.asDict(),
    };
  }
}

/** Count GP (or fp) allocation results by source line: a Map line -> count, ascending. */
export function popsByLine(events, { proc = null, bank = "gp" } = {}) {
  if (bank !== "gp" && bank !== "fp") throw new ValueError("allocation bank must be gp or fp");
  const counts = new Map();
  for (const e of events) {
    if (allocationBank(e) !== bank || e.source_line === null) continue;
    if (proc !== null && e.procedure !== proc) continue;
    counts.set(e.source_line, (counts.get(e.source_line) ?? 0) + 1);
  }
  return new Map(sorted([...counts.entries()], (x) => x[0]));
}

function ringOrder(events, { proc = null } = {}) {
  const order = [];
  for (const e of events) {
    if (allocationBank(e) !== "gp" || e.register === null) continue;
    if (proc !== null && e.procedure !== proc) continue;
    order.push(registerName(e.register));
  }
  return order;
}

/** Tally which key decided each as1 selection: Map key -> count, sorted. */
export function readinessKeys(selections) {
  const tally = new Map();
  for (const s of selections) tally.set(s.tie, (tally.get(s.tie) ?? 0) + 1);
  return new Map(sorted([...tally.entries()], (x) => x[0]));
}

const tempLane = (view) => view.lanes.find((l) => l.classification === "temp") ?? null;
const poolLane = (view) => view.lanes.find((l) => l.classification === "pool") ?? null;

function findallGroup(re, text) {
  const g = new RegExp(re.source, "g" + re.flags.replace(/[gy]/g, ""));
  return [...text.matchAll(g)].map((m) => (m.length > 1 ? m[1] : m[0]));
}

function displacedHomes(view) {
  let rows = 0;
  const moved = new Set();
  for (const row of view.rows) {
    if (row.classification !== "constant") continue;
    const target = findallGroup(STACK_HOME_RE, row.target ?? "");
    const candidate = findallGroup(STACK_HOME_RE, row.candidate ?? "");
    if (target.length && candidate.length && !pyEq(target, candidate)) {
      rows += 1;
      for (let i = 0; i < Math.min(target.length, candidate.length); i++) {
        if (target[i] !== candidate[i]) moved.add(JSON.stringify([target[i], candidate[i]]));
      }
    }
  }
  return [rows, moved.size];
}

export const STACK_HOME_RANKING = Object.freeze([
  "a pool lane of unequal length: the side carrying the surplus web names the direction, because a value one side colours and the other homes is a declaration-list fact",
  "the frame delta: a whole 8-byte quantum in either direction",
  "the number of displaced homes: more than one is a position in the list rather than a count",
]);

function stackHomeLever(view, ladder, rows, homes) {
  const targetFrame = view.target_frame_size ?? null, candidateFrame = view.candidate_frame_size ?? null;
  const delta = targetFrame === null || candidateFrame === null ? null : Math.abs(candidateFrame) - Math.abs(targetFrame);
  const declared = ladder === null ? null : ladder.named.length;
  const pool = poolLane(view);
  const poolDelta = pool === null ? null : pool.candidate.length - pool.target.length;
  const measurements = {
    pool_lane_length_delta: poolDelta, target_frame_size: targetFrame, candidate_frame_size: candidateFrame, frame_delta: delta,
    frame_delta_words: delta === null ? null : Math.floor(delta / 4), declared_locals: declared, displaced_home_rows: rows,
    displaced_homes: homes, instruction_counts_agree: view.target_instructions === view.candidate_instructions,
  };
  const evidence = [];
  if (delta !== null) evidence.push(`frame: target ${Math.abs(targetFrame || 0)} bytes, candidate ${Math.abs(candidateFrame || 0)} bytes, delta ${signed(delta)}`);
  if (rows) evidence.push(`${rows} aligned row(s) differ only in a stack displacement, over ${homes} distinct home(s): a frame fact, not an immediate`);
  if (declared !== null) evidence.push(`frame ladder: ${declared} declared local slot(s) above the compiler-temp region`);
  if (poolDelta) {
    evidence.push(`pool lane differs in length by ${signed(poolDelta)}: the ` + (poolDelta > 0 ? "candidate" : "target")
      + " colours a web the other side does not, which is a declaration-list difference and outranks the frame arithmetic");
  }
  evidence.push("every declared local reserves a home whether or not it is register-coloured, and the declared block rounds up to 8 bytes: "
    + "measured over five builds on func_overlay_022_F0000000, 7 locals -> 0x58, 6 -> 0x58, 5 -> 0x50");
  let primary, reason;
  if (poolDelta) {
    primary = STACK_HOME_FAMILIES[poolDelta > 0 ? 0 : 2];
    reason = "the pool lane is " + (poolDelta > 0 ? "longer on the candidate, so it" : "shorter on the candidate, so the target")
      + " colours a web the other side does not; that names the declaration the list is wrong about, and lane evidence is ranked ahead of the frame arithmetic";
  } else if (delta !== null && delta > 0) {
    primary = STACK_HOME_FAMILIES[0];
    reason = "the candidate's frame is larger than the target's by at least one 8-byte quantum, so the candidate homes something the target "
      + "does not -- how many declarations that is depends on where the block already sat, and the frame is the measurement, not the declaration count";
  } else if (delta !== null && delta < 0) {
    primary = STACK_HOME_FAMILIES[2];
    reason = "the target's frame is larger than the candidate's by at least one 8-byte quantum, so the target homes something the candidate "
      + "does not -- read the family below in reverse, adding a declaration rather than moving one";
  } else if (homes > 1) {
    primary = STACK_HOME_FAMILIES[2];
    reason = "the frames agree and more than one home is displaced, which is a position in the declaration list rather than a count";
  } else {
    primary = STACK_HOME_FAMILIES[1];
    reason = "the frames agree and one home is displaced at an unchanged instruction count, which is one declaration too many";
  }
  const needs = [];
  if (declared === null) needs.push(CAPTURE_LADDER);
  if (delta === null) needs.push("frame sizes: neither prologue exposed an immediate frame adjustment, so the count half of this diagnosis is unmeasured");
  return new Lever({ lever_class: LEVER_STACK_HOME, reason, family: primary, evidence, needs, measurements,
    alternatives: STACK_HOME_FAMILIES.filter((f) => f.name !== primary.name) });
}

const familyNamed = (name) => TEMP_RING_FAMILIES.find((f) => f.name === name);

function tracedConstructs(counts, source) {
  if (source === null) return new Map();
  const out = new Map();
  for (const line of counts.keys()) out.set(line, classifyConstruct(line > 0 && line <= source.length ? source[line - 1] : ""));
  return out;
}

function tempRingLever(view, ringEvents, proc, source = null) {
  const temp = tempLane(view), pool = poolLane(view);
  const measurements = {
    target_temp_lane: temp !== null ? [...temp.target] : null,
    candidate_temp_lane: temp !== null ? [...temp.candidate] : null,
    temp_lane_rotation: temp === null ? null : temp.rotation,
    temp_lane_length_delta: temp === null ? null : temp.candidate.length - temp.target.length,
    pool_lane_length_delta: pool === null ? null : pool.candidate.length - pool.target.length,
    pops_by_line: null, pop_total: null, ring_order: null, constructs_by_line: null,
  };
  const evidence = [];
  if (temp !== null && temp.rotation !== null && temp.rotation !== undefined) {
    evidence.push(`temp lane rotates by ${signed(temp.rotation)} from slot ${pyStr(temp.divergence)}; this is an observed register-lane difference, not an independently measured queue-pop count`);
  }
  const lengths = measurements.pool_lane_length_delta;
  if (lengths) evidence.push(`pool lane differs in length by ${signed(lengths)} emitted definitions; this does not count allocator webs or prove a class crossing`);
  if (ringEvents === null) {
    return new Lever({ lever_class: LEVER_TEMP_RING,
      reason: "the residual is a ring rotation, and which construct bought or sold the pop is a property of the free-list trace, not of the disassembly",
      evidence, needs: [CAPTURE_RING], measurements, alternatives: TEMP_RING_FAMILIES });
  }
  const allRing = [...ringEvents];
  const scoped = allRing.filter((e) => proc === null || e.procedure === proc);
  const counts = popsByLine(scoped, { proc });
  const order = ringOrder(scoped, { proc });
  measurements.pops_by_line = Object.fromEntries([...counts].map(([l, c]) => [String(l), c]));
  measurements.pop_total = [...counts.values()].reduce((a, b) => a + b, 0);
  measurements.ring_order = order;
  const ALLOC = ["allocate", "allocation-request", "unsupported-allocation"];
  measurements.allocation_event_counts = Object.fromEntries(counter(scoped.filter((e) => ALLOC.includes(e.action)).map((e) => dget(e.fields, "_event") ?? e.action)).entries());
  measurements.fp_results_by_line = Object.fromEntries([...popsByLine(scoped, { bank: "fp" })].map(([l, c]) => [String(l), c]));
  measurements.pop_metric_basis = "GP allocation result events, not proven FIFO dequeues";
  const issues = allocationIssues(scoped);
  const allocationEvents = allRing.filter((e) => ALLOC.includes(e.action));
  if (proc === null && new Set(allocationEvents.map((e) => e.procedure)).size > 1) issues.push("mixed procedure evidence requires an explicit procedure");
  if (proc !== null && allocationEvents.some((e) => e.procedure === null)) issues.push("unscoped allocation evidence cannot be assigned to the selected procedure");
  const gpEvents = scoped.filter((e) => allocationBank(e) === "gp");
  const gpRing = new Set([8, 9, 10, 11, 12, 13, 14, 15, 24, 25]);
  if (gpEvents.some((e) => !gpRing.has(e.register))) issues.push("GP results include registers outside the supported temporary ring");
  if (scoped.some((e) => e.action === "move-end" && gpRing.has(e.register))) issues.push("GP queue controls require a richer replay model");
  if (!gpEvents.length) issues.push("no GP allocation result evidence for the selected procedure");
  if (gpEvents.some((e) => e.source_line === null)) issues.push("GP results lack source-line evidence");
  if (gpEvents.some((e) => e.object_row === null)) issues.push("GP results lack a measured emitted-index/object-row calibration");
  try {
    const replay = replayFifo(scoped, { procedure: proc, registers: gpRing });
    measurements.gp_fifo_valid = replay.valid;
    measurements.gp_fifo_violations = replay.violations.length;
    if (!replay.valid) issues.push("GP FIFO replay is invalid; shallow helper events do not prove queue transitions");
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    issues.push(e.message);
  }
  if (issues.length) {
    measurements.trace_evidence_issues = issues;
    return new Lever({ lever_class: LEVER_TEMP_RING, reason: "allocation results are diagnostic only: " + issues.join("; "), evidence, measurements,
      needs: ["capture supported GP queue transitions and a measured source/object emission join"], alternatives: TEMP_RING_FAMILIES });
  }
  const doubled = [...counts].filter(([, c]) => c > 1).map(([l]) => l);
  if (doubled.length) {
    evidence.push("source line(s) " + doubled.join(", ") + " consume more than one pop each; a line whose pops exceed the target's ring advance is the statement to edit");
  }
  const charged = doubled.length ? doubled : sorted([...counts.keys()]);
  const constructs = tracedConstructs(counts, source);
  let named;
  if (constructs.size) {
    measurements.constructs_by_line = Object.fromEntries(sorted([...constructs], (x) => x[0]).map(([l, v]) => [String(l), v]));
    named = sorted([...new Set(charged.filter((l) => has(CONSTRUCT_FAMILIES, constructs.get(l))).map((l) => CONSTRUCT_FAMILIES[constructs.get(l)]))]);
    evidence.push("charged line construct(s): " + charged.map((l) => `${l} ${constructs.get(l) ?? "?"}`).join(", "));
  } else named = [];
  const rotation = measurements.temp_lane_rotation;
  let primary = null, needs = [], reason;
  if (source === null) {
    reason = "the pop counts are read and the line to edit is named, but which pop-cost rule that line qualifies for is a property of "
      + "the construct on it, and no source was supplied to check one";
    needs = [CAPTURE_SOURCE];
  } else if (!named.length) {
    reason = "the charged line(s) hold no construct with a measured pop cost -- " + charged.map((l) => `${l} is ${constructs.get(l) ?? "?"}`).join(", ")
      + " -- so no family below applies to them, and the nearest one is not an answer";
  } else if (named.length > 1) {
    reason = "the charged lines hold more than one construct with a measured pop cost (" + named.join(", ") + "), so which of them carries "
      + "the residual is not decided by the counts alone";
  } else if ((rotation === null || rotation === undefined) && !lengths) {
    reason = "the construct on the charged line names a rule, but no temp lane rotated and the pool lane is the same length, so which way "
      + "the ring runs against the target is unmeasured";
    needs = ["a temp-lane rotation: compare against a target disassembly in which the temp lane diverges, so the sign of the rotation names whether the edit buys a pop or sells one"];
  } else {
    primary = familyNamed(named[0]);
    const selected = charged.find((l) => (CONSTRUCT_FAMILIES[constructs.get(l) ?? ""] ?? null) === named[0]);
    const direction = lengths
      ? "the pool lane differs in length, so the residual is a web population difference before it is a rotation"
      : rotation !== null && rotation !== undefined && rotation < 0
        ? "the candidate is short of the target's ring advance, so the edit must buy a pop"
        : "the candidate spends a pop the target does not, so the edit must sell one";
    reason = `${direction}; line ${selected} is a ${constructs.get(selected)}, which is the construct ${primary.name} was measured on`;
  }
  return new Lever({ lever_class: LEVER_TEMP_RING, reason, family: primary, needs,
    evidence: [...evidence, "two pops off means two of these, and either alone is a large regression: overlay20UpdateObjectResource measured 25 "
      + "differing words on the direct field read alone and exact with the double scale composed onto it"],
    measurements, alternatives: TEMP_RING_FAMILIES.filter((f) => primary === null || f.name !== primary.name) });
}

export const CAPTURE_DETAIL = "which web carries the site: re-run with CDX_DETAIL_WEB=<web>, whose records name each web's basic block. The block is what identifies a web; the `line=` field reports the same line for every web in the procedure and identifies nothing";

function substitutions(view) {
  const out = new Map();
  for (const w of view.webs) if (w.candidate && w.target && w.candidate !== w.target) out.set(w.candidate, w.target);
  return out;
}

function residualPair(records, subs) {
  const pairs = sorted([...subs.entries()]);
  if (pairs.length !== 2 || pairs[0][1] !== pairs[1][0] || pairs[1][1] !== pairs[0][0]) {
    return [null, "the residual is not a two-register transposition, so the records do not name a pair of contesting webs"];
  }
  const holders = new Map();
  for (const r of records) {
    if (r.register !== null && subs.has(r.register)) {
      if (!holders.has(r.register)) holders.set(r.register, []);
      holders.get(r.register).push(r);
    }
  }
  const ambiguous = [...holders].filter(([, found]) => found.length > 1).map(([reg, found]) => [reg, found.map((i) => i.web)]);
  if (ambiguous.length) {
    const rendered = sorted(ambiguous, (x) => x[0]).map(([reg, webs]) => `${reg} is held by webs ` + sorted(webs).join(", ")).join("; ");
    return [null, `more than one coloured web holds a register in the residual (${rendered}), so which of them carries these sites is not in the decision records`];
  }
  const missing = sorted([...subs.keys()].filter((k) => !holders.has(k)));
  if (missing.length) {
    return [null, "the log records no coloured web on " + missing.join(", ")
      + ", so the sweep that owns the residual is not in this capture -- check CDX_PROC selected the right procedure ordinal"];
  }
  const [first, second] = sorted([...holders.entries()], (x) => x[0]).map(([, found]) => found[0]);
  return [[first, second], `webs ${first.web} and ${second.web} hold the two registers the residual exchanges`];
}

function visitDirection(pair, subs) {
  const ranked = [];
  for (const r of pair) {
    const register = r.register ?? "";
    const desired = colorForRegister(subs.get(register) ?? "");
    if (desired === null || desired === undefined) {
      return [null, null, `the colour of ${pyStr(subs.has(register) ? subs.get(register) : null)} is not in the pinned colour table, so the two sides cannot be ordered`];
    }
    ranked.push([desired, r]);
  }
  const ordered = sorted(ranked, (x) => x[0]);
  const earlier = ordered[0][1], later = ordered[1][1];
  return [earlier, later, `under p2's lowest-free-colour rule web ${earlier.web} must take colour c${ordered[0][0]} and web ${later.web} colour c${ordered[1][0]}, `
    + `so web ${earlier.web} would have to be visited first -- today it is ` + (earlier.web < later.web ? "already" : "not")
    + " the lower-numbered of the two. This is a reading of the numbering rule and no recorded edit has yet reordered a pair"];
}

const saveText = (v) => (v === null || v === undefined ? "None" : floatRepr(v));

function poolLever(view, log, force, proc) {
  const pool = poolLane(view);
  const target = pool !== null ? [...pool.target] : [];
  const candidate = pool !== null ? [...pool.candidate] : [];
  const delta = candidate.length - target.length;
  const subs = substitutions(view);
  const [reachability, forceNotes] = force !== null ? forceReachability(force) : [null, []];
  const measurements = {
    target_pool_lane: [...target], candidate_pool_lane: [...candidate], target_pool_slots: target.length, candidate_pool_slots: candidate.length,
    pool_lane_length_delta: delta, substitutions: Object.fromEntries(sorted([...subs.entries()])), owning_sweep: null, sweep_decisions: null,
    tie_group: null, move_earlier: null, move_later: null, reachability,
  };
  if (delta) {
    const surplus = delta < 0 ? "target" : "candidate";
    return new Lever({ lever_class: LEVER_POOL_POPULATION,
      reason: `the pool lanes are ${target.length} and ${candidate.length} slots long: the ${surplus} has ${Math.abs(delta)} additional emitted `
        + "definition(s), not a rotation of equal sequences. This is not a count of distinct colored webs and does not prove "
        + "which values cross into temporary allocation",
      evidence: ["lane lengths describe emitted assignments; authenticate allocator webs and reservations before claiming a population change",
        "on overlay43FilterImage (the reference campaign, 2026-09-03) the same shape -- 18 target slots against 15 -- was recorded as a rotation; "
          + "forcing the four-web rotation to the target's colours improved 33 words to 26 and raised opcode mismatches from 8 to 10",
        ...forceNotes],
      needs: [CAPTURE_RING], measurements, reachability });
  }
  if (log === null) {
    return new Lever({ lever_class: LEVER_POOL_ROTATION,
      reason: `the pool lanes are the same length (${target.length} slots) and their contents differ; equal lengths alone do not prove `
        + "a cyclic rotation or equal web populations. Which sweep coloured these webs is a property of the allocator's own "
        + "records and not of two disassemblies, and p1 and p2 take different levers",
      evidence: ["p2, the caller-saved sweep, visits webs in ascending web number and gives each the lowest free colour; p1, the "
        + "callee-saved sweep, is repeated max-save selection with ascending web number only as the tie-break", ...forceNotes],
      needs: [CAPTURE_CDX, ...(force === null ? [CAPTURE_FORCE] : [])], measurements, alternatives: POOL_ROTATION_FAMILIES, reachability });
  }
  const records = sweepRecords(log, { proc });
  const involved = records.filter((r) => r.register !== null && subs.has(r.register));
  const sweeps = sorted([...new Set(involved.map((r) => r.phase))]);
  const owning = sweeps.length === 1 ? sweeps[0] : sweeps.length ? "mixed" : null;
  measurements.owning_sweep = owning;
  measurements.sweep_decisions = Object.fromEntries(["p1", "p2"].map((p) => [p, records.filter((r) => r.phase === p).length]));
  measurements.involved_webs = involved.map((r) => r.asDict());
  const [pair, note] = residualPair(involved, subs);
  const evidence = [`pool lanes equal at ${target.length} emitted definition(s); this does not by itself prove equal allocator-web populations`, note, ...forceNotes];
  const needs = [];
  let family = null;
  if (owning === null) {
    evidence.unshift("no coloured web in this capture holds a register the residual substitutes");
    needs.push(CAPTURE_CDX);
  } else if (owning === "mixed") {
    evidence.unshift("the residual's registers were coloured in BOTH sweeps, which order on different things: p2 on the web number alone, p1 on "
      + "the save with the web number only as a tie-break");
  } else {
    evidence.unshift(`the residual's registers were coloured in ${owning}, ` + (owning === "p2"
      ? "which visits webs in ascending web number and gives each the lowest free colour -- save cost is inert there, measured as "
        + "bestcost=0.000000 on every decision of overlay43FilterImage and overlay60ReassignChoiceSlots while the saves ranged 3.7 to 1400.0"
      : "which takes the largest save each round and reads the web number only to break a tie"));
  }
  if (pair !== null && owning === "p2") {
    const [earlier, later, directionNote] = visitDirection(pair, subs);
    evidence.push(directionNote);
    if (earlier !== null && later !== null) { measurements.move_earlier = earlier.web; measurements.move_later = later.web; }
  } else if (pair !== null && owning === "p1") {
    evidence.push("no direction is named: it would follow from lowest-free-colour, which is recorded for p2 and not for p1");
  }
  let tied = false;
  if (owning === "p1" && pair !== null) {
    for (const [save, webs] of tieGroups(records)) {
      if (webs.includes(pair[0].web) && webs.includes(pair[1].web)) {
        tied = true;
        measurements.tie_group = { save, webs: [...webs] };
        evidence.push(`webs ${pair[0].web} and ${pair[1].web} are in the same p1 tie group: save ${saveText(save)}, members ` + webs.join(", ")
          + ", which p1 orders by web number. A tie is the tie-break and not by itself a lever: webs 13 and 22 of overlay4UpdateObjectMotion "
          + "tie at save 1.5 with identical interference records, do not interfere, and are recorded not colour-reachable");
        break;
      }
    }
    if (!tied) {
      evidence.push(`webs ${pair[0].web} and ${pair[1].web} are not tied on save (${saveText(pair[0].save)} against ${saveText(pair[1].save)}), so p1's max-save `
        + "selection orders them and no renumbering reorders them");
    }
  }
  if (pair !== null && owning === "p1" && !tied) family = POOL_ROTATION_FAMILIES[1];
  else if (pair !== null && (owning === "p1" || owning === "p2")) {
    const blocked = pair.filter((r) => { const c = colorForRegister(subs.get(r.register ?? "") ?? ""); return r.forbidden.includes(c); });
    if (blocked.length) {
      evidence.push("the colour the residual wants is in the interference mask of web " + blocked.map((r) => r.web).join(", ")
        + ", so the pass would decline it: this is not a numbering residual");
    } else if (pair.some((r) => r.web_type === 4)) family = POOL_ROTATION_FAMILIES[0];
    else {
      evidence.push("neither web is a type=4 expression web, and the one measured renumbering spelling was measured on the synthetic "
        + "temp of a narrowing cast; naming it here would apply a rule to a shape it was never measured on");
    }
  }
  if (pair === null) needs.push(CAPTURE_DETAIL);
  if (force === null) needs.push(CAPTURE_FORCE);
  if (family !== null) needs.push(CONFIRM_CAPTURE);
  let reason;
  if (family !== null) {
    reason = `the pool lanes are equal at ${target.length} slot(s) and the residual's webs were coloured in ${owning}, where `
      + (owning === "p2" ? "the visit order is the web number" : tied ? "a tie on save leaves the web number as the only order" : "the saves differ, so only the cost reorders them")
      + `; ${note}`;
  } else if (pair !== null) {
    reason = `the rotation is real and the records name the pair it is between, but no measured source spelling applies to these webs; ${note}`;
  } else {
    reason = `the pool lanes are equal in length, so the residual is a rotation, and ${note}`;
  }
  return new Lever({ lever_class: LEVER_POOL_ROTATION, reason, family, evidence, needs: [...new Set(needs)], measurements,
    alternatives: POOL_ROTATION_FAMILIES.filter((f) => family === null || f.name !== family.name), reachability });
}

function lineOrderLever(view, emitEvents, proc) {
  const measurements = { line_order_conflicts: null, first_conflict: null };
  if (emitEvents === null) {
    return new Lever({ lever_class: LEVER_LINE_ORDER,
      reason: "the residual is an ordering of instructions the target also emits, and whether their lines separate them is a property of ugen's emit records",
      needs: [CAPTURE_EMIT, CAPTURE_AS1], measurements, alternatives: LINE_ORDER_FAMILIES });
  }
  const scoped = emitEvents.filter((e) => proc === null || e.proc === proc);
  const conflicts = lineOrderConflicts(scoped);
  measurements.line_order_conflicts = conflicts.length;
  measurements.first_conflict = conflicts.length ? conflicts[0] : null;
  if (!conflicts.length) {
    return new Lever({ lever_class: LEVER_NONE_KNOWN,
      reason: "the emit trace holds no adjacent instruction pair whose lines could reverse their order, so nothing here is "
        + "separated by a line stamp and the join has nothing to join",
      evidence: [`${scoped.length} emit record(s) read, 0 line-order conflicts`], measurements, needs: [CAPTURE_AS1] });
  }
  const first = conflicts[0];
  return new Lever({ lever_class: LEVER_LINE_ORDER,
    reason: "an adjacent instruction pair is emitted in one order and stamped with lines that put it in the other, which is the pair as1's minimised line key decides",
    family: LINE_ORDER_FAMILIES[0],
    evidence: [`${conflicts.length} line-order conflict(s); the first is proc ${first.proc} block ${first.block}, emit ${first.earlier.emit} at line ${first.earlier.line} `
      + `before emit ${first.later.emit} at line ${first.later.line} (gap ${first.line_gap})`,
      "a loop-invariant hoisted into a preheader carries the loop header's line, so every initialiser written above the loop wins the line key with no dependence edge behind it"],
    measurements, alternatives: [LINE_ORDER_FAMILIES[1]] });
}

function as1Lever(selections) {
  const tally = readinessKeys(selections);
  const measurements = { selections: selections.length, deciding_keys: Object.fromEntries(tally) };
  let readiness = 0;
  for (const [k, c] of tally) if (READINESS_KEYS.has(k)) readiness += c;
  const byLine = tally.get("lineno") ?? 0;
  if (byLine) {
    return new Lever({ lever_class: LEVER_LINE_ORDER,
      reason: "as1 decided at least one selection in this scope on the source line, which is the one key in its chain with a source lever attached",
      family: LINE_ORDER_FAMILIES[0], evidence: [`${byLine} of ${selections.length} selection(s) decided on lineno`], measurements,
      alternatives: [LINE_ORDER_FAMILIES[1]] });
  }
  if (readiness && readiness === selections.length) {
    return new Lever({ lever_class: LEVER_UNREACHABLE,
      reason: "every selection in this scope was decided above the line key, on readiness or on the critical path, and no statement placement changes either",
      unreachable: UNREACHABLE_PROOFS["as1-readiness"],
      evidence: [`${readiness} of ${selections.length} selection(s) decided on ` + [...tally].filter(([k]) => READINESS_KEYS.has(k)).map(([k, c]) => `${k} (${c})`).join(", ")],
      measurements });
  }
  return null;
}

/**
 * Name the source-edit class this residual's evidence supports.
 * @param {any} view MechanismView
 * @param {{ladder?: any, cdx_log?: any, force_result?: any, ring_events?: any[]|null, emit_events?: any[]|null, as1_selections?: any[]|null, source?: string[]|null, proc?: number|null}} [opts]
 */
export function leverFor(view, { ladder = null, cdx_log = null, force_result = null, ring_events = null, emit_events = null, as1_selections = null, source = null, proc = null } = {}) {
  if (as1_selections && as1_selections.length) {
    const decided = as1Lever(as1_selections);
    if (decided !== null) return decided;
  }
  const [rows, homes] = displacedHomes(view);
  const tf = view.target_frame_size ?? null, cf = view.candidate_frame_size ?? null;
  const framesDiffer = tf !== null && cf !== null && tf !== cf;
  const owning = view.owning_pass;
  if (framesDiffer || rows || owning === OWNING_PASS_STACK_HOME) return stackHomeLever(view, ladder, rows, homes);
  if (view.playbook === "register-role-audit" && !(view.evidence !== null && view.evidence !== undefined && view.evidence.decisive)) {
    const observed = (ring_events ?? []).filter((e) => allocationBank(e) === "gp" && (proc === null || e.procedure === proc)).map((e) => e.register);
    return new Lever({ lever_class: LEVER_NONE_KNOWN,
      reason: "possible-color and temporary roles overlap; neither a lane rotation nor a filtered replay proves reservation or demand-order causality",
      measurements: { observed_gp_results: observed, observation_scope_proc: proc, complete_reservation_state: null, target_reservation_state_proved: false },
      needs: ["authenticate per-side reservation metadata and complete GP events before choosing a pop or coloring intervention"] });
  }
  if (owning === OWNING_PASS_UGEN_RING) return tempRingLever(view, ring_events, proc, source);
  if (owning === OWNING_PASS_G0_SCHEDULER || emit_events !== null) return lineOrderLever(view, emit_events, proc);
  const pool = poolLane(view);
  const rotated = pool !== null && !pyEq([...pool.target], [...pool.candidate]);
  const unequal = pool !== null && pool.target.length !== pool.candidate.length;
  if (owning === OWNING_PASS_UOPT_COLOR && unequal) return poolLever(view, cdx_log, force_result, proc);
  const proofs = (has(PASS_PROOFS, owning) ? PASS_PROOFS[owning] : []).map((n) => UNREACHABLE_PROOFS[n]);
  const measurements = { owning_pass: owning, displaced_home_rows: rows, webs: view.webs.length };
  const met = proofs.filter((p) => has(PROOF_PRECONDITIONS, p.name) && PROOF_PRECONDITIONS[p.name](view));
  if (met.length === 1) {
    const settled = met[0];
    return new Lever({ lever_class: LEVER_UNREACHABLE,
      reason: `the owning pass reads ${owning} and the residual has the shape ${settled.name} was measured on: ${settled.precondition}`,
      unreachable: settled,
      evidence: [`${view.webs.length} consistent web substitution(s) over ${view.webs.reduce((a, w) => a + w.count, 0)} site(s)`],
      measurements, see_also: proofs.filter((p) => p !== settled) });
  }
  if (owning === OWNING_PASS_UOPT_COLOR && rotated) return poolLever(view, cdx_log, force_result, proc);
  return new Lever({ lever_class: LEVER_NONE_KNOWN,
    reason: `no lever class is supported by this evidence: the owning pass reads ${owning}, the frames agree, and no home, ring or line-order measurement is present`,
    needs: [CAPTURE_RING, CAPTURE_EMIT, CAPTURE_AS1], measurements, see_also: proofs });
}

/** Render the lever block as the lines `diagnose` prints under MECHANISM. */
export function formatLever(lever) {
  const lines = [`lever: ${lever.lever_class} -- ${lever.reason}`];
  if (lever.reachability !== null) lines.push(`  reachability: ${lever.reachability} -- ` + FORCE_REACHABILITY_ADVICE[lever.reachability]);
  if (lever.family !== null) { lines.push(`  edit (${lever.family.name}): ${lever.family.edit}`); lines.push(`  proved on: ${lever.family.citation}`); }
  if (lever.unreachable !== null) {
    lines.push(`  unreachable (${lever.unreachable.name}): ${lever.unreachable.proof}`);
    lines.push(`  measured on: ${lever.unreachable.citation}`);
    lines.push(`  reopens when: ${lever.unreachable.reopens_when}`);
  }
  for (const l of lever.evidence) lines.push(`  evidence: ${l}`);
  for (const l of lever.needs) lines.push(`  capture: ${l}`);
  for (const f of lever.alternatives) lines.push(`  or (${f.name}) when ${f.discriminator}`);
  for (const p of lever.see_also) {
    lines.push(`  see also (${p.name}): ${p.proof}`);
    if (p.precondition) lines.push(`    applies when: ${p.precondition}`);
  }
  return lines;
}
