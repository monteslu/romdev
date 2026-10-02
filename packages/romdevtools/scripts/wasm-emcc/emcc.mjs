#!/usr/bin/env node
// emcc.mjs - a Python-free emcc for romdev's builds.
//
// Same command line as emscripten's emcc/em++ (the subset romdev's build
// scripts use), but every step runs in node:
//   compile  -> clang from @yowasp/clang (LLVM as WASM), with exactly the
//               flags emcc's tools/compile.py adds
//   link     -> link.mjs (wasm-ld as WASM, emscripten's own JS compiler for
//               the glue, binaryen's wasm-opt as WASM)
//   emar     -> llvm-ar as WASM
// The emscripten tree (src/, tools/*.mjs, system/ headers) and its sysroot
// are inputs, located by ROMDEV_EMSCRIPTEN_ROOT / ROMDEV_EMSCRIPTEN_SYSROOT.
//
//   node emcc.mjs [emcc args...]        (or via the emcc/em++ shims in bin/)

import fs from "node:fs";
import path from "node:path";
import { runClangDriver, runLLVMTool, toolchainDir } from "./llvm.mjs";
import { Settings, applyUserSettings } from "./settings.mjs";
import { link, unsupported, llvmBackendArgs } from "./link.mjs";

const SOURCE_EXT = new Set([".c", ".i", ".cppm", ".pcm", ".cpp", ".cxx", ".cc", ".c++", ".CPP", ".CXX", ".C", ".CC", ".C++", ".ii", ".m", ".mi", ".mm", ".mii", ".bc", ".ll", ".S"]);
const ASM_EXT = new Set([".s"]);
const HEADER_EXT = new Set([".h", ".hxx", ".hpp", ".hh", ".H", ".HXX", ".HPP", ".HH"]);
// tools/cmdline.py CLANG_FLAGS_WITH_ARGS
const CLANG_FLAGS_WITH_ARGS = new Set(["-MT", "-MF", "-MJ", "-MQ", "-D", "-U", "-o", "-x", "-Xpreprocessor", "-include", "-imacros", "-idirafter", "-iprefix", "-iwithprefix", "-iwithprefixbefore", "-isysroot", "-imultilib", "-A", "-isystem", "-iquote", "-install_name", "-compatibility_version", "-mllvm", "-current_version", "-I", "-L", "-include-pch", "-u", "-undefined", "-target", "-Xlinker", "-Xclang", "-z"]);

export function locate() {
  const tc = toolchainDir();
  const emRoot = path.resolve(process.env.ROMDEV_EMSCRIPTEN_ROOT ?? path.join(tc, "emscripten"));
  const sysroot = path.resolve(process.env.ROMDEV_EMSCRIPTEN_SYSROOT ?? path.join(tc, "sysroot"));
  const emVersion = fs.readFileSync(path.join(emRoot, "emscripten-version.txt"), "utf8").trim().replace(/^"|"$/g, "").replace(/-git$/, "");
  return { tc, emRoot, sysroot, emVersion, binaryenBin: path.join(tc, "node_modules/binaryen/bin") };
}

const suffixOf = (f) => { const b = path.basename(f); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : ""; };

function isDashSForEmcc(args, i) {
  let a;
  if (args[i] === "-s") { if (args.length <= i + 1) return false; a = args[i + 1]; } else a = args[i].slice(2);
  a = a.split("=")[0];
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(a) && a === a.toUpperCase() && /[A-Z]/.test(a);
}

