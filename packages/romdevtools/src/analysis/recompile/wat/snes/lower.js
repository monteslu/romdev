// 65816 -> WAT lowering for the SNES recompiler: one instruction at one ROM
// file offset becomes one WAT arm body.
//
// Ported from sms-wat's m65816.py (lower()) line for line; the differential
// gate compares this module's output against the Python emitter's.
//
// WHY THE OPCODE BYTE AND NOT OPERAND TEXT. An IR operand string is
// ambiguous between addressing modes (`$12` is direct page at one opcode and
// stack-relative at another), and a relative target printed with
// `addr == file offset` loses its bank past 64KB. So the lowerer takes the
// raw bytes plus a LENGTH, re-derives (mnemonic, mode) from the opcode byte
// through romdev's own 65816 decoder table, and computes relative targets in
// file-offset space where they are exact.
//
// REGISTER WIDTH. A, X, Y and S are 16-bit globals; M and X are runtime
// flags, and every memory access branches on them. Immediates are the
// exception: their width is part of the instruction LENGTH, so the caller
// (index.js) emits BOTH readings of every M/X-dependent immediate and selects
// on the live flag.
//
// Plain JS ESM + JSDoc.

import { opcodeInfo } from "../../decode-65816.js";

/** Raised for an opcode the lowerer refuses to guess at (the arm falls back to the RAM interpreter). */
export class Unsupported extends Error {}

/** Operand bytes per RESOLVED mode (immM/immX are resolved by the caller). */
export const MODE_BYTES = {
  imp: 0, acc: 0, imm8: 1, imm16: 2,
  dp: 1, dpx: 1, dpy: 1,
  idp: 1, idpx: 1, idpy: 1, ildp: 1, ildpy: 1,
  abs: 2, absx: 2, absy: 2, absl: 3, abslx: 3,
  ind: 2, indx: 2, indl: 2,
  sr: 1, sry: 1, rel: 1, rell: 2, bm: 2,
};

/**
 * Instruction length for a mode under the given M/X (1 = 8-bit).
 * @param {string} mode
 * @param {number} m
 * @param {number} x
 */
export function oplen(mode, m, x) {
  if (mode === "immM") mode = m ? "imm8" : "imm16";
  else if (mode === "immX") mode = x ? "imm8" : "imm16";
  return 1 + MODE_BYTES[mode];
}

// Cycle cost, snes9x's way (cpuops.cpp / cpuaddr.h / getset.h): every
// program byte fetched costs the code region's memory speed ($ms, set per
// instruction by $step), every data byte read or written costs its own
// region's speed ($rd8/$wr8 charge it), and each internal operation costs
// ONE_CYCLE (6 master clocks). lower() returns the STATIC internal-operation
// count; the conditional ones (D low byte non-zero, an indexed read that
// crosses a page or uses a 16-bit index, a taken branch) are charged by the
// code the addressing helpers and the arm tail emit.
const IO_MODE = { dpx: 1, dpy: 1, idpx: 1, sr: 1, sry: 1, indx: 1 };
const IO_MNEM = {
  asl: 1, lsr: 1, rol: 1, ror: 1, inc: 1, dec: 1, tsb: 1, trb: 1,   // RMW (and the accumulator forms)
  inx: 1, iny: 1, dex: 1, dey: 1,
  tax: 1, tay: 1, txa: 1, tya: 1, txy: 1, tyx: 1, tsx: 1, txs: 1, tcd: 1, tdc: 1, tcs: 1, tsc: 1,
  clc: 1, sec: 1, cli: 1, sei: 1, clv: 1, cld: 1, sed: 1, nop: 1, wdm: 1, xce: 1, rep: 1, sep: 1,
  xba: 2, wai: 1,
  pha: 1, phx: 1, phy: 1, php: 1, phb: 1, phk: 1, phd: 1,
  pla: 2, plx: 2, ply: 2, plp: 2, plb: 2, pld: 2,
  jsr: 1, jsl: 1, rts: 3, rtl: 2, rti: 2, brl: 1,
  mvn: 2, mvp: 2,
};
/** @param {string} mode @param {string} mnem */
function cycles(mode, mnem) {
  let io = (IO_MODE[mode] ?? 0) + (IO_MNEM[mnem] ?? 0);
  // A read-modify-write on memory spends its internal cycle between the
  // read and the write (snes9x ASL8 ... TRB16): the body charges it there.
  if (RMW.has(mnem) && mode !== "acc") io -= 1;
  // JMP/JSR (a,X): the one internal cycle is AbsoluteIndexedIndirect's.
  if ((mnem === "jmp" || mnem === "jsr") && mode === "indx") io = 1;
  if (mnem === "wdm") io = 0;   // Op42: S9xGetWord at PC instead (see below)
  // Internal cycles snes9x spends AFTER the data accesses are charged there
  // by the body (TRAILING_IO), not up front.
  return io - (TRAILING_IO[mnem] ?? 0);
}
/** Internal cycles after the accesses: RTS's last (Op60), MVN/MVP's two (Op54/Op44). */
const TRAILING_IO = { rts: 1, mvn: 2, mvp: 2 };
/** snes9x charges these leading internal cycles as ONE AddCycles(TWO_CYCLES): an event is seen after both. */
const IO_CHUNK = new Set(["pla", "plx", "ply", "plp", "plb", "pld", "rts", "rtl", "rti", "xba"]);
const RMW = new Set(["asl", "lsr", "rol", "ror", "inc", "dec", "tsb", "trb"]);
/** Charge one internal operation (6 master clocks). */
export const IO1 = "(global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))";
const DL_IO = `(if (i32.and (global.get $d) (i32.const 0xFF)) (then ${IO1}))`;
const DP_MODES = new Set(["dp", "dpx", "dpy", "idp", "idpx", "idpy", "ildp", "ildpy"]);

