# Changelog

All notable changes to `romdevtools`. Dates are release dates.
(Published as `romdev-mcp` through 0.11.0; renamed to `romdevtools` in 0.13.0 —
the `romdev-mcp` bin is kept as an alias.)

## 0.14.0

**Two platform-specific top-level tools folded into their domain verbs, a
device-free cheat search, and skill-surface polish.** Pre-1.0 the surface keeps
consolidating with no deprecated aliases (call `catalog({op:'whatsNew'})` for the
live OLD→NEW map), so the tool count drops 34 → 32.

### Changed (breaking — pre-1.0, no aliases)
- **`patchGbHeader` → `romPatch({op:'gbHeader'})`.** It's a ROM-file patch, same
  family as romPatch's other ops — not a standalone Game-Boy tool. Same params
  (path/outputPath/cgb/title/cartType/romSize/ramSize/destination), same output.
- **`dmaTrace` → `watch({on:'dma'})`.** The Genesis VDP-DMA trace is a log-all
  trace like `watch`'s on:'mem'/'range'/'pc' — now a fourth `on`. Same
  `precision:'exact'|'sampled'` + filters.
- **`cheats({op:'search'})` no longer needs `platform`.** Omit it and the search
  sweeps EVERY indexed platform; each match reports its own `platform`. You don't
  have to know the console to find a game's cheats. Pass `platform` only to scope
  the search to one console.

### Added
- **`GET /skills/romdev/SKILL.md`** is now the primary skill URL — it mirrors the
  on-disk path agents save skills to (`~/.claude/skills/romdev/SKILL.md`) exactly.
  `/romdev/SKILL.md` and the flat `/romdev-skill.md` are kept as aliases.
- **The `/livestream` observer header now links to `/documentation`** (the live
  Swagger console), so a human watching can jump to the API docs.

### Fixed (HTTP transport — failures are now unmissable)
- **A failed tool call returns a non-2xx, never a 200 with the error in the body.**
  Tools that signal failure by RETURNING a failure-shaped result ({ok:false} /
  {opened:false} / {applied:false} / a top-level `error`) — not just by throwing —
  now map to HTTP 400 uniformly for EVERY tool. Before, e.g. `playtest` returning
  `{opened:false}` came back 200, so an agent driving the REST/skill surface saw
  "success," never read the body, and reported "window's up!" while no window
  existed. (Valid "no"/state answers — `notSupported`, `matched:false`,
  `loaded:false` — correctly stay 200.) A failed `playtest` window-open also now
  logs to the server console so a human at the terminal sees it regardless.
- **`x-romdev-session` is now REQUIRED — a missing header returns 401**, instead
  of the server auto-minting a throwaway one-shot session (which silently dropped
  the loaded ROM and surfaced as "No ROM loaded" a couple calls later). The 401
  message tells the agent to pick one stable id and send it every call.

### Fixed (playtest — no more invisible windows)
- **`playtest({op:'open'})` now FAILS LOUDLY when there's no real display** instead
  of reporting `opened:true` for a window nothing can see. If the server's SDL
  comes up on the `offscreen`/`dummy` video driver (no desktop session — server
  started over SSH, from a tty, before the desktop login, or as a headless agent
  subprocess), the window would render and play audio but never appear on a
  screen. We now detect the selected driver via SDL itself
  (`sdl.info.drivers.video.current`) — ground truth, cross-platform (Linux/macOS/
  Windows), and it correctly ALLOWS a virtual display like Xvfb (reports `x11`,
  not `offscreen`). On the offscreen case the open throws (→ 400 / MCP error) with
  the exact fix: run the server from inside your logged-in desktop session.
  Headless tools (screenshot/runSource/inspect) are unaffected — offscreen stays
  fine for everything except opening a window for a human.

### Changed
- **The skill/HTTP session docs now coach a UNIQUE, task-descriptive
  `x-romdev-session` id** (e.g. `nes-platformer-build`) — the id is the label a
  human sees in `/livestream`, and it's how several agents share one server
  without clobbering each other's emulator host.

## 0.13.0

**Renamed `romdev-mcp` → `romdevtools` + a plain-HTTP tool surface and an Agent
Skill, so you can drive the same tools without using MCP.** Most agents support
MCP; some people just prefer not to (setup, always-on context cost, server
lifecycle). The same 34 tools are now reachable three ways — MCP, plain HTTP,
and a portable SKILL.md — all generated from the one tool registry (no
duplication). Same Express app, same localhost trust, per-agent dynamic sessions.

### Changed (rename + robustness)
- **Package `romdev-mcp` → `romdevtools`**; primary command is now `npx
  romdevtools`. `romdev-mcp` stays a bin alias of the same server, so existing
  `npx romdev-mcp` / MCP configs keep working. CLI bin → `romdevtools-cli`.
