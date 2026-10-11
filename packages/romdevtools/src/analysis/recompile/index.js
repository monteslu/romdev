// Generic recompile orchestrator - the source/target-agnostic port engine.
//
// recompile(sourceAsm, {source, target}) wires LIFT (source ISA → IR) → EMIT (IR
// → target ISA) through a registry. Adding a platform PAIR is one lifter + one
// emitter; the orchestrator, IR, residue handling, callee-stubbing, and the
// disasm-tool wiring are all shared. NES→SNES and NES→Genesis go through the SAME
// code path here - the only difference is which emitter the registry hands back.
//
// An EMITTER is an object: {
//   targetPlatform, targetIsa,
//   emitBody(ir) → string,                       // IR functions → target asm body
//   emitWrapper({ body, entry, ... }) → string,  // ROM wrapper (vectors, preamble)
//   emitSeam() → string,                         // the hardware-seam stub include
//   seamFile,                                    // include filename for the seam
//   findUndefinedLabels(body, equs) → string[],  // callees to stub (target syntax)
//   emitStubs(names) → string,                   // `label: ret` stubs (target syntax)
// }
// A LIFTER is: lift(sourceAsm) → { ir, equs, instrCount, seamCount, entry }.
//
// ── NOTE FOR A FUTURE WASM/WAT BACKEND ─────────────────────────────────────
// Every emitter here targets ASSEMBLY (65816, m68k), so this does not bite
// today - but it will the moment someone adds a WASM backend, and it is a
// measured result rather than a guess (reported from a shipped SMS→WAT
// recompiler):
//
//   A single wasm function with ~3,800 nested blocks and a ~3,800-entry
//   `br_table` blows V8's COMPILER ZONE - an OOM inside the zone allocator
//   that `--max-old-space-size` does nothing about, because the zone is not
//   the JS heap. ~1,070 arms was fine.
//
// The whole-function dispatch loop (one br_table arm per basic block) is the
// natural shape for a recompiler and walks straight into this. Shard the
// dispatch into several functions of a few hundred arms each.
//
// Plain JS ESM + JSDoc.

import { collectResidue } from "./ir.js";
import { lift6502 } from "./lift-6502.js";
import { liftZ80 } from "./lift-z80.js";
import { emit65816Body } from "./emit-65816.js";
import {
  emitMainAsm as emit65816Wrapper, emitSeam as emit65816Seam,
  findUndefinedLabels, emitStubs,
} from "../recompile-65816.js";
import {
  emitm68kBody, emitM68kWrapper, emitM68kSeam, findUndefinedLabelsM68k, emitM68kStubs,
} from "./emit-m68k.js";
import { emit65816FromZ80Body, emitZ80SeamAsm } from "./emit-65816-from-z80.js";

/** source ISA / platform → lifter. (gg/gbc/md aliases map to their base ISA.) */
/** Source platform -> the ISA its lifter produces IR from. An emitter accepts
 *  or rejects a pairing on the ISA, not the platform name, so adding a fifth
 *  Z80 machine needs no emitter change. */
export const SOURCE_ISA = {
  nes: "6502", "6502": "6502",
  sms: "z80", gg: "z80", msx: "z80", z80: "z80",
};

const LIFTERS = {
  nes: lift6502, "6502": lift6502,
  // One Z80 lifter serves FOUR platforms: Master System, Game Gear, MSX, and
  // the Genesis sound CPU. They share the ISA and differ only at the hardware
  // seam, which the IR already keeps separate (irHwReg).
  sms: liftZ80, gg: liftZ80, msx: liftZ80, z80: liftZ80,
  // future: gb → lift-sm83; genesis (68000) → lift-m68k; etc.
};

