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
  "decomp",             // decomp({op}) — matching decompilation on a splat project's own compiler
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
    decomp: false,
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
      "nes_chr", "nes_apu_regs", "nes_cpu_regs", "nes_ppu_regs",
      "nes_cart_ram", "nes_ppu_scroll", "nes_ppu_scroll_lines", "nes_chr_lines", "nes_bgfetch", "nes_sprlines", "nes_ntmap", "nes_pallines", "nes_masklines", "nes_ntmaplines", "nes_bgpix", "nes_backdrop", "nes_sprdrawn", "nes_bgval", "nes_maskpix", "nes_linepix", "nes_linedeemp", "nes_palrgb"],
    ...tileDeep(),
  },
  snes: {
    cpuFamily: "65816", decompileQuality: "medium",
    cpus: { main: "65816", secondary: ["spc700"] },
    audioChips: ["dsp"],
    memoryRegions: [...GENERIC_REGIONS, "snes_oam", "snes_cgram", "snes_aram", "snes_fillram",
      "snes_linepix", "snes_linestate", "snes_frameinfo", "snes_m7lines", "snes_linedepth", "snes_cliplines",
      "snes_lp_world", "snes_lp_obj"],
    ...tileDeep(),
  },
  genesis: {
    cpuFamily: "m68k", decompileQuality: "excellent",
    cpus: { main: "m68k", secondary: [] }, // z80 not yet decoded
    audioChips: ["ym2612", "psg"],
    memoryRegions: [...GENERIC_REGIONS, "genesis_cram", "genesis_vsram", "genesis_vdp_regs",
      "genesis_z80_ram", "genesis_m68k", "genesis_ym2612", "genesis_psg",
      "md_linepix", "md_bgpix", "md_objpix", "md_pixrgb", "md_linestate", "md_pixlines"],
    ...tileDeep(),
  },
  sms: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "z80", secondary: [] },
    audioChips: ["psg"],
    memoryRegions: [...GENERIC_REGIONS, "sms_vram", "sms_cram", "sms_vdp_regs", "sms_z80_regs",
      "sms_linepix", "sms_bgpix", "sms_objpix", "sms_pixrgb", "sms_linestate", "sms_pixlines"],
    ...tileDeep(),
  },
  gg: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "z80", secondary: [] },
    audioChips: ["psg"],
    memoryRegions: [...GENERIC_REGIONS, "gg_vram", "gg_cram",
      "gg_linepix", "gg_bgpix", "gg_objpix", "gg_pixrgb", "gg_linestate", "gg_pixlines"],
    ...tileDeep(),
  },
  gb: {
    cpuFamily: "sm83", decompileQuality: "good",
    cpus: { main: "sm83", secondary: [] },
    audioChips: ["gb"],
    memoryRegions: [...GENERIC_REGIONS, "gb_vram", "gb_oam", "gb_io", "gb_hram",
      "gb_bgpdata", "gb_objpdata", "gb_cpu_regs",
      /* universal redraw capture planes */
      "gb_lineregs", "gb_bgpix", "gb_sprpix", "gb_palline",
      "gb_bgcol15", "gb_sprcol15"],
    ...tileDeep(),
  },
  gbc: {
    cpuFamily: "sm83", decompileQuality: "good",
    cpus: { main: "sm83", secondary: [] },
    audioChips: ["gb"],
    memoryRegions: [...GENERIC_REGIONS, "gb_vram", "gb_oam", "gb_io", "gb_hram",
      "gb_bgpdata", "gb_objpdata", "gb_cpu_regs",
      /* universal redraw capture planes */
      "gb_lineregs", "gb_bgpix", "gb_sprpix", "gb_palline",
      "gb_bgcol15", "gb_sprcol15"],
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
      decomp: false,
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
      decomp: false,
    },
  },
  gametank: {
    // Clyde Shaffer's open W65C02S console: a 128x128 framebuffer drawn by a
    // hardware blitter (no tilemap / no fixed OAM), + a second 65C02 audio
    // coprocessor. Closest cousin is the Lynx (also 65C02 + blitter). The core
    // is patched with the romdev_* debug hooks (6502 regsnap + MemoryWrite/Read
    // watchpoints + the mos6502 dispatch freeze) — so cpuState + write/read
    // watchpoints + pc-break + watchdog + coverage are LIVE, alongside build/run/
    // screenshot/disasm/decompile. inspectSprites is N/A (the blitter has no OAM,
    // like Dreamcast); inspectBackground N/A (framebuffer, not a tilemap).
    cpuFamily: "6502", decompileQuality: "rough",
    cpus: { main: "6502", secondary: ["acp-65c02"] }, // ACP = the audio coprocessor (2nd 65C02)
    // audioDebug(chip:'acp') reports the ACP's STATE (DAC output, IRQ/sample rate,
    // run/mute, audio-CPU PC) via the core's romdev_acp_get export — it's a second
    // 65C02 driving a DAC, not a fixed-register synth.
    audioChips: ["acp"],
    memoryRegions: [...GENERIC_REGIONS],
    renderingKind: "framebuffer", introspection: "shallow",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: true, audioDebug: true,
      cart: true, disasm: true, decompile: true,
      decomp: false,
    },
  },
  pico8: {
    // FAKE-08 (MIT) runs PICO-8 carts. PICO-8 is a Lua VM, not a real CPU — so there's
    // no machine code to disassemble/decompile and no CPU register file (cpuState N/A).
    // But: build=PACKAGE a .p8 cart (Lua + gfx/sfx/map sections); run/screenshot work;
    // memory works — the romdev patch exposes the full 64KB PICO-8 address space as
    // system_ram (sprite sheet, map, flags, music, sfx, general RAM, screen buffer).
    // disasm here is target:'source' — the cart IS Lua source, so we return the Lua
    // itself (the honest "understand this cart" path), not a machine-code listing.
    // It renders to a 128×128 framebuffer (poke to screen memory), so the inspect-*
    // tile/sprite-table tools are N/A like gametank/the disc platforms.
    // tier:"fantasy" — a fantasy console (Lua VM), not a CPU emulator. Held to its OWN
    // conformance, NOT the canonical-14 cross-checks (which assume CPU disasm/decompile/
    // cpuState/tile inspectors every real console has). Excluded from CONTRACT_PLATFORMS
    // via NEXTGEN_TIER_PLATFORMS.
    tier: "fantasy",
    cpuFamily: "lua", decompileQuality: "n/a",
    cpus: { main: "", secondary: [] }, // Lua VM — no CPU register file
    audioChips: [], // audioDebug not wired (PICO-8's synth isn't a fixed-register chip we decode)
    memoryRegions: [...GENERIC_REGIONS],
    renderingKind: "framebuffer", introspection: "shallow",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: false, audioDebug: false,
      cart: false, disasm: true, decompile: false,
      decomp: false,
    },
  },
  sync32: {
    // monteslu's RP2350 console (Cortex-M33 games as .s32 ROMs), emulated by
    // s32core — a first-party pure-C interpreter (11-cart byte-exact
    // differential suite against the Unicorn reference emulator lives in the
    // s32core repo). tier:"arm" — new 32-bit tier, analysis/inspectors land
    // later; today: run + screenshot (+ input/frames/playtest via the host).
    // Carts build IN romdev now (0.131.0): the WASM arm-none-eabi toolchain
    // that ships for GBA also targets Cortex-M33, and the SDK's
    // crt0/linker-scripts/headers ship in romdev-platform-sync32, so
    // build({platform:'sync32'}) produces a .s32 with no native gcc and no
    // Python. Verified byte-identical to the SDK's own native build.
    tier: "arm",
    cpuFamily: "arm", decompileQuality: "n/a",
    cpus: { main: "cortex-m33", secondary: [] },
    audioChips: [],
    // system_ram IS the console's 520KB SRAM at 0x20000000 — a game's globals,
    // its stack, and in ram mode its code. The sync32_* regions are the
    // debugger views the core exposes on top.
    memoryRegions: ["system_ram", "sync32_cpu_regs", "sync32_palette", "sync32_canvas", "sync32_sheet0"],
    renderingKind: "framebuffer", introspection: "shallow",
    // The framebuffer region the flat-renderer naReasons point at (the shared
    // text used to name `video_ram`, which this platform does not have).
    framebufferRegion: "sync32_canvas",
    // No cart(): a .s32 is an ELF-derived image with a 64-byte header, not a
    // mapper-banked ROM — nothing to identify or patch as a "cart".
    cartNa: "sync32 carts are ELF-derived .s32 images with a 64-byte header (title/id/api/video/mode), not a mapper-banked ROM — there is no board or mapper for cart() to identify or patch. build({platform:'sync32'}) reports the header fields it wrote.",
    // The single most decision-relevant number on the platform, and it lived
    // only in a linker script on disk: how many bytes an IMAGE may occupy.
    // ram mode: text+rodata+data+bss all live in the 320KB game region minus
    // the 16KB stack. xip mode: code+rodata execute from a 12MB flash slot and
    // only data+bss count against the same RAM region (stack reservation is
    // S32_STACK, default 16KB, raisable with linkOptions
    // ['--defsym=S32_STACK=0x8000'] at the cost of your own RAM).
    imageBudget: {
      ram: { base: 0x20030000, imageBytes: 0x50000 - 0x4000, counts: "text+rodata+data+bss", stackBytes: 0x4000,
             note: "everything in one 311296-byte region; the top 16KB is the stack" },
      xip: { base: 0x10100000, imageBytes: 12 * 1024 * 1024, counts: "text+rodata (execute in place from flash)",
             ramBase: 0x20030000, ramBytes: 0x50000 - 0x4000, ramCounts: "data+bss", stackBytes: 0x4000,
             note: "code and rodata run from the flash slot; data+bss take the 311296-byte RAM region (stack default 16KB, S32_STACK)" },
    },
    ops: {
      build: true, run: true, screenshot: true,
      // inspectSprites stays FALSE, and that is not a gap: it means OAM
      // slots, and sync32 has no OAM. A game blits from loaded SHEETS with
      // api->sprite(), so the sheets are what there is to look at — read them
      // as the sync32_sheet* regions (8-bit indices into the palette below).
      //
      // inspectBackground/renderingContext are false for the same reason:
      // there is no tilemap and no PPU. A game composes straight into a flat
      // 8-bit canvas, which frame({op:'screenshot'}) already shows.
      //
      // decompile stays false deliberately: this console has no commercial
      // ROMs to reverse-engineer, so the RE engine has no subject here.
      inspectSprites: false, inspectPalette: true, inspectBackground: false,
      renderingContext: false, cpuState: true, audioDebug: false,
      cart: false, disasm: false, decompile: false,
      decomp: false,
    },
  },
  pce: {
    cpuFamily: "huc6280", decompileQuality: "medium",
    cpus: { main: "", secondary: [] }, // getCPUState main NOT wired for pce
    audioChips: ["pce"],
    memoryRegions: [...GENERIC_REGIONS, "pce_vdc_vram", "pce_vdc_satb", "pce_vdc_regs",
      "pce_vce_palette", "pce_cpu_regs", "pce_psg_regs", "pce_vdc_reglines",
      "pce_vce_pallines", "pce_vdc_linepix", "pce_vce_xofflines",
      "pce_vce_srclines", "pce_paldeltas"],
    renderingKind: "tile", introspection: "deep",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: false, audioDebug: true,
      cart: false, disasm: true, decompile: true,
      decomp: false,
    },
  },
  msx: {
    cpuFamily: "z80", decompileQuality: "good",
    cpus: { main: "", secondary: [] }, // getCPUState main NOT wired for msx
    audioChips: ["ay8910"],
    memoryRegions: [...GENERIC_REGIONS, "msx_vram", "msx_vdp_regs", "msx_vdp_status", "msx_vdp_reglines", "msx_vram_deltas", "msx_fb_tail",
      "msx_palette", "msx_cpu_regs", "msx_psg_regs"],
    renderingKind: "tile", introspection: "deep",
    ops: {
      build: true, run: true, screenshot: true,
      inspectSprites: true, inspectPalette: true, inspectBackground: false,
      renderingContext: true, cpuState: false, audioDebug: true,
      cart: false, disasm: true, decompile: true,
      decomp: false,
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
    renderingKind: "3d", introspection: "shallow",
    ops: {
      // beetle_psx_hw: the GPU renders on the REAL GPU via the GLES3/WebGL2 hardware
      // renderer through native-gles (like glide64-N64 + Flycast-DC), with OpenBIOS
      // EMBEDDED (PCSX-Redux, MIT, region-free) — no Sony firmware to ship, no BIOS file.
      // run/screenshot + cheats + cpuState + audioDebug live; disasm + decompile work
      // (MIPS Capstone + the MIPS:LE:32 SLEIGH spec). cpuState (R3000A GPR_full/BACKED_PC)
      // + audioDebug (SPU $1F801C00 register block) come from beetle-side
      // romdev_mips_regs_get/romdev_spu_get exports patched into cpu.c (see
      // scripts/patches/romdev-snippets/beetle-psx-regsnap.c). build needs a PS1
      // toolchain (PSn00bSDK, not yet).
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
      decomp: false,
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
      decomp: true,
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
      // toolchain. cpuState (SH-4 Sh4cntx regs) + audioDebug (AICA 64-channel register
      // window) come from romdev_sh4_regs_get/romdev_aica_get patched into the flycast
      // libretro entry (see scripts/patches/romdev-snippets/flycast-debug.c). The 3D
      // renderer has no tile/sprite inspectors (N/A by hw). disasm/decompile = SH-4
      // analysis slice (rizin `sh` + Ghidra SuperH4 SLEIGH).
      build: true, run: true, screenshot: true,
      inspectSprites: false, inspectPalette: false, inspectBackground: false,
      renderingContext: false, cpuState: true, audioDebug: true,
      cart: false, disasm: true, decompile: true,
      decomp: false,
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
  .filter(([, c]) => c.tier === "mips" || c.tier === "sh" || c.tier === "fantasy" || c.tier === "arm")
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
  if (op === "decomp") return platform === "ps1" ? "the decomp tool's MIPS path is parameterized for splat psx projects (little-endian, GCC, PS-EXE), but no PS1 checkout has been run through it yet: import works and marks the project platformVerified:false; the capability is declared only once a known-matching PS1 function compares exact" : "matching decompilation needs a splat-layout project with its original compiler registered (decomp({op:'import'})); proven for n64 (IDO 5.3) — other platforms have no compile-and-compare adapter";
  if (op === "cart") {
    // The boilerplate said "disc-based" for every framebuffer platform —
    // true of PlayStation, false of sync32 (a cartridge console whose carts
    // simply have no mapper). A platform states its own reason when it has one.
    if (cap.cartNa) return cap.cartNa;
    return cap.renderingKind === "framebuffer"
      ? "this platform is disc-based (no cartridge ROM to inspect/patch as a cart)."
      : null;
  }
  if (NA_OPS.has(op)) {
    const text = RENDERING_NA[cap.renderingKind] ?? null;
    // Name the framebuffer region THIS platform actually exposes; the shared
    // text's `video_ram` is not in every framebuffer platform's region list.
    if (text && cap.renderingKind === "framebuffer") {
      const region = cap.framebufferRegion
        ?? (cap.memoryRegions ?? []).find((r) => /canvas|video_ram|framebuffer|vram/.test(r))
        ?? "video_ram";
      return text.replace("memory({region:'video_ram'})", `memory({region:'${region}'})`);
    }
    return text;
  }
  return null;
}
