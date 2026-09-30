// helpers.js - decomp-permuter's src/helpers.py (settings + weights), plus the
// small TOML reader those files need.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CandidateConstructionFailure } from "./error.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WEIGHTS_FILE = path.join(here, "..", "default_weights.toml");

export function plural(n, noun) { return `${n} ${noun}${n !== 1 ? "s" : ""}`; }

/** Cut the source down to the target function and what follows (trim_source). */
export function trim_source(source, fn_name) {
  const fn_index = source.indexOf(fn_name);
  if (fn_index !== -1) {
    const new_index = fn_index === 0 ? -1 : source.lastIndexOf("\n", fn_index - 1);
    if (new_index !== -1) return source.slice(new_index);
  }
  return source;
}

/**
 * Parse the TOML subset settings.toml / default_weights.toml use: tables,
 * `key = value` with strings (multi-line ones included), integers, floats,
 * booleans and flat arrays, and
 * comments. Anything else is rejected rather than guessed.
 * @returns {Record<string, any>}
 */
export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = stripComment(lines[ln]).trim();
    if (!line) continue;
    let m = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (m) {
      cur = root;
      for (const part of m[1].split(".")) {
        cur[part] ??= {};
        cur = cur[part];
      }
      continue;
    }
    m = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.+)$/.exec(line);
    if (!m) throw new Error(`TOML: cannot parse line ${ln + 1}: ${lines[ln]}`);
    const key = m[1].startsWith("\"") ? m[1].slice(1, -1) : m[1];
    const rest = m[2].trim();
    const delim = rest.startsWith('"""') ? '"""' : rest.startsWith("'''") ? "'''" : null;
    if (delim) {
      // Multi-line string (settings.toml's compiler_command): a newline right
      // after the opening delimiter is trimmed; basic strings take escapes.
      let body = rest.slice(3);
      let end = body.indexOf(delim);
      const startLine = ln;
      while (end < 0) {
        if (++ln >= lines.length) throw new Error(`TOML: unterminated multi-line string on line ${startLine + 1}`);
        body += "\n" + lines[ln];
        end = body.indexOf(delim);
      }
      if (body.slice(end + 3).trim() && !body.slice(end + 3).trim().startsWith("#")) throw new Error(`TOML: text after a multi-line string on line ${ln + 1}`);
      body = body.slice(0, end);
      if (body.startsWith("\n")) body = body.slice(1);
      cur[key] = delim === "'''" ? body : JSON.parse(`"${body.replace(/\\\s*\n\s*/g, "").replace(/\n/g, "\\n").replace(/"/g, (q, i, s) => (s[i - 1] === "\\" ? q : '\\"'))}"`);
      continue;
    }
    cur[key] = parseTomlValue(rest, ln + 1);
  }
  return root;
}

function stripComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === "\\" && inStr === "\"") { i++; continue; }
      if (c === inStr) inStr = null;
    } else if (c === "\"" || c === "'") inStr = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(v, ln) {
  if (v.startsWith("\"")) {
    if (!v.endsWith("\"") || v.length < 2) throw new Error(`TOML: bad string on line ${ln}`);
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`TOML: bad string on line ${ln}`);
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim()).filter(Boolean).map((s) => parseTomlValue(s, ln));
  }
  const clean = v.replaceAll("_", "");
  if (/^[+-]?\d+$/.test(clean)) return { int: Number(clean) };
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(clean)) return Number(clean);
  if (/^0x[0-9a-fA-F]+$/.test(clean)) return { int: Number(clean) };
  throw new Error(`TOML: unsupported value on line ${ln}: ${v}`);
}

// TOML distinguishes int from float; json_prop's float coercion depends on it.
const isInt = (v) => v != null && typeof v === "object" && "int" in v && Object.keys(v).length === 1;
const unwrap = (v) => (isInt(v) ? v.int : v);

function typeName(v) {
  if (isInt(v)) return "int";
  if (typeof v === "number") return "float";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (Array.isArray(v)) return "list";
  if (v && typeof v === "object") return "dict";
  return "NoneType";
}

/** _json_as_type: str / float (ints coerce) / dict / int. */
function asType(what, value, t) {
  const tn = typeName(value);
  if (tn === t) return unwrap(value);
  if (t === "float" && tn === "int") return value.int;
  throw new Error(`${what} must have type ${t}; got ${tn}`);
}

export function json_prop(obj, prop, t, dflt = undefined) {
  const value = obj[prop];
  if (value === undefined) {
    if (dflt !== undefined && dflt !== null) return dflt;
    throw new Error(`Member ${prop} does not exist`);
  }
  return asType("Member " + prop, value, t);
}

export function json_dict(obj, t) {
  const ret = {};
  for (const [key, value] of Object.entries(obj)) ret[key] = asType("Dict entries", value, t);
  return ret;
}

export function merge_randomization_weights(base, overrides) {
  const out = {};
  for (const [key, weight] of Object.entries(base)) out[key] = Object.hasOwn(overrides, key) ? overrides[key] : weight;
  return out;
}

export function get_default_randomization_weights(compiler_type, weightsFile = DEFAULT_WEIGHTS_FILE) {
  const obj = parseToml(readFileSync(weightsFile, "utf8"));
  const base_weights = json_dict(json_prop(obj, "base", "dict", {}), "float");
  if (!(compiler_type in obj)) throw new CandidateConstructionFailure(`Unable to find compiler type ${compiler_type} in default_weights.toml`);
  const compiler_weights = json_dict(json_prop(obj, compiler_type, "dict"), "float");
  return merge_randomization_weights(base_weights, compiler_weights);
}

/** settings.toml of a permuter directory, or {} when absent. */
export function get_settings(dir) {
  let text;
  try { text = readFileSync(path.join(dir, "settings.toml"), "utf8"); } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
  return parseToml(text);
}
