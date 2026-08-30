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
import { pickEvictionVictim, clearSessionAgent } from "./agent-identity.js";
import { wasMinted } from "./session-key.js";

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
export function playtestCheckpointPath(sessionKey, mediaPath, kind = "state") {
  // THE EXTENSION HAS TO MATCH THE CONTENT. A libretro checkpoint is a
  // whole-machine savestate restored with state({op:'load', path}); a
  // wasmcart checkpoint is the cart's SRAM, restored with
  // state({op:'importSram', path}) -- and feeding one to the other's tool
  // fails. Naming both ".state" invited exactly that mistake, so the SRAM
  // flavour is spelled ".sav", which is what every other SRAM file here is.
  const ext = kind === "sram" ? "sav" : "state";
  const safeSession = String(sessionKey).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  if (mediaPath && !mediaPath.startsWith("<") && path.isAbsolute(mediaPath)) {
    const dir = path.dirname(mediaPath);
    const base = path.basename(mediaPath, path.extname(mediaPath));
    return path.join(dir, `${base}.playtest-autosave.${ext}`);
  }
  return path.join(os.tmpdir(), `romdev-playtest-${safeSession}.autosave.${ext}`);
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
      // Check BOTH checkpoint flavours: a libretro core rolls a whole-machine
      // `.state`, a wasmcart rolls its SRAM as `.sav`, and each is restored by
      // a DIFFERENT tool. Looking only for `.state` (as this did) silently
      // missed every wasmcart checkpoint and told the human to replay from
      // boot with their save sitting right there on disk.
      const ckptState = playtestCheckpointPath(sessionKey, prev.path ?? null, "state");
      const ckptSram = playtestCheckpointPath(sessionKey, prev.path ?? null, "sram");
      const ckpt = existsSync(ckptState) ? ckptState : (existsSync(ckptSram) ? ckptSram : null);
      const ckptHint = ckpt
        ? `\nA playtest auto-checkpoint is on disk (your last ~15s of play): after the load above, run\n  state({ op: "${ckpt === ckptSram ? "importSram" : "load"}", path: "${ckpt}" })\nto restore the human's progress instead of replaying from boot.`
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
    // A MINTED session is the one case where "call loadMedia first" is actively
    // wrong advice: the caller may have called it, successfully, one request
    // ago -- into a session it was never told the name of, so this request is a
    // different one. Say that plainly and give the fix, instead of sending an
    // agent round the loop of retrying a load that will keep "working".
    if (wasMinted(sessionKey)) {
      throw new Error(
        "No ROM loaded in this session — and this session was AUTO-MINTED because " +
        "your request carried no session handle, so EVERY request of yours lands in " +
        "a brand-new empty session. That is why loadMedia can report `loaded:true` " +
        "and the very next call still says no ROM (and why catalog({op:'status'}) " +
        "can show `loaded:false` next to `liveHosts:1` — the host from your previous " +
        "request is alive, just not reachable from this one).\n" +
        "FIX: pick ONE stable, descriptive id and send it on EVERY call — as the " +
        "`x-romdev-session` header over plain HTTP, or as `_meta[\"dev.romdev/sessionHandle\"]` " +
        "on an MCP request. Then re-run loadMedia({path}) once and your ROM will stay put.",
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
  touchHost(sessionKey);
  return host;
}

/** @param {string} sessionKey */
export function getHostOrNull(sessionKey) {
  const host = hosts.get(sessionKey) ?? null;
  if (host) touchHost(sessionKey);
  return host;
}

// --- Host lifetime ----------------------------------------------------------
// The server owns how much emulator memory it holds, independent of transport
// behaviour. Two reasons this cannot live on the transport:
//
//  1. It didn't work. Every gate script is its own MCP session, so a 21-gate
//     suite mints 21+ hosts in 12 minutes; the transport-idle reaper
//     (SESSION_IDLE_MS, 30 min) never fired during the run, and scripts that
//     just exit never close their transport at all. Two kernel OOM kills on
//     2026-08-19, ~5.4 GB RSS each, one agent.
//  2. It is about to be impossible. MCP 2026-07-28 removes protocol sessions
//     entirely — there is no connection close to hang eviction on. See
//     internal-romdev/PLAN_mcp_v2_stateless_and_host_lifetime.md.
//
// So: stamp every host access, evict on host inactivity, and cap the total.
// An evicted session self-heals — `lastMedia` survives eviction and getHost
// tells the agent exactly which loadMedia to re-run.

/** @type {Map<string, number>} */
const lastUsed = new Map();

/** How long a host may sit unused before eviction, regardless of its transport. */
const HOST_IDLE_MS = Number(process.env.ROMDEV_HOST_IDLE_MS ?? 10 * 60 * 1000);
/** Hard ceiling on live hosts; at the cap the oldest-idle evictable host goes. */
const MAX_HOSTS = Number(process.env.ROMDEV_MAX_HOSTS ?? 10);

/** @type {(sessionKey: string) => boolean} */
let isProtected = () => false;

/**
 * Install the predicate that marks a session un-evictable. A playtest window
 * means a HUMAN may be mid-game: the autoCheckpoint saves the cart, never the
 * window, and an agent that loses someone's window cannot reopen it.
 * Wired by the server so state.js keeps no dependency on the playtest module.
 * @param {(sessionKey: string) => boolean} fn
 */
export function setHostProtectedPredicate(fn) {
  if (typeof fn === "function") isProtected = fn;
}

/**
 * Is this session un-evictable right now (i.e. does it have a live playtest
 * window with a human in it)?
 *
 * Exported because the HTTP layer has its OWN session reaper and its own
 * cap-eviction, and both call clearHost() -- which tears down the emulator.
 * They were doing it with no protection check at all, so a human playing for
 * 30 minutes without the agent making a single tool call had the host
 * destroyed out from under their live window: the window stayed up presenting
 * a frozen frame with liveHosts:0 behind it. (Measured 2026-08-21: a 32.6
 * minute Formix session against the 30 minute HTTP idleMs.)
 *
 * Read accessor rather than exporting `isProtected` itself, so routes.js can
 * ask the question without importing the playtest module -- keeping the
 * dependency direction setHostProtectedPredicate exists to preserve.
 */
export function isHostProtected(sessionKey) {
  try { return isProtected(sessionKey); } catch { return false; }
}

/** @param {string} sessionKey */
function touchHost(sessionKey) {
  lastUsed.set(sessionKey, Date.now());
}

/** Evict one session's hosts (both slots) without touching lastMedia. */
function evictHost(sessionKey) {
  teardownHost(hosts.get(sessionKey));
  hosts.delete(sessionKey);
  teardownHost(hostsB.get(sessionKey));
  hostsB.delete(sessionKey);
  lastUsed.delete(sessionKey);
  clearSessionAgent(sessionKey);
}

/**
 * Evict hosts idle past HOST_IDLE_MS. Returns the keys evicted so the caller
 * can log them. Protected (playtest) sessions are never evicted by age.
 * @returns {string[]}
 */
export function reapIdleHosts(now = Date.now()) {
  const evicted = [];
  for (const key of [...hosts.keys()]) {
    if (isProtected(key)) continue;
    const seen = lastUsed.get(key);
    if (seen === undefined) { lastUsed.set(key, now); continue; } // give it one window
    if (now - seen > HOST_IDLE_MS) { evictHost(key); evicted.push(key); }
  }
  return evicted;
}

/**
 * Make room before creating a host: while at the cap, evict the oldest-idle
 * evictable session. Never refuses to create — a refusal would surface as a
 * mysterious tool failure, while an eviction self-heals via loadMedia.
 * @param {string} incomingKey the session about to get a host (never evicted)
 * @returns {string[]} keys evicted
 */
function enforceHostCap(incomingKey) {
  const evicted = [];
  while (hosts.size >= MAX_HOSTS) {
    // Fair eviction: oldest-idle host OF THE LARGEST HOLDER (see
    // agent-identity.js). A parallel agent at the cap pays its own eviction
    // bill; ten modest agents are not taxed for one greedy one. Undeclared
    // sessions pool as one anonymous holder -- the pre-attribution behaviour.
    const candidates = [...hosts.keys()].filter((k) => k !== incomingKey && !isProtected(k));
    const victim = pickEvictionVictim(candidates, (k) => lastUsed.get(k) ?? 0);
    if (!victim) break; // everything left is protected or is us
    evictHost(victim);
    evicted.push(victim);
  }
  return evicted;
}

/**
 * A read-only glance at a session, for the new-session reminder: what it
 * holds and how stale it is. Deliberately does NOT touch the activity stamp
 * -- this is used to describe an agent's OTHER sessions, and describing a
 * session must not reset its idle clock (that would make every reminder
 * immortalize the sessions it mentions).
 * @param {string} sessionKey
 */
export function peekSession(sessionKey) {
  const host = hosts.get(sessionKey);
  const lm = lastMedia.get(sessionKey);
  const seen = lastUsed.get(sessionKey);
  return {
    hostLive: !!host,
    loaded: !!host?.status?.loaded,
    platform: host?.status?.platform ?? lm?.platform,
    path: host?.status?.mediaPath ?? lm?.path,
    idleSeconds: seen === undefined ? null : Math.round((Date.now() - seen) / 1000),
  };
}

/** Live host counts + config, for catalog({op:'status'}). */
export function hostLifetimeStats() {
  return {
    liveHosts: hosts.size,
    liveHostsSlotB: hostsB.size,
    maxHosts: MAX_HOSTS,
    hostIdleMs: HOST_IDLE_MS,
  };
}

/**
 * Tear down any existing host for this session and replace it with a fresh
 * one.
 * @param {string} sessionKey
 * @returns {LibretroHost}
 */
export function resetHost(sessionKey) {
  teardownHost(hosts.get(sessionKey));
  hosts.delete(sessionKey);
  enforceHostCap(sessionKey);
  const fresh = new LibretroHost();
  hosts.set(sessionKey, fresh);
  touchHost(sessionKey);
  return fresh;
}

/** Tear down whatever host kind is present (LibretroHost.unloadMedia or a native
 *  host's destroy) — WasmcartHost/JsGameHost don't have unloadMedia. */
function teardownHost(existing) {
  if (!existing) return;
  try {
    // LibretroHost.dispose() releases the CORE (and its WASM linear memory),
    // not just the ROM. unloadMedia() alone leaves the Emscripten module
    // resident, so a discarded host kept its whole heap forever — the
    // mechanism behind the 2026-08-19 OOM kills. Prefer dispose when the host
    // kind offers it; fall back for older/other host kinds.
    if (typeof existing.dispose === "function") {
      existing.dispose();
    } else if (typeof existing.destroy === "function") {
      existing.destroy();
    } else if (typeof existing.unloadMedia === "function" && existing.status?.loaded) {
      existing.unloadMedia();
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
/**
 * Tear down this session's current host and forget it, WITHOUT installing a
 * replacement. Use before building a new host whose construction touches
 * shared process state -- a GL cart creates (and may window-attach) its GL
 * context during loadMedia, so the outgoing context must be gone first or the
 * two overlap and the incoming cart's FBOs validate against a live, possibly
 * window-attached context. installHost() tears down too, but only AFTER the
 * new host has finished loading, which is too late for that case.
 *
 * Safe to call when there is no host. Never throws.
 * @param {string} sessionKey
 */
export function disposeHost(sessionKey) {
  const existing = hosts.get(sessionKey);
  if (!existing) return;
  hosts.delete(sessionKey);
  lastUsed.delete(sessionKey);
  teardownHost(existing);
}

export function installHost(sessionKey, hostInstance) {
  teardownHost(hosts.get(sessionKey));
  hosts.delete(sessionKey);
  enforceHostCap(sessionKey);
  hosts.set(sessionKey, hostInstance);
  touchHost(sessionKey);
  return hostInstance;
}

/** @param {string} sessionKey */
export function clearHost(sessionKey) {
  const existing = hosts.get(sessionKey);
  // Full teardown, not just unloadMedia: this is a session ending, so the core
  // and its WASM heap must go, not merely the ROM.
  teardownHost(existing);
  hosts.delete(sessionKey);
  lastUsed.delete(sessionKey);
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
  // Slot B shares the session's activity stamp: a session comparing two ROMs
  // is active even if every call in the last ten minutes touched only slot B.
  // Without this the reaper would evict BOTH slots (evictHost clears the
  // pair) out from under a live side-by-side comparison.
  touchHost(sessionKey);
  return host;
}

/** @param {string} sessionKey */
export function getHostBOrNull(sessionKey) {
  const host = hostsB.get(sessionKey) ?? null;
  if (host) touchHost(sessionKey);
  return host;
}

/** @param {string} sessionKey @returns {LibretroHost} */
export function resetHostB(sessionKey) {
  // Full teardown, same as slot A: unloadMedia() alone keeps the core and its
  // WASM heap, which is the leak this whole module exists to close. Slot B is
  // a SECOND live core, so it is the more expensive one to leave behind.
  teardownHost(hostsB.get(sessionKey));
  hostsB.delete(sessionKey);
  const fresh = new LibretroHost();
  hostsB.set(sessionKey, fresh);
  touchHost(sessionKey);
  return fresh;
}

/** @param {string} sessionKey */
export function clearHostB(sessionKey) {
  teardownHost(hostsB.get(sessionKey));
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
