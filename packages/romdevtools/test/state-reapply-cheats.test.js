// state({op:'load', reapplyCheats}) + the cheat sidecar on save.
//
// A restore always clears active cheats, and `cheatsCleared:N` has reported that
// for a long time — in the right tool, at the moment it becomes true. It bit
// anyway: a reported session read `cheatsCleared:1`, moved on, re-seeded a rig,
// ran 200 frames and took a screenshot that came back GAME OVER, because the
// invincibility patch had been cleared two calls earlier. The gap is not
// notification, it is that knowing does not stop you forgetting to re-arm three
// calls later while reasoning about something else.
//
// The sidecar covers the other half: a rig SHARED between sessions carries its
// cheat requirements in prose (CLAUDE.md), so a fresh session loading it has no
// active cheats to snapshot and no way to know any were needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerStateTools } from "../src/mcp/tools/state.js";
import { _setHostForTest } from "../src/mcp/state.js";

function getStateHandler(sessionKey) {
  let handler;
  registerStateTools({ tool(name, _d, _s, h) { if (name === "state") handler = h; } }, z, sessionKey);
  return handler;
}

function parseResult(res) {
  assert.equal(res.isError, undefined, "unexpected isError: " + JSON.stringify(res));
  return JSON.parse(res.content.find((c) => c.type === "text").text);
}

/**
 * A host that models the real behaviour: serialize/unserialize round-trips a
 * blob, and a restore CLEARS the cheat table (frontend cheat state isn't in the
 * blob) while reporting how many it dropped.
 */
function fakeHost() {
  const cheats = new Map();
  return {
    status: { platform: "nes", loaded: true, paused: false },
    romPath: null,
    serializeState() { return new Uint8Array([1, 2, 3, 4]); },
    unserializeState() { const n = cheats.size; cheats.clear(); return n; },
    saveState() { return true; },
    loadState() { const n = cheats.size; cheats.clear(); return n; },
    setCheat(index, code, enabled) {
      if (enabled === false) cheats.delete(index);
      else cheats.set(index, code);
    },
    listActiveCheats() {
      return Array.from(cheats.entries()).map(([index, code]) => ({ index, code })).sort((a, b) => a.index - b.index);
    },
    clearCheats() { cheats.clear(); },
    renderOneFrame() {},
    stepFrames() { return 1; },
    getCPUState() { return { pc: 0xC000 }; },
    readMemory(_r, _o, len) { return new Uint8Array(len); },
    getFramebuffer() { return { data: new Uint8Array(4), width: 1, height: 1 }; },
    _cheats: cheats,
  };
}

function tmpStatePath(file = "rig.state") {
  return path.join(mkdtempSync(path.join(tmpdir(), "state-cheats-")), file);
}

test("without reapplyCheats a load clears them and says so, pointing at the flag", async () => {
  const key = "state-cheats-off";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  host.setCheat(0, "OXAASYAO", true);

  const p = tmpStatePath();
  parseResult(await handler({ op: "save", path: p }));
  const r = parseResult(await handler({ op: "load", path: p, probeLiveness: false }));

  assert.equal(r.cheatsCleared, 1);
  assert.equal(host.listActiveCheats().length, 0, "genuinely disarmed — this is what wasted the run");
  assert.equal(r.cheatsReapplied, undefined);
  assert.match(r.cheatsClearedHint, /reapplyCheats:true/);
});

test("reapplyCheats:true re-arms the session's cheats and reports them", async () => {
  const key = "state-cheats-on";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  host.setCheat(0, "OXAASYAO", true);
  host.setCheat(1, "SXIOPO", true);

  const p = tmpStatePath();
  parseResult(await handler({ op: "save", path: p }));
  const r = parseResult(await handler({ op: "load", path: p, probeLiveness: false, reapplyCheats: true }));

  assert.deepEqual(r.cheatsReapplied, ["OXAASYAO", "SXIOPO"]);
  assert.equal(r.cheatsReapplySource, "session");
  assert.deepEqual(host.listActiveCheats().map((c) => c.code), ["OXAASYAO", "SXIOPO"]);
  assert.equal(r.cheatsClearedHint, undefined, "no nag when it was handled");
});

test("re-arming survives the liveness probe, which re-restores the state", async () => {
  // The probe loads the state again; re-applying before it would be undone.
  const key = "state-cheats-probe";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  host.setCheat(0, "OXAASYAO", true);

  const p = tmpStatePath();
  parseResult(await handler({ op: "save", path: p }));
  const r = parseResult(await handler({ op: "load", path: p, probeLiveness: true, reapplyCheats: true }));

  assert.deepEqual(r.cheatsReapplied, ["OXAASYAO"]);
  assert.equal(host.listActiveCheats().length, 1, "still armed after the probe re-restored");
});

