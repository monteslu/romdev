// Static pointer/jump-table decoder. The literal "which index dispatches to this
// handler?" map, the static complement to the LIVE breakpoint({on:'jumptable'})
// resolver. Handles the three forms a real dispatcher uses (v0.41.0 feedback N2):
//
//   1. CONTIGUOUS little-endian words — `dw handler0, handler1, …` at one base.
//   2. SPLIT lo/hi — low bytes in one array, high bytes in a SEPARATE array at a
//      different base: handler = (hi[i] << 8) | lo[i]. (Common on NES shooters.)
//   3. The 6502 RTS-trick (`+1`): the stored value is handler-1 (push, rts → +1),
//      so the real handler = storedWord + 1.
//
// Plus a REVERSE lookup: handler address → the dispatch index/indices that reach
// it ("what object state triggers this routine?").
//
// Operates on the raw ROM image + a CPU-address→file-offset mapper (so it works
// on banked carts). Plain JS ESM + JSDoc.

/**
 * Decode a pointer/jump table into index → handler entries.
 *
 * @param {Object} opts
 * @param {Uint8Array} opts.data        raw ROM image (incl. header)
 * @param {(cpuAddr:number)=>number} opts.toOffset  map a CPU address to a file
 *   offset into `data` (banked-cart aware; throws/returns -1 if unmapped).
 * @param {number} opts.count           number of entries.
 * @param {number} [opts.loBase]        CPU address of the low-byte array. For the
 *   contiguous form, this is the table base (entries are 2 bytes each).
 * @param {number} [opts.hiBase]        CPU address of the high-byte array (SPLIT
 *   form). Omit for the contiguous form (hi byte follows each lo byte).
 * @param {"direct"|"rts+1"} [opts.convention="direct"]  add 1 to each stored word
 *   for the 6502 RTS-trick.
 * @param {"LE"|"BE"} [opts.endian="LE"]  byte order of the CONTIGUOUS form (the
 *   split form is inherently lo-array/hi-array so endian doesn't apply).
 * @returns {{ entries: Array<{index:number, handler:number, storedWord:number}>,
 *             form: string }}
 */
export function decodePointerTable({ data, toOffset, count, loBase, hiBase, convention = "direct", endian = "LE" }) {
  if (!Number.isInteger(count) || count <= 0) throw new Error("decodePointerTable: count must be a positive integer.");
  if (loBase == null) throw new Error("decodePointerTable: loBase (the table / low-byte base) is required.");
  const add = convention === "rts+1" ? 1 : 0;
  const byteAt = (cpuAddr) => {
    const off = toOffset(cpuAddr);
    if (off == null || off < 0 || off >= data.length) {
      throw new Error(`decodePointerTable: CPU address $${cpuAddr.toString(16)} maps outside the ROM (offset ${off}).`);
    }
    return data[off];
  };

  const entries = [];
  const split = hiBase != null;
  for (let i = 0; i < count; i++) {
    let stored;
    if (split) {
      const lo = byteAt(loBase + i);
      const hi = byteAt(hiBase + i);
      stored = (hi << 8) | lo;
    } else if (endian === "BE") {
      const hi = byteAt(loBase + i * 2);
      const lo = byteAt(loBase + i * 2 + 1);
      stored = (hi << 8) | lo;
    } else {
      const lo = byteAt(loBase + i * 2);
      const hi = byteAt(loBase + i * 2 + 1);
      stored = (lo | (hi << 8));
    }
    const handler = (stored + add) & 0xffff;
    entries.push({ index: i, handler, storedWord: stored });
  }
  const form = split
    ? `split lo@$${loBase.toString(16).toUpperCase()}/hi@$${hiBase.toString(16).toUpperCase()}`
    : `contiguous ${endian}@$${loBase.toString(16).toUpperCase()}`;
  return { entries, form: form + (add ? " (rts+1)" : "") };
}

/**
 * Reverse lookup: which dispatch index/indices land on `handler`. Returns all
 * matches (a handler can be shared by several states).
 * @param {ReturnType<typeof decodePointerTable>["entries"]} entries
 * @param {number} handler
 * @returns {number[]} indices
 */
export function reverseLookup(entries, handler) {
  const h = handler & 0xffff;
  return entries.filter((e) => e.handler === h).map((e) => e.index);
}