- **Server fails loudly on a bad bind.** The primary HTTP listener now handles
  `error`: a taken port prints a clear "port N in use — use a different port"
  message to stderr and exits non-zero, and the success banner only prints on a
  real bind (previously it could print "listening…" + exit 0 while not bound).
  `GET /healthz` now returns `version` (so a saved skill can detect staleness).

### Added
- **`POST /tool/{name}`** — run any tool over plain HTTP; JSON body = the args,
  JSON response = the result. Same handlers, same strict validation, same clean
  errors as MCP (bad enum / wrong type / "unknown parameter 'addr' — did you mean
  'offset'?"). Sticky emulator sessions via an `x-romdev-session` header (the
  first call returns one; echo it to keep a host across load→step→read); omit it
  for one-shot file tools. No auth (localhost, same model as `/mcp`).
- **`GET /openapi.json`** — OpenAPI 3.1 for every `/tool/{name}`, request schemas
  via zod→JSON-Schema (the same conversion MCP `tools/list` uses).
- **`GET /documentation`** — Swagger UI over the spec: a live "try it" console.
- **`GET /tool/{name}/schema`** — that tool's JSON Schema (a validator on demand).
- **`GET /skills/romdev/SKILL.md`** — the Agent Skills open-standard SKILL.md
  (frontmatter + workflow guide + generated tool reference). ~100 tokens of
  name+description until invoked vs the always-on MCP tool defs — the on-demand
  context win. Works in Claude Code, opencode, OpenClaw, Hermes, etc. unchanged.

### Changed
- **AGENTS.md is now channel-neutral.** The "how to call" prose lives in per-
  channel preambles (`src/http/skill-doc.js`): the MCP connection text =
  mcpPreamble + AGENTS body ("call the MCP tools…", no routes); the skill doc =
  skillPreamble + sanitized AGENTS body + tool reference ("POST /tool/{name}…",
  no MCP). Neither surface mentions the other (enforced by a test).

## 0.12.0

**Music compilers for 9 systems** — `encodeAudio` grew from 3 to 13 targets, so an
agent can compile real music into a game on nearly every platform with no external
tools. Each target emits exactly what that platform's bundled sound driver plays.

### Added
- **`encodeAudio({ target:'maxmod' })`** — GBA: a tracker module (`.xm`/`.mod`/
  `.it`/`.s3m`) → a Maxmod **soundbank** (.bin + .h). A faithful pure-JS port of
  devkitPro `mmutil` (new package **`romdev-maxmod`**), **byte-identical to real
  mmutil** (verified on .xm/.mod/.it). No devkitPro, no native binary.
- **`encodeAudio({ target:'famitone' })`** — NES: a FamiTracker text export
  (`.txt`) → FamiTone2 ca65 data. A faithful pure-JS port of `text2data` (new
  package **`romdev-famitone`**), byte-exact vs `text2data -ca65`. `noWarnings`/
  `keepInstruments` flags. Plays via the bundled famitone2.s driver.
- **`encodeAudio({ target: 'spc'|'gg'|'sms'|'c64'|'lynx'|'atari7800'|'gb'|'gbc' })`**
  — a note/duration `song` → that platform's bundled-driver note table (in-process,
  no new packages). Note→native pitch per chip: SNES DSP pitch, SN76489 divider
  (gg/sms), SID freq word (c64, 3 voices), Mikey note index (lynx), TIA AUDF
  (atari7800, 32-pitch snap), hUGE note index (gb/gbc, multi-channel hUGEDriver).
  Emits a drop-in `cSource` + raw table bytes. Each verified against its driver's
  own pre-baked note values (e.g. A4=440 → GG divider 254 = the driver's NOTE_A4).
- **`MUSIC_SOURCING.md` guide** — the per-system recipe for turning chiptune /
  tracker / VGM **or arbitrary audio (WAV/MP3)** into game music: ffmpeg → sample
  encoders for the sample-capable systems (Genesis/SNES/GBA), and the open-source
  transcription chain (Basic Pitch → FamiStudio/OpenMPT/mid2vgm → these compilers)
  for the synth-only chips, with the honest "synth chips play notes, not your
  recording" caveat.

### Notes
- The MCP surface stays **34 tools** — every new compiler is a `target` on the
  existing `encodeAudio`, not a new tool.
- PCE and MSX have no bundled music driver yet, so they're not covered (they'd
  need a driver written first, not just a compiler).

## 0.11.0

Genesis music + the symbol/build/audio gaps from the v0.6.0 agent feedback, plus
the consolidation-review follow-ups (axis consistency, op cheat-sheets, a
discoverable rename table).

### Added
- **`catalog({op:'whatsNew'})`** — the recent CHANGELOG + an OLD→NEW tool RENAME
  TABLE (derived from the consolidation MERGE_MAP). Resuming a handoff written
  against an older server? Call this first: pre-1.0 the surface consolidates
  freely with no deprecated aliases, so a remembered name is usually now an `op`
  on a domain tool — this maps all ~124 of them in one read instead of probing.
