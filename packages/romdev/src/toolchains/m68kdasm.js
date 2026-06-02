// Pure-JS Motorola 68000 disassembler. Produces the same indented,
// label-seeded, `; ADDR BB BB`-commented output shape as z80dasm.js /
// sm83dasm.js so the disasm.js post-processors (vector labels, file-offset
// annotation, untilReturn truncation) work unchanged.
//
// Scope: the M68000 (Genesis/Mega Drive main CPU) user-mode instruction set
// that dominates real game code — moves, ALU ops, branches (Bcc/BSR/BRA),
// JMP/JSR, shifts/rotates, bit ops, LEA/PEA, MOVEM, TST/CMP/CLR, EXT, NOP,
// RTS/RTE/RTR, TRAP, LINK/UNLK, DBcc, Scc. Big-endian word fetch. Unknown
// or unhandled opcodes emit `.dc.w $XXXX` so the stream stays aligned.
//
// NOT exhaustive: a few rare/privileged/68020+ forms fall through to
// `.dc.w`. Good enough to read what a game does; not a cycle-exact model.

const DATA_REG = (n) => `d${n}`;
const ADDR_REG = (n) => `a${n}`;

function hex(n, w) {
  const v = n >>> 0;
  return "$" + v.toString(16).toUpperCase().padStart(w, "0");
}
function signedByte(b) { return b >= 0x80 ? b - 0x100 : b; }
function signedWord(w) { return w >= 0x8000 ? w - 0x10000 : w; }
function signedLong(l) { return l >= 0x80000000 ? l - 0x100000000 : l; }

// Read helpers operate on a Uint8Array, big-endian.
function rdWord(bytes, pos) { return (bytes[pos] << 8) | bytes[pos + 1]; }
function rdLong(bytes, pos) {
  return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
}

const SIZE_SUFFIX = { 0: ".b", 1: ".w", 2: ".l" };
const SIZE_BYTES = { 0: 1, 1: 2, 2: 4 };

/**
 * Decode an effective-address field (mode, reg) into operand text, consuming
 * any extension words from `bytes` at `extPos`. Returns { text, len } where
 * `len` is the number of EXTRA bytes consumed (beyond the opcode word).
 *
 * size is 0/1/2 (b/w/l) — needed for immediate (#imm) and absolute decoding.
 */
function decodeEA(mode, reg, bytes, extPos, size, pc) {
  switch (mode) {
    case 0: return { text: DATA_REG(reg), len: 0 };
    case 1: return { text: ADDR_REG(reg), len: 0 };
    case 2: return { text: `(${ADDR_REG(reg)})`, len: 0 };
    case 3: return { text: `(${ADDR_REG(reg)})+`, len: 0 };
    case 4: return { text: `-(${ADDR_REG(reg)})`, len: 0 };
    case 5: { // (d16,An)
      const d = signedWord(rdWord(bytes, extPos));
      return { text: `(${d < 0 ? "-" : ""}${hex(Math.abs(d), 4)},${ADDR_REG(reg)})`, len: 2 };
    }
    case 6: { // (d8,An,Xn) — brief extension word
      const ext = rdWord(bytes, extPos);
      const isAddr = (ext >> 15) & 1;
      const xn = (ext >> 12) & 7;
      const isLong = (ext >> 11) & 1;
      const disp = signedByte(ext & 0xFF);
      const idx = `${isAddr ? "a" : "d"}${xn}.${isLong ? "l" : "w"}`;
      return { text: `(${disp < 0 ? "-" : ""}${hex(Math.abs(disp), 2)},${ADDR_REG(reg)},${idx})`, len: 2 };
    }
    case 7:
      switch (reg) {
        case 0: { // (xxx).w — absolute short
          const a = signedWord(rdWord(bytes, extPos));
          return { text: `(${hex(a & 0xFFFF, 4)}).w`, len: 2 };
        }
        case 1: { // (xxx).l — absolute long
          const a = rdLong(bytes, extPos);
          return { text: `(${hex(a, 8)}).l`, len: 4 };
        }
        case 2: { // (d16,PC)
          const d = signedWord(rdWord(bytes, extPos));
          const target = (pc + 2 + d) >>> 0; // pc points at this ext word - 2? see note
          return { text: `(${hex(target, 6)},pc)`, len: 2, pcRel: target };
        }
        case 3: { // (d8,PC,Xn)
          const ext = rdWord(bytes, extPos);
          const isAddr = (ext >> 15) & 1;
          const xn = (ext >> 12) & 7;
          const isLong = (ext >> 11) & 1;
          const disp = signedByte(ext & 0xFF);
          const idx = `${isAddr ? "a" : "d"}${xn}.${isLong ? "l" : "w"}`;
          return { text: `(${disp < 0 ? "-" : ""}${hex(Math.abs(disp), 2)},pc,${idx})`, len: 2 };
        }
        case 4: { // #imm
          if (size === 2) {
            const v = rdLong(bytes, extPos);
            return { text: `#${hex(v, 8)}`, len: 4 };
          } else if (size === 1) {
            const v = rdWord(bytes, extPos);
            return { text: `#${hex(v, 4)}`, len: 2 };
          } else {
            // byte immediate occupies a full word; value in low byte
            const v = rdWord(bytes, extPos) & 0xFF;
            return { text: `#${hex(v, 2)}`, len: 2 };
          }
        }
      }
  }
  return { text: "<ea?>", len: 0 };
}

