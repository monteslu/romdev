// Help-text oracle (a development tool; nothing in romdev runs it).
//
// Executes the upstream workbench's build_parser() - its source read as text
// and run by the small interpreter in this directory, never by an external
// interpreter - against a recording argument parser, and writes every
// parser's format_help() at width 78 (the width a non-terminal stdout gets):
//
//   node scripts/workbench-help-oracle/golden.mjs golden.json meta.json
//   node scripts/workbench-help-oracle/compare.mjs golden.json diff.json
//
// test/fixtures/workbench/help-golden.json is this output, with the
// documented deviations (test/workbench-help.test.js) taken from romdev.
import path from "node:path";
import fs from "node:fs";
import nodeos from "node:os";
const await_os = () => nodeos;
import { Builtin, Klass, Instance, Tuple, Dict, Opaque, OPAQUE, call, getattr, iterate, pyStr, registerNative, setPackage, importModule, Module, PyFloatV } from "./interp.mjs";
import { formatParserHelp } from "../../src/decomp/workbench/help-format.js";

const SUPPRESS = "==SUPPRESS==";
// The workbench package source: WORKBENCH_SRC, or the conventional checkout.
const PKG = process.env.WORKBENCH_SRC ?? path.join(nodeos.homedir(), "code", "cliemu", "n64-decomp-reference", "n64-decomp-workbench", "src", "decomp_workbench");
const kwv = (k, n, d = null) => (k.has(n) ? k.get(n) : d);
const toJs = (v) => (v instanceof Tuple ? v.items.map(toJs) : Array.isArray(v) ? v.map(toJs) : v instanceof PyFloatV ? v.v : v);

// -- recording argparse -------------------------------------------------------------
const ALL_PARSERS = [];
const ACTION_CLASS = new Klass("Action", [], new Map(), null);
ACTION_CLASS.ns.set("__init__", new Builtin("Action.__init__", ([self], k) => {
  const fields = { option_strings: toJs(kwv(k, "option_strings", [])), dest: kwv(k, "dest"), nargs: toJs(kwv(k, "nargs")), const: kwv(k, "const"), default: kwv(k, "default"),
    type: kwv(k, "type"), choices: kwv(k, "choices"), required: kwv(k, "required", false), help: kwv(k, "help"), metavar: toJs(kwv(k, "metavar")) };
  for (const [n, v] of Object.entries(fields)) self.attrs.set(n, v);
  return null;
}));
const ACTION_NARGS0 = new Set(["store_true", "store_false", "store_const", "append_const", "count", "help", "version"]);

function makeGroup(parser, title, description) { return { parser, title, description, actions: [] }; }

class ParserRec {
  constructor(k) {
    this.prog = kwv(k, "prog");
    this.usage = kwv(k, "usage");
    this.description = kwv(k, "description");
    this.epilog = kwv(k, "epilog");
    const fc = kwv(k, "formatter_class");
    this.formatter = fc === FORMATTERS.RawDescriptionHelpFormatter ? "raw_description" : fc === FORMATTERS.RawTextHelpFormatter ? "raw_text" : fc === FORMATTERS.ArgumentDefaultsHelpFormatter ? "defaults" : null;
    this.actions = []; this.mutex = [];
    this.positionals = makeGroup(this, "positional arguments", null);
    this.optionals = makeGroup(this, "options", null);
    this.groups = [this.positionals, this.optionals];
    this.children = [];
    if (kwv(k, "add_help", true)) this.addAction({ option_strings: ["-h", "--help"], dest: SUPPRESS, nargs: 0, const: null, default: SUPPRESS, type: null, choices: null, required: false, help: "show this help message and exit", metavar: null }, null);
    ALL_PARSERS.push(this);
  }
  addAction(act, container) {
    this.actions.push(act);
    const g = container && container !== this ? container : act.option_strings.length ? this.optionals : this.positionals;
    g.actions.push(act);
    return act;
  }
}

