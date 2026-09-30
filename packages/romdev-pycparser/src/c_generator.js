// c_generator.js - C code generator from AST nodes, a port of pycparser's
// c_generator.py (m2c / decomp-permuter fork). Output must be byte-identical
// to upstream: the permuter hashes it, compiles it, and writes it out.
import * as c_ast from "./c_ast.js";
import { AssertionError } from "./c_parser.js";

// Python truthiness for the values these nodes carry.
const T = (v) => !(v == null || v === false || v === "" || (Array.isArray(v) && v.length === 0));

const precedence_map = {
  "||": 0,
  "&&": 1,
  "|": 2,
  "^": 3,
  "&": 4,
  "==": 5, "!=": 5,
  ">": 6, ">=": 6, "<": 6, "<=": 6,
  ">>": 7, "<<": 7,
  "+": 8, "-": 8,
  "*": 9, "/": 9, "%": 9,
};

const STMT_EXPR_TYPES = new Set([
  c_ast.Decl, c_ast.Assignment, c_ast.Cast, c_ast.UnaryOp,
  c_ast.BinaryOp, c_ast.TernaryOp, c_ast.FuncCall, c_ast.ArrayRef,
  c_ast.StructRef, c_ast.Constant, c_ast.ID, c_ast.Typedef,
  c_ast.ExprList,
]);

export class CGenerator {
  constructor(reduce_parentheses = false) {
    this.indent_level = 0;
    this.reduce_parentheses = reduce_parentheses;
  }

  _make_indent() { return " ".repeat(this.indent_level); }

  visit(node) {
    // Upstream dispatches on the class name, so visit(None) reaches
    // generic_visit(None) and yields ''.
    if (node == null) return this.generic_visit(node);
    const m = this["visit_" + node.constructor.name];
    return m ? m.call(this, node) : this.generic_visit(node);
  }

  generic_visit(node) {
    if (node == null) return "";
    return node.children().map(([, c]) => this.visit(c)).join("");
  }

  visit_Constant(n) { return n.value; }

  visit_ID(n) { return n.name; }

  visit_Pragma(n) {
    let ret = "#pragma";
    if (T(n.string)) ret += " " + n.string;
    return ret;
  }

  visit_ArrayRef(n) {
    const arrref = this._parenthesize_unless_simple(n.name);
    return arrref + "[" + this.visit(n.subscript) + "]";
  }

  visit_StructRef(n) {
    const sref = this._parenthesize_unless_simple(n.name);
    return sref + n.type + this.visit(n.field);
  }

  visit_FuncCall(n) {
    const fref = this._parenthesize_unless_simple(n.name);
    return fref + "(" + this.visitOrNone(n.args) + ")";
  }

  /** self.visit(None) in upstream lands in generic_visit(None) -> ''. */
  visitOrNone(n) { return n == null ? "" : this.visit(n); }

  visit_Typeof(n) { return `typeof(${this.visit(n.expr)})`; }

  visit_UnaryOp(n) {
    if (n.op === "sizeof") return `sizeof(${this.visit(n.expr)})`;
    const operand = this._parenthesize_unless_simple(n.expr);
    if (n.op === "p++") return `${operand}++`;
    if (n.op === "p--") return `${operand}--`;
    return `${n.op}${operand}`;
  }

  visit_BinaryOp(n) {
    const lval_str = this._parenthesize_if(n.left, (d) => !(this._is_simple_node(d)
      || this.reduce_parentheses && d instanceof c_ast.BinaryOp && precedence_map[d.op] >= precedence_map[n.op]));
    const rval_str = this._parenthesize_if(n.right, (d) => !(this._is_simple_node(d)
      || this.reduce_parentheses && d instanceof c_ast.BinaryOp && precedence_map[d.op] > precedence_map[n.op]));
    return `${lval_str} ${n.op} ${rval_str}`;
  }

  visit_Assignment(n) {
    const rval_str = this._parenthesize_if(n.rvalue, (x) => x instanceof c_ast.Assignment);
    return `${this.visit(n.lvalue)} ${n.op} ${rval_str}`;
  }

  visit_IdentifierType(n) { return n.names.join(" "); }