- **Per-op "cheat-sheet" lines** at the top of the fat domain tools (`cpu`,
  `romPatch`, `memory`, `tiles`): a one-line `op → {params}` map so you can see a
  single op's signature without reading the whole merged param blob.
- **`encodeAudio({ target:'xgm2', vgmPath|vgmBase64, name, system })`** — compile a
  `.vgm`/`.vgz` to a COMPILED Genesis XGM2 blob + a 256-aligned C array you
  `#include` and `XGM2_play()`. `XGM2_play()` needs a compiled blob (split FM/PSG
  streams + sample table), not raw VGM — this does that compile. It's a pure-JS
  port of SGDK's Java `xgm2tool` (new package **`romdev-xgm2`**); no Java/jar, no
  native binary. PSG-only tracks coexist with `xgm2pcm` SFX. Verified end-to-end
  (VGM → ROM → gpgx plays real audio).
- **Genesis/GBA symbol resolution.** `symbols({op:'resolve'|'lookup'|'list'|'map'|'addr'})`
  now parses the GNU ld `.map` that `build({output:'romWithDebug'})` produces for
  Genesis (m68k) and GBA (ARM), in addition to cc65 `.dbg` and SDCC sdld `.map`.
  So a C global's name → address → `memory({op:'read'})` is a 1-byte headless
  assertion on every buildable platform (and the SDCC targets gained
  resolve/lookup/list, which they lacked before). Genesis work-RAM symbols come
  back with a `ramOffset` + a ready `system_ram` read recipe.
- **`audioDebug({ op:'inspect', frames:N })` trace mode** — steps N frames,
  samples the chip each frame, returns a per-channel note-timeline (value
  transitions) to assert a melody headlessly. Single-frame snapshot stays the
  default (omit `frames`).
- **`build({ output:'project', path, platform })` builds a C/SGDK directory.**
  Now discovers `main.c` (C / SGDK Genesis / GBA / cc65-C / SDCC-C) or
  `main.s`/`main.asm` and links every source in the dir — no per-iteration file
  manifest. Binary assets (`.bin/.chr/.pcm/.brr/.vgm/...`) fold in automatically.

### Changed (breaking — pre-1.0, no aliases)
- **`tiles` is now keyed by `op`, not `as`.** Every other domain tool keys on
  `op`; `tiles({as:...})` was the lone exception and agents reflexively typed
  `tiles({op:...})` and ate a round-trip. Now consistent: `tiles({op:'png'|
  'pixels'|'fingerprints'|'ascii'|'preview'})`. The old `as` key is rejected.

### Fixed
- Genesis music docs named the wrong tool/API. Corrected to `XGM2_play` (there is
  no `XGM2_startPlay` in R58), the compiled-blob requirement, and that the legacy
  `xgmtool`/`.xgc`/`XGM_*` is a DIFFERENT format.
- **`romPatch({op:'findPointer'})` no longer doubles its hit list with shadows.**
  On the multi-width systems (Genesis: 32+24-bit BE; SNES: 16+24-bit LE) a wider
  hit shares its low bytes with the narrower form one position over — the byte
  shadow. Those are now suppressed by default (`shadowsSuppressed` reports the
  count); `suppressShadows:false` shows the raw set and a new `widths:[4]` filter
  searches only the widest form. The suppression matches on offset-overlap AND
  pointer-value (so two coincidentally co-located but distinct pointers are never
  falsely merged). The other 12 platforms emit a single width, so this is a
  verified no-op there. (NBA-Jam-TE agent nit: 20 hits → the 10 distinct
  relocation handles, no hand-dedupe.)
- **`cpu({op:'call'})` watchdog now trips on a wrong-entry free-run, not just a
  tight loop — on EVERY CPU.** Two cross-system gaps fixed:
  - The default budget was `maxFrames*500k`, always larger than `maxFrames`-worth
    of real execution, so a wrapper PC with a bad source that fell back into the
    game's main loop silently hit `maxFrames` with `watchdog:false`. The default
    is now **per-CPU** (`0.8 × maxFrames × instrPerFrame`, capped at 4M) so it
    trips before the frame cap on the fast cores AND the slow ~1MHz 8-bit CPUs
    (a flat 4M never tripped within 600 frames on the 6507/6510 — they run only
    ~3–3.8M instructions in that span). Real codecs finish in <~1M instructions,
    so even the slow-CPU floor keeps 2–3× headroom. The not-returned message now
    names the wrapper/free-run case.
  - **The instruction watchdog is now wired into the gpgx `z80_run` loop, not
    just `m68k_run`** — so it actually fires on **SMS/GG** (where the Z80 is the
    active CPU). Before, `callSubroutine` armed a watchdog that could never trip
    on SMS/GG (the counter only incremented on the m68k), so a Z80 free-run fell
    to `maxFrames`. Requires the rebuilt `romdev-core-gpgx` WASM. (NBA-Jam-TE
    agent nit, generalized to all 14 platforms.)

