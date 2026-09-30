// project-config.js - conservative, portable project configuration
// (.decomp-workbench.toml) and discovery. Discovery records surrounding
// evidence (objdiff, Splat, a build file) and never guesses which of many
// build objects is a function's target: object paths and symbols must be
// unambiguous before they become executable defaults.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { ValueError, sorted, strRepr } from "./py.js";
import { FileNotFoundError } from "./py-extra.js";
import { resolvePath, expanduser, osError } from "./py-path.js";
import { parseToml, TOMLDecodeError } from "./toml.js";
import { CONFIGURED_MACROS, DEFAULT_PRESERVE_MACRO_MODES, NO_MACROS } from "./permute.js";

export const CONFIG_NAME = ".decomp-workbench.toml";
export const PROJECT_CONFIG_SCHEMA = "decomp-workbench-project-v1";
// [permuter] may name the interpreter the original workbench ran the permuter
// under. romdev runs its own JS permuter and never starts that program; the
// key is still accepted so an existing project file loads, and its value is
// reported as written.
const INTERPRETER_KEY = "permuter.python".slice("permuter.".length);

const SECTIONS = new Set(["project", "object", "build", "compiler", "campaign", "permuter"]);
const KEYS = {
  project: new Set(["name"]),
  object: new Set(["target", "candidate", "symbol", "section", "objdump", "input_mode"]),
  build: new Set(["command", "cwd", "env", "inherit_env"]),
  compiler: new Set(["id", "frontend", "language", "driver", "backend"]),
  campaign: new Set(["state_dir", "cache_dir", "retain_sources"]),
  permuter: new Set(["make", INTERPRETER_KEY, "permuter_dir", "object_template", "compiler_marker", "compiler_command", "assembler_command",
    "compiler_type", "preserve_macros", "preserve_macro_modes", "decompme_compiler", "objdump", "output_dir", "ranking", "fallback_flags",
    "skip_postprocess", "minutes", "jobs", "threads", "load_threshold", "nice", "step_timeout_seconds"]),
};

/** shlex.quote / shlex.join */
export function shlexQuote(s) {
  s = String(s);
  if (!s) return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}
export const shlexJoin = (argv) => argv.map(shlexQuote).join(" ");

const PERMUTER_DEFAULTS = Object.freeze({
  make: "make", [INTERPRETER_KEY]: null, permuter_dir: null, object_template: "build/{source}.o", compiler_marker: null, compiler_command: null,
  assembler_command: null, compiler_type: "ido", preserve_macros: [], preserve_macro_modes: [...DEFAULT_PRESERVE_MACRO_MODES],
  decompme_compiler: null, objdump: null, output_dir: null, ranking: null, fallback_flags: [], skip_postprocess: ["\\.py\\b"],
  minutes: 20, jobs: 1, threads: null, load_threshold: 0.0, nice: 15, step_timeout_seconds: 600.0,
});

/** How this project drives the permuter (see the permute commands). */
export class PermuterOptions {
  constructor(fields = {}) { Object.assign(this, { ...PERMUTER_DEFAULTS, ...fields }); Object.freeze(this); }
  asDict() {
    return {
      make: this.make, [INTERPRETER_KEY]: this[INTERPRETER_KEY], permuter_dir: this.permuter_dir ? String(this.permuter_dir) : null,
      object_template: this.object_template, compiler_marker: this.compiler_marker, compiler_command: this.compiler_command,
      assembler_command: this.assembler_command, compiler_type: this.compiler_type, preserve_macros: [...this.preserve_macros],
      preserve_macro_modes: [...this.preserve_macro_modes], decompme_compiler: this.decompme_compiler, objdump: this.objdump,
      output_dir: this.output_dir ? String(this.output_dir) : null, ranking: this.ranking ? String(this.ranking) : null,
      fallback_flags: [...this.fallback_flags], skip_postprocess: [...this.skip_postprocess], minutes: this.minutes, jobs: this.jobs,
      threads: this.threads, load_threshold: this.load_threshold, nice: this.nice, step_timeout_seconds: this.step_timeout_seconds,
    };
  }
}

const CONFIG_DEFAULTS = Object.freeze({
  name: null, target: null, candidate: null, symbol: null, section: ".text", objdump: null, input_mode: "objects", build_command: [],
  build_cwd: null, inherit_env: [], environment: [], compiler_id: null, frontend: null, language: null, driver: null, backend: null,
  state_dir: null, cache_dir: null, retain_sources: "leaders",
});

