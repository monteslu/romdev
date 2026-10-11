// 6502 -> WAT lowering for the NES cart, decoded straight from PRG bytes.
//
// Decoding from the opcode byte means the addressing mode is KNOWN, not
// inferred from disassembler text, and it gives the exact cycle behaviour of
// the reference.
//
// TIMING FOLLOWS fceumm's x6502.c EXACTLY, because the picture depends on it:
//   * the opcode's base cycles (CycTable) are charged at FETCH, in $step,
//     before any of the instruction's memory accesses, so a `sta $2005` is
//     seen by the PPU at the time AFTER its 4 cycles;
//   * a read through abs,X / abs,Y / (zp),Y that crosses a page adds 1 cycle
//     (GetABIRD/GetIYRD) before the access, plus a dummy read of the
//     uncarried address;
//   * indexed stores and RMWs always do the dummy read (GetABIWR/GetIYWR) and
//     never add a cycle;
//   * a taken branch adds 1, and 1 more if it lands in another page;
//   * ADDCYC(n) is `count -= n*48; timestamp += n`.
//
// The dummy reads only matter when they hit I/O ($2002/$2007/$4016 have read
// side effects), so they are emitted only when the address can be I/O.
//
// Ported from the earlier Python emitter; the emitted text is
// kept identical so the two can be diffed.
//
// Plain JS ESM + JSDoc.

const OPS_TEXT = `
00 brk imp  01 ora izx  05 ora zp   06 asl zp   08 php imp  09 ora imm
0A asl acc  0D ora abs  0E asl abs  10 bpl rel  11 ora izy  15 ora zpx
16 asl zpx  18 clc imp  19 ora aby  1D ora abx  1E asl abx  20 jsr abs
21 and izx  24 bit zp   25 and zp   26 rol zp   28 plp imp  29 and imm
2A rol acc  2C bit abs  2D and abs  2E rol abs  30 bmi rel  31 and izy
35 and zpx  36 rol zpx  38 sec imp  39 and aby  3D and abx  3E rol abx
40 rti imp  41 eor izx  45 eor zp   46 lsr zp   48 pha imp  49 eor imm
4A lsr acc  4C jmp abs  4D eor abs  4E lsr abs  50 bvc rel  51 eor izy
55 eor zpx  56 lsr zpx  58 cli imp  59 eor aby  5D eor abx  5E lsr abx
60 rts imp  61 adc izx  65 adc zp   66 ror zp   68 pla imp  69 adc imm
6A ror acc  6C jmp ind  6D adc abs  6E ror abs  70 bvs rel  71 adc izy
75 adc zpx  76 ror zpx  78 sei imp  79 adc aby  7D adc abx  7E ror abx
81 sta izx  84 sty zp   85 sta zp   86 stx zp   88 dey imp  8A txa imp
8C sty abs  8D sta abs  8E stx abs  90 bcc rel  91 sta izy  94 sty zpx
95 sta zpx  96 stx zpy  98 tya imp  99 sta aby  9A txs imp  9D sta abx
A0 ldy imm  A1 lda izx  A2 ldx imm  A4 ldy zp   A5 lda zp   A6 ldx zp
A8 tay imp  A9 lda imm  AA tax imp  AC ldy abs  AD lda abs  AE ldx abs
B0 bcs rel  B1 lda izy  B4 ldy zpx  B5 lda zpx  B6 ldx zpy  B8 clv imp
B9 lda aby  BA tsx imp  BC ldy abx  BD lda abx  BE ldx aby  C0 cpy imm
C1 cmp izx  C4 cpy zp   C5 cmp zp   C6 dec zp   C8 iny imp  C9 cmp imm
CA dex imp  CC cpy abs  CD cmp abs  CE dec abs  D0 bne rel  D1 cmp izy
D5 cmp zpx  D6 dec zpx  D8 cld imp  D9 cmp aby  DD cmp abx  DE dec abx
E0 cpx imm  E1 sbc izx  E4 cpx zp   E5 sbc zp   E6 inc zp   E8 inx imp
E9 sbc imm  EA nop imp  EC cpx abs  ED sbc abs  EE inc abs  F0 beq rel
F1 sbc izy  F5 sbc zpx  F6 inc zpx  F8 sed imp  F9 sbc aby  FD sbc abx
FE inc abx
`;

