# ROM-hacking playbook (cross-platform)

A decision tree for reverse-engineering and patching an existing ROM, distilled
from real sessions (the traps below cost hours each). Read this once before a
romhack; it tells you which tool to reach for at each fork so you don't thrash.

Cross-platform. For platform specifics (memory map, VDP/PPU, byte order) also
read that platform's `platform({op:'doc', platform, name:'mental_model'})`.

---

## 0. Orient first (one minute, saves an hour)

1. `cart({op:'identify', path})` — name, platform, CRC, copier-header/zip handling.
2. `cheats({op:'lookup', path})` — if the bundled DB has this game, the cheat list **is a
   free RAM map**: labeled addresses for lives/score/timer/stats. This is the
   single best head start. No match? `cheats({op:'search', platform, query})` with a
   loose name (fuzzy) before assuming it's absent. Cheats are a STARTING point,
   not the whole job — combine with disassembly below.
3. `symbols({op:'map', platform})` / the platform MENTAL_MODEL for the layout.

The cheat DB is bundled (`romdev_game_codes`). Do **not** scan the user's disk for
`.cht` files — if it's not in the bundled DB, treat it as absent and RE it.

**Reading a `cheats({op:'lookup'})` hit as a RAM/code map.** Each decoded part carries an
`address`, a `value`, a `kind` (`ram` = a labeled variable; `code` = a labeled ROM
patch site, has a `compare`), and a `device` (`game-genie`/`pro-action-replay`/
`gameshark`/`action-replay`/`raw`). So "which byte holds magic?" → one `lookup` call.
Filter a long list with `filter:"health"` or `kind:"ram"`. A match is by No-Intro
**name/filename, NOT a verified CRC** — it's PROBABLE (a different region/revision can
move addresses), so confirm before patching. The cheapest confirmation is to apply it
and watch: `cheats({op:'apply', path, desc})` → `frame({op:'screenshot'})`.

`cheats({op:'apply'})` is non-destructive (volatile core state, the RetroArch way — the ROM
file is never touched; `host({op:'reset'})`/`state({op:'load'})`/`cheats({op:'clear'})` removes it). It takes a
matched `desc`, a raw `code`, or `loadMedia({cheats:[…]})` to seed codes BEFORE frame 0.
`appliedAs` reports how it went in (`ram` poke / `rom` read-intercept / `raw` device
code). DB coverage is 13/14 (every tier-1 system except C64); GBA cheats are
encrypted, so apply-only (no labeled-address map — see `mapNote`).

**Creating a NEW code — `cheats({op:'make', platform, address, value, compare?})`.** The inverse of
decoding: turn a byte you found (via §1 or `breakpoint`) into a shareable, verified code,
for ANY ROM incl. your own homebrew/WIP. A RAM cheat needs just `address`+`value`; a ROM
patch adds `compare` (the byte currently there). It encodes for the platform's native
device(s) and labels each (NES/Genesis → Game Genie; SNES → Pro Action Replay **and**
Game Genie; GB/GBC → Game Genie + GameShark; SMS/GG → Action Replay) plus the raw
`ADDR:VAL`; each carries `verified:true` (round-trips against the full DB). Systems with no
letter-code device (Atari 2600/7800, Lynx, GBA, C64, PC Engine, MSX) get a verified raw
code. Works on all 14. Nothing is ever written to a ROM file.

---

## 1. To find the RAM address of a value (score / timer / stat / HP / record-id)

