// as1-reorganize.js - IDO 5.3 `as1 -R`: the list-scheduler trace the
// assembler already ships behind `cc -Wa,-R`. It is print-only (the traced
// object is byte-identical to the untraced one) and richer than
// DKWB-SCHED-V1: it carries the losing candidates, so the deciding key of
// each selection can be computed here.
//
// Key chain, lexicographic minimum: (start_time, -besttime, -aftercycles,
// -latency, node->addr, node->lineno, ready-list position). node->addr is not
// in the record per candidate, so the chain here has five keys, and the
// report's proof says so. `cycle=` is the selection ordinal within a block.
//
// Plain JS ESM + JSDoc.

import { TRACE_PREFIX, SchedulerEvent } from "./scheduler.js";
import { splitlines, rstrip, strip, hex, pyInt } from "./py.js";

export const AS1_R_GRAMMAR = Object.freeze([
  "BASIC BLOCK: %d",
  "Node %3u: inst %.8x, relocation %u, lineno %u",
  "        before %u, aftercycles %u, maxhazard %u",
  "        afternodes: %u/%d ...",
  "Initial nodes: <ids>",
  "  node %u (INST %d), time = %u, aftercycles = %u, latency = %u, besttime = %d",
  "Picking node %u (INST %d), at %x, best_addr = %x",
]);

const BLOCK_RE = /^\s*BASIC BLOCK:\s*(-?\d+)/;
const NODE_RE = /^\s*Node\s+(\d+):\s*inst\s+([0-9a-fA-F]+),\s*relocation\s+(\d+),\s*lineno\s+(\d+)/;
const INITIAL_RE = /^\s*Initial nodes:/;
const CANDIDATE_RE = /^\s*node\s+(\d+)\s*\(INST\s+(-?\d+)\),\s*time\s*=\s*(\d+),\s*aftercycles\s*=\s*(\d+),\s*latency\s*=\s*(\d+),\s*besttime\s*=\s*(-?\d+)/;
const PICKING_RE = /^\s*Picking node\s+(\d+)\s*\(INST\s+(-?\d+)\),\s*at\s+([0-9a-fA-F]+),\s*best_addr\s*=\s*([0-9a-fA-F]+)/;

/** [name, attribute, maximise] */
const KEYS = [
  ["start-time", "time", false],
  ["besttime", "besttime", true],
  ["aftercycles", "aftercycles", true],
  ["latency", "latency", true],
  ["lineno", "lineno", false],
];

const PRIMARY_OPCODES = new Map([
  [0x02, "j"], [0x03, "jal"], [0x04, "beq"], [0x05, "bne"], [0x06, "blez"], [0x07, "bgtz"], [0x08, "addi"], [0x09, "addiu"],
  [0x0A, "slti"], [0x0B, "sltiu"], [0x0C, "andi"], [0x0D, "ori"], [0x0E, "xori"], [0x0F, "lui"], [0x11, "cop1"], [0x14, "beql"],
  [0x15, "bnel"], [0x16, "blezl"], [0x17, "bgtzl"], [0x18, "daddi"], [0x19, "daddiu"], [0x1A, "ldl"], [0x1B, "ldr"], [0x20, "lb"],
  [0x21, "lh"], [0x22, "lwl"], [0x23, "lw"], [0x24, "lbu"], [0x25, "lhu"], [0x26, "lwr"], [0x27, "lwu"], [0x28, "sb"], [0x29, "sh"],
  [0x2A, "swl"], [0x2B, "sw"], [0x2C, "sdl"], [0x2D, "sdr"], [0x2E, "swr"], [0x31, "lwc1"], [0x35, "ldc1"], [0x37, "ld"],
  [0x39, "swc1"], [0x3D, "sdc1"], [0x3F, "sd"],
]);

const SPECIAL_FUNCTS = new Map([
  [0x00, "sll"], [0x02, "srl"], [0x03, "sra"], [0x04, "sllv"], [0x06, "srlv"], [0x07, "srav"], [0x08, "jr"], [0x09, "jalr"],
  [0x0C, "syscall"], [0x0D, "break"], [0x10, "mfhi"], [0x11, "mthi"], [0x12, "mflo"], [0x13, "mtlo"], [0x18, "mult"],
  [0x19, "multu"], [0x1A, "div"], [0x1B, "divu"], [0x1C, "dmult"], [0x1D, "dmultu"], [0x1E, "ddiv"], [0x1F, "ddivu"],
  [0x20, "add"], [0x21, "addu"], [0x22, "sub"], [0x23, "subu"], [0x24, "and"], [0x25, "or"], [0x26, "xor"], [0x27, "nor"],
  [0x2A, "slt"], [0x2B, "sltu"], [0x2C, "dadd"], [0x2D, "daddu"], [0x2E, "dsub"], [0x2F, "dsubu"],
]);

/** Name one instruction word: only the mnemonic, never invented operands. */
export function mipsMnemonic(word) {
  word = word >>> 0;
  const primary = (word >>> 26) & 0x3F;
  if (primary === 0) {
    const funct = word & 0x3F;
    if (word === 0) return "nop";
    return SPECIAL_FUNCTS.get(funct) ?? `special.${hex(funct, 4, { prefix: true })}`;
  }
  if (primary === 0x01) return "regimm";
  return PRIMARY_OPCODES.get(primary) ?? `op.${hex(primary, 4, { prefix: true })}`;
}

