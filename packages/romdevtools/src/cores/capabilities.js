// capabilities.js — the platform CAPABILITY CONTRACT.
//
// One declarative entry per platform stating, in machine-readable form, what
// romdev's platform-sensitive tools can do on it. This is the SOURCE OF TRUTH
// the BUILDING.md `deep`/`shallow` legend used to encode as prose — now data,
// enforced by test/capability-conformance.test.js (declared MUST exactly match
// actual tool behavior; mismatch fails CI).
//
// Why it exists: the 14 tier-1 platforms are near-uniform, but the next-gen tier
// (N64/PS1/Dreamcast/PSP/DS) breaks that — 3D rendering, MIPS/SH-4 CPUs, GPU-FBO
// screenshots, ops that are meaningless on a polygon renderer. A declared
// contract + a uniform "unsupported" signal lets agents discover what a system
// can do BEFORE calling, and keeps the matrix honest as platforms diverge.
//
// Fields (keep MINIMAL — only what the contract / discovery / conformance use):
//   cpuFamily       primary CPU family (forward-looking; "6502","z80","sm83",
//                   "m68k","arm","65816","huc6280" today; "mips","sh4" later)
//   renderingKind   "tile" | "framebuffer" | "3d" | "none" — how the screen is
//                   produced. The current 14 are all "tile". Drives whether
//                   tile/nametable inspection ops even make sense.
//   introspection   "deep" | "shallow" — the BUILDING.md legend, as data.
//   ops.*           boolean per platform-sensitive op (see OP_KEYS below).
//   decompileQuality "excellent"|"good"|"medium"|"rough" (from the RE engine).
//   cpus            { main, secondary[] } — what getCPUState({op:'read'}) decodes.
//   audioChips      chip ids audioDebug({op:'inspect'}) decodes ([] = no chip).
//   memoryRegions   exact region ids memory({op}) accepts beyond the generic set.

/** The platform-sensitive op keys the contract tracks. Universal tools (build's
 * file plumbing, encodeAudio, catalog, files, ...) are NOT here — they don't
 * vary by platform. */
export const OP_KEYS = /** @type {const} */ ([
  "build",              // buildSource for this platform
  "run",                // loadMedia + a real core
  "screenshot",         // frame({op:'screenshot'})
  "inspectSprites",     // sprites({op:'inspect'})
  "inspectPalette",     // palette({source:'live'})
  "inspectBackground",  // background({view:'renderState'/'map'})
  "renderingContext",   // background({view:'renderState'}) decode
  "cpuState",           // cpu({op:'read'}) main CPU
  "audioDebug",         // audioDebug({op:'inspect'})
  "cart",               // cart({op:'extract'/'wrap'})
  "disasm",             // disasm({target:'rom'/'project'/'references'})
  "decompile",          // disasm({target:'decompile'}) — RE engine, all 14
]);

// Generic regions every running core exposes (libretro RETRO_MEMORY_*).
const GENERIC_REGIONS = ["system_ram", "save_ram", "video_ram", "rtc"];

/** @typedef {{ cpuFamily:string, renderingKind:"tile"|"framebuffer"|"3d"|"none",
 *   introspection:"deep"|"shallow", ops:Record<string,boolean>,
 *   decompileQuality:string, cpus:{main:string, secondary:string[]},
 *   audioChips:string[], memoryRegions:string[] }} Capability */

const tileDeep = ({ ops: opsOverride = {}, ...rest } = {}) => ({
  renderingKind: "tile", introspection: "deep",
  ...rest,
  ops: {
    build: true, run: true, screenshot: true,
    inspectSprites: true, inspectPalette: true, inspectBackground: true,
    renderingContext: true, cpuState: true, audioDebug: true,
    cart: true, disasm: true, decompile: true,
    ...opsOverride,
  },
});

