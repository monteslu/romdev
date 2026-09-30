// Recompiled 68000 blocks for the sync32 Genesis runtime (rd_blocks*.c).
//
// Input: the cartridge image and a coverage record (coverage.js, measured on
// the exact cart): the executed instruction addresses and the (pc, next pc)
// pairs seen. A block starts at every address control can arrive at other
// than by falling through (jump/call/return targets, interrupt entries,
// the instruction after anything that ends a block) and runs straight on
// while the next instruction was executed and is not itself a block start.
// Code the coverage never saw is not compiled: Musashi interprets it.
//
// Each instruction is gpgx's Musashi handler partially evaluated for that
// opcode at that address (ctrans-c.js). Around it the block adds what
// m68k_run's loop does per instruction, in one of two timing profiles:
//
//   fast:  the refresh-delay check once per block; base cycles accumulated
//          and added before the next instruction that calls out (memory,
//          SR, interrupts) and at the end, so every access still sees the
//          same clock; the block runs to its end even past the m68k_run
//          target (line and interrupt timing move to block granularity).
//   exact: refresh check and cycles per instruction, and the block stops as
//          soon as the m68k_run target is reached, exactly where gpgx's loop
//          stops. The 68000 is then instruction-for-instruction gpgx.
//
// Both keep two gpgx behaviours that reach back into the CPU from I/O: a
// VDP write that raises the delayed interrupt runs the NEXT instruction from
// inside the handler (m68k_set_irq_delay), and SR writes take interrupts.
// After such a write the block ends as gpgx's loop would.
//
// LICENSE: the output is derived from Genesis Plus GX (non-commercial).
//
// Plain JS ESM + JSDoc.

import { loadGpgxData } from "../../wat/genesis/gpgx-data.js";
import { TrError } from "../../wat/genesis/ctrans.js";
import { translateM68kC } from "./ctrans-c.js";

const hx = (v) => (v >>> 0).toString(16).padStart(6, "0");
const fname = (pc) => `rdb_${hx(pc)}`;

/**
 * @param {{image:Uint8Array, normalized:Uint8Array}} cart from index.js cartImage
 * @param {{pcs:Iterable<number>|Map<number,number>, pairs:Iterable<number>, irqTargets?:Iterable<number>, profile?:'fast'|'exact', maxInsns?:number, files?:number, onlyHot?:number}} cov
 */
