// pins.js - catalogue the address pins a project writes down in its linker
// scripts and symbol files (`NAME = expression;`), and classify each one:
// derived (names a symbol, follows the layout), authentic-fixed (console or
// caller whitelist fixes it), artifact-suspect (a constant in a window the
// project owns), rom-offset (a raw cartridge offset), shadowing-pin (an
// absolute pin that overrode an object's own definition), or unclassified.
// Also reads and drafts whitelist files: drafted entries are always emitted
// COMMENTED OUT, because a whitelist entry is a claim the project makes, not
// one a map reader can make for it.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { ValueError, sorted, splitlines, strip, pyInt, replace, strRepr, hex } from "./py.js";
import { NamedRange, RangeModel, WhitelistEntry, defaultN64Windows } from "./mips-refs.js";

export const DERIVED = "derived";
export const AUTHENTIC_FIXED = "authentic-fixed";
export const ARTIFACT_SUSPECT = "artifact-suspect";
export const ROM_OFFSET = "rom-offset";
export const SHADOWING_PIN = "shadowing-pin";
export const UNCLASSIFIED = "unclassified";
export const CLASSIFICATIONS = Object.freeze([SHADOWING_PIN, ARTIFACT_SUSPECT, ROM_OFFSET, UNCLASSIFIED, AUTHENTIC_FIXED, DERIVED]);

const CART_REASON = "cart domain (0xB0000000 PI address space): an address written down in place of data the project has not matched yet";
const HARDWARE_REASON = "memory-mapped hardware register window: fixed by the console, not by this project's layout";
const KSEG0_REASON = "kseg0 RAM address written as a constant: it does not move when the layout moves";
const ROM_OFFSET_REASON = "raw ROM offset: below every run-time RAM window and inside the extent "
  + "this map places, so it addresses the cartridge image rather than memory. "
  + "Symbolize it against the linker's own <segment>_ROM_START/_ROM_END "
  + "symbols and it follows the layout instead of being written down";

export const VRAM_WINDOW_FLOOR = 0x80000000;

function vramFloor(model) {
  const los = model.windows.filter((w) => w.lo >= VRAM_WINDOW_FLOOR).map((w) => w.lo);
  return los.length ? Math.min(...los) : VRAM_WINDOW_FLOOR;
}

export const BOOT_GLOBALS_LO = 0x80000300;
export const BOOT_GLOBALS_HI = 0x80000404;

export function bootGlobalsWhitelist() {
  return new WhitelistEntry({ lo: BOOT_GLOBALS_LO, hi: BOOT_GLOBALS_HI,
    reason: "N64 boot globals (osTvType..osAppNMIBuffer) and the fixed entrypoint: written by the boot ROM before any of this project runs" });
}

/** The default classification model: the N64 windows plus a caller whitelist. */
export function defaultPinModel({ whitelist = [], windows = null } = {}) {
  return new RangeModel({ windows: windows !== null ? [...windows] : defaultN64Windows(), whitelist: [...whitelist] });
}

/** [classification, window, reason] for one absolute value. */
export function classifyAbsolute(value, { model, rom_extent = null }) {
  const [window, whitelisted, reason] = model.classifyValue(value);
  if (whitelisted) return [AUTHENTIC_FIXED, window, reason];
  if (window === "cart") return [ARTIFACT_SUSPECT, window, CART_REASON];
  if (window === "kseg1") return [AUTHENTIC_FIXED, window, HARDWARE_REASON];
  if (window === "kseg0") return [ARTIFACT_SUSPECT, window, KSEG0_REASON];
  if (rom_extent !== null && rom_extent !== undefined && value >= 0 && value < Math.min(rom_extent, vramFloor(model))) return [ROM_OFFSET, window, ROM_OFFSET_REASON];
  return [UNCLASSIFIED, window, null];
}

// Parsing

const ASSIGNMENT_RE = /^\s*(?<name>[A-Za-z_][A-Za-z0-9_$.]*)\s*=\s*(?<rhs>[\s\S]+)$/;
const IDENTIFIER_RE = /(?<![\w$.])[A-Za-z_$][A-Za-z0-9_$.]*/g;
const LD_BUILTINS = new Set(["ABSOLUTE", "ADDR", "ALIGN", "ALIGNOF", "BLOCK", "CONSTANT", "DATA_SEGMENT_ALIGN", "DEFINED", "LENGTH", "LOADADDR",
  "MAX", "MIN", "ORIGIN", "SEGMENT_START", "SIZEOF", "SIZEOF_HEADERS"]);
