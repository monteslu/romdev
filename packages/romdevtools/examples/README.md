# Examples

Minimal "hello" projects for every platform romdev's bundled toolchains can build. Each one is the simplest thing that's still a real ROM — an agent forks from these instead of starting from a blank file.

Each example fits the convention:
- A `main.c` or `main.asm`/`main.s` as the entry point.
- Builds with `build({output:'rom', platform, source})` (most platforms) or with
  the per-platform extra below.
- Produces a runnable ROM for the matching emulator core.

| Platform     | Source               | Toolchain | Extra build args                     |
| ------------ | -------------------- | --------- | ------------------------------------ |
| nes          | `nes/main.c`         | cc65      | `linkerConfig: "chr-ram"` (writes tiles at runtime via PPUADDR/PPUDATA; preset defines OAM segment + drops CHR-ROM region) |
| nes (full game) | `nes/space-shooter/` | cc65   | Canonical complete-game reference — a generic fixed-shooter showing "NES-shaped C": bit-packed alien state, 5-col formation for the 8-sprite/scanline limit, correct OAM-staging order, shields/HUD as BG tiles, CHR-RAM upload, APU SFX. Build with `linkerConfig: "chr-ram-runtime"` + `nes_runtime.c`. See its README. |
| c64          | `c64/main.c`         | cc65      | Direct VIC-II + screen-RAM demo: paints background, writes screen codes for "HELLO ROM-DEV-MCP" into screen RAM with white-on-blue color, cycles the border color. C89 (cc65) — no mixed decl/code. |
| atari2600    | `atari2600/main.asm` | dasm      | Standard NTSC kernel (3 vsync + 37 vblank + 192 visible + 30 overscan) with a single GRP0 sprite, joystick-driven movement, and the vector table at $FFFA. |
| atari2600 (gallery shooter) | `atari2600/templates/mini_invaders.asm` | dasm | Fixed-shooter 2600 game using the RIGHT TIA objects (not playfield "barcode" bars): P0 double-width cannon, P1 + NUSIZ1=%011 = a row of 3 hardware-replicated invaders, M0 = shot. Aliens march + drop at edges; button fires. The honest 2600-idiomatic genre layout. `scaffold({op:'project', platform:"atari2600", template:"mini_invaders"})`. |
| atari7800    | `atari7800/main.c`   | cc65      | Minimal MARIA bring-up: DLL pointing at a single-zone DL, palette load, CHARBASE = 0. cc65 can't constant-fold pointer→int for static initializers, so the DL/DLL addresses are patched in at runtime in `main()`. |
| lynx         | `lynx/main.c`        | cc65      |                                      |
| snes         | `snes/main.asm`      | asar      |                                      |
| genesis      | `genesis/main.s`     | vasm68k   |                                      |
| gb           | `gb/main.c` (default) or `gb/main.asm` (`language:"asm"`) | sdcc sm83 port (C, default) / rgbds (asm) | C example cycles the BG palette every 32 frames. Asm example shows yellow 'H' on light BG, scrollable with A. SDCC GB hardware-register headers under `src/platforms/gb/lib/c/gb_hardware.h`. |
| gbc          | `gbc/main.asm`       | rgbds (asm) / sdcc sm83 (C) | The bundled example is an asm CGB-color demo (yellow 'H' on a true-blue BG, only possible on GBC). C is also supported via SDCC sm83 — same as GB. |
| sms          | `sms/main.c` (or `sms/templates/*.c`) | sdcc | Pair with `src/platforms/sms/lib/c/sms_crt0.s` (passed via `crt0` arg) — boots into a real cartridge with vector table + SP=$DFF0 + IM 1. Yellow 'H' on blue, scrollable with P1-B1. The 9 templates under `sms/templates/` (default, hello_sprite, tile_engine, shmup, shmup_2p, platformer, puzzle, sports, racing, music_demo) all use this crt0 — `scaffold({op:'project'})` copies it in automatically. |
| gg           | `gg/templates/default.c` (or any other template) | sdcc | R53: GG now ships `src/platforms/gg/lib/c/gg_crt0.s` (byte-identical to SMS's). Real visible-and-runnable default: VDP Mode 4 init + palette + yellow 'H' centered in the 160×144 visible viewport + B1 scroll loop. The 9 templates (default, hello_sprite, tile_engine, shmup, platformer, puzzle, sports, racing, music_demo) all link the GG runtime + crt0 via `scaffold({op:'project', platform:"gg"})`. |
| gba          | `gba/templates/*.c`  | arm-none-eabi-gcc | Default runtime = **libtonc** (`#include <tonc.h>`). 9 scaffolds incl. `tonc_hello`, `tonc_hello_sprite`, the 5 genre scaffolds, and `maxmod_demo` (music). Pass `runtime:"libgba"` for the devkitPro API, `runtime:"none"` for bare newlib. **Always call `irq_init(NULL); irq_add(II_VBLANK, NULL);` before `VBlankIntrWait()`** — otherwise the BIOS halts forever. |
| pce          | `pce/<template>/main.c` | cc65 (HuC6280) | HuCard homebrew, no BIOS. Ships a direct-register VDC/PSG helper lib (`pce.h` + `pce.lib`) — cc65 has no PCE sprite/sound library. Templates: `sprite_move`, `catch_game`, `music_sfx`, plus the 5 genre scaffolds (shmup/platformer/puzzle/sports/racing). **`#include <stdint.h>`** for int8/16/32_t — `pce.h` only typedefs u8/u16. Genre scaffolds fill the BAT (32×32 virtual screen); the platformer smooth-scrolls via the VDC BXR register. |
| msx          | `msx/<template>/main.c` | sdcc (z80) | Boots cartridge homebrew on the open C-BIOS (no proprietary ROM). Ships an AY-3-8910 + TMS9918/V9938 VDP helper lib (`msx_hw.h` + `msx_vdp.c`). Templates: `sprite_move`, `catch_game`, `music_sfx`, plus the 5 genre scaffolds. The bundled `msx_crt0.s` (applied by the dir-build recipe automatically) emits the `"AB"` cartridge header at $4000 + INIT pointer — **C-BIOS shows its logo for ~2-3 s, then CALLs INIT**, so run ≥240 frames before screenshotting. The platformer column-streams the SCREEN 2 name table for a tile-by-tile scroll. |

## Guides

- **[porting-across-platforms/](porting-across-platforms/README.md)** — building
  the *same* arcade game on many systems? Read this first. A per-platform matrix
  of the right rendering primitive (OAM sprites vs. VIC chars vs. Lynx blitter
  vs. 7800 display-lists vs. 2600 beam-raced TIA) so you don't get "correct but
  ugly" output. Prototype on GBA/Genesis, then port the render layer downward.
- **[art-first-workflow/](art-first-workflow/README.md)** — converting pixel-art
  editor output (Aseprite/Tiled/GIF/TexturePacker) into platform-native tiles.
