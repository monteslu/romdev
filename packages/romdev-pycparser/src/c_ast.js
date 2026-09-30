// c_ast.js - AST node classes, a port of pycparser's generated c_ast.py.
//
// The node shapes (constructor fields, children order, attr_names) are read
// from tables/c_ast.json, which scripts/gen-tables.mjs extracts from the
// upstream c_ast.py, so traversal order is exactly upstream's.
//
// Python -> JS conventions used throughout this package:
//   None -> null; a node's `coord` defaults to null.
//   Nodes compare by identity (upstream defines no __eq__).
//   `for c of node` iterates children like Node.__iter__.
import spec from "./tables/c_ast.json" with { type: "json" };

export class Node {
  /** A sequence of all children that are Nodes: [[name, node], ...]. */
  children() {
    const out = [];
    for (const [name, kind] of this.constructor.childSpec) {
      const v = this[name];
      if (kind === "single") { if (v != null) out.push([name, v]); }
      else if (v) for (let i = 0; i < v.length; i++) out.push([`${name}[${i}]`, v[i]]);
    }
    return out;
  }

  *[Symbol.iterator]() {
    for (const [name, kind] of this.constructor.childSpec) {
      const v = this[name];
      if (kind === "single") { if (v != null) yield v; }
      else if (v) yield* v;
    }
  }

  get attr_names() { return this.constructor.attrNames; }

  /** Pretty print the node and its children, like Node.show(). */
  show({ offset = 0, attrnames = false, showemptyattrs = true, nodenames = false, showcoord = false, _my_node_name = null } = {}) {
    let buf = "";
    const lead = " ".repeat(offset);
    if (nodenames && _my_node_name != null) buf += lead + this.constructor.name + " <" + _my_node_name + ">: ";
    else buf += lead + this.constructor.name + ": ";
    if (this.attr_names.length) {
      const isEmpty = (v) => v == null || (typeof v === "string" || Array.isArray(v)) && v.length === 0;
      const nvlist = this.attr_names.map((n) => [n, this[n]]).filter(([, v]) => showemptyattrs || !isEmpty(v));
      if (attrnames) buf += nvlist.map(([n, v]) => `${n}=${pyStr(v)}`).join(", ");
      else buf += nvlist.map(([, v]) => pyStr(v)).join(", ");
    }
    if (showcoord) buf += ` (at ${this.coord == null ? "None" : String(this.coord)})`;
    buf += "\n";
    for (const [childName, child] of this.children()) {
      buf += child.show({ offset: offset + 2, attrnames, showemptyattrs, nodenames, showcoord, _my_node_name: childName });
    }
    return buf;
  }
}

/** Python str() of an attribute value (lists print as reprs). */
export function pyStr(v) {
  if (v == null) return "None";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

export function pyRepr(v) {
  if (v == null) return "None";
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes("\"") ? "\"" : "'";
    let s = "";
    for (const ch of v) {
      if (ch === "\\") s += "\\\\";
      else if (ch === q) s += "\\" + q;
      else if (ch === "\n") s += "\\n";
      else if (ch === "\t") s += "\\t";
      else if (ch === "\r") s += "\\r";
      else s += ch;
    }
    return q + s + q;
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (v === true) return "True";
  if (v === false) return "False";
  if (v instanceof Node) return nodeRepr(v);
  return String(v);
}

function listRepr(obj) {
  if (Array.isArray(obj)) return "[" + obj.map((e) => listRepr(e).replaceAll("\n", "\n ")).join(",\n ") + "\n]";
  return pyRepr(obj);
}

/** Node.__repr__ */
export function nodeRepr(node) {
  const cls = node.constructor.name;
  let result = cls + "(";
  let indent = "", separator = "";
  for (const name of node.constructor.fields) {
    result += separator + indent;
    result += name + "=" + listRepr(node[name]).replaceAll("\n", "\n  " + " ".repeat(name.length + cls.length));
    separator = ",";
    indent = "\n " + " ".repeat(cls.length);
  }
  return result + indent + ")";
}

function isPlainObject(x) {
  return x != null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
}

/** @type {Record<string, typeof Node>} */
export const nodeClasses = {};

for (const def of spec) {
  const fields = def.fields;
  // Dynamic class with the upstream name (so constructor.name === "Decl" etc.).
  const cls = {
    [def.name]: class extends Node {
      constructor(...args) {
        super();
        // Keyword form: new Decl({name, quals, ...}) mirrors Python kwargs.
        if (args.length === 1 && isPlainObject(args[0]) && fields.length > 0) {
          const kw = args[0];
          for (const f of fields) this[f] = kw[f] === undefined ? null : kw[f];
          this.coord = kw.coord === undefined ? null : kw.coord;
          return;
        }
        for (let i = 0; i < fields.length; i++) this[fields[i]] = args[i] === undefined ? null : args[i];
        this.coord = args[fields.length] === undefined ? null : args[fields.length];
      }
    },
  }[def.name];
  cls.fields = fields;
  cls.childSpec = def.children;
  cls.attrNames = def.attrs;
  nodeClasses[def.name] = cls;
}

export const {
  ArrayDecl, ArrayRef, Asm, AsmOperand, Assignment, Alignas, BinaryOp, Break, Case, Cast, Compound,
  CompoundLiteral, Constant, Continue, Decl, DeclList, Default, DoWhile, EllipsisParam, EmptyStatement,
  Enum, Enumerator, EnumeratorList, ExprList, FileAST, For, FuncCall, FuncDecl, FuncDef, GccAttribute,
  GccAttributeStatement, Goto, ID, IdentifierType, If, InitList, Label, NamedInitializer, ParamList,
  PtrDecl, Range, Return, StaticAssert, Struct, StructRef, Switch, TernaryOp, TypeDecl, Typedef, Typename,
  Typeof, UnaryOp, Union, While, Pragma,
} = nodeClasses;

/**
 * A base NodeVisitor, like c_ast.NodeVisitor: subclass it and define
 * visit_XXX methods; generic_visit visits children in order.
 */
export class NodeVisitor {
  visit(node) {
    const m = this["visit_" + node.constructor.name];
    return m ? m.call(this, node) : this.generic_visit(node);
  }

  generic_visit(node) {
    for (const c of node) this.visit(c);
  }
}

/** True when `x` has a field named `name` (Python hasattr on a slotted node). */
export function hasField(x, name) {
  return x instanceof Node && x.constructor.fields.includes(name);
}
