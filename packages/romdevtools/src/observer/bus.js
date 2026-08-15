// observer/bus.js — process-singleton event emitter that taps every
// MCP tool call (args, result, errors, embedded images) and ships them
// to the /livestream socket.io server.
//
// Lazy-singleton pattern: import { observer } from this module wherever
// you need to emit. Subscribers attach via observer.on('event', fn).
//
// Event shapes (always include sessionKey + ts):
//
//   {
//     type: 'call',
//     sessionKey, ts,
//     tool: 'loadMedia',
//     args: {...},
//     durationMs: 123,
//     ok: true,
//     result: {...},        // ← jsonifiable; large strings/buffers summarized
//     images: [             // ← extracted from result.content[]
//       { kind: 'screenshot', pngBase64: '...' }
//     ],
//   }
//
//   {
//     type: 'call',
//     sessionKey, ts,
//     tool: 'loadMedia',
//     args: {...},
//     durationMs: 5,
//     ok: false,
//     error: 'message',
//   }
//
//   { type: 'session_connect',    sessionKey, ts }
//   { type: 'session_disconnect', sessionKey, ts }
//
// The bus also keeps an in-memory ring buffer of the last N events
// (across all sessions) so livestream clients connecting mid-session
// get a replay of recent activity.

import { EventEmitter } from "node:events";

// Replay buffer for a newly-connected observer: "what just happened", not a
// session archive. NOTE this ring is GLOBAL, not per-session -- a busy sweep
// across many carts shares the same 50 slots.
const RING_SIZE = Number(process.env.ROMDEV_OBSERVER_RING) || 50;

// The ring is bounded in EVENTS; these bound it in BYTES. `result` goes through
// summarizeForLog, but `images` is a SIBLING field that never did -- so a ring
// full of frames was 50 full-size base64 PNGs, and the single `replay` emit on
// connect measured ~20MB against socket.io's 1MB default maxHttpBufferSize.
// Over that limit the server closes the connection, the client reconnects, and
// gets the same oversized payload again: an invisible reconnect loop whose only
// symptom was "the livestream page sometimes takes forever to render". It was
// intermittent because a ring of cheap text calls replays in a few KB.
//
// Live emits still carry full images -- only what we RETAIN is stripped. The
// client keeps just the newest image per (session, tool) anyway (latestByKind),
// so historical frames in a replay were nearly worthless to begin with.
// `??`-style resolution, NOT `||`: a deliberate 0 (keep no image payloads at
// all) must be honoured, and `|| default` silently rewrites it to the default.
function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Keep ONE full frame by default. The client shows the newest image per tool,
// so one is what a freshly-opened page can actually display; retaining 3 x
// 400KB composites still cleared 1MB, which is the limit that was breaking us.
const RING_IMAGE_KEEP = envNum("ROMDEV_OBSERVER_RING_IMAGES", 1);
const RING_MAX_BYTES = envNum("ROMDEV_OBSERVER_RING_BYTES", 8 * 1024 * 1024);

