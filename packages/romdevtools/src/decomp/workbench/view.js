// view.js - the aligned mechanism view: LCS alignment, class lanes, and
// hunk taxonomy. Every count here is an ALIGNED count, never a positional
// one: positional diffing turns one upstream register-role swap into dozens
// of phantom scattered differences.
//
// Two alignment passes (a longest-matching-block sequence matcher with no
// junk heuristic), then classification:
//   1. anchor on normalized instruction text;
//   2. inside each unmatched region, pair by opcode, so an operand-level
//      difference is classified rather than shown as delete beside insert;
//   3. classify every pair: register, commutative-order, constant,
//      relocation, displacement, or match.
// Register lanes come from the WHOLE aligned stream, matching rows included.
//
// Plain JS ESM + JSDoc.

import {
  frameSize, isCommutativeSwap, registerOperands, relocationFieldMask,
} from "./compare.js";
import { nextSteps, passLawSteps } from "./field-guide.js";
import { comparable, comparePoolAccesses, poolAccesses } from "./literal-pool.js";
import { IDO53_GP_SEED, IDO53_SHARED_GP, RegisterReservations } from "./register-state.js";
import { VIEW_METRICS_BY_KEY } from "./schema.js";
import { COLOR_REGISTERS } from "./globalcolor.js";
import { PassEvidence } from "./pass-evidence.js";
import { SequenceMatcher } from "./difflib.js";
import { ValueError, sorted, pyMod, pyInt, hex, strip, splitWs, strRepr, match as reMatch } from "./py.js";

export { PassEvidence };

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

const keysOf = (m) => (m instanceof Map || (m && typeof m.keys === "function" && typeof m.get === "function")) ? [...m.keys()] : Object.keys(m);
const valuesOf = (m) => (m instanceof Map || (m && typeof m.values === "function" && typeof m.get === "function")) ? [...m.values()] : Object.values(m);
const lookup = (m, k) => { const v = typeof m.get === "function" ? m.get(k) : m[k]; return v === undefined ? null : v; };
const contains = (coll, x) => (coll instanceof Set || (coll && typeof coll.has === "function")) ? coll.has(x) : coll.includes(x);
const sizeOf = (m) => (m === null || m === undefined) ? 0 : typeof m.size === "number" ? m.size : Array.isArray(m) ? m.length : Object.keys(m).length;
const arrEq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const get0 = (o, k) => o[k] ?? 0;
const trunc32 = (x) => x >>> 0;

/** The mask pair a relocation field mask returns: [mask, unknownKinds]. */
function fieldMask(instruction) {
  const r = relocationFieldMask(instruction);
  return Array.isArray(r) ? r : [r.mask, r.unknown];
}

