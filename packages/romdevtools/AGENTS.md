# romdev — Agent guide

This is romdev's GENERIC orientation — read it once. The platform-specific detail (memory maps, footguns, debug tooling) lives in each platform's docs, which you fetch on demand with `platform({op:'doc'})` as you work; this doc tells you when.

## What this server does

Drives the full homebrew ROM dev loop for 18 retro game platforms (NES, SNES, Game Boy, Game Boy Color, Game Boy Advance, Genesis, Sega Master System, Game Gear, Atari 2600/7800, Atari Lynx, Commodore 64, PC Engine / TurboGrafx-16, and MSX / MSX2, plus the open-hardware GameTank — and the 3D consoles Nintendo 64, Sony PlayStation, and Sega Dreamcast) — plus the **PICO-8** fantasy console (via FAKE-08: a Lua VM, so its own tier — `build` PACKAGES a `.p8` from Lua, `disasm({target:'source'})` reads the cart's Lua instead of machine code, `memory({region:'system_ram'})` reads its 64 KB; cpuState/decompile/tile-inspectors are N/A). Build → run → screenshot → inspect → patch → iterate. Also a strong reverse-engineering kit: disassemble existing ROMs into byte-exact rebuildable projects (`disasm({target:'project'})`/`disasm({target:'references'})` — the workhorse for any structural hack), find a value's address with the Cheat-Engine search loop (`memory({op:'search'})`/`memory({op:'searchNext'})`), find the EXACT instruction that wrote a RAM byte (`breakpoint({on:'write'})`, a core-level write watchpoint), confirm a patch is live in the running image (`memory({op:'readCart'})`; add `findHex` to scan the whole cart for a byte pattern with every hit mapped to a CPU address — call-site hunts in one call), bound every instruction that can REACH a RAM byte including near-base indexed forms (`disasm({target:'accessScan'})` — the 'who can write this?' scan, classified read/write/rmw; on a banked cart pass **`banks:[…]`/`excludeBanks:[…]`** to scan only the CODE banks — a DATA bank decodes as fiction that still boundary-verifies, and on 6502 a zero-page target hits constantly inside tile data, so an unfiltered scan can be hundreds of junk sites. The result always carries a **`perBank`** density rollup so you can tell which banks to distrust without reading their rows, and rows are capped **per bank** (`maxSitesPerBank`, default 32) so a flooded bank can't consume the whole budget and truncate away the real hits from the code banks), decode in-game script interpreters from a declarative grammar (`disasm({target:'script'})` — level scripts/spawn lists as structured records, reproducible in the call), tell whether a "found table" is really ASCII (`memory({op:'classify'})`), trace where an on-screen graphic comes from (`watch({on:'copy'})` on the 15 classic platforms — writer PC per VRAM write; `watch({on:'dma'})` for Genesis DMA sources), drive menus by screen-change (`navigate`), and look up cheats (`cheats({op:'lookup'})`/`cheats({op:'search'})`: a free, crowd-sourced labeled RAM/code map for known ROMs), apply + create cheats, convert assets, study patterns from real games. **Doing a romhack? Start with `platform({op:'doc', platform:'romhacking', name:'playbook'})`** — the decision tree that wires all of the above together. Bundled WASM toolchains and emulator cores — no system dependencies, no installs.

You drive the work. The human is a director — they may want a game, a ROM disassembly, a tool-assisted reverse-engineering session, or anything else this server can do.

## The one hard rule: NEVER install a compiler or emulator. romdev bundles every one.

Internalize this above all else: **you never need — and must never install — a compiler or an emulator to build or run a ROM here.** Every compiler/assembler/linker (cc65, sdcc, gcc, tcc, wla, rgbds, vasm, m68k-gcc, arm-none-eabi-gcc, …), every devkit/SDK (SGDK, PVSnesLib, libtonc/libgba, cc65 libs, …), and every emulator core (fceumm, snes9x, gpgx, gambatte, mGBA, handy, vice, prosystem, stella, …) is **already bundled as WASM** and runs in-process through these MCP tools. The whole build → link → run → inspect loop is `build({output:'rom'})` / `build({output:'run'})` / `build({output:'project'})` / `loadMedia` / `frame({op:'screenshot'})` / `inspect*` / `playtest` — never a host `gcc` or a downloaded toolchain.

**So if a build toolchain or emulator is ever invoked or prompts to install — `clang`, `gcc`, Xcode / macOS Command Line Tools, `node-gyp`, devkitPro, `brew/apt install <compiler>` — that is a DEFECT, not your cue to proceed.** Stop, do NOT install it, do NOT investigate it with host-side diagnostic commands (that just alarms the user), and surface it: "romdev should provide this — a host compiler/emulator should never be needed." Then find the romdev tool or report the gap. `platform({op:'list'})` / `platform({op:'toolchains'})` show what's bundled.

### Host content tools (art / audio / map editors) are totally fine

This rule is about **compilers and emulators only** — NOT about content tools. ImageMagick, GIMP, Aseprite/LibreSprite, Audacity, Tiled, a tracker (FamiStudio/Deflemask), Python for a quick art script — all fine to use, and fine for the user to install. They produce **raw source art/audio** (a PNG, a sprite sheet, a `.wav`, a `.tmx`); romdev then **imports and packs** that into platform-native data. Use them freely when they help; just don't reach for a *compiler or emulator*.

## The second rule: READ YOUR TARGET PLATFORM'S DOCS BEFORE YOU WRITE CODE FOR IT

This doc is deliberately GENERIC — it can't hold 18 platforms' worth of detail without bloating every session. The knowledge that actually saves you — the memory map, the input/control quirks, the render-enable order, the codegen traps, the SDK's footguns — lives in each platform's docs, read on demand:

- **`platform({op:'doc', platform, name:'mental_model'})`** — read this for EVERY system you're about to build or RE on, BEFORE you write code. It's a couple hundred tokens and most "why won't this work" dead-ends are a documented footgun you'd have seen there (a C64 game that needs a keyboard key to start; an SDCC WRAM-layout trap; a platform's render-enable order; gambatte exposing `gb_vram` not `video_ram`).
- **`platform({op:'doc', platform, name:'troubleshooting'})`** — the symptom→fix list; read it the moment something's broken.
- **`platform({op:'doc', platform:'romhacking', name:'playbook'})`** — read FIRST if you're doing a romhack/RE (the cross-platform decision tree).

Skipping this is the #1 avoidable time-sink. If you find yourself flailing on platform behavior and you haven't read that platform's `mental_model`, stop and read it — the answer is almost always there.

### romdev also packs assets in-server — reach for these first

Asset conversion is bundled too, so you often don't need the host tools at all. First-class tools: `encodeArt({stage:'tiles'})`, `encodeArt({stage:'tilemap'})`, `encodeArt({stage:'quantize'})`, `palette({source:'platformMaster'})`, `palette({source:'lospec'})`, `encodeArt({stage:'validate'})`, the loaders `importArt({from:'texturepacker'})` / `importArt({from:'aseprite'})` / `importArt({from:'gif'})` / `importArt({from:'tiled'})`, and helpers like `sprites({op:'capture'})` / `importArt({from:'rom'})`. The canonical quantize→tile→pack path lives here. Typical flow: paint pixels in a host editor (or generate a PNG), then `encodeArt({stage:'quantize'})` → `encodeArt({stage:'tiles'})` to get platform-native tiles. (You can do the whole thing in-server too when the art is procedural.)

### Native-addon prompts are a packaging bug — never compile on the host

A couple of optional features load a native Node addon (most notably the `playtest` SDL window, via `@kmamal/sdl`). These ship **prebuilt** — they must never compile on your machine. If you see a `clang` / Xcode / Command Line Tools / `node-gyp` build kick off while using romdev, the prebuilt binary is missing or mismatched: **do not let it compile, do not install a toolchain — report it.** `playtest` itself self-heals by downloading its prebuilt binary and, if it can't, fails with a `reason:"sdl-binary-missing"` tool error whose message carries the exact one-line `fixCommand` — it never needs a host compiler.

## If a human is watching, open playtest early

If a human is sitting next to you during this session — and that's most sessions in practice — open the playtest window as soon as your first build succeeds. `playtest()` opens a native SDL window that runs your ROM live and accepts USB gamepads (hot-plugged controllers are picked up automatically). It returns **immediately** — the render loop runs in the background, so you keep calling other tools while the human plays. Every other MCP tool keeps working against that same running ROM, and **`build({output:'run'})`/`loadMedia` rebuilds update the window in place** — the window follows your latest build, no relaunch and no crash on rebuild. A human sitting next to you should be **playing the game** while you iterate, not watching screenshots scroll past.

**Co-driving is detected for you.** While the human is actively pressing (pad or keyboard), the window's input wins over yours and its real-time loop races your frame-stepping — and you'll KNOW: `frame`/`input` responses carry a `humanCoDriveWarning` while they pressed within the last ~2s, and `catalog({op:'status'})` / `playtest({op:'status'})` expose `humanInputActive`. When the human is idle the window leaves your `input({op:'set'})` alone. For deterministic stepping while they play, either `host({op:'pause'})` (the window keeps rendering, frozen) or use a SECOND session (a different `x-romdev-session` header = a fully isolated emulator).

```
playtest()                       // opens the SDL window (returns immediately). op:'open' is the default;
                                 // playtest({op:'stop'|'status'|'framebuffer'}) close / check / capture-what-the-human-sees
                                 // playtest({op:'fps', show?}) show/hide the on-screen fps counter (or open with fpsOverlay:true)
```

After that, keep iterating with `build({output:'run'})` / `build({output:'rom'})` / memory({op:'read'}) / frame({op:'screenshot'}) exactly as before — they all act on the live emulator the user is playing. Because the window and `frame({op:'screenshot'})` read the **same** live host, what you capture is what the human sees. (If you ever need to be explicit — e.g. to double-check the human's exact frame — `playtest({op:'framebuffer'})` captures the window's framebuffer directly, with `source`/`loadedMediaPath`/`frameCount` metadata.)

**No gamepad?** `playtest()`'s response includes a `keyboardControls` map and a `tellUser` note when no controller is detected — relay the keys to the human (arrows = D-pad, Z = main action, Enter = START, ESC closes) so they know how to play.

**The mouse works on pointer carts.** For a wasmcart cart that declares FLAG_POINTER (menus, card games, touch-first games), the window forwards real mouse moves/clicks into the cart's pointer slot 0, mapped through the same letterbox the frame is drawn with — so the human can just click, including after resizing the window. Pad-only carts never see mouse movement.

**"It feels slow" is a number, not a vibe.** The window's title bar always shows live fps (`<game> | 58 fps`, the rate actually achieved). `playtest({op:'status'})` returns `perf` — rolling `fps` (60 = full speed) and `tickHz`, plus per-stage costs (`stepMs` emulation, `convertMs` framebuffer→RGBA, `presentMs` SDL blit, `audioQueuedMs` queue depth) — so YOU can say where the time goes. When the HUMAN should see the number on screen, `playtest({op:'fps', show:true})` draws a corner counter into the frame (they can also toggle it with F3).

Skip playtest only when there's clearly no human in the loop: CI runs, automated test suites, batch reverse-engineering, or when the user has explicitly said "headless." `playtest()` needs a desktop session to draw into; if it can't open a window the call FAILS as a tool error (never a success-shaped `opened:false`) and the message tells you exactly how to fix it. Three distinct cases: `reason:"sdl-binary-missing"` means the `@kmamal/sdl` native binary isn't installed (the server tries to self-heal, but if it can't, the message gives a `fixCommand` to run + restart) — a one-time native-addon fix, NOT a display problem. `reason:"no-display"` means SDL came up on the offscreen/dummy driver — no physical screen (headless/SSH; run the server in a terminal inside the desktop session). `reason:"sdl-error"` quotes whatever SDL actually threw — READ the quoted error; the message only suggests the desktop-session fix when the error really names a display/driver problem, otherwise treat the quoted error itself as the fault to report. Either way, every other tool (build, run, screenshot, inspect) is fully headless and unaffected. When in doubt, ask once, then default to opening it.

