// csource.js - reading decompiled C as text, with the block structure made
// explicit. The workbench does not parse C: it reads the dialect projects
// write (one statement per line, braces on their own lines) and says so.
// Probes get where each statement sits in the block structure (a definition
// in a closed `if` does not reach a later statement) and which statements
// are inside a loop body.
//
// Plain JS ESM + JSDoc.

import { ValueError, splitlines, reEscape, counter, splitWs, strip } from "./py.js";

export class CSourceError extends ValueError { constructor(message) { super(message); this.name = "ValueError"; } }

/** Identifiers that are not struct/union member selections. */
export const IDENTIFIER_RE = /(?<![\w.])(?<!->)[A-Za-z_]\w*/g;

export const KEYWORDS = new Set(splitWs(`auto break case char const continue default do double else enum extern
  float for goto if inline int long register restrict return short signed
  sizeof static struct switch typedef union unsigned void volatile while
  NULL`));

const ASSIGN_TEMPLATE = (q) => `(?<![\\w.>])${q}\\s*(?:\\[[^\\];]*\\])?\\s*(?:=(?!=)|[-+*/%&|^]=|<<=|>>=)`;
const MAY_DEFINE_TEMPLATE = (q) => `(?:&\\s*${q}\\b|\\+\\+\\s*${q}\\b|${q}\\s*\\+\\+|--\\s*${q}\\b|${q}\\s*--)`;
const DECLARE_TEMPLATE = (q) => `^\\s*(?:[A-Za-z_]\\w*\\s*[\\w*\\s]*?)\\b${q}\\s*(?:\\[[^\\]]*\\])?\\s*(?:[;,=](?!=))`;
const ADDRESS_TEMPLATE = (q) => `&\\s*${q}\\b`;
export { ASSIGN_TEMPLATE, MAY_DEFINE_TEMPLATE, DECLARE_TEMPLATE, ADDRESS_TEMPLATE };

const LOOP_RE = /(?<![\w.])(for|while|do)(?![\w.])/;
const SWITCH_RE = /(?<![\w.])switch(?![\w.])/;
const CONTROL_BREAK_RE = /^(case\b|default\s*:|goto\b|break\b|continue\b)/;

/** The file's lines with comments and string bodies blanked (line numbers kept). */
export function stripNoncode(text) {
  const result = [];
  let inBlock = false;
  for (const line of splitlines(text)) {
    const out = [];
    let index = 0;
    const length = line.length;
    while (index < length) {
      const ch = line[index];
      if (inBlock) {
        if (line.startsWith("*/", index)) { inBlock = false; out.push("  "); index += 2; continue; }
        out.push(" "); index += 1; continue;
      }
      if (line.startsWith("/*", index)) { inBlock = true; out.push("  "); index += 2; continue; }
      if (line.startsWith("//", index)) { out.push(" ".repeat(length - index)); break; }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        out.push(ch); index += 1;
        while (index < length) {
          if (line[index] === "\\" && index + 1 < length) { out.push("  "); index += 2; continue; }
          if (line[index] === quote) { out.push(quote); index += 1; break; }
          out.push(" "); index += 1;
        }
        continue;
      }
      out.push(ch); index += 1;
    }
    result.push(out.join(""));
  }
  return result;
}

/** Count the identifiers on one line, ignoring keywords and members. */
export function identifiers(line) {
  return counter([...line.matchAll(IDENTIFIER_RE)].map((m) => m[0]).filter((n) => !KEYWORDS.has(n) && !/^\d+$/.test(n)));
}

/** Whether `line` writes `name`, as far as the text can say. */
export function defines(line, name) {
  const q = reEscape(name);
  if (new RegExp(ASSIGN_TEMPLATE(q)).test(line)) return true;
  if (new RegExp(MAY_DEFINE_TEMPLATE(q)).test(line)) return true;
  return new RegExp(DECLARE_TEMPLATE(q)).test(line);
}

export function declaresWithoutInitializer(line, name) {
  const q = reEscape(name);
  if (!new RegExp(DECLARE_TEMPLATE(q)).test(line)) return false;
  return !new RegExp(ASSIGN_TEMPLATE(q)).test(line);
}

/** Where `name` is declared, or null. */
export function declarationLine(lines, name) {
  const re = new RegExp(DECLARE_TEMPLATE(reEscape(name)));
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return null;
}

/** Every line that writes `name`, excluding a bare declaration. */
export function definitionLines(lines, name) {
  const out = [];
  lines.forEach((line, i) => { if (!declaresWithoutInitializer(line, name) && defines(line, name)) out.push(i + 1); });
  return out;
}

/** Whether `line` mentions `name` as a value rather than declaring it. */
export function reads(line, name) {
  if (!identifiers(line).has(name)) return false;
  return !declaresWithoutInitializer(line, name);
}

