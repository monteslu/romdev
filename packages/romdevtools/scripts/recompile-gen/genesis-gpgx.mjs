#!/usr/bin/env node
// Generate the gpgx-derived data the Genesis WAT backend specialises from.
//
//   node scripts/recompile-gen/genesis-gpgx.mjs [<gpgx-src-dir>] [<out.json.gz>] [--check]
//
// <gpgx-src-dir> is the PATCHED genesis_plus_gx tree romdev builds its core
// from (scripts/build-genesis-plus-gx.sh leaves it at
// ${ROMDEV_BUILD_DIR:-<pkg>/build}/gpgx/src, the default). The default output
// is src/analysis/recompile/wat/genesis/gpgx-derived.json.gz.
// --check regenerates in memory and fails if the committed file differs.
//
// This runs ONCE, at development time, when the gpgx pin or its romdev patch
// changes. A recompile never needs C source: the JS backend
// (src/analysis/recompile/wat/genesis/ctrans.js) partially evaluates the ASTs
// committed here.
//
// What it does (the C front end of sms-wat's m68k_tr.py / z80_tr.py):
//
//   1. preprocess Musashi (m68kcpu.h + m68kops.h) and z80.c with the defines
//      gpgx's own libretro build uses (lib/c-preprocessor.mjs, which writes
//      `cpp -P` style text);
//   2. cut every function definition out of the preprocessed text with the
//      same regexes, rewrite the same type spellings, and parse each with
//      lib/c-parser.mjs (pycparser's AST shape);
//   3. keep the functions reachable from the 68000 opcode handlers (via the
//      instruction jump table) and from the Z80 op/cb/dd/ed/fd/xycb handlers;
//   4. serialise their ASTs as compact arrays, plus the tables the handlers
//      index (m68ki_cycles, shift tables, the jump table, Z80 cc_* tables) and
//      the VDP's cycle2hc32/40 tables from hvc.h.
//
// Plain JS, no dependencies beyond node.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync, crc32, gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Preprocessor } from "./lib/c-preprocessor.mjs";
import { parse, serialize, walk } from "./lib/c-parser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const check = process.argv.includes("--check");
const g = path.resolve(args[0] ||
  path.join(process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build"), "gpgx", "src"));
const out = args[1] || path.join(pkg, "src", "analysis", "recompile", "wat", "genesis", "gpgx-derived.json.gz");
const GENERATOR = "scripts/recompile-gen/genesis-gpgx.mjs";
const GENERATOR_VERSION = 1;

const CPP_DEFINES = ["-DLSB_FIRST", "-DALIGN_LONG", "-DUSE_16BPP_RENDERING", "-D__LIBRETRO__"];

// What GCC (x86_64 Linux, gnu17) predefines and the system headers define
// that these sources test or use. System headers themselves are not read.
const PREDEFINED = `#define __STDC__ 1
#define __STDC_VERSION__ 201710L
#define __GNUC__ 15
#define __x86_64__ 1
#define __linux__ 1
#define CHAR_BIT 8
#define INT_MAX 2147483647
#define UINT_MAX 4294967295U
#define NULL ((void *)0)
#define true 1
#define false 0
#define bool _Bool
#define PRId64 "ld"
#define PRIu64 "lu"
#define PRIuPTR "lu"`;

const INCLUDES = ["core/m68k", "core", "", "core/debug", "core/sound", "core/cart_hw", "core/input_hw",
  "core/cd_hw", "core/cart_hw/svp", "core/z80", "core/ntsc", "libretro", "libretro/libretro-common/include"];
// z80_tr.py's include order starts at core/z80
const INCLUDES_Z80 = ["core/z80", ...INCLUDES.filter((d) => d !== "core/z80")];

function cpp(includes, file) {
  const defines = {};
  for (const d of CPP_DEFINES) defines[d.slice(2)] = "1";
  const pp = new Preprocessor({
    includePaths: includes.map((d) => (d ? path.join(g, d) : g)),
    defines,
    predefined: PREDEFINED,
  });
  return pp.run(file);
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
/** Every function definition the regex finds, cut out by brace counting. */
function cutFunctions(src, re) {
  const funcs = new Map();
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length, d = 1;
    while (d) {
      const c = src[i];
      d += (c === "{") - (c === "}");
      i++;
    }
    funcs.set(m[1], src.slice(m.index, i));
  }
  return funcs;
}

/** Names the function mentions: every ID (callees, globals, struct fields). */
function callsIn(n, acc) {
  walk(n, (x) => {
    if (x._ === "FuncCall" && x.name?._ === "ID") acc.add(x.name.name);
    if (x._ === "ID") acc.add(x.name);
  });
  return acc;
}

/** Parse the reachable functions, starting from the handlers. */
function reachable(handlers, funcs, prelude, rewrite) {
  const asts = new Map(), errors = {};
  const parseOne = (name) => {
    if (asts.has(name) || name in errors || !funcs.has(name)) return;
    try {
      asts.set(name, parse(prelude + rewrite(funcs.get(name))).ext.at(-1));
    } catch (e) {
      errors[name] = String(e.message);
    }
  };
  const todo = [...handlers];
  const seen = new Set();
  while (todo.length) {
    const n = todo.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    parseOne(n);
    if (asts.has(n)) for (const c of callsIn(asts.get(n), new Set())) if (funcs.has(c) && !seen.has(c)) todo.push(c);
  }
  return { asts, errors };
}

/** A C initializer entry: integers and + - * with parentheses, as Python's eval saw them. */
function evalInt(s) {
  if (!/^[0-9a-fA-Fx()*+\- ]+$/.test(s)) throw new Error(`gpgx gen: table entry '${s}' is not a constant`);
  const v = Function(`"use strict"; return (${s});`)();
  if (!Number.isInteger(v)) throw new Error(`gpgx gen: table entry '${s}'`);
  return v;
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// 68000 (Musashi)
// ---------------------------------------------------------------------------
function m68k(schema) {
  let src = cpp(INCLUDES, {
    name: path.join(g, "drv.c"),
    text: '#define m68ki_cpu m68k\n#define MUL (7)\n#include "shared.h"\n' +
      '#include "m68kconf.h"\n#include "m68kcpu.h"\n#include "m68kops.h"\n',
  });
  src = src.replace(/\*\(unsigned short \*\)\(m68k\.memory_map\[\(\((\w+(?:\+2)?)\)>>16\)&0xff\]\.base \+ \(\(\1\) & 0xffff\)\)/g,
    "__raw16($1)");
  src = src.replace(/\(m68k\.memory_map\[\(\((\w+)\)>>16\)&0xff\]\.base\)\[\(\(\1\) & 0xffff\)\^1\]/g, "__raw8($1)");
  const funcs = cutFunctions(src, /^(?:static |)(?:inline |)(?:void|unsigned int|int|unsigned char)\s+(\w+)\s*\(([^)]*)\)\s*\n?\{/gm);
  for (const m of src.matchAll(/^inline (?:unsigned int|void) (\w+)\(([^)]*)\) \{.*\}$/gm)) {
    if (!funcs.has(m[1])) funcs.set(m[1], m[0]);
  }
  const tables = {};
  for (const m of src.matchAll(/^static (?:const )?unsigned (?:char|short|int) (\w+)\[(?:\d+|0x[0-9a-fA-F]+)?\]\s*=\s*\{(.*?)\};/gms)) {
    const body = m[2].replace(/\/\*.*?\*\//gs, "");
    tables[m[1]] = body.split(",").filter((x) => x.trim()).map((x) => evalInt(x.trim().replaceAll("(7)", "7")));
  }
  const txt = readFileSync(path.join(g, "core/m68k/m68ki_cycles.h"), "utf8");
  const body = txt.slice(txt.indexOf("{") + 1, txt.lastIndexOf("}"));
  const cycles = [...body.matchAll(/(\d+\*7)/g)].map((m) => evalInt(m[1]));
  if (cycles.length !== 0x10000) throw new Error(`gpgx gen: m68ki_cycles has ${cycles.length} entries`);
  tables.m68ki_cycles = cycles;
  const jt = [...readFileSync(path.join(g, "core/m68k/m68ki_instruction_jump_table.h"), "utf8").matchAll(/m68k_op_\w+/g)].map((m) => m[0]);
  if (jt.length !== 0x10000) throw new Error(`gpgx gen: jump table has ${jt.length} entries`);

  const rewrite = (t) => t.replaceAll("__inline__", "inline")
    .replace(/(?<!un)signed short/g, "short")
    .replace(/(?<!un)signed char/g, "char_s")
    .replace(/(?<!un)signed int/g, "int");
  const handlers = [...new Set(jt)].sort(byName);
  const { asts, errors } = reachable(handlers, funcs, "typedef int char_s; typedef int cpu_memory_map;\n", rewrite);
  const usedIds = new Set();
  for (const fd of asts.values()) callsIn(fd, usedIds);
  const hidx = new Map(handlers.map((n, k) => [n, k]));
  const keep = new Set(["m68ki_cycles", "m68ki_shift_8_table", "m68ki_shift_16_table", "m68ki_shift_32_table"]);
  const names = Object.keys(tables).sort(byName);
  return {
    handlers,
    jumpTable: jt.map((n) => hidx.get(n)),
    functions: Object.fromEntries([...asts.keys()].sort(byName).map((n) => [n, serialize(asts.get(n), schema)])),
    parseErrors: errors,
    tables: Object.fromEntries(names.filter((n) => usedIds.has(n) || keep.has(n)).map((n) => [n, tables[n]])),
    tableNames: names,
  };
}

// ---------------------------------------------------------------------------
// Z80 (MAME z80.c as carried by gpgx)
// ---------------------------------------------------------------------------
function z80(schema) {
  const src = cpp(INCLUDES_Z80, path.join(g, "core/z80/z80.c"));
  const funcs = cutFunctions(src, /^(?:static |)(?:inline |)(?:void|UINT8|UINT16|UINT32|unsigned int|int|unsigned char)\s+(\w+)\s*\(([^)]*)\)\s*\n?\{/gm);
  const cc = {};
  for (const m of src.matchAll(/^static const UINT16 (cc_\w+)\[0x100\] =\s*\{(.*?)\};/gms)) {
    cc[m[1]] = m[2].split(",").filter((x) => x.trim()).map((x) => evalInt(x.trim()));
  }
  for (const k of ["cc_op", "cc_cb", "cc_ed", "cc_xy", "cc_xycb", "cc_ex"]) {
    if (cc[k]?.length !== 256) throw new Error(`gpgx gen: ${k} is not 256 entries`);
  }
  const prelude = "typedef unsigned char UINT8; typedef unsigned short UINT16; typedef unsigned int UINT32;" +
    "typedef signed char INT8; typedef short INT16; typedef int INT32; typedef int PAIR;" +
    "typedef int char_s;\n";
  const hex = (i) => i.toString(16).padStart(2, "0");
  const handlers = Array.from({ length: 256 }, (_, i) => `op_${hex(i)}`);
  for (const p of ["cb", "dd", "ed", "fd", "xycb"]) for (let i = 0; i < 256; i++) handlers.push(`${p}_${hex(i)}`);
  const { asts, errors } = reachable(handlers, funcs, prelude, (t) => t.replace(/(?<!un)signed char/g, "char_s"));
  return {
    handlers,
    functions: Object.fromEntries([...asts.keys()].sort(byName).map((n) => [n, serialize(asts.get(n), schema)])),
    parseErrors: errors,
    cc,
  };
}

function cTable(file, name, n) {
  const txt = readFileSync(file, "utf8");
  const i = txt.indexOf(name);
  let body = txt.slice(txt.indexOf("{", i) + 1, txt.indexOf("}", i));
  body = body.replace(/\/\*.*?\*\//gs, "");
  const vals = body.split(",").filter((x) => x.trim()).map((x) => {
    const s = x.trim();
    if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(s)) throw new Error(`gpgx gen: ${name} entry '${s}'`);
    return Number(s);
  });
  if (vals.length !== n) throw new Error(`gpgx gen: ${name} has ${vals.length} entries`);
  return vals;
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const LICENSE_NOTE =
  "Derived from Genesis Plus GX (Musashi 68000 core, MAME z80.c, hvc.h) by " +
  `${GENERATOR}. Genesis Plus GX is NON-COMMERCIAL: ` +
  "redistributions may not be sold nor used in a commercial product or activity. " +
  "Musashi and z80.c carry their own non-commercial notices (z80.c: Portable Z80 " +
  "emulator V3.9, Copyright Juergen Buchmueller). A wasmcart built from this data " +
  "contains code transpiled from these sources and inherits these terms. The full " +
  "license texts are in the upstream tree pinned in scripts/versions.json.";

/** JSON the way Python's json.dumps(separators=(',', ':')) writes it (ASCII only). */
const pyJson = (v) => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** gzip with a fixed header (mtime 0, XFL 2 for level 9, OS 255) so output is reproducible. */
function gzip(buf) {
  const head = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(buf) >>> 0, 0);
  tail.writeUInt32LE(buf.length >>> 0, 4);
  return Buffer.concat([head, deflateRawSync(buf, { level: 9, memLevel: 8, windowBits: 15 }), tail]);
}

function findPin(o) {
  if (!o || typeof o !== "object") return null;
  for (const [k, v] of Object.entries(o)) {
    if (k === "genesis_plus_gx") return v;
    const r = findPin(v);
    if (r) return r;
  }
  return null;
}

function main() {
  if (!existsSync(path.join(g, "core/m68k/m68kops.h"))) {
    console.error(`usage: genesis-gpgx.mjs [<gpgx-src-dir>] [<out.json.gz>] [--check]\n  ${g} is not a genesis_plus_gx tree (run scripts/build-genesis-plus-gx.sh)`);
    process.exit(2);
  }
  const versions = JSON.parse(readFileSync(path.join(pkg, "scripts/versions.json"), "utf8"));
  const pin = findPin(versions);
  const files = ["core/m68k/m68kops.h", "core/m68k/m68kcpu.h", "core/m68k/m68k.h", "core/m68k/m68kconf.h",
    "core/m68k/m68ki_cycles.h", "core/m68k/m68ki_instruction_jump_table.h",
    "core/z80/z80.c", "core/z80/z80.h", "core/hvc.h", "core/shared.h", "romdev_debug.h"];
  const schema = {};
  const data = {
    format: "romdev-gpgx-derived",
    generatorVersion: GENERATOR_VERSION,
    generator: GENERATOR,
    license: "non-commercial (Genesis Plus GX license)",
    licenseNote: LICENSE_NOTE,
    provenance: {
      upstream: pin.url, commit: pin.commit,
      patch: pin.patch, patchSha256: sha(path.join(pkg, pin.patch)),
      cppDefines: CPP_DEFINES,
      files: Object.fromEntries(files.filter((f) => existsSync(path.join(g, f))).map((f) => [f, sha(path.join(g, f))])),
    },
    m68k: m68k(schema),
    z80: z80(schema),
    hvc: {
      cycle2hc32: cTable(path.join(g, "core/hvc.h"), "cycle2hc32[3420]", 3420),
      cycle2hc40: cTable(path.join(g, "core/hvc.h"), "cycle2hc40[3420]", 3420),
    },
  };
  data.schema = schema;
  const raw = Buffer.from(pyJson(data));
  const m = data.m68k, z = data.z80;
  const summary = `m68k ${m.handlers.length} handlers, ${Object.keys(m.functions).length} functions ` +
    `(${Object.keys(m.parseErrors).length} unparsable), z80 ${Object.keys(z.functions).length} functions ` +
    `(${Object.keys(z.parseErrors).length} unparsable)`;
  if (check) {
    const cur = existsSync(out) ? gunzipSync(readFileSync(out)) : Buffer.alloc(0);
    if (!cur.equals(raw)) { console.error(`${out} is stale; rerun without --check`); process.exit(1); }
    console.log(`  gpgx-derived: ${summary}; ${out} up to date`);
    return;
  }
  const gz = gzip(raw);
  writeFileSync(out, gz);
  console.log(`  gpgx-derived: ${summary}; ${raw.length} bytes json -> ${gz.length} gz -> ${out}`);
}

main();
