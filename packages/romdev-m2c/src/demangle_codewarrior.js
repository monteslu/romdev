// demangle_codewarrior.js - CodeWarrior C++ symbol demangler (port of
// m2c/demangle_codewarrior.py), supporting operators, templates (including
// literals), and arrays.
//
// CodeWarrior's symbol mangling and C++ ABI seems to be based on the
// Macintosh spec, section 3.4.1.2 (page 18) of
// https://mirror.informatimago.com/next/developer.apple.com/tools/mpw-tools/compilers/docs/abi_spec.pdf
// It deviates from this spec in a few key ways:
//   - The <count> in <qualified_name> is an unterminated <int> (no '_' separator)
//   - Parameterized types use '<', ',' and '>' characters instead of the "__PT" prefix
//
// Like the rest of m2c this file is licensed under the GPL v3. It is based on
// `demangler.cs` by arookas, provided under the 3-clause BSD License:
// https://gist.github.com/arookas/0c0cd842c9ca836d7a9ed06a655b1a22
//
// Copyright (c) 2017, arookas
// All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//
//   1. Redistributions of source code must retain the above copyright notice, this
//      list of conditions and the following disclaimer.
//
//   2. Redistributions in binary form must reproduce the above copyright notice,
//      this list of conditions and the following disclaimer in the documentation
//      and/or other materials provided with the distribution.
//
//   3. Neither the name of the copyright holder nor the names of its
//      contributors may be used to endorse or promote products derived from
//      this software without specific prior written permission.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
//   DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
//   FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
//   DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
//   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
//   CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
//   OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
//   OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
import { ValueError, pyassert, repr } from "./py.js";

// These substitutions are performed by the doldisasm.py decomp tool, and not by
// the CodeWarrior compiler directly. Undo them for convience.
const DOLDISASM_SUBSTITUTIONS = [
  ["<", "$$0"],
  [">", "$$1"],
  ["@", "$$2"],
  ["\\", "$$3"],
  [",", "$$4"],
  ["-", "$$5"],
];

/** Minimal io.StringIO: read(n), tell(), seek(pos). */
class StringIO {
  constructor(s) {
    this.s = s;
    this.pos = 0;
  }
  read(n = -1) {
    const start = this.pos;
    const end = n < 0 ? this.s.length : Math.min(this.s.length, start + n);
    this.pos = end;
    return this.s.slice(start, end);
  }
  tell() {
    return this.pos;
  }
  seek(p) {
    this.pos = p;
  }
}

/** Read exactly `size` chars from `src`, or raise a ValueError. */
function read_exact(src, size) {
  const value = src.read(size);
  if (value.length !== size) throw new ValueError(`Unable to read ${size} bytes; got ${repr(value)}`);
  return value;
}

/** Run fn, restoring the offset of `src` afterwards. */
function peeking(src, fn) {
  const ptr = src.tell();
  try {
    return fn();
  } finally {
    src.seek(ptr);
  }
}

/** Read up to `n` chars from `src` without advancing the offset. */
function peek(src, n = 1) {
  return peeking(src, () => src.read(n));
}

/** Wrap `s` in a StringIO for fn, and assert it was fully consumed after fn returns. */
function as_stringio(s, fn) {
  const buf = new StringIO(s);
  const result = fn(buf);
  const leftover = buf.read();
  if (leftover) throw new ValueError(`Unable to parse full input, leftover chars: ${repr(leftover)}`);
  return result;
}

// Python int(str) for base 10 (optional sign, digits); ValueError otherwise.
function pyInt(s) {
  const t = s.trim();
  if (!/^[+-]?[0-9]+(_[0-9]+)*$/.test(t)) throw new ValueError(`invalid literal for int() with base 10: ${repr(s)}`);
  return parseInt(t.replaceAll("_", ""), 10);
}

/**
 * The name of a C++ symbol, class, or namespace, optionally parameterized
 * with `template_params`.
 */
