// playtest tools — open a live SDL window for the loaded ROM, with the
// emulator host shared between the window and every other MCP tool.
// Returns immediately; you can call screenshot / readMemory / saveState /
// pause / stepFrames etc. while the user is playing.

import { writeFile } from "node:fs/promises";

import { getHost, getHostOrNull } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";

// Playtest windows are PER SESSION: the MCP server is multi-session (one server
// serves several agents at once), and the same user can have 2-3 different games
// open simultaneously — each in its own window. So we key the window handle by
// sessionKey, NOT a single module global. One agent's window never clobbers
// another's, and closing one session tears down only its own window.
/** @type {Map<string, any>} */
const sessions = new Map();

/** Test-only: inject a fake session handle so the per-session registry can be
 *  unit-tested without opening a real SDL window. Not used in production. */
export function __setSessionForTest(sessionKey, fakeSession) {
  if (fakeSession == null) sessions.delete(sessionKey);
  else sessions.set(sessionKey, fakeSession);
}

/**
 * Close the playtest window for ONE session (if any). Called when that session
 * disconnects so a single agent leaving never touches the other agents' games.
 * Safe to call when nothing is open for that key.
 * @param {string} sessionKey
 * @returns {boolean} true if a window was closed
 */
export function stopPlaytestForSession(sessionKey) {
  const s = sessions.get(sessionKey);
  if (!s) return false;
  try { s.stop(); } catch {}
  sessions.delete(sessionKey);
  return true;
}

/**
 * Close EVERY open playtest window. Called from the server's shutdown path so a
 * shutdown leaves no window behind. Windows are in-process (same Node process
 * as the server), so a clean exit tears them down anyway — but this makes it
 * explicit and synchronous on SIGINT/SIGTERM across all sessions.
 * @returns {number} how many windows were closed
 */
export function stopAllPlaytest() {
  let n = 0;
  for (const [key, s] of sessions) {
    try { s.stop(); n++; } catch {}
    sessions.delete(key);
  }
  return n;
}

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
 * Reconcile ONE session's cached handle against the real SDL window. If the
 * window died without firing a 'close' event, `running` stays true forever and
 * every query lies. Probe the window; if it's gone, drop it so the next
 * playtest() for that session opens fresh.
 * @param {string} sessionKey
 * @returns {boolean} true if a live window is genuinely still up for that key.
 */
function reconcileSession(sessionKey) {
  const s = sessions.get(sessionKey);
  if (!s) return false;
  if (!isSessionAlive(s)) {
    try { s.stop?.(); } catch {}
    sessions.delete(sessionKey);
    return false;
  }
  return true;
}

/**
 * Cheap "is there a live playtest window for THIS session right now?" query,
 * used by runSource to decide whether to attach the one-shot "consider
 * playtest" hint to its response.
 * @param {string} sessionKey
 * @returns {boolean}
 */
export function isPlaytestRunning(sessionKey) {
  return reconcileSession(sessionKey);
}

