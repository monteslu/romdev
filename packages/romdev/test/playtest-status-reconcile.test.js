// Regression tests for the stale-playtest-status bug.
//
// Symptom seen in the wild: a playtest window died WITHOUT firing SDL's
// 'close' event (server restart / compositor kill / X-Wayland session loss),
// so the module-cached session kept `running: true` and `playtestStatus`
// reported a live window with an advancing frameCount while NO window was on
// screen. The fix: reconcile against a window-level truth-probe
// (`windowAlive()`), not the cached `running` flag, and tear the dead session
// down. `isSessionAlive` is the pure decision that drives that reconcile.

import { test } from "node:test";
import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { registerTools } from "../src/mcp/tools/index.js";
import { isSessionAlive } from "../src/mcp/tools/playtest.js";

test("isSessionAlive: null session is not alive", () => {
  assert.equal(isSessionAlive(null), false);
  assert.equal(isSessionAlive(undefined), false);
});

test("isSessionAlive: a live window probe wins over the running flag", () => {
  // Normal healthy session: window up, flag up.
  assert.equal(isSessionAlive({ running: true, windowAlive: () => true }), true);
});

test("isSessionAlive: dead window is reported dead EVEN when running is still true", () => {
  // THE bug: the window died but `running` was never flipped. The probe must
  // override the stale flag so callers don't believe a corpse is live.
  const stale = { running: true, windowAlive: () => false };
  assert.equal(isSessionAlive(stale), false);
});

test("isSessionAlive: a throwing probe (freed SDL handle) is treated as dead", () => {
  // windowAlive() itself catches throws, but defend the contract: a probe
  // that returns a falsy value for any reason means not-alive.
  assert.equal(isSessionAlive({ running: true, windowAlive: () => 0 }), false);
});

test("isSessionAlive: legacy handle without a probe falls back to running", () => {
  assert.equal(isSessionAlive({ running: true }), true);
  assert.equal(isSessionAlive({ running: false }), false);
});

async function startClient() {
  const server = new McpServer(
    { name: "playtest-status-test", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, z);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "playtest-status-client", version: "0.0.1" },
    { capabilities: {} },
  );
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function parseToolJson(res) {
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

test("playtestStatus reports running:false when no window is open", async () => {
  const client = await startClient();
  const res = await client.callTool({ name: "playtestStatus", arguments: {} });
  const parsed = parseToolJson(res);
  assert.equal(parsed.running, false, "no window → running must be false, not a stale truthy value");
});

test("playtestStop is a clean no-op when no window is open", async () => {
  const client = await startClient();
  const res = await client.callTool({ name: "playtestStop", arguments: {} });
  const text = res.content.find((c) => c.type === "text")?.text ?? "";
  assert.match(text, /no playtest window open/i);
});

test("playtest with no display returns an actionable no-display error (not a silent no-op)", async () => {
  // Simulate the real-world trigger: a server launched from a shell/tmux
  // session that has no desktop display env (started before desktop login,
  // or a cron/CI run). playtest() must NOT silently appear to succeed.
  const savedDisplay = process.env.DISPLAY;
  const savedWayland = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const client = await startClient();
    const res = await client.callTool({ name: "playtest", arguments: {} });
    const parsed = parseToolJson(res);
    assert.equal(parsed.opened, false, "must report not-opened, not a fake success");
    assert.equal(parsed.reason, "no-display");
    assert.match(parsed.message, /DISPLAY|WAYLAND_DISPLAY/);
    assert.match(parsed.message, /headless tool|still work/i, "should reassure that other tools still work");
  } finally {
    if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay;
    if (savedWayland !== undefined) process.env.WAYLAND_DISPLAY = savedWayland;
  }
});

test("playtestFramebuffer errors cleanly when no playtest window is open", async () => {
  // The point of the tool is "capture what the human's window shows". With no
  // window it must return a structured error pointing at screenshot(), NOT
  // throw or silently capture the agent's active host.
  const client = await startClient();
  const res = await client.callTool({ name: "playtestFramebuffer", arguments: { inline: true } });
  const parsed = parseToolJson(res);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /no playtest window open/i);
  assert.match(parsed.hint, /screenshot/i, "should point the agent at screenshot() as the fallback");
});