## 0.10.0

Tool-surface consolidation: **132 narrow tools → 34 domain tools.** Every tool is
now a small verb with a typed operation axis (`memory({op})`, `build({output})`,
`breakpoint({on})`, `sprites({op})`, `disasm({target})`, `romPatch({op})`, …) —
never a generic `action: functionName` dispatcher. No capability lost; every old
tool is reached as an operation on a richer domain tool. Cuts the dump-all token
cost ~4× and keeps the surface under the soft tool-cap of clients like Cursor/
Copilot. The progressive-disclosure path (`loadCategory`/`describeTool`/lean mode)
was removed too — every tool registers at session init, so `tools/list` returns
the full surface immediately. See AGENTS.md "Tool surface" for the new names and
the rename map.

## 0.9.0

The RE-INJECT path (Blocker 2 from the decompress feedback) — the round-trip
side of a ROM hack. You could already FIND any asset; now you can put an edited
copy BACK in a form the game accepts, on all 14 platforms.

### Added
- **`makeStoredBlock({ platform, rawHex|rawBytes, format })`** — wrap raw bytes so
  the game's OWN decompressor expands them VERBATIM, via each format's literal/
  raw-copy escape. No need to write a compressor. Formats: GBA BIOS LZ77 (flag
  byte 0x00 = 8 literals), SNES LC_LZ2 (command 000 direct-copy + 0xFF end),
  SMS/GG + MSX RLE (0x80|n literal run), NES PackBits/Konami-RLE, and `raw` (no
  wrapper) for the systems that store graphics uncompressed (Lynx/2600/7800,
  often PCE, NES CHR-ROM). HONEST limits, surfaced in the tool: Genesis Nemesis
  (Huffman) and C64 crunchers (Exomizer/pucrunch) have NO clean stored escape and
  are not offered; Genesis Kosinski is offered but flagged EXPERIMENTAL (the
  end-terminator varies by decompressor — self-verify). Output is proven to
  round-trip both against reference decompressors AND, for GBA, against the REAL
  BIOS LZ77 (SWI 0x11) running live under mgba.
- **`findPointerTo({ path, romOffset })`** — find every pointer in a ROM that
  references a byte offset, using the platform-correct encoding: Genesis 32-bit
  BE (= ROM offset, 1:1 at $000000); SNES 16-bit (bank-implied) / 24-bit long LE
  via LoROM/HiROM (auto-detected); GBA 32-bit LE = 0x08000000+offset (value-
  search-complete — catches literal pools AND tables in one pass); NES/GB/SMS/PCE
  /etc 16-bit LE CPU addresses with their bank-window aliases (page-ambiguous —
  correlate with the nearby bank-set). The missing piece for redirecting a loader.
- **`relocateBlock({ path, newHex, toOffset, pointerOffset })`** — write an edited
  block to free ROM space (pair with findFreeSpace) and repoint a pointer at it,
  with the platform-correct pointer encoding. `dryRun:true` previews the writes.
  The safe "don't overwrite in place" move when an edit changes size.

The full round-trip: watchDma/findWriter locate the block → callSubroutine
decompresses it (now hang-proof) → edit → makeStoredBlock → findFreeSpace →
relocateBlock writes + repoints → verify in the emulator.

## 0.8.0

The `callSubroutine` instruction **watchdog is now on every CPU core** — the
0.7.0 hang-fix was the Genesis reference; this round fans the core-side hook out
to the other ten CPUs so a runaway routine never hangs the WASM on any platform.
Requires the bumped core packages.

### Changed — watchdog on all cores
- The instruction WATCHDOG (force-stop a runaway routine at a host-set budget,
  return `{watchdog:true, finalPC, finalRegs}` instead of hanging `_retro_run`) is
  now built into all eleven CPU cores: m68k+Z80 (gpgx, 0.7.0), 6502 (fceumm),
  SM83 (gambatte), 65816 (snes9x), ARM7TDMI (mgba), 65C02 (handy), 6510 (vice),
  6502 (prosystem), 6507 (stella2014), HuC6280 (geargrafx), Z80 (bluemsx). Each
  core: a per-instruction counter in the CPU dispatch loop that, at the limit,
  freezes the PC + sets the same `romdev_pc_hit` the breakpoint uses (so
  `retro_run` drains the frame and returns), reports the trip as a 6th element of
  `romdev_pcbreak_get`, and exports `romdev_watchdog_set`. mgba ends the frame via
  a cycle-budget bump and NEVER `processEvents` (so the VBlank IRQ can't rewrite
  the frozen PC). Why it must be in each core: WASM is single-threaded synchronous,
  so a JS timeout can't interrupt a routine spinning inside one `_retro_run` frame.
