// A small interpreter for the Python subset the workbench uses to BUILD its
// argument parser. It executes build_parser() against a recording argparse
// stub, so the golden --help texts come from the original parser definitions
// themselves, not from a transcription.
import fs from "node:fs";
import path from "node:path";
import { parseModule } from "./parser.mjs";

// -- values -----------------------------------------------------------------
export class PyFloatV { constructor(v) { this.v = v; } }
export class Tuple { constructor(items) { this.items = items; } }
export class PySetV { constructor(items = []) { this.m = new Map(); for (const x of items) this.m.set(keyOf(x), x); } }
export class Dict { constructor() { this.m = new Map(); } get(k) { const e = this.m.get(keyOf(k)); return e ? e[1] : undefined; } set(k, v) { const kk = keyOf(k); const e = this.m.get(kk); if (e) e[1] = v; else this.m.set(kk, [k, v]); } has(k) { return this.m.has(keyOf(k)); } del(k) { this.m.delete(keyOf(k)); } keys() { return [...this.m.values()].map((e) => e[0]); } values() { return [...this.m.values()].map((e) => e[1]); } entries() { return [...this.m.values()]; } }
export class Func { constructor(def, scope, mod, name) { this.def = def; this.scope = scope; this.mod = mod; this.name = name ?? def.name; } }
export class Builtin { constructor(name, fn) { this.name = name; this.fn = fn; } }
export class Klass { constructor(name, bases, ns, mod) { this.name = name; this.bases = bases; this.ns = ns; this.mod = mod; } lookup(n) { if (this.ns.has(n)) return this.ns.get(n); for (const b of this.bases) { if (b instanceof Klass) { const v = b.lookup(n); if (v !== undefined) return v; } } return undefined; } }
export class Instance { constructor(cls) { this.cls = cls; this.attrs = new Map(); } }
export class Module { constructor(name) { this.name = name; this.globals = new Map(); } }
export class Opaque { constructor(why) { this.why = why; } }
class Bound { constructor(self, fn) { this.self = self; this.fn = fn; } }
class PyExc extends Error { constructor(value) { super(`raised: ${describe(value)}`); this.value = value; } }
class ReturnSig { constructor(v) { this.v = v; } }
class BreakSig {}
class ContinueSig {}

function describe(v) { try { return v instanceof Instance ? v.cls.name : v instanceof Opaque ? `<opaque ${v.why}>` : String(v); } catch { return "?"; } }

export function keyOf(x) {
  if (x instanceof Tuple) return "T" + JSON.stringify(x.items.map(keyOf));
  if (typeof x === "string") return "s" + x;
  if (typeof x === "number") return "n" + x;
  if (x instanceof PyFloatV) return "n" + x.v;
  if (typeof x === "boolean") return "n" + (x ? 1 : 0);
  if (x === null) return "None";
  return x;
}

export const OPAQUE = (why) => new Opaque(why);
const isOpaque = (v) => v instanceof Opaque;

// -- repr / str -------------------------------------------------------------
export function floatRepr(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  let s = String(x);
  if (/e/.test(s)) { const [m, e] = s.split("e"); s = `${m}e${e[0] === "-" ? "-" : "+"}${e.replace(/^[-+]/, "").padStart(2, "0")}`; }
  return s;
}
export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v instanceof PyFloatV) return floatRepr(v.v);
  if (v instanceof Instance) {
    const m = findMethod(v, "__str__");
    if (m) return call(m, [], {});
    if (v.cls.name === "Path" || v.pathValue !== undefined) return v.pathValue;
  }
  return pyRepr(v);
}
export function pyRepr(v) {
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    return q + v.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r") + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v instanceof Tuple) return v.items.length === 1 ? `(${pyRepr(v.items[0])},)` : "(" + v.items.map(pyRepr).join(", ") + ")";
  if (v instanceof Dict) return "{" + v.entries().map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ") + "}";
  if (v instanceof PySetV) return v.m.size ? "{" + [...v.m.values()].map(pyRepr).join(", ") + "}" : "set()";
  if (v instanceof Opaque) throw new Error(`repr of opaque value (${v.why})`);
  if (v instanceof Klass) return `<class '${v.name}'>`;
  if (v instanceof Func) return `<function ${v.name}>`;
  return pyStr(v);
}

// -- truthiness, comparison -------------------------------------------------
export function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (v instanceof PyFloatV) return v.v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Tuple) return v.items.length > 0;
  if (v instanceof Dict) return v.m.size > 0;
  if (v instanceof PySetV) return v.m.size > 0;
  if (v instanceof Opaque) throw new Error(`truth value of opaque (${v.why})`);
  return true;
}
const num = (v) => (v instanceof PyFloatV ? v.v : typeof v === "boolean" ? (v ? 1 : 0) : v);
export function eq(a, b) {
  if (a instanceof Tuple && b instanceof Tuple) return a.items.length === b.items.length && a.items.every((x, i) => eq(x, b.items[i]));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  const na = num(a), nb = num(b);
  if (typeof na === "number" && typeof nb === "number") return na === nb;
  return a === b;
}
export function cmp(a, b) {
  if ((a instanceof Tuple || Array.isArray(a)) && (b instanceof Tuple || Array.isArray(b))) {
    const x = a instanceof Tuple ? a.items : a, y = b instanceof Tuple ? b.items : b;
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = cmp(x[i], y[i]); if (c) return c; }
    return x.length - y.length;
  }
  const na = num(a), nb = num(b);
  if (typeof na === "number" && typeof nb === "number") return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw new Error(`cannot compare ${describe(a)} and ${describe(b)}`);
}

export function iterate(v) {
  if (Array.isArray(v)) return [...v];
  if (v instanceof Tuple) return [...v.items];
  if (typeof v === "string") return [...v];
  if (v instanceof Dict) return v.keys();
  if (v instanceof PySetV) return [...v.m.values()];
  if (v && v.__iter) return v.__iter();
  if (v instanceof Opaque) throw new Error(`iterate opaque (${v.why})`);
  throw new Error(`cannot iterate ${describe(v)}`);
}

