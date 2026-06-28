// libretro callback wiring.
//
// Registers the four required callbacks (env, video_refresh, input_poll,
// input_state) plus audio sample + sample_batch. State lives on a plain
// CallbackState object closed over by the addFunction handlers.
//
// Env handler patterns are mirrored from retroemu/src/core/LibretroHost.js —
// many cores call log_cb / GET_VARIABLE / etc. inside retro_load_game, so we
// must respond correctly to avoid WASM "null function / signature mismatch"
// traps on cold load.
//
// See memory `libretro-wasm-patterns` for rationale.

import { RETRO_HW_FRAME_BUFFER_VALID } from "./retroConstants.js";

/**
 * @typedef {Object} Frame
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {number} format one of RETRO_PIXEL_FORMAT_*
 * @property {Uint8Array} pixels copy, safe to keep across calls
 */

/**
 * @typedef {Object} CallbackState
 * @property {number} pixelFormat negotiated pixel format
 * @property {Frame | null} lastFrame
 * @property {Int16Array[]} audioRing interleaved S16 stereo samples
 * @property {boolean} supportsNoGame
 * @property {Uint16Array[]} inputPorts joypad bitmask per port
 * @property {Map<string, { description: string, options: string[], value: string }>} coreVariables
 * @property {boolean} variablesUpdated
 * @property {string} systemDir absolute path the core can ask about
 * @property {string} saveDir absolute path the core can ask about
 * @property {number[]} _allocatedPtrs heap pointers we keep alive for the core's lifetime
 * @property {number | null} _logCbPtr cached log function pointer
 */

import {
  RETRO_ENVIRONMENT_EXPERIMENTAL,
  RETRO_PIXEL_FORMAT_0RGB1555,
  RETRO_PIXEL_FORMAT_RGB565,
  RETRO_PIXEL_FORMAT_XRGB8888,
  RETRO_DEVICE_JOYPAD,
} from "./retroConstants.js";

// Env command IDs (extended set from retroemu)
const E = {
  GET_OVERSCAN: 2,
  GET_CAN_DUPE: 3,
  SET_MESSAGE: 6,
  SHUTDOWN: 7,
  SET_PERFORMANCE_LEVEL: 8,
  GET_SYSTEM_DIRECTORY: 9,
  SET_PIXEL_FORMAT: 10,
  SET_INPUT_DESCRIPTORS: 11,
  SET_KEYBOARD_CALLBACK: 12,
  SET_DISK_CONTROL_INTERFACE: 13,
  SET_HW_RENDER: 14,
  GET_VARIABLE: 15,
  SET_VARIABLES: 16,
  GET_VARIABLE_UPDATE: 17,
  SET_SUPPORT_NO_GAME: 18,
  GET_LIBRETRO_PATH: 19,
  SET_FRAME_TIME_CALLBACK: 21,
  SET_AUDIO_CALLBACK: 22,
  GET_RUMBLE_INTERFACE: 23,
  GET_INPUT_DEVICE_CAPABILITIES: 24,
  GET_SENSOR_INTERFACE: 25,
  GET_CAMERA_INTERFACE: 26,
  GET_LOG_INTERFACE: 27,
  GET_PERF_INTERFACE: 28,
  GET_LOCATION_INTERFACE: 29,
  GET_CONTENT_DIRECTORY: 30,
  GET_SAVE_DIRECTORY: 31,
  SET_SYSTEM_AV_INFO: 32,
  SET_PROC_ADDRESS_CALLBACK: 33,
  SET_SUBSYSTEM_INFO: 34,
  SET_CONTROLLER_INFO: 35,
  SET_MEMORY_MAPS: 36,
  SET_GEOMETRY: 37,
  GET_USERNAME: 38,
  GET_LANGUAGE: 39,
  GET_CURRENT_SOFTWARE_FRAMEBUFFER: 40,
  GET_HW_RENDER_INTERFACE: 41,
  SET_SUPPORT_ACHIEVEMENTS: 42,
  SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE: 43,
  SET_SERIALIZATION_QUIRKS: 44,
  SET_HW_SHARED_CONTEXT: 44 | 0x10000, // 0x1004C
  GET_VFS_INTERFACE: 45,
  GET_LED_INTERFACE: 46,
  GET_AUDIO_VIDEO_ENABLE: 47,
  GET_MIDI_INTERFACE: 48,
  GET_FASTFORWARDING: 49,
  GET_TARGET_REFRESH_RATE: 50,
  GET_INPUT_BITMASKS: 51,
  GET_CORE_OPTIONS_VERSION: 52,
  SET_CORE_OPTIONS: 53,
  SET_CORE_OPTIONS_INTL: 54,
  SET_CORE_OPTIONS_DISPLAY: 55,
  GET_PREFERRED_HW_RENDER: 56,
  GET_DISK_CONTROL_INTERFACE_VERSION: 57,
  SET_DISK_CONTROL_EXT_INTERFACE: 58,
  GET_MESSAGE_INTERFACE_VERSION: 59,
  SET_MESSAGE_EXT: 60,
  GET_INPUT_MAX_USERS: 61,
  SET_AUDIO_BUFFER_STATUS_CALLBACK: 62,
  SET_MINIMUM_AUDIO_LATENCY: 63,
  SET_FASTFORWARDING_OVERRIDE: 64,
  SET_CONTENT_INFO_OVERRIDE: 65,
  GET_GAME_INFO_EXT: 66,
  SET_CORE_OPTIONS_V2: 67,
  SET_CORE_OPTIONS_V2_INTL: 68,
  SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK: 69,
  SET_VARIABLE: 70,
};

