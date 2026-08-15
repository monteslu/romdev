// host/xauth.js — point XAUTHORITY at a cookie the X server will actually
// accept, before anything tries to open a GL context.
//
// Mutter/Xwayland regenerates its auth file when the compositor restarts, but a
// long-lived login session keeps exporting the path it was given at login. The
// old file is still there and still readable, so nothing looks broken -- until
// EGL reports:
//
//   Invalid MIT-MAGIC-COOKIE-1 key
//   native-gles: eglInitialize failed
//
// which reads like a GPU/driver problem and is really an auth problem. Seen on
// 2026-08-15: $XAUTHORITY pointed at an Aug 5 cookie while the server had moved
// to an Aug 13 one, so every GL cart silently lost the GPU. GL is never a
// fallback here -- a stale cookie must not be allowed to quietly downgrade it.
//
// Strategy: only act when the CURRENT setting cannot work, then pick the newest
// candidate that can. Verification is a real connection attempt, not a
// heuristic -- mtime alone would happily select a newer-but-wrong file.

import { readdirSync, statSync, accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/** Directories that hold per-session X cookies, newest-wins within each. */
function candidateDirs() {
  const dirs = [];
  if (process.env.XDG_RUNTIME_DIR) dirs.push(process.env.XDG_RUNTIME_DIR);
  dirs.push(`/run/user/${typeof process.getuid === "function" ? process.getuid() : ""}`);
  if (process.env.HOME) dirs.push(process.env.HOME);
  return [...new Set(dirs.filter(Boolean))];
}

/** Files in `dir` that look like an X authority file, newest mtime first. */
function findCookieFiles(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    // mutter's `.mutter-Xwaylandauth.XXXXXX`, GDM's `.Xauthority`, and the
    // `.Xauthority-c`/`-l` lock siblings are deliberately NOT matched.
    const isCookie =
      name.startsWith(".mutter-Xwaylandauth.") ||
      name === ".Xauthority" ||
      name.startsWith("xauth_");
    if (!isCookie) continue;
    const full = path.join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      accessSync(full, constants.R_OK);
      out.push({ path: full, mtimeMs: st.mtimeMs });
    } catch {
      /* unreadable or vanished mid-scan — not a candidate */
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Can we actually open $DISPLAY with this cookie? Uses xdpyinfo when present
 * (cheap, definitive, no GL context created). Returns null when we cannot tell
 * — the caller treats "unknown" as "don't touch anything".
 * @returns {boolean|null}
 */
function canConnect(xauthorityPath) {
  try {
    execFileSync("xdpyinfo", {
      env: { ...process.env, XAUTHORITY: xauthorityPath },
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch (e) {
    // ENOENT = xdpyinfo isn't installed: we have no oracle, so report unknown
    // rather than condemning a cookie that may be perfectly good.
    if (e && e.code === "ENOENT") return null;
    return false;
  }
}

/**
 * Resolve XAUTHORITY to a working cookie. Mutates process.env only when the
 * current value is demonstrably broken AND a demonstrably working replacement
 * exists. Safe to call on every platform; a no-op when there's no X display.
 *
 * @returns {{changed: boolean, reason: string, from?: string, to?: string}}
 */
export function resolveXauthority({ log } = {}) {
  const note = (result) => {
    if (log && result.changed) {
      log.info(
        `[xauth] $XAUTHORITY pointed at a cookie the X server rejects; using ${result.to} instead ` +
          `(GL would otherwise fail with "Invalid MIT-MAGIC-COOKIE-1 key" / eglInitialize failed).`,
      );
    } else if (log && result.reason === "no-working-candidate") {
      log.info(
        "[xauth] no usable X cookie found — GL contexts will fail. " +
          "If a compositor restarted, log out and back in, or set XAUTHORITY by hand.",
      );
    }
    return result;
  };

  if (process.platform !== "linux") return { changed: false, reason: "not-linux" };
  // No X display at all (true headless, or pure Wayland with no Xwayland):
  // nothing to authenticate against, and the banner already says so.
  if (!process.env.DISPLAY) return { changed: false, reason: "no-display" };

  const current = process.env.XAUTHORITY;
  if (current) {
    const ok = canConnect(current);
    // Working, or we have no way to judge → leave a working system alone.
    if (ok === true) return { changed: false, reason: "current-works" };
    if (ok === null) return { changed: false, reason: "cannot-verify" };
  }

  const seen = new Set(current ? [current] : []);
  for (const dir of candidateDirs()) {
    for (const cand of findCookieFiles(dir)) {
      if (seen.has(cand.path)) continue;
      seen.add(cand.path);
      if (canConnect(cand.path) === true) {
        process.env.XAUTHORITY = cand.path;
        return note({ changed: true, reason: "replaced", from: current, to: cand.path });
      }
    }
  }
  return note({
    changed: false,
    reason: current ? "no-working-candidate" : "no-candidate",
    from: current,
  });
}
