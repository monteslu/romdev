// assets.js - identify and ROUND-TRIP the non-code bytes.
//
// 7,238,640 bytes of this ROM (86.3%) sit in `bin` ranges the ledger can only
// call "raw". Some of that is compressed archives, some is textures, some is
// audio banks, some is microcode. Until a tool can unpack a range AND repack it
// byte-exactly, none of it can move out of the opaque bucket, and the project
// cannot answer whether the non-code half is "done".
//
// ROUND-TRIP IS THE ONLY ACCEPTANCE TEST. Unpacking alone proves nothing: a
// decoder that produces plausible pixels from the wrong offset is worse than no
// decoder, because it looks like progress. A format is only "recovered" when
// unpack -> repack reproduces the original bytes exactly, and this module
// reports the sha of both sides so the claim is checkable.
//
// Identification is by MAGIC and STRUCTURE, never by file extension or by a
// name in the splat yaml - a name is a label someone typed, not evidence.
//
// Plain JS ESM + JSDoc.

import { createHash } from "node:crypto";

export const ASSET_SCHEMA = "romdev-decomp-assets-v1";

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** MIO0: "MIO0", uncompressed size, compressed-offset, raw-offset (big-endian). */
function tryMio0(buf) {
  if (buf.length < 16 || buf.toString("ascii", 0, 4) !== "MIO0") return null;
  const destSize = buf.readUInt32BE(4), compOff = buf.readUInt32BE(8), rawOff = buf.readUInt32BE(12);
  if (compOff < 16 || rawOff < compOff || compOff > buf.length || rawOff > buf.length) return null;
  return { format: "MIO0", destSize, compOffset: compOff, rawOffset: rawOff, headerBytes: 16 };
}

/** Yay0: same family, different header order. */
function tryYay0(buf) {
  if (buf.length < 16 || buf.toString("ascii", 0, 4) !== "Yay0") return null;
  const destSize = buf.readUInt32BE(4), linkOff = buf.readUInt32BE(8), chunkOff = buf.readUInt32BE(12);
  if (linkOff < 16 || chunkOff < linkOff || linkOff > buf.length) return null;
  return { format: "Yay0", destSize, linkOffset: linkOff, chunkOffset: chunkOff, headerBytes: 16 };
}

/** Decode an MIO0/Yay0 LZ stream. Both use the same layout/length encoding. */
function decodeMio0(buf, h) {
  const out = Buffer.alloc(h.destSize);
  let layoutPos = h.headerBytes;
  let compPos = h.compOffset ?? h.linkOffset;
  let rawPos = h.rawOffset ?? h.chunkOffset;
  let dst = 0, bitIdx = 0;

  // SEMANTICS TAKEN FROM THE PROJECT'S OWN libmio0.c, which is what its build
  // actually links - not from a guess, and not from tools/mio0_decompress.py,
  // whose bit polarity is inverted relative to this data.
  //
  // Four details, each of which silently corrupts output on its own, and none
  // of which "the decode reached destSize" can detect - four different WRONG
  // variants all produced exactly destSize bytes on real data here:
  //   * a SET layout bit is a LITERAL; a clear bit is a backref.
  //   * length   = ((vals[0] & 0xF0) >> 4) + 3
  //   * distance = ((vals[0] & 0x0F) << 8) + vals[1] + 1
  //   * the copy reads out[dst - distance] BYTE AT A TIME, because an
  //     overlapping run reads bytes this same loop is writing.
  while (dst < h.destSize) {
    const byteAt = layoutPos + (bitIdx >> 3);
    if (byteAt >= buf.length) return null;
    const isLiteral = (buf[byteAt] & (1 << (7 - (bitIdx % 8)))) !== 0;
    bitIdx++;
    if (isLiteral) {
      if (rawPos >= buf.length) return null;
      out[dst++] = buf[rawPos++];
    } else {
      if (compPos + 2 > buf.length) return null;
      const v0 = buf[compPos], v1 = buf[compPos + 1];
      compPos += 2;
      const length = ((v0 & 0xf0) >> 4) + 3;
      const distance = ((v0 & 0x0f) << 8) + v1 + 1;
      if (distance > dst) return null;
      for (let i = 0; i < length && dst < h.destSize; i++) { out[dst] = out[dst - distance]; dst++; }
    }
  }
  return out;
}

