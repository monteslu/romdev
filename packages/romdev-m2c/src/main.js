// Port of m2c/main.py
import fs from "node:fs";
import { build_typemap, dump_typemap } from "./c_types.js";
import { DecompFailure } from "./error.js";
import { build_flowgraph } from "./flow_graph.js";
import { get_function_text } from "./if_statements.js";
import { CodingStyle, Options, Target } from "./options.js";
import { AsmData, parse_file } from "./asm_file.js";
import { InstrProcessingFailure } from "./instruction.js";
import { GlobalInfo, narrow_func_call_outputs, translate_to_ast, visualize_flowgraph } from "./translate.js";
import { TypePool } from "./types.js";
import { MipsArch, MipseeArch } from "./arch_mips.js";
import { ValueError, int_ } from "./py.js";
import { capture, print, write } from "./io.js";

let graphviz = null;
/** Graphviz compiled to WASM, loaded only when --visualize is used. */
async function loadGraphviz() {
  if (!graphviz) graphviz = (await import("@viz-js/viz")).instance();
  return graphviz;
}

let archModules = null;
async function loadArchModules() {
  if (archModules) return archModules;
  const [ppc, arm, sh] = await Promise.all([import("./arch_ppc.js"), import("./arch_arm.js"), import("./arch_sh.js")]);
  archModules = { ppc, arm, sh };
  return archModules;
}

class DecompilationState {
  constructor(fn, state) {
    this.function = fn;
    this.state = state; // {flow_graph, info} or an Error
  }
}

function isError(x) {
  return x instanceof Error;
}

/** Python traceback.format_exception_only-ish rendering for internal errors. */
function print_exception(exc) {
  let e = exc;
  if (e instanceof InstrProcessingFailure && e.cause) e = e.cause;
  const name = e && e.name ? e.name : "Error";
  const msg = e && e.message !== undefined ? e.message : String(e);
  print("Traceback (most recent call last):");
  if (e && e.stack) {
    for (const line of String(e.stack).split("\n").slice(1)) print(`  ${line.trim()}`);
  }
  print(msg ? `${name}: ${msg}` : name);
}

function print_exception_as_comment(exc, options, context) {
  const context_phrase = context !== null ? ` in ${context}` : "";
  if (exc && (exc.code === "ENOENT" || exc.code === "EACCES" || exc.code === "EISDIR")) {
    print(`/* OSError${context_phrase}: ${exc.message} */`);
    return;
  } else if (exc instanceof DecompFailure) {
    print("/*");
    print(`Decompilation failure${context_phrase}:\n`);
    print(exc.message);
    if (options.stacktrace && exc.cause) {
      print();
      print_exception(exc.cause);
    }
    print("*/");
  } else {
    print("/*");
    print(`Internal error${context_phrase}:\n`);
    print_exception(exc);
    print("*/");
  }
}

function make_arch(options, mods) {
  const t = options.target;
  if (t.arch === Target.ArchEnum.MIPS) return t.platform === Target.PlatformEnum.MIPSEE ? new MipseeArch() : new MipsArch();
  if (t.arch === Target.ArchEnum.PPC) return new mods.ppc.PpcArch();
  if (t.arch === Target.ArchEnum.ARM) return t.platform === Target.PlatformEnum.GBA ? new mods.arm.ArmGbaArch() : new mods.arm.ArmArch();
  if (t.arch === Target.ArchEnum.SH) return t.platform === Target.PlatformEnum.SH4 ? new mods.sh.Sh4Arch() : new mods.sh.Sh2Arch();
  throw new ValueError(`Invalid target arch: ${t.arch}`);
}

/**
 * Run m2c with parsed options, printing to the current io sink. Returns the exit code.
 * Arch modules for non-MIPS targets are loaded by run_async / decompile.
 */
