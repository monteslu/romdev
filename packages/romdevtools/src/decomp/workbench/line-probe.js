// line-probe.js - does statement line assignment own a schedule residue?
// Three deterministic variants are compiled from one preprocessed `.i`:
// baseline (untouched), split-statements (a token-identical reflow: a
// newline after each `;` at brace depth >= 1 on overlong lines, outside
// literals, comments and for(;;) headers) and global-shift (blank lines
// prepended, a control that must never move the object). An optional `tie`
// variant reassigns single statements' line numbers with `#line` pairs. The
// comparison is over raw 4-byte instruction words of `.text` (or one
// function's byte range), read with a minimal ELF reader.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ValueError, sorted, strip, strRepr, splitlines, osErrorText } from "./py.js";
import { DEFAULT_STREAM_LIMIT, captureStreams } from "./artifacts.js";
import { CompilerTimeoutError, runCompiler } from "./campaign.js";
import { displayPath } from "./model.js";
import { renderPassCommand } from "./pass-adapter.js";

export const LINE_PROBE_SCHEMA = "decomp-workbench-line-probe-v1";
export const DEFAULT_SPLIT_THRESHOLD = 400;
export const DEFAULT_SHIFT_LINES = 20;
export const DEFAULT_WORK_DIR = ".decomp-workbench/probe-lines";
export const VARIANT_NAMES = Object.freeze(["baseline", "split-statements", "global-shift"]);
export const VARIANT_DESCRIPTIONS = Object.freeze({
  baseline: "untouched preprocessed source",
  "split-statements": "on physical lines longer than --split-threshold, insert a newline after each ';' at brace-depth>=1, outside strings/char literals/"
    + "comments, and outside a for(;;) header - token-identical",
  "global-shift": "insert --shift-lines blank lines at the top (control: must never change the compiled object)",
  tie: "wrap each --tie STATEMENT=LINE statement in a '#line LINE' / restore pair, reassigning only that statement's line number - token-identical",
});
export const PREPROCESSED_INPUT_HELP = "a preprocessed C translation unit ('cc -E unit.c > unit.i', or what an "
  + "IDO-style driver retains alongside its normal compile with -K)";

const STT_FUNC = 2;

/** A user-facing line-probe failure that must never show a traceback. */
export class LineProbeError extends ValueError { constructor(message) { super(message); this.name = "ValueError"; } }
/** The compiled artifact could not be read as an ELF object. */
export class ElfFormatError extends LineProbeError {}

/** str.splitlines(keepends=True). */
function splitlinesKeep(text) {
  const out = [];
  const re = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) { out.push(text.slice(last, m.index + m[0].length)); last = m.index + m[0].length; }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isAlnum = (c) => /^[\p{L}\p{N}]$/u.test(c);
const isSpace = (c) => strip(c) === "";

/** Prepend `blank_lines` blank lines: a pure line-number relabeling. */
export function globalShift(text, { blank_lines = DEFAULT_SHIFT_LINES } = {}) {
  if (blank_lines < 0) throw new LineProbeError("--shift-lines must be non-negative");
  return "\n".repeat(blank_lines) + text;
}

