#!/usr/bin/env node
// Compile ares's firmware-running SNES coprocessors to wasm32 and write them
// as WAT for the SNES WAT recompiler (src/analysis/recompile/wat/snes/
// ares-chips.json): the uPD96050 the ST010 / ST011 are (ares
// component/processor/upd96050) and the ARM the ST018 is
// (component/processor/arm7tdmi plus sfc/coprocessor/armdsp/memory.cpp and
// io.cpp). snes9x has no real emulation of either (an HLE that stops early, a
// stub); a cart built with the chip's firmware runs this code instead, and the
// snes9x reference core runs the same code
// (scripts/patches/snes9x-ares-chips.patch), so the two agree to the bit.
//
// The processors are ares's own source compiled as it is, against
// glue/romdev_ares.hpp in place of ares's emulator-wide ares/ares.hpp (staged
// as include/ares/ares.hpp); the glue (ares-chips/glue: glue_necdsp.cpp,
// glue_armdsp.cpp, see romdev_ares_chips.hpp) includes ares's
// sfc/coprocessor/necdsp and armdsp driver files that touch the chip from the
// S-CPU side as they are, and restates the rest of those drivers and ares's
// thread clock without ares's node tree, debugger and scheduler list;
// glue_runtime.cpp is the allocator and the few libc / libc++ pieces a unit
// has no library for.
//
// Each unit is linked twice at two --global-base values and printed with
// lib/wasm-unit.mjs (an address inside the unit's memory becomes @{offset};
// the cart places the unit). A unit imports nothing.
//
// Recompile time never needs ares or a compiler; only this script does:
// clang++ and wasm-ld (emsdk's native ones by default, or ROMDEV_WASM_CLANG /
// ROMDEV_WASM_LD), the ares tree scripts/fetch-ares.sh fetched and patched
// (scripts/patches/ares-romdev.patch: nall's platform detection learns
// WebAssembly), and the emscripten sysroot headers of romdev's wasm toolchain
// (scripts/wasm-emcc/fetch-wasm-toolchain.mjs). --check regenerates in memory
// and fails if the committed file differs.
//
// Licence: ares is ISC (Copyright (c) 2004-2025 ares team, Near et al), a
// permissive licence; a cart that contains a unit carries ares's notice
// (romdev's NOTICE has it).
//
// usage: ares-chips.mjs [<ares src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/ares/src (scripts/fetch-ares.sh's clone)
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeModule, unitWat as printUnit } from "./lib/wasm-unit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const buildDir = process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build");
const srcDir = path.resolve(args[0] || path.join(buildDir, "ares", "src"));
const out = args[1] || path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "ares-chips.json");
const glueDir = path.join(here, "ares-chips", "glue");
const sysroot = process.env.ROMDEV_WASM_SYSROOT || path.join(buildDir, "wasm-toolchain", "sysroot");
const WASMOPT = path.join(buildDir, "wasm-toolchain", "node_modules", "binaryen", "bin", "wasm-opt");

const emsdk = process.env.EMSDK || path.join(process.env.HOME || "", "emsdk");
const CLANG = process.env.ROMDEV_WASM_CLANG || path.join(emsdk, "upstream", "bin", "clang++");
const WASMLD = process.env.ROMDEV_WASM_LD || path.join(emsdk, "upstream", "bin", "wasm-ld");
for (const t of [CLANG, WASMLD]) if (!existsSync(t)) throw new Error(`ares-chips: ${t} not found (set EMSDK, or ROMDEV_WASM_CLANG / ROMDEV_WASM_LD)`);
if (!existsSync(WASMOPT)) throw new Error(`ares-chips: no binaryen wasm-opt at ${WASMOPT} (run scripts/wasm-emcc/fetch-wasm-toolchain.mjs)`);
if (!existsSync(path.join(sysroot, "include", "c++", "v1"))) throw new Error(`ares-chips: no emscripten sysroot at ${sysroot} (run scripts/wasm-emcc/fetch-wasm-toolchain.mjs, or set ROMDEV_WASM_SYSROOT)`);
if (!existsSync(path.join(srcDir, "ares", "component", "processor", "upd96050", "upd96050.cpp"))) throw new Error(`ares-chips: no ares source at ${srcDir} (run scripts/fetch-ares.sh first)`);
if (!readFileSync(path.join(srcDir, "nall", "nall", "intrinsics.hpp"), "utf8").includes("ARCHITECTURE_WASM32")) {
  throw new Error(`ares-chips: ${srcDir} lacks scripts/patches/ares-romdev.patch (run scripts/fetch-ares.sh)`);
}

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.ares;
const sha = (t) => createHash("sha256").update(t).digest("hex");

