// 65816 batch decoder for the IR exporter.
//
// Same reasoning as the 6502: binutils has no 65816 target, and da65 is a
// whole-file disassembler that cannot be asked for one instruction at a
// given offset without a per-offset flood.
//
// THE HARD PART IS INSTRUCTION WIDTH. On the 65816 an immediate operand is
// 1 or 2 bytes depending on the M (accumulator) and X (index) flags, which
// are RUNTIME state set by `sep`/`rep`. A static decoder cannot know them, so
// this one tracks them along the linear walk - `rep #$20` clears M, `sep #$20`
// sets it - and reports the assumption in each record. That is the documented
// asar footgun in the other direction: guess the width and every subsequent
// instruction is misaligned.
import { modeOperandBytes } from "./m65816-metadata.js";

const M = new Array(256).fill(null);
function set(op, mnem, mode) { M[op] = { mnem, mode }; }

// cc=01 ALU group, same low-3-bits structure as the 6502 plus the 65816's
// stack-relative and long modes.
const ALU = { 0x00: "ora", 0x20: "and", 0x40: "eor", 0x60: "adc",
              0x80: "sta", 0xa0: "lda", 0xc0: "cmp", 0xe0: "sbc" };
// The cc=01 column, by LOW NIBBLE. Writing it as `(i<<2)|1` and a separate
// list put `sr` where `dp` belongs (0xA5 is `lda dp`, not `lda sr`) and the
// `b|0x02` line clobbered `ldx #imm` at 0xA2. Indexing by the actual low
// nibble makes the mapping checkable against an opcode matrix by eye.
const ALU_BY_LOW = {
  0x01: "idpx", 0x03: "sr",   0x05: "dp",   0x07: "ildp",
  0x09: "immM", 0x0d: "abs",  0x0f: "absl",
  0x11: "idpy", 0x13: "sry",  0x15: "dpx",  0x17: "ildpy",
  0x19: "absy", 0x1d: "absx", 0x1f: "abslx",
  0x12: "idp",
};
for (const [base, mnem] of Object.entries(ALU)) {
  const b = Number(base);
  for (const [lo, mode] of Object.entries(ALU_BY_LOW)) {
    // `sta #imm` does not exist; 0x89 is BIT #imm.
    if (mnem === "sta" && mode === "immM") continue;
    set(b | Number(lo), mnem, mode);
  }
}
set(0x89, "bit", "immM");

const RMW = { 0x00: "asl", 0x20: "rol", 0x40: "lsr", 0x60: "ror",
              0x80: "stx", 0xa0: "ldx", 0xc0: "dec", 0xe0: "inc" };
for (const [base, mnem] of Object.entries(RMW)) {
  const b = Number(base);
  set(b | 0x06, mnem, "dp");
  set(b | 0x0e, mnem, "abs");
  set(b | 0x16, mnem, mnem === "stx" || mnem === "ldx" ? "dpy" : "dpx");
  set(b | 0x1e, mnem, mnem === "ldx" ? "absy" : "absx");
  if (mnem === "asl" || mnem === "rol" || mnem === "lsr" || mnem === "ror")
    set(b | 0x0a, mnem, "acc");
}
set(0xa2, "ldx", "immX"); set(0xa0, "ldy", "immX");
set(0xe0, "cpx", "immX"); set(0xc0, "cpy", "immX");
set(0xa4, "ldy", "dp"); set(0xac, "ldy", "abs");
set(0xb4, "ldy", "dpx"); set(0xbc, "ldy", "absx");
set(0xa6, "ldx", "dp"); set(0xae, "ldx", "abs");
set(0x84, "sty", "dp"); set(0x8c, "sty", "abs"); set(0x94, "sty", "dpx");
set(0x86, "stx", "dp"); set(0x8e, "stx", "abs"); set(0x96, "stx", "dpy");
set(0xe4, "cpx", "dp"); set(0xec, "cpx", "abs");
set(0xc4, "cpy", "dp"); set(0xcc, "cpy", "abs");
set(0x24, "bit", "dp"); set(0x2c, "bit", "abs");
set(0x34, "bit", "dpx"); set(0x3c, "bit", "absx");

