// scorer.js - a port of decomp-permuter's src/scorer.py. Scores a candidate
// object against the target by diffing simplified objdump output: difflib
// opcodes over mnemonics, then per-field penalties on "equal" lines and
// reorder/insert/delete penalties for the rest.
import { createHash } from "node:crypto";
import { SequenceMatcher } from "./difflib.js";
import { opcodes as levenshteinOpcodes } from "./levenshtein.js";
import { get_arch, objdump, pySplitWs1 } from "./objdump.js";

export const PENALTY_INF = 10 ** 9;
export const PENALTY_STACKDIFF = 1;
export const PENALTY_BRANCHDIFF = 1;
export const PENALTY_REGALLOC = 5;
export const PENALTY_REORDERING = 60;
export const PENALTY_INSERTION = 100;
export const PENALTY_DELETION = 100;

/** shlex.split for the objdump_command setting (POSIX mode quoting). */
export function shlexSplit(s) {
  const out = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      cur ??= "";
      const e = s.indexOf("'", i + 1);
      if (e < 0) throw new Error("No closing quotation");
      cur += s.slice(i + 1, e);
      i = e;
    } else if (c === "\"") {
      cur ??= "";
      i++;
      while (i < s.length && s[i] !== "\"") {
        if (s[i] === "\\" && i + 1 < s.length && "\\\"$`\n".includes(s[i + 1])) { cur += s[i + 1]; i += 2; continue; }
        cur += s[i++];
      }
      if (i >= s.length) throw new Error("No closing quotation");
    } else if (c === "\\") {
      cur ??= "";
      if (i + 1 < s.length) { if (s[i + 1] !== "\n") cur += s[i + 1]; i++; }
    } else if (/\s/.test(c)) {
      if (cur != null) { out.push(cur); cur = null; }
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (cur != null) out.push(cur);
  return out;
}

/** int(s, 0) for the stack-offset field (decimal without leading zeros, or 0x/0o/0b). */
function pyInt0(s) {
  const m = /^\s*([+-]?)(0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|[1-9][0-9]*|0+)\s*$/.exec(s.replaceAll("_", ""));
  if (!m) throw new Error(`invalid literal for int() with base 0: '${s}'`);
  const body = m[2];
  let v;
  if (/^0[xX]/.test(body)) v = parseInt(body.slice(2), 16);
  else if (/^0[oO]/.test(body)) v = parseInt(body.slice(2), 8);
  else if (/^0[bB]/.test(body)) v = parseInt(body.slice(2), 2);
  else v = parseInt(body, 10);
  return m[1] === "-" ? -v : v;
}

function fieldMatchesAnySymbol(field, arch) {
  if (arch.name === "ppc") {
    if (field.includes("...")) return true;
    const k = field.lastIndexOf("@");
    if (k >= 0 && ["l", "h", "ha", "sda21"].includes(field.slice(k + 1))) field = field.slice(0, k);
    return /^@\d+$/.test(field);
  }
  if (arch.name === "mips") return field.includes(".");
  if (arch.name === "arm32") return field.includes(".");
  return false;
}