// -- string formatting -------------------------------------------------------
export function formatSpec(v, spec) {
  if (!spec) return pyStr(v);
  const m = /^(?:(.)?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) throw new Error(`format spec ${spec}`);
  let [, fillc, align, sign, alt, zero, width, grouping, prec, type] = m;
  let s;
  const n = num(v);
  if (type === "d" || (type === undefined && typeof v === "number" && !(v instanceof PyFloatV) && typeof n === "number" && prec === undefined)) {
    s = typeof n === "number" && type ? String(Math.trunc(n)) : pyStr(v);
    if (typeof n === "number" && grouping) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, grouping);
  } else if (type === "f" || type === "F") s = n.toFixed(prec === undefined ? 6 : Number(prec));
  else if (type === "%") s = (n * 100).toFixed(prec === undefined ? 6 : Number(prec)) + "%";
  else if (type === "x" || type === "X") { s = Math.trunc(n).toString(16); if (type === "X") s = s.toUpperCase(); if (alt) s = "0x" + s; }
  else if (type === "o") s = Math.trunc(n).toString(8);
  else if (type === "b") s = Math.trunc(n).toString(2);
  else if (type === "g" || type === "G") s = String(Number(n.toPrecision(prec === undefined ? 6 : Math.max(1, Number(prec)))));
  else if (type === "e") s = n.toExponential(prec === undefined ? 6 : Number(prec));
  else { s = pyStr(v); if (prec !== undefined) s = s.slice(0, Number(prec)); }
  if (typeof n === "number" && sign === "+" && n >= 0 && type) s = "+" + s;
  const w = Number(width || 0);
  if (s.length < w) {
    const numeric = typeof n === "number" && !(typeof v === "string");
    const f = zero && !fillc ? "0" : fillc ?? " ";
    const al = align ?? (zero ? "=" : numeric ? ">" : "<");
    const pad = w - s.length;
    if (al === "<") s = s + f.repeat(pad);
    else if (al === ">") s = f.repeat(pad) + s;
    else if (al === "^") s = f.repeat(Math.floor(pad / 2)) + s + f.repeat(Math.ceil(pad / 2));
    else { const neg = s[0] === "-" || s[0] === "+"; s = neg ? s[0] + f.repeat(pad) + s.slice(1) : f.repeat(pad) + s; }
  }
  return s;
}

function percentFormat(fmt, args) {
  let i = 0;
  const list = args instanceof Tuple ? args.items : [args];
  return fmt.replace(/%(?:\(([^)]*)\))?([-#0 +]*)(\*|\d*)(?:\.(\d+))?([sdirfgxXe%c])/g, (m, name, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    let v;
    if (name !== undefined) v = args instanceof Dict ? args.get(name) : getattr(args, name);
    else { if (width === "*") width = String(list[i++]); v = list[i++]; }
    let s;
    if (conv === "s") s = pyStr(v); else if (conv === "r") s = pyRepr(v);
    else if (conv === "d" || conv === "i") s = String(Math.trunc(num(v)));
    else if (conv === "f") s = num(v).toFixed(prec === undefined ? 6 : Number(prec));
    else if (conv === "x") s = Math.trunc(num(v)).toString(16);
    else if (conv === "X") s = Math.trunc(num(v)).toString(16).toUpperCase();
    else if (conv === "c") s = typeof v === "number" ? String.fromCharCode(v) : v;
    else s = pyStr(v);
    if (conv === "s" && prec !== undefined) s = s.slice(0, Number(prec));
    const w = Number(width || 0);
    if (s.length < w) s = flags.includes("-") ? s.padEnd(w) : s.padStart(w, flags.includes("0") && conv !== "s" ? "0" : " ");
    return s;
  });
}

function strFormat(fmt, args, kwargs) {
  let auto = 0;
  return fmt.replace(/\{\{|\}\}|\{([^{}!:]*)(?:!([rsa]))?(?::([^{}]*))?\}/g, (m, field, conv, spec) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    let v;
    const [head, ...rest] = field.split(/(?=[.[])/);
    if (head === "") v = args[auto++];
    else if (/^\d+$/.test(head)) v = args[Number(head)];
    else v = kwargs.get(head);
    for (const r of rest) v = r.startsWith(".") ? getattr(v, r.slice(1)) : getitem(v, /^\[\d+\]$/.test(r) ? Number(r.slice(1, -1)) : r.slice(1, -1));
    if (conv === "r") v = pyRepr(v); else if (conv === "s") v = pyStr(v);
    return formatSpec(v, spec ?? "");
  });
}

// -- attribute access ---------------------------------------------------------
function findMethod(inst, name) {
  const m = inst.cls.lookup(name);
  if (m instanceof Func) return new Bound(inst, m);
  return null;
}

export function getattr(v, name, dflt) {
  const miss = () => { if (dflt !== undefined) return dflt; throw new PyExc(new Error(`AttributeError: ${describe(v)}.${name}`)); };
  if (v instanceof Opaque) return OPAQUE(`${v.why}.${name}`);
  if (v instanceof Module) { if (v.globals.has(name)) return v.globals.get(name); if (v.lazy) return v.lazy(name); return miss(); }
  if (v instanceof Instance) {
    if (v.attrs.has(name)) return v.attrs.get(name);
    const m = v.cls.lookup(name);
    if (m instanceof Func) {
      if (m.property) return call(m, [v], new Map());
      return new Bound(v, m);
    }
    if (m instanceof Builtin) return new Bound(v, m);
    if (m !== undefined) return m;
    if (v.native && name in v.native) return v.native[name];
    return miss();
  }
  if (v instanceof Klass) { const m = v.lookup(name); if (m !== undefined) return m; if (name === "__name__") return v.name; return miss(); }
  if (v && typeof v === "object" && v.__attrs) { const r = v.__attrs(name); if (r !== undefined) return r; return miss(); }
  if (typeof v === "string") { const m = STR_METHODS[name]; if (m) return new Builtin(`str.${name}`, (a, k) => m(v, a, k)); }
  if (Array.isArray(v)) { const m = LIST_METHODS[name]; if (m) return new Builtin(`list.${name}`, (a, k) => m(v, a, k)); }
  if (v instanceof Tuple) { if (name === "count") return new Builtin("count", (a) => v.items.filter((x) => eq(x, a[0])).length); if (name === "index") return new Builtin("index", (a) => v.items.findIndex((x) => eq(x, a[0]))); }
  if (v instanceof Dict) { const m = DICT_METHODS[name]; if (m) return new Builtin(`dict.${name}`, (a, k) => m(v, a, k)); }
  if (v instanceof PySetV) { const m = SET_METHODS[name]; if (m) return new Builtin(`set.${name}`, (a, k) => m(v, a, k)); }
  if (v instanceof Func && name === "__name__") return v.name;
  if (v instanceof Builtin && name === "__name__") return v.name;
  return miss();
}

