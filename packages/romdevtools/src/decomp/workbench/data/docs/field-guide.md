# Field guide: IDO codegen levers

**The diff looks like X. Here is the C that moves it.**

This is the manual path. No permuter, no agent, no trace -- just the mechanisms
that were found by matching real functions, written down so you can apply them
by hand. [Start here](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/START_HERE.md) explains the loop these fit into; this page
is what you consult once `view` has named a mechanism.

**Running these commands in romdev.** romdev does not install a
`decomp-workbench` executable; the workbench runs inside the romdev server.
A command written here as `decomp-workbench <group> <command> ARGS` runs as
`decomp({op:'workbench', project, wbGroup:'<group>', wbCommand:'<command>',
wbArgs:[ARGS]})`. Call `decomp({op:'workbench', project})` with no
`wbCommand` to list every group and command the server carries (object,
trace, instrument, pass, probe, sweep, permute, oracle, campaign, experiment,
toolchain and more). A command the catalog marks destructive needs
`allowDestructive:true`; one that reaches the network needs
`allowNetwork:true`. Common steps also have their own decomp ops:
`compare` (compile and score a candidate inside its translation unit),
`diagnose` and `layout` (read a stored comparison), `variants` (measure a
bounded list of source variants), `search` and `job` (bounded permuter
runs), `experiment` (hypothesis, control and conclusion records), `gate`,
`rank`, `dispatch` (parallel triage), `integrate` and `verify`.
The `guide` command has no server op: a `guide <number>` pointer names a
numbered section of this page, and `guide laws <era>` names a page under
`compiler-laws/`.

Levers 1-19 were each proven on a real IDO 5.3 `-O2 -g3 -mips2` function, and
the measured effect is quoted so you can calibrate how much to believe it.
Levers 20-22 come from a later campaign and are a different kind of finding --
they are about the *frontend* being a variable rather than about the C you
write under one -- so they carry their own provenance. Lever 23 is the same
kind of finding one stage earlier: the *preprocessor* as a variable, and lever
25 is its natural-source counterpart -- line numbers as a dial you can turn
without a directive. Levers 26-28 come from campaigns that ended past the
usual finish line: recovering a stack frame whose allocation was already
exact, cleaning up after a match, and winning a register that was *taken*
rather than underpriced. Levers 29-33 come from a campaign that closed a
2057-instruction function to zero words, and they are the levers of a *full*
frame: steering a register by what a call forbids rather than what a web costs,
buying a local out of an array's tail, emptying the compiler's own temp pool,
and the discovery that physical source line numbers reach the assembler's
scheduler. Levers 34-39 come from an **IDO 7.1** campaign that closed a
1,868-instruction jump-table function from one word to zero, and they are the
levers of a *dispatch*: a barrier that survives one pass and is deleted by the
next, the parity of a partition, the block order of a switch, and the read-count
dial as arithmetic rather than as a search. The C snippets are illustrative
shapes, not copy-paste patches: the *form* is the lever, the identifiers are
yours.

**Read the order as priority.** Levers 1-4 cost one variant each and can erase
a hundred words. Do not touch the register sections until the instruction count
and opcode schedule have stopped moving.

Any section here can be printed in the terminal:
`decomp-workbench guide <playbook>`, `guide <verdict>`, or `guide <number>`.
[From verdict to edit](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/from-verdict-to-edit.md) takes one lever from this page
to a source change and back.

