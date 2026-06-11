# Game Boy Color — troubleshooting

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

Read MENTAL_MODEL.md first (`platform({op:'doc', platform:"gbc",
name:"mental_model"})`). Most DMG-era troubleshooting from GB applies
unchanged — including the **two SDCC sm83 codegen footguns below**, which are
the #1 cause of a clean-building GBC C game that boots but never renders.

## ⚠ "Sprites/tiles never show AND the CPU crashed (PC near $002B)" — the #1 SDCC footgun

SDCC's sm83 backend **miscompiles a byte-copy loop through an `__xdata`
pointer** — the "copy tiles into VRAM" pattern:
```c
uint8_t *dst = (uint8_t *)0x8000;
for (uint8_t i = 0; i < 16; i++) dst[i] = src[i];   // ☠ writes to the return
                                                    //   address → CPU crash
```
The build succeeds and the ROM boots, so it looks like a logic bug, but it's
codegen — `PC` ends up stuck near `$002B`, sprites/tiles never appear, OAM
stays zero. **Fix:** use the bundled `memcpy_vram(dst, src, n)` (in every
project's `gb_runtime.c`) for ALL copies into VRAM/`__xdata`, never a raw
for-loop. `build({output:'rom'})` with `lint:"strict"` also flags the raw pattern.

## ⚠ "Loop never ends / dead code after a loop" — uint8 loop-bound trap

```c
uint8_t i; for (i = 0; i < 32 * 32; i++) { ... }   // ☠ 255 < 1024 always true
```
A `uint8_t` can't reach a bound >255 → infinite loop, all later code dead. SDCC
gives no warning. Use `uint16_t` for any bound that can exceed 255. (Linter
flags it.) See [[sdcc-uint8-loop-bound-trap]].

## ⚠ "Flat-color screen, no sprites, OAM reads all zero on the first frame(s)"

Your sprites are staged in `shadow_oam` but never reached hardware OAM before
the LCD turned on — so the first visible frame shows power-on garbage / nothing.
Common when you enable the LCD, *then* enter a `wait_vblank()` loop that flushes
OAM only after the wait (so frame 1 renders un-flushed), and especially when you
use the `enable_vblank_irq()` HALT path (the first `wait_vblank()` sleeps the CPU
before you'd flush).

**Fix — DMA the first OAM frame BEFORE enabling the LCD:**
```c
oam_clear();
oam_set(0, y, x, tile, attr);   /* stage your initial sprites */
oam_dma_flush();                /* push to hardware while LCD is still off */
LCDC = LCDC_LCD_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO;   /* THEN turn on */
/* now the loop: wait_vblank(); oam_dma_flush(); ... */
```
Also make sure `oam_dma_init_hram()` ran (lcd_init_default does it) so the DMA
routine executes from HRAM. The bundled `hello_sprite` template shows this exact
order. Diagnose with `sprites({op:'inspect'})` / `background({view:'renderState'})` if a screenshot is
just flat color.

## "ROM boots into green-shade DMG mode, not color"

Header byte `$0143` isn't `$80`. The CGB boot ROM checks this byte
and falls back to DMG mode when it's `$00`.

When you build with `platform:"gbc"`, `build({output:'rom'})` / `build({output:'run'})`
**auto-fix the header** — Nintendo logo, header + global checksums,
and `$0143 = $80` (CGB-enhanced) — so a freshly built `.gbc` already
boots in color. You do **not** call `romPatch({op:'gbHeader'})` for that.

```js
build({ output: 'run', platform: "gbc", language: "c", ... });  /* header auto-fixed */
```

If you instead see green-shade DMG mode, the ROM was almost certainly
built with `platform:"gb"` (so the CGB flag stayed `$00`). Rebuild with
`platform:"gbc"`. Reach for `romPatch({op:'gbHeader'})` only to fix up an existing /
externally built `.gbc` whose header was never set, or to override a
header field (e.g. force `cgb:false`).

## "OCPS / OCPD writes don't change colors"

You're in DMG mode (see above) — those registers don't exist on DMG.
Rebuild with `platform:"gbc"` so the CGB flag is set. Once in CGB mode,
`OCPS` is the sprite palette index (with auto-increment in bit 7),
`OCPD` is the data write.

To write sprite palette 0, color 1 = bright red:

```c
OCPS = 0x80 | (0 * 8) | (1 * 2);  /* auto-inc + palette 0 + color 1 */
OCPD = 0x1F;                       /* low byte: red 31, green 0 */
OCPD = 0x00;                       /* high byte: blue 0 */
```

The `* 8` and `* 2` reflect the BCPS/OCPS layout — 8 palettes × 4
colors × 2 bytes per color = 64 byte index space.

## "BG colors stuck on default — only sprites change"

BG palettes live at BCPS/BCPD ($FF68/$FF69), not OCPS/OCPD. And you
must also write per-tile attribute bytes to VRAM bank 1 selecting
which BG palette (0-7) each tile uses:

```c
VBK = 1;
*(uint8_t*)0x9800 = 0x01;  /* tile at top-left uses BG palette 1 */
VBK = 0;
```

Without the attribute writes, every BG tile defaults to palette 0.

## "Game ran on Game Boy emulator but not on Game Boy Color emulator"

`loadMedia({platform:"gbc", path})` expects gambatte in CGB mode. If
your ROM was built with `platform:"gb"` (no gbHeader patch) the file
extension is `.gb` and the header CGB byte is $00, so gambatte starts
in DMG mode. To switch a DMG ROM to CGB:

1. Rename / re-extension to `.gbc`
2. Run `romPatch({op:'gbHeader', path:"out.gbc"})` — also fixes the global
   checksum that the boot ROM checks

## "BG map updates randomly don't stick" / a tile updates one frame late forever

The core (like real hardware mid-frame) DROPS writes to VRAM ($8000-$9FFF)
that land outside vblank while the LCD is on — silently. A game loop that
pokes the BG map "whenever the state changes" will have SOME of those pokes
land mid-frame and vanish: stale cells, a piece that visually lags the
logical grid, glitches that move around as code timing shifts.

The robust pattern (used by the bundled puzzle example games):

1. **COLLECT** — during the frame, don't touch VRAM. Append (addr, tile)
   pairs to a small RAM queue whenever game state changes a cell.
2. **FLUSH** — immediately after `wait_vblank()` (right after the OAM DMA),
   drain the queue with pure writes. No scanning, no logic — vblank is only
   ~1140 cycles, so the flush must be writes only and bounded.
3. **Scrub** — repaint one or two rows per frame round-robin as insurance,
   so any cell that ever got dropped self-heals within a second.

If you must write outside that structure, turn the LCD off first (only
acceptable during init/load screens — mid-game it flashes white).

## "Sound is the same as DMG"

That's correct — CGB has the **identical** 4-channel APU as DMG. The
`sound_*` API from gb_runtime works unchanged. CGB does NOT add new
sound channels or extra waveforms.

## "ROM size > 32 KB needed"

The bundled GBC example games all fit in 32 KB (single bank, no MBC).
For larger projects use an MBC (memory bank controller). MBC1 / MBC3
work in gambatte; set the `$0147` cartridge type byte accordingly.
romPatch({op:'gbHeader'}) doesn't set this — you write it from your asm/C.

## "Frame heartbeat feels janky / slow"

Default GBC speed is the same as DMG (~4 MHz Z80). Double-speed mode
via KEY1 ($FF4D) doubles CPU but halves audio sample rate + breaks
cycle-counted code. Most homebrew leaves it off; if you need the
extra clocks, change the GB example pattern to:

```c
KEY1 = 1;            /* request speed switch */
__asm__("stop");     /* arm the switch (compiler-specific syntax) */
```

Not bundled in any example — use only if you've measured a need.