/**
 * Encode a buffer as MIO0.
 *
 * The inverse of decodeMio0, to the same spec taken from the project's own
 * libmio0.c: a SET layout bit is a literal, length = nibble+3 (3..18),
 * distance = 12 bits + 1 (1..4096), copying from out[dst - distance].
 *
 * ROUND TRIP IS THE ACCEPTANCE TEST, not "it produced output". A different
 * encoder makes different (valid) choices about which match to take, so a
 * re-encode of arbitrary data will NOT reproduce the original bytes even when
 * both decode correctly. `roundTrip()` therefore verifies decode(encode(x)) ==
 * x - semantic identity - and separately reports whether the bytes are
 * identical to the original container.
 */
export function encodeMio0(data) {
  const MAX_LEN = 18, MAX_DIST = 4096;
  const buf = Buffer.from(data);
  const len = buf.length;

  // The lookback is keyed by FIRST BYTE ONLY (not a 3-byte hash) and scanned
  // OLDEST-FIRST, because `cur_length > best_length` is a strict improvement:
  // among equal-length matches the OLDEST (largest distance) wins. A hash-chain
  // encoder scanning newest-first picks a different, equally valid offset - and
  // the container bytes then differ from the original. Reproducing the
  // reference's choices exactly is what makes the round trip byte-identical.
  const lookback = Array.from({ length: 256 }, () => ({ idx: [], start: 0 }));
  const push = (b, at) => { lookback[b].idx.push(at); };

  // find_longest, including the overlap continuation: when a match runs right
  // up to `start_offset` it keeps matching into the bytes it just produced,
  // which is how a run-fill reaches length 18 from distance 1.
  const findLongest = (startOffset, maxSearch) => {
    let bestLength = 0, bestOffset = 0;
    const lb = lookback[buf[startOffset]];
    const farthest = Math.max(startOffset - MAX_DIST, 0);
    let k = lb.start;
    while (k < lb.idx.length && lb.idx[k] < farthest) k++;
    lb.start = k;
    for (; k < lb.idx.length && lb.idx[k] < startOffset; k++) {
      const off = lb.idx[k];
      let searchLen = Math.min(maxSearch, startOffset - off);
      let i = 0;
      for (; i < searchLen; i++) if (buf[startOffset + i] !== buf[off + i]) break;
      let curLength = i;
      if (curLength === searchLen) {
        searchLen = maxSearch - curLength;
        let j = 0;
        for (; j < searchLen; j++) if (buf[startOffset + curLength + j] !== buf[off + j]) break;
        curLength += j;
      }
      if (curLength > bestLength) { bestLength = curLength; bestOffset = startOffset - off; }
    }
    return { length: bestLength, offset: bestOffset };
  };

  const layout = [];
  const comp = [];
  const raw = [];
  let proc = 0;

  if (len > 0) {
    // Special case: the first byte is always a literal.
    push(buf[0], 0);
    raw.push(buf[0]);
    layout.push(1);
    proc = 1;
  }

  while (proc < len) {
    const maxLength = Math.min(len - proc, MAX_LEN);
    let m = findLongest(proc, maxLength);
    // Push the current byte BEFORE the lookahead check, as the reference does.
    push(buf[proc], proc);

    if (m.length > 2) {
      // LAZY MATCHING: emit a literal when the NEXT position matches more than
      // one longer. Dropping this changes which matches are taken and the
      // container no longer reproduces.
      const laLen = Math.min(len - proc - 1, MAX_LEN);
      const la = laLen > 0 ? findLongest(proc + 1, laLen) : { length: 0, offset: 0 };
      if (m.length + 1 < la.length) {
        raw.push(buf[proc]);
        layout.push(1);
        proc++;
        m = la;
        push(buf[proc], proc);
      }
      for (let i = 1; i < m.length; i++) push(buf[proc + i], proc + i);
      comp.push((((m.length - 3) & 0x0f) << 4) | (((m.offset - 1) >> 8) & 0x0f), (m.offset - 1) & 0xff);
      layout.push(0);
      proc += m.length;
    } else {
      raw.push(buf[proc]);
      layout.push(1);
      proc++;
    }
  }

  const layoutBytes = Buffer.alloc(Math.ceil(layout.length / 8) || 1);
  layout.forEach((b, n) => { if (b) layoutBytes[n >> 3] |= 1 << (7 - (n % 8)); });

  // The layout section is 4-BYTE ALIGNED before the compressed section starts
  // (ALIGN(MIO0_HEADER_LENGTH + bit_length, 4) in the reference). Without the
  // padding every offset in the header is short and the container never matches
  // the original even when every match choice is identical.
  const compOff = (16 + layoutBytes.length + 3) & ~3;
  const rawOff = compOff + comp.length;
  const out = Buffer.alloc(rawOff + raw.length);
  out.write("MIO0", 0, "ascii");
  out.writeUInt32BE(len, 4);
  out.writeUInt32BE(compOff, 8);
  out.writeUInt32BE(rawOff, 12);
  layoutBytes.copy(out, 16);
  Buffer.from(comp).copy(out, compOff);
  Buffer.from(raw).copy(out, rawOff);
  return out;
}

