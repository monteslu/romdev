// playtest tools — open a live SDL window for the loaded ROM, with the
// emulator host shared between the window and every other MCP tool.
// Returns immediately; you can call screenshot / readMemory / saveState /
// pause / stepFrames etc. while the user is playing.

import { writeFile } from "node:fs/promises";

import { getHost, getHostOrNull, playtestCheckpointPath } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";
import { log } from "../log.js";

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

/**
 * Human co-drive snapshot for one session: is a playtest window open, and has
 * the HUMAN pressed anything (pad / keyboard / rewind-scrub) within the last
 * ~2 s? Drives catalog({op:'status'}) and the co-drive warning attached to
 * frame/input responses. Cheap, never throws; with no window everything is
 * inactive. Frames are window ticks ≈ frames at 60fps real time.
 * @param {string} sessionKey
 * @returns {{windowOpen: boolean, humanInputActive: boolean, framesSinceHumanInput: number | null}}
 */
export function getPlaytestHumanStatus(sessionKey) {
  if (!reconcileSession(sessionKey)) {
    return { windowOpen: false, humanInputActive: false, framesSinceHumanInput: null };
  }
  const s = sessions.get(sessionKey);
  return {
    windowOpen: true,
    humanInputActive: typeof s.humanInputActive === "function" ? !!s.humanInputActive() : false,
    framesSinceHumanInput: typeof s.framesSinceHumanInput === "function" ? s.framesSinceHumanInput() : null,
  };
}

/**
 * The warning attached to frame({op:'step'/'stepAndShot'}) and input(set/press/
 * sequence/navigate) responses while a human is co-driving this session's
 * playtest window. null when there's no window or the human hasn't pressed
 * recently — so the field only appears when there's a REAL conflict.
 * @param {string} sessionKey
 * @returns {string | null}
 */
export function humanCoDriveWarning(sessionKey) {
  const st = getPlaytestHumanStatus(sessionKey);
  if (!st.windowOpen || !st.humanInputActive) return null;
  const ago = st.framesSinceHumanInput != null ? `~${st.framesSinceHumanInput} frames ago` : "moments ago";
  return (
    `A playtest window is open and the HUMAN last pressed buttons ${ago} — you are co-driving the same ` +
    "emulator. While they press, the window's input overwrites yours each tick (the human wins), and its " +
    "real-time 60fps loop races your frame-stepping (non-deterministic results). Either host({op:'pause'}) " +
    "while you inspect (the window keeps rendering, frozen), do deterministic work in a SECOND session " +
    "(a different x-romdev-session header = a fully isolated emulator), or wait for the human to stop."
  );
}

