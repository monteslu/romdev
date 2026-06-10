# Game Gear — mental model

One page. Read once before you write your first GG game.

## CPU + memory map

```
Z80A @ 3.58 MHz, 8 KB cartridge RAM (system RAM bigger via mapper).
$0000-$3FFF  ROM bank 0 (fixed)
$4000-$7FFF  ROM bank 1 (mapper-switchable via port $FE)
$8000-$BFFF  ROM bank 2 (mapper-switchable via port $FF)
$C000-$DFFF  Work RAM
$E000-$FFFB  Work RAM mirror
$FFFC-$FFFF  Mapper control registers
```

Most 32 KB example games fit in banks 0+1 and never touch the mapper.

## VDP (display)

GG VDP = SMS VDP in Mode 4, smaller visible viewport.

- **Framebuffer:** 256×192 (same as SMS)
- **Visible:** 160×144 centered (48 px border each side, 24 px top/bottom)
- **Modes:** only Mode 4 (256×192 tile + sprite) is useful — the other
  TMS9918 modes are inherited but not used.
- **Palette:** 32 entries × 12-bit BGR (4-4-4) — twice the depth of
  SMS. Each CRAM entry is 2 little-endian bytes. BG entries 0-15,
  sprite entries 16-31.
- **Tile size:** 8×8, 4bpp planar. 448 tile slots × 32 bytes each.
- **Sprites:** 64 SAT entries, 8×8 or 8×16 mode. **Hardware limit: at
  most 8 sprites per scanline.** Extra sprites on the same row are
  silently dropped by the VDP — symptom is "the first 8 letters of
  my 14-letter title render, the rest are invisible." For text
  overlays > 8 chars on the same row, split across multiple Y rows
  OR draw the text via the BG name table (no per-line limit).

**Always render gameplay content inside (48, 24)..(207, 167)** so it's
visible on real hardware. The bundled example games work without this
because gpgx shows the full framebuffer.

### Sprite coords are hardware-space, NOT visible-space

The libretro core's screenshot returns only the 160×144 visible region,
but the bytes you write to OAM are still in 256×192 hardware
coordinates. An 8×8 sprite at OAM `(X=48, Y=24)` appears at the
**top-left of the visible region** (which is the same hardware-coord
`(48, 24)`). The visible region is OAM `x ∈ [48, 207]`, `y ∈ [24, 167]`.

To center a sprite on screen: target OAM `(48 + 76, 24 + 68)` for
roughly visible center, not `(80, 72)`.

The `sprites({op:'inspect'})` tool's X/Y fields report hardware coords too —
match them up with hardware-coord arithmetic, not visible-coord.

### SAT $D0 terminator — still a hazard if you write $D0 yourself

The SMS/GG renderer treats Y=$D0 in **any** OAM Y byte as a HARD
terminator — it stops scanning further sprite slots the moment it
hits one. Earlier rounds of the bundled `gg_sprite_init()` wrote
$D0 to every Y byte to "hide" sprites at boot — that caused the
classic "I populated slots 0..5 and slot 6 was still $D0 so the
renderer halted at slot 5" footgun.

**The runtime now initialises unused slots to $E0** (off-screen,
below the 192-line area, but NOT the terminator). Slots you don't
touch stay invisible AND don't kill the renderer. You only have
to worry about $D0 if you write it explicitly — e.g. to stop
sprite scanning early as an optimisation.

If sprites past a certain slot are missing in `sprites({op:'inspect'})`,
check the live OAM Y bytes for $D0 in a slot before them. That's
still the diagnosis; the runtime just doesn't create the problem
on its own anymore.

### R6 sprite-tile-base: default is $2000 (0xFF)

`gg_vdp_init()` sets R6 = 0xFF. R6 bit 2 is the SA13 select for
sprite tile data — bit 2 is **SET** in 0xFF, so sprite tiles read
from `$2000-$3FFF`, in their **own bank** separate from BG tiles at
$0000. This is the baseline because every bundled example uploads
its sprite tiles to `$2000` (`gg_load_tiles(0x2000, …)`) — the
default and the examples match, so sprites Just Show Up.

Watch the bit: 0xFB has SA13 **CLEAR** = sprite tiles at $0000
(sharing the BG bank). If you ever set R6=0xFB you MUST also upload
your sprite tiles to $0000, or the VDP reads the empty/BG bank and
every sprite is invisible — the classic GG/SMS "my sprites don't
show up" trap.

The `sprites({op:'inspect'})` tool's `spriteTileDataBase` field reports the
address the VDP is actually reading from — trust that over any
comment.

## I/O port map

