# romdev

romdev is a tool server that lets a coding agent (or you) build, run, debug, reverse-engineer and recompile retro console games. It covers 19 consoles and computers from the Atari 2600 to the Dreamcast, plus PICO-8 and two native WebAssembly game runtimes. Every compiler, emulator core and analysis engine ships as WebAssembly through npm, so there is nothing else to install.

```
npx romdevtools
```

That starts the server on `http://127.0.0.1:7331`. It works the same on Linux, Windows and macOS (Node 24 or newer). The output is a standard ROM (`.nes`, `.gb`, `.md`, `.sfc`, `.gba`, ...) that runs in other emulators, on flash carts and on real hardware.

## What it does

romdev exposes 38 tools over MCP and plain HTTP. Each tool is a verb with an operation axis, such as `memory({op:'search'})` or `disasm({target:'cfg'})`.

- **Building.** Per-platform toolchains (cc65, SDCC, RGBDS, asar, gcc and binutils for m68k/ARM/MIPS/SH, SGDK, PVSnesLib, libtonc and more) compiled to WebAssembly. Fork a working example game with `examples({op:'fork'})`, then `build({output:'run'})` builds, loads, runs and screenshots it in one call. Output ROMs get the checksums and headers real hardware needs.
- **Assets.** `encodeArt` turns PNGs into tiles, tilemaps and palettes; `importArt` reads Aseprite/LibreSprite, Tiled, GIF and TexturePacker files; `sprites({op:'capture'})` lifts a multi-sprite character from a running game; `encodeAudio` produces SNES BRR, Genesis XGM2, GBA maxmod soundbanks, NES FamiTone2 data and note tables for the other sound chips.
- **Running and inspecting.** libretro emulator cores as WebAssembly: step frames, take screenshots, drive input, read and write memory, inspect sprites, palettes, tilemaps, CPU and sound-chip state, save and restore states. `frame({op:'verify'})` reports whether a game is rendering without needing to look at the picture.
- **Reverse engineering.** Value search, write/read/execution breakpoints, single-stepping, coverage traces, byte-exact rebuildable disassembly (`disasm({target:'project'})` and `build({output:'reassemble'})`), a bundled cheat database as a labeled RAM map, ROM patching with re-injection of compressed assets, custom-font text tools, and a [romhacking playbook](packages/romdevtools/src/platforms/_guides/ROMHACKING_PLAYBOOK.md).
- **Analysis and decompilation.** Rizin and Ghidra compiled to WebAssembly: function detection, control-flow graphs, cross-references, reachable-block sets and C pseudocode on 18 platforms, including the MIPS and SH-4 3D consoles. `breakpoint({on:'jumptable'})` resolves computed-jump dispatchers by running the game.
- **Static recompilation.** `disasm({target:'recompile', emit:'wasmcart'})` recompiles a whole NES, SNES (including its coprocessor carts), Game Boy, Game Boy Color, GBA, Master System, Game Gear or Genesis ROM into a wasmcart. `frame({op:'verifyRecompile'})` checks the result against the reference emulator core frame by frame (pixels, memory, audio, must-fail controls); `findDiverge`, `fuzzRecompile` and `traceInstructions` locate differences down to the instruction. A Genesis ROM can also be built as a native cart for the sync32 console.
- **Matching decompilation.** `decomp({op})` drives a splat-based N64 or PlayStation decomp project: generate candidate C with m2c, compile it with the project's original compiler, compare per instruction, search with the permuter, and integrate with a full-ROM byte check. Everything runs as JavaScript and WebAssembly in process; no Python, make or host compiler. IDO, SGI's compiler, is proprietary and not distributed; build it once with `packages/romdevtools/scripts/build-ido.sh` from this repository or point `ROMDEV_IDO_DIR` at your own build. KMC gcc 2.7.2, EGCS 1.1.2, PS1 gcc 2.6.3 and mips-linux-gnu gcc 14 ship as WebAssembly.
- **Native runtimes.** wasmcart (`.wasc`, WebAssembly games written in any language, with GL and WebGPU rendering) and jsgame (JavaScript canvas and WebGL games) run through the same load, step, screenshot and input loop, with cart introspection through `wasm({op})`.
- **Active Bezels.** `.ab` companion packages that read a game's memory every frame and draw a composite scene (maps, HUDs). romdev returns the composite and the raw core frame for the same frame so a bezel can be checked against the game.
- **A human in the loop.** `playtest()` opens an SDL window with gamepad support on the running game while the agent keeps working; `host({op:'play'})` shows a session on the `/livestream` page.

