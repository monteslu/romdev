// addressToSymbol — given a CPU address and a linker map (.map / .sym),
// return the nearest preceding symbol. Closes the C-debug gap on SDCC
// (and any other toolchain that emits a .map file).
//
// Common workflow:
//
//   1. buildSource({platform:"gb", source:..., outputPath:"foo.gb",
//                   includeSymbols: true})
//      → { symbols: "<sdld .map text>" }
//   2. (Save symbols to disk OR pass `symbolsText` directly each call.)
//   3. getCPUState() → { pc: "$01A7" }
//   4. addressToSymbol({ pc: 0x01A7, symbolsText: <.map> })
//      → { symbol: "wait_vblank", offset: 0x0C }
//
// Parsers supported:
//   - SDCC sdld .map (Z80 / sm83): `<4-hex addr><whitespace><name>`
//   - cc65 ld65 .sym ("VICE-style"): `al 0xNNNN .Lname`
//   - Future: vasm listings, asar symbol tables

import { readFile } from "node:fs/promises";
import { jsonContent, safeTool } from "../util.js";

function parseSdldStyle(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // sdld emits two formats:
    //   "<addr>  <name>"  (areas section, single-column)
    //   "<addr>  <name>   <module>"  (globals section, indented in raw,
    //                                  trimmed equal here, with optional module name)
    // 4-8 hex digits + at least one whitespace gap + identifier; optional
    // trailing module name (ignored).
    const m = /^([0-9A-Fa-f]{4,8})\s+([A-Za-z_.][A-Za-z0-9_.]*)(?:\s+[A-Za-z_][A-Za-z0-9_]*)?\s*$/.exec(line);
    if (m) {
      out.push({
        address: parseInt(m[1], 16),
        name: m[2].startsWith("_") ? m[2].slice(1) : m[2],
        rawName: m[2],
      });
    }
  }
  return out;
}

function parseLd65Sym(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // ld65 -Lf output (VICE-style): `al 00C000 .clearOAM`
    const m = /^al\s+([0-9A-Fa-f]{2,8})\s+\.?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
    if (m) {
      out.push({
        address: parseInt(m[1], 16),
        name: m[2],
        rawName: m[2],
      });
    }
  }
  return out;
}

function parseAuto(text) {
  // Try sdld first (most common, simplest), then ld65 .sym format.
  let entries = parseSdldStyle(text);
  if (entries.length === 0) entries = parseLd65Sym(text);
  entries.sort((a, b) => a.address - b.address);
  return entries;
}

function nearestSymbol(entries, pc) {
  // Binary search for the highest entry whose address <= pc.
  let lo = 0, hi = entries.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].address <= pc) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const sym = entries[best];
  const next = entries[best + 1];
  return {
    symbol: sym.name,
    rawSymbol: sym.rawName,
    symbolAddress: "$" + sym.address.toString(16).toUpperCase().padStart(4, "0"),
    symbolAddressDec: sym.address,
    offset: pc - sym.address,
    offsetHex: "+0x" + (pc - sym.address).toString(16).toUpperCase(),
    nextSymbol: next ? next.name : null,
    nextSymbolAddress: next ? "$" + next.address.toString(16).toUpperCase().padStart(4, "0") : null,
  };
}

/** op:'addr' on the `symbols` tool — PC → nearest preceding symbol from a .map/.sym. */
export async function addressToSymbolCore({ pc, symbolsText, symbolsPath }) {
      let text = symbolsText;
      if (!text && symbolsPath) {
        text = await readFile(symbolsPath, "utf-8");
      }
      if (!text) {
        throw new Error(
          "symbols({op:'addr'}): pass either `symbolsText` (inline) or `symbolsPath` (file). " +
          "Capture them via `build({..., includeSymbols: true})`."
        );
      }
      const entries = parseAuto(text);
      if (entries.length === 0) {
        return {
          pc: "$" + pc.toString(16).toUpperCase().padStart(4, "0"),
          symbolsLength: text.length,
          symbol: null,
          note: "Couldn't parse any symbols from the input. Expected either SDCC sdld format (`XXXX  _name`) or ld65 VICE format (`al XXXX .name`).",
        };
      }
      const result = nearestSymbol(entries, pc);
      if (!result) {
        return {
          pc: "$" + pc.toString(16).toUpperCase().padStart(4, "0"),
          symbolsLength: text.length,
          symbol: null,
          note: `PC $${pc.toString(16).toUpperCase()} is below the lowest symbol ($${entries[0].address.toString(16).toUpperCase()}). Probably ROM header / boot stub.`,
        };
      }
      return {
        pc: "$" + pc.toString(16).toUpperCase().padStart(4, "0"),
        pcDec: pc,
        ...result,
        symbolsParsed: entries.length,
      };
}

// Legacy no-op shim removed: addressToSymbol is now symbols({op:'addr'}).
export function registerAddressToSymbolTools() { /* folded into the `symbols` tool */
}