- [Cheap first -- one variant each](#cheap-first--one-variant-each)
- [Working a structure mismatch](#working-a-structure-mismatch)
- [The coloring pool (uopt)](#the-coloring-pool-uopt)
- [The temp-FIFO lane (ugen)](#the-temp-fifo-lane-ugen)
- [Coalescing copies](#coalescing-copies)
- [When source search is over](#when-source-search-is-over)
- [When the compiler itself is the variable](#when-the-compiler-itself-is-the-variable)
- [When the preprocessor is the variable](#when-the-preprocessor-is-the-variable)
- [When the line number is the variable](#when-the-line-number-is-the-variable)
- [When the dispatch is the variable](#when-the-dispatch-is-the-variable)
- [When the dial has arithmetic](#when-the-dial-has-arithmetic)
- [Dead families -- do not spend variants here](#dead-families--do-not-spend-variants-here)

---

## Cheap first -- one variant each

### 1. Wrong constant masquerading as structure

**Diff looks like:** a large `structure-mismatch` whose *earliest* hunk begins
at a constant materialization -- `lui`, `li`, `andi`, `ori`, `slti`.

```c
/* before */  if (flags & RENDER_UNK10) { ... }   /* 0x10 */
/* after  */  if (flags & RENDER_DECAL) { ... }   /* 0x00100000 */
```

**Why:** the assembly encodes the truth about the constant, and everything
downstream of a wrong branch predicate is a consequence, not an independent
problem. One wrong enum identifier produced 183 "structural" words in
`blockSetupVertices`; correcting it left 21.

**Then re-derive every fake.** Padding and dead reads that were fitted to the
wrong body are now wrong too -- in that same function a stale `if ((s32)x) {}`
pad had been compensating for the bad constant's register pressure, and the
frame and register counts only snapped exact once it was removed.

**Points here:** `verdict=constant-mismatch`, `playbook=constant-audit`, and any
structure verdict whose first hunk starts at an immediate.

### 2. Commutative operand order

**Diff looks like:** `verdict=commutative-order`, or a handful of `or`/`and`/
`xor`/`addu` sites with the same two operands in swapped positions.

```c
/* neither of these moves anything - they canonicalize identically */
x = a | b;
x = b | a;

/* this is a different AST, and it flips the emitted operand order */
x |= b;
```

**Why:** operand order on a commutative op is front-end expression shape, not
allocation. IDO 5.3 canonicalizes source-level swaps of a plain binary
expression to byte-identical objects, but compound assignment is a distinct
tree and emits the other order. Proven on `texDPTextureSimple`.

**Not every frontend canonicalizes.** Under accom lineage, `a + b` emits its
operands in the *reverse* of source order: `(src_row_start + k)` produced
`addu ?,v0,t3` where the ROM has `addu s4,t3,v0`, and commuting the source
expression fixed it. uopt normalizes the *value*, not the emitted operand
order, so a swapped-operand `addu`/`or` hunk under a non-cfe frontend is a
free, instruction-neutral source fix rather than an allocation problem --
try it before spending a variant on lifetimes. Under IDO 5.3's own cfe the
paragraph above still holds; check which frontend you are on
([lever 20](#20-frontend-lineage-check)) before generalizing either way.

**Points here:** `verdict=commutative-order`, `playbook=ast-shape`, and any
small register/operand hunk whose two sides hold the same two operands. Do not
capture an allocator trace for this class -- the allocator is not involved.

### 3. The `-g0` diagnostic

**Diff looks like:** the same instruction multiset in a different order, or
"the target hoists further than my candidate". `verdict=schedule-mismatch`, or a
`view` verdict of `schedule`.

```sh
# rebuild the same candidate with -g0 instead of -g3, then compare again
```

**Why:** IDO emits `.loc` records under `-g3`, and as1 can use their line
identity as a scheduling constraint or tie-break. If the divergent region
collapses toward exact under `-g0`, debug metadata participates and the
assembler can reach the target ordering.

That result is **an ownership probe, not source proof**. A freer scheduler can
rescue a non-original expression or statement shape. `vsprintf` is the
counterexample that corrected this guide: `-g0` took its float paths from 25
words to 2, but the eventual match still required replacing pre-subtracted
padding with one early length expression and live width comparisons. After a
positive probe, compare source topology and decoded line tags; use
`replay-as1` or a narrow scheduler trace only when the remaining ordering
cannot be explained from those two views.

**The negative result is also useful, but scoped.** If `-g0` does *not*
collapse a region, that region is not explained solely by debug-line
constraints for the exact source, flags, context, and toolchain you tested.
Verify those inputs before retiring the hypothesis; do not generalize one
negative region to the whole function.

**If you are already `-g0`, this probe is vacuous.** There is no `-g3` schedule
to collapse, and a null result here says nothing about the compiler. When the
multiset is equal and the register allocation is identical, go to
[lever 23](#23-preprocessor-line-assignment): statement line boundaries
constrain uopt and ugen at `-g0` too, and *which* line each statement lands on
is a preprocessor decision you can change.

**Points here:** `verdict=schedule-mismatch`, `playbook=g0-schedule-probe`.
The probe narrows layer ownership; it never awards a source match.

### 4. Flag parity and context parity

**Diff looks like:** a large structural residual on source you have reason to
believe is right -- a ported scratch, a function that matched elsewhere.

**Why:** the same source under the same nominal flags produces different code
in a different translation unit context, and a single missing assembler flag
produces differences that read as structural. A decomp.me preset missing
`-Wab,-r4300_mul` produced roughly 78 "structural" words on already-ROM-verified
source. Type differences reaching the optimizer from a different `ctx.c` shift
schedule and branch-likely selection on their own.

**Do this before any source search on a ported function:** diff your flag line
against the project's real build rules, and compare against the full-TU build
rather than a harness. See [Minute 1 of Start here](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/START_HERE.md#minute-1--do-i-need-to-isolate-the-function-first).

**See also:** lever 24 audits the same missing-context family when it takes
the shape of an `#if`/`#elif` guard rather than a flag or `ctx.c` diff.

### 24. Preprocessor-conditional audit

**Diff looks like:** a large `structure-mismatch` with extra cases, an
unexplained jump table, or a whole block of code that "shouldn't" be there --
and the guard directly above it reads like it excludes that code.

```c
/* neither BUILD_VERSION nor VERSION_J is defined in this translation unit */
#if BUILD_VERSION >= VERSION_J
case DRAW_SOMETHING:
    ...
#endif
```

**Why:** when neither identifier in an `#if`/`#elif` expression is defined,
the C preprocessor substitutes `0` for both, and `0 >= 0` is true -- the guard
silently compiles the region in. Nothing about the source *reads* as wrong:
both names are plausible macros, and the mistake is legible only to the
preprocessor, not to a person scanning the diff. This kept one IDO 7.1
project's `drawbitmap` unmatched for years: the undefined-vs-undefined
`#if BUILD_VERSION >= VERSION_J` compiled in an extra switch case -- +109
instructions and a jump table nobody asked for -- and the resulting structure
diff gave no hint that a stale conditional was the entire cause. One
`#include <PR/os_version.h>`, which defines `BUILD_VERSION`, collapsed the
residual to size-exact. The general trap is any `#if`/`#elif` whose
expression's identifiers are *all* undefined: comparisons and equality
collapse to a constant truth value the author almost certainly did not
intend, most dangerously when that constant is true.

**Do this before any source search on a large structural residual:**
`decomp-workbench context lint FILE.c --define NAME=VALUE` parses every
`#if`/`#elif` in the file against the macros you name plus whatever the file
`#define`s along the way, and reports every guard whose truth was decided
entirely by identifiers nobody defined.

**Points here:** `verdict=structure-mismatch` or `schedule-mismatch` on source
you otherwise trust, and any large residual whose earliest hunk sits just
inside a conditional block.

---

## Working a structure mismatch

Bucket the hunks by size and fix the largest first, against whatever ground
truth you have about the function's lineage. Above roughly 500 instructions,
align, bucket by region, settle structure region by region, and only then run
the register playbook per remaining bucket. Hold every allocator experiment
until the instruction count and the opcode schedule are stable -- a register
lever applied to a function with the wrong shape tells you nothing.

Two structure-class traps have their own levers.

### 5. Don't fight the auto-hoist

**Diff looks like:** `+1` instruction and `+8` frame around a loop that
contains a call; the target re-reads memory each iteration where your candidate
caches the value in a register and spills it around the call.

```c
/* do NOT do this to force the re-read */
for (i = 0; i < n; i++) { ... }        /* split into two loops, */
for (; i < m; i++) { ... }             /* or duplicate the body */
```

**Why:** IDO performs its own loop-invariant motion, and restructuring the
control flow to force a particular memory behavior defeats it rather than
steering it. Loop splitting cost +147 words on `blockComputeVertexColors`
against a candidate that was already close.

**The lever, if one exists, is register pressure near the call -- not control
flow.** Revert any structural change that raises the word count sharply instead
of pushing through it.

### 6. The spill-slot census

**Diff looks like:** a consistent `+N` frame delta together with a *uniformly
shifted* tail of stack offsets.

**Why:** that signature is one extra (or one missing) spill slot, and every
shifted offset below it is the same fact restated. Census the stack offsets on
both sides, find the single value that gained a home, and work on that value's
liveness. Chasing the shifted offsets individually is chasing one problem N
times.

`compare --json` carries `candidate_stack_offsets` and both frame sizes for
exactly this census.

---

## Which register belongs to which pass -- the era table

Two independent populations write MIPS registers, and reading one as the other
sends you to the wrong compiler pass. This split is **per compiler release**,
and only one release has been probed.

### IDO 5.3 at `-O2 -mips2` -- verified

Probed with nine forced-color experiments and confirmed against instrumented
ugen. `view --register-profile ido53` (the default) uses exactly this table.

| Population | Pass | Registers |
|---|---|---|
| `pool` | uopt coloring | `v0 v1 a0 a1 a2 a3 s0 s1 s2 s3 s4 s5 s6 s7 s8` |
| `temp` | ugen scratch candidates | `t6 t7 t8 t9` |
| `shared` | actual role unknown | `t0 t1 t2 t3 t4 t5` |
| `fp-pool` | uopt coloring | `f0 f2 f12 f14 f16 f18 f20 f22 f24` |
| `fp-temp` | ugen ring | `f4 f6 f8 f10` (ring order) |

Two facts to hold on to, because three campaign agents assumed the opposite of
both:

* **`t0`–`t5` have shared possible roles under 5.3.** Colors c7–c12
  can reserve them; unreserved entries may become UGEN temporaries. The
  default `shared` lane means unknown actual role, not actual coloring.
  Register substitutions alone cannot distinguish reservation changes from
  expression-demand or lifetime changes. Diagnose those inputs before a lever.
* **`f4/f6/f8/f10` are never uopt colors either.** They are the whole float
  ring: it is four wide, not six.

`f16`/`f18` look like the ambiguous pair and are not one, which is worth its own
paragraph because reading them as temps cost a campaign stage about fifteen
builds and an adoption path that had to be withdrawn. ugen initializes `ffree`
with six entries -- `f4 f6 f8 f10 f16 f18`, from `nf1 = 4` plus `nf2 = 2` -- so a
reader who quotes the initializer gets a six-wide ring. The trace says
otherwise: `f16`/`f18` are **withdrawn before the first float allocation and
never handed out**, and one instrumented procedure allocated `f4`–`f10` 1460
times out of 1460. They are uopt colors (c28/c29) and belong to `fp-pool`.
Widening `fp-temp` onto them makes an `f12`→`f16` difference report as a closed
temp-ring site when it is a coloring change -- a phantom closure. If a float-site
script of your own carries the ring, assert the width rather than deriving it
from the initializer.

The int color map has a hole at c13 and the float colors occupy c24–c32, which
is why a forced-color probe on 5.3 must not assume a dense index space.

### The colorability gate -- ask this before any color lever

The possible-color palette is distinct from these default role lanes. It
includes t0–t5. A reservation need not survive as an emitted colored use.
The ten-entry startup order is `t6 t7 t8 t9 t0 t1 t2 t3 t4 t5`; removals
before allocation can change the available pool.

A coloring pass can only put a value in a register it hands out. For IDO 5.3
that includes `pool` + `fp-pool` + the shared t0–t5 entries. A confirmed
register outside that possible palette can be reached directly only
by ugen's block-local ring. So when the *target* register at a divergence is
ring-only, no reweighting, no tie-break, and no `CDX_FORCE` colour reaches it:
This restricts direct forcing, not indirect coloring effects: a changed
reservation can move temporary assignments without changing early demand order.
Do not infer an unreachable source family from a temporary register name.

`view` and `diagnose` separate direct palette limits from causal ownership:

* GP scratch/shared substitutions → `playbook=register-role-audit`, unknown
  ownership and `routing=evidence-first` until deciding evidence is available;
* `ring_only_targets` describes only supported direct color limits;
* possible-color membership does not prove actual colored ownership.

`--json` carries the same fact as `ring_only_targets`, and
`--emit-force-spec` refuses a wholly ring-only residual rather than writing a
handoff for an unsupported direct force. Indirect reservation effects remain
possible. Candidate-only traces never establish the original target's pool.

### Any other release -- unverified

`--register-profile unverified` carries the pre-probe table
(`pool = v0 v1 a0-a3 t0-t5`, `temp = t6-t9 s8`, no float split). It is the
table six earlier campaigns were read against, and it is deliberately what a
compiler with no probe of its own still gets. It has never been measured
against a single named release; treat a lane it produces as a hypothesis, and
probe before quoting it.

---

## The coloring pool (uopt)

uopt colors variable webs into the pool population above, lowest free index
first. `view`'s **pool lane** is the sequence of assignments in emission order. A pool-lane divergence means a web took a
different slot, which almost always means the *set* or the *priority* of webs
differs -- not that one register was picked wrongly.

Three things move a pool assignment: adding a web, removing a web, and changing
a web's priority. That is the whole surface. Levers 7-13 work it by price;
lever 28 removes a web by *legality* instead, which is what is left when the
register you want is held rather than mispriced -- including in the
callee-saved contest the same coloring pass decides.

### 7. Dead-web positioning

**Diff looks like:** the pool lane diverges at slot *k*; your carrier is one
register too low.

```c
/* zero instructions emitted; creates a web that takes the next free pool slot */
if (gSomeGlobal) {}
```

**Why:** a duplicated read inside an if-condition with an empty body survives
dead-code elimination as a code-free web, and that web occupies the next free
pool slot, marching every later web one position down the order. Two such reads
put the carrier in `$a3` on `rarezipUncompress`, which matched the function.

**The boundary matters:** a dead web takes the *next free* slot. It cannot
reach past a live web to free a specific register. On `objprint`, dead reads of
whole locals and globals always landed in `v1` and could never occupy `v0` -- see
lever 9 for the construct that can.

**Points here:** `playbook=pool-position`, a pool-lane divergence in `view`.

### 8. Expression dead reads

**Diff looks like:** as lever 7, but the plain `if (var) {}` form is inert,
lands in the wrong slot, or the value you need a web for is not a named local.

```c
if (gFile_TEX_TAB[tab]) {}            /* an array-index rvalue */
if ((tab * 4) + tabEntry + tabEntry) {}   /* an arithmetic rvalue */
```

**Why:** the zero-code dead read generalizes from locals and globals to
arbitrary rvalue expressions, and the expression form gives you control over
*which* value gets a web rather than only over how many webs exist. The second
form above, plus a parameter mask, is what matched `texLoadTextureActual`; the
first was the only thing that beat a stubborn `lui` hoist.

**And it lifts the `v0` boundary:** the "dead reads take `v1`, never `v0`" rule
applies to whole locals and globals. Reads of *intermediate values* do take
`v0`.

### 9. The read-count priority dial

**Diff looks like:** two webs compete for the same slot and the wrong one wins;
you can form the web you want, but it colors second.

```c
if (gFile_TEX_TAB[tab]) {}
if (gFile_TEX_TAB[tab]) {}    /* stack a second read of the losing web */
```

**Why:** uopt orders webs by accumulated benefit, so read count is a
continuous priority control rather than an on/off switch, and stacking reads of
the losing web until it outranks the winner is **monotone** -- you can turn the
dial rather than search. On `texLoadTextureActual`, one read left 5 words and
two reads left zero.

**Practical note:** this is the cheapest possible campaign -- a one-dimensional
sweep of *n* reads at one site, not a permutation search. Filter the results
with `--census aligned_register=0` (or whichever key the dial is supposed to
move) rather than by reading each report: the exit code is `0` when the
predicate holds and `3` when it does not, so the sweep prints only the *n* that
worked.

### 10. The chain-split dead read

**Diff looks like:** you need a short-lived web in `v0`, but the value is a
local whose update chain is one continuous assignment, and every dead read you
add takes `v1`.

```c
/* before */  x += a;
/* after  */  x += a; if (!x); x++;
```

**Why:** splitting a local's own update chain with a dead read forms a short
web *from the intermediate value*, and intermediate-value webs can take `v0`
where whole-local reads cannot. It costs zero instructions and zero frame, and
it does not consume a coalescing copy the way an assignment RHS would.

On `objprint` this was the first construct in roughly 2,800 variants to color
the count web correctly with no forced color at all. Note the trailing
semicolon: `if (!x);` -- an empty *statement*, which is what keeps it free.

**Its cost:** the dead read is a branch in the ucode and pins the chain above
whatever guard follows, so it can convert an allocation residual into a
schedule residual. That is usually progress; check with `view` rather than
assuming.

### 11. Pool-vs-temp routing

**Diff looks like:** a value that appears in the *pool* lane on one side and
the *temp* lane on the other; often the entire residual.

```c
/* pool: a named local whose live range spans the loop */
s32 end = base + count;
for (...) { ... use(end); ... }

/* temp: the same expression inlined at the use site */
for (...) { ... use(base + count); ... }
```

**Why:** promoting a value to a named local that spans a loop makes uopt form a
colored web for it; inlining the expression leaves it in ugen's block-local temp
rotation. Which side of that divide a value sits on decides which lane it
appears in, and no color force can move it across. Proven both directions on
`rarezipUncompress` (the local `end`).

**When you see this**, stop working on colors: the question is web *formation*,
not web *coloring*.

### 12. Mul-vs-shift web formation

**Diff looks like:** identical emitted instructions, but one side forms a web
for a scaled index and the other does not.

```c
/* forms a web */          tab * 4
/* does not form one */    tab << 2
```

**Why:** the two spellings emit the same code but are not interchangeable as
liverange-formation triggers -- the multiply survives into ucode as an
expression the optimizer can name, the shift is folded earlier. Recorded on
`texLoadTextureActual`.

**Confidence: low-to-moderate.** This is a single observation, and an earlier
round on the same function saw `tab << 2` as a web member on the target side.
Treat it as a cheap one-variant probe when a scaled index is near your
divergence, not as a rule.

### 13. Copy-propagation defeat

**Diff looks like:** a CSE'd expression forms a web on your side and takes the
register you wanted, and no placement of a dead read displaces it.

```c
/* before */  use(id & 0xFFFF); ... use(id & 0xFFFF);
/* after  */  id &= 0xFFFF; use(id); ... use(id);
```

**Why:** masking into a formal parameter in place gives that parameter multiple
reaching definitions, and IDO does not copy-propagate such a parameter -- so the
CSE expression web never forms at all, and the value falls to a ugen temp
instead of consuming a pool slot. On `texLoadTextureActual` this was the first
variant family in six rounds to match the target's instructions 43-45.

**This is the delete-a-web lever**, the counterpart to levers 7-8. A forced
color cannot delete a web; source can.

---

### 28. Alias a local to take it out of the allocation contest

**Diff looks like:** `playbook=pool-position` where the pool lane is shifted by
exactly one position and every save-raising lever is already exhausted -- the
value you need in a callee-saved register loses because *another* web is holding
the slot, and the trace shows your candidate web `split` with `regsleft` at zero
and every callee-saved color forbidden by the time it is considered.

```c
/* zero instructions emitted; the local can no longer form a web at all */
if (&frame_local);
```

**Why:** every other lever in this guide adjusts what a web *costs*. This one
changes what the compiler is *allowed* to do. Once a local's address is taken,
its reads after a call must come from memory -- a callee could have written it --
so those reads can never join a register web, and the store into it becomes
mandatory rather than a copy the optimizer may propagate away. The variable
leaves the coloring contest entirely, freeing the register its web was
occupying for whoever comes next.

**The exact term it moves.** Aliasing does not lower a price; it feeds an
eligibility gate. uopt strikes a web from coloring outright when its computed
`save` is not strictly positive, where `save` is the web's gross reference
weight minus one charge per use that needs a reload and one per def that needs
a store -- and an address-taken local is exactly the local whose uses reload and
whose defs store. Measured on one function: a dead-code probe
(`if (0) { f(&colour, …); }`, zero instructions) moved one web's store charge
from 0 to 8. The gate is `> 0` and not `>= 0`, so a web whose charges exactly
cancel its gross is struck; that last unit is worth chasing when a sweep stalls
one charge short. A struck web emits no *candidate* record, which is how you
recognize the state in a trace -- but it is still allocated, to the stack. That
is worth stating plainly, because "emits no candidate record" reads as "was
never a candidate for anything" and it is not: the `CDX_FORCE` strike (`=n`)
and split (`=s`) controls both send the value to a stack home, so **neither
models "this value never entered the allocation contest"**. Nothing in the
force grammar does; only a source change that stops the value being a value
does. One campaign spent a build discovering that. See
[compiler laws L55](compiler-laws/ido-5.3.md#l55-the-eligibility-gate-save--0-is-struck-before-colouring-begins)
for the formula and its falsified rivals.

That is the move when the target register is not *underpriced* but *taken*: on
a tiled-blit function whose ROM packed ten callee-saved values into nine
registers, no amount of reweighting could seat the tenth. Aliasing the one that
belonged in memory reproduced the ROM's callee-saved map exactly.

**Its companion construct -- two source variables over one home.** The shape this
lever usually completes is a value that lives in a register early and in memory
later:

```c
tmp = <expr>;      /* colored: definition plus one early use */
slot = tmp;        /* the mandatory store */
if (&slot);        /* the alias: later reads are loads, never web members */
/* ... calls ... */
/* later uses read `slot`, not `tmp` */
```

**Direction matters:** alias the *memory* half. Aliasing the register half
destroys the callee-saved candidacy you were trying to win.

**It is free on locals, not on parameters.** A parameter's alias forces its
incoming argument home to be written, costing one to two instructions -- so the
obvious move of aliasing an uncolored parameter is usually not available. Check
the instruction count, not just the register lanes.

**Where you put the mark is a tuning axis -- sweep it.** The alias is
whole-scope in the sense that matters for legality (the variable is out of the
contest for its whole range), but its *placement* is worth real words. On
`func_ovl8_803787C0`, the same two marks scored 140 words at the function head,
131 in the `j` loop, and **106** in the innermost loop -- every one of them
emitting zero instructions. Sweep innermost-first, and score rather than assume:
at one earlier site a late mark cost 4 instructions, which is a fact about that
site and not a rule. Treat "the mark is positionally inert" as falsified.

**Measured boundaries.** It does **not** compose with
identity-arithmetic anti-folding (lever: `(E) + 0`): that already splits the
value into its own u-code temp, leaving the alias nothing to remove, and the two
together are byte-identical to `+ 0` alone. Adding a single local that colors is
frame-free (frame size counts stack *homes*, not locals); several at once are
not -- check `candidate_frame_size` on every variant.

**Points here:** `playbook=pool-position` with a one-position lane shift, a
`decision=split` on the web you want colored, or a `force_declined` naming a
callee-saved color with `regsleft` exhausted.

`decomp-workbench trace-globalcolor TRACE.log --proc N` names that symptom for
you: a web whose decision line carries `regsleft=0` is annotated with this
lever, and `--desired-color` says so again when the color you asked for is held
by an interfering web.

### 29. Steer a register with an argument pin

**Diff looks like:** `verdict=register-permutation` confined to one web -- every
site that reads one variable uses the neighbouring argument register (`a1` where
the target has `a2`), instruction count and frame already exact, and every
cost-side lever on that web has been tried.

```c
/* before: the carrier is dead across the call */
text = (char *) langGet(0xa01c);
sprintf(buffer, fmt, text, n + 1, (char *) langGet(0xa01d));

/* after: the column carrier itself holds the value across the call whose
   format argument pins a1, so a1 enters the web's forbidden set */
k = (s32) langGet(0xa01c);
sprintf(buffer, fmt, (char *) k, n + 1, (char *) langGet(0xa01d));
```

**Why:** `forbidden0` is seeded before the coloring worklist from two sources --
the assigned colors on the web's adjacency list *and* the hard-register conflict
vector. A web live across a call's argument setup inherits a forbid from every
argument register that call pins. So the reachable move is not to make your
register cheaper; it is to make the register you do *not* want **illegal**, by
giving the value a live range that crosses a call pinning it. Zero instructions,
frame unchanged.

**Measured:** an IDO 5.3 project's `mp_watch_menu_display` -- a two-statement diff moved one
web's forbidden mask `0x70000000 → 0x7a000000`, the web from `a1` to `a2`, and
six sites to register-for-register exact at parity. Six earlier certificates in
that campaign had each looked for an *arithmetic* route to the same flip and
proved it impossible; the fact was never arithmetic.

**The side effect to plan for.** The forbid follows the *whole* web, so a symbol
carrying two roles inherits it for both. In the measured case the same symbol
was also a loop index, which came out register-swapped against the target until
the roles were split onto two symbols -- see lever 31 for where the second symbol
came from.

**Points here:** `verdict=register-permutation` on a single web, a
`force_declined` naming the register you want, and any campaign whose sweep of
save/crossing weights on that web has closed.

### 30. Write `a && b` as the compiler expands it

**Diff looks like:** you need a predicate's *value* on a named carrier -- to give
it a live range (lever 29), to move it off a contested web, or to empty a temp
pool (lever 32) -- and every respelling you have tried detonates the allocator
basin by hundreds of rows.

```c
/* cfe's own expansion of `v = a && b`, written out */
v = (a == 0);
if (v) { v = (b == 0); }
```

**Why:** cfe expands `&&` in value position into exactly that shape. Spelled
that way, with a named local standing in for the pool temp, it is
**byte-identical** to the operator at every site. Spelled any other way --
`v = 0; if (a && b) v = 1;`, an `if/else`, or a branch-free `|`/`&`/`*` -- it is
a different u-code sequence and costs real rows.

**Measured:** four `&&` sites, singly and in every pair and triple: byte-identical
throughout. The same four sites under the other spellings measured 264–860 rows
across four stages, and four impossibility certificates rested on that price
before the expansion was written out.

**Points here:** any lever that needs a predicate on a named carrier, and any
"branch rewrite is unaffordable here" conclusion measured on a spelling other
than this one.

---

## The temp-FIFO lane (ugen)

Expression temps come from ugen's own free list, not from uopt's coloring pool.
`view`'s **temp lane** is that pop sequence.

### The allocation law (IDO 5.3, read from ugen source and instrumented)

Read from `ugen.c` in the 5.3 recompilation and confirmed with an instrumented
binary that rebuilds a campaign object byte-identically to the stock toolchain:

* ugen keeps **two singly-linked lists per register class**, free and in-use.
  Allocation pops the **head** of the free list (`f_get_one_free_reg`);
  freeing appends to its **tail** (`f_add_to_free_list`). It is therefore a
  **least-recently-freed round robin**, not an LRU or a preference order.
* `f_init_regs` runs **once per procedure**, so the phase does not carry across
  functions. It seeds the int ring `t6 t7 t8 t9 t0 t1 t2 t3 t4 t5` and the
  float ring `f4 f6 f8 f10`. The float initializer lists `f16 f18` as well,
  but both are withdrawn before the first allocation and never handed out
  (1460 of 1460 float allocations measured in `f4`–`f10`), so the effective
  ring is four wide and `f16`/`f18` are uopt colors.
* Consequently **the register at a site is a pure function of the alloc/free
  event sequence that preceded it** -- nothing else. No liveness heuristic, no
  ucode-temp-index mapping. A value that uopt colors is *not* a ugen temp; a
  value it leaves uncolored consumes a ring slot.

**This section is 5.3-verified.** The three levers under it (14–16) were
derived on IDO 7.1 campaigns and still describe the mechanism, but the ring
contents, the ring *order*, and the "not a FIFO rotation but a per-position
permutation" caveat below are 5.3 measurements. On any other release the ring
is unverified -- run the probe before quoting numbers.

A temp lane that reads `rotation=+1` from slot *k* is **one event**, not *N*
mistakes: somewhere before slot *k* your candidate popped one more or one fewer
temp than the target. Fixing the visibly-wrong instructions individually is
impossible -- they are downstream of a queue.

**The lever is always in the block *preceding* the visible divergence.**

### The lever is the class-crossing site, not the row

Rotating the initial free list is a legitimate oracle knob and it is **not** the
fix. Swept over all ten phases on one 5.3 campaign function, the best possible
initial phase was worth 84 of 845 int-temp rows; the phase that reproduced the
first divergent instruction exactly made the total *worse* (1440 against 1416).
No choice of initial state closes the band, because the initial state is fixed
and the divergence is in the **event sequence**.

The events are the sites where a value crosses the class boundary: your
candidate leaves as a ugen temp what the target colored, or colors what the
target left as a temp. Each such site re-phases **every** downstream temp in
the procedure.

* target colors, you do not → give the value a *named local* so uopt forms a
  web. Adding a declaration wrecks the frame, so reuse a dead declared local
  and retype it: declaration-count-neutral.
* you color, the target does not → remove the named local and spell the value
  as an expression.

Find them by walking both objects position-wise and reporting every instruction
whose *destination* register crosses the boundary. `view`'s lanes are that walk:
a register in the temp lane on one side and the pool lane on the other is a
class-crossing site.

**Score on the site count, not on raw words.** Partial closure is *not*
monotone: on the recorded run, closing 1 site moved 1416 → 1413, 2 → 1445,
3 → 1477, and 5 → **572**. Each closure re-permutes the ring, so an
intermediate candidate can look far worse than the one before it. Confirm on
raw words only at full closure.

### 14. Temp-FIFO phase -- perturb the preceding block

**Diff looks like:** `verdict: phase-shift`, `playbook=temp-fifo-phase`, and a
temp lane with a constant `rotation=+N` tail. Frequently paired with
`prefix-exact@N` -- the bytes agree right up to the surfacing point.

```c
/* before */  animApply(base + (index * 20), flags);
/* after  */  s32 slot = base + (index * 20);
              animApply(slot, flags);
```

**Why:** hoisting a call-argument expression into a named local changes the
order in which values die, and value deaths are what push temps back onto the
free list. One reordered death shifts the whole downstream rotation by one slot.
Proven on `modLoadAnimActual`, which matched in roughly 15 directed variants
once the lane view existed -- against 300 variants of nothing before it.

### 15. The phantom pop

**Diff looks like:** as lever 14, and you need `+1` pop rather than a
reordering.

```c
/* materializes a pool get, emits no instruction */
if ((state == -1) != 0) { ... }

/* these are dropped entirely - zero codegen effect */
id == id;
(void)(x & mask);
```

**Why:** a comparison that feeds a *real* context materializes a temp pop that
the assembler then folds away, so the queue advances without an instruction
appearing. A bare discarded expression is eliminated before it can do anything.
The distinction is the whole lever.

**Two preconditions, both learned the hard way.** The value must already be
live in a register, and the guard must fold. Boolean-normalizing an *actual*
branch condition is not free: `(a < b) != 0` defeated `bltz`/`bgez` folding and
cost **+178 words** on `texLoadTextureActual`. On `blockSetupVertices` every
guard spelling emitted real code and grew the frame. Verify with `view` after
one variant; do not build a family on it.

### 16. The redundant-mask lever

**Diff looks like:** a one-slot temp-FIFO rotation, *and* neighbouring
statements carry asymmetric mask or cast decoration.

```c
/* before */  v->x = (s16)fx << 18;
/* after  */  v->x = ((s16)fx & 0x3fff) << 18;
```

**Why:** a mask that is a no-op at the assembler still consumes one ugen pool
get before as1 folds it away -- a genuinely zero-instruction FIFO rotation,
which the `(x) != 0` guards of lever 15 usually are not. This is the reliable
free phantom pop. It matched `blockSetupVertices`.

**Treat it as a one-variant hypothesis, not a search.** And read the smell:
decoration asymmetry between neighbouring statements in *your* candidate is
itself evidence, because the original author's code is usually symmetric.
Symmetrize the decoration first and see what happens.

---

### 41. Buy or sell a ring pop with the construct that costs one

**Diff looks like:** `lever: temp-ring` with a rotation in the temp lane, and a
`--ring-trace` reporting one source line whose pops do not match the target's
advance.

[Lever 15](#15-the-phantom-pop) and [lever 16](#16-the-redundant-mask-lever)
buy a pop with a mask. Three further constructs move the same counter, and
unlike a mask all three are ordinary code:

| Construct | Costs |
|---|---|
| reading a struct field **through a local** rather than at its use | one pop the direct read does not |
| an index scaled **twice** (type the table as pairs and index the pair) | one more pop than the same access scaled once |
| a **fused** `x = a + b * c` rather than `x = a; x += b * c;` | one pop, and one pool web, against the split form |

The third is the one to reach for when the **pool** lane differs in *length*
and not only in content: that is a web population difference, and no rotation
lever fixes it.

**Check the construct on the charged line before you believe the family.** The
pop count names the line; it does not name the law. Each rule above was
measured on one construct, so pass the candidate's C with `--source` and read
`constructs_by_line`: a charged line reported `constant` or `unclassified`
qualifies for none of them, and the block says so instead of naming the nearest.
A field test spent three builds on `read-the-field-directly` for a line whose
local held a cast integer constant; all three spellings compiled
byte-identically, because L76 is measured on a struct field.

**Two pops off means two of these, and neither works alone.** On the function
that established the first two, each lever on its own scored *worse* than the
plateau -- 25 differing words against 8 -- and composing them was exact. A
bounded permutation over single edits cannot find that pair, which is why the
pop lines are read rather than searched.

**A control that costs one build.** If you suspect a statement split is
actually a scheduling effect, write the same split as one comma-joined physical
line. Byte-identical means the mechanism is the ring, not the line
([L78](compiler-laws/ido-5.3.md#l78-a-pool-carried-accumulate-keeps-a-field-in-its-web-the-fused-form-spends-a-temp)).

**Points here:** `lever_class=temp-ring` from `diagnose --ring-trace`, and
[L76](compiler-laws/ido-5.3.md#l76-a-struct-field-read-through-a-local-costs-one-ring-pop-a-direct-read-does-not)/[L77](compiler-laws/ido-5.3.md#l77-an-index-scaled-twice-costs-one-more-ring-pop-than-an-index-scaled-once).

## Coalescing copies

**Diff looks like:** the residual is exactly one `move rd,rs` (or
`or rd,rs,$zero`) present on one side and absent on the other, plus a
consistent register substitution downstream that unifies the two sides.

### 17. K&R implicit-int return type

**Gate:** use this for either of two measured shapes:

1. the residue contains an actual `move`/copy-shaped site; or
2. `check-scratch --view --project-object ...` reports a late, coherent
   `$v0↔$v1` pool web after a direct call, the scratch declares that callee
   `void`, opcode/temp shape is stable, and the normal project object is exact.

A generic register bijection after a call is not enough. The second route is a
conservative one-variant probe for invisible return-register occupancy, not
proof of the historical prototype. C++ and frontends without C89 implicit
declaration semantics are excluded.

```c
/* before */  void objprint(struct Obj *o) { ... }
/* after  */  objprint(struct Obj *o) { ... }      /* K&R implicit int */
```

**Why:** 1999-era sources routinely declare functions with no return type, and
`void` versus implicit `int` changes ugen's coalescing decision -- on `objprint`
an entire `move` instruction appeared only under the non-void return. A second
campaign exposed the invisible form: an unused call return still occupied
`$v0`, which changed a later pool web from `$v0` to `$v1` without emitting a
move at the call.

**When a candidate is exactly one coalescing copy short, try this before
anything else.** It is one variant. Patch the declaration *and* the definition:
a mismatched pair compiles-fails silently in some harnesses and gets recorded as
a negative result that was never actually tested.

### 18. CSE multiplicity

**Gate:** use this only when the residue contains an actual `move`/copy-shaped
site and the source visibly repeats the same expression. Do not infer
"twice-referenced" from a register appearing at several assembly sites.

```c
/* before */  a = f(p->q); b = g(p->q);        /* p->q referenced twice */
/* after  */  t = p->q; a = f(t); b = g(t);    /* single occurrence */
```

**Why:** under equal instruction shape the coalesced copy lands on the
multi-referenced CSE temp, so making an expression single-occurrence through a
named intermediate moves the copy onto the other value. This is the second lever
to try when lever 17 does not move it (`objprint`, layer 2).

Be aware that these two can be mutually exclusive -- on `objprint` the two
levers each fixed one half of the residual and no source form did both. When you
hit that, you are at the boundary of source search.

With an instrumented uopt, run `trace-copy-decisions` before building a source
grid. The command reads every available snapshot and reports the first observed
`COALESCE -> TEMPCOPY` transition. A transition directly bracketed by
`pre-makelivranges` and `post-makelivranges` names `makelivranges` as the owning
pass; a `pre-reemit` snapshot alone only locates the final symptom.

Do not turn trace hash occupancy into a source claim. `rhs_hash_bucket` and its
reported occupancy are collision-prone table observations. They do not prove
that the RHS expression occurs twice in C. Lever 18 still requires a visibly
repeated source expression. Likewise, a basic-block formation witness is
correlated evidence, not proof that clearing that set will suppress one web
without changing the rest of liveness.

When spelling, declaration, and initializer grids plateau, run them through
`campaign --show-basins`. If hundreds of variants collapse to a handful of
identical object basins, stop permuting that frontend family and report the
equivalence classes. The basin count is the result; the raw variant count is
not progress.

---

## When source search is over

### 19. Callee-saved tie-breaks and the forced-color oracle

**Diff looks like:** `verdict: register-permutation` -- every register
difference forms one consistent bijection -- typically over callee-saved
registers (`$s1` versus `$s2`).

**Why source cannot reach it:** the choice is a priority-order tie-break
between two webs inside uopt's coloring, and source reorderings either
canonicalize away or explode into unrelated changes. On `func_80053B24` the
high-priority web (save 833) took `$s1` and the deferred one (save 0.67) got
`$s2` by elimination; forcing only the high-priority web let the swap cascade
naturally.

Keep three observations separate: formation rank is construction chronology,
`save`/`nocs`/`totalsave` are measured economics, and decision-trace ordinal is
the observed `p1dec`/`p2dec` selection sequence. None is interchangeable with
the others or sufficient source-cause proof by itself.

Two of those fields do not mean what their names suggest, and one campaign
ranked webs by the wrong quantity before checking. `nocs` is the pass's
*compressed* occurrence divisor, `((n - 2) >> 2) + 2` for `n` occurrences, not
`n`: `save * nocs` is therefore not "saving times uses". And the `class` field
in a decision record is the IR register class (integer versus floating point)
from `regclassof`, not the save class -- the class-1/class-2 verdict that
decides whether a web is a colouring candidate at all is decided earlier, in
`compute_save`, and no shipped record reports it.

This distinction mattered in one recorded `func_802963D0_6A7A80`
campaign. A
cancelled hot use formed a hidden web before the visible pointer and gave it
`totalsave=101`; a side-effecting bridge formed it later and raised it to
`2990`, yet reached the same downstream allocation while emitting unwanted
instructions. A separate late instrumentation-only cost overwrite did *not*
reorder anything because the allocator's list had already been established. A
useful priority probe must act before list/queue construction, or compare
natural paired builds; a late field overwrite cannot prove that the metric is
irrelevant.

That one-web example is not a cardinality rule. A one-bijection assembly diff
is one *visible downstream outcome*; it does not prove one source web or one
source edit. In that campaign, the same-looking residue required
three optimizer-erased webs at two nested-loop boundaries to occupy `t5`, `s1`,
and `s2` before the real pointer was colored. Pairwise and same-boundary dead
locals all failed. Use forbidden-color producer evidence to measure the
smallest causal set; if it is several webs, search their lifetime topology as a
composition rather than forcing only the first one and declaring source search
over.

**What to do instead:** if your project has an instrumented static-recomp IDO,
go straight to a forced-color probe rather than more variants --
`decomp-workbench diagnose ... --trace uopt.log --trace-proc N` will read that
trace for you and print an `ownership:` line saying which pass owns the
residual and whether a lever reaches it at all, with `ownership_basis=trace`
rather than `heuristic` ([the ownership line](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/view.md#reading-the-screen)). If
it does not, this class is a legitimate stopping point for **hand** search --
but hand search is not the whole search. No *hand* lever found means a permuter
target: run `decomp-workbench permute-doctor <function>` and then
`decomp-workbench permute-sweep` before recording anything
([permuter sweeps](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/permute-sweep.md)). Two residuals argued unmatchable from verdict prose -- an
interference-forbidden colour and a list-scheduler slot-fill with no source
lever -- were matched by a twenty-minute permuter run after a bespoke
instrumentation build had been funded to explain why they could not be. An
allocation tie is never *proven* unmatchable by two disassemblies; it is
unmatchable **by hand**, which is a claim about the lever set, not about the
function. Record a wall only after a measured search has been flat
(`decomp-workbench permute classify`). Then bundle the scratch and move to the
next function.

**One trap, because it cost a campaign a full round:** the instrumented pass
has *two disjoint web namespaces*, `p1` (callee-saved) and `p2` (caller-saved).
A sweep is exhaustive only if it covers both. A `p1`-only sweep once produced a
confident "this is ugen's fault" conclusion when the answer was a `p2` web, one
force from exact. The workbench now requires phase-qualified force keys
(`p2:w55=c2`) for exactly this reason. See
[Trace analysis](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/trace-analysis.md).

**A second trap, now defused:** forcing a color the web's interference mask
already forbids used to abort the compiler. The pass now declines the force,
records `force_declined … forbidden=0x…`, and lets the natural coloring stand,
so a sweep runs to completion and the declines tell you which endpoints do not
exist. Read them ahead of time from `trace-globalcolor`'s `forbidden_colors`
on any logging run. See
[Compiler instrumentation](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/compiler-instrumentation.md#a-forbidden-color-is-declined-not-fatal).

---

### 43. Read the proof before re-deriving it

**Diff looks like:** `lever: unreachable`, or a `see_also` naming one of the
proofs below.

Four residual classes have been closed by ruling them out, each at the cost of
a day and a dozen builds. They are levers in the sense that matters most: they
tell you what not to spend.

| Proof | What it says | What reopens it |
|---|---|---|
| `as1-readiness` | the two instructions are separated by readiness, not by their lines; in a block of *N* pre-branch nodes whose branch is ready at cycle *N*−1 exactly one node is left over, and a leftover always wins the delay slot | a model of as1's `besttime`, so the node set can be reasoned about forward |
| `uopt-address-folding` | an address fold follows what is live where the value is formed, not where the definition is written -- below the stores, in the loop init clause, and removed entirely all leave it intact | a shape in which the target pointer is not a constant offset from a live base at that point |
| `uopt-coalescing-tie-break` | the web is coloured on a tie between the call's argument register and its return register, and the locals the pool lane suggests merging are already coalesced | a forced-colour probe (CDX), which decides the tie directly |
| `cfe-pointer-add-order` | at one pointer-add expression, typed-pointer commutations, casts and assignment forms are recorded exhausted; byte-offset arithmetic *did* move the temp order, and was kept, but to mask/scale/pointer where the target wants mask/pointer/scale | a source form yielding mask, pointer, scale -- the one order no tried spelling produced |

Two of these are reported as **measurements**, and when they are, the class is
`unreachable` rather than `none-known`. `as1-readiness` needs an `--as1-trace`
whose selections are all decided above the line key.
`uopt-coalescing-tie-break` needs only what two disassemblies already carry:
the colourer owning the residual, and one consistent web substitution across
its sites between the registers a call takes its argument in and returns in.
A lone `s0`->`s1` web is also one web under the colourer, and this proof says
nothing about it. The other two describe shapes a disassembly cannot
distinguish, so
they stay under `see_also` -- each with an `applies when:` line stating the
shape it was measured on, for you to check.

That promotion exists because the alternative was measured. A field test met
`none-known`, three `capture:` lines and this proof as a footnote, read the
proof, and spent one build to confirm it: the carrier coalesced away
byte-identically, exactly as the proof says. The build was the cost of printing
a met proof as background.

**And a correct `none-known` is worth as much.** In the same field test
`func_8003A2C8` returned `none-known`, `routing=permuter-first`,
`reachability=permuter-target`, with the note that one of its five
substitutions wants `t6` -- a register the era's colouring pass never hands out
([L64](compiler-laws/ido-5.3.md#l64-the-integer-temp-ring-is-seeded-t6-t7-t8-t9-t0--t5)).
No build was spent, and none should have been: a ring-only target register is a
measurement no hand lever can argue with, and the routing had already named the
tool that can. Declining to guess is an output, not a gap.

**And "unreachable" is still not a wall.** Every one of these is a statement
about *hand* levers. Run
[the permuter](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/permute-sweep.md) before recording any of them as final.

**Points here:** `lever_class=unreachable` from `diagnose`, and
[L75](compiler-laws/ido-5.3.md#l75-the-temp-order-at-a-pointer-add-what-moves-it-and-what-the-record-says-does-not),
[L79](compiler-laws/ido-5.3.md#l79-a-selection-decided-above-lineno-has-no-source-lever),
[L81](compiler-laws/ido-5.3.md#l81-address-reassociation-is-insensitive-to-where-the-definition-is-written),
[L82](compiler-laws/ido-5.3.md#l82-an-argumentreturn-coalescing-tie-is-not-a-source-form).

### 45. Repeat the field read to buy the register-to-register copy

**Diff looks like:** `lever: carrier-count` -- the target loads a field into a
scratch register and copies it into a saved one; the candidate loads it once
into the saved register and never emits the copy. Instruction counts differ by
exactly the copies, and every later relocation is shifted by that index.

[Lever 40](#40-de-declare-a-value-so-it-takes-a-compiler-temp-home) repeats an
*expression* to move its home out of the declared block. This is the sibling
edit with a different effect: repeat the **field access** and uopt commons it
as a CSE but keeps *two live carriers*, and materialising the second carrier is
the copy.

```c
/* before -- one carrier, no copy */
s32 phase = state->phase;
seed(phase);
advance(entity, phase);

/* after -- the second spelling commons to the same value but leaves the
   scratch load live, so the copy into the saved register is emitted */
seed(state->phase);
advance(entity, state->phase);
```

A cached local is exactly what suppresses this, which is why the intuitive
"avoid the redundant load" edit moves the residual the wrong way. Measured on
The reference campaign's `func_8001D960`: **196 to 27 differing words** on this edit alone,
because the one missing instruction had been shifting every later relocation
by an index. The function matched from there.

**Do not confuse it with a dead read.** Levers 8 and 9 cover a genuinely dead
load placed to move priority; this one's value is consumed twice and the
second read is not dead at all.

**Points here:** `lever_class=carrier-count`, and a relocation count that
matches while the instruction count does not.

### 46. Census the declarations before reading the frame as an allocation defect

**Diff looks like:** `lever: frame-size` or `lever: stack-home` with the frame
off by a multiple of 8 and several homes displaced together.

The declared-local list is a frame instrument twice over. Its **length** sizes
the local block in 8-byte steps; its **order** fixes every home at
`frame_top - 4k`. So a frame delta is a declaration-count question before it is
an allocation question, and displaced homes are an ordering question.

The procedure is mechanical, and beats searching:

1. Census the target's stack displacements for call-crossing values.
2. Count them. That is the local block's size, and therefore the number of
   declarations the source needs.
3. Order the declarations so each lands on its measured displacement.

Dropping one m2c-only local moves the frame while the instruction count barely
changes -- which is the signature that tells you the frame, not the body, is the
defect. On the reference campaign this closed five homes in one function and the entire frame
of another (`0x120` to `0x108`, four m2c-only locals), and it was the dominant
lever across two whole translation units.

Every declared `f32` or pointer local reserves a stack home whether or not it
is register-coloured, so an unused declaration still costs frame.

At `-O2` the whole thing is an equation:
`frame = roundup8(outgoing + saved + 4*temps + locals)`, locals top-aligned --
**but an `s16` local takes two bytes, not four.** That single exception is what
makes a missing narrow local invisible and makes every add-a-local probe grow
the frame by the wrong amount.

The displaceable compiler temporaries are loop-invariant CSEs in a loop's
*controlling condition*, and there is a cheap detector for them: delete the
loop. If the aggregate's home drops by 8, that condition owns two temps.

**Points here:** `lever_class=frame-size` with the instruction counts close,
and [lever 26](#26-recover-stack-homes-without-losing-the-live-range-topology)
having already been spent.

### 47. Screen a per-TU flag off the target, then decide it by measurement

**Diff looks like:** a residual that will not converge however good the C is,
across *several* functions in one translation unit.

A per-TU compiler flag makes every candidate in the unit wrong by a constant,
so it reads as many separate function-level walls. Some flags have a local,
recognisable codegen signature and can be screened straight off the
disassembly, with no compilation: IDO under `-Wab,-r4300_mul` separates two
adjacent single-precision multiplies with a scheduler nop, and counting those
takes seconds where searching the flag lattice by compiling takes hours.

**But a screen is not a verdict, and this one is the cautionary case.** Every
translation unit in the reference campaign that has such a pair shows the nop -- 51 of 51 -- so
the signature is necessary and cannot discriminate. Setting the flag on the six
units the screen named split them exactly evenly: three improved (−15, −23, −27
masked words) and three regressed (+28, +13, +8), and the unit with the
*strongest* signature in the tree was the worst regression, driving one
function backwards out of its class.

So screen with the signature and decide with measurement:

1. Set the flag on **one** unit.
2. Rebuild and confirm the ROM is still byte-identical. That proves no
   already-matched function in the unit moved, and it is cheap.
3. Re-measure the queue and keep the flag only if the unit's masked words fall.

Step 3 has a trap of its own: a ranking tool that caches per-function scores
will republish them unchanged after a flag edit unless you ask it to
*re-measure*. A real change looking like no change is usually this.

**Points here:** several functions in one unit stalled together, and
[lever 3](#3-rebuild-the-same-candidate-with--g0-and-compare-again) already
falsified.

### 48. Cross-check a positional score against a shift-tolerant one

**Diff looks like:** a large differing-word count on a function whose
instruction selection is obviously close, and especially any *comparison*
between two candidates or two flag sets on such a function.

The differing-word metric is positional: it compares row *n* against row *n*.
A single inserted or deleted instruction renumbers every row after it, so a
candidate that is correct everywhere except for one early insertion scores as
though it were wrong everywhere. The metric is accurate about identity and
misleading about magnitude, and it is **actively wrong for ranking**.

Two measurements from one campaign day, on different functions:

- On a 6300-byte overlay function a pure alignment shift moved the positional
  score by **173 words** while the count of exactly-identical rows did not move
  at all.
- On an 11 KB function `flag_sweep` ranked `-O2 -g3` first on positional words
  (2507 against 2511) when the alignment-aware counts put it clearly last --
  1752 non-exact rows against 1674, and 338 structural rows against 255. **A
  flag decision taken on the positional score alone would have been backwards.**

So before any comparison on a function with alignment shifts, get a
shift-tolerant number:

1. Align the two instruction streams under a diff that tolerates insertions,
   rather than by index.
2. Count **exactly-identical rows** and **structural rows** (insertions plus
   deletions). Those two move for real reasons; the positional count moves for
   bookkeeping reasons too.
3. Report the running shift. If it stays within a few words across the body and
   keeps returning to zero, the residual **re-converges** and the function is a
   dense local defect, not a structural mismatch -- whatever the verdict says.

That last reading is worth having on its own: `structure-mismatch` is often an
artefact of positional comparison across an early insertion. Three separate
whale-sized functions were reclassified this way in one day, each turning out
to be a register-naming problem with 93%+ mnemonic agreement.

**Points here:** any residual over a few hundred words, any flag comparison,
and any verdict of `structure-mismatch` on a function whose mnemonic census is
close.

### 49. Replay the assembler phase to find out whether C can reach the residual

**Diff looks like:** a small, stubborn residual that survives every source form
you can think of -- and, in particular, one you suspect is decided after the
compiler proper has finished.

`ugen` accepts `-l <file>` and writes its output as **text**; that is what
`cc -S` uses. Re-assembling that text with `acpp` + `as0` + `as1` reproduces
the compiler's own object **byte for byte** -- but only under the *compiler
path's* `as1` flags. The driver's own `.s` path is not equivalent: it adds
`-pic0 -noglobal`. Drop those two and the round trip is exact.

That turns the last phase from an opaque step into a searchable space: edit the
listing, re-assemble, score. Combined with a direct `cc` loop
([lever 47](#47-screen-a-per-tu-flag-off-the-target-then-decide-it-by-measurement)'s
companion technique) one campaign measured **~500 scored candidates per
second** -- 720 declaration orders in 3.5 s, a 3,840-cell lattice in 17 s.

**Its most valuable use is the negative.** Feed `as1` the candidate's own
listing with one hand edit applied -- on the reference campaign's `overlay11UpdateMenu`, two
spill stores exchanged -- and if the result reproduces the target exactly, you
have positively proved that the rest of the C is already correct and that this
one difference *is* the whole residual. Then ask whether any C could produce
it. There the answer was no:

- `ugen` already emitted the pair in the target's order; `as1` exchanged them.
- `ugen` orders caller-save spills strictly ascending by register -- **73 of 73**
  comparable sites in that tree, including 38 where register order and home
  offset disagree. The target needed descending.
- The only barrier that blocks the exchange is a `.loc` naming a *greater* line
  between the two stores, and `ugen` emits at most one `.loc` per statement
  while both spills belong to the same call statement.

So the function is not source-reachable at those flags, and twenty further
source forms would have held at the same score. **Recording that is worth more
than a match on a different function**, because it stops every future worker
from re-searching a space that provably contains no answer. Reopening such a
target needs a new *input* -- a compile mode that changes the assembler's memory
disambiguation or debug context -- not another spelling.

A second reading falls out of the same replay: an operand appearing in `$at`
outside a `.set noat` sequence is an **`as1` constant-multiply expansion**, not
anything `ugen` chose. It tells you the source multiplies where you may have
written a shift.

**Caution:** `cc -S` writes `<basename>.s` into the *current* directory and
ignores `-o`, so any parallel harness must run it in a private cwd.

**Points here:** a residual under ~5 words that survives a wide source sweep,
and any question of the form "can C even express this?".

### 50. Resolve addresses to link-time values before believing a residual

**Diff looks like:** a small register-only or operand-only residual on a
function whose logic you are confident about -- especially one that has survived
several work packets unchanged.

**It may not be in the code at all.** splat spells an address as a `%hi`/`%lo`
pair of a *named symbol* only when it has a symbol to name and the two halves
sit together. Otherwise it emits the literal form:

```
    lui   $v0, (0x800C9464 >> 16)
    addiu $v0, $v0, (0x800C9464 & 0xFFFF)
```

which carries **no ELF relocation**. A comparator that masks relocation words --
which is what "relocation-masked differing words" means -- sees a relocated word
on the candidate side and a literal on the target side, and reports a
difference that will not exist after linking.

Two independent measurements on the same campaign day, by different routes:

- **The halves straddled a branch.** The `lui` was hoisted above an early-return
  test and the load sat after it, so splat could not pair them. The candidate
  spelled the address back as `(s32 **)0x800C9464`, and *every* object-level
  scorer in the project -- workbench, permuter, and the ranking's masked words --
  reported the register difference a literal-address load makes and a global
  load does not. That phantom two-word residual survived **three work
  packets**. Writing it as `&D_800C9460[1]` gave IDO the one-register global
  idiom and the linked words were identical.
- **splat minted no symbol** for an overlay-local address. That accounted for
  the *entire* reported residual of one function and 4 of another's 10.

So before working a small residual: resolve every address materialization on
both sides to its link-time value and compare those. If the residual
disappears, it was bookkeeping.

**The mirror trap, which is why you cannot simply mask every `>> 16`:** the
identical syntax with a full 32-bit constant -- `0x41F00000 >> 16` -- is a
**float immediate**, not an address. Masking it hides a real difference. Tell
them apart by whether the value resolves to a mapped address in the linked
image.

**Points here:** any residual under about 10 words that has outlived more than
one attempt, and any `lui` whose operand is a literal rather than a symbol.

### 51. Give the loop an index, not a hand-written cursor

**Diff looks like:** a register-name residual on a loop that no lattice moves --
declaration order flat, line grouping flat, placement flat. The instruction
count is often already exact.

The cursors IDO emits are **uopt's own strength-reduced induction variables**,
derived from an index. While the source spells the cursors out by hand, the
allocator sees a different set of webs than the target had, and no permutation
of that source can reach the target's register names. The lattice is flat
because you are searching the wrong space.

```c
/* before -- four hand-written cursors, floors at 11 differing words */
u8 *flags = &state->flags[0];
Entry *entry = &state->entries[0];
s32 *timer = &state->timers[0];
while (count--) { ... *flags++ ... entry++ ... *timer++ ... }

/* after -- one index over the parallel arrays, exact */
s32 i = count;
while (i--) { ... state->flags[i] ... state->entries[i] ... }
```

Measured on the reference campaign's `src/main/fx.c`, where this closed **three functions in
one pass**: 11 → 0, 15 → 0, and (as `p += 0x28` → `i * 0x28`) 20 → 0. On the
first of those the hand-cursor form was proved to floor at 11 exhaustively --
all 720 orderings of its six setup assignments against all 32 physical-line
groupings.

Rewriting it also produces, in one step, effects a plateau may have recorded as
several separate walls: the loop index's now-dead copy taking the *first* pool
colour, the synthesised trip counter taking the second, a byte offset shared
between two arrays, and a base materialised inside the loop rather than before
it.

**The converse is a real reading too.** If every indexed form is dramatically
worse -- one block measured 96 words against 5 -- the cursor genuinely is in the
source, and that is positive evidence rather than a failed attempt. Straight-
line code with no loop has no induction variable to recover.

**Two neighbours found with it:**

- **A local's integer width reorders the ugen temp ring.** Two texture extents
  as `s16` against `s32` were sixteen of one function's twenty words, and
  nothing about placement or inlining reaches it.
- **An extra *coalesced* named web costs no instruction and moves FP colours.**
  Naming both results of a rotation, not just the one the next statement
  consumes, fixed a six-word f2/f14 swap. It is a web-*count* fact, which is
  exactly why the whole ordering lattice was flat. FP webs ignore declaration
  order just as integer webs do -- 6,000 random permutations, none better.

**Points here:** `lever_class` register-only or colour-only on a loop, with
the instruction count already exact and the ordering family already spent.

### 44. Read the pool lanes' lengths before calling anything a rotation

**Diff looks like:** `lever: pool-rotation` or `lever: pool-population` -- a
colour-only residual with the same instructions on both sides.

**Step one is arithmetic, not judgement.** Compare the two pool lanes'
*lengths*. Equal lengths are the precondition for calling a residual a
rotation. Unequal lengths are a **population** difference: one side colours a
value the other leaves in the temp ring, and no colour reaches a web that does
not exist. `overlay43FilterImage` was recorded as "one cyclic pool rotation"
for as long as nobody compared them -- 18 target slots against 15, with the
temp lanes correspondingly 18 against 21. Forcing the rotation to the target's
colours made the first five pool slots exact and improved 33 words to 26, and
raised opcode mismatches from 8 to 10.

**Step two needs a capture, and there is no reading it off the diff.** Two
sweeps colour a procedure and they do not share an order
([L83](compiler-laws/ido-5.3.md#l83-p2-visits-webs-in-web-number-order-and-the-save-cost-is-inert-there),
[L84](compiler-laws/ido-5.3.md#l84-p1-is-repeated-max-save-selection-the-web-number-breaks-ties-only)):

```sh
CDX_LOG=1 CDX_OUT=cdx.log CDX_PROC=1 make build/work.o     # the TU, once
decomp-workbench diagnose target.o build/work.o --function step \
  --ladder cdx.log --lever-proc 1
```

| Owning sweep | What it orders on | What the lever is |
|---|---|---|
| `p2` (caller-saved) | ascending web number, lowest free colour; the save is computed and ignored | renumbering, and nothing else |
| `p1` (callee-saved), webs **tied** on save | the web number, inside the tie group | renumbering *if anything*; a tie alone does not make the pair separable |
| `p1`, webs across a save boundary | the save | the cost -- use counts or loop depth, which moves the instruction stream, so rank it last |

The block names the tie group, its save and its members. For a **p2** pair it
also reads a direction off the lowest-free-colour rule -- between two contested
colours, the web that must end up with the *lower* colour would have to be
visited first -- and offers it as a reading of the rule, not as a measured
lever: no recorded edit has yet reordered a pair. For a p1 pair it names no
direction at all, because lowest-free-colour is recorded for p2 and not for
p1. And a tie is the tie-break, not a promise: webs 13 and 22 of
`overlay4UpdateObjectMotion` tie at save 1.5 with identical interference
records, do not interfere, and are not colour-reachable.

**Step three, the one spelling that has been measured to move a web number:**
declare the truncated local at its narrow type and drop the explicit cast, so
the truncation happens at the store
([L85](compiler-laws/ido-5.3.md#l85-a-truncation-written-at-the-store-renumbers-its-synthetic-temp)).
Four that do not move one -- declaration order, relational operand order, an
added local, and a hoist that bought the interference and still lost the
number -- are in
[L86](compiler-laws/ido-5.3.md#l86-four-spellings-that-move-no-web-number),
and the third of them costs a stack home.

**Confirm with a second capture, always.** Both spellings tried from the
numbering model on `overlay4UpdateObjectMotion` were plausible and neither
moved a web number: cfe had already coalesced the store one of them depended
on, and only an upstream web shifted. The capture costs nothing and would have
saved both builds. The block refuses to name a renumbering edit without asking
for it.

**And ask the force oracle whether the colours are legal at all.** `words=0`
under a recorded `CDX_FORCE` is the strongest verdict available for a register
residual: it says the whole residual is colours, every one of them is legal,
and what is missing is a spelling.

```sh
decomp-workbench diagnose target.o build/work.o --function step \
  --ladder cdx.log --force-result sweep.json --lever-proc 1
```

On `overlay4UpdateObjectMotion` three pinned colours took an 8-word residual to
`words=0`. That did not match the function -- the source lever for the last of
the three has not been found, and
[L86](compiler-laws/ido-5.3.md#l86-four-spellings-that-move-no-web-number)
says why -- but it separated "one spelling away" from "not available in this
web graph" for the cost of one build.

**Points here:** `lever_class=pool-rotation` or `pool-population` from
`diagnose`, and
[L83](compiler-laws/ido-5.3.md#l83-p2-visits-webs-in-web-number-order-and-the-save-cost-is-inert-there),
[L84](compiler-laws/ido-5.3.md#l84-p1-is-repeated-max-save-selection-the-web-number-breaks-ties-only),
[L85](compiler-laws/ido-5.3.md#l85-a-truncation-written-at-the-store-renumbers-its-synthetic-temp),
[L86](compiler-laws/ido-5.3.md#l86-four-spellings-that-move-no-web-number).

## When the compiler itself is the variable

**Diff looks like:** a dispatch or convention the project compiler provably
cannot emit (wrong jump-table arity, wrong chain order, wrong compare
operand order), clustering by translation unit while neighbors match
byte-for-byte; or a residual that hundreds of spellings never move while
the surrounding schedule is exact.

### 20. Frontend lineage check

Before concluding "hand-patched object" or shipping a modified compiler,
test the *other authentic frontends* that feed the same backend: `accom` /
`ccom` (IDO ≤4.x, jump-table threshold **4** where cfe's is 5), `upas`
(Pascal, tables dense `case`s from N=2). Cross-generation ucode handoff
works -- a 4.1 frontend's `.B`+symtab feed a 7.1 `uopt/ugen/as1` directly --
so the deviant TU can share the byte-exact backend with the rest of the
ROM. Run the fingerprint atlas first (thresholds, chain order and layout,
const-first compares, the s16 strength-reduction signature); porting whole
functions comes after a fingerprint matches. See
[Alternate authentic frontends](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/alternate-frontends.md). On one IDO 7.1
project's ovl8 this turned a proven-impossible `sltiu at,a0,4` into words=0 through
unmodified, community-archived binaries.

### 21. accom line placement

Under `accom`, source **line numbers are semantic**: two token-identical
bodies that differ only in newline placement compile to different
schedules. When a residual under an accom-lineage frontend survives every
expression respelling, bisect *whitespace* -- join the statement cluster
around the mis-scheduled instruction onto one line and re-split until the
schedule flips. One campaign's terminal two-word residual (a copy/load
order in a branch delay slot) was exactly this, isolated by bisecting a
minimal probe against the generated body until only a newline differed.

### 22. Dispatch construct discrimination

Sorted test order with dispatch-first layout is a cfe `switch`; sorted
with bodies-first is accom's; a value-split tree is `upas`; **source
order is not a switch at all** -- no frontend in the accom→cfe family
preserves case order -- it is an `if / else if` (or goto) chain. In-loop
if-chains with hoisted constants compare **const-first under accom**;
under cfe, const-first is only reachable when the compared expression is
a global on the left. Classify the dispatch before spending variants on
the wrong construct: two prior campaigns fought a "switch" for weeks that
was never a switch.

## When the preprocessor is the variable

One stage earlier than the section above: not which compiler ran, but what the
compiler was handed.

### 23. Preprocessor line assignment

**Diff looks like:** an equal instruction multiset in a different order with
register allocation identical -- `verdict=schedule-mismatch` -- on a `-g0`
build, so [lever 3](#3-the--g0-diagnostic) has nothing left to collapse and
every compiler version you try produces the same output.

```bash
# Replace these example arrays with the translation unit's exact arguments.
cpp_flags=(-DVERSION_US -Iinclude)
compiler_flags=(-O2 -mips2)

# IDO's external preprocessor, then compile the preprocessed unit.
acpp "${cpp_flags[@]}" file.c > file.i
cc -c "${compiler_flags[@]}" file.i
```

**Why:** cfe takes each statement's source line number from its *preprocessed*
input, and uopt/ugen treat a statement line boundary as an instruction
scheduling barrier -- **at `-g0` as well as at `-g3`**. Line numbers are an
input to the schedule even when no debug record reaches the object. cfe's
internal cpp attributes every statement of a multi-line macro expansion to the
invocation's *first* line; IDO's external `acpp` attributes them to the
invocation's *successive* lines. Same token stream, two line assignments, two
schedules.

The evidence is in the listing ugen writes (`ugen -l`, or the `.s` the driver
keeps with `cc -K`). At one divergent site the internal-cpp build read:

```
	.loc	2	200
	sw	$a1, 12($a0)
	.loc	2	200
	lui	$t2, 0x1234
```

and the acpp build read:

```
	.loc	2	211
	sw	$a1, 12($a0)
	.loc	2	214
	lui	$t2, 0x1234
```

Only the second scheduled the store *between* the `lui`/`ori` halves of the
next statement's constant -- which is what the retail ROM does.

**Measured:** an IDO 7.1 project's `drawbitmap`, 1479 instructions: 59 schedule-swapped words
→ 0 under `acpp` preprocessing. Every IDO era tested (5.2, 5.3, 6.0, 7.1,
MIPSpro 7.4.4) and every `as1` flag and pipeline model produced identical
output given the same `.i`, so this lever -- not the compiler version -- owned
the residue. The compiler-era hunt that preceded it was a total red herring,
and it cost hours.

**Measure before you spend a build.** `decomp-workbench diagnose TARGET.o
CANDIDATE.o --candidate-listing LISTING.s` reports, per schedule-divergent
site, whether the reordered instructions straddle a `.loc` change, and routes
to this lever when most of them do.

**No `acpp`?** The cheaper form of the same experiment is a token-identical
line reflow: put the divergent statements on their own source lines, changing
newlines only, and rebuild. It is a coarser dial than swapping preprocessors,
but it moves the same variable.

**Points here:** `verdict=schedule-mismatch` with identical allocation,
`playbook=line-assignment-probe`, and any `-g0` build whose lever 3 probe came
back empty.

**Scope anything you conclude is impossible.** A line-number bisection measures
one statement order and one physical layout. "No layout reaches the target" is
a fact about the variants you built, not about the language -- see lever 25,
which is the counterexample that cost us a published claim.

### 25. Line-number ties by splicing

**Diff looks like:** `verdict=schedule-mismatch` you have already localized to
statement line numbers (lever 23), where the target needs some statement to
carry a line number *less than or equal to* one that is textually above it --
typically a statement just below a block that must be scheduled as though it
were inside the block.

```c
    var_s3 = sp14C;               /* legal hoist: now at or above line L      */
    ...
    bytecsr = out_buf;

    if (temp_s1 <= 0)                                            \
    {                                                            \
        temp_s1 -= 0x8;                                          \
        temp_s2 <<= 0x10, temp_s2 |= *(csr++), temp_s1 += 0x10;  \
    }                                                            \
    sp134 = (temp_s2 << (0x18 - temp_s1)) >> 0x18;   /* gets the `if`'s line */
```

**Why:** cfe numbers each statement by the *logical* source line it starts on,
and a logical line is what survives translation phase 2 -- backslash-newline
splicing. Statements that share a logical line share a line number. So the
sequence of statement line numbers a natural layout can produce is
non-decreasing along statement order but **not strictly increasing**, and the
ties are free: put several statements on one physical line, or join several
physical lines with trailing `\`. Splice a block's closing brace *and* the
statement after it back to the block's first line and that statement now carries
a number from *inside* the block -- the one thing a one-statement-per-line layout
cannot express. Two forms, one effect: `} sp134 = …;` on one physical line
produces the identical object.

**Measured:** `unref_800036B4`, 339 instructions, IDO 7.1 `-O2 -mips2`. A
four-word residue split into two independent pairs. Hoisting `var_s3 = sp14C;`
above `bytecsr = out_buf;` fixed one pair and left the other at 2 words;
splicing the `if` block onto the following statement fixed the other pair and
left the first at 2; together, 0 -- `.text` byte-identical. A 26-variant ablation
puts sharp boundaries on both: the hoisted statement may tie its predecessor's
line but not exceed it, and the spliced statement's line may reach the block's
last interior statement but not its `}`. The `cc -K` listing shows it directly --
the same four instructions carry `.loc 2 13302` spliced and `.loc 2 13307`
unspliced.

**Pairs with a statement move, and that is the point.** Neither lever reaches
the target alone here. A hoist changes *which* line numbers a statement can
reach at all; a tie changes the *relation* between two of them. Campaigns that
score a statement move as "partial, dominated" and drop the family never try the
layout levers on top of it -- this match was two edits from variants already on
disk, in a campaign that had built 128 of them and published an impossibility
proof.

**Practical note:** trailing backslashes do not survive editors that trim
trailing whitespace, formatters, or some paste paths, and the failure is a
regressed score rather than an error. If the file has to travel, prefer the
one-physical-line form. Neither form survives `clang-format`, so settle it with
maintainers before an upstream PR. `decomp-workbench check-scratch` reports
both hazards on every export: an intact statement-level splice is listed as
load-bearing so the reader re-checks it after pasting, and a backslash
followed by trailing whitespace -- which is not a splice at all, only the
score-regressing corpse of one -- is a warning.

**See also:** lever 21 bisects whitespace for the same reason under accom
lineage; lever 23 is the same variable one stage earlier, at macro expansion.

**Points here:** `verdict=schedule-mismatch` with identical allocation,
`playbook=line-assignment-probe`, and any campaign whose line-number sweep found
a plateau it cannot reach with one statement per line.

## When allocation is exact but the frame is not

### 26. Recover stack homes without losing the live-range topology

**Diff looks like:** `verdict=frame-layout` / `playbook=stack-frame-recovery`:
the instruction count, opcodes, and register lanes are identical, while only
the negative prologue and positive epilogue `addiu sp,sp` immediates differ.

This state is valuable but it is not a match. It proves the source has recreated
the allocator decisions and isolates the remaining problem to source-local stack
homes or frame layout. Do not follow a generic constant-audit recipe: the frame
immediate is compiler-derived, not a literal to change in C.

Before generating variants, read the `frame evidence` line from `object compare`
or `object diagnose`. It separates observed callee-save slots from the remaining
frame bytes. If save bytes differ, investigate the colored/saved register set.
If save bytes agree and only non-save bytes differ, do not search callee-save
permutations: investigate ABI padding, outgoing arguments, spills, or local/temp
homes. “Non-save” is an evidence boundary, not a synonym for source locals.

Start with an ablation table. Remove one suspect local at a time and record two
axes for every build: normalized instruction residue and frame size. Then try
narrow scalar types and `register` once each. If those plateau, preserve the
same definition/use boundaries while replacing a phantom local with an existing
value, reusing one local across disjoint webs, or splitting one source local into
multiple webs. The objective is to keep the allocator's interference graph while
removing a distinct stack home.

**The pad slot: move temp offsets without paying frame for them.** When the
residue is compiler temps landing at the wrong stack offsets, deleting a dead
local realigns them -- and drops the frame, which you were trying to keep.
Splitting an existing local so one of its halves holds the vacated slot moves
the same offsets while keeping the frame exact. It is the frame-neutral form of
the same edit, and it is the companion construct to
[lever 28](#28-alias-a-local-to-take-it-out-of-the-allocation-contest): one
takes a local out of the register contest, the other keeps a home occupied
without adding one.

If every existing local can be marked `register` without changing the residual
or frame, stop trying to “cancel” the extra frame against those locals. That is
evidence that the winning phantom/temporary itself owns the extra frame quantum;
the next source shape must recreate its web without a distinct automatic home.

Keep allocation-exact/wrong-frame candidates on the Pareto frontier. Discarding
them because they fail the frame gate throws away the best diagnostic state;
accepting them because normalized distance is zero is equally wrong. Final
acceptance still requires the authentic compiler and the target frame.

**Points here:** `verdict=frame-layout-mismatch` from `compare`,
`verdict=frame-layout` from `view`/`diagnose`, and
`playbook=stack-frame-recovery`.

### 40. De-declare a value so it takes a compiler-temp home

**Diff looks like:** `lever: stack-home` with the frames equal or the
candidate's larger, and one call-crossing value homed a single word away from
the target's slot for it.

The frame is `[declared locals][cfe temps][uopt temps]`, and reordering
declarations permutes slots *inside* the first region. It cannot move a value
out of it. So when the target homes the value in the temp region and the
candidate declares it, the whole declaration-order family
([lever 26](#26-recover-stack-homes-without-losing-the-live-range-topology))
is spent before it starts, and the edit is to stop declaring the value:

```c
/* before -- the count is a named local, so it is homed in the declared block */
s32 bytes = count * (s32)sizeof(Entry);
allocate(bytes);
zero(bytes);

/* after -- the expression is repeated, commoned across the call, and homed
   in the temp region the target uses */
allocate(count * (s32)sizeof(Entry));
zero(count * (s32)sizeof(Entry));
```

Three directions, one family, and the frame arithmetic picks between them:

**Read the pool lane before the frame.** The ranking is: an unequal pool lane
first, then the frame delta, then the number of displaced homes. A pool lane
longer on the candidate means it colours a web the target keeps elsewhere,
which points at the declaration list more directly than a byte count does. A
field test on a six-line function had equal frames and one displaced home -- on
frame arithmetic alone that reads as "one declaration too many", and there was
no dead local to reuse; the pool lane's surplus web named declaration
placement, and declaring an index and a pointer ahead of a large `u8` buffer
closed both stack constants, 8 words to 6.

| The measurement says | The edit | Measured on |
|---|---|---|
| candidate frame larger | drop a declaration (above) | `overlay34InitStorage`, 46/50 to exact, home `sp+0x18` against the target's `sp+0x1C` |
| frames equal, one home moved one word, instruction counts equal | carry the value in a local that is already dead there, so the declared count falls by one | `func_overlay_026_F0000B18_187AF10`, 129/131 to exact, spill `sp+0x40` to `sp+0x44` |
| frames equal, two or more adjacent homes moved by the same amount | declare the pair *after* the local whose slots it must follow | `overlay84InitializeAndUpdate`, 172/179 to exact, pair `sp+0x4C`/`0x48` to `sp+0x44`/`0x40` |

**Check the frame moved before believing the count.** A declared block rounds
up to 8 bytes, so a removed declaration is often free, and an 8-byte difference
is one quantum rather than two declarations
([L72](compiler-laws/ido-5.3.md#l72-the-declared-block-is-a-rounded-quantum--measure-the-frame-do-not-count-declarations)).
Not every declared scalar owns a home at all: in this cohort two declarations
came out of one function for a byte-identical object.

**The repeated expression has to be one the compiler commons** -- call-crossing
and identical at both sites. Where it is not, the cost is an extra
materialisation: `func_overlay_026`'s ruled-out variant inlined the difference
at three sites, the CSE declined, and the object went to 135 words.

**Points here:** `lever_class=stack-home` from `diagnose`, and
[L73](compiler-laws/ido-5.3.md#l73-the-declared-local-count-not-only-the-order-places-a-call-crossing-home).

### 31. Spend an array's unaddressed tail on a new local

**Diff looks like:** you need one more registerizable local -- a second symbol to
split two roles apart (lever 29), a carrier for a hoist -- and the frame is
exactly full: adding a declaration moves the frame size and detonates a whole
family of constant rows.

```c
/* before: 16 bytes of buffer, no room for another local */
s32 textheight;
char rankbuffer[16];

/* after: the same frame, the same homes, one more local */
s32 textheight; s32 m;      /* takes the array's last word */
char rankbuffer[12];
```

**Why:** IDO reserves a home for every declared local, packed strictly top-down
in declaration order, so any net change in the block moves every home below it.
But an array whose **base only** is ever addressed -- `addiu ?,sp,BASE` and
nothing else -- has bytes in its interior that no instruction names. Shrink it
and declare the new local so the array's base stays put: the block length is
unchanged, the frame is unchanged, every used home lands on its original offset,
and a registerizable local appears out of nothing.

**Check first, with the census, not by reading the C:** the array is eligible
only if the object references its base and never an interior offset.

**Measured:** an IDO 5.3 project's `mp_watch_menu_display`. `[16] → [12]` plus one `s32`
declared immediately before it: frame unchanged, nine register rows dead,
because the function finally had a second symbol for a split role. It scales --
`[8]` plus *two* new locals, one never referenced, is byte-identical to the
one-local build. Declaration order is the whole trick: putting the new local on
the other side of its neighbour costs 22 rows, and shrinking without refilling
the hole costs 213–227.

**Points here:** `playbook=stack-frame-recovery`, and any allocation lever
blocked on "there is no free local at this frame size" -- a ceiling that was
stated twice in that campaign and was wrong both times.

### 32. Empty the cfe expression-temp pool

**Diff looks like:** the residue is a handful of constant rows that are one
stack-home addend, repeated -- your carrier lives at a local's home where the
target uses a compiler temp's slot -- and the frame is already exact.

**Why:** cfe mints **one** pooled temp symbol per type class for expression
values that need a home, and the temp region sits immediately below the locals
block, its slots assigned in symbol-index order with the earliest-born symbol
highest. A temp born early therefore outranks every later one permanently, and
the only way to reach the higher slot is for the earlier temp not to exist. The
pool is one value-numbered symbol that re-mints at the next materialisation when
you delete a def -- so killing sites one at a time looks like a wall. It is not:
the materialisation classes are enumerable, and removing all of them leaves the
function with no cfe temp at all.

The classes measured on one function, each with its kill:

| class | kill |
|---|---|
| a call used as a **non-final** argument of another call | hoist it to a local on the line above (free) -- the *last* call-valued argument never temps, it goes `v0` → argument slot |
| `a && b` in value position | lever 30 |
| a ternary in an expression | expand to `if/else` with a named carrier |

**Then spend what it releases.** A dead pool hands its 4 bytes to the *locals*
block, never to another temp -- so the payoff is one more declared local (lever
31 is the other way to buy the same thing), not a second temp slot.

**Measured:** ~120 respellings across four stages failed to kill the pool one
site at a time, and two impossibility certificates were written from that.
Enumerating the classes and removing all of them at once produced the campaign's
first build with no cfe temp, which was what let a named local take the target's
slot and closed the function.

**Points here:** a constant-row residue that is one repeated home addend, a
`CDX_SYMTAB`/`-Wo,-zdbug:2` itable ladder showing a temp between your locals and
the target's, and any campaign that has been killing temp definition sites
individually.

## When the line number is the variable

### 33. Fold statements to break an as1 scheduler tie

**Diff looks like:** two adjacent instructions issue in the opposite order from
the target, allocation and instruction count exact, and no source respelling
moves them -- a `schedule` verdict that has survived the lever 3 and lever 23
probes.

```c
/* before: the `li` carries the smaller line number and wins every tie */
if (game_over) { colour = 10; } else { colour = 0; }
x = ((viewleft + offset) - colour) + 0x28;

/* after: one physical line, so both candidates carry the same lineno and the
   ready-list position decides */
if (game_over) { colour = 10; } else { colour = 0; } x = ((viewleft + offset) - colour) + 0x28;
```

**Why:** as1's list scheduler picks the lexicographic minimum of
`(start_time, −besttime, −aftercycles, −latency, node->addr, node->lineno,
ready-list position)`, and `node->lineno` is a **source line number**. A
leading − marks a key that is maximised; `start_time` and `node->lineno` are
minimised, so **lower `lineno` wins**. With `node->addr` 0 throughout a
compiled TU, the line number is the last effective key. So physical
line numbers are a codegen input at scheduling, and whitespace is a lever.

Two consequences worth internalizing. A layout that keeps each statement on its
own line can never flip a tie in the direction "later statement first" -- keys
1–4 are equal by construction and no legal C ordering gives the later statement
the smaller number. And where one pair of statements must win *both* ways at two
different cycles, only **equality** delivers it: an inversion fixes one cycle and
breaks the other.

**Read it directly -- the trace is free and byte-inert:**

```sh
cc -Wa,-R -c source.c >sched.log 2>&1    # capture both streams
```

IDO 5.3's as1 prints the `-R` trace on **stdout**; other assembler builds may
use stderr, so capture both or the log comes back empty.

The object built with `-R` is `cmp`-identical to the object built without it, so
no instrumented assembler is needed for this era.

**Measured:** an IDO 5.3 project's `mp_watch_menu_display` -- 2688 recorded selections, 59
decided by `lineno`; eight differing rows, all of them `lineno` decisions, all
eight killed by folding four `if/else` groups onto one physical line each. The
token stream is byte-identical after whitespace normalisation, and instruction
count, frame and frame layout were unchanged. Those eight rows had been recorded
as basin-invariant across 21 respellings -- every one of which happened to
preserve the relative line order of the two tied instructions.

**Where it has no purchase:** an allocation-class residue. In the same function,
a later 13-word residue did not move under a dozen line layouts. Check the trace
for a `lineno` tie at the site before spending variants here. And the lever is
the line number, nothing else: splitting one of these statements into two to move
an instruction earlier detonated the allocator at 936 rows.

**Points here:** `verdict=schedule-mismatch` with identical allocation,
`playbook=line-assignment-probe`, and any adjacent-instruction swap that survived
lever 25.

### 42. Join an initialiser to the loop header's physical line

**Diff looks like:** `lever: line-order` with a line-order conflict whose
earlier record is an initialiser and whose later record is a loop-invariant
address, or a `--as1-trace` in which a selection was decided on `lineno`.

[Lever 33](#33-fold-statements-to-break-an-as1-scheduler-tie) folds two
statements onto one line to break a tie. This is the specific case that keeps
recurring, and the reason it is not obvious: a loop-invariant hoisted into the
preheader is stamped with the **loop header's** line, not its use site's. Every
initialiser above the loop therefore carries a lower line and wins as1's
minimised key, with nothing in the data flow behind it.

```c
/* before -- the count is at line 45, the hoisted table address at line 46 */
remaining = 7;
do {

/* after -- one physical line, and the line key stops deciding */
remaining = 7; do {
```

Moving the initialiser is not the lever. It is already as late as C allows;
that is what makes the residual look sourceless, and two functions were
recorded unreachable on exactly that reading before the emit trace existed.

**The second half of the family: birth order.** When the preheader materialises
*several* invariants, their order among themselves is ugen's birth order, which
follows source statement order. A bound kept in a local is born before a count
read inline -- so spelling the bound inline in the loop test moves its birth
after the count. One function needed both halves.

**When it is inert, it says so in one build.** A byte-identical object under a
line join is evidence the pair is not separated by their lines, and the next
lever is a different family.

**Points here:** `lever_class=line-order` from `diagnose --emit-trace`, and
[L80](compiler-laws/ido-5.3.md#l80-a-loop-invariant-hoist-carries-the-loop-headers-line).

## When the dispatch is the variable

Levers 34–38 are **IDO 7.1** measurements from one 1,868-instruction function
with a two-cluster jump-table dispatch, taken from one word to zero. They are
specialist levers: reach for them only when the residual is in or around a
`switch`, and read [compiler laws IDO 7.1](compiler-laws/ido-7.1.md) for the
mechanism behind each one. The 5.3 laws do **not** transfer here -- the same
Binasm stream through 5.3's `as1` produces a 321-word object.

Two habits from that campaign matter more than any single lever below.

**Prove the fix at the phase boundary before hunting for the C.** Capture the
pass streams (`decomp-workbench pass ucode`, `pass binasm`), patch the record
you think is missing, re-run the *stock* phases, and score. That tells you
whether the shape you are about to spend fifty variants on is even the right
shape. In this campaign the barrier below was proven `words=0` by stream
surgery a full session before any source spelling produced it -- and three
earlier barrier families were killed the same way, in minutes, for the price of
one patched stream each.

**Prove levers in isolation, compose late.** All four of the levers that closed
this function are worthless alone: 9 words for the layout by itself, 13 for the
layout plus an unballasted barrier, 5 for the selector without the ballast, 8
for the ballast without the selector -- and 0 for the four together. A lever that
does not improve the score is not thereby refuted; it is a component whose
partner you have not found yet. Record what each one *moves*, not what it
scores.

### 34. The conditional branch-to-next barrier

**Diff looks like:** one register wrong on a fallthrough block, immediately
after a copy (`move a,b`) that the target also emits, with instruction count,
opcodes, gaps and frame all exact. Under IDO 7.1 this is `as1`'s `peep_reg`
propagating the copy into your fallthrough; the target's block did not inherit
the fact.

```c
if (opcode && opcode && opcode);      /* exactly three tests */
switch (opcode) { ... }
```

**Why:** UGEN's branch-to-next eliminator removes at most **two** conditional
branches and unboundedly many unconditional ones. Three chained empty-body
tests therefore leave exactly one branch-to-next alive into the assembler,
where it creates a basic-block boundary that fails `update_ctnt`'s
single-predecessor gate and kills the copy fact -- and is *then* deleted as
removable. Zero instructions, zero frame, one healed register.

**The arity is the lever, and it is sharp:** one and two tests are erased by
UGEN before `as1` ever sees them (no effect); three is exact; **four is
catastrophic** (1,822 words). Branch sense, the compared variable and the
branch opcode are all irrelevant -- only the surviving boundary matters.
Branchless spellings (`x + x + x`, `|`, `&`) fold to one reference and are
inert.

**Measured:** three barriers inserted into a captured Ucode stream and run
through stock ugen+as1 gave `words=0 opcodes=0 gaps=0 regs=0 insns=1868`,
reproduced independently by a second agent from the same base. The source form
reached the same result once levers 35–38 supplied the surrounding shape.

**Where it has no purchase:** unconditional jumps, labels, `#pragma`s,
trampolines and no-ops at the same boundary -- all erased before the assembler.
7.1's `cfe` has no inline-assembly or optimisation pragma, so the assembler-mode
spellings (`.set nomove` and friends) that also work at the Binasm level have no
C form at all.

**Points here:** a one-register residual on a fallthrough after a copy, with
everything else exact.

### 35. Goto-pair parity steering

**Diff looks like:** a range branch whose *sense* is inverted (`bnez` where the
target has `beqz`), and two dispatch clusters that have swapped places -- the
low table's `addiu`/`sltiu` pair sitting where the high table's belongs.

```c
/* the branch target becomes the fallthrough, so name the arm you want to fall
   into and send the other one away explicitly */
if (opcode >= 209) goto high;
goto low_entry;
high:;
```

**Why:** written this way, `high` becomes the **fallthrough** and the branch is
inverted onto the low path. Which arm falls through decides which dispatch block
is a single-predecessor fallthrough -- and therefore which one inherits `as1`'s
copy facts (lever 34 and the laws behind it). Parity is a *layout* lever with a
*register* consequence.

**Do not spend variants on the comparison's polarity.** `>= 209`, `> 208` and
`!(x < 209)` compile byte-identically, and so does collapsing the pair into a
single `if (x < 209) goto low_entry;`. Seven distinct spellings of this family
produced one text hash.

**Measured:** the goto pair plus a nested switch (lever 36) and no other change
scored `words=9 opcodes=0 gaps=0 insns=1868 frame=-168` -- every layout word
already correct. The braced `if/else` partition of the *same* program is not
equivalent: `words=1797 opcodes=1656`, four instructions short.

**Points here:** an inverted range branch, or two jump tables in the wrong
order, with the instruction count already exact.

### 36. Opposing-arm ballast

**Diff looks like:** you added lever 34's barrier to one arm of a partition and
the parity flipped -- the branch sense inverted and the dispatch clusters
swapped. The barrier is doing its job and paying for it in layout.

```c
if (opcode >= 209) goto high;
goto low_entry;
high:;
if (opcode && opcode && opcode);      /* the barrier                     */
switch (opcode) {
low_entry:
    if (opcode && opcode && opcode);  /* the ballast: same weight, other arm */
    switch (opcode) { ... }
```

**Why:** control flow immediately after a goto target re-biases which arm falls
through (lever 35). Putting the *same* zero-code statement on the opposing arm
restores the balance, so the barrier keeps its register heal and gives back the
layout.

**It is idempotent, so do not sweep multiplicity:** one, two and three copies of
the ballast statement compile to byte-identical text. Sweep *placement*
instead.

**Measured:** barrier on one arm, `words=13 opcodes=1` (five parity sites: a
branch sense, plus two `addiu`/`sltiu` pairs exchanging). Barrier on both arms,
`words=8 opcodes=0 regs=0` -- the parity sites are gone and the residual is
purely stack offsets (lever 38).

**Points here:** a parity regression that appeared *when you added* a
zero-instruction statement, not before it.

### 37. Duff-nest a switch to move its bodies

**Diff looks like:** a `structure-mismatch` of hundreds to a couple of thousand
words whose entire edit script is one moved block family -- the case bodies of
one dispatch sitting immediately behind their jump table instead of after
another dispatch's bodies. `align` says so; `words` will not.

```c
switch (high_selector)          /* outer: the cases whose bodies go LAST  */
{
low_entry:                      /* entered by `goto` from outside         */
    switch (selector)           /* inner: the cases whose bodies go FIRST */
    {
        case ...:  ...
    }
    break;
    case HIGH_A: ...            /* outer cases continue here              */
}
```

**Why:** uopt rebuilds block order with a depth-first walk that always takes the
successor whose **original lexical number is `node->num + 1`** first. A jump
table's lexically-next successor is one of its own bodies, so the walk exhausts
that subtree before returning to the other arm -- which is exactly the
relocation you are looking at. Nesting the second switch *inside the first
one's body*, entered by a `goto` to a label between its cases, gives the walk
the numbering that produces the target order.

**Cheaper things to try first, and what they buy:** an empty pure conditional
(`if (x);`) on the **first** case trampoline, or on an explicit
`default: goto low;`, also changes the numbering -- uopt turns an empty
conditional into a `Unop` that emits nothing but **keeps its CFG edge**. Those
reached `words=1441`/`1442` where a plain `default: goto low;` sat at 1,787.
Placement follows the `num + 1` rule literally: "first" and "middle" move the
layout, "last" is inert. Keep the condition to **one or two** references; three
crossed a fold threshold and retained real instructions.

**Traps.** A `volatile` in the empty condition turns the free `Unop` into a
`Upop` that preserves the evaluation -- real code. Bare labels, `Uloc` and
`Unop` create no edge at all and cannot reorder anything. And predecessor count
is never consulted, so "give it another predecessor" is not this lever.

**Points here:** `verdict=structure-mismatch` with an exact instruction count,
whose `align` edit script is one moved block run; any partitioned switch whose
bodies came out in the wrong cluster.

### 38. `x ? x : x` as a switch selector

**Diff looks like:** allocation, schedule, opcodes, registers and frame *size*
are all exact, and the only residual is a family of stack offsets -- the same
`sw`/`lw` homes off by a constant, in a frame whose total is already right.

```c
switch (opcode ? opcode : opcode) { ... }

/* and, where you also need lever 34's barrier inside the switch statement: */
switch (opcode && opcode && opcode ? opcode : opcode) { ... }
```

**Why:** a conditional expression in selector position reshapes the switch's
selector temp, which moves the temp region's homes. It is a frame-layout lever
with **no codegen collateral at all** -- a rare thing, and the reason it is
worth trying before any declaration surgery (levers 26, 31, 32).

**Measured:** with everything else held fixed, adding the ternary changed
exactly eight words -- two temp homes moving from `44/48(sp)` to `40/44(sp)` --
inside an unchanged `-168` frame, with identical instruction count, opcodes,
registers, floats and schedule. That was the last residual of the campaign, and
it had survived a 135-shape × 261-variant declaration/width/qualifier/lifetime
grid, because it was never a colouring problem.

**Insensitive to spelling, so do not sweep it.** Four placements -- outer
selector, inner selector, either arity of the condition, both selectors at once
-- produced one byte-identical exact object. Sweep *which switch* if anything,
not how you write it.

**The two-in-one:** when the condition is an `&&`-chain, the selector also
carries lever 34's barrier *inside* the switch statement -- which is how you
reach a boundary where a standalone statement cannot go, because ugen builds
the table's range guard as an atomic tree with no room for a label inside it.

**Points here:** an exact allocation with a stack-home residual, especially one
that has already resisted declaration levers.

## When the dial has arithmetic

### 39. The dead-read priority dial (IDO 7.1)

**Diff looks like:** a register rotation you are trying to buy with dead reads
(levers 7–9), on IDO 7.1, where read count feels like a random walk.

It is not a random walk. 7.1's `uopt` colours by Chow priority, and the
arithmetic was read out of an instrumented compiler:

```
priority = save / units
units    = raw < 3 ? raw : ((raw - 2) >> 2) + 2
raw      = refnodes + cardbits
```

* **+10 `save` per surviving reference**, with **no discount for branch
  nesting** -- a read inside an `if` is worth exactly what one at top level is.
* **+1 `cardbit` per spanning statement**: each additional *statement* before
  the site contributes its own transient block to every web that spans it.
* **An empty-body `if` folds after `compute_save`** -- its references are
  counted, its code is not emitted. That is why a zero-instruction statement
  can rotate an allocation at all.
* **Ties break by ascending first-occurrence symbol**, so at equal priority the
  earlier-declared value wins; that dial is a declaration move, not a read.

**`units` is a step function, so the dial is a cliff, not a slope.** `raw` 3–6
gives 2 units, 7–10 gives 3, 11–14 gives 4. Measured on one web: two references
tied at 15.0 (symbol order decided), **three references in a single statement**
gave 70/4 = 17.5 and the target rotation, and four collapsed codegen to 1,834
words. Separate statements overshoot on `cardbits` where one statement with
three references does not -- which is why `if (x && x && x);` is the shape.

**Poisoning is non-local.** A third read *block* halved a neighbouring web's
priority through card growth and shifted the whole colour ladder; the
equilibria found in that function tolerated only two to four specific reads
before the schedule broke. Budget reads against the *schedule*, not against the
web you are aiming at.

**What is not reachable:** loop-depth weighting. Trip-1 and `while (0)`
wrappers fold before `compute_save` (identical priorities), and a real `for`
loop changes the frame.

**Measured:** a donor-free three-reference statement reproduced a complete
target integer-web rotation at `words=3`, falsifying nine grids' worth of
"the donor rotation is the only integer-web lever". A separate 261-variant
closure recorded the same arithmetic per basin.

**Where it has no purchase:** composition. Every donor composed with this dial
re-broke the rotation. Two levers that each move the same web do not add; price
them together or not at all.

**Points here:** `playbook=pool-position` on an IDO 7.1 target, and any read-count
search that has been treating multiplicity as a smooth dial.

## After the function matches

### 27. Minimize fake-match machinery without reopening exactness

**Diff looks like:** there is no residual: raw instruction words and relocation
targets are exact, but the accepted C still contains artificial statics, empty
controls, cancelled arithmetic, dead assignments, or other scaffolding whose
translation-unit effects and necessity are unknown.

Exactness ends the binary search, not the source-quality review. First inventory
the suspicious constructs without calling them dead:

```sh
decomp-workbench experiment inspect-source exact.c
```

The inventory marks every finding `safe_automatic_removal=false` and attaches
the review question that makes the construct unsafe to delete blindly. Empty
controls can evaluate a side-effecting condition or preserve a statement-line
boundary; cancelled arithmetic can retain volatile reads, promotions, or
overflow behavior; a static can be real state. The command's cleanup checklist
therefore ends at full-object collateral and the project link/ROM verifier,
not at a shorter-looking function.

Turn related declaration/use changes into named, exact-text transformations.
Preserve one transformation per measured mechanism or object-basin
representative, then generate only bounded singleton and cross-family
combinations:

```sh
decomp-workbench experiment compose cleanup.json generated --dry-run
decomp-workbench experiment compose cleanup.json generated
decomp-workbench experiment validate generated/experiment.json
```

Run the generated candidates through the authentic compiler with
`--no-stop-on-exact`. A cleanup candidate survives only if raw words,
relocation targets, instruction count, and frame all remain exact. Then compare
the full translation unit:

```sh
decomp-workbench object collateral reference-tu.o candidate-tu.o \
  --function function_name --fail-on-collateral
```

This phase is allowed to prefer fewer artificial declarations, fewer empty
controls, and less section/symbol collateral among binary-equivalent
candidates. It is not allowed to call the shortest fake historically original.
If two traces have different semantic fingerprints but `decision outcome:
status=identical`, report carrier substitution: different hidden webs recreated
the same ordered register endpoints.

One campaign's `func_802963D0_6A7A80` cleanup is the model. The first exact source used
three artificial statics and three empty controls. A later source kept only the
cancelled static read and replaced two static carriers with duplicate
`if (width == height) {}` controls at the same loop boundary. Stock IDO emitted
the same exact function and allocator decision sequence; the full-TU `.bss`
shrunk from `0x30` to `0x20`, while GP-linker metadata still exposed the one
remaining static. The decisive experiment was a cross-family composition that
both earlier single-family searches had left on disk.

**Points here:** an exact function with measurable fake-match burden,
source-distinct traces with an identical decision outcome, or a cleaner exact
candidate that still needs translation-unit collateral and project verification.

## A sweep winner is a hypothesis, not an edit

**Hard rule: no winner of an automated source-mutation sweep is adopted until
its diff has been read and every changed line justified as a C
transformation.** The score is not the evidence. A generator proposes edits by
shape, so a variant that compiles and scores better than its baseline may
simply not be the same program, and nothing downstream will catch it -- the
comparator answers "are these the same object", never "are these the same
program".

Both recorded failures came from one sweep that renamed a local's occurrences
in line-proximity groups:

* a group holding only *reads* -- its definitions were 130 lines earlier --
  became a read of an uninitialised variable. It compiled and it scored;
* the top-scoring row renamed a local's *first* store and left a later
  conditional store and two reads behind, so a path now reaches a read without
  passing a write.

```sh
decomp-workbench experiment review-mutation baseline.c winner.c
```

prints the diff and flags both shapes: a use no earlier line writes to
(`read-before-definition` / `definition-removed`, error), and a removed write
to a value still read (`write-removed`, warning -- whether the surviving reads
are still dominated is a control-flow question the check does not answer).
`--fail-on-warning` makes both fatal in a script.

The command is a review surface, not a proof. It does not parse, type, or
execute C: a clean report means the two named shapes were not found. The
justification is still yours, and an unjustified line is a reason to drop the
variant rather than to search around it.

If you are writing the sweep, the same rule belongs in the generator:
require every renamed group to begin with a definition of the name, and refuse
a group that removes a write while leaving a read.

---

## Dead families -- do not spend variants here

Each of these was searched exhaustively at real cost; skip them.

| Family | Verdict |
|---|---|
| `a \| b` versus `b \| a` | Canonicalized to byte-identical objects. Use `x \|= y` (lever 2). |
| Declaration-order permutation | Inert across three campaigns and ~1000 variants. Test once, cheaply, then drop it. Two exceptions exist: absolute first-declared position mattered on `texLoadTextureActual`, and removing a fully-unreferenced local once changed codegen 20+ instructions away. |
| Bare discarded expressions | `id == id;`, `(void)(x & mask);`, dead second stores -- all eliminated with zero codegen effect. Use an empty-if (lever 7). |
| Line joins and comma merges to beat `-g3` | `.loc` is per statement; the barriers do not move (lever 3). What does move them is *which* line each statement is attributed to -- at preprocessing time (lever 23) or by splicing statements onto one logical line (lever 25). Joining lines to remove a barrier is dead; joining them to make two statements share a number is lever 25, and it matched a function. |
| Loop splitting to force a memory re-read | Defeats IDO's own loop-invariant motion; +147 words measured (lever 5). |
| The permuter on varargs functions | IDO's `va_arg` is unparsable by pycparser either expanded or preserved. Plan `printf`-family campaigns without it. |
| The permuter as a solver | Roughly 140,000 iterations across four campaigns solved zero residuals. It is a hypothesis generator; it earned its keep once, by exposing lever 17 through a red herring. |
| Reassociation-defeat casts under accom | cfe's tree-height reduction needs `(s32)` cast barriers to hold an address sum together; accom never reassociates those sums -- all spellings are byte-identical, and the casts are pure cfe artifacts. Do not port them across frontends. |
| Duplicate-value case labels | cfe converts every case constant to the switch's promoted type *before* its duplicate check; nine spellings of an equal value (suffixes, wide constants, float casts, wraparound arithmetic) all error. A table arity below the frontend threshold cannot be forced this way -- that is lever 20 territory. |
| Unconditional barriers at a dispatch boundary (IDO 7.1) | `goto next; next:;`, trampolines, bare labels, `#pragma`s and no-ops are all erased before the assembler. Only a *conditional* branch-to-next survives, and only at arity three (lever 34). |
| Respelling a switch selector to reach uopt's additive wrapper (IDO 7.1) | `sel + 0` cannot make it -- a zero displacement is dropped, and the wrapper is chosen by expression class. A 50-form grid (address-taken, pointer, array, bitfield, enum, `volatile`, comma) split cleanly: forms erased early enough to keep the schedule erase back to baseline; forms that survive uopt change the frame and register regime globally. |
| Comparison polarity in a partition (IDO 7.1) | `>= N`, `> N-1`, `!(x < N)` and the collapsed single-goto form all compile byte-identically. Sweep placement (lever 36), never polarity. |
| Ballast multiplicity (IDO 7.1) | One, two and three copies of the same zero-code statement are byte-identical. It is a switch, not a slider. |
| Ternary-selector spelling (IDO 7.1) | Outer switch, inner switch, either condition arity, or both at once -- one byte-identical object (lever 38). |
| Declaration/width/qualifier dials against a temp-slot residual (IDO 7.1) | 135 shapes × 261 variants moved nothing, because a stack-home residual under an exact allocation is not a colouring problem. Try lever 38 first. |
| Loop wrappers to weight a web's `save` (IDO 7.1) | Trip-1 and `while (0)` fold before `compute_save`; a real `for` changes the frame. There is no reachable depth weighting (lever 39). |

---

## Verdict-to-lever index

| `view` verdict / `playbook` | Levers |
|---|---|
| `constant` / `constant-audit` | 1, then re-derive fakes |
| `commutative-order` / `ast-shape` | 2 |
| `schedule` / `g0-schedule-probe` | 3, 4, then 23, 24 |
| `schedule` at `-g0`, allocation identical / `line-assignment-probe` | 23, 25, 33, 4 |
| `structure` / `structure-buckets` | 1, 4, 24, 5, 6 |
| `phase-shift` / `temp-fifo-phase` | 14, 15, 16 |
| `allocation` / `pool-position` | 7, 8, 9, 10, 11, 12, 13, then 28, 29, 30 |
| `register-permutation` / `forced-color-oracle` | 17, 18, then 19 |
| `frame-layout` / `stack-frame-recovery` | 26, 31, 32 |
| target register is *taken*, not underpriced / `pool-position` | 7-13, then 28, 29 |
| the frame is full and the lever needs one more symbol / `stack-frame-recovery` | 31, then 32 |
| one register wrong on a fallthrough after a copy (IDO 7.1) / `copy-propagation-barrier` | 34, 35, 36, 38 |
| jump-table bodies or clusters in the wrong order (IDO 7.1) / `dispatch-layout` | 37, 35, 36, 34 |
| exact allocation, stack homes off by a constant (IDO 7.1) / `stack-frame-recovery` | 26, 31, 32, and 38 if a switch is in the residual |
| read-count dial on IDO 7.1 / `pool-position` | 39, then 7-13 |
| `lever: stack-home` from `diagnose` | 40, then 26, 31, 32 |
| `lever: temp-ring` from `diagnose --ring-trace` | 41, then 14, 15, 16 |
| `lever: line-order` from `diagnose --emit-trace` | 42, then 33, 25 |
| `lever: pool-rotation` / `pool-population` from `diagnose --ladder` | 44, then 7-13 |
| `lever: unreachable`, or a `see_also` proof | 43, then the permuter |
| function exact; fake-match scaffolding remains / `post-match-cleanup` | 27 |
| TU-clustered impossible dispatch | 20, 22, then the atlas in [alternate-frontends](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/alternate-frontends.md) |
| token-identical variants stall (accom lineage) | 21 |

## See also

- [Start here](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/START_HERE.md) -- the loop these levers fit into.
- [From verdict to edit](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/from-verdict-to-edit.md) -- one worked example of
  taking a lever from this page to a source change and back.
- [The `guide` command](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/guide-command.md) -- `decomp-workbench guide <playbook>`
  prints any section below without leaving the terminal.
- [Working a backlog of near matches](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/walkthrough-30-near-matches.md) -- how to
  apply this guide to thirty functions instead of one.
- [Aligned mechanism view](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/view.md) -- the command that names the mechanism.
- [Compiler laws: IDO 5.3](compiler-laws/ido-5.3.md) and
  [IDO 7.1](compiler-laws/ido-7.1.md) -- what the compiler does, as opposed to
  what to do about it. Levers 34-44 each name their law there, L83-L86 are the
  newest four, and `decomp-workbench guide laws ido-5.3 L80` prints one law
  instead of the page.
- [Permuter sweeps](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/permute-sweep.md) -- when no hand lever is left:
  `permute-doctor` before the search, `permute-sweep` for it, `permute classify`
  for the class it measured, and `ranking stamp`/`ranking check` so the order
  the queue is worked in is still a measurement of this tree.
- [Final-function campaign lessons](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/final-function-campaigns.md) -- the longer
  reasoning behind several of these entries.