```
your agent <--MCP / HTTP--> romdev server <-> WASM libretro core <-> your game
                                 |
                                 +-> WASM toolchains, Rizin/Ghidra, recompiler
```

The tools work just as well called by hand or from scripts.

## Supported systems

**Build** is writing a new game; **Hack** is modifying an existing one. Ratings describe how much friction to expect with romdev's current examples and libraries, not the hardware in the abstract. A dash means there is no romhack tooling beyond code analysis for that system yet.

| System | Year | Languages (toolkit) | Build | Hack | Notes |
|---|---|---|---|---|---|
| Atari 2600 | 1977 | 6502 asm (dasm) | Hardest | Hard | No framebuffer, 128 bytes of RAM, every scanline cycle-counted. |
| Commodore 64 | 1982 | C / 6502 asm (cc65) | Easy | - | Forgiving hardware and decades of documentation. Boots on the MEGA65 Open ROMs. |
| MSX / MSX2 | 1983 | C / Z80 asm (SDCC) | Easy | - | Z80 with the TMS9918/V9938 VDP family. Runs on the open C-BIOS. |
| NES / Famicom | 1983 | C / 6502 asm (cc65) | Hard | Medium | The PPU is unforgiving (OAM/NMI timing, CHR-RAM). Many games store data plainly; the disassembler is mapper-aware. |
| Master System | 1985 | C / Z80 asm (SDCC) | Easy | Medium | Simple Z80 and VDP; near twin of the Game Gear. |
| Atari 7800 | 1986 | C / 6502 asm (cc65) | Hard | Hard | MARIA display-list graphics with sparse documentation. |
| PC Engine / TurboGrafx-16 | 1987 | C / HuC6280 asm (cc65) | Medium | - | romdev ships a direct-register helper library; HuCards need no BIOS. |
| Genesis / Mega Drive | 1988 | C (SGDK) / 68000 asm (Motorola syntax, GNU as) | Medium | Easy | Flat 68000 addressing and no bank switching make it the easiest to hack. |
| Game Boy | 1989 | C / SM83 asm (SDCC, RGBDS) | Easy | Easy | The recommended starting point. |
| Atari Lynx | 1989 | C / 6502 asm (cc65) | Medium | - | Suzy/Mikey sprite engine with few references. |
| Game Gear | 1990 | C / Z80 asm (SDCC) | Easy | Medium | Master System VDP with a smaller window and 12-bit colour. |
| Super Nintendo | 1990 | C (PVSnesLib) / 65816 asm (asar) | Medium | Medium | PVSnesLib has "renders nothing" traps; the mental model lists them. |
| Game Boy Color | 1998 | C / SM83 asm (SDCC, RGBDS) | Easy | Easy | The Game Boy toolchain plus CGB colour. |
| Game Boy Advance | 2001 | C (libtonc, libgba) | Medium | - | 32-bit ARM with a large hardware surface. |
| GameTank | 2024 | C / 6502 asm (cc65) | Medium | - | An open-hardware W65C02S console: a 128x128 framebuffer drawn by a blitter, and a second 65C02 for audio. |
| sync32 | 2026 | C (arm-none-eabi, Cortex-M33) | Easy | - | An open RP2350-based console: a flat framebuffer and a function-pointer ABI, no PPU, tilemap or banking. |
| Nintendo 64 | 1996 | C (mips-elf-gcc, libdragon) | Hard | - | Rendered on the GPU through parallel-n64's glide64. |
| PlayStation | 1994 | C (mips-elf-gcc, PSn00bSDK) | Hard | - | Rendered on the GPU through Beetle PSX HW; boots OpenBIOS, no Sony firmware. |
| Dreamcast | 1998 | C (sh-elf-gcc) | Hard | - | Rendered on the GPU through Flycast with its reios HLE BIOS; bare-metal C. |
| PICO-8 | 2015 | Lua (FAKE-08) | Easiest | Easy | Carts are Lua source, so building is packaging and hacking is editing. |
| wasmcart | 2026 | Any language that targets WebAssembly | Easy | - | You bring the compiler; romdev runs, inspects and packs the cart. Carts need wasmcart ABI v4. |
| jsgame | 2024 | JavaScript (canvas, WebGL2) | Easy | - | JavaScript games run like carts, with V8 introspection. |

