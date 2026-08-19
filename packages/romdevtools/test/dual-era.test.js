// Both protocol eras, one server, one tool definition.
//
// MCP 2026-07-28 removed the initialize handshake, the Mcp-Session-Id header
// and protocol sessions entirely. romdev has to keep serving legacy clients
// (which is every client shipping today) while serving modern ones, and the
// SDK's own guidance is that ONE factory must back both so the two eras
// cannot drift apart.
//
// The interesting property is not "modern requests get answers" -- it is that
// a modern session KEEPS ITS EMULATOR across requests with no session to hang
// it on. That works only because identity comes from a client handle
// (session-key.js) and host lifetime is owned by the server (state.js), which
// is why those two landed before this one.
//
// See internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md (workstream C).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMcpHandler, isLegacyRequest, McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { z } from "zod";

import { withV1ToolApi } from "../src/mcp/v2-adapter.js";
import { resolveSessionKey, SESSION_META_KEY } from "../src/mcp/session-key.js";

const PROTOCOL = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";

/** A modern request envelope: the spec requires version + capabilities on every one. */
function modernBody(id, method, params = {}, handle) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        [META_VERSION]: PROTOCOL,
        [META_CAPS]: {},
        ...(handle ? { [SESSION_META_KEY]: handle } : {}),
      },
    },
  };
}

function modernRequest(body, mcpName) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": body.method,
      "mcp-name": mcpName ?? body.method,
    },
    body: JSON.stringify(body),
  });
}

/**
 * A handler shaped exactly like the server's: one factory, a per-request
 * server, identity resolved OUTSIDE the factory (the factory is handed
 * {era, requestInfo} and cannot see the body).
 */
function buildHandler(store) {
  let currentKey = null;
  const handler = createMcpHandler(
    () => {
      const sessionKey = currentKey ?? "unkeyed";
      const server = new McpServerV2(
        { name: "romdev-test", version: "0.0.1" },
        { capabilities: { tools: {} } },
      );
      const wrapped = withV1ToolApi(server);
      // A stand-in for the real tool surface: the point is that the SAME
      // registration drives both eras, and that it scopes by sessionKey.
      wrapped.tool("put", "store a value in this session", { v: z.string() }, async ({ v }) => {
        store.set(sessionKey, v);
        return { content: [{ type: "text", text: "stored" }] };
      });
      wrapped.tool("get", "read this session's value", async () => ({
        content: [{ type: "text", text: store.get(sessionKey) ?? "<none>" }],
      }));
      return server;
    },
    { legacy: "reject" },
  );
  return {
    async dispatch(body, handle) {
      currentKey = resolveSessionKey({ meta: body.params?._meta }).sessionKey;
      const res = await handler.fetch(modernRequest(body, body.params?.name));
      return res.json();
    },
  };
}

test("era classification: a modern envelope is not legacy, an initialize is", async () => {
  const modern = modernRequest(modernBody(1, "server/discover"));
  assert.equal(await isLegacyRequest(modern, JSON.parse(JSON.stringify(modernBody(1, "server/discover")))), false);

  const legacyBody = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "old", version: "1" } },
  };
  const legacyReq = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(legacyBody),
  });
  assert.equal(await isLegacyRequest(legacyReq, legacyBody), true);
});

test("server/discover advertises 2026-07-28 with no handshake", async () => {
  const h = buildHandler(new Map());
  const out = await h.dispatch(modernBody(1, "server/discover"));
  assert.ok(out.result, `expected a result, got ${JSON.stringify(out).slice(0, 200)}`);
  assert.ok(out.result.supportedVersions.includes(PROTOCOL));
});

test("a modern session keeps its state across SEPARATE stateless requests", async () => {
  const store = new Map();
  const h = buildHandler(store);
  const handle = "session-alpha";

  await h.dispatch(modernBody(1, "tools/call", { name: "put", arguments: { v: "alpha-value" } }, handle));
  // A brand new request. No session, no Mcp-Session-Id, no connection reuse --
  // the handle is the ONLY thing tying these two calls together.
  const got = await h.dispatch(modernBody(2, "tools/call", { name: "get", arguments: {} }, handle));

  assert.equal(got.result.content[0].text, "alpha-value");
});

test("two modern handles are two sessions -- state does not leak between them", async () => {
  const store = new Map();
  const h = buildHandler(store);

  await h.dispatch(modernBody(1, "tools/call", { name: "put", arguments: { v: "mine" } }, "session-a"));
  const other = await h.dispatch(modernBody(2, "tools/call", { name: "get", arguments: {} }, "session-b"));

  assert.equal(other.result.content[0].text, "<none>",
    "a different handle must not see another session's emulator");
});

test("the v1 .tool() adapter registers both the shaped and no-arg forms", async () => {
  const store = new Map();
  const h = buildHandler(store);
  const list = await h.dispatch(modernBody(1, "tools/list"));
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["get", "put"]);
  // The shaped tool kept its input schema; the no-arg one did not invent one.
  const put = list.result.tools.find((t) => t.name === "put");
  assert.ok(put.inputSchema, "a shaped tool keeps its schema through the adapter");
});

test("list results carry the cache hints the revision requires", async () => {
  const h = buildHandler(new Map());
  const list = await h.dispatch(modernBody(1, "tools/list"));
  // ttlMs + cacheScope are required on list results in 2026-07-28 (SEP-2549).
  assert.equal(typeof list.result.ttlMs, "number");
  assert.ok(["public", "private"].includes(list.result.cacheScope));
});

test("a modern session that loses its host to eviction recovers by name", async () => {
  // The A x C interaction, and the one that would bite hardest in practice:
  // the modern era has no session to notice an eviction, so the ONLY way a
  // stateless client learns what happened is the error it gets back. It must
  // name the exact call to re-run, or an agent is left guessing what it had
  // loaded. Verified live against the server too (an evicted wasmcart session
  // was told `loadMedia({ platform: "wasmcart", path: "..." })`).
  const { installHost, rememberLastMedia, reapIdleHosts, getHost, setHostProtectedPredicate } =
    await import("../src/mcp/state.js");

  setHostProtectedPredicate(() => false);
  const handle = "modern-evicted";
  // Whatever key the handle resolves to is the key the host lives under --
  // that identity is exactly what workstream B guarantees.
  const { sessionKey } = resolveSessionKey({ meta: { [SESSION_META_KEY]: handle } });
  assert.equal(sessionKey, handle);

  installHost(sessionKey, { status: { loaded: true }, dispose() {} });
  rememberLastMedia(sessionKey, { platform: "wasmcart", path: "/tmp/game.wasc" });

  reapIdleHosts(Date.now() + 60 * 60 * 1000);

  assert.throws(() => getHost(sessionKey), (err) => {
    assert.match(err.message, /loadMedia/);
    assert.match(err.message, /wasmcart/);
    assert.match(err.message, /game\.wasc/);
    return true;
  }, "an evicted modern session must be told exactly how to get back");
});
