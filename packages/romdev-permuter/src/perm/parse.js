// parse.js - PERM macro parsing, a port of decomp-permuter's src/perm/parse.py.
import {
  CombinePerm, ForceSamelinePerm, GeneralPerm, IgnorePerm, IntPerm, LineSwapPerm, LineSwapAstPerm,
  OncePerm, PretendPerm, RandomizerPerm, RootPerm, TextPerm, VarPerm,
} from "./perm.js";

class ParseAssertionError extends Error {
  constructor(message = "") { super(message); this.name = "AssertionError"; }
}

function _split_by_comma(text) {
  let level = 0;
  let current = "";
  const args = [];
  for (const c of text) {
    if (c === "," && level === 0) {
      args.push(current);
      current = "";
    } else {
      if (c === "(") level += 1;
      else if (c === ")") {
        level -= 1;
        if (!(level >= 0)) throw new ParseAssertionError("Bad nesting");
      }
      current += c;
    }
  }
  if (level !== 0) throw new ParseAssertionError("Mismatched parentheses");
  args.push(current);
  return args;
}

const _split_args = (text) => _split_by_comma(text).map(_rec_perm_parse);

const _split_args_newline = (text) => text.split("\n").filter((line) => line.trim()).map(_rec_perm_parse);

function _split_args_text(text) {
  return _split_args(text).map((perm) => {
    if (!(perm instanceof TextPerm)) throw new ParseAssertionError();
    return perm.text;
  });
}

function _make_once_perm(text) {
  const args = _split_by_comma(text);
  if (args.length !== 1 && args.length !== 2) throw new Error("PERM_ONCE takes 1 or 2 arguments");
  const key = args[0].trim();
  const value = _rec_perm_parse(args[args.length - 1]);
  return new OncePerm(key, value);
}

function _make_var_perm(text) {
  const args = _split_by_comma(text);
  if (args.length !== 1 && args.length !== 2) throw new Error("PERM_VAR takes 1 or 2 arguments");
  const var_name = _rec_perm_parse(args[0]);
  const value = args.length === 2 ? _rec_perm_parse(args[1]) : null;
  return new VarPerm(var_name, value);
}

/** int() of a PERM_INT bound. */
function pyInt(s) {
  const t = s.trim().replaceAll("_", "");
  if (!/^[+-]?\d+$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return BigInt(t);
}

export const PERM_FACTORIES = {
  PERM_GENERAL: (text) => new GeneralPerm(_split_args(text)),
  PERM_ONCE: (text) => _make_once_perm(text),
  PERM_RANDOMIZE: (text) => new RandomizerPerm(_rec_perm_parse(text)),
  PERM_FORCE_SAMELINE: (text) => new ForceSamelinePerm(_rec_perm_parse(text)),
  PERM_VAR: (text) => _make_var_perm(text),
  PERM_LINESWAP_TEXT: (text) => new LineSwapPerm(_split_args_newline(text)),
  PERM_LINESWAP: (text) => new LineSwapAstPerm(_split_args_newline(text)),
  PERM_INT: (text) => {
    const args = _split_args_text(text).map(pyInt);
    if (args.length !== 2) throw new TypeError(`IntPerm takes 2 arguments (${args.length} given)`);
    return new IntPerm(args[0], args[1]);
  },
  PERM_IGNORE: (text) => new IgnorePerm(_rec_perm_parse(text)),
  PERM_PRETEND: (text) => new PretendPerm(_rec_perm_parse(text)),
};

function _consume_arg_parens(text) {
  let level = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") level += 1;
    else if (c === ")") {
      level -= 1;
      if (level === -1) return [text.slice(0, i), text.slice(i + 1)];
    }
  }
  throw new Error("Failed to find closing parenthesis when parsing PERM macro");
}

function _rec_perm_parse(text) {
  let remain = text;
  const macro_search = /(PERM_.+?)\(/;
  const perms = [];
  while (remain.length > 0) {
    const match = macro_search.exec(remain);
    if (match == null) {
      perms.push(new TextPerm(remain));
      break;
    }
    const perm_type = match[1];
    if (!Object.hasOwn(PERM_FACTORIES, perm_type)) throw new Error("Unrecognized PERM macro: " + perm_type);
    const between = remain.slice(0, match.index);
    let args;
    [args, remain] = _consume_arg_parens(remain.slice(match.index + match[0].length));
    perms.push(new TextPerm(between));
    perms.push(PERM_FACTORIES[perm_type](args));
  }
  if (perms.length === 1) return perms[0];
  return new CombinePerm(perms);
}

/**
 * Parse PERM macros out of a source text. `log` receives upstream's
 * informational lines ("No perm macros found...", "Will try N ...").
 */
export function perm_parse(text, log = (s) => console.log(s)) {
  let ret = _rec_perm_parse(text);
  if (new RootPerm(ret).perm_count <= 1n && !ret.is_random()) {
    ret = new RandomizerPerm(ret);
    log("No perm macros found. Defaulting to randomization.");
  }
  ret = new RootPerm(ret);
  if (!ret.is_random()) log(`Will run for ${ret.perm_count} iterations.`);
  else log(`Will try ${ret.perm_count} different base sources.`);
  return ret;
}
