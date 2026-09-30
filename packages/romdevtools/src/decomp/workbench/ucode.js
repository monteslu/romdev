// ucode.js - decode retained IDO binary Ucode (the uopt-to-ugen pass
// boundary) and report its switch dispatches.
//
// IDO binary Ucode is a variable-width stream of big-endian 32-bit words.
// The decoder follows the public IDO source definitions in ucode.h and
// libu/uini.c (n64decomp/ido commit d068e439) rather than searching for byte
// signatures. The report answers the late-stage control-flow question: what
// selector expression feeds each Uxjp, which label owns the case table, which
// label is the default, and where does every dense table entry jump. Unknown
// semantic operands remain raw words.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ValueError, hex, sum } from "./py.js";
import { BINASM_RECORD_SIZE, parseBinasm, readStreamBytes } from "./binasm.js";

export const UCODE_REPORT_SCHEMA = "decomp-workbench-ucode-xjp-v1";

/** Append-only Uopcode enum order from src/ucode.h. */
export const OPCODE_NAMES = Object.freeze(["abs","add","adj","aent","and","aos","asym","bgn","bgnb","bsub","cg1","cg2","chkh","chkl","chkn","chkt","cia","clab","clbd","comm","csym","ctrl","cubd","cup","cvt","cvtl","dec","def","dif","div","dup","end","endb","ent","eof","equ","esym","fill","fjp","fsym","geq","grt","gsym","hsym","icuf","idx","iequ","igeq","igrt","ijp","ilda","ildv","ileq","iles","ilod","inc","ineq","init","inn","int","ior","isld","isst","istr","istv","ixa","lab","lbd","lbdy","lbgn","lca","lda","ldap","ldc","ldef","ldsp","lend","leq","les","lex","lnot","loc","lod","lsym","ltrm","max","min","mod","mov","movv","mpmv","mpy","mst","mus","neg","neq","nop","not","odd","optn","par","pdef","pmov","pop","regs","rem","ret","rlda","rldc","rlod","rnd","rpar","rstr","sdef","sgs","shl","shr","sign","sqr","sqrt","ssym","step","stp","str","stsp","sub","swp","tjp","tpeq","tpge","tpgt","tple","tplt","tpne","typ","ubd","ujp","unal","uni","vreg","xjp","xor","xpar","mtag","alia","ildi","isti","irld","irst","ldrc","msym","rcuf","ksym","osym","irlv","irsv"]);
export const DTYPE_NAMES = Object.freeze(["Adt","Cdt","Fdt","Gdt","Hdt","Idt","Jdt","Kdt","Ldt","Mdt","Ndt","Pdt","Qdt","Rdt","Sdt","Wdt","Xdt","Zdt"]);
export const MTYPE_NAMES = Object.freeze(["Zmt","Mmt","Pmt","Rmt","Smt","Amt","Tmt","Kmt"]);

// uini.c defaults every instruction to two words and then overrides these.
const FOUR_WORD_OPS = new Set(["adj","aent","asym","bgn","cia","clab","comm","csym","ctrl","cup","cvt","def","dif","ent","esym","fill","fsym","gsym","hsym","icuf","iequ","igeq","igrt","ildv","ileq","iles","ilod","ineq","inn","int","isld","isst","istr","istv","ksym","lab","lca","ldc","ldef","ldrc","lod","lsym","mov","mpmv","msym","mus","optn","osym","par","pdef","pmov","rcuf","regs","rlda","rldc","rlod","rnd","rpar","rstr","sdef","sgs","ssym","str","swp","typ","uni","vreg","ildi","isti","irld","irst"]);
const SIX_WORD_OPS = new Set(["ilda","lda","init"]);
const HAS_CONSTANT = new Set(["cia","comm","init","lca","ldc","rldc","ssym"]);
const VARIABLE_CONSTANT_DTYPES = new Set([9, 12, 13, 14, 16]);

