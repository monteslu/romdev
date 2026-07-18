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

import { LibretroHost } from "romdev-core-host/index.js";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";

/** @type {Map<string, LibretroHost>} */
const hosts = new Map();

/**
 * Disk path for a playtest session's rolling auto-checkpoint (eviction
 * survivability). Deterministic per (session, rom) so the eviction-recovery hint
 * can name it WITHOUT any bookkeeping. Next to the ROM when it's a real on-disk
 * file; else a stable per-session file under the OS temp dir. (v0.41.0 feedback
 * note 125904.) Shared by the playtest tool (writer) and getHost (recovery hint).
 * @param {string} sessionKey
 * @param {string|null} mediaPath
 */
export function playtestCheckpointPath(sessionKey, mediaPath) {
  const safeSession = String(sessionKey).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  if (mediaPath && !mediaPath.startsWith("<") && path.isAbsolute(mediaPath)) {
    const dir = path.dirname(mediaPath);
    const base = path.basename(mediaPath, path.extname(mediaPath));
    return path.join(dir, `${base}.playtest-autosave.state`);
  }
  return path.join(os.tmpdir(), `romdev-playtest-${safeSession}.autosave.state`);
}

// Secondary host slot ("B") per session. The primary slot above is what every
// tool uses by default; slot B exists for the ONE workflow that needs two cores
// live at once: side-by-side comparison (e.g. an original ROM vs. its port).
// loadMedia({slot:'b'}) loads here; frame({op:'sideBySide'}) captures both. It
// is entirely opt-in — a session that never loads slot B pays nothing, and the
// per-session teardown below clears both slots together.
/** @type {Map<string, LibretroHost>} */
const hostsB = new Map();

// What this session last loaded, kept OUTSIDE the host map so it SURVIVES a
// host eviction (server restart / session reconnect / unload). The host itself
// is gone in those cases, so the "No ROM loaded" error has nothing to read —
// this is the breadcrumb that lets the error tell the agent exactly how to
// recover ("you last loaded <X>; re-run loadMedia to pick back up") instead of
// a generic wipe. Set by loadMedia on success; never cleared on eviction.
/** @type {Map<string, {platform?: string, path?: string, fromBase64?: boolean}>} */
const lastMedia = new Map();

/** Record the media a session last loaded (for recovery hints). @param {string} sessionKey */
export function rememberLastMedia(sessionKey, info) {
  lastMedia.set(sessionKey, info);
}
/** @param {string} sessionKey */
export function getLastMedia(sessionKey) {
  return lastMedia.get(sessionKey) ?? null;
}

/**
 * @param {string} sessionKey
 * @returns {LibretroHost}
 */
export function getHost(sessionKey) {
  const host = hosts.get(sessionKey);
  if (!host) {
    // If THIS session loaded media before, the host was evicted (restart /
    // reconnect / unload) — lead with the exact recovery call instead of the
    // generic "you're in the wrong session" guidance, which doesn't apply here.
    const prev = lastMedia.get(sessionKey);
    if (prev && (prev.path || prev.fromBase64)) {
      const recall = prev.path
        ? `loadMedia({ platform: "${prev.platform}", path: "${prev.path}" })`
        : `loadMedia({ platform: "${prev.platform}", base64: ... })  (your ROM came from base64 — re-supply the bytes)`;
      // If a playtest window was open, a rolling auto-checkpoint may be on disk —
      // restoring it recovers the human's MANUAL progress, not just a fresh boot.
      const ckpt = playtestCheckpointPath(sessionKey, prev.path ?? null);
      const ckptHint = existsSync(ckpt)
        ? `\nA playtest auto-checkpoint is on disk (your last ~15s of play): after the load above, run\n  state({ op: "load", path: "${ckpt}" })\nto restore the human's progress instead of replaying from boot.`
        : "";
      throw new Error(
        "No ROM loaded in this session — the host was evicted (the server restarted, " +
        "your session reconnected, or the media was unloaded). Emulator state lives in " +
        "server memory only, so it did not survive. RECOVER by re-running your last load:\n  " +
        recall +
        ckptHint +
        "\nThen replay any boot/navigate steps to get back to where you were. " +
        "(If instead you expected a DIFFERENT session, you may be sending an inconsistent " +
        "`x-romdev-session` header — reuse one stable id on every call.)",
      );
    }
    throw new Error(
      "No ROM loaded in this session — call loadMedia({path}) first. " +
      "If you DID loadMedia and still see this, your calls are landing in DIFFERENT " +
      "sessions: over plain HTTP/skill you must send the SAME `x-romdev-session` " +
      "header on every call (pick one stable id and reuse it) — a new/missing id is " +
      "a fresh empty session each time. " +
      "If you WERE mid-session and just got reconnected (the server restarted or " +
      "your session expired): emulator state is held in server memory only, so it " +
      "did not survive — re-run loadMedia({path}) with your ROM (still on disk) to " +
      "pick back up. A fresh boot is the recovery point.",
    );
  }
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
  teardownHost(hosts.get(sessionKey));
  const fresh = new LibretroHost();
  hosts.set(sessionKey, fresh);
  return fresh;
}

