// objdump.js — run a native GNU binutils objdump (compiled to WASM) over a raw
// binary blob and normalize its output into romdev's annotated-asm shape.
//
// WHY native objdump: the hand-rolled per-CPU JS decoders (m68kdasm/z80dasm/
// sm83dasm) drop real instructions to `.dc.w` and desync the byte stream. The
// binutils disassembler is the authoritative, complete decoder for each ISA —
// and we ALREADY compile binutils to WASM for the m68k and ARM toolchains, so
// `<target>-objdump` ships inside the matching toolchain package alongside
// as/ld/objcopy.
//
// Output shape: each instruction line becomes
//     <mnemonic> <operands>            ; <ADDR> <hexbytes>
// with absolute operands rewritten to `$XXXX` and intra-blob targets to
// `L______` labels — matching what scanAsmForReferences/disassembleProject
// already parse for the da65 (6502) path.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { runIsolated, binaryFile } from "./_worker/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-arch glue lives in the matching toolchain package; resolve it there,
// falling back to a local src copy during dev. `pkg` is the npm package and
// `file` the glue basename inside its wasm/ dir.
function resolveGlue(pkg, file, localSubdir) {
  try {
    const u = import.meta.resolve(pkg);
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", file);
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, localSubdir ?? "", "wasm", file);
  if (existsSync(local)) return local;
  return null;
}

/** Arch → { glue, bfdMachine } registry. Add a row when a new objdump ships. */
const ARCHES = {
  m68k: () => ({
    glue: resolveGlue("romdev-toolchain-m68k-gcc", "m68k-elf-objdump.mjs", "m68k-elf-gcc"),
    machine: "m68k",
  }),
  arm: () => ({
    // ARM/Thumb binutils ships in romdev-platform-gba (the GBA platform bundles
    // the arm-none-eabi toolchain — same place as/ld/objcopy live).
    glue: resolveGlue("romdev-platform-gba", "arm-none-eabi-objdump.mjs", "arm-none-eabi-gcc"),
    machine: "arm",
  }),
  thumb: () => ({
    // Thumb is the same objdump with the force-thumb disassembler flavor.
    glue: resolveGlue("romdev-platform-gba", "arm-none-eabi-objdump.mjs", "arm-none-eabi-gcc"),
    machine: "arm",
    extraArgs: ["-M", "force-thumb"],
  }),
  z80: () => ({
    // SMS / Game Gear / MSX — plain Z80. binutils' z80 objdump (ships in the
    // sdcc toolchain package, which already serves Z80 builds).
    glue: resolveGlue("romdev-toolchain-sdcc", "z80-elf-objdump.mjs", "z80"),
    machine: "z80",
  }),
  gbz80: () => ({
    // Game Boy / Color — SM83 / LR35902. The SAME z80 binutils objdump handles
    // it via the gbz80 machine (binutils z80-dis.c has full INSS_GBZ80 support).
    glue: resolveGlue("romdev-toolchain-sdcc", "z80-elf-objdump.mjs", "z80"),
    machine: "gbz80",
  }),
};

/** True if a native objdump is available for this arch (glue resolves). */
export function objdumpAvailable(arch) {
  const a = ARCHES[arch]?.();
  return !!(a && a.glue);
}

/**
 * Disassemble a raw binary blob with native objdump.
 * @param {object} args
 * @param {Uint8Array} args.bytes
 * @param {'m68k'|'arm'|'thumb'|'z80'} args.arch
 * @param {number} [args.startAddress] VMA of the first byte (default 0)
 * @returns {Promise<{ asm: string, raw: string, exitCode: number, available: boolean }>}
 */
