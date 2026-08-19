// Host lifetime: the server bounds its own emulator memory.
//
// WHY THIS EXISTS. On 2026-08-19 the server was OOM-killed twice in 28
// minutes (~5.4 GB RSS, 300-500 GB mapped) by a SINGLE agent running a
// 21-gate cart suite. Two mechanisms, both "absent policy" rather than wrong
// code:
//
//   1. unloadMedia() freed the ROM but never dropped the Emscripten module,
//      so a discarded host kept its entire WASM linear memory forever.
//   2. Every gate script is its own MCP session, and the only eviction was a
//      30-minute TRANSPORT-idle reaper — which never fires during a 12-minute
//      suite, and never fires at all for a script that exits without closing.
//
// These tests pin the fix: dispose() actually releases, and hosts are evicted
// on their OWN activity and count, independent of any transport. The second
// half is also a hard prerequisite for MCP 2026-07-28, which removes protocol
// sessions and with them any connection-close signal to hang eviction on.
// See internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md.

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { LibretroHost } from "romdev-core-host/index.js";
import { resolveCore } from "../src/cores/registry.js";
import {
  getHost,
  getHostOrNull,
  resetHost,
  clearHost,
  installHost,
  reapIdleHosts,
  setHostProtectedPredicate,
  hostLifetimeStats,
  rememberLastMedia,
  _liveHostCount,
} from "../src/mcp/state.js";
import { buildExampleRom } from "./build-fixture-rom.js";

let ROM_PATH;
before(async () => { ROM_PATH = await buildExampleRom("nes"); });

/** A host that records whether it was torn down, and how. */
function fakeHost() {
  const calls = [];
  return {
    calls,
    status: { loaded: true },
    dispose() { calls.push("dispose"); this.status.loaded = false; },
  };
}

test("dispose() drops the core module, not just the ROM", async () => {
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", path: ROM_PATH });
  host.stepFrames(2);

  assert.ok(host.mod, "core module is resident while loaded");
  assert.equal(host.status.loaded, true);

  host.dispose();

  // The whole point: the module reference is gone, so the WASM memory can
  // actually be collected. unloadMedia() alone leaves `mod` in place — that
  // is precisely the leak this test guards.
  assert.equal(host.mod, null, "dispose() must drop the Emscripten module");
  assert.equal(host.status.loaded, false);
  assert.equal(host.state.lastFrame, null, "a retained frame view pins the heap");
  assert.equal(host.state.audioRing.length, 0, "retained audio views pin the heap");
});

test("dispose() is safe twice and on a host that never loaded", () => {
  const fresh = new LibretroHost();
  fresh.dispose();          // never loaded a core
  fresh.dispose();          // and again
  assert.equal(fresh.mod, null);
});

test("unloadMedia() alone does NOT release the core (documents the old behaviour)", async () => {
  const host = new LibretroHost();
  const core = resolveCore("nes");
  await host.loadCore(core.jsPath, core.wasmPath);
  await host.loadMedia({ platform: "nes", path: ROM_PATH });

  host.unloadMedia();
  // This is not a bug in unloadMedia — a host is normally REUSED for the next
  // load, so keeping the core is correct there. It is only a leak when the
  // host is being thrown away, which is why teardown calls dispose().
  assert.ok(host.mod, "unloadMedia keeps the core for reuse; dispose is what frees it");
  host.dispose();
  assert.equal(host.mod, null);
});

test("clearHost tears the host down instead of only unloading media", () => {
  const key = "lifetime-clear";
  const host = fakeHost();
  installHost(key, host);
  assert.equal(getHostOrNull(key), host);

  clearHost(key);

  assert.deepEqual(host.calls, ["dispose"], "session end must fully tear down");
  assert.equal(getHostOrNull(key), null);
});

test("idle hosts are evicted on their own activity, with no transport involved", () => {
  setHostProtectedPredicate(() => false);
  const key = "lifetime-idle";
  installHost(key, fakeHost());
  assert.ok(getHostOrNull(key), "host is live");

  // First sweep gives an unstamped host one window rather than evicting it
  // immediately; installHost stamps, so this one is simply not idle yet.
  reapIdleHosts();
  assert.ok(getHostOrNull(key), "a freshly used host is not idle");

  // Sweep from far enough in the future that it is past HOST_IDLE_MS.
  const evicted = reapIdleHosts(Date.now() + 60 * 60 * 1000);

  assert.ok(evicted.includes(key), "an unused host must be evicted by age");
  assert.equal(getHostOrNull(key), null);
});

