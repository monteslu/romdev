# Debugging guide: inspecting and asserting state

How to find out what a running game is doing without guessing from screenshots: the per-platform inspectors, memory and state tools, symbol-aware reads, input mapping and save semantics. For reverse-engineering existing ROMs, read the romhacking playbook (`platform({op:'doc', platform:'romhacking', name:'playbook'})`). Read this with `platform({op:'doc', platform:'guide', name:'debugging'})`.

## Platform tiers

- 15 classic platforms: NES, SNES, Game Boy, Game Boy Color, GBA, Genesis, SMS, Game Gear, Atari 2600, Atari 7800, Lynx, C64, PC Engine, MSX, GameTank.
- sync32 (an open RP2350-based console; a native ARM cart, no PPU).
- 3D consoles: N64, PlayStation, Dreamcast.
- PICO-8 (FAKE-08, a Lua VM) and the native runtimes wasmcart and jsgame.

`platform({op:'capabilities', platform})` is the authoritative per-platform op matrix; a tool that cannot do an op on a platform returns `{unsupported:true, reason, alternative}`.

## Coverage by tool

- `cpu({op:'read'})`: 17 of the 19 platforms (MSX and PC Engine have no decoder yet). On ARM interpreters (sync32) there is no `execPc`; r15 is already the next instruction. GBA reports a pipeline-adjusted `execPc`. Core clocks appear under `coreInternal`.
- `breakpoint({on:'write'|'read'|'pc'})`, `frame({op:'stepInstruction'|'stepInstructions'})`, `cpu({op:'setReg'|'call'|'decompress'})`, `watch({on:'range'|'pc'|'mem'})`: all 15 classic platforms; `breakpoint`, single-step and coverage also run on N64 (cached-interpreter CPU).
- `watch({on:'copy'})` (every write into a VRAM window with the executing PC): the 15 classic platforms. `watch({on:'dma'})` (which ROM offset a VRAM graphic was DMA'd from): Genesis only.
- `disasm({target:'bytes'|'rom'|'references'})` and the Rizin/Ghidra targets (`cfg`, `xrefs`, `functions`, `decompile`, `resolveJumptable`): 18 platforms (all but sync32), including the 3D consoles' MIPS and SH-4. `disasm({target:'project'})` byte-exact reassembly and `build({output:'reassemble'})`: the 15 classic platforms.
- `sprites({op:'inspect'})`, `palette({source:'live'})`, `background({view:'renderState'})`: detailed on NES, SNES, Genesis, GB, GBC, SMS, GG, GBA, Atari 2600, Atari 7800, C64, Lynx. PC Engine and MSX have the generic tools and their cores' native regions. Lynx `sprites` returns the SCB list head (no fixed OAM). GameTank, sync32 and Dreamcast are framebuffer machines with no OAM or tilemap, so `sprites`/`background` do not apply.
- `audioDebug({op:'inspect'})`: the 13 systems with a sound chip (all classic platforms but the Atari 2600 and 7800), including GameTank's ACP coprocessor (`chip:'acp'`). `frames:N` traces a per-channel note timeline for headless melody checks; `audioDebug({op:'record'})` captures audio.
- `videoDebug({chip:'vdp'})`: SMS, GG and Genesis decoded VDP state (mode flags, name-table, sprite-attribute and pattern bases as real VRAM addresses, scroll, line counter, border). The control latch, status register and VRAM address are not exposed by the core and the response lists them under `unavailable`; for status-register behaviour use `breakpoint({on:'read'})` on the status port.
- `frame({op:'verify'})`: "is it rendering?" without vision on the 15 classic platforms and the native runtimes. Returns `{verified:true|false|null, issues[], pixels, render}`; `null` until a frame has been stepped.

Each platform's mental model lists its regions, inspectors and traps: `platform({op:'doc', platform, name:'mental_model'})`. By symptom:

- NES: blank screen, wrong sprites or colours, PPU registers, CIRAM attributes, banked CHR.
- SNES: garbage or flashing sprites, OAM/CGRAM, SPC700 and S-DSP state (PPU registers are read through the FillRAM shadow).
- Genesis: sprites, palette, scroll, SAT/CRAM/VSRAM/VDP/Z80 state (the core byte-swaps VRAM).
- GB/GBC: sprites, palette, tiles, SM83/APU/LCDC state; the core exposes `gb_vram` (not `video_ram`), `gb_oam`, `gb_io`, `gb_hram`.
- SMS/GG: sprites, tiles, palette, Z80, VRAM/CRAM/VDP regions; GG has a 12-bit palette and `gg_vram`/`gg_cram`.
- GBA: sprites, palette, BG, `execPc`, the `gba_*` regions, ARM vs Thumb disassembly.
- Atari 2600 and 7800: TIA or MARIA state, display lists, palette; no OAM and no `audioDebug`.
- C64: VIC, sprites, SID, banking, `c64_*` regions, `.prg` disassembly, disk load and save.
- Lynx: SCB lists, Mikey palette and audio, 65C02 registers, the `lynx_hw_regs` $FC00-$FDFF window.
- MSX and PC Engine: VDP/PSG inspection, AY-3-8910 `audioDebug`; generic tools otherwise.

## Memory and state

- `memory({op:'regions'})` lists the regions valid for the loaded platform. The per-platform ones (`sms_cram`, `genesis_cram`, `gba_palette`, `pce_vce_palette`, `msx_palette`, ...) are where most video and audio state lives.
- `memory({op:'read', region, offset, length})`; `offsets:[...]` batches scattered reads. Reads of 4 KB or less come back inline; larger ones need `outputPath` or `inline:true` (`echo:false` skips the inline hex).
- `memory({op:'snapshot'})` then `memory({op:'diff'})`: which bytes changed across an event. The diff is a clustered summary with stride detection; `minDelta`, `changeDir:'inc'|'dec'`, `deltaEq`, `beforeMin/Max`, `afterMin/Max` filter it; `outputPath` with `echo:false` writes the full list.
- `memory({op:'diffRuns', portsA, portsB?})`: which byte an input drives, from the same start state run twice.
- `memory({op:'search'})` / `searchNext` / `searchUnknown`: the value-search loop. Relative compares (`inc`, `dec`, `changed`) work as the first narrow; `as:'bcd'` and `as:'digits'` find packed-BCD scores and digit-per-byte HUD buffers.
- `memory({op:'readCart'})`: the loaded cart image (`{cpuAddress, bank}` for banked NES/SNES addresses; `findHex` scans for a byte pattern and maps every hit to a CPU address).
- `memory({op:'classify'})`: whether bytes look like ASCII, code or tile data. `memory({op:'provenance'})` and `memory({op:'write'})` complete the set.
- `state({op:'diff'})` is the coarse whole-machine diff; `state({op:'dump'})` a forensic dump.

## Assert state headlessly with symbols

Every "did the score go up / HP drop / level change?" check is a byte of RAM. Build with debug info, resolve the C global, read it: no screenshot.

```js
const b   = build({ output: "romWithDebug", platform, source, inline: true })
const sym = symbols({ op: "resolve", /* dbg or map: */ name: "score" })
memory({ op: "read", region, offset })
```

| Platform | Debug artifact | Pass to `symbols` |
|---|---|---|
| NES, C64, Atari 7800, Lynx, PC Engine (cc65) | `.dbg` | `{ dbg }` |
| GB, GBC, SMS, GG, MSX (SDCC) | sdld `.map` (`mapText`) | `{ map }` |
| Genesis (m68k-elf), GBA (arm-none-eabi) | GNU ld `.map` (`mapText`) | `{ map }` |

`build({output:'romWithDebug', resolveSymbols:["grid","score"]})` resolves names in the same call. `symbols` ops: `resolve` (name to address), `lookup` (address to symbol), `list`, `map` (layout by region; detects sdld or GNU ld), `addr` (live PC to enclosing C function), `analyze` (a ROM's structure). cc65 prefixes C names with `_`; `resolve` tries both spellings.

- Genesis C globals live in the $E0FF0000 work-RAM mirror; `resolve` returns `ramOffset` (the low 16 bits) and a `readHint`: read with `memory({op:'read', region:'system_ram', offset: ramOffset})`. The core word-swaps WRAM, so a 16-bit value's bytes are swapped at that offset.
- `static` globals resolve too. A global that is never read can be removed at -O2; mark state you inspect `volatile`.
- `symbols({op:'addr', pc, symbolsText: b.mapText})` names the routine a live `cpu({op:'read'}).pc` sits in.
- `symbols({op:'map', dbg, platform})` shows where every variable landed. cc65 reserves zero page $00-$01; the first `.res 1` is $02.

When you do not know the symbol, `memory({op:'snapshot'})`, trigger the event, `memory({op:'diff'})`.

## Diagnosing behaviour over time

`frame({op:'verify'})` answers "is it alive". When the screen looks plausible but the game is wrong, trace state instead of reading screenshots:

- Choppy movement or scroll: `recordSession({frames:180, holdInputs:[{right:true}], includeScreenshots:false, memorySamples:[{region, offset, length, label}]})` and sample the player's X and the scroll registers; look for scroll changing while the sprite barely moves. `watch({on:'mem', format:'series', ranges:[...]})` gives a value-per-frame curve. On Genesis, rewriting tilemaps in the frame loop is the usual cause; `watch({on:'dma', perFrame:true})` shows DMA spikes.
- A computed value is wrong but the build is clean: resolve the variable and read it (above). On sm83 and Z80, a "wrong value" is more often a WRAM layout collision than a miscompile; see the GB/GBC SDCC notes.
- Unclear background: `background({view:'map'})` decodes the tilemap (indices or a rendered PNG); `frame({op:'screenshot', scale:4})` enlarges a small handheld screen.
- Multi-byte values in `watch({on:'range'})`: set `as:'u16le'` (or u16be, u24, u32), otherwise the range is diffed per byte (un-annotated multi-byte ranges carry `byteIndex`/`byteLabel` and a `constantBytes[]` list of bytes that never moved). A watch armed while the CPU sits at an uncleared breakpoint reports `armedWhileHalted`. `fromState`/`fromStatePath` trace from a restored savestate.
- `breakpoint({on:'write'})` runs to the end of the frame and reports the last matching write with `hits`; `condition:'increase'|'decrease'|'equals'` with `conditionValue` keeps the meaningful write; `conditionWidth:16` watches a word in the platform's byte order; RAM mirrors are canonicalised (`armedAddress`); on a `pressDuring` run, `abortIf:[{region, offset, label}]` stops early when a guard byte changes. Every hit carries `registersAtHit`, and the CPU stays frozen until the hit is cleared.
- `breakpoint({on:'pc'})` freezes the CPU at an instruction; on a miss it reports `mainThreadPc` (the busiest PC over about a frame) and a `pcHistogram`.

Long-form loop when `build({output:'run'})` is too coarse: `build({output:'rom'})`, `loadMedia({platform, path})` (or `base64`), `frame({op:'step', frames})` or `runUntil({condition})`, then `frame({op:'screenshot'})`, `tiles({op:'pixels'|'fingerprints'})` or `memory({op:'read'})`; drive input with `input({op:'set'|'press'|'sequence'})`, and use `input({op:'timeline'})` (an absolute per-frame schedule) for differential work against a reference; `state({op:'save'|'load'})` for try and undo.

## Images or data

Image mode (`frame({op:'screenshot'})`, `tiles({op:'png'})`, `background({view:'map', render:true})`) is for "does this look right?". Text mode (`tiles({op:'pixels'|'ascii'|'fingerprints'})`, `memory({op:'read'})`, `frame({op:'screenshot', format:'ascii'})`) is for precise comparison and costs fewer tokens. If your client may drop inline images, start from `frame({op:'verify'})` and the decoded JSON of `sprites`, `palette` and `background`.

CHR and tile tools read from a file when you pass `path` (iNES CHR located automatically; raw `.chr`/`.bin` as-is) and from the running emulator otherwise; the response says `source:"file"` or `"emulator"`. NES homebrew built with `linkerConfig:"chr-ram"` has no CHR in the file; read it from the emulator after upload.

## Input mapping

`input({op:'set'})` takes an Xbox-shaped controller: D-pad, four face buttons (`north`/`east`/`south`/`west` for portable code), `l`/`r`, `l2`/`r2`, `l3`/`r3`, `start`, `select`. `ports[N]` is port N, and each button is its own boolean (`{a:true, b:true}`); a malformed port object is rejected, and a typo'd button comes back in `ignoredButtons[]`. Pressing a button the platform lacks does nothing; `input({op:'layout', platform})` lists real buttons, bit order and libretro ids.

The raw libretro names `a`/`b`/`x`/`y` are not the printed labels, and on the three genesis_plus_gx platforms they are inverted:

- Genesis: A/B/C are libretro y/b/a, so `{a:true}` presses C and Genesis A is `{y:true}` or `{west:true}`.
- SMS and Game Gear: button 1 (main fire) is libretro `b`, button 2 is `a`.
- Every other core maps straight through: NES, GB/GBC, SNES (with x/y/l/r), GBA, PC Engine (a = I, b = II), MSX (a = trigger 1), Lynx. C64 and Atari 2600 are single-fire: fire is `{b}` or `{south}`. The Atari 7800 boots in 1-button mode.
- wasmcart maps by position like the cores: `a` is east, `b` is south.

Use the spatial names or `input({op:'press', button:'a'|'b'|'c'|'1'|'2'})`, which resolve to the right physical button. Other input ops: `navigate` (advances a menu on screen change and reports whether each press was consumed), `timeline`, `pressKey`, `typeText`, `joyport` (C64 keyboard and joystick ports), `pointer` and `wheel` (wasmcart).

## Save states and SRAM

- `state({op:'save'|'load', name})` slots are in memory and discarded on `host({op:'shutdown'})` or new media. `state({op:'save', path})` writes the live host to a file; `state({op:'export', fromSlot, path})` copies an existing slot (such as one the human saved with a playtest hotkey) without touching the live host; `state({op:'load', path})` reloads either. A relative `path` resolves against the loaded ROM's directory (`resolvedPath` is echoed).
- A restore clears active cheats and reports `cheatsCleared`; `reapplyCheats:true` re-arms them (`cheatsReapplied[]`). `state({op:'save', path})` records active cheats in a `<path>.cheats.json` sidecar.
- SRAM (the battery save file): `memory({op:'read'|'write', region:'save_ram'})` live; `state({op:'exportSram'|'importSram', path})` for the `.sav`; `cart({op:'identify'})` reports `saveRam:{hasBattery, bytes}`. Carts without battery saves (and the Atari 2600, 7800 and Lynx) have an empty `save_ram`; use savestates. C64 saves to disk: `state({op:'exportDisk'|'importDisk'|'putDiskFile'})`.
- `host({op:'reset'})` resets the core and frame counter (and clears cheats) but keeps the ROM. `framesRun` is monotonic: `state({op:'load'})` does not roll it back.

## Common traps

- NES mapper addressing: NROM 16 KB carts mirror PRG at $8000 and $C000 (disassembly reports $C000+). Banked mappers fix the top 16 KB at $C000; pass a `startAddress` in the right range for another bank.
- C64 media is `.prg`, `.d64` or `.t64`; `loadMedia` takes `mediaKind`, and many C64 games need a key (F1, RUN/STOP) to start.
- A freshly booted Genesis ROM shows black for many frames while VDP init runs; step 60 or more frames before judging.

## When a call fails

Errors name the fix. Build failures return `issues: [{file, line, col, severity, message, stage}]`, ranked critical, error, warning, info; fix `critical:true` entries (such as a `WILL HANG:` loop-bound trap) even when the build succeeded. Entries with `stage:"lint"` come from a pre-compile lint with the right line number and a `ref:` into the platform's gotchas; `lint:"strict"` fails the build on any lint hit. Link errors carry a `hint`. Tool errors carry the recovery step, such as the exact `loadMedia({...})` to restore after an eviction.

Each WASM toolchain call runs in a child worker. If it aborts, only the worker dies; the response is `{ok:false, stage:"crash", log, crash:{exitCode, signal}}` and the session keeps working.
