// sweep-generators.js - the variant families a search actually needs, and the
// carrier pool they draw from. Each generator is a class in
// GENERATOR_CLASSES and emits sources through the composer, so every edit
// states the base it was written against and the zones it must not touch.
//
// N (null-hypothesis removal) is the cheapest and matters most: rebuild the
// base with each accumulated lever removed, and price it on the base as it
// stands now. The hoists (H/O/P/A), the commutative flip (C), copy
// elimination (K) and live-range fusion (F) mint the deltas nothing else does.
// Every carrier is an existing dead local: a fresh declaration mints a frame
// slot the frame gate rejects.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ComposeError, Edit, EditPlan, applyPlan, sourceSha256 } from "./compose.js";
import { SweepCoverage } from "./coverage.js";
import { CSourceError, declarations, defines, definitionLines, identifiers, reads, scanStatements, stripNoncode, takesAddress } from "./csource.js";
import { SweepError, SweepManifest, Variant, VariantKey } from "./sweep.js";
import { splitlines, strip, lstrip, rstrip, strRepr, sorted, fullmatch, reEscape, sum } from "./py.js";

export const GENERATOR_LIMITS = Object.freeze([
  "Edits are textual and structural. Nothing here parses or types C, so a variant is a proposal to build, not a proven-equivalent program.",
  "Liveness is read from the text: a definition is an assignment, a compound assignment, an increment or an address-of. A write through a pointer the text does not spell is not seen.",
  "A carrier is only ever an existing dead local. A fresh declaration mints a new frame slot (8 bytes for an f32 on the one compiler this was measured on) and the frame gate rejects it, so the pool never proposes one.",
  "Review a winner before adopting it: `decomp-workbench experiment review-mutation BASE WINNER`.",
]);

