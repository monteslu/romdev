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

const RING_SIZE = 200;

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
    this.ring.push(event);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.emit("event", event);
  }

  /** Snapshot the ring (newest-last) for replay to a new subscriber. */
  replay() {
    return [...this.ring];
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
export function _setFrameThrottleForTest(ms) { FRAME_MIN_INTERVAL_MS = ms; }

/** @type {Map<string, {lastTs: number, timer: any, pending: null | {provider: Function, meta: object}}>} */
const _frameThrottle = new Map();

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
export function pushObserverFrame(meta, provider) {
  const key = `${meta.sessionKey ?? "http"}|${meta.tool ?? "?"}`;
  let st = _frameThrottle.get(key);
  if (!st) { st = { lastTs: 0, timer: null, pending: null }; _frameThrottle.set(key, st); }
  const now = Date.now();
  if (!st.timer && now - st.lastTs >= FRAME_MIN_INTERVAL_MS) {
    st.lastTs = now;
    setImmediate(() => _emitFrame(provider, meta));
    return;
  }
  // Inside the window: stash as the pending trailing frame (latest wins) and
  // arm the trailing timer once.
  st.pending = { provider, meta };
  if (!st.timer) {
    const delay = Math.max(1, st.lastTs + FRAME_MIN_INTERVAL_MS - now);
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