/** Decode a MIO0 container (exported so a caller can verify a round trip). */
export function decodeMio0Container(buf) {
  const h = tryMio0(buf);
  if (!h) return null;
  return decodeMio0(buf, h);
}

/** N64 image formats, by bytes-per-pixel. Identification needs dimensions. */
export const IMAGE_FORMATS = Object.freeze({
  rgba16: { bpp: 2, note: "5/5/5/1 RGBA" }, rgba32: { bpp: 4, note: "8/8/8/8 RGBA" },
  ia16: { bpp: 2, note: "8/8 intensity+alpha" }, ia8: { bpp: 1 }, ia4: { bpp: 0.5 },
  i8: { bpp: 1 }, i4: { bpp: 0.5 }, ci8: { bpp: 1, note: "needs a TLUT" }, ci4: { bpp: 0.5, note: "needs a TLUT" },
});

/**
 * Identify what a byte range is, by magic and structure only.
 *
 * Returns candidates with confidence. An unidentified range says so - a guess
 * dressed as an identification is the failure this module is built to avoid.
 */
export function identify(buf, { name } = {}) {
  const candidates = [];
  const m0 = tryMio0(buf); if (m0) candidates.push({ ...m0, confidence: "high", basis: "MIO0 magic + self-consistent header offsets" });
  const y0 = tryYay0(buf); if (y0) candidates.push({ ...y0, confidence: "high", basis: "Yay0 magic + self-consistent header offsets" });

  // An RSP microcode blob is a text/data pair of very specific sizes; without
  // the boundary we can only note the possibility.
  if (!candidates.length && buf.length >= 0x1000 && buf.length % 8 === 0) {
    const zeros = buf.subarray(0, 64).filter((b) => b === 0).length;
    if (zeros < 8) candidates.push({ format: "unknown-binary", confidence: "none", basis: "no recognised magic; dense non-zero head" });
  }
  if (!candidates.length) candidates.push({ format: "unidentified", confidence: "none", basis: "no recognised magic" });

  return {
    name: name ?? null, bytes: buf.length, sha256: sha(buf).slice(0, 16),
    candidates,
    note: candidates[0].confidence === "high" ? undefined
      : "NOT identified. This range stays in the opaque bucket: reporting a guess as a format would move bytes out of 'raw' without evidence.",
  };
}

/**
 * Unpack AND repack, and report whether the round trip is byte-exact.
 *
 * `repack` is supplied by the caller for formats romdev can only decode; when
 * absent the result says `roundTrip: "decode-only"` rather than implying the
 * format is recovered.
 */
