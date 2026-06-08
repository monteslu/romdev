# Game Boy Color — mental model

The Game Boy Color is the DMG (original Game Boy) with **color
extensions** layered on. Most of the hardware (CPU, instruction set,
VRAM layout, OAM, sound) is identical to DMG. Color adds:

## Five silent-failure footguns to know before you start (R26 + R27)

These are GB-tree problems that bite identically on GBC because the
runtime is the same SDCC sm83 port + same DMA hardware + same
cartridge-header format. All five have shipped fixes in the bundled
runtime + tools, but a custom build that bypasses them hits exactly
the same wall.

1. **Cartridge header must be FULLY patched, not just logo + checksums.**
   `build({output:'rom'})` / `build({output:'run'})` do this for you at build time: every byte
   at $0134..$014C is filled, and on `platform:"gbc"` the CGB flag at
   $0143 is set to $80 (CGB-aware + DMG-compatible). You do **not** run
   `romPatch({op:'gbHeader'})` on a freshly built ROM. Reach for `romPatch({op:'gbHeader'})` only
   to fix up an existing / externally built ROM whose header was never
   set, or to override a field — e.g. starting from a `.gb` ROM and
   wanting CGB color, pass `cgb: true` explicitly.

2. **OAM shadow buffer must be page-aligned.** `shadow_oam` is pinned
   at $C100 in the bundled runtime via `__at (0xC100)`. If you roll
   your own buffer, pick an address with `0x00` in the low byte. OAM
   DMA reads only the high byte and copies 160 bytes from `$XX00`.

3. **Raw VRAM stores can be optimized away.** Use `memcpy_vram(dst,
   src, n)` from `gb_runtime.h` (volatile-safe by construction) or
   cast through `volatile uint8_t *`. See `lib/c/SDCC_GOTCHAS.md`
   § "Writes to VRAM".

4. **OAM DMA must run from HRAM.** During the ~160 µs OAM DMA window
   the CPU can ONLY fetch from HRAM ($FF80-$FFFE). The bundled
   `oam_dma_copy()` installs a 9-byte stub at $FF80 and CALLs it; the
   stub spins from HRAM where DMA can't conflict. Pre-r55 the spin
   ran from ROM and fetched $FF for every instruction → `rst $38` →
   stack corruption → intermittent LCDC = $FF, BG VRAM wiped, sprites
   jump. `lcd_init_default()` auto-installs the stub; if you bypass
   that helper, call `oam_dma_init_hram()` yourself before any DMA.

5. **`gb_crt0.s` zeros BSS correctly.** Pre-r55's gsinit zeroed
   `_INITIALIZED` (wrong section — gets overwritten by the copy loop)
   instead of `_DATA` (actual BSS). Result: uninitialized statics
   booted with WRAM garbage. The fixed crt0 zeros `_DATA` from
   `s__DATA` for `l__DATA` bytes; bring-your-own crt0 should do the
   same.

6. **Don't poke a hardcoded `$C0xx` WRAM pointer for game state — it
   overlaps your statics.** SDCC links the C runtime's data + BSS (every
   `static` global: your PRNG seed, your grids, your scores) at the BOTTOM
   of WRAM starting `$C000`. A `volatile uint8_t *board = (uint8_t*)0xC000;`
   then scribbles right over `static uint32_t rng = ...;` et al. Symptom
   looks exactly like an SDCC *codegen* bug — e.g. a 32-bit xorshift PRNG
   that "degenerates" so every roll is identical (its seed is being
   clobbered, not miscompiled). **Use a `static` array and let the linker
   place it** (`static uint8_t board[78]; board[i]=p;`), or hardcode at
   `$C200`+ and confirm with the linker map (`build({includeSymbols:true})`
   → check `s__DATA`/`s__BSS`). Full write-up + repro in
   `lib/c/SDCC_GOTCHAS.md` § "sm83 codegen traps in plain game logic".

- **Two VRAM banks** (switched via VBK at $FF4F) — bank 0 holds tile
  pattern data, bank 1 holds per-tile BG attributes (palette index,
  H/V flip, priority, tile bank).
- **8 BG palettes × 4 colors** (indexed via BCPS/BCPD at $FF68/$FF69).
- **8 sprite palettes × 4 colors** (indexed via OCPS/OCPD at
  $FF6A/$FF6B).
- **Each color is 15-bit BGR** (5+5+5), stored as two little-endian
  bytes per entry.
- **Double-speed mode** via KEY1 ($FF4D) — Z80 runs at ~8 MHz instead
  of ~4 MHz. Most homebrew ignores this; lots of cycle-counted code
  breaks under it.
- **HDMA** ($FF51-$FF55) for fast block transfers during HBlank —
  used for live tile streaming.

## MCP debug & inspection tooling

GBC shares the patched gambatte core with DMG, so **all the live inspectors
and `gb_*` memory regions documented in the GB MENTAL_MODEL apply unchanged
here** — `sprites({op:'inspect'})`, `tiles({op:'png'})`, `cpu({op:'read'})`,
`audioDebug({op:'inspect', chip:'gb'})`, and the `gb_vram` / `gb_oam` / `gb_io`
/ `gb_hram` / `gb_cpu_regs` regions (same gotcha: it's `gb_vram`, NOT the
generic `video_ram`). Disassembly routes through the same `-m gbz80` objdump.
See the GB MENTAL_MODEL for the shared gambatte debug tooling.

