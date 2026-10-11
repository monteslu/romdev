# GameTank - mental model

The GameTank is Clyde Shaffer's open-hardware 8-bit console: a **W65C02S** main
CPU, a **hardware blitter** drawing into a 128x128 framebuffer, and a second
65C02 running as the audio coprocessor (the ACP). romdev builds for it with
**cc65** and the cart format is `.gtr`.

## The shape of the machine

| | |
|---|---|
| CPU | W65C02S (cc65 target) |
| Video | 128x128 framebuffer, double-buffered, drawn by a blitter |
| Graphics RAM | GRAM pages hold sprite sheets that the blitter copies from |
| Audio | the ACP: a second 65C02 driving a DAC, fed by firmware the SDK uploads |
| Input | two gamepad ports, 3-button pads (A, B, C) + Start |
| Cart | 32 KB flat image at `$8000`, one region |

There is **no tilemap, no nametable and no sprite OAM**. Every frame is redrawn
from scratch by blitter commands: filled boxes and rectangle copies out of
GRAM. Think of it as closer to the Lynx (also 65C02 + blitter) than to the NES.

## Drawing: always through the SDK draw queue

The bundled SDK (`gametank.h`, `gfx/draw_queue.h`, `gfx/sprites.h`, copied into a
forked project) queues blitter operations and runs them as the blitter frees
up. Use the queue. Synchronous blits corrupt the framebuffer and drop the frame
rate. The example games wrap it in `gt_draw.h`, which documents three gotchas:

1. A box whose width OR height is 128 is silently dropped. Clamp to 127.
2. Box top-edge scanlines can flicker between the two framebuffer pages. Finish
   a frame that draws near the top with `queue_clear_border(topColor)`.
3. Use `rnd8()` from `gt_draw.h`, not the SDK `rnd()`, which corrupts state on
   this single-bank build.

Per-frame GRAM sprite blits are the expensive part. Too many overrun vblank and
the queue drops draws (visible as flicker), so keep sprite blits few and draw
simple shapes as filled boxes.

## Building

All five genre examples ship (`gametank/shmup|platformer|puzzle|sports|racing`).
`sports` is a genuine 2-player game, since the GameTank has two gamepad ports.
Fork one, then build the project:

```js
examples({ op:'fork', example:'gametank/shmup', name:'mygame', path:'/abs/path/to/projects' })
build({ output:'project', path:'/abs/path/to/projects/mygame' })
```

The fork carries the SDK runtime and the example's helper headers
(`gt_draw.h`, `gt_palette.h`, `gt_sprites.h`, `gt_hud.h`, `gt_sound.h`). A
direct `build()` uses `linkerConfig:"sdk"`.

## Driving input over MCP

Use `input({op:'press', button:'a'|'b'|'c'})` or the spatial names
(`north/east/south/west`): both resolve to the physical GameTank button.
`input({op:'layout', platform:'gametank'})` has the exact map. The C side reads
`player1_buttons` / `player2_buttons` against the `INPUT_MASK_*` bits in
`input.h` after `update_inputs()`.

## MCP debug & inspection tooling

The core is patched with romdev's debug hooks, so the classic-platform tool set
works:

- **`cpu({op:'read'})`** - the 65C02 register file.
- **`audioDebug({op:'inspect', chip:'acp'})`** - the ACP's state: DAC output,
  IRQ/sample rate, run/mute, and the audio CPU's PC.
- **`breakpoint({on:'write'|'read'|'pc'})`**, the `cpu({op:'call'})` watchdog,
  and `watch({on:'pc'})` coverage.
- **`palette({source:'live'})`** and `frame({op:'verify'})` for render health.
- **Not available:** `sprites({op:'inspect'})` and `background`. The blitter
  has no OAM and the screen is a framebuffer, not a tilemap.

## Reverse-engineering & decompilation

- **Disassembly:** `disasm({target:'bytes'|'rom'|'references'|'project'})`. A
  cart is one flat 32 KB region at `$8000`, so `disasm({target:'project'})`
  produces a single region and `build({output:'reassemble', platform:'gametank', path})`
  rebuilds it byte-identical in one call.
- **Structure:** the 6502 Rizin/Ghidra path - `disasm({target:'functions'|'cfg'|'xrefs'})`
  and `symbols({op:'analyze'})`.
- **Cart parts:** `cart({op:'extract'|'wrap'})`.
- **Re-inject:** the 6502 `romPatch` path (`write`, `findPointer`, `relocate`,
  `makeStored` with `raw`), same as NES, C64 and Lynx.
- **Cheats:** `cheats({op:'make', platform:'gametank'})` encodes a GameTank Game
  Genie code. There is no bundled cheat database for GameTank.

**Decompiler quality on 65C02: ROUGH.** Carry-flag idioms and 16-bit math on an
8-bit CPU decompile to noise; the disassembly is often clearer than the
pseudocode. `disasm({target:'decompile', address})` returns C-like pseudocode
(the `qualityNote` field restates this). Read it to UNDERSTAND a routine; use
`disasm({target:'project'})` to actually edit + rebuild. The full loop is in
the ROM-hacking playbook, section 5f
(`platform({op:'doc', platform:'romhacking', name:'playbook'})`).
