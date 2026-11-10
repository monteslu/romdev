// Host runners (src/mcp/host-runners.js): every session's host runs in its
// own process, so one session's long call cannot stall another session or the
// front, and one session's host dying fails only that session.
//
// Each test starts a real server on a free port and drives it over HTTP, the
// door clients use. The isolation test has a control that must fail: the same
// load with ROMDEV_HOST_WORKERS=0 (every host in the server process) has to
// show the stall, or the measurement could not tell the two apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "src", "mcp", "server.js");
const NES = path.join(HERE, "roms", "nestest.nes");
const HELLO = path.join(HERE, "fixtures", "hello.wasc");

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ...extraEnv };
  delete env.ROMDEV_REEXEChild;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const pid = await new Promise((resolve, reject) => {
    const onData = (d) => {
      out += d;
      const m = /server up pid=(\d+)/.exec(out);
      if (m) resolve(+m[1]);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code, signal) => reject(new Error(`server exited (${code ?? signal}) before it was up:\n${out}`)));
  });
  const stop = async () => {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    await new Promise((r) => { if (proc.exitCode != null) r(); else { proc.once("exit", r); setTimeout(r, 8000).unref(); } });
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
  };
  return { port, pid, stop, log: () => out };
}

function post(port, p, body, headers = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "POST", agent: false,
      headers: { "content-type": "application/json", "content-length": data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch { /* text */ }
        resolve({ status: res.statusCode, ms: performance.now() - t0, text, json });
      });
    });
    req.on("error", (e) => resolve({ status: 0, ms: performance.now() - t0, text: String(e.message), json: null }));
    req.end(data);
  });
}
const tool = (port, session, name, args = {}) => post(port, `/tool/${name}`, args, { "x-romdev-session": session });
const initialize = (port) => post(port, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { accept: "application/json, text/event-stream" });

async function must(port, session, name, args) {
  const r = await tool(port, session, name, args);
  assert.equal(r.status, 200, `${name} ${JSON.stringify(args)}: ${r.text.slice(0, 500)}`);
  return r;
}

/** Steps that keep the session's host busy for about `ms` (NES frames run synchronously). */
async function framesFor(port, session, ms) {
  const r = await must(port, session, "frame", { op: "step", frames: 600 });
  return Math.max(600, Math.round((600 / r.ms) * ms));
}

/**
 * While session A runs one long synchronous step, how long do another
 * session's initialize, catalog and a short step of its own take?
 */
async function stallWhileBusy(srv) {
  await must(srv.port, "busy-a", "loadMedia", { platform: "nes", path: NES });
  await must(srv.port, "quiet-b", "loadMedia", { platform: "nes", path: NES });
  const frames = await framesFor(srv.port, "busy-a", 6000);
  const long = tool(srv.port, "busy-a", "frame", { op: "step", frames });
  await new Promise((r) => setTimeout(r, 300));
  const init = await initialize(srv.port);
  const cat = await tool(srv.port, "quiet-b", "catalog", { op: "status" });
  const step = await tool(srv.port, "quiet-b", "frame", { op: "step", frames: 10 });
  const a = await long;
  assert.equal(a.status, 200, a.text.slice(0, 300));
  return { longMs: a.ms, initMs: init.ms, catalogMs: cat.ms, stepMs: step.ms, cat };
}

test("host runners: one session's long step does not stall the front or another session", { timeout: 180000 }, async (t) => {
  const srv = await startServer();
  try {
    const r = await stallWhileBusy(srv);
    t.diagnostic(`busy step ${r.longMs | 0} ms; meanwhile initialize ${r.initMs | 0} ms, catalog ${r.catalogMs | 0} ms, other session's step ${r.stepMs | 0} ms`);
    assert.ok(r.longMs > 2500, `the busy step must really be long to prove anything (${r.longMs} ms)`);
    assert.ok(r.initMs < 1000, `initialize took ${r.initMs} ms while another session stepped`);
    assert.ok(r.catalogMs < 1500, `catalog took ${r.catalogMs} ms while another session stepped`);
    assert.ok(r.stepMs < 1500, `the quiet session's own step took ${r.stepMs} ms`);
    const health = r.cat.json.serverHealth;
    assert.equal(health.hostIsolation, "process");
    assert.equal(health.liveHosts, 2);
    const rows = health.hostRunners;
    assert.equal(rows.length, 2);
    const busy = rows.find((x) => x.session === "busy-a");
    assert.ok(busy.busy.length === 1 && /frame/.test(busy.busy[0].call), JSON.stringify(busy));
    assert.notEqual(busy.pid, srv.pid);
    assert.equal(r.cat.json.loaded, true);
    assert.equal(r.cat.json.platform, "nes");
  } finally { await srv.stop(); }
});

