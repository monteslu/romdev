// Port of m2c/if_statements.py
/* eslint no-unused-vars: ["error", { "args": "none" }] -- keeps upstream's parameter lists */
import { BasicNode, ConditionalNode, ReturnNode, SwitchNode, TerminalNode } from "./flow_graph.js";
import { Target } from "./options.js";
import { BinaryOp, CommaConditionExpr, Condition, Literal, SwitchControl, early_unwrap_ints, format_expr, get_block_info, simplify_condition } from "./translate.js";
import { Type } from "./types.js";
import { DefaultMap, dcinit, dcreplace, factory, format, lstrip, pyassert, pyeq, sorted } from "./py.js";

export class Context {
  constructor({ flow_graph, fmt, options, is_void = true }) {
    this.flow_graph = flow_graph;
    this.fmt = fmt;
    this.options = options;
    this.is_void = is_void;
    this.switch_nodes = new Map();
    this.case_nodes = new DefaultMap(() => []);
    this.goto_nodes = new Set();
    this.emitted_nodes = new Set();
    this.has_warned = false;
  }
  add_switch(node) {
    this.switch_nodes.set(node, 0);
    return new SwitchIndex(this, node);
  }
}

export class IfElseStatement {
  constructor(condition, if_body, else_body = null) {
    this.condition = condition;
    this.if_body = if_body;
    this.else_body = else_body;
  }
  should_write() {
    return true;
  }
  format(fmt) {
    const space = fmt.indent("");
    const condition = simplify_condition(this.condition);
    const cond_str = format_expr(condition, fmt);
    const after_ifelse = fmt.coding_style.newline_after_if ? `\n${space}` : " ";
    const before_else = fmt.coding_style.newline_before_else ? `\n${space}` : " ";
    let if_str = fmt.indented(() => [`${space}if (${cond_str})${after_ifelse}{`, this.if_body.format(fmt), `${space}}`].join("\n"));
    if (this.else_body !== null && !this.else_body.is_empty()) {
      const sub_if = this.else_body.get_lone_if_statement();
      let else_str;
      if (sub_if) {
        const sub_if_str = lstrip(sub_if.format(fmt));
        else_str = `${before_else}else ${sub_if_str}`;
      } else {
        else_str = fmt.indented(() => [`${before_else}else${after_ifelse}{`, this.else_body.format(fmt), `${space}}`].join("\n"));
      }
      if_str = if_str + else_str;
    }
    return if_str;
  }
}

export class SwitchIndex {
  constructor(context, node) {
    this.context = context;
    this.node = node;
  }
  equals(other) {
    return other instanceof SwitchIndex && this.context === other.context && this.node === other.node;
  }
  to_comment(fmt) {
    const index = this.context.switch_nodes.get(this.node);
    if (this.context.switch_nodes.size === 1) return null;
    return `switch ${index + 1}`;
  }
}

export class SwitchStatement {
  constructor(jump, body, index) {
    this.jump = jump;
    this.body = body;
    this.index = index;
  }
  should_write() {
    return true;
  }
  format(fmt) {
    const lines = [];
    const comments = [];
    const body_is_empty = this.body.is_empty();
    const comment = this.index.to_comment(fmt);
    if (comment) comments.push(comment);
    if (this.jump.is_irregular) comments.push("irregular");
    else if (this.jump.num_cases === null) comments.push("unable to parse jump table");
    else if (this.jump.jump_table !== null && body_is_empty) comments.push(`jump table: ${this.jump.jump_table.c_symbol_name}`);
    const head = `switch (${format_expr(this.jump.control_expr, fmt)})`;
    if (body_is_empty) lines.push(fmt.with_comments(`${head};`, comments));
    else {
      if (fmt.coding_style.newline_after_if) {
        lines.push(fmt.with_comments(`${head}`, comments));
        lines.push(fmt.indent("{"));
      } else lines.push(fmt.with_comments(`${head} {`, comments));
      fmt.indented(fmt.coding_style.switch_indent_level, () => lines.push(this.body.format(fmt)));
      lines.push(fmt.indent("}"));
    }
    return lines.join("\n");
  }
}

export class SimpleStatement {
  static __fields = [["contents"], ["comments", factory(() => [])], ["is_jump", false], ["indent", 0]];
  constructor(...args) {
    dcinit(this, args);
  }
  should_write() {
    return this.contents !== null || this.comments.length > 0;
  }
  format(fmt) {
    let content;
    if (this.contents === null) content = "";
    else if (typeof this.contents === "string") content = this.contents;
    else content = this.contents.format(fmt);
    const comments = [];
    for (const c of this.comments) {
      if (typeof c === "string") comments.push(c);
      else {
        const co = c(fmt);
        if (co !== null) comments.push(co);
      }
    }
    return fmt.with_comments(content, comments, { indent: this.indent });
  }
  clear() {
    this.contents = null;
    this.comments = [];
  }
}

