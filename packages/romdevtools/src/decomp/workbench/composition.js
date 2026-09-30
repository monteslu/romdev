// composition.js - bounded, text-exact composition of independently
// observed source mechanisms (`experiment compose`), the fake-match syntax
// inventory (`experiment inspect-source`), and the mutation review that sits
// between "scores well" and "is the same program" (`experiment
// review-mutation`). Every one of them is a text analysis and says so.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, sorted, strRepr, splitlines, counter } from "./py.js";
import { FileNotFoundError } from "./py-extra.js";
import { resolvePath, expanduser, osError, isDir } from "./py-path.js";
import * as csource from "./csource.js";
import { SweepCoverage } from "./coverage.js";
import { SequenceMatcher, unifiedDiff } from "./difflib.js";
import { dumps } from "./pyjson.js";

export const COMPOSITION_SCHEMA = "decomp-workbench-composition-v1";
export const SOURCE_INSPECTION_SCHEMA = "decomp-workbench-source-inspection-v1";
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATIC_LOCAL_RE = /^\s+static\s+[^;]+;\s*$/;
const EMPTY_CONTROL_RE = /\b(if|for|while)\s*\([^;{}]*\)\s*\{\s*\}\s*;?\s*$/;
const ZERO_ARITHMETIC_RE = /(?:\b[A-Za-z_]\w*\s*[*&]\s*0\b|\b0\s*[*&]\s*[A-Za-z_]\w*\b)/;
const SELF_CANCEL_RE = /\b(?<left>[A-Za-z_]\w*)\s*(?:-|\^)\s*\k<left>\b/;

const sha256 = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const utf8Len = (s) => Buffer.byteLength(s, "utf8");
const isPyInt = (v) => Number.isInteger(v) || typeof v === "boolean";
const asInt = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : v);

export class TextEdit { constructor(find, replace, occurrences) { Object.assign(this, { find, replace, occurrences }); Object.freeze(this); } }
export class Transformation {
  constructor({ identifier, family, description, edits, conflicts, requires }) { Object.assign(this, { identifier, family, description, edits, conflicts, requires }); Object.freeze(this); }
}
export class CompositionSpec {
  constructor({ path: p, baseline, transformations, max_order, max_candidates }) { Object.assign(this, { path: p, baseline, transformations, max_order, max_candidates }); Object.freeze(this); }
}

/** Read UTF-8 source without normalizing line endings. */
export function readSource(p) { return fs.readFileSync(p, "utf8"); }

function resolveFrom(root, value, field) {
  if (typeof value !== "string" || !value) throw new ValueError(`composition ${field} must be a non-empty path`);
  const p = expanduser(value);
  return resolvePath(path.isAbsolute(p) ? p : path.join(root, p));
}

