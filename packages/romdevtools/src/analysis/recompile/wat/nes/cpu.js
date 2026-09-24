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
// Ported from sms-wat src/nes_cpu.py (commit 219d233); the emitted text is
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

/** Official opcodes: opcode -> [mnemonic, addressing mode]. @type {Map<number, [string, string]>} */
export const OPS = new Map();
{
  const t = OPS_TEXT.split(/\s+/).filter(Boolean);
  for (let i = 0; i < t.length; i += 3) OPS.set(parseInt(t[i], 16), [t[i + 1], t[i + 2]]);
}

/** Instruction length by addressing mode. */
export const LEN = {
  imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, rel: 2,
  izx: 2, izy: 2, abs: 3, abx: 3, aby: 3, ind: 3,
};

const READS = new Set(["lda", "ldx", "ldy", "ora", "and", "eor", "adc", "sbc", "cmp", "cpx", "cpy", "bit"]);
const RMW = new Set(["asl", "lsr", "rol", "ror", "inc", "dec"]);
const STORES = new Set(["sta", "stx", "sty"]);

/** Thrown for a byte that is not an official opcode; the arm becomes a trap. */
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
 * Lower one instruction. `pcbase` is the canonical CPU address of the arm; it
 * only decides the static page-cross cost of a branch. The emitted code uses
 * the RUNTIME $pc for fall-through, pushes and branches, so an arm executed
 * through another mirror behaves exactly as the reference does there.
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
  // Base cycles are charged in $step (followed by the APU hook, as fceumm's
  // X6502_Run does), not here.
  const nxt = `(global.set $pc (i32.and (i32.add (global.get $pc) (i32.const ${ln})) (i32.const 0xFFFF)))`;
  const n16 = b1 | (b2 << 8);

  if (mode === "rel") {
    const disp = b1 >= 128 ? b1 - 256 : b1;
    const cond = BRANCH_COND[m];
    const tmp = (pcbase + 2) & 0xFFFF;
    const tgt = (tmp + disp) & 0xFFFF;
    const pen = ((tmp ^ tgt) & 0x100) ? 2 : 1;
    return `(if ${cond} (then ${cyc(pen)} (global.set $pc (i32.and (i32.add ` +
      `(global.get $pc) (i32.const ${2 + disp})) (i32.const 0xFFFF)))) ` +
      `(else ${nxt}))`;
  }
  if (m === "jmp") {
    if (mode === "abs") return `(global.set $pc (i32.const ${n16}))`;
    // JMP ($xxFF) reads the high byte from $xx00 (the 6502 page-wrap bug).
    const hi = (n16 & 0xFF00) | ((n16 + 1) & 0xFF);
    return `(global.set $pc (i32.or (call $rd8 (i32.const ${n16})) ` +
      `(i32.shl (call $rd8 (i32.const ${hi})) (i32.const 8))))`;
  }
  if (m === "jsr") {
    return "(global.set $t (i32.and (i32.add (global.get $pc) (i32.const 2)) (i32.const 0xFFFF)))" +
      push("(i32.shr_u (global.get $t) (i32.const 8))") +
      push("(i32.and (global.get $t) (i32.const 0xFF))") +
      `(global.set $pc (i32.const ${n16}))`;
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

  // ---- shifts / rotates / inc / dec ---------------------------------------
  if (RMW.has(m)) {
    if (mode === "acc") {
      return rmwOn(m, "(global.get $a)") + "(global.set $a (global.get $t))" +
        nz("(global.get $a)") + nxt;
    }
    const [pre, kind, load] = operand(mode, m, b1, b2, rom);
    const body = [pre];
    // RMW_AB/RMW_ABI: read, write the OLD value back, then the new one. Only
    // visible on I/O, so the double write is emitted only there.
    let dbl = false;
    if (kind[0] === "abs" && kind[1] >= 0x2000 && kind[1] < 0x4020) dbl = true;
    if (mode === "abx" && (ioPage(b2) || ioPage((b2 + 1) & 0xFF))) dbl = true;
    if (dbl) {
      body.push(`(global.set $t3 ${load})`);
      body.push(storeTo(kind, "(global.get $t3)"));
      body.push(rmwOn(m, "(global.get $t3)"));
    } else {
      body.push(rmwOn(m, load));
    }
    body.push(storeTo(kind, "(global.get $t)"));
    body.push(nz("(global.get $t)"));
    body.push(nxt);
    return body.join("");
  }

  // ---- stores ---------------------------------------------------------------
  if (STORES.has(m)) {
    const [pre, kind] = operand(mode, m, b1, b2, rom);
    return pre + storeTo(kind, `(global.get $${m[2]})`) + nxt;
  }

  // ---- reads ----------------------------------------------------------------
  const [pre, , load] = operand(mode, m, b1, b2, rom);
  const body = [pre];
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
  } else {
    throw new Unsupported(m);
  }
  body.push(nxt);
  return body.join("");
}