// Stack effects copied from uini.c: they find the exact postfix expression
// consumed by XJP instead of printing an arbitrary record window.
const PUSH_ONE = new Set(["abs","add","adj","and","bsub","chkh","chkl","chkn","cvt","cvtl","dec","dif","div","dup","equ","geq","grt","idx","iequ","igeq","igrt","ilda","ildi","ileq","iles","ilod","irld","inc","ineq","inn","int","ior","isld","ixa","lbd","lca","lda","ldap","ldc","ldrc","ldsp","leq","les","lnot","lod","max","min","mod","mpy","mus","neg","neq","not","odd","rem","rnd","sgs","shl","shr","sign","sqr","sqrt","sub","swp","typ","ubd","uni","xor"]);
const POP_ONE = new Set(["abs","adj","aos","chkh","chkl","chkn","chkt","cvt","cvtl","dec","fjp","icuf","ijp","ilda","ilod","inc","irld","isld","lbd","lnot","mpmv","neg","not","odd","par","pmov","pop","rnd","sgs","sqr","sqrt","str","stsp","swp","tjp","typ","ubd","xjp","xpar"]);
const POP_TWO = new Set(["add","and","bsub","dif","div","equ","fill","geq","grt","iequ","igeq","igrt","ildi","ileq","iles","ineq","inn","int","ior","irst","isst","istr","ixa","leq","les","max","min","mod","mov","mpy","mus","neq","rem","shl","shr","sign","sub","tpeq","tpge","tpgt","tple","tplt","tpne","uni","xor"]);
const POP_THREE = new Set(["idx","isti"]);
const CONTROL_BOUNDARIES = new Set(["bgn","bgnb","clab","end","endb","fjp","ijp","lab","ldef","ret","tjp","ujp","xjp"]);

/** An exact integer: a Number when it is safe, else a BigInt. */
function exact(b) { return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b; }
function signed64(hiWord, loWord) { return exact(BigInt.asIntN(64, (BigInt(hiWord) << 32n) | BigInt(loWord))); }
function unsigned64(hiWord, loWord) { return exact((BigInt(hiWord) << 32n) | BigInt(loWord)); }
const signed32 = (v) => (v & 0x80000000 ? v - 0x100000000 : v);

function dtypeName(dtype) { return dtype < DTYPE_NAMES.length ? DTYPE_NAMES[dtype] : `dtype-${dtype}`; }

function baseWordLength(name) {
  if (name === "xjp") return 8;
  if (SIX_WORD_OPS.has(name)) return 6;
  if (FOUR_WORD_OPS.has(name)) return 4;
  return 2;
}

function stackPop(name) {
  if (POP_THREE.has(name)) return 3;
  if (POP_TWO.has(name)) return 2;
  if (POP_ONE.has(name)) return 1;
  return 0;
}

/** Name fixed-record Binasm when it was passed as variable Ucode. */
function wrongPassFormatHint(data) {
  if (!data.length || data.length % BINASM_RECORD_SIZE) return "";
  const records = parseBinasm(data);
  const recognized = sum(records.map((r) => r.kind !== "unknown"));
  if (recognized * 4 < records.length * 3) return "";
  return `; input appears to be fixed ${BINASM_RECORD_SIZE}-byte Binasm (${recognized}/${records.length} records recognized). `
    + "UGEN's -temp output is Binasm-shaped, not its input Ucode; inspect that file with "
    + "`pass binasm` and give `pass ucode` UGEN's positional input";
}

/** One losslessly framed IDO binary Ucode instruction. */
export class UcodeRecord {
  constructor({ index, word_offset, words, opcode, name, dtype, mtype, lexlev, base_word_length }) {
    Object.assign(this, { index, word_offset, words, opcode, name, dtype, mtype, lexlev, base_word_length });
    Object.freeze(this);
  }
  get byte_offset() { return this.word_offset * 4; }
  get raw_hex() { return this.words.map((w) => hex(w, 8)).join(" "); }

  /** The active integer member of an Uldc `union Valu` (see bwri.c word order). */
  get integer_constant() {
    if (this.name !== "ldc" || this.words.length < this.base_word_length + 2) return null;
    const first = this.words[this.base_word_length], second = this.words[this.base_word_length + 1];
    if (this.dtype === 5) return signed64(second, first); // Idt: low word first
    if (this.dtype === 6) return signed32(first); // Jdt
    if (this.dtype === 7) return unsigned64(second, first); // Kdt
    if (this.dtype === 8) return first; // Ldt
    return null;
  }

  get detail() {
    const w = this.words;
    if (this.name === "xjp") return `cases=L${w[1]} default=L${w[2]} range=${this.lower_bound}..${this.upper_bound}`;
    if (this.name === "clab") return `label=L${w[1]} entries=${w[2]}`;
    if (this.name === "lab" || this.name === "ldef") return `label=L${w[1]}`;
    if (this.name === "fjp" || this.name === "tjp" || this.name === "ujp") return `target=L${w[1]}`;
    if (this.name === "loc") return `file=${this.lexlev} line=${w[1]}`;
    if (this.name === "ldc" && w.length >= this.base_word_length + 2) {
      const constant = this.integer_constant;
      if (constant !== null) {
        let detail = `constant=${constant} length=${w[2]}`;
        if (this.dtype === 6 || this.dtype === 8) detail += ` inactive-word=0x${hex(w[this.base_word_length + 1], 8)}`;
        return detail;
      }
      const payload = w.slice(this.base_word_length, this.base_word_length + 2);
      return `constant-payload=0x${hex(payload[0], 8)}/0x${hex(payload[1], 8)} length=${w[2]}`;
    }
    if (this.name === "lod" || this.name === "str") return `${MTYPE_NAMES[this.mtype]} block=${w[1]} offset=${signed32(w[2])} length=${w[3]}`;
    return `dtype=${dtypeName(this.dtype)}`;
  }

