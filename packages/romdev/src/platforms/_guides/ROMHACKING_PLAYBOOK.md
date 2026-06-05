# ROM-hacking playbook (cross-platform)

A decision tree for reverse-engineering and patching an existing ROM, distilled
from real sessions (the traps below cost hours each). Read this once before a
romhack; it tells you which tool to reach for at each fork so you don't thrash.

Cross-platform. For platform specifics (memory map, VDP/PPU, byte order) also
read that platform's `getPlatformDoc({platform, name:'mental_model'})`.

---

## 0. Orient first (one minute, saves an hour)

1. `identifyRom({path})` — name, platform, CRC, copier-header/zip handling.
2. `gameCheats({path})` — if the bundled DB has this game, the cheat list **is a
   free RAM map**: labeled addresses for lives/score/timer/stats. This is the
   single best head start. No match? `searchCheats({platform, query})` with a
   loose name (fuzzy) before assuming it's absent. Cheats are a STARTING point,
   not the whole job — combine with disassembly below.
3. `getMemoryMap({platform})` / the platform MENTAL_MODEL for the layout.

The cheat DB is bundled (`romdev_game_codes`). Do **not** scan the user's disk for
`.cht` files — if it's not in the bundled DB, treat it as absent and RE it.

---

## 1. To find the RAM address of a value (score / timer / stat / HP / record-id)

