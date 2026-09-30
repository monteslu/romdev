// cli.js - the workbench command surface: every command's grammar, the
// journey map's grouped spellings, and the JSON contract (one schema-named
// document per run; exit 0 success, 1 gate/no-result, 2
// usage/capability/process, 3 census-failed).
//
// Commands live in the `*-cli.js` modules beside this file; each exports
// COMMAND_SPECS (see argparse.js for the spec shape). They are discovered
// from the directory, so a new command module needs no edit here.
//
// runCommand() runs a command in the calling process. runCommandIsolated()
// runs it in a child node process (workbench/child.js) with the project
// directory as its working directory, and kills it on timeout.
//
// Plain JS ESM + JSDoc.

import path from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { renderJson } from "./pyjson.js";
import { errorReport, jsonEnvelope, SCHEMAS } from "./reporting.js";
import { rewriteGroupAlias, commandMapPayload as mapPayload } from "./discovery.js";
import { parseArgs, formatHelp, formatUsage, ArgumentError, ParserExit } from "./argparse.js";

export const PROG = "decomp-workbench";
export const VERSION = "0.8.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const WELCOME = [
  "decomp-workbench: diagnose why an almost-matching MIPS object still differs, and what to change next.",
  "New here? Run `decomp-workbench commands` for the compact map, or read docs/START_HERE.md",
  "Full command list: decomp-workbench --help",
  "Name a lever family: decomp-workbench guide <playbook|verdict|lever>",
];

let _specs = null;

/** Every command spec, keyed by its argv path ("trace-scheduler", "experiment validate"). */
export async function commandSpecs() {
  if (_specs) return _specs;
  const files = readdirSync(HERE).filter((f) => f.endsWith("-cli.js")).sort();
  const map = new Map();
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(HERE, f)).href);
    for (const spec of mod.COMMAND_SPECS ?? []) {
      const key = spec.path.join(" ");
      if (map.has(key)) throw new Error(`workbench command '${key}' is defined twice (${f})`);
      map.set(key, { ...spec, module: f });
    }
  }
  _specs = map;
  return map;
}

/** Longest registered argv path that prefixes `argv`. */
export async function resolveCommand(argv) {
  const specs = await commandSpecs();
  const rewritten = rewriteGroupAlias(argv);
  for (let n = Math.min(3, rewritten.length); n >= 1; n--) {
    const key = rewritten.slice(0, n).join(" ");
    if (specs.has(key)) return { spec: specs.get(key), rest: rewritten.slice(n), argv: rewritten };
  }
  return null;
}

/** The versioned command map (every catalogued command). */
export function commandMapPayload() { return mapPayload(); }

/** Does the command at `invocation` accept `flag`? From its own grammar. */
export async function commandAcceptsFlag(invocation, flag) {
  const r = await resolveCommand(invocation.filter((x) => x !== PROG));
  if (!r) return false;
  return r.spec.arguments.some((a) => Array.isArray(a.flags) && a.flags.includes(flag));
}

function makeIo() {
  const out = [], err = [];
  return {
    out, err,
    print: (s = "") => out.push(`${s}\n`),
    eprint: (s = "") => err.push(`${s}\n`),
    write: (s) => out.push(String(s)),
    ewrite: (s) => err.push(String(s)),
  };
}

function reportCommandFor(argv) {
  const nested = argv.length >= 2 ? `${argv[0]}-${argv[1]}` : "unknown";
  if (SCHEMAS[nested]) return nested;
  return argv.find((a) => SCHEMAS[a]) ?? "unknown";
}