  get lower_bound() {
    if (this.name !== "xjp") throw new ValueError("lower_bound is defined only for Uxjp");
    return signed64(this.words[4], this.words[5]);
  }

  get upper_bound() {
    if (this.name !== "xjp") throw new ValueError("upper_bound is defined only for Uxjp");
    return signed64(this.words[6], this.words[7]);
  }

  asDict() {
    const result = {
      index: this.index, byte_offset: this.byte_offset, offset_hex: `0x${hex(this.byte_offset)}`, word_count: this.words.length,
      words: this.words.map((w) => `0x${hex(w, 8)}`), raw_hex: this.raw_hex, opcode: this.opcode, name: `U${this.name}`,
      dtype: this.dtype, dtype_name: dtypeName(this.dtype), mtype: this.mtype, mtype_name: MTYPE_NAMES[this.mtype],
      lexlev: this.lexlev, detail: this.detail,
    };
    if (this.name === "ldc" && this.words.length >= this.base_word_length + 2) {
      result.constant_storage_words = this.words.slice(this.base_word_length, this.base_word_length + 2).map((w) => `0x${hex(w, 8)}`);
      result.constant_value = this.integer_constant;
      if (this.dtype === 6 || this.dtype === 8) result.inactive_constant_word = `0x${hex(this.words[this.base_word_length + 1], 8)}`;
    }
    return result;
  }
}

/** Parse one complete big-endian IDO binary Ucode stream. */
export function parseUcode(source) {
  const data = readStreamBytes(source);
  if (data.length % 4) throw new ValueError(`Ucode stream is ${data.length} bytes; expected complete 32-bit words`);
  const n = data.length / 4;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = data.readUInt32BE(i * 4);
  const records = [];
  let cursor = 0;
  while (cursor < n) {
    const header = raw[cursor];
    const opcode = header >>> 24;
    if (opcode >= OPCODE_NAMES.length) {
      throw new ValueError(`unknown Ucode opcode 0x${hex(opcode, 2)} at byte offset 0x${hex(cursor * 4)}${wrongPassFormatHint(data)}`);
    }
    const name = OPCODE_NAMES[opcode];
    const dtype = (header >>> 16) & 0x1F;
    const baseLength = baseWordLength(name);
    let total = baseLength;
    if (HAS_CONSTANT.has(name)) {
      total += 2;
      if (VARIABLE_CONSTANT_DTYPES.has(dtype) || name === "comm") {
        if (cursor + baseLength >= n) throw new ValueError(`truncated U${name} constant at byte offset 0x${hex(cursor * 4)}`);
        const byteLength = raw[cursor + baseLength];
        let payloadWords = Math.floor((byteLength + 3) / 4);
        if (payloadWords & 1) payloadWords += 1;
        total += payloadWords;
      }
    }
    const end = cursor + total;
    if (end > n) throw new ValueError(`truncated U${name} at byte offset 0x${hex(cursor * 4)}: needs ${total} words, only ${n - cursor} remain`);
    records.push(new UcodeRecord({ index: records.length, word_offset: cursor, words: raw.slice(cursor, end), opcode, name, dtype,
      mtype: (header >>> 21) & 0x7, lexlev: header & 0xFFFF, base_word_length: baseLength }));
    cursor = end;
  }
  return records;
}

/** Recover the postfix expression whose single result XJP consumes. */
function selectorExpression(records, xjpIndex, { limit }) {
  let needed = 1;
  const selected = [];
  const start = Math.max(0, xjpIndex - limit);
  for (let i = xjpIndex - 1; i >= start; i--) {
    const record = records[i];
    if (CONTROL_BOUNDARIES.has(record.name)) break;
    if (!PUSH_ONE.has(record.name)) continue;
    selected.push(record);
    needed = needed - 1 + stackPop(record.name);
    if (needed === 0) break;
  }
  selected.reverse();
  return [selected, needed === 0];
}

