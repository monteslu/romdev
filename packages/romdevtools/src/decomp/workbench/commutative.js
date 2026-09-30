// commutative.js - commutative operand order, named as a lever and looked for
// one row back. IDO canonicalizes `a + b` and `b + a` to one arithmetic
// instruction, so a wrong source operand order often leaves the arithmetic
// row byte-identical and surfaces in its two operand loads, crossed.
// `operand-order`: the arithmetic row differs by a swapped source pair.
// `operand-load`: the arithmetic row matches and its definitions are crossed.
//
// Plain JS ESM + JSDoc.

import { COMMUTATIVE_OPCODES, commutativeSwap, registerOperands } from "./compare.js";
import { destinationRegister } from "./view.js";
import { splitWs } from "./py.js";

export const DEFINITION_LOOKBACK = 8;

export class OperandDefinition {
  constructor({ register, aligned_row, target, candidate, crossed_with = null }) { Object.assign(this, { register, aligned_row, target, candidate, crossed_with }); Object.freeze(this); }
  asDict() { return { register: this.register, aligned_row: this.aligned_row, target: this.target, candidate: this.candidate, crossed_with: this.crossed_with }; }
}

export class CommutativeFinding {
  constructor({ kind, aligned_row, target_row, candidate_row, opcode, target, candidate, sources, definitions = [] }) {
    Object.assign(this, { kind, aligned_row, target_row, candidate_row, opcode, target, candidate, sources, definitions });
    Object.freeze(this);
  }
  get lever() {
    const [left, right] = this.sources;
    if (this.kind === "operand-order") {
      return `swap the two operands of the ${this.opcode} at aligned row ${this.aligned_row}: the target computes it as `
        + `(${left} op ${right}). This is expression shape -- a compound assignment or an operand order in the source -- not register allocation.`;
    }
    const rows = this.definitions.map((d) => String(d.aligned_row)).join(", ");
    return `the ${this.opcode} at aligned row ${this.aligned_row} matches; its two operand loads at rows ${rows} are crossed. `
      + "Swap the operand order of the expression this row computes -- the differing rows are the symptom, and reallocating them is the wrong repair.";
  }
  asDict() {
    return { kind: this.kind, aligned_row: this.aligned_row, target_row: this.target_row, candidate_row: this.candidate_row, opcode: this.opcode,
      target: this.target, candidate: this.candidate, sources: [...this.sources], definitions: this.definitions.map((d) => d.asDict()), lever: this.lever };
  }
}

function sourcePair(ops) {
  if (ops.length === 2) return [ops[0], ops[1]];
  if (ops.length === 3) return [ops[1], ops[2]];
  return null;
}

/** Every commutative operand finding in one aligned view's rows. */
export function commutativeFindings(rows) {
  const findings = [];
  rows.forEach((row, position) => {
    const t = row.target, c = row.candidate;
    if (!t || !c) return;
    const opcode = splitWs(t, 1)[0];
    if (!COMMUTATIVE_OPCODES.has(opcode)) return;
    if (splitWs(c, 1)[0] !== opcode) return;
    const tOps = registerOperands(t), cOps = registerOperands(c);
    const sources = sourcePair(tOps);
    if (sources === null) return;
    if (commutativeSwap(opcode, tOps, cOps)) {
      findings.push(new CommutativeFinding({ kind: "operand-order", aligned_row: row.index, target_row: row.target_index, candidate_row: row.candidate_index,
        opcode, target: t, candidate: c, sources }));
      return;
    }
    if (!row.matched) return;
    const definitions = crossedDefinitions(rows, position, sources);
    if (definitions.length) {
      findings.push(new CommutativeFinding({ kind: "operand-load", aligned_row: row.index, target_row: row.target_index, candidate_row: row.candidate_index,
        opcode, target: t, candidate: c, sources, definitions }));
    }
  });
  return findings;
}

function crossedDefinitions(rows, position, sources) {
  const [left, right] = sources;
  if (left === right) return [];
  const found = new Map();
  const start = Math.max(0, position - DEFINITION_LOOKBACK);
  for (let p = position - 1; p > start - 1; p--) {
    const row = rows[p];
    if (!row.target || !row.candidate) continue;
    const defined = destinationRegister(row.target);
    if ((defined === left || defined === right) && !found.has(defined)) found.set(defined, row);
    if (found.size === 2) break;
  }
  if (found.size !== 2) return [];
  const l = found.get(left), r = found.get(right);
  if (destinationRegister(l.candidate) !== right) return [];
  if (destinationRegister(r.candidate) !== left) return [];
  return [
    new OperandDefinition({ register: left, aligned_row: l.index, target: l.target, candidate: l.candidate, crossed_with: right }),
    new OperandDefinition({ register: right, aligned_row: r.index, target: r.target, candidate: r.candidate, crossed_with: left }),
  ];
}
