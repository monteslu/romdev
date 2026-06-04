# romdev — Agent guide

You are reading this because romdev is connected. This is the orientation. Read it once; you won't need to re-read it during a session.

## What this server does

Drives the full homebrew ROM dev loop for 14 retro game platforms (NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Genesis, Sega Master System, Game Gear, Atari 2600/7800, Atari Lynx, Commodore 64, PC Engine / TurboGrafx-16, and MSX / MSX2). Build → run → screenshot → inspect → patch → iterate. Also a strong reverse-engineering kit: disassemble existing ROMs (byte-exact rebuildable projects), find the EXACT instruction that wrote a RAM byte (`findWriter`, a core-level write watchpoint), and — the cheapest RE move of all — look up cheats (`gameCheats`: a free, crowd-sourced labeled RAM/code map for known ROMs that answers "which byte holds X?" without disassembling), apply + create cheats, convert assets, study patterns from real games, drive emulator state for scripted testing. Bundled WASM toolchains and emulator cores — no system dependencies, no installs.

You drive the work. The human is a director — they may want a game, a ROM disassembly, a tool-assisted reverse-engineering session, or anything else this server can do.

## The one hard rule: NEVER install a compiler or emulator. romdev bundles every one.

Internalize this above all else: **you never need — and must never install — a compiler or an emulator to build or run a ROM here.** Every compiler/assembler/linker (cc65, sdcc, gcc, tcc, wla, rgbds, vasm, m68k-gcc, arm-none-eabi-gcc, …), every devkit/SDK (SGDK, PVSnesLib, libtonc/libgba, cc65 libs, …), and every emulator core (fceumm, snes9x, gpgx, gambatte, mGBA, handy, vice, prosystem, stella, …) is **already bundled as WASM** and runs in-process through these MCP tools. The whole build → link → run → inspect loop is `buildSource` / `runSource` / `buildProject` / `loadMedia` / `screenshot` / `inspect*` / `playtest` — never a host `gcc` or a downloaded toolchain.

**So if a build toolchain or emulator is ever invoked or prompts to install — `clang`, `gcc`, Xcode / macOS Command Line Tools, `node-gyp`, devkitPro, `brew/apt install <compiler>` — that is a DEFECT, not your cue to proceed.** Stop, do NOT install it, do NOT investigate it with host-side diagnostic commands (that just alarms the user), and surface it: "romdev should provide this — a host compiler/emulator should never be needed." Then find the romdev tool or report the gap. `listPlatforms` / `listToolchains` show what's bundled.

### Host content tools (art / audio / map editors) are totally fine

This rule is about **compilers and emulators only** — NOT about content tools. ImageMagick, GIMP, Aseprite/LibreSprite, Audacity, Tiled, a tracker (FamiStudio/Deflemask), Python for a quick art script — all fine to use, and fine for the user to install. They produce **raw source art/audio** (a PNG, a sprite sheet, a `.wav`, a `.tmx`); romdev then **imports and packs** that into platform-native data. Use them freely when they help; just don't reach for a *compiler or emulator*.

### romdev also packs assets in-server — reach for these first

Asset conversion is bundled too, so you often don't need the host tools at all. First-class tools: `convertImageToTiles`, `imageToTilemap`, `quantizePngForPlatform`, `getPlatformPalettePng`, `getLospecPalette`, `validateGenesisTiles`, the loaders `loadSpriteSheet` / `loadAsepriteSheet` / `loadGifAnimation` / `loadTilemap`, and helpers like `captureMetaSprite` / `crossPlatformSpriteImport`. The canonical quantize→tile→pack path lives here — `loadCategory({category:"assets"})` to see it. Typical flow: paint pixels in a host editor (or generate a PNG), then `quantizePngForPlatform` → `convertImageToTiles` to get platform-native tiles. (You can do the whole thing in-server too when the art is procedural.)

### Native-addon prompts are a packaging bug — never compile on the host

A couple of optional features load a native Node addon (most notably the `playtest` SDL window, via `@kmamal/sdl`). These ship **prebuilt** — they must never compile on your machine. If you see a `clang` / Xcode / Command Line Tools / `node-gyp` build kick off while using romdev, the prebuilt binary is missing or mismatched: **do not let it compile, do not install a toolchain — report it.** `playtest` itself self-heals by downloading its prebuilt binary and, if it can't, returns `{opened:false, reason:"sdl-binary-missing", fixCommand}` with the exact one-line fix — it never needs a host compiler.

## If a human is watching, open playtest early

If a human is sitting next to you during this session — and that's most sessions in practice — open the playtest window as soon as your first build succeeds. `playtest()` opens a native SDL window that runs your ROM live and accepts USB gamepads (hot-plugged controllers are picked up automatically). It returns **immediately** — the render loop runs in the background, so you keep calling other tools while the human plays. Every other MCP tool keeps working against that same running ROM, and **`runSource`/`loadMedia` rebuilds update the window in place** — the window follows your latest build, no relaunch and no crash on rebuild. A human sitting next to you should be **playing the game** while you iterate, not watching screenshots scroll past.

```
loadCategory({category:"show"})  // registers playtest / playtestStop / playtestStatus / playtestFramebuffer
playtest()                       // opens the SDL window (returns immediately)
```

After that, keep iterating with `runSource` / `buildSource` / readMemory / screenshot exactly as before — they all act on the live emulator the user is playing. Because the window and `screenshot()` read the **same** live host, what you screenshot is what the human sees. (If you ever need to be explicit — e.g. to double-check the human's exact frame — `playtestFramebuffer()` captures the window's framebuffer directly, with `source`/`loadedMediaPath`/`frameCount` metadata.)

**No gamepad?** `playtest()`'s response includes a `keyboardControls` map and a `tellUser` note when no controller is detected — relay the keys to the human (arrows = D-pad, Z = main action, Enter = START, ESC closes) so they know how to play.

Skip playtest only when there's clearly no human in the loop: CI runs, automated test suites, batch reverse-engineering, or when the user has explicitly said "headless." `playtest()` needs a desktop session to draw into; if it can't open a window it returns `{opened:false, reason, message}` and the `message` tells you exactly how to fix it. Two distinct cases: `reason:"sdl-binary-missing"` means the `@kmamal/sdl` native binary isn't installed (the server tries to self-heal, but if it can't, the message gives a `fixCommand` to run + restart) — a one-time native-addon fix, NOT a display problem. `reason:"sdl-error"` means SDL ran but couldn't get a display — usually no desktop session (run the server yourself in a terminal inside your desktop session, then connect your agent). Either way, every other tool (build, run, screenshot, inspect) is fully headless and unaffected. When in doubt, ask once, then default to opening it.

## Tool surface: everything is loaded — just call the tool

**All ~101 tools are registered and callable from session init. You do NOT need `loadCategory` first.** If you see a tool name anywhere in this doc or via `listCategories`, you can call it right now.

