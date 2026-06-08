# Atari 2600 / VCS — troubleshooting

> **A build failed? Read `issues[]` FIRST.** Every build/compile call returns
> `issues: [{file, line, col, severity, message, stage}]` — the structured error
> list. It almost always names the exact line to fix. Read that before matching a
> symptom below or touching your source. Fall back to the raw `log` only if
> `issues[]` is empty but `ok:false`.

When something's broken. Read MENTAL_MODEL.md first
(via `platform({op:'doc', platform:"atari2600", name:"mental_model"})`).

## "Screen rolls / shimmers / wrong height"

You wrote the wrong number of scanlines. NTSC is **EXACTLY** 262
scanlines per frame, broken into 3 VSYNC + 37 VBLANK + 192 visible
+ 30 overscan. Any of those off by 1, and the TV's vertical sync
drifts.

Check:
- Did your VSYNC block call `STA WSYNC` exactly 3 times?
- Is your VBLANK loop `LDX #37` then `STA WSYNC ; DEX ; BNE .vb`?
  (37 iterations of WSYNC = 37 scanlines.)
- Same for the visible 192 and overscan 30.
- Are there any extra `STA WSYNC` instructions hiding in your
  game-logic code that pushes you past 262?

Use the cycle counter from `stella -trace` (or our `frame({op:'step'})` +
`cpu({op:'read'})`) to verify your scanline count.

## "Sprites are wider than expected"

Two scanlines = one TIA pixel of vertical resolution at minimum,
but the GRP0/GRP1 register stays valid until you change it. If you
write GRP0 once and don't reset to 0 on the next line, the sprite
"smears down" — extending to the bottom of the screen.

The fix: explicitly write `STA GRP0` with 0 on every line where
the player isn't drawn. Or write it ONCE for the scanlines you
want, and zero AFTER:

```asm
  STA WSYNC
  ; ... compute Y - P_Y ...
  CMP #8           ; within sprite height?
  BCS .blank
  TAY
  LDA SPRITE,Y
  STA GRP0
  JMP .next
.blank:
  LDA #0
  STA GRP0
.next:
```

## "Object X position is off / jittery"

The X-position routine has cycle-count gotchas:

1. **`STA RESP0` itself takes 3 cycles** — the actual reset happens
   at cycle 3 of the instruction, not cycle 0. Fine X via HMP0 +
   HMOVE compensates.
2. **HMOVE itself takes 8 cycles to execute** and triggers a
   "missing horizontal blank" — if HMOVE runs after pixel 56 of
   the current scanline, the right-hand side of the next scanline
   has 8 black pixels.
3. **Your delay loop has variable cycle count** depending on
   whether the branch crosses a page boundary.

Use a known-good X-position routine like the one in
`src/platforms/atari2600/lib/`. Don't roll your own unless you
need pixel-perfect placement.

## "Joystick reads as 'always pressed'"

`SWCHA` is **active low**. Bit value `0` = pressed, `1` =
released. You must INVERT before AND-masking:

```asm
LDA SWCHA
EOR #$FF       ; or: ASL into carry, BCS = not pressed
AND #$80       ; P1 up
BEQ .not_up
; ... move up ...
```

The `default.asm` template uses `ASL` + `BCS` which checks the
high bit directly without explicit inversion — also valid, just
different idiom.

## "ROM works in stella but wrong on real hardware"

Real 2600s are picky. Common gotchas:

1. **Vector table not at $FFFC.** RESET must point to your code's
   entry. `org $FFFA ; .word START ; .word START ; .word START`
   is the canonical setup.
2. **WSYNC timing assumes 76 cycles per scanline.** If you have
   a code path that runs > 76 cycles between WSYNCs, that
   scanline overflows and the next line is short. Real hardware
   doesn't forgive this; stella sometimes does.
3. **Page-crossing branches.** A taken branch that crosses a
   page boundary takes 4 cycles instead of 3. Drift = scanline
   misalignment.

## "Music plays the wrong notes"

AUDF0/AUDF1 frequency values are NOT Hz. They're divisor values
where:

```
freq_hz = 30030 / (audf + 1)
```

(approx, for AUDC tone shape 4 — pure tone.)

So `AUDF0 = 7` → ~3.75 kHz. Higher AUDF = lower pitch. Most
tutorials list a lookup table; the bundled `lib/` directory has
one.

## "Game logic doesn't fit in VBLANK"

37 scanlines × 76 cycles = ~2800 cycles for ALL game logic per
frame. If you need more, you can:

- Spread logic across vblank + overscan (37 + 30 = 67 lines = 5092
  cycles).
- Skip-frame logic that only runs every N frames.
- Move expensive computation into the kernel's "idle" lines (the
  ones where no rendering happens because sprites are off-screen).

## "Building a sprite kernel for vertical movement is hard"

It is. The 2600 has no scrolling, no tilemap, no Y register on
the TIA. To move a sprite down, you must change which scanline
GRP0 starts being non-zero on. The hello-style approach is:

```asm
LDY #192
.draw:
  STA WSYNC
  TYA
  SEC
  SBC P_Y          ; how many lines past the player's top?
  CMP #8           ; within sprite height?
  BCS .blank
  TAY
  LDA SPRITE,Y     ; row Y of the sprite shape
  STA GRP0
  ...
```

This costs ~15 cycles per scanline (~20% of the 76-cycle budget).
For multiple sprites at different Y, the cost multiplies. Real
games use careful kernel layouts ("the 2600 way") to limit
sprites to specific Y bands. See the `lib/player_kernel.asm`
snippet for one approach.

## "First build is slow but later ones are fast"

Expected. dasm cold-load is ~500ms. Steady-state builds < 100ms.
