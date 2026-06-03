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
import { mkdtempSync } from "node:fs";
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
const PLATFORM_CORE_OPTIONS = {};

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
};
import { RETRO_DEVICE_JOYPAD } from "./retroConstants.js";

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
   */
  async loadCore(jsPath, wasmPath) {
    if (this.mod) throw new Error("core already loaded; create a new host");
    const mod = await loadLibretroCore({ jsPath, wasmPath });
    this.mod = mod;
    registerCallbacks({ mod, state: this.state, log: this.log });
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
    const mediaKind = args.mediaKind ?? defaultMediaKind(platform);

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
      throw new Error(`retro_load_game failed for ${mediaPath}`);
    }

    this.status.platform = platform;
    this.status.mediaPath = mediaPath;
    this.status.mediaKind = mediaKind;
    this.status.loaded = true;
    this.status.frameCount = 0;

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
    mod._free(avInfoPtr);

    // Configure controller port 0 as joypad (some cores default to NONE).
    mod._retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);

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
    if (!this.status.loaded) throw new Error("no media loaded");
    if (this.status.paused) return 0;
    for (let i = 0; i < n; i++) {
      mod._retro_run();
      this.status.frameCount++;
    }
    if (this.state.lastFrame) {
      this.status.fbWidth = this.state.lastFrame.width;
      this.status.fbHeight = this.state.lastFrame.height;
    }
    return n;
  }

  /** @returns {{ width: number, height: number, pitch: number, format: number, pixels: Uint8Array }} */
  getFramebuffer() {
    if (!this.state.lastFrame) throw new Error("no frame produced yet — step frames first");
    return this.state.lastFrame;
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
    for (let port = 0; port < this.state.inputPorts.length; port++) {
      const portInput = input.ports[port];
      this.state.inputPorts[port][0] = portInputToMask(portInput, platform);
    }
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
    if (!snapshot) throw new Error(`no save state named '${name}'`);
    this.unserializeState(snapshot);
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
  }

  listStates() {
    return Array.from(this.namedStates.keys());
  }

  /**
   * @param {import("./types.js").MemoryRegion} region
   * @param {number} offset
   * @param {number} length
   * @returns {Uint8Array}
   */
  readMemory(region, offset, length) {
    const mod = this._needMod();
    const id = MemoryRegionToRetro[region];
    if (id === undefined) throw new Error(`unknown memory region '${region}'`);
    const ptr = mod._retro_get_memory_data(id);
    const size = mod._retro_get_memory_size(id);
    if (!ptr || !size) throw new Error(this._emptyRegionError(region));
    if (offset < 0 || offset + length > size) {
      throw new RangeError(`read out of bounds: offset=${offset} len=${length} size=${size}`);
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
    if (id === undefined) throw new Error(`unknown memory region '${region}'`);
    const ptr = mod._retro_get_memory_data(id);
    const size = mod._retro_get_memory_size(id);
    if (!ptr || !size) throw new Error(this._emptyRegionError(region));
    if (offset < 0 || offset + bytes.length > size) {
      throw new RangeError(`write out of bounds: offset=${offset} len=${bytes.length} size=${size}`);
    }
    mod.HEAPU8.set(bytes, ptr + offset);
  }

  reset() {
    const mod = this._needMod();
    mod._retro_reset();
    this.status.frameCount = 0;
    // A reset clears the core's active cheats (they live in volatile core
    // state, never in the ROM) — keep our mirror in sync.
    this._activeCheats = new Map();
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
  setWatchpoint(address, enabled = true) {
    const mod = this._needMod();
    if (typeof mod._romdev_watchpoint_set !== "function") {
      throw new Error("this core build does not expose the write watchpoint (rebuild with romdev_watchpoint_* exports).");
    }
    mod._romdev_watchpoint_set(address >>> 0, enabled ? 1 : 0);
  }

  /** Read the watchpoint state: { enabled, address, lastPC, lastValue, hits }.
   *  lastPC is 0xFFFFFFFF (reported as null) until a write is seen. Pass
   *  clearHits to reset the counter + lastPC after reading. */
  getWatchpoint(clearHits = false) {
    const mod = this._needMod();
    if (typeof mod._romdev_watchpoint_get !== "function") {
      throw new Error("this core build does not expose the write watchpoint.");
    }
    const ptr = mod._malloc(20); // 5 × uint32
    try {
      mod._romdev_watchpoint_get(ptr, clearHits ? 1 : 0);
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
  _emptyRegionError(region) {
    const plat = this.status && this.status.platform;
    const suggestions = {
      // platform → { generic-region-name: "use this instead" }
      gb:    { video_ram: "gb_vram",  save_ram: "save_ram (likely empty on cartless ROMs — try gb_oam / gb_io / gb_hram for non-VRAM state)" },
      gbc:   { video_ram: "gb_vram",  save_ram: "save_ram (try gb_oam / gb_io / gb_hram for non-VRAM state)" },
      sms:   { video_ram: "sms_vram (or sms_cram for palette, sms_vdp_regs for VDP regs)" },
      gg:    { video_ram: "gg_vram (or gg_cram for the 64-byte 12-bit palette, sms_vdp_regs for VDP regs)" },
      snes:  { video_ram: "snes_oam (sprite OAM), snes_cgram (palette), snes_aram (SPC700), or snes_fillram (PPU/DMA reg shadow). The libretro generic 'video_ram' id isn't wired in snes9x." },
      genesis: { video_ram: "genesis_cram / genesis_vsram / genesis_vdp_regs — the generic 'video_ram' id isn't wired in gpgx for Genesis. VRAM itself isn't exposed; use inspectPatternTiles / inspectBackgroundMap / getRenderingContext instead." },
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