const hasIdent = (ids, name) => (ids instanceof Map || (ids && typeof ids.has === "function") ? ids.has(name) : !!ids && Object.prototype.hasOwnProperty.call(ids, name));
const identNames = (ids) => (ids instanceof Map || (ids && typeof ids.keys === "function" && !Array.isArray(ids)) ? [...ids.keys()] : Object.keys(ids ?? {}));
const firstLine = (e) => splitlines(String(e.message))[0] ?? "";
const isCompose = (e) => e instanceof ComposeError;
const stemOf = (p) => { const b = path.basename(String(p)); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

/** Read a C source: raw lines and comment/string-stripped code lines. */
function readSource(p, cwd) {
  let text;
  try { text = fs.readFileSync(path.resolve(cwd, String(p)), "utf8"); } catch (e) {
    const reason = e.code === "ENOENT" ? `[Errno 2] No such file or directory: '${p}'` : e.message;
    throw new CSourceError(`cannot read ${p}: ${reason}`);
  }
  if (!strip(text)) throw new CSourceError(`${p} is empty`);
  return [splitlines(text), stripNoncode(text)];
}

function indentOf(line) { return line.slice(0, line.length - lstrip(line).length); }

const SLUG_RE = /[^A-Za-z0-9]+/g;
export function slug(text) { return text.replace(SLUG_RE, "-").replace(/^-+|-+$/g, "") || "x"; }

// ---------------------------------------------------------------------------
// The carrier pool
// ---------------------------------------------------------------------------

/** One candidate carrier, with the verdict that decides whether it is free. */
export class Carrier {
  constructor({ name, declaration_line, declaration_index, type_text, verdict, reason, last_read = null, next_use = null }) {
    Object.assign(this, { name, declaration_line, declaration_index, type_text, verdict, reason, last_read, next_use });
    Object.freeze(this);
  }
  get usable() { return this.verdict === "dead"; }
  asDict() {
    return { name: this.name, declaration_line: this.declaration_line, declaration_index: this.declaration_index, type: this.type_text,
      verdict: this.verdict, reason: this.reason, last_read: this.last_read, next_use: this.next_use, usable: this.usable };
  }
}

/** The dead locals available at one site, in declaration order. */
export class CarrierPool {
  constructor({ source, at, carriers, declared, wanted_type = null }) {
    Object.assign(this, { source, at, carriers, declared, wanted_type });
    Object.freeze(this);
  }
  get usable() { return this.carriers.filter((c) => c.usable); }
  asDict() {
    return {
      schema: "decomp-workbench-carrier-pool-v1",
      source: this.source, at: this.at, wanted_type: this.wanted_type, declared: this.declared,
      pool_size: this.usable.length,
      carriers: this.carriers.map((c) => c.asDict()),
      rule: "A carrier is an existing local that is dead at this site. A fresh declaration mints a frame slot the frame gate rejects, "
        + "and an unused pad has no web to merge into -- so declared symbols are enumerated first and a pad is never proposed.",
      limits: [...GENERATOR_LIMITS],
    };
  }
}

/** The locals that are dead at line `at`, in declaration order. */
export function carrierPool(p, { at, wanted_type = null, cwd = process.cwd() }) {
  const code = readSource(p, cwd)[1];
  if (!(at >= 1 && at <= code.length)) throw new CSourceError(`${p} has ${code.length} line(s); --at names line ${at}`);
  const statements = scanStatements(code);
  const byLine = new Map(statements.map((s) => [s.line, s]));
  const site = byLine.get(at);
  const siteLoops = new Set(site ? site.loops : []);
  const found = [];
  for (const declaration of declarations(code)) {
    if (declaration.is_array) continue;
    if (declaration.line >= at) continue;
    if (wanted_type && declaration.type_text !== wanted_type) continue;
    const name = declaration.name;
    if (truthyList(takesAddress(code, name))) {
      found.push(new Carrier({ name, declaration_line: declaration.line, declaration_index: declaration.index, type_text: declaration.type_text,
        verdict: "escapes", reason: "its address is taken somewhere in this file, so a callee may hold a pointer to it" }));
      continue;
    }
    let [verdict, reason, nextUse] = livenessAt(code, name, { at });
    if (verdict === "dead" && nextUse !== null) {
      const statement = byLine.get(nextUse);
      if (statement && [...statement.loops].some((l) => !siteLoops.has(l))) {
        verdict = "unproven";
        reason = `the write at line ${nextUse} that would make it dead is inside a loop the site is not in; a back-edge can carry the old value to a read that precedes it textually`;
      }
    }
    const readsBefore = [];
    code.forEach((line, i) => { if (reads(line, name)) readsBefore.push(i + 1); });
    found.push(new Carrier({ name, declaration_line: declaration.line, declaration_index: declaration.index, type_text: declaration.type_text,
      verdict, reason, last_read: readsBefore.length ? Math.max(...readsBefore) : null, next_use: nextUse }));
  }
  const order = { dead: 0, unproven: 1, live: 2, escapes: 3 };
  const ordered = sorted(found, (c) => [order[c.verdict], c.declaration_index]);
  return new CarrierPool({ source: String(p), at, carriers: ordered, declared: declarations(code).length, wanted_type });
}

function truthyList(v) { return Array.isArray(v) ? v.length > 0 : !!v; }

function livenessAt(code, name, { at }) {
  for (let number = at; number <= code.length; number++) {
    const line = code[number - 1];
    if (!reads(line, name) && !defines(line, name)) continue;
    if (defines(line, name) && !readsOwnValue(line, name)) {
      return ["dead", `line ${number} writes it before anything reads it, so its value here is not observed`, number];
    }
    return ["live", `line ${number} reads it before anything writes it, so recycling it here would change that read`, number];
  }
  return ["dead", "nothing reads or writes it after this site", null];
}

/** Whether a write to `name` also reads it (`x += y`, `x = x + 1`, `x++`). */
function readsOwnValue(line, name) {
  const q = reEscape(name);
  const compound = new RegExp(`(?<![\\w.>])${q}\\s*(?:\\[[^\\];]*\\])?\\s*(?:[-+*/%&|^]=|<<=|>>=)`);
  if (compound.test(line)) return true;
  const step = new RegExp(`(?:\\+\\+|--)\\s*${q}\\b|${q}\\s*(?:\\+\\+|--)`);
  if (step.test(line)) return true;
  const eq = line.indexOf("=");
  const rhs = eq < 0 ? "" : line.slice(eq + 1);
  return !!rhs && hasIdent(identifiers(rhs), name);
}

// ---------------------------------------------------------------------------
// N -- the null hypothesis
// ---------------------------------------------------------------------------

/** One accumulated lever, named by the lines that spell it. */
export class Construct {
  constructor({ first, last, label }) { this.first = first; this.last = last; this.label = label; Object.freeze(this); }
  get lines() { const out = []; for (let i = this.first; i <= this.last; i++) out.push(i); return out; }
  get site() { return this.first === this.last ? `L${this.first}` : `L${this.first}-${this.last}`; }
}

/** Parse `LO..HI=label`, `LO..HI` or `N` into a construct. */
export function parseConstruct(text) {
  const eq = text.indexOf("=");
  const spec = eq < 0 ? text : text.slice(0, eq);
  const label = eq < 0 ? "" : text.slice(eq + 1);
  const raw = strip(spec);
  if (!raw) throw new SweepError(`${strRepr(text)} names no lines; write LO..HI or N`);
  let lowText, highText;
  if (raw.includes("..")) { const i = raw.indexOf(".."); lowText = raw.slice(0, i); highText = raw.slice(i + 2); } else { lowText = raw; highText = raw; }
  const isInt = (s) => /^\s*[-+]?\d+\s*$/.test(s);
  if (!isInt(lowText) || !isInt(highText)) throw new SweepError(`${strRepr(text)} is not a construct; write LO..HI[=label] or N[=label]`);
  const first = parseInt(lowText, 10), last = parseInt(highText, 10);
  if (first < 1 || last < first) throw new SweepError(`${strRepr(text)} is not a line range: lines start at 1 and LO must not exceed HI`);
  return new Construct({ first, last, label: strip(label) });
}

function* combinations(items, size) {
  const n = items.length;
  if (size > n) return;
  const idx = Array.from({ length: size }, (_, i) => i);
  while (true) {
    yield idx.map((i) => items[i]);
    let i = size - 1;
    while (i >= 0 && idx[i] === i + n - size) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < size; j++) idx[j] = idx[j - 1] + 1;
  }
}