/** Tear down whatever host kind is present (LibretroHost.unloadMedia or a native
 *  host's destroy) — WasmcartHost/JsGameHost don't have unloadMedia. */
function teardownHost(existing) {
  if (!existing) return;
  try {
    if (typeof existing.unloadMedia === "function" && existing.status?.loaded) {
      existing.unloadMedia();
    } else if (typeof existing.destroy === "function") {
      existing.destroy();
    }
  } catch { /* ignore teardown errors */ }
}

/**
 * Install an already-constructed host (a native-runtime kind: WasmcartHost /
 * JsGameHost) as this session's active host, tearing down any previous one.
 * Emulator platforms use resetHost + loadCore; native runtimes build their own
 * host and hand it here.
 * @param {string} sessionKey
 * @param {object} hostInstance
 */
export function installHost(sessionKey, hostInstance) {
  teardownHost(hosts.get(sessionKey));
  hosts.set(sessionKey, hostInstance);
  return hostInstance;
}

/** @param {string} sessionKey */
export function clearHost(sessionKey) {
  const existing = hosts.get(sessionKey);
  if (existing && existing.status.loaded) {
    try { existing.unloadMedia(); } catch {}
  }
  hosts.delete(sessionKey);
  // A session shutdown tears down BOTH slots — slot B is part of the same
  // session's footprint and must not outlive it.
  clearHostB(sessionKey);
}

// --- Secondary host slot ("B") ----------------------------------------------
// Same lifecycle helpers as the primary, scoped to the hostsB map. getHostB
// throws a slot-specific error (no recovery breadcrumb — slot B is transient
// scratch for a comparison, not the session's main ROM).

/** @param {string} sessionKey @returns {LibretroHost} */
export function getHostB(sessionKey) {
  const host = hostsB.get(sessionKey);
  if (!host) {
    throw new Error(
      "No ROM loaded in comparison slot B for this session — load one with " +
      "loadMedia({ slot: 'b', platform, path }). Slot B is the second core used " +
      "by frame({op:'sideBySide'}); it is not the session's primary ROM.",
    );
  }
  return host;
}

/** @param {string} sessionKey */
export function getHostBOrNull(sessionKey) {
  return hostsB.get(sessionKey) ?? null;
}

/** @param {string} sessionKey @returns {LibretroHost} */
export function resetHostB(sessionKey) {
  const existing = hostsB.get(sessionKey);
  if (existing && existing.status.loaded) {
    try { existing.unloadMedia(); } catch {}
  }
  const fresh = new LibretroHost();
  hostsB.set(sessionKey, fresh);
  return fresh;
}

/** @param {string} sessionKey */
export function clearHostB(sessionKey) {
  const existing = hostsB.get(sessionKey);
  if (existing && existing.status.loaded) {
    try { existing.unloadMedia(); } catch {}
  }
  hostsB.delete(sessionKey);
}

/** Test-only: number of live hosts (both slots). */
export function _liveHostCount() {
  return hosts.size + hostsB.size;
}

/** Test-only: inject a (possibly fake) host for a session key. */
export function _setHostForTest(sessionKey, host) {
  hosts.set(sessionKey, host);
}

/** Test-only: inject a (possibly fake) host into comparison slot B. */
export function _setHostBForTest(sessionKey, host) {
  hostsB.set(sessionKey, host);
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
