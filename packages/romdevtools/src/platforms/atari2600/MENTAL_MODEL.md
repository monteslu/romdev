# Atari 2600 / VCS — mental model

One page. The 2600 is the most architecturally extreme console
romdev supports. Read this twice before you write code.

## The big idea

**The 2600 has no frame buffer.** There's no VRAM. The TIA chip
generates video signal one scanline at a time, and you — the
6502 CPU — must reconfigure the TIA's graphics registers for each
scanline you want to look different. This is called **"racing the
beam."**

If you forget to write the TIA for scanline 42, scanline 42 looks
identical to scanline 41.

## CPU memory map (6507 — a 6502 variant with fewer pins)

```
$0000-$003F   TIA write registers (graphics, audio, collision)
$0030-$003D   TIA read registers (collision, input)
$0080-$00FF   RIOT 128 bytes of RAM — that's ALL the RAM, 128 bytes
$0280-$0297   RIOT I/O (joysticks, timer, console switches)
$F000-$FFFF   ROM (4 KB — standard cart size; banks for larger)
```

**128 bytes of RAM**. Yes. Total. The stack lives here too ($FF
down). Game state must fit in maybe 80 zero-page bytes.

The 6507 has the same 6502 instruction set but only 13 address
pins, so it can only address 8 KB. Bigger carts use bank-switching
hot-spots inside the cart.

## TIA — the graphics object zoo

The TIA has 5 graphics objects and 1 playfield:

```
P0  player 0       8-pixel-wide bitmap, written to GRP0 ($1B)
P1  player 1       8-pixel-wide bitmap, written to GRP1 ($1C)
M0  missile 0      1-8-pixel-wide, shares P0's colour
M1  missile 1      1-8-pixel-wide, shares P1's colour
BL  ball           1-8-pixel-wide, shares playfield colour
PF  playfield      20-pixel-wide pattern, optionally mirrored or
                   repeated across the 160-pixel-wide screen
```

Per scanline, you choose which of these are on, what pattern they
show, what colour they are, and where they're positioned.

## Frame structure (NTSC)

A 2600 NTSC frame is exactly **262 scanlines** in 4 phases:

```
3 scanlines   VSYNC      tell the TV "new frame coming"
37 scanlines  VBLANK     game logic runs here — no rendering
192 scanlines visible    the part the user sees — race the beam
30 scanlines  overscan   more game logic; off-screen
```

Each scanline is exactly **76 CPU cycles** wide. You have to fit
every per-line update into 76 cycles, or you'll be writing the
TIA after the scanline started rendering — which produces
mid-line artifacts (sometimes intentionally exploited).

The canonical control flow:

```asm
MAIN:
  ; VSYNC
  LDA #2 ; STA VSYNC ; 3× STA WSYNC ; LDA #0 ; STA VSYNC

  ; VBLANK — game logic
  LDA #2 ; STA VBLANK
  LDX #37 ; .vb: STA WSYNC ; DEX ; BNE .vb
  ; ... move sprites, read input, update state ...
  LDA #0 ; STA VBLANK

  ; Visible — render scanline-by-scanline
  LDY #192
  .draw: STA WSYNC ; <write TIA for this line> ; DEY ; BNE .draw

  ; Overscan
  LDA #2 ; STA VBLANK
  LDX #30 ; .os: STA WSYNC ; DEX ; BNE .os

  JMP MAIN
```

## Positioning objects horizontally

The TIA has NO X register. To set object X, you have to:

1. Hit `WSYNC` (now at start of next scanline)
2. Burn CPU cycles equal to the desired X position
3. Write to `RESPx` (reset position 0/1/missile/ball)
4. `STA HMOVE` later to apply fine adjustment

Common pattern: a busy loop with known cycle count per iteration:

```asm
  STA WSYNC
  LDX #15          ; X = X coord / 15 (rough)
.delay:
  DEX
  BNE .delay
  STA RESP0
  STA HMOVE
```

This places P0 at roughly column `X * 15`. Fine X (sub-15 pixels)
goes through `HMP0/HMP1/HMM0/HMM1/HMBL` followed by `HMOVE`.

## Colour bytes (NTSC palette)

128-entry palette: `HHHHLLLL` where H = hue (0..15) and L =
luminance (0..15). The same palette as the 7800.

```
$00  greyscale (black at luma 0, white at luma 15)
$0E  white
$48  cyan
$80  blue
$C8  green
$1C  yellow
$46  orange
```

## Input

```
$280  SWCHA  joystick port A (both controllers; high nibble = P1)
$282  SWCHB  console switches (reset, select, B/W, difficulty)
$0C   INPT4  P1 fire button (active low, bit 7)
$0D   INPT5  P2 fire button
```

Active low — invert after read. For SWCHA, bit 7 = P1 up, bit 6 =
P1 down, bit 5 = P1 left, bit 4 = P1 right.

### Driving input over MCP

