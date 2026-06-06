// Byte-exact fidelity tests for the FamiTone2 text2data emitter port.
//
// Fixtures vendored from Shiru's famitone2d test suite + the nesdoug bug-fix
// fork (TESTS/). TestMusic3_good.s was produced by the ORIGINAL Shiru tool (no
// per-subsong name comments); the testA-G *.s files were produced by the fork
// (with name comments) and exercise the bug-fix edge cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { emitFamiTone2 } from '../src/emit-ft2.js';

const here = dirname(fileURLToPath(import.meta.url));
const fix = (f) => readFileSync(join(here, 'fixtures', f), 'utf8');

// firstDiff: report the first differing line for a clear assertion message
function firstDiff(out, good) {
  const a = out.split('\n');
  const b = good.split('\n');
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; ++i) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n  out : ${JSON.stringify(a[i])}\n  good: ${JSON.stringify(b[i])}`;
    }
  }
  return 'lengths differ but no line diff found';
}

test('TestMusic3: byte-exact match to original-Shiru golden (no name comments)', () => {
  const out = emitFamiTone2(fix('TestMusic3.txt'), { name: 'TestMusic3' });
  const good = fix('TestMusic3_good.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('testA: -Wno silences the unsupported effect (300)', () => {
  const out = emitFamiTone2(fix('testA.txt'), { name: 'testA', noWarnings: true, subsongComments: true });
  const good = fix('testA.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('testA: without -Wno the unsupported effect throws', () => {
  assert.throws(
    () => emitFamiTone2(fix('testA.txt'), { name: 'testA' }),
    /Unsupported effect/,
  );
});

test('testD: multiple D00 in a pattern on different channels', () => {
  const out = emitFamiTone2(fix('testD.txt'), { name: 'testD', subsongComments: true });
  const good = fix('testD.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('testE: -allin keeps the (otherwise unused) instrument', () => {
  const out = emitFamiTone2(fix('testE.txt'), { name: 'testE', keepInstruments: true, subsongComments: true });
  const good = fix('testE.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('testF: Bxx below D00 in a pattern on a different channel', () => {
  const out = emitFamiTone2(fix('testF.txt'), { name: 'testF', subsongComments: true });
  const good = fix('testF.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('testG: Bxx loop carries the correct instrument forward', () => {
  const out = emitFamiTone2(fix('testG.txt'), { name: 'testG', subsongComments: true });
  const good = fix('testG.s');
  assert.equal(out, good, firstDiff(out, good));
});

test('rejects non-FamiTracker-export input', () => {
  assert.throws(() => emitFamiTone2('not a famitracker export', { name: 'x' }), /FamiTracker text export/);
});

test('rejects non-string input', () => {
  assert.throws(() => emitFamiTone2(null, {}), TypeError);
});

test('song label is sanitized to a valid ca65 label', () => {
  const out = emitFamiTone2(fix('TestMusic3.txt'), { name: 'my song!.ftm' });
  assert.match(out, /^my_song__ftm_music_data:$/m);
});
