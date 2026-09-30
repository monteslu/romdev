// experiments.js - project-neutral experiment manifests (v1 parameter
// families, v2 with signals, controls and coverage) and selected-region
// constraints. Loading validates everything and mutates nothing.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ValueError, sorted, strRepr, pyInt, pyEq, strCmp } from "./py.js";
import { FileNotFoundError } from "./py-extra.js";
import { resolvePath, expanduser } from "./py-path.js";
import { pyRepr } from "./pyrepr.js";
import { loadsJson } from "./json-error.js";
import { METRICS_BY_KEY } from "./schema.js";

export const EXPERIMENT_SCHEMA_V1 = "decomp-workbench-experiment-v1";
export const EXPERIMENT_SCHEMA_V2 = "decomp-workbench-experiment-v2";
export const EXPERIMENT_SCHEMA = EXPERIMENT_SCHEMA_V1;
export const EXPERIMENT_SCHEMAS = new Set([EXPERIMENT_SCHEMA_V1, EXPERIMENT_SCHEMA_V2]);
export const SIGNAL_KINDS = new Set(["target-rows-exact", "target-region-exact", "metrics", "residual-classes"]);
export const RESIDUAL_CLASS_NAMES = new Set(["structural", "schedule", "register", "constant", "commutative"]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isPyInt = (v) => Number.isInteger(v) || typeof v === "boolean";
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const sortedList = (items) => sorted([...items]).join(", ");

/** json.dumps(value, sort_keys=True, separators=(",", ":")): ASCII, compact, sorted. */
export function compactJson(value) {
  const esc = (s) => {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i), ch = s[i];
      if (ch === '"') out += '\\"'; else if (ch === "\\") out += "\\\\"; else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r"; else if (ch === "\t") out += "\\t"; else if (ch === "\b") out += "\\b"; else if (ch === "\f") out += "\\f";
      else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`; else out += ch;
    }
    return out + '"';
  };
  const enc = (v) => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : String(v)) : (Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity");
    if (typeof v === "string") return esc(v);
    if (Array.isArray(v)) return `[${v.map(enc).join(",")}]`;
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(strCmp);
    return `{${keys.map((k) => `${esc(k)}:${enc(v[k])}`).join(",")}}`;
  };
  return enc(value);
}

export class SignalSpec {
  constructor(id, kind, required, config) { Object.assign(this, { id, kind, required, config }); Object.freeze(this); }
  asDict() { return { id: this.id, kind: this.kind, required: this.required, ...this.config }; }
}

export class ControlSpec {
  constructor(id, kind, candidates, expect, required = true) { Object.assign(this, { id, kind, candidates, expect, required }); Object.freeze(this); }
  asDict() {
    const payload = { id: this.id, kind: this.kind, required: this.required, expect: this.expect };
    if (this.kind === "absolute") payload.candidate = String(this.candidates[0]);
    else payload.candidates = this.candidates.map(String);
    return payload;
  }
}

/** A half-open instruction-index range a campaign should preserve. */
export class RegionConstraint {
  constructor(start, end, name = "selected") {
    if (start < 0 || end <= start) throw new ValueError("selected_region requires 0 <= start < end instruction indices");
    Object.assign(this, { start, end, name }); Object.freeze(this);
  }
  asDict() { return { name: this.name, start: this.start, end: this.end }; }
}

export class ExperimentManifest {
  constructor(fields) { Object.assign(this, fields); Object.freeze(this); }
  metadataFor(source) {
    const resolved = resolvePath(source);
    const payload = { schema: this.schema, family: this.family, parameters: this.candidates.get(resolved) ?? {},
      parameter_space: this.parameter_space, baseline: this.baseline, manifest: this.path,
      homologous_parameters: this.homologous_parameters.map((g) => [...g]) };
    if (this.schema === EXPERIMENT_SCHEMA_V2) payload.signals = this.signals.map((s) => s.id);
    return payload;
  }
  asDict() {
    const payload = {
      schema: this.schema, path: this.path, family: this.family, baseline: this.baseline, parameters: this.parameter_space,
      candidates: sorted([...this.candidates.entries()], (e) => e[0]).map(([source, parameters]) => ({ source, parameters })),
      homologous_parameters: this.homologous_parameters.map((g) => [...g]),
      selected_region: this.region ? this.region.asDict() : null,
    };
    if (this.schema === EXPERIMENT_SCHEMA_V2) {
      Object.assign(payload, { signals: this.signals.map((s) => s.asDict()), controls: this.controls.map((c) => c.asDict()), coverage: this.coverage });
    }
    return payload;
  }
  /** The normalized definition that participates in run identity. */
  identityReceipt() {
    const payload = this.asDict();
    if (this.schema === EXPERIMENT_SCHEMA_V2) {
      const sources = new Set([this.baseline, ...this.candidates.keys(), ...this.controls.flatMap((c) => c.candidates)]);
      payload.input_sha256 = Object.fromEntries(sorted([...sources]).map((s) => [s, createHash("sha256").update(fs.readFileSync(s)).digest("hex")]));
    }
    return { schema: this.schema, path: this.path, sha256: createHash("sha256").update(Buffer.from(compactJson(payload), "utf8")).digest("hex") };
  }
}

function resolveFrom(root, value, field) {
  if (typeof value !== "string" || !value) throw new ValueError(`experiment ${field} must be a non-empty path`);
  let p = expanduser(value);
  if (!path.isAbsolute(p)) p = path.join(root, p);
  return resolvePath(p);
}

/** int(value) for a JSON value, raising like the original on the wrong type. */
function toInt(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new ValueError("cannot convert"); return Math.trunc(v); }
  if (typeof v === "string") return pyInt(v);
  throw new TypeError("int() argument must be a string or a number");
}

function parseRegion(value) {
  if (value === null || value === undefined) return null;
  if (!isObj(value)) throw new ValueError("experiment selected_region must be an object");
  let start, end;
  try {
    if (!has(value, "start") || !has(value, "end")) throw new Error("missing");
    start = toInt(value.start); end = toInt(value.end);
  } catch { throw new ValueError("experiment selected_region requires integer start and end"); }
  const name = value.name ?? "selected";
  if (typeof name !== "string" || !name) throw new ValueError("experiment selected_region name must be a string");
  return new RegionConstraint(start, end, name);
}

function identifier(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new ValueError(`experiment ${field} must be a non-empty string`);
  const normalized = value.trim();
  if (![...normalized].every((c) => /[\p{L}\p{N}]/u.test(c) || "._-".includes(c))) throw new ValueError(`experiment ${field} contains unsupported characters`);
  return normalized;
}

const SIGNAL_FIELDS = new Set(["id", "kind", "required", "rows", "ranges", "start", "end", "name", "comparison", "equals", "minimum", "maximum", "allowed", "forbidden"]);
const FIELDS_BY_KIND = {
  "target-rows-exact": new Set(["rows", "ranges", "comparison"]),
  "target-region-exact": new Set(["start", "end", "name", "comparison"]),
  "metrics": new Set(["equals", "minimum", "maximum"]),
  "residual-classes": new Set(["allowed", "forbidden"]),
};

function parseSignal(value, index) {
  if (!isObj(value)) throw new ValueError(`experiment signal ${index} must be an object`);
  const unknown = Object.keys(value).filter((k) => !SIGNAL_FIELDS.has(k));
  if (unknown.length) throw new ValueError(`experiment signal ${index} has unknown field(s): ` + sortedList(unknown));
  const signalId = identifier(value.id, `signal ${index} id`);
  const kind = value.kind;
  if (!SIGNAL_KINDS.has(kind)) throw new ValueError(`experiment signal ${strRepr(signalId)} kind must be one of: ` + sortedList(SIGNAL_KINDS));
  const required = value.required ?? false;
  if (typeof required !== "boolean") throw new ValueError(`experiment signal ${strRepr(signalId)} required must be boolean`);
  let config = Object.fromEntries(Object.entries(value).filter(([k]) => !["id", "kind", "required"].includes(k)));
  const irrelevant = Object.keys(config).filter((k) => !FIELDS_BY_KIND[kind].has(k));
  if (irrelevant.length) throw new ValueError(`experiment signal ${strRepr(signalId)} has field(s) invalid for ${kind}: ` + sortedList(irrelevant));
  if (kind === "target-rows-exact") {
    const rows = config.rows ?? [], ranges = config.ranges ?? [];
    if (!Array.isArray(rows) || !rows.every((r) => isPyInt(r) && r >= 0)) throw new ValueError(`experiment signal ${strRepr(signalId)} rows must be non-negative integers`);
    if (!Array.isArray(ranges)) throw new ValueError(`experiment signal ${strRepr(signalId)} ranges must be a list`);
    for (const item of ranges) {
      const keys = isObj(item) ? Object.keys(item).sort() : [];
      if (!isObj(item) || keys.length !== 2 || keys[0] !== "end" || keys[1] !== "start" || !isPyInt(item.start) || !isPyInt(item.end) || item.start < 0 || item.end <= item.start) {
        throw new ValueError(`experiment signal ${strRepr(signalId)} has an invalid half-open range`);
      }
    }
    if (!rows.length && !ranges.length) throw new ValueError(`experiment signal ${strRepr(signalId)} requires rows or ranges`);
    const mode = config.comparison ?? "relocation-aware";
    if (!["raw", "relocation-aware"].includes(mode)) throw new ValueError(`experiment signal ${strRepr(signalId)} comparison must be raw or relocation-aware`);
    config.comparison = mode;
  } else if (kind === "target-region-exact") {
    let region;
    try {
      if (!has(config, "start") || !has(config, "end")) throw new Error("missing");
      region = new RegionConstraint(toInt(config.start), toInt(config.end), String(config.name ?? signalId));
    } catch { throw new ValueError(`experiment signal ${strRepr(signalId)} requires valid start/end`); }
    const mode = config.comparison ?? "relocation-aware";
    if (!["raw", "relocation-aware"].includes(mode)) throw new ValueError(`experiment signal ${strRepr(signalId)} comparison must be raw or relocation-aware`);
    config = { ...region.asDict(), comparison: mode };
  } else if (kind === "metrics") {
    const predicates = ["equals", "minimum", "maximum"].filter((n) => has(config, n));
    if (!predicates.length) throw new ValueError(`experiment signal ${strRepr(signalId)} requires a metric predicate`);
    for (const p of predicates) {
      const values = config[p];
      if (!isObj(values) || !Object.keys(values).length) throw new ValueError(`experiment signal ${strRepr(signalId)} ${p} must be an object`);
      const unknownMetrics = Object.keys(values).filter((k) => !has(METRICS_BY_KEY, k));
      if (unknownMetrics.length) throw new ValueError(`experiment signal ${strRepr(signalId)} has unknown metric(s): ` + sortedList(unknownMetrics));
    }
  } else {
    const allowedClasses = config.allowed ?? [...RESIDUAL_CLASS_NAMES];
    const forbidden = config.forbidden ?? [];
    for (const [field, classes] of [["allowed", allowedClasses], ["forbidden", forbidden]]) {
      if (!Array.isArray(classes) || !classes.every((c) => typeof c === "string")) throw new ValueError(`experiment signal ${strRepr(signalId)} ${field} must be a list`);
      const unknownClasses = classes.filter((c) => !RESIDUAL_CLASS_NAMES.has(c));
      if (unknownClasses.length) throw new ValueError(`experiment signal ${strRepr(signalId)} has unknown residual class(es): ` + sortedList(new Set(unknownClasses)));
    }
    config = { allowed: allowedClasses, forbidden };
  }
  return new SignalSpec(signalId, String(kind), required, config);
}

export function parseSignalSpecs(values) {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values)) throw new ValueError("experiment signals must be a list");
  const signals = values.map((v, i) => parseSignal(v, i));
  const ids = signals.map((s) => s.id);
  if (ids.length !== new Set(ids).size) throw new ValueError("experiment signal ids must be unique");
  return signals;
}

const isFileSync = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function parseControls(root, values) {
  if (values === null || values === undefined) return [];
  if (!Array.isArray(values)) throw new ValueError("experiment controls must be a list");
  const controls = [];
  values.forEach((value, index) => {
    if (!isObj(value)) throw new ValueError(`experiment control ${index} must be an object`);
    const unknown = Object.keys(value).filter((k) => !["id", "kind", "candidate", "candidates", "expect", "required"].includes(k));
    if (unknown.length) throw new ValueError(`experiment control ${index} has unknown field(s): ` + sortedList(unknown));
    const controlId = identifier(value.id, `control ${index} id`);
    const kind = value.kind ?? "absolute";
    if (!["absolute", "differential"].includes(kind)) throw new ValueError(`experiment control ${strRepr(controlId)} kind must be absolute or differential`);
    const raw = kind === "absolute" ? [value.candidate ?? null] : value.candidates;
    if (!Array.isArray(raw) || raw.length !== (kind === "absolute" ? 1 : 2)) {
      throw new ValueError(`experiment control ${strRepr(controlId)} requires ${kind === "absolute" ? "one candidate" : "two candidates"}`);
    }
    const candidates = raw.map((item) => resolveFrom(root, item, `control ${controlId} candidate`));
    if (new Set(candidates).size !== candidates.length) throw new ValueError(`experiment control ${strRepr(controlId)} candidates must be distinct`);
    for (const c of candidates) if (!isFileSync(c)) throw new FileNotFoundError(`experiment control candidate does not exist: ${c}`);
    const expect = value.expect ?? {};
    if (!isObj(expect) || !Object.keys(expect).length) throw new ValueError(`experiment control ${strRepr(controlId)} expect must be a non-empty object`);
    const required = value.required ?? true;
    if (typeof required !== "boolean") throw new ValueError(`experiment control ${strRepr(controlId)} required must be boolean`);
    controls.push(new ControlSpec(controlId, String(kind), candidates, expect, required));
  });
  const ids = controls.map((c) => c.id);
  if (ids.length !== new Set(ids).size) throw new ValueError("experiment control ids must be unique");
  return controls;
}

/** Python str() of a dict of JSON values, for the duplicate-assignment message. */
const dictStr = (d) => pyRepr(d);

/** Load a deterministic, non-mutating experiment sidecar. */
export function loadExperiment(p) {
  const manifestPath = resolvePath(p);
  const value = loadsJson(fs.readFileSync(manifestPath, "utf8"));
  if (!isObj(value) || !EXPERIMENT_SCHEMAS.has(value.schema)) throw new ValueError("experiment schema must be one of: " + sortedList(EXPERIMENT_SCHEMAS));
  const schema = String(value.schema);
  if (schema === EXPERIMENT_SCHEMA_V1 && ["signals", "controls", "coverage"].some((n) => has(value, n))) {
    throw new ValueError(`experiment signals, controls, and coverage require ${EXPERIMENT_SCHEMA_V2}`);
  }
  const family = value.family;
  if (typeof family !== "string" || !family.trim()) throw new ValueError("experiment family must be a non-empty string");
  const root = path.dirname(manifestPath);
  const baseline = resolveFrom(root, value.baseline, "baseline");
  if (!isFileSync(baseline)) throw new FileNotFoundError(`experiment baseline does not exist: ${baseline}`);
  const parameters = value.parameters ?? {};
  if (!isObj(parameters)) throw new ValueError("experiment parameters must be an object of value lists");
  const parameterSpace = {};
  for (const [name, choices] of Object.entries(parameters)) {
    if (typeof name !== "string" || !name) throw new ValueError("experiment parameter names must be non-empty strings");
    if (!Array.isArray(choices) || !choices.length) throw new ValueError(`experiment parameter ${strRepr(name)} must be a non-empty list`);
    parameterSpace[name] = choices;
  }
  const candidatesValue = value.candidates ?? [];
  if (!Array.isArray(candidatesValue)) throw new ValueError("experiment candidates must be a list");
  const candidates = new Map();
  const seenSets = new Set();
  const inSpace = (choice, list) => list.some((x) => pyEq(x, choice));
  candidatesValue.forEach((candidate, index) => {
    if (!isObj(candidate)) throw new ValueError(`experiment candidate ${index} must be an object`);
    const source = resolveFrom(root, candidate.source, `candidate ${index} source`);
    if (!isFileSync(source)) throw new FileNotFoundError(`experiment candidate does not exist: ${source}`);
    const assignment = candidate.parameters ?? {};
    if (!isObj(assignment)) throw new ValueError(`experiment candidate ${index} parameters must be an object`);
    const unknown = Object.keys(assignment).filter((k) => !has(parameterSpace, k));
    if (unknown.length) throw new ValueError(`experiment candidate ${index} has unknown parameter(s): ` + sortedList(unknown));
    if (schema === EXPERIMENT_SCHEMA_V2 && (Object.keys(assignment).length !== Object.keys(parameterSpace).length || Object.keys(parameterSpace).some((k) => !has(assignment, k)))) {
      const missing = Object.keys(parameterSpace).filter((k) => !has(assignment, k));
      throw new ValueError(`experiment-v2 candidate ${index} must assign every declared parameter; missing: ` + sortedList(missing));
    }
    for (const [name, selected] of Object.entries(assignment)) {
      if (!inSpace(selected, parameterSpace[name])) {
        throw new ValueError(`experiment candidate ${index} selects ${name}=${pyRepr(selected)}, which is outside the declared parameter space`);
      }
    }
    const serialized = compactJson(assignment);
    if (seenSets.has(serialized)) throw new ValueError(`experiment parameter assignment is duplicated: ${dictStr(assignment)}`);
    seenSets.add(serialized);
    if (candidates.has(source)) throw new ValueError(`experiment candidate source is duplicated: ${source}`);
    candidates.set(source, { ...assignment });
  });
  const invariants = value.invariants ?? {};
  if (!isObj(invariants)) throw new ValueError("experiment invariants must be an object");
  const region = parseRegion(has(value, "selected_region") ? value.selected_region : invariants.selected_region);
  const homologousValue = value.homologous_parameters ?? [];
  if (!Array.isArray(homologousValue)) throw new ValueError("experiment homologous_parameters must be a list");
  const homologous = [];
  const claimed = new Set();
  homologousValue.forEach((group, index) => {
    if (!Array.isArray(group) || group.length < 2 || !group.every((n) => typeof n === "string" && n)) {
      throw new ValueError(`experiment homologous_parameters group ${index} must contain at least two parameter names`);
    }
    if (new Set(group).size !== group.length) throw new ValueError(`experiment homologous_parameters group ${index} contains duplicates`);
    const unknownH = group.filter((n) => !has(parameterSpace, n));
    if (unknownH.length) throw new ValueError(`experiment homologous_parameters group ${index} has unknown parameter(s): ` + sortedList(new Set(unknownH)));
    const overlap = group.filter((n) => claimed.has(n));
    if (overlap.length) throw new ValueError("experiment homologous_parameters groups overlap at: " + sortedList(new Set(overlap)));
    const choices = group.map((n) => parameterSpace[n]);
    if (choices.slice(1).some((c) => !pyEq(c, choices[0]))) throw new ValueError(`experiment homologous_parameters group ${index} must share the same declared choices`);
    for (const n of group) claimed.add(n);
    homologous.push([...group]);
  });
  if (homologous.length && !candidates.has(baseline)) {
    throw new ValueError("experiment baseline must appear in candidates with a parameter assignment when homologous_parameters are declared");
  }
  if (homologous.length) {
    const baseAssign = candidates.get(baseline);
    const missingH = homologous.flat().filter((n) => !has(baseAssign, n));
    if (missingH.length) throw new ValueError("experiment baseline assignment is missing homologous parameter(s): " + sortedList(new Set(missingH)));
  }
  const signals = parseSignalSpecs(value.signals ?? null);
  const controls = parseControls(root, value.controls ?? null);
  const signalIds = new Set(signals.map((s) => s.id));
  for (const control of controls) {
    if (control.kind === "absolute") {
      const allowed = new Set(["signals", "metrics", "object_sha256", "returncode", ...Object.keys(METRICS_BY_KEY)]);
      const unknownExpect = Object.keys(control.expect).filter((k) => !allowed.has(k));
      if (unknownExpect.length) throw new ValueError(`experiment control ${strRepr(control.id)} has unknown expectation(s): ` + sortedList(unknownExpect));
      if (has(control.expect, "returncode") && !isPyInt(control.expect.returncode)) throw new ValueError(`experiment control ${strRepr(control.id)} returncode must be an integer`);
      const objectHash = control.expect.object_sha256;
      if (objectHash !== undefined && objectHash !== null && (typeof objectHash !== "string" || objectHash.length !== 64 || !/^[0-9a-f]+$/.test(objectHash))) {
        throw new ValueError(`experiment control ${strRepr(control.id)} object_sha256 must be 64 lowercase hexadecimal characters`);
      }
      const signalExpect = control.expect.signals ?? {};
      const metricExpect = control.expect.metrics ?? {};
      if (!isObj(signalExpect) || !isObj(metricExpect)) throw new ValueError(`experiment control ${strRepr(control.id)} signals/metrics expectations must be objects`);
      const unknownSignals = Object.keys(signalExpect).filter((k) => !signalIds.has(k));
      if (unknownSignals.length) throw new ValueError(`experiment control ${strRepr(control.id)} references unknown signal(s): ` + sortedList(unknownSignals));
      const statuses = Object.values(signalExpect).map((s) => (typeof s === "string" ? s : pyRepr(s).replace(/^'|'$/g, "")));
      if (statuses.some((s) => !["PASS", "FAIL", "UNKNOWN"].includes(s))) throw new ValueError(`experiment control ${strRepr(control.id)} signal statuses must be PASS, FAIL, or UNKNOWN`);
      const unknownMetrics = Object.keys(metricExpect).filter((k) => !has(METRICS_BY_KEY, k));
      if (unknownMetrics.length) throw new ValueError(`experiment control ${strRepr(control.id)} references unknown metric(s): ` + sortedList(unknownMetrics));
    } else {
      const keys = Object.keys(control.expect);
      if (keys.length !== 1 || keys[0] !== "different") throw new ValueError(`experiment differential control ${strRepr(control.id)} expect must contain only different`);
      const paths = control.expect.different;
      if (!Array.isArray(paths) || !paths.length || !paths.every((x) => typeof x === "string")) {
        throw new ValueError(`experiment differential control ${strRepr(control.id)} different must be a non-empty string list`);
      }
      for (const pv of paths) {
        const i = pv.indexOf(".");
        const prefix = i < 0 ? pv : pv.slice(0, i), sep = i >= 0, key = i < 0 ? "" : pv.slice(i + 1);
        const valid = pv === "object_sha256" || (sep && ((prefix === "metrics" && has(METRICS_BY_KEY, key)) || (prefix === "signals" && signalIds.has(key))));
        if (!valid) throw new ValueError(`experiment differential control ${strRepr(control.id)} has invalid evidence path ${strRepr(pv)}`);
      }
    }
  }
  const coverageValue = value.coverage ?? {};
  if (!isObj(coverageValue)) throw new ValueError("experiment coverage must be an object");
  const unknownCoverage = Object.keys(coverageValue).filter((k) => !["method", "excluded", "exclusion_reason", "sampling"].includes(k));
  if (unknownCoverage.length) throw new ValueError("experiment coverage has unknown field(s): " + sortedList(unknownCoverage));
  const excluded = coverageValue.excluded ?? 0;
  if (!isPyInt(excluded) || excluded < 0) throw new ValueError("experiment coverage excluded must be a non-negative integer");
  const declared = Object.keys(parameterSpace).length ? Object.values(parameterSpace).reduce((s, c) => s * c.length, 1) : 1;
  if (excluded > declared) throw new ValueError("experiment coverage excluded cannot exceed the declared parameter space");
  if (excluded + candidates.size > declared) throw new ValueError("experiment coverage exclusions and candidate assignments overlap or exceed the declared parameter space");
  const method = coverageValue.method ?? "explicit-candidates";
  if (typeof method !== "string" || !method.trim()) throw new ValueError("experiment coverage method must be a non-empty string");
  const exclusionReason = coverageValue.exclusion_reason ?? null;
  if (exclusionReason !== null && (typeof exclusionReason !== "string" || !exclusionReason.trim())) throw new ValueError("experiment coverage exclusion_reason must be a non-empty string");
  if (excluded && exclusionReason === null) throw new ValueError("experiment coverage exclusion_reason is required when assignments are excluded");
  const sampling = coverageValue.sampling ?? null;
  if (sampling !== null && typeof sampling !== "string" && !isObj(sampling)) throw new ValueError("experiment coverage sampling must be a string or object");
  const coverage = { method: method.trim(), excluded: Number(excluded), exclusion_reason: exclusionReason, sampling };
  return new ExperimentManifest({ path: manifestPath, schema, family, baseline, parameter_space: parameterSpace, candidates,
    homologous_parameters: homologous, region, signals, controls, coverage, raw: value });
}

/** The declared Cartesian parameter-space size. */
export function expectedParameterCombinations(manifest) {
  const vals = Object.values(manifest.parameter_space);
  return vals.length ? vals.reduce((s, c) => s * c.length, 1) : 1;
}

/** Refuse a sidecar that cannot account for supplied candidate sources. */
export function validateCampaignSources(manifest, sources) {
  const resolved = new Set(sources.map((s) => resolvePath(s)));
  const accounted = new Set([...manifest.candidates.keys(), manifest.baseline]);
  const missing = [...resolved].filter((s) => !accounted.has(s));
  if (missing.length) throw new ValueError("experiment manifest does not describe supplied source(s): " + sorted(missing).join(", "));
}