export function setattr(obj, name, val) {
  if (obj instanceof Instance) obj.attrs.set(name, val);
  else if (obj instanceof Module) obj.globals.set(name, val);
  else if (obj instanceof Klass) obj.ns.set(name, val);
  else if (obj && obj.__setattr) obj.__setattr(name, val);
  else if (obj instanceof Opaque) return;
  else throw new Error(`setattr on ${describe(obj)}`);
}

export function getitem(v, k) {
  if (v instanceof Opaque) return OPAQUE(`${v.why}[]`);
  if (k && typeof k === "object" && k.slice === true) {
    const seq = Array.isArray(v) ? v : v instanceof Tuple ? v.items : typeof v === "string" ? v : null;
    if (seq === null) throw new Error("slice of non-sequence");
    const len = seq.length;
    const norm = (x, d) => (x === null ? d : x < 0 ? Math.max(0, len + x) : Math.min(len, x));
    const step = k.step ?? 1;
    let out;
    if (step === 1) out = seq.slice(norm(k.lo, 0), norm(k.hi, len));
    else if (step === -1 && k.lo === null && k.hi === null) out = typeof seq === "string" ? [...seq].reverse().join("") : [...seq].reverse();
    else throw new Error("slice step");
    return v instanceof Tuple ? new Tuple(out) : out;
  }
  if (Array.isArray(v) || typeof v === "string") { const i = k < 0 ? v.length + k : k; if (i < 0 || i >= v.length) throw new PyExc(new Error("IndexError")); return v[i]; }
  if (v instanceof Tuple) { const i = k < 0 ? v.items.length + k : k; return v.items[i]; }
  if (v instanceof Dict) { if (!v.has(k)) throw new PyExc(new Error(`KeyError ${pyRepr(k)}`)); return v.get(k); }
  if (v instanceof Instance) { const m = findMethod(v, "__getitem__"); if (m) return call(m, [k], new Map()); }
  if (v && v.__getitem) return v.__getitem(k);
  throw new Error(`subscript of ${describe(v)}`);
}

// -- builtin methods ----------------------------------------------------------
const kw = (k, n, d) => (k && k.has(n) ? k.get(n) : d);
const WS_CHARS = " \t\n\r\x0b\x0c";
const stripChars = (s, chars, l, r) => { const set = chars === null || chars === undefined ? WS_CHARS : chars; let a = 0, b = s.length; if (l) while (a < b && set.includes(s[a])) a++; if (r) while (b > a && set.includes(s[b - 1])) b--; return s.slice(a, b); };
const STR_METHODS = {
  join: (s, [it]) => iterate(it).map((x) => { if (typeof x !== "string") throw new Error(`join non-str ${describe(x)}`); return x; }).join(s),
  strip: (s, [c]) => stripChars(s, c, true, true), rstrip: (s, [c]) => stripChars(s, c, false, true), lstrip: (s, [c]) => stripChars(s, c, true, false),
  split: (s, [sep, max]) => { if (sep === undefined || sep === null) return s.split(/[ \t\n\r\x0b\x0c]+/).filter(Boolean); const parts = s.split(sep); if (max !== undefined && max >= 0 && parts.length > max + 1) return [...parts.slice(0, max), parts.slice(max).join(sep)]; return parts; },
  splitlines: (s) => { const l = s.split(/\r\n|\n|\r/); if (l.length && l[l.length - 1] === "") l.pop(); return l; },
  replace: (s, [a, b]) => s.split(a).join(b), upper: (s) => s.toUpperCase(), lower: (s) => s.toLowerCase(), title: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()),
  startswith: (s, [p]) => (p instanceof Tuple ? p.items.some((x) => s.startsWith(x)) : s.startsWith(p)), endswith: (s, [p]) => (p instanceof Tuple ? p.items.some((x) => s.endsWith(x)) : s.endsWith(p)),
  removeprefix: (s, [p]) => (s.startsWith(p) ? s.slice(p.length) : s), removesuffix: (s, [p]) => (p && s.endsWith(p) ? s.slice(0, -p.length) : s),
  format: (s, a, k) => strFormat(s, a, k ?? new Map()), ljust: (s, [w, f = " "]) => s.padEnd(w, f), rjust: (s, [w, f = " "]) => s.padStart(w, f), center: (s, [w]) => { const p = Math.max(0, w - s.length); return " ".repeat(Math.floor(p / 2)) + s + " ".repeat(Math.ceil(p / 2)); },
  count: (s, [x]) => s.split(x).length - 1, find: (s, [x]) => s.indexOf(x), index: (s, [x]) => s.indexOf(x), isdigit: (s) => /^\d+$/.test(s), isidentifier: (s) => /^[A-Za-z_]\w*$/.test(s),
  casefold: (s) => s.toLowerCase(), capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(), partition: (s, [x]) => { const i = s.indexOf(x); return i < 0 ? new Tuple([s, "", ""]) : new Tuple([s.slice(0, i), x, s.slice(i + x.length)]); },
  encode: (s) => s, zfill: (s, [w]) => s.padStart(w, "0"), expandtabs: (s) => s.replace(/\t/g, "        "),
};
const LIST_METHODS = {
  append: (l, [x]) => { l.push(x); return null; }, extend: (l, [x]) => { l.push(...iterate(x)); return null; }, insert: (l, [i, x]) => { l.splice(i, 0, x); return null; },
  pop: (l, [i]) => (i === undefined ? l.pop() : l.splice(i, 1)[0]), index: (l, [x]) => l.findIndex((y) => eq(x, y)), count: (l, [x]) => l.filter((y) => eq(x, y)).length,
  sort: (l, a, k) => { const key = kw(k, "key", null); const rev = kw(k, "reverse", false); const d = l.map((x, i) => [key ? call(key, [x], new Map()) : x, i, x]); d.sort((p, q) => cmp(p[0], q[0]) || p[1] - q[1]); if (rev) d.reverse(); l.splice(0, l.length, ...d.map((x) => x[2])); return null; },
  copy: (l) => [...l], remove: (l, [x]) => { l.splice(l.findIndex((y) => eq(x, y)), 1); return null; }, reverse: (l) => { l.reverse(); return null; }, clear: (l) => { l.length = 0; return null; },
};
const DICT_METHODS = {
  items: (d) => d.entries().map(([k, v]) => new Tuple([k, v])), keys: (d) => d.keys(), values: (d) => d.values(),
  get: (d, [k, dflt = null]) => (d.has(k) ? d.get(k) : dflt), setdefault: (d, [k, v = null]) => { if (!d.has(k)) d.set(k, v); return d.get(k); },
  update: (d, [o], k) => { if (o) for (const [a, b] of o instanceof Dict ? o.entries() : iterate(o).map((t) => t.items)) d.set(a, b); if (k) for (const [a, b] of k) d.set(a, b); return null; },
  pop: (d, [k, dflt]) => { if (d.has(k)) { const v = d.get(k); d.del(k); return v; } return dflt; }, copy: (d) => { const n = new Dict(); for (const [a, b] of d.entries()) n.set(a, b); return n; },
};
const SET_METHODS = { add: (s, [x]) => { s.m.set(keyOf(x), x); return null; }, update: (s, [x]) => { for (const y of iterate(x)) s.m.set(keyOf(y), y); return null; }, union: (s, [x]) => new PySetV([...s.m.values(), ...iterate(x)]), issubset: (s, [x]) => { const o = new PySetV(iterate(x)); return [...s.m.keys()].every((k) => o.m.has(k)); }, difference: (s, [x]) => { const o = new PySetV(iterate(x)); return new PySetV([...s.m.values()].filter((v) => !o.m.has(keyOf(v)))); } };

