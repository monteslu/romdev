# Changelog

All notable changes to `romdevtools`. Dates are release dates.
(Published as `romdev-mcp` through 0.11.0; renamed to `romdevtools` in 0.13.0 —
the `romdev-mcp` bin is kept as an alias.)

## 0.135.1 — 2026-08-30

### Fixed — two binary packages shipped changed code under a published version

`publish-all.mjs`'s drift check caught it before anything went out:
`romdev-platform-gba@0.11.0` and `romdev-toolchain-m68k-gcc@0.4.0` had
in-tree content that no longer matched their registry tarballs.

Both vendor the build kit (`_worker/wasm-worker.js`, `parse-errors.js`)
that is canonical in `romdevtools/src/toolchains`. 0.130.0's two fixes —
always hand MEMFS bytes rather than a JS string, and parse modern rgbds's
ANSI/two-line diagnostics — were correctly synced into both packages by
`scripts/sync-build-kit.sh`, but neither package was bumped. Publishing
would have skipped them, pairing new romdevtools with the old tarballs and
silently reintroducing `Aborted(Unsupported data type)` on the GBA and
Genesis C paths for anyone installing fresh.

Bumped to `romdev-platform-gba@0.12.0` and
`romdev-toolchain-m68k-gcc@0.4.0`, repinned in romdevtools.

**The general lesson:** the build kit is deliberately duplicated into the
binary packages, and `build-kit-parity.test.js` enforces that the copies
match. That test guards CORRECTNESS but says nothing about VERSIONS — a
synced copy still needs its package bumped, or the fix never reaches an
installed user.

## 0.135.0 — 2026-08-30

### Added — the five GameTank example games now exist as far as the tools care

The five genre templates were already **written** — complete games on the
bundled SDK draw-queue runtime, with pixel-art sprites in GRAM, SFX and
full title/play/game-over loops — but they were never **registered** in the
template manifest. `examples({op:'list', platform:'gametank'})` reported
none, and nothing could fork them. They are registered now, with the exact
runtime file set a verified build needs.

Getting them to build end-to-end took four fixes, each a real gap rather
than a template problem:

- **`build` never exposed `asmIncludes`.** The plumbing existed internally
  (with a comment naming GameTank as the case that needs it) but no schema
  field reached it. A C source still goes through a per-TU ca65 pass, so an
  SDK whose assembly pulls in a generated `.inc` — GameTank's
  `modules_enabled.inc` — failed there with "Cannot open include file" and
  no way for a caller to supply it. Now `asmIncludes`/`asmIncludePaths`.
- **`build({output:'project'})` dropped `.inc` files.** `readProjectDir`
  classified them as C includes only, so a forked project hit the same wall
  even with the file sitting right there on disk. `.inc` now routes to the
  assembler as well.
- **No GameTank project recipe.** A scaffolded project ships `sdk.cfg` (it
  adds the LOADERS/COMMON/SAVE/WAVES segments the SDK runtime needs), but
  with no recipe branch the build ignored it and died on "Missing memory
  area assignment for segment 'COMMON'".
- **`fork` crashed on a template with no `crt0`.** The README generator
  dereferenced `tmpl.crt0.dst` unconditionally; GameTank's linker preset
  carries its own crt0, so the fork threw *after* writing all 45 project
  files.

Verified the whole path: fork → `build({output:'project'})` → load → run,
with screenshots of all five (the shmup's pixel-art raiders, the
platformer's coins, JEWELS, VOLLEY's two paddles, REDLINE's road).

`text.c` and `persist.c` are deliberately absent from the runtime list —
one wants a generated font asset that is not bundled, the other a module
flag that is not set. Neither is needed by the templates.

## 0.134.0 — 2026-08-30

### Added — five sync32 example games, and two real bugs they caught

sync32 shipped as a first-class build target in 0.131.0-0.133.0 but had
**zero examples**, while every established platform has nine or ten. That
gap matters more than it sounds: `examples({op:'list'})` tells an agent to
"fork the example whose CORE LOOP matches your game", so a platform with no
examples has no on-ramp at all.

All five canonical genres now ship, each a complete game with a title
screen, scoring, and a hi-score persisted to save slot 0:

| example | game | core loop |
|---|---|---|
| `sync32/shmup` | STARFALL | starfield, enemy waves, bullet pool, lives |
| `sync32/platformer` | SKYHOP | gravity + jump arc, swept tile collision, follow camera, coins |
| `sync32/puzzle` | CASCADE | match-4 grid, gravity settle, cascade chains |
| `sync32/sports` | RALLY | 2P paddle versus, angle-off-the-paddle, AI fallback |
| `sync32/racing` | OVERDRIVE | eased lane steering, traffic spawning, speed ramp |

Verified the way an agent would actually use them:
`examples({op:'fork', example:'sync32/shmup'})` stamps the game name into
`GAME_TITLE`, and `build({output:'project', path})` compiles the forked
directory in one call with no manifest. The result boots and plays.

### Fixed — libretro A and B were swapped (romdev-core-s32core)

The core's mapping table paired libretro's face buttons with the sync32 pad
bits **positionally**. libretro lays A/B/X/Y out SNES-style, so that put
libretro A on `S32_PAD_B`: a cart binding fire to `S32_PAD_A` — the obvious
binding, and the one the SDK header names — never fired. The CLI and SDL
frontends have always mapped A to `0x1000`; only libretro disagreed, with
both of them and with `sync32.h`.

Found while writing the shmup: holding A produced no bullets, and reading
the cart's bullet array out of SRAM showed zero live entries with the
cooldown at 0 — so the button was never reaching the game, rather than the
fire logic being wrong. Pressing libretro B fired the gun, which pinned it.

### Documented — `rect()`/`clear()` snap to the palette

The templates originally treated `api->rect(..., rgb565)` as an arbitrary
colour. It is not: the canvas is 8-bit **indexed**, so the console maps the
colour to the NEAREST palette entry and stores that index. A colour that is
not in the palette does not render as itself — which is why a grey road came
out blue. Every template now registers the colours it draws with, and leads
with the idiom, because it is the single most surprising thing about
drawing on this console.

## 0.133.1 — 2026-08-30

### Fixed — a test fixture this session truncated, and the wrong claim about it

`space_invaders_nes/space_invaders_nes.nes` was overwritten with 8 bytes
while 0.130.0's `readCart` output path was being exercised: the ROM was
passed where the tool writes its output, so it wrote 8 bytes over the
cartridge. Four tests need a real NES ROM and all four failed with
`the 'nes' core REFUSED this cartridge (8 bytes)` —
`backtrace.test.js` (live PC-break call stack on fceumm), both
`breakpoint-settle.test.js` settleFrames cases, and
`range-watch-digest.test.js`.

**Those four were reported as "pre-existing failures" in the 0.130.0,
0.131.0, 0.132.0 and 0.133.0 commit messages. That was wrong.** They were
caused during this work, not inherited. The mistake behind the claim is
worth recording: the baseline used to "prove" they predated the changes
stashed the SOURCE changes and re-ran the suite — which cannot restore a
damaged binary fixture, so the baseline was already contaminated and
reproduced the same four failures. A check that only re-runs the code
under test says nothing about the data it runs against.

The ROM is a gitignored build output, so there was nothing to `git
checkout`; it was rebuilt from its own sources through
`build({platform:'nes'})` using the invocation in the project's README —
32,784 bytes, valid iNES header. The suite is now **1530/1530, zero
failures**. The same truncation hit
`asteroids_gb_mcp/asteroids_gb.gb` earlier in the session and was rebuilt
the same way; a sweep for other undersized ROM images found none.

The underlying tool bug — `memory` declaring `path` twice, so a `readCart`
input silently became an output path — was fixed in 0.132.0. This entry is
the cleanup of the damage it caused and the correction of the record.

## 0.133.0 — 2026-08-30

### Added — sync32 inspectors: live SRAM, CPU registers, palette, sprite sheets

sync32 could build and run a cart but not look inside one. The core's
`retro_get_memory_data` returned NULL for every id, so a frontend had no
view into a running game — no memory reads, no cheat search, no
watchpoints. s32core now exposes its state (SYSTEM_RAM plus private ids for
the debugger views) and romdev decodes it.

Scoped to **developing** a cart, not reverse-engineering one: sync32 has no
commercial games, so `decompile` stays false rather than pointing the RE
engine at a platform with nothing to decompile.

- **`system_ram`** is the console's 520KB SRAM at `0x20000000` — a game's
  globals, its stack, and in ram mode its code. The whole existing memory
  toolkit now works against it: `snapshot`/`diff` (measured: 4089 changed
  bytes across 227 clusters over 120 frames of `planes`), value search,
  watchpoints.
- **`cpu({op:'read'})`** decodes r0-r15, the packed APSR, and the FPv5-SP
  register file. It deliberately does **not** report an `execPc`: the GBA
  decoder adjusts for pipeline prefetch because ARM7TDMI really prefetches,
  while s32core is an interpreter where r15 is the next instruction, so an
  offset would be invented. Only non-zero s-registers are listed.
- **`palette({source:'live'})`** decodes the 256-entry RGB565 table,
  expanding each channel by bit-replication (`0x1F` → `0xFF`, not `0xF8`)
  so full-scale stays full-scale.
- **Sprite sheets** are readable as `sync32_sheet0` (and `0x1B0+n`).

`inspectSprites` stays **false**, which is an answer rather than a gap: it
means OAM slots and sync32 has no OAM — a game blits from loaded sheets
with `api->sprite()`. `inspectBackground` and `renderingContext` stay false
for the same reason: there is no tilemap and no PPU, just a flat 8-bit
canvas that `frame({op:'screenshot'})` already shows.

Requires romdev-core-host 0.11.0 and romdev-core-s32core 0.2.0.

## 0.132.0 — 2026-08-30

Closes the gap between "sync32 builds a cart" and "sync32 makes games."

### Added — ARMv8-M libgcc, so a cart can use the compiler's helper routines

0.131.0 shipped with the note that a sync32 cart links no libraries,
verified against the `planes` example. That example never needed a helper.
`diskdemo` does: a 64-bit divide emits `__aeabi_uldivmod`, and the link
failed exactly where 0.131.0 predicted it would. The bundled ARM archives
are ARMv4T (they exist for the GBA) and are link-incompatible with a
Cortex-M33 object, so `scripts/build-arm-libgcc-v8m.sh` builds libgcc from
the same gcc 14.2.0 the toolchain uses, configured for `armv8-m.main+fp`
hard-float, asserting the result really is v8-M rather than trusting the
multilib path. Stripped, it is 1.2MB. It is **libgcc only** — a cart still
links no libc.

### Fixed — `-ffreestanding` was dropped along with `-nostartfiles`

`cc1` rejects `-nostartfiles` (a driver option) and both were removed
together. Without `-ffreestanding`, gcc assumes a hosted environment and
is free to turn a struct initializer into a `bl memset` that cannot link
against a cart with no libc. Measured both ways: with the flag only
`__aeabi_uldivmod` is undefined; without it, `memset` as well.

### Added — the folder and archive forms, for games with resources

A cart that reads through the disk API needs its namespace to travel with
it (ABI 3.2-3.4). The SDK does this with a Python tool; romdev builds with
no Python, so `s32-archive.js` ports it — a sorted, uncompressed, plain
ustar tar, verified by round-trip and by GNU tar reading our output with
valid checksums.

`form:'folder'` is the other half, and it matters: the libretro core loads
a **bare executable** and reads a sibling `<romname>/` data directory. It
does not unpack a tar — the SDK's own `diskdemo.s32` archive is refused by
it too. So `archive` is the shape you distribute and `folder` is the shape
that runs in romdev; the schema says so. Pass `data`/`dataPaths` (plus
`api:2` for the disk functions) and optionally `icon`.

Verified: `diskdemo` built through
`build({platform:'sync32', form:'folder'})` loads, runs, and reads its data
files.

### Added — the sync32 platform tree, the way GB has one

`platform({op:'docs', platform:'sync32'})` previously answered "no docs
shipped". It now serves MENTAL_MODEL.md and TROUBLESHOOTING.md, written
against the real `sync32.h`: the API struct and its v1/v2 split, the audio
ring back-pressure trap (the ring is smaller than one video frame of
audio, `audio_push` drops the excess silently, and the sink mutes), the
single-precision FPU, and the ram/xip modes. Every troubleshooting entry
is a failure hit while bringing the platform up.

### Fixed — `memory` declared `path` twice

The readCart ROM input added in 0.130.0 collided with the existing
`outputPath` alias, so `readCart({path})` would have tried to **write** the
ROM to that path. The input is now `romPath`. Two pre-existing lint errors
in `dual-era.test.js` are fixed alongside it, so `npx eslint .` is clean
for the first time since before 0.129.0.

## 0.131.0 — 2026-08-30

### Fixed — the sync32 core never actually shipped

`src/cores/wasm/` is a gitignored build-staging directory. Every other core
resolves through its own `romdev-core-*` package (`resolveCore` tries the
package first, then falls back to staging), but sync32's registry entry
named `romdev-core-s32core` — a package that did not exist and was not a
dependency. The platform therefore worked on the machine that built it and
silently disappeared from `listPlatforms` for everyone else.

`romdev-core-s32core` now exists, romdevtools depends on it, and
`build-s32core.sh` stages into it the way `build-gametank.sh` always has.
The shipped WASM was also stale (built 2026-08-27 against a tree that moved
on 2026-08-28); rebuilt, which brings in the predecoded micro-op engine
(2.6x), audio ring back-pressure, and the disk fix that refuses the
console's `.s32id` marker.

### Added — `build({platform:'sync32'})`, entirely in WASM

sync32 carts previously had to be built outside romdev with a native
`arm-none-eabi-gcc` and Python. `build: false` turned out to be a wiring
gap rather than a missing toolchain:

- The ARM toolchain shipped for GBA is a **full** arm-none-eabi gcc. Given
  `-mcpu=cortex-m33 -mthumb -mfloat-abi=hard -mfpu=fpv5-sp-d16` it emits
  `.cpu cortex-m33 / .arch armv8-m.main / .fpu fpv5-sp-d16`, and
  as/ld/objcopy accept it — so no new toolchain build was needed.
- A sync32 cart links against **no libraries**: the SDK is freestanding,
  and a natively-built cart's ELF has zero undefined symbols and zero
  libgcc helpers. That matters because the bundled ARM archives are ARMv4T
  (ARM7TDMI, for the GBA) and are link-incompatible with ARMv8-M. If a
  future cart does pull in an `__aeabi_*` helper, the link fails loudly and
  that is when an ARMv8-M libgcc gets built.

The pipeline is `cc1 → as → ld → objcopy` plus a JS port of the SDK's
`mks32.py` for the 64-byte container header. The port reads `_start`
straight out of the ELF symbol table rather than shelling out to
`arm-none-eabi-nm`, so the entire build is WASM + JS — no native compiler,
no Python.

New `romdev-platform-sync32` ships the SDK assets a build needs (`crt0.S`,
`ram.ld`/`xip.ld`, `sync32.h`) so nothing depends on a sibling checkout,
plus a minimal freestanding `stdint.h` (sync32.h includes one, and newlib's
pulls a hosted header tree behind it). Cart-header fields are exposed as
`title`, `id`, `mode` (`ram`|`xip`), `video`, `api`, with `linkOptions` for
the SDK's `LDFLAGS_EXTRA`.

**Verified against the SDK itself:** rebuilding the SDK's own `planes`
example through `build({platform:'sync32'})` produces a `.s32` that is
byte-identical to the natively-built cart, and that cart loads and renders
correctly on the emulator. A new oracle test pins the container format to
real SDK output so header drift cannot pass silently.

### Fixed — workspace pin drift

0.130.0 bumped `romdev-core-runner` to 0.2.13 without repinning it in
romdevtools; the workspace-contract test caught it.

## 0.130.0 — 2026-08-30

Client feedback from a `find-game-genie` session against a Super Mario Land
disassembly (GB/MBC1): three bugs and four token sinks.

### Fixed — multi-file rgbds builds crashed, and dropped the extra files anyway

Two defects stacked. The WASM worker passed a JS **string** to
`FS.writeFile` for utf8 inputs; rgbasm is built without the string path and
aborts `Aborted(Unsupported data type)` from inside `writeFile`, naming
neither the file nor the type — so it read as a crash in the assembler
rather than a marshalling bug. Fixed in the worker, where it covers every
bundled toolchain at once (and synced into the vendored GBA/m68k build
kits, so those pipelines get it too).

Underneath it, `buildGB` assembled `main.asm` ONLY and linked a single
object — `sources` was never passed through, so the other `.asm` files were
mounted as INCLUDE payload and their sections never existed in the ROM.
Now one object per translation unit (`.asm`/`.s`), linked together, with
the failing unit named in `failedTU`.

### Added — `build` returns the linker's symbol map on GB asm builds

`rgblink` is always asked for `-n` (symbols) and `-m` (section map);
`symbols` was previously hardcoded `""`. Without a label → `bank:address`
table an agent has to re-derive addresses by sizing every instruction —
one wrote a ~470-line SM83 assembler-lite to do it, which was the largest
single cost of the reported session.

### Added — `memory({op:'readCart', path, platform})` works with no host

Reading bytes out of a cartridge is a static question, but this was the one
byte-reading tool that required a live emulator, so any session that lost
its host also lost byte verification. Now host-free with `path`+`platform`,
matching `disasm({target:'rom'})` and `cheats({op:'make'})`. The
header/mapping derivation moved to `romdev-core-host/cart-image.js` and
`LibretroHost.getCartRom()` delegates to it, so file-backed and host-backed
reads cannot disagree about header size.

### Fixed — `loadMedia` reported `loaded:true` while the next call saw no ROM

Not a load failure. A request carrying no session handle gets an
auto-minted key it is never told, so every request lands in a brand-new
session: the load really did succeed, into a session the caller can never
address again. `resolveSessionKey` computed `minted` and every call site
discarded it. It is now remembered (bounded), and the "No ROM loaded" error
names this cause and gives the fix instead of telling an agent that just
called `loadMedia` to call it again. The reported `loaded:false` alongside
`liveHosts:1` was the correct read: the previous request's host is alive,
just unreachable from the current one.

Also fixed: that error's checkpoint-recovery hint only looked for a
libretro `.state` and missed every wasmcart `.sav` — a gap left by
0.128.0's own SRAM checkpoint.

### Changed — token cost

- `cheats({op:'make', entries:[{address, value, compare?}, …])` batches
  INDEPENDENT patches; publishing 26 codes took 26 round trips. The
  per-call `note` no longer restates `codes[0].code`/`raw`, which are
  structured fields directly above it.
- `GET /tool/:name/schema?for=<target>` narrows a broad tool's schema to
  the parameters that target actually reads. `disasm` carries 49
  parameters (~3.5k tokens) spanning everything from "read a byte range"
  to "recompile NES to 65816"; a one-shot `target:'rom'` read needs 16 —
  **62% smaller**, measured. The default is unchanged, and an unknown
  target returns the full schema plus the filterable target list rather
  than hiding a needed field.

### Changed — diagnostics

- `parseRgbds` strips ANSI colour and parses modern rgbds's two-line
  `error: …` / `at file(line)` form. Every modern diagnostic was falling
  through, so a failed GB build returned `issues: []` and left the agent a
  raw colour-coded log to read.
- A `NAME: MACRO` parse error now says it is **pre-0.5 RGBDS macro syntax**
  and shows the rewrite (`MACRO NAME`). Published GB disassemblies are
  overwhelmingly 0.3.x-era, so this recurs; the raw error
  ("syntax error, unexpected MACRO") never mentions the syntax change.
- `catalog({op:'status'})` reports bundled toolchain versions
  (`capabilities.versions`) from `scripts/versions.json` — the same pin the
  build scripts compile from. Previously only `romdevVersion` was exposed,
  so the bundled assembler's version could only be inferred from a failure.

## 0.129.0 — 2026-08-22

### Fixed — a reload stranded a playtest window on a dead GL context

`WasmcartHost.loadMedia` nulled `_glCtx`/`_glAttached` without detaching
the window or destroying the context. On a reload of a session that
already had a private GL context with a window attached, the window
stayed bound to the OLD surface, a NEW private context was built for the
new cart, and nothing re-attached the window — `playtest.js` calls
`attachWindow` once at open time and never again.

The cart then rendered into the new context's redirect FBO while the
window kept presenting from the old one, which nothing drew into any
more: a **black window at a healthy 60fps** with `presentMs` ~0.15, and a
CPU readback that still looked perfect, because it reads the *cart's* FBO
rather than what the window presents. Swapping on a surface whose context
had been torn down could also take the whole process down — observed as
`server process died from SIGSEGV`, which killed every other session's
window with it.

- `loadMedia` detaches and destroys the old private context in order
  before dropping the reference, and bumps a generation counter exposed
  as `glGeneration()`.
- The playtest present tick records the generation it attached at, and
  re-attaches when it changes (falling back to readback if that refuses).
- GL currency claims go through one `_claimCurrent()` that records the
  owner, so `destroy()` only hands currency back to the shared context
  when this host actually held it — rather than taking it from another
  session's live window.

Verified over six consecutive reloads with a window open: the window kept
rendering every time and the server never died. Measured with an
OS-level window capture, **not** a CPU readback — see the note below.

### Changed — dependency floors

`wasmcart` ^0.23.0 → **^0.24.0**, `webgl-node` ^1.5.0 → **^1.5.1**.

Those two carry the root cause of a *related* black-window failure that
needed no reload at all: `makeCurrent` lived only on webgl-node's wrapper
object, which consumers throw away in favour of the bare context. So
wasmcart's teardown could not actually switch contexts, and — since GL
object names are plain integers with no context identity — its deletes
destroyed another context's identically-numbered textures. One session
tearing down a GL cart blanked another session's live window.

### Note for anyone debugging a black playtest window

`playtest({op:'framebuffer'})` and `frame({op:'screenshot'})` read the
cart's own FBO. A GL-direct window presents by a separate GPU blit. When
those two disagree — which is exactly this class of bug — the capture
shows a perfect picture while the human's screen is black. Capture the
real window instead:

```
DISPLAY=:0 xwininfo -root -tree | grep '"<window title>' | grep node
DISPLAY=:0 import -window 0x<id> /tmp/real.png
```

## 0.128.0 — 2026-08-21

### Fixed — the HTTP idle reaper destroyed a live playtest window's host

Two idle reapers, and only one knew about playtest. `reapIdleHosts` in
`mcp/state.js` has always skipped protected sessions; the HTTP session
reaper in `http/routes.js` did not — and `dropSession` calls
`clearHost`, so it walked past that protection and destroyed the
emulator underneath a live window. The window stayed up presenting a
frozen frame with `liveHosts:0` behind it, which reads as a game crash.

`lastSeen` is stamped by AGENT TOOL CALLS only, so a human playing for
half an hour while the agent (correctly) keeps its hands off looks
perfectly idle from the HTTP layer. Not touching a human's window is
what triggered it; any stray tool call would have kept it alive.
Measured at 32.6 minutes of Formix against the 30 minute `idleMs`.

This was a regression from the 2026-08-19 OOM fix, which made the reaper
free the emulator deliberately because dropping the session record alone
orphaned its host. That leak-plugging is preserved — only live playtest
sessions are exempt. Cap eviction had the identical hole (the host-side
cap filtered on `!isProtected`, its HTTP twin did not, so the two caps
disagreed about what was evictable) and is fixed alongside it.

### Fixed — the playtest auto-checkpoint never wrote, and reported success

`writeCheckpoint` returned early on `typeof h.serializeState !==
"function"`, and no host in `src/host/` implements it — so this was never
wasmcart-specific: every playtest window ever opened advertised a rolling
checkpoint that did not exist. The early return did not set
`lastCheckpointError`, so the FAILING hint in `playtest({op:'status'})`
could not fire, and the tool reported the reassuring "auto-saves every
~15s" note while nothing was being saved.

A wasmcart has no CPU or address space to snapshot, but it does have its
save region. The checkpoint now takes a whole-machine snapshot when the
host can, falls back to the cart's SRAM when it cannot, and only gives up
when it has neither — setting the error in that case so the existing hint
fires. The checkpoint path's extension follows its content (`.state` vs
`.sav`), because feeding SRAM to `state({op:'load'})` fails; the note
names the matching restore call and states plainly that an SRAM
checkpoint restores saved progress rather than the exact frame.
`playtest({op:'status'})` gained `autoCheckpointWritten` and
`autoCheckpointKind`, separating "saving fine" from "has never once
saved" — a distinction the old shape could not express.

## 0.127.0 — 2026-08-20

### Fixed — 3D-core hosts leaked their whole GL context (romdev-core-host 0.9.0)

The same class as the wasmcart GL-object leak, one layer down. wasmcart
leaked objects INTO a shared context; the libretro HW-render path (N64,
PS1, Dreamcast) leaked whole OWNED contexts: `LibretroGL.destroy()` was
never called anywhere, so every discarded 3D-core host dropped its JS
reference to a native EGL context — which does not free it — taking the
context, its FBO, and everything the core ever allocated with it. This
predates wasmcart carts entirely: it has leaked since the 3D cores landed.

Measured, PS1 load+shutdown cycles: before, +17 MB VRAM and +7 MB GTT per
cycle, monotonic, with the game barely booted (a real play session leaks
its working set); after, dead flat across every cycle. `dispose()` now
destroys the HW-render context before dropping it.

Swept every other GL consumer for the same class, and all are clean:
jsgame measured flat over repeated load/dispose cycles (its session
teardown owns its context); the 2D software cores have no GL at all; and
the Active Bezel GPU path (`gpu-command-v1`, 1920x1080) held flat across
**201 verified composes** — VRAM 2.72 → 2.73 GB, GTT 0.27 → 0.28, i.e.
desktop noise — with the package's own `ticks` counter proving the
renderer actually ran each time rather than the reading being vacuous.

## 0.126.0 — 2026-08-20

### Added — `agentSessionReminder` on a new session's first response