const CONDITIONS = [
  "t", "f", "hi", "ls", "cc", "cs", "ne", "eq",
  "vc", "vs", "pl", "mi", "ge", "lt", "gt", "le",
];

/**
 * Disassemble one m68k instruction. Returns { length, text } or null at EOF.
 * `addr` is the CPU address of this instruction (24-bit).
 * pcRel branch targets are formatted as L______ so the label pass picks them up.
 */
function disasmOne(bytes, pos, addr) {
  if (pos + 1 >= bytes.length) return pos < bytes.length ? { length: 1, text: `.byte ${hex(bytes[pos], 2)}` } : null;
  const op = rdWord(bytes, pos);
  const top = (op >> 12) & 0xF;
  // Helper to finish an instruction with an EA operand.
  const ea = (mode, reg, size, side, opLenSoFar) =>
    decodeEA(mode, reg, bytes, pos + opLenSoFar, size, addr);

  // ---- NOP / RTS / RTE / RTR / RESET / TRAPV / illegal block ($4E__) ----
  if (op === 0x4E71) return { length: 2, text: "nop" };
  if (op === 0x4E75) return { length: 2, text: "rts" };
  if (op === 0x4E73) return { length: 2, text: "rte" };
  if (op === 0x4E77) return { length: 2, text: "rtr" };
  if (op === 0x4E70) return { length: 2, text: "reset" };
  if (op === 0x4E76) return { length: 2, text: "trapv" };
  if (op === 0x4E72) { // STOP #imm
    const imm = rdWord(bytes, pos + 2);
    return { length: 4, text: `stop #${hex(imm, 4)}` };
  }
  if ((op & 0xFFF0) === 0x4E40) return { length: 2, text: `trap #${op & 0xF}` };
  if ((op & 0xFFF8) === 0x4E50) { // LINK An,#d16
    const an = op & 7;
    const d = signedWord(rdWord(bytes, pos + 2));
    return { length: 4, text: `link ${ADDR_REG(an)},#${d < 0 ? "-" : ""}${hex(Math.abs(d), 4)}` };
  }
  if ((op & 0xFFF8) === 0x4E58) { // UNLK An
    return { length: 2, text: `unlk ${ADDR_REG(op & 7)}` };
  }
  if ((op & 0xFFF0) === 0x4E60) { // MOVE An,USP / USP,An
    const dir = (op >> 3) & 1;
    const an = op & 7;
    return { length: 2, text: dir ? `move usp,${ADDR_REG(an)}` : `move ${ADDR_REG(an)},usp` };
  }

  // ---- JMP / JSR ($4ED_ / $4E8_) ----
  if ((op & 0xFFC0) === 0x4EC0 || (op & 0xFFC0) === 0x4E80) {
    const isJsr = (op & 0xFFC0) === 0x4E80;
    const mode = (op >> 3) & 7, reg = op & 7;
    const e = ea(mode, reg, 2, "dst", 2);
    let text = `${isJsr ? "jsr" : "jmp"} ${e.text}`;
    // Absolute-long / absolute-short target → emit a label so it links.
    const m = e.text.match(/^\(\$([0-9A-F]+)\)\.[wl]$/);
    if (m) text = `${isJsr ? "jsr" : "jmp"} L${parseInt(m[1], 16).toString(16).toUpperCase().padStart(6, "0")}`;
    return { length: 2 + e.len, text };
  }

  // ---- Bcc / BRA / BSR ($6___) ----
  if (top === 0x6) {
    const cond = (op >> 8) & 0xF;
    let disp = op & 0xFF;
    let len = 2;
    let target;
    if (disp === 0x00) { // 16-bit displacement
      const d16 = signedWord(rdWord(bytes, pos + 2));
      target = (addr + 2 + d16) >>> 0;
      len = 4;
    } else if (disp === 0xFF) { // 32-bit displacement (68020+); rare on Genesis
      const d32 = signedLong(rdLong(bytes, pos + 2));
      target = (addr + 2 + d32) >>> 0;
      len = 6;
    } else {
      target = (addr + 2 + signedByte(disp)) >>> 0;
    }
    const mnem = cond === 0 ? "bra" : cond === 1 ? "bsr" : `b${CONDITIONS[cond]}`;
    return { length: len, text: `${mnem} L${target.toString(16).toUpperCase().padStart(6, "0")}` };
  }

  // ---- MOVEQ ($7___) ----
  if (top === 0x7 && ((op >> 8) & 1) === 0) {
    const dn = (op >> 9) & 7;
    const data = signedByte(op & 0xFF);
    return { length: 2, text: `moveq #${data < 0 ? "-" : ""}${hex(Math.abs(data), 2)},${DATA_REG(dn)}` };
  }

  // ---- MOVE / MOVEA ($1___ byte, $3___ word, $2___ long) ----
  if (top === 0x1 || top === 0x2 || top === 0x3) {
    const size = top === 0x1 ? 0 : top === 0x3 ? 1 : 2;
    const srcMode = (op >> 3) & 7, srcReg = op & 7;
    const dstMode = (op >> 6) & 7, dstReg = (op >> 9) & 7;
    const src = decodeEA(srcMode, srcReg, bytes, pos + 2, size, addr);
    const dst = decodeEA(dstMode, dstReg, bytes, pos + 2 + src.len, size, addr);
    const isMovea = dstMode === 1;
    return {
      length: 2 + src.len + dst.len,
      text: `${isMovea ? "movea" : "move"}${SIZE_SUFFIX[size]} ${src.text},${dst.text}`,
    };
  }

  // ---- LEA / CHK ($4___) and the $4 group (CLR/NEG/NOT/TST/PEA/EXT/SWAP/MOVEM) ----
  if (top === 0x4) {
    // LEA: 0100 ddd 111 mmm rrr
    if (((op >> 6) & 7) === 7 && ((op >> 8) & 1) === 1) {
      const an = (op >> 9) & 7;
      const mode = (op >> 3) & 7, reg = op & 7;
      const e = ea(mode, reg, 2, "src", 2);
      let text = `lea ${e.text},${ADDR_REG(an)}`;
      const m = e.text.match(/^\(\$([0-9A-F]+)\)\.[wl]$/);
      if (m) text = `lea L${parseInt(m[1], 16).toString(16).toUpperCase().padStart(6, "0")},${ADDR_REG(an)}`;
      return { length: 2 + e.len, text };
    }
    // CLR/NEG/NEGX/NOT/TST/NBCD/PEA/SWAP/EXT
    const hi = (op >> 8) & 0xF;
    const sizeBits = (op >> 6) & 3;
    const mode = (op >> 3) & 7, reg = op & 7;
    const simpleUnary = { 0x2: "clr", 0x4: "neg", 0x0: "negx", 0x6: "not", 0xA: "tst" };
    if (simpleUnary[hi] !== undefined && sizeBits !== 3) {
      const e = ea(mode, reg, sizeBits, "dst", 2);
      return { length: 2 + e.len, text: `${simpleUnary[hi]}${SIZE_SUFFIX[sizeBits]} ${e.text}` };
    }
    // SWAP Dn ($4840-$4847)
    if ((op & 0xFFF8) === 0x4840) return { length: 2, text: `swap ${DATA_REG(op & 7)}` };
    // PEA ($4840-... mode!=0) — share opcode space with SWAP; mode bits distinguish
    if ((op & 0xFFC0) === 0x4840) {
      const e = ea(mode, reg, 2, "dst", 2);
      return { length: 2 + e.len, text: `pea ${e.text}` };
    }
    // EXT.w ($48 80) / EXT.l ($48 C0)
    if ((op & 0xFFB8) === 0x4880 && mode === 0) {
      const long = (op >> 6) & 1;
      return { length: 2, text: `ext.${long ? "l" : "w"} ${DATA_REG(op & 7)}` };
    }
    // MOVEM ($48 80 / $4C 80) — reg list to/from memory
    if ((op & 0xFB80) === 0x4880) {
      const dir = (op >> 10) & 1; // 0 = reg→mem, 1 = mem→reg
      const long = (op >> 6) & 1;
      const list = rdWord(bytes, pos + 2);
      const e = decodeEA(mode, reg, bytes, pos + 4, 2, addr);
      const regs = movemRegList(list, mode === 4);
      const text = dir
        ? `movem.${long ? "l" : "w"} ${e.text},${regs}`
        : `movem.${long ? "l" : "w"} ${regs},${e.text}`;
      return { length: 4 + e.len, text };
    }
    // TRAP handled above; fall through to .dc.w
  }

  // ---- ADDQ / SUBQ / Scc / DBcc ($5___) ----
  if (top === 0x5) {
    const sizeBits = (op >> 6) & 3;
    if (sizeBits === 3) {
      // Scc or DBcc
      const cond = (op >> 8) & 0xF;
      if (((op >> 3) & 7) === 1) { // DBcc Dn,disp
        const dn = op & 7;
        const d16 = signedWord(rdWord(bytes, pos + 2));
        const target = (addr + 2 + d16) >>> 0;
        return { length: 4, text: `db${CONDITIONS[cond]} ${DATA_REG(dn)},L${target.toString(16).toUpperCase().padStart(6, "0")}` };
      }
      const mode = (op >> 3) & 7, reg = op & 7;
      const e = ea(mode, reg, 0, "dst", 2);
      return { length: 2 + e.len, text: `s${CONDITIONS[cond]} ${e.text}` };
    }
    const data = ((op >> 9) & 7) || 8; // 0 means 8
    const isSub = (op >> 8) & 1;
    const mode = (op >> 3) & 7, reg = op & 7;
    const e = ea(mode, reg, sizeBits, "dst", 2);
    return { length: 2 + e.len, text: `${isSub ? "subq" : "addq"}${SIZE_SUFFIX[sizeBits]} #${hex(data, 1)},${e.text}` };
  }

  // ---- OR/AND/SUB/ADD/EOR/CMP family ($8 $C $9 $D $B) + immediate group ($0) ----
  const aluByTop = { 0x8: "or", 0xC: "and", 0x9: "sub", 0xD: "add", 0xB: "cmp" };
  if (aluByTop[top] !== undefined) {
    const dn = (op >> 9) & 7;
    const opmode = (op >> 6) & 7;
    const mode = (op >> 3) & 7, reg = op & 7;
    let mnem = aluByTop[top];
    // CMP top=0xB: opmode 3/7 = CMPA, 4-6 with mode... EOR shares 0xB.
    if (top === 0xB) {
      if (opmode === 3 || opmode === 7) { // CMPA
        const size = opmode === 7 ? 2 : 1;
        const e = decodeEA(mode, reg, bytes, pos + 2, size, addr);
        return { length: 2 + e.len, text: `cmpa${SIZE_SUFFIX[size]} ${e.text},${ADDR_REG(dn)}` };
      }
      if (opmode >= 4) { // EOR Dn,<ea>
        const size = opmode & 3;
        const e = decodeEA(mode, reg, bytes, pos + 2, size, addr);
        return { length: 2 + e.len, text: `eor${SIZE_SUFFIX[size]} ${DATA_REG(dn)},${e.text}` };
      }
      // CMP <ea>,Dn
      const size = opmode & 3;
      const e = decodeEA(mode, reg, bytes, pos + 2, size, addr);
      return { length: 2 + e.len, text: `cmp${SIZE_SUFFIX[size]} ${e.text},${DATA_REG(dn)}` };
    }
    // ADD/SUB: opmode 3/7 = ADDA/SUBA (address dest). AND/OR have NO valid
    // 3/7 opmode in the <ea>,Dn / Dn,<ea> family — those encodings are
    // MULU/MULS (0xC) / DIVU/DIVS (0x8), which we don't decode. Emitting
    // `and`+SIZE_SUFFIX[3] (undefined) produced the `andundefined`/`orundefined`
    // garbage that then can't reassemble. Decode ADDA/SUBA; for AND/OR with
    // opmode 3/7 fall through to the faithful `.dc.w` default below.
    if ((top === 0x9 || top === 0xD) && (opmode === 3 || opmode === 7)) {
      const size = opmode === 7 ? 2 : 1;
      const e = decodeEA(mode, reg, bytes, pos + 2, size, addr);
      return { length: 2 + e.len, text: `${top === 0x9 ? "suba" : "adda"}${SIZE_SUFFIX[size]} ${e.text},${ADDR_REG(dn)}` };
    }
    // Only opmodes 0-2 (.b/.w/.l) and 4-6 are the regular ALU <ea><->Dn forms.
    // opmode 3/7 on AND/OR (and any size we can't suffix) → not this family.
    if (opmode !== 3 && opmode !== 7) {
      const size = opmode & 3;
      const dir = (opmode >> 2) & 1; // 0: <ea>,Dn  1: Dn,<ea>
      const e = decodeEA(mode, reg, bytes, pos + 2, size, addr);
      const text = dir
        ? `${mnem}${SIZE_SUFFIX[size]} ${DATA_REG(dn)},${e.text}`
        : `${mnem}${SIZE_SUFFIX[size]} ${e.text},${DATA_REG(dn)}`;
      return { length: 2 + e.len, text };
    }
    // else: fall through to the `.dc.w` default (MULU/MULS/DIVU/DIVS etc.)
  }

  // ---- Immediate ops ($0___): ORI/ANDI/SUBI/ADDI/EORI/CMPI + BTST/BSET/BCLR/BCHG ----
  if (top === 0x0) {
    const immGroup = { 0x0: "ori", 0x2: "andi", 0x4: "subi", 0x6: "addi", 0xA: "eori", 0xC: "cmpi" };
    const hi = (op >> 9) & 7;
    const sizeBits = (op >> 6) & 3;
    const mode = (op >> 3) & 7, reg = op & 7;
    const grpKey = (op >> 8) & 0xF;
    if (immGroup[grpKey] !== undefined && sizeBits !== 3) {
      const mnem = immGroup[grpKey];
      const imm = decodeEA(7, 4, bytes, pos + 2, sizeBits, addr); // #imm
      const e = decodeEA(mode, reg, bytes, pos + 2 + imm.len, sizeBits, addr);
      return { length: 2 + imm.len + e.len, text: `${mnem}${SIZE_SUFFIX[sizeBits]} ${imm.text},${e.text}` };
    }
    // Bit ops: BTST/BCHG/BCLR/BSET. Static (immediate bit #) form: $08__.
    if (grpKey === 0x8) {
      const bitOp = ["btst", "bchg", "bclr", "bset"][(op >> 6) & 3];
      const bit = rdWord(bytes, pos + 2) & 0xFF;
      const e = decodeEA(mode, reg, bytes, pos + 4, 0, addr);
      return { length: 4 + e.len, text: `${bitOp} #${hex(bit, 2)},${e.text}` };
    }
    // Dynamic bit ops (bit # in Dn): bits 8-6 select, bit 8 set.
    if (((op >> 8) & 1) === 1) {
      const bitOp = ["btst", "bchg", "bclr", "bset"][(op >> 6) & 3];
      const dn = (op >> 9) & 7;
      const e = decodeEA(mode, reg, bytes, pos + 2, 0, addr);
      return { length: 2 + e.len, text: `${bitOp} ${DATA_REG(dn)},${e.text}` };
    }
  }

  // ---- Shift / rotate ($E___) ----
  if (top === 0xE) {
    const sizeBits = (op >> 6) & 3;
    const types = ["as", "ls", "rox", "ro"];
    if (sizeBits !== 3) {
      const dir = (op >> 8) & 1; // 1 = left
      const type = types[(op >> 3) & 3];
      const countOrReg = (op >> 9) & 7;
      const isReg = (op >> 5) & 1;
      const dn = op & 7;
      const mnem = `${type}${dir ? "l" : "r"}${SIZE_SUFFIX[sizeBits]}`;
      const cnt = isReg ? DATA_REG(countOrReg) : `#${hex(countOrReg || 8, 1)}`;
      return { length: 2, text: `${mnem} ${cnt},${DATA_REG(dn)}` };
    }
    // memory shift (size=3): shift one word in memory by 1
    const dir = (op >> 8) & 1;
    const type = types[(op >> 9) & 3];
    const mode = (op >> 3) & 7, reg = op & 7;
    const e = decodeEA(mode, reg, bytes, pos + 2, 1, addr);
    return { length: 2 + e.len, text: `${type}${dir ? "l" : "r"} ${e.text}` };
  }

  // Unknown / unhandled — emit one raw word so the stream stays aligned.
  return { length: 2, text: `.dc.w ${hex(op, 4)}` };
}

