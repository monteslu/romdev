// makefile.js - evaluate a decomp project's GNU Makefile in JS, so romdev can
// derive the exact per-target recipe (the compile command of one TU, the link,
// the ROM step) from the project's own build configuration without running
// host `make`.
//
// This is a GNU make *reader*: variables in all flavours (=, :=, ::=, ?=, +=,
// define/endef, override, export), conditionals (ifeq/ifneq/ifdef/ifndef with
// else-chains), include/-include, the function set decomp Makefiles use,
// substitution references, target- and pattern-specific variables, explicit
// and pattern rules, and automatic variables. Recipes are returned expanded,
// never executed here (recipe.js runs them through WASM).
//
// $(shell ...) never reaches a host shell. The handful of probe commands
// Makefiles use (which / command -v / type, uname, nproc, getconf, find,
// mkdir -p, cat, echo, test) are answered in JS against the project tree and
// romdev's WASM tool set; anything else expands to "" and is reported in
// `shellUnanswered`, so a caller can see what configuration was guessed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Program names romdev provides as WASM, which `which`/`type` probes should find. */
export const EMULATED_PROGRAMS = [
  ...["as", "ld", "objcopy", "objdump", "ar", "nm", "strip", "readelf"].map((t) => "mips-linux-gnu-" + t),
  "cpp", "sha1sum", "md5sum", "printf", "echo", "true", ":", "mkdir", "rm", "cp", "iconv",
];

class MakeError extends Error {}

function splitWords(s) { return s.split(/[ \t\n]+/).filter(Boolean); }

