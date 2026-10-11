# MSX - sprite_move

A joystick-controlled **16x16 sprite over a screen-2 TILED background**. A
checkerboard of two tile patterns (a framed grid cell + a centre dot) fills the
whole 32x24 name table; the d-pad moves a white sprite over it and clamps it to
the visible area. The minimal "draw a real tiled background → read input → move a
sprite" loop every action game starts from.

**Build** (fork, then build the project):
```
examples({op:'fork', example:'msx/sprite_move', name:'mygame', path:'/abs/path/to/projects'})
build({output:'project', path:'/abs/path/to/projects/mygame'})
```
The fork copies `main.c` plus the helper lib (`msx_vdp.c`, `msx_hw.h`) and the cart
crt0 (`msx_crt0.s`) into the project, so it builds before you change a line.

## What it shows

- **Tiled background** - `draw_background()` uploads two 8x8 patterns + their
  colour bytes into all THREE screen-2 pattern/colour banks (one per vertical
  third), then lays a checkerboard into the name table. Screen 2 is the classic
  MSX tiled mode: the colour table is one fg/bg byte per 8-pixel row.
- **16x16 sprite** - set VDP R1 to `0xE2` (display-on + 16K + size-16x16) and
  upload a 32-byte sprite pattern (four 8x8 quadrants in column order). Pattern
  `#0` is what `msx_set_sprite(0, x, y, 0, 15)` selects.
- **Input + clamp** - `msx_read_joystick(1)` returns 0=center, 1-8 clockwise
  from up; the code maps the diagonals and clamps px/py to the screen edges.

## Verified

Boot ≥300 frames past the C-BIOS logo, then drive input. Holding RIGHT+DOWN
clamps the sprite to the bottom-right `(x=238, y=174)`; LEFT+UP clamps it to the
top-left `(x=2, y=2)`. Read back from VRAM sprite-attr at `0x1B00` (region
`msx_vram`): Y, X, pattern, colour.

**Input gotcha (verified against the bluemsx core):** the C code reads MSX
joystick **1** (`msx_read_joystick(1)` → BIOS GTSTCK), and that maps to libretro
retropad **port 0** - i.e. `input({op:'set', ports: [{ right: true }]})` (the
FIRST port entry) drives the sprite. Joystick **0** is the keyboard cursor, which
a gamepad does NOT drive. Don't put the d-pad on `ports[1]`; it's a no-op here.
