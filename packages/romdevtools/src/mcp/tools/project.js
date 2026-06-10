// createProject — write a starter project directory the agent can iterate on.
//
// Policy (2026-05-25): no auto-injection at build time. createProject copies
// every file the template depends on (runtime, headers, crt0, linker .cfg)
// into the project directory. The project is then self-contained — any
// `build({output:'run'})` call points at the project's own files via
// sources/sourcesPaths/includePaths/crt0/linkerConfig args. If you take
// the project elsewhere and rebuild with cc65/sdcc directly, every byte
// that compiles is in the directory.

import { jsonContent, safeTool } from "../util.js";
import { starterSnippetsCore, copyStarterSnippetsCore } from "./snippets.js";

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
      describe: "NOVA SENTRY — complete vertical shooter: title shell (1P/2P co-op select), shared-lives co-op, bullet/enemy pools, wave spawner, score + battery hi-score, music + SFX, sprite-0-hit split (fixed HUD over a drifting starfield).",
      players: "1-2 (simultaneous co-op)",
      sram: "battery hi-score at $6000 (hiscore_load/save; iNES battery bit in the crt0)",
      mechanics: ["projectile pools", "wave spawner", "AABB collision", "shared-lives co-op", "title/play/game-over state machine"],
      techniques: [
        "sprite-0-hit split scroll (fixed HUD over scrolling field)",
        "vblank-budget VRAM queue (asm drain in the crt0 NMI)",
        "battery SRAM hi-score (magic + checksum)",
        "CHR-RAM tile upload + 1bpp font",
      ],
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
      describe: "LEDGE LEAPER — side-scrolling platformer: gravity + Q4.4 sub-pixel jump physics, one-way platforms, pits and spikes, coins + distance scoring, battery hi-score. 2P is classic alternating turns (P2 on controller 2) with per-player score and lives. Sprite-0-hit split: fixed HUD over a seamlessly looping scrolling level.",
      players: "1-2 (alternating turns; P2 on controller 2)",
      sram: "battery hi-score (hiscore_load/save)",
      mechanics: ["gravity-jump physics (Q4.4 fixed point)", "one-way platform collision via column map", "horizontal scrolling with camera wall", "pits + spike hazards", "coin pickup + distance scoring", "alternating 2P turns with per-player lives"],
      techniques: [
        "sprite-0-hit split scroll (two-phase PPUSTATUS poll)",
        "dual-nametable seamless 256px level loop",
        "world-anchored sprite objects",
        "queued VRAM HUD updates",
        "battery SRAM hi-score",
      ],
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
      describe: "GEM DUEL — falling-gem match-3: 1P marathon with levels and cascade chains; 2P simultaneous split-board versus where chains send garbage rows to the opponent. Battery hi-score.",
      players: "1-2 (2P = simultaneous versus, split boards)",
      sram: "battery hi-score (hiscore_load/save)",
      mechanics: ["falling-piece control", "match-3 in 4 directions", "cascade chains with multipliers", "garbage attack rows", "soft drop + levels", "split-board versus"],
      techniques: [
        "vblank-budgeted board repaint (dirty-row bitmask, 1 row/frame)",
        "attribute-table palette regions (2-aligned wells)",
        "absolute-RAM arrays in the $0500 user scratch page",
        "battery SRAM hi-score",
        "stage-then-wait OAM order",
      ],
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
      describe: "COURT CLASH — head-to-head court game: 1P vs a beatable CPU or 2P simultaneous versus, first to 5, battery-backed best CPU win streak.",
      players: "1-2 (1P vs CPU / 2P simultaneous versus)",
      sram: "longest 1P win streak vs the CPU (hiscore_load/save)",
      mechanics: ["versus match flow (first-to-5, result screen)", "CPU opponent (speed-capped ball chase)", "2P simultaneous input (both ports)", "edge-hit ball deflection with random spin", "serve pause + alternating serve angle"],
      techniques: [
        "queued HUD text (text_draw_u16) during rendering",
        "PPU-off court/title paint (vram_unsafe_set/text_draw_unsafe)",
        "stage-then-wait OAM order with deterministic sprite slots",
        "xorshift16 PRNG to break deterministic-rally limit cycles",
        "battery PRG-RAM record via hiscore_save",
      ],
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
      describe: "THROTTLE FEUD — top-down vertically-scrolling road racer: scroll_y BG scroll with the wrap-at-240 idiom, streamed roadside scenery via queued tile writes, sprite-digit HUD. 1P: 4 lanes, A/B speed, best distance to battery SRAM. 2P: simultaneous split-lane versus (solid divider, first to 3 crashes loses).",
      players: "1-2 (2P = simultaneous versus, split lanes)",
      sram: "best 1P distance (uint16, 1 unit = 16 scrolled px; hiscore_load/save)",
      mechanics: ["lane steering", "speed control (1P)", "traffic dodging", "crash lives + invulnerability blink", "distance checkpoints", "split-lane versus"],
      techniques: [
        "vertical BG scroll with 240-wrap",
        "streaming-row scenery via queued tile writes",
        "sprite-based HUD (8-per-scanline budgeting)",
        "battery SRAM hi-score",
        "PPU-off full repaint screens",
        "xorshift16 PRNG",
      ],
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
      describe: "METEOR MILITIA — complete GB vertical shooter: press-start title shell with battery-persistent hi-score (MBC1+RAM+BATTERY declared in the crt0 header, $0A enable sequence, magic+checksum record, survives power cycles), and the GB signature — a WINDOW-layer fixed HUD (WX=7/WY=128, LCDC bit 5) over an SCY-scrolling starfield, no raster tricks. Wave spawner, AABB collisions, APU tune + SFX, divide-free painters (the sm83 has no divider). 1P by design: link-cable multiplayer can't be emulated single-instance (stated honestly in-file).",
      players: "1 (one controller; link cable unemulatable single-instance)",
      sram: "MBC1 cart RAM via the save_ram region (8KB) — crt0-declared battery cart, checksummed record, verified across hardReset",
      mechanics: ["projectile pools", "wave spawner", "AABB collision", "lives + respawn knockback", "battery-persistent hi-score", "title/play/game-over state machine"],
      techniques: [
        "window-layer fixed HUD (WX+7 quirk, bottom-strip placement)",
        "MBC1 $0A RAM-enable sequence",
        "shadow OAM + HRAM OAM-DMA stub",
        "one-item-per-vblank VRAM commit queue",
        "HALT-driven vblank wait",
        "divide-free pattern + decimal math",
      ],
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
      describe: "Match-3 falling-block puzzle scaffold for GB. 6×12 grid rendered via BG tilemap, 1×3 active piece (3 colours via 3 BG tile shapes), rotate via A, hard-drop on START, 3+-in-a-row clears in all 4 directions (H/V/diagonals) with gravity + cascade chains.",
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

  // ── PC Engine (cc65 HuC6280) — direct VDC/VCE/PSG helper lib + examples ──
  // The helper lib (pce_video.c/pce_input.c/pce_sound.c + pce_hw.h) is copied as
  // runtime; each template's main is a verified playable example.
  pce: (() => {
    const PCE_RUNTIME = [
      { src: "lib/c/pce_hw.h", dst: "pce_hw.h" },
      { src: "lib/c/pce_video.c", dst: "pce_video.c" },
      { src: "lib/c/pce_input.c", dst: "pce_input.c" },
      { src: "lib/c/pce_sound.c", dst: "pce_sound.c" },
    ];
    const mk = (name, describe) => ({ main: `${name}/main.c`, runtime: PCE_RUNTIME, lang: "C (cc65)", ext: ".pce", describe });
    return {
      default: mk("sprite_move", "Joypad-controlled 16x16 sprite over a solid background — the canonical PCE 'read pad + move a sprite' starter. Exercises the whole helper lib (VCE palette, VRAM upload, BAT fill, SATB + DMA, joypad). Same as the 'sprite_move' template."),
      sprite_move: mk("sprite_move", "Joypad-controlled 16x16 sprite over a tiled background. d-pad moves the sprite; verified visible + responsive. Build up an action game from here."),
      music_sfx: mk("music_sfx", "HuC6280 PSG demo: a looping melody plus a button-fired SFX. Shows psg_tone/psg_off across the PSG's wavetable channels."),
      catch_game: mk("catch_game", "A complete tiny game: a paddle catches a falling object with the d-pad; full game loop with waitvsync(), two sprites, collision, scoring."),
      shmup: {
        ...mk("shmup", "ZENITH BARRAGE — complete PCE vertical shooter: title shell with BRAM-persistent hi-score (bank $F7 TAM thunks + the $1807 write-unlock dance, survives power cycles), and the PCE signature — a 64x32 boss built from exactly TWO 32x32 SATB entries moving as one unit. Wave spawner, AABB collisions, 3-song PSG music + SFX, banded twinkling starfield. 1P by design: geargrafx ships TurboTap disabled, so port-2 input cannot reach the game (stated honestly in-file)."),
        players: "1 (stock PCE has one pad port; TurboTap exists in-core but disabled — future host core-option round)",
        sram: "BRAM bank $F7 via the save_ram region (2KB) — checksummed record, verified across hardReset",
        mechanics: ["projectile pools", "wave spawner", "AABB collision", "multi-sprite boss with HP/phases", "lives + mercy invulnerability", "BRAM-persistent hi-score", "title/play/game-over state machine"],
        techniques: [
          "HuC6270 large sprites (32x32 CGX/CGY, 4-aligned patterns)",
          "two-entry composite boss",
          "shadow SATB + R19 vblank DMA",
          "TAM bank-mapping thunks from C",
          "BRAM $1807 write-unlock",
          "BAT glyph font + partial HUD repaint",
          "PSG divider-table music",
        ],
      },
      platformer: mk("platformer", "Side-scrolling platformer for PC Engine. Gravity + jump + land-on-top platform collision, a multi-screen world streamed via BG X-scroll (BXR), solid platform tiles, sub-pixel physics. d-pad moves, button I jumps."),
      puzzle: mk("puzzle", "Match-3 / falling-block puzzle for PC Engine. A 6x12 well drawn with BG tiles, a 1x3 active piece you move/rotate/soft-drop/hard-drop, 3+-in-a-row clears (H+V) with gravity + cascade chains, score. d-pad moves, I rotates, II hard-drops."),
      sports: mk("sports", "Pong-style sports game for PC Engine. Two paddles + a bouncing ball on a netted court, score to 9, paddle-deflect physics; player 2 falls back to chase-AI when no input. d-pad moves P1."),
      racing: mk("racing", "Top-down lane racer for PC Engine. Player car at the bottom, obstacle cars spawn from the top and slide down, LEFT/RIGHT switches lanes, speed grows with score, crash freeze + auto-reset. Scrolling road BG."),
    };
  })(),

  // ── MSX (SDCC z80) — direct-port VDP/PSG helper lib + cart crt0 + examples ──
  msx: (() => {
    const MSX_RUNTIME = [
      { src: "lib/c/msx_hw.h", dst: "msx_hw.h" },
      { src: "lib/c/msx_vdp.c", dst: "msx_vdp.c" },
    ];
    const MSX_CRT0 = { presetSrc: "lib/c/msx_crt0.s", dst: "msx_crt0.s" };
    const mk = (name, describe) => ({ main: `${name}/main.c`, runtime: MSX_RUNTIME, crt0: MSX_CRT0, lang: "C (SDCC z80)", ext: ".rom", describe });
    return {
      default: mk("sprite_move", "Joystick-controlled sprite on a screen-2 background — the canonical MSX starter. NOTE: read joystick PORT 1 (port 0 is the keyboard). Same as 'sprite_move'."),
      sprite_move: mk("sprite_move", "Joystick-controlled sprite on a screen-2 background. d-pad moves the sprite; verified visible + responsive. The base for any action game."),
      music_sfx: mk("music_sfx", "AY-3-8910 PSG demo: a looping melody on channel A plus a trigger-fired SFX on channel C, with an on-screen indicator."),
      catch_game: mk("catch_game", "A complete tiny game: a paddle catches falling fruit with the joystick; full game loop with vblank sync, two sprites, collision, scoring."),
      shmup: {
        ...mk("shmup", "NEBULA WARDEN — complete MSX vertical shooter (screen 2): title shell with 1P/2P select and session hi-score, simultaneous 2-ship co-op (P2 = joystick port 2), shared-lives arcade scoring, PSG tune-table music + noise SFX, and the MSX signature — screen-2 per-row color (three independent color thirds: depth-banded starfield, HUD band, an 8-color gradient inside one tile). Hi-score is in-session only (the bundled bluemsx build exposes no SAVE_RAM — stated honestly in-file)."),
        players: "1-2 (simultaneous co-op)",
        sram: "none — core exposes no SAVE_RAM region (in-session hi-score; ASCII8-SRAM mapper exists in-core but unsurfaced; future core round)",
        mechanics: ["projectile pools", "wave spawner", "AABB collision", "2P simultaneous co-op (shared lives)", "session hi-score", "title/play/game-over state machine"],
        techniques: [
          "screen-2 per-row color (3 color thirds + per-8x1-row color bytes)",
          "single-tile 8-color gradient",
          "interrupt-free vsync via VDP S#0 poll",
          "sprite Y=208 terminator + offscreen parking",
          "AY-3-8910 noise SFX + per-frame tune-table music",
          "dual joystick ports via GTSTCK/GTTRIG",
        ],
      },
      platformer: mk("platformer", "Side-scrolling platformer for MSX (screen 2). Subpixel gravity/jump/land-on-top collision against a table of platforms across a 512-px (64-cell) world, drawn by COLUMN STREAMING into the wrapping screen-2 name table as the camera follows the player; the player sprite draws in screen space. Joystick LEFT/RIGHT walks, trigger A jumps (only when grounded); PSG jump blip. Interrupt-free vsync. Extend with enemies, pickups, goal."),
      puzzle: mk("puzzle", "Match-3 / falling-block puzzle for MSX (screen 2). A 6-wide x 12-tall well drawn with the BG tilemap (distinct R/G/B cell tiles + grey border + dim field interior so the playfield is always visible). A 1x3 active piece: joystick LEFT/RIGHT shifts, trigger A rotates the colour order, DOWN soft-drops, trigger B hard-drops; 3+-in-a-row clears in all 4 directions with gravity + cascade chains; PSG chime per clear. Interrupt-free vsync. Extend with levels/next-piece preview."),
      sports: mk("sports", "Pong-style 2-player sports for MSX (screen 2). Court (green field + white sidelines + dashed centre net) fills the 32x24 name table; two paddles (stacked sprites) + a ball. Player 1 = joystick PORT 1 UP/DOWN; Player 2 = joystick PORT 2 UP/DOWN, falling back to chase-the-ball AI when no second pad is present so it is playable solo. Wall/paddle bounces + scoring with PSG bonks. Interrupt-free vsync. Extend with serve angles, score display, win condition."),
      racing: mk("racing", "Top-down 3-lane racing for MSX (screen 2). Grey road + green-grass shoulders fill the name table; player car at the bottom, obstacle cars (object pool) spawn at the top and slide down. Joystick LEFT/RIGHT (edge-detected) switches lanes; obstacle speed grows with score; an AABB crash triggers a ~60-frame freeze then auto-reset, with a PSG crash tone. SCORE drawn as tiles. Interrupt-free vsync. Extend with pseudo-3D road, fuel, multiple cars."),
    };
  })(),
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
    describe: "Minimal GBC starter. Same shape as the GB default but ROM extension .gbc — the GB-header patch sets $0143=$80 so gambatte boots in CGB mode.",
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
    main: "templates/puzzle.c",
    runtime: [
      ...GBC_RUNTIME,
      { src: "lib/c/font.h", dst: "font.h" },  /* digits+A-Z 2bpp glyphs for the HUD */
    ],
    lang: GBC_LANG, ext: ".gbc",
    describe: "CHROMA WELL — falling-jewel matcher (the polished reference puzzle), to the full contract: 8x15 well, 6 jewel colors as 6 REAL CGB palettes (BCPS/BCPD + the VRAM bank-1 attribute map — true per-tile color, not colorized mono), 4-direction matches with gravity cascades + chain scoring, magic jewel every 18th piece, window-layer HUD strip, persistent battery hi-score (MBC1+RAM+BATTERY SRAM, magic+checksum, verified across power cycles), title/play/game-over shell, ch1 music + ch2 SFX. The locked well paints via the COLLECT/FLUSH vblank queue (writes outside vblank silently drop — never bypass it). Statics need dataLoc 0xC200 (the project recipe sets it).",
    players: "1 (handheld — link-cable 2P not emulatable single-instance)",
    sram: "MBC1+RAM+BATTERY, 8KB at $A000 ($0A-gated), verified across hardReset",
    mechanics: ["grid logic", "falling-piece matching", "gravity + cascade chains", "scoring/levels", "battery hi-score", "title/play/game-over state machine"],
    techniques: [
      "CGB palette RAM (BCPS/BCPD + OCPS/OCPD, mode-3 write constraint)",
      "VRAM bank-1 attribute map (VBK per-tile palettes)",
      "window-layer HUD",
      "vblank COLLECT/FLUSH queue + idle scrub",
      "OAM DMA HRAM stub",
      "battery SRAM save ($0A enable dance)",
    ],
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
  // The crt0 ships IN the project (like GG/MSX) so the dir is genuinely
  // self-contained: build({output:'project'}) routes it via the crt0 channel
  // (projectBuildRecipe), and an external stock-SDCC rebuild has the real
  // boot stub on disk instead of silently linking SDCC's non-booting one.
  { src: "lib/c/sms_crt0.s",      dst: "sms_crt0.s" },
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
    describe: "ASTRO PICKET — complete SMS vertical shooter: title shell with 1P/2P select and hi-score, simultaneous 2-ship co-op (P2 on port 1), PSG music + SFX, and the SMS signature LINE-INTERRUPT split (VDP register-10 line counter: fixed HUD strip over a scrolling starfield — the programmable cousin of the NES sprite-0 trick). Hi-score persists to Sega-mapper cart RAM on 64KB+ builds (verified); 32KB builds are honestly in-session.",
    players: "1-2 (simultaneous co-op)",
    sram: "Sega-mapper cart RAM at $8000 ($FFFC bit 3) on 64KB+ builds; in-session at 32KB (gpgx maps mapper RAM only above 48KB — documented in-file)",
    mechanics: ["projectile pools", "wave spawner", "AABB collision", "2P simultaneous co-op", "title/play/game-over state machine"],
    techniques: [
      "VDP line-interrupt split (fixed HUD over scrolling field)",
      "Sega-mapper cart RAM persistence ($FFFC control)",
      "PSG tune-table music + noise SFX",
      "SAT slot pre-allocation (no flicker)",
      "IM1 interrupt handshake (VDP status ack discipline)",
    ],
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
    describe: "PRISM PATROL — complete GG vertical shooter: press-START title shell with hi-score, PSG music + SFX, and the GG/SMS signature LINE-INTERRUPT split (fixed HUD over a scrolling starfield) taught against the GG's #1 footgun — the 160x144 window centered in the 256x192 frame (VIS_* offsets; line-counter values are FULL-frame scanlines, so the split lands at 47, not the SMS's 23). 12-bit CRAM palette shows the 4096 colors. Hi-score persists to Sega-mapper cart RAM on 64KB+ builds (verified incl. power-cycle); 32KB builds are honestly in-session.",
    players: "1 (one controller; Gear-to-Gear link 2P can't be emulated single-instance — honest note in-file)",
    sram: "Sega-mapper cart RAM at $8000 ($FFFC bit 3) on 64KB+ builds (verified across soft reset AND power-cycle); in-session at 32KB",
    mechanics: ["projectile pools", "wave spawner", "AABB collision", "title/play/game-over state machine", "persistent hi-score"],
    techniques: [
      "VDP line-interrupt split with GG-window scanline math",
      "GG 160x144 visible-window placement (VIS_* offset idiom)",
      "GG 12-bit CRAM palette (2-byte entries vs SMS 1-byte)",
      "Sega-mapper cart RAM persistence ($FFFC control)",
      "PSG note-table music + noise SFX",
      "IM1 handshake + DI/EI repaint bracket (line-IRQ ack races the VDP address latch)",
    ],
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
    describe: "ION SQUALL — complete horizontal shooter: title shell (port-2 fire = 1P, port-1 fire = 2P co-op), shared-lives co-op, bullet/enemy pools, score + session hi-score, 2-voice SID music with the signature filter sweep + voice-2 SFX, and the C64 signature raster-IRQ split (fixed score bar over a fine-scrolling starfield). Persistence is a gated seam: hiscore_load/save are honest no-ops until the planned VICE core round exposes a save path (documented in-file).",
    players: "1-2 (simultaneous co-op; P1 on joystick port 2, P2 on port 1)",
    sram: "none yet — the VICE core build exposes no SAVE_RAM and no 1541 write-back; hiscore_load/save ship as honest no-op seams for the planned core round",
    mechanics: ["projectile pools", "altitude-seeking enemy spawner", "AABB collision", "shared-lives co-op", "title/play/game-over state machine"],
    techniques: [
      "raster-IRQ split (mid-frame $D016 rewrite: fixed bar over scrolling field)",
      "dual joystick-port reads with keyboard-conflict awareness ($DC00/$DC01)",
      "9th-X-bit sprite staging ($D010 batch commit)",
      "SID filter sweep (11-bit cutoff LFO; shared volume/mode register)",
      "beam-racing coarse scroll scheduled off the bottom IRQ",
      "transition repaints budgeted to text bands (full 880-cell paints freeze ~50 frames)",
    ],
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
    describe: "Match-3 falling-block puzzle for SNES. 6×12 grid (text mode), rotate/soft-drop/hard-drop, 3+-in-a-row clears in all 4 directions with gravity + cascade chains. Rotate click + clear chime via bundled SPC700 sfx.",
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
// All SGDK Genesis C templates share the same runtime bundle: crt0 (sega.s +
// cpp-expanded sega.preprocessed.s for the bare WASM `as`), linker script, ROM
// header source, MIT license, and the full include tree. SGDK itself is
// compiled from source by the build (its source is vendored via
// SGDK_RUNTIME_DIRS) — no prebuilt libmd.a is copied in.
const SGDK_RUNTIME = [
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
  // JOY_readJoypad / XGM2_play actually do. SGDK is compiled FROM this
  // source by the build (no prebuilt libmd.a).
  { src: "lib/sgdk/src", dst: "vendor/sgdk/src" },
  // res/: the generated libres (default font/logo) + its source (.res + PNGs)
  // and the regen recipe — so the resource blobs are reproducible, not opaque.
  { src: "lib/sgdk/res", dst: "vendor/sgdk/res" },
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
    describe: "CINDER SPRINT — complete side-scrolling platformer: title/1P/2P-alternating-turns shell, coins + distance scoring, SRAM hi-score, PSG music + SFX, and the Genesis signature dual-plane parallax (HSCROLL_TILE strip bands: plane A 1:1, plane B sky 1/8 + mountains 1/2) under a hardware-fixed WINDOW-plane HUD. Endless 512-px looping world, zero per-frame tilemap writes.",
    players: "1-2 (alternating turns; P2 on controller 2)",
    sram: "header-declared cartridge SRAM at $200000 odd bytes (hi-score magic+checksum record)",
    mechanics: ["scrolling camera", "gravity + one-way platform collision", "coin pickups + hazards", "distance scoring", "2P alternating turns", "SRAM hi-score save"],
    techniques: [
      "dual-plane parallax (HSCROLL_TILE strip bands)",
      "window-plane fixed HUD",
      "cartridge SRAM via the $A130F1 mapper gate",
      "DMA_QUEUE vblank batching",
      "SAT link-chain sprites (VDP_linkSprites)",
      "seamless 512-px plane-wrap camera",
    ],
  },
  two_plane_parallax: {
    main: "templates/two_plane_parallax.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Two-plane parallax SCROLLING scaffold — the smooth-feel starting point for a Uridium/Sonic-style side-scroller. Plane A = a painted foreground world (ground + platform blocks), Plane B = a repeated starfield, one player sprite. The frame loop does HARDWARE SCROLL ONLY (two VDP_setHorizontalScroll writes + one VDP_updateSprites) — ZERO tilemap writes per frame, which is what keeps movement smooth (rewriting a plane each frame is the #1 'choppy horizontal movement' bug). Plane B scrolls at 1/4 speed for depth. Exposes volatile g_player_x / g_cam_x so you can motion-trace it headlessly (symbols->memory->recordSession). Extend by streaming one offscreen column per 8-px camera step for worlds wider than 512 px — see Genesis MENTAL_MODEL.md 'Scrolling, parallax & the feel trap'.",
  },
  puzzle: {
    main: "templates/puzzle.c",
    runtime: SGDK_RUNTIME,
    runtimeDirs: SGDK_RUNTIME_DIRS,
    lang: SGDK_LANG,
    ext: ".bin",
    describe: "Match-3 falling-block puzzle genre scaffold. 6×12 grid, 1×3 active piece (3 colours), rotate via A, soft-drop on DOWN, hard-drop on START, 3+-in-a-row clears in all 4 directions with gravity + cascade chains. xorshift RNG so cell colours actually vary.",
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
    describe: "VOID PLUNGE — complete Lynx depth-dive shooter: title shell with attract demo, in-session hi-score, and the Lynx signature — Suzy HARDWARE sprite scaling: divers grow 2px to 20px as they approach (HSIZE/VSIZE recomputed per frame from depth, hitbox tracking the hardware scale, far kills pay more). MIKEY 4-voice music + SFX. Honest 1P (ComLynx needs a second Lynx); honest no-save (handy's libretro build exposes no SAVE_RAM — probed; cart 93Cxx EEPROM is the real-hardware path, future core round).",
    players: "1 (handheld — ComLynx multiplayer needs a second physical Lynx)",
    sram: "none — probe: regionSize(save_ram)=0, retro_get_memory(SAVE_RAM)=NULL; cart EEPROM named in-file as the real path (future core round)",
    mechanics: ["depth-corridor enemy dives (screen-Y as depth)", "scaled collision boxes (hitbox = hardware sprite size)", "range-weighted scoring", "projectile pool", "level ramp", "title/play/game-over state machine", "attract-mode demo"],
    techniques: [
      "Suzy hardware sprite scaling (SCB HSIZE/VSIZE 8.8, per-frame rescale)",
      "raw SCB authoring (literal 4bpp data, penpal remap) via tgi_ioctl(0)",
      "canonical TGI full-redraw loop (tgi_busy wait → draw → updatedisplay)",
      "vblank-deferred MIKEY voice writes",
    ],
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
    describe: "Idiomatic Tonc-tutorial GBA C starter. #include <tonc.h>, TTE (Tonc Text Engine) draws 'Hello, Tonc!' on BG0 in MODE_0. Matches what every published GBA C tutorial at gbadev.net teaches. libtonc is compiled from its vendored source by the build (a fast prebuilt seed by default; pass rebuildSdk:true if you edit the SDK source) — the project gets the headers + gba_crt0 + linker script. Build with build({output:'run', platform:'gba', language:'c'}) — defaults to runtime:'libtonc'.",
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
    describe: "GYRE GUNNER — vertical shooter built around the GBA's affine hardware: a rotating, zoom-pulsing vortex backdrop (affine BG2, Mode 1, the 8.8 matrix + reference-point pivot taught register-by-register) and a spinning, scale-pulsing 32x32 boss (OAM affine slot 0, double-size flag). Waves gate the boss fight; hi-score persists in cartridge SRAM ('SRAM_V' marker, byte-wide bus discipline), verified across power cycles. 1P (handheld — link-cable 2P not emulatable single-instance).",
    players: "1 (handheld; link-cable 2P not emulatable single-instance)",
    sram: "cartridge SRAM at 0x0E000000 ('SRAM_V' ROM marker for save-type detection; magic+checksum record), verified across hardReset",
    mechanics: ["projectile pools", "wave spawner", "AABB collision", "affine boss with HP + sine strafe + minions", "SRAM-persistent hi-score", "title/play/game-over state machine"],
    techniques: [
      "affine background (BG2PA-PD 8.8 matrix + BG2X/Y centered pivot, Mode 1)",
      "affine sprite (OAM affine slots, double-size flag)",
      "8bpp BG tiles + 1-byte affine map via VRAM-safe staging",
      "TTE palbank-15 coexistence (8bpp palette footgun)",
      "PSG music loop + SFX channel discipline",
      "lu_sin/lu_cos fixed-point math",
    ],
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
    describe: "Alternate GBA C starter using devkitPro's libgba SDK. MODE_3 framebuffer + red pixel. Pass runtime:'libgba' to build({output:'run'}) — or just use the Tonc path (gba_hello_tonc) which is better aligned with what published tutorials teach.",
  },
  // R34: maxmod music demo. Ships a hand-authored CC0 chiptune.xm +
  // its pre-built soundbank.bin. build({output:'run'}) must be called with
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
    describe: "Maxmod music demo (Tonc + libmm). Plays a CC0 chiptune.xm soundbank via mmInitDefault + mmStart + mmFrame, with START toggling pause. Pass `maxmod:true` AND `binaryIncludes:{\"soundbank.bin\": <bytes>}` to build({output:'run'}). The .xm source + generator script + pre-built soundbank.bin all ship in the project — edit and re-run mmutil to swap the tune.",
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
  // ── Genre scaffolds ───────────────────────────────────────────────
  // The 2600 maps cleanly onto only SOME of the five canonical genres.
  // shmup + sports are the console's native idioms (Space Invaders /
  // Pong); racing (top-down) and platformer (single-screen) are honest,
  // period-correct fits. puzzle (match-3) is deliberately ABSENT — see
  // the note after this block: a 6x12 multi-colour grid is not
  // renderable on a tilemap-less, one-COLUPF-per-line, 2-player TIA, so
  // shipping a "puzzle" key would mean shipping something that isn't a
  // recognizable match-3. Genre id == template key (createGame maps 1:1).
  shmup: {
    main: "templates/shmup.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "SHMUP — the 2600's flagship genre (Space Invaders / Galaxian / Demon Attack). Gallery shooter done with the RIGHT TIA objects: P0 = double-width cannon, P1 + NUSIZ1=%011 = a row of THREE hardware-replicated invaders (one GRP1 write draws all three), M0 = the player shot. Aliens march left/right and drop a step at the edges; fire with the joystick button. Same proven body as the `mini_invaders` template. Extend with M1 as an alien bomb or reuse P1 lower for shields.",
  },
  sports: {
    main: "templates/sports.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "RAPID RALLY — complete 2600 head-to-head paddle game: drawn title screen, 1P vs AI or 2P versus (port-1 stick drives the right paddle), rally counter, TIA SFX + title jingle, auto-return to title, IN-SESSION hi-score (no battery on real 2600 hardware — stated honestly in-source). Teaches the machine itself: 2-line kernel, RESP positioning, SWCHA re-read discipline, score-mode dual color.",
    players: "1-2 (1P vs AI / 2P simultaneous versus)",
    sram: "none — the 2600 has no persistent storage on real hardware; hi-score is in-session only",
    mechanics: ["paddle versus (1P AI / 2P)", "rally counter", "score-to-limit match flow", "auto title return", "session hi-score"],
    techniques: [
      "2-line kernel (racing the beam)",
      "RESP0/RESP1/RESBL coarse+HMxx fine positioning",
      "SWCHA per-check re-read (both sticks, one register)",
      "score-mode dual-color HUD",
      "TIA sound effects + title jingle",
    ],
  },
  racing: {
    main: "templates/racing.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "RACING — top-down vertical-scroll lane racer, the honest 2600 racing idiom (Enduro-style; pseudo-3D road projection needs a per-line table the 4 KB/76-cycle starter budget can't spare). P0 = your car near the bottom (LEFT/RIGHT to weave), reflected playfield draws the two road rails + a dashed centre line that scrolls upward to convey speed, P1 + M0 = descending traffic/hazards you must dodge. Speed (and score) ramps the longer you survive; a TIA-collision crash flashes the screen red and resets your speed. Extend with M1 as a 3rd hazard or NUSIZ1 for two-abreast traffic.",
  },
  platformer: {
    main: "templates/platformer.asm",
    runtime: [],
    lang: "6507 assembly (dasm)",
    ext: ".a26",
    describe: "PLATFORMER — SINGLE-SCREEN (Pitfall! / Montezuma / Kangaroo idiom). The 2600 has NO hardware scroll, no tilemap, 128 B RAM — a smooth side-scroller is not the honest fit (real games flip whole screens). This ships the genre CORE: fixed-point gravity + a jump arc (FIRE button), and land-on-top collision tested in CODE (not TIA collision, since you must know WHICH surface to stand on) against a 4-entry platform table drawn as horizontal playfield bars (the only TIA object wide enough to be a platform). Joystick walks L/R. Extend with ladders (UP/DOWN over a ladder x-span), an enemy on P1, a thrown rock on M0, or Pitfall-style screen-flipping at the edges. NOT a scroller — single screen by design.",
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
    describe: "COMET FLURRY — dense-field meteor shooter built on MARIA's signature object quantity: 24 meteors + 2 ships + 4 shots = 30 independent display-list objects, beyond what the 2600 or stock NES can draw. 1P and 2P simultaneous co-op (shared life pool), score-scaled difficulty, two-voice TIA music with SFX voice-stealing, session hi-score (honest: the bundled prosystem core has no High Score Cart support — comments wire the real HSC path for a future core round).",
    players: "1-2 (simultaneous co-op; port-1 fire starts it)",
    sram: "none — 7800 persistence is the High Score Cart, unimplemented in the bundled core (SAVE_RAM size 0); in-session hi-score with the HSC path documented",
    mechanics: ["dense-swarm dodging", "twin-ship co-op (shared life pool)", "shot/meteor scoring (fast rocks pay more)", "score-scaled difficulty", "spawn-shield shimmer invulnerability", "session hi-score"],
    techniques: [
      "per-scanline display-list pool (120 one-line zones, 3-objects-per-line DMA budget)",
      "DLL zone repointing under DMA-off for state transitions",
      "RAM-canvas text via wide DL entries (no text mode)",
      "#pragma optimize(on) as the cc65 frame budget",
      "two-voice TIA music with SFX voice arbitration",
      "SWCHA nibble-order input idiom",
    ],
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
      // Skip romdev-internal SDK build-cache artifacts — the .seed.a/.seed.hash
      // are how romdev's OWN build avoids recompiling the SDK; a user project
      // never builds the SDK itself, so shipping the prebuilt blob into the
      // project tree is just noise (and contradicts "everything here is source").
      if (/\.seed\.(a|hash)$/i.test(ent.name)) continue;
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
export async function createProjectImpl({ platform, name, path: projPath, title, template, overwrite = false, withSnippets = false, verbose = false }) {
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
    // No template given → prefer a "default" entry, else fall back to the FIRST
    // template the platform defines (e.g. GBA's first entry is `tonc_hello`, not
    // `default`). Only error when an explicit, unknown template was requested.
    const available = Object.keys(TEMPLATES[platform]);
    const tname = template ?? (TEMPLATES[platform].default ? "default" : available[0]);
    tmpl = TEMPLATES[platform][tname];
    if (!tmpl) {
      throw new Error(`Unknown template '${tname}' for platform '${platform}'. Available: ${available.join(", ")}`);
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
    buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"" + platform + "\",\n  sourcesPaths: {\n" + srcLines + "\n  },\n" + (incLines ? "  includePaths: {\n" + incLines + "\n  },\n" : "") + "  linkerConfig: /* contents of " + tmpl.linkerConfig.dst + " */,\n  frames: 240,\n})\n```";
  } else if (isSdccSm83) {
    // GB / GBC (SDCC sm83). build({output:'run'}) BUILDS + RUNS + SCREENSHOTS
    // in one call AND auto-fixes the cartridge header (Nintendo logo, header +
    // global checksums, CGB flag on .gbc) — no manual header-patch step.
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
      "```js\nbuild({\n  output: \"run\",\n" +
      "  platform: \"" + platform + "\",\n" +
      "  sourcesPaths: {\n" + srcLines + "\n  },\n" +
      (incLines ? "  includePaths: {\n" + incLines + "\n  },\n" : "") +
      "  crt0Path: \"gb_crt0.s\",\n" +
      "  codeLoc: 0x150,\n" +
      "  frames: 60,\n" +
      "})\n```\n\n" +
      "`build({output:\"run\"})` auto-fixes the GB/GBC cartridge header (logo, checksums, " +
      "CGB flag) — you do **not** call a header patch for a freshly built " +
      "ROM. Use `romPatch({op:'gbHeader'})` only to fix up an existing/external " +
      "ROM on disk or to override header fields (title, cart type, ROM/RAM size).";
  } else if (isSdccZ80) {
    const inc = runtimeHeaders.length > 0
      ? `\n  includePaths: { ${runtimeHeaders.map((h) => `"${h.dst}": "${h.dst}"`).join(", ")} },`
      : "";
    buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"" + platform + "\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 240,\n})\n```";
  } else if (platform === "c64") {
    const inc = runtimeHeaders.length > 0
      ? `\n  includePaths: { ${runtimeHeaders.map((h) => `"${h.dst}": "${h.dst}"`).join(", ")} },`
      : "";
    buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"c64\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 240,\n})\n```";
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
      "```js\nbuild({\n  output: \"run\",\n" +
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
    //
    // BUT: some runtime .c files are compiled by the build pipeline itself,
    // NOT as user sources — listing them in sourcesPaths duplicates a symbol
    // and FAILS the link. The classic one is SGDK's `rom_header.c`: the
    // Genesis build assembles the ROM header as boot glue (Stage D) and the
    // SGDK runtime archive intentionally excludes it, so a snippet that lists
    // rom_header.c collides with that and the link dies on a duplicate header.
    // Exclude such build-internal files from the documented build command.
    const BUILD_INTERNAL_CS = new Set(["rom_header.c"]);
    const runtimeCs = (tmpl?.runtime ?? [])
      .filter((r) => /\.c$/i.test(r.dst))
      .filter((r) => !BUILD_INTERNAL_CS.has(r.dst));
    if (runtimeCs.length > 0 && /\.c$/i.test(mainFilename)) {
      const runtimeHs = (tmpl?.runtime ?? []).filter((r) => /\.h$/i.test(r.dst));
      const srcLines = [`    "${mainFilename}": "${mainFilename}",`]
        .concat(runtimeCs.map((r) => `    "${r.dst}": "${r.dst}",`))
        .join("\n");
      const incLine = runtimeHs.length > 0
        ? `\n  includePaths: {\n${runtimeHs.map((r) => `    "${r.dst}": "${r.dst}",`).join("\n")}\n  },`
        : "";
      buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"" + platform + "\",\n  language: \"c\",\n  sourcesPaths: {\n" + srcLines + "\n  }," + incLine + "\n  frames: 240,\n})\n```";
    } else {
      const inc = runtimeAsmIncludes.length > 0
        ? `\n  includePaths: { ${runtimeAsmIncludes.map((r) => `"${r.dst}": "${r.dst}"`).join(", ")} },`
        : "";
      buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"" + platform + "\",\n  sourcePath: \"" + mainFilename + "\"," + inc + "\n  frames: 240,\n})\n```";
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
      buildBlock = "```js\nbuild({\n  output: \"run\",\n  platform: \"gba\",\n  language: \"c\",\n  sourcesPaths: {\n" + srcLines + "\n  }," + incLine + "\n  frames: 240,\n})\n```";
    } else {
      buildBlock = "```js\nbuild({ output: \"run\", platform: \"gba\", language: \"c\", sourcePath: \"" + mainFilename + "\", frames: 240 })\n```";
    }
  } else {
    buildBlock = "```js\nbuild({ output: \"run\", platform: \"" + platform + "\", sourcePath: \"" + mainFilename + "\", frames: 240 })\n```";
  }

  let filesSection = `- \`${mainFilename}\` — the game. Title screen, game loop, all the GAME LOGIC clay.\n`;
  if (tmpl?.runtime) {
    for (const { dst } of tmpl.runtime) {
      if (dst === "patch-header.js") {
        // NOT game code — calling it a "runtime helper" implied it compiles
        // into the ROM and confused readers. It's a standalone sidecar tool.
        filesSection += `- \`${dst}\` — sidecar TOOL, not game code (never compiled into the ROM). ` +
          `Stamps the Nintendo logo + header/global checksums a GB ROM needs to boot ` +
          `(\`node patch-header.js game.gb\`) — a zero-install stand-in for RGBDS's rgbfix when you ` +
          `rebuild OUTSIDE romdev with stock SDCC. romdev's own builds fix the header automatically.\n`;
      } else if (dst.endsWith("_crt0.s")) {
        filesSection += `- \`${dst}\` — startup assembly (reset/interrupt vectors, RAM init; routed as the crt0 by the project build). **Load-bearing**: replacing a bundled crt0 once black-screened every project on a platform for a month. Edit with the platform TROUBLESHOOTING doc open.\n`;
      } else {
        filesSection += `- \`${dst}\` — runtime library (rendering/input/sound helpers the game calls). Yours to extend; the HARDWARE IDIOM markers inside say which parts are load-bearing.\n`;
      }
    }
  }
  if (tmpl?.crt0) {
    filesSection += `- \`${tmpl.crt0.dst}\` — startup code (reset vector, NMI handler, hardware vectors). **You own this.**\n`;
  }
  if (tmpl?.linkerConfig) {
    filesSection += `- \`${tmpl.linkerConfig.dst}\` — ld65 linker config (memory layout, segment placement). **You own this.**\n`;
  }
  filesSection += `\nEvery byte that compiles into your ROM is in this directory. If you move the repo somewhere else, you don't need to install anything from romdev to rebuild it — the compiler binaries are the only external dependency.\n\n`;

  // Lead with the project-dir build — ONE call, no manifest. The verbose
  // output:'run' + sourcesPaths form (buildBlock) is the "editing loose
  // source" variant, shown second.
  const projectBuildBlock =
    "```js\nbuild({\n  output: \"project\",\n  platform: \"" + platform + "\",\n  path: \"" + projPath + "\",\n  outputPath: \"" + name + romExt + "\",\n})\n```";
  const readme = `# ${title ?? name}

**A complete, working ${platform} game** (${lang}) — forked from the romdev \`${platform}/${template ?? "default"}\` example. It builds, runs, and renders RIGHT NOW, before you change a line.

${tmpl?.describe ? tmpl.describe + "\n\n" : ""}## How to make it yours

Modify ONE thing at a time and re-run the build after each change — the working game is your regression oracle (it rendered before your edit; if it stops, your last edit broke it):

${projectBuildBlock}

Use \`output:"run"\` to build + load + run + screenshot in one round trip. Don't start over in a blank file — retro bring-up is a chain of fragile hardware init with no partial credit; evolve this game instead, even into a very different game.

## Marker legend (read before restructuring anything)

- \`/* ── HARDWARE IDIOM (load-bearing) ── */\` — this code dodges a documented hardware footgun (the comment says which). **Reshape your gameplay around these regions**; if you must change one, read the cited TROUBLESHOOTING entry first. Each block's header lists what it needs (interrupt hooks, memory regions, register modes) — that's also what a transplant into another game must satisfy.
- \`/* ── GAME LOGIC (clay) ── */\` — enemy patterns, scoring, art, tuning. **Reshape freely** — this is where your game happens.

Need a technique this game doesn't have (another example does)? \`examples({op:"show", example:"<platform>/<name>", technique:"..."})\` extracts that example's marked block with its dependency header — graft it here instead of rewriting it.

## Files

${filesSection}${c89Note}<details>
<summary>Alternative: build from a hand-specified source manifest (when compiling edited loose source, not a project dir)</summary>

${buildBlock}
</details>

## Inspecting + playtesting

- Byte level: \`memory({op:"read"})\`, \`sprites({op:"inspect"})\`, \`palette({source:"live"})\`, \`background({view:"rendered"})\`.
- No-vision render health: \`frame({op:"verify"})\` — "is the game actually rendering?" in one call.
- Human eyes: \`playtest({op:"open"})\` — a live window that follows your rebuilds; the emulator stays available to every other tool.
`;
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

  // Split the manifest: project-OWNED files (main.c, runtime helpers, crt0,
  // cfg, README…) are the only ones an agent touches; the rest are internal
  // toolchain copies on disk that never enter a decision. Echoing all of
  // them — 35/44 on NES (vendor/cc65/libsrc/*), 173/264 on GBA (libtonc
  // include/+sysinclude/), ~270 on SGDK Genesis — was pure context noise
  // across a matrix run. Default to a compact receipt (owned list + a
  // not-owned COUNT); `verbose:true` restores the full flat list.
  //
  // Classify NON-owned by what it actually is, NOT just a `vendor/` prefix:
  // the cc65 path lands under vendor/, but the GBA/Genesis SDKs drop their
  // header trees at include/ + sysinclude/ (no vendor/ prefix) and prebuilt
  // crt objects/archives at the root — none of which an agent edits. (R: the
  // original `!startsWith('vendor/')` denylist missed exactly these two SDK
  // platforms — same bug class as the original fix, second location.)
  const isVendored = (f) =>
    f.startsWith("vendor/") ||                    // cc65 libsrc, pvsneslib, sgdk src
    f.startsWith("include/") ||                   // SDK header trees (libtonc/libgba/SGDK/maxmod)
    f.startsWith("sysinclude/") ||                // libgba/libtonc system headers
    /^crt[a-z0-9]*\.o$/i.test(f) ||               // prebuilt crt objects (crti/crtn/crtbegin/crtend)
    /\.(a|lib)$/i.test(f);                         // prebuilt static archives
  const ownedFiles = writtenFiles.filter((f) => !isVendored(f));
  const vendorFileCount = writtenFiles.length - ownedFiles.length;
  return {
    path: projPath,
    platform,
    template: hasTemplates ? (template ?? "default") : null,
    // The files you actually edit. Vendored toolchain copies are summarized,
    // not listed — they're on disk under vendor/ if you ever need them.
    files: ownedFiles,
    fileCount: writtenFiles.length,
    vendorFileCount,
    ...(verbose ? { allFiles: writtenFiles } : {}),
    snippetsCopied: withSnippets ? snippetFiles : null,
    sourceFile: path.join(projPath, mainFilename),
    toolchain: lang,
    nextStep: `Build the scaffold AS-IS in one call: build({output:"project", platform:"${platform}", path:"${projPath}", outputPath:"<game>.<ext>"}) — it infers the toolchain/crt0/linker from the directory, no sourcesPaths/includePaths/linkerConfig needed. Then edit ${mainFilename} and re-run the same call. (build({output:"run", ...}) with a hand-specified sourcesPaths manifest is the alternative when you're compiling edited loose source instead of a project dir.)`,
  };
}

async function createGameCore({ platform, genre, name, path: projPath, title, overwrite, verbose = false }) {
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
        // Reached only by a platform that ships NO canonical genre yet (every
        // tier-1 platform now ships at least one — atari2600 ships 4, the rest
        // ship all 5 — so in practice this is the bring-up / non-genre tier).
        // List that platform's real project templates so the agent has a
        // concrete next step instead of a bare "default".
        const projTemplates = platformTemplates ? Object.keys(platformTemplates) : [];
        const hint = projTemplates.length ? projTemplates.join(", ") : null;
        throw new Error(
          `createGame: no genre scaffolds for platform '${platform}' yet. ` +
          `Supported platforms: ${genrePlatforms.join(", ") || "(none)"}. ` +
          (hint
            ? `For ${platform}, use createProject({platform:"${platform}", template:"..."}) with one of: ${hint}.`
            : `For other platforms, use createProject({platform, template:"default"}) and build up from there.`)
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
        platform, template: templateId, name, path: projPath, title, overwrite, verbose,
      });
      return { ...result, genre, template: templateId };
}

// ── The examples tool — the fork-don't-create surface (0.29.0) ──────────────
// "Scaffold" died as a concept: there are no empty frames, only complete
// working example games. Making a new game = forking the nearest example and
// modifying it. See internal plan: the weak-model case for this is that retro
// bring-up is a long conjunction of fragile steps with zero partial credit —
// modifying a working game converts "get 15 things right" into "change 2
// while 13 keep working", with a bisectable regression oracle.

const CANONICAL_GENRES = ["shmup", "platformer", "puzzle", "sports", "racing"];
const HANDHELDS = new Set(["gb", "gbc", "gba", "gg", "lynx"]);

// Mechanics inventory per genre — what an agent learns by forking each.
// (Hardware-technique anchors get added per-game as the Complete Game
// Contract lands; list derives the rest from the manifest.)
const GENRE_MECHANICS = {
  shmup:      ["scrolling field", "projectile pools", "enemy waves + spawning", "collision (point/rect)", "score + lives"],
  platformer: ["side-scrolling camera", "gravity + jump arc", "tile collision (walk/land/fall)", "world map"],
  puzzle:     ["grid logic", "piece falling + lock", "match detection (4-dir)", "gravity cascades + chain scoring"],
  sports:     ["versus court", "ball physics + paddle bounce", "2P input (second pad, AI fallback)", "serve/score states"],
  racing:     ["forward-scrolling road", "lane steering", "obstacle spawning", "speed/crash states"],
};

// Fork guidance for genres we don't ship — points at the nearest core loop.
const UNCOVERED_GENRE_GUIDANCE =
  "No example matches your genre exactly? Fork the NEAREST CORE LOOP and reshape it: " +
  "RPG/adventure → puzzle (grid + state machines) or platformer (world + camera); " +
  "tower defense → shmup (spawning + projectiles); " +
  "card/board game → puzzle (grid + turn logic); " +
  "beat-em-up → platformer (movement + collision); " +
  "pinball/breakout → sports (ball physics). " +
  "Fork for the core loop; read other examples (op:'show') for techniques to graft.";

/** "<platform>/<template>" → {platform, template}; also accepts separate args. */
function resolveExampleId({ example, platform, template }) {
  if (example) {
    const m = /^([a-z0-9]+)\/(.+)$/.exec(example);
    if (!m) throw new Error(`examples: bad example id '${example}' — use "<platform>/<name>" (e.g. "nes/shmup"). examples({op:'list'}) shows them all.`);
    return { platform: m[1], template: m[2] };
  }
  if (platform && template) return { platform, template };
  throw new Error("examples: pass `example` (\"nes/shmup\") or `platform` + `template`.");
}

/** One list entry from a TEMPLATES manifest record (defaults derived). */
function exampleEntry(platform, templateId, tmpl) {
  const isGame = CANONICAL_GENRES.includes(templateId);
  const players = tmpl.players ?? (templateId === "sports" && !HANDHELDS.has(platform) ? 2 : 1);
  return {
    example: `${platform}/${templateId}`,
    kind: tmpl.kind ?? (isGame ? "game" : "reference"),
    ...(isGame ? { genre: templateId } : {}),
    description: tmpl.describe ?? "",
    mechanics: tmpl.mechanics ?? (isGame ? GENRE_MECHANICS[templateId] : []),
    // Hardware techniques demonstrated, each with a file + marker anchor for
    // op:'show' extraction — populated per-game as the contract lands.
    techniques: tmpl.techniques ?? [],
    players,
    sram: tmpl.sram ?? false,
  };
}

/** Extract HARDWARE IDIOM / GAME LOGIC marked blocks from source text. */
function extractMarkedBlocks(text) {
  const blocks = [];
  const re = /\/\* ── (HARDWARE IDIOM|GAME LOGIC)([^\n]*?)── \*\/([\s\S]*?)(?=\/\* ── (?:HARDWARE IDIOM|GAME LOGIC)|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ kind: m[1], header: m[2].trim(), body: m[3].trimEnd() });
  }
  return blocks;
}

