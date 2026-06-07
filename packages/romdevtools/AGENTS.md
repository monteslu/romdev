# romdev — Agent guide

You are reading this because romdev is connected. This is the orientation. Read it once; you won't need to re-read it during a session.

## What this server does

Drives the full homebrew ROM dev loop for 14 retro game platforms (NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Genesis, Sega Master System, Game Gear, Atari 2600/7800, Atari Lynx, Commodore 64, PC Engine / TurboGrafx-16, and MSX / MSX2). Build → run → screenshot → inspect → patch → iterate. Also a strong reverse-engineering kit: disassemble existing ROMs into byte-exact rebuildable projects (`disasm({target:'project'})`/`disasm({target:'references'})` — the workhorse for any structural hack), find a value's address with the Cheat-Engine search loop (`memory({op:'search'})`/`memory({op:'searchNext'})`), find the EXACT instruction that wrote a RAM byte (`breakpoint({on:'write'})`, a core-level write watchpoint), confirm a patch is live in the running image (`memory({op:'readCart'})`), tell whether a "found table" is really ASCII (`memory({op:'classify'})`), trace which ROM offset a Genesis graphic was DMA'd from (`watch({on:'dma', precision:'sampled'})`), drive menus by screen-change (`navigate`), and look up cheats (`cheats({op:'lookup'})`/`cheats({op:'search'})`: a free, crowd-sourced labeled RAM/code map for known ROMs), apply + create cheats, convert assets, study patterns from real games. **Doing a romhack? Start with `platform({op:'doc', platform:'romhacking', name:'playbook'})`** — the decision tree that wires all of the above together. Bundled WASM toolchains and emulator cores — no system dependencies, no installs.

You drive the work. The human is a director — they may want a game, a ROM disassembly, a tool-assisted reverse-engineering session, or anything else this server can do.

## The one hard rule: NEVER install a compiler or emulator. romdev bundles every one.

Internalize this above all else: **you never need — and must never install — a compiler or an emulator to build or run a ROM here.** Every compiler/assembler/linker (cc65, sdcc, gcc, tcc, wla, rgbds, vasm, m68k-gcc, arm-none-eabi-gcc, …), every devkit/SDK (SGDK, PVSnesLib, libtonc/libgba, cc65 libs, …), and every emulator core (fceumm, snes9x, gpgx, gambatte, mGBA, handy, vice, prosystem, stella, …) is **already bundled as WASM** and runs in-process through these MCP tools. The whole build → link → run → inspect loop is `build({output:'rom'})` / `build({output:'run'})` / `build({output:'project'})` / `loadMedia` / `frame({op:'screenshot'})` / `inspect*` / `playtest` — never a host `gcc` or a downloaded toolchain.

**So if a build toolchain or emulator is ever invoked or prompts to install — `clang`, `gcc`, Xcode / macOS Command Line Tools, `node-gyp`, devkitPro, `brew/apt install <compiler>` — that is a DEFECT, not your cue to proceed.** Stop, do NOT install it, do NOT investigate it with host-side diagnostic commands (that just alarms the user), and surface it: "romdev should provide this — a host compiler/emulator should never be needed." Then find the romdev tool or report the gap. `platform({op:'list'})` / `platform({op:'toolchains'})` show what's bundled.

### Host content tools (art / audio / map editors) are totally fine

This rule is about **compilers and emulators only** — NOT about content tools. ImageMagick, GIMP, Aseprite/LibreSprite, Audacity, Tiled, a tracker (FamiStudio/Deflemask), Python for a quick art script — all fine to use, and fine for the user to install. They produce **raw source art/audio** (a PNG, a sprite sheet, a `.wav`, a `.tmx`); romdev then **imports and packs** that into platform-native data. Use them freely when they help; just don't reach for a *compiler or emulator*.

### romdev also packs assets in-server — reach for these first

Asset conversion is bundled too, so you often don't need the host tools at all. First-class tools: `encodeArt({stage:'tiles'})`, `encodeArt({stage:'tilemap'})`, `encodeArt({stage:'quantize'})`, `palette({source:'platformMaster'})`, `palette({source:'lospec'})`, `encodeArt({stage:'validate'})`, the loaders `importArt({from:'texturepacker'})` / `importArt({from:'aseprite'})` / `importArt({from:'gif'})` / `importArt({from:'tiled'})`, and helpers like `sprites({op:'capture'})` / `importArt({from:'rom'})`. The canonical quantize→tile→pack path lives here. Typical flow: paint pixels in a host editor (or generate a PNG), then `encodeArt({stage:'quantize'})` → `encodeArt({stage:'tiles'})` to get platform-native tiles. (You can do the whole thing in-server too when the art is procedural.)

### Native-addon prompts are a packaging bug — never compile on the host

A couple of optional features load a native Node addon (most notably the `playtest` SDL window, via `@kmamal/sdl`). These ship **prebuilt** — they must never compile on your machine. If you see a `clang` / Xcode / Command Line Tools / `node-gyp` build kick off while using romdev, the prebuilt binary is missing or mismatched: **do not let it compile, do not install a toolchain — report it.** `playtest` itself self-heals by downloading its prebuilt binary and, if it can't, returns `{opened:false, reason:"sdl-binary-missing", fixCommand}` with the exact one-line fix — it never needs a host compiler.

## If a human is watching, open playtest early

If a human is sitting next to you during this session — and that's most sessions in practice — open the playtest window as soon as your first build succeeds. `playtest()` opens a native SDL window that runs your ROM live and accepts USB gamepads (hot-plugged controllers are picked up automatically). It returns **immediately** — the render loop runs in the background, so you keep calling other tools while the human plays. Every other MCP tool keeps working against that same running ROM, and **`build({output:'run'})`/`loadMedia` rebuilds update the window in place** — the window follows your latest build, no relaunch and no crash on rebuild. A human sitting next to you should be **playing the game** while you iterate, not watching screenshots scroll past.

```
playtest()                       // opens the SDL window (returns immediately). op:'open' is the default;
                                 // playtest({op:'stop'|'status'|'framebuffer'}) close / check / capture-what-the-human-sees
```

After that, keep iterating with `build({output:'run'})` / `build({output:'rom'})` / memory({op:'read'}) / frame({op:'screenshot'}) exactly as before — they all act on the live emulator the user is playing. Because the window and `frame({op:'screenshot'})` read the **same** live host, what you capture is what the human sees. (If you ever need to be explicit — e.g. to double-check the human's exact frame — `playtest({op:'framebuffer'})` captures the window's framebuffer directly, with `source`/`loadedMediaPath`/`frameCount` metadata.)

**No gamepad?** `playtest()`'s response includes a `keyboardControls` map and a `tellUser` note when no controller is detected — relay the keys to the human (arrows = D-pad, Z = main action, Enter = START, ESC closes) so they know how to play.

Skip playtest only when there's clearly no human in the loop: CI runs, automated test suites, batch reverse-engineering, or when the user has explicitly said "headless." `playtest()` needs a desktop session to draw into; if it can't open a window it returns `{opened:false, reason, message}` and the `message` tells you exactly how to fix it. Two distinct cases: `reason:"sdl-binary-missing"` means the `@kmamal/sdl` native binary isn't installed (the server tries to self-heal, but if it can't, the message gives a `fixCommand` to run + restart) — a one-time native-addon fix, NOT a display problem. `reason:"sdl-error"` means SDL ran but couldn't get a display — usually no desktop session (run the server yourself in a terminal inside your desktop session, then connect your agent). Either way, every other tool (build, run, screenshot, inspect) is fully headless and unaffected. When in doubt, ask once, then default to opening it.

## Tool surface: everything is loaded — just call the tool

**All ~34 tools are registered and callable from session init — there is no loading step.** If you see a tool name anywhere in this doc or via `catalog({op:'categories'})`, you can call it right now. Each tool is a small VERB with an operation axis — `memory({op})`, `build({output})`, `sprites({op})`, `breakpoint({on})`, `cpu({op})` — so the whole surface is a few dozen names, not a few hundred.

(We used to lazy-load tools behind a `loadCategory` call. It caused more harm than good — agents burned round-trips re-loading categories, and dynamic registration never propagated reliably to clients anyway. The consolidation shrank the surface enough that the entire thing loads up front; the old `loadCategory`/`describeTool` discovery tools are gone.)

`catalog({op:'categories'})` still exists as a **map of what's available, grouped by purpose** — useful for discovery, not a gate:

