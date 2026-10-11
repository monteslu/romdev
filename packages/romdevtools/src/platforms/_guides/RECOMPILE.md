# Static recompilation guide

romdev can statically recompile an existing ROM into a different program that runs the same game: a wasmcart (`.wasc`), a native sync32 cart, C source, or an instruction-level IR export for your own tools. Everything goes through one tool target, `disasm({target:'recompile'})`, and is checked against the platform's reference emulator core with the `frame` verification ops.

Read this guide with `platform({op:'doc', platform:'guide', name:'recompile'})`.

## What the outputs are

| `emit` | Sources | Output |
|---|---|---|
| `wasmcart` | nes, snes, gb, gbc, gba, sms, gg, genesis | A whole-ROM recompile packed as a `.wasc` at `outputPath`. Load it with `loadMedia({platform:'wasmcart', path})`. |
| `wasm` | same | The same module without the `.wasc` wrapper. |
| `wat` | same | The module as WebAssembly text. Debugging and small carts only: a SNES or GBA module is 1-2 GB of text. |
| `sync32` | genesis | A native `.s32` cart for the sync32 console, built with romdev's WASM Cortex-M33 toolchain. |
| `c` | genesis | The C project behind the sync32 build, written to the `outputPath` directory. |
| `ir` | sms, gg, msx, z80, genesis, gb, gbc, nes, snes, gba | Decoded instructions as JSONL at `outputPath`: byte offsets, CPU addresses, banks, cycles, control flow. |
| `blockMap` | same as `ir` | The same decode as a compact `{offset: length}` map. |
| `asm` (default) | nes, sms, gg, msx, z80 | One routine translated to SNES (65816) or Genesis (68000) assembly. See "Routine translation" below. |

## Whole-ROM recompile to a wasmcart

```js
disasm({target:'recompile', emit:'wasmcart', platform:'nes', path:'/proj/game.nes', outputPath:'/proj/out/game.wasc'})
loadMedia({platform:'wasmcart', path:'/proj/out/game.wasc'})
```

How it works:

- Every byte offset of the ROM becomes a compiled entry point, so a computed jump can never land in uncompiled code.
- Code with no compiled arm (code the game writes or copies into RAM, RAM code it patches, a bank paged where its arms were not compiled) runs in an interpreter built from the same per-instruction lowering. It runs exactly, with no discovery run and no per-game option.
- The hardware model is a port of the reference core the cart is verified against.
- The cart embeds a `romdev.recompile` custom section: platform, reference core, ROM sha1, the linear-memory regions to byte-compare against the reference's memory regions, probe offsets and the frame-alignment convention. A verifier needs no sidecar file.
- Carts declare wasmcart ABI v4.
- The response reports arms lowered and untranslated, sizes and the memory layout. A trap is left only for hardware the backend does not model; the cart's probe block reports `trapped` and `trappc` when it hits one.
- `.wasc` packing is deterministic (fixed timestamps, sorted entries), so the same ROM and options give the same bytes.

### Backends

| Platform | Reference core | Covered |
|---|---|---|
| nes | fceumm | Mappers 0, 1, 2, 3 and 4, undocumented opcodes, RAM code, APU audio sample-exact with the core. |
| snes | snes9x | LoROM, HiROM, ExHiROM; SPC700 and S-DSP audio; hires, interlace, PAL; SA-1, SuperFX, DSP-1 to DSP-4, ST010, ST011, ST018, OBC1, S-RTC, MSU-1, S-DD1, SPC7110, CX4, BS-X and Sufami Turbo; battery saves; chip state compared through `snes_chipstate`. |
| gb, gbc | gambatte | PPU state machine dot for dot, timers, HDMA, OAM DMA, MBC1/2/3/5, HuC1, MBC3 RTC, APU sample-exact. |
| gba | mGBA 0.11 | ARM and Thumb, audio, mosaic, OBJ cycle budget, GPIO, RTC and sensors. |
| sms, gg | genesis_plus_gx | Cycle-exact Z80, Mode 4 and TMS9918 modes, PAUSE NMI, IM2, Sega, Codemasters and Korean mappers, Game Gear in SMS mode, PSG audio sample-exact. |
| genesis | genesis_plus_gx | 68000 from gpgx's Musashi handlers, Z80 from Z80 RAM through gpgx's handlers, 6-button pads, second pad, J-Cart, PAL, backup RAM, EEPROM and mappers, address errors, interlace mode 2, Mode 4, YM2612 and PSG audio sample-exact, SVP (Samsung SSP1601 DSP) carts. |

