# Atari 2600 — source you can read

Trust hierarchy:

1. **Bundled examples** (`examples/atari2600/templates/*.asm`).
2. **Bundled runtime** — `src/platforms/atari2600/lib/*.asm`
   (kernel_skeleton, player_kernel, playfield_kernel,
   read_joystick, vectors).
3. **Bundled cc65 atari2600 libsrc** (R58) at `src/platforms/
   atari2600/lib/cc65-src/`. (Note: cc65 doesn't generate practical
   2600 code; we use **dasm** for 2600. The cc65 libsrc here is the
   small bit cc65 ships for 2600 — mostly reference, since real
   2600 dev is asm.)
4. **Upstream**:

   | What | Upstream |
   |---|---|
   | dasm | https://dasm-assembler.github.io/ |
   | stella2014 libretro core | https://github.com/libretro/stella2014-libretro |
   | stella proper | https://stella-emu.github.io/ |

## 2600 hardware docs

- **Stella Programmer's Guide** (the canonical, by Steve Wright):
  https://atariage.com/2600/programming/Stella_Programmers_Guide.pdf
- **AtariAge 2600 programming**: https://atariage.com/forums/forum/50-atari-2600-programming/
- **TIA reference**: https://www.qotile.net/files/2600_advanced_prog_guide.txt
- **Atari Compendium**: http://www.cs.cmu.edu/~chuck/infopg/atari/c25.html

## The race-the-beam model

The 2600 has NO framebuffer. Every scanline is composed in real time
by writing TIA registers as the beam scans. The CPU has ~76 cycles
per scanline (~3 µs total) to (a) decide what's drawn on that line,
(b) write the right TIA registers BEFORE the beam reaches each
pixel column. Miss a cycle window → graphics glitch.

The bundled `kernel_skeleton.asm` is the canonical "NTSC 3 vsync +
37 vblank + 192 visible + 30 overscan" frame structure. Read it
before writing anything.

## When to use what

- "How do I draw two sprites at different Y positions?" → Stella
  Programmer's Guide § "Players" + `player_kernel.asm`
- "TIA register layout" → `lib/vcs_constants.h` + Stella PG appendix
- "Why does my joystick read drift?" → `read_joystick.asm` +
  `SWCHA`/`SWCHB` docs in Stella PG
- "dasm syntax" → dasm-assembler.github.io
