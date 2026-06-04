// sdcc — bundled Z80 family C compiler + assembler + linker.
//
// Wraps SDCC 4.5.0 compiled to WASM. Targets z80 (SMS / GG). Game Boy uses
// RGBDS for asm; the SDCC sm83 port is bundled for the GB/GBC C path.
//
// Pipeline:
//   1. sdcc.wasm    — C → relocatable (.rel)  (-mz80 / -mez80_z80, etc)
//   2. sdasz80.wasm — .s → .rel               (assembly path)
//   3. sdld.wasm    — .rel + .lib → .ihx      (Intel hex)
//   4. ihx → raw bin → per-platform ROM wrapper (handled by buildForPlatform)
//
// Each tool runs in its own Emscripten module with its own MEMFS.
// share/sdcc/{include,lib/<port>} is mounted at /share/sdcc/ at call time.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SDCC's tool WASM AND its target share/ tree (include + per-port lib) both
// ship in romdev-toolchain-sdcc. Resolve the package's base dir once; fall
// back to a local copy under src/ if present (transition / dev). The package
// is a hard dep of romdev. The share/ files are mounted into MEMFS at call
// time. (Mirrors the cc65 resolver.)
function resolveSdccBaseDir() {
  try {
    const u = import.meta.resolve("romdev-toolchain-sdcc");
    const dir = path.dirname(fileURLToPath(u));
    if (existsSync(path.join(dir, "wasm", "sdcc.js"))) return dir;
  } catch { /* package not resolvable — fall through to local */ }
  if (existsSync(path.join(__dirname, "wasm", "sdcc.js"))) return __dirname;
  throw new Error("SDCC WASM not found — install romdev-toolchain-sdcc");
}
// Lazy + memoized: resolve (and possibly throw "not installed") only on the
// first SDCC build (GB/GBC/SMS/GG C), not at module load — so booting the
// server never touches this package unless SDCC is actually used. Resolve the
// base dir once; derive each tool glue + the share dir from it on demand.
let _sdccBase;
const sdccBase  = () => (_sdccBase ??= resolveSdccBaseDir());
const sdccGlue  = (file) => path.join(sdccBase(), "wasm", file);
const shareDir  = () => path.join(sdccBase(), "share", "sdcc");

/**
 * Map our platform ids to sdcc -m flag values + per-port lib directory.
 * @typedef {{ marg: string, libDir: string }} SdccPortInfo
 * @type {Record<string, SdccPortInfo>}
 */
export const SDCC_PORTS = {
  sms:        { marg: "z80",      libDir: "z80" },
  gg:         { marg: "z80",      libDir: "z80" },
  gb:         { marg: "sm83",     libDir: "sm83" },
  gbc:        { marg: "sm83",     libDir: "sm83" },
  msx:        { marg: "z80",      libDir: "z80" },
};

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

/**
 * Tag the abort/crash log with the SDCC-flavored hint pointing at the
 * R6 stack-overflow fix. Pre-R6, this hint shipped on every Abort —
 * since the build pipeline now runs in a child worker that gets killed
 * on abort, we need to re-add this hint at the wrapper layer when we
 * detect a crash result.
 */
function appendSdccAbortHint(log, argv, toolName) {
  return log +
    `\nAbort in ${toolName}: see worker stderr above.\n` +
    `Args: ${argv.join(" ")}\n` +
    `Hint: unexpected SDCC abort. The historical "dbuf_append_str ` +
    `NULL" assertion family was fixed at the build level on ` +
    `2026-05-25 (emscripten stack overflow). If you see it now, it ` +
    `is a different bug — capture the .c source + this log and open ` +
    `an issue at https://github.com/monteslu/romdev/issues.\n`;
}

/**
 * Run mcpp (Matsui's C preprocessor) on a source. Returns the preprocessed
 * text. Necessary as a separate step because:
 *   1. SDCC ships sdcpp as a shell wrapper around the system /usr/bin/cpp,
 *      which we can't bundle.
 *   2. sdcc.wasm internally fork+exec's its preprocessor; Emscripten's
 *      libc can't fork — popen() returns ENOSYS.
 * So we preprocess with mcpp.wasm ourselves and feed the .i to sdcc.wasm
 * (sdcc skips its own preprocessor when given a .i input file).
 *
 * @param {Object} args
 * @param {string} args.source
 * @param {string} args.port sdcc port id, used for __SDCC_<port> define
 * @param {Record<string, string>} [args.headers]
 * @param {string[]} [args.options]
 */
