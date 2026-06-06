// GB/GBC song compiler — note-song → hUGEDriver huge_song_t C data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSong, noteToHugeIndex } from "../src/platforms/gb/song.js";
import { compileSong as gbcCompile } from "../src/platforms/gbc/song.js";

test("note → hUGE index (C3=0, C4=12, A4=21, C5=24)", () => {
  assert.equal(noteToHugeIndex("C3"), 0);
  assert.equal(noteToHugeIndex("C4"), 12);
  assert.equal(noteToHugeIndex("A4"), 21);
  assert.equal(noteToHugeIndex("C5"), 24);
  assert.equal(noteToHugeIndex("A#3"), 10);
});

test("out-of-range note throws (hUGE is C3..B8)", () => {
  assert.throws(() => noteToHugeIndex("C2"));  // below C3
  assert.throws(() => noteToHugeIndex("C9"));  // above B8
});

test("row tokens: note triggers, '-' sustains (0x80), '.' rests (0xFF)", () => {
  const { bytes } = compileSong({ channels: [{ rows: ["C5", "-", "."] }] });
  // padded to 16 rows; first 3 rows:
  assert.deepEqual([...bytes.slice(0, 6)], [24, 0x00, 0x00, 0x80, 0xFF, 0x00]);
});

test("multi-channel song emits huge_song_t with per-channel orders", () => {
  const { cSource, rows, channels, bytes } = compileSong({
    name: "tune", ticksPerRow: 8,
    channels: [
      { rows: ["C5", "-", "E5", "-", "G5", "-", "C6", "-", ".", ".", ".", ".", ".", ".", ".", "."] },
      { rows: ["C3", "-", "-", "-", "G3", "-", "-", "-", "C3", "-", "-", "-", "C3", "-", "-", "-"] },
    ],
  });
  assert.equal(rows, 16);
  assert.equal(channels, 2);
  assert.equal(bytes.length, 16 * 2 * 2);             // 2 patterns × 16 rows × 2 bytes
  assert.match(cSource, /const huge_song_t tune = \{/);
  assert.match(cSource, /ch1_orders, 1, 1/);          // 1 pattern, loop
  assert.match(cSource, /ch2_orders, 1, 1/);
  assert.match(cSource, /ticks_per_row \*\/ 8/);
});

test("rows auto-pad to 16-row patterns", () => {
  const { bytes } = compileSong({ channels: [{ rows: ["C4", "D4", "E4"] }] }); // 3 → padded to 16
  assert.equal(bytes.length, 16 * 2);
});

test("gbc reuses the gb compiler", () => {
  const a = compileSong({ name: "x", channels: [{ rows: ["C5"] }] });
  const b = gbcCompile({ name: "x", channels: [{ rows: ["C5"] }] });
  assert.deepEqual([...a.bytes], [...b.bytes]);
  assert.equal(a.cSource, b.cSource);
});