export class LabelStatement {
  constructor(context, node) {
    this.context = context;
    this.node = node;
  }
  should_write() {
    const cn = this.context.case_nodes.peek(this.node);
    return this.context.goto_nodes.has(this.node) || Boolean(cn && cn.length);
  }
  format(fmt) {
    const lines = [];
    if (this.context.case_nodes.has(this.node)) {
      for (const [index, case_label] of this.context.case_nodes.get(this.node)) {
        const comment = index.to_comment(fmt);
        const comments = comment ? [comment] : [];
        lines.push(fmt.with_comments(`${case_label}:`, comments, { indent: -1 }));
      }
    }
    if (this.context.goto_nodes.has(this.node)) lines.push(`${label_for_node(this.context, this.node)}:`);
    return lines.join("\n");
  }
}

export class DoWhileLoop {
  constructor(body, condition) {
    this.body = body;
    this.condition = condition;
  }
  should_write() {
    return true;
  }
  format(fmt) {
    const space = fmt.indent("");
    const after_do = fmt.coding_style.newline_after_if ? `\n${space}` : " ";
    const cond = format_expr(simplify_condition(this.condition), fmt);
    return fmt.indented(() => [`${space}do${after_do}{`, this.body.format(fmt), `${space}} while (${cond});`].join("\n"));
  }
}

export class Body {
  constructor(print_node_comment, statements = []) {
    this.print_node_comment = print_node_comment;
    this.statements = statements;
  }
  extend(other) {
    this.print_node_comment = this.print_node_comment || other.print_node_comment;
    this.statements.push(...other.statements);
  }
  add_node(node, comment_empty) {
    const block_info = get_block_info(node);
    const statements = block_info.statements_to_write();
    if (this.print_node_comment && (statements.length || comment_empty)) this.add_comment(`Node ${node.name()}`);
    for (const item of statements) this.statements.push(new SimpleStatement(item));
  }
  add_statement(statement) {
    this.statements.push(statement);
  }
  add_comment(contents) {
    this.add_statement(new SimpleStatement(null, { comments: [contents] }));
  }
  add_if_else(if_else) {
    if (if_else.else_body === null || if_else.if_body.ends_in_jump()) {
      this.statements.push(rewrite_if_ands(if_else.condition, if_else.if_body));
      if (if_else.else_body !== null) this.extend(if_else.else_body);
    } else this.statements.push(if_else);
  }
  add_do_while_loop(do_while_loop) {
    this.statements.push(do_while_loop);
  }
  add_switch(sw) {
    this.add_statement(sw);
  }
  is_empty() {
    return !this.statements.some((s) => s.should_write());
  }
  ends_in_jump() {
    for (let i = this.statements.length - 1; i >= 0; i--) {
      const statement = this.statements[i];
      if (!statement.should_write()) continue;
      return statement instanceof SimpleStatement && statement.is_jump;
    }
    return false;
  }
  get_lone_if_statement() {
    let ret = null;
    for (const statement of this.statements) {
      if (statement.should_write()) {
        if (!(statement instanceof IfElseStatement) || ret) return null;
        ret = statement;
      }
    }
    return ret;
  }
  elide_empty_returns() {
    for (let i = this.statements.length - 1; i >= 0; i--) {
      const statement = this.statements[i];
      if (statement instanceof SimpleStatement && statement.contents === "return;") statement.clear();
      if (!statement.should_write()) continue;
      if (statement instanceof IfElseStatement) {
        statement.if_body.elide_empty_returns();
        if (statement.else_body !== null) statement.else_body.elide_empty_returns();
      }
      break;
    }
  }
  format(fmt) {
    return this.statements
      .filter((s) => s.should_write())
      .map((s) => s.format(fmt))
      .join("\n");
  }
}

/** Iterate through the left-heavy `&&`-joined subconditions, rewriting CommaConditionExprs into nested ifs. */
export function rewrite_if_ands(condition, if_body) {
  let outer_cond = condition;
  const inner_conds = [];
  while (outer_cond instanceof BinaryOp && outer_cond.left instanceof Condition && outer_cond.op === "&&" && outer_cond.right instanceof Condition) {
    const cond = outer_cond.right;
    outer_cond = outer_cond.left;
    if (!(cond instanceof CommaConditionExpr)) inner_conds.push(cond);
    else {
      let inner_cond = cond.condition;
      while (inner_conds.length) inner_cond = join_conditions(inner_cond, "&&", inner_conds.pop());
      const new_body = new Body(if_body.print_node_comment);
      for (const stmt of cond.statements) new_body.add_statement(new SimpleStatement(stmt));
      new_body.add_if_else(new IfElseStatement(inner_cond, if_body, null));
      if_body = new_body;
      condition = outer_cond;
    }
  }
  return new IfElseStatement(condition, if_body, null);
}