Use the iterative value search — **not** a full-RAM diff (gameplay churns
thousands of bytes and you'll drown).

1. `searchValue({value, size, region})` — seed candidates equal to the current
   on-screen value. `region` defaults to `system_ram`.
2. Change the value in-game (take damage, score a point), then
   `searchNext({op:'eq', value})` — or `op:'gt'|'lt'|'changed'|'unchanged'|
   'inc'|'dec'` when you don't know the new value. Repeat until a handful remain.
3. Confirm: `writeMemory` the candidate and watch the screen react.

This is the Cheat-Engine/RetroArch loop. It is THE bread-and-butter primitive.

`snapshotMemory` + `diffMemory` is for "which bytes did THIS one event touch?",
not for value hunting. `diffMemory` defaults to a **clustered summary** (ranges +
stride) so it won't flood you — a reported stride (e.g. "islands at 0x80") is
usually a struct/entity array, each island one record.

---

## 2. To change on-screen TEXT — first find out where it comes from

The #1 trap: visible names/labels are often **pre-rendered tile GRAPHICS**, not
font-rendered from an ASCII string. Patching the ASCII string then does nothing.

1. `learnFontMap` on the on-screen text. If it reports
   `likelyPreRenderedGraphic:true` (unique sequential tiles, no font reuse),
   **stop** — the text is a bitmap. Editing it means changing tile pixels, not a
   string. Do not patch any ASCII string you found; it isn't the source.
2. If it IS font-rendered, find the string with `findEncodedText` /
   `encodeTextForRom` and patch that.
3. To find where a graphic/text was sourced from: on **Genesis**, `traceVramSource`
   — drive to the screen that shows the graphic, and it reports the ROM offset(s)
   the tiles were DMA'd from (decoded from the VDP DMA registers). Edit the tile
   bitmaps at that offset, not any string. (Elsewhere: if `findWriter` on the VRAM
   destination reports no per-byte write, the tiles were bulk-copied/DMA'd from
   ROM; the SOURCE is what you patch — see §4/§5.)

---

## 3. Before trusting a "found table", classify it

The taunt-string trap: bytes 82/79/68 looked like a stat table but were the
ASCII `"ROD"` inside `"FROM DOWNTOWN"`. A coincidence will ship a broken patch.

`classifyRegion({region, offset, length})` →
`ascii-text | high-entropy | sparse-or-tiledata | structured-data | unknown`
with printableRatio/entropy. If it says **ascii-text**, your "table" is probably
a string — find a terminator / font map before treating the bytes as values.

---

## 4. To confirm a patch is actually live, read the cart ROM

`readCartRom({offset, length})` reads the loaded program image. For un-banked
platforms (Genesis/Mega Drive, GB/GBC, SMS/GG, PCE, Lynx) the **file offset IS
the CPU ROM address** — `readCartRom({offset:0x21FF00})` answers "does the
running ROM have my bytes at 0x21FF00?" in one call. (NES/SNES: bytes are
correct but mapper-banked — `mapped:true` in the response; map a CPU PC→offset
via `findWriter`'s prgOffset/bank.)

When a write "doesn't show up", check the ROM here before assuming the patch
failed — it's usually live and the bug is elsewhere (wrong source, see §2/§5).

Patch with `patchFile`/`patchRom` and **always pass `expect`** (the current
bytes) — it catches a hex/dec or wrong-offset mistake before you corrupt the ROM.

---

## 5. To find where a byte is written (or why it isn't)

`findWriter({address})` captures the exact instruction that writes an address.
If it returns `found:false` even after driving the game, the region is likely
**rebuilt as a block** (sprite/OAM shadow, display list, VRAM) — copied/DMA'd
from a SOURCE struct rather than written in place. Don't conclude "the address
is wrong." Find the source: `searchValue` the live value to locate the struct
the copy reads from, then `findWriter` on THAT.

---

## 5b. To READ a register at an instruction — execution breakpoints (all 14)

When the value you want is computed in a register (not a flat table) — e.g. a
decoder does `move.b (a0),d0` and `a0` holds the source pointer — stop the CPU
AT that instruction and read the register. This is the "infer for hours → read
the answer in 3 calls" move:

```
findWriter({address})            → a real, instruction-aligned PC (or use a
                                   disasm label / runUntilRead as the anchor)
runUntilPC({address: thatPC})    → CPU FROZEN exactly at the instruction
getCPUState({platform})          → registers.A0 (etc.) — the live value you need
readCartRom / readMemory at [A0] → follow the pointer
```

Companion tools (all 14 platforms; feature-detect, `notSupported` if a core
lacks it — only PC Engine, which has no findWriter, but its breakpoints work):
- **`runUntilRead({address})`** — the read-side mirror of findWriter: the EXACT
  instruction that READ an address (who *consumes* a value). Use it to anchor on
  a known data byte and find its reader.
- **`stepInstruction()`** — CPU single-step; pair with `getCPUState` to watch
  registers change one instruction at a time through a routine.

Also: a breakpoint PC is a **guaranteed instruction boundary** — feed it to
`disassembleRom({startAddress})` to avoid the mid-instruction-garbage trap.

---

## 6. Driving menus (the real wall-clock sink)

Use `navigate({steps:[{button, maxWaitFrames}]})` — it advances on **screen
change**, not fixed frames, and reports per step whether the press was
`consumed` (the screen reacted). `consumed:false` = the press didn't land
(wrong screen / dropped / game polls input on a specific frame) — re-run it or
hold longer. This is 5-10x faster than the press→step→screenshot loop.

For a long/flaky path: reach a known screen once, `saveState({path})`, then
`loadState` to retry the next leg deterministically instead of re-driving the
whole attract sequence each time. `setInput`'s `requested` echo is what you SET,
not proof the pad saw it — verify via the held-buttons RAM byte or a state
transition.

---

## Quick reference

| Goal | Tool |
|---|---|
| Find a value's address | `searchValue` → `searchNext` (NOT full-RAM diff) |
| Which bytes did one event touch | `snapshotMemory` → `diffMemory` (summary) |
| Is on-screen text a string or a bitmap | `learnFontMap` (reports pre-rendered graphic) |
| Is a "table" really ASCII/code | `classifyRegion` |
| Confirm a patch is in the running ROM | `readCartRom` |
| Where is this byte written / why not | `findWriter` (no write ⇒ source is bulk-copied) |
| Read a register AT an instruction | `runUntilPC({address})` → freeze → `getCPUState` |
| Which instruction READ a byte | `runUntilRead({address})` (read-side findWriter) |
| Single-step the CPU | `stepInstruction` (+ `getCPUState` to watch regs) |
| Where did a VRAM graphic come from (Genesis) | `traceVramSource` (ROM offset of the DMA source) |
| Drive a menu fast | `navigate` (advances on screen change) |
| Free RAM map for a known game | `gameCheats` / `searchCheats` |
| Safe patch | `patchFile`/`patchRom` with `expect` |
