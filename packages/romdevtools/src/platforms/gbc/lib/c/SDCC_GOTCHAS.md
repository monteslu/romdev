# SDCC sm83 / z80 — known gotchas

> **2026-05-25: The big one — `dbuf_append_str(NULL)` crashes — is FIXED.**
>
> What was reported across many sessions as "SDCC sm83 register
> allocator crash on for-loops with function calls", patterns #37/#38/#39,
> the entire #1..#10 family — none of that was an SDCC codegen bug.
> The WASM build's default 64KB stack was overflowing past `__data_end`
> into the static `sm83_regs[]` table, zeroing out the register-name
> pointers, which then propagated to `aopGet → dbuf_append_str(NULL)`.
>
> Fix: `-s STACK_SIZE=8388608` (8 MB) in the emscripten link flags.
> Now compiles for-loops, parallel array writes, function calls in
> loops, nested ifs, multi-array indexed reads, etc. — every previously
> documented "crash pattern" — without complaint.
>
> The `unroll.h` macros are still around if you find a case that needs
> them, but you almost certainly don't.

What's left in this doc:

1. C89-only — SDCC's parser doesn't accept C99 (mid-block decls, etc.)
2. Generic "if you find a new crash" workflow.

## SDCC sm83 is C89

SDCC's sm83 frontend is **C89 only**. None of these work:

```c
/* WRONG — C99 features SDCC rejects */
for (int i = 0; i < 10; i++) { ... }    // inline-declared loop counter
int x = 5;                              // mid-block declarations
{ ... ; int y = ...; }                  // declarations after code

struct foo p = (struct foo){ .x = 1 };  // compound literals
struct foo p = { .x = 1, .y = 2 };      // designated initializers
// single-line comments after non-comment code on same line
```

```c
/* RIGHT — C89 form everything must use */
int i;
for (i = 0; i < 10; i++) { ... }        // declare i above

{
  int x;
  int y;
  x = 5;
  /* ... code here ... */
  y = something();                       /* declarations at TOP only */
}

struct foo p;                           /* declare, then assign */
p.x = 1;
p.y = 2;
```

**Misleading SDCC error message:** when you have a mid-block decl, SDCC
reports the syntax error pointing at the line AFTER the offense:

```
/work/main.c:42: syntax error: token -> 'base' ; column 10
```

Line 42 looks fine. The real problem is **the FIRST declaration that
follows a non-declaration statement** somewhere earlier in the block.
Scan backwards from the reported line for code-then-decl mixing.

The pre-flight linter (`src/toolchains/sdcc/preflight-lint.js`) catches
mid-block decls with the correct file:line before SDCC runs.

## Found a new crash?

If you hit a build failure that isn't C89-related and isn't an obvious
extern undefined / typo:

1. Bisect by deleting code chunks (halve the file, repeat).
2. Reduce to a minimal 4–10 line repro.
3. Capture the exact SDCC error message + the .i (preprocessed) input.
4. Open an issue with the repro at https://github.com/monteslu/romdev/issues
   so we can investigate. **Don't paper over it with workarounds** — with the
   stack-overflow fix in place, real codegen bugs are much rarer and
   each one is worth chasing to root cause.

## Writes to VRAM / OAM / I/O regs need `volatile` (or use the bundled helpers)

SDCC's sm83 optimizer treats a write-only loop to an unanalyzable
absolute address (a raw `(uint8_t*)0x8000` cast) as dead code and may
elide the stores entirely. Pattern that bites:

```c
uint8_t *dst = (uint8_t *)0x8000;     // VRAM
for (uint8_t i = 0; i < 16; i++) dst[i] = tile_data[i];
// ↑ may compile to literally nothing. VRAM stays empty.
```

