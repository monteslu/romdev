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
    exports: ["romdev_dsp_init", "romdev_dsp_reset", "romdev_dsp_get", "romdev_dsp_set", "romdev_set_openbus", "romdev_dsp3_chipstate"],
  },
  seta: {
    sources: ["seta.cpp", "seta010.cpp", "seta011.cpp"], headers: [],
    glue: "glue_seta.cpp", stack: 0x4000,
    exports: ["romdev_seta_init", "romdev_seta_get", "romdev_seta_set", "romdev_set_openbus", "romdev_st011_chipstate"],
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

// ---------------------------------------------------------------- decode
const VT = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x70: "funcref", 0x6f: "externref" };
const NUM = {};
"i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub f64.mul f64.div f64.min f64.max f64.copysign i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s"
  .split(" ").forEach((n, i) => { NUM[0x45 + i] = n; });
const MEM = {};
"i32.load i64.load f32.load f64.load i32.load8_s i32.load8_u i32.load16_s i32.load16_u i64.load8_s i64.load8_u i64.load16_s i64.load16_u i64.load32_s i64.load32_u i32.store i64.store f32.store f64.store i32.store8 i32.store16 i64.store8 i64.store16 i64.store32"
  .split(" ").forEach((n, i) => { MEM[0x28 + i] = n; });
const FC = { 0: "i32.trunc_sat_f32_s", 1: "i32.trunc_sat_f32_u", 2: "i32.trunc_sat_f64_s", 3: "i32.trunc_sat_f64_u",
  4: "i64.trunc_sat_f32_s", 5: "i64.trunc_sat_f32_u", 6: "i64.trunc_sat_f64_s", 7: "i64.trunc_sat_f64_u" };