The 2600 joystick has **one** fire button. Over MCP it's pressed with
`input({op:'set', b: true})` or the spatial `input({op:'set', south: true})` — both clear
`INPT4` bit 7 (verified live against stella). `input({op:'set', a: true})` is a **no-op**
(the 2600 pad has no second button — it's not in `input({op:'layout'})`'s
`physicalButtons`). So drive fire with `b`/`south`, plus the d-pad
up/down/left/right.

## Audio

Two voices, very simple:

```
$15  AUDC0   channel 0 wave shape (0..15 — 1=square, 6=pulse, etc.)
$16  AUDC1   channel 1 wave shape
$17  AUDF0   channel 0 frequency (0..31 — lower = higher pitch)
$18  AUDF1   channel 1 frequency
$19  AUDV0   channel 0 volume (0..15)
$1A  AUDV1   channel 1 volume
```

Write once at trigger, the TIA holds the tone until you change it.

## Collision detection

The TIA tracks 15 pairwise collision flags in registers `$30-$37`.
Each bit corresponds to "object A overlapped object B this frame."
Read them, then write `CXCLR` ($2C) to clear for the next frame.

E.g. P0 vs M1 collision is bit 6 of CXP0FB ($30).

## Cartridge layout

```
$F000-$FFF9   game code + data
$FFFA-$FFFB   NMI vector (unused on 2600)
$FFFC-$FFFD   RESET vector  ← here's where the CPU starts
$FFFE-$FFFF   IRQ vector (unused)
```

For 4 KB carts (the default), the cart is mirrored at `$F000-$FFFF`
and `$1000-$1FFF`. Most games just `org $F000` and let the mirror
take care of itself.

## Build pipeline

When you call `build({output:'rom', platform:"atari2600", source: ...})`:

1. dasm assembles the .asm directly to a flat 4 KB binary.
2. The result is `.a26` — loadable in stella (`loadMedia`).

There's no linker — dasm produces a complete cart in one pass.

## MCP debug & inspection tooling

The 2600 runs on the **stella2014 (patched)** core. Because the 2600 has
no framebuffer and no standard sound chip, its inspectors look different
from the tilemap consoles — they decode the live TIA snapshot instead.

What you can read:

- **`palette({source:'live'})`** — the NTSC 128-color palette as a PNG,
  with the *current* TIA background luma+hue extracted from the live
  snapshot so you can see what color the beam is painting right now. This
  is the same 128-entry `HHHHLLLL` palette the 7800 uses.
- **`sprites({op:'inspect'})`** — there is **no OAM** on the 2600, so this
  returns the state of the 5 TIA graphics objects (P0, P1, M0, M1, Ball)
  plus a current-scanline PNG showing how the TIA is composing that line.
- **`cpu({op:'read'})`** — the 6502 register file (A / X / Y / P / SP / PC)
  pulled from the M6502 core's internal regs.
- **`background({view:'renderState'})`** — decodes the 32-byte TIA snapshot
  into the playfield pattern, per-object enables/positions, and the color
  registers.
- **`disasm({target:'rom'})`** and **`disasm({target:'references'})`** —
  both anchor to the top of the bank (`$F000-$FFFF`) and label the vector
  table (NMI / RESET / IRQ at `$FFFA`). On banked carts (F8 = 8 KB,
  F6 = 16 KB, F4 = 32 KB) `references` scans EVERY 4 KB bank at `$F000`,
  refs tagged `romBank`; `disasm({target:'project'})` likewise emits one
  region per bank plus per-bank `BANKn` wrappers and a multi-area `.cfg`
  blob for the native ca65/ld65 rebuild.

Memory regions for **`memory({op:'read'})`**:

| Region | Size | What it is |
| --- | --- | --- |
| `system_ram` | 128 bytes | the RIOT RAM — that's the *entire* console RAM |
| `a26_tia_regs` | 32 bytes | the live TIA register snapshot |
| `a26_cpu_regs` | 7 bytes | the 6502 register snapshot |

**No `audioDebug` inspector.** The 2600's sound comes from the two TIA
audio voices (`AUDC/AUDF/AUDV` at `$15-$1A`), not a standard PSG/FM chip,
so there's no `audioDebug` decode — read the audio state directly out of
the `a26_tia_regs` snapshot instead.

## Reverse-engineering & decompilation

The Rizin/Ghidra analysis engine works here like everywhere: `disasm({target:'functions'})` to carve the program, `disasm({target:'cfg'|'xrefs'})` to trace it, `symbols({op:'analyze'})` for a one-shot structural map.

**Decompiler quality on 6502: ROUGH.** Carry-flag idioms and 16-bit math on an 8-bit CPU decompile to noise that only reads cleanly once an LLM folds it — on this CPU the disassembly is often more honest than the pseudocode. `disasm({target:'decompile', address})` returns C-like pseudocode (the `qualityNote` field restates this). Read it to UNDERSTAND a routine; use `disasm({target:'project'})` to actually edit + rebuild. See the cross-platform ROM-hacking playbook §5f for the full loop.
