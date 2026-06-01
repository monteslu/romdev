# NES — mental model

One page. Read once before you write your first game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## CPU memory map ($0000-$FFFF)

```
$0000-$00FF  zero page (fast — ldx/ldy/zp,x addressing)
$0100-$01FF  hardware stack (256 bytes)
$0200-$02FF  shadow OAM — by convention, DMA'd to PPU OAM each vblank
$0300-$07FF  WRAM (general-purpose RAM, 1.5 KB)
$0800-$1FFF  mirrors of $0000-$07FF
$2000-$2007  PPU registers (mirrored every 8 bytes through $3FFF)
$4000-$4017  APU + I/O registers
$4018-$401F  test-mode registers (unused)
$6000-$7FFF  cart RAM (mappers only; not present on NROM-256)
$8000-$FFFF  PRG ROM (32 KB on NROM-256, fixed)
```

The cc65 runtime claims:
- ZP $00-$01 reserved (cc65 internal)
- ZP $02-$1B: cc65 C runtime (`c_sp`, tmp1-4, ptr1-4, sreg)
- ZP $1C+ available to your game (with our chr-ram crt0)
- `$0500-$07FF` (3 pages): cc65 C parameter stack

## PPU memory map (separate from CPU bus!)

```
$0000-$0FFF  pattern table 0 — 256 tiles × 16 bytes (sprite tiles by default)
$1000-$1FFF  pattern table 1 — 256 tiles × 16 bytes (BG tiles by default)
$2000-$23FF  nametable 0 + attribute table 0
$2400-$27FF  nametable 1 + attribute table 1
$2800-$2BFF  nametable 2 + attribute table 2 (mirrors NT0 on NROM)
$2C00-$2FFF  nametable 3 + attribute table 3 (mirrors NT1 on NROM)
$3F00-$3F1F  palette RAM (32 bytes)
```

PPU memory is accessed by the CPU via the registers `$2006` (PPUADDR)
and `$2007` (PPUDATA). To write byte X to PPU address $1234:

```c
PPUADDR = 0x12;     /* high byte first */
PPUADDR = 0x34;     /* low byte second */
PPUDATA = x;        /* PPUADDR auto-increments by 1 (or 32 if PPUCTRL.2 set) */
```

Important: VRAM is only safely writable when **rendering is off**
(via `PPUMASK = 0`) OR during vblank. Writing during the visible
frame corrupts the scroll registers and produces rainbow garbage.

## Sprites (OAM)

64 sprites × 4 bytes each = 256 bytes. The convention is to keep a
"shadow OAM" buffer at WRAM $0200 and DMA-copy it to PPU OAM each
vblank via `$4014 = $02`.

Bytes per sprite:
- **byte 0 (Y):** screen Y minus 1. Y=$EF..$FF hides the sprite.
- **byte 1 (tile):** index into the sprite pattern table.
- **byte 2 (attr):** palette (bits 0-1), priority (bit 5), flip H/V
  (bits 6/7).
- **byte 3 (X):** screen X (0-255).

The hardware draws **at most 8 sprites per scanline.** The 9th+ are
dropped. You can rotate which sprites get priority by reshuffling
OAM each frame.

## Backgrounds (nametables + attribute tables)

A nametable is 32×30 = 960 bytes. Each byte selects a tile from the
BG pattern table.

The attribute table is 64 bytes following each nametable ($23C0..$23FF
for NT0). Each byte covers a 4×4 tile group — 16 tiles — with 4
quadrants of 2 bits each:

```
bit 7-6   bit 5-4
bottom    bottom
right     left

bit 3-2   bit 1-0
top       top
right     left
```

Each 2-bit value selects one of the 4 BG palettes. So **every 2×2
tile group within the 4×4 attribute byte shares a palette.** This is
the single biggest source of NES color confusion.

The `nes_runtime` helper `tile_set_palette(nt, x, y, palette)` does
the read-modify-write dance and the bit-twiddling — use it instead
of writing attributes by hand.

## Palettes

32 bytes at $3F00-$3F1F:
- $3F00: universal backdrop color
- $3F01..$3F03: BG palette 0 (colors 1,2,3 — color 0 always backdrop)
- $3F04: mirrors $3F00 (often skipped)
- $3F05..$3F07: BG palette 1
- $3F08..$3F0F: BG palettes 2-3
- $3F10..$3F1F: same shape for sprite palettes 0-3 (color 0 is
  transparent for sprites, NOT backdrop)

The NES color table is a fixed 64-entry list (palette index 0..$3F)
indexing into hardware colors. See `getPlatformPalettePng({platform:"nes"})`
for the full table.