export async function runSdcpp(args) {
  const { source, port, options = [] } = args;
  const headers = args.headers ?? {};
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  const argv = [
    "-I", "/share/sdcc/include",
    "-I", "/work",
    `-D__SDCC`,
    `-D__SDCC_${port}`,
    ...options,
    "/work/main.c",
    "/work/main.i",
  ];
  const r = await runIsolated({
    gluePath: sdccGlue("mcpp.js"),
    argv,
    inputFiles,
    hostDirMounts: [{ hostDir: path.join(shareDir(), "include"), vfsDir: "/share/sdcc/include" }],
    outputFiles: [{ vfsPath: "/work/main.i", encoding: "utf8" }],
  });
  return {
    log: r.crash ? appendSdccAbortHint(r.log, argv, "mcpp") : r.log,
    exitCode: r.exitCode,
    preprocessed: getOutputText(r, "/work/main.i"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Compile a (preprocessed or raw) C source to a relocatable .rel.
 * Pipeline runs sdcpp first, then sdcc on the .i output. The wrapper
 * stitches them together so callers see a single C → .rel step.
 *
 * @param {Object} args
 * @param {string} args.source C source
 * @param {string} args.port "z80" / "ez80_z80" / etc — sdcc -m value
 * @param {Record<string, string>} [args.headers] virtual headers, mounted at /work
 * @param {string[]} [args.options] extra sdcc flags
 */
export async function runSdccCompile(args) {
  const { source, port, options = [] } = args;
  // 1) Preprocess.
  const cpp = await runSdcpp({ source, port, headers: args.headers });
  if (cpp.exitCode !== 0 || !cpp.preprocessed) {
    return { rel: null, exitCode: cpp.exitCode || 1, log: "--- sdcpp ---\n" + cpp.log };
  }
  // 2) Hand the preprocessed text to sdcc in --c1mode. In c1mode sdcc
  // reads pre-tokenized input from stdin and emits assembly to disk
  // (skipping its built-in popen("sdcpp ...") which Emscripten can't
  // satisfy). The .i text is piped in via FS.init(stdinFn, ...) inside
  // the worker. Output is .asm; sdasz80 turns it into .rel.
  const sdccArgv = [
    `-m${port}`,
    "--c1mode",
    "-o", "/work/main.asm",
    ...options,
  ];
  const sdccResult = await runIsolated({
    gluePath: sdccGlue("sdcc.js"),
    argv: sdccArgv,
    stdinText: cpp.preprocessed,
    outputFiles: [{ vfsPath: "/work/main.asm", encoding: "utf8" }],
  });
  const r = {
    log: sdccResult.crash ? appendSdccAbortHint(sdccResult.log, sdccArgv, "sdcc") : sdccResult.log,
    exitCode: sdccResult.exitCode,
    asmSource: getOutputText(sdccResult, "/work/main.asm"),
  };

  // Now sdcc emitted assembly — feed it to sdasz80 to get the .rel.
  if (r.exitCode !== 0 || !r.asmSource) {
    return {
      rel: null,
      exitCode: r.exitCode || 1,
      log: "--- mcpp ---\n" + cpp.log + "\n--- sdcc --c1mode ---\n" + r.log,
    };
  }
  // sm83 (Game Boy) uses sdasgb instead of sdasz80 — different instruction set.
  const isSm83 = port === "sm83" || port === "gbz80";
  const asmRunner = isSm83 ? runSdasgb : runSdasz80;
  const asmLabel  = isSm83 ? "sdasgb"  : "sdasz80";
  const asm = await asmRunner({ source: r.asmSource });
  return {
    rel: asm.rel,
    exitCode: asm.exitCode,
    log:
      "--- mcpp ---\n" + cpp.log +
      "\n--- sdcc --c1mode ---\n" + r.log +
      `\n--- ${asmLabel} ---\n` + asm.log,
  };
}

/**
 * Assemble a Z80 .s source to .rel with sdasz80.
 */
export async function runSdasz80(args) {
  const { source, options = [] } = args;
  const argv = [
    "-plosgff", // standard flags (preserve case, list, output, symbols, globals, all symbols, ff/no fill)
    ...options,
    "/work/main.rel", // sdasz80 writes <name>.rel; arg is also the input base
    "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: sdccGlue("sdasz80.js"),
    argv,
    inputFiles: [textFile("/work/main.s", source)],
    outputFiles: [{ vfsPath: "/work/main.rel", encoding: "utf8" }],
  });
  return {
    log: r.crash ? appendSdccAbortHint(r.log, argv, "sdasz80") : r.log,
    exitCode: r.exitCode,
    rel: getOutputText(r, "/work/main.rel"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Assemble an SM83 .s source to .rel with sdasgb. Different from sdasz80
 * because Game Boy's SM83 has a non-Z80 instruction set + different
 * relocation type IDs.
 */
export async function runSdasgb(args) {
  const { source, options = [] } = args;
  const argv = [
    "-plosgff",
    ...options,
    "/work/main.rel",
    "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: sdccGlue("sdasgb.js"),
    argv,
    inputFiles: [textFile("/work/main.s", source)],
    outputFiles: [{ vfsPath: "/work/main.rel", encoding: "utf8" }],
  });
  return {
    log: r.crash ? appendSdccAbortHint(r.log, argv, "sdasgb") : r.log,
    exitCode: r.exitCode,
    rel: getOutputText(r, "/work/main.rel"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Link relocatable objects + libraries → Intel hex.
 *
 * @param {Object} args
 * @param {Record<string, string>} args.objects map of name → .rel text
 * @param {string} args.port sdcc port id (e.g. "z80")
 * @param {string[]} [args.libraries] extra .lib names (without dir) to link
 * @param {number} [args.codeLoc] code segment start address (default 0x0000)
 * @param {number} [args.dataLoc] data segment start address (default 0xC000 for Z80)
 * @param {string} [args.crt0] alternative crt0 .rel text. Defaults to the
 *   stock SDCC crt0.rel from share/sdcc/lib/<port>/.
 */
export async function runSdld(args) {
  const {
    objects,
    port,
    libraries = [],
    codeLoc = 0x0000,
    dataLoc = 0xC000,
    crt0,
  } = args;
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [];
  for (const [name, text] of Object.entries(objects)) {
    inputFiles.push(textFile("/work/" + name, text));
  }
  // crt0: read from disk in the parent, ship its bytes to the worker.
  if (crt0) {
    inputFiles.push(textFile("/work/crt0.rel", crt0));
  } else {
    const stockCrt0 = await readFile(path.join(shareDir(), "lib", port, "crt0.rel"));
    inputFiles.push(textFile("/work/crt0.rel", stockCrt0.toString("utf8")));
  }
  const argv = [
    "-n", // sdldz80 mode (default behavior, explicit for clarity)
    "-mjwx", // map file + use crt0 + link error wraps + no echo
    "-i", // intel hex output
    "-b", `_CODE=0x${codeLoc.toString(16)}`,
    "-b", `_DATA=0x${dataLoc.toString(16)}`,
    "-k", "/share/sdcc/lib/" + port,
    ...libraries.flatMap((l) => ["-l", l]),
    "/work/out.ihx", // output base
    "/work/crt0.rel",
    ...Object.keys(objects).map((n) => "/work/" + n),
    "-l", port + ".lib",
    "-e", // end of arg list
  ];
  const r = await runIsolated({
    gluePath: sdccGlue("sdld.js"),
    argv,
    inputFiles,
    hostDirMounts: [
      { hostDir: path.join(shareDir(), "lib", port), vfsDir: "/share/sdcc/lib/" + port },
    ],
    outputFiles: [
      { vfsPath: "/work/out.ihx", encoding: "utf8" },
      { vfsPath: "/work/out.map", encoding: "utf8" },
    ],
  });
  return {
    log: r.crash ? appendSdccAbortHint(r.log, argv, "sdld") : r.log,
    exitCode: r.exitCode,
    ihx: getOutputText(r, "/work/out.ihx") || null,
    map: getOutputText(r, "/work/out.map") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}),
  };
}

/**
 * Convert Intel HEX text → raw binary, padded to `size` bytes with `fill` byte.
 * Mirrors `makebin -s <size>` behavior. Pure JS; faster than spinning another WASM.
 *
 * @param {string} ihx Intel hex text
 * @param {number} size pad to this many bytes (e.g. 32768 for SMS)
 * @param {number} [fill=0xFF] fill byte for unwritten regions
 */
export function ihxToBin(ihx, size, fill = 0xFF) {
  const out = new Uint8Array(size).fill(fill);
  let highBits = 0; // for type 04 (extended linear address)
  for (const rawLine of ihx.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(":")) continue;
    const byteCount = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const recType = parseInt(line.substr(7, 2), 16);
    const dataHex = line.substr(9, byteCount * 2);
    if (recType === 0x00) {
      // data record
      const absAddr = ((highBits << 16) | addr) >>> 0;
      for (let i = 0; i < byteCount; i++) {
        const byte = parseInt(dataHex.substr(i * 2, 2), 16);
        const target = absAddr + i;
        if (target < out.length) out[target] = byte;
      }
    } else if (recType === 0x04) {
      // extended linear address: high 16 bits of subsequent addresses
      highBits = parseInt(dataHex, 16);
    } else if (recType === 0x01) {
      // EOF
      break;
    }
    // 0x02 / 0x03 / 0x05 — segment + start records, not relevant for our flat-binary targets
  }
  return out;
}

/**
 * Convenience: compile + assemble (if needed) + link a C project to a raw
 * binary ready for per-platform ROM wrapping.
 *
 * @param {Object} args
 * @param {string} [args.source] single C source (shortcut)
 * @param {Record<string, string>} [args.sources] map of name → contents (.c or .s/.asm)
 * @param {string} args.port sdcc port id (e.g. "z80")
 * @param {number} args.romSize pad result to this many bytes
 * @param {Record<string, string>} [args.headers]
 * @param {number} [args.codeLoc]
 * @param {number} [args.dataLoc]
 * @param {string[]} [args.libraries]
 * @param {string} [args.crt0]
 */
export async function buildZ80C(args) {
  const sources = args.sources ?? { "main.c": args.source };
  let log = "";
  /** @type {Record<string, string>} */
  const objects = {};
  // SM83 (Game Boy) uses sdasgb instead of sdasz80 — different instruction set.
  const isSm83 = args.port === "sm83" || args.port === "gbz80";
  // Track which TUs compiled successfully before any failure, so the
  // error response can pinpoint exactly which translation unit died
  // (the SDCC `Aborted(...)` message itself doesn't include the TU name).
  const compiledOK = [];
  for (const [name, src] of Object.entries(sources)) {
    const ext = path.extname(name).toLowerCase();
    if (ext === ".s" || ext === ".asm") {
      // Assembly path — sdasz80 for z80 ports, sdasgb for sm83.
      const asmRun = isSm83 ? runSdasgb : runSdasz80;
      const asmLabel = isSm83 ? "sdasgb" : "sdasz80";
      const r = await asmRun({ source: src });
      log += `--- ${asmLabel} (${name}) ---\n` + r.log + "\n";
      if (r.exitCode !== 0 || !r.rel) {
        log += `\n[buildZ80C] FAILED on TU '${name}' (${asmLabel}). Successfully compiled before this: ${compiledOK.length === 0 ? "(none)" : compiledOK.join(", ")}\n`;
        return { binary: null, log, exitCode: r.exitCode || 1, stage: asmLabel, failedTU: name, compiledOK: [...compiledOK] };
      }
      compiledOK.push(name);
      objects[name.replace(/\.(s|asm)$/i, ".rel")] = r.rel;
    } else {
      // C path — sdcc -c
      const r = await runSdccCompile({
        source: src,
        port: args.port,
        headers: args.headers,
      });
      log += `--- sdcc (${name}) ---\n` + r.log + "\n";
      if (r.exitCode !== 0 || !r.rel) {
        log += `\n[buildZ80C] FAILED on TU '${name}' (sdcc). Successfully compiled before this: ${compiledOK.length === 0 ? "(none)" : compiledOK.join(", ")}\n`;
        return { binary: null, log, exitCode: r.exitCode || 1, stage: "sdcc", failedTU: name, compiledOK: [...compiledOK] };
      }
      compiledOK.push(name);
      objects[name.replace(/\.(c|h)$/i, ".rel")] = r.rel;
    }
  }
  // Round 26 fix #14: when caller passes `crt0` as .s/.asm SOURCE
  // (which is how every test in this repo + every agent has always
  // used it), assemble it first. Pre-r54 this raw .s text was shoved
  // into /work/crt0.rel; sdld silently rejected the malformed "rel"
  // and quietly fell back to SDCC's stock crt0 from sm83.lib. Result:
  // the custom GB crt0 with the real cartridge boot sequence + IRQ
  // vectors NEVER LINKED. Symptom: writes to $FF24/$FF25/$FF47 etc
  // either land in stock-crt0-trampled RAM or never reach the APU/PPU.
  // Audio was the most visible victim (NR50/NR51 = $00, NR52 never
  // got to $80 because gambatte's bootrom-emulated startup left it in
  // a half-state and our writes never ran from the right entry).
  //
  // Detection: a real sdld .rel object starts with `XL2\n` or `XL4\n`
  // (the relocation byte-order tag). A .s source typically starts with
  // a comment (`;`) or a directive (`.module`, `.area`, etc.) — but
  // never with the .rel header. Asm-pre-assembled .rel files (e.g.
  // from runSdasgb output above) carry the XL prefix naturally.
  let crt0Rel = args.crt0;
  if (crt0Rel && !/^XL[2-4]\b/.test(crt0Rel.trim())) {
    // Looks like .s source — assemble it via the same path we use for
    // user .s sources.
    const crt0Asm = await (isSm83 ? runSdasgb : runSdasz80)({ source: crt0Rel });
    log += `--- ${isSm83 ? "sdasgb" : "sdasz80"} (crt0) ---\n` + crt0Asm.log + "\n";
    if (crt0Asm.exitCode !== 0 || !crt0Asm.rel) {
      log += `\n[buildZ80C] FAILED to assemble crt0 source. Successfully compiled before this: ${compiledOK.length === 0 ? "(none)" : compiledOK.join(", ")}\n`;
      return { binary: null, log, exitCode: crt0Asm.exitCode || 1, stage: "sdasgb-crt0" };
    }
    crt0Rel = crt0Asm.rel;
  }

  const link = await runSdld({
    objects,
    port: args.port,
    libraries: args.libraries,
    codeLoc: args.codeLoc,
    dataLoc: args.dataLoc,
    crt0: crt0Rel,
  });
  log += "--- sdld ---\n" + link.log;
  if (link.exitCode !== 0 || !link.ihx) {
    return { binary: null, log, exitCode: link.exitCode, stage: "sdld" };
  }
  // `romBase` (e.g. MSX $4000) means the cartridge maps at that address: the
  // ihx writes records at absolute $4000+, so size the buffer to cover them,
  // then slice to a `romBase`-based page image (offset 0 == address romBase).
  // Without it, an MSX ROM would be a $0000-based image with its real code at
  // offset $4000 — the header check + the core both expect it at offset 0.
  if (args.romBase) {
    const span = args.romBase + (args.romSize || 0);
    const full = ihxToBin(link.ihx, span);
    const end = args.romSize ? args.romBase + args.romSize : full.length;
    return { binary: full.slice(args.romBase, end), log, exitCode: 0, stage: "done", map: link.map ?? null };
  }
  // If romSize is null/0, size the buffer to the highest address the ihx
  // actually wrote (no padding to a ROM size). Used for tape targets like
  // ZX Spectrum where the loader cares about exact byte count.
  const size = args.romSize || ihxHighWaterMark(link.ihx);
  const binary = ihxToBin(link.ihx, size);
  // For tape-style outputs, trim leading zero bytes BEFORE the code-load
  // address so the .tap data block contains only the actual code.
  let trimmed = binary;
  if (!args.romSize && args.codeLoc) {
    trimmed = binary.slice(args.codeLoc);
  }
  return { binary: trimmed, log, exitCode: 0, stage: "done", map: link.map ?? null };
}

/**
 * Parse a sdld .map file into a flat array of {address, name, file?}
 * entries. The .map file format (Intel-hex-style linker output) lists
 * areas, then symbols within them:
 *
 *   AREA _CODE
 *      Addr   Global Symbol
 *   00000150  _main
 *   0000015B  _wait_vblank
 *   ...
 *
 * For our use case (PC → function name), we just want the (address, name)
 * pairs. Strip leading underscores so callers can compare to C names.
 */
export function parseSdldMap(map) {
  if (!map) return [];
  const out = [];
  for (const rawLine of map.split(/\r?\n/)) {
    const line = rawLine.trim();
    // Match "<4 hex addr><whitespace><name>" — sdld emits 4-hex addresses
    // for z80/sm83 (16-bit address space).
    const m = /^([0-9A-Fa-f]{4,8})\s+([A-Za-z_.][A-Za-z0-9_.]*)\s*$/.exec(line);
    if (m) {
      out.push({
        address: parseInt(m[1], 16),
        addressHex: "0x" + m[1].toUpperCase(),
        name: m[2].startsWith("_") ? m[2].slice(1) : m[2],
        rawName: m[2],
      });
    }
  }
  out.sort((a, b) => a.address - b.address);
  return out;
}

// Walk an Intel hex file and return the highest absolute byte address
// that gets written, plus 1 (i.e. the minimum buffer length). For tape
// targets we use this so the resulting .tap data block size matches the
// actual code, not a padded ROM size.
function ihxHighWaterMark(ihx) {
  let highBits = 0;
  let max = 0;
  for (const rawLine of ihx.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(":")) continue;
    const byteCount = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const recType = parseInt(line.substr(7, 2), 16);
    if (recType === 0x00) {
      const end = ((highBits << 16) | addr) + byteCount;
      if (end > max) max = end;
    } else if (recType === 0x04) {
      const dataHex = line.substr(9, byteCount * 2);
      highBits = parseInt(dataHex, 16);
    } else if (recType === 0x01) {
      break;
    }
  }
  return max;
}
