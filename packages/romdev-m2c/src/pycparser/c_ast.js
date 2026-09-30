// pycparser: c_ast.js - AST node classes (port of m2c_pycparser/c_ast.py,
// which is generated from _c_ast.cfg). Copyright (c) 2008-2022 Eli
// Bendersky, BSD licence (see NOTICE).
//
// Every class takes the same positional constructor arguments as the Python
// class, in `__slots__` order, with an optional trailing `coord`.
// `Class.__slots__` lists the attribute order (without coord).
import { pyStrRepr, str } from "../py.js";

// Entry syntax as in _c_ast.cfg: name* = child, name** = child sequence.
const SPEC = `
ArrayDecl: [type*, dim*, dim_quals]
ArrayRef: [name*, subscript*]
Asm: [quals, asm*, output_operands**, input_operands**, clobbers**, gotos]
AsmOperand: [symbolic_name, constraint*, expr*]
Assignment: [op, lvalue*, rvalue*]
Alignas: [alignment*]
BinaryOp: [op, left*, right*]
Break: []
Case: [expr*, stmts**]
Cast: [to_type*, expr*]
Compound: [block_items**]
CompoundLiteral: [type*, init*]
Constant: [type, value]
Continue: []
Decl: [name, quals, align, storage, funcspec, gcc_attributes**, type*, init*, bitsize*, asmlabel*]
DeclList: [decls**]
Default: [stmts**]
DoWhile: [cond*, stmt*]
EllipsisParam: []
EmptyStatement: []
Enum: [name, gcc_attributes**, values*]
Enumerator: [name, gcc_attributes, value*]
EnumeratorList: [enumerators**]
ExprList: [exprs**]
FileAST: [ext**]
For: [init*, cond*, next*, stmt*]
FuncCall: [name*, args*]
FuncDecl: [args*, type*]
FuncDef: [decl*, param_decls**, body*]
GccAttribute: [name, args**]
GccAttributeStatement: [attrs**]
Goto: [name]
ID: [name]
IdentifierType: [names]
If: [cond*, iftrue*, iffalse*]
InitList: [exprs**]
Label: [name, stmt*]
NamedInitializer: [name**, expr*]
ParamList: [params**]
PtrDecl: [quals, type*]
Range: [first*, last*]
Return: [expr*]
StaticAssert: [cond*, message*]
Struct: [name, gcc_attributes**, decls**]
StructRef: [name*, type, field*]
Switch: [cond*, stmt*]
TernaryOp: [cond*, iftrue*, iffalse*]
TypeDecl: [declname, quals, align, type*]
Typedef: [name, quals, storage, gcc_attributes**, type*]
Typename: [name, quals, align, gcc_attributes**, type*]
Typeof: [expr*]
UnaryOp: [op, expr*]
Union: [name, gcc_attributes**, decls**]
While: [cond*, stmt*]
Pragma: [string]
`;

function _repr(obj) {
  if (Array.isArray(obj)) return "[" + obj.map((e) => _repr(e).replace(/\n/g, "\n ")).join(",\n ") + "\n]";
  if (obj instanceof Node) return obj.__repr__();
  if (typeof obj === "string") return pyStrRepr(obj);
  if (obj === null || obj === undefined) return "None";
  if (obj === true) return "True";
  if (obj === false) return "False";
  if (obj && typeof obj.__repr__ === "function") return obj.__repr__();
  return String(obj);
}

/** Abstract base class for AST nodes. */
export class Node {
  __repr__() {
    const cls = this.constructor.name;
    let result = cls + "(";
    let indent = "";
    let separator = "";
    for (const name of this.constructor.__slots__) {
      result += separator;
      result += indent;
      result += name + "=" + _repr(this[name]).replace(/\n/g, "\n  " + " ".repeat(name.length + cls.length));
      separator = ",";
      indent = "\n " + " ".repeat(cls.length);
    }
    result += indent + ")";
    return result;
  }
  toString() {
    return this.__repr__();
  }
  children() {
    return [];
  }
  *[Symbol.iterator]() {
    for (const [, c] of this.children()) yield c;
  }
  get attr_names() {
    return this.constructor.attr_names;
  }
  /**
   * Pretty print the node and its children to `buf` (an object with a
   * write(string) method).
   */
  show(buf, { offset = 0, attrnames = false, showemptyattrs = true, nodenames = false, showcoord = false, _my_node_name = null } = {}) {
    const lead = " ".repeat(offset);
    if (nodenames && _my_node_name !== null) buf.write(lead + this.constructor.name + " <" + _my_node_name + ">: ");
    else buf.write(lead + this.constructor.name + ": ");
    if (this.attr_names.length) {
      const isEmpty = (v) => v === null || v === undefined || ((typeof v === "string" || Array.isArray(v)) && v.length === 0);
      const nvlist = this.attr_names.map((n) => [n, this[n]]).filter(([, v]) => showemptyattrs || !isEmpty(v));
      const attrstr = attrnames ? nvlist.map(([n, v]) => `${n}=${str(v)}`).join(", ") : nvlist.map(([, v]) => str(v)).join(", ");
      buf.write(attrstr);
    }
    if (showcoord) buf.write(" (at " + str(this.coord) + ")");
    buf.write("\n");
    for (const [childName, child] of this.children()) {
      child.show(buf, { offset: offset + 2, attrnames, showemptyattrs, nodenames, showcoord, _my_node_name: childName });
    }
  }
}