// -- calling --------------------------------------------------------------------
export function call(f, args, kwargs = new Map()) {
  if (f instanceof Opaque) return OPAQUE(`${f.why}()`);
  if (f instanceof Builtin) return f.fn(args, kwargs);
  if (f instanceof Bound) {
    if (f.fn instanceof Builtin) return f.fn.fn([f.self, ...args], kwargs);
    return call(f.fn, [f.self, ...args], kwargs);
  }
  if (f instanceof Func) return callFunc(f, args, kwargs);
  if (f instanceof Klass) return instantiate(f, args, kwargs);
  if (f && f.__call) return f.__call(args, kwargs);
  throw new Error(`call of ${describe(f)}`);
}

function instantiate(cls, args, kwargs) {
  const native = nativeBase(cls);
  if (native && native.construct) {
    const inst = native.construct(args, kwargs, cls);
    return inst;
  }
  const inst = new Instance(cls);
  const init = cls.lookup("__init__");
  if (init instanceof Func) callFunc(init, [inst, ...args], kwargs);
  else if (init instanceof Builtin) init.fn([inst, ...args], kwargs);
  return inst;
}
function nativeBase(cls) {
  if (cls.native) return cls.native;
  for (const b of cls.bases) { if (b instanceof Klass) { const n = nativeBase(b); if (n) return n; } }
  return null;
}

let CURRENT_CLASS = [];
function callFunc(f, args, kwargs) {
  const d = f.def;
  const scope = new Scope(f.scope, f.mod);
  const params = d.params;
  let ai = 0;
  const used = new Set();
  for (const p of params) {
    if (p.kind === "pos") {
      if (ai < args.length) { scope.set(p.name, args[ai++]); used.add(p.name); }
      else if (kwargs.has(p.name)) { scope.set(p.name, kwargs.get(p.name)); used.add(p.name); }
      else if (p.def) scope.set(p.name, p.defValue);
      else throw new Error(`${f.name}() missing argument ${p.name}`);
    } else if (p.kind === "varargs") { scope.set(p.name, new Tuple(args.slice(ai))); ai = args.length; }
    else if (p.kind === "kwonly") {
      if (kwargs.has(p.name)) { scope.set(p.name, kwargs.get(p.name)); used.add(p.name); }
      else if (p.def) scope.set(p.name, p.defValue);
      else throw new Error(`${f.name}() missing kw ${p.name}`);
    } else if (p.kind === "kwargs") {
      const d2 = new Dict();
      for (const [k, v] of kwargs) if (!used.has(k)) d2.set(k, v);
      scope.set(p.name, d2);
      for (const k of kwargs.keys()) used.add(k);
    }
  }
  for (const k of kwargs.keys()) if (!used.has(k) && !params.some((p) => p.kind === "kwargs")) throw new Error(`${f.name}() unexpected kw ${k}`);
  if (ai < args.length && !params.some((p) => p.kind === "varargs")) throw new Error(`${f.name}() too many args`);
  scope.funcClass = f.ownerClass ?? null;
  scope.selfArg = args[0];
  const yields = d.hasYield ? [] : null;
  scope.yields = yields;
  try { execBlock(d.body, scope); } catch (e) { if (e instanceof ReturnSig) return yields ? yields : e.v; throw e; }
  return yields ?? null;
}

// -- scopes and evaluation --------------------------------------------------------------
class Scope {
  constructor(parent, mod) { this.parent = parent; this.mod = mod; this.vars = new Map(); this.globalsDecl = new Set(); }
  get(n) {
    for (let s = this; s; s = s.parent) if (s.vars.has(n)) return s.vars.get(n);
    return this.mod.lookup(n);
  }
  set(n, v) { if (this.globalsDecl.has(n)) this.mod.globals.set(n, v); else this.vars.set(n, v); }
}

function hasYield(body) {
  let found = false;
  const walk = (n) => {
    if (!n || typeof n !== "object" || found) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.k === "Yield") { found = true; return; }
    if (n.k === "FunctionDef" || n.k === "Lambda" || n.k === "ClassDef") return;
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  walk(body);
  return found;
}

function makeFunc(def, scope) {
  for (const p of def.params) if (p.def) p.defValue = evaluate(p.def, scope);
  if (def.hasYield === undefined) def.hasYield = hasYield(def.body);
  return new Func(def, scope instanceof Scope && scope.vars ? scope : null, scope.mod ?? scope, def.name);
}

export function execBlock(stmts, scope) { for (const s of stmts) exec(s, scope); }