/** Resolve the Uclab and dense Uujp records immediately after XJP. */
function caseTable(records, xjpIndex) {
  const xjp = records[xjpIndex];
  const next = xjpIndex + 1;
  if (next >= records.length) return [null, []];
  const clab = records[next];
  if (clab.name !== "clab" || clab.words[1] !== xjp.words[1]) return [null, []];
  const expected = clab.words[2];
  const jumps = [];
  for (const record of records.slice(next + 1, next + 1 + expected)) {
    if (record.name !== "ujp") break;
    jumps.push(record);
  }
  return [clab, jumps];
}

/** Index ordinary Ulab blocks by label number. */
function labelBlocks(records) {
  const positions = [];
  records.forEach((r, i) => { if (r.name === "lab") positions.push(i); });
  const blocks = new Map();
  positions.forEach((start, k) => {
    const end = k + 1 < positions.length ? positions[k + 1] : records.length;
    blocks.set(records[start].words[1], records.slice(start, end));
  });
  return blocks;
}

/** The destination of a metadata-only label/jump trampoline. */
function trivialJumpTarget(block) {
  const semantic = block.filter((r) => !["lab", "loc", "nop", "comm"].includes(r.name));
  if (semantic.length === 1 && semantic[0].name === "ujp") return semantic[0].words[1];
  return null;
}

/** Trace a case target through zero-work Uujp trampolines. */
function caseTargetChain(blocks, target, { limit = 32 } = {}) {
  const labels = [target];
  const visited = new Set([target]);
  let status = "direct";
  let exhausted = true;
  for (let n = 0; n < limit; n++) {
    const block = blocks.get(labels[labels.length - 1]);
    if (!block) { status = "missing-label"; exhausted = false; break; }
    const nextTarget = trivialJumpTarget(block);
    if (nextTarget === null) { status = labels.length > 1 ? "trampoline" : "direct"; exhausted = false; break; }
    status = "trampoline";
    if (visited.has(nextTarget)) { labels.push(nextTarget); status = "cycle"; exhausted = false; break; }
    labels.push(nextTarget);
    visited.add(nextTarget);
  }
  if (exhausted) status = "limit";
  const terminal = blocks.get(labels[labels.length - 1]);
  return {
    labels, hop_count: labels.length - 1, effective_target_label: labels[labels.length - 1], status,
    terminal_block_record_count: terminal ? terminal.length : null,
    terminal_block_preview: terminal ? terminal.slice(0, 8).map((r) => r.asDict()) : null,
  };
}

/** A machine-readable report for every XJP in one retained stream. */
export function buildUcodeXjpReport(stream, { expression_limit = 64 } = {}) {
  if (expression_limit < 1) throw new ValueError("expression limit must be at least 1");
  const data = readFileSync(stream);
  const records = parseUcode(data);
  const blocks = labelBlocks(records);
  const dispatches = [];
  records.forEach((record, index) => {
    if (record.name !== "xjp") return;
    const [expression, complete] = selectorExpression(records, index, { limit: expression_limit });
    const [clab, jumps] = caseTable(records, index);
    const lower = record.lower_bound, upper = record.upper_bound;
    const span = BigInt(upper) >= BigInt(lower) ? exact(BigInt(upper) - BigInt(lower) + 1n) : 0;
    const targets = jumps.map((j) => j.words[1]);
    const chains = targets.map((t) => caseTargetChain(blocks, t));
    dispatches.push({
      xjp: record.asDict(), case_table_label: record.words[1], default_label: record.words[2],
      lower_bound: lower, upper_bound: upper, range_size: span,
      selector_expression: expression.map((r) => r.asDict()), selector_expression_complete: complete,
      case_table: clab ? clab.asDict() : null, case_targets: targets,
      cases: targets.map((t, off) => ({ value: exact(BigInt(lower) + BigInt(off)), target_label: t, target_chain: chains[off] })),
      trampoline_case_count: sum(chains.map((c) => c.hop_count > 0)),
      case_table_complete: clab !== null && BigInt(jumps.length) === BigInt(span),
    });
  });
  return {
    schema: UCODE_REPORT_SCHEMA,
    stream: { path: String(stream), bytes: data.length, words: Math.floor(data.length / 4), record_count: records.length,
      sha256: createHash("sha256").update(data).digest("hex"), byteorder: "big" },
    dispatch_count: dispatches.length,
    dispatches,
    format_source: { repository: "https://github.com/n64decomp/ido", revision: "d068e439f52615763a3facd6944873899ebad2fd", files: ["src/ucode.h", "src/libu/uini.c"] },
    proof: "This is static pass-boundary evidence: it establishes the binary Ucode selector, XJP labels/range, encoded dense table, and any metadata-only Uujp trampoline chains. It does not by itself prove which C spelling emitted that Ucode.",
  };
}
