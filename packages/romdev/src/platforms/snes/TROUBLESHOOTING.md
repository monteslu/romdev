# Super Nintendo / Super Famicom — troubleshooting

When something's broken. Read MENTAL_MODEL.md first for the "what's
going on" version (via `getPlatformDoc({platform:"snes", name:"mental_model"})`).

## "ROM builds but the screen is black / forced blank"

The SNES PPU starts in **forced blank** state. INIDISP register
$2100 has bit 7 set on reset, which means "display off, allow VRAM
write any time". You must clear bit 7 of INIDISP before anything
appears on screen.

PVSnesLib provides `setScreenOn()` to do this. Forget it → black
screen forever, even if the rest of your code is perfect.

```c
setMode(BG_MODE1, 0);
consoleDrawText(10, 10, "hi");
setScreenOn();   /* ← without this, nothing draws */
while (1) WaitForVBlank();
```

## "tcc-65816 fails with `';' expected` on `for (u16 i = 0; ...)`"

tcc-65816 is C89-only. You cannot declare variables inline in `for`
loops, mid-block, or as the rhs of expressions. Move all declarations
to the top of each function or block.

```c
/* WRONG (C99+) */
for (u16 i = 0; i < 10; i++) { ... }

/* RIGHT (C89) */
u16 i;
for (i = 0; i < 10; i++) { ... }
```

Same applies to mid-block declarations like `u16 v = expr;` after
statements — must be hoisted to block top.

## "wla-65816 link fails with `unresolved external 'tilfont'`"

Your `main.c` references `tilfont` / `palfont` symbols, but no
sibling `.asm` defines them. PVSnesLib's `consoleInitText` requires
these — they hold the font tile data and palette respectively.

Stub them with zero bytes in a sibling `data.asm`:

```asm
.section ".rodata1" superfree
tilfont:
.db 0, 0, 0, 0, 0, 0, 0, 0
palfont:
.db 0, 0, 0, 0, 0, 0, 0, 0
.ends
```

Then build with both files:
```js
buildSource({platform:"snes", language:"c",
  sources: {"main.c": ..., "data.asm": ...}});
```

For real fonts, run PVSnesLib's `gfx4snes` tool natively to convert
a PNG → `.pic` + `.pal`, then `.incbin` them in `data.asm`.

## "Sprites don't appear"

Three things to check:

1. **You called `oamSet()` but not `oamUpdate()`.** PVSnesLib's
   `oamSet` writes to a RAM-side shadow buffer; `oamUpdate()`
   pushes that buffer to OAM via DMA. Without it, the PPU sees
   whatever was in OAM before.
2. **Sprite Y is in the off-screen range.** OAM Y=$F0+ hides the
   sprite. If you initialised OAM to zero and then never set Y,
   your sprite is at Y=0 (visible), but if you set Y=240+ it's
   invisible.
3. **No sprite tile data uploaded.** `oamInitGfxSet` is the
   canonical "upload sprite tiles + palette to VRAM" call. Forget
   it and the OAM points to garbage tiles → invisible / random
   patterns.

## "BG mode is wrong / background is glitched"

`setMode(BG_MODE1, 0)` configures Mode 1: BG0 + BG1 (16-color), BG2
(4-color). If you're using `consoleInitText` for text, it writes
into BG0 of Mode 1 by default. You need to also call
`bgSetDisable(1)` and `bgSetDisable(2)` if you're not using those
layers — otherwise they'll render whatever happens to be at their
default VRAM addresses (often garbage).

```c
setMode(BG_MODE1, 0);
bgSetDisable(1);   /* disable BG1 */
bgSetDisable(2);   /* disable BG2 */
```

## "Build fails with `RAM overflow` / `code section overflow`"

The SNES LoROM bank layout maps only 32 KB per bank (the upper half).
PVSnesLib's default linkfile gives you 8 banks = 256 KB. Symptoms:

- "code section overflow" → your compiled code is larger than the
  remaining ROM space.
- "RAM overflow" → too many globals + the C stack don't fit in the
  8 KB low-RAM region.

Fixes:
- Compile with `-Os` to reduce code size.
- Move large constant arrays to `const` so they go to ROM, not RAM.
- For really big games, switch to a bigger ROM (extend the LoROM
  layout to 16 banks).

## "Audio doesn't work / silent"

Three layers:

1. **SPC700 driver not booted.** PVSnesLib has `spcBoot()` — call
   once at startup. Forget it and `spcPlay()` does nothing.
2. **APUIO ports stuck.** The SPC700 communication is via $2140-$2143.
   On reset both sides write zeros and then handshake; if you bypass
   PVSnesLib's `spc*` helpers and poke the ports directly, your
   handshake may be wrong.
3. **No sound data loaded.** `spcSetSoundEntry()` registers BRR
   samples + sequence pointers — without these, channels are silent.

PVSnesLib's API is the path of least resistance. Roll your own SPC
driver only when you really need the control.

## "consoleDrawText output is corrupt / shifted"

`consoleInitText(palnum, palsize, tilfont, palfont)` configures the
font palette. If you pass `palnum=0` (palette 0) but your `palfont`
isn't 32 bytes of valid 16-color BGR-555, the font renders with
garbage colors.

Also: `consoleSetTextMapPtr`, `consoleSetTextGfxPtr`,
`consoleSetTextOffset` must all be set BEFORE `consoleInitText`.
PVSnesLib doesn't validate; bad ptrs → corrupt text.

Canonical setup:

```c
consoleSetTextMapPtr(0x6800);    /* BG map base in VRAM */
consoleSetTextGfxPtr(0x3000);    /* tile data base in VRAM */
consoleSetTextOffset(0x0100);    /* first text tile in tilemap */
consoleInitText(0, 16 * 2, &tilfont, &palfont);
```

## "Save states don't include the SPC700 state"

snes9x snapshot includes APU state by default, so this should work
out of the box. If you find SFX restart on load, double-check that
your driver doesn't reinitialise itself unconditionally in the NMI
handler.

## "First C build is slow but later ones are instant"

Expected. tcc-65816.wasm + wla-65816.wasm cold-load + compile takes
1-2s. Subsequent builds reuse the warm worker pool (R12 crash
isolation infrastructure). Steady-state builds are sub-second.

## "I want to use real graphics from a PNG"

`gfx4snes` (the PVSnesLib companion tool) converts PNG → .pic + .pal.
It's not yet bundled in rom-dev-mcp's WASM toolchain. Workflow:

1. Run `gfx4snes` natively on your build machine to produce
   `mysprite.pic` + `mysprite.pal`.
2. Ship those binary files alongside `main.c` + `data.asm` in
   your project.
3. In `data.asm`:
   ```asm
   tilsprite:
   .incbin "mysprite.pic"
   palsprite:
   .incbin "mysprite.pal"
   ```

(rom-dev-mcp's `buildSource` accepts binary `.pic` / `.pal` blobs
as sibling resources.)
