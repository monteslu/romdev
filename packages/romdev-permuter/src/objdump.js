// objdump.js - a port of decomp-permuter's src/objdump.py: per-arch settings,
// the objdump text simplifier the scorer diffs, relocation folding, and the
// ELF machine sniff. Disassembly itself runs romdev's WASM binutils (never a
// host objdump); see runObjdump().
import { readFileSync } from "node:fs";
import path from "node:path";
import { runWasmTool, runRawFsTool } from "./wasm-tool.js";

// Ignore registers, for cleaner output. (Upstream: False.)
const ign_regs = false;
// Skip branch-likely delay slots. (Upstream: False.)
const skip_bl_delay_slots = false;
const skip_lines = 1;
const re_int = /-?[0-9]+/g;
const re_int_full = /(?<![0-9a-zA-Z_])-?[0-9]+\b/g;

const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** @typedef {{row: string, mnemonic: string, has_symbol: boolean}} Line */

/**
 * @typedef {object} ArchSettings
 * @property {string} name
 * @property {string[]} executable
 * @property {string[]} arguments
 * @property {RegExp} re_comment
 * @property {RegExp} re_reg
 * @property {RegExp} re_sprel
 * @property {RegExp} re_includes_sp
 * @property {string[]} sp_ref_insns
 * @property {string} reloc_str
 * @property {Set<string>} branch_instructions
 * @property {Set<string>} forbidden
 * @property {Set<string>} branch_likely_instructions
 */

const forbiddenDefault = () => new Set((ASCII_LETTERS + "_").split(""));

export const MIPS_BRANCH_LIKELY_INSTRUCTIONS = new Set([
  "beql", "bnel", "beqzl", "bnezl", "bgezl", "bgtzl", "blezl", "bltzl", "bc1tl", "bc1fl",
]);
export const MIPS_BRANCH_INSTRUCTIONS = new Set([
  "b", "j", "beq", "bne", "beqz", "bnez", "bgez", "bgtz", "blez", "bltz", "bc1t", "bc1f",
  ...MIPS_BRANCH_LIKELY_INSTRUCTIONS,
]);
const PPC_BRANCH_INSTRUCTIONS = new Set([
  "b", "beq", "beq+", "beq-", "bne", "bne+", "bne-", "blt", "blt+", "blt-", "ble", "ble+", "ble-",
  "bdnz", "bdnz+", "bdnz-", "bge", "bge+", "bge-", "bgt", "bgt+", "bgt-",
]);
const ARM32_BRANCH_INSTRUCTIONS = new Set();
for (const prefix of ["b", "bl"]) {
  for (const cond of ["", "eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al"]) {
    for (const suffix of ["", ".n", ".w"]) ARM32_BRANCH_INSTRUCTIONS.add(prefix + cond + suffix);
  }
}
const X86_BRANCH_INSTRUCTIONS = new Set([
  "jmp", "ljmp", "ja", "jae", "jb", "jbe", "jc", "jcxz", "jecxz", "jrcxz", "je", "jg", "jge", "jl", "jle",
  "jna", "jnae", "jnb", "jnbe", "jnc", "jne", "jng", "jnge", "jnl", "jnle", "jno", "jnp", "jns", "jnz",
  "jo", "jp", "jpe", "jpo", "js", "jz", "call",
]);

/** @type {ArchSettings} */
export const MIPS_SETTINGS = {
  name: "mips",
  re_comment: /<.*?>/g,
  re_reg: /\$?\b(a[0-3]|t[0-9]|s[0-8]|at|v[01]|f[12]?[0-9]|f3[01]|k[01]|fp|ra)\b/g,
  re_sprel: /(?<=,)([0-9]+|0x[0-9a-f]+)\((sp|s8)\)/g,
  re_includes_sp: /\b(sp|s8)\b/,
  sp_ref_insns: ["addiu"],
  reloc_str: "R_MIPS_",
  executable: ["mips-linux-gnu-objdump", "mips64-linux-gnu-objdump", "mips64-elf-objdump"],
  arguments: ["-drz", "-m", "mips:4300"],
  branch_likely_instructions: MIPS_BRANCH_LIKELY_INSTRUCTIONS,
  branch_instructions: MIPS_BRANCH_INSTRUCTIONS,
  forbidden: forbiddenDefault(),
};

