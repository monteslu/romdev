# Genesis / Mega Drive — quickstart

The compressed version of "everything I had to learn the hard way
building a Genesis ROM with romdev."

## Snippets shipped in this directory

| File | Purpose |
|---|---|
| `header.s` | 256-byte ROM header + interrupt vector table. **Required** for every Genesis ROM — without it the cart is unbootable. |
| `vdp_init.s` | Standard 320×224 VDP register init (plane bases, scroll, sprite table, etc.) — call from `_reset`. |
| `wram.s` | How to declare WRAM variables WITHOUT exploding your ROM size to 16 MB. |
| `pad_read.s` | 3-button controller read with edge detection (held / pressed / released). |
| `vblank_wait.s` | Busy-wait pattern for syncing to VBlank without interrupts. |
| `nmi_safe.s` | Full VINT (vblank interrupt) handler with register preservation. |
| `sprite_table.s` | Soft-OAM staging + DMA upload pattern. |
| `z80_bootstrap.s` | Z80 sound CPU bring-up + bus protocol. |

Fetch any with `getStarterSnippet({platform:"genesis", name:"<file>"})`.
Pull them all at once with `getAllStarterSnippets({platform:"genesis"})`.

## The five gotchas that cost the most time

### 1. vasm Motorola syntax: NO SPACES after commas

```asm
move.w #$2700, sr       ; ERROR: "number or identifier expected"
move.w #$2700,sr        ; OK
```

vasm's Motorola syntax tokenizer treats the space as terminating the
operand. This applies to ALL multi-operand instructions: `move`, `add`,
`movem`, `lea`, etc. The starter snippets in this directory are all
no-space; don't add spaces when editing them even if your editor
auto-formats.

### 2. WRAM variables: use `equ`, not `org`

```asm
org $00FF0000           ; BAD: pads ROM to 16 MB
my_var:  dc.l 0         ;      and the var is not actually stored there

my_var equ $00FF0000    ; GOOD: pure compile-time constant
                        ;       CPU writes here at runtime; no ROM space used
```

The "your ROM is 16 MB and will not fit on a cart" surprise is one of
the top three Genesis-newbie mistakes. See `wram.s` for the full pattern.

### 3. Header byte counts: notes field is 32 bytes, NOT 40

Several online references claim the "notes" field at $1D0 is 40 bytes.
It is 32. ($1D0-$1EF, with region at $1F0-$1FF.) If you size it as
40, region overlaps your code section at $200 and vasm yells
"sections must not overlap." `header.s` has the authoritative layout
in a prominent comment at the top.

### 4. VDP control reads: bit 3 of LOW byte, address $C00005

The VDP status register is a 16-bit big-endian word at $C00004. The
"vblank in progress" flag is bit 3 of the LOW byte — accessed at
$C00005, not $C00004. Lots of old Genesis tutorials test the wrong
address and busy-wait forever. `vblank_wait.s` gets this right.

### 5. m68k can't do memory-to-memory arithmetic

```asm
add.w lines_counter, total_lines    ; ERROR: "instruction not supported"
                                    ; m68k arithmetic needs a register
move.w lines_counter, d0
add.w d0, total_lines               ; OK
```

The 68000's instruction set requires at least one operand of most
arithmetic ops to be a register (D0-D7 or A0-A7). Coming from cc65 or
asar (where memory-to-memory is sometimes legal) this catches you.
The "instruction not supported on selected architecture" error from
vasm is technically correct but cryptic — it means "this addressing-
mode combination is invalid for the 68000," not "your CPU is too old."

## Build + iterate workflow

The fastest loop (works for most Genesis dev):

```js
runSource({
  platform: "genesis",
  source: /* your .s contents */,
  frames: 60,                    // step 60 frames after load
  holdInputs: [{ start: true }], // optional: hold a button
})
```

Returns build status + final screenshot in one call (~500 ms cold,
faster after the core is warm).

For multi-file projects use the `sources` map:

```js
runSource({
  platform: "genesis",
  sources: { "main.s": mainText, "music.s": musicText },
  frames: 60,
})
```

For projects with binary assets (tiles, palettes, music data):

```js
buildSource({
  platform: "genesis",
  sourcePath: "/abs/path/main.s",
  binaryIncludePaths: {
    "tiles.bin":   "/abs/path/assets/tiles.bin",
    "palette.bin": "/abs/path/assets/palette.bin",
  },
  outputPath: "out.gen",
})
```

Source can then `incbin "tiles.bin"` directly.

## Debugging tools available

Genesis has full debugging parity with SNES — see `catalog({op:'categories'})`
then `loadCategory({category:"debug"})`:

| Tool | What it gives you |
|---|---|
| `sprites({op:'inspect', platform:"genesis"})` | 80-sprite linked-list decoded to {slot, x, y, tile, palette, priority, flipH, flipV, size, visible} |
| `palette({source:'live', platform:"genesis"})` | All 64 CRAM colors decoded to {r, g, b} + a PNG swatch sheet |
| `cpu({op:'read', platform:"genesis", cpu:"main"})` | 68K state: D0-D7, A0-A7, PC, flags NZVCXST, intMask |
| `audioDebug({op:'inspect', chip:'psg'})` | PSG channels: 3 tone + 1 noise |
| `audioDebug({op:'inspect', chip:'ym2612'})` | YM2612 raw snapshot (decoder is limited; raw blob diff-able) |
| `memory({op:'read', region:"genesis_cram"})` | 128 B CRAM raw |
| `memory({op:'read', region:"genesis_vdp_regs"})` | 32 VDP registers |
| `memory({op:'read', region:"genesis_z80_ram"})` | 8 KB Z80 sound CPU RAM |
| `state({op:'dump', path})` | Full savestate blob for forensic inspection |

Pair `screenshot({overlayBoxes:true})` with `sprites({op:'inspect'})` for
"is the GPU rendering sprites where I think they are" visual debugging.

## ROM file extension

Default convention in this MCP: `.gen`. Genesis frontends
(Batocera, ES-DE, RetroBat, RetroPie, ROCKNIX) all accept `.gen`,
`.md`, `.bin`, `.smd`. `.gen` is unambiguous in 2026: `.md` collides
with markdown, `.bin` is generic, `.smd` implies a header format
we do not emit.

## Open question: live Z80 driver state

The YM2612 + Z80 sound CPU state is not currently as deeply
introspectable as the SNES SPC700 + DSP — YM2612 in particular
requires walking gpgx's internal struct which is version-fragile.
If you hit a sound-debugging wall here, open an issue at
https://github.com/monteslu/romdev/issues.
