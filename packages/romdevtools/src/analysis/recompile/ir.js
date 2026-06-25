// Generic recompile IR — the spine of the source/target-agnostic port engine.
//
// The port engine has two halves: a LIFTER turns one source-CPU instruction into
// IR node(s); an EMITTER turns IR node(s) into target-CPU assembly. Adding a
// platform PAIR is then one lifter + one emitter (registered by ISA name), not an
// N×N matrix of hand-written transpilers. NES→SNES is the first pair; the IR is
// what lets NES→Genesis (and any other pair whose ISAs have a lifter+emitter)
// reuse the SAME pipeline instead of a second bespoke recompiler.
//
// DESIGN PRINCIPLE: the IR is DELIBERATELY SMALL and HONEST. It models only the
// instruction classes a mechanical port actually needs, and REFUSES (rather than
// guesses) anything whose semantics don't carry across ISAs. A refused node is
// surfaced as residue, never silently mistranslated — the same contract the
// original 6502→65816 recompiler held. We are NOT building a full optimizing
// compiler IR (SSA, types, dataflow); we're building a normalized transfer format
// for "this instruction loads/stores/branches/calls/touches-hardware".
//
// IR node shape (a plain object; `op` is the discriminant):
//   { op:'label',   name }                              — a code label / branch target
//   { op:'reg',     mnemonic, operand, raw }            — a register/ALU op that maps
//        1:1 across the source & target's compatible register file. `kind` tags the
//        abstract operation so an emitter that ISN'T 1:1 can translate it.
//   { op:'load',    reg, addr, mode }                   — reg ← mem
//   { op:'store',   reg, addr, mode }                   — mem ← reg
//   { op:'alu',     fn, reg, operand, mode }            — reg = reg fn operand
//   { op:'branch',  cond, target }                      — conditional relative branch
//   { op:'jump',    target }                            — unconditional jump
//   { op:'call',    target }                            — subroutine call (push return)
//   { op:'ret',     kind:'sub'|'interrupt' }            — return
//   { op:'hwreg',   access:'read'|'write', reg, addr, via } — a hardware-MMIO access
//        (the "seam"): the target can't do the source's MMIO, so this becomes a
//        call into the target's runtime shim. `reg` is the source register-file
//        address (e.g. NES $2000); `via` is the CPU register carrying the value.
//   { op:'passthrough', text, raw }                     — emitter writes `text` as-is
//        (used by a 1:1 emitter where the source mnemonic IS a valid target mnemonic)
//   { op:'refuse',  reason, raw }                       — not mechanically translatable;
//        becomes residue. NEVER emitted as code.
//
// Every node may carry `label` (a leading code label) and `addr` (the source CPU
// address, for diagnostics). Plain JS ESM + JSDoc.

/** The IR op discriminants. */
export const IR = Object.freeze({
  LABEL: "label",
  REG: "reg",
  LOAD: "load",
  STORE: "store",
  ALU: "alu",
  BRANCH: "branch",
  JUMP: "jump",
  CALL: "call",
  RET: "ret",
  HWREG: "hwreg",
  PASSTHROUGH: "passthrough",
  REFUSE: "refuse",
});

/**
 * Abstract operation kinds an emitter can switch on when it ISN'T a 1:1 textual
 * passthrough (e.g. emitting m68k from 6502, where `lda`→`move.b` and the named
 * 8-bit accumulator becomes a chosen data register). A lifter tags each `reg`/
 * `alu`/`load`/`store`/`branch` node with one of these so the emitter never has
 * to know the SOURCE mnemonic — only the abstract intent.
 */
export const ABSTRACT = Object.freeze({
  // data movement
  LOAD_ACC: "load_acc", LOAD_X: "load_x", LOAD_Y: "load_y",
  STORE_ACC: "store_acc", STORE_X: "store_x", STORE_Y: "store_y",
  TRANSFER: "transfer",
  PUSH: "push", PULL: "pull",
  // arithmetic / logic (on the accumulator unless noted)
  ADD: "add", SUB: "sub", AND: "and", OR: "or", XOR: "xor",
  INC: "inc", DEC: "dec", SHL: "shl", SHR: "shr", ROL: "rol", ROR: "ror",
  CMP: "cmp", BIT: "bit",
  // index reg inc/dec/compare
  INX: "inx", INY: "iny", DEX: "dex", DEY: "dey",
  CPX: "cpx", CPY: "cpy",
  // flags / nop
  SET_FLAG: "set_flag", CLR_FLAG: "clr_flag", NOP: "nop",
});

/** Branch conditions (ISA-neutral). A lifter maps its native branches onto these;
 *  an emitter maps these onto the target's branch instructions. */
export const COND = Object.freeze({
  EQ: "eq", NE: "ne", CC: "cc", CS: "cs", // zero/carry
  MI: "mi", PL: "pl", VC: "vc", VS: "vs", // sign/overflow
  ALWAYS: "always",
});

// ── node constructors (keep call sites terse + consistent) ──────────────────
export const irLabel = (name) => ({ op: IR.LABEL, name });
export const irPassthrough = (text, raw, label) => ({ op: IR.PASSTHROUGH, text, raw, label });
export const irRefuse = (reason, raw, label) => ({ op: IR.REFUSE, reason, raw, label });
export const irReg = (kind, mnemonic, operand, raw, label) => ({ op: IR.REG, kind, mnemonic, operand, raw, label });
export const irBranch = (cond, target, raw, label) => ({ op: IR.BRANCH, cond, target, raw, label });
export const irJump = (target, raw, label) => ({ op: IR.JUMP, target, raw, label });
export const irCall = (target, raw, label) => ({ op: IR.CALL, target, raw, label });
export const irRet = (kind, raw, label) => ({ op: IR.RET, kind, raw, label });
export const irHwReg = (access, reg, via, raw, label) => ({ op: IR.HWREG, access, reg, via, raw, label });

/**
 * Validate an IR program (array of nodes) — a cheap structural check so a buggy
 * lifter fails loudly here, not deep in an emitter. Returns the array unchanged
 * or throws. Not a type system; just a guard that every node has a known `op`.
 * @param {Array<object>} nodes
 */
export function validateIR(nodes) {
  if (!Array.isArray(nodes)) throw new Error("IR program must be an array of nodes");
  const ops = new Set(Object.values(IR));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n !== "object" || !ops.has(n.op)) {
      throw new Error(`IR node ${i} has an unknown op: ${JSON.stringify(n)}`);
    }
  }
  return nodes;
}

/** Collect the residue (refused nodes) from an IR program — what the engine
 *  could NOT mechanically translate, surfaced to the caller instead of guessed. */
export function collectResidue(nodes) {
  return nodes.filter((n) => n.op === IR.REFUSE).map((n) => ({ reason: n.reason, line: (n.raw || "").trim() }));
}
