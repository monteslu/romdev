# Sega Genesis / Mega Drive — troubleshooting

When something's broken. Read MENTAL_MODEL.md first for the "what's
going on" version (via `getPlatformDoc({platform:"genesis", name:"mental_model"})`).

## "ROM builds but the screen is blank / black"

The Genesis VDP starts in forced-blank state. SGDK's sega.s + libmd
lift the blank during boot, but only if your `main()` calls into the
SGDK frame heartbeat. **You MUST call `SYS_doVBlankProcess()` at least
once** before anything appears on screen — it primes the DMA queue,
flushes initial palette + tile uploads, and ticks the sprite engine.

Specifically: a `main()` that just runs `while (1) { /* nothing */ }`
will boot, but you'll never see anything because the DMA queue never
runs.

Fix:

```c
while (1) {
    /* ... your per-frame work ... */
    SYS_doVBlankProcess();
}
```

## "Sprites don't appear"

Two failure modes:

1. **You staged sprites via `VDP_setSprite()` but didn't call
   `VDP_updateSprites(n, DMA)`.** SGDK buffers SAT writes in a RAM-
   side cache and only flushes them to VRAM when you call
   `VDP_updateSprites`. Without the flush, the VDP draws stale (or
   zero) SAT entries.
2. **You used the sprite engine (`SPR_init`/`SPR_addSprite`) but
   didn't call `SPR_update()` each frame.** Same problem at a
   different layer — the engine maintains its own state and only
   pushes to the SAT on `SPR_update`.

Either fix:

```c
/* low-level path */
VDP_setSprite(0, x, y, SPRITE_SIZE(1,1), TILE_ATTR_FULL(...));
VDP_updateSprites(1, DMA);

/* high-level path */
SPR_setPosition(player, x, y);
SPR_update();
```

## "Colors are wrong / everything is one shade of green"

The Genesis colour encoding is **BGR**, not RGB, and each channel is
3 bits (0..7). The full word is `0BGR` packed in 4-bit nibbles:

- `$0EEE` = white (B=14, G=14, R=14 — 14 saturates to 7 in hw)
- `$000E` = bright red
- `$00E0` = bright green
- `$0E00` = bright blue
- `$0000` = black

If you're seeing all-green, you wrote RGB-ordered values (the green
nibble is in the middle of both layouts, so it survives).

## "Build fails with `undefined reference to '_system'`"

You're using a newlib that wasn't patched for bare-metal m68k. Our
WASM toolchain's libc was built with `-DNO_EXEC` and you shouldn't
see this. If you do, you may be linking against a different libc
that the project shipped — check that `libmd.a` + the bundled
`libc.a` are what link is finding.

## "Build fails with `relocation truncated to fit: R_68K_PC16`"

68000 short-form branches (`bra.s`, `bcc.s`) reach only ±128 bytes.
Long-form (`bra`, `bcc`) reach ±32 KB. Some compiler-generated jump
tables and stub helpers fall foul when libgcc.a / libc.a links pull
in too much. Workarounds:

- Use `-fno-jump-tables` to suppress jump-table generation.
- Compile with `-Os` (size-optimize) — packs code more densely.
- Split monolithic functions into smaller ones (each gets its own
  PC-relative branch budget).

## "ROM boots in genesis_plus_gx but fails on real hardware (TMSS)"

TMSS-equipped consoles (model 2 onward) require the 68000 to write
the four ASCII bytes `'S' 'E' 'G' 'A'` to $A14000 within ~500ms of
boot. SGDK's sega.s does this. If you bypassed SGDK's crt0 (e.g.
custom linker script that doesn't include `sega.o`), you'll boot
fine on genesis_plus_gx (no TMSS) but fail on real hardware.

Fix: keep `sega.o` (built from `sega.preprocessed.s`) in your link
list. Or, write your own TMSS unlock in your custom crt0.

## "Sound is silent"

Three layered things to check:

1. **YM2612 is muted at reset.** SGDK's XGM2_init() unmutes it; if
   you're using XGM2, just call `XGM2_init()` once before
   `XGM2_startPlay()`.
2. **Z80 reset/busreq isn't released.** If you bypass SGDK's sound
   API and want to write YM2612 registers directly, you must first
   write 1 to `$A11200` (Z80 reset off) and 0 to `$A11100` (busreq
   off). Genesis Plus GX is lenient here; real hardware isn't.
3. **PSG (SN76489) writes go to $C00011 *byte-wise*.** A `move.w` to
   $C00011 silently writes only the low byte; use `move.b`.

## "Save states don't restore Z80 state"

The libretro core needs to capture the Z80 RAM ($A00000-$A0FFFF) +
the bus-grant state. If you've stored game state in Z80 RAM (rare
but possible) and save state is missing your data on reload, it's
likely the core doesn't snapshot Z80 RAM by default. Workaround:
keep persistent state in 68000 WRAM ($FF0000+) — that's always
snapshotted.

