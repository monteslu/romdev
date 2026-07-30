// Opt-in periodic auto-snapshot — v0.103.0 feedback item 2, ask (b).
//
// Ask (a) was pid/uptime in catalog({op:'status'}) so a session can DETECT that
// the server restarted under it. That shipped. This is the other half, and the
// more valuable one: detection alone just tells you the work is gone. With a
// recent snapshot the recovery point is "the last minute" instead of "fresh
// boot".
//
// The reported restart happened between two consecutive calls seconds apart, no
// version change, no idle gap. Recovery cost a full re-drive (loadMedia + state
// load + 480-frame advance + poke + breakpoint) and was cheap ONLY because that
// moment was reachable from a save state and a deterministic recipe. A drive
// anchored on a long breakpoint run would have been expensive to lose.
//
// The properties under test are the ones that make this safe to leave armed:
// opt-in, lazy (no background timer), never clobbers a hand-built rig, and never
// fails the call it was meant to protect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  configureAutoSnapshot,
  autoSnapshotStatus,
  maybeAutoSnapshot,
  findLatestAutoSnapshot,
  readAutoSnapshot,
  _resetAutoSnapshots,
} from "../src/mcp/auto-snapshot.js";

function fakeHost({ loaded = true, blob = [1, 2, 3, 4], throws = false } = {}) {
  return {
    status: { platform: "nes", loaded },
    serializeState() {
      if (throws) throw new Error("core refused to serialize");
      return new Uint8Array(blob);
    },
  };
}

const tmpDir = () => mkdtempSync(path.join(tmpdir(), "autosnap-test-"));

test("disarmed by default — no snapshot without asking", async () => {
  _resetAutoSnapshots();
  const key = "snap-off";
  assert.equal(autoSnapshotStatus(key), null);
  // Serializing state costs real time on big cores, and a frame-exact flow must
  // not have unrequested work injected into it.
  assert.equal(await maybeAutoSnapshot(key, fakeHost()), null);
});

test("armed, it captures once the interval has elapsed", async () => {
  _resetAutoSnapshots();
  const key = "snap-basic";
  const dir = tmpDir();
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 60, dir });

  const host = fakeHost();
  // t=0 is the arm moment, so the first check is not yet due.
  assert.equal(await maybeAutoSnapshot(key, host, 1000), null, "not due yet");
  const wrote = await maybeAutoSnapshot(key, host, 61_000);
  assert.ok(wrote, "captured once the interval passed");
  assert.ok(existsSync(wrote.path));
  assert.deepEqual(Array.from(readFileSync(wrote.path)), [1, 2, 3, 4]);
});

test("it does nothing when no ROM is loaded", async () => {
  _resetAutoSnapshots();
  const key = "snap-noload";
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 1, dir: tmpDir() });
  assert.equal(await maybeAutoSnapshot(key, fakeHost({ loaded: false }), 999_000), null);
});

test("snapshots ROTATE, so a restart mid-write can't leave only a truncated file", async () => {
  _resetAutoSnapshots();
  const key = "snap-rotate";
  const dir = tmpDir();
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 10, dir });
  const host = fakeHost();

  const a = await maybeAutoSnapshot(key, host, 20_000);
  const b = await maybeAutoSnapshot(key, host, 40_000);
  const c = await maybeAutoSnapshot(key, host, 60_000);
  assert.notEqual(a.path, b.path, "consecutive writes use different files");
  assert.equal(a.path, c.path, "two slots, rotating");
});

test("a serialize failure is recorded, never thrown", async () => {
  // A safety net that breaks the call it was protecting is worse than none.
  _resetAutoSnapshots();
  const key = "snap-fail";
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 1, dir: tmpDir() });
  const r = await maybeAutoSnapshot(key, fakeHost({ throws: true }), 999_000);
  assert.equal(r, null, "returned null instead of throwing");
  assert.match(autoSnapshotStatus(key).lastError, /refused to serialize/);
});

test("concurrent checks don't both write for the same interval", async () => {
  _resetAutoSnapshots();
  const key = "snap-race";
  const dir = tmpDir();
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 10, dir });
  const host = fakeHost();
  // Both see the same "now" and both would consider themselves due; the slot is
  // claimed before the first await so only one proceeds.
  const [x, y] = await Promise.all([
    maybeAutoSnapshot(key, host, 30_000),
    maybeAutoSnapshot(key, host, 30_000),
  ]);
  assert.equal([x, y].filter(Boolean).length, 1, "exactly one write");
});