export function label_for_node(context, node) {
  if (node.loop) return `loop_${node.block.index}`;
  return `block_${node.block.index}`;
}

/** Try to emit a node for the first time, together with a label for it. */
export function emit_node(context, node, body) {
  if (context.emitted_nodes.has(node)) {
    if (!(node instanceof ReturnNode)) {
      emit_goto(context, node, body);
      return false;
    } else body.add_comment(`Duplicate return node #${node.name()}. Try simplifying control flow for better match`);
  } else {
    body.add_statement(new LabelStatement(context, node));
    context.emitted_nodes.add(node);
  }
  body.add_node(node, true);
  if (node instanceof ReturnNode) emit_return(context, node, body);
  return true;
}

export function emit_goto(context, target, body) {
  pyassert(!(target instanceof TerminalNode), "cannot goto a TerminalNode");
  const label = label_for_node(context, target);
  context.goto_nodes.add(target);
  body.add_statement(new SimpleStatement(`goto ${label};`, { is_jump: true }));
}

export function add_labels_for_switch(context, node, case_type, cases, default_node) {
  pyassert(cases.length, "jtbl list must not be empty");
  const switch_index = context.add_switch(node);
  const indexes = sorted(cases.map(([i]) => i));
  const use_hex = context.fmt.coding_style.hex_case || (Math.min(...indexes) >= 0 && Math.max(...indexes) > 50);

  const skipped_labels = [];
  let emitted_label_count = 0;

  for (const [index, target] of cases) {
    const enum_name = case_type.get_enum_name(index);
    let case_label;
    if (enum_name) case_label = `case ${enum_name}`;
    else if (use_hex) {
      if (index < 0) case_label = `case -0x${format(-index, "X")}`;
      else case_label = `case 0x${format(index, "X")}`;
    } else case_label = `case ${index}`;

    if (is_empty_goto(target, default_node) || is_empty_goto(target, node.immediate_postdominator)) skipped_labels.push([target, [switch_index, case_label]]);
    else {
      context.case_nodes.get(target).push([switch_index, case_label]);
      emitted_label_count += 1;
    }
  }

  if (default_node !== null) {
    context.case_nodes.get(default_node).push([switch_index, "default"]);
    emitted_label_count += 1;
  }

  if (emitted_label_count < 5) for (const [target, label] of skipped_labels) context.case_nodes.get(target).push(label);
  return switch_index;
}

/** If `node` is a switch bounds-check ConditionalNode, return the switch's control expression. */
export function switch_guard_expr(node) {
  if (!(node instanceof ConditionalNode)) return null;
  const cond = get_block_info(node).branch_condition;
  pyassert(cond !== null);
  const switch_node = node.fallthrough_edge;
  if (!(switch_node instanceof SwitchNode)) return null;
  const switch_block_info = get_block_info(switch_node);
  pyassert(switch_block_info.switch_control !== null);
  if (
    switch_node.parents.length === 1 &&
    switch_node.parents[0] === node &&
    !switch_block_info.statements_to_write().length &&
    switch_block_info.switch_control.matches_guard_condition(cond)
  ) {
    return switch_block_info.switch_control.control_expr;
  }
  return null;
}

/** Return true if `node` represents a jump to `end` without any other statements */
export function is_empty_goto(node, end) {
  if (end === null) return false;
  const seen_nodes = new Set([node]);
  for (;;) {
    if (node === end) return true;
    const block_info = get_block_info(node);
    if (block_info.statements_to_write().length) return false;
    if (node instanceof ReturnNode && end instanceof TerminalNode && block_info.return_value === null) return true;
    else if (node instanceof BasicNode) {
      node = node.successor;
      if (seen_nodes.has(node)) return false;
      seen_nodes.add(node);
    } else return false;
  }
}

export function gather_any_comma_conditions(block_info) {
  const branch_condition = block_info.branch_condition;
  pyassert(branch_condition !== null);
  const comma_statements = block_info.statements_to_write();
  if (comma_statements.length) {
    pyassert(!(branch_condition instanceof CommaConditionExpr));
    return new CommaConditionExpr(comma_statements, branch_condition);
  }
  return branch_condition;
}

