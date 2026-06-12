# Atari Lynx — mental model

The first handheld with color + hardware-blitter sprites. 6502-class
CPU + two custom chips (Suzy + Mikey). cc65 targets it natively;
handy emulates it.

## CPU + memory

- **65SC02** at ~4 MHz (CMOS 6502 variant).
- **64 KB RAM** (entire address space is RAM after boot).
- ROM is *paged* through a mapper — the cartridge has the ROM, paged
  in via Mikey-controlled bank-switching. Most homebrew fits in a
  single 64KB image.

## Suzy (sprite/blitter chip)

Suzy is a **hardware sprite blitter**. You build a sprite-control-block
(SCB) in RAM describing what to draw, write its address to
`SCB_NEXT_LO/HI`, kick the blitter via the `SPRGO` bit — Suzy walks
the SCB list and renders all sprites at once into the framebuffer.

cc65's TGI driver wraps this behind `tgi_install` + `tgi_bar` /
`tgi_setcolor` / `tgi_outtextxy` — you get rectangle + text drawing
without writing SCBs manually. For pixel-level sprites use raw Suzy
calls or `tgi_sprite(scb_ptr)`.

## Mikey (everything else)

Mikey handles:
- **Display** — 160×102 visible viewport, 4bpp paletted (16 colors)
- **Palette** — 16 entries × 12-bit RGB at `$FDA0-$FDBF`
- **Audio** — 4 LFSR-based voices at `$FD20-$FD3F`. Configurable
  feedback taps + period. Lower period = higher pitch.
- **Timers** — 8 hardware timers; one drives the audio sample rate
- **Joystick** — read via SWITCHES register at `$FCB0`. cc65 provides
  `joy_read(JOY_1)` + `JOY_LEFT/RIGHT/UP/DOWN/BTN_1/BTN_2` macros.

**Live debug:** the MCP inspectors (`palette` / `cpu` / `audioDebug` /
`background` / `breakpoint`, and the SCB-list-head `sprites` special case) are
documented in "MCP debug & inspection tooling" below.

## MCP debug & inspection tooling

The Lynx runs on handy (patched). The inspectors read the *live* core state —
reach for them when a sprite or palette renders wrong and the source alone
doesn't explain it. Details and the per-tool facts:

- **`palette({source:'live'})`** — the **16-entry, 12-bit RGB** Mikey palette
  (`$FDA0-$FDBF`) converted to RGB.
- **`cpu({op:'read'})`** — 65C02 dump: A / X / Y / P / SP / PC plus the
  decoded flag bits.
- **`audioDebug({op:'inspect', chip:'mikey'})`** — the 4 Mikey voices: volume,
  the timer→period→frequency→note chain, and the **12-bit LFSR** state.
- **`background({view:'renderState'})`** — decodes DISPCTL: the DMA-enable,
  flip, and color-mode bits plus the display base address.
- **`sprites({op:'inspect'})` is the special case.** The Lynx has **no fixed
  OAM** — sprites are **SCB (Sprite Control Block) linked lists in RAM** that
  Suzy walks at blit time. So this tool can't return a sprite table; instead
  it returns the **SCB list head (SCBNEXT, `$FC10`/`$FC11`)** plus
  instructions to walk the chain yourself over `system_ram`.

### Memory regions (`memory({op:'read', region:…})`)

| Region          | Address / size        | Contents                                              |
|-----------------|-----------------------|-------------------------------------------------------|
| `lynx_cpu_regs` | —                     | 65C02 register snapshot                               |
| `lynx_hw_regs`  | $FC00-$FDFF window     | the **Suzy + Mikey** register window — sprite-engine regs, LCD control, audio, palette |
| `system_ram`    | 64 KB                 | full address space (also where the SCB chain lives)   |

Pair these with `breakpoint({on:'write'})` for the full live-debug loop.

## Frame heartbeat (cc65 + tgi)

```c
#include <tgi.h>
#include <joystick.h>
#include <lynx.h>
#include "lynx_sfx.h"

void main(void) {
    tgi_install(&lynx_160_102_16_tgi);
    tgi_init();
    joy_install(&lynx_stdjoy_joy);
    sfx_init();

    for (;;) {
        tgi_clear();
        /* draw via tgi_bar / tgi_setcolor / tgi_outtextxy */
        tgi_updatedisplay();   /* blocks until vblank, flips buffers */
        sfx_update();
        /* read joy_read(JOY_1) + update state */
    }
}
```

