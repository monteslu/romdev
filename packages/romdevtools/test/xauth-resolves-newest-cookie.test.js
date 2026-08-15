// A compositor restart regenerates the Xwayland cookie, but a long-lived login
// session keeps exporting the path it got at login. The stale file still exists
// and is still readable, so nothing LOOKS wrong -- EGL just starts failing with
// "Invalid MIT-MAGIC-COOKIE-1 key" / "eglInitialize failed", which reads like a
// GPU fault and silently costs every GL cart its GPU.
//
// resolveXauthority() must repair that, and -- more important -- must NEVER
// touch a working system. These tests pin both directions. They do not need a
// display: candidate selection is driven through a stubbed connect oracle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveXauthority } from "../src/host/xauth.js";

// The resolver is a Linux/X11 concern and returns {reason:'not-linux'} early
// everywhere else. The harness below is POSIX-only too (it fakes `xdpyinfo`
// with a shebang script + exec bit, neither of which Windows honours), so skip
// the whole file off-Linux rather than assert Linux behaviour on a platform
// that never runs the code path.
const skip = process.platform !== "linux" ? "linux/X11-only behaviour" : false;

/** Build a dir of cookie files with controlled mtimes. `files`: [name, ageSec]. */
function cookieDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "romdev-xauth-"));
  const now = Date.now() / 1000;
  for (const [name, ageSec] of files) {
    const full = path.join(dir, name);
    writeFileSync(full, "cookie");
    utimesSync(full, now - ageSec, now - ageSec);
  }
  return dir;
}

/**
 * Run resolveXauthority with a controlled environment. `works` is the set of
 * paths the fake X server accepts; xdpyinfo is shimmed via PATH so no real
 * display is needed.
 */