- `platforms` — which platforms + languages are supported
- `run` — load ROMs, step frames, screenshot (works for existing ROMs you didn't compile)
- `input` — drive controllers, look up hardware bit layouts. `navigate` walks menus by advancing on SCREEN CHANGE (not fixed frames) and reports whether each press was consumed — the fast, reliable way to script a UI.
- `state` — savestates and forensic state inspection (`state({op:'save'})`, `state({op:'load'})`, `state({op:'export'})` a slot to disk without touching the live host, `state({op:'list'})`, `state({op:'dump'})`)
- `memory` — read/write VRAM/OAM/CGRAM/ARAM and other regions (all 14 platforms). `memory({op:'read'})` takes `offsets:[…]` to batch scattered reads in one call. **`memory({op:'search'})`/`memory({op:'searchNext'})`** = the Cheat-Engine value-search loop ("find the address of X, narrow as X changes"). **`memory({op:'readCart'})`** reads the loaded cart image to confirm a patch is live. **`memory({op:'classify'})`** says whether bytes look like ASCII/code/tile-data (kills the "found table that's really a string" trap). `memory({op:'snapshot'})` + `memory({op:'diff'})` answer "which bytes changed across this event?" (diff defaults to a clustered summary with stride detection); `state({op:'diff'})` is the coarse whole-machine version.
- `debug` — `sprites({op:'inspect'})`, `palette({source:'live'})`, `cpu({op:'read'})` (all 14), `audioDebug({op:'inspect'})` (the 12 systems with a sound chip — all but Atari 2600/7800; pass `frames:N` to TRACE a per-channel note-timeline for headless melody asserts), `background({view:'renderState'})`, `breakpoint({on:'write'})` (write watchpoint, all 14), **`watch({on:'dma', precision:'sampled'})`** (Genesis: which ROM offset a VRAM graphic was DMA'd from), **`disasm({target:'bytes'|'rom'|'references'|'project'})`** (ALL 14 — native binutils objdump per CPU, incl. GBA ARM7/Thumb; the byte-exact `disasm({target:'project'})` reassembles through native as/ld/objcopy), `symbols({op})` lookup, `background({view:'rendered'})`, plus **`cheats({op})`** (`cheats({op:'lookup'})` = a free labeled RAM/code map for known ROMs, `cheats({op:'search'})` to fuzzy-find a game by name, `cheats({op:'apply'})`/`cheats({op:'clear'})` non-destructively, `cheats({op:'make'})` to create codes)
- `assets` — convert PNGs to tiles (`encodeArt`/`importArt`), WAVs to BRR, identify ROMs (`cart({op:'identify'})`), plus the hacking toolkit (`romPatch({op})` — write/writeMany/spliceCHR/relocate/makeStored/findFree/findPointer/diff, `assembleSnippet`, `cart({op:'extract'})`, `cart({op:'wrap'})`)
- `project` — starter snippets per platform
- `show` — `playtest({op})`: `op:'open'` opens the live SDL window for a human, `op:'stop'` closes it, `op:'status'` reports liveness, `op:'framebuffer'` captures exactly what the human's window shows
- `advanced` — `runUntil`, **`watch({on:'mem'|'range'|'pc'})`** (LOG-ALL tracing), **`breakpoint({on:'write'})`** (the EXACT instruction that wrote a byte, via a core watchpoint — fixes the frame-sampled-PC problem; `precision:'sampled'` is the cheap frame-PC version), **`breakpoint({on:'pc'})`** (execution breakpoint — freeze the CPU AT an instruction and read its registers), **`breakpoint({on:'read'})`** (the EXACT instruction that read a byte), **`frame({op:'stepInstruction'})`** (CPU single-step) — all 14 platforms; input recording

**"Disassemble this NES ROM"** is now just: `disasm({target:'rom', path, startAddress, length})`. No discovery step.

### Romhacking / reverse-engineering: check `cheats({op:'lookup'})` early — it's a free RAM map

> **Doing a romhack? Read the playbook first:** `platform({op:'doc', platform:'romhacking', name:'playbook'})`
> — the full decision tree (find a value's address with `memory({op:'search'})`, tell whether
> on-screen text is a string or a pre-rendered bitmap, confirm a patch is live with
> `memory({op:'readCart'})`, drive menus fast with `navigate`, avoid the "found table that's
> really ASCII" trap with `memory({op:'classify'})`). It encodes the traps below so you don't
> rediscover them the hard way.

When the task is to **modify an existing game**, you have two complementary
entry tools, and which leads depends on the kind of hack:

- **`cheats({op:'lookup', path})`** — the bundled cheat DB is a crowd-sourced **labeled
  memory/code map** for thousands of known ROMs: each RAM cheat is a named address
  (`"Infinite Health" → $00CD`), each Game Genie code is a named code site. It
  answers *"which byte holds X?"* for free, in one call — when an entry exists.
  Cheap to check, so check it early. But it only helps for **values it happens to
  label**, and only for ROMs in the DB.
- **`disasm({target:'rom'})` / `disasm({target:'project'})` / `disasm({target:'references'})`** — the actual
  code. This is how you understand *how* something works and the **only** path for
  structural hacks: new logic/behavior, text, graphics, AI, anything no cheat
  names — and for any game the cheat DB doesn't cover.

**Don't treat one as a mere fallback for the other — they answer different
questions, and running both early is normal.** A good default:

1. **`cart({op:'identify', path})`** → platform + title (sniffs zip-wrapped ROMs too).
2. **`cheats({op:'lookup', path})`** — a fast lookup. If it names the address you need,
   you may have just skipped a long memory hunt. If it returns nothing useful (no
   match, or no cheat for *your* target), that's fine — move on, no time lost.
3. **Disassemble / trace** whenever the hack is about CODE or about data the
   cheats don't cover: `disasm({target:'project'})` for a rebuildable project,
   `disasm({target:'references'})` for "what touches this address", `breakpoint({on:'write'})` for the exact
   instruction that wrote a byte, `watch({on:'mem'})`/`breakpoint({on:'write',precision:'sampled'})` to find an address
   empirically. For a no-cheats game or a logic/text/graphics change, this is
   where the real work is — start here, don't wait on a cheat lookup.
4. **VERIFY before patching**: `memory({op:'write'})` the address live and watch the effect
   (cheat labels are *probable* — matched by name, not verified CRC; static
   "matches the pattern" ≠ "actually runs").
5. **Patch**: `romPatch({op:'write'})`/`romPatch({op:'writeMany'})` with `expect:` bytes (refuses a wrong-revision
   write) — or `cheats({op:'apply'})` to prototype a value change live first.

Rule of thumb: **cheats are a shortcut for finding a known value's address;
disassembly is how you change behavior.** Most non-trivial hacks need the
disassembler regardless — so reach for it freely, and let `cheats({op:'lookup'})` save you a
hunt when it can, not gate the work when it can't.

**If your session ever returns a 404 "session not found"** (the server restarted), your MCP client should auto-reconnect (re-`initialize`) — and the fresh session again has every tool loaded. You don't re-arm anything. If your client does NOT auto-reconnect on 404, restart its MCP connection once; that's a client limitation, not a server step.

## Large output: write to a path, or ask for it inline

Tools that can return a LARGE payload (ROM bytes, full disassembly, big memory dumps, build logs, tile blobs, **and screenshots/inspect images**) follow ONE rule so they don't silently flood your context:

- **`inline: false` is the default → you MUST pass an output path** (`outputPath` / `outputDir` / `path`). The payload is written there and you get back just `{ path, bytes }`. Calling such a tool with neither a path nor `inline:true` returns a clear error telling you which to pass.
- **`inline: true` → the payload comes back in the response** (base64 / hex / text / the image). Use this when you actually want it in context.

There is **no hidden default location** — nothing ever lands in a temp dir you can't find, so you never lose a ROM to `/tmp`. You (the agent) decide where output goes; pass your project directory.

Ergonomic exceptions:
- **Small reads stay inline.** `memory({op:'read'})` of ≤4 KB returns hex inline with no path needed (peeking a few RAM/OAM/palette bytes is the common case). Only large reads require a path/inline.
- **`build({output:'run'})` returns its screenshot inline by default** — its whole purpose is "build + run + show me." Pass `screenshotPath` only if your client can't display inline images.

**On images specifically:** the `inline:true` image is only useful if YOUR client actually delivers inline images to you — some clients silently drop or down-convert image content. If you're not certain you can see them, **work from the structured data instead**: `sprites({op:'inspect'})` / `palette({source:'live'})` / `background({view:'renderState'})` always return their decoded JSON (sprite lists, palette entries, render flags) regardless of inline/path, and `frame({op:'screenshot', format:'ascii'})` gives a text render. The inline PNG is an opt-in luxury, not the primary signal.

## Trust hierarchy — where to find ground truth (R58 + R58b)

Two parallel paths depending on what you need:

### Path A — Scaffold a working project (the dumb-model-friendly path)

Most agent sessions start here. You want a working ROM, not a
research project. Use the high-level scaffolding tools and don't
worry about ground truth:

1. **`scaffold({op:'project', platform, template, name, path})`** — drops a
   complete, self-contained project tree on disk (main.c + the
   runtime files it needs + your `vendor/` library source for
   reference + README + .gitignore). Build with `build({output:'run'})` against
   the project's files; the bundled examples ARE the reference
   implementation.
2. **`scaffold({op:'game', platform, genre})`** — same but picks a known-good
   genre scaffold (shmup / platformer / puzzle / sports / racing).
3. **`scaffold({op:'snippets', platform, mode})`** (mode `list`/`get`/`getAll`)
   / **`scaffold({op:'copySnippets', platform, destinationDir})`** — fetch
   vetted helper files (reset routine, read_pad, OAM DMA, palette
   upload, etc.) when building from a smaller starting point.
   `scaffold({op:'copySnippets'})` writes the files to disk in one call
   without round-tripping bytes through your context — preferred
   when you're scaffolding into a project dir.

For most workflows, path A is all you need. Read MENTAL_MODEL.md +
TROUBLESHOOTING.md when stuck. File a feedback round if the bundled
examples are wrong.

### Path B — Debug when the bundled code disagrees with behavior

When the example builds clean but doesn't render / sound / behave
right, when an API call doesn't do what you expect, when you need
ground truth on what a library function actually does — dig in this
order:

1. **Bundled examples** (`examples/<platform>/templates/*.{c,asm}`) —
   verified to compile + (usually) run. Start here for the working pattern.
2. **Your own project's runtime source** (alongside `main.c`) — our
   thin wrappers (gb_runtime.c, lynx_sfx.c, sms_vdp_init.c, etc.).
   All ~50-200 lines, fully readable. Read these when an API call
   isn't doing what you expect.
3. **Your own project's `vendor/` library source** (R58b — auto-
   copied into every project at scaffold time). The FULL source of
   every library your ROM links against — `vendor/cc65/libsrc/<p>/`
   for cc65 platforms, `vendor/libtonc/src/` + `vendor/libgba/src/`
   for GBA, `vendor/pvsneslib/source/` for SNES, `vendor/sgdk/src/`
   for Genesis. **`grep -rn <symbol> vendor/`** inside your project
   finds the actual implementation of any library function. No MCP
   call needed.
4. **`platform({op:'doc', platform, name:"upstream_sources"})`** — per-
   platform pointers at every bundled source path + upstream GitHub
   links for the compilers + emulators we DON'T bundle (cc65,
   sdcc, m68k-gcc, snes9x, gambatte, handy, etc.). Use as a
   cheat-sheet for "where do I look for X?"
5. **Upstream GitHub** for compilers + emulators when the bug is
   below our thin wrappers. Don't bundle (gigabytes for gcc/binutils
   source) but the link is one click.
6. **Hit a real bug in romdev itself?** Open an issue at
   https://github.com/monteslu/romdev/issues with repro details. File
   only with a diagnosis (not bare "it doesn't work") — read the bundled
   source first.

**Important constraint on path B:** the `vendor/` library source is
**read-only in practice**. You can read + grep it freely, but if
you EDIT a file there, the linker still uses our precompiled
`libtonc.a` / `libmd.a` / etc., so your ROM won't pick up the
change. R59 (planned) will fix this with a per-TU object cache +
source-first library build. Until then, treat `vendor/` as a window
into "what the linked code actually does."

The "vendor/" library source in your project is new in R58b (it was
previously in the install only; you'd have to call
`scaffold({op:'copySnippets'})` to pull it in). Now it lands automatically
when you `scaffold({op:'project'})`. Round 30/31 Lynx wedges took 5 friction
rounds partly because cc65's TGI driver source wasn't visible;
post-R58b you can `grep -rn bar_c vendor/cc65/libsrc/lynx/` from
inside your project directory and read the actual blitter code.

**Practical rule for path B:** if you find yourself filing a
feedback round without first `grep`ping `vendor/` for the symbol
you're debugging, you're skipping the cheap diagnosis path. The
bundled examples are starting points, NOT ground truth — when they
disagree with behavior, trust the library source over the example.

### Which path to use

- **Just need a working game** → Path A. Use `scaffold({op:'game'})`, iterate.
- **Hit a bug or unexpected behavior** → switch to Path B.
- **Don't know which** → start in Path A; if iterations fail to
  converge after 2-3 attempts, you're hitting something path A
  can't fix and need path B.

### Where files land in your project tree

A scaffolded project (whether via `scaffold({op:'project'})` or `scaffold({op:'game'})`) is
**FLAT** for everything you author. `main.c` / `main.asm`, your
helper modules (e.g. `gb_runtime.c`, `nes_runtime.c`,
`atari7800_sfx.c`, `vcs_constants.h`), the platform crt0 + linker
config — all sit at the project root, next to each other. Asm
`include "vcs_constants.h"` / C `#include "gb_runtime.h"` resolves
without `-I` flags because dasm / cc65 / sdcc all default to the
current directory.

The **only** subdir you'll see at scaffold time is `vendor/` —
that's the read-only library source tree (cc65 libsrc, libtonc /
libgba src, PVSnesLib source, SGDK src) auto-bundled by R58b so
you can `grep -rn vendor/` when debugging. Don't put your own
source under `vendor/`.

So when `scaffold({op:'copySnippets'})` drops e.g. `read_joystick.asm` into
your project dir, it lands at `./read_joystick.asm` (alongside
`main.asm`), NOT under `./include/` or `./lib/`. Every platform
follows the same flat layout.

