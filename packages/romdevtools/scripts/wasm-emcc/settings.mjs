// settings.mjs - emscripten's settings model (tools/settings.py + the -s
// parsing in tools/cmdline.py), in JS.
//
// Defaults come from the emscripten tree's own src/settings.js and
// src/settings_internal.js, so a version bump brings its defaults along.
// What the JS compiler (tools/compiler.mjs) receives is externalDict(): every
// setting whose value differs from its default, plus the legacy settings - the
// same rule settings.py uses, so the JSON can be diffed against emcc's.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const MEM_SIZE_SETTINGS = new Set(["GLOBAL_BASE", "STACK_SIZE", "TOTAL_STACK", "INITIAL_HEAP", "INITIAL_MEMORY", "MEMORY_GROWTH_LINEAR_STEP", "MEMORY_GROWTH_GEOMETRIC_CAP", "GL_MAX_TEMP_BUFFER_SIZE", "MAXIMUM_MEMORY", "DEFAULT_PTHREAD_STACK_SIZE", "ASYNCIFY_STACK_SIZE"]);
export const INTERNAL_SETTINGS = new Set(["SIDE_MODULE_IMPORTS"]);
export const EXTRA_INCOMING_JS_API = ["fetchSettings"];

// tools/settings.py LEGACY_SETTINGS (emscripten 4.0.18).
export const LEGACY_SETTINGS = [
  ["BINARYEN", "WASM"], ["TOTAL_STACK", "STACK_SIZE"], ["BINARYEN_ASYNC_COMPILATION", "WASM_ASYNC_COMPILATION"],
  ["UNALIGNED_MEMORY", [0]], ["FORCE_ALIGNED_MEMORY", [0]], ["PGO", [0]], ["QUANTUM_SIZE", [4]], ["FUNCTION_POINTER_ALIGNMENT", [2]],
  ["RESERVED_FUNCTION_POINTERS", "ALLOW_TABLE_GROWTH"], ["BUILD_AS_SHARED_LIB", [0]], ["SAFE_SPLIT_MEMORY", [0]], ["SPLIT_MEMORY", [0]],
  ["BINARYEN_METHOD", ["native-wasm"]], ["BINARYEN_TRAP_MODE", [-1]], ["PRECISE_I64_MATH", [1, 2]], ["MEMFS_APPEND_TO_TYPED_ARRAYS", [1]],
  ["ERROR_ON_MISSING_LIBRARIES", [1]], ["EMITTING_JS", [1]], ["SKIP_STACK_IN_SMALL", [0, 1]], ["SAFE_STACK", [0]],
  ["MEMORY_GROWTH_STEP", "MEMORY_GROWTH_LINEAR_STEP"], ["ELIMINATE_DUPLICATE_FUNCTIONS", [0, 1]],
  ["ELIMINATE_DUPLICATE_FUNCTIONS_DUMP_EQUIVALENT_FUNCTIONS", [0]], ["ELIMINATE_DUPLICATE_FUNCTIONS_PASSES", [5]], ["WASM_OBJECT_FILES", [0, 1]],
  ["TOTAL_MEMORY", "INITIAL_MEMORY"], ["WASM_MEM_MAX", "MAXIMUM_MEMORY"], ["BINARYEN_MEM_MAX", "MAXIMUM_MEMORY"], ["BINARYEN_PASSES", [""]],
  ["SWAPPABLE_ASM_MODULE", [0]], ["ASM_JS", [1]], ["FINALIZE_ASM_JS", [0, 1]], ["ASYNCIFY_WHITELIST", "ASYNCIFY_ONLY"],
  ["ASYNCIFY_BLACKLIST", "ASYNCIFY_REMOVE"], ["EXCEPTION_CATCHING_WHITELIST", "EXCEPTION_CATCHING_ALLOWED"], ["SEPARATE_ASM", [0]],
  ["SEPARATE_ASM_MODULE_NAME", [""]], ["FAST_UNROLLED_MEMCPY_AND_MEMSET", [0, 1]], ["DOUBLE_MODE", [0, 1]], ["PRECISE_F32", [0, 1, 2]],
  ["ALIASING_FUNCTION_POINTERS", [0, 1]], ["AGGRESSIVE_VARIABLE_ELIMINATION", [0, 1]], ["SIMPLIFY_IFS", [1]], ["DEAD_FUNCTIONS", [[]]],
  ["WASM_BACKEND", [-1]], ["EXPORT_BINDINGS", [0, 1]], ["RUNNING_JS_OPTS", [0]], ["EXPORT_FUNCTION_TABLES", [0]], ["BINARYEN_SCRIPTS", [""]],
  ["WARN_UNALIGNED", [0, 1]], ["ASM_PRIMITIVE_VARS", [[]]], ["WORKAROUND_IOS_9_RIGHT_SHIFT_BUG", [0]], ["RUNTIME_FUNCS_TO_IMPORT", [[]]],
  ["LIBRARY_DEPS_TO_AUTOEXPORT", [[]]], ["EMIT_EMSCRIPTEN_METADATA", [0]], ["SHELL_FILE", [""]], ["LLD_REPORT_UNDEFINED", [1]],
  ["MEM_INIT_METHOD", [0]], ["USE_PTHREADS", [0, 1]], ["USES_DYNAMIC_ALLOC", [1]], ["REVERSE_DEPS", ["auto", "all", "none"]],
  ["RUNTIME_LOGGING", "RUNTIME_DEBUG"], ["MIN_EDGE_VERSION", [0x7FFFFFFF]], ["MIN_IE_VERSION", [0x7FFFFFFF]],
  ["WORKAROUND_OLD_WEBGL_UNIFORM_UPLOAD_IGNORED_OFFSET_BUG", [0]], ["AUTO_ARCHIVE_INDEXES", [0, 1]], ["USE_ES6_IMPORT_META", [1]],
  ["EXTRA_EXPORTED_RUNTIME_METHODS", [[]]], ["SUPPORT_ERRNO", [0]], ["DEMANGLE_SUPPORT", [0]], ["MAYBE_WASM2JS", [0]], ["HEADLESS", [0]],
  ["USE_OFFSET_COVERTER", [0]], ["ASYNCIFY_LAZY_LOAD_CODE", [0]], ["USE_WEBGPU", [0]],
];

