# MSX / MSX2 — mental model

One page. Read once before you write your first MSX game. The TROUBLESHOOTING.md
alongside this file is for when something's broken; this is the "what's going on"
version.

## Start here — don't hand-write the VDP/PSG plumbing

romdev ships a **hardware helper library** (`src/platforms/msx/lib/c/`:
`msx_hw.h` + `msx_vdp.c`, plus the cartridge `msx_crt0.s`) so you call
`msx_set_screen2()`, `msx_vram_write()`, `msx_set_sprite()`, `msx_read_joystick()`,
`msx_psg_tone()` in plain C. It uses DIRECT Z80 I/O ports (the reliable path —
NOT fragile inline-asm BIOS wrappers).

The fastest way to a working game: **fork the example game whose core loop is
nearest yours — `examples({op:'fork', example:"msx/shmup", name, path})`** — or any
of `platformer` / `puzzle` / `sports` / `racing`, the full genre set. For a smaller
starting point fork `msx/sprite_move` (also `music_sfx`, `catch_game`). Either drops
a complete, *building* project — a verified playable example + the helper lib +
the cart crt0 + docs. Read the example's `main.c`, then change it. Examples live in
`examples/msx/`. The `platformer` example column-streams the SCREEN 2 name table
for a tile-by-tile side-scroll. **Gotcha:** read joystick **port 1**
(`msx_read_joystick(1)`) — port 0 is the keyboard, which an emulator's gamepad
doesn't drive.

## CPU — Z80 (16-bit address space, paged in 16 KB slots)

```
$0000-$3FFF   slot 0 — BIOS ROM (C-BIOS): BDOS-ish entry points, the font, INITXT etc.
$4000-$BFFF   slot 1 — YOUR CARTRIDGE (32 KB) maps here
$C000-$FFFF   slot 3 — work RAM
```

The MSX uses a slot/subslot memory system; a 32 KB cartridge maps at
**$4000-$BFFF**. You don't manage slots for a simple ROM — the BIOS pages your
cart in and CALLs it.

The Z80 has a separate **I/O port** space (`in`/`out`). The VDP, PSG, and PPI
(keyboard/joystick) are reached via ports, but for most things you call **BIOS
routines** in slot 0 instead of touching ports directly.

## The cartridge boot handshake (critical)

A cart ROM begins with a 16-byte header at $4000:
```
$4000  "AB"           cartridge magic (0x41 0x42)
$4002  INIT  pointer  the BIOS CALLs this to start your program
$4004  STATEMENT      BASIC hook (0 = none)
$4006  DEVICE         (0 = none)
$4008  TEXT           (0 = none)
$400A..$400F          reserved (0)
```
On boot the BIOS scans slots, finds "AB", and **CALLs INIT**. Two rules:
1. **INIT must NOT return.** If it `ret`s, the BIOS decides no bootable cart is
   present and prints "No cartridge found" (after running your code, so you'll
   *see* your output flash, then the error). End `main()` in an infinite loop.
2. **C-BIOS shows its logo for ~2-3 s (≈150 frames) BEFORE calling INIT.** Step
   at least 240 frames before expecting output on screen.

romdev's `msx_crt0.s` starter emits this header and handles the handoff; build
your `main.c` together with it (`crt0:'.module empty\n'`).

## Video — V9938 VDP (TMS9918 superset on MSX2)

VRAM up to 128 KB. The VDP has 64 registers (`msx_vdp_regs`) + 16 status
registers (`msx_vdp_status`):
- **R1 bit 6** is the master display enable. If clear, you see only the border
  color. `background({view:'renderState'})` reads this.
- Screen mode is selected by M1-M5 bits across R0/R1. Text (screen 0/1), tiled
  (screen 2), and MSX2 bitmap (screen 4+) modes have different VRAM table layouts;
  `background({view:'renderState'})` decodes the mode and the pattern/color/sprite table base
  addresses for you.
- **Palette:** on MSX2 bitmap modes, 16 programmable entries (`msx_palette`),
  each a **9-bit GRB** value. On MSX1/TMS9918 modes the palette is a fixed
  16-color hardware set. `palette({source:'live'})` picks the right source automatically.
- **Sprites:** up to 32, defined in a VRAM sprite-attribute table (base from R5/
  R11). Y=208 ($D0) terminates the list. `sprites({op:'inspect'})` reads it.

## Frame heartbeat

The VDP raises a VBlank interrupt (~60 Hz NTSC / 50 Hz PAL). Status register 0
bit 7 is the VBlank flag. The BIOS's interrupt handler runs each frame; your code
can hook it or just poll.

