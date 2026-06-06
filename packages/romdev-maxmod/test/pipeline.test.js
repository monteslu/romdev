// End-to-end pipeline tests: soundbankFromModule() must be BYTE-IDENTICAL to
// the REAL devkitPro mmutil (with FixSample ACTIVE — the GBA sample fixer that
// down-converts to 8-bit, trims post-loop data, and unrolls short loops up to
// GBA_MIN_LOOP_SIZE=512). The reference .bin files here were produced by the
// stock mmutil 1.10.x C source (NOT the FixSample-stubbed build used by
// mas.test.js):
//
//   chiptune_xm.bin        — mmutil chiptune.xm        (MOD_CHIPTUNE)
//   serializer_mod_fixed.bin — mmutil serializer.mod   (MOD_SERIALIZER)
//   sample_it_fixed.bin    — mmutil sample.it          (MOD_SAMPLE)
//
// This is the path real consumers use, and the one that regressed (the GBA
// FixSample loop-unroll was never wired, so looped samples were emitted at
// their raw length instead of the unrolled >=512 length).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { soundbankFromModule } from '../src/index.js';
import { parseXm } from '../src/xm.js';
import { FixSample } from '../src/samplefix.js';
import { makeSample } from '../src/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadBin = (name) => new Uint8Array(readFileSync(join(here, name)));

/** Index of the first differing byte, or -1 if identical. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function assertBinEqual(actual, expected, label) {
  const d = firstDiff(actual, expected);
  if (d === -1) return;
  assert.fail(
    `${label}: first diff at byte 0x${d.toString(16)} (js len ${actual.length}, ref len ${expected.length})`,
  );
}

test('soundbankFromModule: chiptune.xm → byte-identical to real mmutil (GBA loop unroll)', () => {
  const { bin } = soundbankFromModule(loadBin('chiptune.xm'), { name: 'chiptune' });
  assertBinEqual(bin, loadBin('chiptune_xm.bin'), 'XM bin');
});

test('soundbankFromModule: serializer.mod → byte-identical to real mmutil (looped + unlooped)', () => {
  const { bin } = soundbankFromModule(loadBin('serializer.mod'), { name: 'serializer' });
  assertBinEqual(bin, loadBin('serializer_mod_fixed.bin'), 'MOD bin');
});

test('soundbankFromModule: sample.it → byte-identical to real mmutil', () => {
  const { bin } = soundbankFromModule(loadBin('sample.it'), { name: 'sample' });
  assertBinEqual(bin, loadBin('sample_it_fixed.bin'), 'IT bin');
});

test('FixSample (GBA): short forward loop unrolls to >= GBA_MIN_LOOP_SIZE (512)', () => {
  // chiptune.xm's only sample: 256-byte forward loop. samplefix.c FixSample_GBA
  // unrolls (512/256)+1 = 3 extra copies → 256 + 256*3 = 1024.
  const mod = parseXm(loadBin('chiptune.xm'), { fixSample: FixSample });
  const s = mod.samples[0];
  assert.equal(s.sample_length, 1024, 'unrolled length');
  assert.equal(s.loop_start, 0, 'loop_start');
  assert.equal(s.loop_end, 1024, 'loop_end == length');
  assert.equal(s.loop_type, 1, 'forward loop preserved');
  assert.equal(s.data.length, 1024, 'PCM grown to match');
});

test('FixSample (GBA): unrolled loop region tiles the source loop exactly', () => {
  const mod = parseXm(loadBin('chiptune.xm'), { fixSample: FixSample });
  const s = mod.samples[0];
  // Every appended sample equals data[(loop_start) + (i % looplen)] from the
  // original 256-sample loop (Unroll_Sample_Loop semantics).
  for (let i = 256; i < 1024; i++) {
    assert.equal(s.data[i], s.data[i % 256], `tile at ${i}`);
  }
});

test('FixSample (GBA): unlooped sample is left at its raw length', () => {
  // A constructed unlooped 8-bit sample must NOT be unrolled or trimmed.
  const s = makeSample();
  s.format = 0; // 8-bit
  s.sample_length = 10;
  s.loop_type = 0;
  s.loop_start = 0;
  s.loop_end = 0;
  s.frequency = 8000;
  s.data = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  FixSample(s);
  assert.equal(s.sample_length, 10, 'length unchanged');
  assert.deepEqual(Array.from(s.data), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'PCM unchanged');
});
