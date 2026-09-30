// maspsx.js - a JS port of maspsx (github.com/mkst/maspsx), the assembly
// post-processor PS1 decomp projects put between gcc's cc1 and GNU as so the
// output matches what Sony's ASPSX assembler made of the same code (nop
// placement, $at expansions, gp-relative accesses, div expansion, ...).
//
// Ported from maspsx.py + maspsx/__init__.py at the revision recipe.js pins by
// content hash; the port follows the Python line for line, including where it
// raises (an exception there is an error exit here) and Python's own string,
// integer and float semantics.

// -- Python semantics ------------------------------------------------------
const PY_WS = "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0                　";
const isWs = (c) => PY_WS.includes(c);

/** str.strip() */
export function pyStrip(s) {
  let a = 0, b = s.length;
  while (a < b && isWs(s[a])) a++;
  while (b > a && isWs(s[b - 1])) b--;
  return s.slice(a, b);
}

/** str.split() with no separator: runs of whitespace, no empty fields. */
export function pySplit(s) {
  const out = [];
  let cur = "";
  for (const c of s) {
    if (isWs(c)) { if (cur) { out.push(cur); cur = ""; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

class PyError extends Error {}

/** int(s, base) for base 10 or 0. */
export function pyInt(s, base = 10) {
  const t = pyStrip(String(s)).replace(/_/g, (m, i, str) => {
    // underscores are allowed only between digits
    if (i === 0 || i === str.length - 1 || !/[0-9a-fA-F]/.test(str[i - 1]) || !/[0-9a-fA-F]/.test(str[i + 1])) throw new PyError(`invalid literal for int(): '${s}'`);
    return "";
  });
  const m = /^([+-]?)(.*)$/.exec(t);
  const sign = m[1] === "-" ? -1n : 1n;
  let body = m[2];
  let v;
  if (base === 10) {
    if (!/^[0-9]+$/.test(body)) throw new PyError(`invalid literal for int() with base 10: '${s}'`);
    v = BigInt(body);
  } else {
    let r = /^0[xX]([0-9a-fA-F]+)$/.exec(body);
    if (r) v = BigInt("0x" + r[1]);
    else if ((r = /^0[oO]([0-7]+)$/.exec(body))) v = BigInt("0o" + r[1]);
    else if ((r = /^0[bB]([01]+)$/.exec(body))) v = BigInt("0b" + r[1]);
    else if (/^(0+|[1-9][0-9]*)$/.test(body)) v = BigInt(body);
    else throw new PyError(`invalid literal for int() with base 0: '${s}'`);
  }
  return sign * v;
}

/** float(s) */
function pyFloat(s) {
  const t = pyStrip(String(s)).replace(/_/g, "");
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return NaN;
  if (!/^[+-]?((\d+\.?\d*)|(\.\d+))([eE][+-]?\d+)?$/.test(t)) throw new PyError(`could not convert string to float: '${s}'`);
  return Number(t);
}

const hexU = (n) => n.toString(16).toUpperCase();

// -- maspsx/__init__.py ------------------------------------------------------
const branchMnemonics = new Set(["beq", "bgez", "bgtz", "blez", "bltz", "bne"]);
const jumpMnemonics = new Set(["j", "jal"]);
const loadMnemonics = new Set(["lb", "lbu", "lh", "lhu", "lw", "lwl", "lwr"]);
const storeMnemonics = new Set(["sb", "sh", "sw", "swl", "swr", "swc2"]);
const singleRegLoads = new Set(["mult", "multu", "div", "divu", "rem", "remu", "move", "negu", "nor"]);
const doubleRegLoads = new Set(["and", "andi", "or", "ori", "xor", "xori", "addu", "subu", "sll", "slr", "srl", "sra", "slt", "slti", "sltu"]);

function stripComments(line) {
  if (line.includes("#")) line = line.split("#")[0];
  return pyStrip(line);
}

const re = (src) => new RegExp(src);
const match = (src, s) => re("^(?:" + src + ")").exec(s);

function lineLoadsFromReg(line, rSource) {
  line = stripComments(line);
  const r = rSource.split("$").join("\\$");
  const m = match("([A-z][A-z0-9]*)\\s+(.*)$", line);
  if (!m) return false;
  const [, op, rest] = m;
  const t = (src) => !!match(src, rest);
  if (loadMnemonics.has(op)) {
    if (t(`^.*\\(\\s*${r}\\s*\\)$`)) return true;
  } else if (storeMnemonics.has(op)) {
    if (t(`^.*\\(\\s*${r}\\s*\\)$`)) return true;
    if (t(`^${r},.*$`)) return true;
  } else if (op === "lwc2") {
    if (t(`^.*\\(\\s*${r}\\s*\\)$`)) return true;
  } else if (op === "jal") {
    if (t(`^.*,\\s*${r}$`)) return true;
  } else if (op === "j") {
    if (t(`^${r}$`)) return true;
  } else if (["ctc2", "mtc0", "mtc2"].includes(op)) {
    if (t(`^${r},.*$`)) return true;
  } else if (branchMnemonics.has(op)) {
    if (t(`^${r},.*$`)) return true;
    if (t(`^.*,\\s*${r},.*$`)) return true;
  } else if (singleRegLoads.has(op)) {
    if (t(`^.*,\\s*${r}$`)) return true;
    if (op.startsWith("mult") && t(`^${r},.*$`)) return true;
    if ((op.startsWith("div") || op.startsWith("rem")) && t(`^.*,${r}.*$`)) return true;
  } else if (doubleRegLoads.has(op)) {
    if (t(`^.*,\\s*${r},.*$`)) return true;
    if (t(`^.*,.*,\\s*${r}$`)) return true;
  }
  return false;
}

const isNumber = (v) => !!(match("^-?\\d+$", v) || match("^-?0x[A-Fa-f0-9]+$", v));

function usesAt(line) {
  line = stripComments(line);
  let m, operand;
  if ((m = match("^s[wbh]\\s+(\\$[a-z0-9]+),\\s*%lo\\(([^(]+)\\)\\(([^)]+)\\)", line))) return false;
  if ((m = match("^s[wbh]\\s+(\\$[a-z0-9]+),\\s*(-?[A-z0-9_.+]+)$", line))) {
    operand = m[2];
    if (!isNumber(operand)) return true;
  } else if ((m = match("^s[wbh]\\s+(\\$[a-z0-9]+),\\s*([^(]+)\\(([^)]+)\\)", line))) {
    operand = m[2];
  } else if ((m = match("l[a-z]+\\s+(\\$[a-z0-9]+),\\s*([^(]+)\\(([^)]+)\\)", line))) {
    operand = m[2];
  } else return false;
  if (isNumber(operand)) {
    const num = pyInt(operand, 0);
    if (-32769n < num && num < 32768n) return false;
  }
  return true;
}

function parseLoadOrStore(rest) {
  let m, rDest, operand, rSource, needsExpanding;
  if ((m = match("(\\$[a-z0-9]+),\\s*%lo\\(([^(]+)\\)\\(([^(]+)\\)", rest))) {
    [, rDest, operand, rSource] = m; needsExpanding = false;
  } else if ((m = match("(\\$[a-z0-9]+),\\s*([^(]+)\\(([^)]+)\\)", rest))) {
    [, rDest, operand, rSource] = m; needsExpanding = true;
  } else if ((m = match("(\\$[a-z0-9]+),\\s*([^(]+)", rest))) {
    [, rDest, operand] = m; rSource = null; needsExpanding = true;
  } else throw new PyError(`Unable to parse load/store instruction: ${rest}`);
  const isAddend = !(match("^-?\\d+$", operand) || match("^-?0x[A-Fa-f0-9]+$", operand));
  return { rSource, rDest, operand, isAddend, needsExpanding };
}

function divNeedsExpanding(line) {
  const [inst, ...rest] = pySplit(line);
  if (inst === undefined) throw new PyError("not enough values to unpack");
  if (!(inst.startsWith("div") || inst.startsWith("rem"))) return false;
  if (rest.length === 0) throw new PyError("list index out of range");
  const rDest = rest[0].split(",")[0];
  return !(rDest === "$zero" || rDest === "$0");
}

function expandLoadImmediate(line) {
  const res = [];
  const m = match("li\\s+(\\$[0-9A-z]+),\\s?(-?[x0-9a-fA-F]+)", line);
  if (!m) throw new PyError("li regex failed");
  const rDest = m[1];
  const operand = pyInt(m[2], 0);
  if (0n < operand && operand < 0x10000n) res.push(`ori\t${rDest},$zero,${operand}`);
  else if (operand >= 0x10000n) {
    res.push(`lui\t${rDest},(${operand} >> 16) & 0xFFFF`);
    if (operand & 0xffffn) res.push(`ori\t${rDest},${rDest},${operand} & 0xFFFF`);
  } else if (0n > operand && operand > -0x8000n) res.push(`addiu\t${rDest},$zero,${operand}`);
  else if (operand === -0x8000n) res.push(`addiu\t${rDest},$zero,${operand} & 0xFFFF`);
  else if (operand < -0x8000n) {
    res.push(`lui\t${rDest},(${operand} >> 16) & 0xFFFF`);
    if (operand & 0xffffn) res.push(`ori\t${rDest},${rDest},${operand} & 0xFFFF`);
  } else res.push(`ori\t${rDest},0`);
  return res;
}

function expandMove(line) {
  line = stripComments(line);
  const [op, ...rest] = pySplit(line);
  if (op === undefined) throw new PyError("not enough values to unpack");
  if (op === "move") {
    const parts = rest.join(" ").split(",");
    if (parts.length !== 2) throw new PyError("wrong number of values to unpack");
    return `addu\t${parts[0]},${parts[1]},$zero`;
  }
  return line;
}

const isLabel = (line) => !!match("\\$L(b|e)?\\d+:$", line);

function isInstruction(line, { ignoreNop = false, ignoreSet = false, ignoreLabel = false } = {}) {
  if (line.length === 0) return false;
  if (ignoreNop && line === "#nop") return false;
  if (ignoreSet && [".set\treorder", ".set\tnoreorder", ".set\tvolatile", ".set\tnovolatile"].includes(line)) return false;
  if (ignoreLabel && isLabel(line)) return false;
  if (line.startsWith(".stab")) return false;
  if (line.startsWith(".def") || line.startsWith(".bend") || line.startsWith(".begin")) return false;
  if (line.startsWith(".loc")) return false;
  if (line.startsWith("L")) {
    if (line.length < 2) throw new PyError("string index out of range");
    if (!"0123456789".includes(line[1]) && line.endsWith(":")) return false;
  }
  if (line === ".set\tmacro" || line === ".set\tnomacro") return false;
  if (line === "#.set\tvolatile" || line === "#.set\tnovolatile") return false;
  if (line === "#APP" || line === "#NO_APP") return false;
  return true;
}

const NEXT_REG = {
  "$f0": "$f1", "$f2": "$f3", "$f4": "$f5", "$f6": "$f7", "$f12": "$f13", "$f14": "$f15",
  "$v0": "$v1", "$a0": "$a1", "$a2": "$a3", "$t0": "$t1", "$t2": "$t3", "$s0": "$s1", "$s2": "$s3",
  "$2": "$3", "$4": "$5", "$6": "$7", "$8": "$9", "$10": "$11", "$18": "$19",
};
function getNextRegister(reg) {
  const r = Object.hasOwn(NEXT_REG, reg) ? NEXT_REG[reg] : undefined;
  if (r === undefined) throw new PyError(`Unknown mapping for ${reg}`);
  return r;
}

function expandMacro(line) {
  const res = [];
  for (let l of stripComments(line).split(";")) {
    l = pyStrip(l);
    if (l.length === 0) continue;
    const [op, ...rest] = pySplit(l);
    res.push([op, rest.join(" ")]);
  }
  return res;
}

function splitTwo(s) {
  const p = s.split(",");
  if (p.length !== 2) throw new PyError(`expected 2 values to unpack, got ${p.length}`);
  return p;
}

/** struct.pack(">f", x) as an unsigned 32-bit int, with Python's overflow error. */
function f32Bits(x) {
  const f = Math.fround(x);
  if (!Number.isFinite(f) && Number.isFinite(x)) throw new PyError("float too large to pack with f format");
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, f);
  return dv.getUint32(0);
}

function loadImmediateSingle(line) {
  const res = [];
  const [r1, value] = splitTwo(line.slice(5));
  const num = f32Bits(pyFloat(value));
  const upper = (num & 0xffff0000) >>> 16;
  const lower = num & 0xffff;
  res.push(`lui\t${r1},0x${hexU(upper)}`);
  if (lower) res.push(`ori\t${r1},0x${hexU(lower)}`);
  return res;
}

function loadImmediateDouble(line) {
  const res = [];
  const [r1, value] = splitTwo(line.slice(5));
  const r2 = getNextRegister(r1);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, pyFloat(value));
  const num = dv.getBigUint64(0);
  const r1Upper = (num & 0xffff0000n) >> 16n;
  const r1Lower = num & 0xffffn;
  const r2Upper = (num & 0xffff000000000000n) >> 48n;
  const r2Lower = (num & 0xffff00000000n) >> 32n;
  if (r1Upper || r1Lower) {
    res.push(`lui\t${r1},0x${hexU(r1Upper)}`);
    if (r1Lower) res.push(`ori\t${r1},0x${hexU(r1Lower)}`);
  } else res.push(`li\t${r1},0x0`);
  res.push(`lui\t${r2},0x${hexU(r2Upper)}`);
  if (r2Lower) res.push(`ori\t${r2},0x${hexU(r2Lower)}`);
  return res;
}

const MULDIV = ["mult\t", "multu\t", "div\t", "divu\t", "rem\t", "remu\t"];

export class MaspsxProcessor {
  constructor(lines, {
    sdataLimit = 0, expandDiv = false, expandLi = false, nopAtExpansion = false, nopMfloMfhi = true,
    sltuAt = false, addiuAt = false, divUsesTge = false, gpAllowOffset = false, gpAllowLa = false,
    useCommSection = false, useCommForLcomm = false,
  } = {}) {
    this.lines = lines.map((x) => pyStrip(x));
    Object.assign(this, { sdataLimit, expandDiv, expandLi, nopAtExpansion, nopMfloMfhi, sltuAt, addiuAt, divUsesTge, gpAllowOffset, gpAllowLa, useCommSection, useCommForLcomm });
    this.isReorder = true; this.skipInstructions = 0; this.fileNum = 1; this.lineIndex = 0;
    this.bssEntries = new Map(); this.sbssEntries = new Map(); this.sdataEntries = new Map();
    this.commSymbols = new Set();
  }

  preprocessLines() {
    let inSdata = false, usesSize = false, currentSymbol;
    for (const line of this.lines) {
      if (line === "") continue;
      if (line.startsWith(".align") || line.startsWith(".globl")) continue;
      if (line.startsWith(".text") || line.startsWith(".data") || line.startsWith(".rdata")) { inSdata = false; continue; }
      if (line.startsWith(".section") && line.endsWith(".text")) { inSdata = false; continue; }
      if (line.startsWith("#")) continue;
      if (line.startsWith(".sdata")) { inSdata = true; continue; }
      if (line.startsWith(".file") || line.startsWith(".extern")) { inSdata = false; continue; }
      if (line.startsWith(".comm") || line.startsWith(".lcomm")) {
        inSdata = false;
        const parts = pySplit(line);
        if (parts.length !== 2) throw new PyError(`expected 2 values to unpack, got ${parts.length}`);
        const [symbol, sizeStr] = splitTwo(parts[1]);
        const size = pyInt(sizeStr);
        if (size <= BigInt(this.sdataLimit)) this.sbssEntries.set(symbol, size);
        else this.bssEntries.set(symbol, size);
        if (line.startsWith(".comm")) this.commSymbols.add(symbol);
        continue;
      }
      if (inSdata) {
        const m = match("\\.size\\s+([^,]+),([0-9]+)", line);
        if (m) { currentSymbol = m[1]; this.sdataEntries.set(currentSymbol, pyInt(m[2])); usesSize = true; continue; }
        if (!usesSize) {
          if (line.endsWith(":")) { currentSymbol = line.split(":").join(""); this.sdataEntries.set(currentSymbol, 0n); }
          else {
            if (line.startsWith(".type")) continue;
            let size;
            if (line.startsWith(".space")) {
              const parts = pySplit(line);
              if (parts.length !== 2) throw new PyError(`expected 2 values to unpack, got ${parts.length}`);
              size = pyInt(parts[1]);
            } else if (line.startsWith(".word")) size = 4n;
            else if (line.startsWith(".half") || line.startsWith(".short")) size = 2n;
            else if (line.startsWith(".byte")) size = 1n;
            else if (line.startsWith(".ascii")) size = BigInt(line.length - 9);
            else throw new PyError(`Unable to parse .sdata instruction: ${line}`);
            if (!this.sdataEntries.has(currentSymbol)) throw new PyError(`KeyError: ${currentSymbol}`);
            this.sdataEntries.set(currentSymbol, this.sdataEntries.get(currentSymbol) + size);
          }
        }
      }
    }
  }

  processLines() {
    this.isReorder = true; this.skipInstructions = 0; this.fileNum = 1;
    this.bssEntries = new Map(); this.sbssEntries = new Map(); this.sdataEntries = new Map();
    this.preprocessLines();
    let res = [];
    let inHack = false;
    this.lines.forEach((line, i) => {
      this.lineIndex = i;
      if (line.includes(".ent\t__maspsx_include_asm_hack")) inHack = true;
      if (inHack) {
        res.push(line.includes("# maspsx-keep") ? line : `# ${line} # DEBUG: skipped due to include asm hack`);
        if (line.includes(".end\t__maspsx_include_asm_hack")) inHack = false;
        return;
      }
      if (isInstruction(line) && this.skipInstructions > 0) { this.skipInstructions--; res.push(`# ${line}  # DEBUG: skipped`); }
      else res = res.concat(this.processLine(line));
    });
    for (const [section, entries] of [["sbss", this.sbssEntries], ["bss", this.bssEntries]]) {
      let i = 0;
      for (const [symbol, size] of entries) {
        if (i++ === 0) res.push(`.section .${section}`);
        if (this.useCommSection && (this.commSymbols.has(symbol) || this.useCommForLcomm)) { res.push(`\t.comm ${symbol},${size}`); continue; }
        if (section === "sbss") {
          if (size >= 8n) res.push("\t.align 3");
          else if (size >= 4n) res.push("\t.align 2");
          else if (size >= 2n) res.push("\t.align 1");
        }
        if (section === "bss") res.push(`\t.globl ${symbol}`);
        res.push(`${symbol}:`, `\t.space ${size}`);
      }
    }
    return res;
  }

  getNextInstruction({ skip = 0, ignoreNop = false, ignoreSet = false, ignoreLabel = false } = {}) {
    for (let i = this.lineIndex + 1; i < this.lines.length; i++) {
      const line = this.lines[i];
      if (isInstruction(line, { ignoreNop, ignoreSet, ignoreLabel })) {
        if (skip === 0) return line;
        skip--;
      }
    }
    return "";
  }

  usesGp(line) {
    if (this.sdataLimit === 0) return false;
    line = stripComments(line);
    if (usesAt(line)) {
      const [op, ...rest] = line.split("\t");
      if (loadMnemonics.has(op) || storeMnemonics.has(op)) {
        const { operand } = parseLoadOrStore(rest.join(" "));
        let symbol, gpAllowed;
        if (operand.split("+").length - 1 === 1) { symbol = operand.split("+")[0]; gpAllowed = this.gpAllowOffset || !this.commSymbols.has(symbol); }
        else { symbol = operand; gpAllowed = true; }
        if (gpAllowed && (this.sbssEntries.has(symbol) || this.sdataEntries.has(symbol))) return true;
      }
    }
    return false;
  }

  nopBeforeNext(nextInstruction, rDest) {
    const res = [];
    if (lineLoadsFromReg(nextInstruction, rDest)) {
      let nopRequired = false, reason;
      if (!usesAt(nextInstruction)) { reason = `'${nextInstruction}' does not use $at`; nopRequired = true; }
      if (this.usesGp(nextInstruction)) { reason = `'${nextInstruction}' uses $gp`; nopRequired = true; }
      if (usesAt(nextInstruction) && this.nopAtExpansion) { reason = `'${nextInstruction}' inject nop beween ${rDest} and $at expansion`; nopRequired = true; }
      if (nopRequired) {
        const label = this.getNextInstruction({ skip: 0, ignoreNop: true, ignoreSet: true });
        if (isLabel(label)) { res.push(label); this.skipInstructions = 1; }
        res.push(`nop # DEBUG: Reuse of '${rDest}'. ${reason}`);
      }
    } else res.push(`#nop # DEBUG: '${nextInstruction}' does not load from ${rDest}`);
    return res;
  }

  mfloMfhi(rSource = null) {
    let res = [];
    if (!this.nopMfloMfhi) return res;
    const nextInstruction = this.getNextInstruction({ skip: 0, ignoreNop: true, ignoreSet: true, ignoreLabel: true });
    const nextNext = this.getNextInstruction({ skip: 1, ignoreNop: true, ignoreSet: true, ignoreLabel: true });
    if (MULDIV.some((x) => nextInstruction.startsWith(x))) {
      let skip = 0;
      for (;;) {
        const inst = this.getNextInstruction({ skip });
        skip++;
        if (inst === nextInstruction) {
          res.push("nop", "nop");
          if (divNeedsExpanding(inst)) { res.push("# DEBUG: div needs expanding"); skip--; }
          else res.push(expandMove(inst));
          break;
        }
        if (!inst.startsWith("#")) res.push(expandMove(inst));
      }
      this.skipInstructions = skip;
    } else if (MULDIV.some((x) => nextNext.startsWith(x))) {
      let skip = 0, noReorder = false;
      for (;;) {
        const inst = this.getNextInstruction({ skip });
        if (inst.startsWith(".set") && inst.endsWith("noreorder")) { noReorder = true; skip++; continue; }
        skip++;
        if (inst === nextInstruction) {
          const op = pySplit(pyStrip(inst))[0];
          if (op === undefined) throw new PyError("not enough values to unpack");
          if (loadMnemonics.has(op)) { skip = 0; break; }
          if (op === "mflo" || op === "mfhi") { skip = 0; break; }
          if (op === "li") {
            const expanded = expandLoadImmediate(inst);
            if (this.expandLi) res = res.concat(expanded); else res.push(inst);
            if (expanded.length === 2) res.push("#nop  # DEBUG: mflo/mfhi with mult/div/rem and li expands to 2 ops");
            else res.push("nop  # DEBUG: mflo/mfhi with mult/div/rem and li expands to 1 op");
          } else if (noReorder) {
            res.push("nop  # DEBUG: mflo/mfhi with mult/div/rem and 1 instruction (noreorder)", ".set\tnoreorder", expandMove(inst));
          } else if (rSource && lineLoadsFromReg(inst, rSource)) {
            res.push(`nop  # DEBUG: mflo/mfhi with mult/div/rem and 1 instruction which loads from ${rSource}`, expandMove(inst));
          } else {
            const maybeLabel = this.getNextInstruction({ skip });
            if (isLabel(maybeLabel)) {
              res.push(expandMove(inst), maybeLabel, "nop  # DEBUG: mflo/mfhi with mult/div/rem and 1 instruction (label)");
              skip++;
            } else res.push(expandMove(inst), "nop  # DEBUG: mflo/mfhi with mult/div/rem and 1 instruction");
          }
        } else if (inst === nextNext) {
          if (divNeedsExpanding(inst)) { res.push("# DEBUG: div needs expanding"); skip--; }
          else res.push(inst);
          break;
        } else if (!inst.startsWith("#")) res.push(expandMove(inst));
      }
      this.skipInstructions = skip;
    }
    return res;
  }

  atExpansion(op, rDest, rSource, operand, { addiu, lead = "at-first" }) {
    if (addiu) return ["# EXPAND_AT START", ".set\tnoat", `lui\t$at,%hi(${operand})`, `addiu\t$at,$at,%lo(${operand})`, `addu\t$at,$at,${rSource}`, `${op}\t${rDest},0x0($at)`, ".set\tat", "# EXPAND_AT END"];
    const add = lead === "at-first" ? `addu\t$at,$at,${rSource}` : `addu\t$at,${rSource},$at`;
    return ["# EXPAND_AT START", ".set\tnoat", `lui\t$at,%hi(${operand})`, add, `${op}\t${rDest},%lo(${operand})($at)`, ".set\tat", "# EXPAND_AT END"];
  }

  gpRel(operand) {
    if (operand.split("+").length - 1 === 1) {
      const [symbol, offset] = operand.split("+");
      return { symbol, gpRel: `%gp_rel(${symbol}+${offset})($gp)`, gpAllowed: this.gpAllowOffset || !this.commSymbols.has(symbol) };
    }
    return { symbol: operand, gpRel: `%gp_rel(${operand})($gp)`, gpAllowed: true };
  }

  processLine(line) {
    let res = [];
    if (line.length === 0) return [line];
    if (line.startsWith("#")) return [];
    if (line.startsWith(".")) {
      if (line.startsWith(".def\t") || line.startsWith(".begin\t") || line.startsWith(".bend\t")) { /* coff: skipped */ }
      else if (line.startsWith(".set\t")) {
        if (line.endsWith("\tnoreorder")) this.isReorder = false;
        else if (line.endsWith("\treorder")) this.isReorder = true;
      } else if (line.startsWith(".file\t")) {
        const parts = pySplit(line);
        if (parts.length !== 3) throw new PyError(`expected 3 values to unpack, got ${parts.length}`);
        res.push(`.file\t${this.fileNum} ${parts[2]}`);
        this.fileNum++;
      } else if (line.startsWith(".ent\t")) res.push(line, ".set\tnoreorder");
      else if (line.startsWith(".comm") || line.startsWith(".lcomm")) { /* handled in preprocessLines */ }
      else if (line.startsWith(".data")) res.push(".section .data");
      else if (line.startsWith(".sdata")) res.push(".section .sdata");
      else if (line.startsWith(".rdata")) res.push(".section .rodata");
      else res.push(line);
      return res;
    }
    if (line.startsWith("$L")) return [line];

    let actualRDest = null;
    if (line.includes(";")) {
      const expanded = expandMacro(line);
      if (expanded.length > 0) {
        const [actualOp, actualRest] = expanded[expanded.length - 1];
        if (loadMnemonics.has(actualOp)) actualRDest = parseLoadOrStore(actualRest).rDest;
      }
    }

    const words = pySplit(line);
    const op = words[0], rest = words.slice(1);
    const intOf = (s) => pyInt(s);

    if (loadMnemonics.has(op)) {
      const { rSource, rDest: rd, operand, isAddend, needsExpanding } = parseLoadOrStore(rest.join(" "));
      let rDest = rd;
      let nextInstruction = this.getNextInstruction({ skip: 0, ignoreNop: true, ignoreSet: true, ignoreLabel: true });
      if (nextInstruction.includes(";")) nextInstruction = nextInstruction.split(";")[0];
      if (!needsExpanding) {
        res.push(`${line} # DEBUG: leaving for assembler to expand`);
        res = res.concat(this.nopBeforeNext(nextInstruction, rDest));
      } else if (isAddend && rSource === null) {
        const { symbol, gpRel, gpAllowed } = this.gpRel(operand);
        if (gpAllowed && (this.sdataEntries.has(symbol) || this.sbssEntries.has(symbol))) res.push(`${op}\t${rDest},${gpRel}`);
        else res.push(line);
        res = res.concat(this.nopBeforeNext(nextInstruction, rDest));
      } else if (isAddend && rSource) {
        res = res.concat(this.atExpansion(op, rDest, rSource, operand, { addiu: this.addiuAt }));
        res = res.concat(this.nopBeforeNext(nextInstruction, rDest));
      } else {
        if (rSource && (intOf(operand) > 32767n || intOf(operand) < -32768n)) res = res.concat(this.atExpansion(op, rDest, rSource, operand, { addiu: false, lead: "source-first" }));
        else res.push(line);
        if (actualRDest !== null) rDest = actualRDest;
        res = res.concat(this.nopBeforeNext(nextInstruction, rDest));
      }
    } else if (storeMnemonics.has(op) || (op === "la" && this.sdataLimit > 0)) {
      const { rSource, rDest, operand, isAddend } = parseLoadOrStore(rest.join(" "));
      if (isAddend && rSource === null) {
        let { symbol, gpRel, gpAllowed } = this.gpRel(operand);
        if (op === "la" && !this.gpAllowLa) gpAllowed = false;
        if (gpAllowed && (this.sdataEntries.has(symbol) || this.sbssEntries.has(symbol))) res.push(`${op}\t${rDest},${gpRel}`);
        else res.push(line);
      } else if (isAddend && rSource) {
        if (this.addiuAt && op !== "la") res = res.concat(this.atExpansion(op, rDest, rSource, operand, { addiu: true }));
        else res.push(line);
      } else if (rSource && (intOf(operand) > 32767n || intOf(operand) < -32768n)) {
        res = res.concat(this.atExpansion(op, rDest, rSource, operand, { addiu: false, lead: "source-first" }));
      } else res.push(line);
    } else if (branchMnemonics.has(op) || jumpMnemonics.has(op)) {
      res.push(line);
      if (this.isReorder) res.push("nop  # DEBUG: branch/jump");
    } else if (op === "move") res.push(expandMove(line));
    else if (["addu", "subu", "sra", "srl", "srr", "sll", "or"].includes(op)) res.push(line);
    else if (op === "li") res = res.concat(this.expandLi ? expandLoadImmediate(line) : [line]);
    else if (op === "li.s") res = res.concat(loadImmediateSingle(line));
    else if (op === "li.d") res = res.concat(loadImmediateDouble(line));
    else if (op === "mflo" || op === "mfhi") { res.push(line); res = res.concat(this.mfloMfhi()); }
    else if (op === "break") {
      if (rest.length === 0) throw new PyError("list index out of range");
      const num = pyInt(rest[0], 0);
      res.push(`break\t0x${hexU(num >> 10n)},0x${hexU(num & 0x3ffn)}`);
    } else if (op === "div" || op === "rem" || op === "divu" || op === "remu") {
      if (rest.length === 0) throw new PyError("list index out of range");
      const parts = rest[0].split(",");
      if (parts.length !== 3) throw new PyError(`expected 3 values to unpack, got ${parts.length}`);
      const [rDest, rSource, rOperand] = parts;
      if (rDest === "$zero" || rDest === "$0") return [line];
      const unsigned = op === "divu" || op === "remu";
      const moveFrom = op === "rem" || op === "remu" ? "mfhi" : "mflo";
      const L = this.lineIndex;
      if (this.expandDiv) {
        if (!unsigned) res.push("# EXPAND_DIV START", ".set\tnoat", `div\t$zero,${rSource},${rOperand}`, `bnez\t${rOperand},.L_NOT_DIV_BY_ZERO_${L}`, "nop", "break\t0x7", `.L_NOT_DIV_BY_ZERO_${L}:`, "addiu\t$at,$zero,-1", `bne\t${rOperand},$at,.L_DIV_BY_POSITIVE_SIGN_${L}`, "lui\t$at,0x8000", `bne\t${rSource},$at,.L_DIV_BY_POSITIVE_SIGN_${L}`, "nop", this.divUsesTge ? "tge\t$zero,$zero,93" : "break\t0x6", `.L_DIV_BY_POSITIVE_SIGN_${L}:`, `${moveFrom}\t${rDest}`, ".set\tat", "# EXPAND_DIV END");
        else res.push("# EXPAND_DIVU START", ".set\tnoat", `divu\t$zero,${rSource},${rOperand}`, `bnez\t${rOperand},.L_NOT_DIV_BY_ZERO_${L}`, "nop", "break\t0x7", `.L_NOT_DIV_BY_ZERO_${L}:`, `${moveFrom}\t${rDest}`, ".set\tat", "# EXPAND_DIVU END");
      } else if (!unsigned) res.push("# EXPAND_ZERO_DIV START", `div\t$zero,${rSource},${rOperand}`, `${moveFrom}\t${rDest}`, "# EXPAND_ZERO_DIV END");
      else res.push("# EXPAND_ZERO_DIVU START", `divu\t$zero,${rSource},${rOperand}`, `${moveFrom}\t${rDest}`, "# EXPAND_ZERO_DIVU END");
      const extra = this.mfloMfhi(rDest);
      if (extra.length > 0) res = res.concat(extra);
      else {
        const next = this.getNextInstruction({ skip: 0, ignoreSet: true, ignoreLabel: true });
        res = res.concat(this.nopBeforeNext(next, rDest));
      }
    } else if (op === "sltu") {
      if (rest.length === 0) throw new PyError("list index out of range");
      const parts = rest[0].split(",");
      if (parts.length !== 3) throw new PyError(`expected 3 values to unpack, got ${parts.length}`);
      const [rDest, rSource, rOperand] = parts;
      if (match("^-?\\d+$", rOperand) || match("^-?0x[A-Fa-f0-9]+$", rOperand)) {
        const value = pyInt(rOperand);
        if (this.sltuAt && value < 0n) res.push(`li\t$at,${rOperand}`, `${op}\t${rDest},${rSource},$at`);
        else res.push(line);
      } else res.push(line);
    } else res.push(line);
    return res;
  }
}

// -- maspsx.py -------------------------------------------------------------
const OPTIONS = {
  "--aspsx-version": "value", "--run-assembler": "flag", "--gnu-as-path": "value", "--dont-force-G0": "flag",
  "--expand-div": "flag", "--macro-inc": "flag", "--dont-expand-li": "flag", "--force-stdin": "flag",
  "--use-comm-section": "flag", "--use-comm-for-lcomm": "flag", "--print-output": "flag", "--print-input": "flag",
  "--no-macro-inc": "flag", "--expand-li": "flag",
};

/** argparse.parse_known_args for maspsx's options (unique prefixes allowed, as argparse does). */
export function parseMaspsxArgs(argv) {
  const opts = { "--gnu-as-path": "mipsel-linux-gnu-as" };
  const asArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--") || a === "--") { asArgs.push(a); continue; }
    const eq = a.indexOf("=");
    const name = eq >= 0 ? a.slice(0, eq) : a;
    let key = Object.hasOwn(OPTIONS, name) ? name : null;
    if (!key) {
      const cands = Object.keys(OPTIONS).filter((k) => k.startsWith(name));
      if (cands.length > 1) throw new PyError(`ambiguous option: ${name} could match ${cands.join(", ")}`);
      key = cands[0] ?? null;
    }
    if (!key) { asArgs.push(a); continue; }
    if (OPTIONS[key] === "flag") {
      if (eq >= 0) throw new PyError(`argument ${key}: ignored explicit argument '${a.slice(eq + 1)}'`);
      opts[key] = true;
    } else if (eq >= 0) opts[key] = a.slice(eq + 1);
    else {
      if (i + 1 >= argv.length || (argv[i + 1].startsWith("-") && !/^-\d/.test(argv[i + 1]))) throw new PyError(`argument ${key}: expected one argument`);
      opts[key] = argv[++i];
    }
  }
  return { opts, asArgs };
}

/** Python's text-mode read of the input: UTF-8, universal newlines, readlines(). */
function readLines(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l));
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const cmpTuple = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i >= a.length) return -1; if (i >= b.length) return 1; if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return 0; };