export function run(options, mods = archModules ?? {}) {
  const arch = make_arch(options, mods);

  const all_functions = new Map();
  const asm_data = new AsmData();
  let typemap;
  try {
    for (const filename of options.filenames) {
      let text;
      if (typeof filename === "object" && filename !== null) text = filename.text;
      else if (filename === "-") text = fs.readFileSync(0, "utf8");
      else text = fs.readFileSync(filename, "utf8");
      const name = typeof filename === "object" && filename !== null ? filename.name : filename;
      const asm_file = parse_file({ name, text }, arch, options);
      for (const fn of asm_file.functions) all_functions.set(fn.name, fn);
      asm_file.asm_data.merge_into(asm_data);
    }
    if (options.heuristic_strings) asm_data.detect_heuristic_strings();
    typemap = build_typemap(options.c_contexts, arch, options.use_cache);
  } catch (e) {
    print_exception_as_comment(e, options, null);
    return 1;
  }

  if (options.dump_typemap) {
    dump_typemap(typemap);
    return 0;
  }

  let functions;
  if (!options.function_indexes_or_names.length) functions = [...all_functions.values()];
  else {
    const functions_by_c_name = new Map();
    for (const [name, fn] of all_functions) functions_by_c_name.set(arch.c_symbol_name(name), fn);
    functions = [];
    for (const index_or_name of options.function_indexes_or_names) {
      if (typeof index_or_name === "number") {
        if (!(0 <= index_or_name && index_or_name < all_functions.size)) {
          print(`Function index ${index_or_name} is out of bounds (must be between ` + `0 and ${all_functions.size - 1}).`, { __print_opts: true, stderr: true });
          return 1;
        }
        functions.push([...all_functions.values()][index_or_name]);
      } else {
        let fn = all_functions.get(index_or_name) ?? null;
        if (fn === null) fn = functions_by_c_name.get(index_or_name) ?? null;
        if (fn === null) {
          print(`Function ${index_or_name} not found.`, { __print_opts: true, stderr: true });
          return 1;
        }
        functions.push(fn);
      }
    }
  }

  const fmt = options.formatter();
  const function_names = new Set(all_functions.keys());
  const typepool = new TypePool({
    unknown_field_prefix: fmt.coding_style.unknown_underscore ? "unk_" : "unk",
    unk_inference: options.unk_inference,
    union_field_overrides: options.union_field_overrides,
  });
  const global_info = new GlobalInfo(asm_data, arch, options.target, function_names, typemap, typepool, {
    deterministic_vars: options.deterministic_vars,
    stack_spill_detection: options.stack_spill_detection,
  });

  const decompilations = [];
  for (const fn of functions) {
    let state;
    try {
      narrow_func_call_outputs(fn, global_info);
      const flow_graph = build_flowgraph(fn, global_info.asm_data, arch, { fragment: false, print_warnings: options.debug, debug_patterns: options.debug_patterns });
      state = { flow_graph, info: null };
    } catch (e) {
      state = e;
    }
    decompilations.push(new DecompilationState(fn, state));
  }

  let global_decls_exc = null;
  for (let i = 0; i < options.passes - 1; i++) {
    for (const decomp of decompilations) {
      if (isError(decomp.state)) continue;
      const flow_graph = decomp.state.flow_graph;
      try {
        flow_graph.reset_block_info();
        decomp.state.info = translate_to_ast(decomp.function, flow_graph, options, global_info);
      } catch (e) {
        decomp.state = e;
      }
    }
    if (global_decls_exc === null) {
      try {
        global_info.global_decls(fmt, options.global_decls, []);
      } catch (e) {
        global_decls_exc = e;
      }
    }
    for (const decomp of decompilations) {
      if (isError(decomp.state)) continue;
      const info = decomp.state.info;
      try {
        get_function_text(info, options);
      } catch (e) {
        decomp.state = e;
      }
    }
    typepool.prune_structs();
  }

  for (const decomp of decompilations) {
    if (isError(decomp.state)) continue;
    const flow_graph = decomp.state.flow_graph;
    try {
      flow_graph.reset_block_info();
      decomp.state.info = translate_to_ast(decomp.function, flow_graph, options, global_info);
    } catch (e) {
      decomp.state = e;
    }
  }

  if (options.visualize_flowgraph !== null) {
    const decomp = decompilations[0];
    try {
      if (isError(decomp.state)) throw decomp.state;
      const dot_source = visualize_flowgraph(decomp.state.flow_graph, options.visualize_flowgraph);
      if (options.visualize_format === Options.VisualizeFormatEnum.SVG) {
        // Upstream pipes the dot source through graphviz; here graphviz runs as WASM (@viz-js/viz).
        if (!mods.viz) throw new DecompFailure("SVG visualization: graphviz WASM not loaded (call decompile(), which loads it)");
        write(mods.viz.renderString(dot_source, { format: "svg" }));
      } else write(dot_source);
      return 0;
    } catch (e) {
      print_exception_as_comment(e, options, null);
      return 1;
    }
  }

  let return_code = 0;
  try {
    const type_decls = typepool.format_type_declarations(fmt, options.print_stack_structs);
    if (type_decls) print(type_decls);
    if (global_decls_exc !== null) throw global_decls_exc;
    const infos = decompilations.filter((d) => !isError(d.state) && d.state.info !== null).map((d) => d.state.info);
    const global_decls = global_info.global_decls(fmt, options.global_decls, infos);
    if (global_decls) print(global_decls);
  } catch (e) {
    print_exception_as_comment(e, options, null);
    return_code = 1;
  }

  decompilations.forEach((decomp, index) => {
    if (index !== 0) print();
    const fn = decomp.function;
    try {
      if (options.print_assembly) {
        print(String(fn));
        print();
      }
      if (isError(decomp.state)) throw decomp.state;
      const function_text = get_function_text(decomp.state.info, options);
      print(function_text);
    } catch (e) {
      print_exception_as_comment(e, options, `function ${fn.name}`);
      return_code = 1;
    }
  });

  for (const warning of typepool.warnings) {
    const line = fmt.with_comments("", [warning]);
    if (line) print(line);
  }
  return return_code;
}

