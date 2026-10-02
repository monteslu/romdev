// system-libs.mjs - build emscripten's system libraries (tools/system_libs.py)
// and the zlib port (tools/ports/zlib.py) with the wasm-emcc driver, so the
// sysroot needs neither Python nor a prebuilt emsdk cache.
//
// Library definitions mirror system_libs.py for emscripten 4.0.18: the same
// source lists, cflags, variation suffixes, object naming and archive member
// order. Only the variations romdev links are described; ask for another and
// it is refused.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { locate } from "./emcc.mjs";
import { runLLVMTool } from "./llvm.mjs";

const DETERMINISTIC_PREFIX = "/emsdk/emscripten";
const BIN = path.join(path.dirname(new URL(import.meta.url).pathname), "bin");

const LIBC_SOCKETS = ["socket.c", "socketpair.c", "shutdown.c", "bind.c", "connect.c", "listen.c", "accept.c", "getsockname.c", "getpeername.c", "send.c", "recv.c", "sendto.c", "recvfrom.c", "sendmsg.c", "recvmsg.c", "getsockopt.c", "setsockopt.c", "freeaddrinfo.c", "gethostbyaddr.c", "gethostbyaddr_r.c", "gethostbyname.c", "gethostbyname_r.c", "gethostbyname2.c", "gethostbyname2_r.c", "in6addr_any.c", "in6addr_loopback.c", "accept4.c"];
const MUSL_INTERNAL_INCLUDES = ["system/lib/libc/musl/src/internal", "system/lib/libc/musl/src/include", "system/lib/libc/musl/include", "system/lib/libc", "system/lib/pthread"];
const MUSL_INTERNAL_CFLAGS = ["-std=c99", "-D_XOPEN_SOURCE=700", "-Wno-unused-result"];

function filesIn(emRoot, dir, names) { return names.map((n) => path.join(emRoot, dir, n)); }
function globIn(emRoot, dir, re, excludes = []) {
  const root = path.join(emRoot, dir);
  const out = [];
  const walk = (d, recursive) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(p, true); }
      else if (re.test(e.name) && !excludes.includes(e.name)) out.push(p);
    }
  };
  walk(root, re.recursive);
  return out.sort(); // python sorted() on full paths: code-point order
}
const rx = (source, recursive = false) => Object.assign(new RegExp(source), { recursive });

/** os.walk(top) order: dir entries as listed by the OS (python does not sort). */
function osWalkFiles(top, ignore) {
  const out = [];
  const walk = (d) => {
    const ents = fs.readdirSync(d, { withFileTypes: true });
    const files = ents.filter((e) => !e.isDirectory()).map((e) => e.name);
    for (const f of files) if (f.endsWith(".c") && !ignore.has(f)) out.push(path.join(d, f));
    for (const e of ents) if (e.isDirectory() && !ignore.has(e.name)) walk(path.join(d, e.name));
  };
  walk(top);
  return out;
}

