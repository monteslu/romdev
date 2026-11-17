// The core tools load up front in clients that defer MCP tools.
//
// Claude Code lists a server's tools by name only and loads a schema when the
// agent searches for it. An agent that must search before it can call
// loadMedia runs a shell command instead, and the work never reaches romdev.
// The core loop is marked `_meta["anthropic/alwaysLoad"]` in tools/list so it
// is there from the first turn; everything else stays deferred, because each
// marked tool costs every session its full definition.
//
// Also checked: the connection instructions point cart work at romdev inside
// the first 4096 characters, which is all Claude Code shows of them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createMcpHandler, McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { z } from "zod";

import { withV1ToolApi, ALWAYS_LOAD, ALWAYS_LOAD_KEY } from "../src/mcp/v2-adapter.js";
import { buildToolRegistry } from "../src/http/tool-registry.js";
import { mcpPreamble } from "../src/http/skill-doc.js";

const PROTOCOL = "2026-07-28";

async function listTools(names) {
  const handler = createMcpHandler(() => {
    const server = new McpServerV2({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    const wrapped = withV1ToolApi(server);
    for (const n of names) {
      wrapped.tool(n, `${n} tool`, { x: z.string().optional() }, async () => ({ content: [{ type: "text", text: "ok" }] }));
    }
    return server;
  }, { legacy: "reject" });
  const body = {
    jsonrpc: "2.0", id: 1, method: "tools/list",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL, "io.modelcontextprotocol/clientCapabilities": {} } },
  };
  const res = await handler.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": PROTOCOL, "mcp-method": "tools/list", "mcp-name": "tools/list" },
    body: JSON.stringify(body),
  }));
  return (await res.json()).result.tools;
}

test("the core tools carry anthropic/alwaysLoad and the rest do not", async () => {
  const tools = await listTools(["catalog", "loadMedia", "frame", "input", "wasm", "disasm", "memory"]);
  const marked = tools.filter((t) => t._meta?.[ALWAYS_LOAD_KEY] === true).map((t) => t.name).sort();
  assert.deepEqual(marked, ["catalog", "frame", "input", "loadMedia", "wasm"]);
  // Control: an unmarked tool has no such key, so the check above can fail.
  const disasm = tools.find((t) => t.name === "disasm");
  assert.equal(disasm._meta?.[ALWAYS_LOAD_KEY], undefined);
});

test("every always-load name is a real romdev tool (a rename cannot silently drop one)", () => {
  const reg = buildToolRegistry("always-load-names");
  const tools = reg.tools ?? reg;
  for (const name of ALWAYS_LOAD) {
    assert.ok(tools.has(name), `${name} is not a registered tool`);
  }
});

test("the instructions send cart runs to romdev within what Claude Code shows", () => {
  const shown = mcpPreamble.slice(0, 4096);
  assert.match(shown, /loadMedia\(\{platform:'wasmcart', path\}\)/);
  assert.match(shown, /wasmcart CLI/);
  assert.doesNotMatch(mcpPreamble, /no loading step/, "the old claim that no client defers tools");
});
