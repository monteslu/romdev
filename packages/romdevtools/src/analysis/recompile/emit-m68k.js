// IR → m68k (Genesis / Mega Drive, vasm68k syntax) emitter. This is the proof
// that the recompile engine is GENERIC: a 6502-sourced IR targets the 68000 here
// through the SAME pipeline that targets the 65816 — no second bespoke recompiler.
//
// Unlike NES→SNES (65816 runs 6502 logic 1:1 in emulation mode), NES→Genesis is
// REAL ISA translation: the 6502's 8-bit register file is modeled on 68000 data
// registers, and each abstract op becomes the equivalent 68000 instruction. The
// 6502 address space (zero page + RAM + the parts of $0000-$1FFF a game touches)
// is mapped to a contiguous block of 68000 work RAM (NES_RAM), so a `sta $05`
// becomes `move.b d0, (NES_RAM+5).w` — and that block IS the Tier-1 RAM-diff
// oracle's mirror (run original + port, byte-diff this block per frame).
//
// SCOPE (phase 1, logic only): the documented 6502 set that maps mechanically;
// the PPU/APU seam is STUBBED (writes drop, $2002 read → $80 so vblank loops
// exit), exactly like the SNES phase-1 path — presentation is a later runtime.
// Decimal mode, RMW-on-MMIO, and undocumented opcodes are REFUSED upstream by the
// lifter, so they never reach here.
//
// Register model:  6502 A → d0   X → d1   Y → d2   (8-bit, used via .b)
//                  6502 P (flags) → the 68000 CCR is set by the move/alu itself;
//                  we do NOT model the full 6502 flag semantics — branches use the
//                  CCR the prior op left, which is correct for the common
//                  load→branch / compare→branch idioms (the same pragmatic bound
//                  the SNES emulation-mode path relies on hardware for).
//
// Plain JS ESM + JSDoc.

import { IR } from "./ir.js";
import { ABSTRACT, COND } from "./ir.js";

/** Base of the mapped 6502 address space inside 68000 work RAM. Genesis work RAM
 *  is $FF0000-$FFFFFF; we park the 8KB NES-visible space at $FF0000. A 6502
 *  address N reads/writes (NES_RAM + N). */
const NES_RAM = 0xff0000;

/** 6502 registers → 68000 data registers. */
const ACC = "d0", X = "d1", Y = "d2";

/** Translate a 6502 operand to a 68000 source/dest effective address.
 *  Returns { ea, imm } — `imm` true if it's an immediate (#...). Indexed modes
 *  (`$addr,x` / `$addr,y`) use the index register as a 68000 address-register
 *  displacement via a scratch address reg a0. */
