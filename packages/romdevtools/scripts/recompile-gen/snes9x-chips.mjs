#!/usr/bin/env node
// Compile snes9x's coprocessor / add-on sources to wasm32 and write them as
// WAT for the SNES WAT recompiler (src/analysis/recompile/wat/snes/snes9x-chips.json).
//
// The chips are snes9x's own code, compiled, not re-typed: dsp.cpp and
// dsp1-4.cpp (the DSP-1/2/3/4 HLE), seta.cpp + seta010.cpp + seta011.cpp
// (ST010 / ST011), obc1.cpp, srtc.cpp (with srtcemu.cpp), msu1.cpp (with
// apu/resampler.h) and bsx.cpp. Each unit is those files plus a small glue
// file (snes9x-chips/glue_*.cpp) that holds the objects snes9x keeps in
// globals.cpp / memmap.cpp and exposes the entry points snes9x's own
// callers use (getset.h's MAP_* cases, ppu.cpp's register cases, cpu.cpp
// S9xReset, memmap.cpp InitROM). The headers the sources include are
// snes9x's, except snes9x.h / memmap.h / display.h and a few C++ headers,
// which are freestanding stand-ins (snes9x-chips/include) declaring the
// fields the chips touch.
//
// The DSP-1, DSP-3 and ST010 data ROM tables in dsp1.cpp, dsp3.cpp and
// seta010.cpp are emptied before compiling (snes9x-chips/hle-data.mjs); the
// cart fills them from the user's data ROM (glue/romdev_hledata.h).
//
// Each unit is linked twice at two different --global-base values. A value
// that differs between the two links by exactly the base difference is an
// address inside the unit's own memory (an i32.const, a load/store offset,
// a global's init, a data word); it is written as @{offset} and the cart
// places the unit's memory wherever its layout puts it. Everything else is
// byte-identical between the links. The unit's imports (time(), the MSU-1
// file reads, the BS-X map sink) are functions the cart provides.
//
// Recompile time never needs the snes9x source or a compiler; only this
// script does (emsdk's clang + wasm-ld: $EMSDK/upstream/bin, or
// ROMDEV_WASM_CLANG / ROMDEV_WASM_LD). --check regenerates in memory and
// fails if the committed file differs (same compiler version required: the
// provenance names it).
//
// usage: snes9x-chips.mjs [<snes9x src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/snes9x/src (build-snes9x.sh's clone)
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeModule, unitWat as printUnit } from "./lib/wasm-unit.mjs";
import { HLE_TABLES, stripHleData } from "./snes9x-chips/hle-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const buildDir = process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build");
const srcDir = args[0] || path.join(buildDir, "snes9x", "src");
const out = args[1] || path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "snes9x-chips.json");
const stubDir = path.join(here, "snes9x-chips");

const emsdk = process.env.EMSDK || path.join(process.env.HOME || "", "emsdk");
const CLANG = process.env.ROMDEV_WASM_CLANG || path.join(emsdk, "upstream", "bin", "clang++");
const WASMLD = process.env.ROMDEV_WASM_LD || path.join(emsdk, "upstream", "bin", "wasm-ld");
for (const t of [CLANG, WASMLD]) if (!existsSync(t)) throw new Error(`snes9x-chips: ${t} not found (set EMSDK, or ROMDEV_WASM_CLANG / ROMDEV_WASM_LD)`);

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.snes9x ?? versions.snes9x;
const sha = (t) => createHash("sha256").update(t).digest("hex");

const CFLAGS = ["--target=wasm32", "-O2", "-std=c++11", "-ffreestanding", "-fno-exceptions", "-fno-rtti",
  "-fno-threadsafe-statics", "-mcpu=mvp", "-mbulk-memory", "-msign-ext", "-mmutable-globals", "-Wno-everything", "-I."];
const BASE_A = 0x100000, BASE_B = 0x300000, DELTA = BASE_B - BASE_A;

/** The standard headers every unit sees (snes9x.h's stand-in includes them). */
const COMMON_HEADERS = ["dsp.h", "seta.h", "obc1.h"];

/**
 * The units. `sources` are snes9x files compiled as they are; `headers`
 * are snes9x headers they include; `glue` is ours. `imports` names the cart
 * function each undefined symbol becomes.
 */
