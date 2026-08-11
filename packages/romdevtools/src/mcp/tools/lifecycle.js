import { resolveCore } from "../../cores/registry.js";
import {
  clearHost, clearHostB, disposeHost, getHost, getHostB, getHostBOrNull, getHostOrNull,
  installHost, rememberLastMedia, resetHost, resetHostB,
} from "../state.js";
import { WasmcartHost } from "../../host/WasmcartHost.js";
import { JsGameHost } from "../../host/JsGameHost.js";

// Native-runtime platforms don't use a libretro core — they run a native WASM/JS
// game module in-process. loadMedia builds the matching host and installs it.
const NATIVE_RUNTIME_HOSTS = {
  wasmcart: () => new WasmcartHost(),
  jsgame: () => new JsGameHost(),
};
import { jsonContent, safeTool, textContent } from "../util.js";
import { resolveCheatCodeForApply } from "./cheats.js";
import { attachObserverFrame } from "./watch-memory.js";
import { attachActiveBezel, detachActiveBezel, activeBezelStatus, notifyActiveBezel } from "../active-bezel.js";
import { readFile } from "node:fs/promises";

const MEDIA_KINDS = ["cartridge", "disk", "tape", "program"];

export function registerLifecycleTools(server, z, sessionKey) {
  // Shared loader: accepts a file `path` OR base64 `bytes` (exactly one).
  // slot:'b' targets the secondary comparison host (for frame sideBySide);
  // it gets its own fresh host and does NOT overwrite slot A's recovery
  // breadcrumb, since B is transient scratch, not the session's main ROM.
  async function doLoadMedia({ platform, path, base64, mediaKind, virtualName, cheats, slot, deterministicSeed, coreOptions, presentWindow, useActiveBezel, activeBezelPath, activeBezelConfig, activeBezelForce, activeBezelRenderer }) {
    if (!path && !base64) throw new Error("loadMedia: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (path && base64) throw new Error("loadMedia: provide `path` OR `base64`, not both.");
    if (deterministicSeed !== undefined && !NATIVE_RUNTIME_HOSTS[platform]) {
      throw new Error("deterministicSeed is a wasmcart option (seeded replay via wc_set_seed). Emulator cores are already deterministic from power-on — just replay the same input script.");
    }

    // Native-runtime kinds (wasmcart, jsgame) bypass the libretro core path: build
    // their own host, load the game module, install it as the session host. They
    // share the frame/input/screenshot surface but not loadCore/cheats/regions.
    if (NATIVE_RUNTIME_HOSTS[platform]) {
      if (slot === "b") throw new Error(`slot 'b' (side-by-side) is not supported for '${platform}'`);
      // Tear the OUTGOING host down BEFORE the new one builds its GL context.
      // installHost() below also tears down, but by then the new cart has
      // already loaded -- and a GL cart creates (and for presentWindow,
      // ATTACHES) its context during loadMedia. Overlapping the two left the
      // incoming cart validating FBOs while the outgoing context was still
      // live and window-attached, so the load immediately after a
      // presentWindow session rendered a broken picture
      // (GL_FRAMEBUFFER_INCOMPLETE_ATTACHMENT every frame) while the load
      // after THAT was fine. Ordering the disposal explicitly is the fix;
      // installHost's own teardown then finds nothing left to do.
      disposeHost(sessionKey);
      const host = NATIVE_RUNTIME_HOSTS[platform]();
      const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
      await host.loadMedia({
        platform,
        ...(bytes ? { bytes } : { path }),
        ...(deterministicSeed !== undefined ? { deterministic: { seed: deterministicSeed } } : {}),
        // presentWindow gives a GL cart its OWN GL context so a later
        // playtest window can bind it and present by GPU swap instead of
        // reading every frame back to the CPU. It has to be decided here
        // because the context is bound when the cart's wasm loads and cannot
        // be swapped afterward.
        ...(presentWindow ? { presentWindow: true } : {}),
      });
      installHost(sessionKey, host);
      if (path || bytes) rememberLastMedia(sessionKey, { platform, path, fromBase64: !!bytes });
      const caps = host.getCapabilities();
      const result = {
        loaded: true, platform, kind: caps.kind,
        mediaKind: host.status.mediaKind,
        ...(bytes ? { bytes: bytes.length } : { path: host.status.mediaPath }),
        fbWidth: host.status.fbWidth, fbHeight: host.status.fbHeight,
        ...(deterministicSeed !== undefined ? { deterministicSeed: host.status.deterministicSeed } : {}),
        capabilities: caps,
      };
      // Push the first frame to the /livestream observer, same as an emulator load.
      attachObserverFrame(result, host, `${platform} loaded`);
      return result;
    }

    const resolved = resolveCore(platform);
    if (!resolved) throw new Error(`no core available for platform '${platform}'`);
    const slotB = slot === "b";
    const host = slotB ? resetHostB(sessionKey) : resetHost(sessionKey);
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
    await host.loadMedia({
      platform,
      ...(bytes ? { bytes, virtualName } : { path }),
      // Only force a mediaKind when the caller picked one; otherwise let the host
      // derive it from the file extension (a C64 .d64 → "disk", .tap → "tape",
      // .prg → "program") so status reports the kind honestly.
      ...(mediaKind ? { mediaKind } : {}),
      ...(coreOptions ? { coreOptions } : {}),
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

    // Active Bezel: an executable companion that runs after every core frame and
    // renders the final scene. Attached last, so it sees the fully prepared
    // machine (cheats seeded, media mounted) on its first tick.
    //
    // Slot B is comparison scratch for frame({op:'sideBySide'}) and never drives
    // presentation, so a bezel there would composite a picture nothing displays.
    let activeBezel;
    if (useActiveBezel || activeBezelPath) {
      if (slotB) throw new Error("Active Bezels are not supported on slot 'b' — it is comparison scratch and never drives the presented frame.");
      const romBytes = bytes ?? new Uint8Array(await readFile(host.status.mediaPath ?? path));
      await attachActiveBezel(sessionKey, host, {
        packagePath: activeBezelPath,
        mediaPath: host.status.mediaPath ?? path,
        romBytes,
        platform,
        config: activeBezelConfig ?? {},
        force: activeBezelForce,
        renderer: activeBezelRenderer,
      });
      activeBezel = activeBezelStatus(sessionKey);
    } else {
      // A plain load must not inherit the previous ROM's bezel: the package is
      // matched to a specific ROM hash, so keeping it across a media swap would
      // composite one game's map over another game's picture.
      detachActiveBezel(sessionKey);
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
      ...(activeBezel ? { activeBezel } : {}),
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
      useActiveBezel: z.boolean().default(false).describe("Load the same-basename Active Bezel sidecar beside the ROM ('Game.nes' -> 'Game.ab') and run it after every core frame, making the COMPOSITE the default presented/captured picture. An Active Bezel is an executable companion that reads the core's live memory and renders the whole scene — a map, a HUD, reconstructed world graphics — around or over the game. Fails loudly if no sidecar exists rather than quietly loading the ROM alone. Default false: omit it and loadMedia behaves exactly as it always has."),
      activeBezelPath: z.string().optional().describe("Explicit package path (a .ab archive OR an unpacked directory), overriding same-basename discovery. This is a DEVELOPMENT override for iterating on a package that doesn't live beside the ROM yet — ordinary use should rely on discovery."),
      activeBezelConfig: z.record(z.string(), z.any()).optional().describe("Per-package settings, validated against the manifest's settings schema (e.g. {show_map:true})."),
      activeBezelForce: z.boolean().default(false).describe("Load the package even when the ROM hash does not match what it declares support for. The composite may be meaningless — a map keyed to another revision's RAM layout draws confidently wrong things — so this is for development, not for trusting the output."),
      activeBezelRenderer: z.enum(["software", "gpu"]).optional().describe("Force the compositor. Default: GPU when the package requests it and a GL context is available, else the CPU compositor. 'software' pins the CPU path, which is fully featured and deterministic — the right choice for golden-frame comparisons."),
      deterministicSeed: z.number().int().min(0).optional().describe("wasmcart only: load as a DETERMINISTIC REPLAY — fixed virtual clock + this u32 RNG seed delivered to the cart's wc_set_seed before init. Same seed + same input script = an identical frame sequence (airtight frameHash regression goldens). Only meaningful for carts that declare WC_FLAG_DETERMINISTIC (check capabilities.hasDeterministic after load); other carts get the fixed clock but keep their own entropy."),
      coreOptions: z.record(z.string(), z.string()).optional().describe("Libretro core options applied before the ROM loads, overriding the core's defaults (e.g. {\"snes9x_layer_3\":\"disabled\"} hides a layer at the RENDERER so an Active Bezel can own it — game state and VRAM are untouched). Keys/values are core-specific and unvalidated: a wrong key is silently ignored by the core, so verify the effect visually."),
      presentWindow: z.boolean().optional().describe("wasmcart GL carts only: load this cart on its OWN GL context so a later playtest({op:'open'}) can present it by GPU swap instead of reading every frame back to the CPU (measured ~5.4ms/frame of a 16.7ms budget at 1080p). Pass it when you intend to open a window for a HUMAN to play a 3D/GL cart. It must be set at load time — the GL context binds when the cart's wasm loads and cannot be swapped afterward, so a cart already loaded without it keeps the readback path until reloaded. Costs one extra GL context per loaded cart; a cart loaded WITHOUT it shares the process-wide offscreen context, which can never be attached to a window (doing so would drag every other session's cart into that window). No effect on 2D carts or emulator cores."),
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
          // The package is bound to this ROM's hash; keeping it across an unload
          // would leave one game's map ready to composite over another's picture.
          const hadBezel = slotB ? false : detachActiveBezel(sessionKey);
          return textContent(`unloaded${slotB ? " (slot B)" : ""}${hadBezel ? " (Active Bezel detached)" : ""}`);
        }
        case "shutdown":
          if (slotB) clearHostB(sessionKey); else { detachActiveBezel(sessionKey); clearHost(sessionKey); }
          return textContent(`shutdown complete${slotB ? " (slot B)" : ""}`);
        case "reset": {
          const host = get(sessionKey);
          if (hard) {
            const reloaded = await host.hardReset();
            // Keep the package across a reset (same ROM) but tell it continuity
            // broke, so it discards caches built from a timeline that no longer
            // exists rather than drawing a stale interpretation of fresh state.
            if (!slotB) notifyActiveBezel(sessionKey, "reset");
            return observe(textContent(reloaded ? "reset (hard / power-cycle — RAM cleared)" : "reset (soft — no cached ROM to reload for a hard reset)"), host, "reset (hard)");
          }
          host.reset();
          if (!slotB) notifyActiveBezel(sessionKey, "reset");
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