export function registerPlaytestTools(server, z, sessionKey) {
  // op:'open' — open (or reuse) the SDL window for this session.
  async function ptOpen({ scale = 3, title, aspect = "tv" }) {
      // No preflight display checks. We just attempt to open the SDL window and
      // report whatever SDL says — env-var guessing (DISPLAY/WAYLAND_DISPLAY)
      // is Linux-only and wrong on macOS/Windows, where those vars are never
      // set even with a full GUI session. SDL's createWindow already knows
      // whether it can draw on any platform; the try/catch below surfaces the
      // real error.
      const host = getHost(sessionKey);
      const loadedMediaPath = host.status?.mediaPath ?? null;
      if (reconcileSession(sessionKey)) {
        // THIS session already has a window open. We don't open a second one for
        // the same session — it shares this session's live host — so report the
        // existing one. (A DIFFERENT session having its own window is fine and
        // independent; this only reuses your own.)
        return jsonContent({
          opened: true,
          reusedExistingWindow: true,
          loadedMediaPath,
          frameCount: host.status?.frameCount ?? sessions.get(sessionKey)?.frameCount,
          note: "A playtest window was already open for this session — reused it (it shares your session's live host and already shows your latest loaded/rebuilt ROM). Call playtestStop first to reopen with a different scale/aspect. (Other agents' windows are separate.)",
        });
      }

      const { playtest, KEYBOARD_BINDINGS_HELP } = await import("../../playtest/playtest.js");
      let session;
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
        sessions.set(sessionKey, session);
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
      // Detach so process doesn't hang on the closed promise. Only clear THIS
      // session's slot, and only if it still points at this same session (a
      // later reopen could have replaced it).
      session.closed.then(() => {
        if (sessions.get(sessionKey) === session) sessions.delete(sessionKey);
      });
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
        note: "Window is open and the render loop runs in the background. Other MCP tools (frame, memory, host pause/resume, state, ...) act on the same live host. Call playtest({op:'stop'}) to close the window.",
      });
  }

  // op:'stop' — close this session's window.
  async function ptStop() {
      return textContent(stopPlaytestForSession(sessionKey) ? "playtest window closed" : "no playtest window open");
  }

  // op:'status' — is a window open, what's it showing, does it match the active host?
  async function ptStatus() {
      // reconcileSession() probes the real SDL window and tears down a dead
      // one — so a window killed without a 'close' event reports running:false
      // instead of lying forever (the post-restart / compositor-kill case).
      if (!reconcileSession(sessionKey)) {
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
      const session = sessions.get(sessionKey);
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
          hint: "The active host diverged from the playtest window (a build({output:'run'})/" +
            "loadMedia swapped it). frame({op:'screenshot'}) now shows the active host, NOT " +
            "what the human sees. Call playtest({op:'framebuffer'}) to capture the human's window.",
        }),
      });
  }

  // op:'framebuffer' — capture the EXACT frame the human's window shows.
  async function ptFramebuffer({ path: outPath, inline }) {
      if (!reconcileSession(sessionKey)) {
        return jsonContent({
          ok: false,
          error: "no playtest window open",
          hint: "Open one with playtest(), or use screenshot() to capture the session's active host.",
        });
      }
      if (!inline && !outPath) {
        return jsonContent({ ok: false, error: "pass `path` (where to write the PNG) or `inline:true`." });
      }
      const frame = sessions.get(sessionKey).captureFrame();
      if (!frame) {
        return jsonContent({
          ok: false,
          error: "playtest window has no loaded host right now (mid-rebuild?)",
          hint: "A build({output:'run'})/loadMedia may be swapping the host this instant — retry in a moment.",
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
  }

  server.tool(
    "playtest",
    "Show the loaded ROM to a HUMAN in a native SDL window, one tool keyed by `op`. For your OWN build-iteration " +
    "testing use frame({op:'screenshot'}) / build({output:'run'}) instead.\n" +
    "• op:'open' (default) — open (or reuse this session's) window. Only call it once the game is worth a human's " +
    "eyes (boots, renders, the feature is visible) — a window on a black screen/crash just wastes their attention. " +
    "BEST FOR diagnosing a USER-REPORTED bug: hand them the window, let them drive to the exact moment, then " +
    "inspect the SAME live host in real time (memory/watch/sprites/state). Every other tool keeps working against " +
    "that live host while the window is open. FOOTGUN — the window's loop owns input AND stepping: each tick it " +
    "rebuilds controller state from the human's gamepad+keyboard, calls setInput, then steps a frame, so your " +
    "input({op:'set'}) is OVERWRITTEN on the next tick (the human wins). To inspect a moving state freeze it first: " +
    "host({op:'pause'}) → read → host({op:'resume'}). Requires @kmamal/sdl. `scale`/`title`/`aspect` shape the window.\n" +
    "• op:'stop' — close THIS session's window (the host stays loaded; other agents' windows unaffected).\n" +
    "• op:'status' — is a window open, what ROM/frame it shows, and `activeHostMatchesWindow` (false = a build/" +
    "loadMedia swapped the active host, so frame({op:'screenshot'}) no longer shows what the human sees — use op:'framebuffer').\n" +
    "• op:'framebuffer' — capture the EXACT framebuffer the human's window shows (the window's own host, not the " +
    "active host frame({op:'screenshot'}) reads). `path` (default) or `inline:true`.",
    {
      op: z.enum(["open", "stop", "status", "framebuffer"]).default("open")
        .describe("open=show the ROM to a human (default); stop=close this session's window; status=is it open + does it match the active host; framebuffer=capture what the human sees."),
      scale: z.number().int().min(1).max(8).default(3).describe("op:open — integer upscale factor for the window."),
      title: z.string().optional().describe("op:open — window title."),
      aspect: z.enum(["fb", "tv", "core"]).default("tv").describe("op:open — initial window shape. 'tv' (DEFAULT) = how a player saw the hardware (4:3 consoles; native LCD for handhelds — GB/GBC 10:9 not stretched, GG ~6:5, Lynx 4:3, GBA 3:2). 'fb' = raw framebuffer × scale (square pixels, dev geometry). 'core' honors the core's display_aspect_ratio. NOTE: 'tv' reads the platform from the running host, so pass the correct `platform` to loadMedia (gbc not gb for a CGB game) or it falls back to the fb aspect."),
      path: z.string().optional().describe("op:framebuffer — absolute path to write the PNG to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("op:framebuffer — return the image in the response instead of writing to disk."),
    },
    safeTool(async (args) => {
      switch (args.op ?? "open") {
        case "open":        return await ptOpen(args);
        case "stop":        return await ptStop();
        case "status":      return await ptStatus();
        case "framebuffer": {
          if (!args.inline && !args.path) throw new Error("playtest({op:'framebuffer'}): pass `path` (where to write the PNG) or `inline:true`.");
          return await ptFramebuffer(args);
        }
        default: throw new Error(`playtest: unknown op '${args.op}'`);
      }
    }),
  );
}