/**
 * Run one workbench command in this process.
 * @param {string[]} argv command words then arguments (flat or grouped spelling)
 * @param {{cwd?: string, env?: Record<string,string>}} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export async function runCommand(argv, { cwd = process.cwd(), env = {} } = {}) {
  const ctx = { cwd, env: { ...process.env, ...(env ?? {}) }, resolve: (p) => path.resolve(cwd, p), runCommand: (a) => runCommand(a, { cwd, env }) };
  if (!argv.length) return { code: 0, stdout: WELCOME.join("\n") + "\n", stderr: "" };
  if (argv[0] === "--version") return { code: 0, stdout: `${PROG} ${VERSION}\n`, stderr: "" };
  if (argv[0] === "--help" || argv[0] === "-h") {
    const specs = await commandSpecs();
    const { HIDDEN_FLAT_COMMANDS } = await import("./discovery.js");
    const names = [...specs.values()].filter((s) => s.path.length === 1 && !HIDDEN_FLAT_COMMANDS.has(s.path[0])).map((s) => s.path[0]).sort();
    const lines = [`usage: ${PROG} [-h] [--version] [--explain-keys] COMMAND ...`, "",
      "MIPS object diagnosis, decomp.me handoffs, candidate campaigns, compiler traces, and pass replay", "",
      "positional arguments:", "  COMMAND               run `decomp-workbench commands` for the compact journey map",
      ...names.map((n) => `    ${n.padEnd(20)}${specs.get(n).help ?? ""}`), "",
      "Start with `decomp-workbench commands` for the compact journey map, or docs/START_HERE.md for the whole workflow."];
    return { code: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  }
  if (argv[0] === "--explain-keys") {
    const { explainKeysText } = await import("./schema.js");
    return { code: 0, stdout: explainKeysText() + "\n", stderr: "" };
  }
  const jsonRequested = argv.includes("--json") || argv.includes("--json-summary");
  const r = await resolveCommand(argv);
  if (!r) {
    const word = rewriteGroupAlias(argv)[0];
    const lines = `${PROG}: error: '${word}' is not a ${PROG} command.\nRun \`${PROG} commands\` for the compact journey map, or \`${PROG} --help\` for every command.\n`;
    if (jsonRequested) return { code: 2, stdout: renderJson(errorReport(reportCommandFor(rewriteGroupAlias(argv)), { status: 2, message: `'${word}' is not a ${PROG} command.` })), stderr: "" };
    return { code: 2, stdout: "", stderr: `usage: ${PROG} [-h] [--version] [--explain-keys] COMMAND ...\n${lines}` };
  }
  const { spec, rest } = r;
  const prog = `${PROG} ${spec.path.join(" ")}`;
  let args;
  try {
    const { explainKeysText } = await import("./schema.js");
    args = parseArgs(spec, rest, { prog, explainKeys: explainKeysText, version: `${PROG} ${VERSION}` });
  } catch (e) {
    if (e instanceof ParserExit) return { code: e.status, stdout: e.stdout, stderr: "" };
    if (!(e instanceof ArgumentError)) throw e;
    const line = e.topLevel ? `${PROG}: error: ${e.message}` : `${prog}: error: ${e.message}`;
    if (jsonRequested) {
      // The top-level parser's prefix is stripped; a subcommand's is kept.
      const message = e.topLevel ? e.message : line;
      return { code: 2, stdout: renderJson(errorReport(reportCommandFor(r.argv), { status: 2, message })), stderr: "" };
    }
    return { code: 2, stdout: "", stderr: `${formatUsage(spec, { prog })}${line}\n` };
  }
  args.command = spec.path[0];
  const io = makeIo();
  let status;
  try {
    status = await spec.handler(args, io, ctx);
  } catch (e) {
    const message = String(e?.message ?? e);
    if (jsonRequested) return { code: 2, stdout: renderJson(errorReport(String(args.report_command ?? args.command), { status: 2, message })), stderr: String(e?.stack ?? "") };
    return { code: 2, stdout: io.out.join(""), stderr: io.err.join("") + `error: ${message}\n` };
  }
  status = status ?? 0;
  const stdout = io.out.join(""), stderr = io.err.join("");
  if (!jsonRequested || spec.rawJson) return { code: status, stdout, stderr };
  const env2 = jsonEnvelope(String(args.report_command ?? args.command), status, stdout, stderr);
  return { code: env2.code, stdout: env2.stdout, stderr: "" };
}

/** A spec for a command group with no operation: print its listing. */
export function listingSpec(pathWords, { help, description, epilog }) {
  return {
    path: pathWords, help, description, epilog, arguments: [],
    handler: (_args, io) => { io.write(formatHelp({ arguments: [], description, epilog }, { prog: `${PROG} ${pathWords.join(" ")}` })); return 0; },
  };
}

const CHILD = fileURLToPath(new URL("./child.js", import.meta.url));

/**
 * Run one command in a child node process whose working directory is `cwd`,
 * killed (with any process it started) when it exceeds `timeoutMs`.
 */
export function runCommandIsolated(argv, { cwd = process.cwd(), env = {}, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false, stderrTail = "";
    const child = fork(CHILD, [], { cwd, env: { ...process.env, ...(env ?? {}) }, stdio: ["ignore", "ignore", "pipe", "ipc"], detached: true, serialization: "advanced" });
    child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-4000); });
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
      const message = `timeout: exceeded --timeout of ${timeoutMs} ms; the command and every process it started were killed`;
      const jsonRequested = argv.includes("--json");
      finish({ code: 2, stdout: jsonRequested ? renderJson(errorReport(argv[0] ?? "unknown", { status: 2, message })) : "", stderr: `error: ${message}\n`, timedOut: true });
    }, timeoutMs);
    child.on("message", (m) => { if (m?.type === "result") finish({ code: m.code, stdout: m.stdout, stderr: m.stderr }); });
    child.on("error", (e) => finish({ code: 2, stdout: "", stderr: `error: ${e.message}\n` }));
    child.on("exit", (code, signal) => finish({ code: 2, stdout: "", stderr: `error: workbench command process exited (${signal ?? code}) without a result\n${stderrTail}` }));
    child.send({ type: "run", argv, cwd, env });
  });
}
