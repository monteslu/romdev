# Game Boy / Game Boy Color — mental model

One page. Read once before you write your first game. The
TROUBLESHOOTING.md alongside this file is for when something's broken;
this is the "what's going on" version.

## Blank screen? Verify rendering first (no vision needed)

Compiles clean but nothing on screen? Call **`frame({op:'verify', frames:60})`** —
one call fuses a framebuffer pixel scan with the live LCDC and returns
`{verified:true|false|null, issues[]}`. `renderDisabled` = LCD off (LCDC.7 clear);
`blankScreen`/`nearlyBlank` with LCD on = nothing in the BG map / OAM / palette
(check the footguns below + read `memory({op:'read', region:'gb_vram'})`);
`verified:null` = step a frame first. Zero image tokens, frame-0-guarded — use it
as the first move when a change "did nothing."

## Toolchains

Default is **C** via SDCC's sm83 port (the same SDCC that powers SMS/GG/MSX/
Coleco). For hand-tuned asm, pass `language:"asm"` to route through RGBDS. The C
path uses `__sfr __at 0xFFNN` to bind GB I/O regs; the helper headers under
`src/platforms/gb/lib/c/gb_hardware.h` define LCDC/STAT/SCY/SCX/LY/BGP/OBP0/OBP1/
etc. for both DMG and CGB. ⚠ SDCC 4.4.0 codegen quirk: `for (;;) { switch + write
to __sfr }` crashes the register allocator — use `do { ... } while (1)` and
table-lookup writes instead. (See the GB/GBC SDCC_GOTCHAS for the full set of
sm83 codegen footguns.)

## MCP debug & inspection tooling

The bundled gambatte core is patched to expose deep live state — sprites,
palettes, tiles, background/LCDC, CPU, and raw memory regions. This applies to
**both `gb` and `gbc`** builds (one shared gambatte core).

**Live inspectors (decode hardware state, no manual byte-twiddling):**

- **`sprites({op:'inspect'})`** — decodes all 40 OAM slots and renders a
  sprite-sheet PNG with sprite-priority + horizontal/vertical flip applied.
- **`palette({source:'live'})`** — DMG path decodes the BGP / OBP0 / OBP1 bytes
  into 4 shades each; CGB path decodes the 64-byte BCPS/OCPS palette RAM into
  8 palettes × 4 colors in BGR555.
- **`tiles({op:'png'})`** — renders all 384 tiles from $8000-$97FF.
- **`cpu({op:'read'})`** — SM83 register file: A/F/BC/DE/HL + flags + IME/halt.
- **`audioDebug({op:'inspect', chip:'gb'})`** — DMG APU decode: 2 pulse + wave
  + noise channels, with timer→freq→note conversion, sweep, duty, and panning,
  read straight from the live `NR*` registers.
- **`background({view:'renderState'})`** — LCDC bit-by-bit, scroll (SCX/SCY),
  LY/LYC, window state, plus CGB extras: current VRAM bank, KEY1, and the
  BCPS/OCPS palette index.

**Raw memory regions** via `memory({op:'read', region:...})`:

| Region | Contents |
|---|---|
| `gb_vram` | VRAM ($8000-$9FFF) — tile data + BG maps (CGB: the active bank) |
| `gb_oam` | OAM ($FE00-$FE9F) — 40 sprites × 4 bytes |
| `gb_io` | I/O register page ($FF00-$FF7F) — LCDC, BGP, JOYP, CGB regs, etc. |
| `gb_hram` | HRAM ($FF80-$FFFE) — fast scratch |
| `gb_bgpdata` | CGB BG palette RAM (64 bytes) |
| `gb_objpdata` | CGB OBJ palette RAM (64 bytes) |
| `gb_cpu_regs` | SM83 register snapshot |

⚠ **Gotcha: gambatte exposes `gb_vram`, NOT the generic `video_ram` region.**
Other platforms' cores expose video memory under `video_ram`; on GB/GBC you must
ask for `gb_vram` (and the other `gb_*` names above). A `video_ram` read here
returns nothing.