/** Utility class for tracking possible switch control values across multiple conditional branches. */
export class Bounds {
  static __fields = [["lower", -(2 ** 31)], ["upper", 2 ** 32 - 1], ["holes", factory(() => new Set())]];
  constructor(...args) {
    dcinit(this, args);
    pyassert(this.lower <= this.upper);
  }
  without(hole) {
    return dcreplace(this, { holes: new Set([...this.holes, hole]) });
  }
  at_most(val) {
    if (this.lower <= val && val <= this.upper) return dcreplace(this, { upper: val });
    else if (val > this.upper) return this;
    return Bounds.empty();
  }
  at_least(val) {
    if (this.lower <= val && val <= this.upper) return dcreplace(this, { lower: val });
    else if (val < this.lower) return this;
    return Bounds.empty();
  }
  values({ max_count }) {
    const values = [];
    for (let i = this.lower; i < this.upper + 1; i++) {
      if (!this.holes.has(i)) {
        values.push(i);
        if (values.length > max_count) return null;
      }
    }
    return values;
  }
  static empty() {
    return new Bounds({ lower: 0, upper: 0, holes: new Set([0]) });
  }
}

/** Try to express the nodes in `chained_cond_nodes` as a single Condition. Returns [cond, if_node, else_node] or null. */
export function try_make_if_condition(chained_cond_nodes, end) {
  const start_node = chained_cond_nodes[0];
  let if_node = chained_cond_nodes[chained_cond_nodes.length - 1].fallthrough_edge;
  let else_node = chained_cond_nodes[chained_cond_nodes.length - 1].conditional_edge;
  pyassert(else_node !== null);

  const allowed_nodes = new Set([...chained_cond_nodes, if_node, else_node]);
  const node_cond_edges = new Map();
  for (const node of chained_cond_nodes) {
    if (!allowed_nodes.has(node.conditional_edge) || !allowed_nodes.has(node.fallthrough_edge)) return null;
    allowed_nodes.delete(node);
    const block_info = get_block_info(node);
    let cond;
    if (node === start_node) {
      cond = block_info.branch_condition;
      pyassert(cond instanceof Condition);
    } else cond = gather_any_comma_conditions(block_info);
    node_cond_edges.set(node, [cond, node.conditional_edge, node.fallthrough_edge]);
  }

  for (;;) {
    const node_parents = new Map();
    for (const node of node_cond_edges.keys()) node_parents.set(node, []);
    for (const [node, edges] of node_cond_edges) {
      for (const child of edges.slice(1)) {
        if (child !== if_node && child !== else_node) {
          pyassert(child instanceof ConditionalNode);
          if (!node_parents.has(child)) throw new Error("KeyError: node");
          node_parents.get(child).push(node);
        }
      }
    }

    let found = false;
    for (const [child, parents] of node_parents) {
      if (parents.length !== 1) continue;
      const parent = parents[0];
      const [child_cond, child_if, child_else] = node_cond_edges.get(child);
      let [parent_cond, parent_if, parent_else] = node_cond_edges.get(parent);
      let cond;
      if (parent_if === child_if && parent_else === child) {
        parent_else = child_else;
        cond = join_conditions(parent_cond, "||", child_cond);
      } else if (parent_if === child_else && parent_else === child) {
        parent_else = child_if;
        cond = join_conditions(parent_cond, "||", child_cond.negated());
      } else if (parent_if === child && parent_else === child_if) {
        parent_if = child_else;
        cond = join_conditions(parent_cond, "&&", child_cond.negated());
      } else if (parent_if === child && parent_else === child_else) {
        parent_if = child_if;
        cond = join_conditions(parent_cond, "&&", child_cond);
      } else continue;
      node_cond_edges.set(parent, [cond, parent_if, parent_else]);
      node_cond_edges.delete(child);
      found = true;
      break;
    }
    if (!found) break;
  }

  if (node_cond_edges.size !== 1 || !node_cond_edges.has(start_node)) return null;
  let [cond, left_node, right_node] = node_cond_edges.get(start_node);

  if (left_node === else_node && right_node === if_node) cond = cond.negated();
  else pyassert(left_node === if_node && right_node === else_node);

  if (else_node === end) else_node = null;
  else if (if_node === end) {
    cond = cond.negated();
    if_node = else_node;
    else_node = null;
  }
  return [cond, if_node, else_node];
}