/** Insert a newline after each qualifying `;` on an overlong line. */
export function splitStatementLines(text, { threshold = DEFAULT_SPLIT_THRESHOLD } = {}) {
  if (threshold <= 0) throw new LineProbeError("--split-threshold must be positive");
  let braceDepth = 0, word = "", inString = false, inChar = false, inBlock = false;
  const parenStack = [];
  const outLines = [];
  for (const line of splitlinesKeep(text)) {
    let bare = line;
    if (bare.endsWith("\n")) bare = bare.slice(0, -1);
    while (bare.endsWith("\n")) bare = bare.slice(0, -1);
    while (bare.endsWith("\r")) bare = bare.slice(0, -1);
    const eligible = [...bare].length > threshold;
    let inLine = false;
    const buffer = [];
    const chars = [...line];
    let i = 0;
    while (i < chars.length) {
      const c = chars[i], n = i + 1 < chars.length ? chars[i + 1] : "";
      if (inBlock) {
        buffer.push(c);
        if (c === "*" && n === "/") { buffer.push(n); i += 2; inBlock = false; continue; }
        i += 1; continue;
      }
      if (inLine) { buffer.push(c); i += 1; continue; }
      if (inString) {
        buffer.push(c);
        if (c === "\\" && n) { buffer.push(n); i += 2; continue; }
        if (c === '"') inString = false;
        i += 1; continue;
      }
      if (inChar) {
        buffer.push(c);
        if (c === "\\" && n) { buffer.push(n); i += 2; continue; }
        if (c === "'") inChar = false;
        i += 1; continue;
      }
      if (c === "/" && n === "*") { inBlock = true; buffer.push(c); word = ""; i += 1; continue; }
      if (c === "/" && n === "/") { inLine = true; buffer.push(c); word = ""; i += 1; continue; }
      if (c === '"') { inString = true; buffer.push(c); word = ""; i += 1; continue; }
      if (c === "'") { inChar = true; buffer.push(c); word = ""; i += 1; continue; }
      if (isAlnum(c) || c === "_") { word += c; buffer.push(c); i += 1; continue; }
      if (c === "(") { parenStack.push(word === "for"); buffer.push(c); word = ""; i += 1; continue; }
      if (c === ")") { if (parenStack.length) parenStack.pop(); buffer.push(c); word = ""; i += 1; continue; }
      if (c === "{") { braceDepth += 1; buffer.push(c); word = ""; i += 1; continue; }
      if (c === "}") { braceDepth = Math.max(0, braceDepth - 1); buffer.push(c); word = ""; i += 1; continue; }
      if (c === ";") {
        buffer.push(c);
        word = "";
        const inFor = parenStack.length > 0 && parenStack[parenStack.length - 1];
        if (eligible && braceDepth >= 1 && !inFor) buffer.push("\n");
        i += 1; continue;
      }
      if (!isSpace(c)) word = "";
      buffer.push(c);
      i += 1;
    }
    outLines.push(buffer.join(""));
  }
  return outLines.join("");
}

/** Reassign each tied statement's line number via a `#line` pair. */
export function tieStatementLines(text, ties) {
  const lines = splitlinesKeep(text);
  const seen = new Map();
  for (const [statement, assigned] of ties) {
    if (assigned < 1) throw new LineProbeError(`--tie ${statement}=${assigned}: the assigned line number must be 1 or greater`);
    if (statement < 1 || statement > lines.length) throw new LineProbeError(`--tie ${statement}=${assigned}: statement line ${statement} is outside the 1..${lines.length} input range`);
    if (seen.has(statement)) {
      throw new LineProbeError(`--tie lists statement line ${statement} twice (=${seen.get(statement)} and =${assigned}); one statement can only be tied to one line number`);
    }
    seen.set(statement, assigned);
    const stripped = strip(lines[statement - 1]);
    if (!stripped || stripped.startsWith("#")) {
      const what = !stripped ? "blank" : "a preprocessing directive";
      throw new LineProbeError(`--tie ${statement}=${assigned}: input line ${statement} is ${what}, so it carries no statement to reassign; tie the line the statement starts on`);
    }
  }
  const out = [];
  lines.forEach((line, i) => {
    const index = i + 1;
    const assigned = seen.get(index);
    if (assigned === undefined) { out.push(line); return; }
    if (!line.endsWith("\n")) line += "\n";
    out.push(`#line ${assigned}\n`, line, `#line ${index + 1}\n`);
  });
  return out.join("");
}

/** The deterministic variant source texts, baseline first. */
export function generateVariants(text, { split_threshold = DEFAULT_SPLIT_THRESHOLD, shift_lines = DEFAULT_SHIFT_LINES, ties = null } = {}) {
  const variants = { baseline: text, "split-statements": splitStatementLines(text, { threshold: split_threshold }),
    "global-shift": globalShift(text, { blank_lines: shift_lines }) };
  if (ties && ties.length) variants.tie = tieStatementLines(text, ties);
  return variants;
}