export function registerProjectTools(server, z) {
  server.tool(
    "examples",
    "The example-game library — complete, working, teaching-grade games per platform, and the ONLY way to start a " +
    "new project: **never start from a blank file — fork the nearest example and modify it into your game, even a " +
    "very different game.** (Retro bring-up is a long chain of fragile hardware init with zero partial credit; a " +
    "working game is a regression oracle — change 2 things while 13 keep working.) `op`: 'list' | 'fork' | 'show' | " +
    "'snippets' | 'copySnippets'.\n" +
    "'list': the mechanics map — every example with its kind (game vs minimal reference), mechanics inventory, " +
    "hardware techniques demonstrated (with file+marker anchors for op:'show'), players, SRAM. Use it to pick the " +
    "example whose CORE LOOP is nearest your game; fork that one, then op:'show' OTHER examples for techniques to graft.\n" +
    "'fork': copy an example into a NEW project dir as YOUR game — sources + every runtime file + crt0 + linker cfg + " +
    "README, self-contained, renamed throughout (project name, game title where the code carries one). Builds and runs " +
    "before you change a line. Then: modify one thing at a time, re-running build({output:'run'}) after each.\n" +
    "'show': read a donor example WITHOUT forking it — a whole file, or one marked technique block (extracted by its " +
    "HARDWARE IDIOM marker, including the dependency header that says what the block needs to survive a transplant).\n" +
    "'snippets'/'copySnippets': the legacy vetted-snippet library (browse/fetch/copy). Prefer forking + grafting from " +
    "real games; snippets remain for one-off references.",
    {
      op: z.enum(["list", "fork", "show", "snippets", "copySnippets"]).describe("list the library; fork an example into your game; show donor source/technique without forking; legacy snippets."),
      platform: z.string().optional().describe("op=list: filter to one platform. op=fork/show/snippets/copySnippets: platform id (or encode it in `example`)."),
      example: z.string().optional().describe("op=fork/show: example id as \"<platform>/<name>\" (e.g. \"nes/shmup\", \"gb/puzzle\") — from op:'list'."),
      template: z.string().optional().describe("op=fork/show: example name when passing `platform` separately (alias of the id's second half)."),
      name: z.string().optional().describe("op=fork: YOUR game's name (project dir naming, output binary, and the in-game title where the example carries one). Required."),
      path: z.string().optional().describe("op=fork: absolute path where the project dir is created. Required."),
      title: z.string().optional().describe("op=fork: human-readable title for the README (defaults to `name`)."),
      overwrite: z.boolean().default(false).describe("op=fork: allow writing into an existing non-empty dir. op=copySnippets: overwrite existing files."),
      verbose: z.boolean().default(false).describe("op=fork: echo the FULL flat file manifest incl. vendor/** (default: only the files you own + a vendorFileCount)."),
      file: z.string().optional().describe("op=show: which file of the example to read (default: the main source)."),
      technique: z.string().optional().describe("op=show: extract ONE marked technique block whose HARDWARE IDIOM header matches this string (case-insensitive substring), instead of the whole file."),
      // legacy snippets passthrough
      mode: z.enum(["list", "get", "getAll"]).default("list").describe("op=snippets: 'list' (names), 'get' (one, needs snippetName), 'getAll' (joined)."),
      snippetName: z.string().optional().describe("op=snippets mode:'get': snippet name."),
      language: z.string().optional().describe("op=snippets/copySnippets: filter 'c' | 'asm'."),
      outputPath: z.string().optional().describe("op=snippets mode:'getAll': write the joined snippets here (or inline:true)."),
      inline: z.boolean().default(false).describe("op=snippets mode:'getAll': return `combined` inline."),
      destinationDir: z.string().optional().describe("op=copySnippets: directory to write snippets into."),
      include: z.array(z.string()).optional().describe("op=copySnippets: whitelist of snippet names."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "list": {
          const platforms = args.platform ? [args.platform] : Object.keys(TEMPLATES);
          const examples = [];
          for (const p of platforms) {
            const t = TEMPLATES[p];
            if (!t) continue;
            for (const id of Object.keys(t)) examples.push(exampleEntry(p, id, t[id]));
          }
          // Games first (the forkable starting points), references after.
          examples.sort((a, b) => (a.kind === b.kind ? a.example.localeCompare(b.example) : a.kind === "game" ? -1 : 1));
          return jsonContent({
            count: examples.length,
            doctrine: "Fork the example whose CORE LOOP matches your game; op:'show' the others for techniques to graft. " +
              "Ranked: nearest fork alone > fork + one graft > fork + many grafts — prefer the leftmost that gets your game made.",
            uncoveredGenres: UNCOVERED_GENRE_GUIDANCE,
            examples,
          });
        }
        case "fork": {
          const { platform, template } = resolveExampleId(args);
          if (!args.name || !args.path) throw new Error("examples({op:'fork'}): `name` and `path` are required (your game's name + where to create it).");
          if (!TEMPLATES[platform]?.[template]) {
            const have = TEMPLATES[platform] ? Object.keys(TEMPLATES[platform]).join(", ") : "(no examples for this platform)";
            throw new Error(`examples({op:'fork'}): no example '${platform}/${template}'. This platform has: ${have}.`);
          }
          const result = await createProjectImpl({
            platform, template, name: args.name, path: args.path, title: args.title,
            overwrite: args.overwrite, verbose: args.verbose,
          });
          // Rename the game THROUGH: where the example carries a GAME_TITLE
          // define, stamp the new name so the title screen says YOUR game
          // (identity transfer is the cheap defense against base-game-concept
          // leakage — an agent working on "CAVERN RUN" treats leftover shmup
          // scoring as a bug in ITS game).
          let titleStamped = false;
          try {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const stamp = String(args.name).toUpperCase().replace(/[^A-Z0-9 \-]/g, "").slice(0, 16) || "MY GAME";
            for (const f of result.files ?? []) {
              if (!/\.(c|h|s|asm)$/i.test(f)) continue;
              const fp = path.join(result.path, f);
              let src;
              try { src = await fs.readFile(fp, "utf-8"); } catch { continue; }
              const re = /(#define\s+GAME_TITLE\s+")[^"]*(")/;
              if (re.test(src)) {
                await fs.writeFile(fp, src.replace(re, `$1${stamp}$2`), "utf-8");
                titleStamped = true;
              }
            }
          } catch { /* best-effort; the fork itself succeeded */ }
          return jsonContent({
            ...result,
            forkedFrom: `${platform}/${template}`,
            template,
            ...(CANONICAL_GENRES.includes(template) ? { genre: template } : {}),
            ...(titleStamped ? { gameTitle: true } : {}),
            note: `Forked ${platform}/${template} → '${args.name}'. It builds and runs RIGHT NOW — verify with the build({output:"run"}) call in its README before changing anything, then modify ONE thing at a time, re-running after each. The README's marker legend says which regions are hardware idiom (reshape gameplay around them) vs game logic (clay).`,
          });
        }
        case "show": {
          const { platform, template } = resolveExampleId(args);
          const tmpl = TEMPLATES[platform]?.[template];
          if (!tmpl) {
            const have = TEMPLATES[platform] ? Object.keys(TEMPLATES[platform]).join(", ") : "(none)";
            throw new Error(`examples({op:'show'}): no example '${platform}/${template}'. This platform has: ${have}.`);
          }
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const { fileURLToPath } = await import("node:url");
          const baseDir = path.dirname(fileURLToPath(import.meta.url));
          const exDir = path.resolve(baseDir, "..", "..", "..", "examples");
          // Default file = the template's `main` source (relative to
          // examples/<platform>/). An explicit `file` resolves the same way.
          const rel = args.file ?? tmpl.main;
          if (!rel) throw new Error(`examples({op:'show'}): example '${platform}/${template}' has no default source — pass the file arg.`);
          const fp = path.resolve(exDir, platform, rel);
          if (!fp.startsWith(exDir)) throw new Error("examples({op:'show'}): file path escapes the examples directory.");
          let text;
          try { text = await fs.readFile(fp, "utf-8"); }
          catch { throw new Error(`examples({op:'show'}): can't read '${rel}' for ${platform}/${template}.`); }
          if (args.technique) {
            const blocks = extractMarkedBlocks(text).filter((b) => b.kind === "HARDWARE IDIOM");
            const hit = blocks.find((b) => b.header.toLowerCase().includes(args.technique.toLowerCase()));
            if (!hit) {
              return jsonContent({
                example: `${platform}/${template}`, technique: args.technique, found: false,
                availableTechniques: blocks.map((b) => b.header),
                note: blocks.length
                  ? "No HARDWARE IDIOM block matches — availableTechniques lists this file's blocks."
                  : "This example has no marked technique blocks yet (markers land as games reach the Complete Game Contract). op:'show' without `technique` returns the whole file.",
              });
            }
            return jsonContent({
              example: `${platform}/${template}`, technique: hit.header, found: true,
              code: hit.body,
              note: "The block header states its DEPENDENCIES (interrupt hooks, memory regions, register modes) — satisfy those in your game before transplanting the code.",
            });
          }
          return jsonContent({ example: `${platform}/${template}`, file: rel, source: text });
        }
        case "snippets":
          return await starterSnippetsCore({ ...args, name: args.snippetName });
        case "copySnippets": {
          if (!args.destinationDir) throw new Error("examples({op:'copySnippets'}): `destinationDir` is required.");
          return await copyStarterSnippetsCore({ ...args, overwrite: args.overwrite ?? true });
        }
        default: throw new Error(`examples: unknown op '${args.op}'`);
      }
    }),
  );

  // patchGbHeader was folded into romPatch({op:'gbHeader'}) (rom-id.js) — it's a
  // ROM-file patch op, same family as romPatch's other ops, not a scaffold tool.
}