/** @type {ArchSettings} */
export const PPC_SETTINGS = {
  name: "ppc",
  re_includes_sp: /\b(r1)\b/,
  sp_ref_insns: [],
  re_comment: /(<.*>|\/\/.*$)/g,
  re_reg: /\$?\b([rf](?:[02-9]|[1-9][0-9]+)|f1)\b/g,
  re_sprel: /(?<=,)(-?[0-9]+|-?0x[0-9a-f]+)\(r1\)/g,
  reloc_str: "R_PPC_",
  executable: ["powerpc-eabi-objdump"],
  arguments: ["-dr", "-EB", "-mpowerpc", "-M", "broadway"],
  branch_instructions: PPC_BRANCH_INSTRUCTIONS,
  branch_likely_instructions: new Set(),
  forbidden: forbiddenDefault(),
};

/** @type {ArchSettings} */
export const ARM32_SETTINGS = {
  name: "arm32",
  re_includes_sp: /\b(sp)\b/,
  sp_ref_insns: ["add", "sub"],
  re_comment: /(<.*>|\/\/.*$)/g,
  re_reg: /\$?\b([rq][0-9]|[rq]1[0-5]|pc|lr|[ds][12]?[0-9]|[ds]3[01]|fp(scr|exc|sid))\b/g,
  re_sprel: /sp, #-?(0x[0-9a-fA-F]+|[0-9]+)\b/g,
  reloc_str: "R_ARM_",
  executable: ["arm-none-eabi-objdump"],
  arguments: ["-drz"],
  branch_instructions: ARM32_BRANCH_INSTRUCTIONS,
  branch_likely_instructions: new Set(),
  forbidden: forbiddenDefault(),
};

/** @type {ArchSettings} */
export const X86_SETTINGS = {
  name: "x86",
  re_comment: /<.*>/g,
  re_includes_sp: /\b(%esp)\b/,
  sp_ref_insns: ["add", "sub"],
  re_reg: /%?\b(e?(?:(?:[sd]i|[sb]p)l?|[abcd][xhl])|[cdesfg]s|cr[0-7]|x?mm[0-7]|st)\b/g,
  re_sprel: /-?(0x[0-9a-f]+|[0-9]+)(?=\((%ebp|%esi)\))/g,
  reloc_str: "R_386_",
  executable: ["objdump"],
  arguments: ["-d", "--no-show-raw-insn"],
  branch_instructions: X86_BRANCH_INSTRUCTIONS,
  branch_likely_instructions: new Set(),
  forbidden: forbiddenDefault(),
};

/** Pick arch settings from the ELF header's e_machine (objdump.get_arch). */
export function get_arch(o_file) {
  const data = typeof o_file === "string" ? readFileSync(o_file).subarray(0, 20) : o_file.subarray(0, 20);
  const arch = data[5] === 2 ? (data[18] << 8) + data[19] : (data[19] << 8) + data[18];
  if (arch === 3) return X86_SETTINGS;
  if (arch === 8) return MIPS_SETTINGS;
  if (arch === 20) return PPC_SETTINGS;
  if (arch === 40) return ARM32_SETTINGS;
  throw new Error("Bad ELF");
}

export class PermuterAssertionError extends Error {
  constructor(message = "") { super(message); this.name = "AssertionError"; }
}
function assert(cond, msg) { if (!cond) throw new PermuterAssertionError(msg); }

/** Python str.split() with no arguments. */
export function pySplitWs(s) { return s.split(/\s+/).filter((x) => x !== ""); }

