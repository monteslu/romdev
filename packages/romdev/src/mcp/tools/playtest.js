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
    "person' tool, NOT your build-iteration loop. Only call it once the game is worth a human's eyes (boots, " +
    "renders, the feature is visible). FOR YOUR OWN BUILD TESTING use screenshots instead (runSource / " +
    "stepAndScreenshot / screenshot) — a window on a black screen or crash just wastes the human's " +
    "attention. BEST FOR (beyond demos): diagnosing a USER-REPORTED bug — when the human already has a repro, " +
    "hand them the window, let them drive to the exact moment, then inspect the SAME live host in real time " +
    "(readMemory / watchMemory / inspectSprites / dumpState, with pause/resume to freeze a moving state). " +
    "That beats blindly re-deriving a state headless across reboots. Once open, every other tool keeps working " +
    "against the SAME live host (snapshot mid-play, dump state, restore a saveState while they play). " +
    "INPUT/STEPPING WHILE OPEN: the window's own loop drives the emulator — each tick it rebuilds controller " +
    "state from the human's gamepad+keyboard and calls setInput, then steps one frame. So your `setInput` is " +
    "OVERWRITTEN on the next tick (the human's input wins; they are NOT merged with yours), and the window — " +
    "not you — owns stepFrames. To inspect a moving state, `pause` (halts the tick loop, freezing input AND " +
    "stepping) → readMemory/watchMemory/dumpState → `resume`. Reads don't need a pause; only deterministic " +
    "stepping or agent-driven input do. " +
    "Requires @kmamal/sdl; stays open until closed or playtestStop. See the `aspect` param for window shape.",
    {
      scale: z.number().int().min(1).max(8).default(3).describe("Integer upscale factor for the window."),
      title: z.string().optional().describe("Window title."),
      aspect: z.enum(["fb", "tv", "core"]).default("fb").describe("Initial window shape. 'fb' (default) opens at raw framebuffer * scale — square pixels, exact dev-time geometry. 'tv' = 'how a player saw the hardware': 4:3 for consoles (NES/SNES/Genesis/SMS/Atari/C64); native LCD aspect for handhelds (GB/GBC 10:9 = 160×144 NOT stretched; GG ~6:5; Lynx 4:3; GBA 3:2). 'core' honors the core's reported display_aspect_ratio (the framebuffer geometric ratio, often non-4:3 — Genesis H40 reports ~10:7). The user can resize; letterbox preserves the chosen aspect. NOTE: 'tv' looks up the platform from the running host, so always pass the correct `platform` arg to loadMedia (`platform:\"gbc\"` not `\"gb\"` for a CGB game) or 'tv' falls back to the framebuffer aspect."),
    },
    safeTool(async ({ scale, title, aspect }) => {
      // No preflight display checks. We just attempt to open the SDL window and
      // report whatever SDL says — env-var guessing (DISPLAY/WAYLAND_DISPLAY)
      // is Linux-only and wrong on macOS/Windows, where those vars are never
      // set even with a full GUI session. SDL's createWindow already knows
      // whether it can draw on any platform; the try/catch below surfaces the
      // real error.
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
        // Branch on WHY it failed — the cause is either the @kmamal/sdl native
        // binary not being installed (common under `npx`, where the transitive
        // install script is skipped) or an actual display/session problem.
        // Conflating them (the old message always blamed the desktop session)
        // sent people down the wrong path.
        const kind = e?.sdlKind;
        const headlessNote =
          " Every headless tool (screenshot / runSource / readMemory / " +
          "stepFrames / pressButton) still works against the live ROM — only " +
          "the interactive window is affected.";

        if (kind === "missing-binary" || kind === "install-failed") {
          // Native-addon problem, NOT a display problem.
          const fix = e?.fixCmd
            ? `Run: ${e.fixCmd} (then restart the server). `
            : "Reinstall @kmamal/sdl so its prebuilt binary is fetched. ";
          return jsonContent({
            opened: false,
            reason: "sdl-binary-missing",
            platform: process.platform,
            message:
              "The playtest window couldn't open because the @kmamal/sdl native " +
              "binary isn't installed: " + (e?.message ?? String(e)) + ". " +
              (kind === "install-failed"
                ? "An automatic install was attempted but failed (often a network/proxy block on the GitHub release download). "
                : "(This is common under `npx romdev-mcp` — npm skips @kmamal/sdl's install script that fetches the binary; the server tried to self-heal but the binary is still absent.) ") +
              fix + "This is a one-time native-addon fix, NOT a display/desktop " +
              "issue." + headlessNote,
            fixCommand: e?.fixCmd ?? null,
            loadedMediaPath,
          });
        }

        // A genuine SDL init / display failure (e.g. no video device, no
        // desktop session). NOW the desktop-session advice is the right call.
        return jsonContent({
          opened: false,
          reason: "sdl-error",
          platform: process.platform,
          message:
            "Couldn't open the SDL playtest window: " + (e?.message ?? String(e)) +
            ". SDL initialized but couldn't get a display. This usually means the " +
            "server has no access to a logged-in desktop session — e.g. it was " +
            "spawned as an MCP subprocess by your agent host, or runs over plain " +
            "SSH/headless. The reliable fix: run the server yourself in a terminal " +
            "inside your desktop session, then connect your agent to it." +
            headlessNote + " You can also open the built ROM in any standalone emulator.",
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
      if (!reconcileSession()) {
        // No window — but report whether a host/ROM is still loaded so the
        // caller can decide whether to re-loadMedia or just re-open playtest,
        // instead of defensively reloading (Jay's session2 #3).
        const h = getHostOrNull(sessionKey);
        return jsonContent({
          running: false,
          hostLoaded: !!h,
          activeMediaPath: h?.status?.mediaPath ?? null,
          activeFrameCount: h?.status?.frameCount ?? null,
          note: h
            ? "No playtest window, but a host/ROM is still loaded — re-open playtest without re-running loadMedia."
            : "No playtest window and no host loaded — loadMedia (or runSource) first.",
        });
      }
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
