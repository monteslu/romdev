// Agent attribution: who owns a session, and who pays at the caps.
//
// After the stateless MCP migration there is no connection affinity left, so
// one agent opening 53 parallel sessions and ten agents opening five each
// are indistinguishable from transport signals -- session keys are
// self-declared strings on both the REST and modern-MCP paths. That
// blindness has a concrete cost now that sessions and hosts are CAPPED: a
// global oldest-idle eviction lets the greediest caller push everyone
// else's sessions out.
//
// The answer is the same pattern as session identity, one level up: a
// cooperative self-declared agent handle. These tests pin the property that
// makes declaring worth it -- at a cap, THE LARGEST HOLDER pays.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setSessionAgent,
  getSessionAgent,
  clearSessionAgent,
  groupByAgent,
  pickEvictionVictim,
  UNATTRIBUTED,
} from "../src/mcp/agent-identity.js";

function cleanup(keys) {
  for (const k of keys) clearSessionAgent(k);
}

test("undeclared sessions pool as one anonymous agent -- the pre-attribution behaviour", () => {
  assert.equal(getSessionAgent("never-declared"), UNATTRIBUTED);
  const groups = groupByAgent(["a", "b", "c"]);
  assert.deepEqual([...groups.keys()], [UNATTRIBUTED]);
  assert.equal(groups.get(UNATTRIBUTED).length, 3);
});

test("empty and missing declarations do not overwrite a real one", () => {
  setSessionAgent("s1", "formix-agent");
  setSessionAgent("s1", undefined);
  setSessionAgent("s1", "");
  assert.equal(getSessionAgent("s1"), "formix-agent");
  cleanup(["s1"]);
});

test("eviction targets the LARGEST holder's oldest session, not the globally oldest", () => {
  // agent-big holds 4 sessions, agent-small holds 1 -- and agent-small's is
  // the globally OLDEST. Global oldest-idle would evict the modest agent's
  // only session; fairness must instead charge the big holder.
  const stamps = { "big-1": 100, "big-2": 40, "big-3": 90, "big-4": 80, "small-1": 10 };
  for (const k of ["big-1", "big-2", "big-3", "big-4"]) setSessionAgent(k, "agent-big");
  setSessionAgent("small-1", "agent-small");

  const victim = pickEvictionVictim(Object.keys(stamps), (k) => stamps[k]);

  assert.equal(victim, "big-2", "the largest holder's oldest session pays, not the bystander's");
  cleanup(Object.keys(stamps));
});

test("one parallel agent at the cap evicts only itself", () => {
  // The scenario that motivated all of this: one agent going super parallel
  // next to several modest ones. Simulate repeated evictions and assert the
  // modest agents' sessions all survive.
  const stamps = {};
  const keys = [];
  for (let i = 0; i < 20; i++) { const k = `burst-${i}`; keys.push(k); stamps[k] = i; setSessionAgent(k, "burst-agent"); }
  for (const [k, t] of [["calm-a", 1], ["calm-b", 2], ["quiet-c", 3]]) { keys.push(k); stamps[k] = t; setSessionAgent(k, k.startsWith("calm") ? "calm-agent" : "quiet-agent"); }

  const evicted = [];
  const live = new Set(keys);
  for (let n = 0; n < 10; n++) {
    const v = pickEvictionVictim(live, (k) => stamps[k]);
    evicted.push(v);
    live.delete(v);
  }

  assert.ok(evicted.every((k) => k.startsWith("burst-")),
    `all ten evictions must hit the burst agent, got: ${evicted.join(", ")}`);
  assert.ok(live.has("calm-a") && live.has("calm-b") && live.has("quiet-c"),
    "the modest agents' sessions all survive");
  cleanup(keys);
});

test("undeclared sessions compete as a pool -- staying anonymous is not a shield", () => {
  // If anonymity exempted sessions from largest-holder accounting, declaring
  // would be strictly worse than not declaring, and nobody would.
  const stamps = { "anon-1": 5, "anon-2": 6, "anon-3": 7, "named-1": 1 };
  setSessionAgent("named-1", "polite-agent");

  const victim = pickEvictionVictim(Object.keys(stamps), (k) => stamps[k]);

  assert.equal(victim, "anon-1", "the anonymous pool is the largest holder here and pays first");
  cleanup(Object.keys(stamps));
});

test("clearing a session's attribution forgets it", () => {
  setSessionAgent("gone", "someone");
  clearSessionAgent("gone");
  assert.equal(getSessionAgent("gone"), UNATTRIBUTED);
});