// NOTE: `display` uses an explicit sentinel, NOT a `= ":0"` default parameter.
// Passing `display: undefined` to test the headless path would TRIGGER the
// default and set DISPLAY=:0 — the test would then exercise the opposite of
// what it claims. Omit the key for :0; pass `display: null` for headless.
function withEnv({ display, xauthority, dir, works = [] }, fn) {
  const wantDisplay = display === undefined ? ":0" : display;
  const saved = { ...process.env };
  const shimDir = mkdtempSync(path.join(tmpdir(), "romdev-shim-"));
  // A fake xdpyinfo that exits 0 only for the accepted cookies.
  const shim = path.join(shimDir, "xdpyinfo");
  const ok = JSON.stringify(works);
  writeFileSync(
    shim,
    `#!/usr/bin/env node\nconst ok=${ok};process.exit(ok.includes(process.env.XAUTHORITY)?0:1);\n`,
    { mode: 0o755 },
  );
  try {
    if (wantDisplay === null) delete process.env.DISPLAY;
    else process.env.DISPLAY = wantDisplay;
    if (xauthority === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = xauthority;
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.PATH = `${shimDir}:${process.env.PATH}`;
    // Hand the callback the value resolveXauthority left behind. Assertions
    // about env MUST read this, not process.env — the finally block below
    // restores the ambient session values (this box really does export
    // DISPLAY=:0), which would mask what the resolver actually did.
    const result = fn();
    return { result, xauthorityAfter: process.env.XAUTHORITY };
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(shimDir, { recursive: true, force: true });
  }
}

test("a stale cookie is replaced by the newest one that actually connects", { skip }, () => {
  // Exactly the Aug 5 / Aug 13 shape seen in the wild.
  const dir = cookieDir([
    [".mutter-Xwaylandauth.OLD", 10 * 86400],
    [".mutter-Xwaylandauth.NEW", 1 * 86400],
  ]);
  const stale = path.join(dir, ".mutter-Xwaylandauth.OLD");
  const fresh = path.join(dir, ".mutter-Xwaylandauth.NEW");

  const { result: r, xauthorityAfter } = withEnv({ xauthority: stale, dir, works: [fresh] }, () =>
    resolveXauthority(),
  );

  assert.equal(r.changed, true);
  assert.equal(xauthorityAfter, fresh, "the working cookie is actually exported");
  assert.equal(r.to, fresh);
  assert.equal(r.from, stale);
});

test("a WORKING cookie is left alone even when a newer file exists", { skip }, () => {
  // The critical non-regression: newest-wins must never override still-valid
  // credentials. mtime is a tiebreak, not the oracle.
  const dir = cookieDir([
    [".mutter-Xwaylandauth.CURRENT", 10 * 86400],
    [".mutter-Xwaylandauth.NEWER", 1 * 86400],
  ]);
  const current = path.join(dir, ".mutter-Xwaylandauth.CURRENT");
  const newer = path.join(dir, ".mutter-Xwaylandauth.NEWER");

  const { result: r, xauthorityAfter } = withEnv(
    { xauthority: current, dir, works: [current, newer] },
    () => resolveXauthority(),
  );

  assert.equal(r.changed, false);
  assert.equal(r.reason, "current-works");
  assert.equal(xauthorityAfter, current, "the still-valid cookie is left exactly as it was");
});

test("newest-first: with several working candidates the freshest wins", { skip }, () => {
  const dir = cookieDir([
    [".mutter-Xwaylandauth.A", 30 * 86400],
    [".mutter-Xwaylandauth.B", 2 * 86400],
    [".mutter-Xwaylandauth.C", 9 * 86400],
  ]);
  const b = path.join(dir, ".mutter-Xwaylandauth.B");
  const { result: r } = withEnv(
    { xauthority: path.join(dir, "gone"), dir, works: [b, path.join(dir, ".mutter-Xwaylandauth.C")] },
    () => resolveXauthority(),
  );
  assert.equal(r.changed, true);
  assert.equal(r.to, b, "newest working candidate, not merely the first that works");
});

test("no working candidate: reports it and does NOT invent a cookie", { skip }, () => {
  const dir = cookieDir([[".mutter-Xwaylandauth.DEAD", 5 * 86400]]);
  const stale = path.join(dir, ".mutter-Xwaylandauth.DEAD");
  const { result: r } = withEnv({ xauthority: stale, dir, works: [] }, () => resolveXauthority());

  assert.equal(r.changed, false);
  assert.equal(r.reason, "no-working-candidate");
});

test("headless (no DISPLAY) is a clean no-op", { skip }, () => {
  const dir = cookieDir([[".mutter-Xwaylandauth.X", 1 * 86400]]);
  const { result: r } = withEnv({ display: null, xauthority: undefined, dir, works: [] }, () =>
    resolveXauthority(),
  );
  assert.equal(r.changed, false);
  assert.equal(r.reason, "no-display");
});

test("without xdpyinfo we have no oracle, so we change nothing", { skip }, () => {
  // Better to leave a possibly-stale cookie than to swap blind: a wrong swap
  // breaks a machine that was working.
  const dir = cookieDir([[".mutter-Xwaylandauth.N", 1 * 86400]]);
  const saved = { ...process.env };
  try {
    process.env.DISPLAY = ":0";
    process.env.XAUTHORITY = path.join(dir, ".mutter-Xwaylandauth.N");
    process.env.XDG_RUNTIME_DIR = dir;
    process.env.PATH = "/nonexistent-dir-with-no-xdpyinfo";
    const r = resolveXauthority();
    assert.equal(r.changed, false);
    assert.equal(r.reason, "cannot-verify");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("lock siblings and non-cookie files are never selected", { skip }, () => {
  const dir = cookieDir([
    [".Xauthority-c", 1 * 86400],
    [".Xauthority-l", 1 * 86400],
    ["notes.txt", 1 * 86400],
    [".Xauthority", 5 * 86400],
  ]);
  const real = path.join(dir, ".Xauthority");
  const { result: r } = withEnv(
    { xauthority: path.join(dir, "gone"), dir, works: [real, path.join(dir, ".Xauthority-c")] },
    () => resolveXauthority(),
  );
  assert.equal(r.to, real, "the -c lock file is newer but must not be a candidate");
});

// This one runs on EVERY platform — it is the guard that keeps a Linux-only
// concern from touching Windows/macOS. Without it the non-linux early return
// is the least-tested line in the file, on the platforms that depend on it
// most. process.platform is redefined rather than stubbed at import time so a
// single loaded module can be exercised as all three.
test("non-linux platforms are an untouched no-op (Windows/macOS safety)", () => {
  const realPlatform = process.platform;
  const savedXauth = process.env.XAUTHORITY;
  const savedDisplay = process.env.DISPLAY;
  try {
    for (const plat of ["win32", "darwin", "aix", "sunos"]) {
      Object.defineProperty(process, "platform", { value: plat, configurable: true });
      // Deliberately hostile env: a DISPLAY set and a broken XAUTHORITY. On
      // Linux this is exactly the shape that triggers a replacement.
      process.env.DISPLAY = ":0";
      process.env.XAUTHORITY = "/nonexistent/definitely-broken-cookie";

      const r = resolveXauthority();

      assert.equal(r.changed, false, `${plat}: must not change anything`);
      assert.equal(r.reason, "not-linux", `${plat}: must short-circuit before any fs/exec work`);
      assert.equal(
        process.env.XAUTHORITY,
        "/nonexistent/definitely-broken-cookie",
        `${plat}: XAUTHORITY must be left exactly as the user set it`,
      );
    }
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    if (savedXauth === undefined) delete process.env.XAUTHORITY;
    else process.env.XAUTHORITY = savedXauth;
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  }
});
