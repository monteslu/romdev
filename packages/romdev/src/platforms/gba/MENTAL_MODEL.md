# Game Boy Advance — mental model

One page. Read once before you write your first GBA game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## Runtimes (R28)

Two C runtimes ship bundled. Pass `runtime:` to `buildSource` /
`runSource` to pick:

- **`"libtonc"` (default)** — Tonc-tutorial aligned. `#include <tonc.h>`,
  TTE (Tonc Text Engine) for text via `tte_init_chr4c_default` +
  `tte_write` / `tte_printf`, `tonccpy` / `toncset` for VRAM-safe copy,
  `OBJ_ATTR` shadow buffer + `oam_copy` for sprite updates,
  `key_poll` + `key_held`. Matches what every published tutorial at
  gbadev.net teaches.
- **`"libgba"`** — devkitPro's official SDK. `#include <gba.h>`,
  `REG_DISPCNT`, `MODE3_FB`, `SPRITE_GFX`, `OAM`, `KEY_A`, etc. Opt in
  with `runtime: "libgba"` (or legacy `libgba: true`).
- **`"none"`** — bare gcc + newlib only. For people writing their own
  abstractions or porting bare-metal code.

Sound — both runtimes ship `gba_sfx.h` / `gba_sfx.c` (3 functions:
`sfx_init` / `sfx_tone(channel, freq_period, length)` / `sfx_noise`)
wrapping the DMG-compatible APU. Channels 3 (wave) + Direct Sound are
left to user code (they need more setup than a one-call sfx helper).

## CPU memory map (ARM7TDMI)

```
$00000000-$00003FFF  BIOS ROM (16 KB) — read-only firmware
$02000000-$0203FFFF  EWRAM (256 KB) — slow but big main work RAM
$03000000-$03007FFF  IWRAM (32 KB) — fast on-chip RAM
$04000000-$040003FE  I/O registers (memory-mapped MMIO)
$05000000-$050003FF  BG palette + OBJ palette (1 KB)
$06000000-$06017FFF  VRAM (96 KB) — BG tile data, sprite tile data, framebuffer
$07000000-$070003FF  OAM (1 KB) — sprite attributes
$08000000-$09FFFFFF  Game Pak ROM (up to 32 MB) — your .gba lives here
$0E000000-$0E00FFFF  Game Pak SRAM (64 KB) — battery-backed saves
```

The ARM7TDMI runs in two modes:
- **ARM**: 32-bit instructions, 4 bytes each. Faster on the GBA's
  32-bit IWRAM. Slower on 16-bit-wide ROM.
- **Thumb**: 16-bit instructions, 2 bytes each. Significantly smaller
  code. About the same speed as ARM on ROM (because ROM is 16-bit).
  **Most GBA games default to Thumb** because ROM is the common case.

`-mthumb` switches gcc into Thumb mode. `-mthumb-interwork` allows
mixing ARM + Thumb in the same binary. libgba is built Thumb-interwork.

## Display

```
240×160 pixels visible, 6 BG modes (0-5)

Mode 0: 4 tile BGs, scrolling. The classic 2D Mario-style mode.
Mode 1: 2 tile BGs + 1 affine BG (rotation/scale).
Mode 2: 2 affine BGs only. Mode 7-style perspective.
Mode 3: 240×160 BGR555 framebuffer at $06000000. 16-bit per pixel.
Mode 4: 240×160 palettized 8bpp framebuffer + a back buffer. Faster.
Mode 5: 160×128 BGR555 framebuffer + back buffer.
```

Most published GBA games use mode 0. The `MODE_3` path (used in our
`gba_hello` template) is the simplest — write directly to the
framebuffer like a modern game.

## Sprites (OAM)

128 sprite slots at $07000000. Each entry is 8 bytes:

```
attr0 (16 bits): Y position (8), affine flag, double-size, shape,
                 256-color flag, mosaic, etc.
attr1 (16 bits): X position (9), affine index OR hflip+vflip, size
attr2 (16 bits): tile index (10), priority (2), palette (4)
filler (16 bits)
```

Sprite tile data lives at $06010000-$06017FFF (32 KB = 1024 4bpp tiles
or 512 8bpp tiles). Sprite palette at $05000200-$050003FF.

libgba helpers: `SPRITE_GFX`, `OAM`, `SPRITE_PALETTE`. Compose attr
fields via `OBJ_*` constants in `gba_sprites.h`.

## Tile + map

Mode 0 BG: each BG layer has a 32-tile-wide map at a configurable VRAM
base (`REG_BGxCNT` selects). Tiles are 8x8 4bpp (or 8x8 8bpp); a map
entry is 16 bits = 10-bit tile index + 4-bit palette + 2 flip bits.

## Input