/** Look for irregular switch-like structures from nested ConditionalNodes & SwitchNodes. */
export function try_build_irregular_switch(context, start, end) {
  if (!(start instanceof ConditionalNode)) return null;
  pyassert(start.postdominators.has(end));
  const start_block_info = get_block_info(start);
  const control_expr0 = switch_guard_expr(start);
  let var_expr = null;

  if (control_expr0 !== null) var_expr = control_expr0;
  else if (start_block_info.branch_condition !== null) {
    const start_cond = simplify_condition(start_block_info.branch_condition);
    if (start_cond !== null && start_cond instanceof BinaryOp && start_cond.right instanceof Literal) var_expr = start_cond.left;
  }
  if (var_expr === null) return null;

  const uw_var_expr = early_unwrap_ints(var_expr);
  const node_queue = [[start, new Bounds()]];
  const visited_nodes = new Set();
  const nodes_to_mark_emitted = new Set();
  const cases = new Map();
  let default_node = null;
  let irregular_comparison_count = 0;

  while (node_queue.length) {
    const [node, bounds] = node_queue.pop();
    if (visited_nodes.has(node) || node === end || node === default_node) continue;
    visited_nodes.add(node);
    const block_info = get_block_info(node);

    if (node !== start && block_info.statements_to_write().length) {
      // pass
    } else if (is_empty_goto(node, end)) {
      nodes_to_mark_emitted.add(node);
      if (node instanceof BasicNode) node_queue.push([node.successor, bounds]);
      continue;
    } else if (!node.dominators.has(start) || !node.postdominators.has(end)) {
      // pass
    } else if (node instanceof BasicNode) {
      nodes_to_mark_emitted.add(node);
      node_queue.push([node.successor, bounds]);
      continue;
    } else if (node instanceof ConditionalNode) {
      const control_expr = switch_guard_expr(node);
      if (control_expr !== null && pyeq(early_unwrap_ints(control_expr), uw_var_expr)) {
        node_queue.push([node.fallthrough_edge, bounds]);
        node_queue.push([node.conditional_edge, bounds]);
        nodes_to_mark_emitted.add(node);
        continue;
      }
      pyassert(block_info.branch_condition !== null);
      const cond = simplify_condition(block_info.branch_condition);
      if (cond instanceof BinaryOp && cond.right instanceof Literal && pyeq(early_unwrap_ints(cond.left), uw_var_expr)) {
        const val = cond.right.value;
        if (cond.op === "==") {
          if (cases.has(val)) return null;
          cases.set(val, node.conditional_edge);
          node_queue.push([node.fallthrough_edge, bounds.without(val)]);
        } else if (cond.op === "!=" && (node.block.index > node.conditional_edge.block.index || context.options.target.compiler !== Target.CompilerEnum.IDO)) {
          if (cases.has(val)) return null;
          cases.set(val, node.fallthrough_edge);
          node_queue.push([node.conditional_edge, bounds.without(val)]);
        } else if (cond.op === "<") {
          node_queue.push([node.fallthrough_edge, bounds.at_least(val)]);
          node_queue.push([node.conditional_edge, bounds.at_most(val - 1)]);
        } else if (cond.op === ">=") {
          node_queue.push([node.fallthrough_edge, bounds.at_most(val - 1)]);
          node_queue.push([node.conditional_edge, bounds.at_least(val)]);
        } else if (cond.op === "<=") {
          node_queue.push([node.fallthrough_edge, bounds.at_least(val + 1)]);
          node_queue.push([node.conditional_edge, bounds.at_most(val)]);
        } else if (cond.op === ">") {
          node_queue.push([node.fallthrough_edge, bounds.at_most(val)]);
          node_queue.push([node.conditional_edge, bounds.at_least(val + 1)]);
        } else return null;
        irregular_comparison_count += 1;
        nodes_to_mark_emitted.add(node);
        continue;
      }
    } else if (node instanceof SwitchNode) {
      if (block_info.switch_control === null) return null;
      if (!pyeq(early_unwrap_ints(block_info.switch_control.control_expr), uw_var_expr)) return null;
      let i = block_info.switch_control.offset;
      for (const c of node.cases) {
        if (cases.has(i)) return null;
        cases.set(i, c);
        i++;
      }
      nodes_to_mark_emitted.add(node);
      irregular_comparison_count += 1;
      continue;
    }

    const values = bounds.values({ max_count: 1 });
    if (values && values.length && context.options.target.compiler !== Target.CompilerEnum.IDO) {
      for (const value of values) {
        if (cases.has(value)) return null;
        cases.set(value, node);
      }
      nodes_to_mark_emitted.add(node);
      continue;
    }

    if (default_node !== null) return null;
    if (node instanceof ReturnNode || (node.dominators.has(start) && node.postdominators.has(end))) default_node = node;
  }

  if (irregular_comparison_count < 2 || nodes_to_mark_emitted.size < 3 || new Set(cases.values()).size < 2) return null;

  const switch_index = add_labels_for_switch(context, start, var_expr.type, [...cases.entries()], default_node);
  const case_nodes = [...cases.values()];
  if (default_node !== null) case_nodes.push(default_node);
  const sw = build_switch_statement(context, SwitchControl.irregular_from_expr(var_expr), case_nodes, switch_index, end);
  for (const n of nodes_to_mark_emitted) context.emitted_nodes.add(n);
  return sw;
}

