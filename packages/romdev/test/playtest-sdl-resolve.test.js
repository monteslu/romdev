// Regression guard for the playtest "@kmamal/sdl binary never installed under
// npx" report. Covers the package-root resolution (its `exports` blocks the
// usual `require.resolve('@kmamal/sdl/package.json')`) and the error-kind
// classification that drives the accurate vs misleading error message.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { sdlPackageRoot } from "../src/playtest/playtest.js";

test("sdlPackageRoot resolves @kmamal/sdl despite its exports map", () => {
  const root = sdlPackageRoot();
  assert.ok(root, "should resolve the @kmamal/sdl package root");
  assert.ok(existsSync(path.join(root, "package.json")), "root should contain package.json");
  // The install script (what fetches the prebuilt binary) must be locatable —
  // that's what both the postinstall and the runtime self-heal invoke.
  assert.ok(existsSync(path.join(root, "scripts", "install.mjs")),
    "should locate @kmamal/sdl/scripts/install.mjs for self-heal");
});

// The error classifier in getSdl(): a module-not-found / sdl.node error is a
// "missing-binary" kind (→ "run the install script" message), NOT a display
// problem (→ desktop-session message). Mirror that predicate here so a
// refactor can't silently revert to the misleading branch.
function classifyKind(err) {
  const isModuleErr = err?.code === "ERR_MODULE_NOT_FOUND" ||
    /sdl\.node|dist[\\/]/.test(err?.message || "");
  return isModuleErr ? "missing-binary" : "sdl-error";
}

test("missing-binary errors classify away from the desktop-session message", () => {
  const e1 = new Error("Cannot find module '../../dist/sdl.node'");
  assert.equal(classifyKind(e1), "missing-binary");

  const e2 = new Error("boom");
  e2.code = "ERR_MODULE_NOT_FOUND";
  assert.equal(classifyKind(e2), "missing-binary");

  // A genuine SDL init failure (no video device) is NOT a binary problem.
  const e3 = new Error("SDL_Init failed: No available video device");
  assert.equal(classifyKind(e3), "sdl-error");
});
