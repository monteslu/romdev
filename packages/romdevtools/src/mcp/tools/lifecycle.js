import { resolveCore, coresFor } from "../../cores/registry.js";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import {
  clearHost, clearHostB, disposeHost, getHost, getHostB, getHostBOrNull, getHostOrNull,
  installHost, installHostB, rememberLastMedia, resetHost, resetHostB,
} from "../state.js";
import { WasmcartHost } from "../../host/WasmcartHost.js";
import { JsGameHost } from "../../host/JsGameHost.js";

// Native-runtime platforms don't use a libretro core - they run a native WASM/JS
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
import { registerMediaLoader } from "./fast-present.js";
import { emitSessionEnd } from "../session-events.js";
import { startPlay, stopPlay, PLAY_MAX_SECONDS } from "../autoplay.js";
import { getPlaytestHumanStatus } from "./playtest.js";

const MEDIA_KINDS = ["cartridge", "disk", "tape", "program"];

export function registerLifecycleTools(server, z, sessionKey) {
  // Expose the loader so playtest({op:'open', fastPresent:true}) can reload a
  // GL cart onto a private context. doLoadMedia is closure-scoped over this
  // sessionKey, so handing it over by registration keeps that scoping intact
  // and avoids a circular import.
  registerMediaLoader(sessionKey, (opts) => doLoadMedia(opts));
  // Shared loader: accepts a file `path` OR base64 `bytes` (exactly one).
  // slot:'b' targets the secondary comparison host (for frame sideBySide);
  // it gets its own fresh host and does NOT overwrite slot A's recovery
  // breadcrumb, since B is transient scratch, not the session's main ROM.
  async function doLoadMedia({ platform, path, base64, mediaKind, virtualName, cheats, slot, deterministicSeed, deterministicStepMs, coreOptions, core, firmware, presentWindow, gpuPower, wgpu, useActiveBezel, activeBezelPath, activeBezelConfig, activeBezelForce, activeBezelRenderer }) {
    if (!path && !base64) throw new Error("loadMedia: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (path && base64) throw new Error("loadMedia: provide `path` OR `base64`, not both.");
    if (deterministicSeed !== undefined && !NATIVE_RUNTIME_HOSTS[platform]) {
      throw new Error("deterministicSeed is a wasmcart option (seeded replay via wc_set_seed). Emulator cores are already deterministic from power-on - just replay the same input script.");
    }
    if (deterministicStepMs !== undefined && deterministicSeed === undefined) {
      throw new Error("deterministicStepMs sets the virtual clock step of a deterministic replay; pass deterministicSeed with it.");
    }

    // Native-runtime kinds (wasmcart, jsgame) bypass the libretro core path: build
    // their own host, load the game module, install it as the session host. They
    // share the frame/input/screenshot surface but not loadCore/cheats/regions.
    if (NATIVE_RUNTIME_HOSTS[platform]) {
      const slotB = slot === "b";
      if (slotB && (presentWindow || useActiveBezel)) throw new Error("comparison slot B does not own a presentation window or active bezel");
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
      if (slotB) clearHostB(sessionKey); else disposeHost(sessionKey);
      const host = NATIVE_RUNTIME_HOSTS[platform]();
      const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
      await host.loadMedia({
        platform,
        ...(bytes ? { bytes } : { path }),
        ...(deterministicSeed !== undefined ? { deterministic: { seed: deterministicSeed, ...(deterministicStepMs !== undefined ? { stepMs: deterministicStepMs } : {}) } } : {}),
        // presentWindow gives a GL cart its OWN GL context so a later
        // playtest window can bind it and present by GPU swap instead of
        // reading every frame back to the CPU. It has to be decided here
        // because the context is bound when the cart's wasm loads and cannot
        // be swapped afterward.
        ...(presentWindow ? { presentWindow: true } : {}),
        // WebGPU carts: which GPU on a two-GPU machine (wasmcart's
        // adapterOptions.powerPreference). Unset = WASMCART_WGPU_POWER from
        // the server's environment, else the driver's default.
        ...(gpuPower ? { gpuPower } : {}),
        // wgpu:false: act as a host without WebGPU (wasmcart's own option),
        // so a dual cart runs on GL and a WebGPU-only cart is refused.
        ...(wgpu === false ? { wgpu: false } : {}),
      });
      if (slotB) installHostB(sessionKey, host); else installHost(sessionKey, host);
      if (!slotB && (path || bytes)) rememberLastMedia(sessionKey, { platform, path, fromBase64: !!bytes });
      const caps = host.getCapabilities();
      const result = {
        loaded: true, platform, kind: caps.kind,
        ...(slotB ? { slot: "b" } : {}),
        mediaKind: host.status.mediaKind,
        ...(bytes ? { bytes: bytes.length } : { path: host.status.mediaPath }),
        fbWidth: host.status.fbWidth, fbHeight: host.status.fbHeight,
        // wasmcart carts: which GPU API the cart runs on ('webgpu', 'gl', or
        // null for a 2D cart), so an agent knows how its frames come back.
        ...(host.status.gpu !== undefined ? { gpu: host.status.gpu } : {}),
        // WebGPU carts: the GPU it actually got, to assert on (two-GPU machines).
        ...(host.status.gpuAdapter ? { gpuAdapter: host.status.gpuAdapter } : {}),
        ...(deterministicSeed !== undefined ? { deterministicSeed: host.status.deterministicSeed } : {}),
        // A cart whose WCInfo leaves inputPtr/timePtr at 0 gets no input or
        // clock (the host refuses to write them over linear offset 0). Say so
        // at load, where it is cheapest to act on.
        ...(host.status.abiWarnings?.length ? { abiWarnings: host.status.abiWarnings } : {}),
        capabilities: caps,
      };
      // Push the first frame to the /livestream observer, same as an emulator load.
      if (!slotB) attachObserverFrame(result, host, `${platform} loaded`);
      return result;
    }

    if (core && !coresFor(platform).includes(core)) throw new Error(`loadMedia: core '${core}' is not a ${platform} core (${coresFor(platform).join(", ") || "none"})`);
    const resolved = resolveCore(platform, core);
    if (!resolved) throw new Error(`no ${core ? core + " " : ""}core available for platform '${platform}'`);
    const slotB = slot === "b";
    const host = slotB ? resetHostB(sessionKey) : resetHost(sessionKey);
    await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender, noderawfs: resolved.noderawfs });
    // a coprocessor's firmware or data ROM the core reads from its system directory (snes9x: dsp1b.data.rom, st011.rom, ...; bsnes: st011.rom, ...)
    if (firmware) {
      if (!existsSync(firmware)) throw new Error(`loadMedia: firmware: no file at ${firmware}`);
      if (!host.mod?.FS) throw new Error(`loadMedia: the ${resolved.coreName} core has no file system to put firmware in`);
      host.mod.FS.mkdirTree(host.state.systemDir);
      host.mod.FS.writeFile(nodePath.join(host.state.systemDir, nodePath.basename(firmware)), new Uint8Array(readFileSync(firmware)));
    }
    const bytes = base64 ? new Uint8Array(Buffer.from(base64, "base64")) : undefined;
    await host.loadMedia({
      platform,
      ...(bytes ? { bytes, virtualName } : { path }),
      // Only force a mediaKind when the caller picked one; otherwise let the host
      // derive it from the file extension (a C64 .d64 → "disk", .tap → "tape",
      // .prg → "program") so status reports the kind correctly.
      ...(mediaKind ? { mediaKind } : {}),
      ...(coreOptions ? { coreOptions } : {}),
    });

    // Pre-seed cheats BEFORE the first frame - so a boot-time cheat (e.g. a Game
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
    // Only for slot A - the breadcrumb is the primary ROM's recovery anchor;
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
      if (slotB) throw new Error("Active Bezels are not supported on slot 'b' - it is comparison scratch and never drives the presented frame.");
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
    // frame - before that, fbWidth/fbHeight hold a pre-boot default (e.g.
    // 256×192 on Genesis) that does NOT match the real output resolution
    // (256×224 after booting). Reporting it here misleads any agent that routes
    // on dimensions, so we omit it until a frame has been stepped and point the
    // caller at stepFrames instead.
    const framebufferKnown = host.status.frameCount > 0 || host.status.settleFramesUsed > 0;
    // SETTLE FRAMES ARE REAL EXECUTION. loadMedia runs the core until it emits
    // its first video_refresh plus a few more (so framebuffer geometry is the
    // ROM's, not a pre-init default), and deliberately does NOT count them in
    // frameCount - "the first stepFrames(N) advances the count by exactly N".
    //
    // The cost of that is a frameCount of 0 that does NOT mean "nothing has
    // executed": the game's boot code has already run and written RAM. A client
    // comparing two slots at offset 0 read the settled values as a hardware
    // power-on pattern and concluded it was cart-dependent; measured with the
    // settle loop suppressed, every cart tested reads the SAME byte there and
    // the differences are entirely what each game had overwritten by then.
    // Report the count so nobody has to infer it.
    const settleFrames = host.status.settleFramesUsed || 0;
    const payload = jsonContent({
      loaded: true,
      platform,
      ...(slotB ? { slot: "b" } : {}),
      core: resolved.coreName,
      mediaKind: host.status.mediaKind,
      ...(bytes ? { bytes: bytes.length } : { path: host.status.mediaPath }),
      ...(settleFrames > 0 ? { settleFrames, settleNote: `The core ran ${settleFrames} warm-up frames during load to resolve real framebuffer geometry. They are NOT counted in frameCount (which stays 0 so your first frame({op:'step', frames:N}) advances it by exactly N), but they ARE real execution: the game's boot code has run and written RAM. Memory read now is post-boot state, not hardware power-on state.` } : {}),
      ...(framebufferKnown
        ? { framebuffer: { width: host.status.fbWidth, height: host.status.fbHeight } }
        : { framebufferNote: "Framebuffer dimensions are unknown until the core runs - call frame({op:'step'}) first, then catalog({op:'status'}) (the pre-boot default does not match the real output resolution)." }),
      ...(appliedCheats ? { cheats: appliedCheats } : {}),
      ...(activeBezel ? { activeBezel } : {}),
    });
    // Livestream: only slot A drives the human's view (the session's main ROM).
    // Slot B is comparison scratch - surfacing it would flip the livestream
    // back and forth between two ROMs. frame({op:'sideBySide'}) is what shows B.
    if (slotB) return payload;
    return attachObserverFrame(payload, host, `loaded ${host.status.mediaPath ? host.status.mediaPath.split("/").pop() : platform}`);
  }

  server.tool(
    "loadMedia",
    "Load a ROM/disk/tape/program into a fresh host - resolves the libretro core automatically. " +
    "Pass `path` (file on disk) OR `base64` (ROM bytes - e.g. straight from build, no disk write, " +
    "for a fast iteration loop). `cheats` apply BEFORE the first frame (one call instead of loadMedia + " +
    "cheats({op:'apply'})), so a boot-time code that changes a value the reset code reads is in effect from frame 0. " +
    "`slot:'b'` loads into the SECONDARY comparison host (a different platform is fine) so two cores can run " +
    "at once for frame({op:'sideBySide'}) - the original-vs-port compare loop; slot B does not affect slot A " +
    "or the livestream. " +
    "NOTE: framebuffer dimensions are omitted until you step frames (frame({op:'step'})) - the pre-boot default does not match the " +
    "real output resolution.",
    {
      platform: z.string().describe("Platform id (e.g. 'nes', 'gb', 'c64'). Use platform({op:'list'}) to discover."),
      path: z.string().optional().describe("Absolute path to the media file. Provide this OR `base64`."),
      base64: z.string().optional().describe("Base64-encoded media bytes. Provide this OR `path`."),
      mediaKind: z.enum(MEDIA_KINDS).optional().describe("Default 'cartridge' for consoles, 'program' for C64."),
      virtualName: z.string().optional().describe("With `base64`: virtual filename shown to cores that fopen() the path (default '/rom')."),
      cheats: z.array(z.string()).max(64).optional().describe("Codes applied before the first frame (Game Genie / raw ADDR:VAL[:COMPARE] / native device codes). A raw ROM-address code is re-encoded to a read-intercept so it doesn't silently no-op. Returns a per-code `cheats:[{code, appliedAs, applied}]` report."),
      slot: z.enum(["a", "b"]).default("a").describe("'a' (default) = the session's primary host (what every other tool uses). 'b' = the secondary comparison host used by frame({op:'sideBySide'}); load the second ROM here. Slot B is independent scratch - it keeps no recovery breadcrumb and never drives the livestream."),
      useActiveBezel: z.boolean().default(false).describe("Load the same-basename Active Bezel sidecar beside the ROM ('Game.nes' -> 'Game.ab') and run it after every core frame, making the COMPOSITE the default presented/captured picture. An Active Bezel is an executable companion that reads the core's live memory and renders the whole scene - a map, a HUD, reconstructed world graphics - around or over the game. Fails loudly if no sidecar exists rather than quietly loading the ROM alone. Default false: omit it and loadMedia behaves exactly as it always has."),
      activeBezelPath: z.string().optional().describe("Explicit package path (a .ab archive OR an unpacked directory), overriding same-basename discovery. This is a DEVELOPMENT override for iterating on a package that doesn't live beside the ROM yet - ordinary use should rely on discovery."),
      activeBezelConfig: z.record(z.string(), z.any()).optional().describe("Per-package settings, validated against the manifest's settings schema (e.g. {show_map:true})."),
      activeBezelForce: z.boolean().default(false).describe("Load the package even when the ROM hash does not match what it declares support for. The composite may be meaningless - a map keyed to another revision's RAM layout draws confidently wrong things - so this is for development, not for trusting the output."),
      activeBezelRenderer: z.enum(["software", "gpu"]).optional().describe("Force the compositor. Default: GPU when the package requests it and a GL context is available, else the CPU compositor. 'software' pins the CPU path, which is fully featured and deterministic - the right choice for golden-frame comparisons."),
      deterministicStepMs: z.number().positive().max(1000).optional().describe("wasmcart only, with deterministicSeed: the virtual clock step in ms per frame (default 1000/60). Use a whole number (e.g. 16) to match an engine that runs on integer milliseconds, such as a native build run with a fixed frame time, so the two can be compared frame for frame."),
      deterministicSeed: z.number().int().min(0).optional().describe("wasmcart only: load as a DETERMINISTIC REPLAY - fixed virtual clock + this u32 RNG seed delivered to the cart's wc_set_seed before init. Same seed + same input script = an identical frame sequence (airtight frameHash regression goldens). Only meaningful for carts that declare WC_FLAG_DETERMINISTIC (check capabilities.hasDeterministic after load); other carts get the fixed clock but keep their own entropy."),
      core: z.string().optional().describe("Run the platform on a second core instead of its default (snes: 'bsnes', the accuracy reference for the firmware coprocessors ST010/ST011/ST018, with the same memory region ids as snes9x). Omitted: the platform's own core."),
      firmware: z.string().optional().describe("Path to a coprocessor firmware or data ROM file the core reads from its system directory; copied there under its file name before the ROM loads. romdev ships no chip firmware or data. snes9x: dsp1b.data.rom (2048 bytes, the DSP-1B's data ROM; or dsp1b.rom, 8192) for DSP-1 carts, dsp3.data.rom for DSP-3, st010.data.rom for ST010 (without it such a cart is refused with the file named), and st011.rom / st018.rom (the program ROM then the data ROM) to run those chips on ares's code. bsnes: the chip's firmware (e.g. dsp1b.rom, st010.rom, st011.rom, st018.rom; cx4.data.rom is optional, without it the Cx4 runs bsnes's high-level emulation)."),
      coreOptions: z.record(z.string(), z.string()).optional().describe("Libretro core options applied before the ROM loads, overriding the core's defaults (e.g. {\"snes9x_layer_3\":\"disabled\"} hides a layer at the RENDERER so an Active Bezel can own it - game state and VRAM are untouched). Keys/values are core-specific and unvalidated: a wrong key is silently ignored by the core, so verify the effect visually."),
      gpuPower: z.enum(["low-power", "high-performance"]).optional().describe("wasmcart WebGPU carts only: which GPU the cart runs on, on a machine with two ('low-power' = the integrated GPU, 'high-performance' = the discrete one). Unset: the server's WASMCART_WGPU_POWER, else the driver's default. The load result's gpuAdapter names the GPU the cart actually got ({vendor, architecture, device, description, featureLevel, powerPreference}); assert on it if your work must stay off a GPU. Must be set at load time. No effect on GL or 2D carts."),
      wgpu: z.boolean().optional().describe("wasmcart carts only: false makes this load act as a host WITHOUT WebGPU. A dual cart (imports both GL and WebGPU) then runs on GL, so you can compare its two renderers on one server; a WebGPU-only cart is refused at load with the reason. Default: WebGPU where the server has it."),
      presentWindow: z.boolean().optional().describe("wasmcart GL carts only: load this cart on its OWN GL context so a later playtest({op:'open'}) can present it by GPU blit+swap instead of reading every frame back to the CPU. Measured on a 1080p 3D cart: convertMs 3.52 -> 0, window cost ~7.45ms -> ~2.0ms at a steady 60fps. Pass it when you intend to open a window for a HUMAN to play a 3D/GL cart; skip it for headless work, where the readback is what you want anyway. MUST be set at load time - the GL context binds when the cart's wasm loads and cannot be swapped afterward, so a cart already loaded without it keeps the readback path until reloaded. CAPTURES ARE UNAFFECTED BY CONTRACT: frame({op:'screenshot'}) and playtest({op:'framebuffer'}) return the full cart frame at the cart's resolution, byte-identical to a plain load, and capture dimensions are a function of the CART only - nothing a human does to the window (drag, F11) changes them. Costs one extra GL context per loaded cart; a cart loaded WITHOUT it shares the process-wide offscreen context, which can never be attached to a window (doing so would drag every other session's cart into that window). No effect on 2D carts or emulator cores."),
    },
    safeTool(doLoadMedia),
  );


  server.tool(
    "host",
    "Emulator host lifecycle. `op`: 'unload' | 'shutdown' | 'reset' | 'pause' | 'resume' | 'play' | 'stop'. " +
    "(Loading media is the separate `loadMedia` tool.)\n" +
    "'unload': drop the current media but keep the core hot (for a fast ROM swap). 'shutdown': tear the host down " +
    "entirely (a later loadMedia makes a fresh one).\n" +
    "'reset': DEFAULT is a SOFT reset (the RESET button - retro_reset; on most cores does NOT clear work RAM, so " +
    "boot-seeded variables PERSIST). Pass `hard:true` for a TRUE power-cycle that reloads the ROM from scratch and " +
    "clears RAM + re-seeds boot state - use it when re-testing boot-time behavior (a soft reset boots the PREVIOUS " +
    "state).\n" +
    "'pause': halt emulation (frame steps advance nothing until resume). 'resume': continue.\n" +
    "'play': run this session in REAL TIME on the server for `seconds` (default 60, max " + PLAY_MAX_SECONDS + ") from ONE call, " +
    "so the /livestream shows the game moving. Returns at once. Use it instead of looping frame({op:'step'}) to keep " +
    "the stream alive - never poll. The run ends when its seconds elapse, on host({op:'stop'}), on ANY other tool " +
    "call on this session (you are driving again; catalog status reads excepted), or if the media goes away. Input " +
    "set beforehand with input({op:'set'}) stays held; a self-playing (autopilot/attract) cart plays itself. Refused " +
    "while a human playtest window is open (it already runs in real time). 'stop': end a play run now and report " +
    "framesRun.\n" +
    "`slot:'b'` targets the secondary comparison host (loaded via loadMedia({slot:'b'})). Slot-B ops never " +
    "touch the livestream.",
    {
      op: z.enum(["unload", "shutdown", "reset", "pause", "resume", "play", "stop"]).describe("unload media; shutdown the host; reset (soft/hard); pause; resume; play = real-time run on the server for `seconds` (livestream); stop = end a play run."),
      seconds: z.number().positive().max(PLAY_MAX_SECONDS).default(60).describe(`op=play: how long to run in real time (default 60, max ${PLAY_MAX_SECONDS}).`),
      hard: z.boolean().default(false).describe("op=reset: true = full power-cycle (reload the ROM; clears work RAM + boot-seeded state). false (default) = soft RESET-button reset (RAM persists)."),
      slot: z.enum(["a", "b"]).default("a").describe("'a' (default) = the primary host. 'b' = the secondary comparison host (frame sideBySide)."),
    },
    safeTool(async ({ op, hard, slot, seconds }) => {
      const slotB = slot === "b";
      const get = slotB ? getHostB : getHost;
      const getOrNull = slotB ? getHostBOrNull : getHostOrNull;
      // Slot B never drives the human's livestream - wrap attachObserverFrame so
      // slot-A behavior is unchanged but slot B stays silent.
      const observe = slotB ? (content) => content : attachObserverFrame;
      switch (op) {
        case "unload": {
          const host = getOrNull(sessionKey);
          if (!host || !host.status.loaded) {
            // Don't claim success when there was nothing loaded - that masks a
            // session/state mix-up (the agent thinks it unloaded media it never had).
            return textContent(`nothing to unload - no media is loaded in ${slotB ? "comparison slot B" : "this session"}`);
          }
          if (!slotB) stopPlay(sessionKey, "unload");
          // Emulator hosts unload the ROM and keep the core; the native-runtime
          // hosts (WasmcartHost, JsGameHost) have no separate unload, so tearing
          // the cart down IS the unload (status.loaded goes false).
          if (typeof host.unloadMedia === "function") host.unloadMedia();
          else host.destroy();
          // The package is bound to this ROM's hash; keeping it across an unload
          // would leave one game's map ready to composite over another's picture.
          const hadBezel = slotB ? false : detachActiveBezel(sessionKey);
          return textContent(`unloaded${slotB ? " (slot B)" : ""}${hadBezel ? " (Active Bezel detached)" : ""}`);
        }
        case "shutdown":
          if (slotB) clearHostB(sessionKey);
          else {
            stopPlay(sessionKey, "shutdown");
            detachActiveBezel(sessionKey);
            clearHost(sessionKey);
            // Shutdown means the SESSION is done, not just its emulator. The
            // HTTP route holds a ~20 MB tool registry and a livestream entry
            // per session, and without this they outlived every clean
            // shutdown by 30 idle minutes -- a suite that opened and dutifully
            // shut down ~53 sessions still left ~1 GB of registries behind.
            // Announced as an event because the session records live behind
            // transport-layer closures this tool cannot (and should not)
            // reach. A later call on the same key just re-creates the session.
            emitSessionEnd(sessionKey);
          }
          return textContent(`shutdown complete${slotB ? " (slot B)" : ""}`);
        case "reset": {
          const host = get(sessionKey);
          if (hard) {
            const reloaded = await host.hardReset();
            // Keep the package across a reset (same ROM) but tell it continuity
            // broke, so it discards caches built from a timeline that no longer
            // exists rather than drawing a stale interpretation of fresh state.
            if (!slotB) notifyActiveBezel(sessionKey, "reset");
            return observe(textContent(reloaded ? "reset (hard / power-cycle - RAM cleared)" : "reset (soft - no cached ROM to reload for a hard reset)"), host, "reset (hard)");
          }
          host.reset();
          if (!slotB) notifyActiveBezel(sessionKey, "reset");
          return observe(textContent("reset (soft - RESET button; work RAM persists, use hard:true to clear it)"), host, "reset");
        }
        case "pause":
          get(sessionKey).pause();
          return textContent(`paused${slotB ? " (slot B)" : ""}`);
        case "resume":
          get(sessionKey).resume();
          return textContent(`resumed${slotB ? " (slot B)" : ""}`);
        case "play": {
          if (slotB) throw new Error("host({op:'play'}): slot B never drives the livestream - play runs slot A only.");
          const host = get(sessionKey);
          if (!host.status?.loaded) throw new Error("host({op:'play'}): no media loaded - loadMedia first.");
          if (getPlaytestHumanStatus(sessionKey).windowOpen) throw new Error("host({op:'play'}): a playtest window is open on this session and already runs it in real time.");
          const r = startPlay(sessionKey, host, { seconds: seconds ?? 60 });
          return jsonContent({ playing: true, seconds: r.seconds, fps: r.fps, endsAt: new Date(r.endsAt).toISOString(),
            note: "runs on the server; any other call on this session (except catalog) or host({op:'stop'}) ends it" });
        }
        case "stop": {
          const r = stopPlay(sessionKey, "stop");
          return r ? jsonContent({ stopped: true, ...r }) : textContent("nothing playing on this session");
        }
        default:
          throw new Error(`host: unknown op '${op}'`);
      }
    }),
  );

  // getStatus folded into catalog({op:'status'}) (entry-tier, in index.js).
}
