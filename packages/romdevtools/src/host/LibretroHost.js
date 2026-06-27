// LibretroHost — Node-side host for a single Emscripten libretro core.
//
// One instance = one platform's core loaded + (optionally) one ROM. The host
// exposes a small public API the MCP layer wraps:
//
//   loadCore(jsPath, wasmPath?)
//   loadMedia({ platform, path, mediaKind? })
//   unloadMedia()
//   stepFrames(n)
//   getFramebuffer() / screenshot()
//   setInput(frameInput)
//   saveState(name) / loadState(name) / listStates()
//   readMemory(region, offset, length) / writeMemory(region, offset, bytes)
//   reset() / pause() / resume() / getStatus()
//
// Patterns drawn from retroemu/LibretroHost.js + wasmcart-libretro/libretro.c.
// See memory `libretro-wasm-patterns`.

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadLibretroCore } from "./coreLoader.js";
import { newCallbackState, registerCallbacks } from "./callbacks.js";
import { framebufferToRgba, framebufferToScreenshot } from "./framebuffer.js";
import {
  MemoryRegionToRetro,
  defaultMediaKind,
  portInputToMask,
} from "./types.js";

/**
 * Per-platform core-option overrides applied before retro_load_game.
 * Most cores work with their menu-defaults; a few need explicit values
 * to function headlessly (no menu = no user pick). Empty today — all
 * shipped cores load with their defaults.
 */
// Core filename stem → platform, for the cores whose renderer (or other boot-time
// behavior) is chosen from an option at retro_init. loadCore uses this to pre-seed
// PLATFORM_CORE_OPTIONS before the core registers its variables, so the override
// wins over the core's default (e.g. glide64-GL over angrylion-software for N64).
const CORE_STEM_TO_PLATFORM = {
  parallel_n64: "n64",
  pcsx_rearmed: "ps1",
  flycast: "dreamcast",
  beetle_psx_hw: "ps1",
};

const PLATFORM_CORE_OPTIONS = {
  // blueMSX defaults its machine to "SEGA - SC-3000" (an SG-1000 clone, wrong for
  // MSX carts). Force the open MSX2+ C-BIOS machine — a superset that also runs
  // MSX1 carts — so homebrew boots with no proprietary BIOS. The matching
  // `… - C-BIOS` machine tree ships in romdev-core-bluemsx/bios and is mirrored
  // into the wasm FS as the system dir (see loadMedia + resolveSystemDir).
  msx: { bluemsx_msxtype: "MSX2+ - C-BIOS" },
  // geargrafx ships with the TurboTap disabled, which makes port-1 input
  // unreachable in-game (every pad scan slot mirrors pad 0). Enabling it
  // costs nothing for 1P games (slot 0 still reads pad 0) and routes the
  // host's port-1 input to pad slot 2 — PCE 2P works (probed 2026-06-10
  // during the ZENITH BARRAGE gold round).
  pce: { geargrafx_turbotap: "Enabled" },
  // parallel_n64 defaults to a software gfx plugin that never presents to our GL
  // FBO. Force glide64 (the GL renderer) so HW render actually produces frames.
  n64: { "parallel-n64-gfxplugin": "glide64" },
  // beetle_psx_hw defaults to the software renderer; force hardware_gl so it
  // renders through the GL context the host set up (otherwise no FBO frames).
  ps1: { beetle_psx_hw_renderer: "hardware_gl" },
  // Flycast defaults to THREADED rendering — the render thread + the main thread's
  // wait on it makes retro_run unwind under emscripten pthreads (yields to the event
  // loop, incompatible with our synchronous frame-step). Disable it so render() runs
  // synchronously on the calling thread (Emulator::render → run(), no cross-thread
  // wait). Also keep per-frame sync (no auto frame-skip) so one retro_run = one frame.
  // hle_bios (reios) MUST be on: it's flycast's HLE BIOS, and only the reios boot
  // path loads a raw homebrew .elf (reios_loadElf copies PT_LOAD segments to their
  // vaddr + jumps). With it off (the default), flycast wants a real dc_boot.bin we
  // don't ship → the .elf never loads (RAM stays empty, CPU never runs our code).
  // emulate_framebuffer scans out the DC framebuffer directly on every VBlank (the 2D
  // path, no TA list) — so simple homebrew that writes RGB565 pixels to VRAM presents
  // reliably without building a full PowerVR2 tile list. (Threaded rendering is also
  // force-disabled in the core itself; the option here is belt-and-suspenders.)
  dreamcast: {
    flycast_threaded_rendering: "disabled",
    flycast_hle_bios: "enabled",
    flycast_emulate_framebuffer: "enabled",
  },
  // VICE mounts a .d64/.tap/.crt but, with autostart off, just sits at the BASIC
  // `READY.` prompt — the agent would see a blue boot screen, not the game. Force
  // autostart so a disk/tape image runs the first program automatically (same as
  // typing LOAD"*",8,1 : RUN). warp-during-autostart skips the slow 1541 load so
  // the game is up in a fraction of the wall-clock. A bare .prg is injected and
  // run directly by the core regardless of this; it matters for disk/tape/cart.
  c64: {
    vice_autostart: "enabled",
    vice_autoloadwarp: "enabled",
    vice_warp_boost: "enabled",
    // Leave the mounted disk WRITABLE so a save-capable game can write its save
    // files back into the .d64 (VICE updates the in-FS image in place). Without
    // this a game's SAVE silently fails / errors — defeating disk-save support.
    vice_floppy_write_protection: "disabled",
    // TWO live C64 control ports so 2P games see player 2. The VICE core drives
    // ONE control port per RetroPad by default (every retro port → cur_port);
    // the per-port split only happens with the userport adapter, where the
    // mapper does vice_port = cur_port + retro_port. With joyport=1 + a userport
    // adapter that gives retro0→control-port-1, retro1→control-port-2 — BOTH
    // standard ports live. Our games read P1 on control port 2 ($DC00) and P2
    // on port 1 ($DC01); the host swaps the two retro ports below
    // (portInputToMask C64 path) so host port 0 = P1 (control port 2) and host
    // port 1 = P2 (control port 1), matching the universal "port 0 = player 1"
    // convention. Verified: drives both paddles independently in 2P, 1P-vs-CPU
    // still reachable. (Both options ship in the wasm — no core rebuild.)
    vice_joyport: "1",
    vice_userport_joytype: "HIT",
  },
};

/**
 * Platforms whose core fopen()s a BIOS / machine-config tree from the system
 * directory, mapped to the @romdev package + subdir that ships it. When the
 * caller passes no systemDir, the host resolves the bundled tree from here so
 * the platform boots with zero setup.
 */
const PLATFORM_SYSTEM_DIR = {
  msx: { pkg: "romdev-core-bluemsx", export: "biosDir" },
};

/**
 * Resolve the absolute path of a platform's bundled system/BIOS dir, or null if
 * the platform needs none / the package isn't resolvable. Best-effort: any
 * failure falls back to null (the core then boots with whatever default it has).
 * @param {string} platform
 * @returns {string | null}
 */
function resolvePlatformSystemDir(platform) {
  const entry = PLATFORM_SYSTEM_DIR[platform];
  if (!entry) return null;
  try {
    const dir = path.dirname(fileURLToPath(import.meta.resolve(entry.pkg)));
    const biosDir = path.join(dir, "bios");
    if (existsSync(biosDir)) return biosDir;
  } catch { /* package not resolvable */ }
  return null;
}

/**
 * Recursively copy a host directory into the emscripten virtual FS so a core's
 * fopen() can read it (BIOS / machine-config trees). emscripten FILESYSTEM=1
 * MEMFS is enough — no NODEFS rebuild needed.
 * @param {any} FS the core module's FS
 * @param {string} hostDir absolute host path
 * @param {string} fsDir destination path inside the wasm FS (e.g. "/system")
 */
function mirrorDirToFS(FS, hostDir, fsDir) {
  try { FS.mkdir(fsDir); } catch { /* exists */ }
  for (const name of readdirSync(hostDir)) {
    const hostPath = path.join(hostDir, name);
    const fsPath = fsDir + "/" + name;
    const st = statSync(hostPath);
    if (st.isDirectory()) {
      mirrorDirToFS(FS, hostPath, fsPath);
    } else if (st.isFile()) {
      try { FS.writeFile(fsPath, readFileSync(hostPath)); } catch { /* skip */ }
    }
  }
}

/**
 * When loadMedia is called with `bytes:` and no `virtualName`, this is
 * the extension we tack onto "/rom" so the core knows which platform
 * it's looking at. Critical for shared cores — genesis_plus_gx looks
 * at the path extension to pick SMS vs GG vs Genesis vs Master System.
 * Round 26 fix: pre-r26, in-memory GG loads landed as SMS because the
 * default virtualName was "/rom" with no extension.
 */
export const PLATFORM_VIRTUAL_EXT = {
  nes:        ".nes",
  snes:       ".sfc",
  genesis:    ".md",
  megadrive:  ".md",
  md:         ".md",
  sms:        ".sms",
  gg:         ".gg",
  gb:         ".gb",
  gbc:        ".gbc",
  gba:        ".gba",
  c64:        ".prg",
  lynx:       ".lnx",
  atari2600:  ".a26",
  atari7800:  ".a78",
  pce:        ".pce",
  msx:        ".rom",
};
import { RETRO_DEVICE_JOYPAD, ROMDEV_PIXEL_FORMAT_RGBA8888 } from "./retroConstants.js";

// C64 controller→keyboard map (the Batocera/RetroDeck model: a CONTROLLER alone
// plays C64 — no physical keyboard needed — by mapping spare buttons/stick to
// the C64 keyboard keys games need at setup screens). Keyed by the button NAME
// setInput receives (libretro + spatial names + the playtest right-stick virtual
// buttons c64_f1..f7). The joystick itself (d-pad + Fire) is NOT here — those
// stay a real joypad. Everything here is routed to the key matrix instead.
//   B / south = Fire        → joystick (handled as joypad, not a key)
//   X / west  = Space        L2 = Run/Stop   R2 / start = Return
//   R-stick   = F1/F3/F5/F7  (playtest emits c64_f1..f7 from the right stick)
const C64_BUTTON_KEYS = {
  west: "space", y: "space",
  l2: "run/stop",
  r2: "return", start: "return",
  c64_f1: "f1", c64_f3: "f3", c64_f5: "f5", c64_f7: "f7",
  north: "f1", x: "f1",   // also expose F1 on the top face (1-player select is the #1 need)
};
// The buttons that ARE the C64 joystick (pass through to the joypad mask):
const C64_JOY_BUTTONS = new Set(["up", "down", "left", "right", "b", "south", "a", "east"]);

// C64 keyboard matrix: key name (lowercase) → [row, col] in the 8×8 matrix the
// KERNAL scans via CIA1. Drives romdev_key_matrix() in the VICE core. Values
// taken from VICE's own C64 positional keymap (data/C64/sdl_pos_uk.vkm).
// Covers the keys RE/startup flows need; extend as needed.
const C64_KEY_MATRIX = {
  // function keys (the common "1 player / start" selectors)
  f1: [0, 4], f3: [0, 5], f5: [0, 6], f7: [0, 3],
  // editing / control
  return: [0, 1], enter: [0, 1], space: [7, 4], del: [0, 0], backspace: [0, 0],
  "run/stop": [7, 7], runstop: [7, 7], stop: [7, 7],
  ctrl: [7, 2], cbm: [7, 5], commodore: [7, 5],
  lshift: [1, 7], rshift: [6, 4], home: [6, 3], clr: [6, 3],
  // cursor keys (C64 has DOWN + RIGHT; UP/LEFT are the shifted forms — use
  // shift+down / shift+right for those)
  "crsr-down": [0, 7], "crsr-right": [0, 2], down: [0, 7], right: [0, 2],
  // digits
  "0": [4, 3], "1": [7, 0], "2": [7, 3], "3": [1, 0], "4": [1, 3],
  "5": [2, 0], "6": [2, 3], "7": [3, 0], "8": [3, 3], "9": [4, 0],
  // letters
  a: [1, 2], b: [3, 4], c: [2, 4], d: [2, 2], e: [1, 6], f: [2, 5],
  g: [3, 2], h: [3, 5], i: [4, 1], j: [4, 2], k: [4, 5], l: [5, 2],
  m: [4, 4], n: [4, 7], o: [4, 6], p: [5, 1], q: [7, 6], r: [2, 1],
  s: [1, 5], t: [2, 6], u: [3, 6], v: [3, 7], w: [1, 1], x: [2, 7],
  y: [3, 1], z: [1, 4],
};

