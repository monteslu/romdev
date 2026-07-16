# GBA — source you can read

Trust hierarchy (try in order before filing a feedback round):

1. **Bundled examples** (`examples/gba/templates/*.c`) — verified
   compile + run. Start here.
2. **Bundled runtime source** (`(shipped in romdev-platform-gba) share/gba/c/gba_sfx.c`) —
   our APU wrapper. Read when sfx isn't doing what you expect.
3. **Bundled library source** — libtonc + libgba + maxmod (R58):

   | Library | Local source | Read this when |
   |---|---|---|
   | libtonc | `(shipped in romdev-platform-gba) share/gba/libtonc/src/` | `tte_init_X` / `oam_copy` / TTE behavior |
   | libgba | `(shipped in romdev-platform-gba) share/gba/libgba/src/` | `irqInit`/`irqEnable`/`VBlankIntrWait` |
   | maxmod | `(shipped in romdev-platform-gba) share/gba/maxmod/` (.s files already there) | `mmFrame`/`mmStart` audio timing |

4. **Upstream GitHub** (NOT bundled — fetch on demand):

   | What | Upstream |
   |---|---|
   | libtonc (Tonc) | https://github.com/devkitPro/libtonc |
   | libgba | https://github.com/devkitPro/libgba |
   | maxmod | https://github.com/devkitPro/maxmod |
   | mGBA libretro core | https://github.com/libretro/mgba |
   | mGBA proper | https://github.com/mgba-emu/mgba |
   | arm-none-eabi-gcc | https://gcc.gnu.org/ + https://github.com/bminor/binutils-gdb |

## GBA hardware docs

- Pan-style canonical: **GBATEK** at https://problemkaputt.de/gbatek.htm
- Tonc tutorial (best practical guide): https://www.coranac.com/tonc/text/
- Cowbite Spec (alt register reference): https://www.cs.rit.edu/~tjh8300/CowBite/CowBiteSpec.htm

## When to use what

- "How does `tte_write` lay out tile data?" → `libtonc/src/tte/`
- "What does `irqInit` install?" → `libgba/src/interrupt.c` (gnu_as section)
- "How does maxmod's IRQ-driven mixer work?" → `maxmod/asm/mp_mixer_gba.s`
- "Why does my BG3 show garbage on mGBA?" → GBATEK section 8 (Video)
- "Does the bundled `gba_sfx_tone` set the trigger bit?" → our
  `gba_sfx.c` source (50 lines).
