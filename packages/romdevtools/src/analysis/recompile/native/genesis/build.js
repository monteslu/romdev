// disasm({target:'recompile', emit:'c'|'sync32', platform:'genesis'}):
// a Mega Drive ROM -> a C project (emit:'c') or a built .s32 cart
// (emit:'sync32') for the sync32 console. See index.js for the design.
//
// options:
//   profile: 'exact' (default) | 'fast'          timing profile of the blocks
//   audioQuality: 'fast' (default) | 'hq' | 'half'  gpgx's linear or band-limited resampling;
//                                                 'half': fast + FM operators every other sample
//   audioRate: 'console' (default) | 'reference'  48 kHz for the console, or the reference
//                                                 core's 44100 Hz stream (a test build)
//   blocks: false                                 no recompiled blocks (Musashi only)
//   coverage: {                                   what to compile (see ../coverage.js)
//     cart: '<exact .wasc>'                       the verified wasmcart to trace; omitted,
//                                                 it is built first (disasm emit:'wasmcart')
//     input, frames                               a schedule to run (reference frames)
//     fuzzSeeds: [1,2,3], fuzzFrames, fuzzInput   seeded random play (fuzzRecompile's)
//     schedules: [{input, frames}]                more play to cover (other levels, longer runs)
//   }
//   z80: false                                    no recompiled Z80 driver (gpgx's Z80 core only);
//                                                 by default the driver in Z80 RAM after the
//                                                 coverage run is recompiled (z80blocks.js)
//   coverageFile: '<json>'                        reuse a saved coverage record
//   saveCoverage: '<json>'                        write the coverage record
//   title, id                                     cart header fields
//   extraCflags: ['-D...']                        more compiler flags for every unit (experiments)
//
// Plain JS ESM + JSDoc.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { emitProject, buildProject, describe, SYNC32_LIMITS, mapObjectSizes } from "./index.js";

/** The coverage record for emitBlocks: from a file, a traced cart, or a fresh exact cart. */
async function coverageFor(romPath, outputPath, o, onProgress) {
  if (o.coverageFile) {
    const c = JSON.parse(readFileSync(o.coverageFile, "utf8"));
    return { pcs: c.pcs.map((e) => (Array.isArray(e) ? e[0] : e)), pairs: c.pairs, irqTargets: c.irqTargets ?? [], runs: c.runs ?? [], z80Image: c.z80Image ? new Uint8Array(Buffer.from(c.z80Image, "base64")) : null, source: { coverageFile: o.coverageFile } };
  }
  const cov = o.coverage ?? {};
  let cart = cov.cart;
  if (!cart) {
    cart = outputPath.replace(/\.[^./]+$/, "") + ".exact.wasc";
    if (!existsSync(cart)) {
      onProgress?.("building the exact wasmcart to trace coverage on");
      const { recompileToWasmcart } = await import("../../wat/build.js");
      await recompileToWasmcart({ platform: "genesis", romPath, outputPath: cart, emit: "wasmcart", options: {} });
    }
  }
  const { collectCoverage } = await import("../coverage.js");
  const c = await collectCoverage({
    cart, input: cov.input, frames: cov.frames ?? (cov.input ? 3600 : undefined),
    fuzzSeeds: cov.fuzzSeeds ?? [1, 2, 3], fuzzFrames: cov.fuzzFrames ?? 3600, fuzzInput: cov.fuzzInput, schedules: cov.schedules, onProgress,
  });
  if (o.saveCoverage) writeFileSync(o.saveCoverage, JSON.stringify({ pcs: [...c.pcs.entries()], pairs: [...c.pairs], irqTargets: [...c.irqTargets], runs: c.runs, z80Image: c.z80Image ? Buffer.from(c.z80Image).toString("base64") : null, z80Images: c.z80Images, source: c.source }));
  return { pcs: [...c.pcs.keys()], pairs: [...c.pairs], irqTargets: [...c.irqTargets], runs: c.runs, z80Image: c.z80Image, source: c.source };
}

/**
 * @param {{romPath:string, outputPath:string, emit:'c'|'sync32', options?:object, onProgress?:(s:string)=>void}} a
 */