// The undocumented opcodes fceumm implements (ops.h, "AAC" onward), with
// fceumm's semantics. skb = "DOP" (skips its operand byte WITHOUT reading
// it); top = "TOP" (LD_AB/LD_ABX: a real read, page-cross cycle included);
// atx = $AB ("ATX(OAL)": A |= $EE, A &= imm, X = A); las = $BB ("LAR",
// done as a RMW_ABY in fceumm). The twelve KIL/JAM bytes stay traps.
const UNOFFICIAL_TEXT = `
0B anc imm  2B anc imm  87 sax zp   97 sax zpy  8F sax abs  83 sax izx
6B arr imm  4B alr imm  AB atx imm  CB axs imm  8B xaa imm  EB sbc imm
C7 dcp zp   D7 dcp zpx  CF dcp abs  DF dcp abx  DB dcp aby  C3 dcp izx  D3 dcp izy
E7 isb zp   F7 isb zpx  EF isb abs  FF isb abx  FB isb aby  E3 isb izx  F3 isb izy
07 slo zp   17 slo zpx  0F slo abs  1F slo abx  1B slo aby  03 slo izx  13 slo izy
27 rla zp   37 rla zpx  2F rla abs  3F rla abx  3B rla aby  23 rla izx  33 rla izy
47 sre zp   57 sre zpx  4F sre abs  5F sre abx  5B sre aby  43 sre izx  53 sre izy
67 rra zp   77 rra zpx  6F rra abs  7F rra abx  7B rra aby  63 rra izx  73 rra izy
A7 lax zp   B7 lax zpy  AF lax abs  BF lax aby  A3 lax izx  B3 lax izy
BB las aby  93 sha izy  9F sha aby  9C shy abx  9E shx aby  9B tas aby
04 skb imm  14 skb imm  34 skb imm  44 skb imm  54 skb imm  64 skb imm  74 skb imm
80 skb imm  82 skb imm  89 skb imm  C2 skb imm  D4 skb imm  E2 skb imm  F4 skb imm
1A nop imp  3A nop imp  5A nop imp  7A nop imp  DA nop imp  FA nop imp
0C top abs  1C top abx  3C top abx  5C top abx  7C top abx  DC top abx  FC top abx
`;

/** Every opcode fceumm executes (official + undocumented, not KIL): opcode -> [mnemonic, addressing mode]. @type {Map<number, [string, string]>} */
export const OPS = new Map();
/** The 151 documented opcodes. @type {Set<number>} */
export const OFFICIAL = new Set();
{
  const t = OPS_TEXT.split(/\s+/).filter(Boolean);
  for (let i = 0; i < t.length; i += 3) { OPS.set(parseInt(t[i], 16), [t[i + 1], t[i + 2]]); OFFICIAL.add(parseInt(t[i], 16)); }
  const u = UNOFFICIAL_TEXT.split(/\s+/).filter(Boolean);
  for (let i = 0; i < u.length; i += 3) OPS.set(parseInt(u[i], 16), [u[i + 1], u[i + 2]]);
}

/** Instruction length by addressing mode. */
export const LEN = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, rel: 2,
  izx: 2, izy: 2, abs: 3, abx: 3, aby: 3, ind: 3,
};

const READS = new Set(["lda", "ldx", "ldy", "ora", "and", "eor", "adc", "sbc", "cmp", "cpx", "cpy", "bit",
  "lax", "top", "anc", "alr", "arr", "atx", "axs", "xaa"]);
const RMW = new Set(["asl", "lsr", "rol", "ror", "inc", "dec"]);
/** undocumented RMW + ALU pairs (fceumm RMW_xx(OP1;OP2)) */
const RMW2 = { slo: ["asl", "ora"], rla: ["rol", "and"], sre: ["lsr", "eor"], rra: ["ror", "adc"], dcp: ["dec", "cmp"], isb: ["inc", "sbc"] };
const STORES = new Set(["sta", "stx", "sty", "sax", "sha", "shx", "shy", "tas"]);

/** Thrown for a KIL/JAM byte (fceumm jams the CPU); the arm becomes a trap. */
export class Unsupported extends Error {}

/**
 * ADDCYC(n) as WAT statements.
 * @param {number} n
 */
export function cyc(n) {
  return `(global.set $cnt (i32.sub (global.get $cnt) (i32.const ${48 * n})))` +
    `(global.set $ts (i32.add (global.get $ts) (i32.const ${n})))`;
}

/** @param {string} e */
function nz(e) {
  return `(global.set $fz (i32.eqz ${e}))` +
    `(global.set $fn (i32.shr_u ${e} (i32.const 7)))`;
}

/** Can an access into page `hi` (or the page after it) touch I/O? @param {number} hi */
function ioPage(hi) {
  return (hi >= 0x20 && hi <= 0x40) || hi === 0x1F;
}

/**
 * Can an indexed read from base `n16` (+0..$FF) land on open bus, i.e. an
 * address fceumm answers with X.DB ($4000-$4014 and $4018-$5FFF: write-only
 * APU registers and the unmapped expansion area)?
 * @param {number} n16
 */
function openBusRange(n16) {
  const lo = n16, hi = n16 + 0xFF;
  return (lo <= 0x4014 && hi >= 0x4000) || (lo <= 0x5FFF && hi >= 0x4018);
}

/** @param {string} v */
function push(v) {
  return `(i32.store8 (i32.or (i32.const 0x100) (global.get $s)) ${v})` +
    "(global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFF)))";
}

const POP = "(global.set $s (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFF)))" +
  "(i32.load8_u (i32.or (i32.const 0x100) (global.get $s)))";

