// sweep.js - a sweep is a named family of sources, a manifest, and an explicit
// ingest. The workbench emits sources and a manifest; the project's own
// compile-one wrapper turns them into objects; the objects come back to be
// gated, scored and reported.
//
// Built in rather than remembered: a variant is keyed by (site, class,
// carrier), never by site alone; a class is a registry entry, not a regex
// (an unregistered letter is an error naming the registry); and nothing is
// dropped silently - limits, refused edits and missing objects are counted,
// named and printed, with a coverage line saying whether a negative result is
// a proof about the space or evidence about a sample.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { SweepCoverage } from "./coverage.js";
import { ValueError, strRepr, sorted, pyStr } from "./py.js";
import { dumps } from "./pyjson.js";

export const SWEEP_SCHEMA = "decomp-workbench-sweep-v1";
export const INGEST_SCHEMA = "decomp-workbench-sweep-ingest-v1";

/** A sweep could not be generated, written, or read back. */
export class SweepError extends ValueError {
  constructor(message) { super(message); this.name = "ValueError"; this.sweepError = true; }
}

/** One generator class: its letter, its name, and what it mints. */
export class GeneratorClass {
  constructor(letter, name, description) { this.letter = letter; this.name = name; this.description = description; Object.freeze(this); }
  asDict() { return { letter: this.letter, name: this.name, description: this.description }; }
}

/** Every class a sweep can mint. */
export const GENERATOR_CLASSES = Object.freeze({
  N: new GeneratorClass("N", "null-hypothesis removal", "one accumulated construct deleted, singly or jointly, to price it"),
  O: new GeneratorClass("O", "deep operand hoist", "a leaf of a nested subexpression hoisted into a carrier"),
  H: new GeneratorClass("H", "top-level operand hoist", "one side of the top-level binary expression hoisted into a carrier"),
  P: new GeneratorClass("P", "compound-assignment hoist", "x op= y becomes C = y; x op= C"),
  A: new GeneratorClass("A", "call-argument hoist", "f(expr) becomes C = expr; f(C)"),
  C: new GeneratorClass("C", "commutative flip", "the two operands of a commutative operator exchanged"),
  K: new GeneratorClass("K", "copy elimination", "a copy Y = X removed and Y's later reads rehosted onto X"),
  F: new GeneratorClass("F", "live-range fusion", "a donor local's occurrences renamed to the target, fusing two webs"),
});

/** The registered class, or an error naming the registry. */
export function knownClass(letter) {
  const entry = Object.prototype.hasOwnProperty.call(GENERATOR_CLASSES, letter) ? GENERATOR_CLASSES[letter] : null;
  if (!entry) {
    const known = Object.values(GENERATOR_CLASSES).map((c) => `${c.letter} (${c.name})`).join(", ");
    throw new SweepError(`${strRepr(letter)} is not a generator class. Registered classes: ${known}. `
      + "A class that is not registered is dropped from every catalogue read, so this is an error rather than a shorter table.");
  }
  return entry;
}

