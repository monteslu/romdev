# romdev

The entry point for **romdev** — vibe-code real retro games. Build, run, inspect, and reverse-engineer actual homebrew ROMs (NES, SNES, Game Boy, Genesis, Atari, C64, GBA, PC Engine, MSX, GameTank, sync32 — and the 3D consoles N64, PlayStation, and Dreamcast), plus the **PICO-8** fantasy console (via FAKE-08), with one command — drive it yourself or let a coding assistant do it.

```bash
npx romdevtools
```

**What you get:**

- **Build** — bundled per-platform toolchains (cc65, SDCC, RGBDS, asar, vasm, SGDK, PVSnesLib, libtonc, …) as WASM. Write source, compile, get a real ROM.
- **Run + see + drive** — load the ROM into an emulated console (libretro cores as WASM), step frames, screenshot, script controller input. The 2D consoles render in software; the 3D consoles (N64 via glide64, PlayStation via Beetle PSX HW, Dreamcast via Flycast) render on the **real GPU** through [`native-gles`](https://github.com/monteslu/native-gles) — headless OpenGL/EGL, no browser. PlayStation ships [OpenBIOS](https://github.com/grumpycoders/pcsx-redux) (MIT) embedded, so there's no proprietary firmware to supply. **Dreamcast is EXPERIMENTAL, but no longer just a curiosity** — the SH-4 runs on a WASM recompiler, so commercial discs boot, render, respond to input, and drive through their menus into gameplay. Across the five discs used for testing: all five boot and take controller input, and two reach live in-game scenes (3D world rendering with a working HUD); the rest land on title menus or save-file prompts. Throughput is ~70-140fps headless, against ~16fps when the SH-4 was interpreted through core 0.2.0. AICA sound is still interpreted and measures under ~12% of frame time. What hasn't been characterised is *sustained* play — a full level, long-run stability, framerate under the heaviest scenes — so treat it as young rather than finished.
- **Inspect + romhack** — read CPU/video/save RAM, watch memory, write-breakpoints, the Cheat-Engine value-search loop, a bundled cheat database, mapper-aware disassembly, and a byte-exact rebuildable-project disassembler (`disasm({target:'project'})` splits a ROM into byte-exact region `.asm`; **`build({output:'reassemble'})` rebuilds it into a byte-identical ROM in one call on all 15 classic platforms** — edit a region and rebuild, the "cmp before commit" gate for any structural hack).
- **Reverse-engineering analysis engine (all 18 platforms — incl. the 3D consoles' MIPS R3000/R4300 + SH-4)** — control-flow graphs, deep cross-references, auto-detected functions (ranked real-code-first), a one-shot structural map, and a Ghidra **decompiler** (C-like pseudocode, with hardware registers named and 6502 SLEIGH clutter folded to readable C): `disasm({target:'cfg'|'xrefs'|'functions'|'decompile'})` and `symbols({op:'analyze'})`. And the piece no static tool has: **live computed-jumptable recovery** — `breakpoint({on:'jumptable'})` runs the emulator to resolve the `JMP (table,X)` / RTS-trick dispatchers (state machines, script/battle VMs) that static analysis collapses to "could not recover." Understand *how* a routine works before you touch it — no $3,000 IDA license, no install.
- **Convert assets** — PNG → platform tiles/tilemaps, quantize-to-palette, audio importers (BRR for SNES, XGM2 PCM for Genesis).
- **Active Bezels** — an executable companion to a specific ROM (a `.ab` package) that runs once per emulated frame, reads the core's live memory, and renders the complete final scene: a map, a HUD, reconstructed world graphics, around or over the game. `loadMedia({useActiveBezel:true})` picks up the same-basename sidecar (`Game.nes` → `Game.ab`) and makes the **composite** the presented and captured picture. romdev is where these get *verified*, not just played: a package can load, tick without trapping, emit valid draw commands, and still be completely wrong about the game, so `frame({op:'screenshot', source:'both'})` returns the composite and the raw core framebuffer for the SAME frame — plus the three geometries (core framebuffer / intended display aspect / bezel scene) that are easy to conflate. Compare them against the guest's own memory reads to check the package's *interpretation*, not just that it drew something.
- **Native game runtimes (beyond emulation)** — the same run/see/drive loop also hosts two *native* game formats: **wasmcart** (`.wasc` — WASM games from any language; 2026) and **jsgame** (`.jsgame` — JavaScript canvas/WebGL games; 2024). `loadMedia({platform:'wasmcart'|'jsgame'})` → `frame({op:'step'|'screenshot'})` → `input`, over the same tools — plus **`wasm({op:'conformance'})`** (the 'won't load, why?' verdict — required exports / manifest-vs-instance / declared caps / debug + determinism consistency), `wasm({op:'info'|'exports'|'read'|'write'})` (live WCInfo + heap + module exports), **named debug state** (`wasm({op:'debugState'})` and read/write BY NAME — the cart's opt-in `wc_debug_state` table: `player_x` instead of a raw offset), **frame-stamped events** (`wasm({op:'events'})` drains `wc_debug_mark` annotations + captured `wc_log` — a run navigable by the moments the cart marked), **deterministic replay** (`loadMedia({deterministicSeed})` seeds `wc_set_seed` + fixes the virtual clock, so `regression({op:'capture'/'check'})` frame-hash goldens are airtight on carts that declare `WC_FLAG_DETERMINISTIC`; named-state checkpoints cover the carts that can't), **`audioDebug({op:'record'})`** (capture the cart's audio to WAV — ears to go with the eyes), **headless GL** (a cart whose wasm imports from the `gl` module renders on an offscreen WebGL2 context — screenshots, `frame({op:'verify'})`, and regression goldens see the real GPU draws, no window; `status.gl` reports rendered vs stubbed), and `pack({target:'wasc'|'jsgame'})` to zip a source dir into the distributable archive (the "build" step; romdev doesn't compile the WASM — bring your own). A capability descriptor marks the emulator-only tools (memory regions / cpuState / disasm) *not-applicable* for these kinds. Depends on the [`wasmcart`](https://www.npmjs.com/package/wasmcart) + [`rungame`](https://www.npmjs.com/package/rungame) packages (jsgame runs in a `vm` realm — the server self-re-execs with `--experimental-vm-modules`).
- **PICO-8 (fantasy console)** — the [FAKE-08](https://github.com/jtothebell/fake-08) player (MIT, no BIOS) runs PICO-8 `.p8` (Lua source) and `.p8.png` (cart-in-a-label-PNG) carts at 128×128 with sound. `loadMedia({platform:'pico8'})` → `frame`/`input` work like any core; `build({platform:'pico8', source: lua})` PACKAGES a runnable `.p8` from Lua (+ optional gfx/sfx/map sections) — it's a cart assembler, not a CPU compiler (the Lua IS the code). PICO-8 is a Lua VM, so instead of machine-code disasm/decompile you read the cart's Lua directly with `disasm({target:'source'})`; `memory({region:'system_ram'})` exposes the full 64KB PICO-8 address space (sprite sheet, map, sfx, general RAM, screen buffer). Its capability descriptor is a `fantasy` tier — cpuState/decompile/tile-inspectors report *not-applicable* (there's no CPU or tile hardware to inspect). Ships the [`romdev-core-fake08`](https://www.npmjs.com/package/romdev-core-fake08) core package.

Point any coding agent at it three ways:

- **Plain HTTP** — `POST http://127.0.0.1:7331/tool/{name}`; browse/try every tool at `/documentation`.
- **Agent Skill** — `GET /skills/romdev/SKILL.md` (the [Agent Skills](https://agentskills.io) standard; save it to your skills dir as `skills/romdev/SKILL.md`; ~100 tokens until invoked).
- **MCP** — it's also a [Model Context Protocol](https://modelcontextprotocol.io/) server at `/mcp` for clients that want it. **Both protocol eras are served on that one endpoint**: legacy clients (the `initialize` handshake + `Mcp-Session-Id`) work unchanged, and clients speaking the stateless **2026-07-28** revision — no handshake, no session id, per-request `_meta` — are served natively, with `server/discover` advertising what the server supports. Since that revision has no protocol session to hold your identity, the server takes it from (in order) a `_meta["dev.romdev/sessionHandle"]` handle, the optional **`session` argument every tool accepts**, or — when a call names nothing — your keep-alive connection, in which case each result ends with a `session: <id>` line you can pass back to pin it. Over plain HTTP the same job is done by `x-romdev-session`.

This package contains all the JavaScript — the tool surface, the WASM emulator host, the per-platform example games, runtime/library source, and debug helpers — but **no emulator or compiler WASM itself.** Those ship in the `romdev-*` binary packages it depends on; each platform's core/toolchain WASM is resolved (`import.meta.resolve`) and instantiated only the first time you build or run that platform, so memory stays proportional to what you actually use.

> For the full project — what romdev is, the supported-platform matrix, how the pieces fit together, and how to develop on it — see the [repository README](https://github.com/monteslu/romdev#readme).

## What's in this package

- **`bin`**
  - `romdevtools` → the tool server (`src/mcp/server.js`). Serves the HTTP tool routes, `/documentation`, `/skills/romdev/SKILL.md`, and an MCP endpoint on `http://127.0.0.1:7331` by default (`PORT` / `HOST` to override). `romdev-mcp` is kept as an alias of the same command.
  - `romdevtools-cli` → a smoke/utility CLI, incl. `romdevtools-cli play <rom>` (SDL window, hot-plug controllers, live fps in the title bar).
- **`src/`** — the server, MCP tools, WASM host, core/toolchain resolvers, per-platform memory interpretation, and bundled library/runtime source (cc65 libs, PVSnesLib, SGDK, libtonc/libgba, hUGEDriver, …) that forked projects link against.
- **`examples/`** — per-platform example games (complete, working, forkable) and minimal references.

## Dependencies

`romdevtools` depends on the binary/data packages it needs (exact-pinned), so a single install gets a matched, tested set:

- 2D cores: `romdev-core-{fceumm,gambatte,gpgx,vice,handy,prosystem,geargrafx,bluemsx,gametank,s32core,fake08}`
- 3D / GPU cores (rendered through `native-gles`): `romdev-core-{parallel-n64,beetle-psx-hw,flycast}`
- Platforms (core + dedicated toolchain bundled): `romdev-platform-{snes,gba,atari2600}`
- Toolchains: `romdev-toolchain-{cc65,sdcc,m68k-gcc,vasm,rgbds,mips-gcc,sh-gcc}` (mips-gcc = N64/PS1 C; sh-gcc = Dreamcast C)
- GPU deps (OPTIONAL — only the 3D cores need them; the 2D cores never touch GL): `native-gles` + `webgl-node`. A headless user without a GPU stack can still run all the 2D platforms.
- Analysis: `romdev-analysis` (Rizin → WASM: control-flow graphs, cross-references, function detection) and `romdev-analysis-decompiler` (Ghidra's C++ decompiler → WASM + SLEIGH processor specs for all 18 CPUs, incl. MIPS R3000/R4300 + SH-4). Power `disasm({target:'cfg'|'xrefs'|'functions'|'decompile'})` and `symbols({op:'analyze'})`. Lazy-loaded on first use.
- Data: `romdev_game_codes` — the bundled game-code / cheat database (a free labeled RAM/code map for thousands of known ROMs), split out so it can grow independently. Lazy-loaded one platform at a time.
- Native runtimes: [`wasmcart`](https://www.npmjs.com/package/wasmcart) (runs `.wasc` WASM game carts) and [`rungame`](https://www.npmjs.com/package/rungame) (runs `.jsgame` JavaScript games headlessly). Also `romdev-audio-resampler` (WASM+SIMD S16-stereo resampler, used by the live-window audio sink).
- Active Bezels: `active-bezel` — the `.ab` package format, its reference runtime, and the compositor, shared with retroemu so the composite an agent inspects is the one a player sees. Imported lazily, only when a package is actually attached.

`@kmamal/sdl` is used only by `playtest()` / `romdevtools-cli play` (the live window). It ships its native binary via its own install script, which npm skips when romdev is a transitive dep (e.g. under `npx`) — so romdev's `postinstall` fetches it, and `playtest()` also self-heals at runtime if the binary is still missing (downloading the prebuilt before the first window open). Either way, if the binary can't be fetched (offline/locked-down network), the headless server is unaffected — only the live window degrades, and the error tells you the one command to fix it.

## Connect

```bash
npx romdevtools
# then, e.g. for Claude Code (MCP):
claude mcp add --transport http romdev http://127.0.0.1:7331/mcp
```

It's a standard **streamable-HTTP** MCP server at `http://127.0.0.1:7331/mcp`. For opencode, Codex CLI, and other clients, see **[Connect](https://github.com/monteslu/romdev#connect)** in the repository README. An optional human observer (live tool-call view) is at `/livestream`.

Agents: the server delivers [`AGENTS.md`](./AGENTS.md) as connection-time instructions — the workflow guide for the full tool surface. Or just connect your agent and call `catalog({op:'categories'})` to explore the tools live, and `catalog({op:'status'})` for the running version + session snapshot.

## Prefer not to use MCP? Use HTTP or a Skill

Most agents support MCP, but you don't have to use it. Run the server
(`npx romdevtools`) and **skip wiring it into your agent's MCP
config** — no `claude mcp add`, no `mcp.json` entry, no MCP client at all. The
same 32 tools are reachable over plain HTTP / as an Agent Skill against the
running server:

- **Plain HTTP:** `POST http://127.0.0.1:7331/tool/{name}` with the args as a JSON
  body; the response is JSON. Browse/try every tool at **`/documentation`**
  (Swagger UI, served locally — no CDN), or get the machine spec at
  **`/openapi.json`**. **The agent picks its own session id** and sends it as the
  `x-romdev-session` header on every call — it's **required** (no header → `401`;
  the server won't silently run you in a throwaway session). Make it unique and
  task-descriptive (e.g. `nes-platformer-build`), since it's also the label shown
  in the `/livestream` observer. The emulator host is per-session, so the same id
  keeps your ROM across calls, and several agents can share one server by each
  using a different id. **Running many sessions at once?** Also send a stable
  `x-romdev-agent` header — one value for *you*, across all your sessions. It is
  optional and cooperative, and it buys two things: at the session/host caps
  eviction targets the **largest holder's** oldest session, so your parallel
  burst evicts its own idle sessions instead of another agent's, and the first
  response of each new session you open carries `agentSessionReminder` — your
  other live sessions, what each holds, how idle they are — which is exactly the
  list you need to sweep up afterwards. When you finish with a session,
  **`host({op:'shutdown'})`** releases all of it (emulator, session record,
  livestream entry) immediately rather than waiting out the idle timer. A call
  that fails returns a non-2xx (4xx) with the reason in the body — never a 200
  that hides an error. romdev runs **locally** and tool path args (`path`,
  `outputPath`, …) are **local filesystem paths**, not uploads — pass absolute
  paths on the same machine.
- **Agent Skill:** **`GET /skills/romdev/SKILL.md`** is a portable [Agent
  Skills](https://agentskills.io) `SKILL.md` (works in Claude Code, opencode,
  OpenClaw, Hermes, …). Drop it in your agent's skills dir; it costs ~100 tokens
  until invoked (vs always-on MCP tool defs), then teaches the workflows + the
  `POST /tool/{name}` calls.

Both are generated from the same tool registry as the MCP surface, so they never
drift. **You still run the server** — `npx romdevtools` (it hosts the
emulators/toolchains in-process and serves these routes on :7331). What the
HTTP/skill path removes is the *MCP client/protocol and its always-on context
cost* — not the server. There's no separate install beyond romdev itself, and
never a host `gcc` or emulator.

## License

romdev's code is **MIT**, and **the games you build are yours — including to
sell.** Full details + third-party component inventory:
[LICENSE](https://github.com/monteslu/romdev/blob/main/LICENSE) and
[NOTICE](https://github.com/monteslu/romdev/blob/main/NOTICE).