A declared agent (`x-romdev-agent` / `dev.romdev/agentHandle`) that opens a
NEW session gets its own inventory back on that first response: its other
live sessions, what each holds, and idle time — with the two actions that
matter (reuse a key to continue earlier work; `host({op:'shutdown'})` what
is finished). Parallelize-then-sweep becomes a supported workflow: burst as
wide as you like, then use the list to clean up everything you opened.
First call only; declared agents only (an unattributed reminder would leak
other agents' activity and cry wolf on ordinary parallelism); and listing a
session never resets its idle clock.

## 0.125.0 — 2026-08-20

### Added — agent attribution, and fair eviction at the caps

Stateless MCP removed the last transport signal that could group sessions
by caller, so one agent opening dozens of parallel sessions and ten agents
opening a few each were indistinguishable — and at the new session/host
caps, a global oldest-idle eviction let the greediest caller push
bystanders' sessions out.

Callers can now declare who they are: `x-romdev-agent` header (REST) or
`dev.romdev/agentHandle` in `_meta` (2026-07-28 MCP) — one stable value per
agent, across all its sessions. Optional and cooperative. What it buys:
both caps evict the oldest-idle session of the LARGEST holder, so a
parallel agent evicts its own sessions rather than a bystander's.
Undeclared sessions pool as one anonymous holder — unchanged behaviour for
callers that never send it, and anonymity is not a shield (the pool
competes like any holder). `catalog({op:'status'})` reports
`sessionsByAgent`, so "one agent going parallel, or ten agents?" is
answerable from a status call.

## 0.124.0 — 2026-08-20

### Fixed — `host({op:'shutdown'})` ends the session, not just the emulator

An agent that dutifully shut down every session it opened still left each
session's ~20 MB tool registry and its livestream entry alive for the
30-minute idle reaper — the cleanup API existed at the emulator layer and
not at the session layer. Shutdown (primary slot) now drops the whole
session: registry, livestream entry, emulator. Not destructive: the next
call on the same `x-romdev-session` re-creates it, and last-media recovery
breadcrumbs survive independently. Slot-B shutdown deliberately does not
end the session (a comparison in progress must not lose its primary host).

### Added — HTTP session cap + `liveHttpSessions` in `serverHealth`

For agents that never clean up: sessions are capped
(`ROMDEV_MAX_HTTP_SESSIONS`, default 32), evicting oldest-idle to make
room — an eviction self-heals, unbounded growth takes the machine down.
`serverHealth.liveHttpSessions` is the count the livestream session list
shows, so ghost-session questions are answerable from a status call.

## 0.123.0 — 2026-08-20

### Fixed — the GPU memory leak that starved the machine (via wasmcart 0.23.0)

Repeated GL cart loads leaked every GL object the cart created: wasmcart's
import layer tracked them all and nothing deleted them at cart teardown, and
on the SHARED offscreen context — which outlives every cart — that meant each
gate run's full GL footprint (1080p render targets, bloom chains) stayed
resident forever. VRAM climbed ~1 GB per burst of parallel gate runs until
the 8 GB card filled, then spilled into GTT (GPU-mapped SYSTEM RAM), reaching
26.69 GB of a 54 GB machine in ~90 minutes — invisible to ps/top, because
GTT is accounted to the GPU. Fixed upstream in wasmcart 0.23.0
(`_releaseAll` wired into cart destroy); this release pins it. The same
parallel bursts that drove GTT to 3.1 GB now hold dead flat.

### Added — `serverHealth.gpu` in `catalog({op:'status'})`

`gpu {driver, gttMb, vramMb}` — this process's GPU memory, read from DRM
fdinfo, plus a loud warning past ~2 GB of GTT explaining that GTT is system
RAM and why ps will not show it. This is the instrument that traced the leak;
it stays so the next one names itself. The figures are upper bounds (shared
buffers are counted once per process that maps them) — judge the trend, not
the absolute number.

## 0.122.0 — 2026-08-20

### Added — `playtest({op:'open', fastPresent:true})`

A wasmcart GL cart loaded the ordinary way shares the one process-wide
offscreen GL context, which can never be bound to a window (attaching it would
drag every other session's cart into that window). So it presents by dragging
every frame back to the CPU: measured 27.9/45.1/54.9 ms per frame at 1080p
against 3.4/6.1/9.1 GL-direct — the worst case is a human playing at 41 fps.

`op:'open'` already detected that and warned, and it is also the only call that
knows a human is about to watch — so every caller was left re-deriving the same
save/reload/restore dance by hand, and an agent that reported success without
reading `presenting` handed a human a 41 fps window and never knew.

`fastPresent:true` does it for you: read the cart's save data, reload the same
path with `presentWindow:true`, restore the save, attach. The response reports
what happened (`fastPresent: {applied, reloaded, saveDataCarriedBytes}`), and a
failure to make the window faster never fails to open the window.

Opt-in rather than automatic, for two reasons: the reload RESTARTS the cart —
safe at open time, never on a window a human may be mid-game in, so it is
skipped entirely when this session already has a window open — and it costs one
extra GL context per loaded cart, which is wrong for headless gate work where
the readback is what you want.

### Changed — the readback warning is now actionable

It names the cart, so the manual recipe is copy-pasteable rather than a shape
to fill in. `op:'open'`'s description leads with `fastPresent`, since that is
the call an agent reaches for first when a human wants to play. And the
warning on a REUSED window no longer suggests stop-reload-reopen — that advice
could cost a human their game; it now says to leave a live window alone.

## 0.121.0 — 2026-08-19

### Fixed — the server bounds its own emulator memory (it was being OOM-killed)

The server was killed by the kernel twice in 28 minutes (~5.4 GB RSS,
300-500 GB mapped) under a SINGLE agent running one 21-gate cart suite. It
never logged a crash because it never crashed; it was shot, and the log
simply stopped mid-boot. Downstream, every gate in the run failed with
ECONNREFUSED, which reads exactly like a red assertion rather than a dead
host.

Two mechanisms, neither of them wrong code — both absent policy.

`unloadMedia()` freed the ROM and kept the core: it calls
`retro_unload_game` and nulls the status fields but leaves the Emscripten
instance, and therefore its whole WASM linear memory, resident. That is
correct when a host is about to be REUSED, which is the normal case, and a
leak only when the host is being thrown away. `LibretroHost.dispose()`
(new, `romdev-core-host` 0.8.0) unloads the game, runs `retro_deinit`
while the heap is still valid — skipped for proxied cores, whose deinit
belongs to the app thread — then drops the module and every view into it
(`lastFrame` and `audioRing` are subarrays of the module heap, and one
retained entry pins the whole ArrayBuffer).

Eviction was keyed on the transport, which is the wrong clock. Every
client script is its own session, so a 12-minute suite mints 20+ hosts,
and the only reaper was a 30-minute TRANSPORT-idle sweep — it cannot fire
during the run, and never fires at all for a script that exits without
closing. Hosts are now stamped on every access and swept on their own
inactivity (`ROMDEV_HOST_IDLE_MS`, default 10 min) under a hard cap
(`ROMDEV_MAX_HOSTS`, default 10) that evicts the oldest-idle session
rather than refusing to load. An eviction is not an error: `lastMedia`
outlives the host, so the next call returns a "No ROM loaded" error naming
the exact `loadMedia({...})` to re-run. **Playtest sessions are exempt** —
a human may be mid-game.

Measured on the workload that did the killing: peak RSS 5.4 GB and a
kernel kill, versus ~2.9 GB and three consecutive green suite runs on one
process.

### Added — MCP 2026-07-28 (the stateless revision) served alongside 2025-era clients

The current MCP revision removes the `initialize` handshake, the
`Mcp-Session-Id` header and protocol sessions outright; every request
carries its version, capabilities and identity in `_meta`, and servers
MUST answer `server/discover`. Per the spec's compatibility matrix a
modern client talking to a legacy-only server simply fails.

Both eras are now served on `/mcp`. Legacy clients are unchanged.
Modern requests are served statelessly, with `server/discover` advertising
`["2026-07-28"]`. Since that revision has no protocol session to carry
identity, pass a stable handle as `_meta["dev.romdev/sessionHandle"]` on
every call — it ties your calls to YOUR emulator exactly as
`x-romdev-session` does over plain HTTP. Omit it and every call lands in a
fresh empty session.

Note for anyone doing the same migration: `createMcpHandler`'s default
`legacy: 'stateless'` builds a FRESH server per request, which is right for
a stateless service and wrong for a server where a session owns a live
emulator. This uses `legacy: 'reject'` behind `isLegacyRequest`, the
pattern the SDK documents for keeping an existing sessionful deployment.

### Added — `serverHealth` in `catalog({op:'status'})`

`{rssMb, liveHosts, maxHosts, hostIdleMs}`, so an agent seeing odd
failures can ask instead of inferring from a connection error.
`liveHosts == maxHosts` during a heavy run is HEALTHY — it is the cap
working, not a leak.

### Changed — cart output no longer floods the server log

wasmcart's `CartHost` writes every `wc_log` line and cart printf straight
to stderr, one or two per frame; that put 58 MB of per-frame telemetry
into the log in a day and buried every actual server event — including the
evidence of the kills above. Those lines now go to a 200-line ring buffer,
surfaced as `recentCartLog` in `catalog({op:'status'})` and restored to the
log wholesale with `ROMDEV_LOG_CART=1`. The log also gained a pid-stamped
startup line, so a log ending without a shutdown line is legible as a kill.

## 0.120.0 — 2026-08-19

### Fixed — wasmcart SRAM is now visible to `state()` and survives a reload

wasmcart carts have real SRAM (`WasmcartHost.getSaveData()`), but everything
around it was broken: `state({op:'exportSram'/'importSram'})` routed every
platform through the libretro save-RAM REGION api (`regionSize`/
`readMemory(region,...)`), which wasmcart doesn't implement — the resulting
TypeError was swallowed by a `catch { return 0 }` into a confidently wrong
"the loaded ROM has no battery save RAM", even on a cart holding 4096 live
bytes. `state({op:'save'})` called `host.saveState()`, which also doesn't
exist on wasmcart, and threw a raw uncaught TypeError. And nothing persisted
SRAM across `loadMedia` — the only way an agent (or a human at the playtest
window) restarts a cart — so a save file could never be observed surviving a
reload, which is the entire point of a save file.

- `WasmcartHost` gained `setSaveData`/`saveDataSize` alongside the existing
  `getSaveData`, all backed by the cart's own `savePtr`/`saveSize` via the
  raw-heap `readMemory`/`writeMemory` this host already exposes — there's no
  named `save_ram` region on wasmcart, just an offset into the cart's heap.
- `exportSram`/`importSram` now branch on which SRAM shape a host offers
  (wasmcart's get/set pair vs. libretro's named region) instead of assuming
  the region API and reporting a false size-0. The "no battery save" error
  now also distinguishes "this platform genuinely has none" from "this host
  doesn't implement the region API" — the specific thing that turned a
  missing implementation into a confidently wrong answer.
- `state({op:'save'/'load'})` on wasmcart now fails with a clear message
  ("whole-machine savestates are not supported on 'wasmcart' ... use
  exportSram/importSram instead") rather than a raw `host.saveState is not a
  function` TypeError.
- SRAM now survives a `loadMedia` of the same cart path within a session, via
  an in-process cache (NOT a file written next to the ROM — the first cut of
  this fix did that, and it broke every OTHER wasmcart test in this repo's
  own suite: every load of a tracked `.wasc` fixture left an untracked `.sav`
  beside it). `state({op:'exportSram'})` remains the explicit, opt-in path
  for save data that needs to survive across sessions/restarts.

Verified live against formix's real 4096-byte SRAM through the MCP tools:
`exportSram` now reports 4096 bytes (not 0) and round-trips correctly;
`state({op:'save'})` fails with the new clear message; a reload of the same
cart path carries the SRAM forward unchanged.

## 0.119.0 — 2026-08-19

### Fixed — the playtest window forwards the scroll wheel to the cart

0.118.0 taught `input({op:'wheel'})` to reach a cart, which fixed the
headless MCP path — but it never touched the playtest window itself, so a
human at the window still had every platform wheel event dropped on the
floor. A cart whose only mouse zoom is the wheel was driveable by an agent
and not by the person holding the mouse: it read as a broken game rather
than a missing handler. Found on exactly that cart — the pad shoulders
stepped the zoom correctly and the wheel did nothing at all.

The window's `mouseWheel` handler now converts node-sdl's NOTCHES to
wasmcart's 1/120-notch `wc_wheel_t` units (ROUNDED, not truncated, so a slow
trackpad drag's small fractions don't vanish to zero), respects
`SDL_MOUSEWHEEL_FLIPPED` (natural scrolling — negates both axes), positions
the pointer at the wheel event's location first (an anchored zoom reads the
pointer position), and forwards through `host.setInput`. Two-finger trackpad
scroll and macOS pinch (ctrl+wheel) both arrive as wheel events, so this is
also the only route those gestures have into a cart.

The conversion (`wheelEventToCartDelta`) is exported and unit-tested in
isolation, since the window itself cannot be driven headlessly.

Touch is still not wired — the playtest window remains mouse/pad/keyboard
only for direct human input.

## 0.118.0 — 2026-08-17

### Added — the scroll wheel reaches wasmcart carts: `input({op:'wheel'})`

wasmcart 0.22.0 added `wc_wheel_t {int32 dx, dy}` behind `wc_info_t.wheel_ptr`
(ABI v3.1), gated by the existing `WC_FLAG_POINTER`. `WasmcartHost` never
forwarded it, so a cart that bound one continuous axis — camera zoom, a
throttle, a scrub bar — had no way to be driven headlessly, and the playtest
window dropped the platform's wheel events on the floor.

```
input({op:'wheel', notches: 1})     # one click of a detented wheel, UP
input({op:'wheel', notches: -0.25}) # a trackpad nudge, DOWN
input({op:'wheel', notchesX: 1})    # horizontal (tilt wheels, trackpads)
input({op:'wheel', dy: 120})        # the raw 1/120 units, for ABI assertions
```

`notches` is the unit a cart author thinks in; `dx`/`dy` are the raw
1/120-notch WHEEL_DELTA form for a test pinning exact values. Notches win when
both are passed, and are **rounded rather than truncated** so `0.1` is 12 units
instead of vanishing. **Positive is UP** — the `wasmcart.h`/SDL/LOVE
convention, not the browser's downward `deltaY`.

Two contract details that are easy to get wrong, and are tested rather than
assumed:

- The delta belongs to the **next frame stepped**, and the host clears it
  afterwards. So a wheel call must be followed by a frame step to be observed,
  and a cart cannot keep zooming forever off one flick.
- Repeated calls before that step **accumulate**. A trackpad flick is dozens of
  events; a host that assigned instead of adding would deliver only the last
  one. Verified against wasmcart-lua's wheel cart through the MCP: two
  `notches:1` calls then one step arrives as `dy=2.0000`, and a step with no
  wheel reads `0.0000`.

A zero delta is **refused** rather than accepted as a no-op: the field is
already cleared every frame, so scrolling by nothing can only be a caller
error, and accepting it would let a units mistake (`0.001` notches rounding to
0) look like it worked.

Also repins `wasmcart ^0.22.0`. A cart host resolved on an older wasmcart
degrades to a no-op instead of throwing, since `cart.wheel` simply is not there.

## 0.117.1 — 2026-08-16

### Fixed — `/livestream` was slow to show its sessions over a network

The page connected with a bare `io()`, which is socket.io's **polling-first**
default: it opens on HTTP long-polling and upgrades to WebSocket afterwards.
That costs **three sequential round trips** before any content arrives —
`GET`(open, returns the sid) → `POST`(the `40` connect packet) → `GET`(data,
which is what carries the `replay`) — and the replay body is base64-inflated
on the way through. Every later server→client message then needs its own
request cycle instead of a push.

On loopback each leg is ~1.5 ms, so the whole thing is invisible. That is
exactly why it shipped: the observer was written assuming loopback, and
`server.js` still says so (`No auth — loopback only`). Over a network it is
3× RTT before the **"connected" label** even flips — the label waits on the
POST, not the first GET — and the session tabs wait on the third leg, because
`replay` is the only thing that populates them. Reported as "kinda slow to
display the sessions", from another machine, and not reproducible locally at
any payload size.

Now `io({ transports: ["websocket", "polling"] })`. Polling is **kept as a
fallback** rather than removed: a proxy or network that blocks WebSocket
would otherwise get no livestream at all, which is a worse failure than a
slow one.

A guard test asserts the option on the SHIPPED html, and asserts the option
itself rather than any behaviour — the UI harness's `io` stub ignores its
arguments, so a silent revert to bare `io()` would keep every other
livestream test green. Confirmed it fails on that revert.

## 0.117.0 — 2026-08-16

Everything since 0.116.0, which is the last version on npm. 0.116.1 and
0.116.2 were bumped in the repo but never published, so their changes ship
here rather than carrying release dates that never happened.

Four of these are GL-context lifetime bugs found in the same area within a
week of each other. That is the theme of the release: one process-wide shared
context plus per-host private ones, and every place that assumed whatever was
current was the right one.

### Fixed — the shared GL context is claimed at LOAD, not just at step

A cart loading on the shared offscreen context built its FBOs against
whatever context happened to be current. After a `presentWindow` load that is
another host's PRIVATE context, so the cart ran on the shared context with
attachments validated against a different one. Only a demanding target
notices: 3DreamEngine's sky job (cubemap/MRT) fails with "the framebuffer is
incomplete — the targets must agree on size", while plain 2D canvases complete
fine. The private path already claimed its context at load; this one did not.

Why it took four reports to place: **the damage lasts exactly one load.** The
next load finds currency already corrected by the first load's own
`stepFrames`, so the second measurement always passes. Two people on the same
box with the same cart binary got opposite answers depending purely on who
measured second, and each produced a confident, wrong isolation from it.

It shipped on reasoning rather than on a green run — the shared path must
never rely on another host having left the right context current — and the
reproduction followed: 9/10 fail without the fix, 0/10 with it. The earlier
"cannot reproduce" was a single trial each time, and the first load after a
fresh server has no stale private context to inherit, so it passes even when
broken.

`test/fixtures/glstress.wasc` is the fixture that can actually see this
(1920x1080, re-set scissor, MRT set plus a cubemap); `glcart.wasc` is 64x64
and builds no such target, so it never reaches the attachment validation. The
committed tests are **regression guards, not proof**, and say so: in-process,
one process reusing one shared context does not reproduce what separate MCP
sessions do. The MCP harness stays the oracle.

### Fixed — EGL failures that were really an X auth problem

A compositor restart regenerates the Xwayland auth file, but a long-lived
login session keeps exporting the path it was handed at login. The old file
still exists and is still readable, so nothing looks wrong — EGL just starts
failing with `Invalid MIT-MAGIC-COOKIE-1 key` / `eglInitialize failed`, which
reads as a GPU or driver fault. Found on a box whose `$XAUTHORITY` pointed at
an Aug 5 cookie while the server had moved to an Aug 13 one: **every GL cart
had silently lost the GPU**, which is never something to fall back from
quietly.

`resolveXauthority()` runs before anything can create a context. It acts only
when the current cookie is demonstrably broken and only picks a candidate that
demonstrably works — verification is a real `xdpyinfo` connection, not an mtime
guess, because newest-file-wins would happily select a newer-but-wrong cookie.
Without `xdpyinfo` there is no oracle, so it changes nothing rather than
swapping blind. Scoped to Linux/X11; Windows and macOS take a `not-linux`
early return before any fs or exec work.

### Fixed — the livestream replay could be ~20MB

`result` went through `summarizeForLog`; `images` is a sibling field that
never did, so a ring of 50 frames retained 50 full-size base64 PNGs.
socket.io's default `maxHttpBufferSize` is 1MB, and exceeding it does not
error visibly — the server closes the connection and the client reconnects
into the same oversized payload. The symptom was "the livestream page
sometimes takes a very long time to render", intermittent because a ring of
cheap text calls replays in a few KB.

Three bounds, smallest first: image payloads are retained only on the newest
event (`ROMDEV_OBSERVER_RING_IMAGES`), older ones degrading to
`{omitted, bytes}` placeholders; a byte budget
(`ROMDEV_OBSERVER_RING_BYTES`, 8MB) evicts oldest as a structural backstop;
and `maxHttpBufferSize` is now a stated 32MB choice rather than a silent 1MB
default. Measured on the shape that broke: **20,486,282 → 416,804 bytes, 49x.**

### Fixed — the livestream PAGE grew for as long as the tab stayed open

The server-side ring is byte-bounded; the page it feeds was not. Every piece
of per-session state grew without limit — one event entry per tool call
forever, one full base64 PNG per distinct tool name (~40 tools), one entry per
session key ever seen — and `renderLog()` rebuilt a DOM row for every retained
event on every incoming event, so a tab left open next to a long run got
steadily slower as well as fatter.

Caps are per-session so a fan-out across carts stays a normal shape:
`MAX_EVENTS` 300, `MAX_IMAGE_KINDS` 8, `MAX_LOG_ROWS` 200, and `MAX_SESSIONS`
96 as a backstop that evicts DEAD sessions only — never a connected one, and
never the tab being viewed. The tests run against the REAL shipped HTML (the
inline IIFE is extracted and run on a stub DOM) rather than a hand-copy that
would pass forever while the page regressed.

### Added — `playtest` says which present path a window actually got

`op:'open'` and `op:'status'` now return `presenting` (`"gl-direct"` |
`"readback"` | `"software"`), and a GL cart on the readback path also returns
`presentingWarning` with the numbers and the fix. Measured on three 1080p
carts: readback 27.85 / 45.13 / 54.89 ms per frame against 3.42 / 6.11 / 9.11
GL-direct — the worst case is a human playing at 41 fps. Nothing in the
response used to say which path a window got, and the one line that noticed
was `log.debug`, so the only symptom was a human saying the game felt bad.
That line is `log.info` now, and the reused-window branch reports it too — a
reopen must not be the one call that hides a slow window.

Deliberately NOT auto-reloading with `presentWindow:true` on open, though
`open` is where the intent becomes known: `WasmcartHost` has no
`serializeState` (only cart save data), so the reload would silently discard
the player's progress, and `open` cannot know whether a human is mid-play.
Trading a visible 5-8x perf problem for invisible data loss is the wrong
direction. The warning names the reload as the fix and says to do it before
the human starts.

### Fixed — a `presentWindow` load no longer poisons later plain loads

Tearing down a presentWindow host destroyed its private GL context and left
NOTHING current — native-gles unbinds on destroy and does not fall back — so
the next cart to load on the shared offscreen context made GL calls against a
null current context and died with `Cannot read properties of null (reading
'_id')`. One `presentWindow:true` load broke every plain `loadMedia` after it,
for the life of the server process.

It presented as a per-cart rendering fault rather than a lifetime bug: five
shipped carts screenshotted, 4 of 5 black or failing on the DEFAULT readback
path while all five worked with `presentWindow:true`. The one that worked was
simply first in the list, before any direct load had happened. Fixed by
handing currency back to the shared context after destroying a private one.
Affects 0.116.0 only.

## 0.116.0 — 2026-08-12

- **GL wasmcart carts can present straight to the window: `loadMedia({
  platform:'wasmcart', presentWindow:true })`.** A GL cart used to have every
  frame dragged back to the CPU (`glReadPixels` + a row flip + an alpha pass)
  purely so SDL could blit it in software — measured at a third of a frame
  budget at 1080p, moving pixels the GPU already had. With `presentWindow` the
  cart renders into its own GL context, which the playtest window binds
  directly, and presenting is a GPU blit + swap: **`convertMs` 3.52 → 0**,
  window cost ~7.45 ms → ~2.0 ms on a 1080p 3D cart at a steady 60 fps.

  It is opt-in **at load time** because the GL context binds when the cart's
  wasm loads and cannot be swapped afterwards, so a cart already loaded without
  it keeps the readback path until it is reloaded. It is also deliberately not
  automatic: the offscreen GL context is ONE process-wide object shared by
  every cart in every session, so attaching *that* to a window would drag every
  other session's cart into it. `presentWindow` builds a private context the
  host exclusively owns, and only a private context may ever be attached.

  **Captures are unaffected, by contract.** A screenshot under `presentWindow`
  is byte-identical to the readback path — full cart frame, cart resolution —
  and the readback stays lazy: stepping copies no pixels, only a consumer
  asking for them pays. Requires wasmcart ≥ 0.21.2 and webgl-node ≥ 1.5.0.

- **P/Space no longer kills the server on wasmcart and jsgame windows.**
  `pause()`/`resume()` existed only on `LibretroHost`, and the hotkey called
  them unguarded from inside an SDL event callback — where a throw escapes the
  tool-call error path entirely and takes the whole process down, losing every
  session's host. With no `status.paused` field the ternary always took the
  pause branch, so it threw on the FIRST press, every time, on a key the
  window's own help text invites the human to press. Both hosts now implement
  the pause contract (a paused cart is genuinely frozen — `stepFrames` returns
  0), the call site is guarded like its F2/F4 neighbours, and K (frame
  advance) and R (rewind) — previously unreachable, now live — handle
  jsgame's async `stepFrames`, whose unhandled rejection was the same hazard
  by another route.

- **A playtest window stops stepping a core that has trapped.** A WASM cart
  that traps (typically `memory access out of bounds` — its linear memory hit
  the maximum its own build declared) fails identically forever, but the tick
  loop retried it 60 times a second, burying the cause under identical log
  lines. Three consecutive step errors now disable stepping and log ONE
  diagnosable line naming the cart's actual linear-memory size; a single good
  frame clears the counter, so a genuine one-tick blip mid-swap still rides
  through. The window keeps presenting its last good frame and stays
  responsive to F2/ESC — `loadMedia` recovers it.

- **Fixes to the GL-direct path, all of which rendered a plausible-but-wrong
  picture rather than erroring** (found by the MCP client agent measuring
  frame EXTENT, and by a human looking at a window):

  - the game drew in the **bottom-left corner** of any window that was not
    exactly the cart's resolution — presenting was a bare `swapBuffers` with
    no letterbox, where the readback path had always scaled into a `dstRect`;
  - **screenshots of an open GL-direct window came back black** with
    `ok:true` — the readback read the window surface, whose contents are
    undefined after a swap, instead of the cart's own frame;
  - **captures were cropped and scaled**, and the crop moved with window
    state — the readback clamped its region to the CONTEXT (window) size while
    the cart renders into a cart-sized FBO;
  - **resize and F11 fullscreen** put the game back in a corner — nothing told
    the GL surface the window had changed, so the letterbox rect and the
    surface disagreed;
  - **dragging a window narrow permanently squashed the game** — `stepFrames`
    clamped the cart's declared `fbWidth`/`fbHeight` to the context size, so a
    resize rewrote the CART's size (and `Math.min` only shrinks, so it never
    recovered). `displayAspect` became portrait, the letterbox then fitted the
    picture perfectly to a corrupted target, and every geometry check stayed
    green while the window was visibly wrong.

## 0.115.2 — 2026-08-11

- **snes9x captures the displayed frame as LAYER PLANES** — new regions
  `snes_lp_world` (every non-OBJ pixel) and `snes_lp_obj` (every OBJ
  pixel, 0x0000 transparent key), split per line by the core's own depth
  buffer at capture time. Nothing re-renders, so HDMA gradients and color
  math stay baked in, and world-then-obj compositing reproduces the frame
  exactly. This is what gives active-bezel's `snes.draw` its layer split
  (platform-snes 0.11.0): a SNES bezel can now shade the world and the
  actors separately, smb-acid style, with the player passed through
  untouched.

- **GL-direct present is the ONLY present path for GPU-bezel windows, and
  `ROMDEV_GL_PRESENT` no longer exists.** A window that cannot bind the
  compositor's GL context onto its surface refuses to open with an error
  naming the broken layer, instead of silently falling back to the 1080p
  software blit (~29ms/frame, game at half speed) -- the silent degrade
  that hid a broken native-gles `attachWindow` for two days of sessions.
  GPU is a REQUIREMENT on every machine this runs on; there is no flag
  because there is no legitimate reason to choose the broken path. Pairs
  with active-bezel 0.9.4, where a gpu-command-v1 guest whose GPU
  compositor fails to init throws instead of quietly composing on CPU.

- **`loadMedia` accepts `coreOptions`** — libretro core options applied
  before the ROM loads, overriding the core's defaults (romdev-core-host
  0.7.1 carries the passthrough; core-runner 0.2.9 repins it). The driving
  case: `{"snes9x_layer_3":"disabled"}` hides a layer at the RENDERER —
  game state and VRAM untouched — so an Active Bezel can own that layer
  and re-render it itself (a reverse-mode bezel keeps the status bar
  readable this way: the core never bakes the text into the frame, so
  there is no mirrored ghost to fight). Keys are core-specific and
  unvalidated; a wrong key is silently ignored by the core, so verify the
  effect visually.

- **The playtest tool now says what an Active Bezel actually is.** A field
  session (fresh agent, external user) asked "can the playtest window do
  RetroArch GL filters?" and the agent answered — from this tool's schema
  alone — that an Active Bezel is "an image-overlay frame around the
  picture," concluding no shader path exists. The op:'bezel' surface never
  contradicted it. The description now states the real thing: a programmable
  WASM+GPU compositor over live game memory, with `effect_set` (single-pass
  RetroArch .glsl ports near-verbatim) and `surface_preset` (whole
  multi-pass .glslp presets) — and that this IS the CRT/scanline/GL-filter
  mechanism, attached via loadMedia. Tool descriptions are the only surface
  a fresh agent is guaranteed to read; the capability existed, the schema
  hid it.

## 0.115.1 — 2026-08-07

### playtest: bezel suspend no longer freezes a GL-present window

- With GL-direct present active, the B-key suspend path fell into the SDL
  software-render branch — but ANGLE's CAMetalLayer owns that window, so
  SDL's draws landed underneath it: the window froze on the last GL frame
  (reads as a crash) and the composite did not come back on resume. The
  raw core picture now presents through the same GL pipeline (draw into
  the scene, blit, swap — ~0.3ms, still vsynced). One window, one stack,
  in both toggle states.

## 0.115.0 — 2026-08-07

### NES Game Genie: `cheats({op:'make'})` emits the canonical spelling

- 8-letter NES codes now set bit 3 of the third letter — the 8-character
  LENGTH MARKER Galoob's encoder sets on every 8-letter code (measured:
  30,531 of 30,532 published 8-letter codes in the bundled DB, and after
  the fix 20,090 of 20,118 unique DB codes re-encode byte-identical; the
  rest are known mis-published outliers). Every emitted 8-letter code used
  to differ from its published spelling by exactly this bit (`SLZPLOVS`
  for Contra's `SLXPLOVS`). Codes spelled either way still APPLY — fceumm
  and romdev's decoder branch on length and mask the bit — but emitted
  text is published text, and real hardware sets the marker.
- Why the round-trip test never caught it: the decoder masks the bit, so
  `decode(encode(x)) === x` held while every emission was mis-spelled. New
  tests pin emitted TEXT against published codes (verified failing without
  the fix), assert the marker invariant (set on 8-letter, clear on
  6-letter), and pin that both spellings still decode identically.

### Every GL consumer pinned to its own context

- native-gles is multi-context; the process-global context is gone. One
  session's playtest window can no longer present another session's
  rendering (found as: a wasmcart session's window showing a different
  session's game + bezel). WasmcartHost makes its offscreen context current
  before each step burst; hw-render cores (LibretroGL) record the handle of
  the context they render into and bind makeCurrent/resize/destroy to it —
  the bare `destroyContext()` there used to tear down whichever context
  happened to be current.
- **macOS playtest windows: real vsync, correct Retina scale.** Via
  native-gles' ANGLE **Metal** backend: display-synced presents
  (`CAMetalLayer.displaySyncEnabled`; the previous CGL backend free-ran at
  thousands of swaps/sec no matter the swap interval), NSView handles
  resolved to their backing CALayer (window surfaces on macOS never
  actually worked before), and per-swap backing-scale re-sync so dragging
  the window between monitors with different scales keeps the picture
  full-size instead of collapsing it into a corner.
- **Honest `convertMs`.** The playtest perf counter started its timer above
  the whole bezel tick+compose block and re-counted it as ~2.7ms of phantom
  framebuffer conversion. It now times only the convert/wrap section:
  ~0.0005ms with a bezel active (a zero-copy Buffer wrap).

## 0.114.0 — 2026-08-06

### Active Bezel pre_frame: a bezel can shape the frame, not just observe it

- active-bezel 0.7.0 (ABI 2): a package may define `pre_frame(frame)`,
  called before EVERY core frame by every frame driver — `frame({op:'step'})`,
  `runUntil`, watch/breakpoint runs, playtest. Region writes land before the
  game's logic consumes them, and `ab.input_override` replaces what the core
  is polled with for that frame (whole mask or per button). Hook lives on the
  host's per-frame choke point (`romdev-core-host` `beforeFrame`), so no
  driver can skip it — an input remap that missed frames would play garbage.
- Overrides are one-frame statements: cleared at the top of every frame,
  re-asserted by the bezel each frame it still wants them. The physical
  `inputPorts` word is never touched — `input({op:'set'})` still sets the
  real pad, input displays and `humanPressing` keep seeing the truth, and the
  bezel's own `ab.input` reads report physical state so a left/right swap
  cannot feed back on itself.
- `catalog({op:'status'})` reports `activeBezel.preFrame: {defined, calls}`
  plus `preFrameHookError`. Check it before trusting a negative input result
  or a "value changed with no writer" observation: pre_frame writes are
  host-side pokes, invisible to core-side `breakpoint`/`watch`.

### Analog input: raw axes reach the host, triggers reach the mask

- `input({op:'set'})` ports accept `axes: {lx, ly, rx, ry, lt, rt}` (sticks
  −1..1, triggers 0..1). Additive: the digital mask stays the game-facing
  contract; axes feed the libretro ANALOG device — real proportional N64
  steering instead of full-deflection d-pad synthesis (d-pad synthesis still
  applies per-axis when no real axis is present) — and a bezel's analog
  `ab.input` reads (sticks + index-2 trigger pressure).
- The playtest window (and `runRom`) now map the physical pad's analog
  triggers onto the L2/R2 mask bits through ONE shared derivation
  (`romdev-core-runner` `deriveTriggerState`): baseline-relative threshold
  with hysteresis, so an X360 trigger that idles mid-scale neither sticks nor
  chatters. Both sticks and baseline-corrected trigger pressures flow through
  as axes. Most retro platforms ignore bits 12-15, which makes L2/R2/L3/R3
  free real estate for bezel controls.

### Bezel suspend/resume, new window hotkeys, lifecycle events actually delivered

- **`playtest({op:'bezel', show?})` + the B hotkey** suspend/resume an
  attached Active Bezel WITHOUT tearing it down: the guest keeps every bit
  of interpreter state (resume never re-runs `init()`); while suspended,
  captures and the window show the raw core frame (`source:'core'`),
  pre_frame stops shaping the game, and any staged input override is
  dropped. `catalog({op:'status'})` reports `activeBezel.bypassed` — check
  it before reading a `source:'core'` capture as "no bezel exists". Agent
  and human flip the SAME state (the op:'fps'/F3 pattern).
- **H hotkey** in the playtest window: soft reset (the console RESET
  button; RetroArch's default binding), same path as `host({op:'reset'})`
  including the bezel continuity notification.
- **Bezel lifecycle events were silent no-ops — fixed.** `notifyActiveBezel`
  passed string names ("reset") where the runtime's `event()` takes numeric
  AB_EVENT codes; a string coerces to event 0, so every reset/state-load/
  rewind notification since the feature landed reached no guest and
  refreshed no regions. Names now map to codes.

### The playtest window: GL-direct present by default, pacing that can slow down, unfocused gamepad

- **GL-direct present is the default** (opt out `ROMDEV_GL_PRESENT=0`). The
  bezel compositor's GL context rebinds onto the window's native handle and
  presents by GPU blit + swap — ~0.1ms at any window size, no software-blit
  rescale cliff. It proved out behind `ROMDEV_GL_PRESENT=1` since 2026-08-03;
  the flag being lost across a server restart is exactly how a live session
  regressed to a 13.7ms software present, ~54Hz core ticking, and a growing
  audio queue while the window still reported 60fps.
- **Audio-paced stepping can now slow the game DOWN, not just speed it up.**
  Every tick used to step at least one frame, and Node's setInterval floors
  at ~16ms — under NTSC's 16.69ms — so games ran ~3.5% fast and the queue
  climbed to the 250ms safety valve (a quarter second of audio latency). A
  tick that finds the queue already a frame past target now presents without
  stepping, locking game speed to the audio clock. Queue target raised
  60ms→100ms: at 60ms the device oscillated dry-and-refill (the clicks and
  pops), since any GC pause on the event loop out-sized the cushion.
- **The gamepad works with the window unfocused.** SDL drops controller
  button presses without input focus unless the background-events hint is
  set; `initSdl()` (romdev-core-runner) now sets it, so playtest + `runRom`
  keep taking pad input while the human watches a terminal. Keyboard stays
  focus-gated by design (keys route to the focused window). Override with
  `SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS=0`.
- **Lynx presents at its native LCD shape** (160:102 — the Lynx screen is
  square-pixel) instead of a 102:81 approximation. The rest of the `tv`
  table is unchanged: consoles present 4:3, the other handhelds already used
  their native LCD ratios.

### active-bezel 0.8.0: script errors you can actually see, layered redraw

- Repinned `^0.8.0` (published 2026-08-06; the ABI 2 pre_frame release plus
  the layer split). Agent-facing here: **a bezel script error no longer
  masquerades as healthy.** The runtimes catch script exceptions and draw a
  readable error panel (embedded TTF face) while the tick returns normally —
  so `error`/`lastError` stay null. The guest's `ab_last_error` now surfaces
  through `catalog({op:'status'})` as `activeBezel.BEZEL_SCRIPT_ERROR` with a
  hint, hoisted to the top of the status object so a health check can't scan
  past it.
- For redraw packages: three-way layer routing (backdrop / solid tiles /
  sprites in one draw), `hide_cell` / `hide_sprite` / `isolate_sprite` (own a
  class of pixels without screen-scraping; identify entities by OAM slot, not
  colour), and `surface_filter` mask textures + ordering/ping-pong fixes.

Tests: `pre-frame-hook.test.js` — pure override semantics, the per-frame
beforeFrame contract on the real core, a control-gated nestest check that the
CORE genuinely sees a masked button, an MCP end-to-end run where a Lua
bezel's pre_frame stamps RAM once per frame, and a suspend/resume round
trip proving frozen counters, core-labeled captures, and same-instance
resume. Packages: romdev-core-host 0.6.0, romdev-core-runner 0.2.7,
active-bezel ^0.8.0 (repinned).

## 0.113.0 — 2026-08-05

### The mouse drives wasmcart pointer carts, in the window and from the tools

- The playtest window forwards real mouse moves/clicks into a pointer cart's
  slot 0, inverted through the exact letterbox the frame was presented with —
  a human can just click, including after a resize. Gated on the cart
  declaring FLAG_POINTER, so pad-only carts never see mouse movement.
- `input({op:'pointer'})` gains `id` (0 = mouse, 1-9 = touch fingers) and
  `active:false` to release a slot. The old hardcoded slot 0 made the #1
  cart-side portability trap untestable: a cart that polls only pointer[0]
  works with a desktop mouse and silently ignores every touch on a phone.

### Per-scanline capture planes in six cores; regions are platform-gated

The memory regions behind the pixel-exact redraw bezels graduate into the
shipped cores: NES scroll/CHR/sprite/palette/mask/per-pixel planes (and
`nes_cart_ram`), GB/GBC capture planes, Genesis/SMS/GG line planes, SNES
line state + Mode 7, PCE VDC/VCE lines and palette write log, MSX VDP lines
and VRAM deltas. `memory({op:'read'})` now refuses a region the loaded
platform does not expose, naming the platform's actual list — region ids are
baked per-core, and reading another platform's id returned garbage that
looked like data. Core packages rebuilt and bumped: fceumm 0.12.0,
gambatte 0.11.0, gpgx 0.14.0, geargrafx 0.9.0, bluemsx 0.8.0 (which also
now ships its mapper databases — without them unrecognized mapper carts
loaded, reported success, and sat on a blank screen), platform-snes 0.10.0.

### Exactness and correctness fixes

- Core options that paint non-hardware pixels are pinned off: fceumm's
  Zapper crosshair (a core-drawn overlay that made light-gun games look
  like renderer bugs) and gambatte's float-gamma GBC colour correction
  (unreproducible rounding; also a determinism hazard). core-host 0.5.0.
- The GB/GBC Game Genie codec is transcribed verbatim from the shipped
  core. The previous version, written from a third-party reference doc,
  decoded EVERY published 9-digit code to the wrong address and compare.
- HTTP and MCP now run tools with IDENTICAL arguments: the HTTP path
  validated with the zod schema and then threw the parsed result away, so
  none of the ~184 `.default()` declarations applied over HTTP. Pinned by
  a transport-parity test.
- `disasm({target:'decompile'})` accepts `bank` for switchable-mapper
  addresses; without it the decompiler read bank 0's filler and reported
  "bad instruction data" for code that lives in another bank.

### Operational

- The re-exec wrapper reports how its child died: a signal-killed server
  (segfault in a GL driver, OOM kill) exited 0 and the logs said clean
  shutdown. Now it names the signal and exits 128+signum.
- Observability priced as a recent-history feed: log ring 5000→500
  entries (ROMDEV_LOG_RING raises it), livestream frames downscale to
  <=960 wide before PNG encode (the full-1080p encode was ~120ms of
  synchronous stutter every 2s inside playtest).

## 0.112.0 — 2026-08-01

### Universal Active Bezels flow through loadMedia

active-bezel 0.5.0 lets a package declare `"universal": true` — it works with
any ROM, matching at a new level instead of needing `activeBezelForce`. The
pin moves to `^0.5.0` so that declaration reaches `loadMedia`; nothing changes
in romdev's own surface.

### NES full-loop feedback round (client session, 2026-07-31)

- `frame` honours `crop` on `op:'screenshot'` AND `op:'stepAndShot'`. It was
  silently ignored on the step path — the docs recommended it for reading HUD
  strips cheaply, and an agent following that advice got the full frame while
  believing it was looking at the crop.
- The `disasm` functions → decompile chain works on NES. Two layered bugs:
  `decompile` treated the CPU address `functions` reports as a flat file
  offset, and once mapped, NROM handed the decompiler the raw file — where a
  function's own absolute references (`jsr $8CBD`) point past the end of a
  32KB image loaded at vma 0, so Ghidra bailed with "No function selected".
  NROM now gets a CPU-addressed 64KB image (PRG at $8000, NROM-128 mirrored
  into $C000) the way the banked-NES and SNES paths already did.
- `disasm({target:'functions'})` is bounded: 25 functions by default, sorted
  by size, with `total`/`truncated` in the response and `topN`/`minSize` to
  widen or filter. A 32KB NROM previously returned all ~115 functions —
  including ~40 single-block cc65 stubs — as the single most expensive
  response in a session.
- `build` rejects `crt0`/`crt0Path` on non-SDCC platforms with a message that
  names the actual problem. An NES build with a ca65 crt0Path was routed into
  sdasz80, which produced a wall of ASxxxx errors blaming "bundled startup
  code" — the wrong file entirely.
- `build({output:'project'})` applies the chr-ram-runtime preset when a NES
  project ships `nes_runtime.c`, not only when it carries its own crt0/cfg.

### NES example and scaffold fixes

- space-shooter runs at ~56fps (was 29). cc65 compiled `oam_spr`'s four-byte
  body into ~80 instructions and 16 subroutine calls per sprite — the whole
  frame at ~24 sprites, so the loop missed every other NMI and locked to half
  rate. `oam_spr` is now four absolute-indexed stores in `oam_fast.s`, and the
  example's build contract includes that file. The background melody follows:
  it advances per loop iteration, so half rate meant half tempo.
- space-shooter's HUD is visible: it was drawn on tilemap row 0, inside the
  8-scanline overscan band CRTs hide and emulators crop.
- space-shooter scores hits reliably: the shot-vs-alien hitbox was narrower
  than the sprite art it had to hit.
- The shmup scaffold spawns enemies across the whole playfield. `random8() &
  0x7F` capped spawns at x 143 while the ship travels to 240, so a player
  right of centre faced nothing and the score never moved — which made a
  freshly forked scaffold look broken when its collision code was fine.

## 0.111.0 — 2026-07-31

### Active Bezels: the bezel can see the controller

`ab.input()` returned 0 forever. The bezel runtime was constructed without an
`inputManager`, so a package drawing a live controller, an input display or a
button-press indicator could never light up. The game itself was unaffected --
that path goes straight into the core -- which made it look like the bezel was
broken when nothing was. Now wired to the host's `state.inputPorts`, the same
libretro joypad mask the core reads, so the bezel and the game cannot disagree
about what is held.

### playtest no longer dies on a GPU bezel

Opening a playtest window after loading a GPU Active Bezel crashed the whole
server with `X Error BadAccess (GLX X_GLXMakeCurrent)`. A GPU bezel owns a
native-gles EGL context; an accelerated SDL window then calls `glXMakeCurrent`
on the same X display and the two contexts collide. playtest already opened a
software-blit window for HW-render cores (n64/ps1/dreamcast) for exactly this
reason, but the check was `!!host.hwRender` and a bezel is not a core -- an NES
bezel collided just as a Dreamcast core would. The composite reaches the window
as CPU pixels either way, so the software blit costs nothing.

### Fixed

- The Active Bezel integration fixture lives in `test/fixtures/bezel/` instead
  of being resolved out of `active-bezel/examples/diagnostic`. When that
  directory was removed upstream in 0.4.1 the path vanished, the suite's
  `skip: !HAVE_BEZEL` guard fired, and **ten integration tests silently stopped
  running**. A fixture the suite depends on now lives where nothing outside
  this repository can move it, and a missing fixture throws instead of skipping.
- `active-bezel` bumped to `^0.4.1`, which fixes `abtool scaffold` for `js`,
  `python` and `ruby`.

### Active Bezels: what they are, and why romdev runs them

An **Active Bezel** is an executable companion to a specific ROM (a `.ab`
package): it runs once per emulated frame, reads the core's live memory, and
renders the complete final scene — a map, a HUD, reconstructed world graphics —
around or over the game. `loadMedia({useActiveBezel:true})` loads the
same-basename sidecar (`Game.nes` → `Game.ab`) and makes the COMPOSITE the
presented and captured picture. It fails loudly when there is no sidecar rather
than quietly loading the ROM alone; a call without the new parameters behaves
exactly as it always has.

romdev runs these because it is the only consumer that can VERIFY one. A package
can load cleanly, tick without trapping, emit perfectly valid draw commands, and
be completely wrong about the game — an early package for a maze game declared it read
the player's room, X and Y, its readable `main.c` contained room-aware logic, and
the compiled `main.wasm` ignored the room byte entirely and drew fake progress
bars. Unit tests proved it loaded and drew; they proved nothing about meaning.
Catching that needs the raw core framebuffer, the decoded live game state, and
the final composite at the same instant, so:

- `frame({op:'screenshot', source:'composite'|'core'|'both'})` — `'composite'`
  is the default with a bezel attached, `'core'` is the raw emulator picture,
  and `'both'` returns the pair for the SAME frame plus the geometry triple.
- Responses report the three geometries that are easy to conflate: the raw core
  framebuffer, the game's intended display aspect, and the bezel's logical
  scene. Conflating them is how a 4:3 game ends up stretched into a tall
  rectangle.
- `catalog({op:'status'})` and `loadMedia` advertise the running package, so a
  session re-grounding after a restart knows a screenshot is not the core's
  picture before it interprets one.

Lifecycle keeps a package from ever compositing over the wrong game: the bezel
ticks on the STEP path (not only at capture time, so a package with per-frame
state doesn't see a timeline full of holes); `host({op:'unload'/'shutdown'})`
and a plain `loadMedia` detach it (the package is bound to a ROM hash);
`host({op:'reset'})` and `state({op:'load'})` keep it but notify it that
continuity broke, so it drops caches from the abandoned timeline. A guest fault
is recorded in `activeBezel.lastError` and the capture falls back to the core
frame — a broken package never takes down a session mid-investigation.

Development overrides, deliberately not the ordinary path: `activeBezelPath`
(a package elsewhere, unpacked directories included), `activeBezelConfig`
(validated against the manifest's settings schema), `activeBezelForce` (load
despite a ROM-hash mismatch — the composite may be meaningless), and
`activeBezelRenderer:'software'` (pin the deterministic CPU compositor for
golden-frame comparisons). Not supported on `slot:'b'`, which is comparison
scratch and never drives the presented frame.

Adds a dependency on `active-bezel`, which carries the format, the reference
runtime, and the compositor, shared with retroemu.

## 0.109.0 — 2026-07-30

Acts on three rounds of field notes (v0.98.0, v0.103.0, v0.106.1). Every
item was reproduced against the tree before being fixed; every new test was
also run as a CONTROL against the unfixed code, to confirm it can actually
fail.

### cpu({op:'call'}) left the machine unresumable

`callSubroutine`'s setup pushes a sentinel return address onto the GAME's
stack, lowers SP by that width, and overwrites PC. When the callee reaches
its return that unwinds; when the run is CUT SHORT (`stopAtPC`, or a
watchdog stop mid-routine) none of it does — and with `sandbox:false` there
was no restore at all. Reproduced on nestest/fceumm: S dropped `$FD` to
`$0A` and stayed. A reported session saw `$F5` to `$F3` (two bytes of 6502
sentinel), then crashed into RAM when the game's own `pla/pla/rts` popped
garbage.

`returned:false` is precisely the unsafe case. The CPU register file is now
restored when a call doesn't return (`cpuContextRestored:true`), so the
stack goes back while the RAM the routine wrote stays live — reading that is
the whole point of `sandbox:false`.

The repair covers all 15 platforms with a CPU-call profile, and is verified
on all four CPU families that can build a ROM in-test: NES (6502 page
stack), GB (SM83), SMS (Z80) and Genesis (m68k predecrement). The two stack
disciplines leak in OPPOSITE directions, so testing one proves nothing about
the other.

### input({op:'set'}) silently pressed nothing on a wrong shape

The unknown-key guard only fired on keys whose value was literally `true`,
so `{port:0, buttons:['a','b']}` slipped past it AND the `requested` echo:
accepted, nothing pressed. Malformed port objects are now rejected. A silent
no-op here poisons NEGATIVE results — a button-gated branch that "never
fires" when the button was never held reads as a finding about the game.

### watch({on:'mem'}) misreported multi-byte variables

A range was diffed per BYTE with every event carrying the range's label, so
a 16-bit value whose high byte held steady reported as its low byte alone
(`$05F0` read as 240, not 1520) and the constant byte emitted nothing at
all. Adds `as:'u16le'|'u16be'|'u24le'|'u24be'|'u32le'|'u32be'` for one
combined series, plus `byteIndex`/`byteLabel` and a `constantBytes[]` roll
so an un-annotated range stops lying quietly.

A watch armed at an un-cleared breakpoint hit now carries `armedWhileHalted`
on `on:'mem'` as well as `on:'range'` — an empty window from a mid-frame
arming is not a clean negative, and "nothing writes X" is load-bearing.

### accessScan drowned in data banks

A DATA bank decodes as fiction that still boundary-verifies, and on 6502 a
zero-page target hits constantly inside tile data (`C6 C0` is an ordinary
byte pair). Adds `banks`/`excludeBanks`, an always-on `perBank` density
rollup, and a PER-BANK row cap (`maxSitesPerBank`, default 32) — the old
global slice let one flooded bank consume the whole budget and truncate away
the real hits from the code banks.

### Cheats survive a state load

`state({op:'load', reapplyCheats:true})` snapshots active cheats before the
load and re-arms them after. `state({op:'save'})` records them in a
`<path>.cheats.json` SIDECAR so a shared rig describes its own requirements;
the `.state` bytes are unchanged, so every existing state keeps loading.

### Restart recovery

`catalog({op:'status'})` reports `serverPid`/`serverStartedAt`/
`serverUptimeSeconds`, so a session can DETECT that the server restarted
under it. `state({op:'autoSnapshot', enabled:true})` bounds the loss: an
opt-in periodic save, taken lazily on calls already touching the host (no
timer, nothing while idle), into a session-scoped temp dir that can never
clobber a named slot, swallowing its own errors so it can't break the call
it was protecting. `state({op:'recoverSnapshot'})` restores the newest.

### Smaller

- `disasm({target:'source', projectDir})` now routes to the annotated-source
  lookup; previously that spelling still meant the PICO-8-only cart read.
- A legacy `rebuild.json` project is detected by name, and the error no
  longer advises re-running `disasm({target:'project'})` — on an annotated
  project that regenerates the sources and destroys the annotations.
- Parameter aliases across tools: `address`/`cpuAddress` where a memory
  location is meant, bare addresses in `captureMemory`, `path`/`outputPath`
  both ways, `dataHex` for `hex`. Individually trivial; the collection was
  what cost the round trips.

## 0.108.0 — 2026-07-28

Repin `romdev-core-flycast` 0.4.0 — a Dreamcast core with six SH-4
recompiler changes, five of them correctness.

The one that matters most: **a commercial disc that did not boot at all now
runs.** The dispatch-miss path for "block is compiled but not in the dispatch
table" ran the block via the SHIL interpreter and THEN called
`rdv_FailedToFindBlock()`, which does `Sh4cntx.pc = pc` — rewinding pc to the
block just finished so the dispatch loop ran it again. For a block that is a
function prologue, the frame was pushed twice and popped once: the function
returned on a stack 20 bytes low, loaded a local as the return address, and
jumped to garbage.

Also: interrupts unmasked by an SR write are now delivered on the C++/SHIL
execution paths (rec_x64 and the interpreter always did this, the WASM
backend did not); the SMC fingerprint dropped from three scattered byte-pair
reads plus four FNV rounds to two aligned dword loads, on a path that runs on
EVERY dispatch of EVERY RAM block; each block's guest-code pointer is resolved
once at compile time instead of recomputed per dispatch; SH-4 division emits
native WASM i64 div/rem instead of trampolining through an import; and a
conditional whose targets are both in a chain now checks BOTH arms against
ctx.pc rather than assuming the fall-through.

Finally, chaining follows a conditional's fall-through edge, not just its
taken target — mean chain length was ~1.15, i.e. most compiled modules were a
single block. Delayed conditionals (bt.s/bf.s) are excluded: they stash their
condition in ctx.jdyn, which every block in a chain shares through one cached
local, so chaining both of their edges let a later block clobber an earlier
one's pending condition.

Perf is a deliberate trade, bisected commit-by-commit: the chaining change
buys one heavy disc a stable +37% and costs two others ~3-5%. The other five
changes are perf-neutral within measurement noise. Correctness was verified
with a new chain-vs-reference differential (the existing EXECUTOR_MODE 7
shadow forces single-block compilation and is blind to chaining): zero
divergences across 235,753 multi-block comparisons on three discs, with the
single-block control clean at 689,807 comparisons.

## 0.107.5 — 2026-07-28

Repin `romdev-core-host` 0.3.0 and `romdev-core-runner` 0.2.4.

The publish preflight caught real drift: core-host 0.2.1 was already on the
registry with `native-gles`/`webgl-node` as **optionalDependencies**, while
in-tree they had been moved to `dependencies` — the GL-is-required change.
That is an install-behaviour change on a published version, so it takes a
minor bump rather than being force-published over.

core-runner has no content change of its own (its shipped files are identical
to the registry tarball; the in-tree diff is test files, which do not ship).
It is bumped so it can repin core-host — otherwise npm nests the old
core-host@0.2.1 underneath it and the optional/required distinction comes
right back through the transitive path.

## 0.107.4 — 2026-07-28

Repin `wasmcart` ^0.9.1. No code change.

0.9.0 made the Node `CartHost` supply its own GL context, matching what the
browser host started doing in 0.8.0 — the same `load()` call had been
succeeding in a browser and throwing under Node. 0.9.1 adds `getGlContext()`
and fixes the CLI reading a private field that is only set when the host
self-provisions, so a caller-supplied context silently disabled GL readback.

romdev keeps supplying its own factory rather than relying on the new
self-provisioning: it wants ONE 1280x720 context reused for the whole process,
where wasmcart's own default is 640x480 created per load. Its `_gl` tracking
already covers both the host-created and caller-supplied cases, so
`getGlContext()` is not needed here.

## 0.107.3 — 2026-07-28

Repin `wasmcart` ^0.8.0. No code change — romdev already supplies a GL context
unconditionally and never used the `allowMissingGL` opt-out that 0.8.0 removes.

0.8.0 also closes a hole that did affect anyone embedding the browser host:
`CartHostWeb` never got 0.7.0's "GL cart with no context is a load error"
change and still silently stubbed, so the breaking change 0.7.0 announced did
not reach browser consumers. It now supplies its own WebGL2 context.

## 0.107.2 — 2026-07-27

README only. The Dreamcast blurb still said sustained play "hasn't been
characterised", written before the discs were actually driven with a
controller. Testing since then got every disc past its boot/save prompt —
all five take controller input and navigate their menus, and two reach live
in-game scenes with 3D world rendering and a working HUD.

The earlier stall was an input mistake on my side, not an emulator limit:
these DC dialogs confirm on **B**, and only `a` had been tried. Nothing in
the core changed.

Still honestly scoped: *sustained* play (a full level, long-run stability,
framerate in the heaviest scenes) remains uncharacterised, so the platform
is still flagged EXPERIMENTAL.

## 0.107.1 — 2026-07-27

Docs/comment fix, no behaviour change: removes commercial game titles from
everything that ships to npm. The 0.107.0 CHANGELOG named two of them, and
CHANGELOG.md is in the `files` allowlist, so they went out inside the tarball.
Four older instances were caught in the same sweep — comments in
`src/cores/registry.js`, `src/playtest/playtest.js`, `src/cheats/lookup.js`
(which used a real title as its filename-normalization example) and
`romdev-core-host`'s `LibretroHost.js`. The playtest comment also still called
the Dreamcast core interpreter-only, which stopped being true in core 0.3.0.

Verified by scanning the actual `npm pack --dry-run` file list rather than the
working tree — a hand-written grep had already missed one of these.

Repins `romdev-core-host` 0.2.1 and `romdev-core-runner` 0.2.3. core-runner
carries no content change; it is bumped so it can repin core-host, otherwise
npm would nest the old core-host@0.2.0 underneath it and the scrubbed comment
would still ship.

## 0.107.0 — 2026-07-27

Dreamcast gets the WASM SH-4 recompiler: repin `romdev-core-flycast` 0.3.0
(was 0.2.0, the SH-4 interpreter). Commercial GD-ROM titles go from ~16fps —
unplayable — to 70-160fps headless, with AICA (ARM7+DSP) still interpreted at
under ~12% of frame time.

Two correctness fixes landed in the recompiler first; the repin is only safe
because of them:

- **A block could be executed twice.** The dispatch-miss handler for "block is
  compiled but not in the dispatch table" (hash collision or eviction) ran the
  block via the SHIL interpreter and THEN called `rdv_FailedToFindBlock()` to
  restore the table entry — but that function does `Sh4cntx.pc = pc`, so it
  rewound pc to the block just finished and the dispatch loop ran it again.
  Every other backend calls it BEFORE executing, which is why the assignment is
  correct there. For a block that is a function prologue, the frame got pushed
  twice and popped once: the function returned on a stack 20 bytes low, loaded a
  local as PR, and jumped to garbage. That was the commercial-disc boot hang.
- **Interrupts were deferred on `BET_*Intr` block exits.** Those blocks end on an
  SR write, which can unmask an already-pending interrupt; rec_x64 emits
  `GenCall(UpdateINTC)` and the interpreter does `if (UpdateSR()) UpdateINTC();`,
  while the WASM backend did neither. Harmless for natively-dispatched blocks
  (the sync_sr fallback recomputes `interrupt_pend` and the dispatch loop tests
  it every block) but a real gap in the two miss handlers, which ran a block via
  SHIL and fell through with no interrupt check at all.

`build-flycast.sh` now DEFAULTS to the recompiler, so a plain run reproduces the
published core byte-for-byte (verified). `ROMDEV_FLYCAST_INTERP=1` builds the
interpreter instead — the old `ROMDEV_FLYCAST_JIT=1` opt-in is gone, since the
JIT is no longer opt-in. Also adds `test/dreamcast-jit-perf.js`, a perf harness
whose liveness gate judges by the SH-4 block counter rather than the framebuffer
(a static picture means "waiting on input", not "hung" — several discs park on a
save-file prompt with the CPU running fine).

## 0.106.1 — 2026-07-25

FIX (found live by the first real-GL-cart acceptance run): `frame({op:'verify'})`
threw a raw TypeError on EVERY wasmcart and jsgame session — both native
hosts' `screenshotRgba()` returned `{pixels}` where the LibretroHost contract
(and every caller: computeVerify, sideBySide, livestream) destructures
`{rgba}`. Present since the hosts were born; nothing ever exercised verify on
a native-runtime kind until the openarena smoke below. Key renamed to `rgba`;
regression test pins the shape AND runs computeVerify through a real cart.

The acceptance run itself (the throwaway-server MCP flow on the openarena
`.wasc` — the full ioquake3 engine + 409MB of game data): loadMedia reports
`hasGlRendering:true` → 240 frames → `verify` = verified true (73,931
distinct colors, 98.8% non-backdrop) → `frame({op:'screenshot'})` captures a
real in-game 3D frame (terrain, skybox, viewmodel, HUD) → held `up`+`b` via
`input({op:'set'})` moves the camera and the armor counter. Headless GL for
wasmcart is proven end-to-end on a commercial-grade engine.

## 0.106.0 — 2026-07-25

**wasmcart GL carts render HEADLESS** — real GPU pixels in screenshots and
frame hashes, no window, no display. Rides wasmcart 0.6.0's `glBackend`
factory contract: WasmcartHost offers CartHost a lazy factory that CartHost
invokes only when the cart's wasm actually imports from the `gl` module
(the import section is the detection ground truth). The factory serves ONE
process-lifetime offscreen webgl-node WebGL2 context (single native EGL
context, no destroy API — reused across loads; GL state carries over, carts
set their own). After each `stepFrames` call the GL context is read back
(Y-flipped, alpha forced opaque — the hwRender lesson) into the host frame
as RGBA8888, so `frame({op:'screenshot'})`, `frame({op:'verify'})`, and
regression goldens all see the actual draws.

- `status.gl`: `"rendered"` | `"stubbed"` for GL carts, `null` for 2D carts;
  `getCapabilities().hasGlRendering` alongside.
- Degrades honestly: wasmcart < 0.6.0 or missing webgl-node → the old
  stubbed-GL behavior (2D framebuffer only), reported as `"stubbed"`, never
  a load failure. Version-gated by reading wasmcart's package version (its
  exports map hides package.json — resolved next to the entry).
- 720p offscreen ceiling; readback clamps to the drawing buffer. Carts that
  viewport at 0,0 (the norm) read back exactly.
- Tests: wasmcart-gl.test.js (GL clear color read back byte-exact through
  the full host path; 2D carts untouched; hash coverage) — skip-guarded on
  clean clones where the pin is still ^0.5.0.

Release note: the `wasmcart` dependency is ^0.6.0 (lockfile refreshed from
the registry — no manual sync in play); wasmcart 0.6.0 is published, so the
headless-GL path is live for a fresh install. The version gate + test
skip-guards remain as belt-and-braces for downgraded environments.

## 0.105.4 — 2026-07-23

**fps ON the window, for the human** (0.105.3 gave the agent
`playtest({op:'status'}).perf`; this puts it where the player is looking).
romdev-core-runner → 0.2.2 (repinned; new `drawFpsOverlay` export).

- **Title bar always shows live fps** — `"<game> | 60 fps"`, updated once a
  second, in BOTH windows (romdev's playtest and core-runner's runRom, the
  SDK/CLI tier). Zero render cost; it's the fps the machine actually
  achieves, not the target.
- **F3 toggles an on-screen counter** (playtest): green digits on a black
  box, top-left, drawn into the frame right before the blit, sized relative
  to the framebuffer. `drawFpsOverlay()` is pure pixel writes, unit-tested
  (digits render, rest of the frame untouched, bounds-safe on tiny frames,
  clamped 0..999). Keyboard help updated.
- runRom also picked up the reused RGBA conversion buffer from 0.105.3
  (it was still allocating per tick).
- **The agent can drive the counter too**: `playtest({op:'fps', show?})`
  toggles/sets the on-screen counter (same state F3 flips — no separate
  flags to fight over), `playtest({op:'open', fpsOverlay:true})` opens with
  it visible, and op:'status' reports `fpsOverlay` alongside `perf`.
- romdev-xgm2's own 5-test suite was ENOENT-broken since the
  romdev→romdevtools rename (fixture reached into the dead packages/romdev/
  tree; `npm test --workspaces` hid it behind the last workspace's summary).
  Self-contained fixture now; the root `npm test` exit code is the gate.

## 0.105.3 — 2026-07-23

Tests for the 0.105.1 window fix at the level it actually broke, plus the
playtest perf readout ("the window feels slow" is now a number, not a vibe).
romdev-core-runner → 0.2.1 (repinned; new exports).

- **Window sizing extracted + tested.** The initial-size math lived
  duplicated + inline in playtest.js and runRom.js, so nothing unit-tested it
  and the aspect-0 bug hid there. Both now call core-runner's new
  `initialWindowSize()`; playtest-window-sizing.test.js pins the exact wyvern
  repro (1280x720 wasmcart, {scale:2, aspect:'tv'}, host reporting aspect 0 →
  2560x1440, pre-fix 0x1440), a no-zero-window sweep across every
  aspect-mode/platform/bogus-aspect combination, real-cart end-to-end sizing
  from a loaded WasmcartHost, and a plain-language throw on an unsettled 0x0
  framebuffer. jsgame's displayAspect regression rides the real-fixture
  jsgame-host test.
- **Playtest perf telemetry** — `playtest({op:'status'})` now returns `perf`:
  rolling-1s `fps` (emulated frames/sec; 60 = full speed) and `tickHz`
  (render passes/sec), plus per-stage EMAs `stepMs` / `convertMs` /
  `presentMs` and `audioQueuedMs`. Answers "is it slow and WHERE" on a live
  window without touching the machine.
- **Window tick cost cuts** (measured on a 1280x720 wasmcart cart):
  framebuffer→RGBA conversion gets a word-at-a-time swizzle for the two
  32bpp formats and a reusable output buffer (1.83 → 0.69 ms/frame,
  byte-identical, and no more ~220MB/s Buffer.alloc churn at 60fps — GC
  pauses read as window jank); the rewind buffer and auto-checkpoint now
  check the host HAS serializeState (wasmcart/jsgame don't) instead of
  throwing into an empty catch every tick.
- **Workspace contract tests** (test/workspace-contract.test.js): every named
  import from a workspace romdev-* package must resolve against the package's
  real export surface, and every workspace-sibling pin must match the in-tree
  version. Plus a publish-all preflight that refuses to publish when a
  package's content changed but its version already exists on the registry —
  the 0.105.1→0.105.2 miss, now structurally blocked.
- **Three pre-existing drifts the new preflight caught, fixed**:
  romdev-analysis, romdev-analysis-decompiler, and romdev-famitone all
  changed in-tree after their 0.1.0 publishes without a bump — fresh installs
  were getting a decompiler with NO Dreamcast SH-4 SLEIGH, an analysis
  package predating the core-wasm de-dup, and famitone without the lint-bug
  fixes, while the monorepo tested the current code. All three → 0.2.0,
  repinned.

## 0.105.2 — 2026-07-23

FIX (release mechanics of the 0.105.1 fix): 0.105.1 added the
`effectiveAspect` export to romdev-core-runner's present.js WITHOUT bumping
that package's version, and romdevtools pins the runner exactly. A fresh
install therefore paired romdevtools 0.105.1 with the registry's
romdev-core-runner 0.1.1 (which predates the export), and opening the
playtest window failed with "romdev-core-runner does not provide an export
named effectiveAspect". Monorepo/workspace checkouts never saw it (the
workspace copy links in-tree). Now: **romdev-core-runner 0.2.0** published
with the export, romdevtools repinned to it. No code changes beyond the
version/pin; the 0.105.1 window fix itself was correct.

## 0.105.1 — 2026-07-23

FIX: the playtest window zero-sized itself for wasmcart/jsgame carts: SDL
threw "invalid width" and the tool misreported it as "SDL initialized but
couldn't get a display". Root cause: `WasmcartHost`/`JsGameHost` left
`status.displayAspect` at its 0 init forever, every window-sizing site used
`displayAspect ?? fbW/fbH` (nullish coalescing keeps the 0), `tvAspectFor`'s
unknown-platform default returned it verbatim, and the window opened at
`width = round(height * 0) = 0`. Not OS-specific; it first tripped on macOS
only because that is where a wasmcart cart first met the playtest window.

- Both native hosts now report the real framebuffer ratio once dimensions
  settle (cart pixels are square, so aspect = fbWidth/fbHeight), kept current
  on resolution changes.
- New `effectiveAspect(statusAspect, fbW, fbH)` guard in romdev-core-runner's
  present.js, used at all six sizing/letterbox sites (playtest.js and
  runRom.js); `tvAspectFor`'s default now refuses non-finite/non-positive
  values instead of passing them through.
- The playtest tool's catch-all SDL error no longer asserts a display/desktop
  problem for arbitrary errors: the desktop-session advice appears only when
  the SDL message actually names a display/driver failure, otherwise the
  quoted SDL error itself is presented as the fault to report.
- Tests: present-aspect-guard.test.js (tvAspectFor/effectiveAspect truth
  table) plus a real-cart displayAspect regression in
  wasmcart-real-cart.test.js.

## 0.105.0 — 2026-07-23

**wasmcart harness, the rest of the plan — deterministic replay, debug events,
positioning, and the dogfood proof** (WS3 Parts B+C, WS5, WS6 of
internal-romdev/WASMCART_UMBRELLA_PLAN.md). Consumes wasmcart 0.5.0 (spec-side:
`WC_FLAG_DETERMINISTIC` + `wc_set_seed` + `WC_DETERMINISTIC_RNG`;
`wc_debug_mark` + captured `wc_log`; both opt-in, default structurally absent).
Feature-detected — inert on wasmcart 0.4.0. **Depends on `wasmcart` ^0.5.0**
(repinned at release; wasmcart 0.5.0 is live on npm).

- **Deterministic replay** — `loadMedia({deterministicSeed})` (wasmcart only;
  refused with a pointer on emulator platforms, which are already deterministic
  from power-on): fixed virtual clock + the u32 seed delivered to the cart's
  `wc_set_seed` BEFORE `wc_init`. Same seed + same input script = an identical
  frame sequence on carts that declare `WC_FLAG_DETERMINISTIC` (surfaced as
  `capabilities.hasDeterministic`, `status.deterministicSeed`). Requesting it
  on a pre-0.5.0 wasmcart install refuses loudly instead of handing back a
  silently-unseeded run.
- **Regression goldens are seed-aware** — `regression({op:'capture'})` stamps
  the session's `deterministicSeed` into the golden; `op:'check'` under a
  different seed fails FAST with the exact reload remedy instead of reporting
  the mismatch as frame-hash noise. With a seed, frameHash checkpoints are
  airtight (proven across fresh loads in tests and live).
- **`wasm({op:'events'})`** — drain the frame-stamped debug event trace:
  `wc_debug_mark(id)` annotations and captured `wc_log` lines, the navigable
  timeline of a run. Pull-model, clears on read; says so plainly on a
  pre-events wasmcart build.
- **`input({op:'pointer'})`** — absolute pointer for wasmcart carts that declare
  `WC_FLAG_POINTER`: position the cursor at an exact `{x, y}` (cart pixels) and
  hold `left`/`right`. Drives mouse-UI carts a gamepad-button vocabulary can't
  reach — `WasmcartHost.setInput({pointer})` → `CartHost.setPointer`. Refuses on
  emulator platforms (no pointer surface). Exercised end-to-end driving the
  Stratagus RTS cart's menus through the live MCP server.
- **Conformance grows determinism checks** — `WC_FLAG_DETERMINISTIC` without
  `wc_set_seed` is an error (declared but unseedable); the export without the
  flag is a self-policing warn.
- **FIX: 0 Hz WAV headers** — `audioDebug({op:'record'})` used `?? 48000` for
  the fallback rate, which let a wasmcart cart's declared 0 ("host decides")
  through as an unplayable 0 Hz WAV header. Now `|| 48000`. Caught by the
  dogfood run below.
- **Vendored `test/fixtures/detrng.wasc`** (+ source/rebuild recipe): RNG-noise
  render + marks + debug fields. 7 new consumer tests (replay identity across
  loads, seed divergence, caps/status surfacing, events drain, conformance,
  airtight golden, seed-mismatch refusal, WAV rate) — skip-guarded so a clean
  clone on wasmcart 0.4.0 stays green.
- **WS6 dogfood shipped** — `rom-games/wasmcart/starfall/`: a real game
  (deterministic spawns, named state, marks, audio, input) developed and
  verified END-TO-END through the live MCP server: seeded load → conformance
  → screenshot → input-driven `player_x` by name → non-silent audio record →
  events timeline → regression capture/check bit-exact across fresh loads →
  wrong-seed refusal. Its README documents the loop.
- **WS5 positioning** — wasmcart repo gains `docs/positioning.md` (ship the
  artifact you debugged; native backends optional with fidelity risk contained;
  observability by construction); this README's wasmcart paragraph updated to
  the full surface.

Release note: the `wasmcart` dependency is now ^0.5.0 (lockfile refreshed) —
wasmcart 0.5.0 is published, so every determinism/events/pointer feature is
live for a fresh install rather than feature-detected-inert.

## 0.104.0 — 2026-07-23

**wasmcart harness, Slice 1 — the sense loop + conformance** (internal-romdev/
WASMCART_UMBRELLA_PLAN.md WS1+WS2). romdev is the run/debug/validate harness
for wasmcart carts, NOT an SDK — it starts at the `.wasc` the developer's own
toolchain produced. This slice makes the WASM-runtime introspection WasmcartHost
already had reachable, and gives the agent EARS to go with its eyes:

- **Audio capture** — `audioDebug({op:'record'})` now works on a wasmcart
  session. WasmcartHost accumulates each `CartHost.runFrame().audio` (Int16 or
  Float32, normalized to Int16) into the `state.audioRing` the record op drains,
  and sets `status.audioSampleRate` from the cart's WCInfo. The agent verifies
  "did the jump sound play" headlessly, the same way it verifies the frame.
- **New `wasm` tool** — introspection an emulator can't offer, gated on
  `hasWasmIntrospection` and refusing symmetrically on a libretro host:
  - `op:'conformance'` — the "won't load / loaded but wrong, WHY?" verdict:
    required exports (wc_get_info/wc_init/wc_render) present? manifest abi vs the
    running instance? declared resolution vs actual? manifest shape? →
    `{conforms, issues[]}`, each issue naming the fix. The wasmcart analogue of
    iNES-header validation; the one failure an agent can't diagnose from source.
  - `op:'info'/'exports'` (+ `abiComplete`), `op:'read'/'write'` over the cart
    heap (raw byte offset; shared hex cleaner), `op:'save'`.
- **`catalog({op:'status'})`** surfaces the wasmcart facts (kind,
  wasmIntrospection, wasmMemoryBytes, wasmExportCount, audioCapture) so an agent
  picks the right tools without probing by failure.
- **Fix**: WasmcartHost was missing `getStatus()`, which `catalog({op:'status'})`
  calls host-kind-agnostically — status crashed on any wasmcart session (caught
  by the new live smoke; regression-tested).
- Shared `parseHexBytes` factored out of memory.js so `memory({op:'write'})` and
  `wasm({op:'write'})` clean/validate hex identically.

- **Named debug state (wasmcart debug ABI consumer).** WasmcartHost gains
  feature-detected `readDebugState`/`readDebugValue`/`writeDebugValue`
  passthroughs (like setFixedStep — present only when the wasmcart build has the
  debug ABI). The `wasm` tool gains `op:'debugState'` (dump the cart's opt-in
  named fields with values) and `read`/`write` by `name` (resolve a debug field
  to offset+type, read/write DECODED — the source-level view vs. a raw offset).
  `conformance` now checks debug-ABI consistency (FLAG_DEBUG set but no
  wc_debug_state export = error; export without the flag = warn). Capability
  `hasDebugState` added. The wasmcart SIDE (FLAG_DEBUG, wc_debug_state, the
  WC_DEBUG_FIELDS SDK macro, default-off governing rule) is committed in the
  wasmcart repo (part of ABI 3 — no version bump, pre-1.0/no external users);
  romdev consumes it once that publishes + repins. Until then the named-debug
  ops feature-detect and stay inert against the pinned wasmcart@0.3.0.

- **Checkpoint-based regression harness (`regression` tool).** Prove a change
  didn't break a game: `op:'capture'` runs an input script and records
  observations at checkpoint frames into a golden JSON; `op:'check'` re-runs and
  diffs → {passed, diffs[]}. Host-kind-agnostic (emulators AND wasmcart).
  REPLAYS FROM THE LOADED STATE (no per-frame savestate) so it scales to ANY
  cart size — the scale-analysis answer to "full-frame replay is impractical for
  multi-GB carts". Observations: 'frameHash' (framebuffer fingerprint;
  reproducible only on a deterministic cart), 'debug' (wasmcart NAMED debug
  state — the size-independent, deterministic path: 'at frame 600, hp==3' costs
  the same at 128KB or 2GB), 'memory' (emulator regions). WasmcartHost gained a
  strided `framebufferHash()` (fast on 1080p+ GL carts, deterministic). Verified
  live through MCP: capture → reload → check passes on hello.wasc.

The wasmcart named-debug ops (read/write by name) go fully live once the
wasmcart debug ABI publishes + romdev repins; until then they feature-detect
and the regression harness's 'debug' checkpoints require that build. 'frameHash'
and 'memory' checkpoints work today on every host.

- **wasmcart repinned to ^0.4.0** — the debug ABI published, so the named-debug
  ops and 'debug' regression checkpoints above are LIVE, not inert.

- **FIX: input never reached wasmcart carts.** `WasmcartHost._padFromInput`
  emitted named 0/1 button fields, but `CartHost._writePads` expects
  `{connected, buttons: <BUTTON bitmask>, leftX..rightTrigger}` and ZEROES any
  pad without `connected` — so every romdev `input`/`setInput` call read as a
  disconnected pad. Pads now translate to the real shape (bitmask from
  wasmcart's exported BUTTON map, analog + trigger passthrough) and pad 0 is
  connected-idle from load, like a libretro port. Caught by the first REAL-cart
  input test: the mock-host suite stayed green through the whole bug. New
  `test/fixtures/dbghello.wasc` (hello + WC_DEBUG_FIELDS, source + rebuild
  recipe alongside) now covers input, named debug state, and regression
  capture/check against an actual compiled cart.

## 0.103.0 — 2026-07-19

**v0.98.0 feedback batch** (from a NES annotation session, shared late — the
increments predate 0.99.0 but the asks were still open):

- **`disasm({target:'sourceLookup', projectDir, startAddress, endAddress?})`**
  (headline) — show YOUR OWN annotated project source for a CPU address, the
  most-repeated navigation op in an annotation session. Reads the project's
  `.asm`/`.s` files and returns the lines whose trailing address comment
  (`; E4DB 20 E4 D2`, what `disasm({target:'project'})` emits) falls in
  range, with context, annotations intact. Replaces the hand-built
  nibble-class grep over a 7000-line bank file (which silently truncates on
  a missed nibble class and pulls in false hits from data tables). Merges
  contiguous hits into blocks; explains an empty result (no address comments
  vs. address-not-in-range).
- **`memory({op:'write'})` hex cleaning** — spaces/underscores/`$` are now
  stripped before validation (an embedded space no longer trips the
  odd-length check), and the errors name the real cause: a bad character is
  quoted, an odd count is reported "after stripping separators … a byte is
  two hex chars" instead of a bare "even length" message that sent the
  caller re-counting nibbles.
- **`watch` armed-while-halted flag** — arming a range watch while the CPU
  sits at an un-cleared breakpoint hit misses everything already executed in
  the broken frame, and an empty result then reads as a clean negative
  (load-bearing evidence in RE). The result now carries
  `armedWhileHalted:true` + guidance when armed from that state; a
  `fromState` restore re-anchors execution so it's correctly not flagged
  there. Schema warning added.

## 0.102.0 — 2026-07-19

**The RE round, part 2** — the two remaining mechanizable recipes from the
same field workflow 0.101.0 distilled:

- **Save-state liveness probe** — `state({op:'load'})` now verifies the
  restored state is LIVE: step 4 frames, check the PC moves / framebuffer
  changes, then RE-RESTORE the exact state (net-zero side effects). A state
  captured mid-pause/transition has its dispatchers stopped, and everything
  watched from it looks dead — the `liveness` field says so up front with
  the re-save guidance, instead of costing a session the discovery.
  `probeLiveness:false` skips it for frame-exact flows.
- **`autoNarrow` on range censuses** — a truncated census can support a
  positive but never a NEGATIVE claim (the dropped rows are exactly what
  could overturn "nothing else touches this"). With `autoNarrow:true` and a
  `fromState`/`fromStatePath` anchor, `watch({on:'range'})` halves `frames`
  and re-runs deterministically until the log fits (max 5 halvings, floor
  8), reporting `autoNarrowed:{attempts, framesRequested, framesUsed,
  complete}` so the annotation can state the census was complete. Without
  the anchor it refuses to pretend (re-runs would drift) and says why.

Deliberately NOT added: routine attribution on single breakpoint hits (a
hit is one PC you're about to disassemble anyway — the census rollup from
0.101.0 is where routine units pay); producer enumeration for a VALUE
(immediate scans structurally miss table-driven writers — that's dataflow,
which is what the live census IS; the caveat stays in the docs).

## 0.101.0 — 2026-07-18

**The RE round: four capabilities distilled from a field agent's annotation
workflow** (each one replaces a recipe that had to be executed by hand, and
documented in prose, every time):

- **`disasm({target:'accessScan', address})`** — bound every instruction that
  can REACH a RAM byte. Direct operands PLUS indexed forms whose base sits
  within `window` below the target or at its page base (the store scan's
  structural blind spot: an `sta base,y` never names `base+k`), classified
  read/write/rmw/pointerLoad with the index offset needed. Z80/SM83/m68k
  report the pointer LOADS that take the address (register-based access is
  statically invisible; the result says so). 13 platforms; literal-pool ISAs
  (GBA) refuse with the live-tool pointer. Instruction-boundary verification
  is inherited from the per-bank disassembly, not byte-pattern matching.
- **`disasm({target:'script', grammar})`** — decode a data region as custom
  bytecode from a declarative grammar (level/map scripts, spawn lists,
  cutscene streams, music macros). Per-opcode field lists with
  flag-conditional presence + implied defaults, counted and terminator-ended
  lists, stop/chain commands, record prefix fields. The grammar rides in the
  call, so a verified script format is re-decodable by any future session
  instead of living in a side decoder script. Platform-agnostic;
  bounds-checked; machine-readable stop reasons.
- **Phantom-read flagging** — a `watch({on:'range', kind:'read'})` census on
  the 6502 family now decodes the instruction at each reporting PC from the
  cart image: an indexed WRITE/RMW whose operand base is outside the range is
  flagged `phantomRead` with its `storeBase` — the CPU's dummy-read cycle
  landed in the range, but the program never reads those bytes there. Stops
  bus artifacts being written up as consumers.
- **Routine grouping** — pass `dbg`/`dbgPath` (cc65) or `map`/`mapPath`
  (sdld/GNU ld) to `watch({on:'range'})` and every byPC row carries
  `routine` (nearest preceding symbol) plus a `byRoutine` rollup, so
  censuses compare across sessions in ROUTINE units (an RMW logs two PCs in
  one routine; raw PC counts read as false disagreements).

## 0.100.0 — 2026-07-18

**romdev-core-host goes ISOMORPHIC** (ROMDEV_CORE_RUNNER_PLAN Phase 2 / §6b,
repinned here as `romdev-core-host@0.2.0` + `romdev-core-runner@0.1.1`):

- The core's static import closure (LibretroHost, coreLoader, callbacks,
  framebuffer, types, constants, gamegenie, cpu-state) now has ZERO top-level
  `node:` imports and no pngjs, enforced by an extension of the
  browser-surface-imports gate. Node I/O moved to a lazy adapter
  (`romdev-core-host/io-node.js`) loaded only on path-based code paths.
- New isomorphic entry points: `loadCore({ factory, wasmBinary })` runs a
  core from the glue's default export + wasm bytes (no disk);
  `loadMedia({ bytes })` was already byte-capable; new
  `loadMedia({ systemFiles })` mounts an in-memory BIOS tree (the browser
  alternative to a host-disk systemDir). `loadCore({ io: false })` forces
  the pure contract even under Node.
- PNG encode/crop/resample split to `romdev-core-host/framebuffer-png.js`
  (pngjs drags node:zlib); `framebuffer.js` keeps the pure typed-array
  converters and newly exports `decodePixelsInto` for direct canvas blits.
  `screenshot()` preloads the encoder at loadCore and degrades to a
  descriptive error pointing at `screenshotRgba()` where it can't load.
  BREAKING (pre-1.0): `framebufferToPng` / `framebufferToScreenshot` are no
  longer re-exported from the core-host index; import the subpath.
- Buffer usage in the core surface replaced with TextEncoder-based
  `encodeCString` (pure-util.js, also exported).
- Node behavior is byte-identical: the new `core-host-pure-e2e` gate runs
  the same ROM through the path-based host and a `{ io: false }` bytes-only
  host and asserts identical framebuffer hash, RAM, and frame count.
- Zero romdevtools tool-surface changes; importers repointed to the new
  subpaths only.

## 0.99.0 — 2026-07-18

**The host + runner extraction** (internal-romdev/ROMDEV_CORE_RUNNER_PLAN.md
Phase 1; MODULARITY.md item 4's trigger fired — six SDK run bridges + the web
IDEs are the consumers):

- **New package `romdev-core-host`** — the libretro host runtime
  (`LibretroHost`, coreLoader, callbacks, framebuffer codecs, retro
  constants, every per-chip audio/CPU-state decoder, the GL bridge, and the
  Game Genie decoder) published standalone. This is the SAME host the MCP
  server runs — romdevtools now consumes it as a dependency, so there is
  exactly ONE host implementation. Bundles no cores. The two non-libretro
  host variants (JsGameHost/WasmcartHost) stay in romdevtools so the SDK
  dep tree doesn't drag rungame/wasmcart.
- **New package `romdev-core-runner`** — the human "fire it up" tier:
  `runRom(rom, {core, buttonMap, keyMap, scale, title, aspect})` opens an
  SDL window over romdev-core-host with keyboard + hot-plug gamepad input,
  audio at the core's native rate, and aspect-correct pixel-perfect
  scaling. Carries the playtest window's SDL hardening VERBATIM (`initSdl`:
  missing-native-binary self-repair, the failed-import-cache workaround,
  offscreen-driver detection) and throws a structured
  `{code:"SDL_UNAVAILABLE", sdlKind, fixCmd}` — never a module-load crash;
  `@kmamal/sdl` is an optionalDependency declared ONCE here. Deliberately
  NO agent surface (checkpoints/rewind/live-host-follow stay in playtest).
- **playtest.js folded onto the runner's shared pieces**: initSdl (with the
  romdev-specific no-display guidance preserved verbatim at the tool
  surface), the SDL-button/keyboard → RetroPad maps, letterbox, tvAspectFor,
  bitToName, and the framebuffer→RGBA blit now come from romdev-core-runner
  — the duplicated copies are deleted. playtest keeps the agent tier:
  live-host follow, auto-checkpoints, rewind, human co-drive detection,
  audio-paced stepping, the C64/N64 layouts.
- Tests: SDL-absent contract (structured failure with SDL missing, mocked;
  offscreen-driver detection) + the moved host unit tests.

The SDK folds (gtlua/mdlua/neslua/c64lua/gbalua → ~15-line `runRom` shims)
are the SDK repos' follow-up; this release is the romdev-side extraction
they consume.

## 0.98.0 — 2026-07-17

Cross-platform generalization of the 0.96.0/0.97.0 feedback fixes ("fixes
that go across systems get done for all systems"):

- **Mirror canonicalization for EVERY mirror platform**, not just SNES:
  arming a watch (write/read/range) on an alias form now canonicalizes on
  NES ($0800-$1FFF → $0000-$07FF), GB/GBC (echo $E000-$FDFF → $C000-$DDFF),
  SMS/GG ($E000-$FFFB → $C000-$DFFB; mapper regs untouched), and Genesis
  ($E00000-$FEFFFF → $FF0000|offset). Only unambiguous mirror windows are
  touched — nothing that could alias ROM/regs (a Genesis read-watch on a
  cart table at $000218 stays literal). Verified live on gpgx: arming the
  $E2-mirror form catches the canonical $FF-form writer.
  ⚠ Residual, stated honestly: snes9x is the only core whose hooks
  canonicalize LIVE accesses, so on the other platforms a WRITER that itself
  uses a mirror form still evades the watch. Fixing that direction needs
  per-core hook patches + core rebuilds — deferred until it bites someone.
- **`conditionWidth:16` is endianness-aware.** Genesis 68k words are
  BIG-endian, so 'equals' now arms the word's high byte AT `address` there
  (not address+1, which is the LOW byte on 68k and was wrong in 0.96.0) and
  the host-side word compare composes big-endian. Verified live on gpgx
  (a `move.w #$2000` write caught with exact PC). GBA gained proper
  EWRAM/IWRAM mapping for the host-side reads too.
- **`readCart` `findHex` maps GB/GBC (MBC $4000 window) and SMS/GG
  (Sega-mapper slot 2)** hits to bank + CPU address, alongside the existing
  NES/SNES/flat mappings.

Not applicable elsewhere, for the record: the 65816 M/X width dataflow and
`widths:{a,i}` override are width-state concepts only 65816 has (GBA's
analog — ARM/Thumb mode mixing — already has the per-window `thumb` flag;
full mode-tracking disasm remains the known deferred item), and the
reassemble `issues[]` fix was already platform-generic.

## 0.97.0 — 2026-07-17

v0.94.0 feedback round 2 (the SNES annotation agent's 20:51 + 00:40 notes).

**Bug fix — SNES WRAM mirror aliasing in exact watchpoints.** Watching
`$0218` silently missed a `sta f:$7E0218` writer (and vice-versa forms): the
snes9x hook canonicalizes every LIVE access to the $7E form, so the host now
canonicalizes the ARMED address too — write watch, read watch, AND the range
watch (whose [lo,hi] had the same hole). Any addressing form of a low-WRAM
byte (`sta $18` DP, `sta $0218` absolute in banks $00-$3F/$80-$BF,
`sta f:$7E0218` long) is caught from any armed form. Results echo
`armedAddress` when canonicalization applied. Verified against the real core
(the previously-missing raw form now reports the exact writer PC). No core
rebuild — host-side fix.

**Minor fix — `disasm({target:'rom'})` outputPath** creates its parent
directory instead of raw ENOENT.

**Reassemble failures are structured now** (the hottest annotation call):
`regions[].issues[]` per the standard {file,line,message} contract, ANSI
color codes stripped, and the internal `main.s` remapped to the region's
REAL source file with line numbers shifted past any auto-prepended
`.setcpu`/`.org` — so the error points at the file you actually edit.

**`disasm({target:'rom'}) widths:{a,i}`** — explicit 65816 entry-width
override (8|16 each). For a blob with no in-window caller the agent often
KNOWS the width (live P capture, surrounding code); the override skips
inference and decodes at the stated entry (in-window rep/sep still
followed). The forced-width decode replaces hand-decoding from byte columns.

**`memory({op:'readCart', findHex})`** — byte-pattern scan over the loaded
cart image ('20 3C 87' finds every `jsr $873C`), each match mapped to a CPU
address server-side (NES bank + $8000/$C000 window; SNES LoROM/HiROM
bank:addr). The call-site hunt without a Python side-script.

**`frame({op:'screenshot', crop:{x,y,w,h}})`** — native-res crop before any
scale (composable with integer scale for a detail view). The HUD-
verification token-saver: poke a value → crop-read the counter in one call.

**Doc/hint nudges:** the memory-search "0 left" note suggests re-seeding
`as:'bcd'` (BCD-stored counters); the screenshot `scale` docs warn that
sub-native scales are illegible for text (use native + crop); the per-byte
read-watch miss note points table-consumer hunts at
`watch({on:'range', kind:'read'})`, which already answers "who reads any
byte of this struct?" in one call.

## 0.96.0 — 2026-07-16

v0.94.0 feedback round (the SNES annotation agent's two notes files — no bugs
reported, three asks):

- **`disasm({target:'rom'})` now runs the 0.94.0 per-instruction M/X width
  dataflow on 65816** — the same widthRanges walk as `target:'project'`:
  in-window `rep`/`sep` are followed (width-homogeneous ADDRMODE ranges, so a
  16-bit immediate decodes full-width even when the `rep` that set it is
  several instructions back) and the ENTRY width is inferred (8/8 first, then
  the other three scored by desync symptoms). The tool description says so.
  This makes "re-decode one range under corrected widths" a single call — no
  project regeneration that would discard hand-maintained annotations.
- **`breakpoint({on:'write'})` gains `conditionWidth: 16`** (auto-inferred
  when `conditionValue > 255`): `condition:'equals'` arms the core watch on
  the HIGH byte (address+1) with the value's high byte — no more useless
  $00-low-byte matches on constants like $2000 — and verifies the low byte
  host-side so the hit means the WORD equals the target. `'increase'`/
  `'decrease'` compare the word host-side each frame (an unconditioned core
  watch supplies the writer PC), so a 16-bit counter's carry can't lie the
  way a byte-level delta does. Results carry `valueWord`/`oldValueWord`/
  `watchedByte`; `conditionValue`'s schema now allows 0-65535.
- **`memory({op:'read', offsets, compact:true})`** returns the batch as ONE
  `{"0xOFF": "hex"}` map (~4x fewer tokens for the sample-N-flags pattern).

## 0.95.0 — 2026-07-16

The GBA + Genesis build pipelines are now standalone: their SDK library trees
AND build drivers live in the binary packages, with stable public entries, and
the whole pipeline runs in a non-node host (browser Web Worker) through an
injected environment. An SDK built on either target deps ONE package and zero
romdevtools.

**Share trees moved into the binary packages**
- `src/platforms/gba/lib/` → `romdev-platform-gba/share/gba/lib/` (libtonc,
  libgba, maxmod, sysbase, crt0s, ld scripts, arm target archives).
- `src/platforms/genesis/lib/` → `romdev-toolchain-m68k-gcc/share/genesis/lib/`
  (full SGDK tree + the minimal `c/` runtime).
- Both packages export `shareDir`. Templates' `lib/...` references unchanged
  (the inner layout is preserved). Build scripts/docs/tests repointed.

**Stable public build entries (drivers moved INTO the packages)**
- `import { buildGbaC, parseBuildLog } from "romdev-platform-gba"`.
- `import { buildGenesisC, finalizeGenesisRom, runSjasm, runBintos,
  parseBuildLog } from "romdev-toolchain-m68k-gcc"`.
- romdevtools itself now builds GBA/Genesis through these entries — one
  pipeline, no fork. The shared tool-running kit is vendored byte-identical in
  each package's `build/` (romdevtools' `src/toolchains` is canonical; a
  parity test fails the suite on drift, `scripts/sync-build-kit.sh` re-syncs).
- The old deep-import paths (`src/toolchains/gba-c/`, `genesis-c/`, `sjasm/`)
  no longer exist.

**Env-injectable tool running (the browser-IDE seam)**
- `buildGbaC({..., env})` / `buildGenesisC({..., env})`: `env.runTool` carries
  a logical ToolJob (`{tool, glueFile, pkg, argv, inputFiles, outputFiles}`)
  and the host owns WASM instantiation + MEMFS; `env.share` supplies the
  share tree as a `{relPath: bytes|text}` manifest (stage with
  `buildShareManifest` — key order matters: it feeds compile order → ar
  member order → ROM bytes); `env.hash` + `env.sdkCache` cover the SDK seed
  check + rebuild cache; `env.loadGlue` covers sjasm/bintos on Genesis.
- No node builtin in the pipeline's static import closure (test-enforced);
  node defaults load lazily. An injected-env build is sha256-identical to the
  node path (test-enforced). Browsers need only a Buffer shim (ar packer).
- Pure marshalling moved to `common/io.js`; `common/share-fs.js` is the new
  share seam; `makeGccToolchain(config, env)` + `makeArmGccTools(env)` /
  `makeM68kGccTools(env)` / `makeZ80Tools(env)` factories.

**Fixes**
- SDK seed hashes were keyed on ABSOLUTE source paths, so any tree move (or
  another machine) made every GBA/Genesis build report a false
  `sdkEditIgnored`. Hash keys are share-relative now; seeds regenerated.
- The staged gametank core wasm had been overwritten by a build without the
  romdev debug instrumentation (Game Genie/cheat exports missing). Rebuilt
  with `scripts/build-gametank.sh`; `romdev-core-gametank` 0.4.0, repinned.

**Packages:** romdevtools 0.95.0, romdev-platform-gba 0.11.0,
romdev-toolchain-m68k-gcc 0.3.0, romdev-core-gametank 0.4.0.

## 0.94.0 — 2026-07-16

Follow-up to the 0.93.0 SNES readability fix, from a fresh annotation session.
0.93.0 stopped the `.byte` floor but left two quality gaps; both are fixed, plus
two token-efficiency wins.

**65816 readability — full M/X dataflow + coverage pass**
- **Per-instruction M/X width tracking (full dataflow).** da65's info-file
  `ADDRMODE` is a fixed ENTRY seed — it doesn't follow an in-stream `rep #$30` /
  `sep #$20`, so a 16-bit immediate after a width change decoded one byte short
  (`lda #$0000` read as `lda #$00` + a spurious `brk`) and desynced the routine.
  Each span is now LINEAR-WALKED with a real 65816 length decoder (base-length
  table derived from da65 + the exact width-dependent immediate set) that tracks
  M/X per instruction and splits the span into maximal width-homogeneous ranges;
  a single da65 call seeds every range to its true `ADDRMODE`. So `and #$00FF`,
  `ldx #$0000`, `lda #$1234` etc. decode at full width even when the `rep` that
  set it was several instructions back — with correct `.a8/.a16/.i8/.i16`.
- **Entry-width inference.** A function entered in 16-bit mode from its caller
  (no leading `rep`/`sep` to re-sync) had the wrong opening width. Each span now
  tries the candidate entry widths and keeps the one with the fewest misdecode
  symptoms (stray `brk`/`cop`/`wdm` — the desync fingerprint). Bank0's `brk`
  misdecodes dropped ~3× on the reference cart.
- **Reachable code the analysis engine missed is now recovered — across the
  whole cc65 family (not just SNES).** A small gap sandwiched between two code
  spans is very likely a routine entered only via a branch (a dispatch loop
  branched into, never `call`ed) — the analysis engine's function detection skips
  it, so it used to fall out as a `.byte` blob. Such gaps (≤1KB, code on both
  sides) are decoded speculatively and KEPT when they round-trip byte-exact; a
  data gap floors back to `.byte`. This now runs for **every cc65-family platform**
  — 6502 (nes/c64/atari/pce/lynx/gametank) as well as 65816 (snes). Bulk/leading/
  trailing data is left as `.byte` un-probed (fast). Byte-exactness holds
  throughout. (The M/X width machinery above is 65816-only — the 6502 cores have
  no width state. The GNU-toolchain families — m68k/z80/sm83/arm — deliberately
  do NOT use a code-span map: objdump does a full linear sweep and already
  decodes every byte, so a span map would only degrade them by `.byte`-ing
  correctly-decoded gaps.)
- **`readablePercent` is honest.** Measured over the identified code spans only;
  a speculatively-probed gap that floored to `.byte` no longer inflates the
  denominator, and the width fixes remove the "high % but misleading stream"
  case. A 100% bank is now trustworthy.

Net on the reference 1MB LoROM cart: byte-identical end-to-end, ~75% average
disassembled as instructions (100% on code banks), ~43s.

**`breakpoint({on:'pc'})` miss now reports the main thread**
- On a miss, the frame-boundary `pcNow` almost always lands on the NMI/idle
  handler — useless for "where was the code I'm hunting." The response now also
  carries **`mainThreadPc`** (the busiest PC over ~a frame of single-stepping —
  the main loop) plus a `pcHistogram` of the top PCs by hit count. The sampling
  is save-state-wrapped, so it has **zero side effects** (the emulator is
  restored, frame counter included).

**Token efficiency**
- **`symbols({op:'analyze'})` gained `summary:true` and `topN`.** The full
  function+string table is ~44K chars on a 1MB ROM (it overflowed the tool-result
  limit and spilled to a file). `summary:true` returns counts + entrypoints + the
  top functions (by size, then callers) + a few sample strings (~2.5K chars) —
  the slice the disassemble workflow actually extracts. `topN` bounds the full
  list.
- **`frame({op:'stepInstructions', stepFormat:'compact'})`.** A triage trace's
  signal is "which loop is the CPU in"; the default per-step objects are ~90%
  padding for that. `compact` returns one string per step (`$PC flow->$target`)
  plus a `pcRanges` loop-map with hit counts.

## 0.93.0 — 2026-07-16

**The 65816 (SNES) data-only readability floor is fixed.** `disasm({target:'project'})` on a SNES
cart used to produce byte-exact but **0%-readable** output — every instruction floored to `.byte`, so
the whole workflow was carving routines out of a data wall by hand. It now disassembles the real code
as instructions: a full 1MB LoROM cart round-trips **byte-identical** at **~68% average
instructions** (100% on pure-code banks; data banks correctly stay `.byte`) in **~30s**.

Three compounding root causes, all fixed:
- **The byte-capture regex matched zero code lines.** da65's `--comments 4` appends a right-aligned
  ASCII gutter after the byte hex (`sei ; 8000 78    x`); the heal loop's regex anchored the byte
  group to end-of-line, so it recognized **no** code → couldn't tell code from data → floored the
  region. The regex now stops at the gutter gap. (This alone was the whole 0% floor.)
- **Cross-span width desync.** A single whole-region da65 pass let one function's `.a8/.i8` width
  state leak across a data gap into the next function, mis-sizing its operands and cascading. The
  65816 path now disassembles each code span **independently** (re-seeding width per span) and dumps
  the gaps as `.byte`, so nothing desyncs.
- **Unbounded heal on mis-classified data.** A data blob the analysis engine over-claimed as a
  function used to grind one `.byte` pin per re-assembly. Each span now bails to a clean `.byte` dump
  once too many lines pin (it isn't readable code anyway) — turning a multi-minute grind into seconds.

Supporting changes: da65 gained a per-span code-map info file (`TYPE Code` RANGEs from the analysis
engine); undefined cross-span label references are auto-equated to their literal addresses at stitch
time; and the WASM worker pool now defaults to `(cores − 2)` capped at 12 (was 2), so the many small
per-function reassembly jobs actually use the machine. `ROM_DEV_WASM_POOL_SIZE` still overrides.

## 0.92.0 — 2026-07-16

A batch of RE-workflow fixes from two SNES annotation sessions (carving routines out of the 65816
`.byte` floor with the live debugger).

**Correctness**
- **`memory({op:'readCart', cpuAddress, bank})` honored the SNES bank** — a bank-local 16-bit
  address + `bank:2` read BANK 0's bytes silently (the third of the "silently the wrong bank" family;
  the disasm twin was 0.91.2). It now composes `bank<<16 | cpuAddress` under LoROM/HiROM mapping.
- **`frame({op:'stepInstructions'})` `width` no longer lies on taken branches.** `width` was the raw
  PC delta, so a taken forward branch (a 2-byte `beq` to +3) looked exactly like a 3-byte instruction —
  silently mis-validating a 65816 immediate-width decode. Each step is now classified from its opcode
  into **`flow: 'seq'|'branch'|'call'|'jump'|'ret'`** (a small fixed 6502/65816 transfer set), and
  `width` is emitted **only on `flow:'seq'`** steps (where the delta really is the instruction size); a
  control transfer carries `flow` + `nextPc` instead.
- **`cpu({op:'call'})` speaks the loaded core's registers.** `finalRegs` used hardcoded m68k names
  ({D0,A0,…}) on every core, so on a 65816 core the values came back under wrong labels — now decoded
  per-CPU (A/X/Y/P/DB/D/S/PC on SNES). `regs` accepts register **names** (`{a:0x0350}`) via a
  per-platform map (unknown name → clear error), not just raw ids. New **`callMode:'jsr'|'jsl'`** sizes
  the 65816 return/sentinel correctly (a plain `jsr`/`rts` helper pushes 2 bytes, not the 3-byte
  `jsl`/`rtl` default — otherwise it "returned" one byte off into vector-stub land).

**Token cost**
- `build({output:'reassemble'})` collapses the per-region array to `{count, allByteExact:true}` on full
  success (was ~2.5 KB of identical rows on a 32-bank cart every rebuild); it lists only the failed/edited
  regions — which is when the detail is actionable.
- `breakpoint({on:'pc'})` hits no longer re-emit the ~600-char `registersAtHit` note every time (the full
  explanation is in the tool description, loaded once) — a terse pointer instead. `memory({op:'read'})`
  stops emitting a `note: null` field for regions that have no note.

## 0.91.3 — 2026-07-16

**A large flat-region disassembly no longer locks up the server** (field report: a ~500 KB Genesis
`disasm({target:'project'})` "locked up the whole MCP server").

- Genesis is one flat 68k region, so it disassembled the entire ROM as a SINGLE unit — and the
  reassembler's heal loop is **superlinear** in region size (it re-assembles the whole growing
  region each pass: 32 KB ≈ 2 s but 64 KB ≈ 8 s). A ~471 KB cart took **~5 minutes**, monopolizing
  one WASM worker the whole time — indistinguishable from a lockup, and past any client timeout. The
  0.89.0 per-region parallelism didn't help because there was only ONE region.
- Fix: `planRegions` now **chunks a large flat region** (Genesis; ≤32 KB per `chunkN.asm`). Each
  chunk's heal loop stays fast, and the existing per-region loop runs them across the worker pool in
  parallel. A boundary that splits an instruction just floors those bytes to `.byte` — still
  byte-exact, since the reassemble rebuild splices each chunk into `original.rom` by offset. Measured
  on a real 512 KB cart: **~5 min → ~33 s**, and the one-call `build({output:'reassemble'})` rebuild
  is **byte-identical** (verified). `planRebuild`'s Genesis header/pad math spans all chunks.
- For the fully-robust path on any multi-MB ROM, `background:true` + poll (0.89.0) now genuinely
  helps here — 15 chunks parallelize where one region couldn't.

## 0.91.2 — 2026-07-15

**Packaging: build artifacts really can't ship now.** The 0.90.0 `.npmignore` meant to keep stray
`examples/**/*.gba`/`.build.log` out of the tarball was inert — npm uses the `files` array as the
allowlist and bypasses `.npmignore` for included dirs. The exclusions moved into `files` itself
(`!examples/**/*.gba` …), where npm honors them; verified a stray `.gba` + build log no longer pack
(source-form `.p8` carts + input assets still ship).

**`disasm({target:'rom', bank:N})` no longer silently reads the wrong bank** (field report from a
SNES annotation session — the dangerous twin of the 0.90.0 SNES-address fix).

- On SNES LoROM, `{startAddress:$83CD, bank:2}` used to SUCCEED but read **bank 0's** bytes and
  return a plausible-looking disassembly under the caller's bank-2 label — silently the wrong 32 KB
  (worse than an error; an agent would annotate bank 0 under a bank-2 name). The `bank` param was
  simply dropped for SNES.
- Fixed + verified on a real 1 MB commercial LoROM cart: `disasm({startAddress:0x83CD, bank:2})` now
  composes the full 24-bit address ($0283CD), decodes bank 2's actual routine (`sep #$10 /
  ldx $0314 / …`), and resolves the file offset to 0x103CD — the report's exact wanted result. A
  full 24-bit `startAddress` works identically.
- Also honored `bank` for **SMS/GG** (page a 16 KB bank into the Sega-mapper slot-2 $8000 window).
- **Flat platforms (Genesis/GBA/Lynx/C64) now REJECT a non-zero `bank`** instead of silently
  applying it to a flat read — no cart banking there, so a bank is a caller error, surfaced loudly.
- Regression tests: bank-N reads the right 32 KB (not bank 0), full-address parity, and the
  flat-platform rejection.

## 0.91.1 — 2026-07-15

**`binaryIncludes` base64 strings were embedded as TEXT on the GBA/gcc-runner paths — the real
cause of the maxmod "silent without `print()`" saga.**

- The MCP/HTTP contract delivers `binaryIncludes` as base64 STRINGS (inline AND `binaryIncludePaths`
  both arrive base64). `binaryFile()` in the worker layer did `Buffer.from(bytes)` — decoding a
  string as UTF-8 — so the base64 *text itself* became the mounted file's contents and `.incbin`
  embedded ~4/3-inflated garbage into the ROM. asar/cc65/vasm68k/wladx each carried their own
  either/or guard (why NES CHR etc. always worked); the GBA soundbank stub and the generic gcc
  runner (Genesis/MIPS/SH `.incbin`) did not. Direct in-process `Uint8Array` callers were unaffected
  — hence "same source, different ROM, opposite audio" between an agent session (server, base64)
  and a local harness (bytes). Diagnosed by finding the soundbank's base64 text inside the silent
  ROM; a corrupt bank makes maxmod's `mmReadPattern` misread (the phantom-channel tell) and every
  build silent regardless of what else runs.
- Fix: `binaryFile()` now honors the same either-bytes-or-base64 contract as the per-toolchain
  guards. Regression test builds the same ROM both ways and asserts byte-identity + that the bank's
  base64 text never appears in a ROM.

## 0.91.0 — 2026-07-15

**GBA `system_ram` was silently wrong — fixed, + a new `gba_iwram` region** (defect report from
the gba_lua_sdk maxmod debugging session; `romdev-platform-gba@0.10.0`).

- Root cause was an **upstream mgba-libretro bug**: `retro_get_memory_size(SYSTEM_RAM)` returned
  `GB_SIZE_WORKING_RAM` (32768 — the Game Boy constant) unconditionally, while
  `retro_get_memory_data` returned the GBA's 256 KB **EWRAM**. So `system_ram` on GBA was the first
  32 KB of EWRAM wearing IWRAM's size: reads at `$0300xxxx`-style offsets returned real-but-wrong
  bytes (silent zeros where libtonc puts nothing), IWRAM was unreachable entirely, and the
  misleading 32768 size "confirmed" false hypotheses for hours. Same wrongness flowed through
  `breakpoint({captureMemory})`.
- Fixed in the mgba patch: `system_ram` now reports EWRAM's real size (**262144**) and reads the
  full 256 KB; new **`gba_iwram`** region (32 KB @ `$03000000`) exposes the RAM where the C stack
  and libtonc/maxmod `.bss` actually live. Region enums are single-source, so `gba_iwram` appears
  in every memory tool automatically.
- GBA MENTAL_MODEL corrected (it wrongly claimed `system_ram` covered both RAMs) + a new
  "IWRAM vs EWRAM debugging footgun" note: map the address by prefix — `$02xxxxxx` → `system_ram`,
  `$03xxxxxx` → `gba_iwram`.
- Regression test: live tonc ROM, asserts EWRAM reads past the old bogus 32 KB limit and that
  IWRAM reads live stack/`.bss` bytes (all-zeros = the defect is back).
- **Audited all 15 classic platforms for the same defect class — GBA was the only instance.**
  Live audit of `system_ram` size vs hardware truth on every core: gpgx (the other multi-system
  core, serving Genesis/SMS/GG) switches sizes per system correctly (64 KB / 8 KB / 8 KB); the two
  flagged outliers are correct by design and verified live-data-not-zeros (Atari 7800's 64 KB is
  the intended whole-bus view — offset == CPU address, documented; MSX's 512 KB is real mapper RAM
  on the emulated machine). The "important RAM unexposed" pattern (the IWRAM analog) was also
  checked: GB HRAM (`gb_hram`) and Genesis Z80 sound RAM (`genesis_z80_ram`) already have
  dedicated regions — GBA IWRAM was the one gap.

## 0.90.0 — 2026-07-15

Two fixes from a SNES *annotation* session (carving a routine out of the SNES `.byte`
floor by live single-stepping).

- **`disasm({target:'rom'})` accepts a banked SNES address ≥ 0x10000.** Passing a natural LoROM CPU
  address (e.g. `$02AF86`, bank 2) aborted with da65's `StartAddr < 0x10000` precondition — the wrong
  half of a multi-bank cart's address space. It now disassembles with the bank-local 16-bit address
  (the correct in-bank CPU address) and folds the bank base back into the file-offset annotation, so
  the full 24-bit address maps to the right ROM offset. `memory({op:'readCart'})` already accepted the
  full address; the two tools now agree.
- **`frame({op:'stepInstructions', count})` — bulk single-step.** Tracing a routine to confirm its
  boundaries + 65816 immediate widths cost ~one round trip per instruction (a 2-byte `lda #imm8` vs a
  3-byte `ldx #imm16` shows up only as the PC delta). This returns an ordered `trace:[{pc, width}]` in
  ONE call — `width` = PC[k+1]-PC[k] (a missing width = a branch/jump moved the PC) — with the
  boilerplate note emitted once, not per entry. `withRegisters:true` adds the register file at each
  step. Collapses a ~26-call trace into 1. Works on all 18 platforms (it wraps `stepInstruction`); the
  `width` cap is the longest instruction across every ISA (16), so m68k's up-to-10-byte instructions
  aren't clamped like a 6502-sized cap would.
- Stray build artifacts (a compiled `.gba`/`.build.log` a playtest wrote into `examples/`) no longer
  ship in the npm package — an `.npmignore` excludes ROM binaries + build logs from the `examples`
  glob (source-form `.p8` example carts + `.png`/`.chr`/`.bin` input assets still ship).

## 0.89.0 — 2026-07-14

Large-ROM `disasm({target:'project'})` no longer times out the tool call — the last of the
findings from a 1 MB commercial SNES run. A multi-MB cart (32-bank SNES/Genesis) can take minutes to
reassemble; that used to time the MCP call out mid-run even though the server finished writing every
bank.

- **Parallelized the per-bank reassembly.** The region loop was strictly sequential (one bank at a
  time, one WASM worker). It now fires all regions concurrently and the worker pool caps real
  parallelism at `ROM_DEV_WASM_POOL_SIZE` (default 2) — so a 32-bank cart runs pool-many banks at
  once instead of serializing 32 heal loops. Order + byte-exactness preserved.
- **`disasm({target:'project', background:true})` — the timeout-proof path.** For a large ROM, start
  the disassembly in the background and get a `{jobId}` back IMMEDIATELY; the server keeps working
  even if the call's client times out. Poll with `disasm({target:'project', job, outputDir})` — it
  reports `regionsDone/regionsTotal` while running, then returns the exact same completion payload a
  synchronous call would, once `status:'done'` (or the reason on `'error'`). Job state lives in a
  `.romdev-job.json` in the output dir (stateless across calls; git-ignored). The sync path is
  unchanged and remains the default for normal-size ROMs.

## 0.88.2 — 2026-07-13

Two fixes from a real-world `disasm({target:'project'})` + `build({output:'reassemble'})` run — a
1 MB commercial SNES ROM (which rebuilt **byte-identical**, validating 0.88.0 on real hardware data).

- **ROM data can't be committed by accident.** `disasm({target:'project'})` keeps a verbatim
  `original.rom` (the reassemble splice template) in the project dir — copyrighted cartridge bytes.
  It now also writes a `.gitignore` that excludes `original.rom` plus common ROM extensions, so a
  scaffolded project can't check the ROM into git. If a `.gitignore` already exists, the rules are
  appended (deduped), never clobbered. (No `*.md` in the list — it collides with Markdown / BUILD.md;
  `original.rom` covers the template on every platform regardless.) The payload advertises
  `romProtected: ".gitignore"`.
- **`readablePercent` no longer lies about padding.** A uniform-fill bank (all `$FF` or `$00`)
  disassembles into junk instructions (`sbc $FFFFFF,x` …) and used to report a bogus ~100% readable —
  so the *emptiest* bank looked the "most readable," inverting the "low % = data bank" heuristic. Fill
  regions are now detected (≥99.5% one byte, ≥256 bytes) and reported honestly: `readablePercent: null`
  + `fill: true` + `fillByte`, excluded from the code-only `readablePercentAvg`, and labeled in the
  region `.asm` header. The payload reports `fillRegions` count.

## 0.88.0 — 2026-07-12

- **`build({output:'reassemble'})` — the UNIFORM byte-exact ROUND-TRIP.** `disasm({target:'project'})`
  splits a ROM into byte-exact region `.asm` files, but a one-call rebuild only existed for the
  cc65-native subset (NES/C64/Atari7800/Lynx/PCE via `rebuild.json`). Every other platform documented
  a "run these native tools yourself" recipe — so an agent (or one of Jay's disassemble/annotate
  skills) following the "rebuild byte-identical + `cmp` before every commit" gate would stall on
  SNES/Genesis/GB/etc. This adds a single rebuild call that works on **every** classic platform.
  - `disasm({target:'project'})` now also writes `reassemble.json` (a `{platform, romTemplate,
    romLength, regions:[{file, startAddress, fileOffset, byteLength}]}` manifest) + a verbatim
    `original.rom` copy, for all platforms. `BUILD.md` leads with the one-call path.
  - `build({output:'reassemble', platform, path})` reads the manifest, ASSEMBLES each (possibly
    hand-edited) region `.asm` with the platform's native assembler — ca65 for 6502/65816, GNU-as for
    m68k/arm/z80/sm83 — and SPLICES each result into a copy of `original.rom` at its file offset, so
    the cartridge header, inter-region gaps, and trailing pad return byte-for-byte. Returns
    `{ok, byteExact, outputPath, regions:[{file, byteExact, …}]}`.
  - **The annotation gate is now real on every platform:** a same-length region edit rebuilds a
    modified-but-valid ROM (`byteExact:false`, exactly the changed bytes differ); a length-changing
    edit is REFUSED with a precise per-region error (splicing can't shift every later byte). Verified
    byte-identical end-to-end on all six CPU families (6502, 65816, sm83, z80, m68k, arm).
  - New `assembleRegionText()` in `toolchains/common/reassemble.js` (the assemble-only half — no
    disassemble/heal). It also fixes a latent silent-truncation bug: a length-growing edit on the GNU
    paths was truncated back to the region size by the objcopy slice; it now reports `producedLength`
    so the caller catches it.
- **GameTank joins the rebuildable-project platforms (14 → 15 classic).** `disasm({target:'project'})`
  now handles GameTank's flat W65C02S EEPROM cart (32KB mapped at `$8000`, vectors at `$FFFA`; rides the
  6502-family da65/ca65 path), so `build({output:'reassemble', platform:'gametank'})` rebuilds it
  byte-identical like every other classic system. `.gtr` now sniffs to `gametank` (no explicit platform
  needed) and has a `PLATFORM_VIRTUAL_EXT` entry. (The docs already claimed GameTank was covered — this
  makes it true.)

## 0.87.2 — 2026-07-12

- Pin the reproducible `cc65` toolchain (`romdev-toolchain-cc65@0.1.3`) so cc65 builds are
  deterministic across environments.
- Fix the m68k (Genesis) byte-exact reassembly: the ELF `.text` word-aligned, so `objcopy -O binary`
  emitted 2 leading pad bytes and the region shifted by 2. `SUBALIGN(1)` on the link script pins the
  section at its origin.

## 0.87.1 — 2026-07-08

- **PICO-8: input fix + 5 finished genre example games.** The `_clearInputOnResume` patch delivers
  the first button press after a cart load (without it no cart leaves its title screen). Ships five
  complete example carts (shmup/platformer/puzzle/sports/racing) with original art + looping
  public-domain music.

## 0.87.0 — 2026-07-08

- **PICO-8 platform via FAKE-08.** The MIT-licensed FAKE-08 player compiled to a WASM libretro core
  (`romdev-core-fake08`, no BIOS). Full tool surface: `build({platform:'pico8'})` packages a `.p8`,
  `disasm({target:'source'})` returns the cart's Lua, `memory({region:'system_ram'})` reads the flat
  64KB PICO-8 map, and load/run/see/drive work. Capability tier `fantasy` (excluded from the
  CPU-emulator RE contracts — it's a Lua VM, not machine code).

## 0.86.0 — 2026-07-01

- **GameTank Game Genie — a brand-new cheat-code format.** Nobody had made GameTank cheat codes
  before; this adds a Game-Genie-style read-substitution device to the emulated GameTank core plus
  a code format that is HARDWARE-COMPATIBLE (the same codes would work on a physical Game Genie
  built for the console's open cart bus).
  - Core (`romdev-core-gametank@0.2.0`): a value-override cheat device in the shared debug lib
    (`romdev_cheat_set`/`romdev_cheat_read`/`romdev_cheat_get`, 24 slots). `MemoryRead` returns the
    substitute byte on an address match, with optional compare-against-original (survives bank
    switching) — exactly what a hardware Game Genie does. Any core that adds the one-line
    `romdev_cheat_read` call to its bus read gets this for free.
  - Format: `encodeGameTankGameGenie`/`decodeGameTankGameGenie` — a distinct 16-letter wheel
    (`KLMNPQRSTVWXYZ23`), 16-bit address + 8-bit value (+ optional compare), scrambled with a
    checksum. Plain codes are `XXX-XXXX`, compare codes `XXXX-XXXXX` (e.g. `$8100→0x42` = KTM-LPK3).
    Wired into every device dispatcher; `cheats({op:'make', platform:'gametank', …})` generates
    codes and `cheats({op:'apply'})` applies them live. GameTank's `retro_cheat_set` is a stub, so
    `LibretroHost.setCheat` routes GameTank cheats through the romdev value-override device.
- **jsgame test no longer skips.** It ran only under `--experimental-vm-modules`, so the default
  suite skipped it. It now runs in an isolated forked child process (SDL is main-thread-only;
  rungame leaks handles) driven over rawr JSON-RPC — the child carries the flag and is killed when
  the RPC resolves, so the main suite stays clean. Suite: 1099 tests, 1099 pass, 0 skipped.

## 0.85.0 — 2026-07-01

- **Native-runtime game kinds — wasmcart + jsgame are now first-class hosts.** romdev is a
  uniform harness for runnable game artifacts; libretro emulator cores were one kind, and now
  wasmcart carts (`.wasc`) and jsgame web games (`.jsgame`) are two more. They run native
  WASM/JS in-process (not emulation) but share the same run/see/drive surface:
  `loadMedia({platform:'wasmcart'|'jsgame'}) → frame(step/screenshot/verify) → input`, driven
  through the existing tools. A capability descriptor per host keeps emulator-only tools
  (memory regions, cpuState, disasm, cheats) absent for these kinds.
  - `WasmcartHost` wraps wasmcart's `CartHost.runFrame`; framebuffer is XRGB8888 (decoded as-is).
    **WASM introspection** (the V8-runtime bonus): read/write the real cart heap, enumerate the
    module's exports, read the WCInfo. Needs `wasmcart@^0.3.0` (its new `setFixedStep`).
  - `JsGameHost` wraps jsgamelauncher's new headless `createHostSession` (`rungame@^0.13.0`):
    host-stepped rAF + offscreen-canvas readback, synthetic gamepad input, **JS introspection**
    (`globalThis._jsg`). Requires the server to run with `--experimental-vm-modules` — the server
    now SELF-RE-EXECS with that flag if missing (harmless for everything else).
- **`pack` tool — the "build" (zip) step for native kinds.** `pack({target:'wasc'|'jsgame',
  source, outputPath})` assembles a source directory into its distributable `.wasc`/`.jsgame`
  archive (a zip; NOT a compiler — wasmcart is any-language→WASM, jsgame is plain JS). Rounds
  out the build→run→see loop for these kinds. Zero new deps (fflate).

## 0.84.1 — 2026-06-30

- **New package `romdev-audio-resampler`** — the WASM+SIMD linear audio resampler (interleaved
  S16LE stereo, any src→dst rate) is carved out of `src/playtest/resampler/` into its own
  standalone, zero-dep npm package so other projects can consume it (retroemu's terminal audio
  path needs it to resample fractional-rate cores like the GameTank ACP's ~13983 Hz up to a
  fixed device rate — the way a libretro frontend does). romdevtools now depends on it; the
  playtest audio sink imports it instead of the in-tree copy. No behavior change here.

## 0.84.0 — 2026-06-30

**The 3D GL cores are now PLAYABLE in the SDL playtest window — N64 + PS1 at full speed.**
Until now the hardware-rendered cores (n64/ps1/dreamcast, all `hwRender:true`) rendered
headlessly but couldn't be driven interactively. Verified end-to-end: commercial 3D titles on
**N64** and **PS1** play in the window at full speed with sound and a
standard controller. Five fixes, all in `src/playtest/playtest.js` + `src/host/`:
- **Software-blit window for hwRender cores.** An `accelerated:true` SDL window makes a GLX
  context that collides with native-gles's EGL context → `X_GLXMakeCurrent BadAccess` server
  crash. hwRender cores now open `accelerated:false` (they only present CPU readback pixels).
- **RGBA8888 in the window's pixel converter** — the hwRender readback format was unhandled →
  black window. Added (with the alpha=255 force the GL FBO needs).
- **Audio-paced stepping, wall-clock budgeted.** Step extra frames per tick to keep SDL's
  buffer full, but cap the burst by WALL-CLOCK (≤1.5 ticks), not a frame count. A frame-count
  cap froze the event loop on slow cores (8 frames × 60ms = 480ms) → stutter death-spiral;
  the time budget keeps the window responsive and the audio steady. (Fixes the N64 choppy
  audio too — parallel-n64 emits ~91 frames of audio per real second, not 60.)
- **N64 analog stick + full pad map.** `inputStateCb` handles `RETRO_DEVICE_ANALOG` (synthesize
  ±32767 from the d-pad); N64-specific pad map (Z = a free face button, C-buttons = right
  stick — the analog triggers idle half-pressed and aren't used by N64).
- **No per-frame serialize on hwRender.** The rewind buffer AND the auto-checkpoint both call
  `serializeState()` — fine for 8/16-bit (KB) but brutal on a 16MB N64/DC state (~18ms/call).
  Skipped entirely when `host.hwRender`.

**Dreamcast: boots commercial GD-ROM games, but EXPERIMENTAL / not yet playable.** flycast now
loads + renders real discs — a first — via two fixes: the
**GLES (WebGL2) renderer** (`-DUSE_GLES=ON`; the desktop-GL path called `glClearDepth` which
WebGL lacks → a frame-58 crash), and **NODERAWFS disc streaming** (`-s NODERAWFS=1` + a host
`noderawfs` path) so libchdr seeks the disc off Node's real fs instead of loading the whole
CHD into the WASM heap (an 872MB CHD OOM'd a 1GB heap). BUT on the interpreter core DC
runs at ~5 fps — **unplayable.** It ships on the correct interpreter; the WASM SH-4 JIT (78fps,
integrated behind `ROMDEV_FLYCAST_JIT=1`) has native-emit bugs that hang a commercial disc's boot
and is a documented next step (internal). DC is labeled experimental, not a playable platform.

## 0.83.0 — 2026-06-30

**GameTank examples: 5 genre games reworked into shippable, hardware-tested shape.**
The GameTank example set (`examples/gametank/templates/`) went from thin scaffolds
to five complete, play-tested games (verified on real RetroDeck hardware): `shmup`,
`platformer`, `puzzle`, `sports`, `racing`. Along the way several real GameTank
blitter/SDK footguns were isolated and are now documented in the shared headers so
future games dodge them:
- **A box of width OR height exactly 128 is silently DROPPED** by the blitter (a
  full-screen-dimension fill never draws). Clamp to 127. (Hit as a "vanishing
  ground" / "no road" bug.) Documented in `gt_draw.h`.
- **Box top-edge scanlines flicker between the two double-buffer pages** — only the
  border-clear path paints the screen's edge rows cleanly. Frames that draw near the
  top finish with `queue_clear_border(topColor)` (drawn LAST; HUD text that must sit
  in rows 0-6 goes AFTER it). Documented in `gt_draw.h`.
- **The SDK `rnd()` corrupts game state on the single-bank build** — use the inline
  `rnd8()` xorshift in `gt_draw.h` instead. (Broke enemy spawning until found.)
- **GRAM sprite blits are the per-frame cost** — too many overrun the vblank window
  and the draw queue drops rects (platforms flicker/vanish). Keep sprites few (the
  platformer blits only the hero; coins are cheap rects).
- New shared helpers: `gt_hud.h` gained a 3×5 A–Z text font (`hud_text`); `gt_draw.h`
  exposes `rnd8()`. `gt_sound.h` SFX wired into sports (wall/paddle/score) and racing
  (crash). `puzzle` is now a faithful Columns-style 3-jewel matcher (CHROMA WELL):
  3-tile falling column, A/B color-cycle, horizontal/vertical/diagonal matching with
  gravity chains. Platformer gained a 3-frame walk cycle, signed/clamped jump physics
  (no more unsigned-wrap fall-death), swept platform-landing (no tunneling), and a
  coin pickup chime. `examples/README.md` gained the GameTank row.

## 0.82.0 — 2026-06-29

**New platform: GameTank — the 18th system, a full Tier-1.** Clyde Shaffer's
open-hardware [GameTank](https://gametank.zone/) (a W65C02S console: 128×128
hardware-blitter framebuffer + a second 65C02 audio coprocessor) is now a
first-class romdev platform, held to the SAME Tier-1 contract as the 14 classic
2D systems — not the partial 3D-console tier.
- **Build** via cc65 (`--cpu 65c02`, `-t none`) + a bundled single-bank 32 KB
  preset (linker cfg + crt0 + vectors + `gametank.h`). Output is a flat `.gtr`
  (EEPROM32K, size-keyed mapper). The cc65 dispatch gained a per-platform CPU
  override (the `-t none` path needs an explicit `--cpu`) + preset-bundled
  headers; both reusable by future cc65 platforms.
- **Run + render** through `monteslu/gametank-libretro` (built to WASM).
- **Full debug surface** — the core is patched with the shared romdev_debug
  hooks: `cpuState` (live 65C02 regs), write/read **watchpoints**, **pc-break**,
  **watchdog**, **coverage**, `setReg`/`getReg`. Same machinery every other
  instrumented core links.
- **audioDebug** (`chip:'acp'`) — the ACP audio coprocessor's state (DAC output,
  IRQ/sample rate, run/mute, the audio-CPU PC).
- **cart** extract/wrap — split a `.gtr` into body + the `$FFFA` vector table
  (size-keyed mapper detect), and re-wrap for the extract→patch→rebuild cycle.
- **disasm/decompile** — the existing 6502 Rizin/Ghidra path covers it.
- N/A by hardware (like Dreamcast): `inspectSprites` (blitter, no OAM),
  `inspectBackground` (framebuffer, no tilemap). No genre scaffolds yet.

New packages: `romdev-core-gametank`. The capability conformance test holds
GameTank to the full Tier-1 contract (13/13).

## 0.81.0 — 2026-06-29

**Shared toolchain layers.** The same de-duplication pass the debug ABI got, applied
to `src/toolchains/` — three small shared modules under `common/` collapse what every
wrapper and C-SDK builder re-implemented. Pure de-duplication: every argv, `/work`
path, output encoding, log header, stage name, and return shape is byte-for-byte
unchanged — no behavior change.
- **`common/wasm-tool.js`** — the glue-resolution dance (`import.meta.resolve(pkg)` →
  local `src/` fallback → throw install hint) that ~15 wrappers each duplicated, plus
  the `runIsolated` input-file marshalling. `makeGlueResolver` / `resolveGlueFile`
  (file-glue: asar, wladx, rgbds, dasm, vasm68k, sjasm, tcc816, z80/sdas, da65) +
  `resolveToolBaseDir` (base-dir: cc65, sdcc).
- **`common/gcc-toolchain.js`** — `makeGccToolchain(config)`. The arm/m68k/mips/sh GCC
  wrappers were ~73% identical (cc1→as→ld→objcopy); each is now a ~67-line config object
  + thin named re-exports (callers keep `runM68kAs` etc). MIPS endian (N64 big / PS1
  little) handled via per-stage flag functions. ~210 → 67 lines each.
- **`common/c-build.js`** — `CBuild` stage-runner + `BuildError`. The 5 GCC/tcc C-SDK
  builders (gba/genesis/mips/sh/snes-c) plus cc65 repeated the
  `run → log += → if (fail) return {ok:false,…,stage,…crash}` dance ~73×; it's now
  `cb.stage(name, run, pick)` (throws `BuildError`) + a single try/catch that maps back
  to the exact result via `e.toResult(extra)`. `BuildError.fields()` serves the cc65
  shape (no `ok` field — index.js adds it). All 17 systems' C compilers now run through
  the shared layers; sdcc is a documented partial fit (shares the log accumulator, keeps
  its bespoke per-TU failure context). Full suite 1084/1084.

## 0.80.0 — 2026-06-29

**Shared debug ABI library.** The per-core debug instrumentation (watchpoints,
read-watch, range-watch, PC coverage, PC breakpoints, the instruction watchdog,
and the at-hit register snapshot) was ~700 lines of nearly-identical C inlined
into every core's patch. It's now ONE shared library — `scripts/romdev-debug/
romdev_debug.{h,c}` — that every migrated core links against. Each core keeps only
a small hook shim (bus taps + dispatch hook + its CPU-specific register snapshot);
the machinery and every host-probed `romdev_*` export live in exactly one place.

This is purely internal — **no tool or ABI behavior changes** for callers. The
payoff: the host ↔ core debug contract can no longer drift per core, adding the
debug surface to a new core drops from ~700 lines to ~80, and a new conformance
test makes any drift a hard failure.

- **Shared lib + ABI contract** (`romdev_debug.h`): the ~16 host-probed exports +
  the core-hook interface (`romdev_on_write/on_read/on_dispatch` returning hit/freeze
  signals; `romdev_is_frozen`/`romdev_pc_hit_kind`/`romdev_wp_wants_old`/`romdev_any_armed`
  accessors).
- **10 cores migrated**, spanning every CPU family in the project: gambatte (sm83),
  fceumm (6502), genesis-plus-gx (m68k **and** z80 — both CPUs now feed the SAME shared
  debug state, replacing the old "m68kcpu.c defines, z80.c externs" split), snes9x
  (65816), vice (6510/C64), prosystem (6502/7800), stella2014 (6507/2600), geargrafx
  (HuC6280/PCE), bluemsx (z80/MSX), and mgba (ARM7TDMI/GBA — the lone 32-bit RISC core).
  Each per-core patch shrank substantially (e.g. fceumm 869→421, snes9x 814→449,
  genesis 1249→738, mgba 934→437 lines).
- **handy (Lynx 65C02) migrated too — the last inline holdout.** A first attempt regressed
  CPU execution; the root cause turned out to be the read hook. The Lynx's `CPU_PEEK`
  reads memory OR a hardware I/O register (`mSystem.Peek_CPU` at $FC00+), and reading an
  I/O register has SIDE EFFECTS (clears a status bit / advances a FIFO). The first migrated
  read macro was an expression (comma-operator) form that re-evaluated the underlying read
  2-3× → the I/O register got read multiple times per access → corrupted hardware state →
  the CPU never reached its main loop (looked like a "freeze"). Fixed by reading the source
  EXACTLY ONCE into a temp via a GCC statement-expression before calling `romdev_on_read`.
  Patch shrank 640→251 lines. With this, **all 13 instrumented cores share the lib** — no
  inline holdouts remain. (Also fixed the libretro.cpp frame-loop guard, which referenced
  the now-private `romdev_pc_hit` symbol directly → switched to the `romdev_is_frozen()`
  accessor like every other migrated core.)
- **The newer cores too — and ONE PS1 core now.** N64 (parallel-n64, MIPS R4300) had its
  own divergent debug snippet (a second copy of the machinery with a 2-arg pcbreak_set that
  silently dropped the host's step arg → single-step was BROKEN); it now uses the shared lib
  via a thin shim (R4300 snapshot + RDRAM canon + call-site adapters), single-step fixed.
  **PS1 was split across TWO cores** — beetle-psx-hw (the GPU/GL renderer, but read-only
  state) and pcsx-rearmed (full debug, but software-render + not even wired into the
  registry). That split was useless — you couldn't get GPU *and* debugging in one core. So
  the full debug surface (watchpoints, pc-break, single-step, range, coverage) was added
  DIRECTLY to **beetle-psx-hw** (shared lib + a shim hooking mednafen's WriteMemory/
  ReadMemory + the CPU_RunReal interpreter loop), and **pcsx-rearmed was deleted entirely**
  (package, build script, snippets, version pin). PS1 is now ONE core that GPU-renders AND
  fully debugs. Dreamcast (flycast, SH-4) has no debug machinery — only read-only SH-4/AICA
  state accessors (irreducibly per-core), nothing to migrate. **all 13 instrumented cores share the lib** (Lynx included — see below). Also fixed a missing package-stage step in the
  beetle build (rebuilds appeared to "do nothing" since the registry loads the package copy).
- **`test/romdev-debug-abi.test.js`**: loads each migrated core's wasm and asserts the
  full shared ABI is exported — drift fails the suite (now guards all 13, incl N64 + beetle PS1 + Lynx). 
  **`test/romdev-debug-lib.test.js`** compiles the lib natively and checks its logic.
- Build wiring: each migrated `build-<core>.sh` stages + includes (`INCFLAGS_PLATFORM`)
  + compiles/archives `romdev_debug.c`. Author guide for the shim-only flow is in
  `BUILDING.md`. (CRLF cores — gpgx z80, vice, prosystem — generate the patch against an
  LF-normalized baseline so `git diff` doesn't explode.)

## 0.71.1 — 2026-06-29

Feedback from the first run against the `pret/pokeruby` GBA decompilation.

- **Project-mode `entry` now resolves a NESTED path** (e.g. `entry:'src/main.c'`). The
  recursive asset staging already walked subdirs, but entry resolution stayed top-level
  only — so any decomp/SDK-layout project whose entry isn't at the repo root failed with
  "entry not found." Now it resolves against the recursive file set, reads the nested file
  as the entry **source**, accepts a bare filename when it uniquely matches one nested
  file, and errors with a "did you mean `src/…`?" hint.
- **`platform({op:'list'})` honors the `platform` filter** — returns just that one
  platform's row instead of the whole 17-platform matrix (the biggest token sink reported:
  ~17 KB → ~0.8 KB for one platform). New **`slim:true`** drops the verbose per-language
  `note` + `quirks` prose (~60× smaller); detail stays behind `op:'doc'`/`op:'capabilities'`.
- **`platform({op:'resolve'})` surfaces the toolchain(s)** + a note that the build
  toolchain is WASM/harness-only (was core-paths-only, forcing `node_modules` spelunking).
- **GBA `mental_model` "What's NOT bundled"** now calls out **agbcc's absence** (the real
  blocker for byte-exact Gen-III decomps like pokeruby/pokeemerald) and adds a "romdev's
  build model" section: `build` is single-shot compile→ROM, the toolchain can't back an
  external Makefile, with the confirmed host agbcc recipe for matching builds.

## 0.71.0 — 2026-06-28

### N64 / PS1 / Dreamcast reach full parity: cpuState + audioDebug + GPU-rendering helper libs + 5 examples each

The three next-gen 3D platforms are now first-class alongside the original 14.

**Live debugging (cpuState + audioDebug).** PS1 (beetle_psx_hw) and Dreamcast (flycast)
gained the romdev debug-reader exports, so `cpu({op:'read'})` and
`audioDebug({op:'inspect'})` light up (N64 already had them):
- **PS1** — `cpu({op:'read'})` returns the live R3000A register file; `audioDebug({chip:'spu'})`
  decodes the SPU's 24 voices + main volume (read from the raw register mirror, not the
  sweep-quantized `SPU_Read`).
- **Dreamcast** — `cpu({op:'read'})` returns the SH-4 registers (r0–r15, pc, pr, gbr, vbr,
  sr + decoded flags, mac, fpul); `audioDebug({chip:'aica'})` decodes the AICA's 64
  PCM/ADPCM channels + master volume. Full host plumbing + decoders added.
- The capability manifest now reports cpuState/audioDebug `true` for all three (verified by
  probing real core exports; `breakpoint`/`watch` remain pending on PS1/DC).

**GPU-rendering helper libs (no software framebuffers).** Every 3D platform's helper now
draws through the GPU — a software rasterizer would be black on the GL cores and <1fps:
- **N64** — the `n64.h` helper was rewritten to emit a **GBI (F3DEX2) display list** that
  glide64 HLEs onto the GPU (clear/rect as fill-rectangles, triangles scan-converted into
  GPU fill-rect spans), instead of poking pixels into RDRAM (which rendered black on
  glide64). No Nintendo microcode shipped — the OSTask CRC-bait trick selects F3DEX2.
- **PS1** — already correct (GP0 GPU primitives on beetle_psx_hw).
- **Dreamcast** — `dc.h` now sets **480i interlace** in `dc_video_init` (240p only showed
  the top 240 of 480 lines), and added a Maple-DMA `dc_pad()` / `dc_pressed()`.
- `#include "n64.h"` / `#include "psx.h"` now auto-bundle (parity with `dc.h`).

**5 genre examples per platform.** N64, PS1, and Dreamcast each ship
shmup / platformer / puzzle / racing / sports examples — all verified building + rendering
on the GPU.

**Docs.** MENTAL_MODEL + TROUBLESHOOTING for N64, PS1, and Dreamcast (the render model,
boot story, debug surface, and what's N/A and why).

### asar (SNES) build-tool fixes

From real commercial-disassembly feedback:
- **`build({output:'project'|'run'})` honors `options` + a new `defines` map** (e.g. asar
  `--define`) — they were silently dropped.
- **New `entry` param** so a project whose top file isn't `main.*` (e.g. an existing
  `smw.asm` disassembly) builds without injecting glue.
- **Subdirectory assets are staged recursively** (a flat `readdir` missed nested
  `incbin`/`incsrc` targets).
- **A clean asar error is no longer mislabeled** `[worker] Abort in WASM` (it exits errors
  via a C++-exception path; the misleading heap-pointer line is stripped when real
  diagnostics are present).
- **The LoROM-header bankcross preflight no longer false-positives** on banks $01+ (the
  header is only in bank $00) and honors `check bankcross off`.
- **A readfile/filesize advisory** warns when a source reads many distinct files that way
  (the asar-WASM resource limit), pointing at the pre-convert-to-`.bin` + `incbin`
  workaround.

### Toolchain

- **sh-c (Dreamcast) defaults to `-O1`** — the sh-elf `cc1.wasm` has an `-O2`-only pass
  that aborts on common control flow; `-O1` dodges it. A user-supplied `-O<level>` wins.

## 0.70.0 — 2026-06-26

### Dreamcast is ship-ready: verified build → run → screenshot, with a renderable example

The Dreamcast platform is now verified end-to-end and release-ready:

- **build → run → screenshot proven + regression-tested.** A C homebrew compiles via
  sh-elf-gcc, boots DIRECTLY on Flycast's reios HLE BIOS (no GD-ROM image, no firmware),
  and renders on the real GPU through native-gles at 640×480 — confirmed by the new
  `test/dreamcast-runside.test.js`.
- **dc.h is now auto-bundled.** The PowerVR2 framebuffer helper (640×480 RGB565 bring-up:
  FB_R_CTRL/SIZE/SOF1 + SPG) ships in the sh-c toolchain lib and is injected automatically,
  so `#include "dc.h"` just works — a DC program is a single `main.c` with no glue. A
  caller-supplied `dc.h` still overrides the bundled one.
- **A renderable example** — `examples/dreamcast/hello` (DCHELLO): the canonical starter
  that paints a test pattern through the GPU pipeline. Registered with createProject /
  scaffold like the other platforms.

(The 640×480 screenshot path was already correct — the GL FBO is sized to Flycast's
upscale bound and the host crops the readback to the core's reported geometry; a raw
readback without crop args was the only thing that looked oversized.)

## 0.69.0 — 2026-06-26

### PS1 renders on the REAL GPU via native-gles (Beetle PSX HW + OpenBIOS)

The PS1 core is now **Beetle PSX HW** (mednafen) with its GLES3/WebGL2 hardware renderer,
rendering the PS1 GPU on the real GPU through native-gles — the same path as glide64-N64
and Flycast-DC. It ships with **OpenBIOS embedded** (PCSX-Redux, MIT-licensed, region-free),
so there's NO copyrighted Sony firmware to ship and no BIOS file to supply. (Verified:
mod.GL exposed, SET_HW_RENDER fires, hwActive=true, the OpenBIOS 3D-cube boot animation
renders in shaded perspective through native-gles.)

- New package romdev-core-beetle-psx-hw (replaces romdev-core-pcsx-rearmed as the PS1
  core); build-beetle-psx-hw.sh reuses the N64 GL recipe (all-.o link, -lGL +
  GL_ENABLE_GET_PROC_ADDRESS + GL in EXPORTED_RUNTIME_METHODS, the libretro-common EXTRAS).
- Registry: ps1 → beetle_psx_hw, hwRender:true. Manifest: renderingKind 3d, run+screenshot
  +disasm+decompile+build true; cpuState/audioDebug now false (beetle lacks the romdev
  MIPS/SPU debug exports the old pcsx_rearmed-software build had — a future core patch;
  pcsx had no WebGL2 GPU path).

NOTE (both MIPS platforms): the GL cores render RDP/GPU display lists, NOT raw CPU-written
framebuffers — so the romdev software-3D example libs (which rasterize into a framebuffer)
render black on them; REAL games with GPU geometry render correctly. SDK-based examples
(libdragon rdpq / PSn00bSDK GTE) are the renderable path. Suite 1059/1059.

## 0.68.0 — 2026-06-26

### N64 renders on the REAL GPU via native-gles (glide64), not software

parallel_n64 now renders the RDP through **glide64 → GLES2/WebGL2 → native-gles** (the
real GPU, headless EGL pbuffer), replacing the angrylion software-RDP build. SET_HW_RENDER
fires, the host's LibretroGL drives native-gles, and frames read back via glReadPixels —
the same GPU path as Flycast/Dreamcast. (Verified: hwActive=true, the GL context engages
from boot.)

The build + host fixes that made it work (every one was a real wall):
- **Link all .o directly**, not via a .bc/.a archive — the archive route drops the
  GLSM/context_reset/glide64 objects (no externally-referenced symbol), so the core never
  calls SET_HW_RENDER. (build-parallel-n64.sh)
- **`-lGL` + `GL_ENABLE_GET_PROC_ADDRESS=1` + `"GL"` in EXPORTED_RUNTIME_METHODS** — these
  make Emscripten emit `Module["GL"]=GL`, so the returned module actually exposes the GL
  context object the host needs. Without them, `mod.GL` is undefined and HW render never
  initializes.
- **coreLoader: don't set `noInitialRun`/`wasmBinary` for GL (canvas) cores** — both
  suppress the Emscripten GL runtime init; use `locateFile` so the .wasm loads the normal way.
- **Pre-seed PLATFORM_CORE_OPTIONS before `_retro_init`** (loadCore now infers the platform
  from the core filename): the core picks its renderer (glide64 vs angrylion) from
  `parallel-n64-gfxplugin` during retro_init, so the override must be set before then.
- Registry: n64 is now `hwRender:true` (glide64 GL).

## 0.67.0 — 2026-06-26

### Dreamcast examples + sh-c -O level fix

Four DC example programs (rom-games/dreamcast/): dchello (test card), bounce (animation),
starfield (shmup background), grid (puzzle/board) — all build via the WASM toolchain and
render distinct content through Flycast, exercising the dc.h helper (no-KOS PowerVR2
framebuffer + 2D primitives).

sh-c driver: a user-supplied `-O<level>` now wins over the default `-O2` (gcc honors the
LAST -O, so a default appended after the user's would clobber it — only add -O2 if absent).
This matters because the WASM cc1 hangs at -O2 on some sources (the interprocedural-
optimization phase; native sh-elf-gcc compiles them in <1s), and -O1 is the workaround.
Suite 1059/1059.

## 0.66.0 — 2026-06-26

### Dreamcast: build() works — full WASM toolchain + packaging

`build({platform:"dreamcast"})` now compiles SH-4 C to a bootable ELF entirely in WASM,
and the result boots + renders through Flycast — the complete zero-install pipeline
(build → run → screenshot), verified end-to-end via the public `buildForPlatform`.

- **sh-elf-gcc WASM toolchain** (cc1 + as + ld + objcopy + objdump): gcc 14.2.0 +
  binutils 2.42 + newlib 4.4.0 for sh-elf (little-endian SH-4, m4-single-only). The cc1
  build needed CC_FOR_BUILD forced native (emconfigure makes $(CC)=emcc, which would
  build the gen tools as WASM) + the host-side libcpp/libiberty configured first.
- **sh-c build driver** + lib (dc-crt0.s zeroes .bss + calls main; dc.ld links at
  0x8c010000; newlib libc/libm/libgcc). The ELF IS the deliverable — reios boots it.
- **Packages:** romdev-core-flycast (the DC core) + romdev-toolchain-sh-gcc (the WASM
  compiler), both added as romdevtools deps; the registry resolves the DC core from the
  package. Manifest `dreamcast.build` is now true.

Dreamcast core parity reached: disasm + decompile + build + run + screenshot. Suite
1059/1059.

## 0.65.0 — 2026-06-26

### Dreamcast: homebrew renders correct graphics + HW-frame crop-to-native

A minimal DC homebrew (no KallistiOS — a dependency-free `dc.h` helper that programs the
PowerVR2 FB_R_CTRL/FB_R_SIZE/FB_R_SOF1 + SPG for a 640x480 RGB565 framebuffer) builds with
the native sh-elf toolchain, boots via reios HLE, runs, and renders a test pattern that the
host captures **pixel-exact** (verified: dark-blue background + equal red/green/blue bars +
white frame, the program's exact colors). This closes the DC render-fidelity loop.

Host change (helps any HW-render core): the video_refresh callback now records the core's
reported active resolution, and the GL readback crops the FBO to it — so a 640x480 DC frame
no longer comes back as the full 853x853 GL viewport with a dead border. `readbackFrame`
takes optional (cropW, cropH); `_afterRun` passes the core's w/h. Suite 1059/1059.

## 0.64.0 — 2026-06-26

### Dreamcast: present-path verified — screenshot works

Flycast renders to the GL FBO and the host reads it back: a framebuffer-writing homebrew
program shows ~727k captured pixels through the host's normal frame path (hwFramePending →
readbackFrame). Manifest `dreamcast.screenshot` is now true. With the CPU executing
(0.63.0), the direct-framebuffer present path lights up.

Added `flycast_emulate_framebuffer: enabled` to the host's DC options — it scans the DC
framebuffer out on every VBlank (the 2D path, no PowerVR2 tile list), so simple homebrew
that writes RGB565 to VRAM presents reliably without authoring a full TA list. (Full
TA/3D fidelity + correct framebuffer addressing come with the KOS helper lib; the pipeline
itself — boot → run → render → host capture — is proven end-to-end.) Suite 1059/1059.

## 0.63.0 — 2026-06-26

### Dreamcast: HOMEBREW EXECUTES — run + memory introspection live

Custom Flycast core patches make the SH-4 actually execute guest code. A homebrew .elf
boots via reios HLE, the SH-4 runs it, and the guest's RAM writes are visible through the
host (verified: a 0xDC0DC0DC marker the test program writes appears in DC RAM). Manifest
`dreamcast.run` is now true.

Root cause (3 stacked bugs): (1) worker-thread aborts — fixed by single-thread +
`--wrap pthread_create` no-op (0.62.0); (2) HLE BIOS off — only the reios path loads a raw
.elf, and the option is latched at retro_init, so default `UseReios=true` in source for
emscripten; (3) THE BIG ONE — `ThreadedRendering` defaulted ON, which runs the CPU on a
`std::async` worker that our pthread no-op kills → the SH-4 never steps (PC stuck at the
reset vector, reios_boot never fires, RAM stays zero). Fixed by unconditionally
`config::ThreadedRendering.override(false)` for emscripten in update_variables.

`screenshot` stays false until the PowerVR2 present-path is verified with a TA-driving
program (the KOS helper lib — next phase). All patches reproducible in build-flycast.sh.
Suite 1059/1059.

## 0.62.0 — 2026-06-26

### Dreamcast run-side BREAKTHROUGH: Flycast boots + runs DC ELFs

The threading wall is solved. Flycast (the full DC emulator) now **boots a homebrew
.elf via reios HLE and runs frames** through the romdev host — `retro_init` /
`retro_load_game` / `retro_run` all succeed, av_info reports 640×480, and video_refresh
fires every frame. No abort, no `unwind`.

The fix (after trying PROXY_TO_PTHREAD + ASYNCIFY, which deadlocks in Node on the
GL↔proxy-thread dependency): build single-threaded and **`--wrap` pthread_create to a
no-op** (`scripts/patches/romdev-snippets/flycast-pthread-noop.c`). pthread_create
returns success but spawns nothing; join/detach are no-ops. So flycast's worker threads
(achievements/http/network/audio-async) never run, `std::thread`'s ctor doesn't abort
(no "thread constructor failed"), and — crucially — the main thread never blocks on a
worker, so there's no emscripten `unwind`. Emulation runs synchronously on retro_run
(ThreadedRendering defaulted false). This is far cleaner than stubbing thread sites
one-by-one (there were 4+ wrapper classes plus raw std::thread/std::async).

Also: the GL `get_proc_address` bridge fix (0.59.0) is what got context_reset past the
signature mismatch; the 512MB-mmap fallback (posix_vmem) got init past the trap.

NEXT: a DC program that actually renders via PowerVR2 (the KOS helper lib) to verify the
present path end-to-end, then flip run/screenshot true. Captured in build-flycast.sh.
Suite green.

## 0.60.0 — 2026-06-26

### Dreamcast: SuperH4 SLEIGH metadata shipped + Flycast threading progress

- **SuperH4 SLEIGH metadata committed** (`.ldefs`/`.pspec`/`.cspec`) — these ship
  alongside the gitignored `.sla` (like every other CPU); without them the decompiler
  couldn't load the SuperH4 spec at runtime. (0.57.0 shipped the wiring but missed the
  metadata files. Now complete.)
- Flycast run-side threading: the single-threaded WASM build needs worker-thread
  creation stubbed (emscripten can't spawn them without -pthread; with -pthread the
  main thread can't block → unwind). Captured the patches in `build-flycast.sh`
  (`cThread::Start` / `VPeriodicThread::start` no-op, `ThreadedRendering` defaults
  false on emscripten) + the `flycast_threaded_rendering: disabled` host option.

KNOWN-OPEN: Flycast's load still aborts on a not-yet-located worker thread (no-pthread)
or unwinds (pthread). The thread/main-loop model integration is the remaining run-side
fight — see N64_PS1_LESSONS_FOR_DREAMCAST.md. DC analysis (disasm+decompile) is fully
shipped + tested. Suite 1059/1059.

## 0.59.0 — 2026-06-26

### Dreamcast run-side: Flycast loads ELFs + GL bridge fix (general)

Flycast WASM now boots a homebrew `.elf` (reios HLE — no BIOS/disc) and requests GL:
- threads: `-pthread -sPTHREAD_POOL_SIZE=8` (Flycast spawns std::threads; without
  pthreads the ctor aborts). The pthread build bakes the module filename into the
  worker bootstrap, so it MUST link with the final `flycast_libretro.js` name.
- **GL proc-address (general bridge fix in LibretroGL.js):** emscripten-WebGL cores
  (Flycast) resolve GL via libretro `get_proc_address`. The bridge previously returned
  a no-op 0-arg stub → the core called multi-arg GL fns through it → "null function or
  function signature mismatch" in context_reset. Now the bridge returns the real
  `emscripten_GetProcAddress` table pointer (built with `-sGL_ENABLE_GET_PROC_ADDRESS=1
  -lGL`); the native-gles stub path stays as the glide64-N64 fallback. This fix helps
  ANY future emscripten-WebGL core.
- `ROMDEV_CORE_LOG=1` env gates core stdout/stderr (was always suppressed) — found the
  thread + mmap aborts with it.

KNOWN-OPEN: `retro_run` throws emscripten's `unwind` (Flycast yields via
emscripten_set_main_loop / Asyncify, incompatible with the host's synchronous
frame-step). That main-loop integration is the next run-side step. Suite 1059/1059.

## 0.58.0 — 2026-06-26

### Dreamcast run-side: Flycast WASM core builds + inits; sh-elf toolchain built

The two heaviest Dreamcast pieces, both landed (build infrastructure; host present-path
integration is the next step):

- **sh-elf-gcc toolchain** (SH-4): binutils 2.42 + gcc 14.2.0 + newlib 4.4.0, built
  for `sh-elf` (m4-single-only, little-endian — the DC ABI). Compiles SH-4 C end to
  end. `scripts/build-sh-toolchain.sh` (adapted from the mips one; SH-4 is single-
  endian so no be/el split).
- **Flycast → WASM**: the full Dreamcast emulator (785 C++ files, GLES3/WebGL2)
  compiled to a 5.9MB WASM module that instantiates with all libretro entry points
  and `retro_init` succeeds. Flycast has no upstream emscripten build, so
  `scripts/build-flycast.sh` applies the romdev WASM patches discovered here:
  - a `CPU_GENERIC` host (no JIT) → the SH-4/ARM/DSP interpreters (`TARGET_NO_REC`);
    CMake `DetectArchitecture` + `build.h` + the FPU-control / JIT-segfault-recovery
    arch branches all get a generic no-op path.
  - asio single-threaded (`ASIO_DISABLE_THREADS`) so it doesn't need POSIX
    signal_blocker/tss_ptr (emscripten without -pthread isn't detected as POSIX).
  - Vulkan OFF (WASM uses WebGL); networking/UPnP stubbed.
  - **the key boot fix:** emscripten can't `mmap` a 512MB contiguous reservation (it
    traps), so `posix_vmem::init` declines fast-vmem on emscripten → Flycast's
    malloc-based memory fallback engages and `retro_init` succeeds.
- `dreamcast` registry entry (Flycast, hwRender — PowerVR2 is GPU-first, no software
  framebuffer; HLE reios BIOS, no firmware to ship).

Suite 1059/1059. Next: the GL present-path (load_game + run + frame through the host's
WebGL2 bridge), then the helper lib + 5 example games + packaging.

## 0.57.0 — 2026-06-26

### Dreamcast (SH-4) analysis slice — disasm + decompile

First slice of Dreamcast support: the SH-4 (SuperH) reverse-engineering path, on the
same pattern as the PS1/N64 analysis slice.

- rizin's `sh` plugin (already in rizin.wasm) wired for disasm/cfg/xrefs/functions
  (arch=sh, little-endian).
- Ghidra's **SuperH4** SLEIGH spec compiled (`SuperH4_le.sla`) + shipped in
  romdev-analysis-decompiler → `decompile` produces real C (langid
  `SuperH4:LE:32:default`). Verified: SH-4 bytes → disasm + decompiled C.
- analyze.js handles DC binaries: strips an ELF to its first PT_LOAD segment (vaddr =
  loadBase 0x8c010000) or treats a raw image as flat; left-pads so flat offset ==
  the VA's low bits + rebases the high bits (same trick PS1 needed for absolute-
  addressed calls — SH-4's PC-relative + absolute addressing needs it too).
- `dreamcast` added to the capability manifest as the new `sh` tier (analysis-first;
  run/build/etc. land in later phases). The 3D (PowerVR2) renderer's tile/sprite
  inspectors are N/A by hardware with a stated reason. Excluded from the all-14
  contract via the generalized NEXTGEN_TIER (mips + sh).

Suite 1059/1059. Run-side (Flycast WASM), build (sh-elf-gcc), the helper lib, and the
5 example games are the next phases.

## 0.56.1 — 2026-06-26

### ascii screenshot: legible default grid + lighter default color (0.44.0 feedback #1)

`frame({op:'screenshot', format:'ascii'})` defaulted to a `fb/16` grid (16×14 for a
256×224 NES frame — too coarse to read any game state) AND truecolor (`38;2;r;g;b`
per cell, ~7.9KB of escapes). So the "cheap text screenshot" was both expensive and
useless for an "are we in gameplay?" check.

- default grid is now `fb/8` (one cell per 8×8 tile → 32×28 for NES, legible).
- default `colors` is now `'256'` (indexed) instead of `'true'` — near-identical read,
  far fewer escape bytes. Net for the NES case: 4× more cells AND ~55% smaller
  (7876B → 3551B).
- when a caller forces a grid too coarse to show state, the result carries a `note`
  pointing at `memory({op:'read'})` as the cheaper exact path for a pass/fail check.

## 0.56.0 — 2026-06-26

### N64 + PS1 are now SHIPPABLE: core packages + toolchain wired for publish

The functionality was done, but the artifacts weren't distributable — the cores lived
only in the gitignored dev-staging dir, with no npm package to publish. Fixed:

- **New `romdev-core-pcsx-rearmed`** (PS1) and **`romdev-core-parallel-n64`** (N64,
  headless-angrylion software) packages, mirroring the 14's structure (package.json
  + index.js + README + gitignored `wasm/` shipped via the `files` allowlist +
  verify-wasm prepublish guard). These are CUSTOM romdev builds (the romdev debug
  exports + IPL3) — documented in each README + built by scripts/build-*.sh.
- **`romdev-toolchain-mips-gcc`** moved to required `dependencies` (build needs it);
  the two cores added to `dependencies` (always installed, like the 14). lockfile
  regenerated — `npm ci` passes.
- publish-all.mjs now discovers all 3 (26 packages total).

### A real shipping bug the npm-pack smoke test caught

The cores' Emscripten glue had a DEV SCRATCH wasm name baked in (`pcsx_vram.wasm`,
`pn64_sw.wasm` from `-o $SCRATCH/...`) instead of the published `*_libretro.wasm`.
The host always passes `wasmBinary` so it worked in dev — but any consumer loading
the factory directly got ENOENT. Re-linked both glues with the correct `-o` name (the
build scripts already used it; only my hand-links were wrong). A clean-install smoke
test (npm pack → install into a bare dir → resolve + instantiate + check exports) +
a packaging contract test now pin this so it can't silently regress.

Verified: clean-install smoke test passes, full build→load-from-package→run→render
pipeline works for both, npm ci + lint + 1054/1054 tests green. Ready for `npm publish`.

## 0.55.0 — 2026-06-26

### System manifests now call out the features a platform CAN'T have (and why)

A bare `inspectSprites: false` in the capability manifest is ambiguous — an agent
can't tell "N/A by hardware, permanent" from "a decoder we haven't built." For the
14 tile-based systems this never bit (they support those ops); for the framebuffer
(PS1) / 3D (N64) systems, FOUR ops are false with no stated reason.

- New `naReason(platform, op)` in the capability manifest returns a HARDWARE-grounded
  explanation, keyed on `renderingKind`: a framebuffer/3D renderer has no tile/
  sprite-attribute/nametable/palette tables for the tile-era inspectors to read —
  those ops are *meaningless on the hardware*, not merely absent. (PS1 `cart` →
  "disc-based, no cartridge ROM".)
- `platform({op:'capabilities', platform})` now includes a `naReasons` map alongside
  `ops`, so the manifest itself states what each platform can't do + why.
- The `unsupported()` signal from inspectSprites/inspectPalette/inspectBackground/
  renderingContext now carries that hardware reason instead of a generic "no decoder
  for this platform" — an agent gets "this is a 3D renderer, there are no sprite
  tables" and won't retry or request a decoder that can't exist.
- Conformance test pins it: every false introspection op on ps1/n64 must carry a
  hardware-grounded N/A reason. Suite 1054/1054.

## 0.54.0 — 2026-06-26

### Audit: two real N64/PS1 parity gaps found + fixed

A full per-tool audit (all 32 tools, live-probed on both platforms) surfaced two
genuine gaps where the platform was CAPABLE but the tool didn't deliver:

1. **PS1 reverse-engineering returned bogus addresses.** `disasm`/`cfg`/`xrefs`/
   `functions`/`decompile` on a PS1 PS-EXE found a single fake `fcn.00000000` at
   file offset 0 (not the real 0x80010000+ VA), and `decompile` then threw "address
   maps outside the image." Root cause: rizin ignores `-B` on a raw buffer, so the
   stripped .text was analyzed flat from 0, and PS1's ABSOLUTE jal targets dangled →
   no cross-function discovery. Fix: left-pad the .text so flat offset == the VA's
   low 20 bits (jal-following now works) and add the high bits back as a rebase, so
   every reported address is a real VA that round-trips. PS1 now finds all functions
   (16 vs 1) at correct VAs, CFG/xrefs/decompile all resolve. (N64 was already fine.)

2. **PS1 `video_ram` was claimed but empty.** The manifest lists `video_ram` for
   every platform, but pcsx_rearmed never exposed the GPU VRAM. Added a
   `romdev_vram_get` export (1024×512×16bpp) wired into `memory({region:'video_ram'})`
   — PS1 GPU VRAM is now readable (verified: rendered pixels show up).

Everything else in the audit was already at parity or genuinely N/A-by-hardware
(the tile/sprite/nametable/palette inspectors need tables a framebuffer/3D renderer
doesn't have; `cart` is for cartridge ROMs). save/loadState, runUntil, frame-verify,
romPatch, and the agnostic art/snippet tools all work on both. Suite 1053/1053.

## 0.53.0 — 2026-06-26

### N64 + PS1 reach EXAMPLE parity: 5 full genre games each

Both new platforms now ship the same caliber of bundled, playable examples as the
other 14 (parity = "5 decent full games"), registered in project.js and forkable +
buildable through the normal createProject/build tool flow.

**PS1** (4 × 3D + 1 × 2D, on a software 3D engine + the GPU): shmup STARFALL,
racing POLE BENDER (a real receding 3D road), platformer BLOCK HOP, sports
SLAM COURT (3D pong/air-hockey), puzzle DROP GRID (2D — the right idiom for a grid).

**N64** (all 5 × 3D — the N64 was a 3D-first machine, so even the puzzle is a 3D
well of cubes): STARFALL 64 / POLE BENDER 64 / BLOCK HOP 64 / SLAM COURT 64 /
DROP GRID 64, on the same software-3D lib with a framebuffer backend the
headless-angrylion core scans out.

Every example builds + boots + renders, verified on the actual cores (frames
inspected). The N64 path required the three earlier breakthroughs (self-booting
.z64 via a clean IPL3, a headless-angrylion GL-free core, and the VI-scanout
software rasterizer). Suite 1052/1052.

**This completes N64 + PS1 parity** — every tool the other 14 have works, and both
ship 5 full idiomatic examples.

## 0.51.0 — 2026-06-26

### N64 audioDebug — FULL parity (zero functional gaps)

- **`getAudioState({chip:'ai'})`** decodes the N64 Audio Interface: sample rate
  (from DACRATE + the VI clock), whether audio is playing (a buffer is DMA-queued),
  the DMA source address. (N64 audio is RSP-mixed, so the AI is the OUTPUT state, not
  per-voice — that lives in game-specific RSP audio lists in RDRAM.) Verified: a real
  ROM reports `playing:true, sampleRate:32006`. From a `romdev_ai_get` export added
  to parallel_n64. n64 `audioChips:['ai']`, `audioDebug:true`.

**This closes the last functional gap.** A programmatic audit confirms N64/PS1 now
match the canonical 14 on every applicable op — build, run, screenshot, memory,
cpuState, audioDebug, disasm, decompile, cheats, breakpoint, watch. The only manifest
differences are N/A BY HARDWARE: the tile/sprite/nametable/palette inspectors
(framebuffer/3D renderers have no such tables) and `cart` (disc-based). Suite 1052/1052.

## 0.50.0 — 2026-06-26

### PS1 SPU audioDebug

- **`getAudioState({chip:'spu'})`** decodes the PS1 SPU's 24 ADPCM voices (per-voice
  volume L/R, pitch→Hz, ADSR, key-on/off + main volume + control), from a
  `romdev_spu_get` export added to pcsx_rearmed (copies the SPU regArea). Verified:
  a toolchain-built program's SPU register writes read back correctly.
- ps1 `audioDebug:true` in the manifest.

**Parity status (N64/PS1 vs the canonical 14):** at parity on build, run, screenshot,
memory, cpuState, disasm, decompile, cheats, breakpoint, watch (+ PS1 audioDebug).
Genuinely N/A by hardware: the tile/sprite/nametable/palette inspectors (framebuffer/3D
renderers have no such tables) and `cart` (disc-based). **Remaining real TODO:** N64
audioDebug (the RSP/AI audio path — a deeper decode than the PS1 SPU register block).

## 0.49.0 — 2026-06-26

### N64 + PS1 live-debug — breakpoint + watch now work

The remaining big parity gap: the live-debugging RE tools. parallel_n64 (R4300) and
pcsx_rearmed (R3000) are rebuilt with romdev's CPU instrumentation, so:

- **`breakpoint({on:'pc'|'write'|'read'})`** + **`watch({on:'range'|'mem'})`** work on
  both MIPS platforms — verified live: a C program (built by the romdev toolchain)
  writing to a known address is caught by a write watchpoint with the writing PC, and
  a range watch captures the write stream during emulation.
- A `romdev_debug.c` instrumentation unit (per core) hooks the memory write/read paths
  (write/read watch + range watch + coverage) and the interpreter step (PC break +
  single-step). Exports the full `romdev_watchpoint`/`readwatch`/`pcbreak`/`range`/`cov`/
  `regsnap`/`watchdog` set the host already expects — so the host needed ZERO changes
  (its debug methods were already generic).
- Reproducible via the updated build-pcsx-rearmed.sh / build-parallel-n64.sh
  (patch the source + hooks + exports).

**Remaining honest gap:** `audioDebug` (PS1 SPU / N64 audio chip decoders) is still
TODO. The tile/sprite/nametable inspectors stay N/A by hardware (framebuffer/3D
renderers have no such tables). Everything else is at parity. Suite 1050/1050.

## 0.48.0 — 2026-06-25

### N64 + PS1 `build` op — full feature parity

The last missing op. N64 and PS1 now **build** C from source, completing parity
with the 14 (every op: build, run, screenshot, memory, disasm, decompile, cheats,
cpuState).

- **A from-scratch `mips-elf` GCC toolchain compiled to WASM** — binutils 2.42 +
  gcc 14.2.0 + newlib 4.4.0, the same two-stage pipeline as the Genesis m68k
  toolchain. STAGE 1 builds it natively; STAGE 2 re-compiles cc1/as/ld/objcopy/
  objdump to WASM. One toolchain serves both endiannesses (cc1 `-mel`/`-meb`,
  as/ld `-EL`/`-EB`).
- **`buildSource({platform:'ps1'|'n64', language:'c'})`** — cc1 → as → ld → objcopy,
  links a minimal crt0 + libc/libm/libgcc. PS1 wraps the image in a PS-EXE the HLE
  BIOS loads; N64 emits a big-endian flat image. **Verified end-to-end:** a C program
  compiled by the toolchain boots and renders on the PS1 core (GPU fill executed).
- Four GCC-15/emscripten build incompatibilities fixed along the way (all in the
  build scripts): binutils `static_assert`-as-identifier (`-std=gnu11`), newlib
  libgloss pre-C23 idioms (permissive target CFLAGS), libiberty `psignal` conflict
  (source patch, both gcc + binutils copies), and the `all-gcc`/`all` aux-tool
  targets pulling in ftw/gprofng (build the specific `cc1`/`as`/`ld` targets).
- New `romdev-toolchain-mips-gcc` package (the WASM tools); pinned + reproducible
  via `build-mips-toolchain.sh` + `build-mips-wasm-tools.sh`.

**Caveats:** the bare build path has no SDK yet — PS1 is "drive the GPU/SPU
registers yourself" (PSn00bSDK forthcoming); N64 compiles+links but a self-booting
cart needs IPL3 + a libdragon header (libdragon forthcoming). Both are logic/RE-
complete and the foundation for the SDKs. The framebuffer/3D renderers have no
tile/sprite inspectors by nature.

## 0.47.0 — 2026-06-25

### N64 + PS1 reach feature parity (cheats + cpuState + decompile)

The MIPS tier now matches the 14 on everything except `build`:

- **MIPS decompile** — `disasm({platform:'n64'|'ps1', target:'decompile'})` produces
  real Ghidra C pseudocode. **No Python**: the stock Ghidra MIPS SLEIGH spec is
  compiled to `.sla` (MIPS:BE:32 for N64, MIPS:LE:32 for PS1) by the same
  `sleigh_opt` that builds the other 8 CPU tables. (m2c/Pyodide was rejected — it
  would drag a CPython runtime into the tool.)
- **cpuState** — `cpu({op:'read'})` decodes the live R4300 (N64) / R3000 (PS1)
  register file: 32 GPRs by o32 ABI name + lo/hi + PC. Backed by a tiny
  `romdev_mips_regs_get` appended to each core's `libretro.c` (the new
  `build-parallel-n64.sh` / `build-pcsx-rearmed.sh` recipes).
