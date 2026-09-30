// view-cli.js - terminal rendering and commands for the aligned mechanism
// view: `view`, `view-dumps`, `window`, `window-dumps`.
//
// Rendering rules, in the order they matter: the verdict chooses emphasis and
// guidance, never visibility (every non-matching aligned row is printed,
// grouped by class); the human labels are the JSON keys; glyphs stay ASCII.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { parseCensus, evaluateCensus, censusStatus } from "./census.js";
import * as O from "./cli-options.js";
import { writeForceSpecification, expandResolve } from "./force-spec.js";
import { renderDiagnosisHtml } from "./html-report.js";
import { displayPath } from "./model.js";
import { dumpObject, parseSelectedDisassembly, selectionWarnings, symbolSelectionError, crossFunctionWarning } from "./objdump.js";
import { loadReservations } from "./register-state.js";
import { VIEW_CENSUS_KEYS } from "./schema.js";
import { Painter, emitLines, resolveColor, resolveWidth, visibleLength, visibleLjust, WEB_COLORS } from "./terminal.js";
import { DEFAULT_REGISTER_PROFILE, MATCH, REGISTER_CLASS_PROFILES, buildView } from "./view.js";
import { dumps } from "./pyjson.js";
import { ValueError, hex, isInputError, osErrorText, strRepr, strip, rstrip, lstrip, floorDiv } from "./py.js";
import { isReportedError, OSError } from "./py-extra.js";

export { Painter, resolveColor, WEB_COLORS };

export const WINDOW_SCHEMA = "decomp-workbench-window-v1";

const tokens = (pairs) => pairs.map(([k, v]) => `${k}=${fmt(v)}`).join(" ");
const fmt = (v) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));
const rangeText = (v) => (v === null || v === undefined ? "none" : `${v[0]}..${v[1]}`);
const byteRangeText = (v) => (v === null || v === undefined ? "none" : `0x${hex(v[0])}..0x${hex(v[1])}`);
const pairKey = (p) => `${p[0]}\u0000${p[1]}`;

export const SIGNATURE_NOTE = "signature reads left to right: how much is untouched, where state first "
  + "drifts, then which axis it drifted on - in that causal order.";
export const LANE_NOTE = "pool = uopt's colored variable webs (lowest free index wins); "
  + "temp = ugen's block-local least-recently-freed ring - two independent "
  + "register populations. shared = possible color or temp, actual role "
  + "unknown. Per-input supplied reservations project conditional lanes; "
  + "register-profile alone cannot prove the effective temporary pool.";
export const KEY_NOTE = "labels defined: decomp-workbench --explain-keys";

export function renderHeader(view, painter = null, { terse = false } = {}) {
  const brush = painter ?? new Painter(false);
  const counts = view.counts;
  const lines = [];
  const title = `view ${view.symbol || "all-instructions"}`;
  lines.push(`${title}  ` + tokens([["target_instructions", view.target_instructions], ["candidate_instructions", view.candidate_instructions],
    ["aligned_rows", view.aligned_rows], ["match", counts[MATCH] ?? 0], ["target_frame_size", view.target_frame_size],
    ["candidate_frame_size", view.candidate_frame_size], ["register_profile", view.register_profile]]));
  const vt = [["structural", counts.structural ?? 0], ["schedule", counts.schedule ?? 0], ["register", counts.register ?? 0], ["constant", counts.constant ?? 0]];
  for (const optional of ["commutative", "relocation", "displacement"]) if (counts[optional]) vt.push([optional, counts[optional]]);
  vt.push(["hunks", view.hunks.length], ["playbook", view.playbook], ["routing", view.routing]);
  lines.push(brush.bold("verdict:") + " " + brush.verdict(view.verdict) + "  " + tokens(vt));
  const own = view.ownership;
  lines.push("ownership: " + tokens([["owning_pass", own.owning_pass], ["reachability", own.reachability], ["ownership_basis", own.basis]]));
  lines.push("signature: " + view.signature.join(" "));
  if (!terse) lines.push("  " + SIGNATURE_NOTE);
  if (view.webs.length) lines.push("webs: " + view.webs.map((w, i) => brush.web(i + 1, `${w.web} ${w.target}->${w.candidate} x${w.count}`)).join(", "));
  if (!terse) lines.push(KEY_NOTE);
  return lines;
}

