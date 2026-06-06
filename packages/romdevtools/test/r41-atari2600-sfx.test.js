// R41 — Atari 2600 TIA sfx in asm scaffolds.
//
// The 2600 has no C compiler — sfx is inline 6507 asm writing to
// AUDC0/AUDF0/AUDV0 ($15/$17/$19). Each scaffold sets up a boot
// chime + per-event sfx + a per-frame countdown that silences on
// zero.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

async function readSrc(rel) {
  return readFile(join(REPO_ROOT, rel), "utf-8");
}

const TEMPLATES = ["default", "paddle", "single_screen"];

test("R41 Atari 2600 sfx-wired scaffolds: every template compiles + writes AUDV0", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  for (const t of TEMPLATES) {
    const src = await readSrc(`examples/atari2600/templates/${t}.asm`);
    // Sanity check the source actually wires sfx — every scaffold must
    // mention AUDV0 (volume reg) so we know it's writing audio.
    assert.match(src, /AUDV0/, `2600/${t}: scaffold doesn't reference AUDV0 — TIA sfx not wired`);
    const r = await buildForPlatform({ platform: "atari2600", source: src });
    assert.equal(r.ok, true, `2600/${t} build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
    assert.equal(r.binary.length, 4096, `2600/${t}: should be 4 KB`);
  }
});