/** Emit the removal lattice: each construct deleted, singly and jointly, after the unedited control. */
export function removalFamily(p, { constructs, order = 1, frozen = [], cwd = process.cwd() }) {
  if (!constructs.length) {
    throw new SweepError("name at least one construct to remove: --construct LO..HI=label. The constructs are the levers this base has "
      + "accumulated; the sweep prices each of them on the base as it stands now.");
  }
  const [raw, code] = readSource(p, cwd);
  for (const item of constructs) {
    if (item.last > raw.length) throw new SweepError(`${p} has ${raw.length} line(s); construct ${item.label || item.site} names line ${item.last}`);
  }
  if (order < 1) throw new SweepError("--order must be at least 1");
  const baseSha = sourceSha256(path.resolve(cwd, String(p)));
  const stem = stemOf(p);
  const variants = [new Variant({
    key: new VariantKey({ site: "control", generator_class: "N", carrier: "-" }),
    filename: `${stem}.N.control.c`,
    text: raw.map((l) => `${l}\n`).join(""),
    description: "the base, unedited: the control every price is measured against",
    detail: { removed: [], control: true },
  })];
  const dropped = [];
  const subsets = [];
  for (let size = 1; size <= Math.min(order, constructs.length); size++) for (const c of combinations(constructs, size)) subsets.push(c);
  if (constructs.length > order) subsets.push([...constructs]);
  for (const subset of subsets) {
    const removed = sorted([...new Set(subset.flatMap((c) => c.lines))]);
    const site = subset.map((c) => c.site).join("+");
    const label = subset.map((c) => c.label || c.site).join("+");
    let composed;
    try {
      composed = applyPlan(new EditPlan({ base: String(p), base_sha256: baseSha,
        edits: removed.map((n) => new Edit({ line: n, expect: raw[n - 1], label })), frozen, label }));
    } catch (e) {
      if (!isCompose(e)) throw e;
      dropped.push({ site, reason: firstLine(e) });
      continue;
    }
    variants.push(new Variant({
      key: new VariantKey({ site, generator_class: "N", carrier: "-" }),
      filename: `${stem}.N.${slug(site)}.c`,
      text: composed.text,
      description: `removed: ${label}`,
      detail: { removed, constructs: subset.map((c) => c.label || c.site), order: subset.length, semantics: removalSemantics(code, removed) },
    }));
  }
  return new SweepManifest({
    generator: "regress", base: String(p), base_sha256: baseSha, variants,
    coverage: new SweepCoverage({ basis: `subsets of ${constructs.length} construct(s) up to order ${order}`, space: 2 ** constructs.length,
      covered: variants.length, excluded: dropped.length }),
    dropped, limits: GENERATOR_LIMITS,
  });
}

/** Name the one shape a removal can break: a definition something reads. */
function removalSemantics(code, removed) {
  const gone = new Set(removed);
  const survivors = code.map((line, i) => (gone.has(i + 1) ? "" : line));
  const broken = [];
  for (const number of removed) {
    for (const name of identNames(identifiers(code[number - 1]))) {
      if (!defines(code[number - 1], name)) continue;
      const stillDefined = definitionLines(code, name).filter((o) => !gone.has(o));
      const stillRead = survivors.some((line) => line && reads(line, name));
      if (stillRead && !stillDefined.length) broken.push(name);
    }
  }
  if (broken.length) return "read-before-definition: " + sorted([...new Set(broken)]).join(", ");
  return "ok";
}

// ---------------------------------------------------------------------------
// H / O / P / A -- the hoists
// ---------------------------------------------------------------------------

const ASSIGN_RE = /^(?<lhs>[^=;]+?)\s*=(?!=)\s*(?<rhs>.+);\s*$/;
const COMPOUND_ASSIGN_RE = /^(?<lhs>[^=;]+?)\s*(?<op>[-+*/%&|^]=|<<=|>>=)\s*(?<rhs>.+);\s*$/;
const LEAF_SRC = String.raw`[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*(?:\s*\[[^\]]*\])?`;
const LEAF_RE = new RegExp(LEAF_SRC);
const BINARY_RE = /\s(?<op>[-+*/]|<<|>>)\s/;

