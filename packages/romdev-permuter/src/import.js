// import.js - decomp-permuter's import.py: turn a C file + a function's asm +
// the project's compile command into a permuter directory
// (nonmatchings/<fn>/{base.c,compile.sh,target.s,target.o,base.o,settings.toml}),
// or upload it to decomp.me.
//
// Every external program upstream runs (make --dry-run / ninja -t commands,
// cpp, the assembler, compile.sh) goes through a toolchain adapter so romdev
// can run them as WASM/JS; see resolveToolchain(). The adapter contract:
//   buildCommandLines({root, cFile, makeFlags, buildSystem}) -> {lines, invocation}
//       what `make --always-make --dry-run --debug=j PERMUTER=1 <flags>` (or
//       `ninja -t commands <flags>`) would print, as text lines
//   preprocess({cwd, argv, stdin}) -> string      argv[0] is "cpp"
//   run({cwd, argv}) -> {code, log}               the assembler
//   compileScript({script, input, output}) -> boolean   run a compile.sh
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync, rmSync, renameSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ast_util from "./ast_util.js";
import { CandidateConstructionFailure } from "./error.js";
import { get_default_randomization_weights, parseToml } from "./helpers.js";
import { shlexSplit } from "./scorer.js";
import { Compiler } from "./compiler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ASM_PRELUDE_FILE = path.join(here, "..", "prelude.inc");
export const DEFAULT_AS_CMDLINE = ["mips-linux-gnu-as", "-march=vr4300", "-mabi=32"];
const RE_FUNC_NAME = /^[a-zA-Z0-9_$]+$/;
export const CPP = ["cpp", "-P", "-undef"];
export const STUB_FN_MACROS = [
  "-D_Static_assert(x, y)=",
  "-D__attribute__(x)=",
  "-DGLOBAL_ASM(...)=",
  "-D__asm__(...)=_permuter_ignore_line __asm__(__VA_ARGS__)",
];
export const SETTINGS_FILES = ["permuter_settings.toml", "tools/permuter_settings.toml", "config/permuter_settings.toml"];

/** sys.exit(1) with a message on stderr (the CLI turns it into an exit code). */
export class ImportExit extends Error {
  constructor(message, code = 1) { super(message); this.name = "ImportExit"; this.code = code; }
}

/** shlex.quote */
export function shq(s) {
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}
export const formatcmd = (cmdline) => cmdline.map(shq).join(" ");

function json_dict(data, prop, allow_missing = true) {
  if (!(prop in data)) {
    if (allow_missing) return {};
    throw new Error(`missing "${prop}" property`);
  }
  const ret = data[prop];
  if (ret == null || typeof ret !== "object" || Array.isArray(ret)) throw new Error(`"${prop}" property must be a dict`);
  return ret;
}