function addArgument(parser, container, mutexGroup, args, k) {
  const flags = args.map(toJs);
  const isOpt = flags.length && flags[0].startsWith("-");
  let dest = kwv(k, "dest");
  if (!dest) {
    if (!isOpt) dest = flags[0];
    else { const long = flags.find((f) => f.startsWith("--")) ?? flags[0]; dest = long.replace(/^-+/, "").replace(/-/g, "_"); }
  }
  const action = kwv(k, "action", "store");
  let rec;
  if (action === BOOL_OPT) {
    const opts = flags.flatMap((f) => (f.startsWith("--") ? [f, "--no-" + f.slice(2)] : [f]));
    rec = { option_strings: opts, dest, nargs: 0, const: null, default: toJs(kwv(k, "default")), type: null, choices: null, required: !!kwv(k, "required", false), help: kwv(k, "help"), metavar: null, usage_text: opts.join(" | ") };
  } else if (action instanceof Klass) {
    const kk = new Map(k); kk.delete("action");
    if (!kk.has("dest")) kk.set("dest", dest);
    kk.set("option_strings", isOpt ? flags : []);
    const inst = call(action, [], kk);
    const g = (n) => (inst.attrs.has(n) ? inst.attrs.get(n) : null);
    rec = { option_strings: toJs(g("option_strings")) ?? [], dest: g("dest"), nargs: toJs(g("nargs")), const: g("const"), default: g("default"), type: g("type"), choices: g("choices"), required: !!g("required"), help: g("help"), metavar: toJs(g("metavar")) };
  } else {
    const nargs = ACTION_NARGS0.has(action) ? 0 : toJs(kwv(k, "nargs"));
    let def = kwv(k, "default", action === "store_true" ? false : action === "store_false" ? true : action === "help" || action === "version" ? SUPPRESS : null);
    rec = { option_strings: isOpt ? flags : [], dest, nargs, const: kwv(k, "const"), default: def, type: kwv(k, "type"), choices: kwv(k, "choices"),
      required: isOpt ? !!kwv(k, "required", false) : !(nargs === "?" || nargs === "*"), help: kwv(k, "help") ?? (action === "version" ? "show program's version number and exit" : null), metavar: toJs(kwv(k, "metavar")) };
    if (action === "help" || action === "version") rec.dest = SUPPRESS;
  }
  if (rec.choices !== null && rec.choices !== undefined) rec.choices = iterate(rec.choices).map(toJs);
  if (typeof rec.type !== "string" && rec.type) rec.type = null;
  if (rec.default instanceof Opaque) rec.default = `<opaque>`;
  else rec.default = toJs(rec.default);
  const act = parser.addAction(rec, container);
  if (mutexGroup) mutexGroup.actions.push(act);
  return act;
}

function containerObj(parser, group, mutex) {
  const self = {
    __attrs(n) {
      switch (n) {
        case "add_argument": return new Builtin("add_argument", (a, k) => wrapAction(addArgument(parser, group ?? parser, mutex, a, k)));
        case "add_argument_group": return new Builtin("add_argument_group", (a, k) => { const g = makeGroup(parser, kwv(k, "title", a[0] ?? null), kwv(k, "description", a[1] ?? null)); parser.groups.push(g); return containerObj(parser, g, null); });
        case "add_mutually_exclusive_group": return new Builtin("add_mutually_exclusive_group", (a, k) => { const m = { required: !!kwv(k, "required", false), actions: [] }; parser.mutex.push(m); return containerObj(parser, group, m); });
        case "set_defaults": return new Builtin("set_defaults", () => null);
        case "add_subparsers": return new Builtin("add_subparsers", (a, k) => addSubparsers(parser, k));
        case "prog": return parser.prog;
        case "description": return parser.description;
        case "epilog": return parser.epilog;
        case "print_help": case "print_usage": case "error": case "exit": case "parse_args": case "parse_known_args": case "format_help": case "format_usage": return new Builtin(n, () => OPAQUE(n));
        case "_actions": return parser.actions.map(wrapAction);
      }
      return OPAQUE(`parser.${n}`);
    },
    __setattr() {},
  };
  self.rec = parser;
  return self;
}
const wrapAction = (act) => ({ __attrs: (n) => (n in act ? act[n] : OPAQUE(`action.${n}`)), __setattr: (n, v) => { act[n] = toJs(v); }, act });

