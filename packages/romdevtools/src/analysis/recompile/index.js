// Generic recompile orchestrator — the source/target-agnostic port engine.
//
// recompile(sourceAsm, {source, target}) wires LIFT (source ISA → IR) → EMIT (IR
// → target ISA) through a registry. Adding a platform PAIR is one lifter + one
// emitter; the orchestrator, IR, residue handling, callee-stubbing, and the
// disasm-tool wiring are all shared. NES→SNES and NES→Genesis go through the SAME
// code path here — the only difference is which emitter the registry hands back.
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
// Plain JS ESM + JSDoc.

import { collectResidue } from "./ir.js";
import { lift6502 } from "./lift-6502.js";
import { emit65816Body } from "./emit-65816.js";
import {
  emitMainAsm as emit65816Wrapper, emitSeam as emit65816Seam,
  findUndefinedLabels, emitStubs,
} from "../recompile-65816.js";
import {
  emitm68kBody, emitM68kWrapper, emitM68kSeam, findUndefinedLabelsM68k, emitM68kStubs,
} from "./emit-m68k.js";

/** source ISA / platform → lifter. (gg/gbc/md aliases map to their base ISA.) */
const LIFTERS = {
  nes: lift6502, "6502": lift6502,
  // future: gb/sms → lift-sm83 / lift-z80; genesis → lift-m68k; etc.
};

/** target platform → emitter object. */
const EMITTERS = {
  snes: {
    targetPlatform: "snes", targetIsa: "65816",
    emitBody: emit65816Body,
    emitWrapper: (a) => emit65816Wrapper(a),
    emitSeam: emit65816Seam,
    seamFile: "nes_seam.asm",
    findUndefinedLabels,
    emitStubs,
  },
  genesis: {
    targetPlatform: "genesis", targetIsa: "m68k",
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
function resolveEmitter(target) {
  const e = EMITTERS[target];
  if (!e) throw new Error(`recompile: no emitter for target '${target}'. Supported targets: ${Object.keys(EMITTERS).join(", ")}.`);
  return e;
}

/** The supported (source → target) pairs, for tool docs + capability reporting. */
export function supportedPairs() {
  const sources = Object.keys(LIFTERS).filter((k) => !/^\d/.test(k)); // platform names, not bare ISA
  const targets = Object.keys(EMITTERS);
  const pairs = [];
  for (const s of sources) for (const t of targets) if (s !== t) pairs.push(`${s}→${t}`);
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
  const emitter = resolveEmitter(target);

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

  // 3. equs (address aliases) — union, de-duped, emitted once in the reset prefix.
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

  return {
    mainAsm, seamAsm, seamFile: emitter.seamFile,
    residue: [...residue, ...nmiResidue],
    entry, nmiEntry,
    instrCount: lifted.instrCount + nmiInstr,
    seamCount: lifted.seamCount + nmiSeam,
    stubbed,
    source, target, targetIsa: emitter.targetIsa,
  };
}