/** Python str.split(None, 1). */
export function pySplitWs1(s) {
  const t = s.replace(/^\s+/, "");
  if (!t) return [];
  const m = /\s+/.exec(t);
  if (!m) return [t];
  const rest = t.slice(m.index + m[0].length);
  return rest ? [t.slice(0, m.index), rest] : [t.slice(0, m.index)];
}

export function parse_relocated_line(line) {
  let ind2 = -1;
  let found = false;
  for (const c of ",\t ") {
    if (line.includes(c)) { ind2 = line.lastIndexOf(c); found = true; break; }
  }
  if (!found) throw new Error(`failed to parse relocated line: ${line}`);
  const before = line.slice(0, ind2 + 1);
  let after = line.slice(ind2 + 1);
  const ind3 = after.indexOf("(");
  let imm;
  if (ind3 === -1) { imm = after; after = ""; }
  else { imm = after.slice(0, ind3); after = after.slice(ind3); }
  if (imm === "0x0") imm = "0";
  return [before, imm, after];
}

export function pre_process(mnemonic, args, next_row) {
  if (next_row && next_row.includes("R_PPC_EMB_SDA21")) {
    args = args.replaceAll("(r2)", "(0)").replaceAll("(r13)", "(0)").replaceAll(",r2,", ",0,").replaceAll(",r13,", ",0,");
    if (mnemonic === "li" || mnemonic === "lis") {
      mnemonic = mnemonic.replace("li", "addi");
      const args_parts = args.split(",");
      args = args_parts[0] + ",0," + args_parts[1];
    }
  }
  return [mnemonic, args];
}

export function process_mips_reloc(reloc_row, prev, repl, imm) {
  if (reloc_row.includes("R_MIPS_JALR") || reloc_row.includes("R_MIPS_NONE")) return repl;
  if (imm !== "0" && imm !== "imm" && imm !== "addr") repl += (imm.startsWith("-") ? "" : "+") + imm;
  if (["R_MIPS_LO16", "R_MIPS_LITERAL", "R_MIPS_GPREL16"].some((r) => reloc_row.includes(r))) repl = `%lo(${repl})`;
  else if (reloc_row.includes("R_MIPS_GOT16")) repl = `%got(${repl})`;
  else if (reloc_row.includes("R_MIPS_CALL16")) repl = `%call16(${repl})`;
  else if (reloc_row.includes("R_MIPS_HI16")) repl = `%hi(${repl})`;
  else assert(reloc_row.includes("R_MIPS_26"), `unknown relocation type '${reloc_row}'`);
  return repl;
}

export function process_ppc_reloc(reloc_row, prev, repl) {
  assert(["R_PPC_REL24", "R_PPC_ADDR16", "R_PPC_EMB_SDA21"].some((r) => reloc_row.includes(r)),
    `unknown relocation type '${reloc_row}' for line '${prev}'`);
  if (reloc_row.includes("R_PPC_REL24")) return repl;
  if (reloc_row.includes("R_PPC_ADDR16_HI")) return `${repl}@h`;
  if (reloc_row.includes("R_PPC_ADDR16_HA")) return `${repl}@ha`;
  if (reloc_row.includes("R_PPC_ADDR16_LO")) return `${repl}@l`;
  if (reloc_row.includes("R_PPC_ADDR16")) {
    if (repl.includes("+0x7")) {
      if (parseInt(repl.split("+")[1], 16) > 0x70000000) return repl.split("+")[0];
    }
  } else if (reloc_row.includes("R_PPC_EMB_SDA21")) {
    return `${repl}@sda21`;
  }
  return repl;
}

export function process_arm32_reloc(reloc_row, prev, repl) {
  assert(["R_ARM_THM_CALL", "R_ARM_CALL", "R_ARM_ABS32"].some((r) => reloc_row.includes(r)),
    `unknown relocation type '${reloc_row}' for line '${prev}'`);
  return repl;
}