The Rizin/Ghidra analysis engine works on all 19 systems except sync32, whatever the Hack rating; the rating is about editing data, not analysing code. Decompiler output is most readable on ARM (GBA) and 68000 (Genesis), good on Z80 and the MIPS/SH-4 consoles, and rough on the 6502 family. Byte-exact rebuildable disassembly covers the 15 classic 2D systems.

To ship something quickly, start with Game Boy, Game Boy Color, Master System, Game Gear, C64 or PICO-8. To modify an existing game, Genesis and Game Boy are the gentlest.

## Examples, sound and docs per platform

Every classic platform ships starter projects, a sound API, a music demo on that platform's usual engine, and five genre examples (shmup, platformer, puzzle, sports, racing); the Atari 2600 has four (no puzzle). GameTank, sync32, PICO-8, N64, PlayStation and Dreamcast ship genre examples too. Fork one with `examples({op:'fork', example:'nes/platformer', name, path})`. The platformer side-scrolls with a hardware camera on every platform except NES and the Atari 2600. Each platform has a mental model and troubleshooting guide readable in session with `platform({op:'doc', platform, name})`.

| Platform | Core | Compiler / SDK | Music engine |
|---|---|---|---|
| NES | fceumm | cc65 | FamiTone2 |
| Game Boy / Color | gambatte | SDCC, RGBDS | hUGEDriver |
| SNES | snes9x (bsnes as an alternate) | PVSnesLib, asar | SPC700 driver |
| Genesis | genesis_plus_gx | SGDK (m68k gcc), 68000 asm (m68k GNU as) | XGM2 |
| Master System / Game Gear | genesis_plus_gx | SDCC | PSG tracker |
| C64 | VICE x64 | cc65 | SID sequencer |
| GBA | mGBA | libtonc, libgba (arm gcc) | maxmod |
| Atari Lynx | handy | cc65 | Lynx audio |
| Atari 2600 | stella2014 | dasm | 2-voice TIA |
| Atari 7800 | prosystem | cc65 | 2-voice TIA tracker |
| PC Engine | geargrafx | cc65 | HuC6280 PSG |
| MSX / MSX2 | blueMSX | SDCC | AY-3-8910 PSG |
| GameTank | GameTank core | cc65 | ACP audio coprocessor |
| sync32 | s32core | arm-none-eabi gcc | game-side software synth |
| Nintendo 64 | parallel-n64 (glide64, GPU) | mips gcc | - |
| PlayStation | Beetle PSX HW (GPU) | mips gcc, PSn00bSDK | - |
| Dreamcast | Flycast (GPU) | sh gcc | - |
| PICO-8 | FAKE-08 | Lua | built in |
| wasmcart | wasmcart host (no emulator) | your own | 48 kHz PCM ring |
| jsgame | rungame (no emulator) | your own | WebAudio |

