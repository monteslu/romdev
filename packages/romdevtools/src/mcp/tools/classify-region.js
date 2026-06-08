// classifyRegion — cheap heuristic for "what kind of data is at this offset?"
//
// The trap this kills: a long RE session confidently identified a "stat table"
// at an offset because values 82/79/68 matched the stats it wanted — but those
// bytes were the ASCII string "ROD" (from "FROM DOWNTOWN"). A weaker agent will
// 100% ship a broken patch off a coincidence like that. classifyRegion looks at
// the bytes and says "this looks like ASCII text / code / a pointer table / tile
// data / unknown" with the metrics behind the call, so the agent stops before
// trusting a coincidental table.

/** Printable ASCII (incl. space) ratio of a byte buffer. */
function printableRatio(bytes) {
  if (!bytes.length) return 0;
  let p = 0;
  for (const b of bytes) if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x21 && b <= 0x7e)) p++;
  return p / bytes.length;
}

/** Longest run of consecutive printable-ASCII bytes (length). */
function longestPrintableRun(bytes) {
  let best = 0, cur = 0;
  for (const b of bytes) {
    if (b === 0x20 || (b >= 0x21 && b <= 0x7e)) { cur++; if (cur > best) best = cur; }
    else cur = 0;
  }
  return best;
}

/** Shannon entropy (bits/byte, 0..8) — low = repetitive/structured, high = packed/compressed. */
function entropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Uint32Array(256);
  for (const b of bytes) counts[b]++;
  let h = 0;
  for (const c of counts) if (c) { const p = c / bytes.length; h -= p * Math.log2(p); }
  return h;
}

/** Fraction of zero bytes — high in sparse tables / padding / tile data. */
function zeroRatio(bytes) {
  if (!bytes.length) return 0;
  let z = 0;
  for (const b of bytes) if (b === 0) z++;
  return z / bytes.length;
}

/**
 * Heuristically classify a byte buffer.
 * @param {Uint8Array} bytes
 * @param {object} [opts]
 * @param {boolean} [opts.bigEndian] platform endianness (for pointer-table guess)
 * @returns {{ looksLike: string, printableRatio:number, entropy:number, zeroRatio:number, longestAsciiRun:number, asciiPreview:string|null, confidence:string, note:string }}
 */
export function classifyBytes(bytes, _opts = {}) {
  const pr = printableRatio(bytes);
  const ent = entropy(bytes);
  const zr = zeroRatio(bytes);
  const run = longestPrintableRun(bytes);

  // ASCII text: mostly printable AND a meaningful run (so a table that happens to
  // have some printable bytes scattered doesn't read as text — it's the RUN that
  // distinguishes "ROD" inside real text from coincidental printable values).
  let looksLike = "unknown";
  let confidence = "low";
  let note = "";
  if (pr >= 0.85 && run >= 4) {
    looksLike = "ascii-text";
    confidence = pr >= 0.95 && run >= 6 ? "high" : "medium";
    note = "Mostly printable ASCII with a real run — likely a text string. A 'data table' overlapping this is probably a coincidence (values matching ASCII codes). Check for terminators / a font map before treating bytes here as a stat/pointer table.";
  } else if (ent >= 6.5) {
    looksLike = "high-entropy"; // compressed / encrypted / packed graphics
    confidence = "medium";
    note = "High entropy — likely compressed data, packed graphics, or encrypted. Not a plain table; don't read it as flat values.";
  } else if (zr >= 0.5 && ent <= 3.5) {
    looksLike = "sparse-or-tiledata"; // lots of zeros, low entropy
    confidence = "low";
    note = "Sparse / low-entropy (many zeros) — could be tile/bitmap data, a sparse table, or padding. Inspect as tiles (getTile/inspectPatternTiles) if it's graphics.";
  } else if (ent <= 4.5 && pr < 0.5) {
    looksLike = "structured-data"; // tables, code, binary records
    confidence = "low";
    note = "Low-entropy non-text bytes — plausibly a table, structured records, or code. If you think it's a table, verify the stride/record size; if code, disassemble.";
  } else {
    looksLike = "unknown";
    note = "No strong signal. Could be a table, mixed data, or code — verify before trusting it as a flat value table.";
  }

  const asciiPreview = (looksLike === "ascii-text" || pr >= 0.6)
    ? Array.from(bytes.slice(0, 48), (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("")
    : null;

  return {
    looksLike,
    printableRatio: Math.round(pr * 100) / 100,
    entropy: Math.round(ent * 100) / 100,
    zeroRatio: Math.round(zr * 100) / 100,
    longestAsciiRun: run,
    asciiPreview,
    confidence,
    note,
  };
}

/** True if a buffer is "probably ASCII text" — the cheap guard tools use to warn
 *  that a candidate offset overlaps a string region. */
export function overlapsAsciiText(bytes) {
  return printableRatio(bytes) >= 0.85 && longestPrintableRun(bytes) >= 4;
}
