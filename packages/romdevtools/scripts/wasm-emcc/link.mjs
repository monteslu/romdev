// link.mjs - the link half of emcc (tools/link.py, tools/emscripten.py,
// tools/building.py, tools/system_libs.py selection), in JS.
//
// Scope: the link shapes romdev's build scripts use (MODULARIZE + EXPORT_ES6
// glue for node, MEMFS or NODERAWFS, with or without emscripten EH/SjLj).
// Anything outside that is refused with an explicit "unsupported" error
// rather than approximated, so a build either matches emcc or stops.
//
// The heavy lifting stays in emscripten's own JS (tools/compiler.mjs,
// tools/acorn-optimizer.mjs, tools/preprocessor.mjs), LLVM's wasm-ld (WASM,
// via llvm.mjs) and binaryen's wasm-opt / wasm-metadce (WASM, npm binaryen).
// Only the orchestration that emcc.py does in Python is ported here.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runLLVMTool } from "./llvm.mjs";
import { extractMetadata, stripSections } from "./wasm.mjs";

const UNSUPPORTED = 0x7fffffff;
const VALID_ENVIRONMENTS = ["web", "webview", "worker", "node", "shell"];
const MIN_BROWSER = {
  MUTABLE_GLOBALS: { chrome: 74, firefox: 61, safari: 130100, node: 120000 },
  NON_TRAPPING_FPTOINT: { chrome: 75, firefox: 65, safari: 150000, node: 130000 },
  SIGN_EXT: { chrome: 74, firefox: 62, safari: 140100, node: 120000 },
  BULK_MEMORY: { chrome: 75, firefox: 79, safari: 150000, node: 130000 },
  JS_BIGINT_INTEGRATION: { chrome: 67, firefox: 78, safari: 150000, node: 130000 },
  THREADS: { chrome: 74, firefox: 79, safari: 140100, node: 160400 },
  PROMISE_ANY: { chrome: 85, firefox: 79, safari: 140000, node: 150000 },
};

export const unsupported = (what) => { throw new Error(`wasm-emcc: unsupported: ${what} (not used by romdev's builds yet; port it from emscripten's link.py before relying on it)`); };

const isCSymbol = (n) => n.startsWith("_");
const demangleC = (n) => (isCSymbol(n) ? n.slice(1) : "$" + n);
const INTERNAL_START_STOP = new Set(["__start_em_asm", "__stop_em_asm", "__start_em_js", "__stop_em_js", "__start_em_lib_deps", "__stop_em_lib_deps", "__em_lib_deps"]);
const isInternalGlobal = (n) => INTERNAL_START_STOP.has(n) || n.startsWith("__em_js__") || n.startsWith("__em_lib_deps");
const isUserExport = (n) => !isInternalGlobal(n) && n !== "__indirect_function_table" && n !== "memory" && !n.startsWith("dynCall_") && !n.startsWith("orig$");
export const asmjsMangle = (n) => { if (n === "__main_argc_argv") n = "main"; return isUserExport(n) ? "_" + n : n; };
const dedup = (l) => [...new Set(l)];

function caniuse(S, feature) {
  const req = MIN_BROWSER[feature];
  return !(S.get("MIN_CHROME_VERSION") < req.chrome || S.get("MIN_FIREFOX_VERSION") < req.firefox || S.get("MIN_SAFARI_VERSION") < req.safari || S.get("MIN_NODE_VERSION") < req.node);
}

function suffix(f) { const b = path.basename(f); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; }
const unsuffixed = (f) => { const s = suffix(f); return s ? f.slice(0, -s.length) : f; };

