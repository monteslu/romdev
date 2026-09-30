// capture.js - arg-preserving compiler phase capture around an unmodified IDO
// root. IDO's driver hands its phases temporary files it deletes on exit;
// this generates a toolchain copy where each wrapped phase (ugen, as0, as1 by
// default) is a link to one node wrapper that copies every FILE argument
// before and after a single invocation into a labelled run directory, next to
// the exact argv and exit status. The untouched phase binary is kept beside
// it as <phase>.real and run unchanged, so a capture build is byte-identical
// to a normal one.
//
// Run directory layout: <dest>/captures/<YYYYmmdd-HHMMSS>-<pid>-<phase>/
//   argv.txt (one "%03d <argument>" line per argument), status.txt,
//   before-<n>-<basename>, after-<n>-<basename>, phase.txt, cwd.txt.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ValueError, strRepr, sorted, splitlines } from "./py.js";
import { FileNotFoundError, OSError } from "./py-extra.js";
import { dumps } from "./pyjson.js";
import { fileSha256 } from "./campaign.js";
import { fileURLToPath } from "node:url";

const PROC_CHILD = fileURLToPath(new URL("./proc-child.js", import.meta.url));

export const CAPTURE_SCHEMA = "decomp-workbench-capture-toolchain-v1";
export const CAPTURE_RUNS_SCHEMA = "decomp-workbench-capture-runs-v1";
export const CAPTURE_MANIFEST_NAME = "workbench-capture.json";
export const WRAPPER_NAME = "phase-wrapper";
export const TOOLCHAIN_DIRECTORY = "toolchain";
export const CAPTURES_DIRECTORY = "captures";
export const DEFAULT_PHASES = ["ugen", "as0", "as1"];
export const VALUE_OPTIONS = new Set(["-o", "-t", "-temp", "-l", "-G"]);
export const OPTION_ROLES = { "-o": "output", "-t": "symtab", "-temp": "temp", "-l": "listing" };

/**
 * The wrapper every wrapped phase name links to. A phase binary that is a
 * real IDO pass (an ELF executable) runs through romdev's WASM toolchain
 * (proc-child.js, whose path is written into the wrapper), never on the host;
 * a phase that is itself a script (a stand-in) runs as it is.
 */