export function renderLanes(view, { window, terse = false }) {
  if (!view.lanes.length) return [];
  const lines = ["", "REGISTER LANES (per-class assignment sequences, matching instructions included)"];
  if (!terse) lines.push("  " + LANE_NOTE);
  const labelWidth = Math.max(...view.lanes.map((l) => l.classification.length));
  for (const lane of view.lanes) {
    const total = Math.max(lane.target.length, lane.candidate.length);
    const start = lane.divergence !== null && lane.divergence !== undefined && total > window ? Math.max(0, lane.divergence - floorDiv(window, 2)) : 0;
    const end = Math.min(total, start + window);
    const widths = [];
    const at = (arr, s) => (s < arr.length ? arr[s] : "-");
    for (let s = start; s < end; s++) widths.push(Math.max(at(lane.target, s).length, at(lane.candidate, s).length));
    const prefix = " ".repeat(2 + labelWidth + 2);
    const cells = (arr) => { const out = []; for (let s = start; s < end; s++) out.push(at(arr, s).padEnd(widths[s - start])); return out.join(" "); };
    const slots = tokens([["slots", `${start}..${Math.max(start, end - 1)}/${total}`]]);
    lines.push(`  ${lane.classification.padEnd(labelWidth)}  target     ${rstrip(cells(lane.target))}   ${slots}`);
    lines.push(`${prefix}candidate  ${rstrip(cells(lane.candidate))}`);
    const markerIndent = prefix + " ".repeat("candidate  ".length);
    if (lane.divergence === null || lane.divergence === undefined) { lines.push(`${markerIndent}identical ${lane.target.length}/${total}`); continue; }
    const k = Math.max(0, lane.divergence - start);
    const offset = widths.slice(0, k).reduce((a, b) => a + b, 0) + k;
    const detail = [["slot", lane.divergence], ["aligned_row", lane.divergence_row]];
    if (lane.rotation) detail.push(["rotation", `+${lane.rotation}`]);
    lines.push(`${markerIndent}${"-".repeat(offset)}^ ` + tokens(detail));
  }
  return lines;
}

function annotationParts(row, webs, painter) {
  return row.substitutions.map((pair) => {
    const number = webs.get(pairKey(pair));
    let label = `${pair[0]}->${pair[1]}`;
    if (number !== undefined) label = painter.web(number, `${label} [w${number}]`);
    return label;
  });
}

function assemblyWidth(rows) {
  let w = 0, any = false;
  for (const row of rows) for (const t of [row.target, row.candidate]) if (t !== null && t !== undefined) { w = Math.max(w, t.length); any = true; }
  return any ? w : 1;
}

export function contextWindows(view, hunks, { context }) {
  const windows = [];
  const last = view.rows.length - 1;
  hunks.forEach((hunk, i) => {
    let low = Math.max(0, hunk.start - context);
    let high = Math.min(last, hunk.end + context);
    if (i) low = Math.max(low, floorDiv(hunks[i - 1].end + hunk.start, 2) + 1);
    if (i + 1 < hunks.length) high = Math.min(high, floorDiv(hunk.end + hunks[i + 1].start, 2));
    windows.push([low, Math.max(low, high)]);
  });
  return windows;
}

export const ROW_PREFIX = 2 + 5 + 1 + 1 + 1;
export const ANNOTATION_INDENT = " ".repeat(ROW_PREFIX + 2);

const isAlnum = (c) => c !== "" && /^[\p{L}\p{N}]$/u.test(c);

function paintRegisters(text, registers, row, webs, painter, { target_side }) {
  let rendered = text === null || text === undefined ? "-" : text;
  if (!painter.enabled || text === null || text === undefined) return rendered;
  for (const pair of row.substitutions) {
    const number = webs.get(pairKey(pair));
    if (number === undefined) continue;
    const register = target_side ? pair[0] : pair[1];
    if (!registers.includes(register)) continue;
    for (const token of [`$${register}`, register]) {
      const index = rendered.indexOf(token);
      if (index < 0) continue;
      const trailing = rendered.slice(index + token.length, index + token.length + 1);
      if (isAlnum(trailing)) continue;
      rendered = rendered.slice(0, index) + painter.web(number, token) + rendered.slice(index + token.length);
      break;
    }
  }
  return rendered;
}