class Reader {
  constructor(b, p = 0, end = b.length) { this.b = b; this.p = p; this.end = end; }
  u8() { if (this.p >= this.end) throw new Error("snes9x-chips: read past end"); return this.b[this.p++]; }
  u32() { let r = 0, s = 0, c; do { c = this.u8(); r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return r >>> 0; }
  s32() { let r = 0, s = 0, c; do { c = this.u8(); r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); if (s < 32 && (c & 0x40)) r |= -1 << s; return r | 0; }
  s64() { let r = 0n, s = 0n, c; do { c = this.u8(); r |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80); if (s < 64n && (c & 0x40)) r |= -1n << s; return BigInt.asIntN(64, r); }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  name() { return Buffer.from(this.bytes(this.u32())).toString("utf8"); }
  vt() { const t = VT[this.u8()]; if (!t) throw new Error("snes9x-chips: unknown value type"); return t; }
  limits() { const f = this.u8(); const min = this.u32(); const max = f & 1 ? this.u32() : null; return { min, max }; }
}

/** One instruction list per function: {op, imm[]} with immediates kept raw. */
function decodeModule(bytes) {
  const r = new Reader(bytes);
  if (r.u32() !== 0x6d736100 >>> 0 && false) throw new Error("bad magic");
  r.p = 8;
  const m = { types: [], imports: [], funcTypes: [], tables: [], globals: [], exports: [], start: null, elems: [], codes: [], datas: [] };
  const constExpr = (rr) => {
    const op = rr.u8();
    let v;
    if (op === 0x41) v = { t: "i32", v: rr.s32() };
    else if (op === 0x42) v = { t: "i64", v: rr.s64() };
    else if (op === 0x23) v = { t: "global", v: rr.u32() };
    else throw new Error(`snes9x-chips: const expr op 0x${op.toString(16)}`);
    if (rr.u8() !== 0x0b) throw new Error("snes9x-chips: const expr end");
    return v;
  };
  while (r.p < bytes.length) {
    const id = r.u8(), size = r.u32(), end = r.p + size;
    const s = new Reader(bytes, r.p, end);
    switch (id) {
      case 0: break;
      case 1: for (let n = s.u32(); n--;) {
        if (s.u8() !== 0x60) throw new Error("snes9x-chips: non-func type");
        const params = []; for (let k = s.u32(); k--;) params.push(s.vt());
        const results = []; for (let k = s.u32(); k--;) results.push(s.vt());
        m.types.push({ params, results });
      } break;
      case 2: for (let n = s.u32(); n--;) {
        const mod = s.name(), nm = s.name(), kind = s.u8();
        if (kind === 0) m.imports.push({ mod, name: nm, kind: "func", type: s.u32() });
        else if (kind === 2) { s.limits(); m.imports.push({ mod, name: nm, kind: "memory" }); }
        else throw new Error(`snes9x-chips: import kind ${kind} (${mod}.${nm})`);
      } break;
      case 3: for (let n = s.u32(); n--;) m.funcTypes.push(s.u32()); break;
      case 4: for (let n = s.u32(); n--;) { const t = s.vt(); m.tables.push({ t, ...s.limits() }); } break;
      case 5: s.u32(); s.limits(); break;
      case 6: for (let n = s.u32(); n--;) { const t = s.vt(); const mut = s.u8(); m.globals.push({ t, mut, init: constExpr(s) }); } break;
      case 7: for (let n = s.u32(); n--;) { const nm = s.name(); const kind = s.u8(); m.exports.push({ name: nm, kind, idx: s.u32() }); } break;
      case 8: m.start = s.u32(); break;
      case 9: for (let n = s.u32(); n--;) {
        const flags = s.u32();
        if (flags !== 0) throw new Error(`snes9x-chips: elem segment flags ${flags}`);
        const off = constExpr(s); const fns = []; for (let k = s.u32(); k--;) fns.push(s.u32());
        m.elems.push({ off: off.v, fns });
      } break;
      case 10: for (let n = s.u32(); n--;) {
        const sz = s.u32(), fend = s.p + sz;
        const fr = new Reader(bytes, s.p, fend);
        const locals = []; for (let k = fr.u32(); k--;) { const c = fr.u32(); const t = fr.vt(); for (let j = 0; j < c; j++) locals.push(t); }
        m.codes.push({ locals, ins: decodeExpr(fr) });
        s.p = fend;
      } break;
      case 11: for (let n = s.u32(); n--;) {
        const flags = s.u32();
        if (flags === 0) { const off = constExpr(s); m.datas.push({ off: off.v, bytes: s.bytes(s.u32()) }); }
        else if (flags === 1) m.datas.push({ off: null, bytes: s.bytes(s.u32()) });
        else throw new Error(`snes9x-chips: data segment flags ${flags}`);
      } break;
      case 12: break;
      default: throw new Error(`snes9x-chips: section ${id}`);
    }
    r.p = end;
  }
  return m;
}

function decodeExpr(r) {
  const ins = [];
  let depth = 1;
  const bt = () => {
    const c = r.b[r.p];
    if (c === 0x40) { r.p++; return ""; }
    if (VT[c]) { r.p++; return `(result ${VT[c]})`; }
    throw new Error("snes9x-chips: type-index block types are not supported");
  };
  while (depth > 0) {
    const op = r.u8();
    if (op === 0x02 || op === 0x03 || op === 0x04) { ins.push({ op: ["block", "loop", "if"][op - 2], bt: bt() }); depth++; continue; }
    if (op === 0x0b) { depth--; if (depth > 0) ins.push({ op: "end" }); continue; }
    if (op === 0x05) { ins.push({ op: "else" }); continue; }
    if (op === 0x00) { ins.push({ op: "unreachable" }); continue; }
    if (op === 0x01) { ins.push({ op: "nop" }); continue; }
    if (op === 0x0c || op === 0x0d) { ins.push({ op: op === 0x0c ? "br" : "br_if", n: r.u32() }); continue; }
    if (op === 0x0e) { const ls = []; for (let k = r.u32(); k--;) ls.push(r.u32()); ins.push({ op: "br_table", ls, d: r.u32() }); continue; }
    if (op === 0x0f) { ins.push({ op: "return" }); continue; }
    if (op === 0x10) { ins.push({ op: "call", f: r.u32() }); continue; }
    if (op === 0x11) { const t = r.u32(); const tab = r.u32(); ins.push({ op: "call_indirect", t, tab }); continue; }
    if (op === 0x1a) { ins.push({ op: "drop" }); continue; }
    if (op === 0x1b) { ins.push({ op: "select" }); continue; }
    if (op === 0x1c) { const n = r.u32(); const ts = []; for (let k = 0; k < n; k++) ts.push(r.vt()); ins.push({ op: "select_t", ts }); continue; }
    if (op >= 0x20 && op <= 0x22) { ins.push({ op: ["local.get", "local.set", "local.tee"][op - 0x20], n: r.u32() }); continue; }
    if (op === 0x23 || op === 0x24) { ins.push({ op: op === 0x23 ? "global.get" : "global.set", g: r.u32() }); continue; }
    if (MEM[op]) { const align = r.u32(); if (align & 0x40) throw new Error("snes9x-chips: multi-memory memarg"); ins.push({ op: MEM[op], align, off: r.u32() }); continue; }
    if (op === 0x3f || op === 0x40) { r.u8(); ins.push({ op: op === 0x3f ? "memory.size" : "memory.grow" }); continue; }
    if (op === 0x41) { ins.push({ op: "i32.const", v: r.s32() }); continue; }
    if (op === 0x42) { ins.push({ op: "i64.const", v: r.s64() }); continue; }
    if (op === 0x43) { const b = r.bytes(4); ins.push({ op: "f32.bits", v: (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) | 0 }); continue; }
    if (op === 0x44) { const b = r.bytes(8); let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[k]); ins.push({ op: "f64.bits", v: BigInt.asIntN(64, v) }); continue; }
    if (NUM[op]) { ins.push({ op: NUM[op] }); continue; }
    if (op === 0xfc) {
      const sub = r.u32();
      if (FC[sub]) { ins.push({ op: FC[sub] }); continue; }
      if (sub === 10) { r.u8(); r.u8(); ins.push({ op: "memory.copy" }); continue; }
      if (sub === 11) { r.u8(); ins.push({ op: "memory.fill" }); continue; }
      throw new Error(`snes9x-chips: 0xFC ${sub}`);
    }
    throw new Error(`snes9x-chips: opcode 0x${op.toString(16)}`);
  }
  return ins;
}

