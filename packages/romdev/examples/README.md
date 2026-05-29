# Examples

Minimal "hello" projects for every platform rom-dev-mcp's bundled toolchains can build. Each one is the simplest thing that's still a real ROM — an agent forks from these instead of starting from a blank file.

Each example fits the convention:
- A `main.c` or `main.asm`/`main.s` as the entry point.
- Builds with `buildSource({ platform, source })` (most platforms) or with
  the per-platform extra below.
- Produces a runnable ROM for the matching emulator core.

| Platform     | Source               | Toolchain | Extra build args                     |
| ------------ | -------------------- | --------- | ------------------------------------ |
| nes          | `nes/main.c`         | cc65      | `linkerConfig: "chr-ram"` (writes tiles at runtime via PPUADDR/PPUDATA; preset defines OAM segment + drops CHR-ROM region) |
| c64          | `c64/main.c`         | cc65      | Direct VIC-II + screen-RAM demo: paints background, writes screen codes for "HELLO ROM-DEV-MCP" into screen RAM with white-on-blue color, cycles the border color. C89 (cc65) — no mixed decl/code. |
| atari2600    | `atari2600/main.asm` | dasm      | Standard NTSC kernel (3 vsync + 37 vblank + 192 visible + 30 overscan) with a single GRP0 sprite, joystick-driven movement, and the vector table at $FFFA. |
| atari5200    | `atari5200/main.c`   | cc65      |                                      |
| atari7800    | `atari7800/main.c`   | cc65      | Minimal MARIA bring-up: DLL pointing at a single-zone DL, palette load, CHARBASE = 0. cc65 can't constant-fold pointer→int for static initializers, so the DL/DLL addresses are patched in at runtime in `main()`. |
| lynx         | `lynx/main.c`        | cc65      |                                      |
| snes         | `snes/main.asm`      | asar      |                                      |
| genesis      | `genesis/main.s`     | vasm68k   |                                      |
| gb           | `gb/main.c` (default) or `gb/main.asm` (`language:"asm"`) | sdcc sm83 port (C, default) / rgbds (asm) | C example cycles the BG palette every 32 frames. Asm example shows yellow 'H' on light BG, scrollable with A. SDCC GB hardware-register headers under `src/platforms/gb/lib/c/gb_hardware.h`. |
| gbc          | `gbc/main.asm`       | rgbds (asm) / sdcc sm83 (C) | The bundled example is an asm CGB-color demo (yellow 'H' on a true-blue BG, only possible on GBC). C is also supported via SDCC sm83 — same as GB. |
| sms          | `sms/main.c` (or `sms/templates/*.c`) | sdcc | Pair with `src/platforms/sms/lib/c/sms_crt0.s` (passed via `crt0` arg) — boots into a real cartridge with vector table + SP=$DFF0 + IM 1. Yellow 'H' on blue, scrollable with P1-B1. The 9 templates under `sms/templates/` (default, hello_sprite, tile_engine, shmup, shmup_2p, platformer, puzzle, sports, racing, music_demo) all use this crt0 — `createProject` copies it in automatically. |
| gg           | `gg/templates/default.c` (or any other template) | sdcc | R53: GG now ships `src/platforms/gg/lib/c/gg_crt0.s` (byte-identical to SMS's). Real visible-and-runnable default: VDP Mode 4 init + palette + yellow 'H' centered in the 160×144 visible viewport + B1 scroll loop. The 9 templates (default, hello_sprite, tile_engine, shmup, platformer, puzzle, sports, racing, music_demo) all link the GG runtime + crt0 via `createProject({platform:"gg"})`. |
| gba          | `gba/templates/*.c`  | arm-none-eabi-gcc | Default runtime = **libtonc** (`#include <tonc.h>`). 9 scaffolds incl. `tonc_hello`, `tonc_hello_sprite`, the 5 genre scaffolds, and `maxmod_demo` (music). Pass `runtime:"libgba"` for the devkitPro API, `runtime:"none"` for bare newlib. **Always call `irq_init(NULL); irq_add(II_VBLANK, NULL);` before `VBlankIntrWait()`** — otherwise the BIOS halts forever. |
| msx          | `msx/main.c`         | sdcc      | Bring-up only (single default template). Same SDCC z80 path as SMS — a future round will port the genre scaffolds. |
| coleco       | `coleco/main.c`      | sdcc      | Bring-up only (single default template). Same SDCC z80 path as SMS — a future round will port the genre scaffolds. |
