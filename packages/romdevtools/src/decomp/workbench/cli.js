// cli.js - the in-process workbench command surface: the command catalog,
// an argument parser with the workbench's option grammar and error wording,
// and the JSON contract (one schema-named document per run; exit 0 success,
// 1 gate/no-result, 2 usage/capability/process, 3 census-failed).
//
// Commands are the late-stage mechanism diagnostics romdev drives: object
// diagnose, trace scheduler, trace globalcolor and instrument globalcolor.
// Every command runs inside the romdev process; the only child process any
// of them starts is the project's own objdump.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { dumps, renderJson } from "./pyjson.js";
import { strRepr } from "./py.js";

const casefold = (s) => s.toLowerCase();

export const PROG = "decomp-workbench";
export const ERROR_SCHEMA = "decomp-workbench-error-v1";
export const COMMAND_MAP_SCHEMA = "decomp-workbench-command-map-v1";

/** Report schemas per flat command name. */
export const SCHEMAS = Object.freeze({
  "commands": "decomp-workbench-command-map-v1",
  "diagnose": "decomp-workbench-diagnosis-v3",
  "trace-globalcolor": "decomp-workbench-trace-globalcolor-v1",
  "trace-scheduler": "decomp-workbench-scheduler-trace-v1",
});

export function schemaFor(command) { return SCHEMAS[command] ?? `decomp-workbench-${command}-v1`; }

const REGISTER_PROFILES = ["ido53", "unverified"];

const VIEW_RENDER_OPTIONS = (defaultMaxHunks) => [
  { flags: ["--report-regs"], action: "store_true" },
  { flags: ["--terse"], action: "store_true" },
  { flags: ["--context"], type: "int", default: 2 },
  { flags: ["--max-hunks"], type: "int", default: defaultMaxHunks },
  { flags: ["--lane-window"], type: "int", default: 32 },
  { flags: ["--show-all"], action: "store_true" },
  { flags: ["--register-profile"], default: "ido53", choices: REGISTER_PROFILES },
  { flags: ["--target-reservations"] },
  { flags: ["--candidate-reservations"] },
  { flags: ["--color"], default: "auto", choices: ["auto", "always", "never"] },
];

const VIEW_OUTPUT_OPTIONS = [
  { flags: ["--width"], default: 0 },
  { flags: ["--pager"], default: "auto", choices: ["auto", "always", "never"] },
  { flags: ["--html"] },
  { flags: ["--emit-force-spec"] },
];

/**
 * The ported commands. `group`/`command` is the grouped spelling the catalog
 * lists; `name` is the flat spelling. Handlers load lazily.
 */