// ---------------------------------------------------------------- relocate + print
/**
 * Print one function body from the two links. A constant or offset that
 * moved by exactly DELTA is an address in the unit's memory: @{A - BASE_A}.
 */
function printBody(a, b, names) {
  if (a.ins.length !== b.ins.length) throw new Error(`snes9x-chips: ${names.fn}: instruction counts differ between links`);
  const lines = [];
  let indent = 1;
  for (let i = 0; i < a.ins.length; i++) {
    const x = a.ins[i], y = b.ins[i];
    if (x.op !== y.op) throw new Error(`snes9x-chips: ${names.fn}: op ${i} differs between links`);
    const addr = (va, vb, what) => {
      if (va === vb) return String(va);
      if (vb - va !== DELTA) throw new Error(`snes9x-chips: ${names.fn}: ${what} ${va} vs ${vb} is not an address`);
      return `@{${va - BASE_A}}`;
    };
    let t;
    switch (x.op) {
      case "block": case "loop": case "if": t = `${x.op}${x.bt ? " " + x.bt : ""}`; break;
      case "end": case "else": indent--; t = x.op; break;
      case "br": case "br_if": t = `${x.op} ${x.n}`; break;
      case "br_table": t = `br_table ${x.ls.join(" ")} ${x.d}`; break;
      case "call": t = `call ${names.func(x.f)}`; break;
      case "call_indirect": t = `call_indirect ${names.table(x.tab)} (type ${names.type(x.t)})`; break;
      case "select_t": t = `select (result ${x.ts.join(" ")})`; break;
      case "local.get": case "local.set": case "local.tee": t = `${x.op} ${x.n}`; break;
      case "global.get": case "global.set": t = `${x.op} ${names.global(x.g)}`; break;
      case "i32.const": t = `i32.const ${addr(x.v, y.v, "i32.const")}`; break;
      case "i64.const": if (x.v !== y.v) throw new Error(`snes9x-chips: ${names.fn}: i64 constant moved`); t = `i64.const ${x.v}`; break;
      case "f32.bits": t = `i32.const ${x.v}\n    f32.reinterpret_i32`; break;
      case "f64.bits": t = `i64.const ${x.v}\n    f64.reinterpret_i64`; break;
      default:
        if (x.off !== undefined) {
          const o = addr(x.off, y.off, "memarg offset");
          t = `${x.op}${o !== "0" ? ` offset=${o}` : ""} align=${1 << x.align}`;
        } else t = x.op;
    }
    lines.push("    " + "  ".repeat(Math.max(0, indent - 1)) + t);
    if (x.op === "block" || x.op === "loop" || x.op === "if" || x.op === "else") indent++;
  }
  return lines.join("\n");
}

