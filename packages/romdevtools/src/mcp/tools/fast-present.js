// Reload a GL cart onto its own GL context, carrying its save data across.
//
// WHY THIS EXISTS. A wasmcart GL cart loaded the ordinary way shares the ONE
// process-wide offscreen GL context, and that context can never be bound to a
// window -- attaching it would drag every other session's cart into that
// window (see WasmcartHost.canAttachWindow). So such a cart presents by
// dragging every frame back to the CPU: ~5.4 ms of a 16.7 ms budget at 1080p,
// measured 27.9/45.1/54.9 ms per frame across three carts versus
// 3.4/6.1/9.1 GL-direct. The worst case is a human playing at 41 fps.
//
// The fix is `loadMedia({presentWindow:true})`, which gives the cart a PRIVATE
// context. It must be decided at load time, because the context binds when the
// cart's wasm loads and cannot be swapped afterward. So a cart already loaded
// the ordinary way can only get there by reloading.
//
// `playtest({op:'open'})` is the one call in the system that knows a human is
// about to watch, and before this it could only detect the slow path and warn
// -- leaving every caller to re-derive the same save/reload/restore dance by
// hand. (Field report: internal-romdev/feedback/2026-08-20_playtest-open-
// cannot-fix-the-readback-path-it-detects.md.) This is that dance, once.
//
// It is OPT-IN (`fastPresent:true`) rather than automatic, for two reasons
// that both come from the constraints above:
//
//   1. A reload RESTARTS THE CART. That is safe at open time, before anyone is
//      playing, and never safe on a reused window that may have a human
//      mid-game. The caller enforces that; this helper just does the work.
//   2. It costs one extra GL context per loaded cart. Right for a human
//      window, wrong as a default for headless gate work, where the readback
//      is exactly what you want.

import { getHostOrNull } from "../state.js";

// The lifecycle loader, registered per session so this module can reload a
// cart without importing lifecycle.js (which would be circular: lifecycle
// registers tools, playtest calls this, and doLoadMedia is closure-scoped
// over its own sessionKey anyway).
/** @type {Map<string, (opts: object) => Promise<any>>} */
const loaders = new Map();

/** Called by registerLifecycleTools so other tools can reload media. */
export function registerMediaLoader(sessionKey, fn) {
  loaders.set(sessionKey, fn);
}

/** @param {string} sessionKey */
export function getMediaLoader(sessionKey) {
  return loaders.get(sessionKey) ?? null;
}

/**
 * Reload the session's currently-loaded wasmcart onto a private GL context so
 * a window can present it by GPU blit + swap.
 *
 * Save data is carried across when the cart has any: a reload restarts the
 * cart, and losing a player's progress to a performance optimisation would be
 * a worse bug than the slow present it fixes.
 *
 * Never throws: this runs inside `playtest({op:'open'})`, where failing to
 * make a window FASTER must never fail to open the window at all. On any
 * problem the original cart is left loaded and the caller keeps the readback
 * path it already had.
 *
 * @param {string} sessionKey
 * @returns {Promise<{ok: boolean, reason?: string, savedBytes?: number}>}
 */
export async function reloadForFastPresent(sessionKey) {
  const host = getHostOrNull(sessionKey);
  if (!host) return { ok: false, reason: "no host loaded" };

  const loadMedia = getMediaLoader(sessionKey);
  if (!loadMedia) return { ok: false, reason: "no media loader registered for this session" };

  const path = host.status?.mediaPath;
  const platform = host.status?.platform;
  if (!path || typeof path !== "string" || path.startsWith("<")) {
    // A base64/in-memory load has no path to reload FROM. The bytes are not
    // retained anywhere we can reach, so this is a real limitation rather
    // than something to work around.
    return { ok: false, reason: "cart was not loaded from a file path (base64/in-memory), so it cannot be reloaded" };
  }

  // Carry the save across. wasmcart exposes SRAM directly (getSaveData /
  // setSaveData); there is no CPU state to snapshot, which is why this is the
  // persistence primitive rather than state({op:'save'}).
  let saved = null;
  try {
    if (typeof host.getSaveData === "function") {
      const data = host.getSaveData();
      if (data && data.length) saved = Uint8Array.from(data);
    }
  } catch { /* no save data is fine; a fresh cart has none */ }

  try {
    await loadMedia({ platform, path, presentWindow: true });
  } catch (e) {
    return { ok: false, reason: `reload failed: ${e?.message ?? e}` };
  }

  const fresh = getHostOrNull(sessionKey);
  if (!fresh) return { ok: false, reason: "reload produced no host" };
  if (typeof fresh.canAttachWindow === "function" && !fresh.canAttachWindow()) {
    // The reload succeeded but did not yield an attachable context. Report it
    // rather than claim a speed-up the window will not get.
    return { ok: false, reason: "reloaded cart still cannot bind a window (not a GL cart?)" };
  }

  if (saved) {
    try {
      if (typeof fresh.setSaveData === "function") fresh.setSaveData(saved);
    } catch (e) {
      // The cart is loaded and fast; the save did not make it. Say so loudly
      // in the result -- silently losing progress is the one outcome worse
      // than a slow window.
      return { ok: true, savedBytes: 0, reason: `save data could NOT be restored: ${e?.message ?? e}` };
    }
  }

  return { ok: true, savedBytes: saved ? saved.length : 0 };
}
