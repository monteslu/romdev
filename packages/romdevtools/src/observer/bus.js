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
