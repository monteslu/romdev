// Shared by the recompiler data generators that compile an emulator's C to
// wasm32 and print it as WAT for a recompiled cart (snes9x-chips.mjs,
// gpgx-svp.mjs): a wasm binary decoder and the two-link relocation printer.
//
// A unit is linked twice at two --global-base values (baseA, baseA + delta).
// A constant, memarg offset, global init or data word that differs between
// the two links by exactly delta is an address inside the unit's own memory
// and is written as @{offset}; everything else must be byte-identical.

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
  u8() { if (this.p >= this.end) throw new Error("wasm-unit: read past end"); return this.b[this.p++]; }
  u32() { let r = 0, s = 0, c; do { c = this.u8(); r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); return r >>> 0; }
  s32() { let r = 0, s = 0, c; do { c = this.u8(); r |= (c & 0x7f) << s; s += 7; } while (c & 0x80); if (s < 32 && (c & 0x40)) r |= -1 << s; return r | 0; }
  s64() { let r = 0n, s = 0n, c; do { c = this.u8(); r |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80); if (s < 64n && (c & 0x40)) r |= -1n << s; return BigInt.asIntN(64, r); }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  name() { return Buffer.from(this.bytes(this.u32())).toString("utf8"); }
  vt() { const t = VT[this.u8()]; if (!t) throw new Error("wasm-unit: unknown value type"); return t; }
  limits() { const f = this.u8(); const min = this.u32(); const max = f & 1 ? this.u32() : null; return { min, max }; }
}

