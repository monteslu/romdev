// Block index for the Game Boy WAT backend: one {m, o, n} record per ROM
// offset, straight from romdev's IR decode (irRecords, all alignments). No
// HTTP, no JSONL round trip.
//
// OPERANDS ARE CPU ADDRESSES, NOT FILE OFFSETS. The emitter keys its dispatch
// arms by ROM offset but sets `$pc` to a CPU address and maps pc -> offset at
// run time through `$rombank`, so a branch target must be what the CPU sees:
// $0000-$3FFF for bank 0, $4000-$7FFF for the banked window. The IR exporter
// guarantees that (gbWindows + gbFixOps in gb-metadata.js).
//
// Operand width follows the operand's ROLE, not the encoding length: a `jr`
// is two bytes but its operand is an absolute 16-bit target, and keying width
// off the length truncated `jr z,$0086` to `jr z,$86`.
import { irPlan, irRecords, newIrStats } from "../../export-z80-ir.js";

/** Mnemonics whose operand is an absolute address whatever the encoding width. */
const JUMPS = new Set(["jr", "jp", "call"]);
/** The IR spells numbers C-style (`0x020c`); `$` and `L` label forms are accepted too. */
const TOK = /L[0-9A-Fa-f]{6}|0x[0-9A-Fa-f]+|\$[0-9A-Fa-f]+/g;

function tokValue(t) {
  return parseInt(t.startsWith("0x") ? t.slice(2) : t.slice(1), 16);
}

/**
 * Normalise an operand string to the emitter's spelling: `$XXXX` for a
 * 16-bit role, `$XX` for an 8-bit one, `rst` vectors as `L0000NN`.
 * @param {string} mnem lowercased mnemonic
 * @param {string} ops
 * @param {number} n instruction length
 */
export function normOps(mnem, ops, n) {
  if (mnem === "rst") {
    TOK.lastIndex = 0;
    const m = TOK.exec(ops);
    if (!m) return ops;
    const v = parseInt(m[0].replace(/^[L$]+/, "").replace("0x", ""), 16);
    return "L" + v.toString(16).toUpperCase().padStart(6, "0");
  }
  const width = JUMPS.has(mnem) || n >= 3 ? 4 : 2;
  return ops.replace(TOK, (t) => {
    const v = tokValue(t) & (width === 4 ? 0xffff : 0xff);
    return "$" + v.toString(16).toUpperCase().padStart(width, "0");
  });
}

const UNDEF_OPS = new Set([0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD]);

/**
 * Fold one IR record into the block index. Primary wins; a secondary record
 * is an alternative reading of the same bytes and never displaces the tiling.
 * @param {Map<number, {m:string,o:string,n:number}>} blocks
 * @param {object} r IR record
 * @returns {boolean} true when the record was a ROM-end truncation
 */
export function addRecord(blocks, r) {
  const off = r.off;
  if (blocks.has(off) && r.alignment !== "primary") return false;
  if (r.mnemonic == null) {
    // `truncated-at-rom-end`: an opcode whose operands would run past EOF.
    // It becomes a TRAPPING arm (mnemonic `?`), never a silent nop. Any other
    // null mnemonic is an undecoded instruction and is refused.
    if (r.decodeStatus !== "truncated-at-rom-end") {
      throw new Error(`gb blocks: offset 0x${off.toString(16)} has no mnemonic (decodeStatus=${r.decodeStatus}); not a ROM-end truncation, so this is an undecoded instruction, not a tail byte`);
    }
    blocks.set(off, { m: "?", o: "", n: 1 });
    return true;
  }
  const m = r.mnemonic.toLowerCase();
  // The SM83's unused opcodes: gambatte's CPU switch has no body for them
  // (cpu.cpp: "not specified. should freeze." then break), so each is the
  // 4-cycle opcode fetch and nothing else, one byte long - a nop.
  if (m === "defb" && r.len === 1 && UNDEF_OPS.has(tokValue((r.ops || "").trim()) & 0xFF)) {
    blocks.set(off, { m: "nop", o: "", n: 1 });
    return false;
  }
  // STOP is TWO bytes on the LR35902 (`10 00`): gambatte skips the byte after
  // the opcode (cpu.cpp case 0x10: pc + 1 after the fetch). objdump prints
  // it as a one-byte `stop`, which woke the cart onto the padding byte: one
  // extra nop and a pc one short of gambatte's while it slept.
  const n = m === "stop" ? 2 : r.len;
  blocks.set(off, { m, o: normOps(m, r.ops || "", r.len), n });
  return false;
}

/**
 * Decode every offset of a Game Boy ROM through romdev's IR exporter and
 * build the emitter's block index. Refuses a partial index: a hole would be
 * a silent trap at run time.
 * @param {Uint8Array} rom
 * @returns {Promise<Map<number, {m:string,o:string,n:number}>>}
 */
export async function discoverBlocks(rom) {
  const buf = Buffer.isBuffer(rom) ? rom : Buffer.from(rom.buffer, rom.byteOffset, rom.byteLength);
  const { isa, windows } = irPlan(buf, { platform: "gb", allOffsets: true });
  const st = newIrStats();
  const blocks = new Map();
  for await (const r of irRecords(buf, isa, windows, { wantAllAlignments: true, st })) addRecord(blocks, r);
  if (blocks.size !== buf.length) {
    const missing = [];
    for (let i = 0; i < buf.length && missing.length < 8; i++) if (!blocks.has(i)) missing.push(i);
    throw new Error(`gb blocks INCOMPLETE: ${buf.length - blocks.size} offsets have no record (first ${missing.join(",")}). A hole becomes a silent trap at run time, so no partial index is used.`);
  }
  return blocks;
}

/**
 * A block index from its JSON form ({"<offset>": {m,o,n}}), e.g. a cached
 * or externally supplied one.
 * @param {Record<string, {m:string,o?:string,n:number}>} obj
 */
export function blocksFromJson(obj) {
  const blocks = new Map();
  for (const [k, v] of Object.entries(obj)) blocks.set(Number(k), { m: v.m, o: v.o ?? "", n: v.n });
  return blocks;
}

let catalogue = null;
/**
 * Every SM83 opcode (and every $CB opcode) as the IR decode spells it, for
 * the RAM interpreter's templates: RAM code may use opcodes the ROM's own
 * code never does. Decoded once from a synthetic image (opcode, $A5, $C3).
 * @returns {Promise<{ops: Map<number,{m:string,o:string,n:number}>, cb: Map<number,{m:string,o:string,n:number}>}>}
 */
export async function opcodeCatalogue() {
  if (catalogue) return catalogue;
  const img = new Uint8Array(0x8000);
  for (let op = 0; op < 256; op++) img.set([op, 0xA5, 0xC3, 0x00], op * 16);
  for (let op = 0; op < 256; op++) img.set([0xCB, op, 0x00, 0x00], 0x1000 + op * 4);
  const b = await discoverBlocks(img);
  const ops = new Map(), cb = new Map();
  for (let op = 0; op < 256; op++) if (op !== 0xCB) ops.set(op, b.get(op * 16));
  for (let op = 0; op < 256; op++) cb.set(op, b.get(0x1000 + op * 4));
  catalogue = { ops, cb };
  return catalogue;
}
