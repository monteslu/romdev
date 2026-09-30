// diagnosis.js - one-pass object loading for combined comparison and
// mechanism diagnosis: each object is disassembled once, then the exact
// comparison and the aligned mechanism view are built from the same
// instruction streams.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import path from "node:path";
import { ValueError, replace } from "./py.js";
import { compareInstructions, resolveTrueInstructions } from "./compare.js";
import { LEVER_SCHEMA } from "./levers.js";
import { displayPath } from "./model.js";
import { dumpObject, parseSelectedDisassembly, selectionWarnings, symbolSelectionError } from "./objdump.js";
import { BASIS_NONE, DEFAULT_REGISTER_PROFILE, OWNING_PASS_UNKNOWN, REACHABILITY_UNKNOWN, ROUTING_IMPORT_FIX, Ownership, buildView } from "./view.js";

/** v3 adds owning_pass, reachability and ownership_basis beside the verdict. */
export const DIAGNOSIS_SCHEMA = "decomp-workbench-diagnosis-v3";

/** Exact comparison truth and the aligned explanation built from one input. */
export class Diagnosis {
  constructor({ comparison, view, lever = null }) { Object.assign(this, { comparison, view, lever }); Object.freeze(this); }

  asDict({ report_regs = false, cross_rom = false } = {}) {
    const c = this.comparison;
    const accepted = c.exact || (cross_rom && c.structural_exact);
    const basis = c.exact ? "function-exact" : cross_rom && c.structural_exact ? "cross-rom-structural" : "mismatch";
    const comparison = c.asDict();
    comparison.accepted = !!accepted;
    comparison.acceptance_basis = basis;
    const payload = { schema: DIAGNOSIS_SCHEMA, comparison, routing: this.routing, ...this.ownership.asDict(), view: this.view.asDict({ report_regs }) };
    if (this.lever !== null) { payload.lever = this.lever.asDict(); payload.lever_schema = LEVER_SCHEMA; }
    return payload;
  }

  get _import_fault() {
    return (this.comparison.relocation_symbol_mismatches ?? 0) > 0 || (this.comparison.unknown_relocations ?? []).length > 0;
  }

  get routing() { return this._import_fault ? ROUTING_IMPORT_FIX : this.view.routing; }

  get ownership() {
    if (this._import_fault) {
      return new Ownership({ owning_pass: OWNING_PASS_UNKNOWN, reachability: REACHABILITY_UNKNOWN, basis: BASIS_NONE,
        reason: "a relocation names a different symbol, or one nothing understood: the candidate is not reading what the target reads, so no pass owns this yet" });
    }
    return this.view.ownership;
  }
}

/** Build both reports from two already-parsed instruction streams. */
export function diagnoseInstructions(target, candidate, { target_name, candidate_name, symbol, register_profile = DEFAULT_REGISTER_PROFILE, warnings = [],
  target_true_instructions = null, candidate_true_instructions = null, instruction_count_verified = false, evidence = null,
  target_reservations = null, candidate_reservations = null }) {
  const t = [...target], c = [...candidate];
  const comparison = compareInstructions(t, c, { target_name, candidate_name, symbol, warnings, target_true_instructions,
    candidate_true_instructions, instruction_count_verified });
  const view = buildView(t, c, { target_name, candidate_name, symbol, register_profile, warnings, evidence, target_reservations, candidate_reservations });
  return new Diagnosis({ comparison, view });
}

/** Disassemble each object once, then build both reports in process. */
export function diagnoseObjects(target, candidate, { objdump = null, symbol = null, section = ".text", register_profile = DEFAULT_REGISTER_PROFILE,
  evidence = null, target_reservations = null, candidate_reservations = null, cwd = process.cwd(), env = process.env } = {}) {
  const [targetText, targetItems] = dumpObject(target, { objdump, symbol, section, cwd, env });
  const [candidateText, candidateItems] = dumpObject(candidate, { objdump, symbol, section, cwd, env });
  const target_name = displayPath(target, cwd), candidate_name = displayPath(candidate, cwd);
  const warnings = selectionWarnings(targetText, candidateText, { symbol, target_name, candidate_name, section });
  const abs = (p) => path.resolve(cwd, String(p));
  const tt = resolveTrueInstructions(abs(target), { symbol, section });
  const ct = resolveTrueInstructions(abs(candidate), { symbol, section });
  return diagnoseInstructions(targetItems, candidateItems, { target_name, candidate_name, symbol, register_profile, warnings,
    target_true_instructions: tt, candidate_true_instructions: ct, instruction_count_verified: tt !== null && ct !== null,
    evidence, target_reservations, candidate_reservations });
}

/** Load each retained dump once, then build both reports. */
export function diagnoseDumps(target, candidate, { symbol = null, register_profile = DEFAULT_REGISTER_PROFILE, evidence = null,
  target_reservations = null, candidate_reservations = null, cwd = process.cwd() } = {}) {
  const targetText = readFileSync(path.resolve(cwd, String(target)), "utf8");
  const candidateText = readFileSync(path.resolve(cwd, String(candidate)), "utf8");
  const targetItems = parseSelectedDisassembly(targetText, { symbol });
  const candidateItems = parseSelectedDisassembly(candidateText, { symbol });
  const target_name = displayPath(target, cwd), candidate_name = displayPath(candidate, cwd);
  if (!targetItems.length || !candidateItems.length) {
    throw new ValueError(symbolSelectionError(symbol, { inputs: [[target_name, targetText], [candidate_name, candidateText]] }));
  }
  return diagnoseInstructions(targetItems, candidateItems, { target_name, candidate_name, symbol, register_profile,
    warnings: selectionWarnings(targetText, candidateText, { symbol, target_name, candidate_name }), evidence, target_reservations, candidate_reservations });
}

export { replace };
