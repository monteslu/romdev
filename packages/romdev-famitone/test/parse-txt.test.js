// Tests for the FamiTracker .txt parser port (parse-txt.js).
//
// Validation source: Shiru's famitone2d test suite (TESTS/*.txt + *.s) plus the
// bundled music_data.s. We assert the parsed in-memory model matches the facts
// encoded in those known-good text2data outputs.
//
// The test fixtures live in the upstream port-source tree, which is NOT part of
// this package. If they are absent (e.g. on a clean checkout / CI without the
// donor tree), the fixture-backed tests are skipped; the self-contained
// synthetic tests always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  parseFamiTrackerTxt,
  isFamiTrackerTextExport,
  FamiTrackerParseError,
} from '../src/parse-txt.js';

const FIXTURES = '<ROMDEV_TEST_FIXTURES>';
const haveFixtures = existsSync(FIXTURES + 'TestMusic3.txt');
const readFix = (f) => readFileSync(FIXTURES + f, 'utf8');

// ---------------------------------------------------------------------------
// Self-contained synthetic export (no external fixtures needed).
// ---------------------------------------------------------------------------

const MINI = `# FamiTracker text export 0.4.2

# Song information
TITLE           "Mini"
AUTHOR          "tester"
COPYRIGHT       "2026"

# Global settings
MACHINE         0

# Macros
MACRO       0   0  -1  -1   0 : 6 15 12 9 7 6 5 4 2
MACRO       4   0   0  -1   0 : 2

# Instruments
INST2A03   0     0  -1  -1  -1   0 "Lead"

# Tracks

TRACK   3   6 150 "synth"
COLUMNS : 1 1 1 1 1

ORDER 00 : 00 00 00 00 00

PATTERN 00
ROW 00 : C-4 00 . ... : ... .. . ... : ... .. . ... : ... .. . ... : ... .. . ...
ROW 01 : ... .. . ... : ... .. . ... : ... .. . ... : ... .. . ... : ... .. . ...
ROW 02 : ... .. . B00 : ... .. . ... : ... .. . ... : ... .. . ... : ... .. . ...

# End of export
`;

test('isFamiTrackerTextExport detects the header', () => {
  assert.equal(isFamiTrackerTextExport(MINI), true);
  assert.equal(isFamiTrackerTextExport('[Module]\nName=foo'), false);
});

test('non-FT-export input throws', () => {
  assert.throws(() => parseFamiTrackerTxt('[Module]\n'), FamiTrackerParseError);
});

test('mini export: title/author/tempo/note encoding', () => {
  const m = parseFamiTrackerTxt(MINI, { songName: 'Mini' });
  assert.equal(m.title, 'Mini');
  assert.equal(m.author, 'tester');
  assert.equal(m.subSongsCount, 1);
  assert.deepEqual(m.subSongNames, ['synth']);
  assert.equal(m.speed, 6);
  assert.equal(m.tempo, 150);

  const s = m.subsongs[0].song;
  // B00 at row 2 -> order_loop 0, pattern cut to length 3 (row+1)
  assert.equal(s.order_length, 1);
  assert.equal(s.order_loop, 0);
  assert.equal(s.pattern[0].length, 3);

  // C-4: C=2, octave 4 -> 2 + 12*4 = 50, then -12 -> 38
  assert.equal(s.pattern[0].row[0].channel[0].note, 38);
  assert.equal(s.pattern[0].row[0].channel[0].instrument, 0);

  // volume envelope 0 values intact
  const v0 = m.envelopes.volume[0];
  assert.deepEqual(Array.from(v0.value.slice(0, v0.length)), [6, 15, 12, 9, 7, 6, 5, 4, 2]);

  // duty macro value[0] = 2
  assert.equal(m.envelopes.duty[0].value[0], 2);
});

test('note out of range throws', () => {
  const bad = MINI.replace('C-4 00', 'C-9 00');
  assert.throws(() => parseFamiTrackerTxt(bad), FamiTrackerParseError);
});

// ---------------------------------------------------------------------------
// Fixture-backed tests against the known-good text2data outputs.
// ---------------------------------------------------------------------------