**Disassembly:** `disasm({target:'rom'})` + `disasm({target:'references'})` +
`disasm({target:'project'})` route through the native binutils z80 `objdump` in
its `gbz80` machine (WASM, `-m gbz80`) — full CB-prefix coverage plus the
SM83-specific opcodes (`ld (hl+),a`, `ldh`, `reti`, `ld hl,sp+e8`). One z80-elf
binutils serves both plain Z80 (SMS/GG/MSX) and the GB CPU.

## Five silent-failure footguns to know before you start (R26 + R27)

If your ROM compiles cleanly but doesn't render — or sprites land in
the wrong place, or VRAM stays empty, or "everything works for the
no-input case but corrupts within ~100 frames when you press a button" —
check these first. All five have shipped fixes in the bundled runtime
+ tools, but a custom build that bypasses them hits exactly the same wall.

1. **Cartridge header must be FULLY patched, not just logo + checksums.**
   `build({output:'rom'})` / `build({output:'run'})` do this for you at build time (they run
   rgbfix on the linked ROM): valid Nintendo logo, header + global
   checksums, cart type / ROM-RAM size, and the CGB flag at $0143 — set
   to $00 for `.gb` and $80/$C0 for `.gbc`. Getting $0143 wrong is the
   classic white-screen: a stray $FF pad there trips CGB mode on a DMG
   ROM so BGP/OBP* writes are ignored. Because the build sets it from the
   platform you chose, a freshly built ROM is correct with **no manual
   step**. Call `romPatch({op:'gbHeader'})` only to fix up an existing/external ROM
   or override a field (title, cart type, ROM/RAM size, CGB flag).

2. **OAM shadow buffer must be page-aligned.** OAM DMA copies 160 bytes
   from `$XX00` — it reads ONLY the high byte of your source address.
   The bundled `shadow_oam` in `gb_runtime.c` is pinned at $C100 with
   `__at (0xC100)`; if you roll your own buffer, pick an address with
   `0x00` in the low byte (e.g. $C200, $C300) and pass it directly to
   `oam_dma_copy`. A plain `uint8_t my_oam[160]` may land at $C017 or
   wherever the linker picks → DMA reads from $C000 → garbage in OAM.

3. **Raw VRAM stores can be optimized away.** SDCC sm83 treats
   `*((uint8_t*)0x8000) = x;` as dead code if the optimizer can't see
   side effects. Use `memcpy_vram(dst, src, n)` from `gb_runtime.h`
   (volatile-safe by construction) or cast through `volatile uint8_t *`.
   See `gb_runtime/lib/c/SDCC_GOTCHAS.md` § "Writes to VRAM" for detail.

3b. **OAM DMA goes FIRST after `wait_vblank()` — before any staging work.**
   The vblank window is ~10 scanlines (~1140 cycles) and SDCC call overhead
   is brutal: even a few dozen `oam_set()` CALLS before the flush push the
   DMA out of vblank into active display, where it tears the sprites on one
   FIXED scanline every frame (the "horizontal line a third of the way down"
   glitch). The robust frame shape is: stage OAM/BG writes into RAM any time
   during the frame, then `wait_vblank(); oam_dma_flush();` as the very first
   thing, then a small bounded batch of BG map writes. One frame of sprite
   latency is imperceptible. Also: statics belong at `dataLoc 0xC200` or
   above (the project recipe sets this) so they can't collide with
   `shadow_oam` at $C100.

4. **OAM DMA must run from HRAM.** During the ~160 µs OAM DMA window
   the CPU can ONLY fetch from HRAM ($FF80-$FFFE). The bundled
   `oam_dma_copy()` now installs a 9-byte stub at $FF80 and CALLs it;
   the stub spins from HRAM where DMA can't conflict. Pre-r55 the spin
   ran from ROM and fetched $FF for every instruction (the bus-conflict
   default), which decodes as `rst $38` → stack corruption →
   intermittent LCDC = $FF, BG VRAM wiped, sprites jump. Symptom
   classically appeared as "works clean for 3000 frames with no input,
   corrupts within 100 frames once a button is held" because the
   gameplay code path's length / branches changed, shifting which DMAs
   ran during which fetches. **The fix is in `lcd_init_default()` —
   it auto-installs the stub.** Roll your own OAM DMA only if you
   call `oam_dma_init_hram()` yourself first.

