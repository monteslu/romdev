// A session looping per-item calls is told so, in the response it reads, with
// the bulk form of the tool it is flooding (feedback 2026-09-22: 38,763 disasm
// calls at 49-72 req/s against a shared server, and nothing said a word).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestStats, floodWarning, FLOOD_RPS, FLOOD_WINDOW_S } from "../src/observer/request-stats.js";

test("floodWarning: silent at normal rates, names the bulk form once a session floods", () => {
  let now = 1_000_000;
  const stats = new RequestStats({ now: () => now });
  const call = () => stats.record({ type: "call", sessionKey: "s1", tool: "disasm", ok: true });
  // 5 req/s for 10 s: an agent working normally
  for (let t = 0; t < FLOOD_WINDOW_S * 5; t++) { call(); now += 200; }
  assert.equal(floodWarning("s1", "disasm", stats), null);
  // 50 req/s: the loop
  for (let t = 0; t < FLOOD_WINDOW_S * 50; t++) { call(); now += 20; }
  const w = floodWarning("s1", "disasm", stats);
  assert.ok(w && /emit:'blockMap'/.test(w) && /req\/s/.test(w), w);
  assert.ok(stats.recentRate("s1").rps > FLOOD_RPS);
  // another session is not blamed for it
  assert.equal(floodWarning("s2", "disasm", stats), null);
  // and the warning stops once the loop does
  now += (FLOOD_WINDOW_S + 1) * 1000;
  assert.equal(floodWarning("s1", "disasm", stats), null);
});
