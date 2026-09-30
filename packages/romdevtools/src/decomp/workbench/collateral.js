// collateral.js - translation-unit collateral beyond one selected function:
// section sizes (zero-fill included), contents, relocations and symbols, so a
// function-level match cannot hide a whole-object change.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runProgramSync } from "./proc.js";
import { createHash } from "node:crypto";
import { compareObjects } from "./compare.js";
import { canonicalTable, sectionBytes } from "./fidelity.js";
import { discoverObjdump } from "./objdump.js";
import { ValueError, splitlines, strip, sorted, strRepr, pyEq } from "./py.js";
import { FileNotFoundError, RuntimeError } from "./py-extra.js";

export const COLLATERAL_SCHEMA = "decomp-workbench-object-collateral-v1";
export const DEFAULT_IGNORES = Object.freeze([".debug*", ".mdebug*", ".comment", ".note*"]);
const SECTION_RE = /^\s*\d+\s+(?<name>\S+)\s+(?<size>[0-9a-fA-F]+)\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+2\*\*(?<alignment>\d+)\s*$/;

/** fnmatch.fnmatchcase(name, pattern). */
export function fnmatchcase(name, pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const j = pattern.indexOf("]", i + 2);
      if (j < 0) { re += "\\["; continue; }
      let body = pattern.slice(i + 1, j);
      if (body.startsWith("!")) body = "^" + body.slice(1);
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = j;
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`, "s").test(name);
}

const ignored = (name, patterns) => patterns.some((p) => fnmatchcase(name, p));

/** Run objdump; an absent optional section is stable evidence, not a failure. */
function run(executable, args, { timeout, env }) {
  const r = runProgramSync([executable, ...args], { encoding: "utf8", timeout: timeout * 1000, env });
  if (r.error) {
    if (r.error.code === "ETIMEDOUT") throw new RuntimeError(`objdump ${args.join(" ")} timed out after ${timeout} seconds`);
    throw r.error;
  }
  if (r.status) {
    const diagnostic = strip(r.stderr) || strip(r.stdout);
    if (diagnostic.includes("section") && diagnostic.includes("not found")) return "";
    throw new RuntimeError(`objdump ${args.join(" ")} failed with exit ${r.status}: ${diagnostic}`);
  }
  return r.stdout;
}

const expandResolve = (p, cwd) => { const e = p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p; const a = path.resolve(cwd, e); try { return fs.realpathSync(a); } catch { return a; } };
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Section sizes, flags and content hashes, including zero-fill sections. */
export function objectSectionInventory(p, { objdump = null, ignore = DEFAULT_IGNORES, timeout = 10.0, cwd = process.cwd(), env = process.env } = {}) {
  const objectPath = expandResolve(String(p), cwd);
  let isFile = false;
  try { isFile = fs.statSync(objectPath).isFile(); } catch {}
  if (!isFile) throw new FileNotFoundError(`object does not exist: ${objectPath}`);
  const executable = discoverObjdump(objdump, { cwd, env });
  const lines = splitlines(run(executable, ["-h", objectPath], { timeout, env }));
  const result = new Map();
  lines.forEach((line, index) => {
    const m = SECTION_RE.exec(line);
    if (!m) return;
    const name = m.groups.name;
    if (ignored(name, ignore)) return;
    if (result.has(name)) throw new ValueError(`object has duplicate in-scope section name ${strRepr(name)}: ${objectPath}`);
    let flags = [];
    if (index + 1 < lines.length && !SECTION_RE.test(lines[index + 1])) flags = lines[index + 1].split(",").map((x) => strip(x)).filter(Boolean);
    const hasContents = flags.includes("CONTENTS");
    const content = hasContents ? sectionBytes(run(executable, ["-s", "-j", name, objectPath], { timeout, env })) : Buffer.alloc(0);
    const size = parseInt(m.groups.size, 16);
    if (hasContents && content.length !== size) throw new ValueError(`objdump returned ${content.length} of ${size} byte(s) for section ${strRepr(name)}: ${objectPath}`);
    result.set(name, { size, alignment: 2 ** parseInt(m.groups.alignment, 10), flags, has_contents: hasContents, content_sha256: hasContents ? sha(content) : null });
  });
  return result;
}

function tableHash(executable, p, option, { timeout, env }) { return sha(canonicalTable(run(executable, [option, p], { timeout, env }))); }

/** Report full-object changes that a function-only comparison cannot see. */
export function compareObjectCollateral(reference, candidate, { symbol = null, section = ".text", objdump = null, ignore = DEFAULT_IGNORES, timeout = 10.0, cwd = process.cwd(), env = process.env } = {}) {
  const referencePath = expandResolve(String(reference), cwd), candidatePath = expandResolve(String(candidate), cwd);
  const executable = discoverObjdump(objdump, { cwd, env });
  const before = objectSectionInventory(referencePath, { objdump: executable, ignore, timeout, cwd, env });
  const after = objectSectionInventory(candidatePath, { objdump: executable, ignore, timeout, cwd, env });
  if (!before.size || !after.size) throw new ValueError("objdump returned no in-scope sections; verify --objdump and --ignore-section before treating this as a collateral result");
  const changes = [];
  for (const name of sorted([...new Set([...before.keys(), ...after.keys()])])) {
    const expected = before.get(name) ?? null, actual = after.get(name) ?? null;
    const changed = [];
    if (expected === null || actual === null) changed.push("presence");
    else for (const f of ["size", "alignment", "flags", "content_sha256"]) if (!pyEq(expected[f], actual[f])) changed.push(f);
    if (changed.length) changes.push({ section: name, changed, size_delta: (actual ? actual.size : 0) - (expected ? expected.size : 0), reference: expected, candidate: actual });
  }
  const relocationsIdentical = tableHash(executable, referencePath, "-r", { timeout, env }) === tableHash(executable, candidatePath, "-r", { timeout, env });
  const symbolsIdentical = tableHash(executable, referencePath, "-t", { timeout, env }) === tableHash(executable, candidatePath, "-t", { timeout, env });
  let fn = null, fnExact = null;
  if (symbol !== null && symbol !== undefined) {
    const comparison = compareObjects(referencePath, candidatePath, { objdump: executable, symbol, section, cwd, env });
    fn = comparison.asDict();
    fnExact = comparison.raw_word_mismatches === 0 && comparison.relocation_target_mismatches === 0 && comparison.exact;
  }
  const detected = Boolean(changes.length || !relocationsIdentical || !symbolsIdentical);
  const classification = !detected ? "none" : fnExact ? "outside-selected-function" : "translation-unit-difference";
  return {
    schema: COLLATERAL_SCHEMA, reference: referencePath, candidate: candidatePath, selected_symbol: symbol ?? null, selected_function_exact: fnExact,
    selected_function: fn, classification, collateral_detected: detected, ignored_sections: [...ignore], section_changes: changes,
    section_change_count: changes.length, relocations_identical: relocationsIdentical, symbol_table_identical: symbolsIdentical,
    proof: "Section sizes include zero-fill sections such as .bss; content, relocation, and symbol-table checks are translation-unit evidence. "
      + "Selected-function exactness remains a separate gate and does not establish whole-object or whole-ROM identity.",
    next_gate: detected ? "Remove or explain the listed translation-unit changes, then run the normal project link/ROM verification." : "Run the normal project link/ROM verification.",
  };
}
