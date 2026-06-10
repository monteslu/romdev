# Sega Genesis / Mega Drive — mental model

One page. Read once before you write your first Genesis game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## CPU memory map ($000000-$FFFFFF, 68000 24-bit)

```
$000000-$3FFFFF   cart ROM (4 MB max — typical homebrew cart is 256 KB - 4 MB)
$A00000-$A0FFFF   Z80 sound CPU RAM (64 KB window when bus is granted)
$A10000-$A1001F   IO ports (controllers, version, region)
$A11100-$A11101   Z80 busreq + reset
$A14000-$A14003   TMSS (lock-out — write "SEGA" to $A14000 on boot)
$C00000-$C00007   VDP data + control + HV counter
$C00011           PSG (SN76489) — write-only
$FF0000-$FFFFFF   work RAM (64 KB, mirrored $00FF... via 16M layout)
```

A few quirks worth knowing:

- **WRAM is at the TOP of the address space** ($FF0000-$FFFFFF), not the
  bottom. The stack pointer initialises to $00FFE000 (top of WRAM,
  minus 8 KB headroom).
- **The 68000 must NEVER write to ROM space**, even by mistake. Writing
  to $000000-$3FFFFF triggers a bus error.
- **Z80 RAM is only visible when the 68000 has bus-grant**. SGDK
  handles this for you when you use the sound API.
- **TMSS:** on a TMSS-equipped console (model 2+) the 68000 must
  write "SEGA" to $A14000 within the first few seconds, or the
  console refuses to start the VDP. SGDK's sega.s does this.

## Reading your C globals headlessly — assert state, don't screenshot ⭐

Every "did the score go up / did HP drop / did the level change?" check is one
byte of RAM, not a screenshot. Build with debug, resolve the symbol, read it:

```
b   = build({output:'romWithDebug', platform:'genesis', source, inline:true})
sym = symbols({op:'resolve', map: b.mapText, name:'score'})
// → { address:0xE0FF004A, ramOffset:0x4A, readHint:"... region:'system_ram', offset:0x4a ..." }
memory({op:'read', region:'system_ram', offset: sym.ramOffset, length:2})
```

- **SGDK links work-RAM through the $E0FF0000 mirror** (hardware mirrors $FF0000
  across the high bus). The emulator exposes that 64 KB as `system_ram`, indexed
  by the **low 16 bits** of the symbol address — `symbols({op:'resolve'})` hands
  you that `ramOffset` + the exact `memory({op:'read'})` recipe, so you never
  compute the mirror by hand.
- **`static` file-local globals resolve too** (SGDK emits per-symbol sections).
  A non-`static` global that's never *read* can be optimised away at -O2 — mark
  game-state vars you inspect `volatile` (you want that anyway).
- **WRAM (`system_ram`) is normalized to CPU byte order** — offset X is the
  byte the 68k sees at $FF0000+X, words read big-endian as expected, and
  offsets line up with disassembly addresses and cheat-DB maps. (gpgx stores
  work RAM host-LE word-swapped internally; the host un-swaps it. Before
  0.28.0 the raw swapped layout leaked through — value-search/diff loops were
  self-consistent, but any offset cross-referenced against a `move.b $FFxxxx`
  in a disassembly was off-by-XOR-1.)
- **PC → which function?** `symbols({op:'addr', pc, symbolsText: b.mapText})` maps
  a live `cpu({op:'read'}).pc` to the enclosing C function.

This replaces ~20 verification screenshots a session with 1-byte reads.
`memory({op:'snapshot'})` + `memory({op:'diff'})` before/after an event answers
"which bytes did this touch?" when you don't know the symbol yet.

## VDP (Video Display Processor) — separate bus

The VDP has its own VRAM (64 KB), CRAM (128 bytes), VSRAM (80 bytes).
You don't address it directly; you talk to it through `$C00000`
(data port) and `$C00004` (control port).

