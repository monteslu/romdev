# Compiler laws: IDO 5.3

What this compiler *does*, as opposed to what to do about it. The
[field guide](../field-guide.md) is levers -- source edits and the residual each
one moves. This page is mechanism: the rules the passes actually follow, each
with the evidence that established it and the earlier claim it corrected.

Both halves matter, and the second half more. Almost every law below replaced
a plausible, widely-repeated, wrong belief. Reading only the conclusions would
hand you the answers without the thing that makes them trustworthy, which is
the record of how the previous answers failed.

## Scope

Everything here is **IDO 5.3** (`cc` → `cfe` → `uopt` → `ugen` → `as1`) at
`-O2 -mips2 -G 0 -non_shared -Olimit 2000`. No law on this page has been tested
on another IDO release. Where a law depends on a driver default (ring widths,
list sizes) that is called out, because those are startup constants for one
driver configuration and not properties of the compiler.

The measurements come predominantly from two large procedures -- one of 4644
instructions and 922 basic blocks, and one of 2057 instructions with 222 calls --
so "always" below means "in every case observed in those procedures", never
"provably, in all programs".

Laws L49–L60 come from an IDO 5.3 `mp_watch_menu_display` campaign (2026-08,
~2900 builds across ~37 delegated stages, scratch score 6859 → instruction-exact
at 2057/2057 words). Like the L26–L40 block below, each carries a
**Provenance** line naming the stage, because those stages ran in parallel and
reused each other's internal law numbers; this page's numbers are its own.

Laws L62–L70 come from the reference campaign decompilation (2026-08), a
whole-ROM campaign rather than one procedure: they were measured across a
resident cohort of exact matches, an instrumented ugen free list, and a
permuter sweep, and several of them are levers that campaign had to re-derive
from scratch because they were nowhere on this page. Two of them (L69, L70)
are not compiler behaviour at all but **measurement** laws about harnesses
that lie, filed under Measurement laws for that reason.

Laws L72–L82 come from the same campaign's overlay lever cohort
(2026-09-02/03): seven lanes carrying **22** targets with measured work, run
with an instrumented ugen and the assembler's own scheduler trace. These laws
name 19 of those 22; the twentieth function they name, `levelFreeAll` in L75,
is a resident target from a separate shard and is outside the cohort.

Seven of them state what an edit *does* (L72–L74 the frame, L76–L78 the ring,
L80 the hoisted line) and four state what no edit does (L75, L79, L81, L82);
L79 carries a delay-slot corollary of the same kind. The second group is the
more expensive half: each of those was established by spending builds until
the mechanism was read, and each is now a test an analyst can run before
spending them again.

Laws L83–L86 come from one lane of the same campaign (2026-09-03), thirteen
builds on three overlay functions read with the instrumented uopt CDX
colouring profile. They are what the two colouring sweeps actually order on
(L83, L84), the one source spelling measured to move a web number (L85), and
four that move none (L86). They are narrow on purpose: three functions, one
of which is the only one whose webs reached the callee-saved sweep at all.

## What a receipt may cite

