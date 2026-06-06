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
`build({output:'rom'})` / `build({output:'run'})`, not a manual `patchGbHeader` step). All
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
