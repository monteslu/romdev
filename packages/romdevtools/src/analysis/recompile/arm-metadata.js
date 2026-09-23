// ARM7TDMI (GBA) metadata over the EXISTING binutils ARM decoder - not a
// second decoder, and not a hand-authored table.
//
// CYCLE PROVENANCE - READ THIS BEFORE TRUSTING A NUMBER HERE.
//
// There is NO extractable per-opcode cycle table in mGBA, and this module does
// not pretend otherwise. I looked: src/arm/isa-arm.c builds every instruction
// through DEFINE_INSTRUCTION_ARM, which opens with
//
//     int currentCycles = ARM_PREFETCH_CYCLES;
//
// and ARM_PREFETCH_CYCLES is `(1 + cpu->memory.activeSeqCycles32)`
// (include/mgba/internal/arm/isa-arm.h:13) - a RUNTIME value read from
// cpu->memory, not a constant. Loads and stores then add
//
//     currentCycles += cpu->memory.activeNonseqCycles32
//                    - cpu->memory.activeSeqCycles32;
//
// (ARM_LOAD_POST_BODY / ARM_STORE_POST_BODY), a PC write adds
// `2 + activeNonseqCycles32 + activeSeqCycles32` (ARMWritePC, isa-inlines.h:80),
// and multiplies add 1-4 internal cycles chosen by the RUN-TIME VALUE of the
// multiplier operand (ARM_WAIT_SMUL / ARM_WAIT_UMUL, isa-inlines.h:40/55).
//
// So an ARM7TDMI instruction's cost is a function of (a) which memory region
// the instruction and its operand live in, (b) the WAITCNT register's current
// value, and (c) for multiplies, actual register contents. None of the three
// is knowable from the opcode word, which is exactly why mGBA has no table to
// extract. Emitting a fabricated per-opcode table and calling it "extracted
// from mGBA" would be a lie about provenance.
//
// This is the same situation as the 65816/snes9x, which the exporter already
// handles by returning null from `cycles` and recording the accounting model
// in provenance instead. That is what happens here: `armCycles` returns null,
// and the S/N/I model plus the waitstate tables below are what a recompiler
// uses to compute a real cost at lowering time.
//
// The tables below ARE extracted - verbatim from mGBA src/gba/memory.c:58-63,
// which is a real, checkable source. They are the WAITCNT-independent base
// values (what GBAMemoryInit installs before any WAITCNT write).

/**
 * ARM7TDMI cycle-type model, as ARM's own documentation names the three types
 * and as mGBA implements them:
 *   S (sequential)     - a fetch from the address after the previous one
 *   N (non-sequential) - a fetch at a newly-computed address
 *   I (internal)       - a cycle with no bus access (shifts by register,
 *                        multiply iterations, ...)
 * Every instruction's cost is some (nS + mN + pI) with the S/N charged at the
 * waitstate of the region being touched.
 */
export const ARM_CYCLE_TYPES = Object.freeze({ S: "sequential", N: "non-sequential", I: "internal" });

/**
 * Base waitstates by memory region (address bits 27..24), VERBATIM from
 * mGBA src/gba/memory.c. Index = region nibble: 0 BIOS, 2 EWRAM, 3 IWRAM,
 * 4 I/O, 5 palette, 6 VRAM, 7 OAM, 8-D ROM mirrors, E-F SRAM.
 *
 * These are the values GBAMemoryInit writes before the game touches WAITCNT.
 * A game that writes WAITCNT changes the ROM rows at run time - see
 * ROM_WAITSTATES below - which is one more reason there is no static table.
 */
export const GBA_BASE_WAITSTATES_16 = Object.freeze([0, 0, 2, 0, 0, 0, 0, 0, 4, 4, 4, 4, 4, 4, 4, 0]);
export const GBA_BASE_WAITSTATES_32 = Object.freeze([0, 0, 5, 0, 0, 1, 1, 0, 7, 7, 9, 9, 13, 13, 9, 0]);
export const GBA_BASE_WAITSTATES_SEQ_16 = Object.freeze([0, 0, 2, 0, 0, 0, 0, 0, 2, 2, 4, 4, 8, 8, 4, 0]);
export const GBA_BASE_WAITSTATES_SEQ_32 = Object.freeze([0, 0, 5, 0, 0, 1, 1, 0, 5, 5, 9, 9, 17, 17, 9, 0]);

/** WAITCNT-selected ROM waitstates, mGBA src/gba/memory.c:62-63. */
export const ROM_WAITSTATES = Object.freeze([4, 3, 2, 8]);
export const ROM_WAITSTATES_SEQ = Object.freeze([2, 1, 4, 1, 8, 1]);