/** One variant's compile command, outcome, and retained evidence. */
export class VariantCompile {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  get compiled() { return this.returncode === 0 && this.object_path !== null; }
}

/** Write one variant's source, compile it, and retain every stream. */
export async function compileVariant(name, sourceText, { run_dir, compile_template, compile_cwd, environment, timeout, stream_limit, artifact_dir }) {
  const variantDir = path.join(run_dir, name);
  fs.mkdirSync(variantDir, { recursive: true });
  const sourcePath = path.join(variantDir, "variant.i");
  fs.writeFileSync(sourcePath, sourceText, "utf8");
  const objectPath = path.join(variantDir, "variant.o");
  const command = renderPassCommand(compile_template, { input_path: sourcePath, output_path: objectPath, work_path: variantDir });
  const started = performance.now();
  let returncode, stdout, stderr;
  try {
    const p = await runCompiler(command, { environment, compile_cwd, timeout });
    ({ returncode, stdout, stderr } = p);
  } catch (e) {
    if (!(e instanceof CompilerTimeoutError)) throw e;
    returncode = 124;
    stdout = e.stdout;
    stderr = strip(`${e.stderr}\n${e.message}`);
  }
  const duration = (performance.now() - started) / 1000;
  const stdoutPath = path.join(variantDir, "compile.stdout.txt"), stderrPath = path.join(variantDir, "compile.stderr.txt");
  fs.writeFileSync(stdoutPath, stdout, "utf8");
  fs.writeFileSync(stderrPath, stderr, "utf8");
  const streams = captureStreams(stdout, stderr, { limit: stream_limit, artifact_dir, stem: name });
  let isFile = false;
  try { isFile = fs.statSync(objectPath).isFile(); } catch { isFile = false; }
  const compiled = returncode === 0 && isFile;
  return new VariantCompile({ name, command, source_path: sourcePath, object_path: compiled ? objectPath : null, returncode, duration_seconds: duration,
    stdout_preview: streams.stdout, stderr_preview: streams.stderr, stdout_path: stdoutPath, stderr_path: stderrPath });
}

/** The compared byte range: its words and a human-readable provenance. */
export class ObjectWindow {
  constructor({ words, source, byte_length }) { Object.assign(this, { words, source, byte_length }); Object.freeze(this); }
}

function cstr(blob, offset) {
  if (offset >= blob.length) return "";
  let end = blob.indexOf(0, offset);
  if (end < 0) end = blob.length;
  return new TextDecoder("utf-8", { fatal: false }).decode(blob.subarray(offset, end));
}

/** Split bytes into 4-byte words (hex strings); a short tail is kept. */
function chunkWords(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 4) out.push(Buffer.from(data.subarray(i, i + 4)).toString("hex"));
  return out;
}