export function loadComposition(p) {
  const manifestPath = resolvePath(p);
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== COMPOSITION_SCHEMA) throw new ValueError(`composition schema must be ${COMPOSITION_SCHEMA}`);
  const baseline = resolveFrom(path.dirname(manifestPath), value.baseline, "baseline");
  let isFile = false;
  try { isFile = fs.statSync(baseline).isFile(); } catch {}
  if (!isFile) throw new FileNotFoundError(`composition baseline does not exist: ${baseline}`);
  const raw = value.transformations;
  if (!Array.isArray(raw) || !raw.length) throw new ValueError("composition transformations must be a non-empty list");
  const transformations = [];
  const ids = new Set();
  raw.forEach((t, index) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new ValueError(`composition transformation ${index} must be an object`);
    const identifier = t.id;
    if (typeof identifier !== "string" || !IDENTIFIER_RE.test(identifier)) throw new ValueError(`composition transformation ${index} id must be filename-safe`);
    if (ids.has(identifier)) throw new ValueError(`composition transformation id is duplicated: ${identifier}`);
    ids.add(identifier);
    const family = t.family;
    if (typeof family !== "string" || !family.trim()) throw new ValueError(`composition transformation ${identifier} needs a family`);
    const description = t.description ?? "";
    if (typeof description !== "string") throw new ValueError(`composition transformation ${identifier} description must be text`);
    const rawEdits = t.edits;
    if (!Array.isArray(rawEdits) || !rawEdits.length) throw new ValueError(`composition transformation ${identifier} needs at least one edit`);
    const edits = rawEdits.map((e, ei) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) throw new ValueError(`composition transformation ${identifier} edit ${ei} must be an object`);
      const find = e.find, replace = e.replace ?? "", occurrences = e.occurrences ?? 1;
      if (typeof find !== "string" || !find) throw new ValueError(`composition transformation ${identifier} edit ${ei} find must be non-empty text`);
      if (typeof replace !== "string") throw new ValueError(`composition transformation ${identifier} edit ${ei} replace must be text`);
      if (!isPyInt(occurrences) || asInt(occurrences) < 1) throw new ValueError(`composition transformation ${identifier} edit ${ei} occurrences must be a positive integer`);
      return new TextEdit(find, replace, asInt(occurrences));
    });
    const conflicts = t.conflicts ?? [], requires = t.requires ?? [];
    if (!Array.isArray(conflicts) || !conflicts.every((x) => typeof x === "string")) throw new ValueError(`composition transformation ${identifier} conflicts must be ids`);
    if (!Array.isArray(requires) || !requires.every((x) => typeof x === "string")) throw new ValueError(`composition transformation ${identifier} requires must be ids`);
    transformations.push(new Transformation({ identifier, family, description, edits, conflicts: new Set(conflicts), requires: new Set(requires) }));
  });
  const known = new Set(transformations.map((t) => t.identifier));
  for (const t of transformations) {
    const unknown = [...new Set([...t.conflicts, ...t.requires])].filter((x) => !known.has(x));
    if (unknown.length) throw new ValueError(`composition transformation ${t.identifier} references unknown id(s): ${sorted(unknown).join(", ")}`);
  }
  const maxOrder = value.max_order ?? 2, maxCandidates = value.max_candidates ?? 256;
  if (!isPyInt(maxOrder) || !(asInt(maxOrder) >= 1 && asInt(maxOrder) <= transformations.length)) throw new ValueError("composition max_order must be between 1 and transform count");
  if (!isPyInt(maxCandidates) || asInt(maxCandidates) < 1) throw new ValueError("composition max_candidates must be a positive integer");
  return new CompositionSpec({ path: manifestPath, baseline, transformations, max_order: asInt(maxOrder), max_candidates: asInt(maxCandidates) });
}

function validCombination(items) {
  const selected = new Set(items.map((i) => i.identifier));
  return items.every((i) => ![...i.conflicts].some((c) => selected.has(c)) && [...i.requires].every((r) => selected.has(r)));
}

const countOf = (text, find) => text.split(find).length - 1;
function replaceFirst(text, find, replacement, n) {
  let out = "", rest = text;
  for (let k = 0; k < n; k++) { const i = rest.indexOf(find); if (i < 0) break; out += rest.slice(0, i) + replacement; rest = rest.slice(i + find.length); }
  return out + rest;
}

function applyItems(text, items) {
  let result = text;
  for (const t of items) {
    for (const e of t.edits) {
      const observed = countOf(result, e.find);
      if (observed !== e.occurrences) throw new ValueError(`${t.identifier}: expected ${e.occurrences} occurrence(s), found ${observed}: ${strRepr(e.find)}`);
      result = replaceFirst(result, e.find, e.replace, e.occurrences);
    }
  }
  return result;
}

function comb(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }

