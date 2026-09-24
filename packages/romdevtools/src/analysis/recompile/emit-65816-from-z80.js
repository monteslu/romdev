// Z80 IR → 65816 (SNES asar) emitter.
//
// This is a REAL cross-ISA translation, not the near-1:1 passthrough the
// 6502→65816 emitter uses. 65816 emulation mode is a 6502, so 6502 mnemonics
// re-emit verbatim; Z80 mnemonics do not exist on a 65816 at all, and emitting
// them produces a file that looks like assembly and cannot build.
//
// REGISTER MODEL - the whole design turns on this.
//
// The Z80 has more registers than the 65816 (A,B,C,D,E,H,L + the 16-bit pairs
// BC/DE/HL/IX/IY/SP), and the 65816 has A,X,Y and a direct page. So the Z80
// register file lives in DIRECT PAGE, one byte per register, and the 65816's A
// is the working register that values pass through:
//
//     $00 A   $01 B   $02 C   $03 D
//     $04 E   $05 H   $06 L   $07 F
//     $08-09 IX   $0A-0B IY
//
// HL/DE/BC are just the byte pairs above read as a word, so `ld a,(hl)` is an
// indirect load through direct page -- which the 65816 does natively with
// [dp] addressing. That is why direct page, rather than absolute RAM, is the
// right home: it keeps the common Z80 idioms to one instruction.
//
// WHAT IS NOT TRANSLATED. Z80 flag semantics differ from 6502/65816 (Z80 has
// N/H for BCD, and its carry is set the opposite way on subtract). Anything
// whose correctness depends on those bits is REFUSED by the lifter or emitted
// with an explicit marker here, rather than silently producing code that runs
// and computes the wrong thing.
//
// Plain JS ESM + JSDoc.

import { IR, COND } from "./ir.js";

/** Direct-page slots for the emulated Z80 register file. */
export const DP = Object.freeze({
  A: 0x00, B: 0x01, C: 0x02, D: 0x03,
  E: 0x04, H: 0x05, L: 0x06, F: 0x07,
  IX: 0x08, IY: 0x0a,
});

const dp = (n) => `$${n.toString(16).padStart(2, "0")}`;
/** Unique label counter for emitted block-op loops. */
let blkSeq = 0;
/** Unique label counter for branch-over-long-jump expansions. */
let brSeq = 0;
const I = "        ";

/** 8-bit register name → its direct-page slot, or null if not a plain reg. */
function regSlot(name) {
  const k = String(name ?? "").trim().toLowerCase();
  const map = { a: DP.A, b: DP.B, c: DP.C, d: DP.D, e: DP.E, h: DP.H, l: DP.L };
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
}

/** 16-bit pair → the direct-page slot of its LOW byte (65816 dp is little-endian). */
function pairSlot(name) {
  const k = String(name ?? "").trim().toLowerCase();
  // Z80 pairs are high:low (H is high of HL); a 65816 [dp] word read wants the
  // LOW byte first, so point at L / E / C and let the word read pick up the high.
  const map = { hl: DP.L, de: DP.E, bc: DP.C, ix: DP.IX, iy: DP.IY, sp: 0x0c, af: DP.A };
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null;
}

/**
 * Z80-only registers with NO 65816 equivalent.
 *
 * `I` is the interrupt-vector register and `R` the memory-refresh counter.
 * Neither exists on a 65816, and both are plain identifiers, so `ld a,r` sailed
 * through `labelToken()` and emitted `lda r` - an ALU op against a LABEL NAMED
 * r that does not exist, rejected by asar as Elabel_not_found. Emitting a
 * marker keeps the line visible in the output AND counted in residue, which is
 * the honest outcome: refusing to translate is not the same as pretending the
 * instruction was not there. (`ld a,r` is used as a cheap pseudo-random source
 * in real games, so this appears in commercial code and not in short samples.)
 */
const Z80_ONLY_REGS = new Set(["i", "r"]);
const isZ80OnlyReg = (t) => Z80_ONLY_REGS.has(String(t ?? "").trim().toLowerCase());

