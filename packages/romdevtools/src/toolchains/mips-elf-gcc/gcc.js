// mips-elf-gcc — WASM toolchain wrappers for N64 / PS1 C builds.
//
// Pipeline (mirrors m68k-elf-gcc/gcc.js — gcc-the-driver can't fork/exec under
// emscripten, so we orchestrate cc1 → as → ld → objcopy through callMain):
//   runCc1mips({source, headers, options, endian}) → MIPS assembly (.s)
//   runMipsAs({source, includes, endian})          → .o ELF object
//   runMipsLd({objects, linkScript, ...})          → linked .elf (+ map)
//   runMipsObjcopy({elf})                          → raw .bin
//
// Endianness: N64 (R4300) is big-endian (default), PS1 (R3000) is little-endian
// (-EL). The same WASM toolchain emits both — pass endian:'little' for PS1.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The WASM ships in romdev-toolchain-mips-gcc; fall back to the in-tree dev copy.
function resolveMipsGlue(file) {
  try {
    const u = import.meta.resolve("romdev-toolchain-mips-gcc");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* not resolvable — fall through */ }
  const local = path.join(__dirname, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`mips-elf-gcc WASM (${file}) not found — build it with scripts/build-mips-wasm-tools.sh`);
}
const _glue = {};
const mipsGlue = (file) => (_glue[file] ??= resolveMipsGlue(file));

/** Endian flags differ by TOOL: cc1 (the C frontend) wants `-mel`/`-meb`; the
 *  assembler + linker want `-EL`/`-EB`. `-mabi=32` (cc1) covers both R3000 (PS1)
 *  and R4300 (N64) 32-bit code. */
function cc1ArchFlags(endian) {
  return [endian === "little" ? "-mel" : "-meb", "-mabi=32"];
}
function asArchFlags(endian) {
  // -G0: never use GP-relative (small-data) addressing. Without it, statics land in
  // .sdata/.sbss and the 16-bit GPREL offsets overflow ("relocation truncated") on
  // anything but a tiny program. -G0 forces normal .data/.bss addressing.
  return [endian === "little" ? "-EL" : "-EB", "-mabi=32", "-G0"];
}

// ── cc1 — MIPS gcc C frontend, source → assembly ─────────────────────
export async function runCc1mips(args) {
  const { source, options = [], endian = "big" } = args;
  const headers = args.headers ?? {};
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) inputFiles.push(textFile("/work/" + name, content));
  const argv = [
    ...cc1ArchFlags(endian),
    "-iquote", "/work", "-I", "/work",
    ...options,
    "/work/main.c", "-o", "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: mipsGlue("cc1.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.s", encoding: "utf8" }],
  });
  return { log: r.log, exitCode: r.exitCode, asmSource: getOutputText(r, "/work/main.s") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}

// ── mips-elf-as — GNU assembler, .s → .o ─────────────────────────────
export async function runMipsAs(args) {
  const { source, options = [], endian = "big" } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  const inputFiles = [textFile("/work/main.s", source)];
  for (const [name, content] of Object.entries(includes)) inputFiles.push(textFile("/work/" + name, content));
  for (const [name, bytes] of Object.entries(binaryIncludes)) inputFiles.push(binaryFile("/work/" + name, bytes));
  const argv = [...asArchFlags(endian), "-I", "/work", ...options, "/work/main.s", "-o", "/work/main.o"];
  const r = await runIsolated({
    gluePath: mipsGlue("mips-elf-as.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.o", encoding: "base64" }],
  });
  return { log: r.log, exitCode: r.exitCode, object: getOutputBytes(r, "/work/main.o"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}

// ── mips-elf-ld — GNU linker, .o + linker script → .elf ──────────────
export async function runMipsLd(args) {
  const { objects, linkScript, libraries = [], libraryPaths = [], options = [], endian = "big" } = args;
  const archives = args.archives ?? {};
  const inputFiles = [textFile("/work/link.ld", linkScript)];
  for (const [name, bytes] of Object.entries(objects)) inputFiles.push(binaryFile("/work/" + name, bytes));
  for (const [name, bytes] of Object.entries(archives)) inputFiles.push(binaryFile("/work/" + name, bytes));
  const argv = [
    endian === "little" ? "-EL" : "-EB",
    "-T", "/work/link.ld",
    "-o", "/work/main.elf",
    "-Map=/work/main.map",
    ...libraryPaths.flatMap((p) => ["-L", p]),
    ...Object.keys(objects).map((n) => "/work/" + n),
    ...libraries.map((l) => `-l${l}`),
    ...options,
  ];
  const r = await runIsolated({
    gluePath: mipsGlue("mips-elf-ld.mjs"),
    argv, inputFiles,
    outputFiles: [
      { vfsPath: "/work/main.elf", encoding: "base64" },
      { vfsPath: "/work/main.map", encoding: "utf8" },
    ],
  });
  return { log: r.log, exitCode: r.exitCode, elf: getOutputBytes(r, "/work/main.elf"),
    map: getOutputText(r, "/work/main.map") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}

// ── mips-elf-objcopy — ELF → raw .bin ────────────────────────────────
export async function runMipsObjcopy(args) {
  const { elf, options = [] } = args;
  const inputFiles = [binaryFile("/work/main.elf", elf)];
  const argv = ["-O", "binary", ...options, "/work/main.elf", "/work/main.bin"];
  const r = await runIsolated({
    gluePath: mipsGlue("mips-elf-objcopy.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.bin", encoding: "base64" }],
  });
  return { log: r.log, exitCode: r.exitCode, binary: getOutputBytes(r, "/work/main.bin"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}
