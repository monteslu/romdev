// argparse.js - the workbench's command-line grammar, interpreted from a
// declarative spec so every command keeps its original options, defaults,
// error wording and help text.
//
// A command spec:
//   { path: ["trace-scheduler"] or ["experiment", "validate"],
//     help, description, epilog, prog?,
//     arguments: [ArgSpec...],
//     mutex: [{ required: bool, dests: [dest...] }],
//     defaults: { dest: value } (set_defaults, e.g. report_command),
//     handler(args, io, ctx) -> exit code }
// An ArgSpec mirrors add_argument:
//   positional: { dest, nargs?, type?, choices?, default?, help?, metavar? }
//   option:     { flags: ["--x", "-x"], dest?, action?, type?, nargs?, const?,
//                 default?, choices?, required?, help?, metavar? }
//   action: store | store_true | store_false | store_const | append |
//           append_const | count | extend | version | help | symbol |
//           explain_keys | list_file
//   type: "int" | "float" | "str" | function(text) -> value (throw
//         ArgumentTypeError(message) to reject)
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { strRepr, splitlines, strip } from "./py.js";

export class ArgumentTypeError extends Error {}

/** A parse failure; `prog` names the parser that raised it. */
export class ArgumentError extends Error {
  constructor(message, { prog = null, topLevel = false } = {}) { super(message); this.prog = prog; this.topLevel = topLevel; }
}

/** Raised to stop parsing with output (help, version, explain-keys). */
export class ParserExit extends Error {
  constructor(status, stdout = "") { super("exit"); this.status = status; this.stdout = stdout; }
}

export const SUPPRESS = Symbol("SUPPRESS");

export function destOf(a) {
  if (a.dest) return a.dest;
  if (!a.flags) throw new Error("positional without dest");
  const long = a.flags.find((f) => f.startsWith("--")) ?? a.flags[0];
  return long.replace(/^-+/, "").replace(/-/g, "_");
}

const isOption = (a) => Array.isArray(a.flags);
const NEG_NUMBER = /^-\d+$|^-\d*\.\d+$/;

function typeName(t) { return typeof t === "function" ? (t.displayName ?? t.name ?? "value") : t ?? "str"; }

function convert(a, text, label) {
  const t = a.type ?? "str";
  let v = text;
  try {
    if (t === "int") {
      if (!/^\s*[-+]?\d[\d_]*\s*$/.test(text)) throw new ArgumentError(`${label}: invalid int value: ${strRepr(text)}`);
      v = parseInt(text.replace(/_/g, ""), 10);
    } else if (t === "float") {
      const s = strip(text).toLowerCase();
      const n = /^[-+]?(inf|infinity)$/.test(s) ? (s.startsWith("-") ? -Infinity : Infinity) : /^[-+]?nan$/.test(s) ? NaN : Number(s.replace(/_/g, ""));
      if (s === "" || (Number.isNaN(n) && !/nan$/.test(s))) throw new ArgumentError(`${label}: invalid float value: ${strRepr(text)}`);
      v = n;
    } else if (typeof t === "function") {
      v = t(text);
    }
  } catch (e) {
    if (e instanceof ArgumentError) throw e;
    if (e instanceof ArgumentTypeError) throw new ArgumentError(`${label}: ${e.message}`);
    throw new ArgumentError(`${label}: invalid ${typeName(t)} value: ${strRepr(text)}`);
  }
  if (a.choices && !a.choices.includes(v)) {
    throw new ArgumentError(`${label}: invalid choice: ${strRepr(v)} (choose from ${a.choices.map((c) => (typeof c === "string" ? strRepr(c) : String(c))).join(", ")})`);
  }
  return v;
}

const optLabel = (a) => `argument ${a.flags.join("/")}`;
const posLabel = (a) => `argument ${a.metavar ?? a.dest}`;

function initialValue(a) {
  switch (a.action) {
    case "store_true": return a.default ?? false;
    case "store_false": return a.default ?? true;
    case "count": return a.default ?? null;
    case "help": case "version": case "explain_keys": return SUPPRESS;
    default: {
      const d = a.default;
      if (d === undefined) return null;
      return Array.isArray(d) ? [...d] : d;
    }
  }
}

/**
 * Parse `tokens` against a command spec.
 * @returns {Record<string, any>}
 */