/** Rough byte cost of a retained event (base64 dominates; JSON.stringify is honest enough). */
function eventBytes(event) {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

/**
 * Replace an event's image payloads with `{omitted:true, bytes}` placeholders,
 * keeping kind/mimeType so the log line can still say a frame happened. Returns
 * the event unchanged (same reference) when it carries no image payload.
 */
function stripImagePayloads(event) {
  if (!event || !Array.isArray(event.images) || event.images.length === 0) return event;
  if (!event.images.some((img) => typeof img?.base64 === "string")) return event;
  return {
    ...event,
    images: event.images.map((img) =>
      typeof img?.base64 === "string"
        ? { kind: img.kind, mimeType: img.mimeType, omitted: true, bytes: img.base64.length }
        : img,
    ),
  };
}

class ObserverBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    /** @type {Array<object>} */
    this.ring = [];
    /** @type {Set<string>} active sessionKeys */
    this.sessions = new Set();
  }

  push(event) {
    // Retain a byte-bounded copy; emit the full-fidelity event to live clients.
    // Newest RING_IMAGE_KEEP image-bearing events keep their payload so a fresh
    // page still opens on a picture; older ones degrade to placeholders.
    this.ring.push(event);
    this.#demoteOldImages();
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.#enforceByteBudget();
    this.emit("event", event);
  }

  /** Keep payloads only on the newest RING_IMAGE_KEEP image-bearing entries. */
  #demoteOldImages() {
    let kept = 0;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const ev = this.ring[i];
      if (!Array.isArray(ev?.images) || ev.images.length === 0) continue;
      const hasPayload = ev.images.some((img) => typeof img?.base64 === "string");
      if (!hasPayload) continue;
      if (kept < RING_IMAGE_KEEP) { kept++; continue; }
      this.ring[i] = stripImagePayloads(ev);
    }
  }

  /**
   * Structural backstop: evict oldest until the ring fits RING_MAX_BYTES. Runs
   * after image demotion, so it only bites when even the retained payloads (or
   * a flood of large text results) exceed the budget.
   */
  #enforceByteBudget() {
    let total = 0;
    for (const ev of this.ring) total += eventBytes(ev);
    while (this.ring.length > 1 && total > RING_MAX_BYTES) {
      total -= eventBytes(this.ring.shift());
    }
    // A single event over budget can't be evicted away (we always keep one);
    // strip its payload so replay stays bounded no matter what.
    if (this.ring.length === 1 && total > RING_MAX_BYTES) {
      this.ring[0] = stripImagePayloads(this.ring[0]);
    }
  }

  /** Snapshot the ring (newest-last) for replay to a new subscriber. */
  replay() {
    return [...this.ring];
  }

  /** Total retained bytes — for tests and diagnostics. */
  ringBytes() {
    let total = 0;
    for (const ev of this.ring) total += eventBytes(ev);
    return total;
  }

  /** List active session keys. */
  activeSessions() {
    return [...this.sessions];
  }

  sessionConnected(sessionKey) {
    this.sessions.add(sessionKey);
    this.push({ type: "session_connect", sessionKey, ts: Date.now() });
  }

  sessionDisconnected(sessionKey) {
    this.sessions.delete(sessionKey);
    this.push({ type: "session_disconnect", sessionKey, ts: Date.now() });
    // Drop this session's frame-throttle state. Each entry can hold a `pending`
    // provider CLOSURE that captures the emulator host in order to rasterize a
    // frame later -- so a stale entry pins a whole framebuffer alive, and the
    // map itself grew one entry per (session, tool) forever.
    dropObserverFrameState(sessionKey);
  }
}

export const observer = new ObserverBus();

// ── Throttled deferred-frame emission ───────────────────────────────────────
// `call_frame` events carry a freshly-rasterized framebuffer PNG for the
// human's livestream. Tools attach a PROVIDER thunk (attachObserverFrame) and
// both transports route it here. Two guarantees:
//   1. The PNG encode NEVER runs on the agent's critical path (deferred via
//      setImmediate / the trailing timer).
//   2. Rate-limited to one frame per FRAME_MIN_INTERVAL_MS **per
//      (session, tool)** — frame({op:'step'}) called 120× in a narrowing loop
//      emits at most every 2s, but a step followed immediately by a DIFFERENT
//      tool's frame (input, state load, …) still shows: distinct tools don't
//      throttle each other. Trailing-edge: the LAST suppressed frame in a
//      burst always lands when the window reopens (rendered at fire time =
//      the current screen, which is exactly what the human wants to converge
//      on).
let FRAME_MIN_INTERVAL_MS = 2000;
// With NO livestream client connected the capture serves only the replay ring,
// but provider() still rasterizes + PNG-encodes the full composite (~120ms for
// a 1920x1080 Active Bezel scene) on the event loop -- which landed inside the
// next bezel tick and showed up as a hard stutter every 2s during playtest.
// Keep the ring warm on a lazy cadence instead; the moment a client attaches,
// the 2s cadence resumes on the next frame.
let FRAME_IDLE_INTERVAL_MS = 15000;
export function _setFrameThrottleForTest(ms) { FRAME_MIN_INTERVAL_MS = ms; }

/** @type {Map<string, {lastTs: number, timer: any, pending: null | {provider: Function, meta: object}}>} */
const _frameThrottle = new Map();
// Hard ceiling on distinct (session, tool) throttle entries.
const FRAME_STATE_MAX = Number(process.env.ROMDEV_FRAME_STATE_MAX) || 64;