function rowLines(rows, { webs, painter, budget, markerOf }) {
  const width = assemblyWidth(rows);
  const lines = [];
  for (const row of rows) {
    const marker = markerOf(row);
    let parts = !row.matched ? annotationParts(row, webs, painter) : [];
    if (!parts.length && !row.matched) parts = [row.classification];
    const target = paintRegisters(row.target, row.target_registers, row, webs, painter, { target_side: true });
    const candidate = paintRegisters(row.candidate, row.candidate_registers, row, webs, painter, { target_side: false });
    const body = `  ${String(row.index).padStart(5)} ${marker} ${visibleLjust(target, width)} | ${visibleLjust(candidate, width)}`;
    lines.push(...wrapAnnotation(body, parts, budget));
  }
  return lines;
}

export function renderHunks(view, { context, max_hunks, painter, budget = 0 }) {
  if (!view.hunks.length) return [];
  const webs = new Map(view.webs.map((w, i) => [pairKey([w.target, w.candidate]), i + 1]));
  const lines = [];
  const shown = max_hunks ? view.hunks.slice(0, max_hunks) : view.hunks;
  const windows = contextWindows(view, shown, { context });
  shown.forEach((hunk, i) => {
    const [start, end] = windows[i];
    lines.push("");
    lines.push(painter.bold(`HUNK ${hunk.hunk}`) + "  " + tokens([["class", hunk.classification], ["rows", rangeText([hunk.start, hunk.end])],
      ["target", rangeText(hunk.target_range)], ["candidate", rangeText(hunk.candidate_range)],
      ["target_bytes", byteRangeText(hunk.target_bytes)], ["candidate_bytes", byteRangeText(hunk.candidate_bytes)]]));
    lines.push(...rowLines(view.rows.slice(start, end + 1), { webs, painter, budget,
      markerOf: (row) => (hunk.start <= row.index && row.index <= hunk.end ? ">" : " ") }));
  });
  if (max_hunks && view.hunks.length > max_hunks) {
    lines.push("", `(${view.hunks.length - max_hunks} further hunk(s) not shown; raise --max-hunks or use --json)`);
  }
  return lines;
}

export function wrapAnnotation(body, parts, budget) {
  if (!parts.length) return [body];
  const joined = parts.join(" ");
  if (!budget || visibleLength(body) + 2 + visibleLength(joined) <= budget) return [`${body}  ${joined}`];
  const lines = [body];
  let current = ANNOTATION_INDENT;
  for (const part of parts) {
    const candidate = current + (current !== ANNOTATION_INDENT ? " " : "") + part;
    if (current !== ANNOTATION_INDENT && visibleLength(candidate) > budget) { lines.push(current); current = ANNOTATION_INDENT + part; }
    else current = candidate;
  }
  lines.push(current);
  return lines;
}

export function renderWebs(view, { painter }) {
  if (!view.webs.length) return [];
  const lines = ["", "WEBS (one consistent substitution may explain many sites)"];
  view.webs.forEach((web, i) => {
    let rows = web.rows.slice(0, 12).map(String).join(",");
    if (web.rows.length > 12) rows += ",...";
    lines.push("  " + painter.web(i + 1, `${web.web}  ${web.target}->${web.candidate}`) + "  " + tokens([["count", web.count], ["rows", rows]]));
  });
  return lines;
}

export function renderRegisterReport(view) {
  const lines = ["", "REGISTER REPORT (per aligned index, matching rows included)"];
  lines.push(`  ${"index".padStart(5)}  ${"class".padEnd(12)}  ${"target".padEnd(24)}  candidate`);
  for (const item of view.registerReport()) {
    const target = item.target.join(",") || "-";
    const candidate = item.candidate.join(",") || "-";
    lines.push(`  ${String(item.index).padStart(5)}  ${item.class.padEnd(12)}  ${target.padEnd(24)}  ${candidate}`);
  }
  return lines;
}