const UNITS = {
  dsp: {
    sources: ["dsp.cpp", "dsp1.cpp", "dsp2.cpp", "dsp3.cpp", "dsp4.cpp"], headers: [],
    glue: "glue_dsp.cpp", stack: 0x4000,
    exports: ["romdev_dsp_init", "romdev_dsp_reset", "romdev_dsp_get", "romdev_dsp_set", "romdev_set_openbus", "romdev_dsp3_chipstate", "romdev_dsp_hledata"],
  },
  seta: {
    sources: ["seta.cpp", "seta010.cpp", "seta011.cpp"], headers: [],
    glue: "glue_seta.cpp", stack: 0x4000,
    exports: ["romdev_seta_init", "romdev_seta_get", "romdev_seta_set", "romdev_set_openbus", "romdev_st011_chipstate", "romdev_seta_hledata"],
  },
  st018: {
    sources: ["seta018.cpp"], headers: [],
    glue: "glue_st018.cpp", stack: 0x1000,
    exports: ["romdev_st018_bind", "romdev_st018_get", "romdev_st018_set", "romdev_set_openbus", "romdev_st018_chipstate"],
  },
  obc1: {
    sources: ["obc1.cpp"], headers: [],
    glue: "glue_obc1.cpp", stack: 0x1000,
    exports: ["romdev_obc1_bind", "romdev_obc1_reset", "romdev_obc1_get", "romdev_obc1_set", "romdev_set_openbus"],
  },
  srtc: {
    sources: ["srtc.cpp"], headers: ["srtc.h", "srtcemu.h", "srtcemu.cpp"],
    glue: "glue_srtc.cpp", stack: 0x1000,
    exports: ["romdev_srtc_init", "romdev_srtc_reset", "romdev_srtc_get", "romdev_srtc_set", "romdev_set_openbus", "romdev_srtc_chipstate", "romdev_srtc_rtcdata"],
    imports: { time: "time" },
  },
  msu1: {
    sources: ["msu1.cpp"], headers: ["msu1.h", "apu/resampler.h"],
    glue: "glue_msu1.cpp", stack: 0x1000,
    // the reference's float -> int conversions are the saturating ones (see cx4)
    cflags: ["-mnontrapping-fptoint"],
    exports: ["romdev_msu_init", "romdev_msu_enabled", "romdev_msu_read", "romdev_msu_write", "romdev_msu_generate",
      "romdev_msu_avail", "romdev_msu_mix"],
  },
  bsx: {
    sources: ["bsx.cpp"], headers: ["bsx.h"],
    glue: "glue_bsx.cpp", stack: 0x1000,
    // getset.h brings bsx.h in through memmap.h in snes9x; the libc calls it makes
    cflags: ["-include", "snes9x.h", "-include", "bsx.h", "-include", "glue_bsx_libc.h"],
    exports: ["romdev_bsx_init", "romdev_bsx_active", "romdev_bsx_reset", "romdev_bsx_get", "romdev_bsx_set",
      "romdev_bsx_ppu_get", "romdev_bsx_ppu_set", "romdev_bsx_chipstate"],
    imports: { time: "time" },
  },
  // (sdd1.js / spc7110.js / cx4.js) `cflags` are added to CFLAGS for the
  // unit, `libs` are linked after its objects
  sdd1: {
    sources: ["sdd1emu.cpp"], headers: ["sdd1emu.h"],
    glue: "glue_sdd1.cpp", stack: 0x1000,
    exports: ["romdev_sdd1_buffer", "romdev_sdd1_decompress"],
  },
  spc7110: {
    sources: ["spc7110.cpp"], headers: ["spc7110.h", "spc7110emu.h", "spc7110emu.cpp", "spc7110dec.h", "spc7110dec.cpp", "srtc.h"],
    glue: "glue_spc7110.cpp", stack: 0x1000,
    // memmap.h -> getset.h brings spc7110.h into spc7110.cpp in snes9x
    cflags: ["-include", "snes9x.h", "-include", "spc7110.h"],
    exports: ["romdev_spc7110_init", "romdev_spc7110_reset", "romdev_spc7110_get", "romdev_spc7110_set", "romdev_spc7110_offset", "romdev_spc7110_dma", "romdev_set_openbus", "romdev_spc7110_chipstate", "romdev_spc7110_rtcdata"],
    imports: { time: "time" },
  },
  cx4: {
    sources: ["c4.cpp", "c4emu.cpp"], headers: ["c4.h", "sar.h"],
    glue: "glue_cx4.cpp", stack: 0x1000,
    // the reference core's clang (emscripten 4.0) converts float to int with
    // the saturating instructions (nontrapping-fptoint is on by default), and
    // memmap.h -> getset.h brings c4.h into c4.cpp / c4emu.cpp in snes9x
    cflags: ["-mnontrapping-fptoint", "-include", "snes9x.h", "-include", "memmap.h", "-include", "c4.h"],
    // sin / cos / atan: emscripten's own libc (musl), as the reference links them
    libs: [path.join(emsdk, "upstream", "emscripten", "cache", "sysroot", "lib", "wasm32-emscripten", "libc.a")],
    exports: ["romdev_c4_init", "romdev_c4_get", "romdev_c4_set"],
  },
};