/** Output the subgraph between `start` and `end`, including the branch condition in `start`. */
export function build_conditional_subgraph(context, start, end) {
  let curr_node = start;
  const chained_cond_nodes = [];
  for (;;) {
    pyassert(curr_node instanceof ConditionalNode);
    chained_cond_nodes.push(curr_node);
    curr_node = curr_node.fallthrough_edge;
    if (
      !(
        context.options.andor_detection &&
        curr_node instanceof ConditionalNode &&
        curr_node.postdominators.has(end) &&
        end !== curr_node &&
        !curr_node.loop &&
        curr_node.parents.every((p) => chained_cond_nodes.includes(p)) &&
        !switch_guard_expr(curr_node)
      )
    ) {
      break;
    }
  }

  let cond_result;
  for (;;) {
    pyassert(chained_cond_nodes.length);
    cond_result = try_make_if_condition(chained_cond_nodes, end);
    if (cond_result) break;
    chained_cond_nodes.pop();
  }
  const [cond, if_node, else_node] = cond_result;

  for (const n of chained_cond_nodes.slice(1)) context.emitted_nodes.add(n);

  let else_body = null;
  if (else_node) else_body = build_flowgraph_between(context, else_node, end);
  const if_body = build_flowgraph_between(context, if_node, end);
  return new IfElseStatement(cond, if_body, else_body);
}

export function join_conditions(left, op, right) {
  pyassert(op === "&&" || op === "||");
  return new BinaryOp(left, op, right, { type: Type.boolean() });
}

export function emit_return(context, node, body) {
  const ret_info = get_block_info(node);
  const ret = ret_info.return_value;
  if (ret !== null) {
    const ret_str = format_expr(ret, context.fmt);
    body.add_statement(new SimpleStatement(`return ${ret_str};`, { is_jump: true }));
    context.is_void = false;
  } else body.add_statement(new SimpleStatement("return;", { is_jump: true }));
}

/** Helper for building both regular & irregular switch bodies. */
export function build_switch_statement(context, jump, case_nodes, switch_index, end) {
  const switch_body = new Body(context.options.debug);

  const remaining_labels = [];
  // (Python closure semantics: the lambda reads `index` late, i.e. its final value.)
  let index;
  const end_labels = context.case_nodes.get(end);
  for (const entry of end_labels) {
    index = entry[0];
    const case_label = entry[1];
    if (index.equals(switch_index)) {
      const comments = [(fmt) => index.to_comment(fmt)];
      switch_body.add_statement(new SimpleStatement(`${case_label}:`, { comments, indent: -1 }));
    } else remaining_labels.push([index, case_label]);
  }
  if (remaining_labels.length !== context.case_nodes.get(end).length) {
    switch_body.add_statement(new SimpleStatement("break;", { is_jump: true }));
    context.case_nodes.set(end, remaining_labels);
  }

  const uniq = [...new Set(case_nodes)];
  const sorted_cases = sorted(uniq, (node) => [node.block.index, case_nodes.indexOf(node)]);
  const next_sorted_cases = [...sorted_cases.slice(1), null];
  for (let k = 0; k < sorted_cases.length; k++) {
    const c = sorted_cases[k];
    const next_case = next_sorted_cases[k];
    if (context.emitted_nodes.has(c) || c === end) {
      // pass
    } else if (next_case !== null && !context.emitted_nodes.has(next_case) && next_case !== end && c.postdominators.has(next_case)) {
      switch_body.extend(build_flowgraph_between(context, c, next_case));
      if (!switch_body.ends_in_jump()) switch_body.add_comment("fallthrough");
    } else {
      switch_body.extend(build_flowgraph_between(context, c, end));
      if (!switch_body.ends_in_jump()) switch_body.add_statement(new SimpleStatement("break;", { is_jump: true }));
    }
  }
  return new SwitchStatement(jump, switch_body, switch_index);
}

function enumerate_from(arr, start) {
  return arr.map((v, i) => [i + start, v]);
}

/** Output the subgraph between `switch` and `end` (single jump table switches). */
export function build_switch_between(context, sw, def, end) {
  const switch_cases = [...sw.cases];
  if (def === end) def = null;
  else if (def !== null) switch_cases.push(def);
  const jump = get_block_info(sw).switch_control;
  pyassert(jump !== null);
  const switch_index = add_labels_for_switch(context, sw, jump.control_expr.type, enumerate_from(sw.cases, jump.offset), def);
  return build_switch_statement(context, jump, switch_cases, switch_index, end);
}

export function detect_loop(context, start, end) {
  pyassert(start.loop);
  let condition = null;
  let new_end = null;
  for (const node of start.loop.backedges) {
    if (start.postdominators.has(node) && node instanceof ConditionalNode && node.fallthrough_edge === end) {
      const block_info = get_block_info(node);
      pyassert(block_info.branch_condition !== null);
      condition = block_info.branch_condition;
      new_end = node;
      break;
    }
  }
  if (!condition) return null;
  const loop_body = build_flowgraph_between(context, start, new_end, true);
  emit_node(context, new_end, loop_body);
  return new DoWhileLoop(loop_body, condition);
}