const ATTRIBUTE_RE = /^[A-Za-z_][A-Za-z0-9_]*:\S+$/;

const condense = (text) => text.split(/\s+/).filter(Boolean).join(" ");

function stripComments(text) {
  const pieces = [], comments = [];
  let index = 0, line = 1, lineHasCode = false;
  const size = text.length;
  while (index < size) {
    const ch = text[index];
    if (ch === "\n") { pieces.push("\n"); line += 1; lineHasCode = false; index += 1; continue; }
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      const stop = close < 0 ? size : close + 2;
      const body = text.slice(index + 2, close < 0 ? size : close);
      comments.push({ line, text: condense(body), trailing: lineHasCode });
      const span = text.slice(index, stop);
      pieces.push([...span].map((c) => (c === "\n" ? "\n" : " ")).join(""));
      line += span.split("\n").length - 1;
      index = stop;
      continue;
    }
    if (text.startsWith("//", index)) {
      const close = text.indexOf("\n", index);
      const stop = close < 0 ? size : close;
      comments.push({ line, text: condense(text.slice(index + 2, stop)), trailing: lineHasCode });
      pieces.push(" ".repeat(stop - index));
      index = stop;
      continue;
    }
    if (!/\s/.test(ch)) lineHasCode = true;
    pieces.push(ch);
    index += 1;
  }
  return [pieces.join(""), comments];
}

// A folder for the integer-constant expressions a pin's right-hand side can
// hold: integer literals, unary - + ~, binary | ^ & << >> + - * / // %,
// parentheses and ABSOLUTE(x), with the usual precedence and floor
// division/modulo. Anything else does not fold ("unresolved").
class NoFold extends Error {}

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const m = /^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:[1-9](?:_?\d)*|0(?:_?0)*))(?![\w.])/.exec(src.slice(i));
    if (m) {
      let t = m[0].replace(/_/g, "");
      let v;
      if (/^0[xX]/.test(t)) v = BigInt(t);
      else if (/^0[oO]/.test(t)) v = BigInt("0o" + t.slice(2));
      else if (/^0[bB]/.test(t)) v = BigInt("0b" + t.slice(2));
      else v = BigInt(t);
      toks.push({ t: "num", v }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (["<<", ">>", "//"].includes(two)) { toks.push({ t: two }); i += 2; continue; }
    if ("+-*/%&|^~()".includes(c)) { toks.push({ t: c }); i++; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { toks.push({ t: "id", v: id[0] }); i += id[0].length; continue; }
    throw new NoFold();
  }
  return toks;
}

function foldExpression(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]?.t;
  const eat = (t) => { if (peek() !== t) throw new NoFold(); p++; };
  const floorDiv = (a, b) => { if (b === 0n) throw new NoFold(); const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; };
  const mod = (a, b) => { if (b === 0n) throw new NoFold(); const r = a % b; return r !== 0n && (r < 0n) !== (b < 0n) ? r + b : r; };
  const shift = (a, b, left) => { if (b < 0n) throw new ValueError("negative shift count"); return left ? a << b : a >> b; };
  const binary = (next, ops) => () => {
    let left = next();
    while (ops[peek()]) { const op = peek(); p++; left = ops[op](left, next()); }
    return left;
  };
  const unary = () => {
    const t = peek();
    if (t === "-") { p++; return -unary(); }
    if (t === "+") { p++; return unary(); }
    if (t === "~") { p++; return ~unary(); }
    return atom();
  };
  const atom = () => {
    const tk = toks[p];
    if (!tk) throw new NoFold();
    if (tk.t === "num") { p++; return tk.v; }
    if (tk.t === "(") { p++; const v = or(); eat(")"); return v; }
    if (tk.t === "id" && tk.v === "ABSOLUTE" && toks[p + 1]?.t === "(") {
      p += 2; const v = or(); eat(")"); return v;
    }
    throw new NoFold();
  };
  const mul = binary(unary, { "*": (a, b) => a * b, "/": floorDiv, "//": floorDiv, "%": mod });
  const add = binary(mul, { "+": (a, b) => a + b, "-": (a, b) => a - b });
  const sh = binary(add, { "<<": (a, b) => shift(a, b, true), ">>": (a, b) => shift(a, b, false) });
  const and = binary(sh, { "&": (a, b) => a & b });
  const xor = binary(and, { "^": (a, b) => a ^ b });
  const or = binary(xor, { "|": (a, b) => a | b });
  const v = or();
  if (p !== toks.length) throw new NoFold();
  return v;
}