`tgi_updatedisplay()` is the frame heartbeat — it ping-pongs the
double-buffered display and waits for vblank.

## Drawing many rectangles in one frame (example-game pattern)

The minimal example above draws "one rect per frame." For an actual
game with HUD + background + sprites you'll do many tgi_bar / tgi_setcolor
pairs per frame. The pattern that works:

```c
for (;;) {
    /* 1. Fill the entire framebuffer with the BG color FIRST. This
     *    erases the previous frame on the back-page (Lynx TGI is
     *    double-buffered — see below). */
    tgi_setcolor(C_BG);
    tgi_bar(0, 0, 159, 101);

    /* 2. Draw EVERYTHING from scratch every frame: HUD, scoreboard,
     *    sprites, text. The back-page was just blanked; whatever you
     *    don't draw won't appear. */
    draw_hud();
    draw_scoreboard();
    draw_basket();
    for (i = 0; i < MAX_SPRITES; i++) draw_sprite(i);

    /* 3. Swap pages — what you just drew becomes visible at next vblank. */
    tgi_updatedisplay();

    /* 4. Update game state for next frame. */
    pad = joy_read(JOY_1);
    update_world(pad);
}
```

**Don't try to "persist" anything between frames** by drawing it once
outside the loop — the back-page gets blanked every iteration. Every
visible thing must be re-drawn every frame. This is unlike NES/SMS/GG
where the BG nametable persists in VRAM.

## Double-buffering

cc65's Lynx TGI driver maintains TWO display pages and the vblank IRQ
flips between them on `tgi_updatedisplay()`. While the user sees page
A, your `tgi_bar` calls write to page B. After update, page B is
shown and you start drawing on page A.

Practical consequence: **`tgi_updatedisplay` is non-blocking** — it
just sets a swap-request flag. The actual swap happens in the next
vblank IRQ. If your loop iterates faster than vblank, you'll request
swaps that get coalesced. That's fine for steady-state rendering, but
it means there's no built-in 60 fps cap. If you want frame rate
control, call `tgi_setframerate(60)` after `tgi_init()`.

## Audio (lynx_sfx)

The bundled `lynx_sfx.{h,c}` wraps Mikey's 4 audio voices with the
cross-platform shape:

- `sfx_init()`
- `sfx_tone(channel, period, length_frames)` — channel 0-3
- `sfx_noise(length_frames)` — voice 3, LFSR feedback for white noise
- `sfx_update()` — call once per frame to tick auto-silence
- `sfx_off()`

period is the 8-bit timer reload — Hz ≈ 6 MHz / 16 / (period+1).
Useful: 80 = ~6 kHz (high pew), 160 = ~3 kHz (mid blip), 200 = ~2 kHz
(low thump).

### cc65's lynx_snd music engine

For streamed music (vs one-shot SFX) use cc65's bundled lynx_snd:

```c
lynx_snd_init();                       // installs 240Hz IRQ + voice reset
lynx_snd_play(channel, demo_music);    // begin streaming on the channel
lynx_snd_stop_channel(channel);        // stop ONE channel
lynx_snd_stop();                       // stop ALL channels (no arg)
```

**Stop variants:** `lynx_snd_stop(void)` stops every channel.
`lynx_snd_stop_channel(unsigned char ch)` stops one channel. Easy to
type `lynx_snd_stop(1)` and get a compile error — use the right one.

**Signature gotcha:** `lynx_snd_play`'s second arg is
`unsigned char *music` — non-const. The bundled `demo_music[]` is
declared non-const so it matches the cc65 signature without warning.
If you build your own bytestream and want to mark it `const`, you'll
need a `(unsigned char *)` cast at the call site.

### Audio + TGI interaction (R29 diagnosed → R57 fixed)

Earlier round-28/29 reports of "calling sfx_init / sfx_tone wedges
TGI rendering" were a real bug, now resolved in `lynx_sfx.c`.

**Root cause:** writing the MIKEY voice CTL register ($FD25 / $FD2D /
$FD35 / $FD3D) with the ENABLE_COUNT bit set triggers handy's
`gNextTimerEvent = gSystemCycleCount` (mikie.cpp:1676) — a SYNCHRONOUS
timer-event sweep at the next CPU instruction. That sweep can preempt
an in-flight Suzy blit operation and the partially-blitted sprite
gets corrupted. Symptom: HUD + score render (Suzy was idle for those),
playfield sprites missing (Suzy was mid-blit when the sweep landed).