/** target platform → emitter object. */
const EMITTERS = {
  snes: {
    targetPlatform: "snes", targetIsa: "65816",
    // WHICH SOURCE ISAs this emitter can actually translate.
    //
    // 65816 emulation mode IS a 6502, so a 6502-sourced IR re-emits its
    // mnemonics verbatim and assembles. That is the emitter's whole design --
    // and it means any OTHER source ISA passes through as text the assembler
    // has never heard of (`dec b`, `ld a,(hl)`, `ret label`), producing a file
    // that looks plausible and cannot build. Declaring the accepted sources is
    // what turns that from a silent miscompile into an explicit error.
    sourceIsas: ["6502"],
    emitBody: emit65816Body,
    emitWrapper: (a) => emit65816Wrapper(a),
    emitSeam: emit65816Seam,
    seamFile: "nes_seam.asm",
    findUndefinedLabels,
    emitStubs,
  },
  genesis: {
    targetPlatform: "genesis", targetIsa: "m68k",
    // Translates the ABSTRACT ops, but its operand handling assumes 6502
    // addressing modes, so it is 6502-sourced for now too.
    sourceIsas: ["6502"],
    emitBody: emitm68kBody,
    emitWrapper: (a) => emitM68kWrapper(a),
    emitSeam: emitM68kSeam,
    seamFile: "nes_seam_md.asm",
    findUndefinedLabels: findUndefinedLabelsM68k,
    emitStubs: emitM68kStubs,
  },
};

/** Resolve a source platform/ISA to its lifter, or throw with the supported set. */
function resolveLifter(source) {
  const f = LIFTERS[source];
  if (!f) throw new Error(`recompile: no lifter for source '${source}'. Supported sources: ${Object.keys(LIFTERS).filter((k) => k.length > 4 || /^[a-z]/.test(k)).join(", ")}.`);
  return f;
}

/** Resolve a target platform to its emitter, or throw with the supported set. */
/**
 * Emitters that exist for ONE source ISA against a target, keyed
 * `<sourceIsa>->{target}`.
 *
 * The base EMITTERS table is keyed by target alone, which was fine while every
 * source was 6502. It stops being fine the moment two source ISAs need
 * genuinely different code for the same target: 6502→65816 is a near-1:1
 * passthrough (65816 emulation mode IS a 6502), while z80→65816 has to
 * translate every instruction and emulate the Z80 register file in direct page.
 */
const SOURCE_EMITTERS = {
  "z80->snes": {
    targetPlatform: "snes", targetIsa: "65816",
    sourceIsas: ["z80"],
    emitBody: emit65816FromZ80Body,
    emitWrapper: (a) => emit65816Wrapper({
      ...a, sourceLabel: "Z80", sourceIsaLabel: "Z80 (register file in direct page)",
      seamFile: "z80_seam.asm",
    }),
    emitSeam: emitZ80SeamAsm,
    seamFile: "z80_seam.asm",
    findUndefinedLabels,
    emitStubs,
  },
};

function resolveEmitter(target, sourceIsa) {
  const specific = SOURCE_EMITTERS[`${sourceIsa}->${target}`];
  if (specific) return specific;
  const e = EMITTERS[target];
  if (!e) throw new Error(`recompile: no emitter for target '${target}'. Supported targets: ${Object.keys(EMITTERS).join(", ")}.`);
  return e;
}

/** The supported (source → target) pairs, for tool docs + capability reporting. */
export function supportedPairs() {
  const sources = Object.keys(LIFTERS).filter((k) => !/^\d/.test(k)); // platform names, not bare ISA
  const pairs = [];
  for (const s of sources) {
    const isa = SOURCE_ISA[s] ?? s;
    for (const [t, em] of Object.entries(EMITTERS)) {
      if (s === t) continue;
      // Only list a pair the emitter can really translate. Listing every
      // cross product advertised sms→snes, which lifts fine and emits
      // unassemblable text.
      const specific = SOURCE_EMITTERS[`${isa}->${t}`];
      const use = specific ?? em;
      if (Array.isArray(use.sourceIsas) && !use.sourceIsas.includes(isa)) continue;
      pairs.push(`${s}→${t}`);
    }
  }
  return pairs;
}

