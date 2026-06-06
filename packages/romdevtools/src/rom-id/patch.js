// ROM patching for agent-authored ROM hacks.
//
// Takes a base ROM + a list of byte writes and produces a modified ROM.
// Per-platform smarts:
//   - For iNES files we know byte 4 = PRG bank count and byte 5 = CHR
//     bank count, so we can validate writes don't fall outside the file
//     and warn if the header should be regenerated.
//   - Patches that extend past EOF are an error by default; pass
//     `allowExpand: true` to grow the file (zero-padded).

import { readFile, writeFile } from "node:fs/promises";

/**
 * @typedef {Object} PatchWrite
 * @property {number} offset       absolute byte offset into the ROM
 * @property {string} [hex]        hex string of bytes to write
 * @property {string} [base64]     base64 of bytes to write
 * @property {Uint8Array} [bytes]  raw bytes
 */

/**
 * @param {Object} args
 * @param {Uint8Array} args.rom    base ROM bytes
 * @param {PatchWrite[]} args.writes
 * @param {boolean} [args.allowExpand] grow the file if writes extend past EOF
 * @returns {{ rom: Uint8Array, applied: number, expanded: number, log: string[] }}
 */
export function patchRom(args) {
  const base = args.rom;
  const writes = args.writes ?? [];
  const allowExpand = !!args.allowExpand;

  // Calculate the final size we'll need.
  let maxEnd = base.length;
  for (const w of writes) {
    const bytes = normalizeBytes(w);
    if (w.offset + bytes.length > maxEnd) {
      maxEnd = w.offset + bytes.length;
    }
  }

  /** @type {string[]} */
  const log = [];
  let expanded = 0;
  if (maxEnd > base.length) {
    if (!allowExpand) {
      throw new Error(
        `patch extends ROM from ${base.length} to ${maxEnd} bytes; pass allowExpand:true to permit`,
      );
    }
    expanded = maxEnd - base.length;
    log.push(`expanded ROM by ${expanded} bytes (was ${base.length}, now ${maxEnd})`);
  }

  const out = new Uint8Array(maxEnd);
  out.set(base, 0);

  let applied = 0;
  for (const w of writes) {
    const bytes = normalizeBytes(w);
    if (w.offset < 0 || w.offset + bytes.length > out.length) {
      throw new RangeError(
        `write out of range: offset=${w.offset} len=${bytes.length} romSize=${out.length}`,
      );
    }
    out.set(bytes, w.offset);
    applied++;
  }

  return { rom: out, applied, expanded, log };
}

/**
 * Generic single-write file splicer with an optional `expect` safety check.
 *
 * Reads a file, optionally verifies that the bytes at `offset` match a
 * provided `expect` hex string (case-insensitive, whitespace-tolerant),
 * writes new bytes in-place, and writes back to disk (or a different path).
 *
 * The `expect` guard is the key feature: without it, patches silently
 * corrupt when the ROM doesn't match what the patch was authored against
 * (different region, different revision). With it, the agent gets a
 * structured error naming the actual bytes vs the expected ones.
 *
 * @param {Object} args
 * @param {string} args.path        source file path (modified in place unless `outputPath` given)
 * @param {string} [args.outputPath] optional separate destination; if omitted, overwrites `path`
 * @param {number} args.offset      byte offset to write at
 * @param {string} [args.hex]       bytes to write, as hex
 * @param {string} [args.base64]    bytes to write, as base64
 * @param {string} [args.expect]    if set, fail unless the current bytes at `offset` match
 * @param {boolean} [args.allowExpand] grow the file if the write extends past EOF
 * @returns {Promise<{path: string, offset: number, bytesWritten: number, expectMatched: boolean | null, fileSize: number, expanded: number}>}
 */