## "First C build is slow (1-2 s) but later ones are instant"

This is expected. cc1-m68k.wasm is 17.5 MB and gets mmap-loaded into
a worker on first invocation. Subsequent builds reuse the warm worker
pool (R12 crash-isolation infrastructure). The cold-start hit is
unavoidable; the steady-state cost is sub-second.

## "Genesis ROM header is wrong (region, IO support, ROM range)"

`rom_header.c` defines these via `const u32 rom_header[]` style arrays
that the C compiler emits as the 256-byte SEGA header. The bundled
default declares NTSC + PAL + JP region, 3-button + 6-button + mouse
IO support, and a 4 MB ROM size. Edit `rom_header.c` (it's plain C
data) to change these.

The header checksum at offset $18E is computed by the link step from
your code+data; don't hand-edit it.

## "My splash / title screen is the right shapes but all one color and choppy/striped"

You hand-rolled the PNG→tile conversion and got the byte encoding
wrong. The symptom — correct silhouette, everything in one color
(usually red), vertical striping — means your tile bytes were raw
RGB-ish values instead of 4bpp **palette indices**, and/or the row
stride / nibble packing was off. The high nibble of each byte is the
LEFT pixel; each nibble is a 0..15 index into a 16-color CRAM line,
not a color.

**Don't hand-roll it. Use the `imageToTilemap` MCP tool** — it dedupes
tiles, bin-packs colors across the 4 palette lines, and emits correct
4bpp packed bytes + a 16-bit-BE name-table + the CRAM palette in one
call:

```
# 1. Source must be 320×224.
# 2. Quantize to the Genesis palette:
getPlatformPalettePng({ platform:"genesis", format:"png", outputPath:"/tmp/gen_pal.png" })
magick splash.png -dither FloydSteinberg -remap /tmp/gen_pal.png splash_q.png
# 3. Convert:
imageToTilemap({ platform:"genesis", pngPath:"splash_q.png", outputDir:"splash_out/" })
```

You get `splash_out/chr.bin` (deduped tiles), `nametable.bin`
(40×28 16-bit-BE entries), `palette.bin` (4×16 CRAM words), and
`preview.png`. **Open `preview.png` first** — it's the tool rendering
its own output, so a correct preview guarantees a correct in-game
result. Then DMA `chr.bin` to VRAM, load `palette.bin` into CRAM, and
write `nametable.bin` to your Plane A base (set plane width = 64 cells).
The tool response `note` restates the exact sizes + destinations.

If `imageToTilemap` returns `genesis.warnings[]` about cells with >16
colors, your source crams too many colors into one 8×8 cell (the VDP's
hard limit) — re-author those regions or accept the per-cell
approximation.

## "I want to use SGDK's image converter / `bmp.h` / .bmp loading"

First choice for any PNG → tiles+tilemap+palette conversion: the
**`imageToTilemap` MCP tool** (see the splash-screen section above). It
needs no native tools and produces ready-to-DMA blobs.

The full SGDK helper-tool suite (`rescomp`, `bintos`, `convsym`,
`xgmtool`) isn't yet ported to WASM. You can still use these tools
**natively** on a build machine to produce the .bin / .o / .pal /
.tileset blobs, then drop them into your rom-dev-mcp project as
binary `extraSources` — the rom-dev-mcp build will just incbin them.

For a handful of hand-drawn tiles, you can also author them as
`u32[8]` arrays in C (4bpp tile format = 8 rows × 4 bytes each, two
pixels per byte). The shipped `hello_sprite`, `tile_engine`, `shmup`,
`platformer`, `puzzle` templates use this approach. **But never
hand-encode a full-screen image this way** — that's the red/choppy
failure above.
