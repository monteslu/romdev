// emit-provenance.js - ugen's DKWB-EMIT-V1 emit-order provenance records:
// the order instruction records enter the ibuffer and the source line each
// one is stamped with. The line is a key in as1's selection chain (lower
// wins), and the only one with a source lever attached.
//
// Plain JS ESM + JSDoc.

import { ValueError, splitlines, strip, splitWs, sorted, pyInt, strRepr, fullmatch } from "./py.js";

export const TRACE_PREFIX = "DKWB-EMIT-V1";
export const TRACE_SCHEMA = "decomp-workbench-ugen-emit-trace-v1";
const FIELD_RE = /([A-Za-z_][A-Za-z0-9_]*)=(\S+)/;
export const REQUIRED_FIELDS = ["proc", "block", "emit", "op", "line", "buffer", "fn"];
const BUFFERS = new Set(["fwd", "back"]);

export const DIRECTIVE_FUNCTIONS = new Set([
  "f_emit_dir0", "f_emit_dir1", "f_emit_dir2", "f_emit_dir_ll", "f_emit_alias", "f_emit_regmask", "f_emit_loopno",
  "f_emit_optimize_level", "f_emit_file", "f_emit_vers", "f_emit_symbol", "f_emit_pic", "f_emit_init", "f_emit_cpalias",
  "f_emit_cpadd", "f_emit_cpload", "f_emit_vreg", "f_emit_itext", "f_define_label", "f_ddefine_label", "f_define_exception_label",
]);

/** One ibuffer record ugen wrote, in the order it wrote it. */
export class EmitEvent {
  constructor({ proc, block, emit, op, line, buffer, fn }) { Object.assign(this, { proc, block, emit, op, line, buffer, fn }); Object.freeze(this); }
  get is_instruction() { return this.buffer === "fwd" && !DIRECTIVE_FUNCTIONS.has(this.fn); }
  asDict() {
    return { proc: this.proc, block: this.block, emit: this.emit, op: this.op, line: this.line, buffer: this.buffer, fn: this.fn, is_instruction: this.is_instruction };
  }
}

function integer(fields, name, lineNumber) {
  try {
    if (!fields.has(name)) throw new Error("missing");
    return pyInt(fields.get(name), 0);
  } catch {
    throw new ValueError(`emit trace line ${lineNumber} has invalid integer field ${strRepr(name)}`);
  }
}

/** Parse DKWB-EMIT-V1 records, preserving unrelated diagnostics: [events, ignored]. */
export function parseEmitTrace(text) {
  const events = [], ignored = [];
  splitlines(text).forEach((raw, idx) => {
    const lineNumber = idx + 1;
    if (!raw.includes(TRACE_PREFIX)) { if (strip(raw)) ignored.push(raw); return; }
    const body = raw.slice(raw.indexOf(TRACE_PREFIX) + TRACE_PREFIX.length);
    const pairs = [];
    for (const token of splitWs(body)) {
      const m = fullmatch(FIELD_RE, token);
      if (!m) throw new ValueError(`emit trace line ${lineNumber} has malformed token ${strRepr(token)}`);
      pairs.push([m[1], m[2]]);
    }
    const fields = new Map(pairs);
    if (fields.size !== pairs.length) {
      const counts = new Map();
      for (const [n] of pairs) counts.set(n, (counts.get(n) ?? 0) + 1);
      throw new ValueError(`emit trace line ${lineNumber} repeats field(s): ` + sorted([...counts].filter(([, c]) => c > 1).map(([n]) => n)).join(", "));
    }
    const unknown = sorted([...fields.keys()].filter((k) => !REQUIRED_FIELDS.includes(k)));
    if (unknown.length) throw new ValueError(`emit trace line ${lineNumber} has unsupported field(s): ` + unknown.join(", "));
    const missing = REQUIRED_FIELDS.filter((n) => !fields.has(n));
    if (missing.length) throw new ValueError(`emit trace line ${lineNumber} is missing field(s): ` + missing.join(", "));
    if (!BUFFERS.has(fields.get("buffer"))) {
      throw new ValueError(`emit trace line ${lineNumber} has unknown buffer ${strRepr(fields.get("buffer"))}; expected one of ` + sorted([...BUFFERS]).join(", "));
    }
    const event = new EmitEvent({ proc: integer(fields, "proc", lineNumber), block: integer(fields, "block", lineNumber),
      emit: integer(fields, "emit", lineNumber), op: integer(fields, "op", lineNumber), line: integer(fields, "line", lineNumber),
      buffer: fields.get("buffer"), fn: fields.get("fn") });
    for (const name of ["proc", "block", "emit", "op", "line"]) {
      if (event[name] < 0) throw new ValueError(`emit trace line ${lineNumber} has negative field ${strRepr(name)}`);
    }
    events.push(event);
  });
  return [events, ignored];
}