function assign(target, v, scope) {
  switch (target.k) {
    case "Name": scope.set(target.id, v); return;
    case "Tuple": case "List": {
      const items = iterate(v);
      const star = target.elts.findIndex((e) => e.k === "Starred");
      if (star < 0) { if (items.length !== target.elts.length) throw new Error("unpack mismatch"); target.elts.forEach((e, i) => assign(e, items[i], scope)); }
      else {
        const after = target.elts.length - star - 1;
        target.elts.slice(0, star).forEach((e, i) => assign(e, items[i], scope));
        assign(target.elts[star].v, items.slice(star, items.length - after), scope);
        target.elts.slice(star + 1).forEach((e, i) => assign(e, items[items.length - after + i], scope));
      }
      return;
    }
    case "Attr": setattr(evaluate(target.v, scope), target.name, v); return;
    case "Subscript": {
      const obj = evaluate(target.v, scope);
      if (target.idx.k === "Slice" && Array.isArray(obj)) {
        const lo = target.idx.lo ? evaluate(target.idx.lo, scope) : 0, hi = target.idx.hi ? evaluate(target.idx.hi, scope) : obj.length;
        obj.splice(lo, hi - lo, ...iterate(v));
        return;
      }
      const k = evaluate(target.idx, scope);
      if (Array.isArray(obj)) obj[k < 0 ? obj.length + k : k] = v; else if (obj instanceof Dict) obj.set(k, v); else if (obj instanceof Opaque) return; else throw new Error("subscript assign");
      return;
    }
    default: throw new Error(`assign to ${target.k}`);
  }
}

function exec(s, scope) {
  try { return exec0(s, scope); }
  catch (e) {
    if (e instanceof ReturnSig || e instanceof BreakSig || e instanceof ContinueSig) throw e;
    if (!e.pyStack) e.pyStack = [];
    if (s.line && e.pyStack.length < 12) e.pyStack.push(`${(scope.mod?.file ?? "?").split("/").pop()}:${s.line}`);
    throw e;
  }
}

function exec0(s, scope) {
  switch (s.k) {
    case "Expr": evaluate(s.e, scope); return;
    case "Assign": { const v = evaluate(s.v, scope); for (const t of s.targets) assign(t, v, scope); return; }
    case "AnnAssign": if (s.v) assign(s.target, evaluate(s.v, scope), scope); return;
    case "AugAssign": { const cur = evaluate(s.target, scope); const v = binop(s.op, cur, evaluate(s.v, scope)); if (Array.isArray(cur) && s.op === "+") { cur.push(...iterate(evaluate(s.v, scope))); return; } assign(s.target, v, scope); return; }
    case "Pass": return;
    case "Suite": execBlock(s.body, scope); return;
    case "Return": throw new ReturnSig(s.v ? evaluate(s.v, scope) : null);
    case "If": if (truthy(evaluate(s.test, scope))) execBlock(s.body, scope); else execBlock(s.orelse, scope); return;
    case "For": {
      let broke = false;
      for (const item of iterate(evaluate(s.iter, scope))) {
        assign(s.target, item, scope);
        try { execBlock(s.body, scope); } catch (e) { if (e instanceof BreakSig) { broke = true; break; } if (e instanceof ContinueSig) continue; throw e; }
      }
      if (!broke) execBlock(s.orelse, scope);
      return;
    }
    case "While": { let n = 0; while (truthy(evaluate(s.test, scope))) { if (++n > 100000) throw new Error("while runaway"); try { execBlock(s.body, scope); } catch (e) { if (e instanceof BreakSig) return; if (e instanceof ContinueSig) continue; throw e; } } return; }
    case "Break": throw new BreakSig();
    case "Continue": throw new ContinueSig();
    case "FunctionDef": {
      const f = makeFunc(s, scope);
      let v = f;
      for (const d of [...(s.decorators ?? [])].reverse()) {
        const name = d.k === "Name" ? d.id : d.k === "Attr" ? d.name : d.k === "Call" && d.f.k === "Name" ? d.f.id : null;
        if (name === "property" || name === "cached_property") { f.property = true; continue; }
        if (["staticmethod", "classmethod", "wraps", "dataclass", "overload", "abstractmethod", "lru_cache", "cache"].includes(name)) { if (name === "staticmethod") f.static = true; continue; }
        v = call(evaluate(d, scope), [v]);
      }
      scope.set(s.name, v);
      return;
    }
    case "ClassDef": {
      const bases = s.bases.filter((a) => a.kind === "pos").map((a) => evaluate(a.v, scope));
      const cls = new Klass(s.name, bases, new Map(), scope.mod ?? scope);
      const cscope = new Scope(scope instanceof Scope ? scope : null, scope.mod ?? scope);
      cscope.isClass = true;
      for (const st of s.body) {
        try { exec(st, cscope); } catch (e) { if (e instanceof ReturnSig) throw e; /* tolerate class-body oddities */ }
      }
      for (const [k, v] of cscope.vars) { if (v instanceof Func) v.ownerClass = cls; cls.ns.set(k, v); }
      scope.set(s.name, cls);
      return;
    }
    case "Import": for (const n of s.names) { const mod = importModule(n.name, scope.mod); scope.set(n.as ?? n.name.split(".")[0], n.as ? mod : importModule(n.name.split(".")[0], scope.mod)); } return;
    case "ImportFrom": {
      const mod = importModule(s.mod, scope.mod);
      for (const n of s.names) {
        if (n.name === "*") continue;
        const val = mod instanceof Module && !mod.globals.has(n.name) && !mod.lazy && mod.isPackage ? importModule(`${s.mod}${s.mod.endsWith(".") ? "" : "."}${n.name}`, scope.mod) : getattr(mod, n.name, OPAQUE(`${s.mod}.${n.name}`));
        scope.set(n.as ?? n.name, val);
      }
      return;
    }
    case "Try": {
      try { execBlock(s.body, scope); }
      catch (e) {
        if (!(e instanceof PyExc) || !s.handlers.length) throw e;
        const h = s.handlers[0];
        if (h.as) scope.set(h.as, e.value);
        execBlock(h.body, scope);
        return;
      } finally { if (s.finalbody.length) execBlock(s.finalbody, scope); }
      execBlock(s.orelse, scope);
      return;
    }
    case "With": { for (const it of s.items) { const v = evaluate(it.e, scope); if (it.as) assign(it.as, v, scope); } execBlock(s.body, scope); return; }
    case "Raise": throw new PyExc(s.e ? evaluate(s.e, scope) : null);
    case "Global": for (const n of s.names) scope.globalsDecl?.add(n); return;
    case "Del": return;
    case "Assert": return;
    default: throw new Error(`statement ${s.k}`);
  }
}

