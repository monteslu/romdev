// romdev-pycparser - a plain-JS port of pycparser as vendored by m2c
// (m2c_pycparser) and decomp-permuter (perm_pycparser): the same fork of
// pycparser 2.23 with GCC extensions (attributes, asm, typeof, ...).
//
//   import { CParser, CGenerator, c_ast } from "romdev-pycparser";
//   const ast = new CParser().parse(text, "<source>");
//   const back = new CGenerator().visit(ast);
import { readFileSync } from "node:fs";
import { CParser } from "./c_parser.js";

export * as c_ast from "./c_ast.js";
export { Node, NodeVisitor, nodeRepr } from "./c_ast.js";
export { CParser, Coord, ParseError, AssertionError, PyValueError } from "./c_parser.js";
export { CLexer, LexToken, LexError, pyRegexToJs } from "./c_lexer.js";
export { CGenerator } from "./c_generator.js";
export { fix_switch_cases, fix_atomic_specifiers } from "./ast_transforms.js";

/**
 * Parse a C file (pycparser.parse_file). Upstream can shell out to `cpp`;
 * this port never spawns a host tool, so preprocessing is a caller-supplied
 * function: pass `preprocess(filename) -> text` together with use_cpp.
 * @param {string} filename
 * @param {{use_cpp?: boolean, preprocess?: (filename: string) => string, parser?: CParser, encoding?: BufferEncoding}} [opts]
 */
export function parse_file(filename, { use_cpp = false, preprocess = null, parser = null, encoding = "utf8" } = {}) {
  let text;
  if (use_cpp) {
    if (!preprocess) throw new Error("parse_file: use_cpp needs a preprocess(filename) function (no host cpp is spawned)");
    text = preprocess(filename);
  } else {
    // open(filename) in text mode: universal newlines (\r\n and lone \r become \n).
    text = readFileSync(filename, encoding).replace(/\r\n?/g, "\n");
  }
  return (parser ?? new CParser()).parse(text, filename);
}