```
REG_KEYINPUT (read-only): bits ACTIVE-LOW (0 = pressed)
  bit 0: A    bit 1: B     bit 2: Select  bit 3: Start
  bit 4: R   bit 5: L      bit 6: U       bit 7: D
  bit 8: R-shoulder         bit 9: L-shoulder
```

libgba wraps this: `KEY_A`, `KEY_B`, etc. masks; `REG_KEYS` returns
the inverted byte so pressed = 1.

## Sound

Two parallel paths:

1. **Tone channels** (4): identical to GBC — 2 squares + 1 wave + 1 noise.
   Backwards-compatible with GBC games. Programmed via $04000060 +.
2. **Direct Sound** (2): 8-bit PCM channels with DMA streaming. The
   modern path for sample-based music. Programmed via $04000082 + DMA.

libgba sound API in `gba_sound.h` covers the tone channels but the
DMA-driven PCM streaming is something you'd typically pair with
maxmod (separate library, not bundled here).

**For scaffold-level sfx**, the libtonc runtime ships a minimal
`gba_sfx.h` / `gba_sfx.c` pair (3 functions: `sfx_init`, `sfx_tone`,
`sfx_noise`) that wraps the DMG-compatible APU directly. Same shape
as the NES/GB scaffold sound API, so cross-platform game ports feel
the same. All 5 GBA genre scaffolds (shmup/platformer/puzzle/sports/
racing) use it.

## Frame heartbeat

```c
/* libtonc setup — REQUIRED before any VBlankIntrWait() call. */
irq_init(NULL);
irq_add(II_VBLANK, NULL);

while (1) {
    VBlankIntrWait();    /* halts CPU until vblank IRQ fires */
    /* update game state */
    /* write to OAM / VRAM */
}
```

`VBlankIntrWait()` calls a BIOS function that puts the CPU to sleep
until the vblank IRQ fires. **You MUST install the IRQ table BEFORE
the first call** (`irq_init(NULL)` + `irq_add(II_VBLANK, NULL)` with
libtonc — `irqInit(NULL)` + `irqEnable(IRQ_VBLANK)` with libgba).
Without this, the BIOS halts the CPU forever waiting for an IRQ that
never fires. ROM appears to compile + load but freezes on frame 1 —
single most common GBA gotcha. Every bundled scaffold does it; copy
the pattern.

## Cart header format

```
$00-$03  ARM 'b' instruction branching to your _start
$04-$9F  Nintendo logo (156 bytes) — required for real-hardware boot
$A0-$AB  Game title (12 ASCII chars)
$AC-$AF  Game code
$B0-$B1  Maker code
$B2-$BB  Header bytes (unit code, device type, version, complement check)
$BC-$BF  Reserved
```

mGBA does NOT enforce the Nintendo logo (which is good — bundling it
would be a copyright issue). The `gba_crt0.s` we ship leaves it as
zeros. Real-hardware ROMs need it; mGBA and our test pipeline run
fine without it.

## Build pipeline

When you call `buildSource({platform:"gba", language:"c"})`:

1. `cc1-arm` (gcc 14.2.0 C frontend, WASM) compiles your `.c` → `.s`
   ARM assembly (Thumb-interwork mode, `-mcpu=arm7tdmi`).
2. `arm-none-eabi-as` (binutils, WASM) assembles each `.s` → `.o`.
3. `arm-none-eabi-ld` (binutils, WASM) links user `.o` + bundled
   `gba_crt0.o` + `crti.o` + `crtbegin.o` + a tiny `fake_heap_end`
   stub + `libgba.a` + `libgcc.a` + `libc.a` + `libnosys.a` +
   `crtend.o` + `crtn.o` per `gba_cart.ld` → ELF.
4. `arm-none-eabi-objcopy` (binutils, WASM) extracts the raw `.gba`
   ROM from the ELF.

Loadable via mGBA (`loadMedia`).

## What's NOT bundled

- **libgba's `console.c`** (iprintf-style stdio output). Pulls in
  devkitPro's libsysbase header chain — not yet ported. See
  TROUBLESHOOTING.md for the trade-off rationale and workarounds.
- **maxmod** (sample-based music driver). Separate library; not
  bundled. Add manually if you need it.
- **devkitARM's `bin2s`** (binary → assembly converter for asset
  pipelines). Not bundled; ship binary assets as C arrays for now.

Everything else from a stock devkitARM install works.

## Horizontal scrolling (for side-scrollers)

GBA tiled BG modes (0-2) give each BG layer a hardware scroll register —
`REG_BG0HOFS` / `REG_BG0VOFS` (and BG1/2/3). Write the camera offset each
frame; scroll a second layer at a fraction of camX for parallax. BG maps are
32×32 (or larger via screen-block size); for a wider world, stream the column
entering view into the map's screen-blocks as the camera advances. A fixed HUD
goes on its own BG layer left unscrolled (or via an HBlank IRQ that resets the
offset for the HUD scanlines). Track camX in pixels; actor screen-X = worldX -
camX.