### Options

Pass per-game settings that cannot be derived from the ROM in `options`. Unknown keys are ignored by a backend that does not use them. The common ones:

- `traceEntries` (power of two, 1024 and up): also record CPU registers per instruction, for `findDiverge` at `level:'instruction'`. Off by default.
- `breakArm` (an address): a must-fail control. One instruction is deliberately miscompiled, so a verifier that still passes is not measuring anything. Never set for a real build. Related controls: `breakThumb` (gba), `breakChip` (snes coprocessor reads), `svpBreak` (genesis SVP), `muteChannels` (nes, gb).
- `ramInterpreter:false` (sms, gg, genesis): a must-fail control only. RAM code then traps instead of running.
- `ramCode` (sms, gg, genesis): pre-compiles RAM-resident code found by a reference run or a static scan. A speed optimisation only; RAM code runs without it.

Per backend:

- snes: `firmware` (path to `st011.rom`, 53248 bytes, or `st018.rom`, 163840 bytes; required for those carts, which run on ares's chip code), `saveRam` (an `.srm` the cart powers on with), `saveRtc` (a 20-byte `.rtc` for S-RTC or SPC7110+RTC carts), `pcSkip`, `regwatchPc`, `armRanges`, `limit` (debugging). The verifier gives the reference core the same firmware and save files; keep them beside the reference ROM.
- sms, gg: `mapper` (`sega`, `codemasters`, `korean-a000`, `none`), `pagesSlot0`, `pagesSlot1`, `slot1Bank`, `region` (`export` or `japan`), `ramRegions`, `ramSnapshot`, `ramSnapshotFrame`, `probeRegs`. Most are derived from the header and a mapper scan.
- genesis: `discoverRamCode:false` turns off the static RAM-code scan; `audio:false` builds without sound.
- gba: `interp:true` builds without static arms (every instruction interpreted; small and slow, useful as an oracle); `buttons:'byName'` for a pad layout that reads wasmcart buttons by name instead of position.

Each backend's full option list is in its `describe()` output, echoed in the recompile response.

### Firmware and boot code

- ST011 and ST018 SNES carts need the chip's firmware file, supplied by you. romdev does not ship it.
- DSP-1 carts need the chip's data ROM, also supplied by you as firmware. romdev does not ship it.
- The SPC700 boot program in recompiled SNES carts is romdev's own clean-room reimplementation, not the console's boot ROM.
- `loadMedia({platform:'snes', core:'bsnes', firmware})` runs the reference on bsnes, the accuracy reference for the ST010, ST011 and ST018. `frame({op:'verifyRecompile', referenceCore:'bsnes'})` verifies against it.

## Verifying a recompiled cart

A recompile is only as good as its verification. The `frame` tool has five ops for it; all of them load what they need into slots A (cart) and B (reference) themselves.

### `frame({op:'verifyRecompile', cart, reference})`

One call that verifies a cart against its reference core:

- Loads the cart in slot A and the source ROM in slot B, drives both with one `input` schedule (`'frame:buttons:hold,...'` in reference frames), and aligns the two frame axes itself (`alignment` in the result; override with `cartFrameOffset`, or `cartFrameOffset:'auto'` to search for a sharp picture peak).
- At each of `atFrames` it scores exact, content (non-backdrop) and moving pixels, writes `[cart|ref|diff]` PNGs to `outputDir`, and byte-compares every region and field in the cart's section against the reference's memory (`requireStateMatch` defaults to true).
- Runs must-fail controls on separate cart instances: `vramZero`, `wrongFrame`, `wrongInput`. A control that cannot fail is reported as `couldNotFail` with the reason.
- VERIFIED needs every scored frame at 95% or more content on at least 2000 content pixels (and 95% moving where 200 or more pixels moved), every control failing, and no trap. `reasons[]` names each miss.
- Audio: `audio:true` reports, `audio:'required'` makes it part of the verdict. Both sides are captured per frame and compared sample for sample (or by spectral and envelope similarity when the rates differ), with their own must-fail controls (`silence`, `shift`, `stereoDrop`, `channelDrop`). `audioWav:true` writes WAVs.
- Auto mode (`auto:true`, or `atFrames` omitted): romdev picks the input schedule, scored frames and audio window from the reference core alone, deterministically from `auto.seed`, and reports a `reproduce` call. When no reference frame meets the bar the verdict is INCONCLUSIVE; the bar is never lowered.
- `firmware`, `cartButtonMap` and `referenceCore` cover carts that need them; a `p2.` (p1 to p4) prefix in the schedule presses another controller (`'900:p2.start:10'`). Companion files the cart's section lists (an MSU-1 data pack, for example) are copied into the reference core's file system.

### `frame({op:'findDiverge', cart, reference})`

The root-cause finder. In recompile mode it steps both sides on the same schedule and compares every region and scalar field of the cart's layout every frame (or every `stride`), from `startFrame`, and returns the first differing frame with the first differing byte and fields. `audio:true` also compares each frame's audio.

With `level:'instruction'` it traces one frame on both sides (the cart's trace ring and the reference core's free-running instruction trace), walks the two pc streams to the first divergent instruction, and reports `context` instructions from both sides. It reports interrupt-timing differences separately, compares per-instruction cycle costs (`firstClockDivergence`), compares registers where both traces carry them (build the cart with `options.traceEntries`), names the instruction that first produced a different value (`registers.producedBy`), and reads the reference CPU at the divergence (`firstDivergence.refCpuHere`).

### `frame({op:'fuzzRecompile', cart})`

Runs the cart alone under seeded random play (`seeds`, `frames` per seed, `input` presses kept in every script) and reports the first frame each seed traps at. A trap is invisible from outside (the host keeps showing the last picture), and a verified schedule only covers the code it reaches.

### `frame({op:'traceInstructions', frames})`

The instruction stream a host really executes over up to 600 frames: on a core, its free-running trace with the clock at each dispatch; on a recompiled cart, the trace ring its section declares. Returns the first `head` entries and a `pcRanges` loop map, and writes every entry to `outputPath`. `slot:'b'` traces the comparison host.

### `frame({op:'cycles', cart})`

sync32 carts only: CPU cycles per frame over a frame span on an input schedule (min, mean, p95, max, frames over the ABI floor and clock budgets, worst frames). `profile:true` adds a pc-sampling profile attributed per function, object file and group from the cart's linker map; `perFrame`, `series`, `annotate` and `groups` refine it.

## Native sync32 build of a Genesis cart

`disasm({target:'recompile', platform:'genesis', emit:'sync32'})` builds a native `.s32`: genesis_plus_gx's machine in C plus the game's 68000 code recompiled per basic block to C, compiling only the code the wasmcart recompile was seen to run (`options.coverage: {cart, input, frames, fuzzSeeds, schedules}`); the rest runs in the Musashi interpreter. The game's Z80 driver is recompiled too (`options.z80:false` skips it).

- `options.profile`: `'exact'` (default, instruction-exact 68000) or `'fast'` (block-level cycle charging; drifts from the reference).
- `options.audioQuality`: `'fast'` (default), `'hq'` (sample-exact against the reference) or `'half'` (cheapest).
- `options.audioRate`: `'console'` (48 kHz) or `'reference'` (the reference core's 44100 Hz stream, for a test build that `verifyRecompile` compares sample for sample).
- `options.extraCflags` passes extra compiler flags.
- `emit:'c'` writes the C project instead of building it. The `emit:'sync32'` response reports image and RAM use against the 3 MB XIP slot and 304 KB game RAM.

Verify with `frame({op:'verifyRecompile', cart:'<.s32>', reference:'<rom>'})` and measure with `frame({op:'cycles'})`.

## IR export for your own recompiler

`emit:'ir'` with `allOffsets:true` and `outputPath` writes JSONL covering every byte of the ROM (a manifest comes back, never megabytes inline):

- Banked platforms decode each bank at the CPU address it executes at, so `addr` and branch targets are CPU addresses.
- `alignments:'all'` adds a record at every byte offset the linear tiling did not start an instruction at (`alignment:'secondary'`). A computed jump can land mid-instruction, so a recompiler needs them. Secondary records overlap by design: assert `offsetsWithRecord == romBytes`, never sum record lengths.
- Instructions that straddle a bank edge are marked `straddlesWindow`; undecodable bytes are `decodeStatus:'data'` records; a tail cut by the end of the ROM is `truncated-at-rom-end`.
- GBA: `cpuState:'arm'|'thumb'` picks the instruction set. Most GBA game code is Thumb, so export both.
- `emit:'blockMap'` gives `{offset: length}`; `primaryOnly:true` limits it to the linear tiling. `fileOffset`, `slot`, `mapper` and `mapperState` control where and how banks are decoded.

## Routine translation (asm output)

The older routine translator lifts one routine (`startAddress`, `length`) through a shared IR and emits target assembly. Sources: `nes` (6502) and `sms`/`gg`/`msx`/`z80` (one Z80 lifter). Targets (`targetPlatform`): `snes` (65816, 1:1 emulation-mode port; `withShim` draws the original's static boot screen, `withRuntime` adds per-frame sprite flush and the game's NMI so it plays) and `genesis` (68000 logic translation, presentation stubbed; check it with `frame({op:'compareRam'})`). `outputDir` gets `main.asm` and the seam file for `build({platform:'snes'})`.

- An unsupported source and target pair is refused.
- `residue` lists everything not mechanically translatable. The common entry is a computed jump: resolve its arms with `breakpoint({on:'jumptable'})` and re-run with those addresses as entries.
- Hardware is left at a seam: 6502 hardware is memory-mapped (PPU/APU stubs); on the Z80 every `in`/`out` is a seam (`Z80_IO_READ`/`Z80_IO_WRITE`, port in X).

This translates a routine and stubs out-of-slice callees. For a whole ROM use `emit:'wasmcart'`.

## Licence of recompiled carts

A compiled homebrew ROM contains only its author's code. A recompiled cart is different: it contains code ported or translated from the reference emulator, plus the code of the game it was recompiled from. Every recompiled cart carries a `licence` entry in its `romdev.recompile` section (on sync32, in the cart metadata) naming each component, its upstream, commit and SPDX id, and what the terms mean for sharing the cart:

- nes: fceumm, GPL-2.0-or-later.
- gb, gbc: gambatte, GPL-2.0-only (plus the MIT blipper resampler).
- gba: mGBA, MPL-2.0.
- sms, gg, genesis: Genesis Plus GX, Musashi, MAME z80.c and (for SVP) the SVP code, all non-commercial terms; blip_buf, LGPL-2.1-or-later.
- snes: snes9x, non-commercial; snes_spc S-DSP, LGPL-2.1-or-later; SPC7110 code, ISC; ares chip cores (ST011, ST018), ISC.

The full licence texts ship in the package's `LICENSES/` directory and the NOTICE file's "Recompiled carts" section explains the terms. The recompiled game's own code remains its owner's.