/** @returns {CallbackState} */
export function newCallbackState({ systemDir = "", saveDir = "" } = {}) {
  return {
    pixelFormat: RETRO_PIXEL_FORMAT_0RGB1555,
    lastFrame: null,
    audioRing: [],
    supportsNoGame: false,
    inputPorts: [new Uint16Array(1), new Uint16Array(1)],
    // Keyboard state: a set of currently-pressed RETRO_KEY_* codes. The core
    // polls via input_state(port, KEYBOARD, 0, keyCode) and gets 1 if pressed.
    keysDown: new Set(),
    coreVariables: new Map(),
    variablesUpdated: false,
    systemDir,
    saveDir,
    _allocatedPtrs: [],
    _logCbPtr: null,
  };
}

/**
 * @param {number} format
 * @returns {number}
 */
export function pixelBytes(format) {
  if (format === RETRO_PIXEL_FORMAT_XRGB8888) return 4;
  if (format === RETRO_PIXEL_FORMAT_RGB565) return 2;
  if (format === RETRO_PIXEL_FORMAT_0RGB1555) return 2;
  return 4;
}

/**
 * Register all libretro callbacks on the module. Must be called BEFORE
 * `_retro_init()`.
 * @param {Object} args
 * @param {any} args.mod Emscripten Module
 * @param {CallbackState} args.state
 * @param {(level: number, msg: string) => void} [args.log]
 */
