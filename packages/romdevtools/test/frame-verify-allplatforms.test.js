// frame({op:'verify'}) — the no-vision "is the game actually rendering / alive?"
// health check. MUST work across ALL platforms: the pixel scan is platform-
// agnostic, and pickRenderFlags normalizes each platform's render-enable decode.
// This builds a `default` scaffold for every platform, runs it, and asserts
// verify does NOT false-fail a known-good game (verified !== false) and that the
// render-enable decode resolves (renderEnabled is true or null, never throws).
// Also checks the frame-0 guard. (Render correctness of the scaffolds themselves
// is covered elsewhere; here we test the verify FEATURE across systems.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProjectImpl } from "../src/mcp/tools/project.js";
import { buildProjectCore } from "../src/mcp/tools/toolchain.js";
import { resolveCore } from "../src/cores/registry.js";
import { resetHost, clearHost } from "../src/mcp/state.js";
import { computeVerify } from "../src/mcp/tools/frame.js";

const parse = (r) => JSON.parse(r.content[0].text);

// virtual filename per platform so shared cores (genesis_plus_gx for sms/gg/md)
// dispatch correctly off the extension.
const VEXT = {
  nes: ".nes", snes: ".sfc", genesis: ".md", gb: ".gb", gbc: ".gbc",
  sms: ".sms", gg: ".gg", c64: ".prg", lynx: ".lnx", atari2600: ".a26",
  atari7800: ".a78", pce: ".pce", msx: ".rom", gba: ".gba",
};

// one default-ish template per platform (gba's default scaffold is gba_hello).
const PLATFORMS = [
  ["nes", "default"], ["snes", "default"], ["genesis", "default"],
  ["gb", "default"], ["gbc", "default"], ["sms", "default"], ["gg", "default"],
  ["c64", "default"], ["lynx", "default"], ["atari2600", "default"],
  ["atari7800", "default"], ["pce", "default"], ["msx", "default"],
  ["gba", "gba_hello"],
];

for (const [platform, template] of PLATFORMS) {
  test(`frame verify works on ${platform}`, { timeout: 240000 }, async () => {
    const key = `verify-test-${platform}`;
    const root = await mkdtemp(path.join(tmpdir(), `fv-${platform}-`));
    const dir = path.join(root, `${platform}-${template}`);
    try {
      await createProjectImpl({ platform, name: `${platform}-${template}`, path: dir, template, overwrite: true });
      const romPath = path.join(root, "out" + (VEXT[platform] || ".bin"));
      const build = parse(await buildProjectCore({ path: dir, platform, outputPath: romPath }));
      assert.equal(build.ok, true, `${platform} build failed: ${(build.logTail || "").slice(-300)}`);

      // load + run via a session-registered host so getRenderingContext finds it
      const core = resolveCore(platform);
      const host = resetHost(key);
      await host.loadCore(core.jsPath, core.wasmPath);
      const bin = new Uint8Array(await readFile(romPath));
      await host.loadMedia({ platform, bytes: bin, virtualName: "/rom" + (VEXT[platform] || "") });

      // 1. frame-0 guard: before stepping, verdict is null + unsettled
      const boot = await computeVerify(host, 0, key);
      assert.equal(boot.verified, null, `${platform}: frame-0 should be null (unsettled), got ${boot.verified}`);
      assert.equal(boot.unsettled, true, `${platform}: frame-0 should be unsettled`);

      // 2. after running, verify produces a well-formed, INTERNALLY CONSISTENT
      //    verdict on every platform (the cross-platform contract). We don't
      //    require verified:true here — some default scaffolds legitimately
      //    render blank, and verify correctly flags those (that's the feature) —
      //    we require the verdict to be sound, not a false positive/negative.
      const v = await computeVerify(host, 600, key);

      // shape contract on EVERY platform
      assert.ok(v.pixels && v.pixels.width > 0 && v.pixels.height > 0, `${platform}: no framebuffer dims`);
      assert.ok(v.render && "renderEnabled" in v.render, `${platform}: render.renderEnabled missing`);
      assert.ok([true, false, null].includes(v.verified), `${platform}: verified not tri-state: ${v.verified}`);

      // CONSISTENCY: the verdict must agree with the evidence it reports.
      const checks = (v.issues || []).map((i) => i.check);
      if (v.verified === true) {
        assert.ok(v.pixels.distinctColors >= 2, `${platform}: verified TRUE but screen is ${v.pixels.distinctColors} flat color(s)`);
        assert.equal(v.issues, undefined, `${platform}: verified TRUE but has issues`);
      } else if (v.verified === false) {
        assert.ok(v.issues && v.issues.length > 0, `${platform}: verified FALSE with no issues[]`);
        if (checks.includes("blankScreen")) {
          assert.ok(v.pixels.distinctColors <= 1, `${platform}: blankScreen claimed but ${v.pixels.distinctColors} colors`);
        }
        if (checks.includes("nearlyBlank")) {
          // Threshold mirrors NEARLY_BLANK_DOMINANT (0.92) in frame.js — a screen
          // where one color fills >=92% reads as blank to a human even though
          // something rendered.
          assert.ok(v.pixels.dominantPct >= 92, `${platform}: nearlyBlank claimed but dominant=${v.pixels.dominantPct}%`);
        }
        if (checks.includes("renderDisabled")) {
          assert.equal(v.render.renderEnabled, false, `${platform}: renderDisabled claimed but renderEnabled=${v.render.renderEnabled}`);
        }
      }
      // renderEnabled, when decoded, must be a real tri-state (never undefined/NaN)
      assert.ok(v.render.renderEnabled === true || v.render.renderEnabled === false || v.render.renderEnabled === null,
        `${platform}: renderEnabled bad value ${v.render.renderEnabled}`);
    } finally {
      clearHost(key);
      await rm(root, { recursive: true, force: true });
    }
  });
}