function selected(events, proc, block) {
  return events.filter((e) => (proc === null || proc === undefined || e.proc === proc) && (block === null || block === undefined || e.block === block));
}

function groupByBlock(events, predicate = () => true) {
  const map = new Map();
  for (const e of events) {
    if (!predicate(e)) continue;
    const k = `${e.proc},${e.block}`;
    if (!map.has(k)) map.set(k, [[e.proc, e.block], []]);
    map.get(k)[1].push(e);
  }
  return sorted([...map.values()], (x) => x[0]);
}

/** Adjacent instruction pairs whose lines could reverse their order. */
export function lineOrderConflicts(events) {
  const conflicts = [];
  for (const [[proc, block], rows0] of groupByBlock(events, (e) => e.is_instruction)) {
    const rows = sorted(rows0, (e) => e.emit);
    for (let i = 0; i + 1 < rows.length; i++) {
      const earlier = rows[i], later = rows[i + 1];
      if (earlier.line < later.line) {
        conflicts.push({ proc, block, earlier: earlier.asDict(), later: later.asDict(), line_gap: later.line - earlier.line });
      }
    }
  }
  return conflicts;
}

/** Per-block emission order with the source line each record carries. */
export function emitReport(events, { proc = null, block = null } = {}) {
  const sel = selected(events, proc, block);
  const instructions = sel.filter((e) => e.is_instruction);
  const blocks = [];
  for (const [[p, b], rows0] of groupByBlock(sel)) {
    const rows = sorted(rows0, (e) => e.emit);
    const bi = rows.filter((r) => r.is_instruction);
    blocks.push({ proc: p, block: b, records: rows.map((r) => r.asDict()), instruction_count: bi.length,
      lines: sorted([...new Set(bi.map((r) => r.line))]) });
  }
  return {
    schema: TRACE_SCHEMA,
    proof: "ugen emission order and per-record source lines. Evidence about the scheduler's *input*, not its output: ugen contains no ready "
      + "list, no dependence DAG and no delay-slot filler, so slot, priority and delay-slot occupancy are not derivable here -- read "
      + "them from `cc -Wa,-R` via as1-reorganize.",
    event_count: sel.length,
    instruction_count: instructions.length,
    procedures: sorted([...new Set(events.map((e) => e.proc))]),
    blocks,
    line_order_conflicts: lineOrderConflicts(sel),
  };
}

/** Render a report as the per-block emission listing an analyst reads. */
export function formatEmitReport(report) {
  const lines = [];
  const pad = (v, n) => String(v).padEnd(n);
  for (const block of report.blocks) {
    lines.push(`proc ${block.proc} block ${block.block}  ${block.instruction_count} instruction records  lines [${block.lines.join(", ")}]`);
    for (const row of block.records) {
      lines.push(`  ${row.is_instruction ? "I" : "."} emit=${pad(row.emit, 6)} line=${pad(row.line, 6)} op=${pad(row.op, 6)} ${pad(row.buffer, 4)} ${row.fn}`);
    }
  }
  const conflicts = report.line_order_conflicts;
  lines.push("", `line-order conflicts: ${conflicts.length}`);
  for (const c of conflicts) {
    lines.push(`  proc ${c.proc} block ${c.block}: emit=${c.earlier.emit} line=${c.earlier.line} (${c.earlier.fn}) before emit=${c.later.emit} line=${c.later.line} (${c.later.fn}) -- the earlier record's lower line wins as1's line key`);
  }
  return lines.join("\n");
}
