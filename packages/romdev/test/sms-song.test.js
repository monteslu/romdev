// SMS song compiler — note/duration → sms_music.c parallel-array voice table.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSong,
  noteToSemitone,
  semitoneToHz,
  hzToDivider,
  noteToDivider,
  SMS_PSG_CLOCK,
  PSG_DIVIDER_MAX,
  REST_DIVIDER,
} from "../src/platforms/sms/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48);   // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("A4 = 440 Hz → SN76489 divider 254 (the canonical check)", () => {
  // The whole point: divider = round(3579545 / (32 * 440)).
  assert.equal(Math.round(SMS_PSG_CLOCK / (32 * 440)), 254);
  assert.equal(semitoneToHz(noteToSemitone("A4")), 440);
  assert.equal(hzToDivider(440), 254);
  assert.equal(noteToDivider("A4"), 254);
});

test("divider math matches the driver's #defines for clean tunings", () => {
  // C4 261.63Hz→428, C3 130.81Hz→855, E4 329.63Hz→339, B4 493.88Hz→226.
  assert.equal(hzToDivider(261.63), 428);
  assert.equal(hzToDivider(130.81), 855);
  assert.equal(hzToDivider(329.63), 339);
  assert.equal(hzToDivider(493.88), 226);
  // and from note names via equal temperament (A4=440):
  assert.equal(noteToDivider("C3"), 855);
  assert.equal(noteToDivider("E4"), 339);
});

test("divider clamps to the 10-bit PSG register", () => {
  assert.equal(PSG_DIVIDER_MAX, 0x3ff);
  // an absurdly low note would exceed 0x3FF → clamped.
  assert.equal(hzToDivider(1), PSG_DIVIDER_MAX);
  // an absurdly high note → clamped up to at least 1.
  assert.ok(hzToDivider(1e9) >= 1);
});

test("compileSong emits parallel arrays, NO sentinel (SMS-specific shape)", () => {
  const song = { rows: ["A4:18", "C4:18", "rest:9"], voice: 0 };
  const { bytes, freq, len, rows } = compileSong(song);
  assert.equal(rows, 3);

  // freq array: 3 uint16 (A4=254, C4=428, rest=0).
  assert.deepEqual([...freq], [254, 428, REST_DIVIDER]);
  // len array: 3 uint8.
  assert.deepEqual([...len], [18, 18, 9]);

  // Raw byte image = freq[] (2 bytes/row LE) THEN len[] (1 byte/row).
  // No terminator/sentinel byte — total = 3*2 + 3 = 9.
  assert.equal(bytes.length, 3 * 2 + 3);
  assert.deepEqual([...bytes], [
    254, 0,   // A4 LE
    428 & 0xff, (428 >> 8) & 0xff, // C4 = 0xAC,0x01
    0, 0,     // rest
    18, 18, 9, // len[]
  ]);
  // explicitly: there is no 0x00-after-len sentinel — last byte is the last len.
  assert.equal(bytes[bytes.length - 1], 9);
});

test("cSource is a drop-in for one voice (uint16 freq + uint8 len + track_len)", () => {
  const { cSource } = compileSong({ rows: ["A4", "rest"], voice: 1, name: "mel1" });
  assert.match(cSource, /static const uint16_t mel1_freq\[2\] = \{/);
  assert.match(cSource, /static const uint8_t  mel1_len\[2\] = \{/);
  assert.match(cSource, /254/);              // A4 divider present
  assert.match(cSource, /set track_len\[1\] = 2/);
});

test("rest forms: null, 'rest', {note:'rest'} all → divider 0", () => {
  const { freq } = compileSong({ rows: [null, "rest", { note: "rest", frames: 5 }] });
  assert.deepEqual([...freq], [0, 0, 0]);
});

test("raw divider passthrough + default frames", () => {
  const { freq, len } = compileSong({ rows: [{ divider: 200, frames: 12 }, "A4"], defaultFrames: 24 });
  assert.equal(freq[0], 200);
  assert.equal(len[0], 12);
  assert.equal(len[1], 24); // shorthand "A4" took defaultFrames
});

test("out-of-range frames, bad note, and bad divider throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "A4", frames: 999 }] }));
  assert.throws(() => compileSong({ rows: [{ note: "A4", frames: 0 }] }));
  assert.throws(() => compileSong({ rows: ["H9"] }));
  assert.throws(() => compileSong({ rows: [{ divider: 5000 }] })); // > 10-bit
  assert.throws(() => compileSong({ rows: [] }));                  // empty track
});
