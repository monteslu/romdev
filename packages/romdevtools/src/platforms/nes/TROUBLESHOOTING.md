# NES — symptom → fix

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

Find your symptom below; each entry has the 1-line diagnosis + the
MCP tool call that confirms it. Run these BEFORE you start bisecting
your C source.

## "Screen is grey / random / never changes"

**Cause #1: palette never written.** Power-on palette RAM is
undefined. Symptom: a single ugly color (often $0F → grey-ish or
$00) fills the screen. Fix: `palette_load(palette)` BEFORE
`ppu_on_all()`.
```js
memory({op:'read', region:"nes_palette", offset:0, length:32})
// Expect non-random bytes 0..0x3F.
```

**Cause #2: PPU rendering disabled.** PPUMASK = 0 means the PPU
doesn't render. `ppu_on_all()` sets bit 3 (BG) + bit 4 (sprites) =
$1E.
```js
background({view:'renderState'})
// Look for "bgVisible: true, spritesVisible: true".
```

**Cause #3: PPU not warmed up.** PPU ignores writes for ~29 658
cycles after reset. Our crt0 waits for two vblanks. If you replaced
the crt0, restore the two `bit $2002; bpl` waits.

## "Sprite doesn't appear"

Check in this order:

1. **OAM byte 0 is the Y position. Y=$EF..$FF hides the sprite.**
   Hardware Y = screen Y - 1, so the top edge of the screen is
   OAM Y=0 (i.e. screen Y=1).
   ```js
   memory({op:'read', region:"nes_oam", offset:0, length:16})
   // bytes 0..3 = slot 0: [Y, tile, attr, X]
   ```

2. **Sprite pattern table mismatch.** Default PPUCTRL has bit 3 = 0,
   so sprites fetch from $0000-$0FFF. If your sprite tile is at
   $1000+ you'll render BG tiles as sprites (= corrupt).

3. **PPUMASK.4 (OBJ enable) is off.** `ppu_on_all()` turns it on.

4. **Sprite uploaded but slot Y still $FF.** `oam_clear()` sets Y to
   $FF and resets `oam_index` to 0. You must call `oam_spr` AFTER
   `oam_clear`.
   ```js
   sprites({op:'inspect'})    // shows which slots are visible
   ```

5. **The Y off-by-one bug.** `oam_spr` subtracts 1 from Y to convert
   "screen coordinate" to "OAM byte 0". If you write shadow_oam
   directly, do this yourself: `shadow_oam[0] = (screen_y - 1)`.

## "Wrong colors"

1. **Universal backdrop ≠ what you set.** `$3F00` is the backdrop.
   The PPU also reads $3F04/$3F08/$3F0C as backdrop if a sprite is
   transparent above a BG-color-0 cell — there's mirroring weirdness.
   Set them all to the same value to avoid surprises.

2. **Attribute table boundaries are 2×2 tile groups.**
   `tile_set_palette(nt, x, y, p)` changes the palette of a 2×2
   group. Setting one tile changes its 3 neighbors. There's no way
   to give adjacent 2×2 groups different palettes without
   accepting the boundary.

3. **PPUMASK.0 is "greyscale mode."** Set it accidentally and every
   color is mapped to nearest grey. Check via `background({view:'renderState'})`.
   ```js
   background({view:'renderState'})    // "grayscale" should be false
   ```

## "Game freezes / locks up"

1. **NMI vector points at $0000.** If you replaced the crt0 and
   didn't define `nmi:`, the CPU jumps to garbage and hangs.
   ```js
   memory({op:'read', region:"system_ram", ...})    // or:
   xxd file.nes | tail -1                    // last 6 bytes = NMI, RESET, IRQ
   ```

2. **`ppu_wait_nmi()` spinning forever.** That means NMI never fires.
   Check that PPUCTRL bit 7 is set:
   ```js
   background({view:'renderState'})    // "nmiEnabled" should be true
   ```
   If not, `ppu_on_all()` or `ppu_on_bg()` should set it. If you wrote
   to PPUCTRL manually with bit 7 off, you've disabled NMI.

3. **`oam_clear()` + `oam_spr()` mid-frame race.** If you call these
   AFTER `ppu_wait_nmi()` (i.e. just after vblank started), the cc65-
   generated code is slow enough that you may not finish before the
   next vblank, and the NMI's DMA captures shadow_oam mid-update.
   Fix: stage sprites BEFORE `ppu_wait_nmi()`, not after.

## "Sprites flicker on and off every other frame"

Your loop order is `ppu_wait_nmi → oam_clear → oam_spr` instead of
the canonical `oam_clear → oam_spr → ppu_wait_nmi`. The NMI fires
at vblank start and DMAs whatever shadow_oam contains AT THAT
MOMENT. With the wrong order, you populate shadow_oam AFTER the
NMI has already run, so half the frames DMA the cleared
(all-`$FF`) shadow_oam.

