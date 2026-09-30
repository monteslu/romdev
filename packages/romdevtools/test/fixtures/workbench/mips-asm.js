// A tiny MIPS assembler that renders GNU objdump `-d -r` text for workbench
// test fixtures. Words and printed assembly stay consistent: the aligned view
// derives its byte-identical-prefix signature from the words and its
// classification from the operands, so invented words would validate nothing.
//
// Branch destinations are written `@N` for instruction index N; call targets
// are named symbols and take a relocation entry from `relocations`.

const REGISTERS = {
  zero: 0, at: 1, v0: 2, v1: 3, a0: 4, a1: 5, a2: 6, a3: 7, t0: 8, t1: 9, t2: 10, t3: 11, t4: 12, t5: 13, t6: 14, t7: 15,
  s0: 16, s1: 17, s2: 18, s3: 19, s4: 20, s5: 21, s6: 22, s7: 23, t8: 24, t9: 25, k0: 26, k1: 27, gp: 28, sp: 29, s8: 30, ra: 31,
};
const FLOAT_REGISTERS = Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`f${n}`, n]));
const FLOAT_MEMORY = { lwc1: 0x31, swc1: 0x39 };
const SPECIAL = { sll: 0x00, srl: 0x02, sra: 0x03, jr: 0x08, mult: 0x18, multu: 0x19, add: 0x20, addu: 0x21, subu: 0x23,
  and: 0x24, or: 0x25, xor: 0x26, nor: 0x27, slt: 0x2A, sltu: 0x2B };
const IMMEDIATE = { beq: 0x04, bne: 0x05, blez: 0x06, bgtz: 0x07, addi: 0x08, addiu: 0x09, slti: 0x0A, andi: 0x0C, ori: 0x0D,
  xori: 0x0E, lui: 0x0F, lb: 0x20, lh: 0x21, lw: 0x23, lbu: 0x24, lhu: 0x25, sb: 0x28, sh: 0x29, sw: 0x2B };
const MEMORY_RE = /^(-?(?:0x[0-9a-fA-F]+|\d+))\((\w+)\)$/;
const LABEL_RE = /^@(\d+)$/;

export class AssemblyError extends Error {}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function reg(name) { if (!has(REGISTERS, name)) throw new AssemblyError(`unknown register '${name}'`); return REGISTERS[name]; }
function freg(name) { if (!has(FLOAT_REGISTERS, name)) throw new AssemblyError(`unknown float register '${name}'`); return FLOAT_REGISTERS[name]; }
function int0(text) { const neg = text.startsWith("-"); const t = neg ? text.slice(1) : text; const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, 10); return neg ? -v : v; }
const imm = (text) => int0(text) & 0xFFFF;

function encode(m, ops, index) {
  if (m === "nop") return 0;
  if (m === "jal" || m === "j") return ((m === "jal" ? 0x03 : 0x02) << 26) >>> 0;
  if (m === "move") return ((reg(ops[1]) << 21) | (reg(ops[0]) << 11) | 0x21) >>> 0;
  if (m === "li") return ((0x09 << 26) | (reg(ops[0]) << 16) | imm(ops[1])) >>> 0;
  if (has(FLOAT_MEMORY, m)) {
    const mem = MEMORY_RE.exec(ops[1]);
    if (!mem) throw new AssemblyError(`${m} needs an offset(base) operand`);
    return ((FLOAT_MEMORY[m] << 26) | (reg(mem[2]) << 21) | (freg(ops[0]) << 16) | imm(mem[1])) >>> 0;
  }
  if (has(SPECIAL, m)) {
    const funct = SPECIAL[m];
    if (["sll", "srl", "sra"].includes(m)) return ((reg(ops[1]) << 16) | (reg(ops[0]) << 11) | ((int0(ops[2]) & 0x1F) << 6) | funct) >>> 0;
    if (m === "jr") return ((reg(ops[0]) << 21) | funct) >>> 0;
    if (m === "mult" || m === "multu") return ((reg(ops[0]) << 21) | (reg(ops[1]) << 16) | funct) >>> 0;
    return ((reg(ops[1]) << 21) | (reg(ops[2]) << 16) | (reg(ops[0]) << 11) | funct) >>> 0;
  }
  if (has(IMMEDIATE, m)) {
    const op = IMMEDIATE[m];
    if (m === "lui") return ((op << 26) | (reg(ops[0]) << 16) | imm(ops[1])) >>> 0;
    if (m === "beq" || m === "bne") {
      const offset = parseInt(ops[2].slice(1), 10) - index - 1;
      return ((op << 26) | (reg(ops[0]) << 21) | (reg(ops[1]) << 16) | (offset & 0xFFFF)) >>> 0;
    }
    if (m === "blez" || m === "bgtz") {
      const offset = parseInt(ops[1].slice(1), 10) - index - 1;
      return ((op << 26) | (reg(ops[0]) << 21) | (offset & 0xFFFF)) >>> 0;
    }
    const mem = MEMORY_RE.exec(ops[1]);
    if (mem) return ((op << 26) | (reg(mem[2]) << 21) | (reg(ops[0]) << 16) | imm(mem[1])) >>> 0;
    return ((op << 26) | (reg(ops[1]) << 21) | (reg(ops[0]) << 16) | imm(ops[2])) >>> 0;
  }
  throw new AssemblyError(`unsupported mnemonic '${m}'`);
}

function display(m, ops, index, symbol) {
  if (m === "nop") return "nop";
  if (m === "jal" || m === "j") return `${m} 0 <${ops[0]}>`;
  const rendered = ops.map((operand) => {
    const label = LABEL_RE.exec(operand);
    if (label) { const address = parseInt(label[1], 10) * 4; return `${address.toString(16)} <${symbol}+0x${address.toString(16)}>`; }
    const mem = MEMORY_RE.exec(operand);
    if (mem) return `${mem[1]}($${mem[2]})`;
    return has(REGISTERS, operand) || has(FLOAT_REGISTERS, operand) ? `$${operand}` : operand;
  });
  return `${m} ` + rendered.join(",");
}

/**
 * @param {string[]} lines
 * @param {{symbol?: string, relocations?: Record<number,string>|null}} [opts]
 */
export function assemble(lines, { symbol = "demo", relocations = null } = {}) {
  const relocationMap = relocations ?? {};
  const out = [`00000000 <${symbol}>:`];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const sp = trimmed.search(/\s/);
    const mnemonic = sp < 0 ? trimmed : trimmed.slice(0, sp);
    const rest = sp < 0 ? "" : trimmed.slice(sp).trim();
    const operands = rest ? rest.split(",").map((s) => s.trim()) : [];
    const word = encode(mnemonic, operands, index);
    const address = index * 4;
    out.push(`${address.toString(16).padStart(4)}: ${word.toString(16).padStart(8, "0")}  ${display(mnemonic, operands, index, symbol)}`);
    const kind = relocationMap[index];
    if (kind) out.push(`${" ".repeat(24)}${address.toString(16)}: ${kind}`);
  });
  return out.join("\n") + "\n";
}
