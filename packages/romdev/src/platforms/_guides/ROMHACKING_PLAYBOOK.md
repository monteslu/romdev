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

---

## 1. To find the RAM address of a value (score / timer / stat / HP / record-id)

Use the iterative value search — **not** a full-RAM diff (gameplay churns
thousands of bytes and you'll drown).

1. `memory({op:'search', value, size, region})` — seed candidates equal to the current
   on-screen value. `region` defaults to `system_ram`.
2. Change the value in-game (take damage, score a point), then
   `memory({op:'searchNext', compare:'eq', value})` — or `compare:'gt'|'lt'|'changed'|'unchanged'|
   'inc'|'dec'` when you don't know the new value. Repeat until a handful remain.
3. Confirm: `memory({op:'write'})` the candidate and watch the screen react.

This is the Cheat-Engine/RetroArch loop. It is THE bread-and-butter primitive.

`memory({op:'snapshot'})` + `memory({op:'diff'})` is for "which bytes did THIS one event touch?",
not for value hunting. `memory({op:'diff'})` defaults to a **clustered summary** (ranges +
stride) so it won't flood you — a reported stride (e.g. "islands at 0x80") is
usually a struct/entity array, each island one record.

---

## 2. To change on-screen TEXT — first find out where it comes from

The #1 trap: visible names/labels are often **pre-rendered tile GRAPHICS**, not
font-rendered from an ASCII string. Patching the ASCII string then does nothing.

1. `text({op:'learn'})` on the on-screen text. If it reports
   `likelyPreRenderedGraphic:true` (unique sequential tiles, no font reuse),
   **stop** — the text is a bitmap. Editing it means changing tile pixels, not a
   string. Do not patch any ASCII string you found; it isn't the source.
2. If it IS font-rendered, find the string with `text({op:'find'})` /
   `text({op:'encode'})` and patch that.
3. To find where a graphic/text was sourced from: on **Genesis**, `dmaTrace({precision:'sampled'})`
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
correct but mapper-banked — `mapped:true` in the response; map a CPU PC→offset
via `breakpoint({on:'write'})`'s prgOffset/bank.)

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
lacks a hook):
- **`breakpoint({on:'read', address})`** — the read-side mirror of findWriter: the EXACT
  instruction that READ an address (who *consumes* a value). Use it to anchor on
  a known data byte and find its reader.
- **`frame({op:'stepInstruction'})`** — CPU single-step; pair with `cpu({op:'read'})` to watch
  registers change one instruction at a time through a routine.
- **`cpu({op:'setReg', regId, value})`** — write a CPU register (inverse of getCPUState;
  for setting up a callSubroutine by hand or forcing a path).

Also: a breakpoint PC is a **guaranteed instruction boundary** — feed it to
`disasm({target:'rom', startAddress})` to avoid the mid-instruction-garbage trap.

---

## 5c. Compressed assets — drive the ROM's OWN decompressor (the codec wall)

When a name/portrait/map is **LZ/RLE-compressed** (you proved the on-screen bytes
aren't a flat table — `breakpoint({on:'read'})` on the suspected pool got 0 hits), don't
reimplement the codec. Find the game's decompressor (trace a DMA/copy back to it,
or `watch({on:'pc'})`/`breakpoint({on:'read'})` near the asset), then RUN it:

```
decompressWith({ entryPC, sourceAddress, destAddress })  → runs the codec
readMemory at destAddress                                → the decompressed bytes
```