export function wrapperText(procChild = PROC_CHILD) {
  return `#!/usr/bin/env node
// decomp-workbench phase capture wrapper.
//
// Preserve one compiler phase's file arguments around a single invocation.
// The wrapper is invoked through a symlink named for the phase; the untouched
// phase binary lives beside it as "<phase>.real" and is run unchanged, so a
// capture build produces the same bytes as a normal one.
//
// WORKBENCH_CAPTURE_OFF=1   pass straight through, capturing nothing
// WORKBENCH_CAPTURE_ROOT    write run directories here instead of ../captures
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const invoked = process.argv[1];
const toolDir = path.dirname(path.resolve(invoked));
const phase = path.basename(invoked);
const realTool = path.join(toolDir, phase + ".real");
const args = process.argv.slice(2);

function executable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }
const ROMDEV_PROC_CHILD = ${JSON.stringify(procChild)};
function isElf(p) {
  try { const fd = fs.openSync(p, "r"); const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString("latin1") === "\\x7fELF"; } catch { return false; }
}
function run() {
  let r;
  if (isElf(realTool)) {
    const version = /(?:^|[\\/_-])(?:ido)?[\\/_-]?(5\\.3|7\\.1)(?:[\\/_]|$)/i.exec(toolDir);
    if (!version) { process.stderr.write("capture wrapper: " + realTool + " is a host IDO pass and its IDO version is not in the toolchain path; romdev runs IDO passes only as WASM\\n"); return 127; }
    const job = JSON.stringify({ argv: ["/ido/" + version[1] + "/" + phase, ...args], cwd: process.cwd(), mode: "wasm", env: process.env, stdin: null });
    r = spawnSync(process.execPath, [ROMDEV_PROC_CHILD], { input: job, stdio: ["pipe", "inherit", "inherit"] });
  } else {
    r = spawnSync(realTool, args, { stdio: "inherit" });
  }
  if (r.error) { process.stderr.write("capture wrapper: " + r.error.message + "\\n"); return 127; }
  if (r.signal) return 128 + (require("os").constants.signals[r.signal] || 1);
  return r.status;
}
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function copyPreserving(from, to) {
  fs.copyFileSync(from, to);
  const st = fs.statSync(from);
  fs.chmodSync(to, st.mode & 0o7777);
  fs.utimesSync(to, st.atime, st.mtime);
}
const pad = (n, w = 2) => String(n).padStart(w, "0");

if (!executable(realTool)) {
  process.stderr.write("capture wrapper: no real phase binary at " + realTool + "\\n");
  process.exit(127);
}
if ((process.env.WORKBENCH_CAPTURE_OFF || "0") === "1") process.exit(run());

const captureRoot = process.env.WORKBENCH_CAPTURE_ROOT || path.join(path.dirname(toolDir), "captures");
fs.mkdirSync(captureRoot, { recursive: true });
const d = new Date();
const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
const runDir = path.join(captureRoot, stamp + "-" + process.pid + "-" + phase);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, "phase.txt"), phase + "\\n");
fs.writeFileSync(path.join(runDir, "cwd.txt"), process.cwd() + "\\n");
let argvText = "";
args.forEach((arg, i) => {
  argvText += pad(i + 1, 3) + " " + arg + "\\n";
  if (isFile(arg)) copyPreserving(arg, path.join(runDir, "before-" + (i + 1) + "-" + path.basename(arg)));
});
fs.writeFileSync(path.join(runDir, "argv.txt"), argvText);
const status = run();
args.forEach((arg, i) => {
  if (isFile(arg)) copyPreserving(arg, path.join(runDir, "after-" + (i + 1) + "-" + path.basename(arg)));
});
fs.writeFileSync(path.join(runDir, "status.txt"), status + "\\n");
process.exit(status);
`;
}

function makeExecutable(p) {
  const mode = fs.statSync(p).mode;
  fs.chmodSync(p, mode | 0o111);
}

/** One phase invocation's arguments, split into roles. */
export class CapturedArgv {
  constructor({ argv, inputs, roles, flags }) { Object.assign(this, { argv, inputs, roles, flags }); Object.freeze(this); }
  indexOf(role) { const e = this.roles[role]; return e === undefined ? null : e[0]; }
  // value_of(role). With no role this stays the ordinary object valueOf, so
  // the record never coerces to a role value by accident.
  valueOf(role) { if (role === undefined) return this; const e = this.roles[role]; return e === undefined ? null : e[1]; }
  summary() {
    const parts = this.inputs.map(([, v]) => path.posix.basename(v));
    for (const role of ["output", "symtab", "temp", "listing"]) {
      const e = this.roles[role];
      if (e !== undefined) parts.push(`${role}=${path.posix.basename(e[1])}`);
    }
    return parts.length ? parts.join(" ") : "(no file arguments)";
  }
  asDict() {
    const roles = {};
    for (const role of sorted(Object.keys(this.roles))) roles[role] = { index: this.roles[role][0], value: this.roles[role][1] };
    return { argv: [...this.argv], inputs: this.inputs.map(([index, value]) => ({ index, value })), roles, flags: [...this.flags], summary: this.summary() };
  }
}

/** Split one phase command line into inputs, named roles, and flags. */
export function parsePhaseArgv(argv) {
  const inputs = [], roles = {}, flags = [];
  let pending = null;
  argv.forEach((argument, i) => {
    const index = i + 1;
    if (pending !== null) {
      const role = OPTION_ROLES[pending];
      if (role !== undefined) roles[role] = [index, argument];
      else flags.push(`${pending} ${argument}`);
      pending = null;
      return;
    }
    if (VALUE_OPTIONS.has(argument)) { pending = argument; return; }
    if (argument.startsWith("-")) { flags.push(argument); return; }
    inputs.push([index, argument]);
  });
  if (pending !== null) flags.push(pending);
  return new CapturedArgv({ argv: [...argv], inputs, roles, flags });
}

