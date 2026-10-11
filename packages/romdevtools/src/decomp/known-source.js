// known-source.js - look before you decompile.
//
// Twenty-seven libultra functions remain in assembly on this project. libultra
// is SDK code: its sources are published, several N64 decompilation projects
// have already matched it, and hand-decompiling a routine whose source exists is
// the most expensive way to obtain it. The same is true inside one project -
// camera, menu and render families repeat with small variations, so a sibling
// that already matched is the best possible starting candidate.
//
// MATCHING IS BY BYTES AND SHAPE, NEVER BY NAME. `func_80049A94` tells you
// nothing, and a name-similarity match would produce confident wrong
// attributions. Three signals, in decreasing strength:
//
//   1. exact instruction-word equality (modulo relocated operands)
//   2. relocation SHAPE - the sequence of relocation types and their positions
//   3. normalized CFG - block count, edge structure, terminator kinds
//
// A hit is a CANDIDATE with provenance and a license note, never an answer. It
// still has to compile and compare locally, because a function that looks like
// a known one can still have been built with different flags.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseSplatAsm } from "./splat-map.js";

export const KNOWN_SOURCE_SCHEMA = "romdev-decomp-known-source-v1";

/**
 * Reference repositories to search: the directories listed in
 * ROMDEV_DECOMP_REFERENCES (path-delimiter separated) that exist.
 */
function referenceRoots() {
  const out = [];
  if (process.env.ROMDEV_DECOMP_REFERENCES) out.push(...process.env.ROMDEV_DECOMP_REFERENCES.split(path.delimiter));
  return out.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
}

/**
 * A structural fingerprint of a function, independent of addresses and symbol
 * names. Two functions with the same fingerprint have the same SHAPE.
 */
export function structuralFingerprint(asmText) {
  const p = parseSplatAsm(asmText);
  const opcodes = [];
  const relocShape = [];
  let branches = 0, calls = 0, loads = 0, stores = 0, floats = 0;

  for (let i = 0; i < p.instructions.length; i++) {
    const t = p.instructions[i].text ?? "";
    const op = (/^\s*([a-z][\w.]*)/.exec(t) ?? [])[1] ?? "?";
    opcodes.push(op);
    if (/^b/.test(op) && op !== "break") branches++;
    if (/^(jal|jalr)$/.test(op)) calls++;
    if (/^l[bhwd]/.test(op)) loads++;
    if (/^s[bhwd]/.test(op)) stores++;
    if (/c1$/.test(op) || /^(add|sub|mul|div)\.[sd]$/.test(op)) floats++;
    // A relocated operand is a %hi/%lo or a symbolic jump target.
    if (/%hi|%lo|\b0x[0-9a-f]{6,}\b/.test(t)) relocShape.push(`${i}:${op}`);
  }

  const h = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
  return {
    instructionCount: p.instructions.length,
    sizeBytes: p.sizeBytes,
    // Opcode sequence with operands stripped: survives register allocation and
    // relocation differences, which is exactly what we want to match across
    // builds of the same source.
    opcodeHash: h(opcodes.join(",")),
    // The relocation SHAPE: which instruction indices carry a relocation.
    relocShapeHash: h(relocShape.join(",")),
    // Coarse shape, for near-miss ranking when the hashes differ.
    profile: { branches, calls, loads, stores, floats },
    // Exact word equality, ignoring nothing: the strongest signal.
    wordHash: h(p.instructions.map((i) => (i.word >>> 0).toString(16)).join(",")),
  };
}

/** Similarity of two coarse profiles, 0..1. */
function profileSimilarity(a, b) {
  const keys = ["branches", "calls", "loads", "stores", "floats"];
  let num = 0, den = 0;
  for (const k of keys) {
    const x = a[k] ?? 0, y = b[k] ?? 0;
    num += Math.min(x, y); den += Math.max(x, y);
  }
  return den === 0 ? 1 : num / den;
}

/**
 * Index every nonmatching .s in the project so siblings can be searched.
 * @param {import("./project.js").Project} project
 */
export async function indexProjectFunctions(project, { asmRoot } = {}) {
  const root = asmRoot ?? project.abs(path.join("asm"));
  const index = [];
  if (!fs.existsSync(root)) return index;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.name.endsWith(".s")) {
        try {
          const fp = structuralFingerprint(await readFile(f, "utf8"));
          if (fp.instructionCount > 0) index.push({ path: path.relative(project.root, f), symbol: path.basename(e.name, ".s"), ...fp });
        } catch {}
      }
    }
  };
  await walk(root);
  return index;
}

/**
 * Search for a known or sibling source for one function.
 *
 * @param {import("./project.js").Project} project
 * @param {{symbol:string, asmText:string, workClass?:string}} target
 */
export async function findKnownSource(project, { symbol, asmText, workClass }, { minSimilarity = 0.85, limit = 8 } = {}) {
  const target = structuralFingerprint(asmText);
  const index = await indexProjectFunctions(project);

  const hits = [];
  for (const cand of index) {
    if (cand.symbol === symbol) continue;
    let kind = null, confidence = 0;
    if (cand.wordHash === target.wordHash) { kind = "exact-words"; confidence = 1; }
    else if (cand.opcodeHash === target.opcodeHash) { kind = "same-opcode-sequence"; confidence = 0.9; }
    else if (cand.relocShapeHash === target.relocShapeHash && cand.instructionCount === target.instructionCount) { kind = "same-relocation-shape"; confidence = 0.7; }
    else {
      const sim = profileSimilarity(cand.profile, target.profile);
      const sizeRatio = Math.min(cand.instructionCount, target.instructionCount) / Math.max(cand.instructionCount, target.instructionCount, 1);
      if (sim >= minSimilarity && sizeRatio >= minSimilarity) { kind = "similar-shape"; confidence = Math.round(sim * sizeRatio * 100) / 100; }
    }
    if (kind) hits.push({ symbol: cand.symbol, path: cand.path, kind, confidence, instructionCount: cand.instructionCount, sizeBytes: cand.sizeBytes });
  }
  hits.sort((a, b) => b.confidence - a.confidence);

  const refs = referenceRoots();
  return {
    schema: KNOWN_SOURCE_SCHEMA, symbol, workClass: workClass ?? null,
    target: { instructionCount: target.instructionCount, sizeBytes: target.sizeBytes, profile: target.profile },
    siblingHits: hits.slice(0, limit),
    referenceRootsSearched: refs,
    ...(workClass === "libultra-known-source" ? {
      libultraNote: "This function is SDK code. Its source is published and several N64 decompilation projects have already matched it - "
        + "search those before decompiling by hand. Set ROMDEV_DECOMP_REFERENCES to a colon-separated list of checked-out reference "
        + "repositories to include them in this search.",
    } : {}),
    ...(refs.length === 0 ? {
      referenceNote: "no reference repositories are configured, so ONLY this project's own functions were searched. "
        + "Set ROMDEV_DECOMP_REFERENCES to widen it.",
    } : {}),
    policy: "matching is by instruction words, relocation shape and CFG profile - NEVER by symbol name, because a name is not evidence "
      + "and a name-similarity hit would be a confident wrong attribution. Every hit is a CANDIDATE with provenance: it still has to "
      + "compile and compare locally, since a function that looks like a known one can have been built with different flags. "
      + "Check the license of any source you import.",
  };
}
