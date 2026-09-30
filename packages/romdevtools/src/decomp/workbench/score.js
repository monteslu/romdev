// score.js - score one candidate function's bytes against ROM or object
// ground truth: one number, computed the same way every time. Windowing goes
// through the symbol table, or (for a local function IDO stripped from the
// table) through the two visible neighbours around it, never a hardcoded
// offset. `score` and `matrix` both call scoreReport.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { createHash } from "node:crypto";
import { displayPath } from "./model.js";
import { dumpObject } from "./objdump.js";
import { ValueError, splitlines, sorted, strRepr, hex, pyInt } from "./py.js";

export const BETWEEN_RATIONALE = "IDO strips local (static) function symbols from the object's symbol "
  + "table, so --function cannot find them; --between locates the bytes "
  + "between two surrounding symbols IDO did keep.";

const LABEL_ADDRESS_RE = /^(?<addr>[0-9a-fA-F]+)\s+<(?<name>[^>]+)>:\s*$/;

export class ScoreError extends ValueError {}

const hexp = (n) => hex(n, 0, { prefix: true });
const isRuntime = (e) => e?.name === "RuntimeError";

/** Every `<name>:` label in a whole-section dump, with its address. */
export function labelAddresses(text) {
  const out = new Map();
  for (const line of splitlines(text)) { const m = LABEL_ADDRESS_RE.exec(line); if (m) out.set(m.groups.name, parseInt(m.groups.addr, 16)); }
  return out;
}

export class Window {
  constructor({ label, instructions, mode, note = null }) { Object.assign(this, { label, instructions, mode, note }); Object.freeze(this); }
  get words() { return this.instructions.map((i) => i.word); }
  get size() { return this.instructions.length * 4; }
}

/** Window one function's instructions by its symbol-table entry. */
export function windowBySymbol(p, { objdump, symbol, section = ".text", label = null, cwd = process.cwd(), env = process.env }) {
  let instructions;
  try { [, instructions] = dumpObject(p, { objdump, symbol, section, cwd, env }); }
  catch (e) {
    if (!isRuntime(e)) throw e;
    throw new ScoreError(`${e.message}\n  If ${strRepr(symbol)} is a local/static function, IDO may have stripped its symbol from the table -- try --between with the two symbols that surround it.`);
  }
  return new Window({ label: label || symbol, instructions: [...instructions], mode: "function" });
}

/** Window the bytes between the end of one symbol and the start of another. */
export function windowBetween(p, { objdump, start_symbol, end_symbol, section = ".text", label = null, cwd = process.cwd(), env = process.env }) {
  const [text, instructions] = dumpObject(p, { objdump, symbol: null, section, cwd, env });
  const addresses = labelAddresses(text);
  if (!addresses.has(end_symbol)) {
    const defined = sorted([...addresses.keys()]).join(", ") || "no symbols";
    throw new ScoreError(`--between end symbol ${strRepr(end_symbol)} was not found in ${displayPath(p, cwd)}; it defines: ${defined}`);
  }
  let start;
  try { [, start] = dumpObject(p, { objdump, symbol: start_symbol, section, cwd, env }); }
  catch (e) {
    if (!isRuntime(e)) throw e;
    throw new ScoreError(`--between start symbol ${strRepr(start_symbol)} could not be disassembled in ${displayPath(p, cwd)}: ${e.message}`);
  }
  if (!start.length) throw new ScoreError(`--between start symbol ${strRepr(start_symbol)} produced no instructions in ${displayPath(p, cwd)}`);
  const startAddress = start[start.length - 1].address + 4;
  const endAddress = addresses.get(end_symbol);
  if (endAddress <= startAddress) {
    throw new ScoreError(`--between ${start_symbol},${end_symbol} is empty or reversed in ${displayPath(p, cwd)} (end 0x${hex(endAddress)} <= start 0x${hex(startAddress)}); check the symbol order and that both symbols belong to the same section`);
  }
  const windowed = instructions.filter((i) => startAddress <= i.address && i.address < endAddress);
  if (!windowed.length) throw new ScoreError(`--between ${start_symbol},${end_symbol} covered no instructions in ${displayPath(p, cwd)}`);
  return new Window({ label: label || `${start_symbol}..${end_symbol}`, instructions: windowed, mode: "between", note: BETWEEN_RATIONALE });
}

