# Game Boy Advance — mental model

One page. Read once before you write your first GBA game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## Runtimes (R28)

Two C runtimes ship bundled. Pass `runtime:` to `build({output:'rom'})` /
`build({output:'run'})` to pick:

- **`"libtonc"` (default)** — Tonc-tutorial aligned. `#include <tonc.h>`,
  TTE (Tonc Text Engine) for text via `tte_init_chr4c_default` +
  `tte_write` / `tte_printf`, `tonccpy` / `toncset` for VRAM-safe copy,
  `OBJ_ATTR` shadow buffer + `oam_copy` for sprite updates,
  `key_poll` + `key_held`. Matches what every published tutorial at
  gbadev.net teaches.
- **`"libgba"`** — devkitPro's official SDK. `#include <gba.h>`,
  `REG_DISPCNT`, `MODE3_FB`, `SPRITE_GFX`, `OAM`, `KEY_A`, etc. Opt in
  with `runtime: "libgba"` (or legacy `libgba: true`).
- **`"none"`** — bare gcc + newlib only. For people writing their own
  abstractions or porting bare-metal code.

Sound — both runtimes ship `gba_sfx.h` / `gba_sfx.c` (3 functions:
`sfx_init` / `sfx_tone(channel, freq_period, length)` / `sfx_noise`)
wrapping the DMG-compatible APU. Channels 3 (wave) + Direct Sound are
left to user code (they need more setup than a one-call sfx helper).

## CPU memory map (ARM7TDMI)

```
$00000000-$00003FFF  BIOS ROM (16 KB) — read-only firmware
$02000000-$0203FFFF  EWRAM (256 KB) — slow but big main work RAM
$03000000-$03007FFF  IWRAM (32 KB) — fast on-chip RAM
$04000000-$040003FE  I/O registers (memory-mapped MMIO)
$05000000-$050003FF  BG palette + OBJ palette (1 KB)
$06000000-$06017FFF  VRAM (96 KB) — BG tile data, sprite tile data, framebuffer
$07000000-$070003FF  OAM (1 KB) — sprite attributes
$08000000-$09FFFFFF  Game Pak ROM (up to 32 MB) — your .gba lives here
$0E000000-$0E00FFFF  Game Pak SRAM (64 KB) — battery-backed saves
```

The ARM7TDMI runs in two modes:
- **ARM**: 32-bit instructions, 4 bytes each. Faster on the GBA's
  32-bit IWRAM. Slower on 16-bit-wide ROM.
- **Thumb**: 16-bit instructions, 2 bytes each. Significantly smaller
  code. About the same speed as ARM on ROM (because ROM is 16-bit).
  **Most GBA games default to Thumb** because ROM is the common case.

`-mthumb` switches gcc into Thumb mode. `-mthumb-interwork` allows
mixing ARM + Thumb in the same binary. libgba is built Thumb-interwork.

## Display

```
240×160 pixels visible, 6 BG modes (0-5)

Mode 0: 4 tile BGs, scrolling. The classic 2D platformer mode.
Mode 1: 2 tile BGs + 1 affine BG (rotation/scale).
Mode 2: 2 affine BGs only. Mode 7-style perspective.
Mode 3: 240×160 BGR555 framebuffer at $06000000. 16-bit per pixel.
Mode 4: 240×160 palettized 8bpp framebuffer + a back buffer. Faster.
Mode 5: 160×128 BGR555 framebuffer + back buffer.
```

Most published GBA games use mode 0. The `MODE_3` path (used in our
`gba_hello` template) is the simplest — write directly to the
framebuffer like a modern game.

## Sprites (OAM)

128 sprite slots at $07000000. Each entry is 8 bytes:

```
attr0 (16 bits): Y position (8), affine flag, double-size, shape,
                 256-color flag, mosaic, etc.
attr1 (16 bits): X position (9), affine index OR hflip+vflip, size
attr2 (16 bits): tile index (10), priority (2), palette (4)
filler (16 bits)
```

Sprite tile data lives at $06010000-$06017FFF (32 KB = 1024 4bpp tiles
or 512 8bpp tiles). Sprite palette at $05000200-$050003FF.

libgba helpers: `SPRITE_GFX`, `OAM`, `SPRITE_PALETTE`. Compose attr
fields via `OBJ_*` constants in `gba_sprites.h`.