class Hoist {
  constructor(generator_class, tok, leaf, before, after) { Object.assign(this, { generator_class, token: tok, leaf, before, after }); Object.freeze(this); }
  rewrite(carrier) { return this.before + carrier + this.after; }
}

/** Emit hoists of one statement's operands into every available carrier. */
export function hoistFamily(p, { line, classes = ["O"], carriers = [], frozen = [], cwd = process.cwd() }) {
  const [raw] = readSource(p, cwd);
  if (!(line >= 1 && line <= raw.length)) throw new SweepError(`${p} has ${raw.length} line(s); --line names line ${line}`);
  for (const letter of classes) {
    if (!["H", "O", "P", "A"].includes(letter)) {
      throw new SweepError(`${strRepr(letter)} is not a hoist class; choose from H (top-level operand), O (deep operand), P (compound assignment), A (call argument)`);
    }
  }
  const pool = carrierPool(p, { at: line, cwd });
  const names = carriers.length ? carriers : pool.usable.map((c) => c.name);
  if (!names.length) {
    throw new SweepError(`no local is dead at line ${line}, so there is no carrier to hoist into. Run \`decomp-workbench sweep carriers\` `
      + "to see why each declared local was refused; a fresh declaration is not an answer, because it mints a frame slot the gate rejects.");
  }
  const declared = new Set(pool.carriers.map((c) => c.name));
  const unknown = names.filter((n) => !declared.has(n));
  if (unknown.length) throw new SweepError(`${p} does not declare ${unknown.join(", ")}; a carrier must be an existing local`);
  const text = raw[line - 1];
  const indent = indentOf(text);
  const baseSha = sourceSha256(path.resolve(cwd, String(p)));
  const stem = stemOf(p);
  const variants = [], dropped = [];
  const proposals = hoistProposals(strip(text), { classes });
  if (!proposals.length) {
    throw new SweepError(`${p}:${line} offers no hoist of class ${classes.join(", ")}: ${strRepr(strip(text))}. H and O need an assignment `
      + "with a compound right-hand side, P a compound assignment, A a call with an expression argument.");
  }
  for (const proposal of proposals) {
    for (const name of names) {
      const carrier = pool.carriers.find((c) => c.name === name);
      const site = `L${line}.${proposal.token}`;
      const statement = proposal.rewrite(name);
      let composed;
      try {
        composed = applyPlan(new EditPlan({ base: String(p), base_sha256: baseSha,
          edits: [new Edit({ line, expect: text, replace: indent + statement, insert: [`${indent}${name} = ${proposal.leaf};`],
            label: `${proposal.generator_class} hoist into ${name}` })], frozen, anchors: [], label: site }));
      } catch (e) {
        if (!isCompose(e)) throw e;
        dropped.push({ site, reason: firstLine(e) });
        continue;
      }
      variants.push(new Variant({
        key: new VariantKey({ site, generator_class: proposal.generator_class, carrier: name }),
        filename: `${stem}.${proposal.generator_class}.${slug(site)}.${name}.c`,
        text: composed.text,
        description: `hoist ${strRepr(proposal.leaf)} into ${name} (declaration index ${carrier.declaration_index})`,
        detail: { leaf: proposal.leaf, carrier_verdict: carrier.verdict, carrier_declaration_index: carrier.declaration_index, line },
      }));
    }
  }
  return new SweepManifest({
    generator: "hoist", base: String(p), base_sha256: baseSha, variants,
    coverage: new SweepCoverage({ basis: `${proposals.length} hoist site(s) at line ${line} x ${names.length} carrier(s)`,
      space: proposals.length * names.length, covered: variants.length, excluded: dropped.length }),
    dropped, limits: GENERATOR_LIMITS,
  });
}

/** Enumerate the hoists available in one statement, by class. */
export function hoistProposals(statement, { classes }) {
  const found = [];
  const compound = COMPOUND_ASSIGN_RE.exec(statement);
  if (classes.includes("P") && compound) {
    const rhs = compound.groups.rhs;
    const head = statement.slice(0, statement.indexOf(rhs));
    found.push(new Hoist("P", "rhs", rhs, head, ";"));
  }
  const assignment = ASSIGN_RE.exec(statement);
  if (assignment && !compound) {
    const rhs = assignment.groups.rhs;
    const offset = statement.indexOf(rhs);
    if (classes.includes("H")) {
      const split = BINARY_RE.exec(rhs);
      if (split) {
        const s = split.index, e = split.index + split[0].length;
        const left = rhs.slice(0, s), right = rhs.slice(e);
        found.push(new Hoist("H", "lhs", strip(left), statement.slice(0, offset), rhs.slice(s) + ";"));
        found.push(new Hoist("H", "rhs", strip(right), statement.slice(0, offset) + rhs.slice(0, e), ";"));
      }
    }
    if (classes.includes("O")) {
      maximalLeaves(rhs).forEach(([start, end], index) => {
        const leaf = rhs.slice(start, end);
        if (strip(leaf) === strip(rhs)) return;
        found.push(new Hoist("O", `k${index}`, strip(leaf), statement.slice(0, offset + start), statement.slice(offset + end)));
      });
    }
  }
  if (classes.includes("A")) {
    callArguments(statement).forEach(([start, end], index) => {
      const argument = strip(statement.slice(start, end));
      if (!argument || (fullmatch(LEAF_RE, argument) && !argument.includes("."))) return;
      found.push(new Hoist("A", `a${index}`, argument, statement.slice(0, start), statement.slice(end)));
    });
  }
  return found;
}