/** Output a section of a flow graph (start inclusive, end exclusive). */
export function build_flowgraph_between(context, start, end, skip_loop_detection = false) {
  let curr_start = start;
  const body = new Body(context.options.debug);

  while (curr_start !== end) {
    pyassert(!(curr_start instanceof TerminalNode));

    if (!skip_loop_detection && curr_start.loop && !context.emitted_nodes.has(curr_start)) {
      let imm_pdom = curr_start;
      while (curr_start.loop.nodes.has(imm_pdom)) {
        pyassert(imm_pdom.immediate_postdominator !== null);
        imm_pdom = imm_pdom.immediate_postdominator;
      }
      const do_while_loop = detect_loop(context, curr_start, imm_pdom);
      if (do_while_loop) {
        body.add_do_while_loop(do_while_loop);
        curr_start = imm_pdom;
        continue;
      }
    }

    if (context.emitted_nodes.has(curr_start) && is_empty_goto(curr_start, end)) break;

    if (!emit_node(context, curr_start, body)) break;

    if (curr_start.emit_goto) {
      emit_goto(context, curr_start, body);
      const index = context.flow_graph.nodes.indexOf(curr_start);
      const fallthrough = context.flow_graph.nodes[index + 1];
      if (curr_start instanceof ConditionalNode) pyassert(fallthrough === curr_start.fallthrough_edge);
      curr_start = fallthrough;
      continue;
    }

    let curr_end = curr_start.immediate_postdominator;
    pyassert(curr_end !== null);

    let irregular_switch = null;
    if (context.options.switch_detection) irregular_switch = try_build_irregular_switch(context, curr_start, curr_end);

    if (irregular_switch !== null) body.add_switch(irregular_switch);
    else if (switch_guard_expr(curr_start) !== null) {
      pyassert(curr_start instanceof ConditionalNode, "checked by switch_guard_expr");
      const switch_node = curr_start.fallthrough_edge;
      pyassert(switch_node instanceof SwitchNode, "checked by switch_guard_expr");
      const default_node = curr_start.conditional_edge;
      context.emitted_nodes.add(switch_node);
      if (curr_end === switch_node) {
        curr_end = switch_node.immediate_postdominator;
        pyassert(curr_start.postdominators.has(curr_end));
      }
      body.add_switch(build_switch_between(context, switch_node, default_node, curr_end));
    } else if (curr_start instanceof SwitchNode) {
      body.add_switch(build_switch_between(context, curr_start, null, curr_end));
    } else if (curr_start instanceof ConditionalNode) {
      body.add_if_else(build_conditional_subgraph(context, curr_start, curr_end));
    } else if (curr_start instanceof BasicNode && curr_start.fake_successor === curr_end) {
      curr_end = curr_start.successor;
    } else {
      const ch = curr_start.children();
      pyassert(
        ch.length === 1 && ch[0] === curr_end,
        `While emitting flowgraph between ${start.name()}:${end.name()}, ` + `skipped nodes while stepping from ${curr_start.name()} to ${curr_end.name()}.`,
      );
    }
    curr_start = curr_end;
  }
  return body;
}

/** Naive procedure for generating output with only gotos for control flow. */
export function build_naive(context, nodes) {
  const body = new Body(context.options.debug);

  const emit_goto_or_early_return = (node, b) => {
    if (node instanceof ReturnNode && !node.is_real()) emit_node(context, node, b);
    else emit_goto(context, node, b);
  };
  const emit_successor = (node, cur_index) => {
    if (cur_index + 1 < nodes.length && nodes[cur_index + 1] === node && !(node instanceof ReturnNode && !node.is_real())) return;
    emit_goto_or_early_return(node, body);
  };

  nodes.forEach((node, i) => {
    if (node instanceof ReturnNode) {
      if (node.is_real()) emit_node(context, node, body);
    } else if (node instanceof BasicNode) {
      emit_node(context, node, body);
      emit_successor(node.successor, i);
    } else if (node instanceof SwitchNode) {
      const jump = get_block_info(node).switch_control;
      pyassert(jump !== null);
      const index = add_labels_for_switch(context, node, jump.control_expr.type, enumerate_from(node.cases, jump.offset), null);
      emit_node(context, node, body);
      body.add_switch(new SwitchStatement(jump, new Body(false), index));
    } else if (node instanceof ConditionalNode) {
      emit_node(context, node, body);
      const if_body = new Body(true);
      emit_goto_or_early_return(node.conditional_edge, if_body);
      const block_info = get_block_info(node);
      pyassert(block_info.branch_condition !== null);
      body.add_if_else(new IfElseStatement(block_info.branch_condition, if_body, null));
      emit_successor(node.fallthrough_edge, i);
    } else {
      pyassert(node instanceof TerminalNode);
    }
  });
  return body;
}