## Tile + map

Mode 0 BG: each BG layer has a 32-tile-wide map at a configurable VRAM
base (`REG_BGxCNT` selects). Tiles are 8x8 4bpp (or 8x8 8bpp); a map
entry is 16 bits = 10-bit tile index + 4-bit palette + 2 flip bits.

## Input

```
REG_KEYINPUT (read-only): bits ACTIVE-LOW (0 = pressed)
  bit 0: A    bit 1: B     bit 2: Select  bit 3: Start
  bit 4: R   bit 5: L      bit 6: U       bit 7: D
  bit 8: R-shoulder         bit 9: L-shoulder
```

libgba wraps this: `KEY_A`, `KEY_B`, etc. masks; `REG_KEYS` returns
the inverted byte so pressed = 1.

### Driving input over MCP

mGBA maps `input({op:'set'})` button names **straight through** — verified live, no
inversion: `{a}`→A, `{b}`→B, `{l}`→L, `{r}`→R, `{start}`/`{select}`, plus the
d-pad. So `input({op:'set', a: true})` presses GBA A as expected — unlike the
genesis_plus_gx platforms (Genesis/SMS/GG), there's no surprise here.

## Sound

Two parallel paths:

1. **Tone channels** (4): identical to GBC — 2 squares + 1 wave + 1 noise.
   Backwards-compatible with GBC games. Programmed via $04000060 +.
2. **Direct Sound** (2): 8-bit PCM channels with DMA streaming. The
   modern path for sample-based music. Programmed via $04000082 + DMA.

libgba sound API in `gba_sound.h` covers the tone channels but the
DMA-driven PCM streaming is something you'd typically pair with
maxmod (separate library, not bundled here).

**Debugging sound:** `audioDebug({op:'inspect', chip:"gba"})` decodes the live APU —
per-channel freq→note/duty/volume for the 4 tone channels plus the 2 Direct
Sound FIFO states. See "MCP debug & inspection tooling" below for the rest of
the live-debug loop (sprites / palette / background / cpu / breakpoint + the
memory regions and disasm pipeline).

**For starter-level sfx**, the libtonc runtime ships a minimal
`gba_sfx.h` / `gba_sfx.c` pair (3 functions: `sfx_init`, `sfx_tone`,
`sfx_noise`) that wraps the DMG-compatible APU directly. Same shape
as the NES/GB example sound API, so cross-platform game ports feel
the same. All 5 GBA genre example games (shmup/platformer/puzzle/sports/
racing) use it.

## MCP debug & inspection tooling

GBA runs on mGBA (patched). These inspectors read the *live* core state —
reach for them when a sprite, palette, or BG renders wrong and the source
alone doesn't explain it. (The audio inspector is also summarized under
"Sound" above.)

- **`sprites({op:'inspect'})`** — decodes all **128 OAM sprites** into a
  generic shape: attr0/1/2 unpacked to shape + size, **9-bit signed X**,
  the affine and hidden flags, and tile / palette / priority.
- **`palette({source:'live'})`** — reads the palette as **15-bit BGR555**:
  256 BG entries + 256 OBJ entries. Pass `area:'bg'` or `area:'sprite'` to
  pick the half.
- **`cpu({op:'read'})`** — ARM7TDMI dump: the 16 general regs **r0-r15**,
  `cpsr` + `spsr`, the processor mode, the ARM/THUMB state bit, and an
  **`execPc`** field that is r15 adjusted back for the pipeline prefetch
  (r15 reads ahead of the executing instruction, so raw r15 is misleading —
  use `execPc` for "where am I really").
- **`audioDebug({op:'inspect', chip:'gba'})`** — the 4 DMG-compatible PSG
  channels (per-channel freq→note / duty / volume) plus the **2 Direct Sound
  DMA FIFO** states, and master / bias. See "Sound" above.
- **`background({view:'renderState'})`** — decodes DISPCNT: the BG mode, and
  per-BG enable / priority / char-base / map-base / color-mode, the
  forced-blank bit, and OBJ enable. Use it to confirm REG_DISPCNT and the
  REG_BGxCNT bases match where you uploaded tiles + maps.

