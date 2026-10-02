#!/usr/bin/env node
// Compile Genesis Plus GX's SVP chip (cart_hw/svp/svp.c + ssp16.c: the
// SSP1601 DSP interpreter and the SVP memory controller) to wasm32 and write
// it as WAT for the Genesis WAT recompiler
// (src/analysis/recompile/wat/genesis/gpgx-svp.json).
//
// The chip is gpgx's own code, compiled, not re-typed. The sources are
// gpgx's files unchanged; shared.h is a freestanding stand-in declaring the
// gpgx structures they touch (gpgx-svp/shared.h) and gpgx-svp/glue_svp.c
// holds the objects gpgx keeps elsewhere (cart.rom, m68k.memory_map,
// zbank_memory_map) and the entry points gpgx's own callers use. The flags
// are the reference core's (Makefile.libretro, platform=emscripten: -O3
// -DNDEBUG -DLSB_FIRST -DALIGN_LONG -DBYTE_ORDER=LITTLE_ENDIAN).
//
// Two units are written: `svp`, and `svp_break`, the same sources with ONE
// SSP opcode broken (mpya: A += P becomes A += P ^ 1), the must-fail control
// a cart built with options.svpBreak runs. The edit is applied to the staged
// copy only and recorded in the provenance.
//
// Each unit is linked twice at two --global-base values and printed with
// the shared relocation printer (lib/wasm-unit.mjs): an address inside the
// unit's memory is @{offset}, placed by the cart's layout.
//
// Recompile time never needs the gpgx source or a compiler; only this
// script does (emsdk's clang + wasm-ld: $EMSDK/upstream/bin, or
// ROMDEV_WASM_CLANG / ROMDEV_WASM_LD). --check regenerates in memory and
// fails if the committed file differs (same compiler version required: the
// provenance names it).
//
// usage: gpgx-svp.mjs [<gpgx src dir>] [<out.json>] [--check]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/gpgx/src (build-genesis-plus-gx.sh's clone)
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeModule, unitWat } from "./lib/wasm-unit.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const buildDir = process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build");
const srcDir = args[0] || path.join(buildDir, "gpgx", "src");
const out = args[1] || path.join(pkg, "src", "analysis", "recompile", "wat", "genesis", "gpgx-svp.json");
const stubDir = path.join(here, "gpgx-svp");

const emsdk = process.env.EMSDK || path.join(process.env.HOME || "", "emsdk");
const CLANG = process.env.ROMDEV_WASM_CLANG || path.join(emsdk, "upstream", "bin", "clang");
const WASMLD = process.env.ROMDEV_WASM_LD || path.join(emsdk, "upstream", "bin", "wasm-ld");
for (const t of [CLANG, WASMLD]) if (!existsSync(t)) throw new Error(`gpgx-svp: ${t} not found (set EMSDK, or ROMDEV_WASM_CLANG / ROMDEV_WASM_LD)`);

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.genesis_plus_gx;
const sha = (t) => createHash("sha256").update(t).digest("hex");

const CFLAGS = ["--target=wasm32", "-O3", "-ffreestanding", "-mcpu=mvp", "-mbulk-memory", "-msign-ext", "-mmutable-globals",
  "-DNDEBUG", "-DLSB_FIRST", "-DALIGN_LONG", "-DBYTE_ORDER=LITTLE_ENDIAN", "-Wno-everything", "-I."];
const BASE_A = 0x100000, BASE_B = 0x500000, DELTA = BASE_B - BASE_A;
const SVP = "core/cart_hw/svp";
const SOURCES = ["svp.c", "ssp16.c"];
const HEADERS = ["svp.h", "ssp16.h"];
const EXPORTS = ["romdev_svp_init", "romdev_svp_reset", "romdev_svp_run", "romdev_svp_state", "romdev_svp_ssp_size",
  "romdev_svp_read8", "romdev_svp_read16", "romdev_svp_write8", "romdev_svp_write16",
  "romdev_svp_ctrl_r8", "romdev_svp_ctrl_r16", "romdev_svp_ctrl_w16"];

/** The must-fail control's one edit to ssp16.c (mpya: A += P). */
const BREAK = { file: "ssp16.c", from: "rA32 += rP.v; /* confirmed to be 32bit */", to: "rA32 += rP.v ^ 1; /* confirmed to be 32bit */" };

