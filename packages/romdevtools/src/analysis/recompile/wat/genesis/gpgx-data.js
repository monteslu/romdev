// Loader for gpgx-derived.json.gz: the Musashi / z80.c handler ASTs and the
// reference tables the Genesis backend specialises from. Generated once by
// scripts/recompile-gen/genesis-gpgx.mjs (see its header); recompile time only
// reads this file, it never needs gpgx's C source.
//
// LICENSE: the data is derived from Genesis Plus GX and is NON-COMMERCIAL
// (see `licenseNote` in the file and NOTICE). Carts built from it inherit that.
//
// Plain JS ESM + JSDoc.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { TrError } from "./ctrans.js";

const DATA_URL = new URL("./gpgx-derived.json.gz", import.meta.url);

let cached = null;

/** Arrays [kind, ...fields] -> {k: kind, field: value} using the file's schema. */
function hydrator(schema) {
  const h = (x) => {
    if (!Array.isArray(x)) return x;
    const kind = x[0];
    const fields = typeof kind === "string" ? schema[kind] : undefined;
    if (fields && x.length === fields.length + 1) {
      const o = { k: kind };
      for (let i = 0; i < fields.length; i++) o[fields[i]] = h(x[i + 1]);
      return o;
    }
    return x.map(h);
  };
  return h;
}

function astLookup(functions, errors, hydrate, what) {
  const memo = new Map();
  return (name) => {
    if (name === null || name === undefined) throw new TrError(`no ${what} definition for None`);
    let fd = memo.get(name);
    if (fd) return fd;
    if (Object.hasOwn(errors, name)) throw new TrError(`parse ${name}: ${errors[name]}`);
    if (!Object.hasOwn(functions, name)) throw new TrError(`no ${what} definition for ${name}`);
    fd = hydrate(functions[name]);
    memo.set(name, fd);
    return fd;
  };
}

/**
 * Load (once) the gpgx-derived data.
 * @returns {{meta:object, m68k:{handlers:string[], jumpTable:number[], tables:Record<string,number[]>, astOf:(n:string)=>any, handlerName:(ir:number)=>string}, z80:{handlers:string[], cc:Record<string,number[]>, astOf:(n:string)=>any}, hvc:{cycle2hc32:number[], cycle2hc40:number[]}}}
 */
export function loadGpgxData() {
  if (cached) return cached;
  const raw = JSON.parse(gunzipSync(readFileSync(fileURLToPath(DATA_URL))).toString("utf8"));
  if (raw.format !== "romdev-gpgx-derived") throw new Error("gpgx-derived.json.gz: unexpected format");
  const hydrate = hydrator(raw.schema);
  const m = raw.m68k;
  const z = raw.z80;
  cached = {
    meta: {
      generatorVersion: raw.generatorVersion,
      license: raw.license,
      licenseNote: raw.licenseNote,
      provenance: raw.provenance,
    },
    m68k: {
      handlers: m.handlers,
      jumpTable: m.jumpTable,
      tables: m.tables,
      astOf: astLookup(m.functions, m.parseErrors, hydrate, "m68k"),
      handlerName: (ir) => m.handlers[m.jumpTable[ir]],
    },
    z80: {
      handlers: z.handlers,
      cc: z.cc,
      astOf: astLookup(z.functions, z.parseErrors, hydrate, "z80"),
    },
    hvc: raw.hvc,
  };
  return cached;
}
