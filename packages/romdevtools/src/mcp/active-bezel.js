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
import { createRequire } from "node:module";
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
  const { ActiveBezelRuntime, setGlModule } = await import("active-bezel");

  /*
   * Hand active-bezel the ONE native-gles instance this process owns.
   *
   * A second instance is never a redundancy, it is a hang: two copies of the
   * addon mean two EGL states in one process (the symlinked-package lesson).
   * When active-bezel was consumed via a file: symlink its own require could
   * not even FIND native-gles, and GpuCompositor.create swallowed the error,
   * silently dropping every gpu-command-v1 package to the CPU compositor
   * (measured: ~14ms/frame compositing 1920x1080 -- the difference between
   * 60fps and 40). The dep is a registry install now (0.6.0, native-gles as a
   * peer), so resolution would land on the hoisted copy anyway -- injection
   * stays because it makes the single-instance handover explicit instead of
   * an accident of hoisting. A GL context is still created lazily, and only
   * for packages that request the GPU renderer. (HW-render cores own the
   * process context the same way -- if a 3D core and a GPU bezel ever need to
   * coexist, arbitration goes HERE.)
   */
  try {
    setGlModule(createRequire(import.meta.url)("native-gles"));
  } catch (err) {
    console.error(`[active-bezel] native-gles injection failed -- GPU packages will fall back to the CPU compositor: ${err.message}`);
  }

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
      /*
       * Let the bezel SEE the controller.
       *
       * Without this, ab.input() is wired to `this.inputManager?.getState(...)
       * ?? 0` and therefore returns 0 forever -- the game receives input
       * normally (that path goes straight into the core) but a bezel drawing
       * a live controller, a button-press indicator or an input display can
       * never light up. It looks like the bezel is broken when nothing is.
       *
       * The host already tracks the current frame's state as a libretro
       * joypad bitmask per port, which is the same thing the core reads, so
       * the bezel and the game cannot disagree about what is held.
       */
      inputManager: {
        getState(port, device, index, id) {
          /*
           * Always the PHYSICAL pad, never the overridden view: input_state is
           * the bezel's read surface, and a bezel that overrode a button must
           * still see the real press (a left/right swap that read its own
           * output would re-swap every frame). The core's view goes through
           * effectiveJoypadMask in the host's input callback instead.
           */
          if (device === 1) {
            const mask = host?.state?.inputPorts?.[port]?.[0] ?? 0;
            /* id 256 (RETRO_DEVICE_ID_JOYPAD_MASK) asks for the whole word. */
            if (id === 256) return mask;
            if (id < 0 || id > 15) return 0;
            return (mask >> id) & 1;
          }
          /* RETRO_DEVICE_ANALOG (5): raw stick/trigger state where the host
           * tracks it (playtest passes real axes; agent setInput may too).
           * index 0/1 = left/right stick, id 0/1 = X/Y, -32768..32767;
           * index 2 = ANALOG_BUTTON, id 12/13 = trigger pressure 0..32767. */
          if (device === 5) {
            const axes = host?.state?.analogPorts?.[port];
            if (!axes) return 0;
            const s16 = (v) => Math.max(-32768, Math.min(32767, Math.round((v || 0) * 32767)));
            if (index === 2) {
              if (id === 12) return Math.max(0, s16(axes.lt));
              if (id === 13) return Math.max(0, s16(axes.rt));
              return 0;
            }
            if (index === 0) return id === 0 ? s16(axes.lx) : id === 1 ? s16(axes.ly) : 0;
            if (index === 1) return id === 0 ? s16(axes.rx) : id === 1 ? s16(axes.ry) : 0;
            return 0;
          }
          return 0;
        },
        /* The pre_frame write surface: one-frame joypad overrides, applied
         * when the core polls, cleared by the host at the top of every frame.
         * The runtime only forwards these from inside pre_frame. */
        setOverride(port, device, index, id, value) {
          return host?.setInputOverride?.(port, device, index, id, value) ?? false;
        },
        clearOverrides() {
          host?.clearInputOverrides?.();
        },
      },
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

  /*
   * Wire the ABI-2 pre_frame hook into the host's per-frame choke point.
   *
   * Installed UNCONDITIONALLY (not only when the current script defines
   * pre_frame): an ASSETS_RELOADED reboot can add the hook to a script that
   * lacked it at attach time, and a conditional install would silently never
   * call it. The cost when undefined is one function call + a cached property
   * check per frame — preFrame() early-returns before touching the guest, so
   * watch/breakpoint bursts pay effectively nothing.
   *
   * This lives on the HOST rather than at tool call sites deliberately: the
   * bezel tick tolerates being per-step-call, but an input remap that skips
   * frames plays garbage, and _runCore is the one place every frame driver
   * (frame step, runUntil, watch, breakpoint, playtest) funnels through.
   */
  if (typeof host.setInputOverride === "function") {
    host.beforeFrame = (frameNumber) => {
      const entry = sessions.get(sessionKey);
      if (entry?.runtime && !entry.bypassed) entry.runtime.preFrame(frameNumber);
    };
  } else if (runtime.status?.()?.preFrame?.defined) {
    /* A guest that WANTS pre_frame on a host that cannot run it must fail
     * loudly, not tick along with the hook silently never called. */
    detachActiveBezel(sessionKey);
    throw new Error(
      "This Active Bezel defines pre_frame, but this host has no per-frame "
      + "beforeFrame/setInputOverride support. Update romdev-core-host.",
    );
  }
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