export async function emitBlocks(cart, cov) {
  const profile = cov.profile ?? "exact";
  if (profile !== "fast" && profile !== "exact") throw new Error(`genesis native: options.profile must be 'fast' or 'exact', got '${profile}'`);
  const D = loadGpgxData();
  const rom = cart.normalized;
  const size = cart.image.length;
  const f16 = (p) => { p &= size - 1; return (rom[p] << 8 | rom[p + 1]) & 0xffff; };
  const pcList = [...(cov.pcs instanceof Map ? cov.pcs.keys() : cov.pcs)].map((p) => p >>> 0);
  const romPcs = pcList.filter((p) => p < 0x400000 && !(p & 1)).sort((a, b) => a - b);
  const executed = new Set(romPcs);

  // translate every executed instruction once
  const ins = new Map();
  const failed = [];
  for (const pc of romPcs) {
    try {
      ins.set(pc, translateM68kC(D.m68k, f16(pc), pc, f16, `L${hx(pc)}_`));
    } catch (e) {
      if (!(e instanceof TrError)) throw e;
      failed.push({ pc, error: e.message });
    }
  }
  const straight = (pc) => { const t = ins.get(pc); return t && t.nextPc === ((pc + t.length) >>> 0) && !t.pcMoved; };

  // block starts
  const leaders = new Set();
  const addLeader = (p) => { if (ins.has(p)) leaders.add(p); };
  for (const p of cov.irqTargets ?? []) addLeader(p >>> 0);
  for (const key of cov.pairs ?? []) {
    const a = Math.floor(key / 0x1000000), b = key % 0x1000000;
    const t = ins.get(a);
    // An rte lands wherever the interrupt was taken, which in the exact
    // profile is any instruction boundary: starting blocks there would split
    // loops (and wait loops) that are only ever entered mid-way by a return.
    // The dispatcher interprets up to the next block start instead.
    if (t && t.handler === "m68k_op_rte_32") continue;
    if (!t || b !== ((a + t.length) >>> 0) || !straight(a)) addLeader(b);
  }
  for (const [pc, t] of ins) {
    if (!straight(pc)) {
      addLeader((pc + t.length) >>> 0);
      if (t.nextPc != null) addLeader(t.nextPc);
    }
  }
  for (const pc of ins.keys()) {
    // reached only by a jump the pairs did not show (coverage from several runs)
    let isSucc = false;
    for (let back = 2; back <= 10 && !isSucc; back += 2) {
      const q = pc - back, t = ins.get(q);
      if (t && ((q + t.length) >>> 0) === pc && straight(q)) isSucc = true;
    }
    if (!isSucc) leaders.add(pc);
  }

  const maxInsns = cov.maxInsns ?? 48;
  const blocks = [];
  for (const start of [...leaders].sort((a, b) => a - b)) {
    const list = [];
    let pc = start;
    for (;;) {
      const t = ins.get(pc);
      if (!t) break;
      list.push(pc);
      if (!straight(pc) || list.length >= maxInsns) break;
      const nx = (pc + t.length) >>> 0;
      if (!executed.has(nx) || leaders.has(nx) || !ins.has(nx)) break;
      pc = nx;
    }
    if (list.length) blocks.push({ start, list });
  }
  const blockAt = new Set(blocks.map((b) => b.start));
  const ref = (pc) => (blockAt.has(pc) ? `(const void *)${fname(pc)}` : "0");

  // emit
  const bodies = blocks.map((b) => blockC(b, ins, profile, ref));
  const nfiles = Math.max(1, cov.files ?? Math.min(12, Math.ceil(blocks.length / 400)));
  const files = {};
  const proto = blocks.map((b) => `const void *${fname(b.start)}(void);`).join("\n");
  files["rd_blocks_gen.h"] = `/* Generated by romdev: prototypes of the recompiled 68000 blocks. */\n#ifndef _RD_BLOCKS_GEN_H_\n#define _RD_BLOCKS_GEN_H_\n${proto}\n#endif\n`;
  const per = Math.ceil(blocks.length / nfiles);
  for (let i = 0; i < nfiles; i++) {
    const part = bodies.slice(i * per, (i + 1) * per);
    files[`rd_blocks${i}.c`] = PRELUDE(profile) + part.join("\n");
  }
  files["rd_blocks.c"] = `/* Generated by romdev: block table, sorted by pc. */\n#include "rd_blocks.h"\n#include "rd_blocks_gen.h"\n`
    + `const rd_block_entry_t rd_block_table[${blocks.length || 1}] = {\n${blocks.map((b) => `  { 0x${hx(b.start)}u, ${fname(b.start)} }`).join(",\n") || "  { 0xffffffffu, 0 }"}\n};\n`
    + `const unsigned int rd_block_count = ${blocks.length};\n`;
  const compiledInsns = blocks.reduce((s, b) => s + b.list.length, 0);
  return {
    files,
    stats: {
      profile,
      executedPcs: romPcs.length,
      compiledPcs: compiledInsns,
      blocks: blocks.length,
      translateFailures: failed.length,
      ...(failed.length ? { failures: failed.slice(0, 20).map((f) => ({ pc: "$" + hx(f.pc), error: f.error })) } : {}),
      maxBlockInsns: Math.max(0, ...blocks.map((b) => b.list.length)),
      meanBlockInsns: blocks.length ? Math.round(compiledInsns / blocks.length * 10) / 10 : 0,
      cFiles: nfiles,
    },
  };
}

const PRELUDE = (profile) => `/* Generated by romdev: recompiled 68000 blocks (${profile} profile).
   Each function is a run of 68000 instructions, every one of them gpgx's
   Musashi handler specialised for its opcode at its address. Derived from
   Genesis Plus GX (non-commercial). Do not edit. */
#include "shared.h"
#define m68ki_cpu m68k
#define MUL (7)
extern const unsigned char *const rd_m68ki_cycles;
#define m68ki_cycles rd_m68ki_cycles
#include "m68kconf.h"
#include "m68kcpu.h"
#include "rd_blocks.h"
#include "rd_runtime.h"
#include "rd_blocks_gen.h"
#define RD_RAW16(a) (*(unsigned short *)(m68k.memory_map[((a)>>16)&0xff].base + ((a) & 0xffff)))
#define RD_RAW8(a) ((m68k.memory_map[((a)>>16)&0xff].base)[((a) & 0xffff)^1])
void rd_UseDivuCycles(uint32 dst, uint32 src);
void rd_UseDivsCycles(sint32 dst, sint16 src);
void rd_UseMuluCycles(uint16 src);
void rd_UseMulsCycles(sint16 src);
#define RD_REFRESH() if (m68k.cycles >= m68k.refresh_cycles) { m68k.refresh_cycles = m68k.cycles + (128*7); m68k.cycles += (2*7); }
`;