  _visit_expr(n) {
    if (n instanceof c_ast.InitList) return "{" + this.visit(n) + "}";
    if (n instanceof c_ast.ExprList || n instanceof c_ast.Compound) return "(" + this.visit(n) + ")";
    return this.visit(n);
  }

  visit_Decl(n, no_type = false) {
    let s = no_type ? n.name : this._generate_decl(n);
    if (T(n.asmlabel)) s += " asm(" + this.visit(n.asmlabel) + ")";
    if (T(n.gcc_attributes)) s += this._generate_attrs(n.gcc_attributes);
    if (T(n.bitsize)) s += " : " + this.visit(n.bitsize);
    if (T(n.init)) s += " = " + this._visit_expr(n.init);
    return s;
  }

  visit_DeclList(n) {
    let s = this.visit(n.decls[0]);
    if (n.decls.length > 1) s += ", " + n.decls.slice(1).map((decl) => this.visit_Decl(decl, true)).join(", ");
    return s;
  }

  visit_Typedef(n) {
    let s = "";
    if (T(n.storage)) s += n.storage.join(" ") + " ";
    s += this._generate_type(n.type);
    return s;
  }

  visit_Cast(n) {
    const s = "(" + this._generate_type(n.to_type, [], false) + ")";
    return s + " " + this._parenthesize_unless_simple(n.expr);
  }

  visit_ExprList(n) { return n.exprs.map((e) => this._visit_expr(e)).join(", "); }

  visit_InitList(n) { return n.exprs.map((e) => this._visit_expr(e)).join(", "); }

  visit_Enum(n) { return this._generate_struct_union_enum(n, "enum"); }

  visit_Alignas(n) { return `_Alignas(${this.visit(n.alignment)})`; }

  visit_Enumerator(n) {
    if (!T(n.value)) return `${this._make_indent()}${n.name}${this._generate_attrs(n.gcc_attributes)},\n`;
    return `${this._make_indent()}${n.name}${this._generate_attrs(n.gcc_attributes)} = ${this.visit(n.value)},\n`;
  }

  visit_FuncDef(n) {
    const decl = this.visit(n.decl);
    this.indent_level = 0;
    const body = this.visit(n.body);
    if (T(n.param_decls)) {
      const knrdecls = n.param_decls.map((p) => this.visit(p)).join(";\n");
      return decl + "\n" + knrdecls + ";\n" + body + "\n";
    }
    return decl + "\n" + body + "\n";
  }

  visit_FileAST(n) {
    let s = "";
    for (const ext of n.ext) {
      if (ext instanceof c_ast.FuncDef) s += this.visit(ext);
      else if (ext instanceof c_ast.Pragma) s += this.visit(ext) + "\n";
      else s += this.visit(ext) + ";\n";
    }
    return s;
  }

  visit_Compound(n) {
    let s = this._make_indent() + "{\n";
    this.indent_level += 2;
    if (T(n.block_items)) s += n.block_items.map((stmt) => this._generate_stmt(stmt)).join("");
    this.indent_level -= 2;
    s += this._make_indent() + "}\n";
    return s;
  }

  visit_CompoundLiteral(n) { return "(" + this.visit(n.type) + "){" + this.visit(n.init) + "}"; }

  visit_GccAttributeStatement(n) { return this._generate_attrs(n.attrs).replace(/^\s+/, "") + ";"; }

  visit_EmptyStatement() { return ";"; }

  visit_ParamList(n) { return n.params.map((param) => this.visit(param)).join(", "); }

  visit_Return(n) {
    let s = "return";
    if (T(n.expr)) s += " " + this.visit(n.expr);
    return s + ";";
  }

  visit_Break() { return "break;"; }

  visit_Continue() { return "continue;"; }

  visit_TernaryOp(n) {
    let s = "(" + this._visit_expr(n.cond) + ") ? ";
    s += "(" + this._visit_expr(n.iftrue) + ") : ";
    s += "(" + this._visit_expr(n.iffalse) + ")";
    return s;
  }

  visit_If(n) {
    let s = "if (";
    if (T(n.cond)) s += this.visit(n.cond);
    s += ")\n";
    s += this._generate_stmt(n.iftrue, true);
    if (T(n.iffalse)) {
      s += this._make_indent() + "else\n";
      s += this._generate_stmt(n.iffalse, true);
    }
    return s;
  }