/** Parse `850-875` / `863` selectors into inclusive row ranges. */
export function parseRowRanges(values) {
  const ranges = [];
  for (const value of values) {
    const text = strip(value);
    const dash = text.indexOf("-");
    const lowText = dash < 0 ? text : text.slice(0, dash), highText = dash < 0 ? "" : text.slice(dash + 1);
    const asInt = (s) => (/^\s*[-+]?\d+\s*$/.test(s) ? parseInt(s, 10) : NaN);
    const low = asInt(lowText), high = dash >= 0 ? asInt(highText) : low;
    if (Number.isNaN(low) || Number.isNaN(high)) throw new ValueError(`row selector must be N or LOW-HIGH, not ${strRepr(value)}`);
    if (low < 0 || high < 0) throw new ValueError(`row selector must not be negative: ${strRepr(value)}`);
    if (high < low) throw new ValueError(`row selector must not run backwards: ${strRepr(value)}`);
    ranges.push([low, high]);
  }
  return ranges;
}

function windowClasses(rows) {
  const seen = [];
  for (const row of rows) if (!row.matched && !seen.includes(row.classification)) seen.push(row.classification);
  return seen;
}

/** Render the named aligned rows, in full, side by side. */
export function renderWindow(view, ranges, { painter, budget = 0 }) {
  const webs = new Map(view.webs.map((w, i) => [pairKey([w.target, w.candidate]), i + 1]));
  const last = view.rows.length - 1;
  const lines = [];
  for (const [low, high] of ranges) {
    lines.push("");
    if (low > last) { lines.push(`ROWS ${low}-${high}  (past the end: the alignment holds ${view.rows.length} row(s), 0-${last})`); continue; }
    const end = Math.min(high, last);
    const selected = view.rows.slice(low, end + 1);
    const differing = selected.filter((r) => !r.matched).length;
    let header = tokens([["count", selected.length], ["differing", differing], ["classes", windowClasses(selected).join(",") || "-"]]);
    if (end < high) header += `  (clamped to the last row, ${last})`;
    lines.push(painter.bold(`ROWS ${low}-${end}`) + "  " + header);
    lines.push(...rowLines(selected, { webs, painter, budget, markerOf: (row) => (row.matched ? " " : "*") }));
  }
  return lines;
}

/** The selected rows as JSON, in the published row vocabulary. */
export function windowPayload(view, ranges) {
  const last = view.rows.length - 1;
  const selected = [];
  for (const [low, high] of ranges) {
    for (const row of view.rows.slice(low, Math.min(high, last) + 1)) {
      selected.push({ aligned_row: row.index, class: row.classification, matched: row.matched, target: row.target, candidate: row.candidate,
        target_address: row.target_address, candidate_address: row.candidate_address, target_registers: [...row.target_registers],
        candidate_registers: [...row.candidate_registers], substitutions: row.substitutions.map((p) => [...p]) });
    }
  }
  return { schema: WINDOW_SCHEMA, symbol: view.symbol, target: view.target, candidate: view.candidate, aligned_rows: view.aligned_rows,
    requested_rows: ranges.map((r) => [...r]), row_count: selected.length, differing: selected.filter((r) => !r.matched).length, rows: selected };
}

/** Render the whole screen as lines of monochrome-safe text. */
export function renderView(view, { context = 2, max_hunks = 20, lane_window = 32, report_regs = false, painter = null,
  show_warnings = true, width = 0, terse = false, extra_sections = [] } = {}) {
  const brush = painter ?? new Painter(false);
  const lines = show_warnings ? view.warnings.map((w) => `warning: ${w}`) : [];
  lines.push(...renderHeader(view, brush, { terse }));
  if (view.register_first_divergence) {
    lines.push(brush.warn("the FIRST divergence is a register-class divergence, not a structural one: the decision was made upstream of hunk 1 even though it surfaces there."));
  }
  lines.push(...renderLanes(view, { window: lane_window, terse }));
  lines.push(...renderHunks(view, { context, max_hunks, painter: brush, budget: resolveWidth(width) }));
  lines.push(...renderWebs(view, { painter: brush }));
  if (report_regs) lines.push(...renderRegisterReport(view));
  lines.push(...extra_sections);
  lines.push("");
  lines.push(...renderGuidance(view.guidance, { budget: resolveWidth(width) }));
  return lines.map((l) => rstrip(l));
}