/**
 * Run maspsx as its command line would. stdin: the piped input (or null when
 * stdin is a terminal). readFile(path) reads the fallback input file.
 * @returns {{code:number, stdout:string, stderr:string, runAssembler?:{argv:string[], input:string}}}
 */
export function maspsxMain(argv, { stdin = null, readFile } = {}) {
  let stderr = "";
  try {
    const { opts, asArgs } = parseMaspsxArgs(argv);
    if (opts["--no-macro-inc"]) stderr += "MASPSX: --no-macro-inc is no longer required and will be removed in a future update\n";
    if (opts["--expand-li"]) stderr += "MASPSX: --expand-li is enabled automatically if --aspsx-version is below 2.56\n";
    let readFromFile = stdin === null;
    let inLines = [];
    if (!readFromFile) {
      inLines = readLines(stdin);
      if (inLines.length === 0) {
        if (opts["--force-stdin"]) return { code: 1, stdout: "", stderr: stderr + "MASPSX: --force-stdin but no input from stdin!\n" };
        stderr += "MASPSX: Warning, no input from stdin, will try to read from a file\n";
        readFromFile = true;
      }
    }
    if (readFromFile) {
      if (asArgs.length === 0) return { code: 1, stdout: "", stderr: stderr + "MASPSX: Error, no input file found!\n" };
      inLines = readLines(readFile(asArgs.pop()));
    }
    if (opts["--print-input"]) stderr += inLines.join("");
    const preamble = [opts["--macro-inc"] ? '.include "macro.inc"' : ""];
    let sdataLimit = 0;
    const filtered = [];
    for (let arg of asArgs) {
      if (arg === "-KPIC") continue;
      if (arg.startsWith("-mcpu=")) arg = arg.split("-mcpu=").join("-mtune=");
      else if (arg.startsWith("-G") && arg.length > 2) sdataLimit = Number(pyInt(arg.slice(2)));
      filtered.push(arg);
    }
    let divUsesTge = false, nopAtExpansion = false, nopMfloMfhi = true, sltuAt = true, expandLi = true, gpAllowOffset = false, gpAllowLa = false, addiuAt = false;
    if (opts["--aspsx-version"]) {
      const v = opts["--aspsx-version"].split(".").map((x) => Number(pyInt(x)));
      if (cmpTuple([1, 10], v) < 0 && cmpTuple(v, [2, 10]) < 0) divUsesTge = true;
      if (cmpTuple(v, [2, 30]) < 0) { nopAtExpansion = true; nopMfloMfhi = false; addiuAt = true; }
      if (cmpTuple(v, [2, 50]) >= 0) expandLi = false;
      if (cmpTuple(v, [2, 70]) >= 0) { sltuAt = false; gpAllowOffset = true; }
      if (cmpTuple(v, [2, 80]) >= 0) gpAllowLa = true;
    }
    if (opts["--dont-expand-li"] && expandLi) expandLi = false;
    const p = new MaspsxProcessor(inLines, {
      sdataLimit, expandDiv: !!opts["--expand-div"], expandLi, nopAtExpansion, nopMfloMfhi, sltuAt, addiuAt, divUsesTge,
      gpAllowOffset, gpAllowLa, useCommSection: !!opts["--use-comm-section"], useCommForLcomm: !!opts["--use-comm-for-lcomm"],
    });
    let outLines;
    try { outLines = p.processLines(); }
    catch (err) { return { code: 1, stdout: "", stderr: stderr + `MASPSX: An exception occurred: ${err.message}\n` }; }
    const outText = [...preamble, ...outLines].join("\n") + "\n";
    if (opts["--print-output"]) stderr += outText;
    if (opts["--run-assembler"]) {
      const cmd = [opts["--gnu-as-path"], ...filtered, "-"];
      if (!opts["--dont-force-G0"]) cmd.splice(cmd.length - 1, 0, "-G0");
      return { code: 0, stdout: "", stderr, runAssembler: { argv: cmd, input: outText } };
    }
    return { code: 0, stdout: outText, stderr };
  } catch (e) {
    if (e instanceof PyError) return { code: 1, stdout: "", stderr: stderr + `maspsx: error: ${e.message}\n` };
    throw e;
  }
}
