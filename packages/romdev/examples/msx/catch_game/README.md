# MSX — catch_game

A complete, playable MSX cartridge game (SDCC z80, C89). Move the basket at the
bottom left/right with the joystick (or keyboard cursor keys) to catch the coin
falling from the top. Catch it: **+1 score** and the coin respawns in a new
column; miss it (it reaches the floor): it just respawns — a friendly, no-fail
demo. The score is drawn as on-screen tiles (`SCORE 000`) along the top row.

What it demonstrates, end to end:

- **screen 2 (GRAPHIC II)** setup via `msx_set_screen2()` (BIOS INIGRP).
- **Tile font** — a 16-glyph mini font (`SCORE` + the 10 digits) uploaded to the
  pattern generator + color table, then placed via the name table. This is how
  you draw HUD text without the BIOS text mode.
- **Two hardware sprites** — basket (plane 0) + coin (plane 1), repositioned
  every frame with `msx_set_sprite()`.
- **Input** — `msx_read_joystick()` (BIOS GTSTCK) read on BOTH stick 0 (keyboard
  cursor) and stick 1 (port), so keys or a pad both work.
- **AABB collision + scoring**, with a short PSG catch blip (`msx_psg_tone`).
- **Vblank-synced game loop** — one step per VDP frame.

## Vblank without the BIOS ISR (the load-bearing gotcha)

The shared lib's `msx_vblank_wait()` spins on the BIOS **JIFFY** counter, which
only advances while the BIOS VBlank **interrupt handler** runs. On a bare
cartridge under C-BIOS, JIFFY does **not** advance (it stays frozen) — so
`msx_vblank_wait()` hangs forever and the game loop never runs (you'd see the
static HUD but no moving sprites). This example instead polls the VDP directly:

```c
__sfr __at 0x99 VDPSTATUS;          /* port 0x99 read = selected S# register */
static void vsync(void) {
    (void)VDPSTATUS;                /* reading S#0 clears the frame flag */
    while (!(VDPSTATUS & 0x80)) { } /* spin until the next VBlank sets it */
}
```

Reading status register S#0 bit 7 (the frame flag) needs **no interrupts** and
works on any MSX. Use this pattern in any bare-cart MSX game; don't depend on
JIFFY/`msx_vblank_wait()` unless you've installed your own ISR or confirmed the
BIOS one is live.

## Build + run

`.c`/`.s` go in `sources`, `.h` in `includes`:

```js
import { buildForPlatform } from "romdev/src/toolchains/index.js";
const build = await buildForPlatform({
  platform: "msx",
  sources:  { "main.c": SRC, "msx_vdp.c": LIB, "msx_crt0.s": CRT0 },
  includes: { "msx_hw.h": HDR },
  crt0: ".module empty\n",
  sourceName: "main.c",
});
```

`_verify.mjs` is the runnable harness used to verify this example: it builds,
steps past the C-BIOS logo (~300 frames), screenshots, then drives RIGHT and
LEFT input and confirms the basket sprite's bright-pixel centroid actually moves
(`shot_before.png` → `shot_after_right.png` → `shot_after_left.png`).

```
node examples/msx/catch_game/_verify.mjs   # prints VERIFIED_OK
```

Verified on the bluemsx core: HUD + both sprites render, the basket tracks
left/right input, and catching coins increments the on-screen score
(`SCORE 000` → `SCORE 003` while auto-tracking the coin).

## Reusable starter

This is a good base for any **catch / dodge / single-screen arcade** MSX game.
The tile-font HUD, two-sprite + AABB pattern, dual-stick input read, and the
interrupt-free `vsync()` are all drop-in reusable.