/** The `next:` footer, wrapping rather than ellipsizing. */
export function renderGuidance(guidance, { budget = 0 } = {}) {
  const lines = [];
  guidance.forEach((entry, i) => {
    const indent = " ".repeat(entry.length - lstrip(entry, " ").length);
    const lead = (i === 0 ? "next: " : "      ") + indent;
    lines.push(...wrapWords(strip(entry), { lead, budget }));
  });
  return lines;
}

function wrapWords(text, { lead, budget }) {
  if (!budget || visibleLength(lead) + visibleLength(text) <= budget) return [lead + text];
  const continuation = " ".repeat(lead.length + 2);
  const lines = [];
  let current = lead;
  for (const word of text.split(" ")) {
    if (!word) continue;
    const fresh = current === lead || current === continuation;
    const candidate = current + (fresh ? "" : " ") + word;
    if (!fresh && visibleLength(candidate) > budget) { lines.push(current); current = continuation + word; }
    else current = candidate;
  }
  lines.push(current);
  return lines;
}

// Commands

const errText = (e) => (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code) ? osErrorText(e) : e.message);
const reportable = (e) => isInputError(e) || isReportedError(e) || e instanceof SyntaxError;

/** Write the --html / --emit-force-spec outputs; returns the note lines. */
export function writeViewOutputs(view, args, ctx, io, { comparison = null } = {}) {
  const forceOutput = args.emit_force_spec ? expandResolve(args.emit_force_spec, ctx.cwd) : null;
  const htmlOutput = args.html ? expandResolve(args.html, ctx.cwd) : null;
  for (const [output, label] of [[forceOutput, "force specification"], [htmlOutput, "HTML report"]]) {
    if (output !== null && fs.existsSync(output)) throw new OSError(`refusing to overwrite ${label}: ${output}`);
  }
  if (forceOutput !== null) writeForceSpecification(view, forceOutput, { cwd: ctx.cwd });
  if (htmlOutput !== null) {
    fs.mkdirSync(path.dirname(htmlOutput), { recursive: true });
    fs.writeFileSync(htmlOutput, comparison ? renderDiagnosisHtml(view, { comparison, report_regs: args.report_regs }) : renderDiagnosisHtml(view), { flag: "wx" });
    io.eprint(`note: ${htmlOutput} contains the target's disassembly. It is ROM-derived -- keep it out of version control.`);
  }
  return { forceOutput, htmlOutput };
}