function libcFiles(emRoot, isMt) {
  if (isMt) throw new Error("libc -mt variation not described yet");
  const files = [];
  const musl = path.join(emRoot, "system/lib/libc/musl/src");
  let ignore = ["ipc", "passwd", "signal", "sched", "time", "linux", "aio", "exit", "legacy", "mq", "setjmp", "ldso", "malloc",
    "memcpy.c", "memset.c", "memmove.c", "getaddrinfo.c", "getnameinfo.c", "res_query.c", "res_querydomain.c", "proto.c", "ppoll.c",
    "syscall.c", "popen.c", "pclose.c", "getgrouplist.c", "initgroups.c", "wordexp.c", "timer_create.c", "getauxval.c", "lookup_name.c",
    "fork.c", "vfork.c", "posix_spawn.c", "posix_spawnp.c", "execve.c", "waitid.c", "system.c", "_Fork.c", "__reset_tls.c", "__init_tls.c", "__libc_start_main.c",
    ...LIBC_SOCKETS, "thread"];
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/thread", ["pthread_self.c", "pthread_cleanup_push.c", "pthread_attr_init.c", "pthread_attr_destroy.c", "pthread_attr_get.c", "pthread_attr_setdetachstate.c", "pthread_attr_setguardsize.c", "pthread_attr_setinheritsched.c", "pthread_attr_setschedparam.c", "pthread_attr_setschedpolicy.c", "pthread_attr_setscope.c", "pthread_attr_setstack.c", "pthread_attr_setstacksize.c", "pthread_getattr_np.c", "pthread_getconcurrency.c", "pthread_getcpuclockid.c", "pthread_getschedparam.c", "pthread_setschedprio.c", "pthread_setconcurrency.c", "default_attr.c", "call_once.c", "tss_create.c", "tss_delete.c", "tss_set.c", "cnd_broadcast.c", "cnd_destroy.c", "cnd_init.c", "cnd_signal.c", "cnd_timedwait.c", "cnd_wait.c", "mtx_destroy.c", "mtx_init.c", "mtx_lock.c", "mtx_timedlock.c", "mtx_trylock.c", "mtx_unlock.c", "thrd_create.c", "thrd_exit.c", "thrd_join.c", "thrd_sleep.c", "thrd_yield.c"]));
  files.push(...filesIn(emRoot, "system/lib/pthread", ["library_pthread_stub.c", "pthread_self_stub.c", "proxying_stub.c"]));
  ignore.push("pow_small.c", "log_small.c", "log2_small.c");
  files.push(...osWalkFiles(musl, new Set(ignore)));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/time", ["clock_settime.c", "asctime_r.c", "asctime.c", "ctime.c", "difftime.c", "ftime.c", "gmtime.c", "localtime.c", "nanosleep.c", "clock.c", "clock_nanosleep.c", "clock_getres.c", "clock_gettime.c", "ctime_r.c", "timespec_get.c", "utime.c", "__map_file.c", "strftime.c", "__tz.c", "__tm_to_secs.c", "__year_to_secs.c", "__month_to_secs.c", "wcsftime.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/legacy", ["getpagesize.c", "err.c", "euidaccess.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/linux", ["getdents.c", "gettid.c", "utimes.c", "statx.c", "wait4.c", "wait3.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/malloc", ["reallocarray.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/sched", ["sched_yield.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/exit", ["abort.c", "_Exit.c", "atexit.c", "at_quick_exit.c", "quick_exit.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/ldso", ["dladdr.c", "dlerror.c", "dlsym.c", "dlclose.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc/musl/src/signal", ["block.c", "getitimer.c", "killpg.c", "setitimer.c", "sigorset.c", "sigandset.c", "sigaddset.c", "sigdelset.c", "sigemptyset.c", "sigisemptyset.c", "sigfillset.c", "sigismember.c", "siginterrupt.c", "signal.c", "sigprocmask.c", "sigrtmax.c", "sigrtmin.c", "sigwait.c", "sigwaitinfo.c"]));
  files.push(...filesIn(emRoot, "system/lib/libc", ["emscripten_console.c", "emscripten_fiber.c", "emscripten_get_heap_size.c", "emscripten_memcpy.c", "emscripten_memmove.c", "emscripten_memset.c", "emscripten_memcpy_bulkmem.S", "emscripten_memset_bulkmem.S", "emscripten_mmap.c", "emscripten_scan_stack.c", "emscripten_time.c", "mktime.c", "kill.c", "lookup_name.c", "pthread_sigmask.c", "raise.c", "sigaction.c", "sigtimedwait.c", "wasi-helpers.c", "system.c"]));
  files.push(...filesIn(emRoot, "system/lib/pthread", ["thread_profiler.c"]));
  files.push(...globIn(emRoot, "system/lib/libc/compat", rx("\\.c$")));
  return files;
}

