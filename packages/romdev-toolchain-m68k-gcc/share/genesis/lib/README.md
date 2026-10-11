# Genesis / Mega Drive - quickstart

The short list of what matters most when building a Genesis ROM in assembly
with romdev.

## Snippets shipped in this directory

| File | Purpose |
|---|---|
| `header.s` | 256-byte ROM header + interrupt vector table. **Required** for every Genesis ROM - without it the cart is unbootable. |
| `vdp_init.s` | Standard 320×224 VDP register init (plane bases, scroll, sprite table, etc.) - call from `_reset`. |
| `wram.s` | How to declare WRAM variables WITHOUT exploding your ROM size to 16 MB. |
| `pad_read.s` | 3-button controller read with edge detection (held / pressed / released). |
| `vblank_wait.s` | Busy-wait pattern for syncing to VBlank without interrupts. |
| `nmi_safe.s` | Full VINT (vblank interrupt) handler with register preservation. |
| `sprite_table.s` | Soft-OAM staging + DMA upload pattern. |
| `z80_bootstrap.s` | Z80 sound CPU bring-up + bus protocol. |

Fetch one with
`examples({op:'snippets', platform:'genesis', mode:'get', snippetName:'<name>'})`,
list them with `mode:'list'`, or get them all at once with `mode:'getAll'`.
`examples({op:'copySnippets', platform:'genesis', destinationDir})` copies them
into a project.

## Five common mistakes

### 1. Motorola syntax: whitespace ends the operand field

```asm
move.w #$2700,sr        ; OK
move.w d0,d1 copy it    ; OK: everything after the operands is a comment
dc.w 1 + 2              ; assembles dc.w 1 - " + 2" is a comment
```

In Motorola syntax the operand field ends at the first space or tab, and the
rest of the line is a comment. A space right after a comma is skipped
(`move.w #$2700, sr` works), but a space anywhere else inside an operand or
expression cuts it short. Write expressions without spaces: `dc.w 1+2`.

### 2. WRAM variables: use `equ`, not `org`

```asm
org $00FF0000           ; BAD: pads ROM to 16 MB
my_var:  dc.l 0         ;      and the var is not actually stored there

my_var equ $00FF0000    ; GOOD: pure compile-time constant
                        ;       CPU writes here at runtime; no ROM space used
```

A ROM that comes out at 16 MB is the usual symptom. See `wram.s` for the full
pattern.

### 3. Header byte counts: notes field is 32 bytes, NOT 40

Several online references claim the "notes" field at $1D0 is 40 bytes.
It is 32. ($1D0-$1EF, with region at $1F0-$1FF.) If you size it as
40, region overlaps your code section at $200 and the build fails with
"org blocks overlap." `header.s` has the authoritative layout
in a prominent comment at the top.

### 4. VDP control reads: bit 3 of LOW byte, address $C00005

The VDP status register is a 16-bit big-endian word at $C00004. The
"vblank in progress" flag is bit 3 of the LOW byte - accessed at
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
asar (where memory-to-memory is sometimes legal), this is easy to miss.
An "operands mismatch" error from the assembler means "this addressing-mode
combination is invalid for the 68000," not "your CPU is too old."

## Build + iterate workflow

The fastest loop for most Genesis work:

```js
build({
  output: 'run',
  platform: "genesis",
  source: /* your .s contents */,
  frames: 60,                    // step 60 frames after load
  holdInputs: [{ start: true }], // optional: hold a button
})
```

Returns the build status and a final screenshot in one call.

For multi-file projects use the `sources` map:

```js
build({
  output: 'run',
  platform: "genesis",
  sources: { "main.s": mainText, "music.s": musicText },
  frames: 60,
})
```

For projects with binary assets (tiles, palettes, music data):

```js
build({
  output: 'rom',
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

Genesis has full debugging parity with SNES - all tools are loaded at session
start (see `catalog({op:'categories'})` for the map):

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

Compare `sprites({op:'inspect'})` with `frame({op:'screenshot'})` to check that
sprites render where the game places them (the screenshot `overlayBoxes` option
is NES and SNES only).

## ROM file extension

romdev writes `.gen` by default. Genesis frontends (Batocera, ES-DE,
RetroBat, RetroPie, ROCKNIX) all accept `.gen`, `.md`, `.bin` and `.smd`.
`.gen` is unambiguous: `.md` collides with Markdown, `.bin` is generic, and
`.smd` implies an interleaved header format romdev does not emit.

## Limitation: live Z80 driver state

The YM2612 + Z80 sound CPU state is not currently as deeply
introspectable as the SNES SPC700 + DSP - YM2612 in particular
requires walking gpgx's internal struct which is version-fragile.
If you hit a sound-debugging wall here, open an issue at
https://github.com/monteslu/romdev/issues.