```
VRAM   64 KB   tile patterns + name-tables + sprite-attribute-table
CRAM  128 B    4 palettes × 16 colors × 2 bytes (BGR, 9-bit)
VSRAM  80 B    per-column vertical scroll values
```

The two display planes:

- **Plane A** (foreground) — name-table address configurable via VDP
  reg 2. SGDK puts the font here, so `VDP_drawText` writes plane A.
- **Plane B** (background) — name-table address via VDP reg 4. Use
  this for your world tile-map; it sits *behind* plane A.

Plane sizes are configurable (32×32, 64×32, 32×64, 64×64 cells).
Default H40 mode is 40 cells wide × 28 tall visible (320×224 px).

## Sprites (sprite-attribute table — SAT)

The SAT lives in VRAM at an address set by VDP reg 5. Up to 80 entries
(64 displayable in H32 mode, 80 in H40), 8 bytes each:

```
+0 Y position (10-bit, offset by 128 — Y=128 is top of screen)
+2 size (4 bits w × 4 bits h, in tiles)
+3 link (next sprite in chain — SAT is a linked list)
+4 attribute: palette (bits 13-14), priority (bit 15), HV flip, tile index
+6 X position (10-bit, offset by 128)
```

The VDP draws at most **20 sprites per scanline** (H40), **16 per
scanline** (H32). Beyond that the rest are dropped.

**SGDK convention:** don't poke the SAT yourself. Use either the
sprite engine (`SPR_init`, `SPR_addSprite`, `SPR_update`) for
animated sprites, or the lightweight `VDP_setSprite()` + `VDP_updateSprites()`
direct-VDP path if you only need static images.

**Lifting a character from another Genesis ROM:** a visible character is
usually several SAT entries (multi-cell hardware sprites) referencing
non-contiguous VRAM tiles in column-major order. Don't crop a screenshot
or a tile sheet — use `sprites({op:'capture', platform:"genesis", slots|rect})`
which reads the live SAT, copies the referenced tiles in hardware order,
and emits tiles + palette + layout + an SGDK `_draw()` helper. Use
`sprites({op:'group'})` first to find which slots form one character. See
AGENTS.md → "Lifting a Genesis CHARACTER".

## Tiles

Tiles are 8×8 pixels, 4 bits per pixel (4bpp = 16 colors per tile).
A tile is 32 bytes in VRAM. The VDP holds 2048 tiles max in 64 KB.

SGDK reserves the low ~512 tiles for the system font + UI; user tile
data starts at `TILE_USER_INDEX`. Upload tiles via `VDP_loadTileData()`
(DMA or CPU push, depending on the `TransferMethod` arg).

**Converting an image to tiles** (sprite sheet, or a full-screen
splash/title image): use the `encodeArt({stage:'tilemap'})` MCP tool — it produces
correct 4bpp packed tiles + tilemap + palette and a preview PNG in one
call. **Do not hand-encode a full-screen picture** as `u32[8]` arrays;
that's the #1 way to get a "right shapes, all-red, choppy" splash
screen. See TROUBLESHOOTING.md → "My splash / title screen is the right
shapes but all one color".

## Palette

CRAM holds 4 palettes × 16 colors × 2 bytes = 128 bytes. Colour 0
of each palette is the transparent / backdrop colour. The colour
encoding is BGR, 3 bits per channel, with 4-bit alignment:

```
$0BGR  → e.g. $0EEE = white, $000E = bright red, $0E00 = blue
```

(Yes — blue and red are reversed from the "usual" RGB order.)

SGDK macros: `PAL0..PAL3` for palette indices, `PAL_setColor(absidx, val)`
where `absidx = pal * 16 + col`.

## Frame heartbeat

```
while (1) {
    update_game_state();
    draw_world_to_plane_b();
    stage_sprites();
    SYS_doVBlankProcess();   // blocks until vblank, drives DMA queue,
                             // sprite-engine update, joypad poll,
                             // sound driver tick.
}
```