- **cheats** — `_retro_cheat_set`/`_retro_cheat_reset` are now exported from the
  rebuilt cores (they were in the upstream C, just unexported).
- The cores are reproducible: pinned in `versions.json`, built by the new recipes
  (clone → append the regsnap → emcc with the cheat+regsnap exports; the regsnap is
  `EMSCRIPTEN_KEEPALIVE` so LTO doesn't strip it).

**Parity scorecard** — N64 & PS1 now have: run, screenshot, memory r/w, disasm
(cfg/xrefs/functions), decompile, cheats, cpuState. The one remaining op is
**build** (a MIPS GCC→WASM toolchain — PSn00bSDK/libdragon — the largest separate
piece). The framebuffer/3D renderers have no tile/sprite/nametable inspectors by
nature.

## 0.46.0 — 2026-06-25

### N64 + PS1 run-side: boot, run, render (the MIPS tier goes live)

Past analysis-only — N64 and PS1 now **boot, run, and present real frames** through
the host. The 32-bit MIPS tier is a new partial tier (`tier:"mips"`), distinct from
the canonical 14.

- **N64** (ParaLLEl-N64, HW 3D render) — `run` + `frame({op:'screenshot'})` produce
  real 3D frames headlessly via a GL framebuffer readback. Rendering goes through a
  ported GL bridge (`LibretroGL`/`LibretroGLBridge`) backed by `native-gles` +
  `webgl-node`, which are **optionalDependencies**: lazy-loaded only when an N64/PS1
  core boots, so the 14 software platforms and headless installs without the GPU
  module are completely unaffected (clear install hint if absent).
- **PS1** (PCSX-ReARMed, software + **built-in HLE BIOS**) — `run` + screenshot with
  zero firmware to ship, no GL dependency. Loads PS-EXE (and disc images).
- **Memory** works for both: `readMemory`/`writeMemory` on `system_ram` (N64 = 8MB
  RDRAM, PS1 = 2MB main RAM) — poke values directly.
- **Static RE** (from 0.45.0) still works: `disasm({platform:'n64'|'ps1',
  target:'rom'|'functions'|'cfg'|'xrefs'})`.
- N64 `.v64`/`.n64` byte orders auto-normalize to `.z64`; PS-EXE headers are stripped.

Three GL-binding bugs fixed to get frames on screen: the Emscripten `getContext`
shim's `instanceof WebGLRenderingContext` check (needs WebGL1 to be a distinct
class), the signed-vs-unsigned `RETRO_HW_FRAME_BUFFER_VALID` compare, and the
all-transparent FBO alpha (forced opaque in a new RGBA decode path).