## Tool surface: everything is loaded — just call the tool

**All ~32 tools are registered and callable from session init — there is no loading step.** If you see a tool name anywhere in this doc or via `catalog({op:'categories'})`, you can call it right now. Each tool is a small VERB with an operation axis — `memory({op})`, `build({output})`, `sprites({op})`, `breakpoint({on})`, `cpu({op})` — so the whole surface is a few dozen names, not a few hundred.

(We used to lazy-load tools behind a `loadCategory` call. It caused more harm than good — agents burned round-trips re-loading categories, and dynamic registration never propagated reliably to clients anyway. The consolidation shrank the surface enough that the entire thing loads up front; the old `loadCategory`/`describeTool` discovery tools are gone.)

`catalog({op:'categories'})` still exists as a **map of what's available, grouped by purpose** — useful for discovery, not a gate:

- `platforms` — which platforms + languages are supported
- `run` — load ROMs, step frames, screenshot — `crop:{x,y,w,h}` returns a native-res strip (HUD counters legible at a fraction of the image tokens) — (works for existing ROMs you didn't compile)
- `input` — drive controllers, look up hardware bit layouts. `input({op:'set', ports})` is POSITIONAL: `ports[N]` IS port N (there is no `port` key), and each button is its own boolean (`{a:true, b:true}`, never `{buttons:['a','b']}`). A malformed port object is REJECTED rather than partially applied — a press that silently doesn't happen turns into a false NEGATIVE about the game, which is the most expensive wrong answer this tool can give. `navigate` walks menus by advancing on SCREEN CHANGE (not fixed frames) and reports whether each press was consumed — the fast, reliable way to script a UI. **`input({op:'pointer', x, y, left?, right?, id?, active?})`** is absolute mouse/touch for wasmcart carts that declare FLAG_POINTER: `id` selects the pointer SLOT (0 = mouse, the default; 1-9 = touch fingers — several slots at once is a multi-finger gesture), and `active:false` releases a slot the way a real host does on touchend. Use `id:1+` to test the commonest cart-side portability trap: a cart that polls only pointer[0] works perfectly with a desktop mouse and silently ignores every touch on a phone.
- `state` — savestates and forensic state inspection (`state({op:'save'})`, `state({op:'load'})`, `state({op:'export'})` a slot to disk without touching the live host, `state({op:'list'})`, `state({op:'dump'})`). A restore always CLEARS active cheats — pass **`reapplyCheats:true`** to `state({op:'load'})` and they are snapshotted before the load and re-armed after (`cheatsReapplied[]`), because reading `cheatsCleared:N` does not stop you forgetting to re-arm three calls later. `state({op:'save', path})` records any active cheats in a `<path>.cheats.json` **sidecar** so a rig shared between sessions describes its own requirements instead of relying on prose; the `.state` bytes are unchanged, so existing states keep loading. **`state({op:'autoSnapshot', enabled:true, intervalSeconds:60})`** arms an opt-in periodic background save so an unprompted SERVER RESTART costs a minute instead of the session — captures happen lazily on calls that already touch the host (no timer, nothing while idle), land in a session-scoped temp dir that can never clobber a named slot, and can never fail the call they were protecting. **`state({op:'recoverSnapshot'})`** restores the newest one after a restart.
- `memory` — read/write VRAM/OAM/CGRAM/ARAM and other regions (all 18 platforms). `memory({op:'read'})` takes `offsets:[…]` to batch scattered reads in one call. **`memory({op:'search'})`/`memory({op:'searchNext'})`** = the Cheat-Engine value-search loop ("find the address of X, narrow as X changes") — relative compares (`inc`/`dec`/`changed`) work as the FIRST narrow (baselines recorded at seed), and `as:'bcd'`/`as:'digits'` search packed-BCD scores and digit-per-byte HUD buffers (any constant tile base) when stored ≠ displayed. **`memory({op:'searchUnknown'})`** is the unknown-initial-value hunt — seed the whole region with no value, then narrow by `dec`/`inc`/`changed` across events (the value you can't read off the HUD). **`memory({op:'readCart'})`** reads the loaded cart image to confirm a patch is live (pass `{cpuAddress, bank}` to read a banked CPU address on NES/SNES). **`memory({op:'classify'})`** says whether bytes look like ASCII/code/tile-data (kills the "found table that's really a string" trap). `memory({op:'snapshot'})` + `memory({op:'diff'})` answer "which bytes changed across this event?" (diff defaults to a clustered summary with stride detection; small clusters carry before/after hex, `minDelta` filters churn, and predicate filters — `changeDir:'inc'|'dec'`, `deltaEq`, `beforeMin/Max`, `afterMin/Max` — keep only the bytes that moved the way you expect; `outputPath`+`echo:false` route the full list to disk); **`memory({op:'diffRuns', portsA, portsB?})`** answers "which byte does this INPUT drive?" in one call (same start state run twice under two inputs, only the divergent bytes return); `state({op:'diff'})` is the coarse whole-machine version. Reads routed to disk take `echo:false` to skip the inline hex.
- `debug` — **`frame({op:'verify'})`** (NO-VISION render-health: one call answers "is the game actually rendering / alive?" on all 15 classic platforms AND the native runtimes (wasmcart/jsgame — pixel scan only, GL carts scanned via the offscreen-GL readback, `render.renderEnabled:null`) — fuses a framebuffer pixel scan with the per-platform render-enable/NMI decode; `{verified:true|false|null, issues[], pixels, render}`, frame-0-guarded so it never cries wolf on boot), `sprites({op:'inspect'})`, `palette({source:'live'})`, `cpu({op:'read'})` (all 18), `audioDebug({op:'inspect'})` (the 13 systems with a sound chip — all but Atari 2600/7800; incl. GameTank's ACP coprocessor via `chip:'acp'`; pass `frames:N` to TRACE a per-channel note-timeline for headless melody asserts), `background({view:'renderState'})`, `breakpoint({on:'write'})` (write watchpoint, all 18; EVERY hit on EVERY platform carries `registersAtHit` — the register file frozen at the hit instant, the only honest read since live regs drift after a hit — and the CPU stays frozen until the hit is cleared), **`watch({on:'dma', precision:'sampled'})`** (Genesis: which ROM offset a VRAM graphic was DMA'd from), **`watch({on:'copy'})`** (the 15 classic platforms: every write landing in a VRAM window logged with the EXECUTING instruction's PC — the generic 'which routine uploads this graphic?'; port-based video memory hooked in-core incl. the SNES DMA path, CPU-mapped VRAM via the range log), **`disasm({target:'bytes'|'rom'|'references'|'project'|'sourceLookup'})`** (`bytes`/`rom`/`references` on all 18, `project` byte-exact reassembly on the 15 classic platforms (incl. GameTank, cc65/6502) — native binutils objdump per CPU, incl. GBA ARM7/Thumb; the byte-exact `disasm({target:'project'})` reassembles through native as/ld/objcopy; banked carts — NES mappers, SNES LoROM, GB MBC, Sega mapper, MSX megaROM, 2600 F8/F6/F4, 7800 SuperGame, >32KB HuCards — are split and reference-scanned PER BANK, refs tagged `prgBank`/`romBank`; `sourceLookup` returns YOUR annotated project source lines for an address range, matched on the emitted address comment — the annotation session's most-repeated nav op; `disasm({target:'source', projectDir, startAddress})` routes here too, so either spelling works, and it matches only a line's OWN address annotation so a data table whose bytes read like the address isn't a false hit), plus the **Rizin/Ghidra RE engine** `disasm({target:'cfg'|'xrefs'|'functions'|'decompile'|'resolveJumptable'})` (ALL 18, incl. the 3D consoles' MIPS R3000/R4300 + SH-4 — control-flow graphs, deep xrefs, auto-detected functions [sorted real-code-first, `looksLikeData` flagged], and Ghidra C pseudocode; quality excellent on GBA/Genesis, rough on 6502; decompile output NAMES hardware registers [`PPUMASK` not `*0x2001`] and on the 6502 family folds SLEIGH clutter to readable C99 [`uint8_t`, `zp_FD`]; `resolveJumptable` resolves computed dispatchers live via `breakpoint({on:'jumptable'})`) + `symbols({op:'analyze'})` (one-shot structural map — pass **`summary:true`** for counts + entrypoints + top functions [~2.5K chars vs the full ~44K table on a 1MB ROM], or **`topN`** to bound the list), `symbols({op})` lookup, `background({view:'rendered'})`, plus **`cheats({op})`** (`cheats({op:'lookup'})` = a free labeled RAM/code map for known ROMs, `cheats({op:'search'})` to fuzzy-find a game by name, `cheats({op:'apply'})`/`cheats({op:'clear'})` non-destructively, `cheats({op:'make'})` to create codes)
- `assets` — convert PNGs to tiles (`encodeArt`/`importArt`), WAVs to BRR, identify ROMs (`cart({op:'identify'})`), plus the hacking toolkit (`romPatch({op})` — write/writeMany/spliceCHR/relocate/makeStored/findFree/findPointer/diff, `assembleSnippet`, `cart({op:'extract'})`, `cart({op:'wrap'})`)
- `project` — the example-game library (`examples`: list / fork / show, plus the legacy snippet ops)
- `show` — `playtest({op})`: `op:'open'` opens the live SDL window for a human, `op:'stop'` closes it, `op:'status'` reports liveness, `op:'framebuffer'` captures exactly what the human's window shows
- `advanced` — `runUntil`, **`watch({on:'mem'|'range'|'pc'})`** (LOG-ALL tracing; for a MULTI-BYTE variable — 16/32-bit distance, score, pointer, timer — set **`as:'u16le'`** (or u16be/u24/u32) on the range: without it the range is diffed per BYTE and a value whose high byte holds steady reports as its low byte alone under the range's label ($05F0 reads as 240, not 1520), while un-annotated multi-byte ranges now carry `byteIndex`/`byteLabel` and a `constantBytes[]` roll for the bytes that never moved. A watch armed while the CPU sits at an un-cleared breakpoint hit misses everything already executed in that frame, so the result carries `armedWhileHalted` — an empty window then isn't a clean negative; `range`/`pc` take **`fromState`**/`fromStatePath` to trace from a restored savestate moment), **`breakpoint({on:'write'})`** (the EXACT instruction that wrote a byte, via a core watchpoint — fixes the frame-sampled-PC problem; runs to END OF FRAME and reports the LAST matching write with `hits`=count; `condition:'increase'|'decrease'|'equals'`+`conditionValue` filters to the MEANINGFUL write — the score going UP, not the per-frame restore churn (core-level on all 18, `oldValueByte` reported); `conditionWidth:16` watches a WORD in the platform's byte order (BE on Genesis) — 'equals' arms the word's high byte, inc/dec compare the word so a carry can't lie; RAM-mirror aliases (SNES $7E low mirror, NES $0800+, GB echo, SMS/GG, Genesis $E0-$FE) are canonicalized at arm time (`armedAddress` echoed); `precision:'sampled'` is the cheap frame-PC version; on a `pressDuring` run pass **`abortIf:[{region,offset,label}]`** to stop early if the driven scenario derails — a guard byte changing returns `{aborted, abortedBy, before, after}` instead of burning all `maxFrames` on a meaningless `found:false`), **`breakpoint({on:'pc'})`** (execution breakpoint — freeze the CPU AT an instruction and read its registers; on a MISS it reports **`mainThreadPc`** — the busiest PC over ~a frame of single-stepping, i.e. the main loop, not the frame-boundary NMI/idle `pcNow` — plus a `pcHistogram`, save-state-wrapped so it has no side effects), **`breakpoint({on:'read'})`** (the EXACT instruction that read a byte), **`breakpoint({on:'jumptable'})`** (RESOLVE a computed-jump dispatcher static analysis can't follow — `JMP (table,X)` / RTS-trick state machines, script/battle VMs: break at the dispatcher, single-step through the indirect transfer, record the COMPUTED targets live across frames/inputs; the varying arms are isolated from fixed trampolines; `disasm({target:'resolveJumptable'})` points here. No static-only tool can do this — it needs the live emulator), **`frame({op:'stepInstruction'})`** (CPU single-step) — all 18 platforms; input recording

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
   cheats don't cover: `disasm({target:'project'})` for a rebuildable project
   (then edit a region `.asm` and `build({output:'reassemble', platform, path})` to
   rebuild a byte-identical ROM in one call — the "cmp before commit" gate; a
   `.gitignore` is written so the kept `original.rom` can't be committed. **Large
   ROM (≥512KB, e.g. a 1MB SNES/Genesis cart)? Pass `background:true`** and poll
   `disasm({target:'project', job, outputDir})` — the reassemble can take minutes
   and would otherwise time the call out. A uniform-fill/padding bank reports
   `fill:true` + `readablePercent:null`, so "low % = data bank" isn't fooled by a
   $FF pad tail),
   `disasm({target:'references'})` for "what touches this address", `breakpoint({on:'write'})` for the exact
   instruction that wrote a byte, `watch({on:'mem'})`/`breakpoint({on:'write',precision:'sampled'})` to find an address
   empirically. For STRUCTURE — "what are the functions, how do they call each
   other, what's the control flow" — use the Rizin analysis ops: `symbols({op:'analyze'})`
   for a one-shot map (functions + entrypoints), `disasm({target:'functions'})` for the
   auto-detected function list, `disasm({target:'cfg', address})` for a function's basic-block
   graph, `disasm({target:'xrefs', address})` for every cross-reference TO an address (deeper
   than the da65 `references` scan — it follows the analysis graph). For C-like PSEUDOCODE,
   `disasm({target:'decompile', address})` runs Ghidra's decompiler (carries the decompiler's
   own WARNINGs; quality excellent on GBA/Genesis, good on GB/Z80, rough on 6502). All
   Rizin/Ghidra analysis ops cover 18/18 platforms (incl. the 3D consoles' MIPS/SH-4). For a no-cheats game or a
   logic/text/graphics change, this is where the real work is — start here, don't wait on a
   cheat lookup.
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

**On images specifically:** the `inline:true` image is only useful if YOUR client actually delivers inline images to you — some clients silently drop or down-convert image content. If you're not certain you can see them, **work from the structured data instead**: start with **`frame({op:'verify'})`** — one call tells you `{verified:true|false|null}` whether the game is actually rendering (fuses a pixel scan with the render-enable registers), so you don't sit staring at a black frame wondering if it's broken or just blank. Then `sprites({op:'inspect'})` / `palette({source:'live'})` / `background({view:'renderState'})` always return their decoded JSON (sprite lists, palette entries, render flags) regardless of inline/path, and `frame({op:'screenshot', format:'ascii'})` gives a text render. The inline PNG is an opt-in luxury, not the primary signal.

## Trust hierarchy — where to find ground truth (R58 + R58b)

Two parallel paths depending on what you need:

### Path A — Fork a working example game (the dumb-model-friendly path)

Most agent sessions start here. You want a working ROM, not a
research project. **Never start from a blank file — fork the example
whose CORE LOOP is nearest your game (even for a very different game),
then modify one thing at a time, re-running `build({output:'run'})`
after each change.** Retro bring-up is a long chain of fragile
hardware init with zero partial credit; a working game is a
regression oracle.

1. **`examples({op:'list', platform?})`** — the mechanics map of the
   complete working example games (kind `game` vs minimal `reference`).
   Pick the one whose core loop is nearest your game.
2. **`examples({op:'fork', example:"<platform>/<name>", name, path})`** —
   copies that example into a NEW project dir as YOUR game (sources +
   every runtime file + crt0 + linker cfg + vendored library source +
   README + .gitignore), renamed throughout. It builds and runs before
   you change a line. The response lists only the files you EDIT
   (`files`) + a `vendorFileCount`; pass `verbose:true` for the full manifest.
   Build the whole dir in one call with `build({output:'project', path,
   outputPath})` (toolchain/crt0/linker inferred — no manifest); the bundled
   examples ARE the reference implementation.
3. **`examples({op:'show', example, file?, technique?})`** — read a
   DONOR example without forking it; `technique` extracts one marked
   HARDWARE IDIOM block (with its dependency header) to graft into
   your game instead of rewriting it.
4. **`examples({op:'snippets', platform, mode})`** (mode `list`/`get`/`getAll`)
   / **`examples({op:'copySnippets', platform, destinationDir})`** — fetch
   vetted helper files (reset routine, read_pad, OAM DMA, palette
   upload, etc.) as one-off references.
   `examples({op:'copySnippets'})` writes the files to disk in one call
   without round-tripping bytes through your context — preferred
   when you're copying into a project dir.

Reminder (it's the second rule up top): **read your platform's
`platform({op:'doc', platform, name:'mental_model'})` BEFORE you write code for
it** — that's where the footguns that would otherwise burn your session live.

For most workflows, path A is all you need. **When a tool call FAILS, read the
error message and `issues[]` first — see "When a call fails" below; the error
usually names the fix.** File a feedback round if the bundled examples are wrong.

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
   copied into every project at fork time). The FULL source of
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
`examples({op:'copySnippets'})` to pull it in). Now it lands automatically
when you `examples({op:'fork'})`. Round 30/31 Lynx wedges took 5 friction
rounds partly because cc65's TGI driver source wasn't visible;
post-R58b you can `grep -rn bar_c vendor/cc65/libsrc/lynx/` from
inside your project directory and read the actual blitter code.

**Practical rule for path B:** if you find yourself filing a
feedback round without first `grep`ping `vendor/` for the symbol
you're debugging, you're skipping the cheap diagnosis path. The
bundled examples are starting points, NOT ground truth — when they
disagree with behavior, trust the library source over the example.

### Which path to use

- **Just need a working game** → Path A. Fork the nearest example with `examples({op:'fork'})`, iterate.
- **Hit a bug or unexpected behavior** → switch to Path B.
- **Don't know which** → start in Path A; if iterations fail to
  converge after 2-3 attempts, you're hitting something path A
  can't fix and need path B.

### Where files land in your project tree

A forked project (`examples({op:'fork'})`) is
**FLAT** for everything you author. `main.c` / `main.asm`, your
helper modules (e.g. `gb_runtime.c`, `nes_runtime.c`,
`atari7800_sfx.c`, `vcs_constants.h`), the platform crt0 + linker
config — all sit at the project root, next to each other. Asm
`include "vcs_constants.h"` / C `#include "gb_runtime.h"` resolves
without `-I` flags because dasm / cc65 / sdcc all default to the
current directory.

The **only** subdir you'll see at fork time is `vendor/` —
that's the read-only library source tree (cc65 libsrc, libtonc /
libgba src, PVSnesLib source, SGDK src) auto-bundled by R58b so
you can `grep -rn vendor/` when debugging. Don't put your own
source under `vendor/`.

So when `examples({op:'copySnippets'})` drops e.g. `read_joystick.asm` into
your project dir, it lands at `./read_joystick.asm` (alongside
`main.asm`), NOT under `./include/` or `./lib/`. Every platform
follows the same flat layout.

Because the layout is flat, **the simplest loop is `build({output:'run', path, platform})`
(build + load + run + screenshot in one call) or `build({output:'project', path, platform})`
(build the dir to a ROM) — no per-iteration file manifest, on EVERY platform.** Point it at
a forked project directory and it does the right per-platform thing automatically: finds the
entry (`main.c` for C / SGDK Genesis / GBA / cc65-C / SDCC-C, or `main.s` / `main.asm` for
asm), routes the platform's crt0 correctly (e.g. GB/GBC `gb_crt0.s` via the cart-header path,
not as a plain source — so no `gsinit` collision), applies the right linker preset
(e.g. NES `chr-ram-runtime`, which supplies the OAM/CHARS segments), skips SDK intermediates
(e.g. Genesis `sega.preprocessed.s`, the SNES SPC700 driver, any `*.upstream.*`), wires the
runtime (GBA libtonc/libgba/maxmod by what the source includes), routes `#include`d C/asm
siblings as includes, treats `.h`/`.inc` as includes, and folds binary assets
(`.bin/.chr/.pcm/.brr/.vgm/.xgc/...`) in as `binaryIncludes`. So iterating an on-disk project
is just `build({output:'run', path:'/my/proj', platform})` every time — you do **not** need to
enumerate `sources`/`includes`/`crt0Path`/`linkerConfig` by hand. (Use `build({output:'rom'})`
with explicit `sources` only when the files aren't on disk, e.g. generated in-context.)

## Supported platforms

**14 tier-1 platforms** (build + run + screenshot + inspect + genre example games + sound + music + per-platform MENTAL_MODEL.md + TROUBLESHOOTING.md):

NES, Game Boy, Game Boy Color, SNES, Genesis, Game Boy Advance, SMS, Game Gear, C64, Atari 7800, Lynx, PC Engine, MSX — all with the full set of forkable genre example games (`examples({op:'fork', example:'<platform>/shmup|platformer|puzzle|sports|racing', name, path})`). The Atari 2600 is also tier-1 but ships **4** of those genres (no `puzzle` — the TIA has no tilemap to draw a match-3 board). The `platformer` example side-scrolls (hardware camera + per-platform column streaming) on every tier-1 platform except NES and the Atari 2600, which are single-screen (neither has hardware background scroll). Every tier-1 platform also ships a music demo using the platform's de-facto music engine — `music_demo` for most: FamiTone2 (NES), hUGEDriver (GB/GBC), SPC700 driver (SNES), XGM2 via SGDK (Genesis), maxmod + .xm soundbank (GBA), PSG trackers (SMS/GG), SID sequencer (C64), `lynx_snd_play` (Lynx), 2-voice TIA (Atari 2600/7800); PC Engine and MSX ship theirs as `music_sfx` (HuC6280 PSG; AY-3-8910 PSG). PC Engine and MSX additionally ship a hardware helper library plus `sprite_move` / `catch_game` example projects alongside the genre examples.

**Bring-up only** (build pipeline works, single `default` example, no genre example games or sound/music wrappers yet): ColecoVision. Uses SDCC z80 same as SMS/GG/MSX — the genre examples are queued.

**Delisted** (toolchain works but core-side issue blocks the run loop): Atari 5200 (atari800 BIOS-load path), ZX Spectrum (fuse tape-load path).

Call `platform({op:'list'})` (in the `platforms` category) for the live capability matrix, including per-platform language defaults and quirks. **Defaults are picked to maximize agent effectiveness** — for every platform that has a bundled C compiler, C is the default (LLMs write C cleanly; the compiler handles register allocation + memory mapping). Platforms whose only bundled toolchain is an assembler default to asm. Override with `language: "asm"` or `language: "c"` when you specifically need the non-default.

For maintainers: the platform / core / patch / region-ID matrix and the recipe for adding a new platform live in the project repo at https://github.com/monteslu/romdev.

## Deep debug tooling status per platform

Different platforms have different levels of MCP-exposed debugging — different hardware needs different tools, and we've patched the cores where it's been worth it. The generic shapes — `cpu({op:'read'})`, `breakpoint({on:'write'})`, `disasm({target:'rom'})`/`disasm({target:'references'})`, `memory({op:'search'})`/`memory({op:'readCart'})`/`memory({op:'classify'})`, cheats — work on **all 18 platforms** (disassembly via native binutils `objdump` compiled to WASM, one per CPU family — incl. GBA ARM7/Thumb and the 3D consoles' MIPS/SH-4); byte-exact `disasm({target:'project'})` reassembly is the **15 classic platforms** (incl. GameTank, cc65/6502). The deep per-platform inspectors (`sprites({op:'inspect'})`, `palette({source:'live'})`, `background({view:'renderState'})`, `audioDebug({op:'inspect'})`) are detailed for **12 systems** below; **PC Engine and MSX** currently have the generic shapes + their core's native regions but not yet the full custom-inspector treatment (extend by patching their cores per the snes9x/gpgx pattern). `audioDebug({op:'inspect'})` covers the **13 with a sound chip** (all but Atari 2600/7800; incl. GameTank's ACP coprocessor). A few are honest hardware-shaped exceptions, noted inline below (the Lynx has no fixed OAM so `sprites({op:'inspect'})` returns the SCB list head; GameTank is a blitter framebuffer with no sprite OAM / no tilemap, so `sprites({op:'inspect'})`/`background` are N/A). Coverage detail per platform:

> **Universal across the 15 classic platforms:** `breakpoint({on:'write'})` (the core-level
> instruction write watchpoint — the exact PC that wrote a RAM byte, all 15 classic CPU
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
> or need a mid-routine halt. With `sandbox:false` (the default — you want the dst
> buffer left live to read), a call that does NOT return leaves the sentinel push and
> the callee's own pushes stranded on the game's stack; the CPU register file is
> restored automatically in that case (`cpuContextRestored:true`) so the interrupted
> code can still resume, while the RAM the routine wrote is deliberately left live),
> **`watch({on:'range'})`** (log EVERY read/write hitting an address range — discovery;
> pass **`fromState`**/`fromStatePath` to restore a savestate FIRST so the trace runs from a
> known, repeatable moment — jump to the boss, then see what writes HP),
> **`watch({on:'pc'})`** (coverage trace — distinct PCs executed in a window; also takes `fromState`),
> **the RE-INJECT trio** (put an edited asset BACK, all 15 classic platforms): **`romPatch({op:'findPointer'})`**
> (find every pointer to a ROM offset — Genesis 32-bit BE, SNES LoROM/HiROM, GBA
> 0x08000000+offset incl. literal pools, banked 8-bit 16-bit-LE aliases),
> **`romPatch({op:'makeStored'})`** (wrap raw bytes so the game's OWN decompressor expands them
> verbatim — GBA LZ77 / SNES LC_LZ2 / SMS+MSX RLE / NES PackBits / `raw` for the
> uncompressed-graphics systems; Nemesis + C64 crunchers honestly refused), and
> **`romPatch({op:'relocate'})`** (write to free space + repoint),
> `cheats({op:'lookup'})`/`cheats({op:'search'})`/`cheats({op:'apply'})`/`cheats({op:'make'})` (cheat
> lookup/apply/create), `cpu({op:'read'})`, `memory({op:'search'})`/`memory({op:'searchNext'})`/`memory({op:'readCart'})`/`memory({op:'classify'})`,
> `memory({op:'snapshot'})`/`memory({op:'diff'})`/`state({op:'diff'})`, `watch({on:'mem'})`/`breakpoint({on:'write',precision:'sampled'})`.
> `audioDebug({op:'inspect'})` covers the 13 systems with a sound chip (all but Atari 2600/7800; incl. GameTank's ACP coprocessor).
> **`watch({on:'dma', precision:'exact'})`** (which DMA wrote a VRAM tile, and from where) is **Genesis-only**
> (VDP DMA) — elsewhere use `breakpoint({on:'write'})`/`watch({on:'range'})`. All other RE tools above
> work on every platform that has the register-write/watch core hooks (the 15 classic platforms).
> `disasm({target:'rom'})` + `disasm({target:'references'})` cover **all 18** (incl. the 3D consoles' MIPS/SH-4), and `disasm({target:'project'})` byte-exact reassembly the **15 classic platforms** (incl. GameTank) — every
> CPU family disassembles through a native binutils `objdump` (WASM). To REBUILD,
> **`build({output:'reassemble', platform, path})` turns a `disasm({target:'project'})`
> dir back into a byte-identical ROM in ONE call on all 15** — it assembles each
> region `.asm` with the native assembler and splices the results into the original's
> header/gaps/pad. (Edit a region first for an intentional change; a same-length edit
> rebuilds a modified ROM, a length-changing edit is refused.) The per-platform notes
> below cover the platform-SPECIFIC inspectors + chips (PC Engine + MSX: generic shapes only so far).

The deep per-platform inspectors + the exact memory-region names, core quirks, and any platform-specific traps live in **each platform's `MENTAL_MODEL.md`** (read via `platform({op:'doc', platform, name:'mental_model'})`) — read it for the system you're on. Symptom → doc:
- **NES** — blank/black screen, wrong sprites/colors, or need live PPU regs / CIRAM-attribute / MMC1-banked CHR state.
- **SNES** — garbage/flashing sprites, or live OAM/CGRAM/SPC700/S-DSP state (PPU regs read via the FillRAM shadow — no core patch needed).
- **Genesis** — missing/wrong sprites, palette/scroll, or live SAT/CRAM/VSRAM/VDP/Z80 state (mind the gpgx VRAM byte-swap).
- **GB / GBC** — wrong sprites/palette/tiles/BG or live SM83/APU/LCDC state; gambatte exposes `gb_vram` (NOT `video_ram`) + `gb_oam`/`gb_io`/`gb_hram`. (GB MENTAL_MODEL also holds the SDCC toolchain notes; GBC adds the CGB palette deltas.)
- **SMS / GG** — sprite/tile/palette/BG issues or live Z80 + VRAM/CRAM/VDP regions (SMS holds the shared gpgx detail; GG = 12-bit-vs-6-bit palette + `gg_vram`/`gg_cram` deltas).
- **GBA** — sprite/palette/BG wrong, ARM7 `execPc` (pipeline-adjusted PC), the `gba_*` regions, or ARM-vs-Thumb objdump (Thumb decodes as `.byte`).
- **Atari 2600** — blank screen / missing sprite / TIA-or-palette state, or `audioDebug` "not supported" (no OAM, no standard sound chip).
- **Atari 7800** — display-list garbage, MARIA palette/DPP, `sprites({op:'inspect'})` returns no OAM, or no `audioDebug`.
- **C64** — VIC/sprites/SID/banking misbehaving: live palette/sprites/cpu/renderState inspectors, `c64_*` regions, `.prg` disasm, disk load/save+export (and its keyboard/joyport input — see "Driving input over MCP").
- **Atari Lynx** — `sprites({op:'inspect'})` returns an SCB list head (no fixed OAM), or you need the Mikey palette/audio, 65C02 regs, or the `lynx_hw_regs` $FC00-$FDFF window.
- **MSX** — VDP/PSG inspection or AY8910 `audioDebug`. (ColecoVision is bring-up-only: standard `system_ram`/`save_ram`/`video_ram`, no custom inspectors — extend by patching its core per the snes9x/gpgx pattern.)
- **PC Engine** — generic shapes + the core's native regions only so far (no custom-inspector treatment yet).
- **GameTank** — Clyde Shaffer's open-hardware W65C02S console (cc65 toolchain, ext `.gtr`). Full classic-style Tier-1: `cpu({op:'read'})` (65c02 regsnap), `audioDebug({op:'inspect', chip:'acp'})` (the ACP audio coprocessor), `breakpoint({on:'write'|'read'|'pc'})` + watchdog + coverage, `disasm` (`bytes`/`rom`/`references`/`project` + the 6502 Rizin/Ghidra cfg/xrefs/functions/decompile path — a 32KB flat cart @ `$8000`, one region, rebuilt byte-identical via `build({output:'reassemble', platform:'gametank', path})`), `cart({op:'extract'|'wrap'})`, and the 6502 re-inject path (`romPatch`) same as NES/C64/Lynx. **No `sprites({op:'inspect'})`/`background`** — it's a blitter framebuffer with no sprite OAM / no tilemap (like the Dreamcast). No genre example games yet (brand-new platform).

Starter snippets per platform live under `src/platforms/<platform>/lib/`. Discover via `examples({op:'snippets', platform})` (default `mode:'list'`), fetch one via `examples({op:'snippets', platform, mode:'get', snippetName})`. SNES + NES + Genesis + SMS + Game Boy + Atari 2600 + Atari 7800 have substantial snippet libraries; others are minimal.

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
5. `input({op:'set'})` / `input({op:'press'})` / `input({op:'sequence'})` to drive the game — some platforms have extra control/input modes worth reading in their `MENTAL_MODEL.md` (e.g. C64 needs keyboard keys like F1/RUN-STOP to start many games; `input({op:'pressKey'/'typeText'/'joyport'})`)
6. `state({op:'save'}, "checkpoint")` / `state({op:'load'}, "checkpoint")` for try/undo

## Diagnosing behavior over time (game-feel, not just "is it alive")

`frame({op:'verify'})` answers "is it rendering / alive". When the screen looks
plausible but the game is WRONG — choppy movement, a value that's off, a piece
that locks mid-air — STOP eyeballing screenshots and trace the state. These tools
already exist; reach for them by symptom:

- **"Movement/scrolling feels choppy / camera desyncs / scroll jumps."**
  `recordSession({frames:180, holdInputs:[{right:true}], includeScreenshots:false,
  memorySamples:[{region, offset, length, label}]})` — holds input over N frames and
  returns an analyzable timeline. Sample the player's screen-X + the scroll
  registers (Genesis: `genesis_vsram` + the HSCROLL table in `video_ram`; per
  platform varies) and look for camera scroll changing while the sprite barely
  moves, or non-monotone deltas. `watch({on:'mem', format:'series', ranges:[...]})`
  gives the same idea as a compact value-vs-frame CURVE per byte. (Genesis: see
  its MENTAL_MODEL "Why does horizontal movement feel choppy?" — the usual cause
  is rewriting tilemaps in the frame loop; `watch({on:'dma', perFrame:true})`
  shows the per-frame DMA bytes that spike when you do.)
- **"A computed value is wrong but the build is clean."** Don't re-read your C.
  Resolve the variable's address and read it: `build({output:'romWithDebug',
  resolveSymbols:["grid","score"]})` (or `symbols({op:'resolve', mapPath|dbgPath,
  name})`) → `memory({op:'read', region, offset})`. Cheap, zero image tokens, and
  it tells you whether the bug is your logic or your data. (sm83/z80: a "wrong
  value" is far more often a WRAM layout collision than a miscompile — see the
  GB/GBC SDCC_GOTCHAS "codegen traps in plain game logic".)
- **"I can't tell what's on the background."** `background({view:'map'})` decodes
  the BG tilemap (grid of tile indices, or a rendered PNG) — don't hand-compute
  nametable offsets. Small handheld too tiny to read inline? `frame({op:'screenshot',
  scale:4})` up-scales (nearest-neighbor).

## When a call fails: READ THE ERROR FIRST

romdev errors are written FOR you — they name what went wrong AND how to recover. Read the message (and `issues[]`) before guessing, screenshotting, or retrying blindly. Two shapes:

- **Build/compile failures** return `issues: [{file, line, col, severity, message, stage}, ...]` — the structured error list. Use that array, NOT the raw `log`; it almost always names the exact line. Fall back to `log` only if `issues` is empty but `ok: false`. `issues[]` is RANKED most-dangerous first (**critical → error → warning → info**), so read it top-down: an entry flagged `critical: true` (e.g. a `WILL HANG:` `uint8`-loop-bound trap) is a latent crash even on a build that otherwise succeeded — fix those FIRST, never skip them as "just a warning". Link errors carry no `line` but include a `hint` naming the missing symbol + how to resolve it.
- **Tool/runtime errors** (thrown) carry the recovery step in the message itself. Examples: a "No ROM loaded" error after a session reconnect echoes the EXACT `loadMedia({...})` call to restore your state; a rejected `loadMedia` names the likely cause (wrong platform / truncated / unsupported mapper) and points you at `cart({op:'identify'})`; an `input({op:'set'})` with a typo'd button returns `ignoredButtons[]` so you see it pressed nothing. Don't discard these — they're the fix.

**Crash isolation (R12).** Every WASM toolchain call runs in a child worker process. If a tool aborts (`_abort()`, SIGSEGV, OOM), only the worker dies — the MCP server keeps running, all other agent sessions are unaffected, tool registration + save states + playtest windows survive. The build response surfaces as `{ ok: false, stage: "crash", log: "[crash] worker exited unexpectedly — signal=… code=…", crash: { exitCode, signal } }`. Treat `stage: "crash"` as "the toolchain blew up — log the args + source somewhere durable so it can be triaged; you can keep iterating in this session without reconnecting".

## ROM hacking workflow

**The full RE/romhack workflow is the playbook — read it FIRST:**
`platform({op:'doc', platform:'romhacking', name:'playbook'})`. It's the cross-platform
decision tree that wires the primitives below together (with the trap each one exists
to avoid), plus the per-asset round-trips (text, compressed assets, graphics) and a
Quick-reference table. Don't reconstruct the flow from this summary — it's only here so
you know the capability exists and where the detail lives.

Key primitives (all bundled, all 15 classic tier-1 systems unless noted; full detail in the
playbook):

- **Find a value's RAM address** — the Cheat-Engine loop `memory({op:'search'})` →
  `memory({op:'searchNext', compare})`, NOT a full-RAM diff. (`memory({op:'snapshot'})`+`memory({op:'diff'})`
  answers the different question "which bytes did THIS one event touch?".)
- **Free RAM/code map for a known game** — `cheats({op:'lookup', path})` decodes each cheat
  into labeled addresses (`kind:ram`=variable, `kind:code`=patch site); `cheats({op:'apply'})`
  confirms a label live + non-destructively; `cheats({op:'make'})` mints a verified shareable
  code from a byte you found. Probable (name) match — verify before patching.
- **Find the instruction that wrote/read a byte** — `breakpoint({on:'write', address})` returns
  the EXACT writer (core-level watchpoint, correct under NMI/IRQ; reports `bank`);
  `precision:'sampled'` is the lighter frame-sampled lead. `breakpoint({on:'read'})` is the
  read-side mirror. `found:false` ⇒ the region is bulk-copied/DMA'd from a SOURCE struct.
- **Read a register AT an instruction** — `breakpoint({on:'pc', address})` freezes the CPU →
  `cpu({op:'read'})` for the live register file (e.g. a decoder's source pointer);
  `frame({op:'stepInstruction'})` single-steps (or **`frame({op:'stepInstructions', count})`** to bulk-step N into ONE ordered trace — each step carries `flow` (seq/branch/call/jump/ret) and a true instruction `width` on `flow:'seq'`; pass **`stepFormat:'compact'`** for one string per step (`"$PC flow->$target"`) + a `pcRanges` loop-map with hit counts, ~90% fewer tokens for the "which loop is the CPU in" triage view). The "infer for hours → read it in 3 calls" move.
- **Discover the unknown routine** — `watch({on:'range'|'pc'})` logs every PC touching a
  region; `watch({on:'dma'})` (Genesis) traces a graphic back to its ROM source offset.
- **Confirm bytes / classify** — `memory({op:'readCart'})` reads the running program image
  (un-banked: file offset = CPU address); `memory({op:'classify'})` tells a real table from
  ASCII/code before you trust it.
- **Edit on-screen text** — `text({op:'learn'})` infers the font map (incl. LIVE
  `fromScreen` mode — no offset needed) and flags pre-rendered-graphic text (don't patch
  the "string"); `text({op:'find'})`/`text({op:'encode'})` do the string round-trip.
- **Compressed assets** — drive the ROM's OWN codec: `cpu({op:'decompress'})`/`cpu({op:'call'})`
  to expand, then the re-inject trio `romPatch({op:'makeStored'})` (verbatim-expand block) →
  `romPatch({op:'findFree'})` → `romPatch({op:'relocate'})`, with `romPatch({op:'findPointer'})` for the
  loader pointer. Don't reimplement the compressor.
- **Author/verify the patch** — `assembleSnippet({cpu, origin, code})` → bytes;
  `romPatch({op:'write'})` (always pass `expect`); `romPatch({op:'diff'})` mapper-aware verify;
  `disasm({target:'references'})` (static "who touches this?"); `cart({op:'extract'|'wrap'})`.
- **Graphics swaps** — `tiles({op:'png'})`/`importArt({from:'rom'})` → edit →
  `romPatch({op:'spliceCHR'})`; `background({view:'rendered'})` for the tile IDs drawn now.

Category placement: most live in `assets`; `disasm({target:'rom'})` is in `debug`; the
breakpoint trio (`pc`/`read`/`stepInstruction`) is in `advanced`.

## Disassembler

`disasm({target:'rom'|'references'})` covers **all 18 platforms** (incl. the 3D consoles'
MIPS R3000/R4300 + SH-4); byte-exact `disasm({target:'project'})` reassembly is the **15
classic platforms** (incl. GameTank, cc65/6502). Every CPU
family disassembles through a native binutils disassembler compiled to WASM (no
hand-rolled JS decoders): 6502/65816 via cc65's `da65`, Z80 (SMS/GG/MSX) + SM83
(GB/GBC) via one z80-elf `objdump` (`-m z80` / `-m gbz80`), m68k (Genesis) via
`m68k-elf-objdump`, ARM/Thumb (GBA) via `arm-none-eabi-objdump`. The annotations
(vector labels / hardware-register names / file-offset comments / `untilReturn`) are
post-processing layered on top.

```js
disasm({target:'rom', path, platform:"nes", startAddress:0xC184,
                length:64, untilReturn:true})
//   reset:  sei                  ; C184 78        @0x194 (prg @0x184)
//           lda  #$00            ; C186 A9 00     @0x196 (prg @0x186)
//           sta  $2000           ; C188 8D 00 20  @0x198 (prg @0x188) PPUCTRL
```

`disasm({target:'project'})` is the **RE-rebuild workhorse**: one call turns a whole ROM
into a byte-exact, re-buildable disassembly (per-region `.asm` + rebuild glue), faithful
where it can be and falling back to `.byte` where it can't — so it *always* reassembles to
the original image. That's the path for any structural hack (new logic / text / graphics).

The tool's own params document the flags (`untilReturn` / `dataRanges` / `endAddress` /
`bank` / `thumb` / `outputPath`; auto vector labels + register-name + file-offset
annotations, all on by default; NES file offsets report both `.nes` and PRG). The
ROM-hacking playbook (`platform({op:'doc', platform:'romhacking', name:'playbook'})`) has
the end-to-end workflow — read those rather than re-deriving the detail here.

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

Both work fine. Image mode is more flexible but burns more tokens per call. Use text mode for scans and diffs, image mode for "does this look like the hero sprite?" questions.

## Active Bezels — when a screenshot is NOT the core's picture

An **Active Bezel** is an executable companion to a specific ROM (a `.ab`
package). It runs once per emulated frame, reads the core's live memory, and
renders the final scene — a map, a HUD, reconstructed world graphics — around or
over the game. Load one with:

```js
loadMedia({platform:'nes', path:'/roms/Game.nes', useActiveBezel:true})
```

That looks for a same-basename sidecar (`Game.nes` → `Game.ab`) and **fails
loudly** if there isn't one, rather than quietly loading the ROM alone.

**Why this section matters even if you never load one:** with a bezel running,
`frame({op:'screenshot'})` returns the **composite** by default, not the raw
emulator framebuffer. If you assume otherwise you will misread every capture. So
before interpreting a screenshot in an unfamiliar session, check
`catalog({op:'status'})` — it reports `activeBezel` whenever one is attached.

**A package can be confidently, completely wrong.** It can load, tick without
trapping, emit perfectly valid draw commands, and still have nothing to do with
the game — an early package for a maze game declared it read the player's room, X and
Y, its readable `main.c` contained room-aware logic, and the compiled
`main.wasm` ignored the room byte entirely and drew fake progress bars. Unit
tests proved it loaded and drew. They proved nothing about meaning.

Catching that needs three things observed at the same instant, which is exactly
why the bezel runs inside romdev instead of only in a player:

```js
frame({op:'screenshot', source:'both', path:'/tmp/shot.png'})
```

`source` selects the picture: `'composite'` (default with a bezel) = the final
scene the human sees, `'core'` = the raw framebuffer ignoring the bezel,
`'both'` = the pair for the SAME frame, plus the geometry triple. Compare the
two against the guest's own region reads — don't settle for "it drew
something."

**Geometries that are easy to conflate,** all reported under `geometry`:

| Key       | What it is                                                             |
| --------- | ---------------------------------------------------------------------- |
| `core`    | the raw framebuffer the emulator produced — does NOT describe intended shape (Atari 2600 pixels are famously not square) |
| `scene`   | the bezel's logical composition, which the host may scale               |
| `display` | the runtime's own account: `logicalWidth/Height`, `internalWidth/Height`, `physicalWidth/Height`, `pictureEffect`, and `rendererBackend` (`opengl-es-3` or `cpu`) |

Conflating them is how a 4:3 game ends up stretched into a tall rectangle. When
a golden frame stops matching, check `display.rendererBackend` first — a GPU/CPU
compositor difference is the usual cause.

**Lifecycle, so a stale package never composites over the wrong game:**

- The bezel ticks on `frame({op:'step'})`, not just at capture time — a package
  with per-frame state (an animation, a room transition) would otherwise see a
  timeline full of holes.
- `host({op:'unload'})` / `host({op:'shutdown'})` **detach** it, and a plain
  `loadMedia` without the flag detaches the previous one. The package is bound
  to a ROM hash; keeping it across a media swap would draw one game's map over
  another game's picture.
- `host({op:'reset'})` and `state({op:'load'})` **keep** the package but notify
  it that continuity broke, so it discards caches built from a timeline that no
  longer exists.
- A guest fault is recorded in `activeBezel.lastError` and the capture falls
  back to the core frame. A broken package never takes down your session.

**Development overrides** (ordinary use should rely on same-basename discovery):
`activeBezelPath` points at a package elsewhere (an unpacked directory works),
`activeBezelConfig` passes per-package settings, `activeBezelForce:true` loads
despite a ROM-hash mismatch (**the composite may be meaningless** — a map keyed
to another revision's RAM layout draws confidently wrong things), and
`activeBezelRenderer:'software'` pins the deterministic CPU compositor, which is
what you want for golden-frame comparisons.

Not supported on `slot:'b'` — that slot is comparison scratch for
`frame({op:'sideBySide'})` and never drives the presented frame.

### Writing one: no toolchain required

The `active-bezel` package ships prebuilt runtimes, so authoring a bezel is
**one command**. No emcc, no build step.

```sh
npx --package active-bezel abtool scaffold my-bezel lua
```

`lua | js | python | ruby` need no toolchain at all; `c` adds the SDK header
and a build.sh for anyone who wants to compile. The scaffold is a complete
package -- runtime wasm, a commented script that is already a working bezel,
and a manifest -- so it loads and renders before you have edited a line.

| Language | Scaffold | Script | API root |
|---|---|---|---|
| Lua 5.4 | `abtool scaffold my-bezel lua` | `main.lua` | `ab.` |
| Python (MicroPython) | `abtool scaffold my-bezel python` | `main.py` | `ab.` |
| JavaScript (QuickJS) | `abtool scaffold my-bezel js` | `main.js` | `ab.` |
| Ruby (mruby) | `abtool scaffold my-bezel ruby` | `main.rb` | `AB.` |
| C | `abtool scaffold my-bezel c` | `main.c` | `ab_*()` |

The scaffold's script is a **working bezel** with a commented example of each
capability: 2D shapes, the live game, TrueType and
bitmap text, live memory reads, transforms, a decoded PNG, a per-vertex mesh,
and a GLSL shader effect. All four expose the same API, so a bezel ports
between languages by changing syntax alone.

```lua
function tick(frame)
  ab.clear(ab.rgb(14, 16, 26))
  ab.draw_game(0, 0, 1440, 1080, ab.SAMPLE.NEAREST)
  local ram = ab.region('system_ram')
  ab.print(font, ('HP %d'):format(ab.read_u8(ram, 0x0E)), 1500, 80, 40, 0xffffffff)
end
```

**The iteration loop is why this matters here.** `activeBezelPath` takes an
unpacked directory, so: edit the script, `loadMedia` again, `frame({op:
'screenshot'})`, look. Nothing needs packing until you ship. To keep game state
across a reload, `state({op:'save'})` → `loadMedia` → `state({op:'load'})`.

A script error does **not** kill the session: the runtime draws the message and
the failing line on an on-screen panel and keeps ticking, so a screenshot tells
you what broke.

Single-pass RetroArch shaders port into `ab.effect_set()` almost verbatim
(rename `Texture` → `u_texture`, `vTexCoord` → `v_uv`, `FragColor` →
`out_color`, add `#version 300 es`). Gate on `v_uv` to treat only the game rect
and leave your panels alone.

**Offscreen surfaces and multi-pass presets.** `ab.surface_create(w, h)` gives
a real render target: draw into it, filter it with its own shader, reuse it as
a texture, keep it across frames. `ab.surface_filter(src, dst, glsl)` runs one
shader into a surface; `ab.surface_preset(src, dst, 'crt.glslp')` runs a whole
multi-pass RetroArch preset. Filtering into a surface runs the shader flat at
the source's own scale, so a CRT shader behaves as written and any geometry
(tilt, curvature) happens once, afterwards. `ab.GAME` is the live frame as a
texture handle. No shaders ship with the package -- point at
[libretro/glsl-shaders](https://github.com/libretro/glsl-shaders) or a
RetroArch install.

**The bezel sees the controller.** `ab.input(port, ab.DEVICE.JOYPAD, 0,
ab.BTN.A)` reads the same libretro state the core does, so an on-screen
controller or input display cannot disagree with the game about what is
held.

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
- **`path` resolution:** a RELATIVE `path` resolves against the **loaded ROM's directory** (so `path:"states/start.state"` lands next to your ROM), an absolute path is used as-is; the result echoes `resolvedPath` when they differ. (It is NOT resolved against the server's CWD.)

**SRAM (the cartridge BATTERY SAVE FILE — distinct from a savestate).** A savestate is the whole machine; SRAM is just the bytes a real cart keeps on its battery (the in-game save). romdev exposes it three ways, all on existing tools:
- **Live read/write:** `memory({op:'read'/'write', region:'save_ram'})` — poke/inspect the running game's save RAM.
- **Persist the `.sav`:** `state({op:'exportSram', path})` writes the save file; `state({op:'importSram', path})` loads one back (edit a save offline, or inject one a player made elsewhere). Same relative-path-resolves-to-ROM-dir rule.
- **Presence:** `cart({op:'identify'})` returns `saveRam:{hasBattery, bytes}` so you know whether a save even exists before reaching for it.
- **No battery save?** Many carts use passwords or no save (and Atari 2600/7800 + Lynx never had cartridge saves). `save_ram` is empty there and the tools say so plainly — use a full-machine savestate (`state({op:'save'/'load'})`) instead. **C64 is different:** its save medium is the floppy disk, not battery SRAM — use the disk ops (`state({op:'exportDisk'/'importDisk'/'putDiskFile'})`, see the C64 platform notes), not save_ram.

`state({op:'load'})` removes any active cheats (a save-state blob doesn't carry frontend cheat state) and reports `cheatsCleared`. `host({op:'reset'})` resets the frame counter + core state (and clears cheats) but keeps the loaded ROM. Both KEEP an attached Active Bezel and notify it that the timeline jumped, so the first composite afterwards is drawn from the restored memory rather than from the abandoned timeline's caches.

## Starting a project: fork an example game

**Never start from a blank file — fork the example whose CORE LOOP is nearest your game (even for a very different game), then modify one thing at a time, re-running `build({output:'run'})` after each.** Read OTHER examples with `examples({op:'show'})` for techniques to graft. Rationale: retro bring-up is a long chain of fragile hardware init with zero partial credit; a working game is a regression oracle.

- **`examples({op:'list', platform?})`** — the mechanics map of the example library: every example with its kind (`game` = complete working game, `reference` = minimal demo like `default` / `hello_sprite` / `tile_engine`), mechanics inventory, hardware techniques demonstrated, players, SRAM. Pick the example whose core loop is nearest your game.

- **`examples({op:'fork', example:"<platform>/<name>", name, path, title?, overwrite?})`** — copies that example into a NEW project dir as YOUR game: `main.{c,asm,s}` + every runtime file it depends on (headers, crt0, linker .cfg) + README + `.gitignore`, renamed throughout. Self-contained: take it elsewhere and rebuild with stock cc65/sdcc, no romdev install needed. (You can also pass `platform` + `template` instead of `example`.) **Then build it in ONE call: `build({output:'run', path:<that dir>, platform})`** — the dir build applies the platform's recipe (crt0/linker-preset/runtime/intermediate-skip) automatically, so you never hand-wire `crt0Path`/`codeLoc`/`linkerConfig`. This fork→build path is verified to build + render on every platform/example.

- The **genre example games** (`shmup` / `platformer` / `puzzle` / `sports` / `racing`) are the usual fork targets — complete working ROMs with state machine + sprite allocation + sound wired. Available on **all 14 tier-1 platforms** (NES, GB, GBC, SNES, Genesis, SMS, GG, C64, GBA, Lynx, Atari 7800, PC Engine, MSX — full 5 each; Atari 2600 — 4, no `puzzle` since the TIA has no tilemap for a match-3 board). Availability is derived from the registered examples (not a hardcoded list), so the error message for an unsupported (platform, name) pair always names the current set; e.g. `atari2600/puzzle` is rejected and the error lists the examples it *does* have. ColecoVision (bring-up only) has no genre examples. No example matches your genre exactly? Fork the NEAREST core loop and reshape it — `examples({op:'list'})` returns the genre→nearest-fork guidance. **Want a side-scroller? Fork `<platform>/platformer`** — on every platform EXCEPT NES and the Atari 2600 it already side-scrolls: a hardware camera follows the player (SCX/$D016/R8/BXR/BG?HOFS/REG_BG?HOFS/bgSetScroll depending on platform), with software tile-column streaming where the world is wider than one nametable/plane. NES and the Atari 2600 are single-screen (no hardware background scroll — platforms drawn as sprites/playfield); to make NES scroll, draw platforms into the background nametables + `ppu_scroll(camX,0)` (it flips the PPUCTRL nametable-select bit past 256 px) + stream columns past 512 px. Each platformer's `describe` text gives the per-platform specifics; the scroll-register details live in the platform's MENTAL_MODEL.md "Horizontal scrolling" section.

- **`examples({op:'show', example, file?, technique?})`** — read a donor example WITHOUT forking it: a whole file, or one marked HARDWARE IDIOM block (`technique`) with the dependency header that says what the block needs to survive a transplant. Fork for the core loop; show OTHER examples for techniques to graft.

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

`playtest({ scale: 3 })` opens a real SDL window for a human to play the loaded ROM with a keyboard or USB controller. It **returns immediately** — the render loop runs in the background and you keep using every other tool against the same live host (so `build({output:'run'})`/`loadMedia` rebuilds update the window in place; it does not relaunch or crash on rebuild). Close it with `playtest({op:'stop'})` (or the human pressing ESC / Select+Start). Needs a desktop display *and* the optional `@kmamal/sdl` dep; without them the open FAILS with a `reason`-tagged tool error and the rest of the server keeps working headless. Use this when the human wants to feel the game, not when you want to test it (for your own checks, use `frame({op:'screenshot'})` — it reads the same live host the window shows). `playtest({op:'status'})` reports liveness + the window's media/frame + `perf` (rolling fps/tickHz and per-stage ms — the "is it slow, and where" readout); the title bar always shows live fps, and `playtest({op:'fps', show?})` toggles an on-screen counter for the human (F3 does the same from the keyboard). `playtest({op:'framebuffer'})` captures exactly what the human sees.

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

⚠ **The raw libretro names `a`/`b`/`x`/`y` are NOT the platform's printed button labels — and on the three genesis_plus_gx platforms (Genesis, SMS, Game Gear) they're INVERTED.** Verified live across all 14 classic platforms:
- **Genesis**: gpgx maps Genesis A/B/C onto libretro **y/b/a** — so `input({op:'set', a:true})` presses Genesis **C**, and Genesis A (SGDK `BUTTON_A`) is `{y:true}` / `{west:true}`.
- **SMS / Game Gear**: button 1 (TL, main fire) is libretro **b**, button 2 (TR) is libretro **a** — so `{a:true}` presses button 2, not 1.
- **Every other core maps straight through** (`{a}`→A, `{b}`→B): NES, GB/GBC, SNES (incl. x/y/l/r), GBA, PC Engine (a=I, b=II), MSX (a=trig 1), Lynx (a=A). C64 + Atari 2600 are single-fire — fire is `{b}`/`{south}`, `{a}` is a no-op. Atari 7800 boots in 1-button mode (both fires read INPT4) until you enable 2-button mode.

**The safe habit: use the spatial names (`north/east/south/west`) or `input({op:'press', button:'a'|'b'|'c'|'1'|'2'})` — both resolve to the correct physical button per platform.** Reach for raw `a`/`b` only when you mean the literal libretro id. `input({op:'layout', platform}).faceButtons` is the authoritative per-platform map; each platform's MENTAL_MODEL has a "Driving input over MCP" note.

## Starter snippets

`examples({op:'snippets', platform})` (default `mode:'list'`) and `examples({op:'snippets', platform, mode:'get', snippetName})` give you vetted boilerplate — reset routine, `read_pad`, OAM DMA, palette upload, nametable clear. Each snippet's comments encode foot-guns prior agent sessions already hit. Always check what's available for your platform before writing platform-specific boilerplate from scratch. NES, SNES, SMS, GG, GB/GBC, Genesis, GBA, C64, Atari 7800 all have substantial snippet libraries. (Prefer forking + grafting from the real example games; snippets remain for one-off references.)

**Three ways to actually use them:**

- `examples({op:'snippets', platform, mode:'get', snippetName})` — one snippet's contents, returned as a string.
- `examples({op:'snippets', platform, mode:'getAll', language?})` — every snippet joined into one string. Useful for **reading**; the giant blob lands in your context (or pass `outputPath` to write it to disk instead).
- **`examples({op:'copySnippets', platform, destinationDir, language?, include?})`** — writes every snippet (or a filtered subset) straight to disk. **Bytes never pass through your context.** Use this when you're copying into a project dir. Flattens `lib/<lang>/foo.c` → `<destinationDir>/foo.c`. Optional `include: ["vdp_init", "joypad_read"]` whitelist for cherry-picking. Default `overwrite: true` (vetted boilerplate is meant to be regenerated).

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

Two cross-cutting notes apply broadly; the rest is platform-specific and lives in
each platform's docs (read them for the system you're on — see below).

- **C compilers run a pre-flight lint before the real compile.** When a build
  fails (or even when it succeeds with warnings), read the structured `issues[]`
  — entries with `stage:"lint"` name the exact file:line and carry a `ref:` into
  the relevant GOTCHAS section. Pass `lint:"strict"` to FAIL the build on any
  lint hit (default is advisory). Don't trust the raw compiler `log` line numbers
  — they're often off-by-one; the lint line is the right one.
- **All SDCC platforms (GB, GBC, SMS, GG, MSX, ColecoVision) are C89.** No inline
  `for (int i = …)`, no mid-block declarations, no compound literals/designated
  initializers — hoist every declaration to the top of its block. The lint catches
  these; the canonical reference (plus the WRAM-layout traps that masquerade as
  "miscompiles") is [`src/platforms/gb/lib/c/SDCC_GOTCHAS.md`](src/platforms/gb/lib/c/SDCC_GOTCHAS.md).

**Platform-specific toolchain traps live in each platform's
`MENTAL_MODEL.md` / `TROUBLESHOOTING.md` (read via
`platform({op:'doc', platform, name:'mental_model'|'troubleshooting'})`) — read
them for YOUR platform before you build.** By symptom:

- **SNES asm `ok:false` with empty/cryptic `issues[]`** → asar silent-fail idioms
  (`$ - label` size expr, `STA SYMBOL+N` on a `=`-constant, bank-border crossed) +
  **CHR/tilemap VRAM overlap** (garbage BG tiles) → snes `TROUBLESHOOTING`.
- **SNES has no sound** → audio is a SEPARATE SPC700 build (`platform:"spc700"` →
  `.incbin` → $2140-$2143 handshake; `encodeAudio({target:'brr'})` for samples) →
  snes `MENTAL_MODEL` "Sound" + `TROUBLESHOOTING`.
- **Hand-asm clobbers the C runtime / a ZP var isn't where you put it** → cc65
  zero-page starts at **$02** ($00-$01 reserved); first `.res 1` = $02. All cc65
  platforms (NES, C64, Atari, Lynx) → nes/c64 `MENTAL_MODEL`.
- **Busy BG art renders garbage / `encodeArt({stage:'tilemap'})` warns** → NES
  256-unique-tiles-per-pattern-table cap → nes `MENTAL_MODEL`.
- **GB/GBC: white screen, sprites garbage, VRAM stays empty, or "works until a
  button is held then corrupts"** → header/CGB-flag auto-fix, `shadow_oam`
  page-alignment, `memcpy_vram` (raw VRAM stores get elided), OAM-DMA-from-HRAM,
  crt0 BSS-zeroing, and `gb_vram` (NOT `video_ram`) → gb `MENTAL_MODEL` footguns +
  `SDCC_GOTCHAS`.
- **SMS/GG: sprites past slot N vanish / text cut off / sprites invisible** →
  8-sprites-per-scanline limit, SAT `$D0` terminator, R6 sprite-tile-base
  ($2000 vs $0000), GG OAM hardware-vs-visible coords → sms/gg `MENTAL_MODEL`.

Turnkey NES/GB/GBC projects (`examples({op:'fork'})`) copy every runtime file
the example needs (`*_runtime.{h,c}`, `gb_hardware.h`, crt0, linker cfg) into the
project dir and auto-fix the cart header at build — iterate the whole dir with
`build({output:'run', path, platform})`. Details in those platforms' MENTAL_MODELs.

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