/** cmdline.py parse_arguments/parse_args (romdev subset). */
export function parseArgs(argv, S) {
  const opts = { inputFiles: [], outputFile: null, preJs: [], postJs: [], preloadFiles: [], embedFiles: [], sanitize: new Set(), libDirs: [], dashC: false, dashS: false, dashE: false, dashM: false, syntaxOnly: false, noEntry: false, nostdlib: false, nostdlibxx: false, nodefaultlibs: false, nolibc: false, nostartfiles: false, noMinify: false, oformat: null, fastMath: false, requestedDebug: null, target: "" };
  let args = [...argv];
  for (let i = 0; i < args.length; i++) {
    if (["-l", "-L", "-I", "-z", "--js-library", "-o", "-x", "-u"].includes(args[i])) {
      if (args[i] === "--js-library") args[i] += "=";
      if (args.length <= i + 1) throw new Error(`option '${args[i]}' requires an argument`);
      args[i] += args[i + 1]; args[i + 1] = "";
    }
  }
  args = args.filter((a, i) => a !== "" || argv[i] === "");
  const settingsChanges = [];
  const out = [];
  let skip = false;
  for (let i = 0; i < args.length; i++) {
    if (skip) { skip = false; out.push(args[i]); continue; }
    let a = args[i];
    if (a === "--bind") unsupported("--bind / embind");
    if (CLANG_FLAGS_WITH_ARGS.has(a)) skip = true;
    if (a === "-s" && isDashSForEmcc(args, i)) { settingsChanges.push(args[++i]); continue; }
    if (a.startsWith("-s") && a.length > 2 && isDashSForEmcc(args, i)) { settingsChanges.push(a.slice(2)); continue; }
    const argVal = (name) => (a.startsWith(name + "=") ? a.slice(name.length + 1) : a === name ? args[++i] : null);
    if (a.startsWith("-O")) {
      let lvl = a.slice(2) || "2";
      if (lvl === "s") { lvl = 2; S.set("SHRINK_LEVEL", 1); }
      else if (lvl === "z") { lvl = 2; S.set("SHRINK_LEVEL", 2); }
      else if (lvl === "g") { lvl = 1; S.set("SHRINK_LEVEL", 0); S.set("DEBUG_LEVEL", Math.max(S.get("DEBUG_LEVEL"), 1)); }
      else if (lvl === "fast") { opts.fastMath = true; lvl = 3; S.set("SHRINK_LEVEL", 0); }
      else S.set("SHRINK_LEVEL", 0);
      S.set("OPT_LEVEL", Math.min(Number(lvl), 3));
      out.push(a); continue;
    }
    if (a.startsWith("-flto")) { S.set("LTO", a.includes("=") ? a.split("=")[1] : "full"); out.push(a); continue; }
    if (a === "-fno-lto") { S.set("LTO", 0); out.push(a); continue; }
    for (const [flag, key] of [["--pre-js", "preJs"], ["--post-js", "postJs"]]) {
      const v = a === flag || a.startsWith(flag + "=") ? argVal(flag) : null;
      if (v !== null) { opts[key].push(path.resolve(v)); a = null; break; }
    }
    if (a === null) continue;
    if (a.startsWith("--embed-file") || a.startsWith("--preload-file") || a.startsWith("--closure") || a.startsWith("--extern-") || a.startsWith("--js-transform") || a === "--emrun" || a.startsWith("--shell-file") || a === "--emit-symbol-map" || a === "--cpuprofiler" || a === "--memoryprofiler" || a === "--tracing" || a === "--threadprofiler" || a === "--proxy-to-worker" || a === "--use-preload-plugins" || a === "--post-link") unsupported(a);
    if (a.startsWith("--oformat")) { const v = argVal("--oformat"); opts.oformat = v.toUpperCase(); continue; }
    if (a.startsWith("--minify")) { if (argVal("--minify") !== "0") throw new Error("0 is the only supported option for --minify"); opts.noMinify = true; continue; }
    if (a.startsWith("-g")) {
      opts.requestedDebug = a;
      const lvl = a.slice(2) || "3";
      if (/^\d+$/.test(lvl)) {
        S.set("DEBUG_LEVEL", Math.min(Number(lvl), 4));
        if (S.get("DEBUG_LEVEL") === 0) { S.set("GENERATE_DWARF", 0); S.set("GENERATE_SOURCE_MAP", 0); S.set("EMIT_NAME_SECTION", 0); }
        else if (S.get("DEBUG_LEVEL") > 1) S.set("EMIT_NAME_SECTION", 1);
        if (S.get("DEBUG_LEVEL") < 3 && !(S.get("GENERATE_SOURCE_MAP") || S.get("SEPARATE_DWARF"))) out.push("-g0");
        else { out.push("-g3"); if (S.get("DEBUG_LEVEL") === 3) S.set("GENERATE_DWARF", 1); if (S.get("DEBUG_LEVEL") === 4) S.set("GENERATE_SOURCE_MAP", 1); }
      } else if (lvl === "z") out.push(a);
      else unsupported(`debug flag ${a}`);
      continue;
    }
    if (a === "--profiling" || a === "-profiling" || a === "--profiling-funcs" || a === "-profiling-funcs") unsupported(a);
    if (a === "-v") { opts.verbose = true; out.push(a); continue; }
    if (a === "--no-entry") { opts.noEntry = true; continue; }
    if (a === "-fno-exceptions") { S.set("DISABLE_EXCEPTION_CATCHING", 1); S.set("DISABLE_EXCEPTION_THROWING", 1); S.set("WASM_EXCEPTIONS", 0); }
    else if (a === "-fexceptions") { S.set("DISABLE_EXCEPTION_THROWING", 0); S.set("DISABLE_EXCEPTION_CATCHING", 0); }
    else if (a === "-fwasm-exceptions") S.set("WASM_EXCEPTIONS", 1);
    else if (a === "-fignore-exceptions") S.set("DISABLE_EXCEPTION_CATCHING", 1);
    else if (a === "-ffast-math") opts.fastMath = true;
    else if (a === "-pthread") { S.set("PTHREADS", 1); S.set("USE_PTHREADS", 1); }
    else if (a === "-fno-rtti") S.set("USE_RTTI", 0);
    else if (a === "-frtti") S.set("USE_RTTI", 1);
    else if (a.startsWith("-fsanitize=")) for (const x of a.slice(11).split(",")) opts.sanitize.add(x);
    else if (["-mbulk-memory", "-mno-bulk-memory", "-msign-ext", "-mno-sign-ext", "-mno-nontrapping-fptoint"].includes(a)) unsupported(`feature flag ${a}`);
    else if (a === "-shared") { opts.shared = true; continue; }
    else if (a === "-r") { opts.relocatable = true; continue; }
    else if (a === "-c") opts.dashC = true;
    else if (a === "-S") opts.dashS = true;
    else if (a === "-E") opts.dashE = true;
    else if (a === "-M" || a === "-MM") opts.dashM = true;
    else if (a === "-fsyntax-only") opts.syntaxOnly = true;
    else if (a === "-nostdlib") opts.nostdlib = true;
    else if (a === "-nostdlibxx") opts.nostdlibxx = true;
    else if (a === "-nodefaultlibs") opts.nodefaultlibs = true;
    else if (a === "-nolibc") opts.nolibc = true;
    else if (a === "-nostartfiles") opts.nostartfiles = true;
    else if (a.startsWith("-L")) opts.libDirs.push(a.slice(2));
    else if (a.startsWith("--target=")) opts.target = a.slice(9);
    if (a.startsWith("-o") && a.length > 2) { opts.outputFile = a.slice(2); continue; }
    if (!a.startsWith("-") && a !== "") opts.inputFiles.push(a);
    out.push(a);
  }
  // parse_s_args
  for (let key of settingsChanges) {
    if (!key.includes("=")) key += "=1";
    if (/^MIN_.*_VERSION(=.*)?$/.test(key)) { const v = parseInt(key.split("=")[1], 10); if (v < 0) key = key.split("=")[0] + "=0x7FFFFFFF"; }
    let [k, ...rest] = key.split("="); let v = rest.join("=");
    if (k.startsWith("NO_") && (v === "0" || v === "1")) { k = k.slice(3); v = String(1 - Number(v)); }
    S.user[k] = v;
  }
  applyUserSettings(S);
  return { opts, newargs: out };
}