Diagnostic: sample `nes_oam[0..3]` over 8 consecutive frames.
Wrong-order produces alternating `sprite/ff000000/sprite/ff000000`.
Correct-order produces `sprite/sprite/sprite/sprite`.

Fix: stage shadow_oam BEFORE waiting.
```c
for (;;) {
  /* update game state */
  oam_clear(); oam_spr(...);   // stage
  tile_set(...);                // queue BG writes
  ppu_wait_nmi();               // sleep — NMI DMAs + flushes
}
```

## "BG tile visible in tiles({op:'png'}) but not on screen"

The NES PPU renders 240 scanlines but most TVs (and our
framebuffer output) crop to 224. Nametable row 0 (PPU $2000-$201F,
top 8 px) and row 29 (PPU $23A0-$23BF, bottom 8 px) get cut. If
your score lives at row 0 it'll be in the nametable but invisible.

Fix: move HUD to row 2+ and keep "press start"-style bottom UI at
row 27 or lower.

## "State corrupts / mystery crashes as the game grows" — RAM/BSS overflow

The NES has only **2 KB of RAM** ($0000-$07FF), and the chr-ram linker
config carves most of it up: zeropage, the stack, and `shadow_oam`
(256 B at $0200) leave roughly **~512 B for your BSS+DATA** (globals).
Overflow it and there's no error — your globals quietly collide with
the stack or shadow OAM → corrupted state, sprites that flicker to
garbage, random crashes.

**Check the `ramUsage` field in the build response** —
it lists your BSS / DATA / ZEROPAGE segment sizes from the linker map.
If BSS+DATA is approaching the config's RAM region, shrink your state:
prefer `uint8_t` over `int`, bit-pack flags, use small fixed arrays,
avoid large `static` buffers. (This is why "NES-shaped C" uses bitmasks
and tiny structs — it's not style, it's the 512 B ceiling.)

## "build({output:'run'}) screenshot looks one frame behind my sprites"

On NES, the NMI handler DMAs `shadow_oam` → real OAM at the *start* of
each vblank, so sprites you stage on frame N first appear when frame
N+1 renders. `build({output:'run'})` now steps one extra frame on NES before the
screenshot so it matches your staged OAM — but if you script frames
manually (`frame({op:'step'})` then `frame({op:'screenshot'})`), add one extra `frame({op:'step'}, 1)`
after staging to see the current sprite positions.

## "memory({op:'read'}, nes_chr) returns same bytes for offset 0 and offset 4096"

Was a real bug in R59 of the fceumm patch — `memory({op:'read'}, nes_chr)`
collapsed all 8 1KB pages into copies of the first page on NROM.
Fixed in R61 (2026-05-27). If you still see this, your MCP server
is running a stale WASM:
```sh
# Check the timestamp of the bundled fceumm wasm in your install:
stat -c '%y' node_modules/romdev-core-fceumm/wasm/fceumm_libretro.wasm
```
Workaround if you can't restart: `tiles({op:'png'})` reads CHR
via a different path and was unaffected throughout.

## "Globals read garbage / `_nmi_counter` never advances"

Your `.cfg` puts the BSS region (`RAM:`) at $6000-$7FFF, but your
cart is NROM with no battery WRAM (iNES flags6 bit 1 = 0). That
region is UNMAPPED on the hardware — reads return open-bus
(parasitic capacitance from the last bus value). Globals appear
to "kind of work" because the open bus briefly retains what you
just wrote, but `_nmi_counter` increments are lost and any
"wait until counter == target" loop spins forever.

Diagnostic:
```js
memory({op:'read', region:"system_ram", offset:0x6000, length:16})
// All $FF or matching the last value you wrote = open bus.
```

Fix: edit your `.cfg`:
```
RAM:    file = "", start = $0300, size = $0200, define = yes;
```
(512 bytes of real internal RAM between OAM at $0200 and the C
stack at $0500.) For larger BSS, opt into a mapper that maps
PRG-RAM at $6000 and set iNES flags6 bit 1.

The bundled `chr-ram-runtime.cfg` already does this correctly as
of 2026-05-27.

## "OAM is full of $FF — DMA must be broken"

Probably not. The crt0's init loop writes `$FF` to all 256 bytes
of `_shadow_oam @ $0200` at boot (canonical sprite-Y off-screen
sentinel). If your game only populates a few slots, the rest stay
`$FF` and OAM DMA faithfully copies them. `memory({op:'read'}, nes_oam)`
showing mostly `$FF` is the EXPECTED state, not a bug.

Sentinel test that proves DMA works:
```js
host({op:'pause'})
memory({op:'write', region:"system_ram", offset:0x0200, hex:"42".repeat(256)})
host({op:'resume'}); frame({op:'step', count:1})
memory({op:'read', region:"nes_oam", offset:0, length:16})
// All $42 → DMA copies the source page faithfully. Working as designed.
// All $FF → real DMA bug. Escalate.
```