/** @type {Record<string, Capability>} */
export const CAPABILITIES = {
  nes: {
    cpuFamily: "6502", decompileQuality: "rough",
    cpus: { main: "6502", secondary: [] },
    audioChips: ["nes"],
    memoryRegions: [...GENERIC_REGIONS, "nes_nametables", "nes_palette", "nes_oam",
      "nes_chr", "nes_apu_regs", "nes_cpu_regs", "nes_ppu_regs"],
    ...tileDeep(),
  },
  snes: {
    cpuFamily: "65816", decompileQuality: "medium",
    cpus: { main: "65816", secondary: ["spc700"] },
    audioChips: ["dsp"],
    memoryRegions: [...GENERIC_REGIONS, "snes_oam", "snes_cgram", "snes_aram", "snes_fillram"],
    ...tileDeep(),
  },
  genesis: {
    cpuFamily: "m68k", decompileQuality: "excellent",
    cpus: { main: "m68k", secondary: [] }, // z80 not yet decoded
    audioChips: ["ym2612", "psg"],
    memoryRegions: [...GENERIC_REGIONS, "genesis_cram", "genesis_vsram", "genesis_vdp_regs",
      "genesis_z80_ram", "genesis_m68k", "genesis_ym2612", "genesis_psg"],
    ...tileDeep(),
  },
  sms: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "z80", secondary: [] },
    audioChips: ["psg"],
    memoryRegions: [...GENERIC_REGIONS, "sms_vram", "sms_cram", "sms_vdp_regs", "sms_z80_regs"],
    ...tileDeep(),
  },
  gg: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "z80", secondary: [] },
    audioChips: ["psg"],
    memoryRegions: [...GENERIC_REGIONS, "gg_vram", "gg_cram"],
    ...tileDeep(),
  },
  gb: {
    cpuFamily: "sm83", decompileQuality: "good",
    cpus: { main: "sm83", secondary: [] },
    audioChips: ["gb"],
    memoryRegions: [...GENERIC_REGIONS, "gb_vram", "gb_oam", "gb_io", "gb_hram",
      "gb_bgpdata", "gb_objpdata", "gb_cpu_regs"],
    ...tileDeep(),
  },
  gbc: {
    cpuFamily: "sm83", decompileQuality: "good",
    cpus: { main: "sm83", secondary: [] },
    audioChips: ["gb"],
    memoryRegions: [...GENERIC_REGIONS, "gb_vram", "gb_oam", "gb_io", "gb_hram",
      "gb_bgpdata", "gb_objpdata", "gb_cpu_regs"],
    ...tileDeep(),
  },
  gba: {
    cpuFamily: "arm", decompileQuality: "excellent",
    cpus: { main: "arm", secondary: [] },
    audioChips: ["gba"],
    memoryRegions: [...GENERIC_REGIONS, "gba_cpu_regs", "gba_io_regs", "gba_palette", "gba_oam"],
    // GBA: the patched mgba regions give MORE than BUILDING.md's old "shallow"
    // prose implied — inspectSprites/Palette + renderingContext + cpuState +
    // audioDebug are all wired (per the tool Supported lists). cart extract/wrap
    // and inspectBackgroundMap are NOT.
    renderingKind: "tile", introspection: "shallow",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },
  atari2600: {
    cpuFamily: "6502", decompileQuality: "rough",
    cpus: { main: "6502", secondary: [] },
    audioChips: [], // TIA tone, no dedicated sound chip audioDebug decodes
    memoryRegions: [...GENERIC_REGIONS, "a26_tia_regs", "a26_cpu_regs"],
    ...tileDeep({ ops: { audioDebug: false, inspectSprites: true, inspectBackground: false } }),
  },
  atari7800: {
    cpuFamily: "6502", decompileQuality: "rough",
    cpus: { main: "6502", secondary: [] },
    audioChips: [], // TIA; no audioDebug decode
    memoryRegions: [...GENERIC_REGIONS, "a78_cpu_regs"],
    ...tileDeep({ ops: { audioDebug: false, inspectBackground: false } }),
  },
  c64: {
    cpuFamily: "6502", decompileQuality: "rough",
    cpus: { main: "6502", secondary: [] },
    audioChips: ["sid"],
    memoryRegions: [...GENERIC_REGIONS, "c64_color_ram", "c64_vic_regs", "c64_sid_regs",
      "c64_cia1_regs", "c64_cia2_regs", "c64_cpu_regs"],
    // C64 has no inspectBackgroundMap branch (character-mode screen is read via
    // raw VIC regions, not a snapshotter).
    ...tileDeep({ ops: { inspectBackground: false } }),
  },
  lynx: {
    cpuFamily: "65c02", decompileQuality: "rough",
    cpus: { main: "65c02", secondary: [] },
    audioChips: ["mikey"],
    memoryRegions: [...GENERIC_REGIONS, "lynx_cpu_regs", "lynx_hw_regs"],
    // Lynx: sprites return the SCB list head (no fixed OAM) — counts as wired.
    // shallow per BUILDING.md (generic introspection + sfx/music templates).
    renderingKind: "tile", introspection: "shallow",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },
  pce: {
    cpuFamily: "huc6280", decompileQuality: "medium",
    cpus: { main: "", secondary: [] }, // getCPUState main NOT wired for pce
    audioChips: ["pce"],
    memoryRegions: [...GENERIC_REGIONS, "pce_vdc_vram", "pce_vdc_satb", "pce_vdc_regs",
      "pce_vce_palette", "pce_cpu_regs", "pce_psg_regs"],
    renderingKind: "tile", introspection: "deep",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: false, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },
  msx: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "", secondary: [] }, // getCPUState main NOT wired for msx
    audioChips: ["ay8910"],
    memoryRegions: [...GENERIC_REGIONS, "msx_vram", "msx_vdp_regs", "msx_vdp_status",
      "msx_palette", "msx_cpu_regs", "msx_psg_regs"],
    renderingKind: "tile", introspection: "deep",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: false, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },

  // ── 32-bit MIPS tier — ANALYSIS-FIRST (no run-side core yet) ──────────────
  // disasm/decompile are wired through the shipped rizin.wasm MIPS plugin (PS1 =
  // R3000 LE, N64 = R4300 BE). Everything run-side (build/run/screenshot/the
  // tile/sprite inspectors) is FALSE: there is no emulator core in this slice, and
  // the tile/nametable/OAM inspectors are MEANINGLESS on a framebuffer (PS1) / 3D
  // (N64) renderer anyway — so an agent gets the uniform unsupported() signal
  // instead of blindly calling inspectBackground on a polygon machine.
  // disasm/cfg/xrefs/functions WORK (rizin's Capstone MIPS plugin). decompile is
  // FALSE: the rz-ghidra decompiler ships only the 8 SLEIGH specs for the current
  // tier (no MIPS.sla) — adding it is a romdev-analysis-decompiler rebuild, a later
  // step. decompileQuality records the EXPECTED quality once that spec ships.
  ps1: {
    cpuFamily: "mips", decompileQuality: "good", tier: "mips",
    cpus: { main: "r3000", secondary: ["gte"] },
    audioChips: ["spu"],
    memoryRegions: [...GENERIC_REGIONS],
    renderingKind: "framebuffer", introspection: "shallow",
    ops: {
      // pcsx_rearmed: software render + HLE BIOS (no firmware, no GL). run/screenshot
      // + cpuState (R3000 regsnap) + cheats live; disasm + decompile work (MIPS
      // Capstone + the MIPS:LE:32 SLEIGH spec). build needs a PS1 toolchain
      // (PSn00bSDK, not yet). The framebuffer renderer has no tile/sprite inspectors.
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },
  n64: {
    cpuFamily: "mips", decompileQuality: "good", tier: "mips",
    cpus: { main: "r4300", secondary: ["rsp"] },
    audioChips: ["ai"], // AI = the audio OUTPUT interface (RSP-mixed; no per-voice chip)
    memoryRegions: [...GENERIC_REGIONS],
    renderingKind: "3d", introspection: "shallow",
    ops: {
      // parallel_n64: HW (GL) render via the optional native-gles bridge.
      // run/screenshot + cpuState (R4300 regsnap) + cheats + breakpoint/watch +
      // audioDebug(AI) live; disasm + decompile work; build via mips-elf-gcc.
      // The 3D renderer has no tile/sprite inspectors (N/A by hardware).
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
    },
  },

  dreamcast: {
    cpuFamily: "sh", decompileQuality: "good", tier: "sh",
    cpus: { main: "sh4", secondary: ["arm7"] }, // SH-4 main + ARM7 AICA sound CPU
    audioChips: ["aica"],
    memoryRegions: [...GENERIC_REGIONS],
    renderingKind: "3d", introspection: "shallow",
    ops: {
      // Flycast WASM boots + RUNS homebrew .elf (reios HLE): the SH-4 executes guest
      // code (run + memory introspection), and the PowerVR2 present-path works — flycast
      // renders to the GL FBO and the host reads it back (verified: a framebuffer-writing
      // program shows ~727k captured pixels). `build` lands with the sh-elf-gcc WASM
      // toolchain. The 3D renderer has no tile/sprite inspectors (N/A by hw).
      // disasm/decompile = SH-4 analysis slice (rizin `sh` + Ghidra SuperH4 SLEIGH).
      build: false, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: false, audioDebug: false,
      cart: false, disasm: true, decompile: true,
    },
  },
};