const FIXED = {
  0x00: ["brk", "imm8"], 0x02: ["cop", "imm8"],
  0x08: ["php", "imp"], 0x28: ["plp", "imp"],
  0x48: ["pha", "imp"], 0x68: ["pla", "imp"],
  0x5a: ["phy", "imp"], 0x7a: ["ply", "imp"],
  0xda: ["phx", "imp"], 0xfa: ["plx", "imp"],
  0x8b: ["phb", "imp"], 0xab: ["plb", "imp"],
  0x0b: ["phd", "imp"], 0x2b: ["pld", "imp"],
  0x4b: ["phk", "imp"], 0x62: ["per", "rell"],
  0xd4: ["pei", "dp"], 0xf4: ["pea", "abs"],
  0x18: ["clc", "imp"], 0x38: ["sec", "imp"], 0x58: ["cli", "imp"],
  0x78: ["sei", "imp"], 0xb8: ["clv", "imp"], 0xd8: ["cld", "imp"],
  0xf8: ["sed", "imp"], 0xfb: ["xce", "imp"], 0xeb: ["xba", "imp"],
  0xc2: ["rep", "imm8"], 0xe2: ["sep", "imm8"],
  0x1b: ["tcs", "imp"], 0x3b: ["tsc", "imp"], 0x5b: ["tcd", "imp"],
  0x7b: ["tdc", "imp"], 0x9a: ["txs", "imp"], 0xba: ["tsx", "imp"],
  0x88: ["dey", "imp"], 0xc8: ["iny", "imp"], 0xca: ["dex", "imp"],
  0xe8: ["inx", "imp"], 0xaa: ["tax", "imp"], 0xa8: ["tay", "imp"],
  0x8a: ["txa", "imp"], 0x98: ["tya", "imp"], 0x9b: ["txy", "imp"],
  0xbb: ["tyx", "imp"], 0x1a: ["inc", "acc"], 0x3a: ["dec", "acc"],
  0xea: ["nop", "imp"], 0x42: ["wdm", "imm8"],
  0xdb: ["stp", "imp"], 0xcb: ["wai", "imp"],
  0x20: ["jsr", "abs"], 0x22: ["jsl", "absl"], 0xfc: ["jsr", "indx"],
  0x4c: ["jmp", "abs"], 0x5c: ["jml", "absl"], 0x6c: ["jmp", "ind"],
  0x7c: ["jmp", "indx"], 0xdc: ["jml", "indl"],
  0x60: ["rts", "imp"], 0x6b: ["rtl", "imp"], 0x40: ["rti", "imp"],
  0x10: ["bpl", "rel"], 0x30: ["bmi", "rel"], 0x50: ["bvc", "rel"],
  0x70: ["bvs", "rel"], 0x90: ["bcc", "rel"], 0xb0: ["bcs", "rel"],
  0xd0: ["bne", "rel"], 0xf0: ["beq", "rel"], 0x80: ["bra", "rel"],
  0x82: ["brl", "rell"],
  0x44: ["mvp", "bm"], 0x54: ["mvn", "bm"],
  0x04: ["tsb", "dp"], 0x0c: ["tsb", "abs"],
  0x14: ["trb", "dp"], 0x1c: ["trb", "abs"],
  0x64: ["stz", "dp"], 0x74: ["stz", "dpx"],
  0x9c: ["stz", "abs"], 0x9e: ["stz", "absx"],
};
for (const [op, [mnem, mode]] of Object.entries(FIXED)) set(Number(op), mnem, mode);

/**
 * The opcode grid entry for one opcode byte, with the addressing mode left
 * UNRESOLVED (`immM`/`immX` stay as-is). The WAT recompiler lowers from this
 * so the arms, the RAM interpreter's tables and the IR exporter all share
 * one table.
 * @param {number} op
 * @returns {{mnem: string, mode: string} | null}
 */
export function opcodeInfo(op) {
  const e = M[op & 0xff];
  return e ? { mnem: e.mnem, mode: e.mode } : null;
}

const HEX = (v, n) => "$" + v.toString(16).toUpperCase().padStart(n, "0");

function resolveMode(mode, mflag, xflag) {
  if (mode === "immM") return mflag ? "imm8" : "imm16";
  if (mode === "immX") return xflag ? "imm8" : "imm16";
  return mode;
}

