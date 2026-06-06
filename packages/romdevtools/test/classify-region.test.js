// classifyRegion heuristic — the "found table that's really ASCII text" trap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBytes, overlapsAsciiText } from "../src/mcp/tools/classify-region.js";

test("the 'ROD' trap: ASCII text is classified as ascii-text, not a table", () => {
  // "FROM DOWNTOWN" contains 82/79/68 = R/O/D — the coincidence that cost hours.
  const bytes = new TextEncoder().encode("FROM DOWNTOWN!!");
  const c = classifyBytes(bytes);
  assert.equal(c.looksLike, "ascii-text");
  assert.ok(c.asciiPreview.includes("FROM DOWNTOWN"));
  assert.ok(overlapsAsciiText(bytes), "overlapsAsciiText should flag it");
});

test("a real stat table (small values, no ascii run) is NOT called text", () => {
  const table = new Uint8Array([7, 5, 8, 9, 6, 7, 8, 5, 9, 4, 6, 7, 8, 3, 5, 6]);
  const c = classifyBytes(table);
  assert.notEqual(c.looksLike, "ascii-text");
  assert.equal(overlapsAsciiText(table), false);
});

test("high-entropy data → 'high-entropy' (compressed/packed)", () => {
  const packed = new Uint8Array(256);
  for (let i = 0; i < 256; i++) packed[i] = (i * 73 + 19) & 0xff;
  assert.equal(classifyBytes(packed).looksLike, "high-entropy");
});

test("sparse zero-heavy data → tile/sparse, not text", () => {
  const tiles = new Uint8Array(64);
  tiles[3] = 0xff; tiles[7] = 0x18; tiles[20] = 0x3c;
  assert.equal(classifyBytes(tiles).looksLike, "sparse-or-tiledata");
});