### Memory regions (`memory({op:'read', region:…})`)

| Region          | Address / size                     | Contents                                  |
|-----------------|------------------------------------|-------------------------------------------|
| `gba_cpu_regs`  | —                                  | ARM7TDMI register snapshot                 |
| `gba_io_regs`   | $04000000-$040003FE (1 KB)         | the I/O page — **video AND audio** MMIO    |
| `gba_palette`   | $05000000-$050003FF (1 KB)         | 256 BG + 256 OBJ BGR555 entries            |
| `gba_oam`       | $07000000-$070003FF (1 KB)         | 128 sprite attribute entries (8 B each)    |
| `system_ram`    | $02000000-$0203FFFF (256 KB)       | **EWRAM only** — the big/slow work RAM     |
| `gba_iwram`     | $03000000-$03007FFF (32 KB)        | **IWRAM** — the C stack + libtonc/maxmod `.bss` live HERE, not in EWRAM |
| `video_ram`     | $06000000-$06017FFF (96 KB)        | BG + sprite tile data + framebuffer        |
| `save_ram`      | $0E000000-$0E00FFFF (64 KB)        | battery-backed SRAM                        |

**IWRAM vs EWRAM — the debugging footgun:** a `$0300xxxx` address (SP, maxmod's
`mmLayerMain`, most C globals on this toolchain) lives in `gba_iwram`, NOT
`system_ram`. Reading `system_ram` at that low 16-bit offset returns EWRAM bytes —
real memory, wrong RAM — which "confirms" false hypotheses. Map the address by its
prefix first: `$02xxxxxx` → `system_ram`, `$03xxxxxx` → `gba_iwram`.

Pair `sprites` / `palette` / `background` / `cpu` with
`breakpoint({on:'write'})` for the full live-debug loop.

### Disassembly (`disasm({target:…})`)

`disasm({target:'rom'})`, `disasm({target:'references'})`, and
`disasm({target:'project'})` run the native binutils
**`arm-none-eabi-objdump`** (WASM) — **ARM mode by default**, pass
`thumb:true` for Thumb code. To rebuild, **`build({output:'reassemble',
platform:'gba', path})` turns the project dir back into a byte-identical ROM in
one call** — it assembles each region through `arm-none-eabi-as`/`ld`/`objcopy` and
splices the results into the original's header/pad (you don't run them yourself).

**Gotcha (until ARM/Thumb mode-tracking lands):** GBA C compiles mostly to
**Thumb** reached via an **ARM crt0 stub**, so an ARM-mode disasm of a full
ROM decodes the Thumb spans as `.byte` — still byte-exact, just less readable.
Disasm the Thumb spans with `thumb:true` to get real mnemonics.

## Frame heartbeat

```c
/* libtonc setup — REQUIRED before any VBlankIntrWait() call. */
irq_init(NULL);
irq_add(II_VBLANK, NULL);

while (1) {
    VBlankIntrWait();    /* halts CPU until vblank IRQ fires */
    /* update game state */
    /* write to OAM / VRAM */
}
```

`VBlankIntrWait()` calls a BIOS function that puts the CPU to sleep
until the vblank IRQ fires. **You MUST install the IRQ table BEFORE
the first call** (`irq_init(NULL)` + `irq_add(II_VBLANK, NULL)` with
libtonc — `irqInit(NULL)` + `irqEnable(IRQ_VBLANK)` with libgba).
Without this, the BIOS halts the CPU forever waiting for an IRQ that
never fires. ROM appears to compile + load but freezes on frame 1 —
single most common GBA gotcha. Every bundled example does it; copy
the pattern.

## Cart header format

```
$00-$03  ARM 'b' instruction branching to your _start
$04-$9F  Nintendo logo (156 bytes) — required for real-hardware boot
$A0-$AB  Game title (12 ASCII chars)
$AC-$AF  Game code
$B0-$B1  Maker code
$B2-$BB  Header bytes (unit code, device type, version, complement check)
$BC-$BF  Reserved
```

mGBA does NOT enforce the Nintendo logo (which is good — bundling it
would be a copyright issue). The `gba_crt0.s` we ship leaves it as
zeros. Real-hardware ROMs need it; mGBA and our test pipeline run
fine without it.

## Build pipeline