/** Region nibble for a GBA address. */
export function gbaRegion(addr) { return (addr >>> 24) & 0xf; }

export const ARM_CYCLE_PROVENANCE = {
  source: "mGBA (build/mgba/src): src/arm/isa-arm.c, include/mgba/internal/arm/isa-arm.h, include/mgba/internal/arm/isa-inlines.h, src/gba/memory.c",
  unit: "ARM7TDMI cycles at 16.78MHz",
  extracted: false,
  perOpcodeTable: null,
  note:
    "NO per-opcode cycle table exists in mGBA and none is fabricated here. mGBA charges per MEMORY ACCESS at run time: every ARM instruction starts at ARM_PREFETCH_CYCLES = 1 + activeSeqCycles32 (a live value read from cpu->memory, not a constant); loads/stores add activeNonseqCycles32 - activeSeqCycles32; a PC write adds 2 + N32 + S32; and multiplies add 1-4 internal cycles selected by the RUN-TIME value of the multiplier register (ARM_WAIT_SMUL/ARM_WAIT_UMUL). Cost therefore depends on the memory region touched, the current WAITCNT, and for multiplies on register contents - none of which is a function of the opcode word. armCycles() returns null for this reason, exactly as the 65816 does against snes9x. The waitstate arrays exported by this module ARE verbatim from mGBA src/gba/memory.c:58-63 and are the base (post-GBAMemoryInit, pre-WAITCNT-write) values.",
  model: {
    kinds: "S (sequential), N (non-sequential), I (internal)",
    dataProcessing: "1S; +1I when the shift amount is in a register; +1N+1S when Rd is PC",
    ldr: "1S + 1N + 1I; +1N+1S when Rd is PC",
    str: "2N",
    ldmStm: "nS + 1N + 1I (load) / (n-1)S + 2N (store)",
    branch: "2S + 1N",
    multiply: "1S + mI where m is 1..4 by the multiplier operand's magnitude",
    reference: "ARM7TDMI Technical Reference Manual, Chapter 'Instruction Cycle Timings'; mGBA implements the same model dynamically",
  },
};

/**
 * Cycles for an ARM instruction from its opcode word alone.
 *
 * ALWAYS null, deliberately. See the provenance note: the cost is not a
 * function of the opcode. A caller must compute cost from the S/N/I model plus
 * the region actually touched, which the recompiler can do because it knows
 * the lowered addresses. Returning a plausible integer here would silently
 * make every scanline budget wrong in a way nothing would catch.
 */
export function armCycles() { return null; }

// ---------------------------------------------------------------------------
// Control flow.
//
// ARM's condition code is a SUFFIX on the mnemonic, so classification must
// strip it - but only when what remains is a real mnemonic. `b` vs `bl` vs
// `bls` (branch if lower-or-same) is the trap: naive suffix stripping turns
// `bls` into `bl` and reports a call where there is a conditional branch.
// ---------------------------------------------------------------------------

/** The 15 usable ARM condition codes ("al" is the implicit default, "nv" is
 *  deprecated but still decodes). Order matters only for the longest-match
 *  strip below. */
const CONDS = ["eq", "ne", "cs", "hs", "cc", "lo", "mi", "pl", "vs", "vc",
  "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"];

/**
 * Split an ARM mnemonic into {base, cond}.
 *
 * WHOLE-MNEMONIC FIRST. `bls`, `bl`, `blx`, `bx`, `bic`, `mls`, `mvn`, `teq`
 * all end in something that reads as a condition code. The only safe rule is:
 * if the full mnemonic is itself a known base, it has no condition suffix.
 */
const BASES = new Set([
  "b", "bl", "bx", "blx",
  "mov", "mvn", "add", "adc", "sub", "sbc", "rsb", "rsc",
  "and", "orr", "eor", "bic", "cmp", "cmn", "tst", "teq",
  "mul", "mla", "umull", "umlal", "smull", "smlal",
  "ldr", "str", "ldm", "stm", "ldrb", "strb", "ldrh", "strh",
  "ldrsb", "ldrsh", "swp", "swpb",
  "mrs", "msr", "swi", "svc", "nop",
  "ldc", "stc", "cdp", "mrc", "mcr",
  "push", "pop", "clz",
]);

