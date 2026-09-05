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
 * Optional tool ARGUMENT carrying the handle. Advertised on every tool's
 * schema in the modern era (v2-adapter.js) and resolved before dispatch
 * (server.js), never read by a handler.
 */
export const SESSION_ARG = "session";

/** Per-client id Claude Code's claude.ai-proxy transport sends. */
export const CLIENT_SESSION_HEADER = "x-mcp-client-session-id";

/**
 * The one line every result carries when the caller never NAMED its session
 * (the key came from a mint or from connection affinity). It is the only
 * surface a tool-calling agent is guaranteed to read, so it is where the
 * handle has to live.
 * @param {string} sessionKey
 */
export function sessionHandleNote(sessionKey) {
  return `session: ${sessionKey} — this emulator is keyed to your connection; pass session:"${sessionKey}" on later calls to keep it if a call ever says "No ROM loaded" (a replaced connection starts empty).`;
}

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
 *  2. the `session` TOOL ARGUMENT (`params.arguments.session` on a
 *     tools/call) -- the form an agent can actually produce from inside a
 *     tool call, and the spec's prescribed replacement for protocol sessions.
 *  3. Claude Code's `x-mcp-client-session-id` header, when its transport
 *     sends one.
 *  4. the key bound to the caller's SOCKET on an earlier request
 *     (connection affinity; server.js owns the binding).
 *  5. the TRANSPORT's id (`Mcp-Session-Id`), for legacy-era clients that do
 *     not send a handle. This branch is what 2026-07-28 removes.
 *  6. a freshly minted handle, returned to the caller so it can pin
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
 * @param {Record<string, any>} [src.args]      tools/call `arguments`, if any
 * @param {string|null} [src.socketKey]  key already bound to the caller's socket
 * @returns {{sessionKey: string, source: "handle"|"argument"|"socket"|"transport"|"minted", minted: boolean}}
 */
export function resolveSessionKey({ meta, headers, transportSessionId, args, socketKey } = {}) {
  const fromMeta = meta?.[SESSION_META_KEY];
  if (typeof fromMeta === "string" && fromMeta.length > 0) {
    return { sessionKey: fromMeta, source: "handle", minted: false };
  }

  const fromHeader = headers?.[SESSION_HEADER];
  if (typeof fromHeader === "string" && fromHeader.length > 0) {
    return { sessionKey: fromHeader, source: "handle", minted: false };
  }

  // The spec's own answer to "no protocol session": a handle passed back as
  // an ORDINARY TOOL ARGUMENT. Every tool advertises an optional `session`
  // (see v2-adapter.js); the value is resolved HERE, once, before dispatch,
  // so no handler has to know it exists. This is the one form an agent can
  // actually produce — it cannot set `_meta` or an HTTP header from a tool
  // call, which is why the two branches above were unreachable from Claude
  // Code and every request landed in a freshly minted session.
  const fromArg = args?.[SESSION_ARG];
  if (typeof fromArg === "string" && fromArg.length > 0) {
    return { sessionKey: fromArg, source: "argument", minted: false };
  }

  // Claude Code's claude.ai-proxy transport stamps a per-client id. When it
  // is present it is exactly the stable-per-process identity we want.
  const fromClientHeader = headers?.[CLIENT_SESSION_HEADER];
  if (typeof fromClientHeader === "string" && fromClientHeader.length > 0) {
    return { sessionKey: fromClientHeader, source: "handle", minted: false };
  }

  // CONNECTION AFFINITY. A stateless client that names nothing still speaks
  // over a keep-alive socket that is private to its process (measured: each
  // Claude Code process holds its own persistent connection to this server).
  // The server binds the key it minted for a socket's first request to that
  // socket, so the next request on the same connection lands in the same
  // session with zero effort from the agent. The handle is advertised back in
  // every result so the agent can pin it (`session:"..."`) if the connection
  // is ever replaced -- a new socket with no handle is a new session.
  if (typeof socketKey === "string" && socketKey.length > 0) {
    return { sessionKey: socketKey, source: "socket", minted: false };
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