export function roundTrip(buf, { name, repack } = {}) {
  const id = identify(buf, { name });
  const best = id.candidates[0];
  if (best.confidence !== "high") {
    return { ...id, roundTrip: "not-attempted", state: "raw",
      why: "the format was not identified, so there is nothing to round-trip" };
  }

  let decoded = null;
  try { decoded = decodeMio0(buf, best); } catch { decoded = null; }
  if (!decoded) {
    return { ...id, roundTrip: "decode-failed", state: "format-identified",
      why: `the ${best.format} header is self-consistent but the stream did not decode. The magic is evidence of the format; a failed decode is NOT evidence it is something else.` };
  }
  const decodedSha = sha(decoded);
  if (decoded.length !== best.destSize) {
    return { ...id, roundTrip: "decode-short", state: "format-identified",
      decodedBytes: decoded.length, expectedBytes: best.destSize,
      why: "the decode produced a different length than the header declares - treat the decode as unverified" };
  }

  // DEFAULT REPACKER. romdev ships a MIO0 encoder, so the round trip can be
  // completed without the caller supplying one.
  const repackFn = typeof repack === "function" ? repack
    : (best.format === "MIO0" ? encodeMio0 : null);
  if (!repackFn) {
    return { ...id, roundTrip: "decode-only", state: "format-identified",
      decodedBytes: decoded.length, decodedSha256: decodedSha.slice(0, 16),
      why: `decoded successfully, but there is no repacker for ${best.format}. A format is only RECOVERED when unpack -> repack `
        + "reproduces the payload exactly; decode alone leaves this range at 'format-identified'." };
  }

  let repacked = null;
  try { repacked = repackFn(decoded); } catch (e) {
    return { ...id, roundTrip: "repack-failed", state: "format-identified", error: String(e?.message ?? e).slice(0, 200) };
  }

  // TWO DIFFERENT CLAIMS, and conflating them would overstate the result.
  //
  //   payloadExact  - decode(repack(decode(x))) == decode(x). The data survives
  //                   a full round trip. THIS is what makes a range editable.
  //   containerExact- repack(decode(x)) == x byte for byte. Only true when our
  //                   encoder happens to make the same match choices as the
  //                   original compressor, which is NOT required for
  //                   correctness: a different valid encoding decodes the same.
  let payloadExact = false;
  try {
    const again = decodeMio0Container(Buffer.isBuffer(repacked) ? repacked : Buffer.from(repacked ?? []));
    payloadExact = !!again && Buffer.compare(Buffer.from(again), Buffer.from(decoded)) === 0;
  } catch {}
  // The RANGE may be longer than the CONTAINER: a segment is padded to
  // alignment with zeros after the MIO0 stream ends. Comparing raw lengths
  // reported a false mismatch on a repack that is byte-identical over every
  // byte the container occupies.
  let containerExact = false;
  let trailingPadBytes = 0;
  if (Buffer.isBuffer(repacked) && repacked.length <= buf.length) {
    const head = Buffer.compare(buf.subarray(0, repacked.length), repacked) === 0;
    const tail = buf.subarray(repacked.length);
    containerExact = head && tail.every((b) => b === 0);
    if (head) trailingPadBytes = tail.length;
  }
  const exact = payloadExact;
  return {
    ...id,
    roundTrip: exact ? (containerExact ? "byte-exact" : "payload-exact") : "mismatch",
    state: exact ? "round-trip-tool" : "format-identified",
    payloadExact, containerExact,
    originalBytes: buf.length, repackedBytes: repacked?.length ?? null,
    ...(trailingPadBytes ? { trailingPadBytes, trailingPadNote: "zero padding after the container, inside the range but not part of the MIO0 stream" } : {}),
    originalSha256: sha(buf).slice(0, 16), repackedSha256: repacked ? sha(repacked).slice(0, 16) : null,
    decodedBytes: decoded.length, decodedSha256: decodedSha.slice(0, 16),
    why: !exact
      ? "the repacked container did not decode back to the same payload, so the encoder is NOT faithful and this range stays at "
        + "'format-identified' - a lossy round trip cannot rebuild the ROM."
      : containerExact
        ? "unpack -> repack reproduced the original container byte for byte."
        : "unpack -> repack -> unpack reproduces the PAYLOAD exactly; the container bytes differ because a different (equally valid) "
          + "set of match choices was made. The data is fully recoverable and editable, which is what 'round-trip-tool' means. "
          + "Rebuilding the ORIGINAL ROM byte-for-byte additionally needs the original compressor's choices - use the untouched "
          + "container for ranges you are not editing.",
  };
}

/**
 * Scan a ROM's bin ranges and report what is identifiable.
 * @param {Buffer} rom
 * @param {Array<{name:string,romStart:number,romEnd:number,type:string}>} ranges
 */
export function scanRanges(rom, ranges) {
  const out = [];
  let identified = 0, identifiedBytes = 0, opaqueBytes = 0;
  for (const r of ranges) {
    const size = Math.max(0, (r.romEnd ?? 0) - (r.romStart ?? 0));
    if (!size) continue;
    const buf = rom.subarray(r.romStart, r.romEnd);
    const id = identify(buf, { name: r.name });
    const known = id.candidates[0].confidence === "high";
    if (known) { identified++; identifiedBytes += size; } else opaqueBytes += size;
    out.push({ name: r.name, romStart: r.romStart, bytes: size, format: id.candidates[0].format, confidence: id.candidates[0].confidence });
  }
  return {
    schema: ASSET_SCHEMA,
    scanned: out.length, identified, identifiedBytes, opaqueBytes,
    ranges: out.sort((a, b) => b.bytes - a.bytes).slice(0, 60),
    note: "identification is by MAGIC and STRUCTURE only - never by the name in the splat yaml, which is a label someone typed. "
      + "`identifiedBytes` may still be far short of the opaque total; that is the true state, not a failure of the scan.",
  };
}