export class LibretroHost {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.systemDir] absolute path the core can ask about
   * @param {string} [opts.saveDir] absolute path the core can ask about
   * @param {(level: number, msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "romdev-"));
    /** @type {any | null} */
    this.mod = null;
    // The host-disk system dir (BIOS / machine configs). Mirrored into the wasm
    // FS on first loadMedia for cores that fopen() from it (blueMSX C-BIOS).
    this.systemDir = opts.systemDir ?? null;
    this._systemDirMounted = false;
    this.state = newCallbackState({
      systemDir: opts.systemDir ?? tmp,
      saveDir: opts.saveDir ?? tmp,
    });
    this.log = opts.log;
    this.status = {
      platform: null,
      corePath: null,
      mediaPath: null,
      mediaKind: null,
      loaded: false,
      paused: false,
      frameCount: 0,
      fbWidth: 0,
      fbHeight: 0,
    };
    /** @type {Map<string, Uint8Array>} */
    this.namedStates = new Map();
  }

  /**
   * Load a libretro core module. Registers callbacks then runs retro_init.
   * @param {string} jsPath
   * @param {string} [wasmPath]
   * @param {Object} [opts]
   * @param {boolean} [opts.hwRender] this core HW-renders (GL) — n64/ps1. Loads the
   *   optional native GL stack and creates a headless context BEFORE the core boots
   *   (GL calls happen during init/load). The 14 software cores omit this.
   */
  /** Infer the platform from a core's js filename stem (e.g.
   *  ".../parallel_n64_libretro.js" → "n64"), so loadCore can pre-seed that
   *  platform's option overrides without the caller threading the platform
   *  through. Covers the cores whose boot-time renderer choice depends on an
   *  option; returns null otherwise (the overrides are then a no-op anyway). */
  _platformForCore(jsPath) {
    const stem = (jsPath.split("/").pop() || "").replace(/_libretro\.js$/, "");
    return CORE_STEM_TO_PLATFORM[stem] ?? null;
  }

  async loadCore(jsPath, wasmPath, opts = {}) {
    if (this.mod) throw new Error("core already loaded; create a new host");

    let glCanvas = null;
    if (opts.hwRender) {
      // Set up the HW-render path: LibretroGL owns the FBO/readback; a webgl-node
      // mock canvas backs the minified core's GLctx. Both pull the OPTIONAL native
      // GL deps lazily (clear install hint if absent).
      const { LibretroGL } = await import("./LibretroGL.js");
      const { loadWebGl2Context } = await import("./glOptionalDep.js");
      this.hwRender = new LibretroGL();
      await this.hwRender.ensureGl();
      const createWebGL2Context = await loadWebGl2Context();
      const { canvas } = createWebGL2Context(640, 480);
      // Skip Emscripten's Safari WebGL2 workaround (breaks instanceof) by
      // pre-setting the flag it checks.
      canvas.getContextSafariWebGL2Fixed = canvas.getContext;
      glCanvas = canvas;
      this._glContextCreated = true;
      // The env callback routes SET_HW_RENDER to this handler.
      this.state.hwRender = this.hwRender;
    }

    const mod = await loadLibretroCore({ jsPath, wasmPath, glCanvas });
    this.mod = mod;

    // Canvas HW-render cores: initialize the Emscripten GL context so `GLctx` is
    // set BEFORE any GL call (the core's context_reset / first getParameter). Must
    // run before _retro_init.
    if (glCanvas && mod.GL) {
      const handle = mod.GL.createContext(glCanvas, { majorVersion: 2 });
      if (handle > 0) mod.GL.makeContextCurrent(handle);
    }

    registerCallbacks({ mod, state: this.state, log: this.log });

    // Pre-seed per-platform core-option overrides BEFORE _retro_init. The core
    // registers its variables (SET_VARIABLES) during retro_init and decides its
    // renderer THEN — e.g. parallel_n64 reads `parallel-n64-gfxplugin` to pick
    // glide64 (GL/HW-render) vs angrylion (software). Seeding the override here
    // (not in loadMedia, which is too late) makes the SET_VARIABLES handler keep
    // our value instead of the core's default, so HW render engages from boot.
    const platform = opts.platform ?? this._platformForCore(jsPath);
    if (platform) {
      const overrides = PLATFORM_CORE_OPTIONS[platform];
      if (overrides) {
        for (const [key, value] of Object.entries(overrides)) {
          this.state.coreVariables.set(key, { value });
        }
        this.state.variablesUpdated = true;
      }
    }

    mod._retro_init();
    this.status.corePath = jsPath;
  }

  /**
   * Load media (ROM, disk, tape, program). Reads the file from disk,
   * writes a copy into Emscripten's virtual FS so cores that `fopen` the path
   * can find it, and calls `retro_load_game` with a populated `retro_game_info`.
   *
   * `retro_game_info` layout on wasm32:
   *   offset 0:  const char *path  (4 bytes)
   *   offset 4:  const void *data  (4 bytes)
   *   offset 8:  size_t size       (4 bytes)
   *   offset 12: const char *meta  (4 bytes)
   *
   * @param {import("./types.js").LoadMediaArgs} args
   */
  async loadMedia(args) {
    const mod = this._needMod();
    const { platform } = args;
    // Derive the kind from the file/virtual extension when the caller didn't say
    // — so a C64 .d64 reports mediaKind:"disk" (writable save target) vs a .prg
    // "program". For an in-memory load, the virtualName carries the ext.
    const kindExt = path.extname(args.path || args.virtualName || "");
    const mediaKind = args.mediaKind ?? defaultMediaKind(platform, kindExt);

    // Apply per-platform core option defaults BEFORE retro_load_game.
    // Most cores work with their option defaults; a few need explicit
    // overrides for headless use (none today, but the hook stays wired).
    const overrides = PLATFORM_CORE_OPTIONS[platform];
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        this.state.coreVariables.set(key, { value });
      }
      // Cores poll GET_VARIABLE_UPDATE to know when to re-read options.
      this.state.variablesUpdated = true;
    }

    // Some cores fopen() BIOS / machine-config files from the system directory
    // (e.g. blueMSX reads `<systemDir>/Machines/<name>/cbios_*.rom`). When the
    // caller didn't pass a systemDir, resolve the platform's bundled BIOS tree
    // (romdev-core-bluemsx ships the open C-BIOS machines) so MSX "just works".
    if (!this.systemDir) {
      const bundled = resolvePlatformSystemDir(platform);
      if (bundled) this.systemDir = bundled;
    }

    // The emscripten FS is virtual, so the host-disk systemDir isn't visible to
    // the core's fopen unless we mirror it INTO the wasm FS. Do that once per
    // host, and point the core's GET_SYSTEM_DIRECTORY at the in-FS path.
    if (this.systemDir && !this._systemDirMounted && mod.FS) {
      try {
        const FS_SYS = "/system";
        mirrorDirToFS(mod.FS, this.systemDir, FS_SYS);
        // Redirect the core's reported system dir to the in-FS copy.
        if (this.state) this.state.systemDir = FS_SYS;
        this._systemDirMounted = true;
      } catch (e) {
        if (this.log) this.log(3, `system dir mirror failed: ${e.message}`);
      }
    }

    let data, mediaPath, ext;
    if (args.bytes) {
      // In-memory load — no disk involved.
      data = args.bytes instanceof Uint8Array ? args.bytes : new Uint8Array(args.bytes);
      // Round 26 fix: when the caller doesn't pass a virtualName, default
      // the virtual filename's EXTENSION to one the core uses to
      // distinguish platforms it multiplexes. genesis_plus_gx shares one
      // .wasm across SMS/GG/Genesis and dispatches off the extension —
      // without `.gg` the core treats a GG ROM as SMS, silently. Same
      // shape for any shared-core platform.
      const defaultExt = PLATFORM_VIRTUAL_EXT[platform] ?? "";
      mediaPath = args.virtualName ?? ("/rom" + defaultExt);
      ext = path.extname(mediaPath);
      // Synthesize a stable status path that still encodes the platform
      // when the user didn't supply a name (helpful in logs).
      if (!args.virtualName) mediaPath = "<memory" + defaultExt + ">";
    } else if (args.path) {
      mediaPath = args.path;
      data = await readFile(mediaPath);
      ext = path.extname(mediaPath);
    } else {
      throw new Error("loadMedia requires either `path` or `bytes`");
    }
    const vfsPath = "/rom" + ext;
    if (mod.FS) {
      try {
        mod.FS.writeFile(vfsPath, data);
      } catch (e) {
        if (this.log) this.log(3, `FS.writeFile failed: ${e.message}`);
      }
    }

    // Allocate ROM data into the WASM heap (the core may keep this pointer).
    const dataPtr = mod._malloc(data.length);
    mod.HEAPU8.set(data, dataPtr);

    // Allocate path string.
    const pathStr = mod.FS ? vfsPath : mediaPath;
    const pathBytes = Buffer.from(pathStr + "\0", "utf-8");
    const pathPtr = mod._malloc(pathBytes.length);
    mod.HEAPU8.set(pathBytes, pathPtr);

    // retro_game_info struct (16 bytes on wasm32).
    const infoPtr = mod._malloc(16);
    mod.setValue(infoPtr + 0, pathPtr, "i32");
    mod.setValue(infoPtr + 4, dataPtr, "i32");
    mod.setValue(infoPtr + 8, data.length, "i32");
    mod.setValue(infoPtr + 12, 0, "i32"); // meta = null

    const ok = mod._retro_load_game(infoPtr);

    // Free the struct itself. Don't free pathPtr or dataPtr — the core may
    // retain pointers into them for the life of the loaded game.
    mod._free(infoPtr);

    if (!ok) {
      // This is the failure path for EVERY bad/wrong-platform/corrupt/
      // unsupported-mapper image — the most common loadMedia failure. The core
      // returns a bare false, so name the likely causes + the exact checks
      // rather than leaving the agent with "failed".
      throw new Error(
        `The '${platform}' core REFUSED this ${mediaKind || "media"} ` +
        `(${data.length} bytes${ext ? `, ${ext}` : ""}, path ${mediaPath}). ` +
        `retro_load_game returned false — the bytes reached the core but it would not accept them. ` +
        `Common causes: (1) wrong platform for this file (a GB ROM loaded as 'nes', etc.) — ` +
        `confirm the platform matches the file; (2) a corrupt or TRUNCATED image — re-check the byte length; ` +
        `(3) an unsupported mapper/board or a missing/!bad header. ` +
        `Inspect the file with cart({op:'identify'}) to see what platform/mapper it really is, ` +
        `then load with the matching platform.`,
      );
    }

    this.status.platform = platform;
    this.status.mediaPath = mediaPath;
    this.status.mediaKind = mediaKind;
    this.status.loaded = true;
    this.status.frameCount = 0;

    // Cache enough to re-load this exact media for a true power-cycle
    // (reset({hard:true})). `retro_reset` is only a console RESET-button reset —
    // it does NOT clear work RAM on most cores, so boot-seeded state persists.
    // Stash the raw bytes (a copy, so a later free of the caller's buffer can't
    // corrupt it) + the load descriptor; hardReset() replays loadMedia with it.
    this._loadArgs = {
      bytes: data instanceof Uint8Array ? data.slice() : new Uint8Array(data),
      platform,
      mediaKind,
      virtualName: args.virtualName,
    };

    // Read system_av_info to seed framebuffer dimensions.
    // struct retro_system_av_info {
    //   struct retro_game_geometry {
    //     unsigned base_width;    // +0
    //     unsigned base_height;   // +4
    //     unsigned max_width;     // +8
    //     unsigned max_height;    // +12
    //     float aspect_ratio;     // +16
    //   };                        // 20 bytes
    //   /* 4 bytes pad to align double */
    //   struct retro_system_timing {
    //     double fps;             // +24
    //     double sample_rate;     // +32
    //   };
    // };
    const avInfoPtr = mod._malloc(64);
    mod._retro_get_system_av_info(avInfoPtr);
    this.status.fbWidth = mod.getValue(avInfoPtr + 0, "i32");
    this.status.fbHeight = mod.getValue(avInfoPtr + 4, "i32");
    // aspect_ratio (+16) is the intended DISPLAY aspect (what a CRT would
    // show). Cores often report a non-square value here because the
    // framebuffer doesn't have square pixels — e.g. Atari 2600 ships a
    // 160×210 buffer but the TV showed it ~4:3, SNES ships 256×224 but
    // the CRT stretched it to ~8:7. Falls back to fb shape for cores that
    // report 0 (meaning "pixels are square, just use base_width/height").
    const reportedAspect = mod.getValue(avInfoPtr + 16, "float");
    this.status.displayAspect = reportedAspect > 0
      ? reportedAspect
      : this.status.fbWidth / this.status.fbHeight;
    // timing.sample_rate is at offset +32 (double).
    this.status.audioSampleRate = mod.getValue(avInfoPtr + 32, "double");
    // max_width/max_height (+8/+12) bound the FBO for HW-render cores (the core may
    // render larger than base, e.g. N64 hi-res or PS1 internal upscale).
    const maxW = mod.getValue(avInfoPtr + 8, "i32") || this.status.fbWidth;
    const maxH = mod.getValue(avInfoPtr + 12, "i32") || this.status.fbHeight;
    mod._free(avInfoPtr);

    // HW render: now that AV info is known, create the FBO the core renders into.
    // createContext() also fires the core's context_reset (via dynCall) so it
    // (re)builds its GL resources. The EGL context was already created in loadCore.
    if (this.hwRender?.active) {
      this.hwRender.createContext(maxW, maxH, this._glContextCreated);
    }

    // Configure controller port 0 as joypad (some cores default to NONE).
    mod._retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
    // Port 1 too — needed for 2P. The C64/VICE 2P path (two live control ports)
    // only reads RetroPad port 1 when it's registered as a joypad device.
    mod._retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD);

    // ---- Settle the framebuffer to the ROM's chosen geometry ----
    //
    // av_info above gives the core's GEOMETRIC DEFAULT for the
    // platform, NOT the dimensions the ROM ends up rendering. Most
    // cores ship a power-on default that the ROM overrides during
    // its own VDP/PPU init in the first few frames. Examples:
    //   - genesis_plus_gx defaults to 256×192 (H32, no border) but
    //     most Genesis games switch to 320×224 (H40) in their first
    //     init frame.
    //   - snes9x defaults to 256×224 but games select 256×239 or
    //     512×448 (interlaced) based on PPU regs the ROM sets up.
    //
    // The rom-games agent reasonably expected fbWidth/Height after
    // loadMedia to reflect "what screenshot will show me". Step a
    // small number of frames here so the agent sees the ROM-chosen
    // geometry, not the pre-init default.
    //
    // 8 frames is generous — Genesis games typically settle their
    // VDP in 1-3 frames; SNES in 1; NES in 1-2. The cost is ~5-30 ms
    // on loadMedia, paid once. Skip when loaded paused (caller is
    // already in control).
    if (!this.status.paused) {
      // Settle frames are core warm-up, not agent-visible gameplay
      // frames — don't increment frameCount. From the agent's POV the
      // first stepFrames(N) should advance the count by exactly N.
      //
      // Strategy: step until the core emits its FIRST video_refresh
      // (proven ROM-rendered geometry — pre-init av_info values are
      // useless), THEN step a few more to let any same-frame mode-switch
      // settle (e.g. Genesis ROMs that fire video_refresh in 256×192
      // mode then immediately switch to 320×224 on the next frame).
      //
      // Cap aggressively — 64 frames is just over 1 second on a 60Hz
      // platform and we don't want a pathological ROM blocking
      // loadMedia indefinitely.
      const MAX_SETTLE = 64;
      const FRAMES_AFTER_FIRST_REFRESH = 4;
      const beforeRefreshSnapshot = this.state.lastFrame;
      let stepped = 0;
      let firstRefreshAt = -1;
      while (stepped < MAX_SETTLE) {
        mod._retro_run();
        this._afterRun();
        stepped++;
        if (firstRefreshAt < 0 && this.state.lastFrame && this.state.lastFrame !== beforeRefreshSnapshot) {
          firstRefreshAt = stepped;
        }
        if (firstRefreshAt > 0 && stepped >= firstRefreshAt + FRAMES_AFTER_FIRST_REFRESH) break;
      }
      if (this.state.lastFrame) {
        this.status.fbWidth = this.state.lastFrame.width;
        this.status.fbHeight = this.state.lastFrame.height;
      }
      // Diagnostic: surface what happened in case agents want to know
      // why loadMedia took longer than expected.
      this.status.settleFramesUsed = stepped;
      this.status.settleFirstRefreshAt = firstRefreshAt;
    }
  }

  unloadMedia() {
    const mod = this._needMod();
    if (this.status.loaded) {
      mod._retro_unload_game();
      this.status.loaded = false;
      this.status.platform = null;
      this.status.mediaPath = null;
      this.status.mediaKind = null;
      this.status.frameCount = 0;
    }
  }

  /**
   * Run N frames as fast as possible (no pacing — agent loop, not playback).
   * @param {number} n
   * @returns {number} frames actually run
   */
  stepFrames(n) {
    const mod = this._needMod();
    this._needMedia();
    if (this.status.paused) return 0;
    for (let i = 0; i < n; i++) {
      mod._retro_run();
      this._afterRun();
      this.status.frameCount++;
    }
    if (this.state.lastFrame) {
      this.status.fbWidth = this.state.lastFrame.width;
      this.status.fbHeight = this.state.lastFrame.height;
    }
    return n;
  }

  /** Post-_retro_run hook: HW-render readback. The video callback set
   *  state.hwFramePending during run; now (GL state stable) read back the FBO into
   *  state.lastFrame as an RGBA frame. No-op for the 14 software cores. */
  _afterRun() {
    if (this.state.hwFramePending && this.hwRender?.active) {
      this.state.hwFramePending = false;
      // Crop the GL FBO to the core's reported active resolution (e.g. DC 640x480 in an
      // 853x853 FBO) so screenshots don't carry the dead viewport border.
      const frame = this.hwRender.readbackFrame(this.state.hwFrameW, this.state.hwFrameH);
      if (frame) {
        this.state.lastFrame = {
          width: frame.width, height: frame.height,
          pitch: frame.width * 4, format: ROMDEV_PIXEL_FORMAT_RGBA8888,
          pixels: frame.pixels, rgba: true,
        };
      }
    }
  }

  /** Run exactly ONE frame to refresh the framebuffer, even while paused — for a
   *  deterministic "restore → screenshot" without un-pausing (so the real-time
   *  playtest loop can't race). Advances the (monotonic) frame counter by 1.
   *  Returns the frame count after. */
  renderOneFrame() {
    const mod = this._needMod();
    this._needMedia();
    mod._retro_run();
    this._afterRun();
    this.status.frameCount++;
    if (this.state.lastFrame) {
      this.status.fbWidth = this.state.lastFrame.width;
      this.status.fbHeight = this.state.lastFrame.height;
    }
    return this.status.frameCount;
  }

  /** @returns {{ width: number, height: number, pitch: number, format: number, pixels: Uint8Array }} */
  getFramebuffer() {
    if (!this.state.lastFrame) throw new Error("no frame produced yet — step frames first");
    return this.state.lastFrame;
  }

  /**
   * The loaded cartridge ROM as the CPU's program space starts from, derived
   * from the bytes handed to retro_load_game (the file image, header-stripped
   * per platform). This is NOT a live core memory region — it's the loaded image
   * — but for un-banked platforms (Genesis/GB/SMS/GG: file base == CPU $000000 /
   * $0000) reading offset N here IS "what the CPU fetches at ROM address N", which
   * is exactly what you need to confirm a patch is actually running. For banked
   * platforms (NES PRG, SNES LoROM/HiROM) the file image is correct bytes but the
   * CPU sees them through a mapper, so a file offset is not a flat CPU address.
   *
   * @returns {{ bytes: Uint8Array, base: number, headerSkipped: number, mapped: boolean, platform: string, note: string }}
   */
  getCartRom() {
    if (!this._loadArgs || !this._loadArgs.bytes) {
      throw new Error("no ROM loaded — call loadMedia first");
    }
    const platform = this._loadArgs.platform;
    const raw = this._loadArgs.bytes;
    let headerSkipped = 0;
    let mapped = false;
    let base = 0;
    let note = "File image == CPU ROM space (un-banked): offset N is the byte the CPU fetches at ROM address N.";

    if (platform === "nes") {
      // iNES / NES2.0: 16-byte header, then PRG (then CHR). The CPU sees PRG via
      // the mapper at $8000-$FFFF — file offset is NOT a flat CPU address.
      if (raw.length >= 4 && raw[0] === 0x4e && raw[1] === 0x45 && raw[2] === 0x53 && raw[3] === 0x1a) headerSkipped = 16;
      mapped = true;
      note = "NES PRG-ROM (iNES header skipped). Bytes are correct but the CPU sees them through the mapper at $8000-$FFFF — a file offset is not a flat CPU address. Use findWriter's prgOffset/bank to map a CPU PC to a PRG offset.";
    } else if (platform === "snes") {
      // Copier header: 512 bytes iff (len % 1024) == 512. After that, LoROM/HiROM
      // banking maps the image into $00:8000+ — also not a flat CPU address.
      if ((raw.length % 1024) === 512) headerSkipped = 512;
      mapped = true;
      note = "SNES ROM (copier header skipped if present). Bytes are correct but LoROM/HiROM banking maps them into $xx:8000+ — a file offset is not a flat CPU address.";
    } else if (platform === "gba") {
      mapped = true;
      base = 0x08000000;
      note = "GBA ROM is mapped flat at 0x08000000 — CPU address = 0x08000000 + file offset.";
    }
    // genesis/megadrive, gb, gbc, sms, gg, lynx, pce, c64, msx, atari*: file base
    // is the CPU ROM base (un-banked or banked-from-0), default note applies.

    const bytes = headerSkipped ? raw.subarray(headerSkipped) : raw;
    // `raw` is the FULL on-disk image incl. any header — needed by the banked
    // CPU-address mapping (mapNesAddress expects the iNES header present).
    return { bytes, raw, base, headerSkipped, mapped, platform, note };
  }

  /**
   * Cheap fingerprint of the current frame (FNV-1a over the pixel bytes), for
   * "did the screen change?" checks without retaining a full base64 copy. 0 if
   * no frame yet. Two identical frames hash identically; any pixel diff changes it.
   * @returns {number}
   */
  framebufferHash() {
    if (!this.state.lastFrame) return 0;
    const px = this.state.lastFrame.pixels;
    let h = 0x811c9dc5;
    // Sample stride 1 (every byte) — frames are small (≤256x240x4); the whole
    // buffer hashes in well under a frame's worth of time.
    for (let i = 0; i < px.length; i++) {
      h ^= px[i];
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; // h * 16777619 mod 2^32
    }
    return h >>> 0;
  }

  /** Returns the latest frame as a base64 PNG. */
  screenshot() {
    const f = this.getFramebuffer();
    return framebufferToScreenshot(f.width, f.height, f.pixels, f.pitch, f.format);
  }

  /** Returns the latest frame as flat RGBA8888 bytes — for piping into
   * chafa-wasm or other pixel-consuming tools without the PNG round trip. */
  screenshotRgba() {
    const f = this.getFramebuffer();
    return {
      width: f.width,
      height: f.height,
      rgba: framebufferToRgba(f.width, f.height, f.pixels, f.pitch, f.format),
    };
  }

  /** @param {import("./types.js").FrameInput} input */
  setInput(input) {
    const platform = this.status.platform ?? undefined;
    // C64: route the keyboard-mapped controller buttons (Space/Run-Stop/Return/
    // F1-F7) to the key matrix so a CONTROLLER alone can play — the
    // Batocera/RetroDeck model. The joystick bits (d-pad + Fire) still flow to
    // the joypad mask below. Applies to BOTH playtest and the agent's setInput.
    if (platform === "c64" && this.mod && typeof this.mod._romdev_key_matrix === "function") {
      this._applyC64ButtonKeys(input.ports[0] || {});
    }
    for (let port = 0; port < this.state.inputPorts.length; port++) {
      // C64 2P port swap: with joyport=1 + userport the VICE mapper binds
      // RetroPad 0 → C64 control port 1 and RetroPad 1 → control port 2. But
      // our games read player 1 on control port 2 ($DC00) and player 2 on
      // control port 1 ($DC01). So feed host port 0's input to RetroPad slot 1
      // (→ control port 2 = P1) and host port 1's to slot 0 (→ port 1 = P2),
      // restoring the universal "host port 0 = player 1" convention.
      const srcPort = platform === "c64" ? (port ^ 1) : port;
      const portInput = this._c64StripKeyButtons(input.ports[srcPort], platform);
      this.state.inputPorts[port][0] = portInputToMask(portInput, platform);
    }
  }

  /** C64: press/release matrix keys for the held keyboard-mapped buttons on a
   *  port, edge-tracked so a key releases when its button is no longer held. */
  _applyC64ButtonKeys(portInput) {
    const held = this._c64HeldKeys || (this._c64HeldKeys = new Set());
    const want = new Set();
    for (const [btn, key] of Object.entries(C64_BUTTON_KEYS)) {
      if (portInput[btn] === true) want.add(key);
    }
    // press newly-wanted, release no-longer-wanted
    for (const key of want) {
      if (!held.has(key)) {
        const pos = C64_KEY_MATRIX[key];
        if (pos) this.mod._romdev_key_matrix(pos[0], pos[1], 1);
        held.add(key);
      }
    }
    for (const key of [...held]) {
      if (!want.has(key)) {
        const pos = C64_KEY_MATRIX[key];
        if (pos) this.mod._romdev_key_matrix(pos[0], pos[1], 0);
        held.delete(key);
      }
    }
  }

  /** Strip the C64 keyboard-mapped buttons out of a port so they don't ALSO
   *  press a joystick direction/fire (only the real joystick bits remain). */
  _c64StripKeyButtons(portInput, platform) {
    if (platform !== "c64" || !portInput) return portInput;
    const out = {};
    for (const k of Object.keys(portInput)) {
      if (C64_JOY_BUTTONS.has(k)) out[k] = portInput[k];
    }
    return out;
  }

  /** @param {string} name */
  saveState(name) {
    const snapshot = this.serializeState();
    this.namedStates.set(name, snapshot);
  }

  /**
   * Return the raw save-state blob — every libretro core implements this,
   * so it's the one cross-platform way to peek at internal state the
   * standard memory-region API doesn't expose (e.g. SNES SPC700 + ARAM,
   * Genesis Z80 RAM, GB hardware regs). The blob's layout is core-specific;
   * callers typically grep for known byte patterns to locate regions.
   * @returns {Uint8Array}
   */
  serializeState() {
    const mod = this._needMod();
    const size = mod._retro_serialize_size();
    if (!size) throw new Error("core reports zero serialize size");
    const ptr = mod._malloc(size);
    try {
      const ok = mod._retro_serialize(ptr, size);
      if (!ok) throw new Error("retro_serialize failed");
      return new Uint8Array(mod.HEAPU8.buffer, ptr, size).slice();
    } finally {
      mod._free(ptr);
    }
  }

  /** @param {string} name */
  loadState(name) {
    const snapshot = this.namedStates.get(name);
    if (!snapshot) throw new Error(this._noStateError(name));
    return this.unserializeState(snapshot); // returns # cheats cleared
  }

  /**
   * Restore the emulator from a raw save-state blob (the inverse of
   * serializeState). Used by both the in-memory loadState and the
   * load-from-disk path so they share one code path. The blob must come from
   * the SAME core/platform that produced it — retro_unserialize rejects a
   * size/format mismatch and we surface that as a clear error.
   * @param {Uint8Array} blob
   */
  unserializeState(blob) {
    const mod = this._needMod();
    if (!blob || !blob.byteLength) throw new Error("unserializeState: empty blob");
    const expected = mod._retro_serialize_size();
    if (expected && blob.byteLength !== expected) {
      throw new Error(
        `save-state size mismatch: blob is ${blob.byteLength} bytes but this core expects ${expected}. ` +
        "The state was almost certainly saved from a different platform/ROM — load the matching ROM first.",
      );
    }
    const ptr = mod._malloc(blob.byteLength);
    try {
      mod.HEAPU8.set(blob, ptr);
      const ok = mod._retro_unserialize(ptr, blob.byteLength);
      if (!ok) throw new Error("retro_unserialize failed (core rejected the blob)");
    } finally {
      mod._free(ptr);
    }
    // A save-state restore replaces RAM/CPU/PPU but does NOT carry frontend cheat
    // state — and our active cheats were applied for the PRE-restore run. Clear
    // them so loadState honors its documented "cheats are removed" contract
    // (matches reset()). Returns how many were cleared so callers can report it.
    const cleared = this._activeCheats ? this._activeCheats.size : 0;
    if (cleared) this.clearCheats();
    return cleared;
  }

  listStates() {
    return Array.from(this.namedStates.keys());
  }

  /** Return a named in-memory slot's raw blob (for exporting to disk WITHOUT
   *  disturbing the live host). Throws if the slot doesn't exist. */
  getStateBlob(name) {
    const blob = this.namedStates.get(name);
    if (!blob) throw new Error(this._noStateError(name));
    return blob;
  }

  /** Build a "no save state named X" error that lists the slots that DO exist
   *  (or says there are none) and names the op to create one. */
  _noStateError(name) {
    const names = [...this.namedStates.keys()];
    return names.length
      ? `No save state named '${name}'. Existing in-memory slots: ${names.map((n) => `'${n}'`).join(", ")}. ` +
        `(List them with state({op:'list'}); create one with state({op:'save', name}).)`
      : `No save state named '${name}' — this session has NO in-memory save slots yet. ` +
        `Create one with state({op:'save', name:'${name}'}) first (or load from disk with state({op:'load', path})).`;
  }

  /**
   * @param {import("./types.js").MemoryRegion} region
   * @param {number} offset
   * @param {number} length
   * @returns {Uint8Array}
   */
  /**
   * Byte size of a memory region (0 if the core doesn't expose it). Lets tools
   * read "the whole region from offset" without guessing a length.
   * @param {import("./types.js").MemoryRegion} region
   * @returns {number}
   */
  regionSize(region) {
    const mod = this._needMod();
    const id = MemoryRegionToRetro[region];
    if (id === undefined) return 0;
    return mod._retro_get_memory_size(id) || 0;
  }

  /** gpgx stores 68k work RAM as 16-bit words in host-LE order — the CPU's
   *  byte at $FF0000+A physically lives at work_ram[A^1] (core/macros.h
   *  READ_BYTE/WRITE_BYTE on little-endian builds). Normalize the system_ram
   *  region to CPU byte order here so offset X IS the byte the 68k sees at
   *  $FF0000+X — otherwise every byte-granular tool (search, diff, write,
   *  classify) is off-by-XOR-1 vs disassembly addresses and cheat-DB maps
   *  (self-consistent within raw-only loops, which is why it hid; poisonous
   *  the moment an address crosses to/from the CPU view). */
  _byteSwapRegion(region) {
    return region === "system_ram" && this.status.platform === "genesis";
  }

  readMemory(region, offset, length) {
    const mod = this._needMod();
    // PS1 GPU VRAM (1024×512×16bpp = 1MB) isn't on the RETRO_MEMORY interface; the
    // rebuilt pcsx core exposes it via romdev_vram_get. Serve video_ram from there.
    if (region === "video_ram" && typeof mod._romdev_vram_get === "function") {
      const SIZE = 1024 * 512 * 2;
      if (offset < 0 || offset + length > SIZE) {
        throw new RangeError(`read out of bounds: offset=${offset} len=${length} size=${SIZE}`);
      }
      const p = mod._malloc(SIZE);
      try {
        mod._romdev_vram_get(p, SIZE / 2);
        return new Uint8Array(mod.HEAPU8.buffer, p + offset, length).slice();
      } finally { mod._free(p); }
    }
    const id = MemoryRegionToRetro[region];
    if (id === undefined) throw new Error(this._unknownRegionError(region));
    const ptr = mod._retro_get_memory_data(id);
    const size = mod._retro_get_memory_size(id);
    if (!ptr || !size) throw new Error(this._emptyRegionError(region));
    if (offset < 0 || offset + length > size) {
      throw new RangeError(`read out of bounds: offset=${offset} len=${length} size=${size}`);
    }
    if (this._byteSwapRegion(region)) {
      const heap = mod.HEAPU8;
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = heap[ptr + ((offset + i) ^ 1)];
      return out;
    }
    return new Uint8Array(mod.HEAPU8.buffer, ptr + offset, length).slice();
  }

  /**
   * @param {import("./types.js").MemoryRegion} region
   * @param {number} offset
   * @param {Uint8Array} bytes
   */
  writeMemory(region, offset, bytes) {
    const mod = this._needMod();
    const id = MemoryRegionToRetro[region];
    if (id === undefined) throw new Error(this._unknownRegionError(region));
    const ptr = mod._retro_get_memory_data(id);
    const size = mod._retro_get_memory_size(id);
    if (!ptr || !size) throw new Error(this._emptyRegionError(region));
    if (offset < 0 || offset + bytes.length > size) {
      throw new RangeError(`write out of bounds: offset=${offset} len=${bytes.length} size=${size}`);
    }
    if (this._byteSwapRegion(region)) {
      const heap = mod.HEAPU8;
      for (let i = 0; i < bytes.length; i++) heap[ptr + ((offset + i) ^ 1)] = bytes[i];
      return;
    }
    mod.HEAPU8.set(bytes, ptr + offset);
  }

  // ── C64 disk image read/write (VICE) ───────────────────────────────────────
  // The VICE WASM core takes content in-memory and exposes no disk memory region,
  // so these go through dedicated core exports that read/write the LIVE mounted
  // 1541 disk_image_t directly (see scripts/patches/vice-romdev-memory-regions.patch).
  // Only the standard 35-track 1541 .d64 (174848 bytes) is supported. unit 8.

  /** True if the loaded core exposes the romdev disk read/write exports. */
  diskImageSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_disk_export === "function"
                  && typeof mod._romdev_disk_import === "function");
  }

  /**
   * Read the LIVE mounted disk image out as a flat .d64.
   * @param {number} [unit] drive unit (default 8)
   * @returns {Uint8Array} the .d64 bytes (copied out of WASM memory)
   */
  exportDiskImage(unit = 8) {
    const mod = this._needMod();
    if (typeof mod._romdev_disk_export !== "function") {
      throw new Error("this core build does not expose disk export (C64/VICE only).");
    }
    const len = mod._romdev_disk_export(unit >>> 0, 0) >>> 0;
    if (!len) {
      throw new Error("no disk image mounted on this unit, or it is not a 35-track .d64. " +
        "Load a .d64 with loadMedia({platform:'c64', path}) first.");
    }
    const ptr = mod._romdev_disk_ptr();
    // copy out — the core buffer is reused on the next export
    return mod.HEAPU8.slice(ptr, ptr + len);
  }

  /**
   * Write a flat .d64 back into the LIVE mounted disk image (sector by sector).
   * @param {Uint8Array} bytes a 174848-byte .d64
   * @param {number} [unit] drive unit (default 8)
   * @returns {number} bytes written
   */
  importDiskImage(bytes, unit = 8) {
    const mod = this._needMod();
    if (typeof mod._romdev_disk_import !== "function") {
      throw new Error("this core build does not expose disk import (C64/VICE only).");
    }
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const ptr = mod._malloc(data.length);
    try {
      mod.HEAPU8.set(data, ptr);
      const n = mod._romdev_disk_import(ptr, data.length >>> 0, unit >>> 0, 0) >>> 0;
      if (!n) throw new Error("disk import failed — no writable .d64 mounted on this unit.");
      return n;
    } finally {
      mod._free(ptr);
    }
  }

  /**
   * Write ONE PRG file (name + bytes incl. its 2-byte load address) straight into
   * the LIVE mounted disk via the vdrive — the "inject a save" primitive.
   * @param {string} name file name (PETSCII, ≤16 chars)
   * @param {Uint8Array} bytes the PRG file bytes (load address + body)
   * @param {number} [unit] drive unit (default 8)
   */
  putDiskFile(name, bytes, unit = 8) {
    const mod = this._needMod();
    if (typeof mod._romdev_disk_putfile !== "function") {
      throw new Error("this core build does not expose disk putfile (C64/VICE only).");
    }
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nameBytes = Buffer.from(String(name) + "\0", "latin1");
    const namePtr = mod._malloc(nameBytes.length);
    const dataPtr = mod._malloc(data.length || 1);
    try {
      mod.HEAPU8.set(nameBytes, namePtr);
      mod.HEAPU8.set(data, dataPtr);
      const rc = mod._romdev_disk_putfile(unit >>> 0, namePtr, dataPtr, data.length >>> 0);
      if (rc !== 0) throw new Error(`disk putfile failed (rc=${rc}) — no writable .d64 mounted, or the disk is full.`);
    } finally {
      mod._free(namePtr);
      mod._free(dataPtr);
    }
  }

  // ── C64 keyboard + joyport (VICE core only) ──────────────────────────
  // C64 games need KEYBOARD input (F1 = 1 player, RUN/STOP, SPACE/RETURN at
  // setup screens) before joystick gameplay — joystick alone can't pass them.
  // The VICE core exports romdev_key_matrix / romdev_kbdbuf_feed /
  // romdev_joyport_* (see scripts/patches/vice-romdev-memory-regions.patch).

  /** True if the loaded core exposes C64 keyboard injection (VICE only). */
  keyboardSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_key_matrix === "function");
  }

  /**
   * Press (and optionally auto-release) a single C64 key by name. Drives the
   * C64 8×8 key matrix directly via the core. Held for `frames` then released.
   * @param {string} key  a name from C64_KEY_MATRIX (case-insensitive)
   * @param {number} [frames] frames to hold before release (default 4)
   * @returns {{key:string, row:number, col:number, frames:number}}
   */
  pressC64Key(key, frames = 4) {
    const mod = this._needMod();
    if (typeof mod._romdev_key_matrix !== "function") {
      throw new Error("this core build does not expose C64 keyboard input (C64/VICE only).");
    }
    const pos = C64_KEY_MATRIX[String(key).toLowerCase()];
    if (!pos) {
      throw new Error(
        `unknown C64 key '${key}'. Known: ${Object.keys(C64_KEY_MATRIX).join(", ")}.`,
      );
    }
    const [row, col] = pos;
    mod._romdev_key_matrix(row, col, 1);    // press
    this.stepFrames(Math.max(1, frames | 0));
    mod._romdev_key_matrix(row, col, 0);    // release
    this.stepFrames(1);
    return { key: String(key).toLowerCase(), row, col, frames: Math.max(1, frames | 0) };
  }

  /**
   * Press a C64 key like pressC64Key, but sample the machine-visible input
   * state (CIA1 $DC00/$DC01 — the keyboard/joystick scan ports) BEFORE,
   * DURING (key held), and AFTER (released). Lets an RE agent tell apart
   * "my key never reached VICE" from "VICE saw it but the game didn't scan
   * it this frame". No core change — reads the already-exposed c64_cia1_regs
   * region ($DC00..$DC0F).
   * @param {string} key
   * @param {number} frames  frames to hold (sampled at the midpoint)
   * @returns {object} matrix coords + held flag + per-phase CIA snapshots
   */
  pressC64KeyVerify(key, frames = 4) {
    const mod = this._needMod();
    if (typeof mod._romdev_key_matrix !== "function") {
      throw new Error("this core build does not expose C64 keyboard input (C64/VICE only).");
    }
    const pos = C64_KEY_MATRIX[String(key).toLowerCase()];
    if (!pos) {
      throw new Error(`unknown C64 key '${key}'. Known: ${Object.keys(C64_KEY_MATRIX).join(", ")}.`);
    }
    const [row, col] = pos;
    const held = Math.max(1, frames | 0);
    // $DC00 = CIA1 PRA (port A — joystick 2 + keyboard col select),
    // $DC01 = CIA1 PRB (port B — joystick 1 + keyboard row read).
    const cia = () => {
      try {
        const r = this.readMemory("c64_cia1_regs", 0, 2);
        return { DC00: r[0], DC01: r[1] };
      } catch { return null; }
    };
    const before = cia();
    mod._romdev_key_matrix(row, col, 1);          // press
    this.stepFrames(Math.ceil(held / 2));
    const during = cia();                          // key still held
    this.stepFrames(Math.max(1, held - Math.ceil(held / 2)));
    mod._romdev_key_matrix(row, col, 0);          // release
    this.stepFrames(1);
    const after = cia();
    return {
      key: String(key).toLowerCase(),
      row, col,
      frames: held,
      joyport: this.getC64JoyPort?.() ?? null,
      autoReleased: true,
      cia1: { before, during, after },
      note: "CIA1 $DC00 (port A) / $DC01 (port B) are the keyboard/joystick scan ports the KERNAL reads. `during` is sampled with the key held; if before==during the key never moved the matrix line (didn't reach VICE); if they differ but the game didn't react, it scanned a different key/port or that screen ignores it.",
    };
  }

  /**
   * Set the SET of C64 keyboard keys held down (for scripted timelines like
   * recordSession). Diffs against the currently-held set: presses newly-added
   * keys' matrix lines, releases removed ones. Pass [] to release all. Does NOT
   * step frames — the caller's loop owns stepping. Unknown keys throw.
   * @param {string[]} keys
   * @returns {{held: string[], matrix: Array<[number,number]>}}
   */
  setC64HeldKeys(keys) {
    const mod = this._needMod();
    if (typeof mod._romdev_key_matrix !== "function") {
      throw new Error("this core build does not expose C64 keyboard input (C64/VICE only).");
    }
    const want = new Set((keys ?? []).map((k) => String(k).toLowerCase()));
    for (const k of want) {
      if (!C64_KEY_MATRIX[k]) {
        throw new Error(`unknown C64 key '${k}'. Known: ${Object.keys(C64_KEY_MATRIX).join(", ")}.`);
      }
    }
    const have = this._c64HeldKeys ?? (this._c64HeldKeys = new Set());
    // release keys no longer wanted
    for (const k of have) {
      if (!want.has(k)) { const [r, c] = C64_KEY_MATRIX[k]; mod._romdev_key_matrix(r, c, 0); have.delete(k); }
    }
    // press newly-added keys
    for (const k of want) {
      if (!have.has(k)) { const [r, c] = C64_KEY_MATRIX[k]; mod._romdev_key_matrix(r, c, 1); have.add(k); }
    }
    return { held: [...have], matrix: [...have].map((k) => C64_KEY_MATRIX[k]) };
  }

  /**
   * Feed a PETSCII string into the C64 kernal keyboard buffer (for typing
   * LOAD/RUN/filenames). `\r` (or `\n`) becomes RETURN. Non-blocking — the
   * kernal drains it as the screen editor runs, so step frames after.
   * @param {string} text
   * @returns {number} kbdbuf_feed's result (>=0 ok)
   */
  typeC64Text(text) {
    const mod = this._needMod();
    if (typeof mod._romdev_kbdbuf_feed !== "function") {
      throw new Error("this core build does not expose C64 text input (C64/VICE only).");
    }
    const s = String(text).replace(/\n/g, "\r");
    const bytes = Buffer.from(s + "\0", "latin1");
    const ptr = mod._malloc(bytes.length);
    try {
      mod.HEAPU8.set(bytes, ptr);
      return mod._romdev_kbdbuf_feed(ptr) | 0;
    } finally {
      mod._free(ptr);
    }
  }

  /** Get the active C64 joystick port (1 or 2) the RetroPad drives. */
  getC64JoyPort() {
    const mod = this._needMod();
    if (typeof mod._romdev_joyport_get !== "function") {
      throw new Error("this core build does not expose C64 joyport (C64/VICE only).");
    }
    return mod._romdev_joyport_get() | 0;
  }

  /** Set the active C64 joystick port (1 or 2). Default is 2 (most games). */
  setC64JoyPort(port) {
    const mod = this._needMod();
    if (typeof mod._romdev_joyport_set !== "function") {
      throw new Error("this core build does not expose C64 joyport (C64/VICE only).");
    }
    if (port !== 1 && port !== 2) throw new Error("C64 joyport must be 1 or 2.");
    mod._romdev_joyport_set(port | 0);
    return port | 0;
  }

  reset() {
    const mod = this._needMod();
    mod._retro_reset();
    this.status.frameCount = 0;
    // A reset clears the core's active cheats (they live in volatile core
    // state, never in the ROM) — keep our mirror in sync.
    this._activeCheats = new Map();
  }

  /**
   * True power-cycle: re-load the ROM from scratch so work RAM is cleared and
   * all boot-seeded state is fresh — what `retro_reset` does NOT do (it's only
   * the RESET button; RAM persists on most cores). Falls back to a soft reset
   * if the load args weren't cached (shouldn't happen after a normal load).
   * @returns {Promise<boolean>} true if a full reload happened
   */
  async hardReset() {
    if (!this._loadArgs) {
      this.reset();
      return false;
    }
    // Battery semantics: SAVE_RAM survives a power-cycle on a battery cart.
    // Carry it across the reload (the reload itself zeroes it).
    let sram = null;
    try {
      const size = this.regionSize("save_ram");
      if (size > 0) sram = Uint8Array.from(this.readMemory("save_ram", 0, size));
    } catch { /* no save_ram region on this core/cart — nothing to carry */ }
    await this.loadMedia(this._loadArgs);
    if (sram && sram.some((b) => b !== 0)) {
      // Restore like a frontend restores the .srm: bytes in place BEFORE the
      // game's boot code reads them. Some cores size SAVE_RAM lazily (gpgx
      // scans for the last non-empty byte → size 0 on a fresh boot), so fall
      // back to the raw region pointer when the sized path refuses.
      let restored = false;
      try {
        if (this.regionSize("save_ram") >= sram.length) {
          this.writeMemory("save_ram", 0, sram);
          restored = true;
        }
      } catch { /* sized path unavailable */ }
      if (!restored) {
        try {
          const ptr = this.mod._retro_get_memory_data(0); // RETRO_MEMORY_SAVE_RAM
          if (ptr) { this.mod.HEAPU8.set(sram, ptr); restored = true; }
        } catch { /* no save buffer on this core/cart */ }
      }
      // loadMedia's settle frames may already have run the game's
      // hi-score load against empty SRAM — soft-reset so boot re-reads.
      if (restored) { try { this.reset(); } catch { /* keep the loaded state */ } }
    }
    return true;
  }

  /** True when this core's WASM build exposes the libretro cheat interface.
   *  (Older bundled cores predate the cheat-export build flag.) */
  cheatsSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._retro_cheat_set === "function");
  }

  /**
   * Enable (or update) a cheat via the libretro cheat interface — the SAME
   * mechanism RetroArch uses. NON-DESTRUCTIVE: the code is applied in volatile
   * core state (RAM write each frame for RAM cheats; an in-core read-intercept
   * for ROM/compare cheats). The ROM file on disk is NEVER modified, and a
   * reset/unload/loadState clears it. `code` is the RAW cheat string (e.g.
   * "00C7:FF", "SXIOPO", "AJ9T-CA5Y") — the CORE decodes it, so this works for
   * every format the core understands without us decoding first.
   * @param {number} index  slot index (0-based; reuse to overwrite a slot)
   * @param {string} code   raw cheat code string
   * @param {boolean} [enabled=true]
   */
  setCheat(index, code, enabled = true) {
    const mod = this._needMod();
    if (typeof mod._retro_cheat_set !== "function") {
      throw new Error(
        "this core build does not expose the cheat interface (retro_cheat_set). " +
        "Rebuild the core with the cheat exports, or apply RAM cheats via writeMemory.",
      );
    }
    const bytes = Buffer.from(String(code) + "\0", "utf-8");
    const ptr = mod._malloc(bytes.length);
    try {
      mod.HEAPU8.set(bytes, ptr);
      mod._retro_cheat_set(index >>> 0, enabled ? 1 : 0, ptr);
    } finally {
      mod._free(ptr);
    }
    if (!this._activeCheats) this._activeCheats = new Map();
    if (enabled) this._activeCheats.set(index, code);
    else this._activeCheats.delete(index);
  }

  /** Clear ALL active cheats (calls retro_cheat_reset). Non-destructive. */
  clearCheats() {
    const mod = this._needMod();
    if (typeof mod._retro_cheat_reset === "function") mod._retro_cheat_reset();
    this._activeCheats = new Map();
  }

  /** The cheats currently enabled in this session: [{ index, code }]. */
  listActiveCheats() {
    return Array.from((this._activeCheats ?? new Map()).entries())
      .map(([index, code]) => ({ index, code }))
      .sort((a, b) => a.index - b.index);
  }

  /** True when this core build exposes the instruction-level write watchpoint. */
  watchpointSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_watchpoint_set === "function" && typeof mod._romdev_watchpoint_get === "function");
  }

  /**
   * Arm (or disarm) the instruction-level write watchpoint on a CPU address.
   * Unlike the frame-sampled watchMemory PC, this records the EXACT writing
   * instruction's PC (captured inside the core's CPU write path), so it's
   * correct even for NMI/IRQ-driven writes. One watchpoint at a time.
   * @param {number} address CPU address to watch
   * @param {boolean} [enabled=true]
   */
  setWatchpoint(address, enabled = true, opts) {
    const mod = this._needMod();
    if (typeof mod._romdev_watchpoint_set !== "function") {
      throw new Error("this core build does not expose the write watchpoint (rebuild with romdev_watchpoint_* exports).");
    }
    // Value-condition (0.30.0): the core's write hook only counts/records writes
    // that satisfy the condition so the reported PC is the MEANINGFUL write, not
    // a restoring/churn write or just the frame's last write. Feature-detected:
    // a core build without _romdev_watchpoint_set_cond ignores the condition
    // (conditionApplied:false) and the tool layer falls back where it can.
    let conditionApplied = false;
    if (opts && opts.condition && typeof mod._romdev_watchpoint_set_cond === "function") {
      // cond code: 1=increase, 2=decrease, 3=equals. value used by 'equals'.
      const code = opts.condition === "increase" ? 1 : opts.condition === "decrease" ? 2 : 3;
      mod._romdev_watchpoint_set_cond(address >>> 0, enabled ? 1 : 0, code, (opts.value ?? 0) & 0xFF);
      conditionApplied = true;
    } else {
      mod._romdev_watchpoint_set(address >>> 0, enabled ? 1 : 0);
    }
    return { conditionApplied };
  }

  /** Read the watchpoint state: { enabled, address, lastPC, lastValue, hits,
   *  prgOffset? }. lastPC is 0xFFFFFFFF (reported as null) until a write is seen.
   *  prgOffset (when the core reports it — fceumm/NES) is the ABSOLUTE PRG-ROM
   *  offset of the writing instruction, which disambiguates the BANK for a
   *  $8000-$BFFF PC on a banked mapper. Pass clearHits to reset after reading. */
  getWatchpoint(clearHits = false) {
    const mod = this._needMod();
    if (typeof mod._romdev_watchpoint_get !== "function") {
      throw new Error("this core build does not expose the write watchpoint.");
    }
    const ptr = mod._malloc(28); // up to 7 × uint32 (older cores write only 5-6)
    try {
      // Pre-seed slots 6+7 so an older core leaves prgOffset/oldValue = "none".
      new Uint32Array(mod.HEAPU8.buffer, ptr, 7).fill(0xFFFFFFFF);
      mod._romdev_watchpoint_get(ptr, clearHits ? 1 : 0);
      const u = new Uint32Array(mod.HEAPU8.buffer, ptr, 7);
      const lastPC = u[2];
      const prgOffset = u[5];
      const oldValue = u[6]; // slot 7 (0.30.0): the pre-write byte, for inc/dec
      return {
        enabled: !!u[0],
        address: u[1],
        lastPC: lastPC === 0xFFFFFFFF ? null : lastPC,
        lastValue: u[3] & 0xFF,
        hits: u[4],
        ...(prgOffset !== 0xFFFFFFFF ? { prgOffset } : {}),
        ...(oldValue !== 0xFFFFFFFF ? { lastOldValue: oldValue & 0xFF } : {}),
      };
    } finally {
      mod._free(ptr);
    }
  }

  // ── PC breakpoint + read watchpoint + single-step (core-side, exact) ────────
  // Symmetric to the write watchpoint. On PC hit the core's execute loop drains
  // the cycle budget and bails, but retro_run still finishes the frame — so the
  // LIVE register file is end-of-frame state by the time the host reads it. Cores
  // that snapshot the registers AT the hit (NES/fceumm: getPCBreak().registersAtHit)
  // give the reliable break-instant regs; others expose only lastPC + the RAM side
  // effects. The read watchpoint records the PC that READ an address. All require a
  // core patched with the romdev_pcbreak_*/romdev_readwatch_* exports. Capability
  // (and reg-snapshot availability) is feature-detected per core.

  /** True when this core build exposes the PC breakpoint + single-step. */
  pcBreakSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_pcbreak_set === "function" && typeof mod._romdev_pcbreak_get === "function");
  }

  /** True when this core build exposes the instruction-level read watchpoint. */
  readWatchSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_readwatch_set === "function" && typeof mod._romdev_readwatch_get === "function");
  }

  /** Arm/disarm the PC breakpoint. `step:true` arms a one-instruction
   *  single-step (the address is ignored). One breakpoint at a time. */
  setPCBreak(address, enabled = true, step = false) {
    const mod = this._needMod();
    if (typeof mod._romdev_pcbreak_set !== "function") {
      throw new Error("this core build does not expose the PC breakpoint (rebuild with romdev_pcbreak_* exports).");
    }
    mod._romdev_pcbreak_set(address >>> 0, enabled ? 1 : 0, step ? 1 : 0);
  }

  /** Read the breakpoint state: { enabled, address, hit, lastPC, hits }.
   *  lastPC is null until a hit. Pass clearHit to re-arm (clears the hit flag). */
  getPCBreak(clearHit = false) {
    const mod = this._needMod();
    if (typeof mod._romdev_pcbreak_get !== "function") {
      throw new Error("this core build does not expose the PC breakpoint.");
    }
    const ptr = mod._malloc(44); // up to 11 × uint32 (newer fceumm writes 11: +A/X/Y/P/S snapshot)
    try {
      // Pre-seed all 11 slots. The reg-snapshot slots (6-10) default to
      // 0xFFFFFFFF = "no snapshot" so a core that only writes 6 (Genesis et al.)
      // leaves them as "unavailable" rather than 0 (a valid register value).
      const seed = new Uint32Array(mod.HEAPU8.buffer, ptr, 11);
      seed.fill(0); seed[6] = seed[7] = seed[8] = seed[9] = seed[10] = 0xFFFFFFFF;
      mod._romdev_pcbreak_get(ptr, clearHit ? 1 : 0);
      const u = new Uint32Array(mod.HEAPU8.buffer, ptr, 11);
      const lastPC = u[3];
      // Register snapshot at the hit instant (fceumm). 0xFFFFFFFF = not captured
      // (older core, or no hit yet). When present, these are the RELIABLE
      // break-instant regs — the live X6502 regs are clobbered by end-of-frame.
      const snap = (u[6] === 0xFFFFFFFF && u[7] === 0xFFFFFFFF)
        ? null
        : { A: u[6] & 0xFF, X: u[7] & 0xFF, Y: u[8] & 0xFF, P: u[9] & 0xFF, S: u[10] & 0xFF };
      return {
        enabled: !!u[0],
        address: u[1],
        hit: !!u[2],
        lastPC: lastPC === 0xFFFFFFFF ? null : lastPC,
        hits: u[4],
        watchdog: !!u[5], // the run was force-stopped by the instruction watchdog
        registersAtHit: snap,
      };
    } finally {
      mod._free(ptr);
    }
  }

  /** Arm the instruction watchdog (force-stop a runaway after `limit` instructions
   *  so callSubroutine can't hang the WASM; 0 = disable). No-op on cores that lack
   *  it (older builds) — the per-frame maxFrames is the fallback there. */
  setWatchdog(limit) {
    const mod = this._needMod();
    if (typeof mod._romdev_watchdog_set === "function") mod._romdev_watchdog_set(limit >>> 0);
  }
  watchdogSupported() {
    return !!(this.mod && typeof this.mod._romdev_watchdog_set === "function");
  }

  /** True when this core build exposes the at-hit register snapshot (gpgx). */
  regSnapSupported() {
    return !!(this.mod && typeof this.mod._romdev_regsnap_get === "function");
  }

  /**
   * Read the at-hit register snapshot: the FULL register file frozen by the
   * core hook at the instant a pc-break / watchdog / write-watch / read-watch
   * fired. The live register file keeps running after a hit (per-scanline CPU
   * scheduling / next-frame re-entry), so post-hit register reads drift —
   * this snapshot is the truth. Shipped by ALL patched cores (all 14
   * platforms). Returns { kind, named } or null when no hit has been
   * snapshotted (or the core build predates the export). kind:
   * 1=pc-break/step, 2=watchdog, 3=write-watch, 4=read-watch. `named` keys
   * follow each CPU's own register file; `pc` is always the EXECUTING
   * instruction (ARM: its pipeline PC, the same convention breakpoint
   * addresses use). Pass clear to reset the kind.
   */
  /** True when the loaded MIPS core (n64/ps1) exposes the live R3000/R4300 register
   *  snapshot (the cheat+regsnap-enabled romdev build). */
  mipsRegsSupported() {
    return !!(this.mod && typeof this.mod._romdev_mips_regs_get === "function");
  }

  /** Read the live MIPS register file: 32 GPRs + LO + HI + PC, as a Uint32Array(35).
   *  null if the core doesn't expose it (older build). */
  getMipsRegs() {
    const mod = this.mod;
    if (!mod || typeof mod._romdev_mips_regs_get !== "function") return null;
    const ptr = mod._malloc(35 * 4);
    try {
      mod._romdev_mips_regs_get(ptr);
      return new Uint32Array(mod.HEAPU8.buffer, ptr, 35).slice();
    } finally {
      mod._free(ptr);
    }
  }

  /** True when the PS1 core exposes the SPU register block (getAudioState chip:'spu'). */
  spuRegsSupported() {
    return !!(this.mod && typeof this.mod._romdev_spu_get === "function");
  }

  /** True when the N64 core exposes the AI registers (getAudioState chip:'ai'). */
  aiRegsSupported() {
    return !!(this.mod && typeof this.mod._romdev_ai_get === "function");
  }

  /** Read the N64 AI registers + VI clock as a Uint32Array(7). null if absent. */
  getAiRegs() {
    const mod = this.mod;
    if (!mod || typeof mod._romdev_ai_get !== "function") return null;
    const ptr = mod._malloc(7 * 4);
    try {
      mod._romdev_ai_get(ptr);
      return new Uint32Array(mod.HEAPU8.buffer, ptr, 7).slice();
    } finally {
      mod._free(ptr);
    }
  }

  /** Read the PS1 SPU's 0x400-word register block as a Uint16Array(1024). null if
   *  the core doesn't expose it. */
  getSpuRegs() {
    const mod = this.mod;
    if (!mod || typeof mod._romdev_spu_get !== "function") return null;
    const ptr = mod._malloc(0x400 * 2);
    try {
      mod._romdev_spu_get(ptr, 0x400);
      return new Uint16Array(mod.HEAPU8.buffer, ptr, 0x400).slice();
    } finally {
      mod._free(ptr);
    }
  }

  getRegSnapshot(clear = false) {
    const mod = this.mod;
    if (!mod || typeof mod._romdev_regsnap_get !== "function") return null;
    const ptr = mod._malloc(21 * 4);
    try {
      mod._romdev_regsnap_get(ptr, clear ? 1 : 0);
      const u = new Uint32Array(mod.HEAPU8.buffer, ptr, 21);
      const kind = u[0];
      if (!kind) return null;
      const r = Array.from(u.subarray(2, 2 + Math.min(u[1] >>> 0, 19)));
      const platform = this.status.platform;
      const h2 = (v) => "$" + (v & 0xFF).toString(16).toUpperCase();
      const h4 = (v) => "$" + (v & 0xFFFF).toString(16).toUpperCase();
      const hx = (v) => "$" + (v >>> 0).toString(16).toUpperCase();
      let named;
      if (platform === "genesis") {
        // m68k regId order: D0-7, A0-7, PC(instr start), SR, SP.
        named = {};
        for (let i = 0; i < 8; i++) named["d" + i] = hx(r[i]);
        for (let i = 0; i < 8; i++) named["a" + i] = hx(r[8 + i]);
        named.pc = hx(r[16]);
        named.sr = h4(r[17]);
        named.sp = hx(r[18]);
      } else if (platform === "gba") {
        // ARM regId order: r0-r15 raw, CPSR at 16, instr pipeline PC at 17, SP at 18.
        named = {};
        for (let i = 0; i < 16; i++) named["r" + i] = hx(r[i]);
        named.cpsr = hx(r[16]);
        named.pc = hx(r[17]);   // EXECUTING instruction's pipeline PC (pc-break convention)
        named.sp = hx(r[18]);
      } else if (platform === "snes") {
        // 65816 regId order: A, X, Y, P, S, DB, D, …, PBPC(instr start).
        named = {
          a: h4(r[0]), x: h4(r[1]), y: h4(r[2]), p: h4(r[3]), s: h4(r[4]),
          db: h2(r[5]), d: h4(r[6]), pc: hx(r[16]),
        };
      } else if (platform === "gb" || platform === "gbc") {
        named = {
          a: h2(r[0]), f: h2(r[1]), b: h2(r[2]), c: h2(r[3]),
          d: h2(r[4]), e: h2(r[5]), h: h2(r[6]), l: h2(r[7]),
          pc: h4(r[16]), sp: h4(r[18]),
        };
      } else if (platform === "sms" || platform === "gg" || platform === "msx") {
        named = {
          a: h2(r[0]), f: h2(r[1]), b: h2(r[2]), c: h2(r[3]),
          d: h2(r[4]), e: h2(r[5]), h: h2(r[6]), l: h2(r[7]),
          ix: h4(r[8]), iy: h4(r[9]), pc: h4(r[16]), sp: h4(r[18]),
        };
      } else {
        // 6502 family (nes, atari2600, atari7800, c64, lynx, pce/huc6280):
        // regId order A, X, Y, P, S, …, PC(instr start).
        named = {
          a: h2(r[0]), x: h2(r[1]), y: h2(r[2]), p: h2(r[3]), s: h2(r[4]),
          pc: h4(r[16]),
        };
      }
      return { kind, named };
    } finally {
      mod._free(ptr);
    }
  }

  /** True when this core build exposes the pure-CPU run (gpgx). */
  runPureSupported() {
    return !!(this.mod && typeof this.mod._romdev_run_pure === "function");
  }

  /** True when this core build exposes the interrupt block (the pure-call
   *  primitive on cores without a separable CPU loop). */
  irqBlockSupported() {
    return !!(this.mod && typeof this.mod._romdev_irqblock_set === "function");
  }

  /** Suppress (or restore) interrupt DELIVERY to the active CPU. While
   *  blocked, pending IRQ/NMI lines stay pending and no game handler can run
   *  — the mechanism behind pure calls on cores whose CPU/video loops are
   *  interleaved (everything except gpgx, which steps the CPU alone). */
  setIrqBlock(on) {
    const mod = this._needMod();
    if (typeof mod._romdev_irqblock_set !== "function") {
      throw new Error("this core build does not expose the interrupt block (rebuild with romdev_irqblock_set).");
    }
    mod._romdev_irqblock_set(on ? 1 : 0);
  }

  /** True when a pure call is possible on this platform by ANY mechanism:
   *  a separable CPU run (gpgx), an interrupt block, or hardware with no
   *  interrupts at all (the 2600's 6507 has no IRQ/NMI lines wired — every
   *  call is inherently pure). */
  pureCallSupported() {
    return this.runPureSupported() || this.irqBlockSupported() || this.status.platform === "atari2600";
  }

  /** True when this core build exposes the VRAM-port copy trace (port-based
   *  video memory: NES/SNES/PCE/MSX/SMS/GG/Genesis). Direct-mapped platforms
   *  answer the same question through watchRange on the CPU-visible VRAM. */
  vramWatchSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_vramwatch_set === "function" && typeof mod._romdev_vramwatch_get === "function");
  }

  /**
   * Run `frames` frames logging every data-port write landing in the VRAM
   * address window [lo,hi] — {vramAddr, pc, value} per event, pc being the
   * EXECUTING instruction (during DMA on SNES, the instruction that triggered
   * it). The "where does this graphic come from?" primitive for port-based
   * video memory. Returns { events, total, stored, truncated }.
   */
  watchVram(lo, hi, frames, perFrame) {
    const mod = this._needMod();
    this._needMedia();
    if (!this.vramWatchSupported()) throw new Error("VRAM copy trace not supported by this core.");
    mod._romdev_vramwatch_set(lo >>> 0, hi >>> 0, 1);
    try {
      this._runFramesExclusive(perFrame ?? (() => false), frames);
    } finally {
      // drained below; disarm after
    }
    const CAP = 1024;
    const outPtr = mod._malloc(CAP * 3 * 4);
    const out2Ptr = mod._malloc(8);
    try {
      const n = mod._romdev_vramwatch_get(outPtr, CAP, out2Ptr);
      const u = new Uint32Array(mod.HEAPU8.buffer, outPtr, n * 3);
      const u2 = new Uint32Array(mod.HEAPU8.buffer, out2Ptr, 2);
      const events = [];
      for (let i = 0; i < n; i++) {
        events.push({ vramAddr: u[i * 3], pc: u[i * 3 + 1], value: u[i * 3 + 2] & 0xFF });
      }
      return { events, total: u2[0], stored: u2[1], truncated: u2[0] > u2[1] };
    } finally {
      mod._free(outPtr);
      mod._free(out2Ptr);
      mod._romdev_vramwatch_set(0, 0, 0);
    }
  }

  /** Arm/disarm the read watchpoint on a CPU address. */
  setReadWatch(address, enabled = true) {
    const mod = this._needMod();
    if (typeof mod._romdev_readwatch_set !== "function") {
      throw new Error("this core build does not expose the read watchpoint (rebuild with romdev_readwatch_* exports).");
    }
    mod._romdev_readwatch_set(address >>> 0, enabled ? 1 : 0);
  }

  /** Read the read-watchpoint state: { enabled, address, lastPC, lastValue, hits }. */
  getReadWatch(clearHits = false) {
    const mod = this._needMod();
    if (typeof mod._romdev_readwatch_get !== "function") {
      throw new Error("this core build does not expose the read watchpoint.");
    }
    const ptr = mod._malloc(20); // 5 × uint32
    try {
      mod._romdev_readwatch_get(ptr, clearHits ? 1 : 0);
      const u = new Uint32Array(mod.HEAPU8.buffer, ptr, 5);
      const lastPC = u[2];
      return {
        enabled: !!u[0],
        address: u[1],
        lastPC: lastPC === 0xFFFFFFFF ? null : lastPC,
        lastValue: u[3] & 0xFF,
        hits: u[4],
      };
    } finally {
      mod._free(ptr);
    }
  }

  /**
   * Run until the CPU PC reaches `address` (or until `maxFrames` frames elapse),
   * then stop with the CPU frozen exactly at that instruction. Returns
   * { hit, frame, pc?, hits? }. On hit the registers are readable via getCPUState.
   * The breakpoint is auto-disarmed after the run so normal stepping resumes.
   */
  /**
   * Drive `_retro_run()` in a tight loop while making THIS call the sole driver
   * of the core. If a playtest window is open, its 60fps setInterval tick is
   * ALSO calling stepFrames(1) on this same shared host — two drivers racing
   * would let the tick step past a breakpoint between our iterations and corrupt
   * frame timing. The playtest tick skips stepping whenever `status.paused`, so
   * we mark the host paused for the duration (and restore the prior state after),
   * giving us exclusive control. We drive `_retro_run()` directly here rather
   * than via stepFrames() precisely because stepFrames() no-ops while paused.
   * The window keeps RENDERING the frozen frame, so the human still sees state.
   * @param {(i:number)=>boolean} body called per frame; return true to stop early.
   * @param {number} maxFrames
   * @returns {number} frames actually run
   */
  _runFramesExclusive(body, maxFrames) {
    const mod = this._needMod();
    // Suspend ONLY the playtest window's render-tick stepping for the duration —
    // not `status.paused` (the agent's pause is a separate concept, and the core
    // run must be identical whether or not the user paused). The playtest tick
    // checks `_renderTickSuspended` and renders-only while it's set; we own the
    // core's frame advance here so the two never race past a breakpoint.
    const prevSuspended = this._renderTickSuspended;
    this._renderTickSuspended = true;
    let framesRun = 0;
    try {
      for (let i = 0; i < maxFrames; i++) {
        mod._retro_run();
        this.status.frameCount++;
        framesRun++;
        if (body(i)) break;
      }
    } finally {
      this._renderTickSuspended = prevSuspended;
      if (this.state.lastFrame) {
        this.status.fbWidth = this.state.lastFrame.width;
        this.status.fbHeight = this.state.lastFrame.height;
      }
    }
    return framesRun;
  }

  runUntilPC(address, maxFrames = 600) {
    this._needMod();
    this._needMedia();
    if (!this.pcBreakSupported()) {
      throw new Error("PC breakpoint not supported by this core (Genesis today; other cores as patched).");
    }
    this.setPCBreak(address, true, false);
    let hit = false;
    let framesRun = 0;
    try {
      framesRun = this._runFramesExclusive(() => {
        if (this.getPCBreak(false).hit) { hit = true; return true; }
        return false;
      }, maxFrames);
    } finally {
      // Disarm so subsequent stepFrames/runUntil* run normally.
      this.setPCBreak(0, false, false);
    }
    const st = this.getPCBreak(true); // read final state + clear hit
    return {
      hit,
      frame: this.status.frameCount,
      framesRun,
      ...(hit ? { pc: st.lastPC, hits: st.hits } : {}),
    };
  }

  /**
   * Run until a watched address is READ (or maxFrames elapse). Unlike the PC
   * break this does NOT freeze mid-frame — it records the reading PC and the run
   * completes the frame it was found in. Returns { hit, frame, pc?, value?, hits? }.
   */
  runUntilRead(address, maxFrames = 600) {
    this._needMod();
    this._needMedia();
    if (!this.readWatchSupported()) {
      throw new Error("read watchpoint not supported by this core (Genesis today; other cores as patched).");
    }
    this.setReadWatch(address, true);
    let hit = false;
    let framesRun = 0;
    try {
      framesRun = this._runFramesExclusive(() => {
        if (this.getReadWatch(false).hits > 0) { hit = true; return true; }
        return false;
      }, maxFrames);
    } finally {
      this.setReadWatch(0, false);
    }
    const st = this.getReadWatch(true);
    return {
      hit,
      frame: this.status.frameCount,
      framesRun,
      ...(hit ? { pc: st.lastPC, value: st.lastValue, hits: st.hits } : {}),
    };
  }

  /**
   * Execute exactly ONE CPU instruction and stop (single-step). Freezes the CPU
   * right after the stepped instruction. Returns { pc } — the PC the CPU is now
   * poised at. Note: a frame may advance other subsystems; this is a CPU-level
   * single-step, the finest granularity the core exposes.
   */
  stepInstruction() {
    this._needMod();
    this._needMedia();
    if (!this.pcBreakSupported()) {
      throw new Error("single-step not supported by this core (Genesis today; other cores as patched).");
    }
    this.setPCBreak(0, false, true); // step mode (one-shot)
    // Exclusive driver (suspends the playtest tick); the step fires on the very
    // next instruction, so one frame is more than enough for the core to dispatch
    // it. Stop after that one frame regardless.
    this._runFramesExclusive(() => true, 1);
    const st = this.getPCBreak(true);
    return { pc: st.lastPC, hit: st.hit };
  }

  // ── Register write + callSubroutine (item 1) ────────────────────────────────
  // romdev reg-id convention (stable across all patched cores): for the m68k
  // family 0..7=D0..D7, 8..15=A0..A7, 16=PC, 17=SR, 18=SP. Other CPU families map
  // their own registers onto the same id space (documented per core).

  /** True when this core build exposes register-write + callSubroutine. */
  setRegSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_setreg === "function" && typeof mod._romdev_getreg === "function");
  }

  /** Write one CPU register by romdev reg-id. */
  setReg(regId, value) {
    const mod = this._needMod();
    if (typeof mod._romdev_setreg !== "function") {
      throw new Error("register write not supported by this core (rebuild with romdev_setreg).");
    }
    mod._romdev_setreg(regId | 0, value >>> 0);
  }

  /** Read one CPU register by romdev reg-id. */
  getReg(regId) {
    const mod = this._needMod();
    if (typeof mod._romdev_getreg !== "function") {
      throw new Error("register read not supported by this core (rebuild with romdev_getreg).");
    }
    return mod._romdev_getreg(regId | 0) >>> 0;
  }

  /**
   * Call a subroutine in the live core and run until it returns: set the given
   * registers (by romdev reg-id), push a SENTINEL return address on the stack,
   * set PC, then run with a PC breakpoint armed on the sentinel until the routine
   * RTSes back to it. Sandboxed by default — snapshots full core state first and
   * restores it after, so the live game is untouched (the dst buffer the routine
   * wrote is captured into a savestate-independent copy? no — it lives in core
   * RAM; the caller reads it via readMemory BEFORE restore by passing a `capture`
   * callback). Returns { returned, framesRun, finalRegs } (+ whatever `capture`
   * returns). The general primitive behind decompressWith / "drive the ROM's own
   * codec." regIds map per the convention above. sentinelPC must be an address
   * that won't otherwise be executed (default: 0 — the ROM's reset/0 vector area,
   * unlikely mid-run; override if it collides).
   *
   * @param {object} a
   * @param {number} a.pc            entry PC of the subroutine
   * @param {Record<number,number>} a.regs  reg-id → value to set before the call
   * @param {number} [a.spReg=18]    the reg-id of the stack pointer (m68k: 18)
   * @param {number} [a.pcReg=16]    the reg-id of the program counter (m68k: 16)
   * @param {number} [a.sentinelPC=0] return address pushed on the stack (4 bytes for m68k)
   * @param {number} [a.sentinelBytes=4] how wide the return address is on the stack
   * @param {number} [a.maxFrames=600] cap so a runaway can't hang
   * @param {boolean} [a.sandbox=true] snapshot+restore around the call
   * @param {(host:LibretroHost)=>any} [a.capture] read result from core RAM BEFORE restore
   */
  callSubroutine(a) {
    this._needMod();
    this._needMedia();
    if (!this.setRegSupported()) {
      throw new Error("cpu({op:'call'}) not supported by this core (rebuild with romdev_setreg/romdev_getreg).");
    }
    if (!this.pcBreakSupported()) {
      throw new Error("cpu({op:'call'}) needs the PC breakpoint (romdev_pcbreak) too.");
    }
    const prof = this._cpuCallProfile();
    const {
      pc, regs = {}, spReg = prof.spReg, pcReg = prof.pcReg, sentinelPC = prof.defaultSentinel,
      sentinelBytes = prof.retBytes, maxFrames = 600, sandbox = true, capture,
      // pure: step ONLY the active CPU (no frame machinery — VDP lines, co-CPU,
      // interrupt raising). Without it, each "frame" of the call runs the
      // game's OWN per-frame logic concurrently (VBlank handlers via RAM
      // vectors etc.), which can stomp the buffer the driven routine is
      // writing — a real session diffed a CORRECT codec reimplementation
      // against that poisoned output for hours. gpgx (Genesis/SMS/GG) only.
      pure = false,
      // presetMemory: [{addr, bytes}] CPU-space writes applied before the call
      // (codecs that read a global from RAM — a dest stride, a mode flag, etc).
      presetMemory = [],
      // stopAtPC: an additional PC to halt on (returns partial output even if the
      // routine never reaches the sentinel). Use for "run into the codec, stop at
      // a known mid-point, see what it produced so far."
      stopAtPC,
      // maxInstructions: the instruction watchdog budget — the real cap that
      // catches a runaway, whether it's a tight infinite loop OR a wrong-setup
      // entry (e.g. a WRAPPER PC with a bad source) that falls back into the
      // game's own main loop and free-runs forever instead of returning.
      //
      // The budget MUST trip BEFORE maxFrames is exhausted on such a free-run —
      // otherwise the run silently hits maxFrames and the agent can't tell
      // "wrong entry" from "legitimately long." Two failure modes the default
      // has to dodge, and why it's PER-CPU rather than a flat constant:
      //   • too LOW relative to a real codec → cuts off a legit decompress.
      //   • too HIGH relative to maxFrames-worth of execution → never trips
      //     before the frame cap. A flat 4M does this on the ~1MHz 8-bit CPUs
      //     (6507/6510 run only ~3-3.8M instructions in 600 frames), so the
      //     watchdog could never fire there.
      // Derive it from the CPU's instrPerFrame (set in _cpuCallProfile): 80% of
      // maxFrames-worth, capped at 4M for the fast cores (GBA/Genesis). Any real
      // decompressor finishes in <~1M instructions on every one of these CPUs,
      // so even the slow-CPU floor (~2.9M for c64/atari2600) keeps 2-3x headroom
      // while guaranteeing the watchdog beats the frame cap. Callers who KNOW a
      // routine is genuinely huge pass an explicit maxInstructions to override.
      maxInstructions = Math.max(
        200_000,
        Math.min(4_000_000, Math.floor(maxFrames * (prof.instrPerFrame ?? 50000) * 0.8)),
      ),
    } = a;

    const snapshot = sandbox ? this.serializeState() : null;
    let captured, returned = false, framesRun = 0, watchdogTripped = false, stoppedAtPC = false;
    let pureMode = null;
    try {
      // Apply pre-call memory writes (CPU-space).
      for (const m of presetMemory) {
        const bytes = m.bytes instanceof Uint8Array ? m.bytes
          : new Uint8Array((m.hex || "").match(/../g)?.map((h) => parseInt(h, 16)) || []);
        if (bytes.length) this.writeMemoryCpuAddr(m.addr >>> 0, bytes);
      }
      // Set caller-supplied registers.
      for (const [id, val] of Object.entries(regs)) this.setReg(Number(id), val);
      // Push the sentinel return address per the CPU's stack discipline, then set
      // SP + PC. The return address width + push direction + byte order all come
      // from the per-CPU profile (m68k pushes 4 BE bytes, predecrement; the 6502
      // pushes 2 bytes high-then-low at $0100+SP and SP grows DOWN; SM83 pushes 2
      // LE bytes predecrement; 65816 RTL pops 3 bytes).
      let sp = this.getReg(spReg) >>> 0;
      // The 6502/65816 RTS/RTL return to (popped address + 1) — they push PC-1. So
      // to land the run on `sentinelPC`, push sentinelPC + retAdjust (-1 there, 0
      // for m68k RTS / SM83 RET / Z80 RET which return to the exact pushed addr).
      const pushed = (sentinelPC + (prof.retAdjust ?? 0)) >>> 0;
      const buf = new Uint8Array(sentinelBytes);
      if (prof.retBigEndian) {
        for (let i = 0; i < sentinelBytes; i++) buf[i] = (pushed >>> (8 * (sentinelBytes - 1 - i))) & 0xFF;
      } else {
        for (let i = 0; i < sentinelBytes; i++) buf[i] = (pushed >>> (8 * i)) & 0xFF;
      }
      if (prof.stackPage !== undefined) {
        // 6502/65816-style page stack: bytes go at $page + SP, SP decremented after
        // each byte (push order = the bytes as written, SP ends below them).
        const base = prof.stackPage;
        let s = sp & 0xFF;
        for (let i = 0; i < sentinelBytes; i++) {
          this.writeMemoryCpuAddr(base + s, buf.subarray(i, i + 1));
          s = (s - 1) & 0xFF;
        }
        this.setReg(spReg, s);
      } else {
        // Predecrement stack (m68k/SM83): SP -= width, write the block, set SP.
        sp = (sp - sentinelBytes) >>> 0;
        this.writeMemoryCpuAddr(sp, buf);
        this.setReg(spReg, sp);
      }
      this.setReg(pcReg, pc >>> 0);

      // Arm the instruction watchdog so a runaway codec force-stops mid-frame
      // instead of hanging the WASM (the core check between frames can't catch a
      // tight infinite loop). The breakpoint stops on the sentinel return; if
      // `stopAtPC` is given we break THERE instead (run-to-a-mid-point + return
      // partial). The watchdog catches everything else.
      this.setWatchdog(maxInstructions);
      const target = (stopAtPC !== undefined ? stopAtPC : sentinelPC) >>> 0;
      this.setPCBreak(target, true, false);
      let finalState = null;
      let irqBlocked = false;
      try {
        if (pure && this.runPureSupported()) {
          // STRONGEST pure mode (gpgx): step ONLY the CPU — no frame machinery
          // at all. Mask m68k interrupts so a PENDING VINT raised before the
          // call can't redirect entry (no NEW interrupts are raised — the
          // system loop never runs). The sandbox restore (or the game's own
          // RTE discipline) makes the IPL change invisible afterward.
          pureMode = "cpu-only";
          if (this.status.platform === "genesis") {
            this.setReg(17, (this.getReg(17) | 0x0700) & 0xFFFF);
          }
          // Drive the CPU in cycle chunks, checking the sentinel/watchdog
          // between chunks. The watchdog bounds total instructions; the chunk
          // cap is only a backstop against a watchdog-less older core.
          const CHUNK_CYCLES = 1_000_000;
          const maxChunks = 512;
          for (let i = 0; i < maxChunks; i++) {
            this.mod._romdev_run_pure(CHUNK_CYCLES);
            const st = this.getPCBreak(false);
            if (st.hit) {
              finalState = st;
              if (st.watchdog) watchdogTripped = true;
              else if (stopAtPC !== undefined) stoppedAtPC = true;
              else returned = true;
              break;
            }
          }
        } else {
          if (pure) {
            // INTERRUPT-BLOCKED pure mode (every other core): the frame
            // machinery still runs (video/timers advance — harmless, they
            // don't write game RAM), but interrupt DELIVERY is suppressed, so
            // no game handler can execute. The only running game code is the
            // routine we called — the same guarantee that matters for the
            // output buffer. The 2600's 6507 has no interrupt lines at all,
            // so every call there is pure by hardware.
            if (this.irqBlockSupported()) {
              this.setIrqBlock(true);
              irqBlocked = true;
              pureMode = "irq-blocked";
            } else if (this.status.platform === "atari2600") {
              pureMode = "no-interrupts";
            } else {
              throw new Error("cpu({op:'call', pure:true}) not supported by this core build (needs the romdev_irqblock_set export — update the core package).");
            }
          }
          framesRun = this._runFramesExclusive(() => {
            const st = this.getPCBreak(false);
            if (st.hit) {
              finalState = st;
              if (st.watchdog) watchdogTripped = true;
              else if (stopAtPC !== undefined) stoppedAtPC = true;
              else returned = true;
              return true;
            }
            return false;
          }, maxFrames);
        }
      } finally {
        if (irqBlocked) { try { this.setIrqBlock(false); } catch { /* core gone */ } }
        this.setPCBreak(0, false, false);
        this.setWatchdog(0);
        if (!finalState) finalState = this.getPCBreak(true); else this.getPCBreak(true);
      }
      // Capture the result from core RAM BEFORE any restore — always, so a partial
      // (watchdog/stopAtPC) result still hands back whatever the codec wrote.
      if (capture) captured = capture(this);
      // Read the final register file + PC for progress reporting (entry-exact when
      // the breakpoint fired before-dispatch, which is the m68k default).
      let finalPC = finalState && finalState.lastPC != null ? finalState.lastPC : null;
      let finalRegs = null;
      try { finalRegs = this._readCallRegs(); } catch { /* best effort */ }
      this._lastCallResult = { finalPC, finalRegs };
    } finally {
      if (snapshot) this.unserializeState(snapshot);
    }
    const fin = this._lastCallResult || {};
    return {
      returned, framesRun,
      ...(pure ? { pure: true, pureMode } : {}),
      ...(watchdogTripped ? { watchdog: true, reason: "watchdog: hit the instruction budget (likely a runaway loop — wrong A0/regs, a needed preset, or legitimately huge; raise maxInstructions or check the entry setup)" } : {}),
      ...(stoppedAtPC ? { stoppedAtPC: "$" + (stopAtPC >>> 0).toString(16).toUpperCase() } : {}),
      ...(fin.finalPC != null ? { finalPC: "$" + fin.finalPC.toString(16).toUpperCase(), finalPCRaw: fin.finalPC } : {}),
      ...(fin.finalRegs ? { finalRegs: fin.finalRegs } : {}),
      ...(captured !== undefined ? { captured } : {}),
    };
  }

  /** Read the small set of registers most useful for callSubroutine progress
   *  reporting (m68k A0/A1/D0/D1 + PC/SP), by reg-id, best-effort. */
  _readCallRegs() {
    const out = {};
    const ids = { D0: 0, D1: 1, A0: 8, A1: 9, PC: 16, SP: 18 };
    for (const [name, id] of Object.entries(ids)) {
      try { out[name] = "0x" + (this.getReg(id) >>> 0).toString(16).toUpperCase(); } catch { /* skip */ }
    }
    return out;
  }

  /**
   * Per-CPU calling profile for callSubroutine: how the stack/return work for the
   * loaded platform's CPU. reg-ids match each core's romdev_setreg convention.
   *  - retBytes: width of the return address pushed (RTS/RTL pop width)
   *  - retBigEndian: byte order of the pushed return address
   *  - stackPage: if set, a page-relative stack ($0100 for 6502) — SP is an 8-bit
   *    index into that page (push writes at page+SP, decrement); if undefined the
   *    stack is a full predecrement stack (m68k/SM83) addressed by SP directly.
   *  - ramMask / ramRegion: CPU-addr → memory region mapping for the stack writes.
   */
  _cpuCallProfile() {
    const p = this.status.platform;
    // `instrPerFrame`: a CONSERVATIVE estimate of how many instructions one frame
    // of this CPU executes (clock ÷ avg-cycles-per-instr ÷ ~60fps). Used to size
    // the callSubroutine watchdog budget so it trips BEFORE the per-frame cap even
    // on the slow ~1MHz 8-bit CPUs (a fixed 4M never trips inside 600 frames on a
    // 6507/6510 — only ~3-3.8M instructions run in 600 frames there). Real codecs
    // finish in <~1M instructions on any of these, so 0.8×maxFrames×instrPerFrame
    // still clears a legit decompress with margin. See the watchdog budget below.
    switch (p) {
      case "genesis": case "megadrive": case "md":
        // m68k: SP=18, PC=16; RTS pops a 4-byte big-endian return; work RAM
        // $FF0000-$FFFFFF → system_ram (& 0xFFFF). Sentinel 0 (vector area).
        // 7.67MHz / ~10 cyc/instr / 60 ≈ 12.8k; use 50k (tight loops are denser).
        return { spReg: 18, pcReg: 16, retBytes: 4, retBigEndian: true, defaultSentinel: 0, ramMask: 0xFFFF, instrPerFrame: 50000 };
      case "nes": case "atari2600": case "atari7800": case "lynx": case "c64": case "pce":
        // 6502/65C02/HuC6280/6510: A=0,X=1,Y=2,P=3,SP=4,PC=16. RTS pops 2 bytes
        // (PCL,PCH) from the $0100 page. system_ram is the low RAM; the stack page
        // $0100-$01FF maps to system_ram offset 0x100-0x1FF on most of these.
        // The slowest cores live here (atari2600 6507 ~1.19MHz, c64 6510 ~1MHz):
        // ~5-6k instr/frame → 600 frames ≈ 3-3.8M, BELOW a flat 4M. 6k keeps the
        // per-CPU budget under the frame cap so the watchdog actually trips.
        return { spReg: 4, pcReg: 16, retBytes: 2, retBigEndian: true, defaultSentinel: 0, stackPage: 0x100, ramMask: 0xFFFF, retAdjust: -1, instrPerFrame: 6000 };
      case "gb": case "gbc":
        // SM83: PC=16, SP=18. CALL/RET push 2 little-endian bytes, predecrement
        // SP. Stack lives in WRAM ($C000-$DFFF, also high RAM); SP & 0x1FFF →
        // system_ram (the 8KB WRAM window). Sentinel 0 (rst vector area).
        // 4.19MHz / ~10 cyc / 60 ≈ 7k.
        return { spReg: 18, pcReg: 16, retBytes: 2, retBigEndian: false, defaultSentinel: 0, ramMask: 0x1FFF, instrPerFrame: 8000 };
      case "snes":
        // 65816: SP=4, PC=16. A long subroutine (JSL/RTL) pushes a 3-byte return
        // (the 65816 stack is in bank 0, page-relative is the 8-bit/16-bit S). We
        // push 3 bytes at the 16-bit S in bank 0 (predecrement); WRAM low mirror.
        // ~3.58MHz / ~6 cyc / 60 ≈ 10k.
        return { spReg: 4, pcReg: 16, retBytes: 3, retBigEndian: false, defaultSentinel: 0, ramMask: 0x1FFF, retAdjust: -1, instrPerFrame: 12000 };
      case "sms": case "gg": case "msx":
        // Z80: PC=16, SP=18. CALL/RET push 2 LE bytes predecrement. Work RAM
        // window varies (SMS $C000-$DFFF → sms low RAM); SP & 0x1FFF.
        // 3.58MHz / ~7 cyc / 60 ≈ 8.5k (tight JR-loops denser → use 7k floor).
        // NOTE: on SMS/GG the Z80 is the active CPU and the gpgx watchdog counter
        // is wired into z80_run as of the matching core patch (was m68k-only).
        return { spReg: 18, pcReg: 16, retBytes: 2, retBigEndian: false, defaultSentinel: 0, ramMask: 0x1FFF, instrPerFrame: 7000 };
      case "gba":
        // ARM7TDMI: SP=r13 (reg-id 13), PC=r15 (reg-id 15). No implicit return-on-
        // stack (BL uses LR). callSubroutine on ARM would set LR=sentinel instead
        // of pushing — handled by the ARM branch (lrReg). EWRAM mapping.
        // 16.78MHz / ~2 cyc / 60 ≈ 140k → the fixed 4M cap applies first.
        return { spReg: 13, pcReg: 15, retBytes: 4, retBigEndian: false, defaultSentinel: 0, ramMask: 0x3FFFF, lrReg: 14, instrPerFrame: 140000 };
      default:
        // Unknown — m68k-shaped fallback (Genesis defaults).
        return { spReg: 18, pcReg: 16, retBytes: 4, retBigEndian: true, defaultSentinel: 0, ramMask: 0xFFFF, instrPerFrame: 50000 };
    }
  }

  /** Write bytes to a CPU address, resolving the platform's CPU-space→region map
   *  (used by callSubroutine to seed the stack). Uses the per-CPU profile's mask. */
  writeMemoryCpuAddr(cpuAddr, bytes) {
    const prof = this._cpuCallProfile();
    const off = (cpuAddr & (prof.ramMask ?? 0xFFFF)) >>> 0;
    this.writeMemory("system_ram", off, bytes);
  }

  // ── Range watch + PC coverage (item 2, discovery) ───────────────────────────

  /** True when this core exposes the range watch + coverage log. */
  rangeWatchSupported() {
    const mod = this.mod;
    return !!(mod && typeof mod._romdev_range_set === "function" && typeof mod._romdev_cov_set === "function");
  }

  /**
   * Run `frames` frames logging EVERY read/write touching [lo,hi] (mode 1=read,
   * 2=write, 3=both) — the list-all-hits discovery tool. Returns
   * { events:[{pc,address,value}], total, stored, truncated }.
   */
  watchRange(lo, hi, mode, frames) {
    const mod = this._needMod();
    this._needMedia();
    if (!this.rangeWatchSupported()) throw new Error("range watch not supported by this core.");
    const m = mode === "read" ? 1 : mode === "write" ? 2 : 3;
    mod._romdev_range_set(lo >>> 0, hi >>> 0, m, 1);
    try {
      this._runFramesExclusive(() => false, frames);
    } finally {
      // leave armed=0 after draining
    }
    // Drain: out2=[total,stored]; out=packed triples.
    const CAP = 4096;
    const outPtr = mod._malloc(CAP * 3 * 4);
    const out2Ptr = mod._malloc(8);
    try {
      const n = mod._romdev_range_get(outPtr, CAP, out2Ptr);
      const out2 = new Uint32Array(mod.HEAPU8.buffer, out2Ptr, 2);
      const total = out2[0], stored = out2[1];
      const u = new Uint32Array(mod.HEAPU8.buffer, outPtr, n * 3);
      const events = [];
      for (let i = 0; i < n; i++) events.push({ pc: u[i * 3], address: u[i * 3 + 1], value: u[i * 3 + 2] & 0xFF });
      mod._romdev_range_set(0, 0, 0, 0); // disarm
      return { events, total, stored, truncated: total > stored };
    } finally {
      mod._free(outPtr); mod._free(out2Ptr);
    }
  }

  /**
   * Run `frames` frames recording every DISTINCT PC executed within [lo,hi] — the
   * coverage trace ("what code runs here?"). Returns { pcs:[...], distinct, total, truncated }.
   */
  logPCRange(lo, hi, frames) {
    const mod = this._needMod();
    this._needMedia();
    if (!this.rangeWatchSupported()) throw new Error("coverage trace not supported by this core.");
    mod._romdev_cov_set(lo >>> 0, hi >>> 0, 1);
    this._runFramesExclusive(() => false, frames);
    const CAP = 8192;
    const outPtr = mod._malloc(CAP * 4);
    const out2Ptr = mod._malloc(8);
    try {
      const n = mod._romdev_cov_get(outPtr, CAP, out2Ptr);
      const out2 = new Uint32Array(mod.HEAPU8.buffer, out2Ptr, 2);
      const distinct = out2[0], total = out2[1];
      const u = new Uint32Array(mod.HEAPU8.buffer, outPtr, n);
      const pcs = Array.from(u.slice(0, n));
      mod._romdev_cov_set(0, 0, 0); // disarm
      return { pcs, distinct, total, truncated: distinct > n };
    } finally {
      mod._free(outPtr); mod._free(out2Ptr);
    }
  }

  // ── Targeted VDP-DMA watch (item 3, Genesis only) ───────────────────────────

  /** True when VDP-DMA logging applies to the LOADED platform. The gpgx core
   *  exports the DMA hooks, but only GENESIS has VDP DMA — SMS/GG (also gpgx) use
   *  a different VDP with no DMA, so the hook never fires there. Gate on the
   *  loaded platform, not just the export's presence. */
  dmaWatchSupported() {
    const mod = this.mod;
    const p = this.status.platform;
    const isGenesis = p === "genesis" || p === "megadrive" || p === "md";
    return isGenesis && !!(mod && typeof mod._romdev_dmawatch_set === "function" && typeof mod._romdev_dmawatch_get === "function");
  }

  /**
   * Run `frames` frames logging every mem→VDP DMA. Returns
   * { dmas:[{vramDest, source, lengthWords, code}], total, stored, truncated }.
   * The caller filters by vramDest. Genesis-only.
   */
  watchDma(frames) {
    const mod = this._needMod();
    this._needMedia();
    if (!this.dmaWatchSupported()) throw new Error("VDP-DMA watch not supported by this core (Genesis only).");
    mod._romdev_dmawatch_set(1);
    this._runFramesExclusive(() => false, frames);
    const CAP = 1024;
    const outPtr = mod._malloc(CAP * 4 * 4);
    const out2Ptr = mod._malloc(8);
    try {
      const n = mod._romdev_dmawatch_get(outPtr, CAP, out2Ptr);
      const out2 = new Uint32Array(mod.HEAPU8.buffer, out2Ptr, 2);
      const total = out2[0], stored = out2[1];
      const u = new Uint32Array(mod.HEAPU8.buffer, outPtr, n * 4);
      const dmas = [];
      for (let i = 0; i < n; i++) dmas.push({ vramDest: u[i * 4], source: u[i * 4 + 1], lengthWords: u[i * 4 + 2], code: u[i * 4 + 3] });
      mod._romdev_dmawatch_set(0); // disarm
      return { dmas, total, stored, truncated: total > stored };
    } finally {
      mod._free(outPtr); mod._free(out2Ptr);
    }
  }

  /**
   * Per-frame VDP-DMA timeline. Steps `frames` frames ONE AT A TIME, and for
   * each frame reports how many mem→VDP DMAs fired + how many VRAM/CRAM/VSRAM
   * bytes they moved. The core's `romdev_dmawatch_set(1)` RESETS its counters
   * (see the patch), so re-arming before each single-frame step gives a clean
   * per-frame bucket with no core rebuild — the cheap derivation of "VDP/DMA
   * work per frame" the feel-diagnostics workflow needs.
   *
   * `onFrame(i)` is called at the top of each frame (before the step) so the
   * caller can drive scheduled input. Genesis-only.
   *
   * Returns { frames:[{frame, dmas, words, bytes, romBytes, ramBytes}], ... }.
   * `romBytes`/`ramBytes` split the moved bytes by source bus (ROM asset upload
   * vs the RAM→VRAM sprite/scroll refresh) so a per-frame asset-DMA spike — the
   * "I redrew a tilemap in the loop" smell — stands out from the steady refresh.
   */
  watchDmaPerFrame(frames, onFrame) {
    const mod = this._needMod();
    this._needMedia();
    if (!this.dmaWatchSupported()) throw new Error("VDP-DMA watch not supported by this core (Genesis only).");
    const CAP = 1024;
    const outPtr = mod._malloc(CAP * 4 * 4);
    const out2Ptr = mod._malloc(8);
    const isRam = (src) => (src >>> 0) >= 0xE00000;
    const out = [];
    let peakBytes = 0, peakFrame = -1, totalBytes = 0, totalDmas = 0;
    try {
      for (let i = 0; i < frames; i++) {
        if (onFrame) onFrame(i);
        mod._romdev_dmawatch_set(1);          // arm + RESET counters for this frame
        this._runFramesExclusive(() => false, 1);
        const n = mod._romdev_dmawatch_get(outPtr, CAP, out2Ptr);
        const out2 = new Uint32Array(mod.HEAPU8.buffer, out2Ptr, 2);
        const total = out2[0];                // total DMAs this frame (>= stored)
        const u = new Uint32Array(mod.HEAPU8.buffer, outPtr, n * 4);
        let words = 0, romBytes = 0, ramBytes = 0;
        for (let k = 0; k < n; k++) {
          const src = u[k * 4 + 1], len = u[k * 4 + 2];
          words += len;
          if (isRam(src)) ramBytes += len * 2; else romBytes += len * 2;
        }
        const bytes = words * 2;
        out.push({ frame: i, dmas: total, words, bytes, romBytes, ramBytes,
          ...(total > n ? { coreBufferTruncated: true } : {}) });
        totalBytes += bytes; totalDmas += total;
        if (bytes > peakBytes) { peakBytes = bytes; peakFrame = i; }
      }
      mod._romdev_dmawatch_set(0);            // disarm
      return { frames: out, totalBytes, totalDmas, peakBytes, peakFrame };
    } finally {
      mod._free(outPtr); mod._free(out2Ptr);
    }
  }

  pause() {
    this.status.paused = true;
  }

  resume() {
    this.status.paused = false;
  }

  getStatus() {
    return { ...this.status };
  }

  _needMod() {
    if (!this.mod) throw new Error("no core loaded — call loadCore first");
    return this.mod;
  }

  // Guard for every op that needs a loaded game. The bare "no media loaded"
  // left the agent guessing; this names the fix (loadMedia) and the gotcha
  // (emulator state is in-memory, so a reconnect/restart drops it). The richer
  // session-aware recovery (echoing the exact prior loadMedia call) lives at the
  // tool layer in state.js getHost(); this is the host-level twin.
  _needMedia() {
    if (!this.status.loaded) {
      throw new Error(
        "No media loaded — call loadMedia({platform, path}) before this op. " +
        "(If you DID load and hit this after a reconnect/restart, the host's in-memory " +
        "state didn't survive — re-run loadMedia with your ROM to pick back up.)",
      );
    }
  }

  /**
   * Build a friendly error message when a memory region is empty (the
   * core didn't expose it). Includes per-platform suggestions when we
   * know a sibling region likely has what the caller wanted.
   *
   * Round 26 footgun: an agent debugging GB read `video_ram` (the
   * generic libretro id 3), got "empty", and started a multi-iteration
   * "my VRAM writes are being optimized away" spiral — when in fact
   * gambatte exposes VRAM as `gb_vram`, not the generic id.
   */
  _unknownRegionError(region) {
    // A bad region name should never leave the agent guessing — list the valid
    // ones (the single source of truth, MemoryRegionToRetro) so it can pick the
    // right one. The cross-platform names (system_ram / video_ram / save_ram)
    // exist everywhere; the rest are platform-specific.
    const valid = Object.keys(MemoryRegionToRetro).sort();
    const common = valid.filter((r) => ["system_ram", "video_ram", "save_ram", "rom"].includes(r));
    return (
      `Unknown memory region '${region}'. ` +
      `Common (most platforms): ${common.join(", ")}. ` +
      `All registered region names: ${valid.join(", ")}. ` +
      `(Region availability is per platform — some names only resolve on the platform that has that hardware.)`
    );
  }

  _emptyRegionError(region) {
    const plat = this.status && this.status.platform;
    // SRAM gets an honest, specific answer: empty save_ram almost always means
    // "this cart/system has no battery save," NOT "the core is broken."
    if (region === "save_ram") {
      if (["atari2600", "atari7800", "lynx"].includes(plat)) {
        return `'${plat}' has no cartridge battery saves (the hardware never supported them) — ` +
          `save_ram is always empty here, there's no save file to read/write.`;
      }
      if (plat === "c64") {
        return `C64 has no cartridge battery SRAM — the C64 save medium is the FLOPPY (.d64), ` +
          `not save_ram (so save_ram is empty, as expected). A game's own KERNAL SAVE writes ` +
          `into the live disk; capture it with state({op:'exportDisk', path}) (the .d64 then ` +
          `includes the saved file, re-loadable to resume). Inject an outside save with ` +
          `state({op:'importDisk', path}) or state({op:'putDiskFile', path}).`;
      }
      return `save_ram is empty on platform '${plat}': this CART has no battery save ` +
        `(check cart({op:'identify'}).saveRam.hasBattery — many ROMs use passwords or no save). ` +
        `If you expected a save, confirm the cart header marks it battery-backed. ` +
        `For a full-machine snapshot regardless of SRAM, use state({op:'save'/'load', path}).`;
    }
    const suggestions = {
      // platform → { generic-region-name: "use this instead" }
      gb:    { video_ram: "gb_vram",  save_ram: "save_ram (likely empty on cartless ROMs — try gb_oam / gb_io / gb_hram for non-VRAM state)" },
      gbc:   { video_ram: "gb_vram",  save_ram: "save_ram (try gb_oam / gb_io / gb_hram for non-VRAM state)" },
      sms:   { video_ram: "sms_vram (or sms_cram for palette, sms_vdp_regs for VDP regs)" },
      gg:    { video_ram: "gg_vram (or gg_cram for the 64-byte 12-bit palette, sms_vdp_regs for VDP regs)" },
      snes:  { video_ram: "snes_oam (sprite OAM), snes_cgram (palette), snes_aram (SPC700), or snes_fillram (PPU/DMA reg shadow). The libretro generic 'video_ram' id isn't wired in snes9x." },
      genesis: { video_ram: "Genesis VRAM IS exposed via 'video_ram' (gpgx) once a ROM is loaded and a frame has run — if it reads empty, step a frame first (the SAT/sprites need the game to have written VRAM). Palette/scroll/VDP regs are genesis_cram / genesis_vsram / genesis_vdp_regs. For decoded views use inspectSprites / inspectPatternTiles / inspectBackgroundMap / getRenderingContext." },
      c64:   { video_ram: "c64_color_ram (1 KB) / c64_vic_regs / c64_sid_regs / c64_cia1_regs / c64_cia2_regs. The C64 has no separate VRAM — the VIC-II reads from main system_ram." },
    };
    const hint = suggestions[plat] && suggestions[plat][region];
    if (hint) {
      return `memory region '${region}' is empty on platform '${plat}'. Try: ${hint}. ` +
             `Or use inspectPatternTiles / inspectBackgroundMap / inspectSprites / inspectPalette which abstract over per-platform memory layout.`;
    }
    return `memory region '${region}' is empty (core didn't expose it on platform '${plat || "?"}'). ` +
           `If you need raw bytes, see the platform-specific regions in src/host/types.js or the inspect* tools which know the right region per platform.`;
  }
}