function buildUnit(name, base, broken) {
  const stage = path.join(buildDir, "gpgx-svp-stage", name);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const files = {};
  for (const f of [...SOURCES, ...HEADERS]) {
    const dst = path.join(stage, f);
    copyFileSync(path.join(srcDir, SVP, f), dst);
    files[`${SVP}/${f}`] = sha(readFileSync(dst));
  }
  if (broken) {
    const p = path.join(stage, BREAK.file);
    const t = readFileSync(p, "utf8");
    if (t.split(BREAK.from).length !== 2) throw new Error(`gpgx-svp: ${BREAK.file} no longer holds exactly one '${BREAK.from}'`);
    writeFileSync(p, t.replace(BREAK.from, BREAK.to));
  }
  const stubs = {};
  for (const f of ["shared.h", "glue_svp.c"]) {
    copyFileSync(path.join(stubDir, f), path.join(stage, f));
    stubs[f] = sha(readFileSync(path.join(stubDir, f)));
  }
  const objs = [];
  for (const f of [...SOURCES, "glue_svp.c"]) {
    const o = path.join(stage, f.replace(/[/.]/g, "_") + ".o");
    execFileSync(CLANG, [...CFLAGS, "-c", f, "-o", o], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
    objs.push(o);
  }
  const wasmPath = path.join(stage, `${name}-${base.toString(16)}.wasm`);
  execFileSync(WASMLD, ["--no-entry", "--import-memory", "--allow-undefined", "-O2", "--gc-sections",
    `--global-base=${base}`, "-z", "stack-size=4096", ...EXPORTS.map((e) => `--export=${e}`),
    ...objs, "-o", wasmPath], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
  return { bytes: readFileSync(wasmPath), files, stubs };
}

/**
 * Where the svp_t sits in the unit's memory and its field sizes, read by
 * running link A: romdev_svp_init(rom, 0) then romdev_svp_state().
 */
async function layoutOf(bytes) {
  const memory = new WebAssembly.Memory({ initial: (BASE_A >> 16) + 64 });
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
  const e = instance.exports;
  e.romdev_svp_init(0, 0);
  const svp = e.romdev_svp_state() >>> 0;
  return { svp: svp - BASE_A, iram: 0, iramSize: 0x800, dram: 0x20000, dramSize: 0x20000, ssp: 0x40000, sspSize: e.romdev_svp_ssp_size() };
}

const clangVersion = execFileSync(CLANG, ["--version"], { encoding: "utf8" }).split("\n")[0];
const units = {};
let provFiles = {}, provStubs = {}, layout = null;
for (const [name, broken] of [["svp", false], ["svp_break", true]]) {
  const a = buildUnit(name, BASE_A, broken);
  const b = buildUnit(name, BASE_B, broken);
  if (!broken) { provFiles = a.files; provStubs = a.stubs; layout = await layoutOf(a.bytes); }
  units[name] = unitWat(name, decodeModule(a.bytes), decodeModule(b.bytes), { prefix: "g", baseA: BASE_A, delta: DELTA });
}
const data = {
  provenance: {
    source: pin?.url ?? "https://github.com/libretro/genesis-plus-gx.git",
    commit: pin?.commit ?? null,
    license: "Genesis Plus GX / SVP code by notaz: free for non-commercial use only",
    files: provFiles,
    glue: provStubs,
    compiler: clangVersion,
    cflags: CFLAGS.join(" "),
    generator: "scripts/recompile-gen/gpgx-svp.mjs",
    brokenControl: { unit: "svp_break", file: `${SVP}/${BREAK.file}`, from: BREAK.from, to: BREAK.to },
    note: "gpgx's SVP sources compiled to wasm32 and printed as WAT; @{n} is an address n bytes into the unit's memory",
  },
  // offsets into the unit's memory: the svp_t and its iram_rom / dram / ssp1601 fields
  layout,
  units,
};
const text = JSON.stringify(data, null, 1) + "\n";
if (check) {
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error(`gpgx-svp: ${out} differs from a fresh generation`); process.exit(1); }
  console.log("gpgx-svp: up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${Object.entries(units).map(([k, v]) => `${k} ${v.size}B`).join(", ")}; svp_t at +0x${layout.svp.toString(16)}, ssp1601_t ${layout.sspSize}B`);
}
