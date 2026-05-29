// Toolchain registry. See PLAN.md § Toolchain bundling.
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
    platforms: ["nes", "c64", "atari7800", "lynx"],
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
    platforms: ["sms", "gg"],
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
  vasm68k: {
    id: "vasm68k",
    displayName: "vasm (68k assembler)",
    platforms: ["genesis"],
    tier: 1,
    source: "bundled:vasm68k",
  },
  vasmarm: {
    id: "vasmarm",
    displayName: "vasm (ARM assembler)",
    platforms: ["gba"],
    tier: 1,
    source: "bundled:vasmarm",
  },
};