/** Parse `dst,src` into trimmed halves (either may be absent). */
function operands(operand) {
  const s = String(operand ?? "").trim();
  if (!s) return [null, null];
  const i = s.indexOf(",");
  if (i < 0) return [s, null];
  return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

/** An immediate like `$2` / `0x2` / `2` → a 65816 immediate, else null. */
function immediate(tok) {
  const t = String(tok ?? "").trim();
  // REGISTER NAMES FIRST. `a`, `b`, `c`, `d`, `e` are all valid hex digits, so
  // a bare hex match happily read `ld (hl),a` as "load immediate 0x0A" and
  // `xor a` (the idiomatic Z80 zero-A) as "xor 0x0A" -- both silently wrong,
  // and both in the first ten instructions of real code.
  if (regSlot(t) != null) return null;
  // Only a `$`/`h`-marked literal, or a multi-digit run, is an immediate; a
  // bare single letter is a register.
  const m = t.match(/^\$([0-9A-Fa-f]{1,4})$/)
    || t.match(/^([0-9A-Fa-f]{1,4})[Hh]$/)
    || t.match(/^([0-9]+)$/);
  if (!m) return null;
  const v = parseInt(m[1], /^[0-9]+$/.test(m[1]) && !/[$Hh]/.test(t) ? 10 : 16);
  return Number.isFinite(v) ? `#$${(v & 0xff).toString(16).padStart(2, "0")}` : null;
}

/** `(hl)` / `(de)` / `(bc)` / `(ix+d)` → an indirect read/write plan. */
function indirect(tok) {
  const t = String(tok ?? "").trim().toLowerCase();
  const m = t.match(/^\(\s*(hl|de|bc|ix|iy)\s*([+-]\s*\$?[0-9a-fA-F]+)?\s*\)$/);
  if (!m) return null;
  const slot = pairSlot(m[1]);
  if (slot == null) return null;
  return { slot, disp: m[2] ? m[2].replace(/\s+/g, "") : null, pair: m[1] };
}

/** `(ix+10)` displacements are DECIMAL in objdump output; `$`-prefixed is hex. */
function parseDisp(disp) {
  const t = String(disp ?? "").replace(/\s+/g, "");
  const neg = t.startsWith("-");
  const body = t.replace(/^[+-]/, "");
  const v = body.startsWith("$")
    ? parseInt(body.slice(1), 16)
    : parseInt(body, 10);
  return Number.isFinite(v) ? (neg ? -v : v) : NaN;
}

/** `($1234)` or `(LABEL)` → an absolute operand, else null. */
function absolute(tok) {
  const t = String(tok ?? "").trim();
  const m = t.match(/^\(\s*\$?([0-9A-Fa-f]{2,4})[Hh]?\s*\)$/);
  if (m) return `$${parseInt(m[1], 16).toString(16).padStart(4, "0")}`;
  // The disassembler labels addresses, so real code says `ld a,(L000000)`
  // far more often than it says `ld a,($0000)`. A label IS an address.
  const lbl = t.match(/^\(\s*([A-Za-z_.$][\w.$]*)\s*\)$/);
  if (lbl) return lbl[1];
  return null;
}

/** A bare label used as a value (`ld hl,L000123`). */
function labelToken(tok) {
  const t = String(tok ?? "").trim();
  return /^[A-Za-z_.$][\w.$]*$/.test(t) && regSlot(t) == null && pairSlot(t) == null ? t : null;
}

/**
 * Load one Z80 source operand into the 65816 accumulator.
 * Returns the instruction lines, or null when the form is not translatable.
 */
function loadIntoA(src, out) {
  const imm = immediate(src);
  if (imm) { out.push(`${I}lda     ${imm}`); return true; }
  const r = regSlot(src);
  if (r != null) { out.push(`${I}lda     ${dp(r)}`); return true; }
  const ind = indirect(src);
  if (ind && !ind.disp) { out.push(`${I}lda     [${dp(ind.slot)}]`); return true; }
  if (ind && ind.disp) {
    // (ix+d) / (iy+d): displacement in Y, then [dp],y.
    const d = parseDisp(ind.disp);
    if (!Number.isFinite(d)) return false;
    const w = emitIndexForDisp(d, out);
    out.push(`${I}lda     [${dp(ind.slot)}],y`);
    restoreIndexWidth(w, out);
    return true;
  }
  const abs = absolute(src);
  if (abs) { out.push(`${I}lda     ${abs}`); return true; }
  // A bare label as a SOURCE is an absolute address the disassembler named.
  const lbl = labelToken(src);
  if (lbl) { out.push(`${I}lda     ${lbl}`); return true; }
  return false;
}

/** Store the accumulator into one Z80 destination operand. */
function storeFromA(dst, out) {
  const r = regSlot(dst);
  if (r != null) { out.push(`${I}sta     ${dp(r)}`); return true; }
  const ind = indirect(dst);
  if (ind && !ind.disp) { out.push(`${I}sta     [${dp(ind.slot)}]`); return true; }
  if (ind && ind.disp) {
    const d = parseDisp(ind.disp);
    if (!Number.isFinite(d)) return false;
    const w = emitIndexForDisp(d, out);
    out.push(`${I}sta     [${dp(ind.slot)}],y`);
    restoreIndexWidth(w, out);
    return true;
  }
  const abs = absolute(dst);
  if (abs) { out.push(`${I}sta     ${abs}`); return true; }
  const lbl = labelToken(dst);
  if (lbl) { out.push(`${I}sta     ${lbl}`); return true; }
  return false;
}

/**
 * Emit the index load for an `(ix+d)` / `(iy+d)` displacement.
 *
 * THE SIGN TRAP. The Z80 displacement is a SIGNED byte (-128..+127) and
 * negative offsets are ordinary -- `(ix-3)` reaches a local below a frame
 * pointer. The 65816's `[dp],y` index, by contrast, is UNSIGNED. Narrowing the
 * displacement with `d & 0xff` therefore turned `(iy-3)` into `ldy #$fd`,
 * indexing +253 instead of -3: a read 256 bytes away from the intended byte,
 * with no error anywhere.
 *
 * Y must hold the 16-bit two's-complement value so the add wraps correctly, so
 * a negative displacement loads Y in 16-bit mode. A non-negative one keeps the
 * cheap 8-bit form.
 */
function emitIndexForDisp(d, out) {
  if (d < 0) {
    const word = (d & 0xffff) >>> 0;
    out.push(`${I}rep     #$10            ; 16-bit Y: (i${"xy"}±d) displacement ${d} is NEGATIVE`);
    out.push(`${I}ldy     #$${word.toString(16).padStart(4, "0")}`);
    return { wide: true };
  }
  out.push(`${I}ldy     #$${(d & 0xff).toString(16).padStart(2, "0")}`);
  return { wide: false };
}

/** Restore 8-bit index registers after a wide displacement load. */
function restoreIndexWidth(state, out) {
  if (state.wide) out.push(`${I}sep     #$10            ; back to 8-bit index`);
}

/** Untranslatable line marker - visible in the output AND in the residue. */
function untranslated(node, why) {
  return `${I}; UNTRANSLATED (${why}): ${(node.raw || "").trim()}`;
}

/** Z80 `ld` - the single most common instruction, hence its own path. */
function emitLd(node, out) {
  const [dst, src] = operands(node.operand);
  if (!dst || !src) { out.push(untranslated(node, "ld needs two operands")); return; }
  if (isZ80OnlyReg(dst) || isZ80OnlyReg(src)) {
    out.push(untranslated(node, `Z80-only register (I/R) has no 65816 equivalent`));
    return;
  }
  // 16-bit pair loads (`ld hl,$1234`) set two dp bytes.
  const pair = pairSlot(dst);
  if (pair != null && regSlot(dst) == null) {
    // ORDER MATTERS, for the same register/hex ambiguity `immediate()` guards
    // against. `de`, `bc`, `ad`, `be` are all valid hex, so testing the bare
    // literal first read `ld hl,de` as "load immediate $00DE" -- a silent
    // miscompile of a plain pair-to-pair move, and one of the most common
    // 16-bit instructions in real Z80 code. Registers are checked first, so a
    // literal is only ever what is left over.
    const srcPairFirst = pairSlot(src);
    if (srcPairFirst != null) {
      out.push(`${I}rep     #$20            ; 16-bit pair-to-pair move`);
      out.push(`${I}lda     ${dp(srcPairFirst)}`);
      out.push(`${I}sta     ${dp(pair)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    // Only a `$`/`h`-MARKED literal, or one containing a digit, is a number;
    // a bare all-letter token is a register name we do not handle here.
    // A leading 0 is how `h`-suffix assemblers keep a hex value that starts
    // with a letter from looking like an identifier (`0beefh`), so allow five
    // characters in that form -- refusing it lost a legitimate literal.
    const m = /^(\$[0-9A-Fa-f]{1,4}|[0-9][0-9A-Fa-f]{0,4}[Hh]|[0-9][0-9A-Fa-f]{0,3})$/.test(String(src).trim())
      ? String(src).trim().match(/^\$?0?([0-9A-Fa-f]{1,4})[Hh]?$/) : null;
    if (m) {
      const v = parseInt(m[1], 16) & 0xffff;
      out.push(`${I}rep     #$20            ; 16-bit A for a pair load`);
      out.push(`${I}lda     #$${v.toString(16).padStart(4, "0")}`);
      out.push(`${I}sta     ${dp(pair)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    const lbl = labelToken(src);
    if (lbl) {
      out.push(`${I}rep     #$20            ; 16-bit pair load from a label`);
      out.push(`${I}lda     #${lbl}`);
      out.push(`${I}sta     ${dp(pair)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    // (pair-to-pair is handled at the top of this branch, before the literal
    // match, because a pair name is also valid hex.)
    const absSrc = absolute(src);
    if (absSrc) {
      out.push(`${I}rep     #$20            ; 16-bit load from memory`);
      out.push(`${I}lda     ${absSrc}`);
      out.push(`${I}sta     ${dp(pair)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    out.push(untranslated(node, "16-bit load from an unsupported source"));
    return;
  }
  // `ld <pair>,<pair>` where dst parsed as an 8-bit reg name (b/c/d/e/h/l are
  // also pair letters) -- fall through to the 8-bit path only when src is 8-bit.
  if (pairSlot(src) != null && regSlot(src) == null) {
    // A 16-bit SOURCE with a non-pair destination is a 16-bit STORE:
    // `ld ($C105),hl` / `ld sp,hl`. Both are word moves in 16-bit A.
    const sp = pairSlot(src);
    const absDst = absolute(dst) ?? labelToken(dst);
    if (absDst) {
      out.push(`${I}rep     #$20            ; 16-bit store`);
      out.push(`${I}lda     ${dp(sp)}`, `${I}sta     ${absDst}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    out.push(untranslated(node, `16-bit source '${src}' into an 8-bit destination`));
    return;
  }
  if (!loadIntoA(src, out)) { out.push(untranslated(node, `unsupported source '${src}'`)); return; }
  if (!storeFromA(dst, out)) { out.push(untranslated(node, `unsupported destination '${dst}'`)); return; }
}

/** ALU ops: Z80 is `<op> <src>` implicitly against A. */
function emitAlu(op65, node, out) {
  const [srcOnly] = operands(node.operand);
  const src = srcOnly ?? node.operand;
  out.push(`${I}lda     ${dp(DP.A)}`);
  const imm = immediate(src);
  if (imm) { out.push(`${I}${op65}     ${imm}`); }
  else {
    const r = regSlot(src);
    const ind = indirect(src);
    const pr = pairSlot(src);
    const albl = labelToken(src) ?? absolute(src);
    // ORDER MATTERS. `absolute()` also accepts the `(LABEL)` spelling, so it
    // matches `(hl)` and hands back the bare text `hl` - which then emitted
    // `eor hl`, an ALU op against a LABEL NAMED hl that does not exist. asar
    // rejects it with Elabel_not_found, and only on real code: a register
    // indirect as an ALU source is common in commercial ROMs and absent from
    // short synthetic routines. REGISTER-INDIRECT is checked before anything
    // that could read it as a name.
    if (r != null) out.push(`${I}${op65}     ${dp(r)}`);
    else if (ind && !ind.disp) out.push(`${I}${op65}     [${dp(ind.slot)}]`);
    else if (ind && ind.disp) {
      // (ix+d)/(iy+d) as an ALU source: index in Y, then [dp],y.
      const d = parseDisp(ind.disp);
      if (!Number.isFinite(d)) { out.push(untranslated(node, `unsupported ALU displacement '${ind.disp}'`)); return; }
      const w = emitIndexForDisp(d, out);
      out.push(`${I}${op65}     [${dp(ind.slot)}],y`);
      restoreIndexWidth(w, out);
    }
    else if (albl && pr == null) out.push(`${I}${op65}     ${albl}`);
    else if (pr != null) {
      // 16-bit ALU (`add hl,de`): the accumulator load above was 8-bit, so
      // redo the whole thing in 16-bit mode against the pair.
      out.length = out.length - 1;                 // drop the 8-bit lda
      const [dstPair] = operands(node.operand);
      const dslot = pairSlot(dstPair) ?? DP.L;
      out.push(`${I}rep     #$20            ; 16-bit ${op65}`);
      out.push(`${I}lda     ${dp(dslot)}`);
      out.push(`${I}${op65}     ${dp(pr)}`);
      out.push(`${I}sta     ${dp(dslot)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    else { out.push(untranslated(node, `unsupported ALU operand '${src}'`)); return; }
  }
  out.push(`${I}sta     ${dp(DP.A)}`);
}

/** inc/dec on a register or through a pair. */
function emitIncDec(which, node, out) {
  const [tgt] = operands(node.operand);
  const t = tgt ?? node.operand;
  const r = regSlot(t);
  if (r != null) { out.push(`${I}${which}     ${dp(r)}`); return; }
  const p = pairSlot(t);
  if (p != null) {
    out.push(`${I}rep     #$20            ; 16-bit pair ${which}`);
    out.push(`${I}${which}     ${dp(p)}`);
    out.push(`${I}sep     #$20`);
    return;
  }
  const ind = indirect(t);
  if (ind && !ind.disp) {
    out.push(`${I}lda     [${dp(ind.slot)}]`);
    out.push(`${I}${which}     a`);
    out.push(`${I}sta     [${dp(ind.slot)}]`);
    return;
  }
  out.push(untranslated(node, `unsupported ${which} operand '${t}'`));
}

/** IR condition → the 65816 branch that tests it. */
/** The INVERSE branch, for the branch-over-long-jump expansion below. */
const BRANCH_INVERSE = {
  beq: "bne", bne: "beq", bcs: "bcc", bcc: "bcs",
  bmi: "bpl", bpl: "bmi", bvs: "bvc", bvc: "bvs",
};

const BRANCH_OF = {
  [COND.EQ]: "beq", [COND.NE]: "bne",
  [COND.CS]: "bcs", [COND.CC]: "bcc",
  [COND.MI]: "bmi", [COND.PL]: "bpl",
  [COND.VS]: "bvs", [COND.VC]: "bvc",
};

function emitReg(node, out) {
  const m = String(node.mnemonic ?? "").toLowerCase();
  switch (m) {
    case "ld":  emitLd(node, out); return;
    case "and": emitAlu("and", node, out); return;
    case "or":  emitAlu("ora", node, out); return;
    case "xor": emitAlu("eor", node, out); return;
    case "add": case "adc": emitAlu("adc", node, out); return;
    case "sub": case "sbc": emitAlu("sbc", node, out); return;
    case "cp":  emitAlu("cmp", node, out); return;
    case "inc": emitIncDec("inc", node, out); return;
    case "dec": emitIncDec("dec", node, out); return;
    case "nop": out.push(`${I}nop`); return;
    case "scf": out.push(`${I}sec`); return;
    case "ccf": out.push(`${I}; ccf: complement carry`); out.push(`${I}bcs     +`); out.push(`${I}sec`); out.push(`${I}bra     ++`); out.push(`+       clc`); out.push("++"); return;
    case "di":  out.push(`${I}sei`); return;
    case "ei":  out.push(`${I}cli`); return;
    case "cpl": out.push(`${I}lda     ${dp(DP.A)}`, `${I}eor     #$ff`, `${I}sta     ${dp(DP.A)}`); return;
    // Accumulator rotates. Z80's rlca/rrca rotate A alone; the 65816 rotates
    // through carry, which is the same shape for the common "shift a byte out"
    // idiom these appear in.
    case "rlca": case "rla": out.push(`${I}lda     ${dp(DP.A)}`, `${I}rol     a`, `${I}sta     ${dp(DP.A)}`); return;
    case "rrca": case "rra": out.push(`${I}lda     ${dp(DP.A)}`, `${I}ror     a`, `${I}sta     ${dp(DP.A)}`); return;
    case "rlc": case "rl": case "sla": case "sll":
    case "rrc": case "rr": case "sra": case "srl": {
      const [tgt] = operands(node.operand);
      const rs = regSlot(tgt); const ind2 = indirect(tgt);
      const rot = /^(rlc|rl|sla|sll)$/.test(m) ? "rol" : (m === "srl" ? "lsr" : "ror");
      if (rs != null) { out.push(`${I}${rot}     ${dp(rs)}`); return; }
      if (ind2 && !ind2.disp) {
        out.push(`${I}lda     [${dp(ind2.slot)}]`, `${I}${rot}     a`, `${I}sta     [${dp(ind2.slot)}]`);
        return;
      }
      out.push(untranslated(node, `unsupported ${m} operand`)); return;
    }
    // bit/set/res N,<target> - the 65816 has no bit-addressing, so build the
    // mask and use and/ora/bit.
    case "bit": case "set": case "res": {
      const parts = String(node.operand ?? "").split(",");
      const n = parseInt(String(parts[0] ?? "").trim(), 10);
      const tgt = (parts[1] ?? "").trim();
      if (!Number.isFinite(n) || n < 0 || n > 7) { out.push(untranslated(node, `${m} with a non-literal bit index`)); return; }
      const mask = 1 << n;
      const hex = `#$${mask.toString(16).padStart(2, "0")}`;
      const rs = regSlot(tgt); const ind2 = indirect(tgt);
      const src = rs != null ? dp(rs) : (ind2 && !ind2.disp ? `[${dp(ind2.slot)}]` : null);
      if (!src) { out.push(untranslated(node, `unsupported ${m} target '${tgt}'`)); return; }
      if (m === "bit") { out.push(`${I}lda     ${src}`, `${I}and     ${hex}      ; bit ${n} -> Z`); return; }
      out.push(`${I}lda     ${src}`);
      out.push(m === "set" ? `${I}ora     ${hex}` : `${I}and     #$${(~mask & 0xff).toString(16).padStart(2, "0")}`);
      out.push(`${I}sta     ${src}`);
      return;
    }
    // ex de,hl / exx swap register banks. Emulated in direct page, a swap is
    // just three moves -- no 65816 instruction needed.
    case "ex": {
      const [d1, s1] = operands(node.operand);
      // `ex af,af'` swaps the accumulator/flags with their shadow copies.
      // Shadows live just past the main file, so the swap is byte moves.
      if (/^af\s*,\s*af'?$/i.test(String(node.operand ?? "").trim())) {
        out.push(`${I}; ex af,af' - swap A/F with their shadow copies`);
        for (const [main, shadow] of [[DP.A, 0x10], [DP.F, 0x11]]) {
          out.push(`${I}lda     ${dp(main)}`, `${I}pha`,
                   `${I}lda     ${dp(shadow)}`, `${I}sta     ${dp(main)}`,
                   `${I}pla`, `${I}sta     ${dp(shadow)}`);
        }
        return;
      }
      const p1 = pairSlot(d1), p2 = pairSlot(s1);
      if (p1 == null || p2 == null) { out.push(untranslated(node, `unsupported ex operands '${node.operand}'`)); return; }
      out.push(`${I}rep     #$20            ; ex ${d1},${s1}`);
      out.push(`${I}lda     ${dp(p1)}`, `${I}pha`);
      out.push(`${I}lda     ${dp(p2)}`, `${I}sta     ${dp(p1)}`);
      out.push(`${I}pla`, `${I}sta     ${dp(p2)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    case "push": case "pop": {
      const [p] = operands(node.operand);
      // `push af` is the flags+accumulator pair; A lives at $00 and F at $07,
      // which are not adjacent, so push them as two bytes rather than a word.
      if (String(p ?? "").trim().toLowerCase() === "af") {
        if (m === "push") out.push(`${I}lda     ${dp(DP.A)}`, `${I}pha`, `${I}lda     ${dp(DP.F)}`, `${I}pha`);
        else out.push(`${I}pla`, `${I}sta     ${dp(DP.F)}`, `${I}pla`, `${I}sta     ${dp(DP.A)}`);
        return;
      }
      const slot = pairSlot(p) ?? regSlot(p);
      if (slot == null) { out.push(untranslated(node, `unsupported ${m} operand '${p}'`)); return; }
      out.push(`${I}rep     #$20`);
      out.push(m === "push" ? `${I}lda     ${dp(slot)}` : `${I}pla`);
      out.push(m === "push" ? `${I}pha` : `${I}sta     ${dp(slot)}`);
      out.push(`${I}sep     #$20`);
      return;
    }
    // Block moves. `ldir` copies BC bytes from (HL) to (DE) and is one opcode
    // on Z80; on 65816 it is a loop. Emitting the loop is mechanical and
    // exact -- these appear in every real ROM's init path, so refusing them
    // left a visible hole in otherwise-complete output.
    case "ldi": case "ldir": case "ldd": case "lddr": {
      const dec = m.startsWith("ldd");
      const rep = m.endsWith("r");
      const lbl = `Lz80_blk_${blkSeq++}`;
      if (rep) out.push(`${lbl}:`);
      out.push(`${I}lda     [${dp(DP.L)}]          ; (HL)`);
      out.push(`${I}sta     [${dp(DP.E)}]          ; -> (DE)`);
      out.push(`${I}rep     #$20`);
      out.push(`${I}lda     ${dp(DP.L)}`, `${I}${dec ? "dec" : "inc"}     a`, `${I}sta     ${dp(DP.L)}`);
      out.push(`${I}lda     ${dp(DP.E)}`, `${I}${dec ? "dec" : "inc"}     a`, `${I}sta     ${dp(DP.E)}`);
      out.push(`${I}lda     ${dp(DP.C)}`, `${I}dec     a`, `${I}sta     ${dp(DP.C)}`);
      out.push(`${I}sep     #$20`);
      if (rep) out.push(`${I}bne     ${lbl}`);
      return;
    }
    case "cpi": case "cpir": case "cpd": case "cpdr": {
      const dec = m.startsWith("cpd");
      const rep = m.endsWith("r");
      const lbl = `Lz80_blk_${blkSeq++}`;
      if (rep) out.push(`${lbl}:`);
      out.push(`${I}lda     ${dp(DP.A)}`, `${I}cmp     [${dp(DP.L)}]`);
      out.push(`${I}rep     #$20`);
      out.push(`${I}lda     ${dp(DP.L)}`, `${I}${dec ? "dec" : "inc"}     a`, `${I}sta     ${dp(DP.L)}`);
      out.push(`${I}lda     ${dp(DP.C)}`, `${I}dec     a`, `${I}sta     ${dp(DP.C)}`);
      out.push(`${I}sep     #$20`);
      if (rep) out.push(`${I}bne     ${lbl}`);
      return;
    }
    // Interrupt mode / halt have no 65816 equivalent worth faking; they are
    // system-level and the target's own init owns that decision.
    case "im":   out.push(`${I}; im ${node.operand ?? ""} - interrupt mode is the target's own concern`); return;
    case "halt": out.push(`${I}; halt - target decides (wai on 65816 if an IRQ will arrive)`); return;
    case "exx": {
      // Swap BC/DE/HL with the shadow bank. Shadows occupy $12..$17, mirroring
      // the main file's layout so each swap is a word move.
      out.push(`${I}; exx - swap BC/DE/HL with the shadow bank`);
      out.push(`${I}rep     #$20`);
      for (const [main, shadow] of [[DP.C, 0x12], [DP.E, 0x14], [DP.L, 0x16]]) {
        out.push(`${I}lda     ${dp(main)}`, `${I}pha`,
                 `${I}lda     ${dp(shadow)}`, `${I}sta     ${dp(main)}`,
                 `${I}pla`, `${I}sta     ${dp(shadow)}`);
      }
      out.push(`${I}sep     #$20`);
      return;
    }
    default:
      // Everything else (block ops, daa, rotates through (HL), im, halt)
      // has no faithful single-instruction 65816 form. Marking it is the
      // honest outcome: the line is visible in the asm AND counted as residue.
      out.push(untranslated(node, `no 65816 translation for Z80 '${m}'`));
  }
}

/**
 * IR (from a Z80 lifter) → 65816 body text.
 * @param {Array<object>} ir
 */
export function emit65816FromZ80Body(ir) {
  const out = [];
  blkSeq = 0; brSeq = 0;
  // ONE DEFINITION PER LABEL. A label can arrive twice for the same address:
  // once as its own LABEL node and again attached to the instruction that
  // follows it. Emitting both produced `reset:` twice and asar rejected the
  // file with Elabel_redefined - visible only on a slice big enough to include
  // the vector table, which is why a small region assembled fine. Defining a
  // label a second time is never meaningful here, so the duplicate is dropped
  // rather than renamed: a renamed label would silently break the branch that
  // targets it.
  const defined = new Set();
  const define = (name) => {
    if (!name || defined.has(name)) return;
    defined.add(name);
    out.push(`${name}:`);
  };
  for (const node of ir) {
    if (node.label && node.op !== IR.LABEL) define(node.label);
    switch (node.op) {
      case IR.LABEL: define(node.name); break;
      case IR.REG:   emitReg(node, out); break;
      case IR.BRANCH: {
        // THE RANGE PROBLEM, and why a short branch cannot be emitted directly.
        //
        // A Z80 `jr`/`djnz` and a 65816 `beq`/`bne` have the SAME +/-128 range,
        // so a naive 1:1 emission looks safe. It is not: this emitter expands
        // ONE Z80 instruction into MANY 65816 instructions - every 16-bit pair
        // op becomes a rep/op/sep sandwich - so a loop that fit comfortably in
        // Z80 no longer fits. Real code fails in both directions (measured
        // -139, -482 and +252 on commercial ROMs); a short synthetic routine
        // survives, which is exactly why an assembly gate on a small fixture
        // did not catch it.
        //
        // The fix is the standard assembler expansion: invert the condition,
        // branch OVER a long jump, and let the long jump carry the distance.
        // `brl` is +/-32767 and stays relative, so the output remains
        // position-independent - which a `jmp` to an absolute label would not.
        const b = BRANCH_OF[node.cond] ?? "bne";
        const inv = BRANCH_INVERSE[b] ?? "beq";
        const over = `Lz80_br_${brSeq++}`;
        out.push(`${I}${inv}     ${over}`);
        out.push(`${I}brl     ${node.target}`);
        define(over);
        break;
      }
      case IR.JUMP:  out.push(`${I}jmp     ${node.target}`); break;
      case IR.CALL:  out.push(`${I}jsr     ${node.target}`); break;
      case IR.RET:   out.push(node.kind === "interrupt" ? `${I}rti` : `${I}rts`); break;
      case IR.HWREG: {
        // The Z80 seam is I/O SPACE, not memory-mapped registers: the port
        // number identifies the device. Route it through one runtime call so
        // the target's own hardware is wired in one place.
        const port = node.reg == null ? "(c)" : `$${node.reg.toString(16)}`;
        out.push(`${I}; seam: Z80 I/O ${node.access} port ${port}`);
        if (node.reg == null) {
          out.push(`${I}lda     ${dp(DP.C)}`, `${I}tax`);
        } else {
          out.push(`${I}ldx     #$${(node.reg & 0xff).toString(16).padStart(2, "0")}`);
        }
        out.push(node.access === "write"
          ? `${I}lda     ${dp(DP.A)}\n${I}jsr     Z80_IO_WRITE`
          : `${I}jsr     Z80_IO_READ\n${I}sta     ${dp(DP.A)}`);
        break;
      }
      case IR.PASSTHROUGH: out.push(node.text); break;
      case IR.REFUSE:
        out.push(`${I}; UNTRANSLATED: ${(node.raw || "").trim()}  (${node.reason})`);
        break;
      default: break;
    }
  }
  return out.join("\n");
}

/** The Z80 I/O seam stub - one place to wire the target's real hardware. */
export function emitZ80SeamAsm() {
  return [
    "; Z80 I/O seam. X = port number, A = value (write) / result (read).",
    ";",
    "; The Z80 reaches hardware through a SEPARATE I/O space rather than",
    "; memory-mapped registers, so every in/out is a device access and nothing",
    "; else is. Wire the target's hardware here; until then a read returns 0",
    "; and a write is dropped, which is visible rather than wrong.",
    "Z80_IO_WRITE:",
    "        rts",
    "Z80_IO_READ:",
    "        lda     #$00",
    "        rts",
    "",
  ].join("\n");
}