test("host runners control: with ROMDEV_HOST_WORKERS=0 the same load stalls the front (must fail the bound)", { timeout: 180000 }, async (t) => {
  const srv = await startServer({ ROMDEV_HOST_WORKERS: "0" });
  try {
    const r = await stallWhileBusy(srv);
    t.diagnostic(`busy step ${r.longMs | 0} ms; meanwhile initialize ${r.initMs | 0} ms, catalog ${r.catalogMs | 0} ms, other session's step ${r.stepMs | 0} ms`);
    assert.ok(r.longMs > 2500, `the busy step must really be long (${r.longMs} ms)`);
    // In one process the initialize waits for the whole synchronous step.
    assert.ok(r.initMs > 1000, `the in-process control did NOT stall (${r.initMs} ms): the isolation test proves nothing`);
    assert.equal(r.cat.json.serverHealth.hostIsolation, undefined);
  } finally { await srv.stop(); }
});

test("host runners: a host process that dies fails only its own session, with a clear error", { timeout: 180000 }, async () => {
  const srv = await startServer();
  try {
    await must(srv.port, "victim", "loadMedia", { platform: "nes", path: NES });
    await must(srv.port, "bystander", "loadMedia", { platform: "wasmcart", path: HELLO });
    await must(srv.port, "bystander", "frame", { op: "step", frames: 30 });
    const frames = await framesFor(srv.port, "victim", 6000);
    const cat = await must(srv.port, "bystander", "catalog", { op: "status" });
    const victimPid = cat.json.serverHealth.hostRunners.find((x) => x.session === "victim").pid;
    const long = tool(srv.port, "victim", "frame", { op: "step", frames });
    await new Promise((r) => setTimeout(r, 500));
    process.kill(victimPid, "SIGABRT"); // what a native abort (PulseAudio TLS) does
    const dead = await long;
    assert.equal(dead.status, 400, dead.text.slice(0, 300));
    const err = dead.json?.error ?? dead.text;
    assert.match(err, /host process \(pid \d+\) was killed by SIGABRT while running frame\(\{op:'step'\}\)/);
    assert.match(err, /Only this session was affected/);
    assert.match(err, /loadMedia\(\{ platform: "nes", path: ".*nestest\.nes" \}\)/);
    // The server and the other session are untouched.
    const step = await must(srv.port, "bystander", "frame", { op: "step", frames: 30 });
    assert.ok(step.ms < 5000);
    const after = await must(srv.port, "bystander", "catalog", { op: "status" });
    assert.equal(after.json.serverPid, srv.pid);
    assert.equal(after.json.loaded, true);
    assert.equal(after.json.platform, "wasmcart");
    assert.equal(after.json.serverHealth.hostRunnerDeaths.length, 1);
    // The victim's next call gets a fresh host process and the usual recovery hint.
    const again = await tool(srv.port, "victim", "frame", { op: "step", frames: 1 });
    assert.equal(again.status, 400);
    assert.match(again.json?.error ?? again.text, /No ROM loaded in this session - the host was evicted[\s\S]*nestest\.nes/);
    await must(srv.port, "victim", "loadMedia", { platform: "nes", path: NES });
    await must(srv.port, "victim", "frame", { op: "step", frames: 5 });
  } finally { await srv.stop(); }
});

test("host runners: a host whose event loop stops answering is killed by the watchdog", { timeout: 180000 }, async () => {
  const srv = await startServer({ ROMDEV_RUNNER_WEDGE_MS: "2500" });
  try {
    await must(srv.port, "wedge", "loadMedia", { platform: "nes", path: NES });
    const frames = await framesFor(srv.port, "wedge", 15000);
    const r = await tool(srv.port, "wedge", "frame", { op: "step", frames });
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.match(r.json?.error ?? r.text, /stopped answering for 3 s while frame\(\{op:'step'\}\) ran \(the cart did not return\)/);
    assert.ok(r.ms < 12000, `the watchdog took ${r.ms} ms`);
    const init = await initialize(srv.port);
    assert.equal(init.status, 200);
  } finally { await srv.stop(); }
});

