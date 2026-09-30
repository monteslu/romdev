// objdump.js - objdump discovery, invocation and parsing. GNU objdump prints
// relocations on the line after the affected instruction; the parser makes
// them part of the instruction so comparison masks only linker-controlled
// fields. The project's objdump is the only child process this starts.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runProgramSync } from "./proc.js";
import { toolName } from "../toolchain.js";

/** The shipped WASM objdump, by the name proc.js routes to it. */
export const WASM_OBJDUMP = "mips-linux-gnu-objdump";
import { MINIMUM_ELIDED_RUN } from "./elf-instructions.js";
import { symbolExtent } from "./elf-symbols.js";
import { annotateLocalPc16 } from "./local-pc16.js";
import { Instruction, Relocation } from "./model.js";
import { splitlines, strip, strRepr } from "./py.js";
import { FileNotFoundError, RuntimeError } from "./py-extra.js";

export const SYMBOL_LIST_LIMIT = 8;
export const TROUBLESHOOTING_NO_INSTRUCTIONS = "docs/troubleshooting.md#objdump-produced-no-instructions";

export const INSTRUCTION_RE = /^\s*([0-9a-fA-F]+):\s+([0-9a-fA-F]{8})\s+(.+?)\s*$/;
export const RELOCATION_RE = /^\s*([0-9a-fA-F]+):?\s+(R_MIPS_[A-Za-z0-9_]+)(?:\s+(.+?))?\s*$/;
export const SYMBOL_RE = /^\s*[0-9a-fA-F]+\s+<(?<name>[^>]+)>:\s*$/;
const BRANCH_DESTINATION_RE = /^(?<opcode>b[a-z0-9._]*)\s+[^<>]*<(?<name>[^>+ ]+)>\s*$/;
const LINKING_BRANCHES = new Set(["bal", "bgezal", "bgezall", "bltzal", "bltzall"]);
const casefold = (s) => s.toLowerCase();

/** Measured GNU/MIPS capabilities for one executable. */
export class ObjdumpProbe {
  constructor({ executable, compatible, version, checks, error = null }) { Object.assign(this, { executable, compatible, version, checks, error }); Object.freeze(this); }
  asDict() { return { compatible: this.compatible, version: this.version, checks: Object.fromEntries(this.checks), error: this.error }; }
}

/** A tiny deterministic MIPS ELF32 object with one relocation. */
export function mipsProbeObject() {
  const align = (v, b = 4) => (v + b - 1) & ~(b - 1);
  const be = (fmt, ...vals) => {
    const sizes = { I: 4, H: 2, B: 1 };
    const buf = Buffer.alloc([...fmt].reduce((n, c) => n + sizes[c], 0));
    let o = 0;
    [...fmt].forEach((c, i) => { if (c === "I") buf.writeUInt32BE(vals[i] >>> 0, o); else if (c === "H") buf.writeUInt16BE(vals[i], o); else buf.writeUInt8(vals[i], o); o += sizes[c]; });
    return buf;
  };
  const text = be("III", 0x0C000000, 0x03E00008, 0);
  const relocation = be("II", 0, (1 << 8) | 4);
  const strings = Buffer.from("\0probe_external\0probe_func\0", "latin1");
  const symbols = Buffer.concat([Buffer.alloc(16), be("IIIBBH", strings.indexOf("probe_external"), 0, 0, 0x10, 0, 0),
    be("IIIBBH", strings.indexOf("probe_func"), 0, text.length, 0x12, 0, 1)]);
  const sectionNames = Buffer.from("\0.text\0.rel.text\0.symtab\0.strtab\0.shstrtab\0", "latin1");
  const textOffset = 52;
  const relocationOffset = align(textOffset + text.length);
  const symbolsOffset = align(relocationOffset + relocation.length);
  const stringsOffset = align(symbolsOffset + symbols.length);
  const sectionNamesOffset = align(stringsOffset + strings.length);
  const shoff = align(sectionNamesOffset + sectionNames.length);
  const header = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    be("HHIIIIIHHHHHH", 1, 8, 1, 0, 0, shoff, 0x10001007, 52, 0, 0, 40, 6, 5)]);
  const nameOf = (n) => sectionNames.indexOf(n);
  const sh = (...v) => be("IIIIIIIIII", ...v);
  const secs = Buffer.concat([Buffer.alloc(40),
    sh(nameOf(".text"), 1, 0x6, 0, textOffset, text.length, 0, 0, 4, 0),
    sh(nameOf(".rel.text"), 9, 0, 0, relocationOffset, relocation.length, 3, 1, 4, 8),
    sh(nameOf(".symtab"), 2, 0, 0, symbolsOffset, symbols.length, 4, 1, 4, 16),
    sh(nameOf(".strtab"), 3, 0, 0, stringsOffset, strings.length, 0, 0, 1, 0),
    sh(nameOf(".shstrtab"), 3, 0, 0, sectionNamesOffset, sectionNames.length, 0, 0, 1, 0)]);
  const image = Buffer.alloc(shoff + secs.length);
  header.copy(image, 0); text.copy(image, textOffset); relocation.copy(image, relocationOffset); symbols.copy(image, symbolsOffset);
  strings.copy(image, stringsOffset); sectionNames.copy(image, sectionNamesOffset); secs.copy(image, shoff);
  return image;
}