function token(text) {
  return text.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** Where the edit is, what class it is, and which carrier selects it. */
export class VariantKey {
  constructor({ site, generator_class, carrier = "-" }) {
    this.site = site; this.generator_class = generator_class; this.carrier = carrier;
    knownClass(generator_class);
    Object.freeze(this);
  }
  get label() {
    if (this.carrier === "" || this.carrier === "-") return `${this.generator_class}.${token(this.site)}`;
    return `${this.generator_class}.${token(this.site)}.${token(this.carrier)}`;
  }
  asDict() { return { site: this.site, class: this.generator_class, carrier: this.carrier, label: this.label }; }
}

/** One generated source, with the key that identifies its experiment. */
export class Variant {
  constructor({ key, filename, text, description, detail = {} }) {
    Object.assign(this, { key, filename, text, description, detail });
    Object.freeze(this);
  }
  get stem() { const b = path.basename(this.filename); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; }
  asDict() { return { ...this.key.asDict(), filename: this.filename, stem: this.stem, description: this.description, detail: this.detail }; }
}

/** The sources a sweep emitted, and what space they are a sample of. */
export class SweepManifest {
  constructor({ generator, base, base_sha256, variants, coverage, dropped = [], directory = "", context = "", limits = [] }) {
    Object.assign(this, { generator, base, base_sha256, variants, coverage, dropped, directory, context, limits });
    Object.freeze(this);
  }
  asDict() {
    return {
      schema: SWEEP_SCHEMA,
      generator: this.generator,
      base: this.base,
      base_sha256: this.base_sha256,
      context: this.context,
      directory: this.directory,
      variant_count: this.variants.length,
      variants: this.variants.map((v) => v.asDict()),
      coverage: this.coverage.asDict(),
      dropped: this.dropped.map((d) => ({ ...d })),
      dropped_count: this.dropped.length,
      classes: sorted([...new Set(this.variants.map((v) => v.key.generator_class))]).map((l) => GENERATOR_CLASSES[l].asDict()),
      limits: [...this.limits],
    };
  }
}

/** Raise when two variants share one (site, class, carrier) triple. */
export function checkKeys(variants) {
  const seen = new Map();
  for (const item of variants) {
    const key = JSON.stringify([item.key.site, item.key.generator_class, item.key.carrier]);
    const other = seen.get(key);
    if (other) {
      throw new SweepError(`two variants share the key site=${item.key.site} class=${item.key.generator_class} carrier=${item.key.carrier}: `
        + `${strRepr(other.description)} and ${strRepr(item.description)}. A sweep is keyed by all three; a collision means two `
        + "different edits would be scored under one name.");
    }
    seen.set(key, item);
  }
}

/** Drop variants whose emitted bytes another variant already has. */
export function dedupeVariants(variants) {
  const seen = new Map();
  const kept = [], duplicates = [];
  for (const item of variants) {
    const first = seen.get(item.text);
    if (!first) { seen.set(item.text, item); kept.push(item); continue; }
    duplicates.push({ site: item.key.label, reason: `byte-identical to ${first.key.label}; one source, one build` });
  }
  return [kept, duplicates];
}

/** Write every variant plus `sweep.json`, and return the placed manifest. */
export function writeFamily(manifest, { directory, overwrite = false, cwd = process.cwd() }) {
  const [variants, duplicates] = dedupeVariants(manifest.variants);
  if (duplicates.length) {
    manifest = new SweepManifest({ ...manifest, variants,
      coverage: new SweepCoverage({ basis: manifest.coverage.basis, space: manifest.coverage.space, covered: variants.length,
        step: manifest.coverage.step, excluded: manifest.coverage.excluded + duplicates.length }),
      dropped: [...manifest.dropped, ...duplicates] });
  }
  checkKeys(manifest.variants);
  const target = String(directory);
  const abs = path.resolve(cwd, target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && fs.readdirSync(abs).length && !overwrite) {
    throw new SweepError(`${target} is not empty. A sweep directory is the record of one experiment; pass --overwrite to replace it, or name a new one.`);
  }
  try { fs.mkdirSync(abs, { recursive: true }); } catch (e) {
    throw new SweepError(`cannot create ${target}: ${e.message}`);
  }
  for (const item of manifest.variants) fs.writeFileSync(path.join(abs, item.filename), item.text, "utf8");
  const placed = new SweepManifest({ ...manifest, directory: target });
  fs.writeFileSync(path.join(abs, "sweep.json"), dumps(placed.asDict()) + "\n", "utf8");
  return placed;
}

/** Read a `sweep.json` back, checking every class against the registry. */
export function readManifest(p, { cwd = process.cwd() } = {}) {
  let location = String(p);
  const isDir = (q) => { try { return fs.statSync(path.resolve(cwd, q)).isDirectory(); } catch { return false; } };
  if (isDir(location)) location = path.join(location, "sweep.json");
  let text;
  try { text = fs.readFileSync(path.resolve(cwd, location), "utf8"); } catch (e) {
    const reason = e.code === "ENOENT" ? `[Errno 2] No such file or directory: '${location}'` : e.message;
    throw new SweepError(`cannot read the sweep manifest ${location}: ${reason}`);
  }
  let payload;
  try { payload = JSON.parse(text); } catch (e) { throw new SweepError(`${location} is not valid JSON: ${e.message}`); }
  const get = (k, d) => (payload && typeof payload === "object" && k in payload ? payload[k] : d);
  if (get("schema", null) !== SWEEP_SCHEMA) {
    throw new SweepError(`${location} is not a ${SWEEP_SCHEMA} document (schema=${strRepr(get("schema", null))})`);
  }
  const variants = (get("variants", []) ?? []).map((item) => new Variant({
    key: new VariantKey({ site: pyStr(item.site), generator_class: pyStr(item.class), carrier: pyStr("carrier" in item ? item.carrier : "-") }),
    filename: pyStr(item.filename), text: "", description: pyStr("description" in item ? item.description : ""), detail: { ...(item.detail || {}) },
  }));
  checkKeys(variants);
  const coverage = get("coverage", null) || {};
  const cg = (k, d) => (k in coverage ? coverage[k] : d);
  return new SweepManifest({
    generator: pyStr(get("generator", "")),
    base: pyStr(get("base", "")),
    base_sha256: pyStr(get("base_sha256", "")),
    variants,
    coverage: new SweepCoverage({ basis: pyStr(cg("basis", "unknown")), space: cg("space", null), covered: Math.trunc(Number(cg("covered", variants.length))),
      step: cg("step", null), excluded: Math.trunc(Number(cg("excluded", 0))) }),
    dropped: (get("dropped", []) ?? []).map((d) => ({ ...d })),
    directory: pyStr(get("directory", path.dirname(location))),
    context: pyStr(get("context", "")),
    limits: [...(get("limits", []) ?? [])],
  });
}