/**
 * Suspend/resume the bezel WITHOUT tearing it down.
 *
 * The whole point vs detach: the guest interpreter stays alive — no
 * shutdown, no re-init, no reboot on resume. Script globals, caches,
 * loaded fonts/textures all survive; while bypassed the guest is simply
 * never CALLED (no pre_frame, no tick), captures return the raw core
 * frame, and any input override staged for the next frame is dropped so
 * a suspended bezel stops shaping the game immediately.
 *
 * @param {string} sessionKey
 * @param {boolean} [force] true=active, false=bypassed; omit to toggle
 * @returns {boolean|null} new BYPASSED state, or null if no bezel attached
 */
export function setActiveBezelBypassed(sessionKey, force) {
  const entry = sessions.get(sessionKey);
  if (!entry) return null;
  entry.bypassed = force !== undefined ? !!force : !entry.bypassed;
  if (entry.bypassed) entry.host?.clearInputOverrides?.();
  return entry.bypassed;
}

/** Drop the bezel for a session (media unload, host shutdown, a new package). */
export function detachActiveBezel(sessionKey) {
  const entry = sessions.get(sessionKey);
  if (!entry) return false;
  /* Unhook the per-frame pre_frame path and drop any override still pending
   * for the next frame — a detached bezel must stop shaping the game NOW. */
  if (entry.host) {
    entry.host.beforeFrame = null;
    entry.host.clearInputOverrides?.();
  }
  try { entry.runtime.shutdown?.(); } catch { /* teardown is best-effort */ }
  sessions.delete(sessionKey);
  return true;
}

/** The live runtime for a session, or null. */
export function getActiveBezel(sessionKey) {
  return sessions.get(sessionKey)?.runtime ?? null;
}

/**
 * Detach this process's GL context from the calling thread, after draining any
 * work still in flight.
 *
 * Serialization boundary between the TWO display stacks romdev can end up
 * holding at once: native-gles owns an EGL context (created on its own
 * EGL_PLATFORM_DEVICE display), while an open playtest window drives SDL,
 * which on X11/XWayland brings up GLX. Both bottom out in the same Mesa
 * driver state inside one process, and the observed failure is a SIGSEGV in
 * `__memcpy_avx512` under libgallium during a glTexImage2D whose arguments
 * were verified correct -- driver state, not caller state.
 *
 * The bezel's GL work (texture creates/destroys at guest tick time via
 * synchronous ab_host imports, then compose) and SDL's present used to run
 * back to back in one synchronous tick with nothing between them. Calling
 * this after the composite is in hand and before window.render() means the
 * bezel's context is finished and no longer current when SDL touches Mesa.
 *
 * glFinish first: releasing a context with commands still queued leaves the
 * driver working on buffers the next stack may disturb. It costs a pipeline
 * drain, which is why this is called once per COMPOSED frame rather than per
 * GL call, and not at all when no window is open.
 *
 * Portable by construction -- no window handles, no platform branches. The
 * calls are no-ops on a build without them, and every path is optional-chained
 * so a CPU-compositor session (native-gles never loaded) costs nothing.
 *
 * @returns {boolean} true if a context was actually released
 */