function parseElfSections(data) {
  if (data.length < 20 || data.subarray(0, 4).toString("latin1") !== "\x7fELF") {
    throw new ElfFormatError("does not look like an ELF object (missing 0x7f 'ELF' magic); the compile command must produce a real relocatable object for word-level comparison");
  }
  const eiClass = data[4], eiData = data[5];
  if (eiClass !== 1 && eiClass !== 2) throw new ElfFormatError(`unsupported ELF class byte ${eiClass}`);
  if (eiData !== 1 && eiData !== 2) throw new ElfFormatError(`unsupported ELF data-encoding byte ${eiData}`);
  const le = eiData === 1, is64 = eiClass === 2;
  const u16 = (o) => (le ? data.readUInt16LE(o) : data.readUInt16BE(o));
  const u32 = (o) => (le ? data.readUInt32LE(o) : data.readUInt32BE(o));
  const u64 = (o) => Number(le ? data.readBigUInt64LE(o) : data.readBigUInt64BE(o));
  const headerSize = is64 ? 48 : 36;
  if (data.length < 16 + headerSize) throw new ElfFormatError("truncated ELF header");
  let shoff, shentsize, shnum, shstrndx;
  if (is64) { shoff = u64(16 + 24); shentsize = u16(16 + 42); shnum = u16(16 + 44); shstrndx = u16(16 + 46); }
  else { shoff = u32(16 + 16); shentsize = u16(16 + 30); shnum = u16(16 + 32); shstrndx = u16(16 + 34); }
  if (shoff === 0 || shnum === 0) throw new ElfFormatError("object has no section-header table (stripped, or not a relocatable/linked object)");
  const sectionSize = is64 ? 64 : 40;
  const raw = [];
  for (let index = 0; index < shnum; index++) {
    const o = shoff + index * shentsize;
    if (o + sectionSize > data.length) throw new ElfFormatError("truncated ELF section-header table");
    if (is64) raw.push([u32(o), u32(o + 4), u64(o + 16), u64(o + 24), u64(o + 32), u32(o + 40)]);
    else raw.push([u32(o), u32(o + 4), u32(o + 12), u32(o + 16), u32(o + 20), u32(o + 24)]);
  }
  if (shstrndx >= raw.length) throw new ElfFormatError("invalid section-name string table index");
  const [, , , shstrOffset, shstrSize] = raw[shstrndx];
  if (shstrOffset + shstrSize > data.length) throw new ElfFormatError("truncated section-name string table");
  const shstrtab = data.subarray(shstrOffset, shstrOffset + shstrSize);
  const sections = raw.map(([name, kind, addr, offset, size, link], index) => ({ index, name: cstr(shstrtab, name), kind, addr, offset, size, link }));
  return { le, is64, sections, u16, u32, u64 };
}

function parseSymbols(data, { le, is64, symtab, sections }) {
  if (symtab.link >= sections.length) throw new ElfFormatError("symbol table's linked string-table index is out of range");
  const strtab = sections[symtab.link];
  if (strtab.offset + strtab.size > data.length) throw new ElfFormatError("truncated symbol string table");
  const blob = data.subarray(strtab.offset, strtab.offset + strtab.size);
  const entry = is64 ? 24 : 16;
  const count = Math.floor(symtab.size / entry);
  const u16 = (o) => (le ? data.readUInt16LE(o) : data.readUInt16BE(o));
  const u32 = (o) => (le ? data.readUInt32LE(o) : data.readUInt32BE(o));
  const u64 = (o) => Number(le ? data.readBigUInt64LE(o) : data.readBigUInt64BE(o));
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = symtab.offset + i * entry;
    if (o + entry > data.length) throw new ElfFormatError("truncated symbol table entry");
    if (is64) out.push({ name: cstr(blob, u32(o)), info: data[o + 4], shndx: u16(o + 6), value: u64(o + 8), size: u64(o + 16) });
    else out.push({ name: cstr(blob, u32(o)), value: u32(o + 4), size: u32(o + 8), info: data[o + 12], shndx: u16(o + 14) });
  }
  return out;
}