export async function runObjdump(args) {
  const arch = args.arch;
  const spec = ARCHES[arch]?.();
  if (!spec || !spec.glue) {
    return { asm: "", raw: "", exitCode: -1, available: false };
  }
  const start = args.startAddress ?? 0;
  const argv = [
    "-D",                       // disassemble all sections
    "-b", "binary",             // treat input as a flat binary
    "-m", spec.machine,
    "--adjust-vma=0x" + start.toString(16),
    ...(spec.extraArgs ?? []),
    "/work/in.bin",
  ];
  const r = await runIsolated({
    gluePath: spec.glue,
    argv,
    inputFiles: [binaryFile("/work/in.bin", args.bytes)],
  });
  const raw = r.log ?? "";
  return {
    asm: normalizeObjdump(raw, start),
    raw,
    exitCode: r.exitCode ?? 0,
    available: true,
    ...(r.crash ? { crash: r.crash } : {}),
  };
}

// objdump line format (binary target):
//    "   202:\t46fc 2700      \tmove #0x2700,%sr"
// addr (hex), TAB, space-separated opcode bytes, TAB, mnemonic + operands.
const LINE_RE = /^\s*([0-9a-fA-F]+):\t([0-9a-fA-F ]+?)\s*\t(.*)$/;

/**
 * Convert objdump's raw text into romdev's annotated-asm shape:
 *   <mnemonic> <operands>            ; <ADDR6> <hexbytes>
 * Operands' `0x...` immediates/targets become `$...`; targets that land inside
 * the disassembled range get an `L______` label and a label line is emitted, so
 * scanAsmForReferences + disassembleProject's reference scan work unchanged.
 *
 * @param {string} raw objdump stdout
 * @param {number} startAddress VMA of the first byte
 * @returns {string}
 */
export function normalizeObjdump(raw, startAddress = 0) {
  const lines = raw.split("\n");
  /** @type {{addr:number, bytes:string, mnem:string, ops:string}[]} */
  const rows = [];
  for (const line of lines) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    // objdump groups raw bytes into words (`46fc 2700`); re-split into single
    // space-separated bytes (`46 fc 27 00`) so the `; ADDR bytes` comment is
    // per-byte parseable by the reassembly heal loop.
    const bytes = (m[2].replace(/\s+/g, "").match(/../g) || []).join(" ");
    let text = m[3].trim();
    if (!text) continue;
    // Split mnemonic / operands.
    const sp = text.search(/\s/);
    const mnem = sp < 0 ? text : text.slice(0, sp);
    const ops = sp < 0 ? "" : text.slice(sp + 1).trim();
    rows.push({ addr, bytes, mnem, ops });
  }
  if (!rows.length) return raw; // nothing parsed — return objdump output verbatim

  // Which addresses are branch/call targets that land inside the blob? Those get
  // a label so the reference scanner can resolve operands to them.
  const addrSet = new Set(rows.map((r) => r.addr));
  const labelAt = new Set();
  for (const r of rows) {
    for (const mt of r.ops.matchAll(/0x([0-9a-fA-F]+)/g)) {
      const v = parseInt(mt[1], 16);
      if (addrSet.has(v)) labelAt.add(v);
    }
  }
  const L = (v) => "L" + (v >>> 0).toString(16).toUpperCase().padStart(6, "0");
  const $ = (v, width) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(width ?? 0, "0");

  const out = [
    "; m68k/arm/z80 disassembly (native binutils objdump)",
    `; start $${(startAddress >>> 0).toString(16).toUpperCase()}, ${rows.length} instructions`,
    "",
    '        .setcpu "auto"',
    "",
  ];
  for (const r of rows) {
    if (labelAt.has(r.addr)) out.push(L(r.addr) + ":");
    // Rewrite operand `0x....` → `$....`; in-range targets → labels.
    const ops = r.ops.replace(/0x([0-9a-fA-F]+)/g, (_, h) => {
      const v = parseInt(h, 16);
      if (labelAt.has(v)) return L(v);
      return $(v);
    });
    const addr6 = (r.addr >>> 0).toString(16).toUpperCase().padStart(6, "0");
    const instr = ops ? `${r.mnem} ${ops}` : r.mnem;
    out.push(`        ${instr.padEnd(34)} ; ${addr6} ${r.bytes}`);
  }
  return out.join("\n") + "\n";
}