/** One node considered at one selection. */
export class Candidate {
  constructor({ node, inst, time, aftercycles, latency, besttime, position, lineno = null, word = null }) {
    Object.assign(this, { node, inst, time, aftercycles, latency, besttime, position, lineno, word });
    Object.freeze(this);
  }
  asDict() {
    return { node: this.node, inst: this.inst, time: this.time, aftercycles: this.aftercycles, latency: this.latency,
      besttime: this.besttime, position: this.position, lineno: this.lineno, word: this.word === null ? null : `0x${hex(this.word, 8)}` };
  }
}

/** One `Picking node` decision, with the candidates it beat. */
export class Selection {
  constructor({ block, ordinal, chosen, addr, best_addr, candidates, tie }) {
    Object.assign(this, { block, ordinal, chosen, addr, best_addr, candidates, tie });
    Object.freeze(this);
  }
  get winner() { return this.candidates.find((c) => c.node === this.chosen) ?? null; }
  asDict() {
    return { block: this.block, ordinal: this.ordinal, chosen: this.chosen, addr: this.addr, best_addr: this.best_addr,
      tie: this.tie, candidates: this.candidates.map((c) => c.asDict()) };
  }
}

/** Name the first key of the chain on which exactly one candidate wins. */
function decidingKey(candidates, chosen) {
  let remaining = [...candidates];
  if (remaining.length === 1) return "sole-candidate";
  for (const [name, attribute, maximise] of KEYS) {
    const values = remaining.map((c) => c[attribute]);
    if (values.some((v) => v === null || v === undefined)) continue;
    const best = maximise ? Math.max(...values) : Math.min(...values);
    const winners = remaining.filter((c) => c[attribute] === best);
    if (winners.length === 1) return winners[0].node === chosen ? name : `${name}-disagrees`;
    remaining = winners;
  }
  return "list-order";
}

/**
 * Parse one `cc -Wa,-R` trace into [selections, events, ignored].
 * @param {string} text
 * @param {{proc?: number}} [opts]
 */
export function parseAs1ReorganizeTrace(text, { proc = 0 } = {}) {
  const selections = [], events = [], ignored = [];
  const linenos = new Map(), words = new Map();
  let block = null, fallbackBlock = 0;
  // Ordinals accumulate per block: as1 dumps a block again after
  // reorganizing it, and a reset would mint two selections per key.
  const ordinals = new Map();
  let pending = [];
  let seenBlockHeader = false;
  for (const raw of splitlines(text)) {
    const line = rstrip(raw);
    if (!strip(line)) continue;
    let m = BLOCK_RE.exec(line);
    if (m) { block = pyInt(m[1]); seenBlockHeader = true; linenos.clear(); words.clear(); pending = []; continue; }
    m = NODE_RE.exec(line);
    if (m) { const node = pyInt(m[1]); words.set(node, parseInt(m[2], 16)); linenos.set(node, pyInt(m[4])); continue; }
    if (INITIAL_RE.test(line)) {
      if (!seenBlockHeader) { block = fallbackBlock; fallbackBlock += 1; }
      pending = [];
      continue;
    }
    m = CANDIDATE_RE.exec(line);
    if (m) {
      const node = pyInt(m[1]);
      pending.push(new Candidate({ node, inst: pyInt(m[2]), time: pyInt(m[3]), aftercycles: pyInt(m[4]), latency: pyInt(m[5]),
        besttime: pyInt(m[6]), position: pending.length, lineno: linenos.get(node) ?? null, word: words.get(node) ?? null }));
      continue;
    }
    m = PICKING_RE.exec(line);
    if (m) {
      const chosen = pyInt(m[1]);
      const candidates = pending;
      pending = [];
      if (!candidates.length) { ignored.push(raw); continue; }
      const currentBlock = block !== null ? block : 0;
      const ordinal = ordinals.get(currentBlock) ?? 0;
      ordinals.set(currentBlock, ordinal + 1);
      const selection = new Selection({ block: currentBlock, ordinal, chosen, addr: parseInt(m[3], 16), best_addr: parseInt(m[4], 16),
        candidates, tie: decidingKey(candidates, chosen) });
      selections.push(selection);
      const winner = selection.winner;
      const word = (winner ? winner.word : null) || 0;
      events.push(new SchedulerEvent({ proc, block: currentBlock, cycle: ordinal, word, opcode: mipsMnemonic(word),
        line: winner && winner.lineno ? winner.lineno : 0, ready: candidates.length, chosen: `n${chosen}`, tie: selection.tie }));
      continue;
    }
    ignored.push(raw);
  }
  return [selections, events, ignored];
}

/** Render parsed selections as DKWB-SCHED-V1 lines. */
export function toDkwbRecords(events) {
  const lines = [];
  for (const e of events) {
    lines.push(`${TRACE_PREFIX} proc=${e.proc} block=${e.block} cycle=${e.cycle} word=0x${hex(e.word, 8)} `
      + `opcode=${e.opcode} line=${e.line} ready=${e.ready} chosen=${e.chosen} tie=${e.tie}`);
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}