function binop(op, a, b) {
  if (a instanceof Opaque || b instanceof Opaque) return OPAQUE(`binop ${op}`);
  switch (op) {
    case "+":
      if (typeof a === "string" && typeof b === "string") return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (a instanceof Tuple && b instanceof Tuple) return new Tuple([...a.items, ...b.items]);
      return arith(a, b, (x, y) => x + y);
    case "-": if (a instanceof PySetV) return new PySetV([...a.m.values()].filter((v) => !b.m.has(keyOf(v)))); return arith(a, b, (x, y) => x - y);
    case "*":
      if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, b));
      if (typeof b === "string" && typeof a === "number") return b.repeat(Math.max(0, a));
      if (Array.isArray(a) && typeof b === "number") return Array(Math.max(0, b)).fill(0).flatMap(() => a);
      if (a instanceof Tuple && typeof b === "number") return new Tuple(Array(Math.max(0, b)).fill(0).flatMap(() => a.items));
      return arith(a, b, (x, y) => x * y);
    case "/": return new PyFloatV(num(a) / num(b));
    case "//": return Math.floor(num(a) / num(b));
    case "%": if (typeof a === "string") return percentFormat(a, b); { const r = num(a) % num(b); return r !== 0 && (r < 0) !== (num(b) < 0) ? r + num(b) : r; }
    case "**": return arith(a, b, (x, y) => x ** y);
    case "|": if (a instanceof PySetV) return new PySetV([...a.m.values(), ...b.m.values()]); if (a instanceof Dict) { const d = new Dict(); for (const [k, v] of a.entries()) d.set(k, v); for (const [k, v] of b.entries()) d.set(k, v); return d; } return num(a) | num(b);
    case "&": if (a instanceof PySetV) return new PySetV([...a.m.values()].filter((v) => b.m.has(keyOf(v)))); return num(a) & num(b);
    case "^": return num(a) ^ num(b);
    case "<<": return num(a) * 2 ** num(b);
    case ">>": return Math.floor(num(a) / 2 ** num(b));
    default: throw new Error(`binop ${op}`);
  }
}
function arith(a, b, f) {
  const fl = a instanceof PyFloatV || b instanceof PyFloatV;
  const r = f(num(a), num(b));
  if (typeof r !== "number" || Number.isNaN(r) && !fl) throw new Error(`arith on ${describe(a)} ${describe(b)}`);
  return fl ? new PyFloatV(r) : r;
}

function contains(container, item) {
  if (typeof container === "string") return container.includes(item);
  if (Array.isArray(container)) return container.some((x) => eq(x, item));
  if (container instanceof Tuple) return container.items.some((x) => eq(x, item));
  if (container instanceof Dict) return container.has(item);
  if (container instanceof PySetV) return container.m.has(keyOf(item));
  if (container instanceof Opaque) throw new Error("in opaque");
  throw new Error(`in ${describe(container)}`);
}

function comprehend(node, scope, sink) {
  const inner = new Scope(scope instanceof Scope ? scope : null, scope.mod ?? scope);
  if (scope instanceof Scope) inner.parent = scope;
  const rec = (gi) => {
    if (gi === node.gens.length) { sink(inner); return; }
    const g = node.gens[gi];
    for (const item of iterate(evaluate(g.iter, gi === 0 ? scope : inner))) {
      assign(g.target, item, inner);
      if (g.ifs.every((c) => truthy(evaluate(c, inner)))) rec(gi + 1);
    }
  };
  rec(0);
}

function evalArgs(argNodes, scope) {
  const args = [], kwargs = new Map();
  for (const a of argNodes) {
    if (a.kind === "pos") args.push(evaluate(a.v, scope));
    else if (a.kind === "star") args.push(...iterate(evaluate(a.v, scope)));
    else if (a.kind === "kw") kwargs.set(a.name, evaluate(a.v, scope));
    else if (a.kind === "kwargs") { const d = evaluate(a.v, scope); if (d instanceof Opaque) continue; for (const [k, v] of d.entries()) kwargs.set(k, v); }
  }
  return [args, kwargs];
}

export function evaluate(n, scope) {
  switch (n.k) {
    case "Const": return n.float ? new PyFloatV(n.v) : n.v;
    case "Name": return scope.get(n.id);
    case "JoinedStr": return n.parts.map((p) => (p.k === "Const" ? p.v : p.k === "JoinedStr" ? evaluate(p, scope) : fmtValue(p, scope))).join("");
    case "Attr": {
      if (n.v.k === "Call" && n.v.f.k === "Name" && n.v.f.id === "super") {
        // super().method: look the method up past the current class
        let s = scope; while (s && !s.funcClass) s = s.parent;
        const cls = s?.funcClass, self = s?.selfArg;
        for (const b of cls?.bases ?? []) {
          const m = b instanceof Klass ? b.lookup(n.name) : null;
          if (m instanceof Func) return new Bound(self, m);
          if (m instanceof Builtin) return new Bound(self, m);
        }
        return new Builtin("super-noop", () => null);
      }
      return getattr(evaluate(n.v, scope), n.name);
    }
    case "Call": {
      const f = evaluate(n.f, scope);
      const [args, kwargs] = evalArgs(n.args, scope);
      return call(f, args, kwargs);
    }
    case "Subscript": return getitem(evaluate(n.v, scope), n.idx.k === "Slice" ? { slice: true, lo: n.idx.lo ? evaluate(n.idx.lo, scope) : null, hi: n.idx.hi ? evaluate(n.idx.hi, scope) : null, step: n.idx.step ? evaluate(n.idx.step, scope) : null } : evaluate(n.idx, scope));
    case "Tuple": return new Tuple(n.elts.flatMap((e) => (e.k === "Starred" ? iterate(evaluate(e.v, scope)) : [evaluate(e, scope)])));
    case "List": return n.elts.flatMap((e) => (e.k === "Starred" ? iterate(evaluate(e.v, scope)) : [evaluate(e, scope)]));
    case "Set": return new PySetV(n.elts.flatMap((e) => (e.k === "Starred" ? iterate(evaluate(e.v, scope)) : [evaluate(e, scope)])));
    case "Dict": { const d = new Dict(); n.keys.forEach((k, i) => { if (k === null) { const o = evaluate(n.vals[i], scope); for (const [a, b] of o.entries()) d.set(a, b); } else d.set(evaluate(k, scope), evaluate(n.vals[i], scope)); }); return d; }
    case "ListComp": case "GeneratorExp": { const out = []; comprehend(n, scope, (s) => out.push(evaluate(n.elt, s))); return out; }
    case "SetComp": { const out = new PySetV(); comprehend(n, scope, (s) => { const v = evaluate(n.elt, s); out.m.set(keyOf(v), v); }); return out; }
    case "DictComp": { const d = new Dict(); comprehend(n, scope, (s) => d.set(evaluate(n.elt, s), evaluate(n.value, s))); return d; }
    case "BinOp": return binop(n.op, evaluate(n.a, scope), evaluate(n.b, scope));
    case "Unary": { const v = evaluate(n.v, scope); if (v instanceof Opaque) return v; return n.op === "-" ? (v instanceof PyFloatV ? new PyFloatV(-v.v) : -num(v)) : n.op === "+" ? v : ~num(v); }
    case "Not": return !truthy(evaluate(n.v, scope));
    case "BoolOp": { const a = evaluate(n.a, scope); if (n.op === "and") return truthy(a) ? evaluate(n.b, scope) : a; return truthy(a) ? a : evaluate(n.b, scope); }
    case "IfExp": return truthy(evaluate(n.test, scope)) ? evaluate(n.body, scope) : evaluate(n.orelse, scope);
    case "Compare": {
      let left = evaluate(n.left, scope);
      for (let i = 0; i < n.ops.length; i++) {
        const right = evaluate(n.comps[i], scope);
        const op = n.ops[i];
        let r;
        if (left instanceof Opaque || right instanceof Opaque) { if (op === "is" || op === "is not") r = (left === right) === (op === "is"); else throw new Error(`compare with opaque (${describe(left)} ${op} ${describe(right)})`); }
        else if (op === "==") r = eq(left, right); else if (op === "!=") r = !eq(left, right);
        else if (op === "is") r = left === right; else if (op === "is not") r = left !== right;
        else if (op === "in") r = contains(right, left); else if (op === "not in") r = !contains(right, left);
        else { const c = cmp(left, right); r = op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0; }
        if (!r) return false;
        left = right;
      }
      return true;
    }
    case "Lambda": { const def = { name: "<lambda>", params: n.params, body: [{ k: "Return", v: n.body }] }; return makeFunc(def, scope); }
    case "NamedExpr": { const v = evaluate(n.v, scope); scope.set(n.name, v); return v; }
    case "Starred": return evaluate(n.v, scope);
    case "Yield": { let s = scope; while (s && !s.yields) s = s.parent; if (s?.yields) { if (n.from) s.yields.push(...iterate(evaluate(n.v, scope))); else s.yields.push(n.v ? evaluate(n.v, scope) : null); } return null; }
    default: throw new Error(`expression ${n.k}`);
  }
}

