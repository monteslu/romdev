// whats-next.js - `next`: what to run now, and one sentence of why. A
// router, not a second field guide: each step is one concrete command with
// the real paths substituted, ranked so steps that clear a blocker (an
// instruction-count difference that makes every later word unreadable) come
// before steps that interpret what the blocker distorts.
//
// Plain JS ESM + JSDoc.

import { PLAYBOOK_LEVERS, VERDICT_PLAYBOOKS } from "./field-guide.js";
import { sorted } from "./py.js";

export const RING_ROTATION_THRESHOLD = 4;
export const RANK_BLOCKER = 0;
export const RANK_FAMILY = 1;
export const RANK_ATTRIBUTION = 2;
export const RANK_REFERENCE = 3;
export const RANK_LABELS = { 0: "blocker", 1: "family", 2: "attribution", 3: "reference" };

/** shlex.quote */
export function shellQuote(s) {
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s) && /^[\x00-\x7f]*$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** shlex.join */
export function shellJoin(argv) { return argv.map(shellQuote).join(" "); }

export class Step {
  constructor(rank, argv, why, action, expected_signal) { Object.assign(this, { rank, argv, why, action, expected_signal }); Object.freeze(this); }
  get command() { return shellJoin(["decomp-workbench", ...this.argv]); }
  asDict() {
    return { rank: this.rank, kind: RANK_LABELS[this.rank], action: this.action, command_argv: ["decomp-workbench", ...this.argv],
      command: this.command, why: this.why, expected_signal: this.expected_signal, safety: "read-only" };
  }
}

export class Plan {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    return { schema: "decomp-workbench-next-v1", target: this.target, candidate: this.candidate, words: this.words, verdict: this.verdict,
      matched: this.matched, steps: this.steps.map((s) => s.asDict()), blocked: [...this.blocked] };
  }
}

const DUMP_COMMANDS = { align: "align-dumps", compare: "compare-dumps", diagnose: "diagnose-dumps", phase: "phase-dumps", view: "view-dumps" };

function comparisonArgv(command, target, candidate, { dumps, symbol, section, objdump, extra = [] }) {
  const actual = dumps ? DUMP_COMMANDS[command] : command;
  const argv = [actual, target, candidate, ...extra];
  if (symbol) argv.push("--function", symbol);
  if (!dumps) { argv.push("--section", section); if (objdump) argv.push("--objdump", objdump); }
  return argv;
}

const IMMEDIATES = "shapes agree and only literal operands differ; this puts every differing immediate side by side.";

export const VERDICT_ROUTES = Object.freeze({
  "structure-mismatch": ["view", ["--show-all"], "opcode shape differs, so this is a source-level difference; bucket the hunks and work at the expression or control-flow level before any allocator experiment."],
  "schedule-mismatch": ["diagnose", [], "the instruction multiset is identical and only the order differs, so this is late-pass scheduling; diagnose says whether statement line assignment or the assembler owns the ordering."],
  "allocation-mismatch": ["diagnose", [], "opcode shape matches and only registers differ; diagnose names which allocation family this is -- temp-FIFO phase, pool position, or coalescing -- from these two objects, with no instrumented toolchain."],
  "constant-mismatch": ["diagnose", ["--show-diff"], IMMEDIATES],
  "operand-mismatch": ["diagnose", ["--show-diff"], IMMEDIATES],
  "frame-layout-mismatch": ["view", [], "the stack frames differ, which is its own acceptance gate: a better register score cannot compensate for a wrong frame."],
});

export const ALLOCATION_VERDICTS = new Set(["allocation-mismatch", "frame-layout-mismatch"]);
export const FALLBACK_ROUTE = ["diagnose", [], "one screen of exactness, mechanism, and the field-guide lever for this residual."];

const get = (o, k) => (o && typeof o.get === "function" && !Array.isArray(o) ? o.get(k) : o?.[k]);

