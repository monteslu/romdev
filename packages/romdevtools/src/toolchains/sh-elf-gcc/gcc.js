// sh-elf-gcc — WASM toolchain wrappers for Dreamcast (SH-4) C builds.
//
// Pipeline (mirrors mips-elf-gcc/gcc.js — gcc-the-driver can't fork/exec under
// emscripten, so we orchestrate cc1 → as → ld → objcopy through callMain):
//   runCc1sh({source, headers, options})  → SH assembly (.s)
//   runShAs({source, includes})           → .o ELF object
//   runShLd({objects, linkScript, ...})   → linked .elf (+ map)
//   runShObjcopy({elf})                   → raw .bin
//
// The Dreamcast SH-4 is little-endian, m4-single-only FP. Single endianness — no
// EL/EB split like MIPS. The staged tool stems keep the createMips* EXPORT_NAMEs
// the build script reused, but the glue filenames are sh-elf-*.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The WASM ships in romdev-toolchain-sh-gcc; fall back to the in-tree dev copy.
function resolveShGlue(file) {
  try {
    const u = import.meta.resolve("romdev-toolchain-sh-gcc");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* not resolvable — fall through */ }
  const local = path.join(__dirname, "wasm", file);
  if (existsSync(local)) return local;
  throw new Error(`sh-elf-gcc WASM (${file}) not found — build it with scripts/build-sh-wasm-tools.sh`);
}
const _glue = {};
const shGlue = (file) => (_glue[file] ??= resolveShGlue(file));

// SH-4 little-endian, m4-single-only FP. cc1 wants -ml; as wants -little --isa=sh4.
const CC1_ARCH = ["-ml", "-m4-single-only"];
const AS_ARCH = ["-little", "--isa=sh4"];

// ── cc1 — SH gcc C frontend, source → assembly ───────────────────────
export async function runCc1sh(args) {
  const { source, options = [] } = args;
  const headers = args.headers ?? {};
  const inputFiles = [textFile("/work/main.c", source)];
  for (const [name, content] of Object.entries(headers)) inputFiles.push(textFile("/work/" + name, content));
  const argv = [
    ...CC1_ARCH,
    "-iquote", "/work", "-I", "/work",
    ...options,
    "/work/main.c", "-o", "/work/main.s",
  ];
  const r = await runIsolated({
    gluePath: shGlue("cc1.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.s", encoding: "utf8" }],
  });
  return { log: r.log, exitCode: r.exitCode, asmSource: getOutputText(r, "/work/main.s") || null,
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}

// ── sh-elf-as — GNU assembler, .s → .o ───────────────────────────────
export async function runShAs(args) {
  const { source, options = [] } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  const inputFiles = [textFile("/work/main.s", source)];
  for (const [name, content] of Object.entries(includes)) inputFiles.push(textFile("/work/" + name, content));
  for (const [name, bytes] of Object.entries(binaryIncludes)) inputFiles.push(binaryFile("/work/" + name, bytes));
  const argv = [...AS_ARCH, "-I", "/work", ...options, "/work/main.s", "-o", "/work/main.o"];
  const r = await runIsolated({
    gluePath: shGlue("sh-elf-as.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.o", encoding: "base64" }],
  });
  return { log: r.log, exitCode: r.exitCode, object: getOutputBytes(r, "/work/main.o"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}

// ── sh-elf-ld — GNU linker, .o + linker script → .elf ────────────────
export async function runShLd(args) {
  const { objects, linkScript, libraries = [], libraryPaths = [], options = [] } = args;
  const archives = args.archives ?? {};
  const inputFiles = [textFile("/work/link.ld", linkScript)];
  for (const [name, bytes] of Object.entries(objects)) inputFiles.push(binaryFile("/work/" + name, bytes));
  for (const [name, bytes] of Object.entries(archives)) inputFiles.push(binaryFile("/work/" + name, bytes));
  const argv = [
    "-EL",
    "-T", "/work/link.ld",
    "-o", "/work/main.elf",
    "-Map=/work/main.map",
    ...libraryPaths.flatMap((p) => ["-L", p]),
    ...Object.keys(objects).map((n) => "/work/" + n),
    ...libraries.map((l) => `-l${l}`),
    ...options,
  ];
  const r = await runIsolated({
    gluePath: shGlue("sh-elf-ld.mjs"),
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

// ── sh-elf-objcopy — ELF → raw .bin ──────────────────────────────────
export async function runShObjcopy(args) {
  const { elf, options = [] } = args;
  const inputFiles = [binaryFile("/work/main.elf", elf)];
  const argv = ["-O", "binary", ...options, "/work/main.elf", "/work/main.bin"];
  const r = await runIsolated({
    gluePath: shGlue("sh-elf-objcopy.mjs"),
    argv, inputFiles,
    outputFiles: [{ vfsPath: "/work/main.bin", encoding: "base64" }],
  });
  return { log: r.log, exitCode: r.exitCode, binary: getOutputBytes(r, "/work/main.bin"),
    ...(r.crash ? { crash: r.crash, stage: "crash" } : {}) };
}