export const COMMANDS = [
  {
    name: "diagnose", group: "object", command: "diagnose",
    description: "one-screen exactness, mechanism, and next lever",
    positionals: [{ dest: "target" }, { dest: "candidate" }],
    options: [
      { flags: ["--symbol", "--function"], dest: "symbol", action: "symbol" },
      { flags: ["--explain-keys"], action: "explain_keys" },
      { flags: ["--section"], default: ".text" },
      { flags: ["--objdump"] },
      { flags: ["--candidate-listing"] },
      { flags: ["--trace"] },
      { flags: ["--trace-proc"], type: "int" },
      { flags: ["--trace-web"], type: "int" },
      { flags: ["--ladder"] },
      { flags: ["--force-result"] },
      { flags: ["--ring-trace"] },
      { flags: ["--emit-trace"] },
      { flags: ["--as1-trace"] },
      { flags: ["--source"] },
      { flags: ["--lever-proc"], type: "int" },
      { flags: ["--json"], action: "store_true" },
      ...VIEW_RENDER_OPTIONS(1),
      ...VIEW_OUTPUT_OPTIONS,
      { flags: ["--show-diff"], action: "store_true" },
      { flags: ["--cross-rom"], action: "store_true" },
      { flags: ["--fail-on-mismatch"], action: "store_true" },
      { flags: ["--built-from"], action: "append", default: null },
      { flags: ["--allow-stale"], action: "store_true" },
      { flags: ["--census"], action: "append", default: [] },
    ],
    safety: { default: "read-only", external_process: true, network: false, destructive: false },
    load: async () => (await import("./diagnose-cli.js")).diagnoseCommand,
  },
  {
    name: "trace-globalcolor", group: "trace", command: "globalcolor",
    description: "inspect a focused allocator decision",
    positionals: [{ dest: "trace" }],
    options: [
      { flags: ["--proc"], type: "int" },
      { flags: ["--desired-register"] },
      { flags: ["--web"], type: "int" },
      { flags: ["--lineage-table"], type: "int", action: "append", default: [] },
      { flags: ["--dtype"], type: "int" },
      { flags: ["--top"], type: "int", default: 20 },
      { flags: ["--json"], action: "store_true" },
    ],
    safety: { default: "read-only", external_process: false, network: false, destructive: false },
    load: async () => (await import("./globalcolor-cli.js")).traceGlobalcolorCommand,
  },
  {
    name: "trace-scheduler", group: "trace", command: "scheduler",
    description: "inspect named ready-set decisions and tie-breaks",
    positionals: [{ dest: "trace" }],
    options: [
      { flags: ["--against"] },
      { flags: ["--from-as1-r"], action: "store_true" },
      { flags: ["--emit"] },
      { flags: ["--proc"], type: "int" },
      { flags: ["--block"], type: "int" },
      { flags: ["--limit"], type: "int", default: 50 },
      { flags: ["--json"], action: "store_true" },
    ],
    safety: { default: "read-only", external_process: false, network: false, destructive: false },
    load: async () => (await import("./scheduler-cli.js")).traceSchedulerCommand,
  },
  {
    name: "instrument-uopt-globalcolor", group: "instrument", command: "globalcolor",
    description: "add focused allocator color probes",
    positionals: [{ dest: "input" }, { dest: "output" }],
    options: [
      { flags: ["--allow-unverified-source"], action: "store_true" },
      { flags: ["--in-place"], action: "store_true" },
    ],
    safety: { default: "writes-explicit-output", external_process: false, network: false, destructive: false },
    load: async () => (await import("./instrument-uopt-cli.js")).instrumentUoptCommand,
  },
];

const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
const BY_GROUP = new Map(COMMANDS.map((c) => [`${c.group} ${c.command}`, c]));

/** Resolve a flat or grouped spelling to its command spec. */
export function resolveCommand(argv) {
  if (argv.length >= 2 && BY_GROUP.has(`${argv[0]} ${argv[1]}`)) return { spec: BY_GROUP.get(`${argv[0]} ${argv[1]}`), rest: argv.slice(2) };
  if (argv.length >= 1 && BY_NAME.has(argv[0])) return { spec: BY_NAME.get(argv[0]), rest: argv.slice(1) };
  return null;
}

/** The versioned, self-describing command map for the ported commands. */
export function commandMapPayload() {
  const groups = {};
  for (const c of COMMANDS) {
    (groups[c.group] ??= []).push({
      command: c.command, invocation: [PROG, c.group, c.command], description: c.description,
      report_schema: schemaFor(c.name), safety: { ...c.safety },
    });
  }
  return {
    schema: COMMAND_MAP_SCHEMA, groups,
    automation: {
      success: "one versioned JSON document when --json is supported",
      failure_schema: ERROR_SCHEMA,
      exit_codes: { 0: "success", 1: "gate/no-result", 2: "usage/capability/process", 3: "census-failed" },
    },
    network: { policy: [], commands: [], hosts: [] },
    compatibility: "Grouped spellings and flat command names are both supported.",
  };
}

class ArgumentError extends Error {
  /** @param {string} message @param {boolean} topLevel */
  constructor(message, topLevel = false) { super(message); this.topLevel = topLevel; }
}

const destOf = (o) => o.dest ?? o.flags[0].replace(/^--/, "").replace(/-/g, "_");
const isNegativeNumber = (s) => /^-\d+$|^-\d*\.\d+$/.test(s);

/**
 * Parse a command's argument list with the workbench's option grammar:
 * interleaved positionals, `--opt value` and `--opt=value`, unique-prefix
 * abbreviations, `--` to end options.
 */