The 3D consoles render on the GPU through [native-gles](https://github.com/monteslu/native-gles) (headless OpenGL ES, no browser).

## Packages

The package you install is `romdevtools`. It depends on `romdev-*` packages that carry the WebAssembly binaries, so each one can be versioned and reused separately. A platform's binaries load the first time you use that platform.

| Package group | Packages |
|---|---|
| Server | [`romdevtools`](./packages/romdevtools): the tool server (MCP, HTTP, Agent Skill), examples, libraries, docs. Bins: `romdevtools`, `romdevtools-cli`, `romdev-mcp` (alias). |
| Emulator cores (15) | `romdev-core-fceumm`, `-gambatte`, `-gpgx`, `-vice`, `-handy`, `-prosystem`, `-geargrafx`, `-bluemsx`, `-gametank`, `-bsnes`, `-fake08`, `-s32core`, `-parallel-n64`, `-beetle-psx-hw`, `-flycast` |
| Core runtime (2) | [`romdev-core-host`](./packages/romdev-core-host) (the libretro host, usable without the server) and [`romdev-core-runner`](./packages/romdev-core-runner) (an SDL window over it) |
| Platform bundles (4) | `romdev-platform-snes`, `-gba`, `-atari2600`, `-sync32`: a core and compiler used by no other platform |
| Toolchains (7) | `romdev-toolchain-cc65`, `-sdcc`, `-rgbds`, `-m68k-gcc`, `-mips-gcc` (also armips and mips-linux-gnu binutils), `-sh-gcc`, `-decomp-gcc` (KMC, EGCS and PS1 gcc for decomp projects) |
| Analysis (2) | `romdev-analysis` (Rizin), `romdev-analysis-decompiler` (Ghidra decompiler and SLEIGH specs) |
| Decomp tools (6) | `romdev-splat`, `romdev-spimdisasm`, `romdev-rabbitizer`, `romdev-m2c`, `romdev-permuter`, `romdev-pycparser`: JavaScript and WebAssembly ports of the community decomp tools |
| Audio (4) | `romdev-famitone`, `romdev-maxmod`, `romdev-xgm2`, `romdev-audio-resampler` |
| Data (1) | `romdev_game_codes`: the cheat database used as a labeled RAM and code map, loaded one platform at a time |

`romdev-toolchain-ido` is private and never published; see "Matching decompilation" above.

The WebAssembly binaries are build outputs shipped through npm; this repository holds the sources, build scripts, patches and version pins. [packages/romdevtools/scripts/BUILD_MAP.md](./packages/romdevtools/scripts/BUILD_MAP.md) maps each binary to the script that builds it.

## Connect

```bash
npx romdevtools      # MCP on http://127.0.0.1:7331/mcp
```

The first run downloads the packages; later runs start from the npm cache. `PORT` and `HOST` change the bind address. `http://127.0.0.1:7331/livestream` shows tool calls and running sessions live for a human watching.

### Claude Code

```bash
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

### opencode

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "romdev": {
      "type": "remote",
      "url": "http://127.0.0.1:7331/mcp",
      "enabled": true
    }
  }
}
```

### Codex CLI

```bash
codex mcp add romdev --url http://127.0.0.1:7331/mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.romdev]
url = "http://127.0.0.1:7331/mcp"
```

### Other MCP clients and plain HTTP

Any streamable-HTTP MCP client can use `http://127.0.0.1:7331/mcp`. Both the session-based protocol (an `initialize` handshake and `Mcp-Session-Id`) and the stateless 2026-07-28 revision are served on that endpoint; on the stateless revision, pass one stable `session` argument on every call so your calls reach the same emulator.

Without MCP, every tool is an HTTP route: `POST /tool/{name}` with a JSON body and an `x-romdev-session` header. `GET /openapi.json` describes them, `GET /documentation` is a browsable console, and `GET /skills/romdev/SKILL.md` is an Agent Skill generated from the running server.

Then describe what you want:

```
> Make me a tiny NES game where a sprite moves around the screen.

[agent: examples({op:"fork", example:"nes/platformer", name:"mygame", path:"/path/to/mygame"})]
[agent: build({output:"run", platform:"nes", path:"/path/to/mygame"}) -> builds, loads, runs, screenshots]
[agent looks at the result and iterates]
```

`romdevtools-cli play game.gba` also works as a plain emulator: an SDL window with hot-plugged controllers and live fps in the title bar.

## Development

An npm-workspaces monorepo (Node 24 or newer):

```bash
git clone https://github.com/monteslu/romdev.git
cd romdev
npm install
npm test
```

The WebAssembly binaries are built from pinned upstream sources in a reproducible Emscripten container; see [BUILD_MAP.md](./packages/romdevtools/scripts/BUILD_MAP.md). You only rebuild them when bumping an upstream or adding a platform. [docs/decomp-throughput.md](./packages/romdevtools/docs/decomp-throughput.md) describes the measured decompilation workflow, bounded permuter search and Z80 IR export.

## License

romdev's own code is MIT ([LICENSE](./LICENSE)). The third-party components it bundles keep their own licences, listed in [NOTICE](./NOTICE).

Games you build with romdev are yours, including to sell; the bundled runtime libraries they link are permissively licensed (see NOTICE).

Recompiled carts are different: a cart made by the static recompiler contains code ported from the reference emulator (GPL, MPL or non-commercial terms depending on the platform) as well as the original game's code. Each recompiled cart carries a `licence` entry naming those components, and NOTICE explains the terms.