/** Read `size` raw bytes at `offset` from a local ROM/binary file. */
export function readRomWindow(p, { offset, size, cwd = process.cwd() }) {
  const abs = p.startsWith("/") ? p : `${cwd}/${p}`;
  let stat = null;
  try { stat = fs.statSync(abs); } catch {}
  if (!stat || !stat.isFile()) throw new ScoreError(`ROM file does not exist: ${displayPath(p, cwd)} (check --rom)`);
  if (offset < 0) throw new ScoreError(`--rom-offset must not be negative: ${hexp(offset)}`);
  if (size <= 0) throw new ScoreError(`--size must be positive: ${size}`);
  const data = fs.readFileSync(abs);
  if (offset >= data.length) throw new ScoreError(`--rom-offset ${hexp(offset)} is past the end of ${displayPath(p, cwd)} (${data.length} byte(s)); check the offset and that this is the right ROM revision`);
  const end = offset + size;
  if (end > data.length) throw new ScoreError(`--rom-offset ${hexp(offset)} + size ${size} reaches past the end of ${displayPath(p, cwd)} (${data.length} byte(s)); the ROM may be the wrong revision, or the offset/size is wrong`);
  const window = data.subarray(offset, end);
  if (window.length % 4) throw new ScoreError(`ROM window at ${hexp(offset)} is ${window.length} byte(s), which is not a multiple of 4; check --size`);
  return window;
}

/** Split raw big-endian bytes into 32-bit hex words. */
export function wordsFromBytes(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 4) out.push(Buffer.from(data.subarray(i, i + 4)).toString("hex"));
  return out;
}

export class WordScore {
  constructor(f) { Object.assign(this, f); Object.freeze(this); }
  asDict() {
    return { label: this.label, mode: this.mode, note: this.note, candidate_size: this.candidate_size, target_size: this.target_size,
      diff_words: this.diff_words, relocation_floor: this.relocation_floor, diff_positions: [...this.diff_positions],
      candidate_sha256: this.candidate_sha256, matched: this.matched };
  }
  get summary() {
    const plural = this.relocation_floor === 1 ? "" : "s";
    return `size ${this.candidate_size}/${this.target_size}, diff words ${this.diff_words} (+${this.relocation_floor} relocation-floor word${plural})`;
  }
}

/** Score one window against target words, masking relocation words. */
export function scoreWindow(window, targetWords) {
  const cw = window.words;
  const reloc = new Set();
  window.instructions.forEach((item, i) => { if (item.relocations.length) reloc.add(i); });
  const total = Math.max(cw.length, targetWords.length);
  let diff = 0, floor = 0;
  const positions = [];
  for (let i = 0; i < total; i++) {
    const c = i < cw.length ? cw[i] : null, t = i < targetWords.length ? targetWords[i] : null;
    if (reloc.has(i) && c !== null && t !== null) { floor++; continue; }
    if (c !== t) { diff++; positions.push(i); }
  }
  return new WordScore({ label: window.label, mode: window.mode, note: window.note, candidate_size: cw.length * 4, target_size: targetWords.length * 4,
    diff_words: diff, relocation_floor: floor, diff_positions: positions,
    candidate_sha256: createHash("sha256").update(Buffer.from(cw.join(""), "ascii")).digest("hex"), matched: diff === 0 });
}

export class ControlSpec {
  constructor({ name, offset = null, size = null }) { Object.assign(this, { name, offset, size }); Object.freeze(this); }
}

const CONTROL_RE = /^(?<name>[^@]+?)(?:@(?<offset>0[xX][0-9a-fA-F]+|\d+)(?::(?<size>\d+))?)?$/;

/** Parse `NAME`, `NAME@0xOFFSET`, or `NAME@0xOFFSET:SIZE`. */
export function parseControlSpec(text) {
  const m = CONTROL_RE.exec(text.trim());
  if (!m || !m.groups.name) throw new ScoreError(`invalid --control ${strRepr(text)}; expected NAME, NAME@0xOFFSET, or NAME@0xOFFSET:SIZE`);
  return new ControlSpec({ name: m.groups.name, offset: m.groups.offset ? pyInt(m.groups.offset, 0) : null, size: m.groups.size ? parseInt(m.groups.size, 10) : null });
}