/** Every line that takes `name`'s address. */
export function takesAddress(lines, name) {
  const re = new RegExp(ADDRESS_TEMPLATE(reEscape(name)));
  const out = [];
  lines.forEach((line, i) => { if (re.test(line)) out.push(i + 1); });
  return out;
}

const DECLARATION_RE = new RegExp("^(?<indent>\\s*)"
  + "(?<type>(?:(?:const|static|volatile|register|unsigned|signed|struct|union|enum|long|short)\\s+)*[A-Za-z_]\\w*(?:\\s+(?:long|int|char|double))*(?:\\s*\\*)*)"
  + "\\s+(?<declarators>[^;]+);\\s*$");
const NOT_A_TYPE = new Set(splitWs("break case continue default do else for goto if return sizeof switch while"));
const DECLARATOR_RE = /^\s*(?<stars>\**)\s*(?<name>[A-Za-z_]\w*)\s*(?<array>(?:\[[^\]]*\])*)\s*(?:=\s*(?<initializer>.+))?$/;

/** One declared local: where, what type, and in what (load-bearing) order. */
export class Declaration {
  constructor({ line, index, type_text, name, array = "", initializer = null }) {
    Object.assign(this, { line, index, type_text, name, array, initializer }); Object.freeze(this);
  }
  get initialized() { return this.initializer !== null; }
  get is_array() { return !!this.array; }
  asDict() { return { line: this.line, index: this.index, type: this.type_text, name: this.name, array: this.array, initializer: this.initializer }; }
}

function splitDeclarators(text) {
  const parts = [];
  let depth = 0, current = "";
  for (const ch of text) {
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.filter((p) => p.trim());
}

/** Every local declaration, in declaration order. */
export function declarations(lines) {
  const found = [];
  lines.forEach((line, i) => {
    const m = DECLARATION_RE.exec(line);
    if (!m) return;
    const typeText = splitWs(m.groups.type).join(" ");
    const words = splitWs(typeText);
    const first = words.length ? words[0] : "";
    if (NOT_A_TYPE.has(first) || first === "typedef" || first === "extern") return;
    const decls = m.groups.declarators;
    if (decls.includes("(") || decls.includes("?")) return;
    for (const part of splitDeclarators(decls)) {
      const p = DECLARATOR_RE.exec(part);
      if (!p) continue;
      found.push(new Declaration({ line: i + 1, index: found.length, type_text: strip(`${typeText} ${p.groups.stars}`), name: p.groups.name,
        array: p.groups.array || "", initializer: p.groups.initializer ? strip(p.groups.initializer) : null }));
    }
  });
  return found;
}

/** One statement position, with the block path that reaches it. */
export class Statement {
  constructor({ line, text, depth, path, loops, control_break }) { Object.assign(this, { line, text, depth, path, loops, control_break }); Object.freeze(this); }
  get in_loop() { return this.loops.length > 0; }
  /** Whether `other`'s block is still open here (structural dominance). */
  reachedFrom(other) {
    return other.line < this.line && other.path.every((v, i) => this.path[i] === v) && this.path.length >= other.path.length;
  }
}

/** One Statement per code line, with its block and loop path. */
export function scanStatements(lines) {
  const statements = [];
  const blockStack = [];
  const loopStack = [];
  let nextBlock = 0, pendingLoop = false, pendingSwitch = false, depth = 0;
  lines.forEach((raw, i) => {
    const line = strip(raw);
    const opens = raw.split("{").length - 1;
    const closes = raw.split("}").length - 1;
    const body = LOOP_RE.exec(raw);
    if (body && !(body[1] === "while" && closes && !opens)) pendingLoop = true;
    if (SWITCH_RE.test(raw)) pendingSwitch = true;
    if (line) {
      statements.push(new Statement({ line: i + 1, text: line, depth, path: [...blockStack], loops: loopStack.map((l) => l[0]), control_break: CONTROL_BREAK_RE.test(line) }));
    }
    for (const ch of raw) {
      if (ch === "{") {
        nextBlock += 1; blockStack.push(nextBlock); depth += 1;
        if (pendingLoop && !pendingSwitch) loopStack.push([nextBlock, depth]);
        pendingLoop = false; pendingSwitch = false;
      } else if (ch === "}") {
        if (loopStack.length && blockStack.length && loopStack.at(-1)[0] === blockStack.at(-1)) loopStack.pop();
        if (blockStack.length) blockStack.pop();
        depth = Math.max(0, depth - 1);
      }
    }
    if (!opens && (line.endsWith(";") || line.endsWith("}"))) { pendingLoop = false; pendingSwitch = false; }
  });
  return statements;
}
