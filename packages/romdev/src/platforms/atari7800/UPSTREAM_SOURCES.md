# Atari 7800 — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/atari7800/templates/*.c`).
2. **Bundled runtime** — `src/platforms/atari7800/lib/c/
   atari7800_sfx.c`, `atari7800_music.c`, asm helpers in `lib/*.asm`,
   `maria_registers.h`.
3. **Bundled cc65 atari7800 libsrc** (R58) at `src/platforms/
   atari7800/lib/cc65-src/`. cc65's 7800 target — joystick, conio,
   MARIA helpers.
4. **Upstream**:

   | What | Upstream |
   |---|---|
   | cc65 | https://github.com/cc65/cc65 |
   | prosystem libretro core | https://github.com/libretro/prosystem-libretro |

## 7800 hardware docs

- **7800 Software Guide** (Atari official, scanned): https://atariage.com/2600/archives/index.html#7800
- **MARIA programming**: https://atariage.com/forums/forum/51-atari-7800-programming/
- **TIA audio** (same chip as 2600): see `../atari2600/UPSTREAM_SOURCES.md`

## MARIA is unusual

The 7800's video chip (MARIA) doesn't use a fixed framebuffer or
tile grid — every scanline is composed from **Display List Objects**
that point at sprite-like graphics buffers. The programmer assembles
each frame's display list in RAM and writes a pointer to it via
`DLL` ($FC). MARIA walks the list each frame.

Bundled `display_list.asm` + `maria_init.asm` show the canonical
single-zone DL pattern. Read the 7800 Software Guide § DMA + DL
sections before doing anything custom.

## When to use what

- "How do I render N sprites?" → MARIA DL — 7800 SW Guide
- "TIA audio (POKEY's not on most 7800 carts)" → atari7800_sfx.c +
  TIA docs (same chip as 2600)
- "prosystem doesn't expose register X" → libretro prosystem GitHub
- "cc65's 7800 conio implementation" → `lib/cc65-src/`
