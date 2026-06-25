import { resolveCore } from "../../cores/registry.js";
import {
  clearHost, clearHostB, getHost, getHostB, getHostBOrNull, getHostOrNull,
  rememberLastMedia, resetHost, resetHostB,
} from "../state.js";
import { jsonContent, safeTool, textContent } from "../util.js";
import { resolveCheatCodeForApply } from "./cheats.js";
import { attachObserverFrame } from "./watch-memory.js";

const MEDIA_KINDS = ["cartridge", "disk", "tape", "program"];

export function registerLifecycleTools(server, z, sessionKey) {
  // Shared loader: accepts a file `path` OR base64 `bytes` (exactly one).
  // slot:'b' targets the secondary comparison host (for frame sideBySide);
  // it gets its own fresh host and does NOT overwrite slot A's recovery
  // breadcrumb, since B is transient scratch, not the session's main ROM.
  async function doLoadMedia({ platform, path, base64, mediaKind, virtualName, cheats, slot }) {
    const resolved = resolveCore(platform);
    if (!resolved) throw new Error(`no core available for platform '${platform}'`);
    if (!path && !base64) throw new Error("loadMedia: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (path && base64) throw new Error("loadMedia: provide `path` OR `base64`, not both.");
    const slotB = slot === "b";
    const host = slotB ? resetHostB(sessionKey) : resetHost(sessionKey);
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender });
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
    await host.loadMedia({
      platform,
      ...(bytes ? { bytes, virtualName } : { path }),
      // Only force a mediaKind when the caller picked one; otherwise let the host
      // derive it from the file extension (a C64 .d64 → "disk", .tap → "tape",
      // .prg → "program") so status reports the kind honestly.
      ...(mediaKind ? { mediaKind } : {}),
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
    // Remember what we loaded so a later host eviction (restart/reconnect) can
    // tell the agent the exact loadMedia call to recover with. Survives reset.
    // Only for slot A — the breadcrumb is the primary ROM's recovery anchor;
    // slot B is disposable comparison scratch and must not clobber it.
    if (!slotB) {
      rememberLastMedia(sessionKey, {
        platform,
        ...(bytes ? { fromBase64: true } : { path: host.status.mediaPath ?? path }),
      });
    }

    // Framebuffer dimensions are NOT known until the core has run at least one
    // frame — before that, fbWidth/fbHeight hold a pre-boot default (e.g.
    // 256×192 on Genesis) that does NOT match the real output resolution
    // (256×224 after booting). Reporting it here misleads any agent that routes
    // on dimensions, so we omit it until a frame has been stepped and point the
    // caller at stepFrames instead.
    const framebufferKnown = host.status.frameCount > 0;
    const payload = jsonContent({
      loaded: true,
      platform,
      ...(slotB ? { slot: "b" } : {}),
      core: resolved.coreName,
      mediaKind: host.status.mediaKind,
      ...(bytes ? { bytes: bytes.length } : { path: host.status.mediaPath }),
      ...(framebufferKnown
        ? { framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight } }
        : { framebufferNote: "Framebuffer dimensions are unknown until the core runs — call stepFrames first, then getStatus (the pre-boot default does not match the real output resolution)." }),
      ...(appliedCheats ? { cheats: appliedCheats } : {}),
    });
    // Livestream: only slot A drives the human's view (the session's main ROM).
    // Slot B is comparison scratch — surfacing it would flip the livestream
    // back and forth between two ROMs. frame({op:'sideBySide'}) is what shows B.
    if (slotB) return payload;
    return attachObserverFrame(payload, host, `loaded ${host.status.mediaPath ? host.status.mediaPath.split("/").pop() : platform}`);
  }

  server.tool(
    "loadMedia",
    "Load a ROM/disk/tape/program into a fresh host — resolves the libretro core automatically. " +
    "Pass `path` (file on disk) OR `base64` (ROM bytes — e.g. straight from buildSource, no disk write, " +
    "for a fast iteration loop). `cheats` apply BEFORE the first frame (one call instead of loadMedia + " +
    "applyCheat), so a boot-time code that changes a value the reset code reads is in effect from frame 0. " +
    "`slot:'b'` loads into the SECONDARY comparison host (a different platform is fine) so two cores can run " +
    "at once for frame({op:'sideBySide'}) — the original-vs-port compare loop; slot B does not affect slot A " +
    "or the livestream. " +
    "NOTE: framebuffer dimensions are omitted until you stepFrames — the pre-boot default does not match the " +
    "real output resolution.",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'gb', 'c64'). Use listPlatforms() to discover."),
      path: z.string().optional().describe("Absolute path to the media file. Provide this OR `base64`."),
      base64: z.string().optional().describe("Base64-encoded media bytes. Provide this OR `path`."),
      mediaKind: z.enum(MEDIA_KINDS).optional().describe("Default 'cartridge' for consoles, 'program' for C64."),
      virtualName: z.string().optional().describe("With `base64`: virtual filename shown to cores that fopen() the path (default '/rom')."),
      cheats: z.array(z.string()).max(64).optional().describe("Codes applied before the first frame (Game Genie / raw ADDR:VAL[:COMPARE] / native device codes). A raw ROM-address code is re-encoded to a read-intercept so it doesn't silently no-op. Returns a per-code `cheats:[{code, appliedAs, applied}]` report."),
      slot: z.enum(["a", "b"]).default("a").describe("'a' (default) = the session's primary host (what every other tool uses). 'b' = the secondary comparison host used by frame({op:'sideBySide'}); load the second ROM here. Slot B is independent scratch — it keeps no recovery breadcrumb and never drives the livestream."),
    },
    safeTool(doLoadMedia),
  );


  server.tool(
    "host",
    "Emulator host lifecycle. `op`: 'unload' | 'shutdown' | 'reset' | 'pause' | 'resume'. " +
    "(Loading media is the separate `loadMedia` tool.)\n" +
    "'unload': drop the current media but keep the core hot (for a fast ROM swap). 'shutdown': tear the host down " +
    "entirely (a later loadMedia makes a fresh one).\n" +
    "'reset': DEFAULT is a SOFT reset (the RESET button — retro_reset; on most cores does NOT clear work RAM, so " +
    "boot-seeded variables PERSIST). Pass `hard:true` for a TRUE power-cycle that reloads the ROM from scratch and " +
    "clears RAM + re-seeds boot state — use it when re-testing boot-time behavior (a soft reset boots the PREVIOUS " +
    "state).\n" +
    "'pause': halt emulation (stepFrames returns 0 until resume). 'resume': continue.\n" +
    "`slot:'b'` targets the secondary comparison host (loaded via loadMedia({slot:'b'})). Slot-B ops never " +
    "touch the livestream.",
    {
      op: z.enum(["unload", "shutdown", "reset", "pause", "resume"]).describe("unload media; shutdown the host; reset (soft/hard); pause; resume."),
      hard: z.boolean().default(false).describe("op=reset: true = full power-cycle (reload the ROM; clears work RAM + boot-seeded state). false (default) = soft RESET-button reset (RAM persists)."),
      slot: z.enum(["a", "b"]).default("a").describe("'a' (default) = the primary host. 'b' = the secondary comparison host (frame sideBySide)."),
    },
    safeTool(async ({ op, hard, slot }) => {
      const slotB = slot === "b";
      const get = slotB ? getHostB : getHost;
      const getOrNull = slotB ? getHostBOrNull : getHostOrNull;
      // Slot B never drives the human's livestream — wrap attachObserverFrame so
      // slot-A behavior is unchanged but slot B stays silent.
      const observe = slotB ? (content) => content : attachObserverFrame;
      switch (op) {
        case "unload": {
          const host = getOrNull(sessionKey);
          if (!host || !host.status.loaded) {
            // Don't claim success when there was nothing loaded — that masks a
            // session/state mix-up (the agent thinks it unloaded media it never had).
            return textContent(`nothing to unload — no media is loaded in ${slotB ? "comparison slot B" : "this session"}`);
          }
          host.unloadMedia();
          return textContent(`unloaded${slotB ? " (slot B)" : ""}`);
        }
        case "shutdown":
          if (slotB) clearHostB(sessionKey); else clearHost(sessionKey);
          return textContent(`shutdown complete${slotB ? " (slot B)" : ""}`);
        case "reset": {
          const host = get(sessionKey);
          if (hard) {
            const reloaded = await host.hardReset();
            return observe(textContent(reloaded ? "reset (hard / power-cycle — RAM cleared)" : "reset (soft — no cached ROM to reload for a hard reset)"), host, "reset (hard)");
          }
          host.reset();
          return observe(textContent("reset (soft — RESET button; work RAM persists, use hard:true to clear it)"), host, "reset");
        }
        case "pause":
          get(sessionKey).pause();
          return textContent(`paused${slotB ? " (slot B)" : ""}`);
        case "resume":
          get(sessionKey).resume();
          return textContent(`resumed${slotB ? " (slot B)" : ""}`);
        default:
          throw new Error(`host: unknown op '${op}'`);
      }
    }),
  );

  // getStatus folded into catalog({op:'status'}) (entry-tier, in index.js).
}
