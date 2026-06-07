# Game Boy / Game Boy Color — symptom → fix

Stuck? Find your symptom below; each entry has the 1-line diagnosis and
the MCP tool call that confirms it. **Run the diagnosis BEFORE you start
bisecting the C source** — most "GB doesn't render" bugs are one of these
five things.

## "Screen is blank / stays grey-white forever"

**Cause #1: LCD is off.** `LCDC.7 = 0` means the screen never updates.
```js
memory({op:'read', region:"gb_io", offset:0x40, length:1})  // LCDC byte
// 0x80+ = on, 0x00-0x7F = off
```

**Cause #2: stuck in `wait_vblank()` with LCD off.** Before the
2026-05-25 runtime fix the helper hung forever in this case; now it
returns immediately. If you've inlined your own `while (LY < 144)`
wait, replace it with `wait_vblank()` from `gb_runtime.h`.
```js
cpu({op:'read'})  // PC stuck inside your wait loop? You hit this bug.
```

**Cause #3: BG and OBJ both disabled.** `LCDC` must have bit 0 (BG on)
and/or bit 1 (OBJ on) set, or there's nothing to draw. The `gb_runtime`
helper `lcd_init_default()` sets a known-good value
(`LCDC = 0x83`: on + BG + OBJ + tile data $8000).

## "Sprite doesn't appear"

Check in this order:
1. **OAM byte 0 is the Y position. Y=0 hides the sprite.** Hardware Y =
   screen Y + 16, so the top edge of the screen is OAM Y=16. Same for X
   (hardware X = screen X + 8, off-screen = X<8 or X>=168).
   ```js
   memory({op:'read', region:"gb_oam", offset:0, length:16})
   // bytes 0..3 = slot 0: [Y, X, tile, attr]
   ```
2. **Tile index points at unuploaded VRAM.** If your tile data is at
   $8010+ (slot 1+) but the OAM byte 2 (tile index) is 0, you're showing
   the blank slot 0.
3. **LCDC.1 (OBJ enable) is off.** Same as above — `lcd_init_default()`
   turns it on.
4. **OAM DMA never ran.** You staged the sprite in `shadow_oam[]` but
   forgot to call `oam_dma_flush()` each vblank.
   ```js
   sprites({op:'inspect', platform:"gbc"})   // shows what the LCD sees right now
   ```

## ⚠ "Sprites/tiles never show AND the CPU crashed (PC near $002B)" — the #1 SDCC footgun

**The single most common way a GB/GBC C game silently dies.** SDCC's sm83
backend **miscompiles a byte-copy loop that writes through an `__xdata`
pointer** — the canonical "copy my tiles into VRAM" pattern:

```c
uint8_t *dst = (uint8_t *)0x8000;   // VRAM
for (uint8_t i = 0; i < 16; i++) dst[i] = src[i];   // ☠ MISCOMPILES
```

SDCC emits code that writes to the **return address** instead of `dst`,
corrupting the stack → the CPU jumps to garbage and crashes (you'll see
`PC` stuck around `$002B`, `SP` corrupt). The build SUCCEEDS and the ROM
boots, so it looks like a logic bug — but it's codegen. Symptom: sprites/
tiles never appear, OAM stays zero, `cpu({op:'read'})` shows a wild PC.

**Fix — use the bundled helper, never a raw `dst[i]=src[i]` loop to VRAM:**
```c
memcpy_vram(dst, src, 16);   // ships in gb_runtime.c — does the copy safely
```
`memcpy_vram()` is in every GB/GBC project's `gb_runtime.c`. Any time you copy
bytes into VRAM ($8000-$9FFF) or another `__xdata` region, call it instead of
hand-rolling a for-loop. (`build({output:'rom'})` with `lint:"strict"` will also flag the
raw pattern as a preflight error.)

## ⚠ "Loop never ends / all code after a loop is dead" — uint8 loop-bound trap

```c
uint8_t i;
for (i = 0; i < 32 * 32; i++) { ... }   // ☠ 255 < 1024 is ALWAYS true → infinite
```
A `uint8_t` counter can't reach a bound >255, so the loop never exits and
everything after it is dead code. SDCC does **not** warn. Use `uint16_t` for any
loop whose bound can exceed 255. (The preflight linter flags this too.) See also
the cross-platform note: [[sdcc-uint8-loop-bound-trap]].

## "Wrong colors on GBC"

1. **`$0143` is not $80.** This is the CGB-mode header byte.
   `build({output:'rom'})` / `build({output:'run'})` set it automatically from the platform —
   build with `platform:"gbc"` and it's $80/$C0; build with
   `platform:"gb"` and it stays $00 (DMG). So if colors are wrong, first
   check you didn't build this as a `.gb` ROM — rebuild with
   `platform:"gbc"`. (To force a value on an existing ROM: set it in your
   `gb_crt0.s` header section, run `romPatch({op:'gbHeader', path:"out.gbc"})`, or
   run `node patch-header.js out.gbc`.) Verify:
   ```sh
   xxd -s 0x143 -l 1 out.gbc      # expect: 80
   ```