/** tools/link.py phase_linker_setup (romdev subset). Returns {target, wasmTarget, oformat}. */
export function linkerSetup(ctx) {
  const { S, opts } = ctx;
  const has = (k) => k in S.user;
  // setup_environment_settings
  const env = S.get("ENVIRONMENT");
  const maybeWebWorker = !env.length || env.includes("worker");
  if (S.get("SHARED_MEMORY") && env.length) env.push("worker");
  for (const e of env) if (!VALID_ENVIRONMENTS.includes(e)) throw new Error(`Invalid environment specified in "ENVIRONMENT": ${env}`);
  S.set("ENVIRONMENT_MAY_BE_WEB", !env.length || env.includes("web"));
  S.set("ENVIRONMENT_MAY_BE_WEBVIEW", !env.length || env.includes("webview"));
  S.set("ENVIRONMENT_MAY_BE_NODE", !env.length || env.includes("node"));
  S.set("ENVIRONMENT_MAY_BE_SHELL", !env.length || env.includes("shell"));
  S.set("ENVIRONMENT_MAY_BE_WORKER", !env.length || env.includes("worker"));
  if (!S.get("ENVIRONMENT_MAY_BE_NODE")) S.set("MIN_NODE_VERSION", UNSUPPORTED);
  if (!(S.get("ENVIRONMENT_MAY_BE_WEB") || maybeWebWorker || S.get("ENVIRONMENT_MAY_BE_WEBVIEW"))) {
    for (const b of ["FIREFOX", "SAFARI", "CHROME"]) S.set(`MIN_${b}_VERSION`, UNSUPPORTED);
  }
  // apply_library_settings
  for (const a of ctx.linkerArgs) if (/^-l(embind|glfw3?|SDL|SDL2_mixer)$/.test(a)) unsupported(`library setting ${a}`);
  // calc_extra_ldflags
  ctx.libDirs.push(ctx.sysrootLib, path.join(ctx.emRoot, "src/lib"));
  ctx.linkerArgs.push("-L" + ctx.sysrootLib, "-L" + path.join(ctx.emRoot, "src/lib"));
  for (const k of ["FETCH", "STB_IMAGE", "WASMFS"]) if (S.get(k)) unsupported(k);

  const autoconf = process.env.EMMAKEN_JUST_CONFIGURE || opts.inputFiles.some((f) => /^conftest\.c(pp)?$/.test(f));
  if (autoconf) { S.set("EXIT_RUNTIME", 1); S.set("NODERAWFS", 1); opts.executable = true; }
  if (S.get("OPT_LEVEL") >= 1) S.setDefault("ASSERTIONS", 0);
  const dbg = ["LIBRARY_DEBUG", "GL_DEBUG", "DYLINK_DEBUG", "OPENAL_DEBUG", "SYSCALL_DEBUG", "WEBSOCKET_DEBUG", "SOCKET_DEBUG", "FETCH_DEBUG", "EXCEPTION_DEBUG", "PTHREADS_DEBUG", "ASYNCIFY_DEBUG"].some((k) => S.get(k));
  S.setDefault("RUNTIME_DEBUG", dbg ? 1 : 0);
  if (opts.emrun || opts.cpuProfiler || opts.memoryProfiler || S.get("PTHREADS_PROFILING") || opts.jsTransform) unsupported("emrun/profilers/js-transform");

  let target = opts.outputFile ?? (autoconf ? "a.out" : S.get("SIDE_MODULE") ? "a.out.wasm" : "a.out.js");
  const dir = path.dirname(target);
  if (dir && !fs.existsSync(dir)) throw new Error(`specified output file (${target}) is in a directory that does not exist`);
  const finalSuffix = suffix(target);
  if (S.get("WASM_ESM_INTEGRATION") || S.get("SOURCE_PHASE_IMPORTS") || S.get("MODULARIZE") === "instance") unsupported("WASM_ESM_INTEGRATION / MODULARIZE=instance");
  if (opts.relocatable || opts.shared) unsupported("-r / -shared");
  let oformat = opts.oformat;
  if (!oformat) {
    if (S.get("SIDE_MODULE") || finalSuffix === ".wasm") oformat = "WASM";
    else if (finalSuffix === ".html") oformat = "HTML";
    else if (finalSuffix === ".mjs" || S.get("EXPORT_ES6")) oformat = "MJS";
    else oformat = "JS";
  }
  if (oformat === "HTML") unsupported("HTML output");
  if (oformat === "MJS") S.setDefault("EXPORT_ES6", 1);
  S.set("OUTPUT_FORMAT", oformat);
  for (const k of ["JS_BASE64_API", "GROWABLE_ARRAYBUFFERS", "SUPPORT_BIG_ENDIAN", "WASM_JS_TYPES", "ASYNCIFY", "MINIMAL_RUNTIME", "SINGLE_FILE", "MAIN_MODULE", "SIDE_MODULE", "RELOCATABLE", "LINKABLE", "EMBIND", "WASM_WORKERS", "AUDIO_WORKLET", "PROXY_TO_PTHREAD", "PROXY_TO_WORKER", "MEMORY64", "SAFE_HEAP", "EVAL_CTORS", "SPLIT_MODULE", "EMSCRIPTEN_TRACING", "WASM_EXCEPTIONS", "STRICT", "LZ4", "PURE_WASI", "USE_CLOSURE_COMPILER", "DETERMINISTIC", "MEMORYPROFILER", "STB_IMAGE", "BUILD_AS_WORKER", "EXPORT_EXCEPTION_HANDLING_HELPERS", "EXCEPTION_STACK_TRACES"]) {
    if (S.get(k)) unsupported(k);
  }
  if (S.get("MODULARIZE") && S.get("MODULARIZE") !== 1) throw new Error(`Invalid setting "${S.get("MODULARIZE")}" for MODULARIZE.`);
  let wasmTarget;
  if (oformat === "WASM") wasmTarget = target;
  else if (S.get("WASM") === 0) unsupported("WASM=0 (wasm2js)");
  else { wasmTarget = unsuffixed(target) + ".wasm"; if (wasmTarget === target) throw new Error("output file has the same name as the wasm target"); }
  if (S.get("WASM") === 2) unsupported("WASM=2");
  if (oformat === "WASM") S.set("STANDALONE_WASM", 1);

  if (opts.noEntry) S.set("EXPECT_MAIN", 0);
  else if (S.get("STANDALONE_WASM")) { /* _main noted only */ }
  else if (has("EXPORTED_FUNCTIONS")) {
    if (S.get("USER_EXPORTS").includes("_main")) {
      S.get("EXPORTED_FUNCTIONS").splice(S.get("EXPORTED_FUNCTIONS").indexOf("_main"), 1);
      S.get("EXPORT_IF_DEFINED").push("main");
    } else S.set("EXPECT_MAIN", 0);
  } else S.get("EXPORT_IF_DEFINED").push("main");

  if (S.get("STANDALONE_WASM")) {
    if (has("EXIT_RUNTIME")) throw new Error("explicitly setting EXIT_RUNTIME not compatible with STANDALONE_WASM");
    S.set("EXIT_RUNTIME", S.get("EXPECT_MAIN"));
    S.set("IGNORE_MISSING_MAIN", 0);
    S.setDefault("LEGALIZE_JS_FFI", 0);
  }
  for (const e of S.get("EXPORTED_FUNCTIONS")) ctx.userRequestedExports.add(e);
  if (S.get("EXPORTED_FUNCTIONS").includes("_main") || S.get("EXPORT_IF_DEFINED").includes("main")) S.get("EXPORT_IF_DEFINED").push("__main_argc_argv");
  else if (S.get("ASSERTIONS") && !S.get("STANDALONE_WASM")) S.get("EXPORT_IF_DEFINED").push("main", "__main_argc_argv");
  if (S.get("ASSERTIONS")) {
    if (S.get("WASM_EXCEPTIONS") || !S.get("DISABLE_EXCEPTION_CATCHING")) unsupported("ASSERTIONS with exception catching (EXCEPTION_STACK_TRACES)");
    if (!S.get("PURE_WASI") && !opts.nostdlib && !opts.nodefaultlibs) S.setDefault("STACK_OVERFLOW_CHECK", Math.max(S.get("ASSERTIONS"), S.get("STACK_OVERFLOW_CHECK")));
  }
  if (S.user.WARN_ON_UNDEFINED_SYMBOLS === "0") S.setDefault("ERROR_ON_UNDEFINED_SYMBOLS", 0);
  if (S.get("EXPORT_ES6") && !S.get("MODULARIZE")) {
    if (has("MODULARIZE")) throw new Error("EXPORT_ES6 requires MODULARIZE to be set");
    S.set("MODULARIZE", 1);
  }
  const DLF = S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE");
  DLF.push("$wasmMemory");
  if (S.get("INCOMING_MODULE_JS_API").includes("noExitRuntime")) DLF.push("$noExitRuntime");
  if (S.get("SHRINK_LEVEL") >= 2 && !S.get("AUDIO_WORKLET") && !S.get("ENVIRONMENT_MAY_BE_SHELL")) S.setDefault("TEXTDECODER", 2);
  if (process.env.EMCC_AUTODEBUG) unsupported("EMCC_AUTODEBUG");
  if (S.get("DYNCALLS")) DLF.push("$dynCall");
  if (S.get("ASSERTIONS")) DLF.push("$warnOnce");
  DLF.push("$getValue", "$setValue");
  DLF.push("$ExitStatus");
  if (S.get("LOAD_SOURCE_MAP") || S.get("PROXY_TO_WORKER") || (S.get("WASM_ASYNC_COMPILATION") && !S.get("MODULARIZE"))) DLF.push("$addRunDependency", "$removeRunDependency");
  if (S.get("ABORT_ON_WASM_EXCEPTIONS") || S.get("SPLIT_MODULE")) DLF.push("$wasmTable");
  if (S.get("EMULATE_FUNCTION_POINTER_CASTS")) S.set("DYNCALLS", 1);
  if (S.get("RUNTIME_DEBUG") || S.get("ASSERTIONS") || S.get("STACK_OVERFLOW_CHECK") || S.get("PTHREADS_PROFILING") || S.get("GL_ASSERTIONS")) DLF.push("$ptrToString");
  const RE = S.get("REQUIRED_EXPORTS");
  if (S.get("STACK_OVERFLOW_CHECK")) RE.push("emscripten_stack_get_end", "emscripten_stack_get_free", "emscripten_stack_get_base", "emscripten_stack_get_current", "emscripten_stack_init");
  if (S.get("STACK_OVERFLOW_CHECK") >= 2) DLF.push("$setStackLimits");
  // check_browser_versions
  for (const [k, oldest] of [["MIN_FIREFOX_VERSION", 68], ["MIN_CHROME_VERSION", 74], ["MIN_SAFARI_VERSION", 120200], ["MIN_NODE_VERSION", 122209]]) {
    if (S.get("LEGACY_VM_SUPPORT")) S.setDefault(k, 0);
    if (S.get(k) !== 0 && S.get(k) < oldest) throw new Error(`${k} older than ${oldest} is not supported`);
  }
  if (S.get("MIN_NODE_VERSION") >= 150000) S.setDefault("NODEJS_CATCH_REJECTION", 0);
  if (S.get("MODULARIZE")) { S.setDefault("NODEJS_CATCH_REJECTION", 0); S.setDefault("NODEJS_CATCH_EXIT", 0); }
  if (S.get("POLYFILL")) S.set("TRANSPILE", S.get("MIN_FIREFOX_VERSION") < 79 || S.get("MIN_CHROME_VERSION") < 85 || S.get("MIN_SAFARI_VERSION") < 140000 || S.get("MIN_NODE_VERSION") < 160000);
  if (S.get("TRANSPILE")) unsupported("TRANSPILE (babel)");
  if (S.get("USE_WEBGL2")) S.set("MAX_WEBGL_VERSION", 2);
  if (S.get("MIN_WEBGL_VERSION") === 2) S.setDefault("MAX_WEBGL_VERSION", 2);
  if (S.get("MIN_WEBGL_VERSION") > S.get("MAX_WEBGL_VERSION")) throw new Error("MIN_WEBGL_VERSION must be smaller or equal to MAX_WEBGL_VERSION!");
  if (opts.preloadFiles.length || opts.embedFiles.length || opts.usePreloadPlugins) unsupported("--preload-file / --embed-file");
  if (S.get("FORCE_FILESYSTEM") && !S.get("FILESYSTEM")) throw new Error("`-sFORCE_FILESYSTEM` cannot be used with `-sFILESYSTEM=0`");
  if (S.get("FULL_ES3")) { S.set("FULL_ES2", 1); S.set("MAX_WEBGL_VERSION", Math.max(2, S.get("MAX_WEBGL_VERSION"))); }
  if (S.get("MAIN_READS_PARAMS") && !S.get("STANDALONE_WASM")) RE.push("_emscripten_stack_alloc");
  if (S.get("SUPPORT_LONGJMP") === "emscripten" || !S.get("DISABLE_EXCEPTION_CATCHING")) DLF.push("$stackSave", "$stackRestore");
  if (S.get("DYNAMIC_EXECUTION") === 2) DLF.push("$stackTrace");
  if (!S.get("STANDALONE_WASM") && (S.get("EXIT_RUNTIME") || S.get("ASSERTIONS"))) S.get("EXPORT_IF_DEFINED").push("fflush");
  if (!S.get("DECLARE_ASM_MODULE_EXPORTS")) DLF.push("$assignWasmExports");
  if (S.get("ALLOW_MEMORY_GROWTH")) S.setDefault("ABORTING_MALLOC", 0);
  if (S.get("PTHREADS")) unsupported("-pthread");
  S.get("JS_LIBRARIES").push(path.join(ctx.emRoot, "src/lib/libpthread_stub.js"));
  // feature_matrix.apply_min_browser_versions (only the branches reachable here)
  if (S.get("WASM_BIGINT") && has("WASM_BIGINT")) unsupported("explicit WASM_BIGINT");
  if (S.get("SHARED_MEMORY") || S.get("OFFSCREENCANVAS_SUPPORT") || S.get("SUPPORT_LONGJMP") === "wasm") unsupported("SHARED_MEMORY / OFFSCREENCANVAS_SUPPORT / SUPPORT_LONGJMP=wasm");
  S.set("SUPPORTS_PROMISE_ANY", caniuse(S, "PROMISE_ANY"));
  S.setDefault("WASM_BIGINT", caniuse(S, "JS_BIGINT_INTEGRATION"));
  if (S.get("INCOMING_MODULE_JS_API").includes("preRun")) DLF.push("$addOnPreRun");
  if (S.get("INCOMING_MODULE_JS_API").includes("postRun")) DLF.push("$addOnPostRun");
  if (S.get("FORCE_FILESYSTEM")) {
    S.get("EXPORTED_RUNTIME_METHODS").push("FS_createPath", "FS_createDataFile", "FS_preloadFile", "FS_unlink", "FS_createLazyFile", "FS_createDevice", "addRunDependency", "removeRunDependency");
  }
  setInitialMemory(S);
  if (!S.get("DECLARE_ASM_MODULE_EXPORTS") || ctx.linkerArgs.includes("-lexports.js")) S.set("MINIFY_WASM_EXPORT_NAMES", 0);
  if (willMetadce(S) && S.get("OPT_LEVEL") >= 2 && S.get("DEBUG_LEVEL") <= 2 && oformat !== "WASM" && S.get("ASYNCIFY") !== 2 && !S.get("LINKABLE") && !S.get("STANDALONE_WASM") && !S.get("AUTODEBUG") && !S.get("ASSERTIONS") && !S.get("RELOCATABLE") && S.get("MINIFY_WASM_EXPORT_NAMES")) {
    S.set("MINIFY_WASM_IMPORTS_AND_EXPORTS", 1);
    S.set("MINIFY_WASM_IMPORTED_MODULES", 1);
  }
  if (S.get("WASM_BIGINT")) S.set("LEGALIZE_JS_FFI", 0);
  if (opts.sanitize.size) unsupported("-fsanitize");
  if (!has("GLOBAL_BASE") && !S.get("SHRINK_LEVEL") && !S.get("OPT_LEVEL") && !S.get("USE_ASAN")) S.set("STACK_FIRST", true);
  if (ctx.linkerArgs.includes("--stack-first")) S.set("STACK_FIRST", true);
  setMaxMemory(S);
  if (!S.get("MEMORY64") && S.get("MAXIMUM_MEMORY") > 2 * 1024 * 1024 * 1024) S.set("CAN_ADDRESS_2GB", 1);
  if (S.get("MAX_WEBGL_VERSION") >= 2) {
    S.set("WEBGL_USE_GARBAGE_FREE_APIS", 1);
    if (S.get("MIN_FIREFOX_VERSION") !== UNSUPPORTED && S.get("MAXIMUM_MEMORY") > 2 ** 31) S.set("WEBGL_USE_GARBAGE_FREE_APIS", 0);
    if (S.get("WEBGL_USE_GARBAGE_FREE_APIS") && S.get("MIN_WEBGL_VERSION") >= 2) S.set("INCLUDE_WEBGL1_FALLBACK", 0);
  }
  DLF.push("$callRuntimeCallbacks");
  if (S.get("EXIT_RUNTIME") && !S.get("STANDALONE_WASM")) RE.push("__funcs_on_exit");
  if (!S.get("DISABLE_EXCEPTION_CATCHING")) RE.push("__cxa_can_catch", "__cxa_increment_exception_refcount", "__cxa_decrement_exception_refcount", "setThrew", "__cxa_free_exception");
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(S.get("EXPORT_NAME"))) throw new Error(`EXPORT_NAME is not a valid JS identifier: \`${S.get("EXPORT_NAME")}\``);
  S.set("EMSCRIPTEN_VERSION", ctx.emVersion);
  S.set("SOURCE_MAP_BASE", opts.sourceMapBase ?? "");
  S.set("LINK_AS_CXX", (ctx.runViaEmxx || !!S.get("DEFAULT_TO_CXX")) && !opts.nostdlibxx);
  if (!S.get("STANDALONE_WASM")) RE.push("__wasm_call_ctors");
  S.set("PRE_JS_FILES", opts.preJs);
  S.set("POST_JS_FILES", opts.postJs);
  S.set("MINIFY_WHITESPACE", S.get("OPT_LEVEL") >= 2 && S.get("DEBUG_LEVEL") === 0 && !opts.noMinify);
  if (S.get("USE_CLOSURE_COMPILER") || !S.get("MINIFY_WHITESPACE")) S.set("MAYBE_CLOSURE_COMPILER", 1);
  return { target, wasmTarget, oformat };
}