function* combinations(items, size) {
  const idx = Array.from({ length: size }, (_, i) => i);
  const n = items.length;
  if (size > n) return;
  for (;;) {
    yield idx.map((i) => items[i]);
    let i = size - 1;
    while (i >= 0 && idx[i] === i + n - size) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Generate a bounded interaction set and a campaign-compatible manifest. */
export function composeSources(spec, output, { max_order = null, max_candidates = null, step = 1, write = true } = {}) {
  const order = max_order === null ? spec.max_order : max_order;
  const cap = max_candidates === null ? spec.max_candidates : max_candidates;
  if (!(order >= 1 && order <= spec.transformations.length)) throw new ValueError("--max-order must be between 1 and transform count");
  if (step < 1) throw new ValueError(`--step must be at least 1, got ${step}`);
  let planned = 0;
  for (let size = 1; size <= order; size++) planned += comb(spec.transformations.length, size);
  const sampled = planned > 0 ? Math.ceil(planned / step) : 0;
  if (sampled > cap) {
    throw new ValueError(`composition plans ${planned} combinations` + (step > 1 ? ` (${sampled} at step ${step})` : "")
      + `, above cap ${cap}; lower --max-order, raise --step to sample the space, or raise --max-candidates explicitly`);
  }
  const outputPath = resolvePath(output);
  if (write && fs.existsSync(outputPath)) {
    if (!isDir(outputPath) || fs.readdirSync(outputPath).length) throw osError(`composition output is not empty: ${outputPath}`, "EEXIST");
  }
  const baselineText = readSource(spec.baseline);
  const baselineLines = splitlines(baselineText).length;
  const baselineBytes = utf8Len(baselineText);
  const suffix = path.extname(spec.baseline) || ".c";
  const candidates = [], rejected = [];
  let excluded = 0, ordinal = 0;
  for (let size = 1; size <= order; size++) {
    for (const items of combinations(spec.transformations, size)) {
      const take = ordinal % step === 0;
      ordinal++;
      if (!take) continue;
      if (!validCombination(items)) { excluded += 1; continue; }
      const identifiers = items.map((i) => i.identifier);
      let source;
      try { source = applyItems(baselineText, items); } catch (e) {
        if (e.name !== "ValueError") throw e;
        rejected.push({ transformations: identifiers, error: e.message });
        continue;
      }
      candidates.push({ transformations: identifiers, families: sorted([...new Set(items.map((i) => i.family))]), source_text: source,
        source_sha256: sha256(source), source_bytes: utf8Len(source), byte_delta: utf8Len(source) - baselineBytes,
        line_delta: splitlines(source).length - baselineLines });
    }
  }
  if (!candidates.length) {
    const detail = rejected.length ? `; ${rejected.length} combination(s) failed exact edits` : "";
    throw new ValueError(`composition produced no valid candidates; review max_order, requires, and conflicts${detail}`);
  }
  if (write) {
    fs.mkdirSync(outputPath, { recursive: true });
    const baselineName = `baseline${suffix}`;
    fs.copyFileSync(spec.baseline, path.join(outputPath, baselineName));
    const experimentCandidates = [];
    candidates.forEach((item, i) => {
      const name = `${String(i + 1).padStart(3, "0")}-${item.transformations.join("+")}${suffix}`;
      fs.writeFileSync(path.join(outputPath, name), item.source_text, "utf8");
      item.source = name;
      experimentCandidates.push({ source: name, parameters: Object.fromEntries(spec.transformations.map((t) => [t.identifier, item.transformations.includes(t.identifier)])) });
    });
    const experiment = { schema: "decomp-workbench-experiment-v1", family: "bounded-mechanism-composition", baseline: baselineName,
      parameters: Object.fromEntries(spec.transformations.map((t) => [t.identifier, [false, true]])), candidates: experimentCandidates,
      composition_source: spec.path };
    fs.writeFileSync(path.join(outputPath, "experiment.json"), dumps(experiment) + "\n", "utf8");
  }
  const crossFamily = candidates.filter((c) => c.families.length > 1).length;
  const coverage = new SweepCoverage({ basis: `subsets of ${spec.transformations.length} transformation(s) up to order ${order}`,
    space: planned, covered: candidates.length + rejected.length, step, excluded });
  return {
    coverage: coverage.asDict(), schema: COMPOSITION_SCHEMA, spec: spec.path, baseline: spec.baseline,
    baseline_sha256: sha256(baselineText), baseline_bytes: baselineBytes,
    output: write ? outputPath : null, planned_output: outputPath, write, max_order: order, candidate_cap: cap,
    planned_combinations: planned, excluded_by_constraints: excluded, rejected_combinations: rejected,
    generated_candidates: candidates.length, cross_family_candidates: crossFamily,
    candidates: candidates.map(({ source_text, ...rest }) => rest),
    proof: "Exact literal edits were composed in declared order. No source semantics, compiler effect, function exactness, or plausibility is inferred until the generated candidates are compiled.",
    next_steps: [
      write ? `decomp-workbench experiment validate ${path.join(outputPath, "experiment.json")}` : "Re-run without --dry-run to write the candidate set.",
      "Run decomp-workbench campaign with the stock compiler and --no-stop-on-exact.",
      "Keep only candidates that pass raw-word, relocation-target, frame, and translation-unit collateral gates.",
    ],
  };
}

const QUESTIONS = {
  "function-scope-static-candidate": "Does this object carry program state, or only affect storage and allocation? Group its declaration and every use in one measured edit.",
  "empty-control": "Is the condition side-effect-free, and does this physical statement boundary affect line assignment or allocation?",
  "zero-arithmetic": "Are operand evaluation, volatile reads, promotions, and overflow behavior preserved if this is changed?",
  "self-cancelling-arithmetic": "Are repeated evaluations, volatile reads, and signed-overflow behavior preserved if this is changed?",
};

/** Inventory suspicious fake-match constructs without claiming deadness. */
export function inspectSource(p) {
  const sourcePath = resolvePath(p);
  const text = readSource(sourcePath);
  const findings = [];
  const seenLines = new Map();
  splitlines(text).forEach((line, i) => {
    const number = i + 1;
    const stripped = line.trim();
    const kinds = [];
    if (STATIC_LOCAL_RE.test(line)) kinds.push("function-scope-static-candidate");
    if (EMPTY_CONTROL_RE.test(line)) {
      kinds.push("empty-control");
      const key = stripped.replace(/;+$/, "");
      if (!seenLines.has(key)) seenLines.set(key, []);
      seenLines.get(key).push(number);
    }
    if (ZERO_ARITHMETIC_RE.test(line)) kinds.push("zero-arithmetic");
    if (SELF_CANCEL_RE.test(line)) kinds.push("self-cancelling-arithmetic");
    for (const kind of kinds) {
      findings.push({ line: number, kind, source: stripped, claim: "syntactic-candidate-only", safe_automatic_removal: false, review_question: QUESTIONS[kind] });
    }
  });
  const duplicates = sorted([...seenLines.entries()], (e) => e[0]).filter(([, l]) => l.length > 1).map(([source, lines]) => ({ source, lines, count: lines.length }));
  const byKind = counter(findings.map((f) => f.kind));
  const inventory = Object.fromEntries(sorted([...byKind.entries()], (e) => e[0]));
  return {
    schema: SOURCE_INSPECTION_SCHEMA, source: sourcePath, source_sha256: sha256(text), finding_count: findings.length,
    inventory_by_kind: inventory, findings, duplicate_empty_controls: duplicates,
    proof: "Conservative syntax inventory only. A finding may be intentional, load-bearing, or historically correct; removal is never implied.",
    next_gate: "Group declarations with their uses, encode deletion/substitution mechanisms in a composition manifest, then compile every candidate against exact binary and collateral gates.",
    cleanup_gates: [
      "Preserve the exact baseline source/object receipt.",
      "Encode one justified declaration/use or control-shape mechanism per transformation.",
      "Compile the bounded set with the stock lineage and --no-stop-on-exact.",
      "Review every surviving mutation diff; a clean text check is not semantic proof.",
      "Require raw words, relocation targets, instruction count, and frame to remain exact.",
      "Run object collateral and the project's normal link/ROM verification.",
    ],
  };
}

// Mutation review: the gate between "scores well" and "is the same program".

export const MUTATION_REVIEW_SCHEMA = "decomp-workbench-mutation-review-v1";

function firstDefinition(lines, name) { const w = csource.definitionLines(lines, name); return w.length ? w[0] : null; }

/** The first line that uses `name` as a value (a bare declaration is not a use). */
function firstUse(lines, name) {
  for (let i = 0; i < lines.length; i++) {
    if (!csource.identifiers(lines[i]).has(name)) continue;
    if (csource.declaresWithoutInitializer(lines[i], name)) continue;
    return i + 1;
  }
  return null;
}

const reviewFinding = (code, severity, identifier, line, message, action) => ({ code, severity, identifier, line, message, action, claim: "textual-candidate-only" });

function changedLines(base, variant) {
  const removed = [], added = [];
  for (const [tag, i1, i2, j1, j2] of new SequenceMatcher(base, variant).getOpcodes()) {
    if (tag === "equal") continue;
    removed.push(...base.slice(i1, i2));
    added.push(...variant.slice(j1, j2));
  }
  return [removed, added];
}

/** Surface a mutation's diff and the two shapes that invalidate one. */
export function reviewMutation(baseline, variant, { context = 3 } = {}) {
  if (context < 0) throw new ValueError("context must not be negative");
  const baselinePath = resolvePath(baseline), variantPath = resolvePath(variant);
  const baselineText = readSource(baselinePath), variantText = readSource(variantPath);
  const baseLines = splitlines(baselineText), variantLines = splitlines(variantText);
  const diff = unifiedDiff(baseLines, variantLines, { fromfile: baselinePath, tofile: variantPath, lineterm: "", n: context });
  const [removed, added] = changedLines(baseLines, variantLines);
  const before = new Map(), after = new Map();
  const tally = (m, line) => { for (const [k, v] of csource.identifiers(line).entries()) m.set(k, (m.get(k) ?? 0) + v); };
  for (const l of removed) tally(before, l);
  for (const l of added) tally(after, l);
  const names = sorted([...new Set([...before.keys(), ...after.keys()])]);
  const findings = [];
  for (const name of names) {
    if (csource.declarationLine(variantLines, name) === null) continue;
    const variantUse = firstUse(variantLines, name);
    if (variantUse === null) continue;
    const variantDefinition = firstDefinition(variantLines, name);
    if (variantDefinition !== null && variantDefinition <= variantUse) continue;
    const baseUse = firstUse(baseLines, name);
    const baseDefinition = firstDefinition(baseLines, name);
    if (baseUse !== null && (baseDefinition === null || baseDefinition > baseUse)) continue;
    const introduced = (after.get(name) ?? 0) > (before.get(name) ?? 0);
    const where = variantDefinition !== null ? ` (the first write is line ${variantDefinition})` : ", and the variant never writes to it";
    const was = baseUse !== null ? "the baseline wrote it before using it" : "the baseline never used it";
    findings.push(reviewFinding(introduced ? "read-before-definition" : "definition-removed", "error", name, variantUse,
      `the mutation ${introduced ? "introduces" : "leaves"} a use of ${strRepr(name)} at line ${variantUse} that no earlier line writes to${where}; ${was}`,
      "start the renamed group at a definition, restore the removed write, or drop the variant: a read that reaches no definition compiles and scores without being the same program"));
  }
  const reported = new Set(findings.map((f) => String(f.identifier)));
  for (const name of names) {
    if (reported.has(name) || csource.declarationLine(variantLines, name) === null) continue;
    if (firstUse(variantLines, name) === null) continue;
    const baseWrites = csource.definitionLines(baseLines, name);
    const variantWrites = csource.definitionLines(variantLines, name);
    if (variantWrites.length >= baseWrites.length) continue;
    findings.push(reviewFinding("write-removed", "warning", name, variantWrites.length ? variantWrites[0] : null,
      `the mutation removes ${baseWrites.length - variantWrites.length} of ${baseWrites.length} write(s) to ${strRepr(name)}, which is still read; whether a path now reaches a read without passing a write is a control-flow question this check cannot answer`,
      "confirm by hand that every surviving read is dominated by a surviving write before adopting"));
  }
  if (added.length > removed.length) {
    findings.push(reviewFinding("statement-count-changed", "warning", "", null,
      `the mutation adds ${added.length - removed.length} more line(s) than it removes, so it is not a pure substitution`,
      "justify the added statements line by line before adopting"));
  } else if (removed.length > added.length) {
    findings.push(reviewFinding("statement-count-changed", "warning", "", null,
      `the mutation removes ${removed.length - added.length} more line(s) than it adds, so it is not a pure substitution`,
      "justify the removed statements line by line before adopting"));
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    schema: MUTATION_REVIEW_SCHEMA, baseline: baselinePath, variant: variantPath,
    baseline_sha256: sha256(baselineText), variant_sha256: sha256(variantText),
    changed_lines_removed: removed.length, changed_lines_added: added.length,
    identifiers_introduced: sorted([...after.keys()].filter((n) => after.get(n) > (before.get(n) ?? 0))),
    identifiers_withdrawn: sorted([...before.keys()].filter((n) => before.get(n) > (after.get(n) ?? 0))),
    errors, warnings: findings.length - errors, finding_count: findings.length, findings, diff, reviewed: !findings.length,
    proof: "Textual review only. This does not parse, type, or execute C, so it cannot certify that a variant is the same program: a clean report means the two named shapes were not found, not that the mutation is valid.",
    next_gate: "Read the printed diff and justify every changed line before adopting the variant, then re-run the exact binary, frame, and translation-unit collateral gates on it.",
  };
}
