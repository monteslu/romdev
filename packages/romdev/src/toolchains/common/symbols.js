// Generic symbol-file parsers and lookups.
//
// Different toolchains emit different formats:
//   - cc65 → .dbg (line-oriented, see cc65/dbgparse.js — handled separately)
//   - asar/bass/wla-dx → .sym (WLA format: "<bank>:<addr> <name>" sections)
//   - cc65 → .lbl (older list label format)
//
// This file handles non-dbg formats. Each parser returns the same shape
// so callers can be format-agnostic.

/**
 * @typedef {Object} Symbol
 * @property {string} name
 * @property {number} address      24-bit linear address (bank << 16 | offset)
 * @property {number} [bank]       optional bank byte (asar/SNES)
 * @property {string} [kind]       "label" | "constant" — guessed per format
 */

/**
 * Parse a WLA-DX .sym file. asar emits this with --symbols=wla.
 * Format:
 *   [labels]
 *   00:8000 reset
 *   01:8000 chr_data
 *
 *   [definitions]
 *   ff:0001 some_constant
 *
 * Sections are introduced by [section_name] in brackets. Each line is
 * "<bank>:<offset> <name>". Offsets are hex.
 * @param {string} text
 * @returns {Symbol[]}
 */
export function parseWlaSym(text) {
  const out = [];
  let section = null;
  // Asar's .sym file has several sections; only [labels] and [definitions]
  // map names to addresses. [source files], [addr-to-line mapping], etc.
  // use bank:offset prefixes too but aren't symbol declarations.
  const NAME_SECTIONS = new Set(["labels", "definitions"]);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (!NAME_SECTIONS.has(section)) continue;
    const m = line.match(/^([0-9A-Fa-f]+):([0-9A-Fa-f]+)\s+(\S+)/);
    if (!m) continue;
    const bank = parseInt(m[1], 16);
    const offset = parseInt(m[2], 16);
    if (!Number.isFinite(bank) || !Number.isFinite(offset)) continue;
    out.push({
      name: m[3],
      address: (bank << 16) | offset,
      bank,
      kind: section === "definitions" ? "constant" : "label",
    });
  }
  return out;
}

/**
 * Parse a cc65-style .lbl file. Simpler format used by older cc65 and
 * various 6502 tools:
 *   al 008000 reset
 *   al 00800a mainloop
 *
 * The `al` prefix is "absolute label" (cc65 ld65 emits this with --dbgfile).
 * @param {string} text
 * @returns {Symbol[]}
 */
export function parseCc65Lbl(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";")) continue;
    const m = line.match(/^al\s+([0-9A-Fa-f]+)\s+(\S+)/);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    if (!Number.isFinite(addr)) continue;
    // cc65 leading-dot names like `._main` → strip the dot for ergonomics.
    const name = m[2].replace(/^\./, "");
    out.push({ name, address: addr, kind: "label" });
  }
  return out;
}

/**
 * Auto-detect symbol-file format from filename extension or content
 * sniffing, then parse and return the unified Symbol[].
 *
 * @param {Object} args
 * @param {string} args.text
 * @param {string} [args.format] explicit format override: "wla" | "cc65-lbl"
 * @param {string} [args.path]   filename, used for ext-based detection
 */
export function parseSymbols(args) {
  const { text, format, path } = args;
  let chosen = format;
  if (!chosen && path) {
    const lower = path.toLowerCase();
    if (lower.endsWith(".sym")) chosen = "wla";
    else if (lower.endsWith(".lbl")) chosen = "cc65-lbl";
  }
  if (!chosen) {
    // Content sniff. WLA always has a [labels] / [definitions] section
    // header somewhere near the top.
    if (/^\s*\[(labels|definitions)\]/im.test(text)) chosen = "wla";
    else if (/^al\s+[0-9A-Fa-f]+\s/m.test(text)) chosen = "cc65-lbl";
    else throw new Error("could not detect symbol-file format; pass format=\"wla\" or \"cc65-lbl\"");
  }
  switch (chosen) {
    case "wla":      return parseWlaSym(text);
    case "cc65-lbl": return parseCc65Lbl(text);
    default: throw new Error(`unknown symbol format '${chosen}'`);
  }
}

/**
 * Build a fast lookup map for "what's at this address?" — used to
 * annotate disassembled instructions with labels.
 * @param {Symbol[]} symbols
 */
export function buildSymbolMap(symbols) {
  const byAddr = new Map();
  for (const s of symbols) {
    if (!byAddr.has(s.address)) byAddr.set(s.address, []);
    byAddr.get(s.address).push(s);
  }
  return {
    /** Look up the symbol(s) exactly at an address. */
    at: (addr) => byAddr.get(addr) ?? [],
    /** All symbols, sorted by address (handy for "what's near X"). */
    list: () => [...symbols].sort((a, b) => a.address - b.address),
  };
}