/** The P register packed from the flag globals (bit 5 set, B clear). */
export const PACK_P = "(i32.or (i32.const 0x20) (i32.or " +
  "(i32.shl (global.get $fn) (i32.const 7)) (i32.or " +
  "(i32.shl (global.get $fv) (i32.const 6)) (i32.or " +
  "(i32.shl (global.get $fd) (i32.const 3)) (i32.or " +
  "(i32.shl (global.get $fi) (i32.const 2)) (i32.or " +
  "(i32.shl (global.get $fz) (i32.const 1)) " +
  "(global.get $fc)))))))";

/** @param {string} src */
function unpackP(src) {
  return `(global.set $t ${src})` +
    "(global.set $fn (i32.and (i32.shr_u (global.get $t) (i32.const 7)) (i32.const 1)))" +
    "(global.set $fv (i32.and (i32.shr_u (global.get $t) (i32.const 6)) (i32.const 1)))" +
    "(global.set $fd (i32.and (i32.shr_u (global.get $t) (i32.const 3)) (i32.const 1)))" +
    "(global.set $fi (i32.and (i32.shr_u (global.get $t) (i32.const 2)) (i32.const 1)))" +
    "(global.set $fz (i32.and (i32.shr_u (global.get $t) (i32.const 1)) (i32.const 1)))" +
    "(global.set $fc (i32.and (global.get $t) (i32.const 1)))";
}

/**
 * @typedef {object} RomView
 * @property {(addr: number) => (number|null)} fixedByte  the byte at CPU
 *   address $8000-$FFFF when it cannot change at run time (a constant-folded
 *   ROM operand), else null (a banked window: read it through $rd8).
 */

/**
 * @typedef {[string, number|null]} Kind  where an operand lives: zp / zpd /
 *   ram / ramd / abs / rom / dyn, plus the static address when there is one.
 */

/**
 * Operand access for one addressing mode.
 * @param {string} mode
 * @param {string} mnem
 * @param {number} b1
 * @param {number} b2
 * @param {RomView} rom
 * @returns {[string, Kind|null, string]} [pre statements, kind, load expression]
 */
