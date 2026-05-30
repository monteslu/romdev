# SNES — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/snes/templates/*.c`).
2. **Bundled runtime source** — `src/platforms/snes/lib/c/snes_sfx.c`,
   the SPC driver in `lib/audio/spc_driver.asm`, the `apu_blob.asm`
   uploader.
3. **Bundled library source** (R58) — PVSnesLib at
   `src/platforms/snes/lib/pvsneslib/source/`. The complete PVSnesLib
   source tree — every API (`consoleDrawText`, `setMode`,
   `WaitForVBlank`, `padsCurrent`, OAM helpers, palette helpers) has
   readable C/asm here.
4. **Upstream GitHub** (NOT bundled):

   | What | Upstream |
   |---|---|
   | PVSnesLib | https://github.com/alekmaul/pvsneslib |
   | tcc-65816 (the C compiler we ship for SNES) | https://github.com/alekmaul/tcc/tree/65816 |
   | wla-dx (65816 assembler we link with) | https://github.com/vhelin/wla-dx |
   | asar (the alternative 65816 asm we ship) | https://github.com/RPGHacker/asar |
   | snes9x libretro core | https://github.com/libretro/snes9x |

## SNES hardware docs

- **SNES Dev Manual** (Nintendo's, scanned): https://archive.org/details/SNESDevManual
- **Anomie's SNES docs** (the modern reference): http://www.romhacking.net/community/566/
- **Fullsnes** (problemkaputt, pan-docs style): https://problemkaputt.de/fullsnes.htm
- **superfamicom.org**: https://snes.nesdev.org/

## SPC700 (audio subsystem)

The SNES audio chip is a separate CPU (Sony SPC700) with its own
64 KB ARAM. Main 65816 → SPC communication via 4 mailbox bytes at
$2140-$2143. Our `snes_sfx.c` + `spc_driver.asm` handle the upload
+ command protocol; for music driver internals see:

- Our bundled SPC driver: `src/platforms/snes/lib/audio/spc_driver.asm`
  (152 bytes — tiny, fully readable)
- SPC700 reference: https://wiki.superfamicom.org/spc700-reference
- BRR sample format: https://wiki.superfamicom.org/bit-rate-reduction-(brr)

## When to use what

- "How does `consoleDrawText` lay out the tilemap?" → `pvsneslib/source/`
  + grep `consoleDrawText`
- "What does `WaitForVBlank` actually do?" → same dir
- "Why doesn't my BRR sample loop?" → BRR docs above + `apu_blob.asm`
- "How does tcc-65816 lay out the stack?" → tcc-65816 GitHub
- "snes9x doesn't expose register X" → libretro snes9x GitHub
