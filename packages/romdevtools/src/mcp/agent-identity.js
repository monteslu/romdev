// Which AGENT owns a session.
//
// Sessions are self-declared opaque strings, and after the stateless MCP
// migration there is no connection affinity left to group them by: one agent
// opening 53 parallel sessions and ten agents opening five each look
// identical. That blindness has a concrete cost now that sessions and hosts
// are CAPPED -- a global cap means the greediest caller evicts everyone
// else's sessions, not its own.
//
// So, the same pattern as session identity one level up: an optional,
// cooperative, self-declared handle. REST callers send `x-romdev-agent`;
// modern-MCP callers put `dev.romdev/agentHandle` in `_meta`. This is
// attribution among trusted local agents, not authentication -- an agent can
// lie, and the cost of lying is only that the resource accounting blames the
// wrong name on a machine the caller already controls.
//
// What declaring buys the caller: fairness. Cap evictions target the
// largest holder first, so a parallel agent that declares itself evicts its
// OWN oldest sessions at the cap instead of a bystander's. Undeclared
// sessions pool together as one anonymous "agent" and share that pool's
// fate -- which is exactly the pre-attribution behaviour, so nothing
// regresses for callers that never send the header.

export const AGENT_HEADER = "x-romdev-agent";
export const AGENT_META_KEY = "dev.romdev/agentHandle";

/** The pool undeclared sessions share. */
export const UNATTRIBUTED = "(unattributed)";

/** @type {Map<string, string>} sessionKey → agent handle */
const agents = new Map();

/** Record who owns a session. Harmless to repeat; last declaration wins. */
export function setSessionAgent(sessionKey, agent) {
  if (typeof agent === "string" && agent.length > 0) agents.set(sessionKey, agent);
}

/** @returns {string} the owning agent, or the anonymous pool */
export function getSessionAgent(sessionKey) {
  return agents.get(sessionKey) ?? UNATTRIBUTED;
}

/** Forget a session's attribution (call when the session ends). */
export function clearSessionAgent(sessionKey) {
  agents.delete(sessionKey);
}

/**
 * Group live session keys by agent.
 * @param {Iterable<string>} sessionKeys
 * @returns {Map<string, string[]>} agent → its session keys
 */
export function groupByAgent(sessionKeys) {
  const out = new Map();
  for (const key of sessionKeys) {
    const agent = getSessionAgent(key);
    if (!out.has(agent)) out.set(agent, []);
    out.get(agent).push(key);
  }
  return out;
}

/**
 * Pick which session to evict at a cap: the oldest-idle session OF THE
 * LARGEST HOLDER. This is what turns a global cap into a fair one -- a
 * parallel agent pays its own eviction bill, and ten modest agents are not
 * taxed for one greedy one.
 *
 * @param {Iterable<string>} sessionKeys   candidates (already excludes protected ones)
 * @param {(key: string) => number} lastUsedOf  idle stamp per key (older = smaller)
 * @returns {string | null}
 */
export function pickEvictionVictim(sessionKeys, lastUsedOf) {
  const byAgent = groupByAgent(sessionKeys);
  if (byAgent.size === 0) return null;
  let holder = null;
  for (const [, keys] of byAgent) {
    if (!holder || keys.length > holder.length) holder = keys;
  }
  let victim = null;
  let oldest = Infinity;
  for (const key of holder) {
    const at = lastUsedOf(key) ?? 0;
    if (at < oldest) { oldest = at; victim = key; }
  }
  return victim;
}