/**
 * -> {mnem, mode, op} for the opcode at `off`, mode UNRESOLVED.
 * @param {Uint8Array} rom
 * @param {number} off
 */
export function decode(rom, off) {
  const op = rom[off];
  const e = opcodeInfo(op);
  if (!e) throw new Unsupported(`opcode $${op.toString(16).toUpperCase().padStart(2, "0")}`);
  return { mnem: e.mnem, mode: e.mode, op };
}

/** @param {string[]} parts */
const seq = (parts) => parts.filter((p) => p).join(" ");

// The program bank and addresses relative to the executing instruction come
// from the LIVE pc, never from the ROM offset: the same ROM byte runs at
// $00:8000 and at its $80:8000 FastROM mirror (and, on HiROM, at $C0:8000),
// and snes9x pushes, branches and returns inside whichever bank is running.
const PB = "(i32.and (global.get $pc) (i32.const 0xFF0000))";
/** pc + n inside the program bank (the 65816's PC does not carry into PB). */
export const pcRel = (n) => `(i32.or ${PB} (i32.and (i32.add (global.get $pc) (i32.const ${n})) (i32.const 0xFFFF)))`;
const pc16Rel = (n) => `(i32.and (i32.add (global.get $pc) (i32.const ${n})) (i32.const 0xFFFF))`;

// Direct page: D + offset, wrapping inside bank 0.
const dp = (off) => `(i32.and (i32.add (global.get $d) (i32.const ${off})) (i32.const 0xFFFF))`;
const dpIdx = (off, reg) =>
  `(i32.and (i32.add (i32.add (global.get $d) (i32.const ${off})) (global.get $${reg})) (i32.const 0xFFFF))`;
// A 16-bit address in the DATA BANK; indexing may carry out of the bank.
const db = (expr16) => `(i32.add (global.get $db24) ${expr16})`;

// The last operand byte the CPU fetched is on the data bus when the data
// access happens (snes9x cpuaddr.h sets OpenBus = the address's high byte,
// the bank byte for long modes, the operand for direct page). A read of an
// unmapped address returns it. Indirect modes read their pointer through
// $rd16/$rd24, which leave the pointer's last byte there by themselves.
const OB_BYTE = { dp: 1, dpx: 1, dpy: 1, sr: 1, abs: 2, absx: 2, absy: 2, absl: 3, abslx: 3 };
/**
 * The effective address, with the addressing mode's conditional internal
 * cycles. `kind` is 'r' (read), 'w' (write) or 'm' (read-modify-write):
 * snes9x's indexed modes charge their extra cycle unconditionally for a
 * write or a 16-bit index, and for an 8-bit-index read only on a page cross.
 */
function addr24(mode, b, kind = "r") {
  let e = addr24raw(mode, b);
  const pre = [];
  const k = OB_BYTE[mode];
  if (k) pre.push(`(global.set $ob (i32.const ${b[k]}))`);
  if (DP_MODES.has(mode)) pre.push(DL_IO);
  if (mode === "absx" || mode === "absy") {
    const r = mode === "absx" ? "x" : "y";
    if (kind === "r") pre.push(`(if (i32.or (i32.eqz (global.get $fx)) (i32.gt_u (i32.add (i32.const ${b[1]}) (i32.and (global.get $${r}) (i32.const 0xFF))) (i32.const 0xFF))) (then ${IO1}))`);
    else pre.push(IO1);
  }
  if (mode === "idpy") {
    // (d),Y: the page-cross test needs the pointer, so read it first.
    e = `(i32.add ${db("(global.get $t5)")} (global.get $y))`;
    pre.push(`(global.set $t5 (call $rd16 ${dp(b[1])}))`);
    if (kind === "r") pre.push(`(if (i32.or (i32.eqz (global.get $fx)) (i32.gt_u (i32.add (i32.and (global.get $t5) (i32.const 0xFF)) (i32.and (global.get $y) (i32.const 0xFF))) (i32.const 0xFF))) (then ${IO1}))`);
    else pre.push(IO1);
  }
  return pre.length ? `(block (result i32) ${pre.join(" ")} ${e})` : e;
}
function addr24raw(mode, b) {
  const u8 = b[1], u16 = b[1] | (b[2] << 8), u24 = b[1] | (b[2] << 8) | (b[3] << 16);
  switch (mode) {
    case "dp": return dp(u8);
    case "dpx": return dpIdx(u8, "x");
    case "dpy": return dpIdx(u8, "y");
    case "abs": return db(`(i32.const ${u16})`);
    case "absx": return db(`(i32.add (i32.const ${u16}) (global.get $x))`);
    case "absy": return db(`(i32.add (i32.const ${u16}) (global.get $y))`);
    case "absl": return `(i32.const ${u24})`;
    case "abslx": return `(i32.and (i32.add (i32.const ${u24}) (global.get $x)) (i32.const 0xFFFFFF))`;
    case "idp": return db(`(call $rd16 ${dp(u8)})`);
    case "idpx": return db(`(call $rd16 ${dpIdx(u8, "x")})`);
    case "idpy": return `(i32.add ${db(`(call $rd16 ${dp(u8)})`)} (global.get $y))`;
    // [dp]: a 24-bit pointer; the bank comes from the pointer, not DB.
    case "ildp": return `(call $rd24 ${dp(u8)})`;
    case "ildpy": return `(i32.and (i32.add (call $rd24 ${dp(u8)}) (global.get $y)) (i32.const 0xFFFFFF))`;
    // dp,s: stack relative, always bank 0.
    case "sr": return `(i32.and (i32.add (global.get $s) (i32.const ${u8})) (i32.const 0xFFFF))`;
    case "sry":
      return `(i32.add ${db(`(call $rd16 (i32.and (i32.add (global.get $s) (i32.const ${u8})) (i32.const 0xFFFF)))`)} (global.get $y))`;
    default: throw new Unsupported(`addr mode ${mode}`);
  }
}