Use the iterative value search — **not** a full-RAM diff (gameplay churns
thousands of bytes and you'll drown).

1. `memory({op:'search', value, size, region})` — seed candidates equal to the current
   on-screen value. `region` defaults to `system_ram`.
2. Change the value in-game (take damage, score a point), then
   `memory({op:'searchNext', compare:'eq', value})` — or `compare:'gt'|'lt'|'changed'|'unchanged'|
   'inc'|'dec'` when you don't know the new value. The relative compares work as the
   FIRST narrow too (baselines are recorded at seed). Repeat until a handful remain.
3. Confirm: `memory({op:'write'})` the candidate and watch the screen react.

This is the Cheat-Engine/RetroArch loop. It is THE bread-and-butter primitive.

**Don't know the value? (lives/timer/ammo not on the HUD)** Use the
unknown-initial-value hunt: `memory({op:'searchUnknown', region, size})` seeds
the WHOLE region with no value, then narrow across events with
`searchNext({compare:'dec'|'inc'|'unchanged'|'changed'|'gt'|'lt'})` — e.g.
`searchUnknown` → lose a life → `searchNext({compare:'dec'})` → repeat until 1–2
remain. `op:'search'` needs a value; `op:'searchUnknown'` is for when you can't
see the number.

**Stored ≠ displayed.** When a correct-looking seed returns 0, the byte usually isn't the
raw number: seed `as:'bcd'` for packed-BCD scores (2 decimal digits per byte — very common
on NES), or `as:'digits'` for one byte per ON-SCREEN digit at any constant tile base (HUD
tile-index buffers; the matched base is reported per candidate, and `searchNext` keeps
comparing in the same representation). For displayed−1 lives or ÷10 scores, just seed the
transformed number. If an INPUT drives the value (position, velocity, charge), skip the
loop entirely: `memory({op:'diffRuns', portsA:[{right:true}]})` isolates it in one call.

`memory({op:'snapshot'})` + `memory({op:'diff'})` is for "which bytes did THIS one event touch?",
not for value hunting. `memory({op:'diff'})` defaults to a **clustered summary** (ranges +
stride) so it won't flood you — a reported stride (e.g. "islands at 0x80") is
usually a struct/entity array, each island one record. Small clusters (≤8 bytes) carry
`before`/`after` hex inline, and `minDelta:N` drops |after−before| < N so RNG/counter
wiggle disappears from the report. For the locate-value-via-diff case, predicate
filters cut a 500-byte death-window diff to the ~3 rows you want in one call:
`changeDir:'dec'|'inc'` (direction), `deltaEq:N` (signed exact delta — `deltaEq:-1`
= "lost one life"), and `beforeMin/Max` + `afterMin/Max` (value-range gates, e.g.
`beforeMax:9` = a small counter, not a coordinate). `outputPath` writes the full
diff JSON to your path regardless of size (`echo:false` returns just the
counts+path so a big diff never streams through context).

**"Which byte does this INPUT drive?" → `memory({op:'diffRuns'})`** — runs the same start
state twice (savestate restore in between) under two different held inputs (`portsA` vs
`portsB`, default released) for `frames` each, and returns only the bytes that DIVERGE
between the runs, with run-A/run-B values on small clusters. One call replaces the whole
save → hold → step → dump → restore → hold-other → dump → diff loop; the frame counter and
all input-independent churn cancel out automatically. (The emulator is left at the end of
run B.)

---

## 2. To change on-screen TEXT — first find out where it comes from

The #1 trap: visible names/labels are often **pre-rendered tile GRAPHICS**, not
font-rendered from an ASCII string. Patching the ASCII string then does nothing.

1. `text({op:'learn'})` on the on-screen text — it infers the game's char→tile-ID map
   (games use their own encoding: Excitebike A=$0A, Mario ASCII-offset, FF sparse). Two
   modes: ROM mode `knownStrings:[{text, offset}]` when you found the bytes; **LIVE mode
   `fromScreen:[{text, row, col}]`** reads the tile IDs straight off the live BG map at a
   tile position (`background({view:'map'})` shows where the text sits) — this breaks the
   chicken-and-egg of needing the offset you're still hunting. Live mode works on every
   tilemap platform (NES/SNES/Genesis/GB/GBC/SMS/GG/C64); atari2600/7800, lynx, gba have
   no text nametable → ROM mode only. If `learn` reports `likelyPreRenderedGraphic:true`
   (unique sequential tiles, no font reuse), **stop** — the text is a bitmap. Editing it
   means changing tile pixels, not a string. Do not patch any ASCII string you found.
2. If it IS font-rendered: `text({op:'find', romPath, text, fontMap})` locates the string
   (returns `fileOffset`, `prgFileOffset`, and a bank-aware `cpuAddress`+`bank` to feed
   `disasm({target:'rom'})`; flags a likely length-prefix byte to avoid the overrun trap),
   then `text({op:'encode', text, fontMap})` → bytes for `romPatch({op:'write'})`.
3. To find where a graphic/text was sourced from: on **Genesis**, `watch({on:'dma', precision:'sampled'})`
   — drive to the screen that shows the graphic, and it reports the ROM offset(s)
   the tiles were DMA'd from (decoded from the VDP DMA registers). Edit the tile
   bitmaps at that offset, not any string. (Elsewhere: if `breakpoint({on:'write'})` on the VRAM
   destination reports no per-byte write, the tiles were bulk-copied/DMA'd from
   ROM; the SOURCE is what you patch — see §4/§5.)

---

## 3. Before trusting a "found table", classify it

The taunt-string trap: bytes 82/79/68 looked like a stat table but were the
ASCII `"ROD"` inside `"FROM DOWNTOWN"`. A coincidence will ship a broken patch.

`memory({op:'classify', region, offset, length})` →
`ascii-text | high-entropy | sparse-or-tiledata | structured-data | unknown`
with printableRatio/entropy. If it says **ascii-text**, your "table" is probably
a string — find a terminator / font map before treating the bytes as values.

---

## 4. To confirm a patch is actually live, read the cart ROM

`memory({op:'readCart', offset, length})` reads the loaded program image. For un-banked
platforms (Genesis/Mega Drive, GB/GBC, SMS/GG, PCE, Lynx) the **file offset IS
the CPU ROM address** — `memory({op:'readCart', offset:0x21FF00})` answers "does the
running ROM have my bytes at 0x21FF00?" in one call. (NES/SNES: bytes are
correct but mapper-banked — `mapped:true` in the response.) For a BANKED CPU
address, read it directly: `memory({op:'readCart', cpuAddress:0x8654, bank:6})`
maps the bank→PRG offset for you (NES/SNES) — the inverse of the breakpoint
result's bank/prgOffset, so you stop hand-computing `cpuAddr−0x8000+bank*0x4000`.
A NES `$C000+` address resolves to the fixed top bank automatically.