test("saving with cheats active writes a sidecar; the .state bytes are untouched", async () => {
  const key = "state-sidecar-write";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  host.setCheat(0, "OXAASYAO", true);

  const p = tmpStatePath();
  const r = parseResult(await handler({ op: "save", path: p }));

  assert.deepEqual(r.cheatsRecorded, ["OXAASYAO"]);
  assert.ok(existsSync(p + ".cheats.json"), "sidecar written next to the state");
  const side = JSON.parse(readFileSync(p + ".cheats.json", "utf8"));
  assert.deepEqual(side.cheats.map((c) => c.code), ["OXAASYAO"]);
  // The blob itself must be exactly what the core produced — that is the whole
  // reason this is a sidecar and not a new field in the state format.
  assert.deepEqual(Array.from(readFileSync(p)), [1, 2, 3, 4]);
});

test("no cheats active means no sidecar (no noise beside every state file)", async () => {
  const key = "state-sidecar-none";
  _setHostForTest(key, fakeHost());
  const handler = getStateHandler(key);
  const p = tmpStatePath();
  const r = parseResult(await handler({ op: "save", path: p }));
  assert.equal(r.cheatsRecorded, undefined);
  assert.equal(existsSync(p + ".cheats.json"), false);
});

test("recordCheats:false opts out", async () => {
  const key = "state-sidecar-optout";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  host.setCheat(0, "OXAASYAO", true);
  const p = tmpStatePath();
  parseResult(await handler({ op: "save", path: p, recordCheats: false }));
  assert.equal(existsSync(p + ".cheats.json"), false);
});

test("a FRESH session loading a shared rig learns its cheats from the sidecar", async () => {
  // The case prose in CLAUDE.md was covering: nothing is active to snapshot,
  // so the rig's own record is the only source.
  const p = tmpStatePath();
  {
    const key = "state-sidecar-author";
    const host = fakeHost();
    _setHostForTest(key, host);
    const handler = getStateHandler(key);
    host.setCheat(0, "OXAASYAO", true);
    parseResult(await handler({ op: "save", path: p }));
  }

  const key2 = "state-sidecar-consumer";
  const fresh = fakeHost();               // no cheats active
  _setHostForTest(key2, fresh);
  const handler2 = getStateHandler(key2);
  const r = parseResult(await handler2({ op: "load", path: p, probeLiveness: false, reapplyCheats: true }));

  assert.deepEqual(r.cheatsReapplied, ["OXAASYAO"]);
  assert.equal(r.cheatsReapplySource, "sidecar");
  assert.deepEqual(r.cheatsRecordedWithState, ["OXAASYAO"]);
  assert.deepEqual(fresh.listActiveCheats().map((c) => c.code), ["OXAASYAO"]);
});

test("the sidecar is reported even when reapplyCheats wasn't asked for", async () => {
  const p = tmpStatePath();
  {
    const key = "state-sidecar-author2";
    const host = fakeHost();
    _setHostForTest(key, host);
    const handler = getStateHandler(key);
    host.setCheat(0, "OXAASYAO", true);
    parseResult(await handler({ op: "save", path: p }));
  }
  const key2 = "state-sidecar-quiet";
  _setHostForTest(key2, fakeHost());
  const handler2 = getStateHandler(key2);
  const r = parseResult(await handler2({ op: "load", path: p, probeLiveness: false }));
  // Discovering this via GAME OVER is the failure being designed out.
  assert.deepEqual(r.cheatsRecordedWithState, ["OXAASYAO"]);
  assert.match(r.cheatsClearedHint, /SAVED with 1 cheat/);
});

test("a corrupt sidecar is ignored rather than failing the load", async () => {
  const key = "state-sidecar-corrupt";
  const host = fakeHost();
  _setHostForTest(key, host);
  const handler = getStateHandler(key);
  const p = tmpStatePath();
  parseResult(await handler({ op: "save", path: p }));
  writeFileSync(p + ".cheats.json", "{ this is not json");
  const r = parseResult(await handler({ op: "load", path: p, probeLiveness: false, reapplyCheats: true }));
  assert.equal(r.loaded, true);
  assert.equal(r.cheatsRecordedWithState, undefined);
});