/** compile.py get_cflags */
function getCflags(S, userArgs, sysroot) {
  const f = ["-target", "wasm32-unknown-emscripten"];
  if (S.get("DISABLE_EXCEPTION_CATCHING") && !S.get("WASM_EXCEPTIONS")) f.push("-fignore-exceptions");
  if (S.get("INLINING_LIMIT")) f.push("-fno-inline-functions");
  if (S.get("PTHREADS")) { if (!userArgs.includes("-pthread")) f.push("-pthread"); }
  else if (S.get("SHARED_MEMORY")) unsupported("SHARED_MEMORY compile");
  if (S.get("RELOCATABLE") || S.get("LINKABLE") || userArgs.includes("-fPIC")) unsupported("-fPIC / relocatable compile");
  if (S.get("LTO")) {
    if (!userArgs.some((a) => a.startsWith("-flto"))) f.push("-flto=" + S.get("LTO"));
    if (S.get("SUPPORT_LONGJMP") === "wasm") f.push("-mexception-handling");
  } else for (const a of llvmBackendArgs(S)) f.push("-mllvm", a);
  f.push("--sysroot=" + sysroot);
  if (S.get("EMSCRIPTEN_TRACING")) f.push("-D__EMSCRIPTEN_TRACING__=1");
  if (S.get("SHARED_MEMORY")) f.push("-D__EMSCRIPTEN_SHARED_MEMORY__=1");
  if (!S.get("STRICT")) f.push("-DEMSCRIPTEN");
  // ports.add_cflags: zlib's headers live in the sysroot; boost headers port is unsupported here.
  if (S.get("USE_BOOST_HEADERS") || S.get("USE_SDL") || S.get("USE_LIBPNG") || S.get("USE_BZIP2")) unsupported("ports other than zlib");
  if (userArgs.some((a) => /^-m(sse|avx|neon)/.test(a))) unsupported("SIMD intrinsics flags");
  if (!userArgs.includes("-nostdinc")) {
    if (!S.get("USE_SDL")) f.push("-Xclang", "-iwithsysroot/include/fakesdl");
    f.push("-Xclang", "-iwithsysroot/include/compat");
  }
  return f;
}