const RE_PAREN = /(?<!%hi)(?<!%lo)\(/;

export class Scorer {
  static PENALTY_INF = PENALTY_INF;

  /**
   * Use Scorer.create(): the target is disassembled asynchronously.
   * @param {{target_o: string, stack_differences: boolean, algorithm: string, debug_mode: boolean, ign_branch_targets: boolean, objdump_command: string|null}} opts
   */
  constructor(opts) {
    this.target_o = opts.target_o;
    this.arch = get_arch(opts.target_o);
    this.stack_differences = opts.stack_differences;
    this.algorithm = opts.algorithm ?? "difflib";
    this.debug_mode = opts.debug_mode;
    this.objdump_command = opts.objdump_command || "";
    this.ign_branch_targets = opts.ign_branch_targets;
    this.PENALTY_INF = PENALTY_INF;
    this.debugLog = [];
    if (this.algorithm !== "difflib" && this.algorithm !== "levenshtein") throw new Error(`unknown diff algorithm ${this.algorithm}`);
    // re.search needs a non-global copy of the stack-relative pattern.
    this.re_sprel_search = new RegExp(this.arch.re_sprel.source, this.arch.re_sprel.flags.replace("g", ""));
  }

  static async create(opts) {
    const s = new Scorer(opts);
    [, s.target_seq] = await s._objdump(s.target_o);
    s.difflib_differ = new SequenceMatcher({ autojunk: false });
    s.difflib_differ.set_seq2(s.target_seq.map((line) => line.mnemonic));
    return s;
  }

  async _objdump(o_file) {
    const objdump_command = this.objdump_command ? shlexSplit(this.objdump_command) : null;
    const lines = await objdump(o_file, this.arch, {
      objdump_command, stack_differences: this.stack_differences, ign_branch_targets: this.ign_branch_targets,
    });
    return [lines.map((line) => line.row).join("\n"), lines];
  }

  /**
   * @param {string|Uint8Array|null} cand_o object path/bytes, or null for a failed compile
   * @returns {Promise<[number, string]>} [score, sha256 of the simplified disassembly]
   */
  async score(cand_o) {
    if (!cand_o) return [PENALTY_INF, ""];
    const [objdump_output, cand_seq] = await this._objdump(cand_o);
    return this.scoreLines(objdump_output, cand_seq);
  }

  /** The scoring proper, on an already simplified candidate disassembly. */
  scoreLines(objdump_output, cand_seq) {
    let num_stack_penalties = 0;
    let num_branch_penalties = 0;
    let num_regalloc_penalties = 0;
    let num_reordering_penalties = 0;
    let num_insertion_penalties = 0;
    let num_deletion_penalties = 0;
    const deletions = [];
    const insertions = [];
    const arch = this.arch;

    const diff_sameline = (old_line, new_line) => {
      const old_stack = num_stack_penalties, old_branch = num_branch_penalties, old_regalloc = num_regalloc_penalties;
      const old = old_line.row, neu = new_line.row;
      if (old === neu) return false;
      let ignore_last_field = false;
      if (this.stack_differences) {
        const oldsp = this.re_sprel_search.exec(old);
        const newsp = this.re_sprel_search.exec(neu);
        if (oldsp && newsp) {
          const oldrel = pyInt0(oldsp[1] || "0");
          const newrel = pyInt0(newsp[1] || "0");
          num_stack_penalties += Math.abs(oldrel - newrel);
          ignore_last_field = true;
        }
      }
      if (!this.ign_branch_targets) {
        const b_instr = arch.branch_instructions, bl_instr = arch.branch_likely_instructions;
        if (old_line.mnemonic === new_line.mnemonic
          && (b_instr.has(old_line.mnemonic) || bl_instr.has(old_line.mnemonic))
          && old_line.row !== new_line.row && !old_line.has_symbol && !new_line.has_symbol) {
          const old_target = old_line.row.split(",").at(-1);
          const new_target = new_line.row.split(",").at(-1);
          if (old_target !== new_target) {
            num_branch_penalties += 1;
            ignore_last_field = true;
          }
        }
      }
      const new_parts = pySplitWs1(neu), old_parts = pySplitWs1(old);
      let newfields = new_parts.length > 1 ? new_parts[1].split(",") : [];
      let oldfields = old_parts.length > 1 ? old_parts[1].split(",") : [];
      if (ignore_last_field) {
        newfields = newfields.slice(0, -1);
        oldfields = oldfields.slice(0, -1);
      } else {
        oldfields = oldfields.slice(0, -1).concat(oldfields.length > 0 ? oldfields.at(-1).split(RE_PAREN) : []);
        newfields = newfields.slice(0, -1).concat(newfields.length > 0 ? newfields.at(-1).split(RE_PAREN) : []);
      }
      const n = Math.min(newfields.length, oldfields.length);
      for (let k = 0; k < n; k++) {
        const nf = newfields[k], of = oldfields[k];
        if (nf !== of) {
          if (fieldMatchesAnySymbol(nf, arch) && old_line.has_symbol) continue;
          num_regalloc_penalties += 1;
        }
      }
      num_regalloc_penalties += Math.abs(newfields.length - oldfields.length);
      return old_regalloc !== num_regalloc_penalties || old_stack !== num_stack_penalties || old_branch !== num_branch_penalties;
    };

    let result_diff;
    if (this.algorithm === "levenshtein") {
      // Upstream remaps mnemonics to characters (a fresh map per score) and
      // diffs the two strings with Levenshtein.opcodes(cand, target).
      const remapping = new Map();
      const remap = (seq) => seq.map((m) => {
        if (!remapping.has(m)) remapping.set(m, remapping.size);
        return remapping.get(m);
      });
      result_diff = levenshteinOpcodes(remap(cand_seq.map((l) => l.mnemonic)), remap(this.target_seq.map((l) => l.mnemonic)));
    } else {
      this.difflib_differ.set_seq1(cand_seq.map((line) => line.mnemonic));
      result_diff = this.difflib_differ.get_opcodes();
    }
    const equal_no_diff = new Set();
    for (const [tag, i1, i2, j1, j2] of result_diff) {
      if (tag === "equal") {
        for (let k = 0; k < i2 - i1; k++) {
          if (!diff_sameline(this.target_seq[j1 + k], cand_seq[i1 + k])) equal_no_diff.add(i1 + k);
        }
      }
      if (tag === "replace" || tag === "delete") for (let k = i1; k < i2; k++) insertions.push(cand_seq[k].row);
      if (tag === "replace" || tag === "insert") for (let k = j1; k < j2; k++) deletions.push(this.target_seq[k].row);
    }

    if (this.debug_mode) this.debugLog.push(this._formatDebugDiff(result_diff, cand_seq, equal_no_diff));

    // Counter(insertions) + Counter(deletions), iterated in first-seen order.
    const ins = new Map(), dels = new Map(), keys = new Map();
    for (const x of insertions) { ins.set(x, (ins.get(x) ?? 0) + 1); keys.set(x, true); }
    for (const x of deletions) { dels.set(x, (dels.get(x) ?? 0) + 1); keys.set(x, true); }
    for (const item of keys.keys()) {
      const i = ins.get(item) ?? 0, d = dels.get(item) ?? 0;
      const common = Math.min(i, d);
      num_insertion_penalties += i - common;
      num_deletion_penalties += d - common;
      num_reordering_penalties += common;
    }

    const final_score = num_stack_penalties * PENALTY_STACKDIFF
      + num_branch_penalties * PENALTY_BRANCHDIFF
      + num_regalloc_penalties * PENALTY_REGALLOC
      + num_reordering_penalties * PENALTY_REORDERING
      + num_insertion_penalties * PENALTY_INSERTION
      + num_deletion_penalties * PENALTY_DELETION;
    this.lastPenalties = {
      stack: num_stack_penalties, branch: num_branch_penalties, regalloc: num_regalloc_penalties,
      reordering: num_reordering_penalties, insertion: num_insertion_penalties, deletion: num_deletion_penalties,
    };
    return [final_score, createHash("sha256").update(objdump_output, "utf8").digest("hex")];
  }

  _formatDebugDiff(result_diff, cand_seq, equal_no_diff) {
    const mnemMax = Math.max(0, ...this.target_seq.map((l) => l.mnemonic.length), ...cand_seq.map((l) => l.mnemonic.length));
    const fmt = (line, maxLen) => {
      const k = line.indexOf("\t");
      if (k < 0) return line;
      let s = line.slice(0, k).padEnd(mnemMax) + "  " + line.slice(k + 1);
      if (maxLen) s = s.slice(0, maxLen);
      return s;
    };
    const out = [];
    for (const [tag, i1, i2, j1, j2] of result_diff) {
      if (tag === "equal") {
        for (let k = 0; k < i2 - i1; k++) {
          const same = equal_no_diff.has(i1 + k);
          out.push(`${same ? "\u001b[0m" : "\u001b[94m"}${fmt(this.target_seq[j1 + k].row, 40).padEnd(40)}\t${fmt(cand_seq[i1 + k].row)}`);
        }
      }
      if (tag === "replace" || tag === "delete") for (let k = i1; k < i2; k++) out.push(`\u001b[32;1m${"".padEnd(40)}\t${fmt(cand_seq[k].row)}`);
      if (tag === "replace" || tag === "insert") for (let k = j1; k < j2; k++) out.push(`\u001b[91;1m${fmt(this.target_seq[k].row)}\t`);
    }
    out.push("\u001b[0m");
    return out.join("\n");
  }
}