export function parseArgs(spec, tokens, { prog, explainKeys = null, version = null } = {}) {
  const args = {};
  const options = spec.arguments.filter(isOption);
  const positionals = spec.arguments.filter((a) => !isOption(a));
  for (const a of spec.arguments) {
    const v = initialValue(a);
    const d = destOf(a);
    if (v !== SUPPRESS && !(d in args)) args[d] = v;
  }
  Object.assign(args, spec.defaults ?? {});
  const byFlag = new Map();
  for (const o of options) for (const f of o.flags) byFlag.set(f, o);
  const seen = new Set();
  const find = (flag) => {
    if (byFlag.has(flag)) return [flag, byFlag.get(flag)];
    if (!flag.startsWith("--")) return null;
    const hits = [...byFlag.keys()].filter((f) => f.startsWith(flag));
    const owners = new Set(hits.map((f) => byFlag.get(f)));
    if (owners.size === 1) return [hits[0], byFlag.get(hits[0])];
    if (owners.size > 1) throw new ArgumentError(`ambiguous option: ${flag} could match ${hits.join(", ")}`, { prog });
    return null;
  };
  const looksLikeOption = (t) => t.startsWith("-") && t !== "-" && !NEG_NUMBER.test(t) && t !== "--";
  const posTokens = [];
  const extras = [];
  let onlyPos = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (onlyPos) { posTokens.push(tok); continue; }
    if (tok === "--") { onlyPos = true; continue; }
    if (!looksLikeOption(tok)) { posTokens.push(tok); continue; }
    let flagText = tok, inline = null;
    if (tok.startsWith("--") && tok.includes("=")) { flagText = tok.slice(0, tok.indexOf("=")); inline = tok.slice(tok.indexOf("=") + 1); }
    else if (!tok.startsWith("--") && tok.length > 2 && byFlag.has(tok.slice(0, 2))) { flagText = tok.slice(0, 2); inline = tok.slice(2); }
    const found = find(flagText);
    if (!found) { extras.push(tok); continue; }
    const [flag, a] = found;
    const d = destOf(a);
    const label = optLabel(a);
    seen.add(a);
    const action = a.action ?? "store";
    const noValue = ["store_true", "store_false", "store_const", "append_const", "count", "help", "version", "explain_keys"].includes(action);
    if (noValue) {
      if (inline !== null) throw new ArgumentError(`${label}: ignored explicit argument ${strRepr(inline)}`, { prog });
      if (action === "store_true") args[d] = true;
      else if (action === "store_false") args[d] = false;
      else if (action === "store_const") args[d] = a.const;
      else if (action === "append_const") args[d] = [...(args[d] ?? []), a.const];
      else if (action === "count") args[d] = (args[d] ?? 0) + 1;
      else if (action === "help") throw new ParserExit(0, formatHelp(spec, { prog }));
      else if (action === "version") throw new ParserExit(0, `${version ?? ""}\n`);
      else if (action === "explain_keys") throw new ParserExit(0, `${explainKeys ? explainKeys() : ""}\n`);
      continue;
    }
    // Values: nargs None/"?"/"*"/"+"/N
    const nargs = a.nargs;
    let values = [];
    if (inline !== null) values = [inline];
    else {
      const take = [];
      let j = i + 1;
      const max = nargs === undefined || nargs === null ? 1 : nargs === "?" ? 1 : typeof nargs === "number" ? nargs : Infinity;
      while (j < tokens.length && take.length < max && !looksLikeOption(tokens[j]) && tokens[j] !== "--") { take.push(tokens[j]); j++; }
      values = take; i = j - 1;
    }
    if ((nargs === undefined || nargs === null) && values.length !== 1) throw new ArgumentError(`${label}: expected one argument`, { prog });
    if (nargs === "+" && values.length < 1) throw new ArgumentError(`${label}: expected at least one argument`, { prog });
    if (typeof nargs === "number" && values.length !== nargs) throw new ArgumentError(`${label}: expected ${nargs} argument${nargs === 1 ? "" : "s"}`, { prog });
    const conv = values.map((v) => convert(a, v, label));
    let value;
    if (nargs === undefined || nargs === null) value = conv[0];
    else if (nargs === "?") value = conv.length ? conv[0] : a.const ?? null;
    else value = conv;
    if (action === "append") args[d] = [...(args[d] ?? []), value];
    else if (action === "extend") args[d] = [...(args[d] ?? []), ...value];
    else if (action === "symbol") {
      const previous = args[d];
      if (previous !== null && previous !== undefined && previous !== value) {
        throw new ArgumentError(`${label}: conflicts with ${args.__symbol_option ?? "--symbol"} ${strRepr(previous)}; --symbol and --function are two spellings of one selector`, { prog });
      }
      args.__symbol_option = flag;
      args[d] = value;
    } else if (action === "list_file") {
      const p = String(value);
      let text;
      try { text = readFileSync(p === "-" ? 0 : p, "utf8"); } catch (e) { throw new ArgumentError(`${label}: cannot read ${p}: ${e.message}`, { prog }); }
      const items = splitlines(text).map((l) => strip(l)).filter((l) => l && !l.startsWith("#"));
      if (!items.length) throw new ArgumentError(`${label}: ${p} holds no values (blank lines and # comments are ignored)`, { prog });
      const itemConv = items.map((x) => (a.itemType ? convert({ type: a.itemType }, x, label) : x));
      args[d] = [...(args[d] ?? []), ...itemConv];
    } else args[d] = value;
  }
  // Positionals: allocate tokens left to right; greedy nargs leave enough
  // for the required ones after them.
  const minFor = (a) => (a.nargs === "?" || a.nargs === "*" ? 0 : a.nargs === "+" ? 1 : typeof a.nargs === "number" ? a.nargs : 1);
  let k = 0;
  const missing = [];
  positionals.forEach((a, idx) => {
    const rest = positionals.slice(idx + 1).reduce((s, b) => s + minFor(b), 0);
    const avail = posTokens.length - k - rest;
    const d = destOf(a), label = posLabel(a);
    const nargs = a.nargs;
    if (nargs === undefined || nargs === null) {
      if (avail < 1) { missing.push(a.metavar ?? a.dest); return; }
      args[d] = convert(a, posTokens[k++], label);
    } else if (nargs === "?") {
      if (avail >= 1) args[d] = convert(a, posTokens[k++], label);
      else args[d] = a.default ?? null;
    } else if (nargs === "*" || nargs === "+") {
      const n = Math.max(0, avail);
      if (nargs === "+" && n < 1) { missing.push(a.metavar ?? a.dest); return; }
      const vals = posTokens.slice(k, k + n).map((t) => convert(a, t, label));
      k += n;
      args[d] = nargs === "*" && !vals.length ? (a.default ?? []) : vals;
    } else {
      if (avail < nargs) { missing.push(a.metavar ?? a.dest); return; }
      args[d] = posTokens.slice(k, k + nargs).map((t) => convert(a, t, label));
      k += nargs;
    }
  });
  const requiredOpts = options.filter((o) => o.required && !seen.has(o));
  if (missing.length || requiredOpts.length) {
    throw new ArgumentError(`the following arguments are required: ${[...missing, ...requiredOpts.map((o) => o.flags.join("/"))].join(", ")}`, { prog });
  }
  for (const group of spec.mutex ?? []) {
    const used = options.filter((o) => group.dests.includes(destOf(o)) && seen.has(o));
    if (used.length > 1) throw new ArgumentError(`argument ${used[1].flags.join("/")}: not allowed with argument ${used[0].flags.join("/")}`, { prog });
    if (group.required && !used.length) {
      const names = options.filter((o) => group.dests.includes(destOf(o))).map((o) => o.flags.join("/"));
      throw new ArgumentError(`one of the arguments ${names.join(" ")} is required`, { prog });
    }
  }
  extras.push(...posTokens.slice(k));
  if (extras.length) throw new ArgumentError(`unrecognized arguments: ${extras.join(" ")}`, { prog, topLevel: true });
  delete args.__symbol_option;
  return args;
}

