// instrument-gate.js - the identity gate, recorded. An instrumented compiler
// is only worth reading if, with tracing off, it emits the same object the
// stock compiler does. The comparison is fidelity.js's (section-scoped,
// because stock IDO under -g3 is not file-level reproducible); what this adds
// is a durable stamp naming the profile, both objects and their hashes, the
// sections gated and the objdump that read them, plus --verify, which re-runs
// the comparison rather than trusting the record.
//
// The workbench does not build compilers; both objects come from the
// project's own build.
//
// Plain JS ESM + JSDoc.

import { existsSync, readFileSync, writeFileSync, statSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ValueError, strRepr } from "./py.js";
import { dumps } from "./pyjson.js";
import { DEFAULT_SECTIONS, compareObjectFidelity } from "./fidelity.js";
import { fileSha256 } from "./campaign.js";

export const GATE_SCHEMA = "decomp-workbench-instrument-gate-v1";

export const GATE_CLAIM = "With tracing off, the instrumented pass emitted the same .text, .rodata, "
  + ".data, relocations and symbol table as the stock pass, for these two "
  + "objects only. It says nothing about any other translation unit, about the "
  + "instrumented pass with tracing on, or about the record grammar its traces "
  + "use.";

/** The gate could not be run, stamped, or verified. */
export class InstrumentGateError extends ValueError {}

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const resolved = (p) => { const a = path.resolve(p); try { return realpathSync(a); } catch { return a; } };

function now() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

/** Run the section-scoped comparison and return the stamp it earns. */
export function buildStamp({ stock, instrumented, profile, objdump = null, sections = DEFAULT_SECTIONS, timeout = 10.0, note = "", env = process.env }) {
  const stockPath = expandUser(String(stock)), instrumentedPath = expandUser(String(instrumented));
  for (const [label, p] of [["--stock", stockPath], ["--instrumented", instrumentedPath]]) {
    if (!isFile(p)) {
      throw new InstrumentGateError(`${label} does not exist: ${p}. The gate compares two objects somebody else already built -- the workbench does not build compilers.`);
    }
  }
  if (!profile.trim()) {
    throw new InstrumentGateError("--profile names which instrumented pass this stamp is about, e.g. --profile uopt-cdx. A stamp with no profile cannot be looked up.");
  }
  const report = compareObjectFidelity(stockPath, instrumentedPath, { objdump, sections, timeout, env });
  return {
    schema: GATE_SCHEMA, profile: profile.trim(), recorded: now(), pass: !!report.pass, gates: { ...report.gates },
    sections: [...sections], objdump: report.stock.objdump,
    stock: { path: resolved(stockPath), sha256: fileSha256(stockPath) },
    instrumented: { path: resolved(instrumentedPath), sha256: fileSha256(instrumentedPath) },
    file_identical: !!report.file_identical, note, claim: GATE_CLAIM,
  };
}

/** Write one stamp, refusing to create a directory nobody named. */
export function writeStamp(stamp, { path: target }) {
  const parent = path.dirname(target);
  if (parent && !existsSync(parent)) {
    throw new InstrumentGateError(`${parent} does not exist. Name a directory that does: the workbench does not invent a place to keep gate records.`);
  }
  writeFileSync(target, dumps(stamp) + "\n", "utf8");
  return target;
}

export function readStamp(location) {
  let text;
  try { text = readFileSync(location, "utf8"); } catch (e) { throw new InstrumentGateError(`cannot read the stamp ${location}: ${e.message}`); }
  let payload;
  try { payload = JSON.parse(text); } catch (e) { throw new InstrumentGateError(`${location} is not valid JSON: ${e.message}`); }
  const schema = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.schema ?? null : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || schema !== GATE_SCHEMA) {
    throw new InstrumentGateError(`${location} is not a ${GATE_SCHEMA} document (schema=${strRepr(schema)})`);
  }
  return payload;
}

/** Re-run the gate the stamp records, and report what changed. */
export function verifyStamp(location, { objdump = null, timeout = 10.0, env = process.env } = {}) {
  const stamp = readStamp(location);
  const findings = [], moved = [];
  for (const side of ["stock", "instrumented"]) {
    const recorded = stamp[side] || {};
    const objectPath = String(recorded.path ?? "");
    if (!isFile(objectPath)) { moved.push(`${side} object ${objectPath || "."} is gone`); continue; }
    const current = fileSha256(objectPath);
    if (current !== recorded.sha256) {
      moved.push(`${side} object ${objectPath} has changed since the stamp (${String(recorded.sha256 ?? "?").slice(0, 16)} -> ${current.slice(0, 16)})`);
    }
  }
  if (moved.length) return { schema: GATE_SCHEMA, verification: "STALE", pass: false, stamp, findings: moved, claim: GATE_CLAIM };
  const fresh = buildStamp({ stock: stamp.stock.path, instrumented: stamp.instrumented.path, profile: stamp.profile, objdump,
    sections: stamp.sections && stamp.sections.length ? stamp.sections : DEFAULT_SECTIONS, timeout, env });
  for (const [gate, passed] of Object.entries(fresh.gates)) {
    const was = stamp.gates?.[gate];
    if (passed !== was) findings.push(`${gate}: the stamp recorded ${was ? "PASS" : "FAIL"}, the rerun reports ${passed ? "PASS" : "FAIL"}`);
  }
  return { schema: GATE_SCHEMA, verification: findings.length ? "DISAGREES" : "AGREES", pass: !!fresh.pass && !findings.length,
    stamp, rerun: fresh, findings, claim: GATE_CLAIM };
}

/** Render one gate result for a terminal. */
export function gateLines(stamp, { stamp_path = null } = {}) {
  const lines = [
    `instrument gate: ${stamp.pass ? "PASS" : "FAIL"}  profile=${stamp.profile}`,
    `stock:        ${stamp.stock.path}  sha256 ${stamp.stock.sha256.slice(0, 16)}`,
    `instrumented: ${stamp.instrumented.path}  sha256 ${stamp.instrumented.sha256.slice(0, 16)}`,
    "",
  ];
  for (const [gate, passed] of Object.entries(stamp.gates)) lines.push(`  ${gate.padEnd(14)} ${passed ? "PASS" : "FAIL"}`);
  if (stamp.pass && !stamp.file_identical) {
    lines.push("", "note: the gated sections agree and the whole files do not. That is expected -- stock IDO under -g3 is not file-level reproducible, and .mdebug varies between runs of the unmodified compiler.");
  }
  if (!stamp.pass) {
    lines.push("", "This instrument's traces are not evidence about the stock compiler. Fix the instrumentation until the disabled build is byte-identical, then gate again.");
  }
  if (stamp_path !== null && stamp_path !== undefined) lines.push("", `stamped: ${stamp_path}`);
  lines.push("", `claim: ${stamp.claim}`);
  return lines;
}

/** Render a --verify result. */
export function verificationLines(result) {
  const stamp = result.stamp;
  const lines = [`instrument gate: ${result.verification}  profile=${stamp.profile}  recorded ${stamp.recorded}`];
  if (result.findings.length) {
    lines.push("", ...result.findings.map((f) => `  ${f}`), "", "The stamp no longer describes what is on disk. Re-run the gate against the objects you actually have.");
  } else lines.push("", "  the rerun agrees with the stamp on every gated section");
  lines.push("", `claim: ${stamp.claim}`);
  return lines;
}