Or the general form for any reg-args routine — `cpu({op:'call', pc, regs})` sets
the registers (m68k 8=A0, 9=A1, 0=D0; per-CPU reg-ids in `cpu({op:'setReg'})`'s docs),
pushes a sentinel return, and runs until it returns. Most of these formats have a
"stored/uncompressed" escape opcode, so once you can SEE the decompressed output
you can usually craft a replacement by hand. (sandbox:false leaves the dest buffer
live for readMemory; sandbox:true restores the game untouched.)

## 5e. Re-inject an edited asset — the round-trip (don't reimplement the compressor)

Once you can SEE the decompressed bytes (5c) and you've edited them, put them BACK
in a form the game accepts — without writing an encoder:

```
makeStoredBlock({ platform, rawHex, format })  → bytes the game's OWN decompressor
                                                  expands VERBATIM (literal/raw escape)
findFreeSpace({ path })                        → an unused $FF/$00 run to write into
relocateBlock({ path, newHex, toOffset,        → write the block to free space AND
               pointerOffset })                  repoint the loader's pointer at it
findPointerTo({ path, romOffset })             → find that pointer in the first place
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
  8-bit 16-bit-LE CPU addresses) and scans the ROM. On banked systems a 16-bit hit
  is page-ambiguous — pair it with the nearby bank-set instruction.
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
  draw?" → disassembleRom the PCs it returns.
- **`dmaTrace({precision:'exact', vramDest})`** (Genesis) — which DMA wrote the tile at a VRAM dest,
  and the ROM SOURCE it came from. The targeted version of `dmaTrace({precision:'sampled'})`; the
  way to catch a DMA'd (not CPU-written) name/portrait bitmap `breakpoint({on:'write'})` can't see.

---

## 6. Driving menus (the real wall-clock sink)

Use `navigate({steps:[{button, maxWaitFrames}]})` — it advances on **screen
change**, not fixed frames, and reports per step whether the press was
`consumed` (the screen reacted). `consumed:false` = the press didn't land
(wrong screen / dropped / game polls input on a specific frame) — re-run it or
hold longer. This is 5-10x faster than the press→step→screenshot loop.

For a long/flaky path: reach a known screen once, `state({op:'save', path})`, then
`state({op:'load'})` to retry the next leg deterministically instead of re-driving the
whole attract sequence each time. `input({op:'set'})`'s `requested` echo is what you SET,
not proof the pad saw it — verify via the held-buttons RAM byte or a state
transition.

---

## Quick reference

| Goal | Tool |
|---|---|
| Find a value's address | `memory({op:'search'})` → `memory({op:'searchNext'})` (NOT full-RAM diff) |
| Which bytes did one event touch | `memory({op:'snapshot'})` → `memory({op:'diff'})` (summary) |
| Is on-screen text a string or a bitmap | `text({op:'learn'})` (reports pre-rendered graphic) |
| Is a "table" really ASCII/code | `memory({op:'classify'})` |
| Confirm a patch is in the running ROM | `memory({op:'readCart'})` |
| Where is this byte written / why not | `breakpoint({on:'write'})` (no write ⇒ source is bulk-copied) |
| Read a register AT an instruction | `breakpoint({on:'pc', address})` → freeze → `cpu({op:'read'})` |
| Which instruction READ a byte | `breakpoint({on:'read', address})` (read-side findWriter) |
| Single-step the CPU | `frame({op:'stepInstruction'})` (+ `cpu({op:'read'})` to watch regs) |
| Set a CPU register | `cpu({op:'setReg', regId, value})` |
| Decompress a compressed asset | `cpu({op:'decompress'})` / `cpu({op:'call'})` (run the ROM's own codec) |
| Re-inject edited bytes the game accepts | `romPatch({op:'makeStored'})` (verbatim-expand block) → `romPatch({op:'findFree'})` → `romPatch({op:'relocate'})` |
| Find the pointer that loads an asset | `romPatch({op:'findPointer', romOffset})` |
| FIND the unknown routine touching X | `watch({on:'range', start,end})` (all hits) / `watch({on:'pc'})` (coverage) |
| Which DMA wrote a VRAM tile + its source (Genesis) | `dmaTrace({precision:'exact', vramDest})` |
| Where did a VRAM graphic come from (Genesis) | `dmaTrace({precision:'sampled'})` (ROM offset of the DMA source) |
| Drive a menu fast | `navigate` (advances on screen change) |
| Free RAM map for a known game | `cheats({op:'lookup'})` / `cheats({op:'search'})` |
| Safe patch | `romPatch({op:'write'})`/`romPatch({op:'writeMany'})` with `expect` |