(We used to lazy-load tools behind `loadCategory` to keep the surface small. It caused more harm than good — agents burned round-trips re-loading categories and got confused about what was callable. So the full surface loads up front. If a server is explicitly run in lean mode — `ROMDEV_LEAN_TOOLS=1` — then only an entry tier loads and you arm the rest with `loadCategory`; that's the exception, not the default.)

`listCategories` still exists as a **map of what's available, grouped by purpose** — useful for discovery, not a gate:

- `platforms` — which platforms + languages are supported
- `run` — load ROMs, step frames, screenshot (works for existing ROMs you didn't compile)
- `input` — drive controllers, look up hardware bit layouts
- `state` — savestates and forensic state inspection (`saveState`, `loadState`, `exportState` a slot to disk without touching the live host, `listStates`, `dumpState`)
- `memory` — read/write VRAM/OAM/CGRAM/ARAM and other regions. `readMemory` takes `offsets:[…]` to batch scattered reads in one call. `snapshotMemory` + `diffMemory` answer "which bytes changed across this event?" (snapshot → trigger → diff returns just the changed offsets); `diffState` is the coarse whole-machine version.
- `debug` — inspectSprites, inspectPalette, getCPUState (all 14), getAudioState (the 12 systems with a sound chip — all but Atari 2600/7800), getRenderingContext, findWriter (write watchpoint, all 14), **disassemble**/disassembleProject (13 — not GBA's ARM7), symbol lookup, whichTilesAreRendered, addressToSymbol, plus **cheats** (`gameCheats` = a free labeled RAM/code map for known ROMs, `applyCheat`/`clearCheats` non-destructively, `makeCheat` to create codes)
- `assets` — convert PNGs to tiles, WAVs to BRR, identify ROMs, plus the hacking toolkit (`patchFile`, `assembleSnippet`, `diffRoms`, `findFreeSpace`, `spliceCHR`, `extractCart`, `wrapRomFromParts`)
- `project` — starter snippets per platform
- `show` — `playtest` (open the live SDL window for a human), `playtestStop`, `playtestStatus`, `playtestFramebuffer` (capture exactly what the human's window shows)
- `advanced` — runUntil, watchMemory / runUntilWrite, **`findWriter`** (the EXACT instruction that wrote a byte, via a core watchpoint — fixes the frame-sampled-PC problem), input recording

**"Disassemble this NES ROM"** is now just: `disassembleRom({path, startAddress, length})`. No discovery step.

### Romhacking / reverse-engineering: start with `gameCheats` — it's a free RAM map

When the task is to **modify an existing game** ("give the player infinite lives",
"change this text", "find where the score lives"), the cheapest first move is
almost always `gameCheats({path})`, NOT disassembly. The bundled cheat database is
a crowd-sourced **labeled memory map** for thousands of known ROMs: each RAM cheat
is a named address (`"Infinite Health" → $00CD`), each Game Genie / code cheat is a
named code site (address + value). It answers the most expensive RE question —
*"which byte or routine holds X?"* — for free, in one call, before you disassemble
or hunt with watchMemory. This is a serious RE tool, not a toy.

The canonical romhacking loop:
1. **`identifyRom({path})`** → platform + title (sniffs zip-wrapped ROMs too).
2. **`gameCheats({path})`** → the free labeled RAM/code map for THIS game. Filter
   by keyword (`filter:"lives"`). Treat labels as *probable* (matched by name, not
   verified CRC) — see step 3.
3. **VERIFY the label** before patching: `writeMemory` the address live and watch
   the effect, or `watchMemory`/`runUntilWrite` to confirm what touches it. Static
   "matches the pattern" ≠ "actually runs."
4. **Patch**: `patchFile`/`patchRom` (with `expect:` bytes so a wrong-revision
   write is refused) — or apply the cheat live with `applyCheat` to prototype.

Only drop to `disassembleRom` / `findReferences` / `findWriter` when cheats don't
cover what you need (custom logic, compressed data, an address no cheat names).
Those are powerful, but they're step 2 *after* the free map, not step 1.

**If your session ever returns a 404 "session not found"** (the server restarted), your MCP client should auto-reconnect (re-`initialize`) — and the fresh session again has every tool loaded. You don't re-arm anything. If your client does NOT auto-reconnect on 404, restart its MCP connection once; that's a client limitation, not a server step.

## Large output: write to a path, or ask for it inline

Tools that can return a LARGE payload (ROM bytes, full disassembly, big memory dumps, build logs, tile blobs, **and screenshots/inspect images**) follow ONE rule so they don't silently flood your context:

- **`inline: false` is the default → you MUST pass an output path** (`outputPath` / `outputDir` / `path`). The payload is written there and you get back just `{ path, bytes }`. Calling such a tool with neither a path nor `inline:true` returns a clear error telling you which to pass.
- **`inline: true` → the payload comes back in the response** (base64 / hex / text / the image). Use this when you actually want it in context.

There is **no hidden default location** — nothing ever lands in a temp dir you can't find, so you never lose a ROM to `/tmp`. You (the agent) decide where output goes; pass your project directory.

Ergonomic exceptions:
- **Small reads stay inline.** `readMemory` of ≤4 KB returns hex inline with no path needed (peeking a few RAM/OAM/palette bytes is the common case). Only large reads require a path/inline.
- **`runSource` returns its screenshot inline by default** — its whole purpose is "build + run + show me." Pass `screenshotPath` only if your client can't display inline images.

**On images specifically:** the `inline:true` image is only useful if YOUR client actually delivers inline images to you — some clients silently drop or down-convert image content. If you're not certain you can see them, **work from the structured data instead**: `inspectSprites` / `inspectPalette` / `getRenderingContext` always return their decoded JSON (sprite lists, palette entries, render flags) regardless of inline/path, and `screenshot({format:'ascii'})` gives a text render. The inline PNG is an opt-in luxury, not the primary signal.

## Trust hierarchy — where to find ground truth (R58 + R58b)

Two parallel paths depending on what you need:

### Path A — Scaffold a working project (the dumb-model-friendly path)

Most agent sessions start here. You want a working ROM, not a
research project. Use the high-level scaffolding tools and don't
worry about ground truth:

1. **`createProject({platform, template, name, path})`** — drops a
   complete, self-contained project tree on disk (main.c + the
   runtime files it needs + your `vendor/` library source for
   reference + README + .gitignore). Build with `runSource` against
   the project's files; the bundled examples ARE the reference
   implementation.
2. **`createGame({platform, genre})`** — same but picks a known-good
   genre scaffold (shmup / platformer / puzzle / sports / racing).
3. **`starterSnippets({platform, mode})`** (mode `list`/`get`/`getAll`)
   / **`copyStarterSnippets({platform, destinationDir})`** — fetch
   vetted helper files (reset routine, read_pad, OAM DMA, palette
   upload, etc.) when building from a smaller starting point.
   `copyStarterSnippets` writes the files to disk in one call
   without round-tripping bytes through your context — preferred
   when you're scaffolding into a project dir.

For most workflows, path A is all you need. Read MENTAL_MODEL.md +
TROUBLESHOOTING.md when stuck. File a feedback round if the bundled
examples are wrong.

### Path B — Debug when the bundled code disagrees with behavior

When the example builds clean but doesn't render / sound / behave
right, when an API call doesn't do what you expect, when you need
ground truth on what a library function actually does — dig in this
order:

1. **Bundled examples** (`examples/<platform>/templates/*.{c,asm}`) —
   verified to compile + (usually) run. Start here for the working pattern.
2. **Your own project's runtime source** (alongside `main.c`) — our
   thin wrappers (gb_runtime.c, lynx_sfx.c, sms_vdp_init.c, etc.).
   All ~50-200 lines, fully readable. Read these when an API call
   isn't doing what you expect.
3. **Your own project's `vendor/` library source** (R58b — auto-
   copied into every project at scaffold time). The FULL source of
   every library your ROM links against — `vendor/cc65/libsrc/<p>/`
   for cc65 platforms, `vendor/libtonc/src/` + `vendor/libgba/src/`
   for GBA, `vendor/pvsneslib/source/` for SNES, `vendor/sgdk/src/`
   for Genesis. **`grep -rn <symbol> vendor/`** inside your project
   finds the actual implementation of any library function. No MCP
   call needed.
4. **`getPlatformDoc({platform, name:"upstream_sources"})`** — per-
   platform pointers at every bundled source path + upstream GitHub
   links for the compilers + emulators we DON'T bundle (cc65,
   sdcc, m68k-gcc, snes9x, gambatte, handy, etc.). Use as a
   cheat-sheet for "where do I look for X?"
5. **Upstream GitHub** for compilers + emulators when the bug is
   below our thin wrappers. Don't bundle (gigabytes for gcc/binutils
   source) but the link is one click.
6. **Hit a real bug in romdev itself?** Open an issue at
   https://github.com/monteslu/romdev/issues with repro details. File
   only with a diagnosis (not bare "it doesn't work") — read the bundled
   source first.

**Important constraint on path B:** the `vendor/` library source is
**read-only in practice**. You can read + grep it freely, but if
you EDIT a file there, the linker still uses our precompiled
`libtonc.a` / `libmd.a` / etc., so your ROM won't pick up the
change. R59 (planned) will fix this with a per-TU object cache +
source-first library build. Until then, treat `vendor/` as a window
into "what the linked code actually does."

The "vendor/" library source in your project is new in R58b (it was
previously in the install only; you'd have to call
`copyStarterSnippets` to pull it in). Now it lands automatically
when you `createProject`. Round 30/31 Lynx wedges took 5 friction
rounds partly because cc65's TGI driver source wasn't visible;
post-R58b you can `grep -rn bar_c vendor/cc65/libsrc/lynx/` from
inside your project directory and read the actual blitter code.

**Practical rule for path B:** if you find yourself filing a
feedback round without first `grep`ping `vendor/` for the symbol
you're debugging, you're skipping the cheap diagnosis path. The
bundled examples are starting points, NOT ground truth — when they
disagree with behavior, trust the library source over the example.

### Which path to use

- **Just need a working game** → Path A. Use createGame, iterate.
- **Hit a bug or unexpected behavior** → switch to Path B.
- **Don't know which** → start in Path A; if iterations fail to
  converge after 2-3 attempts, you're hitting something path A
  can't fix and need path B.

### Where files land in your project tree

A scaffolded project (whether via `createProject` or `createGame`) is
**FLAT** for everything you author. `main.c` / `main.asm`, your
helper modules (e.g. `gb_runtime.c`, `nes_runtime.c`,
`atari7800_sfx.c`, `vcs_constants.h`), the platform crt0 + linker
config — all sit at the project root, next to each other. Asm
`include "vcs_constants.h"` / C `#include "gb_runtime.h"` resolves
without `-I` flags because dasm / cc65 / sdcc all default to the
current directory.

The **only** subdir you'll see at scaffold time is `vendor/` —
that's the read-only library source tree (cc65 libsrc, libtonc /
libgba src, PVSnesLib source, SGDK src) auto-bundled by R58b so
you can `grep -rn vendor/` when debugging. Don't put your own
source under `vendor/`.

So when `copyStarterSnippets` drops e.g. `read_joystick.asm` into
your project dir, it lands at `./read_joystick.asm` (alongside
`main.asm`), NOT under `./include/` or `./lib/`. Every platform
follows the same flat layout.

## Supported platforms

**13 tier-1 platforms** (build + run + screenshot + inspect + ≥5 genre scaffolds + sound + music + per-platform MENTAL_MODEL.md + TROUBLESHOOTING.md):

NES, Game Boy, Game Boy Color, SNES, Genesis, Game Boy Advance, SMS, Game Gear, C64, Atari 2600, Atari 7800, Lynx — all with `createGame({genre: shmup|platformer|puzzle|sports|racing})` available except Atari 2600 (asm-only — no genre scaffolds). The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every one of these except NES, which is single-screen. Every tier-1 platform also ships a `music_demo` template using the platform's de-facto music engine: FamiTone2 (NES), hUGEDriver (GB/GBC), SPC700 driver (SNES), XGM2 via SGDK (Genesis), maxmod + .xm soundbank (GBA), PSG trackers (SMS/GG), SID sequencer (C64), `lynx_snd_play` (Lynx), 2-voice TIA (Atari 2600/7800).

**Bring-up only** (build pipeline works, single `default` template, no genre scaffolds or sound/music wrappers yet): MSX, ColecoVision. Both use SDCC z80 same as SMS/GG — the genre scaffolds are queued.

**Delisted** (toolchain works but core-side issue blocks the run loop): Atari 5200 (atari800 BIOS-load path), ZX Spectrum (fuse tape-load path).

Call `listPlatforms` (in the `platforms` category) for the live capability matrix, including per-platform language defaults and quirks. **Defaults are picked to maximize agent effectiveness** — for every platform that has a bundled C compiler, C is the default (LLMs write C cleanly; the compiler handles register allocation + memory mapping). Platforms whose only bundled toolchain is an assembler default to asm. Override with `language: "asm"` or `language: "c"` when you specifically need the non-default.

For maintainers: the platform / core / patch / region-ID matrix and the recipe for adding a new platform live in the project repo at https://github.com/monteslu/romdev.

## Deep debug tooling status per platform

