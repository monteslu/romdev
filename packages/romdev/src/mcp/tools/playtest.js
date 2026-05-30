// playtest tools — open a live SDL window for the loaded ROM, with the
// emulator host shared between the window and every other MCP tool.
// Returns immediately; you can call screenshot / readMemory / saveState /
// pause / stepFrames etc. while the user is playing.

import { writeFile } from "node:fs/promises";

import { getHost, getHostOrNull } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";

// Module-scoped session handle so playtestStop / playtestStatus can reach it.
let session = null;

/**
 * Pure truth-test for a playtest session handle. Prefers the window-level
 * probe (`windowAlive()`), which reflects the real SDL window even when it
 * died without firing a 'close' event (compositor kill, X/Wayland session
 * loss, freed handle) — the case where the plain `running` flag lies. Falls
 * back to `running` for older handles that predate the probe. Exported so the
 * reconciliation contract is unit-testable without opening a real window.
 *
 * @param {{windowAlive?: () => boolean, running?: boolean} | null} s
 * @returns {boolean}
 */
export function isSessionAlive(s) {
  if (!s) return false;
  if (typeof s.windowAlive === "function") return !!s.windowAlive();
  return !!s.running;
}

/**
 * Reconcile our cached `session` against the real SDL window. If the window
 * died without firing a 'close' event, `session.running` stays true forever
 * and every playtest query lies. Probe the underlying window; if it's gone,
 * tear the session down so the next playtest() opens a fresh one.
 *
 * @returns {boolean} true if a live window is genuinely still up.
 */
function reconcileSession() {
  if (!session) return false;
  if (!isSessionAlive(session)) {
    // Best-effort cleanup of the dead session, then forget it.
    try { session.stop?.(); } catch {}
    session = null;
    return false;
  }
  return true;
}

/**
 * Cheap "is there a live playtest window right now?" query, used by
 * runSource to decide whether to attach the one-shot "consider playtest"
 * hint to its response. Module-singleton scope matches the existing
 * `session` lifetime — there's at most one playtest window per process.
 *
 * @returns {boolean}
 */
export function isPlaytestRunning() {
  return reconcileSession();
}

