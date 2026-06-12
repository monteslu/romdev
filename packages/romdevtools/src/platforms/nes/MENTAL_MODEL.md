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

> **cc65 zero-page starts at $02, not $00 (applies to every cc65 platform —
> NES, C64, Atari, Lynx, …).** cc65 reserves `$00-$01` for its runtime, so your
> first `.res 1` in the `ZEROPAGE` segment lands at **$02**, not $00. If you
> hand-write asm that assumes a zero-page var is at $00 you'll clobber the
> runtime. Confirm actual addresses with `symbols({op:'map'})` after
> `build({output:'romWithDebug'})`.

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

> **256-tile cap per pattern table (the busy-image trap).** The nametable's
> tile index is 8-bit, so a single pattern table holds at most **256 unique
> tiles** — and a per-frame BG can therefore use at most 256 distinct tiles.
> Auto-converting a busy full-screen illustration almost always needs more than
> 256 unique 8×8 tiles and **overflows**; `encodeArt({stage:'tilemap'})` warns
> when it does. The only real workaround is mid-frame CHR bank switching
> (an MMC3-class mapper) — the bundled NROM presets can't do it, so design BG
> art to reuse tiles (≤256 unique per table).

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
indexing into hardware colors. See `palette({source:'platformMaster', platform:"nes"})`
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

## Input

The ROM reads the pad by strobing `$4016` (write 1 then 0) then reading 8 bits
in order A, B, Select, Start, Up, Down, Left, Right (bit 0 of each read).

### Driving input over MCP

fceumm maps `input({op:'set'})` button names **straight through** — verified live, no
inversion: `{a}`→A, `{b}`→B, `{select}`/`{start}`, plus the d-pad. The spatial
names also resolve (east→A, west→B). So `input({op:'set', a: true})` presses NES A as
expected — unlike the genesis_plus_gx platforms (Genesis/SMS/GG), there's no
surprise here.

## What `examples({op:'fork'})` copies into your project

`examples({op:'fork', example:"nes/hello_sprite"|"nes/tile_engine"|"nes/default", name, path})`
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

## Blank screen? Verify rendering before you guess (no vision needed)

If the screen looks black/blank, don't iterate blind — call
**`frame({op:'verify', frames:60})`**. One call fuses a framebuffer pixel scan
with the live PPU registers and tells you `{verified:true|false|null, issues[]}`:
- `renderDisabled` → PPUMASK has BG+sprites off (footgun, see below) — set
  PPUMASK bits 3/4.
- `blankScreen`/`nearlyBlank` but render IS enabled → the PPU is on but nothing's
  in the nametable/OAM/palette: check the loop-order + OAM-DMA footguns below, and
  read the raw regions (`memory({op:'read', region:'nes_nametables'/'nes_oam'/'nes_palette'})`).
- `verified:null` (unsettled) → you haven't stepped a frame yet; step first.

It won't false-fire on boot, and it costs zero image tokens. Use it as the first
move whenever a change "did nothing" on screen.

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
`memory({op:'read'}, nes_oam)` returning all `$FF` after a few frames can
mean "DMA copied the source page faithfully because the source
was all `$FF` when NMI fired" — NOT "DMA broken."

