// mips-obj.js — relocatable-object plumbing for the matching loop: assemble a
// splat .s into a target object, run objdump -dr on any .o, and parse the
// listing into per-symbol instruction streams that carry their relocations.
//
// Both sides of every comparison (target assembled from the extracted asm,
// candidate compiled from C) go through the SAME assembler + objdump, so a
// textual match is a match of what the linker will see, relocations included.
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/** Run a process, capture stdout/stderr, never throw on non-zero. */
export function run(cmd, args, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e), spawnError: true }); });
    child.on("close", (code, signal) => { clearTimeout(t); resolve({ code: code ?? -1, signal, stdout: out, stderr: err }); });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

/**
 * The assembler prelude splat/asm-processor projects rely on: `glabel`,
 * `jlabel`, `dlabel` macros + o32 float register aliases. Mirrors
 * decomp-permuter's prelude.inc so a target.o assembled here scores the same
 * as one the permuter builds.
 */
export const ASM_PRELUDE = `.set noat
.set noreorder
.set gp=64
.macro glabel label, visibility=global
    .\\visibility \\label
    .type \\label, @function
    \\label:
.endm
.macro endlabel label
    .size \\label, . - \\label
.endm
.macro alabel label, visibility=global
    .\\visibility \\label
    .type \\label, @function
    \\label:
.endm
.macro jlabel label, visibility=local
    \\label:
.endm
.macro dlabel label, visibility=global
    .\\visibility \\label
    .type \\label, @object
    \\label:
.endm
.macro enddlabel label
    .size \\label, . - \\label
.endm
.macro nonmatching label, size=1
.endm
` + [
  ["fv0", 0], ["fv0f", 1], ["fv1", 2], ["fv1f", 3], ["ft0", 4], ["ft0f", 5], ["ft1", 6], ["ft1f", 7], ["ft2", 8], ["ft2f", 9],
  ["ft3", 10], ["ft3f", 11], ["fa0", 12], ["fa0f", 13], ["fa1", 14], ["fa1f", 15], ["ft4", 16], ["ft4f", 17], ["ft5", 18], ["ft5f", 19],
  ["fs0", 20], ["fs0f", 21], ["fs1", 22], ["fs1f", 23], ["fs2", 24], ["fs2f", 25], ["fs3", 26], ["fs3f", 27], ["fs4", 28], ["fs4f", 29],
  ["fs5", 30], ["fs5f", 31],
].map(([n, i]) => `.set $${n}, $f${i}`).join("\n") + "\n";

/**
 * Rewrite a splat nonmatching .s so GNU as accepts it standalone: strip the
 * `nonmatching` size markers, turn `.late_rodata` into a real `.rodata`
 * section appended after the text (asm-processor's convention), keep the
 * `.text` function intact.
 */
export function prepareTargetAsm(asmText) {
  const lines = asmText.split("\n");
  const text = [], late = [], rodata = [];
  let section = ".text";
  for (const line of lines) {
    const m = /^\s*\.section\s+(\S+)/.exec(line);
    if (m) { section = m[1]; continue; }
    if (/^\s*nonmatching\s/.test(line)) continue;
    if (/^\s*\.(rdata|late_rodata_alignment)\b/.test(line)) continue;
    if (section === ".late_rodata") late.push(line);
    else if (section === ".rodata" || section === ".rdata") rodata.push(line);
    else if (section === ".text") text.push(line);
    // .data/.bss carried by a function .s are not part of the .text comparison.
  }
  let out = ASM_PRELUDE + "\n.section .text\n" + text.join("\n") + "\n";
  if (rodata.length || late.length) out += "\n.section .rodata\n" + rodata.join("\n") + "\n" + late.join("\n") + "\n";
  return out;
}

/**
 * Assemble a splat .s into target.o with the project's assembler.
 * @param {{asmText:string, outDir:string, as:string, asFlags:string[], includeDirs:string[], cwd:string, env?:object}} a
 */
export async function assembleTarget({ asmText, outDir, as, asFlags, includeDirs, cwd, env }) {
  await mkdir(outDir, { recursive: true });
  const sPath = path.join(outDir, "target.s");
  const oPath = path.join(outDir, "target.o");
  const prepared = prepareTargetAsm(asmText);
  await writeFile(sPath, prepared);
  const args = [...asFlags, ...includeDirs.flatMap((d) => ["-I", d]), "-o", oPath, sPath];
  const r = await run(as, args, { cwd, env });
  if (r.code !== 0) throw new Error(`assembling target failed (${as} ${args.join(" ")}): ${r.stderr.slice(0, 800)}`);
  return { targetS: sPath, targetO: oPath, sha256: createHash("sha256").update(prepared).digest("hex") };
}