// ares is C++20; nall throws on misuse and std::function on an empty call;
// glue_runtime.cpp traps on any throw, as emscripten's default (exceptions not
// caught) aborts. The emscripten sysroot's compat headers, as emcc adds them.
const CFLAGS = ["--target=wasm32-unknown-emscripten", `--sysroot=${sysroot}`, "-Xclang", "-iwithsysroot/include/compat", "-DEMSCRIPTEN",
  "-O2", "-std=c++20", "-fignore-exceptions", "-fno-threadsafe-statics", "-mcpu=mvp", "-mbulk-memory", "-msign-ext", "-mmutable-globals",
  "-Wno-everything"];
const BASE_A = 0x100000, BASE_B = 0x4100000, DELTA = BASE_B - BASE_A;

/** The units: ares sources (paths in the ares tree) plus the glue. */
const UNITS = {
  necdsp: {
    sources: ["ares/component/processor/upd96050/upd96050.cpp"],
    drivers: ["ares/sfc/coprocessor/necdsp/memory.cpp"],
    glue: ["glue_necdsp.cpp", "glue_runtime.cpp"],
    arena: 64 * 1024, stack: 0x4000,
    exports: ["romdev_necdsp_init", "romdev_necdsp_read", "romdev_necdsp_write", "romdev_necdsp_line", "romdev_necdsp_chipstate", "romdev_unit_arena_used"],
    firmware: 0xd000,
    chipstate: "romdev_necdsp_chipstate",
    probe: (x, fw) => x.romdev_necdsp_init(11, fw),
  },
  armdsp: {
    sources: ["ares/component/processor/arm7tdmi/arm7tdmi.cpp"],
    drivers: ["ares/sfc/coprocessor/armdsp/memory.cpp", "ares/sfc/coprocessor/armdsp/io.cpp"],
    glue: ["glue_armdsp.cpp", "glue_runtime.cpp", "glue_stack.S"],
    // the ARM runs as a cothread, as in ares: romdev's libco backend, and the
    // Asyncify pass over the linked unit (it switches inside the unit)
    libco: true,
    // the ARM's instruction and disassembler tables (one std::function per
    // entry) and its cothread
    arena: 8 * 1024 * 1024, stack: 0x8000,
    exports: ["romdev_armdsp_init", "romdev_armdsp_read", "romdev_armdsp_write", "romdev_armdsp_line", "romdev_armdsp_chipstate", "romdev_unit_arena_used"],
    firmware: 0x28000,
    chipstate: "romdev_armdsp_chipstate",
    probe: (x, fw) => x.romdev_armdsp_init(fw),
  },
};