When a write "doesn't show up", check the ROM here before assuming the patch
failed — it's usually live and the bug is elsewhere (wrong source, see §2/§5).

Patch with `romPatch({op:'write'})`/`romPatch({op:'writeMany'})` and **always pass `expect`** (the current
bytes) — it catches a hex/dec or wrong-offset mistake before you corrupt the ROM.

---

## 5. To find where a byte is written (or why it isn't)

`breakpoint({on:'write', address})` captures the exact instruction that writes an address.
If it returns `found:false` even after driving the game, the region is likely
**rebuilt as a block** (sprite/OAM shadow, display list, VRAM) — copied/DMA'd
from a SOURCE struct rather than written in place. Don't conclude "the address
is wrong." Find the source: `memory({op:'search'})` the live value to locate the struct
the copy reads from, then `breakpoint({on:'write'})` on THAT.

**Precision — exact vs sampled.** The default `breakpoint({on:'write'})` is a core-level write
watchpoint: it returns the EXACT writing instruction's PC, captured inside the CPU write
path — correct even for NMI/IRQ-driven writes (the common case where a frame-sampled PC
is just the idle loop). On ALL 14 platforms, every hit (write/read/pc) also carries
**`registersAtHit`** — the full register file frozen AT the hit instant — and the CPU
stays FROZEN until the hit is cleared. Use registersAtHit instead of a follow-up
`cpu({op:'read'})`: pre-0.28.0 the live registers kept running after a hit (on gpgx they
drifted hundreds of instructions — address registers read that way were someone else's
values). On a banked mapper it reports the `bank` (NES/GB/SMS-GG) so you
can pass `{startAddress, bank}` to `disasm({target:'rom'})`. The lighter
`breakpoint({on:'write', precision:'sampled'})` (a.k.a. `watch({on:'mem'})`) steps until the byte changes
and returns a frame-boundary PC — a lead, not a guarantee under interrupts; use it for the
value timeline or when you just want the change history, and cross-check the value trace.

**Stop on the MEANINGFUL write, not the churn.** `breakpoint({on:'write'})` runs
to END OF FRAME and reports the LAST matching write that frame (with `hits` =
the count of all matching writes) — so a frequent **restoring** write (a pointer-
arithmetic `inc`/`dec` that touches the byte every frame, a re-arm) can mask the
write you actually want. Filter to the real change with `condition` (all 14
platforms): `condition:'decrease'` / `'increase'` stop only when the stored byte
actually went down/up (a real lives−1, not a restore), and `condition:'equals',
conditionValue:N` stops on the byte becoming N (e.g. a $00→$01 respawn re-arm).
The hit then reports `oldValueByte`→`valueByte` so you see the exact transition.
This is the difference between pinning a genuine decrement instantly and chasing
net-zero restoring churn.