export function build_body(context, options) {
  const start_node = context.flow_graph.entry_node();
  const terminal_node = context.flow_graph.terminal_node();
  const is_reducible = context.flow_graph.is_reducible();

  let body;
  if (options.ifs && is_reducible) {
    body = build_flowgraph_between(context, start_node, terminal_node);
    body.elide_empty_returns();
  } else {
    body = new Body(context.options.debug);
    if (options.ifs && !is_reducible) body.add_comment("Flowgraph is not reducible, falling back to gotos-only mode.");
    body.extend(build_naive(context, context.flow_graph.nodes));
  }

  for (const node of context.flow_graph.nodes) {
    if (context.emitted_nodes.has(node) || node instanceof TerminalNode) continue;
    if (node instanceof ReturnNode && !node.is_real()) continue;
    body.add_comment(`bug: did not emit code for node #${node.name()}; contents below:`);
    emit_node(context, node, body);
  }

  let index = 0;
  for (const node of context.flow_graph.nodes) {
    if (context.switch_nodes.has(node)) {
      context.switch_nodes.set(node, index);
      index += 1;
    }
  }
  return body;
}

export function get_function_text(function_info, options) {
  const fmt = options.formatter();
  const context = new Context({ flow_graph: function_info.flow_graph, options, fmt });
  const body = build_body(context, options);

  const function_lines = [];
  if (options.debug) function_lines.push("Here's the whole function!\n");

  for (const warning of function_info.stack_info.warnings) {
    const line = fmt.with_comments("", [`Warning: ${warning}`]);
    if (line) function_lines.push(line);
  }
  if (function_info.symbol.demangled_str !== null) {
    const line = fmt.with_comments("", [function_info.symbol.demangled_str]);
    if (line) function_lines.push(line);
  }

  const fn_name = function_info.symbol.c_symbol_name;
  const arg_strs = [];
  function_info.stack_info.arguments.forEach((arg, i) => {
    if (i === 0 && function_info.stack_info.replace_first_arg !== null) {
      const [original_name, original_type] = function_info.stack_info.replace_first_arg;
      arg_strs.push(original_type.to_decl(original_name, fmt));
    } else arg_strs.push(arg.type.to_decl(arg.format(fmt), fmt));
  });
  if (function_info.stack_info.is_variadic) arg_strs.push("...");
  const arg_str = arg_strs.join(", ") || "void";

  let fn_header = `${fn_name}(${arg_str})`;
  if (context.is_void) fn_header = `void ${fn_header}`;
  else fn_header = function_info.return_type.to_decl(fn_header, fmt);
  const whitespace = fmt.coding_style.newline_after_function ? "\n" : " ";
  function_lines.push(`${fn_header}${whitespace}{`);

  let any_decl = false;
  fmt.indented(() => {
    const formatted_body = body.format(fmt);

    let local_vars = function_info.stack_info.local_vars;
    if (options.target.compiler !== Target.CompilerEnum.GCC) local_vars = [...local_vars].reverse();
    for (const local_var of local_vars) {
      const type_decl = local_var.toplevel_decl(fmt);
      if (type_decl !== null) {
        let comments = [];
        if (function_info.stack_info.weak_stack_var_locations.has(local_var.value)) comments = ["compiler-managed"];
        function_lines.push(new SimpleStatement(`${type_decl};`, { comments }).format(fmt));
        any_decl = true;
      }
    }

    const temp_decls = [];
    for (const v of function_info.stack_info.temp_vars) {
      if (v.is_emitted) {
        const type_decl = v.type.to_decl(v.format(fmt), fmt);
        temp_decls.push(`${type_decl};`);
        any_decl = true;
      }
    }

    const var_sort = fmt.descending_regs ? (d) => d.split("_")[1] : (d) => d;
    for (const decl of sorted(temp_decls, var_sort, fmt.descending_regs)) function_lines.push(new SimpleStatement(decl).format(fmt));

    for (const phi_var of function_info.stack_info.naive_phi_vars) {
      const type_decl = phi_var.type.to_decl(phi_var.get_var_name(), fmt);
      function_lines.push(new SimpleStatement(`${type_decl};`).format(fmt));
      any_decl = true;
    }

    if (function_info.stack_info.replace_first_arg !== null) {
      pyassert(function_info.stack_info.arguments.length >= 1);
      const replaced_arg = function_info.stack_info.arguments[0];
      const [original_name] = function_info.stack_info.replace_first_arg;
      const lhs = replaced_arg.type.to_decl(replaced_arg.format(fmt), fmt);
      const rhs = `(${replaced_arg.type.format(fmt)}) ${original_name}`;
      function_lines.push(new SimpleStatement(`${lhs} = ${rhs};`).format(fmt));
    }

    if (any_decl) function_lines.push("");
    function_lines.push(formatted_body);
    function_lines.push("}");
  });
  return function_lines.join("\n");
}
