# romdev - Agent guide

This is romdev's general orientation. Read it once. Detail lives in docs you fetch on demand with `platform({op:'doc'})`; this guide says which one to read when.

## What this server does

romdev runs the whole retro game development and reverse-engineering loop in-process: build, run, screenshot, inspect, debug, patch, disassemble, decompile, recompile, convert assets and drive emulators. Every compiler and emulator core is bundled as WASM.

- Platforms: 19 consoles and computers (see "Platforms"), plus the PICO-8 fantasy console and two native runtimes (wasmcart, jsgame).
- Homebrew: fork a working example game, edit it, `build({output:'run'})` to build, load, run and screenshot in one call.
- Reverse engineering: byte-exact rebuildable disassembly, value search, write/read/pc breakpoints, coverage, Rizin/Ghidra analysis and decompilation, cheat lookup, ROM patching and asset re-injection.
- Static recompilation: turn a NES, SNES, Game Boy, GBA, SMS/GG or Genesis ROM into a wasmcart and verify it against the reference core.
- Matching decompilation: recover C that compiles to the original bytes with the project's original compiler, run as WASM.

You drive the work. The human directs: they may want a game, a disassembly, a romhack, a recompile, or anything else here.

### Where the detail lives

| Read | When |
|---|---|
| `platform({op:'doc', platform, name:'mental_model'})` | Before writing code or doing RE on a platform: memory map, video chip, input, build pipeline, footguns, debug regions. |
| `platform({op:'doc', platform, name:'troubleshooting'})` | The moment something on that platform is broken. |
| `platform({op:'doc', platform, name:'upstream_sources'})` | Where the bundled library and compiler sources are. |
| `platform({op:'doc', platform:'n64', name:'decomp'})` | Matching decompilation. |
| `platform({op:'doc', platform:'romhacking', name:'playbook'})` | Before any romhack or RE task: the decision tree and per-asset round trips. |
| `platform({op:'doc', platform:'guide', name:'recompile'})` | Static recompilation and its verification ops. |
| `platform({op:'doc', platform:'guide', name:'debugging'})` | Per-platform inspector coverage, memory/state tools, symbol-aware reads, input mapping, save states. |
| `platform({op:'doc', platform:'guide', name:'assets'})` | Art, tilemaps, sprite capture, audio formats, cross-platform moves. |
| `platform({op:'doc', platform:'guide', name:'music'})` | Where to get music and how to turn it into platform data. |
| `platform({op:'doc', platform:'guide', name:'wasmcart'})` | wasmcart carts: ABI, input, WebGPU, `presentWindow`, the `wasm` tool. |
| `platform({op:'doc', platform:'guide', name:'bezels'})` | Active Bezels (`.ab` companions that composite over a game). |
| `platform({op:'doc', platform:'guide', name:'sessions'})` | Sessions, eviction, many agents on one server, the playtest window, the livestream, feedback. |

`platform({op:'docs', platform})` lists what a platform ships; `platform({op:'docs', platform:'guide'})` lists the guides.

## The one hard rule: never install a compiler or emulator

You never need, and must never install, a compiler or emulator to build or run a ROM here. Every compiler, assembler and linker (cc65, sdcc, gcc and binutils for m68k/arm/mips/sh, tcc, wla, rgbds, asar, dasm), every SDK (SGDK, PVSnesLib, libtonc/libgba, cc65 libs) and every emulator core is bundled as WASM and runs through these tools: `build`, `loadMedia`, `frame`, the inspectors, `playtest`.

If a compiler or emulator install is invoked or prompted (`clang`, `gcc`, Xcode or Command Line Tools, `node-gyp`, devkitPro, `brew`/`apt install <compiler>`), that is a defect. Do not install it, do not investigate it with host commands, and report it ("romdev should provide this"), for example with `feedback({op:'record'})`. `platform({op:'list'})` and `platform({op:'toolchains'})` show what is bundled.