Every receipt on this page is a **symbol-level citation**: the function a
measurement came from, its address-derived name, its size, its frame, the
registers a group landed on, and the object hash that closed it. Nothing on
this page is a copy of any part of a binary -- no instruction text, no
disassembly, no extracted data -- and the objects behind these receipts are
not redistributable and are not in this repository. That is the exemption
[CONTRIBUTING](https://github.com/akratch/n64-decomp-workbench/blob/main/CONTRIBUTING.md) records for symbol-level citations, and
it is why these laws need no separate redistribution basis. Reproducing one
means rebuilding it from the project that owns the binary.

## Evidence tiers

| Tier | Meaning |
|---|---|
| **T1** | Measured with a gated instrumented compiler: the pass source was read, live records were logged, and a force knob reproduced a named object hash. |
| **T2** | Inferred from build outcomes: probe ladders, score deltas, hash collapses. The mechanism was not read directly. |
| **T3** | Single observation, not swept. Treat as a lead. |

**The identity gate.** A T1 claim is only T1 if the instrumented compiler was
gated: built with the instrumentation *disabled*, its object must be
byte-identical to the stock compiler's. Every instrument cited here passed that
gate, several against a stock object *and* one or more oracle hashes. An
ungated instrument attributes decisions to the wrong pass, which is worse than
having no instrument.

**Oracle hashes go stale.** A force set that reproduced a target hash on one
base often does not on the next, because adoptions move everything downstream.
The law usually survives; the hash does not. Re-gate an oracle on the current
base before believing a negative result from it.

**No impossibility claims.** Every closed lever below is recorded as *scoped* --
with the space that was actually covered -- never as impossible.

---

## cfe (the front end)

### L1. Free order is cfe's operand order

The order in which `ugen` releases the two source registers of a binary
operation is the ucode **operand order**, and that operand order is the same
bit `cfe` emits as `rs`/`rt`. cfe owns the bit, uopt transports it, ugen
consumes it (see [L11](#l11-ugen-frees-a-binary-ops-sources-in-operand-order)).

**Receipt -- T1.** Instrumented `ugen` traced both objects through one divergent
site: the allocation *request* sequence was identical on both sides, and the
divergence entered through the free list. One free transposition 100 rows
upstream accounted for a 117-row heal, reproduced three equivalent ways
(`FFSWAPS`, `FHEADS`, `FSETS`) to one object hash. ~14 builds.

**Falsifies.** The prior stage's claim that the divergence unit was the
**within-statement request order**. Request orders were measured identical; the
prize was a free-order bit, not a request-order bit. That in turn had already
replaced an earlier "the target holds one extra fp temp live across this
window" reading, which two independent probes (a hold-out and a rotation) both
refuted -- both builds carried the same free list into the window.

**Scope.** Binary operations reaching ugen's binary-operand path. This bit is
**invisible in the emitted bytes**: the assembly at the deciding statement was
byte-identical on both sides, so no amount of disassembly reading will recover
it.

### L2. Claim order is source *condition* order; test order is canonicalized

Specific-register claims are ordered by the order the values appear as
**conditions in the source**. The emitted **test** order is canonicalized by
cfe and does not track it.

**Receipt -- T2 over a T1 attribution.** A 29-build probe ladder. The decisive
observation: the target emits its two definitions in one order while *both*
gate conditions test in the other, and a pure condition swap moves claim rows
while healing exactly zero test rows. Reordering the normalization groups so
the second value claims first healed 5 rows and was adopted on both artifacts.

**Falsifies.** The immediately preceding claim that ROM claim order was
condition **use** order. The pure-condition-swap probe is precisely the
disproof: use order predicts test rows would move, and none did.

**Scope.** Floating-point specific claims. This does **not** close the residual
band it was found in; no order permutation reaches it, and a different lever
class was named as required.

### L3. Float `+` at an assignment root: one bit, two effects

For a float `+` at the root of an assignment's right-hand side, cfe emits `rs`
as the source's **right** operand, and allocates the fp ring in the order
`[pair₁, singleton, pair₂]` when the paired subtree is on the right, or
`[singleton, pair₁, pair₂]` when it is on the left. One source-association bit
drives both.

**Receipt -- T1.** Hand stage capture, gated byte-identical against the driver's
own object. The cfe intermediate records change shape with the source
association. 47 scored builds; all 12 spellings enumerated.

**Falsifies.** No prior claim. **But a conclusion drawn from it was itself
falsified**: reading the unscheduled instruction stream showed the target's fp
allocation ordinals at the deciding statement *are* ours, so the "the target
needs two halves of one bit to disagree" conflict does not exist. The rule
stands; that corollary does not.

### L4. cfe owns the frame layout

The frame is one descending symbol-creation-order batch, plus LIFO-bucketed
temps.

**Receipt -- T1**, double-gated instrument. Six forces reproduce a 15-row heal
to an exact hash; later sharpened when it turned out **no anonymous temps
exist** in the translation unit at all, and a single force on one frame-batch
ordinal reproduces the oracle hash exactly. A related law: the spill home is
**symbol-keyed**, so renaming a dead host moves it.

**Falsifies.** The claim that a 15-row constant family was a second *uopt* temp
population. The homes are already present in the cfe intermediate: the "second
temp population" was cfe frame layout.

### L5. There is no `acpp` stage for C in IDO 5.3

`cc` invokes `cfe` directly. Verified from `cc -show`.

**Receipt -- T1**, with a measured consequence: multi-line statement splits,
comments, and same-type casts are **byte-proven inert**.

**Falsifies.** An inherited cross-campaign lever -- the `acpp` line-assignment
trick from a different toolchain -- which would otherwise have been searched
blind. Line-assignment levers still exist under 5.3, but not through `acpp`.

### L49. One general expression temp per function, value-numbered

cfe mints **one** pooled temp symbol per type class for expression values that
need a home, and uopt's itable is a hash table of expressions in
first-occurrence order -- so the pool's symbol index is stamped at whichever
materialisation happens to come first, and **re-mints at the next one** when
that site is deleted. A "second class" of definition on the same slot is not a
second construct; it is the same pooled symbol seen at another site. The
materialisation sites are enumerable, and because they are enumerable the pool
is **killable**: remove every member and the function compiles with no cfe temp
at all.

**Receipt -- T1.** `CDX_SYMTAB`, a whole-itable dump gated byte-identical
against the stock compiler with the instrument both unset *and* enabled. The
pool's index moved 72 → 121 when all 21 `viGetY()` argument sites were replaced
and the slot survived; the annotated op dump then read the pool's complete
def/use set as three construct classes on one symbol, and a build that removed
all of them was the campaign's first object with no cfe temp in the itable.

**Falsifies.** Two same-campaign certificates: "there is always at least one
discarded or materialised call result, so the temp's def count cannot reach
zero", and the reading that a newly-appearing def site was a *fourth class* of
construct rather than the pool re-anchoring. Both had survived ~120 respelling
attempts across four stages, which is what a value-numbered pool looks like from
the outside.

**Provenance:** `mp_watch_menu_display` (2026-08), stages `symdump`
(`L-sd-1`/`L-sd-2`), `cfetemps`, `birthorder` (`L-bo-1`).

### L50. A call-valued argument temps only in a non-final position

A call used as an argument of another call materialises into the pool
[L49](#l49-one-general-expression-temp-per-function-value-numbered) describes
**only when other arguments are set up after it**. The *last* call-valued
argument goes `v0` → argument slot directly and mints nothing.

**Receipt -- T1**, itable dumps on both shapes: the double-inline births exactly
one pointer temp (the third argument), never two, and the final argument's
result reaches its outgoing slot with no home written.

**Falsifies.** A same-campaign law that priced every call-in-argument as a temp,
which made a whole family of double-inline spellings look unaffordable. It also
retires the retype route: giving the callee an `int` return type still does not
pool a call-result temp with the general expression temp -- the two never share a
symbol, whatever the type.

**Provenance:** `mp_watch_menu_display` (2026-08), stages `cfetemps`
(`L-pk-3` falsified), `finalframe` (`L-cf-4` re-tested).

### L51. cfe's own `&&`-as-a-value expansion is a spelling you can write

cfe expands `v = a && b` **as a value** into `v = (a); if (v) { v = (b); }`.
Written out that way in the source, with a named local in place of the pool
temp, it is **byte-identical** to the operator at every site. Other branch-free
or branch-ful respellings of the same predicate (`v = 0; if (a && b) v = 1;`,
`if/else` forms, `|`, `&`, `*`) are **not** -- they cost hundreds of rows.

**Receipt -- T1, hash-exact.** Four `&&` sites, each rewritten singly, in every
pair and in every triple: byte-identical objects throughout. The same four sites
under the other spellings measured 264–860 rows across four independent stages.

**Falsifies.** Four impossibility certificates that all rested on the wrong
spelling -- including one stage's 819-row "maximal legal attack" concluding the
temp pool could not be emptied. The predicate was never the expensive thing; the
*expansion* was, and the expansion is writable.

**Scope.** The value form. This says nothing about `&&` in a controlling
expression, where no value is materialised in the first place.

**Provenance:** `mp_watch_menu_display` (2026-08), stage `birthorder`
(`L-bo-2`).

### L52. `uadd` operand order follows node complexity, and a cast is a node

cfe decides a `uadd`'s operand order by node complexity, not by source order. A
same-signedness cast is not a distinct node -- `(s32) x` on an already
sign-extended value is the same node as `x` -- but an **unsigned** conversion is,
and it demotes its operand to the right-hand side.

**Receipt -- T1.** The last differing word of a full campaign: `addu t9,a0,v1`
versus `addu t9,v1,a0`. Source-order swaps, `+=` forms, `(s32)` casts, an `s16`
carrier and 16 other carrier symbols all failed; `(u32) x2` produced the
target's operand order and closed the function to zero words.

**Scope.** One site, one target. State it as the mechanism to *try* at a
commutative-operand residue ([L2](#l2-claim-order-is-source-condition-order-test-order-is-canonicalized)
and the guide's lever 2 are the rest of that family), not as a swept law.

**Provenance:** `mp_watch_menu_display` (2026-08), stage `birthorder`
(`L-bo-4`).

### L53. The frame is a byte map, and every declared local has a home in it

IDO reserves a home for **every** declared local, whether or not it is ever
coloured, and packs the symbol block strictly top-down in **declaration order**:
`[locals, declaration order][cfe temps][uopt temps]`, temps immediately below
the locals block. Block-scope locals follow function-scope ones; there is **no
sibling-scope overlay**. Within the temp region, slots assign in **symbol-index
order, earliest-born highest** -- so a temp created at line 117 permanently
outranks one created at line 288, and the only way to reach the higher slot is
for the earlier temp not to exist ([L49](#l49-one-general-expression-temp-per-function-value-numbered)).
Removing *n* bytes anywhere in the block moves every home below the removal by
`n`, which is why an unconsidered declaration edit shows up as a whole family of
constant rows.

**Receipt -- T1.** A byte-for-byte frame budget on a −216 frame -- outgoing args
48, saved regs 16, allocator spill 8, symbols 144 -- reconstructed from a
stack-home census of both objects (every `N(sp)` and `addiu ?,sp,N`) joined
against three independent `CDX_SYMTAB` ladders, and agreeing with the target at
**every** offset. Home is `raw10 + framesize` in the itable record, two's
complement.

**Scope, and the two holes that are not spendable.** The same census found two
4-byte holes -- the round-to-8 padding of a 3-register save area and of a
single-word spill area. Both are allocator outputs, and neither is addressable
from source. "There are spare bytes in the frame" and "there are spendable bytes
in the frame" are different claims.

**Provenance:** `mp_watch_menu_display` (2026-08), stages `symdump`,
`finalframe` (`L-ff-1`/`L-ff-2`), `birthorder`.

### L54. An array's unaddressed interior is spendable frame

An array whose **base only** is ever addressed can be shrunk, and the freed
bytes handed to a new local declared immediately *before* it, with every other
home landing on its original offset: the block length is unchanged, the frame is
unchanged, and a registerisable local appears out of nothing. Declaration order
is the whole trick -- the new local must go on the side that leaves the array's
base where it was.

**Receipt -- T1.** `char rankbuffer[16]` → `[12]` plus one `s32` declared before
it: frame `−216` unchanged, every used home target-exact, and nine register rows
died because the function finally had a second symbol for the role. Verified to
scale -- `[8]` plus *two* new locals (one of them never referenced) is
byte-identical to the one-local build. Declaring the new local on the other side
of its neighbour costs 22 rows; shrinking without refilling the hole costs
213–227.

**Falsifies.** Two same-campaign ceiling certificates -- "29 locals is the
ceiling at this frame size", then "30" -- and the general form both rested on,
that a local supply is what the declaration list already says it is. The supply
was inside a declared array the whole time.

**Provenance:** `mp_watch_menu_display` (2026-08), stages `finalframe`
(`L-ff-3`, `L-ff-4`), `birthorder` (`L-bo-3`, which spent the last 4 bytes a
dead temp pool released -- those go to the **locals** block, never to temps).

### L62. A float scalar's load form is decided by its value, and the form decides the schedule

A single-precision constant reaches the code in one of two forms, and which
one it takes is a property of the **value**, not of the spelling:

* if the constant's low halfword is zero it is materialised inline --
  `lui` the high half, `mtc1` -- a *statement* load, emitted where the
  statement is;
* otherwise it needs a full 32-bit word, so cfe files it in `.rodata` and
  the reference becomes an `lwc1`.

> Therefore only the second form joins the function's **invariant-load
> group**: the block of `lwc1`s ugen hoists together at the top, in its own
> order. A constant a reader thinks of as "the same scale as the others"
> schedules with them iff its bit pattern forces the rodata form.

`0.01f` is `0x3C23D70A`; its low halfword is `0xD70A`, so it takes the
rodata form. `0.5f` is `0x3F000000`, low halfword zero, so it does not --
and no respelling of `0.5f` moves it into the group.

**Receipt -- T2**, from an exact match. `func_800508D4` (512 bytes,
`-O2 -mips2 -32 -Wo,-loopunroll,0`) is a four-scale routine whose residual
was a pure schedule difference of four words: the candidate materialised one
scale four instructions before the target did. The four scales are not four
of a kind -- three are int-representable and one is the TU's own `0.01f`
literal, and only the literal's `lwc1` belongs in the invariant group. Once
the unsigned scale was spelled as that literal, the object matched with the
target's own `f26/f24/f22/f20` group order.

**Falsifies.** The reading the campaign had been working from, that the
divergent load was a *placement* decision a declaration reorder could move.
Reordering the declaration produced a byte-identical object -- the same
object hash -- which is what it should do, because the pass never had a
choice to make: a statement load and an invariant load are different
constructs, not two placements of one.

**Scope.** The halfword rule is the load-form gate; the *group order* is
ugen's and is not claimed here.

**Provenance:** the reference campaign decomp (2026-08), resident anim
cohort, `func_800508D4`.

### L63. Declaration order places a call-crossing spill -- reconfirmed, and usable as a lever

Independent reconfirmation of
[L53](#l53-the-frame-is-a-byte-map-and-every-declared-local-has-a-home-in-it)
on an unrelated campaign, with the operational form spelled out: declared
locals take **descending** stack homes in **declaration order**, so moving a
declaration earlier moves its home *higher*, and the position of a
call-crossing local in the declaration list is what chooses which offset its
spill lands on. The lever is: when the instruction sequence is already exact
and only stack offsets differ, reorder semantically independent declarations
before inventing extra state.

**Receipt -- T2**, four exact matches in one cohort. On `func_80055970`
(436 bytes) declaring the second vehicle pointer **second** lands its
call-crossing spill on the target's `sp+0x48`; on `func_80055F64` declaring
the volatile `secondZ` before `secondY` retains the target home; on
`func_80056274` the declaration order alone fixes two target-pointer spill
homes; and on `frontDrawRectangles` (129 words) the screen dimensions'
declaration order recovers the target's `0x58`/`0x54` pair. Each is a
whole-object match through the project build, not a scratch score.

**Scope, and one open question.** L53 read the homes out of the **cfe**
intermediate and attributes the layout to cfe. This campaign's note recorded
the same behaviour as *uopt* homing the locals, on outcome evidence only --
it never read a pass. The operational rule is identical either way and both
campaigns measured it; which pass writes the map is settled by L53's
instrument, not by this reconfirmation.

**Provenance:** the reference campaign decomp (2026-08), resident collision
and front-end cohorts.

### L72. The declared block is a rounded quantum -- measure the frame, do not count declarations

Every declared local reserves a home
([L53](#l53-the-frame-is-a-byte-map-and-every-declared-local-has-a-home-in-it)),
including one the allocator colours into a register and never spills;
`register` does not suppress the reservation, and that was measured rather
than assumed. But the block is rounded up to **8 bytes**, so a declaration is
free whenever the block is already odd, and a declaration count is therefore
not a frame size. The operational rule is the negative one: **read the frame,
do not count the declarations.**

**Receipt -- T2**, a five-build ladder on one function. On
`func_overlay_022_F0000000` seven declared locals give a `0x58` frame, six give
`0x58`, and five give `0x50`: the 7→6 step is the rounding and is free, the
6→5 step is the quantum.

**Falsifies.** "Removing a declaration shrinks the frame by four." Half of
these steps cost nothing. It also falsifies the reverse inference: that an
8-byte frame difference names two declarations. It names one quantum, and how
many declarations that is depends on where the block already sat.

**Counter-examples, both measured.** Not every declared scalar owns a home. On
`func_overlay_036_F0000818` removing `center` **together with** the
six-statement high/low juggle it feeds -- four locals instead of six -- produced
a **byte-identical** object (sha1 `d5b15a9c149a`, 63 instructions, frame
`0x80`, the same 7 differing words), and the same sha1 is produced by a variant
that replaces the juggle and removes **no** declaration at all. Two
declarations came out for nothing, which is what the lane means by "`center`
never owned a home"; on that function the frame moves only when one particular
local goes, and never reaches the target's. Second: a frame delta is not
always a declaration. On `func_overlay_029_F0000EE0` folding two locals into
one left the frame at `-112` and cost two words (29 → 31). That lane's own
next-lever line reads the two surplus words as temp/staging homes rather than
declarations, and proposes attacking the caller-save staging around a call;
that is a hypothesis it recorded, not a cause it measured, and it is repeated
here as one.

**Provenance:** the reference campaign decomp (2026-09-03), lane `lever-ov6`
for the frame ladder and the `func_overlay_036` counter-example, lane
`lever-ov8` for the `func_overlay_029` counter-example.

### L73. The declared-local *count*, not only the order, places a call-crossing home

The frame block is `[declared locals][cfe temps][uopt temps]`
([L53](#l53-the-frame-is-a-byte-map-and-every-declared-local-has-a-home-in-it)),
and declared locals take descending homes from the frame top in declaration
order ([L63](#l63-declaration-order-places-a-call-crossing-spill--reconfirmed-and-usable-as-a-lever)).
Reordering permutes slots inside the declared region. Changing how many locals
are declared moves a value between regions, and that is a different lever with
three directions.

> **Drop** a declaration, so a call-crossing common subexpression stays a
> compiler temporary and is homed in the temp region. **Reuse** a local that
> is already dead as the carrier, so the declared count falls by one and a
> later spill moves one slot. **Declare later**, so a value keeps its region
> and changes its slot.

**Receipt -- T2**, three matches on 2026-09-03, one per direction, each
recorded with its offsets.

* `overlay34InitStorage`, 46/50 words to exact. Frame `0x30` on both sides;
  besides `ra` at `sp+0x14` the only in-frame home was the byte count, at
  `sp+0x18` in the candidate against `sp+0x1C` in the target. Passing
  `count * (s32)sizeof(...)` into both calls and repeating the expression makes
  it a call-crossing common subexpression, which the hand-off records as taking
  a temp home rather than a declared-local home. **Note the direction as it is
  recorded**: the sp-relative offset moves *up* one word, `0x18` to `0x1C`,
  while the project's learnings page describes the same move as "one word
  lower" in the ladder's top-down ordering. Both descriptions are of this one
  measurement; nothing here resolves them into a general direction.
* `func_overlay_026_F0000B18_187AF10`, 129/131 words to exact at an unchanged
  131-word object. Thirteen declared locals occupy `sp+0x44..0x74` descending
  from the frame top, with the sole caller-save temp immediately below at
  `sp+0x40`; the target spills at `sp+0x44`, so it has twelve declared locals
  and the frame rounds up, leaving `sp+0x40` a hole. A local dead after the
  normalisation divides carries the value and the separate one disappears.
* `overlay84InitializeAndUpdate`, 172/179 words to exact. The target homes the
  pair at `sp+0x44`/`sp+0x40`, the candidate at `sp+0x4C`/`sp+0x48`; declaring
  the pair after the local whose slots it must follow lands them on the retail
  offsets.

**A caveat on these three receipts, from the record.** The two matches in the
first lane were promoted with the resident call sites left unrebound, and the
campaign branch they merged into **failed to link** until a later lane declared
the missing `objcopy --redefine-sym` steps; that hand-off states that anything
reporting a verified match after those promotions merged should be re-checked.
The per-function evidence above -- offsets, word counts, and the third match's
`promotion_trial exact in=0 out=0` -- is what the lanes recorded; a whole-ROM
verification of the first two inside that window is not claimed here and has
not been re-run against the current tree.

**Falsifies.** The reading of L63 that treats declaration *order* as the whole
lever. One of the three had already been through an order sweep:
`overlay34InitStorage` records reordering its four locals as having no effect,
because only one of them is ever homed.

**Scope.** The repeated expression must be one the compiler actually commons.
Where it declines, the cost is an extra materialisation:
`func_overlay_026`'s ruled-out variant inlined the difference at three sites
and the CSE declined, at **135 words**.

**Provenance:** the reference campaign decomp (2026-09-03), lanes `lever-ov3`
(the first two) and `lever-ov4` (the third).

### L74. An 8-byte aggregate declared last sits below the temp region and holds the frame from there

A declared aggregate at the end of the declaration list is placed **below the
temp region**, and the frame size is held from there. Moving it up the list
does not merely reorder two homes: the whole temp region moves by its size,
and every temp home with it. Deleting it collapses the frame.

**Receipt -- T2**, two builds against one target. On
`overlay84InitializeAndUpdate` an 8-byte `scratch` aggregate declared last
holds the frame at `0x58`. Moving it above the first scalar puts the two
scalars on their target homes but drops the whole temp region by 8 bytes,
moving an argument's home from `sp+0x38` to `sp+0x30` -- **10 words**, where
the declaration reorder alone
([L73](#l73-the-declared-local-count-not-only-the-order-places-a-call-crossing-home))
gave exact. Deleting it collapses the frame from `0x58` to `0x50`, **30
words**. The hand-off's conclusion is that `scratch` must stay last, and that
it is load-bearing rather than decoration.

**Falsifies.** "An unused-looking local array is spendable." Here it is what
holds the frame. That is a different claim from
[L54](#l54-an-arrays-unaddressed-interior-is-spendable-frame), which is about
the *interior* of an array that stays declared.

**Scope.** One 8-byte aggregate in one function, at the end of one declaration
list. The hand-off does not record whether its address is taken, and no such
premise is claimed here; a third variant that folded the two scalars into an
`s32 range[2]` and dropped `scratch` reached 109 instructions at frame `0x50`,
which is a different shape and not a further measurement of this law.

**Provenance:** the reference campaign decomp (2026-09-03), lane `lever-ov4`,
`overlay84InitializeAndUpdate`.

### L75. The temp order at a pointer add: what moves it, and what the record says does not

**This law was overstated and is restated to its evidence.** It previously
claimed that cfe canonicalises every pointer-add so that *no* spelling
reorders the temps it allocates, and cited a basin of five spellings
collapsing to one object and a flat permuter run. Neither is in the record,
and the record contradicts the scope: byte-offset arithmetic -- named there as
the untried direction -- was tried, and it *did* move the order.

What the shard records is narrower and still worth having. At one pointer-add
expression the baseline allocates **pointer, mask, then scale**. Semantically
equivalent byte-offset arithmetic changes that order to **mask, scale, then
pointer**, which makes the masked index exact and improves the body from
112/117 to 114/117 words with no change to size, frame, calls or relocations.
The order the target needs is **mask, pointer, then scale**, and no tried form
produces it.

> Therefore: the byte-offset rewrite is a real lever on this order and is
> already spent. Typed-pointer commutations, casts and assignment forms are
> recorded as exhausted, and repeating them is the recorded do-not-repeat.

**Receipt -- T2, with a T1 trace behind the order it names.** `levelFreeAll`
(`src/main/level.c`), 114/117 words, frame `0x28`, first mismatch `+0x13C`,
36/36 relocation offsets, types and identities exact. A hash-pinned IDO 5.3
ugen build that passed stock object fidelity for text, rodata, data,
relocations and symbols supplied the allocation order through its source-line
trace. Three register-only words remain, the pointer and scale temporaries
exchanged.

**Falsifies.** Its own earlier statement, above, and the habit that produced
it: reading a plateau note's "next lever" line as a description of what was
tried. The shard's `retained gain` field records the byte-offset rewrite as
**kept**, not as a suggestion.

**Scope.** One resident function, one expression. Nothing here says which pass
fixes the order, and no claim is made that a pointer add is canonicalised:
the one spelling change that was measured moved it. The remaining question is
which source form yields mask, pointer, scale.

**Provenance:** the reference campaign decomp, the project's own
`levelFreeAll` plateau-handoff shard, which carries no date. It is a resident
function; the overlay lever cohort behind L72–L74 and L76–L82 does not include
it.

---

## uopt (the optimizer)

### L6. A save "occurrence" is a basic block, not a source reference

In uopt's save computation, one occurrence is one **basic block** in which the
web appears. Uses and defs are per-block counts.

**Receipt -- T1.** Instrumented uopt with an extended occurrence record, gated
byte-identical; field offsets read from the pass itself; block pointers printed
and rank-ordered into a program-order index of 922 blocks, monotone in source
line, calibrated against four symbols identified by independent probes.

**Falsifies.** The undocumented but universally acted-on assumption that an
occurrence is a source reference. The consequence is operational: **a source
edit that moves a reference within a block changes the gross cost and leaves
the occurrence count untouched**, so any tooling that diffs occurrence counts
to identify a web is blind. Diff the gross. This is why occurrence probes
looked inert for two entire stages.

### L7. The save formula, exactly

```
gross = Σ_occ (uses + defs) × block_weight
      − LDSTCOST × block_weight per call-boundary reload
      − LDSTCOST × block_weight per second-pattern occurrence
n     = occurrences + bvectcard
div   = n < 3 ? n : ((n − 2) >> 2) + 2
save  = gross / div        (doubled for one dtype; that branch does not fire here)
class = (save > 0) ? 1 : 2        ← strict greater-than
```

Corollary, load-bearing: every gross term is non-negative, so **`save <= 0` is
reachable only through the two boundary charges**. Occurrence count and loop
depth can only push save *up*.

**Receipt -- T1.** Instrumented at the verdict store, which is the only writer,
plus per-occurrence and per-decision records. ~840 oracle builds across six
sweeps, gated to a named hash. Measured distribution: 293 of 404 uncoloured
webs sit at exactly zero net -- one unit of gross away from the strict `>`.

**Falsifies.** Two inherited claims: the divisor is the **compressed** count,
not the raw occurrence count; and the dtype doubling is a separate late step
that does not fire in this configuration. It also falsified **this workbench's
own field labels** -- one trace command was printing an equation asserting an
arithmetic relation the records do not establish, and a `class=` field that was
a different classification entirely. Both fixed.

**Scope.** The doubling branch is read from source, not measured here.

### L8. An uncoloured web is a memory home, not a ring temp

An uncoloured uopt web is a **memory local with a stack home and a store**. It
is not a ugen ring temp. A third state exists and is what a target often uses:
neither coloured nor stack-homed, because it is not a web at all -- it is an
anonymous ucode stack expression.

**Receipt -- T1.** Forcing a named intermediate to the uncoloured class did
produce the target's operand order and the desired register -- *and also emitted
a store to a stack slot*, taking raw differences from 1148 to 3940. The
upstream damage was not the colouring; it was the extra live web.

**Falsifies.** An entire residue question two stages had framed -- "how does a
one-statement float local avoid uopt colouring?" -- by showing the answer would
not reproduce the target even if obtained. Recorded as retired, not deferred.
This is the law that lets you *price* an answer before spending builds on it.

### L9. All du-chains of one variable merge into one web (the graft lever)

uopt merges every du-chain of one user variable into one web. So assigning an
expression to a **dead local** grafts the new chain onto that variable's web,
and the merged web usually keeps the donor's colour. Because decompiled names
encode the register the target used, this is a *directed* colour lever.

**Receipt -- T1 mechanism, T2 adoptions.** The mechanism was proven by a probe
showing one web carrying two disjoint chains at two loop weights. Three
adoptions banked 21 rows total, each with zero collateral and an identical
frame. ~95 builds.

**Scope -- heavily fenced.** Four rules, each earned:

1. The donor must be an **existing** local. A new declaration shifts the frame
   and costs roughly 500 constant rows (see [L14](#l14-a-new-declaration-costs-the-frame)).
2. The donor's other du-chains must be dead, disjoint, and non-loop. A
   loop-weighted donor drags the merged web up the decision order.
3. The name must encode the register you want kept.
4. One graft per web, verified by census.

Known failure classes: grafts onto a heavy global's CSE web are always
catastrophic; **no fp local carries a ring-register name, so this lever cannot
recolour ring temps at all**; and webs are keyed on ranges rather than symbols,
which bounds how much of "one variable" is really the key.

### L10. Dead-def grafts die before web founding

Dead-def grafts of **any** shape -- split definition or full redefinition -- are
eliminated before founding and collapse to the same object. Only occurrences
that survive to founding can flip claim order. Use-side reorderings inside
conditions are cfe-folded.

**Receipt -- T2, hash-exact.** A full early redefinition killed by an identical
later definition compiles to **byte-identically the same object** as a
structurally different split-definition graft. Byte identity of two different
constructs is the proof of a common absorption point.

**Falsifies.** The narrower rule from the previous stage, which had qualified
this as holding only when a compound redefinition follows. The qualifier was
removed. It also scoped out an earlier hypothesis about what governs founding.

**Scope.** Dead-def constructs only, and explicitly **not** an impossibility
claim about founding order: a *live* occurrence did flip founding and banked 13
rows. Web founding itself is live-ucode first-occurrence order, computed
**after** dead-code deletion -- which is the reason this law holds.

### L20. A copy-lever's temp NAME is inert; only site and count matter

Once a grafting site and a member count are fixed (see
[L9](#l9-all-du-chains-of-one-variable-merge-into-one-web-the-graft-lever)),
which *name* fills each slot does not change the object at all -- not the
score, not the register file, not the frame.

**Receipt -- T2, exhaustive.** 40 distinct ordered triples of dead `f32` locals
at one three-statement copy site, drawn from a 14-name pool, all compiled to
`ni = 4641`, all four positional coordinates identical, and the identical
positional word count. The rows the copy occupies were charged by the site,
not by any property of the 40 spellings tried there.

**Falsifies.** The implicit assumption behind every "try another temp name"
sweep at an already-identified site: that spelling is a free variable worth
searching. It is not, once the site and count are fixed -- a tool or a reader
should stop respelling and start asking why the *site* charges what it does.

**Scope.** Copy-lever grafts specifically. A name still matters for the
*register* a graft inherits when donor identity changes (L9's directed-lever
mechanism) -- this law is about respelling **within** one already-chosen
donor/site combination, not about choosing a different donor.

### L21. A mint requires an unwebbed memory load feeding an operation directly

Every construct observed to mint an interfering coloured web shares one shape:
an **unwebbed** memory load (a struct field, not an existing local) that feeds
an operation -- a comparison, an arithmetic op -- **directly**, with no
intervening assignment to a webbed local. A load that lands in an existing web
first, or a load whose result is only ever stored, does not mint.

**Receipt -- T2, unifying.** Established by elimination: three independently
discovered minters (a struct-field copy pair, a struct-field comparison hoist,
and an address pun) all fit the shape, and a large window of otherwise-plausible
candidate sites (nine source lines, dozens of respellings) were all inert
*because* each already routes its load through an existing web before use. The
inert results are explained by the same rule that explains the three positive
ones.

**Scope.** Necessary in every case observed; not proven sufficient in
general -- see [L22](#l22-a-mint-also-requires-an-address-exposed-frame-slot),
which found a load meeting this shape that still did not mint until a second
condition was met.

### L22. A mint also requires an address-exposed frame slot

An unwebbed load feeding an operation directly (L21) mints an interfering web
**only when uopt cannot register-promote it** -- and register promotion is
refused specifically when the value's stack slot is **address-exposed**
elsewhere in the function (something in the source takes its address, even
indirectly through a pun). The carrier that round-trips through that slot --
whichever declaration happens to occupy it -- is what mints, not the
expression or the variable name used to reach it.

**Receipt -- T2, positional, exhaustive.** A 186-position sweep transposing
which `f32` declaration occupies each frame slot found that only two adjacent
positions mint, and *whichever* declaration sits at the minting position
reproduces the same object **byte-for-byte**; moved off that position, the
same declaration is byte-identical to the base with no mint at all. The mint
follows the slot, independent of which source name or expression fills it.

**Falsifies.** The previous stage's narrower reading -- "extending a live range
across a boundary mints an interfering web" -- which was true of its one
example but named the wrong necessary condition: the mechanism is address
exposure of the slot the value round-trips through, not liveness extension by
itself. It also falsifies a claim from the stage before that: that a repeated
carrier at the same site is CSE'd into a single instance and so cannot mint
independently. Two independently-declared carriers at the delta-saturated
class (see [L25](#l25-a-delta-saturated-site-scores-identically-under-further-generators))
compose exactly by the group law and produce **different objects with the
same delta and the same instruction count** -- proof that the delta is a
property of the *site*, not of which carrier occupies it.

**Scope.** One procedure, one address-exposing pun (`&sp498 - 8`-style). Not
tested against a function with no address-exposed locals at all, where this
mechanism may not be reachable.

### L55. The eligibility gate: `save <= 0` is struck before colouring begins

Upstream of every cost the allocator computes, uopt applies an **eligibility
gate**: a web whose computed `save` is not strictly positive is struck from
colouring entirely and stays in memory permanently. Struck webs emit **no
`p1cand` and no `p1dec` record at all** -- they never reach the toll and
crossing arithmetic [L28](#l28-p1s-decision-is-net--bestcost-and-totalsave-is-net)
and [L56](#l56-the-callee-save-toll-is-a-saturating-size-term) describe. The
verdict byte is `(0.0f < save) ? 1 : 2`; verdict 2 sets `color = -1`, drops the
web out of the interference bitvector, decrements its neighbours' degrees, and
calls `whyuncolored()`.

```
save = ( Σ_occ w(bb)·(uses+defs)          gross
       − Σ_occ w(bb)·A·[reload(occ)]      chargeA, per USE
       − Σ_occ w(bb)·A·[store(occ)] )     chargeB, per DEF
     / divisor
A = 1.0 ;  w(bb) = 1.0 straight-line, 10.0 in a loop
nocs = #occurrences + bvectcard(web+12)
divisor = nocs < 3 ? nocs : 2 + ((nocs − 2) >> 2)
save *= 2  iff  dtype == 12
```

The gate is `> 0`, **not** `>= 0`: a web whose charges exactly cancel its gross
is struck. This is the mechanism by which ordinary plain locals get memory
homes -- not a lost cost contest, but an exclusion before the contest. The
measured driver of both charges is **aliasing**: an address-taken local's uses
need reloads (chargeA) and its defs need stores (chargeB), so `&x` in an
argument list is what puts `x` in memory.

**Receipt -- T1.** `compute_save`, `uopt.c` **L46f1ec–L46f254**, with a
codegen-inert rebuild of the CDX uopt emitting one `savedetail` record per call
and one `saveocc` record per occurrence (gate: reproduces two named object
hashes byte-exact). **262 of 512** webs in one function are struck. Nine webs
whose `net` is exactly `0.000000` at six decimals are all verdict 2. A
dead-code address-taken probe -- `if (0) { f(&colour, …); }`, zero instructions --
moved one web's `chargeB` from 0 to 8 and its `save` from 3.57 to 2.43, and a
forced verdict-2 on that web reproduced the champion's **entire** colour
assignment, web-for-web, at exact instruction parity.

**Falsifies.** Four hypotheses that had each been carried as the explanation for
memory residency, and one impossibility certificate. A fixed colourable-web
budget: false -- a lab sweep took the `p1dec` count 8 → 348 with no knee. An
occurrence-density or span penalty: false -- span moves only the divisor, which
is strictly positive and therefore can never change `save`'s sign. `dtype`/size:
false -- the only dtype term is a *doubling* for `dtype == 12`. An interference
degree term in `bestcost`: false -- `numintf` is printed and never priced. And
the certificate "the measured cost model forbids the target's allocation" was
measuring the wrong stage entirely: crossings price a candidate, charges decide
whether there is a candidate.

**Provenance:** `mp_watch_menu_display` (2026-08), stage `colourterm`
(`L-ct-1`…`L-ct-5`); generalises the ovl8 `chargeB` law
([L36](#l36-chargeb-exactly-a-store-placement-term)) by giving it its gate.

### L67. A comparison prints its copy-propagated variable first

When one operand of a comparison is a variable uopt has copy-propagated to
its source and the other is a constant, the emitted test names the
**variable first**, whatever order the C wrote. Writing `if (0 == *text)`
and `if (*text == 0)` therefore produce the same word; what *does* move the
printed order is whether the compared value is reached through a
copy-propagated carrier or is materialised at the site.

> Therefore operand order in a branch is not a spelling you choose. It is a
> readout of which side arrived as a propagated variable -- which makes it
> evidence about the *carrier*, and useless as a lever.

**Receipt -- T1**, from the CDX allocator trace on `func_8004D40C`. The trace
fixed every branch-operand order in the function at once, and the resulting
rule -- that the scan comparisons must be expression-direct on the propagated
pointer dereference rather than routed through a cached local -- took the
residual from five words to two. A `CDX_FORCE` swap on the same base proved
the remaining pair was one web the target splits.

**Falsifies.** The habit of permuting comparison operand order as a lever.
Every such permutation on this function produced the same object; the order
was never a free variable, and the builds spent on it were spent on nothing.

**Scope.** Constant-versus-variable comparisons. Variable-versus-variable
order is [L1](#l1-free-order-is-cfes-operand-order)'s question, not this
one, and is not claimed here.

**Provenance:** the reference campaign decomp (2026-08), font cohort,
`func_8004D40C`.

### L81. Address reassociation is insensitive to where the definition is written

When uopt reassociates an induction base into a constant offset from a live
pointer, which pointer it folds against is a property of what is live at the
point the value is formed, not of where the defining statement sits. Moving the
definition below the stores that follow it, into a loop's init clause, or
removing the local and spelling the expression at its uses all leave the fold
intact -- and two of those spellings compiled byte-identically to each other.

> Therefore a residual whose two sides fold the same address against
> *different* base pointers is not a statement-placement residual, and the
> emission order that follows from the base is not one either: it is
> downstream of a decision the placement does not reach.

**Receipt -- T2**, three variants against one target. On
`func_overlay_038_F0000000` the target forms the induction base as a small
constant offset from one pointer and the candidate from another; six of the
seven differing words are the emission order that follows. Dropping the local
and passing the field, in the hope that uopt's own reduction would mint the
target's initial value, produced 83 differing words at 81 instructions -- the
induction variable is genuinely in the source. Moving the definition below the
field stores sank both registers with it, 9 words. Initialising it in the loop's
init clause was **byte-identical** to the form it replaced.

**Falsifies.** The assumption that an address fold is reachable by moving the
statement that creates it -- the first thing three separate levers tried, on
three separate functions, at one build each.

**Scope, and a measurement warning that belongs with the law.** This residual
is invisible to a two-disassembly comparison of an overlay object: the seven
sites are relocation-masked and alignment absorbs the rest, so `diagnose`
reports the pair exact while the project's own comparison reports seven words.
Any claim about an overlay function's reachability must be made against the
project comparison, not against a scratch-shaped one
([L70](#l70-an-isolated-cc--c-does-not-schedule-like-the-project-path) is the
same failure at a different layer).

**Provenance:** the reference campaign decomp (2026-09-03),
`func_overlay_038_F0000000`.

### L82. An argument/return coalescing tie is not a source form

Where a web can be coloured either into the register a call takes its argument
in or into the register the call returns in, and both are live-compatible, the
choice is uopt's and no source spelling expresses it. The two locals a pool
lane suggests merging are, in this shape, already coalesced: merging them by
hand changes nothing.

**Receipt -- T3**, one function, one decisive build. On `overlay59PrepareEntry`
nine differing words are one web at seven sites: the target loads a descriptor
into the return register and spends a register copy in the call's delay slot,
the candidate colours the same web into the argument register and fills with a
no-op. Merging the two locals into one carrier -- the shape the pool lane
suggests -- produced a **byte-identical** object, sha1 `867bddc1205f`. Single
observation, not swept; recorded so the next analyst spends the one build on
something else.

**Falsifies.** The reading of a pool-lane suggestion as an edit. The lane says
two values share a colour in the target; it does not say the candidate has kept
them apart, and here uopt had already merged them.

**Scope.** The tie itself is directly decidable with a forced-colour probe
([the p1 decision arithmetic](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/p1-decision-arithmetic.md)), and this law is
what is left when that instrument is unavailable: the CDX profile was absent
from the campaign's instrumented uopt for the whole of this cohort, which is
why the class is T3 and not T1.

**Provenance:** the reference campaign decomp (2026-09-03),
`overlay59PrepareEntry`.

### L85. A truncation written at the store renumbers its synthetic temp

uopt mints a synthetic intermediate for a two-step narrowing cast and numbers
it where the truncation is written. Written as an *expression* cast the temp
is numbered in the expression; written as a **store** into a narrow local it
is numbered at the store, and a store is numbered LHS before RHS. Declaring
the local at its narrow type and dropping the explicit cast therefore moves
the temp: on the function below it went from web 48 to web 49, and both
threshold webs took the target's colours, 8 differing words to 3.

**What the numbers do and do not show.** The temp's partner stayed at web 50,
so 49 is still the lower of the pair and their relative order never changed.
The lever is therefore *not* a reordering of these two webs, and this law does
not claim one: what is recorded is that moving the truncation site moves the
synthetic temp's number, and that the colours came out right when it did. Which
intervening web the renumbering displaced -- and so why the colours changed -- is
not in the capture. Nothing here licenses reading a web-number change as a
reordering of the pair on either side of it.

Two preconditions, both measured, both required:

* the value must not be passed on after the narrowing store, or the store
  truncates a value a later call still needs. On the function below the
  else-branch store to the local was dropped and the call result passed
  directly first -- an edit already proved byte-identical
  -- so the narrow store could not reach it.
* the truncation must survive cfe. A store cfe has already coalesced away
  cannot be numbered at a site that no longer exists. That is how the
  else-branch edit above moved nothing: it left webs 48 and 50 on their
  numbers and shifted only an upstream web, 146 to 145. It is **not** why the
  four spellings in [L86](#l86-four-spellings-that-move-no-web-number) moved
  nothing -- each of those failed for its own reason, none of them a coalesced
  store.

> Therefore a renumbering edit is confirmed against a **second CDX capture**,
> never against the source diff.

**Receipt -- T1**, live records either side of the edit plus an object.
`overlay4UpdateObjectMotion`, seven builds: webs 48 and 50 are `type=4`
expression webs -- the `config->threshold` load and the synthetic intermediate
of the `(s16)` truncation, which uopt sinks out of the assignment and into the
comparison. Declaring `delta` as `s16` and dropping the cast renumbered the
temp **48 → 49**, closed both threshold webs, and took the residual from 8
differing words to 3 with the frame unchanged at -0x60 and the instruction
stream still exact. Reproduced byte-identically under the stock toolchain,
sha1 `8f11fe39ee5d`, so the result is not an artifact of the profile. The same
function's remaining three words are the reachability limit recorded in
[L86](#l86-four-spellings-that-move-no-web-number).

**Falsifies.** The belief that LHS-before-RHS is a property of the *statement*
a value appears in. It is a property of the site the truncation is written at,
and the same value written two ways is numbered in two places.

**Provenance:** the reference campaign decomp, overlay pool-spike lane
(2026-09-03), `overlay4UpdateObjectMotion`, adopted as commit `cd2b9500`
(2026-09-04).

### L86. Four spellings that move no web number

Measured on the function of
[L85](#l85-a-truncation-written-at-the-store-renumbers-its-synthetic-temp),
against the same capture:

| Spelling | What it did |
|---|---|
| swap two `s32` declarations | **byte-identical**: declaration order is inert for register-resident locals. It is [L63](#l63-declaration-order-places-a-call-crossing-spill--reconfirmed-and-usable-as-a-lever)'s lever only where a home is at stake |
| swap the comparison operands | **byte-identical**: cfe canonicalises relational operand order, so LHS-before-RHS does not apply at a comparison |
| read the value into an added local | shifts every downstream web number by a constant (22 → 25, 48 → 51, 50 → 53) and **reorders no pair** -- and it bought a stack home, 8 differing words to 22, frame -0x60 to -0x68 |
| hoist the timer read above the switch | 8 differing words to **209**. It did create the interference -- the timer took the second colour -- but the selector still numbered lower and took the first colour first |

> Therefore an added local is not a renumbering lever. It translates the
> numbering and a sweep that reads only the order is unmoved by a translation.

**And the floor this function actually sits on.** Its last three words are not
colour-reachable at all. Webs 13 and 22 arrive at their decisions with
identical records -- same save 1.5, same `numintf=4`, same
`forbidden0=0x00038000`, same `available0=0x7ffc0000` -- do not interfere, and
both take the lowest free colour. For the first to take the second colour, the
first colour must be forbidden to it, which needs an interference with a
holder of that colour; its whole neighbour set is entry-block pointers, a web
p1 splits, and one synthetic, while the two holders are late-block webs a
first-block web cannot reach. The pool populations are equal, so it is not a
population difference either. A different web **structure** is required, and
no spelling tried produced one without wrecking the instruction stream.

**Receipt -- T2**, four objects and one capture. The fourth spelling above is
the only recorded attempt at the different web *structure* the floor paragraph
calls for, and it is what "without wrecking the instruction stream" is measured
against. Three of the four spellings
above are byte-identical or measured objects; the numbering claims are read
from `p1color` records, which also show that when a spelling did move a number
it moved an upstream web (146 → 145) and left 13, 22, 48 and 50 exactly where
they were.

**Falsifies.** "Add a local to renumber the webs", which is the first thing a
numbering model suggests and which this function paid 14 extra differing words
to disprove. Also the reading of a residual with equal saves, equal
interference counts and equal masks as a tie a lever can break: it is two webs
the pass cannot tell apart, and neither numbering, priority nor affinity
separates them.

**Provenance:** the reference campaign decomp (2026-09-03), overlay pool-spike
lane, `overlay4UpdateObjectMotion`.

---

## p1 (the global-colour allocator)

Laws L26–L40 come from an IDO 5.3 `object_interaction` campaign (2026-08-08/09,
15 stages, 54 → 0 differing words), which spent most of its second half inside
`f_compute_save` and `f_split` -- the same pass L6–L9 already described, read
here at the level of individual `uopt.c` line numbers rather than build
outcomes alone. Each entry below carries a **Provenance** line naming the
stage and that stage's own law label, because the campaign's parallel stages
independently reused numbers -- two different stages each produced an "L84",
two each produced an "L60", and so on. The numbers below are this page's own,
assigned in the order the mechanism was nailed down; they do not match any
stage's internal numbering, and no stage's internal numbering is used
anywhere else on this page. [The p1 decision arithmetic](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/p1-decision-arithmetic.md)
walks the whole formula end to end with a worked example; this section is the
per-fact reference it cites.

### L26. Webs are keyed on storage, not on the C name

uopt's web-formation keys on the **stack slot** (or register-equivalent
storage location) a value round-trips through, never on which C identifier
names it. A constant-offset address pun, a `struct` wrapper, and a `union`
member reaching the same storage all compile to the **same web** -- and,
measured directly, the same object hash. **C cannot give one stack slot two
uopt symbols**, and the converse trap is just as real: a fresh declaration at
a *different* slot is a different web even when its value is provably
identical to an existing one (see [L14](#l14-a-new-declaration-costs-the-frame)).

**Receipt -- T2, hash-exact.** Six differently-spelled reads of one slot
(plain access, struct wrapper, three union member spellings, a raw pointer
pun) all compiled to the identical object hash. A `f32 x[1]` respelling of
the same slot costs +4 rows and `volatile` costs +7 with 11 loads -- neither
suppresses the web, because both still resolve to the same storage.

**Scope.** This is the fact [L39](#l39-copy-elimination-delete-the-redundant-copy-extend-the-temp)
and the fusion mechanism of
[L35](#l35-fusing-a-donor-imports-its-chargeb) both depend on: a "donor" or a
"copy elimination" is only free when the two spellings already share, or are
made to share, one piece of storage.

**Provenance:** stage `keyd`, originally L53.

### L27. The FP colour map, corrected

The IDO 5.3 floating-point colour-to-register map is `c24=$f0 c25=$f2
c26=$f12 c27=$f14 c28=$f16 c29=$f18`. `$f4`–`$f10` are never p1 colours at
all -- see [L38](#l38-p1-never-colours-into-the-local-fp-ring) for what they
are instead.

**Receipt -- T1, four independent object-level receipts** across four
separate forced-colour experiments, each reproducing a named hash.

**Falsifies.** An earlier reading in this same campaign (outside this page's
L40–93 source range) had asserted `c24=$f8 c25=$f10`, correct only from c26
upward, and had further concluded that landing a web naturally on c26
required first occupying c24/c25 -- a plausible-sounding but wrong inference
that sent multiple stages hunting for an "occupancy" lever. What actually
keeps a web off c24/c25 is `f_cupcosts`' call-boundary charge (see
[L28](#l28-p1s-decision-is-net--bestcost-and-totalsave-is-net)), not colour
occupancy -- a stage in this campaign's own line even read its own colour map
correctly for the *upper* two colours and still drew the wrong operational
conclusion from it, which is the reason this entry exists as a full law and
not a one-line erratum.

**Provenance:** stage `red`, originally L54.

### L28. p1's decision is `net <= bestcost`, and `totalsave` **is** `net`

The values a trace prints as `totalsave` and `net` are the identical number --
`totalsave = save × nocs`, and that product cancels back to `net` exactly,
in every record. p1's colouring/splitting decision is a single inequality,
`net <= bestcost`: true, the web is split (sent to `f_split`)
unconditionally; false, it stands and gets coloured. There is no third
outcome and no separate "decline" path reachable by any other route -- a
brief that says "make p1 decline this web" means, arithmetically, "make
`bestcost >= totalsave` at the moment this web is decided," nothing else.

**Receipt -- T1.** `f_globalcolor`, `uopt.c` **158777–158790**: `f6 = save *
nocs; cf = f6 <= f20 (bestcost); if (cf) f_split(...)`. Confirmed against
**1454/1454** `p1dec` records with zero discrepancies -- every one satisfies
`totalsave == net` to the last decimal.

**Falsifies.** The folk reading that treated `nocs`/`bbcard` as levers on the
*decision* -- "raise `bbcard` so the divisor steps and `save` halves" does
move `save`'s numeric value, but `nocs` cancels out of the product that
actually gates the decision, so that move changes the web's **rank** against
its neighbours and nothing about whether it splits. Also retires an earlier,
narrower reading in this campaign that treated "no decline" as an emergent
property of one specific web rather than the pass's actual control flow --
true in its conclusion, incomplete in its reason.

**Scope.** `f_needsplit`'s own spill path (a second route into memory
residency, gated on `regsleft == 0`) is reachable only from the
post-colouring neighbour loop, never from this decision. It is a different
mechanism and does not create a second way to "decline."

**Provenance:** stage `don`, originally L84 (disambiguated in this campaign's
own records as "L84-don" against `sev`'s unrelated L84,
[L32](#l32-web-fusion-by-rename-breaks-block-containment) below); the
weaker, single-web form of the same conclusion was first stated by stage
`keyb`, originally L40.

### L29. `nocs`, exactly -- L7's divisor, sourced and floored

`nocs` is the same quantity [L7](#l7-the-save-formula-exactly) calls `div`:
`nocs = f(occ + bbcard)`, where `f(X) = X` for `X < 3` and `((X−2)>>2)+2`
otherwise, and `bbcard` is the cardinality of the web's live-block bitvector
(`web+0x0c`) -- the count of basic blocks the web is **live into**, not the
count of blocks it is written or read in. `save = net / nocs`, doubled only
when `dtype == 12` (a branch this campaign never triggered: `dtype` was
always one of `{0, 6, 8, 13}` across 895 measured websurable). A direct
corollary: any web with two or more live-in blocks has `nocs >= 2`, so
**removing occurrences from such a web can only ever lower `save`**, never
raise it by shrinking the divisor.

**Receipt -- T1.** `f_compute_save`, `uopt.c` **154631–154905**. Verified
against 893 `savedetail` records with zero discrepancies, and independently
against a second 895-record sweep for the `dtype` branch.

**Falsifies.** A same-campaign proposal to remove one web's rarest
occurrence on the theory that it would step `nocs` down and double `save` --
arithmetically, the occurrence in question belonged to a web already at
`nocs = 2`, the campaign-minimum for a multi-block web, and removing it left
`nocs` unchanged while lowering `gross`, making `save` worse, not better. The
step function has a floor, and reading it as freely reversible at any
occurrence is the trap.

**Provenance:** stage `redb`, originally L62 (`nocs` formula); stage `sev`,
originally L87 (the floor-of-2 corollary and its falsification of the
mis-applied reversal).

### L30. `chargeA`: the boundary charge, exactly

`chargeA` is `1.0 x block_weight`, summed over every occurrence whose basic
block has a predecessor **outside** the web's own block set (the `nl` -- "not
local" -- flag) and which is not exempted by `canmoverlod`. This is one of the
two boundary charges [L7](#l7-the-save-formula-exactly) already named without
decomposing. A web with **any** such occurrence has `net >= 1 > bestcost` for
every live-range shape that keeps the occurrence -- it can never be declined
by shrinking or reshaping the web around it; the only way to change the
outcome is to remove the occurrence, or the web, before p1 sees it at all.

**Receipt -- T1.** The `nl` flag is written in the occurrence builder, `uopt.c`
**150695–150745** (`nl = occ+21`). Cross-checked against KEY-D's earlier,
coarser statement of the same conclusion (chargeA = count of nl-flagged
occurrences), which this entry supersedes with the exact bit location and the
`block_weight` multiplier KEY-D's version omitted.

**Scope -- the operational reading, quoted directly.** In this campaign's own
target web, one occurrence (`2.0f * x`, a doubled read in a single block)
contributed **two** uses in one boundary block by itself, which is why that
web's `net` floor was never reachable through source restructuring alone --
see [L35](#l35-fusing-a-donor-imports-its-chargeb) and
[L37](#l37-the-discarded-expression-lever) for the two constructs that
finally did remove it, neither of which is a "reshape."

**Provenance:** stage `keyd`, originally L55; refined with the exact
`uopt.c` location and multiplier by stage `redb`, originally L63; the
specific occurrence identified by stage `don`, originally L85 (disambiguated
as "L85-don" against `sev`'s unrelated L85,
[L32](#l32-web-fusion-by-rename-breaks-block-containment) below).

### L31. p1's colour-order tie-break: ascending web number

p1 visits webs sorted by `(−save, +web)` -- highest save first, and **ties
broken by the lower web number**. A web can therefore out-rank a
higher-`save` neighbour it is exactly tied with, provided it was founded
earlier. Any threshold reasoned against a lower-numbered competing web is
`>=`, not the strict `>` a naive reading of the sort produces.

**Receipt -- T1**, 486 decision records, 244 of them ties, zero violations of
the tie-break rule.

**Falsifies.** An earlier claim in this campaign that a specific pair of
webs was blocked by **strict** interference containment -- "no interference
construct can free the contested colour, because any blocker of the smaller
web is by construction also a blocker of the larger one." The strict-`>`
premise behind that claim is one notch too strong; the actual tie-break gave
the lever this law's falsification history needed
(see [L32](#l32-web-fusion-by-rename-breaks-block-containment)).

**Provenance:** stage `sev`, originally L83.

### L32. Web fusion by rename breaks block containment

Renaming every reference of a local `V` to an existing local `W` merges `V`'s
occurrences into `W`'s web: `W`'s `occ`, `bbcard`, and `nocs` all rise, and
**`W` also imports every interference edge `V` had** -- at zero instructions,
provided `V`'s and `W`'s live ranges were disjoint before the rename (uopt
[keys the merged web on the shared storage](#l26-webs-are-keyed-on-storage-not-on-the-c-name),
same mechanism as a graft, run in the opposite direction). This is the
construct that answers L31's "not strict" tie-break with an actual lever: a
block-containment relationship between two webs (one's forbidden-colour set a
subset of the other's) holds only while the smaller web's block set stays
what it is, and fusion changes that set.

**Receipt -- T1.** One measured fusion took a web from `gross 12 -> 21`,
`nocs 2 -> 4`, and imported the donor's full interference mask, reproduced
byte-for-byte against a hand-derived prediction.

**Falsifies.** The "no interference construct can help" half of the claim
[L31](#l31-p1s-colour-order-tie-break-ascending-web-number) already
falsified the premise of. With the premise gone, the conclusion (block
containment as recorded is a fixed, unbreakable barrier) does not survive
either.

**Provenance:** stage `sev`, originally L84 (disambiguated as "L84-sev"
against `don`'s unrelated L84, [L28](#l28-p1s-decision-is-net--bestcost-and-totalsave-is-net)
above) and L85. The block-containment claim it falsifies was stage `zed`,
originally L79.

### L33. `numintf`/`f_isconstrained` was not the carve switch here

`f_isconstrained` (`numintf >= LIMIT[regclassof(sym)]`, `uopt.c`
**153891–153950**, `LIMIT` at `0x1001e5fc + 4*class`) gates one specific
allocator behaviour, but it was **not** the switch controlling this
campaign's contested carve: forcing `numintf` across its measured range
produced no flip, nor did forcing `forbidden0 = 0xff` / `bestcost = 60` /
`regsleft = 4` individually or in conjunction (ten forced-oracle builds).
The actual mechanism was the interference **structure** inside `f_split`'s
own region-growing loop, `uopt.c` **155990–156090**, which stops growing a
region at a block where `f_is_cup_affecting_regs` fires.

**Receipt -- T1**, ten forced-oracle builds, all negative for the named
fields.

**Scope.** This is a scoped negative, not a claim that `f_isconstrained`
never matters -- only that it was ruled out, by direct force, as the
mechanism for one named site. One switch inside `f_split`'s region-growing
loop remains formally undecoded: a byte read at `sp+127` gates whether the
loop consults `f_is_cup_affecting_regs` at all, is read six times in
`f_split`, and is written nowhere in it. The campaign that found this closed
its target through a different mechanism ([L37](#l37-the-discarded-expression-lever))
before needing to decode it.

**Provenance:** stage `don`, originally L86 (disambiguated as "L86-don"
against `sev`'s unrelated L86,
[L34](#l34-a-pure-call-with-a-frozen-argument-may-be-moved-across-an-equivalent-call)
below).

### L34. A pure call with a frozen argument may be moved across an equivalent call

If a function is pure and its argument value is already frozen (no
intervening write reaches it) between two call sites, the **value** the
first call computed is provably equal to what the second call would compute,
and either call's result may serve either use. Concretely: a call at source
line *A* and a second call to the same pure function with the same
now-frozen argument at line *B* mean the def normally attributed to *B* can
be handed to a **dead donor local** while the original symbol still carries
the correct value from *A* -- because *A* dominates every read between the two
lines. This kills a web from source at zero added instructions whenever the
donor's forced store happens to land on the row the removed definition used
to occupy.

**Receipt -- T2, one constructive instance, function-wide.** One campaign
target dropped 52 -> 39 positional words this way, `ni` unchanged, both
recompiles reproducing the object.

**Scope.** This is stated as a *general* decompilation lever, not specific to
its one discovered instance -- the same campaign's own source has other
repeated calls to pure functions with arguments that become frozen between
call sites (`sqrtf`, `atan2f`), not swept here. A mechanical scan for
"repeated pure call, frozen argument between sites" is the natural next
instrument.

**Provenance:** stage `keyd`, originally L56.

### L35. Fusing a donor imports its chargeB

Renaming a **spilled** donor local's references onto a target symbol (the
same storage-keyed fusion as
[L32](#l32-web-fusion-by-rename-breaks-block-containment), applied to buy a
specific charge rather than to break containment) gives the target's web the
donor's `chargeB` contribution. Every split piece of the fused web then lands
at `net < 0`, i.e. class 2, and the whole symbol goes memory-resident with no
colour construct and no extra instructions under stock `cc`. The donor is not
optional: only a donor the ROM **itself** spills supplies a nonzero
`chargeB` (see [L36](#l36-chargeb-exactly-a-store-placement-term) for why),
so this family's price floor is fixed by the cheapest ROM-spilled donor
available -- one measured campaign had donors at 2, 4, 6, and 7 rows, with no
zero-cost donor found across 290 tried fusions.

**Receipt -- T1**, 290 fusion builds, oracle-verified against a forced-colour
target.

**Falsifies.** Nothing on this page; superseded in its *explanation* (not its
result) by [L36](#l36-chargeb-exactly-a-store-placement-term), which is the
direct read of the mechanism this entry originally attributed to "a
definition before a loop, with a use inside it." The floor this entry
establishes stands -- it was simply not the cheapest route once L37 was
found.

**Provenance:** stage `don`, originally L89 (the kill mechanism, its causal
account since corrected) and L90 (the price floor, which stands).

### L36. `chargeB`, exactly: a store-placement term

`chargeB = Σ weight(bb(q))` over occurrences `q` satisfying `w34 ∧ ¬o23 ∧ o22
∧ (defs != 0 ∨ nl = 0)`, where `w34` = "the web has at least one occurrence
that is a definition," and `o22` = `¬f_allsucmember(successors, web+0x14)` --
the definition does **not** reach all of the block's successors. This is a
**store-placement** condition: it fires whenever a definition's value does
not provably reach every path out of its block, regardless of whether a loop
is anywhere nearby. A loop contributes only through `weight`, which is ×10
per loop-nesting level rather than the ×1 of straight-line code -- the same
`block_weight` multiplier [L7](#l7-the-save-formula-exactly) already uses
throughout the save formula.

**Receipt -- T1.** `uopt.c` **154761–154808** (the `chargeB` gate itself),
**149841–149851** and **153573–153615** (`w34`), **150947–151122** (`o22`).
Cross-checked against two independent kills: one where every contributing
weight was 10 (inside a loop), and a second, later one where every
contributing weight was 1 (no loop at all) -- both fired `chargeB` correctly
by the formula above.

**Falsifies.** The immediately preceding reading in this same campaign,
which had attributed a successful kill to "a donor whose definition precedes
a loop and whose use is inside it" -- a plausible story built from a single
positive example, where every contributing donor happened to be
loop-adjacent. Read from the pass source directly, the loop was never a
precondition: it was a coincidence of which donors happened to be available,
supplying only the weight multiplier, never the gate condition itself. The
donor-fusion **result**
([L35](#l35-fusing-a-donor-imports-its-chargeb)) is unaffected; only its
explanation was wrong.

**Provenance:** stage `omega`, originally L92, correcting stage `don`'s
originally L89.

### L37. The discarded-expression lever

A statement that reads a local and discards the value -- `if (v);`, or a
value-guarded form like `if (v != 0.0f);` -- compiles to **zero
instructions** and adds nothing to `gross`, but it still creates an
occurrence, and that occurrence is a **definition-adjacent read** that can
satisfy [L36](#l36-chargeb-exactly-a-store-placement-term)'s `o22`/`w34`
conditions on its own. Where the web already has a qualifying definition
elsewhere, adding this occurrence reshapes `f_split`'s region growth so every
resulting piece gains the exit edge `chargeB` needs, `net` drops below zero
for every piece, and the symbol goes memory-resident with **no donor, no
second stack home, and no instruction cost at all** -- the cheapest possible
route to the outcome [L35](#l35-fusing-a-donor-imports-its-chargeb) reaches
by fusion.

Value-guarded spellings (`if (v != 0.0f);`, `if (v < 0.0f);`, `if ((s32) v);`)
are strictly better than the bare `if (v);`: the bare form can merge with a
neighbouring empty-body guard at the assembler and cost a real `bc1f`+`nop`
pair, which a value-guarded form does not.

**Receipt -- T1.** This is the construct that closed a full campaign's last
residual words to zero. 3,930 candidate sources / 3,876 objects built to
find the one insertion point that scored 0 (305 of 999 tried insertion
positions scored 0 by themselves; the specific point chosen was the only one
provably assigned by every other constraint). The resulting object is
byte-identical to the ROM in all 4644 instructions.

**Falsifies.** Nothing directly, but it retires the assumption every
disassembly-only reconstruction makes implicitly: that every source
statement present in the original has a visible machine-code trace. See
[L48](#l48-zero-footprint-statements-can-be-load-bearing) for that lesson
stated on its own.

**Provenance:** stage `omega`, originally L91.

### L38. p1 never colours into the local FP ring

p1's colour set is exactly `{$f0, $f2, $f12, $f14, $f16, $f18, $f20}` -- see
[L27](#l27-the-fp-colour-map-corrected). `$f4`, `$f6`, `$f8`, `$f10` are
[ugen's local scratch ring](../field-guide.md#the-allocation-law-ido-53-read-from-ugen-source-and-instrumented)
(see also [L13](#l13-the-fp-ring-is-four-wide-f4-f6-f8-f10)) and are **never**
a p1 colour, in either direction: p1 cannot claim them, and
nothing that lands in them was ever a coloured web. A direct consequence: a
minted web at a source site where the ROM has **no** web there costs at
least 2 rows (one for the definition, one for the use) -- there is no route
to a zero-cost plant at such a site, because the register a plant would need
to reuse is never actually a colour. A zero-cost route at such a site is
therefore always evidence of a **missing temp in the decompiled C**, not a
free lever. It belongs to the "split machine temp" and "missing local" error
classes.

**Receipt -- T1**, consistent with L13's and L27's independent measurements
of the same ring.

**Provenance:** stage `b4u`, originally L75.

### L39. Copy-elimination: delete the redundant copy, extend the temp

When decompiled source computes a value into a compiler-visible temp `T` and
then copies it into a named symbol `S` (`T = expr; S = T;`), the register the
source is chasing is frequently **already on `T`** -- deleting the copy and
extending `T`'s live range over `S`'s former uses reaches it directly,
because `S` never has to change colour: it simply stops existing over that
range. This heals a colour mismatch some campaigns spend many stages
searching for as if the fix had to move `S`'s own web.

**Receipt -- T1**, one measured instance closing a full colour transposition
at zero instructions, byte-identical to the ROM at every coordinate.

**Falsifies.** Nothing named on this page, but it retroactively explains
several stages' worth of failed attempts, in the same campaign, to move `S`'s
colour directly against a block-level colour reservation -- the reservation
was real ([L32](#l32-web-fusion-by-rename-breaks-block-containment)'s
containment relationship), and the lever was never on that side of the copy.

**Provenance:** stage `redb`, originally L60.

### L40. Routing through a third symbol is copy-propagated away

Introducing an intermediate named symbol purely to carry a value from one
expression to another (`T = <expr>; f(T, ...)`) does not create a new web or
a new occurrence when `T` is otherwise unused: uopt copy-propagates it away
before web-building, and the object is byte-identical to writing the
expression directly at the call site. **To change which web a value belongs
to, the edit must touch the symbol that already owns the value** -- see
[L26](#l26-webs-are-keyed-on-storage-not-on-the-c-name).

**Receipt -- T2**, 44 of 44 instances confirmed on one base, 4 of 4
re-confirmed on a second, independent base after an unrelated rebase.

**Provenance:** stage `eye`, originally L66.

### L56. The callee-save toll is a saturating size term

The cost p1 charges for the **first** callee-saved register a web wants is
`clamp(nBB / 4, 4, 60)`, where `nBB` is the procedure's basic-block count as
uopt builds it -- one block per call, two per `if`, plus one. It is a **size**
term, not a save/restore price: `+0.25` per call, `+0.50` per `if`, `+0.0` per
straight-line instruction, `+0.0` per unit of loop *weight*, floored at 4 and
**saturated at exactly 60**. Two companions complete the ladder:
`cost_caller = 2 × call crossings` (weighted by block weight), and a callee
register already in the save mask that the web does not interfere with costs
**0**. So a large procedure pays a flat 60 and the toll is not a
source-reachable quantity there: only a web whose `totalsave` clears the toll
can *open* the bank, and every cheaper web queues behind that opener, taking its
register for free afterwards.

**Receipt -- T1.** A synthetic lab reading `p1cost`/`p1dec` off the instrumented
uopt across three independent slopes, exact at six decimals in every cell:
calls 3 → 60, `if`s 1 → 400, +300 straight-line instructions (no change), a
100-trip loop (its blocks only). The clamp is measured at 60.000000 from
`nBB = 241` upward. On a real 222-call procedure, adding an `if` and removing an
`if` both left `TOLL = 60.000000`.

**Falsifies.** Four hypotheses that had each been treated as the reason a
register was unaffordable. **Amortisation** (the toll justified against the sum
of queued beneficiaries): false -- 80 webs sit at `bestcost = 60.000000`, each
judged on its own `totalsave`; there is no pre-scan and no queue. **Pairing** (a
second callee register discounted once the first is saved): false -- with `s0`
and `s1` in the mask, `s2` still costs the full 60; "already claimed costs 0" is
register *identity*, not bank state. **Frame-already-saves**: false, same
records. **Order/retry** (declined webs re-offered once the bank opens): false --
249 `p1dec` records and **zero** `p2dec`/`p2color` records; a declined web
splits, and its fragments are decided as *new* webs at their own lower `save`,
never re-offered the original decision. It also retires the reading of "60" as a
constant, which is what made the toll look like an unmovable law of the
allocator rather than a property of procedure size.

**Provenance:** `mp_watch_menu_display` (2026-08), stage `tolllaw`
(`L-tl-1`…`L-tl-3`).

### L57. The copy-relation channel: `available0` is an argmin, not a complement

`available0` is **not** the complement of `forbidden0`. It is the **argmin set
of `f_cupcosts` over the non-forbidden colours** -- the colours that are cheapest
once copy relations are priced. A copy relation is a **physical `pmov`** in
either direction (call-argument setup, call results, formal-parameter copies);
each candidate colour accumulates the cost of the copies it would leave
unelided. Ties leave every tied bit set, and the **lowest-numbered register
wins** among them. There is no bypass: a copy relation cannot hand a web a
forbidden colour, it can only re-rank the ones still allowed.

**Receipt -- T1.** `uopt.c` **158465–158573**, read out and checked against the
decision records: the campaign's contested carrier had `f_cupcosts` cost **0 at
every candidate colour** and therefore lost its target register purely on the
lowest-number tie-break -- which is why every copy-cost lever aimed at it (copy
survival, displacement, role promotion, union) measured 38–937 rows and none
moved the colour.

**Falsifies.** An earlier same-campaign reading -- "a web copy-related to an
argument register gets `available0` narrowed to that register, bypassing the
forbids" -- which was an inference from one record pair and sent a stage hunting
for a bypass that does not exist. The narrowing is real; the bypass is not.

**Provenance:** `mp_watch_menu_display` (2026-08), stages `moveabsorb`
(`L-ma`, the falsified form) and `channel3` (the decoded form).

### L58. `forbidden0` is seeded from hard-register conflicts -- argument pins steer colours

Before the colouring worklist runs, `forbidden0` is seeded from **two** sources:
the assigned colours on the web's adjacency list, *and* the hard-register
conflict bit-vector. A web that is live across a call's **argument setup**
therefore inherits a forbid from every argument pin that call writes. This is a
**source-reachable register-steering channel**: give a value a live range that
spans a call which pins the register you do not want it to take, and it takes
the next one instead -- at zero instructions.

**Receipt -- T1.** Two `p1dec` ladders across a two-statement source diff.
Carrying a string pointer in the column-select carrier put that web live across
a `sprintf` whose format argument pins `a1`; `forbidden0` moved
`0x70000000 → 0x7a000000`, the web moved `a1 → a2`, and six column sites became
register-for-register target-exact at exact instruction parity and unchanged
frame. The register the displaced web freed was taken by the unroller's
remainder bound, mirror-image, in the same records.

**Falsifies.** Six earlier certificates in the same campaign -- a missing symbol,
a density gate, an unroller range gate, a band web, a copy-cost channel, and a
role-split -- every one of which was hunting an **arithmetic** route to what is a
**conflict-vector** fact. Cost reasoning cannot reach a register that liveness
forbids, and no amount of it will.

**Scope.** The pinning call must be a real call in the emitted code; the forbid
follows the whole web, so a symbol carrying two roles inherits the forbid for
both -- which is how one lever's fix created a second, register-swapped family
until the roles were split onto two symbols
([L54](#l54-an-arrays-unaddressed-interior-is-spendable-frame)).

**Provenance:** `mp_watch_menu_display` (2026-08), stages `unrollcrack`
(`L-uc-3`, the seeding), `wordsaudit` (`L-wa-1`, the lever).

### L66. A web feeding a call argument inherits that argument's register at cost 0

When a web's only consumer is a call argument, p1 charges **nothing** for
colouring it into that argument register: the copy the call would otherwise
need is exactly what the colouring saves, so the affinity wins the contest
before any reweighting lever is reached. The consequence is a source shape
that reads as wasteful and is not: **re-caching a base into the same local
on every loop iteration** keeps that local on the argument register across
the loop, while the value that varies stays a junior temp.

> Therefore an argument register showing up as a loop-carried base is not a
> coincidence to be permuted away. It is the affinity, and the source form
> that reproduces it is the redundant-looking re-cache.

This is the cost-side companion to
[L58](#l58-forbidden0-is-seeded-from-hard-register-conflicts--argument-pins-steer-colours):
L58 says an argument pin *forbids* colours to its neighbours; this says the
same pin *offers* its own colour, free, to the web that feeds it.

**Receipt -- T1**, from the CDX allocator trace on `func_80038750` (296
bytes, exact through the project build). The trace showed the destination
local carrying the callee's `a1`-argument affinity; spelling the relocation
loop so the table base is re-cached into that local each iteration put the
base on `a1` and left the element on `a0` as a junior temp, and the object,
its jump table, and its linked ROM range are exact.

**Falsifies.** The reading that a loop-invariant base re-assigned inside the
loop is redundant code to be hoisted. Hoisting it is what loses the argument
register.

**Scope -- one observation, not swept.** The instrument was read, so the
receipt is T1 for the trace it came from; the *generality* is not. One
procedure, one call, one argument register was measured, and the cost-0
affinity is stated here for the case where a web's **only** consumer is that
call argument. What is untested: a web feeding two calls with different
argument positions, a web read after the call as well, and whether the
affinity survives against a competing pin -- all three are cases where L58's
forbidden mask and this cost meet, and which of them wins was never measured.
Treat the re-cache lever as a lead outside the single-consumer shape.

**Provenance:** the reference campaign decomp (2026-08), resident menu
cohort, `func_80038750`.

### L83. p2 visits webs in web-number order, and the save cost is inert there

The caller-saved sweep takes the procedure's webs in **ascending web number**
and gives each the lowest colour still free. It computes a save for every one
of them and does not order on it: every `p2dec` in the two procedures below
records `bestcost=0.000000`, and the largest save in the first is coloured
sixth.

> Therefore nothing that changes a web's use count or loop depth moves its
> position in this sweep: the visit order is the web number and the save is
> computed and discarded. That is what the sweep orders on. It is **not** a
> statement that a p2 rotation is reachable, and the record contains the
> counter-example: `overlay40FadeRecords` is 21 p2 decisions with pool lanes
> equal at 27 slots -- a rotation by every test above -- and is recorded not
> colour-reachable, because the target's load definition sits in a different
> web *partition*, which no visit order produces. Whether a given residual's
> colours are legal at all is answered by a force experiment
> ([the reachability field](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/json-contracts.md#the-lever-block)), not by
> this law.

**Receipt -- T1**, live records from the instrumented uopt CDX colouring
profile. `overlay43FilterImage`: 9 decisions, all p2, every `bestcost` zero,
visit order 0, 2, 6, 9, 12, 16, 60, 73, 84 -- strictly ascending -- against
saves of 560.5, 3.7, 23.7, 155.0, 200.0, 1400.0, 120.0, 25.0 and 10.0.
`overlay60ReassignChoiceSlots`: 10 decisions, all p2, all `bestcost` zero,
ascending web order, two webs declined at save 0. The profile's own identity
on this cohort is the receipt under
[L85](#l85-a-truncation-written-at-the-store-renumbers-its-synthetic-temp),
which reproduced byte-identically under the stock toolchain.

**Falsifies.** The reading of the two sweeps as one allocator with one order.
A campaign that has read [L28](#l28-p1s-decision-is-net--bestcost-and-totalsave-is-net)
and reaches for a save lever on a p2 web is spending builds on a number the
sweep does not consult.

**Provenance:** the reference campaign decomp (2026-09-03), overlay pool-spike
lane, `overlay43FilterImage` and `overlay60ReassignChoiceSlots`.

### L84. p1 is repeated max-save selection; the web number breaks ties only

The callee-saved sweep re-scans every uncoloured web each round and takes the
largest save, with **ascending web number as the tie-break**. The `p1cand`
records make it explicit: each round re-lists every uncoloured web with its
save and a running `best=`, and the winner is the maximum.

> Therefore a pair **tied** on save is ordered by web number and nothing
> else, and a pair across a save boundary is ordered by the save: reordering
> that one needs the cost changed, which means changing use counts or loop
> depth, which changes the instruction stream -- and a rotation is by
> definition a residual whose instruction stream is already right.
>
> A tie is the tie-break, not a lever. Two webs can tie and still be
> unreachable: webs 13 and 22 of the function below are members of the very
> tie group named here, arrive with identical save, interference count and
> masks, and do not interfere -- so neither numbering nor priority separates
> them ([L86](#l86-four-spellings-that-move-no-web-number)).

**Receipt -- T1**, live records. `overlay4UpdateObjectMotion` (proc ordinal 1)
selects webs 146, 98, 0, 132, 6 at saves 7.0, 4.0, 3.0, 2.0 and 1.714, and
then 2, 13, 22, 48, 50 -- five webs all tied at save 1.5, taken in ascending
web number. The tie is what a source edit can reach; the five saves above it
are not.

**Falsifies.** "The allocator colours by priority" as a single claim. Priority
orders p1 and orders nothing in p2 ([L83](#l83-p2-visits-webs-in-web-number-order-and-the-save-cost-is-inert-there)),
and which sweep owns a residual's webs is not visible in a disassembly.

**Provenance:** the reference campaign decomp (2026-09-03), overlay pool-spike
lane, `overlay4UpdateObjectMotion`.

---

## as1 (the assembler's instruction scheduler)

### L59. The scheduler's tie-break reads physical source line numbers

as1's list scheduler picks the **lexicographic minimum** of

```
( start_time, −aftercycles, −latency, node->addr, node->lineno, ready-list position )
```

and `node->lineno` is a **source line number**. Each key is a strict `<` accept
/ `!=` reject step, so the chain is exact lexicographic order. Where `node->addr`
is 0 for every node -- the ordinary case for a compiled TU -- `lineno` is the last
effective key before raw list order. **Physical source line numbers are a
codegen input at the scheduling stage**, and statement folding and blank lines
are therefore matching levers with no token change at all.

Two operational corollaries. A respelling that keeps each statement on its own
line **cannot** flip a `lineno` tie in the direction "later statement first" --
keys 1–4 are already equal by construction and no legal C ordering gives the
later statement the smaller number. The two reachable moves are to make the
lines **equal** (fold onto one physical line, so key 6 decides) or to move the
other instruction's owning statement later. And where a site needs *both*
orders -- two tied selections in the same pair of statements, wanted opposite
ways -- only equality can deliver it; an inversion fixes one and breaks the other.

**Receipt -- T1, from the compiler's own trace.** IDO 5.3 `as1` ships a
scheduler trace, reachable as **`cc -Wa,-R`** (option 13 of as1's 106-entry
option table), and it is **byte-inert**: the object built with `-R` is
`cmp`-identical to the object built without it, whole file. The rule was decoded
from the selection driver at `as1.c:69172` and confirmed against **2688**
recorded selections, of which 59 were decided by `lineno`. Eight differing rows
in a real function were all `lineno` decisions, and all eight fell to a
**whitespace-only** edit -- four `if/else` groups folded onto one physical line
each, token stream byte-identical after whitespace normalisation -- at exact
instruction parity, exact frame, and exact frame layout.

**Falsifies.** A same-campaign claim that those eight rows were
**basin-invariant**, carried across 21 respellings and several stages. They were
*line-number*-invariant: every one of the 21 respellings happened to preserve
the relative source-line order of the two tied instructions, which is the only
input the deciding key reads. It also moots, for this era, the apparatus of
patching a generated as1 behind a hash-pinned instrumentation profile -- the
stock assembler already prints a richer trace than the schema carries.

**Scope.** The pipeline-model branch that would instead score candidates through
`f_is_node_better` is gated on a global that is **off** for this driver
configuration; every observed selection is explained without it. And the lever
is the line number itself, nothing else at the site: restructuring one of these
statements into two to move an instruction earlier detonated the allocator
(936 rows). Where the residue is allocation-class rather than schedule-class,
line layout has **no** purchase -- a 13-word residue elsewhere in the same
function did not move under any of a dozen line layouts.

**Provenance:** `mp_watch_menu_display` (2026-08), stage `schedtie`
(`L-st-1`…`L-st-3`), re-confirmed inert on two later bases by stages
`wordsaudit` (`L-wa-2`) and `finalframe`.

### L79. A selection decided above `lineno` has no source lever

`lineno` is the **last** key in as1's selection chain, so a selection decided
on any earlier key is decided by readiness or by the critical path, and no
statement placement reaches it. The deciding key of a selection is therefore a
reachability test -- the cheapest one on this page, because the assembler
prints it.

A second, sharper form for the delay slot. In a block of *N* pre-branch nodes
whose branch becomes ready at cycle *N*−1, exactly one node is always left
over, and **a leftover node always wins the delay slot**; as1 fills the slot
speculatively from the fall-through successor only when the branch is the last
node picked. So a target that fills its delay slot from below needs a block
with a different node *count*, which is an instruction-count change and not a
placement change.

**Receipt -- T1**, from `cc -Wa,-R`. On `overlay1FindNextAngle` and its
identically-shaped twin `overlay1FindPreviousAngle` (2 words each) the
pre-branch block holds four nodes: the stack reload of the count is picked at
cycle 0 on the highest `aftercycles`, the address-high node at cycle 1, the
float load at cycle 2, and the branch becomes ready at cycle 3 on a load-use
latency. At cycle 3 the branch (`aftercycles` 1) outranks the remaining
zero-latency initialisation (`aftercycles` 0), so the branch is picked and the
leftover node necessarily fills the slot; the target has the branch picked at
cycle 4 with no leftover. **Seven levers were tried, over 7 as1 traces and 3
full builds.** Five were inert on the pair -- three line joins, one of which
left the object sha1 unchanged from the baseline, and two hoists of the
loop-counter initialiser that regressed to 51 instructions and 36 differing
words (the comma-operator form of the hoist was byte-identical to the plain
one). **One did move the schedule**: swapping the result initialiser above the
limit load put the *float load* into the delay slot instead, which confirms
the line tie-break among equal-`aftercycles` ready nodes and does not move the
branch. The positive control closes it: moving the limit load inside the
guarded block leaves three fillers, the branch becomes the last node picked,
and as1 *does* perform the successor fill the target shows -- the mechanism is
live, and the obstacle is the node count.

Three further functions fail the same test for three different reasons, which
is what makes it a test rather than one function's story. Their lane iterated
**compile-only** (`cc -Wa,-R` plus objdump), with a promotion trial as the
closing oracle, so no build count attaches to them. On `overlay11UpdateMenu`
every node in the block is stamped with the call statement's line, so the line
key has nothing to discriminate on; on `overlay33InitializeBuffers` the two
nodes differ on `aftercycles` (0 against 1); on `overlay1ResolvePathPoint`
they tie at `aftercycles` 4 and separate on `besttime`.

**Falsifies.** The general reading of L59 as "schedule residuals are a line
lever". They are, when `lineno` decides -- and that case closed two functions
the same week
([L80](#l80-a-loop-invariant-hoist-carries-the-loop-headers-line)). When an
earlier key decides, the line lever is not merely unlikely to work: the seven
levers above are what it costs to establish that one function at a time.

**Scope, and a disagreement about the chain that is left open.** These
hand-offs record the order as **highest `aftercycles` first, ties broken by
lowest `besttime`** (release recency, following ugen's emission order). This
workbench's own decoder places `besttime` *above* `aftercycles` and maximises
both, reproducing its own fixture's 2688 selections; L59 lists neither key in
that position and omits `besttime` entirely. Three readings, and nothing above
depends on which is right: readiness is the outer key and `lineno` is the last
key under all three, which is all the reachability test uses. Settling it is
improvement-backlog item 15's first job.

**Provenance:** the reference campaign decomp (2026-09-02/03), lane
`lever-as1` for the overlay 1 pair and lane `lever-ov2` for the other three.

### L80. A loop-invariant hoist carries the loop header's line

When an address or a bound is hoisted into a loop preheader, ugen stamps the
hoisted record with the **loop header's** source line, not the line of the
statement that uses it. Every initialiser written above the loop therefore
carries a strictly lower line into as1 and wins the minimised `lineno` key
with no dependence edge behind it. The initialiser cannot be moved later -- it
is already as late as C allows -- so the lever is to remove the difference
rather than to reverse it: put the initialiser on the loop header's
**physical line**.

A second-order form. Where the preheader materialises *several* invariants,
their order among themselves is ugen's **birth order**, and birth order
follows source statement order. A bound kept in a local is born before a count
read inline; spelling the bound inline in the loop test moves its birth after
the count.

**Receipt -- T1 on two functions, T2 on two more.** The emit-provenance records
(`DKWB-EMIT-V1`) were read for exactly two: `overlay40UpdateEntries`, recorded
"no dependency edge authenticates a new source form" at 44/46 words with four
regressed variants behind the verdict, went to **exact** with the loop-count
initialiser joined to the loop header's physical line -- `remaining = 7; do {`
as the source spells it, `count = 7; do {` in the generic form the project's
own learnings page uses; and `overlay57HandleModeInput`, recorded as needing
"source-authentic evidence for IDO's base-address scheduling", lost its three
scheduled words the same way. Both on 2026-09-02. **Only those two carry a
recorded fidelity gate**: built through the instrumented `cc` with traces off,
`.text` is `cmp`-identical to stock in both the shipped (`GLOBAL_ASM`) and
`-DNON_MATCHING` configurations.

The other two were closed on `diagnose` and `cc -Wa,-R`, with no emit trace.
`func_overlay_047_F00009D0` showed the LO16 relocation identities swapped at
the head of both release loops, with the pool lane confirming the two `addiu`s
issued cursor-first where retail issues bound-first; `entry = &D_0_entries;
do {` on one line, once per loop, took it from 10 words to 6. It had first
been sent the wrong way by explicit end-pointer locals initialised before the
cursors -- still 10 words, and flipping the `lui` pair instead, because birth
order follows statement order. `func_overlay_014_F0000000` needed both halves:
the bound spelled inline in the tail test so it is hoisted after the count,
and the cursor's initialiser joined to the `do {` line; 4/4 words, promotion
trial exact, ROM verifies.

**Falsifies.** Two recorded "unreachable by statement placement" verdicts,
both correct about the evidence in front of them and both wrong. The line the
scheduler reads was never printed, so the analyst compared the lines they
could see -- the statements' own -- and concluded that the earlier statement was
already as early as it goes. It was; the hoist was later than it looked.

**Scope, and a negative control worth running.** The join works where the two
records are separated **only** by their lines. Where they are not, it is inert
and says so cheaply: on `func_overlay_022_F0000000` joining the carrier's
assignment onto the `if` line compiled byte-identically, so that store pair is
not line-scheduled, and on `func_overlay_070_F00000D8` the comma-joined form
of a statement split did the same
([L78](#l78-a-pool-carried-accumulate-keeps-a-field-in-its-web-the-fused-form-spends-a-temp)).
A byte-identical object under a line join is evidence the residual is not
line-owned, and it costs one build. The lever also does not apply to register
renames, to delay-slot fills chosen by latency, or to relocation-surface
differences.

**Provenance:** the reference campaign decomp, the emit-provenance pass
(2026-09-02) for `overlay40UpdateEntries` and `overlay57HandleModeInput`, lane
`lever-ov7` (2026-09-03) for `func_overlay_047_F00009D0` and lane `lever-ov2`
for `func_overlay_014_F0000000`.

---

## ugen (the code generator)

### L11. ugen frees a binary op's sources in operand order

ugen's binary-operand handler frees the first operand's register, then the
second's. Release order equals operand order -- never the temp ID at the site.

**Receipt -- T1**, established twice independently: first from traces (874
identical events, with the first divergence in the free list's *tail* order),
then read directly from the pass source with both free calls located.

**Falsifies.** The working temp-ID-order hypothesis for release order, which
had been queued as the next front. Killing it at the site relocated the
question upstream to temp-ID renumbering, merging two problems that had been
worked separately.

This is the consumption half of [L1](#l1-free-order-is-cfes-operand-order).

### L12. The temp ring is least-recently-freed

Two singly-linked FIFO lists per register class. Allocation pops the **head**
of the free list, spilling the in-use head if the free list is empty; freeing
appends to the **tail**.

> Therefore allocation is a least-recently-freed round robin. The register
> chosen for the *n*-th temp is a pure function of the allocate/free event
> sequence that preceded it -- nothing else. There is no liveness heuristic, no
> preference, no ucode-temp-index mapping.

**Receipt -- T1**, source plus gated instrument plus an oracle sweep, including
a prediction-then-test: one instruction's register was explained from first
principles (two prologue folds burn ring slots without emitting anything), then
confirmed by rotating the initial free list and walking that instruction
through the ring exactly one step per rotation.

**Falsified in turn -- by itself, immediately.** The rotation that matched the
predicted instruction made the overall score *worse*. **The residue is
therefore not a ring phase.** Phase was worth 84 of 845 rows, and no choice of
initial free-list state can close the band. That negative retargeted the whole
campaign onto **class-crossing sites** -- where one side leaves as a ugen temp
what the other coloured -- and took the residual from 1416 to 572.

**Scope.** Per procedure: the register state is re-initialized once per
procedure and does not carry across, which is why levers placed in preceding
procedures were inert. List sizes are driver startup constants.

### L13. The fp ring is four wide: `f4 f6 f8 f10`

The initializer lists six registers, but two are withdrawn before the first
allocation and never handed out: **1460 of 1460** allocations were from the
four. The withdrawn pair are uopt colours.

**Rule filed with it: assert the ring width, do not derive it from the
initializer.**

**Receipt -- T1, exhaustive**, from an instrumented trace, cross-checked against
an independent uopt colour listing and re-confirmed twice in later stages.

**Falsifies.** The earlier stage's own write-up, which reported the initializer
and called it "the independent confirmation" of the ring. Reading it literally
cost ~15 builds and one wrong adoption path, because widening the set makes a
tool report **phantom closures** -- a move onto a uopt colour looks like a fix
and is not. It also falsified this workbench's prose, which had called the
withdrawn pair "genuinely ambiguous" and said the float free list "extends onto
them under pressure". Corrected; regression tests now lock the four-wide ring.

**Scope.** The *effective* ring for this driver's defaults. The withdrawal is
uopt's and is per-procedure.

### L23. Two independent copies take the ring colour their SOURCE ORDER sets

When two field-copy statements are independent of each other (neither reads
what the other writes) and both land on ring-temp candidates, **transposing
their source order** transposes which one gets which ring colour -- with no
other effect: the instruction count, the frame, and every other positional
coordinate stay identical. This is the first lever found in the campaign that
repairs a ring-colour mismatch without minting a new record at all.

**Receipt -- T2, swept.** 44 adjacent simple-assignment pairs in the procedure
were tried as the transposition; exactly one location produced the swap
(closing four rows of a residual byte-for-byte); nine more were score-neutral
but changed the object (a different, untested swap), and the remainder did
nothing. `ni` and frame were unchanged in every one of the 44.

**Scope.** Two source-adjacent, mutually-independent copy statements whose
values are both ring-temp (not uopt-web) candidates. Does not apply once
either side is coloured by uopt (see
[L8](#l8-an-uncoloured-web-is-a-memory-home-not-a-ring-temp)) -- this is a
purely ugen-side reordering.

### L14. A new declaration costs the frame

Introducing a new local shifts the frame and costs on the order of 500 constant
rows. Never introduce one; graft onto an existing dead local instead.

**Receipt -- T2, repeatedly**, across at least three independent stages that
each rediscovered it. Operationally this is the single most load-bearing rule
on this page.

### L15. There is no strength reduction in IDO 5.3 uopt

**Receipt -- T2**, ten scoped probes. Consequence: a target pattern requiring an
unnamed loop-carried web cannot be minted from source, because there is no pass
to mint it. Stated as measured-absent in this translation unit, not
proven-absent in the pass.

### L16. Register claims are advisory

Forcing a claim to a different register produces a **byte-identical object**
for non-ring registers: the force fires, the logs obey, and the emitted colour
binds upstream regardless.

**Receipt -- T1**, confirmed in two separate stages with two instruments.

**Falsifies.** A named force point from an earlier stage, which is now closed
as a lever and kept only as a log. This is the law that makes
[L2](#l2-claim-order-is-source-condition-order-test-order-is-canonicalized)
-- source condition order -- the only route to those rows.

### L17. ugen runs two fp allocation passes

The early allocation ordinals are **not** emission-ordered; the later ones are.
A knob indexed by allocation ordinal therefore looks structureless until the
boundary between the two passes is found.

**Receipt -- T1**, by binary search for the boundary. This is the arithmetic an
earlier entry had declared could not be written.

### L41. The temp-ring phase is a seven-slot vector, not four coordinates

The ring's rotation state at any point in a function is fully described by a
vector of independent phase counters, one per structurally distinct region of
the function (seven were found in one campaign's target: four adjacent
"band" regions plus three finer sub-regions inside one of them), each valued
in `ℤ₄` (the ring is four wide -- [L13](#l13-the-fp-ring-is-four-wide-f4-f6-f8-f10)).
Source edits move these coordinates **additively**: 87 of 87 tested
compositions of independently-measured edits predicted the resulting phase
vector exactly. A scorer that reduces this state to four whole-function
coordinates (or fewer) is not wrong about what it measures, but it is a
**lossy projection** -- two regions can individually disagree with the target
while a coarse four-coordinate read reports them as identity, and a region
that is only one ring-step from correct can be hidden behind a region that
is already correct, because the coarse coordinate is an average, not a
per-region fact.

**Receipt -- T2, exhaustive within one window.** 87/87 additive predictions
correct; the seven-slot model resolved a heal that the four-coordinate
model's owning campaign had failed to find for an entire prior stage.

**Falsifies.** A same-campaign claim, one stage earlier, that a specific
16-row window was "byte-exact if and only if" one whole-function phase
coordinate took a specific value -- stated as a fixed, function-wide
relationship. It was not fixed: it was true only on the base it was measured
on, and broke on the very next base, because the real state has more degrees
of freedom than the coordinate the claim was stated against could see.

**Scope.** The slot count (seven) and their boundaries are specific to the
one function measured; the mechanism -- additive per-region ring phase,
under-resolved by any coarser scorer -- is the general claim.

**Provenance:** stage `b4s`, originally L64; falsifies stage `b4r`,
originally L60.

### L42. One copy temp is one ring step -- unless the carrier repeats

Deleting or inserting one plain copy-through-a-temp statement (a
struct-to-local field copy with no other effect) steps every ring phase
coordinate downstream of it by exactly one ring position, and successive
steps at the same site compose multiplicatively (verified: two independently
measured deltas at the same site composed to exactly their product in the
ring's cyclic group). This holds **once per source line that supplies a
fresh occurrence** -- but a single carrier symbol used as the copy target at
**two distinct source lines** steps the phase **twice**, because uopt treats
each line's occurrence as a separate web-formation event even though both
name the same symbol; only a genuine multi-statement chain collapsed onto
**one** line is coalesced into a single step.

**Receipt -- T2.** Twenty scored objects, zero exceptions, for the
single-line case; a direct, deliberately-constructed counterexample (one
symbol, two lines) confirmed the double-step, `ni` and every positional
coordinate otherwise identical between the two readings.

**Falsifies.** An earlier, narrower statement in the same campaign that "a
multi-link chain at one source line steps the phase once, not once per
link" -- true as stated, but read too broadly by the stage after it as "one
*symbol* steps once," which the two-line counterexample disproves. The
scoping variable is the source **line**, not the symbol.

**Provenance:** stage `b4r`, originally L59 and L62; corrected by stage
`b4t`, originally L73.

### L43. The phase vector is additive; the damage is not

While the ring-phase state itself composes additively across independent
source edits ([L41](#l41-the-temp-ring-phase-is-a-seven-slot-vector-not-four-coordinates)),
the **positional word cost** of reaching a given phase state is not: two
edits whose row-damage footprints overlap do not sum, and a search that
prunes candidate compositions by their summed damage (rather than building
each one) can miss the cheapest route. One measured pair of edits, individually
+33 and +31 rows, composed to +33 -- not +64 -- because their damaged rows
overlapped. A search capped at a fixed number of composed atoms on the
assumption that damage estimates transfer is a search capped on a false
premise.

**Receipt -- T2**, direct build of the overlapping pair plus a wider sweep
that had been capped at three composed atoms on the additive-damage
assumption; the actual cheapest solution needed four.

**Scope.** This is the phase-mechanism analogue of
[L24](#l24-instruction-count-under-composition-is-not-additive): where L24
says instruction-count deltas do not sum under composition, this law says
the same about positional-word damage specifically inside one ring-phase
family, for the additive reason given above (row-set overlap), not for L24's
unrelated reasons (frame shifts, whole-procedure renumbering, CSE).

**Provenance:** stage `b4t`, originally L71.

### L44. A construct's delta class depends on the carrier, not only the site

At a fixed source site with a fixed construct shape, **which** local symbol
fills the carrier role can change the resulting phase delta's class, not
merely its cosmetic spelling. In one measured case, only the two
earliest-declared candidate locals at a site produced one delta class;
every other same-typed local available at that site produced a different,
more expensive one. A catalogue of "what this site's construct is worth"
that is keyed on the site alone, without recording which carrier was used
to measure it, silently under-resolves -- later reuse of the cheap number
against a different carrier is not reproducible.

**Receipt -- T2**, one site, one construct shape, full enumeration of the
available same-typed carrier pool.

**Falsifies.** A prior, differently-numbered law from an earlier stage of
the same campaign (outside this page's L26–48 source range, referenced here
only as "the delta belongs to the site") that had been carried forward
uncorrected through at least two later stages' work, including a census that
had thinned candidates on the strength of it.

**Provenance:** stage `b4s`, originally L65.

### L45. A fresh declaration's frame cost, reconfirmed

Independent reconfirmation of [L14](#l14-a-new-declaration-costs-the-frame)
on a second, unrelated campaign and a different function: introducing a
brand-new `f32` local (rather than recycling an existing dead one) shifted
the frame by 8 bytes and was unavailable as a carrier at an already
frame-saturated gate. The mechanism and the operational rule are identical
to L14; only the measured quantum differs (L14's host campaign measured
whole-function constant-row damage on the order of 500 rows for a different
function's frame; this campaign measured the frame-byte shift directly).
Both are the same fact -- a new automatic variable is a new stack home -- read
through different instruments.

**Receipt -- T2**, direct frame-size comparison, one declaration added and
removed.

**Provenance:** stage `b4s`, originally L68.

### L61. The FP expression-temp assignment has a closed form

Within one basic block, ugen assigns the FP expression temps
(`r0..r3 = f4, f6, f8, f10` -- the four-wide ring of
[L13](#l13-the-fp-ring-is-four-wide-f4-f6-f8-f10)) by a fixed rule. With
`j` the number of FP temps already consumed in the block before the current
statement and `n` the total FP temps the block consumes, the statement's
`i`-th temp is register

```
reg(i) = (n + d[(j + i) mod 4]) mod 4,   d = [0, 2, 3, 1]
```

The per-statement temp consumption was measured alongside it: a scalar
float copy costs 1; a float **struct** copy costs 0 (it lowers to integer
`lw`/`sw`); `neg.s` costs 2; an int→float conversion costs 2; a binary FP
operation costs 3; a three-deep expression chain costs 5.

**Receipt -- T2**, verified by construction against built objects; the same
closed form was reverse-engineered independently by two operators in
different campaigns, because ugen's temp allocator emits no trace
([roadmap](https://github.com/akratch/n64-decomp-workbench/blob/main/docs/roadmap.md) carries the instrument that would make this
directly observable, and future revisions T1).

**Provenance:** proxy stage `SGQkv`, an IDO 5.3 campaign, 2026-08-13.

### L64. The integer temp ring is seeded `t6 t7 t8 t9 t0 .. t5`

[L12](#l12-the-temp-ring-is-least-recently-freed) gives the discipline --
pop the head, free to the tail -- but not the initial state, and the initial
state is what decides every register in a procedure with no spills. The
integer free list is re-seeded once per procedure in the order

```
t6 t7 t8 t9 t0 t1 t2 t3 t4 t5
```

This is the startup order, not proof that every entry remains available.
Per-procedure reservations can remove shared registers before the first
allocation. UOPT's possible colors include t0–t5; a register-name-only lane
must not treat them as universally temporary or universally colored.

> Compare initialization/removal state before attributing a visible rotation
> to an extra pop. Observed return subsets alone do not prove the complete
> pool, and an instruction may disappear while its allocation still matters.

**Receipt -- T1**, from an instrumented ugen. Return-site hooks on the
free-list helper (`f_get_free_reg` -- the entry-side `ALLOC` hook logs the
*request* descriptor, not the register handed back) emit the allocated
register; the integer stream reads the seeded order directly, and the fp
stream reads the four-wide ring of
[L13](#l13-the-fp-ring-is-four-wide-f4-f6-f8-f10) rotating beside it.

**Falsifies.** The assumption three campaign agents worked from, that the
integer ring is seeded in register-number order from `t0`. Under it, a
correctly-diagnosed one-pop phase error is attributed to the wrong lever,
because the register the candidate "should" have is computed from the wrong
seed.

**Scope.** A startup constant, distinct from effective available membership,
and per procedure: the list is re-seeded at procedure entry and does not carry
across, which is why levers placed in a preceding procedure are inert.

**Provenance:** the reference campaign decomp (2026-08), instrumented-ugen
free-list traces; the same seed is the register profile this workbench
ships for IDO 5.3 at `-O2 -mips2`.

### L65. A redundant mask still costs one ring pop -- the phantom pop

A mask that folds away into the field it writes -- `x & 1` into a 1-bit
field, `x & 0xFF` into a `u8` field, `x & 0xFFFF` into a `u16` one -- emits
**no instruction** and still consumes **one pop** of the temp ring. (The
fold is the compiler's, not the assembler's; which pass performs it was not
read, and nothing below depends on the answer.) The pop is real; only the
instruction is absent. So the construct is a pure one-step ring rotation
with no positional cost, and it works in both directions: adding one
advances the ring by one, and *removing* an existing redundant mask retards
it by one.

> Therefore a ring phase error of exactly one step has a free lever at
> either end, and the site to look at is the source line that consumes two
> pops where the target's consumes one.

**Receipt -- T1**, both directions, on two functions. Adding a `& 1`
redundant with a 1-bit field insert supplied the missing pop on
`func_8003A520` and made the object, its relocations and its linked ROM
range exact. In the other direction, free-list records carrying ugen's
current source line located a phantom pop on `func_8001A154` -- one line, a
`& 0xFFFFU` on a `u8` field, was the only line consuming two pops -- and
removing that mask realigned the entire field-copy ring onto the target.

**Falsifies.** The rule of thumb that a codegen-inert construct is
codegen-inert. It is instruction-inert; the ring is state, and state is what
the next allocation reads. This is also why a "no source lever" verdict on a
ring residual is premature until the pop *lines* have been read: on
`func_8001A154` the mask removal was found by the line provenance, not by
inspection, and the function had been recorded as a scheduler wall before
it.

**Scope.** One pop per folded mask, measured on integer field copies. The
same construct on a value that cannot be folded away is an ordinary
instruction and is not this lever.

**Provenance:** the reference campaign decomp (2026-08), `func_8003A520`
(field-guide lever 16) and `func_8001A154` (instrumented free-list line
provenance).

### L76. A struct field read through a local costs one ring pop a direct read does not

Naming a struct field in a local and using the local costs **one extra ring
pop** against reading the field where it is used, even where the two forms emit
the same instructions. The local's value is a candidate for a coloured web; the
direct read is an expression, and an expression takes a ring temp. So the
construct is a one-step ring rotation in the same sense as
[L65](#l65-a-redundant-mask-still-costs-one-ring-pop--the-phantom-pop)'s
phantom mask, available in both directions, and unlike the mask it is a shape a
1999 source tree writes for legibility rather than a fake.

**Receipt -- T1**, from free-list records carrying ugen's own source line. On
`overlay20UpdateObjectResource` a scoped bound-check local made the check a
uopt-coloured pool web where the target pops a ring temp; reading the field
directly restored the pop. The line provenance is what located it: the trace
gives an allocation ordinal per expression site, and the differing site was one
line.

**Falsifies.** "A local that only carries a field read is codegen-inert." It is
instruction-inert.

**Scope, and the composition rule that matters more than the law.** This lever
alone was a **regression** on the function it closed -- 25 differing words
against a plateau of 8 -- and became exact only composed with
[L77](#l77-an-index-scaled-twice-costs-one-more-ring-pop-than-an-index-scaled-once).
Where a ring is two pops out of phase, two levers are needed and neither is
individually an improvement, which is precisely why a bounded permutation over
single edits does not find them.

**Provenance:** the reference campaign decomp (2026-09-03),
`overlay20UpdateObjectResource`, 90/98 words to exact.

### L77. An index scaled twice costs one more ring pop than an index scaled once

An index that is scaled twice -- multiplied in the expression and again by the
array's own element size -- burns an **invisible temp** between the base load
and the shift, and so costs one more ring pop than the same access with a
single scale. No instruction distinguishes the two forms. The lever is
therefore a *typing* choice: typing a table as pairs and indexing the pair
scales twice, typing it as elements and indexing the element scales once, and
the two spellings differ by exactly one ring position.

**Receipt -- T1/T2**, both directions, two functions. On
`overlay20UpdateObjectResource` the original and the direct-read variant each
allocated four temps for an owner load where the target allocates three; typing
the table as 8-byte pairs and indexing the pair removed the extra allocation
and, composed with [L76](#l76-a-struct-field-read-through-a-local-costs-one-ring-pop-a-direct-read-does-not),
took the function to exact. In the other direction, on
`func_overlay_070_F00000D8` a pop *lost* to an unrelated lever was recovered by
typing the pair table so the index scales twice -- **visible instructions
unchanged** -- and the function went to exact at 165/171 → 0.

**Falsifies.** The reading of a same-length register permutation as
necessarily schedule-owned. Both functions above presented as same-length
`t`-register substitutions, which the current verdict vocabulary routes to the
scheduler; both were ring population, and the free-list trace is what
distinguished them.

**Scope.** Measured on integer table indexing where the element size is a power
of two. The count is one pop per extra scale; nothing here says a third scale
costs a third pop.

**Provenance:** the reference campaign decomp (2026-09-03),
`overlay20UpdateObjectResource` and `func_overlay_070_F00000D8`.

### L78. A pool-carried accumulate keeps a field in its web; the fused form spends a temp

Splitting `x = a + b * c` into `x = a;` then `x += b * c;` keeps `a` in the
coloured web it already occupies, where the fused form loads it into a ring
temp. The two forms therefore differ by one ring pop **and** by one web, and
the difference shows in the pool lane's *length*, not only in its content --
which is the readout that separates this from an ordinary rotation.

**Receipt -- T2**, one function, with a clean negative control. On
`func_overlay_070_F00000D8` the split made both the pool and the fp lanes
exact. On its own it scored 44 differing words, because it also removes one ring
pop and rotates everything downstream; composed with
[L77](#l77-an-index-scaled-twice-costs-one-more-ring-pop-than-an-index-scaled-once)
it was exact. **The control:** writing the same split as a single
comma-joined physical line compiled **byte-identically**, which rules out the
as1 line key ([L59](#l59-the-schedulers-tie-break-reads-physical-source-line-numbers))
as the mechanism and leaves the web population as the only difference between
the forms.

**Falsifies.** "A statement split is a scheduling lever." Sometimes it is
([L59](#l59-the-schedulers-tie-break-reads-physical-source-line-numbers)); here
the byte-identical comma form proves it is not, and the same control run on any
split separates the two mechanisms in one build.

**Provenance:** the reference campaign decomp (2026-09-03),
`func_overlay_070_F00000D8`.

---

## Measurement laws

### L18. Positional words are the true metric

Rank candidates on **positional word differences after masking
linker-controlled fields**. Row-based census metrics inflate in repetitive
regions: a change measured as +5 to +8 rows was +1 positional word, every time.

**Receipt -- T1-adjacent**, from an instrumented diff of a swap family where
every swap was exactly +1 positional.

**Falsifies.** More than one "compiler finding" on this page's history that
turned out to be a metric artifact rather than compiler behaviour -- most
notably a claimed global schedule reordering that was the aligner destabilizing
over eight near-identical statements. One stage built a 257-build lever table
ordered by the wrong metric.

`decomp-workbench score TARGET.o CANDIDATE.o` prints this number as its
headline and says when the others disagree.

### L19. Partial closure is not monotone

Closing part of a set of class-crossing sites can make the score *worse* on
the way to making it much better. Score on the site count, not on words, until
the set is fully closed; confirm on words only at full closure.

**Receipt -- T2.** A recorded run went 1416 → 1413 → 1445 → 1477 → **572** as
sites closed one at a time. Each intermediate regression was a real object,
not a measurement artifact: closing one crossing re-phases everything
downstream of it, and the phase only settles when its partner closes too.

**Falsifies.** The tacit assumption behind every greedy sweep -- that a lever
which raises the score is a lever to discard. Under this law a rising score is
evidence about the *set*, not about the lever.

### L24. Instruction count under composition is not additive

Composing two constructs whose individually-measured `ni` deltas are `+a` and
`-a` does not reliably produce `ni + 0`. Screening candidate compositions by
their summed instruction-count delta, instead of building each one, is invalid.

**Receipt -- T2, exhaustive within one window.** Sixteen zero-sum ±`ni`
compositions were built (pairs and triples measured individually at `+1`/`-1`,
`+3`/`-3`, `+11`/`-8`/`-3`, and others) across one nine-site window. None
landed on the target instruction count; the results scattered across five
other values instead, including one three-way composition that summed to zero
individually-measured delta and still missed by eight.

**Scope.** One window, one procedure. Stated as a warning against a specific
screening shortcut, not a claim about why composition fails -- the individual
mechanisms (frame shifts, whole-procedure renumbering, CSE across sites) are
each independently documented elsewhere on this page; this law is that their
*sum* is not the composition's effect.

### L25. A delta-saturated site scores identically under further generators

Once a source line's available *permutation deltas* have all been produced by
some generator at that site, additional generators at the same site -- even
structurally different ones -- reproduce a delta already seen, and several
reproduce the identical object byte-for-byte.

**Receipt -- T2, hash-exact.** Of 38 companion solutions found for one target
delta, 30 land on two adjacent source lines and **all 30 score identically**;
six of the 30 are byte-identical objects, not merely equal-scoring ones. An
earlier stage's table of per-generator scores at those same two lines was
measured against a single plain generator and does not transfer to the
saturated set -- every later generator there was always going to match it.

**Falsifies.** The implicit assumption that a table of per-site scores,
measured once, stays valid as new generators are tried at that site. Once a
site is known saturated, further search there answers "which spelling",
never "what score" -- the score question is already closed.

**Scope.** Sites where multiple generators have already been found; a lever
found once. Whether a NEW site is saturated is not knowable in advance --
this law explains why several already-saturated sites stopped producing
information, not which untried site will turn out to be one.

### L46. Ring-quotiented scores are not positional scores

A band-vector score expressed relative to the ring's own rotation group (a
"free" count reported after quotienting out a global ring-coset shift) can
look like a large improvement while the actual positional-word score -- the
one that matters, per [L18](#l18-positional-words-are-the-true-metric) --
is far worse, because the whole object carries a hidden global coset shift
the ring-relative number cancels out. One recorded case reported as "worth
10" (an apparent close approach) was, measured positionally, **1045** words
off. A `free`/band number is only safely comparable to a baseline when the
object's ring-phase coordinates are independently confirmed identity; it is
never safe to read on its own.

**Receipt -- T2, hash-exact.** The specific object behind the "worth 10"
claim, re-scored: bands **29**, `posdiff_nonreloc` **1045**.

**Falsifies.** The headline result of the stage that produced the "worth 10"
figure -- not because the object was mis-built, but because the scorer used
to report it collapsed a ring-coset rotation into a number that reads like
positional progress and is not one.

**Provenance:** stage `redb`, originally L61; falsifies stage `red`,
originally L58/L59.

### L47. A lever's price is a property of the base -- re-measure the whole set

An edit's cost is not an intrinsic property of the edit; it is a property of
the edit **against the object it is applied to**. The identical three-line
change was measured at +1015 positional rows against one base and, after an
unrelated fix changed that base's ring phase, was **free and −4** against
the next. More generally, a whole accumulated set of previously-adopted
levers can silently go from load-bearing to pure loss the moment the base
changes under it: one measured case found that four levers a prior stage had
each individually justified were, on the next base, jointly worth exactly
zero -- their combined effect had already been supplied by an unrelated fix,
and all four were costing rows for no remaining benefit. The only way to see
this is a **removal experiment**: drop each inherited lever (and the full
power set of small combinations) and re-measure from zero, rather than
carrying a prior stage's pricing forward as fact.

**Receipt -- T2.** The re-priced 3-line edit (comparison table across three
bases); the four-lever null-hypothesis sweep (128-point lattice, 128 builds,
the all-plain point uniquely minimal by 10 rows).

**Falsifies.** Every inherited "this costs N rows" figure a stage did not
personally re-derive on its own base. Neither instance was a measurement
error at the time it was taken -- both were correct on the base they were
measured against -- which is exactly what makes this trap easy to fall into
twice.

**Provenance:** stage `eye`, originally L67; independently rediscovered and
sharpened into the removal-experiment practice by stage `b4u`, originally
L74.

### L48. Zero-footprint statements can be load-bearing

Source can contain a statement that changes the compiler's allocation
decisions (see [L37](#l37-the-discarded-expression-lever)) while emitting no
instruction at all. A reconstruction built only from the disassembly --
however careful -- cannot see such a statement, because there is nothing in
the object to reconstruct it from: eleven prior stages of one campaign,
working from disassembly and allocator mechanism alone, did not find it. It
was found by an oracle outside the disassembly entirely: a sibling game's
**independently matched** decompilation of the evolved version of the same
routine carried the identical discarded-expression idiom, in the identical
place, three times in fifteen lines. **When a function is byte-exact under a
forced allocator decision but not under the stock compiler, look for a
zero-footprint statement before looking for a mis-spelled one** -- a forced
match that reproduces the target proves the allocation is reachable in
principle; the gap to a natural, unforced match is then a *missing*
construct, not a *wrong* one.

**Receipt -- T1.** The closing match of a full campaign: a discarded-read
statement, zero instructions, that closed the campaign's residual to a
byte-exact ROM rebuild.

**Provenance:** stage `omega`, originally L93.

### L60. Every allocation verdict is relative to the current web population

An allocator verdict is a statement about a **population**, not about a web.
Every declined force, every saturated sweep, every "this construct costs N" is
conditioned on which other webs exist at the moment the decision is taken -- so
each of them must be **re-measured after every champion change**, not carried
forward. [L47](#l47-a-levers-price-is-a-property-of-the-base--re-measure-the-whole-set)
says this about a lever's price; this law is the same fact about *verdicts*,
where it bites harder, because a verdict reads as a closed question and a price
reads as a number that might drift.

The practical corollary is a discipline: **a model that forbids the observed
target is a model missing a term.** The target object exists. When the cost
model says it cannot, the defect is in the model, and the next move is to find
the missing term rather than to record an impossibility.

**Receipt -- T2, nine instances in one campaign.** Nine impossibility
certificates -- each stated with its arithmetic, each correct against the
population it was measured on -- fell to a later stage that supplied a term the
model lacked: a saturating size term ([L56](#l56-the-callee-save-toll-is-a-saturating-size-term)),
an eligibility gate ([L55](#l55-the-eligibility-gate-save--0-is-struck-before-colouring-begins)),
a hard-register conflict vector ([L58](#l58-forbidden0-is-seeded-from-hard-register-conflicts--argument-pins-steer-colours)),
a spendable array interior ([L54](#l54-an-arrays-unaddressed-interior-is-spendable-frame)),
a value-numbered temp pool ([L49](#l49-one-general-expression-temp-per-function-value-numbered)),
and a spelling ([L51](#l51-cfes-own--as-a-value-expansion-is-a-spelling-you-can-write)).
Several were stated as floors ("the basin bottoms at 72") and a later force
oracle on the same base returned 65.

**Falsifies.** The habit that produces impossibility certificates at all:
reasoning to a floor from a model, in a campaign whose whole activity is
discovering that the model is incomplete. Every stage that wrote one had
measured correctly; what none of them could measure was the term they did not
know about.

**Provenance:** `mp_watch_menu_display` (2026-08), whole campaign --
~2900 builds, ~37 delegated stages, nine falsified certificates, seven decoded
allocator/scheduler channels, from a scratch score of 6859 to
instruction-exact.

### L68. The jump table's bytes are the case mapping

A compiler-owned switch table is **evidence about the source**, not just
bytes to reproduce. Its entry order names which case value reaches which
body, so a candidate whose `.text` already matches can still have the case
mapping backwards -- the table decides the mapping, and a wrong mapping that
happens to emit the same instructions is a semantic error the word count
cannot see.

> Therefore read the table before believing a body: the mapping it states
> outranks any donor's, and matching `.text` is not evidence that the
> mapping is right.

**Receipt -- T2.** On `func_80038750` the TU's own five-entry language table
gave the mapping `assetIndex = language + 1` in **descending** case order.
The body in place at the time was an adapted donor that reversed it -- and
matched `.text` anyway, by coincidence, because the reversal happened to
emit the same words. Taking ownership of the table (moving the `.rodata`
carve, trimming the section) corrected the mapping and kept the object
exact.

**Falsifies.** "The words match, so the source is right." They matched, and
it was not.

**Provenance:** the reference campaign decomp (2026-08), resident menu
cohort, `func_80038750`.

### L69. A permuter that finds nothing instantly is a setup fault, not a hard function

A randomized search that reports no improvement within seconds is reporting
on **its scratch**, not on the function. The failure modes are all
configuration: the importer's default ISA is not the project's, a per-file
flag was dropped, the scratch skips a post-compile transform the real object
gets, or the base does not compile at all. Every one of them produces the
same symptom -- an instant flat search -- and every one of them reads as "this
function is hard".

**Receipt -- T2, eight of twelve targets in one sweep.** decomp-permuter's
importer inferred `-mips1` where the project builds `-mips2`, and the
flag-recovery step ran the build's dry run against an **already-built**
object, which prints nothing -- so the correction silently did not happen and
the scratch stayed on the wrong ISA. Eight of twelve targets "found nothing
instantly" and were filed as hard. With the source touched first so the dry
run prints, and the real per-file flags installed, those functions are
ordinary search targets: two of them matched outright, one from its
pre-match source in 75 seconds.

Two further faults found while repairing it, both worth a preflight: the
build echoes its recipe with a backslash continuation, so the flags sit on a
line that does not name the compiler; and the static "flag group" tables a
host tends to keep were wrong for a translation unit that looked default
(it carried `-Wab,-r4300_mul`). **Only the build's own dry run is
authoritative.**

**Falsifies.** A whole column of "unwinnable" verdicts. The workbench's
answer is `permute-doctor`, which asserts the scratch's flags against the
project's real ones and refuses a base whose score is not finite and
positive; run it before reading any flat search as a fact about the
function.

**Provenance:** the reference campaign decomp (2026-08), permuter campaign,
Epoch 13–14 sweeps.

### L70. An isolated `cc -c` does not schedule like the project path

Compiling one function on its own does not reproduce the schedule the
project build produces for it, even with the same flags. Instruction count
and protective-nop placement both move. A residual measured on an isolated
compile is therefore a residual of the harness, and a lever proven there has
not been proven.

**Receipt -- T2, a direct disagreement.** The same source compiled two ways --
isolated `cc -c`, versus the project path (its assembly post-processor plus
`mips64-elf-as`, the path its verification uses) -- produced **56 versus 58
instructions** with different nop placement on `func_8001A154`. Nine source
variants were then swept on the authoritative path; the two objects the
isolated path had suggested were not among the outcomes at all.

**Scope, and what it does not excuse.** The nops in question are
*ugen-scheduled and source-dependent*, not an assembler artifact -- both
assemblers omit them -- and the schedule that carries them **is** reachable
from C on the project path, proven by a fully C-matched resident function
that computes the same shape and whose verified object carries it. "The
harness disagrees" is a reason to move the measurement, never a reason to
record a toolchain wall.

**Provenance:** the reference campaign decomp (2026-08), `func_8001A154`
authoritative-path variant sweep; reachability confirmed on `func_80024D00`.

### L71. The linked image is the only oracle for unrelocated-module code

A module that ships **unrelocated** carries its own relocation table and is
patched by the game's runtime linker after it loads. What the image stores
at each site is the record's stored addend, not an address, so the target's
calls name placeholders no compiled object can reproduce. Every
object-level oracle -- the permuter's score, `words`, a relocation-aware
comparison -- therefore has a floor above zero on such a function, and the
floor is a property of the oracle, not of the C. The linked image is the
only sound oracle, and it is a sound one: if the built image equals the
target over the function's bytes, the function is right whatever any score
says.

**Receipt -- T1, 279 candidates and a 1773/1773 replay.** In the reference campaign
every overlay function's promotion needed a hand-derived
linker value per referenced placeholder, and the permuter could never score
zero on any of them. Two measurements settle both halves. First, the values
are not judgement calls: each is a pure function of the stored addends at
the sites the module's own table names, and replaying the procedure over
every overlay object that project's link consumes reproduced **1773 of 1773**
hand-written values with zero refusals, plus 979 of 982 untracked values
agreeing with the linked ELF's own symbols (the three exceptions are lone
`R_MIPS_LO16` sites, which observe only the low half -- the emitted word is
identical either way). Second, with those values generated rather than
hand-written, the measurable candidate pool went from **110 of 279 to 150 of
279**, and every newly-linking candidate produced **zero out-of-range
differing bytes**: an in-range word count where there had been a link error.

**Falsifies.** "This function is hard" for a whole class of functions whose
only problem was that nothing was scoring them. It also falsifies the
inverse mistake -- reading a nonzero permuter score on such a function as
residual codegen -- since the same candidate can be image-exact.

**Scope.** The law is about the *oracle*, not about difficulty: a
`text-differs N words` verdict from the image is an ordinary residual and
every other law on this page still applies to it. The addend is only
readable where the candidate's schedule already agrees at the placeholder's
own sites; where two sites disagree the synthesis refuses rather than
inventing a value, which is a stated precondition and not a wall.

**The workbench's answer** is `decomp-workbench reloc-surface` (the values,
generated, audited against whatever block a project already hand-wrote) and
`decomp-workbench linked-compare` (the image, classified per function range
as exact / text-exact / text-differs N words / size-differs), with
`permute-doctor --target-object` routing between them. See
`docs/linked-oracle.md`.

**Provenance:** the reference campaign decomp (2026-08), overlay promotion
campaign, `lane/reloc-synth` and `lane/reloc-synth2`.

---

## Instruments these laws were read with

Not laws -- the handles. Each was gated (§ the identity gate) before anything was
concluded from it.

* **`cc -Wa,-R`** -- as1's own scheduler trace: per-block DAGs with
  `before`/`aftercycles`/`maxhazard`/successor latencies and one record per
  selection. Byte-inert, no patched binary, no profile to pin
  ([L59](#l59-the-schedulers-tie-break-reads-physical-source-line-numbers)).
* **`uopt -Wo,-zdbug:2`** -- stock uopt writes `./uoptlist`: flow graph, unroll
  trace, and the full itable in `printitab` form. No instrumented compiler
  needed.
* **`CDX_SYMTAB`** -- the itable dump on the instrumented uopt. Frame home is
  `raw10 + framesize` (two's complement), which is what turns a record into a
  stack offset you can diff against a home census.
* **The itable is value-numbered**, a hash table of expressions in
  first-occurrence order: a repeated expression reuses its index and bumps its
  version, so an index is stamped at the *first* appearance of that expression
  -- the property that makes a temp's birth site identifiable, and the property
  that makes [L49](#l49-one-general-expression-temp-per-function-value-numbered)
  true.
* **The ucode carries no names.** `cfe -j` output holds the file name, the
  procedure name and string literals; every local, parameter and temp is a bare
  (class, offset) pair. There is no name to read for a temp short of `-g`, which
  changes codegen.

---

## Claims a reader will find in older notes and should not believe

| Claim | Status | What killed it |
|---|---|---|
| The divergence unit is within-statement request order | superseded by [L1](#l1-free-order-is-cfes-operand-order) | request orders measured identical |
| ROM claim order is condition *use* order | corrected by [L2](#l2-claim-order-is-source-condition-order-test-order-is-canonicalized) | a pure condition swap moved claims and zero tests |
| An occurrence is a source reference | superseded by [L6](#l6-a-save-occurrence-is-a-basic-block-not-a-source-reference) | occurrence records read from the pass |
| The save divisor is the raw occurrence count | corrected by [L7](#l7-the-save-formula-exactly) | instrumented decision records |
| The fp ring is six wide | corrected by [L13](#l13-the-fp-ring-is-four-wide-f4-f6-f8-f10) | 1460/1460 allocations from four registers |
| A 15-row constant family is a second uopt temp population | corrected by [L4](#l4-cfe-owns-the-frame-layout) | the homes are already in the cfe intermediate |
| ugen has a second, uninstrumented fp allocation path | closed | the traffic is uopt-assigned colour, not allocation |
| ugen binds uopt temp ids to physical fp registers via whole-procedure state | retired | every promotion decision identical under the perturbation; the collateral was uopt's |
| A 13-row family is one named variable's webs | corrected twice | first to six CSE webs, then to **one** web |
| Split-def grafts cannot flip founding only when a compound redefinition follows | generalized by [L10](#l10-dead-def-grafts-die-before-web-founding) | two different graft shapes compile byte-identically |
| Three or more simultaneous swaps trip a global schedule reorder | never existed | the trip was the aligner; positional damage is exactly +1 word per swap |
| No single fp-ring perturbation improves on the base | was a **sampled** claim presented as an enumeration | one eighth of the space had been swept; the conclusion held on re-run, but the original statement was not entitled to be a proof |
| A named heavy float literal is the headline lever | refuted with an instruction count | the proposed spelling deletes three instructions the target contains |
| Row *N* is the gate for all float rows | retired | it is worth one commutative row |
| Extending a live range across a boundary is sufficient to explain a mint | refined by [L22](#l22-a-mint-also-requires-an-address-exposed-frame-slot) | a 186-position sweep showed the mint follows the frame slot, not the live range |
| A repeated dead-store carrier at one site is CSE'd, so a second one cannot mint independently | falsified by [L22](#l22-a-mint-also-requires-an-address-exposed-frame-slot) | two independent carriers composed to different objects with the same delta and the same instruction count |
| The FP colour map is `c24=$f8 c25=$f10 …`, and a web lands on c26 by first occupying c24/c25 | corrected by [L27](#l27-the-fp-colour-map-corrected) | four independent forced-colour receipts; the actual barrier is `f_cupcosts`' call-boundary charge, not colour occupancy |
| A named web pair is blocked from recolouring because any blocker of the smaller is by construction a blocker of the larger (strict block containment) | corrected by [L31](#l31-p1s-colour-order-tie-break-ascending-web-number) and falsified by [L32](#l32-web-fusion-by-rename-breaks-block-containment) | the tie-break is `>=`, not `>`, and web fusion by rename changes the block set the containment claim was stated against |
| A source line's construct delta belongs to the site, independent of which local carries it | falsified by [L44](#l44-a-constructs-delta-class-depends-on-the-carrier-not-only-the-site) | only the two earliest-declared carriers at the site minted the cheap delta class; every other same-typed carrier minted a more expensive one |
| A ring-phase window is byte-exact iff one whole-function phase coordinate takes a fixed value | falsified by [L41](#l41-the-temp-ring-phase-is-a-seven-slot-vector-not-four-coordinates) | true only on the base it was measured on; the real state has more independent coordinates than the claim could see |
| A donor-fusion kill works because the donor's definition precedes a loop with a use inside it | corrected by [L36](#l36-chargeb-exactly-a-store-placement-term) | direct instrumentation of `chargeB` shows the gate is store-placement, not loop membership; the loop supplied only the weight multiplier |
| A re-deal is "worth 10 rows" (a band-relative improvement) | falsified by [L46](#l46-ring-quotiented-scores-are-not-positional-scores) | the same object scored positional 1045 once the ring-coset shift was accounted for |
| The callee-save toll is a constant -- a save/restore instruction price | corrected by [L56](#l56-the-callee-save-toll-is-a-saturating-size-term) | it is `clamp(nBB/4, 4, 60)`, a size term that saturates; every large procedure sees 60 |
| A declined web is re-offered once another web opens the callee bank | retired by [L56](#l56-the-callee-save-toll-is-a-saturating-size-term) | 249 `p1dec` records, zero `p2dec`; a declined web splits and its fragments are new webs |
| A plain local is memory-resident because its web loses the cost contest | corrected by [L55](#l55-the-eligibility-gate-save--0-is-struck-before-colouring-begins) | `save <= 0` strikes it before the contest; it emits no candidate record at all |
| A copy relation can hand a web a forbidden colour (an `available0` bypass) | corrected by [L57](#l57-the-copy-relation-channel-available0-is-an-argmin-not-a-complement) | `available0` is the argmin of `f_cupcosts` over the **non-forbidden** colours |
| The declaration list states the local supply; *N* locals is the ceiling at this frame size | falsified twice by [L54](#l54-an-arrays-unaddressed-interior-is-spendable-frame) | an array whose base alone is addressed carries spendable bytes in its tail |
| `a && b` as a value is expensive in every respelling | falsified by [L51](#l51-cfes-own--as-a-value-expansion-is-a-spelling-you-can-write) | cfe's own expansion, written out, is byte-identical at every site; the other spellings cost 264–860 rows |
| There is always a materialised call result, so the cfe temp pool cannot be emptied | falsified by [L49](#l49-one-general-expression-temp-per-function-value-numbered) | the pool is one value-numbered symbol that re-mints; the sites are enumerable and were all removed |
| A float scale can be scheduled into the invariant-load group by moving its declaration | corrected by [L62](#l62-a-float-scalars-load-form-is-decided-by-its-value-and-the-form-decides-the-schedule) | the group membership is the load *form*, decided by the constant's low halfword; the reorder produced a byte-identical object |
| Comparison operand order is a spelling worth permuting | corrected by [L67](#l67-a-comparison-prints-its-copy-propagated-variable-first) | the propagated variable prints first whatever the C says; every permutation produced the same object |
| A loop-invariant base re-assigned inside the loop is redundant code to hoist | corrected by [L66](#l66-a-web-feeding-a-call-argument-inherits-that-arguments-register-at-cost-0) | hoisting it loses the argument-register affinity that colours it for free |
| The integer temp ring is seeded in register-number order from `t0` | corrected by [L64](#l64-the-integer-temp-ring-is-seeded-t6-t7-t8-t9-t0--t5) | instrumented free-list return records read `t6 t7 t8 t9 t0..t5` |
| A construct that emits no instruction cannot move an allocation | corrected by [L65](#l65-a-redundant-mask-still-costs-one-ring-pop--the-phantom-pop) | a folded mask emits nothing and still pops the ring once |
| Matching `.text` means the case mapping is right | falsified by [L68](#l68-the-jump-tables-bytes-are-the-case-mapping) | a reversed mapping matched the words by coincidence; the table said otherwise |
| A permuter that finds nothing in seconds has found a hard function | falsified by [L69](#l69-a-permuter-that-finds-nothing-instantly-is-a-setup-fault-not-a-hard-function) | eight of twelve such verdicts were one wrong ISA flag in the scratch |
| A lever proven on an isolated `cc -c` is proven | falsified by [L70](#l70-an-isolated-cc--c-does-not-schedule-like-the-project-path) | the same source compiled 56 instructions isolated and 58 on the project path |
| Eight scheduler-tie rows are basin-invariant | corrected by [L59](#l59-the-schedulers-tie-break-reads-physical-source-line-numbers) | they were line-number-invariant; all eight fell to a whitespace-only edit |
| A candidate that cannot score zero against its target object has residual codegen | falsified by [L71](#l71-the-linked-image-is-the-only-oracle-for-unrelocated-module-code) | the module ships unrelocated, so the score has a floor no source change closes; the same candidates were image-exact |

---

## Using this page

```sh
decomp-workbench guide laws ido53
```

The field guide answers "what do I change". This page answers "what will the
compiler do about it". When they disagree, the guide is the one that gets
edited: a lever is a hypothesis about mechanism, and mechanism is measured
here.

### L87. The carrier-colour law: schedule and pool colour are one decision

**Receipt -- T2, three measurements on one translation unit.** Measured on
`src/overlays/o001/overlay_001_tail.c` in the reference campaign from build
outcomes: the colouring order was read off compiled objects and the spelling
table below is a set of byte comparisons against the same base. The pass
records were not read, so the *mechanism* is inferred rather than logged; what
is directly measured is that reordering statements never separates the two
effects, and that the `^ 0` at the use separates them every time.

uopt colours pool webs in the order of each web's **first surviving
definition, in source statement order**, and ugen emits them in that same
order. So the schedule and the colouring are not two knobs -- they are one, and
**reordering statements to fix a colour always moves the schedule with it.**
A residual that is "right schedule, wrong colours" cannot be closed by any
permutation of the statements that produce those values.

What decides whether a value gets a pool colour at all:

| Spelling | Effect |
|---|---|
| a named local | takes a **pool colour**, numbered in statement order |
| the same value spelled as the field or global access again | becomes a **CSE temp**, numbered after *every* named local -- see [L76](#l76-a-struct-field-read-through-a-local-costs-one-ring-pop-a-direct-read-does-not) |
| declaration order, and `register` | **inert**, reconfirming [L63](#l63-declaration-order-places-a-call-crossing-spill--reconfirmed-and-usable-as-a-lever) outside the stack-home case |
| a genuinely dead store | reserves **no** colour -- uopt kills it before web numbering |
| `value = 0`, likewise never read | **does** reserve one |

That last pair is the sharp edge: two stores that a reader would both call dead
differ by whether uopt eliminates them *before* web numbering runs.

**The lock breaks at the use, not at the definition.** An inert operation
written where the value is *consumed* keeps the schedule exactly and still
moves the colouring:

```c
/* schedule exact, two colours exchanged */
if (record->group == group) { ... }

/* same schedule, both colours restored */
if (record->group == (group ^ 0)) { ... }
```

Operand order matters here, and [L67](#l67-a-comparison-prints-its-copy-propagated-variable-first) says why:
`(group ^ 0) == record->group` costs one further word.

**The `^ 0` is not free, and on one function it *was* the plateau.** It splits
the `%hi`/`%lo` pair of the value it is applied to across two registers. On
The reference campaign's `overlay1FindBestRecord` that split was the entire reported two-word
residual: the trick restored both pool colours and introduced exactly one new
defect in doing so. A split pair is a readable signal rather than noise -- in
that unit's already-matched code, 45 of 51 `lui`+load pairs use the same
register and all six exceptions are `$at` float loads.

The function matched on a **third degree of freedom** instead: *physical line
grouping*. Statement order fixes the colour (this law); line grouping moves the
schedule without moving the colour. Writing `remaining = 31; group = D_1D88;`
on one physical line gives both -- `remaining` first so it takes the colour, and
joined so ugen emits the group load ahead of the countdown. Splitting the line
costs the instruction swap; reversing the statements costs the colours. So when
the colour and the schedule both need to move, reach for the line before
reaching for an inert operation.

A related per-variable rule fell out of the same unit: **a pool colour belongs
to the variable, not the assignment.** Storing into a local that is already dead
reuses its colour and spends no new one, which is how a second function there
closed.

### L88. A colour residual with an identical ring order is a site, not a phase

**Receipt -- T2, with a byte-identity corroboration.** The ring-order comparison
and the two half-edits are build-outcome measurements on the reference campaign's
`func_8001D960`. The composition claim is stronger than T2 on its own: the
composed edit produced a byte-identical ROM rebuild, so the pair is confirmed
by identity even though the ring mechanism behind it was inferred.

When both objects pop the temp ring in the *same* order -- for the integer ring,
[L64](#l64-the-integer-temp-ring-is-seeded-t6-t7-t8-t9-t0--t5)'s seed -- and
differ only in which source site draws which ordinal, the residual is **not** a
ring phase and chasing the phase is wasted effort.

Find instead the one site where one side spends a **ugen ring temp** and the
other a **uopt pool colour**. Naming a value adds the colour; inlining it
removes it; and which direction is correct is per function, readable from the
target. On `func_8001D960` the site was a call result the candidate had named
and the target drew from the ring -- and the neighbouring case in the same
`switch` already spelled the identical expression inline, so the asymmetry was
visible in the source before any measurement.

**The edits compose, and neither half is a signal.** Inlining that value alone
was a *regression* (103 differing words, one instruction too many). Inlining it
**and** sinking an unrelated `|=` below the whole product was exact. No search
over single edits finds that, and a single-edit accept rule rejects both halves.

### L89. `x * 1.0f` on an `f32` is not the FP phantom pop

**Receipt -- T3, one observation, not swept.** Seen once on the reference campaign's
`src/main/charControl.c` while looking for an FP analogue of L65. Treat as a
lead: it says the obvious spelling buys nothing on that function, not that no
FP identity anywhere can move a web.

Negative result, worth recording because the analogy is tempting.
[L65](#l65-a-redundant-mask-still-costs-one-ring-pop--the-phantom-pop) says a
redundant integer mask still costs a ring pop, which makes it a lever. The
floating-point equivalent does not exist: under IDO 5.3 at `-O2`, `x * 1.0f`
on an `f32` folds to **no instruction at all** and is allocation-inert. It buys
nothing and cannot be used to move an FP web.