function _emitFrame(provider, meta) {
  try {
    const img = provider();
    if (img) {
      observer.push({
        type: "call_frame",
        sessionKey: meta.sessionKey ?? "http",
        platform: typeof meta.resolvePlatform === "function" ? (meta.resolvePlatform() ?? meta.platform ?? null) : (meta.platform ?? null),
        ts: meta.ts ?? Date.now(),
        tool: meta.tool,
        ...(meta.caption ? { caption: meta.caption } : {}),
        images: [img],
      });
    }
  } catch { /* livestream is best-effort; never affects the agent */ }
}

/**
 * Queue a deferred framebuffer for the livestream, throttled per
 * (session, tool). `meta`: { sessionKey, tool, ts?, platform?,
 * resolvePlatform?, caption? } — resolvePlatform (a thunk) is preferred so
 * the platform label reflects post-call state (loadMedia sets it DURING the
 * call). `provider` returns {kind:'image', mimeType, base64} or null; it is
 * invoked OFF the agent's critical path.
 */
/** Forget frame-throttle state for a session (all of its tools). */
export function dropObserverFrameState(sessionKey) {
  const prefix = `${sessionKey ?? "http"}|`;
  for (const [key, st] of _frameThrottle) {
    if (!key.startsWith(prefix)) continue;
    if (st.timer) { try { clearTimeout(st.timer); } catch {} }
    st.pending = null;                 // release the captured provider closure
    _frameThrottle.delete(key);
  }
}

export function pushObserverFrame(meta, provider) {
  const key = `${meta.sessionKey ?? "http"}|${meta.tool ?? "?"}`;
  let st = _frameThrottle.get(key);
  if (!st) {
    // Backstop for sessions that vanish without a clean disconnect: evict the
    // coldest entries rather than let the map grow without bound.
    if (_frameThrottle.size >= FRAME_STATE_MAX) {
      const stale = [..._frameThrottle.entries()]
        .sort((a, b) => a[1].lastTs - b[1].lastTs)
        .slice(0, Math.ceil(FRAME_STATE_MAX / 4));
      for (const [k, v] of stale) {
        if (v.timer) { try { clearTimeout(v.timer); } catch {} }
        v.pending = null;
        _frameThrottle.delete(k);
      }
    }
    st = { lastTs: 0, timer: null, pending: null };
    _frameThrottle.set(key, st);
  }
  const now = Date.now();
  const interval = observer.listenerCount("event") === 0
    ? FRAME_IDLE_INTERVAL_MS : FRAME_MIN_INTERVAL_MS;
  if (!st.timer && now - st.lastTs >= interval) {
    st.lastTs = now;
    setImmediate(() => _emitFrame(provider, meta));
    return;
  }
  // Inside the window: stash as the pending trailing frame (latest wins) and
  // arm the trailing timer once.
  st.pending = { provider, meta };
  if (!st.timer) {
    const delay = Math.max(1, st.lastTs + interval - now);
    st.timer = setTimeout(() => {
      st.timer = null;
      const p = st.pending;
      st.pending = null;
      if (p) {
        st.lastTs = Date.now();
        _emitFrame(p.provider, p.meta);
      }
    }, delay);
    if (st.timer.unref) st.timer.unref();   // never hold the process open
  }
}

/**
 * Extract image payloads from an MCP tool result. MCP tool results have
 * `content: [{type:'text'|'image', ...}]`. We pull out images so the UI
 * can display them inline without parsing the full result.
 */
export function extractImages(result) {
  if (!result || !Array.isArray(result.content)) return [];
  const out = [];
  for (const c of result.content) {
    if (c && c.type === "image" && typeof c.data === "string") {
      out.push({
        kind: "image",
        mimeType: c.mimeType || "image/png",
        base64: c.data,
      });
    }
  }
  return out;
}

/**
 * Truncate long string property values inside a JSON-shaped result so the
 * livestream log doesn't drown in 200 KB binary base64. Top-level
 * property names always preserved. Strings >threshold are replaced
 * with `<${size}B str>` placeholders. Recurses one level into objects;
 * doesn't recurse into arrays of objects (keeps it fast).
 */
export function summarizeForLog(value, threshold = 200) {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > threshold ? `<${value.length}B str>` : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) return `[<${value.length} items>]`;
    return value.map((v) => summarizeForLog(v, threshold));
  }
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = summarizeForLog(value[k], threshold);
    }
    return out;
  }
  return value;
}