/** Read the wrapper's `%03d <argument>` argv listing in recorded order. */
export function readArgvFile(p) {
  let st = null;
  try { st = fs.statSync(p); } catch { st = null; }
  if (!st?.isFile()) return [];
  const entries = [];
  const text = new TextDecoder("utf-8", { fatal: false }).decode(fs.readFileSync(p));
  for (const line of splitlines(text)) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    const indexText = sp < 0 ? line : line.slice(0, sp);
    if (sp < 0 || !/^\d+$/.test(indexText)) throw new ValueError(`${p}: malformed argv line: ${strRepr(line)}`);
    entries.push([parseInt(indexText, 10), line.slice(sp + 1)]);
  }
  return sorted(entries, (e) => e[0]).map((e) => e[1]);
}

const expand = (p) => (p === "~" || String(p).startsWith("~/") ? (process.env.HOME ?? "") + String(p).slice(1) : String(p));
const resolve = (p) => { const a = path.resolve(expand(p)); try { return fs.realpathSync(a); } catch { return a; } };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function carry(source, target, { link }) {
  if (link) {
    if (lexists(target)) fs.unlinkSync(target);
    fs.symlinkSync(source, target);
    return;
  }
  if (isDir(source)) {
    // Copy the tree with every link dereferenced into an ordinary file.
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) carry(path.join(source, name), path.join(target, name), { link: false });
    return;
  }
  fs.copyFileSync(source, target);
  const st = fs.statSync(source);
  fs.chmodSync(target, st.mode & 0o7777);
  fs.utimesSync(target, st.atime, st.mtime);
}

/** Generate an arg-preserving wrapper toolchain around one IDO root. */
export function makeCaptureToolchain(source, destination, { phases = DEFAULT_PHASES, link = false, force = false } = {}) {
  const root = resolve(source);
  const dest = resolve(destination);
  if (!isDir(root)) throw Object.assign(new OSError(`IDO root is not a directory: ${root}`), { kind: "NotADirectoryError" });
  if (dest === root || dest.startsWith(root + path.sep)) throw new ValueError("destination must not be inside the IDO root");
  const wanted = [...new Set(phases)];
  if (!wanted.length) throw new ValueError("at least one phase must be wrapped");
  const missing = wanted.filter((p) => !isFile(path.join(root, p)));
  if (missing.length) {
    const available = sorted(fs.readdirSync(root)).join(", ") || "nothing";
    throw new FileNotFoundError(`IDO root ${root} has no ${missing.join(", ")}; it contains ${available}`);
  }
  const toolchain = path.join(dest, TOOLCHAIN_DIRECTORY);
  const captures = path.join(dest, CAPTURES_DIRECTORY);
  if (lexists(toolchain)) {
    if (!force) {
      throw Object.assign(new OSError(`refusing to overwrite an existing capture toolchain: ${toolchain} (pass --force to replace it; collected captures are kept)`), { kind: "FileExistsError" });
    }
    fs.rmSync(toolchain, { recursive: true, force: true });
  }
  fs.mkdirSync(toolchain, { recursive: true });
  fs.mkdirSync(captures, { recursive: true });
  const carried = [], aliases = [];
  for (const name of sorted(fs.readdirSync(root))) {
    const entry = path.join(root, name);
    const target = path.join(toolchain, name);
    if (isLink(entry) && !isFile(entry) && !isDir(entry)) { carried.push({ name, carried: "skipped-dangling-symlink" }); continue; }
    if (isLink(entry) && resolve(entry) === root) {
      // A version self-alias (`7.1 -> .`) must point at the capture copy.
      fs.symlinkSync(".", target);
      aliases.push(name);
      carried.push({ name, carried: "self-alias" });
      continue;
    }
    if (wanted.includes(name)) {
      const real = path.join(toolchain, `${name}.real`);
      carry(entry, real, { link });
      if (!isLink(real)) makeExecutable(real);
      carried.push({ name, carried: "wrapped", real: path.basename(real), bytes: fs.statSync(entry).size, sha256: fileSha256(entry) });
      continue;
    }
    carry(entry, target, { link });
    carried.push({ name, carried: link ? "symlink" : "copy", bytes: isFile(entry) ? fs.statSync(entry).size : null });
  }
  const wrapper = path.join(toolchain, WRAPPER_NAME);
  fs.writeFileSync(wrapper, wrapperText(), "utf8");
  makeExecutable(wrapper);
  for (const phase of wanted) {
    const linkPath = path.join(toolchain, phase);
    if (lexists(linkPath)) fs.unlinkSync(linkPath);
    fs.symlinkSync(WRAPPER_NAME, linkPath);
  }
  const alias = path.basename(root);
  if (alias && !aliases.includes(alias) && !lexists(path.join(toolchain, alias))) {
    fs.symlinkSync(".", path.join(toolchain, alias));
    aliases.push(alias);
  }
  const manifest = {
    schema: CAPTURE_SCHEMA, created_at_unix: Date.now() / 1000, source: root, destination: dest, toolchain, captures,
    carry_mode: link ? "symlink" : "copy", wrapped_phases: wanted, wrapper: { name: WRAPPER_NAME, sha256: fileSha256(wrapper) },
    self_aliases: aliases, entries: carried,
    usage: `point the project's compiler root at ${toolchain} and build one translation unit; every wrapped phase leaves one run directory under ${captures}. Set WORKBENCH_CAPTURE_OFF=1 to pass through.`,
    proof: "The wrapper runs the untouched phase binary and only copies file arguments, so a capture build is byte-identical to a normal one. It does not prove anything by itself; it retains the evidence.",
  };
  fs.writeFileSync(path.join(dest, CAPTURE_MANIFEST_NAME), dumps(manifest) + "\n", "utf8");
  return manifest;
}