## NMI (vblank interrupt)

The PPU fires NMI at the start of vblank (line 241) when
**PPUCTRL bit 7** is set. Our crt0 wires `nmi:` to a handler that:

1. Saves A/X/Y on the stack.
2. Does OAM DMA: `STA $4014` with A=$02 → copies $0200..$02FF to PPU OAM.
3. Flushes the VRAM queue (writes pending palette/nametable changes).
4. Resets PPUADDR to $2000 (otherwise the queue's last $2006 write
   leaves a dangling latch and rendering is wrong).
5. Sets PPUSCROLL from `scroll_x` / `scroll_y` globals.
6. Sets PPUCTRL from `ppuctrl_value` global.
7. Increments `nmi_counter` so `ppu_wait_nmi()` can return.
8. Restores A/X/Y, RTI.

You don't write this handler. `nes_runtime.c` provides it.

## Game-loop pattern

Canonical NES C loop:

```c
void main(void) {
    /* INIT (PPU off) */
    ppu_off();
    chr_ram_upload(0x0000, sprite_tiles, sprite_tiles_size);
    chr_ram_upload(0x1000, bg_tiles, bg_tiles_size);
    palette_load(palette);
    /* render initial nametable here via vram_unsafe_set or queue */
    oam_clear();
    oam_spr(player_x, player_y, player_tile, 0);
    ppu_on_all();

    /* GAME LOOP */
    for (;;) {
        /* Stage sprites for the upcoming frame FIRST. */
        oam_clear();
        oam_spr(player_x, player_y, player_tile, 0);
        /* Stage VRAM writes via vram_set / tile_set / tile_set_palette. */

        /* Block until vblank — NMI handler will DMA shadow_oam and
         * flush the VRAM queue. */
        ppu_wait_nmi();

        /* Read input, update game state. */
        pad = pad_poll(0);
        if (pad & PAD_RIGHT) ++player_x;
        /* ... */
    }
}
```

**Order matters.** If you stage sprites AFTER `ppu_wait_nmi`, you're
writing to a shadow_oam that's already been DMA'd a frame earlier —
your changes show up a frame late OR not at all (if oam_clear is mid-write
when the next NMI fires).

## Vblank cycle budget

Roughly 2270 CPU cycles available during vblank for NMI work. Our
NMI handler uses:
- OAM DMA: 513 cycles
- PPUADDR/PPUSCROLL/PPUCTRL reset: ~30 cycles
- ~50 cycles of prologue/epilogue
- Remainder for `vram_queue_flush`: ~1670 cycles

Each VRAM queue entry costs 3 PPU writes + bookkeeping ≈ 15 cycles.
At 24 entries per queue, that's ~360 cycles. Comfortably within budget.

## What `createProject` copies into your project

`createProject({platform:"nes", template:"hello_sprite"|"tile_engine"|"default"})`
writes these files into your project directory. **They're yours** — every
byte that compiles is in the repo. Edit, fork, replace; nothing is auto-injected
at build time.

| File | Provides |
|---|---|
| `main.c` | Your game's entry point (the template). |
| `nes_runtime.h` | API: `ppu_*`, `oam_*`, `pad_*`, `palette_*`, `chr_ram_upload`, `tile_set`, `tile_set_palette`, `vram_set`, `ppu_scroll`, PAD_* masks. |
| `nes_runtime.c` | Helper implementations. Linked as an extra TU. |
| `chr-ram-runtime.crt0.s` | Custom crt0 with NMI handler (OAM DMA + VRAM queue flush + scroll reset). Clears CHR-RAM at boot so BG tile 0 is blank. Includes the iNES header. |
| `chr-ram-runtime.cfg` | Linker config: NROM-256, CHR-RAM, vertical mirroring, OAM segment at $0200. |
| `README.md` | Build invocation + "rebuild outside MCP" instructions. |

Build calls explicitly point at these files via `sourcesPaths` /
`includePaths` + `linkerConfig: <contents of chr-ram-runtime.cfg>`. The
project README shows the exact incantation.

## Five footguns to know before you start

Read these BEFORE writing your game-loop. Each one cost a previous
agent several rounds.

### 1. Framebuffer is 256×224, not 256×240

The PPU renders 240 scanlines but the standard NES output crops
the top 8 + bottom 8 pixels (overscan). Anything in nametable row
0 (`$2000-$201F`, top 8 px) or row 29 (`$23A0-$23BF`, bottom 8 px)
is in the nametable but NOT on screen.

Keep HUD/score at **row 2** (`tile_set(0, x, 2, t)`) and bottom
prompts at **row 27** or earlier.

