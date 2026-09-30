// pycparser for m2c, ported to JS ESM (from m2c's vendored m2c_pycparser,
// itself pycparser upstream b5c6024 with C-extension patches).
// pycparser Copyright (c) 2008-2022 Eli Bendersky; PLY Copyright (c)
// 2001-2017 David M. Beazley. Both BSD licensed (see NOTICE).
//
// API (mirrors the Python module):
//   import { CParser, CGenerator, c_ast, ParseError, Coord } from "./pycparser/index.js";
//   const ast = new CParser().parse(text, filename);           // FileAST
//   new CGenerator().visit(node)                                // C source string
//
// m2c's parse_c() drives the parser the same way the Python does:
//   const p = new CParser();
//   p.clex.filename = "<source>"; p.clex.reset_lineno();
//   p._scope_stack = [new Map(initialScope)];                   // scopes are Map<string, boolean>
//   p._last_yielded_token = null;
//   const ast = p.cparser.parse({ input: source, lexer: p.clex });
//   const scope = new Map(p._scope_stack[0]);
// ParseError has `.args = [message, coord]` (coord is a Coord, or a string
// for "At end of input"), and Coord has .file/.line/.column/.source_line().
import * as c_ast from "./c_ast.js";

export { c_ast };
export { CParser } from "./c_parser.js";
export { CLexer } from "./c_lexer.js";
export { CGenerator } from "./c_generator.js";
export { Coord, ParseError } from "./plyparser.js";
export { fix_switch_cases, fix_atomic_specifiers } from "./ast_transforms.js";
