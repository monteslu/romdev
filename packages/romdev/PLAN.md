# romdev — Plan

A Node.js MCP server that gives coding agents (Claude, Codex) full control of homebrew ROM development across retro platforms by hosting libretro cores compiled to WASM.

The agent is the user. Every capability ships as an MCP tool.

## Current state (snapshot)

**v1 — full vibe-coding loop (build → run → screenshot → inspect → patch) working end-to-end on 13 tier-1 platforms, with deep introspection, sound + music, and 5 genre scaffolds each.**

**Launch-candidate, NOT launch-proven.** The build/run/inspect surface is real and tested (327/327), and the agent-first wrapper is genuinely defensible — nobody else wraps these toolchains + emulator debug APIs behind a uniform LLM-callable interface. But the headline thesis ("a weaker model ships a playable game in one session") is **unvalidated** — everything to date is validated by Opus-class agents + the author. Before calling it 1.0, see [§ Launch readiness — open risks](#launch-readiness--open-risks): the weak-model use case is untested, the NES stock platformer self-crashes (~150 idle frames), and remote MCP clients don't auto-reconnect. The recipe tier + AAA cross-chip helpers are 5-40% built (post-launch roadmap — see [§ Roadmap](#roadmap-v2-direction--data-driven)).

| Metric              | Value                                                   |
| ------------------- | ------------------------------------------------------- |
| Tests passing       | 327 / 327 (npm test, ~30 s) |
| Tool surface        | 101 MCP tools across 10 categories, all loaded at session init (see [§ v1 MCP tool surface](#v1-mcp-tool-surface)). Full tools/list ≈ 11.5K tokens (~114 tok/tool) — this is the IDLE floor; real sessions also carry AGENTS.md as connection instructions + the schemas/outputs of calls you make. Descriptions kept concise (R62); same-operation families use one enum/param-discriminated tool (`getCPUState({cpu})`, `readMemory({region})`, `getAudioState({chip})`, `screenshot({format})`, `starterSnippets({mode})`); large outputs are path-or-inline (R63) so no single call floods context. No deprecated tool shims — renames update docs. |
| Working platforms   | NES, **C64**, GB/GBC, Atari 2600, Atari 7800, Lynx, SNES, Genesis, **SMS, Game Gear, MSX, ColecoVision** (build + run + screenshot — 13 platforms); Atari 5200 (build only — needs Asyncify-built atari800 core); ZX Spectrum (toolchain works + .tap wrapper works, but fuse libretro core rejects retro_load_game for tapes in headless mode — needs core-side investigation). |
| Bundled emulators   | 22 libretro cores (~25 MB)                              |
| Bundled toolchains  | dasm, cc65 (cc65 + ca65 + ld65 + 67 MB runtime libs/headers/cfg), asar, vasm68k, RGBDS (rgbasm + rgblink + rgbfix), **sdcc 4.4.0** (sdcc + mcpp + sdasz80 + sdasgb + sdld, ~22 MB; z80/z180/gbz80/ez80_z80 backends. mcpp 2.7.2 chained as preprocessor + sdcc --c1mode with piped stdin to bypass Emscripten's no-fork limitation). Downgraded from 4.5.0 to 4.4.0 because 4.5.0 has a z80-backend `aopGet`/`dbuf_append_str` regression that crashes on `__sfr __at` access + several other common patterns. **2026-05-25:** root-caused the "register allocator crash family" (`dbuf_append_str NULL` on for-loops with function calls, parallel array writes, indexed-with-mul reads) — it was emscripten's default 64 KB stack overflowing past `__data_end` into the static `sm83_regs[]` table. Fixed with `-s STACK_SIZE=8388608` (8 MB) in `scripts/_lib.sh`. All the previously documented "crash patterns" #1..#10 / #37 / #38 / #39 compile cleanly now. The old `unroll.h` workaround macros + 9-pattern pre-flight linter are gone (linter still catches C89 syntax violations, which is the only real SDCC-sm83 quirk left). |
| Native dependencies | Zero in headless MCP mode. `@kmamal/sdl` optional for playtest. |
| npm package size    | **~104 MB tarball (gzip) / ~310 MB unpacked** (re-measured 2026-05-28). WASM cores + toolchains dominate; WASM gzips to ~20-36%. Single largest file: `cc1-arm.wasm` 135 MB (GBA GCC). Ship-everything-in-package is the rollout decision — see [§ Deployment & rollout](#deployment--rollout). |
| Cross-platform      | Linux verified end-to-end; macOS + Windows should "just work" via Node + WASM but not yet CI-tested |
| Crash isolation     | **2026-05-25 (R12):** every WASM toolchain invocation (cc65, ca65, ld65, da65, dasm, asar, vasm68k, sdcc, mcpp, sdasz80, sdasgb, sdld, rgbasm, rgblink, rgbfix) now runs in a child worker spawned via `child_process.fork`. A toolchain Abort / SIGSEGV / OOM exits the worker, the parent detects via the `exit` event, fails the in-flight job with `{ stage:"crash", crash:{exitCode,signal} }`, and spawns a replacement. **Crash in one session cannot affect another** — MCP server stays up, tool registration + save states + playtest windows + loaded ROMs all survive. Warm worker pool (default 2 workers, env `ROM_DEV_WASM_POOL_SIZE`) amortizes startup. Implementation: `src/toolchains/_worker/{wasm-worker,pool,run}.js`. Test: `test/crash-isolation.test.js` SIGKILLs workers mid-flight and asserts the next call succeeds. |
| Onramp completeness | **2026-05-28 (R61):** `createProject` supports 14 platforms (NES, GB/GBC, C64, SMS, GG, MSX, Coleco, SNES, Genesis, Atari 2600/5200/7800, Lynx); each ships a `default` template, most also `hello_sprite` + `tile_engine`. **`createGame({platform, genre})`** scaffolds a complete genre-shaped baseline (all 5 genres: shmup / platformer / puzzle / sports / racing) on **11 platforms: NES, GB, GBC, SNES, Genesis, SMS, GG, C64, GBA, Lynx, Atari 7800** — genre availability is derived from the registered `TEMPLATES` (no hardcoded list, so it can't drift); atari2600/msx/coleco have no genre scaffolds and are rejected with the current supported set. The `platformer` scaffold side-scrolls on every genre platform except NES (single-screen). Templates live under `examples/<platform>/templates/`; impl factored to `createProjectImpl()` so createProject + createGame share the work. (Originally landed R14, NES-only/3-genre — see the R21/R22/R23/R52/R61 changelog entries below for the platform + genre + side-scroller expansion.) |
| Art-first workflow  | **2026-05-25 (R11):** New asset-loader tools that parse FOSS pixel-art editor outputs directly into platform-native tile bytes — no ImageMagick install, no shell scripts, no agent-orchestrated pipelines. `loadAsepriteSheet` (.ase via ase-parser, 41 KB MIT pure-JS) returns deduped tiles + named slices + animation tags; `loadTilemap` (Tiled .tmj JSON) returns per-layer data blobs + named object placements with key/value properties; `loadGifAnimation` (omggif, 38 KB MIT) returns per-frame tile bytes + delays; `loadSpriteSheet` (TexturePacker PNG+JSON). Plus: `getPlatformPalettePng` gains `format: "lospec"|"hex"` for direct import into LibreSprite + Lospec compatibility; `convertImageToTiles` now warns on PNG colors outside the platform palette (±8/channel tolerance, never throws). Walkthrough at [`examples/art-first-workflow/README.md`](examples/art-first-workflow/README.md). Two new pure-JS deps total ~80 KB unpacked, zero native build steps. |
| GB/GBC + NES turnkey | **2026-05-25 (R7/R8/R9/R10):** `createProject({platform, template})` produces a SELF-CONTAINED project — every byte that compiles is in the directory. The build pipeline does NOT auto-inject runtimes, custom crt0s, or post-link header patches; it compiles exactly what the caller gives it. Templates copy `{nes,gb}_runtime.{h,c}` + `{nes,gb}_crt0.s` + the linker `.cfg` into the project alongside `main.c`. Three templates per platform: `default` (palette cycle), `hello_sprite` (sprite + d-pad + **beep on A press**), `tile_engine` (multi-room tile map + collision). Runtime APIs include `sound_init` / `sound_play_tone` / `sound_play_noise` / `sound_off` for the NES APU (pulse/triangle/noise) and GB APU (2 square + wave + noise) — fire-and-forget SFX. NES uses Shiru/neslib bit layout (`PAD_A=0x80`, `PAD_RIGHT=0x01`); GB uses sm83 SFR helpers + OAM-DMA pattern. GB ROMs need a Nintendo-logo + header checksum patch post-link — `patchGbHeader` MCP tool + a `patch-header.js` script bundled into every GB/GBC project do this caller-invoked (no auto). New per-platform docs: [`src/platforms/nes/MENTAL_MODEL.md`](src/platforms/nes/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/nes/TROUBLESHOOTING.md); [`src/platforms/gb/MENTAL_MODEL.md`](src/platforms/gb/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/gb/TROUBLESHOOTING.md). The R7 SDCC sm83 stack-overflow fix is still in place (`-s STACK_SIZE=8388608` in `scripts/_lib.sh`) so for-loops with function calls + parallel array writes + multi-array indexed reads compile cleanly. |

> **Adding a new platform / core / toolchain?** Read [`BUILDING.md`](BUILDING.md) first. It's the single source of truth for the platform×core×patch×region-ID×toolchain matrix, the memory-region ID allocation, and the "how to add a platform without breaking the others" recipe. Keep it in sync when you ship a new one.

## Launch readiness — open risks

An honest pre-1.0 risk register. These are the things that decide whether the launch lands — distinct from the feature roadmap below. Ordered by "what bites a first-time user soonest."

- [~] **R1 — Headline use case: FIRST EVAL RUN (2026-05-29), partial result.** v2's thesis is "a weaker model ships a playable game in one session." First real eval run against the live server: a **capable model (Codex/GPT)** shipped GB + Genesis games fast + clean (Genesis: 6 calls, valid 512KB .bin) and got SNES rendering after debugging; a **free model (Big Pickle, opencode)** built + debugged a GBC shmup for 50+ calls with ZERO tool errors and competent assembly-level debugging, but **did NOT ship** — it ran out of reasoning runway on SDCC codegen footguns. **Key result: the tooling is NOT the bottleneck (zero harness errors across ~90 calls, both models). The entire weak-vs-capable gap = whether the model knows ~2 SDCC sm83 footguns the scaffold half-documents** (the `dst[i]=src[i]`→`__xdata` miscompile — fix `memcpy_vram()` ships but TROUBLESHOOTING never mentions it; and the uint8-loop-bound infinite loop, [[sdcc-uint8-loop-bound-trap]], no lint catches it). Both agents left detailed feedback (rom-games/gbc/asteroids/MCP_FEEDBACK.md; feedback_round34_snes_invaders_scaffold.md). **So "democratizes retro dev" is now evidence-backed-but-gated-on-R7:** capable models clear the floor today; weak models need the R7 scaffold/lint fixes to reliably ship. Re-run the eval after R7 lands.
  - **CAPSTONE: Codex shipped the SAME GAME ON ALL 12 PLATFORMS in one session** (feedback_space_invaders_full_platform_run.md, 2026-05-29). Its verdict: *"romdev is already strong enough to let an agent build real ROMs across a large set of systems in one session."* Difficulty came from two distinct sources, which it correctly separated: **hardware-hard** (2600 10/10, 7800 8/10, NES 7/10) vs **scaffold-hard** (SNES "dots" 6/10, GBC vblank-trap 6.5/10, Lynx TGI-blank 7/10 — all "correct but ugly/blank because the easy path didn't push toward the right primitive"). Its #1 meta-conclusion matches ours exactly: *"the remaining improvements are about turning 'technically works' into 'visually idiomatic' faster"* — i.e. hand the model the right rendering primitive per platform. Difficulty ranking (easiest→hardest): GBA 2, Genesis 3, SMS 3.5, GG 4, GB 4, C64 5, SNES 6, GBC 6.5, NES 7, Lynx 7, 7800 8, 2600 10.
  - **Already fixed since Codex ran (it was on pre-R7 code):** NES OAM/NMI order + ramUsage + canonical example (committed); GBC `memcpy_vram` footgun docs (R7a); SNES sfx-blocks-video + oamSet (R7c); **atari7800 + lynx `getInputLayout` (its #1 ask — done 2026-05-29)**.
  - **Capstone follow-ups — DONE (2026-05-29, committed `904847b`, pushed):** the canonical Lynx TGI loop (`tgi_busy`→full-bar clear→draw→`tgi_updatedisplay`); the 2600 gallery-shooter template (P0 cannon / P1+NUSIZ enemies / M0 shot — real TIA objects, not playfield "barcode"); the 7800 dynamic MARIA display-list guide (patch-in-place, never full per-frame rebuild); the GBC first-visible-frame fix (DMA OAM before LCD-on); GG visible-viewport coordinate constants; the SNES render fix (clean `bgSetDisable`+palette backdrop, drop the buggy `oamSetEx` hide-all, flush first OAM before `setScreenOn` — root cause was OUR scaffold, not the hardware); and the **`examples/porting-across-platforms` guide** (the per-platform best-rendering-primitive matrix). Full reply to Codex in `~/code/cliemu/feedback_from_mcp_dev.md`.
  - **Still deferred (visual-ceiling, non-blocking):** SNES chunky-metasprite visual scaffold; deeper GBC HALT/vblank-first-OAM stall investigation. Neither blocks launch.
- [ ] **R2 — NES stock platformer self-crashes (~150 idle frames).** Pre-existing cc65/runtime bug (NOT the side-scroller work — the *stock* single-screen scaffold crashes with no input). The most iconic platform's flagship demo dying on its own is a first-ten-minutes-bad-impression. Documented in [[nes-stock-platformer-idle-crash]] with repro + ruled-out causes; needs single-step debugging to the corrupting instruction. **Blocks the NES side-scroller too.**
- [x] **R3 — Client survival across server restart: LAZY-INIT SESSION ADOPTION (2026-05-29).** Was: a restart invalidated the session id, and clients that didn't auto-reinitialize on the 404 got stuck. Now the server **adopts** an unknown session id instead of rejecting it — a client that shows up post-restart with its old id is transparently re-homed into a fresh session under that exact id (`lazyInitTransport` in server.js), so the client never sees a failure and keeps its id. Emulator/host state was in RAM and is gone, so the re-adopted session is empty: the first host-needing call returns clear "re-run loadMedia({path})" guidance (state.js getHost). This is SAFE now (it wasn't pre-2026-05-29) because the full tool surface registers at init by default — there's no per-session loadCategory state to lose, which was the original reason we rejected unknown ids. Implementation reaches one level into the SDK (`transport._webStandardTransport.sessionId/_initialized`) because the streamable-HTTP transport otherwise only binds its id via a real Hono `initialize` we can't fabricate; guarded by test/lazy-init-reconnect.test.js so an SDK bump fails loudly. Verified end-to-end: restart server → old-session-id tools/list returns 200 with the real tool list, not 404. (Full STATE rehydration — restoring the loaded ROM / frame position — remains deliberately NOT done; it's a feature, not a fix, and rarely worth it for a build-iterate dev tool.)
- [ ] **R4 — Docs outran bookkeeping (symptom, not just cleanup).** This session found PLAN claiming 8 platforms/206 tests (real: 13/327), M6/M9 marked pending-but-done, createGame silently missing 3 platforms. Fixed those — but the pattern means OTHER stale assumptions are likely baked in that no one's tripped over. **Action:** treat "does the doc match the code?" as a recurring audit, not a one-time fix. Cross-platform CI (R5) catches the functional half.
- [ ] **R5 — No CI; macOS/Windows unverified.** "Should just work via Node+WASM" is untested on non-Linux. A launch invites those users. **Action:** at minimum a GitHub Actions matrix (linux/mac/win) running `npm test` before 1.0.
- [ ] **R6 — "Feature complete" is scoped to v1.** v1 lets an agent make *a* game; the things that make a *good* retro game — AAA cross-chip layer (HDMA, sprite-per-line budget, real music tooling beyond demos) and the recipe tier (`verifyGameWorks`, `traceWrite`, `buildAndLoad`) — are 5-40% built. Fine for launch IF the messaging says "make a working game," not "make a polished game." Don't let the tidy metrics (11.5K token tax, 327 green) imply more completeness than exists.
- [ ] **R7 — Scaffold + footgun fixes the R1 eval surfaced (the weak-model floor-raiser).** Concrete, verified findings from the 2026-05-29 eval. These don't block a capable-model launch (Codex shipped without them) but they're the difference between "free model ships" and "free model grinds + fails." Ordered by leverage:
  - **(a) Surface the SDCC sm83 footguns where a weak model trips.** GB/GBC `TROUBLESHOOTING.md` must LEAD with: (i) the `for(i){ dst[i]=src[i]; }`-to-`__xdata`/VRAM miscompile (writes to the return address → CPU crashes to PC=0x002B → no sprites) — the fix `memcpy_vram()` already ships in `gb_runtime.c` but is undocumented; (ii) the `uint8_t i` with a >255 loop bound = infinite loop. **Add SDCC preflight-lint rules for BOTH** (preflight-lint.js currently catches neither). This is the single highest-leverage fix — it's the entire Big-Pickle-vs-Codex gap.
  - **(b) `createGame` should RETURN the exact build invocation for the project it scaffolds** (`nextStep: {tool, args}` with the precise sources/includes/binaryIncludes). Even Codex burned ~4 `runSource` calls reconstructing the SNES SFX recipe by trial. Hand it over; collapses ~4 calls → 1. (Rubric #3 — `nextStep` — already a stated principle; apply it here.)
  - **(c) SNES scaffold pass (per feedback_round34):** `sfx_init()` before `setScreenOn()` → **black screen, OAM stays zero, video never starts** (build succeeds + boots → expensive silent failure). Make `sfx_init()` timeout-safe OR defer sound init until after the first visible frame. ALSO: the scaffold calls `oamSet(slot, ...)` but PVSnesLib's `oamSet` takes a **byte offset (`slot*4`)**, not a slot number — the shipped examples corrupt OAM. Fix to `oamSet(slot<<2, …)` or wrap as `setSpriteSlot()`. ALSO: the text-console BG renders a noisy garbage tilemap (confirmed via screenshot — uninitialized BG); ship a clean BG init + a known-good visible-HUD example. ALSO: replace the 3-tile dot-like sprite art with a readable Invaders-grade set (Genesis scaffold is the quality bar).
  - **(d) Boot-to-obviously-working baseline (cross-platform principle behind a+c).** Scaffolds should boot to an unmistakably-visible, moving sprite on a clean background, so a weak model's FIRST screenshot reads "working — now edit," not "black / garbage — now debug." Verified failures: GB first-boot sprite invisible; SNES first-boot black then garbage-checkerboard BG.
  - **(e) crt0 `+0x0101` edge-case (gb_crt0.s:132,149, identical gb+gbc).** The dual-dec gsinit loop overruns 256 bytes when a section length's low byte == 0xFF (verified by simulation). Latent — neither eval game hit it — but a real correctness bug. Rewrite the two loops with `ld a,b; or c; jr z,skip; ldir`/zero-loop (Big Pickle's suggested fix is correct).

**What's genuinely strong + de-risked:** the introspection depth (getCPUState/getAudioState/inspect*/readMemory regions across 10 platforms — the actually-hard part), crash isolation (R12), the agent-first wrapper being a real moat nobody else has, and test discipline (327 green, brittle tests fixed not deleted). The risk is believing the easy metrics mean done.

## Deployment & rollout

**North star for distribution:** a user runs **`npx romdev`** — ONE command, nothing else to learn — and the MCP server is live, with every platform ready. Cross-platform (Linux / macOS / Windows, x64 + arm64), zero system dependencies, zero build step, no Docker, no toolchain install, **no romdev-specific CLI incantations** (`romdev add …`, `--platforms …`, etc.). If a user has to learn our custom commands to use it, no one will. They point their agent at it and make games. Everything below serves that one sentence — and any design that adds a required command the user must memorize is wrong by default.

### The core decision: split on CHANGE-CADENCE (decided 2026-05-28)

We ship everything (no on-demand fetch — zero-setup is the whole promise; a fetch step is the #1 first-run-horror-story risk), but **split into packages along the line where the change rate changes.** Observed over a week of dev (mtimes confirm it): the **WASM cores + compilers are a slow, stable layer** (newest wasn't touched in ~2-3 days, and the one recent change — fceumm — was a deliberate R59 patch, not churn), while **code / scaffolds / libraries / tooling churn hourly.** Things that change at wildly different rates should version + publish + CI independently. So:

- **`romdev`** (the published entry point, what `npx romdev` runs) — the **fast-churning layer**: MCP server, generic tools (readMemory/screenshot/disassemble/host harness), **AND all the libraries + scaffolds + snippets + runtime + per-platform debug helpers** (`ppu.js`/`vdp.js`/…). Everything we edit constantly. Fast `npm test` CI; frequent publishes. Depends on the platform packages below for their binaries.
- **`romdev-platform-*`** — the **slow/stable, heavy layer ONLY**: that platform's **emulator core wasm + compiler wasm**. Nothing else. Rebuilt rarely via its own heavy Emscripten CI; versioned + published independently.

  **Two faces — don't conflate them:**
  - **PUBLISHED to npm (what users get):** just the built `.wasm` + `.js` glue. Small, that's all an installer needs.
  - **In the package's SOURCE REPO (what builds the wasm):** the build recipe — `build-<core>.sh`, **its patches** (`scripts/patches/<core>-*.patch`), emscripten flags, upstream version pins, and the core's CI. This is `.npmignore`'d OUT of the tarball, exactly like the monorepo's 14 GB `build/` is excluded today. The package "has whatever it needs to build the wasm" — *in its repo, not its published artifact.* Its CI is "patch/version changes → rebuild wasm → commit → publish." (Open D3b detail: vendor upstream core source vs. fetch-at-build with a pinned commit — fetch is leaner, avoids replicating the 14 GB problem per-package.)

  **Patches colocate with the binary they patch.** Today all core/compiler patches sit in one shared monorepo `scripts/patches/` (fceumm memory-regions, snes9x, gpgx, prosystem, stella2014, the cc65 stack-size / sdcc fixes…). Under the split, **each patch moves into the repo of the binary package it patches** — the fceumm patch in the NES-core package, the gpgx patch in `romdev-core-gpgx`, etc. Rationale: a patch + the wasm it produces + the version bump + the republish are ONE atomic change-unit; colocating them makes "patch → rebuild → ship" a self-contained loop in one repo with one CI run (today it crosses `scripts/patches/` → `src/cores/wasm/` and couples to the monolith release). NOTE the distinction: only **patches to upstream core/compiler C source** (which regenerate wasm) move into binary packages; any fix to *shipped glue/runtime JS* stays in `romdev` (it's product code, not a build input). The patches are tiny hand-authored text — the valuable artifact — and they travel with their package.

**Why this cut (not "platform package = everything for that platform"):** the content we change all week (scaffolds, tooling, snippets) stays in ONE package (`romdev`), so a cross-cutting change — like every edit this week — is a single `romdev` publish, NOT 12 platform-package republishes. You only touch `romdev-platform-nes` when its *wasm* changes, which is rare. The two release cadences never collide. This is the whole point.

**Install model: HARD dependencies, `romdev` is the orchestrator.** `romdev` is the ONLY thing the user installs (`npx romdev`); it lists the binary packages it needs as regular `dependencies` and resolves/loads them. The whole binary-package topology below is an **internal implementation detail romdev coordinates** — invisible to the user, who always just gets the matched, tested set installed up front. Works fully offline; no mid-session `npm install`; no custom CLI. Same footprint as a monolith, deliberately.

- **Exact-pin the binary deps** (`"romdev-core-gpgx": "2.1.0"`, not `^2.1.0`). `romdev`'s package.json is the single version coordinator — a given `romdev` release installs the exact binary set it was tested against. This is what makes "new library needs a newer compiler → bump the binary package, bump romdev's pin, publish romdev" a safe, atomic, reproducible coordination point (the dependency arrow points `romdev → binaries`, never back; a user can never end up with new-library + stale-compiler). Floating `^` ranges would silently break that guarantee.

**Package the binaries by what's SHARED (the real sharing map):** core-sharing and compiler-sharing cut *across* each other (a platform's core-family ≠ its compiler-family), so group **per binary**, not per "platform family." `romdev` orchestrates which it pulls.

| Binary | Kind | Serves platforms | Package |
|---|---|---|---|
| `genesis_plus_gx` | core | Genesis, SMS, GG | `romdev-core-gpgx` |
| `gambatte` | core | GB, GBC | `romdev-core-gambatte` |
| `fceumm` | core | NES | `romdev-core-fceumm` |
| `snes9x` | core | SNES | `romdev-core-snes9x` |
| `mgba` | core | GBA | `romdev-core-mgba` |
| `vice_x64` | core | C64 | `romdev-core-vice` |
| `handy` | core | Lynx | `romdev-core-handy` |
| `stella2014` | core | 2600 | `romdev-core-stella` |
| `prosystem` | core | 7800 | `romdev-core-prosystem` |
| `sdcc` | compiler | GB, GBC, SMS, GG | `romdev-toolchain-sdcc` |
| `cc65` | compiler | NES, C64, 7800, Lynx | `romdev-toolchain-cc65` |
| `arm-gcc` | compiler | GBA (the 135 MB one) | `romdev-toolchain-arm-gcc` |
| `m68k-gcc` | compiler | Genesis (C) | `romdev-toolchain-m68k-gcc` |
| `asar` | compiler | SNES (asm) | `romdev-toolchain-asar` |
| `tcc816`+`wladx` | compiler | SNES (C) | `romdev-toolchain-snes-c` |
| `vasm` | compiler | Genesis (asm) | `romdev-toolchain-vasm` |
| `rgbds` | compiler | GB/GBC (asm) | `romdev-toolchain-rgbds` |
| `dasm` | compiler | 2600 | `romdev-toolchain-dasm` |

Per-binary packaging = zero duplication + patch-once-republish-one (a gpgx fix bumps one package, not three platform packages). Each package's patch lives in its repo (see "Patches colocate" above). **Optional convenience bundles** like `romdev-platform-sms-gg` (SMS+GG share BOTH gpgx and sdcc — the one case where a full binary set is shared) can be thin meta-packages on top, but the per-binary packages are the organizing primitive. Exact split/naming is whatever's cleanest at implementation — the user never sees it; `romdev` orchestrates.

**Why split at all (wins independent of user footprint, which is unchanged):**
1. **Decoupled release cadence** — the thing your week-of-dev observation proves: scaffold/tooling edits (hourly) republish only `romdev`; wasm patches (rare) republish only the affected binary package. No 104 MB monolith republish for a one-line snippet fix.
2. **Isolates the 135 MB single-file risk** — `cc1-arm.wasm` lives in its own (gba) package; the `romdev` tarball stays small + definitely-publishable.
3. **Separate CI topology** — `romdev` gets fast `npm test` on every push; the wasm packages get heavy Emscripten CI that fires only on a wasm-source change (or manual trigger). Neither blocks the other.
4. **Keeps optional/lazy open for free** — boundaries are the prerequisite IF footprint ever forces a hybrid. NOT a v1 goal, and any such hybrid MUST preserve "no custom CLI" — auto-install transparently, never make the user type `romdev add`. We do not ship a platform-management CLI. `npx romdev` installs everything; that's the design.
5. **Cheaper to implement than lazy** — hard deps guarantee the wasm is present at install, so resolvers just point at the dep package (`import.meta.resolve`) instead of `__dirname/wasm`; NO "not installed, go fetch" UX (the expensive part, deferred with the hybrid).
6. **One copy on disk** — a shared binary (sdcc, cc65, gpgx, gambatte) is its own package, so npm installs it ONCE in node_modules and every platform that needs it resolves to that copy — no duplicate 19 MB compilers bloating node_modules. (Requires the exact-pin above so all requests resolve to one version; doesn't shrink the download, just the installed footprint.)

**Sizing (re-measured 2026-05-28), still the aggregate even when split:**
- Unpacked: **~310 MB**; gzipped tarball total: **~104 MB**. WASM gzips to ~20-36% of raw (cores ~19%, sdcc ~26%, ARM compiler ~36%).
- npm does NOT hard-block this; the 256MB-unpacked figure is folkloric, not enforced. The real transfer is the tarball, cached after first `npx`.
- (Old README claim "25.5 MB compressed / 83.8 MB unpacked" is **stale** — fixed in the snapshot table.)

**Strip dead weight first (free, do regardless of the split):** cc65 ships multi-MB `.lib` files for platforms we DON'T support — `atari.lib`, `atarixl.lib`, `geos-cbm.lib`, `geos-apple.lib` (Apple II / GEOS / Atari-8bit, ~15 MB combined). Audit every toolchain for unshipped-target artifacts and drop them.

### Package layout (target)

Reorganize toward a clean published tree. Goal: the npm `files` whitelist ships exactly what runs + what agents read, nothing else.

- **`dist/`** — the runnable server + tool code (currently `src/mcp`, `src/host`, `src/toolchains` JS glue, `src/cores`/`src/toolchains` WASM, `src/observer`, `src/playtest`, `src/rom-id`). This is what `npx romdev` executes. (We're plain ESM + JSDoc — no transpile step — so "dist" may just be a curated subset of today's `src/`, not a build output. Decide: rename for clarity, or keep `src/` and just fix the `files` list. Renaming is cosmetic; not a blocker.)
- **`platform-src/`** — the per-platform code examples + bundled SDK/runtime source + starter snippets that agents read and scaffold from (today's `examples/` + `src/platforms/*/lib`). Shipped because the R58 "agents grep their way out of corner cases" model depends on it being present in the install.
- **WASM blobs** — cores (`*_libretro.wasm`) + toolchains (cc1/sdcc/asar/etc.). The heavy bits. Ship as-is (gzip-on-the-wire handles compression); only special-case the 135 MB file if the registry requires it.
- **Build inputs stay OUT.** `build/` (14 GB of upstream core/toolchain source trees) is dev-only, never published — already excluded. Tests excluded via the `files` glob.
- **Fix `package.json`:** `bin` still says `romdev`/`romdev-cli` — rename the primary bin to **`romdev`** so `npx romdev` works.
- **⚠ The WASM blobs are NOT tracked in git** (verified 2026-05-28: `git ls-files src/cores/wasm` is empty; only `build/` and `src/toolchains/*/install/` are gitignored, but the committed-artifact `.wasm` were apparently never `git add`ed). `npm pack` ships from the working tree, so a publish from THIS machine would include them — but **a publish from a clean CI checkout (D5) would ship a package with no cores/toolchains = totally broken.** Resolve before any CI publish: either (a) commit the WASM artifacts to git (simplest, but adds ~210 MB to the repo + bloats clones), (b) use git-LFS for them, or (c) have the release job fetch/restore them from a GitHub Release artifact before `npm publish`. This is a launch-blocking decision, not a detail.

### Cross-platform / cross-arch — mostly free, two caveats

The architecture makes this nearly free, which is the whole bet:
- **WASM is architecture-independent** — the same core/toolchain `.wasm` runs on x64 and arm64 identically. No per-arch builds from us.
- **Node ≥24** covers Linux/macOS/Windows on x64+arm64. The floor is modern on purpose: this is an end-user dev tool, not a library for legacy apps, so requiring current Node is fine — and it lets us lean on the newer/faster V8 WASM engine instead of holding back for an ancient LTS. The runtime also gets faster under us for free as V8 advances; we do no work for that.
- **WASM is already fast enough — performance optimization is explicitly NOT launch work.** The cores run far faster than real hardware (NES ~6-15k fps) and the compilers build in seconds; nothing this week was bottlenecked on WASM execution. Node ≥22 exposes WASM **SIMD + threads**, which *could* make cores/compilers faster still — but that's a **deferred future lever, not a task.** We will not spend launch time on it. Recorded here only so "make the wasm faster" is recognized as optional upside to revisit if a real workload ever demands it (e.g. on-device builds on a weak Pi/handheld), never as a prerequisite. Don't gold-plate a thing that already works.
- **`@kmamal/sdl`** (the playtest window, an `optionalDependency`) ships prebuilt binaries for Linux (x64/arm64), macOS (x64/arm64), Windows (x64), auto-downloaded on install. Self-contained — no system SDL needed.

Caveats to document, not fix:
- **Windows-on-ARM**: `@kmamal/sdl` doesn't list win-arm64; `playtest()` may be unavailable there. The **headless MCP server (the core product) still works** — playtest is optional. Document "playtest needs win-x64/mac/linux."
- **`@kmamal/sdl` is optional**: if its prebuilt download fails, install must still succeed and the server must still run headless. Confirm the optionalDependency degrades gracefully (server boots, only `playtest()` errors with a clear "SDL not available" message).

### Build & CI story — for US + contributors, never for the player

The player builds nothing (`npx romdev`). But the *build* audience — us + occasional contributors regenerating a wasm core/compiler — needs a repeatable, zero-setup builder. Two distinct concerns, and they map cleanly onto GitHub Actions' two execution modes (VM runners vs. containers):

1. **WASM artifact build (rare, heavy) → a Docker/Emscripten CONTAINER, Linux-only, build-once.**
   The key fact: **the wasm build never touches Visual Studio or Xcode — it's Linux + Emscripten, full stop.** emcc compiles C/C++ → wasm; the output is OS- and arch-independent. So you build each `.wasm` ONCE in one Linux container and it runs on every player platform — no per-OS, no per-arch build, no MSVC/Xcode SDK hell. That's *why* Docker fits here (not because containers are trendy): a pinned `romdev/wasm-builder` image (Emscripten version + build scripts) is the **contributor build on-ramp** — anyone on any OS does `docker run --rm -v $PWD:/work romdev/wasm-builder ./build-fceumm.sh` and gets a reproducible wasm with zero local toolchain install. Two front doors, same zero-setup ethos: **players → `npx romdev`** (never build), **builders → `docker run romdev/wasm-builder`** (never install a toolchain). Caveats: Docker is the *recommended* path, not required (the `build-*.sh` scripts also work against a native emcc install — that's `build/` today); and this audience is *tiny + infrequent* (wasm is near-static — see the cadence finding), so it's post-launch, not on the player's critical path. In Actions this is a job with `container: emscripten/emsdk:<pinned>` (or `docker run` as a step) on `ubuntu-latest` — **no OS matrix needed** (wasm is arch-independent).
2. **Release CI (frequent, light) → plain VM runners, full OS matrix, NO container.**
   GitHub Actions matrix on **VM runners** — **{ubuntu, macos, windows} × {x64, arm64 where hosted runners exist}** running `npm ci && npm test` on every PR/tag. Must be VMs, not containers: the whole point is validating the JS + prebuilt wasm actually run on each real OS/arch (closes risk **R5**) — a Linux container can't test macOS/Windows. Release CI does NOT run Emscripten; it tests against the prebuilt wasm + publishes (tag-gated `npm publish` after tests pass). (Verify current hosted-runner labels for linux-arm64 / win-arm64 — availability + free-tier caveats shift.)

**Recommendation:** VM-matrix Actions for release CI (launch-blocking, no container); a containerized Emscripten builder for the rare wasm rebuild (contributor on-ramp + reproducibility, post-launch fine). Not either/or — different tools, different jobs; the WASM-is-Linux-only-and-arch-independent fact is what keeps them from fighting (build once in a container, test everywhere on VMs).

### Rollout task list (ordered)

- [ ] **D1 — Strip dead weight.** Audit `src/toolchains/**` for libs/artifacts of unsupported platforms (cc65 Apple/GEOS/Atari-8bit `.lib`s first). Re-measure. Update the stale README size claim with real numbers.
- [ ] **D2 — `npm publish --dry-run` + `npm pack`, inspect the tarball.** Confirm: (a) the WASM is actually in the tarball (it's NOT in git — see the ⚠ above — so this verifies the working-tree publish path), (b) `build/`+tests excluded, (c) the 135 MB cc1-arm.wasm is accepted (or plan the split). Single highest-information cheap step — **do it first.**
- [ ] **D2b — Decide how WASM artifacts reach a CI publish** (commit / git-LFS / fetch-from-release). Launch-blocking for D5; without it, CI publishes an empty-of-cores package. See the ⚠ in Package layout.
- [ ] **D3 — Rename the bins to `romdev`** in package.json (both: the MCP server `romdev` → primary `romdev`; the CLI `romdev-cli` → keep the `play <rom>`/`identify`/`run` subcommands reachable under `romdev` too, e.g. `romdev play game.gba` — that bonus emulator path already works, just needs the new name). THE acceptance test for the whole rollout: on a clean machine, `npx romdev` (no flags, no prior setup, no custom commands) boots the server AND every platform builds+runs. Verify via `npm pack` → install the tarball in a temp dir → `npx romdev` → exercise one build per platform. If any platform needs an extra command to work, the rollout has failed its north star.
- [ ] **D3b — Change-cadence split:** `romdev` keeps ALL the fast-churning content (server, tools, scaffolds, libs, snippets, debug helpers) + hard-deps on the binary packages. The binaries (emulator cores + compiler wasm) move into `romdev-platform-*` (single-platform binaries) and shared-binary packages (`romdev-core-gpgx`, `romdev-toolchain-sdcc`, `-cc65`) per the shared-binary sub-decision above. Each binary package PUBLISHES only the built wasm+glue; its build recipe (patch + build script + emscripten flags) lives in its repo, `.npmignore`'d. Change core/toolchain resolvers from `__dirname/wasm` to `import.meta.resolve`-of-the-dep-package; NO "not installed" UX (hard deps guarantee presence). Each binary package gets its own heavy Emscripten CI (fires on patch/version change only); `romdev` gets the fast `npm test` CI. **Can ship AFTER a monolith launch if time-constrained** — identical install from the user's view.
- [ ] **D4 — Verify graceful SDL degradation.** Simulate `@kmamal/sdl` install failure; confirm headless server still runs and `playtest()` errors cleanly.
- [ ] **D5 — Release CI:** GitHub Actions matrix (linux/mac/win, x64/arm64) running `npm test`; publish job on tag. Closes R5.
- [ ] **D6 — (post-launch) Publish a `romdev/wasm-builder` Docker image** (pinned Emscripten + build scripts) as the contributor build on-ramp: `docker run --rm -v $PWD:/work romdev/wasm-builder ./build-<core>.sh` → reproducible wasm, zero local toolchain (no VS/Xcode ever — it's Linux+emcc, build-once, arch-independent). Recommended path, not required (scripts also run against native emcc). Small/infrequent audience; not on the player's critical path.
- [ ] **D7 — First-run UX polish:** document that the first `npx romdev` pulls ~104 MB (cached after); suggest `npm i -g romdev` for heavy users; make the server print a clear "ready — point your agent at http://127.0.0.1:7327/mcp" banner.
- [ ] **D8 — Package layout reorg** (`dist/` + `platform-src/`) — cosmetic clarity; do last or defer, it's not blocking `npx romdev` working.

### What romdev produces (positioning — keep this straight)

**The deliverable is the ROM, not the tool.** romdev builds a standard, hardware-valid ROM (`.nes`/`.gba`/`.md`/…) that runs anywhere ROMs run — RetroArch, native emulators (Mesen/mGBA/BizHawk), flash carts, real hardware, a $40 handheld. The user ships the ROM, never romdev. The bundled WASM cores are a **dev instrument** (build → run → screenshot → inspect → iterate), not the distribution runtime; that's why "fast enough" trumps "fast" (frame-step + observe, no playback-grade vsync/audio-sync needed) and why on-device core performance isn't load-bearing (the device plays the ROM in its own native emulator). The one obligation this creates: the dev core and the native emulators the user lands on must **agree** — so keep finalizing ROMs correctly (checksums/headers) and keep the per-platform footgun docs sharp. Value = "the ROM is *correct* and runs everywhere," not "our core plays it."

### Post-launch directions (captured, explicitly NOT v1 — do not let these become scope)

The architecture opens doors we are deliberately NOT walking through for launch. Recorded so the vision isn't lost AND so none of it masquerades as a prerequisite:
- **Cores as a fun player platform.** `playtest()` already proves the WASM cores are a fine *play* surface (SDL window, hot-plug gamepads, on a TV via a Pi). Libretro's frontend feature set is then nearly free to expose: **player-facing save files, save states, shaders, fast-forward/rewind, controller remapping.** Genuinely cool, genuinely feasible — and genuinely not launch work. Revisit after the ROM-build loop is proven.
- **RetroPie / cheap-handheld targets.** "Shell into the Pi, vibe-code a game, play it on the TV." Falls out of WASM-on-ARM + SDL-on-Pi. Three measure-on-hardware unknowns gate it (compiler speed on weak ARM, RAM headroom, SDL-on-TV); the robust universal version that sidesteps all three is **"build anywhere, drop the ROM on the device, play in its stock emulator."** Worth a pre-launch Pi-5 spike ONLY because it'd be the best demo — not because anything depends on it.
- **WASM SIMD/threads perf work** (see Cross-platform note) — optional upside, only if a real workload demands it.
- **romdev as a plain emulator/player.** ALREADY WORKS today: `src/cli/smoke.js` ships a `play <rom-or-zip>` subcommand (SDL window, gamepads, zip handling, platform inference). So someone can just use romdev as a libretro frontend to play any ROM — it's a free bonus of having the cores + SDL on hand. Keep it as a documented nicety; **do NOT build it into a real emulator-frontend product** (ROM browser, settings menus, per-core config — that's the RetroArch surface, a different product). The launch product is the game-*maker*; "it also plays ROMs" is a freebie you mention, not a thing you polish. Only launch action: the `play` path should be reachable under the `romdev` name (folded into D3's bin rename, not new work).

Rule for all of these: WASM is already fast enough and the ROM already runs everywhere. They're upside to revisit *after* v1 is proven, never a gate on it. Don't gold-plate a thing that works.

## Goals

- **Turnkey vibe-coding platform** for retro homebrew. `npx romdev`, point an agent at it, ship games.
- **Agent-first interface.** MCP is primary; CLI exists only for our own smoke tests.
- **One install, all OSes.** Linux, Windows, macOS — no per-OS binaries, no signing dance, no toolchain hunting.
- **Deep dev loop.** Build → run → screenshot → inspect memory → poke state → save/load → iterate.

## Roadmap (v2 direction — data-driven)

> This section absorbs the former `V2_DESIGN.md` (deleted 2026-05-28; this is now the single planning doc). It is direction-setting, not a sprint plan — items become tasks as we pick them up.

### The strategic thesis (the moat)

> "Every existing debugger expects a human at the keyboard. Mesen's Lua API, Emulicious's DAP, mGBA's scripting all exist — but no one has wrapped them behind a uniform `runUntil` / `screenshot` / `traceWrite` interface that an LLM agent can call. **That wrapper is the entire moat.**" — research synthesis, 2026-05-23.

romdev's defensibility is being **the** agent-first interface to retro emulation + toolchain — a deliberately designed surface for agents to make games, not "an MCP wrapper around an emulator." **As of v1 that wrapper exists and ships** (build/run/screenshot/inspect/patch across 13 platforms, deep introspection, sound + music, 5 genre scaffolds). The roadmap below is the *optimization* layer on top of that moat, not the moat itself.

Three sub-theses guide what we add:

1. **Deterministic compute belongs in tools.** LLMs are bad at bit-packing, cycle counting, hex math, bank arithmetic — reliably good at sequencing + intent. Every tool should internalize a category of compute the agent shouldn't do.
2. **Authoritative reference data belongs in tools.** Long-tail domain knowledge (6502 mnemonics, SNES PPU registers, mode-7 transforms) is where LLMs hallucinate most confidently. `lookupRegister(name)` beats hoping the model remembers.
3. **Tool surface should be progressively disclosable.** Anthropic's benchmarks: lazy tool loading moved Opus 4 from 49% → 74% on tool-selection accuracy. (Status caveat: we have the category system but currently load everything at init — see "Progressive disclosure" below.)

### North star

**Democratize retro game dev: a weaker LLM (Sonnet, Haiku, or smaller) should ship a good playable retro game in one prompt-and-iterate session.** A capable agent (Opus-class) already can today; the gap is the weaker model thrashing on multi-step choreography even when each primitive works. The fix is **compression: fewer, smarter, higher-leverage tools backed by real-game data** — added *additively*, never replacing primitives.

### What's shipped vs. open (honest status, 2026-05-28)

**Recipe tier — high-leverage compositions (~40% there).**
Multi-step operations that would cost 5-15 round-trips as primitives.
- ✅ `runUntil` (boot + scripted input + stop on memory/PPU condition), `runUntilWrite`, `watchMemory`, `diffRoms`, `recordSession`.
- ⬜ `verifyGameWorks({rom})` — title → start → 5s play → per-state screenshots in one call.
- ⬜ `buildAndLoad({projectPath})` — build → push to running emulator at last savestate → resume (edit-to-pixels <1s). (`runSource` partially covers this for the live-playtest case.)
- ⬜ `traceWrite({address, savestate})` — replay from savestate, log every write to a range with PC+bank. *The single most-asked question on NESdev.*
- ⬜ `goldenFrameTest` (visual regression via image hash), `diffVram` (symbolic nametable/CHR/OAM/palette diff with "written by PC=$…").

**AAA cross-chip layer — the shipping-game enablers (~5% there).**
Composable operations around the frame budget. Build each only when a real game hits the limit.
- Budget calculators (do-not-trust-LLM): ⬜ `vblankBudget`, `vramFreeBytes`, `aramFreeBytes`, `spritePerLinePredictor`.
- Schedulers: ⬜ `scheduleHdmaGradient`, `setupStatusBarSplit` (generic split-scroll: NES sprite-0 / SNES HDMA / Genesis HINT / GB STAT-LYC), `allocateVramRegion`, `requestVramUpload`.
- Asset compilers (no hallucination surface): ✅ `pcmToBrr` (BRR encoder); ⬜ `generateSmpsSong`, `packOamEntry`, `packTilemap`.
- Lint checks (catch silent landmines): ✅ asar bank-crossing preflight, SDCC pre-flight linter; ⬜ `lintPaletteSlots`, `lintDpcmGlitch`, `lintHardwareSafety`.

**Reference-data tools (partial).** ✅ `lookupAddress`, `getMemoryMap`, `getInputLayout`, `getPlatformDoc`. ⬜ `lookupRegister`, `lookupOpcode`, `lookupMapper` backed by authoritative tables.

**Progressive disclosure — built but not engaged.** The category system exists (`loadCategory` / `listCategories`, 10 categories) but in practice all 101 tools register at session init. The v2 entry-tier funnel (`listTools` / `describeTool` as the ≤5-tool onramp) is only half-present (`describeTool` ✅, `listTools` ⬜). This is the **least-validated** v2 bet — defer the lazy-loading refactor until Phase-1 usage data says capable models actually benefit from a narrower entry (they may not; everything-loaded is working fine for Opus-class agents today).

### API design rubric (apply to every new + existing tool)

1. **Use case first** — description's first sentence is "use this when…", not the mechanics.
2. **≤3 required params, ≤7 total** — every optional gets a server-side default; enums for finite spaces.
3. **`hint` / `nextStep` in every return** — biggest lever for weak-model success; nudge toward the next tool even on success.
4. **Structured errors** `{code, message, suggested_fix, relevant_docs_url}` — never raw stderr.
5. **Shared parameter vocabulary** — `platform`, `projectPath`, `savestate`, `path` mean the same thing everywhere.
6. **Long-running ops return handles, not blocks** — pair every `start_*` with `status_*` / `logs_*`.
7. **Symmetric verb pairs** — `start`/`stop`, `create`/`delete`, `load`/`unload`.
8. **Concise default response; `verbose` opt-in** — truncate logs, paginate lists, return diffs not full payloads.
9. **Idempotent + queryable** — same args twice is safe; `getStatus()` always cheap.
10. **Iterate tool descriptions against evals** — treat descriptions as prompts; test variants.

### Mitigations for known LLM failure modes (each is a tool-shape decision)

- **Hallucination plateau at rounds 5-7** → an explicit `checkpoint_progress({summary})` tool (⬜); recipes that iterate force a checkpoint after N rounds.
- **Weak spatial reasoning** → return structured `{sprite_list, palette, scroll}` alongside every screenshot (✅ `inspectSprites` / `getRenderingContext` do this).
- **Weak visual diff** → return diff *descriptors* (`{changed_tiles, pixel_diff_count, regions}`), not "compare these images."
- **Weak numeric precision** → never ask the agent to compute bits; always ship a `pack_*` / `cycles_until_*` helper.
- **Hallucinated long-tail knowledge** → `lookupRegister` / `lookupOpcode` / `lookupMapper` backed by tables.
- **Generic errors → repeat-mistake loops** → structured error objects (rubric #4).

### Sequencing (revised 2026-05-23, still current)

**SNES → v2 → Genesis.** Drive v2 by *accumulated real usage data*, not the research synthesis alone — "the compression designs itself from real data."

- **Phase 1 — SNES to AAA quality (largely complete).** Driven by the rom-games agent's devnotes; every ask evaluated against "does this unblock a real game?" SPC700 `getCPUState({cpu:"spc700"})` ✅, `getDspState()` ✅, BRR encoder ✅. Cross-chip coordination tools only when a SNES game hits the limit (not yet).
- **Phase 2 — v2 compression refactor (open).** Build the recipe tier + budget calculators + (maybe) progressive disclosure once we know which of the 101 tools agents actually call, where weaker models get stuck, and which primitives keep getting called together. Done condition: a Sonnet/Haiku-class model ships a small SNES or NES game in one session.
- **Phase 3 — Genesis to SNES parity (patterns mostly transfer).** Z80 sub-CPU ≈ SPC700, YM2612+PSG ≈ S-DSP, 68K ≈ 65816 mailbox. `getCPUState({cpu:"z80"})` ✅, `getYm2612State` / `getPsgState` ✅, genesis_plus_gx region patches ✅ — Genesis introspection is already largely shipped; remaining work is HINT raster / plane-coordination / SMPS snippets.
- **Future:** GB parity polish, NES MMC3 effects, MSX/Coleco genre scaffolds, deeper GBA introspection. Order driven by user demand.

What we must NOT do meanwhile: design primitives in ways that make eventual compression harder. Keep tool shapes consistent (path-based I/O, generic cross-platform shapes, named params with defaults) so recipes compose cleanly later.

### Layered API, not replaced API

The v2 compression must be **additive, not subtractive.** Recipes coexist with primitives; capable agents (Opus-class) keep full access. The trap to avoid is a "recipes-only" API that locks capable models out of clever moves (mid-frame ARAM inspection, custom save-state surgery, bespoke disasm queries). Principles:

- **Recipes are public compositions of public primitives.** Never private. If `verifyGameWorks` calls `loadMedia + stepFrames + screenshot` internally, those stay equally callable. The capable agent who wants 9 of 10 steps reaches for primitives.
- **Recipes return everything they captured, not just summaries.** Capable agents using a recipe and then drilling in shouldn't need a second pass — the data's already there.
- **Recipes are documented as "this composes X, Y, Z in pattern P."** So capable agents see the composition and can adapt it. Recipes are teaching examples, not black boxes.
- **Escape hatches everywhere.** `createGame({genre, customMainLoop: "..."})` lets you override scaffold choices when you have a reason. Recipe handles 95% case; escape hatch handles 5%.
- **`listTools()` makes the layering visible.** Group by tier (Primitives / Recipes / Inspection). Capable agents see the whole menu; weaker agents are nudged toward recipes by descriptions that say "use createGame unless you specifically need...".

The mental model: **narrow at entry, deep once you're in.** The first 1-3 tool calls (createGame, loadMedia) are very few options with very prescriptive defaults — the onramp. Once the agent is in a working loop (project exists, ROM loaded), the full primitive surface is available unchanged: inspectSprites, getCPUState, disassemble, dumpState/findHex, custom asset encoders, savestate surgery, anything. Recipes that exist for the in-loop phase (verifyGameWorks, etc.) are convenience layers that save round-trips, NOT gates that hide primitives.

This is how good dev environments work: VS Code has one way to open a project, infinite ways to work within it. Rails has `rails new myapp` (one call, sensible defaults), then the entire framework is available. Make has a default target plus 47 others. The narrow entry isn't a limit — it's an onramp. Once you're on the road, all lanes are open.

Democratization = raising the floor (weaker models can succeed at the entry point). Freedom = keeping the ceiling (capable models still have every primitive once they're moving). Both at once.

## Non-goals (initial scope)

- 32-bit / 64-bit era platforms beyond GBA (N64, PSX, Saturn). GBA shipped (R27/R28, libtonc); the cap is now "GBA and below." N64+ revisited later.
- A GUI / web UI / TUI. Agents drive the system; humans drive the agents.
- Authentic-flicker pixel-perfect display. We're a dev harness, not a player.
- RetroAchievements, netplay, shader chains.
- Mobile / handheld targeting at v1 (although Node + WASM gives this nearly for free later).

## Stack

| Layer            | Choice                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| Runtime          | Node 24+ (ESM)                                                          |
| Language         | Plain JavaScript (ESM) with JSDoc types                                 |
| Emulator backend | libretro cores compiled to WASM via Emscripten (fceumm, gambatte, snes9x, genesis_plus_gx, stella, handy, vice_x64, prosystem, etc.) |
| MCP SDK          | `@modelcontextprotocol/sdk`                                             |
| Image encoding   | `pngjs` (pure JS, no native deps)                                       |
| HTTP fetch       | Node built-in `fetch`                                                   |
| Test runner      | `node --test`                                                           |

Why Node + WASM:

- One `.wasm` core file runs identically on every host. No per-OS binaries, no `dlopen` quirks, no macOS code signing.
- Distribution is `npm install`. End users (non-developers) get a single command.
- Reuses the cliemu JS ecosystem (retroemu, gamepad-node, webaudio-node, napi-canvas, wasmcart).
- WASM perf at the 16-bit-and-below tier runs at many multiples of real-time. No bottleneck for agent-driven workflows.

## Target platforms (all zero-install)

| Platform                  | libretro core (WASM) | Toolchain (WASM)               | Path  |
| ------------------------- | -------------------- | ------------------------------ | ----- |
| NES                       | fceumm               | cc65                           | C or asm |
| Commodore 64              | vice_x64             | cc65                           | C or asm |
| Game Boy / GBC            | gambatte             | RGBDS                          | asm |
| Atari 2600                | stella               | dasm                           | asm |
| Atari 5200 / 7800         | prosystem / a5200    | cc65                           | C or asm |
| Lynx                      | handy                | cc65 (handy variant)           | C or asm |
| Master System / Game Gear | genesis_plus_gx      | sdcc + devkitSMS, or wla-dx    | C or asm |
| SNES                      | snes9x               | asar or WLA-DX (65816 asm)     | asm |
| Genesis                   | genesis_plus_gx      | vasm or asm68k (68k asm)       | asm |
| GBA                       | mGBA                 | vasm-ARM or armips             | asm |

### Key insight: the agent is the programmer

The historical reason for shipping a C compiler per platform was *human* productivity — programmers don't want to write 68k or 65816 assembly by hand. With LLMs doing the coding, that argument disappears. LLMs already know every retro assembly dialect fluently. **The user is a game director with ideas, not a programmer reading the code.**

This makes the toolchain WASM problem dramatically smaller. We don't need m68k-elf-gcc on the Genesis — we need a 68k *assembler* (tiny, trivially Emscripten-able). We don't need devkitARM on GBA — we need an ARM assembler. SNES doesn't need PVSnesLib's whole stack — it needs `asar` or `WLA-DX`.

Standalone assemblers are typically 10-100KB of C code and port to WASM in an afternoon. Full C cross-compilers are tens of MB and weeks of work. This is what makes "zero install for every platform" achievable.

### Toolchain bundling

Every toolchain is bundled as `.wasm` in the npm package. Building a ROM is a `child_process` invocation of `node` running e.g. `asar.wasm` against an Emscripten NODEFS temp dir. Same workflow on every OS, no install step, no PATH fiddling.

**Compilers (C path, for platforms where it's clean and adds little cost):**

- **cc65** → NES, C64, Atari 5200/7800, Lynx. Plain C; own Emscripten build.
- **sdcc** → Game Boy (sm83 port, default C path), Sega Master System / Game Gear (z80 + custom crt0), MSX, ColecoVision.

**Assemblers (asm-first path, esp. for 16/32-bit where the C toolchain is heavy):**

- **dasm** → Atari 2600 (6502/6507). Tiny port.
- **RGBDS** → Game Boy / GBC (SM83). [RGBDS-Live](https://gbdev.io/rgbds-live/) upstream WASM build exists.
- **WLA-DX or asar** → SNES (65816). Asar in particular is a single C++ file with no big deps.
- **vasm or asm68k** → Genesis (68k). vasm is multi-CPU and well-maintained.
- **vasm-ARM or armips** → GBA (ARM7TDMI).

### Starter libraries — minimal in v1, full SDK runtimes deferred

For each platform we ship a **minimal** starter library under `src/platforms/<name>/lib/` — just enough to bootstrap a game: VDP/PPU init, VBlank handler skeleton, basic input read, simple sprite dispatch. The agent extends from there.

**What we deliberately do NOT ship in v1:** the big SDK runtimes — SGDK's full sprite engine + Z80 sound driver + image converter pipeline; PVSnesLib's complete HDMA + sound + tile pipeline; devkitARM's libgba. Replicating those properly is weeks of work each. The agent can write what it needs in-place; the starter library is a launchpad, not a framework.

These SDK-equivalent runtimes become a follow-on workstream once v1 platforms are solid.

Tradeoff: WASM compilers run ~5-10x slower than native (small NES build: ~50ms → ~500ms). Imperceptible for the agent's iteration loop; not worth optimizing.

### Why this combination is fast

The constraint nature of these old systems is a feature. Estimated end-to-end agent iteration latency (compile → load → step 60 frames → screenshot):

| Platform     | Compile      | Load + sim 60f | Screenshot | Total       |
| ------------ | ------------ | -------------- | ---------- | ----------- |
| Atari 2600   | ~5-15 ms     | ~5 ms          | ~10 ms     | **~20-30 ms** |
| Game Boy     | ~50-100 ms   | ~10 ms         | ~10 ms     | **~70-120 ms** |
| NES / C64    | ~150-400 ms  | ~10 ms         | ~15 ms     | **~175-425 ms** |

These are tool-side latencies only. The bottleneck of the agent loop is *the LLM generating code*, not us. Atari 2600 in particular is small enough that an agent could plausibly do dozens of compile-run-screenshot cycles per second.

Design implication: the harness must support high-frequency calls. `stepFrames(10000)` should return in well under a second so an agent can scrub through long runs for debugging. Don't add round-trip overhead, don't write framebuffers to disk on hot paths.

## Architecture

### High level

```
┌─────────────────────────────────────────────────┐
│ Coding Agent (Claude, Codex, etc.)              │
└──────────────────┬──────────────────────────────┘
                   │ MCP (stdio)
┌──────────────────▼──────────────────────────────┐
│ romdev server  (src/mcp)                   │
│ tools: loadMedia, stepFrames, screenshot, …     │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│ Harness  (src/host)                             │
│ - WASM libretro core loader                     │
│ - frame loop, callbacks, framebuffer            │
│ - save state, memory, input state               │
└────┬──────────────────┬──────────────────┬──────┘
     │                  │                  │
┌────▼─────┐    ┌───────▼──────┐    ┌──────▼──────┐
│ Toolchain│    │  Platforms   │    │  Core cache │
│ managers │    │  (NES PPU,   │    │  (.wasm dl)│
│ (cc65 …) │    │   C64 KERNAL)│    │             │
└──────────┘    └──────────────┘    └─────────────┘
```

### Module layout

```
romdev/
├── PLAN.md
├── README.md
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── host/                     # WASM libretro host
│   │   ├── core.ts               # core load + retro_* binding
│   │   ├── callbacks.ts          # video/audio/input/env callbacks
│   │   ├── memory.ts             # retro_get_memory_data + region enum
│   │   ├── state.ts              # serialize/unserialize in-memory
│   │   ├── input.ts              # per-frame input state
│   │   ├── framebuffer.ts        # XRGB8888 + PNG encode
│   │   └── types.ts              # MediaKind, MemoryRegion, …
│   ├── mcp/                      # MCP server
│   │   ├── server.ts             # stdio bootstrap
│   │   └── tools/
│   │       ├── lifecycle.ts      # loadMedia / pause / reset / shutdown
│   │       ├── frame.ts          # stepFrames / screenshot
│   │       ├── input.ts          # setInput / pressButton / sequence
│   │       ├── state.ts          # saveState / loadState / listStates
│   │       ├── memory.ts         # readMemory / writeMemory / watchMemory
│   │       ├── core.ts           # listCores / installCore
│   │       ├── toolchain.ts      # listToolchains / installToolchain
│   │       └── build.ts          # buildProject
│   ├── cores/                    # core registry (which .wasm for which platform)
│   ├── toolchains/               # per-platform installers
│   │   └── cc65/
│   ├── platforms/                # per-platform memory interpretation
│   │   ├── nes/
│   │   │   ├── ppu.ts            # tile/sprite/palette decoders
│   │   │   └── symbols.ts        # cc65 .dbg parser
│   │   └── c64/
│   └── cli/
│       └── smoke.ts              # local smoke-test harness
├── cache/                        # (gitignored) downloaded cores + toolchains
└── test/
```

`cache/` is created at runtime under the OS user-data dir (e.g. `~/.local/share/romdev` on Linux) using Node `os.homedir()`. The in-repo `cache/` is only used when developing.

### Key types

```ts
type MediaKind = "cartridge" | "disk" | "tape" | "program";

type MemoryRegion = "system_ram" | "save_ram" | "video_ram" | "rtc";

interface LoadMediaArgs {
  platform: string;       // "nes", "c64", ...
  path: string;
  mediaKind?: MediaKind;  // defaults: cartridge for consoles, program for C64
}

interface InputFrame {
  // libretro RETRO_DEVICE_JOYPAD button bitfield, per port
  ports: Array<{
    up?: boolean; down?: boolean; left?: boolean; right?: boolean;
    a?: boolean; b?: boolean; x?: boolean; y?: boolean;
    l?: boolean; r?: boolean; l2?: boolean; r2?: boolean; l3?: boolean; r3?: boolean;
    start?: boolean; select?: boolean;
  }>;
}
```

### Conventions adopted from existing cliemu work

These come from `wasmcart-libretro` and `retroemu/`; do not re-derive them:

- **Framebuffer is XRGB8888.** No alpha used, no conversion in fast path. Match libretro environment callback's pixel format negotiation.
- **Audio is S16 stereo, 48000 Hz**, ring-buffer drained per frame. F32 sources get converted in the host, not exposed to the agent.
- **Input shaped like W3C Gamepad API** (buttons + axes), mapped to libretro JOYPAD inside the host.
- **GL state save/restore around each frame** — for cores that touch GL state (Genesis Plus GX hardware mode, SNES with HD mode 7, etc.). NES/GB/Atari are software-rendered and don't need this, but the harness must do it once we move past those.
- **Save states are `Uint8Array` in memory**, named slots keyed by string. Disk persistence is an opt-in tool, not the default.

### Native dependencies: just node-sdl

The ONLY native dependency in the entire stack is [`node-sdl`](https://github.com/kmamal/node-sdl) — well-maintained, ships prebuilds for Linux/macOS/Windows via npm. Everything else (libretro cores, toolchains, framebuffer encoding, save states, memory inspection) is pure WASM or JS.

This gives us a clean two-mode split:

**Headless agent dev mode (default, MCP-driven, v1 scope):** Zero native deps. Pure Node + WASM. Agent calls MCP tools; framebuffer comes back as PNG; input goes through deterministic `setInput` / `pressButton`. Works identically on every Node 24+ host with no system libraries required. This is also the mode that runs in CI.

**Playtest mode (optional, post-v1):** Pulls in `node-sdl` for:
- Real gamepad input via [`gamepad-node`](../gamepad-node), so a human game director can grab a controller and feel the game.
- Audio playback (the libretro core emits S16 stereo PCM via `retro_audio_sample_batch`; SDL's audio sink plays it).
- Display window for live viewing.

Agent input is always deterministic via MCP, never via `gamepad-node`. Playtest mode is for the human reviewing what the agent built.

### Audio specifics

We're not building JavaScript games — the libretro core produces PCM directly. v1 audio: buffer the S16 stereo 48000Hz stream in memory and expose via a `getAudioBuffer` MCP tool for the rare case an agent wants to inspect it. Most of the time the agent loop runs silent; agents don't have ears, and that's fine.

`webaudio-node` is not used here — it solves JS-game synthesis, which doesn't apply. Playtest audio playback goes through `node-sdl`'s audio sink, the same dep used for gamepad input.

## v1 MCP tool surface

Tools must have structured argument schemas, deterministic outputs, and tool descriptions written for an agent.

| Tool                       | Purpose                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `listCores`                | Enumerate available + installed libretro cores.                                  |
| `installCore`              | Download `.wasm` core into cache. Returns path.                                  |
| `listToolchains`           | Enumerate available + installed homebrew toolchains.                             |
| `installToolchain`         | Download + extract toolchain for current OS. Returns install prefix.             |
| `loadMedia`                | Load ROM/disk/tape/program into a fresh harness instance.                        |
| `unloadMedia`              | Tear down current media + free WASM instance.                                    |
| `stepFrames`               | Run N frames. Returns frame count + last-frame metadata.                         |
| `screenshot`               | Capture current framebuffer as inline base64 PNG.                                |
| `setInput`                 | Set persistent input state (held buttons stay held).                             |
| `pressButton`              | Press a button for N frames then release. Convenience over `setInput`+`stepFrames`. |
| `inputSequence`            | Run a scripted sequence of frame-by-frame inputs. Useful for replays.            |
| `saveState`                | Snapshot current emulation into a named slot.                                    |
| `loadState`                | Restore a named slot.                                                            |
| `listStates`               | List named save state slots.                                                     |
| `readMemory`               | Read range from a memory region.                                                 |
| `writeMemory`              | Poke a range. Optional, gated, helpful for debug.                                |
| `watchMemory`              | Step N frames, diff a region each frame, return every change with current PC. Frame-level (not instruction-level). Cross-platform. Pair with `pressDuring` to drive input mid-watch. |
| `runUntilWrite`            | Step until target byte changes, return the writing frame + PC. Pair with `disassembleRom near pc` to find the writing instruction. |
| `whichTilesAreRendered`    | Walk current frame's BG nametable + OAM, return the set of tile IDs actually being drawn. Sample at multiple states + diff to map tile IDs → game assets. |
| `buildProject`             | Run platform toolchain against a project directory. Returns build log + ROM path. |
| `pause` / `resume` / `reset` | Lifecycle controls.                                                            |
| `getStatus`                | Current platform, core, loaded media, frame count, paused state.                 |

Out of v1 (will follow soon): symbol-aware memory inspection, tile/sprite/palette viewers, breakpoint-on-write, audio sample export, project scaffold (`createProject`).

Since v1: the surface has grown to ~65 tools across 9 progressive-disclosure categories. Notable additions:
- **Disassembly + ROM hacking** (`disassembleRom` with auto-tagged vector labels, HW register names, file-offset comments — NES emits both `.nes` and `prg.bin` offsets to avoid the iNES-header off-by-16 footgun — and mapper-aware addressing; `patchFile` with expect-check; `assembleSnippet` (6502/65816/68k/z80/sm83); `diffRoms`; `findFreeSpace`; `findReferences`; `spliceCHR` (with `bank` arg + `paletteHint` for explicit RGB→index mapping); `extractCart` / `wrapRomFromParts`; `extractSpriteSheet` (with `bank` arg + `paletteFromEmulator` for live-palette colorization); `findEncodedText` (returns both file + prg offsets)).
- **Debugger-style introspection** (`watchMemory`, `runUntilWrite` — cross-platform frame-level memory-write tracing with PC reporting; `whichTilesAreRendered` — current-frame tile-ID set from nametable + OAM, for tile→asset mapping by diffing across game states; `addressToSymbol` — translate a PC to the nearest C function name using sdld .map / ld65 .sym tables, closes the C-debug gap on SDCC/cc65 builds).
- **SDCC pre-flight linter** (2026-05) — `buildSource` scans C sources for C89 violations (mid-block declarations, C99 inline for-loop counters) so SDCC's own (misleading) syntax errors don't bite agents. The previous incarnation flagged a big catalog of "register-pressure crash patterns" (parallel array writes, multi-array indexed reads, for-loops with function calls, nested-if return clusters) — those were diagnosed as an emscripten stack-overflow bug (see R7 entry below) and removed. `lint:"strict"` arg fails the build on any lint hit. Multi-TU builds report `failedTU` + `failedTUHostPath` + `compiledOK`. `runSource` surfaces lint warnings too.
- **SDCC sm83 stack-overflow fix (R7, 2026-05-25)** — root-caused the "register allocator crash family" (`dbuf_append_str NULL`) to emscripten's default 64 KB WASM stack overflowing past `__data_end` and zeroing the static `sm83_regs[]` table. Fixed in `scripts/_lib.sh` with `-s STACK_SIZE=8388608` (8 MB). Patterns #1..#10 / #37 / #38 / #39 from earlier agent notes all compile cleanly. The `unroll.h` macros + 9-pattern preflight linter were retired; the only SDCC sm83 quirk left is C89 syntax.
- **Symbol-aware debug** (`buildSourceWithDebug`, `resolveSymbol`, `lookupAddress`, `listSymbols`, `getMemoryMap`).
- **CPU/DSP state inspection** (`getCPUState`, `getDspState`, `getYm2612State`, `getPsgState`).
- **Tile-level introspection** (`getTile`, `tileFingerprints`, `tilesAscii`, `inspectPatternTiles`, `inspectBackgroundMap`, `inspectSprites`, `inspectPalette`).
- **Audio/asset pipeline** (`convertImageToTiles`, `imageToTilemap`, `pcmToBrr`, `pcmToWav`, `recordAudio`).

See `AGENTS.md` for the agent-facing tour of the full surface; `listCategories()` + `loadCategory()` + `describeTool()` is the live introspection path.

## Milestones

### M0 — Survey & scaffolding ✅ done

- [x] Stack decision: Node + WASM (after rejecting Rust + native libretro)
- [x] Location: `~/code/cliemu/romdev/`
- [x] Plan + README
- [x] `package.json`, ESM, `.gitignore`. (No `tsconfig.json` — plain JS chosen.)
- [x] Captured retroemu + wasmcart-libretro patterns to memory `libretro-wasm-patterns.md`

### M1 — WASM libretro host, headless ✅ done

- [x] `LibretroHost` class loads Emscripten libretro cores
- [x] env / video_refresh / audio_sample / audio_sample_batch / input_poll / input_state callbacks via `addFunction`
- [x] `loadMedia({ platform, path, mediaKind })` writes ROM to MEMFS + calls `retro_load_game`
- [x] `stepFrames(n)` loops `retro_run` with no pacing (agent mode)
- [x] `screenshot()` returns base64 PNG; supports XRGB8888 / RGB565 / 0RGB1555
- [x] CLI smoke binary at `src/cli/smoke.js`

Acceptance met: `nestest.nes` boots in fceumm, screenshot matches the expected NES test menu.

### M2 — Input + state + memory ✅ done

- [x] `setInput`, `pressButton`, `inputSequence`
- [x] `saveState` / `loadState` / `listStates` (in-memory `Uint8Array` slots)
- [x] `readMemory` for SYSTEM_RAM / SAVE_RAM / VIDEO_RAM / RTC
- [x] `writeMemory`
- [x] `watchMemory` — frame-level write trace via per-frame readMemory diff; reports `{ frame, offset, before, after, pc }`. Plus `runUntilWrite` (step-until-byte-changes variant). Cross-platform; instruction-level breakpoints deferred to core-side patches.

### M3 — MCP server ✅ done

- [x] stdio MCP server using `@modelcontextprotocol/sdk`
- [x] All M1+M2 tools registered + 8 lifecycle/control tools
- [x] In-memory MCP integration test drives the full surface (`test/mcp.test.js`)

### M4 — Cores & toolchains ✅ done

- [x] Cores bundled in `src/cores/wasm/` (22 libretro cores from retroemu)
- [x] `cc65.wasm` + `ca65.wasm` + `ld65.wasm` built from upstream via `scripts/build-cc65.sh`
- [x] cc65 runtime libs / headers / cfg / target shipped under `src/toolchains/cc65/share/cc65/`
- [x] `buildSource` MCP tool produces a `.nes` ROM end-to-end
- [x] `installToolchain` MCP tool — bundled cores are always "installed"
- [x] `installCore` — not needed; cores ship bundled

End-to-end test passing: agent runs `buildSource({ platform: "nes", source: "void main(void){}" })` → gets a 40976-byte iNES file → loads in fceumm → screenshot.

### M5 — Second platform (C64) ✅ done

- [x] cc65 toolchain covers C64 (its original target)
- [x] Example at `examples/c64/main.c` compiles
- [x] `vice_x64.wasm` emulator core built and shipped (~2.3 MB)
- [x] `media_kind` plumbing in place for `.prg` / `.d64` / `.t64` / `.crt`
- [x] Full loop verified: cc65 → .prg → VICE → screenshot shows real C64 BASIC boot prompt with the agent's printf output

### M6 — Sprite/tile/palette inspection ✅ done

Shipped well beyond the original NES-first scope: `inspectSprites`, `inspectPalette`, `inspectPatternTiles`, `inspectBackgroundMap`, `getRenderingContext` plus the per-platform debug helpers (`ppu.js` / `vdp.js` / `maria.js` / `tia.js`) are wired across all "deep" platforms (10 of 13 — see BUILDING.md status legend). cc65 symbol parsing landed via `addressToSymbol` / `buildSourceWithDebug`. (Originally tracked as tasks #29/#30 and marked "pending"; closed out across the M7/M8 platform rounds.)

### M7 — 8-bit platform expansion ✅ done

- [x] Atari 2600 (stella2014 + dasm) — full loop verified. stella2014 patched to expose a26_tia_regs (32-byte TIA snapshot: VSYNC/VBLANK/NUSIZ/COLUPx/PFx/CTRLPF/GRPx/HMxx/AUD) + a26_cpu_regs (7-byte 6502 snapshot). inspectPalette / inspectSprites (5 graphics objects state + per-scanline composition PNG) / getCPUState / getRenderingContext / disassembleRom + findReferences (anchored at $F000-$FFFF; vector labels at $FFFA). Starter snippets in src/platforms/atari2600/lib/.
- [x] Game Boy / GBC (gambatte + RGBDS asm + SDCC sm83-port C) — full loop verified, Nintendo logo renders. gambatte patched to expose gb_vram, gb_oam, gb_io, gb_hram, gb_bgpdata, gb_objpdata, gb_cpu_regs for inspectSprites/Palette/PatternTiles/getCPUState/getRenderingContext. Built-in JS SM83 disassembler in disassembleRom + findReferences. **Default language flipped to C** in 2026-05 — `buildSource({platform:"gb", source})` routes through SDCC's sm83 port; pass `language:"asm"` for the RGBDS path. **GBDK-lite runtime (2026-05, R9 self-contained policy):** `gb_hardware.h` (full I/O register map), `gb_runtime.h` + `gb_runtime.c` (`wait_vblank` LCD-off-safe, `joypad_read`, `oam_dma_copy`, `oam_clear`/`oam_set`/`oam_dma_flush` + `shadow_oam[160]`, `memcpy_vram`, `lcd_init_default`), `gb_crt0.s` (custom crt0 reserving $0100-$014F header window + `init:` at $0150), `patch-header.js` (standalone Nintendo logo + checksum patcher). All copied into the project by `createProject({platform:"gb"|"gbc", template:...})` — **not auto-injected** at build time. The R7 SDCC stack-overflow fix (`-s STACK_SIZE=8388608`) is still in place so for-loops + parallel array writes + indexed-with-mul reads compile cleanly. SDCC sm83 is C89-only — declare loop vars at top of blocks.
- [x] Atari 7800 (prosystem + cc65) — full loop verified. prosystem patched to expose a78_cpu_regs (7-byte 6502 snapshot from sally globals); MARIA regs + RAM + ROM are all already visible via the existing `system_ram` (memory_ram[65536] = full 6502 address space). inspectPalette (decoded MARIA palette block at $20-$3F into 8 palettes × 3 colors + backdrop) / inspectSprites (MARIA control regs + DPP for the agent to walk display lists) / getCPUState / getRenderingContext / disassembleRom + findReferences (top 16 KB by default). Starter snippets in src/platforms/atari7800/lib/.
- [x] Commodore 64 — deep introspection (vice patched). Build was already wired (M5); this milestone adds the libretro-side memory regions: `c64_color_ram` (1 KB), `c64_vic_regs` (64 B from `vicii.regs`), `c64_sid_regs` (29 B via `sid_peek`), `c64_cia1_regs` / `c64_cia2_regs` (16 B each from the cia_context's c_cia[]), `c64_cpu_regs` (7 B 6510 snapshot). The CPU snapshot reads from `romdev_reg_a/x/y/p/sp` globals — lifted out of `maincpu_mainloop()`'s static locals via `#define` aliasing, so they reflect the live state every instruction. inspectPalette renders the 16-color hardware palette + the VIC-II's current border/bg/extra-bg indices. inspectSprites returns the 8 MOBs with the screen-RAM sprite-data pointers at $07F8 so the agent can find each sprite's pixel block. getRenderingContext decodes mode/scroll/colors/sprites/VIC bank/screen-base/char-base. disassembleRom + findReferences accept `.prg` files (2-byte load-address header) + C64 register annotation. Starter snippets in src/platforms/c64/lib/ (vic_init / sprite_table / sid_play / read_joystick / basic_stub).
- [x] Lynx (handy + cc65 handy variant) — full loop verified
- [ ] Atari 5200 (atari800 + cc65) — toolchain works, core needs Asyncify rebuild
- [x] Master System / Game Gear (genesis_plus_gx + sdcc) — full loop verified
- [x] MSX (fmsx + sdcc) — full loop verified
- [ ] ZX Spectrum (fuse + sdcc) — toolchain works, .tap wrapper works; fuse libretro core rejects retro_load_game for tapes in headless mode (verified with libspectrum's own standard-tap.tap fixture). Needs core-side investigation — fuse may want tapes via a runtime "load tape" command rather than retro_load_game.
- [x] ColecoVision (gearcoleco + sdcc) — full loop verified

### M8 — 16-bit platforms (assembler-first, minimal runtime) ✅ done

- [x] SNES (snes9x + asar) — full loop verified
- [x] Genesis (genesis_plus_gx + vasm68k) — full loop verified
- [x] Minimal starter examples per platform (`examples/snes/main.asm`, `examples/genesis/main.s`)

### M9 — GBA ✅ done

Shipped R27/R28. mGBA core (build + run + screenshot; introspection "shallow" per BUILDING.md), arm-none-eabi-gcc toolchain with **libtonc** as the default runtime (`runtime:"libgba"` and `"none"` also available), all 5 genre scaffolds + `tonc_hello`/`tonc_hello_sprite` + `maxmod_demo` music. The canonical GBA gotcha (`irq_init(NULL); irq_add(II_VBLANK, NULL);` before `VBlankIntrWait()` or the BIOS halts forever) is handled in every scaffold + documented in the GBA TROUBLESHOOTING.md. Deeper GBA introspection (sprite/PPU decode) is post-v1.

### Post-v1 — Full SDK runtimes

Replicate the convenience layers from the historical C SDKs. Each is weeks of work; revisit once usage patterns emerge.

- [x] **C for SNES end-to-end + PVSnesLib bundled.** (R15/R16/R18, 2026-05-26)
  - **R15/R16:** Pipeline shipped — `tcc-65816` (alekmaul TinyCC fork → WASM via `scripts/build-tcc816.sh`) → `wla-65816` + `wlalink` (vhelin WLA-DX → WASM via `scripts/build-wladx.sh`, two-stage build with native instruction-table generator) → minimum-viable crt0 + hdr.asm under `src/platforms/snes/lib/c/` (original code).
  - **R18:** Idiomatic PVSnesLib runtime bundled under `src/platforms/snes/lib/pvsneslib/` (4 precompiled .obj files = 664 KB; 240 KB of headers; MIT license shipped). `buildSnesC` now has two modes: `pvsneslib:true` (default) links the runtime so `#include <snes.h>` + `consoleDrawText`, `setMode`, `WaitForVBlank`, `padsCurrent`, etc. work out of the box; `pvsneslib:false` preserves R16's bare-main path. Discovered during the spike: 816-opt + constify are optimization-only passes, not correctness — wla-65816 can consume tcc's raw output directly, so we skip them entirely. Tests: `snes-c.test.js`, `pvsneslib.test.js`, `snes-c-e2e.test.js` (MCP → snes9x).
- [x] **C for Genesis end-to-end + SGDK bundled.** (R20, 2026-05-26)
  - **Stage 1 (native bootstrap):** binutils 2.42 → gcc 14.2.0 stage 1 → newlib 4.4.0 → gcc 14.2.0 stage 2 cross-toolchain for `m68k-elf` built natively (script: `scripts/build-m68k-toolchain.sh`). Required newlib patches: `_LDBL_EQ_DBL=1` so libm/complex compiles for m68k (long-double = double on this target), and configure.host swap of `-DHAVE_SYSTEM` for `-DNO_EXEC` so bare-metal m68k doesn't pull in an undefined `_system`. `--disable-libgloss` to skip the sim/io stub libs.
  - **Stage 2 (WASM port):** `cc1` (gcc C frontend, 17.5 MB), `m68k-elf-as` (binutils assembler, 889 KB), `m68k-elf-ld` (linker, 1.2 MB), `m68k-elf-objcopy` (ELF→raw, 681 KB) compiled to WASM via Emscripten with MODULARIZE + EXPORT_ES6 + ALLOW_MEMORY_GROWTH. cc1 needed `INITIAL_MEMORY=128MB` (default 16 MB OOMs immediately on real source). libiberty `psignal` fallback signature clashed with emscripten signal.h; resolved by setting `HAVE_PSIGNAL=1` in libiberty/config.h. gcov-tool depends on `ftw()` which emscripten libc lacks — bypassed by `make cc1` directly instead of `make all-gcc`. Script: `scripts/build-m68k-wasm-tools.sh`. Glue files are `.mjs` (emcc EXPORT_ES6 generates ESM with `import.meta.url`); `wasm-worker.js` updated to accept either `.js` or `.mjs`.
  - **Stage 3 (SGDK runtime + onramp):** `libmd.a` (2.6 MB, 77 .o files), `sega.s` crt0 (raw original + cpp-preprocessed `sega.preprocessed.s` for the WASM `as` path), `rom_header.c`, `md.ld` linker script, full `include/` header tree (69 headers) bundled under `src/platforms/genesis/lib/sgdk/`. MIT LICENSE + GPL libgcc-runtime-exception COPYING.RUNTIME shipped. `buildGenesisC` has two modes: `sgdk:true` (default, links libmd.a + rom_header.bin + sega.o + libc/libgcc) and `sgdk:false` (minimum-viable: bare main → 256-byte vector + header → raw ROM). New createProject template `genesis/sgdk_hello` ships the full ~3 MB runtime INTO the user's project tree (libmd.a + sega.s/sega.preprocessed.s + md.ld + rom_header.c + LICENSE + 69 SGDK headers) per the project-self-containment policy: a Genesis SGDK project rebuilds on any machine with `m68k-elf-gcc` installed, no romdev required, and contains zero scripts (cross-platform-by-construction). Tests: `genesis-c.test.js`, `sgdk.test.js`, `project-genesis-sgdk.test.js`.
- [x] **Onramp parity across Genesis / SNES / GB / GBC** (R21, 2026-05-26)
  - **Templates:** added 5 new Genesis SGDK templates (hello_sprite, tile_engine, shmup, platformer, puzzle) on top of the existing sgdk_hello, factored the SGDK runtime bundle to a `SGDK_RUNTIME` constant for clean reuse. Added 4 new SNES PVSnesLib templates (hello_sprite, shmup, platformer, puzzle) with hand-authored 4bpp sprite + palette `.asm` siblings (tcc-65816 is C89, so all declarations live at block top). Added 3 new GB SDCC sm83 templates (shmup, platformer, puzzle) using the same gb_runtime helpers as the existing default/hello_sprite/tile_engine.
  - **createGame:** extended GENRE_MAP from NES-only to **NES + GB + GBC + SNES + Genesis**, all three genres (shmup / platformer / puzzle). The createGame tool description + parameter docs updated to match.
  - **Per-platform docs:** new `src/platforms/genesis/MENTAL_MODEL.md` + `TROUBLESHOOTING.md` and `src/platforms/snes/MENTAL_MODEL.md` + `TROUBLESHOOTING.md` — same shape as the existing NES + GB docs (memory map → PPU/VDP architecture → frame heartbeat → build pipeline; troubleshooting covers blank screens, missing sprites, palette / colour gotchas, link errors, build-size overflow).
  - **Debug helper:** new `src/platforms/genesis/vdp.js` with `decodeSAT`, `decodeCRAM`, `decode4bppTile`, `decodeGenesisSubpalette`, `rgbToGenesisColor`, `decodeVDPRegs` — parity with the existing `nes/ppu.js`, `gb/ppu.js`, `snes/ppu.js`. 9 unit tests in `vdp.test.js`.
  - **createProject gbc fix:** `createProjectImpl` was mapping `LIB_PLATFORM` for gbc → gb but not `EXAMPLES_DIR`, so any new gbc template request looked under `examples/gbc/` (nonexistent). Aliased to read from `examples/gb/` instead.
  - **Tests:** new `test/r21-template-parity.test.js` (compiles every new Genesis SGDK template + every new SNES PVSnesLib template + every new GB sm83 template end-to-end and asserts header / size sanity); new `test/r21-creategame-parity.test.js` (asserts the full 5-platform × 3-genre grid of createGame calls all scaffold). 162 → 175 tests passing.
- [x] **Onramp parity for SMS / Atari 7800 / Atari 2600** (R22, 2026-05-26)
  - **SMS:** 5 new SDCC z80 templates (hello_sprite, tile_engine, shmup, platformer, puzzle) on top of the existing default. Factored `SMS_RUNTIME` constant in project.js since they all link against the same vdp_init/load_palette/load_tiles/vblank_wait/joypad_read/sprite_table runtime helpers. Added `MENTAL_MODEL.md` + `TROUBLESHOOTING.md` for SMS. createGame extended to support SMS. `vdp.js` was already 456 lines — complete debug helper.
  - **Atari 7800:** promoted from SIMPLE_STARTERS to TEMPLATES. 4 new cc65 templates (hello_sprite, shmup, platformer, puzzle). Used per-object Display List entries (MARIA's architecture) instead of NES-style sprite tables because the 7800 has no OAM and only 4 KB of RAM (too small for software-rendered framebuffer). Added MENTAL_MODEL + TROUBLESHOOTING — 7800 docs emphasize how different MARIA is from PPU-style chips. `maria.js` already complete.
  - **Atari 2600:** promoted from SIMPLE_STARTERS to TEMPLATES. 2 new dasm templates (paddle = Pong-style two-paddle + ball; single_screen = dodge-the-falling-pixels using P0 + M0). Per-platform docs added — the 2600 doc emphasizes "racing the beam" since the platform has no framebuffer and 128 bytes of RAM. `tia.js` already complete (355 lines).
  - **New tool: `getPlatformDoc` + `listPlatformDocs`** in `src/mcp/tools/platform-docs.js`. Templates and TROUBLESHOOTING files reference `MENTAL_MODEL.md` for the architecture overview, but until this round agents had no way to actually read those markdown files through MCP. The new tools expose them. Also: createProject now ships MENTAL_MODEL + TROUBLESHOOTING INTO the user's project tree alongside main source, so the references resolve locally too. Cross-references in the docs updated to mention `getPlatformDoc({platform, name:"mental_model"})` for discoverability.
  - **Tests:** new `test/r22-template-parity.test.js` (compiles every new SMS/7800/2600 template + asserts createGame supports new platforms) + new `src/mcp/tools/platform-docs.test.js` (4 unit tests for listPlatformDocs / getPlatformDoc happy paths + errors). 175 → 183 passing.
- [x] **Human-in-the-loop polish for the playtest path** (R23, 2026-05-26)
  Driven by feedback from another agent designing a hackathon scaffold (Token Burn) where non-coders direct an agent and play their game live for 6 hours. The big idea: the human should be *playing* their game, not watching screenshots scroll past. Four pieces:
  - **AGENTS.md instruction**: new prominent section near the top — "If a human is watching, open playtest early" — explaining what playtest does, exactly which two MCP calls open it (`loadCategory({category:"show"})` then `playtest()`), and that other tools keep working live against the same ROM. Delivered as server instructions at connect time, so every consumer sees it.
  - **runSource one-shot hint**: when a runSource call succeeds and no playtest window is open, attach a `hint` field to the response nudging "open playtest if a human is watching." **Once per session** (gated by per-`sessionKey` Set in toolchain.js) so legitimate headless flows (CI, automated tests, batch RE) get exactly one nudge then never again. New `isPlaytestRunning()` export on playtest.js for cheap state probing.
  - **Controller hot-plug** in playtest.js: previously the SDL controller was opened once at startup and a second/replacement pad was silently ignored. Now subscribes to `sdl.controller.on('deviceAdd' | 'deviceRemove', ...)`, maintains a two-slot map (port 0 = first pad, port 1 = second), and feeds both ports into `host.setInput`. Re-add after remove fills the lowest empty slot, so player 1 stays player 1 across reconnects. Listeners detached on `stop()`.
  - **Sports + racing genres on every tier-1 platform** (NES, GB, GBC, SNES, Genesis, SMS, Atari 7800). Sports = Pong; on platforms with two controller ports (NES port1, Genesis JOY_2, SNES padsCurrent(1), SMS PORT_JOY_B + PORT_JOY_A high bits, Atari 7800 SWCHA low nibble), the second pad drives the right paddle with AI fallback when no second pad is plugged in. On GB/GBC (single controller port, no native 2P hardware), sports is player-vs-AI by design. Racing = endless 3-lane top-down dodge, single-player on every platform. SMS got a new `sms_joypad_read_p2()` runtime helper that reassembles P2's awkward split-across-$DC-and-$DD bit layout into the same P1 bit shape. SNES + Atari 7800 needed new sibling .asm sprite-data files (`sports-data.asm`, `racing-data.asm`); Atari 7800's MARIA per-object DL pattern is the same one the existing 7800 shmup uses. Atari 7800 sports uses tall thin canvases (4 bytes × 96 rows × 3 buffers = 1.1 KB) to fit in 4 KB RAM.
  - **Tests:** new `test/runsource-playtest-hint.test.js` (2 tests — first call has hint, second in same session does NOT) + new `test/r23-sports-racing-genres.test.js` (4 tests — NES sports/racing build, Genesis sports/racing build with SEGA header, createGame happy path, createGame error path for unsupported platform). 183 → 189 passing.
- [x] **`crossPlatformSpriteImport` live-palette propagation fix** (R23f, 2026-05-26)
  Driven by `~/code/cliemu/feedback_round17_intent_validation.md`. The composite (`extractSpriteSheet → cropSpriteSheet → quantizePngForPlatform`) was running its internal extract step with the **per-platform default palette** instead of reading the live emulator palette like the standalone `extractSpriteSheet` does. Result: artist-facing color (vivid red bike + blue rider on the Excitebike → GBC lift) was lost; output came back grayscale-toned. Fix: the impl now mirrors `extractSpriteSheet`'s palette-resolution chain — explicit `paletteFromEmulator` wins; otherwise the intent default (homebrew → true, rom-hack → false) decides; live read via `decodeLivePalette(host, sourcePlatform, paletteIndex, spec)` when a ROM is loaded; per-platform default palette as the homebrew fallback when no ROM; explicit `paletteFromEmulator:true` without a ROM throws (matches `extractSpriteSheet`'s behavior). Two new optional params: `paletteFromEmulator?: boolean` and `paletteIndex?: number`. Response surfaces `sourcePaletteSource` so the agent can verify the live read happened. Also fixed: the impl was receiving `sessionKey` as `_sessionKey` (the underscore-prefixed "unused" convention) and the tool registration didn't thread it into the impl call — both fixed so `getHostOrNull(sessionKey)` actually finds the per-session host. New `test/r23f-cross-platform-live-palette.test.js` (3 tests covering the bug repro, the rom-hack non-regression, and the explicit-flag-no-ROM error path). 189 → 196 passing (R23 was 189, R23f adds 3, R23e adds 4 → 196 total).
- [x] **R23g — rom-hack cross-platform preserve path validation** (2026-05-26)
  The other agent offered to test `intent:"rom-hack"` cross-platform after R23f landed: "NES 4-color → SNES 16-color subpalette where preserve-verbatim is exactly right." We preempted by running it ourselves. New `test/r23g-rom-hack-cross-platform-preserve.test.js` (3 tests) proves three invariants: (1) the composite's output PNG is **byte-equal** to the discrete extract+crop chain under rom-hack (the strong preserve guarantee), (2) rom-hack doesn't silently switch on the live-palette read even when a host is available, (3) rom-hack's output palette is monochrome (no color leakage from per-platform defaults). 196 → 199 passing.
- [x] **R25 — C64 hello_sprite + tile_engine templates** (2026-05-26)
  C64 had only `default`. Added two new templates leveraging the existing `c64_registers.h` runtime header: `hello_sprite` (VIC-II hardware MOB + joystick port 2 — the agent-friendly default since port 1 conflicts with the keyboard scan matrix) and `tile_engine` (40×25 character matrix + walking sprite + AABB collision against block cells). Macro-naming gotcha: cc65's stdlib pre-defines `POKE`, `PEEK`, `SCREEN`, `COLOR_RAM` etc. — the bundled template uses `WR` / `RD` + `SCREEN` / `COLORS` to dodge conflicts. New `src/platforms/c64/MENTAL_MODEL.md` + `TROUBLESHOOTING.md` (memory map / VIC-II character cells / MOBs / CIA dual-purpose ports / SID / .prg load-header). Test `test/r25-c64-templates.test.js` (2 tests) — build + createProject scaffold. 199 → 201 passing.
- [x] **R26 — 2P competitive shmup on SMS + Genesis** (2026-05-26)
  R23/R23e wired JOY_2 into sports + racing; R26 brings the same to shmup. New `shmup_2p` template on Genesis + SMS: each player owns their own ship + 4-bullet pool + score; enemies are shared (first to hit wins). SMS got a new `sms_joypad_read_p2()` runtime helper that reassembles P2's awkward split-across-$DC/$DD bit layout (already added in R23e, reused here). Genesis Pad B port uses BUTTON_A as the fire button (same shape as P1 — uniform feel). Existing single-player `shmup` template unchanged so previous users aren't disrupted. Test `test/r26-shmup-2p.test.js` (3 tests — both platforms build, createProject scaffolds with the P2 helper). 201 → 204 passing.
- [x] **R24 — libgba-equivalent for GBA** (2026-05-26)
  Game Boy Advance is now a full tier-1 C platform with bundled libgba. `buildSource({platform:"gba", language:"c", source: "#include <gba.h>\\nint main(...)"})` produces a loadable `.gba` ROM end-to-end through the WASM toolchain.
  - **Stage 1 (native bootstrap):** binutils 2.42 + gcc 14.2.0 + newlib 4.4.0 cross-toolchain for `arm-none-eabi` built natively (`scripts/build-arm-toolchain.sh`). Differences from m68k: target = `arm-none-eabi`, CPU = `arm7tdmi`, mode = `arm`, float = `soft`. No `_LDBL_EQ_DBL` patch needed (ARM EABI long double is already double). `--disable-newlib-supplied-syscalls` replaces m68k's `--disable-libgloss`.
  - **Stage 2 (WASM port):** cc1 + arm-none-eabi-{as,ld,objcopy} compiled to WASM via emcc (`scripts/build-arm-wasm-tools.sh`). Same R20 playbook: libiberty `HAVE_PSIGNAL=1` patch (applied to BOTH the gcc-tree's libiberty AND binutils' separate libiberty), `CC_FOR_BUILD=gcc CXX_FOR_BUILD=g++` override on every `emmake make` invocation (the standard Canadian-cross pattern — WASM toolchain for HOST tools, NATIVE toolchain for BUILD tools like genmodes/genhooks). For the final modularize+EXPORT_ES6 wrap, EMCC_CFLAGS-on-link does the job: `EMCC_CFLAGS="-s MODULARIZE=1 -s EXPORT_NAME=createCc1arm -s EXPORT_ES6=1 ..." emmake make cc1` re-runs the final link with the wrap flags. Wasm filenames have to match what the emcc-generated mjs embeds (single-quoted bareword like `'cc1.wasm'`); we rename the .wasm + sed-patch the mjs's embedded reference. Total stage-2 footprint: 162 MB (unstripped — R28 idea is to rebuild with `-O3 --strip-debug` to drop to ~20 MB like m68k's published artifacts).
  - **Stage 3 (libgba runtime):** libgba 0.5.4 fetched from devkitPro/libgba GitHub, built against the stage-1 native toolchain (`scripts/build-libgba.sh`). DEVKITPRO + DEVKITARM env vars synthesized to point at our `build/arm-toolchain/install/`. A minimal `gba_rules` file synthesized inline since we don't ship devkitPro's. devkitPro's canonical iosupport.h staged from upstream into `arm-none-eabi/include/sys/`. `gba_crt0.s` + `gba_cart.ld` fetched from devkitPro/devkitarm-crtls. Plus `crti.o`/`crtn.o`/`crtbegin.o`/`crtend.o` from gcc-14.2.0's startup objects. **One trade-off documented loudly: libgba's `console.c` (iprintf-style stdio) IS EXCLUDED** because it pulls in devkitPro's libsysbase header chain we don't bundle. See the long warning block in `scripts/build-libgba.sh`, R27 in this PLAN, and `src/platforms/gba/TROUBLESHOOTING.md` for the three workarounds (mGBA debug interface, hand-rolled tile-text renderer, install devkitPro natively). Total libgba bundle: ~3 MB (libgba.a 323 KB + 69 SDK headers + sysinclude 2.4 MB + crt objects).
  - **buildGbaC JS driver** in `src/toolchains/gba-c/gba-c.js`: orchestrates cc1 → as → ld → objcopy through the worker pool. Two modes: `libgba:true` (default — full SDK link with crti/crtn + libgba.a + libgcc.a + libc.a + libnosys.a + a generated `fake_heap_end` stub since we excluded libsysbase) and `libgba:false` (minimum-viable — bare main against raw GBA registers + simple linker script).
  - **Wired into buildSource dispatch:** `args.platform === "gba"` routes to `buildGbaC`; `LANGUAGE_TOOLCHAIN.gba` declares C as available with the iprintf caveat surfaced in the `note` field; `PLATFORM_DEFAULT_LANGUAGE.gba = "c"`.
  - **Template:** `examples/gba/templates/gba_hello.c` ships the canonical "MODE_3 framebuffer, draw a red pixel at (120, 80)" starter. Builds to a 1068-byte `.gba` ROM with valid ARM `b 0xb8` instruction at the cart header offset.
  - **Per-platform docs:** new `src/platforms/gba/MENTAL_MODEL.md` + `TROUBLESHOOTING.md` — memory map, ARM7TDMI ARM/Thumb modes, display modes 0-5, OAM, sound, build pipeline. TROUBLESHOOTING leads with a prominent **"iprintf doesn't work — why?"** section per user request, plus the three workaround paths in detail.
  - **Tests:** new `test/r24-gba-c-build.test.js` (2 tests — minimum-viable bare main + libgba `#include <gba.h>` with MODE_3 + BG2_ON). 204 → 206 passing.
- [x] **R28 — libtonc as default GBA runtime + mgba core + GBA scaffolds + sound** (2026-05-26)
  Game Boy Advance went from "build-only" tier to a full tier-1 platform with playback, scaffolds, and sound. Five things shipped together because they all unblock the same agent experience.
  - **libtonc 1.4.5 as default GBA runtime.** Aligned with what every published tutorial at gbadev.net/tonc teaches. `#include <tonc.h>`, `tte_init_chr4c_default` + `tte_write` / `tte_printf` for text (no libsysbase needed — sidesteps the R24 iprintf gotcha entirely). `tonccpy` / `toncset` VRAM-safe memcpy/memset. `OBJ_ATTR` shadow buffer + `oam_copy` DMA flush. `key_poll` / `key_held` input. Built via `scripts/build-libtonc.sh` against the R24 native arm-none-eabi toolchain. **Same trade-off as libgba's console.c:** `tte_iohook.c` (the iprintf↔TTE bridge that needs `<sys/statvfs.h>`+`<sys/dir.h>`+`<sys/iosupport.h>`) is EXCLUDED — but TTE's direct API replaces it, so most users never notice.
  - **Runtime discriminator in `buildGbaC`:** new `runtime:` arg — `"libtonc"` (default) | `"libgba"` (R24 SDK path) | `"none"` (bare gcc + newlib). Legacy R24 `libgba:true|false` flag still works. Backward compatible.
  - **mgba_libretro core.** R24 left GBA build-only ("no core available for platform 'gba'" on `runSource`). R28 imports the prebuilt mgba_libretro.{js,wasm} from sibling `retroemu/cores/` into `src/cores/wasm/` + registers in `src/cores/registry.js`. **GBA is now playable end-to-end in the agent loop** — `runSource({platform:"gba", ...})` returns screenshots, `stepFrames` works, `playtest` works.
  - **`language` + `runtime` plumbed through `runSource` schema.** runSource only had a path for buildSource's `language` arg; missing it meant GBA defaulted to "asm" (which we don't wire) and returned "asm path not yet wired". Added schema fields + threaded both to `buildForPlatform`. Plus: the GBA dispatcher in `toolchains/index.js` now defaults `language` to `"c"` when undefined since no asm path exists yet.
  - **`gba_sfx.h` + `gba_sfx.c` audio wrapper.** Minimal DMG-compatible APU wrapper: `sfx_init()` powers up SOUNDSTAT, `sfx_tone(channel, freq_period, length_frames)` triggers a 50% duty square on ch1/ch2 (`REG_SND1CNT`/`REG_SND2CNT`+`REG_SND[12]FREQ`), `sfx_noise(length_frames)` triggers ch4 noise. Channel 3 (wave RAM) + Direct Sound DMA streaming are out of scope (Direct Sound needs a timer + DMA setup + a sample buffer — for music+samples you'd pair with maxmod separately). Matches NES/GB scaffold sound shape so cross-platform game ports feel the same. Bundled into `GBA_LIBTONC_RUNTIME` staging so it lands next to main.c in `createProject` output.
  - **5 GBA genre scaffolds (Tonc-aligned, with sound).** shmup/platformer/puzzle/sports/racing. Each ~150-230 lines. Each uses TTE for text, OBJ_ATTR for sprites, key_poll for input, sfx_init/sfx_tone/sfx_noise for SFX. shmup: pew on A, explosion on bullet-hit. platformer: jump boing + landing thud. puzzle: rotate click + triple-clear chime. sports: paddle hit, wall blip, score chime/buzz. racing: lane-switch beep, crash noise. Plus `tonc_hello_sprite` (sprite + d-pad) for the simplest sprite-loop example.
  - **The Tonc IRQ trap (caught + fixed in every scaffold).** `VBlankIntrWait()` is a BIOS function that halts the CPU until a vblank IRQ fires. **Without `irq_init(NULL); irq_add(II_VBLANK, NULL);` the BIOS halts forever** — the ROM appears to compile and load but freezes on frame 1. This is the canonical published-tutorial-vs-romdev gotcha; every scaffold (tonc_hello, tonc_hello_sprite, shmup, platformer, puzzle, sports, racing) now sets up IRQs before its main loop. TROUBLESHOOTING.md leads with this.
  - **cc1.wasm rebuilt with `STACK_SIZE=8MB`.** Larger Tonc-using sources (tonc.h umbrella pulls in ~18 headers + TTE + many static inlines) overflow cc1's default 64 KB emscripten stack during LTO. Symptom: `Stack overflow detected. You can try increasing -sSTACK_SIZE (currently set to 65536)` mid-LTO pass + `[worker] Abort in WASM: memory access out of bounds`. Same fix shape we used on SDCC sm83 earlier.
  - **puzzle.c VRAM region disambiguation.** When BG0 grid + TTE BG1 share char-block 0 / screen-block adjacent regions, TTE's init writes wipe the BG0 tile data. Fix: puzzle.c puts BG0 tiles in CBB=3, SBB=28 (well clear of TTE's CBB=2, SBB=30). The other 4 genre scaffolds don't hit this because they use sprites for gameplay (BG0 is only TTE) — no overlap.
  - **README buildBlock for GBA.** `createProject({platform:"gba"})` README now emits a `runSource({sourcesPaths: { main.c, gba_sfx.c }, includePaths: { gba_sfx.h }})` block instead of the single-file default, so users discover the multi-file pattern immediately.
  - **Docs:** PLAN.md (this entry), README.md, `src/platforms/gba/MENTAL_MODEL.md` (libtonc + sfx + IRQ-init), `src/platforms/gba/TROUBLESHOOTING.md` (irq_init trap leads, then iprintf-on-libgba-path note as fallback).
  - **Tests:** `test/r28-gba-libtonc-build.test.js` (4 tests — libtonc default, TTE drawing, libgba opt-in, legacy libgba:false), `test/r28-gba-sfx.test.js` (1 test — sfx_init + sfx_tone + sfx_noise), `test/r28-gba-runsource.test.js` (2 tests — mgba core resolves + end-to-end mgba boot 10 frames). 206 → 213 passing.
- [x] **R30 — Genesis PSG sound wrapper + scaffold integration** (2026-05-26)
  Filled the "scaffolds shouldn't be silent" gap on Genesis. New `genesis_sfx.{h,c}` wraps SGDK's PSG_* helpers with a 5-function API matching the NES/GB/GBA shape: `sfx_init` / `sfx_tone(channel, freq, length_frames)` / `sfx_noise(length_frames)` / `sfx_update` (call once per frame to tick auto-silence countdowns) / `sfx_off`. PSG-only (SN76489 4 channels: 3 squares + 1 noise) — YM2612 FM synth is deferred to future maxmod-style work. Wired into 6 Genesis scaffolds: shmup (pew on fire, boom on hit), platformer (jump boing, land thud), puzzle (rotate click, triple-clear chime), sports (paddle hit + wall blip + score chime/buzz), racing (lane switch + crash), shmup_2p (per-player pew + shared boom). Added genesis_sfx files to GENESIS_RUNTIME staging; SNES + Genesis README buildBlock generator upgraded to detect runtime .c files + emit `sourcesPaths`/`includePaths` block. `test/r30-genesis-psg-sfx.test.js` (1 test). 213 → 214 passing.
- [x] **R31 — SNES SPC700 sound wrapper + scaffold integration** (2026-05-26)
  SNES audio is fundamentally different (no direct DSP — separate SPC700 CPU + 64 KB ARAM + 8-channel DSP). Imported the working SPC driver + samples from `~/code/cliemu/rom-games/snes/invaders/audio/` (spc_driver.asm 152 B + apu_blob.bin 9240 B + shoot.brr + explosion.brr). Built `snes_sfx.h` + `snes_sfx.c` as a pure-C upload+command wrapper around the APUIO ports at $2140-$2143. The driver supports 2 sample slots (cmd 1 = shoot, cmd 2 = explosion) with edge-detected re-trigger via a `release first` pattern. Wired binaryIncludes through buildSnesC. The libsnes single-.c-file constraint means scaffolds `#include "snes_sfx.c"` rather than linking it separately. Wired into 5 SNES scaffolds (shmup, platformer, puzzle, sports, racing). Asar 1.91 buggy-arithmetic discovered + worked around (use literal `$0E00` instead of `$1000 - $200` in spc-arch blocks). To rebuild apu_blob from source: `runAsar({source: spc_driver.asm + base/org + .incbin sample_bank.bin, flatBinary: true})`. `test/r31-snes-sfx.test.js` (2 tests — wrapper builds + apu_blob byte-stable). 214 → 216 passing.
- [x] **R32 — gba_hello.c libgba starter rebuilt with IRQ-init + demo loop** (2026-05-26)
  The libgba opt-in starter previously drew a red pixel and hung with `while(1){}`. Anyone copying it + adding `VBlankIntrWait` would trip the R28 IRQ-init trap. Upgraded to a moving-pixel demo: irqInit() + irqEnable(IRQ_VBLANK) at startup, d-pad input via `~REG_KEYINPUT & 0x3FF`, MODE_3 framebuffer trail. Teaches the canonical libgba pattern (irqInit/irqEnable + VBlankIntrWait loop + input + framebuffer draw) in 30 lines. Verified end-to-end under mGBA (held RIGHT+DOWN for 60 frames produces a red diagonal trail).
- [x] **R33 — maxmod for GBA music** (2026-05-26)
  Built libmm.a (79 KB) for arm-none-eabi from devkitPro/maxmod sources via `scripts/build-maxmod.sh`. Pure-asm library — 7 .s files driven through gcc-as with `-x assembler-with-cpp` (maxmod sources use C-preprocessor-style `#include "mp_*.inc"` per devkitPro convention). Also built the `mmutil` host tool (137 KB Linux ELF) that converts .xm/.mod/.s3m/.it tracker modules into the binary soundbank format — needed minor patches: replaced obsolete `typedef unsigned char bool` with `<stdbool.h>` include, define `PACKAGE_VERSION` macro, link `-lm`. Wired `maxmod: true` opt-in through buildGbaC → libmm.a archive + `-lmm` link option + maxmod.h/mm_types.h headers exposed to cc1. Added `runtime`/`maxmod` to buildSource + runSource MCP schemas. Foundation works — `mmInitDefault(soundbank, 8)` + `mmVBlank` IRQ hook + `mmFrame` per-frame call all link cleanly into a 36 KB ROM. **What's NOT done in this round**: an actual music-track demo (needs a CC0 .xm/.mod source, mmutil-converted soundbank, and a `gba_music_demo` scaffold demonstrating mmStart). The mmutil tool is bundled at `build/maxmod/host/mmutil` for users who want to convert their own modules. `test/r33-gba-maxmod.test.js` (3 tests — libmm.a present, headers present, link smoke). 216 → 219 passing.
- [x] **R35..R40 — Tier-1 push: all mainstream consoles ship with check marks** (2026-05-26)
  Closed every Sega/Atari/Commodore gap so the v1 ship matrix has zero `❌` in the "core / templates / sound / docs" columns for the 13 ship-ready platforms. Six focused rounds:
  - **R35 SMS sound** — `sms_sfx.{h,c}` wraps SN76489 PSG via port $7F. Same chip as Genesis PSG; the wrapper is a byte-port-renamed `genesis_sfx`. Wired into all 8 SMS scaffolds.
  - **R36 Game Gear tier-1** — full new tree: `src/platforms/gg/lib/c/` (vdp_init / load_palette / load_tiles / vblank_wait / joypad_read / sprite_table / gg_sfx) + 7 scaffolds + MENTAL_MODEL.md + TROUBLESHOOTING.md. GG runs on genesis_plus_gx with a 160×144 visible viewport, START on port $00 bit 7, optional stereo via port $06. Joypad helper merges port $DC (D-pad + B1/B2) + port $00 (START) into one byte.
  - **R37 GBC color** — gave GBC its own tree (was previously a `LIB_PLATFORM = "gb"` alias). Mirrors GB runtime but every scaffold writes a REAL BG palette via BCPS/BCPD (R37 test enforces with a regex match). gambatte boots in CGB mode via patchGbHeader's $0143 = $80. Sister docs to GB cover the differences (8 BG palettes × 4 colors, VBK bank-switch for attribute maps).
  - **R38 Atari Lynx tier-1** — first-class Lynx support. 6 scaffolds using cc65's TGI driver (`lynx_160_102_16_tgi`) for Suzy-backed rectangles + text; cc65's `joy_install(&lynx_stdjoy_joy)` for the d-pad. New `lynx_sfx.{h,c}` wraps MIKEY's 4-voice LFSR audio at $FD20+. handy core runs everything natively. C89 throughout (cc65 strict).
  - **R39 C64 5 genre scaffolds + SID** — closed the missing 5 (shmup, platformer, puzzle, sports, racing) on top of the existing hello_sprite + tile_engine. `c64_sfx.{h,c}` wraps the SID with 3 voices, pulse/triangle/sawtooth/noise waveforms + real ADSR envelope shaping (attack 0, decay 9, sustain 8, release 5).
  - **R40 Atari 7800 TIA sound** — `atari7800_sfx.{h,c}` wraps the 7800's TIA audio (inherited from 2600). 2 voices via AUDC/AUDF/AUDV at $15-$1A. Wired into all 7 existing 7800 scaffolds.
  - **Tests** — R35/R36/R37/R38/R39/R40 each ship a dedicated `r<N>-*.test.js` plus updates to the existing R21/R22/R23/R26 tier-1 parity tests (they previously didn't supply the new sfx siblings). DOC_PLATFORMS in the docs-coverage test now lists 12 platforms with docs (was 7). 219 → 228 passing.

  **Result:** every core in `cores/registry.js` (except the two delisted ones — atari5200, zxspectrum) has a working core + at least 5 genre scaffolds + sound + per-platform docs. The next surface to address is **music** (R34 maxmod demo + Genesis YM2612 + SNES SPC700 music + the Lynx track player are future work), not platform-completeness gaps.

- [x] **R34, R42..R51 — Music sprint: every tier-1 platform ships a `music_demo` template** (2026-05-26)
  Filled the "sound shows but doesn't sing" gap. After R35-R40 every platform had `*_sfx` for one-shot blips; this sprint adds a continuous-music engine + `music_demo` scaffold on each. 11 rounds, one per platform/driver path. Standard API on the C platforms: `music_init()` / `music_play(idx?)` / `music_update()` (called once per vblank) / `music_stop()` — same shape across the matrix so cross-platform game ports feel uniform. The pure-asm platforms (NES, 2600) use platform-native equivalents.

  Per-platform driver choices — picked the most authentic + lightest engine each platform's homebrew scene actually uses:
  - **R34 GBA — maxmod + chiptune.xm soundbank.** Closed the R33 "no actual demo" gap. CC0 chiptune authored as `.xm` via `make_chiptune_xm.js`, run through bundled `mmutil` → `chiptune_soundbank.bin` + `chiptune_soundbank.h`. `maxmod_demo.c` ships `mmInitDefault(soundbank, 8)` + `mmStart(MOD_CHIPTUNE, MM_PLAY_LOOP)` + the canonical `irqInit/irqSet IRQ_VBLANK,mmVBlank/mmFrame` per-frame call. Auto-emitted asm stub `.incbin`'s the soundbank.
  - **R42 Genesis — XGM2 via SGDK.** Uses SGDK's `XGM2_startPlay(music)` against a `.xgc`-compiled blob (`.incbin`'d via `xgm2_demo_data.s`). YM2612 + PSG via the Z80 driver SGDK ships — no hand-rolled m68k music engine needed. Lightweight CC0 demo blob bundled.
  - **R43 Lynx — cc65's `lynx_snd_play` streaming engine** (already in cc65's libsrc). `lynx_music.{h,c}` is a hand-authored bytestream song (Mikey 4-voice format documented inline — note byte → length, $80+ = commands like SndLoop/SndSetInstr/SndCallPattern). `music_demo.c` calls `lynx_snd_init()` + `lynx_snd_play(0, demo_music)`.
  - **R44 NES — FamiTone2 (Shiru, public domain).** Industry-standard 6502 music engine. Bundled `famitone2.s` (engine, ~1.5 KB code) + `famitone_bridge.s` (cc65 fastcall wrappers exporting `_famitone_init`/`_famitone_play`/`_famitone_update`) + `music_data.s` (example track in RODATA). `music_demo.c` calls the bridge from C; NMI handler calls `FamiToneUpdate` every frame. Requires the new `chr-ram-runtime` linker config (32 KB PRG + CHR-RAM, no CHR-ROM). LICENSE-FAMITONE attribution shipped.
  - **R45 GB + R45 GBC — hUGEDriver (SuperDisk, MIT).** The de-facto modern GB tracker driver. Compact C port of upstream `hUGE_dosound` + `hUGE_init` (same names so a future RGBDS upstream.o is drop-in). 72-entry note table preserved verbatim. `song_data.c` ships a `sample_song` descriptor. R45 GBC test additionally asserts `BCPS` write so it proves the GBC scaffold uses CGB palettes (the R37 "real CGB" marker). Separate templates for the GB + GBC scaffold trees.
  - **R46 SNES — SPC700 music engine extension.** Extended R31's apu_blob driver: added music engine on SPC voice 1 + a song-row walker reading a table at ARAM $5000. New commands $03/$04 (start/stop music) dispatched via the existing edge-detected command byte at $2140. `snes_sfx.h` gained `sfx_music_play()` / `sfx_music_stop()` — sfx and music share the same uploader (no second blob to ship). `apu_blob.bin` grew from 9240 B to ~20 KB. Music_demo template + matching `music_demo-data.asm` (`incbin`'s the apu_blob) bundled. Asar 1.91 arithmetic bug from R31 still avoided by literal addresses.
  - **R47 SMS — 3-voice PSG tracker.** Hand-rolled SN76489 driver: voice 0 melody, voice 1 harmony, voice 2 bass, parallel `(divider, duration_frames)` arrays. Loops independently per voice (polyrhythm-by-design — bass 8-step, harmony 8-step, melody 16-step). Note dividers documented inline (NTSC 3.58 MHz / 32). Self-contained — doesn't entangle with `sms_sfx`'s static `psg_write` (writes to port $7F directly).
  - **R48 GG — 1-voice PSG tracker on channel 2.** Cooperates with `gg_sfx` (which owns ch 0/1 + ch 3 noise). Sentinel-terminated note table; three hand-authored songs in `gg_music.c` selectable from the d-pad in `music_demo.c`. Same PSG protocol as SMS but with a more constrained channel budget.
  - **R49 C64 — 3-voice SID sequencer.** Per-frame note-table sequencer with pulse-wave shape + ADSR (attack 0, decay 4, sustain 8, release 4) on all three voices. Melody (high pulse), bass (low pulse, half-notes), harmony (mid). 16-bar Am-F-C-G chord loop with melody variations. Not a `.sid` player (those need full 6502 sub-program emulation) — just a frame-tick sequencer that writes SID registers on note transitions. `music_tick()` exposed for beat-sync visuals.
  - **R50 Atari 7800 — 2-voice TIA tracker.** Inherits TIA from R40 sfx. Two voices via AUDC0/AUDF0/AUDV0 + AUDC1/AUDF1/AUDV1. Each table row = `{distortion, freq, frames}`. Distortion 4 (5-bit poly) for melody, distortion 6 for bass timbre contrast. Sentinel `{0,0,0}` ends a voice, which wraps to index 0 — independent voice loops.
  - **R51 Atari 2600 — 2-voice 6507 asm chiptune.** No C toolchain on 2600 → music_demo is pure asm. Two parallel `(AUDF, length_frames)` tables stepped per VBlank. Same AUDC/AUDF/AUDV regs as 7800 (TIA shared lineage). 4 KB cart fully assembled by `dasm`. Tests assert both voices' regs + both note tables appear in source so a regression to mono is caught.

  **Result:** all 13 tier-1 platforms have a `music_demo` template registered in `TEMPLATES.<platform>.music_demo`, all build clean, all link the music driver into a ROM that boots. 228 → 263 tests passing (35 new music tests). The "music" line from the R35-R40 close-out is now fully addressed; the remaining audio gaps are higher-end features (Genesis YM2612 FM instrument design beyond what XGM2 ships, GBA Direct Sound PCM streaming for samples-plus-music, SPC700 BRR sample arsenal beyond the bundled shoot/explosion) rather than per-platform completeness.

- [x] **R63 — Large-output discipline: path-required-unless-inline** (2026-05-28)
  Audited all 101 tools for context-burn (tools that dump big payloads INLINE every call). Found 11 violations + several image tools. Established ONE uniform contract for every large-output tool and applied it.
  - **The rule:** `inline` defaults to **false**. When `inline:false` (default) the caller MUST pass an output path (`outputPath`/`outputDir`/`path`) — the payload is written there and the tool returns just `{path, bytes}`. When `inline:true`, the payload comes back in the response. No path + not inline → a clear error naming both options. **No hidden default location** (rejected a temp-dir default — the user's point: people would make games in /tmp and lose them; "require a path" removes the guesswork and the footgun entirely). Helper: `writeOutput()` in `src/mcp/util.js`.
  - **Applied to:** buildSourceWithDebug (ROM + .dbg/.map + log all gated; debug/log written as siblings of outputPath), readMemory (dropped the duplicate base64 — hex only; ≤4 KB stays inline for ergonomics, >4 KB requires path/inline and writes RAW bytes), disassemble, convertImageToTiles, extractCart (flipped to require outputDir), recordSession (per-frame PNGs to outputDir), starterSnippets(getAll), build logs on buildSource/runSource/buildProject (large log → sibling `.build.log` + tail), and the image tools screenshot / stepAndScreenshot / inspectPatternTiles / inspectPalette / inspectSprites / inspectBackgroundMap / previewVisibleSprites. readAsset got a cap-tighten (1 MB → 64 KB default) rather than the full contract (it's a file-read tool).
  - **Images = per-CALL choice, never a server flag.** Multiple agents of differing vision capability share one server, and some "multimodal" clients silently drop/down-convert inline images — so the inline-vs-disk decision rides on each call's `inline` param. The inspect* tools ALWAYS return their structured JSON (sprite/palette/render-flag data); only the PNG is gated — so a text-only agent works from data, not an image it may never actually receive. Documented in AGENTS.md.
  - **Exceptions (deliberate):** small readMemory reads (≤4 KB inline); **runSource keeps its inline screenshot by default** (its identity is "build+run+SHOW me") with an optional `screenshotPath` to redirect.
  - Verified the contract end-to-end over HTTP (no-path → clear error; inline:true → payload; path → file written + {path}, no inline). **327/327 tests pass** — updated the 5 tests that asserted the old inline-by-default shape to pass `inline:true`. See [[romdev-inline-images-per-call-not-per-server]].

- [x] **R62 — Tool-surface context diet (concise descriptions + same-op consolidation)** (2026-05-28)
  The full tools/list is always-on context every turn for every client. Cut it on two axes — and concise descriptions help agents pick the right tool, not just save tokens. **Full tools/list payload ~17.5K → ~11.9K tokens (~32%); tool count 108 → 101.**
  - **Description trim.** The ~25 fattest descriptions were 800-1,800-char tutorials. Rewrote each to "use this WHEN x; the one load-bearing gotcha; details in param hints" — moved how-to prose into param `.describe()`s / MENTAL_MODEL docs (surfaced on demand by `describeTool`/`getPlatformDoc`) while KEEPING every load-bearing footgun (S-DSP FLG=$6C-not-$5C, GB CGB-flag white-screen, getRenderingContext step-past-startup, findReferences indirect-jump limit, screenshot-ascii "only if you can't see images", playtest "don't open a window to iterate", etc.).
  - **Consolidation (enum/param discriminator, NOT action-dispatch).** Merged same-operation families into one tool each and **DELETED the old tools** (no deprecated aliases — pre-launch, no external callers; we update docs, not keep dead tools):
    - `getDspState`/`getPsgState`/`getYm2612State` → **`getAudioState({chip})`** (mirrors `getCPUState({cpu})`).
    - `loadMediaBytes` → **`loadMedia({base64})`** (path OR base64).
    - `identifyRomBytes` → **`identifyRom({base64})`**.
    - `screenshotAscii` → **`screenshot({format})`** — `format` defaults to `'png'` so the simplest call is unchanged.
    - `getStarterSnippet`/`getAllStarterSnippets`/`listStarterSnippets` → **`starterSnippets({mode})`** — `mode` defaults to `'list'` (cheap, no byte dump).
    Every discriminator defaults to the dominant case, so existing simple calls don't change. All five merged tools verified end-to-end via curl on a live ROM. Updated every in-payload description string + the TOOL_OWNER map that named a deleted tool.
  - **Left separate (false friends — merging would be the action-dispatch anti-pattern):** `disassemble`(bytes) vs `disassembleRom`(file), `buildSource` vs `buildSourceWithDebug` (different return shape), `runUntil` vs `runUntilWrite` (different condition model). Conditional/union schemas are handled worse by models than distinct tools.
  - **Decision recorded:** context levers are (1) concise descriptions and (2) consolidating *same-operation* families behind a clean enum/param with sensible defaults — NOT reviving on-demand progressive disclosure (loadCategory dance hurts weak models + makes reconnect split-brain) and NOT mega "action" tools. We do not ship deprecated tool shims; renames update docs instead. Progressive disclosure stays OFF by default (`ROMDEV_LEAN_TOOLS=1` opt-in only).
  - **Tests:** 330/327 (only the pre-existing Lynx `not ok 263`). No test referenced a deleted tool name.

- [x] **R61 — Side-scroller platformer scaffolds + createGame consistency** (2026-05-28)
  Two-part round. (1) **Side-scrollers:** the `platformer` genre scaffold now side-scrolls on every platform except NES — verified in-emulator (drove L/R, confirmed the H-scroll register moves + the player stays screen-centered + clamps at world edges). GB/GBC: 256-px world = the wrapping BG map, SCX scroll. SMS/GG: 512-px world with software column streaming (32-cell name table wraps, so stream world col `camCol+32` into `(camCol+32)&31` each 8-px step; R8 = -camX). SNES: `bgSetScroll(0,camX,0)` + player in screen space (PVSnesLib console BG → platforms collision-only). C64: hardware fine scroll (`$D016` low 3 bits) + software coarse re-render of screen RAM ($0400) + color RAM ($D800) from a world map + 38-col mode to mask the edge. Genesis + GBA already side-scrolled. Each platformer's `describe` updated to "SIDE-SCROLLING…". Two cross-cutting bugs fixed along the way: an SDCC `uint8_t i < 32*18` infinite loop (576 > 255 → BG never clears → "boot hang") in the GB scaffold, and GB needing `enable_vblank_irq()` (busy-poll wait_vblank runs ~1/30 speed on the WASM emulator). **NES is still single-screen** — discovered the *stock* NES platformer crashes after ~150-200 idle frames (a pre-existing cc65/runtime bug, not scroll-related), so the NES side-scroller is blocked on fixing that first.
  - **(2) createGame consistency.** `createGame` only supported 8 platforms via a hardcoded `GENRE_MAP` that had drifted — it silently omitted **c64, gba, lynx** even though all three have the full 5 genre templates registered. Deleted `GENRE_MAP`; availability is now **derived from `TEMPLATES`** (a genre is available iff `TEMPLATES[platform][genre]` exists), so it can't drift again. Now genre-capable: nes, gb, gbc, snes, genesis, sms, gg, **c64, gba, lynx**, atari7800 (11). Still correctly rejected (no genre templates): atari2600, msx, coleco, zxspectrum. Tool description + platform enum doc updated to list all 11. README.md + AGENTS.md updated.
  - **Tests:** new `test/r61-creategame-all-platforms.test.js` (the 11×5 matrix scaffolds + non-genre platforms reject with the full list + bad genre rejected). Fixed `test/r52-gg-friction-fixes.test.js`, which grepped the now-deleted `GENRE_MAP` source string — rewrote it to assert `TEMPLATES.gg` registers all 5 genres. 328 → 327 tests; 330 passing (the 1 fail is the pre-existing Lynx music `not ok 263`).

- [x] **R60 — Cross-emulator patch audit + vice CIA snapshot fix** (2026-05-27)
  After R59 (fceumm CHR-RAM read bug) shipped, audited every other memory-region patch we ship to make sure no R59-class siblings were lurking. Read all 7 patches via the Explore agent.
  - **Clean (no changes needed):** fceumm (post-R59), gambatte, genesis-plus-gx, prosystem, snes9x, stella2014. All accessors either return direct buffer pointers with matching size declarations OR snapshot into a private buffer of the right size. No pointer-arithmetic-with-offset bugs anywhere.
  - **One latent risk found + fixed in vice:** the C64 CIA1/CIA2 accessors returned `machine_context.cia1->c_cia` — a direct pointer into a live struct field. Worked correctly today (VICE's cia_context layout is stable), but added an upstream-struct-stability dependency that future VICE upgrades could silently break. **Fix:** changed both to snapshot-into-buffer (`romdev_fill_cia1_regs` / `romdev_fill_cia2_regs` + matching 16-byte buffers), same shape as the existing `romdev_fill_sid_regs` + `romdev_fill_cpu_regs`. Per-read cost: one 16-byte memcpy. Eliminates the struct-drift risk entirely.
  - **Rebuilt vice_x64_libretro.wasm** with the patch applied (in progress as this entry is being written; check `/tmp/vice-build.log` for status). Once it lands the agent's C64 reads through `c64_cia1_regs` / `c64_cia2_regs` are guaranteed-stable across future VICE versions.
  - **BUILDING.md updated** with the "Patch bugs vs core bugs" lesson refined: "bias toward the simplest accessor: if you can return a direct ptr (like `SPRAM` for OAM), do that. Per-struct-field pointer returns are fragile — snapshot them into a private buffer."

- [x] **R59 — fceumm `nes_chr` patch off-by-page-offset fix + WASM rebuild** (2026-05-27)
  Agent in `feedback_nes_round2.md` reported `chr_ram_upload(0x1000, ...)` "didn't land" — uploads to $0000 worked, $1000+ silently dropped. Diagnostic: shadow_oam at $0200 verified, NMI ran (`nmi_counter` increments), `vram_queue_flush` worked (nametable writes landed), but `readMemory("nes_chr", offset>=4096)` returned zeros.
  - **Root cause** (found by reading `scripts/patches/fceumm-romdev-memory-regions.patch`): the `ROMDEV_MEMORY_NES_CHR` handler did `memcpy(romdev_chr_buf + i*1024, VPage[i] + i*1024, 1024)`. `VPage[i]` is already a pointer to the start of the i-th 1 KB CHR page — adding `i*1024` to that reads from the WRONG page. For typical CHR-RAM (VPage entries point into one contiguous 8 KB buffer at offsets 0/1024/.../7168): page 0 read correctly (offset 0), pages 1-3 returned shifted data, pages 4-7 read out-of-bounds past the 8 KB buffer → zeros.
  - **The agent's CHR writes were correct all along.** The PPU saw them at $1000-$1FFF and rendered BG tiles fine. Only the diagnostic-side `nes_chr` read was lying.
  - **Fix:** `memcpy(romdev_chr_buf + i*1024, VPage[i], 1024)` — drop the bogus offset. Patched in `scripts/patches/fceumm-romdev-memory-regions.patch` with an R59 comment block explaining the regression.
  - **Rebuild:** `scripts/build-fceumm.sh` rerun, ~5 min Emscripten compile. New `src/cores/wasm/fceumm_libretro.{js,wasm}` (64 KB JS + 793 KB WASM) staged. The `R59 fix:` comment block appears at line 4022 of the built `libretro.c` confirming the patch made it in.
  - **What about Bug A (OAM DMA not landing)?** Still open. Not a `nes_chr`-patch issue — `nes_oam` patch returns `SPRAM` verbatim (correct). The reply asks for a sentinel-byte diagnostic (`writeMemory(system_ram, 0x0200, "77884499"); stepFrames(2); readMemory(nes_oam, 0, 4)`) to confirm whether DMA is actually broken or whether earlier `nes_oam` reads were at the wrong moment. Pending their next round.
  - **Followup wanted by agent:** vendor the `scripts/patches/` + `src/toolchains/cc65/presets/nes/` into NES projects so they can grep our PATCH sources directly. The Bug B in fceumm-romdev-memory-regions.patch would have been findable by them in 5 minutes if patches were vendored. Queued for next NES round.
  - **Reply:** `~/code/cliemu/reply_to_nes_round2.md`.

- [x] **R58b — Drop bundled library source INTO every scaffolded project tree** (2026-05-27)
  R58 shipped readable library source in the romdev install. That was the half-step — agents could `copyStarterSnippets` to pull source into their project, but it wasn't automatic. R58b makes `createProject` copy library source into the project by default, so the agent's `~/coin-catch/` directory ends with:
  ```
  vendor/cc65/libsrc/lynx/       ← cc65 Lynx libsrc (TGI driver, lynx_snd, joystick, conio, crt0)
  vendor/libtonc/src/            ← libtonc (GBA — every TTE / OAM / IRQ implementation)
  vendor/libgba/src/             ← libgba (GBA — irqInit, VBlankIntrWait, register defs)
  vendor/maxmod/                 ← maxmod (GBA — IRQ-driven mixer in pure asm)
  vendor/pvsneslib/source/       ← PVSnesLib (SNES — consoleDrawText, setMode, padsCurrent, OAM helpers)
  vendor/pvsneslib/include/      ← PVSnesLib headers
  vendor/sgdk/src/               ← SGDK (Genesis — SPR_addSprite, VDP_drawText, XGM2_*, JOY_*)
  ```
  - **Lynx** (`LYNX_VENDOR_DIRS`) wired into all 7 templates explicitly — `vendor/cc65/libsrc/lynx/`.
  - **GBA libtonc + libgba + maxmod** (`GBA_LIBTONC_RUNTIME_DIRS` + `GBA_LIBGBA_RUNTIME_DIRS` extended) — every libtonc/libgba scaffold gets `vendor/libtonc/src/` + `vendor/libgba/src/` + `vendor/maxmod/`.
  - **SNES PVSnesLib** (new `SNES_PVSNESLIB_VENDOR_DIRS`) wired into all 8 C-mode SNES templates.
  - **Genesis SGDK** (`SGDK_RUNTIME_DIRS` extended) — SGDK source tree lands at `vendor/sgdk/src/` for every Genesis SGDK scaffold.
  - **C64 + NES + Atari 2600 + Atari 7800** — auto-vendor via a new fallback in `createProjectImpl`. If `src/platforms/<p>/lib/cc65-src/` exists, copy it to `vendor/cc65/libsrc/<p>/` UNLESS the template already wired it via `runtimeDirs` (skip-if-present check). One block of code handles all four platforms without per-template edits.
  - **Size delta:** added ~5 MB to npm package already in R58. R58b is wiring only — no new source files, just where they land.
  - **Agent UX:** every new project IS a self-contained source tree from day one. `cd ~/my-game && grep -rn bar_c .` finds the bar_c definition in `vendor/cc65/libsrc/lynx/tgi/lynx-160-102-16.s`. No `copyStarterSnippets` call needed. No "what's the address of X in the link map?" feedback round needed. The agent reads what they're building against, period.
  - **What's still NOT solved by R58b:** the agent can READ the library source but the BUILD still links against precompiled `libtonc.a` / `libgba.a` / `libmd.a` / `pvsneslib.obj` etc. So if they EDIT the vendor source, their ROM doesn't pick up the change. That's R59 (source-first build with per-TU object cache — see "Planned: Source-first library scaffolding" below). R58b is the read-access intermediate.

- [x] **R58 — Ship library source for every library we bundle (~5 MB delta)** (2026-05-26)
  Driven by the realization that agents debugging Lynx (R28→R30) couldn't read cc65's TGI driver source because we shipped only the WASM toolchain + bundled wrappers, not the underlying library implementations. Every library that's the agent's PROBLEM (not the MCP server's) now ships with readable source.
  - **What we ship source for now:**
    - cc65 platform libsrc per cc65-using platform: NES, C64, Lynx, Atari 2600, Atari 7800 (244 KB - 596 KB each, at `src/platforms/<p>/lib/cc65-src/`). Includes TGI driver, joystick driver, conio, header builder, sound engines.
    - libtonc full source at `src/platforms/gba/lib/libtonc/src/` (424 KB)
    - libgba full source at `src/platforms/gba/lib/libgba/src/` (280 KB)
    - PVSnesLib full source at `src/platforms/snes/lib/pvsneslib/source/` (524 KB)
    - SGDK full source at `src/platforms/genesis/lib/sgdk/src/` (3.0 MB)
    - maxmod source (already shipped as .s files alongside libmm.a)
    - hUGEDriver source (already shipped — both upstream .asm + our compact C port)
    - famitone2 source (already shipped — .s file)
  - **What we DON'T ship source for** (and the rationale): emulator cores + compilers. Agent can't rebuild them and bugs there route to MCP feedback rounds. We document upstream GitHub for each in the new UPSTREAM_SOURCES.md.
  - **New UPSTREAM_SOURCES.md per platform** at `src/platforms/<p>/UPSTREAM_SOURCES.md`. Covers: local bundled-source paths, upstream GitHub for compilers + emulators not bundled, hardware doc references (Pan Docs / GBATEK / Stella Programmer's Guide / SMS Power / etc.), "when to use what" cheat-sheet.
  - **`getPlatformDoc` extended** to serve UPSTREAM_SOURCES.md too — new `name: "upstream_sources"` parameter (aliases: `'upstream'`, `'sources'`). `listPlatformDocs` now lists it alongside MENTAL_MODEL + TROUBLESHOOTING.
  - **AGENTS.md trust-hierarchy section** added before "## Supported platforms": (1) bundled examples, (2) bundled runtime, (3) bundled library source, (4) UPSTREAM_SOURCES.md doc, (5) upstream GitHub, (6) MCP feedback round. Tells the agent explicitly: "if you find yourself filing a feedback round without first trying step 3 (read the library source), you're probably skipping the cheap diagnosis path."
  - **Size delta:** total `src/platforms/` went from ~16 MB to ~21 MB (~5 MB / ~30% bump). npm package goes from ~85 MB to ~90 MB unpacked. Negligible compared to the WASM cores + toolchains that dominate package size.
  - **The leverage:** every "library X does what?" question becomes a grep-locally answer instead of "guess and post a feedback round." Round 30/31's Lynx wedge would have been a one-line grep (`bar_c` in `lynx-160-102-16.s`) instead of three rounds of speculation. This is the cleanest improvement to dumb-agent capability we've shipped — agents that aren't smart enough to dig will continue to file feedback rounds (which is fine), but agents that ARE smart enough now have something to dig INTO.

- [x] **R57 — Lynx audio+TGI wedge root-caused + fixed (from `feedback_round29_lynx_part2.md`)** (2026-05-26)
  Agent confirmed R56's `tgi_setframerate(60)` fix unblocked HUD+score rendering but `sfx_init`/`sfx_tone` STILL wedged playfield draws. Their bisection: `sfx_init` alone was sometimes-flaky, `sfx_tone` was deterministically broken. They suspected the IRQ-enable bit was at CTL bit 3 ($08) and patched the bundled `lynx_sfx.c` to clear it locally — didn't help.
  **Diagnosed:** their bit-3 theory was wrong (bit 3 = ENABLE_COUNT, not IRQ; IRQ enable is at CTLB bit 7 of system timers, NOT used by audio voices anyway). The actual mechanism is in `~/code/cliemu/retroemu/build/handy/src/lynx/mikie.cpp:1668-1680`: writing the AUDxCTL register with bit 3 (ENABLE_COUNT) OR bit 6 (RESET_DONE) set causes handy to execute `gNextTimerEvent = gSystemCycleCount;` — a SYNCHRONOUS timer-event sweep at the next CPU instruction boundary. That sweep can preempt an in-flight Suzy blit and corrupt the partially-blitted sprite. Symptom: HUD + score render OK (Suzy idle), playfield missing (Suzy mid-blit when the sweep landed).
  **Fix:** restructured `src/platforms/lynx/lib/c/lynx_sfx.c` so `sfx_tone` + `sfx_noise` stage their config in shadow RAM (`sfx_pending_kind[4]`, `sfx_pending_period[4]`) and defer the MIKEY writes until `sfx_update()` runs. The contract is now: **`sfx_update()` MUST be called during vblank** (typically right after `tgi_updatedisplay()`). The handy timer-event sweep then lands during vblank where Suzy is idle.
  **Doc updates:** `lynx_sfx.h` got a prominent R57 callout explaining the staging + vblank contract; `MENTAL_MODEL.md`'s "Known issue" section flipped to "diagnosed → fixed" with the canonical loop pattern. The per-frame melody pattern stays documented as a known-safe alternative to `lynx_snd_play` (which uses a different 240Hz IRQ mechanism and hasn't been re-verified against R57).
  Server restarted (per the proper SIGTERM-by-saved-PID pattern, not `lsof | kill`). Reply: `~/code/cliemu/reply_to_round29_lynx_part2.md`.

- [x] **R56 — Lynx agent friction round (from `feedback_round28_lynx_friction.md`)** (2026-05-26)
  Agent ported the GB coin-catch game to Lynx and hit four bugs: (a) `lynx_snd_play` const-mismatch warning at every call site; (b) confusion between `lynx_snd_stop` (all channels) vs `lynx_snd_stop_channel` (one); (c) TGI renders only the top of the framebuffer (HUD + score) when drawing many rects per frame — playfield + sprites invisible; (d) `lynx_snd_init` + TGI interaction wedges drawing entirely. Bugs (a) + (b) fully fixed. Bug (c) diagnosed but not reproduced — the cc65 Lynx TGI driver is double-buffered (vblank IRQ swaps `DRAWPAGE` via `SWAPREQUEST`) so the most likely cause is loop iterating faster than vblank coalescing swap requests OR palette not loaded into Mikey hardware at boot. Suggested fix in the agent reply: add `tgi_setframerate(60)` + `tgi_setpalette(tgi_getdefpalette())` after `tgi_init()`. Bug (d) documented as a known issue with a per-frame `sfx_tone()` melody workaround. Files changed: `src/platforms/lynx/lib/c/lynx_music.{h,c}` (dropped const + added explainer comment); `src/platforms/lynx/MENTAL_MODEL.md` (three new sections: "Drawing many rectangles in one frame" canonical pattern, "Double-buffering" page-swap behavior, "cc65's lynx_snd music engine" with stop variants + signature gotcha + known TGI interaction + workaround). Server NOT restarted this round (live agent active; per established discipline). Test additions deferred until repro is possible safely. Reply to agent: `~/code/cliemu/reply_to_round28_lynx_friction.md`.

- [x] **R55 — GB OAM-DMA HRAM-stub fix + BSS-zeroing fix (from `feedback_round27_gb_runtime.md`)** (2026-05-26)
  Agent found two critical bugs in the bundled GB runtime that no GB ROM since R10 had been immune to:
  - **`gsinit` zeroed wrong segment.** Pre-r55 `gb_crt0.s` `gsinit:` block targeted `s__INITIALIZED` (the runtime shadow of init-value statics, immediately overwritten by the copy loop) for `l__INITIALIZER` bytes — a no-op. The actual BSS at `s__DATA..s__DATA+l__DATA` (where every uninitialized `static` global lands) was left as power-on WRAM garbage. Symptom: `static coin_t coins[4]; ... if (coins[1].active)` would spuriously fire at boot. Fixed by zeroing `s__DATA` for `l__DATA` bytes BEFORE the `_INITIALIZER → _INITIALIZED` copy. Mirrored to GBC.
  - **OAM DMA spin loop ran from ROM, not HRAM.** During the ~160 µs OAM DMA window the GB CPU can ONLY fetch instructions from HRAM ($FF80-$FFFE); reads from ROM/WRAM/VRAM return $FF which decodes as `rst $38` → CALL $0038 → gb_crt0.s `ret` → stack misaligned by 1 byte → accumulating misfetch lands as the operand of an earlier instruction and the CPU jumps to garbage. Classic symptoms: LCDC silently flips to $FF, BG VRAM $9800-$9BFF wiped to zeros, sprites jump. Pre-r55 `oam_dma_copy` was just `DMA = src>>8; for (i=0; i<80; i++);` — the spin ran from ROM and tripped the bug. Fixed via the canonical HRAM-stub idiom: new `oam_dma_init_hram()` installs a 9-byte stub at $FF80 (`ldh ($46),a; ld a,40; dec a; jr nz,-3; ret`); `oam_dma_copy` now calls the HRAM stub which executes its spin from HRAM where DMA can't conflict. `lcd_init_default()` auto-installs the stub. SDCC sm83 calling convention passes the first `uint8_t` arg in register A — which is exactly what the stub's `ldh ($46), a` consumes. Mirrored to GBC.
  - **Defensive `nop` after `halt`** in `wait_vblank` — canonical DMG HALT-bug guard. We run HALT with IME=1 (safe path) but a 1-byte insurance policy is cheap.
  - **Why both bugs evaded all previous rounds**: SDCC's stock sm83 crt0 was being used instead of our bundled `gb_crt0.s` (a separate bug fixed in R54 — sdld silently rejected the raw .s text shoved into `crt0.rel` and fell back to the stock crt0). Stock crt0 had its OWN gsinit that handled BSS correctly, so bug #1 only manifested AFTER R54 made our custom crt0 actually link. Bug #2 manifested intermittently on gambatte (which doesn't strictly enforce the DMA bus-conflict rule) under specific input-correlated code-path lengths.
  - Files: `src/platforms/gb/lib/c/gb_crt0.s` + GBC mirror, `src/platforms/gb/lib/c/gb_runtime.c` + GBC mirror, `src/platforms/gb/lib/c/gb_runtime.h` + GBC mirror, `src/platforms/gb/MENTAL_MODEL.md` + GBC's (went from 3 to 5 footguns), `src/platforms/gb/lib/c/SDCC_GOTCHAS.md` + GBC mirror (two new sections: OAM-DMA-HRAM + BSS-zeroing). Reply: `~/code/cliemu/reply_to_round27_gb_runtime.md`.

- [x] **R54 — GB agent friction round (from `feedback_round26_gb_friction.md`)** (2026-05-26)
  Same shape as R53 but for Game Boy. An agent built "Catch the Coin" on GB and reported 15 specific items — 13 with code fixes shipped this round, 2 deferred (audio not playing on GB — needs more diagnosis; screenshot stale-pre-init is downstream of #1's fix). Two of the 13 are P0 — every C-mode GB ROM was broken without manual workarounds before this round. 276 → 295 tests passing. Test file: `test/r54-gb-friction-fixes.test.js` (19 tests).
  - **#1 P0 — `patchGbHeader` now fills every cart-header byte $0134..$014C.** The pre-r26 version patched only the Nintendo logo at $0104..$0133 plus the two checksums. ld65's sm83 path fills unused bytes with $FF — including $0143 (CGB flag). gambatte saw $FF, entered CGB mode, silently ignored DMG BGP/OBP register writes → white screen on every C-mode GB ROM. Fixed in `src/platforms/gb/lib/c/patch-header.js` (mirrored to GBC tree). Now writes title ($0134..$013E), CGB flag ($0143 = $00 for DMG, $80 for CGB), licensee ($0144..$0145), SGB flag ($0146), cart type ($0147), ROM size ($0148), RAM size ($0149), destination ($014A), old licensee ($014B), version ($014C), then the two checksums. MCP `patchGbHeader` tool exposes optional `title`, `cartType`, `romSize`, `ramSize`, `destination` overrides; defaults match a ROM-only 32 KB DMG cart.
  - **#2 P0 — `shadow_oam` is page-aligned at $C100.** OAM DMA copies 160 bytes from `$XX00` — the source low byte is discarded by hardware. Pre-r26 `shadow_oam[160]` was a plain global; the linker placed it wherever (often $C017 in the agent's build) and `oam_dma_copy(&shadow_oam)` DMA'd bytes from $C000..$C09F (random WRAM) into OAM. Silent garbage; sprites never rendered where the agent put them. Fixed with SDCC's `__at(0xC100)` attribute on BOTH the definition (in `gb_runtime.c`) and the extern in `gb_runtime.h`. Build map confirms `_shadow_oam 0000C100`. The `__at` attribute MUST appear on both the extern AND the definition or SDCC raises `extern definition mismatches`.
  - **#3 — `loadMedia({bytes})` now passes a platform-aware virtual filename extension.** Pre-r26 in-memory loads landed at `/rom` with no extension; `genesis_plus_gx` (which shares one .wasm across SMS/GG/Genesis) dispatches off the path extension, so a GG ROM was always treated as SMS in the in-memory path. Added `PLATFORM_VIRTUAL_EXT` table in `LibretroHost.js`: `gg → .gg`, `sms → .sms`, `genesis → .md`, etc. `loadMedia({bytes,...})` synthesizes `/rom + ext` when the caller doesn't pass `virtualName`. File-path loads were always fine (the extension is on disk).
  - **#4 — Preflight lint message text reflects the actual SDCC port.** Pre-r26 the lint said "SDCC sm83 is C89 only" on every SDCC platform including SMS/GG/MSX/Coleco (which run sm83's sibling, the z80 port). Cross-platform copy-paste bug. Fixed by threading `port` ("sm83" | "z80") through `lintSources` → `lintSdccSource` → `detectMidBlockDecls` and using a `portLabel` template in every message body.
  - **#5 — Bundled runtime files no longer use C99 inline for-loop counters.** `gb_runtime.c` (`oam_dma_copy` line 57), `sms_sfx.c` (lines 37/63/75), `gg_sfx.c` (lines 37/63/75) all had `for (uint8_t i = 0; ...)` — which the linter we ship would flag if a user wrote it. The bundled code now declares `uint8_t i;` at the top of each function then `for (i = 0; ...)`. C89-clean across every SDCC-bound runtime now (Genesis + GBA runtimes use full-C99 toolchains and are unaffected). Also tightened the linter's "looksLikeCode" heuristic to recognize `i++;` and `++i;` as code (was missing — bug found while testing #5).
  - **#6 — GB `default.c` is a real DMG starter** (not the GBC starter it had been mislabeled as). New copy uses BGP ($FF47) directly, cycles 4 shade arrangements, calls out the DMG-vs-CGB distinction in the comment. GBC `default.c` correspondingly labeled as the GBC starter ("Game Boy Color (CGB) starter") so cross-pollination is obvious.
  - **#7 — Doc reference cleanup.** GB and GBC default.c comments now point at REAL sibling templates (hello_sprite, tile_engine, the 5 genre scaffolds, music_demo) — old comments mentioned helpers that didn't exist as `getStarterSnippet` entries (confused createProject templates with starter snippets).
  - **#8 — `buildSourceWithDebug` accepts SDCC platforms.** Pre-r26 it rejected anything non-cc65. Now: cc65 platforms get `dbg` (the .dbg file) for use with resolveSymbol/lookupAddress/getMemoryMap; SDCC platforms (GB/GBC/SMS/GG/MSX/Coleco/ZXSpectrum) get `mapText` (the sdld .map) + a `mapHint` field explaining the column format. resolveSymbol/lookupAddress don't parse mapText yet (deferred — easy follow-up). Agent can grep the mapText directly for now.
  - **#9 — `getRenderingContext` was throwing `sessionKey is not defined` on GB.** Bug in `getRenderingContextCore({ platform, area })` — captured `sessionKey` from `registerRenderingContextTools` closure but the exported standalone function had no access. Fixed by adding `sessionKey` as a destructured arg + having the MCP wrapper spread it through. Cross-checked all other tools; this was the only one with the bug.
  - **#10 — `readMemory` errors now suggest the right per-platform region.** Pre-r26 message was just "memory region 'video_ram' is empty" — agent burned an hour thinking VRAM was being optimized away. New `_emptyRegionError` helper consults a per-platform suggestion table: on GB it says "use `gb_vram` instead", on SMS "use `sms_vram` or `sms_cram`", on Genesis "use `genesis_cram`/`genesis_vsram`... VRAM itself isn't exposed; use inspectPatternTiles instead". Lands on both readMemory + writeMemory.
  - **#11 — `inspectBackgroundMap` now wired for GB and GBC.** Pre-r26 only NES. New `snapshotBackgroundMap` in `src/platforms/gb/ppu.js` composites the 32×32 BG tile map into a 256×256 PNG, honoring LCDC.3 (map base $9800/$9C00), LCDC.4 (8000_unsigned vs 8800_signed tile-data mode), and BGP for DMG palette. Optional `window:true` renders the Window map base instead (LCDC.6). Returns `mapBase` + `mode` + `lcdc` decode + `scy/scx` so the agent can see where the visible 160×144 region falls within the 256×256 plane.
  - **#12 — SDCC_GOTCHAS.md documents the volatile-VRAM-store hazard.** SDCC sm83 may elide writes through `(uint8_t*)0x8000` casts as dead code (it can't prove the address has side effects). New section in `src/platforms/gb/lib/c/SDCC_GOTCHAS.md` (mirrored to GBC) recommends `memcpy_vram` (volatile-safe by construction) or `volatile uint8_t *` casts.
  - **#13 — `wait_vblank` has an IRQ-driven HALT path** via `enable_vblank_irq()`. Pre-r26 it busy-polled `LY` ($FF44) which updates only at WASM stepFrames quantum boundaries — game loops ran at ~1/30 intended speed on the emulator. New path: `enable_vblank_irq()` writes `IE_REG = IE_VBLANK` + clears `IF_REG` + `EI`. `wait_vblank()` then compiles to `HALT` which sleeps the CPU until vblank fires (`~10` cycles instead of thousands). gb_crt0.s's existing `reti` at $0040 is the only ISR needed (just wakes the CPU). Backward-compatible — `wait_vblank` falls back to LY-polling if `enable_vblank_irq` was never called.
  - **GB ↔ GBC mirror discipline.** All four shared files (`gb_runtime.c`, `gb_runtime.h`, `patch-header.js`, `SDCC_GOTCHAS.md`) verified byte-identical between the GB and GBC trees by a dedicated R54 test. The trees are intentionally independent (R37 split — GBC has BCPS-aware scaffolds, GB doesn't) but the runtime helpers + patch script + gotchas docs must stay in lockstep.
  - **#14 + #15 + root-cause crt0-actually-links fix** (added during the second pass on R54). Diagnosed both deferred items ourselves instead of waiting on the agent's follow-up.
    - **Root cause for both #14 (audio) AND much of #1's stubbornness**: `gb_crt0.s` was NEVER ACTUALLY LINKED into any GB ROM, pre or post R10/R54. `buildZ80C` passed `args.crt0` (raw .s text) straight to sdld as if it were a pre-assembled .rel file. sdld silently failed to parse the malformed "rel" and quietly fell back to SDCC's stock `sm83.lib` crt0 — which has no GB cartridge boot, no IRQ vectors, and no `init`. The map for any GB build showed only `_main` at $0150 with NO `init` symbol. Reset vector $0000 = $FF (linker pad), entry $0100 = $FF (no `nop; jp init`). The stock crt0 calls `_main` but doesn't set up the I/O surface — so writes to NR50/NR51/NR52/etc. either landed on a powered-down APU or ran out of order.
    - **Fix:** `buildZ80C` now sniffs `args.crt0` — if the text doesn't start with the .rel file's `XL2`/`XL3`/`XL4` byte-order tag, it's treated as .s source and assembled through `runSdasgb` (sm83) or `runSdasz80` (z80) BEFORE handing to sdld. Auto-detected, fully backward-compatible (pre-assembled .rel still works). One line in `src/toolchains/sdcc/sdcc.js` checks the regex and conditionally runs the assembler.
    - **Post-fix verification:** GB build map now shows `init: 00000150`, `_main: 00000161`, `gsinit: 00000175`. Entry at $0100 = `00 c3 50 01` (`nop; jp $0150`). Reset vector $0000 = $C9 (`ret`) per the explicit crt0 directive.
    - **#14 audio: works now.** `sound_init` + `sound_play_tone(2, 1953, 6)` produces NR52=$F1 (powered + channel-active flags), NR50=$77, NR51=$FF, NR22=$F0 — exactly what we wrote in C. Audio max amplitude 5140+ (was 3042 pre-fix from gambatte's bootrom emulation alone).
    - **#15 screenshot: works now.** Post-loadMedia screenshot returns a clean 160×144 PNG with center pixel ≈ (255,251,255) — real DMG default render, no pinkish stale framebuffer. R54 test asserts the center pixel isn't pinkish (R doesn't dwarf G or B).
    - **Knock-on effect:** every GB ROM built since R10 was running on stock SDCC sm83 crt0 instead of our bundled gb_crt0.s — explains a lot of "the bundled runtime should work OOTB but doesn't" friction. Now the bundled crt0 ACTUALLY runs. Every R45/R54/etc. GB test still passes because the stock crt0 was "good enough" to compile + boot — but it didn't deliver the clean I/O setup the agent expected. Post-fix the bundled crt0 is the real boot path.

- [x] **R53 — GG agent friction round (from `feedback_round24_gg_scaffold_friction.md`)** (2026-05-26)
  An agent shipped "Catch the Coin" on Game Gear from scratch and reported 9 specific friction points. Five had clear fixes; landed them in one round. Test coverage in `test/r52-gg-friction-fixes.test.js` (9 tests, 263 → 272 passing).
  - **Bundled `gg_crt0.s`** in `src/platforms/gg/lib/c/`. Byte-identical to `sms_crt0.s` (the SMS crt0 itself comments "SMS/GG"). Without it, SDCC's stock z80 crt0 traps `rst $08` and any VDP-touching code hangs at PC=$0007. The GG default scaffold was previously a `unsigned char counter; for(;;)counter++;` stub that worked precisely because it never touched the VDP — every other GG project hit the wall.
  - **Replaced the GG default scaffold** with a real visible-and-runnable program: VDP Mode 4 init + palette + yellow 'H' tile centered in the 160×144 visible viewport + scroll-on-B1 input loop. `examples/gg/templates/default.c`. `TEMPLATES.gg.default` now points to it (and pulls `gg_crt0.s` in via a dedicated `GG_DEFAULT_RUNTIME` so single-file users still get the boot vectors). Old `examples/gg/main.c` stub left in place for backward compat but no longer referenced by templates.
  - **Fixed the R6 sprite-tile-base footgun across 6 files.** `vdp_init.c` + `load_tiles.c` on SMS + GG, plus both MENTAL_MODEL.md files. Old comments said "R6=0xFB → sprite tiles at $2000" — that's BACKWARDS. R6 bit 2 (SA13) is CLEAR in 0xFB, so sprite tiles read from $0000 (sharing the bank with BG tiles). The agent burned 2 iterations on this — `inspectSprites`' `spriteTileDataBase` field reported "$0000" which contradicted the comment, and that's how they found it. New comments say "R6=0xFB → tiles at $0000 (set 0xFF for $2000)" and load_tiles example targets $0000 to match.
  - **GG MENTAL_MODEL.md** gained four hardware-specific footgun sections: (a) **8-sprites-per-scanline limit** — extra sprites on the same row silently drop, classic "first 8 letters of CATCH THE COIN render, rest vanish" symptom; (b) **OAM hardware-vs-visible coords** — libretro screenshot returns 160×144 visible but OAM bytes are still in 256×192 hw-coord space (visible region = OAM x∈[48,207], y∈[24,167]); (c) **SAT $D0 terminator** — Y=$D0 in any OAM slot halts the renderer at that slot, so populating slots 0..5 with `gg_sprite_init`'s $D0-fill in slot 6 means slot 5 is the last visible sprite; (d) the R6 correction. All four pointed at `inspectSprites` for live verification.
  - **SMS MENTAL_MODEL.md** got the shared SMS/GG footguns surfaced more prominently: SAT $D0 terminator (mentioned offhand pre-R53, now its own subsection), R6 correction. The 8-sprites-per-scanline note was already there.
  - **`createGame` extended to platform: 'gg'.** GG already had all 5 genre scaffolds (R22 wired shmup/platformer/puzzle/sports/racing) — just needed the `GENRE_MAP.gg` entry + a tool-description update. Now `createGame({platform:"gg", genre:"platformer"})` works.
  - **New `copyStarterSnippets({platform, destinationDir, language?, include?, overwrite?})` MCP tool.** Replaces the `getAllStarterSnippets → parse giant blob → N×Write` loop with one disk-side call. Bytes never pass through the agent's context. Flattens `lib/<lang>/foo.c` → `<destinationDir>/foo.c` so files land as siblings. Optional `include: [...]` whitelist for cherry-picking. Default `overwrite: true` (vetted boilerplate is meant to be regenerated). `getAllStarterSnippets` description updated to point callers at `copyStarterSnippets` when they're scaffolding to disk.
  - **Runtime fix for the SAT $D0 footgun, not just a doc note.** `sms_sprite_init()` and `gg_sprite_init()` previously filled every Y byte with $D0 (intended as "hidden at boot") — that meant the FIRST gap in a sprite allocation halted the renderer. Both runtimes now park unused slots at $E0 (off-screen, below the 192-line visible area, NOT the terminator). Slots you don't touch stay invisible AND don't kill the renderer; the renderer keeps scanning past them so any slot you later populate actually draws. New `OAM_Y_HIDDEN` macro in both `sprite_table.c` files. MENTAL_MODEL.md sections updated to reflect that the trap is now self-inflict-only (write $D0 yourself if you want early termination).
  - **SDCC preflight linter reports EVERY mid-block decl in a block.** The agent reported "lint says line 533, real decl at 539" — that off-by-N was the linter intentionally suppressing subsequent decls (one-per-block), so a real but obvious decl on line 539 was silenced because an earlier subtle one on 533 had already triggered. Fixed in `src/toolchains/sdcc/preflight-lint.js`: every mid-decl now reports, with an ordinal hint (`Mid-block declaration (#2 in this block)`) on subsequent ones. The agent now sees a full picture instead of one-warning-per-block, eliminating the "real decl is N lines down from where you said" surprise. Detail text also calls out that `_t`/`struct`/`union`/`enum` names all count as decls so the agent doesn't mistrust the linter when the flagged line uses a typedef.
  - **`createProject({withSnippets: true})` — the agent's #7b alternative.** Strict-additive boolean param: when true, drops every vetted starter snippet for the platform into the project dir alongside main.c after the template's own runtime files are written. Skips overlaps (snippets already written by the template's `runtime:` list). Response gains a `snippetsCopied: string[]` field. Composes with `createProject` directly so callers who want "main.c + every helper without picking a genre" get it in one shot — no second `copyStarterSnippets` call needed.
  - **One feedback item explicitly NOT addressed in this round:**
    `createGame` for MSX + Coleco — these platforms only ship `default` today and need 5 genre scaffolds built first; tracked as separate work. The "great things, keep doing" list items are kept doing.

- [x] **R52 — Lynx `default` template + GBC/Lynx template-parity test coverage** (2026-05-26)
  Post-music-sprint inventory audit caught two small gaps that the per-platform test matrix had drifted past:
  - **Lynx had no `default` template.** Every other platform starts with `default` as the canonical "ROM that does something visible" entry point — Lynx jumped straight to `hello_sprite`. New `examples/lynx/templates/default.c` is a TGI color-cycling square + "HELLO LYNX" greeting, registered as `TEMPLATES.lynx.default` (inserted before `hello_sprite` so it leads the menu). Gotcha caught during build: cc65's Lynx palette is RED/PINK/LIGHTGREY/GREY/DARKGREY/BROWN/PEACH/YELLOW/LIGHTGREEN/GREEN/PURPLE/BLUE/LIGHTBLUE/WHITE — no CYAN/MAGENTA. Template uses LIGHTBLUE/PURPLE/LIGHTGREEN to keep the rainbow feel.
  - **R37 GBC parity test didn't cover `default` or `music_demo`.** GBC has 9 templates on disk (default + 7 genre scaffolds + music_demo), R37 was covering 7 (R45-gbc-music covers music_demo separately). Added `default` to R37's GBC_TEMPLATES array so the BCPS-write assertion runs on the GBC default too (it already wrote BCPS, just wasn't being checked).
  - **R38 Lynx parity test didn't cover the new `default`.** Added it to LYNX_TEMPLATES — same in-loop assertion (compiles + ROM ≥ 1 KB).
  - **Test count unchanged at 263** because both edits widened existing in-test loops rather than adding new `test()` calls. Each platform now has 8 genre scaffold variations covered in its R37/R38 parity test.

## Decisions made

- **Where do `.wasm` cores come from?** Resolved: bundled in the npm package, sourced from sibling `retroemu/cores/` which has its own build pipeline. `scripts/sync-cores-from-retroemu.sh` refreshes.
- **SGDK on Linux/macOS.** Resolved: skipped entirely. The "agent writes asm" insight made vasm68k the simpler answer. SGDK runtime equivalents are post-v1.
- **MCP transport.** stdio for v1. SSE/HTTP can be added later for remote agents.

## R15 — cross-game sprite-lift pipeline (2026-05-26)

Other agent dropped `~/code/cliemu/feedback_round12_cross_game_sprite_lift.md`
after porting Excitebike CHR → Adventure GBC. The lift worked but
required ~150 lines of glue-code (PNG decode + palette quantize +
manifest gen) the MCP should own. Status:

- [x] **`cropSpriteSheet({path, tileX, tileY, tileW, tileH, outputPath})`** —
  crops a rectangular region of tile cells from an existing tile-grid
  PNG, preserves PLTE via nearest-neighbour remap. Lives in
  `src/mcp/tools/sprite-pipeline.js`. Test: 2/2 pass.
- [x] **`quantizePngForPlatform({path, platform, outputPath, mode?, maxColors?})`** —
  reduces an RGBA PNG to the platform's per-subpalette limit. Per-platform
  defaults wired (NES/GB/GBC/Atari7800 = 4; SMS/GG/SNES/GBA/Genesis/MSX/
  Coleco = 16). Modes: `frequency` (default), `luminance` (sort by luma
  so idx 0 is lightest), `platform-master` (NES-only today, snaps to
  the 2C02 master palette). Tests: 3/3 pass.
- [x] **`crossPlatformSpriteImport({sourceRom, sourcePlatform, sourceBank | sourceOffset, sourceTileX/Y/W/H, targetPlatform, outputPng, outputManifest?, ...})`** —
  one-call composite: read source ROM → render tile bank → crop region
  → quantize to target palette → emit TexturePacker-style manifest.
  Output PNG + manifest feed directly into `loadSpriteSheet`. End-to-end
  NES → GBC lift verified (1/1 test).
- [x] **`extractSpriteSheet({platform:"atari2600"})`** — refuses with a
  structured error pointing to disassembleRom + findReferences for the
  sprite-table-scan workflow. No more noise output.
- [x] **`loadSpriteSheet` — minimum manifest example in description.**
  Both hash + array forms shown.
- [x] **`loadSpriteSheet` — `dedup: "merge"|"preserve"|"preserve-blanks"`
  option.** Default stays `merge`. `preserve` gives every slice a unique
  tile slot regardless of content equality; `preserve-blanks` keeps blank
  tiles unique while still merging identical non-blank tiles.
- [x] **`loadSpriteSheet` / `loadAsepriteSheet` / `loadGifAnimation` — `emit: "raw"|"c"|"ca65"|"rgbasm"` + `emitDefines: true`.**
  `tile_source` field returned in the chosen syntax with per-tile name comments;
  `defines` field returned with `#define T_FOO 0` / `T_FOO = 0` / `T_FOO EQU 0`
  per slice (loadSpriteSheet + loadAsepriteSheet — loadGifAnimation has no
  named frames so it skips defines). `loadTilemap` deferred — tilemaps are
  per-cell layouts, not tile banks; emit doesn't apply the same way.

## R17 — `intent` axis on the asset tools (SHIPPED 2026-05-26)

Other agent dropped `~/code/cliemu/feedback_round15_intent_modes.md`
then v2 after a back-and-forth. Converged design shipped:

- [x] **`intent: "homebrew" | "rom-hack"` REQUIRED** (no default) on
  `extractSpriteSheet`, `cropSpriteSheet`, `previewTileArt`,
  `crossPlatformSpriteImport`, `quantizePngForPlatform`. The user
  pushed for "required, not defaulted" — every call declares its
  purpose at the call site, dumb agents get the question put right
  in front of them via the tool description.
- [x] **Per-platform default palette table** at
  `src/platforms/common/default-palette.js`. NES PPU reset values,
  DMG green, GBC default, SMS/GG, MSX/Coleco (TMS9918), SNES, Genesis,
  Atari 7800. Used by `previewTileArt` and `extractSpriteSheet` when
  `intent:"homebrew"` and no ROM is loaded — agent gets color, not
  grayscale.
- [x] **`getLospecPalette({id, asPlatform?})`** in
  `src/mcp/tools/lospec.js`. Fetches a CC0 retro palette from
  lospec.com by URL slug; optionally snaps colors to the platform's
  hardware master (NES today; other platforms verbatim with a note).
- [x] **`intent` echo'd in every response.** Even though it's
  required at the call site, the response shape includes it so
  log-grepping is easy.

Resolved design calls (matching the v2 convergence):

1. **`loadSpriteSheet` default `dedup` does NOT shift under
   homebrew** — kept `merge` in both intents. Agent agreed (their
   own R12 workflow used `merge` everywhere except one explicit
   `preserve`).
2. **`crossPlatformSpriteImport` under `rom-hack` skips auto-quantize.**
   Tool still runs; source bytes preserved verbatim. The agent's
   v2 added the nuance that NES 4-color → SNES 16-color
   subpalette workflows don't need quantize at all, which is
   exactly where preserve-source is the right behavior.

Tests: `sprite-pipeline.test.js` (6, updated for intent), `sprite-pipeline-intent.test.js` (8, new), `lospec.test.js` (5, new). 150/150 pass.

Deferred from R17, queued for next round when the agent re-runs the
Excitebike → GBC lift under `intent:"homebrew"`:

- Validation strictness (homebrew enforces platform limits, rom-hack warns)
- Error-message tone (how-to-fix vs terse)
- CHR-size + cross-bank warning thresholds

These add infrastructure (per-tool warning collectors); R17 ships
the axis + the per-tool default bundle, the warning layer follows
when there's a concrete workflow asking for it.

### R17 validation findings (queued — `feedback_round17_intent_validation.md`)

Agent re-ran Excitebike → GBC under `intent:"homebrew"` and
reported one concrete gap, plus broad signal that the axis design is
working. Tone: "smooth experience overall. Required arg felt right
at the call site." Specifics:

**Working:** required-arg enforcement; `extractSpriteSheet` with
`intent:"homebrew", paletteIndex:N` correctly returns live NES
emulator colors; `crossPlatformSpriteImport` echoes
`quantizeMode:"platform-master"` matching the v2 doc; `nextStep`
in response saves a round-trip; manifest with 24 named frames
works for the `preserve` enumeration case.

**One concrete gap:** `crossPlatformSpriteImport` under
`intent:"homebrew"` does NOT propagate the SOURCE platform's live
emulator palette through to its internal `extractSpriteSheet`
step. Result: output palette is the GBC platform default
(grayscale-toned), not the actual NES source palette (vivid red
bike + blue rider on Excitebike).

Repro: load Excitebike → step 300 frames → standalone
`extractSpriteSheet({intent:"homebrew", bank:1, paletteIndex:4})`
returns vivid colors; same coordinates via
`crossPlatformSpriteImport({intent:"homebrew", ...})` returns
default-palette grays.

Root cause is one of:
- (a) internal extract doesn't check `paletteFromEmulator:true`
  from the homebrew default for the SOURCE platform
- (b) composite re-quantizes immediately to target default before
  the source colors are ever seen

Fix: under `intent:"homebrew"`, the composite must:
1. Pull live emulator palette for the SOURCE platform in the
   internal extract step (today's standalone-extract behaviour)
2. Preserve those colors through the crop step
3. Only at quantize step does it retarget to the destination's
   palette space

**Also queued (agent offered):** validation run of
`intent:"rom-hack"` cross-platform path, specifically the case
"NES 4-color → SNES 16-color subpalette where preserve-verbatim
is exactly right" — this is the case the v2 reply highlighted
and they haven't run yet.

This is small (~20 lines in `crossPlatformSpriteImportImpl` to
thread `paletteFromEmulator` + `paletteIndex` through to the
inner extract). Will ship alongside the R17 deferred warning-layer
when the time comes — both pieces of feedback land at the same
layer of the composite tool.

## Planned: Source-first library scaffolding (no precompiled .a blobs)

Replace the "ship .a + ship source you can read but not modify" pattern
from R58 with "ship source, compile on first build, cache per-TU."
The agent ends up with the FULL source tree of every library their
ROM links — they can read it, modify it, strip it, debug it. No
black boxes anywhere except the system libs they can't productively
touch (libc / libgcc / newlib startup objects).

### Why

R58 shipped readable source alongside the prebuilt .a blobs. That
half-solved the problem: agents can NOW grep `libtonc/src/tte/
tte_init.c` to understand what an API does. But if they spot a bug
or want to tweak behavior, they have no path to actually CHANGE it —
the link target is still our precompiled `libtonc.a`. They can read
the truth but not act on it.

The R28-R32 Lynx round chain is the canonical example: agent
debugged through 5 feedback rounds because cc65 driver state was
opaque. Even with R58 the agent can READ the driver but the .a is
the link target, so testing a theory still requires us to ship a
fix between rounds. Source-first scaffolding closes that loop: agent
edits driver source locally, rebuilds, sees the result, ships fix
without any round-trip through us.

### Trade-off (the user already accepted this)

- First build per project: ~5-30 seconds compiling library sources.
- Steady-state rebuild: same speed as today (per-TU object cache hits).
- Zero token cost regardless — agent waits on a tool call, doesn't
  burn tokens, doesn't lose context.

For a game that iterates hundreds of times, a 30-second first-build
is noise. For an agent that would otherwise burn 5 feedback rounds
on a black-box bug, it's a massive net win.

### What ships as source vs stays as blob

- **Source (compiled at build time, agent owns):**
  - libtonc (GBA, ~420 KB src)
  - libgba (GBA, ~280 KB src)
  - maxmod (GBA, already mostly .s files — keep)
  - PVSnesLib (SNES, ~520 KB src)
  - SGDK libmd (Genesis, ~3 MB src)
  - cc65 platform libsrc (NES, C64, Lynx, Atari 2600/7800 — already shipped in R58)
  - SDCC runtime sources for sm83 + z80 (if we can extract them
    cleanly — needs investigation, may need to bundle separately)
  - hUGEDriver (already source)
  - FamiTone2 (already source)
- **Blob (foundational, agent can't productively modify):**
  - libc, libgcc, libm (newlib for m68k-elf + arm-none-eabi)
  - crt0/crti/crtn/crtbegin/crtend system startup objects
  - SDCC's sm83.lib / z80.lib runtime libraries (until SDCC source bundling lands)
  - The compiler binaries themselves (sdcc.wasm, cc65.wasm, etc.) —
    these stay WASM forever, not shippable as buildable source

### Architecture

#### Per-TU object cache

Persistent on disk at OS user-data dir, keyed by content hash:

```
~/.local/share/romdev/objcache/
  <platform>/
    <lib-or-project-name>/
      <sha256(source bytes + compiler flags + toolchain version)>.{o,rel}
```

`buildSource` flow:
1. For each .c/.s/.asm source (whether from agent's main.c, from
   bundled libtonc/src/, or from any project file):
   - Compute `key = sha256(source + canonical-flags + toolchain-id)`
   - If `objcache/<platform>/.../<key>.o` exists, use it (no compile)
   - Else compile, cache to objcache, use it
2. Link all .o + crt0 + system libs into ROM

First build = lots of misses, many seconds. Second build = all hits,
fast. Edit one file = one miss, recompile just that TU, fast link.
Same mental model as `make`.

#### Scaffold output

`createProject({platform:"gba", template:"shmup"})` writes:

```
my-game/
  main.c
  README.md
  .gitignore
  libtonc/                  ← full libtonc source tree
    include/
      tonc.h
      tonc_video.h
      ...
    src/
      tte/tte_init.c
      tte/tte_chr4c.c
      core/key_poll.c
      ...
  libgba/                   ← full libgba source tree
    ...
  maxmod/                   ← maxmod .s source tree
    ...
  gba_sfx.{c,h}             ← our wrapper
  gba_sfx_data.s
  gba_crt0.s
  build.json                ← lists which sources to compile
```

`build.json` (or similar — `Makefile` if we keep it simple) tells
`buildSource` what compiles into the ROM. Default is "everything in
the dir." Agent can comment out / delete a library they don't need
to shrink ROM size.

#### Library build flags

Each library has specific flags it needs (libtonc wants `-fno-strict-
aliasing` + specific arm-eabi flags; SGDK wants `-m68000 -Os` + a
specific include order). We ship a per-library JSON or .mk fragment
that says "compile these files with these flags." The agent doesn't
write it; we ship it as part of the source bundle.

### Migration path

Don't flip every platform at once. Pick one as the proof-of-concept,
land it cleanly, then replicate.

1. **GBA first** (libtonc is the simplest — ~50 .c files, clean
   structure, no chained dependencies beyond newlib). Implement
   per-TU caching + library-flags handling. Measure first-build and
   cached-rebuild times.
2. **Validate**: build the existing GBA scaffolds + tests against
   the source-first path. ROM size should be identical to the .a-
   linked version (within rounding). Function symbols should match.
   Audio should still play. Run R28 / R33 / R34 test suite.
3. **Replicate**: libgba (GBA), then PVSnesLib (SNES), then SGDK
   (Genesis), then cc65 platform libs (NES / C64 / Lynx / Atari
   2600 / Atari 7800). Each is ~half a day's work.
4. **Maintain .a as fallback**: keep precompiled .a around for one
   round in case source-first has a regression. Easy to switch back
   if a library has a build-system quirk we missed.

### Estimated build times (first build, single-core WASM compile)

- libtonc full source: ~10 sec (small)
- libgba full source: ~8 sec
- PVSnesLib full source: ~12 sec
- SGDK libmd: ~60 sec (it's 3 MB of C)
- cc65 platform libsrc: ~5 sec
- maxmod (pure asm): ~3 sec

These are per-project, one-time. Subsequent builds hit the cache
and take ~0 sec for unchanged TUs. Agent iterating on main.c only:
~1-2 sec rebuild (just their TU + link).

### Open design questions

- **Cache eviction.** Per-platform per-library directories grow
  unbounded over time as flags / source versions change. Need a
  prune policy ("keep last N project hashes" or "keep last 30
  days"). LRU-style.
- **Shared cache vs per-project.** Currently designed as
  per-toolchain-and-source-hash, so two projects building libtonc
  from the same source share cached objects. That's right — keeps
  the cache from blowing up linearly with project count.
- **Per-library Makefile vs single big build.json.** Lean toward
  per-library `build.json` (small, agent-readable, easy to edit if
  they're customizing).
- **What about cc65's `_BSS` ordering** + similar linker config
  details that affect runtime behavior beyond just "link these
  files"? Need to make sure our per-platform link config still
  produces the right memory map.

### Why this is the right structural fix

Three of the five Lynx friction rounds (R28, R30, R31) were
fundamentally "agent debugging a library it can't change." Two of
the GB rounds (R54, R55) were "MCP server discovered a runtime bug
in code the agent had been using for weeks without recourse."
Source-first scaffolding inverts both:

- Agent finds bug in library → fixes it in their project source →
  ships → reports back: "by the way, libtonc/src/tte/tte_init.c
  line 47 has X bug, fixed locally."
- We adopt the agent's fix upstream → next agent gets the
  better source.

This is the same pattern that makes open-source homebrew toolchains
work at all. Currently we ship a half-open-source experience (read
source but link a blob). Going full-source closes the loop.

### When to build it

After the immediate friction-round cycle calms down. The Lynx
chain is still active; finishing that (or moving on from it
cleanly) should come first. Then this is the next major round —
estimated 1-1.5 weeks of work to land all platforms end-to-end with
proper testing.

This + the `/livestream` observer below are the two biggest
structural improvements left on the list. They're independent;
ship in either order. My instinct: source-first first (more
agent-impactful), observer second (more user-impactful).

## Planned: Session observer / livestream (`/livestream`)

A passive web viewer for live monitoring of agent sessions. Not yet
built — design captured here so it doesn't evaporate.

### The idea

Every tool call, every screenshot/PNG output, every code change, every
build, every emulator state change already passes through the MCP
server as the single chokepoint. Tap that flow and publish to a
WebSocket-backed web page. **Zero agent involvement**, zero token cost
to the agent, full fidelity (real PNGs not ASCII), per-session
isolation, persists across agent crashes.

### Why this is the right shape

Earlier in R56 we discussed ASCII screenshots and agent-side
incentives for showing progress. Both have a fundamental problem: ASCII
is lower-fidelity than the PNG the agent already needs, and "agent
incentive to surface visuals" requires either token-cost manipulation
or system-prompt nudges. Neither is clean.

The observer flips the framing — instead of asking the agent to do
anything, the server publishes what it already produces to a side
channel. The agent doesn't know the channel exists. The user sees
agents "moving and groovin" in real time without touching the agent
loop at all.

### Architecture

- **`SessionLog` class per `sessionKey`**, append-only. Holds the last
  N events in a ring buffer (in-memory) AND streams to disk as JSONL
  at `~/.local/share/romdev/sessions/<sessionKey>/events.jsonl`.
  PNGs land as siblings (`event-0042.png`) with the JSON event holding
  the relative path.
- **Middleware in `src/mcp/tools/index.js`** wraps every `safeTool`
  registration: before-call logs `{tool, args, sessionKey, ts}`,
  after-call logs `{result, durationMs, error?}`.
- **PNG tap at `src/host/framebuffer.js`** + pngjs writes — both go
  through known chokepoints; intercept once.
- **WebSocket server** on the same port 7327 (Node `http` server can
  route `/mcp` → MCP transport, `/livestream` → static HTML, `/livestream/ws`
  → WS upgrade). Single port, single process.
- **Hybrid frames**: JSON text frame for control + structured data
  (`{type: "screenshot", sessionKey, ts, byteLen, fmt: "png"}`), then
  the next binary frame is the actual PNG bytes. Browser pairs them,
  `URL.createObjectURL(blob)` for the `<img>`.
- **Replay-on-connect**: when a client connects, send the last N events
  from the per-session ring buffer so they see context, then live-stream.

### `/livestream` page UX

- Single landing page, **tabs across the top** for each active session.
- **Auto-select first tab** when only one session is active (the
  common case — zero clicks to start watching).
- New session connects → new tab appears; current view unchanged.
- Session ends → if you're on it, fall back to the next live one
  (or stay if you've pinned closed sessions).
- Each tab shows a small indicator: last-frame thumbnail, call rate,
  current platform.
- Main panel: chronological timeline (scrolling) of events with
  per-event rendering — screenshot thumbnails for PNG events, build
  status pills for `buildSource`, color-coded badges by tool category
  (build / run / inspect / patch).
- Full-frame PNGs at native resolution; CSS `image-rendering: pixelated`
  + zoom controls (1x for timeline, 4x for inspector, 8x for "look at
  this specific tile"). Browser handles scaling for free.
- Optional inspector overlays: sprite bounding boxes from
  `inspectSprites`, palette swatches, tile-grid lines on top of the
  framebuffer.

### Disconnect handling — flight recorder for crashes

- `transport.onclose` fires (R13 already hooks it for `clearHost`);
  observer adds `{type: "session_ended", sessionKey, reason}` event.
- **Reason classified**: `graceful` (clean shutdown), `abrupt` (socket
  dropped, no close handshake — the OOM-kill / crash signature). Tab
  bar color-codes accordingly (gray = graceful, red = abrupt).
- **Session log persists on disk** as it writes, not just in memory.
  When an agent process dies, the full timeline up to the last
  successful tool call is already on disk. Scrub it post-mortem to
  see exactly where they were.
- This generalizes: it's a **black box recorder for every agent
  session**, period. Crash, get-stuck, do-the-wrong-thing — you have
  the flight recorder.

### Adjacent uses

1. **Live monitoring** — see what each agent is doing right now,
   across sessions, without disturbing them.
2. **Post-mortem** — "the agent got stuck on the GB build at 3pm,
   what happened?" → scrub the timeline.
3. **Feedback collection** — agents' `feedback_round*.md` reports
   reconstruct from context. With the log, "see calls 47-53, that's
   where it went sideways" is concrete.
4. **Training signal** — corpus of "real agent sessions, what worked
   vs what didn't" is what fine-tuning + eval pipelines want.
5. **Replay** — given a logged session, replay tool calls against a
   fresh server to reproduce a state.

### Bonus subtleties that make it actually fun to watch

- **Color-code by tool category** (build / run / inspect / patch).
  Glance at the scroll, see "this agent is stuck in inspect-inspect-
  inspect" vs "this agent is iterating builds fast."
- **Audio waveform sparklines** when `recordAudio` happens. Visually
  see whether the agent is getting silence vs tones over time.
- **Calls-per-minute indicator.** Visceral sense of "agent is
  hammering" vs "agent is thinking."
- **Diff view on file writes.** When the agent does `patchFile` or
  rewrites main.c, show before/after side-by-side.

### Code-cost estimate

- `src/observer/session-log.js` — log + ring buffer + disk write (~80 lines)
- `src/observer/middleware.js` — wraps safeTool registration (~50 lines)
- `src/observer/png-tap.js` — wraps framebufferToScreenshot + pngjs (~30 lines)
- `src/observer/ws-server.js` — WS server on port 7327 path (~80 lines)
- `src/observer/livestream.html` — single-page client (~250 lines)
- **Total: ~400-500 lines, no new deps** beyond `ws` (transitively present).

### Open design questions

- **Retention policy.** Per-session JSONL grows fast (~hundreds of KB
  per minute under iteration). Need "keep last N sessions" or "keep
  last 7 days" + opt-out per session for sensitive/CI runs.
- **Auth.** Right now MCP is loopback only (127.0.0.1:7327), no auth.
  If we ever bind to non-loopback, the observer page becomes a
  privacy/security surface — would need at minimum a session token
  in the URL.
- **In-tree vs sibling package.** Bake into romdev (one
  `npm install` for everything) OR sibling `romdev-observer` package
  (easier to evolve independently, run multiple viewers against one
  server). Lean toward in-tree for v1 — easier deploy.

### When to build it

Not urgent — agents work today without it. Bank for a quiet stretch
between friction-fix rounds. Best window is when there's a concrete
"I wish I could see what the agent was doing in this session" moment
to design FOR.

## Open questions

- **C64 emulator core.** ✅ shipped 2026-05 with deep introspection (see M7 entry).
- **macOS + Windows CI.** Architecturally cross-platform via Node+WASM, but only Linux is currently CI-tested.
- **Project scaffold tool.** `createProject({ platform, name })` would generate a starter project layout. Useful once we have more than `main.c` examples.
- **`watchMemory` MCP tool.** Currently the agent diffs successive `readMemory` calls. A real watch (triggered next `stepFrames`) would be nice for breakpoint-like workflows.
- **Multi-language per platform (FUTURE).** Today `buildSource` does platform → one-toolchain mapping (`atari2600 → dasm`, `snes → asar`, ...), with cc65 the only multi-language exception (heuristic-sniffs C vs asm). But real retro platforms often have multiple language ecosystems: Atari 2600 has batariBasic (BASIC) and 7800basic alongside dasm; Genesis has SGDK (C via m68k-gcc) alongside vasm68k; Game Boy has GBDK (C via sdcc) alongside RGBDS; SNES has PVSnesLib (C via tcc) alongside asar. Plus speculative future languages (Rust-on-NES via a custom backend, TinyGo-on-GB, etc.).

  Plan: `language` is an **optional** parameter on `buildSource({platform, language, source, ...})`. Each supported platform has a **documented default language** (asm for most, since LLMs write asm fluently — see "Key insight" above; cc65 platforms default to C; etc.). `listPlatforms()` returns the default + supported language list per platform so agents can see what's available without trial-and-error. Server maps `(platform, language)` → toolchain. No new toolchains bundled yet — adding batariBasic / SGDK / GBDK / PVSnesLib happens lazily as agents ask for them. Existing source-content heuristic on cc65 stays as a fallback when language is ambiguous within an already-multi-language toolchain.

  Design principle: **most users (and all agents in vibe-coding mode) shouldn't care what language a ROM is built in.** The default per platform is the best choice for fast vibe-coding loops — smallest toolchain, fastest build, best LLM fluency. Picky users (the "I want C, not asm" / "use BASIC because nostalgia" crowd) opt in via the `language` parameter; they're a small minority. Never default to a "friendlier" language at the cost of build size, speed, or LLM fluency — when the picky user wants it, they ask for it explicitly. Non-bundled languages return `available: false` in `listPlatforms()` so the matrix is discoverable but the demand-pull workflow stays honest about what's actually shipped.

  Why now: cheap to add, future-proofs the API. Why not bundle the toolchains yet: each one is its own multi-hour Emscripten build + tens of MB of runtime libs (the "Starter libraries — minimal in v1, full SDK runtimes deferred" decision applies). Land the axis; add language toolchains demand-pulled.
- **Per-session host isolation.** ✅ shipped 2026-05-26 (R13). `src/mcp/state.js` now keeps a `Map<sessionKey, LibretroHost>` instead of a process-wide singleton; the transport layer mints a UUID `sessionKey` per `McpServer` instance and threads it through `registerTools` → category register fns → tool-handler closures. `transport.onclose` calls `clearHost(sessionKey)` so disconnecting clients don't leak emulator instances + SDL windows. Test: `test/session-isolation.test.js` spins up two independent in-process MCP sessions, loads nestest in A, asserts B sees `loaded:false`, then loads in B and asserts `frameCount` advances independently (60 in A, 0 in B). Playtest's `_sdlModule` singleton is still process-wide (only one SDL window at a time anyway — a clean fix would scope its `session` map by sessionKey too; deferred).

## Constraints we will not bend

- **No native FFI anywhere in v1.** Both cores and toolchains run as WASM. End user never installs a native binary. Period.
- **No per-OS code in the harness.** Paths, fetches, encoders must be OS-agnostic.
- **Every capability has an MCP tool.** The CLI is for our smoke tests. Don't add CLI-only features.
- **Bundle size is not a constraint.** Ship multiple cores per platform when useful, keep full toolchain features, bundle reference docs inline. The product is "zero setup friction." Trading install bandwidth for that is the whole deal.