2. **You wrote to `BGP` / `OBP0` / `OBP1` instead of `BCPD` /
   `OCPD`.** DMG and CGB use different palette registers. On CGB,
   `BGP` is ignored — you must drive the 64-byte BG palette RAM via
   `BCPS` (bit 7 = auto-increment) + `BCPD` for writes.
3. **Forgot to set BCPS/OCPS auto-increment bit.** `BCPS = 0x80`
   means "palette 0, color 0, low byte, auto-advance after every
   BCPD write". Without bit 7, you have to set the address before
   every byte.
4. **Tile attributes (VRAM bank 1) aren't set.** CGB BG colors come
   from the attribute map in VRAM bank 1 at $9800-$9BFF. Default is
   all zeros = palette 0 for every tile. To use other palettes:
   ```c
   VBK = 1;
   *((uint8_t *)0x9800) = 1;  // first tile uses palette 1
   VBK = 0;
   ```

## "Game freezes / hangs"

1. **PC is at $0040 (vblank IRQ vector) but no handler.** You enabled
   `IE` and `EI` but didn't `RETI` from the IRQ vector. Result: the
   CPU is permanently in the IRQ. The default `gb_crt0.s` puts
   `RETI` at every IRQ vector — so this only happens if you've
   replaced the crt0.
2. **Stack overflow.** With a 32 KB ROM you have ~8 KB of WRAM
   ($C000-$DFFF). Default SP is $E000 (top). If you're recursing
   deeply or putting huge arrays on the stack, you can hit $C000 and
   corrupt initialized globals.
   ```js
   cpu({op:'read'})   // check SP
   ```
3. **`halt` without `IE`.** A bare `halt` with no enabled interrupts
   on DMG can deadlock or skip an instruction (the halt-bug). The
   runtime's `oam_dma_copy` and `wait_vblank` use polling, not
   `halt`, to avoid this.

## "Build succeeds but ROM doesn't load (`retro_load_game failed`)"

**Cause: ROM has no Nintendo logo or bad checksum.** The build
pipeline patches in the canonical logo + checksums for every gb/gbc
build automatically (search `NINTENDO_LOGO` in
`src/toolchains/index.js`). If you're seeing this error:

1. You're loading a hand-built ROM from somewhere other than this
   pipeline (e.g. an asm-only ROM not run through rgbfix).
2. Confirm the bytes:
   ```sh
   xxd your.gbc | sed -n '/00000100:/,/00000150:/p'
   ```
   At $0104-$0133 you should see the Nintendo logo (starts `CE ED 66 66`).
   At $014D you should see the header checksum.

## "Code at $0100-$014F got clobbered"

The `gb_crt0.s` reserves $0100-$014F for the cartridge header. The
SDCC linker is configured with `-b _CODE=0x0150` so user code starts
at $0150. If you see code in that window, either:
- You're not using the bundled crt0 (passing your own `crt0:` to the
  build), in which case make sure it reserves the header window.
- A custom `linkerConfig` is overriding the code base. The default
  works; don't override it for GB/GBC unless you know what you're
  doing.

## Debug recipes

A few high-leverage tools you might not know exist:

- **`sprites({op:'inspect', platform:"gbc"})`** — pretty-prints all 40 OAM
  slots showing which are on-screen + tile index + attributes.
- **`background({view:'map', platform:"gbc", render:true})`** — renders
  the BG map as a PNG so you can see what tiles the LCD is reading.
- **`palette({source:'live', platform:"gbc"})`** — shows BG and OBJ palettes
  as colors instead of raw BGR555 bytes.
- **`cpu({op:'read'})`** — PC + registers, useful when you suspect a
  hang.
- **`watch({on:'mem', region:"gb_oam", offset:0, length:4})`** — trace
  every write to OAM slot 0, returns the PC that wrote it.
- **`frame({op:'step', count:3600})`** — runs a full minute of game time
  in milliseconds. Don't be conservative with frame counts when
  hunting bugs.

## Mental model

Boot order that always works for GBC:

```
1. LCDC = 0  (turn off LCD; safe even if already off — runtime checks)
2. Write tile data to $8000+ via VRAM bank 0
3. Write CGB attribute map to $9800+ via VRAM bank 1 (set VBK=1 first)
4. BCPS = 0x80 ; BCPD writes set up BG palette (64 bytes)
5. OCPS = 0x80 ; OCPD writes set up OBJ palette (64 bytes)
6. Build initial OAM via oam_set() into shadow_oam[]
7. LCDC = LCDC_LCD_ON | LCDC_BG_ON | LCDC_OBJ_ON | LCDC_TILE_DATA_LO
8. for (;;) {
     wait_vblank();         // LY hits 144
     oam_dma_flush();       // shadow_oam → $FE00
     pad = joypad_read();   // read input AFTER OAM is up
     /* update game state */
     oam_set(...);          // restage sprites
   }
```

Cribbed from `examples/gbc/templates/tile_engine.c` — start a fresh
game from that template with:

```js
scaffold({
  op: 'project',
  platform: "gbc",
  template: "tile_engine",
  name: "mygame",
  path: "/abs/path/to/dir",
});
```

## Adding a new symptom

Hit something not on this list? Open an issue with a 5-line repro and
the symptom at https://github.com/monteslu/romdev/issues.