export function registerCallbacks(args) {
  const { mod, state, log } = args;

  const envCb = mod.addFunction((cmd, dataPtr) => {
    return handleEnv(mod, state, cmd, dataPtr, log) ? 1 : 0;
  }, "iii");
  mod._retro_set_environment(envCb);

  const videoCb = mod.addFunction((dataPtr, w, h, pitch) => {
    // HW-render path: dataPtr == RETRO_HW_FRAME_BUFFER_VALID means "the frame is in
    // the GL framebuffer." The WASM passes the i32 as SIGNED -1; the constant is the
    // UNSIGNED 0xFFFFFFFF — coerce with >>>0 so both match. DON'T read back here —
    // GL state is only stable AFTER _retro_run returns. Flag it; stepFrames does the
    // glReadPixels post-run.
    const uPtr = dataPtr >>> 0;
    if (uPtr === RETRO_HW_FRAME_BUFFER_VALID && (state.hwRender?.active || state.proxied)) {
      state.hwFramePending = true;
      // Remember the core's reported active resolution (e.g. DC 640x480) so the
      // readback can crop the (often larger, e.g. 853x853) GL FBO to just the
      // rendered region instead of returning the whole viewport with dead borders.
      if (w > 0 && h > 0) { state.hwFrameW = w; state.hwFrameH = h; }
      return;
    }
    if (dataPtr === 0 || uPtr === RETRO_HW_FRAME_BUFFER_VALID) return;
    const bytes = h * pitch;
    const view = mod.HEAPU8.subarray(dataPtr, dataPtr + bytes);
    state.lastFrame = {
      width: w,
      height: h,
      pitch,
      format: state.pixelFormat,
      pixels: new Uint8Array(view),
    };
  }, "viiii");
  mod._retro_set_video_refresh(videoCb);

  const audioBatchCb = mod.addFunction((dataPtr, frames) => {
    if (dataPtr === 0 || frames === 0) return frames;
    const byteLen = frames * 2 * 2;
    const samples = new Int16Array(mod.HEAPU8.buffer, dataPtr, byteLen / 2).slice();
    state.audioRing.push(samples);
    return frames;
  }, "iii");
  mod._retro_set_audio_sample_batch(audioBatchCb);

  const audioOneCb = mod.addFunction((left, right) => {
    const buf = new Int16Array(2);
    buf[0] = left;
    buf[1] = right;
    state.audioRing.push(buf);
  }, "vii");
  mod._retro_set_audio_sample(audioOneCb);

  const inputPollCb = mod.addFunction(() => {
    // input set explicitly by MCP callers — nothing to poll.
  }, "v");
  mod._retro_set_input_poll(inputPollCb);

  const inputStateCb = mod.addFunction((port, device, _idx, id) => {
    // device 3 = RETRO_DEVICE_KEYBOARD — id is the libretro keycode
    if (device === 3) {
      return state.keysDown.has(id) ? 1 : 0;
    }
    // Default: JOYPAD (device 1) and unknown devices fall through to bitfield.
    const portBits = state.inputPorts[port];
    if (!portBits) return 0;
    const bits = portBits[0];
    if (id === 256) return bits; // RETRO_DEVICE_ID_JOYPAD_MASK
    return bits & (1 << id) ? 1 : 0;
  }, "iiiii");
  mod._retro_set_input_state(inputStateCb);
}

function allocString(mod, state, str) {
  const bytes = Buffer.from(str + "\0", "utf-8");
  const ptr = mod._malloc(bytes.length);
  mod.HEAPU8.set(bytes, ptr);
  state._allocatedPtrs.push(ptr);
  return ptr;
}