const isDigitStr = (s) => s.length > 0 && /^\p{Nd}+$/u.test(s);

/** Every maximal leaf token of an expression, as [start, end] offsets. */
export function maximalLeaves(text) {
  const spans = [];
  const re = new RegExp(LEAF_SRC, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const leaf = m[0];
    if (isDigitStr(strip(leaf.split(".")[0].split("->")[0]))) continue;
    const end = m.index + leaf.length;
    if (text.slice(end, end + 1) === "(") continue;
    spans.push([m.index, end]);
  }
  return spans;
}

/** Every top-level argument span of the first call in the statement. */
export function callArguments(statement) {
  const open = statement.indexOf("(");
  if (open < 0) return [];
  let depth = 0, start = open + 1;
  const spans = [];
  for (let index = open; index < statement.length; index++) {
    const ch = statement[index];
    if ("([".includes(ch)) depth++;
    else if (")]".includes(ch)) {
      depth--;
      if (depth === 0) { spans.push([start, index]); break; }
    } else if (ch === "," && depth === 1) { spans.push([start, index]); start = index + 1; }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// C -- the commutative flip
// ---------------------------------------------------------------------------

export const COMMUTATIVE_OPERATORS = Object.freeze(["*", "+", "&", "|", "^"]);

const ATOM_RE = new RegExp(String.raw`^\s*(?:[A-Za-z_]\w*(?:\s*(?:\.|->)\s*[A-Za-z_]\w*)*(?:\s*\[[^\]]*\])?|\(.*\)|-?\d+\.?\d*[fFuUlL]*)\s*$`);

/** Emit one variant per commutative operand pair, exchanged. */
export function commutativeFamily(p, { lines = [], operators = COMMUTATIVE_OPERATORS, frozen = [], cwd = process.cwd() } = {}) {
  const [raw, code] = readSource(p, cwd);
  const baseSha = sourceSha256(path.resolve(cwd, String(p)));
  const stem = stemOf(p);
  const wanted = lines.length ? new Set(lines) : null;
  const declaredAt = new Set(declarations(code).map((d) => d.line));
  const variants = [], dropped = [];
  let space = 0;
  code.forEach((text, i) => {
    const number = i + 1;
    if (wanted && !wanted.has(number)) return;
    if (declaredAt.has(number)) return;
    commutativePairs(text, operators).forEach(([start, end, left, operator, right], index) => {
      space += 1;
      const site = `L${number}.p${index}`;
      if (!ATOM_RE.test(left) || !ATOM_RE.test(right)) {
        dropped.push({ site, reason: `exchanging ${strRepr(strip(left))} and ${strRepr(strip(right))} would need parentheses to stay `
          + "associative-safe; the parentheses are a second, untested edit" });
        return;
      }
      const sourceLine = raw[number - 1];
      const [lh, lc, lt] = spaced(left), [rh, rc, rt] = spaced(right);
      const middle = sourceLine.slice(start + left.length, end - right.length);
      const replaced = sourceLine.slice(0, start) + lh + rc + lt + middle + rh + lc + rt + sourceLine.slice(end);
      let composed;
      try {
        composed = applyPlan(new EditPlan({ base: String(p), base_sha256: baseSha,
          edits: [new Edit({ line: number, expect: sourceLine, replace: replaced, label: `exchange ${strip(left)} ${operator} ${strip(right)}` })],
          frozen, label: site }));
      } catch (e) {
        if (!isCompose(e)) throw e;
        dropped.push({ site, reason: firstLine(e) });
        return;
      }
      variants.push(new Variant({
        key: new VariantKey({ site, generator_class: "C", carrier: operator }),
        filename: `${stem}.C.${slug(site)}.c`, text: composed.text,
        description: `line ${number}: ${strip(left)} ${operator} ${strip(right)} exchanged`,
        detail: { line: number, operator },
      }));
    });
  });
  if (!variants.length && !dropped.length) {
    const where = wanted && wanted.size ? ` on line(s) ${sorted([...wanted]).join(", ")}` : "";
    throw new SweepError(`${p} has no exchangeable commutative operand pair${where}`);
  }
  return new SweepManifest({
    generator: "commute", base: String(p), base_sha256: baseSha, variants,
    coverage: new SweepCoverage({ basis: `commutative operand pairs over ${operators.join(", ")}`, space, covered: variants.length, excluded: dropped.length }),
    dropped, limits: GENERATOR_LIMITS,
  });
}

const PRECEDENCE = { "*": 5, "/": 5, "%": 5, "+": 4, "-": 4, "<<": 3, ">>": 3, "&": 2, "^": 1, "|": 0 };
const BAIL = ["&&", "||", "?", ":", "==", "!=", "<=", ">=", "!", "="];

/** [start, end, left, operator, right] for each exchangeable pair. */
export function commutativePairs(text, operators) {
  const found = [];
  const pending = [...arithmeticRegions(text)];
  while (pending.length) {
    const [start, end] = pending.shift();
    const region = text.slice(start, end);
    for (const [low, high] of parenthesized(region)) pending.push([start + low, start + high]);
    const [operands, tokens] = splitExpression(region);
    if (!tokens.length) continue;
    tokens.forEach(([, operator], index) => {
      if (!operators.includes(operator)) return;
      const leftPrec = index ? PRECEDENCE[tokens[index - 1][1]] : -1;
      const rightPrec = index + 1 < tokens.length ? PRECEDENCE[tokens[index + 1][1]] : -1;
      if (leftPrec >= PRECEDENCE[operator]) return;
      if (rightPrec > PRECEDENCE[operator]) return;
      const ls = operands[index], rs = operands[index + 1];
      found.push([start + ls[0], start + rs[1], region.slice(ls[0], ls[1]), operator, region.slice(rs[0], rs[1])]);
    });
  }
  return found;
}

function spaced(text) {
  const core = strip(text);
  const head = text.slice(0, text.length - lstrip(text).length);
  const tail = text.slice(rstrip(text).length);
  return [head, core, tail];
}

const isAlnum = (c) => /^[\p{L}\p{N}]$/u.test(c);

/** The interiors of the depth-zero parenthesized groups in `region`. */
function parenthesized(region) {
  const spans = [];
  let depth = 0, opened = 0;
  for (let index = 0; index < region.length; index++) {
    const ch = region[index];
    if (ch === "(") {
      depth++;
      if (depth === 1) opened = index + 1;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && index > opened) {
        const before = strip(region.slice(Math.max(0, opened - 2), Math.max(0, opened - 1))).slice(-1);
        if (before && isAlnum(before)) continue; // a call's argument list, not a grouping
        spans.push([opened, index]);
      }
    } else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return spans;
}

/** The spans of one statement worth scanning for an operand pair. */
function arithmeticRegions(text) {
  const statement = rstrip(text);
  if (!statement.endsWith(";")) return [];
  const body = statement.slice(0, statement.lastIndexOf(";"));
  let depth = 0;
  for (let index = 0; index < body.length; index++) {
    const ch = body[index];
    if ("([".includes(ch)) depth++;
    else if (")]".includes(ch)) depth--;
    else if (depth === 0 && ch === "=" && body.slice(index + 1, index + 2) !== "="
      && !["=", "!", "<", ">", "+", "-", "*", "/"].includes(body.slice(Math.max(0, index - 1), index))) {
      return [[index + 1, body.length]];
    }
  }
  return callArguments(statement);
}

/** Split one arithmetic region into depth-zero operands and operators. */
function splitExpression(region) {
  for (const marker of BAIL) if (containsAtTopLevel(region, marker)) return [[], []];
  const operands = [], tokens = [];
  let depth = 0, start = 0, index = 0;
  while (index < region.length) {
    const ch = region[index];
    if ("([".includes(ch)) { depth++; index++; continue; }
    if (")]".includes(ch)) { depth--; index++; continue; }
    if (depth) { index++; continue; }
    if (region.startsWith("->", index)) { index += 2; continue; }
    let tok = null;
    if (region.startsWith("<<", index) || region.startsWith(">>", index)) tok = region.slice(index, index + 2);
    else if ("*/%+-&|^".includes(ch)) tok = ch;
    if (tok === null) { index++; continue; }
    if (!strip(region.slice(start, index))) { index += tok.length; continue; }
    operands.push([start, index]);
    tokens.push([index, tok]);
    start = index + tok.length;
    index += tok.length;
  }
  operands.push([start, region.length]);
  return [operands, tokens];
}

function containsAtTopLevel(region, marker) {
  let depth = 0, index = 0;
  while (index < region.length) {
    const ch = region[index];
    if ("([".includes(ch)) depth++;
    else if (")]".includes(ch)) depth--;
    else if (depth === 0 && region.startsWith(marker, index)) {
      if (marker === "=" && region.slice(index + 1, index + 2) === "=") { index += 2; continue; }
      return true;
    }
    index++;
  }
  return false;
}

// ---------------------------------------------------------------------------
// K -- copy elimination
// ---------------------------------------------------------------------------

const COPY_RE = /^\s*(?<target>[A-Za-z_]\w*)\s*=\s*(?<source>[A-Za-z_]\w*)\s*;\s*$/;

/** Emit one variant per removable copy `Y = X;`, rehosting Y's reads on X. */
export function copyFamily(p, { frozen = [], cwd = process.cwd() } = {}) {
  const [raw, code] = readSource(p, cwd);
  const baseSha = sourceSha256(path.resolve(cwd, String(p)));
  const stem = stemOf(p);
  const declared = new Map(declarations(code).map((d) => [d.name, d]));
  const variants = [], dropped = [];
  let space = 0;
  code.forEach((text, i) => {
    const number = i + 1;
    const m = COPY_RE.exec(text);
    if (!m) return;
    const { target, source: origin } = m.groups;
    if (!declared.has(target) || !declared.has(origin)) return;
    space += 1;
    const site = `L${number}`;
    const reason = copyRefusal(code, { target, origin, at: number });
    if (reason !== null) { dropped.push({ site, reason }); return; }
    const edits = [new Edit({ line: number, expect: raw[number - 1], label: `drop ${target} = ${origin}` })];
    const rehosted = [];
    for (let other = number + 1; other <= code.length; other++) {
      if (!reads(code[other - 1], target)) continue;
      rehosted.push(other);
      edits.push(new Edit({ line: other, expect: raw[other - 1], replace: rename(raw[other - 1], target, origin), label: `read ${origin} instead of ${target}` }));
    }
    let composed;
    try {
      composed = applyPlan(new EditPlan({ base: String(p), base_sha256: baseSha, edits, frozen, label: site }));
    } catch (e) {
      if (!isCompose(e)) throw e;
      dropped.push({ site, reason: firstLine(e) });
      return;
    }
    variants.push(new Variant({
      key: new VariantKey({ site, generator_class: "K", carrier: origin }),
      filename: `${stem}.K.${slug(site)}.${origin}.c`, text: composed.text,
      description: `line ${number}: drop ${target} = ${origin} and read ${origin} at ${rehosted.length} later line(s)`,
      detail: { line: number, target, origin, rehosted },
    }));
  });
  if (!space) throw new SweepError(`${p} holds no copy of the form \`Y = X;\` between two declared locals`);
  return new SweepManifest({
    generator: "copies", base: String(p), base_sha256: baseSha, variants,
    coverage: new SweepCoverage({ basis: "copies of the form Y = X between two declared locals", space, covered: variants.length, excluded: dropped.length }),
    dropped, limits: GENERATOR_LIMITS,
  });
}

function copyRefusal(code, { target, origin, at }) {
  if (truthyList(takesAddress(code, target)) || truthyList(takesAddress(code, origin))) return `${target} or ${origin} has its address taken; a callee may write it`;
  const laterReads = [], laterWrites = [];
  for (let n = at + 1; n <= code.length; n++) {
    if (reads(code[n - 1], target)) laterReads.push(n);
    if (defines(code[n - 1], target)) laterWrites.push(n);
  }
  if (laterWrites.length) return `${target} is written again at line ${laterWrites[0]}, so its later reads are not all this copy's value`;
  if (!laterReads.length) return `nothing reads ${target} after line ${at}; the copy is already dead`;
  const lastRead = Math.max(...laterReads);
  for (let n = at + 1; n <= lastRead; n++) {
    if (defines(code[n - 1], origin)) return `${origin} is written at line ${n}, before ${target}'s last read at line ${lastRead}`;
  }
  return null;
}

function rename(text, old, neu) {
  return text.replace(new RegExp(`(?<![\\w.])(?<!->)${reEscape(old)}\\b`, "g"), () => neu);
}

// ---------------------------------------------------------------------------
// F -- live-range fusion
// ---------------------------------------------------------------------------

/** One fusion candidate, with the live-range fact that decides it. */
export class Donor {
  constructor({ name, declaration_line, declaration_index, type_text, first, last, disjoint, reason }) {
    Object.assign(this, { name, declaration_line, declaration_index, type_text, first, last, disjoint, reason });
    Object.freeze(this);
  }
  asDict() {
    return { name: this.name, declaration_line: this.declaration_line, declaration_index: this.declaration_index, type: this.type_text,
      live_from: this.first, live_to: this.last, disjoint: this.disjoint, reason: this.reason };
  }
}

/** First write to last read (a bare declaration is not a definition). */
function liveRange(code, name) {
  const touched = new Set(definitionLines(code, name));
  code.forEach((line, i) => { if (reads(line, name)) touched.add(i + 1); });
  if (!touched.size) return null;
  return [Math.min(...touched), Math.max(...touched)];
}

/** Rank every local by whether its live range avoids the target's. */
export function fusionDonors(p, { target, cwd = process.cwd() }) {
  const code = readSource(p, cwd)[1];
  const declared = new Map(declarations(code).map((d) => [d.name, d]));
  if (!declared.has(target)) throw new CSourceError(`${p} does not declare ${strRepr(target)}; a fusion target must be a local this file declares`);
  const span = liveRange(code, target);
  if (span === null) throw new CSourceError(`nothing in ${p} reads or writes ${target}`);
  const [low, high] = span;
  const found = [];
  for (const d of declarations(code)) {
    if (d.name === target || d.is_array) continue;
    const ds = liveRange(code, d.name);
    if (ds === null) continue;
    const [first, last] = ds;
    let disjoint, reason;
    if (truthyList(takesAddress(code, d.name))) { disjoint = false; reason = "its address is taken; a callee may hold a pointer"; }
    else if (d.type_text !== declared.get(target).type_text) { disjoint = false; reason = `type ${d.type_text} is not the target's ${declared.get(target).type_text}`; }
    else if (last < low) { disjoint = true; reason = `dies at line ${last}, before the target lives at ${low}`; }
    else if (first > high) { disjoint = true; reason = `lives from line ${first}, after the target dies at ${high}`; }
    else { disjoint = false; reason = `live ${first}..${last} overlaps the target's ${low}..${high}`; }
    found.push(new Donor({ name: d.name, declaration_line: d.line, declaration_index: d.index, type_text: d.type_text, first, last, disjoint, reason }));
  }
  return sorted(found, (x) => [!x.disjoint, x.declaration_index]);
}

/** Emit one variant per donor fused into the target. */
export function fusionFamily(p, { target, donors = [], frozen = [], cwd = process.cwd() }) {
  const [raw, code] = readSource(p, cwd);
  const baseSha = sourceSha256(path.resolve(cwd, String(p)));
  const stem = stemOf(p);
  const table = fusionDonors(p, { target, cwd });
  const byName = new Map(table.map((d) => [d.name, d]));
  const wanted = donors.length ? donors : table.filter((d) => d.disjoint).map((d) => d.name);
  const unknown = wanted.filter((n) => !byName.has(n));
  if (unknown.length) throw new SweepError(`${p} declares no fusable local named ${unknown.join(", ")}`);
  if (!wanted.length) {
    throw new SweepError(`no local's live range avoids ${target}'s in ${p}. Run \`decomp-workbench sweep donors\` to see each local's range and the overlap that refused it.`);
  }
  const variants = [], dropped = [];
  for (const name of wanted) {
    const donor = byName.get(name);
    const site = `${name}->${target}`;
    if (!donor.disjoint) { dropped.push({ site, reason: donor.reason }); continue; }
    const edits = [];
    for (let number = 1; number <= code.length; number++) {
      const line = code[number - 1];
      if (number === donor.declaration_line) {
        edits.push(new Edit({ line: number, expect: raw[number - 1], replace: dropDeclarator(raw[number - 1], name), label: `drop the declaration of ${name}` }));
        continue;
      }
      if (reads(line, name) || defines(line, name)) {
        edits.push(new Edit({ line: number, expect: raw[number - 1], replace: rename(raw[number - 1], name, target), label: `${name} becomes ${target}` }));
      }
    }
    let composed;
    try {
      composed = applyPlan(new EditPlan({ base: String(p), base_sha256: baseSha, edits, frozen, label: site }));
    } catch (e) {
      if (!isCompose(e)) throw e;
      dropped.push({ site, reason: firstLine(e) });
      continue;
    }
    variants.push(new Variant({
      key: new VariantKey({ site, generator_class: "F", carrier: target }),
      filename: `${stem}.F.${slug(name)}.${slug(target)}.c`, text: composed.text,
      description: `fuse ${name} (live ${donor.first}..${donor.last}) into ${target}: ${donor.reason}`,
      detail: donor.asDict(),
    }));
  }
  return new SweepManifest({
    generator: "fuse", base: String(p), base_sha256: baseSha, variants,
    coverage: new SweepCoverage({ basis: `locals whose live range avoids ${target}'s`, space: table.length, covered: variants.length,
      excluded: table.length - variants.length }),
    dropped, limits: GENERATOR_LIMITS,
  });
}

/** Remove one declarator from a declaration, or the whole line (null). */
function dropDeclarator(text, name) {
  const stripped = strip(text);
  const body = rstrip(stripped, ";");
  const parts = body.split(",").map((x) => strip(x));
  if (parts.length <= 1) return null;
  const sp = parts[0].lastIndexOf(" ");
  const head = sp < 0 ? "" : parts[0].slice(0, sp);
  const first = sp < 0 ? parts[0] : parts[0].slice(sp + 1);
  const declName = (item) => strip(item.split("=")[0]).replace(/^\*+/, "");
  const kept = parts.filter((item, i) => declName(item) !== name && i !== 0);
  if (declName(first) === name) {
    if (!kept.length) return null;
    return indentOf(text) + head + " " + kept.join(", ") + ";";
  }
  return indentOf(text) + [parts[0], ...kept].join(", ") + ";";
}

export { sum };
