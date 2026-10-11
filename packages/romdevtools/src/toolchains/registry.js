// Toolchain registry - the platform → toolchain bundling map.
//
// All v1 toolchains are bundled WASM, no install. The `source` field is a
// reference for our build scripts; runtime resolution happens in the loader.

/**
 * @typedef {1 | 2} ToolchainTier
 * @typedef {Object} ToolchainInfo
 * @property {string} id
 * @property {string} displayName
 * @property {string[]} platforms
 * @property {ToolchainTier} tier
 * @property {string} source
 */

/** @type {Record<string, ToolchainInfo>} */
export const TOOLCHAINS = {
  cc65: {
    id: "cc65",
    displayName: "cc65 (6502 C compiler)",
    platforms: ["nes", "c64", "atari7800", "lynx", "pce"],
    tier: 1,
    source: "bundled:cc65",
  },
  rgbds: {
    id: "rgbds",
    displayName: "RGBDS (Game Boy assembler)",
    platforms: ["gb", "gbc"],
    tier: 1,
    source: "bundled:rgbds",
  },
  dasm: {
    id: "dasm",
    displayName: "dasm (6507 assembler)",
    platforms: ["atari2600"],
    tier: 1,
    source: "bundled:dasm",
  },
  sdcc: {
    id: "sdcc",
    displayName: "sdcc (Z80 family C compiler, 4.5.0)",
    platforms: ["sms", "gg", "msx"],
    tier: 1,
    source: "bundled:sdcc",
  },
  asar: {
    id: "asar",
    displayName: "asar (65816 assembler)",
    platforms: ["snes"],
    tier: 1,
    source: "bundled:asar",
  },
  "m68k-elf-as": {
    id: "m68k-elf-as",
    displayName: "GNU as (68k assembler, Motorola syntax)",
    platforms: ["genesis"],
    tier: 1,
    source: "bundled:romdev-toolchain-m68k-gcc",
  },
  "arm-none-eabi-gcc": {
    id: "arm-none-eabi-gcc",
    displayName: "arm-none-eabi gcc (GBA C compiler)",
    platforms: ["gba"],
    tier: 1,
    source: "bundled:romdev-platform-gba",
  },
};