---

## 5b. To READ a register at an instruction — execution breakpoints (all 14)

When the value you want is computed in a register (not a flat table) — e.g. a
decoder does `move.b (a0),d0` and `a0` holds the source pointer — stop the CPU
AT that instruction and read the register. This is the "infer for hours → read
the answer in 3 calls" move:

```
breakpoint({on:'write', address})         → a real, instruction-aligned PC (or use a
                                   disasm label / breakpoint({on:'read'}) as the anchor)
breakpoint({on:'pc', address: thatPC})    → CPU FROZEN exactly at the instruction
cpu({op:'read', platform})       → registers.A0 (etc.) — the live value you need
memory({op:'readCart'}) / memory({op:'read'}) at [A0] → follow the pointer
```

Companion tools (all 14 platforms; feature-detect, `notSupported` if a core
lacks a hook):
- **`breakpoint({on:'read', address})`** — the read-side mirror of `breakpoint({on:'write'})`: the EXACT
  instruction that READ an address (who *consumes* a value). Use it to anchor on
  a known data byte and find its reader.
- **`frame({op:'stepInstruction'})`** — CPU single-step; pair with `cpu({op:'read'})` to watch
  registers change one instruction at a time through a routine.
- **`cpu({op:'setReg', regId, value})`** — write a CPU register (inverse of `cpu({op:'read'})`;
  for setting up a `cpu({op:'call'})` by hand or forcing a path).

Also: a breakpoint PC is a **guaranteed instruction boundary** — feed it to
`disasm({target:'rom', startAddress})` to avoid the mid-instruction-garbage trap.

---

## 5c. Compressed assets — drive the ROM's OWN decompressor (the codec wall)

When a name/portrait/map is **LZ/RLE-compressed** (you proved the on-screen bytes
aren't a flat table — `breakpoint({on:'read'})` on the suspected pool got 0 hits), don't
reimplement the codec. Find the game's decompressor (trace a DMA/copy back to it,
or `watch({on:'pc'})`/`breakpoint({on:'read'})` near the asset), then RUN it:

```
cpu({op:'decompress', entryPC, sourceAddress, destAddress })  → runs the codec
memory({op:'read'}) at destAddress                       → the decompressed bytes
```

Or the general form for any reg-args routine — `cpu({op:'call', pc, regs})` sets
the registers (m68k 8=A0, 9=A1, 0=D0; per-CPU reg-ids in `cpu({op:'setReg'})`'s docs),
pushes a sentinel return, and runs until it returns. Most of these formats have a
"stored/uncompressed" escape opcode, so once you can SEE the decompressed output
you can usually craft a replacement by hand. (sandbox:false leaves the dest buffer
live for `memory({op:'read'})`; sandbox:true restores the game untouched.)

**Pass `pure:true` — on every platform.** A non-pure call that spans frames runs the
game's OWN frame logic concurrently (VBlank handlers via RAM vectors, music
drivers) — which can overwrite the dest buffer mid-call and hand you poisoned
"ground truth" (a real session spent hours diffing a CORRECT reimplementation
against it). With `pure:true` the game's handlers CANNOT run: Genesis/SMS/GG step
only the CPU (`pureMode:'cpu-only'`); everywhere else interrupt DELIVERY is
suppressed for the duration (`'irq-blocked'` — pending lines stay pending, video
advances harmlessly); the 2600 has no interrupts (`'no-interrupts'`). Non-pure
results carry a ⚠ caveat whenever frame logic ran.

## 5e. Re-inject an edited asset — the round-trip (don't reimplement the compressor)

Once you can SEE the decompressed bytes (5c) and you've edited them, put them BACK
in a form the game accepts — without writing an encoder:

```
romPatch({ op:'makeStored', platform, rawHex, format })  → bytes the game's OWN decompressor
                                                            expands VERBATIM (literal/raw escape)
romPatch({ op:'findFree', path })                        → an unused $FF/$00 run to write into
romPatch({ op:'relocate', path, newHex, toOffset,        → write the block to free space AND
           pointerOffset })                                repoint the loader's pointer at it
romPatch({ op:'findPointer', path, romOffset })          → find that pointer in the first place
```

