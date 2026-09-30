// asm-processor.js - a JS port of asm-processor (asm_processor.py + build.py,
// https://github.com/simonlindholm/asm-processor, as vendored by decomp
// projects under tools/asm-processor/).
//
// asm-processor lets a C file embed assembly with GLOBAL_ASM / INCLUDE_ASM:
//   1. preprocess: each asm block becomes a dummy C function/array of exactly
//      the right size, so IDO lays the TU out as if the asm were C;
//   2. the real compiler compiles that C;
//   3. post-process: the asm is assembled separately and its section bytes,
//      symbols and relocations are spliced into the compiler's object.
//
// The output object must match the Python tool's byte for byte (projects
// compare built ROMs by sha1), so this port keeps every algorithm, ordering
// rule and float/strtab formatting of the original. The compiler and
// assembler are injected (romdev runs them as WASM).
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eucJpEncode } from "./euc-jp.js";

const MAX_FN_SIZE = 100;

const SHN_UNDEF = 0, SHN_ABS = 0xfff1, SHN_XINDEX = 0xffff;
const STT_OBJECT = 1, STT_FUNC = 2;
const STB_LOCAL = 0, STB_GLOBAL = 1;
const STV_DEFAULT = 0;
const SHT_NULL = 0, SHT_SYMTAB = 2, SHT_RELA = 4, SHT_NOBITS = 8, SHT_REL = 9;
const SHT_MIPS_GPTAB = 0x70000003, SHT_MIPS_DEBUG = 0x70000005;
const SHF_LINK_ORDER = 0x80;
const MIPS_DEBUG_ST_STATIC = 2, MIPS_DEBUG_ST_PROC = 6, MIPS_DEBUG_ST_BLOCK = 7, MIPS_DEBUG_ST_END = 8,
  MIPS_DEBUG_ST_FILE = 11, MIPS_DEBUG_ST_STATIC_PROC = 14, MIPS_DEBUG_ST_STRUCT = 26,
  MIPS_DEBUG_ST_UNION = 27, MIPS_DEBUG_ST_ENUM = 28;

export class Failure extends Error {}

// -- encodings -----------------------------------------------------------
function normEnc(e) { return String(e).toLowerCase().replace(/[_-]/g, ""); }

/** Python-codec encode for the encodings decomp builds use. */
export class Encoding {
  constructor(encoding) {
    this.encoding = encoding;
    const n = normEnc(encoding);
    this.isEucJp = n === "eucjp";
    this.kind = this.isEucJp ? "eucjp" : (n === "utf8" ? "utf8" : (n === "latin1" || n === "iso88591" ? "latin1" : n === "ascii" ? "ascii" : null));
    if (!this.kind) throw new Failure(`unsupported encoding '${encoding}' (utf-8, latin1, ascii, euc-jp)`);
  }
  encode(s) {
    if (this.isEucJp) s = s.replaceAll("\uff5e", "\u301c");
    if (this.kind === "utf8") return Buffer.from(s, "utf8");
    if (this.kind === "eucjp") return eucJpEncode(s);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > (this.kind === "ascii" ? 0x7f : 0xff)) throw new Failure(`'${this.encoding}' codec can't encode character U+${c.toString(16).padStart(4, "0")}`);
    }
    return Buffer.from(s, "latin1");
  }
}

function decodeText(buf, encoding) {
  const n = normEnc(encoding);
  if (n === "latin1" || n === "iso88591") return buf.toString("latin1");
  if (n === "utf8") return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  if (n === "ascii") return buf.toString("latin1");
  if (n === "eucjp") return new TextDecoder("euc-jp", { fatal: true }).decode(buf);
  throw new Failure(`unsupported input encoding '${encoding}'`);
}