/** The compared window: whole `.text`, or one symbol's range. */
export function extractTextWindow(objectPath, { function: fn = null } = {}) {
  let data;
  try { data = fs.readFileSync(objectPath); } catch (e) {
    throw new LineProbeError(`could not read compiled object ${objectPath}: ${osErrorText(e)}`);
  }
  let parsed;
  try { parsed = parseElfSections(data); } catch (e) {
    if (e instanceof ElfFormatError) throw new ElfFormatError(`${objectPath}: ${e.message}`);
    throw e;
  }
  const byName = new Map();
  for (const s of parsed.sections) if (s.name) byName.set(s.name, s);
  const text = byName.get(".text");
  if (!text) throw new ElfFormatError(`${objectPath}: object has no .text section (sections present: ${sorted([...byName.keys()]).join(", ") || "none"})`);
  const textBytes = data.subarray(text.offset, text.offset + text.size);
  if (fn === null) return new ObjectWindow({ words: chunkWords(textBytes), source: `.text (whole section, ${textBytes.length} byte(s))`, byte_length: textBytes.length });
  const symtab = byName.get(".symtab");
  const omit = "Omit --function for whole-.text mode: IDO commonly strips, or never emits, symbol-table entries for static functions.";
  if (!symtab) throw new ElfFormatError(`${objectPath}: object has no .symtab section, so --function ${strRepr(fn)} cannot be windowed. ${omit}`);
  const symbols = parseSymbols(data, { le: parsed.le, is64: parsed.is64, symtab, sections: parsed.sections });
  const matches = symbols.filter((s) => s.name === fn);
  if (!matches.length) {
    const names = sorted([...new Set(symbols.filter((s) => s.name && (s.info & 0xF) === STT_FUNC).map((s) => s.name))]);
    const shown = names.slice(0, 20).join(", ") + (names.length > 20 ? ", ..." : "");
    throw new ElfFormatError(`${objectPath}: no symbol named ${strRepr(fn)} in the object's symbol table${shown ? ` (function symbols present: ${shown})` : ""}. ${omit}`);
  }
  const symbol = matches[0];
  if (symbol.shndx !== text.index) {
    throw new ElfFormatError(`${objectPath}: symbol ${strRepr(fn)} is not defined in .text (its section index is ${symbol.shndx}); pass a function known to be in .text, or omit --function for whole-.text mode`);
  }
  if (symbol.size === 0) {
    throw new ElfFormatError(`${objectPath}: symbol ${strRepr(fn)} has size 0 in the symbol table (no ELF size recorded - common for assembly-defined or size-stripped symbols). Omit --function for whole-.text mode.`);
  }
  const start = symbol.value - text.addr, end = start + symbol.size;
  if (start < 0 || end > textBytes.length) {
    throw new ElfFormatError(`${objectPath}: symbol ${strRepr(fn)} (value=0x${symbol.value.toString(16)} size=${symbol.size}) falls outside the .text section's bounds; the object may not match the compile command that produced it`);
  }
  const window = textBytes.subarray(start, end);
  return new ObjectWindow({ words: chunkWords(window), source: `.text[${fn}] (${symbol.size} byte(s) at +0x${start.toString(16)})`, byte_length: window.length });
}

/** Count positions (including any length difference) that differ. */
export function wordDiffPositions(left, right) {
  let n = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) if ((left[i] ?? null) !== (right[i] ?? null)) n++;
  return n;
}

/** The toward/away/unchanged partition against a target window. */
export function scoreAgainstTarget(variant, baseline, target) {
  const total = Math.max(variant.length, baseline.length, target.length);
  const mism = (a) => { const s = new Set(); for (let i = 0; i < Math.max(a.length, target.length); i++) if ((a[i] ?? null) !== (target[i] ?? null)) s.add(i); return s; };
  const bm = mism(baseline), vm = mism(variant);
  const toward = [...bm].filter((i) => !vm.has(i)).length, away = [...vm].filter((i) => !bm.has(i)).length;
  return { toward, away, unchanged: total - toward - away, total_positions: total, mismatched_vs_target: vm.size };
}

const expand = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** An OSError whose message is the whole report (FileNotFoundError(msg)). */
export class ProbeOSError extends Error { constructor(message) { super(message); this.name = "OSError"; } }
const notFound = (message) => new ProbeOSError(message);

function loadTargetWords({ target_bytes, target_offset, target_object, fn }) {
  if (target_bytes !== null) {
    const p = path.resolve(expand(target_bytes));
    if (!isFile(p)) throw notFound(`--target-bytes does not exist: ${p}`);
    const data = fs.readFileSync(p);
    if (target_offset < 0 || target_offset > data.length) throw new LineProbeError(`--target-offset ${target_offset} is out of range for ${p} (${data.length} byte(s))`);
    return chunkWords(data.subarray(target_offset));
  }
  const p = path.resolve(expand(target_object));
  if (!isFile(p)) throw notFound(`--target-object does not exist: ${p}`);
  return extractTextWindow(p, { function: fn }).words;
}