/** The ordered plan for one comparison. */
export function planNextSteps(item, { target, candidate, source = null, dumps = false, symbol = null, section = ".text", objdump = null, symbol_map = null, trace = null, proc = null }) {
  const steps = [], blocked = [];
  const cargs = { dumps, symbol, section, objdump };
  if (item.exact) {
    if (dumps) {
      steps.push(new Step(RANK_FAMILY, ["guide", "post-match-cleanup"],
        "the retained disassembly matches, but a text dump cannot prove whole-object, translation-unit, or linked-ROM fidelity; this names the remaining gates without overstating the evidence you supplied.",
        "open-post-match-gates", "the exactness gates still requiring real build artifacts"));
    } else {
      steps.push(new Step(RANK_FAMILY, comparisonArgv("object-collateral", target, candidate, { ...cargs, dumps: false }),
        "the selected function matches; expose any whole-object change that landed outside it before promotion.",
        "check-object-collateral", "zero unexplained changes outside the selected function"));
    }
    return new Plan({ target, candidate, words: item.word_mismatches, verdict: item.verdict, matched: true, steps, blocked: [] });
  }
  const delta = item.candidate_instructions - item.target_instructions;
  if (delta) {
    const direction = delta > 0 ? "more" : "fewer";
    steps.push(new Step(RANK_BLOCKER, comparisonArgv("align", target, candidate, cargs),
      `the candidate emits ${Math.abs(delta)} ${direction} instruction(s) than the target, so every word after the first count difference is shifted rather than wrong; this names the inserted and deleted instructions and says how many instructions away the candidate really is, instead of what the shift costs positionally.`,
      "locate-structural-shift", "the inserted/deleted rows and the first trustworthy aligned residue"));
    blocked.push("allocator and scheduler experiments: their residue is not measurable across an instruction-count difference.");
  }
  if (item.fp_register_mismatches >= RING_ROTATION_THRESHOLD) {
    steps.push(new Step(RANK_FAMILY, comparisonArgv("phase", target, candidate, cargs),
      `${item.fp_register_mismatches} row(s) differ in a floating-point register, which is the shape a rotated scratch ring makes: read whether the residual is a renaming before treating it as a mistake, and read the positional count beside it so a rotation is never recorded as a win.`,
      "classify-fp-ring-phase", "whether one coherent floating-point register rotation explains the rows"));
  }
  if (item.target_frame_size !== null && item.target_frame_size !== undefined && item.candidate_frame_size !== null && item.candidate_frame_size !== undefined
    && item.target_frame_size !== item.candidate_frame_size) {
    steps.push(new Step(RANK_BLOCKER, ["guide", "stack-frame-recovery"],
      `the frames differ (target ${item.target_frame_size}, candidate ${item.candidate_frame_size}); frame recovery is its own acceptance gate, and a better register score cannot compensate for a wrong frame.`,
      "recover-stack-frame", "a source experiment that restores the target frame size"));
  }
  if (item.word_mismatches === 0 && item.raw_word_mismatches && symbol_map) {
    const argv = ["relocation-aliases", target, candidate, "--symbol-map", symbol_map];
    if (symbol) argv.push("--symbol", symbol);
    steps.push(new Step(RANK_FAMILY, argv,
      "no instruction word differs once linker-controlled fields are masked, so what is left is relocation spelling; this proves whether the two spellings link to the same address.",
      "prove-relocation-aliases", "resolved-address equality or a concrete non-aliasing relocation"));
  } else if (item.word_mismatches === 0 && item.raw_word_mismatches) {
    steps.push(new Step(RANK_FAMILY, ["guide", "relocation-only"],
      "only linker-controlled fields remain, but proving aliasing requires a linked symbol map; the guide explains that proof and `next --symbol-map MAP` will emit the concrete command.",
      "prepare-relocation-proof", "a linked symbol map suitable for resolving both spellings"));
  } else {
    const [command, extra, why] = VERDICT_ROUTES[item.verdict] ?? FALLBACK_ROUTE;
    steps.push(new Step(RANK_FAMILY, comparisonArgv(command, target, candidate, { ...cargs, extra }), `verdict=${item.verdict}: ${why}`,
      "inspect-dominant-mechanism", "a mechanism-specific residual and evidence-backed lever family"));
  }
  if (ALLOCATION_VERDICTS.has(item.verdict) && trace) {
    steps.push(new Step(RANK_FAMILY, ["oracle", "plan", trace, ...(proc !== null && proc !== undefined ? ["--proc", String(proc)] : [])],
      "before spending builds on source variants: sweep the forced colours over the webs this residue names, and record the best forced object as the construct's ceiling. A ceiling that does not reach the target rules out every source spelling of the construct at once.",
      "plan-forced-color-oracle", "a bounded force grid and an explicit ceiling for this construct"));
  }
  if (source) {
    steps.push(new Step(RANK_ATTRIBUTION, comparisonArgv("compare", target, candidate, { ...cargs, extra: ["--by-region", source] }),
      "rank the differing words by the source construct that emitted them, so the next edit is the biggest attributed region rather than the first differing row.",
      "attribute-residue-to-source", "ranked source regions with explicit attribution coverage"));
  }
  const playbook = get(VERDICT_PLAYBOOKS, item.verdict);
  if (playbook) {
    const levers = get(PLAYBOOK_LEVERS, playbook) ?? [];
    const leverText = levers.length ? ` (levers ${[...levers].map(String).join(", ")})` : "";
    steps.push(new Step(RANK_REFERENCE, ["guide", playbook], `the lever family for this verdict${leverText}, with the evidence each one needs.`,
      "open-verdict-playbook", "candidate source levers and the evidence required to use them"));
  }
  return new Plan({ target, candidate, words: item.word_mismatches, verdict: item.verdict, matched: false, steps: sorted(steps, (s) => s.rank), blocked });
}

function wrap(text, { prefix, continuation, width = 78 }) {
  const lines = [];
  let current = prefix;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current.length + word.length + 1 > width && ![prefix.trim(), ""].includes(current.trim())) { lines.push(current.trimEnd()); current = continuation; }
    current += word + " ";
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}

/** Render the plan: the state in one line, then numbered steps. */
export function renderPlan(plan, { limit = null } = {}) {
  const head = plan.matched ? `next: this function matches (${plan.target} vs ${plan.candidate})`
    : `next: ${plan.words} word${plan.words === 1 ? "" : "s"} differ, verdict=${plan.verdict} (${plan.target} vs ${plan.candidate})`;
  const lines = [head, ""];
  const shown = limit === null ? plan.steps : plan.steps.slice(0, limit);
  shown.forEach((step, i) => {
    lines.push(`${i + 1}.${step.rank === RANK_BLOCKER ? "  [blocker] " : "  "}${step.command}`);
    lines.push(...wrap(step.why, { prefix: "     why: ", continuation: "          " }));
    lines.push("");
  });
  if (limit !== null && plan.steps.length > limit) lines.push(`(${plan.steps.length - limit} further step(s); pass --all to see them)`, "");
  if (plan.blocked.length) {
    lines.push("not yet:");
    for (const entry of plan.blocked) lines.push(...wrap(entry, { prefix: "  - ", continuation: "    " }));
  }
  return lines.map((l) => l.trimEnd());
}
