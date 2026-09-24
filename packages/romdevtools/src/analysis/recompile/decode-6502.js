// 6502 batch decoder for the IR exporter.
//
// WHY NOT da65: da65 is a whole-file DISASSEMBLER. It follows its own
// tiling, emits labels and directives, and cannot be asked "decode exactly
// the instruction at offset N" for 32,768 offsets without re-running per
// offset - the per-call flood this exporter exists to avoid.
//
// The 6502 needs no external decoder. It has 256 fixed-length opcodes and no
// prefixes, so the table below IS the decoder, and it is checked against
// da65 on a real ROM by test/m6502-decode.test.js rather than trusted.
import { m6502Length } from "./m6502-metadata.js";

// mnemonic + addressing mode per opcode. Undocumented opcodes decode as
// `.byte`, which the recompiler turns into a trap - correct, since executing
// one is a real fault on most NES hardware.
const M = new Array(256).fill(null);
function set(op, mnem, mode) { M[op] = { mnem, mode }; }

const ALU = { 0x00: "ora", 0x20: "and", 0x40: "eor", 0x60: "adc",
              0x80: "sta", 0xa0: "lda", 0xc0: "cmp", 0xe0: "sbc" };
// cc=01 group: (zp,x) zp # abs (zp),y zp,x abs,y abs,x
const ALU_MODES = ["indx", "zp", "imm", "abs", "indy", "zpx", "absy", "absx"];
for (const [base, mnem] of Object.entries(ALU)) {
  for (let b = 0; b < 8; b++) {
    const op = Number(base) | (b << 2) | 1;
    // sta #imm does not exist; that slot is an undocumented nop
    if (mnem === "sta" && ALU_MODES[b] === "imm") continue;
    set(op, mnem, ALU_MODES[b]);
  }
}
// cc=10 shift/inc group
const RMW = { 0x00: "asl", 0x20: "rol", 0x40: "lsr", 0x60: "ror",
              0x80: "stx", 0xa0: "ldx", 0xc0: "dec", 0xe0: "inc" };
const RMW_MODES = ["imm", "zp", "acc", "abs", null, "zpx", null, "absx"];
for (const [base, mnem] of Object.entries(RMW)) {
  for (let b = 0; b < 8; b++) {
    const mode = RMW_MODES[b];
    if (!mode) continue;
    const op = Number(base) | (b << 2) | 2;
    if (mnem === "ldx" && mode === "zpx") { set(op, "ldx", "zpy"); continue; }
    if (mnem === "stx" && mode === "zpx") { set(op, "stx", "zpy"); continue; }
    if (mnem === "ldx" && mode === "absx") { set(op, "ldx", "absy"); continue; }
    if ((mnem === "stx" || mnem === "dec" || mnem === "inc") && mode === "imm") continue;
    if (mnem === "stx" && mode === "absx") continue;
    set(op, mnem, mode);
  }
}
// cc=00 group
const G0 = { 0x20: "bit", 0x40: "jmp", 0x60: "jmpi", 0x80: "sty",
             0xa0: "ldy", 0xc0: "cpy", 0xe0: "cpx" };
const G0_MODES = ["imm", "zp", null, "abs", null, "zpx", null, "absx"];
for (const [base, mnem] of Object.entries(G0)) {
  for (let b = 0; b < 8; b++) {
    const mode = G0_MODES[b];
    if (!mode) continue;
    const op = Number(base) | (b << 2);
    if (mnem === "bit" && mode !== "zp" && mode !== "abs") continue;
    if (mnem === "jmp") { if (mode === "abs") set(0x4c, "jmp", "abs"); continue; }
    if (mnem === "jmpi") { if (mode === "abs") set(0x6c, "jmp", "ind"); continue; }
    if (mnem === "sty" && mode === "imm") continue;
    if ((mnem === "cpy" || mnem === "cpx") && (mode === "zpx" || mode === "absx")) continue;
    if (mnem === "sty" && mode === "absx") continue;
    set(op, mnem, mode);
  }
}
// branches, implied, and the rest
const FIXED = {
  0x00: ["brk", "imp"], 0x20: ["jsr", "abs"], 0x40: ["rti", "imp"],
  0x60: ["rts", "imp"], 0x08: ["php", "imp"], 0x28: ["plp", "imp"],
  0x48: ["pha", "imp"], 0x68: ["pla", "imp"], 0x88: ["dey", "imp"],
  0xa8: ["tay", "imp"], 0xc8: ["iny", "imp"], 0xe8: ["inx", "imp"],
  0x18: ["clc", "imp"], 0x38: ["sec", "imp"], 0x58: ["cli", "imp"],
  0x78: ["sei", "imp"], 0x98: ["tya", "imp"], 0xb8: ["clv", "imp"],
  0xd8: ["cld", "imp"], 0xf8: ["sed", "imp"], 0x8a: ["txa", "imp"],
  0x9a: ["txs", "imp"], 0xaa: ["tax", "imp"], 0xba: ["tsx", "imp"],
  0xca: ["dex", "imp"], 0xea: ["nop", "imp"],
  0x10: ["bpl", "rel"], 0x30: ["bmi", "rel"], 0x50: ["bvc", "rel"],
  0x70: ["bvs", "rel"], 0x90: ["bcc", "rel"], 0xb0: ["bcs", "rel"],
  0xd0: ["bne", "rel"], 0xf0: ["beq", "rel"],
  0x0a: ["asl", "acc"], 0x2a: ["rol", "acc"], 0x4a: ["lsr", "acc"],
  0x6a: ["ror", "acc"],
};
for (const [op, [mnem, mode]] of Object.entries(FIXED)) set(Number(op), mnem, mode);