/** The 32-bit MIPS tier (PS1/N64) — marked `tier:"mips"`. A PARTIAL tier: they
 *  run + screenshot + disasm, but don't yet have the full op surface of the canonical
 *  14 (no build toolchain, no MIPS decompile/cpuState, framebuffer/3D renderers have
 *  no tile/sprite inspectors). They're held to their OWN conformance, not the
 *  "all 14" cross-checks. They graduate to CONTRACT_PLATFORMS as the gaps close. */
export const MIPS_TIER_PLATFORMS = Object.entries(CAPABILITIES)
  .filter(([, c]) => c.tier === "mips")
  .map(([p]) => p);

/** The next-gen tiers (32-bit CPU families added after the canonical 14): MIPS
 *  (PS1/N64) + SH (Dreamcast) + future. Any platform carrying a CPU-family `tier`
 *  is held to its OWN conformance, not the "all 14" cross-checks; a new platform
 *  starts here (analysis-first) and graduates as run/build/etc. land. */
export const NEXTGEN_TIER_PLATFORMS = Object.entries(CAPABILITIES)
  .filter(([, c]) => c.tier === "mips" || c.tier === "sh")
  .map(([p]) => p);

/** Back-compat: the analysis-only set is now empty (PS1/N64 gained run/screenshot
 *  in the run-side wiring). Kept so the name still resolves for older imports. */