**Without `SYS_doVBlankProcess()`** SGDK's DMA queue never flushes →
your sprite updates never appear on screen. It's the single most
important call in any SGDK game loop.

## Scrolling, parallax & the feel trap ⭐

This is the section to read before you build a side-scroller. The #1
"my horizontal movement feels choppy/juddery" bug on Genesis is a
software mistake, not a hardware limit:

> ### ⚠️ DO NOT rewrite full tilemaps in the frame loop.
> The Genesis scrolls in HARDWARE. Moving the world is **two register
> writes** (`VDP_setHorizontalScroll`), which are free. If instead you
> redraw the plane each frame (a big `VDP_setTileMapXY`/`VDP_loadTileMap`
> burst or a per-frame DMA), you overrun vblank, drop frames, and the
> scroll judders. **Paint the planes ONCE at setup; the loop only nudges
> scroll registers and re-stages sprites.** Use the
> `template:"two_plane_parallax"` scaffold as the known-good shape.

### Hardware scroll, the whole loop

A two-plane parallax scroller's *entire* per-frame render cost is:

```c
VDP_setHorizontalScroll(BG_A, -camX);        // foreground: 1:1 with world
VDP_setHorizontalScroll(BG_B, -(camX >> 4)); // background: 1/16 speed = far depth
/* ...stage sprites in SCREEN space... */
VDP_setSprite(0, playerScreenX, playerY, SPRITE_SIZE(2,2), attr);
VDP_updateSprites(1, DMA);                    // flush the SAT
SYS_doVBlankProcess();                        // flush DMA queue, sync vblank
```

No `VDP_setTileMapXY` / `VDP_fillTileMapRect` / `VDP_loadTileMap` in the
loop. Those are SETUP calls (and tiny one-off updates — a coin that
vanishes, a door that opens). They are NOT for whole-plane runtime
redraws. Positive `camX` scrolls the plane LEFT, so you write the
NEGATIVE camera offset. `VDP_setVerticalScroll` is the vertical twin
(it writes VSRAM — see `genesis_vsram`).

### Logical plane size vs HARDWARE plane size

A common confusion: **the Genesis has ONE shared plane-size setting for
BOTH planes A and B** (VDP regs 16). You pick 32×32 / 64×32 / 32×64 /
64×64 *cells* once; you do NOT get an independent size per plane. So a
"32-cell-wide level" still lives inside a 64-cell **physical** plane if
that's the hardware size you set — the extra cells are just offscreen
buffer. The scroll value wraps within the physical plane
(64 cells = 512 px), which is exactly what makes a fully-painted plane
tile forever with no redraw. Don't fight this: pick a hardware plane
size and treat your logical world coords separately.

| Plane size (cells) | Pixels   | Use                                  |
|--------------------|----------|--------------------------------------|
| 32×32              | 256×256  | single-screen / small wrap           |
| **64×32** (default)| 512×256  | horizontal scroller (one plane wide) |
| 32×64              | 256×512  | vertical scroller                    |
| 64×64              | 512×512  | uses the most VRAM for name tables   |

### How Sonic-style large maps REALLY work (wider than one plane)

You do NOT make the plane "as wide as the level," and you do NOT redraw
the plane. The 64-cell hardware plane is a **circular buffer**: as the
camera advances, the column scrolling OFF the left re-appears on the
right (the scroll wraps mod 512 px). You keep the visible window full by
updating exactly **ONE offscreen column** each time the camera crosses
an 8-px tile boundary:

```c
// camX in pixels; world is an array wider than 512 px.
s16 newTileCol = camX >> 3;
if (newTileCol != lastTileCol) {
    // the column about to enter view on the right edge:
    s16 worldCol  = (camX + SCREEN_W) >> 3;
    s16 planeCol  = worldCol & 63;          // wrap into the 64-cell plane
    drawWorldColumn(planeCol, worldCol);    // ONE column, ~28 cells — tiny
    lastTileCol = newTileCol;
}
```