const HEX = (v, n) => "$" + v.toString(16).toUpperCase().padStart(n, "0");

/** Instruction length is a pure function of addressing mode. */
const MODE_LEN = {
  imp: 1, acc: 1,
  imm: 2, zp: 2, zpx: 2, zpy: 2, indx: 2, indy: 2, rel: 2,
  abs: 3, absx: 3, absy: 3, ind: 3,
};

/** Render operands the way the rest of romdev spells them. */
function operands(mode, b, addr, len) {
  const u8 = b[1], u16 = b[1] | (b[2] << 8);
  switch (mode) {
    case "imp": return "";
    case "acc": return "a";
    case "imm": return "#" + HEX(u8, 2);
    case "zp": return HEX(u8, 2);
    case "zpx": return HEX(u8, 2) + ",x";
    case "zpy": return HEX(u8, 2) + ",y";
    case "abs": return HEX(u16, 4);
    case "absx": return HEX(u16, 4) + ",x";
    case "absy": return HEX(u16, 4) + ",y";
    case "ind": return "(" + HEX(u16, 4) + ")";
    case "indx": return "(" + HEX(u8, 2) + ",x)";
    case "indy": return "(" + HEX(u8, 2) + "),y";
    case "rel": {
      const rel = (u8 << 24) >> 24;
      return HEX((addr + 2 + rel) & 0xffff, 4);
    }
    default: return "";
  }
}

/**
 * Decode ONE instruction at `off` in `rom`.
 * @returns {{mnemonic:string, ops:string, len:number, bytes:number[],
 *            decodeStatus:string}}
 */
export function decodeOne(rom, off, addr = off) {
  const op = rom[off];
  if (op === undefined) return null;
  const e = M[op];
  // LENGTH COMES FROM THE MODE, not a separate table. Keeping two lists in
  // step is a standing invitation to exactly the bug this replaces: the LEN
  // table said 1 for opcodes the mode table decoded as immediate, so the
  // truncation guard passed with one byte and rendering the operand read
  // undefined.
  const len = e ? MODE_LEN[e.mode] : 1;
  const bytes = [...rom.subarray(off, Math.min(off + len, rom.length))];
  // TRUNCATION CHECK MUST COME FIRST. An instruction at the ROM's tail whose
  // operand bytes are missing has bytes.length < len, and rendering its
  // operands reads undefined. Emit it as data instead - which is what it is.
  if (!e || bytes.length < len) {
    return { mnemonic: ".byte", ops: HEX(op, 2), len: 1, bytes: [op],
             decodeStatus: "data" };
  }
  return { mnemonic: e.mnem, ops: operands(e.mode, bytes, addr, len),
           len, bytes, decodeStatus: "decoded" };
}

/** Batch form matching the exporter's decoder contract. */
export function decodeBatch(rom, offsets, addrOf = (o) => o) {
  const out = new Map();
  for (const off of offsets) {
    const r = decodeOne(rom, off, addrOf(off));
    if (!r) continue;
    out.set(off, { addr: addrOf(off), mnem: r.mnemonic, ops: r.ops,
                   bytes: r.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "),
                   decodeStatus: r.decodeStatus });
  }
  return out;
}

/**
 * Linear walk over [from, to) producing objdump-shaped rows.
 * Used for the PRIMARY tiling, where each instruction's length advances the
 * cursor - the same contract objdump's output satisfies.
 */
export function decodeLinear(rom, from, to, startAddr) {
  const rows = [];
  let off = from;
  while (off < to) {
    // DO NOT WRAP AT 16 BITS. The exporter recovers a record's file offset
    // as `window.off + row.addr - window.addr`, so wrapping breaks that
    // arithmetic on any ROM whose window base exceeds $FFFF - a 3MB
    // cart failed with "decoder byte/offset mismatch at ROM offset 2".
    // Operand RENDERING still masks to 16 bits where the CPU would.
    const addr = startAddr + (off - from);
    const r = decodeOne(rom, off, addr);
    if (!r) break;
    // Match objdump's row shape exactly: `mnem`, and `bytes` as a SPACE-
    // SEPARATED HEX STRING. decodedIR() parses that string and reads
    // row.mnem, so anything else fails with an opaque undefined error.
    rows.push({ addr, mnem: r.mnemonic, ops: r.ops,
                bytes: r.bytes.map((b) => b.toString(16).padStart(2, "0")).join(" "),
                decodeStatus: r.decodeStatus });
    off += r.len;
  }
  return rows;
}
