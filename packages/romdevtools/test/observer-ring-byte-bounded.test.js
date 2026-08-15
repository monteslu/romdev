// The observer ring is bounded in EVENTS (50) but used to be unbounded in
// BYTES: `result` went through summarizeForLog, `images` did not. A ring full
// of frames made the single `replay` emit on connect ~20MB against socket.io's
// 1MB default — the server closed the connection, the client reconnected, and
// got the same payload again. Symptom: "the livestream page sometimes takes a
// very long time to render", intermittent because a ring of cheap text calls
// replays in a few KB.
//
// These tests pin the three bounds. They import the bus FRESH per test (the
// module exports a process singleton) so ring state can't leak between cases.

import { test } from "node:test";
import assert from "node:assert/strict";

/** Fresh module instance — the bus is a singleton, so cache-bust per test. */
let _n = 0;
async function freshBus(env = {}) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    process.env[k] = String(v);
  }
  try {
    return await import(`../src/observer/bus.js?ring-test=${_n++}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/** A call_frame event carrying a `kb`-sized base64 payload, like a real composite. */
function frameEvent(kb, i = 0) {
  return {
    type: "call_frame",
    sessionKey: "s1",
    ts: 1000 + i,
    tool: "frame",
    images: [{ kind: "image", mimeType: "image/png", base64: "A".repeat(kb * 1024) }],
  };
}

const MB = 1024 * 1024;

test("a ring full of large frames replays far under the socket.io limit", async () => {
  const { observer } = await freshBus();
  // 50 slots x 400KB base64 — the shape that produced the ~20MB replay.
  for (let i = 0; i < 50; i++) observer.push(frameEvent(400, i));

  const payload = JSON.stringify({ events: observer.replay(), activeSessions: [] });
  assert.ok(
    payload.length < MB,
    `replay payload ${payload.length} bytes should be under socket.io's 1MB default; ` +
      `the pre-fix ring produced ~20MB here`,
  );
});

test("the newest frames keep their payload; older ones become placeholders", async () => {
  const { observer } = await freshBus({ ROMDEV_OBSERVER_RING_IMAGES: 3 });
  for (let i = 0; i < 10; i++) observer.push(frameEvent(200, i));

  const withPayload = observer
    .replay()
    .filter((ev) => ev.images?.some((img) => typeof img.base64 === "string"));
  assert.equal(withPayload.length, 3, "exactly the newest 3 image events keep base64");

  // ...and they are the NEWEST three, so a fresh page opens on a current frame.
  assert.deepEqual(withPayload.map((ev) => ev.ts), [1007, 1008, 1009]);

  // Demoted entries still say a frame happened, and say how big it was.
  const demoted = observer.replay().find((ev) => ev.images?.[0]?.omitted);
  assert.equal(demoted.images[0].mimeType, "image/png");
  assert.equal(demoted.images[0].bytes, 200 * 1024);
  assert.equal(demoted.images[0].base64, undefined);
});

test("the byte budget evicts oldest even when every entry is a retained payload", async () => {
  // Keep more images than the budget can hold: demotion alone can't save this,
  // so the byte budget has to bite. 1MB budget, 6 retained x 400KB.
  const { observer } = await freshBus({
    ROMDEV_OBSERVER_RING_IMAGES: 6,
    ROMDEV_OBSERVER_RING_BYTES: MB,
  });
  for (let i = 0; i < 20; i++) observer.push(frameEvent(400, i));

  assert.ok(
    observer.ringBytes() <= MB,
    `ring should hold at or under its 1MB budget, got ${observer.ringBytes()}`,
  );
  // The newest event survives eviction — replay must never come back empty.
  const ring = observer.replay();
  assert.ok(ring.length >= 1);
  assert.equal(ring[ring.length - 1].ts, 1019, "newest event is the one kept");
});

test("a single event larger than the whole budget is stripped, not retained", async () => {
  const { observer } = await freshBus({ ROMDEV_OBSERVER_RING_BYTES: 64 * 1024 });
  observer.push(frameEvent(500, 0)); // one 500KB frame vs a 64KB budget

  assert.ok(observer.ringBytes() <= 64 * 1024, "oversized lone event must be stripped");
  assert.equal(observer.replay()[0].images[0].omitted, true);
});

test("live subscribers still get FULL images — only what is RETAINED is stripped", async () => {
  const { observer } = await freshBus({ ROMDEV_OBSERVER_RING_IMAGES: 0 });
  const seen = [];
  observer.on("event", (ev) => seen.push(ev));

  observer.push(frameEvent(300, 0));

  assert.equal(
    seen[0].images[0].base64.length,
    300 * 1024,
    "the live emit must carry the real frame; stripping is a RETENTION policy",
  );
  // ...while the retained copy is a placeholder.
  assert.equal(observer.replay()[0].images[0].omitted, true);
});

test("text-only events are retained untouched (no needless copying)", async () => {
  const { observer } = await freshBus();
  const ev = { type: "call", sessionKey: "s1", ts: 1, tool: "build", ok: true, result: { size: 40960 } };
  observer.push(ev);

  assert.equal(observer.replay()[0], ev, "an event with no images is stored by reference");
});

// ── Control: the assertion above must FAIL against the pre-fix behaviour, or
// it isn't testing anything. Reproduce the old ring (events-bounded only) and
// prove it blows the 1MB budget.
test("CONTROL: the pre-fix ring really does exceed 1MB (guards the guard)", async () => {
  const oldRing = [];
  for (let i = 0; i < 50; i++) {
    oldRing.push(frameEvent(400, i));
    if (oldRing.length > 50) oldRing.shift();
  }
  const payload = JSON.stringify({ events: oldRing, activeSessions: [] });
  assert.ok(
    payload.length > 10 * MB,
    `the bug must reproduce for the fix to mean anything; got ${payload.length} bytes`,
  );
});
