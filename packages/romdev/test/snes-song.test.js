// SNES song compiler — note/duration → apu_blob 3-byte-per-row table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileSong, noteToSemitone, dspPitch } from "../src/platforms/snes/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48);   // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("dspPitch doubles per octave, base note = baseP", () => {
  const base = noteToSemitone("C4");
  assert.equal(dspPitch(base, base, 0x400), 0x400);              // base note → baseP
  assert.equal(dspPitch(noteToSemitone("C5"), base, 0x400), 0x800); // +12 → 2x
  assert.equal(dspPitch(noteToSemitone("C3"), base, 0x400), 0x200); // -12 → 0.5x
});

test("compileSong emits 3 bytes/row + $00 terminator", () => {
  const { bytes, rows } = compileSong({ base: "C4", baseP: 0x400, rows: ["C4", "E4", "G4"] });
  assert.equal(rows, 3);
  assert.equal(bytes.length, 3 * 3 + 1);
  assert.equal(bytes[bytes.length - 1], 0x00);
  // row 0 = C4 at baseP 0x400, default 16 ticks
  assert.deepEqual([...bytes.slice(0, 3)], [0x10, 0x00, 0x04]);
});

test("shorthand 'C4:32' sets ticks; {p} uses raw DSP pitch", () => {
  const { bytes } = compileSong({ rows: ["C4:32", { p: 0x0a00, ticks: 8 }] });
  assert.equal(bytes[0], 0x20);                 // 32 ticks
  assert.deepEqual([...bytes.slice(3, 6)], [0x08, 0x00, 0x0a]); // raw p=0x0A00, 8t
});

test("ticks out of range and bad note name throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "C4", ticks: 999 }] }));
  assert.throws(() => compileSong({ rows: ["H9"] }));
});