// N/Z from a result whose width follows a runtime flag (sign bit 7 or 15).
const setnz = (expr, flag = "fm") =>
  `(global.set $t4 ${expr})` +
  `(global.set $t4 (i32.and (global.get $t4) (call $wmask (global.get $${flag}))))` +
  `(global.set $fz (i32.eqz (global.get $t4)))` +
  `(global.set $fn (i32.and (i32.shr_u (global.get $t4) (call $wsign (global.get $${flag}))) (i32.const 1)))`;

// N/Z where the width is statically known.
function setnzConst(expr, bits) {
  const mask = (1 << bits) - 1;
  return `(global.set $t4 (i32.and ${expr} (i32.const ${mask})))` +
    `(global.set $fz (i32.eqz (global.get $t4)))` +
    `(global.set $fn (i32.and (i32.shr_u (global.get $t4) (i32.const ${bits - 1})) (i32.const 1)))`;
}

const CC = {
  bpl: "(i32.eqz (global.get $fn))",
  bmi: "(global.get $fn)",
  bvc: "(i32.eqz (global.get $fv))",
  bvs: "(global.get $fv)",
  bcc: "(i32.eqz (global.get $fc))",
  bcs: "(global.get $fc)",
  bne: "(i32.eqz (global.get $fz))",
  beq: "(global.get $fz)",
  bra: null,
};

// The stack is 16-bit in bank 0. Push writes at S then decrements.
const PUSH8 = (v) =>
  `(call $wr8 (i32.and (global.get $s) (i32.const 0xFFFF)) ${v})` +
  "(global.set $s (i32.and (i32.sub (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))";
const PULL8 =
  "(global.set $s (i32.and (i32.add (global.get $s) (i32.const 1)) (i32.const 0xFFFF)))" +
  "(global.set $t (call $rd8 (i32.and (global.get $s) (i32.const 0xFFFF))))";
// 16-bit pushes and pulls are one word access (snes9x PushW / PullW:
// S9xSetWord / S9xGetWord at S-1 / S+1, high byte first on the write).
const push16 = (v) => `(call $push16 ${v})`;
const PULL16 = "(global.set $t (call $pull16))";

// P as a byte: NVMXDIZC.
const PACK_P = "(i32.or " +
  "(i32.shl (global.get $fn) (i32.const 7)) (i32.or " +
  "(i32.shl (global.get $fv) (i32.const 6)) (i32.or " +
  "(i32.shl (global.get $fm) (i32.const 5)) (i32.or " +
  "(i32.shl (global.get $fx) (i32.const 4)) (i32.or " +
  "(i32.shl (global.get $fd) (i32.const 3)) (i32.or " +
  "(i32.shl (global.get $fi) (i32.const 2)) (i32.or " +
  "(i32.shl (global.get $fz) (i32.const 1)) " +
  "(global.get $fc))))))))";

// Narrowing X to 8 bits clears the high bytes of X and Y ($narrowx).
const unpackP = (src) =>
  `(global.set $t3 ${src})` +
  "(global.set $fn (i32.and (i32.shr_u (global.get $t3) (i32.const 7)) (i32.const 1)))" +
  "(global.set $fv (i32.and (i32.shr_u (global.get $t3) (i32.const 6)) (i32.const 1)))" +
  "(global.set $fm (i32.and (i32.shr_u (global.get $t3) (i32.const 5)) (i32.const 1)))" +
  "(global.set $fx (i32.and (i32.shr_u (global.get $t3) (i32.const 4)) (i32.const 1)))" +
  "(global.set $fd (i32.and (i32.shr_u (global.get $t3) (i32.const 3)) (i32.const 1)))" +
  "(global.set $fi (i32.and (i32.shr_u (global.get $t3) (i32.const 2)) (i32.const 1)))" +
  "(global.set $fz (i32.and (i32.shr_u (global.get $t3) (i32.const 1)) (i32.const 1)))" +
  "(global.set $fc (i32.and (global.get $t3) (i32.const 1)))" +
  // Emulation mode keeps M and X set (snes9x S9xUnpackStatus callers).
  "(if (global.get $fe) (then (global.set $fm (i32.const 1)) (global.set $fx (i32.const 1))))" +
  "(call $narrowx)";

// A narrow write into A preserves B (the high byte).
const KEEP_B_T = "(global.set $a (if (result i32) (global.get $fm) " +
  "(then (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) " +
  "(global.get $t))) (else (global.get $t))))";
const KEEP_B_T8 = "(global.set $a (if (result i32) (global.get $fm) " +
  "(then (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) " +
  "(i32.and (global.get $t) (i32.const 0xFF)))) " +
  "(else (global.get $t))))";

/**
 * @typedef {{kind:'jp', bank:number, addr:number} | {kind:'jp_expr'} |
 *   {kind:'jp_file'|'br_file', delta:number, next16:number, cond?:string, noTakenIo?:boolean}} Flow
 */

/**
 * Lower the instruction at FILE OFFSET `off` with length `n`.
 * `pb`/`pc16` are the CPU bank and 16-bit address the offset maps to.
 * @param {Uint8Array} rom
 * @param {number} off
 * @param {number} n
 * @param {number} pb
 * @param {number} pc16
 * @returns {[string, Flow|null, number]} body, flow, cycles
 */
