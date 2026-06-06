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
- **Genesis WRAM is host-LE word-byte-swapped** in gpgx, so a 16-bit value reads
  with its two bytes swapped at the offset (0x1234 → bytes `34 12`). Read the
  word and account for it, or read single bytes.
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

SGDK exposes both via the XGM2 driver. For SFX/music:

```c
extern const u8 my_music[];  // XGM2-format track
XGM2_startPlay(my_music);
XGM2_stop();
SND_PSG_*  // legacy 4-channel PSG playback
```

Hand-rolling YM2612 register pokes is possible but rarely worth it
unless you're building a music engine.

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