export class CxxName {
  constructor(name, template_params = null) {
    this.name = name;
    this.template_params = template_params;
  }
  static parse(src) {
    // Numbers: either a template literal, or a length prefix
    let number_str = "";
    while (CxxName.NUMBER_CHARS.has(peek(src))) number_str += read_exact(src, 1);
    if (number_str === "") throw new ValueError("Unable to parse CxxName, input did not start with a number");
    const number = pyInt(number_str);

    // Check if the number represents a template literal
    const p = peek(src);
    if (p === "," || p === ">") return new CxxName(number_str);

    // Otherwise, it is the length of the name
    if (number <= 0) throw new ValueError("length must be positive");
    const name = read_exact(src, number);

    // Simple case: plain identifier
    if (!name.includes("<")) return new CxxName(name);

    // Otherwise, parse the template parameters between the `<...>` brackets
    if (name[name.length - 1] !== ">") throw new ValueError("unpaired '<'");
    const idx = name.indexOf("<");
    const base_name = name.slice(0, idx);
    const param_strs = name.slice(idx + 1);

    const template_params = as_stringio(param_strs, (buf) => {
      const params = [];
      for (;;) {
        params.push(CxxType.parse(buf));
        const sep = read_exact(buf, 1);
        if (sep === ">") break;
        if (sep === ",") continue;
        throw new ValueError(`Unexpected character while parsing CxxName: ${sep}`);
      }
      return params;
    });
    return new CxxName(base_name, template_params);
  }
  __str__() {
    if (this.template_params === null) return this.name;
    return `${this.name}<${this.template_params.map((p) => p.__str__()).join(", ")}>`;
  }
  toString() {
    return this.__str__();
  }
}
CxxName.NUMBER_CHARS = new Set("-0123456789");

const KIND_VALUES = {
  CONST: "C",
  POINTER: "P",
  REFERENCE: "R",
  SIGNED: "S",
  UNSIGNED: "U",
  ELLIPSIS: "e",
  VOID: "v",
  BOOL: "b",
  CHAR: "c",
  SHORT: "s",
  INT: "i",
  LONG: "l",
  LONG_LONG: "x",
  WIDE_CHAR: "w",
  FLOAT: "f",
  DOUBLE: "d",
  LONG_DOUBLE: "r",
  ARRAY: "A",
  QUALIFIED: "Q",
  FUNCTION: "F",
  SYMBOL_REFERENCE: "&",
};

/** CxxTerm.Kind: an Enum whose members have .name and .value. */
class Kind {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
  /** Kind(value) lookup, raising ValueError for an unknown value like Python's Enum. */
  static of(value) {
    const k = Kind.byValue.get(value);
    if (!k) throw new ValueError(`${repr(value)} is not a valid Kind`);
    return k;
  }
}
Kind.byValue = new Map();
for (const [name, value] of Object.entries(KIND_VALUES)) {
  const k = new Kind(name, value);
  Kind[name] = k;
  Kind.byValue.set(value, k);
}

/**
 * A part of a C++ type, like a token: usually a single letter of a mangled
 * type, or an ARRAY / FUNCTION / QUALIFIED name / SYMBOL_REFERENCE.
 */