test("host runners: eviction, session shutdown and the host cap behave as in-process", { timeout: 180000 }, async () => {
  const srv = await startServer({ ROMDEV_MAX_HOSTS: "1" });
  try {
    await must(srv.port, "first", "loadMedia", { platform: "nes", path: NES });
    await must(srv.port, "second", "loadMedia", { platform: "nes", path: NES });
    // the cap evicted the older host; its session self-heals with the hint
    const evicted = await tool(srv.port, "first", "frame", { op: "step", frames: 1 });
    assert.equal(evicted.status, 400);
    assert.match(evicted.json?.error ?? evicted.text, /host was evicted[\s\S]*nestest\.nes/);
    const st = await must(srv.port, "second", "catalog", { op: "status" });
    assert.equal(st.json.serverHealth.liveHosts, 1);
    // host shutdown ends the session: its runner process goes too
    await must(srv.port, "second", "host", { op: "shutdown" });
    await new Promise((r) => setTimeout(r, 500));
    const st2 = await must(srv.port, "probe", "catalog", { op: "status" });
    assert.equal(st2.json.serverHealth.liveHosts, 0);
    assert.ok(!st2.json.serverHealth.hostRunners.some((x) => x.session === "second"), JSON.stringify(st2.json.serverHealth.hostRunners));
  } finally { await srv.stop(); }
});

test("host runners: a session with a playtest window is never evicted and its human shows in status", { timeout: 180000 }, async () => {
  // ROMDEV_TEST_FAKE_PLAYTEST gives the named session's runner a stand-in
  // window with a human pressing buttons (no display needed).
  const srv = await startServer({ ROMDEV_MAX_HOSTS: "1", ROMDEV_TEST_FAKE_PLAYTEST: "human" });
  try {
    await must(srv.port, "human", "loadMedia", { platform: "nes", path: NES });
    await must(srv.port, "agent", "loadMedia", { platform: "nes", path: NES });
    // at the cap of 1, the window's host must survive; the cap is exceeded instead of evicting it
    const h = await must(srv.port, "human", "catalog", { op: "status" });
    assert.equal(h.json.loaded, true);
    assert.equal(h.json.playtestWindowOpen, true);
    assert.equal(h.json.humanInputActive, true);
    assert.equal(h.json.framesSinceHumanInput, 3);
    // a fresh session (the restart guard's view) sees that a window is open somewhere
    const g = await must(srv.port, "restart-guard", "catalog", { op: "status" });
    assert.equal(g.json.playtestWindowOpen, false);
    assert.equal(g.json.serverHealth.playtestWindowsOpen, 1);
    await must(srv.port, "human", "frame", { op: "step", frames: 5 });
    // input to the human's session carries the co-drive warning, as in-process
    const step = await must(srv.port, "human", "frame", { op: "step", frames: 1 });
    assert.match(step.text, /human|playtest/i);
  } finally { await srv.stop(); }
});

async function mcpSession(port) {
  const init = await post(port, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { accept: "application/json, text/event-stream" });
  assert.equal(init.status, 200, init.text);
  const sid = await new Promise((resolve) => {
    // the session id is a response header; re-issue through http.request to read it
    const data = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }));
    const req = http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", agent: false, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": data.length } }, (res) => { res.resume(); resolve(res.headers["mcp-session-id"]); });
    req.end(data);
  });
  const h = { accept: "application/json, text/event-stream", "mcp-session-id": sid };
  await post(port, "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, h);
  let id = 10;
  return async (name, args) => {
    const r = await post(port, "/mcp", { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, h);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    return r.json.result;
  };
}

test("host runners: the MCP transport runs tools in the runner with the same result shapes (text and images)", { timeout: 180000 }, async () => {
  const srv = await startServer();
  try {
    const callTool = await mcpSession(srv.port);
    const load = await callTool("loadMedia", { platform: "nes", path: NES });
    assert.ok(!load.isError, JSON.stringify(load).slice(0, 300));
    const shot = await callTool("frame", { op: "stepAndShot", frames: 30, inline: true });
    assert.ok(!shot.isError, JSON.stringify(shot).slice(0, 300));
    const img = shot.content.find((c) => c.type === "image");
    assert.ok(img && img.mimeType === "image/png" && img.data.length > 100, JSON.stringify(shot.content.map((c) => c.type)));
    // a bad argument is still refused with the clear error, before anything runs
    const bad = await callTool("frame", { op: "step", framez: 3 });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /framez/);
    const st = await callTool("catalog", { op: "status" });
    const j = JSON.parse(st.content[0].text);
    assert.equal(j.loaded, true);
    assert.equal(j.serverHealth.hostRunners.length, 1);
  } finally { await srv.stop(); }
});
