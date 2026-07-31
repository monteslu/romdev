/*
 * active-bezel.js — session-scoped Active Bezel state for romdev.
 *
 * An Active Bezel is an executable companion to a specific ROM: it runs once per
 * emulated frame, reads the core's live memory regions, and renders the complete
 * final scene. The runtime itself lives in the `active-bezel` package, shared
 * with retroemu, so this module is deliberately thin — discovery, lifecycle, and
 * the per-frame tick, but no format knowledge and no compositing semantics.
 *
 * Why romdev cares
 * ----------------
 * A `.ab` can load cleanly, tick without trapping, and emit perfectly valid draw
 * commands while being completely wrong about the game. That is not
 * hypothetical: an early package for a maze game declared it read the player's
 * room, X and Y, its readable main.c contained room-aware logic, and the
 * compiled main.wasm ignored the room byte entirely and drew fake progress
 * bars. Unit tests proved it loaded and drew. They proved nothing about meaning.
 *
 * Catching that needs three things observable at the same instant: the raw core
 * framebuffer, the decoded live game state, and the final composite. romdev is
 * the only consumer that can show all three, which is why the bezel runs here at
 * all rather than only in a player.
 */

import path from "node:path";
import { stat } from "node:fs/promises";

/** sessionKey -> { runtime, packagePath, config, lastError, lastFrame, ticks } */
const sessions = new Map();

/**
 * Resolve the sidecar for a piece of media: `Game.ext` -> `Game.ab`.
 *
 * Same-basename discovery is the ordinary user-facing path; an explicit path is
 * a development override for iterating on a package that does not live next to
 * the ROM yet.
 */
export function sidecarPathFor(mediaPath) {
  if (!mediaPath) return null;
  const ext = path.extname(mediaPath);
  return path.join(path.dirname(mediaPath), path.basename(mediaPath, ext) + ".ab");
}

/**
 * Attach an Active Bezel to a freshly loaded host.
 *
 * Throws with an actionable message rather than degrading quietly: a caller that
 * passed `useActiveBezel:true` asked for a composite, and silently presenting
 * the raw core picture instead would be exactly the kind of "looks fine, means
 * nothing" failure this whole feature exists to surface.
 *
 * @param {string} sessionKey
 * @param {object} host           the loaded LibretroHost
 * @param {object} opts
 * @param {string} [opts.packagePath]  explicit override (development)
 * @param {string} [opts.mediaPath]    for same-basename discovery
 * @param {Uint8Array} opts.romBytes   for exact hash matching
 * @param {string} opts.platform
 * @param {object} [opts.config]
 * @param {boolean} [opts.force]       accept a non-matching ROM hash
 * @param {string} [opts.renderer]     'software' | 'gpu'
 */
export async function attachActiveBezel(sessionKey, host, {
  packagePath, mediaPath, romBytes, platform, config = {}, force = false, renderer,
}) {
  detachActiveBezel(sessionKey);

  const resolved = packagePath ?? sidecarPathFor(mediaPath);
  if (!resolved) {
    throw new Error(
      "loadMedia({useActiveBezel:true}) needs a media `path` to find the sidecar next to, "
      + "or an explicit `activeBezelPath`. A base64 ROM has no directory to search.",
    );
  }
  try {
    await stat(resolved);
  } catch {
    throw new Error(
      `No Active Bezel found at '${resolved}'. useActiveBezel:true looks for a same-basename `
      + ".ab beside the ROM. Pass activeBezelPath to point at a package elsewhere (an unpacked "
      + "directory works too, for development), or omit useActiveBezel to load the ROM alone.",
    );
  }

  // Imported here rather than at module load: romdev's other 30-odd tools have
  // no reason to pull in a WASM runtime and a compositor on every server start.
  const { ActiveBezelRuntime } = await import("active-bezel");

  let runtime;
  try {
    runtime = await ActiveBezelRuntime.create({
      packagePath: resolved,
      host,
      romBytes,
      platform,
      config,
      force,
      allowGpu: renderer !== "software",
    });
  } catch (cause) {
    const hint = /does not match this ROM/i.test(String(cause?.message))
      ? " The package declares which ROM hashes it supports; this ROM is not one of them. "
        + "Pass activeBezelForce:true to load it anyway (the composite may be meaningless), "
        + "or check you have the revision the package was authored against."
      : "";
    throw new Error(`Active Bezel failed to load from '${resolved}': ${cause?.message ?? cause}.${hint}`, { cause });
  }

  sessions.set(sessionKey, {
    runtime, packagePath: resolved, config, host,
    lastError: null, lastFrame: null, ticks: 0,
  });
  return runtime;
}

/**
 * Find the session a HOST belongs to.
 *
 * The observer's deferred frame provider is handed a host, not a session key,
 * at ~38 call sites. Threading a session key through every one of them would
 * mean a single missed site silently falls back to the raw core picture --
 * exactly the bug this exists to fix, and an invisible one. Resolving from the
 * host instead makes "a bezel is attached" the only thing that matters.
 */
export function sessionKeyForHost(host) {
  if (!host) return null;
  for (const [key, entry] of sessions) {
    if (entry.host === host) return key;
  }
  return null;
}

/** Drop the bezel for a session (media unload, host shutdown, a new package). */
export function detachActiveBezel(sessionKey) {
  const entry = sessions.get(sessionKey);
  if (!entry) return false;
  try { entry.runtime.shutdown?.(); } catch { /* teardown is best-effort */ }
  sessions.delete(sessionKey);
  return true;
}

/** The live runtime for a session, or null. */
export function getActiveBezel(sessionKey) {
  return sessions.get(sessionKey)?.runtime ?? null;
}