test('TestMusic3: matches music_data.s facts', { skip: !haveFixtures }, () => {
  const m = parseFamiTrackerTxt(readFix('TestMusic3.txt'), { songName: 'TestMusic3' });

  assert.equal(m.title, '2 new songs');
  assert.equal(m.author, 'doug fraker');
  assert.equal(m.subSongsCount, 2);
  assert.deepEqual(m.subSongNames, ['Caribou', 'Pause']);

  // 4 instruments in use (0..3); instrument 4 "Drum" is unused by these songs.
  const used = m.instruments.map((x, i) => (x.in_use ? i : null)).filter((x) => x !== null);
  assert.deepEqual(used, [0, 1, 2, 3]);

  // instrument env ids -> @env1,@env2,@env3,@env4 (after default @env0)
  assert.deepEqual(
    used.map((i) => m.instruments[i].volume),
    [0, 1, 2, 3],
  );
  // duty env ids: inst0 -> duty env 0, inst1..3 -> duty env 1; both value[0]=2
  assert.deepEqual(
    used.map((i) => m.instruments[i].duty),
    [0, 1, 1, 1],
  );
  assert.equal(m.envelopes.duty[0].value[0] & 3, 2); // -> $b0 duty byte
  assert.equal(m.envelopes.duty[1].value[0] & 3, 2);

  // volume envelope 0 -> @env1 bytes: each value +192, loop-to-last.
  const v0 = m.envelopes.volume[0];
  assert.deepEqual(Array.from(v0.value.slice(0, v0.length)), [6, 15, 12, 9, 7, 6, 5, 4, 2]);

  // subsong 0: 6 order positions, full 64-row patterns, loop at 0, speed 7
  const s0 = m.subsongs[0].song;
  assert.equal(s0.speed, 7);
  assert.equal(s0.tempo, 150);
  assert.equal(s0.order_length, 6);
  assert.equal(s0.order_loop, 0);
  assert.deepEqual(
    s0.pattern.map((p) => p.length),
    [64, 64, 64, 64, 64, 64],
  );

  // subsong 1 "Pause": B00 at row 31 cuts pattern to length 32, loop 0, speed 6
  const s1 = m.subsongs[1].song;
  assert.equal(s1.speed, 6);
  assert.equal(s1.order_length, 1);
  assert.equal(s1.order_loop, 0);
  assert.deepEqual(
    s1.pattern.map((p) => p.length),
    [32],
  );

  // note encoding: pos0 row0 ch0 is E-3 -> note 30 -> note byte ((30-1)<<1)=0x3a
  assert.equal(s0.pattern[0].row[0].channel[0].note, 30);
  // ch2 row0 C-4 -> 38
  assert.equal(s0.pattern[0].row[0].channel[2].note, 38);
  // noise ch3 row0 "9-#": hex 9 -> ((9+15)&15)+2 = 10
  assert.equal(s0.pattern[0].row[0].channel[3].note, 10);
});

test('testA: unsupported effect throws by default, ok with -Wno', { skip: !haveFixtures }, () => {
  const txt = readFix('testA.txt');
  assert.throws(() => parseFamiTrackerTxt(txt, { songName: 'testA' }), FamiTrackerParseError);
  const m = parseFamiTrackerTxt(txt, { songName: 'testA', noWarnings: true });
  assert.equal(m.subsongs[0].song.pattern[0].length, 5); // D00 cut at row 4
});

test('testE: -allin keeps unused instruments', { skip: !haveFixtures }, () => {
  const txt = readFix('testE.txt');
  const usedOf = (m) => m.instruments.map((x, i) => (x.in_use ? i : null)).filter((x) => x !== null);
  assert.deepEqual(usedOf(parseFamiTrackerTxt(txt, { songName: 'testE' })), [0]);
  assert.deepEqual(usedOf(parseFamiTrackerTxt(txt, { songName: 'testE', keepInstruments: true })), [0, 1]);
});

test('testD/testF/testG: nesdoug shortest/loop bug-fix lengths', { skip: !haveFixtures }, () => {
  const d = parseFamiTrackerTxt(readFix('testD.txt'), { songName: 'testD' });
  assert.deepEqual(d.subsongs[0].song.pattern.map((p) => p.length), [5]);

  const f = parseFamiTrackerTxt(readFix('testF.txt'), { songName: 'testF' });
  assert.deepEqual(f.subsongs[0].song.pattern.map((p) => p.length), [5]);

  const g = parseFamiTrackerTxt(readFix('testG.txt'), { songName: 'testG' });
  const sg = g.subsongs[0].song;
  assert.equal(sg.order_length, 3);
  assert.equal(sg.order_loop, 1);
  assert.deepEqual(sg.pattern.map((p) => p.length), [5, 5, 5]);
});
