# romdev

**Vibe-code real retro games.** One command, and your coding agent can make actual working ROMs for NES, SNES, Game Boy, Genesis, Atari, Commodore 64, and more — that run on RetroArch, native emulators, flash carts, and real hardware. No SDK installs. No emulator setup. No PATH fiddling. No "this only works on Linux."

```
npx romdev
```

That's the whole setup. Everything — emulator cores, assemblers, C compilers, starter libraries, example projects, hardware reference docs — ships as bundled WebAssembly and data via npm. Same on Linux, Windows, and macOS (Node 24+).

## What is this?

`romdev` is a [Model Context Protocol](https://modelcontextprotocol.io/) server. A coding agent connects to it and gets a tool surface for the full homebrew loop:

- **Building** — bundled per-platform toolchains (cc65, SDCC, RGBDS, asar, vasm, SGDK, PVSnesLib, libtonc, …) compiled to WebAssembly. The agent writes source, compiles it, and gets a real ROM.
- **Running** — load the ROM into an emulated console (libretro cores as WASM) and step through it frame by frame.
- **Seeing** — capture the framebuffer as a PNG and hand it to the agent.
- **Driving** — emit controller input, run input scripts, replay sequences.
- **Inspecting** — read CPU/video/save RAM, watch memory, disassemble, inspect sprites/palettes/tilemaps, read CPU + sound-chip state.
- **Saving/restoring** — named save states for try-this-then-undo workflows.

The deliverable is **the ROM**, not the tool: a standard, hardware-valid `.nes`/`.gba`/`.md`/… that runs anywhere ROMs run. The bundled WASM cores are the *dev instrument* (build → observe → iterate), not the distribution runtime.

```
your agent <--MCP--> romdev server <-> WASM libretro core <-> your game
                          |
                          +-> WASM homebrew toolchain (cc65, SDCC, SGDK, …)
```

## Who is it for?

- **Coding agents.** The primary user — every capability is an MCP tool.
- **Non-developers making a game with an AI's help.** Run `npx romdev`, point your agent at it, describe the game you want.
- **Homebrew developers** who want a tighter loop than reload-the-emulator-by-hand. The same MCP tools drive great from a TUI, Inspector, or script.

## Supported systems — pick your platform

Twelve consoles/computers, oldest → newest. They vary enormously in how hard a game is to make and how hard an existing game is to hack. **Build** = write code → compile → run. **Hack** = modify an existing commercial ROM (find data → patch → reinsert). A system can be easy on one and hard on the other. (Difficulty is rated *as it feels through romdev today* — see the note under the table; it gets easier as the tooling improves.)

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
| **Game Boy Advance** | 2001 | C (libtonc / libgba) | 🟡 Medium | — | 32-bit ARM, comfortable C with the well-documented Tonc library — but a big machine (IRQ/DMA/video modes = lots of surface to learn). |

**Difficulty legend:** 🟢 Easy · 🟡 Medium · 🟠 Hard · 🔴 Hardest. **Build** ratings come from an agent that actually shipped the same game on all twelve; **Hack** ratings are for text/data edits (a `—` means no romhack data yet — it's CPU-and-game-dependent, and any game using custom compression jumps to Hard regardless of system).

> **These ratings reflect difficulty *with romdev's current tooling* — not an abstract take on the hardware.** The biggest predictor of how hard a platform feels here isn't its raw hardware but the quality of its scaffolds, snippets, and SDK integration. Good tooling moves a platform a whole tier: the Atari 2600 is the hardest hardware on the list, yet a thick, hardware-verified snippet shelf made it *hard-but-shippable*; the same agent that found NES "hard" shipped on the C-and-SDK platforms in a single pass. **These numbers drift toward easier over time** as scaffolds, footgun fixes, and richer runtimes land. Treat the column as "expect roughly this much friction today," not "this system is permanently this hard."

**If you just want to ship something fast:** Game Boy, Game Boy Color, Master System, Game Gear, or C64. **If you want a challenge / iconic constraint:** NES or Atari 2600. **If you want to modify a classic game:** Genesis or Game Boy (their data is usually uncompressed). The harder systems are very doable but take more iterations — worth choosing deliberately.

## Each platform ships a real SDK + sound + scaffolds

Every platform has a working core, **5 genre scaffolds** (shmup / platformer / puzzle / sports / racing) plus a music demo, a sound API, per-platform `MENTAL_MODEL.md` + `TROUBLESHOOTING.md` docs (readable in-session via `getPlatformDoc`), and debug helpers.

| Platform | Core | Compiler / SDK | Sound | Music engine |
|---|---|---|---|---|
| NES | fceumm | cc65 | `sound_play_tone/noise` (APU) | FamiTone2 |
| Game Boy | gambatte | SDCC (sm83) / RGBDS | `sound_play_tone/noise` (DMG APU) | hUGEDriver |
| Game Boy Color | gambatte (CGB) | SDCC / RGBDS | APU + CGB color | hUGEDriver |
| SNES | snes9x | PVSnesLib (C) / asar (asm) | `sfx_play` (SPC700 + BRR) | SPC700 engine |
| Genesis | genesis_plus_gx | SGDK (m68k-gcc) / vasm (asm) | `sfx_*` PSG | XGM2 via SGDK |
| SMS | genesis_plus_gx | SDCC (z80) | `sfx_*` SN76489 PSG | 3-voice PSG tracker |
| Game Gear | genesis_plus_gx | SDCC (z80) | `sfx_*` (same PSG) | PSG tracker |
| C64 | vice_x64 | cc65 | `sfx_*` SID (ADSR) | 3-voice SID sequencer |
| GBA | mGBA | libtonc / libgba (arm-gcc) | `sfx_*` libtonc | maxmod |
| Atari Lynx | handy | cc65 | `sfx_*` MIKEY 4-voice | cc65 lynx audio |
| Atari 2600 | stella2014 | dasm (asm) | (asm) | 2-voice 6507 chiptune |
| Atari 7800 | prosystem | cc65 | `sfx_*` TIA | 2-voice TIA tracker |

The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every platform except NES (single-screen).

## How it's packaged

`romdev` is a small **monorepo** of npm packages. The thing you install is `romdev`; it hard-depends on a set of `@romdev/*` binary packages that carry the WebAssembly:

- **[`romdev`](./packages/romdev)** — the MCP server, all generic tools, scaffolds, runtime/library source, debug helpers, and the `romdev` / `romdev-cli` binaries. The fast-churning layer; ships **zero wasm**.
- **`@romdev/core-*`** (6) — shared emulator cores: `fceumm`, `gambatte`, `gpgx`, `vice`, `handy`, `prosystem`.
- **`@romdev/platform-*`** (3) — self-contained platform bundles where the core + compiler are used by no one else: `snes`, `gba`, `atari2600`.
- **`@romdev/toolchain-*`** (5) — shared compilers: `cc65`, `sdcc`, `m68k-gcc`, `vasm`, `rgbds`.

`romdev` resolves each core/compiler from its package lazily — a toolchain's WASM is only loaded into memory the first time you build for that platform, so booting the server is fast and a session only pays for the platforms it actually uses. WASM is a **build output**: it ships via the npm packages, not committed to this git repo (which holds the source, recipes, and version pins). See [packages/romdev/BUILDING.md](./packages/romdev/BUILDING.md) for the platform × core × toolchain matrix and how the wasm is built (a pinned Emscripten container).

## Install & connect

```bash
npx romdev          # boots the MCP server on http://127.0.0.1:7331/mcp
```

Register it with your agent. For Claude Code:

```bash
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

Then just describe what you want:

```
> Make me a tiny NES game where a sprite moves around the screen.

[agent: createGame({platform:"nes", genre:"platformer"})]
[agent: buildSource(...) → my-game.nes]
[agent: loadMedia(...); stepFrames(60); screenshot()]
[agent sees the result, iterates]
```

`romdev` also doubles as a plain emulator: `romdev-cli play game.gba` opens an SDL window with hot-plug controllers.

## Development

This is an npm-workspaces monorepo (Node 24+):

```bash
git clone git@github.com:monteslu/romdev.git
cd romdev
npm install
npm test            # runs each package's tests
```

The bundled WASM is built from pinned upstream source in a reproducible Emscripten container — see [packages/romdev/BUILDING.md](./packages/romdev/BUILDING.md). You only need to rebuild it when bumping an upstream version or adding a platform; day-to-day work uses the already-built wasm in the binary packages.

## License

romdev's code is **MIT**, and **the games you build are yours — including to
sell.** Full details + the third-party component inventory: [LICENSE](./LICENSE)
and [NOTICE](./NOTICE).