export function parseArgs(spec, rest) {
  const args = { command: spec.name };
  for (const o of spec.options) {
    if (o.action === "explain_keys") continue;
    const d = destOf(o);
    if (!(d in args)) args[d] = o.action === "store_true" ? false : o.default === undefined ? null : Array.isArray(o.default) ? [...o.default] : o.default;
  }
  const positionals = [];
  const extras = [];
  const byFlag = new Map();
  for (const o of spec.options) for (const f of o.flags) byFlag.set(f, o);
  const find = (flag) => {
    if (byFlag.has(flag)) return [flag, byFlag.get(flag)];
    const hits = [...byFlag.keys()].filter((f) => f.startsWith(flag));
    const owners = new Set(hits.map((f) => byFlag.get(f)));
    if (owners.size === 1) return [hits[0], byFlag.get(hits[0])];
    if (owners.size > 1) throw new ArgumentError(`ambiguous option: ${flag} could match ${hits.join(", ")}`);
    return null;
  };
  const convert = (o, flag, value) => {
    const label = `argument ${o.flags.join("/")}`;
    let v = value;
    if (o.type === "int") {
      if (!/^\s*[-+]?\d+\s*$/.test(value)) throw new ArgumentError(`${label}: invalid int value: ${strRepr(value)}`);
      v = parseInt(value, 10);
    }
    if (o.choices && !o.choices.includes(v)) {
      throw new ArgumentError(`${label}: invalid choice: ${strRepr(v)} (choose from ${o.choices.map(strRepr).join(", ")})`);
    }
    return v;
  };
  let onlyPositionals = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (onlyPositionals || !tok.startsWith("-") || tok === "-" || isNegativeNumber(tok)) { positionals.push(tok); continue; }
    if (tok === "--") { onlyPositionals = true; continue; }
    const eq = tok.indexOf("=");
    const flagText = tok.startsWith("--") && eq > 0 ? tok.slice(0, eq) : tok;
    const found = find(flagText);
    if (!found) { extras.push(tok); continue; }
    const [flag, o] = found;
    const d = destOf(o);
    if (o.action === "store_true") {
      if (eq > 0 && tok.startsWith("--")) throw new ArgumentError(`argument ${o.flags.join("/")}: ignored explicit argument ${strRepr(tok.slice(eq + 1))}`);
      args[d] = true; continue;
    }
    if (o.action === "explain_keys") { args.__explain_keys = true; continue; }
    let value;
    if (eq > 0 && tok.startsWith("--")) value = tok.slice(eq + 1);
    else {
      const next = rest[i + 1];
      if (next === undefined || (next.startsWith("-") && next !== "-" && !isNegativeNumber(next))) {
        throw new ArgumentError(`argument ${o.flags.join("/")}: expected one argument`);
      }
      value = next; i++;
    }
    const v = convert(o, flag, value);
    if (o.action === "append") { args[d] = [...(args[d] ?? []), v]; continue; }
    if (o.action === "symbol") {
      const previous = args[d];
      if (previous !== null && previous !== undefined && previous !== v) {
        throw new ArgumentError(`argument ${o.flags.join("/")}: conflicts with ${args.__symbol_option ?? "--symbol"} ${strRepr(previous)}; --symbol and --function are two spellings of one selector`);
      }
      args.__symbol_option = flag;
    }
    args[d] = v;
  }
  const needed = spec.positionals;
  if (positionals.length < needed.length) {
    throw new ArgumentError(`the following arguments are required: ${needed.slice(positionals.length).map((p) => p.dest).join(", ")}`);
  }
  needed.forEach((p, idx) => { args[p.dest] = positionals[idx]; });
  extras.push(...positionals.slice(needed.length));
  if (extras.length) throw new ArgumentError(`unrecognized arguments: ${extras.join(" ")}`, true);
  delete args.__symbol_option;
  return args;
}

/** Does this command accept `flag`? Answered from the command's own grammar. */
export function commandAcceptsFlag(invocation, flag) {
  const r = resolveCommand(invocation.filter((x) => x !== PROG));
  if (!r) return false;
  return r.spec.options.some((o) => o.flags.includes(flag));
}