/**
 * objdump -dr a relocatable object and parse it into per-symbol instruction
 * streams. Each instruction: {offset, word, mnemonic, operands, reloc:{type,symbol,addend}|null}.
 * @param {{objdump:string, objPath:string, cwd?:string, env?:object, sections?:string[]}} a
 */
export async function dumpObject({ objdump, objPath, cwd, env, extraFlags = [] }) {
  const args = ["--disassemble", "--reloc", "--disassemble-zeroes", "-Mreg-names=32", "-Mno-aliases", ...extraFlags, objPath];
  const r = await run(objdump, args, { cwd, env });
  if (r.code !== 0) throw new Error(`objdump failed on ${objPath}: ${r.stderr.slice(0, 600)}`);
  return parseObjdump(r.stdout);
}

/**
 * Parse `objdump -dr` text. Handles the GNU layout:
 *   Disassembly of section .text:
 *   00000000 <func>:
 *      0:	27bdffd8 	addiu	sp,sp,-40
 *      8:	0c000000 	jal	0 <func>
 *   			8: R_MIPS_26	other_func
 */
export function parseObjdump(text) {
  const sections = new Map(); // section → Map(symbol → {name, offset, instructions[]})
  let section = null, cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m;
    if ((m = /^Disassembly of section (\S+):/.exec(line))) { section = m[1]; if (!sections.has(section)) sections.set(section, new Map()); cur = null; continue; }
    if ((m = /^([0-9a-f]+) <([^>]+)>:\s*$/.exec(line))) {
      if (!section) continue;
      cur = { name: m[2], offset: parseInt(m[1], 16), instructions: [], section };
      sections.get(section).set(m[2], cur);
      continue;
    }
    if (!cur) continue;
    if ((m = /^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s*(?:\t|\s{2,})?(\S+)?\s*(.*)$/.exec(line)) && !/R_MIPS/.test(line)) {
      const offset = parseInt(m[1], 16);
      const word = parseInt(m[2], 16) >>> 0;
      const mnemonic = m[3] ?? "";
      let operands = (m[4] ?? "").trim();
      // Drop objdump's `<sym+off>` annotation on branch/jump targets; we re-derive targets from the word.
      operands = operands.replace(/\s*<[^>]*>\s*$/, "");
      cur.instructions.push({ offset, word, mnemonic, operands, reloc: null });
      continue;
    }
    if ((m = /^\s*([0-9a-f]+):\s+(R_MIPS_\w+)\s+(\S+?)(?:([+-]0x[0-9a-f]+))?\s*$/.exec(line))) {
      const off = parseInt(m[1], 16);
      const ins = cur.instructions.find((i) => i.offset === off) ?? cur.instructions[cur.instructions.length - 1];
      if (ins) ins.reloc = { type: m[2], symbol: m[3], addend: m[4] ? Number(m[4]) : 0 };
      continue;
    }
  }
  return { sections };
}

/** Find a symbol's instruction stream in a parsed dump (any section). */
export function findSymbol(dump, name) {
  for (const [, syms] of dump.sections) if (syms.has(name)) return syms.get(name);
  return null;
}

/** Raw section bytes of an object (objcopy -O binary -j <section>). */
export async function sectionBytes({ objcopy, objPath, section, cwd, env, tmpPath }) {
  const r = await run(objcopy, ["-O", "binary", "--only-section=" + section, objPath, tmpPath], { cwd, env });
  if (r.code !== 0) return null;
  const { readFile } = await import("node:fs/promises");
  try { return await readFile(tmpPath); } catch { return null; }
}

/** `objdump -t` symbol table: name → {value, size, section, type:'F'|'O'|..., global}. */
export async function symbolTable({ objdump, objPath, cwd, env }) {
  const r = await run(objdump, ["-t", objPath], { cwd, env });
  if (r.code !== 0) throw new Error(`objdump -t failed on ${objPath}: ${r.stderr.slice(0, 400)}`);
  const out = new Map();
  for (const line of r.stdout.split("\n")) {
    // 00003b68 g     F .text	000000f8 func_801DEB08
    const m = /^([0-9a-f]+)\s+([lgw ]|[lgw!])\s+([dDFOf ]{1,3})?\s*(\S+)\s+([0-9a-f]+)\s+(\S+)\s*$/.exec(line);
    if (!m) continue;
    out.set(m[6], { value: parseInt(m[1], 16), size: parseInt(m[5], 16), section: m[4], type: (m[3] ?? "").trim(), global: m[2] === "g" });
  }
  return out;
}

/** Trim an instruction stream to a symbol's declared size (drops section-end padding). */
export function trimToSize(stream, sizeBytes) {
  if (!sizeBytes) return stream;
  const n = Math.floor(sizeBytes / 4);
  return stream.length > n ? stream.slice(0, n) : stream;
}
