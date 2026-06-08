// v0.16.0-feedback (more) #2: when a session's host is evicted (server restart /
// reconnect / unload), the "No ROM loaded" error should lead with the EXACT
// loadMedia call to recover with — not just the generic wrong-session guidance.
// rememberLastMedia is the breadcrumb (kept outside the host map so it survives
// the eviction). These are pure unit tests on state.js — no core/host needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { getHost, rememberLastMedia, clearHost } from "../src/mcp/state.js";

test("No-host error WITHOUT prior media: generic session guidance", () => {
  const key = "evict-test-fresh";
  clearHost(key);
  assert.throws(() => getHost(key), (e) => {
    assert.match(e.message, /No ROM loaded in this session/);
    assert.match(e.message, /x-romdev-session/);   // the generic path
    return true;
  });
});

test("No-host error AFTER a path load: echoes the exact recovery loadMedia call", () => {
  const key = "evict-test-path";
  clearHost(key);
  rememberLastMedia(key, { platform: "nes", path: "/roms/smb.nes" });
  // host was evicted (we never set one) — getHost must throw the recovery hint.
  assert.throws(() => getHost(key), (e) => {
    assert.match(e.message, /host was evicted/);
    assert.match(e.message, /loadMedia\(\{ platform: "nes", path: "\/roms\/smb\.nes" \}\)/);
    return true;
  });
});

test("No-host error AFTER a base64 load: tells the agent to re-supply the bytes", () => {
  const key = "evict-test-b64";
  clearHost(key);
  rememberLastMedia(key, { platform: "gb", fromBase64: true });
  assert.throws(() => getHost(key), (e) => {
    assert.match(e.message, /host was evicted/);
    assert.match(e.message, /base64/);
    assert.match(e.message, /platform: "gb"/);
    return true;
  });
});