// ---------------------------------------------------------------- build
function buildUnit(name, u, base) {
  const stage = path.join(buildDir, "ares-chips-stage", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(path.join(stage, "include", "ares"), { recursive: true });
  const glue = {};
  for (const f of readdirSync(glueDir).sort()) {
    copyFileSync(path.join(glueDir, f), path.join(stage, f));
    glue[f] = sha(readFileSync(path.join(glueDir, f)));
  }
  // romdev's stand-in for ares/ares.hpp, found before the ares tree's own
  copyFileSync(path.join(glueDir, "romdev_ares.hpp"), path.join(stage, "include", "ares", "ares.hpp"));
  const objs = [];
  const flags = [...CFLAGS, `-I${path.join(stage, "include")}`, `-I${stage}`, `-I${path.join(srcDir, "nall")}`, `-I${srcDir}`,
    `-I${path.join(srcDir, "ares")}`, `-DROMDEV_UNIT_ARENA=${u.arena}`];
  const libco = u.libco ? [path.join(pkg, "scripts", "patches", "libco-wasm", "libco-wasm.c")] : [];
  if (u.libco) flags.push(`-I${path.join(srcDir, "libco")}`);
  for (const f of [...u.sources.map((s) => path.join(srcDir, s)), ...u.glue.map((g) => path.join(stage, g)), ...libco]) {
    const o = path.join(stage, path.basename(f).replace(/\./g, "_") + ".o");
    execFileSync(CLANG, [...flags, "-c", f, "-o", o], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
    objs.push(o);
  }
  const wasmPath = path.join(stage, `${name}-${base.toString(16)}.wasm`);
  execFileSync(WASMLD, ["--no-entry", "--import-memory", "-O2", "--gc-sections",
    `--global-base=${base}`, "-z", `stack-size=${u.stack}`, ...u.exports.map((e) => `--export=${e}`),
    ...objs, "-o", wasmPath], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
  if (u.libco) {
    // the same transform wasm-emcc gives a module that imports the Asyncify
    // intrinsics (scripts/wasm-emcc/link.mjs inModuleCoroutines), then -O2
    execFileSync(process.execPath, [WASMOPT, "--asyncify", "--pass-arg=asyncify-ignore-imports",
      "--pass-arg=asyncify-removelist@romdev_co_trampoline", "-O2", "--strip-debug", wasmPath, "-o", wasmPath, "--detect-features"],
    { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
  }
  return { bytes: readFileSync(wasmPath), glue };
}

/** The files of the ares tree a unit is built from, for the provenance. */
function aresFiles(u) {
  const files = {};
  const add = (rel) => { const p = path.join(srcDir, rel); if (existsSync(p)) files[rel] = sha(readFileSync(p)); };
  for (const s of u.sources) {
    const dir = path.dirname(s);
    for (const f of readdirSync(path.join(srcDir, dir)).sort()) add(path.join(dir, f));
  }
  for (const f of [...u.drivers, "ares/ares/types.hpp", "nall/nall/intrinsics.hpp", "libco/libco.h", "LICENSE"]) add(f);
  return files;
}

/**
 * The byte length each *_chipstate export writes: the cart's chipstate
 * region is that long. The unit is instantiated (it imports nothing but its
 * memory), the chip initialised with zero firmware, and the export run.
 */
async function chipstateLength(bytes, u) {
  const memory = new WebAssembly.Memory({ initial: (BASE_B + 0x200000) / 0x10000 });
  const mod = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(mod).filter((i) => i.kind !== "memory");
  if (imports.length) throw new Error(`ares-chips: unit imports ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);
  const inst = await WebAssembly.instantiate(mod, { env: { memory } });
  const x = inst.exports;
  if (x.__wasm_call_ctors) throw new Error("ares-chips: unit has static constructors; build every chip object in its init");
  const fw = BASE_A + 0x3000000;
  u.probe(x, fw);
  console.log(`  ${u.chipstate.replace("_chipstate", "")}: arena ${x.romdev_unit_arena_used()} of ${u.arena} bytes in use after init`);
  const len = x[u.chipstate](BASE_A + 0x3100000);
  if (!(len > 0 && len <= 0x10000)) throw new Error(`ares-chips: ${u.chipstate} wrote ${len} bytes`);
  return len;
}

// ---------------------------------------------------------------- main
const clangVersion = execFileSync(CLANG, ["--version"], { encoding: "utf8" }).split("\n")[0];
const units = {};
const provFiles = {}, provGlue = {};
for (const [name, u] of Object.entries(UNITS)) {
  const a = buildUnit(name, u, BASE_A);
  const b = buildUnit(name, u, BASE_B);
  Object.assign(provGlue, a.glue);
  Object.assign(provFiles, aresFiles(u));
  units[name] = printUnit(name, decodeModule(a.bytes), decodeModule(b.bytes), { prefix: "ac", imports: {}, baseA: BASE_A, delta: DELTA });
  units[name].chipstate = { [u.chipstate]: await chipstateLength(a.bytes, u) };
  units[name].firmware = u.firmware;
}
const data = {
  provenance: {
    source: pin?.url ?? "https://github.com/ares-emulator/ares.git",
    commit: pin?.commit ?? null,
    license: "ISC (ares: Copyright (c) 2004-2025 ares team, Near et al); a cart that contains these units carries ares's ISC notice",
    patch: "scripts/patches/ares-romdev.patch",
    files: provFiles,
    glue: provGlue,
    compiler: clangVersion,
    cflags: CFLAGS.filter((f) => !f.startsWith("--sysroot")).join(" "),
    generator: "scripts/recompile-gen/ares-chips.mjs",
    note: "ares's uPD96050 and ARM coprocessors compiled to wasm32 and printed as WAT; @{n} is an address n bytes into the unit's memory",
  },
  units,
};
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`ares-chips: ${out} differs from a fresh generation`); process.exit(1); }
  console.log("ares-chips: up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${Object.entries(units).map(([k, v]) => `${k} ${v.size}B`).join(", ")}`);
}