/**
 * Base visitor: define visit_<ClassName>(node) methods in a subclass;
 * generic_visit visits all children in order.
 */
export class NodeVisitor {
  visit(node) {
    const method = this["visit_" + node.constructor.name];
    if (typeof method === "function") return method.call(this, node);
    return this.generic_visit(node);
  }
  generic_visit(node) {
    for (const c of node) this.visit(c);
  }
}

function makeNodeClass(name, entries) {
  const all = [];
  const child = [];
  const seqChild = [];
  const attr = [];
  for (const e of entries) {
    const clean = e.replace(/\*+$/, "");
    all.push(clean);
    if (e.endsWith("**")) seqChild.push(clean);
    else if (e.endsWith("*")) child.push(clean);
    else attr.push(e);
  }
  const cls = {
    [name]: class extends Node {
      constructor(...args) {
        super();
        for (let i = 0; i < all.length; i++) this[all[i]] = args[i] === undefined ? null : args[i];
        this.coord = args[all.length] === undefined ? null : args[all.length];
      }
      children() {
        const nodelist = [];
        for (const c of child) if (this[c] !== null && this[c] !== undefined) nodelist.push([c, this[c]]);
        for (const c of seqChild) (this[c] || []).forEach((ch, i) => nodelist.push([`${c}[${i}]`, ch]));
        return nodelist;
      }
      *[Symbol.iterator]() {
        for (const c of child) if (this[c] !== null && this[c] !== undefined) yield this[c];
        for (const c of seqChild) for (const ch of this[c] || []) yield ch;
      }
    },
  }[name];
  cls.__slots__ = all;
  cls.attr_names = attr;
  return cls;
}

const classes = {};
for (const line of SPEC.trim().split("\n")) {
  const m = /^(\w+): \[(.*)\]$/.exec(line.trim());
  const entries = m[2].trim() ? m[2].split(",").map((s) => s.trim()) : [];
  classes[m[1]] = makeNodeClass(m[1], entries);
}

export const ArrayDecl = classes.ArrayDecl;
export const ArrayRef = classes.ArrayRef;
export const Asm = classes.Asm;
export const AsmOperand = classes.AsmOperand;
export const Assignment = classes.Assignment;
export const Alignas = classes.Alignas;
export const BinaryOp = classes.BinaryOp;
export const Break = classes.Break;
export const Case = classes.Case;
export const Cast = classes.Cast;
export const Compound = classes.Compound;
export const CompoundLiteral = classes.CompoundLiteral;
export const Constant = classes.Constant;
export const Continue = classes.Continue;
export const Decl = classes.Decl;
export const DeclList = classes.DeclList;
export const Default = classes.Default;
export const DoWhile = classes.DoWhile;
export const EllipsisParam = classes.EllipsisParam;
export const EmptyStatement = classes.EmptyStatement;
export const Enum = classes.Enum;
export const Enumerator = classes.Enumerator;
export const EnumeratorList = classes.EnumeratorList;
export const ExprList = classes.ExprList;
export const FileAST = classes.FileAST;
export const For = classes.For;
export const FuncCall = classes.FuncCall;
export const FuncDecl = classes.FuncDecl;
export const FuncDef = classes.FuncDef;
export const GccAttribute = classes.GccAttribute;
export const GccAttributeStatement = classes.GccAttributeStatement;
export const Goto = classes.Goto;
export const ID = classes.ID;
export const IdentifierType = classes.IdentifierType;
export const If = classes.If;
export const InitList = classes.InitList;
export const Label = classes.Label;
export const NamedInitializer = classes.NamedInitializer;
export const ParamList = classes.ParamList;
export const PtrDecl = classes.PtrDecl;
export const Range = classes.Range;
export const Return = classes.Return;
export const StaticAssert = classes.StaticAssert;
export const Struct = classes.Struct;
export const StructRef = classes.StructRef;
export const Switch = classes.Switch;
export const TernaryOp = classes.TernaryOp;
export const TypeDecl = classes.TypeDecl;
export const Typedef = classes.Typedef;
export const Typename = classes.Typename;
export const Typeof = classes.Typeof;
export const UnaryOp = classes.UnaryOp;
export const Union = classes.Union;
export const While = classes.While;
export const Pragma = classes.Pragma;

/** All node classes by name. */
export const NODE_CLASSES = classes;