export class TargetSpec {
  constructor({ kind, rom = null, rom_offset = null, size = null, target_object = null }) { Object.assign(this, { kind, rom, rom_offset, size, target_object }); Object.freeze(this); }
}

export class ScoreSpec {
  constructor({ target, function: fn, between, controls = [], objdump = null, section = ".text" }) {
    Object.assign(this, { target, function: fn, between, controls, objdump, section }); Object.freeze(this);
  }
}

/** Build a ScoreSpec from a matrix JSON spec's "score" object. */
export function scoreSpecFromDict(data) {
  const fn = data.function;
  const betweenRaw = data.between;
  let between = null;
  if (betweenRaw !== undefined && betweenRaw !== null) {
    if (!(Array.isArray(betweenRaw) && betweenRaw.length === 2)) throw new ScoreError("'between' in the matrix spec must be a two-item array [start_symbol, end_symbol]");
    between = [String(betweenRaw[0]), String(betweenRaw[1])];
  }
  if (Boolean(fn) === Boolean(between)) throw new ScoreError("the matrix spec's 'score' object needs exactly one of 'function' or 'between'");
  const targetObject = data.target_object, rom = data.rom;
  if (Boolean(targetObject) === Boolean(rom)) throw new ScoreError("the matrix spec's 'score' object needs exactly one of 'target_object' or 'rom'");
  let target;
  if (rom) {
    const raw = data.rom_offset;
    if (raw === undefined || raw === null) throw new ScoreError("'rom' in the matrix spec requires 'rom_offset'");
    const romOffset = Number.isInteger(raw) ? raw : pyInt(String(raw), 0);
    target = new TargetSpec({ kind: "rom", rom: String(rom), rom_offset: romOffset, size: data.size ?? null });
  } else target = new TargetSpec({ kind: "object", target_object: String(targetObject) });
  const controls = (data.controls ?? []).map((c) => parseControlSpec(String(c)));
  return new ScoreSpec({ target, function: fn ? String(fn) : null, between, controls, objdump: data.objdump ?? null, section: data.section ?? ".text" });
}

export class ScoreReport {
  constructor(f) { Object.assign(this, { guidance: [], screen: null, ...f }); Object.freeze(this); }
  asDict() {
    return { candidate: this.candidate, target: this.target_description, function: this.function.asDict(), controls: this.controls.map((c) => c.asDict()),
      controls_broken: this.controls_broken, matched: this.matched, guidance: this.guidance, screen: this.screen };
  }
}

export function resolveCandidateWindow(candidatePath, spec, io = {}) {
  if (spec.function) return windowBySymbol(candidatePath, { objdump: spec.objdump, symbol: spec.function, section: spec.section, ...io });
  if (spec.between === null) throw new ScoreError("score spec needs exactly one of --function or --between");
  const [start, end] = spec.between;
  return windowBetween(candidatePath, { objdump: spec.objdump, start_symbol: start, end_symbol: end, section: spec.section, ...io });
}

function resolveTargetWords(spec, window, io) {
  const cwd = io.cwd ?? process.cwd();
  if (spec.target.kind === "rom") {
    if (!spec.target.rom || spec.target.rom_offset === null) throw new ScoreError("--rom requires --rom-offset");
    const size = spec.target.size || window.size;
    const data = readRomWindow(spec.target.rom, { offset: spec.target.rom_offset, size, cwd });
    return [wordsFromBytes(data), `--rom ${displayPath(spec.target.rom, cwd)} offset ${hexp(spec.target.rom_offset)} size ${size}`, null];
  }
  const targetObject = spec.target.target_object;
  if (!targetObject) throw new ScoreError("--target-object is required when --rom is not given");
  const tw = spec.function
    ? windowBySymbol(targetObject, { objdump: spec.objdump, symbol: spec.function, section: spec.section, ...io })
    : windowBetween(targetObject, { objdump: spec.objdump, start_symbol: spec.between[0], end_symbol: spec.between[1], section: spec.section, ...io });
  return [tw.words, `--target-object ${displayPath(targetObject, cwd)} (${tw.label})`, tw];
}