export function releaseBezelGl() {
  try {
    const gl = createRequire(import.meta.url)("native-gles");
    if (typeof gl?.releaseCurrent !== "function") return false;
    gl.glFinish?.();
    gl.releaseCurrent();
    return true;
  } catch {
    // native-gles absent or never initialised (CPU compositor, or no bezel at
    // all). Nothing to serialize against.
    return false;
  }
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
  if (!entry || entry.bypassed) return null;
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
/* Runtime.event() speaks AB_EVENT numbers; the tool callers here speak
 * names. This mapping used to be missing, and a string coerced to i32 is 0 —
 * every lifecycle notification (reset, state load, rewind) was a silent
 * no-op: the guest never heard the event and snapshot regions never
 * refreshed. Numbers mirror active-bezel's AB_EVENT / sdk abi.json. */
const AB_EVENT_BY_NAME = {
  reset: 1, stateLoaded: 2, rewindJump: 3, configChanged: 4,
  displayChanged: 5, assetsReloaded: 6, regionsChanged: 7,
};

export function notifyActiveBezel(sessionKey, eventName) {
  const entry = sessions.get(sessionKey);
  if (!entry) return false;
  const type = typeof eventName === "number" ? eventName : AB_EVENT_BY_NAME[eventName];
  if (!type) return false;
  try { entry.runtime.event?.(type); return true; } catch { return false; }
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
    ...(entry.bypassed ? { bypassed: true } : {}),
    path: entry.packagePath,
    ticks: entry.ticks,
    ...(entry.lastFrame ? { lastFrame: entry.lastFrame } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
    /* A beforeFrame hook failure is caught host-side so stepping never
     * breaks; surface it here so it cannot fail silently either. */
    ...(entry.host?.beforeFrameError
      ? { preFrameHookError: String(entry.host.beforeFrameError?.message ?? entry.host.beforeFrameError) }
      : {}),
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
  /* Suspended by the B hotkey / playtest({op:'bezel'}): the capture is the
   * raw core picture and SAYS so — a reader must never mistake it for the
   * composite the bezel would have drawn. */
  if (entry.bypassed) return { ...core, source: "core", bezelBypassed: true };

  /* The runtime caches the output of the LAST real tick. When it matches the
   * current frame, return it instead of re-ticking: an observer capture used
   * to run a full guest tick plus a 1080p CPU rasterize (~120ms on the event
   * loop) to photograph a frame that was composed ~3ms earlier on the GPU --
   * felt as a hard periodic stutter in playtest, and it polluted tick stats. */
  const rt = entry.runtime;
  if (rt.lastComposed?.rgba && rt.lastComposedFrame === host.status.frameCount) {
    /* Same staleness rule as below: in GL-present mode the cached compose
     * result is a placeholder; read the real frame back from the GPU. */
    if (rt.lastComposed.stale && rt.compositor?.readbackScene) {
      const fresh = rt.compositor.readbackScene();
      return { rgba: fresh.rgba, width: fresh.width, height: fresh.height, source: "composite" };
    }
    return {
      rgba: rt.lastComposed.rgba,
      width: rt.lastComposed.width ?? rt.physicalWidth,
      height: rt.lastComposed.height ?? rt.physicalHeight,
      source: "composite",
    };
  }

  const composed = tickActiveBezel(
    sessionKey, core.rgba, core.width, core.height, host.status.frameCount,
  );
  if (!composed) return { ...core, source: "core", compositeFailed: true };

  /* GL-direct present mode returns STALE pixels from compose (the live
   * frame only exists on the GPU); refresh from the scene FBO for the
   * capture. On-demand only -- the per-frame path never pays this. */
  if (composed.stale && entry.runtime.compositor?.readbackScene) {
    const fresh = entry.runtime.compositor.readbackScene();
    return { rgba: fresh.rgba, width: fresh.width, height: fresh.height, source: "composite" };
  }

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