function movemRegList(mask, predecrement) {
  // In predecrement mode the bit order is reversed (A7..A0,D7..D0).
  const names = [];
  const order = [];
  for (let i = 0; i < 16; i++) order.push(i);
  const bitFor = (i) => predecrement ? 15 - i : i;
  const regName = (i) => (i < 8 ? `d${i}` : `a${i - 8}`);
  const present = [];
  for (let i = 0; i < 16; i++) if ((mask >> bitFor(i)) & 1) present.push(i);
  // Collapse runs within d0-d7 and a0-a7 into ranges.
  const fmt = (lo, hi) => lo === hi ? regName(lo) : `${regName(lo)}-${regName(hi)}`;
  let i = 0;
  while (i < present.length) {
    let j = i;
    while (j + 1 < present.length &&
           present[j + 1] === present[j] + 1 &&
           (present[j] < 8) === (present[j + 1] < 8)) j++;
    names.push(fmt(present[i], present[j]));
    i = j + 1;
  }
  return names.join("/") || "<none>";
}

/**
 * Disassemble a byte buffer of m68k code. Mirrors runZ80dasm's output shape.
 *
 * @param {{ bytes: Uint8Array, startAddress: number, addComments?: boolean }} args
 * @returns {{ asm: string, exitCode: number }}
 */