The bundled `memcpy_vram(dst, src, n)` in `gb_runtime.c` works because
it walks the source/dest as plain `uint8_t *` parameters (which SDCC
can't prove are dead). The bundled `gb_hardware.h` declares every
hardware register as `volatile`-typed via `__sfr __at 0xFFNN`, so
direct writes like `BGP = 0xE4;` are fine.

If you need to write a custom VRAM block-copy:
- **Use `memcpy_vram(dst, src, n)` from `gb_runtime.h`** (recommended).
- **OR** cast the destination through `volatile`:
  `volatile uint8_t *dst = (volatile uint8_t *)0x8000;` — the
  `volatile` qualifier disables the dead-store optimization.
- **OR** mark the writes as side-effecting another way (e.g. read
  the value back). This is fragile.

This is independent of the R26 OAM-alignment fix (`shadow_oam __at
(0xC100)`) and the header CGB-flag fix (now applied automatically by
`build({output:'rom'})` / `build({output:'run'})`, not a manual `romPatch({op:'gbHeader'})` step). All
three are silent-failure bugs that look like "did my changes even
land?" and need different fixes.

## OAM DMA must run from HRAM (R55 fix — applies to ALL GB code, not just SDCC)

This isn't an SDCC issue — it's a GB hardware rule that any bundled
OAM DMA wrapper must respect:

During the ~160 µs OAM DMA transfer, the CPU can ONLY fetch
instructions from HRAM ($FF80-$FFFE). Reads from ROM / WRAM / VRAM
return $FF on real hardware. $FF decodes as `rst $38` which CALLs
$0038; gb_crt0.s vectors $0038 to `ret`, which pops the stack — but
the stack just had the rst's return address pushed, so PC ends up
PC+1 (one byte past the original fetch). Over a few hundred bytes
of "fetching from a $FF bus" the misalignment lands as the operand
of a multi-byte instruction and the CPU jumps into garbage. Classic
symptoms: LCDC = $FF (every bit set — Window enabled, BG map base
flipped), BG VRAM at $9800-$9BFF wiped to zeros, sprite glitches.

The fix is the canonical GB idiom: install a tiny stub in HRAM at
boot, then CALL the HRAM stub from any DMA-driving code. The stub
fetches its own instructions from HRAM (allowed during DMA).

The bundled `gb_runtime.c` does this via `oam_dma_init_hram()`,
called automatically by `lcd_init_default()`. If you bypass
`lcd_init_default` you MUST call `oam_dma_init_hram()` yourself
before any `oam_dma_flush()` / `oam_dma_copy()`. Otherwise sprites
will appear to work, then corrupt VRAM after a few hundred frames
under load — diagnosis time ~3 hours per agent who hits this
(round 27).

If you write your own OAM DMA path, the same rule applies: the
spin-loop bytes MUST be in HRAM. Don't spin in ROM. Don't spin in
WRAM. ONLY HRAM.

## gb_crt0.s zeros BSS correctly (R55 — bundled fix; only matters if you bring your own crt0)

Pre-r55's `gsinit:` had a typo that zeroed `_INITIALIZED` (the
runtime shadow of init-value statics) instead of `_DATA` (actual
BSS). The copy loop right after overwrote `_INITIALIZED` with the
`_INITIALIZER` ROM image anyway — making the zero a no-op. Net
effect: every `static uint8_t flag;` in your code booted with
whatever WRAM byte was there at power-on. Hard to spot because
your initialized statics (`static uint8_t lives = 3;`) WORK
correctly; only the uninitialized ones boot with garbage.

The fixed crt0 zeros `s__DATA..s__DATA + l__DATA` (the actual BSS).
If you bring your own crt0, model the gsinit on the bundled one —
and at minimum add a test like:

```c
static uint8_t test_flag;  /* uninitialized — must be 0 at boot */
void main(void) {
  if (test_flag != 0) { /* boom — your crt0 doesn't zero BSS */ }
}
```

## Multi-TU builds are still a good idea

Independent of any compiler issues, splitting your project into
multiple `.c` files via `sourcesPaths` helps with iteration speed
(fewer lines for sdcc to re-parse on each rebuild) and makes the code
easier to navigate. It's not a workaround anymore, just good hygiene.

```js
build({
  output: 'rom',
  platform: "gbc",
  language: "c",
  sourcesPaths: {
    "main.c":     "/path/to/main.c",
    "render.c":   "/path/to/render.c",
    "data.c":     "/path/to/data.c",
    "objects.c":  "/path/to/objects.c",
  },
})
```

## sm83 codegen traps in plain game logic (WRAM integer/array code)

Every footgun above is about VRAM / OAM-DMA / the cart header — the stuff
that makes sprites vanish. This section is the opposite: **plain WRAM game
logic** — PRNGs, collision grids, score math. Two such "miscompiles" were
reported from a real GBC Columns build session and chased to ground here.
**Verdict: neither was an sm83 codegen bug.** They are documented so you
don't burn hours blaming the compiler for what is actually a memory-layout
or static-init trap.

### NOT a bug: 32-bit math / `uint32_t` shifts ≥ 16