/** Accept either a capture destination or the toolchain directory itself. */
export function resolveToolchain(root) {
  const p = resolve(root);
  const nested = path.join(p, TOOLCHAIN_DIRECTORY);
  return isDir(nested) ? nested : p;
}

/** Accept either a capture destination or the captures directory itself. */
export function resolveCaptures(root) {
  const p = resolve(root);
  const nested = path.join(p, CAPTURES_DIRECTORY);
  if (isDir(nested)) return nested;
  if (isDir(p)) return p;
  throw Object.assign(new OSError(`no capture directory at ${p}`), { kind: "NotADirectoryError" });
}

/** The untouched phase binary, preferring `<phase>.real`. */
export function stockPhaseBinary(toolchain, phase) {
  const root = resolveToolchain(toolchain);
  const real = path.join(root, `${phase}.real`);
  if (isFile(real) || isLink(real)) return real;
  const plain = path.join(root, phase);
  if (isFile(plain) || isLink(plain)) {
    if (isLink(plain) && path.basename(fs.readlinkSync(plain)) === WRAPPER_NAME) {
      throw new FileNotFoundError(`${plain} is a capture wrapper but ${real} is missing; regenerate the toolchain with \`capture make\``);
    }
    return plain;
  }
  throw new FileNotFoundError(`no ${phase} binary in ${root}`);
}

/** One retained copy of a phase file argument. */
export class CaptureFile {
  constructor({ role, index, name, path: p, size }) { Object.assign(this, { role, index, name, path: p, size }); Object.freeze(this); }
  asDict() { return { role: this.role, argument_index: this.index, name: this.name, path: this.path, bytes: this.size }; }
}

/** One wrapped phase invocation, as retained on disk. */
export class CaptureRun {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get stream_bytes() { return this.files.reduce((s, i) => s + i.size, 0); }
  fileFor(role, index) {
    if (index === null || index === undefined) return null;
    return this.files.find((i) => i.role === role && i.index === index) ?? null;
  }
  asDict() {
    return { run_id: this.run_id, directory: this.directory, phase: this.phase, status: this.status, cwd: this.cwd,
      argv: this.argv.asDict(), files: this.files.map((f) => f.asDict()), stream_bytes: this.stream_bytes, file_count: this.files.length };
  }
}

