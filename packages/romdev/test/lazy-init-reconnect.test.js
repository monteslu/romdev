// Guards the lazy-init reconnect feature in src/mcp/server.js.
//
// After a server restart, a client shows up with a session id we never issued
// (because WE restarted). Instead of 404-ing it, the server adopts that id —
// it constructs a StreamableHTTPServerTransport and marks it initialized by
// setting two fields on the SDK's inner _webStandardTransport: `sessionId`
// and `_initialized`. That's a deliberate reach into SDK internals (the
// transport otherwise only binds its id by running a real HTTP `initialize`
// through Hono, which needs genuine Node req/res streams we can't fabricate).
//
// This test asserts those internals still exist + behave, so an SDK upgrade
// that renames/removes them fails LOUDLY here instead of silently breaking
// reconnect. If this test breaks after an SDK bump, update lazyInitTransport()
// in server.js to match the new shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

test("SDK transport exposes settable _webStandardTransport.sessionId + _initialized (lazy-init coupling)", () => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "fixed-id",
  });

  const inner = transport._webStandardTransport;
  assert.ok(inner && typeof inner === "object",
    "transport._webStandardTransport must exist — lazyInitTransport reaches into it");

  // Fresh transport: not yet initialized, no session id.
  assert.equal(inner._initialized, false, "_initialized should start false");
  assert.equal(transport.sessionId, undefined, "sessionId should start undefined");

  // The lazy-init move: adopt the client's id by setting these two fields.
  inner.sessionId = "client-session-abc";
  inner._initialized = true;

  // The OUTER getter must reflect the inner field (server.js + the per-request
  // validateSession path both read transport.sessionId / inner.sessionId).
  assert.equal(transport.sessionId, "client-session-abc",
    "outer sessionId getter must reflect inner.sessionId");
  assert.equal(inner._initialized, true, "_initialized must be settable to true");
});