/** Opcode-sequence alignment with no junk heuristic, as `get_opcodes()` lists it. */
export function sequenceOpcodes(a, b) {
  return new SequenceMatcher(a, b, { autojunk: false }).getOpcodes();
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Every key the human and JSON renderings are allowed to print. */
export function schemaKeys() { return new Set(keysOf(VIEW_METRICS_BY_KEY)); }

// ---------------------------------------------------------------------------
// Register class tables (per-compiler-era profile data)
// ---------------------------------------------------------------------------

/** The pre-probe table, kept verbatim: the conservative default. */
export const UNVERIFIED_CLASSES = Object.freeze({
  "pool": Object.freeze(["v0", "v1", "a0", "a1", "a2", "a3", "t0", "t1", "t2", "t3", "t4", "t5"]),
  "temp": Object.freeze(["t6", "t7", "t8", "t9", "s8"]),
});

/** IDO 5.3 -O2 -mips2, temp tables in ugen free-list (ring) order. */
export const IDO53_CLASSES = Object.freeze({
  "pool": Object.freeze(["v0", "v1", "a0", "a1", "a2", "a3", "s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]),
  "temp": Object.freeze(["t6", "t7", "t8", "t9"]),
  "shared": IDO53_SHARED_GP,
  "fp-pool": Object.freeze(["f0", "f2", "f12", "f14", "f16", "f18", "f20", "f22", "f24"]),
  "fp-temp": Object.freeze(["f4", "f6", "f8", "f10"]),
});

export const REGISTER_CLASS_PROFILES = Object.freeze({ "ido53": IDO53_CLASSES, "unverified": UNVERIFIED_CLASSES });

export const REGISTER_PROFILE_EVIDENCE = Object.freeze({
  "ido53": "IDO 5.3 -O2 -mips2, probed color map and instrumented ugen; "
    + "t0-t5 have shared possible roles, with per-procedure reservations "
    + "required to identify the effective GP ring. The float ring is the "
    + "four registers ugen "
    + "actually hands out (f16/f18 are initialized into ffree, withdrawn "
    + "before the first allocation, and are uopt colors)",
  "unverified": "pre-probe table, not measured against any single release; the "
    + "conservative choice for a compiler with no probe of its own",
});

export const DEFAULT_REGISTER_PROFILE = "ido53";

/** Opcodes whose first register operand is a source, not a destination. */
export const NO_DESTINATION_OPCODES = Object.freeze(new Set([
  "b", "bal", "bc1f", "bc1fl", "bc1t", "bc1tl", "beq", "beql", "beqz", "bgez", "bgezal", "bgezl", "bgtz", "bgtzl",
  "blez", "blezl", "bltz", "bltzal", "bltzl", "bne", "bnel", "bnez", "break", "cache", "ctc1", "ddiv", "ddivu", "div",
  "divu", "dmtc1", "dmult", "dmultu", "j", "jal", "jalr", "jr", "mtc0", "mtc1", "mthi", "mtlo", "mult", "multu", "nop",
  "sb", "sc", "scd", "sd", "sdc1", "sdc2", "sdl", "sdr", "sh", "sw", "swc1", "swc2", "swl", "swr", "sync", "syscall",
  "teq", "tne",
]));

export const SYMBOL_OPERAND_RE = /\b([0-9a-fA-F]+)\s+<([^>]+)>/g;
export const IMMEDIATE_RE = /(?<![A-Za-z0-9_$.])-?(?:0x[0-9a-fA-F]+|\d+)\b/g;
export const SELF_BRANCH_OPCODES = Object.freeze(new Set(["b", "j", "bal"]));
export const BARE_DESTINATION_RE = /(?<=[\s,])(0x)?([0-9a-fA-F]+)\s*$/;
export const JUMP_OPCODES = Object.freeze(new Set(["j", "jal", "jalx"]));
export const ALIGNED_TARGET = "@row";

export const MATCH = "match";
export const DISPLACEMENT = "displacement";
export const STRUCTURAL = "structural";
export const SCHEDULE = "schedule";
export const REGISTER = "register";
export const CONSTANT = "constant";
export const COMMUTATIVE = "commutative";
export const RELOCATION = "relocation";
export const POOL = "pool";
export const POOL_LAYOUT = "pool_layout";

export const CLASS_ORDER = Object.freeze([MATCH, DISPLACEMENT, STRUCTURAL, SCHEDULE, REGISTER, CONSTANT, COMMUTATIVE, RELOCATION, POOL, POOL_LAYOUT]);
export const POOL_RELABEL_FROM = Object.freeze(new Set([RELOCATION, CONSTANT]));
export const MIXED_PRECEDENCE = Object.freeze([CONSTANT, STRUCTURAL, SCHEDULE, COMMUTATIVE, REGISTER]);
export const RESIDUAL_CLASSES = Object.freeze([STRUCTURAL, SCHEDULE, REGISTER, CONSTANT, COMMUTATIVE]);

export const ROUTING_PERMUTER_FIRST = "permuter-first";
export const ROUTING_STRUCTURAL = "structural";
export const ROUTING_IMPORT_FIX = "import-fix";
export const ROUTING_NONE = "none";
export const ROUTING_EVIDENCE_FIRST = "evidence-first";
export const ROUTING_VALUES = Object.freeze([ROUTING_EVIDENCE_FIRST, ROUTING_PERMUTER_FIRST, ROUTING_STRUCTURAL, ROUTING_IMPORT_FIX, ROUTING_NONE]);

export const PERMUTER_ROUTING_SENTENCE = "no HAND lever found -- this is a permuter target; run the sweep before "
  + "concluding a wall.";

export const PERMUTER_ROUTING_STEPS = Object.freeze([
  PERMUTER_ROUTING_SENTENCE,
  "decomp-workbench permute-doctor FUNCTION, then permute-sweep QUEUE. An "
    + "allocation or schedule tie is a search problem; record it as a wall only "
    + "after a measured search has been flat (permute classify).",
  "law L69: a permuter that finds nothing instantly is a setup fault, not a "
    + "hard function -- decomp-workbench guide laws ido53 L69",
]);

export const PERMUTER_ROUTED_VERDICTS = Object.freeze(new Set(["allocation", "phase-shift", "register-permutation", "register-ring-only", "schedule"]));
export const PERMUTER_ROUTED_CLASSES = Object.freeze(new Set([REGISTER, SCHEDULE]));

export const OWNING_PASS_CFE = "cfe-spelling";
export const OWNING_PASS_LOAD_FORM = "rodata-load-form";
export const OWNING_PASS_STACK_HOME = "stack-home-assignment";
export const OWNING_PASS_UOPT_COLOR = "uopt-globalcolor";
export const OWNING_PASS_UGEN_RING = "ugen-temp-ring";
export const OWNING_PASS_G0_SCHEDULER = "g0-scheduler";
export const OWNING_PASS_NONE = "none";
export const OWNING_PASS_UNKNOWN = "unknown";
export const OWNING_PASS_VALUES = Object.freeze([OWNING_PASS_CFE, OWNING_PASS_LOAD_FORM, OWNING_PASS_STACK_HOME, OWNING_PASS_UOPT_COLOR,
  OWNING_PASS_UGEN_RING, OWNING_PASS_G0_SCHEDULER, OWNING_PASS_NONE, OWNING_PASS_UNKNOWN]);

export const REACHABILITY_SOURCE = "source-reachable";
export const REACHABILITY_PERMUTER = "permuter-target";
export const REACHABILITY_PASS_OWNED = "pass-owned";
export const REACHABILITY_UNKNOWN = "unknown";
export const REACHABILITY_VALUES = Object.freeze([REACHABILITY_SOURCE, REACHABILITY_PERMUTER, REACHABILITY_PASS_OWNED, REACHABILITY_UNKNOWN]);

export const BASIS_TRACE = "trace";
export const BASIS_HEURISTIC = "heuristic";
export const BASIS_NONE = "none";
export const BASIS_VALUES = Object.freeze([BASIS_TRACE, BASIS_HEURISTIC, BASIS_NONE]);

export const REACHABILITY_ADVICE = Object.freeze({
  [REACHABILITY_SOURCE]: "a source edit reaches this decision; the levers above are the "
    + "family, and the law under them says what the pass will do about it",
  [REACHABILITY_PERMUTER]: "an allocation, colour or schedule tie with no single named source "
    + "lever -- this is what a randomized search is for",
  [REACHABILITY_PASS_OWNED]: "no handle this evidence exposes reaches the decision -- NOT a wall: "
    + "run the search before recording one, and let permute classify say "
    + "whether it was flat",
  [REACHABILITY_UNKNOWN]: "nothing here settles which pass owns this; fix the inputs, or supply a trace",
});

/**
 * Where this residual should be taken next.
 * @param {string} verdict
 * @param {Record<string, number>} counts
 * @param {string[]} [warnings]
 * @param {string|null} [reachability]
 */
export function routingFor(verdict, counts, warnings = [], reachability = null) {
  if (warnings.length) return ROUTING_IMPORT_FIX;
  if (verdict === "exact" || verdict === "words-identical") return ROUTING_NONE;
  if (reachability === REACHABILITY_UNKNOWN && lookup(counts, REGISTER)) return ROUTING_EVIDENCE_FIRST;
  if (reachability === REACHABILITY_PASS_OWNED) return ROUTING_PERMUTER_FIRST;
  if (PERMUTER_ROUTED_VERDICTS.has(verdict)) return ROUTING_PERMUTER_FIRST;
  if (verdict.startsWith("mixed(")) {
    const primary = primaryClass(counts);
    if (PERMUTER_ROUTED_CLASSES.has(primary)) return ROUTING_PERMUTER_FIRST;
  }
  return ROUTING_STRUCTURAL;
}

/** Which pass owns a residual, how close source gets, and how we know. */
export class Ownership {
  /** @param {{owning_pass: string, reachability: string, basis: string, reason: string}} fields */
  constructor({ owning_pass, reachability, basis, reason }) {
    Object.assign(this, { owning_pass, reachability, basis, reason });
    Object.freeze(this);
  }
  asDict() { return { owning_pass: this.owning_pass, reachability: this.reachability, ownership_basis: this.basis }; }
  /** The footer lines this ownership owes its reader. */
  get steps() {
    if (this.basis === BASIS_NONE) return [];
    const advice = REACHABILITY_ADVICE[this.reachability] ?? "";
    return [
      `owning pass: ${this.owning_pass} (${this.basis}) -- ${this.reason}`,
      `reachability: ${this.reachability} -- ${advice}`,
      ...passLawSteps(this.owning_pass),
    ];
  }
}

const own = (owning_pass, reachability, basis, reason) => new Ownership({ owning_pass, reachability, basis, reason });

export const SOURCE_REACHABLE_PASSES = Object.freeze(new Set([OWNING_PASS_CFE, OWNING_PASS_LOAD_FORM, OWNING_PASS_STACK_HOME]));
export const STACK_HOME_RE = /(-?(?:0x)?[0-9a-fA-F]+)\(\$?sp\)/;
export const POOL_LOAD_OPCODES = Object.freeze(new Set(["lwc1", "ldc1", "l.s", "l.d"]));
export const STATEMENT_LOAD_OPCODES = Object.freeze(new Set(["lui", "ori", "li", "mtc1", "addiu", "dmtc1"]));

function opcodeOf(text) {
  return text ? strip(text.replaceAll("\t", " ")).split(" ")[0].toLowerCase() : "";
}

/** How many differing rows differ only in an `N(sp)` displacement. */
function stackHomeRows(rows) {
  let total = 0;
  for (const row of rows) {
    if (row.classification !== CONSTANT) continue;
    const t = STACK_HOME_RE.exec(row.target || "");
    const c = STACK_HOME_RE.exec(row.candidate || "");
    if (!t || !c) continue;
    if (t[1] !== c[1]) total += 1;
  }
  return total;
}

/** Whether one side pool-loads a float the other materialises. */
function loadFormSplit(rows) {
  const pooled = new Set(), statement = new Set();
  for (const row of rows) {
    if (!row.reported) continue;
    for (const [side, text] of [["target", row.target], ["candidate", row.candidate]]) {
      const opcode = opcodeOf(text);
      if (POOL_LOAD_OPCODES.has(opcode)) pooled.add(side);
      else if (STATEMENT_LOAD_OPCODES.has(opcode)) statement.add(side);
    }
  }
  return pooled.size > 0 && statement.size > 0 && [...pooled].every((s) => !statement.has(s));
}

/**
 * The pass that owns this residual and how close source gets.
 */
export function ownershipFor(verdict, rows, lanes, webs, register_profile = DEFAULT_REGISTER_PROFILE, warnings = [], evidence = null) {
  if (warnings.length) {
    return own(OWNING_PASS_UNKNOWN, REACHABILITY_UNKNOWN, BASIS_NONE,
      "the two sides were not comparable, so nothing here is evidence "
      + "about a pass");
  }
  if (verdict === "exact" || verdict === "words-identical") return own(OWNING_PASS_NONE, REACHABILITY_UNKNOWN, BASIS_NONE, "no residual to own");
  if (evidence !== null && evidence !== undefined && evidence.decisive) return ownershipFromEvidence(evidence);

  if (gpRoleUncertain(webs, register_profile) && primaryClass(countsOf(rows)) === REGISTER) {
    return own(OWNING_PASS_UNKNOWN, REACHABILITY_UNKNOWN, BASIS_HEURISTIC,
      "GP register substitutions do not distinguish UOPT reservations "
      + "from UGEN demand/lifetime changes. A possible color is not an "
      + "actual colored use, and a lane rotation does not prove a changed pop");
  }
  if (verdict === "frame-layout") {
    return own(OWNING_PASS_STACK_HOME, REACHABILITY_SOURCE, BASIS_HEURISTIC,
      "the whole residual is the prologue/epilogue frame adjustment");
  }
  if (loadFormSplit(rows)) {
    return own(OWNING_PASS_LOAD_FORM, REACHABILITY_SOURCE, BASIS_HEURISTIC,
      "one side loads a float from the pool where the other "
      + "materialises it -- a load-form difference, decided by the "
      + "constant's value");
  }
  const homes = stackHomeRows(rows);
  const reported = rows.filter((r) => r.reported).length;
  if (homes && homes === reported) {
    return own(OWNING_PASS_STACK_HOME, REACHABILITY_SOURCE, BASIS_HEURISTIC,
      `all ${homes} differing rows differ only in an N(sp) `
      + "displacement, which is a frame home and not an immediate");
  }
  if (verdict === "phase-shift" || verdict === "register-ring-only") {
    const rotating = lanes.some((lane) => lane.rotation);
    if (rotating) {
      return own(OWNING_PASS_UGEN_RING, REACHABILITY_SOURCE, BASIS_HEURISTIC,
        "a lane rotates by a whole number of slots, so the residual "
        + "is one ring pop and not a set of register choices");
    }
    return own(OWNING_PASS_UGEN_RING, REACHABILITY_PASS_OWNED, BASIS_HEURISTIC,
      "every target register is one no colouring hands out, and no "
      + "lane rotation explains them -- a web-existence decision inside "
      + "ugen, with no phase left to shift");
  }
  if (verdict === "register-permutation" || verdict === "allocation" || verdict.startsWith("mixed(")) {
    const primary = primaryClass(countsOf(rows));
    if (verdict.startsWith("mixed(") && !PERMUTER_ROUTED_CLASSES.has(primary)) {
      return own(OWNING_PASS_CFE, REACHABILITY_SOURCE, BASIS_HEURISTIC,
        `the dominant class is ${primary === null ? "None" : primary}, which the front end `
        + "emitted from the source as written");
    }
    if (primary === SCHEDULE) {
      return own(OWNING_PASS_G0_SCHEDULER, REACHABILITY_PERMUTER, BASIS_HEURISTIC,
        "the dominant class is a pure reordering, which the "
        + "instruction scheduler chose");
    }
    const unreachable = uncolorableTargets(webs, register_profile);
    if (webs.length && unreachable.length === webs.length) {
      return own(OWNING_PASS_UGEN_RING, REACHABILITY_PASS_OWNED, BASIS_HEURISTIC,
        "every target register is a ring temp, which no colouring "
        + "outcome reaches");
    }
    return own(OWNING_PASS_UOPT_COLOR, REACHABILITY_PERMUTER, BASIS_HEURISTIC,
      "consistent register substitutions over registers the colouring "
      + "pass does hand out");
  }
  if (verdict === "schedule") {
    return own(OWNING_PASS_G0_SCHEDULER, REACHABILITY_PERMUTER, BASIS_HEURISTIC,
      "every differing row is a pure reordering; the instructions "
      + "themselves agree");
  }
  return own(OWNING_PASS_CFE, REACHABILITY_SOURCE, BASIS_HEURISTIC,
    `a ${verdict} residual is what the front end emitted from the `
    + "source as written");
}

function ownershipFromEvidence(evidence) {
  if (evidence.contested_allocation || evidence.force_declined) {
    const which = evidence.contested_allocation ? "regsleft=0 at the decision" : "a forced colour was declined";
    return own(OWNING_PASS_UOPT_COLOR, REACHABILITY_PASS_OWNED, BASIS_TRACE,
      `${which}: the register was taken, not underpriced, so no `
      + "reweighting lever wins it");
  }
  if (evidence.ring_pop_divergence) {
    return own(OWNING_PASS_UGEN_RING, REACHABILITY_SOURCE, BASIS_TRACE,
      "the trace's free-list records diverge at a pop, and a pop has a "
      + "source line");
  }
  return own(OWNING_PASS_G0_SCHEDULER, REACHABILITY_PASS_OWNED, BASIS_TRACE,
    "the trace places the differing instruction in a different schedule "
    + "slot, and a ready instruction's slot is not addressable from source");
}

function countsOf(rows) {
  const counts = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  return counts;
}

/** One row of the LCS alignment, with its operand-level classification. */
export class AlignedRow {
  constructor({ index, classification, target_index = null, candidate_index = null, target = null, candidate = null,
    target_address = null, candidate_address = null, target_registers = [], candidate_registers = [], substitutions = [] }) {
    Object.assign(this, { index, classification, target_index, candidate_index, target, candidate, target_address,
      candidate_address, target_registers, candidate_registers, substitutions });
    Object.freeze(this);
  }
  get matched() { return this.classification === MATCH; }
  get reported() { return this.classification !== MATCH && this.classification !== DISPLACEMENT && this.classification !== POOL; }
}

const byteRange = (v) => (v === null || v === undefined ? null : [`0x${hex(v[0])}`, `0x${hex(v[1])}`]);

/** A contiguous run of non-matching aligned rows. */
export class Hunk {
  constructor({ hunk, classification, start, end, target_range, candidate_range, target_bytes, candidate_bytes, classes }) {
    Object.assign(this, { hunk, classification, start, end, target_range, candidate_range, target_bytes, candidate_bytes, classes });
    Object.freeze(this);
  }
  asDict() {
    return {
      hunk: this.hunk, class: this.classification, rows: [this.start, this.end],
      target: this.target_range ? [...this.target_range] : null,
      candidate: this.candidate_range ? [...this.candidate_range] : null,
      target_bytes: byteRange(this.target_bytes), candidate_bytes: byteRange(this.candidate_bytes),
      classes: { ...this.classes },
    };
  }
}

/** A per-class register assignment sequence, matching instructions included. */
export class Lane {
  constructor({ classification, target, candidate, target_rows, candidate_rows, divergence, divergence_row, rotation }) {
    Object.assign(this, { classification, target, candidate, target_rows, candidate_rows, divergence, divergence_row, rotation });
    Object.freeze(this);
  }
  asDict() {
    return { class: this.classification, target: [...this.target], candidate: [...this.candidate], rows: [...this.target_rows],
      slot: this.divergence, aligned_row: this.divergence_row, rotation: this.rotation };
  }
}

/** One consistent register substitution across the aligned stream. */
export class Web {
  constructor({ web, target, candidate, count, rows }) {
    Object.assign(this, { web, target, candidate, count, rows });
    Object.freeze(this);
  }
  asDict() { return { web: this.web, target: this.target, candidate: this.candidate, count: this.count, rows: [...this.rows] }; }
  /** Whether no coloring outcome can put a value in this target register. */
  ringOnlyTarget(register_profile = DEFAULT_REGISTER_PROFILE) { return uncolorableTargets([this], register_profile).length > 0; }
}

/** The aligned mechanism view of one target/candidate pair. */
export class MechanismView {
  constructor({ symbol, target, candidate, register_profile, target_instructions, candidate_instructions, target_frame_size,
    candidate_frame_size, counts, verdict, playbook, signature, prefix_exact, rows, hunks, lanes, webs, guidance,
    warnings = [], pool = null, evidence = null, target_reservations = null, candidate_reservations = null }) {
    Object.assign(this, { symbol, target, candidate, register_profile, target_instructions, candidate_instructions,
      target_frame_size, candidate_frame_size, counts, verdict, playbook, signature, prefix_exact, rows, hunks, lanes,
      webs, guidance, warnings, pool, evidence, target_reservations, candidate_reservations });
    Object.freeze(this);
  }
  get aligned_rows() { return this.rows.length; }
  get ownership() {
    return ownershipFor(this.verdict, this.rows, this.lanes, this.webs, this.register_profile, this.warnings, this.evidence);
  }
  get owning_pass() { return this.ownership.owning_pass; }
  get reachability() { return this.ownership.reachability; }
  get routing() { return routingFor(this.verdict, this.counts, this.warnings, this.ownership.reachability); }
  get register_first_divergence() { return this.signature.includes("register-first-divergence"); }
  registerReport() {
    return this.rows.map((row) => ({ index: row.index, class: row.classification, target: [...row.target_registers], candidate: [...row.candidate_registers] }));
  }
  /** @param {{report_regs?: boolean}} [opts] */
  asDict({ report_regs = false, reportRegs = undefined } = {}) {
    if (reportRegs !== undefined) report_regs = reportRegs;
    const payload = {
      symbol: this.symbol, target: this.target, candidate: this.candidate, register_profile: this.register_profile,
      register_reservations: {
        target: this.target_reservations !== null ? this.target_reservations.asDict() : null,
        candidate: this.candidate_reservations !== null ? this.candidate_reservations.asDict() : null,
        ownership_basis: "conditional lane projection only; no inferred reservations or target trace",
      },
      register_profile_evidence: REGISTER_PROFILE_EVIDENCE[this.register_profile] ?? "unknown profile",
      target_instructions: this.target_instructions, candidate_instructions: this.candidate_instructions,
      aligned_rows: this.aligned_rows, target_frame_size: this.target_frame_size, candidate_frame_size: this.candidate_frame_size,
      verdict: this.verdict, playbook: this.playbook, routing: this.routing,
      ...this.ownership.asDict(),
      signature: [...this.signature], prefix_exact: this.prefix_exact,
      hunks: this.hunks.map((h) => h.asDict()), lanes: this.lanes.map((l) => l.asDict()), webs: this.webs.map((w) => w.asDict()),
      ring_only_targets: uncolorableTargets(this.webs, this.register_profile).map((w) => w.target),
      next: [...this.guidance], warnings: [...this.warnings],
    };
    for (const name of CLASS_ORDER) payload[name] = this.counts[name] ?? 0;
    payload.pool_resolution = this.pool !== null ? this.pool.resolution : null;
    payload.pool_slots = this.pool !== null ? [this.pool.target_slots, this.pool.candidate_slots] : null;
    if (report_regs) payload.register_report = this.registerReport();
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function addressIndex(instructions) {
  const m = new Map();
  instructions.forEach((item, index) => m.set(item.address, index));
  return m;
}

/** Comparison text with alignment-relative branch destinations. */
export function normalizedText(instruction, { address_index, row_of_index }) {
  const relocated = instruction.relocations.length > 0;
  const opcode = instruction.opcode;
  const selfBranch = SELF_BRANCH_OPCODES.has(opcode) || opcode.startsWith("b");
  const localDestination = selfBranch ? (instruction.local_branch_destination ?? null) : null;

  const resolved = (address, name) => {
    const index = address_index.get(address);
    if (index === undefined) return name ? `<${name}>` : `<0x${hex(address)}>`;
    const row = row_of_index.get(index);
    return row !== undefined ? `${ALIGNED_TARGET}${row}` : `@insn${index}`;
  };
  const relocationName = () => {
    const names = sorted([...new Set(instruction.relocations.filter((r) => r.symbol).map((r) => r.symbol))]);
    return names.length ? `<${names.join(",")}>` : "<relocated>";
  };
  const replace = (_m, g1, g2) => {
    const name = g2;
    if (localDestination !== null) return resolved(localDestination, null);
    if (relocated) {
      if (selfBranch || JUMP_OPCODES.has(opcode)) return relocationName();
      return `<${name.split("+")[0]}>`;
    }
    if (!selfBranch) return `<${name.split("+")[0]}>`;
    return resolved(parseInt(g1, 16), name);
  };
  let text = instruction.assembly.replace(SYMBOL_OPERAND_RE, replace);
  if (selfBranch || JUMP_OPCODES.has(opcode)) {
    const bare = BARE_DESTINATION_RE.exec(text);
    if (bare) {
      const token = localDestination !== null ? resolved(localDestination, null)
        : relocated ? relocationName()
        : selfBranch ? resolved(parseInt(bare[2], 16), null)
        : `<0x${hex(parseInt(bare[2], 16))}>`;
      text = text.slice(0, bare.index) + token;
    }
  }
  return text.replaceAll("$", "");
}

const relocationSignature = (ins) => ins.relocations.map((r) => [r.kind, r.symbol ?? null]);
const relocationKindSignature = (ins) => ins.relocations.map((r) => r.kind);
const sigEq = (a, b) => a.length === b.length && a.every((x, i) => (Array.isArray(x) ? x[0] === b[i][0] && x[1] === b[i][1] : x === b[i]));

/** Whether the two words agree outside linker-controlled bits. */
function relocationEquivalent(target, candidate) {
  const [tm, tu] = fieldMask(target);
  const [cm, cu] = fieldMask(candidate);
  if (tu.length || cu.length) return false;
  const keep = trunc32(~(tm | cm));
  return trunc32(target.word_value & keep) === trunc32(candidate.word_value & keep);
}

function immediates(text) {
  return text.replace(SYMBOL_OPERAND_RE, "SYM").match(IMMEDIATE_RE) ?? [];
}

/** The register an instruction defines, or null. */
export function destinationRegister(assembly) {
  if (!assembly) return null;
  const opcode = splitWs(assembly, 1)[0];
  if (NO_DESTINATION_OPCODES.has(opcode) || opcode.startsWith("c.")) return null;
  const operands = registerOperands(assembly);
  return operands.length ? operands[0] : null;
}

/** Classify one aligned instruction pair by the cheapest explanation. */
export function classifyPair(target, candidate, { target_text, candidate_text }) {
  if (target_text === candidate_text) {
    if (target.word === candidate.word && sigEq(relocationSignature(target), relocationSignature(candidate))) return MATCH;
    if (target_text.includes(ALIGNED_TARGET)) return DISPLACEMENT;
    if (relocationEquivalent(target, candidate)) return RELOCATION;
    return STRUCTURAL;
  }
  const tr = registerOperands(target.assembly);
  const cr = registerOperands(candidate.assembly);
  if (!arrEq(tr, cr)) {
    if (isCommutativeSwap(target, candidate)) return COMMUTATIVE;
    return REGISTER;
  }
  if (!arrEq(immediates(target_text), immediates(candidate_text))) {
    if (arrEq(relocationKindSignature(target), relocationKindSignature(candidate)) && relocationEquivalent(target, candidate)) return RELOCATION;
    return CONSTANT;
  }
  return STRUCTURAL;
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/** The text an instruction is anchored on during alignment. */
export function alignmentKey(instruction) {
  return instruction.assembly.replace(SYMBOL_OPERAND_RE, (_m, _g1, g2) => `<${g2.split("+")[0]}>`).replaceAll("$", "");
}

function skeleton(target, candidate) {
  const to = target.map((i) => i.opcode), co = candidate.map((i) => i.opcode);
  if (target.length === candidate.length && arrEq(to, co)) return target.map((_, index) => ["equal", index, index]);
  const tk = target.map(alignmentKey), ck = candidate.map(alignmentKey);
  const anchored = pair(tk, ck, to, co);
  const best = alignmentScore(anchored, tk, ck);
  if (best[0] === Math.min(target.length, candidate.length)) return anchored;
  const alternative = pair(to, co, tk, ck);
  const alt = alignmentScore(alternative, tk, ck);
  if (alt[0] > best[0] || (alt[0] === best[0] && alt[1] > best[1])) return alternative;
  return anchored;
}

function alignmentScore(rows, tk, ck) {
  let identical = 0;
  for (const [, ti, ci] of rows) if (ti !== null && ci !== null && tk[ti] === ck[ci]) identical++;
  return [identical, -rows.length];
}

function pair(tp, cp, ts, cs) {
  const rows = [];
  for (const [tag, t0, t1, c0, c1] of sequenceOpcodes(tp, cp)) {
    if (tag === "equal") { for (let off = 0; off < t1 - t0; off++) rows.push(["equal", t0 + off, c0 + off]); continue; }
    rows.push(...pairWithin(ts.slice(t0, t1), cs.slice(c0, c1), t0, c0));
  }
  return rows;
}

function pairWithin(target, candidate, targetOffset, candidateOffset) {
  const rows = [];
  for (const [tag, t0, t1, c0, c1] of sequenceOpcodes(target, candidate)) {
    const width = tag === "equal" ? t1 - t0 : Math.max(t1 - t0, c1 - c0);
    for (let off = 0; off < width; off++) {
      const ti = t0 + off, ci = c0 + off;
      rows.push([tag, ti < t1 ? targetOffset + ti : null, ci < c1 ? candidateOffset + ci : null]);
    }
  }
  return rows;
}

function substitutionsOf(tr, cr) {
  if (tr.length !== cr.length) return [];
  const out = [];
  for (let i = 0; i < tr.length; i++) if (tr[i] !== cr[i]) out.push([tr[i], cr[i]]);
  return out;
}

// ---------------------------------------------------------------------------
// Lanes, webs, and signatures
// ---------------------------------------------------------------------------

function registerClass(register, profile) {
  for (const [name, members] of Object.entries(profile)) if (members.includes(register)) return name;
  return null;
}

export const MINIMUM_ROTATION_CYCLE = 3;
export const MINIMUM_ROTATION_SLOTS = 3;

function rotationCycle(members, observed) {
  const positions = [];
  members.forEach((name, index) => { if (observed.has(name)) positions.push(index); });
  if (positions.length < MINIMUM_ROTATION_CYCLE) return null;
  for (let k = 0; k < positions.length; k++) if (positions[k] !== positions[0] + k) return null;
  return positions.map((i) => members[i]);
}

function laneRotation(target, candidate, cycle, start) {
  if (target.length !== candidate.length || !cycle.length || start >= target.length) return null;
  if (target.length - start < MINIMUM_ROTATION_SLOTS) return null;
  const size = cycle.length;
  const order = new Map(cycle.map((name, index) => [name, index]));
  const offsets = new Set();
  for (let slot = start; slot < target.length; slot++) {
    const left = order.get(target[slot]), right = order.get(candidate[slot]);
    if (left === undefined || right === undefined) return null;
    offsets.add(pyMod(right - left, size));
  }
  if (offsets.size !== 1) return null;
  const offset = [...offsets][0];
  return offset || null;
}

function buildLanes(rows, profile, targetReservations = null, candidateReservations = null) {
  const projection = (state) => {
    if (state === null || state === undefined) return profile;
    return { ...profile, "pool": [...profile["pool"], ...state.reserved], "temp": state.temp_ring, "shared": [] };
  };
  const targetProfile = projection(targetReservations);
  const candidateProfile = projection(candidateReservations);
  const names = Object.keys(profile);
  const targetLanes = Object.fromEntries(names.map((n) => [n, []]));
  const candidateLanes = Object.fromEntries(names.map((n) => [n, []]));
  for (const row of rows) {
    for (const [assembly, bucket, sideProfile] of [[row.target, targetLanes, targetProfile], [row.candidate, candidateLanes, candidateProfile]]) {
      if (assembly === null) continue;
      const register = destinationRegister(assembly);
      if (register === null) continue;
      const name = registerClass(register, sideProfile);
      if (name !== null) bucket[name].push([register, row.index]);
    }
  }
  const lanes = [];
  for (const name of names) {
    const ts = targetLanes[name].map((x) => x[0]), cs = candidateLanes[name].map((x) => x[0]);
    const tr = targetLanes[name].map((x) => x[1]), cr = candidateLanes[name].map((x) => x[1]);
    if (!ts.length && !cs.length) continue;
    let divergence = null;
    for (let slot = 0; slot < Math.max(ts.length, cs.length); slot++) {
      const left = slot < ts.length ? ts[slot] : null, right = slot < cs.length ? cs[slot] : null;
      if (left !== right) { divergence = slot; break; }
    }
    let divergenceRow = null;
    if (divergence !== null) {
      const cands = [tr, cr].filter((r) => divergence < r.length).map((r) => r[divergence]);
      divergenceRow = cands.length ? Math.min(...cands) : null;
    }
    const cycle = ((name === "temp" || name === "fp-temp" || profile === UNVERIFIED_CLASSES)
      && arrEq(targetProfile[name], candidateProfile[name]))
      ? rotationCycle(targetProfile[name], new Set([...ts, ...cs])) : null;
    const rotation = divergence === null || cycle === null ? null : laneRotation(ts, cs, cycle, divergence);
    lanes.push(new Lane({ classification: name, target: ts, candidate: cs, target_rows: tr, candidate_rows: cr,
      divergence, divergence_row: divergenceRow, rotation }));
  }
  return lanes;
}

function buildWebs(rows) {
  const order = [];
  const sites = new Map();
  for (const row of rows) {
    if (row.classification !== REGISTER && row.classification !== COMMUTATIVE) continue;
    const seen = new Set();
    for (const p of row.substitutions) {
      const k = `${p[0]}\u0000${p[1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!sites.has(k)) { sites.set(k, []); order.push(p); }
      sites.get(k).push(row.index);
    }
  }
  return order.map((p, i) => {
    const r = sites.get(`${p[0]}\u0000${p[1]}`);
    return new Web({ web: `w${i + 1}`, target: p[0], candidate: p[1], count: r.length, rows: r });
  });
}

export const COLORABLE_CLASSES = Object.freeze(["pool", "fp-pool"]);

/** Every register the era's coloring pass can hand out (a possible palette). */
export function colorableRegisters(register_profile = DEFAULT_REGISTER_PROFILE) {
  const profile = REGISTER_CLASS_PROFILES[register_profile] ?? REGISTER_CLASS_PROFILES[DEFAULT_REGISTER_PROFILE];
  const result = new Set();
  for (const name of COLORABLE_CLASSES) for (const r of profile[name] ?? []) result.add(r);
  if (register_profile === "ido53") for (const r of valuesOf(COLOR_REGISTERS)) result.add(r);
  return result;
}

function gpRoleUncertain(webs, profile) {
  return profile === "ido53" && webs.some((w) => IDO53_GP_SEED.includes(w.target) || IDO53_GP_SEED.includes(w.candidate));
}

/** The substitutions whose TARGET register no coloring can reach. */
export function uncolorableTargets(webs, register_profile = DEFAULT_REGISTER_PROFILE) {
  const colorable = colorableRegisters(register_profile);
  const profile = REGISTER_CLASS_PROFILES[register_profile] ?? REGISTER_CLASS_PROFILES[DEFAULT_REGISTER_PROFILE];
  return webs.filter((w) => registerClass(w.target, profile) !== null && !colorable.has(w.target));
}

function consistentPermutation(webs) {
  if (!webs.length) return false;
  const forward = new Map(), backward = new Map();
  for (const w of webs) {
    if (!forward.has(w.target)) forward.set(w.target, w.candidate);
    if (forward.get(w.target) !== w.candidate) return false;
    if (!backward.has(w.candidate)) backward.set(w.candidate, w.target);
    if (backward.get(w.candidate) !== w.target) return false;
  }
  return true;
}

function prefixExact(rows) {
  for (const row of rows) {
    if ([MATCH, RELOCATION, DISPLACEMENT, POOL].includes(row.classification)) continue;
    return row.index;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verdict and guidance
// ---------------------------------------------------------------------------

function phaseShift(lanes) {
  const diverging = lanes.filter((l) => l.divergence !== null);
  if (!diverging.length) return false;
  return diverging.every((l) => l.rotation);
}

function verdictOf(counts, lanes, webs, register_profile = DEFAULT_REGISTER_PROFILE) {
  const present = MIXED_PRECEDENCE.filter((n) => counts[n]);
  if (!present.length) {
    if (counts[POOL_LAYOUT]) return ["pool-layout", "constant-audit"];
    if (counts[RELOCATION] || counts[DISPLACEMENT] || counts[POOL]) return ["words-identical", "relocation-only"];
    return ["exact", "done"];
  }
  if (present.length === 1 && present[0] === REGISTER) {
    if (phaseShift(lanes)) return ["phase-shift", "temp-fifo-phase"];
    const unreachable = uncolorableTargets(webs, register_profile);
    if (webs.length && unreachable.length === webs.length) return ["register-ring-only", "temp-fifo-phase"];
    if (consistentPermutation(webs)) return ["register-permutation", "forced-color-oracle"];
    return ["allocation", "pool-position"];
  }
  if (present.length === 1) {
    return {
      [CONSTANT]: ["constant", "constant-audit"],
      [STRUCTURAL]: ["structure", "structure-buckets"],
      [SCHEDULE]: ["schedule", "g0-schedule-probe"],
      [COMMUTATIVE]: ["commutative-order", "ast-shape"],
    }[present[0]];
  }
  const composition = present.map((n) => `${n}:${counts[n]}`).join(", ");
  const [, playbook] = verdictOf({ [present[0]]: counts[present[0]] }, lanes, webs, register_profile);
  return [`mixed(${composition})`, playbook];
}

const FRAME_ADDIU_RE = /^addiu\s+\$?sp,\$?sp,(-?(?:0x[0-9a-f]+|\d+))$/i;

function frameLayoutOnly(rows, targetFrame, candidateFrame) {
  if (targetFrame === null || candidateFrame === null || targetFrame === candidateFrame) return false;
  const differing = rows.filter((r) => ![MATCH, RELOCATION, DISPLACEMENT, POOL].includes(r.classification));
  if (differing.length !== 2 || differing.some((r) => r.classification !== CONSTANT)) return false;
  const immediate = (text) => {
    if (text === null) return null;
    const m = reMatch(FRAME_ADDIU_RE, strip(text.replaceAll("\t", " ")));
    return m ? pyInt(m[1], 0) : null;
  };
  const pairs = new Set(differing.map((r) => JSON.stringify([immediate(r.target), immediate(r.candidate)])));
  const expected = new Set([JSON.stringify([targetFrame, candidateFrame]), JSON.stringify([-targetFrame, -candidateFrame])]);
  return pairs.size === expected.size && [...pairs].every((p) => expected.has(p));
}

function primaryClass(counts) {
  for (const n of MIXED_PRECEDENCE) if (lookup(counts, n)) return n;
  if (lookup(counts, POOL_LAYOUT)) return POOL_LAYOUT;
  return lookup(counts, RELOCATION) ? RELOCATION : null;
}

function ringOnlyCaution(webs, register_profile) {
  const unreachable = uncolorableTargets(webs, register_profile);
  if (!unreachable.length || unreachable.length === webs.length) return [];
  const named = unreachable.map((w) => w.target).join(", ");
  return [
    `NOTE: ${unreachable.length} of ${webs.length} substitutions want a `
      + `ring-only target register (${named}), which the era's coloring pass `
      + "never hands out.",
    "      No color lever can move those sites; they are a "
      + "web-existence question. Expect any color probe to close only the "
      + "rest.",
  ];
}

function guidanceOf(verdict, counts, lanes, webs, hunks, register_profile = DEFAULT_REGISTER_PROFILE) {
  const lines = [];
  if (verdict.startsWith("mixed(")) {
    lines.push("mixed residual: fix constants first (they cascade), structure "
      + "second, register classes last.");
  }
  if (verdict === "frame-layout") {
    return [
      "allocation and opcode schedule are exact; only the entry/exit "
        + "stack adjustment differs.",
      "preserve the allocator-winning live ranges and recover the frame "
        + "separately by shrinking, reusing, or eliminating local stack homes.",
      "ablate locals one at a time and retain a two-axis Pareto set "
        + "(normalized residue, frame size); do not audit unrelated literals.",
    ];
  }
  const primary = primaryClass(counts);
  if (primary === null) {
    return [
      "aligned instructions and relocation layout are identical for this "
        + "function.",
      "run the project's normal collateral and full-output verification.",
    ];
  }
  if (primary === POOL_LAYOUT) {
    return [
      `${counts[POOL_LAYOUT]} literal-pool access(es) resolve to a `
        + "different slot, width, or anchor correspondence; the remaining "
        + "pool sites agree and are not reported.",
      "this is a literal question, not an allocation one: audit the "
        + "constants and their order, and check whether the candidate emits "
        + "a slot the target does not (or shares one it does not share).",
    ];
  }
  if (primary === RELOCATION) {
    return [
      "every aligned difference is a linker-controlled relocation field.",
      "do not mutate source; verify with the project's link or ROM check.",
    ];
  }
  if (primary === CONSTANT) {
    lines.push(
      "audit the flag, enum, or literal against the target assembly "
        + "FIRST: the assembly encodes the truth.",
      "one wrong identifier can present as a large structural cascade "
        + "(183 words from a single flag mix-up).",
      "after fixing a constant, re-derive any fakes: they may have "
        + "been fitted to the wrong body.",
      "a literal search is outside decomp_permuter's mutation space; "
        + "this is hand work.",
    );
  } else if (primary === STRUCTURAL) {
    const first = hunks.length ? hunks[0].hunk : 1;
    lines.push(
      `work the largest hunk first (hunk ${first} is the earliest); `
        + "bucket by region above ~500 instructions.",
      "if a hunk starts at a constant materialization (lui/andi/li), "
        + "audit that constant before anything else.",
      "hold allocator experiments until the instruction count and "
        + "opcode schedule stabilize.",
    );
  } else if (primary === SCHEDULE) {
    lines.push(
      "equal instruction multiset in a different order: this is late "
        + "scheduling, not allocation.",
      "recompile the candidate with -g0 as an ownership probe. A "
        + "collapse proves debug line metadata constrains the -g3 "
        + "schedule and that as1 can reach the target ordering.",
      "a -g0 collapse does not prove source correctness: a freer "
        + "scheduler can rescue a non-original expression or statement "
        + "shape. Compare topology and line tags before ending source "
        + "search.",
      "statement and expression grouping is the source lever; "
        + "replay-as1 tests whether as1 owns the ordering.",
    );
  } else if (primary === COMMUTATIVE) {
    lines.push(
      "same opcode and operand multiset with the pair swapped: front-end "
        + "AST shape, not allocation.",
      "`a | b` versus `b | a` canonicalizes identically (dead family); "
        + "`x |= y` is a distinct AST and flips the emitted operand order.",
      "do not trace the allocator for this residual.",
    );
  } else if (verdict === "phase-shift") {
    const lane = lanes.find((l) => l.rotation && l.divergence !== null) ?? null;
    let where = "";
    if (lane !== null && lane.divergence !== null) {
      where = ` (${lane.classification} lane, slot ${lane.divergence}, `
        + `aligned row ${lane.divergence_row === null ? "None" : lane.divergence_row}, rotation +${lane.rotation})`;
    }
    lines.push(
      `one upstream event, not ${counts[REGISTER] ?? 0} sites${where}.`,
      "perturb the PRECEDING block: hoist a call-argument expression "
        + "into a named local, which reorders value deaths.",
      "or materialize a phantom pool get with `(x == C) != 0` inside a "
        + "real `if`; a bare discarded expression is dropped with no "
        + "codegen effect.",
      "do not fix the divergent sites individually; declaration-order "
        + "permutation is a dead family here.",
    );
  } else if (verdict === "register-ring-only") {
    const unreachable = uncolorableTargets(webs, register_profile);
    const named = unreachable.map((w) => `${w.target} (candidate ${w.candidate})`).join(", ");
    lines.push(
      `every target register here is ring-only: ${named}. The era's `
        + "coloring pass never hands these out, so no color reaches "
        + "them.",
      "this is a web-existence problem, not a color problem: the "
        + "question is which values became block-local temps, not what "
        + "color a colored web was given.",
      "`forced-color-oracle` and `pool-position` are dead families "
        + "for this residual -- a forced color cannot cross the "
        + "boundary between the two allocators.",
      "run `decomp-workbench view --register-profile` to confirm "
        + "the era table this claim rests on before spending a round on "
        + "it.",
    );
  } else if (verdict === "register-permutation") {
    const mapping = webs.map((w) => `${w.target}->${w.candidate}`).join(", ");
    lines.push(
      `all visible register differences form one bijection (${mapping}): `
        + "report one downstream allocation outcome, not N sites.",
      "one visible bijection does NOT prove one source web or one source "
        + "edit: inspect the desired color's interference producers; a "
        + "staggered ladder of invisible blockers can cause the outcome.",
      "callee-saved tie-breaks resist blind source search; use a forced "
        + "color probe to measure the smallest causal web set before choosing "
        + "more variants.",
    );
    lines.push(...ringOnlyCaution(webs, register_profile));
  } else {
    lines.push(
      "register allocation differs with no consistent permutation. "
        + "Name the family before searching:",
      "  temp-queue phase: perturb the preceding block, since value "
        + "deaths set the phase entering it.",
      "  pool position: dead-web placement (`if (g) {}`) takes the NEXT "
        + "FREE slot and cannot reach past a live web.",
      "  coalescing: return type (void versus implicit int) or CSE "
        + "multiplicity.",
      "capture a globalcolor or ugen pool trace only if an instrumented "
        + "toolchain is already configured.",
    );
    lines.push(...ringOnlyCaution(webs, register_profile));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function hunksOf(rows) {
  const hunks = [];
  let current = [];
  const minMax = (xs) => (xs.length ? [Math.min(...xs), Math.max(...xs)] : null);
  const flush = () => {
    if (!current.length) return;
    const classes = {};
    for (const row of current) classes[row.classification] = (classes[row.classification] ?? 0) + 1;
    const names = Object.keys(classes);
    const label = names.length === 1 ? names[0]
      : "mixed(" + CLASS_ORDER.filter((n) => n in classes).map((n) => `${n}:${classes[n]}`).join(", ") + ")";
    const pick = (f) => current.map((r) => r[f]).filter((v) => v !== null);
    hunks.push(new Hunk({
      hunk: hunks.length + 1, classification: label, start: current[0].index, end: current[current.length - 1].index,
      target_range: minMax(pick("target_index")), candidate_range: minMax(pick("candidate_index")),
      target_bytes: minMax(pick("target_address")), candidate_bytes: minMax(pick("candidate_address")),
      classes,
    }));
    current = [];
  };
  for (const row of rows) {
    if (row.reported) current.push(row);
    else flush();
  }
  flush();
  return hunks;
}

function runsOf(labels) {
  const runs = [];
  let start = null;
  labels.forEach((label, index) => {
    if ([MATCH, DISPLACEMENT, RELOCATION, POOL, POOL_LAYOUT].includes(label)) {
      if (start !== null) { runs.push([start, index - 1]); start = null; }
    } else if (start === null) start = index;
  });
  if (start !== null) runs.push([start, labels.length - 1]);
  return runs;
}

function relabelReorderings(labels, skel, tk, ck) {
  const sides = (start, end) => {
    const part = skel.slice(start, end + 1);
    const left = part.filter(([, ti]) => ti !== null).map(([, ti]) => tk[ti]);
    const right = part.filter(([, , ci]) => ci !== null).map(([, , ci]) => ck[ci]);
    return [sorted(left), sorted(right)];
  };
  const runs = runsOf(labels);
  if (runs.length && arrEq(sorted(tk), sorted(ck)) && tk.length) {
    for (const [s, e] of runs) for (let i = s; i <= e; i++) labels[i] = SCHEDULE;
    return;
  }
  for (const [s, e] of runs) {
    const [left, right] = sides(s, e);
    if (left.length && arrEq(left, right)) for (let i = s; i <= e; i++) labels[i] = SCHEDULE;
  }
  relabelDisplacedRows(labels, skel, tk, ck);
}

function relabelDisplacedRows(labels, skel, tk, ck) {
  const deleted = [], inserted = [], displaced = [];
  skel.forEach(([, ti, ci], index) => {
    if (labels[index] !== STRUCTURAL) return;
    if (ti !== null && ci === null) { deleted.push(tk[ti]); displaced.push(index); }
    else if (ci !== null && ti === null) { inserted.push(ck[ci]); displaced.push(index); }
  });
  if (!displaced.length || !arrEq(sorted(deleted), sorted(inserted))) return;
  for (const index of displaced) labels[index] = SCHEDULE;
}

function poolOperandOnly(targetText, candidateText) {
  return targetText.replace(IMMEDIATE_RE, "@imm") === candidateText.replace(IMMEDIATE_RE, "@imm");
}

function relabelPoolRows(labels, skel, target, candidate, targetText, candidateText) {
  const targetPool = poolAccesses(target);
  const candidatePool = poolAccesses(candidate);
  if (!sizeOf(targetPool) || !sizeOf(candidatePool)) return null;
  const pairs = [], eligible = [];
  skel.forEach(([, ti, ci], row) => {
    if (ti === null || ci === null) return;
    const left = lookup(targetPool, ti), right = lookup(candidatePool, ci);
    if (left === null || right === null || !comparable(left, right)) return;
    pairs.push([row, left, right]);
    if (POOL_RELABEL_FROM.has(labels[row]) && poolOperandOnly(targetText[ti], candidateText[ci])) eligible.push(row);
  });
  const comparison = comparePoolAccesses(pairs, { target_accesses: targetPool, candidate_accesses: candidatePool });
  for (const row of eligible) {
    if (contains(comparison.agreeing, row)) labels[row] = POOL;
    else if (contains(comparison.differing, row)) labels[row] = POOL_LAYOUT;
  }
  return comparison;
}

function scheduleIdentity(instruction, normalized) {
  if (normalized.includes(ALIGNED_TARGET)) return normalized;
  const [mask, unknown] = fieldMask(instruction);
  if (unknown.length) return `${instruction.word}:${normalized}`;
  const kept = trunc32(instruction.word_value & ~mask);
  return `${hex(kept, 8)}:${relocationKindSignature(instruction).join(",")}`;
}

function unknownRelocations(...streams) {
  const kinds = new Set();
  for (const stream of streams) for (const item of stream) for (const k of fieldMask(item)[1]) kinds.add(k);
  return sorted([...kinds]);
}

function signatureOf(rows, lanes, prefix, unknown = []) {
  const signature = [prefix === null ? "prefix-exact@all" : `prefix-exact@${prefix}`];
  for (const lane of lanes) if (lane.divergence !== null) signature.push(`state-divergence@${lane.classification}:${lane.divergence}`);
  if (prefix !== null) {
    const row = rows[prefix];
    const earliest = lanes.filter((l) => l.divergence_row !== null).map((l) => l.divergence_row);
    if ((row.classification === REGISTER || row.classification === COMMUTATIVE) && earliest.length && Math.min(...earliest) <= prefix) {
      signature.push("register-first-divergence");
    }
  }
  for (const kind of unknown) signature.push(`unknown-relocation:${kind}`);
  return signature;
}

const joined = (instructions) => instructions.map((i) => i.assembly).join("\n");

/**
 * Align two instruction streams and classify the residual by mechanism.
 * Keyword options accept snake_case (the report vocabulary) or camelCase.
 * @param {any[]} target
 * @param {any[]} candidate
 * @param {object} opts
 */
export function buildView(target, candidate, opts = {}) {
  const pick = (snake, camel, dflt) => (opts[snake] !== undefined ? opts[snake] : opts[camel] !== undefined ? opts[camel] : dflt);
  const target_name = pick("target_name", "targetName", undefined);
  const candidate_name = pick("candidate_name", "candidateName", undefined);
  const symbol = pick("symbol", "symbol", null);
  const register_profile = pick("register_profile", "registerProfile", DEFAULT_REGISTER_PROFILE);
  const warnings = [...pick("warnings", "warnings", [])];
  const evidence = pick("evidence", "evidence", null);
  const target_reservations = pick("target_reservations", "targetReservations", null);
  const candidate_reservations = pick("candidate_reservations", "candidateReservations", null);

  const profile = REGISTER_CLASS_PROFILES[register_profile];
  if (!Object.prototype.hasOwnProperty.call(REGISTER_CLASS_PROFILES, register_profile)) {
    const known = sorted(Object.keys(REGISTER_CLASS_PROFILES)).join(", ");
    throw new ValueError(`unknown register profile ${strRepr(register_profile)}; known profiles: ${known}`);
  }
  if (register_profile !== "ido53" && (target_reservations !== null || candidate_reservations !== null)) {
    throw new ValueError("per-function reservations are supported only for ido53");
  }
  if (!target.length || !candidate.length) {
    const missing = !target.length ? "target" : "candidate";
    throw new ValueError(`no instructions to align on the ${missing} side; check the symbol name and the section`);
  }

  const skel = skeleton(target, candidate);
  const rowOfTarget = new Map(), rowOfCandidate = new Map();
  skel.forEach(([, ti, ci], row) => { if (ti !== null) rowOfTarget.set(ti, row); if (ci !== null) rowOfCandidate.set(ci, row); });
  const ta = addressIndex(target), ca = addressIndex(candidate);
  const targetText = target.map((item) => normalizedText(item, { address_index: ta, row_of_index: rowOfTarget }));
  const candidateText = candidate.map((item) => normalizedText(item, { address_index: ca, row_of_index: rowOfCandidate }));
  const tsk = target.map((item, i) => scheduleIdentity(item, targetText[i]));
  const csk = candidate.map((item, i) => scheduleIdentity(item, candidateText[i]));

  const labels = skel.map(([tag, ti, ci]) => (tag === "equal" && ti !== null && ci !== null
    ? classifyPair(target[ti], candidate[ci], { target_text: targetText[ti], candidate_text: candidateText[ci] })
    : STRUCTURAL));
  relabelReorderings(labels, skel, tsk, csk);
  const pool = relabelPoolRows(labels, skel, target, candidate, targetText, candidateText);

  const rows = [];
  const counts = Object.fromEntries(CLASS_ORDER.map((n) => [n, 0]));
  skel.forEach(([, ti, ci], index) => {
    const t = ti !== null ? target[ti] : null, c = ci !== null ? candidate[ci] : null;
    const classification = labels[index];
    const tr = t !== null ? [...registerOperands(t.assembly)] : [];
    const cr = c !== null ? [...registerOperands(c.assembly)] : [];
    rows.push(new AlignedRow({
      index, classification, target_index: ti, candidate_index: ci,
      target: t !== null ? t.assembly : null, candidate: c !== null ? c.assembly : null,
      target_address: t !== null ? t.address : null, candidate_address: c !== null ? c.address : null,
      target_registers: tr, candidate_registers: cr,
      substitutions: classification === REGISTER || classification === COMMUTATIVE ? substitutionsOf(tr, cr) : [],
    }));
    counts[classification] = (counts[classification] ?? 0) + 1;
  });

  const lanes = buildLanes(rows, profile, target_reservations, candidate_reservations);
  const webs = buildWebs(rows);
  const hunks = hunksOf(rows);
  const prefix = prefixExact(rows);
  const targetFrame = frameSize(joined(target)) ?? null;
  const candidateFrame = frameSize(joined(candidate)) ?? null;
  let [verdict, playbook] = verdictOf(counts, lanes, webs, register_profile);
  const decisiveGp = !!(evidence !== null && evidence.decisive && gpRoleUncertain(webs, register_profile) && primaryClass(counts) === REGISTER);
  if (gpRoleUncertain(webs, register_profile) && primaryClass(counts) === REGISTER && !decisiveGp) {
    if (verdict === "phase-shift") verdict = consistentPermutation(webs) ? "register-permutation" : "allocation";
    playbook = "register-role-audit";
  }
  if (frameLayoutOnly(rows, targetFrame, candidateFrame)) [verdict, playbook] = ["frame-layout", "stack-frame-recovery"];
  const ownership = ownershipFor(verdict, rows, lanes, webs, register_profile, warnings, evidence);
  if (decisiveGp) {
    playbook = {
      [OWNING_PASS_UOPT_COLOR]: "forced-color-oracle",
      [OWNING_PASS_UGEN_RING]: "temp-fifo-phase",
      [OWNING_PASS_G0_SCHEDULER]: "g0-schedule-probe",
    }[ownership.owning_pass] ?? playbook;
  }
  const guidance = [
    ...(playbook === "register-role-audit" || decisiveGp ? [] : guidanceOf(verdict, counts, lanes, webs, hunks, register_profile)),
    ...ownership.steps,
    ...nextSteps(playbook),
    ...(target_reservations !== null || candidate_reservations !== null
      ? ["lane roles are conditional on supplied per-input reservations; they do not establish actual colored uses or causal ownership"] : []),
    ...(routingFor(verdict, counts, warnings, ownership.reachability) === ROUTING_PERMUTER_FIRST ? PERMUTER_ROUTING_STEPS : []),
  ];
  return new MechanismView({
    symbol, target: target_name, candidate: candidate_name, register_profile,
    target_instructions: target.length, candidate_instructions: candidate.length,
    target_frame_size: targetFrame, candidate_frame_size: candidateFrame, counts, verdict, playbook,
    signature: signatureOf(rows, lanes, prefix, unknownRelocations(target, candidate)),
    prefix_exact: prefix, rows, hunks, lanes, webs, guidance, warnings, pool, evidence,
    target_reservations, candidate_reservations,
  });
}

/** The aligned residual counts for one pair of instruction streams. */
export function alignedClassCounts(target, candidate, { register_profile = DEFAULT_REGISTER_PROFILE, registerProfile = undefined } = {}) {
  if (registerProfile !== undefined) register_profile = registerProfile;
  const view = buildView(target, candidate, { target_name: "", candidate_name: "", register_profile });
  return Object.fromEntries(RESIDUAL_CLASSES.map((n) => [n, view.counts[n] ?? 0]));
}

export { RegisterReservations };