function resolve(expression) {
  const refs = [];
  for (const m of expression.matchAll(IDENTIFIER_RE)) {
    const name = m[0].replace(/\.+$/, "");
    if (name && !LD_BUILTINS.has(name) && !refs.includes(name)) refs.push(name);
  }
  if (refs.length) return ["derived", null, refs];
  let value;
  try { value = foldExpression(expression); } catch (e) { if (e instanceof NoFold) return ["unresolved", null, []]; throw e; }
  return ["absolute", Number(value & 0xFFFFFFFFn), []];
}

/** One pin: a name the project writes down, and what its value is. */
export class Pin {
  constructor({ name, expression, form, classification, value, window, reason, references, source, line, comment, context, attributes = [] }) {
    Object.assign(this, { name, expression, form, classification, value, window, reason, references, source, line, comment, context, attributes });
    Object.freeze(this);
  }
  asDict() {
    return { name: this.name, expression: this.expression, form: this.form, classification: this.classification, value: this.value,
      window: this.window, reason: this.reason, references: [...this.references], source: this.source, line: this.line,
      comment: this.comment, context: this.context, attributes: Object.fromEntries(this.attributes) };
  }
}

/** Parse the assignments of one linker-script/symbol file. */
export function parsePinText(text, { path = null, model, rom_extent = null }) {
  const [code, comments] = stripComments(text);
  const trailing = new Map();
  for (const c of comments) if (c.trailing) trailing.set(c.line, c);
  const standalone = comments.filter((c) => !c.trailing);
  const pins = [];
  let start = 0;
  const lineAt = (offset) => { let n = 1; for (let i = 0; i < offset; i++) if (code.charCodeAt(i) === 10) n++; return n; };
  for (let index = 0; index < code.length; index++) {
    if (code[index] !== ";") continue;
    const statement = code.slice(start, index);
    const offset = start + (statement.length - statement.replace(/^\s+/, "").length);
    const firstLine = lineAt(offset), lastLine = lineAt(index);
    start = index + 1;
    const m = ASSIGNMENT_RE.exec(statement);
    if (!m) continue;
    const expression = condense(m.groups.rhs);
    const [form, value, references] = resolve(expression);
    let classification, window, reason;
    if (form === "derived") [classification, window, reason] = [DERIVED, null, null];
    else if (form === "absolute") [classification, window, reason] = classifyAbsolute(value, { model, rom_extent });
    else [classification, window, reason] = [UNCLASSIFIED, null, null];
    const note = trailing.get(lastLine);
    let commentText = null, attributes = [];
    if (note && note.text) {
      const tokens = note.text.split(/\s+/).filter(Boolean);
      if (tokens.length && tokens.every((t) => ATTRIBUTE_RE.test(t))) attributes = tokens.map((t) => { const k = t.indexOf(":"); return [t.slice(0, k), t.slice(k + 1)]; });
      else commentText = note.text;
    }
    const heading = standalone.filter((c) => c.line < firstLine);
    pins.push(new Pin({ name: m.groups.name, expression, form, classification, value, window, reason, references, source: path,
      line: firstLine, comment: commentText, context: heading.length ? heading[heading.length - 1].text : null, attributes }));
  }
  return pins;
}

