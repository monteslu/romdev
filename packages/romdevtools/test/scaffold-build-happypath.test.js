// HAPPY-PATH REGRESSION: scaffold → build the project DIR. Two independent
// audits found the documented "scaffold then build({output:'project'|'run',
// path})" path failed on most platforms (GB/GBC gsinit, NES OAM/CHARS, Genesis
// sega.preprocessed.s, SNES multi-.c / SPC700 driver, Atari2600 dasm, GB
// music_demo hUGEDriver.upstream.asm, Genesis xgm2_demo .xgc incbin). The
// project-dir builder now applies a per-platform RECIPE (projectBuildRecipe +
// readProjectDir) so it matches a hand-written build. This test locks that in:
// every covered scaffold must BUILD from its dir. (Render correctness is
// separate — this is the "first build doesn't choke" guarantee that keeps weak
// agents from rage-installing their own toolchains.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";

function parse(res) { return JSON.parse(res.content.find((c) => c.type === "text").text); }

// One representative `default`-ish template per platform PLUS the specific
// templates each audit caught failing on the project-dir path.
const CASES = [
  ["gb", "default"], ["gb", "music_demo"],            // music_demo = hUGEDriver.upstream.asm skip
  ["gbc", "default"],
  ["nes", "default"], ["nes", "shmup"],               // OAM/CHARS preset
  ["genesis", "default"], ["genesis", "xgm2_demo"],   // sega.preprocessed.s skip + .xgc incbin
  ["snes", "default"], ["snes", "asm"], ["snes", "shmup"], // asar includes / multi-c / SPC700 skip
  ["sms", "default"], ["sms", "shmup"],
  ["gg", "default"],
  ["c64", "default"],
  ["lynx", "default"],
  ["atari2600", "default"], ["atari2600", "paddle"],  // dasm single-source
  ["atari7800", "default"],
  ["pce", "default"],
  ["msx", "default"],
  ["gba", "tonc_hello"], ["gba", "gba_hello"], ["gba", "maxmod_demo"], // libtonc/libgba/maxmod runtime pick
];

for (const [platform, template] of CASES) {
  test(`scaffold+build project dir: ${platform}/${template}`, { timeout: 240000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `sbhp-${platform}-`));
    const dir = path.join(root, `${platform}-${template}`);
    try {
      await createProjectImpl({ platform, name: `${platform}-${template}`, path: dir, template, overwrite: true });
      const r = parse(await buildProjectCore({ path: dir, platform }));
      assert.equal(r.ok, true,
        `${platform}/${template} project-dir build FAILED (stage=${r.stage}):\n` +
        (r.logTail || r.log || "").slice(-500));
      assert.ok(r.binaryBytes > 0, `${platform}/${template} produced no ROM bytes`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