Sentinel test that proves DMA works before opening a bug:
```js
host({op:'pause'})
memory({op:'write', region:"system_ram", offset:0x0200, hex:"42".repeat(256)})
host({op:'resume'}); frame({op:'step', count:1})
memory({op:'read', region:"nes_oam", offset:0, length:16})
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
  - **Debugging / transcribing sound:** `audioDebug({op:'inspect', chip:"nes"})` decodes
    the live APU register file ($4000-$4017) into per-channel
    {pulse1, pulse2, triangle, noise, dmc} with note names, freq, duty and
    volume — use it to confirm "is my channel actually playing the pitch I
    think?" To capture a note timeline over time (e.g. to port a tune to
    another platform), watch the registers: `watch({on:'mem', region:"nes_apu_regs",
    onChange:"reset", outputPath:...})` logs each note onset, or
    `recordSession({memorySamples:[{region:"nes_apu_regs",...}], sampleEvery:1,
    memoryOutputPath:...})` streams per-frame samples to disk.
- Mapper support — the homebrew presets target NROM (no PRG banking). For
  MMC1/MMC3/UNROM you'll need a different linker config. (For *rebuilding* an
  existing CHR-ROM NROM game byte-identical, see "Rebuilding a CHR-ROM NROM
  image" below — `inesHeader` / the `chr-rom` preset / `disasm({target:'project'})`.)
- IRQ — the IRQ vector returns. Most NES games use a custom IRQ
  handler for mid-frame scroll splits; you'll need to write that asm.
- Multi-screen scrolling — the runtime sets one nametable; for big
  scrolling worlds you need to manage the nametable buffer + bank
  switching yourself.

## MCP debug & inspection tooling

The shipped fceumm core is patched for live introspection — read state
instead of guessing:

- **Sprites:** `sprites({op:'inspect'})` decodes live OAM.
- **Palette:** `palette({source:'live'})` reads the live 32-byte palette RAM.
- **CPU:** `cpu({op:'read'})` reads the 6502.
- **Background render state:** `background({view:'renderState'})` decodes
  PPUCTRL/PPUMASK and resolves the active CHR bank (plus its file offset) —
  this is what tells you which pattern table BG vs sprites are fetching from
  (the bit-4 footgun above).
- **Memory regions:** `memory({op:'read'})` exposes OAM, Palette,
  Nametables (CIRAM — including the 2-bit-per-16x16 attribute data that
  selects each tile group's sub-palette, decoded by `inspectBackgroundMap`),
  CHR (live MMC1-banked CHR — don't parse the iNES file), CPU_REGS,
  PPU_REGS, and APU_REGS (the synthesized $4000-$4017 snapshot consumed by
  `audioDebug`).

## Rebuilding a CHR-ROM NROM image (reverse-engineering)

The homebrew presets above are CHR-**RAM** (the CPU uploads tiles at runtime).
Most *commercial* games are CHR-**ROM**: an 8 KB (or more) bank of fixed tile
data the PPU reads pattern tables from directly. When you rebuild a commercial
game from its disassembly into a byte-identical `.nes`, you need the iNES
header + the CHR-ROM blob + a linker config that concatenates HEADER + PRG +
CHR. romdev has three ways to do this so you never hand-derive header bytes or
write glue `.s`/`.cfg` files.

**The iNES header** (16 bytes at the very start of a `.nes`): `4E 45 53 1A`
("NES"+EOF), then byte 4 = PRG-ROM 16 KB bank count, byte 5 = CHR-ROM 8 KB bank
count (**0 = CHR-RAM**), byte 6 = flags6 (bit0 mirroring 0=horizontal/1=vertical,
bit1 battery, high nibble = mapper low nibble), byte 7 = flags7 (high nibble =
mapper high nibble), bytes 8-15 = 0. NROM is mapper 0; NROM-128 = 1 PRG bank
(maps at $C000, mirrored to $8000), NROM-256 = 2 PRG banks (maps at $8000).

**1. `build({inesHeader:{...}})` — the parametric, no-glue path (recommended).**
Pass `inesHeader: {prgBanks, chrBanks, mapper, mirroring}` and the build
auto-emits the HEADER segment, wires your CHR blob (from `binaryIncludePaths`)
into a CHARS segment, and uses a flat NROM `.cfg`. You supply only the PRG
source(s) + the CHR blob:
```
build({ output:'rom', platform:'nes',
        sourcesPaths:{ "prg.asm": "bank0.asm" },     // the PRG disassembly
        binaryIncludePaths:{ "chr.bin": "chr.bin" }, // extracted CHR-ROM
        inesHeader:{ prgBanks:2, chrBanks:1, mapper:0, mirroring:"vertical" } })
```
Mutually exclusive with `linkerConfig`. Works for any NROM (mapper 0, ≤2 PRG
banks). For a BANKED mapper you don't hand-write the glue anymore:
`disasm({target:'project'})` emits a HEADER segment (the original 16 iNES
bytes), a `.segment "PRGn"` wrapper per bank, and a multi-bank `nes_rebuild.cfg`
(switchable banks at $8000, fixed top bank at $C000), all wired into
`rebuild.json` via `linkerConfigPath` — a one-call byte-exact rebuild.

**2. `linkerConfig:"chr-rom"` — for homebrew C that ships FIXED tile art.**
A cc65-C preset (segment split + a CHARS segment in an 8 KB ROM2 bank). Put your
tiles in `.segment "CHARS"` (`.incbin "tiles.chr"`) + pass the blob via
`binaryIncludePaths`. It ships a companion crt0 with an 8 KB-CHR-ROM header. For
other bank configs, prefer `inesHeader`.

**3. `disasm({target:'project'})` — disassemble → rebuild, in two calls.**
For NES it extracts the CHR-ROM to `chr.bin`, writes a `rebuild.json` (the
exact `build({...})` call, with absolute paths) and a `BUILD.md`. NROM gets the
`inesHeader` one-call form; BANKED mappers (UxROM/MMC1/MMC3…) get per-bank
`PRGn` segment wrappers + the original-bytes HEADER segment + a generated
multi-bank `.cfg` referenced via `linkerConfigPath`. Either way: feed
`rebuild.json` straight back to `build` and you get a byte-identical ROM. This
is the RE workhorse loop: `disasm({target:'project'})` → edit the `.asm` →
rebuild → `diffRoms` to confirm your patch landed.

## Reverse-engineering & decompilation

The Rizin/Ghidra analysis engine works here like everywhere: `disasm({target:'functions'})` to carve the program, `disasm({target:'cfg'|'xrefs'})` to trace it, `symbols({op:'analyze'})` for a one-shot structural map.

**Decompiler quality on 6502: ROUGH.** Carry-flag idioms and 16-bit math on an 8-bit CPU decompile to noise that only reads cleanly once an LLM folds it — on this CPU the disassembly is often more honest than the pseudocode. `disasm({target:'decompile', address})` returns C-like pseudocode (the `qualityNote` field restates this). Read it to UNDERSTAND a routine; use `disasm({target:'project'})` to actually edit + rebuild. See the cross-platform ROM-hacking playbook §5f for the full loop.

## When to drop to asm

Game-loop in C is fine for ~80% of homebrew. Drop to asm when:
- You need cycle-accurate timing (sprite-0 hit splits, raster effects)
- You need fast inner loops (e.g. soft-render scanlines)
- You're writing the sound driver

Otherwise stay in C — it's easier to evolve and the cc65 codegen is
good enough for most game logic.