- Native addons (the playtest window's `@kmamal/sdl`) ship prebuilt. A compile kicking off means the prebuilt is missing: do not let it compile. `playtest` self-heals by downloading the binary, or fails with `reason:"sdl-binary-missing"` and a one-line `fixCommand`.
- Content tools are fine: ImageMagick, GIMP, LibreSprite/Aseprite, Audacity, Tiled, a tracker, a quick art script. They make source PNGs, `.wav`, `.tmx`; romdev imports and packs them (see the assets guide), and often does the whole conversion itself.
- romdev itself is JavaScript and WASM only and never runs Python, make or git on the host.

Matching decompilation also uses the original compiler as WASM. `decomp({op:'setup', root})` runs a fresh checkout's own setup and extract goals in-process (splat as the JS port romdev-splat at the versions the project pins), and `decomp({op:'import'})` registers it. Compiles use the flags the project's Makefile chooses per file (romdev reads the Makefile). Supported compilers: IDO 5.3/7.1, KMC gcc 2.7.2, EGCS 1.1.2, PS1 gcc 2.6.3 with maspsx, mips-linux-gnu gcc 14, with mips-linux-gnu binutils, armips and a JS asm-processor. IDO is SGI's proprietary compiler and is not shipped: build it with `scripts/build-ido.sh` from a romdev source checkout, or point `ROMDEV_IDO_DIR` at your build. A build step with no WASM/JS equivalent (a Python asset packer) is never run on the host: its existing output is kept and reported in `keptPrebuilt`.

## The second rule: read your platform's docs before writing code for it

This guide cannot hold 19 platforms of detail. Read `platform({op:'doc', platform, name:'mental_model'})` for every system you build for or reverse-engineer, before writing code. Most "why won't this work" dead ends are a documented footgun there (a C64 game that needs a key to start, an SDCC WRAM-layout trap, a render-enable order, a core that exposes `gb_vram` not `video_ram`). Read `troubleshooting` the moment something breaks, and the romhacking playbook first for any hack.

## Platforms

| Tier | Platforms | What works |
|---|---|---|
| Classic (15) | NES, SNES, Game Boy, Game Boy Color, GBA, Genesis, Master System, Game Gear, Atari 2600, Atari 7800, Atari Lynx, C64, PC Engine, MSX/MSX2, GameTank | Build, run, inspect, sound and music, forkable genre examples, write/read/pc breakpoints, single-step, coverage, byte-exact disassembly projects, re-inject tools, mental model and troubleshooting docs. |
| sync32 | an open RP2350-based console (Cortex-M33, `.s32`) | C carts against a function-pointer ABI, WASM toolchain, memory/cpu/palette inspection, five genre examples, cycle profiling. No PPU, OAM or tilemap. |
| 3D consoles | Nintendo 64, PlayStation, Dreamcast | Build and run examples (GPU-rendered cores), disassembly, Rizin/Ghidra analysis, memory tools; N64 breakpoints and single-step; matching decompilation projects. |
| Fantasy console | PICO-8 (FAKE-08) | `build` packages a `.p8` from Lua; `disasm({target:'source'})` reads the cart's Lua; `memory({region:'system_ram'})` is its 64 KB. CPU and tile inspectors do not apply. |
| Native runtimes | wasmcart, jsgame | Load, step, screenshot, input, `frame({op:'verify'})`, the `wasm` tool, `pack`. |

Genre examples (`shmup`, `platformer`, `puzzle`, `sports`, `racing`) ship for every classic platform except the Atari 2600, which has four (no `puzzle`: the TIA has no tilemap for a match-3 board), and for sync32, GameTank, PICO-8, N64, PlayStation and Dreamcast. The platformer side-scrolls with a hardware camera everywhere except NES and the Atari 2600, which are single-screen. Classic platforms also ship a music demo (`music_demo`) on the de-facto engine (FamiTone2, hUGEDriver, an SPC700 driver, XGM2, maxmod, PSG trackers, a SID sequencer, `lynx_snd_play`, TIA; PC Engine and MSX as `music_sfx`, plus `sprite_move`/`catch_game` projects).

`platform({op:'list'})` is the live matrix with language defaults and quirks (`platform` filters to one row, `slim:true` drops prose). C is the default wherever a C compiler is bundled; asm-only platforms default to asm; pass `language` to override. Platform-specific inspectors, regions and traps are in each mental model; the debugging guide has the coverage matrix.

## Tools

All 38 tools are registered at session start; call any by name. Each is a verb with an operation axis. `catalog({op:'categories'})` maps them by purpose; `catalog({op:'status'})` re-orients a session (what is loaded, version, health, play and bezel state).

| Tool | Axis and values |
|---|---|
| `catalog` | `op`: categories, status |
| `platform` | `op`: list, capabilities, resolve, toolchains, docs, doc |
| `examples` | `op`: list, fork, show, snippets, copySnippets |
| `build` | `output`: rom, romWithDebug, run, project, reassemble |
| `loadMedia` | load a ROM, disk, tape, program or cart (`path` or `base64`; `slot:'b'`, `core`, `firmware`, `cheats`, `coreOptions`, `useActiveBezel`, wasmcart options) |
| `host` | `op`: unload, shutdown, reset (`hard:true` power-cycles), pause, resume, play, stop |
| `frame` | `op`: step, screenshot, stepAndShot, sideBySide, compareRam, findDiverge, compareRender, portStatus, stepInstruction, stepInstructions, traceInstructions, verify, verifyRecompile, fuzzRecompile, cycles |
| `input` | `op`: set, press, sequence, timeline, navigate, layout, pressKey, typeText, joyport, pointer, wheel |
| `state` | `op`: save, load, list, export, dump, diff, exportSram, importSram, exportDisk, importDisk, putDiskFile, autoSnapshot, recoverSnapshot |
| `memory` | `op`: read, write, readCart, regions, snapshot, diff, diffRuns, classify, search, searchUnknown, searchNext, provenance |
| `symbols` | `op`: resolve, lookup, map, list, addr, analyze |
| `disasm` | `target`: bytes, rom, range, project, references, cfg, xrefs, functions, reachable, decompile, source, resolveJumptable, pointerTable, recompile, script, accessScan, sourceLookup |
| `breakpoint` | `on`: write, read, pc, jumptable |
| `watch` | `on`: mem, range, pc, dma, copy |
| `cpu` | `op`: read, setReg, call, decompress |
| `runUntil`, `recordSession` | step until a memory or framebuffer condition; record a timeline of screenshots and memory samples |
| `sprites` | `op`: inspect, group, preview, capture, render, emitC, extractScreenshot |
| `tiles` | `op`: png, pixels, fingerprints, ascii, preview |
| `background` | `view`: map, renderState, rendered |
| `palette` | `source`: live, platformMaster, lospec |
| `videoDebug`, `audioDebug` | VDP state (`chip:'vdp'`); audio chip state and traces (`op`: inspect, record) |
| `encodeArt`, `importArt` | `stage`: quantize, crop, tiles, tilemap, validate; `from`: aseprite, gif, texturepacker, tiled, rom |
| `encodeAudio` | `target`: brr, xgm2pcm, xgm2, maxmod, famitone, spc, gg, sms, c64, lynx, atari7800, gb, gbc, sync32, sync32pcm |
| `romPatch` | `op`: write, writeMany, spliceCHR, relocate, makeStored, findFree, findPointer, diff, gbHeader |
| `assembleSnippet` | assemble a few instructions to bytes at an origin (6502, 65816, 68k, Z80, SM83, HuC6280) |
| `cart` | `op`: identify, extract, wrap, packDisk |
| `cheats` | `op`: lookup, search, apply, remove, clear, make |
| `text` | `op`: learn, encode, find (custom-font text) |
| `wasm` | `op`: conformance, info, exports, debugState, events, read, write, save, command |
| `pack` | `target`: wasc, jsgame |
| `playtest` | `op`: open, stop, status, framebuffer, fps, bezel |
| `regression` | `op`: capture, check (golden checkpoint runs) |
| `decomp` | matching decompilation, about 45 ops (see "Matching decompilation") |
| `files` | `op`: read, write, list |
| `feedback` | `op`: record, list |

## Making a game: fork an example, then iterate

Never start from a blank file. Fork the example whose core loop is nearest your game (even for a very different game), then change one thing at a time and re-run `build({output:'run'})`. Retro bring-up is a long chain of fragile hardware init with no partial credit; a working game is your regression oracle.

1. `examples({op:'list', platform?})`: every example with its kind (`game` or minimal `reference` such as `default`, `hello_sprite`, `tile_engine`), mechanics, hardware techniques, players and SRAM, plus genre-to-nearest-fork guidance.
2. `examples({op:'fork', example:'<platform>/<name>', name, path, title?, overwrite?})`: copies the example into a new directory as your game (sources, runtime files, crt0, linker config, vendored library source, README, `.gitignore`), renamed throughout. It builds before you change a line. The response lists the files you edit plus `vendorFileCount` (`verbose:true` for the full list). You can pass `platform` + `template` instead of `example`.
3. `build({output:'run', path, platform})` builds the directory, loads it, runs it and returns a screenshot inline. `build({output:'project', path, outputPath})` builds the directory to a ROM.
4. `examples({op:'show', example, file?, technique?})` reads a donor example without forking; `technique` extracts one marked HARDWARE IDIOM block with its dependency header to graft.
5. `examples({op:'snippets', platform, mode:'list'|'get'|'getAll'})` and `examples({op:'copySnippets', platform, destinationDir, include?})` fetch vetted helpers (reset, read_pad, OAM DMA, palette upload); `copySnippets` writes to disk without passing bytes through your context.

Want a side-scroller? Fork `<platform>/platformer`. NES scrolling needs platforms drawn into the nametables plus `ppu_scroll(camX,0)` and column streaming past 512 px; each platformer's `describe` text and the mental model's "Horizontal scrolling" section give the details.

### Project layout and the directory build

A forked project is flat: `main.c`/`main.asm`, your helper modules, crt0 and linker config sit at the root, so includes resolve without `-I`. The only subdirectory is `vendor/`, the full source of every library the ROM links (`vendor/cc65/libsrc/<platform>/`, `vendor/libtonc/src/`, `vendor/libgba/src/`, `vendor/pvsneslib/source/`, `vendor/sgdk/src/`). It is read-only in practice: the linker uses the precompiled libraries, so edits there do not reach the ROM. `grep -rn <symbol> vendor/` finds any library function's implementation.

The directory build finds the entry (`main.c`, `main.s`, `main.asm`), routes the crt0 (GB/GBC `gb_crt0.s` through the cart-header path), applies the linker preset (NES `chr-ram-runtime`), skips SDK intermediates, wires runtimes (GBA libtonc/libgba/maxmod by include), treats `.h`/`.inc` as includes and folds binary assets (`.bin`, `.chr`, `.pcm`, `.brr`, `.vgm`, `.xgc`, ...) in as `binaryIncludes`. Use `build({output:'rom'})` with explicit `sources` only for files not on disk.

`build({output:'run'})` takes `frames` and `holdInputs` (for example `[{right:true}]`) to test input in the same call; round trips are 50-500 ms. Use the separate `loadMedia` / `frame` / `state` calls only when you need several state changes in one ROM lifetime.

### ROMs are finalized for real hardware

`build` output boots on real hardware, flashcarts and strict emulators; the post-link finalize step runs for you (do not checksum or pad by hand): Genesis padding and `$18E` checksum; GB/GBC `rgbfix` (logo, header and global checksums, CGB flag); SMS `TMR SEGA` header, checksum and region byte; SNES power-of-two padding and internal checksum with LoROM/HiROM detection; NES iNES header from the linker config. The response's `romLayout` / `log` say what was applied.

### Where ground truth is when the example disagrees with behaviour

1. The bundled examples (verified to build and run).
2. Your project's runtime source (`gb_runtime.c`, `lynx_sfx.c`, ...; 50-200 readable lines each).
3. Your project's `vendor/` library source.
4. `platform({op:'doc', platform, name:'upstream_sources'})` for bundled source paths and upstream links.
5. Upstream repositories for compilers and emulators.
6. A real romdev bug: open an issue at https://github.com/monteslu/romdev/issues with a diagnosis and repro.

If two or three iterations on the example do not converge, switch from editing to reading the library source. When the example and the library disagree, trust the library.

### Toolchain traps that apply everywhere

- C builds run a pre-flight lint. Read `issues[]`; `stage:"lint"` entries name the right file:line (raw compiler line numbers are often off by one) and carry a `ref:` into the platform's gotchas. `lint:"strict"` fails the build on any lint hit.
- All SDCC platforms (GB, GBC, SMS, GG, MSX) are C89: declarations at the top of each block, no `for (int i...)`, no compound literals or designated initializers. The GB/GBC SDCC notes (in the package at `src/platforms/gb/lib/c/SDCC_GOTCHAS.md`) also cover WRAM-layout traps that look like miscompiles.
- cc65 zero page starts at $02 ($00-$01 are reserved).
- Platform-specific traps (asar silent failures and CHR/tilemap overlap on SNES, SNES audio as a separate SPC700 build, NES 256-unique-tile cap, GB `shadow_oam` alignment and `memcpy_vram`, SMS/GG 8-sprites-per-line and `$D0` terminator) are in each platform's mental model and troubleshooting docs.

## Running, looking and asserting

- `frame({op:'verify'})` answers "is the game actually rendering?" without vision: `{verified:true|false|null, issues[], pixels, render}`.
- Assert state by reading memory, not by reading screenshots: `build({output:'romWithDebug'})`, `symbols({op:'resolve', name})`, `memory({op:'read'})`. The debugging guide has the per-toolchain table.
- `frame({op:'screenshot'})` takes `crop:{x,y,w,h}` (a native-resolution HUD strip for a fraction of the tokens), `scale` (below 1 for cheap change checks, not for reading text; integer above 1 to enlarge), `format:'ascii'`, and `source` when an Active Bezel is attached.
- Input: `input({op:'set', ports})` is positional (`ports[N]` is port N) with one boolean per button; the spatial names `north/east/south/west` resolve to the right physical button on every platform (the raw libretro `a`/`b` are inverted on Genesis, SMS and Game Gear). `input({op:'layout', platform})` gives the real buttons and bit order; read it before writing a `read_pad` routine. `input({op:'timeline'})` is an absolute per-frame schedule for differential runs; `navigate` advances menus on screen change.
- `memory({op:'regions'})` lists the regions for the loaded platform; start there rather than guessing.

### Large output: a path, or ask for it inline

Tools that can return large payloads (ROM bytes, disassembly, memory dumps, build logs, tile blobs, screenshots) default to `inline:false` and need an output path (`outputPath`, `outputDir` or `path`); you get back `{path, bytes}`. Pass `inline:true` to get the payload in the response. There is no hidden default location. Exceptions: `memory({op:'read'})` of 4 KB or less is inline, and `build({output:'run'})` returns its screenshot inline (`screenshotPath` to write it instead). If you are not sure your client shows inline images, work from `frame({op:'verify'})` and the decoded JSON of `sprites`, `palette` and `background`.

Prefer paths over base64 for inputs too: the server shares your filesystem.

### When a call fails, read the error first

Errors name the fix. Build failures return `issues: [{file, line, col, severity, message, stage}]` ranked critical first; fix `critical:true` entries (such as `WILL HANG:` loop-bound traps) even on a successful build; fall back to `log` only when `issues` is empty. Tool errors carry the recovery step (an eviction's "No ROM loaded" names the exact `loadMedia({...})`; a rejected load points at `cart({op:'identify'})`; a mistyped button returns `ignoredButtons[]`). A crashed WASM toolchain returns `stage:"crash"` without affecting the session.

## Reverse engineering and romhacking

Read the playbook first: `platform({op:'doc', platform:'romhacking', name:'playbook'})`. It wires the tools below into a decision tree and covers text, compressed assets and graphics round trips.

A good default order:

1. `cart({op:'identify', path})`: platform, title, mapper, save RAM (handles zip-wrapped ROMs).
2. `cheats({op:'lookup', path})`: the bundled cheat database is a labeled RAM and code map for thousands of known ROMs (`kind:ram` = a variable, `kind:code` = a patch site). Cheap; check early. Labels are probable name matches; verify before patching.
3. Disassemble and trace for anything about code or data the cheats do not cover: `disasm({target:'project'})` for a byte-exact rebuildable project (edit a region `.asm`, then `build({output:'reassemble', platform, path})`; pass `background:true` for ROMs of 512 KB or more and poll with `job`); `disasm({target:'references'|'accessScan'})` for who touches an address; `breakpoint({on:'write'|'read'|'pc'})` for the exact instruction; `watch({on:'range'|'pc'|'copy'|'dma'})` to discover routines; `symbols({op:'analyze'})`, `disasm({target:'functions'|'cfg'|'xrefs'|'reachable'})` for structure; `disasm({target:'decompile'})` for Ghidra pseudocode; `breakpoint({on:'jumptable'})` for computed dispatchers no static walk can follow.
4. Verify live before patching: `memory({op:'write'})` the address and watch the effect.
5. Patch: `romPatch({op:'write'|'writeMany'})` with `expect:` bytes (refuses a wrong revision), or prototype with `cheats({op:'apply'})`.

Find a value's address with the search loop (`memory({op:'search'})` then `searchNext`), not a full-RAM diff. Drive the ROM's own codecs with `cpu({op:'call'|'decompress'})` and put assets back with `romPatch({op:'makeStored'|'findFree'|'relocate'|'findPointer'})`. Edit on-screen text with `text({op:'learn'|'find'|'encode'})`. Assemble patches with `assembleSnippet`. These work on the 15 classic platforms; disassembly and the Rizin/Ghidra analysis cover 18 platforms including the 3D consoles' MIPS and SH-4.

## Static recompilation

`disasm({target:'recompile', emit:'wasmcart', platform, path, outputPath})` recompiles a whole ROM into a playable wasmcart for nes (fceumm), snes (snes9x, with SA-1, SuperFX, DSP-n, ST010/011/018, S-DD1, SPC7110, CX4, OBC1, S-RTC, MSU-1, BS-X, Sufami Turbo), gb/gbc (gambatte), gba (mGBA), sms/gg and genesis (genesis_plus_gx, including SVP carts). Every ROM byte offset is a compiled entry point and RAM code runs in a matching interpreter, so no discovery run is needed. Per-game settings go in `options` (ST011/ST018 and DSP-1 carts need firmware you supply; romdev does not ship chip firmware). `emit:'sync32'|'c'` builds a native sync32 cart from a Genesis ROM; `emit:'ir'|'blockMap'` exports decoded instructions for your own tools; the default `asm` output translates one routine to SNES or Genesis assembly.

Verify with the `frame` ops: `verifyRecompile` (pixels, memory regions, audio and must-fail controls against the reference core in one call; `auto:true` picks the schedule itself), `findDiverge` with `cart` (first differing frame and byte; `level:'instruction'` finds the first divergent instruction), `fuzzRecompile` (seeded play hunting traps), `traceInstructions` (the real executed instruction stream), `cycles` (sync32 frame cost and profile).

Every recompiled cart carries a `licence` entry naming the emulator code it contains (GPL, MPL or non-commercial terms, depending on the platform); the texts are in the package's `LICENSES/` directory. Read `platform({op:'doc', platform:'guide', name:'recompile'})` before using any of this.

## Matching decompilation

`decomp({op})` drives a splat-based decomp project (N64 and PlayStation) through the original compiler as WASM. The loop: `setup` (fresh checkout), `import`, `plan`, `resolve`, `generate` (m2c candidate via romdev-m2c), `compare` (compile inside its translation unit; per-instruction and relocation equality), `search` (bounded permuter job via romdev-permuter; `job`, `jobs`, `candidates`), `integrate` (patch, full-ROM byte verify, auto-revert), `progress`. Runtime ops (`smoke`, `overlays`, `symbolize`, `state`, `trace`, `coverage`) check a live session. Campaign ops (`workbench`, `dispatch`, `experiment`, `gate`, `diagnose`, `variants`, `rank`, `ledger`, `research`, `knownSource`, `assets`, `skill`, `handoff` and others) run the bundled decomp workbench in process. `exactFunctionMatch` and `romLinked.status:'exact'` are the acceptance signals; `distance` only ranks. Read `platform({op:'doc', platform:'n64', name:'decomp'})` first; `decomp({op:'skill'})` returns the bundled campaign skill.

## wasmcart, WebGPU and jsgame

`loadMedia({platform:'wasmcart', path})` runs a WebAssembly cart. Carts must target wasmcart ABI v4 or later (older ones are refused). Buttons map by position (`a` is east). GL carts get their own GL context; WebGPU carts load the same way (`gpuPower`, `wgpu:false`, `deterministicStepMs` are load options). Load GL carts with `presentWindow:true` before opening a playtest window. `wasm({op})` inspects a cart (conformance, named debug state, events, a `command` request/reply channel). `pack({target:'wasc'|'jsgame'})` builds the archive. Details: `platform({op:'doc', platform:'guide', name:'wasmcart'})`.

## If a human is watching, open playtest early

If a human is with you, open the playtest window as soon as the first build succeeds: `playtest()` opens a native SDL window that runs the ROM live with USB gamepads and returns immediately. Every other tool keeps working on the same live host, and rebuilds update the window in place. The human should be playing while you iterate.

- No gamepad: relay the `keyboardControls` / `tellUser` note from the response.
- `playtest({op:'status'})` reports `perf` (fps and per-stage costs); `playtest({op:'fps', show:true})` draws a counter for the human.
- While the human presses buttons, their input wins and responses carry `humanCoDriveWarning`; `catalog({op:'status'})` shows `humanInputActive`. Use `host({op:'pause'})` or a second session for deterministic stepping.
- Skip it for CI, batch RE, or when told "headless". A failed open is a tool error with a `reason` (`sdl-binary-missing`, `no-display`, `sdl-error`) and every other tool stays headless.

To show a game moving on the `/livestream`, call `host({op:'play', seconds})` once; never loop `frame({op:'step'})` calls to keep the stream alive.

The sessions guide covers the window ops, hotkeys, aspect, pointer carts and the livestream in full.

## Active Bezels

An Active Bezel (`.ab`) runs beside a ROM every frame and draws a composite scene. With one attached, `frame({op:'screenshot'})` returns the composite by default, not the core's picture; `catalog({op:'status'})` reports `activeBezel` whenever one is attached, so check it before interpreting captures in an unfamiliar session. `source:'core'|'both'` selects the picture. Bezels with `pre_frame` can poke memory and override input invisibly to breakpoints (`activeBezel.preFrame` in status). Load with `loadMedia({..., useActiveBezel:true})`; authoring needs no toolchain (`npx --package active-bezel abtool scaffold my-bezel lua`). Details: `platform({op:'doc', platform:'guide', name:'bezels'})`.

## Sessions

Your emulator lives in your session for the server's lifetime; sessions do not expire. Use one session for the whole job and keep sending the same identity.
On MCP, call initialize once and reuse the session id; re-initialize only after a server restart (HTTP 404) or an explicit missing-session error.
Clients on the 2026-07-28 protocol revision should pass one stable `session` argument (a descriptive slug) on every tool call.

- A host idle for about 10 minutes may be evicted; the next call fails with "No ROM loaded" and names the exact `loadMedia({...})` to re-run. Open playtest windows are never evicted.
- `state({op:'autoSnapshot', enabled:true})` and `state({op:'recoverSnapshot'})` survive a server restart.
- Running several sessions: declare yourself with the `x-romdev-agent` header (or `dev.romdev/agentHandle` in `_meta`) and end sessions with `host({op:'shutdown'})`.
- A different `session` value is a fully isolated second emulator.
- `feedback({op:'record', title, body, severity})` logs a defect locally for the human.

Details: `platform({op:'doc', platform:'guide', name:'sessions'})`.

## When in doubt

`platform({op:'list'})` for capabilities, `platform({op:'capabilities', platform})` for which ops a platform supports, `catalog({op:'status'})` for what is loaded, `platform({op:'toolchains'})` for build tools, `state({op:'list'})` for save slots, `memory({op:'regions'})` for memory. Tools describe themselves; you do not have to remember the matrix.
