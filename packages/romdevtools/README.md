# romdevtools

romdevtools is the romdev tool server. It lets a coding agent (or you) build, run, debug, reverse-engineer and recompile retro console games: NES, SNES, Game Boy and Game Boy Color, GBA, Genesis, Master System, Game Gear, Atari 2600, 7800 and Lynx, C64, PC Engine, MSX, GameTank, sync32, and the 3D consoles N64, PlayStation and Dreamcast, plus PICO-8 and the wasmcart and jsgame runtimes. Every compiler, emulator core and analysis engine is bundled as WebAssembly.

```bash
npx romdevtools
```

The server listens on `http://127.0.0.1:7331` (`PORT` and `HOST` override it). Node 24 or newer.

## What you get

38 tools, each a verb with an operation axis (`memory({op:'search'})`, `disasm({target:'cfg'})`, `build({output:'run'})`):

- **Build.** cc65, SDCC, RGBDS, asar, dasm, gcc and binutils for m68k, ARM, MIPS and SH, with SGDK, PVSnesLib, libtonc/libgba and other SDKs. Fork an example game with `examples({op:'fork'})`; `build({output:'run'})` builds, loads, runs and screenshots in one call. ROMs come out with the headers and checksums real hardware checks.
- **Run, see, drive.** libretro cores as WebAssembly: step frames, screenshots, controller input, save states. The 3D consoles render on the GPU through [native-gles](https://github.com/monteslu/native-gles) (headless OpenGL ES): N64 through parallel-n64's glide64, PlayStation through Beetle PSX HW with OpenBIOS embedded, Dreamcast through Flycast with its reios HLE BIOS and an SH-4 recompiler. Dreamcast support is experimental.
- **Inspect and romhack.** CPU, video and save RAM; value search; write, read and execution breakpoints; single-step; coverage; a bundled cheat database used as a labeled RAM map; mapper-aware disassembly; `disasm({target:'project'})` plus `build({output:'reassemble'})` for a byte-identical rebuild on the 15 classic platforms; ROM patching with re-injection of compressed assets; custom-font text tools.
- **Analysis.** Rizin and Ghidra compiled to WebAssembly on 18 platforms (all but sync32), including the 3D consoles' MIPS and SH-4: functions, control-flow graphs, cross-references, reachable blocks, a structural map and C pseudocode (`disasm({target:'functions'|'cfg'|'xrefs'|'reachable'|'decompile'})`, `symbols({op:'analyze'})`). `breakpoint({on:'jumptable'})` resolves computed-jump dispatchers by running the game.
- **Static recompilation.** `disasm({target:'recompile', emit:'wasmcart'})` recompiles a whole NES, SNES (with its coprocessors), Game Boy, Game Boy Color, GBA, Master System, Game Gear or Genesis ROM into a playable wasmcart. `frame({op:'verifyRecompile'})` checks it against the reference core (pixels, memory, audio, must-fail controls; `auto:true` picks the input itself), and `findDiverge` (down to `level:'instruction'`), `fuzzRecompile`, `traceInstructions` and `cycles` find and measure differences. A Genesis ROM can also be built as a native sync32 cart (`emit:'sync32'`). `emit:'ir'` exports decoded instructions for your own tools.
- **Matching decompilation.** `decomp({op})` runs the generate, compile, compare, search and integrate loop on a splat-based N64 or PlayStation project, using the project's own compiler as WebAssembly with the flags its Makefile chooses: IDO 5.3/7.1, KMC gcc 2.7.2, EGCS 1.1.2, PS1 gcc 2.6.3 with maspsx, mips-linux-gnu gcc 14, with armips and the mips-linux-gnu binutils. `setup` runs a fresh checkout's extraction in process. m2c, decomp-permuter, splat and spimdisasm run as JavaScript ports. No Python, make or host compiler is used. Project state lives in `~/.romdev/decomp/<project>/`. IDO is SGI's proprietary compiler and is not distributed: build it from a romdev source checkout with `scripts/build-ido.sh`, or set `ROMDEV_IDO_DIR` to your build. Start with `platform({op:'doc', platform:'n64', name:'decomp'})`.
- **Assets.** PNG to tiles, tilemaps and palettes (`encodeArt`), Aseprite/LibreSprite, Tiled, GIF and TexturePacker import (`importArt`), multi-sprite character capture (`sprites({op:'capture'})`), and audio for each platform (`encodeAudio`: SNES BRR and SPC driver data, Genesis XGM2 music and PCM, GBA maxmod soundbanks, NES FamiTone2, note tables for the other sound chips, sync32 synth and PCM).
- **Native runtimes.** wasmcart (`.wasc`, WebAssembly games from any language, with GL and WebGPU rendering; ABI v4 required) and jsgame (JavaScript canvas and WebGL games) on the same load, step, screenshot and input loop. `wasm({op})` validates a cart (`conformance`), reads its named debug state, drains its event log and talks to it over a `command` channel. `loadMedia({deterministicSeed, deterministicStepMs})` gives replayable runs for `regression({op:'capture'|'check'})` goldens. `pack({target:'wasc'|'jsgame'})` builds the archive; you bring your own compiler.
- **PICO-8.** The FAKE-08 player runs `.p8` and `.p8.png` carts. `build({platform:'pico8', source})` packages Lua into a `.p8`; `disasm({target:'source'})` returns a cart's Lua.
- **Active Bezels.** `.ab` companion packages that read the game's memory every frame and draw a composite scene. `frame({op:'screenshot', source:'both'})` returns the composite and the raw core frame for the same frame so a bezel's reading of the game can be checked.
- **A human in the loop.** `playtest()` opens an SDL window on the running game, with gamepads, while the agent keeps working. `host({op:'play', seconds})` shows a session moving on the `/livestream` page.

Detailed guides are served in session: `platform({op:'doc', platform, name:'mental_model'|'troubleshooting'})` per platform, `platform({op:'doc', platform:'romhacking', name:'playbook'})`, and `platform({op:'doc', platform:'guide', name})` for recompile, debugging, assets, music, wasmcart, bezels and sessions.

## Connecting an agent

- **MCP:** a streamable-HTTP MCP server at `http://127.0.0.1:7331/mcp`. For Claude Code: `claude mcp add --transport http romdev http://127.0.0.1:7331/mcp`. Other clients are listed in the [repository README](https://github.com/monteslu/romdev#connect). The session-based protocol and the stateless 2026-07-28 revision are both served; on the stateless revision pass one stable `session` argument on every call. The server sends [`AGENTS.md`](./AGENTS.md) as its connection instructions.
- **Plain HTTP:** `POST /tool/{name}` with the arguments as a JSON body. Send an `x-romdev-session` header on every call (required; without it you get a 401). Pick one unique, descriptive id per task; it keeps your emulator between calls and labels your work on `/livestream`. When running many sessions, also send a stable `x-romdev-agent` header so eviction at the caps takes your own idle sessions, and end each with `host({op:'shutdown'})`. `GET /openapi.json` is the spec and `GET /documentation` a local Swagger UI. Errors come back as non-2xx responses with the reason.
- **Agent Skill:** `GET /skills/romdev/SKILL.md` is an [Agent Skills](https://agentskills.io) file generated from the running server. Save it in your agent's skills directory; it costs little context until used.

romdev runs on the same machine as your agent. Path arguments (`path`, `outputPath`, ...) are local filesystem paths, not uploads.

## What is in this package

- **bin:** `romdevtools` (the server; `romdev-mcp` is an alias) and `romdevtools-cli` (`romdevtools-cli play <rom>` opens an SDL window with hot-plugged controllers and live fps).
- **src/:** the server, tools, WebAssembly host, recompiler, decomp engine, platform docs and the library and runtime source that forked projects link against.
- **examples/:** forkable example games and minimal references per platform.
- **AGENTS.md**, **NOTICE**, **LICENSES/** (licence texts for the emulator code carried into recompiled carts), **CHANGELOG.md**.

This package contains no emulator or compiler WebAssembly. Those ship in the `romdev-*` packages below, and each platform's binaries load the first time you use that platform.

## Dependencies

Exact-pinned, so one install is a matched set:

- Emulator cores: `romdev-core-{fceumm,gambatte,gpgx,vice,handy,prosystem,geargrafx,bluemsx,gametank,bsnes,fake08,s32core}` and the GPU cores `romdev-core-{parallel-n64,beetle-psx-hw,flycast}`. `romdev-core-bsnes` is an alternate SNES core (`loadMedia({platform:'snes', core:'bsnes'})`), the accuracy reference for the ST010/ST011/ST018 coprocessors.
- Core runtime: `romdev-core-host`, `romdev-core-runner`.
- Platform bundles: `romdev-platform-{snes,gba,atari2600,sync32}`.
- Toolchains: `romdev-toolchain-{cc65,sdcc,rgbds,m68k-gcc,mips-gcc,sh-gcc,decomp-gcc}`.
- Analysis: `romdev-analysis` (Rizin) and `romdev-analysis-decompiler` (Ghidra decompiler and SLEIGH specs).
- Decomp: `romdev-m2c`, `romdev-permuter` and `romdev-splat`, which bring in `romdev-spimdisasm`, `romdev-rabbitizer` and `romdev-pycparser`.
- Audio: `romdev-famitone`, `romdev-maxmod`, `romdev-xgm2`, `romdev-audio-resampler`.
- Data: `romdev_game_codes`, the cheat database, loaded one platform at a time.
- GPU: `native-gles` and `webgl-node`, required (the 3D cores and GL wasmcarts render through them).
- Runtimes: [`wasmcart`](https://www.npmjs.com/package/wasmcart) and [`rungame`](https://www.npmjs.com/package/rungame); `active-bezel` for Active Bezels (loaded only when one is attached).
- `@kmamal/sdl` for the playtest window. npm skips its binary download when romdevtools is installed through `npx`, so romdevtools' `postinstall` fetches it and `playtest()` retries at run time. If the binary cannot be fetched, only the window is affected and the error names the command that fixes it.

## License

`"license": "SEE LICENSE IN NOTICE"`. romdev's own code is MIT ([LICENSE](./LICENSE)). The third-party components bundled or depended on keep their own licences, listed in [NOTICE](./NOTICE).

Games you build with romdev are yours, including to sell. Carts made by the static recompiler are different: they contain code ported from the reference emulator (GPL, MPL or non-commercial terms, by platform) as well as the original game's code. Each recompiled cart carries a `licence` entry naming those components; the texts are in [LICENSES/](./LICENSES) and the terms are explained in NOTICE.
