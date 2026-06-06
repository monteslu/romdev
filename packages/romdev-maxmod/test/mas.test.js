// Tests for src/mas.js — the MAS / GBA-sample / MSL-soundbank SERIALIZER.
//
// Reference outputs (serializer_*.bin / serializer_*.h) were produced by the
// ORIGINAL devkitPro mmutil C (1.10.x) compiled with FixSample() stubbed to a
// no-op — so the C serializer consumes the SAME raw parser output our JS
// parsers (it.js/mod.js) produce (no sample-fixup divergence). The JS pipeline
// here parses the identical fixtures and emits the soundbank via
// writeSoundbank(); we assert the result is BYTE-FOR-BYTE identical to the C
// soundbank .bin and the generated .h header.
//
// Coverage across these fixtures spans every serializer branch:
//   serializer_it.{bin,h}  — sample.it + effects.it: 2 modules, 6 unique
//       samples, instrument-mode (FULL 240-byte notemap), instrument
//       envelopes, IT pattern compression + Mark_Patterns, MSL dedup pool.
//   serializer_mod.{bin,h} — serializer.mod: single module, single-sample
//       notemap FAST PATH (0x8000|idx), a LOOPED sample (4-byte loop-restart
//       tail) and an UNLOOPED sample (0x80×4 tail), a pattern-break (Dxx) that
//       drives Mark_Patterns, run-length suppression, and the Cxx volume path.
//   (constructed)          — a standalone WAV/SFX sample via MSL_AddSample
//       (no dedup) producing an SFX_ #define, pooled before module samples.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseIt } from '../src/it.js';
import { parseMod } from '../src/mod.js';
import { writeSoundbank, printDefinition, MAS_VERSION } from '../src/mas.js';
import { makeSample } from '../src/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadBin = (name) => new Uint8Array(readFileSync(join(here, name)));
const loadTxt = (name) => readFileSync(join(here, name), 'latin1');

/** Index of the first differing byte, or -1 if identical prefix. */
function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function assertBinEqual(actual, expected, label) {
  const d = firstDiff(actual, expected);
  if (d === -1) return;
  const lo = Math.max(0, d - 8);
  const hi = Math.min(Math.max(actual.length, expected.length), d + 16);
  const hex = (a) =>
    Array.from(a.slice(lo, hi))
      .map((b) => (b ?? 0).toString(16).padStart(2, '0'))
      .join(' ');
  assert.fail(
    `${label}: first diff at byte 0x${d.toString(16)} ` +
      `(js len ${actual.length}, ref len ${expected.length})\n` +
      `  js : ${hex(actual)}\n  ref: ${hex(expected)}`,
  );
}

test('writeSoundbank: 2 IT modules → byte-identical .bin + .h (full notemap, envelopes, dedup)', () => {
  const inputs = ['sample.it', 'effects.it'];
  const modules = inputs.map((p) => parseIt(loadBin(p)));
  // The C munges the INPUT PATH for the MOD_ define; mmutil was run with bare
  // basenames "sample.it"/"effects.it" → MOD_SAMPLE / MOD_EFFECTS.
  const moduleMeta = inputs.map((p) => ({ filename: p }));

  const { bin, header } = writeSoundbank(modules, [], { moduleMeta });

  assertBinEqual(bin, loadBin('serializer_it.bin'), 'IT bin');
  assert.equal(header, loadTxt('serializer_it.h'), 'IT header');
});

test('writeSoundbank: single MOD → byte-identical (single-sample notemap, loop tails, pattern-break)', () => {
  const mod = parseMod(loadBin('serializer.mod'));
  const { bin, header } = writeSoundbank([mod], [], {
    // mmutil was invoked as "serializer.mod" → MOD_SERIALIZER... but the
    // fixture .h was generated with the path "/tmp/test.mod" → MOD_TEST.
    // Use that exact name so the .h matches the captured reference.
    moduleMeta: [{ filename: 'test.mod' }],
  });

  assertBinEqual(bin, loadBin('serializer_mod.bin'), 'MOD bin');
  assert.equal(header, loadTxt('serializer_mod.h'), 'MOD header');
});

test('writeSoundbank: standalone WAV/SFX sample is added without dedup and emits an SFX_ define', () => {
  const mod = parseMod(loadBin('serializer.mod'));

  // Construct the sample exactly as mmutil's Load_WAV would for an 8-bit mono
  // WAV (freq 8000, 8 unsigned bytes, no loop), with the '#' SFX flag main.c
  // sets. (No wav.js parser is shipped; the serializer accepts model samples.)
  const wav = makeSample();
  wav.frequency = 8000;
  wav.format = 0; // 8-bit
  wav.sample_length = 8;
  wav.loop_type = 0;
  wav.data = Uint8Array.from([128, 140, 108, 160, 88, 180, 68, 200]);
  wav.filename = '#'; // SFX flag

  const { bin, header } = writeSoundbank(
    [mod],
    [{ samp: wav, name: 'beep.wav' }],
    { moduleMeta: [{ filename: 'test.mod' }] },
  );

  // NSAMPS = 1 (wav) + 3 (mod samp_count) = 4; the SFX is pool index 0.
  assert.match(header, /#define SFX_BEEP\t0\r\n/);
  assert.match(header, /#define MSL_NSAMPS\t4\r\n/);
  assert.match(header, /#define MSL_NSONGS\t1\r\n/);
  assert.match(header, /#define MSL_BANKSIZE\t5\r\n/);

  // The bank header: NSAMPS=4, NSONGS=1, then the '*maxmod*' magic.
  assert.equal(bin[0] | (bin[1] << 8), 4, 'MSL_NSAMPS word');
  assert.equal(bin[2] | (bin[3] << 8), 1, 'MSL_NSONGS word');
  assert.deepEqual(
    Array.from(bin.slice(4, 12)),
    [0x2a, 0x6d, 0x61, 0x78, 0x6d, 0x6f, 0x64, 0x2a],
    "'*maxmod*' magic",
  );
});

test('MAS_VERSION is 0x18 (version.h)', () => {
  assert.equal(MAS_VERSION, 0x18);
});

test('printDefinition: basename + uppercase + non-alnum→_ + stop at first dot (msl.c)', () => {
  // basename after last slash, stop at first '.', uppercase, munge punctuation.
  assert.equal(printDefinition('foo.it', 3, 'MOD_'), '#define MOD_FOO\t3\r\n');
  assert.equal(
    printDefinition('/a/b/My Song.mod', 0, 'MOD_'),
    '#define MOD_MY_SONG\t0\r\n',
  );
  assert.equal(
    printDefinition('C:\\path\\beep-1.wav', 7, 'SFX_'),
    '#define SFX_BEEP_1\t7\r\n',
  );
  // empty filename → no line (C early-return).
  assert.equal(printDefinition('', 0, 'MOD_'), '');
  // name stops at the FIRST dot.
  assert.equal(printDefinition('a.b.c', 1, 'X_'), '#define X_A\t1\r\n');
});