function fmtValue(p, scope) {
  let v = evaluate(p.v, scope);
  if (p.conv === "r") v = pyRepr(v); else if (p.conv === "s") v = pyStr(v);
  const spec = p.spec ? evaluate(p.spec, scope) : "";
  if (v instanceof Opaque) throw new Error(`format opaque (${v.why})`);
  if (v instanceof Instance) { const m = findMethod(v, "__format__"); if (m) return call(m, [spec]); }
  return formatSpec(v, spec);
}

// -- modules ------------------------------------------------------------------------------
const MODULES = new Map();
let PKG_DIR = null, PKG_NAME = null;
const NATIVE = new Map();
export function registerNative(name, mod) { NATIVE.set(name, mod); }
export function setPackage(dir, name) { PKG_DIR = dir; PKG_NAME = name; }

export class ModuleScope {
  constructor(mod) { this.mod = mod; }
}

export function importModule(spec, fromMod) {
  let full = spec;
  if (spec.startsWith(".")) {
    const dots = /^\.+/.exec(spec)[0].length;
    const base = (fromMod?.pkg ?? PKG_NAME).split(".");
    const parent = base.slice(0, base.length - (dots - 1)).join(".");
    const rest = spec.slice(dots);
    full = rest ? `${parent}.${rest}` : parent;
  }
  if (MODULES.has(full)) return MODULES.get(full);
  if (NATIVE.has(full)) { MODULES.set(full, NATIVE.get(full)); return NATIVE.get(full); }
  if (full === PKG_NAME) {
    const m = new Module(full); m.isPackage = true; m.pkg = full; MODULES.set(full, m);
    m.lookup = (n) => { if (m.globals.has(n)) return m.globals.get(n); if (n === "__version__") return "0.8.0"; return importModule(`${full}.${n}`, m); };
    m.lazy = (n) => m.lookup(n);
    return m;
  }
  if (full.startsWith(PKG_NAME + ".")) {
    const rel = full.slice(PKG_NAME.length + 1).replace(/\./g, "/");
    const file = path.join(PKG_DIR, rel + ".py");
    if (!fs.existsSync(file)) { const o = OPAQUE(`module ${full}`); MODULES.set(full, o); return o; }
    const m = new Module(full); m.pkg = PKG_NAME; m.file = file;
    MODULES.set(full, m);
    const mscope = { mod: m, get: (n) => m.lookup(n), set: (n, v) => m.globals.set(n, v), vars: null };
    m.lookup = (n) => { if (m.globals.has(n)) return m.globals.get(n); if (n in BUILTINS) return BUILTINS[n]; if (n === "__name__") return full; if (n === "__file__") return file; throw new PyExc(new Error(`NameError ${n} in ${full}`)); };
    const body = parseModule(fs.readFileSync(file, "utf8"), path.basename(file));
    for (const st of body) {
      try { exec(st, mscope); }
      catch (e) {
        // A top-level statement the subset cannot run binds its names to opaque values.
        const names = st.k === "Assign" ? st.targets.flatMap(targetNames) : st.k === "AnnAssign" ? targetNames(st.target) : st.k === "ClassDef" || st.k === "FunctionDef" ? [st.name] : [];
        for (const nm of names) if (!m.globals.has(nm)) m.globals.set(nm, OPAQUE(`${full}.${nm}: ${String(e.message).slice(0, 80)}`));
      }
    }
    return m;
  }
  const o = OPAQUE(`module ${full}`);
  MODULES.set(full, o);
  return o;
}
function targetNames(t) { return t.k === "Name" ? [t.id] : t.k === "Tuple" || t.k === "List" ? t.elts.flatMap(targetNames) : []; }

