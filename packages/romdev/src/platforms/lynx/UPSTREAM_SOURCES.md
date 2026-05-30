# Lynx — source you can read

When the bundled examples + MENTAL_MODEL.md aren't enough and you
need to grep around the actual implementation. Trust hierarchy:

1. **Bundled examples** (`examples/lynx/templates/*.c`) — verified to
   compile and (mostly) work. Start here.
2. **Bundled runtime source** (`src/platforms/lynx/lib/`) — our thin
   wrappers (lynx_sfx.c, lynx_music.c). Read these when an API call
   isn't doing what you expect.
3. **cc65 lynx libsrc** — shipped at `src/platforms/lynx/lib/cc65-src/`.
   The complete cc65 Lynx target source: TGI graphics driver (`tgi/
   lynx-160-102-16.s`), joystick driver, conio, header builder, sound
   engine (`lynx-snd.s`), etc. Read this when "tgi_bar does X — why?".
4. **Compiler + emulator GitHub** (links below) — for anything below
   our thin wrappers and beyond cc65's source. We don't bundle these
   because they're big and the agent can't rebuild them anyway, but
   you can fetch them on demand when chasing a deep bug.
5. **Found a real bug in romdev?** Open an issue at
   https://github.com/monteslu/romdev/issues with repro details.

## Local source paths (in your project after `npm install`)

| What | Where |
|---|---|
| Our lynx_sfx wrapper | `src/platforms/lynx/lib/c/lynx_sfx.c` |
| Our lynx_music wrapper | `src/platforms/lynx/lib/c/lynx_music.c` |
| cc65 TGI driver | `src/platforms/lynx/lib/cc65-src/tgi/lynx-160-102-16.s` |
| cc65 lynx_snd music engine | `src/platforms/lynx/lib/cc65-src/lynx-snd.s` |
| cc65 joystick driver | `src/platforms/lynx/lib/cc65-src/joy/lynx-stdjoy.s` |
| cc65 conio | `src/platforms/lynx/lib/cc65-src/conio.s` |
| cc65 header builder | `src/platforms/lynx/lib/cc65-src/header.s` |

When you grep, start in `cc65-src/` — it's the most likely place
your "why doesn't tgi_X work?" question gets answered.

## Upstream sources (NOT bundled — fetch on demand if needed)

| What | Upstream | Why not bundled |
|---|---|---|
| cc65 compiler + libsrc | https://github.com/cc65/cc65 | We bundle the WASM compiler + lynx libsrc separately; full tree is ~50 MB |
| handy libretro core | https://github.com/libretro/libretro-handy | C++ emulator source, ~5 MB. Read when MCP behavior diverges from real hardware. |
| handy mikie/susie (deeper) | Same repo, `src/lynx/mikie.cpp` + `susie.cpp` | Contains the exact emulation of MIKEY timers + Suzy blitter. Where round-29's audio-vs-TGI bug was diagnosed. |

## Lynx hardware docs

| What | Where |
|---|---|
| Atari Lynx Programmer's Manual | https://atarihq.com/danb/files/Atari_Lynx_Programmer_s_Manual.pdf |
| Lynx Bluebook (epyx engineer notes) | https://archive.org/details/lynx_bluebook |
| Copetti architecture writeup | https://www.copetti.org/writings/consoles/atari-lynx/ |

The Programmer's Manual is the canonical reference for everything
MIKEY + Suzy. Read sections 5 (MIKEY) and 6 (Suzy) before
attempting anything beyond `tgi_bar`.

## When to use what

- "How does `tgi_bar` work internally?" → `cc65-src/tgi/lynx-160-102-16.s`
- "What does the MIKEY timer chain do?" → handy `mikie.cpp` + Programmer's Manual section 5
- "Why does Suzy stop rendering after N frames?" → handy `susie.cpp`
  `PaintSprites()` + check `mSUZYBUSEN` + `mSPRGO`
- "What's the actual audio register layout?" → `cc65-src/lynx-snd.s`
  + Programmer's Manual section 5.6
- "Does the bundled lynx_sfx wrap MIKEY correctly?" → our
  `lynx_sfx.c` source (it's tiny — 100 lines, fully readable)