/** Python `==` for the JSON-ish values settings hold (1 == true, deep lists). */
export function pyEq(a, b) {
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEq(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => pyEq(a[k], b[k]));
  }
  return a === b;
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function pyType(v) {
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "str";
  if (Array.isArray(v)) return "list";
  if (v && typeof v === "object") return "dict";
  return null;
}

function readJsSettings(file) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
  const out = {};
  for (const k of Object.keys(ctx)) out[k] = ctx[k];
  return out;
}

export class Settings {
  constructor(emRoot) {
    this.attrs = {};
    this.types = {};
    this.legacy = new Map();
    this.altNames = new Map();
    this.user = {}; // user_settings: NAME -> raw string
    const main = readJsSettings(path.join(emRoot, "src/settings.js"));
    const internal = readJsSettings(path.join(emRoot, "src/settings_internal.js"));
    Object.assign(this.attrs, main, internal);
    for (const [k, v] of Object.entries(this.attrs)) this.types[k] = pyType(v);
    this.internal = new Set(Object.keys(internal));
    for (const leg of LEGACY_SETTINGS) {
      if (leg.length === 2 && typeof leg[1] === "string") {
        const [name, newName] = leg;
        this.legacy.set(name, null);
        this.altNames.set(name, newName);
        this.altNames.set(newName, name);
        this.attrs[name] = clone(this.attrs[newName]);
      } else {
        const [name, fixed] = leg;
        this.legacy.set(name, fixed);
        this.attrs[name] = clone(fixed[0]);
      }
    }
    this.defaults = clone(this.attrs);
  }
  get(name) {
    if (!(name in this.attrs)) throw new Error(`no such setting: '${name}'`);
    return this.attrs[name];
  }
  set(name, value) {
    if (this.legacy.has(name)) {
      const fixed = this.legacy.get(name);
      if (fixed && !fixed.some((f) => pyEq(f, value))) throw new Error(`invalid command line setting \`-s${name}=${value}\``);
    }
    if (this.altNames.has(name)) this.attrs[this.altNames.get(name)] = value;
    if (!(name in this.attrs)) throw new Error(`Attempt to set a non-existent setting: '${name}'`);
    this.attrs[name] = value;
  }
  /** settings.py default_setting(): only when the user did not set it. */
  setDefault(name, value) { if (!(name in this.user)) this.set(name, value); }
  externalDict() {
    const out = {};
    for (const [k, v] of Object.entries(this.attrs)) {
      if (!pyEq(v, this.defaults[k]) && !INTERNAL_SETTINGS.has(k)) out[k] = v;
    }
    if (!this.attrs.STRICT) for (const k of this.legacy.keys()) out[k] = this.attrs[k];
    return out;
  }
  /** json.dumps(external_dict(), sort_keys=True, indent=2) */
  externalJSON() {
    const d = this.externalDict();
    const sorted = {};
    for (const k of Object.keys(d).sort()) sorted[k] = d[k];
    return pyJsonDumps(sorted);
  }
}