**Still pending** for full parity (honestly off in the manifest): `build` (needs a
MIPS toolchain — PSn00bSDK/libdragon), `decompile` (needs a MIPS SLEIGH spec in the
decompiler — slaspec sources exist, a decompiler-package rebuild), `getCPUState` +
`cheats` (need a core rebuild exposing those exports). The framebuffer/3D renderers
have no tile/sprite/nametable inspectors by nature.

## 0.45.0 — 2026-06-25

### PS1 + N64 analysis-first (the 32-bit MIPS tier)

The first step past the GBA-era line: static RE for PlayStation (R3000) and
Nintendo 64 (R4300), via the MIPS plugin already in the shipped `rizin.wasm` — no
new core, no toolchain, no GPU bridge in this slice.

- **`disasm({platform:'ps1'|'n64', target:'functions'|'cfg'|'xrefs'|'rom'})`** —
  works on real ROMs. Verified: a libdragon N64 homebrew (`FlappyBird.z64`)
  recovers 251 functions with control-flow graphs and cross-references. The raw
  N64 ROM has no entry `aaa` recognizes, so MIPS analysis is seeded at the
  post-IPL3 code start (`af` + `aac`) — `aaa` finds 0, the seed finds the tree.
- **Endianness is wired right:** PS1 is little-endian, N64 is big-endian (same
  `mips` arch). N64 `.v64`/`.n64` dumps are auto-normalized to `.z64` byte order;
  PS1 PS-EXE headers are stripped to the load address.
