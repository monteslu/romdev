# Commodore 64 — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/c64/templates/*.c`).
2. **Bundled runtime** — `src/platforms/c64/lib/c/c64_sfx.c`,
   `c64_music.c`, `c64_registers.h`, asm helpers in `lib/*.s`.
3. **Bundled cc65 C64 libsrc** (R58) at `src/platforms/c64/lib/
   cc65-src/`. cc65's C64 target: joystick, conio, VIC/SID/CIA
   helpers, header builder, the BASIC stub.
4. **Upstream**:

   | What | Upstream |
   |---|---|
   | cc65 | https://github.com/cc65/cc65 |
   | VICE x64 libretro core | https://github.com/libretro/vice-libretro |
   | VICE proper | https://vice-emu.sourceforge.io/ |

## C64 hardware docs

- **C64 Programmer's Reference Guide** (the canonical book, scanned):
  https://www.lemon64.com/forum/viewtopic.php?t=44525
- **codebase64** (modern dev wiki): https://codebase64.org/
- **VIC-II reference**: https://www.zimmers.net/cbmpics/cbm/c64/vic-ii.txt
- **SID reference**: https://codebase64.org/doku.php?id=base:start_at_the_beginning_-_setting_up_the_sid
- **6510 instruction set**: same as 6502 + the I/O port at $0001

## When to use what

- "What's at $D000-$DFFF?" → VIC-II ($D000) / SID ($D400) / CIA1
  ($DC00) / CIA2 ($DD00) — see `c64_registers.h`
- "How does the SID envelope work?" → `c64_music.c` ADSR setup
  + codebase64 SID page
- "BASIC stub — what's `SYS 2061`?" → `lib/basic_stub.s` header
- "VICE doesn't expose register X" → libretro vice-libretro