export function registerPlaytestTools(server, z, sessionKey) {
  // op:'open' — open (or reuse) the SDL window for this session.
  async function ptOpen({ scale = 3, title, aspect = "tv" }) {
      const host = getHost(sessionKey);
      const loadedMediaPath = host.status?.mediaPath ?? null;
      // No env-var preflight here — the GROUND-TRUTH "is there a real display?"
      // check lives in loadSdl() (it asks SDL which video driver it selected and
      // throws sdlKind:"no-display" if it's offscreen/dummy). That's cross-
      // platform and doesn't false-bark on valid offscreen setups like Xvfb.
      // The try/catch below surfaces it (and the binary errors) uniformly.
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

      const { playtest, KEYBOARD_BINDINGS_HELP, C64_BINDINGS_HELP } = await import("../../playtest/playtest.js");
      // Where the rolling auto-checkpoint (eviction survivability) is written.
      // Next to the ROM when it's a real file (so it's obvious + co-located); for
      // base64/in-memory loads, a stable per-session file under the OS temp dir.
      const autoCheckpointPath = playtestCheckpointPath(sessionKey, loadedMediaPath);
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
          autoCheckpointPath,
        });
        session.autoCheckpointPath = autoCheckpointPath;
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

        // A failed window-open is a REAL FAILURE — THROW it, don't return a soft
        // {opened:false} object. Returning success-shaped JSON made the failure
        // invisible on the REST/skill surface (HTTP 200 = "it worked"), so an
        // agent driving the routes would report "window's up!" while no window
        // exists. Thrown → safeTool tags isError → runTool maps it to HTTP 400
        // (REST) and a tool error (MCP). We also log to the server console so a
        // human watching the terminal sees it even if the agent buries the error.
        let reason, message;
        if (kind === "no-display") {
          // GROUND TRUTH: SDL came up on the offscreen/dummy driver — there is no
          // physical screen to show the window on (it would render + play audio
          // but be invisible). loadSdl()'s message already says exactly this + the
          // fix; pass it straight through.
          reason = "no-display";
          message = (e?.message ?? String(e)) + headlessNote;
        } else if (kind === "missing-binary" || kind === "install-failed") {
          // Native-addon problem, NOT a display problem.
          const fix = e?.fixCmd
            ? `Run: ${e.fixCmd} (then restart the server). `
            : "Reinstall @kmamal/sdl so its prebuilt binary is fetched. ";
          reason = "sdl-binary-missing";
          message =
            "The playtest window couldn't open because the @kmamal/sdl native " +
            "binary isn't installed: " + (e?.message ?? String(e)) + ". " +
            (kind === "install-failed"
              ? "An automatic install was attempted but failed (often a network/proxy block on the GitHub release download). "
              : "(This is common under `npx romdevtools` — npm skips @kmamal/sdl's install script that fetches the binary; the server tried to self-heal but the binary is still absent.) ") +
            fix + "This is a one-time native-addon fix, NOT a display/desktop " +
            "issue." + headlessNote;
        } else {
          // Anything else SDL threw. Do NOT overwrite the quoted error with a
          // confident display/desktop diagnosis — "invalid width" (a romdev
          // window-sizing bug) wore the "couldn't get a display" costume once
          // and sent the human debugging the wrong layer. The quoted SDL
          // message is the ground truth; desktop-session advice is offered as
          // the usual cause only when the error actually smells like one.
          reason = "sdl-error";
          const msg = e?.message ?? String(e);
          const smellsLikeDisplay = /display|video|driver|screen|desktop|wayland|x11|xdg|connection/i.test(msg);
          message =
            "Couldn't open the SDL playtest window: " + msg + "." +
            (smellsLikeDisplay
              ? " This usually means the server has no access to a logged-in " +
                "desktop session — e.g. it was spawned as an MCP subprocess by " +
                "your agent host, or runs over plain SSH/headless. The reliable " +
                "fix: run the server yourself in a terminal inside your desktop " +
                "session, then connect your agent to it."
              : " That quoted SDL error is the actual fault (not a display/" +
                "desktop-session problem) — report it as a romdev bug if it " +
                "isn't obviously environmental.") +
            headlessNote + " You can also open the built ROM in any standalone emulator.";
        }
        // Server-console breadcrumb (stderr) so a human at the terminal sees the
        // failure regardless of whether the agent relays the tool error.
        log.error(`playtest: window failed to open (${reason}) — ${e?.fixCmd ? "fix: " + e.fixCmd : message.slice(0, 120)}`);
        const err = new Error(message);
        err.reason = reason;
        if (e?.fixCmd) err.fixCommand = e.fixCmd;
        throw err;
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
      const isC64 = host.status?.platform === "c64";
      return jsonContent({
        opened: true,
        reusedExistingWindow: false,
        loadedMediaPath,
        frameCount: host.status?.frameCount ?? 0,
        scale,
        aspect,
        controllerCount: session.controllerCount,
        // Eviction survivability: while this window is open we roll a .state to
        // disk so the human's manual progress survives a session eviction.
        autoCheckpointPath,
        autoCheckpointNote: `Progress auto-saves to ${autoCheckpointPath} every ~15s while the window is open (and on F2). If the session is evicted, state({op:'load', path}) it to restore the human's playthrough instead of replaying from boot.`,
        // C64 input is non-obvious (games need keyboard keys to START), so ALWAYS
        // relay the controls — a controller alone IS enough (spare buttons/stick
        // map to F1/Run-Stop/Space/Return), and the keyboard fallback covers the
        // no-controller case. This is the Batocera/RetroDeck model.
        ...(isC64
          ? {
              c64Controls: C64_BINDINGS_HELP,
              tellUser:
                "C64 game: RELAY `c64Controls` to the user. A CONTROLLER ALONE is " +
                "enough — they do NOT need a keyboard. Most C64 games need a " +
                "keyboard key to START (e.g. F1 for 1 player); the pad's spare " +
                "buttons/right-stick map to those (F1/F3/F5/F7, Space, Run/Stop, " +
                "Return). Default joystick port is 2; change with input({op:'joyport'}).",
            }
          : noController
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
      const human = getPlaytestHumanStatus(sessionKey);
      return jsonContent({
        running: true,
        // Is the human ACTIVELY playing right now (pressed within ~2 s)? While
        // true, your input/setInput is overwritten each tick and real-time
        // stepping races yours — pause, or use a second session.
        humanInputActive: human.humanInputActive,
        ...(human.framesSinceHumanInput != null ? { framesSinceHumanInput: human.framesSinceHumanInput } : {}),
        // What the HUMAN is looking at (the window's own host):
        windowMediaPath: windowHost?.status?.mediaPath ?? null,
        windowFrameCount: windowHost?.status?.frameCount ?? session.frameCount,
        // What screenshot()/the agent's other tools currently read:
        activeMediaPath: activeHost?.status?.mediaPath ?? null,
        activeFrameCount: activeHost?.status?.frameCount ?? null,
        activeHostMatchesWindow: matches,
        // Live window perf (rolling 1s): fps = emulated frames/sec (60 = full
        // speed; lower = the machine can't keep up), tickHz = render passes/sec,
        // and per-stage EMAs (stepMs emulation, convertMs framebuffer→RGBA,
        // presentMs SDL render, audioQueuedMs SDL queue depth). This is the
        // "is it actually slow, and WHERE" readout.
        ...(session.perf ? { perf: session.perf } : {}),
        ...(matches ? {} : {
          hint: "The active host diverged from the playtest window (a build({output:'run'})/" +
            "loadMedia swapped it). frame({op:'screenshot'}) now shows the active host, NOT " +
            "what the human sees. Call playtest({op:'framebuffer'}) to capture the human's window.",
        }),
        // Eviction survivability: where the human's progress auto-saves, and
        // whether the last write failed (so an agent can warn + suggest a manual
        // state({op:'save', path}) if the rolling checkpoint isn't landing).
        ...((() => {
          const ck = session.lastCheckpoint?.();
          if (!ck || !ck.path) return {};
          return {
            autoCheckpointPath: ck.path,
            ...(ck.lastError
              ? { autoCheckpointError: ck.lastError, autoCheckpointHint: "The rolling auto-checkpoint is FAILING — the human's progress is NOT being saved. Have them pick a writable spot: state({op:'save', path}) manually." }
              : { autoCheckpointNote: "The human's progress auto-saves here every ~15s (and on F2); survives a session eviction via state({op:'load', path})." }),
          };
        })()),
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
        // Usage error → throw so REST returns 400 (not a 200 with ok:false the
        // caller might ignore).
        throw new Error("playtest framebuffer: pass `path` (where to write the PNG) or `inline:true`.");
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
    "that live host while the window is open. FOOTGUN — the window's loop steps the core in REAL TIME, and while " +
    "the human is pressing (pad/keyboard) it writes their input each tick, overwriting yours — the human wins. " +
    "(When the human is idle the window leaves your input({op:'set'}) alone, but its 60fps stepping still races " +
    "your frame({op:'step'}).) You'll KNOW: frame/input responses carry `humanCoDriveWarning` while the human " +
    "pressed within ~2s, and catalog({op:'status'})/playtest({op:'status'}) expose `humanInputActive`. To inspect " +
    "a moving state freeze it first: host({op:'pause'}) → read → host({op:'resume'}); for deterministic stepping " +
    "while the human plays, use a SECOND session (different x-romdev-session = fully isolated emulator). " +
    "Requires @kmamal/sdl. `scale`/`title`/`aspect` shape the window.\n" +
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