- **Capability manifest:** `ps1` (framebuffer) / `n64` (3d) are an analysis-only
  tier — `disasm` true; run-side ops (build/run/screenshot/the tile/sprite
  inspectors) and `decompile` false. The tile/nametable inspectors are meaningless
  on a framebuffer/3D renderer, so an agent gets the clean `unsupported()` signal.
- **`decompile` (C pseudocode) is NOT available yet** for MIPS — the rz-ghidra
  decompiler ships no MIPS SLEIGH spec (adding `MIPS.sla` is a later
  `romdev-analysis-decompiler` rebuild). It returns a clear steer to the working
  disasm targets, not a cryptic failure.

## 0.44.0 — 2026-06-25

### v0.41.0 feedback (part 2) — RE-session ergonomics

- **`watch({on:'range'})` dedupe + digest.** A range watch over a churny window
  flooded with per-frame writes (a counter inc'd at one PC → hundreds of
  near-identical rows). New `dedupe:true` collapses identical `(pc,address,value)`
  events to one row with an `occurrences` count (parity with `on:'dma'`), and
  `distinctPCsOnly:true` returns JUST the per-PC digest (`byPC[{pc,count,
  sampleAddress,sampleValue}]`) and suppresses the raw event list — the
  token-cheap "which routines touch this range?" answer. (133737 N1)