export function runM68kdasm({ bytes, startAddress, addComments = true }) {
  // Pass 1: collect branch/label targets.
  const labels = new Set();
  let pos = 0, addr = startAddress >>> 0;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    for (const m of r.text.matchAll(/\bL([0-9A-F]{6})\b/g)) labels.add(parseInt(m[1], 16));
    pos += r.length;
    addr = (addr + r.length) >>> 0;
  }

  const lines = [
    "; m68kdasm (romdev built-in)",
    "; Input bytes: " + bytes.length,
    "",
    "        .setcpu \"68000\"",
    "",
  ];
  pos = 0;
  addr = startAddress >>> 0;
  while (pos < bytes.length) {
    const r = disasmOne(bytes, pos, addr);
    if (!r) break;
    if (labels.has(addr)) {
      lines.push(`L${addr.toString(16).toUpperCase().padStart(6, "0")}:`);
    }
    let line = "        " + r.text;
    if (addComments) {
      const rawBytes = [];
      for (let b = 0; b < r.length && pos + b < bytes.length; b++) {
        rawBytes.push(bytes[pos + b].toString(16).toUpperCase().padStart(2, "0"));
      }
      // Pad to a comment column.
      while (line.length < 40) line += " ";
      line += `; ${addr.toString(16).toUpperCase().padStart(6, "0")} ${rawBytes.join(" ")}`;
    }
    lines.push(line);
    pos += r.length;
    addr = (addr + r.length) >>> 0;
  }
  return { asm: lines.join("\n") + "\n", exitCode: 0 };
}