export function process_x86_reloc(reloc_row, prev, repl) {
  const ignore = ["WRTSEG", "FIWRQQ", "FIDRQQ", "FIERQQ", "FICRQQ", "FISRQQ", "FIARQQ", "FIFRQQ", "FIGRQQ",
    "FJCRQQ", "FJSRQQ", "FJARQQ", "FJFRQQ", "FJGRQQ"];
  if (ignore.some((x) => reloc_row.includes(x))) return repl;
  repl = pySplitWs(reloc_row).at(-1);
  const [mnemonic, args] = pySplitWs1(prev);
  let offset = false;
  let addr_imm = null;
  if (mnemonic.includes("lcall")) addr_imm = /.*/.exec(args);
  else if (X86_BRANCH_INSTRUCTIONS.has(mnemonic) || mnemonic.includes("call")) {
    addr_imm = /(^|(?<=\*)|(?<=\*%cs:))[0-9a-f]+(?!x)/.exec(args);
  }
  if (!addr_imm) addr_imm = /(?:0x)?(?<![1-9])0$/.exec(args);
  if (!addr_imm) addr_imm = /(?<=,)(?:0x)?0+(?=\(.*\))/.exec(args);
  if (!addr_imm) addr_imm = /(^\$?|(?<=\*))(?:0x)?0(?!x)/.exec(args);
  if (!addr_imm) { addr_imm = /(?:-)?(?:0x)?[0-9a-f]+$/.exec(args); offset = true; }
  if (!addr_imm) { addr_imm = /(?<=,)(?:-)?(?:0x)?[0-9a-f]+/.exec(args); offset = true; }
  if (!addr_imm) { addr_imm = /(^|(?<=\*)|(?:\$))(?:-)?(?:0x)?[0-9a-f]+/.exec(args); offset = true; }
  if (!addr_imm) { addr_imm = /(^|(?<=\*)|(?<=%[fgdecs]s:))(?:-)?(?:0x)?[0-9a-f]+/.exec(args); offset = true; }
  assert(addr_imm, `failed to find address immediate for line '${prev}'`);
  const has = (s) => reloc_row.includes(s);
  if (has("R_386_NONE") || has("R_386_32") || has("R_386_PC32") || has("R_386_16") || has("R_386_PC16")
    || has("R_386_8") || has("R_386_PC8")) { /* pass */ }
  else if (has("dir32")) { if (repl.includes("+")) repl = repl.split("+")[0]; }
  else if (has("DISP32") || has("OFF16") || has("OFF32")) { /* pass */ }
  else if (has("OFFPC16") || has("OFFPC32")) { if (repl.includes("+")) repl = repl.split("+")[0]; }
  else if (has("R_386_GOT32")) repl = `%got(${repl})`;
  else if (has("R_386_PLT32")) repl = `%plt(${repl})`;
  else if (has("R_386_RELATIVE")) repl = `%rel(${repl})`;
  else if (has("R_386_GOTOFF") || has("R_386_GOTPC")) repl = `%got(${repl})`;
  else if (has("R_386_32PLT")) repl = `%plt(${repl})`;
  else if (has("FAR16")) { if (repl.includes("+")) repl = repl.split("+")[0]; }
  else if (has("SEG")) { /* pass */ }
  else assert(false, `unknown relocation type '${reloc_row}' for line '${prev}'`);
  if (offset) {
    let of = addr_imm[0];
    if (of[0] === "$") of = of.slice(1);
    repl = of[0] === "-" ? `${repl}${of}` : `${repl}+${of}`;
  }
  return repl;
}