/**
 * Recompile a source-CPU disassembly to a target-CPU ROM image source, generically.
 *
 * @param {string} sourceAsm   the da65/objdump disassembly of the source routine(s)
 * @param {Object} opts
 * @param {string} opts.source         source platform/ISA (e.g. 'nes')
 * @param {string} opts.target         target platform (e.g. 'snes', 'genesis')
 * @param {string} [opts.entry]        override the entry label
 * @param {boolean} [opts.stubUndefined=true]  stub callees undefined in this slice
 * @param {string} [opts.nmiSourceAsm] source disasm of the NMI handler (2nd body)
 * @param {boolean} [opts.withShim]    target-specific: include the static PPU shim
 * @param {boolean} [opts.withRuntime] target-specific: include the per-frame runtime
 * @returns {{ mainAsm, seamAsm, seamFile, residue, entry, nmiEntry, instrCount,
 *             seamCount, stubbed, source, target, targetIsa }}
 */
export function recompile(sourceAsm, opts = {}) {
  const source = opts.source || "nes";
  const target = opts.target || "snes";
  const lift = resolveLifter(source);
  const emitter = resolveEmitter(target, SOURCE_ISA[source] ?? source);

  // Refuse a pairing the emitter cannot actually translate.
  //
  // Without this the engine happily runs Z80 IR through the 65816 emitter,
  // which re-emits the SOURCE mnemonics verbatim -- correct for 6502 (65816
  // emulation mode is a 6502) and nonsense for anything else. The output looks
  // like assembly and will not build. Failing here, naming both halves, is the
  // difference between "unsupported pair" and a file that wastes an hour.
  const sourceIsa = SOURCE_ISA[source] ?? source;
  const accepted = emitter.sourceIsas;
  if (Array.isArray(accepted) && !accepted.includes(sourceIsa)) {
    throw new Error(
      `recompile: the ${emitter.targetIsa} emitter cannot translate ${sourceIsa} source `
      + `(it accepts: ${accepted.join(", ")}). The ${sourceIsa} LIFTER works -- `
      + `disasm({target:'recompile'}) will lift and report instrCount/seamCount/residue -- `
      + `but emitting ${sourceIsa}->${emitter.targetIsa} needs an emitter that translates the `
      + `abstract IR ops rather than re-emitting source mnemonics. Supported pairs: ${supportedPairs().join(", ")}.`);
  }

  // 1. LIFT the reset/body to IR.
  const lifted = lift(sourceAsm);
  const body = emitter.emitBody(lifted.ir);
  const residue = collectResidue(lifted.ir);

  // 2. Optionally LIFT a second body (the NMI handler) for the live runtime.
  let nmiBody = null;
  let nmiEntry = null;
  let nmiEqus = [];
  let nmiResidue = [];
  let nmiInstr = 0;
  let nmiSeam = 0;
  if (opts.withRuntime && opts.nmiSourceAsm) {
    const nl = lift(opts.nmiSourceAsm);
    nmiEntry = nl.entry;
    nmiEqus = nl.equs;
    nmiInstr = nl.instrCount;
    nmiSeam = nl.seamCount;
    nmiResidue = collectResidue(nl.ir);
    // de-collide the synthetic fall-through entry between the two bodies
    if (nmiEntry === "RECOMPILE_ENTRY") {
      // rename in the IR before emit so the label is unique
      for (const n of nl.ir) { if (n.op === "label" && n.name === "RECOMPILE_ENTRY") n.name = "RECOMPILE_NMI_ENTRY"; if (n.label === "RECOMPILE_ENTRY") n.label = "RECOMPILE_NMI_ENTRY"; }
      nmiEntry = "RECOMPILE_NMI_ENTRY";
    }
    nmiBody = emitter.emitBody(nl.ir);
  }

  // 3. equs (address aliases) - union, de-duped, emitted once in the reset prefix.
  const seen = new Set();
  const allEqus = [...lifted.equs, ...nmiEqus].filter((e) => {
    const name = e.split(/\s*=/)[0].trim();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const fullBody = (allEqus.length ? allEqus.join("\n") + "\n" : "") + body;
  const entry = opts.entry || lifted.entry || "RECOMPILE_ENTRY";

  // 4. Stub callees undefined across BOTH bodies (isolation), in target syntax.
  const stubUndefined = opts.stubUndefined !== false;
  const combined = fullBody + (nmiBody ? "\n" + nmiBody : "");
  const stubbed = stubUndefined ? emitter.findUndefinedLabels(combined, allEqus) : [];
  const withStubs = fullBody + (stubbed.length ? "\n" + emitter.emitStubs(stubbed) : "");

  // 5. Wrap into the target ROM image.
  const mainAsm = emitter.emitWrapper({
    body: withStubs,
    resetLabel: entry,
    withShim: !!opts.withShim,
    withRuntime: !!opts.withRuntime,
    nmiBody,
  });
  const seamAsm = emitter.emitSeam();

  // BANK BUDGET. Cross-ISA translation EXPANDS: a Z80 instruction becomes
  // several 65816 ones (a 16-bit pair op is a rep/op/sep sandwich), measured at
  // roughly 5x. A 65816 bank is 32KB, so a slice that looks modest in source
  // bytes can overflow one bank and the assembler reports a raw
  // `Ebank_border_crossed` that says nothing about WHY. Estimating the emitted
  // size here lets the caller see the limit before the assembler does.
  const emittedBytes = estimateEmittedBytes(mainAsm);
  const BANK_BYTES = 0x8000;
  const bankBudget = {
    estimatedBytes: emittedBytes,
    bankBytes: BANK_BYTES,
    fitsOneBank: emittedBytes <= BANK_BYTES,
    ...(emittedBytes > BANK_BYTES ? {
      warning: `the translated body is roughly ${emittedBytes} bytes, past the ${BANK_BYTES}-byte ${emitter.targetIsa} bank. `
        + "Cross-ISA translation expands (about 5x for z80->65816), so a slice that looks small in source bytes can overflow a bank. "
        + "Recompile a SMALLER region, or split the output across banks - the assembler's own error for this "
        + "(Ebank_border_crossed) does not say why it happened.",
    } : {}),
  };

  return {
    mainAsm, seamAsm, seamFile: emitter.seamFile,
    residue: [...residue, ...nmiResidue],
    entry, nmiEntry,
    instrCount: lifted.instrCount + nmiInstr,
    seamCount: lifted.seamCount + nmiSeam,
    stubbed, bankBudget,
    source, target, targetIsa: emitter.targetIsa,
  };
}

/**
 * Rough emitted size of an assembly body, for the bank-budget check.
 *
 * Counts instruction lines only - labels, comments and directives occupy no
 * space. Sizes are approximate per-instruction averages, which is enough to
 * tell "comfortably inside a bank" from "past it"; the assembler remains the
 * authority on the exact number.
 */
function estimateEmittedBytes(asm) {
  let bytes = 0;
  for (const raw of String(asm ?? "").split("\n")) {
    const line = raw.replace(/;.*$/, "").trim();
    if (!line || line.endsWith(":") || line.startsWith(".") || /^(org|lorom|hirom|incsrc|dw|db)\b/i.test(line)) continue;
    const op = (/^([a-z]+)/i.exec(line) ?? [])[1]?.toLowerCase() ?? "";
    // brl/jmp/jsr are 3; rep/sep and immediates 2; the rest average ~2.5.
    bytes += /^(brl|jmp|jsr|jml|jsl)$/.test(op) ? 3
      : /^(rep|sep)$/.test(op) ? 2
      : /^(nop|rts|rti|txs|xce|sec|clc|sei|cli|pha|pla|phx|plx)$/.test(op) ? 1
      : 3;
  }
  return bytes;
}
