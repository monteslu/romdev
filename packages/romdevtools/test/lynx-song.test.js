// Lynx (Mikey) song compiler — note/ticks → the bundled cc65 driver's bytestream
// (lib/cc65-src/lynx-snd.s, parsed by SndGetCmd: note/length pairs, 0x82=rest,
// 0x00=end). Pitch comes from the driver's SndPrescaler/SndReload tables via the
// Mikey square-wave formula f = 1e6/(2^prescaler·(reload+1)·2).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileSong,
  noteToSemitone,
  indexToFreq,
  snapToIndex,
  semitoneToFreq,
  SND_PRESCALER,
  SND_RELOAD,
  CMD_PAUSE,
  STREAM_END,
} from "../src/platforms/lynx/song.js";

test("note names → absolute semitones (C4=48, A4=57)", () => {
  assert.equal(noteToSemitone("C4"), 48);
  assert.equal(noteToSemitone("A4"), 57);
  assert.equal(noteToSemitone("C-4"), 48); // FamiTracker-style separator
  assert.equal(noteToSemitone("A#3"), 46);
  assert.equal(noteToSemitone("Db4"), 49);
});

test("bundled tables are the 128-entry SndPrescaler/SndReload from lynx-snd.s", () => {
  assert.equal(SND_PRESCALER.length, 128);
  assert.equal(SND_RELOAD.length, 128);
  // spot-check the documented anchor row (index 28).
  assert.equal(SND_PRESCALER[28], 0x03);
  assert.equal(SND_RELOAD[28], 0x8d);
  // index 0 is the rest/terminator slot (prescaler 0, reload 0).
  assert.equal(SND_RELOAD[0], 0x00);
});

test("Mikey pitch math: index 28 = 440.14 Hz = A4 (the table anchor)", () => {
  const f = indexToFreq(28);
  assert.ok(Math.abs(f - 440.14) < 0.05, `index 28 → ${f} Hz, expected ~440.14`);
  // octave neighbours in the table: index 11 ≈ 110 Hz (A2), index 41 ≈ 886 Hz (A5-ish).
  assert.ok(Math.abs(indexToFreq(11) - 110.04) < 0.05);
  // reload $00 wraps to 256 (index 12 uses reload byte $00).
  const f12 = indexToFreq(12);
  assert.ok(Math.abs(f12 - 121.6) < 0.5, `index 12 (reload $00→256) → ${f12} Hz`);
});

test("known note→divider: A4=440Hz snaps to table index 28 (reload $8D, prescaler 3)", () => {
  const snap = snapToIndex(440);
  assert.equal(snap.index, 28);
  assert.ok(Math.abs(snap.freq - 440.14) < 0.05); // chip frequency
  assert.ok(Math.abs(snap.cents) < 2);            // within ~1 cent → near-exact
  assert.equal(SND_RELOAD[snap.index], 0x8d);
  assert.equal(SND_PRESCALER[snap.index], 0x03);
});

test("A4 via compileSong default base resolves to index 28", () => {
  const { detail } = compileSong({ rows: ["A4"] });
  assert.equal(detail[0].index, 28);
  assert.ok(Math.abs(detail[0].cents) < 2);
});

test("compileSong emits note/length pairs + $00 terminator", () => {
  const { bytes, rows } = compileSong({ rows: ["A4", "A4", "A4"], defaultTicks: 30 });
  assert.equal(rows, 3);
  // 3 note rows × 2 bytes + 1 terminator
  assert.equal(bytes.length, 3 * 2 + 1);
  // sentinel: the final byte is $00 (SndStop).
  assert.equal(bytes[bytes.length - 1], STREAM_END);
  assert.equal(STREAM_END, 0x00);
  // row 0 = A4 → note index 28, 30 ticks.
  assert.deepEqual([...bytes.slice(0, 2)], [28, 30]);
});

test("rest emits the 0x82 (SndPause) command + length byte", () => {
  const { bytes } = compileSong({ rows: ["A4:30", { rest: true, ticks: 20 }] });
  assert.deepEqual([...bytes.slice(0, 2)], [28, 30]); // A4, 30t
  assert.deepEqual([...bytes.slice(2, 4)], [CMD_PAUSE, 20]); // rest 20t
  assert.equal(CMD_PAUSE, 0x82);
  assert.equal(bytes[bytes.length - 1], 0x00);
});

test("shorthand 'A4:60' sets ticks; {index} bypasses snapping", () => {
  const { bytes } = compileSong({ rows: ["A4:60", { index: 64, ticks: 8 }] });
  assert.deepEqual([...bytes.slice(0, 2)], [28, 60]); // A4, 60t
  assert.deepEqual([...bytes.slice(2, 4)], [64, 8]);  // raw index 64, 8t
});

test("every emitted note index is in the driver-valid 1..127 range", () => {
  const { bytes } = compileSong({ rows: ["C2", "C8", "A4"] }); // very low + high + mid
  for (let i = 0; i < bytes.length - 1; ) {
    const b = bytes[i];
    if (b === CMD_PAUSE) { i += 2; continue; }
    assert.ok(b >= 1 && b <= 127, `note byte ${b} out of 1..127`);
    i += 2;
  }
});

test("cSource + asm contain a drop-in song table and end markers", () => {
  const { cSource, asm } = compileSong({ rows: ["A4", { rest: true, ticks: 30 }] });
  assert.match(cSource, /unsigned char song\[\] = \{/);
  assert.match(cSource, /28,\s+30/);     // A4 note index, 30 ticks
  assert.match(cSource, /SndStop/);      // terminator comment
  assert.match(asm, /^song:/m);
  assert.match(asm, /\.byte\s+\$00\s+; SndStop/);
});

test("semitoneToFreq: A4 = 440, octave doubles", () => {
  const baseSemi = noteToSemitone("A4");
  assert.equal(semitoneToFreq(baseSemi, baseSemi, 440), 440);
  assert.ok(Math.abs(semitoneToFreq(noteToSemitone("A5"), baseSemi, 440) - 880) < 1e-9);
});

test("ticks out of range, bad index, and bad note name throw", () => {
  assert.throws(() => compileSong({ rows: [{ note: "A4", ticks: 999 }] }));
  assert.throws(() => compileSong({ rows: [{ note: "A4", ticks: 0 }] }));   // 0 is invalid length
  assert.throws(() => compileSong({ rows: [{ index: 200, ticks: 10 }] }));  // > 127
  assert.throws(() => compileSong({ rows: [{ index: 0, ticks: 10 }] }));    // 0 = terminator, not a note
  assert.throws(() => compileSong({ rows: ["H9"] }));
});
