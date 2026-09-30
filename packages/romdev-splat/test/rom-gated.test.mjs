// Differential test against a Python splat reference tree. Needs a checkout
// of an N64 decomp project that uses splat 0.37.1 with its baserom, and the
// output tree Python splat produced from it; skips cleanly otherwise.
//
//   ROMDEV_SPLAT_PROJECT=/path/to/checkout      (its yaml + baserom)
//   ROMDEV_SPLAT_CONFIG=config/us/game.us.yaml  (relative to the checkout)
//   ROMDEV_SPLAT_REF=/path/to/reference/tree    (Python splat's outputs)
//   ROMDEV_SPLAT_COMPARE=asm,bin,.splat         (subtrees to compare)
//   ROMDEV_SPLAT_EXCLUDE=regex                  (paths not written by splat)
//   ROMDEV_SPLAT_COPY=config,src,lib,include,tools/splat_ext
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { split, detectProjectVersions } from '../src/index.js';

const env = process.env;
const project = env.ROMDEV_SPLAT_PROJECT;
const ref = env.ROMDEV_SPLAT_REF;
const config = env.ROMDEV_SPLAT_CONFIG;
const ready = project && ref && config && fs.existsSync(path.join(project, config)) && fs.existsSync(ref);

function walk(root, rel, acc) {
  const d = path.join(root, rel);
  if (!fs.existsSync(d)) return acc;
  if (fs.statSync(d).isFile()) { acc.push(rel); return acc; }
  for (const e of fs.readdirSync(d)) walk(root, path.join(rel, e), acc);
  return acc;
}

test('split output is byte-identical to the Python splat reference tree', { skip: ready ? false : 'set ROMDEV_SPLAT_PROJECT/CONFIG/REF to run' }, async () => {
  const work = fs.mkdtempSync(path.join(env.ROMDEV_SPLAT_TMP || os.tmpdir(), 'romdev-splat-ref-'));
  try {
    for (const p of (env.ROMDEV_SPLAT_COPY || 'config,src,lib,include,tools/splat_ext').split(',')) {
      const from = path.join(project, p);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(work, p), { recursive: true });
    }
    const pins = detectProjectVersions(project);
    const r = await split([config], { cwd: work, splatVersion: pins.splat || '0.37.1', spimdisasmVersion: pins.spimdisasm || undefined });
    assert.equal(r.exitCode, 0, r.stderr);
    const subs = (env.ROMDEV_SPLAT_COMPARE || 'asm,bin,.splat').split(',');
    const ex = env.ROMDEV_SPLAT_EXCLUDE ? new RegExp(env.ROMDEV_SPLAT_EXCLUDE) : null;
    const list = (root) => subs.flatMap((s) => walk(root, s, [])).filter((p) => !ex || !ex.test(p)).sort();
    const want = list(ref);
    const got = list(work);
    assert.ok(want.length > 0, 'reference tree is empty');
    assert.deepEqual(got, want);
    const differing = want.filter((p) => !fs.readFileSync(path.join(ref, p)).equals(fs.readFileSync(path.join(work, p))));
    assert.deepEqual(differing, []);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