Because the layout is flat, **`build({output:'project', path, platform})` rebuilds the
whole directory in one call — no per-iteration file manifest.** It finds `main.c`
(C / SGDK Genesis / GBA / cc65-C / SDCC-C) or `main.s` / `main.asm` (asm), links every
`.c`/`.s` in the dir, treats `.h`/`.inc` as includes, and folds binary assets
(`.bin/.chr/.pcm/.brr/.vgm/...`) in as `binaryIncludes`. So iterating an on-disk project is
just `build({output:'project', path:'/my/proj', platform})` every time — you don't re-send
`sources`/`includes` each build. (Use `build({output:'rom'})` with explicit `sources` when
the files aren't on disk, e.g. generated in-context.)

## Supported platforms

**13 tier-1 platforms** (build + run + screenshot + inspect + ≥5 genre scaffolds + sound + music + per-platform MENTAL_MODEL.md + TROUBLESHOOTING.md):

NES, Game Boy, Game Boy Color, SNES, Genesis, Game Boy Advance, SMS, Game Gear, C64, Atari 2600, Atari 7800, Lynx — all with `scaffold({op:'game', genre: shmup|platformer|puzzle|sports|racing})` available except Atari 2600 (asm-only — no genre scaffolds). The `platformer` scaffold side-scrolls (hardware camera + per-platform column streaming) on every one of these except NES, which is single-screen. Every tier-1 platform also ships a `music_demo` template using the platform's de-facto music engine: FamiTone2 (NES), hUGEDriver (GB/GBC), SPC700 driver (SNES), XGM2 via SGDK (Genesis), maxmod + .xm soundbank (GBA), PSG trackers (SMS/GG), SID sequencer (C64), `lynx_snd_play` (Lynx), 2-voice TIA (Atari 2600/7800).

**Bring-up only** (build pipeline works, single `default` template, no genre scaffolds or sound/music wrappers yet): MSX, ColecoVision. Both use SDCC z80 same as SMS/GG — the genre scaffolds are queued.

**Delisted** (toolchain works but core-side issue blocks the run loop): Atari 5200 (atari800 BIOS-load path), ZX Spectrum (fuse tape-load path).

Call `platform({op:'list'})` (in the `platforms` category) for the live capability matrix, including per-platform language defaults and quirks. **Defaults are picked to maximize agent effectiveness** — for every platform that has a bundled C compiler, C is the default (LLMs write C cleanly; the compiler handles register allocation + memory mapping). Platforms whose only bundled toolchain is an assembler default to asm. Override with `language: "asm"` or `language: "c"` when you specifically need the non-default.

For maintainers: the platform / core / patch / region-ID matrix and the recipe for adding a new platform live in the project repo at https://github.com/monteslu/romdev.

## Deep debug tooling status per platform

Different platforms have different levels of MCP-exposed debugging — different hardware needs different tools, and we've patched the cores where it's been worth it. The generic shapes — `cpu({op:'read'})`, `breakpoint({on:'write'})`, `disasm({target:'rom'})`/`disasm({target:'references'})`/`disasm({target:'project'})`, `memory({op:'search'})`/`memory({op:'readCart'})`/`memory({op:'classify'})`, cheats — work on **all 14 platforms** (disassembly via native binutils `objdump` compiled to WASM, one per CPU family — incl. GBA ARM7/Thumb). The deep per-platform inspectors (`sprites({op:'inspect'})`, `palette({source:'live'})`, `background({view:'renderState'})`, `audioDebug({op:'inspect'})`) are detailed for **12 systems** below; **PC Engine and MSX** currently have the generic shapes + their core's native regions but not yet the full custom-inspector treatment (extend by patching their cores per the snes9x/gpgx pattern). `audioDebug({op:'inspect'})` covers the **12 with a sound chip** (all but Atari 2600/7800). A few are honest hardware-shaped exceptions, noted inline below (the Lynx has no fixed OAM so `sprites({op:'inspect'})` returns the SCB list head). Coverage detail per platform:

> **Universal across ALL 14 platforms:** `breakpoint({on:'write'})` (the core-level
> instruction write watchpoint — the exact PC that wrote a RAM byte, all 14 CPU
> families), **`breakpoint({on:'pc'})`** (execution breakpoint — freeze the CPU AT an
> instruction and read its registers), **`breakpoint({on:'read'})`** (the exact PC that read
> a byte — read-side mirror of `breakpoint({on:'write'})`), **`frame({op:'stepInstruction'})`** (CPU single-step),
> **`cpu({op:'setReg'})`** (write a CPU register), **`cpu({op:'call'})`/`cpu({op:'decompress'})`**
> (drive the ROM's OWN routine — e.g. its decompressor — and capture the output;
> a per-instruction watchdog on **every CPU core** (m68k, 6502/6507/6510/65c02/65816,
> z80 incl. SMS/GG, sm83, arm7tdmi, huc6280) force-stops a runaway routine and
> returns `{watchdog:true, finalPC, finalRegs}` instead of hanging. It catches BOTH
> a tight infinite loop AND a wrong-entry FREE-RUN (a wrapper PC with a bad source
> that falls back into the game's main loop): the default budget is PER-CPU, sized
> to trip before the frame cap on the slow ~1MHz cores too. Pass `maxInstructions`
> to override the budget, `presetMemory`/`stopAtPC` for codecs that read RAM globals
> or need a mid-routine halt),
> **`watch({on:'range'})`** (log EVERY read/write hitting an address range — discovery),
> **`watch({on:'pc'})`** (coverage trace — distinct PCs executed in a window),
> **the RE-INJECT trio** (put an edited asset BACK, all 14): **`romPatch({op:'findPointer'})`**
> (find every pointer to a ROM offset — Genesis 32-bit BE, SNES LoROM/HiROM, GBA
> 0x08000000+offset incl. literal pools, banked 8-bit 16-bit-LE aliases),
> **`romPatch({op:'makeStored'})`** (wrap raw bytes so the game's OWN decompressor expands them
> verbatim — GBA LZ77 / SNES LC_LZ2 / SMS+MSX RLE / NES PackBits / `raw` for the
> uncompressed-graphics systems; Nemesis + C64 crunchers honestly refused), and
> **`romPatch({op:'relocate'})`** (write to free space + repoint),
> `cheats({op:'lookup'})`/`cheats({op:'search'})`/`cheats({op:'apply'})`/`cheats({op:'make'})` (cheat
> lookup/apply/create), `cpu({op:'read'})`, `memory({op:'search'})`/`memory({op:'searchNext'})`/`memory({op:'readCart'})`/`memory({op:'classify'})`,
> `memory({op:'snapshot'})`/`memory({op:'diff'})`/`state({op:'diff'})`, `watch({on:'mem'})`/`breakpoint({on:'write',precision:'sampled'})`.
> `audioDebug({op:'inspect'})` covers the 12 systems with a sound chip (all but Atari 2600/7800).
> **`watch({on:'dma', precision:'exact'})`** (which DMA wrote a VRAM tile, and from where) is **Genesis-only**
> (VDP DMA) — elsewhere use `breakpoint({on:'write'})`/`watch({on:'range'})`. All other RE tools above
> work on every platform that has the register-write/watch core hooks (all 14).
> `disasm({target:'rom'})` + `disasm({target:'references'})` + `disasm({target:'project'})` cover **all 14** — every
> CPU family disassembles through a native binutils `objdump` (WASM), and
> `disasm({target:'project'})` reassembles byte-exact through the matching native
> `as`/`ld`/`objcopy`. The per-platform notes below cover the platform-SPECIFIC
> inspectors + chips (PC Engine + MSX: generic shapes only so far).

- **SNES** (snes9x patched): `sprites({op:'inspect'})`, `palette({source:'live'})`, `cpu({op:'read', cpu:'main'|'spc700'})`, getDspState (full per-voice + master mixer), `memory({op:'read'})` regions for OAM/CGRAM/ARAM/FillRAM. Audio + video both deeply introspectable.
- **NES** (fceumm patched): `sprites({op:'inspect'})`, `palette({source:'live'})`, `cpu({op:'read'})` (6502), `background({view:'renderState'})` (PPUCTRL/PPUMASK decoded → active CHR bank + file offset), `memory({op:'read'})` regions for OAM/Palette/Nametables/CHR/CPU_REGS/PPU_REGS/APU_REGS.
- **Genesis** (gpgx patched): `sprites({op:'inspect'})`, `palette({source:'live'})`, `cpu({op:'read', cpu:'main'})` for 68K, getYm2612State (limited — internal struct), getPsgState, `memory({op:'read'})` regions for CRAM/VSRAM/VDP_REGS/Z80_RAM/M68K/YM2612/PSG/VRAM.
- **SMS / Game Gear** (gpgx patched): `sprites({op:'inspect'})` (SAT decode + sprite-sheet PNG), `palette({source:'live'})` (6-bit BGR for SMS, 12-bit BGR for GG), `tiles({op:'png'})` (4bpp interleaved, 16KB VRAM as 512-tile sheet), `cpu({op:'read'})` (Z80 — A/F/BC/DE/HL/IX/IY/shadows + flags + interrupt state), `audioDebug({op:'inspect', chip:'psg'})` (SN76489 — 3 tone + 1 noise; same gpgx region as Genesis), `background({view:'renderState'})` (VDP regs → name table / BG-tile / sprite-tile / SAT addresses + scroll + display state), `memory({op:'read'})` regions for sms_vram, sms_cram, sms_vdp_regs, sms_z80_regs (gg_vram, gg_cram for Game Gear's 64-byte palette). `disasm({target:'rom'})` + `disasm({target:'references'})` + `disasm({target:'project'})` run through the native binutils z80 `objdump` (WASM, `-m z80`) with full prefix coverage (CB/ED/DD/FD/DDCB/FDCB) and the same auto-label / register-annotation / file-offset / untilReturn pipeline as NES/SNES.
- **Game Boy / Game Boy Color** (gambatte patched): `sprites({op:'inspect'})` (40-sprite OAM decode + sprite-sheet PNG with sprite-priority + h/v flip), `palette({source:'live'})` (DMG: BGP/OBP0/OBP1 byte decode → 4 shades each; GBC: 64-byte BCPS/OCPS palette RAM → 8 palettes × 4 colors BGR555), `tiles({op:'png'})` (384 tiles from $8000-$97FF), `cpu({op:'read'})` (SM83 — A/F/BC/DE/HL + flags + IME/halt), `audioDebug({op:'inspect', chip:'gb'})` (DMG APU — 2 pulse + wave + noise with timer→freq→note, sweep, duty, panning), `background({view:'renderState'})` (LCDC bit-by-bit, scroll, LY/LYC, window, GBC extras: VRAM bank / KEY1 / BCPS/OCPS index), `memory({op:'read'})` regions for gb_vram, gb_oam, gb_io, gb_hram, gb_bgpdata, gb_objpdata, gb_cpu_regs. `disasm({target:'rom'})` + `disasm({target:'references'})` + `disasm({target:'project'})` route through the native binutils z80 `objdump` in its `gbz80` machine (WASM, `-m gbz80`) — full CB-prefix coverage + SM83-specific opcodes (`ld (hl+),a`, `ldh`, `reti`, `ld hl,sp+e8`). One z80-elf binutils serves both plain Z80 (SMS/GG/MSX) and the GB CPU.
  - **Toolchains:** default is **C** via SDCC's sm83 port (same SDCC that powers SMS/GG/MSX/Coleco). For hand-tuned asm, pass `language:"asm"` to route through RGBDS. The C path uses `__sfr __at 0xFFNN` to bind GB I/O regs; helper headers under `src/platforms/gb/lib/c/gb_hardware.h` define LCDC/STAT/SCY/SCX/LY/BGP/OBP0/OBP1/etc. for both DMG and CGB. The SDCC 4.4.0 codegen quirk (`for (;;) { switch + write to __sfr }` crashes the register allocator) applies — use `do { ... } while (1)` and table-lookup writes instead.
- **Atari 2600** (stella2014 patched): `palette({source:'live'})` (NTSC 128-color palette PNG; current background luma+hue extracted from TIA snapshot), `sprites({op:'inspect'})` (no OAM — returns the 5 graphics objects state P0/P1/M0/M1/Ball + a current-scanline PNG showing TIA composition), `cpu({op:'read'})` (6502 — A/X/Y/P/SP/PC from the M6502 internal regs), `background({view:'renderState'})` (decodes the 32-byte TIA snapshot into playfield/sprite/colors), `memory({op:'read'})` regions for `system_ram` (128 bytes of RIOT RAM), `a26_tia_regs` (32-byte TIA snapshot), `a26_cpu_regs` (7-byte 6502 snapshot). `disasm({target:'rom'})` + `disasm({target:'references'})` anchor to the top of the bank ($F000-$FFFF) with vector-table labels (NMI/RESET/IRQ at $FFFA).
- **Atari 7800** (prosystem patched): `palette({source:'live'})` (256-color master PNG; MARIA palette block at $20-$3F decoded into 8 palettes × 3 colors + backdrop), `sprites({op:'inspect'})` (no OAM — returns the MARIA control regs + the DPP display-list-list pointer for the agent to walk), `cpu({op:'read'})` (6502 — A/X/Y/P/SP/PC from prosystem's sally globals), `background({view:'renderState'})` (MARIA CTRL bits + DPP + CHARBASE + dlistPtr), `memory({op:'read'})` regions for `system_ram` (the entire 64KB 6502 address space — MARIA regs, RAM, ROM all visible) + `a78_cpu_regs`. `disasm({target:'rom'})` + `disasm({target:'references'})` default to the top 16KB ($C000-$FFFF) where the reset vector lands.
- **Commodore 64** (vice patched): `palette({source:'live'})` (the 16-color hardware-fixed palette PNG + current border/background/extra-bg indices decoded from VIC-II regs), `sprites({op:'inspect'})` (8 MOBs decoded into the generic shape with X/Y/color/multicolor/expand-X/expand-Y/priority + the screen-RAM sprite-data pointers at $07F8 so the agent can locate sprite pixel blocks), `cpu({op:'read'})` (6510 — A/X/Y/P/SP/PC from a `#define`-aliased live register file + the I/O port at $0001 decoded into LORAM/HIRAM/CHAREN), `audioDebug({op:'inspect', chip:'sid'})` (6581/8580 — 3 voices {waveform, freq→note, pulse-width, ADSR} + filter cutoff/resonance/mode), `background({view:'renderState'})` (VIC-II regs decoded into mode/scroll/colors/sprites, VIC bank from CIA2 $DD00, absolute screen + char base addresses), `memory({op:'read'})` regions for `system_ram` (64 KB RAM), `c64_color_ram` (1 KB), `c64_vic_regs` (64 B), `c64_sid_regs` (29 B via sid_peek), `c64_cia1_regs`/`c64_cia2_regs` (16 B each from `c_cia[]`), `c64_cpu_regs` (7 B). `disasm({target:'rom'})` + `disasm({target:'references'})` accept `.prg` files (2-byte load-address header) and the C64 register annotation table for VIC-II / SID / CIA registers. Starter snippets cover vic_init / sprite_table / sid_play / read_joystick / basic_stub.
- **Game Boy Advance** (mgba patched): `sprites({op:'inspect'})` (128 OAM sprites → generic shape with shape/size, 9-bit signed X, affine/hidden, tile/palette/priority), `palette({source:'live'})` (256 BG + 256 OBJ 15-bit BGR555, `area:'bg'|'sprite'`), `cpu({op:'read'})` (ARM7TDMI — 16 gprs r0-r15 + cpsr/spsr + mode + ARM/THUMB, plus `execPc` adjusted for pipeline prefetch), `audioDebug({op:'inspect', chip:'gba'})` (4 DMG PSG channels + 2 Direct Sound DMA FIFOs, master/bias), `background({view:'renderState'})` (DISPCNT bg-mode + per-BG enable/priority/char-base/map-base/color-mode, forced-blank, OBJ enable), `memory({op:'read'})` regions for `gba_cpu_regs`, `gba_io_regs` (the IO page — video AND audio regs), `gba_palette`, `gba_oam`, plus system_ram/video_ram/save_ram. `disasm({target:'rom'})` + `disasm({target:'references'})` + `disasm({target:'project'})` run through the native binutils `arm-none-eabi-objdump` (WASM) — ARM by default, `thumb:true` for Thumb code; the byte-exact project reassembles through `arm-none-eabi-as`/`ld`/`objcopy`. (Note: GBA C compiles mostly to Thumb reached via an ARM crt0 stub, so an ARM-mode disasm of a full ROM decodes the Thumb spans as `.byte` — still byte-exact, just less readable until ARM/Thumb mode-tracking lands.)
- **Atari Lynx** (handy patched): `palette({source:'live'})` (16-entry 12-bit Mikey palette → RGB), `cpu({op:'read'})` (65C02 — A/X/Y/P/SP/PC + flags), `audioDebug({op:'inspect', chip:'mikey'})` (4 channels — volume, timer→freq→note, 12-bit LFSR state), `background({view:'renderState'})` (DISPCTL DMA-enable/flip/color-mode + display base address), `memory({op:'read'})` regions for `lynx_cpu_regs`, `lynx_hw_regs` (the $FC00-$FDFF Suzy+Mikey window — sprite engine regs, LCD control, audio, palette), plus system_ram. **`sprites({op:'inspect'})` is a special case:** the Lynx has NO fixed OAM — sprites are SCB (Sprite Control Block) linked lists in RAM walked by Suzy, so `sprites({op:'inspect'})` returns the SCB list head (SCBNEXT $FC10/$FC11) and instructions to walk the chain over system_ram rather than a sprite table.
- **MSX, ColecoVision**: standard system_ram + save_ram + video_ram. Deeper introspection not yet added — extend by patching their cores following the snes9x/gpgx/fceumm/vice pattern (see scripts/patches/).

Starter snippets per platform live under `src/platforms/<platform>/lib/`. Discover via `scaffold({op:'snippets', platform})` (default `mode:'list'`), fetch one via `scaffold({op:'snippets', platform, mode:'get', name})`. SNES + NES + Genesis + SMS + Game Boy + Atari 2600 + Atari 7800 have substantial snippet libraries; others are minimal.

## ROMs are finalized for real hardware automatically

`build({output:'rom'})` / `build({output:'run'})` return ROMs that boot on **real hardware,
flashcarts, and strict emulators (RetroDECK / RetroArch)** — not just our
lenient WASM cores. The build pipeline runs each platform's required
post-link finalize step for you. **You do NOT need to checksum, pad, or
header-patch the output yourself.** What gets fixed:

- **Genesis** — padded to a 128KB boundary (min 512KB) + `$18E` checksum.
- **GB / GBC** — `rgbfix`: Nintendo logo ($0104), header checksum ($014D),
  global checksum, CGB flag ($0143 = $00 for `.gb`, $C0 for `.gbc`).
- **SMS** — `TMR SEGA` header at $7FF0 + checksum ($7FFA) + region/size byte
  (export region $4) so the SMS BIOS doesn't reject it. (GG BIOS doesn't
  check, but it's written anyway.)
- **SNES** — padded to a power of 2 (min 32KB) + internal checksum ($FFDE) +
  complement ($FFDC), LoROM/HiROM auto-detected.
- **NES** — the iNES header is emitted by the linker config; nothing to add.

Why this matters: our WASM emulator skips the boot-ROM validation that real
hardware runs, so a ROM can look perfect in `frame({op:'screenshot'})`/`playtest` yet fail
to boot on a console or RetroDECK. The finalize step closes that gap. The
build response `romLayout` / `log` states what was applied.

## First, try build({output:'run'})

**`build({output:'run'})` is the primary tool.** It does build + load + run + screenshot
in a single call, returning the image inline. Reach for it before any 4-call
sequence of build({output:'rom'}) → loadMedia → frame({op:'step'}) → frame({op:'screenshot'}).

```js
build({
  output: "run",
  platform: "gbc",
  source: /* your C or asm */,
  frames: 60,
  holdInputs: [{ a: true }],  // optional — hold buttons during the run
})
```

Round trip is ~50-500 ms depending on platform. Use it for fast iteration,
prototyping, "does my change still render correctly", "does the d-pad
move the sprite". When you change a line of code, the next call is usually
just another `build({output:'run'})` with the same args.

**Where it shines:**
- Trying out a new game-loop change
- Verifying a sprite renders at the right position
- Testing input handling — `holdInputs: [{right: true}]` for 60 frames and
  see if the player moved right
- Quick "did I break it" sanity checks after a refactor

You don't need `loadMedia` / `frame({op:'step'})` / `frame({op:'screenshot'})` separately for any
of these. The 4-call workflow only matters when you want to drive multiple
emulator-state changes within one ROM lifetime (e.g. screenshot at frame 30,
save state, screenshot at frame 60, etc.).

## Going deeper

When `build({output:'run'})` is too coarse, the long-form workflow:

1. `build({output:'rom', platform, source})` → get a ROM as base64 bytes
2. `loadMediaBytes({ platform, base64 })` → load without disk I/O
3. `frame({op:'step', frames: N})` or `runUntil({ condition })` → advance time
4. `frame({op:'screenshot'})` for vibes, `tiles({op:'pixels'})`/`tiles({op:'fingerprints'})` for byte-precise work, `memory({op:'read'})` for game state
5. `input({op:'set'})` / `input({op:'press'})` / `input({op:'sequence'})` to drive the game
6. `state({op:'save'}, "checkpoint")` / `state({op:'load'}, "checkpoint")` for try/undo

## Build errors

Every build tool returns `issues: [{file, line, col, severity, message, stage}, ...]`. Use that array, not the raw `log`. If `issues` is empty but `ok: false`, fall back to `log`.

**Crash isolation (R12).** Every WASM toolchain call runs in a child worker process. If a tool aborts (`_abort()`, SIGSEGV, OOM), only the worker dies — the MCP server keeps running, all other agent sessions are unaffected, tool registration + save states + playtest windows survive. The build response surfaces as `{ ok: false, stage: "crash", log: "[crash] worker exited unexpectedly — signal=… code=…", crash: { exitCode, signal } }`. Treat `stage: "crash"` as "the toolchain blew up — log the args + source somewhere durable so it can be triaged; you can keep iterating in this session without reconnecting".

## ROM hacking workflow

The full byte-patch loop is six MCP calls, no custom scripts:

```js
cart({op:'identify', path })                       // 1. what is it?
disasm({target:'rom', path, startAddress, untilReturn:true })
                                                   // 2. find the target
                                                   //    (auto-tagged reset/nmi/irq labels,
                                                   //     HW register names, file-offset
                                                   //     comments — for NES, BOTH .nes and
                                                   //     prg.bin offsets emitted —
                                                   //     mapper-aware addresses)
assembleSnippet({ cpu, origin, code: "lda #$00\nrts" })
                                                   // 3. encode replacement bytes
memory({op:'write', region:"system_ram", offset:0xRAM, hex })
                                                   // 4. VERIFY first — write the value
                                                   //    on the live emulator, watch for
                                                   //    the expected behavior. Cheaper than
                                                   //    a wrong patch.
romPatch({op:'write', path, offset, hex, expect: "<current bytes>" })
                                                   // 5. patch with safety check —
                                                   //    refuses if existing bytes differ
romPatch({op:'diff', platform, a: original, b: patched })    // 6. verify the patch landed
loadMedia({ platform, path: patched }) → frame({op:'screenshot'})  // 7. run it
```

**Finding which CODE wrote a byte.** Static disasm reading is the slow part —
multiple `cmp #$XX` instructions look identical. Don't guess. Two tools, in order
of precision:

- **`breakpoint({on:'write', address, maxFrames, pressDuring})` — the precise one (NES).**
  Arms a core-level WRITE WATCHPOINT and returns the EXACT writing instruction's
  PC, captured inside the CPU write path — correct even for NMI/IRQ-driven writes
  (the common NES case, where a frame-sampled PC is just the idle loop). This is
  the right tool when you need the actual writer.
  ```js
  breakpoint({ on:'write', address: 0x00CD, maxFrames: 300, pressDuring:[{ frame:30, button:"A" }] })
    → { found:true, pc:"$AF85", value:"0x81", hits:19 }
  disasm({ target:'rom', path, startAddress: 0xAF85 })   // → the real store instruction
  ```
  Supported on **all 14 tier-1 systems** — NES, GB/GBC, Genesis, SMS/GG, SNES,
  Atari 2600/7800, C64, Lynx (65C02), PC Engine (HuC6280), MSX (Z80), and GBA
  (ARM7) — every bundled CPU family. On a banked mapper a `$8000-$BFFF` pc may be
  in a switchable bank; `breakpoint({on:'write'})` reports the `bank` (NES/GB/SMS-GG) so you can
  pass it to `disasm({target:'rom'})`.
- **`watch({on:'mem'})` / `breakpoint({on:'write',precision:'sampled'})` — cross-platform, frame-sampled.** Step until
  the byte changes; the returned `pc` is a frame-boundary sample (a lead, not a
  guarantee under interrupts — cross-check the value trace). Use on non-NES, or
  for the value timeline.
- **`memory({op:'snapshot'})` + `memory({op:'diff'})` — "which bytes did THIS event touch?"** When
  you don't yet know the address: `memory({op:'snapshot'})` before the event, trigger it
  (`input({op:'press'})`/`frame({op:'step'})`), then `memory({op:'diff'})` — you get just the changed offsets
  with before/after, no eyeballing two RAM dumps. The fast way to find an area-id
  / phase / flag byte a transition writes. (`state({op:'diff'})` is the coarse
  whole-machine "did anything change?" version.)

```js
breakpoint({ on:'write', precision:'sampled', region:"system_ram", offset:0x03B6, maxFrames:300,
                pressDuring:[{ frame:30, button:"A" }] })
  → { pc: "$E3AF" (frame-sampled), changes:[{ before:31, after:32 }] }
```

**Execution breakpoints (all 14 platforms) — read the register at the instruction.**
When the answer isn't a flat table but a value computed in a register, stop the
CPU *at the instruction* and read it:
- **`breakpoint({on:'pc', address, maxFrames, pressDuring})`** — runs until the CPU PC
  reaches `address`, then FREEZES the CPU exactly there. Then `cpu({op:'read'})` reads
  the full register file at that precise moment. The canonical RE move: break at a
  decoder's `move.b (a0),d0`, read `A0` → the source pointer, `memory({op:'readCart'})`/
  `memory({op:'read'})` at it. Turns "infer for hours" into ~3 calls.
- **`breakpoint({on:'read', address, ...})`** — the read-side mirror of `breakpoint({on:'write'})`: the
  EXACT instruction PC that READ an address (who *consumes* a value).
- **`frame({op:'stepInstruction'})`** — CPU-level single-step; pair with `cpu({op:'read'})` to watch
  registers change one instruction at a time.
- These work on all 14 platforms (every bundled CPU family) — including `breakpoint({on:'write'})`
  (as of 0.6.0 PC Engine gained its write watchpoint, so no platform is the exception
  anymore).

```js
breakpoint({ on:'write', address:0xFF2000 }) → { pc:"$49E", ... }   // get a real instruction PC
breakpoint({ on:'pc', address:0x49E })       → { hit:true, pc:"$49E" }   // CPU frozen here
cpu({ op:'read', platform:"genesis", cpu:"main" })             // → registers.A0 = the pointer
```

All in the `assets` category except `disasm({target:'rom'})` (in `debug`); the breakpoint
trio (`breakpoint({on:'pc'})`/`breakpoint({on:'read'})`/`frame({op:'stepInstruction'})`) is in `advanced`.

### Before you hunt — check the cheat database (`cheats({op:'lookup'})`)

For a KNOWN commercial ROM, the fastest way to find the byte is to not hunt at
all: the bundled cheat database is a free, crowd-sourced **map of labeled RAM
addresses and code sites**. Call `cheats({op:'lookup', path})` FIRST — for a matched
game it returns that game's cheats with the address decoded out of each one:

```js
cheats({ op:'lookup', path: "Rygar (USA).nes" })
// → { matched:true, confidence:"name", game:"Rygar (USA)", crc32:"...",
//     entries:[
//       { desc:"Infinite Magic Attack", code:"00CD:FF",
//         parts:[{ address:"$00CD", value:"0xFF", kind:"ram" }] },   // ← labeled RAM var
//       { desc:"Infinite Health", code:"SXUZXTSA",
//         parts:[{ address:"$8E20", value:"0xA5", compare:"0x85", kind:"code" }] }, // ← code site
//       ...] }
```

So "which byte holds magic?" is answered in one call: `$00CD`. A RAM cheat
(`kind:"ram"`) is a **labeled variable**; a ROM cheat (`kind:"code"`, has a
`compare`) is a **labeled patch site** — point `disasm({target:'rom'})` at its address
to read the routine. Filter a long list with `filter:"health"` or `kind:"ram"`.

**Device types are labeled — it's not all "Game Genie."** Each decoded part
carries a `device` so you know exactly what you're looking at:
`game-genie` (NES/Genesis/SNES/GB ROM patches), `pro-action-replay` (SNES — the
most common SNES device, RAM pokes like `7E0DBF63`), `gameshark` (GB RAM),
`action-replay` (SMS/GG), or `raw` (`ADDR:VAL`). A few formats (e.g. the SMS/GG
Game Genie variant) are labeled with their device but left address-undecoded
rather than guessing — honest over wrong.

**Trust it like you trust disasm — verify, don't assume.** A match is by
No-Intro name / filename, NOT a verified CRC, so it's a PROBABLE match: very
likely right, but a different region/revision can use different addresses. The
`note` says so explicitly. Confirm a label before patching — the cheapest
confirmation is to apply it and watch:

```js
cheats({ op:'apply', path:"Rygar (USA).nes", desc:"Infinite Magic Attack" })  // enable it live
frame({ op:'screenshot' })                                            // see the effect → label confirmed
// or apply a RAW code from anywhere:
cheats({ op:'apply', code:"00CD:FF" })          // RAM poke → appliedAs:"ram"
cheats({ op:'apply', code:"SXIOPO" })           // Game Genie (core decodes it)
cheats({ op:'apply', code:"C06C:0C:26" })       // raw ROM patch → auto-re-encoded to a read-intercept (appliedAs:"rom", reencodedFrom)
cheats({ op:'clear' })                          // remove all
```

**`appliedAs` tells you how it went in** — `"ram"` (per-frame poke), `"rom"` (in-core
read-intercept), `"raw"` (core-decoded device code), or `"rom-unencodable"` (a ROM
address that couldn't be made into a working ROM patch — likely a no-op; add a COMPARE
byte). A raw `ADDR:VAL:COMPARE` on a ROM address would otherwise silently no-op as a RAM
poke, so `cheats({op:'apply'})` transparently re-encodes it to the platform's ROM-patch device (NES/
Genesis/GB Game Genie, SNES Game Genie — NOT Pro Action Replay, which is RAM). **Boot-time
cheats:** pass `loadMedia({ cheats:[…] })` to apply codes BEFORE frame 0 (iterating on a
boot-seeded value), and use `host({op:'reset', hard:true})` for a true power-cycle — plain `host({op:'reset'})`
is the RESET button and leaves work RAM (and boot-seeded state) intact.

`cheats({op:'apply'})` is also just **fun** — play any matched game with infinite lives,
invincibility, etc. It is **NON-DESTRUCTIVE**, exactly like RetroArch: the cheat
lives in volatile core state (a per-frame RAM write, or an in-core read-intercept
for ROM cheats), the ROM file on disk is NEVER touched, and `host({op:'reset'})` / `state({op:'load'})`
/ `cheats({op:'clear'})` removes it. **`cheats({op:'lookup'})` DB coverage (13/14):** NES, GB/GBC,
SNES, Genesis, SMS/GG, Atari 2600/7800, **Lynx**, **GBA**, **PC Engine**, **MSX** —
every tier-1 system except **C64** (the cheat database ships no C64 entries, so
there's nothing to look up; `cheats({op:'make'})` still works on C64). The DB is its own
package (`romdev_game_codes`), lazy-loaded per platform; `cheats({op:'search', platform,
query})` fuzzy-finds a game by name. One caveat: **GBA** DB cheats are
Code Breaker / GameShark (encrypted), so they're **apply-only** — the `code`
applies live, but the address isn't descrambled into a labeled map the way the
other systems are (the response says so via `mapNote`). **`cheats({op:'apply'})` /
`cheats({op:'make'})` work on all 14.** Unmatched ROMs (homebrew, your own WIP, an
unlisted dump) return `matched:false` with a clear reason — the tool never
guesses.

### Creating NEW cheat codes (`cheats({op:'make'})`)

The inverse of decoding: turn a byte you found into a shareable code — for ANY
ROM, **including your own homebrew/WIP** where no DB entry exists. This closes
the loop with the byte-hunting tools:

```js
breakpoint({ on:'write', precision:'sampled', region:"system_ram", offset:0xCD })   // 1. find the byte (or use cheats({op:'lookup'}))
cheats({ op:'make', platform:"nes", address:0x00CD, value:0xFF })
//   → { raw:"CD:FF", note:"RAM cheat...", ... }            // 2. RAM poke → raw code
// For a ROM/Game-Genie patch, read the current byte and pass it as `compare`:
memory({ op:'read', region:"prg_rom", offset:0x8E20 })          //   (current byte = 0x85)
cheats({ op:'make', platform:"nes", address:0x8E20, value:0xA5, compare:0x85 })
//   → { gameGenie:"SZZAETSA", verified:true, raw:"8E20:A5:85", ... }
cheats({ op:'apply', code:"SZZAETSA" }) → frame({ op:'screenshot' })           // 3. confirm it works
```

`cheats({op:'make'})` encodes for the platform's NATIVE device(s) and **labels each one**
— NES/Genesis → Game Genie; SNES → Pro Action Replay **and** Game Genie; GB/GBC
→ Game Genie (ROM) + GameShark (RAM); SMS/GG → Action Replay — plus the raw
`ADDR:VAL` always. Each generated code carries `verified:true` (decoded back and
confirmed; the encoders round-trip 100% against the full DB — NES/Genesis/GB/GBC
Game Genie, SNES Game Genie + PAR, GB GameShark). Force a specific device with
`device:`. A RAM cheat needs just `address`+`value`; a ROM patch adds `compare`
(the byte currently there). Nothing is ever written to a ROM file.
**`cheats({op:'make'})` works on all 14 tier-1 systems** — the systems with no native
letter-code device (Atari 2600/7800, Lynx, GBA, C64, PC Engine, MSX) get a
verified raw `ADDR:VAL` code that `cheats({op:'apply'})` passes straight to the core.

```js
cheats({ op:'make', platform:"snes", address:0x7E0DBF, value:0x63 })
//   → { codes:[ {device:"pro-action-replay", code:"7E0DBF63", verified:true},
//               {device:"game-genie", code:"17D8-9EE8", verified:true} ],
//       raw:"7E0DBF:63", ... }
```

### Editing in-game TEXT (font maps)

Games store text as their own tile-index encoding (Excitebike: A=$0A; Mario:
ASCII-offset; FF: sparse). Three tools automate the round-trip instead of
hand-deriving the table:

- **`text({op:'learn'})`** — infer the char→tile-ID map. TWO modes:
  - ROM mode: `knownStrings:[{text, offset}]` when you found the text's bytes.
  - **LIVE mode: `fromScreen:[{text, row, col}]`** — the text is on screen RIGHT
    NOW; reads the tile IDs straight from the live BG map at a tile position. This
    breaks the chicken-and-egg (you'd otherwise need the ROM offset you're
    hunting). Works on every tilemap platform (NES/SNES/Genesis/GB/GBC/SMS/GG/C64);
    `background({view:'map'})` shows you where the text sits. (atari2600/7800, lynx,
    gba have no text-tile nametable → use ROM mode.)
- **`text({op:'find', romPath, text, fontMap})`** — locate the string in the
  ROM. Returns `fileOffset` (.nes), `prgFileOffset` (prg.bin), and a bank-aware
  `cpuAddress` + `bank` (NES/GB/GBC in-bank address, Genesis flat; SNES is
  mapper-dependent → use the offsets) — feed `{startAddress, bank}` to
  `disasm({target:'rom'})`. Flags a likely length-prefix byte to avoid the classic
  overrun.
- **`text({op:'encode'})`** — text + map → bytes, ready for `romPatch({op:'write'})`.

```js
text({ op:'learn', fromScreen:[{ text:"START", row:13, col:11 }] })   // read tiles off the live screen
text({ op:'find', romPath, text:"MOUNTAIN", fontMap })            // → offsets + bank + context
text({ op:'encode', text:"NEW TEXT ", fontMap }) → romPatch({ op:'write', ... })  // rewrite it
```

**Tools for hacking, by category:**

- `romPatch({op:'write', path, offset, hex, expect, allowExpand})` — generic byte
  splicer with safety check. THE primitive — every other hack tool
  composes through it. `expect` refuses the write if existing bytes don't
  match, catching the silent corruption when a patch authored against
  region A is applied to region B.
- `assembleSnippet({cpu, origin, code})` — assemble a tiny chunk of asm
  to raw bytes. No header, no linker config, no segments. Supports
  `6502 / 65c02 / 65816 / 68k / z80 / sm83 / gb / gbc / huc6280`.
  Z80 NOTE: sdas dialect requires `#` on immediates (`ld a,#5`, not
  `ld a,5`).
- `romPatch({op:'diff', platform, a, b})` — mapper-aware ROM diff. Reports CPU
  addresses (NROM-128 mirrors correctly, SNES LoROM banks as `XX:XXXX`),
  per-region tallies (PRG vs CHR vs header), and `tile: N` annotations
  on CHR changes for direct sprite-hack identification.
- `romPatch({op:'findFree', path, minLength, fillBytes})` — locate runs of $FF
  or $00 for asm overlays. Sorted longest-first.
- `disasm({target:'references', path, platform, address})` — find every instruction
  that references a target address. Classifies refs as
  `call/jump/branch/read/write/use/ref`. Walks the vector table too.
  Limitation: only direct addressing modes; indirect/computed jumps
  not detected.
- `romPatch({op:'spliceCHR', path, platform, pngBase64, tileIndex, expect, bank, paletteHint})` —
  composition: PNG → tile bytes → splice into CHR at tile slot N.
  Auto-locates iNES CHR base. `expect` checks the existing tile bytes.
  `bank: N` (NES) replaces magic file offsets; `paletteHint:["#RRGGBB",...]`
  gives explicit RGB→palette-index mapping (skips the default quantization
  that requires PNGs with exactly 4 distinct grayscale levels).
- `cheats({op:'lookup', path, filter, kind})` — match a KNOWN ROM to the bundled
  cheat DB and return THIS game's labeled RAM addresses + code sites
  (decoded from each cheat). The free "which byte holds X?" map. Probable
  match (name/filename, not CRC) — verify before patching.
- `cheats({op:'apply', code | desc+path, index, enabled})` /
  `cheats({op:'clear'})` — apply a cheat to the loaded game LIVE and
  non-destructively (the RetroArch way: volatile core state, ROM file
  never touched). Use a raw `code` or a matched `desc`. Doubles as the
  cheapest way to VERIFY a `cheats({op:'lookup'})` label (apply → screenshot), and
  as a fun-bonus (play with infinite lives, etc.).
- `cheats({op:'make', platform, address, value, compare?, style})` — CREATE a new
  cheat code from an address+value (the inverse of decoding). Returns a
  Game Genie letter code + the raw ADDR:VAL, with a `verified` round-trip
  check. Works on any ROM incl. homebrew/WIP. Pair with `breakpoint({on:'write',precision:'sampled'})`/
  `cheats({op:'lookup'})` (find the byte) → `cheats({op:'make'})` (encode) → `cheats({op:'apply'})` (confirm).
- `watch({on:'mem', region, offset, length, frames, pressDuring})` /
  `breakpoint({on:'write', precision:'sampled', region, offset, maxFrames, pressDuring})` — frame-level
  memory-write trace. Reports every change with PC, so you can map a
  RAM byte back to the writing code path. Cross-platform. The "find
  the byte" half of hacking, mechanized. (Reach for this when a ROM
  ISN'T in the cheat DB, or to find a byte no cheat covers.)
- `background({view:'rendered'})` — at the current emulator state, walk the
  BG nametable + OAM and return the set of tile IDs actually being
  drawn. Sample at known game states (title / gameplay / menu) and diff
  the sets to map tile IDs to game assets without scanning sheets by eye.
- `cart({op:'extract', path, outputDir})` — split ROM into standard parts
  (NES: header.bin/prg.bin/chr.bin; SNES: copier_header + rom + internal
  header; Genesis: vectors/header/body; GB: boot/header/body) plus a
  manifest.json with mapper, mirroring, etc.
- `cart({op:'wrap', platform, ...})` — counterpart to `cart({op:'extract'})`.
  Emits `wrapperSource` (.s) + `linkerConfig` (cc65 ld65 cfg) ready
  for `build({output:'rom'})`. Per-platform templates.
- `disasm({target:'rom'})` — see "Disassembler" section below for the full
  annotation set.

For graphics swaps specifically:
- `tiles({op:'png', source:'path', platform, path, bank, paletteFromEmulator, paletteIndex})`
  from a source game → PNG of its tiles. `bank: N` (NES 4 KB CHR bank
  index) replaces magic file-offset math. `paletteFromEmulator: true`
  + `paletteIndex` colors the export with the live game palette
  (instead of grayscale) — much easier to recognize art and edit in a
  pixel tool.
- `importArt({from:'rom', sourceRom, sourcePlatform, sourceBank,
  sourceTileX/Y/W/H, targetPlatform, outputPng, intent, paletteIndex})`
  — one-call lift of a tile region from a source game's ROM into the
  target platform's tile format. Combines extract + crop + quantize +
  optional manifest. Under `intent:"homebrew"` reads the live source
  palette automatically (same `paletteFromEmulator` semantics as
  `tiles({op:'png',source:'path'})`); under `intent:"rom-hack"` preserves source
  bytes verbatim. Output PNG + manifest feed straight into
  `importArt({from:'texturepacker'})`.
- `encodeArt({stage:'tiles', platform, pngBase64})` → target-platform tile bytes
- `romPatch({op:'spliceCHR'})` to write them into the CHR region of your target ROM
  (handles the `encodeArt({stage:'tiles'})` + `romPatch({op:'write'})` composition in one call)

## Disassembler

`disasm({target:'rom'})` ships with every annotation enabled by default:

```js
disasm({target:'rom', path, platform:"nes", startAddress:0xC184,
                length:64, untilReturn:true})
// →
//   reset:  sei                  ; C184 78        x  @0x194 (prg @0x184)
//           cld                  ; C185 D8        .  @0x195 (prg @0x185)
//           lda  #$00            ; C186 A9 00     ..  @0x196 (prg @0x186)
//           sta  $2000           ; C188 8D 00 20  ..   @0x198 (prg @0x188) PPUCTRL
//           ldx  #$FF            ; C18B A2 FF     ..  @0x19B (prg @0x18B)
//           ...
```

What you get:
- **Vector labels** (`reset:`, `nmi:`, `irq:`) auto-tagged from the iNES /
  SNES / Genesis vector tables. For SMS/GG, fixed Z80 vectors are tagged:
  `reset:` at $0000, `rst08`/`rst10`/`rst18`/`rst20`/`rst28`/`rst30:` at
  their RST addresses, `irq:` at $0038 (SMS vblank handler), `nmi:` at
  $0066 (pause button). For GB/GBC, the SM83 vectors get the same
  treatment plus the dedicated IRQ vectors: `vblank:` at $0040,
  `lcd_stat:` at $0048, `timer:` at $0050, `serial:` at $0058,
  `joypad:` at $0060, and `entry:` at $0100. `autoLabelVectors:false`
  to turn off.
- **Hardware register names** (`; PPUCTRL`, `; PPUMASK`, `; SND_CHN`,
  `; VRAM`, `; LCDC`, `; VDP_CTRL`, `; IO_PORT_A` etc) on any operand
  that hits a known platform register. NES + SNES + Genesis + GB + SMS/GG
  tables built in. `annotateRegisters:false`.
- **File-offset comments** (`; @0xNNNN`) on every disassembled line —
  mapper-aware, so $C184 on NROM-128 correctly reports `@0x194`. Direct
  input to `romPatch({op:'write'})`'s `offset`. For NES iNES files, the header-stripped
  PRG offset is ALSO reported (`@0x194 (prg @0x184)`) so you can patch
  either the `.nes` file or `prg.bin` from `cart({op:'extract'})` without doing
  the -16 math. `annotateFileOffsets:false` to turn off.
- **Mapper-aware addressing**: NROM-128 mirror at $C000, MMC1/MMC3/UxROM
  top bank fixed at $C000, SMS sega-mapper slot-0/1/2 1:1 file mapping,
  GB/GBC slot 0 fixed + slot 1 banked (pass `bank` to target a non-
  default ROM bank). No more manual `startAddress: 49152` because the
  disassembler understood the mapping.
- **`endAddress` alternative to `length`** — disassemble "from X to Y"
  without computing byte count yourself.
- **`untilReturn: true`** — truncates at the first `rts/rti/rtl/bare jmp`
  (6502) or `ret/reti/retn/bare jp` (Z80) or `ret/reti/bare jp/jp hl`
  (SM83). Combine with an auto-tagged `reset:` label to grab exactly
  one routine.
- **`dataRanges: [{start, length}]`** — mark address ranges as `.byte`
  tables instead of bizarre disassembled "code." Useful for embedded
  sprite tables, music data, lookup tables.
- **`outputPath`** — writes raw asm to disk instead of returning a
  188KB JSON wad. Returns `{outputPath, asmBytes, asmLines}` for log/inspection.

Every CPU family disassembles through a native binutils disassembler compiled to
WASM: 6502/65816 via cc65's `da65`; Z80 (SMS/GG/MSX) + SM83 (GB/GBC) via one
z80-elf `objdump` (`-m z80` / `-m gbz80`); m68k (Genesis) via `m68k-elf-objdump`;
ARM/Thumb (GBA) via `arm-none-eabi-objdump`. No hand-rolled JS decoders. The
auto-label / register-annotation / file-offset / untilReturn handling is
post-processing layered on the objdump output.

### Whole-ROM, rebuildable projects — `disasm({target:'project'})`

`disasm({target:'rom'})` gives you one routine as text. `disasm({target:'project'})` turns an
**entire ROM into a complete, re-buildable project in one call**, across **all 14
systems** (NES, SNES, GB/GBC, SMS/GG, Genesis, **GBA**, C64, Atari 2600/7800,
**Lynx** — 65C02, **PC Engine** — HuC6280, and **MSX** — Z80; always byte-exact).
Each region disassembles through the CPU's native objdump and reassembles through
the matching native `as`/`ld`/`objcopy`, so the round-trip is guaranteed byte-for-byte:

```js
disasm({ target:'project', path: "game.nes", outputDir: "./game-disasm" })
// → { ok, platform, regions:[{file, startAddress, roundTripOk, readablePercent}],
//     roundTrip:{ allByteExact, failed:[] }, readablePercentAvg }
```

It splits the ROM into regions (per-16KB bank for banked NES, per-32KB bank for
SNES LoROM, slot0+slotX for GB, one flat region for SMS/Genesis/C64/Atari),
disassembles each, then **reassembles it and verifies the result is byte-exact
against the original**. Any line that doesn't reassemble faithfully falls back
to `.byte`/`db` data recovered from the address comments — so the emitted `.asm`
files ALWAYS rebuild to the original bytes (`roundTrip.allByteExact`). The
`readablePercent` per region tells you how much came back as real instructions
vs. data. Each `.asm` carries a provenance + round-trip header and is ready to
edit and rebuild with the platform's native toolchain.

Reassembler per CPU family (all bundled WASM, no installs): **cc65** ca65/ld65
for 6502 + 65816; native binutils **`as`/`ld`/`objcopy`** for the GNU CPUs —
`m68k-elf` (Genesis), `arm-none-eabi` (GBA), and one `z80-elf` for both Z80
(SMS/GG/MSX) and gbz80 (GB/GBC). objdump and `as` share GNU syntax, so objdump's
output feeds straight back into `as` with no translation; any line the assembler
won't reproduce exactly is healed to a `.byte` of its real bytes.

Caveats worth knowing up front:
- **SNES and large Genesis ROMs come back byte-exact but DATA-ONLY**
  (low `readablePercent`). Flat whole-ROM disassembly of a mostly-data image
  heals down to `.byte`; meaningful instruction coverage there needs recursive
  entry-point following, a known follow-up. The bytes are always correct.
- **GBA** rebuilds byte-exact but reads LOW: GBA C compiles mostly to Thumb,
  reached via an ARM crt0 stub, so an ARM-mode disasm decodes the Thumb spans as
  `.byte`. ARM/Thumb mode-tracking is the readability follow-up; the bytes are
  always correct. (The 192-byte GBA header is emitted as a clean data region.)
- Banked-NES is the strongest case — per-bank regions come back ~100%
  instructions. GB/GBC, SMS/GG, C64, and Atari are also near-100%.
- Platform is sniffed from the file extension; pass `platform:` to override.

## CHR/tile tools — file vs emulator source

`tiles({op:'pixels'})`, `tiles({op:'png'})`, `tiles({op:'png',source:'path'})`, `tiles({op:'fingerprints'})`,
and `tiles({op:'ascii'})` all accept an optional `path` arg:
- **With `path` set**: reads CHR straight from a file (iNES auto-locates
  CHR; raw `.chr`/`.bin` files read as-is). Use to survey assets BEFORE
  loading. Response reports `source: "file"`.
- **Without `path`**: reads from the running emulator's pattern table /
  VRAM. Response reports `source: "emulator"`.

## Demake / enhance / cross-platform workflow

The full "take game X on platform A, make it on platform B" pipeline:

1. Study source: `loadMedia({ platform: A, path })`, `recordSession`, `disasm({target:'rom'})`
2. Rip art: `tiles({op:'png', source:'path', platform: A, path})` returns a PNG sheet
3. Recook art: `encodeArt({stage:'tiles', platform: B, pngBase64})` re-encodes in B's tile format and bit depth
4. Write target game: `build({output:'run', platform: B, source})` for fast iteration
5. Embed converted art: `romPatch({op:'writeMany'})` to inject the new CHR/tile bytes

The tile codec handles 4 bit-layouts × 4 bit-depths. NES↔GB is byte-exact at 2bpp. Going up in bit depth (NES→SNES) gains palette headroom. Going down (Genesis→GB) requires color quantization that the codec does automatically.

### Lifting a CHARACTER (not a rectangular tile region) — use meta-sprite capture

`tiles({op:'png',source:'path'})` / `encodeArt({stage:'crop'})` / `importArt({from:'rom'})` work on **rectangular tile-grid regions**. That is the WRONG model for a real character, which is built from **multiple independent hardware sprites** (OAM/SAT entries), each with its own position, size, tile index, palette, flips, priority, and a non-contiguous tile range. Cropping a screenshot or a tile sheet looks right and then renders as garbage in-game because the hardware multi-cell tile order differs per platform (Genesis is column-major; SNES large OBJ + NES/GB 8×16 are their own orders). The meta-sprite tools handle all of it. Works on **genesis, snes, nes, gb, gbc, sms, gg** (C64 MOBs are 24×21 bitmaps, not tiles — not supported):

1. `loadMedia` → step / press to a frame where the character is fully on screen (NOT a menu — if no sprites are up, captures come back empty).
2. `sprites({op:'group', platform})` → clusters on-screen OAM/SAT entries into objects, largest-first (usually the player). Pick a group's `slots`.
3. `sprites({op:'capture', platform, slots:[...] /* or rect:{x,y,w,h} */, name:"enemy", emit:"both", outputDir:"..."})` → writes `tiles.bin`, `palette.bin`/`.json`, `layout.json`, `preview.png` (re-rendered from the EXPORTED data, not a screenshot crop), and a platform-idiomatic `<name>.h`. Hardware tile order is preserved per platform.
4. Inspect `preview.png`. Re-verify any time with `sprites({op:'render', tilesPath, layoutPath})` — no rebuild needed.
5. Include `<name>.h` (Genesis → SGDK `_draw()` helper; NES/GB → shadow-OAM cell table; SNES → oamSet pieces; SMS → SAT cells) — or get it later via `sprites({op:'emitC'})`. Build with `build({output:'run'})`.

This keeps the lifted asset faithful to the source ROM's hardware composition instead of the lossy crop-the-screenshot fallback.

## Visual vs programmatic inspection

You have two modes. Pick per task:

**Image mode** — `frame({op:'screenshot'})`, `tiles({op:'png'})`, `background({view:'map', render: true})`, `palette({source:'live'})`. Returns PNGs. Best for aesthetic judgment ("does this look right?", "did the explosion play?").

**Text mode** — `tiles({op:'pixels'})`, `tiles({op:'ascii'})`, `tiles({op:'fingerprints'})`, `memory({op:'read'})`. Returns structured data or ASCII art. Best for precise comparison ("is this tile blank?", "did $00F4 change between frame 60 and 90?", "find all tiles whose hash matches X").

Both work fine. Image mode is more flexible but burns more tokens per call. Use text mode for scans and diffs, image mode for "does this look like Mario?" questions.

## NES-specific (most common platform)

Patched fceumm exposes extra memory regions beyond the libretro standard:

| Region            | Contents                                       |
| ----------------- | ---------------------------------------------- |
| `system_ram`      | 2KB CPU RAM ($0000-$07FF)                      |
| `nes_chr`         | 8KB CHR (gathered from VPage[0..7]; R59 fixed an off-by-page-offset bug that returned zeros for offsets >= 4096 — if you see CHR uploads "fail" only above 4 KB, you're on a pre-R59 build) |
| `nes_nametables`  | 2KB CIRAM (background tile maps)               |
| `nes_palette`     | 32 bytes ($3F00-$3F1F)                         |
| `nes_oam`         | 256 bytes sprite list (64 sprites × 4 bytes)   |

OAM format: bytes per sprite are `[y, tileIndex, attributes, x]`.

`background({view:'map', render: true})` composites the active CHR + nametable + palette into a real 256×240 PNG — what the BG layer would look like even if rendering is currently disabled.

## Save-state semantics

`state({op:'save'}, name)` / `state({op:'load'}, name)` slots are **in-memory** and discarded on `host({op:'shutdown'})` or new media. To persist a state across sessions:
- `state({op:'save', path})` writes the CURRENT live host to a file directly.
- `state({op:'export', fromSlot, path})` copies an EXISTING in-memory slot (e.g. one the human saved with a playtest emulator-hotkey — it appears in `state({op:'list'})`) to a file **without disturbing the live host** (no pause/resume needed). Reload either with `state({op:'load', path})`.

`state({op:'load'})` removes any active cheats (a save-state blob doesn't carry frontend cheat state) and reports `cheatsCleared`. `host({op:'reset'})` resets the frame counter + core state (and clears cheats) but keeps the loaded ROM.

## Project scaffolding

Three shapes, pick the one that matches what you're doing:

- **`scaffold({op:'project', platform, name, path, template?})`** — writes a starter directory: `main.{c,asm,s}` (from `examples/<platform>/templates/`) + every runtime file the template depends on (headers, crt0, linker .cfg) + README + `.gitignore`. Self-contained: take it elsewhere and rebuild with stock cc65/sdcc, no romdev install needed. Defaults to `template:"default"` (smallest visible-and-runnable program); most tier-1 platforms also have `hello_sprite` + `tile_engine` + the 5 genre templates.

- **`scaffold({op:'project', ..., withSnippets: true})`** — same as above, **plus** drops every vetted starter snippet for the platform alongside main.c. Use when you want "main.c + every helper file ready to edit" in one shot, without picking a genre. Snippets that overlap with the template's runtime are skipped (no double-writes). Response includes `snippetsCopied: string[]`.

- **`scaffold({op:'game', platform, genre})`** — genre-shaped scaffold (`shmup` / `platformer` / `puzzle` / `sports` / `racing`). Higher-level than `scaffold({op:'project'})` — picks the right template + runtime + crt0 + linker config for the genre. Available on **NES, GB, GBC, SNES, Genesis, SMS, GG, C64, GBA, Lynx, Atari 7800** — i.e. every platform that has genre templates. Availability is derived from the registered templates (not a hardcoded list), so the error message for an unsupported platform always names the current set; Atari 2600 (asm-only) + MSX + ColecoVision (bring-up only) have no genre scaffolds and are rejected. Ships a complete working ROM with state machine + sprite allocation + sound wired — fill in gameplay logic on top. **Want a side-scroller? Use `genre:"platformer"`** — and on every platform EXCEPT NES the scaffold already side-scrolls: a hardware camera follows the player (SCX/$D016/R8/BG?HOFS/REG_BG?HOFS/bgSetScroll depending on platform), with software tile-column streaming where the world is wider than one nametable/plane. NES is still single-screen (platforms drawn as sprites); to make it scroll, draw platforms into the background nametables + `ppu_scroll(camX,0)` (it flips the PPUCTRL nametable-select bit past 256 px) + stream columns past 512 px. Each platformer's `describe` text gives the per-platform specifics; the scroll-register details live in the platform's MENTAL_MODEL.md "Horizontal scrolling" section.

Then iterate with `build({output:'run'})` against the source you read from `path/main.*`.

## Symbol-aware debugging — assert state headlessly instead of screenshotting ⭐

**The single biggest win for headless verification:** every "did the score go up / HP
drop / level change?" check is one byte of RAM. Build with debug, resolve the C global,
read it — no screenshot, no visual interpretation. Works on **every platform with a C
toolchain** (all 12 buildable ones):

```js
const b   = build({ output: "romWithDebug", platform, source, inline: true })
const sym = symbols({ op: "resolve", /* dbg or map: */ name: "score" })
memory({ op: "read", region, offset })  // the live value — 0 image tokens
```

`build({output:'romWithDebug'})` returns the right debug artifact for your platform; pass
whichever it gives you to `symbols`:

| Platform | debug artifact | pass to `symbols` |
|----------|---------------|-------------------|
| NES, C64, Atari7800, Lynx, PCE (cc65) | `.dbg` | `{ dbg }` |
| GB, GBC, SMS, GG, MSX (SDCC) | sdld `.map` (`mapText`) | `{ map }` |
| Genesis (m68k-elf) | GNU ld `.map` (`mapText`) | `{ map }` |
| GBA (arm-none-eabi) | GNU ld `.map` (`mapText`) | `{ map }` |

All five ops — `resolve` (name→addr), `lookup` (addr→sym), `list`, `map` (layout by
region), `addr` (live PC→enclosing C function) — work for **all** of these now (`map`
auto-detects sdld vs GNU ld). cc65 prepends `_` to C identifiers (`score`→`_score`);
`resolve` tries both spellings, and SDCC/GNU names come back without the underscore.

**Genesis (and GBA) specifics:**
- Genesis C globals live in the `$E0FF0000` work-RAM mirror. `resolve` hands you a
  `ramOffset` (the low 16 bits) **and** a ready `readHint` — read with
  `memory({op:'read', region:'system_ram', offset: ramOffset})`. (gpgx word-swaps WRAM,
  so a 16-bit value's two bytes are swapped at the offset — read bytes, or account for it.)
- `static` file-local globals resolve too (per-symbol sections). A non-`static` global
  that's never read can be DCE'd at -O2 — mark state vars you inspect `volatile`.
- PC→function: `symbols({op:'addr', pc, symbolsText: b.mapText})` names the routine a live
  `cpu({op:'read'}).pc` sits in.

When you don't know the symbol yet, `memory({op:'snapshot'})` → trigger the event →
`memory({op:'diff'})` shows exactly which bytes changed.

## Playtest mode (optional)

`playtest({ scale: 3 })` opens a real SDL window for a human to play the loaded ROM with a keyboard or USB controller. It **returns immediately** — the render loop runs in the background and you keep using every other tool against the same live host (so `build({output:'run'})`/`loadMedia` rebuilds update the window in place; it does not relaunch or crash on rebuild). Close it with `playtest({op:'stop'})` (or the human pressing ESC / Select+Start). Needs a desktop display *and* the optional `@kmamal/sdl` dep; with neither it returns `{opened:false, reason:...}` and the rest of the server keeps working headless. Use this when the human wants to feel the game, not when you want to test it (for your own checks, use `frame({op:'screenshot'})` — it reads the same live host the window shows). `playtest({op:'status'})` reports liveness + the window's media/frame; `playtest({op:'framebuffer'})` captures exactly what the human sees.

**Windows are PER SESSION.** The server is multi-session (several agents, or a user with 2-3 games open at once); each session gets its OWN window — opening one never disturbs another agent's, `playtest({op:'stop'})` closes only yours, and a session disconnecting tears down just its own window. **Aspect:** the window defaults to `aspect:"tv"` (the 4:3 / native-LCD shape the game was authored for) with nearest-neighbor scaling, so it looks like real hardware and stays crisp + correct aspect when the human resizes it; pass `aspect:"fb"` for raw square-pixel dev geometry.

## Common gotchas

- **CHR-RAM vs CHR-ROM**: Most NES homebrew uses CHR-RAM. CHR tools (`tiles({op:'pixels'})`, `tiles({op:'png'})`, `tiles({op:'fingerprints'})`, `tiles({op:'ascii'})`, `tiles({op:'png',source:'path'})`) all accept an optional `path` arg — pass it to read CHR from the iNES file (CHR-ROM carts), omit to read live CHR-RAM from the running emulator. Response always reports `source: "file" | "emulator"`. NES homebrew built with `linkerConfig:"chr-ram"` has no CHR in the file — must read from the emulator after upload.
- **Mapper-aware addressing**: NES NROM 16KB carts mirror PRG at $8000 and $C000 (`disasm({target:'rom'})` reports the canonical $C000+ addresses since that's where the reset vector points). Banked mappers (MMC1/MMC3/UxROM) have the top 16KB fixed at $C000 with bank 0 at $8000 by default — pass a startAddress in the right range to disassemble a different bank.
- **C64 isn't a console**: media is `.prg` / `.d64` / `.t64`, not "ROM". `loadMedia` takes a `mediaKind` arg; auto-defaults are usually right.
- **Atari 5200 build works but doesn't run**: cc65 produces .a52 files, but our atari800 core needs Asyncify which isn't yet wired into the host. Use Atari 7800 or Lynx if you want a 6502 platform that actually runs.
- **Genesis BG init**: a freshly-booted Genesis ROM shows a black screen for many frames because VDP init is slow. Step 60+ frames before screenshotting.
- **`framesRun` is monotonic**: `state({op:'load'})` restores the core but doesn't roll back our frame counter. Use it for state, not for "what frame am I on" precision.

## Before writing input or memory-layout code

Two tools that save real time and frustration:

- `input({op:'layout', platform})` — returns the platform's controller protocol, bit order, libretro id mapping, AND which buttons physically exist. Read this before writing an asm `read_pad` routine OR before designing controls (so you don't bind to a button the platform doesn't have).
- `symbols({op:'map', dbg, platform})` — after `build({output:'romWithDebug'})`, returns where every variable in your source actually landed in memory, grouped by region (zeropage / system RAM / code / data). cc65 reserves the first 2 zeropage bytes for its runtime; your first `.res 1` lands at `$02`, not `$00`. Don't guess.

## Cross-platform inputs

`input({op:'set'})` accepts an Xbox-shaped controller: D-pad, 4 face buttons (use `north/east/south/west` for portable code — they translate per platform), shoulders (`l/r`), triggers (`l2/r2`), sticks (`l3/r3`), plus `start`/`select`. Older platforms are subsets — `input({op:'layout'})` tells you which buttons are real. Pressing a non-existent button is a silent no-op.

⚠ **The raw libretro names `a`/`b`/`x`/`y` are NOT the platform's printed button labels — and on the three genesis_plus_gx platforms (Genesis, SMS, Game Gear) they're INVERTED.** Verified live across all 14 platforms:
- **Genesis**: gpgx maps Genesis A/B/C onto libretro **y/b/a** — so `input({op:'set', a:true})` presses Genesis **C**, and Genesis A (SGDK `BUTTON_A`) is `{y:true}` / `{west:true}`.
- **SMS / Game Gear**: button 1 (TL, main fire) is libretro **b**, button 2 (TR) is libretro **a** — so `{a:true}` presses button 2, not 1.
- **Every other core maps straight through** (`{a}`→A, `{b}`→B): NES, GB/GBC, SNES (incl. x/y/l/r), GBA, PC Engine (a=I, b=II), MSX (a=trig 1), Lynx (a=A). C64 + Atari 2600 are single-fire — fire is `{b}`/`{south}`, `{a}` is a no-op. Atari 7800 boots in 1-button mode (both fires read INPT4) until you enable 2-button mode.

**The safe habit: use the spatial names (`north/east/south/west`) or `input({op:'press', button:'a'|'b'|'c'|'1'|'2'})` — both resolve to the correct physical button per platform.** Reach for raw `a`/`b` only when you mean the literal libretro id. `input({op:'layout', platform}).faceButtons` is the authoritative per-platform map; each platform's MENTAL_MODEL has a "Driving input over MCP" note.

## Starter snippets

`scaffold({op:'snippets', platform})` (default `mode:'list'`) and `scaffold({op:'snippets', platform, mode:'get', name})` give you vetted boilerplate — reset routine, `read_pad`, OAM DMA, palette upload, nametable clear. Each snippet's comments encode foot-guns prior agent sessions already hit. Always check what's available for your platform before writing platform-specific boilerplate from scratch. NES, SNES, SMS, GG, GB/GBC, Genesis, GBA, C64, Atari 7800 all have substantial snippet libraries.

**Three ways to actually use them:**

- `scaffold({op:'snippets', platform, mode:'get', name})` — one snippet's contents, returned as a string.
- `scaffold({op:'snippets', platform, mode:'getAll', language?})` — every snippet joined into one string. Useful for **reading**; the giant blob lands in your context (or pass `outputPath` to write it to disk instead).
- **`scaffold({op:'copySnippets', platform, destinationDir, language?, include?})`** — writes every snippet (or a filtered subset) straight to disk. **Bytes never pass through your context.** Use this when you're scaffolding into a project dir. Flattens `lib/<lang>/foo.c` → `<destinationDir>/foo.c`. Optional `include: ["vdp_init", "joypad_read"]` whitelist for cherry-picking. Default `overwrite: true` (vetted boilerplate is meant to be regenerated).

Or skip the separate call entirely: `scaffold({op:'project', withSnippets: true})` does the same thing as a one-shot.

## Don't burn your own context with binary data

The biggest mistake agents make on this server is reading binary files into their own context just to forward them to a tool. Don't. Every tool that consumes large binary inputs accepts paths:

- `loadMedia({ platform, path })` instead of inlining `base64`
- `build({ output:'rom', sourcePath, binaryIncludePaths, includePaths, outputPath })` — paths in AND a path back out (`binaryPath`). Inline base64 only on opt-in `inline: true`. (Or `build({output:'project', path})` to build a whole dir without a manifest.)
- `encodeArt({ stage:'tilemap', platform, pngPath, outputDir })` — full-screen PNG → deduped tiles + tilemap + palette, input from disk, output to disk. **This is the tool for splash/title screens** (see the splash-screen section below). Supported: nes, snes, genesis, sms, gg, gb, gbc, c64.
- `frame({ op:'screenshot', path })` — writes PNG to disk, skips inline payload. For a quick "did it change?" sanity check, add `scale: 0.5` (nearest-neighbor, pixel-art-safe) — ~75% fewer image tokens; reserve full resolution for when you actually need pixel detail. **Cheaper still: `symbols({op:'resolve'})` → `memory({op:'read'})` reads the one byte of state with zero image tokens (see Symbol-aware debugging).**
- `tiles({ op:'png', source:'path', outputPath })` — render a ROM file's tiles to a PNG sheet
- `encodeArt({ stage:'tiles', platform, pngPath, outputDir })` — PNG → native tile bytes, input from disk. Pass `tileOrder:'sprite'` for COLUMN-major (Genesis/Lynx multi-cell hardware-sprite order) instead of the default row-major.
- `encodeAudio({ target:'brr', pcmPath, outputPath })` — SNES BRR (the SPC700's only sample format)
- `encodeAudio({ target:'xgm2pcm', wavPath, name, outputCPath })` — GENESIS sample SFX: WAV → XGM2 PCM (8-bit signed mono, 13.3 kHz / 6.65 half-rate, 256-padded) + a 256-aligned C array you `#include` and play with `XGM2_playPCM`. Bakes in the format rules so you don't botch sign/rate/alignment/padding.
- `encodeAudio({ target:'xgm2', vgmPath, name, outputCPath })` — **GENESIS MUSIC: a `.vgm`/`.vgz` → a COMPILED XGM2 blob** + a 256-aligned C array you `#include` and `XGM2_play()`. `XGM2_play()` needs a *compiled* blob (split FM/PSG streams + sample table), NOT raw VGM — this does that compile (a pure-JS port of SGDK's `xgm2tool`; no Java/jar). PSG-only tracks coexist with `xgm2pcm` SFX. `system:'ntsc'|'pal'` forces the timing flag.

When a tool has `path` and `base64` variants, prefer `path`. The server runs on the same machine; both sides share the filesystem. There's no reason to round-trip 50KB of base64 through your prompt.

## Art-first workflow (user does the pixel art, agent wires the ROM)

For users who'd rather paint sprites in LibreSprite than write tile bytes by hand, four asset-loader tools parse FOSS editor outputs directly into platform-native tile data — no `encodeArt({stage:'tiles'})` + ImageMagick chain, no installs beyond the editor itself.

- **`importArt({from:'aseprite', path, platform, outputDir})`** — parse `.ase` (LibreSprite, GPLv2 fork of Aseprite). Returns deduped `tile_bytes` + named `tiles[sliceName] = { tile_indices, width_tiles, height_tiles }` + `tags[name] = { from, to, delays_ms[] }` for animations. Indexed-mode .ase preserves the artist's palette; RGBA mode falls back to platform-master nearest-neighbour. The artist names their slices ("player_idle", "chalice") → game code references the same names. **The killer DX feature** for art-led projects.

- **`importArt({from:'tiled', path, platform, outputDir})`** — parse Tiled `.tmj` (BSD, the de facto FOSS level editor; export as JSON, not XML `.tmx`). Returns per-layer `data` blob + `empty_mask` bitfield (so "no tile" stays distinguishable from "tile 0") + `object_layers[name]` with named placements (player_start, doors, chests) and arbitrary key/value properties. **Multi-layer + object support** means the artist owns level design end-to-end, including spawn data.

- **`importArt({from:'gif', path, platform, outputDir, frame_indices?})`** — extract frames + delays from any GIF. Every editor exports GIF; this is the universal animation pipeline. omggif under the hood — no native deps. Caveat: doesn't apply GIF disposal, so export with `Disposal: Replace` for full-frame anims.

- **`importArt({from:'texturepacker', pngPath, manifestPath, platform, outputDir})`** — TexturePacker-style PNG+JSON. LibreSprite's `Export Sprite Sheet → JSON-Hash` writes this directly. Supports `meta.frameTags` for animation grouping.

**Palette interop:**

- `palette({source:'platformMaster', platform, format: "png" | "lospec" | "hex", outputPath?})` — `"png"` is the swatch sheet for `-remap` dithering (existing behavior). `"lospec"` returns `{name, author, colors:[hex_no_hash]}` for direct LibreSprite/lospec.com import. `"hex"` returns one `#RRGGBB` per line — universal interchange.

- `encodeArt({stage:'tiles'})` now validates the input PNG against the platform's master palette (PLTE for indexed PNGs, distinct-RGB scan for truecolor) with ±8/channel tolerance and surfaces colors-outside-gamut as `warnings[]`. Doesn't throw — silent color shift was the most common newbie failure; now it's loud.

**Workflow walkthrough** + canonical glue code: [`examples/art-first-workflow/README.md`](examples/art-first-workflow/README.md). Six-step path from picking a Lospec palette through `importArt({from:'aseprite'})` + `importArt({from:'tiled'})` to a working ROM.

For repeated builds in an iteration loop, this compounds: a 256KB SNES ROM in 20 build cycles = 7 MB of base64 text accumulated in your context. Paths cost ~60 bytes per call.

## Splash / title / full-screen background images — USE `encodeArt({stage:'tilemap'})`, do NOT hand-roll

If you want a full-screen picture (a splash screen, title card, cutscene still, status panel), there is exactly ONE correct path. **Do not write your own PNG→tile loop** — packing 4bpp/2bpp bitplanes, deduping tiles, assigning palette lines, and building the name-table entry words by hand is fiddly and the failure mode is ugly: the image comes out with the right *shapes* but wrong colors (everything one color) and vertical striping/choppiness. That means your tile bytes were raw RGB-ish values instead of palette indices, or the bit packing/row stride was off.

The correct workflow (all platforms with a tilemap — nes, snes, **genesis**, sms, gg, gb, gbc, c64):

1. **Size the source** to the platform's screen: Genesis **320×224**, NES/SNES/SMS 256×224/256×192, GB 160×144, C64 320×200.
2. **Quantize to the platform palette** so colors land on hardware-displayable values:
   ```
   palette({ source:'platformMaster', platform:"genesis", format:"png", outputPath:"/tmp/pal.png" })
   magick splash.png -dither FloydSteinberg -remap /tmp/pal.png splash_q.png
   ```
3. **Convert in one call:**
   ```
   encodeArt({ stage:'tilemap', platform:"genesis", pngPath:"splash_q.png", outputDir:"out/" })
   ```
   You get `out/chr.bin` (deduped tiles), `out/nametable.bin` (tilemap entries), `out/palette.bin`, and `out/preview.png`. **Look at `preview.png`** — it's the tool re-rendering its own output, so if the preview is correct your in-game result will be too. If the preview is wrong, the input PNG is the problem, not the encode.
4. **Wire it in:** DMA `chr.bin` to VRAM, load `palette.bin` into CRAM/CGRAM, write `nametable.bin` to your BG plane base. The response `note` tells you the exact sizes + where each blob goes per platform.

Genesis specifics: 4bpp tiles (32 B each), **40×28 cells**, up to **4 palette lines of 16 colors** — `encodeArt({stage:'tilemap'})` bin-packs your image's colors across the lines and picks the right line per 8×8 cell automatically. Name-table entries are 16-bit big-endian. Set your Plane A width to 64 cells. The response's `genesis.warnings[]` flags any 8×8 cell that needs >16 colors (the VDP's hard limit) — if you see those, the source art has too many colors crammed into one cell; re-author or accept the approximation.

If a platform genuinely lacks a tilemap (Atari 2600 races the beam; 7800 uses display lists) `encodeArt({stage:'tilemap'})` throws with an explanation — those need hand-authored per-scanline data, there is no automated path.

## Known toolchain landmines

A few platform-tool quirks worth knowing up front:

- **asar (SNES) silent fails** on certain idioms: `$ - label` size expressions crash with a heap-pointer exit code (use `end_label - start_label` instead). Some opcode + operand arithmetic like `STA SYMBOL + N` where SYMBOL is `=`-defined also crashes silently — our preflight catches the common cases. When `ok: false, issues: []`, the wrapper now synthesizes a fallback issue with a hint.
- **asar bank-border-crossed** can happen if your `org` + `dw` runs past $00FFFF. Native vectors are at $FFE4-$FFEE; emulation vectors at $FFF4-$FFFF. Use `scaffold({op:'snippets', platform: "snes", mode: "get", name: "lorom_header.asm"})` for the layout.
- **cc65 (NES, C64, etc.) zero page** starts at $02. cc65 reserves $00-$01 for its runtime. Your first `.res 1` lands at $02, not $00. Use `symbols({op:'map'})` after `build({output:'romWithDebug'})` to confirm.
- **NES pattern table cap = 256 tiles per nametable**. The tilemap index is 8-bit, so per-frame BG can use at most 256 unique tiles per pattern table. Auto-converting a busy illustration usually overflows. `encodeArt({stage:'tilemap'})` warns; the only workaround is mid-frame CHR bank switching (MMC3-class mapper).
- **NES + GB/GBC turnkey** (R9/R10 self-contained + sound, 2026-05-25): use `scaffold({op:'project', platform, template, name, path})` to scaffold a project. The pipeline copies every file the template depends on — `{nes,gb}_runtime.{h,c}`, `gb_hardware.h`, custom `crt0.s`, linker `.cfg`, `patch-header.js` (GB) — into the project directory alongside `main.c`. **No auto-injection at build time.** The build pipeline compiles exactly what you tell it via `sources` / `sourcesPaths` / `includes` / `includePaths` / `crt0` / `crt0Path` / `linkerConfig` / `codeLoc`. Take the project elsewhere with stock cc65/sdcc and it builds the same way. The runtime APIs include sprites, BG, input, AND **sound** — `sound_init` / `sound_play_tone(channel, period, vol, length)` / `sound_play_noise` / `sound_off`. NES drives pulse1+pulse2+triangle+noise via $4000-$400F + $4015; GB drives the 4-channel APU via NR10-NR52. SFX-grade, fire-and-forget — for full music tracks, drop in famitone2 (NES) or your own driver. Templates: `default` (palette cycle), `hello_sprite` (sprite + d-pad + **beep on A press**), `tile_engine` (multi-room tile map). Docs: [`src/platforms/nes/MENTAL_MODEL.md`](src/platforms/nes/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/nes/TROUBLESHOOTING.md); [`src/platforms/gb/MENTAL_MODEL.md`](src/platforms/gb/MENTAL_MODEL.md) + [`TROUBLESHOOTING.md`](src/platforms/gb/TROUBLESHOOTING.md). **Game-loop order matters on NES:** stage `oam_clear`+`oam_spr` BEFORE `ppu_wait_nmi`, not after — the NMI handler DMA's whatever shadow_oam contains at vblank-start. **GB ROM header:** both asm and C builds now auto-run `rgbfix` inside `build({output:'rom'})`, so the Nintendo logo + checksums + CGB flag are correct out of the box — no manual header-patch step needed (use `romPatch({op:'gbHeader'})` only to fix up an external ROM).
- **Game Boy / GBC silent-failure footguns** (R54 cleanup, full detail in `platform({op:'doc', platform:"gb"|"gbc", name:"mental_model"})`):
  - **The bundled `gb_crt0.s` is now actually linked.** Pre-r54 a fundamental bug in `buildZ80C` was shipping the raw .s text to sdld as if pre-assembled — sdld silently rejected it and fell back to SDCC's stock sm83 crt0 (no GB cart boot, no IRQ vectors). Map showed no `init` symbol, $0000 was $FF, $0100 was $FF. Every GB ROM ran on stock crt0 invisibly. Fixed by auto-detecting .s source vs .rel object and running it through sdasgb first. Post-fix: `init` at $0150, entry $0100 = `00 c3 50 01` (nop; jp $0150), reset vector $0000 = $C9. **This was the root cause for #14 audio AND part of why every previous "runtime should work OOTB" round still felt friction-heavy.**
  - **GB/GBC C builds now auto-fix the header at build time** (rgbfix runs inside `build({output:'rom'})`): Nintendo logo at $0104, header checksum at $014D, global checksum, and the CGB flag at $0143 ($00 for `.gb`, $C0 for `.gbc`). You no longer need to patch the header manually — the ROM `build({output:'rom'})` hands back boots on real hardware as-is. `romPatch({op:'gbHeader', path})` still exists if you want to override title / cart type / RAM size / etc. on an existing file.
  - **`shadow_oam` is pinned at $C100** in the bundled `gb_runtime.c` via `__at(0xC100)`. OAM DMA reads ONLY the high byte and copies 160 bytes from `$XX00` — a plain `uint8_t my_oam[160]` may land at $C017 and DMA garbage. If you roll your own OAM buffer, pick an address with `0x00` low byte (e.g. $C200) and pass it directly to `oam_dma_copy`.
  - **Call `enable_vblank_irq()` once at boot.** Without it, `wait_vblank()` busy-polls `LY` which updates only at WASM `frame({op:'step'})` quantum boundaries → game loop runs at ~1/30 intended speed on the emulator. After enable, `wait_vblank()` compiles to `HALT` + vblank IRQ wake (~10 cycles per frame).
  - **Use `memcpy_vram(dst, src, n)` for VRAM bulk writes**, NOT raw `(uint8_t*)0x8000` casts — SDCC sm83 may elide the latter as dead code. The bundled `gb_hardware.h` declares every $FFxx register as `volatile`-typed so direct writes like `BGP = 0xE4;` are fine; the hazard is only on cast-through-pointer block copies.
  - **`background({view:'map', platform:"gb"})` now renders a 256×256 PNG of the BG plane.** Pass `which: 1` for $9C00 map base, `window: true` to render the Window map instead. Returns `mapBase` + `mode` + `scy/scx` so you can see where the visible 160×144 region falls.
  - **`memory({op:'read', region:"video_ram"})` doesn't work on GB** — gambatte exposes VRAM as `gb_vram` (not the generic libretro id). r54 errors now suggest this directly. Also: `gb_oam`, `gb_io`, `gb_hram`, `gb_bgpdata`, `gb_objpdata`, `gb_cpu_regs`. `tiles({op:'png'})` / `background({view:'map'})` / `sprites({op:'inspect'})` abstract over this.
- **SMS / Game Gear VDP footguns** (R53 cleanup, full detail in `platform({op:'doc', platform:"gg"|"sms", name:"mental_model"})`):
  - **8 sprites per scanline** is a hard VDP limit. Extra sprites on the same Y row silently drop — symptom: "first 8 letters of CATCH THE COIN render, rest vanish." Split text across multiple Y rows OR draw it via the BG name table (no per-line limit).
  - **GG OAM coords are hardware-space, NOT visible-space.** The libretro screenshot returns the 160×144 visible region but OAM bytes are still 256×192 hw-coord. Visible region = OAM x∈[48,207], y∈[24,167]. `sprites({op:'inspect'})` reports hardware coords too.
  - **SAT $D0 is the renderer terminator.** R53 fixed `sms_sprite_init` / `gg_sprite_init` so they no longer fill Y with $D0 (they use $E0 now — off-screen but not the terminator). You only hit the trap if you write $D0 yourself; if sprites past a given slot are missing in `sprites({op:'inspect'})`, that's still the diagnosis.
  - **R6 = 0xFB → sprite tiles at $0000**, not $2000 (older comments lied — fixed). Bit 2 SET = $2000, CLEAR = $0000. Trust `sprites({op:'inspect'})`' `spriteTileDataBase` field over comments.
- **SNES CHR/tilemap can overlap in VRAM** if you put them carelessly. CHR starts at word $0000; if your CHR is 16KB the tilemap can't be at word $2000. Put tilemap at word $4000 or later when your CHR is big.
- **SNES audio is a separate ROM build** — the Sony SPC700 coprocessor handles all sound; the main 65816 can only upload a driver + samples then send commands. Workflow: write your SPC driver in `arch spc700` .asm, `build({output:'rom', platform:"spc700", source})` to flat raw bytes, then `.incbin` the result into your main 65816 .asm + write the $BBAA handshake at $2140-$2143 to upload it. `encodeAudio({target:'brr', pcmPath, outputPath})` encodes 16-bit PCM into the SNES BRR format the SPC needs. See `src/platforms/snes/lib/audio_pipeline.asm` for the protocol overview, and the SPC driver bundled into any SNES game project scaffolded with a sound genre.
- **All SDCC-built platforms (GB, GBC, SMS, GG, MSX, ColecoVision)** share a few SDCC-sm83 / -z80 quirks. The detailed reference is [`src/platforms/gb/lib/c/SDCC_GOTCHAS.md`](src/platforms/gb/lib/c/SDCC_GOTCHAS.md).
  **2026-05-25: The "for-loop + function-call crash family" (`dbuf_append_str NULL` assertion) is FIXED.** It was emscripten's default 64 KB stack overflowing the static `sm83_regs[]` table at runtime — not a SDCC codegen bug. Fixed by adding `-s STACK_SIZE=8388608` to `scripts/_lib.sh`. Patterns #1..#10 / #37 / #38 / #39 from previous agent notes all compile cleanly now. You don't need `unroll.h`, you don't need to split files into ≤200-line TUs, you don't need array-of-structs refactors. Write the natural code.
  **C89-only.** SDCC sm83 is C89. No inline `for (int i = 0; ...)`, no mid-block declarations, no compound literals. SDCC's syntax-error line is usually wrong (points at the FIRST decl after non-decl code); use the linter's line numbers instead.
  **Pre-flight linter:** `build({output:'rom'})` runs a syntax scan before invoking SDCC. C89 violations show up in `issues[]` with `stage: "lint"` and a `ref:` pointing at the right GOTCHAS section. Pass `lint:"strict"` to fail the build on any lint hit; default is advisory. **The linter reports EVERY mid-block decl in a block**, ordinal-tagged (`#2`, `#3` etc.) so a subtle earlier decl doesn't silence the obvious later one (R53 fix). If a flagged line doesn't look like a decl to you, double-check: typedef'd names ending in `_t`, plus `struct`/`union`/`enum` declarations, all count.
  **Multi-TU still helps iteration speed** (`sourcesPaths: {"main.c":..., "render.c":...}`): smaller TUs rebuild faster, easier to navigate. When a multi-TU build fails, the response includes `failedTU` + `compiledOK` so you know exactly which file to bisect.
  SMS/GG: `scaffold({op:'project', platform:"sms"|"gg"})` ships `sms_crt0.s` / `gg_crt0.s` into the project automatically — these crt0s give a proper cartridge reset vector + IM 1 + stack setup before calling `main()`. SDCC's stock z80 crt0 traps `rst $08` and any VDP-touching code hangs at PC=$0007, so the bundled crt0 is mandatory for real-hardware boot. GB/GBC: see the NES + GB/GBC self-contained-project bullet above.

## Session continuity — REUSE YOUR SESSION

**MCP sessions on romdev do NOT expire.** They are persistent for
the lifetime of the server process — which is hours/days, not minutes.
If you call `initialize` ONCE at conversation start, that same session
key works for every subsequent tool call all session long.

**DO NOT** call `initialize` again "just to be safe," "because the
session might have timed out," or "because it's been a few minutes."
None of those things happen here. Every tool is already registered at
session init (no loading step), but creating a fresh session breaks the
per-session emulator state (loaded ROM, save states, scroll position,
etc. live PER session) — you'd have to re-`loadMedia` and lose your place.

You ONLY need to re-initialize in TWO cases:

1. **Server restart.** You'll see HTTP 404 with "unknown session id"
   on your next tool call. Send `initialize` once — every tool re-registers automatically (no category reload). You can confirm a restart by checking
   the server's process lifetime — but really, just react to the 404
   when it happens; don't preemptively reconnect.

2. **`Mcp-Session-Id` header missing from your tool call.** If
   somehow your client lost the session ID, you'll get an explicit
   error pointing you at re-initialize. The header is sticky in
   normal MCP client usage; you won't lose it without something going
   wrong on the client side.

**Known historical friction (acknowledged 2026-05-25, since fixed):**
real-world agents previously reported losing connections ~30% of long
sessions. Server-side persistence is stable now. If you DO observe a
session drop without a server restart, open an issue at
https://github.com/monteslu/romdev/issues with the timing — it's a
regression we want to catch.

**Anti-pattern to AVOID:** opening a new session before every "block"
of work. This is almost always wrong, loses your per-session emulator state, and bloats the server's session table. One session per
conversation, end of story.

## When in doubt

`platform({op:'list'})` for capabilities. `catalog({op:'status'})` for what's currently loaded. `platform({op:'toolchains'})` for build tools. `state({op:'list'})` for save slots. Tools are introspectable; you don't have to remember the matrix.