/** Find the matching close paren for a `$(`/`${` reference starting at i (pointing at '(' or '{'). */
function matchParen(s, i) {
  const open = s[i], close = open === "(" ? ")" : "}";
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

/** Split function arguments on top-level commas (parens/braces nest). */
function splitArgs(s, max = Infinity) {
  const out = [];
  let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    if (c === "," && depth === 0 && out.length < max - 1) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function patMatch(pattern, word) {
  const p = pattern.indexOf("%");
  if (p < 0) return pattern === word ? "" : null;
  const pre = pattern.slice(0, p), post = pattern.slice(p + 1);
  if (word.length >= pre.length + post.length && word.startsWith(pre) && word.endsWith(post)) return word.slice(pre.length, word.length - post.length);
  return null;
}
function patSubst(pattern, repl, word) {
  const stem = patMatch(pattern, word);
  if (stem === null) return word;
  return repl.includes("%") ? repl.replace("%", stem) : repl;
}

function globToRe(g) {
  return new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\[!/g, "[^") + "$");
}

export class Makefile {
  /**
   * @param {{root:string, overrides?:Record<string,string>, env?:Record<string,string>, makefile?:string}} a
   */
  constructor({ root, overrides = {}, env = {} }) {
    this.root = root;
    this.vars = new Map();          // name -> {flavor:'simple'|'recursive', value, origin}
    this.overrides = overrides;     // command-line variables (win over the makefile)
    this.rules = [];                // {targets[], prereqs[], orderOnly[], recipe[], pattern:boolean, double:boolean}
    this.targetVars = [];           // {pattern, name, op, value, override}
    this.shellUnanswered = [];
    this.warnings = [];
    this.phony = new Set();
    for (const [k, v] of Object.entries(env)) this.vars.set(k, { flavor: "recursive", value: v, origin: "environment" });
    for (const [k, v] of Object.entries(overrides)) this.vars.set(k, { flavor: "recursive", value: v, origin: "command line" });
    this.vars.set("MAKE", { flavor: "recursive", value: "make", origin: "default" });
    this.vars.set("SHELL", { flavor: "recursive", value: "/bin/sh", origin: "default" });
    this.vars.set("CURDIR", { flavor: "simple", value: root, origin: "default" });
    this.vars.set("RM", { flavor: "recursive", value: "rm -f", origin: "default" });
    this.vars.set("MAKEFILE_LIST", { flavor: "simple", value: "", origin: "default" });
  }

  static async load(root, { makefile = "Makefile", overrides = {}, env = {} } = {}) {
    const mk = new Makefile({ root, overrides, env });
    mk.loadOptions = { makefile, overrides, env };
    mk.includes = [];
    mk.readFile(path.resolve(root, makefile), false);
    return mk;
  }

  // -- reading ---------------------------------------------------------
  readFile(file, optional) {
    let text;
    // Every makefile read (or -included and missing) is a candidate for
    // GNU make's "remaking makefiles" step (build.js remakeMakefiles).
    if (this.includes && file !== path.resolve(this.root, this.loadOptions.makefile)) this.includes.push(path.relative(this.root, file));
    try { text = fs.readFileSync(file, "utf8"); }
    catch (e) { if (optional) return; throw new MakeError(`${path.relative(this.root, file)}: ${e.message}`); }
    const cur = this.vars.get("MAKEFILE_LIST");
    cur.value = (cur.value ? cur.value + " " : "") + path.relative(this.root, file);
    this.evalText(text, path.relative(this.root, file));
  }

  /** Logical lines: backslash-newline joins (recipe lines keep the break). */
  logicalLines(text) {
    const raw = text.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      let line = raw[i];
      const start = i + 1;
      const isRecipe = line.startsWith("\t");
      while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < raw.length) {
        i++;
        if (isRecipe) line = line + "\n" + raw[i].replace(/^\t/, "");
        else line = line.slice(0, -1).replace(/[ \t]+$/, "") + " " + raw[i].replace(/^[ \t]+/, "");
      }
      out.push({ text: line, lineNo: start });
    }
    return out;
  }

  static stripComment(line) {
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\" && line[i + 1] === "#") { out += "#"; i++; continue; }
      if (c === "#") break;
      out += c;
    }
    return out;
  }

  evalText(text, fileLabel = "<eval>") {
    const lines = this.logicalLines(text);
    const cond = []; // stack of {active, done, parentActive}
    const active = () => cond.every((c) => c.active);
    let rule = null; // current rule collecting recipe lines
    for (let li = 0; li < lines.length; li++) {
      const { text: rawLine, lineNo } = lines[li];
      const where = `${fileLabel}:${lineNo}`;
      // Recipe line.
      if (rawLine.startsWith("\t") && rule) {
        if (active()) rule.recipe.push(rawLine.slice(1));
        continue;
      }
      const line = Makefile.stripComment(rawLine);
      const t = line.trim();
      // define ... endef
      let m;
      if ((m = /^(override\s+|export\s+)*define\s+([^\s:+?!=]+)\s*(=|:=|::=|\+=|\?=)?\s*$/.exec(t))) {
        const body = [];
        let depth = 1;
        for (li++; li < lines.length; li++) {
          const lt = lines[li].text.trim();
          if (/^define\b/.test(lt)) depth++;
          if (/^endef\b/.test(lt) && --depth === 0) break;
          body.push(lines[li].text);
        }
        if (active()) this.assign(m[2], m[3] ?? "=", body.join("\n"), { override: /override/.test(m[1] ?? "") });
        rule = null;
        continue;
      }
      // conditionals
      if ((m = /^(ifeq|ifneq|ifdef|ifndef)\b(.*)$/.exec(t))) {
        const parentActive = active();
        const val = parentActive ? this.evalCond(m[1], m[2].trim(), where) : false;
        cond.push({ active: val, done: val });
        continue;
      }
      if ((m = /^else\b\s*(.*)$/.exec(t))) {
        const c = cond[cond.length - 1];
        if (!c) throw new MakeError(`${where}: else without if`);
        const rest = m[1].trim();
        const parentActive = cond.slice(0, -1).every((x) => x.active);
        if (c.done) c.active = false;
        else if (!rest) { c.active = true; c.done = true; }
        else {
          const mm = /^(ifeq|ifneq|ifdef|ifndef)\b(.*)$/.exec(rest);
          if (!mm) throw new MakeError(`${where}: malformed else`);
          const v = parentActive ? this.evalCond(mm[1], mm[2].trim(), where) : false;
          c.active = v; if (v) c.done = true;
        }
        continue;
      }
      // Conditionals do not end a rule's recipe.
      if (/^endif\b/.test(t)) { if (!cond.pop()) throw new MakeError(`${where}: endif without if`); continue; }
      if (!active()) continue;
      if (!t) continue;
      // include
      if ((m = /^(-?include|sinclude)\s+(.*)$/.exec(t))) {
        const optional = m[1] !== "include";
        for (const f of splitWords(this.expand(m[2]))) {
          const files = /[*?[]/.test(f) ? this.wildcard(f) : [f];
          for (const ff of files) this.readFile(path.resolve(this.root, ff), optional);
        }
        rule = null;
        continue;
      }
      if ((m = /^(export|unexport)(\s+.*)?$/.exec(t)) && !/[:=]/.test(m[2] ?? "")) { rule = null; continue; }
      if (/^vpath\b/.test(t)) { rule = null; continue; }
      // assignment (not a rule): find the first assignment operator outside $(...)
      const asg = this.findAssignment(t);
      if (asg) {
        let name = asg.lhs.trim();
        let override = false;
        for (;;) {
          const mm = /^(override|export|private)\s+(.*)$/.exec(name);
          if (!mm) break;
          if (mm[1] === "override") override = true;
          name = mm[2].trim();
        }
        this.assign(this.expand(name).trim(), asg.op, asg.rhs.replace(/^[ \t]+/, ""), { override });
        rule = null;
        continue;
      }
      // rule or target-specific variable
      const colon = this.findRuleColon(t);
      if (colon) {
        const targets = splitWords(this.expand(colon.lhs));
        let rhs = colon.rhs;
        // target-specific variable: `targets: [override] VAR op value`
        const tv = this.findAssignment(rhs.trim());
        if (tv && !/^\s*[^=]*;/.test(rhs)) {
          let name = tv.lhs.trim(), override = false;
          for (;;) { const mm = /^(override|export|private)\s+(.*)$/.exec(name); if (!mm) break; if (mm[1] === "override") override = true; name = mm[2].trim(); }
          for (const tgt of targets) this.targetVars.push({ pattern: tgt, name: this.expand(name).trim(), op: tv.op, value: tv.rhs.replace(/^[ \t]+/, ""), override });
          rule = null;
          continue;
        }
        let inlineRecipe = null;
        const semi = rhs.indexOf(";");
        if (semi >= 0) { inlineRecipe = rhs.slice(semi + 1); rhs = rhs.slice(0, semi); }
        const expanded = this.expand(rhs);
        // static pattern rule: `targets: target-pattern: prereq-patterns`
        const sp = /^([^:]*):(?!:)([^]*)$/.exec(expanded);
        if (sp && !colon.double) {
          const tpat = sp[1].trim();
          const [sNormal, sOrder = ""] = sp[2].split("|");
          const recipe = [];
          if (inlineRecipe !== null && inlineRecipe.trim()) recipe.push(inlineRecipe.trim());
          for (const tgt of targets) {
            const stem = patMatch(tpat, tgt);
            if (stem === null) throw new MakeError(`${where}: target '${tgt}' doesn't match the target pattern '${tpat}'`);
            const sub = (w) => w.replace("%", stem);
            this.rules.push({ targets: [tgt], prereqs: splitWords(sNormal).map(sub), orderOnly: splitWords(sOrder).map(sub), recipe, pattern: false, staticStem: stem, double: false, where });
          }
          rule = { recipe };
          continue;
        }
        const [normal, orderOnly = ""] = expanded.split("|");
        rule = { targets, prereqs: splitWords(normal), orderOnly: splitWords(orderOnly), recipe: [], pattern: targets.some((x) => x.includes("%")), double: colon.double, where };
        if (inlineRecipe !== null && inlineRecipe.trim()) rule.recipe.push(inlineRecipe.trim());
        if (targets.includes(".PHONY")) for (const p of rule.prereqs) this.phony.add(p);
        this.rules.push(rule);
        continue;
      }
      // a line that is just a function call ($(info ...), $(eval ...), $(error ...))
      if (/^\$[({]/.test(t)) { this.expand(t); continue; }
      throw new MakeError(`${where}: cannot parse makefile line: ${t.slice(0, 120)}`);
    }
    if (cond.length) throw new MakeError(`${fileLabel}: missing endif`);
  }

  /** The first assignment operator at paren depth 0, if the line is an assignment. */
  findAssignment(t) {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "$" && (t[i + 1] === "(" || t[i + 1] === "{")) { const j = matchParen(t, i + 1); if (j < 0) return null; i = j; continue; }
      if (c === "(" || c === "{") depth++;
      else if (c === ")" || c === "}") depth--;
      if (depth) continue;
      if (c === "=") {
        const prev = t[i - 1];
        if (prev === ":" && t[i - 2] === ":") return { lhs: t.slice(0, i - 2), op: ":=", rhs: t.slice(i + 1) };
        if (prev === ":") return { lhs: t.slice(0, i - 1), op: ":=", rhs: t.slice(i + 1) };
        if (prev === "+") return { lhs: t.slice(0, i - 1), op: "+=", rhs: t.slice(i + 1) };
        if (prev === "?") return { lhs: t.slice(0, i - 1), op: "?=", rhs: t.slice(i + 1) };
        if (prev === "!") return { lhs: t.slice(0, i - 1), op: "!=", rhs: t.slice(i + 1) };
        return { lhs: t.slice(0, i), op: "=", rhs: t.slice(i + 1) };
      }
      if (c === ":" && t[i + 1] !== "=" && !(t[i + 1] === ":" && t[i + 2] === "=")) return null; // a rule colon comes first
    }
    return null;
  }

  findRuleColon(t) {
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === "$" && (t[i + 1] === "(" || t[i + 1] === "{")) { const j = matchParen(t, i + 1); if (j < 0) return null; i = j; continue; }
      if (c === ":") {
        const double = t[i + 1] === ":";
        return { lhs: t.slice(0, i), rhs: t.slice(i + (double ? 2 : 1)), double };
      }
    }
    return null;
  }

  assign(name, op, value, { override = false } = {}) {
    const cur = this.vars.get(name);
    if (cur && cur.origin === "command line" && !override) return;
    switch (op) {
      case "=": this.vars.set(name, { flavor: "recursive", value, origin: "file" }); break;
      case ":=": case "::=": this.vars.set(name, { flavor: "simple", value: this.expand(value), origin: "file" }); break;
      case "?=": if (!cur) this.vars.set(name, { flavor: "recursive", value, origin: "file" }); break;
      case "!=": this.vars.set(name, { flavor: "simple", value: this.shell(this.expand(value)), origin: "file" }); break;
      case "+=":
        if (!cur) this.vars.set(name, { flavor: "recursive", value, origin: "file" });
        else if (cur.flavor === "simple") cur.value = cur.value + (cur.value ? " " : "") + this.expand(value);
        else cur.value = cur.value + (cur.value ? " " : "") + value;
        break;
      default: throw new MakeError(`unknown assignment operator ${op}`);
    }
  }

  evalCond(kind, argText, where) {
    if (kind === "ifdef" || kind === "ifndef") {
      const name = this.expand(argText).trim();
      const v = this.vars.get(name);
      const defined = !!v && v.value !== "";
      return kind === "ifdef" ? defined : !defined;
    }
    let a, b;
    const s = argText.trim();
    if (s.startsWith("(")) {
      const end = matchParen(s, 0);
      if (end < 0) throw new MakeError(`${where}: malformed ${kind}`);
      const inner = s.slice(1, end);
      const parts = splitArgs(inner, 2);
      if (parts.length !== 2) throw new MakeError(`${where}: malformed ${kind}`);
      a = this.expand(parts[0].trim()); b = this.expand(parts[1].trim());
    } else {
      const m = /^(["'])(.*?)\1\s+(["'])(.*?)\3\s*$/.exec(s);
      if (!m) throw new MakeError(`${where}: malformed ${kind}`);
      a = this.expand(m[2]); b = this.expand(m[4]);
    }
    return kind === "ifeq" ? a === b : a !== b;
  }

  // -- expansion -------------------------------------------------------
  lookup(name, ctx) {
    if (ctx?.auto && name in ctx.auto) return ctx.auto[name];
    if (ctx?.targetVars && ctx.targetVars.has(name)) {
      const tv = ctx.targetVars.get(name);
      return tv.flavor === "simple" ? tv.value : this.expand(tv.value, ctx, name);
    }
    const v = this.vars.get(name);
    if (!v) return "";
    return v.flavor === "simple" ? v.value : this.expand(v.value, ctx, name);
  }

  expand(s, ctx = null, _selfName = null, depth = 0) {
    if (depth > 200) throw new MakeError("recursive variable expansion too deep");
    if (!s.includes("$")) return s;
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "$") { out += c; continue; }
      const n = s[i + 1];
      if (n === undefined) break;
      if (n === "$") { out += "$"; i++; continue; }
      if (n === "(" || n === "{") {
        const end = matchParen(s, i + 1);
        if (end < 0) throw new MakeError(`unterminated variable reference: ${s.slice(i, i + 40)}`);
        const inner = s.slice(i + 2, end);
        out += this.expandRef(inner, ctx, depth);
        i = end;
        continue;
      }
      // single-character variable ($@, $<, $^, $*, $?, $+, $|, $X)
      out += this.lookup(n, ctx);
      i++;
    }
    return out;
  }

  expandRef(inner, ctx, depth) {
    // function call?
    // A function needs whitespace after its name: $(dir) is the VARIABLE dir.
    const fm = /^([a-z-]+)[ \t]+([\s\S]*)$/.exec(inner);
    if (fm && FUNCTIONS.has(fm[1])) return this.callFunction(fm[1], fm[2] ?? "", ctx, depth);
    // substitution reference $(VAR:a=b)
    const colon = inner.indexOf(":");
    if (colon > 0 && inner.indexOf("=", colon) > colon && !inner.slice(0, colon).includes("$(")) {
      const name = this.expand(inner.slice(0, colon), ctx, null, depth + 1);
      const spec = inner.slice(colon + 1);
      const eq = spec.indexOf("=");
      const from = this.expand(spec.slice(0, eq), ctx, null, depth + 1), to = this.expand(spec.slice(eq + 1), ctx, null, depth + 1);
      const val = this.lookup(name, ctx);
      const pat = from.includes("%") ? from : "%" + from, rep = from.includes("%") ? to : "%" + to;
      return splitWords(val).map((w) => patSubst(pat, rep, w)).join(" ");
    }
    const name = this.expand(inner, ctx, null, depth + 1);
    // $(@D) $(@F) $(*D) $(<F) ...
    const dm = /^([@<*^?+])([DF])$/.exec(name);
    if (dm) {
      const words = splitWords(this.lookup(dm[1], ctx));
      return words.map((w) => (dm[2] === "D" ? (path.posix.dirname(w) || ".") : path.posix.basename(w))).join(" ");
    }
    return this.lookup(name, ctx);
  }

  callFunction(fn, argText, ctx, depth) {
    const X = (s) => this.expand(s, ctx, null, depth + 1);
    const args = (n) => splitArgs(argText, n);
    switch (fn) {
      case "subst": { const [a, b, t] = args(3).map(X); return t.split(a).join(b); }
      case "patsubst": { const [p, r, t] = args(3).map(X); return splitWords(t).map((w) => patSubst(p.trim(), r.trim(), w)).join(" "); }
      case "strip": return splitWords(X(argText)).join(" ");
      case "findstring": { const [a, t] = args(2).map(X); return t.includes(a) ? a : ""; }
      case "filter": case "filter-out": {
        const [p, t] = args(2).map(X);
        const pats = splitWords(p);
        return splitWords(t).filter((w) => pats.some((pp) => patMatch(pp, w) !== null) === (fn === "filter")).join(" ");
      }
      case "sort": return [...new Set(splitWords(X(argText)))].sort().join(" ");
      case "word": { const [n, t] = args(2).map(X); return splitWords(t)[Number(n) - 1] ?? ""; }
      case "wordlist": { const [s, e, t] = args(3).map(X); return splitWords(t).slice(Number(s) - 1, Number(e)).join(" "); }
      case "words": return String(splitWords(X(argText)).length);
      case "firstword": return splitWords(X(argText))[0] ?? "";
      case "lastword": { const w = splitWords(X(argText)); return w[w.length - 1] ?? ""; }
      case "dir": return splitWords(X(argText)).map((w) => (w.includes("/") ? w.slice(0, w.lastIndexOf("/") + 1) : "./")).join(" ");
      case "notdir": return splitWords(X(argText)).map((w) => w.slice(w.lastIndexOf("/") + 1)).join(" ");
      case "suffix": return splitWords(X(argText)).map((w) => { const b = w.slice(w.lastIndexOf("/") + 1); const d = b.lastIndexOf("."); return d >= 0 ? b.slice(d) : ""; }).filter(Boolean).join(" ");
      case "basename": return splitWords(X(argText)).map((w) => { const s = w.lastIndexOf("/"); const d = w.lastIndexOf("."); return d > s ? w.slice(0, d) : w; }).join(" ");
      case "addsuffix": { const [s, t] = args(2).map(X); return splitWords(t).map((w) => w + s).join(" "); }
      case "addprefix": { const [p, t] = args(2).map(X); return splitWords(t).map((w) => p + w).join(" "); }
      case "join": { const [a, b] = args(2).map(X).map(splitWords); const n = Math.max(a.length, b.length); return Array.from({ length: n }, (_, i) => (a[i] ?? "") + (b[i] ?? "")).join(" "); }
      case "wildcard": return splitWords(X(argText)).flatMap((p) => this.wildcard(p)).join(" ");
      case "realpath": return splitWords(X(argText)).map((w) => { try { return fs.realpathSync(path.resolve(this.root, w)); } catch { return null; } }).filter(Boolean).join(" ");
      case "abspath": return splitWords(X(argText)).map((w) => path.resolve(this.root, w)).join(" ");
      case "if": { const [c, a, b = ""] = args(3); return X(c).trim() ? X(a) : X(b); }
      case "or": { for (const a of args()) { const v = X(a).trim(); if (v) return v; } return ""; }
      case "and": { let v = ""; for (const a of args()) { v = X(a).trim(); if (!v) return ""; } return v; }
      case "foreach": {
        const [v, list, text] = args(3);
        const name = X(v).trim();
        const saved = this.vars.get(name);
        const out = [];
        for (const w of splitWords(X(list))) {
          this.vars.set(name, { flavor: "simple", value: w, origin: "automatic" });
          out.push(X(text));
        }
        if (saved) this.vars.set(name, saved); else this.vars.delete(name);
        return out.join(" ");
      }
      case "call": {
        const parts = args();
        const name = X(parts[0]).trim();
        const params = parts.slice(1).map(X);
        const saved = new Map();
        const set = (k, v) => { saved.set(k, this.vars.get(k)); this.vars.set(k, { flavor: "simple", value: v, origin: "automatic" }); };
        set("0", name);
        params.forEach((p, i) => set(String(i + 1), p));
        for (let i = params.length + 1; i <= 9; i++) set(String(i), "");
        try {
          const v = this.vars.get(name);
          if (!v) return "";
          return v.flavor === "simple" ? v.value : this.expand(v.value, ctx, null, depth + 1);
        } finally {
          for (const [k, v] of saved) { if (v) this.vars.set(k, v); else this.vars.delete(k); }
        }
      }
      case "value": { const v = this.vars.get(X(argText).trim()); return v ? v.value : ""; }
      case "origin": { const v = this.vars.get(X(argText).trim()); return v ? v.origin : "undefined"; }
      case "flavor": { const v = this.vars.get(X(argText).trim()); return v ? v.flavor : "undefined"; }
      case "eval": this.evalText(X(argText), "<eval>"); return "";
      case "shell": return this.shell(X(argText));
      case "info": return "";
      case "warning": this.warnings.push(X(argText)); return "";
      case "error": throw new MakeError(`makefile $(error): ${X(argText)}`);
      default: throw new MakeError(`unsupported make function $(${fn} ...)`);
    }
  }

  wildcard(pattern) {
    const abs = path.resolve(this.root, pattern);
    if (!/[*?[]/.test(pattern)) return fs.existsSync(abs) ? [pattern] : [];
    const dirPart = pattern.includes("/") ? pattern.slice(0, pattern.lastIndexOf("/")) : ".";
    const base = pattern.slice(pattern.lastIndexOf("/") + 1);
    if (/[*?[]/.test(dirPart)) {
      // Expand the directory part first.
      return this.wildcard(dirPart).flatMap((d) => this.wildcard(`${d}/${base}`));
    }
    let ents;
    try { ents = fs.readdirSync(path.resolve(this.root, dirPart)); } catch { return []; }
    const re = globToRe(base);
    return ents.filter((e) => re.test(e) && (base.startsWith(".") || !e.startsWith("."))).sort().map((e) => (pattern.includes("/") ? `${dirPart}/${e}` : e));
  }

  /** $(shell ...) answered in JS. */
  shell(cmd) {
    const c = cmd.trim();
    const words = c.split(/\s+/);
    const found = (prog) => this.programAvailable(prog);
    let m;
    if ((m = /^(?:which|command -v)\s+(\S+)(\s+2>\s*\/dev\/null)?$/.exec(c))) return found(m[1]) ?? "";
    if ((m = /^type\s+(\S+)\s*>\s*\/dev\/null\s+2>\s*\/dev\/null\s*;\s*echo\s+\$\?$/.exec(c))) return found(m[1]) ? "0" : "1";
    if (c === "uname -s" || c === "uname") return os.type() === "Darwin" ? "Darwin" : os.type() === "Windows_NT" ? "Windows_NT" : "Linux";
    if (c === "uname -m" || c === "uname -p") return { x64: "x86_64", arm64: "aarch64", ia32: "i686" }[process.arch] ?? process.arch;
    if (c === "nproc" || c === "getconf _NPROCESSORS_ONLN") return String(os.cpus()?.length || 1);
    if (c === "getconf LONG_BIT") return "64";
    if ((m = /^mkdir\s+-p\s+(.*)$/.exec(c))) {
      for (const d of splitWords(m[1])) { try { fs.mkdirSync(path.resolve(this.root, d), { recursive: true }); } catch { /* ignore */ } }
      return "";
    }
    if (words[0] === "find") return this.shellFind(words.slice(1));
    if ((m = /^cat\s+(\S+)(\s+2>\s*\/dev\/null)?$/.exec(c))) { try { return fs.readFileSync(path.resolve(this.root, m[1]), "utf8").replace(/\n+$/, "").replace(/\n/g, " "); } catch { return ""; } }
    if ((m = /^echo\s+(.*)$/.exec(c))) return m[1].replace(/^["']|["']$/g, "");
    if ((m = /^(?:test|\[)\s+-([def])\s+(\S+)\s*\]?\s*&&\s*echo\s+(\S+)(?:\s*\|\|\s*echo\s+(\S+))?$/.exec(c))) {
      let ok = false;
      try { const st = fs.statSync(path.resolve(this.root, m[2])); ok = m[1] === "d" ? st.isDirectory() : m[1] === "f" ? st.isFile() : true; } catch { ok = false; }
      return ok ? m[3] : (m[4] ?? "");
    }
    this.shellUnanswered.push(c);
    return "";
  }

  programAvailable(prog) {
    if (EMULATED_PROGRAMS.includes(prog)) return `/romdev/wasm/${prog}`;
    if (prog.includes("/")) return fs.existsSync(path.resolve(this.root, prog)) ? prog : null;
    return null;
  }

  shellFind(args) {
    const roots = [];
    let i = 0;
    while (i < args.length && !args[i].startsWith("-") && args[i] !== "(" && args[i] !== "!") roots.push(args[i++]);
    const preds = []; // [{neg, type?, path?, name?}]
    let neg = false, execCat = false;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-not" || a === "!") { neg = true; continue; }
      // -exec cat {} ;  (print each match's contents)
      if (a === "-exec" && args[i + 1] === "cat" && args[i + 2] === "{}" && /^\\?;$/.test(args[i + 3] ?? "")) { execCat = true; i += 3; continue; }
      if (a === "-type") { preds.push({ neg, type: args[++i] }); neg = false; continue; }
      if (a === "-path") { preds.push({ neg, path: args[++i].replace(/^["']|["']$/g, "") }); neg = false; continue; }
      if (a === "-name") { preds.push({ neg, name: args[++i].replace(/^["']|["']$/g, "") }); neg = false; continue; }
      if (a === "-o" || a === "-a" || a === "(" || a === ")") { this.shellUnanswered.push("find " + args.join(" ")); return ""; }
      if (a.startsWith("2>")) continue;
      this.shellUnanswered.push("find " + args.join(" "));
      return "";
    }
    const out = [];
    const test = (rel, isDir) => preds.every((p) => {
      let r;
      if (p.type) r = p.type === "d" ? isDir : p.type === "f" ? !isDir : false;
      else if (p.path) r = findPathRe(p.path).test(rel); // -path: * crosses "/"
      else r = globToRe(p.name).test(path.posix.basename(rel));
      return p.neg ? !r : r;
    });
    const walk = (rel) => {
      let st;
      try { st = fs.lstatSync(path.resolve(this.root, rel)); } catch { return; }
      const isDir = st.isDirectory();
      if (test(rel, isDir)) out.push(rel);
      if (isDir) {
        let ents;
        try { ents = fs.readdirSync(path.resolve(this.root, rel)); } catch { return; }
        for (const e of ents) walk(rel === "." ? e : `${rel}/${e}`);
      }
    };
    for (const r of roots) walk(r.replace(/\/+$/, "") || "/");
    if (execCat) return out.map((f) => { try { return fs.readFileSync(path.resolve(this.root, f), "utf8"); } catch { return ""; } }).join("").replace(/\n+$/, "").replace(/\n/g, " ");
    return out.join(" ");
  }

  // -- rules -----------------------------------------------------------
  /** Target- and pattern-specific variables that apply to `target`, in make's precedence order. */
  targetVariables(target) {
    const out = new Map();
    const apply = (tv) => {
      const cur = out.get(tv.name);
      const base = cur ?? (this.vars.get(tv.name) ? { ...this.vars.get(tv.name) } : null);
      if (base?.origin === "command line" && !tv.override) return;
      if (tv.op === "=") out.set(tv.name, { flavor: "recursive", value: tv.value });
      else if (tv.op === ":=" || tv.op === "::=") out.set(tv.name, { flavor: "simple", value: this.expand(tv.value, { targetVars: out }) });
      else if (tv.op === "?=") { if (!base) out.set(tv.name, { flavor: "recursive", value: tv.value }); }
      else if (tv.op === "+=") {
        if (!base) out.set(tv.name, { flavor: "recursive", value: tv.value });
        else if (base.flavor === "simple") out.set(tv.name, { flavor: "simple", value: base.value + (base.value ? " " : "") + this.expand(tv.value, { targetVars: out }) });
        else out.set(tv.name, { flavor: "recursive", value: base.value + (base.value ? " " : "") + tv.value });
      }
    };
    // Pattern-specific first (longer stems = less specific, applied earlier), then exact.
    const pats = this.targetVars.map((tv, i) => ({ tv, i, stem: tv.pattern.includes("%") ? patMatch(tv.pattern, target) : null }))
      .filter((x) => x.stem !== null)
      .sort((a, b) => b.stem.length - a.stem.length || a.i - b.i);
    for (const { tv } of pats) apply(tv);
    for (const tv of this.targetVars) if (!tv.pattern.includes("%") && tv.pattern === target) apply(tv);
    return out;
  }

  /**
   * The rule make would use to build `target`: explicit rule with a recipe
   * first, else the first pattern rule whose prerequisites exist (or are
   * themselves buildable), else null.
   * @returns {{target, prereqs:string[], orderOnly:string[], recipe:string[], stem:string|null, rule, explicitPrereqs:string[]}|null}
   */
  findRule(target, { exists = (p) => fs.existsSync(path.resolve(this.root, p)), depth = 0 } = {}) {
    const explicit = this.rules.filter((r) => !r.pattern && r.targets.includes(target));
    const extraPrereqs = explicit.flatMap((r) => r.prereqs);
    const extraOrder = explicit.flatMap((r) => r.orderOnly);
    const withRecipe = explicit.filter((r) => r.recipe.length);
    if (withRecipe.length) {
      const r = withRecipe[withRecipe.length - 1];
      return { target, prereqs: dedupe(extraPrereqs), orderOnly: extraOrder, recipe: r.recipe, stem: r.staticStem ?? null, rule: r };
    }
    if (depth > 4) return null;
    // GNU make (3.82+) tries the matching pattern rules shortest stem first
    // (ties in makefile order), taking the first whose prerequisites exist or
    // can be made.
    const matches = [];
    this.rules.forEach((r, order) => {
      if (!r.pattern || !r.recipe.length) return;
      for (const tp of r.targets) {
        const stem = patMatch(tp, target);
        if (stem !== null) matches.push({ r, stem, order });
      }
    });
    matches.sort((a, b) => a.stem.length - b.stem.length || a.order - b.order);
    for (const { r, stem } of matches) {
      const prereqs = r.prereqs.map((p) => p.replace("%", stem));
      const ok = prereqs.every((p) => exists(p) || this.rules.some((rr) => !rr.pattern && rr.targets.includes(p)) || (this.findRule(p, { exists, depth: depth + 1 }) !== null));
      if (!ok) continue;
      return { target, prereqs: dedupe([...prereqs, ...extraPrereqs]), orderOnly: [...r.orderOnly.map((p) => p.replace("%", stem)), ...extraOrder], recipe: r.recipe, stem, rule: r };
    }
    if (explicit.length) return { target, prereqs: dedupe(extraPrereqs), orderOnly: extraOrder, recipe: [], stem: null, rule: explicit[0] };
    return null;
  }

  /**
   * Expanded recipe lines for `target` (each a shell command line, with its
   * @/-/+ prefixes removed and recorded).
   */
  recipeFor(target, found = this.findRule(target)) {
    if (!found) return null;
    const targetVars = this.targetVariables(target);
    const stem = found.stem ?? this.explicitStem(target);
    const auto = {
      "@": target, "<": found.prereqs[0] ?? "", "^": dedupe(found.prereqs).join(" "), "+": found.prereqs.join(" "),
      "*": stem, "?": found.prereqs.join(" "), "|": found.orderOnly.join(" "),
    };
    const ctx = { auto, targetVars };
    const lines = [];
    for (const raw of found.recipe) {
      const expanded = this.expand(raw, ctx);
      // A backslash-newline stays inside one shell command; a bare newline (a
      // define-d canned recipe) starts the next command.
      for (const l of expanded.split(/(?<!\\)\n/)) {
        let s = l.replace(/^[ \t]+/, ""), silent = false, ignoreErrors = false, always = false;
        for (;;) {
          if (s.startsWith("@")) { silent = true; s = s.slice(1).trimStart(); continue; }
          if (s.startsWith("-")) { ignoreErrors = true; s = s.slice(1).trimStart(); continue; }
          if (s.startsWith("+")) { always = true; s = s.slice(1).trimStart(); continue; }
          break;
        }
        if (!s.trim()) continue;
        lines.push({ command: s, silent, ignoreErrors, always });
      }
    }
    return { target, prereqs: found.prereqs, orderOnly: found.orderOnly, stem: found.stem, lines, targetVars: Object.fromEntries([...targetVars].map(([k, v]) => [k, v.flavor === "simple" ? v.value : this.expand(v.value, ctx)])) };
  }

  /**
   * $* in an explicit rule: the target minus a KNOWN suffix (make's
   * .SUFFIXES list), else empty. --no-builtin-rules (-r) and a bare
   * `.SUFFIXES:` empty that list, which is what decomp Makefiles do.
   */
  explicitStem(target) {
    const flags = " " + this.lookup("MAKEFLAGS", null) + " ";
    let suffixes = /\s(--no-builtin-rules|-r|-[a-zA-Z]*r[a-zA-Z]*)\s/.test(flags) ? [] : DEFAULT_SUFFIXES.slice();
    for (const r of this.rules) {
      if (!r.targets.includes(".SUFFIXES")) continue;
      suffixes = r.prereqs.length ? [...suffixes, ...r.prereqs] : [];
    }
    const s = suffixes.filter((x) => target.endsWith(x)).sort((x, y) => y.length - x.length)[0];
    return s ? target.slice(0, -s.length) : "";
  }

  /** Expanded value of a variable (optionally as seen by a target). */
  value(name, target = null) {
    if (!target) return this.lookup(name, null);
    return this.lookup(name, { targetVars: this.targetVariables(target), auto: {} });
  }
}

function dedupe(a) { return [...new Set(a)]; }

const DEFAULT_SUFFIXES = [".out", ".a", ".ln", ".o", ".c", ".cc", ".C", ".cpp", ".p", ".f", ".F", ".m", ".r", ".y", ".l", ".ym", ".yl", ".s", ".S", ".mod", ".sym", ".def", ".h", ".info", ".dvi", ".tex", ".texinfo", ".texi", ".txinfo", ".w", ".ch", ".web", ".sh", ".elc", ".el"];

const FUNCTIONS = new Set(["subst", "patsubst", "strip", "findstring", "filter", "filter-out", "sort", "word", "wordlist", "words",
  "firstword", "lastword", "dir", "notdir", "suffix", "basename", "addsuffix", "addprefix", "join", "wildcard", "realpath",
  "abspath", "if", "or", "and", "foreach", "call", "value", "origin", "flavor", "eval", "shell", "info", "warning", "error"]);

export { MakeError };

/** find -path glob: `*` and `?` also match "/". */
function findPathRe(g) {
  return new RegExp("^" + g.replace(/[.+^${}()|\\]/g, (c) => "\\" + c).replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}