/** C for one block. */
function blockC(b, ins, profile, ref) {
  const out = [];
  out.push(`const void *${fname(b.start)}(void)\n{`);
  let pend = 0;          // base cycles not yet added (fast)
  const flush = () => { if (pend) { out.push(`  m68k.cycles += ${pend};`); pend = 0; } };
  if (profile === "fast") out.push("  RD_REFRESH()");
  const n = b.list.length;
  for (let k = 0; k < n; k++) {
    const pc = b.list[k];
    const t = ins.get(pc);
    const last = k === n - 1;
    const calls = t.calls > 0 || t.pcMoved;
    if (profile === "exact") out.push("  RD_REFRESH()");
    else if (calls) flush();
    out.push(`  { /* ${hx(pc)} ${t.handler} */`);
    if (t.locals.length) out.push(`    uint32 ${t.locals.join(", ")};`);
    if (t.usesRead) out.push(`    m68k.ir = 0x${t.ir.toString(16)}u;`);
    out.push(`    ${t.body}`);
    if (t.writes) {
      // m68k_set_irq_delay ran the next instruction inside this one's write:
      // gpgx then adds that instruction's base cycles (REG_IR now holds it)
      // instead of this one's, and continues from REG_PC.
      out.push(`    if (rd_irq_delay_abort) { rd_irq_delay_abort = 0; rd_stats.irq_delay_aborts++; ${pend ? `m68k.cycles += ${pend}; ` : ""}m68k.cycles += rd_m68ki_cycles[m68k.ir]; rd_stats.blk_insns += ${k + 1}; return 0; }`);
    }
    out.push("  }");
    if (profile === "exact") {
      out.push(`  m68k.cycles += ${t.cycles};`);
      if (!last) out.push(`  if (m68k.cycles >= (int)rd_cycle_target) { m68k.pc = 0x${hx(b.list[k + 1])}u; rd_stats.blk_insns += ${k + 1}; return 0; }`);
    } else {
      pend += t.cycles;
    }
  }
  flush();
  out.push(`  rd_stats.blk_insns += ${n};`);
  const t = ins.get(b.list[n - 1]);
  const lastPc = b.list[n - 1];
  if (idleLoop(b, ins)) {
    // A wait loop (read RAM, branch back): nothing can change the RAM it reads
    // before this m68k_run returns (interrupts are taken only between
    // m68k_run calls or on SR writes), so every further iteration is the same
    // as this one. Run out the clock with the same per-instruction refresh,
    // cycle and cut-off rules instead of re-executing the reads.
    out.push(`  if (m68k.pc == 0x${hx(b.start)}u) {`);
    if (profile === "exact") {
      // gpgx's loop: check the target, then refresh and run the instruction
      out.push("    for (;;) {");
      for (const pc of b.list) {
        out.push(`      if (m68k.cycles >= (int)rd_cycle_target) { m68k.pc = 0x${hx(pc)}u; return 0; }`);
        out.push(`      RD_REFRESH() m68k.cycles += ${ins.get(pc).cycles}; rd_stats.reserved[1]++;`);
      }
      out.push("    }");
    } else {
      const sum = b.list.reduce((s, pc) => s + ins.get(pc).cycles, 0);
      out.push(`    while (m68k.cycles < (int)rd_cycle_target) { RD_REFRESH() m68k.cycles += ${sum}; rd_stats.reserved[1] += ${n}; }`);
      out.push("    return 0;");
    }
    out.push("  }");
  }
  if (t.nextPc != null && !t.pcMoved) {
    out.push(`  m68k.pc = 0x${hx(t.nextPc)}u;`);
    out.push(`  return ${ref(t.nextPc)};`);
  } else {
    // two-way or dynamic: m68k.pc was set in the body
    const cands = twoWay(t, lastPc);
    if (cands.length && !t.pcMoved) out.push(`  ${cands.map((c) => `if (m68k.pc == 0x${hx(c)}u) return ${ref(c)};`).join(" ")}`);
    out.push("  return 0;");
  }
  out.push("}\n");
  return out.join("\n");
}

const IDLE_BRANCH = /^m68k_op_(?:b(?:hi|ls|cc|cs|ne|eq|vc|vs|pl|mi|ge|lt|gt|le)|bra)_(?:8|16)$/;
const SIDE_EFFECT = /m68k\.(?:dar\[\d+\]|sp\[\d\]|x_flag|cycles|refresh_cycles|stopped|int_mask|int_level|s_flag|t1_flag|poll\.\w+)\s*=/;

/**
 * A block that only reads work RAM at fixed addresses, sets the condition
 * flags, and branches back to its own start (tst.b ($F62A).w / bne.s *-4):
 * a loop waiting for an interrupt handler to change memory.
 */
function idleLoop(b, ins) {
  const n = b.list.length;
  if (n < 1 || n > 4) return false;
  const last = ins.get(b.list[n - 1]);
  if (!IDLE_BRANCH.test(last.handler) || last.writes || last.pcMoved) return false;
  if (!(last.nextPc === b.start || twoWay(last).includes(b.start))) return false;
  for (let k = 0; k < n - 1; k++) {
    const t = ins.get(b.list[k]);
    if (t.writes || t.pcMoved || SIDE_EFFECT.test(t.body)) return false;
    const reads = [...t.body.matchAll(/m68ki_read_(?:8|16|32)\(0x([0-9a-f]+)u\)/g)].map((m) => parseInt(m[1], 16));
    if (reads.length !== t.calls || reads.some((a) => ((a >>> 16) & 0xff) < 0xe0)) return false;
  }
  return true;
}

/** Constant pcs a two-way instruction's body can leave in m68k.pc. */
function twoWay(t) {
  const set = new Set();
  for (const m of t.body.matchAll(/m68k\.pc = 0x([0-9a-f]+)u;/g)) set.add(parseInt(m[1], 16));
  return [...set];
}