/** Validated project defaults with paths resolved from the config file. */
export class ProjectConfig {
  constructor(fields) { Object.assign(this, { ...CONFIG_DEFAULTS, permuter: new PermuterOptions(), ...fields }); Object.freeze(this); }
  get root() { return path.dirname(this.path); }
  /** An auditable object-command argv, or a refusal naming what is absent. */
  objectArgv(command) {
    const missing = [["object.target", this.target], ["object.candidate", this.candidate]].filter(([, v]) => v === null).map(([n]) => n);
    if (missing.length) throw new ValueError(`${this.path} cannot run ${command}: missing ${missing.join(", ")}`);
    const argv = [this.input_mode === "dumps" ? `${command}-dumps` : command, String(this.target), String(this.candidate)];
    if (this.symbol) argv.push("--function", this.symbol);
    if (this.section !== ".text") argv.push("--section", this.section);
    if (this.objdump) argv.push("--objdump", this.objdump);
    return argv;
  }
  /** A campaign argv using every configured build identity field. */
  campaignArgv(sources) {
    if (this.target === null) throw new ValueError(`${this.path} cannot run campaign: missing object.target`);
    if (this.input_mode !== "objects") throw new ValueError("project campaign requires object.input_mode = 'objects'");
    if (!sources.length) throw new ValueError("project campaign requires at least one source");
    if (!this.build_command.length) throw new ValueError(`${this.path} cannot run campaign: missing build.command`);
    const template = this.build_command.join(" ");
    for (const ph of ["{source}", "{output}"]) if (!template.includes(ph)) throw new ValueError(`build.command must contain ${ph}`);
    const argv = ["campaign", String(this.target), ...sources, "--compile-command", shlexJoin(this.build_command),
      "--compile-cwd", String(this.build_cwd ?? this.root), "--state-dir", String(this.state_dir ?? path.join(this.root, ".decomp-workbench")),
      "--cache-dir", String(this.cache_dir ?? path.join(this.root, ".decomp-workbench/cache")), "--retain-sources", this.retain_sources];
    for (const e of this.environment) argv.push("--env", e);
    for (const n of this.inherit_env) argv.push("--inherit-env", n);
    for (const [opt, v] of [["--compiler-id", this.compiler_id], ["--frontend", this.frontend], ["--language", this.language],
      ["--driver", this.driver], ["--backend", this.backend], ["--symbol", this.symbol], ["--objdump", this.objdump]]) if (v) argv.push(opt, v);
    if (this.section !== ".text") argv.push("--section", this.section);
    return argv;
  }
  asDict() {
    const shown = (v) => (v !== null && v !== undefined ? String(v) : null);
    return {
      schema: PROJECT_CONFIG_SCHEMA, path: String(this.path), root: this.root, project: { name: this.name },
      object: { target: shown(this.target), candidate: shown(this.candidate), symbol: this.symbol, section: this.section, objdump: this.objdump, input_mode: this.input_mode },
      build: { command_argv: [...this.build_command], cwd: shown(this.build_cwd), inherit_env: [...this.inherit_env], env: [...this.environment] },
      compiler: { id: this.compiler_id, frontend: this.frontend, language: this.language, driver: this.driver, backend: this.backend },
      campaign: { state_dir: shown(this.state_dir), cache_dir: shown(this.cache_dir), retain_sources: this.retain_sources },
      permuter: this.permuter.asDict(),
    };
  }
}

export class ProjectDiscovery {
  constructor({ root, config_path, detected = [], warnings = [], proposed = {} }) { Object.assign(this, { root, config_path, detected, warnings, proposed }); Object.freeze(this); }
  asDict() {
    return { schema: PROJECT_CONFIG_SCHEMA, root: this.root, config_path: this.config_path, detected: [...this.detected], warnings: [...this.warnings], proposed: this.proposed };
  }
}

