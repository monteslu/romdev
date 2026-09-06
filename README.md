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
- **Reverse-engineering & romhacking** — a full RE toolkit for modifying existing games: iterative value search (`memory({op:'search'})` → `memory({op:'searchNext'})`, the Cheat-Engine loop), `memory({op:'classify'})` (is this "table" really ASCII?), `breakpoint({on:'write'})` (the exact instruction that wrote a byte), `memory({op:'readCart'})` (confirm a patch is live in the running image), `input({op:'navigate'})` (drive menus by screen-change), `watch({on:'dma'})` (Genesis: which ROM offset a graphic was DMA'd from), a bundled cheat database as a free labeled RAM map, `disasm({target:'accessScan'})` (bound every instruction that can reach a RAM byte, indexed bases included), `disasm({target:'script'})` (decode in-game script interpreters from a declarative grammar), and a cross-platform [ROM-hacking playbook](packages/romdevtools/src/platforms/_guides/ROMHACKING_PLAYBOOK.md) (`platform({op:'doc', platform:'romhacking', name:'playbook'})`).
- **Structural analysis & decompilation** — an open-source RE engine (Rizin + Ghidra, compiled to WebAssembly) covering **all 18 platforms** (incl. the 3D consoles' MIPS R3000/R4300 + SH-4): `disasm({target:'functions'})` (auto-detected function list, ranked real-code-first with a `looksLikeData` flag), `disasm({target:'cfg'})` (control-flow graph), `disasm({target:'xrefs'})` (deep cross-references following the analysis graph), `symbols({op:'analyze'})` (one-shot structural map), and `disasm({target:'decompile'})` (Ghidra C-like pseudocode, with hardware-register MMIO named and 6502 SLEIGH clutter folded to readable C — quality excellent on GBA/Genesis, good on Game Boy/Z80, rough on the 6502 family; on N64/PS1/Dreamcast the image is analyzed at its TRUE load address so calls and globals resolve, and an N64 splat project's segment map gives overlay-exact mapping with provenance). And the differentiator no static tool has: **live computed-jumptable recovery** — `breakpoint({on:'jumptable'})` runs the emulator to resolve the `JMP (table,X)` / RTS-trick dispatchers (game-state machines, script/battle VMs) that static analysis collapses to `(*_IRQ)()`. Understand *how* a routine works before you touch it; no $3,000 IDA license, no install.
- **Saving/restoring** — named save states for try-this-then-undo workflows.
- **Active Bezels** — an executable companion to a specific ROM (a `.ab` package) that runs once per emulated frame, reads the core's live memory, and renders the complete final scene: a map, a HUD, reconstructed world graphics, around or over the game. `loadMedia({useActiveBezel:true})` picks up the same-basename sidecar (`Game.nes` → `Game.ab`) and makes the composite the presented and captured picture. romdev is where a package gets **verified**, not just played: one can load cleanly, tick without trapping, emit perfectly valid draw commands, and still be completely wrong about the game — so `frame({op:'screenshot', source:'both'})` returns the composite and the raw core framebuffer for the *same* frame, alongside the three geometries (core framebuffer / intended display aspect / bezel scene) that are easy to conflate. Compare those against the guest's own memory reads and you are checking the package's *interpretation*, not merely that it drew something.
- **Matching decompilation (N64 proven)** — `decomp({op})` runs the function-level *generate → compile → compare → refine* loop against a registered [splat](https://github.com/ethteck/splat) project's **own** compiler (IDO 5.3 via ido-static-recomp, or MIPS GCC) and build: `import` (ROM sha1 verified, toolchain fingerprinted, the exact per-file compile command captured from `make`), `plan` (payoff-ordered queue + batches over the call graph), `generate` (m2c with the translation unit's real type context), **`compare`** (the candidate compiled *inside* its TU with the TU's flags; one aggregate verdict from strict instruction+relocation equality, ROM-linked words, the function's own jump tables/literals, and the rest of the TU unchanged — a check that could not run is `unknown`/`error`, never `exact`), `search` (bounded decomp-permuter jobs), `integrate` (reviewable patch; apply + full-ROM byte verify, auto-revert on mismatch), `types` (evidence → proposed structs), `progress` (code bytes per object, asm/C/library kept apart), and the runtime side — `trace` (real PC breaks: arguments at entry, return value at `ra`), `coverage` (instruction-exact via the core's PC bitmap, per function and basic block), `overlays`/`symbolize` (which overlay is resident, by bytes in RAM), `smoke` (base vs rebuilt ROM, decoded pixels + registers). Ghidra's `disasm({target:'decompile'})` stays the *understanding* tool and now loads N64/PS1/Dreamcast segments at their true addresses. Start with `platform({op:'doc', platform:'n64', name:'decomp'})`.
- **Native game runtimes (not just emulation)** — the same run/see/drive/debug loop works on two *native* game formats, not only libretro cores: **wasmcart** (`.wasc` — WASM games compiled from any language; created 2026) and **jsgame** (`.jsgame` — JavaScript canvas/WebGL games; created 2024). `loadMedia({platform:'wasmcart'|'jsgame'})` → `frame({op:'step'|'screenshot'})` → `input` — screenshots, scripted input, and deterministic frame-stepping over the exact same tools. wasmcart carts add a deterministic-replay path (`loadMedia({deterministicSeed})` — same seed + same input = identical frames), a debug-event timeline (`wasm({op:'events'})`), and an absolute pointer (`input({op:'pointer', x, y, left, right})`) for mouse-UI carts a gamepad vocabulary can't drive. Plus V8/WASM introspection an emulator can't give (peek the cart's WASM heap + exports; the JS game's globals). GL carts (wasm imports from the `gl` module) render headless on an **offscreen WebGL2 context** — screenshots and frame hashes show the real GPU draws, no window needed (wasmcart 0.6.0+; older installs fall back to stubbed GL, reported in `status.gl`) — and when a human is playing, `loadMedia({presentWindow:true})` gives the cart its own context so the playtest window presents by GPU blit + swap instead of round-tripping every frame through the CPU (measured `convertMs` 3.52 → 0 on a 1080p 3D cart); captures stay byte-identical to the headless path either way. `pack({target:'wasc'|'jsgame'})` zips a source dir into the distributable archive (the "build" step — romdev doesn't compile the WASM; you bring your own). Emulator-only tools (memory regions, cpuState, disasm) report *not-applicable* for these kinds via a capability descriptor.

The deliverable is **the ROM**, not the tool: a standard, hardware-valid `.nes`/`.gba`/`.md`/… that runs anywhere ROMs run. The bundled WASM cores are the *dev instrument* (build → observe → iterate), not the distribution runtime.

```
your agent <--MCP--> romdev server <-> WASM libretro core <-> your game
                          |
                          +-> WASM homebrew toolchain (cc65, SDCC, SGDK, …)
```

## Who is it for?

- **Homebrew developers** who want a tighter loop than reload-the-emulator-by-hand — build, run, inspect, and patch real ROMs from one tool surface, drive it from your editor's AI, a TUI, the Inspector, or your own scripts.
- **Anyone making a retro game with an AI's help**, no prior homebrew experience needed. Run `npx romdevtools`, point your coding assistant at it, and describe the game you want.
- **Reverse-engineers and romhackers** — disassembly, control-flow graphs, a decompiler, live memory search, and write-breakpoints across all 18 systems, no $3,000 IDA license.

Every capability is exposed as a tool, so a coding agent can drive the whole loop end-to-end — but the tools are just as usable by hand. The agent is the interface, not a requirement.

## Supported systems — pick your platform

Nineteen consoles/computers, oldest → newest — sixteen 2D systems (including the open-hardware GameTank and sync32) plus three 3D consoles (N64, PlayStation, Dreamcast) — plus the **PICO-8** fantasy console and the two **native game runtimes** (wasmcart, jsgame), each its own tier after the 3D consoles. They vary enormously in how hard a game is to make and how hard an existing game is to hack. **Build** = write code → compile → run. **Hack** = modify an existing commercial ROM (find data → patch → reinsert). A system can be easy on one and hard on the other. (Difficulty is rated *as it feels through romdev today* — see the note under the table; it gets easier as the tooling improves.)

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
| **GameTank** | 2024 | C / 6502 asm (cc65) | 🟡 Medium | — | Clyde Shaffer's **open-hardware** W65C02S console — a 128×128 framebuffer drawn by a hardware blitter + a second 65C02 audio coprocessor. Full Tier-1 (build/run/cpuState/watchpoints/audioDebug/cart). Open docs + a clean SDK make it a friendly modern 8-bit target; ships ~July 2026. |
| **sync32** | 2026 | C (arm-none-eabi, Cortex-M33) | 🟢 Easy | — | An RP2350 console with a **flat framebuffer and a function-pointer ABI** — no PPU, no tilemap, no banking, no scanline timing. A game is `game_main(api)` drawing into a byte array, so it is the gentlest build target here despite being the newest hardware. Build/run/cpuState/memory/palette are wired; there is no romhack column because there are no commercial ROMs. |

The three **3D consoles** are a newer, distinct tier — they compile + boot + render on the **real GPU**, but they're at a different maturity than the 2D lineup: no genre scaffolds yet, and their renderable starting points come from open GPU SDKs (libdragon / PSn00bSDK) rather than romdev's own helper libs. Build = bare C that drives the GPU; Hack = code analysis works (disasm/decompile), data-romhack tooling is minimal.

| System | Year | Languages (toolkit) | Build a game | Romhack a game | Best for |
|---|---|---|---|---|---|
| **Nintendo 64** | 1996 | C (mips-elf-gcc) | 🟠 Hard | — | MIPS R4300 + the RDP/RSP. Renders on glide64 through the GPU; bare C drives a GBI display list (or use libdragon). The 3D end of the pool. |
| **Sony PlayStation** | 1994 | C (mips-elf-gcc) | 🟠 Hard | — | MIPS R3000. Renders on Beetle PSX HW through the GPU; OpenBIOS embedded (no Sony firmware). Bare C writes the GP0/GP1 ports, or link PSn00bSDK. |
| **Sega Dreamcast** | 1998 | C (sh-elf-gcc) | 🟠 Hard | — | SH-4 + PowerVR2. Boots an ELF on Flycast's reios HLE; the bundled `dc.h` brings up a 640×480 framebuffer. No KallistiOS yet (bare-metal C). |

The **PICO-8** fantasy console is its own tier again — not a hardware machine but a Lua VM ([FAKE-08](https://github.com/jtothebell/fake-08), MIT, no BIOS). It runs `.p8` (Lua source) and `.p8.png` (cart-in-a-PNG) carts at 128×128 with sound, and it's the **friendliest build target on the whole list**: the "code" is plain Lua, so `build({platform:'pico8', source: lua})` just packages a runnable `.p8` (no compiler, no linker, no crt0). Because it's a VM, there's no machine code to disassemble — `disasm({target:'source'})` hands back the cart's Lua directly, and `memory({region:'system_ram'})` reads its 64 KB address space. Thousands of freely-shareable community carts run as-is.

| System | Year | Language (toolkit) | Build a game | "Hack" a cart | Best for |
|---|---|---|---|---|---|
| **PICO-8** | 2015 | Lua (FAKE-08) | 🟢 Easiest | 🟢 Easy | The gentlest on-ramp: Lua carts are plain text, so "build" is packaging and "hack" is editing source. Huge community library. |

The two **native game runtimes** are the newest tier — not emulated hardware but native game formats driven through the *same* run/see/drive/debug loop (`loadMedia` → `frame` → `input` → `playtest`). Here romdev is the **harness, not the compiler**: you bring your own toolchain, `pack({target:'wasc'|'jsgame'})` packages the distributable, and the deliverable is the exact artifact you debugged. Emulator-only tools (cpuState, disasm, memory regions) report *not-applicable* via a capability descriptor; in their place you get WASM/V8 introspection an emulator can't offer.

| System | Year | Language (toolkit) | Build a game | "Hack" a cart | Best for |
|---|---|---|---|---|---|
| **wasmcart** | 2026 | any language that targets WASM — C, C++, Rust, Zig, mruby, … (`wc_cart.h` ABI) | 🟢 Easy | — | Ship the same `.wasc` you debugged. The harness adds deterministic replay (`loadMedia({deterministicSeed})`), a debug-event timeline (`wasm({op:'events'})`), named debug state, absolute pointer input for mouse-UI carts, conformance verdicts ("won't load, why"), regression goldens — and GL carts render headless on an offscreen WebGL2 context, so screenshots show the real GPU draws. |
| **jsgame** | 2024 | JavaScript (canvas / WebGL2) | 🟢 Easy | — | The web-game developer's on-ramp: run a JS canvas/WebGL game like a cart — screenshots, scripted input, deterministic frame-stepping — plus V8 introspection (read the game's live globals). |

**Difficulty legend:** 🟢 Easy · 🟡 Medium · 🟠 Hard · 🔴 Hardest. **Build** ratings come from an agent that actually shipped games across the lineup; **Hack** ratings are for text/data edits (a `—` means no romhack data yet — it's CPU-and-game-dependent, and any game using custom compression jumps to Hard regardless of system).

The **RE analysis engine** (control-flow graphs, cross-references, function detection, and a Ghidra decompiler) works on **all 18 systems** — including the 3D consoles' MIPS R3000/R4300 and SH-4 — regardless of the Hack rating above; the rating reflects how hard the *data* is to edit, not whether the *code* can be analyzed. Decompiler readability tracks the CPU: excellent on the 32-bit ARM (GBA) and 68000 (Genesis), good on the MIPS/SH-4 3D CPUs and Z80, down to rough on the 8-bit 6502 family. (The byte-exact *rebuildable-project* disassembler — `disasm({target:'project'})` — covers the 15 classic platforms, and **`build({output:'reassemble'})` rebuilds any of them into a byte-identical ROM in one call**; the 3D consoles get analysis/decompile, not full reassembly yet.)

> **These ratings reflect difficulty *with romdev's current tooling* — not an abstract take on the hardware.** The biggest predictor of how hard a platform feels here isn't its raw hardware but the quality of its scaffolds, snippets, and SDK integration. Good tooling moves a platform a whole tier: the Atari 2600 is the hardest hardware on the list, yet a thick, hardware-verified snippet shelf made it *hard-but-shippable*; the same agent that found NES "hard" shipped on the C-and-SDK platforms in a single pass. **These numbers drift toward easier over time** as scaffolds, footgun fixes, and richer runtimes land. Treat the column as "expect roughly this much friction today," not "this system is permanently this hard."

**If you just want to ship something fast:** Game Boy, Game Boy Color, Master System, Game Gear, or C64. **If you want a challenge / iconic constraint:** NES or Atari 2600. **If you want to modify a classic game:** Genesis or Game Boy (their data is usually uncompressed). The harder systems are very doable but take more iterations — worth choosing deliberately.

## Each platform ships a real SDK + sound + scaffolds

Every 2D platform has a working core, ready-made starter projects, and **5 genre scaffolds** — shmup / platformer / puzzle / sports / racing — plus a music demo. That now includes the Atari 2600 (all five, match-3 board and all), the open-hardware GameTank, and sync32. The 3D consoles are the exception: N64 and PlayStation ship the five, Dreamcast ships starter projects only. PC Engine and MSX *also* ship a hardware helper library and sprite/music example projects alongside their genre scaffolds; Genesis adds a `two_plane_parallax` scaffold (hardware scroll, no per-frame tilemap writes). Each platform has a sound API, per-platform `MENTAL_MODEL.md` + `TROUBLESHOOTING.md` docs (readable in-session via `platform({op:'doc'})`), and debug helpers. Scaffold a project in one call with `scaffold({op:'project'})` (or `scaffold({op:'game'})` for the genre-shaped baselines). Every scaffold builds with zero warnings and renders visible content (checked via `frame({op:'verify'})`).

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
| wasmcart | CartHost (native WASM host — no emulator; GL carts on an offscreen WebGL2 context) | bring-your-own WASM toolchain (`wc_cart.h`) | 48 kHz PCM ring (`wc_audio` / `wc_pcm_mixer`) | — |
| jsgame | rungame (native V8 host — no emulator) | JavaScript (canvas / WebGL2) | game's own WebAudio graph (not captured in-harness yet) | — |

(The two native-runtime rows are the harness tier: no scaffolds and no bundled compiler — `pack({target:'wasc'|'jsgame'})` packages a source dir you built with your own toolchain.)

The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every platform except NES and the Atari 2600 — both single-screen, since neither has hardware background scroll.

The three 3D consoles (N64 / PlayStation / Dreamcast) render on the **real GPU** through [`native-gles`](https://github.com/monteslu/native-gles) — headless OpenGL/EGL, no browser, no software rasterizer — one engine across all three. PlayStation embeds [OpenBIOS](https://github.com/grumpycoders/pcsx-redux) (MIT, region-free), so no proprietary firmware ships. These don't ship genre scaffolds yet; their renderable starting points come from the open GPU SDKs — [libdragon](https://github.com/DragonMinded/libdragon) (Unlicense) for N64, [PSn00bSDK](https://github.com/Lameguy64/PSn00bSDK) (MPL) for PlayStation — which emit the real GPU geometry the GL cores render. (The 2D consoles' software libs render to a CPU framebuffer the GL cores don't scan out.)

## How it's packaged

`romdev` is a small **monorepo** of npm packages. The thing you install is `romdevtools`; it hard-depends on a set of `romdev-*` binary packages that carry the WebAssembly:

- **[`romdevtools`](./packages/romdevtools)** — the tool server (HTTP routes + Agent Skill + MCP), all generic tools, scaffolds, runtime/library source, debug helpers, and the `romdevtools` / `romdev-mcp` (alias) / `romdevtools-cli` binaries. The fast-churning layer; ships **zero wasm**.
- **`romdev-core-*`** (12) — shared emulator cores: `fceumm`, `gambatte`, `gpgx`, `vice`, `handy`, `prosystem`, `geargrafx` (PC Engine), `bluemsx` (MSX), `gametank` (GameTank), and the GPU cores `parallel-n64` (N64), `beetle-psx-hw` (PlayStation), `flycast` (Dreamcast).
- **[`romdev-core-host`](./packages/romdev-core-host)** + **[`romdev-core-runner`](./packages/romdev-core-runner)** (2) — the ISOMORPHIC libretro host runtime (paths under Node, factory + bytes in a browser/worker, one implementation) and the SDL "play it in a window" tier on top of it, published standalone so SDKs, web IDEs, and tools can run cores without the server. The server consumes the same host.
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

**Both protocol eras are served on that one endpoint.** Legacy clients (the `initialize` handshake plus `Mcp-Session-Id`) work exactly as before. Clients speaking the stateless **2026-07-28** revision — no handshake, no session id, protocol version and capabilities in each request's `_meta` — are served natively, and `server/discover` advertises what the server supports. That revision has no protocol session to carry your identity, so the server ties your calls to *your* emulator three ways, in this order: a `_meta["dev.romdev/sessionHandle"]` handle; the optional **`session` argument every tool accepts** (the form an agent can produce from inside a tool call — pass one stable slug on every call); or, when a call names nothing, **your keep-alive connection** — the server keys the session to it and each result ends with a `session: <id>` line you can pass back. Claude Code 2.1.x names nothing, so it gets the connection default and the reminder line. Over plain HTTP the same job is done by the `x-romdev-session` header (send it on every call, and reuse ONE `Mcp-Session-Id` — re-initializing per call is a fresh session even with the header set).

---

Then just describe what you want:

```
> Make me a tiny NES game where a sprite moves around the screen.

[agent: scaffold({op:"game", platform:"nes", genre:"platformer"})]
[agent: build({output:"run", platform:"nes", path}) → builds, loads, runs, screenshots in one call]
[agent sees the result, iterates]
```

`romdev` also doubles as a plain emulator: `romdev-cli play game.gba` opens an SDL window with hot-plug controllers and live fps in the title bar.

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