/** The shared error envelope. */
export function errorReport(command, { status, message, stage = "command", details = null }) {
  const lowered = casefold(message);
  const kind = lowered.includes("timeout") || lowered.includes("exceeded --timeout") ? "timeout"
    : lowered.includes("does not exist") || lowered.includes("no such file") ? "not-found"
    : lowered.includes("failed with exit") || lowered.includes("objdump failed") ? "process-failed"
    : status === 2 ? "usage" : status === 1 ? "no-result" : "command-failed";
  const error = { kind, message };
  if (details) error.details = details;
  return { schema: ERROR_SCHEMA, command, stage, status, error };
}

function withSchema(command, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return "schema" in value ? { ...value } : { ...value, schema: schemaFor(command) };
  return { schema: schemaFor(command), results: value };
}

/** Output sink: each call is one print() line. */
function makeIo() {
  const out = [], err = [];
  return { out, err, print: (s = "") => out.push(`${s}\n`), eprint: (s = "") => err.push(`${s}\n`) };
}

/**
 * Run one workbench command in process.
 * @param {string[]} argv flat or grouped command followed by its arguments
 * @param {{cwd?: string, env?: Record<string,string>}} [ctx]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export async function runCommand(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const ctx = { cwd, env: { ...process.env, ...(env ?? {}) }, resolve: (p) => path.resolve(cwd, p) };
  if (!argv.length) return { code: 0, stdout: "decomp-workbench: late-stage matching diagnostics. Run `commands` for the catalog.\n", stderr: "" };
  const jsonRequested = argv.includes("--json");
  if (argv[0] === "commands") {
    if (jsonRequested) return { code: 0, stdout: renderJson(commandMapPayload()), stderr: "" };
    const lines = ["Journey command map", "Grouped spellings and existing flat commands are both supported."];
    for (const c of COMMANDS) lines.push(`  ${c.group} ${c.command}  ${c.description}`);
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }
  const r = resolveCommand(argv);
  if (!r) {
    const word = argv[0];
    const message = `argument command: invalid choice: ${strRepr(word)} (choose from ${["commands", ...COMMANDS.map((c) => c.name)].map(strRepr).join(", ")})`;
    if (jsonRequested) return { code: 2, stdout: renderJson(errorReport("unknown", { status: 2, message })), stderr: "" };
    return { code: 2, stdout: "", stderr: `${PROG}: error: ${message}\n` };
  }
  const { spec, rest } = r;
  let args;
  try {
    args = parseArgs(spec, rest);
  } catch (e) {
    if (!(e instanceof ArgumentError)) throw e;
    const message = e.topLevel ? e.message : `${PROG} ${spec.name}: error: ${e.message}`;
    if (jsonRequested) return { code: 2, stdout: renderJson(errorReport(spec.name, { status: 2, message })), stderr: "" };
    return { code: 2, stdout: "", stderr: `${e.topLevel ? `${PROG}: error: ${e.message}` : message}\n` };
  }
  if (args.__explain_keys) {
    const { explainKeysText } = await import("./schema.js");
    return { code: 0, stdout: explainKeysText() + "\n", stderr: "" };
  }
  const handler = await spec.load();
  const io = makeIo();
  let status;
  try {
    status = await handler(args, io, ctx);
  } catch (e) {
    // A handler bug is a process failure, reported as the standard document.
    const message = String(e?.message ?? e);
    if (jsonRequested) return { code: 2, stdout: renderJson(errorReport(spec.name, { status: 2, message })), stderr: String(e?.stack ?? "") };
    return { code: 2, stdout: io.out.join(""), stderr: io.err.join("") + `error: ${message}\n` };
  }
  const stdout = io.out.join(""), stderr = io.err.join("");
  if (!jsonRequested) return { code: status, stdout, stderr };
  const output = stdout.trim(), diagnostic = stderr.trim();
  if (output) {
    let value;
    try { value = JSON.parse(output); } catch {
      return { code: 2, stdout: renderJson(errorReport(spec.name, { status: 2, message: diagnostic || "command emitted invalid JSON" })), stderr: "" };
    }
    return { code: status, stdout: renderJson(withSchema(spec.name, value)), stderr: "" };
  }
  const message = diagnostic.replace(/^error: /, "").trim() || "command produced no result";
  return { code: status || 2, stdout: renderJson(errorReport(spec.name, { status: status || 2, message })), stderr: "" };
}

export { dumps };
