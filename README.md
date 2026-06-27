# romdev

**Vibe-code real retro games.** One command, and your coding agent can make actual working ROMs for NES, SNES, Game Boy, Genesis, Atari, Commodore 64, and more — that run on RetroArch, native emulators, flash carts, and real hardware. No SDK installs. No emulator setup. No PATH fiddling. No "this only works on Linux."

```
npx romdevtools
```

That's the whole setup. Everything — emulators, assemblers, C compilers, starter libraries, example projects, hardware reference docs — ships as bundled WebAssembly and data via npm. Same on Linux, Windows, and macOS (Node 24+).

## Features

You (or your coding assistant, over [MCP](https://modelcontextprotocol.io/) / plain HTTP) get a tool surface for the full homebrew loop:

- **Building** — bundled per-platform toolchains (cc65, SDCC, RGBDS, asar, vasm, SGDK, PVSnesLib, libtonc, …) compiled to WebAssembly. The agent writes source, compiles it, and gets a real ROM.
- **Asset conversion** — turn external art and audio into native data without leaving the server: PNG → platform tiles/tilemaps (`convertImageToTiles`, `imageToTilemap` — row-major or hardware sprite order), PNG quantize-to-palette, sprite-sheet/Aseprite/GIF loaders, and audio importers (`pcmToBrr` for SNES, `wavToXgm2Pcm` for Genesis XGM2 PCM). Path-in, native-data-out.
- **Running** — load the ROM into an emulated console (libretro cores as WASM) and step through it frame by frame.
- **Seeing** — capture the framebuffer as a PNG and hand it to the agent.
- **Driving** — emit controller input, run input scripts, replay sequences.
- **Inspecting** — read CPU/video/save RAM, watch memory, disassemble, inspect sprites/palettes/tilemaps, read CPU + sound-chip state.
- **Reverse-engineering & romhacking** — a full RE toolkit for modifying existing games: iterative value search (`memory({op:'search'})` → `memory({op:'searchNext'})`, the Cheat-Engine loop), `memory({op:'classify'})` (is this "table" really ASCII?), `breakpoint({on:'write'})` (the exact instruction that wrote a byte), `memory({op:'readCart'})` (confirm a patch is live in the running image), `input({op:'navigate'})` (drive menus by screen-change), `watch({on:'dma'})` (Genesis: which ROM offset a graphic was DMA'd from), a bundled cheat database as a free labeled RAM map, and a cross-platform [ROM-hacking playbook](packages/romdevtools/src/platforms/_guides/ROMHACKING_PLAYBOOK.md) (`platform({op:'doc', platform:'romhacking', name:'playbook'})`).
- **Structural analysis & decompilation** — an open-source RE engine (Rizin + Ghidra, compiled to WebAssembly) covering **all 14 platforms**: `disasm({target:'functions'})` (auto-detected function list, ranked real-code-first with a `looksLikeData` flag), `disasm({target:'cfg'})` (control-flow graph), `disasm({target:'xrefs'})` (deep cross-references following the analysis graph), `symbols({op:'analyze'})` (one-shot structural map), and `disasm({target:'decompile'})` (Ghidra C-like pseudocode, with hardware-register MMIO named and 6502 SLEIGH clutter folded to readable C — quality excellent on GBA/Genesis, good on Game Boy/Z80, rough on the 6502 family). And the differentiator no static tool has: **live computed-jumptable recovery** — `breakpoint({on:'jumptable'})` runs the emulator to resolve the `JMP (table,X)` / RTS-trick dispatchers (game-state machines, script/battle VMs) that static analysis collapses to `(*_IRQ)()`. Understand *how* a routine works before you touch it; no $3,000 IDA license, no install.
- **Saving/restoring** — named save states for try-this-then-undo workflows.

The deliverable is **the ROM**, not the tool: a standard, hardware-valid `.nes`/`.gba`/`.md`/… that runs anywhere ROMs run. The bundled WASM cores are the *dev instrument* (build → observe → iterate), not the distribution runtime.

```
your agent <--MCP--> romdev server <-> WASM libretro core <-> your game
                          |
                          +-> WASM homebrew toolchain (cc65, SDCC, SGDK, …)
```

## Who is it for?

- **Homebrew developers** who want a tighter loop than reload-the-emulator-by-hand — build, run, inspect, and patch real ROMs from one tool surface, drive it from your editor's AI, a TUI, the Inspector, or your own scripts.
- **Anyone making a retro game with an AI's help**, no prior homebrew experience needed. Run `npx romdevtools`, point your coding assistant at it, and describe the game you want.
- **Reverse-engineers and romhackers** — disassembly, control-flow graphs, a decompiler, live memory search, and write-breakpoints across all 14 systems, no $3,000 IDA license.

Every capability is exposed as a tool, so a coding agent can drive the whole loop end-to-end — but the tools are just as usable by hand. The agent is the interface, not a requirement.

## Supported systems — pick your platform

Fourteen consoles/computers, oldest → newest. They vary enormously in how hard a game is to make and how hard an existing game is to hack. **Build** = write code → compile → run. **Hack** = modify an existing commercial ROM (find data → patch → reinsert). A system can be easy on one and hard on the other. (Difficulty is rated *as it feels through romdev today* — see the note under the table; it gets easier as the tooling improves.)

| System | Year | Languages (toolkit) | Build a game | Romhack a game | Best for |
|---|---|---|---|---|---|
| **Atari 2600** | 1977 | 6502 asm (dasm) | 🔴 Hardest | 🟠 Hard | The deep end. "Race the beam": no framebuffer, 128 B RAM, every scanline cycle-counted. Iconic, brutal, deeply rewarding. |
| **Commodore 64** | 1982 | C / 6502 asm (cc65) | 🟢 Easy | — | 40 years of docs, weird but forgiving hardware. A great first 8-bit target. |
| **MSX / MSX2** | 1983 | C / Z80 asm (SDCC) | 🟢 Easy | — | Z80 + the same TMS9918/V9938 VDP family as the Master System. Boots cartridge homebrew on the open C-BIOS (no proprietary ROM). Big international library. |
| **NES / Famicom** | 1983 | C / 6502 asm (cc65) | 🔴 Hard | 🟡 Medium | "Everyone knows the NES" — but the PPU is unforgiving (OAM/NMI timing, CHR-RAM traps, silent black screens). Hacking is friendlier: lots of games store data plainly; the disassembler is mapper-aware. |
| **Sega Master System** | 1985 | C / Z80 asm (SDCC) | 🟢 Easy | 🟡 Medium | Simple Z80 + VDP. Near-identical twin of the Game Gear. |
| **PC Engine / TurboGrafx-16** | 1987 | C / HuC6280 asm (cc65) | 🟡 Medium | — | HuC6280 (65C02 superset) + the HuC6270 VDC. cc65 has no sprite library, so romdev ships a direct-register helper lib; 9-bit GRB color, 64 hardware sprites. HuCards boot with no BIOS. |
| **Atari 7800** | 1986 | C / 6502 asm (cc65) | 🔴 Hard | 🟠 Hard | MARIA display-list graphics (~100 sprites, little flicker) but a unique model with sparse docs. |
| **Sega Genesis / Mega Drive** | 1988 | C (SGDK) / 68000 asm (vasm) | 🟡 Medium | 🟢 Easy | SGDK is a real C engine (high productivity) with a big API + sharp edges. **Easiest system to hack:** flat 16 MB 68000 addressing, no bank-switching, near-ASCII text in many games. |
| **Game Boy** | 1989 | C / SM83 asm (SDCC / RGBDS) | 🟢 Easy | 🟢 Easy | The recommended starting point. Simple hardware, mature C tooling; games often store data uncompressed → easy to hack too. |
| **Atari Lynx** | 1989 | C / 6502 asm (cc65) | 🟡 Medium | — | Color handheld; Suzy/Mikey display-list sprite engine is its own thing + a tiny community = few references. |
| **Game Gear** | 1990 | C / Z80 asm (SDCC) | 🟢 Easy | 🟡 Medium | Same Mode-4 VDP as the Master System; only the visible window differs. |
| **Super Nintendo (SNES)** | 1990 | C (PVSnesLib) / 65816 asm (asar) | 🟡 Medium | 🟡 Medium | PVSnesLib works but is quirky (many "looks right, renders nothing" traps). Big ROMs often skip compression → medium to hack. |
| **Game Boy Color** | 1998 | C / SM83 asm (SDCC / RGBDS) | 🟢 Easy | 🟢 Easy | The Game Boy with a real color palette — same easy tooling, plus CGB color. |
| **Game Boy Advance** | 2001 | C (libtonc / libgba) | 🟡 Medium | — | 32-bit ARM, comfortable C with the well-documented Tonc library — but a big machine (IRQ/DMA/video modes = lots of surface to learn). |

**Difficulty legend:** 🟢 Easy · 🟡 Medium · 🟠 Hard · 🔴 Hardest. **Build** ratings come from an agent that actually shipped games across the lineup; **Hack** ratings are for text/data edits (a `—` means no romhack data yet — it's CPU-and-game-dependent, and any game using custom compression jumps to Hard regardless of system).

The **RE analysis engine** (control-flow graphs, cross-references, function detection, and a Ghidra decompiler) works on **all 14 systems** regardless of the Hack rating above — the rating reflects how hard the *data* is to edit, not whether the *code* can be analyzed. Decompiler readability tracks the CPU: excellent on the 32-bit ARM (GBA) and 68000 (Genesis), down to rough on the 8-bit 6502 family.

> **These ratings reflect difficulty *with romdev's current tooling* — not an abstract take on the hardware.** The biggest predictor of how hard a platform feels here isn't its raw hardware but the quality of its scaffolds, snippets, and SDK integration. Good tooling moves a platform a whole tier: the Atari 2600 is the hardest hardware on the list, yet a thick, hardware-verified snippet shelf made it *hard-but-shippable*; the same agent that found NES "hard" shipped on the C-and-SDK platforms in a single pass. **These numbers drift toward easier over time** as scaffolds, footgun fixes, and richer runtimes land. Treat the column as "expect roughly this much friction today," not "this system is permanently this hard."

**If you just want to ship something fast:** Game Boy, Game Boy Color, Master System, Game Gear, or C64. **If you want a challenge / iconic constraint:** NES or Atari 2600. **If you want to modify a classic game:** Genesis or Game Boy (their data is usually uncompressed). The harder systems are very doable but take more iterations — worth choosing deliberately.

## Each platform ships a real SDK + sound + scaffolds

Every platform has a working core, ready-made starter projects, and **5 genre scaffolds** — shmup / platformer / puzzle / sports / racing — plus a music demo. (The lone exception is the Atari 2600, which ships 4: the TIA has no tilemap to draw a match-3 board, so there's no `puzzle`.) PC Engine and MSX *also* ship a hardware helper library and sprite/music example projects alongside their genre scaffolds; Genesis adds a `two_plane_parallax` scaffold (hardware scroll, no per-frame tilemap writes). Each platform has a sound API, per-platform `MENTAL_MODEL.md` + `TROUBLESHOOTING.md` docs (readable in-session via `platform({op:'doc'})`), and debug helpers. Scaffold a project in one call with `scaffold({op:'project'})` (or `scaffold({op:'game'})` for the genre-shaped baselines). Every scaffold builds with zero warnings and renders visible content (checked via `frame({op:'verify'})`).

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
| PC Engine | geargrafx | cc65 | `psg_tone` (HuC6280 PSG, 6 ch) | hand-authored PSG |
| MSX / MSX2 | blueMSX | SDCC (z80) | `msx_psg_tone` (AY-3-8910) | hand-authored PSG |
| Nintendo 64 | parallel_n64 (glide64, **GPU**) | mips-gcc (C) | AI / RSP | — |
| PlayStation | beetle_psx_hw (**GPU**) | mips-gcc (C; PSn00bSDK) | SPU | — |
| Dreamcast | flycast (**GPU**) | sh-gcc (C) | AICA | — |

The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every platform except NES and the Atari 2600 — both single-screen, since neither has hardware background scroll.

The three 3D consoles (N64 / PlayStation / Dreamcast) render on the **real GPU** through [`native-gles`](https://github.com/monteslu/native-gles) — headless OpenGL/EGL, no browser, no software rasterizer — one engine across all three. PlayStation embeds [OpenBIOS](https://github.com/grumpycoders/pcsx-redux) (MIT, region-free), so no proprietary firmware ships. These don't ship genre scaffolds yet; their renderable starting points come from the open GPU SDKs — [libdragon](https://github.com/DragonMinded/libdragon) (Unlicense) for N64, [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK) (MPL) for PlayStation — which emit the real GPU geometry the GL cores render. (The 2D consoles' software libs render to a CPU framebuffer the GL cores don't scan out.)

## How it's packaged

`romdev` is a small **monorepo** of npm packages. The thing you install is `romdevtools`; it hard-depends on a set of `romdev-*` binary packages that carry the WebAssembly:

- **[`romdevtools`](./packages/romdevtools)** — the tool server (HTTP routes + Agent Skill + MCP), all generic tools, scaffolds, runtime/library source, debug helpers, and the `romdevtools` / `romdev-mcp` (alias) / `romdevtools-cli` binaries. The fast-churning layer; ships **zero wasm**.
- **`romdev-core-*`** (11) — shared emulator cores: `fceumm`, `gambatte`, `gpgx`, `vice`, `handy`, `prosystem`, `geargrafx` (PC Engine), `bluemsx` (MSX), and the GPU cores `parallel-n64` (N64), `beetle-psx-hw` (PlayStation), `flycast` (Dreamcast).
- **`romdev-platform-*`** (3) — self-contained platform bundles where the core + compiler are used by no one else: `snes`, `gba`, `atari2600`.
- **`romdev-toolchain-*`** (7) — shared compilers: `cc65`, `sdcc`, `m68k-gcc`, `vasm`, `rgbds`, `mips-gcc` (N64/PS1 C), `sh-gcc` (Dreamcast C).
- **`romdev-analysis*`** (2) — the RE engine: `romdev-analysis` (Rizin → WASM) + `romdev-analysis-decompiler` (Ghidra decompiler + SLEIGH specs → WASM).
- **`romdev_game_codes`** (1) — the bundled game-code / cheat database (~30 MB of pre-parsed cheats for thousands of known ROMs across 13 platforms). Split out so the main package stays small and the DB grows on its own cadence; lazy-loaded one platform at a time.

`romdevtools` resolves each core/compiler from its package lazily — a toolchain's WASM is only loaded into memory the first time you build for that platform, so booting the server is fast and a session only pays for the platforms it actually uses. WASM is a **build output**: it ships via the npm packages, not committed to this git repo (which holds the source, recipes, and version pins). See [packages/romdevtools/BUILDING.md](./packages/romdevtools/BUILDING.md) for the platform × core × toolchain matrix and how the wasm is built (a pinned Emscripten container).

## Connect

Boot the server (it stays in the foreground — `Ctrl-C` to stop):

```bash
npx romdevtools      # tool server on http://127.0.0.1:7331/mcp
```

The first run downloads the cores/toolchains; later runs start instantly from the npm cache. An **optional observer** for watching tool calls live is at `http://127.0.0.1:7331/livestream` — purely for humans, no agent needs it.

Then register `http://127.0.0.1:7331/mcp` (streamable-HTTP transport) with your agent:

### Claude Code

```bash
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

### opencode

Add it to `opencode.json` (the `type` must be `"remote"` for an HTTP server):

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

Either run `codex mcp add romdev --url http://127.0.0.1:7331/mcp`, or add the table to `~/.codex/config.toml`:

```toml
[mcp_servers.romdev]
url = "http://127.0.0.1:7331/mcp"
```

In a Codex session, `/mcp` lists the connected servers and their tools.

### Any other MCP client

It's a standard **streamable-HTTP** MCP server — point any MCP-capable client at `http://127.0.0.1:7331/mcp`. Set `PORT` / `HOST` env vars to change the bind address.

---

Then just describe what you want:

```
> Make me a tiny NES game where a sprite moves around the screen.

[agent: scaffold({op:"game", platform:"nes", genre:"platformer"})]
[agent: build({output:"run", platform:"nes", path}) → builds, loads, runs, screenshots in one call]
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

The bundled WASM is built from pinned upstream source in a reproducible Emscripten container — see [packages/romdevtools/BUILDING.md](./packages/romdevtools/BUILDING.md). You only need to rebuild it when bumping an upstream version or adding a platform; day-to-day work uses the already-built wasm in the binary packages.

## License

romdev's code is **MIT**, and **the games you build are yours — including to
sell.** Full details + the third-party component inventory: [LICENSE](./LICENSE)
and [NOTICE](./NOTICE).
