// clusterChanges — the diffMemory summary view. A gameplay diff churns thousands
// of bytes; the summary must collapse them into a few ranges and, crucially,
// spot the stride of a struct array (the most useful RE signal in the noise).

import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterChanges } from "../src/mcp/tools/diff-cluster.js";

test("adjacent changes merge into one cluster (within gap)", () => {
  // 0x200,0x201,0x203 are all within gap=4 → one island; 0x300 is its own.
  const { clusters, stride } = clusterChanges([0x200, 0x201, 0x203, 0x300]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0], { startDec: 0x200, endDec: 0x203, bytes: 3 });
  assert.deepEqual(clusters[1], { startDec: 0x300, endDec: 0x300, bytes: 1 });
  assert.equal(stride, null, "two clusters → no stride claim");
});

test("a gap larger than the threshold splits into separate clusters", () => {
  // 0x200 and 0x210 are 0x10 apart, well past gap=4 → two clusters.
  const { clusters } = clusterChanges([0x200, 0x210], { gap: 4 });
  assert.equal(clusters.length, 2);
});

test("evenly-spaced islands report the stride (struct-array tell)", () => {
  // Four 4-byte records at stride 0x80 — the classic player/entity array.
  const offs = [];
  for (const base of [0x600, 0x680, 0x700, 0x780]) {
    offs.push(base, base + 1, base + 2); // 3 changed fields per record
  }
  const { clusters, stride } = clusterChanges(offs);
  assert.equal(clusters.length, 4, "one island per record");
  assert.equal(stride, 0x80, "uniform 0x80 spacing detected");
});

test("non-uniform spacing reports no stride", () => {
  const { stride } = clusterChanges([0x100, 0x140, 0x1c0]); // deltas 0x40, 0x80
  assert.equal(stride, null);
});

test("fewer than 3 islands never claims a stride", () => {
  const { stride } = clusterChanges([0x100, 0x180]); // 2 islands
  assert.equal(stride, null);
});

test("empty change set yields no clusters", () => {
  const { clusters, stride } = clusterChanges([]);
  assert.equal(clusters.length, 0);
  assert.equal(stride, null);
});

test("custom gap merges wider islands", () => {
  // With gap=0x10, 0x200 and 0x210 (delta 0x10) merge into one cluster.
  const { clusters } = clusterChanges([0x200, 0x210], { gap: 0x10 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].bytes, 2);
});
