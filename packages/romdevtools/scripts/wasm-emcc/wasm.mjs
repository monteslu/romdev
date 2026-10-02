// wasm.mjs - the slice of emscripten's tools/webassembly.py +
// tools/extract_metadata.py that the link needs: read a linked module's
// imports, exports, globals, data segments and target features, and derive
// the metadata the JS glue is generated from.

const SEC = { CUSTOM: 0, TYPE: 1, IMPORT: 2, FUNCTION: 3, TABLE: 4, MEMORY: 5, GLOBAL: 6, EXPORT: 7, START: 8, ELEM: 9, CODE: 10, DATA: 11, DATACOUNT: 12, TAG: 13 };
const KIND = ["func", "table", "memory", "global", "tag"];
const VALTYPE = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128", 0x70: "funcref", 0x6f: "externref", 0x69: "exnref" };

class Reader {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  byte() { return this.buf[this.pos++]; }
  uleb() { let r = 0n, s = 0n, b; do { b = this.byte(); r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return Number(r); }
  sleb() {
    let r = 0n, s = 0n, b;
    do { b = this.byte(); r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
    if (b & 0x40) r -= 1n << s;
    return Number(r);
  }
  bytes(n) { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  str() { return new TextDecoder().decode(this.bytes(this.uleb())); }
  valtype() {
    const t = this.byte();
    if (t === 0x63 || t === 0x64) { this.sleb(); return "ref"; } // (ref null? ht)
    return VALTYPE[t] ?? `0x${t.toString(16)}`;
  }
  limits() { const flags = this.byte(); const min = this.uleb(); const max = flags & 1 ? this.uleb() : null; return { flags, min, max }; }
  initExpr() {
    const ops = [];
    for (;;) {
      const op = this.byte();
      if (op === 0x0b) { ops.push(["end"]); return ops; }
      if (op === 0x41) ops.push(["i32.const", this.sleb()]);
      else if (op === 0x42) ops.push(["i64.const", this.sleb()]);
      else if (op === 0x23) ops.push(["global.get", this.uleb()]);
      else if (op === 0x43) { this.bytes(4); ops.push(["f32.const"]); }
      else if (op === 0x44) { this.bytes(8); ops.push(["f64.const"]); }
      else if (op === 0xd2) ops.push(["ref.func", this.uleb()]);
      else if (op === 0xd0) { this.sleb(); ops.push(["ref.null"]); }
      else throw new Error(`wasm.mjs: unsupported init-expr opcode 0x${op.toString(16)}`);
    }
  }
}

export function parseModule(buf) {
  buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (buf[0] !== 0 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) throw new Error("not a wasm module");
  const r = new Reader(buf, 8);
  const m = { types: [], imports: [], funcTypes: [], globals: [], exports: [], start: null, segments: [], customs: {}, codes: [], numImportedFuncs: 0, numImportedGlobals: 0 };
  while (r.pos < buf.length) {
    const id = r.byte(); const size = r.uleb(); const end = r.pos + size;
    if (id === SEC.CUSTOM) { const name = r.str(); m.customs[name] = buf.subarray(r.pos, end); }
    else if (id === SEC.TYPE) {
      for (let n = r.uleb(); n--;) {
        const form = r.byte(); if (form !== 0x60) throw new Error("wasm.mjs: non-func type");
        const params = []; for (let k = r.uleb(); k--;) params.push(r.valtype());
        const results = []; for (let k = r.uleb(); k--;) results.push(r.valtype());
        m.types.push({ params, results });
      }
    } else if (id === SEC.IMPORT) {
      for (let n = r.uleb(); n--;) {
        const module = r.str(), field = r.str(), kind = KIND[r.byte()];
        const imp = { module, field, kind };
        if (kind === "func") { imp.type = r.uleb(); m.numImportedFuncs++; m.funcTypes.push(imp.type); }
        else if (kind === "table") { imp.elem = r.valtype(); imp.limits = r.limits(); }
        else if (kind === "memory") imp.limits = r.limits();
        else if (kind === "global") { imp.valtype = r.valtype(); imp.mutable = !!r.byte(); m.numImportedGlobals++; m.globals.push({ imported: true, valtype: imp.valtype, mutable: imp.mutable, init: null }); }
        else if (kind === "tag") { r.byte(); imp.type = r.uleb(); }
        m.imports.push(imp);
      }
    } else if (id === SEC.FUNCTION) { for (let n = r.uleb(); n--;) m.funcTypes.push(r.uleb()); }
    else if (id === SEC.GLOBAL) {
      for (let n = r.uleb(); n--;) { const valtype = r.valtype(); const mutable = !!r.byte(); m.globals.push({ valtype, mutable, init: r.initExpr() }); }
    } else if (id === SEC.EXPORT) {
      for (let n = r.uleb(); n--;) { const name = r.str(); const kind = KIND[r.byte()]; m.exports.push({ name, kind, index: r.uleb() }); }
    } else if (id === SEC.START) m.start = r.uleb();
    else if (id === SEC.CODE) {
      for (let n = r.uleb(); n--;) { const sz = r.uleb(); m.codes.push({ offset: r.pos, size: sz }); r.pos += sz; }
    } else if (id === SEC.DATA) {
      for (let n = r.uleb(); n--;) {
        const flags = r.uleb(); let init = null;
        if (flags === 0) init = r.initExpr();
        else if (flags === 2) { r.uleb(); init = r.initExpr(); }
        const sz = r.uleb();
        m.segments.push({ init, offset: r.pos, size: sz });
        r.pos += sz;
      }
    }
    r.pos = end;
  }
  m.buf = buf;
  return m;
}

const constValue = (expr) => {
  if (expr.length !== 2 || expr[1][0] !== "end") throw new Error("unexpected const expr");
  const [op, v] = expr[0];
  if (op === "i32.const" || op === "i64.const") return v;
  if (op === "global.get") return 0;
  throw new Error("unexpected opcode in const expr: " + op);
};
const toUnsigned = (v) => (v < 0 ? v >>> 0 : v);

function targetFeatures(m) {
  const sec = m.customs.target_features;
  const out = {};
  if (!sec) return out;
  const r = new Reader(sec);
  for (let n = r.uleb(); n--;) { const prefix = String.fromCharCode(r.byte()); out[r.str()] = prefix; }
  return out;
}

function findSegment(m, address) {
  for (const seg of m.segments.filter((s) => s.init)) {
    const off = toUnsigned(constValue(seg.init));
    if (address >= off && address < off + seg.size) return [seg, address - off];
  }
  if (m.segments.some((s) => !s.init)) throw new Error("wasm.mjs: passive data segments (pthreads/bulk-memory init) are not handled yet");
  throw new Error("unable to find segment for address: " + address);
}

const dataToString = (bytes) => new TextDecoder().decode(bytes).replace(/\\\\/g, "\\");

function sectionStrings(m, exportMap, name) {
  const s = exportMap.get(`__start_${name}`), e = exportMap.get(`__stop_${name}`);
  if (!s || !e) return new Map();
  const startAddr = toUnsigned(constValue(m.globals[s.index].init));
  const endAddr = toUnsigned(constValue(m.globals[e.index].init));
  const [seg, segOff] = findSegment(m, startAddr);
  const data = m.buf.subarray(seg.offset, seg.offset + seg.size);
  const out = new Map();
  let strStart = segOff; const end = segOff + (endAddr - startAddr);
  while (strStart < end) {
    let strEnd = data.indexOf(0, strStart);
    out.set(startAddr - segOff + strStart, dataToString(data.subarray(strStart, strEnd)));
    strStart = strEnd + 1;
  }
  return out;
}

function stringAt(m, address) {
  const [seg, off] = findSegment(m, address);
  const data = m.buf.subarray(seg.offset, seg.offset + seg.size);
  return dataToString(data.subarray(off, data.indexOf(0, off)));
}

// is_orig_main_wrapper: main's body only calls a 0-arg function
function isOrigMainWrapper(m, funcIndex) {
  const code = m.codes[funcIndex - m.numImportedFuncs];
  const r = new Reader(m.buf, code.offset);
  for (let n = r.uleb(); n--;) { r.uleb(); r.valtype(); }
  const end = code.offset + code.size;
  let op;
  while (r.pos !== end) {
    op = r.byte();
    if (op === 0x10) { const callee = r.uleb(); if (m.types[m.funcTypes[callee]].params.length !== 0) return false; }
    else if (op === 0x20 || op === 0x21) r.uleb();
    else if (op === 0x0b || op === 0x0f) {}
    else return false;
  }
  return op === 0x0b;
}

/** extract_metadata.extract_metadata() */
export function extractMetadata(buf, { standaloneWasm = false } = {}) {
  const m = parseModule(buf);
  const exportMap = new Map(m.exports.map((e) => [e.name, e]));
  const emJsFuncs = {};
  for (const e of m.exports) {
    if (e.kind === "global" && e.name.startsWith("__em_js__")) {
      emJsFuncs[e.name.slice(9)] = stringAt(m, toUnsigned(constValue(m.globals[e.index].init)));
    }
  }
  const feats = Object.entries(targetFeatures(m)).filter(([, p]) => p === "+").map(([f]) => `--enable-${f}`)
    .map((f) => f.replace("--enable-atomics", "--enable-threads").replace("--enable-simd128", "--enable-simd").replace("--enable-nontrapping-fptoint", "--enable-nontrapping-float-to-int"));
  const functionExports = {}; const otherExports = []; const dataExports = {};
  for (const e of m.exports) {
    if (e.kind === "func") functionExports[e.name] = m.types[m.funcTypes[e.index]];
    else {
      if (e.kind === "global") {
        const g = m.globals[e.index];
        if (!g.mutable) { dataExports[e.name] = String(constValue(g.init)); continue; }
      }
      otherExports.push(e.name);
    }
  }
  const main = exportMap.get("main") ?? exportMap.get("__main_argc_argv");
  const mainReadsParams = standaloneWasm ? true : (!main || main.kind !== "func") ? false : !isOrigMainWrapper(m, main.index);
  const imports = [], invokeFuncs = [], emJsFuncTypes = {};
  for (const i of m.imports) {
    if (i.kind === "func") {
      if (i.field.startsWith("invoke_")) invokeFuncs.push(i.field);
      else { if (i.field in emJsFuncs) emJsFuncTypes[i.field] = m.types[i.type]; imports.push(i.field); }
    } else if (i.kind === "global" || i.kind === "tag") imports.push(i.field);
  }
  return {
    functionExports, otherExports, dataExports,
    allExports: m.exports.map((e) => (e.name.startsWith("__em_js__") ? e.name.slice(9) : e.name)),
    emAsmConsts: sectionStrings(m, exportMap, "em_asm"),
    jsDeps: [...sectionStrings(m, exportMap, "em_lib_deps").values()].filter(Boolean),
    emJsFuncs, emJsFuncTypes, features: feats, mainReadsParams, imports, invokeFuncs,
  };
}

const SIG = { i32: "i", i64: "j", f32: "f", f64: "d", externref: "e" };
export const funcTypeToSig = (t) => (t.results.length ? SIG[t.results[0]] : "v") + t.params.map((p) => SIG[p]).join("");

/**
 * building.strip(): drop custom sections (".debug*" when debug, plus the named
 * ones) without re-encoding anything else. Done here rather than with
 * llvm-objcopy because the WASI LLVM's objcopy fails restoring permissions
 * on its output (chmod is ENOSYS under WASI).
 */
export function stripSections(buf, { debug = false, sections = [] } = {}) {
  buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(buf, 8);
  const keep = [buf.subarray(0, 8)];
  while (r.pos < buf.length) {
    const start = r.pos;
    const id = r.byte(); const size = r.uleb(); const end = r.pos + size;
    let drop = false;
    if (id === SEC.CUSTOM) {
      const name = r.str();
      drop = sections.includes(name) || (debug && name.startsWith(".debug"));
    }
    if (!drop) keep.push(buf.subarray(start, end));
    r.pos = end;
  }
  const out = new Uint8Array(keep.reduce((n, b) => n + b.length, 0));
  let o = 0; for (const b of keep) { out.set(b, o); o += b.length; }
  return out;
}
