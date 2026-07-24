// romdev-core-runner — play a ROM on any romdev-core-* emulator core in a real
// SDL window. See runRom.js (the human tier) and sdl.js (the hardened SDL
// loader). The presentation/input primitives in present.js are shared with
// romdev's own playtest window — one SDL host implementation in the ecosystem.
export { runRom } from "./runRom.js";
export { initSdl, sdlPackageRoot } from "./sdl.js";
export {
  SDL_BUTTON_TO_LIBRETRO_BIT,
  KEY_TO_LIBRETRO_BIT,
  STICK_DEADZONE,
  bitToName,
  tvAspectFor,
  effectiveAspect,
  initialWindowSize,
  letterbox,
  framebufferToRgba,
} from "./present.js";