export const willMetadce = (S) => !S.get("ASSERTIONS") && (S.get("OPT_LEVEL") >= 3 || S.get("SHRINK_LEVEL") >= 1);

function setInitialMemory(S) {
  const userInitialHeap = "INITIAL_HEAP" in S.user;
  if (S.get("IMPORTED_MEMORY")) S.set("INITIAL_HEAP", -1);
  if (!userInitialHeap) {
    const ui = S.get("INITIAL_MEMORY") !== -1;
    const um = "MAXIMUM_MEMORY" in S.user || "WASM_MEM_MAX" in S.user || "BINARYEN_MEM_MAX" in S.user;
    if (ui || um) S.set("INITIAL_HEAP", -1);
  }
  if (S.get("INITIAL_HEAP") === -1 && S.get("INITIAL_MEMORY") === -1) S.setDefault("INITIAL_MEMORY", 16 * 1024 * 1024);
  const check = (k) => { if (S.get(k) % 65536 !== 0) throw new Error(`${k} must be a multiple of WebAssembly page size (64KiB), was ${S.get(k)}`); };
  if (S.get("INITIAL_HEAP") !== -1) check("INITIAL_HEAP");
  if (S.get("INITIAL_MEMORY") !== -1) { check("INITIAL_MEMORY"); if (S.get("INITIAL_MEMORY") < S.get("STACK_SIZE")) throw new Error("INITIAL_MEMORY must be larger than STACK_SIZE"); }
  check("MAXIMUM_MEMORY");
  if (S.get("MEMORY_GROWTH_LINEAR_STEP") !== -1) check("MEMORY_GROWTH_LINEAR_STEP");
}

function setMaxMemory(S) {
  const known = S.get("INITIAL_MEMORY") !== -1;
  if (!S.get("ALLOW_MEMORY_GROWTH") && known) S.set("MAXIMUM_MEMORY", S.get("INITIAL_MEMORY"));
  if (!("MAXIMUM_MEMORY" in S.user)) {
    if (S.get("ALLOW_MEMORY_GROWTH") && ((S.get("INITIAL_HEAP") !== -1 && S.get("INITIAL_HEAP") >= 2 ** 31) || (known && S.get("INITIAL_MEMORY") > 2 ** 31))) S.set("MAXIMUM_MEMORY", 2 ** 32);
    if (known && S.get("INITIAL_MEMORY") > S.get("MAXIMUM_MEMORY")) S.set("MAXIMUM_MEMORY", S.get("INITIAL_MEMORY"));
  }
  if (known && S.get("MAXIMUM_MEMORY") < S.get("INITIAL_MEMORY")) throw new Error("MAXIMUM_MEMORY cannot be less than INITIAL_MEMORY");
}

const JS_LIB_MAP = { GL: ["libwebgl.js", "libhtml5_webgl.js"], "webgl.js": ["libwebgl.js", "libhtml5_webgl.js"], GLESv2: ["libwebgl.js"], EGL: ["libegl.js"], dl: [], m: [], rt: [], pthread: [], "stdc++": [], GLU: [], openal: ["libopenal.js"], uuid: ["libuuid.js"], websocket: ["libwebsocket.js"] };