export class CxxTerm {
  constructor(kind, { array_dim = null, function_params = null, function_return = null, qualified_name = null, symbol_reference = null } = {}) {
    this.kind = kind;
    this.array_dim = array_dim;
    this.function_params = function_params;
    this.function_return = function_return;
    this.qualified_name = qualified_name;
    this.symbol_reference = symbol_reference;
  }
  static parse(src) {
    if (CxxName.NUMBER_CHARS.has(peek(src))) {
      return new CxxTerm(Kind.QUALIFIED, { qualified_name: [CxxName.parse(src)] });
    }
    const kind = Kind.of(read_exact(src, 1));
    if (kind === Kind.QUALIFIED) {
      const count = pyInt(read_exact(src, 1));
      const qualified_name = [];
      for (let i = 0; i < count; i++) qualified_name.push(CxxName.parse(src));
      return new CxxTerm(kind, { qualified_name });
    }
    if (kind === Kind.FUNCTION) {
      const function_params = [];
      let function_return = null;
      while (!["", "_", ",", ">"].includes(peek(src))) function_params.push(CxxType.parse(src));
      if (peek(src, 1) === "_") {
        read_exact(src, 1);
        function_return = CxxType.parse(src);
      }
      return new CxxTerm(kind, { function_params, function_return });
    }
    if (kind === Kind.ARRAY) {
      let array_dim = 0;
      for (;;) {
        const c = read_exact(src, 1);
        if (c === "_") break;
        array_dim = array_dim * 10 + pyInt(c);
      }
      return new CxxTerm(kind, { array_dim });
    }
    if (kind === Kind.SYMBOL_REFERENCE) {
      return new CxxTerm(kind, { symbol_reference: CxxSymbol.parse(src) });
    }
    return new CxxTerm(kind);
  }
  __str__() {
    if (this.kind === Kind.ARRAY) {
      pyassert(this.array_dim !== null);
      return `[${this.array_dim}]`;
    }
    if (this.kind === Kind.QUALIFIED) {
      pyassert(this.qualified_name !== null);
      const names = this.qualified_name.map((q) => q.__str__());
      const last = names[names.length - 1];
      if (Object.prototype.hasOwnProperty.call(CxxTerm.OPS, last)) {
        names[names.length - 1] = "operator" + CxxTerm.OPS[last];
      } else if (last === "__ct") {
        pyassert(names.length >= 2);
        names[names.length - 1] = names[names.length - 2];
      } else if (last === "__dt") {
        pyassert(names.length >= 2);
        names[names.length - 1] = `~${names[names.length - 2]}`;
      }
      return names.join("::");
    }
    if (this.kind === Kind.FUNCTION) {
      pyassert(this.function_params !== null);
      let prefix = "";
      if (this.function_return !== null) prefix = `${this.function_return.__str__()} (*) `;
      const args = this.function_params.map((p) => p.__str__()).join(", ");
      return `${prefix}(${args})`;
    }
    if (this.kind === Kind.SYMBOL_REFERENCE) {
      pyassert(this.symbol_reference !== null);
      return `&${this.symbol_reference.__str__()}`;
    }
    if (this.kind === Kind.POINTER) return "*";
    if (this.kind === Kind.REFERENCE) return "&";
    if (this.kind === Kind.LONG_LONG) return "long long";
    if (this.kind === Kind.LONG_DOUBLE) return "long double";
    if (this.kind === Kind.WIDE_CHAR) return "wchar_t";
    if (this.kind === Kind.ELLIPSIS) return "...";
    return this.kind.name.toLowerCase();
  }
  toString() {
    return this.__str__();
  }
}
CxxTerm.Kind = Kind;
CxxTerm.NONTERMINATING_KINDS = new Set([Kind.CONST, Kind.POINTER, Kind.REFERENCE, Kind.SIGNED, Kind.UNSIGNED, Kind.ARRAY]);
CxxTerm.OPS = {
  __nw: " new",
  __nwa: " new[]",
  __dl: " delete",
  __dla: " delete[]",
  __pl: "+",
  __mi: "-",
  __ml: "*",
  __dv: "/",
  __md: "%",
  __er: "^",
  __adv: "/=",
  __ad: "&",
  __or: "|",
  __co: "~",
  __nt: "!",
  __as: "=",
  __lt: "<",
  __gt: ">",
  __apl: "+=",
  __ami: "-=",
  __amu: "*=",
  __amd: "%=",
  __aer: "^=",
  __aad: "&=",
  __aor: "|=",
  __ls: "<<",
  __rs: ">>",
  __ars: ">>=",
  __als: "<<=",
  __eq: "==",
  __ne: "!=",
  __le: "<=",
  __ge: ">=",
  __aa: "&&",
  __oo: "||",
  __pp: "++",
  __mm: "--",
  __cl: "()",
  __vc: "[]",
  __rf: "->",
  __cm: ",",
  __rm: "->*",
};