Different platforms have different levels of MCP-exposed debugging — different hardware needs different tools, and we've patched the cores where it's been worth it. The generic shapes — `getCPUState`, `inspectSprites`, `inspectPalette`, `getRenderingContext`, `findWriter` — are wired for **all 12 tier-1 systems** (each platform's adapter reads its native hardware and normalizes to the common shape); `getAudioState` covers the **10 with a sound chip** (all but Atari 2600/7800). A few are honest hardware-shaped exceptions, noted inline below (the Lynx has no fixed OAM so inspectSprites returns the SCB list head; GBA has no bundled disassembler). Coverage detail per platform:

> **Universal across ALL 12 platforms below:** `findWriter` (the core-level
> instruction write watchpoint — the exact PC that wrote a RAM byte, all 12 CPU
> families), `gameCheats`/`applyCheat`/`makeCheat` (cheat lookup/apply/create),
> `getCPUState` / `getRenderingContext`, `snapshotMemory`/`diffMemory`/`diffState`,
> `watchMemory`/`runUntilWrite`, and `getAudioState` for the 10 systems with a
> sound chip (all but Atari 2600/7800). `disassembleRom` + `findReferences` +
> `disassembleProject` cover 11 — **GBA is the one exception** (ARM7TDMI has no
> bundled disassembler; its live-debug tools all work, only static disasm doesn't).
> The per-platform notes below cover the platform-SPECIFIC inspectors + chips.

- **SNES** (snes9x patched): inspectSprites, inspectPalette, getCPUState({cpu:'main'|'spc700'}), getDspState (full per-voice + master mixer), readMemory regions for OAM/CGRAM/ARAM/FillRAM. Audio + video both deeply introspectable.
- **NES** (fceumm patched): inspectSprites, inspectPalette, getCPUState (6502), getRenderingContext (PPUCTRL/PPUMASK decoded → active CHR bank + file offset), readMemory regions for OAM/Palette/Nametables/CHR/CPU_REGS/PPU_REGS/APU_REGS.
- **Genesis** (gpgx patched): inspectSprites, inspectPalette, getCPUState({cpu:'main'}) for 68K, getYm2612State (limited — internal struct), getPsgState, readMemory regions for CRAM/VSRAM/VDP_REGS/Z80_RAM/M68K/YM2612/PSG/VRAM.
- **SMS / Game Gear** (gpgx patched): inspectSprites (SAT decode + sprite-sheet PNG), inspectPalette (6-bit BGR for SMS, 12-bit BGR for GG), inspectPatternTiles (4bpp interleaved, 16KB VRAM as 512-tile sheet), getCPUState (Z80 — A/F/BC/DE/HL/IX/IY/shadows + flags + interrupt state), getAudioState({chip:'psg'}) (SN76489 — 3 tone + 1 noise; same gpgx region as Genesis), getRenderingContext (VDP regs → name table / BG-tile / sprite-tile / SAT addresses + scroll + display state), readMemory regions for sms_vram, sms_cram, sms_vdp_regs, sms_z80_regs (gg_vram, gg_cram for Game Gear's 64-byte palette). disassembleRom + findReferences run through a built-in JS Z80 decoder with full prefix coverage (CB/ED/DD/FD/DDCB/FDCB) and the same auto-label / register-annotation / file-offset / untilReturn pipeline as NES/SNES.
- **Game Boy / Game Boy Color** (gambatte patched): inspectSprites (40-sprite OAM decode + sprite-sheet PNG with sprite-priority + h/v flip), inspectPalette (DMG: BGP/OBP0/OBP1 byte decode → 4 shades each; GBC: 64-byte BCPS/OCPS palette RAM → 8 palettes × 4 colors BGR555), inspectPatternTiles (384 tiles from $8000-$97FF), getCPUState (SM83 — A/F/BC/DE/HL + flags + IME/halt), getAudioState({chip:'gb'}) (DMG APU — 2 pulse + wave + noise with timer→freq→note, sweep, duty, panning), getRenderingContext (LCDC bit-by-bit, scroll, LY/LYC, window, GBC extras: VRAM bank / KEY1 / BCPS/OCPS index), readMemory regions for gb_vram, gb_oam, gb_io, gb_hram, gb_bgpdata, gb_objpdata, gb_cpu_regs. disassembleRom + findReferences route through a built-in JS SM83 decoder with full CB-prefix coverage + SM83-specific opcodes (`ld (hl+),a`, `ldh`, `reti`, `ld hl,sp+e8`).
  - **Toolchains:** default is **C** via SDCC's sm83 port (same SDCC that powers SMS/GG/MSX/Coleco). For hand-tuned asm, pass `language:"asm"` to route through RGBDS. The C path uses `__sfr __at 0xFFNN` to bind GB I/O regs; helper headers under `src/platforms/gb/lib/c/gb_hardware.h` define LCDC/STAT/SCY/SCX/LY/BGP/OBP0/OBP1/etc. for both DMG and CGB. The SDCC 4.4.0 codegen quirk (`for (;;) { switch + write to __sfr }` crashes the register allocator) applies — use `do { ... } while (1)` and table-lookup writes instead.
- **Atari 2600** (stella2014 patched): inspectPalette (NTSC 128-color palette PNG; current background luma+hue extracted from TIA snapshot), inspectSprites (no OAM — returns the 5 graphics objects state P0/P1/M0/M1/Ball + a current-scanline PNG showing TIA composition), getCPUState (6502 — A/X/Y/P/SP/PC from the M6502 internal regs), getRenderingContext (decodes the 32-byte TIA snapshot into playfield/sprite/colors), readMemory regions for `system_ram` (128 bytes of RIOT RAM), `a26_tia_regs` (32-byte TIA snapshot), `a26_cpu_regs` (7-byte 6502 snapshot). disassembleRom + findReferences anchor to the top of the bank ($F000-$FFFF) with vector-table labels (NMI/RESET/IRQ at $FFFA).
- **Atari 7800** (prosystem patched): inspectPalette (256-color master PNG; MARIA palette block at $20-$3F decoded into 8 palettes × 3 colors + backdrop), inspectSprites (no OAM — returns the MARIA control regs + the DPP display-list-list pointer for the agent to walk), getCPUState (6502 — A/X/Y/P/SP/PC from prosystem's sally globals), getRenderingContext (MARIA CTRL bits + DPP + CHARBASE + dlistPtr), readMemory regions for `system_ram` (the entire 64KB 6502 address space — MARIA regs, RAM, ROM all visible) + `a78_cpu_regs`. disassembleRom + findReferences default to the top 16KB ($C000-$FFFF) where the reset vector lands.
- **Commodore 64** (vice patched): inspectPalette (the 16-color hardware-fixed palette PNG + current border/background/extra-bg indices decoded from VIC-II regs), inspectSprites (8 MOBs decoded into the generic shape with X/Y/color/multicolor/expand-X/expand-Y/priority + the screen-RAM sprite-data pointers at $07F8 so the agent can locate sprite pixel blocks), getCPUState (6510 — A/X/Y/P/SP/PC from a `#define`-aliased live register file + the I/O port at $0001 decoded into LORAM/HIRAM/CHAREN), getAudioState({chip:'sid'}) (6581/8580 — 3 voices {waveform, freq→note, pulse-width, ADSR} + filter cutoff/resonance/mode), getRenderingContext (VIC-II regs decoded into mode/scroll/colors/sprites, VIC bank from CIA2 $DD00, absolute screen + char base addresses), readMemory regions for `system_ram` (64 KB RAM), `c64_color_ram` (1 KB), `c64_vic_regs` (64 B), `c64_sid_regs` (29 B via sid_peek), `c64_cia1_regs`/`c64_cia2_regs` (16 B each from `c_cia[]`), `c64_cpu_regs` (7 B). disassembleRom + findReferences accept `.prg` files (2-byte load-address header) and the C64 register annotation table for VIC-II / SID / CIA registers. Starter snippets cover vic_init / sprite_table / sid_play / read_joystick / basic_stub.
- **Game Boy Advance** (mgba patched): inspectSprites (128 OAM sprites → generic shape with shape/size, 9-bit signed X, affine/hidden, tile/palette/priority), inspectPalette (256 BG + 256 OBJ 15-bit BGR555, `area:'bg'|'sprite'`), getCPUState (ARM7TDMI — 16 gprs r0-r15 + cpsr/spsr + mode + ARM/THUMB, plus `execPc` adjusted for pipeline prefetch), getAudioState({chip:'gba'}) (4 DMG PSG channels + 2 Direct Sound DMA FIFOs, master/bias), getRenderingContext (DISPCNT bg-mode + per-BG enable/priority/char-base/map-base/color-mode, forced-blank, OBJ enable), readMemory regions for `gba_cpu_regs`, `gba_io_regs` (the IO page — video AND audio regs), `gba_palette`, `gba_oam`, plus system_ram/video_ram/save_ram. **The one exception to the universal set:** no `disassembleProject`/`disassembleRom` — ARM7TDMI has no bundled disassembler; use external ARM tools. (findWriter and every other live-debug tool DO work.)
- **Atari Lynx** (handy patched): inspectPalette (16-entry 12-bit Mikey palette → RGB), getCPUState (65C02 — A/X/Y/P/SP/PC + flags), getAudioState({chip:'mikey'}) (4 channels — volume, timer→freq→note, 12-bit LFSR state), getRenderingContext (DISPCTL DMA-enable/flip/color-mode + display base address), readMemory regions for `lynx_cpu_regs`, `lynx_hw_regs` (the $FC00-$FDFF Suzy+Mikey window — sprite engine regs, LCD control, audio, palette), plus system_ram. **inspectSprites is a special case:** the Lynx has NO fixed OAM — sprites are SCB (Sprite Control Block) linked lists in RAM walked by Suzy, so inspectSprites returns the SCB list head (SCBNEXT $FC10/$FC11) and instructions to walk the chain over system_ram rather than a sprite table.
- **MSX, ColecoVision**: standard system_ram + save_ram + video_ram. Deeper introspection not yet added — extend by patching their cores following the snes9x/gpgx/fceumm/vice pattern (see scripts/patches/).

Starter snippets per platform live under `src/platforms/<platform>/lib/`. Discover via `starterSnippets({platform})` (default `mode:'list'`), fetch one via `starterSnippets({platform, mode:'get', name})`. SNES + NES + Genesis + SMS + Game Boy + Atari 2600 + Atari 7800 have substantial snippet libraries; others are minimal.

## ROMs are finalized for real hardware automatically

`buildSource` / `runSource` return ROMs that boot on **real hardware,
flashcarts, and strict emulators (RetroDECK / RetroArch)** — not just our
lenient WASM cores. The build pipeline runs each platform's required
post-link finalize step for you. **You do NOT need to checksum, pad, or
header-patch the output yourself.** What gets fixed:

- **Genesis** — padded to a 128KB boundary (min 512KB) + `$18E` checksum.
- **GB / GBC** — `rgbfix`: Nintendo logo ($0104), header checksum ($014D),
  global checksum, CGB flag ($0143 = $00 for `.gb`, $C0 for `.gbc`).
- **SMS** — `TMR SEGA` header at $7FF0 + checksum ($7FFA) + region/size byte
  (export region $4) so the SMS BIOS doesn't reject it. (GG BIOS doesn't
  check, but it's written anyway.)
- **SNES** — padded to a power of 2 (min 32KB) + internal checksum ($FFDE) +
  complement ($FFDC), LoROM/HiROM auto-detected.
- **NES** — the iNES header is emitted by the linker config; nothing to add.

Why this matters: our WASM emulator skips the boot-ROM validation that real
hardware runs, so a ROM can look perfect in `screenshot`/`playtest` yet fail
to boot on a console or RetroDECK. The finalize step closes that gap. The
build response `romLayout` / `log` states what was applied.

## First, try runSource

**`runSource` is the primary tool.** It does build + load + run + screenshot
in a single call, returning the image inline. Reach for it before any 4-call
sequence of buildSource → loadMedia → stepFrames → screenshot.

```js
runSource({
  platform: "gbc",
  source: /* your C or asm */,
  frames: 60,
  holdInputs: [{ a: true }],  // optional — hold buttons during the run
})
```

Round trip is ~50-500 ms depending on platform. Use it for fast iteration,
prototyping, "does my change still render correctly", "does the d-pad
move the sprite". When you change a line of code, the next call is usually
just another `runSource` with the same args.

**Where it shines:**
- Trying out a new game-loop change
- Verifying a sprite renders at the right position
- Testing input handling — `holdInputs: [{right: true}]` for 60 frames and
  see if the player moved right
- Quick "did I break it" sanity checks after a refactor

You don't need `loadMedia` / `stepFrames` / `screenshot` separately for any
of these. The 4-call workflow only matters when you want to drive multiple
emulator-state changes within one ROM lifetime (e.g. screenshot at frame 30,
save state, screenshot at frame 60, etc.).

## Going deeper

When `runSource` is too coarse, the long-form workflow:

1. `buildSource({ platform, source })` → get a ROM as base64 bytes
2. `loadMediaBytes({ platform, base64 })` → load without disk I/O
3. `stepFrames({ frames: N })` or `runUntil({ condition })` → advance time
4. `screenshot()` for vibes, `getTile`/`tileFingerprints` for byte-precise work, `readMemory` for game state
5. `setInput` / `pressButton` / `inputSequence` to drive the game
6. `saveState("checkpoint")` / `loadState("checkpoint")` for try/undo

## Build errors

Every build tool returns `issues: [{file, line, col, severity, message, stage}, ...]`. Use that array, not the raw `log`. If `issues` is empty but `ok: false`, fall back to `log`.

**Crash isolation (R12).** Every WASM toolchain call runs in a child worker process. If a tool aborts (`_abort()`, SIGSEGV, OOM), only the worker dies — the MCP server keeps running, all other agent sessions are unaffected, tool registration + save states + playtest windows survive. The build response surfaces as `{ ok: false, stage: "crash", log: "[crash] worker exited unexpectedly — signal=… code=…", crash: { exitCode, signal } }`. Treat `stage: "crash"` as "the toolchain blew up — log the args + source somewhere durable so it can be triaged; you can keep iterating in this session without reconnecting".

## ROM hacking workflow

The full byte-patch loop is six MCP calls, no custom scripts:

```js
identifyRom({ path })                              // 1. what is it?
disassembleRom({ path, startAddress, untilReturn:true })
                                                   // 2. find the target
                                                   //    (auto-tagged reset/nmi/irq labels,
                                                   //     HW register names, file-offset
                                                   //     comments — for NES, BOTH .nes and
                                                   //     prg.bin offsets emitted —
                                                   //     mapper-aware addresses)
assembleSnippet({ cpu, origin, code: "lda #$00\nrts" })
                                                   // 3. encode replacement bytes
writeMemory({ region:"system_ram", offset:0xRAM, hex })
                                                   // 4. VERIFY first — write the value
                                                   //    on the live emulator, watch for
                                                   //    the expected behavior. Cheaper than
                                                   //    a wrong patch.
patchFile({ path, offset, hex, expect: "<current bytes>" })
                                                   // 5. patch with safety check —
                                                   //    refuses if existing bytes differ
diffRoms({ platform, a: original, b: patched })    // 6. verify the patch landed
loadMedia({ platform, path: patched }) → screenshot()  // 7. run it
```

**Finding which CODE wrote a byte.** Static disasm reading is the slow part —
multiple `cmp #$XX` instructions look identical. Don't guess. Two tools, in order
of precision:

- **`findWriter({ address, maxFrames, pressDuring })` — the precise one (NES).**
  Arms a core-level WRITE WATCHPOINT and returns the EXACT writing instruction's
  PC, captured inside the CPU write path — correct even for NMI/IRQ-driven writes
  (the common NES case, where a frame-sampled PC is just the idle loop). This is
  the right tool when you need the actual writer.
  ```js
  findWriter({ address: 0x00CD, maxFrames: 300, pressDuring:[{ frame:30, button:"A" }] })
    → { found:true, pc:"$AF85", value:"0x81", hits:19 }
  disassembleRom({ path, startAddress: 0xAF85 })   // → the real store instruction
  ```
  Supported on **all 12 tier-1 systems** — NES, GB/GBC, Genesis, SMS/GG, SNES,
  Atari 2600/7800, C64, Lynx (65C02), and GBA (ARM7) — every bundled CPU family.
  On a banked mapper a `$8000-$BFFF` pc may be in a switchable bank; findWriter
  reports the `bank` (NES/GB/SMS-GG) so you can pass it to `disassembleRom`.
- **`watchMemory` / `runUntilWrite` — cross-platform, frame-sampled.** Step until
  the byte changes; the returned `pc` is a frame-boundary sample (a lead, not a
  guarantee under interrupts — cross-check the value trace). Use on non-NES, or
  for the value timeline.
- **`snapshotMemory` + `diffMemory` — "which bytes did THIS event touch?"** When
  you don't yet know the address: snapshotMemory before the event, trigger it
  (pressButton/stepFrames), then diffMemory — you get just the changed offsets
  with before/after, no eyeballing two RAM dumps. The fast way to find an area-id
  / phase / flag byte a transition writes. (`diffState` is the coarse
  whole-machine "did anything change?" version.)

```js
runUntilWrite({ region:"system_ram", offset:0x03B6, maxFrames:300,
                pressDuring:[{ frame:30, button:"A" }] })
  → { pc: "$E3AF" (frame-sampled), changes:[{ before:31, after:32 }] }
```

All in the `assets` category except `disassembleRom` (in `debug`).

### Before you hunt — check the cheat database (`gameCheats`)

For a KNOWN commercial ROM, the fastest way to find the byte is to not hunt at
all: the bundled cheat database is a free, crowd-sourced **map of labeled RAM
addresses and code sites**. Call `gameCheats({ path })` FIRST — for a matched
game it returns that game's cheats with the address decoded out of each one:

```js
gameCheats({ path: "Rygar (USA).nes" })
// → { matched:true, confidence:"name", game:"Rygar (USA)", crc32:"...",
//     entries:[
//       { desc:"Infinite Magic Attack", code:"00CD:FF",
//         parts:[{ address:"$00CD", value:"0xFF", kind:"ram" }] },   // ← labeled RAM var
//       { desc:"Infinite Health", code:"SXUZXTSA",
//         parts:[{ address:"$8E20", value:"0xA5", compare:"0x85", kind:"code" }] }, // ← code site
//       ...] }
```

So "which byte holds magic?" is answered in one call: `$00CD`. A RAM cheat
(`kind:"ram"`) is a **labeled variable**; a ROM cheat (`kind:"code"`, has a
`compare`) is a **labeled patch site** — point `disassembleRom` at its address
to read the routine. Filter a long list with `filter:"health"` or `kind:"ram"`.

**Device types are labeled — it's not all "Game Genie."** Each decoded part
carries a `device` so you know exactly what you're looking at:
`game-genie` (NES/Genesis/SNES/GB ROM patches), `pro-action-replay` (SNES — the
most common SNES device, RAM pokes like `7E0DBF63`), `gameshark` (GB RAM),
`action-replay` (SMS/GG), or `raw` (`ADDR:VAL`). A few formats (e.g. the SMS/GG
Game Genie variant) are labeled with their device but left address-undecoded
rather than guessing — honest over wrong.

**Trust it like you trust disasm — verify, don't assume.** A match is by
No-Intro name / filename, NOT a verified CRC, so it's a PROBABLE match: very
likely right, but a different region/revision can use different addresses. The
`note` says so explicitly. Confirm a label before patching — the cheapest
confirmation is to apply it and watch:

```js
applyCheat({ path:"Rygar (USA).nes", desc:"Infinite Magic Attack" })  // enable it live
screenshot()                                                          // see the effect → label confirmed
// or apply a RAW code from anywhere:
applyCheat({ code:"00CD:FF" })          // RAM poke → appliedAs:"ram"
applyCheat({ code:"SXIOPO" })           // Game Genie (core decodes it)
applyCheat({ code:"C06C:0C:26" })       // raw ROM patch → auto-re-encoded to a read-intercept (appliedAs:"rom", reencodedFrom)
clearCheats()                           // remove all
```

**`appliedAs` tells you how it went in** — `"ram"` (per-frame poke), `"rom"` (in-core
read-intercept), `"raw"` (core-decoded device code), or `"rom-unencodable"` (a ROM
address that couldn't be made into a working ROM patch — likely a no-op; add a COMPARE
byte). A raw `ADDR:VAL:COMPARE` on a ROM address would otherwise silently no-op as a RAM
poke, so applyCheat transparently re-encodes it to the platform's ROM-patch device (NES/
Genesis/GB Game Genie, SNES Game Genie — NOT Pro Action Replay, which is RAM). **Boot-time
cheats:** pass `loadMedia({ cheats:[…] })` to apply codes BEFORE frame 0 (iterating on a
boot-seeded value), and use `reset({ hard:true })` for a true power-cycle — plain `reset`
is the RESET button and leaves work RAM (and boot-seeded state) intact.

`applyCheat` is also just **fun** — play any matched game with infinite lives,
invincibility, etc. It is **NON-DESTRUCTIVE**, exactly like RetroArch: the cheat
lives in volatile core state (a per-frame RAM write, or an in-core read-intercept
for ROM cheats), the ROM file on disk is NEVER touched, and `reset` / `loadState`
/ `clearCheats` removes it. **`gameCheats` DB coverage (11/12):** NES, GB/GBC,
SNES, Genesis, SMS/GG, Atari 2600/7800, **Lynx**, **GBA** — every tier-1 system
except **C64** (the cheat database ships no C64 entries, so there's nothing to
look up; `makeCheat` still works on C64). One caveat: **GBA** DB cheats are
Code Breaker / GameShark (encrypted), so they're **apply-only** — the `code`
applies live, but the address isn't descrambled into a labeled map the way the
other systems are (the response says so via `mapNote`). **`applyCheat` /
`makeCheat` work on all 12.** Unmatched ROMs (homebrew, your own WIP, an
unlisted dump) return `matched:false` with a clear reason — the tool never
guesses.

### Creating NEW cheat codes (`makeCheat`)

The inverse of decoding: turn a byte you found into a shareable code — for ANY
ROM, **including your own homebrew/WIP** where no DB entry exists. This closes
the loop with the byte-hunting tools:

```js
runUntilWrite({ region:"system_ram", offset:0xCD })   // 1. find the byte (or use gameCheats)
makeCheat({ platform:"nes", address:0x00CD, value:0xFF })
//   → { raw:"CD:FF", note:"RAM cheat...", ... }            // 2. RAM poke → raw code
// For a ROM/Game-Genie patch, read the current byte and pass it as `compare`:
readMemory({ region:"prg_rom", offset:0x8E20 })          //   (current byte = 0x85)
makeCheat({ platform:"nes", address:0x8E20, value:0xA5, compare:0x85 })
//   → { gameGenie:"SZZAETSA", verified:true, raw:"8E20:A5:85", ... }
applyCheat({ code:"SZZAETSA" }) → screenshot()           // 3. confirm it works
```

`makeCheat` encodes for the platform's NATIVE device(s) and **labels each one**
— NES/Genesis → Game Genie; SNES → Pro Action Replay **and** Game Genie; GB/GBC
→ Game Genie (ROM) + GameShark (RAM); SMS/GG → Action Replay — plus the raw
`ADDR:VAL` always. Each generated code carries `verified:true` (decoded back and
confirmed; the encoders round-trip 100% against the full DB — NES/Genesis/GB/GBC
Game Genie, SNES Game Genie + PAR, GB GameShark). Force a specific device with
`device:`. A RAM cheat needs just `address`+`value`; a ROM patch adds `compare`
(the byte currently there). Nothing is ever written to a ROM file.
**`makeCheat` works on all 12 tier-1 systems** — the systems with no native
letter-code device (Atari 2600/7800, Lynx, GBA, C64) get a verified raw
`ADDR:VAL` code that `applyCheat` passes straight to the core.

```js
makeCheat({ platform:"snes", address:0x7E0DBF, value:0x63 })
//   → { codes:[ {device:"pro-action-replay", code:"7E0DBF63", verified:true},
//               {device:"game-genie", code:"17D8-9EE8", verified:true} ],
//       raw:"7E0DBF:63", ... }
```

### Editing in-game TEXT (font maps)

Games store text as their own tile-index encoding (Excitebike: A=$0A; Mario:
ASCII-offset; FF: sparse). Three tools automate the round-trip instead of
hand-deriving the table:

- **`learnFontMap`** — infer the char→tile-ID map. TWO modes:
  - ROM mode: `knownStrings:[{text, offset}]` when you found the text's bytes.
  - **LIVE mode: `fromScreen:[{text, row, col}]`** — the text is on screen RIGHT
    NOW; reads the tile IDs straight from the live BG map at a tile position. This
    breaks the chicken-and-egg (you'd otherwise need the ROM offset you're
    hunting). Works on every tilemap platform (NES/SNES/Genesis/GB/GBC/SMS/GG/C64);
    `inspectBackgroundMap` shows you where the text sits. (atari2600/7800, lynx,
    gba have no text-tile nametable → use ROM mode.)
- **`findEncodedText({ romPath, text, fontMap })`** — locate the string in the
  ROM. Returns `fileOffset` (.nes), `prgFileOffset` (prg.bin), and a bank-aware
  `cpuAddress` + `bank` (NES/GB/GBC in-bank address, Genesis flat; SNES is
  mapper-dependent → use the offsets) — feed `{startAddress, bank}` to
  `disassembleRom`. Flags a likely length-prefix byte to avoid the classic
  overrun.
- **`encodeTextForRom`** — text + map → bytes, ready for `patchFile`.

```js
learnFontMap({ fromScreen:[{ text:"START", row:13, col:11 }] })   // read tiles off the live screen
findEncodedText({ romPath, text:"MOUNTAIN", fontMap })            // → offsets + bank + context
encodeTextForRom({ text:"NEW TEXT ", fontMap }) → patchFile(...)  // rewrite it
```

**Tools for hacking, by category:**

- `patchFile({path, offset, hex, expect, allowExpand})` — generic byte
  splicer with safety check. THE primitive — every other hack tool
  composes through it. `expect` refuses the write if existing bytes don't
  match, catching the silent corruption when a patch authored against
  region A is applied to region B.
- `assembleSnippet({cpu, origin, code})` — assemble a tiny chunk of asm
  to raw bytes. No header, no linker config, no segments. Supports
  `6502 / 65c02 / 65816 / 68k / z80 / sm83 / gb / gbc / huc6280`.
  Z80 NOTE: sdas dialect requires `#` on immediates (`ld a,#5`, not
  `ld a,5`).
- `diffRoms({platform, a, b})` — mapper-aware ROM diff. Reports CPU
  addresses (NROM-128 mirrors correctly, SNES LoROM banks as `XX:XXXX`),
  per-region tallies (PRG vs CHR vs header), and `tile: N` annotations
  on CHR changes for direct sprite-hack identification.
- `findFreeSpace({path, minLength, fillBytes})` — locate runs of $FF
  or $00 for asm overlays. Sorted longest-first.
- `findReferences({path, platform, address})` — find every instruction
  that references a target address. Classifies refs as
  `call/jump/branch/read/write/use/ref`. Walks the vector table too.
  Limitation: only direct addressing modes; indirect/computed jumps
  not detected.
- `spliceCHR({path, platform, pngBase64, tileIndex, expect, bank, paletteHint})` —
  composition: PNG → tile bytes → splice into CHR at tile slot N.
  Auto-locates iNES CHR base. `expect` checks the existing tile bytes.
  `bank: N` (NES) replaces magic file offsets; `paletteHint:["#RRGGBB",...]`
  gives explicit RGB→palette-index mapping (skips the default quantization
  that requires PNGs with exactly 4 distinct grayscale levels).
- `gameCheats({path, filter, kind})` — match a KNOWN ROM to the bundled
  cheat DB and return THIS game's labeled RAM addresses + code sites
  (decoded from each cheat). The free "which byte holds X?" map. Probable
  match (name/filename, not CRC) — verify before patching.
- `applyCheat({code | desc+path, index, enabled})` /
  `clearCheats()` — apply a cheat to the loaded game LIVE and
  non-destructively (the RetroArch way: volatile core state, ROM file
  never touched). Use a raw `code` or a matched `desc`. Doubles as the
  cheapest way to VERIFY a `gameCheats` label (apply → screenshot), and
  as a fun-bonus (play with infinite lives, etc.).
- `makeCheat({platform, address, value, compare?, style})` — CREATE a new
  cheat code from an address+value (the inverse of decoding). Returns a
  Game Genie letter code + the raw ADDR:VAL, with a `verified` round-trip
  check. Works on any ROM incl. homebrew/WIP. Pair with runUntilWrite/
  gameCheats (find the byte) → makeCheat (encode) → applyCheat (confirm).
- `watchMemory({region, offset, length, frames, pressDuring})` /
  `runUntilWrite({region, offset, maxFrames, pressDuring})` — frame-level
  memory-write trace. Reports every change with PC, so you can map a
  RAM byte back to the writing code path. Cross-platform. The "find
  the byte" half of hacking, mechanized. (Reach for this when a ROM
  ISN'T in the cheat DB, or to find a byte no cheat covers.)
- `whichTilesAreRendered()` — at the current emulator state, walk the
  BG nametable + OAM and return the set of tile IDs actually being
  drawn. Sample at known game states (title / gameplay / menu) and diff
  the sets to map tile IDs to game assets without scanning sheets by eye.
- `extractCart({path, outputDir})` — split ROM into standard parts
  (NES: header.bin/prg.bin/chr.bin; SNES: copier_header + rom + internal
  header; Genesis: vectors/header/body; GB: boot/header/body) plus a
  manifest.json with mapper, mirroring, etc.
- `wrapRomFromParts({platform, ...})` — counterpart to extractCart.
  Emits `wrapperSource` (.s) + `linkerConfig` (cc65 ld65 cfg) ready
  for buildSource. Per-platform templates.
- `disassembleRom` — see "Disassembler" section below for the full
  annotation set.

For graphics swaps specifically:
- `extractSpriteSheet({platform, path, bank, paletteFromEmulator, paletteIndex})`
  from a source game → PNG of its tiles. `bank: N` (NES 4 KB CHR bank
  index) replaces magic file-offset math. `paletteFromEmulator: true`
  + `paletteIndex` colors the export with the live game palette
  (instead of grayscale) — much easier to recognize art and edit in a
  pixel tool.
- `crossPlatformSpriteImport({sourceRom, sourcePlatform, sourceBank,
  sourceTileX/Y/W/H, targetPlatform, outputPng, intent, paletteIndex})`
  — one-call lift of a tile region from a source game's ROM into the
  target platform's tile format. Combines extract + crop + quantize +
  optional manifest. Under `intent:"homebrew"` reads the live source
  palette automatically (same `paletteFromEmulator` semantics as
  `extractSpriteSheet`); under `intent:"rom-hack"` preserves source
  bytes verbatim. Output PNG + manifest feed straight into
  `loadSpriteSheet`.
- `convertImageToTiles({ platform, pngBase64 })` → target-platform tile bytes
- `spliceCHR` to write them into the CHR region of your target ROM
  (handles the convertImageToTiles + patchFile composition in one call)

## Disassembler

`disassembleRom` ships with every annotation enabled by default:

```js
disassembleRom({path, platform:"nes", startAddress:0xC184,
                length:64, untilReturn:true})
// →
//   reset:  sei                  ; C184 78        x  @0x194 (prg @0x184)
//           cld                  ; C185 D8        .  @0x195 (prg @0x185)
//           lda  #$00            ; C186 A9 00     ..  @0x196 (prg @0x186)
//           sta  $2000           ; C188 8D 00 20  ..   @0x198 (prg @0x188) PPUCTRL
//           ldx  #$FF            ; C18B A2 FF     ..  @0x19B (prg @0x18B)
//           ...
```

What you get:
- **Vector labels** (`reset:`, `nmi:`, `irq:`) auto-tagged from the iNES /
  SNES / Genesis vector tables. For SMS/GG, fixed Z80 vectors are tagged:
  `reset:` at $0000, `rst08`/`rst10`/`rst18`/`rst20`/`rst28`/`rst30:` at
  their RST addresses, `irq:` at $0038 (SMS vblank handler), `nmi:` at
  $0066 (pause button). For GB/GBC, the SM83 vectors get the same
  treatment plus the dedicated IRQ vectors: `vblank:` at $0040,
  `lcd_stat:` at $0048, `timer:` at $0050, `serial:` at $0058,
  `joypad:` at $0060, and `entry:` at $0100. `autoLabelVectors:false`
  to turn off.
- **Hardware register names** (`; PPUCTRL`, `; PPUMASK`, `; SND_CHN`,
  `; VRAM`, `; LCDC`, `; VDP_CTRL`, `; IO_PORT_A` etc) on any operand
  that hits a known platform register. NES + SNES + Genesis + GB + SMS/GG
  tables built in. `annotateRegisters:false`.
- **File-offset comments** (`; @0xNNNN`) on every disassembled line —
  mapper-aware, so $C184 on NROM-128 correctly reports `@0x194`. Direct
  input to `patchFile.offset`. For NES iNES files, the header-stripped
  PRG offset is ALSO reported (`@0x194 (prg @0x184)`) so you can patch
  either the `.nes` file or `prg.bin` from extractCart without doing
  the -16 math. `annotateFileOffsets:false` to turn off.
- **Mapper-aware addressing**: NROM-128 mirror at $C000, MMC1/MMC3/UxROM
  top bank fixed at $C000, SMS sega-mapper slot-0/1/2 1:1 file mapping,
  GB/GBC slot 0 fixed + slot 1 banked (pass `bank` to target a non-
  default ROM bank). No more manual `startAddress: 49152` because the
  disassembler understood the mapping.
- **`endAddress` alternative to `length`** — disassemble "from X to Y"
  without computing byte count yourself.
- **`untilReturn: true`** — truncates at the first `rts/rti/rtl/bare jmp`
  (6502) or `ret/reti/retn/bare jp` (Z80) or `ret/reti/bare jp/jp hl`
  (SM83). Combine with an auto-tagged `reset:` label to grab exactly
  one routine.
- **`dataRanges: [{start, length}]`** — mark address ranges as `.byte`
  tables instead of bizarre disassembled "code." Useful for embedded
  sprite tables, music data, lookup tables.
- **`outputPath`** — writes raw asm to disk instead of returning a
  188KB JSON wad. Returns `{outputPath, asmBytes, asmLines}` for log/inspection.

6502-family disassembly runs through cc65's da65 (WASM); Z80 + SM83
disassembly runs through built-in pure-JS decoders with full prefix
coverage (Z80: CB/ED/DD/FD/DDCB/FDCB; SM83: CB only — no ED/DD/FD on GB).
DD/FD/DDCB/FDCB). Annotations are post-processing in both paths.

### Whole-ROM, rebuildable projects — `disassembleProject`

`disassembleRom` gives you one routine as text. `disassembleProject` turns an
**entire ROM into a complete, re-buildable project in one call**, across 11 of
the 12 systems (NES, SNES, GB/GBC, SMS/GG, Genesis, C64, Atari 2600/7800, and
**Lynx** — 65C02, byte-exact). **GBA is the sole exception** (ARM7TDMI has no
bundled disassembler — `platform:'gba'` returns an explicit message pointing to
external ARM tools):

```js
disassembleProject({ path: "game.nes", outputDir: "./game-disasm" })
// → { ok, platform, regions:[{file, startAddress, roundTripOk, readablePercent}],
//     roundTrip:{ allByteExact, failed:[] }, readablePercentAvg }
```

It splits the ROM into regions (per-16KB bank for banked NES, per-32KB bank for
SNES LoROM, slot0+slotX for GB, one flat region for SMS/Genesis/C64/Atari),
disassembles each, then **reassembles it and verifies the result is byte-exact
against the original**. Any line that doesn't reassemble faithfully falls back
to `.byte`/`db` data recovered from the address comments — so the emitted `.asm`
files ALWAYS rebuild to the original bytes (`roundTrip.allByteExact`). The
`readablePercent` per region tells you how much came back as real instructions
vs. data. Each `.asm` carries a provenance + round-trip header and is ready to
edit and rebuild with the platform's native toolchain.

Reassembler per CPU family (all bundled WASM, no installs): **cc65** ca65/ld65
for 6502 + 65816, **sjasm** for Z80, **rgbds** for GB SM83, **vasm** for 68k.

Caveats worth knowing up front:
- **SNES and large Genesis ROMs come back byte-exact but DATA-ONLY**
  (low `readablePercent`). Flat whole-ROM disassembly of a mostly-data image
  heals down to `.byte`; meaningful instruction coverage there needs recursive
  entry-point following, a known follow-up. The bytes are always correct.
- Banked-NES is the strongest case — per-bank regions come back ~100%
  instructions. GB/GBC, SMS/GG, C64, and Atari are also near-100%.
- Platform is sniffed from the file extension; pass `platform:` to override.

## CHR/tile tools — file vs emulator source

`getTile`, `inspectPatternTiles`, `extractSpriteSheet`, `tileFingerprints`,
and `tilesAscii` all accept an optional `path` arg:
- **With `path` set**: reads CHR straight from a file (iNES auto-locates
  CHR; raw `.chr`/`.bin` files read as-is). Use to survey assets BEFORE
  loading. Response reports `source: "file"`.
- **Without `path`**: reads from the running emulator's pattern table /
  VRAM. Response reports `source: "emulator"`.

## Demake / enhance / cross-platform workflow

The full "take game X on platform A, make it on platform B" pipeline:

1. Study source: `loadMedia({ platform: A, path })`, `recordSession`, `disassembleRom`
2. Rip art: `extractSpriteSheet({ platform: A, path })` returns a PNG sheet
3. Recook art: `convertImageToTiles({ platform: B, pngBase64 })` re-encodes in B's tile format and bit depth
4. Write target game: `runSource({ platform: B, source })` for fast iteration
5. Embed converted art: `patchRom` to inject the new CHR/tile bytes

The tile codec handles 4 bit-layouts × 4 bit-depths. NES↔GB is byte-exact at 2bpp. Going up in bit depth (NES→SNES) gains palette headroom. Going down (Genesis→GB) requires color quantization that the codec does automatically.

### Lifting a CHARACTER (not a rectangular tile region) — use meta-sprite capture

`extractSpriteSheet` / `cropSpriteSheet` / `crossPlatformSpriteImport` work on **rectangular tile-grid regions**. That is the WRONG model for a real character, which is built from **multiple independent hardware sprites** (OAM/SAT entries), each with its own position, size, tile index, palette, flips, priority, and a non-contiguous tile range. Cropping a screenshot or a tile sheet looks right and then renders as garbage in-game because the hardware multi-cell tile order differs per platform (Genesis is column-major; SNES large OBJ + NES/GB 8×16 are their own orders). The meta-sprite tools handle all of it. Works on **genesis, snes, nes, gb, gbc, sms, gg** (C64 MOBs are 24×21 bitmaps, not tiles — not supported):

1. `loadMedia` → step / press to a frame where the character is fully on screen (NOT a menu — if no sprites are up, captures come back empty).
2. `groupVisibleSprites({platform})` → clusters on-screen OAM/SAT entries into objects, largest-first (usually the player). Pick a group's `slots`.
3. `captureMetaSprite({platform, slots:[...] /* or rect:{x,y,w,h} */, name:"enemy", emit:"both", outputDir:"..."})` → writes `tiles.bin`, `palette.bin`/`.json`, `layout.json`, `preview.png` (re-rendered from the EXPORTED data, not a screenshot crop), and a platform-idiomatic `<name>.h`. Hardware tile order is preserved per platform.
4. Inspect `preview.png`. Re-verify any time with `renderMetaSpritePreview({tilesPath, layoutPath})` — no rebuild needed.
5. Include `<name>.h` (Genesis → SGDK `_draw()` helper; NES/GB → shadow-OAM cell table; SNES → oamSet pieces; SMS → SAT cells) — or get it later via `emitMetaSpriteRenderer`. Build with `runSource`.

This keeps the lifted asset faithful to the source ROM's hardware composition instead of the lossy crop-the-screenshot fallback.

## Visual vs programmatic inspection

You have two modes. Pick per task:

**Image mode** — `screenshot`, `inspectPatternTiles`, `inspectBackgroundMap({ render: true })`, `inspectPalette`. Returns PNGs. Best for aesthetic judgment ("does this look right?", "did the explosion play?").

**Text mode** — `getTile`, `tilesAscii`, `tileFingerprints`, `readMemory`. Returns structured data or ASCII art. Best for precise comparison ("is this tile blank?", "did $00F4 change between frame 60 and 90?", "find all tiles whose hash matches X").

Both work fine. Image mode is more flexible but burns more tokens per call. Use text mode for scans and diffs, image mode for "does this look like Mario?" questions.

## NES-specific (most common platform)

Patched fceumm exposes extra memory regions beyond the libretro standard:

| Region            | Contents                                       |
| ----------------- | ---------------------------------------------- |
| `system_ram`      | 2KB CPU RAM ($0000-$07FF)                      |
| `nes_chr`         | 8KB CHR (gathered from VPage[0..7]; R59 fixed an off-by-page-offset bug that returned zeros for offsets >= 4096 — if you see CHR uploads "fail" only above 4 KB, you're on a pre-R59 build) |
| `nes_nametables`  | 2KB CIRAM (background tile maps)               |
| `nes_palette`     | 32 bytes ($3F00-$3F1F)                         |
| `nes_oam`         | 256 bytes sprite list (64 sprites × 4 bytes)   |

OAM format: bytes per sprite are `[y, tileIndex, attributes, x]`.

`inspectBackgroundMap({ render: true })` composites the active CHR + nametable + palette into a real 256×240 PNG — what the BG layer would look like even if rendering is currently disabled.

## Save-state semantics

`saveState(name)` / `loadState(name)` slots are **in-memory** and discarded on `shutdown` or new media. To persist a state across sessions:
- `saveState({ path })` writes the CURRENT live host to a file directly.
- `exportState({ fromSlot, path })` copies an EXISTING in-memory slot (e.g. one the human saved with a playtest emulator-hotkey — it appears in `listStates`) to a file **without disturbing the live host** (no pause/resume needed). Reload either with `loadState({ path })`.

`loadState` removes any active cheats (a save-state blob doesn't carry frontend cheat state) and reports `cheatsCleared`. `reset()` resets the frame counter + core state (and clears cheats) but keeps the loaded ROM.

## Project scaffolding

Three shapes, pick the one that matches what you're doing:

- **`createProject({ platform, name, path, template? })`** — writes a starter directory: `main.{c,asm,s}` (from `examples/<platform>/templates/`) + every runtime file the template depends on (headers, crt0, linker .cfg) + README + `.gitignore`. Self-contained: take it elsewhere and rebuild with stock cc65/sdcc, no romdev install needed. Defaults to `template:"default"` (smallest visible-and-runnable program); most tier-1 platforms also have `hello_sprite` + `tile_engine` + the 5 genre templates.

- **`createProject({ ..., withSnippets: true })`** — same as above, **plus** drops every vetted starter snippet for the platform alongside main.c. Use when you want "main.c + every helper file ready to edit" in one shot, without picking a genre. Snippets that overlap with the template's runtime are skipped (no double-writes). Response includes `snippetsCopied: string[]`.

- **`createGame({ platform, genre })`** — genre-shaped scaffold (`shmup` / `platformer` / `puzzle` / `sports` / `racing`). Higher-level than createProject — picks the right template + runtime + crt0 + linker config for the genre. Available on **NES, GB, GBC, SNES, Genesis, SMS, GG, C64, GBA, Lynx, Atari 7800** — i.e. every platform that has genre templates. Availability is derived from the registered templates (not a hardcoded list), so the error message for an unsupported platform always names the current set; Atari 2600 (asm-only) + MSX + ColecoVision (bring-up only) have no genre scaffolds and are rejected. Ships a complete working ROM with state machine + sprite allocation + sound wired — fill in gameplay logic on top. **Want a side-scroller? Use `genre:"platformer"`** — and on every platform EXCEPT NES the scaffold already side-scrolls: a hardware camera follows the player (SCX/$D016/R8/BG?HOFS/REG_BG?HOFS/bgSetScroll depending on platform), with software tile-column streaming where the world is wider than one nametable/plane. NES is still single-screen (platforms drawn as sprites); to make it scroll, draw platforms into the background nametables + `ppu_scroll(camX,0)` (it flips the PPUCTRL nametable-select bit past 256 px) + stream columns past 512 px. Each platformer's `describe` text gives the per-platform specifics; the scroll-register details live in the platform's MENTAL_MODEL.md "Horizontal scrolling" section.

Then iterate with `runSource` against the source you read from `path/main.*`.

## Symbol-aware debugging

**cc65 targets (NES, C64, Atari 5200/7800, Lynx) — full pipeline:**

```js
buildSourceWithDebug({ platform, source })  // returns binary + .dbg
resolveSymbol({ dbg, name: "score" })        // → 0x0072
lookupAddress({ dbg, address: 0x8042 })      // → "main + 14"
listSymbols({ dbg })                         // full memory map
```

cc65 prepends `_` to C identifiers: C `score` → asm `_score`. `resolveSymbol` tries both spellings.

**SDCC targets (GB, GBC, SMS, GG, MSX, Coleco, ZXSpectrum) — partial pipeline (R54):**

```js
buildSourceWithDebug({ platform: "gb", source })
  // returns { ok, toolchain:"sdcc", binaryBase64, mapText, mapHint, ... }
```

You get `mapText` (the sdld link map). `resolveSymbol`/`lookupAddress`/`getMemoryMap` don't parse it yet (queued). For now grep `mapText` directly — every static + global is on a line of the form `AAAAAAAA  _symbol_name  _source_unit` where AAAAAAAA is the absolute hex address. The response's `mapHint` field includes a ready-to-use regex. C identifiers get a leading underscore in the map; asm symbols don't. Example:

```js
const { mapText } = JSON.parse(r.content[0].text);
const m = mapText.match(/^\s*([0-9A-F]+)\s+_score\b/m);
const addr = m ? parseInt(m[1], 16) : null;  // e.g. 0xC100
```

## Playtest mode (optional)

`playtest({ scale: 3 })` opens a real SDL window for a human to play the loaded ROM with a keyboard or USB controller. It **returns immediately** — the render loop runs in the background and you keep using every other tool against the same live host (so `runSource`/`loadMedia` rebuilds update the window in place; it does not relaunch or crash on rebuild). Close it with `playtestStop` (or the human pressing ESC / Select+Start). Needs a desktop display *and* the optional `@kmamal/sdl` dep; with neither it returns `{opened:false, reason:...}` and the rest of the server keeps working headless. Use this when the human wants to feel the game, not when you want to test it (for your own checks, use `screenshot` — it reads the same live host the window shows). `playtestStatus` reports liveness + the window's media/frame; `playtestFramebuffer` captures exactly what the human sees.

**Windows are PER SESSION.** The server is multi-session (several agents, or a user with 2-3 games open at once); each session gets its OWN window — opening one never disturbs another agent's, `playtestStop` closes only yours, and a session disconnecting tears down just its own window. **Aspect:** the window defaults to `aspect:"tv"` (the 4:3 / native-LCD shape the game was authored for) with nearest-neighbor scaling, so it looks like real hardware and stays crisp + correct aspect when the human resizes it; pass `aspect:"fb"` for raw square-pixel dev geometry.

## Common gotchas

- **CHR-RAM vs CHR-ROM**: Most NES homebrew uses CHR-RAM. CHR tools (`getTile`, `inspectPatternTiles`, `tileFingerprints`, `tilesAscii`, `extractSpriteSheet`) all accept an optional `path` arg — pass it to read CHR from the iNES file (CHR-ROM carts), omit to read live CHR-RAM from the running emulator. Response always reports `source: "file" | "emulator"`. NES homebrew built with `linkerConfig:"chr-ram"` has no CHR in the file — must read from the emulator after upload.
- **Mapper-aware addressing**: NES NROM 16KB carts mirror PRG at $8000 and $C000 (`disassembleRom` reports the canonical $C000+ addresses since that's where the reset vector points). Banked mappers (MMC1/MMC3/UxROM) have the top 16KB fixed at $C000 with bank 0 at $8000 by default — pass a startAddress in the right range to disassemble a different bank.
- **C64 isn't a console**: media is `.prg` / `.d64` / `.t64`, not "ROM". `loadMedia` takes a `mediaKind` arg; auto-defaults are usually right.
- **Atari 5200 build works but doesn't run**: cc65 produces .a52 files, but our atari800 core needs Asyncify which isn't yet wired into the host. Use Atari 7800 or Lynx if you want a 6502 platform that actually runs.
- **Genesis BG init**: a freshly-booted Genesis ROM shows a black screen for many frames because VDP init is slow. Step 60+ frames before screenshotting.
- **`framesRun` is monotonic**: `loadState` restores the core but doesn't roll back our frame counter. Use it for state, not for "what frame am I on" precision.

## Before writing input or memory-layout code

Two tools that save real time and frustration:

- `getInputLayout({ platform })` — returns the platform's controller protocol, bit order, libretro id mapping, AND which buttons physically exist. Read this before writing an asm `read_pad` routine OR before designing controls (so you don't bind to a button the platform doesn't have).
- `getMemoryMap({ dbg, platform })` — after `buildSourceWithDebug`, returns where every variable in your source actually landed in memory, grouped by region (zeropage / system RAM / code / data). cc65 reserves the first 2 zeropage bytes for its runtime; your first `.res 1` lands at `$02`, not `$00`. Don't guess.

## Cross-platform inputs

`setInput` accepts an Xbox-shaped controller: D-pad, 4 face buttons (use `north/east/south/west` for portable code — they translate per platform), shoulders (`l/r`), triggers (`l2/r2`), sticks (`l3/r3`), plus `start`/`select`. Older platforms are subsets — `getInputLayout` tells you which buttons are real. Pressing a non-existent button is a silent no-op.

## Starter snippets

`starterSnippets({ platform })` (default `mode:'list'`) and `starterSnippets({ platform, mode:'get', name })` give you vetted boilerplate — reset routine, `read_pad`, OAM DMA, palette upload, nametable clear. Each snippet's comments encode foot-guns prior agent sessions already hit. Always check what's available for your platform before writing platform-specific boilerplate from scratch. NES, SNES, SMS, GG, GB/GBC, Genesis, GBA, C64, Atari 7800 all have substantial snippet libraries.

**Three ways to actually use them:**

- `starterSnippets({platform, mode:'get', name})` — one snippet's contents, returned as a string.
- `starterSnippets({platform, mode:'getAll', language?})` — every snippet joined into one string. Useful for **reading**; the giant blob lands in your context (or pass `outputPath` to write it to disk instead).
- **`copyStarterSnippets({platform, destinationDir, language?, include?})`** — writes every snippet (or a filtered subset) straight to disk. **Bytes never pass through your context.** Use this when you're scaffolding into a project dir. Flattens `lib/<lang>/foo.c` → `<destinationDir>/foo.c`. Optional `include: ["vdp_init", "joypad_read"]` whitelist for cherry-picking. Default `overwrite: true` (vetted boilerplate is meant to be regenerated).

Or skip the separate call entirely: `createProject({withSnippets: true})` does the same thing as a one-shot.

## Don't burn your own context with binary data

The biggest mistake agents make on this server is reading binary files into their own context just to forward them to a tool. Don't. Every tool that consumes large binary inputs accepts paths:

- `loadMedia({ platform, path })` instead of `loadMediaBytes({ base64 })`
- `buildSource({ sourcePath, binaryIncludePaths, includePaths, outputPath })` — paths in AND a path back out (`binaryPath`). Inline base64 only on opt-in `inline: true`.
- `imageToTilemap({ platform, pngPath, outputDir })` — full-screen PNG → deduped tiles + tilemap + palette, input from disk, output to disk. **This is the tool for splash/title screens** (see the splash-screen section below). Supported: nes, snes, genesis, sms, gg, gb, gbc, c64.
- `screenshot({ path })` — writes PNG to disk, skips inline payload. For a quick "did it change?" sanity check, add `scale: 0.5` (nearest-neighbor, pixel-art-safe) — ~75% fewer image tokens; reserve full resolution for when you actually need pixel detail.
- `extractSpriteSheet({ outputPath })` — same
- `pcmToBrr({ pcmPath, outputPath })` — same

When a tool has `path` and `base64` variants, prefer `path`. The server runs on the same machine; both sides share the filesystem. There's no reason to round-trip 50KB of base64 through your prompt.

## Art-first workflow (user does the pixel art, agent wires the ROM)

For users who'd rather paint sprites in LibreSprite than write tile bytes by hand, four asset-loader tools parse FOSS editor outputs directly into platform-native tile data — no `convertImageToTiles` + ImageMagick chain, no installs beyond the editor itself.

- **`loadAsepriteSheet({ path, platform, outputDir })`** — parse `.ase` (LibreSprite, GPLv2 fork of Aseprite). Returns deduped `tile_bytes` + named `tiles[sliceName] = { tile_indices, width_tiles, height_tiles }` + `tags[name] = { from, to, delays_ms[] }` for animations. Indexed-mode .ase preserves the artist's palette; RGBA mode falls back to platform-master nearest-neighbour. The artist names their slices ("player_idle", "chalice") → game code references the same names. **The killer DX feature** for art-led projects.

- **`loadTilemap({ path, platform, outputDir })`** — parse Tiled `.tmj` (BSD, the de facto FOSS level editor; export as JSON, not XML `.tmx`). Returns per-layer `data` blob + `empty_mask` bitfield (so "no tile" stays distinguishable from "tile 0") + `object_layers[name]` with named placements (player_start, doors, chests) and arbitrary key/value properties. **Multi-layer + object support** means the artist owns level design end-to-end, including spawn data.

- **`loadGifAnimation({ path, platform, outputDir, frame_indices? })`** — extract frames + delays from any GIF. Every editor exports GIF; this is the universal animation pipeline. omggif under the hood — no native deps. Caveat: doesn't apply GIF disposal, so export with `Disposal: Replace` for full-frame anims.

- **`loadSpriteSheet({ pngPath, manifestPath, platform, outputDir })`** — TexturePacker-style PNG+JSON. LibreSprite's `Export Sprite Sheet → JSON-Hash` writes this directly. Supports `meta.frameTags` for animation grouping.

**Palette interop:**

- `getPlatformPalettePng({ platform, format: "png" | "lospec" | "hex", outputPath? })` — `"png"` is the swatch sheet for `-remap` dithering (existing behavior). `"lospec"` returns `{name, author, colors:[hex_no_hash]}` for direct LibreSprite/lospec.com import. `"hex"` returns one `#RRGGBB` per line — universal interchange.

- `convertImageToTiles` now validates the input PNG against the platform's master palette (PLTE for indexed PNGs, distinct-RGB scan for truecolor) with ±8/channel tolerance and surfaces colors-outside-gamut as `warnings[]`. Doesn't throw — silent color shift was the most common newbie failure; now it's loud.

**Workflow walkthrough** + canonical glue code: [`examples/art-first-workflow/README.md`](examples/art-first-workflow/README.md). Six-step path from picking a Lospec palette through `loadAsepriteSheet` + `loadTilemap` to a working ROM.

For repeated builds in an iteration loop, this compounds: a 256KB SNES ROM in 20 build cycles = 7 MB of base64 text accumulated in your context. Paths cost ~60 bytes per call.

## Splash / title / full-screen background images — USE `imageToTilemap`, do NOT hand-roll

If you want a full-screen picture (a splash screen, title card, cutscene still, status panel), there is exactly ONE correct path. **Do not write your own PNG→tile loop** — packing 4bpp/2bpp bitplanes, deduping tiles, assigning palette lines, and building the name-table entry words by hand is fiddly and the failure mode is ugly: the image comes out with the right *shapes* but wrong colors (everything one color) and vertical striping/choppiness. That means your tile bytes were raw RGB-ish values instead of palette indices, or the bit packing/row stride was off.

The correct workflow (all platforms with a tilemap — nes, snes, **genesis**, sms, gg, gb, gbc, c64):

1. **Size the source** to the platform's screen: Genesis **320×224**, NES/SNES/SMS 256×224/256×192, GB 160×144, C64 320×200.
2. **Quantize to the platform palette** so colors land on hardware-displayable values:
   ```
   getPlatformPalettePng({ platform:"genesis", format:"png", outputPath:"/tmp/pal.png" })
   magick splash.png -dither FloydSteinberg -remap /tmp/pal.png splash_q.png
   ```
3. **Convert in one call:**
   ```
   imageToTilemap({ platform:"genesis", pngPath:"splash_q.png", outputDir:"out/" })
   ```
   You get `out/chr.bin` (deduped tiles), `out/nametable.bin` (tilemap entries), `out/palette.bin`, and `out/preview.png`. **Look at `preview.png`** — it's the tool re-rendering its own output, so if the preview is correct your in-game result will be too. If the preview is wrong, the input PNG is the problem, not the encode.
4. **Wire it in:** DMA `chr.bin` to VRAM, load `palette.bin` into CRAM/CGRAM, write `nametable.bin` to your BG plane base. The response `note` tells you the exact sizes + where each blob goes per platform.

Genesis specifics: 4bpp tiles (32 B each), **40×28 cells**, up to **4 palette lines of 16 colors** — `imageToTilemap` bin-packs your image's colors across the lines and picks the right line per 8×8 cell automatically. Name-table entries are 16-bit big-endian. Set your Plane A width to 64 cells. The response's `genesis.warnings[]` flags any 8×8 cell that needs >16 colors (the VDP's hard limit) — if you see those, the source art has too many colors crammed into one cell; re-author or accept the approximation.

If a platform genuinely lacks a tilemap (Atari 2600 races the beam; 7800 uses display lists) `imageToTilemap` throws with an explanation — those need hand-authored per-scanline data, there is no automated path.

## Known toolchain landmines

A few platform-tool quirks worth knowing up front:

- **asar (SNES) silent fails** on certain idioms: `$ - label` size expressions crash with a heap-pointer exit code (use `end_label - start_label` instead). Some opcode + operand arithmetic like `STA SYMBOL + N` where SYMBOL is `=`-defined also crashes silently — our preflight catches the common cases. When `ok: false, issues: []`, the wrapper now synthesizes a fallback issue with a hint.
- **asar bank-border-crossed** can happen if your `org` + `dw` runs past $00FFFF. Native vectors are at $FFE4-$FFEE; emulation vectors at $FFF4-$FFFF. Use `starterSnippets({ platform: "snes", mode: "get", name: "lorom_header.asm" })` for the layout.
- **cc65 (NES, C64, etc.) zero page** starts at $02. cc65 reserves $00-$01 for its runtime. Your first `.res 1` lands at $02, not $00. Use `getMemoryMap` after `buildSourceWithDebug` to confirm.
- **NES pattern table cap = 256 tiles per nametable**. The tilemap index is 8-bit, so per-frame BG can use at most 256 unique tiles per pattern table. Auto-converting a busy illustration usually overflows. `imageToTilemap` warns; the only workaround is mid-frame CHR bank switching (MMC3-class mapper).
- **NES + GB/GBC turnkey** (R9/R10 self-contained + sound, 2026-05-25): use `createProject({platform, template, name, path})` to scaffold a project. The pipeline copies every file the template depends on — `{nes,gb}_runtime.{h,c}`, `gb_hardware.h`, custom `crt0.s`, linker `.cfg`, `patch-header.js` (GB) — into the project directory alongside `main.c`. **No auto-injection at build time.** The build pipeline compiles exactly what you tell it via `sources` / `sourcesPaths` / `includes` / `includePaths` / `crt0` / `crt0Path` / `linkerConfig` / `codeLoc`. Take the project elsewhere with stock cc65/sdcc and it builds the same way. The runtime APIs include sprites, BG, input, AND **sound** — `sound_init` / `sound_play_tone(channel, period, vol, length)` / `sound_play_noise` / `sound_off`. NES drives pulse1+pulse2+triangle+noise via $4000-$400F + $4015; GB drives the 4-channel APU via NR10-NR52. SFX-grade, fire-and-forget — for full music tracks, drop in famitone2 (NES) or your own driver. Templates: `default` (palette cycle), `hello_sprite` (sprite + d-pad + **beep on A press**), `tile_engine` (multi-room tile map). Docs: [`src/platforms/nes/MENTAL_MODEL.md`](src/platforms/nes/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/nes/TROUBLESHOOTING.md); [`src/platforms/gb/MENTAL_MODEL.md`](src/platforms/gb/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/gb/TROUBLESHOOTING.md). **Game-loop order matters on NES:** stage `oam_clear`+`oam_spr` BEFORE `ppu_wait_nmi`, not after — the NMI handler DMA's whatever shadow_oam contains at vblank-start. **GB ROM header:** both asm and C builds now auto-run `rgbfix` inside `buildSource`, so the Nintendo logo + checksums + CGB flag are correct out of the box — no manual `patchGbHeader` step needed.
- **Game Boy / GBC silent-failure footguns** (R54 cleanup, full detail in `getPlatformDoc({platform:"gb"|"gbc", name:"mental_model"})`):
  - **The bundled `gb_crt0.s` is now actually linked.** Pre-r54 a fundamental bug in `buildZ80C` was shipping the raw .s text to sdld as if pre-assembled — sdld silently rejected it and fell back to SDCC's stock sm83 crt0 (no GB cart boot, no IRQ vectors). Map showed no `init` symbol, $0000 was $FF, $0100 was $FF. Every GB ROM ran on stock crt0 invisibly. Fixed by auto-detecting .s source vs .rel object and running it through sdasgb first. Post-fix: `init` at $0150, entry $0100 = `00 c3 50 01` (nop; jp $0150), reset vector $0000 = $C9. **This was the root cause for #14 audio AND part of why every previous "runtime should work OOTB" round still felt friction-heavy.**
  - **GB/GBC C builds now auto-fix the header at build time** (rgbfix runs inside `buildSource`): Nintendo logo at $0104, header checksum at $014D, global checksum, and the CGB flag at $0143 ($00 for `.gb`, $C0 for `.gbc`). You no longer need to call `patchGbHeader` manually — the ROM `buildSource` hands back boots on real hardware as-is. `patchGbHeader({path})` still exists if you want to override title / cart type / RAM size / etc. on an existing file.
  - **`shadow_oam` is pinned at $C100** in the bundled `gb_runtime.c` via `__at(0xC100)`. OAM DMA reads ONLY the high byte and copies 160 bytes from `$XX00` — a plain `uint8_t my_oam[160]` may land at $C017 and DMA garbage. If you roll your own OAM buffer, pick an address with `0x00` low byte (e.g. $C200) and pass it directly to `oam_dma_copy`.
  - **Call `enable_vblank_irq()` once at boot.** Without it, `wait_vblank()` busy-polls `LY` which updates only at WASM stepFrames quantum boundaries → game loop runs at ~1/30 intended speed on the emulator. After enable, `wait_vblank()` compiles to `HALT` + vblank IRQ wake (~10 cycles per frame).
  - **Use `memcpy_vram(dst, src, n)` for VRAM bulk writes**, NOT raw `(uint8_t*)0x8000` casts — SDCC sm83 may elide the latter as dead code. The bundled `gb_hardware.h` declares every $FFxx register as `volatile`-typed so direct writes like `BGP = 0xE4;` are fine; the hazard is only on cast-through-pointer block copies.
  - **`inspectBackgroundMap({platform:"gb"})` now renders a 256×256 PNG of the BG plane.** Pass `which: 1` for $9C00 map base, `window: true` to render the Window map instead. Returns `mapBase` + `mode` + `scy/scx` so you can see where the visible 160×144 region falls.
  - **`readMemory({region:"video_ram"})` doesn't work on GB** — gambatte exposes VRAM as `gb_vram` (not the generic libretro id). r54 errors now suggest this directly. Also: `gb_oam`, `gb_io`, `gb_hram`, `gb_bgpdata`, `gb_objpdata`, `gb_cpu_regs`. `inspectPatternTiles` / `inspectBackgroundMap` / `inspectSprites` abstract over this.
- **SMS / Game Gear VDP footguns** (R53 cleanup, full detail in `getPlatformDoc({platform:"gg"|"sms", name:"mental_model"})`):
  - **8 sprites per scanline** is a hard VDP limit. Extra sprites on the same Y row silently drop — symptom: "first 8 letters of CATCH THE COIN render, rest vanish." Split text across multiple Y rows OR draw it via the BG name table (no per-line limit).
  - **GG OAM coords are hardware-space, NOT visible-space.** The libretro screenshot returns the 160×144 visible region but OAM bytes are still 256×192 hw-coord. Visible region = OAM x∈[48,207], y∈[24,167]. `inspectSprites` reports hardware coords too.
  - **SAT $D0 is the renderer terminator.** R53 fixed `sms_sprite_init` / `gg_sprite_init` so they no longer fill Y with $D0 (they use $E0 now — off-screen but not the terminator). You only hit the trap if you write $D0 yourself; if sprites past a given slot are missing in `inspectSprites`, that's still the diagnosis.
  - **R6 = 0xFB → sprite tiles at $0000**, not $2000 (older comments lied — fixed). Bit 2 SET = $2000, CLEAR = $0000. Trust `inspectSprites`' `spriteTileDataBase` field over comments.
- **SNES CHR/tilemap can overlap in VRAM** if you put them carelessly. CHR starts at word $0000; if your CHR is 16KB the tilemap can't be at word $2000. Put tilemap at word $4000 or later when your CHR is big.
- **SNES audio is a separate ROM build** — the Sony SPC700 coprocessor handles all sound; the main 65816 can only upload a driver + samples then send commands. Workflow: write your SPC driver in `arch spc700` .asm, `buildSource({platform:"spc700", source})` to flat raw bytes, then `.incbin` the result into your main 65816 .asm + write the $BBAA handshake at $2140-$2143 to upload it. `pcmToBrr({pcmPath, outputPath})` encodes 16-bit PCM into the SNES BRR format the SPC needs. See `src/platforms/snes/lib/audio_pipeline.asm` for the protocol overview, and the SPC driver bundled into any SNES game project scaffolded with a sound genre.
- **All SDCC-built platforms (GB, GBC, SMS, GG, MSX, ColecoVision)** share a few SDCC-sm83 / -z80 quirks. The detailed reference is [`src/platforms/gb/lib/c/SDCC_GOTCHAS.md`](src/platforms/gb/lib/c/SDCC_GOTCHAS.md).
  **2026-05-25: The "for-loop + function-call crash family" (`dbuf_append_str NULL` assertion) is FIXED.** It was emscripten's default 64 KB stack overflowing the static `sm83_regs[]` table at runtime — not a SDCC codegen bug. Fixed by adding `-s STACK_SIZE=8388608` to `scripts/_lib.sh`. Patterns #1..#10 / #37 / #38 / #39 from previous agent notes all compile cleanly now. You don't need `unroll.h`, you don't need to split files into ≤200-line TUs, you don't need array-of-structs refactors. Write the natural code.
  **C89-only.** SDCC sm83 is C89. No inline `for (int i = 0; ...)`, no mid-block declarations, no compound literals. SDCC's syntax-error line is usually wrong (points at the FIRST decl after non-decl code); use the linter's line numbers instead.
  **Pre-flight linter:** `buildSource` runs a syntax scan before invoking SDCC. C89 violations show up in `issues[]` with `stage: "lint"` and a `ref:` pointing at the right GOTCHAS section. Pass `lint:"strict"` to fail the build on any lint hit; default is advisory. **The linter reports EVERY mid-block decl in a block**, ordinal-tagged (`#2`, `#3` etc.) so a subtle earlier decl doesn't silence the obvious later one (R53 fix). If a flagged line doesn't look like a decl to you, double-check: typedef'd names ending in `_t`, plus `struct`/`union`/`enum` declarations, all count.
  **Multi-TU still helps iteration speed** (`sourcesPaths: {"main.c":..., "render.c":...}`): smaller TUs rebuild faster, easier to navigate. When a multi-TU build fails, the response includes `failedTU` + `compiledOK` so you know exactly which file to bisect.
  SMS/GG: `createProject({platform:"sms"|"gg"})` ships `sms_crt0.s` / `gg_crt0.s` into the project automatically — these crt0s give a proper cartridge reset vector + IM 1 + stack setup before calling `main()`. SDCC's stock z80 crt0 traps `rst $08` and any VDP-touching code hangs at PC=$0007, so the bundled crt0 is mandatory for real-hardware boot. GB/GBC: see the NES + GB/GBC self-contained-project bullet above.

## Session continuity — REUSE YOUR SESSION

**MCP sessions on romdev do NOT expire.** They are persistent for
the lifetime of the server process — which is hours/days, not minutes.
If you call `initialize` ONCE at conversation start, that same session
key works for every subsequent tool call all session long.

**DO NOT** call `initialize` again "just to be safe," "because the
session might have timed out," or "because it's been a few minutes."
None of those things happen here. Creating a fresh session every few
tool calls loses every category you loaded (you'd have to re-call
`loadCategory` for each one) and breaks the per-session emulator state
(loaded ROM, save states, scroll position, etc. live PER session).

You ONLY need to re-initialize in TWO cases:

1. **Server restart.** You'll see HTTP 404 with "unknown session id"
   on your next tool call. Send `initialize` once, then re-load any
   categories you were using. You can confirm a restart by checking
   the server's process lifetime — but really, just react to the 404
   when it happens; don't preemptively reconnect.

2. **`Mcp-Session-Id` header missing from your tool call.** If
   somehow your client lost the session ID, you'll get an explicit
   error pointing you at re-initialize. The header is sticky in
   normal MCP client usage; you won't lose it without something going
   wrong on the client side.

**Known historical friction (acknowledged 2026-05-25, since fixed):**
real-world agents previously reported losing connections ~30% of long
sessions. Server-side persistence is stable now. If you DO observe a
session drop without a server restart, open an issue at
https://github.com/monteslu/romdev/issues with the timing — it's a
regression we want to catch.

**Anti-pattern to AVOID:** opening a new session before every "block"
of work. This is almost always wrong, costs you all your `loadCategory`
state, and bloats the server's session table. One session per
conversation, end of story.

## When in doubt

`listPlatforms` for capabilities. `getStatus` for what's currently loaded. `listToolchains` for build tools. `listStates` for save slots. Tools are introspectable; you don't have to remember the matrix.