- **`catalog({op:'status'}).capabilities` build-toolchain flags.** Added
  `cc65Build`, `ld65Link`, `da65Disasm` so an agent knows before calling
  `build`/`disasm` whether the toolchain is present (the analysis subtargets
  cfg/xrefs/functions/decompile are all da65-backed). (184553 #1, 190223 #1)
- **`cheats` slot lifecycle.** `apply` now REPLACES an active freeze on the same
  address instead of stacking a second one that fights for the byte
  (`replacedSameAddress`), and new `op:'remove'` drops ONE cheat by slot/code
  without `clear`'s nuke-all. (213831 #3)
- **`breakpoint` `settleFrames`.** Back-to-back driven runs on the same live host
  could inherit the prior run's held-button shadow on frame 0 (false-positiving a
  negative control). `settleFrames:N` releases the pad to neutral and steps N
  frames before the run so it starts clean. (213831 #1)
- **`breakpoint({on:'pc'})` miss-note** now names the negative-control case: a
  `hit:false` may be the DESIRED result (proving input X does NOT reach a branch),
  not a wrong-address failure. (213831 #2)
- Confirmed already shipped (0.42.0): hex-string `address`/`offset` params, the
  base capabilities map. (133737 N2, 002129 #2)

## 0.43.0 — 2026-06-25

### Port engine is now GENERIC (any source → any target), not NES→SNES-only

The recompiler was rebuilt around a small intermediate representation (IR): a
LIFTER turns a source-CPU disassembly into IR; an EMITTER turns IR into target-CPU
assembly. Adding a platform PAIR is now one lifter + one emitter, not a bespoke
recompiler. NES→SNES and the new NES→Genesis run through the *same* pipeline.

- **`disasm({target:'recompile', targetPlatform})`** — `'snes'` is the 1:1
  emulation-mode port (with the PPU shim/runtime render layers); **`'genesis'` is a
  real 6502→68000 LOGIC translation** — `lda #$42`→`move.b #$42,d0`,
  `sta $0010`→`move.b d0,($FF0010).l`, branches/jsr/jmp mapped, the NES address
  space mapped into Genesis work RAM at `$FF0000` (which IS the Tier-1 RAM-diff
  oracle's mirror). Verified end-to-end: a real NES homebrew's reset routine
  translates to m68k (0 residue), builds with vasm68k, and BOOTS in gpgx with the
  translated logic executing (RAM writes land).
- The presentation seam (PPU/APU) is stubbed for non-SNES targets — it's a LOGIC
  port; verify with `frame({op:'compareRam'})` vs the NES original. A render
  runtime per target is a later layer (NES-PPU-on-SNES is the template).
- Unsupported targets fail with the supported set. `recompileNesToSnes` now
  delegates to the generic engine (same image; existing SNES tests unchanged).
- New: `src/analysis/recompile/` (ir, lift-6502, emit-65816, emit-m68k, index).

## 0.42.0 — 2026-06-24

### v0.41.0 feedback batch + the NES→SNES port engine

A round driven by RE-session feedback (cheats, ergonomics, the human-playtest
eviction case) plus the flagship port-engine work.

#### Fixed — `cheats` raw RAM codes were inert

`cheats({op:'make'})` for a sub-`$0100` RAM address emitted the short `32:09`
form, which libretro cores PARSE but never bind — and `apply` then falsely
reported `applied:true`. `encodeRaw` now pads the address to a binding width
(`0032:09`); `apply` re-encodes a hand-typed short code too. Verified on fceumm.

#### New — hex-string forms on address params

A hex literal in a JSON arg (`address: 0xC06C`) was a hard parse error. All
address-like params (`address`/`offset`/`pc`/`compare`/…) now accept the STRING
forms `"0xC06C"` / `"$C06C"` / decimal strings, coerced before validation —
centralized so every tool gets it.

#### New — `catalog({op:'status'}).capabilities`

A map of which debug ops the loaded core/toolchain implement (pcBreakpoint,
watchpointExact, rangeWatch, cheats, da65Toolchain, …) so an agent picks a
working trace strategy up front instead of probing by failure.

#### New — `callStack` on breakpoint hits (13 of 14 platforms)

`breakpoint({on:'pc'|'write'})` hits carry a decoded call stack: the server walks
the stack from the captured stack pointer and returns each caller PC. Covers the
6502 family (JSR-opcode validated), m68k (Genesis — 4-byte BE return), and Z80/
SM83 (SMS/GG/MSX/GB/GBC — 2-byte LE return). GBA (ARM) is the lone exclusion: its
calls return through the link register, not the stack.

#### New — `references` finds inline jump-table / trampoline call sites

When no `jsr/jmp/branch` names a CODE address (it's reached via a computed jump),
`references` now scans the raw ROM for the address as a 16-bit pointer (LE/BE) and
reports `tableHits`. Per-platform header skip (NES/SNES/7800/Lynx); the 6502
RTS-trick `addr-1` form is scanned only on the 6502 family.

#### New — `disasm({target:'pointerTable'})` (all mapped platforms)

Static index→handler decode of a jump/pointer table: contiguous `dw`, SPLIT
lo/hi arrays at two bases, the RTS-trick (`+1`), and a REVERSE lookup (handler →
dispatch index). The static complement to the live `breakpoint({on:'jumptable'})`.
Works on every platform with an address mapper (nes/snes/sms/gg/gb/gbc/2600/7800/
c64/genesis); the endian default follows the CPU (Genesis/m68k → BE).

#### New — playtest eviction survivability

While a playtest window is open, romdev rolls a `.state` to disk every ~15s (and
on F2), so a session eviction can't lose a human's manual progress — the recovery
hint points at `state({op:'load', path})`. Surfaced in `playtest({op:'status'})`.

#### Leaner schemas

The last inline 62-value region enum in the watch/breakpoint tool schemas is now
a runtime-validated string — the full enum lives once on `memory`'s `region`.

#### Port engine — NES→SNES static recompile renders + plays

`disasm({target:'recompile'})` now draws the original ROM's screen on SNES
(`withShim`, phase-1 static — fixed the `cpx.w` upload bug) and animates sprites
+ runs the game's NMI each vblank (`withRuntime`, phase-2 live). The recompiler
follows the real reset vector and anchors the entry to the routine's first
instruction. (Plus the `frame` port-compare oracles: compareRam/compareRender/
findDiverge/portStatus + side-by-side two-core capture.)

## 0.41.0 — 2026-06-12

### RE engine round — bank-aware decompile, live jumptable recovery, readable 6502 output

A correctness + readability pass across the whole reverse-engineering engine,
plus the differentiator no static tool has: **resolving computed jumps with the
live emulator.** All 14 platforms; no `romdev-analysis*` package changes (the
work is in the address-mapping JS, the decompile post-passes, and the live-debug
tools).

#### New — `breakpoint({on:'jumptable', address})`: live computed-jumptable recovery

Static analysis follows direct addressing only, so a game's *hottest* routines —
state machines, script / event VMs, battle engines that dispatch through
`JMP (table,X)` or an RTS-trick — decompile to `(*_IRQ)()` + "Could not recover
jumptable." romdev has a **live emulator**, so it resolves them dynamically: break
at the dispatcher, single-step through the indirect transfer, and record the PC
it actually lands on — accumulated across frames/inputs. Fixed trampolines (the
compiler's pointer-call shim, return paths) are filtered out by what *doesn't*
vary; the destinations that vary hit-to-hit are the real switch arms, ranked by
hit count. Drive more game states (`pressDuring` / `fromState`) to surface rarer
arms. **No standalone tool (IDA / Ghidra / Binary Ninja) can do this** — it needs
an emulator in the loop. `disasm({target:'resolveJumptable', address})` is the
static-side alias that redirects to it.

#### New — `disasm({target:'decompile'})` reads cleaner

- **Hardware registers are named.** MMIO refs Ghidra emits as raw addresses
  (`*0x2001`, `uRAM400e`) become the register name (`PPUMASK`, `NOISE_LO`), with a
  `/* hw registers: … */` legend — on the 9 platforms with a register map
  (NES/SNES/Genesis/GB/GBC/SMS/GG/2600/7800/C64).
- **6502 SLEIGH clutter folds to readable C** (NES/2600/7800/C64/Lynx/PCE). Width
  types become C99 stdint (`uint1`→`uint8_t`, `uint2`→`uint16_t`), redundant
  nested casts collapse (`(uint16_t)(uint8_t)x`→`(uint8_t)x`), and zero-page byte
  refs are named (`cRAM00fd`→`zp_FD`), with a `/* 6502 fold: … */` legend. A real
  banked NES function went from `*(xunknown1 *)(uint2)(uint1)(param_2 - 0xb)` to
  `*(uint8_t *)(zp_FE - 0xb)` — same semantics, far more readable. (The
  carry-flag-16-bit / BCD reconstruction is left to an LLM reading the output;
  rewriting it textually would risk changing semantics.)

#### Improved — bank-aware decompile + honest function ranking

- **Banked NES `decompile` resolves the bank.** Rizin reports flat-PRG VAs, so a
  flat decode was bank-blind (cross-bank `JSR`/`JMP` landed on the wrong bank).
  `decompile` now lays a real 32 KB CPU window (selected bank @ `$8000` + fixed
  top bank @ `$C000`) so in-bank *and* fixed-bank calls resolve; NROM falls
  through to the flat path. On a real banked game this moved a top-12 function
  list from ~1 readable / 11 garbage to ~10 readable / 2.
- **`disasm({target:'functions'})` is ranked real-code-first** with a
  `looksLikeData` flag (+ `dataCount`), so giant single-block data folds stop
  crowding out the actual control-flow routines you want.

#### Fixed / hardened

- **SMD-interleaved Genesis dumps auto-deinterleave.** A `.bin` in the SMD copier
  format (size = N·16 KB + 512, `0xAA 0xBB` magic) read flat decodes to pure
  "bad instruction" garbage; analysis now detects + reverses the interleave and
  warns, so a flat disasm isn't silently wrong.
- **C64 `.prg` load-address header is stripped** before analysis (the 2-byte load
  address was being analyzed as code), with the base applied so addresses line up.
- **Worker-pool timeout + recycle.** A whole-ROM `aaa` on a multi-MB ROM that
  never returns no longer wedges the shared WASM analysis pool — the call times
  out, the worker is killed + respawned, and a clean `{ timedOut }` result comes
  back (with a "use a scoped pass" hint) instead of every later `disasm` hanging
  until a manual server restart.

#### New op discovery

- **`platform({op:'capabilities', platform?})`** — the per-platform op-support
  matrix (CPU family, rendering kind, which introspection/debug ops each core
  actually wires), so an agent can check support before calling instead of
  catching a failure. Unsupported ops now throw a typed, structured error
  (`{ unsupported, platform, op, reason, alternative }`) rather than a bare string.

## 0.40.2 — 2026-06-11

### Fixed — SNES `disasm({target:'decompile'})` treated the address as a raw file offset

On SNES, `decompile` decompiled the function at raw FILE offset `address`, but
`functions` / `cfg` / `xrefs` all report LoROM/HiROM **CPU** addresses — so the
documented "decompile an address from `functions`" loop silently returned the
wrong function (e.g. asking for the entry at CPU `$00:8000` decompiled file
`0x8000` = CPU `$01:8000`, the wrong bank).

Fix: SNES now lays the cart out by **24-bit CPU address** — each ROM chunk is
placed at its CPU bank (LoROM `$bank:8000`, HiROM `$C0+bank`), with the
`$80-$FF` FastROM (and HiROM `$40-$7F`) mirrors filled in — then decompiles at
the CPU address directly. This fixes both the function lookup AND in-bank /
`jsl` operand resolution (a flat-at-0 image would mis-label every cross-bank
call). The CPU-addressed image is ~16MB sparse (zero-filled between banks); a
real 4MB cart decompiles in ~1.2s. (No change to the `romdev-analysis*`
packages — the fix is in the address-mapping JS.)

Note: 65816 decompiler output is medium quality (variable register width, BCD/
decimal-flag expansion, direct-page guards) — for SNES, lean on `cfg` / `xrefs`
+ targeted `decompile` of leaf routines over big dispatchers.

## 0.40.1 — 2026-06-11

### Fixed — Genesis `disasm({target:'decompile'})` was shifted +0x200

A Genesis decompile at a caller-supplied address silently returned the function
0x200 bytes too low (the wrong one, or an empty `{ return; }` / `halt_baddata()`),
with no warning. `cfg` / `xrefs` / `functions` on the same address were correct —
only `decompile` was off.

Root cause: Rizin's Mega Drive loader splits a flat `.bin` into vtable / header /
text segments and reports a non-zero address delta (`0x200`) on the code segment;
the decompiler's address mapping honored that delta, but the raw image handed to
Ghidra loads flat at offset 0, so the two disagreed by exactly 0x200. Fix: flat-
cartridge platforms (Genesis, SMS, Game Gear, MSX, Game Boy / GBC) now force
file-offset == CPU-address and ignore Rizin's segment delta. The 6502-family
platforms were unaffected (they use a separate base-address path). Regression
test added. (No change to the `romdev-analysis` / `romdev-analysis-decompiler`
packages — the fix is entirely in the address-mapping JS.)

## 0.40.0 — 2026-06-11

### Reverse-engineering analysis engine — control-flow graphs, deep xrefs, function detection, and a decompiler

A full open-source RE analysis layer, covering **all 14 platforms** with zero
proprietary dependencies. Two new binary packages carry the WebAssembly; the
main package gains four `disasm` targets and one `symbols` op that drive them.

- **`disasm({target:'functions'})`** — auto-detected function list
  (`{address, size, nbbs, cc, callers, callees}`): the structural map of an
  unknown ROM, the carve step before you label anything live.
- **`disasm({target:'cfg', address})`** — basic-block control-flow graph of the
  function at `address` (nodes + typed edges: jump / branch_true / branch_false).
- **`disasm({target:'xrefs', address})`** — every cross-reference TO `address`,
  following the analysis graph. Deeper than the flat `target:'references'` da65
  operand scan — prefer `xrefs` once a function pass has run, `references` for a
  quick header-less sweep.
- **`disasm({target:'decompile', address})`** — Ghidra C-like **pseudocode** for
  the function at `address`, with the decompiler's own warnings and a per-CPU
  `qualityNote`. Altitude rule: decompile is for UNDERSTANDING (and as a port
  spec when retargeting to a bigger machine) — `target:'project'` stays the
  byte-exact rebuildable edit path. Quality is excellent on ARM (GBA) and M68K
  (Genesis), good on SM83 (GB/GBC) and Z80 (SMS/GG/MSX), medium on 65816 (SNES)
  and HuC6280 (PC Engine), and rough on the 6502 family (an architecture limit —
  every tool is rough on 6502).
- **`symbols({op:'analyze'})`** — one-shot structural map of a ROM
  (auto-detected functions + strings + entrypoints), no `.dbg`/`.map` needed.

Built from pinned upstreams, fetch-on-demand, never vendored — only the compiled
artifacts ship (see `scripts/build-rizin.sh`, `scripts/build-decompiler.sh`,
`scripts/versions.json`):
- **`romdev-analysis`** — Rizin compiled to WASM (the CFG / xrefs / functions
  engine). LGPL-3.0.
- **`romdev-analysis-decompiler`** — Ghidra's C++ decompiler compiled to WASM
  (no JVM, no rizin) plus SLEIGH processor tables for all 14 CPUs. Apache-2.0,
  with full per-component attribution in the package NOTICE (Ghidra/NSA, and the
  community SM83 / 65816 / HuC6280 SLEIGH specs).

### Documentation: no commercial game titles in shipped source

Swept every shipped tool description, doc, README, mental-model guide, and the
ROM-hacking playbook for commercial game/franchise names and replaced them with
generic platform + hardware + mechanic descriptions ("a banked NES racer", "a
top-down dungeon-crawler shape"). Console and chip names are unchanged — they're
not anyone's IP. The bundled cheat database (third-party crowd-sourced data) is
unaffected.

### Tests build their own ROMs (no external fixtures)

Tests that needed a real ROM now build one from our **own example sources** at
runtime instead of depending on a ROM file on disk — so the whole suite runs
with no external/commercial ROM anywhere. Every previously-skipped fixture-gated
test now runs: **918 tests, 918 pass, 0 fail, 0 skipped**. (This also surfaced a
latent fidelity bug the silent skips had hidden: `wrapRomFromParts` dropped the
iNES battery-SRAM flag on round-trip — now preserved via a new `hasBattery`
field, and exposed on the `wrapRomFromParts` tool.)

## 0.30.0 — 2026-06-11

### RE-tooling round — the Cheat-Engine "locate a value + find its writer" workflow
From an NES reverse-engineering feedback batch. Six additions to the
memory/breakpoint primitives:
- **`memory({op:'searchUnknown'})`** — the unknown-initial-value hunt: seed the
  WHOLE region with no value, then narrow across in-game events with
  `searchNext({compare:'dec'|'inc'|'unchanged'|'changed'|'gt'|'lt'})`. Finds the
  lives/timer/ammo address you can't see on the HUD (`op:'search'` needs a value;
  this doesn't).
- **`memory({op:'diff'})` predicate filters** — `changeDir:'dec'|'inc'`,
  `deltaEq:N` (signed exact delta, e.g. −1 = "lost a life"), `beforeMin/Max` +
  `afterMin/Max` (value-range gates). A 500-byte death-window diff returns the
  ~3 rows you want in one call.
- **`memory({op:'diff'})` honors `outputPath` + `echo:false`** (was a bug — diff
  ignored `outputPath`; a big diff now routes to your path, not a harness path).
- **`memory({op:'readCart', cpuAddress, bank})`** — read cart ROM by a BANKED CPU
  address (NES/SNES), the inverse of the breakpoint result's bank/prgOffset; no
  more hand-computed `cpuAddr−0x8000+bank*0x4000`.
- **`breakpoint({on:'write', condition})`** — stop on the MEANINGFUL write, not
  restoring churn: `condition:'increase'|'decrease'` (the stored byte actually
  moved that way) or `'equals'` + `conditionValue` (became N, e.g. a $00→$01
  re-arm). Reports `oldValueByte`→`valueByte`. Live on **all 14 platforms** (11
  emulator cores rebuilt to capture the pre-write byte). Also clarified in the
  tool note that `on:'write'` runs to end-of-frame and reports the LAST matching
  write (`hits` = count).
- **Tool-schema slim** — dropped the inlined ~62-value region enum from every
  SECONDARY region sub-param (`watch` per-range `ranges[].region`, `recordSession`
  `memorySamples[].region`, and both `runUntil` memory conditions); they're now
  runtime-validated strings, trimming the deferred-load schema cost the feedback
  flagged. The ONE primary discoverable enum (`watch` on:'mem' single-range
  `region`, where the region IS the choice) is intentionally kept. **Bonus fix:**
  the `runUntil` region was a STALE hardcoded 8-value list that silently
  schema-rejected valid non-NES regions (`genesis_cram`, `c64_color_ram`,
  `nes_apu_regs`, …) the handler actually supports — now accepted.

### Core rebuilds
11 emulator cores rebuilt for the value-conditioned write breakpoint (bump +
republish each): fceumm, snes9x, genesis-plus-gx, gambatte, mgba, handy,
geargrafx, prosystem, stella2014, bluemsx, vice. **Build fix (latent, was on
main):** the bluemsx region patch carried a duplicate Makefile CFLAGS hunk
identical to the build patch's; since `git apply` is atomic, that made the whole
region patch silently fail to apply — the watchpoint/region exposure was being
dropped from the build. Removed the duplicate hunk.

## 0.29.0 — 2026-06-11

### Examples — the complete-game library, finished & made honest
- **The 14×5 grid is complete (70 games).** Every platform now ships all five
  canonical genres. The last gap, the Atari 2600 puzzle, ships as **TILE TWINS**
  — a memory match-pairs game (a real puzzle: a static, turn-based board drawn
  as full-width COLUPF bands, the honest TIA fit — not a colored match-3 grid the
  TIA can't render). Forkable via `examples({op:'fork', example:'atari2600/puzzle'})`.
- **C64 games now SAVE for real — 1541 disk save.** The honest C64 medium is the
  floppy (no battery SRAM). All 5 C64 games write a hi-score/record to a SEQ file
  on drive 8 via the KERNAL; run from a `.d64` it commits to the live disk and
  `state({op:'exportDisk'})` captures it (reload restores it). As a bare `.prg`
  there's no mounted disk, so it's an honest in-session no-op. (Replaces the old
  gated no-op seams — the VICE core already supported writable-disk write-back.)
- **C64 two-player now works.** The VICE core drove only one control port per
  RetroPad; host port-1 (P2) input never reached the game. Now both standard
  control ports are live (host port 0 = P1, host port 1 = P2) — verified by
  driving both paddles independently in the versus games.
- **PCE save claim corrected (honesty).** A bare HuCard cannot save — BRAM is
  peripheral-only (CD-ROM² / Tennokoe Bank / Memory Base 128) on real hardware.
  The 5 PCE games no longer claim a battery save; they keep an honest in-session
  hi-score, with the BRAM mapping documented in-file as the real-hardware path.
- **Honest framing.** The examples are described as SCAFFOLDING, not showcases:
  the gameplay is intentionally thin — their value is the working boot sequence,
  APIs, and syntax to fork from. Superlatives dropped from the `examples` tool
  doctrine and the generated project README.

### Added — livestream frame coverage: see what the agent is doing
- **Most state-changing tools now emit the post-call frame to /livestream**,
  at zero cost to the agent (deferred PNG encode after the response goes
  out): `frame({op:'step'})`, `input` set/press/sequence/navigate,
  `state({op:'load'})`, `loadMedia`, `host({op:'reset'})` (soft + hard),
  `runUntil`, `cheats({op:'apply'})`, and `cpu({op:'call'})` — joining the
  breakpoint/watch hits, verify, and stepInstruction that already emitted.
- **Throttled to one frame per 2s per (session, tool)**, trailing-edge: a
  frame-step loop can't flood the stream and its LAST frame always lands;
  different tools back-to-back all show; multiple agents on one server
  never throttle each other.
- **`call_frame` events carry a caption** (`step ×30`, `press start`,
  `state load boss`, `loaded game.nes`) and the livestream UI shows it on
  the image card — the stream reads as a narrative.
- **To-disk renders now reach the stream too**: `tiles({op:'preview'})`,
  `extractSpriteSheet`-style file renders, and `encodeArt` quantize/crop
  attach the PNG as an observer sideband when routed to `outputPath` — the
  human sees the render even though the agent only gets a path.

## 0.28.0

The reverse-engineering release: the three RE primitives — break-instant
`registersAtHit`, interference-free `pure` CPU calls, and the
`watch({on:'copy'})` graphics source-trace — now work on ALL 14 platforms
(every emulator core rebuilt; upstream pins unchanged, everything carried by
the patches in `scripts/patches/`). Plus the full scaffold overhaul from real
RetroDECK playtesting, banked-cart parity for disasm/rebuild, the value-search
upgrades, and the playtest co-drive detection. Details per section below.


### Added — pure calls + the generic copy trace on ALL 14 platforms (primitives #2 and #3)
The other two primitives from the all-platforms RE proposal, completing the
set (registersAtHit was #1):
- **`cpu({op:'call', pure:true})` works everywhere.** The guarantee is the
  same on every platform — the game's own NMI/IRQ/VBlank logic CANNOT run
  during the call and stomp the routine's output buffer — with the mechanism
  reported as `pureMode`: Genesis/SMS/GG step ONLY the CPU (`'cpu-only'`,
  the gpgx separable-loop path); every other core suppresses interrupt
  DELIVERY for the duration (`'irq-blocked'` via a new `romdev_irqblock_set`
  export — pending lines stay pending, video/timers advance harmlessly, no
  game handler executes); the 2600's 6507 has no interrupt lines at all
  (`'no-interrupts'`). Proven live on NES: NMI delivery verified firing,
  then silent under the block, then a planted routine pure-called
  end-to-end with its write landing.
- **`watch({on:'copy'})` — the generic "where does this graphic come
  from?".** Logs every write landing in a VRAM/dest address window with the
  EXECUTING instruction's PC. Port-based video memory is hooked INSIDE the
  cores — NES $2007, SNES $2118/19 (BOTH CPU port writes and the DMA path —
  the PC is the DMA-triggering instruction), PCE VWR, MSX VDP data port,
  SMS/GG/Genesis VDP data port (the CPU-port complement of the Genesis DMA
  watch). Direct-mapped platforms (GB/GBC, GBA, C64, Lynx, 7800) route
  through the CPU-address range log automatically. Follow a hit with
  breakpoint({on:'pc', address: pc}) for registersAtHit at the uploader.
- Cores rebuilt again (same pins; the scripts/patches/ diffs carry
  everything — all 11 verified to apply clean to pristine checkouts).
- `test/pure-copy-primitives.test.js`: the 13-core irq-block/run-pure
  feature matrix, NES NMI-delivery proof + end-to-end pure call, MSX
  block-safety, and copy traces on NES (port), SNES (port+DMA), GB (mapped).

### Fixed/Added — registersAtHit + freeze-after-hit on ALL 14 platforms (every core rebuilt)
The gpgx round's break-instant fixes, extended to every other core — the same
three guarantees now hold across the whole platform matrix:
- **`registersAtHit` everywhere** — every breakpoint hit (pc-break, watchdog,
  write-watch, read-watch) on every platform freezes the FULL register file at
  the hit instant inside the core hook, exported via `romdev_regsnap_get` and
  surfaced in the breakpoint hit response. Per-CPU register sets: 6502 family
  (NES/2600/7800/C64/Lynx/PCE) A/X/Y/P/S/PC; 65816 (SNES) +DB/D; sm83 (GB/GBC)
  A/F/B/C/D/E/H/L/SP; Z80 (SMS/GG/MSX) +IX/IY; m68k (Genesis) D0-7/A0-7/SR;
  ARM7 (GBA) r0-r15/CPSR. NES previously snapshotted pc-breaks only — its
  write/read hits now snapshot too.
- **Freeze-after-hit everywhere** — once a hit fires, the CPU run loop stays
  frozen (across re-entries and frames) until the host clears the hit, so even
  live register reads agree with the snapshot. Previously each core resumed on
  the next loop re-entry and the registers drifted.
- **Executing-instruction PC everywhere** — write/read watchpoints and range
  logs report the EXECUTING instruction's first byte, latched at dispatch
  (sm83/Z80/65816/6502 PCs advance past operands mid-instruction — the same
  off-by-one class the gpgx round fixed for m68k; GBA reports the pipeline PC,
  matching its breakpoint-address convention).
- Cores rebuilt: fceumm, snes9x, gambatte, mGBA, handy, vice, stella2014,
  prosystem, geargrafx, bluemsx (pins unchanged; the romdev patches in
  scripts/patches/ carry all of it — the whole stack reproduces from a clean
  clone). `cpu({op:'call', pure:true})` remains gpgx-only (the other systems'
  CPU/video loops are not separable without deeper core surgery); their calls
  carry the ⚠ frame-logic caveat instead.
- `test/regsnap-all-cores.test.js`: live single-step snapshot + freeze proof
  on 10 platforms (plus the existing gpgx suite for Genesis/SMS/GG).

### Fixed/Added — gpgx core round (a both-consoles sports-title feedback): break-instant truth on Genesis/SMS/GG
The first core rebuild in this release (gpgx only; pins unchanged, patch extended).
- **`registersAtHit` on Genesis/SMS/GG** — `breakpoint({on:'pc'|'write'|'read'})`
  hits now carry the FULL register file (m68k d0-d7/a0-a7/pc/sr/sp; z80
  a/f/b/c/d/e/h/l/ix/iy/pc/sp) frozen by the core AT the hit instant. gpgx
  schedules CPUs per scanline, so the live register file used to drift
  hundreds of instructions past a hit before the host could read it — the
  "wrong-pointer chases" that cost a real RE session ~2h. On a pc-break the
  CPU now also stays FROZEN for the remainder of the frame (and across
  frames until the hit is cleared), so even live reads agree.
- **Write/read watchpoint PC is the EXECUTING instruction** — the hooks now
  record the instruction's first-byte address latched at dispatch, not the
  post-prefetch PC (the orb-at-$2A7216-reported-as-$2A721C off-by-one).
  `breakpoint({on:'write'})` also renames `value`→`valueByte` (it's the one
  byte that landed, not the operand) and explains its `hits` semantics.
- **`cpu({op:'call', pure:true})`** — steps ONLY the active CPU (new
  `romdev_run_pure` export): no VDP line processing, no co-CPU, no interrupts
  raised — so the game's own VBlank logic can NOT run "concurrently" and
  stomp the driven routine's output buffer (a real session diffed a correct
  codec reimplementation against that poisoned output for ~1.5h). Non-pure
  calls that spanned frames now carry a loud ⚠ caveat naming the risk and
  the fix.
- **Genesis `system_ram` normalized to CPU byte order** — gpgx stores 68k
  work RAM host-LE word-swapped (`work_ram[A^1]`); the raw layout leaked
  through every byte-granular tool. Self-consistent within search→write
  loops (which is why it hid — even a test had the swapped bytes baked in as
  the expected value), but off-by-XOR-1 the moment an offset crossed to/from
  disassembly addresses or cheat-DB maps. Offset X now IS the byte the 68k
  sees at $FF0000+X; words read big-endian as documented. This also fixes
  `cpu({op:'call'})` sentinel pushes / `presetMemory` writes for any non-zero
  sentinel address (the default $0 sentinel was swap-invariant, hiding it).
- breakpoint hit responses normalize `hits` (a watchdog stop no longer
  reports the contradictory `hit:true, hits:0`).
- Docs: the held-input menu trick (when a `pressDuring` schedule never
  registers on a menu screen, hold via `input({op:'set'})` and omit
  pressDuring — runs inherit held input) is now in the breakpoint/watch tool
  docs; the server banner prints a one-line headless note when no display is
  available (so an agent knows before promising a playtest window).
- `test/gpgx-registers-at-hit.test.js`: live-core coverage for all of it,
  including a per-platform Genesis memory-read smoke (the earlier
  "info is not defined" regression was invisible to a fake-host-only suite).


### Fixed/Added — value-search upgrades (from the locate-value skill review)
- **Relative compares work as the FIRST `searchNext`.** `op:'search'` now
  baselines every candidate at seed time, so `compare:'inc'/'dec'/'changed'/
  'unchanged'` no longer silently return 0 candidates on the first narrow
  (the footgun a real session burned rounds on and a skill had to document —
  the "do one eq round first" workaround is obsolete).
- **Representation-aware search** — `memory({op:'search', as:'bcd'|'digits'})`
  for the stored≠displayed cases: `'bcd'` matches packed-BCD values (2 decimal
  digits/byte, region endianness — classic NES scores); `'digits'` matches one
  byte per ON-SCREEN digit at ANY constant tile base (HUD digit/tile-index
  buffers; the base is auto-detected per candidate and reported; single-digit
  seeds only accept base 0/0x30 to avoid matching everything). `searchNext`
  narrows in the seed's representation automatically, including numeric
  `inc`/`dec` on decoded values. Works on all platforms/regions (endianness
  per region, big-endian m68k included).
- **search/searchNext response notes fixed** — they recommended the dead
  `searchValue` name and a `writeMemory({bytes})` form that op:'write'
  REJECTS; now they name the live ops with a `hex` payload, mention the
  scene-changed-mid-step empty-round trap, and point input-driven values at
  `diffRuns`. Same stale-name fix in two `watch` tool notes.
- `test/search-representations.test.js` covers all of it.


### Added — banked-cart parity across ALL platforms (per-bank references + rebuild glue)
The 0.27.0 feedback round fixed per-bank reference scanning and one-call banked
rebuild glue for NES only. Every other banked-cart platform now gets the same
treatment:
- **`disasm({target:'references'})` scans EVERY bank on every banked format** —
  SNES multi-bank LoROM (was: only the first 32KB bank), GB/GBC MBC and SMS/GG
  Sega-mapper and MSX megaROM (was: only the first 32KB), Atari 2600 F8/F6/F4
  (was: only the boot bank), Atari 7800 (was: only the top 16KB — flat carts now
  scan the WHOLE image, SuperGame carts per-bank), and >32KB HuCards (was: a
  wrapped, garbage start address). Non-NES refs carry a `romBank` tag (NES keeps
  `prgBank`). Very large carts scan the first 64 banks and SAY SO in `notes`.
- **`disasm({target:'project'})` splits every banked format per-bank** so
  instructions never straddle a bank edge: Sega-mapper SMS/GG (16KB banks),
  MSX megaROMs (16KB banks + the "AB" header as its own data region), banked
  2600 (4KB banks), 7800 SuperGame (16KB banks + the .a78 header split out),
  >32KB HuCards (8KB pages + optional copier header split out).
- **Atari 7800 SuperGame and PC Engine HuCards (flat AND banked) get one-call
  byte-identical `build()` rebuilds** — their asm toolchain is cc65/ca65, the
  same match that made NES one-call. NES-style glue: HEADER segment carrying
  the original header bytes, per-bank segment wrappers, generated multi-bank
  `.cfg` via `linkerConfigPath`. **PCE was previously the one honestly-LOSSY
  case** (planRegions trimmed real $FF padding and didn't strip copier
  headers) — both fixed, `verifiable:true` now.
- **SMS/GG, MSX, and 2600 banked carts get per-bank native rebuild recipes**
  (their `build()` is SDCC/DASM — can't consume the disasm syntax): per-bank
  wrappers + cfg blobs (2600), bank-by-bank `as`/`objcopy`/`dd`/`cat` recipes
  in `BUILD.md` (SMS/GG/MSX), all byte-exact.
- Proven by `test/banked-parity.test.js`: synthetic banked carts on 7 platforms;
  byte-identical one-call rebuilds verified end-to-end for 7800 SuperGame,
  banked PCE, and flat-PCE-with-real-padding.


### Fixed — scaffold overhaul from real RetroDECK/Bazzite playtesting (all 14 platforms)
A full human playtest of every genre scaffold on real hardware surfaced clusters
of repeated logic errors. The big ones:
- **SMS/GG: every `build({output:'project'})` ROM black-screened** — the project
  recipe skipped the dir's `*_crt0.s` believing `buildForPlatform` auto-injects
  the bundled crt0 (it doesn't; only the rom/run handlers do), so SDCC's stock
  z80 crt0 linked instead and `main()` never ran. Also: the bundled crt0's reset
  block was 9 bytes (overflowed into the `.org 0x0008` RST slot, corrupting
  `jp gsinit`), `_CODE` linked at `$0000` ON TOP of the vector table, and `.gg`
  ROMs got an SMS region nibble (`$4C`) that flips Genesis-Plus-GX into SMS-compat
  mode. Project builds now route/fall back to the bundled crt0, `_CODE` sits at
  `$0100`, GG ROMs get region `$7C`, ROMs pad to 32KB before the TMR SEGA header,
  and a regression test pins the boot byte + header. The SMS scaffold now ships
  `sms_crt0.s` like GG/MSX.
- **"All enemies spawn on the left"** (18 shmup/racing templates): spawn X/lane
  came from `spawn_timer`, which the caller resets to 0 immediately before
  `spawn()` — a constant. Each template now has a Galois-LFSR `rand8()`.
- **Puzzle genre**: the gbc template is now the polished falling-jewel reference
  game (4-direction matches, gravity + cascade chains, magic piece, SFX + music,
  collect/flush vblank rendering, dataLoc `$C200` via the gb/gbc project recipe);
  the DMG gb template is rebuilt around the same core; and the
  mark/clear/gravity/cascade core is ported to all 10 other platforms (PCE: H+V
  in its 8KB boot bank). Replaces a horizontal-only scan that missed vertical/
  diagonal matches, half-cleared 4+ runs, and never dropped survivors.
- **Atari 2600**: SWCHA ASL carry-chains clobbered A between shifts (pressing
  RIGHT also "pressed" LEFT — the stuck-to-the-left-edge bug) in three templates;
  the platformer's terminal-velocity clamp caught POSITIVE velocities (unsigned
  CMP), killing every jump within one frame; sports' paddle axis was inverted vs
  the kernel's Y convention and RESBL was never strobed (the ball NEVER moved
  horizontally — per-frame div-15 + HMBL positioning added); racing re-randomizes
  both lanes on crash; shmup aliens reaching the cannon reset the wave.
- **Atari 7800**: the SWCHA joystick bit defines were exactly REVERSED on every
  template (up/down steered left/right; sports' left/right moved the paddle
  vertically). Plus speed tuning (platformer movement + jump, puzzle fall rate,
  sports serve).
- **Platformers**: GBA fell through every platform (the `blocked_below` gate
  only matched a 1px window at 20px/frame fall speeds); SNES platforms are now
  visibly drawn on the scrolled text layer (were invisible collision rects);
  Lynx landing uses a crossing test (exact-equality check tunnelled); C64
  `render_view` rewritten ~20x faster (a per-CELL platform scan + 16-bit modulo
  cost ~2s per 8px scroll step at 1MHz — froze the game and ate jump presses);
  NES player is red (was sky-blue on sky-blue) and moves 2px/frame; GB/GBC jump
  height tamed.
- **GBA sports "never starts"**: `tte_printf` (broken in this libtonc — the
  documented GBA-1 issue) ran every frame and crashed with an undefined-
  instruction exception on iteration 1. Replaced with the `tte_write` digit path
  the other templates already use.
- **SNES**: each genre now gets a distinct backdrop tint (every scaffold shipped
  the same blue checkered wallpaper).
- **Sound everywhere**: every scaffold now has a continuous background-music
  loop plus audible SFX, verified per platform by recording + RMS analysis.
  Genesis/Lynx tick a melody inside `sfx_update()` (no template wiring; Lynx
  voices 64→100), NES adds a triangle-channel melody to `nes_runtime`, PCE a
  ch5 melody with corrected volume (the 5-bit field is ~-1.5dB/step from 31 —
  the old 13 was -27dB, near-silence; the shmup SFX are maxed), and the SMS/GG
  3-voice tracker that already shipped is now actually STARTED by all 11
  templates. **MSX root cause**: `msx_crt0.s` had the same `_INITIALIZER`-in-RAM
  bug fixed for SMS/GG (every `static x = N` booted 0) plus a BIOS-KEYINT
  PSGADDR-latch race (PSG writes now DI/EI-guarded) — both fixed; this likely
  also explains the reported MSX sprite flakiness.
- **GB/GBC sports scanline tear**: the OAM DMA now fires at the vblank leading
  edge (45 staged `oam_set` calls used to push it a third of the frame into
  active display — the "horizontal line a 3rd of the way down" glitch).
- Misc per-genre polish: PCE gameplay speeds, C64 racing clears the BASIC
  startup text, C64 sports court widened to the 9-bit sprite range, MSX/Lynx
  sports contrast, GBA puzzle well border.
- **Verification**: all 69 existing platform×genre scaffolds were swept —
  scaffold → project build → boot → render-health green, all 14 platforms
  respond to input, and each platform's audio was captured and RMS-checked.
  (Atari 2600 has no puzzle genre by design.)

### Fixed/Added — the 0.27.0 NES RE feedback round (banked-NES rebuilds, A/B diff, token cuts)
- **Banked NES `disasm({target:'project'})` now emits COMPLETE, working rebuild
  glue** (the headline ask): a `HEADER` segment with the original 16 iNES bytes,
  a per-bank `PRGn` segment wrapper for every bank, a multi-bank `nes_rebuild.cfg`
  (switchable banks at `$8000`, fixed top bank at `$C000`, CHR wired when
  present), and a `rebuild.json` `build()` call referencing all of it. Proven
  byte-identical on a synthetic 4-bank mapper-2 ROM fed straight back to
  `build()` — what previously took an hour of hand-written segments + cfg is
  now zero glue. (NROM keeps the existing proven `inesHeader` one-call path.)
- **`build({linkerConfigPath})`** reads the `.cfg` from disk so a large
  multi-bank config never streams through context (and `rebuild.json` uses it).
- **`disasm({target:'references'})` scans every PRG bank on banked NES** —
  the old flat-blob-at-`$8000` disassembly returned `refsFound:0` on >32KB
  ROMs. Refs now carry a `prgBank` tag, and `#$nn` immediates no longer count
  as references (they're values, not addresses).
- **`memory({op:'diffRuns'})`** — the A/B input-diff primitive: runs the same
  start state twice under two different held inputs (savestate restore in
  between) and returns only the divergent bytes, with run-A/run-B values for
  small clusters. Replaces the save/run/dump/restore/run/dump/python-diff loop
  (~6 calls + a 4KB context hit) with one call; live-verified isolating an NES
  player-X byte.
- **`memory({op:'read'/'readCart', outputPath, echo:false})`** returns just
  `{path, bytes}` — no more ~4KB hex echo on a 2KB dump that was explicitly
  routed to disk.
- **`memory({op:'diff'})`**: summary clusters ≤8 bytes now include
  `before`/`after` hex (no more falling back to `view:'raw'` for the values),
  and `minDelta` filters RNG/counter wiggle.
- **`input({op:'press'})` guarantees a released→pressed edge** (one released
  frame first), so edge-triggered handlers (START pause) can't miss the press
  when the button was already held.
- **`breakpoint({on:'pc'})` misses now diagnose**: report `pcNow`, stop
  suggesting `pressDuring` when input WAS supplied (wrong-address is then the
  likely story), and point at `watch({on:'pc'})` coverage tracing.

### Added — human co-drive detection: agents now KNOW when a human is playing in the playtest window
The long-standing confusion ("they get confused when I try to play while they're
coding") had a real mechanism: the playtest window shares the session's ONE
emulator host with the agent, and its 60fps tick wrote the human's pad state —
including all-zeros when nobody was pressing — over the agent's `input({op:'set'})`
every frame. The agent had no signal a human was co-driving and no warning that
its input was being clobbered. Now:
- **The window only writes input while the human is actually pressing** (pad,
  keyboard, or rewind-scrub), plus one release write after they let go. An idle
  window no longer silently clobbers the agent's held input. The human still wins
  the instant they press.
- **The window tracks human activity** ("pressed within the last ~2 s" ≈ 120
  ticks) and exposes it: `catalog({op:'status'})` reports `playtestWindowOpen` +
  `humanInputActive` (+ `framesSinceHumanInput`), and `playtest({op:'status'})`
  reports the same.
- **`frame({op:'step'/'stepAndShot'})` and `input(set/press/sequence/navigate)`
  responses carry a `humanCoDriveWarning`** while the human is actively playing,
  telling the agent the conflict is happening NOW and pointing at the escape
  hatches: `host({op:'pause'})` to inspect frozen, or a second session
  (different `x-romdev-session` = fully isolated emulator) for deterministic work.
- The playtest tool's FOOTGUN doc now describes the real contract (real-time
  stepping always races; input only clobbered while the human presses).

### Changed — `screenshot` scale docs: native is the accurate default, upscale adds no detail
The `scale` param's docs oversold integer UPscaling as making tiny handheld shots
"legible." That was misleading: nearest-neighbor upscale just duplicates pixels —
it adds **no information** the native frame doesn't already have, costs more image
tokens, and since VLM vision encoders resize every input to their own fixed
resolution it may not change what the model sees (and can slightly degrade it via a
bicubic downscale of stretched pixels). Reworded the param + tool description to
lead with **native (`scale:1`, the default) = perfect pixels = the accurate
representation**, keep the genuinely-useful DOWNscale (`<1`, fewer tokens for
"did it change?" checks), and frame upscale honestly as a last resort for clients
that can't zoom a small image. (No behavior change — `scale` was already opt-in and
defaulted to native; this is the docs telling the truth about it.)
(Committed during the 0.27.0 cycle but AFTER 0.27.0 published — ships in 0.28.0.)

## 0.27.0

### Added — `breakpoint(on:'pc', captureMemory:[…])` reads named RAM at the hit
Completes item 2 of an NES action-game RE report. 0.26.0 shipped `registersAtHit` (the
break-instant register file) but not the memory half. Now `breakpoint(on:'pc')`
takes `captureMemory:[{region,offset,length,label}]` and returns those reads inline
as `capturedMemory`, so register + RAM inspection at a PC collapses into ONE call —
no follow-up `cpu`/`memory` round trips. `registersAtHit` is the true break instant
(core snapshot); `capturedMemory` reflects the routine's RAM side effects for the
hit frame (stable + what RE needs), documented as such.

## 0.26.0

### Fixed — NES `breakpoint(on:'pc')` now returns reliable break-instant registers
An agent RE'ing an NES action game found that after a `pc` breakpoint hit, a follow-up
`cpu({op:'read'})` returned the **idle-loop PC**, not the breakpoint instruction —
the documented "break, then read the live register file" workflow gave end-of-frame
state. Root cause: fceumm drains the cycle budget on hit but `retro_run` still
finishes the frame, so the live X6502 registers are clobbered before the host reads
them (the schema's "CPU is FROZEN at this instruction" was wrong for NES).
- **fceumm core rebuild** (romdev-core-fceumm 0.8.0): the PC-break handler now
  SNAPSHOTS A/X/Y/P/S at the hit instant, exposed via `romdev_pcbreak_get`.
- **`breakpoint(on:'pc')` returns `registersAtHit`** — the reliable break-instant
  register file. The schema + hit note now steer to it and explicitly warn that a
  live `cpu({op:'read'})` after a hit is end-of-frame state on fceumm. (The
  `captureMemory` companion that reads named RAM inline at the hit landed in 0.27.0.)
- **NES `cpu({op:'read'})` core-internal fields relabeled** (item 3): `DB`,
  `IRQlow`, `tcount`, `count` are fceumm internals (data-bus latch / IRQ bitmask /
  cycle counters), not 6502 registers — moved out of `registers` into a labeled
  `coreInternal` object so they're not misread as CPU state.

### Added — `/livestream` shows the SYSTEM (platform) on every tool call + frame
A human watching `/livestream` on a multi-agent server saw the session id + tool
name, but not WHICH console each call/frame belonged to. Every observer event now
carries `platform` (the session host's loaded system — nes, genesis, …), surfaced
as a badge on the log row and the frame card. Wired on BOTH transports (the MCP
observer middleware and the REST tool registry), resolved AFTER the handler runs so
a `loadMedia` / `build({output:'run'})` that sets the platform mid-call labels its
own frame correctly. Null until a ROM is loaded.

## 0.25.0

### Added — C64 input scripting + verification (RE startup-flow telemetry)
Follow-up to the 0.24.0 C64 keyboard work: an agent RE'ing a C64 shoot-'em-up could now
press keys, but couldn't (a) script a keyboard+joystick startup TIMELINE in one
call, or (b) tell whether a non-responsive key reached VICE at all. Both added — no
core rebuild (the `c64_cia1_regs` region + key matrix already existed):
- **`recordSession` `inputScript[].keys`** — hold C64 keyboard keys from a frame
  until the next entry, interleaved with joystick `ports`, in one deterministic
  timeline (e.g. `{atFrame:0,keys:['f1']},{atFrame:30,ports:[{b:true}]},
  {atFrame:60,keys:['run/stop']},{atFrame:90,keys:[]}`). `ports` is now optional
  (a step may set just keys). Unknown keys are **rejected with a clear error**, not
  silently ignored.
- **`input({op:'pressKey', verify:true})`** — also samples CIA1 **`$DC00`/`$DC01`**
  (the keyboard/joystick scan ports the KERNAL reads) **before / during (key held)
  / after**, plus matrix coords + active joyport. Lets you distinguish "my key
  never reached VICE" (`before==during`) from "VICE saw it but the game ignored it"
  (they differ, no reaction) when a C64 game doesn't respond.

### Changed — `scaffold` no longer echoes the vendored toolchain manifest
`scaffold({op:'project'|'game'})` used to return a flat `files[]` of EVERY written
file — including the toolchain copies (35 of 44 entries on NES, **173 of 264 on
GBA**, ~270 on SGDK Genesis) that an agent never touches. Across a matrix run (one
game × every genre × every platform) that was ~100 KB of pure vendored-path lists
in context with zero decision value. Now the response is a compact receipt:
- `files` — only the project-**OWNED** files you edit (main source, runtime, crt0,
  cfg, README).
- `fileCount` (total written) + `vendorFileCount` (the summarized vendored copies,
  on disk if you ever need them).
- `verbose:true` restores the full flat list as `allFiles`.

"Owned" is classified by what a file **is**, not just a `vendor/` prefix — so it
correctly excludes the SDK header trees the GBA (libtonc `include/`+`sysinclude/`)
and Genesis (SGDK `include/`) toolchains drop OUTSIDE `vendor/`, plus prebuilt
`crt*.o` / `*.a` / `*.lib`. (The initial fix used a `vendor/`-prefix denylist and
missed exactly those two SDK platforms — caught + fixed via a 0.24.0 matrix-run
report. GBA dropped 173→9 owned, Genesis 82→13.) Mirrors the `inline`/`outputPath`
choose-your-payload pattern the snippets op already had.

### Changed — scaffold README + `nextStep` lead with `build({output:'project'})`
The generated project README and the scaffold's `nextStep` now lead with the
one-call **`build({output:'project', platform, path, outputPath})`** form (infers
toolchain/crt0/linker from the directory — no `sourcesPaths`/`includePaths`/
`linkerConfig` to hand-specify), and demote the verbose `output:'run'` + manifest
form to a collapsed "compiling edited loose source" alternative. The project-dir
build was already the easier path; now it's the one a fresh agent copies first.

### Fixed — SMS shmup + Atari 7800 sports scaffolds rendered with wrong colors
Both built and booted but looked broken (a 0.24.0 matrix report flagged them):
- **SMS shmup** rendered the starfield as blue/**GREEN** striped bands. The BG
  palette had colour 1 = `0x08`, which in SMS 2-2-2 BGR is green (G bits), not the
  "deep space blue" the comment claimed. Fixed to a pure-blue depth gradient
  (`0x10/0x20/0x30`) — the bands now read as space, dominant colour went green
  `#00aa00` → blue `#0000ad`.
- **Atari 7800 sports** rendered a near-black playfield that looked dead. Two MARIA
  colour-byte bugs: the court walls used `0x48` (hue 4 = RED → **pink**, not the
  intended blue) and the court floor was `0x00` (black, indistinguishable from a
  blank screen). Fixed to blue walls (`0x8A`, hue 8) + a dark-green court floor
  (`0xB4`) — now reads as an actual court (dominant black → green `#008221`).

Both verified by screenshot + `frame({op:'verify'})`. (These were colour-value
bugs in the scaffold templates, not the render pipeline.)

### Removed — `catalog({op:'whatsNew'})` + the old→new tool rename table
`whatsNew` returned a 125-entry map of pre-1.0 renamed tool names (plus, until now,
~1.4k tokens of inlined CHANGELOG prose) so an agent resuming an old handoff could
re-map a tool that had moved. The pre-1.0 consolidation is long settled — the old
names are git history, and no running agent carries them — so maintaining a
forever-growing rename record (and risking it landing in context) wasn't worth it.
Dropped the op, the `tool-manifest.js` map, and its tests. An agent that hits an
unknown tool name now just reads the current surface (`catalog({op:'categories'})`
or the tool list); full release notes remain in CHANGELOG.md for humans.

## 0.24.0

### Added — C64 keyboard + joyport input (VICE core patch)
An agent RE'ing a C64 shoot-'em-up could reach the intro via joystick but couldn't ENTER
gameplay — the game needs **F1** (1 player) + fire on **port 2**, and romdev's
input was joypad-mask-only. Many C64 games gate gameplay behind KEYBOARD setup
screens that joystick can't reach. The VICE core now exports
`romdev_key_matrix`/`romdev_kbdbuf_feed`/`romdev_joyport_*`, surfaced as:
- **`input({op:'pressKey', key})`** — press a C64 keyboard key (F1/F3/F5/F7,
  Return, Space, Run/Stop, a–z, 0–9, …) by driving the C64 8×8 key matrix.
- **`input({op:'typeText', text})`** — feed a string into the kernal keyboard
  buffer (LOAD/RUN/filenames); `\r` → RETURN.
- **`input({op:'joyport', joyport?})`** — read/set the active C64 joystick port
  (1 or 2; default 2, most games).
- `input({op:'layout', platform:'c64'})` now reports the keyboard keys + joyport.

**A controller alone plays C64** (the Batocera/RetroDeck model — no physical
keyboard needed). Spare pad buttons/stick map to the C64 keyboard keys games need
to start: X/Space=Space, L2=Run/Stop, R2=Return, top face / right-stick =
F1/F3/F5/F7; d-pad + Fire stay the joystick. Unified in the host so it works the
same in the playtest window AND for the agent's headless `setInput`. No-controller
keyboard fallback maps PC F1–F4/Space/Enter to the same C64 keys.
`playtest({op:'open'})` on a C64 game relays the controls. (romdev-core-vice 0.7.0.)

### Changed — leaner, less-confusing agent docs (AGENTS.md / SKILL.md)
AGENTS.md was loaded in full every session for every platform — ~30k tokens, of
which ~13k was platform-specific or duplicated detail an agent on one platform
never needed (and could misapply across platforms). Cut **~31% (~9.5k tokens)**:
- Per-platform debug-tooling detail → each platform's `MENTAL_MODEL.md`.
- The ROM-hacking workflow → folded into the `ROMHACKING_PLAYBOOK.md` guide.
- Toolchain landmines → per-platform `TROUBLESHOOTING.md`/`SDCC_GOTCHAS.md`.
- Disassembler flag reference → it's already in the disasm tool's own schema.
All reachable on demand via `platform({op:'doc'})`; AGENTS.md keeps generic
guidance + symptom→doc pointers. **"Read your target platform's
`platform({op:'doc', name:'mental_model'})` BEFORE you write code for it"** is now
a top-level rule (the footguns live there) — so the on-demand docs actually get
read. The dynamic SKILL.md inherits all of this.

## 0.23.0

Response to real build-session feedback. Theme: bugs found, false alarms
removed, and — the recurring finding — **tools that already existed but agents
couldn't find them**.

### Fixed — multi-tenant host cross-talk (a whole class of bugs)
`sprites({op:'inspect', platform:'genesis'})` returned a *GBC*-flavored error while
Genesis was loaded. Root cause: `inspectSpritesCore` / `getCPUStateCore` /
`getAudioStateCore` / `inspectBackgroundMapCore` / `inspectPatternTilesCore` were
module-global `export let` bindings reassigned per session, each closing over THAT
registration's `sessionKey` — so the last session to register stole the host for
everyone. Now the caller's `sessionKey` is threaded through. Verified on all 7
tile-based sprite platforms with sessions live simultaneously.

### Fixed — SMS/GG C crt0: `static x = N;` initializers booted to 0
Investigating two reported "silent sm83 miscompiles" (32-bit xorshift, indexed
loop): NEITHER reproduces on GB/GBC — both produce byte-exact output. The real bug
was a genuine **z80 crt0 defect**: `sms_crt0.s`/`gg_crt0.s` placed `_INITIALIZER`
in RAM not ROM, so the gsinit `ldir` copied RAM onto itself → every value-static
booted 0 and BSS wasn't zeroed. Fixed both (mirrors the correct `gb_crt0.s`).
Re-verified all SMS/GG scaffolds still build clean + render.

### Changed — lint stops crying wolf on WRAM copies
The SDCC `xdata-copy-miscompile` warning fired on EVERY `dst[i]=src[i]` loop,
including plain WRAM arrays (the message even said "ignore if plain WRAM") —
training agents to ignore lint. Now: provably-VRAM dest → warning, plain RAM array
→ suppressed, unknown → info. (Deliberately did NOT add the requested 32-bit-shift
/ short-loop lint heuristics — they'd be false positives for non-bugs.)

### Added — feedback ergonomics
- **`frame({op:'screenshot', scale})` up-scales** (integer ≥2, nearest-neighbor)
  for legible handheld shots (GB 160×144 → 640×576 at `scale:4`), plus the
  existing `0<scale<1` downscale. All platforms.
- **Cheap symbol→address:** `symbols({op:'resolve', dbgPath|mapPath, name})` reads
  the map FILE on disk (no 63 KB round-trip through context); `build({output:
  'romWithDebug', resolveSymbols:[...]})` folds just those addresses into the
  result. cc65 `.dbg` / sdld `.map` / GNU ld `.map`.

### Added — Genesis feel/perf diagnostics
- **`watch({on:'dma', perFrame:true})`** — per-frame DMA-bytes timeline + spike
  detection (catches "rewriting tilemaps in the frame loop", the #1 Genesis feel
  bug). A hardware-scroll scaffold settles to a flat ~8 bytes/frame.
- **`scaffold` template `two_plane_parallax`** — plane-A foreground + plane-B
  repeated starfield + player sprite, hardware scroll only, zero loop-time tilemap
  writes. Builds clean, renders, scrolls (verified).
- Genesis MENTAL_MODEL/TROUBLESHOOTING: "do NOT rewrite tilemaps in the frame
  loop", logical-vs-hardware plane size, the correct parallax loop, large-scroller-style
  column streaming, and a "why does movement feel choppy?" recipe.

### Changed — discoverability (the recurring root cause)
Several feedback "feature asks" were tools that already existed. `recordSession`
(motion/telemetry timeline) was mislabeled in the catalog as "capture inputs for
replay"; relabeled. New AGENTS.md "Diagnosing behavior over time (game-feel)"
section maps symptom → existing tool (choppy movement → `recordSession`/`watch`
series on scroll+sprite; wrong-but-clean value → `resolveSymbols` + `memory` read;
can't-read-the-BG → `background({view:'map'})` + `screenshot scale:4`).

### Other
- `build({output:'project', path})` already defaults the gb/gbc/sms/gg/msx crt0 +
  codeLoc — documented (the GBC agent was hand-passing them to `output:'rom'`).
- P4 doc + a new info-level `wram-static-overlap` lint advisory (hardcoded
  `$C000–$C0FF` pointer overlapping SDCC's static-data segment — the actual cause
  of the reporter's "monochrome RNG").

## 0.22.1

Doc-only follow-up to 0.22.0's movement-analysis feedback: the `pressDuring`
schema on `watch` and `breakpoint` now states that entries with OVERLAPPING
windows on the same port are OR'd into a chord (e.g. `b`+`right` held while `a`
fires mid-window), not overwritten. The driver already behaved this way; this
documents the guarantee so it doesn't have to be confirmed empirically.

## 0.22.0

**Transparency + correctness pass: every tool failure is actionable, dangerous
warnings are ranked first, and all 14 platforms' scaffolds build clean AND
render visible content.** The theme: a coding agent should never be left guessing
by an opaque error, never skip a crash-class warning buried in noise, and never
copy a scaffold that ships with warnings or a blank screen.

### Changed — actionable error messages across all 14 platforms
Failures now name the fix, not just the symptom:
- **`build`/assemble:** compile errors carry `{file, line, message, stage}`; LINK
  errors (which have no source line) now reach `issues[]` too, each with a `hint`
  naming the missing symbol + how to resolve it — on ALL FOUR linkers (GNU ld for
  Genesis/GBA, ld65 for NES/C64/Lynx/A2600/A7800/PCE, sdld for GB/GBC/SMS/GG/MSX,
  wlalink for SNES). The crt0 (startup-stub) assembly path and `assembleSnippet`
  now surface the first `file:line: message` instead of dumping a raw log.
- **`loadMedia`:** a refused ROM names the likely cause (wrong platform / truncated
  / unsupported mapper) and points at `cart({op:'identify'})`.
- **Runtime/host:** `getHost`'s "No ROM loaded" echoes the EXACT `loadMedia` call
  to recover with after a session eviction; unknown memory region lists the valid
  names; "no save state named X" lists the existing slots; `host({op:'unload'})`
  no longer claims success when nothing was loaded.

### Changed — build `issues[]` ranks the dangerous warnings FIRST
A weak agent skips a lethal warning when it's buried among unused-variable noise.
`issues[]` is now ordered **critical → error → warning → info** (stable within a
rank) on every platform. The SDCC pre-flight lint marks the unconditional
`uint8`-loop-bound trap as `critical: true` (it always hangs) with a `WILL HANG:`
message; the conditional VRAM byte-copy stays a plain warning (it can't be proven
unsafe statically, so it must not cry wolf).

### Fixed — `watch`/`breakpoint` inherit held input (the movement-analysis bug)
A `watch`/`breakpoint` run with NO `pressDuring` now inherits whatever
`input({op:'set'})` last held — exactly like `frame({op:'step'})`. Previously the
first frame reset the pad to neutral, silently dropping a held button. A
`pressDuring` schedule still OWNS the pad for the run (deterministic capture).
Documented on the `input`/`watch`/`breakpoint` schemas.

### Fixed — all 130 scaffolds: zero warnings AND render visible content
Swept every `scaffold({op:'project'})` template on all 14 platforms:
- **Warnings 65 → 0** (was concentrated in GB/GBC/Genesis/GG/GBA/SMS), fixed at
  the SOURCE so scaffolds model the right pattern: GB/GBC VRAM tile copies use the
  runtime's pointer-walk `memcpy_vram` (the indexed `dst[i]=src[i]` form SDCC sm83
  miscompiles into VRAM); Genesis builds pass `-Wno-main` (SGDK mandates
  `int main(bool)`); GBA/GG/SMS narrowing + dead-branch fixes.
- **Blank/broken renders 31 → 0** (verified via `frame({op:'verify'})`): added a
  patterned background to lone-sprite/text scaffolds, and fixed real bugs found
  along the way — **NES FamiTone2's `$0300` RAM collided with the C runtime BSS**
  (zeroed PPUCTRL, killed rendering; the driver's RAM was relocated to `$0700`);
  the **SNES `sfx_init()`-before-`setScreenOn()`** forced-blank trap; a **C64 cc65
  screen-fill-loop hang** (rewritten via `memset`) + sprite-data/`$0801` overlap;
  the **Lynx double-buffer** stale-page trap.

### Added — ESLint over romdev's own JavaScript
Flat config (`npm run lint`) catching real bugs (undefined refs, unused
imports/vars, dupe keys, self-assignment) over the monorepo's plain-JS ESM
sources; vendored SDK/wasm/build trees ignored. Cleaned 114 pre-existing findings.

## 0.21.0

**NES CHR-ROM / iNES rebuild ergonomics + turnkey `disasm({target:'project'})`
across all platforms.** Addresses the v0.16.0 feedback: rebuilding a commercial
NROM game from its disassembly into a byte-identical `.nes` no longer needs
hand-written iNES header bytes, a CHR-ROM `.incbin` glue source, or a 3-region
linker `.cfg`.

### Added — `build({inesHeader:{prgBanks, chrBanks, mapper, mirroring, battery?}})`
NES NROM-rebuild convenience. Auto-emits the 16-byte iNES HEADER segment, wires
the CHR-ROM blob (from `binaryIncludePaths`) into a CHARS segment, and
synthesizes the flat NROM linker `.cfg` (HEADER + PRG + CHARS). The agent
supplies only the PRG disassembly + the CHR blob — no glue `.s`/`.cfg`, no
hand-derived header bytes. PRG start/size derive from `prgBanks` (NROM-128 →
$C000, NROM-256 → $8000). Mutually exclusive with `linkerConfig`. Proven
byte-identical against `nestest.nes`.

### Added — `linkerConfig:"chr-rom"` NES preset
Sibling of `chr-ram`/`chr-ram-runtime`, for homebrew C that ships FIXED tile art:
segment split + a CHARS segment in an 8 KB ROM2 bank + a companion crt0 with an
8 KB-CHR-ROM iNES header. (For other bank configs, prefer `inesHeader`.)

### Changed — `disasm({target:'project'})` now emits a TURNKEY, rebuildable project
Previously it wrote only byte-exact `.asm` region files. Now, per platform, it
also writes the "rebuild glue": data blobs (NES CHR-ROM, MSX/Genesis/GBA/Lynx
headers), a human/agent-readable `BUILD.md`, and — where a one-call rebuild
exists — a `rebuild.json` (the exact `build()` args, absolute paths). Feed
`rebuild.json` back to `build` and you get a byte-identical ROM.
- **One-call `build()` rebuild (byte-identical):** NES, C64, Atari 7800, Lynx
  (Lynx: build() yields the headerless image + a shipped `lnx_header.bin` to
  prepend).
- **Native-recipe (byte-identical, documented in BUILD.md):** SMS, GG, MSX, GB,
  GBC, Genesis, GBA, Atari 2600 — the disasm emits each CPU's native-reassembler
  syntax (ca65 for 6502/65816, GNU `as` for z80/sm83/m68k/arm), which those
  platforms' `build()` toolchains (SDCC/RGBDS/asar/dasm/vasm) can't consume, so
  BUILD.md gives the proven native chain.
- **Not yet byte-exact:** PC Engine (planRegions trims real trailing padding +
  doesn't strip a copier header — BUILD.md says so).

### Fixed — disasm round-trip bugs surfaced by the rebuild work
- `reassemble.js`'s data-only floor omitted `.org`, silently truncating any
  region with a non-zero start address — so multi-bank GB/GBC ($4000 banks) and
  MSX ($4010) didn't round-trip at all. The floor now mirrors the linked path's
  origin handling.
- `dataRegionSource` emitted `$`-prefixed hex that GNU assemblers (ARM/m68k)
  reject (`$2E` read as an undefined symbol); it's now CPU-family-aware (`0x` hex
  for z80/sm83/m68k/arm, `$` for 6502/65816).

### Added — NES MENTAL_MODEL.md "Rebuilding a CHR-ROM NROM image" section
The iNES header bytes decoded, CHR-ROM vs CHR-RAM, NROM-128/-256 mapping, and the
three rebuild paths (`inesHeader` / `chr-rom` preset / `disasm({target:'project'})`).

## 0.20.0

**Genre-scaffold parity across all 14 platforms + the MSX cartridge-boot fix +
PCE rendering fix + a higher blank-screen bar.**

### Fixed — MSX cartridges now actually boot (`scaffold` + recipe)
Every MSX program had been booting to the C-BIOS "No cartridge found" screen:
`retro_load_game` returned true but the cart never reached a slot. Root cause was
NOT the wasm core, the C-BIOS, or the libretro API (all verified working against a
commercial MSX `.rom` in the same host) — it was our **build**. `projectBuildRecipe`
had no MSX branch, so `msx_crt0.s` was compiled as an ordinary translation unit
*alongside* SDCC's stock CP/M-style crt0; the cartridge `"AB"` header at $4000
got dropped and the INIT entry pointed at junk. Fix: route `msx_crt0.s` through
the crt0 slot (`crt0File`, `codeLoc = 0x4010`), exactly like the SMS/GG recipe.
MSX is now full tier-1.

### Fixed — PC Engine "bottom half is vertical stripes" on every game
`vdc_init` set `VDC_MWR` to `0x0010`, which per the HuC6280 VDC spec selects the
**64×32** virtual screen, not the 32×32 the comment claimed. The BAT-clear loops
walk stride-32, so only the top ~16 rows of the 64-wide map were cleared — the
bottom half rendered uninitialized VRAM as vertical stripes. Set `VDC_MWR` to
`0x0000` (true 32×32) so the clear covers the whole visible map.

### Added — genre-scaffold parity (PC Engine, MSX, Atari 2600)
PC Engine and MSX gained the full 5 canonical genre scaffolds
(`shmup` / `platformer` / `puzzle` / `sports` / `racing`); Atari 2600 gained 4
(no `puzzle` — the TIA has no tilemap to draw a match-3 board). Previously these
three shipped only ~3 ad-hoc starters while the other 11 platforms had the full
set. All 14 new scaffolds are verified rendering live (`frame({op:'verify'})` →
`verified:true`, ≥3 distinct colors, dominant under the blank threshold). The MSX
and PCE `platformer` scaffolds side-scroll (MSX via SCREEN 2 name-table column
streaming; PCE via the VDC BXR register). `scaffold({op:'game'})` now works on
all 14 platforms; only the per-(platform,genre) gaps (e.g. `atari2600` + `puzzle`)
are rejected, with the error naming the genres that platform *does* have.

### Changed — blank-screen detection bar raised to 92%
`frame({op:'verify'})`'s `nearlyBlank` threshold went from 99.5% to **92%**
dominant-color coverage — 88–92% of one flat color still reads as "blank" to a
human. A sweep re-tuned the genre scaffolds across every platform to clear the
higher bar (real backgrounds/HUD instead of a lone sprite on a flat field).

### Fixed — `frame({op:'verify'})` now emits its judged frame to the livestream
The REST/skill tool path (`runTool`) was dropping the observer image/frame
sidebands that only the MCP middleware handled, so `verify` (and any tool that
emits a deferred frame) never reached the `/livestream` UI over plain HTTP.
`runTool` now mirrors the middleware: it strips the sidebands from the result and
fires the deferred `call_frame` event.

## 0.19.0

**Two one-stop-shop features for agents — both fold into existing tools, both
work on all 14 platforms.**

### Added — `frame({op:'verify'})`: "is the game actually rendering / alive?"
A one-call render-health check for agents debugging WITHOUT vision (the spiral
where a black frame might be broken *or* fine and you can't tell). Pass `frames`
to boot-then-check in one call. Fuses two independent signals: a platform-agnostic
pixel-content scan of the live framebuffer (distinctColors, dominant-color %) and
the per-platform render-ENABLE/NMI decode (reused from the rendering-context
decoder — covers all 14 platforms). Returns `{verified:true|false|null, issues[],
pixels, render}`:
- `verified:null` + `unsettled` before any frame is stepped (frame-0 guard — never
  cries wolf on boot; step first).
- `issues[]` flags `blankScreen` / `nearlyBlank` / `renderDisabled`. `renderDisabled`
  is ONLY raised when the registers say so (never on a platform we can't decode —
  there the pixel check carries the verdict).
- Pass/fail with zero image tokens; for WHAT to fix, getPlatformDoc(mental_model).
- Verified across all 14 platforms (`frame-verify-allplatforms.test.js`): the
  verdict is internally consistent everywhere, and it correctly flags genuinely
  blank scaffolds as broken. Implements the locked `renderHealth` spec, folded
  into `frame` rather than a new top-level tool.

### Added — `watch({on:'range'/'pc', fromState|fromStatePath})`: trace from a moment
The range/PC tracers can now restore a savestate FIRST, so the log runs from a
known, repeatable point (jump to the boss fight, then see exactly what writes HP)
instead of from wherever the live session happens to be. `fromState` = an in-memory
slot (state({op:'save', name})); `fromStatePath` = a savestate file on disk
(relative paths resolve to the ROM dir). Deterministic — same state → identical
trace. Platform-agnostic (rides the existing all-14-platform range/PC watch).
Result echoes `restoredFrom`. Tests in `watch-fromstate.test.js`.

## 0.18.1

**C64: a game's OWN in-game disk SAVE works — and always did.** 0.18.0 shipped
the disk ops with a "known limit" claiming a running game's KERNAL `SAVE` doesn't
persist in WASM. That was WRONG — the cause was a bug in romdev's `.d64`
*directory reader*, not the emulator: the C64 KERNAL stores filenames in high-bit
PETSCII (A–Z = 0xC1–0xDA), and `readDirectory` dropped those bytes, so an
emulator-written `SCORE` parsed as an empty name and looked missing. VICE was
committing the save to the live disk the whole time (true-drive GCR write-back).

### Fixed
- **`readDirectory`/`extractFile` decode high-bit PETSCII filenames** (and
  lower-as-upper) — so files a game saves (KERNAL SAVE) are visible, not just
  files romdev's own `prgToD64` wrote (which used plain ASCII). Verified end to
  end: a cc65 program does `cbm_save("SCORE",8,…)`, and `exportDisk` reads the
  `SCORE` file back with the right bytes. Locked by a regression test in
  `d64.test.js` + a transparent-save test in `c64-disk-save.test.js`.
- The 0.18.0 "Known limit" is **retracted**: run the game, let it save, then
  `state({op:'exportDisk', path})` captures a `.d64` that includes the save.
  Docs + the `save_ram` n/a message corrected. (Confirmed against the native
  vice-libretro core in RetroDECK, which produces a byte-identical saved disk.)

## 0.18.0

**C64 disk SAVES — the floppy is the C64 save medium, and romdev now reads/writes
it on the live disk.** 0.17.0 added loading/running/distributing `.d64` disks;
this adds save/restore, the C64 analogue of SRAM `exportSram`/`importSram` (the
C64 has no battery RAM — games save by writing files to the floppy, so the disk
IS the save).

### Added — `state` disk ops (C64 / VICE)
- **`state({op:'exportDisk', path})`** — write the LIVE mounted 1541 `.d64` to a
  file (captures any files the game wrote to disk). Re-load it with `loadMedia`
  (autostarts) or push it back with `importDisk`.
- **`state({op:'importDisk', path})`** — write a `.d64` back into the running
  drive (inject a save disk made elsewhere). Enforces the standard 174848-byte
  35-track format.
- **`state({op:'putDiskFile', path, name})`** — inject ONE PRG file straight into
  the live disk via the drive's filesystem (the "write a save" primitive).
- Backed by new VICE core exports (`romdev_disk_export`/`import`/`putfile`) that
  operate on the live `disk_image_t` directly — captured in the reproducible
  `vice-romdev-memory-regions.patch` (verified by a from-scratch re-fetch+build).
  New `LibretroHost` methods: `exportDiskImage`/`importDiskImage`/`putDiskFile`/
  `diskImageSupported`. Locked by `c64-disk-save.test.js`.

### Known limit
- A game's OWN mid-run KERNAL `SAVE` does not yet auto-persist to disk in this
  WASM build (the emulated 1541 serial-bus write stalls). Drive saves from the
  host instead (`putDiskFile` / capture with `exportDisk`), or use a full-machine
  savestate. The C64 `save_ram` n/a message now points at the disk ops.

### Reproducibility hardening
- Every upstream pin in `versions.json` is now a full commit SHA or a verified
  sha256 — closed two gaps: **cc65** was pinned to the mutable tag `V2.19`
  (→ resolved to SHA `555282497c…`), and **sdcc** carried an unfilled
  `UNVERIFIED-…` sha256 (→ real `ae8c1216…`). Zero weak pins remain.

## 0.17.0

**C64 disk images — load real games & ship yours as `.d64`.** The Commodore
brand relaunched in 2025/26 (the FPGA Commodore 64 Ultimate / C64C Ultimate, on
the original 1986 tooling) and the homebrew/demo scene is booming — and that
world ships and loads games as **`.d64` disk images / `.crt` carts**, not bare
`.prg`. romdev was C64-`.prg`-only; now it handles disks end to end. No new
top-level tool and no core rebuild — the bundled VICE already does the work; the
gap was romdev's loader.

### Added
- **Load & run disk/tape/cart:** `loadMedia({platform:'c64', path:'game.d64'})`
  now accepts `.d64/.t64/.tap/.crt/.g64`. VICE attaches the disk to drive 8 and
  **autostarts** it (= `LOAD"*",8,1 : RUN`) under warp (~100 frames vs sitting
  at the BASIC `READY.` prompt). New c64 core-option defaults wire this up
  (`vice_autostart` + `vice_autoloadwarp` + `vice_warp_boost`, write-protection
  off). `status.mediaKind` now reflects the real medium (`disk`/`tape`/
  `cartridge`/`program`) instead of always `program` — `defaultMediaKind` is
  extension-aware.
- **Distribute as a disk:** `cart({op:'packDisk', prgPath})` wraps a built
  `.prg` into an autostart-able `.d64` (a pure-JS 1541 codec — no `c1541`
  dependency; exact `.prg` round-trip, standard 174848-byte image). `cart({op:
  'extract'})` on a `.d64` lists the directory; pass `name:` to pull a file off
  the disk. So the full create→build→distribute loop produces the format the new
  hardware and the scene actually load.

### Known limit
- **In-emulator disk WRITES (a running game's own SAVE) are not yet persisted
  back out of the core.** The write succeeds inside VICE but this WASM build
  doesn't flush the modified image to the (MEM)FS on detach, and VICE exposes no
  disk memory region. Loading/running/distributing disks is unaffected. The
  honest C64 `save_ram` n/a message says so; for reliable persistence use a
  full-machine savestate (`state({op:'save'/'load', path})`). A core patch to
  add a disk export/flush entry point is tracked as a follow-up.

## 0.15.0

**Scaffold audit: every scaffold on every platform now builds AND renders.** Two
independent multi-agent audits found the documented "scaffold then build the dir"
happy path was broken on most platforms, and that many scaffolds built but
rendered blank. Both are fixed — verified 115/115 templates build via the dir
path, and every genre game renders recognizable content. This matters most for
weaker agents: the first build now succeeds, so they build on a working example
instead of assuming the server is broken and installing their own tools.

### Fixed — project-directory build (the linchpin)
- **`build({output:'run'|'project', path})` now works on EVERY platform.** It was
  0/8 on GB/GBC/NES/Genesis and 0/5 on Atari 2600 via the natural path. The
  dir-builder used to glob every file as a source; it now applies a per-platform
  recipe that matches a hand-written build: routes the crt0 correctly (GB/GBC
  `gb_crt0.s` via the cart-header path — no more `Multiple definition of gsinit`),
  applies the linker preset (NES `chr-ram-runtime` — no more `Missing memory area
  'OAM'`), skips SDK intermediates (Genesis `sega.preprocessed.s`, the SNES SPC700
  driver, any `*.upstream.*`), wires the GBA runtime (libtonc/libgba/maxmod by
  what the source includes), routes `#include`d C/asm siblings as includes, and
  bundles every incbin asset (`.xgc`/`.vgz`/…). `output:'run'` accepts `path` too
  (build+load+run+screenshot a dir in one call). One shared code path so the two
  build routes can't drift. Locked in by `scaffold-build-happypath.test.js`.
- **SNES multi-`.c` builds** (genre scaffolds ship `main.c` + `snes_sfx.c`) — the
  stale single-`.c` guard in `buildSnesC` is removed (the link path already
  handled multiple TUs).

### Fixed — scaffolds rendered blank/wrong (now show content)
- **SMS/GG**: `vdp_init` R6 default 0xFB→0xFF — sprite tiles now read from $2000
  where scaffolds upload them (were reading the empty $0000 bank → invisible). GG
  also: 64-byte GG palette format (scaffolds shipped 32) + visible-window coords.
- **Genesis**: genre scaffolds now call `VDP_linkSprites` (the SAT link bytes were
  0 = end-of-list → only slot 0 drew); shmup enemies spread across the field.
- **SNES**: `sports`/`racing` `oamSet` now uses byte offsets (`slot<<2`); a real
  4bpp console font is embedded (the stub made all text black) + the BG-base /
  text-offset / `consoleVblank` wiring fixed → c_hello/puzzle/platformer show text.
- **Lynx**: `platformer`/`puzzle`/`sports`/`racing` use the `while(tgi_busy()){}` +
  full-screen `tgi_bar` clear (were black via bare `tgi_clear()`).
- **C64**: genre sprite data moved $0800→$2000 (it collided with the $0801 `.prg`
  load → `sports` crashed to BASIC, sprites corrupt).
- **NES**: the bundled runtime no longer races the OAM-DMA — `oam_clear` resets the
  index and `ppu_wait_nmi` hides unused slots after staging, so sprite-light
  scaffolds no longer flicker to black; `default` backdrop no longer cycles to black.
- **PCE**: `pce_video.c` now programs the VDC display timing (NTSC 256×224) — fixes
  the vertically-doubled picture.
- **GBA**: per-frame `tte_printf("%05d")` (broken in the bundled libtonc — garbles +
  wedges the loop) replaced with a hand-built score string + `tte_write`.
- **Atari 2600**: `paddle` kernel rebuilt to a 2-line kernel (the per-line work
  overflowed a 76-cycle scanline → ~250 lines, no vsync lock); now stable at 210.

### Changed
- **Doc-drift swept**: every agent-facing `runSource`/`buildSource` → the current
  `build({output:'run'|'rom'})`, dead tool names (`loadCategory`, `inspectSprites`,
  …) → the consolidated forms, across the scaffold README emitter, `nextStep`,
  examples, platform docs, and `.cfg` comments. Emitted scaffold-README `frames`
  60→240 (60 caught the boot logo on some platforms → false "blank").
- **Thin genres** given a BG world (Genesis sports court / racing road, NES racing
  road, SNES sports/racing) so they read as the genre, not objects on black.
- **Missing-genre error** for msx/pce/atari2600 now names the working project
  templates instead of a bare "default".
- The `uint8-loop-bound` preflight lint is scope-aware (no longer false-flags a
  `uint16_t` loop counter that shares a name with a `uint8_t` in another function).

## 0.16.0

**Build diagnostics: agents were building blind — errors AND warnings now reach
the response as structured `issues[]`.** An agent can only fix what the toolchain
tells it, where it tells it. Audited the whole build surface and closed the gaps
so diagnostics (file/line/message/stage) come back in the tool result, not buried
in the raw log. (Also bumps a doc count: the surface is 32 tools after 0.15.0's
dmaTrace→watch / patchGbHeader→romPatch consolidation; stale "34" references in
the docs + source comments updated.)

### Fixed
- **Warnings were OFF.** No C compiler was being asked for them. gcc (GBA/Genesis)
  now compiles USER source with `-Wall -Wextra -Wno-unused-parameter` (the bundled
  SDK stays warning-free so its noise doesn't bury the agent's); cc65 enables its
  valid high-value `-W` set. So unused vars, implicit declarations, etc. are now
  emitted and surfaced.
- **Swallowed errors now structured:** SDCC's keyword-less `file:line: syntax
  error: …` and `warning NNN: …` (GB/GBC/SMS/MSX previously returned an empty
  `issues[]` on a syntax error); the sdld/ASlink `Undefined Global '_x'` link
  error; vasm errors (Genesis asm emits no stage marker, so they hit the
  fallback, which had skipped the vasm parser); and a **missing `incbin` asset**
  — the #1 thing an agent forgets to pass — now reports `could not open <x.bin>`
  with the exact filename.
- **Fixed a build crash that ate the real error:** `build({output:'rom', path})`
  fell into the source builder with no source and threw "Cannot read properties
  of undefined (reading 'split')" instead of the compiler error; it now routes to
  the project-dir builder like `output:'run'`/`'project'`.
- Verified live across all 14 platforms; a `parse-errors-coverage` test locks the
  formats in. (Known limit: asar/SNES-asm only yields a wrapper "aborted"
  message — its WASM build aborts without printing line info.)

### Added — SRAM (cartridge battery save) support, folded into existing tools
The cartridge battery SAVE FILE (in-game saves — distinct from a whole-machine
savestate) is now fully supported, with NO new top-level tool:
- **Live read/write** already worked via `memory({region:'save_ram'})` on every
  battery-capable core (NES/GB/GBC/SNES/Genesis/GBA — verified against each core's
  source; they all expose RETRO_MEMORY_SAVE_RAM).
- **Persist the `.sav`:** `state({op:'exportSram', path})` / `{op:'importSram', path}`
  dump/restore the battery RAM as a real save file (relative path → ROM dir, size-
  mismatch guard, zero-pad-smaller). The save-editor / inject-a-save capability that
  previously forced agents out to local tooling.
- **Presence:** `cart({op:'identify'})` now returns `saveRam:{hasBattery, bytes}`
  (from the iNES battery flag / GB cart-type) so an agent knows a save exists.
- **Honest "no save":** empty `save_ram` now says *why* — "this cart has no battery
  save" / "Atari 2600/7800 & Lynx never had cartridge saves" / "C64 has no battery SRAM (disk/.prg)" — instead of a generic "core didn't expose it." (Confirmed via research +
  core source: no core patches were needed; earlier "broken" readings were
  password-based NES carts, which correctly have no battery.)

### Fixed / Added — v0.15.0 session feedback
- **`state` file `path` resolution.** A RELATIVE `path` (save/load/export) used to
  resolve against the server's CWD → silent ENOENT (and the docs use relative
  paths). It now resolves against the LOADED ROM's directory ("states live next to
  my ROM"); absolute paths are used as-is; the result echoes `resolvedPath`.
- **Abort-guard on input-driven `breakpoint({on:'write', precision:'exact'})`.** New
  `abortIf:[{region,offset,label}]` — caller-named "is this scenario still valid?"
  bytes. If any changes mid-run (player died → title screen, scene flipped) the
  watchpoint stops IMMEDIATELY and returns `{aborted:true, abortedBy, before,
  after}` instead of burning all `maxFrames` and returning a meaningless
  `found:false`. Collapses the derailed-run recovery (breakpoint → screenshot →
  N× memory read → reload) into one informative call.
- **No-hit note is now once-per-session.** `breakpoint` on:write used to repeat a
  ~100-token "two common reasons" explainer on every miss; the full form now fires
  only on the first miss per session, a one-liner after.

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
  verified no-op there. (sports-title agent nit: 20 hits → the 10 distinct
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
    to `maxFrames`. Requires the rebuilt `romdev-core-gpgx` WASM. (sports-title
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

Reverse-engineering follow-ups from a Genesis sports-title agent's decompress
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
a Genesis sports-title session, plus PC Engine + MSX cheat coverage
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
