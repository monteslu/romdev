# IDO late-stage patterns

These are experiment prompts, not rewrite recipes. Re-check the object after
each change.

## Treat source spelling as compiler input

For a close function, preserve and test:

- declaration order and scope;
- which local carries an index, pointer, counter, or temporary result;
- expression grouping and assignment placement;
- integer versus floating literal type;
- loop source form before manually reproducing an apparent unroll;
- call-site prototypes and translation-unit visibility.

Semantically equivalent source can change expression tables, web construction,
spill homes, and later allocation decisions. Each classic "fake match" idiom
pokes exactly one allocator input -- a dead web (`if (g) {}`) takes the next
free pool slot, a K&R implicit-int return changes coalescing, a named
intermediate changes CSE ownership, statement line-grouping moves the
schedule -- so pick the idiom whose input the verdict names, one variant each.

Check the field guide's dead-families table first
(`decomp-workbench guide` prints the index): declaration-order permutation,
commutative operand swaps, and bare discarded expressions were each searched
exhaustively across multiple campaigns and are inert. Testing a buried family
once is cheap; re-searching it is how a day disappears.

Under line-sensitive frontends the placement of newlines is itself compiler
input: two token-identical bodies grouped differently across source lines can
schedule differently. When token-level spellings are exhausted, bisect
whitespace before concluding the schedule is unreachable.

cfe numbers each statement by the logical line it starts on, so the numbers a
natural layout produces are non-decreasing along statement order but not
strictly increasing -- ties are free, via several statements on one physical
line or trailing-backslash splices. Splicing a block's closing brace and the
statement after it back to the block's first line hands that statement a
number from inside the block, which one-statement-per-line layouts cannot
express (field-guide lever 25). What matters is the relation between
statements' numbers, not their absolute values: uniform shifts are inert.
Line-number reachability is therefore two dials, not one -- a statement move
changes which numbers a statement can carry at all; a tie changes the
relation between two of them -- and a sweep that varies only physical layout
under a fixed statement order has not searched the space.

Do not generalize that cfe rule to every IDO frontend. Stock 7.1 NCC/EDG can
attribute the same tokens differently: in `func_ovl8_8037C710`, the existing
backslash-spliced layout missed while explicitly giving both initialization
statements one line and both calls an earlier line matched all 49 instruction
words. Putting each pair literally on one physical line preserved the match.
Treat a splice, a same-physical-line pair, and repeated `#line` markers as
separate experiment cells, and always run them through the named frontend.

## Diagnose allocation rather than decorating it

When opcode shape stabilizes but registers differ:

0. Decide which *population* the differing registers belong to, because the two
   are allocated by different passes and answer to different levers. This is
   per-compiler-era data, not a constant. Under IDO 5.3 at `-O2 -mips2`
   (probed): uopt's possible colors include `v0 v1 a0-a3 t0-t5 s0-s8`.
   The shared `t0-t5` registers may instead be UGEN temporaries when not
   reserved. A visible rotation is not always changed demand order: compare
   per-procedure reservation evidence first. Do not infer a target pool from
   candidate returns. Any other release is unverified -- `view --register-profile
   unverified` is the pre-probe table and a lane it produces is a hypothesis.
   `view --json` reports `register_profile` and `register_profile_evidence` so
   the claim travels with its provenance. The float ring is four wide:
   ugen's `ffree` initializer also lists `f16`/`f18`, but both are withdrawn
   before the first allocation and never handed out, and they are uopt colors.
   A float-site script that quotes the initializer counts `f12`→`f16` as a
   closed temp site when it is a coloring change.
1. Localize the mismatch range.
2. Capture the narrowest relevant `globalcolor`/UGEN trace.
3. Inspect one procedure and web at a time.
4. Form a lifetime hypothesis: an earlier use, a surviving pointer, or an
   unnecessary temporary may keep a color unavailable.
5. Test the source-lifetime change, then remove diagnostic scaffolding.

A temp-population difference is **not** a coloring-priority question. ugen pops
the head of a per-class free list and frees to its tail -- a least-recently-freed
ring, re-seeded once per procedure -- so the register at a site is a pure
function of the alloc/free event sequence before it. The dimension that moves is
the count of **class-crossing sites**, where one side leaves as a ugen temp what
the other colored; each such site re-phases every downstream temp. Score a
campaign on that site count, not on raw words: partial closure is not monotone,
and a recorded 5.3 run went 1416 → 1413 → 1445 → 1477 → 572 as sites closed.
Rotating the ring's initial phase is an oracle knob, not a fix; on that same run
the best possible phase was worth 84 of 845 rows.

The Hartley finish showed that removing a fake can repair a distant coherent
register swap. A fake local is never neutral merely because its generated
instructions appear harmless nearby.

Distinguish *underpriced* from *taken* before spending another reweighting
variant. Every priority lever -- dead webs, extra reads, chain splits -- changes
what a web costs; none of them help when the register is simply held and there
is nothing left to allocate. The machine-readable symptom is a `globalcolor`
decision of `split` (p1) or `no-color` (p2) with `regsleft=0`, or a
`force_declined` naming a callee-saved color;
`decomp-workbench trace-globalcolor TRACE.log --proc N` annotates it. The
answer is a legality change rather than a cost change: `if (&local);` emits
nothing and takes that local out of web candidacy entirely, freeing the
register its web was holding (field-guide lever 28, `decomp-workbench guide
28`). Alias the memory half of a register/memory pair, never the register
half, and check `candidate_frame_size` on every variant.

## Step back from a false local optimum

The Aquas finish showed that a manually forced loop can match a local region
while producing the wrong whole-function allocator topology. If a small loop
needs an escalating stack of fakes, forced conditions, or explicit unrolling:

1. Restore the natural source form.
2. Re-evaluate variable roles and reuse across the whole function.
3. Check declaration order and earlier expression lifetimes.
4. Let the compiler perform an observed unroll when the source topology is
   correct.

Use manual unrolling only when the target evidence requires source-level
unrolling, not because it temporarily improves a local score.

## Use force probes safely

A forced register/color, retained listing edit, or compiler patch is valuable
when it answers one question: "would this late-pass decision explain the
residual?" Record the exact control and result. Then translate the result into
a maintainable source hypothesis. Never commit the forced artifact as the
decompilation answer.