function unitWat(name, A, B) {
  const P = `c_${name}`;
  const nImp = A.imports.filter((i) => i.kind === "func").length;
  const impFuncs = A.imports.filter((i) => i.kind === "func");
  const u = UNITS[name];
  const exportName = {};
  for (const e of A.exports) if (e.kind === 0) exportName[e.idx] = e.name;
  const fname = (f) => {
    if (f < nImp) {
      const imp = impFuncs[f];
      const alias = u.imports?.[imp.name];
      if (!alias) throw new Error(`snes9x-chips: ${name}: undefined symbol ${imp.name} has no cart import`);
      return `$chip_${alias}`;
    }
    return exportName[f] ? `$${P}_${exportName[f]}` : `$${P}_f${f}`;
  };
  const names = {
    fn: "", func: fname, global: (g) => `$${P}_g${g}`, table: () => `$${P}_tab`, type: (t) => `$${P}_t${t}`,
  };
  const types = A.types.map((t, i) => `  (type $${P}_t${i} (func${t.params.length ? ` (param ${t.params.join(" ")})` : ""}${t.results.length ? ` (result ${t.results.join(" ")})` : ""}))`);
  const funcs = [];
  for (let i = 0; i < A.codes.length; i++) {
    const fi = nImp + i;
    names.fn = `${name} ${fname(fi)}`;
    const ty = A.types[A.funcTypes[i]];
    const sig = ty.params.map((p) => ` (param ${p})`).join("") + (ty.results.length ? ` (result ${ty.results.join(" ")})` : "");
    const loc = A.codes[i].locals.length ? `\n    (local ${A.codes[i].locals.join(" ")})` : "";
    funcs.push(`  (func ${fname(fi)}${sig}${loc}\n${printBody(A.codes[i], B.codes[i], names)})`);
  }
  const globals = A.globals.map((g, i) => {
    const gb = B.globals[i];
    let init;
    if (g.init.t === "i32") init = g.init.v === gb.init.v ? String(g.init.v) : (gb.init.v - g.init.v === DELTA ? `@{${g.init.v - BASE_A}}` : null);
    else throw new Error(`snes9x-chips: ${name}: global ${i} init ${g.init.t}`);
    if (init === null) throw new Error(`snes9x-chips: ${name}: global ${i} init is not an address`);
    return `  (global $${P}_g${i} ${g.mut ? `(mut ${g.t})` : g.t} (i32.const ${init}))`;
  });
  let table = null;
  if (A.tables.length) {
    if (A.tables.length !== 1) throw new Error(`snes9x-chips: ${name}: ${A.tables.length} tables`);
    const t = A.tables[0];
    const elems = A.elems.map((e) => `  (elem (table $${P}_tab) (i32.const ${e.off}) func ${e.fns.map(fname).join(" ")})`);
    table = `  (table $${P}_tab ${t.min}${t.max != null ? " " + t.max : ""} funcref)\n` + elems.join("\n");
  }
  // data: active segments at @{off}; pointer words that moved are relocated
  const data = A.datas.map((d, i) => {
    const e = B.datas[i];
    if (d.off === null || e.off - d.off !== DELTA) throw new Error(`snes9x-chips: ${name}: data segment ${i} is not placed at the base`);
    if (d.bytes.length !== e.bytes.length) throw new Error(`snes9x-chips: ${name}: data segment ${i} length differs`);
    const relocs = [];
    for (let k = 0; k < d.bytes.length; k++) {
      if (d.bytes[k] === e.bytes[k]) continue;
      const w = k & ~3;
      const va = new DataView(d.bytes.buffer, d.bytes.byteOffset + w, 4).getUint32(0, true);
      const vb = new DataView(e.bytes.buffer, e.bytes.byteOffset + w, 4).getUint32(0, true);
      if (vb - va !== DELTA) throw new Error(`snes9x-chips: ${name}: data word at +${w} is not an address`);
      if (!relocs.some((r) => r.at === w)) relocs.push({ at: w, rel: va - BASE_A });
      k = w + 3;
    }
    return { off: d.off - BASE_A, hex: Buffer.from(d.bytes).toString("hex"), relocs };
  });
  const sp = A.globals.findIndex((g, i) => g.mut && B.globals[i].init.v - g.init.v === DELTA);
  const top = sp >= 0 ? A.globals[sp].init.v - BASE_A : Math.max(0, ...data.map((d) => d.off + d.hex.length / 2));
  const exports = Object.fromEntries(A.exports.filter((e) => e.kind === 0).map((e) => [e.name, fname(e.idx)]));
  return {
    prefix: P,
    size: (top + 15) & ~15,
    types: types.join("\n"),
    table,
    globals: globals.join("\n"),
    funcs: funcs.join("\n"),
    data,
    exports,
    start: A.start !== null ? fname(A.start) : null,
    imports: impFuncs.map((f) => ({ name: f.name, as: `$chip_${u.imports[f.name]}`, params: A.types[f.type].params, results: A.types[f.type].results })),
  };
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
  units[name] = unitWat(name, decodeModule(a.bytes), decodeModule(b.bytes));
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
