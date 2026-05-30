// createProject — write a starter project directory the agent can iterate on.
//
// Policy (2026-05-25): no auto-injection at build time. createProject copies
// every file the template depends on (runtime, headers, crt0, linker .cfg)
// into the project directory. The project is then self-contained — any
// `buildSource` / `runSource` call points at the project's own files via
// sources/sourcesPaths/includePaths/crt0/linkerConfig args. If you take
// the project elsewhere and rebuild with cc65/sdcc directly, every byte
// that compiles is in the directory.

import { readFile, writeFile } from "node:fs/promises";
import { patchGbHeader } from "../../platforms/gb/lib/c/patch-header.js";
import { jsonContent, safeTool } from "../util.js";

/**
 * Template manifest — each template lists:
 *   - main: path to the seed main.{c,s,asm} under examples/<platform>/
 *   - runtime: array of {src, dst} pairs to copy from src/platforms/<platform>/lib/
 *   - crt0: optional {src, dst} for a custom crt0 (asm)
 *   - linkerConfig: optional {src, dst} for the ld65 .cfg or similar
 *   - buildHint: string telling the agent what build args to use
 */
const TEMPLATES = {
  nes: {
    default: {
      main: "templates/default.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Minimal palette-cycle hello-world. Backdrop color flashes through 4 shades.",
    },
    hello_sprite: {
      main: "templates/hello_sprite.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Single sprite + d-pad movement. Boot order + palette + tile upload all explicit.",
    },
    tile_engine: {
      main: "templates/tile_engine.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "32×30 tile map + room transitions. Walls, doors, collision, multi-screen.",
    },
    /* ── Genre scaffolds (R14, 2026-05-26) ── */
    shmup: {
      main: "templates/shmup.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Vertical-scrolling shooter. Player + 4 bullets + 4 enemies, AABB collision, score counter, wave spawner.",
    },
    platformer: {
      main: "templates/platformer.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Single-screen platformer — also the starting point for a SIDE-SCROLLER (same genre here). Gravity + jump physics (fixed-point Y), 5 platforms, land-on-top collision, respawn on fall. This is the jump/gravity/collision core; it does NOT scroll as shipped. To make it scroll on NES you add a camera + world coords and write new nametable columns across the mirroring boundary as the camera advances (and usually a sprite-0/IRQ split for a fixed HUD) — see the NES MENTAL_MODEL.md scrolling section.",
    },
    puzzle: {
      main: "templates/puzzle.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Match-3 falling-block puzzle. 6×12 grid, 1×3 active piece (3 colors), rotate via A, soft-drop on DOWN, horizontal-triple clear.",
    },
    sports: {
      main: "templates/sports.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Two-player Pong. Port 0 = left paddle, port 1 = right paddle (AI fallback when no 2nd controller). Per-side score 0-9, ball bounces off paddles + walls. Designed for the playtest window with two USB controllers.",
    },
    racing: {
      main: "templates/racing.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Endless top-down lane racer. 3 lanes, 4 obstacle slots, LEFT/RIGHT switches lanes. Speed grows with score; collision triggers a 60-frame freeze then reset.",
    },
    /* R44 (2026-05-26): bundled-driver music demo. FamiTone2 engine +
     * cc65 bridge + example track, all ship as source under lib/asm. */
    music_demo: {
      main: "templates/music_demo.c",
      runtime: [
        { src: "lib/c/nes_runtime.h", dst: "nes_runtime.h" },
        { src: "lib/c/nes_runtime.c", dst: "nes_runtime.c" },
        { src: "lib/asm/famitone2.s", dst: "famitone2.s" },
        { src: "lib/asm/famitone_bridge.s", dst: "famitone_bridge.s" },
        { src: "lib/asm/music_data.s", dst: "music_data.s" },
        { src: "lib/asm/LICENSE-FAMITONE", dst: "LICENSE-FAMITONE" },
      ],
      crt0: { presetSrc: "presets/nes/chr-ram-runtime.crt0.s", dst: "chr-ram-runtime.crt0.s" },
      linkerConfig: { presetSrc: "presets/nes/chr-ram-runtime.cfg", dst: "chr-ram-runtime.cfg" },
      lang: "C (cc65)",
      ext: ".nes",
      describe: "Continuous multi-channel music demo using bundled FamiTone2 (Shiru, public domain). Engine .s + bridge .s + example track .s ship as sources alongside main.c. Swap music_data.s for your own song (text2data converts FamiTracker .txt exports).",
    },
  },
  gb: {
    default: {
      main: "templates/default.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Minimal palette-cycle hello-world.",
    },
    hello_sprite: {
      main: "templates/hello_sprite.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Single sprite + d-pad movement.",
    },
    tile_engine: {
      main: "templates/tile_engine.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "20×18 tile map + room transitions.",
    },
    shmup: {
      main: "templates/shmup.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Vertical-shmup scaffold for GB. Player ship + 4 bullets + 4 enemies, wave spawner, AABB collision, score (in WRAM). OAM slots 0/1-4/5-8 preallocated.",
    },
    platformer: {
      main: "templates/platformer.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "SIDE-SCROLLING platformer for GB. Subpixel gravity + jump + land-on-top collision against a static platform list spread across a 256-px world (the full wrapping BG map). The camera follows the player and scrolls the BG via SCX each frame; the player sprite draws in screen space (worldX - camX). A=jump, d-pad=move. The world here is one BG map wide (no streaming) — for a wider world, stream a new tile column into the 32-wide BG map each time the camera crosses an 8px boundary (window for a fixed HUD). See the GB MENTAL_MODEL.md 'Horizontal scrolling'. Extend with enemies, goals, pickups.",
    },
    puzzle: {
      main: "templates/puzzle.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Match-3 falling-block puzzle scaffold for GB. 6×12 grid rendered via BG tilemap, 1×3 active piece (3 colours via 3 BG tile shapes), rotate via A, hard-drop on START, horizontal-triple clear.",
    },
    sports: {
      main: "templates/sports.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Player-vs-AI Pong. Game Boy hardware has only one controller port, so this is human vs chase-the-ball AI by design. Same gameplay shape as the 2P versions on platforms with two ports.",
    },
    racing: {
      main: "templates/racing.c",
      runtime: [
        { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h", dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c", dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s", dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js", dst: "patch-header.js" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Endless 3-lane top-down racer. LEFT/RIGHT switches lanes, obstacle speed grows with score, 60-frame freeze + auto-reset on collision.",
    },
    /* R45 — hUGEDriver music demo. Ships a compact SDCC-native music
     * driver with the upstream hUGEDriver function surface plus a
     * hand-authored sample song. Source-visible: the full upstream
     * RGBDS asm is bundled alongside as hUGEDriver.upstream.asm. */
    music_demo: {
      main: "templates/music_demo.c",
      runtime: [
        { src: "lib/c/gb_hardware.h",          dst: "gb_hardware.h" },
        { src: "lib/c/gb_runtime.h",           dst: "gb_runtime.h" },
        { src: "lib/c/gb_runtime.c",           dst: "gb_runtime.c" },
        { src: "lib/c/gb_crt0.s",              dst: "gb_crt0.s" },
        { src: "lib/c/patch-header.js",        dst: "patch-header.js" },
        { src: "lib/c/hUGEDriver.h",           dst: "hUGEDriver.h" },
        { src: "lib/c/hUGEDriver.c",           dst: "hUGEDriver.c" },
        { src: "lib/c/song_data.c",            dst: "song_data.c" },
        { src: "lib/c/hUGEDriver.upstream.asm",dst: "hUGEDriver.upstream.asm" },
        { src: "lib/c/LICENSE-HUGEDRIVER",     dst: "LICENSE-HUGEDRIVER" },
      ],
      lang: "C (SDCC sm83)",
      ext: ".gb",
      describe: "Music playback via hUGEDriver. Compact SDCC-native rewrite of the upstream hUGEDriver interface (public domain) + a 4-pattern, two-channel hand-authored sample song. Driver advances on every vblank via hUGE_dosound().",
    },
  },
};
// R37: GBC has its own scaffold tree at examples/gbc/templates/ +
// src/platforms/gbc/lib/c/. Same runtime files as GB (the APU + Z80 +
// most VRAM layout are identical) but the scaffolds add visible
// CGB-mode color via BCPS/BCPD palette writes. Output ext is .gbc so
// patchGbHeader flips $0143 = $80 → CGB-enhanced mode.
const GBC_RUNTIME = [
  { src: "lib/c/gb_hardware.h", dst: "gb_hardware.h" },
  { src: "lib/c/gb_runtime.h",  dst: "gb_runtime.h" },
  { src: "lib/c/gb_runtime.c",  dst: "gb_runtime.c" },
  { src: "lib/c/gb_crt0.s",     dst: "gb_crt0.s" },
  { src: "lib/c/patch-header.js", dst: "patch-header.js" },
];
const GBC_LANG = "C (SDCC sm83, GBC color)";
TEMPLATES.gbc = {
  default: {
    main: "templates/default.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "Minimal GBC starter. Same shape as the GB default but ROM extension .gbc — patchGbHeader sets $0143=$80 so gambatte boots in CGB mode.",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "Single sprite + d-pad on Game Boy Color. Sets a real CGB color palette via BCPS/BCPD (purple backdrop) so you can SEE that CGB mode is active.",
  },
  tile_engine: {
    main: "templates/tile_engine.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "20×18 tile world on GBC. BG palette upload via BCPS/BCPD + sprite palette via OCPS/OCPD.",
  },
  shmup: {
    main: "templates/shmup.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "Vertical-shmup for GBC. Colorful sprites (white ship, yellow bullets, red enemies) and a starfield BG palette via BCPS/BCPD. Same sfx wiring as GB (sound_play_tone/noise).",
  },
  platformer: {
    main: "templates/platformer.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "SIDE-SCROLLING platformer for GBC. Full CGB color palette (BG + sprite via BCPS/OCPS) over the GB side-scroller core: subpixel gravity + jump + land-on-top collision against platforms across a 256-px world (the wrapping BG map). The camera follows the player and scrolls the BG via SCX; the player sprite draws in screen space. A=jump, d-pad=move. One BG map wide (no streaming) — for a wider world, stream a new BG-map column on each 8px camera step (window for a fixed HUD). See the GBC MENTAL_MODEL.md 'Horizontal scrolling'. Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "Match-3 puzzle for GBC. Three colored cells (BG palette via BCPS/BCPD), rotate + soft-drop + hard-drop + triple-clear chime.",
  },
  sports: {
    main: "templates/sports.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "Pong for GBC. Player-vs-AI (one controller). Court green BG + colored paddles + paddle-hit sfx.",
  },
  racing: {
    main: "templates/racing.c", runtime: GBC_RUNTIME,
    lang: GBC_LANG, ext: ".gbc",
    describe: "3-lane racer for GBC. Asphalt BG palette + colored player/enemy cars + lane-switch + crash sfx.",
  },
  /* R45 — same hUGEDriver music_demo as GB, with BCPS/BCPD palette
   * writes so it boots in CGB mode (gambatte flips on .gbc + $0143=$80).
   * The APU is identical between DMG and CGB so the driver code is
   * unchanged — only the visual palette path differs. */
  music_demo: {
    main: "templates/music_demo.c",
    runtime: [
      { src: "lib/c/gb_hardware.h",          dst: "gb_hardware.h" },
      { src: "lib/c/gb_runtime.h",           dst: "gb_runtime.h" },
      { src: "lib/c/gb_runtime.c",           dst: "gb_runtime.c" },
      { src: "lib/c/gb_crt0.s",              dst: "gb_crt0.s" },
      { src: "lib/c/patch-header.js",        dst: "patch-header.js" },
      { src: "lib/c/hUGEDriver.h",           dst: "hUGEDriver.h" },
      { src: "lib/c/hUGEDriver.c",           dst: "hUGEDriver.c" },
      { src: "lib/c/song_data.c",            dst: "song_data.c" },
      { src: "lib/c/hUGEDriver.upstream.asm",dst: "hUGEDriver.upstream.asm" },
      { src: "lib/c/LICENSE-HUGEDRIVER",     dst: "LICENSE-HUGEDRIVER" },
    ],
    lang: GBC_LANG, ext: ".gbc",
    describe: "Music playback on GBC. Compact SDCC-native rewrite of the upstream hUGEDriver interface (public domain) + bundled sample song. Background palette cycles via BCPS/BCPD to confirm CGB mode is active.",
  },
};

// ── SDCC z80 platforms (SMS / GG / MSX / Coleco) ─────────────────────
// They share the same hardware-port idiom (__sfr __at) but differ in
// register addresses / cart layout. SMS has a fleshed-out lib/c/sms_hw.h
// + working main.c we use directly; the other three reuse the same
// example main.c shape and get a minimal __sfr declaration sketch.
// R22: the modular SMS runtime under src/platforms/sms/lib/c/ is what
// hello_sprite + tile_engine + shmup + platformer + puzzle templates link
// against. Factored to a constant so adding a new template is a one-line
// change at the bottom.
const SMS_RUNTIME = [
  { src: "lib/c/sms_hw.h",        dst: "sms_hw.h" },
  { src: "lib/c/vdp_init.c",      dst: "vdp_init.c" },
  { src: "lib/c/load_palette.c",  dst: "load_palette.c" },
  { src: "lib/c/load_tiles.c",    dst: "load_tiles.c" },
  { src: "lib/c/vblank_wait.c",   dst: "vblank_wait.c" },
  { src: "lib/c/joypad_read.c",   dst: "joypad_read.c" },
  { src: "lib/c/sprite_table.c",  dst: "sprite_table.c" },
  // R35: PSG sound wrapper (SN76489 — same chip as Genesis PSG).
  { src: "lib/c/sms_sfx.h",       dst: "sms_sfx.h" },
  { src: "lib/c/sms_sfx.c",       dst: "sms_sfx.c" },
  // R47: 3-voice tracker on top of the PSG (continuous music).
  { src: "lib/c/sms_music.h",     dst: "sms_music.h" },
  { src: "lib/c/sms_music.c",     dst: "sms_music.c" },
];
const SMS_LANG = "C (SDCC z80)";

TEMPLATES.sms = {
  default: {
    // Backward-compat: old `main.c` lives at the top of examples/sms/.
    // New templates use the examples/sms/templates/ tree.
    main: "main.c",
    runtime: [
      { src: "lib/c/sms_hw.h", dst: "sms_hw.h" },
    ],
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Yellow 'H' tile on blue background. Press B1 to scroll BG by 1px/frame. Single-file project, inlines all VDP/joypad helpers.",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "One sprite + d-pad. Uses bundled SMS runtime helpers (sms_vdp_init, sms_load_tiles, sms_sprite_*, sms_vblank_wait, sms_joypad_read). Multi-file project.",
  },
  tile_engine: {
    main: "templates/tile_engine.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "32×24 tile world with walking player + AABB collision against solid tile indices. Demonstrates sms_set_tilemap_cell + the BG-plane name-table at $3800.",
  },
  shmup: {
    main: "templates/shmup.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Vertical-shmup scaffold for SMS. Player ship + 4 bullets + 4 enemies, wave spawner, AABB collisions, score (WRAM). Pre-allocated SAT slots 0/1-4/5-8.",
  },
  platformer: {
    main: "templates/platformer.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "SIDE-SCROLLING platformer for SMS with COLUMN STREAMING. Subpixel gravity + jump + land-on-top collision against platforms across a 512-px world. The SMS name table is only 32 cells (256 px) and wraps, so the world is streamed: the camera follows the player, writes VDP R8 (-camX) for smooth pixel scroll, and each time camX crosses an 8-px boundary it rewrites the name-table column entering from the right (or left, on retreat) with the next world column. Player sprite draws in screen space. 1=jump, d-pad=move. For a fixed HUD, lock the top rows with VDP R0 bit 6. See the SMS MENTAL_MODEL.md 'Horizontal scrolling'. Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Match-3 falling-block scaffold. 6×12 grid rendered via BG tilemap (three distinct tile shapes for R/G/B cells), 1×3 active piece, rotate via B1, hard-drop via B2.",
  },
  sports: {
    main: "templates/sports.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Two-player Pong on SMS. Both controller ports wired — sms_joypad_read for P1, sms_joypad_read_p2 for P2 (reassembles the awkward split-across-$DC/$DD bit layout). AI fallback when no second pad is plugged in.",
  },
  racing: {
    main: "templates/racing.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Endless 3-lane top-down racer. LEFT/RIGHT (edge-detected) switches lanes, obstacles slide down at speed = 2 + score/500 (capped at 4). 60-frame freeze + auto-reset on collision.",
  },
  shmup_2p: {
    main: "templates/shmup_2p.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Two-player competitive shmup on SMS via PORT_JOY_A + PORT_JOY_B (the new sms_joypad_read_p2 helper reassembles P2's split-port bits). Each player owns a 4-bullet pool + score; enemies are shared, first to hit scores.",
  },
  music_demo: {
    main: "templates/music_demo.c",
    runtime: SMS_RUNTIME,
    lang: SMS_LANG,
    ext: ".sms",
    describe: "Continuous 3-voice music demo via sms_music.{h,c} — a tiny tracker on top of the SN76489 PSG. Voice 0 melody, voice 1 harmony, voice 2 bass. Noise channel stays free for game sfx. Source-visible: the parallel per-voice freq/length arrays in sms_music.c ARE the song.",
  },
};
// R36: GG is tier-1 — full runtime + scaffolds + PSG sound, mirrors SMS.
// The genesis_plus_gx core handles GG natively. GG's visible viewport
// is 160×144 (centered in a 256×192 framebuffer); scaffolds render to
// the whole framebuffer but content positioning targets the center.
const GG_RUNTIME = [
  { src: "lib/c/gg_crt0.s",       dst: "gg_crt0.s" },
  { src: "lib/c/gg_hw.h",         dst: "gg_hw.h" },
  { src: "lib/c/vdp_init.c",      dst: "vdp_init.c" },
  { src: "lib/c/load_palette.c",  dst: "load_palette.c" },
  { src: "lib/c/load_tiles.c",    dst: "load_tiles.c" },
  { src: "lib/c/vblank_wait.c",   dst: "vblank_wait.c" },
  { src: "lib/c/joypad_read.c",   dst: "joypad_read.c" },
  { src: "lib/c/sprite_table.c",  dst: "sprite_table.c" },
  { src: "lib/c/gg_sfx.h",        dst: "gg_sfx.h" },
  { src: "lib/c/gg_sfx.c",        dst: "gg_sfx.c" },
  { src: "lib/c/gg_music.h",      dst: "gg_music.h" },
  { src: "lib/c/gg_music.c",      dst: "gg_music.c" },
];
/* For the single-file `default` template — it inlines its own VDP
 * helpers, but it still needs gg_crt0.s for the boot vectors. SDCC's
 * stock z80 crt0 traps rst $08 (used by its host runtime) which would
 * halt any GG cartridge as soon as the VDP fires its first IRQ. */
const GG_DEFAULT_RUNTIME = [
  { src: "lib/c/gg_crt0.s",       dst: "gg_crt0.s" },
];
const GG_LANG = "C (SDCC z80)";

TEMPLATES.gg = {
  default: {
    main: "templates/default.c",
    runtime: GG_DEFAULT_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Minimal GG starter: VDP init + yellow 'H' tile in the center of the 160×144 visible viewport + scroll-on-B1 input loop. Single source file (inlines VDP helpers) + the bundled gg_crt0.s. Use as the read-and-modify starting point when you're not sure what to build; switch to hello_sprite/tile_engine for multi-file projects.",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "One sprite + d-pad. Uses bundled GG runtime helpers (gg_vdp_init, gg_load_tiles, gg_sprite_*, gg_vblank_wait, gg_joypad_read). Multi-file project. Boot chime via the bundled gg_sfx PSG wrapper.",
  },
  tile_engine: {
    main: "templates/tile_engine.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "32×24 tile world with walking player + AABB collision against solid tile indices. BG name-table at $3800.",
  },
  shmup: {
    main: "templates/shmup.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Vertical-shmup scaffold for GG. Player ship + 4 bullets + 4 enemies, wave spawner, AABB collisions, score. Pew sfx on fire, boom on hit (PSG via gg_sfx).",
  },
  platformer: {
    main: "templates/platformer.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "SIDE-SCROLLING platformer for GG with COLUMN STREAMING. Same Mode-4 VDP as the SMS — only the visible window differs (160 px wide). Subpixel gravity + jump + land-on-top collision across a 512-px world; the camera centers on the 160-px window, writes VDP R8 (-camX) for smooth pixel scroll, and streams the next world column into the wrapping 32-cell name table each time camX crosses an 8-px boundary. Player sprite draws in screen space. Jump boing via PSG sfx. 1=jump, d-pad=move. See the SMS/GG MENTAL_MODEL.md 'Horizontal scrolling'. Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Match-3 falling-block scaffold. 6×12 grid, 1×3 piece, rotate via B1, hard-drop via B2. Rotate click + clear chime via PSG.",
  },
  sports: {
    main: "templates/sports.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Single-player Pong vs AI (GG has only one controller). Paddle hit + wall blip + score chime via PSG.",
  },
  racing: {
    main: "templates/racing.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Top-down 3-lane racer scaffold. L/R switches lanes, obstacles slide down + accelerate with score. Lane-switch beep + crash noise via PSG.",
  },
  music_demo: {
    main: "templates/music_demo.c",
    runtime: GG_RUNTIME,
    lang: GG_LANG,
    ext: ".gg",
    describe: "Per-frame PSG music driver (gg_music) playing a hand-authored note table on PSG ch 2, with gg_sfx pew on ch 0. LEFT/RIGHT switches between three bundled songs, UP stops, DOWN restarts, B1 fires sfx. UI centered in the 160×144 visible viewport.",
  },
};

// ── C64: cc65 + SID sound (R39 brings tier-1 parity) ────────────────────
const C64_RUNTIME = [
  { src: "lib/c64_registers.h", dst: "c64_registers.h" },
  { src: "lib/c/c64_sfx.h",     dst: "c64_sfx.h" },
  { src: "lib/c/c64_sfx.c",     dst: "c64_sfx.c" },
];
// R58b: ship cc65 C64 libsrc into project. Joystick driver,
// VIC-II / SID / CIA helpers, conio, header builder — all readable.
const C64_VENDOR_DIRS = [
  { src: "lib/cc65-src", dst: "vendor/cc65/libsrc/c64" },
];
// R49: music_demo gets its own 3-voice SID music driver instead of the
// one-shot sfx wrapper. Note table IS the song — open c64_music.c.
const C64_MUSIC_RUNTIME = [
  { src: "lib/c64_registers.h", dst: "c64_registers.h" },
  { src: "lib/c/c64_music.h",   dst: "c64_music.h" },
  { src: "lib/c/c64_music.c",   dst: "c64_music.c" },
];
const C64_LANG = "C (cc65)";
TEMPLATES.c64 = {
  default: {
    main: "main.c", runtime: [{ src: "lib/c64_registers.h", dst: "c64_registers.h" }], runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "Minimal cc65 C64 program. Includes c64_registers.h (VIC-II + SID + CIA + kernel addrs).",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c", runtime: [{ src: "lib/c64_registers.h", dst: "c64_registers.h" }], runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "One VIC-II hardware sprite driven by joystick port 2.",
  },
  tile_engine: {
    main: "templates/tile_engine.c", runtime: [{ src: "lib/c64_registers.h", dst: "c64_registers.h" }], runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "40×25 character-matrix world with a hardware sprite + AABB collision.",
  },
  shmup: {
    main: "templates/shmup.c", runtime: C64_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "Vertical-shmup. Player + 3 bullets + 4 enemies via VIC-II hardware sprites. SID sfx: pew + boom.",
  },
  platformer: {
    main: "templates/platformer.c", runtime: C64_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "SIDE-SCROLLING platformer for C64 — the fiddliest scroll of all the platforms, done for real. 80-col (640-px) world; the VIC-II only fine-scrolls 0-7 px in hardware ($D016 low 3 bits), so coarse motion re-renders the 40 visible columns of screen RAM ($0400) + color RAM ($D800) from a world map each time the camera crosses a char boundary. 38-column mode ($D016 bit 3 clear) masks the edge garbage column. The player is a VIC-II hardware sprite drawn in screen space (with the $D010 X-MSB handled); SID jump sfx. Joystick port 2, B1 jumps. See the C64 MENTAL_MODEL.md 'Horizontal scrolling'. Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c", runtime: C64_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "Match-3 falling-block puzzle. 6×12 grid in screen RAM (40×25 char matrix), C64 color codes. Rotate click + clear chime via SID.",
  },
  sports: {
    main: "templates/sports.c", runtime: C64_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "Pong with 3 hardware sprites. Joystick port 2 = P1; AI on the right paddle. SID paddle-hit + wall-bounce + score sfx.",
  },
  racing: {
    main: "templates/racing.c", runtime: C64_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "3-lane top-down racer. LEFT/RIGHT switches lanes. SID lane-switch beep + crash noise.",
  },
  music_demo: {
    main: "templates/music_demo.c", runtime: C64_MUSIC_RUNTIME, runtimeDirs: C64_VENDOR_DIRS,
    lang: C64_LANG, ext: ".prg",
    describe: "Continuous 3-voice SID music demo. Per-frame note-table sequencer (c64_music.c IS the song — edit it). Melody / bass / harmony over an Am-F-C-G loop; FIRE on joy port 2 toggles playback.",
  },
};
// R31: SNES audio assets shared by all C-mode genre scaffolds. The
// SPC700 driver source + sample BRR files are visible alongside the
// prebuilt apu_blob.bin (which gets .incbin'd into the ROM via
// snes_sfx_data.asm). User can rebuild apu_blob with asar — see
// src/platforms/snes/lib/audio/apu_blob.asm.
const SNES_SFX_RUNTIME = [
  { src: "lib/c/snes_sfx.h",      dst: "snes_sfx.h" },
  { src: "lib/c/snes_sfx.c",      dst: "snes_sfx.c" },
  { src: "lib/c/snes_sfx_data.asm", dst: "snes_sfx_data.asm" },
  { src: "lib/audio/apu_blob.bin",  dst: "apu_blob.bin" },
  { src: "lib/audio/spc_driver.asm", dst: "spc_driver.asm" },
  { src: "lib/audio/apu_blob.asm",   dst: "apu_blob.asm" },
  { src: "lib/audio/shoot.brr",      dst: "shoot.brr" },
  { src: "lib/audio/explosion.brr",  dst: "explosion.brr" },
  { src: "lib/audio/sample_bank.bin", dst: "sample_bank.bin" },
];

// R58b: ship the full PVSnesLib source tree into every SNES C
// project so the agent can grep snes/sound.h, consoleDrawText,
// setMode, padsCurrent, etc. instead of stabbing at the precompiled
// .obj. Same rationale as the Lynx cc65-src bundling — the agent
// debugs faster when they can read what the library actually does.
const SNES_PVSNESLIB_VENDOR_DIRS = [
  { src: "lib/pvsneslib/include", dst: "vendor/pvsneslib/include" },
  { src: "lib/pvsneslib/source",  dst: "vendor/pvsneslib/source" },
];

TEMPLATES.snes = {
  // C is the SNES default. PVSnesLib gives a clean C API (oamSet,
  // padsCurrent, WaitForVBlank, etc.) instead of raw 65816 — same
  // ergonomics as every other platform's C-mode default. Renders a
  // movable sprite on a blue backdrop, no font dependency.
  default: {
    main: "templates/default.c",
    extraSources: [
      { src: "templates/default-data.asm", dst: "data.asm" },
    ],
    runtime: [],
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Minimal SNES C starter: movable sprite + blue backdrop using PVSnesLib (oamSet, padsCurrent, WaitForVBlank). Two-file project: main.c + data.asm.",
  },
  // Raw 65816 path — kept for cycle-accurate work, IRQ-driven raster
  // effects, etc. Same content as the pre-2026-05-27 `default`.
  asm: {
    main: "main.asm",
    runtime: [
      { src: "lib/lorom_header.asm", dst: "lorom_header.asm" },
      { src: "lib/cgram_upload.asm", dst: "cgram_upload.asm" },
      { src: "lib/reset_init.asm", dst: "reset_init.asm" },
    ],
    lang: "65816 assembly (asar)",
    ext: ".sfc",
    describe: "Raw 65816 asar starter: blue backdrop via CGRAM upload. Use when you need cycle-accurate control (raster splits, mid-frame DMA, etc.). For most game work prefer template:\"default\" (PVSnesLib C).",
  },
  // Text-mode console hello-world. Useful for status displays /
  // debug overlays / tutorial-style text adventures.
  c_hello: {
    main: "templates/c-hello.c",
    extraSources: [
      { src: "templates/c-hello-data.asm", dst: "data.asm" },
    ],
    runtime: [],
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "PVSnesLib text-mode starter: consoleDrawText writes ASCII into a tile-mapped BG0. Stub font in data.asm — replace with .incbin of a real .pic/.pal for legible glyphs.",
  },
  // R21: parity templates with NES + Genesis. tcc-65816 is C89, so all
  // declarations live at block top. Two-file projects (.c + .asm) because
  // PVSnesLib's runtime expects tilfont/palfont symbols to be linkable;
  // sprite templates also ship tilsprite + palsprite hand-authored bytes.
  hello_sprite: {
    main: "templates/hello_sprite.c",
    extraSources: [
      { src: "templates/hello_sprite-data.asm", dst: "data.asm" },
    ],
    runtime: [],
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "One 8×8 sprite + d-pad. oamSet/oamUpdate canonical loop, hand-authored sprite tile + palette in data.asm. Fork to add more sprites, animations, sound.",
  },
  shmup: {
    main: "templates/shmup.c",
    extraSources: [
      { src: "templates/shmup-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Vertical-shmup scaffold for SNES. Player ship + 6 bullets + 6 enemies, wave spawner, AABB collisions, score. SFX (pew on fire, boom on hit) via the bundled SPC700 driver + sample bank.",
  },
  platformer: {
    main: "templates/platformer.c",
    extraSources: [
      { src: "templates/platformer-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "SIDE-SCROLLING platformer for SNES (PVSnesLib). Subpixel gravity + jump + land-on-top collision across a 512-px world. A camera follows the player; the BG scrolls in hardware via bgSetScroll(0, camX, 0) and the player sprite draws in screen space (worldX - camX), held screen-centered while the world moves under it. Jump SFX via the bundled SPC700 driver. NOTE: uses the PVSnesLib console (text) BG, so platforms are collision-only and the scroll shows as the on-BG text sliding — for visible tiled platform art across a wide world, build a tileset with gfx2snes + bgInitTileSet on a 64-wide map and stream tilemap columns into VRAM during vblank. See the SNES MENTAL_MODEL.md 'Horizontal scrolling'. BUILD: needs language:'c', snes_sfx_data.asm in sources, apu_blob.bin as a binary include, and snes_sfx.c/.h in includePaths (all scaffolded by createGame).",
  },
  puzzle: {
    main: "templates/puzzle.c",
    extraSources: [
      { src: "templates/puzzle-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Match-3 falling-block puzzle for SNES. 6×12 grid (text mode), rotate/soft-drop/hard-drop, horizontal-triple clear. Rotate click + clear chime via bundled SPC700 sfx.",
  },
  sports: {
    main: "templates/sports.c",
    extraSources: [
      { src: "templates/sports-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Two-player Pong on SNES. padsCurrent(0)/padsCurrent(1) wire both ports. Paddle-hit + score sfx via bundled SPC700 driver.",
  },
  racing: {
    main: "templates/racing.c",
    extraSources: [
      { src: "templates/racing-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Endless 3-lane top-down racer for SNES. LEFT/RIGHT switches lanes, obstacles slide down at growing speed. Two sprite tiles (player + enemy), score in BG text overlay.",
  },
  // R46: continuous-music demo on the SPC700 driver. Showcases
  // sfx_music_play / sfx_music_stop alongside the existing sfx_play
  // path — the SPC walks a song table autonomously while the 65816
  // just polls input.
  music_demo: {
    main: "templates/music_demo.c",
    extraSources: [
      { src: "templates/music_demo-data.asm", dst: "data.asm" },
    ],
    runtime: SNES_SFX_RUNTIME,
    runtimeDirs: SNES_PVSNESLIB_VENDOR_DIRS,
    lang: "C (tcc-65816 + PVSnesLib)",
    ext: ".sfc",
    describe: "Continuous SPC700 music + SFX demo. Auto-plays a looping arpeggio on voice 1; B = shoot sfx (voice 0), A = stop music, START = resume. Starting point for adding music to any SNES C scaffold.",
  },
};
// All SGDK Genesis C templates share the same runtime bundle: libmd.a,
// crt0 (sega.s + cpp-expanded sega.preprocessed.s for the bare WASM `as`),
// linker script, ROM header source, MIT license, and the full include
// tree. Factored to a constant so adding a new template only takes a
// single line below (template name + main C file).
const SGDK_RUNTIME = [
  { src: "lib/sgdk/libmd.a",             dst: "libmd.a" },
  { src: "lib/sgdk/sega.s",              dst: "sega.s" },
  { src: "lib/sgdk/sega.preprocessed.s", dst: "sega.preprocessed.s" },
  { src: "lib/sgdk/rom_header.c",        dst: "rom_header.c" },
  { src: "lib/sgdk/md.ld",               dst: "md.ld" },
  { src: "lib/sgdk/LICENSE",             dst: "LICENSE-SGDK" },
  { src: "lib/sgdk/COPYING.RUNTIME",     dst: "COPYING-SGDK-RUNTIME" },
  // R30: minimal PSG sound-effects wrapper. 3 functions matching the
  // NES/GB/GBA scaffold sound shape.
  { src: "lib/c/genesis_sfx.h",          dst: "genesis_sfx.h" },
  { src: "lib/c/genesis_sfx.c",          dst: "genesis_sfx.c" },
];
const SGDK_RUNTIME_DIRS = [
  { src: "lib/sgdk/include", dst: "include" },
  // R58b: ship the full SGDK src tree into the project. Agent can grep
  // it directly instead of guessing what SPR_addSprite / VDP_drawText /
  // JOY_readJoypad / XGM2_startPlay actually do.
  { src: "lib/sgdk/src", dst: "vendor/sgdk/src" },
];
const SGDK_LANG = "C (m68k-elf-gcc + SGDK)";

// R42: XGM2 music runtime — adds the demo .vgm source + compiled .xgc blob
// alongside the standard SGDK headers/libmd. .vgm is the human-editable
// chiptune (regen via scripts/build-genesis-demo-vgm.js + xgm2tool); .xgc
// is what gets .incbin'd into ROM via the data.s sibling.
const SGDK_XGM2_RUNTIME = [
  ...SGDK_RUNTIME,
  { src: "lib/sgdk/music/demo.vgm", dst: "demo.vgm" },
  { src: "lib/sgdk/music/demo.xgc", dst: "demo.xgc" },
];

TEMPLATES.genesis = {
  // C via SGDK is the Genesis default. SGDK gives a clean C API
  // (VDP_drawText, SYS_doVBlankProcess, SPR_addSprite, etc.) and
  // builds in <2s. Same ergonomics as every other platform's C
  // default — agent ships a game in one session, not 10.
  default: {
    main: "templates/sgdk_hello.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Genesis C default using SGDK: VDP_drawText shows 'HELLO SEGA GENESIS'. #include <genesis.h>, SYS_doVBlankProcess, full SGDK API. For raw 68k asm see template:\"asm\".",
  },
  // Kept for cycle-accurate work / IRQ-driven raster effects.
  asm: {
    main: "main.s",
    runtime: [
      { src: "lib/header.s", dst: "header.s" },
      { src: "lib/vdp_init.s", dst: "vdp_init.s" },
      { src: "lib/vblank_wait.s", dst: "vblank_wait.s" },
    ],
    lang: "68k assembly (vasm68k)",
    ext: ".bin",
    describe: "Raw 68k Genesis starter (vasm68k): header + VDP init + vblank wait. Use when you need cycle-accurate control (raster splits, mid-frame DMA). For most game work prefer template:\"default\" (SGDK C).",
  },
  sgdk_hello: {
    main: "templates/sgdk_hello.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Alias of template:\"default\" (kept for backward-compat with earlier scripts that named it explicitly).",
  },
  // R42: XGM2 music playback — counterpart to the R30 PSG sfx wrapper.
  // Two-file project (main.c + data.s sibling); data.s does the .incbin
  // of demo.xgc, matching R31's snes_sfx_data.asm pattern. The compiled
  // .xgc plus its source .vgm both ship in the project tree so users can
  // regen with xgm2tool.
  xgm2_demo: {
    main: "templates/xgm2_demo.c",
    extraSources: [
      { src: "templates/xgm2_demo_data.s", dst: "data.s" },
    ],
    runtime: SGDK_XGM2_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "XGM2 music playback demo. XGM2_loadDriver + XGM2_play, music blob incbin'd via data.s sibling. Ships a tiny CC0 PSG arpeggio (demo.vgm source + demo.xgc compiled) — regen with SGDK's xgm2tool. SYS_doVBlankProcess drives the Z80 driver tick.",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Single sprite + d-pad. Uploads one 8×8 tile via VDP_loadTileData, places one VDP sprite, reads JOY_1 each frame, calls VDP_updateSprites + SYS_doVBlankProcess. The minimum-viable input-driven scaffold — fork from here to add more sprites, palettes, sound.",
  },
  tile_engine: {
    main: "templates/tile_engine.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "40×28 tile world on plane B with a walking player + AABB collision against solid tile IDs. Demonstrates VDP_setTileMapXY / VDP_fillTileMapRect / two-plane composition. Single-screen — extend with VDP_setHorizontalScroll for scrolling worlds.",
  },
  shmup: {
    main: "templates/shmup.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Vertical-shmup genre scaffold. Player ship + 6 bullet slots + 6 enemy slots (object pools, no malloc), wave spawner, AABB collisions, score. Pre-allocated SAT slot ranges (0=player, 1-6=bullets, 7-12=enemies) so no flicker.",
  },
  platformer: {
    main: "templates/platformer.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "SIDE-SCROLLING platformer for Genesis. Subpixel gravity + jump + land-on-top collision against a static platform list spread across a 512-px world. Camera follows the player; Plane A scrolls with the world via VDP_setHorizontalScroll, Plane B scrolls at half-rate for parallax. A=jump, d-pad=move. The world here is one 64-cell plane wide (no streaming) — for a wider world, stream the column entering view each 8-px camera step (see Genesis MENTAL_MODEL.md 'Horizontal scrolling'). Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Match-3 falling-block puzzle genre scaffold. 6×12 grid, 1×3 active piece (3 colours), rotate via A, soft-drop on DOWN, hard-drop on START, horizontal-triple clear. xorshift RNG so cell colours actually vary.",
  },
  sports: {
    main: "templates/sports.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Two-player Pong via JOY_1 + JOY_2. AI fallback on port 2 when no second controller. Per-side score 0-9 rendered via VDP_drawText, ball bounces off paddles + court walls. Designed for the playtest window with hot-plugged controllers.",
  },
  racing: {
    main: "templates/racing.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Endless top-down 3-lane racer. LEFT/RIGHT switches lanes, obstacles slide down at increasing speed as score climbs. Game-over on collision with 60-frame freeze then auto-reset.",
  },
  shmup_2p: {
    main: "templates/shmup_2p.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Two-player competitive shmup via JOY_1 + JOY_2. Each player has their own ship + 4-bullet pool + score. Enemies shared — first to hit scores the 10 points. Designed for the romdev playtest window with two hot-plugged controllers.",
  },
};

// Simpler one-file platforms — no runtime/template variants, just a seed source.
// These platforms don't yet have a per-platform lib/ runtime to bundle.
// Empty today; every supported platform now has a full TEMPLATES entry.
const SIMPLE_STARTERS = {};

// R38: Lynx tier-1 with full template set + MIKEY sound + tgi graphics.
// R43: music_demo template — cc65's lynx_snd_play streaming music engine.
// R58b: ship the cc65 Lynx libsrc INTO each project so the agent can
//   grep the TGI driver / lynx_snd engine / joystick driver without
//   leaving their project dir. The 1500-frame TGI wedge round
//   (rounds 28-32) was caused entirely by the agent debugging a
//   blackbox driver. R58 copy-into-install was the half-step;
//   R58b shipping into the PROJECT closes the loop.
const LYNX_VENDOR_DIRS = [
  { src: "lib/cc65-src", dst: "vendor/cc65/libsrc/lynx" },
];
const LYNX_RUNTIME = [
  { src: "lib/c/lynx_sfx.h", dst: "lynx_sfx.h" },
  { src: "lib/c/lynx_sfx.c", dst: "lynx_sfx.c" },
];
const LYNX_MUSIC_RUNTIME = [
  { src: "lib/c/lynx_music.h", dst: "lynx_music.h" },
  { src: "lib/c/lynx_music.c", dst: "lynx_music.c" },
];
const LYNX_LANG = "C (cc65 + tgi)";
TEMPLATES.lynx = {
  default: {
    main: "templates/default.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Minimal Lynx starter: TGI color-cycling square + 'HELLO LYNX' text. Smallest possible ROM that does something visible — use as starting point when you're not sure what to build. Project also includes vendor/cc65/libsrc/lynx/ — the FULL cc65 Lynx driver source (TGI, joystick, sound, conio) so you can grep it directly when debugging.",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Lynx hello + joystick movement. cc65 tgi graphics + lynx_sfx for sound. Boot chime confirms MIKEY audio is wired.",
  },
  music_demo: {
    main: "templates/music_demo.c", runtime: LYNX_MUSIC_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "cc65's lynx_snd_play streaming music engine demo. Plays a short (note, length) sequence on channel 0 via the 240Hz timer IRQ. Hand-authored music bytestream in lynx_music.c — the byte array IS the source. Pairs with lynx_sfx (one-shot pokes) for full audio coverage.",
  },
  shmup: {
    main: "templates/shmup.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Vertical-shmup. Player + 4 bullets + 4 enemies (object pools), AABB collisions. MIKEY pew + boom sfx.",
  },
  platformer: {
    main: "templates/platformer.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Single-screen platformer. Subpixel gravity + jump + 5 platforms. MIKEY jump sfx.",
  },
  puzzle: {
    main: "templates/puzzle.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Match-3 puzzle. 6×12 grid via tgi_bar. Rotate click + clear chime via MIKEY.",
  },
  sports: {
    main: "templates/sports.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "Pong vs AI (handheld = one controller). MIKEY paddle-hit + wall-bounce + score sfx.",
  },
  racing: {
    main: "templates/racing.c", runtime: LYNX_RUNTIME, runtimeDirs: LYNX_VENDOR_DIRS,
    lang: LYNX_LANG, ext: ".lnx",
    describe: "3-lane top-down racer. MIKEY lane-switch beep + crash noise.",
  },
};

// R24 + R28: Game Boy Advance C tier-1 via arm-none-eabi-gcc + EITHER
// libtonc (default, Tonc-tutorial-aligned) OR libgba (devkitPro
// official). Same self-containment policy as Genesis SGDK — the
// entire runtime bundle gets copied INTO the user's project so they
// can rebuild on any machine with devkitARM installed.
//
// Why libtonc is the default: the Tonc tutorial at gbadev.net/tonc is
// THE GBA C corpus the LLM has been trained on. Agent-generated code
// matches Tonc idioms naturally (tte_write, tonccpy, OBJ_ATTR, etc.).
// libgba stays available via `runtime:"libgba"` or `template:"gba_hello"`.
//
// One caveat shared by both runtimes: the libsysbase-backed iprintf
// bridge (tte_iohook in libtonc, console.c in libgba) is NOT bundled.
// Use tte_printf directly with libtonc — that's the Tonc-tutorial
// pattern and works without the libsysbase header chain.
const GBA_LIBTONC_RUNTIME = [
  // libtonc itself is compiled from source by the build (its source is vendored
  // via GBA_LIBTONC_RUNTIME_DIRS), so no prebuilt libtonc.a is copied in.
  { src: "lib/libtonc/gba_crt0.s",   dst: "gba_crt0.s" },
  { src: "lib/libtonc/gba_cart.ld",  dst: "gba_cart.ld" },
  { src: "lib/libtonc/crti.o",       dst: "crti.o" },
  { src: "lib/libtonc/crtn.o",       dst: "crtn.o" },
  { src: "lib/libtonc/crtbegin.o",   dst: "crtbegin.o" },
  { src: "lib/libtonc/crtend.o",     dst: "crtend.o" },
  // Minimal sfx wrapper around the GBA's DMG-compatible APU. Matches
  // the NES/GB scaffold sound shape — sfx_init + sfx_tone + sfx_noise.
  { src: "lib/c/gba_sfx.h",          dst: "gba_sfx.h" },
  { src: "lib/c/gba_sfx.c",          dst: "gba_sfx.c" },
];
const GBA_LIBTONC_RUNTIME_DIRS = [
  { src: "lib/libtonc/include",    dst: "include" },
  { src: "lib/libgba/sysinclude",  dst: "sysinclude" },   // shared with libgba
  // R58b: ship the FULL libtonc source tree INTO the project so the
  // agent can grep/read every implementation (TTE, OAM helpers, IRQ
  // setup, etc.) instead of stabbing in the dark against libtonc.a.
  // The 1500-frame Lynx wedge took 5 rounds partly because cc65 TGI
  // source wasn't in the project tree. Don't repeat that for libtonc.
  { src: "lib/libtonc/src",        dst: "vendor/libtonc/src" },
  { src: "lib/maxmod",             dst: "vendor/maxmod" },
];
const GBA_LIBGBA_RUNTIME = [
  // libgba is compiled from source by the build (source vendored via
  // GBA_LIBGBA_RUNTIME_DIRS); no prebuilt libgba.a copied in.
  { src: "lib/libgba/gba_crt0.s",   dst: "gba_crt0.s" },
  { src: "lib/libgba/gba_cart.ld",  dst: "gba_cart.ld" },
  { src: "lib/libgba/crti.o",       dst: "crti.o" },
  { src: "lib/libgba/crtn.o",       dst: "crtn.o" },
  { src: "lib/libgba/crtbegin.o",   dst: "crtbegin.o" },
  { src: "lib/libgba/crtend.o",     dst: "crtend.o" },
];
const GBA_LIBGBA_RUNTIME_DIRS = [
  { src: "lib/libgba/include",    dst: "include" },
  { src: "lib/libgba/sysinclude", dst: "sysinclude" },
  // R58b: ship full libgba source so the agent can grep irqInit /
  // irqSet / VBlankIntrWait / GBA register defines directly.
  { src: "lib/libgba/src",        dst: "vendor/libgba/src" },
];
const GBA_TONC_LANG  = "C (arm-none-eabi-gcc + libtonc)";
const GBA_LIBGBA_LANG = "C (arm-none-eabi-gcc + libgba)";

TEMPLATES.gba = {
  // Tonc is the default — first key + canonical for new projects.
  tonc_hello: {
    main: "templates/tonc_hello.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "Idiomatic Tonc-tutorial GBA C starter. #include <tonc.h>, TTE (Tonc Text Engine) draws 'Hello, Tonc!' on BG0 in MODE_0. Matches what every published GBA C tutorial at gbadev.net teaches. Bundled runtime: libtonc.a + 18 headers + gba_crt0 + linker script. Build with buildSource({platform:'gba', language:'c'}) — defaults to runtime:'libtonc'.",
  },
  tonc_hello_sprite: {
    main: "templates/tonc_hello_sprite.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "One 8x8 sprite driven by the d-pad. Canonical Tonc sprite-chapter pattern: OBJ_ATTR shadow buffer + oam_copy DMA flush + key_poll/key_held input + 4bpp sprite tile + sprite palette setup. Forks well to multi-sprite scaffolds.",
  },
  shmup: {
    main: "templates/shmup.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "Vertical shmup scaffold (Tonc). Player ship + 6 bullets + 6 enemies (fixed object pools), AABB collision, enemy wave spawner, TTE score readout. ~150 lines.",
  },
  platformer: {
    main: "templates/platformer.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "SIDE-SCROLLING platformer for GBA (Tonc). Subpixel physics (1px = 16 subpixels), gravity + jump + land-on-top collision against platforms in a 512-px world. BG0 is a 64x32 map (whole world fits, no streaming); the camera follows the player via REG_BG0HOFS; the TTE HUD on BG1 stays fixed. For a world wider than 512 px, stream map columns as the camera advances (see GBA MENTAL_MODEL.md). Extend with enemies, goals, pickups.",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "Match-3 falling-block scaffold (Tonc). 6x12 grid drawn as BG tiles, 1x3 active piece with LEFT/RIGHT shift, A rotate, DOWN soft-drop, START hard-drop. Horizontal triples clear + score.",
  },
  sports: {
    main: "templates/sports.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "Pong scaffold (Tonc). Single-controller GBA → right paddle is AI ball-tracker. 24px paddles built from 3 stacked 8x8 sprites, ball collisions, score 0-9 via TTE. Real 2P on GBA needs link cable (out of scope).",
  },
  racing: {
    main: "templates/racing.c",
    runtime: GBA_LIBTONC_RUNTIME,
    runtimeDirs: GBA_LIBTONC_RUNTIME_DIRS,
    lang: GBA_TONC_LANG,
    ext: ".gba",
    describe: "Top-down 3-lane racer scaffold (Tonc). Player car bottom, obstacles spawn from top + slide down, L/R switches lanes, AABB crash detection, 60-frame freeze + reset. Score is frames-since-crash.",
  },
  // Opt-in libgba path for users who prefer the devkitPro SDK or are
  // porting an existing libgba codebase.
  gba_hello: {
    main: "templates/gba_hello.c",
    runtime: GBA_LIBGBA_RUNTIME,
    runtimeDirs: GBA_LIBGBA_RUNTIME_DIRS,
    lang: GBA_LIBGBA_LANG,
    ext: ".gba",
    describe: "Alternate GBA C starter using devkitPro's libgba SDK. MODE_3 framebuffer + red pixel. Pass runtime:'libgba' to buildSource — or just use the Tonc path (gba_hello_tonc) which is better aligned with what published tutorials teach.",
  },
  // R34: maxmod music demo. Ships a hand-authored CC0 chiptune.xm +
  // its pre-built soundbank.bin. buildSource must be called with
  // `maxmod: true` AND binaryIncludes:{ "soundbank.bin": <bytes> } —
  // the buildGbaC layer auto-emits a `.incbin "soundbank.bin"` asm
  // stub exposing the soundbank under the global symbol soundbank_bin.
  // The .xm source ships alongside so users can regenerate the
  // soundbank with mmutil after editing the tune.
  maxmod_demo: {
    main: "templates/maxmod_demo.c",
    runtime: [
      ...GBA_LIBTONC_RUNTIME,
      // maxmod compiled from source by the build — no prebuilt libmm.a.
      { src: "lib/maxmod/music/chiptune.xm",             dst: "chiptune.xm" },
      { src: "lib/maxmod/music/chiptune_soundbank.bin",  dst: "soundbank.bin" },
      { src: "lib/maxmod/music/chiptune_soundbank.h",    dst: "soundbank.h" },
      { src: "lib/maxmod/music/make_chiptune_xm.js",     dst: "make_chiptune_xm.js" },
      { src: "lib/maxmod/LICENSE-MAXMOD",                dst: "LICENSE-MAXMOD" },
    ],
    runtimeDirs: [
      ...GBA_LIBTONC_RUNTIME_DIRS,
      // Adds maxmod.h + mm_types.h next to the libtonc headers.
      { src: "lib/maxmod/include",  dst: "include" },
    ],
    lang: GBA_TONC_LANG,
    ext: ".gba",
    maxmod: true,
    binaryIncludes: ["soundbank.bin"],
    describe: "Maxmod music demo (Tonc + libmm). Plays a CC0 chiptune.xm soundbank via mmInitDefault + mmStart + mmFrame, with START toggling pause. Pass `maxmod:true` AND `binaryIncludes:{\"soundbank.bin\": <bytes>}` to buildSource. The .xm source + generator script + pre-built soundbank.bin all ship in the project — edit and re-run mmutil to swap the tune.",
  },
};

// R22: Atari 2600 promoted to multi-template platform. The 2600 has no
// C compiler (asm only via dasm) and the genre-shmup/platformer/puzzle
// scaffolds from other platforms don't map cleanly — its hardware
// forces "race the beam" rendering. Three templates here that ARE
// idiomatic 2600:
//   default        — single sprite, blue background, joystick movement
//   paddle         — Pong-style: two paddles + ball + walls
//   single_screen  — dodge-the-falling-pixels using P0 + M0
//   music_demo     — two-voice TIA chiptune
//   mini_invaders  — gallery shooter via P0 cannon + P1/NUSIZ1 invaders + M0 shot
TEMPLATES.atari2600 = {
  default: {
    main: "templates/default.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "Hello, 2600. Blue background + white player sprite + joystick movement. Race-the-beam scanline-by-scanline rendering; demonstrates VSYNC/VBLANK/visible/overscan frame structure.",
  },
  paddle: {
    main: "templates/paddle.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "Pong-style scaffold. Two 8-pixel paddles (P0 + P1), one 2-pixel ball (BL), top + bottom walls (PF). Left paddle on joystick, right paddle AI chases ball Y. Demonstrates multi-object positioning via RESP0/RESP1/RESBL.",
  },
  single_screen: {
    main: "templates/single_screen.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "Dodge-the-falling-pixels scaffold. Player at bottom (P0), one falling rock (M0 missile). Demonstrates per-frame missile reset + survive-counter. Extend with multiple missiles, hit detection via TIA collision regs.",
  },
  music_demo: {
    main: "templates/music_demo.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "Two-voice TIA chiptune scaffold. Voice 0 = 32-note melody, voice 1 = 16-note bass ostinato, both driven from hand-authored (AUDF, length_frames) note tables in ROM. AUDC0=AUDC1=$04 (pure tone). Music updates happen during VBLANK (never during visible scanlines). Display is minimal — blue BG + a centered playfield band — because the point IS the audio. The note tables ARE the song; edit them and you're writing chiptune.",
  },
  mini_invaders: {
    main: "templates/mini_invaders.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "Gallery-shooter (Space-Invaders-shaped) done with the RIGHT TIA objects, not playfield 'barcode' bars: P0 = double-width cannon, P1 + NUSIZ1=%011 = a row of THREE hardware-replicated invaders (one GRP1 write draws all three), M0 = the player shot. Aliens march left/right and drop a step at the edges; fire with the joystick button. The honest 2600-idiomatic way to do this genre — extend by reusing P1 lower for shields or adding M1 as an alien bomb. Verified: marches + renders cannon/aliens/shot.",
  },
};

// R22: Atari 7800 promoted to multi-template platform. Each template is
// a standalone .c file under examples/atari7800/templates/. The 7800's
// MARIA architecture (display lists, no traditional tilemap) makes the
// scaffolds work differently from the NES — see the comments in each
// template for the per-object-DL vs framebuffer trade-off.
// R40: TIA sound wrapper for 7800 scaffolds. 2 voices (no noise channel
// per se — but distortion mode 8 = white noise). See atari7800_sfx.h.
const ATARI7800_SFX_RUNTIME = [
  { src: "lib/c/atari7800_sfx.h", dst: "atari7800_sfx.h" },
  { src: "lib/c/atari7800_sfx.c", dst: "atari7800_sfx.c" },
];
// R44: TIA 2-voice music driver — separate runtime since music_demo
// pulls in the song-player tables (atari7800_music.*) instead of the
// one-shot sfx wrapper. Other scaffolds still use ATARI7800_SFX_RUNTIME.
const ATARI7800_MUSIC_RUNTIME = [
  { src: "lib/c/atari7800_music.h", dst: "atari7800_music.h" },
  { src: "lib/c/atari7800_music.c", dst: "atari7800_music.c" },
];

TEMPLATES.atari7800 = {
  default: {
    main: "templates/default.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Minimal MARIA bring-up: DLL + DL pointing at one 16-pixel sprite + palette + DMA enable. The 7800 has no tilemap — display is a list of objects placed at (zone, x).",
  },
  hello_sprite: {
    main: "templates/hello_sprite.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Single sprite driven by joystick port A. Vertical movement faked by stamping the sprite at different row offsets within a 24-row canvas — real 7800 games use multi-zone DLLs for Y movement.",
  },
  shmup: {
    main: "templates/shmup.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Per-object-DL shmup. Each game object (player, bullet, enemy) is one MARIA 5-byte DL header. 4 bullets + 4 enemies in one zone, with X mutated per frame. Demonstrates per-frame DL rebuild + how the 7800 differs from sprite-table consoles.",
  },
  platformer: {
    main: "templates/platformer.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Single-screen platformer in one zone. Subpixel gravity + jump + ground detection. Vertical movement faked via row-offset stamping into the player's 24-row canvas (Y is encoded by which row of the canvas the sprite starts at).",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Match-3 falling-block puzzle. 6×12 grid via per-cell MARIA DL entries (one 5-byte header per filled cell). Three palettes for R/G/B colours. Active piece is 3 extra DL entries.",
  },
  sports: {
    main: "templates/sports.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Two-player Pong on Atari 7800. Both joystick ports wired — SWCHA bits 4-7 = P1, bits 0-3 = P2. AI fallback when P2 isn't plugged in. Three per-object MARIA DL entries (paddles + ball) drawn into tall thin canvases that fit in the 7800's 4 KB RAM.",
  },
  racing: {
    main: "templates/racing.c",
    runtime: ATARI7800_SFX_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "Endless 3-lane top-down racer. Per-object MARIA DL pattern (same as the 7800 shmup) — each game object is one 5-byte DL header pointing at a static tile in ROM. LEFT/RIGHT switches lanes, obstacle speed grows with score.",
  },
  music_demo: {
    main: "templates/music_demo.c",
    runtime: ATARI7800_MUSIC_RUNTIME,
    lang: "C (cc65)",
    ext: ".a78",
    describe: "TIA 2-voice music demo. Hand-authored melody (voice 0, arpeggio + descending walk) and bass (voice 1, walking I-V-IV-V quarters) drive both TIA channels via parallel { distortion, freq, frames } note tables in atari7800_music.c — the tables ARE the song. TIA's 5-bit divider gives ~32 pitches, so the tune sounds primitive on purpose. Minimal pixel-art MUSIC banner on a blue background.",
  },
};

function pickRomExt(platform) {
  if (TEMPLATES[platform]) {
    if (platform === "gbc") return ".gbc";
    if (platform === "gb")  return ".gb";
    if (platform === "nes") return ".nes";
    if (platform === "snes") return ".sfc";
    if (platform === "genesis") return ".bin";
    if (platform === "c64") return ".prg";
    if (platform === "sms") return ".sms";
    if (platform === "gg")  return ".gg";
    if (platform === "atari7800") return ".a78";
    if (platform === "atari2600") return ".a26";
    if (platform === "gba") return ".gba";
  }
  return SIMPLE_STARTERS[platform]?.ext ?? ".bin";
}

/**
 * Recursively copy every file in `srcDir` to `dstDir`, creating
 * subdirectories on demand. Each written file's project-relative path
 * is appended to `writtenFiles` (prefixed with `dstPrefix`, the
 * relative location under the project root where this subtree lives).
 *
 * Used by `runtimeDirs` template entries — currently the SGDK Genesis
 * template, which ships ~270 header files from src/platforms/genesis/
 * lib/sgdk/include into the user's project as include/.
 *
 * Header files are utf-8; everything else is read as raw bytes so
 * binary blobs (resource .pic / .pal data, archives) round-trip
 * unchanged.
 */
async function copyDirRecursive(fs, path, srcDir, dstDir, writtenFiles, dstPrefix) {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(srcDir, ent.name);
    const dstPath = path.join(dstDir, ent.name);
    const relPath = dstPrefix ? `${dstPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      await copyDirRecursive(fs, path, srcPath, dstPath, writtenFiles, relPath);
    } else if (ent.isFile()) {
      const isText = /\.(h|c|s|asm|inc|ld|txt|md|cfg|json)$/i.test(ent.name);
      const contents = await fs.readFile(srcPath, isText ? "utf-8" : null);
      await fs.writeFile(dstPath, contents);
      writtenFiles.push(relPath);
    }
  }
}

/**
 * Programmatic equivalent of the createProject MCP tool. Lifted to a
 * standalone function so createGame can reuse it without going through
 * the SDK's tool-call surface.
 *
 * @param {{platform: string, name: string, path: string, title?: string,
 *   template?: string, overwrite?: boolean}} args
 * @returns {Promise<object>} the same JSON shape createProject's MCP
 *   handler returns: {path, platform, template, files, sourceFile,
 *   toolchain, nextStep}.
 */
export async function createProjectImpl({ platform, name, path: projPath, title, template, overwrite = false, withSnippets = false }) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
  // R37 (revisited): gbc gets its own tree now — color-aware scaffolds,
  // GBC-specific docs, distinct examples/gbc/templates/ + src/platforms/
  // gbc/lib/c/. Same Z80 + APU + most VRAM layout as GB, but BCPS/BCPD
  // palette setup and visibly colorful tile art make the difference.
  const EXAMPLES_DIR = path.join(REPO_ROOT, "examples", platform);
  const PLATFORM_LIB_DIR = path.join(REPO_ROOT, "src", "platforms", platform);
  const CC65_PRESETS_DIR = path.join(REPO_ROOT, "src", "toolchains", "cc65");

  const hasTemplates = !!TEMPLATES[platform];
  const isSimple = !!SIMPLE_STARTERS[platform];
  if (!hasTemplates && !isSimple) {
    throw new Error(`createProject doesn't yet support platform '${platform}'. Supported: ${[...Object.keys(TEMPLATES), ...Object.keys(SIMPLE_STARTERS)].sort().join(", ")}`);
  }

  /** @type {any} */
  let tmpl = null;
  let mainFilename;
  let lang;
  if (hasTemplates) {
    const tname = template ?? "default";
    tmpl = TEMPLATES[platform][tname];
    if (!tmpl) {
      throw new Error(`Unknown template '${tname}' for platform '${platform}'. Available: ${Object.keys(TEMPLATES[platform]).join(", ")}`);
    }
    const mainExt = path.extname(tmpl.main);
    mainFilename = `main${mainExt}`;
    lang = tmpl.lang;
  } else {
    if (template) {
      throw new Error(`Platform '${platform}' has no template variants. Drop the template parameter.`);
    }
    mainFilename = SIMPLE_STARTERS[platform].filename;
    lang = SIMPLE_STARTERS[platform].lang;
  }

  try {
    const entries = await fs.readdir(projPath);
    if (entries.length > 0 && !overwrite) {
      throw new Error(`destination '${projPath}' is not empty. Pass overwrite:true to write anyway.`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.mkdir(projPath, { recursive: true });

  const writtenFiles = [];
  const mainSrcPath = path.join(EXAMPLES_DIR, hasTemplates ? tmpl.main : mainFilename);
  const mainContents = await fs.readFile(mainSrcPath, "utf-8");
  await fs.writeFile(path.join(projPath, mainFilename), mainContents, "utf-8");
  writtenFiles.push(mainFilename);

  if (tmpl?.runtime) {
    for (const { src, dst } of tmpl.runtime) {
      // Detect binary archive files (.a, .o, .bin, .obj) — read as raw bytes,
      // not utf-8. SGDK's libmd.a is 2.6 MB of m68k object archive that
      // utf-8 would mangle on copy.
      const srcPath = path.join(PLATFORM_LIB_DIR, src);
      const isBinary = /\.(a|o|obj|bin|pic|pal|lib|xgc|xgm|vgm|brr)$/i.test(src);
      const contents = await fs.readFile(srcPath, isBinary ? null : "utf-8");
      await fs.writeFile(path.join(projPath, dst), contents);
      writtenFiles.push(dst);
    }
  }

  // R20 stage 3: runtimeDirs recursively copies a whole directory tree
  // (used by the SGDK Genesis template to ship the include/ header tree).
  if (tmpl?.runtimeDirs) {
    for (const { src, dst } of tmpl.runtimeDirs) {
      const srcDir = path.join(PLATFORM_LIB_DIR, src);
      const dstDir = path.join(projPath, dst);
      await copyDirRecursive(fs, path, srcDir, dstDir, writtenFiles, dst);
    }
  }

  // R58b: auto-vendor cc65 platform libsrc when present. Cheap blanket
  // policy — every cc65-using platform gets `vendor/cc65/libsrc/<p>/`
  // dropped into the project unless the template already wired it via
  // runtimeDirs. The TGI driver, joystick driver, conio, sound engine,
  // crt0 — all the things an agent would otherwise have to file a
  // feedback round to debug — now live in their project tree, greppable.
  // Lynx already wires this via LYNX_VENDOR_DIRS, so the skip-if-present
  // check below avoids double-copying for it.
  const cc65SrcDir = path.join(PLATFORM_LIB_DIR, "lib", "cc65-src");
  const cc65SrcDst = path.join(projPath, "vendor", "cc65", "libsrc", platform);
  try {
    await fs.stat(cc65SrcDir);  // throws if missing — fine, skip
    try {
      await fs.stat(cc65SrcDst); // already copied by an explicit runtimeDir? skip
    } catch {
      await copyDirRecursive(fs, path, cc65SrcDir, cc65SrcDst, writtenFiles, `vendor/cc65/libsrc/${platform}`);
    }
  } catch {
    /* no cc65-src for this platform — fine */
  }

  // R19b: extraSources are additional files from EXAMPLES_DIR (typically
  // sibling .asm/.s files that the template's main.c references — like a
  // data.asm providing tilfont/palfont symbols for the SNES C starter).
  // Distinct from `runtime` (which sources from PLATFORM_LIB_DIR).
  if (tmpl?.extraSources) {
    for (const { src, dst } of tmpl.extraSources) {
      const contents = await fs.readFile(path.join(EXAMPLES_DIR, src), "utf-8");
      await fs.writeFile(path.join(projPath, dst), contents, "utf-8");
      writtenFiles.push(dst);
    }
  }

  if (tmpl?.crt0) {
    const srcPath = tmpl.crt0.presetSrc.startsWith("presets/")
      ? path.join(CC65_PRESETS_DIR, tmpl.crt0.presetSrc)
      : path.join(PLATFORM_LIB_DIR, tmpl.crt0.presetSrc);
    const contents = await fs.readFile(srcPath, "utf-8");
    await fs.writeFile(path.join(projPath, tmpl.crt0.dst), contents, "utf-8");
    writtenFiles.push(tmpl.crt0.dst);
  }

  if (tmpl?.linkerConfig) {
    const srcPath = path.join(CC65_PRESETS_DIR, tmpl.linkerConfig.presetSrc);
    const contents = await fs.readFile(srcPath, "utf-8");
    await fs.writeFile(path.join(projPath, tmpl.linkerConfig.dst), contents, "utf-8");
    writtenFiles.push(tmpl.linkerConfig.dst);
  }

  // R22: ship MENTAL_MODEL.md + TROUBLESHOOTING.md from src/platforms/
  // <LIB_PLATFORM>/ into the project tree when they exist. Without this
  // copy, template comments like "see TROUBLESHOOTING.md" point at a
  // file the user can't find — they'd have to call getPlatformDoc.
  // Putting the files alongside the source makes the project a true
  // self-contained build (you can grep MENTAL_MODEL right next to main.c).
  for (const docFile of ["MENTAL_MODEL.md", "TROUBLESHOOTING.md"]) {
    const srcDocPath = path.join(PLATFORM_LIB_DIR, docFile);
    try {
      const docContents = await fs.readFile(srcDocPath, "utf-8");
      await fs.writeFile(path.join(projPath, docFile), docContents, "utf-8");
      writtenFiles.push(docFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      /* doc not shipped for this platform — skip */
    }
  }

  // README + .gitignore generation lives in the MCP handler for now;
  // both create* tools want the README content, so we duplicate the
  // small string-building bit here. To keep the diff tight we replicate
  // it; if we add a third caller we'll factor it out further.
  const romExt = pickRomExt(platform);
  const isCc65 = lang.startsWith("C (cc65)") || lang.startsWith("C (cc65 ");
  const isSdccSm83 = platform === "gb" || platform === "gbc";
  const isSdccZ80 = platform === "sms" || platform === "gg";

  const c89Note = (isCc65 || isSdccSm83 || isSdccZ80)
    ? `## ⚠️ ${isCc65 ? "cc65" : "SDCC"} is C89

Compiles **C89**, not C99/C11. Stick to:
- Declare loop variables at the top of blocks: \`uint8_t i; for (i = 0; ...) { ... }\`.
- All declarations at the top of every block — no mixed declarations + code.
- No designated initializers, no compound literals, no \`//\` line comments in some places.

`
    : "";
  const runtimeHeaders = (tmpl?.runtime ?? []).filter((r) => /\.h$/i.test(r.dst));
  const runtimeAsmIncludes = (tmpl?.runtime ?? []).filter((r) => /\.(s|asm)$/i.test(r.dst));

  let buildBlock;
  if (tmpl?.linkerConfig) {
    // NES (cc65 / chr-ram-runtime preset). Build dynamic sourcesPaths so
    // templates that ship extra .s files (e.g. music_demo with FamiTone2)
    // get them listed too.
    const runtimeNonHeaders = (tmpl?.runtime ?? [])
      .filter((r) => /\.(c|s|asm)$/i.test(r.dst));
    const srcLines = [
      `    "main.c":         "${mainFilename}",`,
      ...runtimeNonHeaders.map((r) => `    "${r.dst}":  "${r.dst}",`),
      `    "_preset_crt0.s": "${tmpl.crt0.dst}",`,
    ].join("\n");
    const incLines = runtimeHeaders.length > 0
      ? runtimeHeaders.map((h) => `    "${h.dst}":  "${h.dst}",`).join("\n")
      : "";
    buildBlock = "```js\nrunSource({\n  platform: \"" + platform + "\",\n  sourcesPaths: {\n" + srcLines + "\n  },\n" + (incLines ? "  includePaths: {\n" + incLines + "\n  },\n" : "") + "  linkerConfig: /* contents of " + tmpl.linkerConfig.dst + " */,\n  frames: 60,\n})\n```";
  } else if (isSdccSm83) {
    // GB / GBC (SDCC sm83). runSource BUILDS + RUNS + SCREENSHOTS in one
    // call AND auto-fixes the cartridge header (Nintendo logo, header +
    // global checksums, CGB flag on .gbc) — no manual patchGbHeader step.
    // Derive sources/includes from the template's runtime list so extra
    // .c files (e.g. music_demo's hUGEDriver) are listed too.
    const runtimeCs = (tmpl?.runtime ?? []).filter((r) => /\.c$/i.test(r.dst));
    const srcLines = [`    "main.c":       "${mainFilename}",`]
      .concat(runtimeCs.map((r) => `    "${r.dst}": "${r.dst}",`))
      .join("\n");
    const incLines = runtimeHeaders.length > 0
      ? runtimeHeaders.map((h) => `    "${h.dst}": "${h.dst}",`).join("\n")
      : "";
    buildBlock =
      "```js\nrunSource({\n" +
      "  platform: \"" + platform + "\",\n" +
      "  sourcesPaths: {\n" + srcLines + "\n  },\n" +
      (incLines ? "  includePaths: {\n" + incLines + "\n  },\n" : "") +
      "  crt0Path: \"gb_crt0.s\",\n" +
      "  codeLoc: 0x150,\n" +
      "  frames: 60,\n" +
      "})\n```\n\n" +
      "`runSource` auto-fixes the GB/GBC cartridge header (logo, checksums, " +
      "CGB flag) — you do **not** call `patchGbHeader` for a freshly built " +
      "ROM. Use `patchGbHeader` only to fix up an existing/external ROM on " +
      "disk or to override header fields (title, cart type, ROM/RAM size).";
  } else if (isSdccZ80) {
    const inc = runtimeHeaders.length > 0
      ? `\n  includePaths: { ${runtimeHeaders.map((h) => `"${h.dst}": "${h.dst}"`).join(", ")} },`
      : "";
    buildBlock = "```js\nrunSource({\n  platform: \"" + platform + "\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 60,\n})\n```";
  } else if (platform === "c64") {
    const inc = runtimeHeaders.length > 0
      ? `\n  includePaths: { ${runtimeHeaders.map((h) => `"${h.dst}": "${h.dst}"`).join(", ")} },`
      : "";
    buildBlock = "```js\nrunSource({\n  platform: \"c64\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 60,\n})\n```";
  } else if (platform === "snes" && /\.c$/i.test(mainFilename)) {
    // R19b: SNES C-mode template (PVSnesLib runtime auto-linked). Multi-file
    // build with sibling .asm providing data symbols (tilfont/palfont).
    //
    // SFX-enabled scaffolds (shmup/platformer/puzzle/etc.) also ship the
    // SPC700 driver via SNES_SFX_RUNTIME. Those files split across THREE
    // build args, and getting the split wrong is the documented footgun:
    //   - snes_sfx_data.asm → a SOURCE (it .incbin's the apu blob; the build
    //     fails with unresolved `apu_blob_end` if it's missing)
    //   - apu_blob.bin      → a BINARY include (the .incbin'd payload)
    //   - snes_sfx.h, snes_sfx.c → includePaths; main.c does
    //     `#include "snes_sfx.c"`, so it is NOT a separately compiled source.
    // The remaining SNES_SFX_RUNTIME files (spc_driver.asm, apu_blob.asm,
    // *.brr, sample_bank.bin) are rebuild-only — not needed for the build.
    const rt = tmpl?.runtime ?? [];
    const has = (dst) => rt.some((r) => r.dst === dst);
    const sfxSourceAsm = has("snes_sfx_data.asm") ? ["snes_sfx_data.asm"] : [];
    const sfxIncludes = rt
      .filter((r) => r.dst === "snes_sfx.h" || r.dst === "snes_sfx.c")
      .map((r) => r.dst);
    const sfxBinary = has("apu_blob.bin") ? ["apu_blob.bin"] : [];

    const sourceNames = [mainFilename]
      .concat((tmpl?.extraSources ?? []).map((e) => e.dst))
      .concat(sfxSourceAsm);
    const sourceLines = sourceNames
      .map((n) => `    "${n}": "${n}",`)
      .join("\n");
    const incLines = sfxIncludes
      .map((n) => `    "${n}": "${n}",`)
      .join("\n");
    const binLines = sfxBinary
      .map((n) => `    "${n}": "${n}",`)
      .join("\n");

    buildBlock =
      "```js\nrunSource({\n" +
      "  platform: \"snes\",\n" +
      "  language: \"c\",\n" +
      "  sourcesPaths: {\n" + sourceLines + "\n  },\n" +
      (incLines ? "  includePaths: {\n" + incLines + "\n  },\n" : "") +
      (binLines ? "  binaryIncludePaths: {\n" + binLines + "\n  },\n" : "") +
      "  frames: 120,\n" +
      "})\n```\n\n" +
      "PVSnesLib's runtime (crt0_snes, libm, libtcc, libc) is auto-linked. " +
      "`#include <snes.h>` works out of the box — consoleDrawText, setMode, " +
      "WaitForVBlank, etc." +
      (sfxSourceAsm.length
        ? " The SPC700 sound files are split across the three args above on " +
          "purpose: `snes_sfx_data.asm` is a SOURCE, `apu_blob.bin` is a " +
          "binary include, and `snes_sfx.{h,c}` are includes (main.c does " +
          "`#include \"snes_sfx.c\"`). Omit any one and the build fails."
        : "");
  } else if (platform === "snes" || platform === "genesis") {
    // R30: Genesis SGDK templates ship genesis_sfx.{h,c} as runtime helpers.
    // If the template's runtime list includes .c files, emit a multi-file
    // sourcesPaths block; otherwise stick with the single-source form.
    const runtimeCs = (tmpl?.runtime ?? []).filter((r) => /\.c$/i.test(r.dst));
    if (runtimeCs.length > 0 && /\.c$/i.test(mainFilename)) {
      const runtimeHs = (tmpl?.runtime ?? []).filter((r) => /\.h$/i.test(r.dst));
      const srcLines = [`    "${mainFilename}": "${mainFilename}",`]
        .concat(runtimeCs.map((r) => `    "${r.dst}": "${r.dst}",`))
        .join("\n");
      const incLine = runtimeHs.length > 0
        ? `\n  includePaths: {\n${runtimeHs.map((r) => `    "${r.dst}": "${r.dst}",`).join("\n")}\n  },`
        : "";
      buildBlock = "```js\nrunSource({\n  platform: \"" + platform + "\",\n  language: \"c\",\n  sourcesPaths: {\n" + srcLines + "\n  }," + incLine + "\n  frames: 60,\n})\n```";
    } else {
      const inc = runtimeAsmIncludes.length > 0
        ? `\n  includePaths: { ${runtimeAsmIncludes.map((r) => `"${r.dst}": "${r.dst}"`).join(", ")} },`
        : "";
      buildBlock = "```js\nrunSource({\n  platform: \"" + platform + "\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 60,\n})\n```";
    }
  } else if (platform === "gba") {
    // GBA libtonc / libgba runtimes ship gba_sfx.{h,c} as a tiny DMG-APU
    // wrapper. Surface multi-file build: main.c + any runtime .c, with
    // runtime .h files in includePaths.
    const runtimeCs = (tmpl?.runtime ?? []).filter((r) => /\.c$/i.test(r.dst));
    const runtimeHs = (tmpl?.runtime ?? []).filter((r) => /\.h$/i.test(r.dst));
    if (runtimeCs.length > 0) {
      const srcLines = [`    "${mainFilename}": "${mainFilename}",`]
        .concat(runtimeCs.map((r) => `    "${r.dst}": "${r.dst}",`))
        .join("\n");
      const incLine = runtimeHs.length > 0
        ? `\n  includePaths: {\n${runtimeHs.map((r) => `    "${r.dst}": "${r.dst}",`).join("\n")}\n  },`
        : "";
      buildBlock = "```js\nrunSource({\n  platform: \"gba\",\n  language: \"c\",\n  sourcesPaths: {\n" + srcLines + "\n  }," + incLine + "\n  frames: 60,\n})\n```";
    } else {
      buildBlock = "```js\nrunSource({ platform: \"gba\", language: \"c\", sourcePath: \"" + mainFilename + "\", frames: 60 })\n```";
    }
  } else {
    buildBlock = "```js\nrunSource({ platform: \"" + platform + "\", sourcePath: \"" + mainFilename + "\", frames: 60 })\n```";
  }

  let filesSection = `## Files\n\n- \`${mainFilename}\` — your game's entry point.\n`;
  if (tmpl?.runtime) {
    for (const { dst } of tmpl.runtime) {
      filesSection += `- \`${dst}\` — runtime helper. **You own this** — edit or replace at will.\n`;
    }
  }
  if (tmpl?.crt0) {
    filesSection += `- \`${tmpl.crt0.dst}\` — startup code (reset vector, NMI handler, hardware vectors). **You own this.**\n`;
  }
  if (tmpl?.linkerConfig) {
    filesSection += `- \`${tmpl.linkerConfig.dst}\` — ld65 linker config (memory layout, segment placement). **You own this.**\n`;
  }
  filesSection += `\nEvery byte that compiles into your ROM is in this directory. If you move the repo somewhere else, you don't need to install anything from romdev to rebuild it — the compiler binaries are the only external dependency.\n\n`;

  const readme = `# ${title ?? name}\n\nA ${lang} project for ${platform}, scaffolded by romdev.\n\n${tmpl?.describe ? tmpl.describe + "\n\n" : ""}${filesSection}${c89Note}## Build + run with romdev\n\n${buildBlock}\n\n## Iterating\n\n- Edit \`${mainFilename}\` (or any of the runtime / crt0 / cfg files — they're yours).\n- Call \`runSource\` to see your changes. It builds + loads + runs + screenshots in one round trip.\n- Inspect at byte level: \`readMemory\`, \`inspectSprites\`, \`inspectPalette\`, \`inspectBackgroundMap({render:true})\`.\n- Open a playtest window for human eyes: \`loadCategory({category:"show"}); playtest({});\` — returns immediately, the window follows your rebuilds, and the emulator stays live for every other tool.\n`;
  await fs.writeFile(path.join(projPath, "README.md"), readme, "utf-8");
  writtenFiles.push("README.md");

  const gitignore = `# Build outputs\n*${romExt}\n*.o\n*.rel\n*.ihx\n*.lst\n*.map\n*.sym\n*.dbg\n\n# Editor\n.vscode/\n.idea/\n*.swp\n.DS_Store\n`;
  await fs.writeFile(path.join(projPath, ".gitignore"), gitignore, "utf-8");
  writtenFiles.push(".gitignore");

  // withSnippets: drop every vetted starter snippet for the platform
  // into the project dir alongside main.c. Replaces "createProject +
  // call getAllStarterSnippets + paste 11 files" with one shot.
  // Snippets that overlap with files we've already written (the
  // runtime tmpl.runtime list typically includes them) are skipped.
  const snippetFiles = [];
  if (withSnippets) {
    const { listSnippetsForPlatform } = await import("./snippets.js").catch(() => ({}));
    // Inline minimal duplicate of listSnippetsForPlatform since snippets.js
    // doesn't export it. Keep this in sync with snippets.js.
    const LIB_DIR = path.join(PLATFORM_LIB_DIR, "lib");
    let entries = [];
    try { entries = await fs.readdir(LIB_DIR); } catch { /* no lib/ */ }
    const written = new Set(writtenFiles);
    /** @type {Array<{srcPath: string, dst: string, language: string}>} */
    const candidates = [];
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || entry === "README.md") continue;
      const entryPath = path.join(LIB_DIR, entry);
      let s;
      try { s = await fs.stat(entryPath); } catch { continue; }
      if (s.isDirectory()) {
        const sub = await fs.readdir(entryPath).catch(() => []);
        for (const f of sub.sort()) {
          if (f.startsWith(".") || f === "README.md") continue;
          candidates.push({ srcPath: path.join(entryPath, f), dst: f, language: entry });
        }
      } else {
        const ext = path.extname(entry).toLowerCase();
        const lang = (ext === ".c" || ext === ".h") ? "c" : "asm";
        candidates.push({ srcPath: entryPath, dst: entry, language: lang });
      }
    }
    // For platforms that have a `lang` like "C (SDCC z80)" filter to C
    // snippets; for asm-only platforms fall through and ship both.
    const wantsC = /\bC\b/i.test(lang);
    const wantsAsm = /\b(asm|sdcc|dasm)\b/i.test(lang);  // best-effort
    const filtered = candidates.filter((c) => {
      if (c.language === "c") return wantsC || !wantsAsm;
      if (c.language === "asm") return wantsAsm || !wantsC;
      return true;
    });
    for (const c of filtered) {
      if (written.has(c.dst)) continue;  // already written by tmpl.runtime
      // Binary detection — same heuristic as the runtime copy above.
      const isBinary = /\.(a|o|obj|bin|pic|pal|lib|xgc|xgm|vgm|brr)$/i.test(c.dst);
      const contents = await fs.readFile(c.srcPath, isBinary ? null : "utf-8");
      await fs.writeFile(path.join(projPath, c.dst), contents);
      writtenFiles.push(c.dst);
      snippetFiles.push(c.dst);
    }
  }

  return {
    path: projPath,
    platform,
    template: hasTemplates ? (template ?? "default") : null,
    files: writtenFiles,
    snippetsCopied: withSnippets ? snippetFiles : null,
    sourceFile: path.join(projPath, mainFilename),
    toolchain: lang,
    nextStep: `Edit ${path.join(projPath, mainFilename)} and call runSource with sourcesPaths/includePaths pointing at the project's files. Everything you need is in the directory — nothing is hidden.`,
  };
}

export function registerProjectTools(server, z) {
  server.tool(
    "createProject",
    "Use this to scaffold a new homebrew project directory: writes a starter main source + every runtime " +
    "file the template needs (headers, crt0, linker .cfg) + README + .gitignore. The result is " +
    "SELF-CONTAINED — every byte that compiles is in the dir, so it rebuilds with stock cc65/sdcc " +
    "elsewhere with nothing else. `template` defaults to the platform's smallest visible-and-runnable " +
    "program; most platforms also have hello_sprite/tile_engine + the genre templates (call listPlatforms " +
    "to see each platform's set). `withSnippets:true` also drops every vetted starter snippet alongside " +
    "main. (For a complete genre-shaped game baseline, prefer createGame.)",
    {
      platform: z.string().describe("Platform id: nes, c64, gb, gbc, sms, gg, atari2600, atari7800, lynx, snes, genesis, gba."),
      name: z.string().min(1).describe("Project name (used for output binary)."),
      path: z.string().describe("Absolute path where the project directory will be created."),
      title: z.string().optional().describe("Optional human-readable title shown in the README."),
      template: z.string().optional().describe("Template id. NES/GB/GBC: 'default' | 'hello_sprite' | 'tile_engine'. Other platforms with templates only have 'default' — omit this arg. Default is 'default'."),
      overwrite: z.boolean().default(false).describe("If true, allow writing into an existing non-empty directory."),
      withSnippets: z.boolean().default(false).describe("If true, also drop every vetted starter snippet for this platform into the project dir alongside main.c. Equivalent to calling copyStarterSnippets after createProject — saves a round trip when you want main.c + every helper without picking a genre template. Snippets that overlap with files the template's runtime already wrote are skipped."),
    },
    safeTool(async (args) => jsonContent(await createProjectImpl(args))),
  );

  // ── createGame — v2 genre-shaped scaffold ─────────────────────────
  // Thin wrapper over createProjectImpl that takes a `genre` instead of
  // a `template`. Each genre maps to a corresponding template under
  // examples/<platform>/ and ships a known-good complete game baseline:
  // main loop, NMI, OAM init, gameplay slot, music driver wiring. The
  // agent fills in gameplay-specific logic on top.
  //
  // R21: NES + GB/GBC + SNES + Genesis with three genres each (shmup,
  // platformer, puzzle). Per-platform extension follows demand. Recipes
  // for other platforms can be added by registering an entry in the
  // GENRE_MAP below and shipping matching template files under
  // examples/<platform>/templates/.
  server.tool(
    "createGame",
    "Scaffold a genre-shaped game project. Higher-level than createProject — " +
    "picks the right template + runtime + crt0 + linker config for the genre. " +
    "Available genres on every supported platform: 'shmup' (vertical shooter), " +
    "'platformer' (side-scrolling + gravity, except NES which is single-screen), " +
    "'puzzle' (match-3 falling blocks), " +
    "'sports' (Pong — two controllers wired where the hardware supports it, " +
    "player-vs-AI on GB/GBC), 'racing' (3-lane top-down lane-switch dodge). " +
    "Supported platforms: nes, gb, gbc, snes, genesis, sms, gg, c64, gba, lynx, atari7800. " +
    "Each scaffolds a complete working ROM you can build + run + screenshot " +
    "in one round trip — fill in gameplay-specific logic on top of the " +
    "known-good baseline.",
    {
      platform: z.string().describe("Platform id. Today: 'nes' | 'gb' | 'gbc' | 'snes' | 'genesis' | 'sms' | 'gg' | 'c64' | 'gba' | 'lynx' | 'atari7800'."),
      genre: z.string().describe("Genre id: 'shmup' | 'platformer' | 'puzzle' | 'sports' | 'racing' — all five available on every supported platform."),
      name: z.string().min(1).describe("Project name (used for output binary)."),
      path: z.string().describe("Absolute path where the project directory will be created."),
      title: z.string().optional().describe("Optional human-readable title shown in the README."),
      overwrite: z.boolean().default(false).describe("If true, allow writing into an existing non-empty directory."),
    },
    safeTool(async ({ platform, genre, name, path: projPath, title, overwrite }) => {
      // The five canonical genres. A genre is available on a platform iff
      // TEMPLATES[platform] has a matching template entry — we DERIVE
      // availability from TEMPLATES rather than maintain a parallel table,
      // so createGame can never drift out of sync with the registered
      // templates (R61: the old hardcoded GENRE_MAP did exactly that — it
      // omitted c64/gba/lynx even though their genre templates were registered).
      //
      // R23 + R23e note: GB / GBC have no native 2P hardware (no second
      // controller port; the link cable would need custom serial code),
      // so their `sports` template is player-vs-AI. Everywhere else port 1
      // is a real second pad with AI fallback when none is plugged in.
      const CANONICAL_GENRES = ["shmup", "platformer", "puzzle", "sports", "racing"];
      const platformTemplates = TEMPLATES[platform];
      // Platforms that ship genre scaffolds = those whose TEMPLATES entry
      // has at least one canonical genre key.
      const genrePlatforms = Object.keys(TEMPLATES).filter((p) =>
        CANONICAL_GENRES.some((g) => TEMPLATES[p] && TEMPLATES[p][g])
      );
      const availableGenres = platformTemplates
        ? CANONICAL_GENRES.filter((g) => platformTemplates[g])
        : [];
      if (availableGenres.length === 0) {
        throw new Error(
          `createGame: no genre scaffolds for platform '${platform}' yet. ` +
          `Supported platforms: ${genrePlatforms.join(", ") || "(none)"}. ` +
          `For other platforms, use createProject({platform, template:"default"}) and build up from there.`
        );
      }
      if (!availableGenres.includes(genre)) {
        throw new Error(
          `createGame: genre '${genre}' not supported for platform '${platform}'. ` +
          `Available genres: ${availableGenres.join(", ")}.`
        );
      }
      // Genre id IS the template id (they're 1:1 by construction).
      const templateId = genre;
      const result = await createProjectImpl({
        platform, template: templateId, name, path: projPath, title, overwrite,
      });
      return jsonContent({ ...result, genre, template: templateId });
    }),
  );

  server.tool(
    "patchGbHeader",
    "Use this to write a complete, valid GB/GBC cartridge header into a ROM: Nintendo boot logo, EVERY " +
    "header byte ($0134-$014C — title, CGB flag, cart type, ROM/RAM size, etc.) with ROM-only defaults, " +
    "plus the header + global checksums. SDCC-path equivalent of `rgbfix -v -p 0`. Fills ALL bytes " +
    "deliberately: leaving the CGB flag as the linker's $FF pad makes gambatte enter CGB mode and ignore " +
    "DMG palette writes → white screen. Also shipped as `patch-header.js` in every GB/GBC project for use " +
    "outside MCP.",
    {
      path: z.string().describe("Absolute path to the .gb / .gbc ROM file. Patched in place unless outputPath is given."),
      outputPath: z.string().optional().describe("If given, write the patched ROM here instead of overwriting."),
      cgb: z.boolean().optional().describe("If true, sets the CGB flag at $0143 to $80 (CGB-aware + DMG-compatible). If omitted, auto-detects from .gbc extension; default for plain .gb is false (DMG-only)."),
      title: z.string().optional().describe("Cartridge title, up to 11 chars at $0134..$013E. Uppercased + zero-padded. Default = zero-fill."),
      cartType: z.number().int().min(0).max(0xFF).optional().describe("Cart-type byte at $0147. Default $00 (ROM-only). Common alternatives: $01=MBC1, $03=MBC1+RAM+BAT, $11=MBC3, $13=MBC3+RAM+BAT, $19=MBC5."),
      romSize: z.number().int().min(0).max(0xFF).optional().describe("ROM-size byte at $0148. Default $00 (32 KB / 2 banks). 1=64KB, 2=128KB, 3=256KB, 4=512KB, 5=1MB, 6=2MB, 7=4MB."),
      ramSize: z.number().int().min(0).max(0xFF).optional().describe("RAM-size byte at $0149. Default $00 (none). $02=8KB, $03=32KB. Only meaningful with battery-backed MBC."),
      destination: z.number().int().min(0).max(0xFF).optional().describe("Destination at $014A. Default $01 (non-Japan). $00 = Japan."),
    },
    safeTool(async ({ path: inPath, outputPath, cgb, title, cartType, romSize, ramSize, destination }) => {
      const rom = new Uint8Array(await readFile(inPath));
      const cgbFlag = cgb ?? (/\.gbc$/i.test(inPath) || (outputPath && /\.gbc$/i.test(outputPath)));
      patchGbHeader(rom, { cgb: cgbFlag, title, cartType, romSize, ramSize, destination });
      const outPath = outputPath ?? inPath;
      await writeFile(outPath, rom);
      return jsonContent({
        path: outPath,
        bytes: rom.length,
        cgb: !!cgbFlag,
        patched: [
          "nintendo_logo@$0104..$0133",
          "title@$0134..$013E",
          `cgb_flag@$0143=${cgbFlag ? "$80" : "$00"}`,
          "licensee@$0144..$0145=$00$00",
          "sgb_flag@$0146=$00",
          `cart_type@$0147=$${(cartType ?? 0).toString(16).padStart(2, "0").toUpperCase()}`,
          `rom_size@$0148=$${(romSize ?? 0).toString(16).padStart(2, "0").toUpperCase()}`,
          `ram_size@$0149=$${(ramSize ?? 0).toString(16).padStart(2, "0").toUpperCase()}`,
          `destination@$014A=$${(destination ?? 1).toString(16).padStart(2, "0").toUpperCase()}`,
          "old_licensee@$014B=$33",
          "rom_version@$014C=$00",
          "header_checksum@$014D",
          "global_checksum@$014E..$014F",
        ],
      });
    }),
  );
}
