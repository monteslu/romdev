// learnFontMap pre-rendered-graphic detection (the NBA Jam name-bitmap trap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPreRenderedGraphic } from "../src/mcp/tools/font-map.js";

const reads = (s, ids) => [...s].map((ch, i) => ({ ch, tileId: ids[i] }));

test("font text (repeated letters reuse their tile) is NOT flagged", () => {
  // "BANANA": A reuses 0x0A, N reuses 0x0E.
  const map = { B: 0x0b, A: 0x0a, N: 0x0e };
  const r = detectPreRenderedGraphic(reads("BANANA", [...("BANANA")].map((c) => map[c])), true);
  assert.equal(r.looksLikeGraphic, false);
});

test("pre-rendered graphic (unique contiguous tiles) IS flagged", () => {
  // "MONTES" drawn as a bitmap: tiles 0x40..0x45, all unique + contiguous.
  const r = detectPreRenderedGraphic(reads("MONTES", [0x40, 0x41, 0x42, 0x43, 0x44, 0x45]), null);
  assert.equal(r.looksLikeGraphic, true);
  assert.equal(r.reason, "unique-contiguous-tiles");
});

test("repeated char with DIFFERENT tiles is flagged (direct proof)", () => {
  // "AA" where each A is a different tile → can't be a font.
  const r = detectPreRenderedGraphic([{ ch: "A", tileId: 0x40 }, { ch: "A", tileId: 0x41 }], false);
  assert.equal(r.looksLikeGraphic, true);
  assert.equal(r.reason, "repeated-char-different-tile");
});

test("short scattered non-contiguous tiles are NOT over-flagged", () => {
  // Real font letters whose tile ids happen to be far apart, no repeats to judge.
  const r = detectPreRenderedGraphic(reads("CAT", [0x10, 0x40, 0x80]), null);
  assert.equal(r.looksLikeGraphic, false);
});