  visit_For(n) {
    let s = "for (";
    if (T(n.init)) s += this.visit(n.init);
    s += ";";
    if (T(n.cond)) s += " " + this.visit(n.cond);
    s += ";";
    if (T(n.next)) s += " " + this.visit(n.next);
    s += ")\n";
    s += this._generate_stmt(n.stmt, true);
    return s;
  }

  visit_While(n) {
    let s = "while (";
    if (T(n.cond)) s += this.visit(n.cond);
    s += ")\n";
    s += this._generate_stmt(n.stmt, true);
    return s;
  }

  visit_DoWhile(n) {
    let s = "do\n";
    s += this._generate_stmt(n.stmt, true);
    s += this._make_indent() + "while (";
    if (T(n.cond)) s += this.visit(n.cond);
    s += ");";
    return s;
  }

  visit_StaticAssert(n) {
    let s = "_Static_assert(";
    s += this.visit(n.cond);
    if (T(n.message)) {
      s += ",";
      s += this.visit(n.message);
    }
    s += ")";
    return s;
  }

  visit_Switch(n) {
    let s = "switch (" + this.visit(n.cond) + ")\n";
    s += this._generate_stmt(n.stmt, true);
    return s;
  }

  visit_Case(n) {
    let s = "case " + this.visit(n.expr) + ":\n";
    for (const stmt of n.stmts) s += this._generate_stmt(stmt, true);
    return s;
  }

  visit_Default(n) {
    let s = "default:\n";
    for (const stmt of n.stmts) s += this._generate_stmt(stmt, true);
    return s;
  }

  visit_Label(n) { return n.name + ":\n" + this._generate_stmt(n.stmt); }

  visit_Goto(n) { return "goto " + n.name + ";"; }

  visit_EllipsisParam() { return "..."; }

  visit_Struct(n) { return this._generate_struct_union_enum(n, "struct"); }

  visit_Typename(n) { return this._generate_type(n.type); }

  visit_Union(n) { return this._generate_struct_union_enum(n, "union"); }

  visit_NamedInitializer(n) {
    let s = "";
    for (const name of n.name) {
      if (name instanceof c_ast.ID) s += "." + name.name;
      else s += "[" + this.visit(name) + "]";
    }
    s += " = " + this._visit_expr(n.expr);
    return s;
  }

  visit_FuncDecl(n) { return this._generate_type(n); }

  visit_ArrayDecl(n) { return this._generate_type(n, [], false); }

  visit_TypeDecl(n) { return this._generate_type(n, [], false); }

  visit_PtrDecl(n) { return this._generate_type(n, [], false); }

  visit_Range(n) { return this.visit(n.first) + " ... " + this.visit(n.last); }

  visit_GccAttribute(n) {
    if (n.args == null) return n.name;
    return n.name + "(" + n.args.map((e) => this.visit(e)).join(", ") + ")";
  }

  visit_Asm(n) {
    let s = "asm" + n.quals.map((q) => " " + q).join("");
    s += "(" + this.visit(n.asm);
    const parts = [
      n.output_operands.map((op) => this.visit(op)).join(", "),
      n.input_operands.map((op) => this.visit(op)).join(", "),
      n.clobbers.map((cl) => this.visit(cl)).join(", "),
      n.gotos.join(", "),
    ];
    if (!n.quals.includes("goto")) {
      while (parts.length && !parts[parts.length - 1]) parts.pop();
    }
    for (const p of parts) {
      s += " :";
      if (p) s += " " + p;
    }
    s += ");";
    return s;
  }

  visit_AsmOperand(n) {
    const s = n.symbolic_name != null ? "[" + n.symbolic_name + "]" : "";
    return s + this.visit(n.constraint) + "(" + this.visit(n.expr) + ")";
  }