When you call `build({output:'rom', platform:"gba", language:"c"})`:

1. `cc1-arm` (gcc 14.2.0 C frontend, WASM) compiles your `.c` → `.s`
   ARM assembly (Thumb-interwork mode, `-mcpu=arm7tdmi`).
2. `arm-none-eabi-as` (binutils, WASM) assembles each `.s` → `.o`.
3. `arm-none-eabi-ld` (binutils, WASM) links user `.o` + bundled
   `gba_crt0.o` + `crti.o` + `crtbegin.o` + a tiny `fake_heap_end`
   stub + `libgba.a` + `libgcc.a` + `libc.a` + `libnosys.a` +
   `crtend.o` + `crtn.o` per `gba_cart.ld` → ELF.
4. `arm-none-eabi-objcopy` (binutils, WASM) extracts the raw `.gba`
   ROM from the ELF.

Loadable via mGBA (`loadMedia`).

## What's NOT bundled

- **`agbcc` (the legacy GBA compiler).** romdev's GBA C path is **modern
  `arm-none-eabi-gcc` 14.2.0** only. The byte-exact decompilations + romhacks
  (pokeruby / pokeemerald / pokefirered, etc.) build with agbcc + a custom
  `ld_script.txt`, so romdev **cannot reproduce a matching retail ROM** for those.
  That's a hard limit, not a missing feature — see "romdev's build model" below.
- **libgba's `console.c`** (iprintf-style stdio output). Pulls in
  devkitPro's libsysbase header chain — not yet ported. See
  TROUBLESHOOTING.md for the trade-off rationale and workarounds.
- **maxmod** (sample-based music driver). Separate library; not
  bundled. Add manually if you need it.
- **devkitARM's `bin2s`** (binary → assembly converter for asset
  pipelines). Not bundled; ship binary assets as C arrays for now.

Everything else from a stock devkitARM install (homebrew-style) works.

## romdev's build model (read this before driving an existing project)

`build` is a **single-shot "compile these sources → one ROM" tool**, NOT an arbitrary
build-system backend. The toolchain binaries are **WASM, run only inside romdev's build
worker (virtual FS)** — they are **not host-callable** and **cannot back an external
project's `Makefile`** as `$(TOOLCHAIN)/bin`. (The `.mjs` wrappers under `node_modules`
export a worker factory, not a CLI `main` — invoking one directly exits 0 and writes
nothing.)

So for an **existing decomp/romhack** (agbcc-era or any project with its own Makefile):
build it **on the host** with its own toolchain, then point romdev at the resulting
`.gba` for the run / inspect / debug / decompile loop. Confirmed host recipe for the
Pokémon Gen-III decomps: `brew install arm-none-eabi-gcc arm-none-eabi-binutils`, clone
`pret/agbcc` → `./build.sh` → `./install.sh <repo>`, then `make <target>` (yields a
byte-matching ROM). romdev's value here is everything AFTER the build, not the build.

## Horizontal scrolling (for side-scrollers)

GBA tiled BG modes (0-2) give each BG layer a hardware scroll register —
`REG_BG0HOFS` / `REG_BG0VOFS` (and BG1/2/3). Write the camera offset each
frame; scroll a second layer at a fraction of camX for parallax. BG maps are
32×32 (or larger via screen-block size); for a wider world, stream the column
entering view into the map's screen-blocks as the camera advances. A fixed HUD
goes on its own BG layer left unscrolled (or via an HBlank IRQ that resets the
offset for the HUD scanlines). Track camX in pixels; actor screen-X = worldX -
camX.

## Reverse-engineering & decompilation

The Rizin/Ghidra analysis engine works here like everywhere: `disasm({target:'functions'})` to carve the program, `disasm({target:'cfg'|'xrefs'})` to trace it, `symbols({op:'analyze'})` for a one-shot structural map.

**Decompiler quality on ARM7TDMI: EXCELLENT.** Most GBA code was compiled C, so the decompiler often recovers something close to the original source — lean on it. `disasm({target:'decompile', address})` returns C-like pseudocode (the `qualityNote` field restates this). Read it to UNDERSTAND a routine; use `disasm({target:'project'})` to actually edit + rebuild. See the cross-platform ROM-hacking playbook §5f for the full loop.
