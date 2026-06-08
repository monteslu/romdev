# Sega Genesis / Mega Drive — troubleshooting

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

When something's broken. Read MENTAL_MODEL.md first for the "what's
going on" version (via `platform({op:'doc', platform:"genesis", name:"mental_model"})`).

## "My C build is throwing 68000 assembler errors (identifier expected / missing reset vector)"

That means the file was assembled as 68k by vasm68k instead of compiled as
C. **Genesis C builds through m68k-elf-gcc + SGDK** (`#include <genesis.h>`),
**not** vasm68k — vasm68k is only for hand-written 68000 assembly. You do NOT
need to write assembly. The build now infers the language from your source
(a `.c` file / C content → gcc), so the common cause is forcing it the wrong
way: if you passed `language:"asm"`, drop it; if your source has no `.c`
filename AND no obvious C tokens, pass `language:"c"` explicitly. (Reverse case:
a `.s` asm file builds via vasm68k — that's correct.)

## "I drive the game with setInput but the jump/action button doesn't fire"

The Genesis button map is **inverted** vs the libretro names. genesis_plus_gx
maps Genesis A/B/C onto libretro **y/b/a** — so `input({op:'set', a:true})` presses
Genesis **C**, not A. An SGDK action bound to `BUTTON_A` (the usual jump) won't
fire from `{a:true}`.

Fix — press the button you actually mean:
- `BUTTON_A` → `input({op:'set', ports:[{y:true}]})` or spatial `{west:true}`
- `BUTTON_B` → `{b:true}` / `{south:true}`
- `BUTTON_C` → `{a:true}` / `{east:true}`

Prefer the spatial names or `input({op:'press', button:'c'})` (they resolve correctly
per platform). `input({op:'layout', platform:'genesis'})` has the full map. (Note:
`input({op:'set'})` takes a `ports` array — `{ports:[{y:true}]}`, not a bare `{y:true}`.)

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
   `XGM2_play()`. (The R58 driver fn is `XGM2_play`, not `XGM2_startPlay` —
   and feed it a COMPILED XGM2 blob from `encodeAudio({target:'xgm2', vgmPath})`,
   not raw VGM.)
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

**Don't hand-roll it. Use the `encodeArt({stage:'tilemap'})` MCP tool** — it dedupes
tiles, bin-packs colors across the 4 palette lines, and emits correct
4bpp packed bytes + a 16-bit-BE name-table + the CRAM palette in one
call:

```
# 1. Source must be 320×224.
# 2. Quantize to the Genesis palette:
palette({ source:'platformMaster', platform:"genesis", format:"png", outputPath:"/tmp/gen_pal.png" })
magick splash.png -dither FloydSteinberg -remap /tmp/gen_pal.png splash_q.png
# 3. Convert:
encodeArt({ stage:'tilemap', platform:"genesis", pngPath:"splash_q.png", outputDir:"splash_out/" })
```

You get `splash_out/chr.bin` (deduped tiles), `nametable.bin`
(40×28 16-bit-BE entries), `palette.bin` (4×16 CRAM words), and
`preview.png`. **Open `preview.png` first** — it's the tool rendering
its own output, so a correct preview guarantees a correct in-game
result. Then DMA `chr.bin` to VRAM, load `palette.bin` into CRAM, and
write `nametable.bin` to your Plane A base (set plane width = 64 cells).
The tool response `note` restates the exact sizes + destinations.

If `encodeArt({stage:'tilemap'})` returns `genesis.warnings[]` about cells with >16
colors, your source crams too many colors into one 8×8 cell (the VDP's
hard limit) — re-author those regions or accept the per-cell
approximation.

## "I want to use SGDK's image converter / `bmp.h` / .bmp loading"

First choice for any PNG → tiles+tilemap+palette conversion: the
**`encodeArt({stage:'tilemap'})` MCP tool** (see the splash-screen section above). It
needs no native tools and produces ready-to-DMA blobs.

Some SGDK helper tools (`rescomp`, `bintos`, `convsym`) aren't ported to WASM;
you can run them natively on a build machine to produce .bin / .o / .pal /
.tileset blobs, then drop them into your romdev project as binary includes — the
build will just incbin them.

**Music is covered, though:** VGM→XGM2 compilation (SGDK's Java `xgm2tool`) is
ported to pure JS and exposed as `encodeAudio({target:'xgm2', vgmPath, name})`
— it emits a 256-aligned C array you `#include` and `XGM2_play()`. No native
tool / Java needed. (PCM SFX: `encodeAudio({target:'xgm2pcm'})`.)

For a handful of hand-drawn tiles, you can also author them as
`u32[8]` arrays in C (4bpp tile format = 8 rows × 4 bytes each, two
pixels per byte). The shipped `hello_sprite`, `tile_engine`, `shmup`,
`platformer`, `puzzle` templates use this approach. **But never
hand-encode a full-screen image this way** — that's the red/choppy
failure above.

## "Horizontal movement / scrolling feels choppy or judders"

Almost always: **you're rewriting the tilemap in the frame loop.** The
Genesis scrolls in HARDWARE — moving the world is two register writes
(`VDP_setHorizontalScroll`), which cost nothing. If you instead redraw a
plane every frame (a `VDP_fillTileMapRect` / `VDP_loadTileMap` / big
`DMA_*` each frame), you overrun the vblank DMA budget and drop frames →
judder. Fix: paint the planes ONCE at setup; the loop only nudges scroll
registers + re-stages sprites. The `template:"two_plane_parallax"`
scaffold is the known-good shape.

Diagnose it without guessing (no core rebuild):

- **Per-frame VDP work:** `watch({on:'dma', perFrame:true, frames:120,
  pressDuring:[{frame:0, button:'right', holdFrames:120}]})` → a per-frame
  `[{frame, bytes, romBytes, ramBytes}]` timeline + `spikes`. A smooth
  loop is a LOW, FLAT curve (just the SAT/scroll refresh). A `spikes`
  entry (bytes ≫ avg, esp. `romBytes`) IS the per-frame asset-upload /
  tilemap-rewrite mistake. (Counts DMA bytes only — non-DMA single-cell
  `VDP_setTileMapXY` pokes aren't counted; the expensive whole-plane work
  always uses DMA and does show.)
- **Motion curve:** sample the player-X + both planes' HSCROLL ($F000 in
  `video_ram`) over 180 frames while holding a direction — see
  MENTAL_MODEL.md "Why does horizontal movement feel choppy?". Look for
  scroll that jumps (non-constant per-frame delta) or a camera that moves
  while the sprite's screen-X is frozen.

For a world WIDER than one 512-px plane, don't make the plane bigger and
don't redraw it — stream ONE offscreen column per 8-px camera step
(circular-buffer the 64-cell plane). See MENTAL_MODEL.md "How Sonic-style
large maps REALLY work".
