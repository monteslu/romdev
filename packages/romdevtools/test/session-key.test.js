// Session identity is resolved from a handle FIRST, the transport second.
//
// Why this matters: MCP 2026-07-28 deletes protocol sessions, so the
// transport-provided id (`Mcp-Session-Id`) stops existing. Every handler
// scopes its host/state by `sessionKey`, so identity has to survive that.
// These tests pin the precedence so the stateless migration changes which
// BRANCH fires, not the identity model.
//
// See internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md (workstream B).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveSessionKey,
  mintSessionHandle,
  SESSION_HEADER,
  SESSION_META_KEY,
} from "../src/mcp/session-key.js";

test("an explicit _meta handle wins over the transport id", () => {
  const r = resolveSessionKey({
    meta: { [SESSION_META_KEY]: "handle-abc" },
    transportSessionId: "transport-xyz",
  });
  assert.equal(r.sessionKey, "handle-abc");
  assert.equal(r.source, "handle");
  assert.equal(r.minted, false);
});

test("the x-romdev-session header is a handle too (the HTTP route always worked this way)", () => {
  const r = resolveSessionKey({
    headers: { [SESSION_HEADER]: "http-session-1" },
    transportSessionId: "transport-xyz",
  });
  assert.equal(r.sessionKey, "http-session-1");
  assert.equal(r.source, "handle");
});

test("with no handle, the transport id is used -- legacy clients keep working", () => {
  const r = resolveSessionKey({ transportSessionId: "transport-xyz" });
  assert.equal(r.sessionKey, "transport-xyz");
  assert.equal(r.source, "transport");
  assert.equal(r.minted, false);
});

test("with neither, a handle is minted AND flagged so it can be advertised back", () => {
  const r = resolveSessionKey({});
  assert.equal(r.source, "minted");
  assert.equal(r.minted, true, "a caller that never learns its key gets a new empty session per call");
  assert.ok(r.sessionKey.length > 0);
});

test("a stateless request with only a handle resolves without any transport at all", () => {
  // This is the 2026-07-28 shape: no Mcp-Session-Id in existence.
  const r = resolveSessionKey({ meta: { [SESSION_META_KEY]: "stateless-1" } });
  assert.equal(r.sessionKey, "stateless-1");
  assert.equal(r.source, "handle");
});

test("empty strings are not identities -- they fall through rather than aliasing", () => {
  // An empty header is the classic way every caller silently shares ONE
  // session (and one emulator). It must not resolve.
  const r = resolveSessionKey({
    meta: { [SESSION_META_KEY]: "" },
    headers: { [SESSION_HEADER]: "" },
    transportSessionId: "",
  });
  assert.equal(r.source, "minted");
  assert.notEqual(r.sessionKey, "");
});

test("minted handles are unique", () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(mintSessionHandle());
  assert.equal(seen.size, 50);
});
