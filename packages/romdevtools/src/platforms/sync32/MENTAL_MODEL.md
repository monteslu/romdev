# sync32 — mental model

A 32-bit console with a **flat framebuffer and a function-pointer API**. If you
have written for the 8- and 16-bit platforms in this tree, unlearn the reflexes:
there are no hardware registers to poke, no VRAM to bank, no tilemap, no
scanline timing to hit. A game is an ARM binary that receives a struct of
function pointers and draws into a byte array.

## The shape of a game

```c
#include "sync32.h"

void game_main(const sync32_api_t *api) {   // the ONE symbol a cart exports
  for (;;) {
    s32_pad_t pad;
    api->pad(0, &pad);
    if (pad.buttons & S32_PAD_A) { /* ... */ }

    api->clear(0x0000);
    api->rect(10, 10, 32, 32, 0xF800);
    api->present();                          // blocks until the frame is shown
  }
}
```

`game_main` never returns in a normal game. `api->exit()` returns to the
launcher.

## Hardware

| | |
|---|---|
| CPU | ARM Cortex-M33 (ARMv8-M main), **thumb**, hard float (fpv5-sp-d16, single precision) |
| Video | 320x240 (`S32_VIDEO_240`, 4:3) or 320x180 (`S32_VIDEO_180`, 16:9 letterbox) |
| Colour | RGB565, 16-bit |
| Sprites | `S32_MAX_SPRITES` = 128 per frame, from loaded sheets |
| Audio | 48kHz stereo s16, a ring of `S32_AUDIO_RING` (1024) frames |
| Save | 8 slots, `S32_SAVE_MAX` (64KB) each |
| Load modes | `ram` (image at 0x20030000) or `xip` (execute in place, 0x10100000) |

## The API struct

`api->api_version` says what is present. Everything through `save_write` is
**v1**; the `disk_*` functions are **v2**. A cart declares the minimum it needs
in its header (`build({api: 2})`) and the console refuses to run it on older
firmware — so check the version rather than calling a v2 pointer on a v1
console.

**Video — and the one idiom that surprises everyone.** `clear(rgb565)` and
`rect(..., rgb565)` take a COLOUR, but the canvas is 8-bit **indexed**. The
console therefore maps your colour to the **nearest entry in the 256-slot
palette** and stores that index. A colour you never put in the palette does not
render as itself; it snaps to whatever is closest — which is how a "grey road"
comes out blue when the palette holds only sprite colours.

So: **every colour a game draws with must also be in the palette.** Put your
backgrounds, HUD colours and grid lines in there alongside the sprite colours.

`sprite()` blits from a loaded sheet, and `present()` shows the frame and paces
the game. For direct pixel work, `canvas()` returns the framebuffer bytes
and `canvas_mark(y0, y1)` tells the console which rows changed — mark only what
you touched, since the console uploads marked rows.

**Sprites.** `sheet_load(pixels8, w, h)` uploads an 8-bit indexed sheet and
returns a handle; `palette_set()` supplies the 256-entry RGB565 palette.
`sprite(sheet, sx, sy, w, h, x, y, flags)` blits a rect from it, with
`S32_SPRITE_FLIP_X` / `S32_SPRITE_FLIP_Y`.

**Input.** `pad(player, &out)` fills `buttons` (the `S32_PAD_*` bits) plus
analog `lx/ly/rx/ry` and `connected`. Analog axes are reported when hardware has
them and are **never required** — a game that only works with sticks will not
run on every console.

**Audio — the one real trap.** The ring holds ~1024 frames, but one video frame
of audio at 48kHz is 800 frames, so the ring is *smaller than two frames' worth*.
`audio_push()` accepts at most `audio_space()` frames and **silently drops the
rest**. Pushing a whole frame in one call therefore loses samples and leaves the
stream under 48kHz — and against the HDMI clock the console declares, a sink
resolves that mismatch by muting. Push small amounts spread across the frame,
topping up as the console drains.

**Storage.** `save_read`/`save_write` take a slot index. The v2 `disk_*`
functions stream files from the game's own directory, sandboxed to it:
`disk_list` enumerates by index until `S32_DISK_ENOENT`, then
`disk_open`/`disk_size`/`disk_seek`/`disk_read`/`disk_close`.

## Building through romdev

```js
build({ platform: 'sync32', language: 'c',
        sources: { 'main.c': src },
        title: 'My Game', id: 'mygame01', mode: 'ram', video: '240', api: 1 })
```

Compilation is the WASM `arm-none-eabi` toolchain targeting Cortex-M33; the SDK
crt0, linker scripts and `sync32.h` ship in `romdev-platform-sync32`, so nothing
external is needed. The result is a launchable `.s32`.

A game with **resources** passes `data` (or `dataPaths`) and gets the archive
form instead — `main.s32e` + `info.txt` + your files in one tar, because a game
that reads through the disk API needs its namespace to travel with it. Set
`api: 2` when you use `disk_*`.

## Freestanding, and what that means

A cart links **no libc**. There is no `printf`, no `malloc`, no `string.h`.
Write your own helpers, or use what the API gives you. The compiler may still
emit calls into **libgcc** for things the CPU cannot do in one instruction —
64-bit division, double-precision float — and those are linked from the bundled
ARMv8-M libgcc.

Two consequences worth internalising:

- **Prefer `float` to `double`.** The FPU is single-precision only. A `double`
  compiles to soft-float calls that are an order of magnitude slower. Builds use
  `-fsingle-precision-constant` so `1.5` is a float, but a declared `double`
  is still a double.
- **Avoid 64-bit integer division** in a hot loop for the same reason: it is a
  library call, not an instruction.

## Memory modes

`ram` copies the image to RAM at 0x20030000 and runs it there — faster, and the
default. `xip` executes in place from flash at 0x10100000, which leaves more RAM
for the game at the cost of slower fetches. The mode selects a different linker
script, so it is a build-time decision, and the header records it.
