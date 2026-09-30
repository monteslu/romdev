// preprocess.js - upstream runs `cpp -P -nostdinc -DPERMUTER base.c` before
// parsing. romdev never spawns a host cpp: a caller that has a JS
// preprocessor passes it as options.preprocess. Without one, this accepts only
// sources a cpp pass would leave token-for-token unchanged (no directives but
// #pragma / #ident / linemarkers, no comments), which is what an
// already-preprocessed base.c is, and refuses anything else instead of
// guessing.
import { readFileSync } from "node:fs";

export class PreprocessorRequired extends Error {
  constructor(message) { super(message); this.name = "PreprocessorRequired"; }
}

/**
 * @param {string} filename
 * @returns {string}
 */
export function preprocess(filename) {
  const text = readFileSync(filename, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#\s*(\w*)/.exec(lines[i]);
    if (m && !["pragma", "ident", "line", ""].includes(m[1]) && !/^\d/.test(m[1])) {
      throw new PreprocessorRequired(`${filename}:${i + 1}: '#${m[1]}' needs a C preprocessor; pass options.preprocess (upstream runs cpp -P -nostdinc -DPERMUTER)`);
    }
  }
  if (hasComment(text)) {
    throw new PreprocessorRequired(`${filename} contains comments; pass options.preprocess (upstream runs cpp -P -nostdinc -DPERMUTER)`);
  }
  return text;
}

/** A comment start outside string/char literals. */
function hasComment(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q || c === "\n") q = null;
      continue;
    }
    if (c === "\"" || c === "'") { q = c; continue; }
    if (c === "/" && (text[i + 1] === "*" || text[i + 1] === "/")) return true;
  }
  return false;
}
