// catalog({op:'status'}) must let a session DETECT a server restart.
//
// A reported session had the server restart between two consecutive calls
// seconds apart: a frame({op:'step'}) succeeded, and the very next
// frame({op:'screenshot'}) came back "No ROM loaded in this session". The error
// text was excellent -- it distinguishes never-loaded / session-mismatch /
// server-restart and names the recovery -- and recovery worked first try. But
// nothing let the session NOTICE the event: no way to log it, and no way to tell
// "the server restarted under me" apart from "I never loaded a ROM" without
// reading prose.
//
// A pid and an uptime are proof, and cost nothing. This is worth having whether
// or not the underlying cause is ever found.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerTools } from "../src/mcp/tools/index.js";

function getCatalogHandler(sessionKey) {
  let handler;
  registerTools({ tool(name, _d, _s, h) { if (name === "catalog") handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

test("status reports the process identity and age", async () => {
  const handler = getCatalogHandler("catalog-restart-1");
  const r = parseResult(await handler({ op: "status" }));

  assert.equal(r.serverPid, process.pid, "the pid a session compares across calls");
  assert.equal(typeof r.serverUptimeSeconds, "number");
  assert.ok(r.serverUptimeSeconds >= 0);
  // Parseable, so a session can log or diff it rather than eyeball it.
  assert.ok(!Number.isNaN(Date.parse(r.serverStartedAt)), "serverStartedAt is an ISO timestamp");
});

test("the pid is stable across calls within one process", async () => {
  // The detector only works if it does NOT change spuriously -- otherwise every
  // status call would look like a restart.
  const handler = getCatalogHandler("catalog-restart-2");
  const a = parseResult(await handler({ op: "status" }));
  const b = parseResult(await handler({ op: "status" }));
  assert.equal(a.serverPid, b.serverPid);
  assert.ok(b.serverUptimeSeconds >= a.serverUptimeSeconds, "uptime moves forward, never back");
});

test("a young process says so, since that IS the restart signal", async () => {
  // Under the test runner the process is seconds old, which is exactly the
  // situation a session needs flagged: if the conversation is older than the
  // server, the server restarted underneath it.
  const handler = getCatalogHandler("catalog-restart-3");
  const r = parseResult(await handler({ op: "status" }));
  if (r.serverUptimeSeconds < 120) {
    assert.match(r.serverRecentlyStarted, /RESTARTED under you/);
    assert.match(r.serverRecentlyStarted, /loadMedia/, "names the recovery");
    assert.match(r.serverRecentlyStarted, /serverPid/, "names the reliable detector");
  }
});

test("the existing status fields still come through", async () => {
  const handler = getCatalogHandler("catalog-restart-4");
  const r = parseResult(await handler({ op: "status" }));
  assert.ok(r.romdevVersion, "version still reported");
  assert.equal(r.loaded, false, "no host in this test session");
  assert.ok(r.capabilities, "capabilities map still present");
});