/** Python's text-mode line iteration: universal newlines, each line keeps its "\n". */
function pyLines(text) {
  const t = text.replace(/\r\n?/g, "\n");
  const out = [];
  let i = 0;
  while (i < t.length) {
    const j = t.indexOf("\n", i);
    if (j < 0) { out.push(t.slice(i)); break; }
    out.push(t.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

// Python str.strip()/split() whitespace (the ASCII/Latin-1 subset is what occurs).
const PY_WS = " \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";
function rstrip(s) { let e = s.length; while (e > 0 && PY_WS.includes(s[e - 1])) e--; return s.slice(0, e); }
function lstrip(s) { let b = 0; while (b < s.length && PY_WS.includes(s[b])) b++; return s.slice(b); }
function strip(s) { return lstrip(rstrip(s)); }
const PY_WS_RUN = new RegExp("[" + [...PY_WS].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("") + "]+");
function pySplit(s) { return strip(s).split(PY_WS_RUN).filter((x) => x.length); }

/** str(pathlib.PurePosixPath(p)): collapse "//" and "." components, drop a trailing "/". */
export function pyPath(p) {
  if (!p) return ".";
  const abs = p.startsWith("/");
  const parts = p.split("/").filter((x) => x && x !== ".");
  const s = (abs ? "/" : "") + parts.join("/");
  return s || (abs ? "/" : ".");
}

/** int(x, 0) */
function pyInt0(s) {
  const t = strip(s).replace(/_/g, "");
  const m = /^([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|[1-9][0-9]*|0+)$/.exec(t);
  if (!m) throw new Failure(`invalid literal for int() with base 0: '${s}'`);
  const body = m[2];
  let v;
  if (/^0[xX]/.test(body)) v = parseInt(body.slice(2), 16);
  else if (/^0[oO]/.test(body)) v = parseInt(body.slice(2), 8);
  else if (/^0[bB]/.test(body)) v = parseInt(body.slice(2), 2);
  else v = parseInt(body, 10);
  return m[1] === "-" ? -v : v;
}
/** int(x) (base 10) */
function pyInt(s) {
  const t = strip(s).replace(/_/g, "");
  if (!/^[+-]?[0-9]+$/.test(t)) throw new Failure(`invalid literal for int() with base 10: '${s}'`);
  return parseInt(t, 10);
}

/** repr() of a Python float (shortest round-trip digits, Python's layout). */
export function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  const [mant, expStr] = Math.abs(x).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expStr); // decimal exponent of the first digit
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const e = Math.abs(exp);
    return `${sign}${m}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" + e : e}`;
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  if (digits.length <= exp + 1) return `${sign}${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
}

// -- ELF -----------------------------------------------------------------
class Fmt {
  constructor(big) { this.big = big; }
  u16(b, o) { return this.big ? b.readUInt16BE(o) : b.readUInt16LE(o); }
  u32(b, o) { return this.big ? b.readUInt32BE(o) : b.readUInt32LE(o); }
  pack(fields) { // [[bits, value]]
    const size = fields.reduce((a, [w]) => a + w / 8, 0);
    const b = Buffer.alloc(size);
    let o = 0;
    for (const [w, v] of fields) {
      if (w === 8) b.writeUInt8(v & 0xff, o);
      else if (w === 16) this.big ? b.writeUInt16BE(v & 0xffff, o) : b.writeUInt16LE(v & 0xffff, o);
      else this.big ? b.writeUInt32BE(v >>> 0, o) : b.writeUInt32LE(v >>> 0, o);
      o += w / 8;
    }
    return b;
  }
}

class ElfHeader {
  constructor(data) {
    this.e_ident = Buffer.from(data.subarray(0, 16));
    if (this.e_ident[4] !== 1) throw new Failure("not a 32-bit ELF");
    this.fmt = new Fmt(this.e_ident[5] === 2);
    const f = this.fmt, d = data;
    this.e_type = f.u16(d, 16); this.e_machine = f.u16(d, 18); this.e_version = f.u32(d, 20);
    this.e_entry = f.u32(d, 24); this.e_phoff = f.u32(d, 28); this.e_shoff = f.u32(d, 32);
    this.e_flags = f.u32(d, 36); this.e_ehsize = f.u16(d, 40); this.e_phentsize = f.u16(d, 42);
    this.e_phnum = f.u16(d, 44); this.e_shentsize = f.u16(d, 46); this.e_shnum = f.u16(d, 48); this.e_shstrndx = f.u16(d, 50);
    if (this.e_type !== 1) throw new Failure("not a relocatable object");
    if (this.e_machine !== 8) throw new Failure("not a MIPS object");
    if (this.e_phoff !== 0 || this.e_shoff === 0 || this.e_shstrndx === SHN_UNDEF) throw new Failure("unexpected ELF layout");
  }
  toBin() {
    return Buffer.concat([this.e_ident, this.fmt.pack([[16, this.e_type], [16, this.e_machine], [32, this.e_version], [32, this.e_entry],
      [32, this.e_phoff], [32, this.e_shoff], [32, this.e_flags], [16, this.e_ehsize], [16, this.e_phentsize], [16, this.e_phnum],
      [16, this.e_shentsize], [16, this.e_shnum], [16, this.e_shstrndx]])]);
  }
}

class Symbol {
  constructor(fmt, data, strtab, name) {
    this.fmt = fmt;
    this.st_name = fmt.u32(data, 0); this.st_value = fmt.u32(data, 4); this.st_size = fmt.u32(data, 8);
    const info = data[12]; this.st_other = data[13]; this.st_shndx = fmt.u16(data, 14);
    if (this.st_shndx === SHN_XINDEX) throw new Failure("too many sections (SHN_XINDEX not supported)");
    this.st_bind = info >> 4; this.st_type = info & 0xf;
    this.name = name != null ? name : strtab.lookupStr(this.st_name);
    this.st_visibility = this.st_other & 3;
  }
  static fromParts(fmt, { st_name, st_value, st_size, st_info, st_other, st_shndx, strtab, name }) {
    return new Symbol(fmt, fmt.pack([[32, st_name], [32, st_value], [32, st_size], [8, st_info], [8, st_other], [16, st_shndx]]), strtab, name);
  }
  toBin() {
    return this.fmt.pack([[32, this.st_name], [32, this.st_value], [32, this.st_size], [8, (this.st_bind << 4) | this.st_type], [8, this.st_other], [16, this.st_shndx]]);
  }
}

class Relocation {
  constructor(fmt, data, shType) {
    this.fmt = fmt; this.shType = shType;
    this.r_offset = fmt.u32(data, 0);
    const info = fmt.u32(data, 4);
    if (shType !== SHT_REL) this.r_addend = fmt.u32(data, 8);
    this.sym_index = info >>> 8; this.rel_type = info & 0xff;
  }
  toBin() {
    const info = ((this.sym_index << 8) | this.rel_type) >>> 0;
    return this.shType === SHT_REL ? this.fmt.pack([[32, this.r_offset], [32, info]]) : this.fmt.pack([[32, this.r_offset], [32, info], [32, this.r_addend]]);
  }
}

class Section {
  constructor(fmt, header, data, index) {
    this.fmt = fmt;
    const f = fmt, h = header;
    this.sh_name = f.u32(h, 0); this.sh_type = f.u32(h, 4); this.sh_flags = f.u32(h, 8); this.sh_addr = f.u32(h, 12);
    this.sh_offset = f.u32(h, 16); this.sh_size = f.u32(h, 20); this.sh_link = f.u32(h, 24); this.sh_info = f.u32(h, 28);
    this.sh_addralign = f.u32(h, 32); this.sh_entsize = f.u32(h, 36);
    if (this.sh_flags & SHF_LINK_ORDER) throw new Failure("SHF_LINK_ORDER sections are not supported");
    if (this.sh_entsize !== 0 && this.sh_size % this.sh_entsize !== 0) throw new Failure("section size not a multiple of entsize");
    this.data = this.sh_type === SHT_NOBITS ? Buffer.alloc(0) : Buffer.from(data.subarray(this.sh_offset, this.sh_offset + this.sh_size));
    this.index = index;
    this.relocatedBy = [];
  }
  static fromParts(fmt, { sh_name, sh_type, sh_flags, sh_link, sh_info, sh_addralign, sh_entsize, data, index }) {
    const header = fmt.pack([[32, sh_name], [32, sh_type], [32, sh_flags], [32, 0], [32, 0], [32, data.length], [32, sh_link], [32, sh_info], [32, sh_addralign], [32, sh_entsize]]);
    return new Section(fmt, header, data, index);
  }
  lookupStr(index) {
    const to = this.data.indexOf(0, index);
    if (to < 0) throw new Failure("unterminated string in string table");
    return this.data.subarray(index, to).toString("latin1");
  }
  addStr(s) {
    const ret = this.data.length;
    this.data = Buffer.concat([this.data, Buffer.from(s, "latin1"), Buffer.from([0])]);
    return ret;
  }
  isRel() { return this.sh_type === SHT_REL || this.sh_type === SHT_RELA; }
  headerToBin() {
    if (this.sh_type !== SHT_NOBITS) this.sh_size = this.data.length;
    return this.fmt.pack([[32, this.sh_name], [32, this.sh_type], [32, this.sh_flags], [32, this.sh_addr], [32, this.sh_offset],
      [32, this.sh_size], [32, this.sh_link], [32, this.sh_info], [32, this.sh_addralign], [32, this.sh_entsize]]);
  }
  initRelocs() {
    this.relocations = [];
    for (let i = 0; i < this.sh_size; i += this.sh_entsize) this.relocations.push(new Relocation(this.fmt, this.data.subarray(i, i + this.sh_entsize), this.sh_type));
  }
  relocateMdebug(originalOffset) {
    const f = this.fmt, d = Buffer.from(this.data);
    const shift = this.sh_offset - originalOffset;
    if (f.u16(d, 0) !== 0x7009) throw new Failure("Invalid magic value for .mdebug symbolic header");
    // HDRR: (count field offset, offset field offset) pairs.
    const pairs = [[8, 12], [16, 20], [24, 28], [32, 36], [40, 44], [48, 52], [56, 60], [64, 68], [72, 76], [80, 84], [88, 92]];
    for (const [cnt, off] of pairs) {
      if (f.u32(d, cnt)) {
        const v = (f.u32(d, off) + shift) >>> 0;
        f.big ? d.writeUInt32BE(v, off) : d.writeUInt32LE(v, off);
      }
    }
    this.data = d;
  }
}

class ElfFile {
  constructor(data) {
    this.data = data;
    if (data.subarray(0, 4).toString("latin1") !== "\x7fELF") throw new Failure("not an ELF file");
    this.elfHeader = new ElfHeader(data.subarray(0, 52));
    this.fmt = this.elfHeader.fmt;
    const offset = this.elfHeader.e_shoff, size = this.elfHeader.e_shentsize;
    const nullSection = new Section(this.fmt, data.subarray(offset, offset + size), data, 0);
    const num = this.elfHeader.e_shnum || nullSection.sh_size;
    this.sections = [nullSection];
    for (let i = 1; i < num; i++) {
      const ind = offset + i * size;
      this.sections.push(new Section(this.fmt, data.subarray(ind, ind + size), data, i));
    }
    let symtab = null;
    for (const s of this.sections) if (s.sh_type === SHT_SYMTAB) { if (symtab) throw new Failure("two symbol tables"); symtab = s; }
    if (!symtab) throw new Failure("no symbol table");
    this.symtab = symtab;
    this.symStrtab = this.sections[symtab.sh_link];
    if (symtab.sh_entsize !== 16) throw new Failure("unexpected symtab entsize");
    this.symbolEntries = [];
    for (let i = 0; i < symtab.sh_size; i += 16) this.symbolEntries.push(new Symbol(this.fmt, symtab.data.subarray(i, i + 16), this.symStrtab));
    const shstr = this.sections[this.elfHeader.e_shstrndx];
    for (const s of this.sections) {
      s.name = shstr.lookupStr(s.sh_name);
      if (s.isRel()) { this.sections[s.sh_info].relocatedBy.push(s); s.initRelocs(); }
    }
  }
  findSymbol(name) {
    for (const s of this.symbolEntries) if (s.name === name) return [s.st_shndx, s.st_value];
    return null;
  }
  findSymbolInSection(name, section) {
    const pos = this.findSymbol(name);
    if (!pos) throw new Failure(`symbol ${name} not found`);
    if (pos[0] !== section.index) throw new Failure(`symbol ${name} not in section ${section.name}`);
    return pos[1];
  }
  findSection(name) { return this.sections.find((s) => s.name === name) ?? null; }
  addSection(name, { sh_type, sh_flags, sh_link, sh_info, sh_addralign, sh_entsize, data }) {
    const shstr = this.sections[this.elfHeader.e_shstrndx];
    const sh_name = shstr.addStr(name);
    const s = Section.fromParts(this.fmt, { sh_name, sh_type, sh_flags, sh_link, sh_info, sh_addralign, sh_entsize, data, index: this.sections.length });
    this.sections.push(s);
    s.name = name;
    return s;
  }
  dropMdebugGptab() {
    while ([SHT_MIPS_DEBUG, SHT_MIPS_GPTAB].includes(this.sections[this.sections.length - 1].sh_type)) this.sections.pop();
  }
  toBuffer() {
    const parts = [];
    let outidx = 0;
    const out = (b) => { parts.push(b); outidx += b.length; };
    const pad = (align) => { if (align && outidx % align) out(Buffer.alloc(align - (outidx % align))); };
    this.elfHeader.e_shnum = this.sections.length;
    out(this.elfHeader.toBin());
    for (const s of this.sections) {
      if (s.sh_type !== SHT_NOBITS && s.sh_type !== SHT_NULL) {
        pad(s.sh_addralign);
        const old = s.sh_offset;
        s.sh_offset = outidx;
        if (s.sh_type === SHT_MIPS_DEBUG && s.sh_offset !== old) s.relocateMdebug(old);
        out(s.data);
      }
    }
    pad(4);
    this.elfHeader.e_shoff = outidx;
    for (const s of this.sections) out(s.headerToBin());
    const buf = Buffer.concat(parts);
    this.elfHeader.toBin().copy(buf, 0);
    return buf;
  }
}

// -- preprocess ----------------------------------------------------------
function isTempName(name) { return name.startsWith("_asmpp_"); }

const reCommentOrString = /#.*|\/\*.*?\*\/|"(?:\\.|[^\\"])*"/g;
function stripComments(line) { return line.replace(reCommentOrString, (s) => ("/#".includes(s[0]) ? " " : s)); }

class SectionSizing { constructor() { this.size = 0; this.align8 = 0; this.alignedFromContext = false; } }

class GlobalState {
  constructor(minInstrCount, skipInstrCount, useJtblForRodata, preludeIfLateRodata, mips1, pascal) {
    this.lateRodataHex = 0xE0123456;
    this.valuectr = 0; this.namectr = 0;
    Object.assign(this, { minInstrCount, skipInstrCount, useJtblForRodata, preludeIfLateRodata, mips1, pascal });
  }
  nextLateRodataHex() {
    const b = Buffer.alloc(4); b.writeUInt32BE(this.lateRodataHex >>> 0, 0);
    if ((this.lateRodataHex & 0xffff) === 0) this.lateRodataHex += 1;
    this.lateRodataHex += 1;
    return b;
  }
  makeName(cat) { this.namectr += 1; return `_asmpp_${cat}${this.namectr}`; }
  funcPrologue(name) {
    if (this.pascal) return [`procedure ${name}();`, "type", " pi = ^integer;", " pf = ^single;", " pd = ^double;", "var", " vi: pi;", " vf: pf;", " vd: pd;", "begin", " vi := vi;", " vf := vf;", " vd := vd;"].join(" ");
    return `void ${name}(void) {`;
  }
  funcEpilogue() { return this.pascal ? "end;" : "}"; }
  pascalAssignment(tp, val) {
    this.valuectr += 1;
    const address = (8 * this.valuectr) & 0x7fff;
    return `v${tp} := p${tp}(${address}); v${tp}^ := ${val};`;
  }
}

class GlobalAsmBlock {
  constructor(fnDesc) {
    this.fnDesc = fnDesc;
    this.curSection = ".text";
    this.asmConts = []; this.lateRodataAsmConts = []; this.textGlabels = [];
    this.fnSectionSizes = { ".text": new SectionSizing(), ".data": new SectionSizing(), ".bss": new SectionSizing(), ".rodata": new SectionSizing(), ".late_rodata": new SectionSizing() };
    this.fnInsInds = [];
    this.gluedLine = "";
    this.numLines = 0;
  }
  fail(message, line) {
    let context = this.fnDesc;
    if (line) context += `, at line "${line}"`;
    throw new Failure(`${message}\nwithin ${context}`);
  }
  countQuotedSize(line0, z, realLine, outputEnc) {
    const line = outputEnc.encode(line0).toString("latin1");
    let inQuote = false, hasComma = true, numParts = 0, ret = 0, i = 0;
    const digits = "0123456789";
    while (i < line.length) {
      let c = line[i]; i += 1;
      if (!inQuote) {
        if (c === '"') { inQuote = true; if (z && !hasComma) this.fail(".asciiz with glued strings is not supported due to GNU as version diffs"); numParts += 1; }
        else if (c === ",") hasComma = true;
      } else {
        if (c === '"') { inQuote = false; hasComma = false; continue; }
        ret += 1;
        if (c !== "\\") continue;
        if (i === line.length) this.fail("backslash at end of line not supported", realLine);
        c = line[i]; i += 1;
        if (c === "x") { while (i < line.length && (digits + "abcdefABCDEF").includes(line[i])) i += 1; }
        else if (digits.includes(c)) { let it = 0; while (i < line.length && digits.includes(line[i]) && it < 2) { i += 1; it += 1; } }
      }
    }
    if (inQuote) this.fail("unterminated string literal", realLine);
    if (numParts === 0) this.fail(".ascii with no string", realLine);
    return z ? ret + numParts : ret;
  }
  align(n) { const s = this.fnSectionSizes[this.curSection]; while (s.size % n !== 0) s.size += 1; }
  align8(realLine) {
    this.align(4);
    const s = this.fnSectionSizes[this.curSection];
    const a8 = s.size % 8;
    if (!s.align8) { s.align8 = 8 - a8; s.alignedFromContext = true; }
    else if (s.align8 !== 8 - a8) {
      if (s.alignedFromContext) this.fail("found two .double directives with different start addresses mod 8. Make sure to provide explicit alignment padding.", realLine);
      else this.fail(".double at address that is not 0 mod 8 (based on .late_rodata_alignment assumption). Make sure to provide explicit alignment padding.", realLine);
    }
  }
  addSized(size, line) {
    if ([".text", ".late_rodata"].includes(this.curSection) && size % 4 !== 0) this.fail("size must be a multiple of 4", line);
    if (size < 0) this.fail("size cannot be negative", line);
    this.fnSectionSizes[this.curSection].size += size;
    if (this.curSection === ".text") {
      if (!this.textGlabels.length) this.fail(".text block without an initial glabel", line);
      this.fnInsInds.push([this.numLines - 1, Math.floor(size / 4)]);
    }
  }
  processLine(line, outputEnc) {
    this.numLines += 1;
    if (line.endsWith("\\")) { this.gluedLine += line.slice(0, -1); return; }
    line = this.gluedLine + line;
    this.gluedLine = "";
    let realLine = line;
    line = stripComments(line);
    line = strip(line);
    line = line.replace(/^[a-zA-Z0-9_]+:\s*/, "");
    let changedSection = false, emittingDouble = false;
    if ((line.startsWith("glabel ") || line.startsWith("jlabel ")) && this.curSection === ".text") this.textGlabels.push(pySplit(line)[1]);
    if (!line) { /* empty */ }
    else if (line.startsWith("glabel ") || line.startsWith("dlabel ") || line.startsWith("jlabel ") || line.startsWith("alabel ") || line.startsWith("endlabel ") || line.startsWith("enddlabel ") || line.startsWith("nonmatching ") || (!line.includes(" ") && line.endsWith(":"))) { /* label */ }
    else if (line.startsWith(".section") || [".text", ".data", ".rdata", ".rodata", ".bss", ".late_rodata"].includes(line)) {
      const parts = pySplit(line.split(",")[0]);
      this.curSection = line === ".rdata" ? ".rodata" : parts[parts.length - 1];
      if (![".data", ".text", ".rodata", ".late_rodata", ".bss"].includes(this.curSection)) this.fail("unrecognized .section directive", realLine);
      changedSection = true;
    } else if (line.startsWith(".late_rodata_alignment")) {
      if (this.curSection !== ".late_rodata") this.fail(".late_rodata_alignment must occur within .late_rodata section", realLine);
      const value = pyInt(pySplit(line)[1]);
      if (![4, 8].includes(value)) this.fail(".late_rodata_alignment argument must be 4 or 8", realLine);
      const s = this.fnSectionSizes[".late_rodata"];
      if (s.align8 && s.align8 !== value) this.fail(".late_rodata_alignment alignment assumption conflicts with earlier .double directive. Make sure to provide explicit alignment padding.");
      s.align8 = value;
      changedSection = true;
    } else if (line.startsWith(".incbin")) {
      const parts = line.split(",");
      this.addSized(pyInt0(parts[parts.length - 1]), realLine);
    } else if (line.startsWith(".word") || line.startsWith(".gpword") || line.startsWith(".float")) {
      this.align(4); this.addSized(4 * line.split(",").length, realLine);
    } else if (line.startsWith(".double")) {
      this.align8(realLine); this.addSized(8 * line.split(",").length, realLine); emittingDouble = true;
    } else if (line.startsWith(".space")) {
      this.addSized(pyInt0(pySplit(line)[1]), realLine);
    } else if (line.startsWith(".balign")) {
      const align = pyInt(pySplit(line)[1]);
      if (align === 4) this.align(4);
      else if (align === 8) { this.align8(realLine); realLine = ".balign 4"; }
      else this.fail("only .balign 4 is supported", realLine);
    } else if (line.startsWith(".align")) {
      const align = pyInt(pySplit(line)[1]);
      if (align === 2) this.align(4);
      else if (align === 3) { this.align8(realLine); realLine = ".align 2"; }
      else this.fail("only .align 2 is supported", realLine);
    } else if (line.startsWith(".asci")) {
      const z = line.startsWith(".asciz") || line.startsWith(".asciiz");
      this.addSized(this.countQuotedSize(line, z, realLine, outputEnc), realLine);
    } else if (line.startsWith(".byte")) {
      this.addSized(line.split(",").length, realLine);
    } else if (line.startsWith(".half") || line.startsWith(".hword") || line.startsWith(".short")) {
      this.align(2); this.addSized(2 * line.split(",").length, realLine);
    } else if (line.startsWith(".size")) { /* ignored */ }
    else if (line.startsWith(".")) this.fail("asm directive not supported", realLine);
    else {
      if (this.curSection !== ".text") this.fail("instruction or macro call in non-.text section? not supported", realLine);
      this.addSized(4, realLine);
    }
    if (this.curSection === ".late_rodata") {
      if (!changedSection) {
        if (emittingDouble) this.lateRodataAsmConts.push(".align 0");
        this.lateRodataAsmConts.push(realLine);
        if (emittingDouble) this.lateRodataAsmConts.push(".align 2");
      }
    } else this.asmConts.push(realLine);
  }
  finish(state) {
    const src = new Array(this.numLines + 1).fill("");
    const lateRodataDummyBytes = [];
    let jtblRodataSize = 0;
    const lateRodataFnOutput = [];
    const numInstr = Math.floor(this.fnSectionSizes[".text"].size / 4);
    const lateRodataAlignment = this.fnSectionSizes[".late_rodata"].align8;
    if (this.fnSectionSizes[".late_rodata"].size > 0) {
      const size = Math.floor(this.fnSectionSizes[".late_rodata"].size / 4);
      let skipNext = false, needsDouble = lateRodataAlignment !== 0, extraMips1Nop = false;
      const [jtblSize, jtblMinRodataSize] = state.pascal ? [state.mips1 ? 9 : 8, 2] : [state.mips1 ? 11 : 9, 5];
      for (let i = 0; i < size; i++) {
        if (skipNext) { skipNext = false; continue; }
        if (!needsDouble && state.useJtblForRodata && i >= 1 && size - i >= jtblMinRodataSize && numInstr - lateRodataFnOutput.length >= jtblSize + 1) {
          let line;
          if (state.pascal) line = "case 0 of " + Array.from({ length: size - i }, (_, c) => `${c}: ;`).join("\n") + " otherwise end;";
          else line = "switch (*(volatile int*)0) { " + Array.from({ length: size - i }, (_, c) => `case ${c}:`).join(" ") + " ; }";
          lateRodataFnOutput.push(line);
          for (let k = 0; k < jtblSize - 1; k++) lateRodataFnOutput.push("");
          jtblRodataSize = (size - i) * 4;
          extraMips1Nop = i !== 2;
          break;
        }
        const dummy = state.nextLateRodataHex();
        lateRodataDummyBytes.push(dummy);
        if (lateRodataAlignment === 4 * (((i + 1) % 2) + 1) && i + 1 < size) {
          const dummy2 = state.nextLateRodataHex();
          lateRodataDummyBytes.push(dummy2);
          const fval = Buffer.concat([dummy, dummy2]).readDoubleBE(0);
          lateRodataFnOutput.push(state.pascal ? state.pascalAssignment("d", pyFloatRepr(fval)) : `*(volatile double*)0 = ${pyFloatRepr(fval)};`);
          skipNext = true; needsDouble = false;
          if (state.mips1) { lateRodataFnOutput.push(""); lateRodataFnOutput.push(""); }
          extraMips1Nop = false;
        } else {
          const fval = dummy.readFloatBE(0);
          lateRodataFnOutput.push(state.pascal ? state.pascalAssignment("f", pyFloatRepr(fval)) : `*(volatile float*)0 = ${pyFloatRepr(fval)}f;`);
          extraMips1Nop = true;
        }
        lateRodataFnOutput.push(""); lateRodataFnOutput.push("");
      }
      if (state.mips1 && extraMips1Nop) lateRodataFnOutput.push("");
    }
    let textName = null;
    if (this.fnSectionSizes[".text"].size > 0 || lateRodataFnOutput.length) {
      textName = state.makeName("func");
      src[0] = state.funcPrologue(textName);
      src[this.numLines] = state.funcEpilogue();
      const instrCount = Math.floor(this.fnSectionSizes[".text"].size / 4);
      if (instrCount < state.minInstrCount) this.fail("too short .text block");
      let totEmitted = 0, totSkipped = 0, fnEmitted = 0, fnSkipped = 0, skipping = true;
      const rodataStack = lateRodataFnOutput.slice().reverse();
      for (const [line, count] of this.fnInsInds) {
        for (let k = 0; k < count; k++) {
          if (fnEmitted > MAX_FN_SIZE && instrCount - totEmitted > state.minInstrCount && (!rodataStack.length || rodataStack[rodataStack.length - 1])) {
            fnEmitted = 0; fnSkipped = 0; skipping = true;
            src[line] += " " + state.funcEpilogue() + " " + state.funcPrologue(state.makeName("large_func")) + " ";
          }
          if (skipping && fnSkipped < state.skipInstrCount + (rodataStack.length ? state.preludeIfLateRodata : 0)) { fnSkipped += 1; totSkipped += 1; }
          else {
            skipping = false;
            if (rodataStack.length) src[line] += rodataStack.pop();
            else if (state.pascal) src[line] += state.pascalAssignment("i", "0");
            else src[line] += "*(volatile int*)0 = 0;";
          }
          totEmitted += 1; fnEmitted += 1;
        }
      }
      if (rodataStack.length) {
        const size = Math.floor(lateRodataFnOutput.length / 3);
        const available = instrCount - totSkipped;
        this.fail(`late rodata to text ratio is too high: ${size} / ${available} must be <= 1/3\nadd .late_rodata_alignment (4|8) to the .late_rodata block to double the allowed ratio.`);
      }
    }
    let rodataName = null;
    if (this.fnSectionSizes[".rodata"].size > 0) {
      if (state.pascal) this.fail(".rodata isn't supported with Pascal for now");
      rodataName = state.makeName("rodata");
      src[this.numLines] += ` const char ${rodataName}[${this.fnSectionSizes[".rodata"].size}] = {1};`;
    }
    let dataName = null;
    if (this.fnSectionSizes[".data"].size > 0) {
      dataName = state.makeName("data");
      src[this.numLines] += state.pascal ? ` var ${dataName}: packed array[1..${this.fnSectionSizes[".data"].size}] of char := [otherwise: 0];` : ` char ${dataName}[${this.fnSectionSizes[".data"].size}] = {1};`;
    }
    let bssName = null;
    if (this.fnSectionSizes[".bss"].size > 0) {
      if (state.pascal) this.fail(".bss isn't supported with Pascal");
      bssName = state.makeName("bss");
      src[this.numLines] += ` char ${bssName}[${this.fnSectionSizes[".bss"].size}];`;
    }
    const fn = {
      textGlabels: this.textGlabels, asmConts: this.asmConts, lateRodataDummyBytes, jtblRodataSize,
      lateRodataAsmConts: this.lateRodataAsmConts, fnDesc: this.fnDesc,
      // Insertion order matters (Python dict): .text, .data, .rodata, .bss.
      data: [[".text", textName, this.fnSectionSizes[".text"]], [".data", dataName, this.fnSectionSizes[".data"]],
        [".rodata", rodataName, this.fnSectionSizes[".rodata"]], [".bss", bssName, this.fnSectionSizes[".bss"]]],
    };
    return { src, fn };
  }
}

const cutsceneDataRe = /CutsceneData (.|\n)*\[\] = {/;
const floatRe = /[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?f/g;
function replFloatHex(m) {
  const b = Buffer.alloc(4); b.writeFloatBE(parseFloat(strip(m).replace(/f+$/, "")), 0);
  return String(b.readUInt32BE(0));
}

/**
 * parse_source: returns the preprocessed text lines (or null) and the functions.
 * @param {{name:string, text:string}} f
 */
export function parseSource(f, opts, outDependencies, { printSource = true, readText } = {}) {
  let minInstrCount, skipInstrCount;
  if (["O1", "O2"].includes(opts.opt)) [minInstrCount, skipInstrCount] = opts.framepointer ? [6, 5] : [2, 1];
  else if (opts.opt === "O0") [minInstrCount, skipInstrCount] = opts.framepointer ? [8, 8] : [4, 4];
  else if (opts.opt === "g") [minInstrCount, skipInstrCount] = opts.framepointer ? [7, 7] : [4, 4];
  else if (opts.opt === "g3") [minInstrCount, skipInstrCount] = opts.framepointer ? [4, 4] : [2, 2];
  else throw new Failure("must pass one of -g, -O0, -O1, -O2, -O2 -g3");
  let preludeIfLateRodata = 0;
  if (opts.kpic) {
    if (["g3", "O2"].includes(opts.opt)) preludeIfLateRodata = 3;
    else { minInstrCount += 3; skipInstrCount += 3; }
  }
  const useJtblForRodata = ["O2", "g3"].includes(opts.opt) && !opts.framepointer && !opts.kpic;
  const state = new GlobalState(minInstrCount, skipInstrCount, useJtblForRodata, preludeIfLateRodata, opts.mips1, opts.pascal);
  const outputEnc = opts.outputEnc;
  let globalAsm = null, startIndex = 0;
  const asmFunctions = [];
  const baseFname = f.name;
  const outputLines = [`#line 1 "${baseFname}"`];
  let isCutsceneData = false, isEarlyInclude = false;
  const lines = pyLines(f.text);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    let rawLine = rstrip(lines[idx]);
    const line = lstrip(rawLine);
    outputLines.push("");
    if (globalAsm !== null) {
      if (line.startsWith(")")) {
        const { src, fn } = globalAsm.finish(state);
        if (state.pascal) src[src.length - 1] += "\n#line " + (lineNo + 1);
        for (let i = 0; i < src.length; i++) outputLines[startIndex + i] = src[i];
        asmFunctions.push(fn);
        globalAsm = null;
      } else globalAsm.processLine(rawLine, outputEnc);
    } else if (line === "GLOBAL_ASM(" || line === "#pragma GLOBAL_ASM(") {
      globalAsm = new GlobalAsmBlock("GLOBAL_ASM block at line " + lineNo);
      startIndex = outputLines.length;
    } else if (((line.startsWith('GLOBAL_ASM("') || line.startsWith('#pragma GLOBAL_ASM("')) && line.endsWith('")'))
      || ((line.startsWith('INCLUDE_ASM("') || line.startsWith('INCLUDE_RODATA("')) && line.includes('",') && line.endsWith(");"))) {
      let prologue = [], fname;
      if (line.startsWith("INCLUDE_")) {
        const k = line.indexOf('",');
        const before = line.slice(0, k), after = line.slice(k + 2);
        fname = before.slice(before.indexOf("(") + 2) + "/" + strip(after).slice(0, -2) + ".s";
        if (line.startsWith("INCLUDE_RODATA")) prologue = [".section .rodata"];
      } else fname = line.slice(line.indexOf("(") + 2, -2);
      const ext = new GlobalAsmBlock(fname);
      for (const l2 of prologue) ext.processLine(l2, outputEnc);
      const text = readText(fname, opts.inputEnc);
      if (text == null) {
        outputLines[outputLines.length - 1] = `#include "GLOBAL_ASM:${fname}"`;
        continue;
      }
      for (const l2 of pyLines(text)) ext.processLine(rstrip(l2), outputEnc);
      const { src, fn } = ext.finish(state);
      if (state.pascal) { src.push("#line " + (lineNo + 1)); outputLines[outputLines.length - 1] = src.join("\n"); }
      else outputLines[outputLines.length - 1] = src.join("");
      asmFunctions.push(fn);
      outDependencies.push(fname);
    } else if (line === "#pragma asmproc recurse") {
      isEarlyInclude = true;
    } else if (isEarlyInclude) {
      isEarlyInclude = false;
      if (!line.startsWith("#include ")) throw new Failure("#pragma asmproc recurse must be followed by an #include");
      // os.path.dirname / os.path.join (no normalisation).
      const slash = baseFname.lastIndexOf("/");
      const fpath = slash < 0 ? "" : (baseFname.slice(0, slash).replace(/\/+$/, "") || "/");
      const rel = line.slice(line.indexOf(" ") + 2, -1);
      const fname = rel.startsWith("/") ? rel : (fpath ? (fpath.endsWith("/") ? fpath : fpath + "/") + rel : rel);
      outDependencies.push(fname);
      const text = readText(fname, opts.inputEnc);
      if (text == null) throw new Failure(`No such file or directory: '${fname}'`);
      // As upstream: the included file gets its own GlobalState and its asm
      // functions are NOT post-processed (parse_source's return is discarded).
      const inner = parseSource({ name: fname, text }, opts, outDependencies, { printSource: true, readText });
      outputLines[outputLines.length - 1] = inner.lines.map((l) => l + "\n").join("") + `#line ${lineNo + 1} "${baseFname}"`;
    } else {
      if (opts.encodeCutsceneDataFloats) {
        if (cutsceneDataRe.test(line)) isCutsceneData = true;
        else if (line.endsWith("};")) isCutsceneData = false;
        if (isCutsceneData) rawLine = rawLine.replace(floatRe, replFloatHex);
      }
      outputLines[outputLines.length - 1] = rawLine;
    }
  }
  return { functions: asmFunctions, lines: printSource ? outputLines : null };
}

/** Serialize preprocessed lines to bytes in the output encoding. */
export function encodeLines(lines, outputEnc) {
  const nl = outputEnc.encode("\n");
  const parts = [];
  for (const l of lines) { parts.push(outputEnc.encode(l)); parts.push(nl); }
  return Buffer.concat(parts);
}

// -- post-process --------------------------------------------------------
const SECTIONS = [".data", ".text", ".rodata", ".bss"];

/**
 * fixup_objfile: splice the assembled GLOBAL_ASM into the compiled object.
 * @param {(sPath:string, oPath:string)=>Promise<void>} assemble throws on failure
 */
export async function fixupObjfile({ objfileName, objfilePath, functions, asmPrelude, assemble, outputEnc, dropMdebugGptab, convertStatics, tmpDir }) {
  const objfile = new ElfFile(await readFile(objfilePath));
  const fmt = objfile.fmt;
  const prevLocs = { ".text": 0, ".data": 0, ".rodata": 0, ".bss": 0 };
  const toCopy = { ".text": [], ".data": [], ".rodata": [], ".bss": [] };
  const asm = [];
  const allLateRodataDummyBytes = [], allJtblRodataSize = [], lateRodataAsm = [];
  let lateRodataSourceNameStart = null, lateRodataSourceNameEnd = null;
  const allTextGlabels = new Set();
  const funcSizes = new Map();
  for (const fn of functions) {
    let ifdefed = false;
    for (const [sectype, tempName, sizing] of fn.data) {
      if (tempName === null) continue;
      if (!(sizing.size > 0)) throw new Failure("empty section block");
      let loc = objfile.findSymbol(tempName);
      if (loc === null) { ifdefed = true; break; }
      loc = loc[1];
      const prevLoc = prevLocs[sectype];
      if (loc < prevLoc) throw new Failure(`Wrongly computed size for section ${sectype} (diff ${prevLoc - loc}). This is an asm-processor bug!`);
      if (loc !== prevLoc) {
        asm.push(".section " + sectype);
        if (sectype === ".text") for (let i = 0; i < Math.floor((loc - prevLoc) / 4); i++) asm.push("nop");
        else asm.push(`.space ${loc - prevLoc}`);
      }
      if (sizing.align8 !== 0 && sizing.align8 !== 8 - (loc % 8)) throw new Failure(`${fn.fnDesc} has unexpected alignment mod 8 for section ${sectype}. Please provide explicit alignment padding.`);
      toCopy[sectype].push([loc, sizing.size, tempName, fn.fnDesc]);
      if (fn.textGlabels.length && sectype === ".text") funcSizes.set(fn.textGlabels[0], sizing.size);
      prevLocs[sectype] = loc + sizing.size;
    }
    if (!ifdefed) {
      for (const g of fn.textGlabels) allTextGlabels.add(g);
      allLateRodataDummyBytes.push(fn.lateRodataDummyBytes);
      allJtblRodataSize.push(fn.jtblRodataSize);
      lateRodataAsm.push(fn.lateRodataAsmConts);
      for (const [sectype, tempName] of fn.data) if (tempName !== null) { asm.push(".section " + sectype); asm.push("glabel " + tempName + "_asm_start"); }
      asm.push(".text");
      for (const l of fn.asmConts) asm.push(l);
      for (const [sectype, tempName] of fn.data) if (tempName !== null) { asm.push(".section " + sectype); asm.push("glabel " + tempName + "_asm_end"); }
    }
  }
  if (lateRodataAsm.some((c) => c.length)) {
    lateRodataSourceNameStart = "_asmpp_late_rodata_start";
    lateRodataSourceNameEnd = "_asmpp_late_rodata_end";
    asm.push(".section .late_rodata");
    asm.push(".word 0, 0");
    asm.push(`glabel ${lateRodataSourceNameStart}`);
    for (const c of lateRodataAsm) asm.push(...c);
    asm.push(`glabel ${lateRodataSourceNameEnd}`);
  }

  await mkdir(tmpDir, { recursive: true });
  const id = randomUUID().slice(0, 12);
  const sName = path.join(tmpDir, `asm-processor${id}.s`);
  const oName = path.join(tmpDir, `asm-processor${id}.o`);
  try {
    await writeFile(sName, Buffer.concat([asmPrelude, Buffer.from("\n"), ...asm.flatMap((l) => [outputEnc.encode(l), Buffer.from("\n")])]));
    await assemble(sName, oName);
    const asmObjfile = new ElfFile(await readFile(oName));

    const mdebugSection = objfile.findSection(".mdebug");
    if (dropMdebugGptab) objfile.dropMdebugGptab();

    const targetReginfo = objfile.findSection(".reginfo");
    if (targetReginfo !== null) {
      const src = asmObjfile.findSection(".reginfo").data;
      const data = Buffer.from(targetReginfo.data);
      for (let i = 0; i < 20; i++) data[i] |= src[i];
      targetReginfo.data = data;
    }

    const modifiedTextPositions = new Set(), jtblRodataPositions = new Set();
    let lastRodataPos = 0;
    for (const sectype of SECTIONS) {
      if (!toCopy[sectype].length) continue;
      const source = asmObjfile.findSection(sectype);
      if (!source) throw new Failure("didn't find source section: " + sectype);
      for (const [pos, count, tempName, fnDesc] of toCopy[sectype]) {
        const loc1 = asmObjfile.findSymbolInSection(tempName + "_asm_start", source);
        const loc2 = asmObjfile.findSymbolInSection(tempName + "_asm_end", source);
        if (loc1 !== pos) throw new Failure("assembly and C files don't line up for section " + sectype + ", " + fnDesc);
        if (loc2 - loc1 !== count) throw new Failure("incorrectly computed size for section " + sectype + ", " + fnDesc + ". If using .double, make sure to provide explicit alignment padding.");
      }
      if (sectype === ".bss") continue;
      const target = objfile.findSection(sectype);
      if (!target) throw new Failure("missing target section of type " + sectype);
      const data = Buffer.from(target.data);
      for (const [pos, count] of toCopy[sectype]) {
        spliceInto(data, pos, source.data.subarray(pos, pos + count), count);
        if (sectype === ".text") { for (let i = 0; i < count / 4; i++) modifiedTextPositions.add(pos + 4 * i); }
        else if (sectype === ".rodata") lastRodataPos = pos + count;
      }
      target.data = data;
    }

    const movedLateRodata = new Map();
    if (allLateRodataDummyBytes.some((l) => l.length) || allJtblRodataSize.some((x) => x)) {
      const source = asmObjfile.findSection(".late_rodata");
      const target = objfile.findSection(".rodata");
      let sourcePos = asmObjfile.findSymbolInSection(lateRodataSourceNameStart, source);
      const sourceEnd = asmObjfile.findSymbolInSection(lateRodataSourceNameEnd, source);
      const total = allLateRodataDummyBytes.reduce((a, l) => a + l.length, 0) * 4 + allJtblRodataSize.reduce((a, b) => a + b, 0);
      if (sourceEnd - sourcePos !== total) throw new Failure("computed wrong size of .late_rodata");
      const newData = Buffer.from(target.data);
      for (let fi = 0; fi < allLateRodataDummyBytes.length; fi++) {
        const dummyList = allLateRodataDummyBytes[fi], jtblSize = allJtblRodataSize[fi];
        for (let index = 0; index < dummyList.length; index++) {
          let dummy = dummyList[index];
          if (!fmt.big) dummy = Buffer.from(dummy).reverse();
          let pos = target.data.indexOf(dummy, lastRodataPos);
          if (pos < 0) throw new Failure("late rodata dummy value not found in .rodata");
          if (index === 0 && dummyList.length > 1 && target.data.subarray(pos + 4, pos + 8).equals(Buffer.alloc(4))) {
            Buffer.alloc(4).copy(newData, pos);
            pos += 4;
          }
          source.data.copy(newData, pos, sourcePos, sourcePos + 4);
          movedLateRodata.set(sourcePos, pos);
          lastRodataPos = pos + 4;
          sourcePos += 4;
        }
        if (jtblSize > 0) {
          if (!dummyList.length) throw new Failure("should always have dummy bytes before jtbl data");
          const pos = lastRodataPos;
          spliceInto(newData, pos, source.data.subarray(sourcePos, sourcePos + jtblSize), jtblSize);
          for (let i = 0; i < jtblSize; i += 4) { movedLateRodata.set(sourcePos + i, pos + i); jtblRodataPositions.add(pos + i); }
          lastRodataPos += jtblSize;
          sourcePos += jtblSize;
        }
      }
      target.data = newData;
    }

    const strtabAdj = objfile.symStrtab.data.length;
    objfile.symStrtab.data = Buffer.concat([objfile.symStrtab.data, asmObjfile.symStrtab.data]);

    const relocatedSymbols = new Set();
    for (const sectype of [...SECTIONS, ".late_rodata"]) {
      const sec = asmObjfile.findSection(sectype);
      if (!sec) continue;
      for (const reltab of sec.relocatedBy) for (const rel of reltab.relocations) relocatedSymbols.add(asmObjfile.symbolEntries[rel.sym_index]);
    }

    const emptySymbol = objfile.symbolEntries[0];
    let newSyms = objfile.symbolEntries.slice(1).filter((s) => !isTempName(s.name));
    for (let i = 0; i < asmObjfile.symbolEntries.length; i++) {
      const s = asmObjfile.symbolEntries[i];
      const isLocal = i < asmObjfile.symtab.sh_info;
      if (isLocal && !relocatedSymbols.has(s)) continue;
      if (isTempName(s.name)) { if (relocatedSymbols.has(s)) throw new Failure("relocation against an asm-processor temporary"); continue; }
      if (s.st_shndx !== SHN_UNDEF && s.st_shndx !== SHN_ABS) {
        const sectionName = asmObjfile.sections[s.st_shndx].name;
        let targetSectionName = sectionName;
        if (sectionName === ".late_rodata") targetSectionName = ".rodata";
        else if (!SECTIONS.includes(sectionName)) throw new Failure("generated assembly .o must only have symbols for .text, .data, .rodata, .late_rodata, ABS and UNDEF, but found " + sectionName);
        const objfileSection = objfile.findSection(targetSectionName);
        if (!objfileSection) throw new Failure("generated assembly .o has section that real objfile lacks: " + targetSectionName);
        s.st_shndx = objfileSection.index;
        if (allTextGlabels.has(s.name)) { s.st_type = STT_FUNC; if (funcSizes.has(s.name)) s.st_size = funcSizes.get(s.name); }
        if (sectionName === ".late_rodata") {
          if (s.st_value === 0) throw new Failure("local symbols in .late_rodata are not allowed");
          s.st_value = movedLateRodata.get(s.st_value);
        }
      }
      s.st_name += strtabAdj;
      newSyms.push(s);
    }
    const makeStaticsGlobal = convertStatics === "global" || convertStatics === "global-with-filename";

    if (mdebugSection && convertStatics !== "no") {
      const staticNameCount = new Map();
      let strtabIndex = objfile.symStrtab.data.length;
      const newStrtabData = [];
      const md = mdebugSection.data, od = objfile.data;
      const ifdMax = fmt.u32(md, 18 * 4), cbFdOffset = fmt.u32(md, 19 * 4);
      const cbSymOffset = fmt.u32(md, 9 * 4), cbSsOffset = fmt.u32(md, 15 * 4);
      for (let i = 0; i < ifdMax; i++) {
        const offset = cbFdOffset + 18 * 4 * i;
        const issBase = fmt.u32(od, offset + 8), isymBase = fmt.u32(od, offset + 16), csym = fmt.u32(od, offset + 20);
        let scopeLevel = 0;
        for (let j = 0; j < csym; j++) {
          const off2 = cbSymOffset + 12 * (isymBase + j);
          const iss = fmt.u32(od, off2), value = fmt.u32(od, off2 + 4), stScIndex = fmt.u32(od, off2 + 8);
          const st = stScIndex >>> 26, sc = (stScIndex >>> 21) & 0x1f;
          if (st === MIPS_DEBUG_ST_STATIC || st === MIPS_DEBUG_ST_STATIC_PROC) {
            const nameOff = cbSsOffset + issBase + iss;
            const nameEnd = od.indexOf(0, nameOff);
            if (nameEnd < 0) throw new Failure("unterminated .mdebug string");
            let symbolName = Buffer.from(od.subarray(nameOff, nameEnd));
            if (scopeLevel > 1) {
              const key = symbolName.toString("latin1");
              const count = (staticNameCount.get(key) ?? 0) + 1;
              staticNameCount.set(key, count);
              symbolName = Buffer.concat([symbolName, Buffer.from(":" + count, "utf8")]);
            }
            let emitted = symbolName;
            if (convertStatics === "global-with-filename") emitted = Buffer.concat([Buffer.from(objfileName, "utf8"), Buffer.from(":"), symbolName]);
            const sectionName = { 1: ".text", 2: ".data", 3: ".bss", 15: ".rodata" }[sc];
            if (!sectionName) throw new Failure(`unexpected .mdebug storage class ${sc}`);
            const section = objfile.findSection(sectionName);
            const symtype = sc === 1 ? STT_FUNC : STT_OBJECT;
            const binding = makeStaticsGlobal ? STB_GLOBAL : STB_LOCAL;
            const sym = Symbol.fromParts(fmt, { st_name: strtabIndex, st_value: value, st_size: 0, st_info: (binding << 4) | symtype, st_other: STV_DEFAULT,
              st_shndx: section.index, strtab: objfile.symStrtab, name: symbolName.toString("latin1") });
            strtabIndex += emitted.length + 1;
            newStrtabData.push(emitted, Buffer.from([0]));
            newSyms.push(sym);
          }
          if ([MIPS_DEBUG_ST_FILE, MIPS_DEBUG_ST_STRUCT, MIPS_DEBUG_ST_UNION, MIPS_DEBUG_ST_ENUM, MIPS_DEBUG_ST_BLOCK, MIPS_DEBUG_ST_PROC, MIPS_DEBUG_ST_STATIC_PROC].includes(st)) scopeLevel += 1;
          if (st === MIPS_DEBUG_ST_END) scopeLevel -= 1;
        }
        if (scopeLevel !== 0) throw new Failure(".mdebug scope levels do not balance");
      }
      objfile.symStrtab.data = Buffer.concat([objfile.symStrtab.data, ...newStrtabData]);
    }

    // Stable sort: defined first, UNDEF after.
    newSyms = stableSort(newSyms, (s) => (s.st_shndx !== SHN_UNDEF ? 0 : 1));
    const oldSyms = [], newerSyms = [];
    const nameToSym = new Map();
    for (const s of newSyms) {
      if (s.name === "_gp_disp") s.st_type = STT_OBJECT;
      if (s.st_bind === STB_LOCAL && s.st_shndx === SHN_UNDEF) throw new Failure(`local symbol "${s.name}" is undefined`);
      if (!s.name) {
        if (s.st_bind !== STB_LOCAL) throw new Failure("global symbol with no name");
        newerSyms.push(s);
      } else {
        const existing = nameToSym.get(s.name);
        if (!existing) { nameToSym.set(s.name, s); newerSyms.push(s); }
        else if (s.st_shndx !== SHN_UNDEF && !(existing.st_shndx === s.st_shndx && existing.st_value === s.st_value)) throw new Failure(`symbol "${s.name}" defined twice`);
        else { s.replaceBy = existing; oldSyms.push(s); }
      }
    }
    newSyms = newerSyms;
    newSyms.unshift(emptySymbol);
    newSyms = stableSort(newSyms, (s) => (s.st_bind !== STB_LOCAL ? 2 : 0) + (s.name === "_gp_disp" ? 1 : 0));
    const numLocalSyms = newSyms.filter((s) => s.st_bind === STB_LOCAL).length;
    newSyms.forEach((s, i) => { s.newIndex = i; });
    for (const s of oldSyms) s.newIndex = s.replaceBy.newIndex;
    objfile.symtab.data = Buffer.concat(newSyms.map((s) => s.toBin()));
    objfile.symtab.sh_info = numLocalSyms;

    for (const sectype of SECTIONS) {
      const target = objfile.findSection(sectype);
      if (!target) continue;
      for (const reltab of target.relocatedBy) {
        const nrels = [];
        for (const rel of reltab.relocations) {
          if ((sectype === ".text" && modifiedTextPositions.has(rel.r_offset)) || (sectype === ".rodata" && jtblRodataPositions.has(rel.r_offset))) continue;
          const ni = objfile.symbolEntries[rel.sym_index].newIndex;
          if (ni === undefined) throw new Failure(`relocation against dropped symbol '${objfile.symbolEntries[rel.sym_index].name}'`);
          rel.sym_index = ni;
          nrels.push(rel);
        }
        reltab.relocations = nrels;
        reltab.data = Buffer.concat(nrels.map((r) => r.toBin()));
      }
    }

    for (const sectype of [...SECTIONS, ".late_rodata"]) {
      const source = asmObjfile.findSection(sectype);
      if (!source || !source.data.length) continue;
      const targetSectype = sectype === ".late_rodata" ? ".rodata" : sectype;
      const target = objfile.findSection(targetSectype);
      if (!target) throw new Failure(targetSectype);
      for (const reltab of source.relocatedBy) {
        for (const rel of reltab.relocations) {
          rel.sym_index = asmObjfile.symbolEntries[rel.sym_index].newIndex;
          if (sectype === ".late_rodata") rel.r_offset = movedLateRodata.get(rel.r_offset);
        }
        const newData = Buffer.concat(reltab.relocations.map((r) => r.toBin()));
        const [prefix, entsize] = reltab.sh_type === SHT_REL ? [".rel", 8] : [".rela", 12];
        let targetReltab = objfile.findSection(prefix + targetSectype);
        if (!targetReltab) targetReltab = objfile.addSection(prefix + targetSectype, { sh_type: reltab.sh_type, sh_flags: 0, sh_link: objfile.symtab.index, sh_info: target.index, sh_addralign: 4, sh_entsize: entsize, data: Buffer.alloc(0) });
        targetReltab.data = Buffer.concat([targetReltab.data, newData]);
      }
    }
    await writeFile(objfilePath, objfile.toBuffer());
  } finally {
    await rm(sName, { force: true });
    await rm(oName, { force: true });
  }
}

/** Python slice assignment data[pos:pos+count] = src (src may be shorter at the end of a section). */
function spliceInto(buf, pos, src, count) {
  if (src.length !== count || pos + count > buf.length) throw new Failure("section splice out of range");
  src.copy(buf, pos);
}

function stableSort(arr, key) {
  return arr.map((v, i) => [key(v), i, v]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

// -- argument parsing (asm_processor.run_wrapped + build.py) -------------
const VALUE_FLAGS = new Set(["--input-enc", "--output-enc", "--asm-prelude", "--convert-statics", "--keep-preprocessed", "--no-dep-file"]);

/**
 * Split a build.py command line: `[asmproc flags] <compiler...> -- <assembler...> -- <compiler flags...>`.
 */
export function parseBuildArgs(allArgs) {
  let i = 0;
  const asmprocFlags = [];
  while (i < allArgs.length) {
    const arg = allArgs[i];
    if (arg === "--") { i += 1; break; }
    if (!arg.startsWith("-")) break;
    i += 1;
    asmprocFlags.push(arg);
    if (VALUE_FLAGS.has(arg) && i < allArgs.length) { asmprocFlags.push(allArgs[i]); i += 1; }
  }
  const sep0 = i;
  const sep1 = allArgs.indexOf("--", sep0);
  const sep2 = sep1 < 0 ? -1 : allArgs.indexOf("--", sep1 + 1);
  if (sep1 < 0 || sep2 < 0) throw new Failure("Usage: build.py [options] <compiler...> -- <assembler...> -- <compiler flags...>");
  const compiler = allArgs.slice(sep0, sep1);
  const assemblerArgs = allArgs.slice(sep1 + 1, sep2);
  const compileArgs = allArgs.slice(sep2 + 1);
  const outInd = compileArgs.indexOf("-o");
  if (outInd < 0) throw new Failure("Failed to parse compiler flags: missing -o argument");
  if (outInd + 1 >= compileArgs.length) throw new Failure("Failed to parse compiler flags: missing argument after -o");
  const outFile = compileArgs[outInd + 1];
  compileArgs.splice(outInd, 2);
  if (!compileArgs.length) throw new Failure("Failed to parse compiler flags: missing input file argument");
  const inFile = compileArgs.pop();
  return { asmprocFlags, compiler, assemblerArgs, compileArgs, outFile, inFile };
}

function parseAsmprocOptions(argv) {
  const o = { inputEnc: "latin1", outputEnc: "latin1", convertStatics: "local", dropMdebugGptab: false, force: false, keepOutputDir: null,
    noDepFile: false, encodeCutsceneDataFloats: false, framepointer: false, mips1: false, g3: false, kpic: false, opt: null, filename: null, asmPrelude: null };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], inline = null;
    // argparse accepts --long-option=value as well as --long-option value.
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    const val = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Failure(`${a} expects a value`);
      return argv[++i];
    };
    switch (a) {
      case "--input-enc": o.inputEnc = val(); break;
      case "--output-enc": o.outputEnc = val(); break;
      case "--convert-statics": o.convertStatics = val(); if (!["no", "local", "global", "global-with-filename"].includes(o.convertStatics)) throw new Failure(`invalid --convert-statics '${o.convertStatics}'`); break;
      case "--asm-prelude": o.asmPrelude = val(); break;
      case "--keep-preprocessed": o.keepOutputDir = val(); break;
      case "--drop-mdebug-gptab": o.dropMdebugGptab = true; break;
      case "--force": o.force = true; break;
      case "--no-dep-file": o.noDepFile = true; break;
      case "--encode-cutscene-data-floats": o.encodeCutsceneDataFloats = true; break;
      case "-framepointer": o.framepointer = true; break;
      case "-mips1": o.mips1 = true; break;
      case "-g3": o.g3 = true; break;
      case "-KPIC": o.kpic = true; break;
      case "-O0": case "-O1": case "-O2": case "-g":
        if (o.opt) throw new Failure("only one of -O0/-O1/-O2/-g may be given");
        o.opt = a.slice(1); break;
      default:
        if (a.startsWith("-")) throw new Failure(`unrecognized asm-processor argument ${a}`);
        o.filename = a;
    }
  }
  if (!o.opt) throw new Failure("one of the arguments -O0 -O1 -O2 -g is required");
  return o;
}

/**
 * build.py: preprocess, compile (injected), post-process (injected assembler).
 * @param {{
 *   args: string[],            build.py's argv (after the script path)
 *   cwd: string,               the project root the build runs in
 *   preludePath: string,       default asm prelude (tools/asm-processor/prelude.inc beside build.py)
 *   tmpDir: string,            scratch (never /tmp)
 *   compile: (argv:string[]) => Promise<{code:number, log:string}>,
 *   assemble: (assemblerArgs:string[], sPath:string, oPath:string) => Promise<{code:number, log:string}>,
 * }} a
 * @returns {Promise<{code:number, log:string, preprocessed?:string, deps:string[], functions:number}>}
 */
export async function asmProcessorBuild({ args, cwd, preludePath, tmpDir, compile, assemble }) {
  let log = "";
  try {
    const parsed = parseBuildArgs(args);
    const { asmprocFlags, compiler, assemblerArgs, compileArgs } = parsed;
    // build.py holds these as pathlib.Path objects: every later str() is normalised.
    const outFile = pyPath(parsed.outFile), inFile = pyPath(parsed.inFile);
    const inAbs = path.resolve(cwd, inFile);
    const inDir = path.dirname(fs.realpathSync(inAbs));
    const optFlags = compileArgs.filter((x) => ["-g3", "-g", "-O0", "-O1", "-O2", "-framepointer", "-KPIC"].includes(x));
    if (!compileArgs.includes("-mips2")) optFlags.push("-mips1");
    const o = parseAsmprocOptions([...asmprocFlags, ...optFlags, inFile]);
    let opt = o.opt;
    const pascal = [".p", ".pas", ".pp"].some((e) => o.filename.endsWith(e));
    if (o.g3) { if (opt !== "O2") throw new Failure("-g3 is only supported together with -O2"); opt = "g3"; }
    if (o.mips1 && (!["O1", "O2"].includes(opt) || o.framepointer)) throw new Failure("-mips1 is only supported together with -O1 or -O2");
    if (pascal && !["O1", "O2", "g3"].includes(opt)) throw new Failure("Pascal is only supported together with -O1, -O2 or -O2 -g3");
    const outputEnc = new Encoding(o.outputEnc);
    const opts = { opt, framepointer: o.framepointer, mips1: o.mips1, kpic: o.kpic, pascal, inputEnc: o.inputEnc, outputEnc, encodeCutsceneDataFloats: o.encodeCutsceneDataFloats };
    const readText = (fname, enc) => {
      const p = path.resolve(cwd, fname);
      if (!fs.existsSync(p)) return null;
      return decodeText(fs.readFileSync(p), enc);
    };
    const deps = [];
    const { functions, lines } = parseSource({ name: o.filename, text: readText(o.filename, o.inputEnc) ?? (() => { throw new Failure(`No such file or directory: '${o.filename}'`); })() }, opts, deps, { printSource: true, readText });

    const work = path.join(tmpDir, `asm_processor${randomUUID().slice(0, 8)}`);
    await mkdir(work, { recursive: true });
    try {
      const pre = path.join(work, "preprocessed_" + randomUUID().replace(/-/g, "") + path.extname(inFile));
      const preBytes = encodeLines(lines, outputEnc);
      await writeFile(pre, preBytes);
      if (o.keepOutputDir) {
        const keep = path.resolve(cwd, o.keepOutputDir);
        await mkdir(keep, { recursive: true });
        await writeFile(path.join(keep, path.basename(inFile, path.extname(inFile)) + "_" + path.basename(pre)), preBytes);
      }
      const compileCmd = [...compiler, ...compileArgs, "-I", inDir, "-o", outFile, pre];
      const cr = await compile(compileCmd);
      log += cr.log ?? "";
      if (cr.code !== 0) {
        log += `Failed to compile file ${inFile}. Command line:\n\n${compileCmd.join(" ")}\n\n`;
        return { code: 55, log, deps, functions: functions.length };
      }
      if (functions.length || o.force) {
        const asmPrelude = o.asmPrelude ? await readFile(path.resolve(cwd, o.asmPrelude)) : (preludePath && fs.existsSync(preludePath) ? await readFile(preludePath) : Buffer.alloc(0));
        await fixupObjfile({
          objfileName: outFile, objfilePath: path.resolve(cwd, outFile), functions, asmPrelude, outputEnc,
          dropMdebugGptab: o.dropMdebugGptab, convertStatics: o.convertStatics, tmpDir: work,
          assemble: async (s, obj) => {
            const ar = await assemble(assemblerArgs, s, obj);
            log += ar.log ?? "";
            if (ar.code !== 0) throw new Failure("failed to assemble");
          },
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    const depsFile = path.resolve(cwd, outFile).replace(/\.[^./]*$/, "") + ".asmproc.d";
    if (deps.length && !o.noDepFile) {
      await writeFile(depsFile, outFile + ": " + deps.join(" \\\n    ") + "\n" + deps.map((d) => "\n" + d + ":\n").join(""));
    } else await rm(depsFile, { force: true });
    return { code: 0, log, deps, functions: functions.length };
  } catch (e) {
    if (e instanceof Failure) return { code: 1, log: log + "Error: " + e.message + "\n", deps: [], functions: 0 };
    throw e;
  }
}
