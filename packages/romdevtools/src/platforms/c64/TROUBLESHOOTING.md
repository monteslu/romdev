# Commodore 64 — troubleshooting

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

When something's broken. Read MENTAL_MODEL.md first
(via `platform({op:'doc', platform:"c64", name:"mental_model"})`).

## "Screen is blank or filled with the wrong characters"

Three common modes:

1. **You wrote to $0400+ before the KERNAL finished clearing the
   screen during boot.** cc65's startup code typically runs after the
   KERNAL clears the screen, so this is rare under cc65 — but if you
   `org $0801` and run before vector setup, you can lose your writes.
   Easy fix: wait 2-3 frames after main() entry before drawing.
2. **VIC_MEMORY ($D018) points at the wrong screen RAM.** Default is
   $0400 (low nibble of D018 = $1, screen base = $0400). If you
   accidentally write D018, the VIC reads garbage instead.
3. **Wrong character set selected.** D018's high nibble selects char
   base. Default $14 means char base = $1000 (which maps to char ROM
   at $D000 with CHAREN=0). Set to $16 for the lowercase set.

## "Sprite doesn't appear"

Most common cause: forgot to set the sprite pointer at $07F8+N.
The sprite enable bit ($D015 bit N) just turns the rendering on;
the data location is in the pointer slot.

Sprite pointer value × 64 = byte offset within the current VIC bank
(default bank = $0000-$3FFF). So pointer = $20 means sprite data at
$20 * $40 = $0800.

Other gotchas:
- Sprite X is 8-bit, but the visible screen is 320 px wide. For X
  positions ≥ 256, set the corresponding bit in `VIC_SPRITES_X8`
  ($D010).
- Sprite Y offset is 50 (so Y=50 is the visible top edge); X offset
  is 24. Set Y=0 and your sprite is invisible above the screen.
- Color RAM stores nibbles ($0..$F), not full bytes. Writing the wrong
  high nibble has no effect, but writing junk for the low nibble gives
  unintended colors.

## "Sprite is invisible behind a character cell"

VIC-II has per-sprite background-priority bits at $D01B
(`VIC_SPR_BG_PRI`). Bit N = 1 means sprite N is drawn BEHIND the
character matrix (for cells with bit 7 of their color byte set as
"foreground"). Default = all 0 = sprites in front. If you accidentally
write $FF to $D01B, all sprites disappear behind the BG layer.

## "POKE / PEEK macro redefinition error"

cc65 already defines POKE / PEEK in `<peekpoke.h>` (and it gets pulled
in automatically by some other headers, like cbm.h). If you write your
own:

```c
#define POKE(addr, val)  (*(volatile uint8_t*)(addr) = (val))
```

…cc65 complains "Macro redefinition is not identical."

Workarounds:
- Use cc65's stock POKE / PEEK from peekpoke.h (no volatile, address
  as integer).
- Or define yours under different names like `WR` / `RD` — the
  bundled `tile_engine` template uses this convention.

## "Joystick input feels random / wrong"

Most likely cause: you're reading port 1 (CIA1_PRB at $DC01) instead
of port 2 (CIA1_PRA at $DC00).

Port 1 input is multiplexed with the keyboard scan matrix. Every 1/60
sec the KERNAL's IRQ reads CIA1_PRB to populate the key buffer; your
joystick read happens between IRQ ticks and sees whatever column the
KERNAL last selected. Result: ghost input.

**Use port 2 (CIA1_PRA) by default.** All bundled C64 templates do.

## "Player 2 input does nothing"

Both C64 control ports ARE live over MCP, so 2P works — the mapping is just
non-obvious: **host port 0 → control port 2 ($DC00) = player 1**, **host port 1
→ control port 1 ($DC01) = player 2** (the universal "port 0 = P1" convention).
So a 2P game reads P1 from $DC00 and P2 from $DC01, and you drive them with two
port entries: `input({op:'set', ports:[{up:true},{down:true}]})` moves P1 up,
P2 down. If P2 seems dead, check you passed a SECOND `ports` entry (not just
port 0) and that the game actually entered 2P mode (its title pick, e.g. "PORT 1
FIRE = 2P"). The host enables the VICE userport-adapter mapping + swaps the two
RetroPad ports under the hood so this convention holds — you don't configure
anything.

## "Audio is silent / SID doesn't play"

Three things to check:

1. `SID_VOL_MODE` ($D418) is 0 by default — set it to $0F or higher
   for any voice to be audible.
2. The voice's CONTROL register ($D404 + voice*7) needs both a
   waveform bit AND the GATE bit set:
   - Wave bits: $10 (triangle), $20 (saw), $40 (pulse), $80 (noise)
   - GATE bit $01: starts the ADSR envelope. Clear → release phase.
3. The voice frequency ($D400 + voice*7) is two bytes (LO + HI).
   Default = 0 = inaudible. SID frequency is a 16-bit value where
   FREQ = (HZ × 16777216) / 985248. So middle-C ≈ 4467 → write
   LO=$73, HI=$11.

## "VIC raster wait hangs"

If you do:

```c
while (PEEK(VIC_RASTER) < 250) { }
```

and the VIC's interrupt configuration has bit 7 of $D011 set (which is
the 9th bit of the raster line counter — for lines >= 256), then the
raster register is effectively 9-bit but you're reading only 8 bits.
Result: raster appears to wrap weirdly.

Default $D011 = $1B (display on, 25 rows, mode 0, bit 7 = 0). Don't
write bit 7 of $D011 unless you know what you're doing.

## "cc65 reports 'unresolved external'"

cc65 needs you to link against the c64.cfg system library that
defines RESET / NMI / IRQ vectors + the BASIC stub. Our build pipeline
does this automatically; if you're writing a standalone ca65 .s with
custom org, you may need to provide your own startup.

## "Save state breaks the running game"

vice's snapshot includes CIA state but NOT necessarily every cycle-
exact VIC register write you made between the snapshot point and the
next vblank. If your game uses raster IRQs for mid-screen tricks, a
load-state mid-frame may render garbage for one frame. Game-side
workaround: re-initialize VIC IRQ vectors at the top of every frame
loop.

## "First build is slow but later ones are fast"

Expected. cc65 + ca65 + ld65 cold-load is ~1-2s. Steady-state builds
are sub-second.