/** json.dumps(x, indent=2) with Python's separators (", " / ": " collapse to newline style). */
export function pyJsonDumps(v) {
  return JSON.stringify(v, (_k, x) => x, 2);
}

function expandByteSize(value) {
  const m = /^(\d+)\s*([kmgt]?b)?$/i.exec(value.trim());
  if (!m) throw new Error(`invalid byte size \`${value}\``);
  let n = Number(m[1]);
  if (m[2]) n *= 1024 ** ["b", "kb", "mb", "gb", "tb"].indexOf(m[2].toLowerCase());
  return String(n);
}

function parseStringValue(text) {
  const f = text[0];
  if (f === "'" || f === '"') {
    text = text.trimEnd();
    if (text[text.length - 1] !== f || text.length < 2) throw new Error("unclosed quoted string");
    return text.slice(1, -1);
  }
  return text;
}

function parseStringList(text) {
  text = text.trimEnd();
  if (text[0] === "[") {
    if (text[text.length - 1] !== "]") throw new Error('unterminated string list');
    text = text.slice(1, -1);
  }
  if (text.trim() === "") return [];
  const values = text.split(",");
  const result = [];
  let index = 0;
  while (true) {
    let current = values[index].trimStart();
    if (!current.length) throw new Error("empty value in string list");
    const first = current[0];
    if (first !== "'" && first !== '"') result.push(current.trimEnd());
    else {
      const start = index;
      while (true) {
        if (index >= values.length) throw new Error("unclosed quoted string");
        const nw = values[index].trimEnd();
        if (nw && nw[nw.length - 1] === first) {
          if (start === index) result.push(current.trimEnd().slice(1, -1));
          else result.push((current + "," + nw).slice(1, -1));
          break;
        } else { current += "," + values[index]; index++; }
      }
    }
    index++;
    if (index >= values.length) break;
  }
  return result;
}

/** cmdline.py parse_value() */
export function parseValue(text, expectedType) {
  if (expectedType === "list" || (text && text[0] === "[")) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return parseStringList(text); }
    if (typeof parsed !== "string" && !Array.isArray(parsed)) throw new Error("settings must be strings or lists");
    return parsed;
  }
  if (expectedType === "float") { const f = Number(text); if (!Number.isNaN(f) && text.trim() !== "") return f; }
  const isHex = text.startsWith("0x");
  const re = isHex ? /^0x[0-9a-fA-F]+$/ : /^\s*[-+]?\d+(_\d+)*\s*$/;
  if (re.test(text)) return isHex ? parseInt(text.slice(2), 16) : parseInt(text.replace(/_/g, ""), 10);
  return parseStringValue(text);
}

/** cmdline.py apply_user_settings() */
export function applyUserSettings(s) {
  s.attrs.ALL_INCOMING_MODULE_JS_API = [...s.attrs.INCOMING_MODULE_JS_API, ...EXTRA_INCOMING_JS_API];
  for (let [key, value] of Object.entries(s.user)) {
    if (s.internal.has(key)) throw new Error(`${key} is an internal setting and cannot be set from command line`);
    const userKey = key;
    if (s.legacy.has(key) && s.altNames.has(key)) key = s.altNames.get(key);
    if (MEM_SIZE_SETTINGS.has(key)) value = expandByteSize(value);
    let filename = null;
    if (value && value[0] === "@") {
      filename = value.slice(1);
      value = fs.readFileSync(filename, "utf8").trim();
    } else value = value.replace(/\\/g, "\\\\");
    const expected = s.types[key];
    let parsed;
    if (filename && expected === "list" && value.trim()[0] !== "[") parsed = value.split(/\r?\n/).filter((v) => !v.startsWith("#")).map((v) => v.trim());
    else parsed = parseValue(value, expected);
    s.set(userKey, parsed);
    if (key === "EXPORTED_FUNCTIONS") s.attrs.USER_EXPORTS = [...s.attrs.EXPORTED_FUNCTIONS];
    if (key === "WASM_OBJECT_FILES") s.attrs.LTO = parsed ? 0 : "full";
  }
}
