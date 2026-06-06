// Game Gear (SN76489 PSG) song compiler — note/duration → gg_music music_note_t
// table (3 bytes/row: divider_lo, divider_hi, dur) + {0,0} sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSong,
  noteToSemitone,
  hzToDivider,
  noteToDivider,
  PSG_CLOCK,
} from "../src/platforms/gg/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48); // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("divider formula: round(3579545 / (32 * Hz)), A4=440 → 254", () => {
  // The exact value the driver header bakes for NOTE_A4 (440 Hz concert A).
  assert.equal(hzToDivider(440), 254);
  assert.equal(noteToDivider("A4"), 254);
  // Spot-check against the rest of gg_music.h's pre-baked NOTE_* table.
  assert.equal(noteToDivider("C4"), 428); // middle C, header NOTE_C4
  assert.equal(noteToDivider("C3"), 855); // header NOTE_C3
  assert.equal(noteToDivider("G4"), 285); // header NOTE_G4
  assert.equal(noteToDivider("C5"), 214); // header NOTE_C5
  assert.equal(noteToDivider("C6"), 107); // header NOTE_C6
  assert.equal(PSG_CLOCK, 3579545);
});

test("divider is 10-bit clamped (1..1023)", () => {
  assert.equal(hzToDivider(1e9), 1); // absurdly high freq clamps to 1
  assert.equal(hzToDivider(10), 1023); // 3579545/320 = 11186 → clamp to 1023
  assert.throws(() => hzToDivider(0));
});

test("compileSong emits 3 bytes/row + {0,0} sentinel", () => {
  const { bytes, rows } = compileSong({ rows: ["C4", "E4", "G4"], defaultDur: 18 });
  assert.equal(rows, 3);
  // 3 rows * 3 bytes + 3-byte sentinel
  assert.equal(bytes.length, 3 * 3 + 3);
  // Sentinel = three trailing zero bytes ({0,0}).
  assert.deepEqual([...bytes.slice(-3)], [0, 0, 0]);
  // Row 0 = C4 → divider 428 = 0x01AC, dur 18.
  assert.deepEqual([...bytes.slice(0, 3)], [0xac, 0x01, 18]);
});

test("A4 row packs the verified divider 254 (lo=0xFE, hi=0x00)", () => {
  const { bytes } = compileSong({ rows: [{ note: "A4", dur: 30 }] });
  assert.deepEqual([...bytes.slice(0, 3)], [0xfe, 0x00, 30]);
});

test("rest emits divider 0; shorthand 'C5:12' sets dur; {div} is raw", () => {
  const { bytes } = compileSong({
    rows: ["rest", "C5:12", { div: 254, dur: 8 }],
    defaultDur: 18,
  });
  // rest → {0,0} note bytes, but a non-zero dur (NOT the sentinel).
  assert.deepEqual([...bytes.slice(0, 3)], [0, 0, 18]);
  // C5 → divider 214 = 0x00D6, dur 12.
  assert.deepEqual([...bytes.slice(3, 6)], [0xd6, 0x00, 12]);
  // raw divider 254, dur 8.
  assert.deepEqual([...bytes.slice(6, 9)], [0xfe, 0x00, 8]);
});

test("cSource is a music_note_t[] block ending in the sentinel", () => {
  const { cSource } = compileSong({ rows: [{ note: "A4", dur: 30 }], name: "song0" });
  assert.match(cSource, /static const music_note_t song0\[\] = \{/);
  assert.match(cSource, /\{\s*254,\s*30 \},/); // A4 row
  assert.match(cSource, /\{ 0, 0 \},\s*\/\* end-of-song sentinel \*\//);
});

test("dur and divider out of range, bad note name throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "C4", dur: 999 }] }));
  assert.throws(() => compileSong({ rows: [{ div: 2000, dur: 4 }] }));
  assert.throws(() => compileSong({ rows: ["H9"] }));
});