/** str.splitlines(keepends=True) */
function splitlinesKeep(s) {
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n" || s[i] === "\r") {
      const end = s[i] === "\r" && s[i + 1] === "\n" ? i + 2 : i + 1;
      out.push(s.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}
const pySplit = (s) => s.split(/\s+/).filter(Boolean);

export function prune_asm(asm_cont, log) {
  let func_name = null;
  const asm_lines = [];
  const late_rodata = [];
  let cur_section = ".text";
  for (const line of splitlinesKeep(asm_cont)) {
    let changed_section = false;
    const line_parts = pySplit(line);
    if (line_parts.length >= 2 && line_parts[0] === ".section") {
      cur_section = line_parts[1];
      changed_section = true;
    } else if ([".text", ".rdata", ".rodata", ".late_rodata", ".bss", ".data"].includes(line.trim())) {
      cur_section = line.trim();
      changed_section = true;
    }
    if (cur_section === ".late_rodata") {
      if (!changed_section) late_rodata.push(line);
      continue;
    }
    if (func_name == null && cur_section === ".text" && line_parts.length >= 2 && (line_parts[0] === "glabel" || line_parts[0] === ".globl")) {
      func_name = line_parts[1];
    }
    asm_lines.push(line);
  }
  if (late_rodata.length) asm_lines.push("\n.section .rodata\n", ...late_rodata);
  if (func_name == null) throw new ImportExit("Missing function name in assembly file! The file should start with 'glabel function_name'.");
  if (!RE_FUNC_NAME.test(func_name)) throw new ImportExit(`Bad function name: ${func_name}`);
  void log;
  return [func_name, asm_lines.join("")];
}

function find_global_asm_func(root_dir, c_file, func_name) {
  let source;
  try { source = readFileSync(c_file, "utf8"); } catch (e) { throw new ImportExit(`Could not open C file: ${e.message}`); }
  let global_asm = null;
  for (const line of splitlinesKeep(source)) {
    let stop_global_asm = false;
    if (global_asm != null) {
      if (line.startsWith(")")) stop_global_asm = true;
      else global_asm.push(line);
    } else {
      if (!line.startsWith("GLOBAL_ASM(") && !line.startsWith("#pragma GLOBAL_ASM(")) continue;
      global_asm = [];
      if (line.includes(")")) {
        const ind = line.indexOf("(");
        const ind2 = line.indexOf(")", ind);
        const fname = path.join(root_dir, line.slice(ind + 2, ind2 - 1));
        try {
          global_asm.push(...splitlinesKeep(readFileSync(fname, "utf8")));
        } catch (e) {
          throw new ImportExit(`Failed to open GLOBAL_ASM file ${fname}: ${e.message}`);
        }
        stop_global_asm = true;
      }
    }
    if (stop_global_asm) {
      for (const line2 of global_asm) if (line2.includes("glabel " + func_name)) return global_asm.join("");
      global_asm = null;
    }
  }
  throw new ImportExit(`Failed to find GLOBAL_ASM for function ${func_name}.`);
}

export function parse_asm(root_dir, c_file, asm_file_or_func_name) {
  let require_matching_func_name = false;
  let asm_cont;
  try {
    asm_cont = readFileSync(asm_file_or_func_name, "utf8");
  } catch (e) {
    if (RE_FUNC_NAME.test(asm_file_or_func_name)) {
      asm_cont = find_global_asm_func(root_dir, c_file, asm_file_or_func_name);
      require_matching_func_name = true;
    } else {
      throw new ImportExit(`Could not open assembly file: ${e.message}`);
    }
  }
  const ret = prune_asm(asm_cont);
  if (require_matching_func_name && ret[0] !== asm_file_or_func_name) throw new ImportExit("GLOBAL_ASM file contains multiple functions.");
  return ret;
}

export function create_directory(func_name, cwd = process.cwd()) {
  mkdirSync(path.join(cwd, "nonmatchings"), { recursive: true });
  for (let ctr = 1; ; ctr++) {
    const dirname = `nonmatchings/${ctr > 1 ? `${func_name}-${ctr}` : func_name}`;
    try {
      mkdirSync(path.join(cwd, dirname));
      return dirname;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

export function find_root_dir(filename, pattern) {
  let old_dirname = null;
  let dirname = path.dirname(path.resolve(filename));
  while (dirname && (!old_dirname || dirname.length < old_dirname.length)) {
    for (const fname of pattern) {
      try { if (statSync(path.join(dirname, fname)).isFile()) return dirname; } catch { /* absent */ }
    }
    old_dirname = dirname;
    dirname = path.dirname(dirname);
  }
  return null;
}

export function fixup_build_command(parts, ignore_part) {
  let res = [];
  let skip_count = 0;
  let assembler = null;
  const last_o = parts.length - 1 - [...parts].reverse().indexOf("-o");
  parts.forEach((part, i) => {
    if (skip_count > 0) { skip_count--; return; }
    if (["-MF", "-MT", "-MQ"].includes(part) || i === last_o) { skip_count = 1; return; }
    if (["-M", "-MM", "-MG", "-MP", "-MD", "-MMD", "-Mno-modules"].includes(part)) return;
    if (part === ignore_part) return;
    res.push(part);
  });
  // An asm-processor wrapper in the recorded command (upstream matches these
  // four substrings); only its argv is read, nothing is run.
  const idx = res.findIndex((arg) => /asm_processor|asm-processor|build\.py|preprocess\.py/.test(arg));
  if (idx >= 0) {
    const ind1 = res.indexOf("--", idx + 1);
    const ind2 = ind1 >= 0 ? res.indexOf("--", ind1 + 1) : -1;
    if (ind1 >= 0 && ind2 >= 0) {
      const compiler = res.slice(idx + 1, ind1);
      assembler = res.slice(ind1 + 1, ind2);
      const compiler_args = res.slice(ind2 + 1);
      while (compiler.length && compiler[0].startsWith("-")) {
        const flag = compiler.shift();
        if (["--input-enc", "--output-enc", "--asm-prelude", "--convert-statics", "--keep-preprocessed"].includes(flag)) compiler.shift();
      }
      res = [...compiler, ...compiler_args];
    }
  }
  return [res, assembler];
}

export async function find_build_command_line(toolchain, root_dir, c_file, make_flags, build_system) {
  if (build_system !== "make" && build_system !== "ninja") throw new ImportExit(`Unknown build system '${build_system}'.`, 1);
  const rel_c_file = path.relative(root_dir, path.resolve(c_file));
  const { lines: debug_output, invocation } = await toolchain.buildCommandLines({ root: root_dir, cFile: rel_c_file, makeFlags: make_flags, buildSystem: build_system });
  const output = [];
  let close_match = "";
  let assembler = DEFAULT_AS_CMDLINE;
  for (let line of debug_output) {
    while (line.includes("//")) line = line.replaceAll("//", "/");
    while (line.includes("/./")) line = line.replaceAll("/./", "/");
    if (!line.includes(rel_c_file)) continue;
    close_match = line;
    let parts = shlexSplit(line);
    if (parts[0] === "bash" && parts.includes("-c")) {
      for (const part of parts) {
        if (part.includes(rel_c_file)) { parts = shlexSplit(part); break; }
      }
    }
    if (!parts.includes(rel_c_file)) continue;
    if (!parts.includes("-o")) continue;
    if (parts.includes("-fsyntax-only")) continue;
    const [cmdline, asmproc_assembler] = fixup_build_command(parts, rel_c_file);
    if (asmproc_assembler) assembler = asmproc_assembler;
    output.push(cmdline);
  }
  if (!output.length) {
    const close_extra = close_match ? "\nFound one possible candidate, but didn't match due to "
      + "either spaces in paths, having -fsyntax-only, or missing an -o flag:\n" + close_match : "";
    throw new ImportExit("Failed to find compile command from build script output. "
      + `Please ensure running '${invocation.join(" ")}' contains a line with the string '${rel_c_file}'.${close_extra}`);
  }
  if (output.length > 1) {
    throw new ImportExit(`Error: found multiple compile commands for ${rel_c_file}:\n${output.map(formatcmd).join("\n")}\n`
      + `Please modify the build script such that '${invocation.join(" ")}' produces a single compile command.`);
  }
  return [output[0], assembler];
}

export function build_preserve_macros(preserve_regex, settings) {
  const subdata = json_dict(settings, "preserve_macros");
  const regexes = [];
  for (const [regex, value] of Object.entries(subdata)) {
    if (typeof value !== "string") throw new Error("AssertionError: preserve_macros values must be strings");
    regexes.push([new RegExp(`^(?:${regex})$`), value]);
  }
  if (preserve_regex === "" || (preserve_regex == null && !regexes.length)) return null;
  const global_regex_text = preserve_regex == null ? "(?:" + Object.keys(subdata).join(")|(?:") + ")" : preserve_regex;
  const global_regex = new RegExp(`^(?:${global_regex_text})$`);
  const type_fn = (macro) => {
    for (const [regex, value] of regexes) if (regex.test(macro)) return value;
    return "int";
  };
  return [global_regex, type_fn];
}

async function preprocess_c_with_macros(toolchain, cpp_command, cwd, preserve_macros) {
  const [preserve_regex, preserve_type_fn] = preserve_macros;
  let source = await toolchain.preprocess({ cwd, argv: [...cpp_command, "-dD", "-fdirectives-only"] });
  source = source.replace(/^\s*#\s*define\s+([a-zA-Z0-9_]+)([ \t(]|$)/gm, (_m, name, g2) => {
    const after = g2 === "(" ? "(" : " ";
    return preserve_regex.test(name) ? `_permuter define ${name}${after}` : `#define ${name}${after}`;
  });
  source = source.replace(/^#define __STDC_[^\n]*\n/gm, "");
  source = await toolchain.preprocess({ cwd, argv: [...CPP, ...STUB_FN_MACROS], stdin: source });
  const late_defines = [];
  const lines = [];
  const graph = new Map();
  const g = (k) => { if (!graph.has(k)) graph.set(k, new Set()); return graph.get(k); };
  for (let line of source.split(/\r\n|\r|\n/).filter((_, i, a) => !(i === a.length - 1 && a[i] === ""))) {
    const is_macro = line.startsWith("_permuter define ");
    let params = [];
    let ignore = false;
    if (line.includes("_permuter_ignore_line ")) {
      line = line.replaceAll("_permuter_ignore_line ", "");
      ignore = true;
    }
    let name;
    if (is_macro) {
      const ind1 = line.indexOf("(");
      const ind2 = line.indexOf(" ", "_permuter define ".length);
      let ind = Math.min(ind1, ind2);
      if (ind === -1) ind = ind1 === -1 && ind2 === -1 ? line.length : Math.max(ind1, ind2);
      const before = line.slice(0, ind);
      const after = line.slice(ind);
      name = pySplit(before)[2];
      late_defines.push([name, after]);
      if (after.startsWith("(")) params = after.slice(1, after.indexOf(")")).split(",").map((w) => w.trim());
    } else {
      if (ignore) lines.push(`#pragma _permuter b64literal ${Buffer.from(line, "utf8").toString("base64")}`);
      else lines.push(line);
      name = "";
    }
    for (const m of line.matchAll(/[a-zA-Z0-9_]+/g)) {
      const name2 = m[0];
      let has_wildcard = false;
      if (is_macro && !params.includes(name2)) {
        const wcbefore = line.slice(0, m.index).replace(/\s+$/, "").endsWith("##");
        const wcafter = line.slice(m.index + name2.length).replace(/^\s+/, "").startsWith("##");
        if (wcbefore || wcafter) {
          g(name).add(name2 + "*");
          has_wildcard = true;
        }
      }
      if (!has_wildcard) g(name).add(name2);
    }
  }
  const used_anywhere = new Set();
  const used_by_nonmacro = g("");
  const queue = [""];
  while (queue.length) {
    const name = queue.pop();
    if (!used_anywhere.has(name)) {
      used_anywhere.add(name);
      if (name.endsWith("*")) {
        const wildcard = name.slice(0, -1);
        for (const [name2, set] of graph) if (name2.includes(wildcard)) queue.push(...set);
      } else {
        queue.push(...g(name));
      }
    }
  }
  const get_decl = (name, after) => {
    const typ = preserve_type_fn(name);
    return after.startsWith("(") ? `${typ} ${name}();` : `extern ${typ} ${name};`;
  };
  const used_macros = late_defines.filter(([name]) => used_by_nonmacro.has(name)).map(([name]) => name);
  return [[
    "#pragma _permuter latedefine start",
    ...late_defines.filter(([name]) => used_anywhere.has(name)).map(([name, after]) => `#pragma _permuter define ${name}${after}`),
    ...late_defines.filter(([name]) => used_by_nonmacro.has(name)).map(([name, after]) => get_decl(name, after)),
    "#pragma _permuter latedefine end",
    ...lines,
    "",
  ].join("\n"), used_macros];
}

export async function import_c_file(toolchain, compiler, cwd, in_file, preserve_macros, log) {
  in_file = path.relative(cwd, path.resolve(in_file));
  let include_next = 0;
  const cpp_command = [...CPP, in_file, "-D__sgi", "-D_LANGUAGE_C", "-DNON_MATCHING", "-DNONMATCHING", "-DPERMUTER",
    "-D_MIPS_SZINT=32", "-D_MIPS_SZLONG=32"];
  for (const arg of compiler) {
    if (include_next > 0) { include_next--; cpp_command.push(arg); continue; }
    if (["-D", "-U", "-I"].includes(arg)) { cpp_command.push(arg); include_next = 1; continue; }
    if (arg.startsWith("-D") || arg.startsWith("-U") || arg.startsWith("-I") || arg === "-nostdinc") cpp_command.push(arg);
  }
  let source, macros;
  try {
    if (preserve_macros == null) {
      source = await toolchain.preprocess({ cwd, argv: [...cpp_command, ...STUB_FN_MACROS] });
      macros = [];
    } else {
      [source, macros] = await preprocess_c_with_macros(toolchain, cpp_command, cwd, preserve_macros);
    }
  } catch (e) {
    throw new ImportExit("Failed to preprocess input file, when running command:\n" + formatcmd(e.argv ?? cpp_command) + (e.message ? `\n${e.message}` : ""));
  }
  log(`Preserving ${macros.length ? "macros: " + macros.join(", ") : "no macros"}. Use --preserve-macros='<regex>' to override.`);
  return source;
}

export function prune_source(source, should_prune, func_name, log) {
  try {
    const ast = ast_util.parse_c(source, { from_import: true });
    const [orig_fn] = ast_util.extract_fn(ast, func_name);
    if (should_prune) {
      try {
        ast_util.prune_ast(orig_fn, ast);
        source = ast_util.to_c_raw(ast);
      } catch (e) {
        log("Source minimization failed! You could try --no-prune as a workaround.");
        throw e;
      }
    }
    return [source, ast_util.to_c(ast, { from_import: true })];
  } catch (e) {
    if (!(e instanceof CandidateConstructionFailure)) throw e;
    log(e.message);
    if (should_prune && source.includes("PERM_")) log("Please put in PERM macros after import, otherwise source minimization does not work.");
    else log("Proceeding anyway, but expect errors when permuting!");
    return [source, null];
  }
}

export function prune_and_separate_context(source, should_prune, func_name, log) {
  let ast;
  try {
    ast = ast_util.parse_c(source, { from_import: true });
  } catch (e) {
    if (!(e instanceof CandidateConstructionFailure)) throw e;
    log(e.message);
    log("Unable to split context from source.");
    log("Using the entire source as context.");
    return ["", ast_util.process_pragmas(source)];
  }
  let orig_fn, ind;
  try {
    [orig_fn, ind] = ast_util.extract_fn(ast, func_name);
  } catch (e) {
    if (!(e instanceof CandidateConstructionFailure)) throw e;
    log(e.message);
    log("Falling back to just removing function bodies.");
    return ["", ast_util.to_c(ast, { from_import: true })];
  }
  if (should_prune) {
    try {
      ind = ast_util.prune_ast(orig_fn, ast);
    } catch (e) {
      log("Source minimization failed! You could try --no-prune as a workaround.");
      throw e;
    }
  }
  ast.ext.splice(ind, 1);
  return [ast_util.to_c(orig_fn, { from_import: true }), ast_util.to_c(ast, { from_import: true })];
}

/** fnmatch.fnmatch (POSIX: case-sensitive). */
export function fnmatch(name, pat) {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") re += "[\\s\\S]*";
    else if (c === "?") re += "[\\s\\S]";
    else if (c === "[") {
      let j = i + 1;
      if (pat[j] === "!") j++;
      if (pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j >= pat.length) re += "\\[";
      else {
        let stuff = pat.slice(i + 1, j).replaceAll("\\", "\\\\");
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        re += `[${stuff}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`).test(name);
}

async function get_decompme_compiler_name(compiler, settings, api_base, log) {
  const compiler_mappings = json_dict(json_dict(settings, "decompme"), "compilers");
  const compiler_path = compiler[0];
  for (const [p, compiler_name] of Object.entries(compiler_mappings)) {
    if (typeof compiler_name !== "string") throw new Error("AssertionError");
    if (fnmatch(compiler_path, p)) return compiler_name;
  }
  let available_ids = [];
  try {
    const r = await fetch(`${api_base}/api/compiler`, { headers: { "User-Agent": "decomp-permuter" } });
    const json_data = await r.json();
    available_ids = Object.keys(json_dict(json_data, "compilers", false));
  } catch (e) {
    log(`Failed to request available compilers from decomp.me:\n${e.message}`);
  }
  log("");
  log(`Unable to map compiler path "${compiler_path}" to something decomp.me understands.`);
  const trail = "permuter_settings.toml, where ... is one of: " + available_ids.join(", ");
  if (Object.keys(compiler_mappings).length) {
    log(`Please add an entry: (wildcards allowed!)\n\n"${compiler_path}" = "..."\n\nto the [decompme.compilers] section of ${trail}`);
  } else {
    log(`Please add a section: (wildcards allowed!)\n\n[decompme.compilers]\n"${compiler_path}" = "..."\n\nto ${trail}`);
  }
  throw new ImportExit("", 1);
}

export function finalize_compile_command(cmdline) {
  const quoted = cmdline.map((arg) => (arg === "|" ? arg : shq(arg)));
  const ind = [...quoted, "|"].indexOf("|");
  return [...quoted.slice(0, ind), '"$INPUT"', ...quoted.slice(ind), "-o", '"$OUTPUT"'].join(" ");
}

export function get_compiler_flags(settings, cmdline) {
  const flags = json_dict(settings, "decompme").flags;
  if (flags) {
    if (typeof flags !== "string") throw new Error("AssertionError");
    return flags;
  }
  const out = [];
  for (let k = 0; k + 1 < cmdline.length; k++) if (cmdline[k] !== "|" && cmdline[k + 1] !== "|") out.push(cmdline[k + 1]);
  return out.map(shq).join(" ");
}

export function write_compile_command(compiler, cwd, out_file) {
  writeFileSync(out_file, "#!/usr/bin/env bash\nset -euo pipefail\nINPUT=\"$(realpath \"$1\")\"\nOUTPUT=\"$(realpath \"$3\")\"\n"
    + `cd ${shq(cwd)}\n` + finalize_compile_command(compiler));
  chmodSync(out_file, 0o755);
}

export function write_asm(asm_prelude_file, asm_cont, out_file) {
  const asm_prelude = readFileSync(asm_prelude_file || DEFAULT_ASM_PRELUDE_FILE, "utf8");
  writeFileSync(out_file, asm_prelude + asm_cont);
}

async function compile_asm(toolchain, assembler, cwd, in_file, out_file) {
  const cmdline = [...assembler, path.resolve(in_file), "-o", path.resolve(out_file)];
  const r = await toolchain.run({ cwd, argv: cmdline });
  if (r.code !== 0) throw new ImportExit(`Failed to assemble .s file, command line:\n${formatcmd(cmdline)}${r.log ? "\n" + r.log : ""}`);
}

/** json.dumps(str) with ensure_ascii. */
function pyJsonStr(s) {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

async function compile_base(toolchain, compile_script, source, c_file, out_file, tmpDir, log) {
  if (source.includes("PERM_")) {
    log("Cannot test-compile imported code because it contains PERM macros. It is recommended to put in PERM macros after import.");
    return;
  }
  source = "#line 1 " + pyJsonStr(c_file) + "\n" + source;
  const compiler = new Compiler(null, { show_errors: true, tmpDir, log: (s) => process.stderr.write(s),
    compileFn: (c, o) => toolchain.compileScript({ script: compile_script, input: c, output: o }) });
  const o_file = await compiler.compile(source);
  if (o_file) {
    try { renameSync(o_file, out_file); } catch { copyFileSync(o_file, out_file); rmSync(o_file, { force: true }); }
  } else {
    log("Warning: failed to compile .c file.");
  }
}

/** Python repr of a float weight (100.0, 0.5, 1e-05). */
function pyFloat(x) {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const s = String(x);
  if (/e/.test(s)) return s.replace(/e([+-])(\d)$/, "e$10$2");
  if (Math.abs(x) < 1e-4 && x !== 0) {
    const [m, e] = x.toExponential().split("e");
    return `${m}e${e[0]}${e.slice(1).padStart(2, "0")}`;
  }
  return s;
}

export function create_write_settings_toml(func_name, compiler_type, filename, objdump_command = null) {
  const rand_weights = get_default_randomization_weights(compiler_type);
  let s = `func_name = "${func_name}"\ncompiler_type = "${compiler_type}"\n`;
  if (objdump_command) s += `objdump_command = "${objdump_command}"\n`;
  s += "\n# uncomment lines below to customize randomization pass weights\n# see --help=randomization-passes for descriptions\n[weight_overrides]\n";
  for (const [key, weight] of Object.entries(rand_weights)) s += `# ${key} = ${pyFloat(weight)}\n`;
  writeFileSync(filename, s);
}

/** A TOML value as the permuter's settings reader sees it (ints unwrapped). */
function plain(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("int" in v && Object.keys(v).length === 1) return v.int;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

/**
 * The adapter that runs build/cpp/as/compile.sh. Order: an explicit module,
 * ROMDEV_PERMUTER_TOOLCHAIN, then romdev's own (romdevtools'
 * src/decomp/permuter-toolchain.js) when this package sits in the romdev tree
 * or beside an installed romdevtools.
 */
export function resolveToolchainUrl(spec = process.env.ROMDEV_PERMUTER_TOOLCHAIN) {
  const candidates = [];
  if (spec) candidates.push(spec);
  candidates.push(path.join(here, "..", "..", "romdevtools", "src", "decomp", "permuter-toolchain.js"));
  try { candidates.push(fileURLToPath(new URL("./src/decomp/permuter-toolchain.js", import.meta.resolve("romdevtools/package.json")))); } catch { /* not installed */ }
  for (const c of candidates) {
    const file = c.startsWith("file:") ? fileURLToPath(c) : path.resolve(c);
    if (existsSync(file)) return pathToFileURL(file).href;
  }
  return null;
}

export async function resolveToolchain(spec) {
  const url = resolveToolchainUrl(spec);
  return url ? import(url) : null;
}

/**
 * import.py main().
 * @param {string[]} arg_list
 * @param {{log?: (s:string)=>void, toolchain?: object, cwd?: string}} [opts]
 * @returns {Promise<string|null>} the created directory (null for --decompme)
 */
export async function importMain(arg_list, { log = (s) => console.log(s), toolchain = null, cwd = process.cwd() } = {}) {
  const args = parseImportArgs(arg_list);
  toolchain ??= await resolveToolchain();
  if (!toolchain) throw new ImportExit("no toolchain adapter: import needs romdev's (romdevtools) or ROMDEV_PERMUTER_TOOLCHAIN");
  const c_file = path.resolve(cwd, args.c_file);
  const root_dir = find_root_dir(c_file, [...SETTINGS_FILES, "Makefile", "makefile", "build.ninja"]);
  if (!root_dir) throw new ImportExit("Can't find root dir of project!");
  let settings = {};
  if (args.settings_file) {
    const sf = path.resolve(cwd, args.settings_file);
    if (!existsSync(sf)) throw new ImportExit("Can't find settings file!");
    settings = plain(parseToml(readFileSync(sf, "utf8")));
  } else {
    for (const filename of SETTINGS_FILES) {
      const f = path.join(root_dir, filename);
      if (existsSync(f)) { settings = plain(parseToml(readFileSync(f, "utf8"))); break; }
    }
  }
  const get_setting = (key) => {
    const value = settings[key];
    if (value == null) return null;
    if (typeof value !== "string") throw new ImportExit(`Value of ${key} in settings.toml must be a string, but found: ${value}`);
    return value;
  };
  const build_system_raw = get_setting("build_system");
  const build_system = build_system_raw || "make";
  const compiler_str = get_setting("compiler_command") || "";
  const assembler_str = get_setting("assembler_command") || "";
  let asm_prelude_file = get_setting("asm_prelude_file");
  const objdump_command = get_setting("objdump_command");
  if (asm_prelude_file != null) asm_prelude_file = path.join(root_dir, asm_prelude_file);
  let compiler_type = get_setting("compiler_type");
  if (compiler_type != null) log(`Compiler type: ${compiler_type}`);
  else {
    compiler_type = "base";
    log("Warning: Compiler type is missing from this project's permuter settings.\n"
      + "Defaulting to base compiler randomization settings. For best permutation results,\n"
      + "please set 'compiler_type' in this project's permuter_settings.toml.");
  }
  const asmArg = existsSync(path.resolve(cwd, args.asm_file_or_func_name)) ? path.resolve(cwd, args.asm_file_or_func_name) : args.asm_file_or_func_name;
  const [func_name, asm_cont] = parse_asm(root_dir, c_file, asmArg);
  log(`Function name: ${func_name}`);
  let compiler, assembler;
  if (compiler_str || assembler_str) {
    if (build_system_raw != null) throw new Error("AssertionError: Must not specify both build system and compiler/assembler");
    compiler = shlexSplit(compiler_str);
    assembler = shlexSplit(assembler_str);
  } else {
    [compiler, assembler] = await find_build_command_line(toolchain, root_dir, c_file, args.make_flags, build_system);
  }
  log(`Compiler: ${finalize_compile_command(compiler)}`);
  log(`Assembler: ${formatcmd(assembler)} "$INPUT" -o "$OUTPUT"`);
  const preserve_macros = build_preserve_macros(args.preserve_macros_regex, settings);
  let source = await import_c_file(toolchain, compiler, root_dir, c_file, preserve_macros, log);

  if (args.decompme) {
    const api_base = process.env.DECOMPME_API_BASE || "https://decomp.me";
    const compiler_name = await get_decompme_compiler_name(compiler, settings, api_base, log);
    let context;
    [source, context] = prune_and_separate_context(source, args.prune, func_name, log);
    try {
      const body = new URLSearchParams({ name: func_name, target_asm: asm_cont, context, source_code: source,
        compiler: compiler_name, compiler_flags: get_compiler_flags(settings, compiler), diff_label: func_name });
      const r = await fetch(`${api_base}/api/scratch`, { method: "POST", body, headers: { "User-Agent": "decomp-permuter" } });
      const resp = await r.text();
      const json_data = JSON.parse(resp);
      if ("slug" in json_data) {
        const token = json_data.claim_token;
        log(token ? `https://decomp.me/scratch/${json_data.slug}/claim?token=${token}` : `https://decomp.me/scratch/${json_data.slug}`);
      } else {
        log(`Server error: ${json_data.error ?? resp}`);
      }
    } catch (e) {
      log(String(e.message ?? e));
    }
    return null;
  }

  let compilable_source;
  [source, compilable_source] = prune_source(source, args.prune, func_name, log);
  const dirname = create_directory(func_name, cwd);
  const abs = (f) => path.join(cwd, f);
  const base_c_file = `${dirname}/base.c`;
  const compile_script = `${dirname}/compile.sh`;
  try {
    writeFileSync(abs(base_c_file), source);
    create_write_settings_toml(func_name, compiler_type, abs(`${dirname}/settings.toml`), objdump_command);
    write_compile_command(compiler, root_dir, abs(compile_script));
    write_asm(asm_prelude_file, asm_cont, abs(`${dirname}/target.s`));
    await compile_asm(toolchain, assembler, root_dir, abs(`${dirname}/target.s`), abs(`${dirname}/target.o`));
    if (compilable_source != null) {
      await compile_base(toolchain, abs(compile_script), compilable_source, base_c_file, abs(`${dirname}/base.o`),
        path.join(cwd, dirname, ".import-tmp"), log);
      rmSync(path.join(cwd, dirname, ".import-tmp"), { recursive: true, force: true });
    }
  } catch (e) {
    if (!args.keep) {
      log(`\nDeleting directory ${dirname} (run with --keep to preserve it).`);
      rmSync(abs(dirname), { recursive: true, force: true });
    }
    throw e;
  }
  log(`\nDone. Imported into ${dirname}`);
  return path.join(cwd, dirname);
}

/** import.py's argparse surface. */
export function parseImportArgs(argv) {
  const out = { keep: false, prune: true, decompme: false, preserve_macros_regex: null, settings_file: null, make_flags: [] };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") && a.includes("=") ? a.indexOf("=") : -1;
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    const val = () => {
      if (eq >= 0) return a.slice(eq + 1);
      if (i + 1 >= argv.length) throw new ImportExit(`argument ${flag}: expected one argument`, 2);
      return argv[++i];
    };
    if (flag === "--keep") out.keep = true;
    else if (flag === "--no-prune") out.prune = false;
    else if (flag === "--decompme") out.decompme = true;
    else if (flag === "--preserve-macros") out.preserve_macros_regex = val();
    else if (flag === "--settings") out.settings_file = val();
    else if (a === "--") pos.push(...argv.slice(i + 1)), (i = argv.length);
    else pos.push(a);
  }
  if (pos.length < 2) throw new ImportExit("the following arguments are required: c_file, {asm_file|func_name}", 2);
  [out.c_file, out.asm_file_or_func_name] = pos;
  out.make_flags = pos.slice(2);
  return out;
}