- **`romPatch({op:'makeStored'})`** uses the format's stored/literal escape: GBA BIOS LZ77,
  SNES LC_LZ2 (direct-copy), SMS/MSX RLE, NES PackBits, or `raw` (no wrapper) for
  the many systems that store graphics uncompressed (Lynx/2600/7800, often PCE,
  NES CHR-ROM). It honestly REFUSES Nemesis (Genesis Huffman) and C64 crunchers —
  those have no hand-authorable stored block; decompress→edit→re-crunch instead.
  Kosinski is offered but EXPERIMENTAL — always verify.
- **Verify the stored block** by running the game's own decompressor on it with
  `cpu({op:'call', pc: codecEntryPC, regs: { A0: yourBlockAddr, A1: destAddr }})`
  and comparing the output to your payload. (This is exactly the 5c step in reverse;
  it's how you confirm the format guess before you ship the patch.)
- **`romPatch({op:'findPointer'})`** computes the platform-correct pointer encoding (Genesis 32-bit
  BE = ROM offset; SNES 16/24-bit LE via LoROM/HiROM; GBA 0x08000000+offset; banked
  8-bit 16-bit-LE CPU addresses) and scans the ROM. On the multi-width systems
  (Genesis/SNES) the narrower form's byte-shadow of a wider hit is suppressed by
  default (`shadowsSuppressed` in the result) — pass `suppressShadows:false` for raw
  or `widths:[4]` to search only the widest form. On banked systems a 16-bit hit is
  page-ambiguous — pair it with the nearby bank-set instruction.
- **`romPatch({op:'relocate'})`** with `dryRun:true` previews the writes before touching the file.
  The safe move when your edit changed size (can't fit in place).

## 5d. Find the UNKNOWN routine — discovery (the other half)

Breakpoints are great once you KNOW the address. To FIND it:
- **`watch({on:'range', start, end, kind})`** — log EVERY `{pc,address,value}` that reads
  or writes anywhere in a range (not stop-on-first). Watch the whole name pool / a
  struct / a flag region and SEE every PC that touches it, instead of probing single
  addresses. `distinctPCs` is the actionable summary.
- **`watch({on:'pc', start, end, frames})`** — coverage trace: every DISTINCT PC that
  EXECUTED in an address window. "What code runs in this bank during the scoreboard
  draw?" → `disasm({target:'rom'})` the PCs it returns.
- **`watch({on:'dma', precision:'exact', vramDest})`** (Genesis) — which DMA wrote the tile at a VRAM dest,
  and the ROM SOURCE it came from. The targeted version of `watch({on:'dma', precision:'sampled'})`; the
  way to catch a DMA'd (not CPU-written) name/portrait bitmap `breakpoint({on:'write'})` can't see.

---

## 6. Driving menus (the real wall-clock sink)

Use `input({op:'navigate', steps:[{button, maxWaitFrames}]})` — it advances on **screen
change**, not fixed frames, and reports per step whether the press was
`consumed` (the screen reacted). `consumed:false` = the press didn't land
(wrong screen / dropped / game polls input on a specific frame) — re-run it or
hold longer. This is 5-10x faster than the press→step→screenshot loop.

For a long/flaky path: reach a known screen once, `state({op:'save', path})`, then
`state({op:'load'})` to retry the next leg deterministically instead of re-driving the
whole attract sequence each time. `input({op:'set'})`'s `requested` echo is what you SET,
not proof the pad saw it — verify via the held-buttons RAM byte or a state
transition.

## 6b. Iterative measurement — boot to gameplay ONCE, reload per run

When you run many measurements on the same starting state (frame-by-frame
velocity tables, per-input timing, A/B trials), do NOT replay the
`loadMedia → step to title → press start → step into the level` preamble every
time — that intro is often hundreds of frames and 4+ calls, and you pay it on
every iteration. Boot once, snapshot, and reload the snapshot per run:

```
loadMedia({platform, path, cheats})         // cheats survive the save state
frame({op:'step', frames:180})              // title renders
input({op:'press', button:'start'})
frame({op:'step', frames:300})              // into gameplay
state({op:'save', name:'ready'})            // <-- the reusable starting point

// then per measurement:
state({op:'load', name:'ready'})            // 1 call instead of the whole boot
... drive + watch ...
```

A save state captures applied cheats and the exact RAM/PPU state, so every run
starts byte-identical — *more* repeatable than re-booting, not just cheaper. A
named slot (`name`) lives in memory for the session; a `path` persists to disk
across sessions. If a task says "restart before each run", a state reload
satisfies that intent far cheaper than a fresh `loadMedia`.

**Driving input through a watched run:** a `watch`/`breakpoint` with NO
`pressDuring` inherits whatever `input({op:'set'})` last held (same as
`frame({op:'step'})`). But if you pass `pressDuring`, that schedule OWNS the pad
for the whole run and a prior `input({op:'set'})` is ignored — so to hold a
button *through* a watched window, put it in `pressDuring`, not a preceding
`set`. (This is the documented contract; the schemas of `watch`/`breakpoint`
and `input({op:'set'})` state it too.)

---

## 7. Authoring & verifying the byte patch

Once you know WHAT to change, the write loop is a handful of calls — no custom scripts:

- **`assembleSnippet({cpu, origin, code})`** — assemble a tiny asm chunk to raw bytes (no
  header/linker/segments). CPUs: `6502 / 65c02 / 65816 / 68k / z80 / sm83 / gb / gbc /
  huc6280`. **Z80 gotcha:** the sdas dialect requires `#` on immediates (`ld a,#5`, not
  `ld a,5`).
- **`romPatch({op:'write', path, offset, hex, expect})`** — the splicer THE other hack tools
  compose through. **Always pass `expect`** (the current bytes) — it refuses the write if
  they don't match, catching a hex/dec slip or a patch authored against region A applied to
  region B. `allowExpand` for size-changing edits.
- **`romPatch({op:'diff', platform, a, b})`** — mapper-aware ROM diff: reports CPU addresses
  (NROM-128 mirrors, SNES LoROM `XX:XXXX`), per-region tallies (PRG vs CHR vs header), and
  `tile:N` annotations on CHR changes for direct sprite-hack identification. Use it to
  confirm a patch landed where you meant.
- **`disasm({target:'references', path, platform, address})`** — find every instruction that
  references a target address, classified `call/jump/branch/read/write/use/ref` (walks the
  vector table too). The fast "who touches this?" for a STATIC image. EVERY banked format
  is scanned PER BANK — NES mappers (refs carry `prgBank`), and SNES multi-bank LoROM,
  GB/GBC MBC, SMS/GG Sega-mapper, MSX megaROM, Atari 2600 F8/F6/F4, Atari 7800 SuperGame,
  and >32KB HuCards (refs carry `romBank`) — so a hit in bank 12 of a 128KB cart shows up,
  not just the first bank. Zero-page direct + indexed operands match, and `#$nn` immediates
  are excluded (values, not addresses). Limitation: direct addressing only —
  indirect/computed jumps aren't detected (use the runtime `watch`/`breakpoint` tools in
  §5/§5d for those).
- **`cart({op:'extract', path, outputDir})`** — split a ROM into standard parts (NES header/
  prg/chr; SNES copier_header+rom+internal header; Genesis vectors/header/body; GB boot/
  header/body) + a `manifest.json` (mapper, mirroring…). **`cart({op:'wrap'})`** is the inverse:
  emits `wrapperSource` + `linkerConfig` ready for `build({output:'rom'})`.

Verify-before-patch: `memory({op:'write', region:'system_ram', offset, hex})` on the LIVE emulator and
watch the screen react — cheaper than shipping a wrong ROM patch.

## 7b. Whole-ROM rebuildable disassembly — `disasm({target:'project'})`

For a STRUCTURAL hack (new logic, not a byte poke), turn the whole ROM into a
re-buildable project in one call: `disasm({target:'project', path, outputDir})`. It splits
the ROM into regions (per-bank on EVERY banked format: 16KB banks for NES/GB/SMS-GG/MSX/
7800-SuperGame, 32KB for SNES LoROM, 4KB for banked 2600, 8KB pages for >32KB HuCards;
one flat region for Genesis/C64/Lynx/GBA and small carts), disassembles each through the CPU's
native objdump, then **reassembles + verifies byte-exact** against the original; any line
that won't reproduce faithfully heals to a `.byte`/`db` of its real bytes, so the emitted
`.asm` ALWAYS rebuilds (`roundTrip.allByteExact`). `readablePercent` per region tells you
how much came back as real instructions vs. data. Alongside the `.asm` it writes the
turnkey **rebuild glue**: data blobs (NES CHR-ROM → `chr.bin`; stripped Genesis/GBA/Lynx/MSX
cartridge header → `*.bin`), a `BUILD.md` with the exact steps, and — where a one-call
rebuild exists — a `rebuild.json` of the precise `build({...})` args. So the loop is
`disasm({target:'project'})` → edit a `.asm` → rebuild → `romPatch({op:'diff'})` to confirm.

**Two rebuild tiers** (the disasm emits each CPU's native-reassembler syntax — ca65 for
6502/65816, GNU `as` for m68k/arm/z80/gbz80 — which only some `build()` toolchains consume):
- **One-call `build()` rebuild, byte-identical** — **NES (NROM *and* banked mappers), C64,
  Atari 7800 (flat *and* SuperGame banked), Lynx, PC Engine (flat *and* banked HuCards)**.
  Feed `rebuild.json` straight to `build`. Banked projects ship a HEADER segment with the
  original header bytes (16 iNES / 128 .a78 / 512 copier), per-bank segment wrappers, and a
  generated multi-bank `.cfg` referenced via `linkerConfigPath` (so the cfg never streams
  through context). (Lynx: `build()` yields the headerless image; prepend the shipped
  `lnx_header.bin` for the full `.lnx`.)
- **Native-recipe rebuild (`buildCall:null`), byte-identical, steps in `BUILD.md`** — **SMS,
  GG, MSX, GB, GBC, Genesis, GBA, Atari 2600**. Their `build()` toolchains (SDCC/RGBDS/asar/
  dasm/vasm) can't reassemble ca65/GNU-as syntax, so `BUILD.md` gives the proven native
  `as`/`ld`/`objcopy` chain — per-bank on banked carts (Sega-mapper SMS/GG, MSX megaROMs,
  banked 2600 get per-bank wrappers + cfg blobs and a bank-by-bank recipe).

**Rebuilding a commercial NES (NROM CHR-ROM) game — `build({inesHeader})`:** the most common
NES RE rebuild. `build({output:'rom', platform:'nes', inesHeader:{prgBanks, chrBanks, mapper,
mirroring}, sourcesPaths:{…the PRG…}, binaryIncludePaths:{"chr.bin":…}})` auto-emits the
16-byte iNES header + CHARS-segment wiring + flat NROM `.cfg` — no hand-derived header bytes.
`disasm({target:'project'})` puts exactly this call in `rebuild.json` for NROM; banked
mappers get the per-bank segment + multi-bank `.cfg` form instead (see the one-call tier
above). (For homebrew C that ships fixed tile art, `linkerConfig:"chr-rom"` is the
segment-split equivalent.)

**Readability caveats** (the bytes are ALWAYS correct; only instruction-vs-`.byte` coverage
varies): SNES and large Genesis ROMs come back byte-exact but DATA-ONLY (flat whole-ROM
disasm of a mostly-data image heals to `.byte` — meaningful coverage needs recursive
entry-point following, a known follow-up). GBA reads LOW because GBA C compiles mostly to
Thumb reached via an ARM crt0 stub, so an ARM-mode disasm decodes Thumb spans as `.byte`.
Banked-NES is the strongest case (~100% instructions); GB/GBC, SMS/GG, C64, Atari are also
near-100%.

## 8. Graphics swaps — PNG ↔ tiles round-trip

For sprite/tile edits (not text), don't hand-roll the tile-format math:

- **`tiles({op:'png', source:'path', platform, path, bank, paletteFromEmulator, paletteIndex})`** —
  a source ROM's tiles → PNG. `bank:N` (NES 4 KB CHR bank) replaces magic file-offset math;
  `paletteFromEmulator:true`+`paletteIndex` colors the export with the LIVE palette (vs
  grayscale) so the art is recognizable to edit.
- **`importArt({from:'rom', sourceRom, sourcePlatform, sourceBank, sourceTileX/Y/W/H, targetPlatform,
  outputPng, intent, paletteIndex})`** — one-call lift of a tile region from a source ROM into
  the target platform's format (extract+crop+quantize). `intent:"homebrew"` reads the live
  source palette; `intent:"rom-hack"` preserves source bytes verbatim.
- **`encodeArt({stage:'tiles', platform, pngBase64})`** → target-platform tile bytes.
- **`romPatch({op:'spliceCHR', path, platform, pngBase64, tileIndex, expect, bank, paletteHint})`** —
  PNG → tile bytes → splice into CHR at tile slot N (auto-locates iNES CHR base; `expect`
  checks the existing tile bytes; `paletteHint:["#RRGGBB",…]` gives explicit RGB→index
  mapping). Composes the `encodeArt`+`romPatch({op:'write'})` step in one call.
- **`background({view:'rendered'})`** — at the current state, the set of tile IDs actually drawn
  (BG nametable + OAM). Sample at title/gameplay/menu and diff the sets to map tile IDs to
  assets without scanning sheets by eye. (`romPatch({op:'findFree'})` locates $FF/$00 runs for asm
  overlays, longest-first.)

---

## Quick reference

| Goal | Tool |
|---|---|
| Find a value's address | `memory({op:'search'})` → `memory({op:'searchNext'})` (NOT full-RAM diff) |
| Which bytes did one event touch | `memory({op:'snapshot'})` → `memory({op:'diff'})` (summary) |
| Which byte does an INPUT drive | `memory({op:'diffRuns', portsA, portsB?})` (A/B divergence, one call) |
| Is on-screen text a string or a bitmap | `text({op:'learn'})` (reports pre-rendered graphic) |
| Is a "table" really ASCII/code | `memory({op:'classify'})` |
| Confirm a patch is in the running ROM | `memory({op:'readCart'})` |
| Where is this byte written / why not | `breakpoint({on:'write'})` (no write ⇒ source is bulk-copied) |
| Read a register AT an instruction | `breakpoint({on:'pc', address})` → freeze → `cpu({op:'read'})` |
| Which instruction READ a byte | `breakpoint({on:'read', address})` (read-side `breakpoint({on:'write'})`) |
| Single-step the CPU | `frame({op:'stepInstruction'})` (+ `cpu({op:'read'})` to watch regs) |
| Set a CPU register | `cpu({op:'setReg', regId, value})` |
| Decompress a compressed asset | `cpu({op:'decompress'})` / `cpu({op:'call', pure:true})` (run the ROM's own codec, interference-free) |
| Where does this on-screen graphic come from | `watch({on:'copy', start, end})` (all 14 — writer PC per VRAM write; Genesis DMA also via `watch({on:'dma'})`) |
| Re-inject edited bytes the game accepts | `romPatch({op:'makeStored'})` (verbatim-expand block) → `romPatch({op:'findFree'})` → `romPatch({op:'relocate'})` |
| Find the pointer that loads an asset | `romPatch({op:'findPointer', romOffset})` |
| FIND the unknown routine touching X | `watch({on:'range', start,end})` (all hits) / `watch({on:'pc'})` (coverage) |
| Which DMA wrote a VRAM tile + its source (Genesis) | `watch({on:'dma', precision:'exact', vramDest})` |
| Where did a VRAM graphic come from (Genesis) | `watch({on:'dma', precision:'sampled'})` (ROM offset of the DMA source) |
| Drive a menu fast | `input({op:'navigate'})` (advances on screen change) |
| Free RAM map for a known game | `cheats({op:'lookup'})` / `cheats({op:'search'})` |
| Apply a cheat live (non-destructive) | `cheats({op:'apply'})` (verify a label / fun) |
| Create a shareable code from a byte | `cheats({op:'make'})` (verified, all 14) |
| Read on-screen text's tile map | `text({op:'learn', fromScreen})` (live, no offset needed) |
| Find / encode a font-rendered string | `text({op:'find'})` → `text({op:'encode'})` |
| Assemble asm → raw patch bytes | `assembleSnippet({cpu, origin, code})` |
| Mapper-aware diff of two ROMs | `romPatch({op:'diff'})` (CPU addrs, CHR `tile:N`) |
| Who references this address (static) | `disasm({target:'references'})` (direct modes only) |
| Split / rebuild a ROM into parts | `cart({op:'extract'})` / `cart({op:'wrap'})` |
| Swap a sprite/tile (PNG round-trip) | `tiles({op:'png'})` → edit → `romPatch({op:'spliceCHR'})` |
| Lift art from another game's ROM | `importArt({from:'rom'})` |
| Tile IDs actually being drawn now | `background({view:'rendered'})` |
| Safe patch | `romPatch({op:'write'})`/`romPatch({op:'writeMany'})` with `expect` |