5. **`gb_crt0.s` zeros BSS correctly.** Pre-r55's gsinit had a typo:
   it zeroed `_INITIALIZED` (the runtime shadow of init-value data,
   which gets overwritten anyway) instead of `_DATA` (the actual BSS
   where uninitialized `static` globals land). Result: every
   `static uint8_t counter;` started with whatever WRAM garbage was
   there at boot — spurious "active" flags on game objects, etc. The
   fixed crt0 zeros `_DATA` from `s__DATA` for `l__DATA` bytes, then
   does the `_INITIALIZER → _INITIALIZED` copy for init-value statics.
   If you use the bundled `gb_crt0.s` you're good; if you bring your
   own, make sure gsinit zeros `_DATA`.

6. **Don't poke a hardcoded `$C0xx` WRAM pointer for game state — it
   overlaps your statics.** SDCC links the C runtime's data + BSS (every
   `static` global: your PRNG seed, your grids, your scores) at the BOTTOM
   of WRAM starting `$C000`. A `volatile uint8_t *board = (uint8_t*)0xC000;`
   then scribbles right over `static uint32_t rng = ...;` et al. Symptom
   looks exactly like an SDCC *codegen* bug — e.g. a 32-bit xorshift PRNG
   that "degenerates" so every roll is identical (it's not miscompiling;
   its seed is being clobbered). **Use a `static` array and let the linker
   place it** (`static uint8_t board[78]; board[i]=p;`), or, if you must
   hardcode, put scratch at `$C200`+ and confirm with the linker map
   (`build({includeSymbols:true})` → check `s__DATA`/`s__BSS`; your scratch
   must start above the end of `_BSS`). Full write-up + the
   "is-it-really-a-miscompile" repro in
   `lib/c/SDCC_GOTCHAS.md` § "sm83 codegen traps in plain game logic".

## Memory map you actually care about

```
$0000-$014F  ROM cart header + reset vectors (crt0 territory)
$0150-$7FFF  ROM code ($0150 is where init: lives — `_CODE` starts here)
$8000-$97FF  VRAM tile data — 384 tiles × 16 bytes (CGB: dual-banked, 768 total)
$9800-$9FFF  VRAM BG maps + CGB attribute map (in bank 1)
$A000-$BFFF  Cart RAM (mappers only; not present in 32 KB ROM-only carts)
$C000-$DFFF  WRAM (8 KB) — your variables, your stack
             ⚠ statics start at $C000 (rng/grids/scores live here): NEVER
               hardcode a $C0xx pointer for game state — use a `static`
               array; for fixed scratch use $C200+ (see footgun #6).
$FE00-$FE9F  OAM (40 sprites × 4 bytes) — written via DMA
$FF00       JOYP — joypad I/O
$FF40-$FF4B I/O registers — LCDC, BGP, OBP0, OBP1, SCY, SCX, etc.
$FF4D-$FF7F CGB-only registers — VBK, BCPS, BCPD, OCPS, OCPD, HDMA*, KEY1
$FF80-$FFFE HRAM (127 bytes) — fast scratch, only place safe during DMA
```

## VRAM banks (CGB)

DMG has one VRAM bank ($8000-$9FFF, 8 KB). CGB has **two**, switched
via `VBK` ($FF4F).

- **Bank 0:** tile data + BG tile map (default; what DMG sees)
- **Bank 1:** BG attribute map (CGB-only — palette index + flip flags
  per tile cell)

To write a CGB BG attribute, set `VBK = 1`, write to $9800-$9FFF, then
set `VBK = 0` so subsequent writes go back to bank 0.

## Palettes

DMG and CGB are **completely different palette systems**. On a CGB
running a CGB-aware ROM, the DMG registers are ignored.

**DMG:**
- `BGP` ($FF47) — 1 byte, 4 colors × 2 bits = 4 grey shades.
- `OBP0` ($FF48), `OBP1` ($FF49) — same shape, for sprites.

**CGB (always for any `platform: "gbc"` build):**
- Palette RAM is 64 bytes BG + 64 bytes OBJ — 8 palettes × 4 colors × 2 bytes (BGR555).
- Written via the "auto-increment register pair" pattern:
  ```c
  BCPS = 0x80;   /* index 0, auto-advance, BG */
  BCPD = lo; BCPD = hi;  /* color 0 of palette 0 */
  BCPD = lo; BCPD = hi;  /* color 1 of palette 0 */
  /* ... 32 BCPD writes total for all 8 BG palettes */
  ```