function operand(mode, mnem, b1, b2, rom) {
  if (rom.dynamic) return operandDyn(mode, mnem);
  const n16 = b1 | (b2 << 8);
  const isread = READS.has(mnem);
  if (mode === "imm") return ["", null, `(i32.const ${b1})`];
  if (mode === "zp") return ["", ["zp", b1], `(i32.load8_u (i32.const ${b1}))`];
  if (mode === "zpx" || mode === "zpy") {
    const r = mode === "zpx" ? "$x" : "$y";
    const pre = `(global.set $ea (i32.and (i32.add (global.get ${r}) ` +
      `(i32.const ${b1})) (i32.const 0xFF)))`;
    return [pre, ["zpd", null], "(i32.load8_u (global.get $ea))"];
  }
  if (mode === "abs") {
    if (n16 < 0x2000) return ["", ["ram", n16 & 0x7FF], `(i32.load8_u (i32.const ${n16 & 0x7FF}))`];
    if (n16 >= 0x8000 && isread) {
      const k = rom.fixedByte(n16);
      if (k !== null) return ["", ["rom", n16], `(i32.const ${k})`];
    }
    return ["", ["abs", n16], `(call $rd8 (i32.const ${n16}))`];
  }
  if (mode === "abx" || mode === "aby") {
    const r = mode === "abx" ? "$x" : "$y";
    let pre = `(global.set $ea (i32.and (i32.add (global.get ${r}) ` +
      `(i32.const ${n16})) (i32.const 0xFFFF)))`;
    const io = ioPage(b2) || ioPage((b2 + 1) & 0xFF);
    const uncarried = `(i32.or (i32.const ${n16 & 0xFF00}) ` +
      "(i32.and (global.get $ea) (i32.const 0xFF)))";
    if (isread && openBusRange(n16)) {
      // fceumm returns X.DB (the last byte on the bus) for an open-bus read:
      // the operand's high byte, or what the page-cross dummy read of the
      // uncarried address put there. $rd8i takes that byte explicitly.
      pre += `(global.set $t3 (i32.const ${b2}))`;
      pre += `(if (i32.gt_u (i32.add (global.get ${r}) (i32.const ${b1})) (i32.const 0xFF)) (then `;
      if (io) pre += `(global.set $t3 (call $rd8i ${uncarried} (i32.const ${b2})))`;
      pre += "(call $addcyc1)))";
      return [pre, ["dyn", null], "(call $rd8i (global.get $ea) (global.get $t3))"];
    }
    if (isread) {
      // GetABIRD: page cross -> dummy read of the uncarried address, then ADDCYC(1).
      let pc = `(if (i32.gt_u (i32.add (global.get ${r}) (i32.const ${b1})) (i32.const 0xFF)) (then `;
      if (io) pc += `(drop (call $rd8 ${uncarried}))`;
      pc += "(call $addcyc1)))";
      pre += pc;
    } else if (io) {
      // GetABIWR: always a dummy read of the uncarried address.
      pre += `(drop (call $rd8 ${uncarried}))`;
    }
    if (n16 + 0xFF < 0x2000) {
      return [pre, ["ramd", null], "(i32.load8_u (i32.and (global.get $ea) (i32.const 0x7FF)))"];
    }
    return [pre, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  if (mode === "izx") {
    const pre = `(global.set $t2 (i32.and (i32.add (global.get $x) (i32.const ${b1})) (i32.const 0xFF)))` +
      "(global.set $ea (i32.or (i32.load8_u (global.get $t2)) " +
      "(i32.shl (i32.load8_u (i32.and (i32.add (global.get $t2) (i32.const 1)) " +
      "(i32.const 0xFF))) (i32.const 8))))";
    return [pre, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  if (mode === "izy") {
    let pre = `(global.set $t2 (i32.or (i32.load8_u (i32.const ${b1})) ` +
      `(i32.shl (i32.load8_u (i32.const ${(b1 + 1) & 0xFF})) (i32.const 8))))` +
      "(global.set $ea (i32.and (i32.add (global.get $t2) (global.get $y)) (i32.const 0xFFFF)))";
    const unc = "(i32.or (i32.and (global.get $t2) (i32.const 0xFF00)) " +
      "(i32.and (global.get $ea) (i32.const 0xFF)))";
    if (isread) {
      // X.DB before the target read: the pointer's high byte, or the byte the
      // page-cross dummy read returned (only I/O can change it), for $rd8i.
      pre += "(global.set $t3 (i32.shr_u (global.get $t2) (i32.const 8)))" +
        "(if (i32.gt_u (i32.add (i32.and (global.get $t2) (i32.const 0xFF)) " +
        "(global.get $y)) (i32.const 0xFF)) (then " +
        `(global.set $t3 (call $dummyrdb ${unc} (global.get $t3))) (call $addcyc1)))`;
      return [pre, ["dyn", null], "(call $rd8i (global.get $ea) (global.get $t3))"];
    }
    pre += `(call $dummyrd ${unc})`;
    return [pre, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  throw new Unsupported(mode);
}

/**
 * The same addressing modes with the operand bytes read at RUN time (in the
 * globals $d1/$d2, fetched by the arm's prologue): code executing from RAM or
 * WRAM, and instructions that straddle a bank window. Every access fceumm
 * makes is kept (page-cross dummy reads and their X.DB, the extra cycle).
 * @param {string} mode
 * @param {string} mnem
 * @returns {[string, Kind|null, string]}
 */
function operandDyn(mode, mnem) {
  const isread = READS.has(mnem);
  const D1 = "(global.get $d1)", D2 = "(global.get $d2)";
  if (mode === "imm") return ["", null, D1];
  if (mode === "zp") return [`(global.set $ea ${D1})`, ["zpd", null], "(i32.load8_u (global.get $ea))"];
  if (mode === "zpx" || mode === "zpy") {
    const r = mode === "zpx" ? "$x" : "$y";
    return [`(global.set $ea (i32.and (i32.add (global.get ${r}) ${D1}) (i32.const 0xFF)))`, ["zpd", null], "(i32.load8_u (global.get $ea))"];
  }
  if (mode === "abs") {
    return [`(global.set $ea (i32.or ${D1} (i32.shl ${D2} (i32.const 8))))`, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  if (mode === "abx" || mode === "aby") {
    const r = mode === "abx" ? "$x" : "$y";
    let pre = `(global.set $ea (i32.and (i32.add (global.get ${r}) (i32.or ${D1} (i32.shl ${D2} (i32.const 8)))) (i32.const 0xFFFF)))`;
    const unc = `(i32.or (i32.shl ${D2} (i32.const 8)) (i32.and (global.get $ea) (i32.const 0xFF)))`;
    if (isread) {
      pre += `(global.set $t3 ${D2})(if (i32.gt_u (i32.add (global.get ${r}) ${D1}) (i32.const 0xFF)) (then ` +
        `(global.set $t3 (call $dummyrdb ${unc} ${D2})) (call $addcyc1)))`;
      return [pre, ["dyn", null], "(call $rd8i (global.get $ea) (global.get $t3))"];
    }
    return [pre + `(call $dummyrd ${unc})`, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  if (mode === "izx") {
    const pre = `(global.set $t2 (i32.and (i32.add (global.get $x) ${D1}) (i32.const 0xFF)))` +
      "(global.set $ea (i32.or (i32.load8_u (global.get $t2)) " +
      "(i32.shl (i32.load8_u (i32.and (i32.add (global.get $t2) (i32.const 1)) (i32.const 0xFF))) (i32.const 8))))";
    return [pre, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  if (mode === "izy") {
    let pre = `(global.set $t2 (i32.or (i32.load8_u ${D1}) ` +
      `(i32.shl (i32.load8_u (i32.and (i32.add ${D1} (i32.const 1)) (i32.const 0xFF))) (i32.const 8))))` +
      "(global.set $ea (i32.and (i32.add (global.get $t2) (global.get $y)) (i32.const 0xFFFF)))";
    const unc = "(i32.or (i32.and (global.get $t2) (i32.const 0xFF00)) (i32.and (global.get $ea) (i32.const 0xFF)))";
    if (isread) {
      pre += "(global.set $t3 (i32.shr_u (global.get $t2) (i32.const 8)))" +
        "(if (i32.gt_u (i32.add (i32.and (global.get $t2) (i32.const 0xFF)) (global.get $y)) (i32.const 0xFF)) (then " +
        `(global.set $t3 (call $dummyrdb ${unc} (global.get $t3))) (call $addcyc1)))`;
      return [pre, ["dyn", null], "(call $rd8i (global.get $ea) (global.get $t3))"];
    }
    return [pre + `(call $dummyrd ${unc})`, ["dyn", null], "(call $rd8 (global.get $ea))"];
  }
  throw new Unsupported(mode);
}

/**
 * @param {Kind} kind
 * @param {string} v
 */
function storeTo(kind, v) {
  const [k, n] = kind;
  if (k === "zp" || k === "ram") return `(i32.store8 (i32.const ${n}) ${v})`;
  if (k === "zpd") return `(i32.store8 (global.get $ea) ${v})`;
  if (k === "ramd") return `(i32.store8 (i32.and (global.get $ea) (i32.const 0x7FF)) ${v})`;
  if (k === "abs" || k === "rom") return `(call $wr8 (i32.const ${n}) ${v})`;
  return `(call $wr8 (global.get $ea) ${v})`;
}

const BRANCH_COND = {
  bpl: "(i32.eqz (global.get $fn))", bmi: "(global.get $fn)",
  bvc: "(i32.eqz (global.get $fv))", bvs: "(global.get $fv)",
  bcc: "(i32.eqz (global.get $fc))", bcs: "(global.get $fc)",
  bne: "(i32.eqz (global.get $fz))", beq: "(global.get $fz)",
};

const IMPLIED = {
  php: push(`(i32.or ${PACK_P} (i32.const 0x10))`),
  plp: unpackP(POP),
  pha: push("(global.get $a)"),
  pla: `(global.set $a ${POP})` + nz("(global.get $a)"),
  clc: "(global.set $fc (i32.const 0))",
  sec: "(global.set $fc (i32.const 1))",
  cli: "(global.set $fi (i32.const 0))",
  sei: "(global.set $fi (i32.const 1))",
  clv: "(global.set $fv (i32.const 0))",
  cld: "(global.set $fd (i32.const 0))",
  sed: "(global.set $fd (i32.const 1))",
  nop: "",
  txs: "(global.set $s (global.get $x))",
};
const TRANSFERS = { tax: ["a", "x"], tay: ["a", "y"], txa: ["x", "a"], tya: ["y", "a"], tsx: ["s", "x"] };

/**
 * RMW body on a source expression, leaving the result in $t.
 * @param {string} m
 * @param {string} src
 */
function rmwOn(m, src) {
  if (m === "asl") {
    return `(global.set $t ${src})` +
      "(global.set $fc (i32.shr_u (global.get $t) (i32.const 7)))" +
      "(global.set $t (i32.and (i32.shl (global.get $t) (i32.const 1)) (i32.const 0xFF)))";
  }
  if (m === "lsr") {
    return `(global.set $t ${src})` +
      "(global.set $fc (i32.and (global.get $t) (i32.const 1)))" +
      "(global.set $t (i32.shr_u (global.get $t) (i32.const 1)))";
  }
  if (m === "rol") {
    return `(global.set $t ${src})` +
      "(global.set $t2 (i32.shr_u (global.get $t) (i32.const 7)))" +
      "(global.set $t (i32.and (i32.or (i32.shl (global.get $t) (i32.const 1)) " +
      "(global.get $fc)) (i32.const 0xFF)))" +
      "(global.set $fc (global.get $t2))";
  }
  if (m === "ror") {
    return `(global.set $t ${src})` +
      "(global.set $t2 (i32.and (global.get $t) (i32.const 1)))" +
      "(global.set $t (i32.or (i32.shr_u (global.get $t) (i32.const 1)) " +
      "(i32.shl (global.get $fc) (i32.const 7))))" +
      "(global.set $fc (global.get $t2))";
  }
  const d = m === "inc" ? 1 : 0xFF;
  return `(global.set $t (i32.and (i32.add ${src} (i32.const ${d})) (i32.const 0xFF)))`;
}

/**
 * ALU operation of a READ instruction on the value expression `load`
 * (fceumm ops.h / x6502.c macros, including the undocumented ones).
 * @param {string} m
 * @param {string} load
 * @returns {string[]}
 */
function aluOn(m, load) {
  const body = [];
  if (m === "lda" || m === "ldx" || m === "ldy") {
    const r = "$" + m[2];
    body.push(`(global.set ${r} ${load})`);
    body.push(nz(`(global.get ${r})`));
  } else if (m === "ora" || m === "and" || m === "eor") {
    const o = { ora: "i32.or", and: "i32.and", eor: "i32.xor" }[m];
    body.push(`(global.set $a (${o} (global.get $a) ${load}))`);
    body.push(nz("(global.get $a)"));
  } else if (m === "adc" || m === "sbc") {
    const v = m === "adc" ? load : `(i32.xor ${load} (i32.const 0xFF))`;
    body.push(`(global.set $t2 ${v})`);
    body.push("(global.set $t (i32.add (i32.add (global.get $a) (global.get $t2)) (global.get $fc)))");
    body.push("(global.set $fv (i32.shr_u (i32.and (i32.and (i32.xor (global.get $a) " +
      "(i32.xor (global.get $t2) (i32.const 0xFF))) (i32.xor (global.get $a) " +
      "(global.get $t))) (i32.const 0x80)) (i32.const 7)))");
    body.push("(global.set $fc (i32.gt_u (global.get $t) (i32.const 0xFF)))");
    body.push("(global.set $a (i32.and (global.get $t) (i32.const 0xFF)))");
    body.push(nz("(global.get $a)"));
  } else if (m === "cmp" || m === "cpx" || m === "cpy") {
    const r = { cmp: "$a", cpx: "$x", cpy: "$y" }[m];
    body.push(`(global.set $t2 ${load})`);
    body.push(`(global.set $fc (i32.ge_u (global.get ${r}) (global.get $t2)))`);
    body.push(`(global.set $t (i32.and (i32.sub (global.get ${r}) (global.get $t2)) (i32.const 0xFF)))`);
    body.push(nz("(global.get $t)"));
  } else if (m === "bit") {
    body.push(`(global.set $t ${load})`);
    body.push("(global.set $fz (i32.eqz (i32.and (global.get $a) (global.get $t))))");
    body.push("(global.set $fn (i32.shr_u (global.get $t) (i32.const 7)))");
    body.push("(global.set $fv (i32.and (i32.shr_u (global.get $t) (i32.const 6)) (i32.const 1)))");
  } else if (m === "lax") {
    // LAX: LDA; LDX
    body.push(`(global.set $a ${load})`, "(global.set $x (global.get $a))", nz("(global.get $a)"));
  } else if (m === "top") {
    // TOP: LD_AB / LD_ABX with an empty op: the read (and its side effects) only
    body.push(`(drop ${load})`);
  } else if (m === "anc") {
    // AAC: AND; C = bit 7 of the result
    body.push(`(global.set $a (i32.and (global.get $a) ${load}))`, nz("(global.get $a)"),
      "(global.set $fc (i32.shr_u (global.get $a) (i32.const 7)))");
  } else if (m === "alr") {
    // ASR: AND; LSRA
    body.push(`(global.set $a (i32.and (global.get $a) ${load}))`,
      "(global.set $fc (i32.and (global.get $a) (i32.const 1)))",
      "(global.set $a (i32.shr_u (global.get $a) (i32.const 1)))", nz("(global.get $a)"));
  } else if (m === "arr") {
    // ARR: AND; V = bit 6 ^ bit 5 of the AND result; rotate right through
    // the OLD carry; C = bit 7 of the AND result
    body.push(`(global.set $a (i32.and (global.get $a) ${load}))`,
      "(global.set $fv (i32.and (i32.shr_u (i32.xor (global.get $a) (i32.shr_u (global.get $a) (i32.const 1))) (i32.const 6)) (i32.const 1)))",
      "(global.set $t2 (i32.shr_u (global.get $a) (i32.const 7)))",
      "(global.set $a (i32.or (i32.shr_u (global.get $a) (i32.const 1)) (i32.shl (global.get $fc) (i32.const 7))))",
      "(global.set $fc (global.get $t2))", nz("(global.get $a)"));
  } else if (m === "atx") {
    // ATX(OAL): A |= $EE; AND; X = A
    body.push(`(global.set $a (i32.and (i32.or (global.get $a) (i32.const 0xEE)) ${load}))`, nz("(global.get $a)"),
      "(global.set $x (global.get $a))");
  } else if (m === "xaa") {
    // XAA: A |= $EE; A &= X; AND imm
    body.push(`(global.set $a (i32.and (i32.and (i32.or (global.get $a) (i32.const 0xEE)) (global.get $x)) ${load}))`,
      nz("(global.get $a)"));
  } else if (m === "axs") {
    // AXS: t = (A & X) - imm; ZN(t & $FF); C = no borrow; X = t
    body.push(`(global.set $t2 ${load})`,
      "(global.set $fc (i32.ge_u (i32.and (global.get $a) (global.get $x)) (global.get $t2)))",
      "(global.set $x (i32.and (i32.sub (i32.and (global.get $a) (global.get $x)) (global.get $t2)) (i32.const 0xFF)))",
      nz("(global.get $x)"));
  } else {
    throw new Unsupported(m);
  }
  return body;
}

/** The unstable stores' value: reg & (((EA - index) >> 8) + 1), fceumm's formula. */
function hiPlusOne(v, idx) {
  return `(i32.and ${v} (i32.add (i32.shr_u (i32.sub (global.get $ea) (global.get ${idx})) (i32.const 8)) (i32.const 1)))`;
}

/**
 * Lower one instruction. `pcbase` is the canonical CPU address of the arm; it
 * only decides the static page-cross cost of a branch. The emitted code uses
 * the RUNTIME $pc for fall-through, pushes and branches, so an arm executed
 * through another mirror behaves exactly as the reference does there.
 *
 * With `rom.dynamic` the operand bytes are NOT known: the arm fetches them at
 * run time (the RAM/WRAM executor, and straddling instructions) and every
 * static shortcut (constant ROM operands, static branch costs) is off.
 *
 * @param {number} op
 * @param {number} b1
 * @param {number} b2
 * @param {RomView} rom
 * @param {number} pcbase
 * @returns {string} WAT statements that end by setting $pc
 */
export function lower(op, b1, b2, rom, pcbase) {
  const ent = OPS.get(op);
  if (!ent) throw new Unsupported(`opcode ${op.toString(16).toUpperCase().padStart(2, "0")}`);
  const [m, mode] = ent;
  const ln = LEN[mode];
  const dyn = !!rom.dynamic;
  // Base cycles are charged in $step (followed by the APU hook, as fceumm's
  // X6502_Run does), not here.
  const nxt = `(global.set $pc (i32.and (i32.add (global.get $pc) (i32.const ${ln})) (i32.const 0xFFFF)))`;
  const n16 = b1 | (b2 << 8);
  // dynamic: operand bytes from memory, as fceumm's RdMem(_PC) does
  const fetch = (k) => `(global.set $d${k} (call $rd8 (i32.and (i32.add (global.get $pc) (i32.const ${k})) (i32.const 0xFFFF))))`;
  const pro = dyn ? (ln >= 2 ? fetch(1) : "") + (ln >= 3 ? fetch(2) : "") : "";
  const N16 = dyn ? "(i32.or (global.get $d1) (i32.shl (global.get $d2) (i32.const 8)))" : `(i32.const ${n16})`;
  return pro + lowerBody();

  function lowerBody() {
  if (mode === "rel") {
    const cond = BRANCH_COND[m];
    if (dyn) {
      // JR: tmp = pc after the operand; pc = tmp + (int8)disp; +1, +1 more on a page change
      return `(if ${cond} (then ${cyc(1)}` +
        "(global.set $t (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))" +
        "(global.set $t2 (i32.and (i32.add (global.get $t) (i32.sub (i32.xor (global.get $d1) (i32.const 0x80)) (i32.const 0x80))) (i32.const 0xFFFF)))" +
        `(if (i32.and (i32.xor (global.get $t) (global.get $t2)) (i32.const 0x100)) (then ${cyc(1)}))` +
        `(global.set $pc (global.get $t2))) (else ${nxt}))`;
    }
    const disp = b1 >= 128 ? b1 - 256 : b1;
    const tmp = (pcbase + 2) & 0xFFFF;
    const tgt = (tmp + disp) & 0xFFFF;
    const pen = ((tmp ^ tgt) & 0x100) ? 2 : 1;
    return `(if ${cond} (then ${cyc(pen)} (global.set $pc (i32.and (i32.add ` +
      `(global.get $pc) (i32.const ${2 + disp})) (i32.const 0xFFFF)))) ` +
      `(else ${nxt}))`;
  }
  if (m === "jmp") {
    if (mode === "abs") return `(global.set $pc ${N16})`;
    // JMP ($xxFF) reads the high byte from $xx00 (the 6502 page-wrap bug).
    if (dyn) {
      return `(global.set $t ${N16})` +
        "(global.set $pc (i32.or (call $rd8 (global.get $t)) (i32.shl (call $rd8 (i32.or (i32.and (global.get $t) (i32.const 0xFF00)) " +
        "(i32.and (i32.add (global.get $t) (i32.const 1)) (i32.const 0xFF)))) (i32.const 8))))";
    }
    const hi = (n16 & 0xFF00) | ((n16 + 1) & 0xFF);
    return `(global.set $pc (i32.or (call $rd8 (i32.const ${n16})) ` +
      `(i32.shl (call $rd8 (i32.const ${hi})) (i32.const 8))))`;
  }
  if (m === "jsr") {
    return "(global.set $t (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))" +
      push("(i32.shr_u (global.get $t) (i32.const 8))") +
      push("(i32.and (global.get $t) (i32.const 0xFF))") +
      `(global.set $pc ${N16})`;
  }
  if (m === "rts") {
    return `(global.set $t ${POP})` +
      `(global.set $t (i32.or (global.get $t) (i32.shl ${POP} (i32.const 8))))` +
      "(global.set $pc (i32.and (i32.add (global.get $t) (i32.const 1)) (i32.const 0xFFFF)))";
  }
  if (m === "rti") {
    // fceumm RTI: _PI = _P, so a pending IRQ is taken right after it
    return unpackP(POP) + "(global.set $pi (global.get $fi))" +
      `(global.set $t ${POP})` +
      `(global.set $pc (i32.or (global.get $t) (i32.shl ${POP} (i32.const 8))))`;
  }
  if (m === "brk") {
    return "(global.set $t (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))" +
      push("(i32.shr_u (global.get $t) (i32.const 8))") +
      push("(i32.and (global.get $t) (i32.const 0xFF))") +
      push(`(i32.or ${PACK_P} (i32.const 0x10))`) +
      "(global.set $fi (i32.const 1))(global.set $pi (i32.const 1))" +
      "(global.set $pc (i32.or (call $rd8 (i32.const 0xFFFE)) " +
      "(i32.shl (call $rd8 (i32.const 0xFFFF)) (i32.const 8))))" +
      "(global.set $nbrk (i32.add (global.get $nbrk) (i32.const 1)))";
  }
  // DOP: `_PC++`, the operand byte is not even read
  if (m === "skb") return nxt;

  // ---- implied / accumulator ----------------------------------------------
  if ((mode === "imp" || mode === "acc") && !RMW.has(m)) {
    let s = IMPLIED[m];
    if (s === undefined) {
      if (TRANSFERS[m]) {
        const [a, b] = TRANSFERS[m];
        s = `(global.set $${b} (global.get $${a}))` + nz(`(global.get $${b})`);
      } else if (m === "inx" || m === "iny" || m === "dex" || m === "dey") {
        const r = (m === "inx" || m === "dex") ? "$x" : "$y";
        const d = m[0] === "i" ? 1 : 0xFF;
        s = `(global.set ${r} (i32.and (i32.add (global.get ${r}) (i32.const ${d})) (i32.const 0xFF)))` +
          nz(`(global.get ${r})`);
      } else {
        throw new Unsupported(m);
      }
    }
    return s + nxt;
  }

  // ---- shifts / rotates / inc / dec, and the undocumented RMW pairs ---------
  if (RMW.has(m) || RMW2[m] || m === "las") {
    if (mode === "acc") {
      return rmwOn(m, "(global.get $a)") + "(global.set $a (global.get $t))" +
        nz("(global.get $a)") + nxt;
    }
    const [pre, kind, load] = operand(mode, m, b1, b2, rom);
    const body = [pre];
    // RMW_AB/RMW_ABI/RMW_IX/RMW_IY: read, write the OLD value back, then the
    // new one (RMW_ZP/ZPX: no double write). Only visible on I/O and mapper
    // registers, so statically it is emitted only where it can matter.
    let dbl = false;
    if (kind[0] === "abs" && kind[1] >= 0x2000 && kind[1] < 0x4020) dbl = true;
    if ((mode === "abx" || mode === "aby") && !dyn && (ioPage(b2) || ioPage((b2 + 1) & 0xFF))) dbl = true;
    // mapper registers live at $8000+: `inc $8000` writes the old value
    // first (an MMC1 reset idiom relies on it)
    if (rom.romWritesMatter && kind[0] === "abs" && kind[1] >= 0x8000) dbl = true;
    if (rom.romWritesMatter && (mode === "abx" || mode === "aby") && !dyn && b2 >= 0x7F) dbl = true;
    // an address only known at run time: always (harmless on RAM)
    if (kind[0] === "dyn" && (dyn || mode === "izx" || mode === "izy")) dbl = true;
    if (dbl) {
      body.push(`(global.set $t3 ${load})`);
      body.push(storeTo(kind, "(global.get $t3)"));
    }
    const src = dbl ? "(global.get $t3)" : load;
    if (m === "las") {
      // LAR: RMW_ABY(_S &= x; _A = _X = _S; X_ZN(_X)): x itself is unchanged
      body.push(`(global.set $t ${src})`,
        "(global.set $s (i32.and (global.get $s) (global.get $t)))",
        "(global.set $a (global.get $s))", "(global.set $x (global.get $s))", nz("(global.get $x)"));
      body.push(storeTo(kind, "(global.get $t)"));
    } else if (RMW2[m]) {
      body.push(rmwOn(RMW2[m][0], src));
      body.push(storeTo(kind, "(global.get $t)"));
      body.push(...aluOn(RMW2[m][1], "(global.get $t)"));
    } else {
      body.push(rmwOn(m, src));
      body.push(storeTo(kind, "(global.get $t)"));
      body.push(nz("(global.get $t)"));
    }
    body.push(nxt);
    return body.join("");
  }

  // ---- stores ---------------------------------------------------------------
  if (STORES.has(m)) {
    const [pre, kind] = operand(mode, m, b1, b2, rom);
    if (m === "sax") return pre + storeTo(kind, "(i32.and (global.get $a) (global.get $x))") + nxt;
    if (m === "sha") return pre + storeTo(kind, hiPlusOne("(i32.and (global.get $a) (global.get $x))", "$y")) + nxt;
    if (m === "shx") return pre + storeTo(kind, hiPlusOne("(global.get $x)", "$y")) + nxt;
    if (m === "shy") return pre + storeTo(kind, hiPlusOne("(global.get $y)", "$x")) + nxt;
    if (m === "tas") {
      return "(global.set $s (i32.and (global.get $a) (global.get $x)))" + pre +
        storeTo(kind, hiPlusOne("(global.get $s)", "$y")) + nxt;
    }
    return pre + storeTo(kind, `(global.get $${m[2]})`) + nxt;
  }

  // ---- reads ----------------------------------------------------------------
  const [pre, , load] = operand(mode, m, b1, b2, rom);
  return [pre, ...aluOn(m, load), nxt].join("");
  }
}
