// C64 SID song compiler — note/duration → the bundled c64_music.c driver's
// per-voice (freq, length_frames) tables. Driver contract:
//   typedef struct { uint16_t freq; uint8_t len; } Note;
//   static const Note melody[]/bass[]/harmony[];  // voices 0/1/2
//   freq = round(Hz / 0.0596);  freq==0 is a rest;  no sentinel — voices wrap.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSong,
  noteToSemitone,
  semitoneToHz,
  hzToSidFreq,
  noteToSidFreq,
  N_REST,
  SID_FREQ_K,
} from "../src/platforms/c64/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48);   // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("pitch math: A4=440Hz → SID divider round(440/0.0596) = 0x1CD7", () => {
  // The stated contract: equal-tempered A4=440 Hz, freq = round(Hz / 0.0596).
  assert.equal(SID_FREQ_K, 0.0596);
  assert.ok(Math.abs(semitoneToHz(noteToSemitone("A4")) - 440) < 1e-9);
  assert.equal(hzToSidFreq(440), 0x1CD7);          // 7383
  assert.equal(noteToSidFreq("A4"), 0x1CD7);       // the verified note→value
  // C4 = 261.626 Hz → round(/0.0596) = 4390 = 0x1126.
  assert.equal(noteToSidFreq("C4"), 0x1126);
  // Octave doubling: C5 ≈ 2× the SID word of C4 (±1 rounding).
  assert.ok(Math.abs(noteToSidFreq("C5") - 2 * noteToSidFreq("C4")) <= 1);
});

test("mono song fills voice 0; voices 1 & 2 get a looping silent rest", () => {
  const r = compileSong({ rows: ["C4", "E4", "G4"], defaultFrames: 10 });
  // voice0 = 3 notes; voice1 & voice2 = 1 silent-loop rest each.
  assert.deepEqual(r.voiceRows, [3, 1, 1]);
  assert.equal(r.rows, 5);
  // voice1/voice2 placeholders are rests (freq 0) that loop at len 255.
  assert.equal(r.voices[1][0].freq, N_REST);
  assert.equal(r.voices[2][0].freq, N_REST);
  assert.equal(r.voices[1][0].len, 255);
});

test("byte layout = per-voice [freq_lo, freq_hi, len], voices concatenated", () => {
  const r = compileSong({ rows: ["A4:10"], defaultFrames: 10 });
  // voice0: A4 = 0x1CD7 → lo 0xD7, hi 0x1C, len 10. Then two silent loops.
  assert.deepEqual([...r.bytes.slice(0, 3)], [0xD7, 0x1C, 10]);
  // voice1 placeholder rest: lo 0x00, hi 0x00, len 255.
  assert.deepEqual([...r.bytes.slice(3, 6)], [0x00, 0x00, 255]);
  // voice2 placeholder rest.
  assert.deepEqual([...r.bytes.slice(6, 9)], [0x00, 0x00, 255]);
  // 1 + 1 + 1 notes = 9 bytes, NO trailing sentinel (driver wraps).
  assert.equal(r.bytes.length, 9);
});

test("rest row → freq 0x0000 (driver gates off without retrigger)", () => {
  const r = compileSong({ rows: ["C4", "rest:20", { rest: true, frames: 5 }] });
  assert.equal(r.voices[0][1].freq, N_REST);
  assert.equal(r.voices[0][1].len, 20);
  assert.equal(r.voices[0][2].freq, N_REST);
  assert.equal(r.voices[0][2].len, 5);
});

test("3-voice song fills all three named tables; cSource has the array names", () => {
  const r = compileSong({
    melody: ["A4", "C5"],
    bass: ["A3:80"],
    harmony: ["C4", "E4", "rest"],
    defaultFrames: 10,
  });
  assert.deepEqual(r.voiceRows, [2, 1, 3]);
  assert.equal(r.rows, 6);
  // Exact array names + struct the driver reads.
  assert.match(r.cSource, /static const Note melody\[\] = \{/);
  assert.match(r.cSource, /static const Note bass\[\] = \{/);
  assert.match(r.cSource, /static const Note harmony\[\] = \{/);
  // A4 row appears as the verified SID word literal.
  assert.match(r.cSource, /0x1CD7u/);
  // No C-level sentinel/terminator emitted (driver wraps by length).
  assert.doesNotMatch(r.cSource, /N_END|terminator|0xFFFFu, *0/);
});

test("raw freq word + SNES-style `ticks` length both accepted", () => {
  const r = compileSong({ rows: [{ freq: 0x1234, ticks: 12 }] });
  assert.equal(r.voices[0][0].freq, 0x1234);
  assert.equal(r.voices[0][0].len, 12);
  assert.deepEqual([...r.bytes.slice(0, 3)], [0x34, 0x12, 12]);
});

test("explicit voices array maps to [melody, bass, harmony]", () => {
  const r = compileSong({ voices: [["C4"], ["C3"], ["G4"]] });
  assert.deepEqual(r.voiceRows, [1, 1, 1]);
  assert.equal(r.voices[0][0].freq, noteToSidFreq("C4"));
  assert.equal(r.voices[1][0].freq, noteToSidFreq("C3"));
  assert.equal(r.voices[2][0].freq, noteToSidFreq("G4"));
});

test("length out of range and bad note name throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "C4", frames: 999 }] }));
  assert.throws(() => compileSong({ rows: [{ note: "C4", frames: 0 }] }));
  assert.throws(() => compileSong({ rows: ["H9"] }));
  assert.throws(() => compileSong({ rows: [{ freq: 70000, frames: 4 }] }));
});
