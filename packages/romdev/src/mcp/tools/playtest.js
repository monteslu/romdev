// playtest tools — open a live SDL window for the loaded ROM, with the
// emulator host shared between the window and every other MCP tool.
// Returns immediately; you can call screenshot / readMemory / saveState /
// pause / stepFrames etc. while the user is playing.

import { getHost, getHostOrNull } from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";

// Module-scoped session handle so playtestStop / playtestStatus can reach it.
let session = null;

/**
 * Cheap "is there a live playtest window right now?" query, used by
 * runSource to decide whether to attach the one-shot "consider playtest"
 * hint to its response. Module-singleton scope matches the existing
 * `session` lifetime — there's at most one playtest window per process.
 *
 * @returns {boolean}
 */
export function isPlaytestRunning() {
  return !!(session && session.running);
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
      const host = getHost(sessionKey);
      const loadedMediaPath = host.status?.mediaPath ?? null;
      if (session && session.running) {
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
      const { playtest } = await import("../../playtest/playtest.js");
      session = await playtest({ host, scale, title, aspect });
      // Detach so process doesn't hang on the closed promise.
      session.closed.then(() => { session = null; });
      return jsonContent({
        opened: true,
        reusedExistingWindow: false,
        loadedMediaPath,
        frameCount: host.status?.frameCount ?? 0,
        scale,
        aspect,
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
    "Check whether a playtest window is currently open, what ROM it's showing, and how many frames have elapsed in the live session.",
    {},
    safeTool(async () => {
      if (!session) return jsonContent({ running: false });
      const host = getHostOrNull(sessionKey);
      return jsonContent({
        running: session.running,
        loadedMediaPath: host?.status?.mediaPath ?? null,
        frameCount: host?.status?.frameCount ?? session.frameCount,
      });
    }),
  );
}