That's ~28 tile writes per 8 px of travel, not a 1792-cell plane redraw.
The `template:"platformer"` scaffold scrolls within one plane (no
streaming); add the column-stream above to go wider. (Real Sonic also
splits the screen with H-blank raster effects for independent strips —
that's an IRQ/raster topic, see the `asm` template.)

## Why does horizontal movement feel choppy? — motion-trace it headlessly ⭐

When movement feels off, don't trial-and-error with screenshots. Sample
the player's world-X, the camera scroll, and the actual VDP scroll
values over ~180 frames while holding a direction, and read the curve.
Two signatures to look for:

1. **Camera scroll changes while the sprite's screen-X barely moves**
   (or vice-versa) → your camera-follow math is off; the world slides
   under a frozen-looking player, or the player slides on a frozen world.
2. **Scroll JUMPS** (non-monotone, big steps) → you're scrolling by a
   non-constant amount per frame (variable-rate camera, or you only
   update scroll on a tile boundary instead of every frame).

The exact call — hold RIGHT, sample player-X + both planes' HSCROLL +
VSRAM over 180 frames. Expose the player/camera vars as `volatile`
globals so they resolve (see "Reading your C globals headlessly"); the
HSCROLL table lives in VRAM (`video_ram`), default base **$F000**
(`frame({op:'verify'})`'s render summary prints "H-scroll table: $Fxxx"):

```js
b   = build({output:'romWithDebug', platform:'genesis', source, inline:true,
             resolveSymbols:['g_player_x','g_cam_x']})
// → resolvedSymbols.g_player_x.ramOffset (system_ram offset)
recordSession({
  frames:180, sampleEvery:10, includeScreenshots:false,
  holdInputs:[{right:true}],
  memorySamples:[
    {label:'player_x', region:'system_ram', offset: PLAYER_X_OFF, length:2},
    {label:'cam_x',    region:'system_ram', offset: CAM_X_OFF,    length:2},
    {label:'hscrollA', region:'video_ram',  offset:0xF000,        length:2},
    {label:'hscrollB', region:'video_ram',  offset:0xF002,        length:2},
    {label:'vsram',    region:'genesis_vsram', offset:0,          length:4},
  ],
})
```

Read the columns: `player_x` should ramp smoothly; `hscrollA` should
move 1:1 with the camera and `hscrollB` at the parallax ratio; both
should be **monotone** (no jumps) while RIGHT is held. ⚠ Genesis WRAM +
VRAM read **word-byte-swapped** in gpgx (a 16-bit `0x00F0` reads as
bytes `F0 00`) — account for the swap, or read single bytes. For a
compact value-vs-frame curve of just the HSCROLL table use
`watch({on:'mem', region:'video_ram', offset:0xF000, length:4,
format:'series', pressDuring:[{frame:0, button:'right', holdFrames:180}]})`.

## Is the loop doing too much VDP work? — per-frame DMA budget ⭐

The render-side cause of choppy scroll is **too many VDP/DMA bytes per
frame** (a tilemap rewrite, an asset re-upload). Measure it directly,
no core rebuild:

```js
watch({on:'dma', perFrame:true, frames:120,
       pressDuring:[{frame:0, button:'right', holdFrames:120}]})
```

returns a per-frame timeline `[{frame, dmas, bytes, romBytes, ramBytes}]`
plus `avgBytesPerFrame`, `peakFrame`/`peakBytes`, and `spikes`.

- A **smooth hardware-scroll loop** shows a LOW, FLAT curve — after boot
  it's mostly the steady SAT/scroll refresh (`ramBytes`, single/low
  double digits per frame).
- A **`spikes` entry** (bytes ≫ average, especially `romBytes` — an
  asset upload FROM cart ROM) is the "I rewrote a tilemap / re-uploaded
  tiles in the frame loop" smell. Move that work to setup, or stream
  ONE column per 8-px scroll step (above).

**CEILING / what this does NOT catch:** this counts mem→VDP **DMA**
bytes (the dominant cost). Plain CPU writes to the VDP data port —
`VDP_setTileMapXY` without DMA, single-cell pokes — are not DMA and are
NOT counted; catching *those* would need a core-side VDP-data-port write
hook (a gpgx patch, not shipped). In practice the expensive per-frame
mistakes (whole-plane fills, `VDP_loadTileMap`, big `DMA_*` transfers)
ALL go through DMA and DO show up here, so the budget is a reliable
choppiness diagnostic today. There is no exposed per-frame
"vblank-cycles-used / overrun" counter either — infer overrun from the
byte budget (DMA bandwidth in vblank is finite: ~7.6 KB to VRAM in PAL
vblank, less in NTSC; a frame moving multiple KB to VRAM is at risk).

## Input

`u16 pad = JOY_readJoypad(JOY_1)` returns a packed bitmask. The
button bits are:

```
BUTTON_UP   = 0x0001    BUTTON_A     = 0x0040
BUTTON_DOWN = 0x0002    BUTTON_B     = 0x0010
BUTTON_LEFT = 0x0004    BUTTON_C     = 0x0020
BUTTON_RIGHT= 0x0008    BUTTON_START = 0x0080
                        BUTTON_X/Y/Z = 0x0400/0x0200/0x0100  (6-button pad)
                        BUTTON_MODE  = 0x0800
```

`JOY_1` is the first controller, `JOY_2` the second. Edge-detect by
xor-ing this frame against last frame and AND-ing with the new state.

### Driving input over MCP — the Genesis button map is INVERTED ⚠

When you drive the game headlessly with `input({op:'set'})`/`input({op:'press'})`, the raw
libretro button names are **NOT** the Genesis A/B/C labels. genesis_plus_gx
maps the printed Genesis buttons **A/B/C onto libretro y/b/a** (verified live
against the core). So:

| You want (SGDK)   | `input({op:'set'})`                    | spatial name |
|-------------------|-------------------------------------|--------------|
| `BUTTON_A`        | `{ y: true }`                       | `{ west: true }`  |
| `BUTTON_B`        | `{ b: true }`                       | `{ south: true }` |
| `BUTTON_C`        | `{ a: true }`                       | `{ east: true }`  |
| `BUTTON_START`    | `{ start: true }`                   | —            |
| X / Y / Z (6-btn) | `{ x: true }` / `{ north: true }` / `{ l: true }` | — |

**The trap:** `input({op:'set'})` presses Genesis **C**, *not* A — so an
SGDK jump bound to `BUTTON_A` won't fire from `{a:true}`. Use `{ y: true }` (or
the spatial `{ west: true }`) for `BUTTON_A`. The **spatial names**
(north/east/south/west) and `input({op:'press'})` resolve correctly per
platform — prefer them over raw a/b/x/y. `input({op:'layout', platform:'genesis'})`
returns the exact map in `faceButtons`. (This inversion is a genesis_plus_gx
quirk shared by SMS + Game Gear; NES/SNES/GB/GBA/etc. are NOT inverted.)

