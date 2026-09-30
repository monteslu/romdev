// ply_yacc.js - PLY's LR parsing engine (ply/yacc.py, LRParser.parseopt_notrack),
// driven by the precomputed LALR tables in tables/yacctab.json.
//
// Upstream calls yacc.yacc(optimize=True) with a committed yacctab.py, which
// PLY loads without re-checking the grammar, so those tables ARE upstream's
// parser. This engine is a line-by-line port of the optimized parse loop,
// including "defaulted states" (a state with a single reduce action reduces
// without fetching a lookahead), which is observable: pycparser's lexer
// callbacks (scope push/pop, typedef lookup) depend on exactly when the next
// token is read.

export class YaccSymbol {
  constructor(type = null, value = null) {
    this.type = type;
    this.value = value;
  }

  toString() { return this.type; }
}

/** The `p` argument of a grammar action. */
export class YaccProduction {
  constructor(slice, stack) {
    this.slice = slice;
    this.stack = stack;
    this.lexer = null;
    this.parser = null;
  }

  /** p[n] */
  get(n) { return n >= 0 ? this.slice[n].value : this.stack[this.stack.length + n].value; }

  /** p[n] = v */
  set(n, v) { this.slice[n].value = v; }

  /** len(p) */
  get length() { return this.slice.length; }

  lineno(n) { return this.slice[n].lineno ?? 0; }

  set_lineno(n, lineno) { this.slice[n].lineno = lineno; }

  lexpos(n) { return this.slice[n].lexpos ?? 0; }
}

/**
 * @param {{action: [number, [string, number][]][], goto: [number, [string, number][]][], productions: any[][]}} tab
 * @param {Record<string, (p: YaccProduction) => void>} actions grammar action per function name
 * @param {(tok: any) => any} errorfunc p_error
 */
export class LRParser {
  constructor(tab, actions, errorfunc) {
    /** @type {Map<number, Map<string, number>>} */
    this.action = new Map(tab.action.map(([s, items]) => [s, new Map(items)]));
    /** @type {Map<number, Map<string, number>>} */
    this.goto = new Map(tab.goto.map(([s, items]) => [s, new Map(items)]));
    this.productions = tab.productions.map(([str, name, len, func]) => {
      let callable = null;
      if (func) {
        callable = actions[func];
        if (!callable) throw new Error(`no grammar action ${func} (${str})`);
      }
      return { str, name, len, func, callable };
    });
    this.errorfunc = errorfunc;
    this.setDefaultedStates();
  }

  setDefaultedStates() {
    /** @type {Map<number, number>} */
    this.defaultedStates = new Map();
    for (const [state, actions] of this.action) {
      const rules = [...actions.values()];
      if (rules.length === 1 && rules[0] < 0) this.defaultedStates.set(state, rules[0]);
    }
  }

  parse(input, lexer) {
    let lookahead = null;
    const lookaheadstack = [];
    const actions = this.action;
    const gotoTab = this.goto;
    const prod = this.productions;
    const defaulted = this.defaultedStates;
    const pslice = new YaccProduction(null);
    pslice.lexer = lexer;
    pslice.parser = this;
    if (input != null) lexer.input(input);
    const getToken = () => lexer.token();
    const statestack = [];
    const symstack = [];
    pslice.stack = symstack;
    statestack.push(0);
    symstack.push(new YaccSymbol("$end"));
    let state = 0;
    for (;;) {
      let t;
      if (!defaulted.has(state)) {
        if (!lookahead) {
          lookahead = lookaheadstack.length ? lookaheadstack.pop() : getToken();
          if (!lookahead) lookahead = new YaccSymbol("$end");
        }
        const ltype = lookahead.type;
        t = actions.get(state)?.get(ltype);
      } else {
        t = defaulted.get(state);
      }
      if (t !== undefined) {
        if (t > 0) {
          statestack.push(t);
          state = t;
          symstack.push(lookahead);
          lookahead = null;
          continue;
        }
        if (t < 0) {
          const p = prod[-t];
          const pname = p.name;
          const plen = p.len;
          const sym = new YaccSymbol(pname, null);
          if (plen) {
            const targ = symstack.slice(symstack.length - plen - 1);
            targ[0] = sym;
            pslice.slice = targ;
            symstack.length -= plen;
            this.state = state;
            p.callable(pslice);
            statestack.length -= plen;
            symstack.push(sym);
            state = gotoTab.get(statestack[statestack.length - 1]).get(pname);
            statestack.push(state);
            continue;
          }
          const targ = [sym];
          pslice.slice = targ;
          this.state = state;
          p.callable(pslice);
          symstack.push(sym);
          state = gotoTab.get(statestack[statestack.length - 1]).get(pname);
          statestack.push(state);
          continue;
        }
        // t === 0: accept
        const n = symstack[symstack.length - 1];
        return n.value ?? null;
      }
      // Syntax error. pycparser's p_error always raises, so there is no
      // recovery path to port: report the offending token (null at EOF).
      let errtoken = lookahead;
      if (errtoken.type === "$end") errtoken = null;
      this.state = state;
      this.errorfunc(errtoken);
      throw new Error("yacc: p_error returned without raising");
    }
  }
}