function libcNonLto(emRoot) {
  return new Set([
    ...filesIn(emRoot, "system/lib/libc/musl/src/math", ["fmin.c", "fminf.c", "fminl.c", "fmax.c", "fmaxf.c", "fmaxl.c", "fmod.c", "fmodf.c", "fmodl.c", "logf.c", "logf_data.c", "log2f.c", "log2f_data.c", "log10.c", "log10f.c", "exp.c", "exp_data.c", "exp2.c", "exp2f.c", "exp2f_data.c", "exp10.c", "exp10f.c", "ldexp.c", "ldexpf.c", "ldexpl.c", "scalbn.c", "__fpclassifyl.c", "__signbitl.c", "__signbitf.c", "__signbit.c", "__math_divzero.c", "__math_divzerof.c", "__math_oflow.c", "__math_oflowf.c", "__math_uflow.c", "__math_uflowf.c", "__math_invalid.c", "__math_invalidf.c", "__math_invalidl.c", "pow.c", "pow_data.c", "log.c", "log_data.c", "log2.c", "log2_data.c", "scalbnf.c"]),
    ...filesIn(emRoot, "system/lib/libc/musl/src/exit", ["atexit.c"]),
    ...filesIn(emRoot, "system/lib/libc", ["emscripten_memcpy.c", "emscripten_memset.c", "emscripten_memcpy_bulkmem.S", "emscripten_memset_bulkmem.S", "emscripten_scan_stack.c", "emscripten_get_heap_size.c", "emscripten_memmove.c"]),
    ...filesIn(emRoot, "system/lib/libc/musl/src/stdio", ["__towrite.c", "__overflow.c", "fwrite.c", "fputs.c", "getc.c", "fputc.c", "fgets.c", "putc.c", "putc_unlocked.c", "putchar.c", "putchar_unlocked.c", "printf.c", "puts.c", "__lockfile.c"]),
    ...filesIn(emRoot, "system/lib/libc/musl/src/string", ["strlen.c"]),
    ...filesIn(emRoot, "system/lib/libc/musl/src/errno", ["__errno_location.c", "strerror.c"]),
  ]);
}

/**
 * The variation a library resolves to for {mt, debug, eh ("none"|"emscripten"),
 * webgl2, fullEs3, getProcAddr}: base name, cflags, sources.
 * cflags order follows Library.get_cflags(): MRO-inherited `cflags`, base
 * cflags, includes, then each mixin's additions in MRO order.
 */
