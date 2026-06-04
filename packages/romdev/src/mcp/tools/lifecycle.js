import { resolveCore } from "../../cores/registry.js";
import { defaultMediaKind } from "../../host/index.js";
import { clearHost, getHost, getHostOrNull, resetHost } from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";
import { resolveCheatCodeForApply } from "./cheats.js";

const MEDIA_KINDS = ["cartridge", "disk", "tape", "program"];

export function registerLifecycleTools(server, z, sessionKey) {
  // Shared loader: accepts a file `path` OR base64 `bytes` (exactly one).
  async function doLoadMedia({ platform, path, base64, mediaKind, virtualName, cheats }) {
    const resolved = resolveCore(platform);
    if (!resolved) throw new Error(`no core available for platform '${platform}'`);
    if (!path && !base64) throw new Error("loadMedia: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (path && base64) throw new Error("loadMedia: provide `path` OR `base64`, not both.");
    const host = resetHost(sessionKey);
    await host.loadCore(resolved.jsPath, resolved.wasmPath);
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
    await host.loadMedia({
      platform,
      ...(bytes ? { bytes, virtualName } : { path }),
      mediaKind: mediaKind ?? defaultMediaKind(platform),
    });

    // Pre-seed cheats BEFORE the first frame — so a boot-time cheat (e.g. a Game
    // Genie code that changes a value the reset code reads) is in effect from
    // frame 0. Raw ROM codes are re-encoded to a read-intercept (same as
    // applyCheat) so they don't silently no-op. Applied only if the core has the
    // cheat interface; otherwise reported as skipped.
    let appliedCheats;
    if (cheats && cheats.length) {
      appliedCheats = [];
      const supported = host.cheatsSupported && host.cheatsSupported();
      cheats.forEach((raw, i) => {
        if (!supported) { appliedCheats.push({ code: raw, applied: false, reason: "core has no cheat interface" }); return; }
        const { code, appliedAs, reencodedFrom } = resolveCheatCodeForApply(raw, platform);
        try {
          host.setCheat(i, code, true);
          appliedCheats.push({ code, appliedAs, ...(reencodedFrom ? { reencodedFrom } : {}), applied: true });
        } catch (e) {
          appliedCheats.push({ code: raw, applied: false, reason: e?.message ?? String(e) });
        }
      });
    }
    // Framebuffer dimensions are NOT known until the core has run at least one
    // frame — before that, fbWidth/fbHeight hold a pre-boot default (e.g.
    // 256×192 on Genesis) that does NOT match the real output resolution
    // (256×224 after booting). Reporting it here misleads any agent that routes
    // on dimensions, so we omit it until a frame has been stepped and point the
    // caller at stepFrames instead.
    const framebufferKnown = host.status.frameCount > 0;
    return jsonContent({
      loaded: true,
      platform,
      core: resolved.coreName,
      mediaKind: host.status.mediaKind,
      ...(bytes ? { bytes: bytes.length } : { path: host.status.mediaPath }),
      ...(framebufferKnown
        ? { framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight } }
        : { framebufferNote: "Framebuffer dimensions are unknown until the core runs — call stepFrames first, then getStatus (the pre-boot default does not match the real output resolution)." }),
      ...(appliedCheats ? { cheats: appliedCheats } : {}),
    });
  }

  server.tool(
    "loadMedia",
    "Use this to load a ROM/disk/tape/program into a fresh host — resolves the right libretro core " +
    "automatically. Pass `path` (file on disk) OR `base64` (ROM bytes — e.g. straight from buildSource, " +
    "no disk write, for a fast iteration loop). Pass `cheats` to apply codes BEFORE the first frame — for " +
    "boot-time cheat testing (e.g. iterating on a Game Genie code that changes a value the reset code reads) " +
    "in one call instead of loadMedia + applyCheat.",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'gb', 'c64'). Use listPlatforms() to discover."),
      path: z.string().optional().describe("Absolute path to the media file on disk. Provide this OR `base64`."),
      base64: z.string().optional().describe("Base64-encoded ROM/disk/tape/program bytes. Provide this OR `path`."),
      mediaKind: z.enum(MEDIA_KINDS).optional().describe("Media type. Defaults to 'cartridge' for consoles and 'program' for C64."),
      virtualName: z.string().optional().describe("With `base64`: virtual filename shown to cores that fopen() the path (default '/rom')."),
      cheats: z.array(z.string()).max(64).optional().describe("Cheat codes to apply before the first frame (Game Genie / raw ADDR:VAL[:COMPARE] / native device codes). Same handling as applyCheat — a raw ROM-address code is re-encoded to a read-intercept so it doesn't silently no-op. Returns a per-code `cheats:[{code, appliedAs, applied}]` report. Use for boot-time cheat testing."),
    },
    safeTool(doLoadMedia),
  );


  server.tool(
    "unloadMedia",
    "Unload the current media without disposing the host. Use this before swapping a ROM if you want to keep the core hot.",
    {},
    safeTool(async () => {
      const host = getHostOrNull(sessionKey);
      if (host) host.unloadMedia();
      return textContent("unloaded");
    }),
  );

  server.tool(
    "shutdown",
    "Tear down the current host entirely. Free all resources. A subsequent loadMedia creates a fresh host.",
    {},
    safeTool(async () => {
      clearHost(sessionKey);
      return textContent("shutdown complete");
    }),
  );

  server.tool(
    "reset",
    "Reset the loaded ROM. DEFAULT is a soft reset (the console's RESET button): it calls the core's " +
    "retro_reset, which on most cores does NOT clear work RAM — so boot-seeded variables and any state " +
    "the game already wrote PERSIST (e.g. a current-area byte stays at its old value). For a TRUE " +
    "power-cycle that clears RAM and re-seeds boot state, pass `hard:true` — that reloads the ROM from " +
    "scratch (equivalent to a fresh loadMedia). Use `hard:true` when re-testing boot-time behavior " +
    "(e.g. iterating on a boot cheat / a different seed value); a soft reset boots the PREVIOUS state.",
    {
      hard: z.boolean().default(false).describe("true = full power-cycle (reload the ROM; clears work RAM + boot-seeded state). false (default) = soft RESET-button reset (RAM persists)."),
    },
    safeTool(async ({ hard }) => {
      const host = getHost(sessionKey);
      if (hard) {
        const reloaded = await host.hardReset();
        return textContent(reloaded ? "reset (hard / power-cycle — RAM cleared)" : "reset (soft — no cached ROM to reload for a hard reset)");
      }
      host.reset();
      return textContent("reset (soft — RESET button; work RAM persists, use hard:true to clear it)");
    }),
  );

  server.tool(
    "pause",
    "Pause emulation. Subsequent stepFrames calls return 0 until resume.",
    {},
    safeTool(async () => {
      getHost(sessionKey).pause();
      return textContent("paused");
    }),
  );

  server.tool(
    "resume",
    "Resume emulation after pause.",
    {},
    safeTool(async () => {
      getHost(sessionKey).resume();
      return textContent("resumed");
    }),
  );

  server.tool(
    "getStatus",
    "Get the current state of the host: platform, loaded media, frame count, paused state, framebuffer dimensions.",
    {},
    safeTool(async () => {
      const host = getHostOrNull(sessionKey);
      if (!host) return jsonContent({ loaded: false });
      return jsonContent(host.getStatus());
    }),
  );
}