/** Every pin a project's pin files declare. */
export class PinCatalogue {
  constructor({ entries, sources }) { this.entries = Object.freeze([...entries]); this.sources = Object.freeze([...sources]); Object.freeze(this); }
  get counts() {
    const found = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0]));
    for (const e of this.entries) found[e.classification] = (found[e.classification] ?? 0) + 1;
    return found;
  }
  byClassification(classification) { return this.entries.filter((e) => e.classification === classification); }
  ranked() {
    const order = new Map(CLASSIFICATIONS.map((c, i) => [c, i]));
    return sorted(this.entries, (e) => [order.get(e.classification) ?? order.size]);
  }
  asDict({ limit }) {
    const counts = this.counts;
    const shown = this.ranked().slice(0, Math.max(0, limit));
    return { pin_sources: [...this.sources], pins_total: this.entries.length, pins_derived: counts[DERIVED], pins_authentic: counts[AUTHENTIC_FIXED],
      pins_artifact: counts[ARTIFACT_SUSPECT], pins_rom_offset: counts[ROM_OFFSET], pins_shadowing: counts[SHADOWING_PIN],
      pins_unclassified: counts[UNCLASSIFIED], pins_shown: shown.length, limit: Math.max(0, limit), pins: shown.map((e) => e.asDict()) };
  }
}

/** Read and classify every pin in the given files. */
export function readPinFiles(paths, { model, rom_extent = null, display = null }) {
  const entries = [], sources = [];
  for (const [i, p] of [...paths].entries()) {
    const name = display ? String(display[i]) : String(p);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(readFileSync(p));
    entries.push(...parsePinText(text, { path: name, model, rom_extent }));
    sources.push(name);
  }
  return new PinCatalogue({ entries, sources });
}

/** Re-read unclassified absolute pins as ROM offsets once the extent is known. */
export function reclassifyRomOffsets(catalogue, { model, rom_extent }) {
  const entries = catalogue.entries.map((item) => {
    if (item.classification !== UNCLASSIFIED || item.value === null) return item;
    const [classification, window, reason] = classifyAbsolute(item.value, { model, rom_extent });
    if (classification !== ROM_OFFSET) return item;
    return replace(item, { classification, window, reason });
  });
  return new PinCatalogue({ entries, sources: catalogue.sources });
}

const SHADOWING_REASON = "an object in this link already defines this symbol, and the linker "
  + "script's assignment silently overrode it (GNU ld does that with no "
  + "warning). The linked ELF still carries the losing definition's size and "
  + "type on the surviving absolute symbol, which is how this was detected. "
  + "Deleting the pin restores the object's own definition, which follows the "
  + "layout for free -- and is byte-identical at the current layout, since "
  + "both spellings resolve to the same address today";

/** Mark absolute pins whose ELF symbol still carries an overridden definition. */
export function reclassifyShadowingPins(catalogue, { elf }) {
  const entries = catalogue.entries.map((item) => {
    const symbol = item.form !== "derived" ? elf.symbol(item.name) : null;
    if (!symbol || !symbol.shadows_definition) return item;
    return replace(item, { classification: SHADOWING_PIN, reason: SHADOWING_REASON });
  });
  return new PinCatalogue({ entries, sources: catalogue.sources });
}

// Whitelist files

const WHITELIST_RE = /^\s*(?<lo>0[xX][0-9a-fA-F]+|\d+)(?:\s*-\s*(?<hi>0[xX][0-9a-fA-F]+|\d+))?\s+(?<reason>\S.*?)\s*$/;

/** Parse `0xADDR reason` / `0xLO-0xHI reason` lines (high bound inclusive). */
export function parseWhitelistText(text) {
  const entries = [];
  splitlines(text).forEach((raw, i) => {
    const number = i + 1;
    const line = strip(raw);
    if (!line || line.startsWith("#")) return;
    const m = WHITELIST_RE.exec(line);
    if (!m) throw new ValueError(`whitelist line ${number} is not \`0xADDR reason\` or \`0xLO-0xHI reason\`: ${strRepr(line)}`);
    const low = pyInt(m.groups.lo, 0);
    const high = m.groups.hi ? pyInt(m.groups.hi, 0) : low;
    if (high < low) throw new ValueError(`whitelist line ${number} ends below where it starts (0x${hex(low)}-0x${hex(high)}); the low address comes first`);
    entries.push(new WhitelistEntry({ lo: low, hi: high + 1, reason: m.groups.reason }));
  });
  return entries;
}

export const WHITELIST_REVIEW_MARKER = "# REVIEW:";