test("an evicted session self-heals: the recovery hint names the exact loadMedia", () => {
  setHostProtectedPredicate(() => false);
  const key = "lifetime-recover";
  installHost(key, fakeHost());
  rememberLastMedia(key, { platform: "nes", path: "/tmp/whatever.nes" });

  reapIdleHosts(Date.now() + 60 * 60 * 1000);

  // Eviction must never be a dead end. lastMedia deliberately OUTLIVES the
  // host so the error can tell the agent what to re-run.
  assert.throws(() => getHost(key), (err) => {
    assert.match(err.message, /loadMedia/);
    assert.match(err.message, /whatever\.nes/, "names the ROM it should reload");
    return true;
  });
});

test("a playtest session is never evicted by age -- a human may be mid-game", () => {
  const key = "lifetime-playtest";
  const host = fakeHost();
  installHost(key, host);
  setHostProtectedPredicate((k) => k === key);

  const evicted = reapIdleHosts(Date.now() + 60 * 60 * 1000);

  assert.ok(!evicted.includes(key), "protected sessions survive the reaper");
  assert.ok(getHostOrNull(key), "the window's host is still live");
  assert.deepEqual(host.calls, [], "and it was not torn down");
  setHostProtectedPredicate(() => false);
  clearHost(key);
});

test("the host cap evicts the oldest-idle session rather than refusing to load", () => {
  setHostProtectedPredicate(() => false);
  const { maxHosts } = hostLifetimeStats();
  const before = _liveHostCount();
  const keys = [];

  // Fill well past the cap, stamping each one later than the last so
  // "oldest-idle" is unambiguous.
  for (let i = 0; i < maxHosts + 5; i++) {
    const key = `lifetime-cap-${i}`;
    keys.push(key);
    installHost(key, fakeHost());
  }

  // Never refuse: a refusal surfaces as a mysterious tool failure, while an
  // eviction self-heals through the loadMedia breadcrumb.
  assert.ok(_liveHostCount() <= maxHosts,
    `live hosts (${_liveHostCount()}) must stay within the cap (${maxHosts})`);
  assert.ok(getHostOrNull(keys[keys.length - 1]), "the newest session kept its host");
  assert.equal(getHostOrNull(keys[0]), null, "the oldest-idle session was evicted first");

  for (const k of keys) clearHost(k);
  assert.equal(_liveHostCount(), before, "test left no hosts behind");
});

test("resetHost replaces a host without leaking the old one", () => {
  setHostProtectedPredicate(() => false);
  const key = "lifetime-reset";
  const first = fakeHost();
  installHost(key, first);

  const fresh = resetHost(key);

  assert.deepEqual(first.calls, ["dispose"], "the replaced host is torn down");
  assert.ok(fresh instanceof LibretroHost);
  clearHost(key);
});

test("hostLifetimeStats reports what catalog({op:'status'}) surfaces", () => {
  const stats = hostLifetimeStats();
  assert.equal(typeof stats.liveHosts, "number");
  assert.equal(typeof stats.maxHosts, "number");
  assert.equal(typeof stats.hostIdleMs, "number");
  assert.ok(stats.maxHosts > 0);
  assert.ok(stats.hostIdleMs > 0);
});

test("slot B activity keeps the session alive -- a side-by-side comparison is not idle", async () => {
  // Slot B is a SECOND live core (the ROM-vs-port comparison workflow), and
  // eviction clears both slots together. So a session whose every recent call
  // touched only slot B must still count as active, or the reaper would tear
  // down a comparison mid-flight -- including the primary ROM the agent was
  // comparing against.
  const { installHost, getHostBOrNull, reapIdleHosts, setHostProtectedPredicate, resetHostB, clearHost } =
    await import("../src/mcp/state.js");

  setHostProtectedPredicate(() => false);
  const key = "lifetime-slotb";
  installHost(key, fakeHost());
  resetHostB(key);
  assert.ok(getHostBOrNull(key), "slot B is live");

  // Touch ONLY slot B, then sweep from a moment that is past the idle window
  // relative to install but not relative to this access.
  const now = Date.now();
  getHostBOrNull(key);
  const evicted = reapIdleHosts(now + 1000);

  assert.ok(!evicted.includes(key), "a session working in slot B is not idle");
  assert.ok(getHostBOrNull(key), "and its comparison core survives");
  clearHost(key);
  assert.equal(getHostBOrNull(key), null, "clearHost tears down BOTH slots");
});

test("resetHostB fully tears the old comparison core down", async () => {
  const { resetHostB, clearHost, _setHostBForTest } = await import("../src/mcp/state.js");
  const key = "lifetime-slotb-reset";
  const old = fakeHost();
  _setHostBForTest(key, old);

  resetHostB(key);

  // unloadMedia() alone would keep the Emscripten module alive -- the same
  // leak slot A had. Slot B must dispose too.
  assert.deepEqual(old.calls, ["dispose"], "the replaced slot-B core is disposed");
  clearHost(key);
});