- `0x80` = bit 7 (auto-inc) + index 0. Without bit 7 set, every write
  to BCPD overwrites the same byte.
- `OCPS`/`OCPD` ($FF6A/$FF6B) are the same for sprites.

## CGB header byte

`$0143` controls CGB mode:
- `0x00` = DMG-only — CGB ignores all the CGB registers
- `0x80` = CGB-aware, DMG-compatible (recommended default)
- `0xC0` = CGB-only (won't boot on DMG)

You normally don't touch this byte by hand: `build({output:'rom'})` / `build({output:'run'})`
set it from the platform you build for ($00 for `platform:"gb"`, $80/$C0
for `platform:"gbc"`). To force a value, set it in your `gb_crt0.s`
header section, or call `romPatch({op:'gbHeader', path, cgb:true})` on the built
ROM (it auto-detects the `.gbc` extension; the standalone
`patch-header.js` script does the same).

## Sprite hardware quirks

- OAM has 40 slots (160 bytes at $FE00-$FE9F). Each slot is
  `{ Y, X, tile, attr }`.
- **Y position is hardware-offset by 16.** Y=0 hides the sprite
  off-screen; Y=16 is the top edge of the LCD.
- **X position is hardware-offset by 8.** X=0 hides; X=8 is the left edge.
- The hardware refreshes OAM from RAM every line; writing OAM mid-frame
  glitches. **Always write OAM via DMA during vblank.**
- `LCDC.1` (= 0x02) must be set to render sprites at all.
- Per-line sprite limit is **10**. The hardware drops the 11th+ on
  each scanline. Tall games use careful Y-staggering.

## OAM DMA

You don't write to $FE00 directly. You write to `DMA` ($FF46) — the
high byte of a source address. The hardware copies 160 bytes from
`source*0x100` to OAM. Takes 160 µs (~640 cycles). During the copy,
**only HRAM ($FF80-$FFFE) is accessible**. The conventional trick is
to call a tiny HRAM stub that sets DMA and spins until done; the
`gb_runtime` `oam_dma_copy()` uses a simpler "spin in WRAM" version
that works in vblank (you should only call it in vblank anyway).

## Vblank timing

- LCD is 154 scanlines tall (visible 0-143, vblank 144-153).
- `LY` ($FF44) reads current scanline.
- **When the LCD is off, LY is frozen at 0.** A blind `while (LY <
  144)` deadlocks. `wait_vblank()` in the runtime checks `LCDC.7`
  first and bails if LCD is off. Don't replace it with a hand-rolled
  loop unless you know what you're doing.

## Joypad

`JOYP` ($FF00) is a multiplexed register. You write 0x10 or 0x20 to
select which row (buttons or d-pad), then read the 4-bit result with
each bit **active-low** (0 = pressed). `joypad_read()` does the
multiplex + inversion + packing into one byte.

Packed byte layout:
- bits 7-4: d-pad (Down, Up, Left, Right)
- bits 3-0: buttons (Start, Select, B, A)

PAD_* masks in `gb_runtime.h` match this layout. Counter-intuitive
because d-pad is in the HIGH nybble, but that's the layout that fell
out of "row select bit determines nybble".

### Driving input over MCP

gambatte maps `input({op:'set'})` button names **straight through** — verified live, no
inversion: `{a}`→A, `{b}`→B, `{start}`/`{select}`, plus the d-pad. The spatial
names also resolve (east→A, west→B). So `input({op:'set', a: true})` presses GB A as
expected — unlike the genesis_plus_gx platforms (Genesis/SMS/GG), there's no
surprise here. (Same for **GBC** — it shares the gambatte core.)

## What `scaffold({op:'project'})` copies into your project

`scaffold({op:'project', platform:"gb"|"gbc", template:...})` writes these files
into your project directory. **They're yours** — every byte that compiles
is in the repo. Edit, fork, replace; nothing is auto-injected at build time.

| File | Provides |
|---|---|
| `main.c` | Your game's entry point (the template). |
| `gb_hardware.h` | All SFR names (LCDC, BGP, BCPS, JOYP, VBK, ...) + LCDC_* bit masks. |
| `gb_runtime.h` | Helper declarations + PAD_* masks + `shadow_oam[]`. |
| `gb_runtime.c` | Helper implementations. Linked as an extra TU. |
| `gb_crt0.s` | Custom crt0 that reserves $0100-$014F for the header window, puts `init:` at $0150. |
| `patch-header.js` | Standalone Node script that patches the Nintendo logo + header/global checksums on a ROM — for fixing up an externally built ROM outside MCP. The normal build does this for you. |
| `README.md` | Build invocation + "rebuild outside MCP" instructions. |

Build calls explicitly reference these files via `sourcesPaths` /
`includePaths` / `crt0Path` + `codeLoc: 0x150`. `build({output:'rom'})` /
`build({output:'run'})` then fix up the cart header automatically (logo, checksums,
CGB flag), so the ROM loads under gambatte with no extra step. Use
`romPatch({op:'gbHeader', path})` (romdev tool) or `node patch-header.js <rom>` (CLI)
only on a ROM the build pipeline didn't produce. See your project's
README for the exact incantation.

## What's NOT done for you

- Music — `sound_init()` + `sound_play_tone(channel, freq_period, length)`
  + `sound_play_noise(length)` + `sound_off()` cover the common
  "beep on event" SFX pattern using the GB APU's 4 channels (2 square,
  triangle/wave, noise). For sequenced multi-channel music, roll your own
  or use raw `NR*` register names from `gb_hardware.h`. To debug it,
  `audioDebug({op:'inspect', chip:"gb"})` decodes the live APU — per-channel
  freq→note/duty/volume/sweep, straight from the `NR*` registers.