// ---------------------------------------------------------------- build
function buildUnit(name, u, base) {
  const stage = path.join(buildDir, "snes9x-chips-stage", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const files = {};
  for (const f of [...u.sources, ...u.headers, ...COMMON_HEADERS]) {
    const dst = path.join(stage, f);
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(path.join(srcDir, f), dst);
    files[f] = sha(readFileSync(dst));
    // the chips' data ROM tables are emptied before anything is compiled
    // (snes9x-chips/hle-data.mjs): the units carry none of that data
    if (HLE_TABLES[f]) writeFileSync(dst, stripHleData(f, readFileSync(dst, "utf8")));
  }
  const stubs = {};
  for (const sub of ["include", "glue"]) {
    for (const f of listDir(path.join(stubDir, sub))) {
      mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
      copyFileSync(path.join(stubDir, sub, f), path.join(stage, f));
      stubs[`${sub}/${f}`] = sha(readFileSync(path.join(stubDir, sub, f)));
    }
  }
  const objs = [];
  for (const f of [...u.sources, u.glue]) {
    const o = path.join(stage, f.replace(/[/.]/g, "_") + ".o");
    execFileSync(CLANG, [...CFLAGS, ...(u.cflags ?? []), "-c", f, "-o", o], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
    objs.push(o);
  }
  const wasmPath = path.join(stage, `${name}-${base.toString(16)}.wasm`);
  execFileSync(WASMLD, ["--no-entry", "--import-memory", "--allow-undefined", "-O2", "--gc-sections",
    `--global-base=${base}`, "-z", `stack-size=${u.stack}`, ...u.exports.map((e) => `--export=${e}`),
    ...objs, ...(u.libs ?? []), "-o", wasmPath], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
  return { bytes: readFileSync(wasmPath), files, stubs };
}

/** Every file under `d`, as sorted paths relative to it (include/ has subdirectories). */
function listDir(d) {
  if (!existsSync(d)) return [];
  return readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(d, path.join(e.parentPath ?? e.path, e.name))).sort();
}

/**
 * The byte length each *_chipstate export writes (romdev_chipstate.h): the
 * cart's chipstate region is that long. The functions copy fixed fields, so
 * running them once on the unlinked unit (imports stubbed) gives the length.
 * @param {Uint8Array} bytes  the unit linked at BASE_A
 * @param {any} u
 */
async function chipstateLengths(bytes, u) {
  const names = u.exports.filter((e) => e.endsWith("_chipstate"));
  if (!names.length) return null;
  const memory = new WebAssembly.Memory({ initial: (BASE_B + 0x200000) / 0x10000 });
  const mod = await WebAssembly.compile(bytes);
  const env = { memory };
  for (const imp of WebAssembly.Module.imports(mod)) if (imp.kind === "function") env[imp.name] = () => 0;
  const inst = await WebAssembly.instantiate(mod, { env });
  const out = {};
  for (const n of names) {
    const len = inst.exports[n](BASE_B);
    if (!(len > 0 && len <= 0x10000)) throw new Error(`snes9x-chips: ${n} wrote ${len} bytes`);
    out[n] = len;
  }
  return out;
}

// ---------------------------------------------------------------- main
const clangVersion = execFileSync(CLANG, ["--version"], { encoding: "utf8" }).split("\n")[0];
const units = {};
const provFiles = {}, provStubs = {};
for (const [name, u] of Object.entries(UNITS)) {
  const a = buildUnit(name, u, BASE_A);
  const b = buildUnit(name, u, BASE_B);
  Object.assign(provFiles, a.files);
  Object.assign(provStubs, a.stubs);
  units[name] = printUnit(name, decodeModule(a.bytes), decodeModule(b.bytes), { imports: u.imports ?? {}, baseA: BASE_A, delta: DELTA });
  const cs = await chipstateLengths(a.bytes, u);
  if (cs) units[name].chipstate = cs;
}
const data = {
  provenance: {
    source: pin?.url ?? "https://github.com/libretro/snes9x.git",
    commit: pin?.commit ?? pin?.ref ?? null,
    files: provFiles,
    glue: provStubs,
    compiler: clangVersion,
    cflags: CFLAGS.join(" "),
    generator: "scripts/recompile-gen/snes9x-chips.mjs",
    hleData: { transform: "scripts/recompile-gen/snes9x-chips/hle-data.mjs", sha256: sha(readFileSync(path.join(stubDir, "hle-data.mjs"))), note: "the DSP-1, DSP-3 and ST010 data ROM tables are emptied before compiling; a cart fills them from the user's data ROM" },
    note: "snes9x's coprocessor sources compiled to wasm32 and printed as WAT; @{n} is an address n bytes into the unit's memory",
  },
  units,
};
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`snes9x-chips: ${out} differs from a fresh generation`); process.exit(1); }
  console.log("snes9x-chips: up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${Object.entries(units).map(([k, v]) => `${k} ${v.size}B`).join(", ")}`);
}