function addSubparsers(parser, k) {
  const prog = kwv(k, "prog") ?? parser.prog;
  const sub = { option_strings: [], dest: kwv(k, "dest") ?? SUPPRESS, nargs: "A...", const: null, default: null, type: null, choices: [],
    required: !!kwv(k, "required", false), help: kwv(k, "help"), metavar: kwv(k, "metavar"), subactionsW: [] };
  Object.defineProperty(sub, "subactions", { get() { return sub.subactionsW.map((w) => w.act); }, enumerable: false });
  const title = kwv(k, "title"), description = kwv(k, "description");
  if (title || description) { const g = makeGroup(parser, title ?? "subcommands", description); parser.groups.push(g); parser.addAction(sub, g); }
  else parser.addAction(sub, null);
  return {
    __attrs(n) {
      if (n === "add_parser") return new Builtin("add_parser", (a, kk) => {
        const name = a[0];
        const k2 = new Map(kk);
        const help = k2.has("help") ? k2.get("help") : undefined; k2.delete("help"); k2.delete("aliases");
        if (!k2.has("prog")) k2.set("prog", `${prog} ${name}`);
        const child = new ParserRec(k2);
        sub.choices.push(name);
        if (help !== undefined) sub.subactionsW.push(wrapAction({ option_strings: [], dest: name, nargs: null, const: null, default: null, type: null, choices: null, required: true, help, metavar: name }));
        parser.children.push(child);
        return containerObj(child, null, null);
      });
      if (n === "_choices_actions") return sub.subactionsW;
      if (n === "choices") return new Dict();
      return OPAQUE(`subparsers.${n}`);
    },
    __setattr(n, v) { if (n === "metavar") sub.metavar = toJs(v); },
    sub,
  };
}

const FORMATTERS = { RawDescriptionHelpFormatter: new Klass("RawDescriptionHelpFormatter", [], new Map(), null), RawTextHelpFormatter: new Klass("RawTextHelpFormatter", [], new Map(), null),
  ArgumentDefaultsHelpFormatter: new Klass("ArgumentDefaultsHelpFormatter", [], new Map(), null), HelpFormatter: new Klass("HelpFormatter", [], new Map(), null) };

const BOOL_OPT = new Klass("BooleanOptionalAction", [], new Map(), null);
const PARSER_CLASS = new Klass("ArgumentParser", [], new Map(), null);
PARSER_CLASS.native = { construct: (a, k) => containerObj(new ParserRec(k), null, null) };

const argparseMod = new Module("argparse");
for (const [n, v] of Object.entries({ ArgumentParser: PARSER_CLASS, Action: ACTION_CLASS, SUPPRESS, OPTIONAL: "?", ZERO_OR_MORE: "*", ONE_OR_MORE: "+", REMAINDER: "...", PARSER: "A...",
  ArgumentTypeError: new Klass("ArgumentTypeError", [], new Map(), null), ArgumentError: new Klass("ArgumentError", [], new Map(), null), Namespace: new Klass("Namespace", [], new Map(), null),
  _SubParsersAction: new Klass("_SubParsersAction", [], new Map(), null), BooleanOptionalAction: BOOL_OPT, ...FORMATTERS })) argparseMod.globals.set(n, v);
registerNative("argparse", argparseMod);
const osMod = new Module("os");
osMod.globals.set("cpu_count", new Builtin("cpu_count", () => (await_os()).cpus().length));
osMod.globals.set("name", "posix"); osMod.globals.set("sep", "/");
osMod.lazy = (n) => OPAQUE("os." + n);
registerNative("os", osMod);
const sysMod = new Module("sys"); sysMod.globals.set("platform", "linux"); sysMod.lazy = (n) => OPAQUE("sys." + n); registerNative("sys", sysMod);

setPackage(PKG, "decomp_workbench");
const cli = importModule("decomp_workbench.cli");
const buildParser = getattr(cli, "build_parser");
let top;
try { top = call(buildParser, []); } catch (e) { console.log("FAILED:", e.message, (e.pyStack ?? []).join(" <- ")); process.exit(1); }

// -- print -------------------------------------------------------------------------------
const out = {};
const errors = [];
for (const p of ALL_PARSERS) {
  const model = { prog: p.prog, usage: p.usage, description: p.description, epilog: p.epilog, formatter: p.formatter, actions: p.actions, mutex: p.mutex,
    groups: p.groups.map((g) => ({ title: g.title, description: g.description, actions: g.actions })) };
  try { out[p.prog] = formatParserHelp(model, { width: 78 }); } catch (e) { errors.push(`${p.prog}: ${e.message}`); }
}
const file = process.argv[2];
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`parsers ${ALL_PARSERS.length}, formatted ${Object.keys(out).length}, errors ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log(" ", e);
const meta = {};
for (const p of ALL_PARSERS) {
  const sub = p.actions.find((a) => a.nargs === "A...");
  if (!sub) continue;
  meta[p.prog] = { dest: sub.dest, required: sub.required, metavar: sub.metavar, help: sub.help, choices: sub.choices, listed: sub.subactions.map((s) => s.dest),
    title: p.groups.find((g) => g.actions.includes(sub))?.title };
}
fs.writeFileSync(process.argv[3] ?? "meta.json", JSON.stringify(meta, null, 1));
