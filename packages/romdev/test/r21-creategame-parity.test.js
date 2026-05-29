// R21 createGame parity test. Confirms createGame now scaffolds shmup
// + platformer + puzzle projects for NES, GB, GBC, SNES, and Genesis
// (NES already worked from R14; the other four are R21 additions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";

const PLATFORMS = ["nes", "gb", "gbc", "snes", "genesis"];
const GENRES = ["shmup", "platformer", "puzzle"];

test("R21 createGame parity: every (platform, genre) pair scaffolds correctly", { timeout: 30000 }, async () => {
  for (const platform of PLATFORMS) {
    for (const genre of GENRES) {
      const projPath = await mkdtemp(join(tmpdir(), `romdev-r21-${platform}-${genre}-`));
      // createGame is a thin wrapper over createProjectImpl with template=genre,
      // so we use createProjectImpl directly here.
      const r = await createProjectImpl({
        platform,
        name: `${platform}-${genre}-test`,
        path: projPath,
        template: genre,
        overwrite: true,
      });
      assert.equal(r.platform, platform);
      assert.equal(r.template, genre);
      assert.ok(Array.isArray(r.files), `${platform}/${genre}: files array missing`);
      // Main file must exist (named main.<ext>)
      const expectedMain = r.files.find((f) =>
        /^main\.(c|asm|s)$/.test(f),
      );
      assert.ok(expectedMain, `${platform}/${genre}: no main.{c,asm,s} in files manifest`);
      const mainStat = await stat(join(projPath, expectedMain));
      assert.ok(mainStat.isFile(), `${platform}/${genre}: main file not regular`);
      // Sanity: main.c should contain a recognisable entry point.
      const mainSrc = await readFile(join(projPath, expectedMain), "utf-8");
      assert.match(mainSrc, /main\s*\(/, `${platform}/${genre}: main file has no main(`);
    }
  }
});