export function process_reloc(reloc_row, prev, ign_branch_targets) {
  if (prev === "<skipped>") return null;
  const [before, imm, after] = parse_relocated_line(prev);
  const repl = pySplitWs(reloc_row).at(-1);
  if (imm === "<target>") {
    assert(ign_branch_targets);
    return null;
  }
  let new_repl;
  if (reloc_row.includes("R_MIPS_")) new_repl = process_mips_reloc(reloc_row, prev, repl, imm);
  else if (reloc_row.includes("R_PPC_")) new_repl = process_ppc_reloc(reloc_row, prev, repl);
  else if (reloc_row.includes("R_ARM_")) new_repl = process_arm32_reloc(reloc_row, prev, repl);
  else if (reloc_row.includes("R_386_")) new_repl = process_x86_reloc(reloc_row, prev, repl);
  else throw new Error(`unknown relocation type: ${reloc_row}`);
  return before + new_repl + after;
}

/** Python hex(int(s)) for a decimal digit string with optional '-'. */
function pyHexOfDecimal(s) {
  const neg = s.startsWith("-");
  const v = BigInt(neg ? s.slice(1) : s);
  return (neg && v !== 0n ? "-" : "") + "0x" + v.toString(16);
}

/**
 * simplify_objdump: objdump -dr text lines -> Line[] the scorer diffs.
 * @param {string[]} input_lines
 * @param {ArchSettings} arch
 * @param {{stack_differences: boolean, ign_branch_targets: boolean}} opts
 * @returns {Line[]}
 */
export function simplify_objdump(input_lines, arch, { stack_differences, ign_branch_targets }) {
  /** @type {Line[]} */
  const output_lines = [];
  let skip_next = false;
  const noRawInsn = arch.arguments.includes("--no-show-raw-insn");
  for (let index = 0; index < input_lines.length; index++) {
    let row = input_lines[index];
    if (index < skip_lines) continue;
    row = row.replace(/\s+$/, "");
    if (row.includes(">:") || !row) continue;
    row = row.replace(arch.re_comment, "");
    row = row.replace(/\s+$/, "");
    const tabs = row.split("\t");
    row = noRawInsn ? tabs.slice(1).join("\t") : tabs.slice(2).join("\t");
    if (!row) continue;
    let row_parts;
    if (row.includes("\t")) {
      const k = row.indexOf("\t");
      row_parts = [row.slice(0, k), row.slice(k + 1)];
    } else {
      const k = row.indexOf(" ");
      row_parts = (k === -1 ? [row] : [row.slice(0, k), row.slice(k + 1)]).map((part) => part.replace(/^\s+/, ""));
    }
    let mnemonic = row_parts[0].trim();
    let args = row_parts.length >= 2 ? row_parts[1].trim() : "";
    const next_line = index + 1 < input_lines.length ? input_lines[index + 1] : null;
    [mnemonic, args] = pre_process(mnemonic, args, next_line);
    row = mnemonic + "\t" + args.replaceAll("\t", "  ");
    if (row.includes(arch.reloc_str)) {
      const modified_prev = process_reloc(row, output_lines[output_lines.length - 1].row, ign_branch_targets);
      if (modified_prev) {
        output_lines[output_lines.length - 1].row = modified_prev;
        output_lines[output_lines.length - 1].has_symbol = true;
      }
      continue;
    }
    if (skip_next) {
      skip_next = false;
      row = "<skipped>";
      mnemonic = "<skipped>";
    }
    if (ign_regs) row = row.replace(arch.re_reg, "<reg>");
    if (!stack_differences) {
      if (arch.sp_ref_insns.includes(mnemonic) && arch.re_includes_sp.test(args)) row = row.replace(re_int_full, "imm");
    }
    if (arch.branch_instructions.has(mnemonic)) {
      if (ign_branch_targets) {
        const instr_parts = args.split(",");
        instr_parts[instr_parts.length - 1] = "<target>";
        args = instr_parts.join(",");
        row = `${mnemonic}\t${args}`;
      }
      // The last part is in hex, so skip the dec->hex conversion
    } else {
      const cur = row;
      row = cur.replace(re_int, (full, offset) => {
        if (full.length <= 1) return full;
        const start = offset, end = offset + full.length;
        if (start && arch.forbidden.has(cur[start - 1])) return full;
        if (end < cur.length && arch.forbidden.has(cur[end])) return full;
        return pyHexOfDecimal(full);
      });
    }
    if (arch.branch_likely_instructions.has(mnemonic) && skip_bl_delay_slots) skip_next = true;
    if (!stack_differences) row = row.replace(arch.re_sprel, "addr(sp)");
    output_lines.push({ row, has_symbol: false, mnemonic });
  }
  while (output_lines.length && output_lines[output_lines.length - 1].mnemonic === "nop") output_lines.pop();
  return output_lines;
}

