// P4 — build-boilerplate defaults for scaffolded projects. The feedback: every
// gbc C build needed crt0Path:'gb_crt0.s' AND codeLoc:0x150 re-passed by hand
// (0x150 is a magic number; forgetting it is a silent footgun). Those should be
// DEFAULTS when building a scaffolded project dir.
//
// This proves build({output:'project', path}) already supplies the crt0 +
// codeLoc (and the SMS/GG/MSX equivalents) via the per-platform project recipe —
// so scaffold({op:'project'}) → build({output:'project', path}) builds with NO
// crt0/codeLoc args. (projectBuildRecipe is the single source of truth.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore, projectBuildRecipe, readProjectDir } from "../src/mcp/tools/toolchain.js";

const toJSON = (res) => {
  assert.equal(res.isError, undefined, "isError: " + JSON.stringify(res));
  return JSON.parse(res.content[0].text);
};
const tmpDir = async () => mkdtemp(path.join(tmpdir(), "romdev-p4-"));

// ── Unit: the recipe defaults crt0/codeLoc directly (cheap, no toolchain). ──
test("projectBuildRecipe defaults gb_crt0.s + codeLoc 0x150 for gb/gbc", () => {
  for (const platform of ["gb", "gbc"]) {
    const r = projectBuildRecipe(platform, ["main.c", "gb_crt0.s", "gb_runtime.c"]);
    assert.equal(r.crt0File, "gb_crt0.s", `${platform}: crt0File should default to gb_crt0.s`);
    assert.equal(r.codeLoc, 0x150, `${platform}: codeLoc should default to 0x150`);
  }
});

test("projectBuildRecipe routes msx_crt0.s + codeLoc 0x4010; skips sms/gg duplicate crt0", () => {
  const msx = projectBuildRecipe("msx", ["main.c", "msx_crt0.s", "msx_vdp.c"]);
  assert.equal(msx.crt0File, "msx_crt0.s");
  assert.equal(msx.codeLoc, 0x4010);
  // SMS/GG: the dir's *_crt0.s must be ROUTED through the crt0 channel.
  // (The old recipe SKIPPED it believing buildForPlatform auto-injects a
  // bundled crt0 — it doesn't; only the rom/run MCP handlers do. Skipping
  // linked SDCC's stock z80 crt0, which never calls main(): every
  // project-built SMS/GG ROM black-screened. readProjectDir falls back to
  // the bundled crt0 when the dir has none.)
  const sms = projectBuildRecipe("sms", ["main.c", "sms_crt0.s", "vdp_init.c"]);
  assert.equal(sms.crt0File, "sms_crt0.s", "sms scaffold crt0 must be routed as crt0");
  assert.ok(!sms.skip.has("sms_crt0.s"), "sms crt0 must NOT be skipped");
  const gg = projectBuildRecipe("gg", ["main.c", "gg_crt0.s", "vdp_init.c"]);
  assert.equal(gg.crt0File, "gg_crt0.s", "gg scaffold crt0 must be routed as crt0");
  assert.ok(!gg.skip.has("gg_crt0.s"), "gg crt0 must NOT be skipped");
});

// ── readProjectDir surfaces those defaults from a REAL scaffolded gbc dir. ──
test("readProjectDir on a scaffolded gbc dir returns crt0 + codeLoc 0x150 (no hand args)", async () => {
  const dir = await tmpDir();
  await createProjectImpl({ platform: "gbc", name: "p4gbc", path: dir, template: "puzzle" });
  const r = await readProjectDir(dir, "gbc");
  assert.ok(r.crt0 != null, "scaffolded gbc dir should yield a crt0 source");
  assert.equal(r.codeLoc, 0x150, "codeLoc should default to 0x150");
  assert.ok(!Object.keys(r.sources).includes("gb_crt0.s"), "gb_crt0.s must be routed as crt0, NOT a plain source TU");
});

// ── End-to-end: scaffold → build({output:'project'}) with NO crt0/codeLoc. ──
// These actually run SDCC, so give them room. Each asserts ok:true with zero
// boilerplate args — the whole point of P4.
for (const platform of ["gbc", "gb", "sms", "gg"]) {
  test(`scaffold(${platform}, puzzle) → build({output:'project'}) with NO crt0/codeLoc → ok`, async () => {
    const dir = await tmpDir();
    await createProjectImpl({ platform, name: `p4-${platform}`, path: dir, template: "puzzle" });
    // The crux: NO crt0Path, NO codeLoc. The project recipe must supply them.
    const built = toJSON(await buildProjectCore({ path: dir, platform }));
    assert.equal(built.ok, true,
      `${platform} project build should succeed with no crt0/codeLoc args; stage=${built.stage} log:\n` +
      (built.log || built.logTail || "").slice(-600));
    assert.ok(built.binaryBytes > 0, `${platform} should produce a non-empty ROM`);
  });
}