export const ANALYSIS_ONLY_PLATFORMS = [];

/** The canonical tier-1 platforms (the 14): full op surface, universal build/run/
 *  screenshot. Excludes the partial next-gen tiers above. */
export const CONTRACT_PLATFORMS = Object.keys(CAPABILITIES)
  .filter((p) => !NEXTGEN_TIER_PLATFORMS.includes(p));

/** Does `platform` support `op`? Unknown platform/op → false. */
export function supports(platform, op) {
  return Boolean(CAPABILITIES[platform]?.ops?.[op]);
}

/** The full capability entry for a platform (or null). */
export function capabilitiesFor(platform) {
  return CAPABILITIES[platform] ?? null;
}

// Why an op is unsupported, grounded in the HARDWARE — so `unsupported()`'s reason
// distinguishes "N/A by hardware, permanent" from "a decoder we haven't wired."
// Keyed on renderingKind: a framebuffer (PS1) / 3D (N64) renderer has no tile,
// sprite-attribute, nametable, or palette tables for the tile-era inspectors to
// read — those ops are MEANINGLESS on the hardware, not merely absent.
const RENDERING_NA = {
  framebuffer: "this platform renders to a flat framebuffer — there are no tile/sprite-attribute/nametable/palette tables to inspect (the GPU draws pixels/polys directly). Read the raw framebuffer via memory({region:'video_ram'}).",
  "3d": "this platform is a 3D (polygon) renderer — there are no tile/sprite-attribute/nametable/palette tables to inspect (geometry is transformed + rasterized, not composed from tile maps). Inspect the scene via memory({region:'system_ram'}) / cpu state.",
};
const NA_OPS = new Set(["inspectSprites", "inspectPalette", "inspectBackground", "renderingContext"]);

/** A hardware-grounded reason an op is unsupported on a platform, or null if the
 *  op isn't one of the hardware-N/A introspection ops. Drives unsupported().reason
 *  so agents see "N/A by hardware" (don't retry / don't request a decoder) rather
 *  than a generic "no decoder for this platform". */
export function naReason(platform, op) {
  const cap = CAPABILITIES[platform];
  if (!cap || cap.ops?.[op]) return null;            // supported → no N/A reason
  if (op === "cart") {
    return cap.renderingKind === "framebuffer"
      ? "this platform is disc-based (no cartridge ROM to inspect/patch as a cart)."
      : null;
  }
  if (NA_OPS.has(op)) return RENDERING_NA[cap.renderingKind] ?? null;
  return null;
}