function operands(mode, b, addr) {
  const u8 = b[1], u16 = b[1] | (b[2] << 8);
  const u24 = b[1] | (b[2] << 8) | (b[3] << 16);
  switch (mode) {
    case "imp": return "";
    case "acc": return "a";
    case "imm8": return "#" + HEX(u8, 2);
    case "imm16": return "#" + HEX(u16, 4);
    case "dp": return HEX(u8, 2);
    case "dpx": return HEX(u8, 2) + ",x";
    case "dpy": return HEX(u8, 2) + ",y";
    case "idp": return "(" + HEX(u8, 2) + ")";
    case "idpx": return "(" + HEX(u8, 2) + ",x)";
    case "idpy": return "(" + HEX(u8, 2) + "),y";
    case "ildp": return "[" + HEX(u8, 2) + "]";
    case "ildpy": return "[" + HEX(u8, 2) + "],y";
    case "abs": return HEX(u16, 4);
    case "absx": return HEX(u16, 4) + ",x";
    case "absy": return HEX(u16, 4) + ",y";
    case "absl": return HEX(u24, 6);
    case "abslx": return HEX(u24, 6) + ",x";
    case "ind": return "(" + HEX(u16, 4) + ")";
    case "indx": return "(" + HEX(u16, 4) + ",x)";
    case "indl": return "[" + HEX(u16, 4) + "]";
    case "sr": return HEX(u8, 2) + ",s";
    case "sry": return "(" + HEX(u8, 2) + ",s),y";
    case "rel": {
      const r = (u8 << 24) >> 24;
      return HEX((addr + 2 + r) & 0xffff, 4);
    }
    case "rell": {
      const r = (u16 << 16) >> 16;
      return HEX((addr + 3 + r) & 0xffff, 4);
    }
    case "bm": return HEX(b[1], 2) + "," + HEX(b[2], 2);
    default: return "";
  }
}

/**
 * Decode one instruction. `mflag`/`xflag` are the CURRENT M/X widths, which
 * the caller tracks - see decodeLinear.
 */
export function decodeOne(rom, off, addr = off, mflag = 1, xflag = 1) {
  const op = rom[off];
  if (op === undefined) return null;
  const e = M[op];
  if (!e) {
    return { mnemonic: ".byte", ops: HEX(op, 2), len: 1, bytes: [op],
             decodeStatus: "data" };
  }
  const mode = resolveMode(e.mode, mflag, xflag);
  const len = 1 + modeOperandBytes(mode);
  const bytes = [...rom.subarray(off, Math.min(off + len, rom.length))];
  if (bytes.length < len) {
    return { mnemonic: ".byte", ops: HEX(op, 2), len: 1, bytes: [op],
             decodeStatus: "data" };
  }
  return { mnemonic: e.mnem, ops: operands(mode, bytes, addr), len, bytes,
           mode, decodeStatus: "decoded" };
}

/** Does this instruction change M/X? Returns the new [m, x]. */
function applyFlagOp(r, mflag, xflag) {
  if (r.mnemonic === "sep" || r.mnemonic === "rep") {
    const v = r.bytes[1];
    const set = r.mnemonic === "sep" ? 1 : 0;
    if (v & 0x20) mflag = set;
    if (v & 0x10) xflag = set;
  }
  return [mflag, xflag];
}

export function decodeLinear(rom, from, to, startAddr, mflag = 1, xflag = 1) {
  const rows = [];
  let off = from;
  while (off < to) {
    // DO NOT WRAP AT 16 BITS. The exporter recovers a record's file offset
    // as `window.off + row.addr - window.addr`, so wrapping breaks that
    // arithmetic on any ROM whose window base exceeds $FFFF - a 3MB
    // cart failed with "decoder byte/offset mismatch at ROM offset 2".
    // Operand RENDERING still masks to 16 bits where the CPU would.
    const addr = startAddr + (off - from);
    const r = decodeOne(rom, off, addr, mflag, xflag);
    if (!r) break;
    rows.push({ addr, mnem: r.mnemonic, ops: r.ops,
                bytes: r.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "),
                decodeStatus: r.decodeStatus });
    [mflag, xflag] = applyFlagOp(r, mflag, xflag);
    off += r.len;
  }
  return rows;
}

export function decodeBatch(rom, offsets, addrOf = (o) => o) {
  const out = new Map();
  for (const off of offsets) {
    // A batch decode has no flag history, so it assumes 8-bit M/X - the
    // reset state. A record whose width that changes is marked, not guessed
    // silently.
    const r = decodeOne(rom, off, addrOf(off), 1, 1);
    if (!r) continue;
    out.set(off, { addr: addrOf(off), mnem: r.mnemonic, ops: r.ops,
                   bytes: r.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "),
                   decodeStatus: r.decodeStatus });
  }
  return out;
}