**Fix (R57):** `sfx_tone` and `sfx_noise` now stage their config in
shadow RAM and DEFER the MIKEY writes until `sfx_update()` is called.
The contract is: **`sfx_update()` MUST be called during vblank** —
typically right after `tgi_updatedisplay()`. The timer-event sweep
then lands during vblank where Suzy is idle.

Canonical loop is unchanged in shape; just be sure `sfx_update` runs
after the vblank wait:

```c
for (;;) {
    tgi_setcolor(C_BG);
    tgi_bar(0, 0, 159, 101);
    draw_hud();
    draw_basket();
    // ... game logic, can call sfx_tone() / sfx_noise() freely ...
    tgi_updatedisplay();   // vblank wait + page swap
    sfx_update();          // ← MIKEY writes happen here, during vblank
}
```

`lynx_snd_play` (cc65's full music engine) hasn't been re-verified
against R57 yet — it installs a 240Hz IRQ that's a different
mechanism. If you need music, the per-frame `sfx_tone()` melody
pattern remains a known-safe alternative:

```c
static const uint8_t melody_periods[] = { 180, 140, 110, 140, 95, 110, 140, 110 };
static uint8_t melody_idx, melody_timer;
void update_music(void) {
    if (melody_timer == 0) {
        sfx_tone(2, melody_periods[melody_idx], 18);
        melody_idx = (uint8_t)((melody_idx + 1) % 8);
        melody_timer = 18;
    } else { melody_timer--; }
}
```

## Joystick

The Lynx has a 4-direction d-pad + 2 face buttons (A, B) + 2
"option" buttons (Opt1, Opt2). cc65 exposes them via `JOY_LEFT(joy)`
etc. There's no second controller — Lynx had a ComLynx link cable
for multi-Lynx multiplayer but no second controller on one unit.

### Driving input over MCP

handy maps `input({op:'set'})` button names **straight through** — verified live, no
inversion: `{a}`→A (outer), `{b}`→B (inner). Spatial east→A, south→B; Opt1/Opt2
map to `{start}`/`{select}`. So `input({op:'set', a: true})` presses Lynx A as
expected. ⚠ Note: the Lynx hardware register `$FCB0` is **active-HIGH** (1 =
pressed, opposite most platforms) — that only matters if you read the register
directly; the `input({op:'set'})` names themselves are normal.

## Color

16-color palette per frame at `$FDA0` (BG) + `$FDB0` (intensity).
cc65's tgi uses a sensible default palette (`COLOR_RED`, `COLOR_GREEN`,
etc.) — see `tgi_setpalette()` if you want custom colors.

## Cartridge format

The ROM file format Handy expects is `.lnx` — a 64-byte header
(magic + bank layout) followed by the raw ROM image. cc65's
`lynx.cfg` produces a header-less raw image; some tools wrap it
into `.lnx`. handy accepts both.

## Differences from C64 (the other 6502-family platform)

- 4 colors → 16. Per-frame palette.
- Hardware sprite blitter (Suzy) vs VIC-II 8-sprite hardware.
- 4-voice LFSR audio (Mikey) vs 3-voice SID. Mikey lacks SID's
  filter + ADSR but is simpler.
- Joystick is direct register read at `$FCB0`, not via CIA1.
- One controller (handheld) — no port 2 fallback patterns.
- 64 KB total RAM, mapped ROM. C64 has 64 KB RAM but most is shadowed
  by ROM by default.

## Reverse-engineering & decompilation

The Rizin/Ghidra analysis engine works here like everywhere: `disasm({target:'functions'})` to carve the program, `disasm({target:'cfg'|'xrefs'})` to trace it, `symbols({op:'analyze'})` for a one-shot structural map.

**Decompiler quality on 65C02: ROUGH.** Carry-flag idioms and 16-bit math on an 8-bit CPU decompile to noise that only reads cleanly once an LLM folds it — on this CPU the disassembly is often more honest than the pseudocode. `disasm({target:'decompile', address})` returns C-like pseudocode (the `qualityNote` field restates this). Read it to UNDERSTAND a routine; use `disasm({target:'project'})` to actually edit + rebuild. See the cross-platform ROM-hacking playbook §5f for the full loop.
