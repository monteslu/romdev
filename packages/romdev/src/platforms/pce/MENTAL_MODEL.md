# PC Engine / TurboGrafx-16 — mental model

One page. Read once before you write your first PC Engine game. The
TROUBLESHOOTING.md alongside this file is for when something's broken; this is
the "what's going on" version.

## CPU — HuC6280 (a 65C02 superset)

The HuC6280 is a 65C02 core with extras: a memory-mapping unit (MPR registers),
a built-in sound chip (PSG), a timer, and block-transfer instructions (`tii`,
`tia`, etc.). For C development with cc65 you mostly don't touch the MPR — the
`pce` target's runtime maps the HuCard and 8 KB of work RAM for you.

```
CPU address space (16-bit, banked via 8 MPRs that map $2000 windows):
  $0000-$1FFF   work RAM (8 KB) — also the stack ($21xx page)
  $4000-$BFFF   (mapped HuCard / hardware via MPR)
  $E000-$FFFF   HuCard ROM (reset/IRQ vectors at $FFF6+)
```

cc65 links your C `_CODE` into ROM and runs `pce/crt0.s`, which clears `.bss`,
copies `.data`, sets the stack, runs constructors, then calls `main`.

## Video — HuC6270 VDC + HuC6260 VCE (two chips)

The **HuC6270 VDC** owns 64 KB of VRAM (word-addressed) and the display:
- A tiled background ("BAT" = Background Attribute Table in VRAM) — there is NO
  separate nametable region; the map lives in VRAM. Virtual screen size is set
  by VDC register R9 (MWR).
- 64 hardware **sprites** via the SATB (Sprite Attribute Table), 16/32 wide ×
  16/32/64 tall. The SATB is DMA'd from VRAM (source in R19).
- VDC register **R5 (CR)** is the master switch: bit 7 = BG enable, bit 6 = SPR
  enable. If both are clear you see only the backdrop color. `getRenderingContext`
  reads this and tells you.

The **HuC6260 VCE** owns color: a 512-entry table (256 BG + 256 SPR sub-palette
slots), each a **9-bit GRB** value (`0bGGG_RRR_BBB`, 3 bits per channel). Slot 0
of every 16-color sub-palette is transparent/backdrop. `inspectPalette` decodes it.

## Frame heartbeat

The VDC raises VBlank once per frame (~60 Hz NTSC). cc65 gives you `waitvsync()`
(libsrc/pce/waitvsync.s) to sync to it — update VRAM during VBlank to avoid
tearing. There is no NMI; the VDC IRQ (R5 bits 2-3 enable raster/vblank IRQ)
drives interrupt-based code.

## Build pipeline

`buildSource({ platform: "pce" })` → cc65 (C89) → ca65 → ld65 with `pce.cfg`
→ a HuCard `.pce` image. The fastest visible output is cc65's **conio** text
library (`#include <conio.h>`): `clrscr()` inits the VDC+VCE and uploads a font,
`cputs()`/`gotoxy()` draw text. The `hello_pce.c` starter snippet does exactly
this.

## The one trap that will bite you

cc65's `pce/crt0.s` clears `.bss` with a block instruction sized `__BSS_SIZE__-1`.
If your program has **no globals/statics**, `__BSS_SIZE__` is 0, the `-1`
underflows, and you get a **"Range error in pce/crt0.s"** at link AND a black
screen. Keep at least one (2+ byte) global. See TROUBLESHOOTING.md.

## Art + input

- `convertImageToTiles({ platform: "pce" })` — PNG → 4bpp HuC6270 tiles (the
  "planar-pairs" layout: 32 B/tile, 16 B plane 0+1 then 16 B plane 2+3). Returns
  a suggested 16-color palette too. DMA the bytes to your VRAM pattern base.
- `getInputLayout({ platform: "pce" })` — the 2-button pad (I=east/'a',
  II=west/'b', Run=start, Select=select) + how the joyport scan works.

## Debugging tools

- `getCPUState()` — HuC6280 PC/A/X/Y/S/P + flags + timer/IRQ state.
- `getRenderingContext()` — VDC R5 screen-enable, BG scroll, SATB source.
- `inspectPalette()` — VCE 512-entry 9-bit GRB (area:'bg'|'sprite').
- `inspectSprites()` — SATB 64 sprites (x/y/tile/palette/size/flip).
- `getMemoryMap()` — where cc65 placed your variables (after buildSourceWithDebug).
- `getAudioState({ chip: "pce" })` — the HuC6280 PSG: 6 wavetable channels
  (per-channel freq/volume/wave; channels 4-5 can also do noise) + main amplitude
  + LFO.
- `readMemory()` regions: `pce_vdc_vram`, `pce_vdc_satb`, `pce_vdc_regs`,
  `pce_vce_palette`, `pce_cpu_regs`, `pce_psg_regs`.