function handleEnv(mod, state, rawCmd, dataPtr, log) {
  const cmd = rawCmd & ~RETRO_ENVIRONMENT_EXPERIMENTAL;

  switch (cmd) {
    case E.GET_CAN_DUPE:
      mod.setValue(dataPtr, 1, "i8");
      return true;

    case E.GET_OVERSCAN:
      mod.setValue(dataPtr, 0, "i8");
      return true;

    case E.SET_MESSAGE:
      return true; // accept, no UI to show it

    case E.SET_PIXEL_FORMAT: {
      const fmt = mod.getValue(dataPtr, "i32");
      if (
        fmt === RETRO_PIXEL_FORMAT_XRGB8888 ||
        fmt === RETRO_PIXEL_FORMAT_RGB565 ||
        fmt === RETRO_PIXEL_FORMAT_0RGB1555
      ) {
        state.pixelFormat = fmt;
        return true;
      }
      return false;
    }

    case E.SET_SUPPORT_NO_GAME: {
      const v = mod.getValue(dataPtr, "i8");
      state.supportsNoGame = v !== 0;
      return true;
    }

    case E.GET_SYSTEM_DIRECTORY: {
      mod.setValue(dataPtr, allocString(mod, state, state.systemDir), "i32");
      return true;
    }

    case E.GET_SAVE_DIRECTORY: {
      mod.setValue(dataPtr, allocString(mod, state, state.saveDir), "i32");
      return true;
    }

    case E.GET_CONTENT_DIRECTORY: {
      mod.setValue(dataPtr, allocString(mod, state, state.saveDir), "i32");
      return true;
    }

    case E.GET_LIBRETRO_PATH: {
      mod.setValue(dataPtr, allocString(mod, state, state.systemDir), "i32");
      return true;
    }

    case E.GET_LOG_INTERFACE: {
      // retro_log_callback { retro_log_printf_t log }
      // Signature: void(enum level, const char *fmt, ...). In Emscripten the
      // vararg comes through as a pointer-to-stack; we declare 'viii' so the
      // function-table entry has the right arity for the WASM caller.
      //
      // We don't implement full vsnprintf in JS, but the fmt string itself is
      // already a useful diagnostic — most cores pass a fully-formed message
      // (no varargs substitution needed) or a message + N args we can't decode.
      // Read the fmt as-is so log output is actually readable.
      if (!state._logCbPtr) {
        state._logCbPtr = mod.addFunction((level, fmtPtr, _vaPtr) => {
          if (!log) return;
          let msg = "<unreadable>";
          try { msg = mod.UTF8ToString(fmtPtr); } catch {}
          log(level, msg);
        }, "viii");
      }
      mod.setValue(dataPtr, state._logCbPtr, "i32");
      return true;
    }

    case E.SET_VARIABLES: {
      // retro_variable[]; { key*, value* } pairs, terminated by null key.
      let ptr = dataPtr;
      while (true) {
        const keyPtr = mod.getValue(ptr, "i32");
        const descPtr = mod.getValue(ptr + 4, "i32");
        if (keyPtr === 0) break;
        const key = mod.UTF8ToString(keyPtr);
        const desc = descPtr ? mod.UTF8ToString(descPtr) : "";
        const semi = desc.indexOf("; ");
        if (semi >= 0) {
          const options = desc.substring(semi + 2).split("|");
          // PRESERVE a value the host already pre-seeded (e.g. via
          // PLATFORM_CORE_OPTIONS, set before retro_load_game). The core
          // registering its variables must NOT clobber that override back to
          // its own default (options[0]) — that silently reset forced options
          // like bluemsx's machine type / cart mapper. Keep the prior value if
          // it's still a valid option; otherwise fall back to the default.
          const prior = state.coreVariables.get(key);
          const keep = prior && options.includes(prior.value) ? prior.value : options[0];
          state.coreVariables.set(key, {
            description: desc.substring(0, semi),
            options,
            value: keep,
          });
        }
        ptr += 8;
      }
      return true;
    }

    case E.SET_CORE_OPTIONS:
    case E.SET_CORE_OPTIONS_INTL:
    case E.SET_CORE_OPTIONS_V2:
    case E.SET_CORE_OPTIONS_V2_INTL:
      // We accept but don't parse v1/v2 core options yet; defaults are used.
      return true;

    case E.GET_VARIABLE: {
      const keyPtr = mod.getValue(dataPtr, "i32");
      if (keyPtr === 0) return false;
      const key = mod.UTF8ToString(keyPtr);
      const v = state.coreVariables.get(key);
      if (!v) {
        mod.setValue(dataPtr + 4, 0, "i32");
        return false;
      }
      const valPtr = allocString(mod, state, v.value);
      mod.setValue(dataPtr + 4, valPtr, "i32");
      return true;
    }

    case E.GET_VARIABLE_UPDATE: {
      mod.setValue(dataPtr, state.variablesUpdated ? 1 : 0, "i8");
      state.variablesUpdated = false;
      return true;
    }

    case E.GET_CORE_OPTIONS_VERSION:
      mod.setValue(dataPtr, 0, "i32");
      return true;

    case E.GET_LANGUAGE:
      mod.setValue(dataPtr, 0, "i32"); // English
      return true;

    case E.GET_USERNAME: {
      mod.setValue(dataPtr, allocString(mod, state, "player"), "i32");
      return true;
    }

    case E.GET_INPUT_DEVICE_CAPABILITIES:
      mod.setValue(dataPtr, 1 << RETRO_DEVICE_JOYPAD, "i32");
      return true;

    case E.GET_INPUT_BITMASKS:
      return true;

    case E.GET_AUDIO_VIDEO_ENABLE:
      mod.setValue(dataPtr, 7, "i32"); // audio + video + fast savestates
      return true;

    case E.GET_FASTFORWARDING:
      mod.setValue(dataPtr, 0, "i8");
      return true;

    case E.GET_TARGET_REFRESH_RATE:
      mod.setValue(dataPtr, 60.0, "double");
      return true;

    case E.GET_INPUT_MAX_USERS:
      mod.setValue(dataPtr, 2, "i32");
      return true;

    case E.GET_MESSAGE_INTERFACE_VERSION:
      mod.setValue(dataPtr, 0, "i32");
      return true;

    case E.GET_DISK_CONTROL_INTERFACE_VERSION:
      mod.setValue(dataPtr, 0, "i32");
      return true;

    case E.SHUTDOWN:
      return true;

    // Accept-and-ignore set: core declares info we don't use right now.
    case E.SET_INPUT_DESCRIPTORS:
    case E.SET_CONTROLLER_INFO:
    case E.SET_SUBSYSTEM_INFO:
    case E.SET_MEMORY_MAPS:
    case E.SET_PERFORMANCE_LEVEL:
    case E.SET_GEOMETRY:
    case E.SET_KEYBOARD_CALLBACK:
    case E.SET_FRAME_TIME_CALLBACK:
    case E.SET_AUDIO_CALLBACK:
    case E.SET_AUDIO_BUFFER_STATUS_CALLBACK:
    case E.SET_MINIMUM_AUDIO_LATENCY:
    case E.SET_DISK_CONTROL_INTERFACE:
    case E.SET_DISK_CONTROL_EXT_INTERFACE:
    case E.SET_SUPPORT_ACHIEVEMENTS:
    case E.SET_HW_RENDER_CONTEXT_NEGOTIATION_INTERFACE:
    case E.SET_SERIALIZATION_QUIRKS:
    case E.SET_CORE_OPTIONS_DISPLAY:
    case E.SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
    case E.SET_FASTFORWARDING_OVERRIDE:
    case E.SET_CONTENT_INFO_OVERRIDE:
    case E.SET_VARIABLE:
    case E.SET_SYSTEM_AV_INFO:
    case E.SET_PROC_ADDRESS_CALLBACK:
      return true;

    // HW render (n64/ps1): if the host set up a GL handler (state.hwRender), let it
    // claim the SET_HW_RENDER request + install its callbacks. Without it (the 14
    // software cores, or no GL stack), reject so the core falls back to software.
    case E.SET_HW_RENDER:
      if (state.hwRender) return state.hwRender.setup(mod, dataPtr);
      // Proxied cores own GL on the app thread (set up before retro_load_game); accept so the
      // core uses its GL path. context_reset runs on the app thread during the proxied load.
      if (state.proxied) return true;
      return false;

    // Things we can't or don't want to support — reject so core falls back.
    case E.GET_RUMBLE_INTERFACE:
    case E.GET_SENSOR_INTERFACE:
    case E.GET_CAMERA_INTERFACE:
    case E.GET_PERF_INTERFACE:
    case E.GET_LOCATION_INTERFACE:
    case E.GET_VFS_INTERFACE:
    case E.GET_LED_INTERFACE:
    case E.GET_MIDI_INTERFACE:
    case E.GET_HW_RENDER_INTERFACE:
    case E.GET_PREFERRED_HW_RENDER:
    case E.GET_CURRENT_SOFTWARE_FRAMEBUFFER:
    case E.GET_GAME_INFO_EXT:
      return false;

    default:
      if (log) log(0, `unhandled retro_environment cmd ${cmd}`);
      return false;
  }
}