Reported: *"`static uint32_t rng=0x1357; rng ^= rng<<13; rng ^= rng>>17;
rng ^= rng<<5;` degenerates — every `1+xorshift()%6` roll comes out the
same (near-monochrome)."*

**Reproduced on sm83: it does NOT degenerate.** A ROM that seeds the PRNG,
calls `xorshift()` 20×, and writes `1 + (result % 6)` to WRAM reads back a
fully-varied `5,5,5,1,5,5,4,1,3,2,1,...` — the exact sequence a reference
implementation produces. Full 32-bit fidelity was confirmed byte-for-byte
across several seeds (`0xDEADBEEF`, `0x00000001`, …). The `<<13` / `>>17` /
`<<5` shifts (including the ≥16-bit right shift) and `% 6` are all correct.
**Do not rewrite a working 32-bit xorshift into 16-bit to "dodge" this.**
32-bit ops are bigger/slower than 16-bit on an 8-bit CPU, so prefer 16-bit
PRNGs for *speed* — but not for correctness; both are correct.

### The REAL trap behind "monochrome RNG": writing game state to a fixed
`0xC0xx` WRAM address that overlaps your statics

This is what actually produces the reported symptom. SDCC links the C
runtime's `_DATA` / `_INITIALIZED` segment (every value-initialised
`static`, e.g. `static uint32_t rng = 0x1357;`) **at the very bottom of
WRAM, starting `$C000`**, with `_BSS` (zero-init statics like
`static uint8_t grid[78];`) right after it. If your code also pokes a
**hardcoded** `$C000`-area pointer for game state —

```c
volatile uint8_t *board = (volatile uint8_t *)0xC000;   /* DON'T */
board[i] = piece;                 /* clobbers `rng` and friends! */
```

— you are scribbling directly over your own statics. Then `xorshift()`
reads a trashed `rng`, the PRNG collapses, and every roll looks the same.
It presents *exactly* like a compiler bug; it is not.

**Fixes (any one):**
- **Best — let the linker place it.** Use a `static` array and take its
  address; never hardcode a WRAM pointer:
  `static uint8_t board[6*13]; ... board[i] = piece;`
- If you *must* use a fixed address, put it well clear of the runtime data:
  `$C200`+ is safe for small projects (statics here end far below `$C100`;
  `shadow_oam` is pinned at `$C100`). Confirm with the linker map — build
  with `includeSymbols:true` and look at `s__DATA` / `s__BSS` (e.g.
  `s__DATA = $C000`, `s__BSS = $C006`): your scratch RAM must start ABOVE
  the end of `_BSS`.
- **Diagnose it in seconds:** read `system_ram` offset 0 right after boot
  and compare against your initialised statics' expected bytes. If a
  `static uint32_t x = 0x1357;` doesn't read back `57 13 00 00` at its map
  address, something is overwriting it.

### NOT a bug: short `for` loop with an indexed `static` array read

Reported: *"`for(i=0;i<3;i++){ if(grid[r*6+col]) return 1; }` reads the
wrong cells (pieces lock mid-air / floating gaps); unrolling the 3
iterations fixed it."*

**Reproduced on sm83: the looped form reads the CORRECT cells.** A ROM that
seeds `grid[]` with a sparse occupied/empty pattern and runs `collides()`
both looped and hand-unrolled, for 8 straddling `(col,topy)` inputs, gets
**identical, correct** results from both forms (`1,0,1,0,1,1,1,1`). The
`grid[r*6+col]` index math and the 3-iteration loop are fine. If your real
collision check "floats," look first at the WRAM-collision trap above (a
clobbered `grid[]`), at off-by-one row/col limits, or at signed/unsigned
mix-ups — not at loop codegen. **Don't pre-emptively unroll loops as a
compiler workaround; with the stack-overflow fix in place, sm83 loops with
indexed array reads are reliable.**

### z80 (SMS/GG) ONLY — fixed: value-initialised statics booted as 0

Investigating the above on the **z80** port (SMS/GG share the SDCC family)
surfaced a real bug — but a **crt0** bug, not codegen. The bundled
`sms_crt0.s` / `gg_crt0.s` placed `_INITIALIZER` (the ROM image of
value-initialised statics) *after* the `_DATA` RAM block in the area list,
so sdld put it in RAM; the gsinit `ldir` then copied uninitialised RAM onto
itself and **every `static uint8_t x = 5;` booted as 0** (and BSS wasn't
zeroed either). On z80 *this* is what made the xorshift PRNG monochrome
(seed `rng` booted 0 → stayed 0). Fixed 2026-06-08 by ROM-placing
`_INITIALIZER` + adding a `_DATA` zero loop, mirroring this sm83 crt0 (which
was already correct — hence sm83 was never affected). If you bring your own
z80 crt0, model gsinit on `gb_crt0.s`.
