// RGBDS — bundled Game Boy / GBC assembler + linker + fix tool.
//
// Pipeline: rgbasm (source .asm → .o object) → rgblink (.o → .gb) →
// rgbfix (patches header + checksums in-place).
//
// Each is its own Emscripten module run through the worker pool for
// crash isolation. Returns from each wrapper carry { exitCode, log,
// crash? } in addition to tool-specific fields.

import { fileURLToPath } from "node:url";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";
import { makeGlueResolver } from "../common/wasm-tool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// RGBDS's WASM ships in romdev-toolchain-rgbds. Resolve each tool's glue from
// that package; fall back to a local copy under src/ if present (transition /
// dev). Lazy + memoized per tool: resolve (and possibly throw "not installed")
// only on the first GB/GBC asm build that uses each tool, not at module load —
// so booting the server never touches this package unless RGBDS is actually used.
const rgbdsGlue = makeGlueResolver({ pkg: "romdev-toolchain-rgbds", localDir: __dirname, label: "RGBDS" });

/**
 * Run rgbasm on a source program.
 * @param {Object} args
 * @param {string} args.source main .asm source
 * @param {Record<string, string>} [args.includes] virtual filename → contents
 * @param {string[]} [args.options]
 */
export async function runRgbasm(args) {
  const { source } = args;
  const includes = args.includes ?? {};
  const opts = args.options ?? [];
  // Which file we assemble, and what the object is called. Multi-file builds
  // assemble each translation unit separately (each needs its OWN object for
  // rgblink), so they pass a name; single-file builds keep "main.asm".
  const unit = args.unitName ?? "main.asm";
  const objName = args.objectName ?? "out.o";
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/" + unit, source)];
  for (const [name, content] of Object.entries(includes)) {
    // The main unit is already mounted above; don't mount it twice (a
    // duplicate MEMFS write of the same path is harmless but confusing in
    // logs, and an `includes` entry that shadows it would silently win).
    if (name === unit) continue;
    inputFiles.push(textFile("/work/" + name, content));
  }
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgbasm.js"),
    argv: ["-I", "/work", ...opts, "-o", "/work/" + objName, "/work/" + unit],
    inputFiles,
    outputFiles: [{ vfsPath: "/work/" + objName, encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    object: getOutputBytes(r, "/work/" + objName),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Link rgbasm object(s) into a Game Boy ROM.
 * @param {Object} args
 * @param {Record<string, Uint8Array>} args.objects
 * @param {string[]} [args.options]
 */
export async function runRgblink(args) {
  const { objects } = args;
  const opts = args.options ?? [];
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [];
  for (const [n, b] of Object.entries(objects)) inputFiles.push(binaryFile("/work/" + n, b));
  // ALWAYS ask the linker for its symbol map (-n) and section map (-m).
  //
  // rgblink emits these only when asked, and every real GB project's Makefile
  // asks (`rgblink -d -n $*.sym -m $*.map`). Without them an agent doing
  // romhacking/RE has no label -> bank:address table, and the only recourse is
  // to hand-write an SM83 assembler-lite that re-derives addresses by sizing
  // every instruction -- which is exactly what one agent had to do, at the
  // cost of most of its session, because `build` returned `symbols: ""`.
  // They are small, textual, and free to produce, so they are not opt-in.
  const wantsSym = !opts.includes("-n");
  const wantsMap = !opts.includes("-m");
  const extra = [
    ...(wantsSym ? ["-n", "/work/out.sym"] : []),
    ...(wantsMap ? ["-m", "/work/out.map"] : []),
  ];
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgblink.js"),
    argv: ["-o", "/work/out.gb", ...extra, ...opts, ...Object.keys(objects).map((n) => "/work/" + n)],
    inputFiles,
    outputFiles: [
      { vfsPath: "/work/out.gb", encoding: "base64" },
      // A failed link writes no map; the worker degrades a missing output to
      // "" rather than throwing, so a broken build still reports the REAL
      // rgblink error instead of an ENOENT for the map.
      ...(wantsSym ? [{ vfsPath: "/work/out.sym", encoding: "utf8" }] : []),
      ...(wantsMap ? [{ vfsPath: "/work/out.map", encoding: "utf8" }] : []),
    ],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.gb"),
    // label -> bank:address, straight from the linker. Empty string rather
    // than undefined so callers can concatenate without guarding.
    symbols: wantsSym ? (getOutputText(r, "/work/out.sym") ?? "") : "",
    map: wantsMap ? (getOutputText(r, "/work/out.map") ?? "") : "",
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Patch a Game Boy ROM's header (fills logo, sets type byte, fixes checksums).
 * @param {Object} args
 * @param {Uint8Array} args.rom
 * @param {string[]} [args.options]
 */
export async function runRgbfix(args) {
  const { rom } = args;
  const opts = args.options ?? ["-v", "-p", "0xFF"];
  const r = await runIsolated({
    gluePath: rgbdsGlue("rgbfix.js"),
    argv: [...opts, "/work/out.gb"],
    inputFiles: [binaryFile("/work/out.gb", rom)],
    outputFiles: [{ vfsPath: "/work/out.gb", encoding: "base64" }],
  });
  return {
    log: r.log,
    exitCode: r.exitCode,
    binary: getOutputBytes(r, "/work/out.gb"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Build a single .asm file all the way to a fixed .gb ROM.
 * @param {Object} args
 * @param {string} args.source
 * @param {Record<string, string>} [args.includes]
 */
export async function buildGB(args) {
  // ONE OBJECT PER .asm, exactly like a real GB project's Makefile.
  //
  // A multi-file rgbds project (`bank0.asm`/`bank1.asm`/... — the shape every
  // published GB disassembly ships) assembles each file to its OWN object and
  // links them together. This used to assemble ONLY `main.asm` and link a
  // single object, with the other files mounted as `includes` — i.e. reachable
  // via INCLUDE but never assembled, so their sections simply did not exist in
  // the ROM. Callers passing `sources` got a build that silently dropped most
  // of the program.
  //
  // `sources` ({name: contents}) is the multi-file form; `source` is the
  // single-file one. A file is a translation unit if it ends in .asm/.s —
  // anything else (.inc, .rgbinc, charmaps) is an INCLUDE payload and must NOT
  // be assembled on its own.
  const sources = args.sources ?? null;
  const includes = args.includes ?? {};
  if (sources && Object.keys(sources).length > 0) {
    const names = Object.keys(sources);
    const isTU = (n) => /\.(asm|s)$/i.test(n);
    const units = names.filter(isTU);
    // Everything is visible to every unit (INCLUDE, INCBIN), whether or not it
    // is itself assembled — that is what `-I /work` means.
    const allVisible = { ...includes, ...sources };
    if (units.length === 0) {
      return {
        binary: null,
        log: `no assemblable source among [${names.join(", ")}] — rgbds needs at least one .asm/.s translation unit`,
        exitCode: 1,
        stage: "rgbasm",
      };
    }
    /** @type {Record<string, Uint8Array>} */
    const objects = {};
    let log = "";
    for (const name of units) {
      const objName = name.replace(/\.(asm|s)$/i, "") .replace(/[^A-Za-z0-9_.-]/g, "_") + ".o";
      const a = await runRgbasm({
        source: sources[name],
        includes: allVisible,
        options: args.options,
        unitName: name,
        objectName: objName,
      });
      log += (log ? "\n" : "") + `--- rgbasm ${name} ---\n` + a.log;
      if (a.exitCode !== 0 || !a.object) {
        // Name the FILE that failed: with N units a bare rgbasm error leaves
        // the caller bisecting by hand to find which one.
        return { binary: null, log, exitCode: a.exitCode || 1, stage: a.stage ?? "rgbasm", failedTU: name };
      }
      objects[objName] = a.object;
    }
    const l = await runRgblink({ objects, options: args.linkOptions });
    if (l.exitCode !== 0 || !l.binary) {
      return { binary: null, log: log + "\n--- rgblink ---\n" + l.log, exitCode: l.exitCode || 1, stage: l.stage ?? "rgblink" };
    }
    const f = await runRgbfix({ rom: l.binary });
    return {
      binary: f.binary ?? l.binary,
      log: log + "\n--- rgblink ---\n" + l.log + "\n--- rgbfix ---\n" + f.log,
      exitCode: f.exitCode,
      stage: f.exitCode === 0 ? "done" : (f.stage ?? "rgbfix"),
      symbols: l.symbols ?? "",
      map: l.map ?? "",
    };
  }

  const a = await runRgbasm(args);
  if (a.exitCode !== 0 || !a.object) {
    return { binary: null, log: a.log, exitCode: a.exitCode || 1, stage: a.stage ?? "rgbasm" };
  }
  const l = await runRgblink({ objects: { "main.o": a.object }, options: args.linkOptions });
  if (l.exitCode !== 0 || !l.binary) {
    return {
      binary: null,
      log: a.log + "\n--- rgblink ---\n" + l.log,
      exitCode: l.exitCode || 1,
      stage: l.stage ?? "rgblink",
    };
  }
  const f = await runRgbfix({ rom: l.binary });
  return {
    binary: f.binary ?? l.binary,
    log: a.log + "\n--- rgblink ---\n" + l.log + "\n--- rgbfix ---\n" + f.log,
    exitCode: f.exitCode,
    stage: f.exitCode === 0 ? "done" : (f.stage ?? "rgbfix"),
    symbols: l.symbols ?? "",
    map: l.map ?? "",
  };
}