function metavarOf(a) {
  if (a.metavar) return a.metavar;
  if (!isOption(a)) return a.dest;
  if (a.choices) return `{${a.choices.join(",")}}`;
  return destOf(a).toUpperCase();
}

function argUsage(a) {
  const mv = metavarOf(a);
  const vals = a.nargs === "?" ? `[${mv}]` : a.nargs === "*" ? `[${mv} ...]` : a.nargs === "+" ? `${mv} [${mv} ...]` : typeof a.nargs === "number" ? Array(a.nargs).fill(mv).join(" ") : mv;
  if (!isOption(a)) return vals;
  const noValue = ["store_true", "store_false", "store_const", "append_const", "count", "help", "version", "explain_keys"].includes(a.action);
  const f = a.flags[0];
  return noValue ? f : `${f} ${vals}`;
}

/** The usage line. */
export function formatUsage(spec, { prog }) {
  const parts = ["[-h]"];
  for (const a of spec.arguments.filter(isOption)) parts.push(a.required ? argUsage(a) : `[${argUsage(a)}]`);
  for (const a of spec.arguments.filter((x) => !isOption(x))) parts.push(argUsage(a));
  return `usage: ${prog} ${parts.join(" ")}\n`;
}

function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width - indent) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** argparse-style help: usage, description, positionals, options, epilog. */
export function formatHelp(spec, { prog }) {
  const width = 78;
  let out = formatUsage(spec, { prog });
  if (spec.description) out += "\n" + wrap(spec.description, width, 0).join("\n") + "\n";
  const section = (title, list) => {
    if (!list.length) return;
    out += `\n${title}:\n`;
    for (const [head, help] of list) {
      const helpText = help ? String(help).replace(/%\(default\)s/g, "") : "";
      if (head.length <= 22 && helpText) {
        const lines = wrap(helpText, width, 24);
        out += `  ${head.padEnd(22)}${lines[0] ?? ""}\n` + lines.slice(1).map((l) => " ".repeat(24) + l + "\n").join("");
      } else {
        out += `  ${head}\n`;
        if (helpText) out += wrap(helpText, width, 24).map((l) => " ".repeat(24) + l + "\n").join("");
      }
    }
  };
  section("positional arguments", spec.arguments.filter((a) => !isOption(a)).map((a) => [metavarOf(a), a.help]));
  const opts = [["-h, --help", "show this help message and exit"]];
  for (const a of spec.arguments.filter(isOption)) {
    const noValue = ["store_true", "store_false", "store_const", "append_const", "count", "help", "version", "explain_keys"].includes(a.action);
    opts.push([a.flags.map((f) => (noValue ? f : `${f} ${metavarOf(a)}`)).join(", "), a.help]);
  }
  section("options", opts);
  if (spec.epilog) out += "\n" + String(spec.epilog) + "\n";
  return out;
}
