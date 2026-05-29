# SMS / Game Gear — quickstart

The compressed version of "everything I had to learn the hard way
building an SMS ROM with romdev."

## Language: C is the default

SDCC 4.4.0 + the bundled SMS-specific crt0 (`c/sms_crt0.s`) give you a
clean C development path. `buildSource({platform:"sms", source: <C>})`
auto-injects the crt0 so your `main()` runs as the cartridge reset
handler with a proper vector table + IM 1 + SP=$DFF0.

C-side hardware access uses SDCC's `__sfr __at <port>` declarations —
see `c/sms_hw.h` for the standard port set. Reading the variable
compiles to `in a,(port)`; writing compiles to `out (port),a`.

ASM is also first-class — pass a `.s` source and it routes through
sdasz80. The asm snippets below are the canonical implementations the
C helpers wrap.

### SDCC 4.4.0 quirks

SDCC sm83/z80 is **C89-only** — no inline `for (int i = 0; ...)`, no
mid-block declarations, no compound literals. The pre-flight linter
catches these with the right file:line before SDCC's own (misleading)
error messages get a chance to confuse you. See
[`../../gb/lib/c/SDCC_GOTCHAS.md`](../../gb/lib/c/SDCC_GOTCHAS.md).

The previously-documented "register-allocator crash family"
(`dbuf_append_str NULL` assertion on for-loops with function calls,
parallel array writes, multi-array indexed reads, etc.) was diagnosed
on 2026-05-25 as the emscripten 64 KB default stack overflowing past
`__data_end` and zeroing out the static `sm83_regs[]` table. Fixed by
bumping the WASM stack to 8 MB. Those patterns compile cleanly now —
no workarounds needed.

## Snippets shipped in this directory

| File | Purpose |
|---|---|
| `header.s` | The 16-byte TMR SEGA cartridge header at $7FF0. Required on real hardware; most emulators forgive its absence. |
| `vdp_init.s` | Mode 4, 192-line, display OFF baseline VDP setup. Call once after reset; then upload palette/tiles/map, then enable display. |
| `vblank_wait.s` | Two flavors: polling on `in a,($BF)` bit 7, and an IM 1 IRQ pattern with a WRAM flag. |
| `joypad_read.s` | Reads ports $DC + $DD, inverts so pressed=1, stores in `_p1_state`/`_p2_state`. Includes button masks. |
| `load_palette.s` | Bulk OTIR of 32 CRAM bytes (16 BG + 16 sprite) via the control-port $C0 prefix. |
| `load_tiles.s` | Bulk OTIR into VRAM at an arbitrary destination. Handles >256 byte transfers (loops on outer page count). |
| `sprite_table.s` | Uploads shadow OAM (256 bytes WRAM) → SAT VRAM region. Includes the (X,tile) pairs layout at $3F80. |

Fetch any with `getStarterSnippet({platform:"sms", name:"<file>"})`.
Pull them all at once with `getAllStarterSnippets({platform:"sms"})`.

## The five gotchas that cost the most time

### 1. VDP register writes need TWO out-of-order bytes

To write VDP register `R`, you send a 16-bit value to control port $BF
as two bytes:
- FIRST byte = the value
- SECOND byte = `$80 | R` (high bit signals "register write")

If you reverse them you'll set the VRAM address pointer instead — a
subtle bug that produces "the display works but later writes go to the
wrong place." Always: `out ($BF), value` then `out ($BF), $80 | reg`.

### 2. CRAM address-set prefix is $C0, VRAM is $40

The VDP control port distinguishes destinations via the high bits of
the second byte:
- `$40 | hi` → VRAM write
- `$00 | hi` → VRAM read
- `$80 | reg` → register write
- `$C0` → CRAM write (the LOW byte first must be the CRAM offset)

Mixing these is the most common cause of "I uploaded my palette but the
screen is still black" — you probably wrote to VRAM by accident.

### 3. SAT terminator $D0

If any Y byte in the sprite attribute table is $D0, the VDP stops
processing sprites at that index and renders only the ones before it.
Hide unused sprites with `Y = $D0`, not by setting them off-screen.
Setting `Y = $FF` won't terminate, just put the sprite somewhere
invisible — you waste a sprite slot.

### 4. SMS palette is 6-bit, not 8-bit

CRAM bytes are 2-2-2 BGR. So $3F is white (all channels max), $3 is
pure red, $C is pure green, $30 is pure blue. Don't pass 0xFFFFFF and
expect white — it'll truncate to $3F. Use `getPlatformPalettePng({platform:"sms"})`
to see all 64 distinct colors and dither input art against them with
imagemagick.

### 5. Game Gear CRAM is 4-4-4 (12-bit BGR), 2 bytes per entry

GG palettes are NOT swappable with SMS palettes. If you're writing
cross-target code, use a `#ifdef GG` / `#ifdef SMS` switch in your
asset pipeline. The image-to-tilemap tool dispatches on platform, but
hand-authored palette tables need the platform-correct encoding.

## VDP register reference (the 11 that matter)

| Reg | Purpose | Common value |
|---|---|---|
| R0 | Mode control 1 | $36 (M4 on, line IRQ off, mask col 0) |
| R1 | Mode control 2 | $E0 to enable display ($80 disables, bit 6 enables, bit 5 enables vblank IRQ) |
| R2 | Name table base | $FF → $3800 (formula: `(reg & 0x0E) << 10`) |
| R3 | Color table (M4 ignored) | $FF |
| R4 | BG tile data base | $FF → $0000 (bit 2 selects $0000 vs $2000) |
| R5 | Sprite attribute table | $7E → $3F00 (formula: `(reg & 0x7E) << 7`) |
| R6 | Sprite tile data base | $FB → $2000 (bit 2 selects $0000 vs $2000) |
| R7 | Border color | $00 = sprite palette entry 0 |
| R8 | BG X scroll | 0 = no scroll |
| R9 | BG Y scroll | 0 = no scroll |
| R10 | Line IRQ counter | $FF = disabled |

Decode the live values via `getRenderingContext({})` — it returns the
fully-shifted base addresses so you don't redo the math.
