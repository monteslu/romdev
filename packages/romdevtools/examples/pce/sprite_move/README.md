# PC Engine - sprite_move

A joypad-controlled 16x16 sprite over a tiled checkerboard background. The d-pad
slides the sprite around the screen. Exercises the whole PCE helper lib:
`vce_set_color` (9-bit GRB palette), `vram_write`/`load_tiles`, the BAT fill,
`set_sprite` + `satb_dma`, `bg_enable`/`spr_enable`, `pce_joy_init`/`pce_joy_read`.

**Build** (fork, then build the project):
```
examples({op:'fork', example:'pce/sprite_move', name:'mygame', path:'/abs/path/to/projects'})
build({output:'project', path:'/abs/path/to/projects/mygame'})
```
The fork copies `main.c` plus the helper lib (`pce_hw.h`, `pce_video.c`,
`pce_input.c`, `pce_sound.c`) into the project. cc65 supplies crt0 + pce.lib.

**Verified:** builds, the BG renders, and the sprite POSITION responds to the
d-pad (X 120→208 on RIGHT, Y→188 on DOWN, confirmed via the SATB region). Keep
≥1 global so cc65's crt0 .bss-clear doesn't underflow (the helper's `_pce_keep`
covers this).