export class WhitelistRule {
  constructor(name, evidence) { Object.assign(this, { name, evidence }); Object.freeze(this); }
  asDict() { return { name: this.name, evidence: this.evidence }; }
}

export const WHITELIST_TEMPLATE_RULES = Object.freeze([
  new WhitelistRule("hardware-window", "the value falls in a memory-mapped hardware window (kseg1, or the "
    + "cart domain inside it): an address the console fixes, which no layout change can move"),
  new WhitelistRule("below-window-floor", "a kseg0 constant below the movable window's own floor: it cannot be "
    + "an address this layout owns, and it is the shape of the libultra "
    + "boot globals the boot ROM writes before any of this project runs"),
]);

export const HARDWARE_WINDOWS = Object.freeze(["kseg1", "cart"]);

export class WhitelistCandidate {
  constructor({ value, name, rule, reason, window, source, line }) { Object.assign(this, { value, name, rule, reason, window, source, line }); Object.freeze(this); }
  asDict() { return { value: this.value, name: this.name, rule: this.rule, reason: this.reason, window: this.window, source: this.source, line: this.line }; }
}

/** Draft one template line per pin that has an authentic-fixed shape. */
export function whitelistCandidates(catalogue, { window_lo }) {
  const found = [];
  for (const pin of catalogue.entries) {
    if (pin.form !== "absolute" || pin.value === null) continue;
    let rule, reason;
    if (HARDWARE_WINDOWS.includes(pin.window)) {
      rule = "hardware-window";
      reason = `${pin.name}: memory-mapped hardware address in the ${pin.window} window, fixed by the console rather than by this project's layout`;
    } else if (pin.window === "kseg0" && pin.value < window_lo) {
      if (pin.classification === AUTHENTIC_FIXED) continue;
      rule = "below-window-floor";
      reason = `${pin.name}: kseg0 constant below the movable window floor 0x${hex(window_lo, 8)}, so no insertion moves it -- boot-globals shaped`;
    } else continue;
    found.push(new WhitelistCandidate({ value: pin.value, name: pin.name, rule, reason, window: pin.window, source: pin.source, line: pin.line }));
  }
  return sorted(found, (c) => [c.value, c.name]);
}

/** Render a skeleton whitelist file from a catalogue's own evidence. */
export function whitelistTemplateText(catalogue, { window_lo, window_lo_section = null }) {
  const candidates = whitelistCandidates(catalogue, { window_lo });
  let floor = `0x${hex(window_lo, 8)}`;
  if (window_lo_section) floor = `${floor} (${window_lo_section})`;
  const lines = [
    "# shift audit --emit-whitelist: a skeleton, not a whitelist.",
    "#",
    "# Format: `0xADDR reason` or `0xLO-0xHI reason`, one per line, high",
    "# bound inclusive, # comments ignored. A reason is required: an",
    "# address with no reason is one somebody re-derives later.",
    "#",
    "# Every entry below is COMMENTED OUT. A whitelist entry is a claim",
    "# your project makes about its own addresses, and reading a linker",
    "# map does not entitle this command to make it for you. Delete the",
    "# lines that are not authentic, rewrite the reasons on the ones",
    "# that are, and remove the leading `# ` to turn one on.",
    "#",
    `# movable window floor: ${floor}`,
  ];
  for (const s of catalogue.sources) lines.push(`# pin_sources: ${s}`);
  lines.push(`# pins_total: ${catalogue.entries.length}`, `# candidates: ${candidates.length}`);
  for (const rule of WHITELIST_TEMPLATE_RULES) {
    const drafted = candidates.filter((c) => c.rule === rule.name).length;
    lines.push(`#   ${rule.name} (${drafted}): ${rule.evidence}`);
  }
  if (!candidates.length) {
    lines.push("#", "# No pin in these files has either shape. That is a result,", "# not an error: this project writes down no hardware address",
      "# and no constant below its own movable window floor.", "");
    return lines.join("\n");
  }
  for (const c of candidates) {
    lines.push("", `${WHITELIST_REVIEW_MARKER} ${c.name} (${c.source || "-"}:${c.line}), rule ${c.rule}`, `# 0x${hex(c.value, 8, { upper: true })} ${c.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

export { NamedRange };