export const VERDICT_LINE_SENSITIVE = "line-sensitive";
export const VERDICT_NOT_LINE_SENSITIVE = "not-line-sensitive";
export const VERDICT_NONDETERMINISTIC = "nondeterministic";

/** The verdict name and its human-readable message. */
export function classifyVerdict(splitDiff, shiftDiff, { shift_lines }) {
  if (shiftDiff) {
    return [VERDICT_NONDETERMINISTIC, "NONDETERMINISTIC COMPILE: global-shift "
      + `(${shift_lines} blank line(s) prepended - a pure line-number relabeling with no statement regrouping) must never change the `
      + `compiled object, but ${shiftDiff} word(s) differ from baseline. Every other verdict from this probe is untrustworthy `
      + "until the compile command is made deterministic under trivial padding (check embedded timestamps, random seeds, "
      + "uninitialized padding bytes, or absolute paths/line numbers baked into the object)."];
  }
  if (splitDiff) {
    return [VERDICT_LINE_SENSITIVE, "LINE-SENSITIVE: statement line assignment participates in scheduling. next: field-guide lever 23 (preprocessor line "
      + "assignment) \u2014 follow the copyable acpp recipe in docs/line-assignment-probe.md with this translation unit's "
      + "exact defines, include paths, and compiler flags"];
  }
  return [VERDICT_NOT_LINE_SENSITIVE, "NOT line-sensitive under this reflow; the schedule residue is owned elsewhere (compiler binary, flags, or instruction selection)."];
}

/** The routing lines a verdict owes its reader. */
export function nextSteps(verdict, { ties = [], target = null } = {}) {
  if (verdict === VERDICT_NONDETERMINISTIC) return [];
  if (verdict === VERDICT_NOT_LINE_SENSITIVE) {
    return ["this rules preprocessor line assignment out for this input only; stay on the compiler/flags branch: decomp-workbench guide g0-schedule-probe"];
  }
  if (!ties.length) {
    const steps = ["retarget one statement: re-run with --tie STATEMENT=LINE (e.g. --tie 83=88, repeatable) to compile a token-identical fourth "
      + "variant that gives just that statement the line number you think it needs - usually its target-order neighbor's."];
    if (target === null) {
      steps.push("add --target-object/--target-bytes so the tie is scored toward and away from the target; a word diff against baseline says it moved, not that it moved the right way.");
    }
    return steps;
  }
  const score = (target ?? {}).tie;
  if (!score) return ["the tie compiled, but nothing scored it: add --target-object or --target-bytes to see whether it moved toward the target."];
  const { toward, away } = score;
  if (toward > away) {
    return [`the tie moved ${toward} site(s) toward the target and ${away} away: line assignment owns those statements. Now hunt the `
      + "natural spelling that carries the same assignment - decomp-workbench guide 25 (logical-line splices) - because a "
      + "#line pair is a probe, not a publishable decompilation."];
  }
  return [`the tie moved ${toward} site(s) toward the target and ${away} away: this assignment is not the one. Try another line for the same `
    + "statement, or another statement; the plateau you measure is scoped to the statement order you swept."];
}

function variantPayload(c, w) {
  return { name: c.name, description: VARIANT_DESCRIPTIONS[c.name], command: c.command, source_path: c.source_path, object_path: c.object_path,
    returncode: c.returncode, duration_seconds: c.duration_seconds, window: w.source, word_count: w.words.length, stdout_path: c.stdout_path,
    stderr_path: c.stderr_path, stdout: c.stdout_preview, stderr: c.stderr_preview };
}