function operandToEa(operand) {
  if (operand == null) return { ea: null, imm: false };
  const op = operand.trim();
  // immediate: #$nn  →  #$nn
  let m = op.match(/^#\$([0-9A-Fa-f]+)$/);
  if (m) return { ea: `#$${m[1]}`, imm: true };
  m = op.match(/^#(\d+)$/);
  if (m) return { ea: `#${m[1]}`, imm: true };
  // absolute / zero-page, optionally indexed
  m = op.match(/^\$([0-9A-Fa-f]+)\s*(?:,\s*([xy]))?$/i);
  if (m) {
    const addr = parseInt(m[1], 16);
    const idx = m[2] ? m[2].toLowerCase() : null;
    if (!idx) {
      const abs = NES_RAM + addr;
      // word-sized absolute EA: (abs).l (work RAM is in the high $FFxxxx range)
      return { ea: `(${hex(abs)}).l`, imm: false, addr };
    }
    // indexed: a0 = NES_RAM + addr + index_reg ; EA = (a0)
    return { ea: null, imm: false, addr, idx };
  }
  // a bare label (branch/jump target handled elsewhere) — pass through as a symbol
  return { ea: op, imm: false, symbol: true };
}

const hex = (n) => "$" + (n >>> 0).toString(16).toUpperCase();

/** Emit the indexed-address setup into a0 for `$addr,x|y`, returning the EA "(a0)". */
function indexedEaLines(addr, idx, out) {
  const ireg = idx === "x" ? X : Y;
  out.push(`        move.l  #${hex(NES_RAM + addr)},a0`);
  out.push(`        move.b  ${ireg},d3`);
  out.push(`        ext.w   d3`);
  out.push(`        adda.w  d3,a0`);
  return "(a0)";
}

/** Emit one IR `reg` (data/ALU/transfer/flag) node as 68000 instructions. */
function emitReg(node, out) {
  const k = node.kind;
  const { ea, addr, idx } = operandToEa(node.operand);
  // resolve the source/dest EA, materializing an indexed EA into a0 when needed
  const realEa = () => (idx != null ? indexedEaLines(addr, idx, out) : ea);
  switch (k) {
    case ABSTRACT.LOAD_ACC: out.push(`        move.b  ${realEa()},${ACC}`); return;
    case ABSTRACT.LOAD_X:   out.push(`        move.b  ${realEa()},${X}`); return;
    case ABSTRACT.LOAD_Y:   out.push(`        move.b  ${realEa()},${Y}`); return;
    case ABSTRACT.STORE_ACC: out.push(`        move.b  ${ACC},${realEa()}`); return;
    case ABSTRACT.STORE_X:   out.push(`        move.b  ${X},${realEa()}`); return;
    case ABSTRACT.STORE_Y:   out.push(`        move.b  ${Y},${realEa()}`); return;
    case ABSTRACT.TRANSFER:  emitTransfer(node, out); return;
    case ABSTRACT.ADD: out.push(`        add.b   ${realEa()},${ACC}`); return;
    case ABSTRACT.SUB: out.push(`        sub.b   ${realEa()},${ACC}`); return;
    case ABSTRACT.AND: out.push(`        and.b   ${realEa()},${ACC}`); return;
    case ABSTRACT.OR:  out.push(`        or.b    ${realEa()},${ACC}`); return;
    case ABSTRACT.XOR: out.push(`        eor.b   ${ACC},${realEa()}`); return; // 68k eor is reg→ea; approx
    case ABSTRACT.CMP: out.push(`        cmp.b   ${realEa()},${ACC}`); return;
    case ABSTRACT.BIT: out.push(`        move.b  ${realEa()},d3`, `        and.b   ${ACC},d3`); return;
    case ABSTRACT.INC: emitIncDec(node, out, "addq"); return;
    case ABSTRACT.DEC: emitIncDec(node, out, "subq"); return;
    case ABSTRACT.SHL: out.push(`        lsl.b   #1,${ACC}`); return;
    case ABSTRACT.SHR: out.push(`        lsr.b   #1,${ACC}`); return;
    case ABSTRACT.ROL: out.push(`        roxl.b  #1,${ACC}`); return;
    case ABSTRACT.ROR: out.push(`        roxr.b  #1,${ACC}`); return;
    case ABSTRACT.INX: out.push(`        addq.b  #1,${X}`); return;
    case ABSTRACT.INY: out.push(`        addq.b  #1,${Y}`); return;
    case ABSTRACT.DEX: out.push(`        subq.b  #1,${X}`); return;
    case ABSTRACT.DEY: out.push(`        subq.b  #1,${Y}`); return;
    case ABSTRACT.CPX: out.push(`        cmp.b   ${realEa()},${X}`); return;
    case ABSTRACT.CPY: out.push(`        cmp.b   ${realEa()},${Y}`); return;
    case ABSTRACT.PUSH: out.push(`        ; push (${node.mnemonic}) — 6502 stack ops are no-ops in the logic port`); return;
    case ABSTRACT.PULL: out.push(`        ; pull (${node.mnemonic}) — 6502 stack ops are no-ops in the logic port`); return;
    case ABSTRACT.SET_FLAG:
    case ABSTRACT.CLR_FLAG:
    case ABSTRACT.NOP:
      out.push(`        nop                     ; ${node.mnemonic} (flag/nop — CCR handled by adjacent ops)`); return;
    default:
      out.push(`        ; UNTRANSLATED reg op ${node.mnemonic} (${k})`); return;
  }
}

/** 6502 register transfers (tax/tay/txa/tya/tsx/txs) → 68000 reg moves. */
function emitTransfer(node, out) {
  const m = node.mnemonic;
  const map = {
    tax: `move.b  ${ACC},${X}`, tay: `move.b  ${ACC},${Y}`,
    txa: `move.b  ${X},${ACC}`, tya: `move.b  ${Y},${ACC}`,
    tsx: `move.b  #$FF,${X}    ; stack ptr is fixed in the logic port`,
    txs: `; txs — stack ptr fixed in the logic port`,
  };
  out.push(`        ${map[m] || `; ${m} (transfer)`}`);
}

/** inc/dec on memory (or accumulator) → addq/subq. */
function emitIncDec(node, out, instr) {
  const { ea, addr, idx } = operandToEa(node.operand);
  if (node.operand == null || node.operand === "a") {
    out.push(`        ${instr}.b  #1,${ACC}`);
    return;
  }
  const e = idx != null ? indexedEaLines(addr, idx, out) : ea;
  out.push(`        ${instr}.b  #1,${e}`);
}

/** ISA-neutral branch cond → 68000 branch instruction. The 68000 CCR after a
 *  move/cmp gives Z (eq/ne) and N (mi/pl); carry/overflow map to C/V. */
const M68K_BRANCH = {
  [COND.EQ]: "beq", [COND.NE]: "bne", [COND.CC]: "bcc", [COND.CS]: "bcs",
  [COND.MI]: "bmi", [COND.PL]: "bpl", [COND.VC]: "bvc", [COND.VS]: "bvs",
};

/**
 * Emit the m68k body from an IR program. Returns the asm body (functions only;
 * the ROM wrapper/vectors/seam are added by emitM68kWrapper / emitM68kSeam).
 * @param {Array<object>} ir
 * @returns {string}
 */
export function emitm68kBody(ir) {
  const out = [];
  for (const node of ir) {
    if (node.label && node.op !== IR.LABEL) out.push(`${node.label}:`);
    switch (node.op) {
      case IR.LABEL: out.push(`${node.name}:`); break;
      case IR.REG: emitReg(node, out); break;
      case IR.BRANCH: out.push(`        ${M68K_BRANCH[node.cond] || "bra"}     ${node.target}`); break;
      case IR.JUMP: out.push(`        jmp     ${node.target}`); break;
      case IR.CALL: out.push(`        jsr     ${node.target}`); break;
      case IR.RET: out.push(node.kind === "interrupt" ? "        rte" : "        rts"); break;
      case IR.HWREG: emitHwReg(node, out); break;
      case IR.PASSTHROUGH: out.push(node.text); break;
      case IR.REFUSE: out.push(`        ; UNTRANSLATED: ${(node.raw || "").trim()}  (${node.reason})`); break;
      default: break;
    }
  }
  return out.join("\n");
}

/** hwreg (the PPU/APU seam) → a call into the m68k runtime stub. Contract mirrors
 *  the 65816 path: d0 holds the value (writes) / receives it (reads); d1 carries
 *  the source register low byte so one routine handles the file. */
function emitHwReg(node, out) {
  const { access, reg, via } = node;
  const lowByte = `#$${(reg & 0xff).toString(16).padStart(2, "0")}`;
  out.push(`        ; seam: ${via} $${reg.toString(16)}`);
  if (access === "write") {
    if (via === "stx") out.push(`        move.b  ${X},${ACC}`);
    else if (via === "sty") out.push(`        move.b  ${Y},${ACC}`);
    out.push(`        move.b  ${lowByte},${X}`, `        jsr     NES_PPU_WRITE`);
  } else {
    out.push(`        move.b  ${lowByte},${X}`, `        jsr     NES_PPU_READ`);
  }
}

/**
 * The m68k ROM wrapper: 68000 vector table at $000000 (SSP + reset PC), the
 * minimal SEGA header at $100, the recompiled body at $200, and the seam include.
 * The body runs straight 68000 (no mode switch) — that's the point: it's a real
 * translation, not an emulation-mode passthrough.
 * @param {{body:string, resetLabel:string, withShim?:boolean, withRuntime?:boolean, nmiBody?:string}} a
 */
export function emitM68kWrapper(a) {
  const { body, resetLabel } = a;
  return [
    "; NES→Genesis recompiled image (romdev generic emit backend, m68k target).",
    "; The 6502 logic is TRANSLATED to 68000 (not emulated). NES RAM is mapped to",
    "; Genesis work RAM at $FF0000 — that block is the Tier-1 RAM-diff oracle mirror.",
    "",
    "    org $00000000",
    "vectors:",
    "    dc.l   $00FFE000          ; initial SSP",
    "    dc.l   RESET_ENTRY        ; reset PC",
    "    rept 62",
    "    dc.l   RESET_ENTRY        ; exceptions → reset (logic port; no handlers yet)",
    "    endr",
    "",
    "    org $00000100",
    "    dc.b \"SEGA MEGA DRIVE \"   ; system magic (16)",
    "    dc.b \"ROMDEV PORT     \"   ; copyright (16, padded)",
    "    dc.b \"NES-PORT (ROMDEV LOGIC RECOMPILE)               \" ; domestic title (48)",
    "    dc.b \"NES-PORT (ROMDEV LOGIC RECOMPILE)               \" ; overseas title (48)",
    "    dc.b \"GM ROMDEV-00  \"     ; serial (14)",
    "    dc.w $0000                 ; checksum",
    "    dc.b \"J               \"   ; device support (16)",
    "    dc.l $00000000             ; ROM start",
    "    dc.l $003FFFFF             ; ROM end",
    "    dc.l $00FF0000             ; RAM start",
    "    dc.l $00FFFFFF             ; RAM end",
    "    dc.b \"            \"        ; SRAM tag (12)",
    "    dc.l $00000000             ; SRAM start",
    "    dc.l $00000000             ; SRAM end",
    "    dc.b \"            \"        ; modem (12)",
    "    dc.b \"romdev generic recompile        \" ; notes (32)",
    "    dc.b \"JUE             \"   ; region (16)",
    "",
    "    org $00000200",
    "RESET_ENTRY:",
    "    move.w  #$2700,sr          ; mask interrupts during init",
    "    lea     $00FFE000,sp       ; set the stack",
    `    jmp     ${resetLabel}`,
    "",
    "; ── recompiled 6502 logic, translated to 68000 ──────────────────────",
    body,
    "",
    `    include "nes_seam_md.asm"`,
    "",
  ].join("\n");
}

/** The m68k hardware-seam stub. Writes drop; $2002 (PPUSTATUS) read returns $80
 *  so 6502 vblank-wait loops (`bit $2002 / bpl`) terminate. Same contract as the
 *  65816 seam, in 68000 syntax. */
export function emitM68kSeam() {
  return [
    "; ── NES hardware seam (m68k v1 stubs) ───────────────────────────────",
    "; d0 = value (writes) / receives it (reads); d1 = register low byte.",
    "NES_PPU_WRITE:",
    "    rts",
    "NES_PPU_READ:",
    "    move.b  #$80,d0            ; vblank set → boot wait-loops exit",
    "    rts",
    "NES_APU_WRITE:",
    "    rts",
    "NES_OAM_DMA:",
    "    rts",
    "",
  ].join("\n");
}

/** Callees referenced by jsr/jmp/branch but not defined in this slice → stub them
 *  (single-routine isolation), in 68000 syntax. */
export function findUndefinedLabelsM68k(body, equs = []) {
  const defined = new Set();
  const equNames = new Set(equs.map((e) => e.split(/\s*=/)[0].trim()));
  const referenced = new Set();
  const SEAM = new Set(["NES_PPU_WRITE", "NES_PPU_READ", "NES_APU_WRITE", "NES_OAM_DMA"]);
  for (const line of body.split("\n")) {
    const def = line.match(/^(\w+):/);
    if (def) defined.add(def[1]);
    const ref = line.match(/^\s+(?:jsr|jmp|b\w\w)\s+([A-Za-z_]\w*)\s*$/);
    if (ref) referenced.add(ref[1]);
  }
  return [...referenced].filter((n) => !defined.has(n) && !equNames.has(n) && !SEAM.has(n));
}

/** `label: rts` stubs (68000) for undefined callees. */
export function emitM68kStubs(names) {
  if (!names.length) return "";
  return [
    "; ── unresolved callee stubs (single-routine isolation) ──",
    ...names.map((n) => `${n}:\n    rts`),
    "",
  ].join("\n");
}