export function registerPlaytestTools(server, z, sessionKey) {
  server.tool(
    "playtest",
    "Use this to open a native SDL window so a HUMAN can watch and play the loaded ROM — the 'show a " +
    "person' tool, NOT your iteration loop. Only call it once the game is worth a human's eyes (boots, " +
    "renders, the feature is visible). FOR YOUR OWN TESTING use screenshots instead (runSource / " +
    "stepAndScreenshot / screenshot) — a window on a black screen or crash just wastes the human's " +
    "attention. Once open, every other tool keeps working against the SAME live host (snapshot mid-play, " +
    "dump state, restore a saveState while they play). Requires @kmamal/sdl; stays open until closed or " +
    "playtestStop. See the `aspect` param for window shape.",
    {
      scale: z.number().int().min(1).max(8).default(3).describe("Integer upscale factor for the window."),
      title: z.string().optional().describe("Window title."),
      aspect: z.enum(["fb", "tv", "core"]).default("fb").describe("Initial window shape. 'fb' (default) opens at raw framebuffer * scale — square pixels, exact dev-time geometry. 'tv' = 'how a player saw the hardware': 4:3 for consoles (NES/SNES/Genesis/SMS/Atari/C64); native LCD aspect for handhelds (GB/GBC 10:9 = 160×144 NOT stretched; GG ~6:5; Lynx 4:3; GBA 3:2). 'core' honors the core's reported display_aspect_ratio (the framebuffer geometric ratio, often non-4:3 — Genesis H40 reports ~10:7). The user can resize; letterbox preserves the chosen aspect. NOTE: 'tv' looks up the platform from the running host, so always pass the correct `platform` arg to loadMedia (`platform:\"gbc\"` not `\"gb\"` for a CGB game) or 'tv' falls back to the framebuffer aspect."),
    },
    safeTool(async ({ scale, title, aspect }) => {
      // Preflight #1 (before requiring a host): a native SDL window needs a
      // desktop display. If the server was launched from a shell with no
      // DISPLAY / WAYLAND_DISPLAY (a tmux/ssh session started before the
      // desktop login, or a cron/CI run), createWindow has nowhere to draw —
      // it fails or silently shows nothing. Surface an actionable message
      // instead of a mystery (and instead of a misleading "no ROM loaded" if
      // getHost ran first). The display is what's missing, not the ROM.
      if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        return jsonContent({
          opened: false,
          reason: "no-display",
          message:
            "Can't open a playtest window: the server process has no DISPLAY or " +
            "WAYLAND_DISPLAY set, so there's no desktop to draw on. This usually " +
            "means the server was started from a shell/tmux/ssh session that " +
            "predates the desktop login. Restart the server with the display env, " +
            "e.g.: DISPLAY=:0 WAYLAND_DISPLAY=wayland-0 " +
            "XAUTHORITY=$XDG_RUNTIME_DIR/.mutter-Xwaylandauth.* node src/mcp/server.js " +
            "(discover live values via: tr '\\0' '\\n' < /proc/<desktop-pid>/environ | " +
            "grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY)='). Every headless tool " +
            "(screenshot, runSource, readMemory, ...) still works — only the live " +
            "window needs a display.",
        });
      }

      const host = getHost(sessionKey);
      const loadedMediaPath = host.status?.mediaPath ?? null;
      if (reconcileSession()) {
        // A window is already open. We DON'T open a second one — there's one
        // window per process, sharing the live host — so this is a no-op that
        // just reports the existing window. The host (and thus the window's
        // content) already reflects any rebuild you did via runSource.
        return jsonContent({
          opened: true,
          reusedExistingWindow: true,
          loadedMediaPath,
          frameCount: host.status?.frameCount ?? session.frameCount,
          note: "A playtest window was already open — reused it (one window per process, sharing the live host). The window already shows your latest loaded/rebuilt ROM. Call playtestStop first if you want to reopen with different scale/aspect.",
        });
      }

      const { playtest, KEYBOARD_BINDINGS_HELP } = await import("../../playtest/playtest.js");
      try {
        // Pass a live-host accessor so the window FOLLOWS rebuilds: runSource/
        // loadMedia call resetHost() and replace the session host, and the
        // window resolves getHostOrNull(sessionKey) each frame to render the
        // latest one (instead of dying on the now-unloaded open-time host).
        session = await playtest({
          host,
          getLiveHost: () => getHostOrNull(sessionKey),
          scale,
          title,
          aspect,
        });
      } catch (e) {
        // createWindow / SDL init threw despite a display being set — surface
        // the real reason rather than a generic tool error.
        return jsonContent({
          opened: false,
          reason: "sdl-error",
          message:
            "Failed to open the SDL playtest window: " + (e?.message ?? String(e)) +
            ". A display IS set (DISPLAY=" + (process.env.DISPLAY ?? "") +
            " WAYLAND_DISPLAY=" + (process.env.WAYLAND_DISPLAY ?? "") +
            "), so this is an SDL/driver issue, not a missing-display one. The " +
            "ROM stays loaded; screenshot / runSource / other tools still work.",
          loadedMediaPath,
        });
      }
      // Detach so process doesn't hang on the closed promise.
      session.closed.then(() => { session = null; });
      // No gamepad plugged in → the user is on the keyboard fallback. Hand the
      // agent the key map AND an explicit instruction to relay it, so the user
      // isn't left guessing which keys drive the game. (A pad hot-plugged later
      // is picked up automatically — this is just the at-open state.)
      const noController = session.controllerCount === 0;
      return jsonContent({
        opened: true,
        reusedExistingWindow: false,
        loadedMediaPath,
        frameCount: host.status?.frameCount ?? 0,
        scale,
        aspect,
        controllerCount: session.controllerCount,
        ...(noController
          ? {
              keyboardControls: KEYBOARD_BINDINGS_HELP,
              tellUser:
                "No gamepad detected — the user is on the keyboard. RELAY the " +
                "`keyboardControls` mapping to them so they know which keys to " +
                "press (arrows = D-pad, Z = main action, etc.). A USB controller " +
                "plugged in later is picked up automatically.",
            }
          : {}),
        note: "Window is open and the render loop runs in the background. Other MCP tools (screenshot, readMemory, pause, stepFrames, saveState, ...) act on the same live host. Call playtestStop to close the window.",
      });
    }),
  );

  server.tool(
    "playtestStop",
    "Close the live playtest window (if one is open). The emulator host stays loaded and you can keep using all the other tools.",
    {},
    safeTool(async () => {
      if (!session) return textContent("no playtest window open");
      session.stop();
      session = null;
      return textContent("playtest window closed");
    }),
  );

  server.tool(
    "playtestStatus",
    "Check whether a playtest window is currently open, what ROM it's showing, and how many frames have " +
    "elapsed. ALSO reports `activeHostMatchesWindow`: false means a `runSource`/`loadMedia` since the window " +
    "opened swapped the session's active host, so `screenshot()` (which reads the active host) no longer shows " +
    "what the human sees — use `playtestFramebuffer` to capture the human's actual window.",
    {},
    safeTool(async () => {
      // reconcileSession() probes the real SDL window and tears down a dead
      // one — so a window killed without a 'close' event reports running:false
      // instead of lying forever (the post-restart / compositor-kill case).
      if (!reconcileSession()) return jsonContent({ running: false });
      const activeHost = getHostOrNull(sessionKey);
      const windowHost = session.host ?? null;
      // The window binds its host at open; the session's active host gets
      // REPLACED by resetHost() on every runSource/loadMedia. Same object →
      // screenshot() and the window agree. Different object → they've diverged.
      const matches = !!windowHost && activeHost === windowHost;
      return jsonContent({
        running: true,
        // What the HUMAN is looking at (the window's own host):
        windowMediaPath: windowHost?.status?.mediaPath ?? null,
        windowFrameCount: windowHost?.status?.frameCount ?? session.frameCount,
        // What screenshot()/the agent's other tools currently read:
        activeMediaPath: activeHost?.status?.mediaPath ?? null,
        activeFrameCount: activeHost?.status?.frameCount ?? null,
        activeHostMatchesWindow: matches,
        ...(matches ? {} : {
          hint: "The active host diverged from the playtest window (a runSource/" +
            "loadMedia swapped it). screenshot() now shows the active host, NOT " +
            "what the human sees. Call playtestFramebuffer to capture the human's window.",
        }),
      });
    }),
  );

  server.tool(
    "playtestFramebuffer",
    "Capture the EXACT framebuffer the human is looking at in the playtest window — the raw emulator frame, " +
    "not an OS screenshot of the scaled window. Use this instead of `screenshot()` when a playtest window is " +
    "open and you need to see what the USER sees: `screenshot()` reads the session's active host, which a " +
    "`runSource`/`loadMedia` rebuild may have swapped away from the window's host. This always reads the " +
    "window's own host. DEFAULT writes the PNG to `path` and returns `{path,...}`; pass `inline:true` to get " +
    "the image in the response. Errors cleanly if no playtest window is open.",
    {
      path: z.string().optional().describe("Absolute path to write the PNG to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the image in the response instead of writing to disk. Default false — then `path` is required."),
    },
    safeTool(async ({ path: outPath, inline }) => {
      if (!reconcileSession()) {
        return jsonContent({
          ok: false,
          error: "no playtest window open",
          hint: "Open one with playtest(), or use screenshot() to capture the session's active host.",
        });
      }
      if (!inline && !outPath) {
        return jsonContent({ ok: false, error: "pass `path` (where to write the PNG) or `inline:true`." });
      }
      const frame = session.captureFrame();
      if (!frame) {
        return jsonContent({
          ok: false,
          error: "playtest window has no loaded host right now (mid-rebuild?)",
          hint: "A runSource/loadMedia may be swapping the host this instant — retry in a moment.",
        });
      }
      const meta = {
        ok: true,
        source: "playtest",
        playtestRunning: true,
        width: frame.width,
        height: frame.height,
        loadedMediaPath: frame.loadedMediaPath,
        platform: frame.platform,
        frameCount: frame.frameCount,
      };
      if (!inline) {
        await writeFile(outPath, Buffer.from(frame.pngBase64, "base64"));
        const json = jsonContent({ ...meta, path: outPath });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: frame.pngBase64 }];
        return json;
      }
      return {
        content: [
          imageContent(frame.pngBase64),
          { type: "text", text: `playtest framebuffer ${frame.width}x${frame.height} — ${frame.loadedMediaPath ?? "<memory>"} @ frame ${frame.frameCount}` },
        ],
      };
    }),
  );
}
