# Atari Lynx — troubleshooting

Read MENTAL_MODEL.md first (`getPlatformDoc({platform:"lynx",
name:"mental_model"})`).

## "ROM loads but screen is black / no display"

You probably forgot `tgi_install` + `tgi_init`. cc65's TGI driver
must be installed before any `tgi_*` call. The canonical opener:

```c
tgi_install(&lynx_160_102_16_tgi);
tgi_init();
```

Without `tgi_init` the framebuffer pointer isn't set; without
`tgi_install` the TGI dispatcher has no driver to call.

## "tgi_outtextxy renders nothing"

cc65's default TGI on Lynx ships without a font. Either:
1. Load one: `tgi_load_vectorfont("lynx_a.fnt", ...)` — fontfiles
   live in `$cc65_share/target/lynx/fonts/`.
2. Draw your own glyphs with `tgi_bar`/`tgi_line`.

The bundled scaffolds work around this by using simple rectangles
for game content + only short text strings. For game UI text, embed
a bitmap font directly in your code.

## "Joystick reads return 0"

`joy_install(&lynx_stdjoy_joy)` is required before `joy_read(JOY_1)`.
The Lynx joystick driver maps the hardware switch register at $FCB0
into cc65's JOY_* macros.

## "MIKEY audio silent — sfx_init was called but I hear nothing"

Three things to check:
1. **Volume sign**: MIKEY's volume register is SIGNED 8-bit. 64 =
   audible, 0 = silent, -1 (0xFF) = also audible but inverted phase.
   sfx_init sets volume to 0 (silent) — you must call sfx_tone or
   sfx_noise to get audio.
2. **STEREO routing**: `$FD50` controls which voices output to which
   speaker. Bits 0-3 *mute* left for voice 0-3; bits 4-7 mute right.
   sfx_init sets it to 0 (all voices to both speakers). If you've
   written non-zero values to $FD50, voices may be muted.
3. **sfx_update**: without it, notes never silence. Probably not
   "silent" but "the same note plays forever and gets ignored as
   background noise."

## "ROM works in handy emulator but not in mednafen/etc."

Other Lynx emulators sometimes expect the 64-byte `.lnx` header that
cc65's default config doesn't emit. Either:
1. Stick with handy (rom-dev-mcp ships this).
2. Wrap your ROM in a `.lnx` header — handy itself can produce one
   via `lyxx -i raw.bin -o game.lnx`.

## "cc65 complains about C99 features"

cc65 is C89. No mixed declarations + code, no inline `for (uint8_t i
= 0; ...)`, no compound literals, no // comments in some configs.
Declare all variables at the top of each block.

The bundled Lynx scaffolds are C89-clean — copy that pattern.

## "Compile fails: no rule to make target lynx-bll.cfg"

You probably tried passing `linkerConfig: "lynx-bll"` — that's the
"bootloader-loaded" config for multi-image ROMs. For a single-image
ROM let cc65 use the default `lynx.cfg`. Drop the linkerConfig arg.

## "Game runs but at wrong speed"

Lynx framerate is configurable via Mikey timer 0. cc65's tgi defaults
to ~60 fps via `tgi_setframerate(60)`. Lower it to 30 for slow games:
`tgi_setframerate(30);` after tgi_init.

Don't bother adjusting if you're just iterating in the emulator —
gpgx and handy both run at the rate the ROM requests.