function emitView(view, args, predicates, io, ctx) {
  if (args.json && args.html) { io.eprint("error: --json and --html are mutually exclusive"); return 2; }
  const payload = args.json || predicates.length ? view.asDict({ report_regs: args.report_regs }) : {};
  let census;
  try { census = evaluateCensus(predicates, payload); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${e.message}`); return 2; }
  let outputs;
  try { outputs = writeViewOutputs(view, args, ctx, io); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) {
    if (census.length) payload.census = census.map((c) => c.asDict());
    io.print(dumps(payload));
  } else {
    const painter = new Painter(resolveColor(args.color, { env: ctx.env, isatty: !!ctx.terminal?.isTTY }));
    const lines = renderView(view, { context: args.context, max_hunks: args.show_all ? 0 : args.max_hunks,
      lane_window: args.show_all ? Math.max(view.target_instructions, view.candidate_instructions) : args.lane_window,
      report_regs: args.report_regs, painter, width: args.width, terse: args.terse });
    lines.push(...census.map((c) => c.line));
    if (args.html) lines.push(`HTML report: ${outputs.htmlOutput}`);
    if (args.emit_force_spec) lines.push(`diagnostic force specification: ${outputs.forceOutput}`);
    emitLines(io, lines, { width: args.width, pager: args.pager });
  }
  const mismatched = args.fail_on_mismatch && !["exact", "words-identical"].includes(view.verdict);
  return censusStatus(census, { otherwise: mismatched ? 1 : 0 });
}

const symbolOf = (args) => (args.symbol ? String(args.symbol) : null);
const res = (ctx, p) => (p === null || p === undefined ? null : expandResolve(p, ctx.cwd));

export async function viewCommand(args, io, ctx) {
  const symbol = symbolOf(args);
  let predicates, view;
  try { predicates = parseCensus(args.census, { allowed: VIEW_CENSUS_KEYS }); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${e.message}`); return 2; }
  try {
    const [tText, target] = dumpObject(args.target, { objdump: args.objdump, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    const [cText, candidate] = dumpObject(args.candidate, { objdump: args.objdump, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    const warnings = selectionWarnings(tText, cText, { symbol, target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(args.candidate, ctx.cwd), section: args.section });
    view = buildView(target, candidate, { target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(args.candidate, ctx.cwd), symbol,
      register_profile: args.register_profile, warnings,
      target_reservations: loadReservations(res(ctx, args.target_reservations), ctx.resolve(args.target), symbol),
      candidate_reservations: loadReservations(res(ctx, args.candidate_reservations), ctx.resolve(args.candidate), symbol) });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  return emitView(view, args, predicates, io, ctx);
}

export async function viewDumpsCommand(args, io, ctx) {
  const symbol = symbolOf(args);
  let predicates, tText, cText, view;
  try { predicates = parseCensus(args.census, { allowed: VIEW_CENSUS_KEYS }); } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${e.message}`); return 2; }
  try { tText = fs.readFileSync(ctx.resolve(args.target), "utf8"); cText = fs.readFileSync(ctx.resolve(args.candidate), "utf8"); }
  catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  const target = parseSelectedDisassembly(tText, { symbol }), candidate = parseSelectedDisassembly(cText, { symbol });
  if (!target.length || !candidate.length) {
    io.eprint("error: " + symbolSelectionError(symbol, { inputs: [[displayPath(args.target, ctx.cwd), tText], [displayPath(args.candidate, ctx.cwd), cText]] }));
    return 2;
  }
  const warnings = selectionWarnings(tText, cText, { symbol, target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(args.candidate, ctx.cwd) });
  try {
    view = buildView(target, candidate, { target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(args.candidate, ctx.cwd), symbol,
      register_profile: args.register_profile, warnings,
      target_reservations: loadReservations(res(ctx, args.target_reservations), ctx.resolve(args.target), symbol),
      candidate_reservations: loadReservations(res(ctx, args.candidate_reservations), ctx.resolve(args.candidate), symbol) });
  } catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  return emitView(view, args, predicates, io, ctx);
}

function windowView(args, ctx) {
  const symbol = symbolOf(args);
  let target, candidate, warning;
  if (args.objdump !== null && args.objdump !== undefined || "section" in args) {
    let tText, cText;
    [tText, target] = dumpObject(args.target, { objdump: args.objdump ?? null, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    [cText, candidate] = dumpObject(args.candidate, { objdump: args.objdump ?? null, symbol, section: args.section, cwd: ctx.cwd, env: ctx.env });
    warning = crossFunctionWarning(tText, cText, { symbol, section: args.section });
  } else {
    const tText = fs.readFileSync(ctx.resolve(args.target), "utf8"), cText = fs.readFileSync(ctx.resolve(args.candidate), "utf8");
    target = parseSelectedDisassembly(tText, { symbol });
    candidate = parseSelectedDisassembly(cText, { symbol });
    if (!target.length || !candidate.length) throw new ValueError(symbolSelectionError(symbol, { inputs: [[displayPath(args.target, ctx.cwd), tText], [displayPath(args.candidate, ctx.cwd), cText]] }));
    warning = crossFunctionWarning(tText, cText, { symbol });
  }
  return buildView(target, candidate, { target_name: displayPath(args.target, ctx.cwd), candidate_name: displayPath(args.candidate, ctx.cwd), symbol,
    register_profile: args.register_profile, warnings: warning ? [warning] : [] });
}

export async function windowCommand(args, io, ctx) {
  let ranges, view;
  try { ranges = parseRowRanges(args.rows); view = windowView(args, ctx); }
  catch (e) { if (!reportable(e)) throw e; io.eprint(`error: ${errText(e)}`); return 2; }
  if (args.json) { io.print(dumps(windowPayload(view, ranges))); return 0; }
  const painter = new Painter(resolveColor(args.color, { env: ctx.env, isatty: !!ctx.terminal?.isTTY }));
  const lines = view.warnings.map((w) => `warning: ${w}`);
  lines.push(tokens([["aligned_rows", view.aligned_rows], ["target", view.target], ["candidate", view.candidate]]));
  lines.push(...renderWindow(view, ranges, { painter, budget: resolveWidth(args.width) }));
  emitLines(io, lines.map((l) => rstrip(l)), { width: args.width, pager: args.pager });
  return 0;
}

function sharedArguments(objectInputs) {
  return [
    ...O.symbolArgument({ help: "view only this exact symbol; --function is the same option" }),
    ...O.explainKeysArgument(),
    ...(objectInputs ? [{ flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" }] : []),
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
    ...O.viewRenderArguments(),
    ...O.viewOutputArguments(),
    { flags: ["--fail-on-mismatch"], action: "store_true", help: "return exit 1 unless the verdict is exact or words-identical" },
    ...O.censusArgument(),
  ];
}

function windowArguments(objectInputs) {
  return [
    ...O.symbolArgument({ help: "window only this exact symbol; --function is the same option" }),
    { flags: ["--rows"], action: "append", required: true, metavar: "LOW-HIGH",
      help: "aligned rows to print, as N or LOW-HIGH; repeatable. These are the numbers `compare --json` reports as aligned_row and `view` prints beside every row" },
    ...(objectInputs ? [{ flags: ["--section"], default: ".text", help: "object section (default: .text)" },
      { flags: ["--objdump"], help: "GNU-compatible MIPS objdump; auto-detected when omitted" }] : []),
    ...O.explainKeysArgument(),
    { flags: ["--json"], action: "store_true", help: "emit JSON" },
    { flags: ["--register-profile"], default: DEFAULT_REGISTER_PROFILE, choices: Object.keys(REGISTER_CLASS_PROFILES).sort(),
      help: `compiler era whose register class table names a substitution (default: ${DEFAULT_REGISTER_PROFILE})` },
    ...O.colorArgument(),
    ...O.terminalArguments(),
  ];
}

const WINDOW_DESCRIPTION = "Print the named aligned rows of two disassemblies side by side, "
  + "marking every row that differs. The row numbers are the ones "
  + "`compare --json` publishes as aligned_row and `view` prints beside "
  + "each row, so a number quoted in a dossier is the number to type.";

export const COMMAND_SPECS = [
  { path: ["view"], handler: viewCommand, help: "aligned mechanism view of a target and candidate object",
    description: "LCS-aligned diagnosis: taxonomy verdict, classified hunks, per-class register lanes, prefix signature, and the lever family for the dominant class.",
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidate", help: "candidate object" }, ...sharedArguments(true)] },
  { path: ["view-dumps"], handler: viewDumpsCommand, help: "aligned mechanism view from retained GNU objdump text",
    description: "Run the aligned mechanism view on redistributable objdump text, so every visualization works without object files.",
    arguments: [{ dest: "target", help: "reference objdump text" }, { dest: "candidate", help: "candidate objdump text" }, ...sharedArguments(false)] },
  { path: ["window"], handler: windowCommand, help: "print named aligned rows of two objects side by side", description: WINDOW_DESCRIPTION,
    defaults: { report_command: "window" },
    arguments: [{ dest: "target", help: "reference object" }, { dest: "candidate", help: "candidate object" }, ...windowArguments(true)] },
  { path: ["window-dumps"], handler: windowCommand, help: "print named aligned rows from retained GNU objdump text", description: WINDOW_DESCRIPTION,
    defaults: { report_command: "window-dumps" },
    arguments: [{ dest: "target", help: "reference objdump text" }, { dest: "candidate", help: "candidate objdump text" }, ...windowArguments(false)] },
];