/** One instruction list per function: {op, imm[]} with immediates kept raw. */
export function decodeModule(bytes) {
  const r = new Reader(bytes);
  if (bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error("wasm-unit: not a wasm module");
  r.p = 8;
  const m = { types: [], imports: [], funcTypes: [], tables: [], globals: [], exports: [], start: null, elems: [], codes: [], datas: [] };
  const constExpr = (rr) => {
    const op = rr.u8();
    let v;
    if (op === 0x41) v = { t: "i32", v: rr.s32() };
    else if (op === 0x42) v = { t: "i64", v: rr.s64() };
    else if (op === 0x23) v = { t: "global", v: rr.u32() };
    else throw new Error(`wasm-unit: const expr op 0x${op.toString(16)}`);
    if (rr.u8() !== 0x0b) throw new Error("wasm-unit: const expr end");
    return v;
  };
  while (r.p < bytes.length) {
    const id = r.u8(), size = r.u32(), end = r.p + size;
    const s = new Reader(bytes, r.p, end);
    switch (id) {
      case 0: break;
      case 1: for (let n = s.u32(); n--;) {
        if (s.u8() !== 0x60) throw new Error("wasm-unit: non-func type");
        const params = []; for (let k = s.u32(); k--;) params.push(s.vt());
        const results = []; for (let k = s.u32(); k--;) results.push(s.vt());
        m.types.push({ params, results });
      } break;
      case 2: for (let n = s.u32(); n--;) {
        const mod = s.name(), nm = s.name(), kind = s.u8();
        if (kind === 0) m.imports.push({ mod, name: nm, kind: "func", type: s.u32() });
        else if (kind === 2) { s.limits(); m.imports.push({ mod, name: nm, kind: "memory" }); }
        else throw new Error(`wasm-unit: import kind ${kind} (${mod}.${nm})`);
      } break;
      case 3: for (let n = s.u32(); n--;) m.funcTypes.push(s.u32()); break;
      case 4: for (let n = s.u32(); n--;) { const t = s.vt(); m.tables.push({ t, ...s.limits() }); } break;
      case 5: s.u32(); s.limits(); break;
      case 6: for (let n = s.u32(); n--;) { const t = s.vt(); const mut = s.u8(); m.globals.push({ t, mut, init: constExpr(s) }); } break;
      case 7: for (let n = s.u32(); n--;) { const nm = s.name(); const kind = s.u8(); m.exports.push({ name: nm, kind, idx: s.u32() }); } break;
      case 8: m.start = s.u32(); break;
      case 9: for (let n = s.u32(); n--;) {
        const flags = s.u32();
        if (flags !== 0) throw new Error(`wasm-unit: elem segment flags ${flags}`);
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
        else throw new Error(`wasm-unit: data segment flags ${flags}`);
      } break;
      case 12: break;
      default: throw new Error(`wasm-unit: section ${id}`);
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
    throw new Error("wasm-unit: type-index block types are not supported");
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
    if (MEM[op]) { const align = r.u32(); if (align & 0x40) throw new Error("wasm-unit: multi-memory memarg"); ins.push({ op: MEM[op], align, off: r.u32() }); continue; }
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
      throw new Error(`wasm-unit: 0xFC ${sub}`);
    }
    throw new Error(`wasm-unit: opcode 0x${op.toString(16)}`);
  }
  return ins;
}

// ---------------------------------------------------------------- relocate + print
/**
 * Print one function body from the two links. A constant or offset that
 * moved by exactly DELTA is an address in the unit's memory: @{A - BASE_A}.
 */
function printBody(a, b, names, { baseA, delta }) {
  if (a.ins.length !== b.ins.length) throw new Error(`wasm-unit: ${names.fn}: instruction counts differ between links`);
  const lines = [];
  let indent = 1;
  for (let i = 0; i < a.ins.length; i++) {
    const x = a.ins[i], y = b.ins[i];
    if (x.op !== y.op) throw new Error(`wasm-unit: ${names.fn}: op ${i} differs between links`);
    const addr = (va, vb, what) => {
      if (va === vb) return String(va);
      if (vb - va !== delta) throw new Error(`wasm-unit: ${names.fn}: ${what} ${va} vs ${vb} is not an address`);
      return `@{${va - baseA}}`;
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
      case "i64.const": if (x.v !== y.v) throw new Error(`wasm-unit: ${names.fn}: i64 constant moved`); t = `i64.const ${x.v}`; break;
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

export function unitWat(name, A, B, { prefix = "c", imports = {}, importPrefix = "$chip_", baseA, delta }) {
  const P = `${prefix}_${name}`;
  const BASE_A = baseA, DELTA = delta;
  const nImp = A.imports.filter((i) => i.kind === "func").length;
  const impFuncs = A.imports.filter((i) => i.kind === "func");
  const exportName = {};
  for (const e of A.exports) if (e.kind === 0) exportName[e.idx] = e.name;
  const fname = (f) => {
    if (f < nImp) {
      const imp = impFuncs[f];
      const alias = imports[imp.name];
      if (!alias) throw new Error(`wasm-unit: ${name}: undefined symbol ${imp.name} has no cart import`);
      return `${importPrefix}${alias}`;
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
    funcs.push(`  (func ${fname(fi)}${sig}${loc}\n${printBody(A.codes[i], B.codes[i], names, { baseA, delta })})`);
  }
  const globals = A.globals.map((g, i) => {
    const gb = B.globals[i];
    let init;
    if (g.init.t === "i32") init = g.init.v === gb.init.v ? String(g.init.v) : (gb.init.v - g.init.v === DELTA ? `@{${g.init.v - BASE_A}}` : null);
    else throw new Error(`wasm-unit: ${name}: global ${i} init ${g.init.t}`);
    if (init === null) throw new Error(`wasm-unit: ${name}: global ${i} init is not an address`);
    return `  (global $${P}_g${i} ${g.mut ? `(mut ${g.t})` : g.t} (i32.const ${init}))`;
  });
  let table = null;
  if (A.tables.length) {
    if (A.tables.length !== 1) throw new Error(`wasm-unit: ${name}: ${A.tables.length} tables`);
    const t = A.tables[0];
    const elems = A.elems.map((e) => `  (elem (table $${P}_tab) (i32.const ${e.off}) func ${e.fns.map(fname).join(" ")})`);
    table = `  (table $${P}_tab ${t.min}${t.max != null ? " " + t.max : ""} funcref)\n` + elems.join("\n");
  }
  // data: active segments at @{off}; pointer words that moved are relocated
  const data = A.datas.map((d, i) => {
    const e = B.datas[i];
    if (d.off === null || e.off - d.off !== DELTA) throw new Error(`wasm-unit: ${name}: data segment ${i} is not placed at the base`);
    if (d.bytes.length !== e.bytes.length) throw new Error(`wasm-unit: ${name}: data segment ${i} length differs`);
    const relocs = [];
    for (let k = 0; k < d.bytes.length; k++) {
      if (d.bytes[k] === e.bytes[k]) continue;
      const w = k & ~3;
      const va = new DataView(d.bytes.buffer, d.bytes.byteOffset + w, 4).getUint32(0, true);
      const vb = new DataView(e.bytes.buffer, e.bytes.byteOffset + w, 4).getUint32(0, true);
      if (vb - va !== DELTA) throw new Error(`wasm-unit: ${name}: data word at +${w} is not an address`);
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
    imports: impFuncs.map((f) => ({ name: f.name, as: `${importPrefix}${imports[f.name]}`, params: A.types[f.type].params, results: A.types[f.type].results })),
  };
}