function runPhase(directory, argv) {
  const marker = path.join(directory, "phase.txt");
  if (isFile(marker)) {
    const recorded = fs.readFileSync(marker, "utf8").trim();
    if (recorded) return recorded;
  }
  const parts = path.basename(directory).split("-");
  if (parts.length >= 3 && !/^\d+$/.test(parts[2])) return parts[2];
  if (parts.length >= 4) return parts[3];
  if (argv.valueOf("temp") && argv.valueOf("output")) return "ugen";
  return "unknown";
}

/** Read one retained run directory into a structured record. */
export function readCaptureRun(directory) {
  const p = resolve(directory);
  if (!isDir(p)) throw Object.assign(new OSError(`capture run is not a directory: ${p}`), { kind: "NotADirectoryError" });
  const argv = parsePhaseArgv(readArgvFile(path.join(p, "argv.txt")));
  let status = null;
  const statusPath = path.join(p, "status.txt");
  if (isFile(statusPath)) {
    const text = fs.readFileSync(statusPath, "utf8").trim();
    if (/^-*\d+$/.test(text)) {
      if (!/^-?\d+$/.test(text)) throw new ValueError(`invalid literal for int() with base 10: ${strRepr(text)}`);
      status = parseInt(text, 10);
    }
  }
  const cwdPath = path.join(p, "cwd.txt");
  const cwd = isFile(cwdPath) ? fs.readFileSync(cwdPath, "utf8").trim() : null;
  let files = [];
  for (const name of sorted(fs.readdirSync(p))) {
    const entry = path.join(p, name);
    if (!isFile(entry)) continue;
    const dash = name.indexOf("-");
    if (dash < 0) continue;
    const role = name.slice(0, dash);
    if (role !== "before" && role !== "after") continue;
    const remainder = name.slice(dash + 1);
    const dash2 = remainder.indexOf("-");
    if (dash2 < 0 || !/^\d+$/.test(remainder.slice(0, dash2))) continue;
    files.push(new CaptureFile({ role, index: parseInt(remainder.slice(0, dash2), 10), name: remainder.slice(dash2 + 1), path: entry, size: fs.statSync(entry).size }));
  }
  files = sorted(files, (i) => [i.index, i.role]);
  return new CaptureRun({ run_id: path.basename(p), directory: p, phase: runPhase(p, argv), status, argv, files, cwd });
}

const isReadError = (e) => e?.name === "ValueError" || e?.name === "OSError" || (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code));

/** List collected runs newest last, with phase, argv, and stream sizes. */
export function listCaptureRuns(root, { phase = null, limit = null } = {}) {
  const captures = resolveCaptures(root);
  let runs = [];
  const unreadable = [];
  for (const name of sorted(fs.readdirSync(captures))) {
    const entry = path.join(captures, name);
    if (!isDir(entry)) continue;
    let run;
    try { run = readCaptureRun(entry); } catch (e) {
      if (!isReadError(e)) throw e;
      unreadable.push({ directory: entry, error: e.message });
      continue;
    }
    if (phase !== null && run.phase !== phase) continue;
    runs.push(run);
  }
  const total = runs.length;
  if (limit !== null && limit >= 0) runs = limit ? runs.slice(-limit) : [];
  const phases = {};
  for (const run of runs) phases[run.phase] = (phases[run.phase] ?? 0) + 1;
  const phaseCounts = Object.fromEntries(sorted(Object.entries(phases), (e) => e[0]));
  return { schema: CAPTURE_RUNS_SCHEMA, captures, run_count: total, listed_count: runs.length, phase_counts: phaseCounts,
    runs: runs.map((r) => r.asDict()), unreadable };
}

/** The newest run of one phase, optionally by its input basename. */
export function findCaptureRun(root, { phase, input_name = null }) {
  const captures = resolveCaptures(root);
  let best = null;
  for (const name of sorted(fs.readdirSync(captures))) {
    const entry = path.join(captures, name);
    if (!isDir(entry)) continue;
    let run;
    try { run = readCaptureRun(entry); } catch (e) { if (isReadError(e)) continue; throw e; }
    if (run.phase !== phase) continue;
    if (input_name !== null && !run.argv.inputs.some(([, v]) => path.posix.basename(v) === input_name)) continue;
    best = run;
  }
  return best;
}
