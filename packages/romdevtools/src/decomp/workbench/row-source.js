// row-source.js - one way to read an object's rows, with the .text alignment
// padding trimmed once so `align` and `phase` mean the same thing by row N.
// Caching is opt-in: there is no default cache directory.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { ValueError } from "./py.js";
import { dumpObject, parseDisassembly, symbolSelectionError, trimFunctionPadding } from "./objdump.js";

/** One object's real instruction rows, padding trimmed. */
export function loadObjectRows(p, { objdump = null, symbol = null, section = ".text", cache = null } = {}) {
  const [, instructions] = cache !== null ? cache.load(p, { symbol, section }) : dumpObject(p, { objdump, symbol, section });
  return trimFunctionPadding([...instructions]);
}

/** Rows from retained `objdump -d -r` text, padding trimmed. */
export function loadDumpRows(p, { symbol = null } = {}) {
  const text = fs.readFileSync(String(p), "utf8");
  const instructions = parseDisassembly(text, { symbol });
  if (!instructions.length) throw new ValueError(symbolSelectionError(symbol, { inputs: [[String(p), text]] }));
  return trimFunctionPadding([...instructions]);
}