const isStr = (v) => typeof v === "string";
function pathOf(root, value, field) {
  if (value === null || value === undefined) return null;
  if (!isStr(value) || !value.trim()) throw new ValueError(`${field} must be a non-empty path string`);
  const p = expanduser(value);
  return resolvePath(path.isAbsolute(p) ? p : path.join(root, p));
}
function optionalString(value, field) {
  if (value === null || value === undefined) return null;
  if (!isStr(value) || !value.trim()) throw new ValueError(`${field} must be a non-empty string`);
  return value;
}
function executable(root, value) {
  const exe = optionalString(value, "object.objdump");
  if (exe === null) return null;
  if (!exe.includes("/") && !exe.includes("\\")) return exe;
  const p = expanduser(exe);
  return resolvePath(path.isAbsolute(p) ? p : path.join(root, p));
}
const isTable = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function table(data, name) {
  const value = data[name] ?? {};
  if (!isTable(value)) throw new ValueError(`[${name}] must be a TOML table`);
  const unknown = Object.keys(value).filter((k) => !KEYS[name].has(k));
  if (unknown.length) throw new ValueError(`unknown [${name}] keys: ${sorted(unknown).join(", ")}`);
  return value;
}
function stringList(value, field) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((x) => isStr(x) && x.trim())) throw new ValueError(`${field} must be an array of non-empty strings`);
  return [...value];
}
const isInt = (v) => (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint";
function positiveInteger(value, field, dflt) {
  if (value === null || value === undefined) return dflt;
  if (!isInt(value) || value <= 0) throw new ValueError(`${field} must be a positive integer`);
  return Number(value);
}
function reCompiles(p) { try { new RegExp(p); return null; } catch (e) { return e.message; } }

function permuterOptions(root, data) {
  const macros = stringList(data.preserve_macros, "permuter.preserve_macros");
  if (macros.some((e) => !e.includes("="))) throw new ValueError("permuter.preserve_macros entries must use PATTERN=TYPE");
  let modes = stringList(data.preserve_macro_modes, "permuter.preserve_macro_modes");
  for (const entry of modes) {
    if (entry === CONFIGURED_MACROS || entry === NO_MACROS) continue;
    const bad = reCompiles(entry);
    if (bad) throw new ValueError(`permuter.preserve_macro_modes entry ${strRepr(entry)} is neither ${strRepr(CONFIGURED_MACROS)}, ${strRepr(NO_MACROS)}, nor a valid narrowing regular expression: ${bad}`);
  }
  if (!modes.length) modes = [...DEFAULT_PRESERVE_MACRO_MODES];
  let threads = data.threads ?? null;
  if (threads !== null) threads = positiveInteger(threads, "permuter.threads", 1);
  const load = data.load_threshold ?? 0.0;
  if (typeof load !== "number" && typeof load !== "bigint") throw new ValueError("permuter.load_threshold must be a number");
  if (load < 0) throw new ValueError("permuter.load_threshold must not be negative");
  const nice = data.nice ?? 15;
  if (!isInt(nice)) throw new ValueError("permuter.nice must be an integer");
  const step = data.step_timeout_seconds ?? 600.0;
  if (typeof step !== "number" && typeof step !== "bigint") throw new ValueError("permuter.step_timeout_seconds must be a number");
  if (step <= 0) throw new ValueError("permuter.step_timeout_seconds must be positive");
  const skips = stringList(data.skip_postprocess, "permuter.skip_postprocess");
  for (const pattern of skips) {
    const bad = reCompiles(pattern);
    if (bad) throw new ValueError(`permuter.skip_postprocess entry ${strRepr(pattern)} is not a valid regular expression: ${bad}`);
  }
  const template = data.object_template ?? "build/{source}.o";
  if (!isStr(template) || !template.includes("{")) throw new ValueError("permuter.object_template must name at least one of {source}, {stem}, {name}, {parent}");
  return new PermuterOptions({
    make: optionalString(data.make, "permuter.make") || "make",
    [INTERPRETER_KEY]: optionalString(data[INTERPRETER_KEY], `permuter.${INTERPRETER_KEY}`),
    permuter_dir: pathOf(root, data.permuter_dir, "permuter.permuter_dir"),
    object_template: template,
    compiler_marker: optionalString(data.compiler_marker, "permuter.compiler_marker"),
    compiler_command: optionalString(data.compiler_command, "permuter.compiler_command"),
    assembler_command: optionalString(data.assembler_command, "permuter.assembler_command"),
    compiler_type: optionalString(data.compiler_type, "permuter.compiler_type") || "ido",
    preserve_macros: macros, preserve_macro_modes: modes,
    decompme_compiler: optionalString(data.decompme_compiler, "permuter.decompme_compiler"),
    objdump: executable(root, data.objdump),
    output_dir: pathOf(root, data.output_dir, "permuter.output_dir"),
    ranking: pathOf(root, data.ranking, "permuter.ranking"),
    fallback_flags: stringList(data.fallback_flags, "permuter.fallback_flags"),
    skip_postprocess: skips.length ? skips : [...PERMUTER_DEFAULTS.skip_postprocess],
    minutes: positiveInteger(data.minutes, "permuter.minutes", 20),
    jobs: positiveInteger(data.jobs, "permuter.jobs", 1),
    threads, load_threshold: Number(load), nice: Number(nice), step_timeout_seconds: Number(step),
  });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Load and validate one project config file. */
export function loadProjectConfig(p) {
  const source = resolvePath(p);
  let data;
  try { data = parseToml(fs.readFileSync(source, "utf8")); } catch (e) {
    if (e instanceof TOMLDecodeError) throw new ValueError(`invalid TOML in ${source}: ${e.message}`);
    throw e;
  }
  if (!isTable(data)) throw new ValueError(`project config is not a TOML table: ${source}`);
  const unknown = Object.keys(data).filter((k) => !SECTIONS.has(k));
  if (unknown.length) throw new ValueError(`unknown config sections: ${sorted(unknown).join(", ")}`);
  const root = path.dirname(source);
  const project = table(data, "project"), object = table(data, "object"), build = table(data, "build"),
    compiler = table(data, "compiler"), campaign = table(data, "campaign");
  const permuter = permuterOptions(root, table(data, "permuter"));
  const command = build.command ?? [], inherit = build.inherit_env ?? [], environment = build.env ?? [];
  if (!Array.isArray(command) || !command.every(isStr)) throw new ValueError("build.command must be an array of strings");
  if (!Array.isArray(inherit) || !inherit.every(isStr)) throw new ValueError("build.inherit_env must be an array of environment names");
  if (!Array.isArray(environment) || !environment.every(isStr)) throw new ValueError("build.env must be an array of NAME=VALUE strings");
  if (environment.some((item) => { const i = item.indexOf("="); return i < 0 || !ENV_NAME.test(item.slice(0, i)); })) throw new ValueError("build.env entries must use NAME=VALUE");
  if (inherit.some((item) => !ENV_NAME.test(item))) throw new ValueError("build.inherit_env entries must be environment names");
  const retain = campaign.retain_sources ?? "leaders";
  if (!["leaders", "exact", "all", "none"].includes(retain)) throw new ValueError("campaign.retain_sources must be leaders, exact, all, or none");
  const section = object.section ?? ".text";
  if (!isStr(section) || !section) throw new ValueError("object.section must be a non-empty string");
  const inputMode = object.input_mode ?? "objects";
  if (!["objects", "dumps"].includes(inputMode)) throw new ValueError("object.input_mode must be objects or dumps");
  if (inputMode === "dumps" && object.objdump !== undefined && object.objdump !== null) throw new ValueError("object.objdump does not apply when object.input_mode is dumps");
  return new ProjectConfig({
    path: source, name: optionalString(project.name, "project.name"),
    target: pathOf(root, object.target, "object.target"), candidate: pathOf(root, object.candidate, "object.candidate"),
    symbol: optionalString(object.symbol, "object.symbol"), section, objdump: executable(root, object.objdump), input_mode: String(inputMode),
    build_command: [...command], build_cwd: pathOf(root, build.cwd ?? ".", "build.cwd"), inherit_env: [...inherit], environment: [...environment],
    compiler_id: optionalString(compiler.id, "compiler.id"), frontend: optionalString(compiler.frontend, "compiler.frontend"),
    language: optionalString(compiler.language, "compiler.language"), driver: optionalString(compiler.driver, "compiler.driver"),
    backend: optionalString(compiler.backend, "compiler.backend"),
    state_dir: pathOf(root, campaign.state_dir ?? ".decomp-workbench", "campaign.state_dir"),
    cache_dir: pathOf(root, campaign.cache_dir ?? ".decomp-workbench/cache", "campaign.cache_dir"),
    retain_sources: String(retain),
    permuter: permuter.objdump ? permuter : new PermuterOptions({ ...permuter, objdump: executable(root, object.objdump) }),
  });
}

/** The nearest config file at or above `start`. */
export function findProjectConfig(start = ".", { cwd = process.cwd() } = {}) {
  let current = resolvePath(start, cwd);
  try { if (fs.statSync(current).isFile()) current = path.dirname(current); } catch { /* a directory, or missing */ }
  for (let dir = current; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, CONFIG_NAME);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    if (path.dirname(dir) === dir) break;
  }
  throw new FileNotFoundError(`no ${CONFIG_NAME} found from ${current} or its parents`);
}

/** Record surrounding evidence without guessing an object pair. */
export function discoverProject(root, { cwd = process.cwd() } = {}) {
  const directory = resolvePath(root, cwd);
  let isDir = false;
  try { isDir = fs.statSync(directory).isDirectory(); } catch {}
  if (!isDir) throw new ValueError(`project root is not a directory: ${directory}`);
  const detected = [], warnings = [];
  const proposed = { project: { name: path.basename(directory) }, object: { section: ".text" },
    campaign: { state_dir: ".decomp-workbench", cache_dir: ".decomp-workbench/cache", retain_sources: "leaders" } };
  const objdiff = path.join(directory, "objdiff.json");
  let objdiffFile = false;
  try { objdiffFile = fs.statSync(objdiff).isFile(); } catch {}
  if (objdiffFile) {
    detected.push({ kind: "objdiff", path: objdiff });
    let problem = null;
    try {
      const payload = JSON.parse(fs.readFileSync(objdiff, "utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) problem = "root is not an object";
    } catch (e) { problem = e.message; }
    if (problem) warnings.push(`could not parse objdiff.json: ${problem}`);
    else warnings.push("objdiff.json detected; object selection is intentionally not guessed because its units can name many targets");
  }
  const yamls = sorted(fs.readdirSync(directory).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).map((f) => path.join(directory, f)));
  const splat = [];
  for (const c of yamls) {
    let head;
    try { head = fs.readFileSync(c).subarray(0, 262144).toString("utf8").slice(0, 65536); } catch { continue; }
    if (head.includes("segments:") && head.includes("options:")) splat.push(c);
  }
  for (const c of splat) detected.push({ kind: "splat", path: c });
  if (splat.length) warnings.push("Splat config detected; ROM and segment metadata do not identify one unambiguous target/candidate object pair");
  for (const filename of ["Makefile", "justfile"]) {
    const f = path.join(directory, filename);
    let ok = false;
    try { ok = fs.statSync(f).isFile(); } catch {}
    if (ok) { detected.push({ kind: "build", path: f }); break; }
  }
  return new ProjectDiscovery({ root: directory, config_path: path.join(directory, CONFIG_NAME), detected, warnings, proposed });
}

/** json.dumps(value, ensure_ascii=False) for a TOML basic string. */
function tomlString(value) {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"'; else if (ch === "\\") out += "\\\\"; else if (ch === "\n") out += "\\n"; else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t"; else if (ch === "\b") out += "\\b"; else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`; else out += ch;
  }
  return out + '"';
}

/** Render the small supported TOML surface. */
export function renderProjectConfig(discovery) {
  const lines = ["# n64-decomp-workbench project defaults", ""];
  for (const section of ["project", "object", "build", "compiler", "campaign"]) {
    const values = discovery.proposed[section];
    if (!values || !Object.keys(values).length) continue;
    lines.push(`[${section}]`);
    for (const [key, value] of Object.entries(values)) {
      let rendered;
      if (isStr(value)) rendered = tomlString(value);
      else if (Array.isArray(value)) rendered = "[" + value.map((x) => tomlString(String(x))).join(", ") + "]";
      else throw new ValueError(`cannot render ${section}.${key}: unsupported value`);
      lines.push(`${key} = ${rendered}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const cloneProposed = (d) => Object.fromEntries(Object.entries(d.proposed).map(([k, v]) => [k, { ...v }]));

export function withObjectOverrides(discovery, { target = null, candidate = null, symbol = null, objdump = null, input_mode = "objects" }) {
  const proposed = cloneProposed(discovery);
  const object = (proposed.object ??= { section: ".text" });
  object.input_mode = input_mode;
  for (const [name, value] of [["target", target], ["candidate", candidate], ["symbol", symbol], ["objdump", objdump]]) if (value !== null && value !== undefined) object[name] = value;
  return new ProjectDiscovery({ ...discovery, proposed });
}

/** Attach only explicitly supplied compiler execution and lineage data. */
export function withBuildOverrides(discovery, { command = null, cwd = null, environment = [], inherit_env = [], compiler_id = null, frontend = null, language = null, driver = null, backend = null }) {
  if (command === null && (cwd !== null || environment.length || inherit_env.length)) throw new ValueError("--compile-cwd, --env, and --inherit-env require --compile-command");
  if (command !== null && !command.length) throw new ValueError("--compile-command must contain an executable");
  const proposed = cloneProposed(discovery);
  if (command !== null) proposed.build = { command, cwd: cwd || ".", env: environment, inherit_env };
  const lineage = Object.fromEntries([["id", compiler_id], ["frontend", frontend], ["language", language], ["driver", driver], ["backend", backend]].filter(([, v]) => v !== null && v !== undefined));
  if (Object.keys(lineage).length) proposed.compiler = lineage;
  return new ProjectDiscovery({ ...discovery, proposed });
}

/** Create the config file; never overwrite. */
export function writeProjectConfig(discovery) {
  fs.mkdirSync(path.dirname(discovery.config_path), { recursive: true });
  try { fs.writeFileSync(discovery.config_path, renderProjectConfig(discovery), { flag: "wx" }); } catch (e) {
    if (e.code === "EEXIST") throw osError(`[Errno 17] File exists: '${discovery.config_path}'`, "EEXIST");
    throw e;
  }
  return discovery.config_path;
}
