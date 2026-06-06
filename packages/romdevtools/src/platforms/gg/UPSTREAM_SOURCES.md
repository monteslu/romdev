# Game Gear — source you can read

GG shares its toolchain (SDCC z80) + emulator (genesis_plus_gx) +
most of the runtime with SMS (`sms_crt0.s` ≡ `gg_crt0.s` byte-for-
byte; PSG protocol identical). The GG tree at `src/platforms/gg/`
holds the GG-specific scaffolds and runtime helpers; SMS docs apply
for everything else.

GG-specific:
- Visible viewport 160×144 inside 256×192 framebuffer — content
  must be centered
- CRAM is 12-bit BGR (vs SMS's 6-bit) — 64 bytes vs 32
- START button at port $00 bit 7 (not on PORT_JOY_A)
- Optional stereo via PSG stereo register at port $06
- One controller only — no port 2 fallback patterns

Trust hierarchy:

1. **Bundled examples** (`examples/gg/templates/*.c`).
2. **Bundled runtime** — `src/platforms/gg/lib/c/*` — VDP, joypad,
   sprite_table, sfx, music. All small + readable.
3. **SDCC z80 port** — WASM compiler shipped, source not bundled.
4. **Upstream**:

   | What | Upstream |
   |---|---|
   | SDCC | http://sdcc.sourceforge.net/ |
   | genesis_plus_gx libretro | https://github.com/libretro/Genesis-Plus-GX |

## GG-specific docs

- **SMS Power!** covers GG too: https://www.smspower.org/Development/Documents
  (most pages have GG addendum or work identically)
- **GG-specific extensions** (CRAM depth, START): SMS Power's GG section

For everything else, see `../sms/UPSTREAM_SOURCES.md`.