/** Compile the deterministic variants and report the verdict. */
export async function runLineProbe(inputPath, { compile_template, function: fn = null, split_threshold = DEFAULT_SPLIT_THRESHOLD, shift_lines = DEFAULT_SHIFT_LINES,
  work_dir = DEFAULT_WORK_DIR, compile_cwd = null, environment = null, timeout = 120.0, stream_limit = DEFAULT_STREAM_LIMIT, artifact_dir = null,
  target_bytes = null, target_offset = 0, target_object = null, ties = null, cwd = process.cwd() }) {
  if (target_bytes !== null && target_object !== null) throw new LineProbeError("--target-bytes and --target-object are mutually exclusive");
  if (target_offset && target_bytes === null) throw new LineProbeError("--target-offset requires --target-bytes");
  if (timeout <= 0) throw new LineProbeError("--timeout must be positive");
  const source = path.resolve(cwd, expand(inputPath));
  if (!isFile(source)) throw notFound(`preprocessed input does not exist: ${source}; expected ${PREPROCESSED_INPUT_HELP}`);
  const text = fs.readFileSync(source, "utf8");
  const compileDir = compile_cwd ? path.resolve(cwd, expand(compile_cwd)) : path.resolve(cwd);
  let isDir = false;
  try { isDir = fs.statSync(compileDir).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new ProbeOSError(`compile working directory does not exist: ${compileDir}`);
  const root = path.resolve(cwd, expand(work_dir));
  fs.mkdirSync(root, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(root, "probe-lines-"));
  const sources = generateVariants(text, { split_threshold, shift_lines, ties });
  const names = Object.keys(sources);
  const compiled = {};
  for (const name of names) {
    const result = await compileVariant(name, sources[name], { run_dir: runDir, compile_template, compile_cwd: compileDir, environment: environment ?? {},
      timeout, stream_limit, artifact_dir });
    compiled[name] = result;
    if (!result.compiled) {
      const lines = splitlines(strip(result.stderr_preview));
      const detail = lines.length ? lines[lines.length - 1] : "no diagnostic";
      throw Object.assign(new Error(`${name} variant failed to compile (exit ${result.returncode}): ${detail}\nfull stderr: ${result.stderr_path}\nrun directory (not cleaned up): ${runDir}`), { name: "RuntimeError" });
    }
  }
  const windows = {};
  for (const name of names) {
    try { windows[name] = extractTextWindow(compiled[name].object_path, { function: fn }); } catch (e) {
      if (e instanceof ElfFormatError) throw new ElfFormatError(`${name} variant: ${e.message}\nrun directory (not cleaned up): ${runDir}`);
      throw e;
    }
  }
  const base = windows.baseline.words;
  const splitDiff = wordDiffPositions(base, windows["split-statements"].words);
  const shiftDiff = wordDiffPositions(base, windows["global-shift"].words);
  const tieDiff = windows.tie ? wordDiffPositions(base, windows.tie.words) : null;
  const [verdict, message] = classifyVerdict(splitDiff, shiftDiff, { shift_lines });
  let targetReport = null;
  if (target_bytes !== null || target_object !== null) {
    const targetWords = loadTargetWords({ target_bytes: target_bytes === null ? null : path.resolve(cwd, expand(target_bytes)), target_offset,
      target_object: target_object === null ? null : path.resolve(cwd, expand(target_object)), fn });
    targetReport = Object.fromEntries(names.map((n) => [n, scoreAgainstTarget(windows[n].words, base, targetWords)]));
  }
  return {
    schema: LINE_PROBE_SCHEMA, input: displayPath(source, cwd), function: fn, split_threshold, shift_lines,
    ties: (ties ?? []).map(([s, a]) => [s, a]), run_directory: runDir,
    variants: Object.fromEntries(names.map((n) => [n, variantPayload(compiled[n], windows[n])])),
    split_word_diff: splitDiff, shift_word_diff: shiftDiff, tie_word_diff: tieDiff, verdict, message,
    next_steps: nextSteps(verdict, { ties: ties ?? [], target: targetReport }), target: targetReport,
  };
}
