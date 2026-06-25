// IR → 65816 (SNES asar) emitter. The 65816 boots in 6502 EMULATION mode, so a
// 6502-sourced IR is "near-1:1": reg/branch/jump/call/return nodes re-emit the
// original mnemonic verbatim, and hwreg (the MMIO seam) becomes a call into the
// NES-PPU-on-SNES runtime. This emitter reproduces the byte-for-byte body the
// original monolithic recompile-65816 produced — it's the same output, reached
// through the generic IR so OTHER source ISAs (whose lifters emit the same IR)
// could target 65816 too, and so 6502 can target OTHER CPUs via a different emitter.
//
// Plain JS ESM + JSDoc.

import { IR } from "./ir.js";
import { NES_REGISTERS } from "../../platforms/common/registers.js";

/** The native 6502 mnemonic for each IR `reg` node is carried on the node itself
 *  (node.mnemonic); for 65816 emulation mode we re-emit it unchanged. */
function emitRegNode(node) {
  const { mnemonic, operand } = node;
  return `        ${mnemonic}${operand ? "     " + operand : ""}`;
}

/** Emit the seam call(s) for one hwreg access — identical to the original
 *  emitSeamAccess: A holds the value (writes) / receives it (reads); the register
 *  low byte goes in X so one seam routine handles the whole file. */
function emitHwReg(node) {
  const { access, reg, via } = node;
  const regName = NES_REGISTERS[reg] || `REG_${reg.toString(16)}`;
  const lowByte = `#$${(reg & 0xff).toString(16).padStart(2, "0")}`;
  const lines = [`        ; seam: ${via} $${reg.toString(16)} (${regName})`];
  if (access === "write") {
    if (via === "sta") {
      lines.push(`        ldx     ${lowByte}`, `        jsr     NES_PPU_WRITE`);
    } else { // stx / sty
      lines.push(`        txa`, `        ldx     ${lowByte}`, `        jsr     NES_PPU_WRITE`);
    }
  } else { // read: lda / ldx / ldy / bit
    lines.push(`        ldx     ${lowByte}`, `        jsr     NES_PPU_READ`);
    if (via === "bit") lines.push(`        ; (bit set N/V from the read value)`);
  }
  return lines;
}

/**
 * Emit the 65816 body from an IR program. Returns the body text (functions only;
 * the LoROM wrapper/seam/vectors are added by the orchestrator via emitMainAsm).
 * A leading label on a node is emitted as its own `label:` line, matching the
 * original output exactly so the existing NES→SNES tests stay green.
 * @param {Array<object>} ir
 * @returns {string}
 */
export function emit65816Body(ir) {
  const out = [];
  for (const node of ir) {
    // node-level label (rides on instruction/branch/etc nodes)
    if (node.label && node.op !== IR.LABEL) out.push(`${node.label}:`);
    switch (node.op) {
      case IR.LABEL:
        out.push(`${node.name}:`);
        break;
      case IR.REG:
        out.push(emitRegNode(node));
        break;
      case IR.BRANCH:
        // 6502 branch mnemonics ARE valid 65816 — re-emit verbatim. node.raw holds
        // the original "bne L8016"; recover the mnemonic from it for fidelity.
        out.push(`        ${branchMnemonic(node)}     ${node.target}`);
        break;
      case IR.JUMP:
        out.push(`        jmp     ${node.target}`);
        break;
      case IR.CALL:
        out.push(`        jsr     ${node.target}`);
        break;
      case IR.RET:
        out.push(node.kind === "interrupt" ? "        rti" : "        rts");
        break;
      case IR.HWREG:
        out.push(...emitHwReg(node));
        break;
      case IR.PASSTHROUGH:
        out.push(node.text);
        break;
      case IR.REFUSE:
        // Visible marker so the asm still SHOWS where logic was dropped (residue
        // is also reported structurally by the orchestrator).
        out.push(`        ; UNTRANSLATED: ${(node.raw || "").trim()}  (${node.reason})`);
        break;
      default:
        break;
    }
  }
  return out.join("\n");
}

/** Recover the 6502 branch mnemonic for an IR branch node from its raw text (the
 *  cond→mnemonic map is 1:1 for 65816 emulation mode). */
function branchMnemonic(node) {
  const m = (node.raw || "").trim().match(/^[a-zA-Z_]\w*:\s*([a-z]{3})|^([a-z]{3})/);
  if (m) return (m[1] || m[2]);
  // fall back from the ISA-neutral cond
  return { eq: "beq", ne: "bne", cc: "bcc", cs: "bcs", mi: "bmi", pl: "bpl", vc: "bvc", vs: "bvs" }[node.cond] || "bne";
}

/** This emitter's target ISA + a human label (for the registry + diagnostics). */
export const TARGET_ISA = "65816";
export const TARGET_PLATFORM = "snes";