- Window layer — `LCDC.5` + `WX`/`WY` registers, no helpers.
- MBC1/MBC3/MBC5 bank switching — every ROM bundled is 32 KB ROM-only.
  For bigger games, write your own bank-switch macros and pass them
  the right address.
- Save RAM — same; cart RAM ($A000-$BFFF) requires mapper-specific
  enable sequences. Not bundled.
- Interrupts beyond vblank/halt — the default IRQ vectors are all
  `reti`. To enable timer/serial/lcd-stat interrupts, you'll need to
  write a custom handler.

## When to break out of the runtime

The bundled `gb_runtime.c` is intentionally minimal. It's the right
choice for the first 80% of a game. When you hit one of these, you'll
need to drop down:

- **Cycle-accurate timing** (line-counter effects, raster split, etc.)
  — needs hand-tuned asm, not C.
- **Sound** — write raw register sequences from a music driver.
- **OAM DMA during raster** — needs the HRAM-stub trick mentioned above.
- **Multi-bank ROMs** — switch to `language: "asm"` and roll your own
  layout via RGBDS.

Most game patterns DON'T need any of this. Try the C path first.

## Horizontal scrolling (for side-scrollers)

The `platformer` scaffold is single-screen. To make it a side-scroller:

- **Hardware scroll:** write `SCX` (`$FF43`) each frame = camera X mod 256.
  The BG is a 32×32 tile map (256×256 px) that wraps, so `SCX` alone scrolls
  smoothly through one map's worth.
- **Streaming:** your world is wider than 256 px, so as the camera advances
  you must rewrite the BG-map **column** that is about to scroll into view.
  Track `camX`; each time `camX` crosses an 8-px boundary, write the next
  world column's 18 (or 20) tile IDs into the off-screen BG-map column at
  `(camX/8 + 20) & 31`. Do VRAM writes during vblank (or with the LCD off /
  via `memcpy_vram`).
- **Fixed HUD:** use the Window (`WX`/`WY`, LCDC bit 5) for a non-scrolling
  status bar — it draws over the BG and ignores SCX/SCY.
- **Vertical too?** `SCY` (`$FF42`) works the same; stream rows instead of
  columns.

Pattern: keep a `world_map[col][row]` array, a `camX` in pixels, convert
actor world-X → screen-X as `worldX - camX`, and only ever touch the one
column entering the screen per 8-px step.
