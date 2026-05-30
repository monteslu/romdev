# NES — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/nes/templates/*.c`).
2. **Bundled runtime** — `src/platforms/nes/lib/c/nes_runtime.c`,
   asm helpers in `lib/*.s`, FamiTone2 source at `lib/asm/famitone2.s`.
3. **Bundled cc65 NES libsrc** (R58) at `src/platforms/nes/lib/
   cc65-src/`. Full cc65 NES target source: joystick driver, conio,
   PPU helpers, header builder, etc.
4. **Upstream GitHub**:

   | What | Upstream |
   |---|---|
   | cc65 | https://github.com/cc65/cc65 |
   | famitone2 + tools | https://shiru.untergrund.net/code.shtml |
   | fceumm libretro core | https://github.com/libretro/libretro-fceumm |

## NES hardware docs

- **NESdev Wiki** (canonical, everything you'd need): https://www.nesdev.org/wiki
- **NESdev guide series**: https://www.nesdev.org/wiki/Tutorials
- **6502 instruction reference**: https://www.masswerk.at/6502/6502_instruction_set.html

## When to use what

- "How does cc65's `joy_read(JOY_1)` poll the controller?" →
  `lib/cc65-src/joystick/nes-stdjoy.s`
- "Why does my CHR-RAM write not appear?" → NESdev wiki "PPU memory map"
- "FamiTone2 song format?" → `lib/asm/famitone2.s` header comment + Shiru's docs
- "fceumm doesn't expose register X" → libretro-fceumm GitHub