// ---------------------------------------------------------------- flags

const BOOL_FLAGS = {
  "--no-cache": ["use_cache", false],
  "--stack-structs": ["print_stack_structs", true],
  "--debug": ["debug", true],
  "--debug-patterns": ["debug_patterns", true],
  "--stacktrace": ["stacktrace", true],
  "--print-assembly": ["print_assembly", true],
  "--dump-typemap": ["dump_typemap", true],
  "--sanitize-tracebacks": ["sanitize_tracebacks", true],
  "--valid-syntax": ["valid_syntax", true],
  "--allman": ["allman", true],
  "--knr": ["knr", true],
  "--indent-switch-contents": ["indent_switch_contents", true],
  "--unk-underscore": ["unknown_underscore", true],
  "--hex-case": ["hex_case", true],
  "--no-casts": ["skip_casts", true],
  "--zfill-constants": ["zfill_constants", true],
  "--force-decimal": ["force_decimal", true],
  "--deterministic-vars": ["deterministic_vars", true],
  "--descending-regs": ["descending_regs", true],
  "--backwards-bss": ["backwards_bss", true],
  "--stop-on-error": ["stop_on_error", true],
  "--void": ["void", true],
  "--gotos-only": ["ifs", false],
  "--no-ifs": ["ifs", false],
  "--no-switches": ["switch_detection", false],
  "--no-andor": ["andor_detection", false],
  "--no-unk-inference": ["unk_inference", false],
  "--no-stack-spill": ["stack_spill_detection", false],
  "--heuristic-strings": ["heuristic_strings", true],
  "--pdb-translate": ["pdb_translate", true],
  "--disable-gc": ["disable_gc", true],
};
const VALUE_FLAGS = {
  "--context": "c_contexts",
  "-D": "defined",
  "-U": "undefined",
  "--incbin-dir": "incbin_dirs",
  "-f": "functions",
  "--function": "functions",
  "--globals": "global_decls",
  "--visualize-format": "visualize_format",
  "--pointer-style": "pointer_style",
  "--comment-style": "comment_style",
  "--comment-column": "comment_column",
  "-t": "target",
  "--target": "target",
  "--passes": "passes",
  "-P": "passes",
  "--reg-vars": "reg_vars",
  "--goto": "goto_patterns",
  "--union-field": "union_fields",
};
const APPEND = new Set(["c_contexts", "defined", "undefined", "incbin_dirs", "functions", "goto_patterns", "union_fields"]);