### 2. shadow_oam at $0200 is INITIALIZED to all $FF by the crt0

The bundled crt0 writes `$FF` to every byte of `_shadow_oam`
($0200-$02FF) at boot — canonical sprite-Y off-screen sentinel.
`readMemory(nes_oam)` returning all `$FF` after a few frames can
mean "DMA copied the source page faithfully because the source
was all `$FF` when NMI fired" — NOT "DMA broken."

Sentinel test that proves DMA works before opening a bug:
```js
pause()
writeMemory({region:"system_ram", offset:0x0200, hex:"42".repeat(256)})
resume(); stepFrames({frames:1})
readMemory({region:"nes_oam", offset:0, length:16})
// All $42 → DMA fine. All $FF → real DMA bug.
```

### 3. Loop order matters for sprite visibility

The NMI handler fires at vblank start and DMAs whatever shadow_oam
contains AT THAT MOMENT. If you `ppu_wait_nmi()` FIRST and stage
sprites AFTER, ~50% of frames DMA the cleared (`$FF`)-filled
shadow_oam because the NMI sometimes catches you between
`oam_clear` and `oam_spr`. Sprite flickers on/off every other
frame.

Always stage first, then sleep:
```c
for (;;) {
  /* game logic / input / state update */
  oam_clear();
  oam_spr(...);
  tile_set(...);            // queue BG writes
  ppu_wait_nmi();           // NMI DMAs the sprites you just staged
}
```

### 4. BSS placement is mapper-dependent

The bundled `chr-ram-runtime.cfg` puts `RAM:` at `$0300-$04FF`
(512 bytes in real internal RAM between OAM at $0200 and the C
stack at $0500). DON'T move it to `$6000` unless you also set
iNES flags6 bit 1 (battery WRAM) — NROM-no-battery has $6000-$7FFF
unmapped, and BSS reads return open bus. Globals look like they
work but `_nmi_counter` never advances and any "wait until counter
== target" loop hangs.

For projects that outgrow 512 bytes of BSS: opt into a mapper that
provides PRG-RAM at $6000 (MMC1/MMC3 etc.) rather than widening the
$0300-$04FF region (you'd collide with the C stack).

### 5. PPUCTRL bit 4 = BG pattern table at $1000

Default `ppuctrl_value = $90` sets bit 4 → BG fetches tiles from
PPU `$1000-$1FFF`. So upload BG tiles via
`chr_ram_upload(0x1000 + tile_idx * 16, ...)`, not $0000.

Sprites are at $0000 by default (PPUCTRL bit 3 = 0). Mixing them
up = "sprite/BG render garbage" or "BG renders sprite tiles
incorrectly aligned."

## What's NOT done for you

- Music — `sound_init()` + `sound_play_tone(channel, period, vol, length)`
  + `sound_play_noise(period, vol, length)` + `sound_off()` cover the
  common "beep on event" SFX pattern using the APU's pulse/triangle/noise
  channels. For multi-channel sequenced music with envelopes / vibrato /
  pattern playback, roll your own — famitone2 is the standard NES sound
  driver but isn't bundled.
  - **Debugging / transcribing sound:** `getAudioState({chip:"nes"})` decodes
    the live APU register file ($4000-$4017) into per-channel
    {pulse1, pulse2, triangle, noise, dmc} with note names, freq, duty and
    volume — use it to confirm "is my channel actually playing the pitch I
    think?" To capture a note timeline over time (e.g. to port a tune to
    another platform), watch the registers: `watchMemory({region:"nes_apu_regs",
    onChange:"reset", outputPath:...})` logs each note onset, or
    `recordSession({memorySamples:[{region:"nes_apu_regs",...}], sampleEvery:1,
    memoryOutputPath:...})` streams per-frame samples to disk.
- Mapper support — only NROM-256 (32 KB PRG, no banks) is wired. For
  MMC1/MMC3/UNROM you'll need a different linker config.
- IRQ — the IRQ vector returns. Most NES games use a custom IRQ
  handler for mid-frame scroll splits; you'll need to write that asm.
- Multi-screen scrolling — the runtime sets one nametable; for big
  scrolling worlds you need to manage the nametable buffer + bank
  switching yourself.

## When to drop to asm

Game-loop in C is fine for ~80% of homebrew. Drop to asm when:
- You need cycle-accurate timing (sprite-0 hit splits, raster effects)
- You need fast inner loops (e.g. soft-render scanlines)
- You're writing the sound driver

Otherwise stay in C — it's easier to evolve and the cc65 codegen is
good enough for most game logic.
