Atari 7800 starter snippets
===========================

Hand-vetted boilerplate for the 7800. The default toolchain is **7800basic**
or **cc65** with the `atari7800` target — the snippets here are written in
ca65-style asm for use with cc65/ca65 or as inline asm in C via `__asm__()`.

Files
-----

- **maria_registers.h** — symbolic names + bit masks for MARIA + TIA-audio
  registers ($20-$3F and $15-$1A).
- **maria_init.asm** — boot-time setup: enable DMA, install minimal
  display-list-list (DLL), point CTRL at the display list.
- **display_list.asm** — example single-zone display list rendering a
  single sprite from RAM.
- **palette_load.asm** — write 8 palettes × 3 colors + the background
  color into the MARIA palette registers.
- **vblank_wait.asm** — busy-wait on MARIA STATUS bit 7 (vblank).
- **read_pad.asm** — read joystick 0 + 1 from INPT0-3 (analog) + INPT4-5
  (digital fire).

Toolchain
---------

Build via `build({output:'rom', platform: "atari7800", source: "..."})`. Server
spawns cc65 with the bundled `atari7800.cfg`. The MCP server invokes
the prosystem libretro core to run the result.

Foot-guns
---------

1. **No automatic init.** Unlike NES/SNES the 7800 has no power-on screen
   blank — if you don't enable DMA + load a display list, MARIA renders
   uninitialised memory. Always run `maria_init.asm` first.
2. **DLL ≠ DL.** The display-list-LIST (DLL) is a list of pointers to
   display-LISTs (DL). A DLL entry says "draw this DL for N scanlines."
   Each DL is one or more drawable entries (sprite/character mode).
3. **Palette bytes share format with the 2600.** Each color is one byte
   from the 256-color master palette ((hue<<4) | luma).
4. **CHARBASE matters in character mode** ($87). Sets the high byte of
   character pixel data — make sure your font data is page-aligned.
5. **No NES-style mappers.** 7800 carts are either 16 KB, 32 KB, or 48 KB
   linear-mapped to the top of address space; banked carts (>48 KB) use
   game-specific schemes (POKEY/SuperGame).