/** Outputs must be absolute (the WASI root is the host /); inputs and include
 * paths stay as given so __FILE__ and diagnostics match emcc - clang resolves
 * them through -working-directory. */
function absolutizeCompileArgs(args, cwd) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-o" || a === "-MF") && i + 1 < args.length) { out.push(a, path.resolve(cwd, args[++i])); continue; }
    if (a.startsWith("-MF") && a.length > 3) { out.push("-MF" + path.resolve(cwd, a.slice(3))); continue; }
    // clang -cc1as ignores -working-directory, so assembler inputs go absolute
    if (!a.startsWith("-") && a.endsWith(".s") && !path.isAbsolute(a)) { out.push(path.resolve(cwd, a)); continue; }
    out.push(a);
  }
  return out;
}

export async function main(argv, { cxx = false } = {}) {
  const loc = locate();
  const S = new Settings(loc.emRoot);
  if (argv.length === 1 && argv[0] === "-v" || argv.includes("--version")) { process.stdout.write(`emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${loc.emVersion} (romdev wasm-emcc)\n`); return 0; }
  if (argv.includes("-dumpversion")) { process.stdout.write(loc.emVersion + "\n"); return 0; }
  if (argv.includes("-dumpmachine") || argv.includes("-print-target-triple") || argv.includes("--print-target-triple")) { process.stdout.write("wasm32-unknown-emscripten\n"); return 0; }
  if (process.env.EMCC_CFLAGS) argv = argv.concat(process.env.EMCC_CFLAGS.split(/\s+/).filter(Boolean));
  // response files
  argv = argv.flatMap((a) => (a.startsWith("@") && fs.existsSync(a.slice(1)) ? fs.readFileSync(a.slice(1), "utf8").split(/\s+/).filter(Boolean) : [a]));
  const { opts, newargs } = parseArgs(argv, S);
  // phase_setup
  const hasHeader = opts.inputFiles.some((f) => HEADER_EXT.has(suffixOf(f)));
  const compileOnly = hasHeader || opts.dashC || opts.dashS || opts.syntaxOnly || opts.dashE || opts.dashM;
  if (S.get("MAIN_MODULE") || S.get("SIDE_MODULE")) unsupported("MAIN_MODULE / SIDE_MODULE");
  if (S.get("STRICT")) S.set("STRICT", Number(S.get("STRICT"))); // only meaningful for compiles here (no -DEMSCRIPTEN); link refuses it
  if ("USE_PTHREADS" in S.user) S.set("PTHREADS", S.get("USE_PTHREADS"));
  if (S.get("PTHREADS") || S.get("WASM_WORKERS")) S.set("SHARED_MEMORY", 1);
  if (S.get("EXCEPTION_CATCHING_ALLOWED").length) S.set("DISABLE_EXCEPTION_CATCHING", 0);
  if (S.get("WASM_EXCEPTIONS")) unsupported("-fwasm-exceptions");
  if (S.get("DISABLE_EXCEPTION_THROWING") && !S.get("DISABLE_EXCEPTION_CATCHING")) throw new Error("DISABLE_EXCEPTION_THROWING was set but is not compatible with enabling exception catching");
  if (S.get("SUPPORT_LONGJMP") === 1 || S.get("SUPPORT_LONGJMP") === true) S.set("SUPPORT_LONGJMP", "emscripten");
  if (S.get("USE_SDL") === 2 || S.get("USE_SDL_MIXER") === 2 || S.get("USE_SDL_GFX") === 2) S.setDefault("GL_ENABLE_GET_PROC_ADDRESS", 1);

  const cwd = process.cwd();
  const clang = cxx ? "clang++" : "clang";
  const cflags = getCflags(S, argv, loc.sysroot);
  if (compileOnly) {
    const allAsm = opts.inputFiles.length && opts.inputFiles.every((f) => ASM_EXT.has(suffixOf(f)));
    const flags = allAsm ? ["-target", "wasm32-unknown-emscripten"] : cflags;
    const cmd = [clang, ...flags, "-working-directory", cwd, ...absolutizeCompileArgs(newargs, cwd)];
    if (opts.outputFile) cmd.push("-o", path.resolve(cwd, opts.outputFile));
    if (process.env.ROMDEV_EMCC_VERBOSE) process.stderr.write("[wasm-emcc] " + cmd.join(" ") + "\n");
    return runClangDriver(cmd);
  }
  // COMPILE_AND_LINK: separate_linker_flags, compile sources to temp objects
  const tmpRoot = process.env.ROMDEV_EMCC_TMP ?? path.join(path.dirname(loc.tc), "wasm-emcc-tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, "link-"));
  try {
    const compileArgs = [], linkerArgs = [];
    let sk = false;
    for (let i = 0; i < newargs.length; i++) {
      if (sk) { sk = false; continue; }
      const a = newargs[i];
      if (CLANG_FLAGS_WITH_ARGS.has(a)) sk = true;
      if (!a.startsWith("-") || a === "-") {
        if (!fs.existsSync(a) && a !== "/dev/null" && a !== "-") throw new Error(`${a}: No such file or directory`);
        linkerArgs.push({ v: a, file: true });
      } else if (a === "-z") { linkerArgs.push({ v: a }, { v: newargs[i + 1] }); sk = true; }
      else if (a.startsWith("-Wl,")) for (const f of a.split(",").slice(1)) linkerArgs.push({ v: f });
      else if (a === "-Xlinker") { linkerArgs.push({ v: newargs[i + 1] }); sk = true; }
      else if (a === "-s" || a.startsWith("-l") || a.startsWith("-L") || a.startsWith("--js-library=") || a.startsWith("-z") || a.startsWith("-u")) linkerArgs.push({ v: a });
      else if (!a.startsWith("-o") && !["-nostdlib", "-nostartfiles", "-nolibc", "-nodefaultlibs", "-s"].includes(a)) {
        compileArgs.push(a);
        if (sk) compileArgs.push(newargs[i + 1]);
      }
    }
    const seen = {};
    for (const la of linkerArgs) {
      if (!la.file) continue;
      const ext = suffixOf(la.v);
      if (SOURCE_EXT.has(ext) || ASM_EXT.has(ext)) {
        let base = path.basename(la.v, ext) + ".o";
        if (seen[base]) { const n = seen[base]++; base = base.replace(/\.o$/, `_${n}.o`); } else seen[base] = 1;
        const obj = path.join(tmp, base);
        const flags = ASM_EXT.has(ext) ? ["-target", "wasm32-unknown-emscripten"] : cflags;
        const code = await runClangDriver([clang, ...flags, "-working-directory", cwd, ...absolutizeCompileArgs(compileArgs, cwd), "-c", path.resolve(cwd, la.v), "-o", obj]);
        if (code !== 0) return code;
        la.v = obj;
      } else if (/\.(so|dylib|dll)$/.test(ext)) unsupported(`dynamic library input ${la.v}`);
    }
    const ports = [];
    if (S.get("USE_ZLIB")) ports.push({ name: "zlib", lib: path.join(loc.sysroot, "lib/wasm32-emscripten/libz.a") });
    for (const p of ports) if (!fs.existsSync(p.lib)) throw new Error(`port library missing: ${p.lib} (build it with scripts/wasm-emcc/build-sysroot.mjs)`);
    const ctx = {
      S, opts, emRoot: loc.emRoot, emVersion: loc.emVersion, sysrootLib: path.join(loc.sysroot, "lib/wasm32-emscripten"), binaryenBin: loc.binaryenBin,
      linkerArgs: linkerArgs.map((l) => l.v), libDirs: [...opts.libDirs], userRequestedExports: new Set(), runViaEmxx: cxx, ports, tmp,
      log: process.env.ROMDEV_EMCC_VERBOSE ? (c) => process.stderr.write("[wasm-emcc] " + c.join(" ") + "\n") : null,
      intermediate: process.env.ROMDEV_EMCC_SAVE ? mkIntermediate(process.env.ROMDEV_EMCC_SAVE) : null,
    };
    if (opts.outputFile) opts.outputFile = path.resolve(cwd, opts.outputFile);
    return await link(ctx);
  } finally {
    if (!process.env.ROMDEV_EMCC_KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function mkIntermediate(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  return (name, content) => fs.writeFileSync(path.join(dir, `emcc-${String(n++).padStart(2, "0")}-${name}`), content);
}

export async function emar(argv) {
  // emar.py: llvm-ar with a fixed member-name scheme; romdev only uses rcs/cr/crs/x/t.
  const args = argv.map((a, i) => (i === 0 || a.startsWith("-") ? a : path.resolve(a)));
  return runLLVMTool(["ar", ...args]);
}

export const emranlib = (argv) => runLLVMTool(["ranlib", ...argv.map((a) => (a.startsWith("-") ? a : path.resolve(a)))]);
