// WAT backend registry: statically recompile a whole commercial ROM into a
// wasmcart. One backend directory per source CPU family; each exports
// `platforms`, `describe(rom, opts)` and `async function* emitWat(rom, opts)`.
// See build.js for the emit -> assemble -> pack pipeline.
//
// Plain JS ESM + JSDoc.

/** backend dir -> platform ids it accepts. Lazy so an unused backend costs nothing. */
const BACKENDS = {
  sms: () => import("./sms/index.js"),
  nes: () => import("./nes/index.js"),
  gb: () => import("./gb/index.js"),
  genesis: () => import("./genesis/index.js"),
  snes: () => import("./snes/index.js"),
  gba: () => import("./gba/index.js"),
};

/** platform id -> backend dir. */
export const PLATFORM_BACKEND = {
  sms: "sms", gg: "sms",
  nes: "nes",
  gb: "gb", gbc: "gb",
  genesis: "genesis", md: "genesis", megadrive: "genesis",
  snes: "snes",
  gba: "gba",
};

/**
 * Resolve the backend module for a platform.
 * @param {string} platform
 */
export async function backendFor(platform) {
  const dir = PLATFORM_BACKEND[platform];
  if (!dir) {
    throw new Error(`recompile emit:'wasmcart' has no WAT backend for platform '${platform}'. Supported: ${Object.keys(PLATFORM_BACKEND).join(", ")}`);
  }
  return BACKENDS[dir]();
}