export async function patchFile(args) {
  const { path, outputPath, offset, hex, base64, expect, allowExpand } = args;
  if (offset == null || typeof offset !== "number" || offset < 0) {
    throw new Error("patchFile: offset must be a non-negative number");
  }
  const newBytes = normalizeBytes({ hex, base64 });
  if (newBytes.length === 0) {
    throw new Error("patchFile: write is empty (pass non-empty hex or base64)");
  }

  const data = new Uint8Array(await readFile(path));

  // Verify expect-guard if provided.
  let expectMatched = null;
  if (expect != null) {
    const expectBytes = parseHex(expect);
    if (offset + expectBytes.length > data.length) {
      throw new Error(
        `patchFile: expect-check region (offset=${offset}, length=${expectBytes.length}) ` +
        `extends past EOF (file is ${data.length} bytes)`,
      );
    }
    const actual = data.slice(offset, offset + expectBytes.length);
    let mismatch = -1;
    for (let i = 0; i < expectBytes.length; i++) {
      if (expectBytes[i] !== actual[i]) { mismatch = i; break; }
    }
    if (mismatch >= 0) {
      expectMatched = false;
      throw new Error(
        `patchFile: expect-check FAILED at file offset 0x${offset.toString(16)} ` +
        `(byte ${mismatch}/${expectBytes.length} differs).\n` +
        `  expected: ${toHex(expectBytes)}\n` +
        `  actual:   ${toHex(actual)}\n` +
        `Refusing to write. The file may be a different region/revision than the patch targets.`,
      );
    }
    expectMatched = true;
  }

  // Apply write through the shared patchRom core for grow-handling.
  const r = patchRom({
    rom: data,
    writes: [{ offset, bytes: newBytes }],
    allowExpand: !!allowExpand,
  });

  const dst = outputPath ?? path;
  await writeFile(dst, r.rom);
  return {
    path: dst,
    offset,
    bytesWritten: newBytes.length,
    expectMatched,
    fileSize: r.rom.length,
    expanded: r.expanded,
  };
}

function parseHex(s) {
  const clean = s.replace(/[\s,_]/g, "");
  if (clean.length % 2 !== 0) throw new Error(`hex string must have even number of digits (got ${clean.length})`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(clean.substr(i * 2, 2), 16);
    if (Number.isNaN(v)) throw new Error(`invalid hex digit pair at index ${i}: '${clean.substr(i * 2, 2)}'`);
    out[i] = v;
  }
  return out;
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

/**
 * Patch a ROM file on disk and write the result.
 * @param {Object} args
 * @param {string} args.input       source ROM path
 * @param {string} args.output      destination path
 * @param {PatchWrite[]} args.writes
 * @param {boolean} [args.allowExpand]
 */
export async function patchRomFile(args) {
  const rom = new Uint8Array(await readFile(args.input));
  const result = patchRom({ rom, writes: args.writes, allowExpand: args.allowExpand });
  await writeFile(args.output, result.rom);
  return { ...result, output: args.output, inputBytes: rom.length, outputBytes: result.rom.length };
}

function normalizeBytes(w) {
  if (w.bytes) return w.bytes;
  if (w.hex !== undefined) {
    return parseHex(w.hex);
  }
  if (w.base64 !== undefined) {
    return new Uint8Array(Buffer.from(w.base64, "base64"));
  }
  throw new Error("each write needs `hex`, `base64`, or `bytes`");
}

/**
 * Extract the CHR ROM bank from an iNES file. Returns the 8KB block as bytes,
 * or null if the ROM has no CHR ROM (CHR-RAM cart).
 *
 * @param {Uint8Array} ines
 * @returns {Uint8Array | null}
 */
export function extractChrFromINes(ines) {
  if (ines.length < 16 || ines[0] !== 0x4e || ines[1] !== 0x45 || ines[2] !== 0x53 || ines[3] !== 0x1a) {
    throw new Error("not a valid iNES file");
  }
  const prgBanks = ines[4];
  const chrBanks = ines[5];
  if (chrBanks === 0) return null;
  const offset = 16 + prgBanks * 16384;
  const size = chrBanks * 8192;
  if (offset + size > ines.length) {
    throw new Error("iNES file truncated — CHR bank past EOF");
  }
  // Return all CHR (could be > 8KB for multi-bank carts).
  return ines.slice(offset, offset + size);
}
