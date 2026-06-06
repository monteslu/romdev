// Atari 7800 (TIA) song compiler — note/frames → bundled atari7800_music driver
// 3-byte-per-row note table { distortion, freq(AUDF), frames } + {0,0,0} sentinel.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSong,
  noteToSemitone,
  noteToAudf,
  audfToHz,
  semitoneToHz,
  TIA_AUDIO_CLOCK,
  DIST_MELODY,
  DIST_BASS,
} from "../src/platforms/atari7800/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48); // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("TIA pitch math: f = clock/(pre·2·(AUDF+1)), pre=1 mode4 / 31 mode6", () => {
  // NTSC TIA audio clock = color clock / 114.
  assert.ok(Math.abs(TIA_AUDIO_CLOCK - 31399.5) < 1);
  // mode 4 (melody) reaches from ~15.7kHz (AUDF0) down to ~490.6Hz (AUDF31).
  assert.ok(Math.abs(audfToHz(0, DIST_MELODY) - 15699.76) < 1);
  assert.ok(Math.abs(audfToHz(31, DIST_MELODY) - 490.62) < 0.1);
  // mode 6 (bass, div-by-31) sits an octave-ish lower: AUDF0 ≈ 506Hz.
  assert.ok(Math.abs(audfToHz(0, DIST_BASS) - 506.44) < 0.1);
});

test("known note→divider: C6 snaps to AUDF=14 (mode 4) ≈ exact", () => {
  const snap = noteToAudf(noteToSemitone("C6"), DIST_MELODY);
  assert.equal(snap.audf, 14);
  assert.ok(Math.abs(snap.hz - 1046.65) < 0.1);     // chip frequency
  assert.ok(Math.abs(snap.wantHz - 1046.5) < 0.1);  // ideal C6
  assert.ok(Math.abs(snap.cents) < 1);              // < 1 cent error → near-exact
});

test("known note→divider: A4=440Hz is out of mode-4 range → snaps to AUDF=31", () => {
  // mode 4's lowest pitch (AUDF=31) is ~490.6 Hz, above A4. So A4 snaps up to the
  // floor AUDF=31 — a documented ~+189-cent approximation of the 32-pitch chip.
  const snap = noteToAudf(noteToSemitone("A4"), DIST_MELODY);
  assert.equal(snap.audf, 31);
  assert.ok(Math.abs(snap.hz - 490.62) < 0.1);
  assert.ok(Math.abs(snap.cents - 188.5) < 1); // sharp by ~189 cents
});

test("compileSong emits 3 bytes/row + {0,0,0} sentinel (matches driver)", () => {
  const { bytes, rows, melody } = compileSong({ rows: ["C6", "A5", "E5"], defaultFrames: 15 });
  assert.equal(rows, 3);
  assert.equal(bytes.length, 3 * 3 + 3); // 3 rows + 3-byte sentinel
  // sentinel is the trailing {0,0,0} the driver's frames==0 loop check reads.
  assert.deepEqual([...bytes.slice(-3)], [0, 0, 0]);
  // row 0 = C6 → distortion 4, AUDF 14, 15 frames.
  assert.deepEqual([...bytes.slice(0, 3)], [4, 14, 15]);
  assert.equal(melody.snapped[0].distortion, DIST_MELODY);
  assert.equal(melody.snapped[0].audf, 14);
});

test("shorthand 'C6:30' sets frames; {audf} uses a raw divider", () => {
  const { bytes } = compileSong({ rows: ["C6:30", { audf: 9, frames: 8, distortion: 4 }] });
  assert.deepEqual([...bytes.slice(0, 3)], [4, 14, 30]); // C6, 30 frames
  assert.deepEqual([...bytes.slice(3, 6)], [4, 9, 8]);   // raw AUDF=9, 8 frames
});

test("two-voice: melody (dist 4) + bass (dist 6) concatenated, each own sentinel", () => {
  const { bytes, melody, bass } = compileSong({
    rows: ["C6"],
    bass: ["C4"],
    defaultFrames: 15,
    bassDefaultFrames: 60,
  });
  // melody table (3 + sentinel 3) then bass table (3 + sentinel 3) = 12 bytes
  assert.equal(bytes.length, 12);
  assert.deepEqual([...melody.bytes], [4, 14, 15, 0, 0, 0]);
  assert.equal(bass.bytes[0], DIST_BASS); // bass uses distortion 6
  assert.equal(bass.bytes[bass.bytes.length - 1], 0); // its own {0,0,0} sentinel
  assert.deepEqual([...bass.bytes.slice(-3)], [0, 0, 0]);
});

test("AUDF stays within the 5-bit (0..31) divider the driver masks with &0x1F", () => {
  const { bytes } = compileSong({ rows: ["C8", "C2"] }); // very high + very low notes
  for (let i = 0; i < bytes.length; i += 3) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0) continue; // sentinel
    assert.ok(bytes[i + 1] <= 31, `AUDF ${bytes[i + 1]} exceeds 5-bit range`);
  }
});

test("frames out of range, bad distortion, and bad note name throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "C6", frames: 999 }] }));
  assert.throws(() => compileSong({ rows: [{ note: "C6", frames: 0 }] })); // 0 is the sentinel
  assert.throws(() => compileSong({ rows: [{ note: "C6", distortion: 99 }] }));
  assert.throws(() => compileSong({ rows: ["H9"] }));
});

test("semitoneToHz: A4 = 440, octave doubles", () => {
  assert.equal(semitoneToHz(57), 440);
  assert.ok(Math.abs(semitoneToHz(69) - 880) < 1e-9);
});