## "retro_load_game failed"

The build pipeline writes a valid iNES header (mapper 0, vertical
mirroring, CHR-RAM=0) for every C build via our chr-ram crt0. If
you're seeing this error, you're either:

1. Loading a hand-built ROM that skipped the bundled crt0.
2. The ROM has stale CHR-ROM bytes that don't match the header's
   "CHR-RAM" declaration. Re-build with `linkerConfig:"chr-ram"`
   (or just leave linkerConfig blank — the C path defaults to chr-ram).

Verify the header:
```sh
xxd -l 16 file.nes
# Expect: 4E 45 53 1A 02 00 01 00 00 00 00 00 00 00 00 00
#         N  E  S  ^  PRG CHR FL FL
#                  16 banks=2 0=CHR-RAM vmirror standard
```

## "Pad input does nothing"

1. **Wrong bit layout.** Our `pad_poll` uses the Shiru/neslib layout:
   `PAD_A = 0x80`, `PAD_RIGHT = 0x01`. **Not** the cc65 `joy.h`
   layout. Use the PAD_* masks from `nes_runtime.h`.

2. **Strobed wrong.** `pad_poll` does the strobe internally. Don't
   call it from inside an NMI handler — the strobe sequence collides
   with the controller pollers some emulators run during DMA.

3. **Controller 1 vs 2.** `pad_poll(0)` reads $4016 (controller 1).
   `pad_poll(1)` reads $4017 (controller 2). Most games only use 0.

## "BG renders garbage / random tiles"

1. **CHR-RAM wasn't initialised.** The crt0 zeros all 8 KB at boot.
   If you skipped the crt0, do it yourself: `chr_ram_upload(0x0000,
   zeros, 0x2000)` at boot before `palette_load`.

2. **PPUCTRL bit 4 wrong.** Bit 4 = 0 means BG fetches from $0000;
   bit 4 = 1 means BG fetches from $1000. Default is bit 4 set
   ($1000). If you upload BG tiles to $0000 (sprite area) and forget
   to change PPUCTRL, BG won't see them.

3. **Nametable wasn't written.** A nametable of all zeros = all tile
   0. If your tile 0 is blank (which is the convention), you get a
   black screen. Use `vram_unsafe_set` during PPU-off or `tile_set`
   from C (queued).

## "Scroll glitches / flickers"

1. **NMI didn't reset PPUADDR/PPUSCROLL.** The bundled NMI handler
   does this. If you replaced it, restore the sequence:
   `bit $2002; lda #$20; sta $2006; sta $2006; lda scroll_x; sta $2005;
   lda scroll_y; sta $2005; lda ppuctrl_value; sta $2000`.

2. **You wrote to PPUADDR outside vblank.** $2006 writes during
   rendering corrupt the internal scroll latch. Always queue VRAM
   writes via `vram_set` / `tile_set` so they flush in NMI.

## Debug recipes

A few high-leverage tools you might not know exist:

- **`sprites({op:'inspect'})`** — pretty-prints all 64 OAM slots with
  visible/hidden status, tile, attr, position.
- **`background({view:'map', render:true})`** — composites the active
  nametable as a PNG.
- **`palette({source:'live'})`** — shows the loaded palette as RGB colors,
  not raw bytes.
- **`background({view:'renderState'})`** — decodes PPUCTRL/PPUMASK/PPUSTATUS
  + "what bank are BG/sprites fetching from right now".
- **`cpu({op:'read'})`** — PC + flags. Use when you suspect a hang.
- **`watch({on:'mem', region:"nes_oam", offset:0, length:4})`** — trace
  every write to OAM slot 0, returns the PC that wrote it.
- **`frame({op:'step', count:3600})`** — runs 1 minute of game time in
  milliseconds. Don't be conservative.

## Mental model + boot order

See [`MENTAL_MODEL.md`](MENTAL_MODEL.md) for the architecture
overview (fetch via `platform({op:'doc', platform:"nes", name:"mental_model"})`).
The canonical "boots cleanly + shows a sprite" sequence is:

```
1. ppu_off()                       // safe to write VRAM
2. chr_ram_upload(0x0000, ...)     // sprite tiles
3. chr_ram_upload(0x1000, ...)     // BG tiles
4. palette_load(palette)            // 32-byte palette at $3F00
5. render initial nametable        // vram_unsafe_set during PPU-off
6. oam_clear() + oam_spr(...)      // initial sprite list
7. ppu_on_all()                    // enable rendering + NMI
8. for(;;) {
     stage sprites + tile_set      // for upcoming frame
     ppu_wait_nmi()                // NMI auto-DMAs + commits queue
     pad = pad_poll(0)             // input
     update game state
   }
```

## Adding a new symptom

Hit something not on this list? Open an issue with a 5-line repro and
the symptom at https://github.com/monteslu/romdev/issues.