## Build pipeline

`build({output:'rom', platform: "msx"})` → SDCC (z80, C89) → sdasz80 → sdld with your
`msx_crt0.s` → a 32 KB `$4000`-based cartridge image. The fastest visible output
is BIOS calls: **INITXT ($006C)** (40-col text mode + clear + enable display),
**CHPUT ($00A2)** (print the char in register A). The `hello_msx.c` starter does
exactly this.

## Art + input

- `encodeArt({stage:'tiles', platform: "msx"})` — PNG → MSX screen-2 tiles. Returns
  TWO streams: `pattern.bin` (1bpp) + `color.bin` (per-row fg/bg nibbles into the
  fixed 16-color TMS9918 palette). Each 8-pixel row is limited to 2 colors —
  that's the classic MSX constraint. DMA pattern.bin to the pattern-generator
  base and color.bin to the color-table base (getRenderingContext shows both).
- `input({op:'layout', platform: "msx"})` — the joystick path via BIOS GTSTCK
  ($00D5) + GTTRIG ($00D8). **Driving input over MCP:** bluemsx maps `input({op:'set'})`
  straight through (verified live, no inversion): `{a}`→trigger 1 (east),
  `{b}`→trigger 2 (west). So `input({op:'set', a: true})` presses trigger 1 as
  expected — unlike the genesis_plus_gx platforms, there's no surprise here.

## Debugging tools

- `cpu({op:'read'})` — Z80 PC/SP/AF/BC/DE/HL/IX/IY + shadow regs + flags + IFF/IM.
- `background({view:'renderState'})` — VDP R1 display-enable, screen mode, VRAM table bases.
- `palette({source:'live'})` — V9938 9-bit GRB (or TMS9918 fixed) 16 entries.
- `sprites({op:'inspect'})` — VRAM sprite-attribute table, up to 32 sprites.
- `symbols({op:'map', map})` — pass the sdld `.map` (the `symbols` field from
  build({output:'romWithDebug'})) to see where SDCC placed your variables/code, grouped by
  region (bios / cart_rom / work_ram).
- `audioDebug({op:'inspect', chip: "ay8910"})` — the AY-3-8910 PSG: 3 square-wave
  channels (tone period→Hz, amplitude, tone/noise enable) + a shared noise
  generator + the envelope (period + shape bits).
- `memory({op:'read'})` regions: `msx_vram`, `msx_vdp_regs`, `msx_vdp_status`,
  `msx_palette`, `msx_cpu_regs`, `msx_psg_regs`, plus `system_ram` (work RAM).
- `disasm({target:'rom'|'references'|'project'})` — native binutils z80
  `objdump`. MegaROMs (>32 KB) are handled per 16 KB bank: `references` scans
  bank 0 at `$4000` (after the "AB" header) and banks 1+ at `$8000` (an
  assumed ASCII16-style window), refs tagged `romBank`;
  `disasm({target:'project'})` splits the header into its own data region and
  emits a bank-by-bank native rebuild recipe in `BUILD.md`.

## MCP debug & inspection tooling

MSX is a **Tier-1** platform with deep introspection — the full set of
inspectors and memory regions is listed under **"Debugging tools"** above
(`cpu` / `background` / `palette` / `sprites` / `symbols` / `audioDebug` for
the AY-3-8910 PSG, and the `msx_vram` / `msx_vdp_regs` / `msx_vdp_status` /
`msx_palette` / `msx_cpu_regs` / `msx_psg_regs` / `system_ram` regions). The
PSG-channel decode means `audioDebug({op:'inspect', chip:'ay8910'})` gives
you the 3 square-wave channels plus the shared noise generator and envelope
without poking at `msx_psg_regs` by hand.

### ColecoVision shares this core family — but is bring-up only

ColecoVision runs the same toolchain family and exposes only the **standard**
introspection: `system_ram` + `save_ram` + `video_ram`. It has **no deep
inspectors** (no `palette` / `sprites` / `background` / `audioDebug` decode)
and **no MENTAL_MODEL of its own** — treat it as a bring-up target, not a
finished Tier-1 platform.

### Extending introspection (for whoever adds a platform)

Deeper, decoded inspectors are not free — each is implemented by **patching
the emulator core** to expose the extra register/VRAM regions, then wiring a
decoder. To add deep introspection to ColecoVision (or any thin platform),
follow the existing core-patch pattern used for snes9x / gpgx / fceumm / vice
under **`scripts/patches/`**.