/** link.py process_libraries */
export function processLibraries(ctx) {
  const out = [];
  const sysLibs = systemLibraryNames(ctx);
  for (const flag of ctx.linkerArgs) {
    if (flag.startsWith("--js-library=")) { ctx.S.get("JS_LIBRARIES").push(path.resolve(flag.slice(13))); continue; }
    if (!flag.startsWith("-l")) { out.push(flag); continue; }
    const lib = flag.slice(2);
    const jsLibs = JS_LIB_MAP[lib];
    if (jsLibs) for (const l of jsLibs) ctx.S.get("JS_LIBRARIES").push(path.join(ctx.emRoot, "src/lib", l));
    if (sysLibs["lib" + lib]) { out.push("-l" + sysLibs["lib" + lib].slice(3)); continue; }
    if (jsLibs) continue;
    if (lib.endsWith(".js")) {
      const p = ctx.libDirs.map((d) => path.join(d, "lib" + lib)).find((p) => fs.existsSync(p));
      if (!p) throw new Error(`unable to find library ${flag}`);
      ctx.S.get("JS_LIBRARIES").push(path.resolve(p));
      continue;
    }
    out.push(flag);
  }
  ctx.linkerArgs = out;
}

/** system_libs.py: the variation each system library resolves to under these settings. */
function systemLibraryNames(ctx) {
  const S = ctx.S;
  const mt = S.get("PTHREADS") ? "-mt" : "";
  const dbg = S.get("ASSERTIONS") ? "-debug" : "";
  const exc = S.get("WASM_EXCEPTIONS") ? "-wasmexcept" : !S.get("DISABLE_EXCEPTION_CATCHING") ? "" : "-noexcept";
  let gl = "libGL" + mt;
  if (S.get("MAX_WEBGL_VERSION") >= 2) gl += "-webgl2";
  if (S.get("FULL_ES3")) gl += "-full_es3";
  if (S.get("GL_ENABLE_GET_PROC_ADDRESS")) gl += "-getprocaddr";
  return {
    libGL: gl, libal: "libal", libhtml5: "libhtml5", libstubs: "libstubs" + dbg, libnoexit: "libnoexit", libc: "libc" + mt + dbg,
    libmalloc: "libdlmalloc" + mt + dbg, libcompiler_rt: "libcompiler_rt" + mt, "libc++": "libc++" + mt + (exc === "-noexcept" ? "-noexcept" : exc),
    "libc++abi": "libc++abi" + mt + (exc === "-noexcept" ? "-noexcept" : exc), libsockets: "libsockets" + mt,
  };
}

/** system_libs.calculate + ports.get_libs (romdev subset). */
export function calculateSystemLibraries(ctx, opts) {
  const S = ctx.S;
  const out = [];
  for (const port of ctx.ports) out.push(port.lib);
  if (opts.nostdlib) return out;
  const n = systemLibraryNames(ctx);
  const add = (k) => { const f = path.join(ctx.sysrootLib, n[k] + ".a"); if (!fs.existsSync(f)) throw new Error(`system library ${n[k]}.a missing from ${ctx.sysrootLib}`); out.push("-l" + n[k].slice(3)); };
  if (S.get("STANDALONE_WASM")) unsupported("STANDALONE_WASM crt1 selection");
  if (opts.nodefaultlibs) return out;
  if (S.get("AUTO_NATIVE_LIBRARIES")) { add("libGL"); add("libal"); add("libhtml5"); }
  if (S.get("JS_MATH") || S.get("PRINTF_LONG_DOUBLE") || S.get("SHRINK_LEVEL") >= 2) unsupported("JS_MATH / PRINTF_LONG_DOUBLE / -Oz libc_optz");
  if (S.get("ALLOW_UNIMPLEMENTED_SYSCALLS")) add("libstubs");
  if (!opts.nolibc) {
    if (!S.get("EXIT_RUNTIME")) add("libnoexit");
    add("libc");
    if (S.get("MALLOC") === "dlmalloc") add("libmalloc");
    else if (S.get("MALLOC") !== "none") unsupported(`MALLOC=${S.get("MALLOC")}`);
  }
  add("libcompiler_rt");
  if (S.get("LINK_AS_CXX")) { add("libc++"); add("libc++abi"); }
  add("libsockets");
  return out;
}

