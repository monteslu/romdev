// File-backed export of the existing decode -> lift pipeline. No emitter and
// no inline megabyte payload. CPU targets remain CPU addresses, never offsets.
import { open, readFile, mkdir, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { runObjdump } from "../../toolchains/objdump.js";
import { liftZ80, DOCUMENTED_Z80 } from "./lift-z80.js";
import { z80Cycles, z80Flags, z80Control, CYCLE_PROVENANCE } from "./z80-metadata.js";
import { smsWindows, SMS_MAPPERS } from "../sms-mapping.js";
import { isaFor, ISAS, PLATFORM_ISA, cpuStatesFor } from "./isa.js";

/** Longest Z80 instruction: DD/FD CB dd op. Bounds the decode lookahead. */
const MAX_Z80_INSTR = 4;
/**
 * Batched decode of ONE instruction at each requested offset.
 *
 * A static recompiler needs the decode at EVERY byte offset, not only at the
 * boundaries of one linear tiling: a computed jump (`jp (hl)`, an rst table, a
 * RAM-built dispatch) can land mid-instruction, and on interleaved code/data it
 * frequently does. The linear tiling answers "who owns this byte"; this answers
 * "what is the instruction if execution starts HERE".
 *
 * Done naively that is one decoder subprocess per offset - ~5ms each, so ~11
 * minutes for a 128KB cart, which is the cost this is meant to remove. Instead
 * each offset contributes a fixed-stride slice to one buffer: MAX_Z80_INSTR
 * real bytes followed by 0x00 padding. The padding is `nop`, so an instruction
 * starting at a slice head cannot reach the next slice, and every slice head
 * decodes independently. Measured: 8,192 offsets resolved in a single 277ms
 * call, 100% hit rate.
 */
const BATCH_MAX = 8192;

/** Default "the decoder produced no instruction here" mnemonics. An ISA whose
 *  decoder spells it differently overrides with isa.dataMnemonics. */
const DEFAULT_DATA_MNEMONICS = new Set([".short", ".word", ".byte", ".inst"]);
function isData(mnem, isa) {
  const m = (mnem || "").toLowerCase();
  return (isa.dataMnemonics ?? DEFAULT_DATA_MNEMONICS).has(m);
}

// The slice stride must EXCEED the ISA's longest instruction, so the zero
// padding after each slice's real bytes cannot be reached by an instruction
// starting at the slice head. Z80's longest is 4 (stride 8); m68k's is 10, so
// a fixed stride of 8 would let one slice decode into the next and silently
// produce wrong instructions. Derived per ISA, rounded up to a power of two so
// slice heads stay cheap to compute.
function strideFor(isa) {
  let s = 8;
  while (s <= isa.maxInstr) s *= 2;
  return s;
}

async function decodeAtOffsets(rom, offsets, isa) {
  /** @type {Map<number, {mnem:string, ops:string, bytes:string}>} */
  const out = new Map();
  const stride = strideFor(isa);
  for (let i = 0; i < offsets.length; i += BATCH_MAX) {
    const slice = offsets.slice(i, i + BATCH_MAX);
    // Fill with the ISA's terminator FIRST, then overwrite each slice head
    // with real bytes. Zero-filling is only correct when 0x00 decodes-and-stops
    // (true on Z80, false on m68k where 0x0000 is `orib`).
    const buf = Buffer.alloc(slice.length * stride);
    for (let b = 0; b < buf.length; b += isa.pad.length) isa.pad.copy(buf, b);
    slice.forEach((off, k) => rom.copy(buf, k * stride, off, Math.min(off + isa.maxInstr, rom.length)));
    // An ISA may carry its OWN decoder (the 6502 does - binutils has no
    // 6502 target). Those decode straight from the ROM at real offsets and
    // skip the batch buffer entirely, which is both simpler and faster.
    if (isa.decode) {
      const got = isa.decode(rom, slice);
      for (const [off, r] of got) out.set(off, r);
      continue;
    }
    const decoded = await runObjdump({ arch: isa.arch, startAddress: 0, bytes: buf });
    if (!decoded.available || decoded.exitCode !== 0 || decoded.crash) {
      throw new Error(`${isa.arch} decoder failed on an alignment batch: ${decoded.raw?.slice(-300)}`);
    }
    const byAddr = new Map(decoded.instructions.map((r) => [r.addr, r]));
    // `decodedAt` = the address objdump decoded this slice at; every
    // pc-relative operand it printed is relative to THAT, not to the offset's
    // real address (decodedIR rebases them).
    slice.forEach((off, k) => { const r = byAddr.get(k * stride); if (r) out.set(off, { ...r, decodedAt: k * stride }); });
  }
  return out;
}

export function irWindows(size, { allOffsets = false, startAddress = 0, length = 4096, bank, fileOffset, slot, mapper = "sega", mapperState } = {}) {
  const bankSize = 0x4000;
  if (!SMS_MAPPERS.includes(mapper)) throw new Error(`Unsupported SMS mapper: ${mapper}`);
  if ((allOffsets || fileOffset != null) && mapperState) throw new Error("mapperState selects a CPU mapping; do not combine it with physical fileOffset/allOffsets export");
  if (allOffsets) {
    if (fileOffset != null || bank != null) throw new Error("allOffsets exports the whole ROM; do not also pass fileOffset or bank");
    return Array.from({ length: Math.ceil(size / bankSize) }, (_, b) => ({
      off: b * bankSize, length: Math.min(bankSize, size - b * bankSize), bank: b,
      addr: (slot ?? Math.min(b, 2)) * bankSize, slot: slot ?? Math.min(b, 2) }));
  }
  if (fileOffset != null) {
    if (fileOffset >= size || fileOffset + length > size) throw new Error("fileOffset/length exceeds ROM size");
    const windows = [];
    for (let off = fileOffset; off < fileOffset + length;) {
      const b = Math.floor(off / bankSize), local = off % bankSize;
      const n = Math.min(bankSize - local, fileOffset + length - off);
      const s = slot ?? Math.min(b, 2);
      windows.push({ off, length: n, bank: b, addr: s * bankSize + local, slot: s }); off += n;
    }
    return windows;
  }
  if (startAddress >= 0xc000) throw new Error("startAddress is a CPU address in RAM, not a ROM file offset; use fileOffset or allOffsets:true for physical ROM bytes");
  if (length > 0xc000 - startAddress) throw new Error("CPU window crosses into RAM; use allOffsets:true for the whole cartridge");
  return smsWindows(size, startAddress, length, { bank, mapper, mapperState });
}

/**
 * Windows for a FLAT address space (Genesis: ROM maps at $000000, no banking).
 *
 * One window per chunk so a single objdump invocation stays bounded, but every
 * window carries bank 0 and addr == off, because the CPU address IS the file
 * offset. Lookahead still applies at each chunk edge for the same reason it
 * does on a bank edge: objdump only sees the bytes it is handed.
 */
export function flatWindows(size, { allOffsets = false, startAddress = 0, length = 4096, fileOffset } = {}) {
  const CHUNK = 0x8000;
  if (allOffsets) {
    return Array.from({ length: Math.ceil(size / CHUNK) }, (_, i) => ({
      off: i * CHUNK, length: Math.min(CHUNK, size - i * CHUNK), bank: 0,
      addr: i * CHUNK, slot: 0 }));
  }
  const off = fileOffset ?? startAddress;
  if (off >= size || off + length > size) throw new Error("window exceeds ROM size");
  return [{ off, length, bank: 0, addr: off, slot: 0 }];
}

/**
 * Move every pc-relative value objdump printed by `delta` (true address minus
 * the address it decoded at). Which tokens are pc-relative is per ISA
 * (`isa.pcRelative`): the branch target of a relative branch (the LAST bare
 * 0x token of `branch` mnemonics), `pcTokens` (m68k %pc@(0x..)) and
 * `comment` (ARM/Thumb `@ (0x..)` literal-pool addresses). Absolute operands
 * (jp nn, abs.w/abs.l EAs, immediates) are never touched.
 * @param {object} isa @param {string} mnemonic @param {string} ops @param {number} delta
 */
export function rebaseOps(isa, mnemonic, ops, delta) {
  const pr = isa.pcRelative;
  if (!delta || !pr || !ops) return ops;
  const move = (hex) => {
    const v = (parseInt(hex, 16) + delta) >>> 0;
    // keep a zero-padded spelling zero-padded (gbz80 prints 0x0003); never add padding
    return v.toString(16).padStart(hex.length > 1 && hex[0] === "0" ? hex.length : 0, "0");
  };
  let out = ops;
  if (pr.pcTokens) out = out.replace(pr.pcTokens, (m, h) => m.slice(0, m.length - h.length) + move(h));
  if (pr.comment) out = out.replace(pr.comment, (m, h) => m.slice(0, m.length - h.length - (m.endsWith(")") ? 1 : 0)) + move(h) + (m.endsWith(")") ? ")" : ""));
  if (pr.branch && pr.branch(mnemonic.toLowerCase())) {
    // the last bare 0x token outside a %pc@(...) operand
    const re = /(^|[\s,])0x([0-9a-f]+)(?![\s\S]*(?:^|[\s,])0x[0-9a-f])/i;
    out = out.replace(re, (m, pre, h) => `${pre}0x${move(h)}`);
  }
  return out;
}

export function decodedIR(row, window, rom, { allowStraddle = false, isa = ISAS.z80 } = {}) {
  const bytes = row.bytes.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
  const off = window.off + row.addr - window.addr;
  const windowEnd = window.off + window.length;
  // AN INSTRUCTION MAY END PAST THE WINDOW. The window is a SLICING artifact,
  // not a decode limit: a bank whose last instruction's operands continue into
  // the next bank is normal (4 of 7 shipped Sega titles do it). What must hold
  // is that the instruction STARTS inside the window and its bytes are really
  // the ROM's - reading past the window edge is fine, reading past the ROM is
  // not.
  const straddles = off + bytes.length > windowEnd;
  // A SECONDARY-alignment record is a decode starting mid-instruction, so it
  // routinely reads past the window; `allowStraddle` says the caller knows. The
  // byte check below is never relaxed: the bytes must be the ROM's real bytes
  // either way.
  if (!bytes.length || off < window.off || off >= windowEnd || off + bytes.length > rom.length
    || (straddles && !allowStraddle && off + bytes.length > rom.length)
    || bytes.some((b, i) => b !== rom[off + i])) throw new Error(`decoder byte/offset mismatch at ROM offset ${off}`);
  const mnemonic = row.mnem.toLowerCase(), len = bytes.length;
  const documented = isa.documented(mnemonic);
  // PC-RELATIVE OPERANDS ARE RECOMPUTED FROM THE BYTES AT THE TRUE ADDRESS.
  // The decoder prints a relative branch's target from the address IT was
  // handed, and that is not always the instruction's CPU address: the
  // all-alignments batch decodes every slice at a fake stride address, so a
  // secondary `jr` came back aimed at the batch buffer (a 32KB cart's $01DA `18 FA`,
  // jr -6, exported as $048C). An ISA that knows its relative encodings
  // rewrites the operand from `bytes` and `row.addr` here, for every record.
  //
  // Every ISA decoded through the batch gets its pc-relative operands rebased
  // from the batch address to the true one (m68k Bcc/BRA/BSR/DBcc targets and
  // %pc@(...) operands, Z80 jr/djnz, ARM/Thumb branches and pc-literal
  // comments): the primary records were right because they are decoded at
  // their real address; every secondary one was off by exactly the distance
  // to its batch slot.
  const rebased = row.decodedAt != null ? rebaseOps(isa, mnemonic, row.ops, row.addr - row.decodedAt) : row.ops;
  const ops = isa.fixOps ? isa.fixOps(mnemonic, rebased, bytes, row.addr) : rebased;
  // `lifted` is Z80-only. A recompiler lowers from mnemonic+ops itself, so an
  // ISA without a lifter omits the field rather than emitting a fake one.
  const lifted = isa.lift ? isa.lift(mnemonic, ops) : undefined;
  return { schema: "romdev-decoded-ir-v1", off, addr: row.addr, bank: window.bank, slot: window.slot,
    bytes, mnemonic, ops, len,
    ...(straddles ? { straddlesWindow: true, windowEnd, bytesBeyondWindow: off + bytes.length - windowEnd,
      straddleNote: "this instruction starts in this bank and its operand bytes continue into the NEXT physical bank. The bytes are the ROM's real bytes; at run time the trailing bytes come from whichever bank is mapped after this one, so treat the decode as correct for this bank's layout and not as proof of the executed operand." } : {}),
    cycles: documented ? isa.cycles(bytes) : null,
    cycleOrder: ["taken-or-repeat", "not-taken-or-final"],
    ...(documented ? isa.control(mnemonic, ops, row.addr, len, bytes)
      : { kind: "unknown", targets: [], fallthrough: null }),
    ...(isa.flags
      ? (documented ? isa.flags(mnemonic, ops) : { flagsRead: null, flagsWritten: null })
      : {}),
    ...(lifted ? { lifted } : {}),
    decodeStatus: documented ? "decoded" : "unknown",
    targetAddressDomain: "cpu", reachability: "unproven-linear-decode" };
}

/**
 * A COMPACT block map: {offset: instructionLength} for every offset that can
 * begin an instruction, plus the manifest's completeness fields.
 *
 * This exists because every consumer of the full IR was re-deriving the same
 * thing: a static recompiler emits one entry point per byte offset, and all it
 * needs per offset is "how long is the instruction here". Reading the whole
 * JSONL to extract one integer per record is wasteful on both sides - a 512KB
 * Genesis cart is ~260k records - and it meant the block map's correctness
 * lived in each consumer instead of here.
 *
 * Runs the SAME export, so the map cannot drift from the decode it summarises.
 */
export async function exportBlockMap(args) {
  const primaryOnly = args.primaryOnly === true;
  const tmp = `${path.resolve(args.outputPath)}.ir.tmp`;
  // A BLOCK MAP IS WHOLE-ROM BY DEFINITION - it answers "what is the
  // instruction at every offset". Forwarding args verbatim meant a caller
  // who did not also pass allOffsets got the default single 4096-byte
  // window, which fails with "window exceeds ROM size" on anything smaller
  // and silently maps only the first 4KB on anything larger. Neither is a
  // block map. An explicit startAddress/length/bank still wins, for the
  // caller who really does want one window.
  // `startAddress` carries a SCHEMA DEFAULT of 0x8000 at the MCP layer, so
  // it is never undefined by the time it arrives here - checking for that is
  // why this worked in-process and still failed through the server. Only an
  // explicitly narrowed request (a real length, fileOffset or bank) means
  // "one window"; a bare blockMap call means the whole ROM.
  const wholeRom = args.length === undefined &&
                   args.fileOffset === undefined &&
                   args.bank === undefined;
  const manifest = await exportZ80IR({
    ...args,
    ...(wholeRom ? { allOffsets: true } : {}),
    outputPath: tmp,
  });
  const { createReadStream } = await import("node:fs");
  const { createInterface } = await import("node:readline");
  const blocks = {};
  let dataOffsets = 0;
  const rl = createInterface({ input: createReadStream(tmp), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const r = JSON.parse(line);
    // BOTH alignments by default. A static recompiler emits one entry point
    // per byte offset, because a computed jump can land mid-instruction - so
    // it needs the decode at offsets the primary tiling never begins an
    // instruction at. Returning only the primary tiling gave 21,689 of 32,768
    // offsets on a real cart and the consumer had to go back to the full IR
    // for the rest, which is the re-derivation this emit exists to remove.
    //
    // `primaryOnly:true` restores the linear tiling, where each byte is owned
    // exactly once - the right choice for a disassembly listing rather than a
    // recompiler.
    if (primaryOnly && r.alignment === "secondary") continue;
    blocks[r.off] = r.len;
    if (r.decodeStatus === "data") dataOffsets++;
  }
  await unlink(tmp).catch(() => {});
  const out = path.resolve(args.outputPath);
  await mkdir(path.dirname(out), { recursive: true });
  const body = JSON.stringify({
    schema: "romdev-blockmap-v1",
    primaryOnly,
    romBytes: manifest.romBytes,
    instructionAlignment: manifest.instructionAlignment ?? 1,
    blockCount: Object.keys(blocks).length,
    dataOffsets,
    coveredBytes: manifest.coveredBytes,
    unresolvedOffsets: manifest.unresolvedOffsets,
    sourceIsa: manifest.provenance?.sourceIsa,
    blocks,
  });
  await (await open(out, "w")).writeFile(body).catch(async (e) => { throw e; });
  return { schema: "romdev-blockmap-manifest-v1", path: out, format: "json",
    romBytes: manifest.romBytes, blockCount: Object.keys(blocks).length,
    dataOffsets, coveredBytes: manifest.coveredBytes,
    unresolvedOffsets: manifest.unresolvedOffsets,
    instructionAlignment: manifest.instructionAlignment ?? 1,
    primaryOnly,
    note: primaryOnly
      ? "blocks maps FILE OFFSET -> instruction length, PRIMARY tiling only: each byte owned by exactly one instruction. Use for a disassembly listing."
      : "blocks maps FILE OFFSET -> instruction length at EVERY offset that can begin an instruction, primary and secondary alignments both. This is what a static recompiler needs: a computed jump can land mid-instruction, so every offset is a potential entry point." };
}

/**
 * The decode as a stream of IR records, in export order: per window, the
 * primary tiling, then (alignments:'all') the secondary decodes. This is the
 * ONE decode path - exportZ80IR serialises it to JSONL, and an in-process
 * consumer (a WAT backend discovering blocks) iterates it directly instead of
 * writing and re-reading hundreds of megabytes of JSONL.
 *
 * `st` accumulates the manifest counters as records are produced.
 * @param {Buffer} rom
 * @param {object} isa ISA descriptor (isa.js)
 * @param {Array<object>} windows
 * @param {{wantAllAlignments?:boolean, st?:object}} [o]
 */
export async function* irRecords(rom, isa, windows, { wantAllAlignments = false, st = newIrStats() } = {}) {
  for (const window of windows) {
    // LOOKAHEAD, so the window's LAST instruction can decode whole.
    //
    // objdump only sees the bytes it is handed. Slicing exactly at the window
    // edge truncated any instruction whose operands continue past it, the
    // decode came up short, and the completeness check below refused the
    // whole cart. Handing it a few trailing bytes lets that instruction
    // decode; records are still only KEPT when they start inside the window,
    // so nothing from the next bank is emitted twice.
    const windowEnd = window.off + window.length;
    const lookahead = Math.min(isa.maxInstr - 1, rom.length - windowEnd);
    // An ISA with its own decoder walks the window linearly here, producing
    // the same {addr, mnemonic, ops, bytes} rows objdump would.
    let decoded;
    if (isa.decodeLinear) {
      decoded = { available: true, exitCode: 0,
                  instructions: isa.decodeLinear(rom, window.off,
                                                 windowEnd + lookahead,
                                                 window.addr) };
    } else {
      decoded = await runObjdump({ arch: isa.arch, startAddress: window.addr, bytes: rom.subarray(window.off, windowEnd + lookahead) });
    }
    if (!decoded.available || decoded.exitCode !== 0 || decoded.crash) throw new Error(`${isa.arch} decoder failed for bank ${window.bank}: ${decoded.raw?.slice(-300)}`);
    let cursor = window.off;
    const primaryStarts = new Set();
    for (const row of decoded.instructions) {
      const rowOff = window.off + row.addr - window.addr;
      if (rowOff >= windowEnd) break;          // belongs to the next window
      const record = decodedIR(row, window, rom, { isa });
      if (record.off !== cursor) throw new Error(`decoder left a gap/overlap at file offset ${cursor}; refusing an incomplete IR export`);
      primaryStarts.add(record.off);
      if (wantAllAlignments) record.alignment = "primary";
      cursor += record.len; st.instrCount++;
      // Coverage counts bytes of THIS window only: a straddling instruction's
      // trailing bytes belong to the next bank and are counted there, so
      // coveredBytes still sums to romBytes exactly.
      st.coveredBytes += Math.min(record.len, windowEnd - record.off);
      if (record.decodeStatus === "unknown") st.unknownCount++;
      if (record.straddlesWindow) st.straddleCount++;
      yield record;
    }
    // Completeness is now "every byte of the window is accounted for", which
    // a straddling final instruction satisfies: it starts inside and its
    // in-window bytes run to the edge.
    //
    // ONE case is not a decoder failure: an opcode sitting in the ROM's final
    // bytes whose operands would run off the END of the file. There is no
    // lookahead to give it and no next bank to take the bytes from, so the
    // trailing bytes are undecodable data. Refusing the whole export for that
    // would block a cart over its last byte or two; they are emitted as
    // `truncated-at-rom-end` records that retain their bytes, the same way
    // unknown opcodes are handled.
    if (cursor < windowEnd && windowEnd === rom.length) {
      const tail = [...rom.subarray(cursor, windowEnd)];
      const record = { schema: "romdev-decoded-ir-v1", off: cursor, addr: window.addr + (cursor - window.off),
        bank: window.bank, slot: window.slot, bytes: tail, mnemonic: null, ops: "", len: tail.length,
        cycles: null, kind: "unknown", targets: [], fallthrough: null, flagsRead: null, flagsWritten: null,
        lifted: [], decodeStatus: "truncated-at-rom-end", targetAddressDomain: "cpu",
        reachability: "unproven-linear-decode",
        truncatedNote: "an opcode here would need operand bytes past the END of the ROM file. The bytes are retained and not lifted: this is undecodable tail data, not a decoder failure." };
      cursor = windowEnd; st.coveredBytes += tail.length; st.instrCount++; st.unknownCount++; st.truncatedTailBytes += tail.length;
      yield record;
    }
    if (cursor < windowEnd) throw new Error(`decoder did not cover the complete bank window ending at ${windowEnd} (stopped at ${cursor})`);

    // SECONDARY ALIGNMENTS: the decode at every offset the primary tiling did
    // not START an instruction at. These are the mid-instruction entry points
    // a computed jump can land on. They are emitted AFTER the primary records
    // and marked, so a consumer reading only `alignment:'primary'` sees the
    // unchanged linear tiling.
    if (wantAllAlignments) {
      const missing = [];
      // ALIGNMENT. On Z80 every byte is a legal entry point. On m68k
      // instructions are WORD-ALIGNED, so an odd offset cannot begin one and
      // a record there would be fiction - the exporter would be inventing
      // entry points that no jump can reach. isa.align makes that explicit
      // rather than leaving it to the decoder to produce garbage.
      for (let off = window.off; off < windowEnd; off++) {
        if (off % isa.align !== 0) continue;
        if (!primaryStarts.has(off)) missing.push(off);
      }
      if (missing.length) {
        const decodedAt = await decodeAtOffsets(rom, missing, isa);
        for (const off of missing) {
          const row = decodedAt.get(off);
          if (!row) { st.unresolvedOffsets++; continue; }
          // objdump emits `.short` where NO valid instruction of this ISA
          // begins - genuinely undecodable data, not a decoder failure. On
          // one 512KB Genesis cart 25 of 262144 offsets are like this
          // (e.g. 0x1DCB2 = `47 45 73 aa`, mid-table data).
          //
          // Emit them as explicit `data` records rather than dropping them:
          // a consumer compiling every offset as an entry point needs an
          // entry for these too, and silently having no record is how
          // coverage gaps hide. The recompiler turns them into a trap, which
          // is correct - executing them IS a fault.
          // The mnemonics that mean "no instruction begins here" are
          // PER-ISA. m68k/6502 objdump says `.short`/`.word`/`.byte`; ARM
          // objdump says `@` and prints `<UNDEFINED> instruction: 0x...` as
          // the operand. Hardcoding the m68k spelling made every undefined
          // ARM word fall through to decodedIR and be emitted as a real
          // instruction named `@`.
          //
          // This is NOT the same question as isa.documented(): on Z80 an
          // undocumented-but-real opcode is !documented yet still an
          // instruction with bytes that execute. `isa.isData` answers only
          // "the decoder produced no instruction at all".
          if (isData(row.mnem, isa)) {
            const dbytes = row.bytes.split(/\s+/).filter(Boolean).map((b) => parseInt(b, 16));
            const rec = { schema: "romdev-decoded-ir-v1", off,
              addr: window.addr + (off - window.off), bank: window.bank, slot: window.slot,
              bytes: dbytes, mnemonic: null, ops: "", len: dbytes.length,
              cycles: null, kind: "unknown", targets: [], fallthrough: null,
              decodeStatus: "data", alignment: "secondary",
              targetAddressDomain: "cpu", reachability: "unproven-linear-decode",
              dataNote: "no valid instruction of this ISA begins here; the bytes are retained and not lifted." };
            st.secondaryCount++; st.unknownCount++;
            yield rec;
            continue;
          }
          // A SECONDARY decode whose operands would run past the END of
          // the ROM is tail data, not a decoder failure - the same case the
          // primary pass emits as `truncated-at-rom-end`. Thumb makes it
          // routine: `bl` is an aligned PAIR of halfwords, so the final two
          // bytes of any ROM ending in a bl-first-half decode to nothing.
          // A 4MB cart whose image ends in `ff ff` had its whole export
          // refused over it.
          const rowBytes = row.bytes.split(/\s+/).filter(Boolean);
          if (!rowBytes.length || off + rowBytes.length > rom.length) {
            const tail = [...rom.subarray(off, rom.length)];
            const rec = { schema: "romdev-decoded-ir-v1", off,
              addr: window.addr + (off - window.off), bank: window.bank, slot: window.slot,
              bytes: tail, mnemonic: null, ops: "", len: tail.length,
              cycles: null, kind: "unknown", targets: [], fallthrough: null,
              decodeStatus: "truncated-at-rom-end", alignment: "secondary",
              targetAddressDomain: "cpu", reachability: "unproven-linear-decode",
              truncatedNote: "an instruction here would need operand bytes past the END of the ROM file." };
            st.secondaryCount++; st.unknownCount++; st.truncatedTailBytes += tail.length;
            yield rec;
            continue;
          }
          const record = decodedIR({ ...row, addr: window.addr + (off - window.off) }, window, rom, { allowStraddle: true, isa });
          record.alignment = "secondary";
          st.secondaryCount++;
          yield record;
        }
      }
    }
  }
}

/** Zeroed manifest counters for irRecords. */
export function newIrStats() {
  return { instrCount: 0, unknownCount: 0, coveredBytes: 0, straddleCount: 0,
    truncatedTailBytes: 0, secondaryCount: 0, unresolvedOffsets: 0 };
}

/**
 * The ISA descriptor a decode request names, validated.
 * @param {{platform:string, cpuState?:string}} args
 */
export function irIsa(args) {
  // `cpuState` picks between a platform's instruction sets (GBA: arm/thumb).
  const isa = isaFor(args.platform, args.cpuState);
  if (!isa && args.cpuState) {
    const have = cpuStatesFor(args.platform);
    throw new Error(have.length
      ? `unknown cpuState '${args.cpuState}' for ${args.platform}; expected one of: ${have.join(", ")}`
      : `platform ${args.platform} has a single instruction set; cpuState does not apply`);
  }
  if (!isa) throw new Error(`emit:'ir' has no ISA descriptor for platform '${args.platform}'. Supported: ${Object.keys(PLATFORM_ISA).join(", ")}`);
  if (isa.arch === "z80" && !["sms", "gg"].includes(args.platform)) throw new Error("emit:'ir' currently supports SMS/GG cartridge mapping only; MSX/raw Z80 mapping is not inferred from SMS slots");
  return isa;
}

/**
 * Resolve the ISA and the windows for a decode request, with the same
 * validation the tool applies. Shared by the JSONL export and in-process
 * consumers so both decode exactly the same bytes the same way.
 * @param {Buffer} rom
 * @param {object} args {platform, cpuState?, allOffsets?, fileOffset?, startAddress?, length?, bank?, ...}
 */
export function irPlan(rom, args) {
  const isa = irIsa(args);
  // WINDOW CHOICE IS BY MAPPER, NOT BY "has banks".
  //
  // irWindows() is SMS-specific: it validates the bank against an SMS mapper
  // and throws "SMS bank N out of range". Routing every ISA with a bankSize
  // through it meant NES and Game Boy - which bank, but not like an SMS -
  // failed with an SMS error on a perfectly good cart.
  //
  // An ISA whose banks are seen through a FIXED CPU window supplies its own
  // `windows` (Game Boy: bank 0 at $0000, every other bank at $4000), so each
  // record's `addr` is the address the CPU executes it at. Everything else
  // takes the flat, chunked walk, correct for any ISA whose ROM is addressed
  // linearly by file offset.
  const windows = isa.windows ? isa.windows(rom.length, args)
    : (isa.bankSize && isa.smsMapper === true) ? irWindows(rom.length, args)
    : flatWindows(rom.length, args);
  return { isa, windows };
}

export async function exportZ80IR(args) {
  // Validate the platform before touching the filesystem.
  irIsa(args);
  if (!args.outputPath) throw new Error("emit:'ir' requires outputPath for JSONL; bulk IR is never returned inline");
  const input = path.resolve(args.path), output = path.resolve(args.outputPath);
  if (input === output) throw new Error("IR outputPath must not overwrite the input ROM");
  const protectInput = async () => {
    const [a, b] = await Promise.all([stat(input), stat(output).catch(e => { if (e.code === "ENOENT") return null; throw e; })]);
    if (b && a.dev === b.dev && a.ino === b.ino) throw new Error("IR outputPath aliases the input ROM; refusing to overwrite it");
  };
  await protectInput();
  const rom = await readFile(input);
  const { isa, windows } = irPlan(rom, args);
  await mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${randomUUID()}.tmp`;
  const fd = await open(temp, "wx");
  const st = newIrStats();
  let bytesWritten = 0;
  const wantAllAlignments = args.alignments === "all";
  try {
    let chunk = "";
    for await (const record of irRecords(rom, isa, windows, { wantAllAlignments, st })) {
      chunk += JSON.stringify(record) + "\n";
      if (chunk.length >= 256 * 1024) { await fd.writeFile(chunk); bytesWritten += Buffer.byteLength(chunk); chunk = ""; }
    }
    if (chunk) { await fd.writeFile(chunk); bytesWritten += Buffer.byteLength(chunk); }
    await fd.close(); await protectInput(); await rename(temp, output);
  } catch (e) { await fd.close().catch(() => {}); await unlink(temp).catch(() => {}); throw e; }
  const { instrCount, unknownCount, coveredBytes, straddleCount, truncatedTailBytes, secondaryCount, unresolvedOffsets } = st;
  return { schema: "romdev-ir-manifest-v1", path: output, format: "jsonl", instrCount, unknownCount,
    bytesWritten, coveredBytes, romBytes: rom.length,
    straddleCount,
    ...(wantAllAlignments ? { alignments: "all", secondaryCount,
      // offsetsTotal counts offsets that CAN legally begin an instruction, not
      // raw bytes. On a word-aligned ISA (m68k) only even offsets qualify, so
      // comparing `offsetsWithRecord` against rom.length would look like 50%
      // coverage on a perfectly complete export. instructionAlignment is
      // reported so a consumer can check the arithmetic rather than trust it.
      instructionAlignment: isa.align,
      offsetsTotal: Math.ceil(rom.length / isa.align),
      offsetsWithRecord: instrCount + secondaryCount,
      // ALWAYS present when alignments:'all' is on, including at zero.
      //
      // This was `...(unresolvedOffsets ? {...} : {})`, so the healthy case -
      // zero unresolved - omitted the field entirely. A caller asserting
      // `unresolvedOffsets === 0` then read `undefined`, which is falsy in the
      // same direction as success: a real regression to a nonzero count and an
      // absent field are indistinguishable to `if (!m.unresolvedOffsets)`. The
      // note claimed these were "reported rather than silently absent" while
      // the code made them silently absent. A count a consumer guards on must
      // be present when it is zero, which is exactly when the guard matters.
      unresolvedOffsets,
      ...(unresolvedOffsets ? {
        unresolvedNote: "offsets the decoder produced no instruction for, usually because fewer than a full instruction's bytes remain before the end of the ROM." } : {}),
      alignmentNote: "every byte offset carries a record. `alignment:'primary'` marks the linear tiling (unchanged from the default export, each byte owned once); `alignment:'secondary'` marks a decode STARTING at an offset the tiling did not begin an instruction at - the mid-instruction entry points a computed jump can land on. Secondary records deliberately overlap: they are alternative readings of the same bytes, not additional coverage, so do NOT sum their lengths against romBytes." } : {}),
    // Always present, for the same reason as unresolvedOffsets above: a count
    // a consumer may guard on must exist when it is zero, or a regression to
    // nonzero is indistinguishable from the field never being there.
    truncatedTailBytes,
    ...(truncatedTailBytes ? { truncatedTailNote: `${truncatedTailBytes} byte(s) at the very end of the ROM are an opcode whose operands would run past the file. They are retained as decodeStatus:'truncated-at-rom-end' rather than refusing the export.` } : {}),
    ...(straddleCount ? { straddleNote: `${straddleCount} instruction(s) start in one bank and their operand bytes continue into the next. Their records carry straddlesWindow:true with bytesBeyondWindow. coveredBytes counts each byte once, in the bank it physically lives in.` } : {}), romSha256: createHash("sha256").update(rom).digest("hex"),
    banks: [...new Set(windows.map((w) => w.bank))], windows,
    cycles: isa.provenance, source: args.platform, sourceIsa: isa.arch,
    mapper: args.mapper ?? "sega",
    mappingMode: args.allOffsets || args.fileOffset != null ? "physical-banks-with-declared-cpu-slot" : "static-cpu-mapping",
    mapperState: args.mapperState ?? null,
    note: "Linear decode is not proof of reachable code. Each bank uses the reported CPU slot; targets stay CPU addresses and are never rebased as ROM offsets. Instruction decoding stops at each selected window boundary; crossing instructions require the actual adjacent mapped bank context. Unknown/data opcodes retain their bytes and are never given fabricated semantics: decodeStatus:'unknown' records carry `lifted` holding a single {op:'refuse'} node naming the unrecognised mnemonic, NOT an empty array and never a real operation. A consumer deciding what to trap should key on decodeStatus, not on `lifted` being empty." };
}