/**
 * A complete C++ type. The final element in `terms` is the primitive type;
 * working from the end, each previous term modifies the type.
 */
export class CxxType {
  constructor(terms = []) {
    this.terms = terms;
  }
  static parse(src) {
    const terms = [];
    for (;;) {
      const p = peek(src);
      if (p === "," || p === ">") break;
      const term = CxxTerm.parse(src);
      terms.push(term);
      if (!CxxTerm.NONTERMINATING_KINDS.has(term.kind)) break;
    }
    return new CxxType(terms);
  }
  __str__() {
    return this.terms.slice().reverse().map((a) => a.__str__()).join(" ").trim();
  }
  toString() {
    return this.__str__();
  }
}

/** A C++ symbol and its type. */
export class CxxSymbol {
  constructor(name, type) {
    this.name = name;
    this.type = type;
  }
  static parse(src) {
    // Find the `base_name`: the prefix of `src` which usually represents the
    // original, unmangled name, typically separated from the type information
    // by the rightmost "__" (with many edge cases).
    let strip_underscores = 0;
    let template_depth = 0;
    let base_name = peeking(src, () => src.read());
    peeking(src, () => {
      let chars = "";
      for (;;) {
        const c = src.read(1);
        if (!c) break;
        if ((c === "," || c === ">") && template_depth === 0) {
          if (strip_underscores === 0) base_name = chars;
          break;
        } else if (c === "<") {
          template_depth += 1;
        } else if (c === ">") {
          template_depth -= 1;
        }
        chars += c;
        if (CxxSymbol.STATIC_FUNCTIONS.has(chars)) {
          base_name = chars;
          strip_underscores = 1;
          break;
        } else if (c === "_" && peek(src) === "_") {
          const lookahead = peek(src, 2);
          if (lookahead.length < 2 || "CFQ0123456789".includes(lookahead[1])) {
            base_name = chars.slice(0, -1);
            strip_underscores = 2;
          }
        }
      }
    });

    read_exact(src, base_name.length + strip_underscores);

    if (CxxSymbol.STATIC_FUNCTIONS.has(base_name)) {
      // `__sinit_Foo_cpp` is the static constructor for "Foo.cpp":
      // "demangle" it into `void Foo_cpp::__sinit(void)`.
      const type = as_stringio("Fv_v", (buf) => CxxType.parse(buf));
      return new CxxSymbol(new CxxTerm(Kind.QUALIFIED, { qualified_name: [new CxxName(src.read()), new CxxName(base_name)] }), type);
    }

    // After the "__", the base_name is followed by the (optional) qualified class name, then the type.
    let class_name = CxxType.parse(src);
    let type;
    if (!["", ",", ">"].includes(peek(src))) {
      type = CxxType.parse(src);
    } else {
      pyassert(class_name !== null);
      type = class_name;
      class_name = null;
    }

    const qualified_name = [];
    if (class_name !== null) {
      pyassert(class_name.terms.length === 1);
      pyassert(class_name.terms[0].kind === Kind.QUALIFIED);
      pyassert(class_name.terms[0].qualified_name !== null);
      qualified_name.push(...class_name.terms[0].qualified_name);
    }
    as_stringio(String(base_name.length) + base_name, (buf) => qualified_name.push(CxxName.parse(buf)));

    const name = new CxxTerm(Kind.QUALIFIED, { qualified_name });
    return new CxxSymbol(name, type);
  }
  __str__() {
    return `${this.name.__str__()} ${this.type.__str__()}`;
  }
  toString() {
    return this.__str__();
  }
}
CxxSymbol.STATIC_FUNCTIONS = new Set(["__sinit", "__sterm"]);