/** compile_javascript: run emscripten's own tools/compiler.mjs. */
export function compileJavascript(ctx, symbolsOnly) {
  const json = ctx.S.externalJSON();
  ctx.intermediate?.("settings.json", json);
  const args = [path.join(ctx.emRoot, "tools/compiler.mjs"), "-"];
  if (symbolsOnly) args.push("--symbols-only");
  const out = execFileSync(process.execPath, args, { input: json, maxBuffer: 1 << 30, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
  if (symbolsOnly) return [null, out];
  if (!out.includes("//FORWARDED_DATA:")) throw new Error("JS compiler did not return forwarded data");
  const i = out.lastIndexOf("//FORWARDED_DATA:");
  return [out.slice(0, i), out.slice(i + 17)];
}

function llvmBackendArgs(S) {
  const a = ["-combiner-global-alias-analysis=false"];
  if (!S.get("DISABLE_EXCEPTION_CATCHING")) a.push("-enable-emscripten-cxx-exceptions");
  if (S.get("EXCEPTION_CATCHING_ALLOWED").length) unsupported("EXCEPTION_CATCHING_ALLOWED");
  if (S.get("SUPPORT_LONGJMP") === "emscripten") a.push("-enable-emscripten-sjlj");
  else if (S.get("SUPPORT_LONGJMP") === "wasm") a.push("-wasm-enable-sjlj");
  a.push("-disable-lsr");
  return a;
}
export { llvmBackendArgs };

function lldFlagsForExecutable(ctx, externalSymbols) {
  const S = ctx.S;
  const cmd = [];
  if (Object.keys(externalSymbols).length) {
    if (S.get("INCLUDE_FULL_LIBRARY")) unsupported("INCLUDE_FULL_LIBRARY");
    const stub = path.join(ctx.tmp, "libemscripten_js_symbols.so");
    const lines = ["#STUB"];
    for (const [name, deps] of Object.entries(externalSymbols)) if (!name.startsWith("$")) lines.push(`${name}: ${deps.join(",")}`);
    fs.writeFileSync(stub, lines.join("\n"));
    cmd.push(stub);
  }
  if (!S.get("ERROR_ON_UNDEFINED_SYMBOLS")) cmd.push("--import-undefined");
  if (S.get("IMPORTED_MEMORY")) cmd.push("--import-memory");
  if (S.get("SHARED_MEMORY")) cmd.push("--shared-memory");
  if (!S.get("GENERATE_DWARF") && !S.get("EMIT_SYMBOL_MAP") && !S.get("GENERATE_SOURCE_MAP") && !S.get("EMIT_NAME_SECTION") && !S.get("ASYNCIFY") && !ctx.keepNames) cmd.push("--strip-debug");
  if (S.get("LTO") && !S.get("EXIT_RUNTIME")) cmd.push("-u__cxa_atexit");
  let cExports = S.get("EXPORTED_FUNCTIONS").filter(isCSymbol).map(demangleC).filter((e) => !(e in externalSymbols));
  cExports = cExports.concat(S.get("REQUIRED_EXPORTS"));
  for (const e of cExports) cmd.push(S.get("ERROR_ON_UNDEFINED_SYMBOLS") ? `--export=${e}` : `--export-if-defined=${e}`);
  for (const e of S.get("EXPORT_IF_DEFINED")) cmd.push(`--export-if-defined=${e}`);
  cmd.push("--export-table");
  if (S.get("ALLOW_TABLE_GROWTH")) cmd.push("--growable-table");
  cmd.push("-z", `stack-size=${S.get("STACK_SIZE")}`);
  if (S.get("ALLOW_MEMORY_GROWTH")) cmd.push(`--max-memory=${S.get("MAXIMUM_MEMORY")}`);
  else cmd.push("--no-growable-memory");
  if (S.get("INITIAL_HEAP") !== -1) cmd.push(`--initial-heap=${S.get("INITIAL_HEAP")}`);
  if (S.get("INITIAL_MEMORY") !== -1) cmd.push(`--initial-memory=${S.get("INITIAL_MEMORY")}`);
  if (S.get("STANDALONE_WASM")) { if (!S.get("EXPECT_MAIN")) cmd.push("--entry=_initialize"); }
  else cmd.push("--no-entry");
  if (S.get("STACK_FIRST")) cmd.push("--stack-first");
  // LLVM 22.1's wasm-ld made --stack-first the default; emsdk 4.0.18's LLVM
  // snapshot predates that, and emcc relies on the old default (data first).
  else cmd.push("--no-stack-first");
  cmd.push(`--table-base=${S.get("TABLE_BASE")}`);
  if (!S.get("STACK_FIRST")) cmd.push(`--global-base=${S.get("GLOBAL_BASE")}`);
  return cmd;
}

async function linkLld(ctx, args, target, externalSymbols) {
  const S = ctx.S;
  args = args.filter((a) => a !== "--start-group" && a !== "--end-group");
  if (args.includes("--strip-all") || args.includes("-s")) args.push("--keep-section=target_features");
  let cmd = ["wasm-ld", "-o", path.resolve(target), ...args];
  for (const a of llvmBackendArgs(S)) cmd.push("-mllvm", a);
  if (!args.includes("--relocatable") && !args.includes("-r")) cmd = cmd.concat(lldFlagsForExecutable(ctx, externalSymbols));
  ctx.log?.(cmd);
  const code = await runLLVMTool(cmd);
  if (code !== 0) throw new Error(`wasm-ld failed (exit ${code})`);
}

async function objcopyStrip(infile, outfile, opts) {
  fs.writeFileSync(outfile, stripSections(fs.readFileSync(infile), opts));
}

// ---- emscripten.py --------------------------------------------------------

function updateSettingsGlue(S, md) {
  // maybe_disable_filesystem
  if (!(S.get("FORCE_FILESYSTEM") || S.get("INCLUDE_FULL_LIBRARY"))) {
    if (S.get("FILESYSTEM") === 0) S.set("SYSCALLS_REQUIRE_FILESYSTEM", 0);
    else {
      const sys = md.imports.filter((d) => d.startsWith("__syscall_") || d.startsWith("fd_") || d === "path_open");
      const ok = new Set(["__syscall_ioctl", "fd_seek", "fd_write", "fd_close", "fd_fdstat_get"]);
      if (sys.every((s) => ok.has(s))) S.set("SYSCALLS_REQUIRE_FILESYSTEM", 0);
    }
  }
  const all = new Set(md.allExports);
  S.set("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE", [...new Set([...S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE"), ...md.imports])].filter((s) => !all.has(s)).sort());
  S.set("WASM_EXPORTS", md.allExports);
  S.set("DATA_EXPORTS", Object.keys(md.dataExports));
  S.set("HAVE_EM_ASM", md.emAsmConsts.size !== 0);
  S.set("BINARYEN_FEATURES", ["--mvp-features", ...md.features]);
  S.set("HAS_MAIN", !!(S.get("PROXY_TO_PTHREAD") || S.get("STANDALONE_WASM") || all.has("main") || all.has("__main_argc_argv")));
  if (S.get("HAS_MAIN")) S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE").push("$exitJS", "$handleException");
  S.set("MAIN_READS_PARAMS", !!md.mainReadsParams);
  if (S.get("MAIN_READS_PARAMS") && !S.get("STANDALONE_WASM")) S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE").push("$stringToUTF8OnStack");
  for (const d of md.jsDeps) S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE").push(...d.split(","));
}

function parenthesesMatch(body, openIdx, closeIdx) {
  if (closeIdx < 0) closeIdx += body.length;
  let count = 1;
  for (let i = openIdx + 1; i <= closeIdx; i++) {
    if (body[i] === body[openIdx]) count++;
    else if (body[i] === body[closeIdx]) { count--; if (count <= 0) return i === closeIdx; }
  }
  return false;
}
function trimAsmConstBody(body) {
  body = body.trim();
  let orig = null;
  while (orig !== body) {
    orig = body;
    if (body.length > 1 && body[0] === '"' && body.at(-1) === '"') body = body.slice(1, -1).replaceAll('\\"', '"').trim();
    if (body.length > 1 && body[0] === "{" && body.at(-1) === "}" && parenthesesMatch(body, 0, -1)) body = body.slice(1, -1).trim();
    if (body.length > 1 && body[0] === "(" && body.at(-1) === ")" && parenthesesMatch(body, 0, -1)) body = body.slice(1, -1).trim();
  }
  return body;
}
function createAsmConsts(md) {
  const out = [];
  for (const [addr, c] of md.emAsmConsts) {
    const body = trimAsmConstBody(c);
    let arity = 0;
    for (let i = 0; i < 16; i++) if (c.includes(`$${i}`)) arity = i + 1;
    const args = Array.from({ length: arity }, (_, i) => `$${i}`).join(", ");
    out.push([addr, body.includes("arguments") ? `function(${args}) { ${body} }` : `(${args}) => { ${body} }`]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function createEmJs(md) {
  const out = [];
  for (const [name, raw] of Object.entries(md.emJsFuncs)) {
    const sepAt = raw.indexOf("<::>");
    let args = raw.slice(0, sepAt).slice(1, -1); const body = raw.slice(sepAt + 4);
    args = args === "void" ? [] : args.split(",");
    const names = args.filter(Boolean).map((a) => a.trim().split(/\s+/).at(-1).replaceAll("*", ""));
    out.push(`function ${name}(${names.join(",")}) ${body}`);
  }
  return out;
}

function makeInvoke(S, sig) {
  const args = ["index", ...Array.from({ length: sig.length - 1 }, (_, i) => "a" + (i + 1))];
  const ret = sig[0] !== "v" ? "return " : "";
  const exceptional = sig[0] === "j" ? "\n    return 0n;" : "";
  const body = S.get("DYNCALLS") ? `${ret}dynCall_${sig}(${args.join(",")});` : `${ret}getWasmTableEntry(${args[0]})(${args.slice(1).join(",")});`;
  return `function invoke_${sig}(${args.join(",")}) {\n  var sp = stackSave();\n  try {\n    ${body}\n  } catch(e) {\n    stackRestore(sp);\n    if (e !== e+0) throw e;\n    _setThrew(1, 0);${exceptional}\n  }\n}`;
}

const shouldExport = (S, sym) => S.get("EXPORT_ALL") || (S.get("EXPORT_KEEPALIVE") && S.get("EXPORTED_FUNCTIONS").includes(sym));

function createModule(S, md, librarySymbols, aliases) {
  const module = [];
  // create_receiving
  const recv = ["\n// Imports from the Wasm binary."];
  const exports = {};
  for (const [n, sig] of Object.entries(md.functionExports)) if (n !== "__wasm_call_ctors") exports[n] = sig;
  for (const n of md.otherExports) exports[n] = null;
  const mangled = [...Object.keys(exports).map(asmjsMangle), ...Object.keys(aliases)];
  if (S.get("ASSERTIONS")) unsupported("ASSERTIONS glue");
  recv.push(`var ${mangled.join(",\n  ")};\n`);
  const aliasInverse = {};
  for (const [sym, alias] of Object.entries(aliases)) { if (!(alias in exports)) throw new Error(`expected alias target (${alias}) to be exported`); (aliasInverse[alias] ??= []).push(sym); }
  const doModuleExports = true;
  const genDyncall = librarySymbols.includes("dynCalls");
  recv.push("\nfunction assignWasmExports(wasmExports) {");
  for (const [sym, sig] of Object.entries(exports)) {
    const isFn = sig !== null;
    const m = asmjsMangle(sym);
    let assignment = m;
    if (genDyncall && isFn && sym.startsWith("dynCall_")) assignment += ` = dynCalls['${sym.slice(8)}']`;
    if (doModuleExports && shouldExport(S, m)) assignment += ` = Module['${m}']`;
    for (const t of aliasInverse[sym] ?? []) {
      assignment += ` = ${t}`;
      if (doModuleExports && S.get("EXPORTED_RUNTIME_METHODS").includes(t)) assignment += ` = Module['${t}']`;
    }
    recv.push(`  ${assignment} = wasmExports['${sym}'];`);
  }
  recv.push("}");
  module.push(recv.join("\n"));
  // create_data_exports
  const dl = [];
  for (const [k, v0] of Object.entries(md.dataExports)) {
    if (isInternalGlobal(k)) continue;
    const v = Number(BigInt(v0) & 0xffffffffn);
    const m = asmjsMangle(k);
    dl.push(shouldExport(S, m) ? `var ${m} = Module['${m}'] = ${v};` : `var ${m} = ${v};`);
  }
  module.push(dl.join("\n"));
  // create_sending
  const send = {};
  for (const n of md.invokeFuncs) send[n] = n;
  for (const n of md.imports) send[n] = n in md.emJsFuncs ? n : asmjsMangle(n);
  if (S.get("IMPORTED_MEMORY")) send.memory = "wasmMemory";
  const prefix = S.get("MAYBE_CLOSURE_COMPILER") ? "/** @export */\n  " : "";
  const elems = Object.keys(send).sort().map((k) => (k === send[k] ? `${prefix}${k}` : `${prefix}${k}: ${send[k]}`));
  module.push(`var wasmImports = {\n  ${elems.join(",\n  ")}\n};`);
  if (S.get("SUPPORT_LONGJMP") === "emscripten" || !S.get("DISABLE_EXCEPTION_CATCHING")) for (const inv of md.invokeFuncs) module.push(makeInvoke(S, inv.slice(7)));
  else if (md.invokeFuncs.length) throw new Error("invoke_ functions exported but exceptions and longjmp are both disabled");
  if (S.get("MEMORY64") || S.get("CAN_ADDRESS_2GB")) module.push(createPointerConversionWrappers(md));
  return module.filter(Boolean).join("\n\n") + "\n";
}

// emscripten.py create_pointer_conversion_wrappers, non-MEMORY64 case: only
// the 'p'-returning entries of its table matter (unsigned pointer returns).
const PTR_SIGS = { sbrk: "pP", _emscripten_stack_alloc: "pp", emscripten_builtin_malloc: "pp", emscripten_builtin_calloc: "ppp", malloc: "pp", realloc: "ppp", calloc: "ppp", memalign: "ppp", memcpy: "pppp", __getTypeName: "pp", emscripten_stack_get_end: "p", emscripten_stack_get_base: "p", pthread_self: "p", emscripten_stack_get_current: "p", __errno_location: "p", emscripten_builtin_memalign: "ppp", __cxa_get_exception_ptr: "pp", _wasmfs_get_cwd: "p_", _wasmfs_mmap: "pp____", emscripten_main_runtime_thread_id: "p", strerror: "p_", stbi_load: "ppppp_", stbi_load_from_memory: "pp_ppp_", _emscripten_find_dylib: "ppppp" };
function makeUnsignPointerWrapper(sig) {
  const n = sig.length - 1;
  const args = Array.from({ length: n }, (_, i) => `a${i}`).join(", ");
  return `\n  var makeWrapper_${sig} = (f) => (${args}) => f(${args}) >>> 0;`;
}
function createPointerConversionWrappers(md) {
  let w = "\n// Argument name here must shadow the `wasmExports` global so\n// that it is recognised by metadce and minify-import-export-names\n// passes.\nfunction applySignatureConversions(wasmExports) {\n  // First, make a copy of the incoming exports object\n  wasmExports = Object.assign({}, wasmExports);\n";
  const seen = new Set(); const wrap = [];
  for (const sym of Object.keys(md.functionExports)) {
    const sig = PTR_SIGS[sym];
    if (sig && sig[0] === "p") { if (!seen.has(sig)) { w += makeUnsignPointerWrapper(sig); seen.add(sig); } wrap.push(sym); }
  }
  for (const f of wrap) w += `\n  wasmExports['${f}'] = makeWrapper_${PTR_SIGS[f]}(wasmExports['${f}']);`;
  return w + "\n  return wasmExports;\n}";
}

function applyStaticCodeHooks(S, fwd, code) {
  const inject = (name) => {
    let hook = fwd[name];
    hook = hook ? `// Begin ${name} hooks\n  ${hook}\n  // End ${name} hooks` : `// No ${name} hooks`;
    code = code.replaceAll(`<<< ${name} >>>`, hook);
  };
  inject("ATMODULES"); inject("ATPRERUNS"); inject("ATINITS"); inject("ATPOSTCTORS");
  if (S.get("HAS_MAIN")) inject("ATMAINS");
  inject("ATPOSTRUNS");
  if (S.get("EXIT_RUNTIME")) inject("ATEXITS");
  return code;
}

/** emscripten.py emscript() + finalize_wasm (no wasm-emscripten-finalize needed with WASM_BIGINT). */
async function emscript(ctx, inWasm, outWasm, outJs, jsSyms) {
  const S = ctx.S;
  S.set("WASM_BINARY_FILE", path.basename(outWasm).replaceAll("\\", "/").replaceAll("'", "\\'").replaceAll('"', '\\"'));
  // finalize_wasm
  if (!S.get("WASM_BIGINT") || S.get("DYNCALLS") || S.get("LEGALIZE_JS_FFI") || S.get("STACK_OVERFLOW_CHECK") >= 2 || S.get("GENERATE_SOURCE_MAP") || S.get("DEBUG_LEVEL") >= 2 || S.get("EMIT_NAME_SECTION") || S.get("EMIT_SYMBOL_MAP"))
    unsupported("a link that needs wasm-emscripten-finalize / name section (DYNCALLS, no BIGINT, -g2+, source maps)");
  ctx.intermediate?.("base.wasm", fs.readFileSync(inWasm));
  const strip = [];
  if (!S.get("EMIT_PRODUCERS_SECTION")) strip.push("producers");
  if (!process.env.ROMDEV_EMCC_KEEP_NAMES) strip.push("name");
  await objcopyStrip(inWasm, outWasm, { debug: !S.get("GENERATE_DWARF"), sections: strip });
  const md = extractMetadata(fs.readFileSync(outWasm), { standaloneWasm: !!S.get("STANDALONE_WASM") });
  // expected vs unexpected (EMSCRIPTEN_KEEPALIVE) exports
  const expected = new Set(S.get("EXPORTED_FUNCTIONS"));
  for (const s of [...S.get("REQUIRED_EXPORTS"), ...S.get("EXPORT_IF_DEFINED")]) expected.add(asmjsMangle(s));
  for (const deps of Object.values(jsSyms)) for (const s of deps) expected.add(asmjsMangle(s));
  let unexpected = md.allExports.filter(isUserExport).map(asmjsMangle).filter((e) => !expected.has(e));
  if (!S.get("STANDALONE_WASM") && md.allExports.includes("main") || md.allExports.includes("__main_argc_argv")) {
    if ("EXPORTED_FUNCTIONS" in S.user && !S.get("USER_EXPORTS").includes("_main")) {
      md.allExports = md.allExports.filter((e) => e !== "main" && e !== "__main_argc_argv");
    } else unexpected.push("_main");
  }
  for (const e of unexpected) ctx.userRequestedExports.add(e);
  S.get("EXPORTED_FUNCTIONS").push(...unexpected);

  updateSettingsGlue(S, md);
  const asmConsts = createAsmConsts(md);
  const emJs = createEmJs(md);
  for (const e of S.get("EXPORTED_FUNCTIONS")) if (!/^[A-Za-z_$][\w$]*$/.test(e)) throw new Error(`invalid export name: "${e}"`);
  if (md.invokeFuncs.length) S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE").push("$getWasmTableEntry");
  const [glue, fwdData] = compileJavascript(ctx, false);
  const fwd = JSON.parse(fwdData);
  let [pre, post] = glue.split("// EMSCRIPTEN_END_FUNCS");
  // report_missing_exports
  const defined = new Set([...S.get("WASM_EXPORTS").map(asmjsMangle), ...fwd.librarySymbols]);
  for (const sym of [...S.get("USER_EXPORTS")].filter((s) => !defined.has(s)).sort()) process.stderr.write(`emcc: warning: undefined exported symbol: "${sym}" [-Wundefined]\n`);
  if (S.get("EXPECT_MAIN") && !S.get("STANDALONE_WASM") && !S.get("IGNORE_MISSING_MAIN") && !S.get("WASM_EXPORTS").includes("main") && !S.get("WASM_EXPORTS").includes("__main_argc_argv")) throw new Error("entry symbol not defined (pass --no-entry to suppress): main");
  if (asmConsts.length) pre += "var ASM_CONSTS = {\n  " + asmConsts.map(([k, v]) => `${k}: ${v}`).join(",  \n ") + "\n};\n";
  if (emJs.length) pre += emJs.join("\n") + "\n";
  const parts = [pre, createModule(S, md, fwd.librarySymbols, fwd.nativeAliases), post];
  S.set("ALIASES", Object.keys(fwd.nativeAliases));
  fs.writeFileSync(outJs, applyStaticCodeHooks(S, fwd, parts.join("")));
  return md;
}

// ---- building.py: binaryen + acorn passes ----------------------------------

function optLevelToStr(o, s) { if (o === 0) return "-O0"; if (s === 1) return "-Os"; if (s >= 2) return "-Oz"; return `-O${Math.min(o, 3)}`; }

function binaryenPasses(S, opts) {
  const p = [];
  const optimizing = S.get("OPT_LEVEL") >= 2;
  if (optimizing) p.push("--strip-target-features");
  if (!caniuse(S, "SIGN_EXT")) p.push("--signext-lowering");
  if (!caniuse(S, "NON_TRAPPING_FPTOINT")) p.push("--llvm-nontrapping-fptoint-lowering");
  if (!caniuse(S, "BULK_MEMORY")) p.push("--llvm-memory-copy-fill-lowering");
  if (optimizing) p.push("--post-emscripten");
  if (optimizing) p.push(optLevelToStr(S.get("OPT_LEVEL"), S.get("SHRINK_LEVEL")));
  if (opts.fastMath) p.push("--fast-math");
  if (optimizing && S.get("GLOBAL_BASE") >= 1024 && !S.get("STACK_FIRST")) p.push("--low-memory-unused");
  if (S.get("EMULATE_FUNCTION_POINTER_CASTS")) p.push("--fpcast-emu");
  if (S.get("BINARYEN_IGNORE_IMPLICIT_TRAPS")) p.push("--ignore-implicit-traps");
  if (optimizing) p.push("--zero-filled-memory");
  if (optimizing) p.push("--pass-arg=directize-initial-contents-immutable");
  if (S.get("BINARYEN_EXTRA_PASSES")) for (const x of S.get("BINARYEN_EXTRA_PASSES").split(",").filter(Boolean)) p.push(x[0] !== "-" ? "--" + x : x);
  if (willMetadce(S)) p.push("--no-stack-ir");
  return p;
}

function runBinaryen(ctx, tool, infile, outfile, args, { capture = false } = {}) {
  const S = ctx.S;
  const cmd = [path.join(ctx.binaryenBin, tool), ...args, ...(process.env.ROMDEV_EMCC_KEEP_NAMES ? ["-g"] : []), infile];
  if (outfile) cmd.push("-o", outfile);
  cmd.push(...(S.get("BINARYEN_FEATURES").length ? S.get("BINARYEN_FEATURES") : ["--detect-features"]));
  ctx.log?.(cmd);
  const out = execFileSync(process.execPath, cmd, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"] });
  if (outfile) ctx.intermediate?.(`${tool}.wasm`, fs.readFileSync(outfile));
  return out;
}

let acornCounter = 0;
function acorn(ctx, file, passes, { extraInfo, returnOutput = false } = {}) {
  const S = ctx.S;
  const orig = file;
  if (extraInfo !== undefined) {
    const tmp = path.join(ctx.tmp, `emcc_acorn_info_${acornCounter}.js`);
    fs.copyFileSync(file, tmp);
    fs.appendFileSync(tmp, "// EXTRA_INFO: " + JSON.stringify(extraInfo));
    file = tmp;
  }
  const cmd = [path.join(ctx.emRoot, "tools/acorn-optimizer.mjs"), file, ...passes];
  if (S.get("MAYBE_CLOSURE_COMPILER")) cmd.push("--closure-friendly");
  if (S.get("EXPORT_ES6")) cmd.push("--export-es6");
  if (returnOutput) return execFileSync(process.execPath, cmd, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] });
  acornCounter++;
  let base = unsuffixed(orig);
  if (base.includes(".jso")) base = unsuffixed(base);
  const out = `${base}.jso${acornCounter}.js`;
  cmd.push("-o", out);
  ctx.log?.(["node", ...cmd]);
  execFileSync(process.execPath, cmd, { stdio: ["ignore", "inherit", "inherit"] });
  ctx.intermediate?.(`${passes[0]}.js`, fs.readFileSync(out));
  return out;
}

const lastBinaryenOpts = (S) => [`--optimize-level=${S.get("OPT_LEVEL")}`, `--shrink-level=${S.get("SHRINK_LEVEL")}`, "--optimize-stack-ir"];

function metadce(ctx, jsFile, wasmFile, last) {
  const S = ctx.S;
  const dataExports = new Set(S.get("DATA_EXPORTS"));
  const exports = [...new Set(S.get("WASM_EXPORTS"))].filter((x) => !dataExports.has(x)).sort();
  const txt = acorn(ctx, jsFile, ["emitDCEGraph", "--no-print"], { returnOutput: true, extraInfo: { exports: exports.map((x) => [asmjsMangle(x), x]) } });
  const graph = JSON.parse(txt);
  const required = ctx.userRequestedExports;
  for (const item of graph) if ("export" in item && (S.get("EXPORT_ALL") || required.has(asmjsMangle(item.export)))) item.root = true;
  const WASI = new Set(["environ_get", "environ_sizes_get", "args_get", "args_sizes_get", "fd_write", "fd_close", "fd_read", "fd_seek", "fd_fdstat_get", "fd_sync", "fd_pread", "fd_pwrite", "proc_exit", "clock_res_get", "clock_time_get", "path_open", "random_get"]);
  for (const item of graph) if ("import" in item && WASI.has(item.import[1])) item.import[0] = S.get("WASI_MODULE_NAME");
  const importMap = {}, exportMap = {};
  for (const item of graph) { if ("import" in item) importMap[item.name] = item.import[1]; else if ("export" in item) exportMap[item.name] = item.export; }
  const tmp = path.join(ctx.tmp, "emcc_dce_graph.json");
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2));
  const args = ["--graph-file=" + tmp, ...(last ? lastBinaryenOpts(S) : [])];
  const out = runBinaryen(ctx, "wasm-metadce", wasmFile, wasmFile, args, { capture: true });
  const unusedImports = [], unusedExports = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith("unused: ")) continue;
    const name = line.slice(8).trim();
    if (name.startsWith("emcc$import$")) unusedImports.push(importMap[name]);
    else if (name.startsWith("emcc$export$") && S.get("DECLARE_ASM_MODULE_EXPORTS")) { const n = exportMap[name]; if (isUserExport(n)) unusedExports.push(n); }
  }
  if (!unusedImports.length && !unusedExports.length) return jsFile;
  const passes = ["applyDCEGraphRemovals"];
  if (S.get("MINIFY_WHITESPACE")) passes.push("--minify-whitespace");
  return acorn(ctx, jsFile, passes, { extraInfo: { unusedImports, unusedExports } });
}

function minifyImportsExports(ctx, jsFile, wasmFile, minifyExports) {
  const S = ctx.S;
  const args = [minifyExports ? (S.get("MINIFY_WASM_IMPORTED_MODULES") ? "--minify-imports-and-exports-and-modules" : "--minify-imports-and-exports") : "--minify-imports", ...lastBinaryenOpts(S)];
  const out = runBinaryen(ctx, "wasm-opt", wasmFile, wasmFile, args, { capture: true });
  const mapping = {};
  for (const line of out.split("\n")) if (line.includes(" => ")) { const [o, n] = line.trim().split(" => "); if (o in mapping) throw new Error("imports must be unique"); mapping[o] = n; }
  const passes = ["applyImportAndExportNameChanges"];
  if (S.get("MINIFY_WHITESPACE")) passes.push("--minify-whitespace");
  return acorn(ctx, jsFile, passes, { extraInfo: { mapping } });
}

function minifyWasmJs(ctx, jsFile, wasmFile, expensive) {
  const S = ctx.S;
  const passes = [expensive ? "AJSDCE" : "JSDCE"];
  const minify = S.get("MINIFY_WHITESPACE") && !S.get("MAYBE_CLOSURE_COMPILER");
  if (minify) passes.push("--minify-whitespace");
  jsFile = acorn(ctx, jsFile, passes);
  if (expensive) {
    jsFile = metadce(ctx, jsFile, wasmFile, !S.get("MINIFY_WASM_IMPORTS_AND_EXPORTS"));
    const p2 = ["AJSDCE"];
    if (minify) p2.push("--minify-whitespace");
    jsFile = acorn(ctx, jsFile, p2);
    if (S.get("MINIFY_WASM_IMPORTS_AND_EXPORTS")) jsFile = minifyImportsExports(ctx, jsFile, wasmFile, S.get("MINIFY_WASM_EXPORT_NAMES"));
  }
  return jsFile;
}

function preprocess(ctx, file, expandMacros) {
  const json = ctx.S.externalJSON();
  const args = [path.join(ctx.emRoot, "tools/preprocessor.mjs"), "-", path.basename(file)];
  if (expandMacros) args.push("--expand-macros");
  return execFileSync(process.execPath, args, { input: json, cwd: path.dirname(file), encoding: "utf8", maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "inherit"] });
}

/**
 * romdev extension (not in emcc): cothreads that switch inside the module.
 * A module that imports binaryen's Asyncify intrinsics from module "asyncify"
 * (start_unwind / stop_unwind / start_rewind / stop_rewind; romdev's libco
 * backend, scripts/patches/libco-wasm/libco-wasm.c, is the user) gets the Asyncify
 * pass right after wasm-ld, before emscripten sees the module: the pass turns
 * those imports into the functions it adds, so the JS glue never has them.
 * Imports never unwind (asyncify-ignore-imports); the trampoline that unwinds
 * stop at and rewinds start from, romdev_co_trampoline, is left alone. This is
 * emscripten's ASYNCIFY=1 transform without its JS runtime, which romdev does
 * not use (ASYNCIFY itself stays refused above).
 *
 * By default every function that can reach a switch (indirect calls count)
 * is instrumented. A module whose cothreads are a small part of it (snes9x
 * with bsnes's ARM, build-snes9x.sh) names the functions that can be on a
 * cothread's stack in ROMDEV_ASYNCIFY_ONLY (comma-separated, * wildcards):
 * only those are instrumented (asyncify-onlylist), and the rest of the
 * module is untouched. The list must name libco's co_switch AND its leaf
 * co_suspend (the function that calls start_unwind): a function left out is
 * taken to never switch, so a switch through it would not unwind. ROMDEV_EMCC_KEEP_NAMES=1 keeps the function names in
 * the output (debugging a switch).
 */
function asyncifyListArgs() {
  const only = process.env.ROMDEV_ASYNCIFY_ONLY;
  if (only) return [`--pass-arg=asyncify-onlylist@${only}`];
  return ["--pass-arg=asyncify-removelist@romdev_co_trampoline"];
}

function importsAsyncify(wasmFile) {
  const bytes = fs.readFileSync(wasmFile);
  const r = { p: 8 };
  const uleb = () => { let v = 0, s = 0, b; do { b = bytes[r.p++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; };
  const str = () => { const n = uleb(); const t = bytes.subarray(r.p, r.p + n).toString("utf8"); r.p += n; return t; };
  let wanted = false;
  while (r.p < bytes.length && !wanted) {
    const id = bytes[r.p++], size = uleb(), end = r.p + size;
    if (id === 2) {
      for (let n = uleb(); n-- && !wanted;) {
        const mod = str(); str(); const kind = bytes[r.p++];
        if (kind === 0) uleb(); else if (kind === 1) { r.p++; const f = bytes[r.p++]; uleb(); if (f & 1) uleb(); } else if (kind === 2) { const f = bytes[r.p++]; uleb(); if (f & 1) uleb(); } else if (kind === 3) r.p += 2; else if (kind === 4) { r.p++; uleb(); }
        if (mod === "asyncify") wanted = true;
      }
    }
    r.p = end;
  }
  return wanted;
}

/** The whole link: setup -> wasm-ld -> emscript -> binaryen -> final emitting. */
export async function link(ctx) {
  const { S, opts } = ctx;
  if (!ctx.linkerArgs.length) throw new Error("no input files");
  const { target, wasmTarget, oformat } = linkerSetup(ctx);
  processLibraries(ctx);
  // phase_calculate_linker_inputs: filter_link_flags for lld keeps everything
  const sys = calculateSystemLibraries(ctx, opts);
  for (const s of sys) { if (s.startsWith("-l") && ctx.linkerArgs.includes(s)) continue; ctx.linkerArgs.push(s); }

  // JS library symbols, so wasm-ld can leave them as imports
  const [, symOut] = compileJavascript(ctx, true);
  const jsInfo = JSON.parse(symOut);
  const jsSyms = jsInfo.deps;
  const addDeps = (sym) => { const d = jsSyms[sym]; if (d && d.length) S.get("REQUIRED_EXPORTS").push(...d); };
  for (const s of S.get("DEFAULT_LIBRARY_FUNCS_TO_INCLUDE")) addDeps(s);
  for (const s of jsInfo.extraLibraryFuncs) addDeps(s);
  for (const s of S.get("EXPORTED_RUNTIME_METHODS")) addDeps(demangleC(s));
  for (const s of S.get("EXPORTED_FUNCTIONS")) addDeps(demangleC(s));

  S.set("EXPORTED_FUNCTIONS", dedup(S.get("EXPORTED_FUNCTIONS")));
  S.set("REQUIRED_EXPORTS", dedup(S.get("REQUIRED_EXPORTS")));
  S.set("EXPORT_IF_DEFINED", dedup(S.get("EXPORT_IF_DEFINED")));
  await linkLld(ctx, ctx.linkerArgs.map((a) => (a.startsWith("-") ? a : path.resolve(a))), wasmTarget, jsSyms);
  if (oformat === "WASM") unsupported("wasm-only output post-link");
  if (importsAsyncify(wasmTarget)) {
    // the pass needs the function names (its removelist); link again keeping them
    ctx.keepNames = true;
    await linkLld(ctx, ctx.linkerArgs.map((a) => (a.startsWith("-") ? a : path.resolve(a))), wasmTarget, jsSyms);
    ctx.keepNames = false;
    runBinaryen(ctx, "wasm-opt", wasmTarget, wasmTarget, ["--asyncify", "--pass-arg=asyncify-ignore-imports", ...asyncifyListArgs(), ...(process.env.ROMDEV_EMCC_KEEP_NAMES ? [] : ["--strip-debug"])]);
  }

  // phase_post_link
  let finalJs = path.join(ctx.tmp, path.basename(unsuffixed(target)) + ".js");
  S.set("TARGET_BASENAME", path.basename(unsuffixed(target)));
  const jsTarget = target;
  S.set("TARGET_JS_NAME", path.basename(jsTarget));
  await emscript(ctx, wasmTarget, wasmTarget, finalJs, jsSyms);
  ctx.intermediate?.("original.js", fs.readFileSync(finalJs));

  // phase_binaryen
  const passes = binaryenPasses(S, opts);
  if (passes.length) { runBinaryen(ctx, "wasm-opt", wasmTarget, wasmTarget, passes); ctx.intermediate?.("byn.wasm", fs.readFileSync(wasmTarget)); }
  if (S.get("CAN_ADDRESS_2GB")) finalJs = acorn(ctx, finalJs, ["unsignPointers"]);
  if (S.get("OPT_LEVEL") >= 2 && S.get("DEBUG_LEVEL") <= 2) finalJs = minifyWasmJs(ctx, finalJs, wasmTarget, willMetadce(S));

  // phase_final_emitting
  if (S.get("MODULARIZE")) {
    let mod = preprocess(ctx, path.join(ctx.emRoot, "src/modularize.js"), true);
    if (S.get("MINIFY_WHITESPACE")) {
      const tmp = path.join(ctx.tmp, "modularize_src.js");
      fs.writeFileSync(tmp, mod);
      mod = fs.readFileSync(acorn(ctx, tmp, ["--minify-whitespace"]), "utf8");
    }
    if (!mod.includes('"<<< INNER_JS_CODE >>>"')) throw new Error("expected to find pattern in input JS: <<< INNER_JS_CODE >>>");
    const full = mod.replace('"<<< INNER_JS_CODE >>>"', () => fs.readFileSync(finalJs, "utf8"));
    finalJs += ".modular.js";
    fs.writeFileSync(finalJs, full);
    ctx.intermediate?.("modularized.js", full);
    const src = fs.readFileSync(finalJs, "utf8");
    fs.writeFileSync(finalJs, src.replaceAll("EMSCRIPTEN$IMPORT$META", "import.meta").replaceAll("EMSCRIPTEN$AWAIT$IMPORT", "await import").replaceAll("EMSCRIPTEN$AWAIT(", "await ("));
  }
  // handle_license
  const licRe = /\/\*\*?(\s*\*?\s*@license)?(\s*\*?\s*Copyright \d+ The Emscripten Authors\s*\*?\s*SPDX-License-Identifier: MIT)+\s*\*\/\s*/g;
  const js = fs.readFileSync(finalJs, "utf8");
  const processed = js.replace(licRe, "");
  if (S.get("EMIT_EMSCRIPTEN_LICENSE")) unsupported("EMIT_EMSCRIPTEN_LICENSE");
  fs.writeFileSync(jsTarget, processed);
  if (opts.executable) {
    fs.writeFileSync(jsTarget, `#!/usr/bin/env node\n${processed}`);
    fs.chmodSync(jsTarget, fs.statSync(jsTarget).mode | 0o100);
  }
  return 0;
}
