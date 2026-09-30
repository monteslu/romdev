// pycparser: plyparser.js - Coord, ParseError and the PLYParser helpers
// (port of m2c_pycparser/plyparser.py). Copyright (c) 2008-2022 Eli
// Bendersky, BSD licence (see NOTICE).
import { str } from "../py.js";

/** Coordinates of a syntactic element: file, line, lex data and position. */
export class Coord {
  constructor(file, line, lexdata, lexpos) {
    this.file = file;
    this.line = line;
    this.lexdata = lexdata;
    this.lexpos = lexpos;
  }
  get column() {
    const nl = this.lexpos <= 0 ? -1 : this.lexdata.lastIndexOf("\n", this.lexpos - 1);
    return this.lexpos - nl;
  }
  source_line() {
    const start = this.lexpos - this.column + 1;
    let end = this.lexdata.indexOf("\n", start);
    if (end === -1) end = this.lexdata.length;
    return this.lexdata.slice(start, end).replace(/\r+$/, "");
  }
  __str__() {
    return `${str(this.file)}:${str(this.line)}:${this.column}`;
  }
  toString() {
    return this.__str__();
  }
  __repr__() {
    return `Coord(${str(this.file)}:${str(this.line)}:${this.column})`;
  }
}

/** Parse error; `args` is [message, coord] like the Python exception. */
export class ParseError extends Error {
  constructor(msg, coord) {
    super(msg);
    this.name = "ParseError";
    this.args = [msg, coord];
    this.coord = coord;
  }
  __str__() {
    return this.args[0];
  }
  toString() {
    return this.args[0];
  }
}

/** Base class holding the helpers pycparser's CParser uses. */
export class PLYParser {
  _coord(lineno, lexpos) {
    return new Coord(this.clex.filename, lineno, this.clex.lexer.lexdata, lexpos);
  }
  _token_coord(p, token_idx) {
    return this._coord(p.lineno(token_idx), p.lexpos(token_idx));
  }
  _parse_error(msg, coord) {
    throw new ParseError(`${str(coord)}: ${msg}`, coord);
  }
}
