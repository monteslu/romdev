#!/usr/bin/env node
// Regenerate src/tables/{lextab,yacctab}.json from the upstream pycparser fork
// (m2c_pycparser / perm_pycparser, which are the same files under two names).
//
// The upstream parser runs PLY in optimize mode, which loads the committed
// lextab.py / yacctab.py WITHOUT checking them against the grammar. Those two
// files are therefore the authoritative definition of how upstream lexes and
// parses, so this port reads them as data instead of re-deriving LALR tables.
// Nothing here executes Python: the files are Python literals, and this script
// parses just enough of that literal syntax to read them.
//
// Usage: node scripts/gen-tables.mjs <lextab module> <yacctab module> <c_ast module>
//   (the three generated modules from perm_pycparser/ or m2c_pycparser/, given
//   as file paths; they are read as data, never run)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [lextabFile, yacctabFile, castFile] = process.argv.slice(2);
if (!castFile) {
  console.error("usage: node scripts/gen-tables.mjs <lextab module> <yacctab module> <c_ast module>");
  process.exit(2);
}

/** Parse a Python literal expression (str, int, None, bool, list, tuple, dict, set(...)). */
export function parsePyLiteral(text) {
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const expect = (c) => { ws(); if (text[i] !== c) throw new Error(`expected '${c}' at ${i}: ${text.slice(i, i + 40)}`); i++; };
  function str() {
    const q = text[i++];
    let out = "";
    while (text[i] !== q) {
      let c = text[i++];
      if (c === "\\") {
        const e = text[i++];
        if (e === "n") c = "\n";
        else if (e === "t") c = "\t";
        else if (e === "r") c = "\r";
        else if (e === "\\") c = "\\";
        else if (e === "'") c = "'";
        else if (e === "\"") c = "\"";
        else if (e === "x") { c = String.fromCharCode(parseInt(text.slice(i, i + 2), 16)); i += 2; }
        else if (e === "\n") c = "";
        else c = "\\" + e;
      }
      out += c;
    }
    i++;
    return out;
  }
  function seq(close) {
    const items = [];
    for (;;) {
      ws();
      if (text[i] === close) { i++; return items; }
      items.push(val());
      ws();
      if (text[i] === ",") { i++; continue; }
      ws();
      if (text[i] === close) { i++; return items; }
      throw new Error(`bad sequence at ${i}: ${text.slice(i, i + 40)}`);
    }
  }
  function val() {
    ws();
    const c = text[i];
    if (c === "'" || c === "\"") return str();
    if (c === "[") { i++; return seq("]"); }
    if (c === "(") { i++; return seq(")"); }
    if (c === "{") {
      i++;
      const obj = [];
      for (;;) {
        ws();
        if (text[i] === "}") { i++; return { dict: obj }; }
        const k = val();
        expect(":");
        const v = val();
        obj.push([k, v]);
        ws();
        if (text[i] === ",") i++;
      }
    }
    if (text.startsWith("None", i)) { i += 4; return null; }
    if (text.startsWith("True", i)) { i += 4; return true; }
    if (text.startsWith("False", i)) { i += 5; return false; }
    if (text.startsWith("set(", i)) { i += 4; const inner = val(); expect(")"); return inner; }
    const m = /^-?\d+/.exec(text.slice(i, i + 32));
    if (m) { i += m[0].length; return Number(m[0]); }
    throw new Error(`cannot parse literal at ${i}: ${text.slice(i, i + 40)}`);
  }
  const v = val();
  return v;
}

/** The value assigned to `name = <literal>` at top level of a Python module. */
function assignment(py, name) {
  const re = new RegExp(`^${name}\\s*=\\s*`, "m");
  const m = re.exec(py);
  if (!m) throw new Error(`no ${name}`);
  const start = m.index + m[0].length;
  // The literal ends where the next top-level statement begins; parse greedily.
  return parsePyLiteral(py.slice(start));
}