function resolveControlTargetWords(spec, control, controlWindow, io) {
  if (spec.target.kind === "rom") {
    if (control.offset === null) throw new ScoreError(`--control ${control.name} needs @OFFSET when scoring against --rom (for example --control ${control.name}@0x1000)`);
    if (!spec.target.rom) throw new ScoreError("--rom requires a path");
    return wordsFromBytes(readRomWindow(spec.target.rom, { offset: control.offset, size: control.size || controlWindow.size, cwd: io.cwd ?? process.cwd() }));
  }
  if (control.offset !== null) throw new ScoreError(`--control ${control.name}@${hexp(control.offset)} must not include an offset when scoring against --target-object; pass the bare symbol name instead (--control ${control.name})`);
  const targetObject = spec.target.target_object;
  if (!targetObject) throw new ScoreError("--target-object is required when --rom is not given");
  return windowBySymbol(targetObject, { objdump: spec.objdump, symbol: control.name, section: spec.section, ...io }).words;
}

/** The `next:` guidance lines for one score report. */
export function buildGuidance({ matched, function_score, controls_broken, target, function_symbol, candidate, cwd = process.cwd() }) {
  const lines = [];
  if (controls_broken) lines.push("CONTROLS BROKEN: a control function that used to match no longer does. Your lever changed something it must not touch -- revert it and narrow the change before trusting the function score below.");
  if (matched) { lines.push("Diff words are zero outside the relocation floor and every control is clean. Run the project's normal link/ROM verification for the final proof."); return lines; }
  if (!function_score.diff_words) return lines;
  if (function_symbol === null) {
    lines.push("This range was selected with `--between` because it has no function symbol, while `diagnose` addresses symbolized functions. Keep scoring this range with `score`/`matrix`, or extract comparable target and candidate objdump windows and pass those to `decomp-workbench diagnose-dumps`.");
    return lines;
  }
  if (target.kind === "object" && target.target_object) {
    lines.push(`Run \`decomp-workbench diagnose ${displayPath(target.target_object, cwd)} ${candidate} --function ${function_symbol}\` for full mechanism classification of the remaining diff words.`);
  } else {
    lines.push(`The target came from raw ROM bytes, so \`diagnose\` needs a comparable target object to run against. Export one, then pass that object and \`${candidate}\` to \`decomp-workbench diagnose --function ${function_symbol}\`.`);
  }
  return lines;
}

/** Score one candidate object's function, plus every declared control. */
export async function scoreReport(candidatePath, spec, { slot = null, cwd = process.cwd(), env = process.env } = {}) {
  const { buildScreenLine } = await import("./screen.js");
  const io = { cwd, env };
  const display = displayPath(candidatePath, cwd);
  const abs = String(candidatePath).startsWith("/") ? String(candidatePath) : `${cwd}/${candidatePath}`;
  let isFile = false;
  try { isFile = fs.statSync(abs).isFile(); } catch {}
  if (!isFile) throw new ScoreError(`candidate object does not exist: ${display}`);
  const window = resolveCandidateWindow(candidatePath, spec, io);
  const [targetWords, targetDescription, targetWindow] = resolveTargetWords(spec, window, io);
  const functionScore = scoreWindow(window, targetWords);
  const controls = [];
  for (const control of spec.controls) {
    const cwin = windowBySymbol(candidatePath, { objdump: spec.objdump, symbol: control.name, section: spec.section, ...io });
    controls.push(scoreWindow(cwin, resolveControlTargetWords(spec, control, cwin, io)));
  }
  const controlsBroken = controls.some((c) => !c.matched);
  const matched = functionScore.matched && !controlsBroken;
  const guidance = buildGuidance({ matched, function_score: functionScore, controls_broken: controlsBroken, target: spec.target, function_symbol: spec.function, candidate: display, cwd });
  const screen = await buildScreenLine(window.instructions, { label: window.label, path: abs, target: targetWindow ? targetWindow.instructions : null, slot });
  return new ScoreReport({ candidate: display, target_description: targetDescription, function: functionScore, controls, controls_broken: controlsBroken,
    matched, guidance, screen: screen.asDict() });
}