// -- builtins ---------------------------------------------------------------------------------
const b = (name, fn) => new Builtin(name, fn);
export const BUILTINS = {
  sorted: b("sorted", ([it], k) => { const l = iterate(it); LIST_METHODS.sort(l, [], k); return l; }),
  len: b("len", ([x]) => (typeof x === "string" || Array.isArray(x) ? x.length : x instanceof Tuple ? x.items.length : x instanceof Dict ? x.m.size : x instanceof PySetV ? x.m.size : (() => { throw new Error(`len ${describe(x)}`); })())),
  str: b("str", ([x = ""]) => pyStr(x)), repr: b("repr", ([x]) => pyRepr(x)),
  int: b("int", ([x, base]) => (typeof x === "string" ? parseInt(x, base ?? 10) : Math.trunc(num(x)))),
  float: b("float", ([x]) => new PyFloatV(Number(num(typeof x === "string" ? Number(x) : x)))),
  bool: b("bool", ([x]) => truthy(x)),
  tuple: b("tuple", ([x]) => new Tuple(x === undefined ? [] : iterate(x))), list: b("list", ([x]) => (x === undefined ? [] : iterate(x))),
  set: b("set", ([x]) => new PySetV(x === undefined ? [] : iterate(x))), frozenset: b("frozenset", ([x]) => new PySetV(x === undefined ? [] : iterate(x))),
  dict: b("dict", ([x], k) => { const d = new Dict(); if (x) for (const [a, c] of x instanceof Dict ? x.entries() : iterate(x).map((t) => iterate(t))) d.set(a, c); for (const [a, c] of k) d.set(a, c); return d; }),
  min: b("min", (a, k) => { const l = a.length === 1 ? iterate(a[0]) : a; const key = kw(k, "key", null); if (!l.length) { if (k.has("default")) return k.get("default"); throw new Error("min empty"); } return l.reduce((p, c) => (cmp(key ? call(key, [c]) : c, key ? call(key, [p]) : p) < 0 ? c : p)); }),
  max: b("max", (a, k) => { const l = a.length === 1 ? iterate(a[0]) : a; const key = kw(k, "key", null); if (!l.length) { if (k.has("default")) return k.get("default"); throw new Error("max empty"); } return l.reduce((p, c) => (cmp(key ? call(key, [c]) : c, key ? call(key, [p]) : p) > 0 ? c : p)); }),
  range: b("range", ([a, c, s = 1]) => { const [lo, hi] = c === undefined ? [0, a] : [a, c]; const out = []; for (let i = lo; s > 0 ? i < hi : i > hi; i += s) out.push(i); return out; }),
  enumerate: b("enumerate", ([it, start = 0]) => iterate(it).map((x, i) => new Tuple([i + start, x]))),
  zip: b("zip", (its) => { const ls = its.map(iterate); const n = Math.min(...ls.map((l) => l.length)); return Array.from({ length: n }, (_, i) => new Tuple(ls.map((l) => l[i]))); }),
  reversed: b("reversed", ([x]) => iterate(x).reverse()),
  any: b("any", ([x]) => iterate(x).some(truthy)), all: b("all", ([x]) => iterate(x).every(truthy)),
  map: b("map", ([f, ...its]) => iterate(its[0]).map((x) => call(f, [x]))), filter: b("filter", ([f, it]) => iterate(it).filter((x) => (f === null ? truthy(x) : truthy(call(f, [x]))))),
  sum: b("sum", ([it, start = 0]) => iterate(it).reduce((p, c) => binop("+", p, c), start)),
  abs: b("abs", ([x]) => Math.abs(num(x))), round: b("round", ([x, n]) => (n === undefined ? Math.round(num(x)) : Number(num(x).toFixed(n)))),
  isinstance: b("isinstance", ([x, t]) => { const ts = t instanceof Tuple ? t.items : [t]; return ts.some((c) => (c === BUILTINS.str && typeof x === "string") || (c === BUILTINS.int && typeof x === "number") || (c === BUILTINS.bool && typeof x === "boolean") || (c === BUILTINS.tuple && x instanceof Tuple) || (c === BUILTINS.list && Array.isArray(x)) || (c === BUILTINS.dict && x instanceof Dict) || (c instanceof Klass && x instanceof Instance && isSub(x.cls, c))); }),
  getattr: b("getattr", ([o, n, d]) => getattr(o, n, d)), hasattr: b("hasattr", ([o, n]) => { try { getattr(o, n); return true; } catch { return false; } }), setattr: b("setattr", ([o, n, v]) => { setattr(o, n, v); return null; }),
  print: b("print", () => null), type: b("type", ([x]) => (x instanceof Instance ? x.cls : OPAQUE("type"))), id: b("id", () => 0), hash: b("hash", () => 0),
  callable: b("callable", ([x]) => x instanceof Func || x instanceof Builtin || x instanceof Klass || x instanceof Bound),
  iter: b("iter", ([x]) => iterate(x)), next: b("next", ([x, d]) => (Array.isArray(x) && x.length ? x.shift() : d)),
  object: new Klass("object", [], new Map(), null),
  Exception: new Klass("Exception", [], new Map(), null), ValueError: new Klass("ValueError", [], new Map(), null), TypeError: new Klass("TypeError", [], new Map(), null),
  RuntimeError: new Klass("RuntimeError", [], new Map(), null), OSError: new Klass("OSError", [], new Map(), null), KeyError: new Klass("KeyError", [], new Map(), null),
  NotImplementedError: new Klass("NotImplementedError", [], new Map(), null), FileNotFoundError: new Klass("FileNotFoundError", [], new Map(), null), SystemExit: new Klass("SystemExit", [], new Map(), null),
  AttributeError: new Klass("AttributeError", [], new Map(), null), IndexError: new Klass("IndexError", [], new Map(), null), LookupError: new Klass("LookupError", [], new Map(), null),
  NotImplemented: null, Ellipsis: "...", __name__: "__main__",
  format: b("format", ([v, spec = ""]) => formatSpec(v, spec)), chr: b("chr", ([x]) => String.fromCharCode(x)), ord: b("ord", ([x]) => x.charCodeAt(0)),
  property: b("property", ([f]) => { f.property = true; return f; }), staticmethod: b("staticmethod", ([f]) => f), classmethod: b("classmethod", ([f]) => f),
  super: b("super", () => OPAQUE("super")), vars: b("vars", ([x]) => { const d = new Dict(); if (x instanceof Instance) for (const [k, v] of x.attrs) d.set(k, v); return d; }),
};
function isSub(c, p) { if (c === p) return true; return c.bases.some((x) => x instanceof Klass && isSub(x, p)); }
