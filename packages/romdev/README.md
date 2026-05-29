# rom-dev-mcp

**A turnkey vibe-coding platform for retro homebrew games.** One command and an agent can make real working ROMs for NES, SNES, Game Boy, Genesis, Atari, Commodore 64, and more. No SDK installs. No emulator setup. No PATH fiddling. No "this only works on Linux."

```
npx rom-dev
```

That's the whole setup. Everything — emulator cores, assemblers, C compilers, starter libraries, example projects, hardware reference docs — ships as bundled WebAssembly and data inside the npm package. Same on Linux, Windows, macOS, and any other Node 24+ host.

Yes, it's a large package. That's the point. We trade bandwidth (once, at install) for **zero ongoing setup friction** — no PATH fiddling, no SDK installers, no "follow these 12 steps for your OS first." A game director with an idea should not be reading installation docs.

> **Status:** v1 — 13 tier-1 platforms working end-to-end with idiomatic C SDKs, **5 genre scaffolds + a `music_demo`** (shmup / platformer / puzzle / sports / racing + music_demo via the platform's de-facto music engine), per-platform `MENTAL_MODEL.md` + `TROUBLESHOOTING.md` docs (readable via `getPlatformDoc`), and debug helpers (`ppu.js` / `vdp.js` / `maria.js` / `tia.js`).
>
> **Tier-1 ship matrix — every platform has a working core + ≥5 genre scaffolds + sound + music + per-platform docs:**
>
> | Platform | Core | Sound API | Music engine |
> |---|---|---|---|
> | NES | fceumm | `sound_play_tone/noise` (APU) | FamiTone2 (Shiru, public domain) |
> | GB | gambatte | `sound_play_tone/noise` (DMG APU) | hUGEDriver (MIT) |
> | GBC | gambatte (CGB mode) | `sound_play_tone/noise` + BCPS/BCPD color | hUGEDriver (MIT) |
> | SNES | snes9x | `sfx_play(cmd)` (SPC700 + BRR samples) | SPC700 music engine (extends sfx driver) |
> | Genesis | genesis_plus_gx | `sfx_*` PSG wrapper + R30 PSG sfx | XGM2 via SGDK |
> | GBA | mGBA | `sfx_*` libtonc + R28 sfx wrapper | maxmod + CC0 chiptune.xm soundbank |
> | SMS | genesis_plus_gx | `sfx_*` SN76489 PSG via port $7F | 3-voice PSG tracker |
> | GG | genesis_plus_gx | `sfx_*` (same PSG as SMS) | 1-voice PSG tracker on ch 2 |
> | C64 | vice_x64 | `sfx_*` SID with ADSR | 3-voice SID sequencer |
> | Lynx | handy | `sfx_*` MIKEY 4-voice LFSR | cc65 `lynx_snd_play` engine |
> | Atari 2600 | stella2014 | (asm-only) | 2-voice 6507 asm chiptune |
> | Atari 7800 | prosystem | `sfx_*` TIA audio | 2-voice TIA tracker |
> | ColecoVision / MSX | gearcoleco / fmsx | bring-up only — `default` template, no genre scaffolds | — |
>
> **Atari 5200** + **ZX Spectrum** are delisted (cores reject custom carts/tapes in headless mode — toolchain works, core-side investigation pending). `playtest()` opens a live SDL window with hot-plug USB controllers + keyboard fallback so a human can play while the agent iterates with `runSource`. The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every genre platform except NES, which is single-screen. **331 / 331 tests passing.**
>
> **Maturity:** launch-*candidate*, not yet 1.0. The build/run/inspect surface is real and tested; what's still open is the weak-model "ships a game in one session" validation, a known NES stock-platformer idle-crash, and remote-MCP-client reconnect UX. See [PLAN.md § Launch readiness — open risks](./PLAN.md#launch-readiness--open-risks).

## Supported systems — pick your platform

Twelve consoles/computers, oldest → newest. Use this to choose what to build *for* — they vary enormously in how hard a game is to make and how hard an existing game is to hack. **Build** = write code → compile → run. **Hack** = modify an existing commercial ROM (find data → patch → reinsert). A system can be easy on one and hard on the other. (Difficulty is rated *as it feels through rom-dev-mcp today* — see the note under the table; it gets easier as the tooling improves.)

| System | Year | Languages (toolkit) | Build a game | Romhack a game | Best for |
|---|---|---|---|---|---|
| **Atari 2600** | 1977 | 6502 asm (dasm) | 🔴 Hardest | 🟠 Hard | The deep end. "Race the beam": no framebuffer, 128 B RAM, every scanline cycle-counted. Iconic, brutal, deeply rewarding. |
| **Commodore 64** | 1982 | C / 6502 asm (cc65) | 🟢 Easy | — | 40 years of docs, weird but forgiving hardware. A great first 8-bit target. |
| **NES / Famicom** | 1983 | C / 6502 asm (cc65) | 🔴 Hard | 🟡 Medium | "Everyone knows the NES" — but the PPU is unforgiving (OAM/NMI timing, CHR-RAM traps, silent black screens). Hacking is friendlier: lots of games store data plainly; the disassembler is mapper-aware. |
| **Sega Master System** | 1985 | C / Z80 asm (SDCC) | 🟢 Easy | 🟡 Medium | Simple Z80 + VDP. Near-identical twin of the Game Gear. |
| **Atari 7800** | 1986 | C / 6502 asm (cc65) | 🔴 Hard | 🟠 Hard | MARIA display-list graphics (~100 sprites, little flicker) but a unique model with sparse docs. |
| **Sega Genesis / Mega Drive** | 1988 | C (SGDK) / 68000 asm (vasm) | 🟡 Medium | 🟢 Easy | SGDK is a real C engine (high productivity) with a big API + sharp edges. **Easiest system to hack:** flat 16 MB 68000 addressing, no bank-switching, near-ASCII text in many games. |
| **Game Boy** | 1989 | C / SM83 asm (SDCC / RGBDS) | 🟢 Easy | 🟢 Easy | The recommended starting point. Simple hardware, mature C tooling; games often store data uncompressed → easy to hack too. |
| **Atari Lynx** | 1989 | C / 6502 asm (cc65) | 🟡 Medium | — | Color handheld; Suzy/Mikey display-list sprite engine is its own thing + a tiny community = few references. |
| **Game Gear** | 1990 | C / Z80 asm (SDCC) | 🟢 Easy | 🟡 Medium | Same Mode-4 VDP as the Master System; only the visible window differs. |
| **Super Nintendo (SNES)** | 1990 | C (PVSnesLib) / 65816 asm (asar) | 🟡 Medium | 🟡 Medium | PVSnesLib works but is quirky (many "looks right, renders nothing" traps). Big ROMs often skip compression → medium to hack. |
| **Game Boy Color** | 1998 | C / SM83 asm (SDCC / RGBDS) | 🟢 Easy | 🟢 Easy | The Game Boy with a real color palette — same easy tooling, plus CGB color. |
| **Game Boy Advance** | 2001 | C (libtonc) | 🟡 Medium | — | 32-bit ARM, comfortable C with the well-documented Tonc library — but a big machine (IRQ/DMA/video modes = lots of surface to learn). |

**Difficulty legend:** 🟢 Easy · 🟡 Medium · 🟠 Hard · 🔴 Hardest. **Build** ratings come from an agent that actually shipped the same game on all twelve; **Hack** ratings are for text/data edits (a `—` means no romhack data yet — it's CPU-and-game-dependent, and any game using custom compression jumps to Hard regardless of system).

> **These ratings reflect difficulty *with rom-dev-mcp's current tooling* — not an abstract take on the hardware.** The biggest predictor of how hard a platform feels here isn't its raw hardware but the quality of its scaffolds, snippets, and SDK integration. Good tooling moves a platform a whole tier: the Atari 2600 is the hardest hardware on the list, yet a thick, hardware-verified snippet shelf made it *hard-but-shippable*; the same agent that found NES "hard" shipped on the C-and-SDK platforms in a single pass. **So these numbers will drift toward easier over time** as we improve scaffolds, fix footguns, and bundle richer runtimes. Treat the column as "expect roughly this much friction today," not "this system is permanently this hard."

**If you just want to ship something fast:** Game Boy, Game Boy Color, Master System, Game Gear, or C64. **If you want a challenge / iconic constraint:** NES or Atari 2600. **If you want to modify a classic game:** Genesis or Game Boy (their data is usually uncompressed). The harder systems are very doable but take more iterations — worth choosing deliberately.

> *(ColecoVision, MSX, Atari 5200, and ZX Spectrum have working build pipelines but no genre scaffolds/sound yet, so they're not listed as "build a game here" targets — see the tier-1 ship matrix below for engine-level status.)*
>
> **Agents:** read [AGENTS.md](./AGENTS.md) for the workflow guide. The MCP server automatically delivers it as connection-time instructions. Recent friction-fix rounds: R53 (GG scaffold parity + `copyStarterSnippets` + `createProject({withSnippets:true})`); R54 (GB header fully filled by `patchGbHeader`, `shadow_oam` page-aligned at $C100, `enable_vblank_irq()` for HALT-driven vblank wait, `inspectBackgroundMap` wired for GB/GBC, `buildSourceWithDebug` accepts SDCC platforms, platform-aware `readMemory` errors); R55 (GB OAM-DMA HRAM-stub fix + crt0 BSS-zeroing fix — every C-mode GB ROM since R10 had been silently affected); R56 (Lynx music + docs cleanup, TGI rendering issue diagnosed); R57 (Lynx audio+TGI wedge root-caused: handy's timer-event sweep on AUDxCTL writes; fixed by deferring MIKEY writes to vblank via `sfx_update`); R58 (ship readable source for every library we bundle — cc65 platform libsrc, libtonc, libgba, PVSnesLib, SGDK — so agents can grep their way out of corner cases instead of filing feedback rounds; ~5 MB delta); R58b (the bundled library source now lands INSIDE every scaffolded project at `vendor/`, so `grep -rn` in the project tree finds what the agent is debugging without leaving the project dir or calling MCP tools); R59 (fixed an off-by-page-offset bug in our fceumm `nes_chr` patch — agent CHR-RAM uploads to $1000+ DID land but our diagnostic-read returned zeros, faking a "write didn't work" bug for any NES project using CHR-RAM with content above 4 KB; fceumm.wasm rebuilt). Shipped: `/livestream` web viewer (socket.io-based passive observer for monitoring active MCP sessions — tabs per session, latest images per kind, activity log with badge counts for unseen events). Future planned: source-first library build with per-TU object cache (agent edits library source → ROM picks up the change) — see PLAN.md.

## What is this?

`rom-dev-mcp` is a [Model Context Protocol](https://modelcontextprotocol.io/) server. A coding agent connects to it and gets a tool surface for:

- **Running games** — load NES / C64 / Game Boy / etc. ROMs into emulated hardware and step through frame by frame.
- **Seeing them** — capture the framebuffer as a PNG and hand it to the agent.
- **Driving them** — emit controller input, run input scripts, replay sequences.
- **Inspecting them** — read CPU RAM, video RAM, save RAM. Watch memory for changes.
- **Saving and restoring** — named save states for try-this-then-undo workflows.
- **Building them** — bundled per-platform homebrew toolchains (cc65, RGBDS, SGDK, …). Agent compiles a project and immediately runs the result.

It runs on Linux, Windows, and macOS from one `npm install`. No per-OS binaries, no signing prompts, no toolchain hunting.

## Who is it for?

- **Coding agents.** The primary user. Every capability is an MCP tool.
- **Non-developers who want to make a retro game with an AI's help.** Install rom-dev-mcp, point your agent at it, describe the game you want.
- **Homebrew developers** who want a tighter feedback loop than reload-the-emulator-by-hand. The same MCP tools work great driven from a TUI / Inspector / script.

## How does it work?

Under the hood, rom-dev-mcp loads [libretro](https://www.libretro.com/) emulator cores compiled to WebAssembly. WASM means the same emulator binaries run identically on every host — no dlopen, no DLL hell, no macOS quarantine — and Node.js gives us a fast, cross-platform runtime for the MCP server, the harness, and the toolchain glue.

```
your agent <--MCP--> rom-dev-mcp server <-> WASM libretro core <-> game
                          |
                          +-> homebrew toolchain (cc65, GBDK, …)
```

## Platforms

V1 covers every platform whose dev stack (emulator + assembler or C compiler) can ship as WebAssembly. **Zero install. Every OS. Same behavior.**

| Platform                  | Emulator (WASM)   | Toolchain (WASM)            | Language(s) you write   | What's it like         | Status |
| ------------------------- | ----------------- | --------------------------- | ----------------------- | ---------------------- | ------ |
| NES                       | fceumm            | cc65 (cc65 + ca65 + ld65)   | C, 6502 assembly        | Mario, Zelda 1, Metroid | ✅      |
| Game Boy / GBC            | gambatte (patched) | sdcc sm83 port (default C), RGBDS (asm) | C (default), SM83 assembly | Tetris, Pokémon Red, Link's Awakening | ✅      |
| Atari 2600                | stella2014        | dasm                        | 6507 assembly           | Combat, Adventure, Yars' Revenge | ✅      |
| Atari 5200                | atari800          | cc65                        | C, 6502 assembly        | Star Raiders, Galaxian | ✅      |
| Atari 7800                | prosystem         | cc65                        | C, 6502 assembly        | Asteroids, Centipede   | ✅      |
| Atari Lynx                | handy             | cc65 (handy variant)        | C, 65C02 assembly       | California Games, Blue Lightning | ✅      |
| SNES / Super Famicom      | snes9x            | tcc-65816 + wla-dx (C, PVSnesLib bundled) + asar (asm) | C (default), 65816 assembly | Mario World, Zelda LttP, Chrono Trigger | ✅      |
| Sega Genesis / Mega Drive | genesis_plus_gx   | m68k-elf-gcc + binutils + newlib + SGDK (C) + vasm (asm) | C (default, SGDK), 68000 assembly | Sonic, Streets of Rage, Shining Force | ✅      |
| Commodore 64              | vice_x64 (patched) | cc65                       | C, 6502 assembly        | Boulder Dash, Impossible Mission | ✅      |
| Master System / Game Gear | genesis_plus_gx (patched) | sdcc + sdasz80         | C, Z80 assembly         | Sonic 1 SMS, Phantasy Star | ✅ |
| MSX / ColecoVision        | fmsx / gearcoleco | sdcc + sdasz80              | C, Z80 assembly         | Knightmare, Tomb Hunter | ✅ |

**What "C, 6502 assembly" means:** the bundled toolchain accepts both, and rom-dev-mcp picks the right path automatically based on whether your source looks like C or assembly. An agent (or human) can write whichever feels more natural for the task.

**Z80 / SM83 platforms (Game Boy / GBC / SMS / GG / MSX / ColecoVision):**
SDCC 4.4.0 is bundled with the z80 + sm83 (GB) + ez80_z80 ports. SMS/GG
ship a custom crt0 (auto-injected by `buildSource`) that gives a proper
cartridge reset vector + IM 1 + stack setup before calling `main()`.
Game Boy uses SDCC's sm83 port with `__sfr __at 0xFFNN` hardware-register
bindings (helper header at `src/platforms/gb/lib/c/gb_hardware.h`); pass
`language:"asm"` to route through RGBDS for hand-tuned binaries instead.
SDCC has one quirky codegen bug — `for(;;) { switch + write to __sfr }`
shape crashes the compiler — workaround: use `do { ... } while(1)` +
table-lookup writes. Documented in `src/platforms/sms/lib/README.md`
and `src/platforms/gb/lib/c/`.

**Defaults are picked for agent effectiveness.** Every platform whose
bundled toolchain includes a C compiler defaults to C (LLMs write C
fluently; the compiler handles register allocation + memory mapping).
Atari 2600 defaults to asm because its bundled toolchain is
assembler-only. SNES and Genesis default to C now that
PVSnesLib + SGDK ship; pass `language:"asm"` to route through asar
or vasm68k for hand-tuned binaries instead.

**Deferred:** GBA (32-bit, separate workstream — arm-none-eabi-gcc + libgba is the analog of R20's m68k-elf-gcc + SGDK work), ZX Spectrum (toolchain works, fuse core rejects tapes in headless mode).

### Why so fast?

The old systems' constraints are a feature. A typical Atari 2600 build is **~20-30 ms end-to-end** (compile → load → simulate 60 frames → screenshot). NES is **~175-425 ms**. The bottleneck in the agent loop is the LLM thinking, not the tools.

### What about C on SNES / Genesis / GBA?

**All three ship with full C SDKs as WebAssembly.** The classic reason a homebrewer reaches for PVSnesLib / SGDK / libgba is "I don't want to write 65816 or 68k or ARM assembly by hand," and while LLMs *can* write either, **idiomatic C with a real SDK is dramatically more productive for actual game work** (sprite engines, frame heartbeats, palette uploads).

- **SNES**: tcc-65816 + wla-dx + PVSnesLib (R18). `#include <snes.h>` works out of the box.
- **Genesis**: full m68k-elf-gcc 14.2.0 + binutils 2.42 + newlib 4.4.0 + SGDK (R20). `#include <genesis.h>` works.
- **GBA**: arm-none-eabi-gcc 14.2.0 + binutils 2.42 + newlib 4.4.0 + libtonc (default) or libgba (R24, R28). `#include <tonc.h>` for the Tonc-tutorial-aligned API; pass `runtime:"libgba"` for the devkitPro API.

### What's deferred

- **MSX + ColecoVision genre scaffolds.** Cores + sdcc-z80 toolchain work today; the platforms ship a `default` template only. The shmup / platformer / puzzle / sports / racing scaffolds + sound wrappers are queued (mostly mechanical given they share the SN76489 PSG with SMS).
- **Audio depth**: Genesis YM2612 FM instrument design beyond what XGM2 ships, GBA Direct Sound PCM streaming for samples-plus-music, SNES SPC700 BRR sample arsenal beyond the bundled shoot/explosion.

## Install (planned)

```bash
npm install -g rom-dev-mcp
```

Then configure your agent of choice to use it. For Claude Code:

```jsonc
// ~/.claude/mcp_settings.json (or whichever your client uses)
{
  "mcpServers": {
    "rom-dev": { "command": "rom-dev-mcp" }
  }
}
```

## Usage (planned)

Once installed, an agent can:

```
> Make me a tiny NES game where a sprite moves around the screen.

[agent calls installToolchain(nes) — fetches cc65]
[agent calls installCore(nes) — fetches fceumm.wasm]
[agent writes main.c + Makefile in ./my-game/]
[agent calls buildProject(./my-game) — gets my-game.nes]
[agent calls loadMedia(./my-game/my-game.nes)]
[agent calls stepFrames(60), screenshot()]
[agent sees the result, iterates]
```

## MCP tools

~101 tools across 10 categories (all loaded at session init). See [PLAN.md § v1 MCP tool surface](./PLAN.md#v1-mcp-tool-surface) for the full list and [AGENTS.md](./AGENTS.md) for the workflow-oriented tour. Common ones:

**Scaffold + build:**
- `createProject({platform, template, withSnippets?})` — generate a self-contained project tree. `withSnippets: true` also drops every vetted helper file into the dir.
- `createGame({platform, genre})` — genre-shaped scaffold (`shmup` / `platformer` / `puzzle` / `sports` / `racing`) on NES / GB / GBC / SNES / Genesis / SMS / GG / C64 / GBA / Lynx / Atari 7800 (every platform with genre templates; availability is derived from the templates themselves). The `platformer` scaffold side-scrolls on all of these except NES (single-screen).
- `copyStarterSnippets({platform, destinationDir})` — bulk-write every vetted helper file to disk without round-tripping their bytes through context.
- `buildSource`, `runSource`, `buildForPlatform` — compile, optionally load + screenshot in one call.

**Run + see:**
- `loadMedia`, `unloadMedia`, `stepFrames`, `screenshot`, `stepAndScreenshot`
- `screenshotAscii` — same frame as `screenshot` but rendered as an ANSI escape-sequence string via chafa-wasm. **ONLY use this if your LLM environment can't view inline image content.** Multimodal agents (Claude 3+, GPT-4o, Gemini, etc.) should always use plain `screenshot` — it returns the real PNG, no fidelity loss. screenshotAscii is for text-only agents that have no other way to "see" a frame. Lossy by design — good for "did the layout come out right" / "is something on screen", bad for "is that glyph readable" or "did the exact color land." Default sizing puts each ASCII cell over 2 game tiles, so the grid maps cleanly to tile coordinates.
- `setInput`, `pressButton`, `inputSequence`
- `saveState`, `loadState`, `listStates`
- `playtest` — opens a live SDL window with hot-plug USB controllers + keyboard fallback so a human can play while the agent iterates.
- `recordAudio` — confirm music is actually playing (peak/RMS + "not silent" boolean).

**Inspect:**
- `readMemory`, `writeMemory`, `watchMemory`, `runUntilWrite`
- `inspectSprites`, `inspectPalette`, `inspectPatternTiles`, `inspectBackgroundMap`, `whichTilesAreRendered`
- `getCPUState`, `getDspState`, `getYm2612State`, `getPsgState`
- `disassembleRom`, `diffRoms`, `findFreeSpace`, `findReferences`, `patchFile`, `extractCart`, `assembleSnippet`
- `getPlatformDoc({platform, name:"mental_model"|"troubleshooting"})` — read per-platform docs through MCP.

**Asset pipeline:**
- `convertImageToTiles`, `imageToTilemap`, `extractSpriteSheet`, `cropSpriteSheet`, `quantizePngForPlatform`, `crossPlatformSpriteImport`
- `captureMetaSprite`, `renderMetaSpritePreview`, `groupVisibleSprites`, `emitMetaSpriteRenderer` — lift a live multi-sprite character (OAM/SAT) into a reusable meta-sprite, preserving hardware composition + per-platform tile order; re-render to verify; emit platform-idiomatic C. Works on genesis, snes, nes, gb, gbc, sms, gg
- `loadSpriteSheet`, `loadAsepriteSheet`, `loadTilemap`, `loadGifAnimation` — FOSS-editor outputs → platform tile bytes
- `getPlatformPalettePng`, `getLospecPalette`

> **Full-screen images (splash / title screens):** use `imageToTilemap` — it dedupes tiles, builds the tilemap, and assigns palettes in one call. Supported: nes, snes, **genesis** (320×224, 4bpp, up to 4 palette lines), sms, gg, gb, gbc, c64. Do **not** hand-roll tile encoding — that's how you get a red/choppy mess. Pre-quantize the PNG with `getPlatformPalettePng` + ImageMagick `-remap`, then `imageToTilemap({platform, pngPath, outputDir})`.

## Development

```bash
git clone <this>
cd rom-dev-mcp
npm install
npm test
```

The CLI smoke binary is for our own validation; end users only ever interact via MCP.

### Reproducing the bundled WASM artifacts

The repo ships prebuilt `.wasm` files for every supported toolchain. You only need to rebuild them if you're updating an upstream version, adding a new platform, or verifying reproducibility. See [`BUILDING.md`](./BUILDING.md) for the full platform×core×patch×region-ID matrix + recipe, and [`scripts/README.md`](./scripts/README.md) for per-script details.

```bash
# Prereqs: emsdk on PATH, cmake, make, git, curl. (bison and flex are auto-built if missing.)
./scripts/build-all.sh
```

Each toolchain has its own script (`build-dasm.sh`, `build-cc65.sh`, `build-asar.sh`, `build-vasm68k.sh`, `build-rgbds.sh`). Upstream sources are cloned into `build/`, which is **not** checked in or shipped. The output of each build is staged into `src/toolchains/<name>/wasm/`, which **is** checked in (so a plain `npm install` works without needing emsdk).

| Path                                         | In git? | In npm? |
| -------------------------------------------- | ------- | ------- |
| `src/cores/wasm/*.{js,wasm}`                 | yes     | yes     |
| `src/toolchains/*/wasm/*.{js,wasm}`          | yes     | yes     |
| `src/toolchains/cc65/share/cc65/**`          | yes     | yes     |
| `src/**/*.js` (host, MCP, wrappers)          | yes     | yes     |
| `examples/`                                  | yes     | yes     |
| `scripts/`                                   | yes     | no      |
| `build/` (upstream sources + intermediates)  | NO      | no      |
| `test/roms/` (third-party test ROMs)         | NO      | no      |

## Project layout

```
rom-dev-mcp/
├── PLAN.md
├── README.md
├── src/
│   ├── host/         # WASM libretro host (core loader, frame loop, callbacks)
│   ├── mcp/          # MCP server + tool registrations
│   ├── cores/        # core registry
│   ├── toolchains/   # per-platform toolchain installers
│   ├── platforms/    # per-platform memory interpretation
│   └── cli/          # smoke-test CLI
└── test/
```

See [PLAN.md § Architecture](./PLAN.md#architecture) for the detailed view.

## License

TBD.

## See also

`rom-dev-mcp` is part of the [cliemu](../) experiments. Related siblings:

- [`retroemu`](../retroemu) — terminal/SDL emulator player that loads libretro cores.
- [`wasmcart-libretro`](../wasmcart-libretro) — the *inverse* project: a libretro core that hosts wasmcart games inside RetroArch.
- [`gamepad-node`](../gamepad-node) — SDL GameController bindings used by both retroemu and the harness here.