/**
 * Run the bezel tick for a frame the core has just produced, and return the
 * composite.
 *
 * Ordering is the contract: the core runs first, the bezel second, against the
 * state the core just wrote. Nothing here is asynchronous, so the visible frame
 * and the state used to enhance it always belong to the same frame number.
 *
 * A guest fault is recorded and surfaced, never thrown: a broken package must
 * not take down an emulation session an agent may be mid-investigation in.
 * The caller falls back to the raw core frame.
 */
export function tickActiveBezel(sessionKey, gameRgba, width, height, frameNumber) {
  const entry = sessions.get(sessionKey);
  if (!entry) return null;
  try {
    const composite = entry.runtime.processFrame(gameRgba, width, height, frameNumber);
    entry.ticks++;
    entry.lastFrame = { frameNumber, width, height };
    entry.lastError = null;
    return composite;
  } catch (e) {
    entry.lastError = String(e?.message ?? e);
    return null;
  }
}

/**
 * Tell the guest that continuity broke — a save-state load or a core reset.
 *
 * Without this a package keeps caches built from a timeline that no longer
 * exists (a room transition it thinks is in progress, an interpolated marker
 * position) and draws a composite that disagrees with the machine it is
 * supposedly describing.
 */
export function notifyActiveBezel(sessionKey, eventName) {
  const entry = sessions.get(sessionKey);
  if (!entry) return false;
  try { entry.runtime.event?.(eventName); return true; } catch { return false; }
}

/**
 * The status object embedded in loadMedia / catalog / frame responses.
 *
 * Carries the runtime's own `display` block through, which is where the sizes
 * that are easy to conflate live: the raw core framebuffer, the bezel's logical
 * scene, and the physical size it is scaled to are different things, and
 * conflating them is how a 4:3 game ends up stretched into a tall rectangle.
 */
export function activeBezelStatus(sessionKey) {
  const entry = sessions.get(sessionKey);
  if (!entry) return null;
  const { runtime } = entry;
  let inner = {};
  try { inner = runtime.status?.() ?? {}; } catch { /* status is best-effort */ }
  return {
    enabled: true,
    path: entry.packagePath,
    ticks: entry.ticks,
    ...(entry.lastFrame ? { lastFrame: entry.lastFrame } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
    config: entry.config,
    ...inner,
  };
}

/**
 * The frame a capture should present: the composite when a bezel is running,
 * the raw core picture otherwise.
 *
 * Every capture path funnels through here so "what the agent sees" and "what
 * the human sees" cannot drift apart. That matters more than it sounds: the
 * whole point of running the bezel inside romdev is that a screenshot is
 * evidence, and evidence that silently differs from the presented frame is
 * worse than none.
 *
 * `source` lets a caller ask for the other one explicitly:
 *   'composite' (default when a bezel is active) — the final scene
 *   'core'                                       — the raw framebuffer
 *
 * Returns {rgba, width, height, source} so the caller can report which it got
 * rather than assuming. A guest that faulted this frame falls back to the core
 * picture and says so through `activeBezelStatus().lastError`.
 */
export function compositeFrame(sessionKey, host, { source = "composite" } = {}) {
  const core = host.screenshotRgba();
  if (source === "core") return { ...core, source: "core" };

  const entry = sessions.get(sessionKey);
  if (!entry) return { ...core, source: "core" };

  const composed = tickActiveBezel(
    sessionKey, core.rgba, core.width, core.height, host.status.frameCount,
  );
  if (!composed) return { ...core, source: "core", compositeFailed: true };

  return {
    rgba: composed.rgba ?? composed,
    width: composed.width ?? entry.runtime.physicalWidth,
    height: composed.height ?? entry.runtime.physicalHeight,
    source: "composite",
  };
}

/**
 * The geometries that have to be kept distinct, because conflating them is how
 * a 4:3 game ends up stretched into a tall rectangle:
 *
 *   core      the raw framebuffer the emulator produced. Its width/height do
 *             NOT describe how the game was meant to look — Atari 2600 pixels
 *             are famously not square.
 *   scene     the bezel's logical composition, which the host may scale.
 *   display   the runtime's own view of the above: logical vs internal vs
 *             physical size, the picture effect, and which compositor backend
 *             actually ran (a GPU/CPU difference is the first thing to check
 *             when a golden frame stops matching).
 */
export function activeBezelGeometry(sessionKey, host) {
  const out = {};
  try {
    const f = host.getFramebuffer();
    out.core = { width: f.width, height: f.height };
  } catch { /* no frame stepped yet */ }

  const entry = sessions.get(sessionKey);
  if (entry) {
    const { runtime } = entry;
    out.scene = { width: runtime.physicalWidth, height: runtime.physicalHeight };
    // Pass the runtime's display block through verbatim rather than picking
    // fields out of it: it is the package's own account of how it intends to be
    // presented, and re-deriving that here is how the two drift apart.
    let inner = {};
    try { inner = runtime.status?.() ?? {}; } catch { /* best-effort */ }
    if (inner.display) out.display = inner.display;
  }
  return out;
}

/**
 * Tick the bezel for the frame the core has just produced, discarding the
 * composite.
 *
 * Called from the step path so the "once per emulated frame" contract holds
 * even when nobody captures anything. The composite is recomputed at capture
 * time from the then-current frame, so throwing this one away costs a compose
 * but keeps the guest's own timeline honest -- and a guest that only ticked on
 * screenshots would see time jump, which is precisely the kind of subtle wrong
 * this whole feature exists to expose.
 */
export function tickForFrame(sessionKey, host) {
  if (!sessions.has(sessionKey)) return false;
  let core;
  try { core = host.screenshotRgba(); } catch { return false; }  // no frame yet
  return tickActiveBezel(sessionKey, core.rgba, core.width, core.height, host.status.frameCount) != null;
}