const lextab = readFileSync(lextabFile, "utf8");
const lex = {
  tabversion: assignment(lextab, "_tabversion"),
  tokens: assignment(lextab, "_lextokens"),
  reflags: assignment(lextab, "_lexreflags"),
  literals: assignment(lextab, "_lexliterals"),
  stateinfo: Object.fromEntries(assignment(lextab, "_lexstateinfo").dict),
  statere: Object.fromEntries(assignment(lextab, "_lexstatere").dict.map(([state, list]) =>
    [state, list.map(([pattern, names]) => ({ pattern, names }))])),
  stateignore: Object.fromEntries(assignment(lextab, "_lexstateignore").dict),
  stateerrorf: Object.fromEntries(assignment(lextab, "_lexstateerrorf").dict),
  stateeoff: Object.fromEntries(assignment(lextab, "_lexstateeoff").dict),
};

const yacctab = readFileSync(yacctabFile, "utf8");
const actionItems = assignment(yacctab, "_lr_action_items").dict;
const gotoItems = assignment(yacctab, "_lr_goto_items").dict;
const productions = assignment(yacctab, "_lr_productions");
// Rebuild _lr_action / _lr_goto exactly as the generated module does: states
// in first-seen order, and per state the symbols in item order.
const action = new Map();
for (const [tok, [states, acts]] of actionItems) {
  states.forEach((s, k) => {
    if (!action.has(s)) action.set(s, []);
    action.get(s).push([tok, acts[k]]);
  });
}
const gotos = new Map();
for (const [sym, [states, targets]] of gotoItems) {
  states.forEach((s, k) => {
    if (!gotos.has(s)) gotos.set(s, []);
    gotos.get(s).push([sym, targets[k]]);
  });
}
const yacc = {
  tabversion: assignment(yacctab, "_tabversion"),
  method: assignment(yacctab, "_lr_method"),
  signature: assignment(yacctab, "_lr_signature"),
  // [state, [[symbol, action]...]] - an array so state order survives JSON.
  action: [...action.entries()],
  goto: [...gotos.entries()],
  // [str, name, len, func, file, line]
  productions,
};

// c_ast.py is generated from _c_ast.cfg, and the generated file is what runs,
// so the node shapes come from it: constructor fields (__slots__ minus
// coord/__weakref__), children in children() order (single '*' or list '**'),
// and attr_names.
const castPy = readFileSync(castFile, "utf8");
const nodes = [];
for (const m of castPy.matchAll(/^class (\w+)\(Node\):\n([\s\S]*?)(?=^class |(?![\s\S]))/gm)) {
  const [, name, body] = m;
  const slots = /__slots__ = \(([^)]*)\)/.exec(body)[1].split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean)
    .filter((s) => s !== "coord" && s !== "__weakref__");
  const childrenBody = /def children\(self\):\n([\s\S]*?)return (?:tuple\(nodelist\)|\(\))/.exec(body)[1];
  const children = [];
  for (const line of childrenBody.split("\n")) {
    let c = /if self\.(\w+) is not None: nodelist\.append/.exec(line);
    if (c) { children.push([c[1], "single"]); continue; }
    c = /for i, child in enumerate\(self\.(\w+) or \[\]\)/.exec(line);
    if (c) children.push([c[1], "list"]);
  }
  const iterBody = /def __iter__\(self\):\n([\s\S]*?)attr_names/.exec(body)[1];
  const iter = [...iterBody.matchAll(/self\.(\w+)/g)].map((x) => x[1]).filter((v, k, a) => a.indexOf(v) === k);
  if (iter.join() !== children.map((c) => c[0]).join()) throw new Error(`${name}: __iter__ and children() disagree`);
  const attrs = /attr_names = \(([^)]*)\)/.exec(body)[1].split(",").map((s) => s.trim().replace(/'/g, "")).filter(Boolean);
  nodes.push({ name, fields: slots, children, attrs });
}

const out = path.join(here, "..", "src", "tables");
writeFileSync(path.join(out, "lextab.json"), JSON.stringify(lex) + "\n");
writeFileSync(path.join(out, "yacctab.json"), JSON.stringify(yacc) + "\n");
writeFileSync(path.join(out, "c_ast.json"), JSON.stringify(nodes, null, 1) + "\n");
console.log(`lextab: ${Object.keys(lex.statere).length} states; yacctab: ${action.size} states, ${productions.length} productions; c_ast: ${nodes.length} node classes`);