/**
 * WASM objdump glue per arch. The caller (romdev) resolves these from its
 * toolchain packages; `setObjdumpGlue` lets it register them.
 * @type {Record<string, string>}
 */
const objdumpGlue = {};

export function setObjdumpGlue(archName, gluePath) { objdumpGlue[archName] = gluePath; }

/** Resolve the glue for an arch: registered path, else the romdev toolchain package. */
export async function resolveObjdumpGlue(archName) {
  if (objdumpGlue[archName]) return objdumpGlue[archName];
  if (archName === "mips") {
    // The mips-linux-gnu build: the same objdump romdev's compare path runs.
    try {
      const { toolchain } = await import("romdev-toolchain-mips-gcc");
      objdumpGlue.mips = toolchain["mips-linux-gnu-objdump"].gluePath;
      return objdumpGlue.mips;
    } catch { /* not installed */ }
  }
  throw new Error(`no WASM objdump registered for arch '${archName}' (romdev runs binutils as WASM only; register one with setObjdumpGlue)`);
}

/**
 * Disassemble an object with the WASM objdump and simplify it (objdump.objdump).
 * `objdump_command` is the settings.toml string split into argv: its first
 * element names the host tool upstream would run and is replaced by the WASM
 * build; the flags are kept.
 * @param {string|Uint8Array} o_file path or object bytes
 * @param {ArchSettings} arch
 * @param {{objdump_command?: string[]|null, stack_differences?: boolean, ign_branch_targets?: boolean}} opts
 * @returns {Promise<Line[]>}
 */
export async function objdump(o_file, arch, { objdump_command = null, stack_differences = false, ign_branch_targets = false } = {}) {
  const args = objdump_command ? objdump_command.slice(1) : arch.arguments;
  const glue = await resolveObjdumpGlue(arch.name);
  let r;
  if (usesRawFs(glue)) {
    if (typeof o_file !== "string") throw new Error("a NODERAWFS objdump reads the object from disk: pass a path");
    r = await runRawFsTool(glue, [...args, path.resolve(o_file)], { argv0: "mips-linux-gnu-objdump" });
  } else {
    const bytes = typeof o_file === "string" ? readFileSync(o_file) : o_file;
    r = await runWasmTool(glue, [...args, "/work/in.o"], { "/work/in.o": bytes });
  }
  if (r.exitCode !== 0) throw new Error(`objdump exited ${r.exitCode}: ${r.stderr.slice(0, 400)}`);
  const lines = splitlines(r.stdout);
  return simplify_objdump(lines, arch, { stack_differences, ign_branch_targets });
}

const rawFs = new Map();
/** Was this emscripten tool built with NODERAWFS (host filesystem) rather than MEMFS? */
function usesRawFs(glue) {
  if (!rawFs.has(glue)) rawFs.set(glue, /NODERAWFS/.test(readFileSync(glue, "utf8")));
  return rawFs.get(glue);
}

/** Python str.splitlines() for \n / \r\n / \r text. */
export function splitlines(s) {
  const out = s.split(/\r\n|\r|\n/);
  if (out.length && out[out.length - 1] === "") out.pop();
  return out;
}