/** Parse a mangled CodeWarrior symbol. */
export function parse(mangled) {
  for (const [old, neu] of DOLDISASM_SUBSTITUTIONS) mangled = mangled.replaceAll(neu, old);
  return as_stringio(mangled, (buf) => CxxSymbol.parse(buf));
}

/** Demangle `mangled`, returning it unchanged when it does not parse. */
export function demangle(mangled) {
  try {
    return parse(mangled).__str__();
  } catch (e) {
    if (e instanceof ValueError) return mangled;
    throw e;
  }
}

/** The module's self-test table: [mangled, expected demangled]. */
export const TEST_CASES = [
  // Unmangled, but with underscores
  ["__foo_bar", "__foo_bar"],
  // Namespacing
  ["get__6FoobarFi", "Foobar::get (int)"],
  // Constructor / Destructor
  ["__ct__10FooBarFoosFP7ArgPtrsUsPCc", "FooBarFoos::FooBarFoos (ArgPtrs *, short unsigned, char const *)"],
  ["__dt__10FooBarFoosFv", "FooBarFoos::~FooBarFoos (void)"],
  // Overloaded operators
  ["__dl__FPv", "operator delete (void *)"],
  ["__nw__FUl", "operator new (long unsigned)"],
  ["__eq__3FooCFRC3Foo", "Foo::operator== (Foo const &) const"],
  // Namespacing & templated arguments
  [
    "do__Q214GrandFooSystem8MiniFoosFUlPC3VecP3VecfUlUlPP8LateBazzUlUc",
    "GrandFooSystem::MiniFoos::do (long unsigned, Vec const *, Vec *, float, long unsigned, long unsigned, LateBazz * *, long unsigned, char unsigned)",
  ],
  [
    "spin__11ThingieBaseFRCQ29MyLibrary8FVec3$$0f$$1RCQ29MyLibrary8FVec3$$0f$$1RCQ29MyLibrary8FVec3$$0f$$1",
    "ThingieBase::spin (MyLibrary::FVec3<float> const &, MyLibrary::FVec3<float> const &, MyLibrary::FVec3<float> const &)",
  ],
  // Templated function names
  ["function<&alpha,&beta,&GAMMA>__FR5Class_i", "function<&alpha, &beta, &GAMMA> int (*) (Class &)"],
  ["function<&m0__5Class,&mf0__5ClassFi>__FR5Class_i", "function<&m0 Class, &Class::mf0 (int)> int (*) (Class &)"],
  // Static functions
  ["__sinit_Foo_cpp", "Foo_cpp::__sinit void (*) (void)"],
  ["__sterm_Foo_cpp", "Foo_cpp::__sterm void (*) (void)"],
  // Confusing function names (check that we split on the last valid "__")
  ["foo__3BarFv", "Bar::foo (void)"],
  ["foo__3BarFv__3BarFv", "Bar::foo__3BarFv (void)"],
  ["foo__Q23Bar3BarFv__3BarFv", "Bar::foo__Q23Bar3BarFv (void)"],
  ["copy__Q23std14__copy$$0Pv$$41$$40$$1FPPvPPvPPv", "std::__copy<void *, 1, 0>::copy (void * *, void * *, void * *)"],
  ["__init__bar__9Bar$$03Foo$$1", "__init__bar Bar<Foo>"],
  ["bar__5__BarFv", "__Bar::bar (void)"],
  // These examples we fail to demangle correctly
  ["bar__5__FooFv", "bar__5__FooFv"], // should be "__Foo::bar (void)"
  ["foo__Ul", "foo__Ul"], // should be "foo long unsigned" (or "long unsigned foo")
];

/** Run the self-test table; returns true when every case matches. */
export function test() {
  let all_pass = true;
  for (const [mangled, demangled] of TEST_CASES) {
    const output = demangle(mangled);
    if (output !== demangled) all_pass = false;
  }
  return all_pass;
}