  _generate_struct_union_enum(n, name) {
    let members, body_function;
    if (name === "struct" || name === "union") {
      members = n.decls;
      body_function = (m) => this._generate_struct_union_body(m);
    } else {
      if (name !== "enum") throw new AssertionError();
      members = n.values == null ? null : n.values.enumerators;
      body_function = (m) => this._generate_enum_body(m);
    }
    let s = name + " " + (T(n.name) ? n.name : "");
    if (members != null) {
      s += "\n";
      s += this._make_indent();
      this.indent_level += 2;
      s += "{\n";
      s += body_function(members);
      this.indent_level -= 2;
      s += this._make_indent() + "}";
    }
    s += this._generate_attrs(n.gcc_attributes);
    return s;
  }

  _generate_struct_union_body(members) { return members.map((decl) => this._generate_stmt(decl)).join(""); }

  _generate_enum_body(members) {
    return members.map((value) => this.visit(value)).join("").slice(0, -2) + "\n";
  }

  _generate_stmt(n, add_indent = false) {
    const typ = n == null ? null : n.constructor;
    if (add_indent) this.indent_level += 2;
    const indent = this._make_indent();
    if (add_indent) this.indent_level -= 2;
    if (STMT_EXPR_TYPES.has(typ)) return indent + this.visit(n) + ";\n";
    if (typ === c_ast.Compound) return this.visit(n);
    if (typ === c_ast.If) return indent + this.visit(n);
    return indent + this.visit(n) + "\n";
  }

  _generate_decl(n) {
    let s = "";
    if (T(n.funcspec)) s = n.funcspec.join(" ") + " ";
    if (T(n.storage)) s += n.storage.join(" ") + " ";
    if (T(n.align)) s += this.visit(n.align[0]) + " ";
    s += this._generate_type(n.type);
    return s;
  }

  _generate_type(n, modifiers = [], emit_declname = true) {
    const typ = n == null ? null : n.constructor;
    if (typ === c_ast.TypeDecl) {
      let s = "";
      if (T(n.quals)) s += n.quals.join(" ") + " ";
      s += this.visitOrNone(n.type);
      let nstr = T(n.declname) && emit_declname ? n.declname : "";
      modifiers.forEach((modifier, i) => {
        if (modifier instanceof c_ast.ArrayDecl) {
          if (i !== 0 && modifiers[i - 1] instanceof c_ast.PtrDecl) nstr = "(" + nstr + ")";
          nstr += "[";
          if (T(modifier.dim_quals)) nstr += modifier.dim_quals.join(" ") + " ";
          nstr += this.visitOrNone(modifier.dim) + "]";
        } else if (modifier instanceof c_ast.FuncDecl) {
          if (i !== 0 && modifiers[i - 1] instanceof c_ast.PtrDecl) nstr = "(" + nstr + ")";
          nstr += "(" + this.visitOrNone(modifier.args) + ")";
        } else if (modifier instanceof c_ast.PtrDecl) {
          if (T(modifier.quals)) nstr = `* ${modifier.quals.join(" ")}${nstr ? " " + nstr : ""}`;
          else nstr = "*" + nstr;
        }
      });
      if (nstr) s += " " + nstr;
      return s;
    }
    if (typ === c_ast.Decl) return this._generate_decl(n.type);
    if (typ === c_ast.Typename) return this._generate_type(n.type, [], emit_declname);
    if (typ === c_ast.IdentifierType) return n.names.join(" ") + " ";
    if (typ === c_ast.ArrayDecl || typ === c_ast.PtrDecl || typ === c_ast.FuncDecl) {
      return this._generate_type(n.type, modifiers.concat([n]), emit_declname);
    }
    return this.visitOrNone(n);
  }

  _generate_attrs(attrs) {
    if (!T(attrs)) return "";
    const li = attrs.map((attr) => this.visit(attr));
    return " __attribute__((" + li.join(", ") + "))";
  }

  _parenthesize_if(n, condition) {
    const s = this._visit_expr(n);
    return condition(n) ? "(" + s + ")" : s;
  }

  _parenthesize_unless_simple(n) { return this._parenthesize_if(n, (d) => !this._is_simple_node(d)); }

  _is_simple_node(n) {
    return n instanceof c_ast.Constant || n instanceof c_ast.ID || n instanceof c_ast.ArrayRef
      || n instanceof c_ast.StructRef || n instanceof c_ast.FuncCall;
  }
}