export async function recompileToSync32(a) {
  const o = a.options ?? {};
  const t0 = Date.now();
  const rom = new Uint8Array(readFileSync(a.romPath));
  const d = describe(rom, o);
  if (!d.supported) throw new Error(`genesis -> sync32: ${d.unsupportedReason}`);
  let cov = null;
  const timings = {};
  if (o.blocks !== false) {
    const t1 = Date.now();
    cov = await coverageFor(a.romPath, a.outputPath, o, a.onProgress);
    timings.coverage = Date.now() - t1;
  }
  const t2 = Date.now();
  const project = await emitProject(rom, { profile: o.profile, audioQuality: o.audioQuality, audioRate: o.audioRate, ...(o.z80 !== false && cov?.z80Image ? { z80Image: cov.z80Image } : {}), ...(cov ? { blocks: { pcs: cov.pcs, pairs: cov.pairs, irqTargets: cov.irqTargets, maxInsns: o.maxBlockInsns } } : {}) });
  timings.emit = Date.now() - t2;
  const coverage = cov ? { runs: cov.runs, source: cov.source, executedPcs: cov.pcs.length } : null;
  if (a.emit === "c") {
    mkdirSync(a.outputPath, { recursive: true });
    for (const [n, t] of Object.entries(project.files)) writeFileSync(path.join(a.outputPath, n), t);
    writeFileSync(path.join(a.outputPath, "romdev-project.json"), JSON.stringify({
      platform: "sync32", mode: "xip", cflags: project.cflags, meta: project.meta,
      build: "build({platform:'sync32', mode:'xip', sourcesPaths:{<every .c>}, includePaths:{<every .h>}, options:<cflags>}) or disasm({target:'recompile', emit:'sync32'})",
    }, null, 1));
    return { platform: "genesis", target: "sync32", emit: "c", outputPath: a.outputPath, files: Object.keys(project.files).length, describe: d, blocks: project.blockStats, z80: project.z80Stats, coverage, timings: { ...timings, total: Date.now() - t0 } };
  }
  if (o.extraCflags?.length) {
    if (!Array.isArray(o.extraCflags) || o.extraCflags.some((f) => typeof f !== "string" || !f.startsWith("-"))) throw new Error("genesis -> sync32: options.extraCflags must be an array of compiler flags");
    project.cflags = [...project.cflags, ...o.extraCflags];
  }
  const t3 = Date.now();
  const b = await buildProject(project, { title: o.title, id: o.id, onProgress: a.onProgress });
  timings.build = Date.now() - t3;
  if (!b.ok) {
    return { platform: "genesis", target: "sync32", emit: "sync32", error: `build failed at ${b.stage}${b.unit ? ` (${b.unit})` : ""}`, errors: b.errors, logTail: (b.log ?? "").slice(-4000) };
  }
  mkdirSync(path.dirname(a.outputPath), { recursive: true });
  writeFileSync(a.outputPath, b.s32);
  writeFileSync(a.outputPath + ".map", b.map);
  const objs = mapObjectSizes(b.map);
  const sum = (re) => Object.entries(objs).filter(([k]) => re.test(k)).reduce((s, [, v]) => s + v, 0);
  const sizes = {
    s32Bytes: b.s32.length,
    imageBytes: b.imageBytes,
    romImageBytes: project.romImageBytes,
    tableBytes: project.tableBytes,
    blockCodeBytes: sum(/^rd_blocks\d+$/),
    musashiBytes: sum(/^m68kcpu$/),
    ramBytes: b.ramBytes,
    dataBytes: b.dataBytes,
    bssBytes: b.bssBytes,
  };
  const limits = {
    xipSlot: { limit: SYNC32_LIMITS.xipSlotBytes, used: b.imageBytes, pct: Math.round(b.imageBytes / SYNC32_LIMITS.xipSlotBytes * 1000) / 10, fits: b.imageBytes <= SYNC32_LIMITS.xipSlotBytes },
    gameRam: { limit: SYNC32_LIMITS.gameRamBytes, used: b.ramBytes, stackReserved: SYNC32_LIMITS.stackBytes, pct: Math.round(b.ramBytes / SYNC32_LIMITS.gameRamBytes * 1000) / 10, fits: b.ramBytes != null && b.ramBytes <= SYNC32_LIMITS.gameRamBytes - SYNC32_LIMITS.stackBytes },
  };
  return {
    platform: "genesis", target: "sync32", emit: "sync32", outputPath: a.outputPath, mapPath: a.outputPath + ".map",
    romSha1: d.romSha1, profile: project.meta.profile, sizes, limits, blocks: project.blockStats, z80: project.z80Stats ?? { entries: 0, note: "no Z80 image (options.z80:false or no coverage run): every Z80 instruction runs in gpgx's core" }, coverage,
    timings: { ...timings, build: b.buildSeconds * 1000, total: Date.now() - t0 },
    next: `loadMedia({platform:'sync32', path:'${a.outputPath}'}); frame({op:'cycles', from, to, input, profile:true}) for cycles per frame; frame({op:'verifyRecompile', cart:'${a.outputPath}', reference:'<rom>'}) against genesis_plus_gx`,
    license: d.licenseNote,
  };
}