export function lower(rom, off, n, pb, pc16) {
  const { mnem, mode: rawMode } = decode(rom, off);
  const mode = rawMode === "immM" || rawMode === "immX" ? (n === 2 ? "imm8" : "imm16") : rawMode;
  const b = [...rom.subarray(off, off + n), 0, 0, 0, 0];
  const nxt16 = (pc16 + n) & 0xffff;
  const u8 = b[1];
  const u16 = b[1] | (b[2] << 8);
  const u24 = b[1] | (b[2] << 8) | (b[3] << 16);
  const cyc = cycles(mode, mnem);
  const imm = mode === "imm8" || mode === "imm16";

  // ---- loads
  if (mnem === "lda" || mnem === "ldx" || mnem === "ldy") {
    const reg = { lda: "a", ldx: "x", ldy: "y" }[mnem];
    const fl = mnem === "lda" ? "fm" : "fx";
    if (imm) {
      const bits = mode === "imm8" ? 8 : 16;
      const v = bits === 8 ? u8 : u16;
      // An 8-bit load keeps A's high byte (B) but zeroes X/Y's.
      let setr;
      if (mnem === "lda") {
        setr = bits === 8
          ? `(global.set $a (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) (i32.const ${v})))`
          : `(global.set $a (i32.const ${v}))`;
      } else {
        setr = `(global.set $${reg} (i32.const ${v}))`;
      }
      return [seq([setr, setnzConst(`(i32.const ${v})`, bits)]), null, cyc];
    }
    const a = addr24(mode, b);
    return [seq([
      `(global.set $t3 ${a})`,
      `(global.set $t (call $rdw (global.get $t3) (global.get $${fl})))`,
      mnem === "lda" ? KEEP_B_T : `(global.set $${reg} (global.get $t))`,
      setnz("(global.get $t)", fl)]), null, cyc];
  }

  // ---- stores
  if (mnem === "sta" || mnem === "stx" || mnem === "sty" || mnem === "stz") {
    if (imm) throw new Unsupported(`${mnem} immediate`);
    const a = addr24(mode, b, "w");
    let src, fl;
    if (mnem === "stz") { src = "(i32.const 0)"; fl = "fm"; }
    else {
      const reg = { sta: "a", stx: "x", sty: "y" }[mnem];
      src = `(global.get $${reg})`;
      fl = mnem === "sta" ? "fm" : "fx";
    }
    return [`(call $wrw ${a} ${src} (global.get $${fl}))`, null, cyc];
  }

  // ---- register transfers
  if (["tax", "tay", "txa", "tya", "txy", "tyx", "tsx", "tcd", "tdc", "tcs", "tsc", "txs"].includes(mnem)) {
    // txs/tcs set no flags; tcd/tdc/tsc are always 16-bit.
    if (mnem === "txs") return ["(global.set $s (global.get $x))", null, cyc];
    if (mnem === "tcs") return ["(global.set $s (global.get $a))", null, cyc];
    if (mnem === "tcd") return [seq(["(global.set $d (global.get $a))", setnzConst("(global.get $d)", 16)]), null, cyc];
    if (mnem === "tdc") return [seq(["(global.set $a (global.get $d))", setnzConst("(global.get $a)", 16)]), null, cyc];
    if (mnem === "tsc") return [seq(["(global.set $a (global.get $s))", setnzConst("(global.get $a)", 16)]), null, cyc];
    const [src, dst, fl] = {
      tax: ["a", "x", "fx"], tay: ["a", "y", "fx"],
      txa: ["x", "a", "fm"], tya: ["y", "a", "fm"],
      txy: ["x", "y", "fx"], tyx: ["y", "x", "fx"],
      tsx: ["s", "x", "fx"],
    }[mnem];
    let mv;
    if (dst === "a") {
      mv = "(global.set $a (if (result i32) (global.get $fm) " +
        "(then (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) " +
        `(i32.and (global.get $${src}) (i32.const 0xFF)))) ` +
        `(else (global.get $${src}))))`;
    } else {
      mv = `(global.set $${dst} (i32.and (global.get $${src}) ` +
        `(call $wmask (global.get $${fl}))))`;
    }
    return [seq([mv, setnz(`(global.get $${dst})`, fl)]), null, cyc];
  }

  if (mnem === "xba") {
    return [seq([
      "(global.set $a (i32.or " +
      "(i32.shr_u (global.get $a) (i32.const 8)) " +
      "(i32.and (i32.shl (global.get $a) (i32.const 8)) " +
      "(i32.const 0xFF00))))",
      // xba sets N/Z from the NEW low byte regardless of M.
      setnzConst("(global.get $a)", 8)]), null, cyc];
  }

  // ---- ALU
  if (mnem === "and" || mnem === "ora" || mnem === "eor") {
    const op = { and: "i32.and", ora: "i32.or", eor: "i32.xor" }[mnem];
    let src;
    if (imm) src = `(i32.const ${mode === "imm8" ? u8 : u16})`;
    else src = `(call $rdw ${addr24(mode, b)} (global.get $fm))`;
    return [seq([
      `(global.set $t2 ${src})`,
      `(global.set $t (${op} (i32.and (global.get $a) ` +
      "(call $wmask (global.get $fm))) (global.get $t2)))",
      KEEP_B_T8,
      setnz("(global.get $t)", "fm")]), null, cyc];
  }

  if (mnem === "adc" || mnem === "sbc") {
    let src;
    if (imm) src = `(i32.const ${mode === "imm8" ? u8 : u16})`;
    else src = `(call $rdw ${addr24(mode, b)} (global.get $fm))`;
    // D set: snes9x's nibble-by-nibble decimal ADC/SBC ($adc_dec).
    const neg = mnem === "sbc"
      ? "(global.set $t2 (i32.xor (global.get $t2) (call $wmask (global.get $fm))))"
      : "";
    return [seq([
      `(global.set $t2 ${src})`,
      `(if (global.get $fd) (then (call $adc_dec (global.get $t2) (i32.const ${mnem === "sbc" ? 1 : 0}))) (else`, neg,
      "(global.set $t3 (i32.and (global.get $a) " +
      "(call $wmask (global.get $fm))))",
      "(global.set $t (i32.add (i32.add (global.get $t3) " +
      "(global.get $t2)) (global.get $fc)))",
      "(global.set $fv (i32.and (i32.shr_u (i32.and " +
      "(i32.xor (global.get $t3) (i32.xor (global.get $t2) (i32.const -1))) " +
      "(i32.xor (global.get $t3) (global.get $t))) " +
      "(call $wsign (global.get $fm))) (i32.const 1)))",
      "(global.set $fc (i32.gt_u (global.get $t) " +
      "(call $wmask (global.get $fm))))",
      "(global.set $a (if (result i32) (global.get $fm) " +
      "(then (i32.or (i32.and (global.get $a) (i32.const 0xFF00)) " +
      "(i32.and (global.get $t) (i32.const 0xFF)))) " +
      "(else (i32.and (global.get $t) (i32.const 0xFFFF)))))",
      setnz("(global.get $t)", "fm"), "))"]), null, cyc];
  }

  if (mnem === "cmp" || mnem === "cpx" || mnem === "cpy") {
    const reg = { cmp: "a", cpx: "x", cpy: "y" }[mnem];
    const fl = mnem === "cmp" ? "fm" : "fx";
    let src;
    if (imm) src = `(i32.const ${mode === "imm8" ? u8 : u16})`;
    else src = `(call $rdw ${addr24(mode, b)} (global.get $${fl}))`;
    return [seq([
      `(global.set $t2 ${src})`,
      `(global.set $t3 (i32.and (global.get $${reg}) ` +
      `(call $wmask (global.get $${fl}))))`,
      "(global.set $t (i32.sub (global.get $t3) (global.get $t2)))",
      "(global.set $fc (i32.ge_u (global.get $t3) (global.get $t2)))",
      setnz("(global.get $t)", fl)]), null, cyc];
  }

  if (mnem === "bit") {
    if (imm) {
      // BIT #imm sets Z only.
      const v = mode === "imm8" ? u8 : u16;
      return [seq([
        "(global.set $t (i32.and (i32.and (global.get $a) " +
        `(call $wmask (global.get $fm))) (i32.const ${v})))`,
        "(global.set $fz (i32.eqz (global.get $t)))"]), null, cyc];
    }
    return [seq([
      `(global.set $t2 (call $rdw ${addr24(mode, b)} ` +
      "(global.get $fm)))",
      "(global.set $fz (i32.eqz (i32.and (i32.and (global.get $a) " +
      "(call $wmask (global.get $fm))) (global.get $t2))))",
      "(global.set $fn (i32.and (i32.shr_u (global.get $t2) " +
      "(call $wsign (global.get $fm))) (i32.const 1)))",
      "(global.set $fv (i32.and (i32.shr_u (global.get $t2) " +
      "(i32.sub (call $wsign (global.get $fm)) (i32.const 1))) " +
      "(i32.const 1)))"]), null, cyc];
  }

  if (mnem === "tsb" || mnem === "trb") {
    const op = mnem === "tsb" ? "i32.or" : "i32.and";
    const rhs = mnem === "tsb" ? "(global.get $t3)" : "(i32.xor (global.get $t3) (i32.const -1))";
    return [seq([
      `(global.set $t2 ${addr24(mode, b, "m")})`,
      "(global.set $t (call $rdw (global.get $t2) (global.get $fm)))",
      "(global.set $t3 (i32.and (global.get $a) " +
      "(call $wmask (global.get $fm))))",
      "(global.set $fz (i32.eqz (i32.and (global.get $t) " +
      "(global.get $t3))))",
      IO1,
      `(call $wrw10 (global.get $t2) (${op} (global.get $t) ${rhs}) ` +
      "(global.get $fm))"]), null, cyc];
  }

  // ---- inc/dec
  if ((mnem === "inc" || mnem === "dec") && mode === "acc") {
    const d = mnem === "inc" ? 1 : -1;
    return [seq([
      "(global.set $t (i32.and (i32.add (i32.and (global.get $a) " +
      `(call $wmask (global.get $fm))) (i32.const ${d})) ` +
      "(call $wmask (global.get $fm))))",
      KEEP_B_T,
      setnz("(global.get $t)", "fm")]), null, cyc];
  }
  if (mnem === "inc" || mnem === "dec") {
    const d = mnem === "inc" ? 1 : -1;
    return [seq([
      `(global.set $t3 ${addr24(mode, b, "m")})`,
      "(global.set $t (i32.and (i32.add (call $rdw (global.get $t3) " +
      `(global.get $fm)) (i32.const ${d})) ` +
      "(call $wmask (global.get $fm))))",
      IO1,
      "(call $wrw10 (global.get $t3) (global.get $t) (global.get $fm))",
      setnz("(global.get $t)", "fm")]), null, cyc];
  }
  if (mnem === "inx" || mnem === "iny" || mnem === "dex" || mnem === "dey") {
    const reg = mnem === "inx" || mnem === "dex" ? "x" : "y";
    const d = mnem === "inx" || mnem === "iny" ? 1 : -1;
    return [seq([
      `(global.set $${reg} (i32.and (i32.add (global.get $${reg}) ` +
      `(i32.const ${d})) (call $wmask (global.get $fx))))`,
      setnz(`(global.get $${reg})`, "fx")]), null, cyc];
  }

  // ---- shifts and rotates
  if (mnem === "asl" || mnem === "lsr" || mnem === "rol" || mnem === "ror") {
    const acc = mode === "acc";
    const pre = acc ? "" : `(global.set $t3 ${addr24(mode, b, "m")})`;
    const src = acc
      ? "(i32.and (global.get $a) (call $wmask (global.get $fm)))"
      : "(call $rdw (global.get $t3) (global.get $fm))";
    let cbit, res;
    if (mnem === "asl") {
      cbit = "(i32.and (i32.shr_u (global.get $t2) (call $wsign (global.get $fm))) (i32.const 1))";
      res = "(i32.shl (global.get $t2) (i32.const 1))";
    } else if (mnem === "lsr") {
      cbit = "(i32.and (global.get $t2) (i32.const 1))";
      res = "(i32.shr_u (global.get $t2) (i32.const 1))";
    } else if (mnem === "rol") {
      cbit = "(i32.and (i32.shr_u (global.get $t2) (call $wsign (global.get $fm))) (i32.const 1))";
      res = "(i32.or (i32.shl (global.get $t2) (i32.const 1)) (global.get $fc))";
    } else {
      cbit = "(i32.and (global.get $t2) (i32.const 1))";
      res = "(i32.or (i32.shr_u (global.get $t2) (i32.const 1)) " +
        "(i32.shl (global.get $fc) (call $wsign (global.get $fm))))";
    }
    const body = [pre,
      `(global.set $t2 ${src})`,
      `(global.set $t4 ${cbit})`,
      `(global.set $t (i32.and ${res} (call $wmask (global.get $fm))))`,
      "(global.set $fc (global.get $t4))",
      acc ? KEEP_B_T : IO1 + "(call $wrw10 (global.get $t3) (global.get $t) (global.get $fm))",
      setnz("(global.get $t)", "fm")];
    return [seq(body), null, cyc];
  }

  // ---- flags
  // CLI / SEI take effect one instruction late ($apply_ichg in $run_frame).
  if (mnem === "cli") return ["(global.set $ichg (i32.or (global.get $ichg) (i32.const 1)))", null, cyc];
  if (mnem === "sei") return ["(global.set $ichg (i32.or (global.get $ichg) (i32.const 2)))", null, cyc];
  const FLAG = { clc: ["fc", 0], sec: ["fc", 1],
    clv: ["fv", 0], cld: ["fd", 0], sed: ["fd", 1] };
  if (FLAG[mnem]) {
    const [f, v] = FLAG[mnem];
    return [`(global.set $${f} (i32.const ${v}))`, null, cyc];
  }
  if (mnem === "rep" || mnem === "sep") {
    const v = u8, bits = [];
    const setv = mnem === "rep" ? 0 : 1;
    for (const [bit, g] of [[0x80, "fn"], [0x40, "fv"], [0x20, "fm"], [0x10, "fx"],
      [0x08, "fd"], [0x04, "fi"], [0x02, "fz"], [0x01, "fc"]]) {
      if (v & bit) bits.push(`(global.set $${g} (i32.const ${setv}))`);
    }
    // Narrowing X zeroes the high bytes of X and Y.
    if ((v & 0x10) && setv === 1) bits.push("(call $narrowx)");
    // REP cannot clear M or X in emulation mode.
    if ((v & 0x30) && setv === 0) bits.push("(if (global.get $fe) (then (global.set $fm (i32.const 1)) (global.set $fx (i32.const 1))))");
    return [seq(bits), null, cyc];
  }
  if (mnem === "xce") {
    return [seq([
      "(global.set $t (global.get $fc))",
      "(global.set $fc (global.get $fe))",
      "(global.set $fe (global.get $t))",
      // Entering emulation mode forces M and X set and S into page 1.
      "(if (global.get $fe) (then " +
      "(global.set $fm (i32.const 1)) (global.set $fx (i32.const 1)) " +
      "(call $narrowx) " +
      "(global.set $s (i32.or (i32.const 0x100) " +
      "(i32.and (global.get $s) (i32.const 0xFF))))))"]), null, cyc];
  }
  if (mnem === "nop") return ["", null, cyc];
  // WDM (snes9x Op42) reads a WORD at the operand (two program-speed reads)
  // and skips one byte.
  if (mnem === "wdm") return ["(global.set $cyc (i32.sub (global.get $cyc) (global.get $ms)))", null, cyc];
  // WAI: pc moves past it and $step burns cycles until $nmi/$irq clear $wai.
  if (mnem === "wai") return ["(global.set $wai (i32.const 1))", null, cyc];

  // ---- stack
  if (mnem === "pha" || mnem === "phx" || mnem === "phy") {
    const reg = mnem[2];
    const fl = mnem === "pha" ? "fm" : "fx";
    return [`(if (global.get $${fl}) ` +
      "(then " + PUSH8(`(i32.and (global.get $${reg}) (i32.const 0xFF))`) + ") " +
      "(else " + push16(`(global.get $${reg})`) + "))", null, cyc];
  }
  if (mnem === "php") return [PUSH8(PACK_P), null, cyc];
  if (mnem === "phb") return [PUSH8("(global.get $db)"), null, cyc];
  if (mnem === "phk") return [PUSH8("(i32.shr_u (global.get $pc) (i32.const 16))"), null, cyc];
  if (mnem === "phd") return [push16("(global.get $d)"), null, cyc];
  if (mnem === "pea") return [push16(`(i32.const ${u16})`), null, cyc];
  if (mnem === "pei") return [DL_IO + push16(`(call $rd16 ${dp(u8)})`), null, cyc];
  if (mnem === "per") {
    // Relative to the NEXT instruction, inside the program bank.
    const d = u16 > 0x7fff ? u16 - 0x10000 : u16;
    return [push16(pc16Rel(n + d)), null, cyc];
  }
  if (mnem === "pla") {
    return [seq([
      "(if (global.get $fm) (then " + PULL8 +
      "(global.set $a (i32.or (i32.and (global.get $a) " +
      "(i32.const 0xFF00)) (global.get $t)))) " +
      "(else " + PULL16 + "(global.set $a (global.get $t))))",
      setnz("(global.get $t)", "fm")]), null, cyc];
  }
  if (mnem === "plx" || mnem === "ply") {
    const reg = mnem === "plx" ? "x" : "y";
    return [seq([
      "(if (global.get $fx) (then " + PULL8 + ") " +
      "(else " + PULL16 + "))",
      `(global.set $${reg} (global.get $t))`,
      setnz("(global.get $t)", "fx")]), null, cyc];
  }
  if (mnem === "plp") return [seq([PULL8, unpackP("(global.get $t)")]), null, cyc];
  if (mnem === "plb") {
    return [seq([PULL8, "(call $setdb (global.get $t))", setnzConst("(global.get $t)", 8)]), null, cyc];
  }
  if (mnem === "pld") {
    return [seq([PULL16, "(global.set $d (global.get $t))", setnzConst("(global.get $d)", 16)]), null, cyc];
  }

  // ---- block move: ONE byte per execution, re-executing until A wraps to
  // $FFFF (7 cycles per byte, as the hardware charges).
  if (mnem === "mvn" || mnem === "mvp") {
    const step = mnem === "mvn" ? 1 : -1;
    const srcBank = b[2], dstBank = b[1];
    return [seq([
      `(call $setdb (i32.const ${dstBank}))`,
      `(call $wr8 (i32.add (i32.const ${dstBank * 0x10000}) ` +
      "(global.get $y)) " +
      `(call $rd8 (i32.add (i32.const ${srcBank * 0x10000}) ` +
      "(global.get $x))))",
      "(global.set $x (i32.and (i32.add (global.get $x) " +
      `(i32.const ${step})) (call $wmask (global.get $fx))))`,
      "(global.set $y (i32.and (i32.add (global.get $y) " +
      `(i32.const ${step})) (call $wmask (global.get $fx))))`,
      "(global.set $a (i32.and (i32.sub (global.get $a) (i32.const 1)) " +
      "(i32.const 0xFFFF)))",
      // Op54/Op44 end with AddCycles(TWO_CYCLES), after the byte moved.
      "(global.set $cyc (i32.sub (global.get $cyc) (i32.const 12)))",
      "(global.set $t (if (result i32) (i32.eq (global.get $a) " +
      `(i32.const 0xFFFF)) (then ${pcRel(n)}) ` +
      "(else (global.get $pc))))"]), { kind: "jp_expr" }, cyc];
  }

  // ---- control flow
  if (mnem in CC) {
    const d = u8 > 0x7f ? u8 - 0x100 : u8;
    if (mnem === "bra") return ["", { kind: "jp_file", delta: n + d, next16: nxt16 }, cyc];
    return ["", { kind: "br_file", delta: n + d, next16: nxt16, cond: CC[mnem] }, cyc];
  }
  if (mnem === "brl") {
    const d = u16 > 0x7fff ? u16 - 0x10000 : u16;
    // Op82: the one internal cycle is its static one, with no taken-branch
    // or page-cross extra.
    return ["", { kind: "jp_file", delta: n + d, next16: nxt16, noTakenIo: true }, cyc];
  }
  if (mnem === "jmp" && mode === "abs") return ["", { kind: "jp_bank", addr: u16 }, cyc];
  if (mnem === "jml" && mode === "absl") return ["", { kind: "jp", bank: u24 >> 16, addr: u24 & 0xffff }, cyc];
  if (mnem === "jmp" && mode === "ind") {
    // (abs) reads the pointer from BANK 0.
    return [`(global.set $t (i32.or ${PB} (call $rd16 (i32.const ${u16}))))`, { kind: "jp_expr" }, cyc];
  }
  const indxTarget = () =>
    `(global.set $t (i32.or ${PB} ` +
    `(call $rd16 (i32.or ${PB} ` +
    `(i32.and (i32.add (i32.const ${u16}) (global.get $x)) ` +
    "(i32.const 0xFFFF))))))";
  // (abs,x) indexes inside the PROGRAM bank.
  if (mnem === "jmp" && mode === "indx") return [indxTarget(), { kind: "jp_expr" }, cyc];
  if (mnem === "jml" && mode === "indl") {
    return [`(global.set $t (call $rd24 (i32.const ${u16})))`, { kind: "jp_expr" }, cyc];
  }
  // JSR/JSL push the address of the instruction's LAST byte.
  if (mnem === "jsr" && mode === "abs") {
    return [push16(pc16Rel(n - 1)), { kind: "jp_bank", addr: u16 }, cyc];
  }
  if (mnem === "jsr" && mode === "indx") {
    return [push16(pc16Rel(n - 1)) + indxTarget(), { kind: "jp_expr" }, cyc];
  }
  if (mnem === "jsl") {
    return [PUSH8("(i32.shr_u (global.get $pc) (i32.const 16))") + push16(pc16Rel(n - 1)),
      { kind: "jp", bank: u24 >> 16, addr: u24 & 0xffff }, cyc];
  }
  if (mnem === "rts") {
    return [seq([
      PULL16,
      IO1,   // Op60: the last internal cycle comes after the pull
      `(global.set $t (i32.or ${PB} ` +
      "(i32.and (i32.add (global.get $t) (i32.const 1)) " +
      "(i32.const 0xFFFF))))"]), { kind: "jp_expr" }, cyc];
  }
  if (mnem === "rtl") {
    return [seq([
      PULL16, "(global.set $t3 (i32.and (i32.add (global.get $t) " +
      "(i32.const 1)) (i32.const 0xFFFF)))",
      PULL8,
      "(global.set $t (i32.or (i32.shl (global.get $t) (i32.const 16)) " +
      "(global.get $t3)))"]), { kind: "jp_expr" }, cyc];
  }
  if (mnem === "rti") {
    // Native RTI pulls P, a 16-bit PC, then the bank; no +1. In emulation
    // mode there is no bank byte and PB stays (snes9x Op40).
    return [seq([
      PULL8, unpackP("(global.get $t)"),
      "(if (global.get $fe) (then (global.set $fm (i32.const 1)) (global.set $fx (i32.const 1)) (call $narrowx)))",
      PULL16, "(global.set $t3 (global.get $t))",
      `(if (global.get $fe) (then (global.set $t (i32.or ${PB} (global.get $t3)))) (else`,
      PULL8,
      "(global.set $t (i32.or (i32.shl (global.get $t) (i32.const 16)) " +
      "(global.get $t3)))))"]), { kind: "jp_expr" }, cyc];
  }
  // BRK / COP (snes9x Op00 / Op02): push PB (native only), the address
  // after the signature byte and P, clear D, set I, and vector through
  // $FFE6 / $FFE4 (native) or $FFFE / $FFF4 (emulation) in bank 0.
  if (mnem === "brk" || mnem === "cop") {
    const [nv, ev] = mnem === "brk" ? [0xffe6, 0xfffe] : [0xffe4, 0xfff4];
    return [seq([
      "(if (i32.eqz (global.get $fe)) (then " + PUSH8("(i32.shr_u (global.get $pc) (i32.const 16))") + "))",
      push16(pc16Rel(2)),
      PUSH8(PACK_P),
      "(global.set $fd (i32.const 0))",
      "(global.set $fi (i32.const 1))",
      `(global.set $t (call $rd16 (if (result i32) (global.get $fe) (then (i32.const ${ev})) (else (i32.const ${nv})))))`,
    ]), { kind: "jp_expr" }, cyc];
  }
  // STP (snes9x OpDB): the pc stays on the STP and the CPU stops.
  if (mnem === "stp") return ["(global.set $t (global.get $pc))", { kind: "jp_expr" }, cyc];
  throw new Unsupported(`${mnem} ${mode}`);
}

