// Where a session key comes from.
//
// A `sessionKey` is the opaque string every tool handler closes over to scope
// its host, save states, playtest window and bezel (see state.js). Today it
// arrives from the transport: the MCP path uses the `Mcp-Session-Id` the SDK
// minted, the plain-HTTP path uses the caller's `x-romdev-session` header.
//
// MCP 2026-07-28 removes protocol sessions outright -- there is no
// `Mcp-Session-Id`, no initialize handshake, and no connection to hang
// identity on. The spec's prescribed replacement for cross-call state is a
// server-minted HANDLE that the caller passes back as an ordinary argument.
//
// Note what does NOT change: the host map. A `requestState`-style sealed blob
// is the right shape for conversation state, and entirely the wrong shape for
// a live emulator core -- you cannot put a WASM instance in a cookie. The core
// stays server-side under `sessionKey`; what has to change is only where the
// KEY comes from. So this module is the single seam:
//
//   explicit handle  ->  transport-provided id  ->  freshly minted handle
//
// The plain-HTTP route has always worked this way (`x-romdev-session` IS a
// caller-supplied handle), which is the existence proof that the key need not
// come from the transport at all. Introducing the indirection now, while the
// transport still supplies an id, means the stateless migration changes which
// branch fires -- not the identity model, and not any handler.
//
// See internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md (workstream B).

import { randomUUID } from "node:crypto";

/** Header the plain-HTTP tool routes have always used. */
export const SESSION_HEADER = "x-romdev-session";

/**
 * `_meta` key carrying an explicit session handle on a modern (2026-07-28)
 * request. Namespaced per the spec's `_meta` naming rules: reverse-DNS-ish
 * prefix, so it cannot collide with `io.modelcontextprotocol/*` keys.
 */
export const SESSION_META_KEY = "dev.romdev/sessionHandle";

/** Mint a fresh opaque handle. */
export function mintSessionHandle() {
  return randomUUID();
}

/**
 * Resolve the session key for one request, in priority order:
 *
 *  1. an EXPLICIT handle -- `_meta["dev.romdev/sessionHandle"]` or the
 *     `x-romdev-session` header. Caller-controlled and transport-independent,
 *     so it keeps working when protocol sessions disappear.
 *  2. the TRANSPORT's id (`Mcp-Session-Id`), for legacy-era clients that do
 *     not send a handle. This branch is what 2026-07-28 removes.
 *  3. a freshly minted handle, returned to the caller so it can pin
 *     subsequent calls to the same session.
 *
 * `minted` tells the caller whether to advertise the handle back: a client
 * that never learns the key it was assigned gets a new empty session on every
 * call, which is the single most confusing failure mode on the HTTP route
 * ("I did call loadMedia").
 *
 * @param {object} src
 * @param {Record<string, any>} [src.meta]      request `_meta`, if any
 * @param {Record<string, any>} [src.headers]   request headers, if any
 * @param {string|null} [src.transportSessionId] id the transport bound, if any
 * @returns {{sessionKey: string, source: "handle"|"transport"|"minted", minted: boolean}}
 */
export function resolveSessionKey({ meta, headers, transportSessionId } = {}) {
  const fromMeta = meta?.[SESSION_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) {
    return { sessionKey: fromMeta, source: "handle", minted: false };
  }

  const fromHeader = headers?.[SESSION_HEADER];
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return { sessionKey: fromHeader, source: "handle", minted: false };
  }

  if (typeof transportSessionId === "string" && transportSessionId.length > 0) {
    return { sessionKey: transportSessionId, source: "transport", minted: false };
  }

  return { sessionKey: mintSessionHandle(), source: "minted", minted: true };
}

/**
 * Sessions that were MINTED for a caller that supplied no handle.
 *
 * A minted key is a session the caller cannot name, so it cannot send the same
 * one twice: every request gets a brand-new empty session. `loadMedia` then
 * honestly reports `loaded:true` (it DID load, into that request's throwaway
 * session), and the very next call lands somewhere else and reports "No ROM
 * loaded" — with `catalog({op:'status'})` showing `loaded:false` alongside
 * `liveHosts:1`, because the host from the previous request really is still
 * there, just not reachable from here.
 *
 * That contradiction is the single most confusing failure on this route, and
 * it was invisible: `minted` was computed and then thrown away by every call
 * site. Remembering it lets the tools that DEPEND on session continuity say
 * what is actually wrong instead of "call loadMedia first" to someone who just
 * did. Bounded so a long-lived server cannot accumulate keys without limit.
 */
const mintedKeys = new Set();
const MINTED_KEYS_MAX = 512;

/** Record that `sessionKey` was minted (i.e. the caller sent no handle). */
export function rememberMinted(sessionKey) {
  if (typeof sessionKey !== "string" || !sessionKey) return;
  // Cheap FIFO bound: a minted key is only useful for the request that made it
  // plus the diagnosis right after, so dropping the oldest costs nothing.
  if (mintedKeys.size >= MINTED_KEYS_MAX) {
    const oldest = mintedKeys.values().next().value;
    if (oldest !== undefined) mintedKeys.delete(oldest);
  }
  mintedKeys.add(sessionKey);
}

/** Was this session minted for a caller that sent no handle? */
export function wasMinted(sessionKey) {
  return mintedKeys.has(sessionKey);
}