const decoder = () => new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
function runText(cmd, args, { timeout, env } = {}) {
  const r = runProgramSync([cmd, ...args], { timeout, env: env ?? process.env });
  if (r.error) throw r.error;
  return { returncode: r.status ?? -1, stdout: decoder().decode(r.stdout ?? Buffer.alloc(0)).replace(/\r\n?/g, "\n"), stderr: decoder().decode(r.stderr ?? Buffer.alloc(0)).replace(/\r\n?/g, "\n") };
}

const probeCache = new Map();

/** Measure whether `executable` satisfies the workbench contract. */
export function probeObjdump(executable, { env } = {}) {
  // A WASM binutils name has no host file: it is identified by its name.
  const wasm = !executable.includes("/") && toolName(executable)?.kind === "binutils" && !fs.existsSync(executable);
  const resolved = wasm ? executable : fs.realpathSync(executable);
  const st = wasm ? { mtimeMs: 0, size: 0 } : fs.statSync(resolved);
  const key = `${resolved}:${st.mtimeMs}:${st.size}`;
  if (probeCache.has(key)) return probeCache.get(key);
  let version = null;
  const checks = { mips_elf32: false, symbol_filter: false, gnu_instruction_syntax: false, mips_relocations: false };
  let result;
  try {
    const v = runText(resolved, ["--version"], { timeout: 3000, env });
    const lines = splitlines(v.stdout || v.stderr);
    version = lines.length ? strip(lines[0]) : null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decomp-workbench-objdump-probe-"));
    try {
      const probe = path.join(tmp, "mips-probe.o");
      fs.writeFileSync(probe, mipsProbeObject());
      result = runText(resolved, ["-d", "-r", "-z", "-j", ".text", probe, "--disassemble=probe_func"], { timeout: 3000, env });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    checks.mips_elf32 = result.returncode === 0;
    checks.symbol_filter = result.stdout.includes("<probe_func>:");
    const ins = parseDisassembly(result.stdout, { symbol: "probe_func" });
    checks.gnu_instruction_syntax = JSON.stringify(ins.map((i) => i.word)) === JSON.stringify(["0c000000", "03e00008", "00000000"]);
    checks.mips_relocations = Boolean(ins.length && ins[0].relocations.length && ins[0].relocations[0].kind === "R_MIPS_26" && ins[0].relocations[0].symbol === "probe_external");
    const compatible = Object.values(checks).every(Boolean);
    const detail = !compatible ? (strip(result.stderr) || strip(result.stdout)) : "";
    const error = compatible ? null : (detail ? splitlines(detail).at(-1) : null);
    const out = new ObjdumpProbe({ executable: resolved, compatible, version, checks: Object.entries(checks), error: error || (compatible ? null : "capability probe failed") });
    probeCache.set(key, out);
    return out;
  } catch (e) {
    const out = new ObjdumpProbe({ executable: resolved, compatible: false, version, checks: Object.entries(checks), error: String(e?.message ?? e) });
    probeCache.set(key, out);
    return out;
  }
}

function isExecutableFile(p) {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
}

function which(name, env = process.env) {
  if (name.includes("/")) return isExecutableFile(name) ? name : null;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutableFile(p)) return p;
  }
  return null;
}

