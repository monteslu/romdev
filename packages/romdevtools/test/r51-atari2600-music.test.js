// R51 — Atari 2600 two-voice music scaffold.
//
// The 2600 has no C compiler, so the music engine is hand-rolled 6507
// asm: two voices (AUDC0/AUDC1 + AUDF0/AUDF1 + AUDV0/AUDV1) stepping
// through (AUDF, length_frames) tables in ROM. This test confirms the
// scaffold compiles to a clean 4 KB cart AND that both voices are
// actually wired (both AUDF regs + both AUDV regs referenced; both
// note tables present in source).

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

test("R51 Atari 2600 music_demo: 2-voice TIA chiptune compiles to 4 KB", { timeout: 120000 }, async () => {
  const { buildForPlatform } = await import("../src/toolchains/index.js");
  const src = await readSrc("examples/atari2600/templates/music_demo.asm");

  // Both voices must be referenced — otherwise it's not 2-voice music.
  assert.match(src, /AUDF0/, "music_demo: AUDF0 (voice 0 freq) not referenced");
  assert.match(src, /AUDF1/, "music_demo: AUDF1 (voice 1 freq) not referenced");
  assert.match(src, /AUDV0/, "music_demo: AUDV0 (voice 0 volume) not referenced");
  assert.match(src, /AUDV1/, "music_demo: AUDV1 (voice 1 volume) not referenced");

  // The note tables ARE the song — both must be present in source.
  assert.match(src, /melody_notes:/, "music_demo: melody_notes label missing");
  assert.match(src, /bass_notes:/,   "music_demo: bass_notes label missing");

  const r = await buildForPlatform({ platform: "atari2600", source: src });
  assert.equal(r.ok, true, `music_demo build failed at ${r.stage}: ${(r.log || "").slice(-300)}`);
  assert.equal(r.binary.length, 4096, "music_demo should be 4 KB");
});

test("R51 Atari 2600 music_demo: registered in TEMPLATES.atari2600", { timeout: 30000 }, async () => {
  // Sanity check — the manifest entry must exist so createProject can
  // actually scaffold the template.
  const project = await readFile(
    join(REPO_ROOT, "src/mcp/tools/project.js"),
    "utf-8",
  );
  // Look for the music_demo block under atari2600 (not lynx — lynx has
  // its own music_demo). The atari2600 block sits between
  // `TEMPLATES.atari2600 = {` and the next `TEMPLATES.` line.
  const start = project.indexOf("TEMPLATES.atari2600 = {");
  assert.ok(start >= 0, "TEMPLATES.atari2600 block not found");
  const end = project.indexOf("TEMPLATES.", start + 1);
  const block = project.slice(start, end >= 0 ? end : undefined);
  assert.match(block, /music_demo:/, "TEMPLATES.atari2600.music_demo not wired");
  assert.match(block, /templates\/music_demo\.asm/, "music_demo.asm not referenced");
});