CGB-only deltas on top of that shared set:

- **`palette({source:'live'})`** on a CGB ROM decodes the **64-byte BCPS/OCPS
  palette RAM** into **8 palettes × 4 colors in BGR555** (the DMG path that
  decodes BGP/OBP0/OBP1 bytes is what runs on a `gb` build instead). The raw
  CGB palette RAM is also readable directly via the **`gb_bgpdata`** (BG, 64
  bytes) and **`gb_objpdata`** (OBJ, 64 bytes) memory regions.
- **`background({view:'renderState'})`** reports the CGB extras the DMG path
  doesn't have: the current **VRAM bank** (VBK), **KEY1** (double-speed state),
  and the live **BCPS/OCPS palette index**.

## CGB vs DMG mode

The CGB boot ROM checks header byte **`$0143`**:
- `$00` → DMG mode (4 grays only, no color)
- `$80` → CGB-enhanced mode (color works, DMG-compat fallback)
- `$C0` → CGB-only mode (refuses to boot on a DMG)

**Every bundled GBC scaffold is built with `$0143 = $80`** — `build({output:'rom'})`
/ `build({output:'run'})` set this automatically at build time when `platform:"gbc"`,
so a freshly built `.gbc` boots in color with no extra step. (Build it as
`platform:"gb"` instead and the flag stays `$00` → DMG green-shade mode,
and OCPS/BCPS writes do nothing.)

## Palette setup

```c
/* Sprite palette 0, color 1 = red */
OCPS = 0x80 | 0x01;        /* auto-increment + index = palette 0, color 1 */
OCPD = (uint8_t)(0x001F & 0xFF);
OCPD = (uint8_t)((0x001F >> 8) & 0xFF);
/* Subsequent writes to OCPD advance the index. */

/* Same shape for BG palette via BCPS/BCPD. */
```

15-bit BGR encoding:
```
bit 14..10  blue   (0..31)
bit  9..5   green  (0..31)
bit  4..0   red    (0..31)
```

White = `0x7FFF`. Black = `0x0000`. Bright red = `0x001F`.

## Tile attributes (BG bank 1)

To use the BG palettes you must:

1. Switch VRAM bank: `VBK = 1`.
2. Write attribute bytes to the same offsets as the tile-map ($9800+).
3. Switch back: `VBK = 0`.

Attribute byte layout:
```
bit 0..2  palette index (0..7)
bit 3     tile bank (0 or 1)
bit 4     unused
bit 5     H-flip
bit 6     V-flip
bit 7     BG-over-OBJ priority
```

## Audio

Identical to DMG — same 4-channel APU. `sound_init` / `sound_play_tone`
/ `sound_play_noise` / `sound_off` from `gb_runtime.h` work unchanged
on GBC. See the GB MENTAL_MODEL.md for the channel layout.
`audioDebug({op:'inspect', chip:"gb"})` decodes the live APU on GBC too.

## Frame heartbeat

Same as DMG:

```c
#include "gb_hardware.h"
#include "gb_runtime.h"

void main(void) {
    sound_init();
    /* setup palettes via BCPS/BCPD + OCPS/OCPD */
    /* enable LCD */
    while (1) {
        wait_vblank();
        /* update OAM, palettes, scroll */
    }
}
```

## Input

Joypad is identical to DMG — `JOYP` ($FF00), row-select multiplex, active-low
(see the GB mental model for the read sequence).

### Driving input over MCP

gambatte maps `input({op:'set'})` button names **straight through** — verified live, no
inversion: `{a}`→A, `{b}`→B, `{start}`/`{select}`, plus the d-pad (spatial
east→A, west→B). So `input({op:'set', a: true})` presses GBC A as expected — unlike
the genesis_plus_gx platforms (Genesis/SMS/GG), there's no surprise here.

## Scaffolds

All GB scaffolds (`shmup`, `platformer`, `puzzle`, `sports`, `racing`,
`hello_sprite`, `tile_engine`) compile identically as GBC ROMs — the
bundled GB runtime is already CGB-aware (writes OCPD/OCPS for color).
The genre scaffolds inherit from GB via `TEMPLATES.gbc = TEMPLATES.gb`;
the only differences at build time are:

- ROM extension: `.gbc` (vs `.gb`)
- the build sets `$0143 = $80` to flip CGB mode on (automatic when you
  build with `platform:"gbc"` — no manual `romPatch({op:'gbHeader'})` step)
- gambatte core accepts both DMG + CGB-mode ROMs

For new GBC code that wants to be CGB-only (no DMG fallback) set the
CGB byte to `$C0` instead of `$80` — `romPatch({op:'gbHeader', path, cgb:true})`
on the built ROM can override it.

## Horizontal scrolling (for side-scrollers)

Identical to DMG: write `SCX` ($FF43) each frame for hardware scroll through
the wrapping 32×32 BG map, and stream the next BG-map column (its tile IDs +,
on CGB, its BG attribute byte in VRAM bank 1) each time the camera crosses an
8-px boundary. Use the Window (LCDC bit 5) for a fixed HUD. CGB adds nothing
that changes the scroll mechanism — just remember the per-tile attribute in
bank 1 when you stream columns. See the GB MENTAL_MODEL for the full pattern.
