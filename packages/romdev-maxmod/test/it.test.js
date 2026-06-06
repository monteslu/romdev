// Tests for src/it.js — the Impulse Tracker (.IT) parser.
//
// Reference values below were captured from the ORIGINAL mmutil C parser
// (devkitPro mmutil 1.10.1, it.c) compiled and run on the same fixtures, with
// FixSample() stubbed so we compare the raw parser output. The fixtures are
// real .it modules (from the pvsneslib SNES audio examples).
//
//   sample.it  — instrument-mode IT, 1 sample (16-bit signed, fmt=3, looped)
//   effects.it — instrument-mode IT, 5 samples (16-bit signed, fmt=3)
//
// We assert: header fields, instrument/envelope decode, sample headers, and
// FNV-style checksums over the fully decoded PCM and pattern data, so a
// regression anywhere in the parse path is caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseIt, MAX_CHANNELS, SAMPF_16BIT } from '../src/it.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (name) => new Uint8Array(readFileSync(join(here, name)));

// FNV-ish rolling hash matching the C reference dumper:
//   sum = (sum*131 + x) mod 2^32   (computed in BigInt as unsigned long)
function hash131(values) {
  let sum = 0n;
  for (const v of values) sum = (sum * 131n + BigInt(v)) & 0xffffffffn;
  return sum;
}

function sampleDataHash(s) {
  return hash131(s.data); // typed array iterates element-wise
}

function patternDataHash(p) {
  const flat = [];
  for (let i = 0; i < p.nrows * MAX_CHANNELS; i++) {
    const e = p.data[i];
    flat.push(e.note, e.inst, e.vol, e.fx, e.param);
  }
  return hash131(flat);
}

test('parseIt: rejects non-IT data', () => {
  assert.throws(() => parseIt(new Uint8Array([0x00, 0x01, 0x02, 0x03])), /ERR_INVALID_MODULE/);
});

test('parseIt: sample.it header + instrument + sample + patterns', () => {
  const m = parseIt(load('sample.it'));

  // header
  assert.equal(m.title, 'spc2it conversion');
  assert.equal(m.order_count, 3);
  assert.equal(m.inst_count, 1);
  assert.equal(m.samp_count, 1);
  assert.equal(m.patt_count, 2);
  assert.equal(m.stereo, true);
  assert.equal(m.inst_mode, true);
  assert.equal(m.freq_mode, 8); // raw masked bit (w & 8), as in it.c
  assert.equal(m.old_effects, false);
  assert.equal(m.link_gxx, false);
  assert.equal(m.global_volume, 128);
  assert.equal(m.initial_speed, 1);
  assert.equal(m.initial_tempo, 250);
  assert.deepEqual(Array.from(m.orders.slice(0, 3)), [0, 1, 255]);

  // channel volume/panning mapping (b*4 clamp for pan)
  assert.equal(m.channel_volume[0], 64);
  assert.equal(m.channel_panning[0], 0);
  assert.equal(m.channel_panning[4], 255);

  // instrument
  const inst = m.instruments[0];
  assert.equal(inst.name, 'SPC2ITSAMPLE');
  assert.equal(inst.global_volume, 128);
  assert.equal(inst.setpan, 64);
  assert.equal(inst.fadeout, 8);
  assert.equal(inst.nna, 0);
  assert.equal(inst.env_flags, 1); // volume env valid

  // sample header
  const s = m.samples[0];
  assert.equal(s.name, 'SPC2ITSAMPLE');
  assert.equal(s.filename, 'SPC2ITSAMPLE');
  assert.equal(s.global_volume, 64);
  assert.equal(s.default_volume, 64);
  assert.equal(s.default_panning, 0);
  assert.equal(s.sample_length, 224);
  assert.equal(s.loop_start, 112);
  assert.equal(s.loop_end, 224);
  assert.equal(s.loop_type, 1);
  assert.equal(s.frequency, 29375);
  assert.equal(s.format, 3); // SAMPF_16BIT | SAMPF_SIGNED
  assert.equal(s.it_compression, 0);
  assert.equal(s.msl_index, 0xffff);
  assert.ok(s.format & SAMPF_16BIT);
  assert.equal(s.data.length, 224);

  // patterns (C reference checksums)
  assert.equal(m.patterns[0].nrows, 128);
  assert.equal(m.patterns[0].clength, 1025);
  assert.equal(patternDataHash(m.patterns[0]), 441743671n);
  assert.equal(m.patterns[1].nrows, 128);
  assert.equal(m.patterns[1].clength, 610);
  assert.equal(patternDataHash(m.patterns[1]), 1193563349n);
});

test('parseIt: effects.it — 16-bit uncompressed PCM decode (C reference checksums)', () => {
  const m = parseIt(load('effects.it'));
  assert.equal(m.samp_count, 5);
  assert.equal(m.patt_count, 2);

  const expectLen = [15536, 8016, 8416, 2512, 2000];
  const expectSum = [3743658362n, 2777654834n, 1931372114n, 1778581452n, 1693838912n];
  const expectNames = ['tada', 'Hall Strings', 'Honky Tonk Piano', 'Marimba 1', 'Cowbell'];
  for (let i = 0; i < 5; i++) {
    const s = m.samples[i];
    assert.equal(s.name, expectNames[i]);
    assert.equal(s.format, 3); // 16-bit signed
    assert.equal(s.sample_length, expectLen[i]);
    assert.equal(s.data.length, expectLen[i]);
    // signed->unsigned centering: silence samples become 32768
    assert.equal(s.data[0], 32768);
    assert.equal(sampleDataHash(s), expectSum[i], `sample ${i} (${s.name}) data hash`);
  }

  // pattern checksums
  assert.equal(m.patterns[0].nrows, 64);
  assert.equal(m.patterns[0].clength, 89);
  assert.equal(patternDataHash(m.patterns[0]), 4076340987n);
  assert.equal(m.patterns[1].nrows, 64);
  assert.equal(m.patterns[1].clength, 74);
  assert.equal(patternDataHash(m.patterns[1]), 530832109n);
});

test('parseIt: empty-cell sentinels (note=250, vol=255) populate every cell', () => {
  const m = parseIt(load('sample.it'));
  // Every parsed cell must have note/vol set (either a real value or sentinel).
  for (const p of m.patterns) {
    assert.equal(p.data.length, p.nrows * MAX_CHANNELS);
    for (const e of p.data) {
      assert.ok(e.note >= 0 && e.note <= 255);
      assert.ok(e.vol >= 0 && e.vol <= 255);
    }
  }
});

test('parseIt: fixSample hook is invoked once per sample after decode', () => {
  const seen = [];
  const m = parseIt(load('effects.it'), {
    fixSample: (s) => {
      // data must already be decoded when the hook runs (matches it.c, where
      // FixSample is the last thing in Load_IT_SampleData).
      assert.ok(s.data, 'sample data decoded before fixSample');
      seen.push(s.name);
    },
  });
  assert.equal(seen.length, m.samp_count);
});
