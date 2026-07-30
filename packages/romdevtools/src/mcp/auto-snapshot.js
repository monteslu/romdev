/*
 * auto-snapshot — an opt-in periodic save state, so an unprompted server restart
 * costs a minute instead of a session.
 *
 * v0.103.0 feedback item 2, ask (b). Ask (a) — pid/uptime in
 * catalog({op:'status'}) — lets a session DETECT that the server restarted under
 * it. This is the half that means the detection isn't just bad news: with a
 * recent snapshot on disk the recovery point is "the last minute" rather than
 * "fresh boot".
 *
 * The reported restart happened between two consecutive calls seconds apart, with
 * no version change and no idle gap. Recovery cost a full re-drive (loadMedia +
 * state load + 480-frame advance + poke + breakpoint). That was cheap only
 * BECAUSE the moment was reachable from a save state and a deterministic recipe;
 * a drive anchored on a long breakpoint run would have been expensive to lose.
 * The existing "emulator host is ephemeral" guidance covers tool-server updates,
 * which are avoidable and expected. An unprompted mid-session restart is neither.
 *
 * Design notes, since several obvious approaches are wrong here:
 *
 *   OPT-IN. Serializing state costs real time on big cores, and a frame-exact
 *   or byte-identity flow must not have unrequested work injected into it. Off
 *   unless asked for.
 *
 *   TIME-BASED, CHECKED LAZILY. No timer, no background work: the check runs
 *   when a tool call is already touching the host, and does nothing if the
 *   interval hasn't elapsed. A setInterval would fire while the process is idle
 *   (pointless — nothing changed) and could land mid-frame during someone else's
 *   deterministic run.
 *
 *   SEPARATE FILES from the user's own slots. Writes go to a session-scoped temp
 *   path, never to a name the caller chose, so an auto-snapshot can never
 *   clobber a rig someone built by hand.
 *
 *   NEVER FAILS A CALL. A snapshot problem (disk full, core mid-transition)
 *   must not break the tool the user actually asked for. Errors are recorded and
 *   surfaced in status, not thrown.
 */

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/** sessionKey -> {intervalMs, dir, lastAt, lastPath, lastBytes, writes, lastError} */
const configs = new Map();

/** Snapshots live under the OS temp dir, namespaced per session. */
function defaultDir(sessionKey) {
  const safe = String(sessionKey || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return path.join(os.tmpdir(), "romdev-autosnap", safe);
}

/**
 * Turn auto-snapshotting on (or off) for a session.
 * @param {string} sessionKey
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {number} [opts.intervalSeconds=60]
 * @param {string} [opts.dir] override the snapshot directory
 */
export function configureAutoSnapshot(sessionKey, { enabled, intervalSeconds = 60, dir } = {}) {
  if (!enabled) {
    configs.delete(sessionKey);
    return { enabled: false };
  }
  const cfg = {
    intervalMs: Math.max(5, intervalSeconds) * 1000,
    dir: dir || defaultDir(sessionKey),
    lastAt: 0, lastPath: null, lastBytes: 0, writes: 0, lastError: null,
  };
  configs.set(sessionKey, cfg);
  return { enabled: true, intervalSeconds: cfg.intervalMs / 1000, dir: cfg.dir };
}

/** Current settings + the most recent snapshot, for catalog({op:'status'}). */
export function autoSnapshotStatus(sessionKey) {
  const cfg = configs.get(sessionKey);
  if (!cfg) return null;
  return {
    enabled: true,
    intervalSeconds: cfg.intervalMs / 1000,
    dir: cfg.dir,
    writes: cfg.writes,
    ...(cfg.lastPath
      ? {
          lastSnapshotPath: cfg.lastPath,
          lastSnapshotBytes: cfg.lastBytes,
          lastSnapshotAgeSeconds: Math.round((Date.now() - cfg.lastAt) / 1000),
        }
      : { note: "armed, but nothing captured yet (no elapsed interval with a loaded ROM)" }),
    ...(cfg.lastError ? { lastError: cfg.lastError } : {}),
  };
}

/**
 * Write a snapshot if the interval has elapsed. Called from tool paths that are
 * already holding the host; a no-op when disabled, too soon, or no ROM is loaded.
 *
 * Deliberately swallows every error: this is a safety net, and a safety net that
 * breaks the call it was meant to protect is worse than none.
 *
 * @param {string} sessionKey
 * @param {object|null} host
 * @param {number} [nowMs] injectable clock, for tests
 */
export async function maybeAutoSnapshot(sessionKey, host, nowMs = Date.now()) {
  const cfg = configs.get(sessionKey);
  if (!cfg || !host) return null;
  if (!host.status?.loaded) return null;
  if (nowMs - cfg.lastAt < cfg.intervalMs) return null;

  // Claim the slot BEFORE the await, so two concurrent calls can't both decide
  // they're due and race to write the same file.
  cfg.lastAt = nowMs;
  try {
    const blob = host.serializeState();
    if (!blob || !blob.length) return null;
    await mkdir(cfg.dir, { recursive: true });
    // Two rotating files rather than one: a restart that happens DURING a write
    // would otherwise leave the only snapshot truncated.
    const slot = cfg.writes % 2;
    const out = path.join(cfg.dir, `auto-${slot}.state`);
    await writeFile(out, blob);
    cfg.writes++;
    cfg.lastPath = out;
    cfg.lastBytes = blob.length;
    cfg.lastError = null;
    return { path: out, bytes: blob.length };
  } catch (e) {
    cfg.lastError = String(e?.message ?? e);
    return null;
  }
}

/**
 * Find the newest usable auto-snapshot for a session, for recovery after a
 * restart. Prefers the larger/newer of the rotating pair, and skips a file that
 * was truncated by a restart mid-write.
 */
export async function findLatestAutoSnapshot(sessionKey, dir) {
  const base = dir || configs.get(sessionKey)?.dir || defaultDir(sessionKey);
  const found = [];
  for (const slot of [0, 1]) {
    const p = path.join(base, `auto-${slot}.state`);
    try {
      const st = await stat(p);
      if (st.size > 0) found.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
    } catch { /* missing slot */ }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { ...found[0], dir: base, ageSeconds: Math.round((Date.now() - found[0].mtimeMs) / 1000) };
}

/** Read a snapshot's bytes (the restore path hands these to unserializeState). */
export async function readAutoSnapshot(p) {
  return new Uint8Array(await readFile(p));
}

/** Test seam. */
export function _resetAutoSnapshots() {
  configs.clear();
}