test("recovery finds the NEWEST snapshot and reads it back", async () => {
  _resetAutoSnapshots();
  const key = "snap-recover";
  const dir = tmpDir();
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 10, dir });

  await maybeAutoSnapshot(key, fakeHost({ blob: [9, 9] }), 20_000);
  await new Promise((r) => setTimeout(r, 12));   // distinct mtimes
  await maybeAutoSnapshot(key, fakeHost({ blob: [7, 7, 7] }), 40_000);

  const found = await findLatestAutoSnapshot(key, dir);
  assert.ok(found, "found a snapshot");
  const bytes = await readAutoSnapshot(found.path);
  assert.deepEqual(Array.from(bytes), [7, 7, 7], "the newer one");
  assert.equal(typeof found.ageSeconds, "number");
});

test("recovery reports nothing when none was ever taken", async () => {
  _resetAutoSnapshots();
  assert.equal(await findLatestAutoSnapshot("snap-empty", tmpDir()), null);
});

test("status reports the interval, count and age; disarming clears it", async () => {
  _resetAutoSnapshots();
  const key = "snap-status";
  const dir = tmpDir();
  configureAutoSnapshot(key, { enabled: true, intervalSeconds: 30, dir });
  assert.equal(autoSnapshotStatus(key).intervalSeconds, 30);
  assert.match(autoSnapshotStatus(key).note, /nothing captured yet/);

  await maybeAutoSnapshot(key, fakeHost(), 60_000);
  const st = autoSnapshotStatus(key);
  assert.equal(st.writes, 1);
  assert.ok(st.lastSnapshotPath);
  assert.equal(st.lastSnapshotBytes, 4);

  configureAutoSnapshot(key, { enabled: false });
  assert.equal(autoSnapshotStatus(key), null, "disarmed");
});

test("snapshots live in a session-scoped dir, away from hand-built rigs", async () => {
  // An auto-snapshot must never be able to clobber a slot someone named.
  _resetAutoSnapshots();
  configureAutoSnapshot("session-a", { enabled: true, intervalSeconds: 10 });
  configureAutoSnapshot("session-b", { enabled: true, intervalSeconds: 10 });
  const a = autoSnapshotStatus("session-a").dir;
  const b = autoSnapshotStatus("session-b").dir;
  assert.notEqual(a, b, "sessions don't share a snapshot dir");
  for (const d of [a, b]) assert.match(path.basename(d), /^session-[ab]$/);
});

// ── End to end, through the tools an agent actually calls ───────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerTools } from "../src/mcp/tools/index.js";

const ROM = new URL("./roms/nestest.nes", import.meta.url).pathname;

async function session(key) {
  const server = new McpServer({ name: key, version: "0.0.1" }, { capabilities: { tools: {} } });
  registerTools(server, z, key);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: key + "-c", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.find?.((c) => c.type === "text")?.text;
    if (r.isError) return { _error: text };
    try { return JSON.parse(text); } catch { return text; }
  };
}

test("arm → step → recover, the whole restart-survival loop", { timeout: 120000 }, async () => {
  _resetAutoSnapshots();
  const key = "snap-e2e";
  const dir = tmpDir();
  const call = await session(key);

  assert.equal((await call("loadMedia", { platform: "nes", path: ROM })).loaded, true);
  const armed = await call("state", { op: "autoSnapshot", enabled: true, intervalSeconds: 5, dir });
  assert.equal(armed.enabled, true);
  assert.match(armed.note, /ARMED/);

  // Drive far enough that a snapshot is genuinely due, then leave a marker so
  // the restore can be proven to have landed on the right moment.
  await call("frame", { op: "step", frames: 30 });
  await call("memory", { op: "write", region: "system_ram", offset: 0x50, hex: "c0de" });
  await new Promise((r) => setTimeout(r, 5100));
  await call("frame", { op: "step", frames: 1 });

  const status = await call("catalog", { op: "status" });
  assert.ok(status.autoSnapshot, "status advertises the recovery point");
  assert.ok(status.autoSnapshot.lastSnapshotPath, "a snapshot exists: " + JSON.stringify(status.autoSnapshot));

  // Simulate the loss: scribble over the marker, as a restart-and-re-drive would.
  await call("memory", { op: "write", region: "system_ram", offset: 0x50, hex: "0000" });

  const rec = await call("state", { op: "recoverSnapshot", dir });
  assert.equal(rec.recovered, true, "recovered: " + JSON.stringify(rec));
  assert.match(rec.note, /bounds the loss, it doesn't erase it/);

  const ram = await call("memory", { op: "read", region: "system_ram", offset: 0x50, length: 2 });
  assert.match(JSON.stringify(ram), /c0de/i, "restored to the snapshotted moment");
});

test("recoverSnapshot with nothing saved explains itself instead of failing", async () => {
  _resetAutoSnapshots();
  const call = await session("snap-e2e-none");
  assert.equal((await call("loadMedia", { platform: "nes", path: ROM })).loaded, true);
  const rec = await call("state", { op: "recoverSnapshot", dir: tmpDir() });
  assert.equal(rec.recovered, false);
  assert.match(rec.note, /only helps for restarts that happen AFTER it's armed/);
});