/**
 * The 256-byte opcode -> operation-id table the RAM interpreter's $isop reads.
 * @returns {Uint8Array}
 */
export function isopTable() {
  const OPID = {
    lda: 1, ldx: 2, ldy: 3, sta: 4, stx: 5, sty: 6,
    stz: 7, and: 8, ora: 9, eor: 10, adc: 11, sbc: 12,
    cmp: 13, cpx: 14, cpy: 15, bit: 16, inc: 17, dec: 18,
    asl: 19, lsr: 19, rol: 19, ror: 19, tsb: 20, trb: 21,
  };
  const tab = new Uint8Array(256);
  for (let op = 0; op < 256; op++) {
    const e = opcodeInfo(op);
    if (!e || e.mode === "imp") continue;
    if (e.mode === "acc" && (e.mnem === "inc" || e.mnem === "dec")) continue;
    tab[op] = OPID[e.mnem] ?? 0;
  }
  return tab;
}

/**
 * The 256-byte opcode -> addressing-mode-id table for the interpreter's $iaddr.
 * @returns {Uint8Array}
 */
export function modeTable() {
  const MODEID = {
    imm8: 1, imm16: 1, immM: 1, immX: 2,
    dp: 3, dpx: 4, dpy: 5,
    idp: 6, idpx: 7, idpy: 8, ildp: 9, ildpy: 10,
    abs: 11, absx: 12, absy: 13, absl: 14, abslx: 15,
    sr: 16, sry: 17, acc: 18,
  };
  const tab = new Uint8Array(256);
  for (let op = 0; op < 256; op++) {
    const e = opcodeInfo(op);
    if (e) tab[op] = MODEID[e.mode] ?? 0;
  }
  return tab;
}