- `callSubroutine` / `decompressWith` now return progress-on-timeout (Blocker 1
  from the decompress feedback) on EVERY platform, not just Genesis.
- Verified per core with a dedicated watchdog test (an infinite-loop routine trips
  the watchdog, reports `finalPC`, and does NOT hang). 593/593 green.

## 0.7.0

Reverse-engineering follow-ups from the NBA Jam (Genesis) agent's decompress
feedback. Genesis reference for the hang-fix (the watchdog is a core hook — it
fans out to every core in 0.8.0); the JS-layer fixes (watchDma, previewTileArt)
are all-platform.

### Added — `callSubroutine` no longer hangs (Blocker 1)
- **Instruction watchdog** (`romdev_watchdog_set`, gpgx m68k): force-stops a
  runaway routine (e.g. a codec fed a wrong A0 that loops forever) so it can't
  hang `_retro_run`. `callSubroutine` arms it and on timeout returns PROGRESS —
  `finalPC` (where it's stuck) + `finalRegs` (A0/A1/D0/D1/PC/SP) + `watchdog:true`
  + a `reason` — instead of an opaque `returned:false`.
- **`presetMemory`** param — seed RAM globals a codec reads before running it.
- **`stopAtPC`** param — halt mid-routine and return the partial output.
- **`maxInstructions`** param — the real (instruction-count) budget. Tail-call /
  JMP-wrapper routines are handled (the final RTS is what's detected).

### Changed
- **`watchDma`** — `dedupe:true` collapses the per-frame VRAM refresh (7000+ events
  → a handful + an `occurrences` count); `sourceFilter:'rom-only'|'ram-only'` drops
  the RAM→VRAM sprite noise; adds `from:ROM/RAM` and `limit`. Fixes the token-cap
  flood the agent hit twice.
- **`previewTileArt`** — `byteOffset` param (preview straight from a raw DMA /
  `findReferences` source) with an `alignmentWarning` + nearest-aligned offsets
  when it isn't a multiple of the tile size — the silent-scramble trap.

## 0.6.0

Reverse-engineering round 2 — the tools that collapse the two walls a real
romhack hits: **compressed assets** and **finding the unknown routine**. All on
**all 14 platforms** (every CPU family), feature-detected with clean `notSupported`
where a core can't. Requires the bumped core packages.

### Added — drive the ROM's own code (item 1)
- **`callSubroutine({ pc, regs, sandbox })`** — set up the CPU (registers by reg-id,
  PC) and run a subroutine until it returns, then read back what it produced.
  Sandboxed (snapshot+restore) by default. The general RE primitive.
- **`decompressWith({ entryPC, sourceAddress, destAddress })`** — thin wrapper for
  the decompressor shape (A0=src/A1=dst). Run the game's OWN codec and `readMemory`
  the output — instead of reimplementing an undocumented LZ format. The codec wall,
  gone.
- **`setRegister({ regId, value })`** — write a CPU register (inverse of getCPUState).
  Per-CPU reg-id conventions (m68k 0-7=D,8-15=A,16=PC,18=SP; 6502 0=A,1=X,2=Y,3=P,
  4=SP,16=PC; SM83/Z80 0=A,1=F,2-7=BCDEHL,16=PC,18=SP; 65816 +5=DB,6=D; ARM 0-15=
  r0-r15,16=CPSR). The host's `callSubroutine` knows each CPU's stack discipline
  (page-stack vs predecrement, return width, the 6502/65816 RTS+1 quirk, ARM
  pipeline flush), so it drives routines correctly on every core, not just Genesis.

### Added — discovery (item 2)
- **`watchRange({ start, end, kind })`** — log EVERY read/write hitting an address
  range (not stop-on-first) as `{pc,address,value}`, with a `distinctPCs` summary.
  The fix for "I don't know which PC touches this" — watch the whole pool and SEE
  the routine instead of probing single addresses.
- **`logPCRange({ start, end, frames })`** — coverage trace: every DISTINCT PC that
  executed in a window. FIND an unknown renderer by seeing what runs, not guessing.

### Added — targeted DMA (item 3, Genesis)
- **`watchDma({ vramDest })`** — every mem→VDP DMA with its VRAM destination + ROM
  source + length. "Which DMA wrote the tile at VRAM 0xNNNN, and from where?" — the
  precise version of `traceVramSource`, the way to catch a DMA'd (not CPU-written)
  name/portrait bitmap. Genesis-only (VDP DMA); `notSupported` elsewhere.

### Also
- **PC Engine (geargrafx) gained a write watchpoint** — so `findWriter` +
  `watchRange`-write now work there too (round 1 had read-watch + breakpoint only).

## 0.5.0

Execution breakpoints — the RE primitive that turns "infer for hours" into "read
the register." Adds `runUntilPC`, `runUntilRead`, and `stepInstruction`, live on
**all 14 platforms**. Same model as the write watchpoint; requires the bumped core
packages (gpgx, fceumm, gambatte, prosystem, geargrafx, bluemsx, handy, vice,
platform-snes, platform-atari2600, platform-gba).

### Added — PC breakpoint + read watchpoint + single-step (all 14 platforms)
The symmetric gaps next to `findWriter` (a core-level WRITE watchpoint), requested
by an agent who could disassemble a name-decoder but couldn't read the one address
register that held the answer. Every bundled CPU family now has it:
- **m68k** Genesis (gpgx), **6502/65C02** NES (fceumm) · Atari 2600 (stella) ·
  Atari 7800 (prosystem) · Lynx (handy), **SM83** GB/GBC (gambatte), **65816** SNES
  (snes9x), **Z80** SMS/GG (gpgx) · MSX (bluemsx), **HuC6280** PC Engine (geargrafx),
  **ARM7TDMI** GBA (mgba), **6510** C64 (vice).
- Each core gains the same `romdev_pcbreak_*` / `romdev_readwatch_*` exports (the
  gpgx m68k patch is the template); the host + MCP layer is core-agnostic and
  feature-detects, returning `notSupported` on any core that lacks the exports.
- Single-step is a per-instruction countdown so it ADVANCES the PC; on a hit the
  core consumes its frame cycle budget (PC frozen) so `retro_run` still completes —
  no mid-frame hang.
- **PC Engine caveat (fixed in 0.6.0):** at 0.5.0 geargrafx had no write
  watchpoint, so `findWriter` was unavailable there (the breakpoint tools worked).
  0.6.0 adds the write watchpoint to geargrafx, so `findWriter` works on PC Engine
  too — all 14 platforms now.
- **`runUntilPC({address, maxFrames, pressDuring})`** — runs until the m68k PC
  reaches `address`, then STOPS with the CPU frozen EXACTLY at that instruction
  (the core's execute loop bails mid-frame on the hit). Then `getCPUState` reads
  the full register file at that precise moment — e.g. break at a decoder's
  `move.b (a0),d0` and read `A0` to get the source pointer in one shot.
- **`runUntilRead({address, ...})`** — the read-side mirror of `findWriter`:
  returns the EXACT instruction PC that READ a watched address (find who *consumes*
  a value, not just who writes it).
- **`stepInstruction()`** — CPU-level single-step (finer than `stepFrames`); pair
  with `getCPUState` to watch registers change one instruction at a time.
- All three feature-detect per core and return `notSupported` where the core lacks
  the patch. Genesis is wired now; the gpgx m68k patch (`romdev_pcbreak_*` /
  `romdev_readwatch_*`) is the template for the remaining cores.

### Fixed
- `build-genesis-plus-gx.sh` now stages the rebuilt core into BOTH `src/cores/wasm`
  AND the `romdev-core-gpgx` package (which the registry actually resolves at
  runtime) — a rebuild no longer silently loads the old package copy.

## 0.4.1

Fixes inverted controller-button mapping on the three genesis_plus_gx platforms
(Genesis, SMS, Game Gear), backed by a **full empirical 14-platform input audit**.
Pure `romdev-mcp` patch — no toolchain/core packages changed.

### Fixed — genesis_plus_gx face-button aliases were inverted
genesis_plus_gx maps the console's printed face buttons onto libretro ids in a
non-obvious order, and romdev's native-button aliases + docs had it backwards.
Verified empirically against the running core (an SGDK / port-$DC probe driven by
each libretro button):
- **Genesis**: A/B/C map to libretro **y/b/a** — so `setInput({a:true})` presses
  Genesis **C**, and Genesis A (SGDK `BUTTON_A`) is `setInput({y:true})` /
  `{west:true}`. `pressButton({button:'c'})` resolved to libretro `y` (Genesis A!);
  now resolves to `a` (Genesis C).
- **SMS / Game Gear**: button 1 (TL) = libretro **b**, button 2 (TR) = libretro
  **a** — so `setInput({a:true})` presses button 2. `pressButton({button:'1'/'2'})`
  resolved to `a`/`b`; now `b`/`a`.
- The **spatial face-button names are correct** on all of these (east/south/west
  resolve to the right physical button) — prefer them, or `pressButton`'s native
  aliases, over raw libretro a/b/x/y.
- This was an agent-reported bug: an SGDK platformer's jump (BUTTON_A) wouldn't
  fire headlessly because every "reasonable" libretro guess pressed the wrong
  button.

### Verified — all 14 platforms probed live (so we KNOW the scope)
Each platform got a hardware-register probe ROM driven by each libretro button.
Result: the press-inversion is **exactly the three genesis_plus_gx platforms**
(Genesis/SMS/GG). Every other core maps `setInput({a})`→A correctly:
**NES** (fceumm), **GB/GBC** (gambatte), **SNES** (snes9x — a/b/x/y/l/r all
correct), **GBA** (mGBA), **PC Engine** (geargrafx — a=I, b=II), **MSX** (bluemsx
— a=trigger 1, b=trigger 2), **Lynx** (handy — a=A, b=B, active-high). **C64**
(vice) and **Atari 2600** (stella) are single-fire — fire registers via `b`/`south`,
`a` is a correct no-op.

### Changed — docs
- `getInputLayout` notes for genesis/sms/gg corrected (they previously claimed
  libretro `a` = Genesis A / SMS button 1 — both wrong).
- **Atari 7800** `getInputLayout` note corrected: it had the ProLine INPT register
  numbers swapped (claimed a→INPT1/b→INPT0; the audit + prosystem source confirm
  **a→INPT0 (right/button 2), b→INPT1 (left/button 1)**). The right/left semantic
  was already right, so button presses were unaffected — only register-by-number
  reads were misled. Also documents the default 1-button boot mode (both fires read
  INPT4 until 2-button mode is enabled via CTLSWB).
- `setInput` / `pressButton` descriptions now surface the face-button-naming trap
  at the callsite and point to spatial names / `getInputLayout().faceButtons`.
- `stepFrames` / `screenshot` descriptions nudge toward `stepAndScreenshot` for
  the drive-then-look loop (token-saving).

## 0.4.0

Native disassemblers across the board, GBA disassembly + byte-exact projects
unlocked, and smarter cheat search. Disassembly is now byte-exact on **all 14
platforms** — `disassembleRom`, `findReferences`, and `disassembleProject` all run
through native tools end to end, no hand-rolled JS de/encoders left anywhere.

### Changed — native binutils disassemblers replace ALL the hand-rolled ones
Every hand-rolled JS instruction decoder (m68k / z80 / sm83) is **deleted** and
replaced by **native GNU binutils `objdump` compiled to WASM** — the same binutils
we already build per toolchain, now shipping `objdump` alongside
`as`/`ld`/`objcopy`. The JS decoders dropped real instructions and (on m68k)
desynced the byte stream into garbage — the "useless binary" a Genesis RE session
hit. There is **no JS fallback** — the native path is the only path.
- **m68k (Genesis)** → `m68k-elf-objdump`. The JS decoder dropped move-sr / muls /
  divu and mis-sized the fallback; a real ROM now disassembles cleanly.
- **Z80 (SMS / Game Gear / MSX)** → binutils z80 `objdump` `-m z80` (fixes the
  (ix+d)/(iy+d) displacement display + edge cases).
- **SM83 (Game Boy / Color)** → the same z80-elf `objdump` via its `gbz80` machine.
  One z80-elf binutils serves both CPU families.
- **ARM/Thumb (GBA)** → `arm-none-eabi-objdump`.

### Added
- **GBA disassembly** (the 14th platform, previously rejected) — `disassembleRom`
  and `findReferences` disassemble ARM7/Thumb via native `arm-none-eabi-objdump`
  (ARM by default, `thumb:true` for Thumb code).
- **`disassembleProject` now covers all 14 platforms, GBA included.** Each region
  disassembles through the CPU's native objdump and reassembles **byte-exact**
  through the matching native `as`/`ld`/`objcopy` (cc65 ca65/ld65 for 6502/65816).
  Any line the assembler won't reproduce exactly is healed to a `.byte` of its real
  bytes, so the round-trip is always byte-for-byte. The GBA project splits a 192-byte
  header data region from an ARM code region; it rebuilds byte-exact but reads low
  (most GBA C is Thumb reached via an ARM crt0 stub — ARM/Thumb mode-tracking is the
  readability follow-up).
- **Lynx** wired into `disassembleRom` + `findReferences` (65C02 via da65; strips the
  64-byte LYNX header, anchors at $0200).
- **Cheat search** now uses `fuse.js` over tag-stripped game names — adds
  character-level typo tolerance on top of the existing region/revision-tag and
  word-order robustness.

### Internal
- Native binutils 2.42 is built to WASM for THREE targets — `m68k-elf`,
  `arm-none-eabi`, and `z80-elf` (one serves both Z80 and gbz80) — each shipping
  `as`/`ld`/`objcopy`/`objdump`. Reproducible build scripts under `scripts/`
  (`build-m68k-wasm-tools.sh`, `build-arm-wasm-tools.sh`, `build-z80-binutils-wasm.sh`),
  pins in `scripts/versions.json`.
- Bumped binary packages this release: `romdev-toolchain-m68k-gcc` 0.2.0 (+ objdump),
  `romdev-platform-gba` 0.3.0 (+ ARM objdump), `romdev-toolchain-sdcc` 0.2.0
  (+ z80-elf binutils).

## 0.3.1

Homebrew/asset-import polish from a Genesis platformer session, plus a Genesis
sprite-inspection bug fix.

### Added
- **`wavToXgm2Pcm`** — convert a WAV (or raw s16le PCM) into a Genesis XGM2 PCM
  sample: 8-bit signed mono, 13.3 kHz (or 6.65 half-rate), 256-byte-padded, plus a
  256-aligned C array + `<NAME>_LEN` define ready to `#include` and `XGM2_playPCM`.
  Bakes in the fiddly sign/rate/alignment/padding rules.
- **`convertImageToTiles`** now takes `pngPath` (reads the PNG from disk — no base64
  token cost or hand-forwarding corruption) and `tileOrder:'sprite'` (column-major,
  the order multi-cell hardware sprites read on Genesis/Lynx).

### Changed
- **`imageToTilemap`** (Genesis) now warns when a visible dominant color is forced
  to palette index 0 (transparent on a scroll plane → renders as the backdrop).
- **`recordAudio`** description now cross-references `getAudioState` (WAV is to
  HEAR; getAudioState is to ASSERT), and notes getAudioState doesn't cover Genesis
  PCM-channel activity yet. Genesis MENTAL_MODEL documents the XGM2 PCM rules.

### Fixed
- **Genesis `inspectSprites` size/position** — a 32×32 sprite decoded as 8×8 (and
  x/y/tile/palette could be wrong) because the SAT words were read big-endian;
  gpgx stores VRAM host-little-endian (byte-swapped). Fixed in the live sprite,
  plane-preview, and which-tiles decoders.

## 0.3.0

The reverse-engineering / romhacking release — a full RE toolkit driven by a real
NBA Jam Tournament Edition (Genesis) session, plus PC Engine + MSX cheat coverage
and a cleaner package split.

### Added — RE / romhacking toolkit
- **`searchValue` / `searchNext`** — the iterative value-search loop (Cheat-Engine
  / RetroArch cheat search): seed candidate addresses for an on-screen value, then
  narrow with `eq`/`gt`/`lt`/`changed`/`unchanged`/`inc`/`dec` as the value changes.
  The bread-and-butter "find the address of X" primitive. Works on all 14 platforms.
- **`readCartRom`** — read the loaded cartridge ROM image to confirm a patch is
  actually running. For un-banked platforms (Genesis, GB/GBC, SMS/GG, PCE, Lynx,
  Atari, C64) a file offset equals the CPU ROM address; NES/SNES skip the header
  and flag `mapped:true` (bytes correct, mapper-banked).
- **`classifyRegion`** — heuristic ("looks like ascii-text / high-entropy /
  tile-data / structured-data") that flags when a "found table" is really an ASCII
  string, killing the coincidental-match trap before a broken patch ships.
- **`navigate`** — drive menus by advancing on SCREEN CHANGE instead of fixed frame
  waits, reporting per-press whether it was `consumed`. 5–10× faster, deterministic
  menu scripting.
- **`traceVramSource`** (Genesis) — report which ROM offset a VRAM graphic was DMA'd
  from (decoded from the VDP DMA registers). Answers "this name/logo is a
  pre-rendered bitmap — where in ROM is it?".
- **`searchCheats`** — fuzzy game-name search over the cheat DB (no full-DB dump).
- **ROM-hacking playbook** — cross-platform RE/patching decision tree, readable via
  `getPlatformDoc({platform:'romhacking', name:'playbook'})`.

### Added — platforms / data
- **PC Engine** and **MSX** cheat-database coverage (397 + 377 games).
- **`romdev_game_codes`** — the cheat database is now its own package (lazy-loaded one
  platform at a time), shrinking the main package while letting the DB grow
  independently. Still a required dependency, so `npx romdev-mcp` ships with cheats.

### Changed
- **`learnFontMap`** now detects and reports pre-rendered tile graphics
  (`likelyPreRenderedGraphic`) instead of failing silently on non-font "text".
- **`diffMemory`** defaults to a clustered summary (changed ranges + stride
  detection — "islands at stride 0x80 ⇒ likely a struct array") instead of dumping
  thousands of per-byte rows; `view:'raw'` for the exact list.
- **`findWriter` / `watchMemory`** now hint, on no per-byte write, that the region
  may be bulk-copied/DMA'd (sprite shadow, display list, VRAM) — watch the source
  struct, not the destination.
- **`screenshot`** with `inline:true` now also writes a temp PNG and returns its
  path, so follow-up ImageMagick crops don't ENOENT.
- **`gameCheats`** fuzzy-matches a ROM name to the DB (region/revision tag tolerant).

### Fixed
- **Genesis CRAM color decode** — colors rendered blue-on-black; the decoder now
  reads the packed 9-bit little-endian CRAM correctly.

## 0.2.0

- PC Engine and MSX added as Tier-1 platforms (14 total).
- Server/livestream show the version, sourced from `package.json`.