const expanduser = (p) => (p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

/** Find a capability-proven MIPS objdump, preferring an explicit path. */
export function discoverObjdump(explicit = null, { cwd = process.cwd(), env = process.env } = {}) {
  if (explicit) {
    const p = path.resolve(cwd, expanduser(explicit));
    if (isExecutableFile(p)) return fs.realpathSync(p);
    const found = which(explicit, env);
    if (found) return found;
    // romdev ships the MIPS binutils as WASM: a mips-*-objdump name runs there.
    if (!explicit.includes("/") && toolName(explicit)?.kind === "binutils") return explicit;
    throw new FileNotFoundError(`explicit objdump does not exist or is not executable: ${explicit}`);
  }
  const rejected = [];
  for (const candidate of ["tools/binutils/mips64-elf-objdump", "mips64-elf-objdump", "mips-linux-gnu-objdump", "objdump"]) {
    const p = path.resolve(cwd, candidate);
    const candidatePath = isExecutableFile(p) ? fs.realpathSync(p) : which(candidate, env);
    if (!candidatePath) continue;
    const probe = probeObjdump(candidatePath, { env });
    if (probe.compatible) return probe.executable;
    rejected.push(`${candidatePath}: ${probe.error}`);
  }
  // Nothing on the host: the WASM mips-linux-gnu-objdump romdev ships.
  if (!rejected.length) return WASM_OBJDUMP;
  const detail = rejected.length ? `; rejected incompatible tools: ${rejected.join("; ")}` : "";
  throw new FileNotFoundError("could not find a GNU-compatible MIPS objdump; install MIPS GNU binutils or pass --objdump /path/to/mips64-elf-objdump" + detail);
}

/** Parse GNU objdump `-r` lines, grouped by section offset. */
export function parseRelocations(text) {
  const grouped = new Map();
  for (const line of splitlines(text)) {
    const m = RELOCATION_RE.exec(line);
    if (!m) continue;
    const offset = parseInt(m[1], 16);
    const symbol = m[3];
    if (!grouped.has(offset)) grouped.set(offset, []);
    grouped.get(offset).push(new Relocation({ offset, kind: m[2], symbol: symbol ? strip(symbol) : null }));
  }
  return grouped;
}

/** Drop C0 control characters (except tab) and DEL from parsed objdump text. */
export function scrubControlCharacters(value) {
  return value.replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
}

function branchDestination(assembly) {
  const m = BRANCH_DESTINATION_RE.exec(assembly);
  if (!m) return null;
  if (LINKING_BRANCHES.has(m.groups.opcode)) return null;
  return m.groups.name;
}

/** Every label a conditional branch in `text` reaches. */
export function interiorLabels(text) {
  const found = new Set();
  for (const line of splitlines(text)) {
    const m = INSTRUCTION_RE.exec(line);
    if (!m) continue;
    const name = branchDestination(strip(scrubControlCharacters(m[3])));
    if (name !== null) found.add(name);
  }
  return found;
}

/**
 * Parse GNU objdump instruction lines, optionally for one symbol.
 * @param {string} text
 * @param {{symbol?: string|null, extent?: import("./elf-symbols.js").SymbolExtent|null}} [opts]
 */
export function parseDisassembly(text, { symbol = null, extent = null } = {}) {
  let matchSymbol = symbol;
  const lines = splitlines(text);
  if (symbol !== null && extent === null) {
    const names = lines.map((l) => SYMBOL_RE.exec(l)).filter(Boolean).map((m) => m.groups.name);
    if (!names.includes(symbol)) {
      const folded = names.filter((n) => casefold(n) === casefold(symbol));
      if (folded.length === 1) matchSymbol = folded[0];
    }
  }
  const relocations = parseRelocations(text);
  const reached = new Set();
  const instructions = [];
  let selected = matchSymbol === null;
  for (const line of lines) {
    const sm = SYMBOL_RE.exec(line);
    if (sm) {
      if (extent === null) {
        const name = sm.groups.name;
        selected = matchSymbol === null || name === matchSymbol || (selected && reached.has(name));
      }
      continue;
    }
    if (!selected && extent === null) continue;
    const m = INSTRUCTION_RE.exec(line);
    if (m) {
      const address = parseInt(m[1], 16);
      const assembly = strip(scrubControlCharacters(m[3]));
      if (extent === null && matchSymbol !== null) {
        const d = branchDestination(assembly);
        if (d !== null) reached.add(d);
      }
      if (extent !== null && !extent.contains(address)) continue;
      instructions.push(new Instruction({ address, word: m[2].toLowerCase(), assembly, relocations: relocations.get(address) ?? [] }));
    }
  }
  return symbol ? trimFunctionPadding(instructions) : instructions;
}

/** Every `<name>:` label in disassembly, in emission order. */
export function symbolLabels(text) {
  return splitlines(text).map((l) => SYMBOL_RE.exec(l)).filter(Boolean).map((m) => m.groups.name);
}

function nameList(names) {
  const shown = names.slice(0, SYMBOL_LIST_LIMIT);
  const remainder = names.length - shown.length;
  const joined = shown.length ? shown.join(", ") : "no symbols";
  return remainder > 0 ? `${joined}, ... (+${remainder} more)` : joined;
}

/** A warning when two dumps name one function each, and differ. */
export function crossFunctionWarning(targetText, candidateText, { symbol, section = ".text" }) {
  if (symbol !== null && symbol !== undefined) return null;
  const t = symbolLabels(targetText), c = symbolLabels(candidateText);
  if (t.length !== 1 || c.length !== 1 || t[0] === c[0]) return null;
  return `target defines ${strRepr(t[0])} but candidate defines ${strRepr(c[0])} - `
    + `comparing the whole ${section} section positionally, not one function. Pass --function to select a single symbol explicitly.`;
}

/** True when a section dump holds code but no symbol naming a function. */
export function anonymousSingleFunction(text, { section = ".text" } = {}) {
  const labels = symbolLabels(text);
  return labels.length === 1 && labels[0] === section;
}

/** Warn that `--function` was answered by a whole-section compare. */
export function strippedSymbolFallbackWarning(text, { symbol, name, section = ".text" }) {
  if (symbol === null || symbol === undefined || !anonymousSingleFunction(text, { section })) return null;
  return `${name} has no symbol for ${strRepr(symbol)} - its ${section} is one `
    + "function's worth of code with the symbol stripped, which is normal "
    + "for a decomp.me export and for an IDO static function. Comparing "
    + `the whole ${section} section positionally instead. Omit --function `
    + "to select this path explicitly.";
}

/** Select one symbol from dump text, or the whole section when it has none. */
export function parseSelectedDisassembly(text, { symbol, section = ".text" }) {
  const ins = parseDisassembly(text, { symbol });
  if (ins.length || symbol === null || symbol === undefined) return ins;
  if (!anonymousSingleFunction(text, { section })) return ins;
  return parseDisassembly(text, { symbol: null });
}

/** Every warning about what the selector actually selected. */
export function selectionWarnings(targetText, candidateText, { symbol, target_name, candidate_name, section = ".text" }) {
  return [
    strippedSymbolFallbackWarning(targetText, { symbol, name: target_name, section }),
    strippedSymbolFallbackWarning(candidateText, { symbol, name: candidate_name, section }),
    crossFunctionWarning(targetText, candidateText, { symbol, section }),
  ].filter(Boolean);
}

/** The error for a selection that matched no instructions. */
export function symbolSelectionError(symbol, { inputs, missing = [] }) {
  const empty = inputs.filter(([name, text]) => missing.includes(name) || !parseDisassembly(text, { symbol }).length);
  const listed = empty.map(([n]) => n).join(", ") || inputs.map(([n]) => n).join(", ");
  if (symbol === null || symbol === undefined) {
    return `no GNU-style objdump instruction lines in ${listed || "the inputs"}; `
      + "expected lines like `  1c: 8f998010 lw t9,-32752(gp)`. "
      + `See ${TROUBLESHOOTING_NO_INSTRUCTIONS}`;
  }
  const names = listed || "the inputs";
  const lines = [`symbol ${strRepr(symbol)} produced no instructions in ${names}.`];
  for (const [name, text] of inputs) lines.push(`  ${name} defines: ${nameList(symbolLabels(text))}`);
  if (empty.some(([, text]) => anonymousSingleFunction(text))) {
    lines.push("  That object defines no function symbols at all, so no name can select in it. Omit --function to compare the whole section positionally.");
  }
  lines.push(`  Names are case-sensitive. See ${TROUBLESHOOTING_NO_INSTRUCTIONS}`);
  return lines.join("\n");
}

/** Drop unreachable zero padding after a final `jr ra` delay slot. */
export function trimFunctionPadding(instructions) {
  let lastReturn = null;
  instructions.forEach((ins, i) => { if (/^jr\s+ra(?:\s|$)/.test(ins.assembly.replaceAll("$", ""))) lastReturn = i; });
  if (lastReturn === null || lastReturn + 2 >= instructions.length) return instructions;
  const trailing = instructions.slice(lastReturn + 2);
  if (trailing.length >= MINIMUM_ELIDED_RUN && trailing.every((i) => i.word === "00000000")) return instructions.slice(0, lastReturn + 2);
  return instructions;
}

/** The real instruction count, blind to trailing `.text` padding. */
export function trueInstructionCount(instructions) { return trimFunctionPadding([...instructions]).length; }

function runObjdump(executable, file, { section, symbol, cwd, env }) {
  const command = ["-d", "-r", "-z", "-j", section, String(file)];
  if (symbol) command.push(`--disassemble=${symbol}`);
  const r = runProgramSync([executable, ...command], { cwd, env: env ?? process.env });
  if (r.error) {
    const e = new FileNotFoundError(r.error.code === "ENOENT" ? `[Errno 2] No such file or directory: '${executable}'` : String(r.error.message));
    throw e;
  }
  return { returncode: r.status ?? -1, stdout: decoder().decode(r.stdout).replace(/\r\n?/g, "\n"), stderr: decoder().decode(r.stderr).replace(/\r\n?/g, "\n") };
}

function wholeSectionPass(executable, file, { section, symbol, extent, cwd, env }) {
  const retry = runObjdump(executable, file, { section, symbol: null, cwd, env });
  if (retry.returncode) return ["", []];
  return [retry.stdout, parseDisassembly(retry.stdout, { symbol, extent })];
}

/**
 * Disassemble an object and return [raw text, parsed instructions].
 * @param {string} file object path as given (resolved against `cwd`)
 * @param {{objdump?: string|null, symbol?: string|null, section?: string, cwd?: string, env?: object}} [opts]
 */
export function dumpObject(file, { objdump = null, symbol = null, section = ".text", cwd = process.cwd(), env = process.env } = {}) {
  const executable = discoverObjdump(objdump, { cwd, env });
  const abs = path.resolve(cwd, String(file));
  const result = runObjdump(executable, String(file), { section, symbol, cwd, env });
  if (result.returncode) throw new RuntimeError(objdumpFailure(file, result));
  const extent = symbol ? symbolExtent(abs, symbol, { section }) : null;
  const instructions = parseDisassembly(result.stdout, { symbol, extent });
  if (instructions.length) return [result.stdout, annotateLocalPc16(abs, instructions, extent)];
  let evidence = result.stdout;
  if (symbol) {
    const [sectionText, retried] = wholeSectionPass(executable, String(file), { section, symbol, extent, cwd, env });
    if (retried.length) return [sectionText, annotateLocalPc16(abs, retried, extent)];
    if (sectionText && anonymousSingleFunction(sectionText, { section })) {
      const whole = parseDisassembly(sectionText, { symbol: null });
      if (whole.length) return [sectionText, whole];
    }
    evidence = sectionText || result.stdout;
  }
  throw new RuntimeError(symbolSelectionError(symbol, { inputs: [[String(file), evidence]], missing: [String(file)] }));
}

function objdumpFailure(file, result) {
  const message = (strip(result.stderr) || strip(result.stdout)) || "no output";
  const quoted = splitlines(message).map((l) => `  ${l}`).join("\n");
  if (message.includes("file format not recognized")) {
    return `objdump failed for ${file}: this does not look like a compiled MIPS ELF object (check the path, and that the build actually produced an object file). objdump said:\n${quoted}`;
  }
  return `objdump failed for ${file}: objdump said:\n${quoted}`;
}
