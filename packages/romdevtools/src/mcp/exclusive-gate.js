// Server-wide exclusive section for timing runs.
//
// Every session's tools run on one Node thread, and a WebGPU host yields to
// the event loop between frames, so on a shared server one session's frame
// times include whatever other sessions' calls ran in between (other carts'
// frames, GL bursts, builds). A timing run holds this gate: while it does,
// tool calls from OTHER sessions wait before they start (catalog stays open,
// so a status check or a restart guard still answers), and the run first
// waits for the calls already in flight to finish. Timing runs from two
// sessions therefore never overlap; the second waits for the first.
//
// What the gate cannot stop is reported by the run instead of hidden: a
// playtest window (a human) keeps its own timer, a call still in flight after
// the drain timeout keeps running, and other processes keep the GPU.
//
// Plain JS ESM + JSDoc.

/** tools that never wait (status checks must answer during a timing run) */
const NEVER_WAIT = new Set(["catalog"]);

/** @type {null | {session: string, since: number, held: number, release: Promise<void>, done: () => void}} */
let holder = null;
/** @type {Map<string, number>} in-flight tool calls per session */
const inflight = new Map();
/** @type {Array<() => void>} wake-ups for drain waiters */
let drainWaiters = [];

function wakeDrain() {
  const w = drainWaiters; drainWaiters = [];
  for (const f of w) f();
}

/**
 * Called at the start of every tool call. Waits while another session holds
 * the gate, then counts the call in flight. Returns the function to call when
 * the call ends.
 * @param {string} sessionKey
 * @param {string} tool
 * @returns {Promise<() => void>}
 */
export async function enterCall(sessionKey, tool) {
  if (!NEVER_WAIT.has(tool)) {
    while (holder && holder.session !== sessionKey) {
      holder.held++;
      await holder.release;
    }
  }
  inflight.set(sessionKey, (inflight.get(sessionKey) || 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const n = (inflight.get(sessionKey) || 1) - 1;
    if (n <= 0) inflight.delete(sessionKey); else inflight.set(sessionKey, n);
    wakeDrain();
  };
}

/** In-flight calls of sessions other than `sessionKey`. */
export function othersInflight(sessionKey) {
  let n = 0;
  for (const [k, v] of inflight) if (k !== sessionKey) n += v;
  return n;
}

/**
 * Take the gate for `sessionKey`: wait for another holder to finish, then for
 * other sessions' in-flight calls to drain (up to drainMs). Returns
 * {release(), waitedMs, drainMs, stillInflight, heldCalls()}.
 * @param {string} sessionKey
 * @param {{drainMs?: number}} [opts]
 */
export async function acquireExclusive(sessionKey, { drainMs = 10000 } = {}) {
  const t0 = Date.now();
  while (holder && holder.session !== sessionKey) await holder.release;
  let done;
  const release = new Promise((r) => { done = r; });
  const me = { session: sessionKey, since: Date.now(), held: 0, release, done };
  holder = me;
  const waitedMs = Date.now() - t0;
  const d0 = Date.now();
  while (othersInflight(sessionKey) > 0 && Date.now() - d0 < drainMs) {
    await new Promise((r) => {
      drainWaiters.push(r);
      setTimeout(r, Math.max(1, drainMs - (Date.now() - d0)));
    });
  }
  return {
    waitedMs,
    drainMs: Date.now() - d0,
    stillInflight: othersInflight(sessionKey),
    heldCalls: () => me.held,
    release() {
      if (holder === me) holder = null;
      me.done();
    },
  };
}

/** Who holds the gate, for catalog status. */
export function exclusiveStatus() {
  return holder ? { session: holder.session, sinceMs: Date.now() - holder.since, callsWaiting: holder.held } : null;
}