/**
 * The RAM interpreter's cycle table, two bytes per opcode: [length | flags,
 * static internal cycles], the same model the arms use (cycles()). Flags:
 * 0x80 = one more byte when M is 16-bit, 0x40 = when X is 16-bit, 0x20 = a
 * direct-page mode (one more cycle when D's low byte is non-zero), 0x10 = a
 * relative branch (one more cycle when taken).
 * @returns {Uint8Array}
 */
export function interpCostTable() {
  const tab = new Uint8Array(512);
  const DP = new Set(["dp", "dpx", "dpy", "idp", "idpx", "idpy", "ildp", "ildpy"]);
  for (let op = 0; op < 256; op++) {
    const e = opcodeInfo(op);
    if (!e) continue;
    let lf = oplen(e.mode, 1, 1);
    if (e.mode === "immM") lf |= 0x80;
    if (e.mode === "immX") lf |= 0x40;
    if (DP.has(e.mode) || e.mnem === "pei") lf |= 0x20;
    if (e.mode === "rel") lf |= 0x10;
    // MVN/MVP read their two operands as two Immediate8s (events between).
    if (e.mnem === "mvn" || e.mnem === "mvp") lf |= 0x08;
    tab[op * 2] = lf;
    // (the interpreter charges a read-modify-write's internal cycle up front)
    // bit 7: the leading internal cycles are one AddCycles (IO_CHUNK).
    tab[op * 2 + 1] = cycles(e.mode, e.mnem) + (RMW.has(e.mnem) && e.mode !== "acc" ? 1 : 0) |
      (IO_CHUNK.has(e.mnem) ? 0x80 : 0);
  }
  return tab;
}
