# Genesis / Mega Drive — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/genesis/templates/*.c`).
2. **Bundled runtime source** — `(shipped in romdev-toolchain-m68k-gcc) share/genesis/c/
   genesis_sfx.c` (PSG wrapper); `lib/sgdk/sega.s` (boot crt0);
   `lib/sgdk/rom_header.c` (cart header builder).
3. **Bundled library source** (R58) — full SGDK source tree at
   `(shipped in romdev-toolchain-m68k-gcc) share/genesis/sgdk/src/`. Every SGDK API (VDP_*,
   SPR_*, JOY_*, XGM2_*, BMP_*, etc.) has readable C here.
4. **Upstream GitHub** (NOT bundled):

   | What | Upstream |
   |---|---|
   | SGDK | https://github.com/Stephane-D/SGDK |
   | m68k-elf-gcc / binutils / newlib (bundled WASM, build instructions only) | https://gcc.gnu.org/ |
   | vasm (the assembler we ship as the alternative path) | http://sun.hasenbraten.de/vasm/ |
   | genesis_plus_gx libretro core | https://github.com/libretro/Genesis-Plus-GX |

## Genesis hardware docs

- **Genesis Software Manual** (Sega official, scanned): https://segaretro.org/Sega_Mega_Drive/Documents
- **Mega Drive technical info** (genesis-effects.blogspot, modern): https://mode5.dev/
- **Plutiedev** (homebrew tutorial site): https://plutiedev.com/
- **Copetti**: https://www.copetti.org/writings/consoles/mega-drive-genesis/
- **VDP register reference**: https://md.railgun.works/index.php?title=Main_Page

## YM2612 + PSG (audio)

The Genesis has TWO audio chips:
- **SN76489 PSG** (3 squares + 1 noise) — what our `genesis_sfx`
  wrapper drives via SGDK's `PSG_*` helpers
- **YM2612 FM synth** (6 channels of 4-op FM) — driven by the Z80
  side via SGDK's XGM2 driver (compiled XGM2 blobs)

The Z80 sound CPU runs a separate program (XGM2 driver) loaded into
Z80 RAM at boot. To get music: compose in DefleMask or similar →
export `.vgm` → compile to XGM2 with `encodeAudio({target:'xgm2', vgmPath, name})`
(a pure-JS port of SGDK's Java `xgm2tool`; emits a 256-aligned C array) → `#include`
→ `XGM2_play(music)`. (The driver fn is `XGM2_play`; the older C `xgmtool`/`.xgc`
is the LEGACY `XGM_*` v1 format — different driver, don't mix.)

For YM2612 register-level work: https://www.smspower.org/Development/YM2612

## When to use what

- "How does `VDP_drawText` work?" → `sgdk/src/vdp_bg.c` + `sgdk/src/font.c`
- "What does `SPR_addSprite` actually queue?" → `sgdk/src/sprite_eng.c`
- "Why does `JOY_readJoypad(JOY_1)` not see Start?" → `sgdk/src/joy.c`
  (controller polling) + Plutiedev's joypad doc
- "How does XGM2_play sync with vblank?" → `sgdk/src/snd/xgm2.c`
- "VDP register X does what?" → md.railgun.works VDP reference