export function describeLibrary(name, v, emRoot) {
  const inc = (dirs) => dirs.map((d) => "-I" + path.join(emRoot, d));
  const mtFlags = v.mt ? ["-pthread", "-sWASM_WORKERS"] : [];
  if (v.mt) throw new Error("-mt system library variations are not described yet");
  switch (name) {
    case "libcompiler_rt": {
      const excludes = ["gcc_personality_v0.c", "extendbfsf2.c", "truncdfbf2.c", "truncxfbf2.c", "truncsfbf2.c", "trunctfbf2.c", "crtbegin.c", "crtend.c", "divxc3.c", "extendhfxf2.c", "extendxftf2.c", "fixxfdi.c", "fixxfti.c", "fixunsxfdi.c", "fixunsxfsi.c", "fixunsxfti.c", "floatdixf.c", "floattixf.c", "floatundixf.c", "floatuntixf.c", "mulxc3.c", "powixf2.c", "trunctfxf2.c", "truncxfhf2.c"];
      const files = [...globIn(emRoot, "system/lib/compiler-rt/lib/builtins", rx("\\.c$"), excludes), ...globIn(emRoot, "system/lib/compiler-rt/lib/profile", rx("\\.c$")), ...globIn(emRoot, "system/lib/compiler-rt/lib/profile", rx("\\.cpp$")),
        ...filesIn(emRoot, "system/lib/compiler-rt", ["stack_ops.S", "stack_limits.S", "emscripten_setjmp.c", "emscripten_exception_builtins.c", "emscripten_tempret.s", "__c_longjmp.S", "__trap.c"])];
      // MRO: libcompiler_rt, MTLibrary, SjLjLibrary, Library -> cflags reversed-MRO inherit: Library + libcompiler_rt
      return { base: "libcompiler_rt", forceObjectFiles: true, files, cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-fno-builtin", "-DNDEBUG", "-DCOMPILER_RT_HAS_ATOMICS=1", ...bc, ...inc(["system/lib/libc", "system/lib/compiler-rt/include"]), "-sSUPPORT_LONGJMP=emscripten", "-sDISABLE_EXCEPTION_THROWING=0", ...mtFlags] };
    }
    case "libnoexit":
      return { base: "libnoexit", files: filesIn(emRoot, "system/lib/libc", ["atexit_dummy.c"]), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", ...bc] };
    case "libc": {
      const cf = ["-Os", "-fno-inline-functions", "-fno-builtin", "-Wno-ignored-attributes", "-Wno-macro-redefined", "-Wno-shift-op-parentheses", "-Wno-string-plus-int", "-Wno-missing-braces", "-Wno-logical-op-parentheses", "-Wno-bitwise-op-parentheses", "-Wno-unused-but-set-variable", "-Wno-unused-variable", "-Wno-unused-label", "-Wno-pointer-sign"];
      const nonLto = libcNonLto(emRoot);
      return {
        base: "libc" + (v.debug ? "-debug" : ""), files: libcFiles(emRoot, v.mt),
        // MRO: libc, MuslInternalLibrary, DebugLibrary, AsanInstrumentedLibrary, MTLibrary, Library
        cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", ...MUSL_INTERNAL_CFLAGS, ...cf, ...bc, ...inc(MUSL_INTERNAL_INCLUDES), ...mtFlags, ...(v.debug ? [] : ["-DNDEBUG"])],
        customize: (cmd, file) => (nonLto.has(file) ? [...cmd.filter((a) => !a.startsWith("-flto") && !a.startsWith("-O")), "-O2"] : cmd),
      };
    }
    case "libsockets":
      return { base: "libsockets", files: filesIn(emRoot, "system/lib/libc/musl/src/network", LIBC_SOCKETS), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", ...MUSL_INTERNAL_CFLAGS, "-Os", "-fno-inline-functions", "-fno-builtin", "-Wno-shift-op-parentheses", ...bc, ...inc(MUSL_INTERNAL_INCLUDES), ...mtFlags] };
    case "libal":
      return { base: "libal", files: filesIn(emRoot, "system/lib", ["al.c"]), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-Os", "-fno-inline-functions", ...bc] };
    case "libhtml5":
      return { base: "libhtml5", files: globIn(emRoot, "system/lib/html5", rx("\\.c$")), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-Oz", "-fno-inline-functions", ...bc, ...inc(["system/lib/libc"])] };
    case "libstubs":
      return { base: "libstubs" + (v.debug ? "-debug" : ""), files: filesIn(emRoot, "system/lib/libc", ["emscripten_syscall_stubs.c", "emscripten_libc_stubs.c"]), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", ...bc, ...inc(["system/lib/libc/musl/src/include"]), ...(v.debug ? [] : ["-DNDEBUG"])] };
    case "libGL": {
      let base = "libGL";
      if (v.webgl2) base += "-webgl2";
      if (v.fullEs3) base += "-full_es3";
      if (v.getProcAddr) base += "-getprocaddr";
      return { base, files: filesIn(emRoot, "system/lib/gl", ["gl.c", "webgl1.c", "libprocaddr.c", "webgl2.c"]), cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-Oz", "-fno-inline-functions", ...bc, ...mtFlags, `-DMAX_WEBGL_VERSION=${v.webgl2 ? 2 : 1}`, ...(v.fullEs3 ? ["-D__EMSCRIPTEN_FULL_ES3__"] : []), ...(v.getProcAddr ? ["-DGL_ENABLE_GET_PROC_ADDRESS=1"] : [])] };
    }
    case "libdlmalloc":
      return { base: "libdlmalloc" + (v.debug ? "-debug" : ""), forceObjectFiles: true, files: [path.join(emRoot, "system/lib/dlmalloc.c"), path.join(emRoot, "system/lib/libc/sbrk.c")], cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-fno-builtin", "-Wno-unused-function", "-Wno-unused-but-set-variable", "-Wno-unused-variable", ...bc, ...mtFlags, ...(v.debug ? ["-UNDEBUG", "-DDLMALLOC_DEBUG"] : ["-DNDEBUG"])] };
    case "libc++abi": {
      const names = ["abort_message.cpp", "cxa_aux_runtime.cpp", "cxa_default_handlers.cpp", "cxa_demangle.cpp", "cxa_guard.cpp", "cxa_handlers.cpp", "cxa_virtual.cpp", "cxa_thread_atexit.cpp", "fallback_malloc.cpp", "stdlib_new_delete.cpp", "stdlib_exception.cpp", "stdlib_stdexcept.cpp", "stdlib_typeinfo.cpp", "private_typeinfo.cpp", "cxa_exception_js_utils.cpp", "__cpp_exception.S", v.eh === "none" ? "cxa_noexception.cpp" : "cxa_exception_emscripten.cpp"];
      // MRO: libcxxabi, ExceptionLibrary, MTLibrary, DebugLibrary, Library
      return { base: "libc++abi" + (v.debug ? "-debug" : "") + (v.eh === "none" ? "-noexcept" : ""), files: filesIn(emRoot, "system/lib/libcxxabi/src", names),
        cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-Oz", "-fno-inline-functions", "-D_LIBCPP_BUILDING_LIBRARY", "-D_LIBCXXABI_BUILDING_LIBRARY", "-DLIBCXXABI_NON_DEMANGLING_TERMINATE", "-std=c++23", ...bc, ...inc(["system/lib/libcxx/src"]), ...(v.debug ? [] : ["-DNDEBUG"]), ...mtFlags, ...(v.eh === "none" ? ["-fno-exceptions"] : ["-sDISABLE_EXCEPTION_CATCHING=0"]), "-D_LIBCXXABI_HAS_NO_THREADS", ...(v.eh === "none" ? ["-D_LIBCXXABI_NO_EXCEPTIONS"] : ["-D__EMSCRIPTEN_EXCEPTIONS__", "-DLIBCXXABI_SILENT_TERMINATE"])] };
    }
    case "libc++": {
      const ex = ["xlocale_zos.cpp", "mbsnrtowcs.cpp", "wcsnrtombs.cpp", "int128_builtins.cpp", "libdispatch.cpp", "locale_win32.cpp", "thread_win32.cpp", "support.cpp", "compiler_rt_shims.cpp", "time_zone.cpp", "tzdb.cpp", "tzdb_list.cpp"];
      return { base: "libc++" + (v.debug ? "-debug" : "") + (v.eh === "none" ? "-noexcept" : ""), files: globIn(emRoot, "system/lib/libcxx/src", rx("\\.cpp$", true), ex),
        cflags: (bc) => ["-O2", "-Wall", "-fno-unroll-loops", "-Oz", "-fno-inline-functions", "-DLIBCXX_BUILDING_LIBCXXABI=1", "-D_LIBCPP_BUILDING_LIBRARY", "-D_LIBCPP_DISABLE_VISIBILITY_ANNOTATIONS", "-Wno-unqualified-std-cast-call", "-Wno-unknown-warning-option", "-std=c++23", "-DLIBC_NAMESPACE=__llvm_libc", ...bc, ...inc(["system/lib/libcxx/src", "system/lib/llvm-libc"]), ...(v.debug ? [] : ["-DNDEBUG"]), ...mtFlags, ...(v.eh === "none" ? ["-fno-exceptions"] : ["-sDISABLE_EXCEPTION_CATCHING=0"])] };
    }
    default: throw new Error(`system library ${name} not described`);
  }
}

function baseCflags(emRoot, buildDir, { lto = false, forceObjectFiles = false } = {}) {
  const f = ["-g", "-sSTRICT", "-Werror"];
  if (lto && !forceObjectFiles) f.push("-flto=" + lto);
  const rel = path.relative(buildDir, emRoot);
  f.push(`-ffile-prefix-map=${emRoot}=${DETERMINISTIC_PREFIX}`, `-ffile-prefix-map=${rel}=${DETERMINISTIC_PREFIX}`, `-fdebug-compilation-dir=${DETERMINISTIC_PREFIX}`);
  return f;
}

function runPool(jobs, n) {
  let i = 0, failed = null;
  return new Promise((resolve, reject) => {
    let running = 0;
    const next = () => {
      if (failed) return;
      if (i >= jobs.length && running === 0) return resolve();
      while (running < n && i < jobs.length) {
        const job = jobs[i++]; running++;
        const p = spawn(process.execPath, [path.join(BIN, job.tool), ...job.args], { cwd: job.cwd, stdio: ["ignore", "inherit", "inherit"] });
        p.on("exit", (code) => { running--; if (code !== 0) { failed = new Error(`compile failed (${code}): ${job.args.slice(-3).join(" ")}`); return reject(failed); } next(); });
      }
    };
    next();
  });
}

/** Library.build_objects + create_lib */
export async function buildLibrary(name, variation, { jobs = os.cpus().length } = {}) {
  const { emRoot, sysroot } = locate();
  const d = describeLibrary(name, variation, emRoot);
  const buildDir = path.join(sysroot, "..", "sysroot-build", d.base + "-tmp");
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const cflags = d.cflags(baseCflags(emRoot, buildDir, { forceObjectFiles: d.forceObjectFiles }));
  const asflags = baseCflags(emRoot, buildDir, { forceObjectFiles: d.forceObjectFiles }); // get_base_cflags(preprocess=False)
  const objects = new Set();
  const work = [];
  for (const src of d.files) {
    const ext = path.extname(src);
    const tool = [".s", ".S", ".c"].includes(ext) ? "emcc" : "em++";
    let cmd = ["-c", ...(ext === ".s" ? asflags : cflags)];
    if (d.customize) cmd = d.customize(cmd, src);
    const stem = path.basename(src, ext).toLowerCase();
    let o = path.join(buildDir, stem + ".o");
    if (objects.has(o)) { let n = 0; while (objects.has(o)) o = path.join(buildDir, `${stem}__${++n}.o`); work.push({ tool, cwd: buildDir, args: [...cmd, src, "-o", o] }); }
    else {
      // batch mode: source relative to build_dir, object keeps the source's case
      o = path.join(buildDir, path.basename(src, ext) + ".o");
      work.push({ tool, cwd: buildDir, args: [...cmd, path.relative(buildDir, src), "-o", o] });
    }
    objects.add(o);
  }
  await runPool(work, jobs);
  const sorted = [...objects].sort((a, b) => { const ka = path.basename(a) === "vmlock.o" ? "AAA_vmlock.o" : path.basename(a); const kb = path.basename(b) === "vmlock.o" ? "AAA_vmlock.o" : path.basename(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
  const out = path.join(sysroot, "lib/wasm32-emscripten", d.base + ".a");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  const code = await runLLVMTool(["ar", "cr", out, ...sorted]);
  if (code !== 0) throw new Error(`llvm-ar failed for ${out}`);
  fs.rmSync(buildDir, { recursive: true, force: true });
  return out;
}

/** tools/ports/zlib.py: zlib 1.3.1 from the pinned tarball. */
export async function buildZlib(srcTarball, { jobs = os.cpus().length } = {}) {
  const { emRoot, sysroot } = locate();
  const portDir = path.join(sysroot, "..", "ports", "zlib");
  const src = path.join(portDir, "zlib-1.3.1");
  if (!fs.existsSync(src)) {
    fs.mkdirSync(portDir, { recursive: true });
    const { execFileSync } = await import("node:child_process");
    execFileSync("tar", ["xzf", srcTarball, "-C", portDir]);
  }
  fs.copyFileSync(path.join(emRoot, "tools/ports/zlib/zconf.h"), path.join(src, "zconf.h"));
  for (const h of fs.readdirSync(src).filter((f) => f.endsWith(".h"))) fs.copyFileSync(path.join(src, h), path.join(sysroot, "include", h));
  const pc = path.join(sysroot, "lib/pkgconfig"); fs.mkdirSync(pc, { recursive: true });
  fs.writeFileSync(path.join(pc, "zlib.pc"), `\nName: zlib\nDescription: zlib port from emscripten\nVersion: 1.3.1\nLibs: -sUSE_ZLIB\nCflags: -sUSE_ZLIB\n`);
  const buildDir = path.join(sysroot, "..", "sysroot-build", "zlib", "lib_wasm32_libz");
  fs.rmSync(buildDir, { recursive: true, force: true }); fs.mkdirSync(buildDir, { recursive: true });
  const cflags = [...baseCflags(emRoot, buildDir), "-O2", "-I" + src, "-Wno-deprecated-non-prototype"];
  const srcs = "adler32.c compress.c crc32.c deflate.c gzclose.c gzlib.c gzread.c gzwrite.c infback.c inffast.c inflate.c inftrees.c trees.c uncompr.c zutil.c".split(" ");
  const objs = [];
  const work = srcs.map((s) => { const o = path.join(buildDir, s + ".o"); objs.push(o); /* ports name objects <src>.o, e.g. adler32.c.o */ return { tool: "emcc", cwd: buildDir, args: ["-c", path.join(src, s), "-o", o, ...cflags] }; });
  await runPool(work, jobs);
  const out = path.join(sysroot, "lib/wasm32-emscripten/libz.a");
  fs.rmSync(out, { force: true });
  const code = await runLLVMTool(["ar", "cr", out, ...objs.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1))]);
  if (code !== 0) throw new Error("llvm-ar failed for libz.a");
  return out;
}

// CLI: node system-libs.mjs <lib> [--debug] [--noexcept] [--webgl2] [--full-es3] [--getprocaddr]
//      node system-libs.mjs zlib <zlib-1.3.1.tar.gz>
//      node system-libs.mjs p4      (every library a P4 libretro core links)
if (import.meta.url === `file://${process.argv[1]}`) {
  const [what, ...rest] = process.argv.slice(2);
  const flag = (f) => rest.includes(f);
  const t0 = Date.now();
  let outs;
  if (what === "zlib") outs = [await buildZlib(path.resolve(rest[0]))];
  else if (what === "p4") {
    outs = [];
    for (const [n, v] of [["libGL", { getProcAddr: true }], ["libal", {}], ["libhtml5", {}], ["libstubs", {}], ["libnoexit", {}], ["libc", {}], ["libdlmalloc", {}], ["libcompiler_rt", {}], ["libc++", { eh: "none" }], ["libc++abi", { eh: "none" }], ["libsockets", {}]]) {
      outs.push(await buildLibrary(n, v));
      console.log(`built ${outs.at(-1)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  } else outs = [await buildLibrary(what, { debug: flag("--debug"), eh: flag("--noexcept") ? "none" : "emscripten", webgl2: flag("--webgl2"), fullEs3: flag("--full-es3"), getProcAddr: flag("--getprocaddr") })];
  console.log(outs.join("\n"), `\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
