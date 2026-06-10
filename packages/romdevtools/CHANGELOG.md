# Changelog

All notable changes to `romdevtools`. Dates are release dates.
(Published as `romdev-mcp` through 0.11.0; renamed to `romdevtools` in 0.13.0 —
the `romdev-mcp` bin is kept as an alias.)

## 0.28.0

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

### Fixed/Added — the 0.27.0 Zanac RE feedback round (banked-NES rebuilds, A/B diff, token cuts)
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
Completes item 2 of the NES Rygar report. 0.26.0 shipped `registersAtHit` (the
break-instant register file) but not the memory half. Now `breakpoint(on:'pc')`
takes `captureMemory:[{region,offset,length,label}]` and returns those reads inline
as `capturedMemory`, so register + RAM inspection at a PC collapses into ONE call —
no follow-up `cpu`/`memory` round trips. `registersAtHit` is the true break instant
(core snapshot); `capturedMemory` reflects the routine's RAM side effects for the
hit frame (stable + what RE needs), documented as such.

## 0.26.0

### Fixed — NES `breakpoint(on:'pc')` now returns reliable break-instant registers
An agent RE'ing NES Rygar found that after a `pc` breakpoint hit, a follow-up
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
Follow-up to the 0.24.0 C64 keyboard work: an agent RE'ing C64 Uridium could now
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
An agent RE'ing C64 Uridium could reach the intro via joystick but couldn't ENTER
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
  loop", logical-vs-hardware plane size, the correct parallax loop, Sonic-style
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
  password-game test carts like Metroid, which correctly have no battery.)

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