## Sound

The Genesis has *two* sound chips:

- **YM2612** — 6 FM operators + DAC. Goes through the M68000 → bus
  to $A04000-$A04003 via Z80 (most idiomatic) or direct $C00011 for
  the PSG-only path.
- **SN76489** (PSG) — same chip as the SMS. 3 square + 1 noise.

SGDK exposes both via the XGM2 driver. For music:

```c
extern const u8 my_music[];   // COMPILED XGM2 blob (.incbin'd) — NOT raw VGM
XGM2_play(my_music);          // the R58 fn is XGM2_play (there is NO XGM2_startPlay)
XGM2_stop();
```

**Genesis music how-to (the whole path):** author a `.vgm` (any tracker/VGM
export), then **compile it to XGM2** — `XGM2_play()` needs a *compiled* blob
(split FM/PSG streams + a sample table), not raw VGM. romdev does the compile
for you with **`encodeAudio({target:'xgm2', vgmPath, name})`** → a ready-to-`#include`
256-aligned C array + `<NAME>_LEN`. Then `XGM2_play(name)`. (The compiler is a
pure-JS port of SGDK's `xgm2tool` — no Java/jar to install.) For PSG-only tunes
this coexists with XGM2 *PCM* SFX (`encodeAudio({target:'xgm2pcm'})`); for FM
music it uses the YM2612.

NOTE: the legacy `xgmtool` / `.xgc` / `XGM_*` driver is a DIFFERENT, older format
— don't feed an `.xgc` to `XGM2_load`/`XGM2_play`, it'll misparse. Use the XGM2
path above. Hand-rolling YM2612 register pokes is possible but rarely worth it.

**Sampled SFX (PCM):** XGM2 plays 8-bit signed PCM samples on its PCM channels
(`XGM2_playPCM(sample, len, SOUND_PCM_CH1)` /
`XGM2_playPCMEx(..., priority, halfRate, loop)`). The sample format is strict and
easy to botch by hand — let **`encodeAudio({target:'xgm2pcm'})`** do it (path in → ready C array +
`<NAME>_LEN` out). The rules it enforces:
- **8-bit SIGNED** mono (not unsigned — a wrong sign is silent garbage).
- **13.3 kHz** native, or **6.65 kHz** with `halfRate` (then play with
  `XGM2_playPCMEx(..., TRUE, ...)`).
- length padded to a **multiple of 256 bytes** (zero = silence).
- the sample buffer must be **256-byte aligned** in ROM —
  `__attribute__((aligned(256)))` (the emitted C does this for you).

**Debugging sound:** `audioDebug({op:'inspect'})` returns a raw-blob snapshot
of the FM chip (gpgx's struct isn't safely per-channel decodable — useful for
frame-to-frame diffing), and `audioDebug({op:'inspect'})` decodes the SN76489
(3 tone + 1 noise channel state, same chip as SMS/GG). To check a sample actually
played, `audioDebug({op:'record'})` writes a WAV you (a human) can listen to — there is **no**
headless per-PCM-channel "is it playing" readout for Genesis yet (it would need a
core patch to expose the XGM2 Z80 driver state), so audio verification here is
record-and-listen, not assert.

## MCP debug & inspection tooling

The shipped genesis_plus_gx (gpgx) core is patched for live introspection.
Video is deeply readable; the FM audio chip is only partially exposed:

- **Sprites:** `sprites({op:'inspect'})` decodes the live SAT.
- **Palette:** `palette({source:'live'})` reads live CRAM.
- **CPU:** `cpu({op:'read', cpu:'main'})` reads the 68000.
- **Audio (limited):** `getYm2612State` returns the YM2612's internal
  struct as a raw blob — gpgx doesn't expose it in a safely per-channel
  decodable form (good for frame-to-frame diffing, see "Debugging sound").
  `getPsgState` decodes the SN76489 (3 tone + 1 noise channels).
- **Memory regions:** `memory({op:'read'})` exposes CRAM, VSRAM, VDP_REGS,
  Z80_RAM (the sound CPU's RAM), M68K work RAM, YM2612, PSG, and VRAM.
  Remember the gpgx byte-swap quirk for VRAM: it reads host-LE
  word-byte-swapped (a 16-bit value's two bytes are swapped at the offset)
  — use tiles({op:'pixels'}) to decode in render order. M68K work RAM
  (`system_ram`) is NOT affected: it's normalized to CPU byte order (see
  "Reading your C globals headlessly").

## Break-instant truth: registersAtHit + pure calls (0.28.0)

gpgx schedules its CPUs per scanline, so a `breakpoint` hit mid-frame used to
leave the LIVE register file hundreds of instructions past the hit by the time
you could read it — chasing pointer registers read that way burned a real
session for ~2h. Fixed two ways:

- **`registersAtHit`** — `breakpoint({on:'pc'|'write'|'read'})` hits now carry
  the FULL register file (d0-d7/a0-a7/pc/sr/sp) frozen by the core at the hit
  instant. Use it, never a follow-up `cpu({op:'read'})`. The reported `pc` for
  write/read hits is the EXECUTING instruction's first byte (pre-0.28.0 it was
  the post-prefetch PC — one instruction late). On a pc-break the 68k also
  stays FROZEN for the rest of the frame, so even live reads agree.
- **`cpu({op:'call', pure:true})`** — steps ONLY the 68k: no VDP lines, no
  Z80, no interrupts raised. Without it, a driven routine that spans frames
  runs the game's own VBlank logic concurrently — which can stomp the output
  buffer you're capturing (a real session diffed a CORRECT codec
  reimplementation against that poisoned "ground truth" for hours). Prefer
  `pure:true` for every decompressor/codec call; non-pure results carry a ⚠
  caveat when frame logic ran. (SMS/GG get the same via the shared core.)