export function splitCond(mnem) {
  const m = (mnem || "").toLowerCase();
  if (BASES.has(m)) return { base: m, cond: "" };
  // S-flag and byte/halfword suffixes ride OUTSIDE the condition on ARM
  // (`addeqs` is not a thing; it is `addseq`... in UAL, but binutils prints
  // pre-UAL `addseq`/`ldmiaeq` forms). Strip a trailing condition only if the
  // remainder is a known base, optionally with an 's' or an ldm/stm addressing
  // suffix still attached.
  for (const c of CONDS) {
    if (!m.endsWith(c) || m.length <= c.length) continue;
    const rest = m.slice(0, -c.length);
    if (BASES.has(rest)) return { base: rest, cond: c };
    if (rest.endsWith("s") && BASES.has(rest.slice(0, -1))) return { base: rest.slice(0, -1), cond: c };
    // ldmia / stmdb / ldmfd ... - 2-letter addressing mode after ldm/stm.
    if (/^(ldm|stm)/.test(rest) && rest.length === 5) return { base: rest.slice(0, 3), cond: c };
  }
  // No recognisable condition: strip a trailing 's'/addressing suffix only.
  if (m.endsWith("s") && BASES.has(m.slice(0, -1))) return { base: m.slice(0, -1), cond: "" };
  if (/^(ldm|stm)/.test(m) && m.length === 5) return { base: m.slice(0, 3), cond: "" };
  return { base: m, cond: "" };
}

function firstHexTarget(ops) {
  const t = /(?:^|[\s,])0x([0-9a-f]+)/i.exec(ops || "");
  return t ? [parseInt(t[1], 16)] : [];
}

/**
 * Control-flow classification for an ARM instruction.
 *
 * Returns the exporter's shape: {kind, targets, fallthrough, conditional}.
 * `kind` is one of jump / call / branch / ret / transfer / unknown.
 */
export function armControl(mnem, ops, addr, len) {
  const { base, cond } = splitCond(mnem);
  const conditional = cond !== "" && cond !== "al";
  const next = addr + len;

  // `bl` / `blx <label>` - a call. Conditional forms fall through either way.
  if (base === "bl" || base === "blx") {
    return { kind: "call", targets: firstHexTarget(ops), fallthrough: next, conditional };
  }
  // `b <label>` - unconditional jump, or a conditional branch with a suffix.
  if (base === "b") {
    return conditional
      ? { kind: "branch", targets: firstHexTarget(ops), fallthrough: next, conditional: true }
      : { kind: "jump", targets: firstHexTarget(ops), fallthrough: null, conditional: false };
  }
  // `bx lr` is the ARM return idiom; `bx <reg>` otherwise is an indirect jump
  // whose target is not statically known.
  if (base === "bx") {
    const isLr = /\blr\b|\br14\b/i.test(ops || "");
    if (isLr) return { kind: "ret", targets: [], fallthrough: conditional ? next : null, conditional };
    return { kind: "jump", targets: [], fallthrough: conditional ? next : null, conditional, indirect: true };
  }
  // WRITING PC IS A BRANCH ON ARM, and this is the case a 68k-shaped
  // classifier misses entirely. `mov pc, lr` returns; `ldr pc, [...]` is a
  // computed jump; `ldmia sp!, {..., pc}` is the standard function epilogue.
  // Treating any of them as a plain transfer makes a recompiler run straight
  // off the end of a function.
  const writesPc = /^\s*(pc|r15)\b/i.test(ops || "");
  if (base === "mov" && writesPc) {
    const fromLr = /\b(lr|r14)\b/i.test(ops || "");
    return { kind: fromLr ? "ret" : "jump", targets: [], fallthrough: conditional ? next : null, conditional, indirect: !fromLr };
  }
  if ((base === "ldr" || base === "add" || base === "sub" || base === "mvn") && writesPc) {
    return { kind: "jump", targets: [], fallthrough: conditional ? next : null, conditional, indirect: true };
  }
  // ldm/pop with pc in the register list = return.
  if ((base === "ldm" || base === "pop") && /\bpc\b/i.test(ops || "")) {
    return { kind: "ret", targets: [], fallthrough: conditional ? next : null, conditional };
  }
  // swi/svc traps to the BIOS and comes back; treat as a call with no static
  // target rather than a transfer, so a recompiler does not inline past it
  // assuming registers are untouched.
  if (base === "swi" || base === "svc") {
    return { kind: "call", targets: [], fallthrough: next, conditional, indirect: true };
  }
  return { kind: "transfer", targets: [], fallthrough: next, conditional };
}

/**
 * Is this a mnemonic we consider decoded?
 *
 * binutils prints `@ <UNDEFINED> instruction: 0x....` for a word that is not a
 * legal ARM encoding; runObjdump surfaces that as mnemonic `@`. It also emits
 * `.word`/`.short`/`.byte` where it gives up entirely. Both are data, not
 * instructions, and must NOT be given fabricated semantics.
 */
export function armDocumented(m) {
  const s = (m || "").toLowerCase();
  if (!s) return false;
  if (s === "@" || s === ".word" || s === ".short" || s === ".byte" || s === ".inst") return false;
  if (s.startsWith("undefined") || s.startsWith("bad")) return false;
  return true;
}