export class ArgumentError extends Error {}

const ALL_LONG = [...Object.keys(BOOL_FLAGS), ...Object.keys(VALUE_FLAGS), "--visualize"].filter((o) => o.startsWith("--"));
function has_opt(flag) {
  return ALL_LONG.includes(flag);
}

/** Parse m2c command-line flags (subset-compatible with upstream argparse). Returns Options. */
export function parse_flags(flags) {
  const args = {
    filenames: [],
    c_contexts: [],
    use_cache: true,
    defined: [],
    undefined: [],
    incbin_dirs: [],
    functions: [],
    global_decls: "used",
    print_stack_structs: false,
    debug: false,
    debug_patterns: false,
    stacktrace: false,
    print_assembly: false,
    dump_typemap: false,
    visualize_flowgraph: null,
    visualize_format: "svg",
    sanitize_tracebacks: false,
    valid_syntax: false,
    allman: false,
    knr: false,
    indent_switch_contents: false,
    pointer_style: "right",
    unknown_underscore: false,
    hex_case: false,
    comment_style: "multiline",
    comment_column: "52",
    skip_casts: false,
    zfill_constants: false,
    force_decimal: false,
    deterministic_vars: false,
    descending_regs: false,
    backwards_bss: false,
    target: "mips-ido-c",
    passes: "2",
    stop_on_error: false,
    void: false,
    ifs: true,
    switch_detection: true,
    andor_detection: true,
    unk_inference: true,
    stack_spill_detection: true,
    heuristic_strings: false,
    reg_vars: null,
    goto_patterns: ["GOTO"],
    pdb_translate: false,
    disable_gc: false,
    union_fields: [],
  };
  for (let i = 0; i < flags.length; i++) {
    let flag = flags[i];
    if (typeof flag !== "string") {
      args.filenames.push(flag);
      continue;
    }
    let value = null;
    if (flag.startsWith("--") && flag.includes("=")) {
      value = flag.slice(flag.indexOf("=") + 1);
      flag = flag.slice(0, flag.indexOf("="));
    } else if (/^-[DUftP]./.test(flag) && !flag.startsWith("--")) {
      value = flag.slice(2);
      flag = flag.slice(0, 2);
    }
    if (flag.startsWith("--") && !has_opt(flag)) {
      // argparse accepts unambiguous prefixes of long options
      const matches = ALL_LONG.filter((o) => o.startsWith(flag));
      if (matches.length === 1) flag = matches[0];
      else if (matches.length > 1) throw new ArgumentError(`ambiguous option: ${flag} could match ${matches.join(", ")}`);
    }
    if (flag === "--visualize") {
      if (value === null && i + 1 < flags.length && (flags[i + 1] === "asm" || flags[i + 1] === "c")) value = flags[++i];
      args.visualize_flowgraph = value ?? "c";
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, flag)) {
      const [k, v] = BOOL_FLAGS[flag];
      args[k] = v;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, flag)) {
      if (value === null) {
        if (i + 1 >= flags.length) throw new ArgumentError(`argument ${flag}: expected one argument`);
        value = flags[++i];
      }
      const k = VALUE_FLAGS[flag];
      if (APPEND.has(k)) args[k] = k === "goto_patterns" ? [...args[k], value] : [...args[k], value];
      else args[k] = value;
      continue;
    }
    if (flag.startsWith("-") && flag !== "-") throw new ArgumentError(`unrecognized arguments: ${flag}`);
    args.filenames.push(flag);
  }
  if (!args.filenames.length) throw new ArgumentError("the following arguments are required: filename");

  const reg_vars = args.reg_vars ? args.reg_vars.split(",") : [];
  const preproc_defines = new Map();
  for (const d of args.undefined) preproc_defines.set(d, null);
  for (const d of args.defined) {
    const i = d.indexOf("=");
    if (i >= 0) preproc_defines.set(d.slice(0, i), int_(d.slice(i + 1), 0));
    else preproc_defines.set(d, 1);
  }

  const coding_style = new CodingStyle({
    newline_after_function: args.allman || args.knr,
    newline_after_if: args.allman,
    newline_before_else: args.allman,
    switch_indent_level: args.indent_switch_contents ? 2 : 1,
    pointer_style_left: args.pointer_style === "left",
    unknown_underscore: args.unknown_underscore,
    hex_case: args.hex_case,
    comment_style: CodingStyle.CommentStyle.of(args.comment_style),
    comment_column: int_(args.comment_column),
  });

  const functions = [];
  for (const fn of args.functions) {
    try {
      functions.push(int_(fn));
    } catch (e) {
      if (!(e instanceof ValueError)) throw e;
      functions.push(fn);
    }
  }

  const union_field_overrides = new Map();
  for (const override of args.union_fields) {
    const i = override.indexOf(":");
    if (i < 0) throw new ArgumentError(`Error: Invalid union field override '${override}'. Expected format: STRUCT_NAME:FIELD_NAME`);
    union_field_overrides.set(override.slice(0, i), override.slice(i + 1));
  }

  let visualize_flowgraph = args.visualize_flowgraph === null ? null : Options.VisualizeTypeEnum.of(args.visualize_flowgraph);
  if (visualize_flowgraph !== null) {
    args.debug = false;
    args.debug_patterns = false;
  }

  return new Options({
    filenames: args.filenames,
    function_indexes_or_names: functions,
    debug: args.debug,
    debug_patterns: args.debug_patterns,
    stacktrace: args.stacktrace,
    void: args.void,
    ifs: args.ifs,
    switch_detection: args.switch_detection,
    andor_detection: args.andor_detection,
    skip_casts: args.skip_casts,
    zfill_constants: args.zfill_constants,
    force_decimal: args.force_decimal,
    heuristic_strings: args.heuristic_strings,
    reg_vars,
    goto_patterns: args.goto_patterns,
    stop_on_error: args.stop_on_error,
    print_assembly: args.print_assembly,
    visualize_flowgraph,
    visualize_format: Options.VisualizeFormatEnum.of(args.visualize_format),
    c_contexts: args.c_contexts,
    use_cache: args.use_cache,
    dump_typemap: args.dump_typemap,
    pdb_translate: args.pdb_translate,
    preproc_defines,
    coding_style,
    sanitize_tracebacks: args.sanitize_tracebacks,
    valid_syntax: args.valid_syntax,
    global_decls: Options.GlobalDeclsEnum.of(args.global_decls),
    target: Target.parse(args.target),
    print_stack_structs: args.print_stack_structs,
    unk_inference: args.unk_inference,
    stack_spill_detection: args.stack_spill_detection,
    passes: int_(args.passes),
    incbin_dirs: args.incbin_dirs,
    deterministic_vars: args.deterministic_vars,
    descending_regs: args.descending_regs,
    backwards_bss: args.backwards_bss,
    disable_gc: args.disable_gc,
    union_field_overrides,
  });
}

/**
 * In-process equivalent of running upstream m2c with <flags>: returns { code, stdout, stderr }.
 * Asm inputs may be file paths, or {name, text} objects mixed into `flags`.
 */
export async function decompile(flags) {
  const mods = { ...(await loadArchModules()) };
  if (flags.some((f) => typeof f === "string" && f.startsWith("--visualize"))) mods.viz = await loadGraphviz();
  let options;
  try {
    options = parse_flags(flags);
  } catch (e) {
    if (e instanceof ArgumentError || e instanceof ValueError) return { code: 2, stdout: "", stderr: `m2c: error: ${e.message}\n` };
    throw e;
  }
  const r = capture(() => run(options, mods));
  return { code: r.value, stdout: r.stdout, stderr: r.stderr };
}