## ROM layout

```
$000000-$0000FF   68000 vector table (64 entries × 4 bytes)
$000100-$0001FF   ROM header (region, name, checksum, IO support, ROM range)
$000200-          your code + data
```

The checksum lives at $18E and must be correct on a real console
(emulators don't enforce it). SGDK's `rom_header.c` provides a
template you fill in (game name, region codes, etc.) and the
build pipeline computes the checksum on link.

## Where the SDK lives (and how to read it)

`scaffold({op:'project', platform:"genesis"})` ships the full SGDK include
tree into the new project at `vendor/sgdk/`. So when your code does
`#include <genesis.h>`, those headers come from
`vendor/sgdk/include/`:

```
vendor/sgdk/include/genesis.h       ← top-level umbrella
vendor/sgdk/include/vdp.h           VDP_*, VDP_setReg, VDP_setPalette
vendor/sgdk/include/vdp_bg.h        VDP_drawText, VDP_setHorizontalScroll
vendor/sgdk/include/sprite_eng.h    SPR_init, SPR_addSprite, SPR_update
vendor/sgdk/include/sys.h           SYS_doVBlankProcess, SYS_disableInts
vendor/sgdk/include/joy.h           JOY_init, JOY_readJoypad, BUTTON_*
vendor/sgdk/include/sound.h         SND_startPlay_PCM, SND_isPlaying_PCM
vendor/sgdk/include/xgm2.h          XGM2_play, XGM2_pause (music)
vendor/sgdk/include/dma.h           DMA_doTransfer, DMA_queue
```

To find what an SGDK function does, GREP the vendor tree — the C
source ships at `vendor/sgdk/src/`. Same pattern as the Lynx cc65
vendor dir and SNES PVSnesLib: the agent reads the library it's
calling instead of guessing from header comments.

## Build pipeline

When you call `build({output:'rom'})`:

1. `cc1-m68k` (gcc 14.2.0 C frontend, WASM) compiles your `.c` →
   `.s` assembly.
2. `m68k-elf-as` (binutils, WASM) assembles each `.s` → `.o`.
3. `m68k-elf-as` also assembles `rom_header.c` (via cc1 → as) →
   raw 256-byte ROM header `.bin`.
4. `m68k-elf-ld` (binutils, WASM) links all `.o` + `libmd.a` +
   `libgcc.a` + `libc.a` per `md.ld` → ELF executable.
5. `m68k-elf-objcopy` (binutils, WASM) extracts the raw binary
   image from the ELF → `.bin` Genesis ROM.

Loadable via genesis_plus_gx (`loadMedia`).
