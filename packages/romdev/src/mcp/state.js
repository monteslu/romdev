// Per-session LibretroHost map.
//
// Each MCP session (one McpServer instance per HTTP `mcp-session-id`) has
// its own host so two agents pointed at the same server can't clobber each
// other's loaded ROM, screenshots, memory reads, etc.
//
// Tool handlers receive a `sessionKey` (an opaque string) at register
// time — they pass it to getHost(key) / resetHost(key) / etc. The key is
// minted once per McpServer instance in registerTools(); the transport
// layer is responsible for calling clearHost(key) on session close.

import { LibretroHost } from "../host/index.js";

/** @type {Map<string, LibretroHost>} */
const hosts = new Map();

/**
 * @param {string} sessionKey
 * @returns {LibretroHost}
 */
export function getHost(sessionKey) {
  const host = hosts.get(sessionKey);
  if (!host) throw new Error("no media loaded — call loadMedia first");
  return host;
}

/** @param {string} sessionKey */
export function getHostOrNull(sessionKey) {
  return hosts.get(sessionKey) ?? null;
}

/**
 * Tear down any existing host for this session and replace it with a fresh
 * one.
 * @param {string} sessionKey
 * @returns {LibretroHost}
 */
export function resetHost(sessionKey) {
  const existing = hosts.get(sessionKey);
  if (existing && existing.status.loaded) {
    try { existing.unloadMedia(); } catch {}
  }
  const fresh = new LibretroHost();
  hosts.set(sessionKey, fresh);
  return fresh;
}

/** @param {string} sessionKey */
export function clearHost(sessionKey) {
  const existing = hosts.get(sessionKey);
  if (existing && existing.status.loaded) {
    try { existing.unloadMedia(); } catch {}
  }
  hosts.delete(sessionKey);
}

/** Test-only: number of live hosts. */
export function _liveHostCount() {
  return hosts.size;
}

// Shared reference to the per-session disclosure manager, so tool
// handlers outside index.js (toolchain.js, etc.) can call consumeHint()
// to emit session-scoped one-shot nudges (e.g. "loadCategory('show') to
// open a window for your user"). Set by registerTools().
//
// NOTE: disclosure is already per-session (one DisclosureState per
// registerTools() call → per McpServer → per session). We just store the
// most-recently-registered one for legacy callers; per-session lookup is
// not needed because disclosure objects don't share state across sessions.
let disclosure = /** @type {{ consumeHint: (key: string, msg: string) => string | null, isLoaded: (n: string) => boolean } | null} */ (null);
export function setDisclosure(d) { disclosure = d; }
export function getDisclosure() { return disclosure; }