```
$06   PSG stereo control (write — L/R routing per channel)
$3E   memory control (mostly leave alone)
$3F   I/O control (mostly leave alone)
$7E   read = V-counter; write = ignored
$7F   read = H-counter; write = PSG (4-channel SN76489)
$BE   VDP data
$BF   VDP control (address + register write)
$DC   joypad A — D-pad + B1 + B2 (active low)
$DD   joypad B — extra (mostly unused on GG)
$00   GG-specific: bit 7 = START button (active low)
$01-$05  GG-specific: link cable, sound balance, etc.
```

### Driving input over MCP — the button map is INVERTED ⚠

Game Gear runs on genesis_plus_gx, which maps the two face buttons onto libretro
the *opposite* of the obvious way (verified live against the core — same as SMS):

| Physical button | `input({op:'set', …})`  | spatial / native |
|-----------------|-------------------|------------------|
| Button 1 (main fire) | `{ b: true }` | `{ west: true }` · `input({op:'press', button:'1'})` |
| Button 2             | `{ a: true }` | `{ east: true }` · `input({op:'press', button:'2'})` |
| START               | `{ start: true }` | — |

**The trap:** `input({op:'set', a: true})` presses **button 2**, not button 1. For the
main fire use `{ b: true }` / `{ west: true }`. Prefer spatial names or
`input({op:'press', button:'1'|'2'})` over raw a/b. `input({op:'layout', platform:'gg'})`
has the exact map.

## Audio

SN76489 PSG — same chip as SMS + Genesis. 4 channels: 3 squares + 1 noise.

Write-only via port `$7F`. See `gg_sfx.h`/`gg_sfx.c` for the canonical
wrapper (sfx_init / sfx_tone / sfx_noise / sfx_update / sfx_off — same
function shape as nes_runtime / gb_runtime / gba_sfx / genesis_sfx /
sms_sfx).

Optional: GG-only stereo register at port `$06` (bits 0-3 = which
channels route to the right speaker, bits 4-7 = same for left).
Defaults to mono — write `0xFF` for "all channels to both speakers"
explicitly.

**Debugging sound:** `audioDebug({op:'inspect', chip:"psg"})` decodes the live SN76489 —
3 tone + 1 noise channel state (the same gpgx PSG region serves GG/SMS/Genesis).

## Frame heartbeat

```c
#include "gg_hw.h"
#include "gg_sfx.h"

void main(void) {
    gg_vdp_init();
    sfx_init();
    gg_vdp_display_on();

    while (1) {
        gg_vblank_wait();
        sfx_update();
        /* update game state, stage SAT, etc. */
    }
}
```

## MCP debug & inspection tooling

Game Gear runs on the same genesis_plus_gx (gpgx, patched) core as SMS, so the
inspectors are identical. **The canonical reference lives in the SMS
MENTAL_MODEL** (`src/platforms/sms/MENTAL_MODEL.md`, "MCP debug & inspection
tooling" section): `sprites({op:'inspect'})`, `tiles({op:'png'})`,
`cpu({op:'read'})` (Z80), `background({view:'renderState'})`,
`audioDebug({op:'inspect', chip:'psg'})` (SN76489, the shared
SMS/GG/Genesis region), and the z80 `objdump` disasm pipeline all apply
unchanged.

Game-Gear-only deltas:

- **`palette({source:'live'})`** decodes **12-bit BGR (4-4-4)**, twice the
  depth of SMS's 6-bit. CRAM is **64 bytes** (2 little-endian bytes per
  entry) instead of 32.
- The Game-Gear memory regions are **`gg_vram`** and **`gg_cram`** (the
  64-byte palette); use these instead of `sms_vram` / `sms_cram`. The
  `sms_vdp_regs` / `sms_z80_regs` register regions are shared (same VDP and
  Z80).
- `sprites({op:'inspect'})` X/Y fields are reported in **256×192 hardware
  coordinates**, not the 160×144 visible window — match them with
  hardware-coord arithmetic (see "Sprite coords are hardware-space" above).

## Differences from SMS — quick reference

- Visible 160×144 vs 256×192 — center content
- 12-bit CRAM vs 6-bit — palettes are 64 bytes vs 32
- One controller only (no port 2)
- START button at port $00 bit 7 (not on PORT_JOY_A)
- Optional PSG stereo register at port $06
- ROM header magic is identical to SMS ("TMR SEGA" at $7FF0)

Everything else (Z80, VDP control protocol, tile format, sprite SAT
layout, joypad polling, BG name table at $3800) is identical to SMS.
You can use sms_hw.h notes + helpers as a reference; the GG runtime
files in lib/c/ are direct ports.
