# Compiler laws: IDO 7.1

What this compiler *does*, as opposed to what to do about it. The
[field guide](../field-guide.md) is levers -- source edits and the residual each
one moves. This page is mechanism: the rules the passes actually follow, each
with the evidence that established it and the earlier claim it corrected.

The [IDO 5.3 page](ido-5.3.md) is the sibling document. Nothing here was
measured on 5.3 and nothing there was measured on 7.1; where the two releases
were run on *identical* input they disagreed, which is the whole reason the era
token is part of the address
([L17](#l17-ugen-and-as1-determine-the-basin-cfe-and-uopt-versions-do-not)).

Read this page for the passes it names, but read it also as a record of how a
one-word residual survived four thousand source spellings. Nine of the laws
below were reached only after the residual was reproduced *at a phase
boundary* -- in the Ucode or Binasm stream -- and then hunted back into C. That
order of work is the transferable part.

## Scope

Everything here is **IDO 7.1** (`cc` → `cfe` → `uopt` → `ugen` → `as1`) at
`-O2 -mips2 -G 0`, as invoked by decomp.me's `ido7.1` preset and by the
project Makefile the measurements came from (which adds `-Wab,-r4300_mul`; the captured `as1`
command line is otherwise the ordinary `-G 0 -p0 -mips2 -EB -g0 -O2`). No law
on this page has been tested on another IDO release except where a law is
explicitly a *comparison* between releases.

The measurements come predominantly from one procedure in an IDO 7.1 project,
`func_ovl0_800CEF4C`, 1,868 instructions, a −168
frame, and a two-cluster jump-table dispatch over a bytecode opcode -- taken
from a 99.9948% / one-word frontier to **words=0, exact=true** over two
sessions and roughly 8,000 compiled-and-scored variants. So "always" below
means "in every case observed in that procedure and its probe grids", never
"provably, in all programs". Two laws (L5, L17) were additionally exercised on
patched Ucode streams, which is a broader base than one source.

Laws L1–L19 come from that campaign (2026-08-23/24).

## Evidence tiers

| Tier | Meaning |
|---|---|
| **T1** | Measured against the pass itself: the original `as1`/`ugen`/`uopt` binary was statically translated and read, or the published `uopt` source was read, or a gated instrumented compiler logged live records. |
| **T2** | Inferred from build outcomes: probe ladders, score deltas, basin collapses, phase-stream captures compared byte-for-byte. The deciding code was not read. |
| **T3** | Single observation, not swept. Treat as a lead. |

**The identity gate.** A T1 claim from an instrumented compiler is only T1 if
that compiler was gated: built with the instrumentation *disabled*, its object
must be byte-identical to the stock compiler's. The `uopt` A71-v2 instrument
cited under L10–L12 passed that gate. The `as1` and `ugen` claims under L1–L6
did not need it: they were read out of a static translation of the **original
stripped SGI ELF**, and every behavioural claim drawn from them was then
re-measured by running the *stock* phase on a patched stream.

**Phase captures are the cheap rung nobody uses.** Six of these laws were
settled by capturing one pass's input and output with an arg-preserving wrapper
and re-running the stock pass on a byte-patched copy. That is far cheaper than
an instrumented build and strictly more decisive than a source sweep, because
it attributes a residual to an owning pass instead of to a spelling.

**No impossibility claims.** Every closed lever below is recorded as *scoped* --
with the space actually covered -- never as impossible. This discipline was
earned: two independently produced "exhausted" verdicts in this campaign were
falsified after the schedule equilibrium moved
([L19](#l19-a-saturation-verdict-is-scoped-to-its-basin)).

**Provisional laws** are marked in their heading and say what evidence is
missing. No clause on this page is provisional: the two that shipped
provisional (L9's owning pass, L11's survival condition) were closed by
directed probes the same day, and their receipts are inline.

**Record names.** Receipts name the campaign's own record files (for example
`AS1_OPTION_CONTROL.md` or a `tu-probe/` grid). Those records belong to the
project the measurements came from and are not distributed with this package;
the names identify which record holds the full data.

---

## as1 (the assembler)

`as1` is where this function's last word lived. Under 7.1 it is not a
transcriber: it runs a two-pass peephole optimizer over basic blocks, carrying
a register-content model across block boundaries, *before* it deletes redundant
instructions.

### L1. `peep_reg` propagates a copy fact, and only a type-3 alias is followed

A `move rd,rs` (`or rd,rs,$zero`) installs a **content fact** on `rd`: type 3,
alias `rs`. Every later source-reading instruction in the same block resolves
its `rs` through `find_def_reg`, which follows the entry **only if its type is
3**, and rewrites the operand in place. There is no register-class test and no
distinction between one source register and another in this path -- the copy is
recognised identically whatever it copies.

**Receipt -- T1.** Static translation of the original SGI 7.1 `as1` ELF.
`peep_reg` at `0x4180dc`–`0x418d33`; source-read dispatch `0x41820c`–`0x41829c`;
`find_def_reg` at `0x416670` (eight-byte GPR entry, alias halfword at `+6`,
type word at `+0`); the destination content action is `(properties >> 16) & 7`,
dispatched at `0x418bf0`–`0x418d18`, and action 5 -- "one nonzero input" -- stores
the alias at `0x418ce8`–`0x418cf4`. `decode`'s property word is `0x02150300`
for `move` and `0x00200200` for `addiu`. The live confirmation is stock `as1`'s
own `-peepdbg` log: `Peepreg (INST 1) changed rs 2 => 3`. Recorded in
`AS1_PEEP_REG_ROW49_MECHANISM.md`.

**Falsifies.** The reading that `repl_reg` -- a separate routine -- owned the
rewrite, and the reading that the donor spelling worked because `as1` treats
`v1` and `a1` differently in `move` handling. Both moves install a fact; the
difference is entirely in L2's filter.

**Scope.** `do_passI_opt` (`0x41c858`) is the only caller; `INST 1` in a
`-peepdbg` line is the first instruction *of a basic block*, not of the
procedure. Reading those numbers as procedure-global inverts every attribution
drawn from the log.

### L2. A content fact reaches the next block only through a single-predecessor fallthrough, and is then filtered by the taken target's live-in mask

`update_ctnt` (`0x416364`) decides, at every basic-block entry, whether the
previous block's facts survive. It preserves them only if **all six** of these
hold: cross-block optimisation is on (`xbb_opt` at `0x10030d98`); the block has
a predecessor record; its **first** predecessor is the immediately previous
sequential block; it has **no second predecessor**; the previous block is
non-empty; and `find_branch_target` returns a taken successor. Any failure
jumps to `0x416538`, calls `init_ctnt`, and the block starts clean.

If all six hold, each surviving alias is filtered against the **taken target's**
GPR live-in word, effectively

```c
if (taken_target->gpr_livein & (0x80000000u >> ctnt[dst].alias))
    clear(ctnt[dst]);
```

so a copy whose *source register* is live on the not-taken path is dropped.
**Branch-target blocks therefore always start clean; only a fallthrough block
with exactly one predecessor inherits anything.** That single sentence is why,
in a pair of jump-table dispatches, one arm heals for free and the other never
does.

**Receipt -- T1.** Gate reads at `0x41637c`–`0x4163cc`; GPR filter loop
`0x4163e4`–`0x41642c` (target word `+36`); FP filter `0x416438`–`0x416528`
(target word `+40`). Offsets `+36`/`+40` are positively identified as the two
`livein` words by `do_passII_opt`'s own debug print, which passes `+36`, `+40`,
`+48`, `+52` to the literal `"livein = %08x,%08x, liveout = %08x,%08x"` at
`0x1000c740`. The measured consequence, on two Binasm streams differing in one
record: `move v0,v1` survives the filter (bit 3 clear in the low target's mask)
and the fallthrough subtract is rewritten to `v1`; `move v0,a1` is cleared (bit
5 set) and the subtract keeps `v0`.
`AS1_PEEP_REG_ROW49_MECHANISM.md`.

**Falsifies.** The campaign's long-running belief that the healing `if
(!command);` donor worked by *allocation* -- it was believed to be an allocator
lever for nine grids and ~1,500 variants. It is a live-in lever: the donor
changed which physical register the copy aliased, and that register happened to
be live on the taken edge. The allocator rotation it dragged along was
collateral, not mechanism.

**Scope, and the useful corollary.** The three mechanically sufficient ways to
keep a fallthrough subtract on its own register are: put the alias source in the
taken target's live-in mask; redefine the alias source between the copy and the
use; or fail one of the six gates. All three are gradeable from the pre-`as1`
Binasm without compiling to an object.

### L3. as1 mutates its content state *before* it deletes redundant code, so a barrier can cost zero instructions

The state changes L1 and L2 describe happen in `do_passI_opt`; the
redundant/def-use deletion runs afterwards at `0x41c0c8` and **does not roll
back** what the peephole already did to the content model. Consequently an
instruction or an edge can exist for exactly as long as it takes to kill a copy
fact and then be deleted from the final code. The instruction count does not
move.

Twelve artificial Binasm insertions at one boundary were measured exact
(1,868 instructions, `words=0`): `.set nomove`/`.set move`, `.set
volatile`/`.set novolatile`, and `.set noreorder`/`.set reorder` spans around
the instruction; a pseudo-`nop`; a physical `move $3,$3` or `or $3,$3,$0`; a
branch to its immediately following local label in four spellings (`b`,
always-true `beq`, register self-`beq`, never-taken `bnez $0`); and -- the
strongest of the family -- a **copy-back** `move v1,v0`, which `peep_reg` first
rewrites to `move v1,v1` (resolving `v0` through the very fact it is about to
destroy), then deletes as a redundant self-copy.

**Receipt -- T1 + T2.** Static translation for the ordering (`0x41c0c8` after
`peep_reg`; dependent-fact scan `0x418a40`–`0x418bc0`; the three `do_passI_opt`
full-reset record paths at `0x41c978`–`0x41ca04`; the `decode`-property barrier
at `0x418148`–`0x41816c`). Bounded stock re-runs for the outcomes:
`AS1_ZERO_FINAL_CODE_TRANSITIONS.md`,
`binasm-copyback-ctnt-results.json`, and the campaign's twelve-barrier matrix.

**Falsifies.** The rule of thumb that a zero-instruction source construct
cannot change codegen. It can, and here it was the *only* thing that could:
every construct that survived to Binasm at that boundary and then vanished
produced the exact object.

**The trap.** A nominal `move v0,v0` is not a barrier -- source operands are
resolved *first*, so it becomes `move v0,v1` and re-creates the bad alias. The
direction of the copy is the whole lever.

**Scope.** These are proofs of phase and target, not acceptable C. An exhaustive
follow-up duplicated **every** distinct non-instruction Binasm directive family
observed in the real function at that boundary -- LOC/file/section/function
metadata, `.option O2`, alias/noalias and call metadata, mode-restoration
records, frame metadata, local labels -- and none blocked the rewrite. The
barrier must be an instruction record or a control edge.

### L4. There is no peephole gate below `-nopeep`

`as1`'s `opt_strings` table (VA `0x10020428`, file offset `0xB0428`) has
exactly 109 entries scanned by `which_opt`. Decoding it and the option jump
table at `0x10011E88` shows one peephole control: index 66, `-nopeep`, which
clears the single one-byte `peep_opt` global at `0x10030E48`. `traverse_bb`
reads that one boolean at `0x0042191C` and, when set, runs **both**
`do_passI_opt` and `do_passII_opt`. No command-line gate exists for `peep_reg`,
`repl_reg`, or any individual transform.

**Receipt -- T1**, with the measured consequences: baseline `w=1`/1,868 insns;
`-noswpipe` `w=1`/1,868 (byte-identical); `-nopeep` `w=1866`/1,904 insns;
`-NR` `w=1846`/1,716. The narrow controls `-nosymregs`, `-newhilo`,
`-no_const_opts`, `-no_lui_opts`, `-no_div_rem_opts` are byte-identical to
baseline; `-nobopt` `w=129`, `-no_at_compression` `w=333`, `-aggr_xbb` `w=443`,
`-no_branch_target` `w=453`, `-noxbb` `w=1330`, `-noglobal` `w=1861`.
`AS1_OPTION_CONTROL.md`.

**Falsifies.** The hope -- pursued across a 25-form source grid -- that a
compiler flag or a `#pragma` could disable the one transform. It also closes
the source route: 7.1 `cfe`'s complete pragma table contains no inline-assembly,
assembler-mode, or per-region optimisation pragma
([L15](#l15-71-cfe-has-no-inline-assembly-or-per-region-optimisation-pragma)).

---

## ugen (the code generator)

### L5. Branch-to-next elimination removes at most **two** conditional branches, and unboundedly many unconditional ones

UGEN deletes a branch whose target is the immediately following label. For
**unconditional** jumps the elimination is unbounded: any number of chained
`Uujp; Ulab` pairs disappear, in any arrangement, with or without `Uloc`,
`Unop`, or unrelated intervening labels. For **conditional** branches it
saturates at two: *N* chained empty-body conditional tests leave
`max(0, N − 2)` surviving branches.

Three is therefore the unique interesting arity. Three chained conditional
tests leave **exactly one** branch-to-next, which survives into Binasm, creates
an `as1` basic-block boundary that fails L2's gate 4, and is then deleted by
`as1` as removable -- at **zero instruction cost**. Two are erased before `as1`
ever sees them. Four is catastrophic.

| barriers inserted | surviving in Binasm | words |
|---|---|---|
| `fjp` ×1, ×2; `ujp` ×N; every single-shape form | 0 | 1 |
| **`fjp` ×3** (either dtype, either sense) | **1** | **0** |
| `fjp` ×4 | 2 | 1822 |

Branch sense, the compared variable, and the branch opcode are all irrelevant --
only the surviving boundary matters. The unique source spelling is
`if (x && x && x);`.

**Receipt -- T2, independently reproduced.** 184 bytes of
`(Ulod; Uldc 0; Uneq; Ufjp L200) ×3; Ulab L200` inserted at byte `0x8d0` of the
captured 48,872-byte Ucode stream (SHA-256 `942e60ba…`), then stock 7.1
`ugen` + `as1`: `words=0 opcodes=0 gaps=0 regs=0 fp=0 insns=1868 frame=-168`.
UGEN's output grows 41,552 → 41,584 bytes; the surviving records are visible at
Binasm `0x980`/`0x990` and the synthesized subtract moves from `0x980` to
`0x9a0`. Reproduced independently from the same base in a separate
checkout: `FJP_BARRIER_PROOF.md`, `fjp-minimality-results.json`,
`FJP_X3_INDEPENDENT_REPRO.md`.

**Falsifies.** Every earlier barrier probe in the campaign -- 25 pragma and
label forms, unconditional `Uujp` separators, trampolines, `Uloc`/`Unop`
padding. All of them were *unconditional* or metadata, and all were erased
before `as1`. The negative result "no source-reachable barrier exists at this
boundary" was correct for one branch class and wrong for the other.

**Scope.** Measured on this function's Ucode at one boundary, plus the
source-level reproduction under L9's composition. The saturation constant (two)
was measured, not read out of `ugen`.

### L6. A jump table's range guard is synthesized by ugen, and its subtract is an atomic child of that guard

The `addu rd,selector,−lower` in front of a dense jump table is **not** emitted
by the `Uxjp` translator. UGEN's tree builder, on seeing `Uxjp`, subtracts the
table's lower bound from the expression stack's accumulated integer displacement
(`L410c58`), materialises it (`func_40e2ac`), then synthesizes a range-check
`Ufjp` over `Ules(normalized_selector, upper − lower + 1)` and appends it
*before* the `Uxjp`. The `Uxjp` handler itself only evaluates or reuses the
selector, shifts left by two, loads the table, optionally applies PIC
adjustment, and jumps.

The consequence for source work is exact: the subtract is node 144 inside the
atomic evaluation tree of synthesized statement 148. **UGEN exposes no label
position between the start of the guard's evaluation and its ADD child.** A
source label can land before the selector records or after the dispatch, and
nowhere in between.

**Receipt -- T1 + T2.** Read from the statically recompiled 7.1 `ugen`
(`f_build_tree` dispatching opcode 140 at `L410a5c`, generic range construction
at `L41107c`, `f_translate` at `L431b48`) against the retained Ucode; the
resulting tree and the Binasm ownership map (`0x950` LOC, `0x960` copy, `0x970`
explicit `blt`, `0x980` synthesized subtract, `0x990` guard branch, `0x9a0`–`0x9c0`
XJP) are tabulated in `UGEN_XJP_LOWERING.md`. Seven Ucode topology
probes -- alternate default targets, trampolines, and barriers with every legal
separator -- produced byte-identical control Binasm (SHA-256 `c3e38fa2…`).

**Falsifies.** The plan to reach the boundary by respelling the *selector*.
UOPT wraps a selector in `binopwithconst(Uadd, expr, 0)` only when its internal
type is `isvar`, and `ustack_add_value()` deliberately does nothing for a zero
displacement -- so `selector + 0` in C cannot manufacture the wrapper, and a
duplicated `((sel + 0) + 0)` tree normalises to byte-identical Binasm. A
50-selector grid (address-taken, pointer, array, bitfield, enum, `volatile`,
comma/assignment forms) confirmed the split: forms erased early enough to
preserve the schedule erase back to the baseline, and forms that keep an
indirect expression through UOPT change the register/frame regime globally
(w128 with frame −176, or w1809–w1846).
`XJP_SELECTOR_SOURCE_REACHABILITY.md`,
`ROW49_NATURAL_IDENTITY_AUDIT.md`.

---

## uopt (the optimizer)

### L7. An empty pure conditional is a ghost edge: no code, but the CFG edge survives

`uopt` creates a conditional jump's predecessor/successor edge the moment it
reads `Ufjp`/`Utjp`. When it subsequently reads the immediately-targeted label
and recognises an empty `if`, it rewrites the branch statement to `Unop` -- but
it **does not remove the graph edge**. `reemit()` emits neither code nor Ucode
for `Unop`. So `if (x);` is an edge that steers block layout and then vanishes
completely.

By contrast `Uloc`, `Unop`, ordinary empty statements and bare labels create no
edge at all, and are therefore inert for layout. (`empty_bb()` does list them,
but it feeds feedback-frequency assignment, not the layout DFS.)

**Receipt -- T1**, read from `n64decomp/ido` at commit `d068e439`:
`uoptinput.c` lines 3382–3399 (edge creation), 3408–3459 (empty-`if`
recognition and `Unop` rewrite), `uoptemit.c` 5315–5316 (`Unop` emits nothing),
`uoptcontrolflow.c` 88–107 (`empty_bb`). Recorded with line-anchored links in
`UOPT_PARTITION_LAYOUT_AUDIT.md`.

**The exception worth knowing.** If `has_volt_ovfw()` is true, the empty
conditional becomes `Upop`, not `Unop`: the evaluation is preserved and the
construct is no longer free. A `volatile` in the condition converts a ghost
edge into real code.

**Falsifies.** "Make the trampoline non-empty" as the layout predicate.
Content is irrelevant except insofar as it changes retained edges or lexical
block numbers ([L8](#l8-block-order-is-a-lexical-successor-first-dfs-num--1-decides)).

### L8. Block order is a lexical-successor-first DFS: `num + 1` decides

`controlflow()` rebuilds the graph's `next` list with `depth_first_order()`,
which (1) appends the current node, (2) finds the successor whose **original
lexical number is exactly `node->num + 1`** and recursively exhausts that
subtree first, then (3) exhausts the remaining successors in successor-list
order. Predecessor count is never consulted.

This is why a partitioned switch relocates its bodies. Reading a `Uclab`, uopt
prepends every table target to the XJP's successor list; but the `num + 1` test
overrides that list order, so the XJP's lexically-next successor -- a case body
or its frontend trampoline -- is exhausted before control returns to the outer
branch's other arm, and the high bodies end up packed behind the high table
instead of after the low bodies. cfe preserves lexical order, so the relocation
is uopt's and not the frontend's.

Two source-level consequences, both measured:

* **Case-anchoring partially defeats it** -- an empty pure conditional
  ([L7](#l7-an-empty-pure-conditional-is-a-ghost-edge-no-code-but-the-cfg-edge-survives))
  on the *first* case trampoline, or a protected `default:` carrying the
  edge to the low dispatch, changes the numbering and moves the bodies. "First"
  and "middle" placements alter layout; "last" is inert, exactly as the
  `num + 1` rule predicts.
* **Duff nesting reproduces the target layout exactly.** An inner switch whose
  entry label sits *inside the outer switch's body*, reached by `goto`, gives
  the DFS the topology the natural single switch cannot: the two dispatch
  clusters and every body land in target order, with the whole 1,868-instruction
  schedule preserved.

**Receipt -- T1 for the predicate** (`uoptcontrolflow.c` 327–352;
`uoptinput.c` 3527–3593 and 3658–3685), **T2 for the outcomes.** The
case-anchoring family: `partition-trampoline-blocker-sources/trblock-001-one-first.c`
at `words=1441`, unchanged true instruction count, text `26a6d274088b`;
`partition-default-low-x1.c`/`-x2.c` at `words=1442 opcodes=1181 gaps=44`, text
`33b66eea8829`, with one *or* two condition references identical and three
crossing a fold threshold into `words=1804`. The Duff-nesting family:
`tu-probe/part8/p8__ge-plain.c` -- goto pair plus nested switch, no other
change -- scores `words=9 opcodes=0 gaps=0 insns=1868 frame=−168`, text
`fd6f35253f3f`, with **every** layout word already correct and the entire
residual being one register (row 49) plus eight stack offsets.
`UOPT_PARTITION_LAYOUT_AUDIT.md`, `PARTITION_BARRIER.md`.

**Falsifies.** Two claims from the partition campaign: that the relocation was
a broad "nontrivial trampoline" test, and that a `Uloc`/`Unop`/bare-label
without an edge could reorder blocks. Also the 1,441–1,792-word plateau's
reading as "body placement is unreachable from C" -- it was reachable, by
nesting rather than by anchoring.

### L9. `if (c) goto L` makes the goto target the fallthrough, and an opposing-arm statement re-biases the choice

Written as `if (c) goto HIGH; goto LOW; HIGH: …`, the compiler makes **HIGH**
the fallthrough and inverts the branch onto the LOW path. That parity -- which
arm is the branch target and which is the fallthrough -- is not fixed by the
comparison's polarity: `>= 209`, `> 208` and `!(x < 209)` produce
byte-identical text, and so does collapsing the pair to the single
`if (x < 209) goto LOW;`.

What *does* move it is control flow at the goto target. Putting a statement --
even a zero-code empty conditional -- immediately after the `HIGH:` label flips
the range branch's sense (`bnez` ↔ `beqz`) and **swaps the two dispatch
clusters**, so the low table's `addiu`/`sltiu` pair and the high table's
exchange places. Putting the *same* statement on the opposing arm as well --
ballast -- restores the target parity and takes the residual back down. The
ballast is idempotent: one, two, and three copies produce byte-identical text.

Because parity decides which dispatch block is the single-predecessor
fallthrough, this law and [L2](#l2-a-content-fact-reaches-the-next-block-only-through-a-single-predecessor-fallthrough-and-is-then-filtered-by-the-taken-targets-live-in-mask)
are the same lever seen from two ends: the copy fact follows the fallthrough.

**Receipt -- T2**, measured with `compare --json` against the campaign target,
every candidate at `insns=1868 gaps=0 frame=−168`:

| shape (`tu-probe/`) | text sha1 | words | opcodes | regs |
|---|---|---:|---:|---:|
| `part8/p8__ge-plain` -- goto pair + Duff nesting, no statement | `fd6f35253f3f` | 9 | 0 | 1 |
| `part8/p8__ge-o3` -- plus `if (x&&x&&x);` on the **high** arm | `60ac03f5e694` | 13 | 1 | 1 |
| `part12/p12__bal1`, `bal2`, `bal3` -- the same statement on **both** arms, ×1/×2/×3 | `339c48483cf5` | 8 | 0 | 0 |

The 13-word basin's five non-stack sites are exactly the parity: row 47
`bnez`→`beqz`, and rows 49/50 ↔ 59/60 exchanging the `−250`/`6` and `−128`/`81`
pairs. The 8-word basin's residual is **only** stack offsets -- row 49's register
is healed. The `60ac03f5e694` basin is reached byte-identically by seven
distinct spellings: all three comparison polarities, the single-goto form
(`part7/p7__goto-o3`), a braced statement (`part10/p10__braced`), the nested
`if (x) if (x) if (x);` (`part10/p10__nested`), and a preceding
`opcode = opcode;` (`part11/p11__selfop`).

**Falsifies.** The braced `if/else` partition as an equivalent of the goto
pair. With a nested inner switch it is not remotely equivalent --
`part7/p7__else-o3` scores `words=1797 opcodes=1656 gaps=26 insns=1864`, four
instructions short and structurally different -- while the goto pair scores 13.

**The owning pass -- proven `uopt`.** A `cc -K` compile of the exact
goto-pair source (`part8/p8__ge-plain.c`) keeps cfe's own output Ucode
(`probe.B`), and it is the naive lexical form: `lod; cvt; ldc 209; geq;
fjp L21` with the true arm's `ujp L22` (the goto to HIGH), then
`L21: ujp L23` (the goto to LOW), then `lab L22` -- both gotos intact, no
inversion, blocks in source order. The uopt-output capture of the same
source (`ido71-ugen-capture/captures/20260824-125523-1862`) shows the
normalised form this law describes: `geq; fjp` straight to the low
dispatch, both `ujp`s eliminated, the high dispatch as the fallthrough.
The rewrite happens between those two streams, and only `uopt` runs there.

### L10. globalcolor is Chow priority colouring, and the priority is `save / units`

7.1 `uopt`'s global register allocator pops webs by
`priority = save / units`, where

```
units = raw < 3 ? raw : ((raw − 2) >> 2) + 2
raw   = refnodes + cardbv-count
```

`cardbv` is the bvect at web+`0x0c`; the live-block bvect is at web+`0x14`.
Pop order is maximum priority first, **ties broken by ascending `sym`**, and
`sym` order is the order of first textual occurrence in the source. A popped
web takes the lowest free colour (for the FP bank, `f0 f2 f12 f14 f16 f18` =
colours 24–29), and its colour is OR'd into the forbidden mask of every
uncoloured neighbour, where interference is **block-granular live-block bvect
overlap**. A web splits when its colours-left reaches zero or it pops
uncolourable; the split head takes a colour valid for its sub-range and the
spill stores land **at the split boundary**.

The quantisation matters more than the formula: `raw` 3–6 → 2 units, 7–10 → 3,
11–14 → 4. Priority is therefore a **step function**, and a dial that adds one
reference can be free or can halve a web's priority depending on where in the
step it lands.

**Receipt -- T1**, gated instrumented `uopt` (A71-v2: interference propagation,
live-block bvects, transit bvects, exact `compute_save` priorities, neighbour
lists), validated against 20+ traces. The target colouring is reproduced as a
consequence, not assumed: the two spill pairs at rows 1696/1698 (`swc1
f16,84(sp)`) and 1751/1753 (`swc1 f12,80(sp)`) follow from one web holding
`f16` at block 243, which is what forces the split there.
`ALLOCATOR_MODEL.md`; instrumentation under
`ido71-instrumented/` (`uopt-trace2.c`, `build/uopt2`).

**Falsifies.** The `opcodes` metric as an allocator fitness function: variants
with a "broken" opcode score can carry exactly the right colouring. Fitness
must be a per-site heal signature over the discriminating rows, not a scalar.

**Scope.** No phase-2 recolouring round was ever observed to trigger in this
function. The colour list and bank are FP; the integer bank was measured only
through its outcomes.

### L11. The dead-read dial calculus

Adding references to a web to move its priority is a **dial with known
arithmetic**, not a permutation:

* **+10 `save` per surviving reference**, regardless of branch nesting. There
  is no discount for a reference inside a conditional, and no loop-depth
  weighting is reachable: trip-1 and `while (0)` wrappers fold before
  `compute_save`, and a real `for` loop changes the frame.
* **+1 `cardbit` per spanning statement.** Each additional *statement* before
  the point of interest contributes its own transient basic block to every web
  that spans it -- which is what pushes `raw` across a quantisation step.
* **An empty-body `if` folds *after* `compute_save`.** Its references are
  counted; its code is not emitted. This is the entire reason a zero-instruction
  statement can rotate an allocation.
* **Ties break by ascending first-occurrence symbol**, so at equal priority the
  earlier-declared value wins -- a dial you turn by moving a declaration, not by
  adding a reference.
* **The step is a cliff.** Measured on one web: 2 references gave a 15.0 tie
  (symbol order decided), 3 references in one statement gave
  70/4 = **17.5** and the target rotation, 4 references collapsed codegen to
  `words=1834`. Branchless spellings (`a + a + a`, `|`, `&`) fold to one
  reference; separate statements overshoot on `cardbits`. `x && x && x` in a
  single statement was the unique sweet spot.
* **Poisoning is fatal and non-local.** A third read *block* halved a
  neighbouring web's priority through card growth, shifting the whole colour
  ladder. Any equilibrium tolerated only 2–4 specific reads before the schedule
  broke.

**Receipt -- T1 arithmetic** from the instrumented traces, **T2 outcomes** over
roughly 60 variants in the `tu-probe/dial2..dial9` grids: the headline cell
`dial8/t8__o3-none.c` reaches `words=3 opcodes=2 gaps=0 insns=1868 frame=−168`
with the complete target integer-web rotation and **no donor at all**.
`O3AND_COUNTERDIAL.md`; a second, independent 261-variant closure with per-basin
priorities in `ROW49_SHORT_CIRCUIT_COUNTERDIAL.md`.

**Falsifies.** Three claims. That the healing donor's rotation was the only
integer-web lever (a donor-free spelling reproduces it). That conditional
nesting discounts `save` by half (+10 everywhere measured). And that the dials
compose: every donor composed with the counter-dial re-broke the rotation, and
the counter-dial "cannot simply be summed until it overcomes the donor's
priority drop".

**The survival condition -- measured, and the campaign summary had it
backwards.** A nine-variant grid on the one-word base (fixed slots -- before
the dispatch `switch` and at the head of the first case body -- varying only
the read target) separates the outcomes on **reaching definitions**, not
liveness:

| slot | read target | outcome | words | opcodes | gaps | insns | frame |
|---|---|---|---:|---:|---:|---:|---|
| pre-switch | `opcode` (defined, live -- the selector itself) | erased, no observable effect at all | 1 | 0 | 0 | 1868 | −168 |
| pre-switch | `command` (defined, live) | erased; pure allocation rotation | 9 | 0 | 0 | 1868 | −168 |
| pre-switch | `csr` (defined, live pointer) | erased; larger rotation | 15 | 0 | 0 | 1868 | −168 |
| case-body head | `command` (defined, live) | erased; the same rotation | 9 | 0 | 0 | 1868 | −168 |
| pre-switch | `temp1` (no reaching definition) | real schedule damage | 116 | 34 | 48 | 1868 | −168 |
| case-body head | `temp1` (no reaching definition) | real schedule damage | 102 | 34 | 44 | 1868 | −168 |
| pre-switch | `svar2` (no reaching definition) | catastrophic; frame moves | 1791 | 1626 | 18 | 1864 | −176 |

An empty-body read is erased at zero instruction cost whenever the variable
has a **reaching definition on that path** -- being live afterwards is
irrelevant, and reading the switch's own selector is even reference-inert.
What is fatal is a read with *no* reaching definition: the upward-exposed
use drags a web back through the CFG (here, through the interpreter loop)
with schedule collateral that scales up to a frame change. The campaign
summary's "survives only on dead or undefined variables" conflated
defined-but-dead with undefined: the exact-match family's phase reads
(`f1`, `temp1`, `f0` in the vortex tail) were safe because those variables
were **defined earlier in the same block**, not because they were dead. The
solid negative half is unchanged: bare labels, bare expression statements,
self-assignments and casts are pruned before `uopt` with no references and
no blocks, and declaration moves are FP-inert.

### L12. Interference is block-granular, and address-escaped locals fuse into one alias-class web

Two values interfere if their live-**block** bvects overlap -- not their
instruction ranges. A single cached field read can therefore keep a segment
alive across a whole block and forbid a colour permanently, invariant across
every trace. Address-escaped locals and their field caches fuse into a single
alias-class web, so aliasing one local drags every member of that class into
the same interference set.

**Receipt -- T1.** Web 87 in this function is the alias class of an
address-escaped stack local ∪ `this_ptcl->vel.z` field caches. A double field
read (a definition at one line plus a re-read in a later line) keeps a block-243
cache segment alive that forbids `f16` for a neighbouring web **in all 20+
instrumented traces**; any single-tail-read spelling severs the edge.
`ALLOCATOR_MODEL.md`.

**Falsifies.** The "distinct second web" route: two sine webs that both want
`f18` interfere via one block, and the block cut that severs them also removes
the provider the other web needs. Recorded as a measured wall, with the
severing spelling named -- not as an impossibility.

---

## cfe (the front end)

### L13. Literal pools are per use site, and an `extern` load is not a literal

7.1 emits **one FP literal per use site** with no deduplication: four textually
identical `0x4422F983` (2048/π) words sit contiguously in this function's
`.rodata`, one for each `sincos` site. Replacing them with reads of an
`extern` -- even `extern const` -- is **not** equivalent: a memory load carries a
different aliasing class than a literal, and the schedule breaks (measured
`words≈300`).

**Receipt -- T1 against ROM bytes.** ROM `0x51B00` (VA `800D6120`), immediately
after the function's two jump tables: `4422F983 4422F983 4422F983 4422F983`.
The compiled object's `.rodata` is 368 bytes where the extracted target's is
348 -- the 20-byte delta is those four words plus a 4-byte alignment pad.
`hosted-fix/TARGET_RODATA_FIX.md`.

**Falsifies.** The whole `extern const` respelling family, which had looked
like a free way to control literal placement.

**The integration corollary.** When such a function is folded back into its
translation unit the compiler re-emits the pool. Any separately-extracted data
symbols covering those words must be deleted from the project's symbol list, or
the build duplicates them.

### L14. A macro hand-expansion is byte-equivalent only on **one physical line**

Expanding a macro by hand is byte-inert if and only if the expansion is emitted
on a single physical line. Split across lines it changes codegen -- the line
number is a codegen input, as it is under 5.3
([L59 there](ido-5.3.md#l59-the-schedulers-tie-break-reads-physical-source-line-numbers)).
The reconstructed macro body is otherwise byte-locked: the ternary and
empty-`else` respellings of the same body break.

**Receipt -- T2**, from the macro-boundary grids
recorded in `ALLOCATOR_MODEL.md`.

**Scope.** T2 and single-function. The 5.3 page carries the read-from-the-pass
version of the mechanism; this is the 7.1 observation that it is still live.

### L15. 7.1 cfe has no inline-assembly or per-region optimisation pragma

The complete 7.1 `cfe` pragma table contains no inline-assembly, assembler-mode,
or per-region optimisation pragma. `asm`, `__asm` and `__asm__` are parsed as
ordinary **implicit function calls**, not as inline assembly. A 25-form source
grid over every accepted pragma spelling emitted byte-identical UGEN streams.

**Receipt -- T1** (pragma table read) **+ T2** (the 25-form grid).

**Falsifies.** The assumption that L3's proven assembler-mode barriers
(`.set nomove` and friends) had *any* source spelling under this compiler.

---

## Composition

### L16. A `x ? x : x` selector reshapes the switch selector temp at zero codegen cost

Writing a switch selector as a conditional expression whose arms are the same
value moves the dispatch temp's stack home. Measured here: two 4-byte temp
homes move down by 4 bytes each -- `44(sp)`/`48(sp)` become `40(sp)`/`44(sp)` --
inside an **unchanged −168 frame**, with identical instruction count, identical
opcodes, identical registers and identical schedule. It is a frame-layout lever
with no codegen collateral at all, which is a rare thing.

When the ternary's condition is an `&&`-chain it *also* carries
[L5](#l5-branch-to-next-elimination-removes-at-most-two-conditional-branches-and-unboundedly-many-unconditional-ones)'s
barrier **inside** the switch statement -- one construct, two mechanisms -- which
is what makes it reachable at a boundary where a standalone statement cannot go
([L6](#l6-a-jump-tables-range-guard-is-synthesized-by-ugen-and-its-subtract-is-an-atomic-child-of-that-guard)).

**Receipt -- T2**, isolated by direct candidate-to-candidate comparison. With
everything else held fixed, `part12/p12__bal1.o` versus
`part13/p13__A-t3out-nobar-b1.o` differ in **exactly eight words**, all of them
`sw`/`lw` stack offsets at indices 1202/1203/1207/1208 and 1247/1248/1252/1253:
`words=8 opcodes=0 gaps=0 regs=0 fp=0 insns=1868`, both frames −168. Against
the target, the ternary basin is `words=0 exact=true`.

The lever is insensitive to nearly everything about its spelling. Four distinct
placements compile to one byte-identical exact text (`3ba07814aab3`): on the
outer selector with a three-term condition (`p13__A-t3out-nobar-b1`, the adopted
source), on the outer selector with a one-term condition plus a separate barrier
statement (`p13__B-t1out-bar-b1`), on the **inner** selector with either arity
(`p13__C-t1in-bar-b1`, `p13__C-t3in-bar-b1`), and on both selectors at once
(`p13__D-t1both-bar-b1`).

**Falsifies.** The reading of that eight-word residual as an allocator problem.
It survived every declaration, width, qualifier and lifetime dial in a
135-shape × 261-variant grid -- because it was never a colouring residual; it
was a temp-slot residual, and one selector respelling moved it.

**How the four mechanisms compose.** The adopted source is the composition of
[L5](#l5-branch-to-next-elimination-removes-at-most-two-conditional-branches-and-unboundedly-many-unconditional-ones),
[L8](#l8-block-order-is-a-lexical-successor-first-dfs-num--1-decides),
[L9](#l9-if-c-goto-l-makes-the-goto-target-the-fallthrough-and-an-opposing-arm-statement-re-biases-the-choice)
and this law, and **each one is useless alone**: 9 words for the layout,
13 for the layout plus an unballasted barrier, 5 for the ternary without the
ballast, 8 for the ballast without the ternary, 0 for all four. The two dials
are exactly orthogonal -- the ternary owns the eight stack words, the ballast
owns the five parity words -- which is only visible because each was proven in
isolation first.

```c
if (opcode >= 209) goto high;          /* L9: goto target is the fallthrough */
goto low_entry;                        /* L9: opposing-arm ballast edge      */
high:;
switch (opcode && opcode && opcode ? opcode : opcode)   /* L16 + L5          */
{
low_entry:                             /* L8: Duff nesting for body layout   */
    if (opcode && opcode && opcode);   /* L5: the surviving as1 barrier      */
    switch (opcode)
    {
        /* … low cases … */
    }
    break;
    /* … high cases, in the outer switch … */
}
```

---

## Cross-phase

### L17. UGEN and as1 determine the basin; cfe and uopt versions do not

Crossing four phase versions -- cfe ∈ {7.1, 7.1-t4, 5.3}, uopt ∈ {7.1, 5.3},
ugen ∈ {7.1, 5.3}, as1 ∈ {7.1, 5.3} -- over all 24 combinations gives exactly
three outcomes, and **cfe and uopt contribute nothing**:

| ugen | as1 | cfe/uopt combos | words | opcodes | gaps | insns | text sha1 |
|---|---|---:|---:|---:|---:|---:|---|
| 7.1 | 7.1 | 6 | 1 | 0 | 0 | 1868 | `87b158ed0749` |
| 7.1 | 5.3 | 6 | 321 | 282 | 4 | 1864 | `36a92e5da5ee` |
| 5.3 | 7.1 | 6 | 1577 | 1426 | 224 | 1868 | `5500c623f323` |
| 5.3 | 5.3 | 6 | 1577 | 1426 | 224 | 1868 | `5500c623f323` |

Feeding one fixed 7.1 Binasm stream to six independent `as1` builds splits them
cleanly by release, not by build: two 7.1 hashes both give `words=1`, four 5.3
hashes all give `words=321`. Four whole 5.3 toolchains from four unrelated
projects emit byte-identical function text despite different binary hashes.

**5.3's `as1` therefore behaves differently on identical input.** The peephole
laws L1–L3 are 7.1 laws, and a 5.3 reading of them would be wrong.

**Receipt -- T2**, 415 executable phase paths inventoried and hashed across the
workspace (68 toolchain roots, 35 unique phase signatures, 14 unique `as1`
hashes); all crossings compiled serially at nice 10 and compared statically.
`COMPILER_PROVENANCE_MATRIX.md`,
`compiler-provenance-{as1,mix,whole}-results.json`.

**Falsifies.** The mixed-provenance hypothesis -- that the original object came
from an earlier cfe or uopt paired with 7.1's backend. Every such mix lands in
the same byte-identical basin.

---

## Measurement laws

### L18. A hosted target can be missing the function's own literal pool

A scratch target object is an *extraction*, and an extraction can be wrong. In
this campaign a `words=0` source scored 5 on decomp.me because the target's
`.rodata` had been truncated at 348 bytes where the true function owns 368:
the splat had symbolised the function's own four-word literal pool as external
data and cut it out of scope. The candidate was the faithful object; the target
was not.

**Receipt -- T1 against ROM bytes**, one minute of work: the four literals are
contiguous with the function's jump tables at ROM `0x51B00`. Repairing the
target's section extent and re-comparing gives `exact=true words=0 opcodes=0
gaps=0 insns=1868 frame=−168` with byte-identical `.rodata` payloads.
`hosted-fix/TARGET_RODATA_FIX.md`, `hosted-fix/target-fixed.o`.

**Falsifies.** Ten days of campaigning that treated the target's scope as
ground truth. A target audit -- rodata continuity after jump tables,
literal-pool presence and width, externalisation of function-owned data --
belongs at campaign *registration*, not after `words=0`.

### L19. A saturation verdict is scoped to its basin

Two independently produced "this dimension is exhausted" verdicts in this
campaign were later falsified -- not because the sweeps were wrong, but because
the equilibrium they were measured in moved. A negative result is a statement
about a basin, and adopting anything that changes the schedule re-opens every
dial closed in the previous one.

**Receipt -- T2, by counter-example.** The donor-rotation family was recorded as
the only integer-web lever after nine grids; a donor-free spelling later
reproduced the rotation exactly
([L11](#l11-the-dead-read-dial-calculus)). Empty-read *positions* were recorded
as saturated; the composition under
[L16](#l16-a-x--x--x-selector-reshapes-the-switch-selector-temp-at-zero-codegen-cost)
used a position from inside that closed set. Both original sweeps were valid
and bounded; neither was entitled to the word "exhausted".

**The corollary for scalar metrics.** `words` over-charges layout: one
candidate scored 1,791 words for what was, as an edit script, a single moved
29-row block. `opcodes` conflates schedule with allocation
([L10](#l10-globalcolor-is-chow-priority-colouring-and-the-priority-is-save--units)).
A per-site heal signature -- a fixed watchlist of discriminating rows rendered
as healed/broken columns -- was the only fitness function that converged.

---

## Instruments these laws were read with

Not laws -- the handles.

* **Static translation of the original SGI ELFs.** `as1` and `ugen` were
  recompiled to readable C from the stripped IRIX binaries; procedure names came
  from `.rtproc` descriptors rather than the symbol table. This is what turned
  "as1 does something here" into named routines and byte offsets (L1–L4, L6).
* **`as1 -peepdbg`.** Stock, no patched binary: prints one line per peephole
  rewrite (`Peepreg (INST n) changed rs A => B`). Read `INST n` as
  block-local (L1).
* **Arg-preserving phase-capture wrappers** around `ugen`/`as0`/`as1`, writing
  each pass's input and output into labelled run directories. Rebuilt ad hoc
  twice in this campaign; it is the single most reusable thing in it.
* **Ucode and Binasm decoding** (`decomp-workbench pass ucode`, `pass binasm`).
  Parsing both phase streams side by side is what found the surviving
  conditional-branch record and the body relocation. Note the trap: `ugen`'s
  `-temp` output is **not** Ucode -- it is fixed 16-byte Binasm records.
* **Ucode patch-and-replay.** Insert records into a captured stream, re-run the
  stock phases, compare. This proved L5 words=0 a full session before the
  source spelling existed, and it is how a fix is validated *before* hunting C
  for it.
* **The instrumented `uopt` (A71-v2).** Five trace points beyond the shipped
  A71 pair: interference propagation, live-block bvects, transit bvects, exact
  `compute_save` priorities, neighbour lists. Gated byte-identical (L10–L12).
* **Byte-pattern search.** Grepping a discriminating instruction encoding
  across dozens of objects is an instant oracle and is badly underused: the
  full-TU-state question under L2's scope was settled by searching both `addiu`
  encodings across four probe objects.

---

## Claims a reader will find in older notes and should not believe

| Claim | Status | What killed it |
|---|---|---|
| `repl_reg` performs the row-49 rewrite | corrected by [L1](#l1-peep_reg-propagates-a-copy-fact-and-only-a-type-3-alias-is-followed) | static translation plus `-peepdbg`: it is `peep_reg` |
| `as1` treats `v1` and `a1` differently in `move` handling | corrected by [L2](#l2-a-content-fact-reaches-the-next-block-only-through-a-single-predecessor-fallthrough-and-is-then-filtered-by-the-taken-targets-live-in-mask) | both install an identical type-3 fact; the live-in filter differs |
| The healing `if (!command);` donor is an allocator lever | corrected by [L2](#l2-a-content-fact-reaches-the-next-block-only-through-a-single-predecessor-fallthrough-and-is-then-filtered-by-the-taken-targets-live-in-mask) | it is a live-in-mask lever; the rotation was collateral |
| A zero-instruction construct cannot change codegen | falsified by [L3](#l3-as1-mutates-its-content-state-before-it-deletes-redundant-code-so-a-barrier-can-cost-zero-instructions) | twelve deleted-before-emission barriers, each exact |
| `move v0,v0` before the use is a self-copy barrier | falsified by [L3](#l3-as1-mutates-its-content-state-before-it-deletes-redundant-code-so-a-barrier-can-cost-zero-instructions) | operands resolve first: it becomes `move v0,v1` and re-creates the fact |
| Some `as1` flag disables just this transform | closed by [L4](#l4-there-is-no-peephole-gate-below--nopeep) | one boolean, `peep_opt`, gates both passes |
| No source-reachable barrier exists at the dispatch boundary | falsified by [L5](#l5-branch-to-next-elimination-removes-at-most-two-conditional-branches-and-unboundedly-many-unconditional-ones) | true for unconditional branches and metadata only; three conditionals survive |
| Barrier strength grows with the number of barriers | corrected by [L5](#l5-branch-to-next-elimination-removes-at-most-two-conditional-branches-and-unboundedly-many-unconditional-ones) | one and two are erased, three is exact, four is catastrophic |
| The jump-table subtract belongs to the `Uxjp` translator | corrected by [L6](#l6-a-jump-tables-range-guard-is-synthesized-by-ugen-and-its-subtract-is-an-atomic-child-of-that-guard) | it is a child of a synthesized range-check `Ufjp` |
| `selector + 0` in C reproduces uopt's additive selector wrapper | falsified by [L6](#l6-a-jump-tables-range-guard-is-synthesized-by-ugen-and-its-subtract-is-an-atomic-child-of-that-guard) | `ustack_add_value()` drops a zero displacement; the wrapper is class-driven |
| Body relocation is a "nontrivial trampoline" test | corrected by [L8](#l8-block-order-is-a-lexical-successor-first-dfs-num--1-decides) | it is `depth_first_order`'s `num + 1` lexical-successor rule |
| Predecessor count influences uopt's block layout | retired by [L8](#l8-block-order-is-a-lexical-successor-first-dfs-num--1-decides) | `depth_first_order()` never consults it |
| A `Uloc`/`Unop`/bare label can reorder blocks | falsified by [L7](#l7-an-empty-pure-conditional-is-a-ghost-edge-no-code-but-the-cfg-edge-survives) | no graph edge is created; only a conditional's ghost edge survives |
| High-case body placement is unreachable from C | falsified by [L8](#l8-block-order-is-a-lexical-successor-first-dfs-num--1-decides) | Duff nesting reproduces the two-cluster layout at `words=9` |
| A braced `if/else` partition is equivalent to a goto pair | falsified by [L9](#l9-if-c-goto-l-makes-the-goto-target-the-fallthrough-and-an-opposing-arm-statement-re-biases-the-choice) | 1,797 words versus 13, and four instructions short |
| The donor rotation is the only integer-web lever | falsified by [L11](#l11-the-dead-read-dial-calculus) | a donor-free three-reference statement reproduces it (`words=3`) |
| Conditional nesting discounts a web's `save` | falsified by [L11](#l11-the-dead-read-dial-calculus) | +10 per reference everywhere measured |
| Loop wrappers weight `save` by depth | closed by [L11](#l11-the-dead-read-dial-calculus) | trip-1 and `while (0)` fold before `compute_save`; real loops change the frame |
| `opcodes` measures allocation quality | corrected by [L10](#l10-globalcolor-is-chow-priority-colouring-and-the-priority-is-save--units) | variants with broken `opcodes` carried the correct colouring |
| The eight-word stack residual is an allocator problem | falsified by [L16](#l16-a-x--x--x-selector-reshapes-the-switch-selector-temp-at-zero-codegen-cost) | one selector ternary moves it with zero codegen change |
| `extern const` reads are equivalent to FP literals | falsified by [L13](#l13-literal-pools-are-per-use-site-and-an-extern-load-is-not-a-literal) | the aliasing class changes the schedule (~300 words) |
| The object came from a mixed cfe/uopt provenance | closed by [L17](#l17-ugen-and-as1-determine-the-basin-cfe-and-uopt-versions-do-not) | all 24 crossings land in the same byte-identical basin |
| The hosted target defines the function's rodata scope | falsified by [L18](#l18-a-hosted-target-can-be-missing-the-functions-own-literal-pool) | ROM bytes show the literal pool the extraction cut |
| Empty-read positions / donor rotations are exhausted | falsified by [L19](#l19-a-saturation-verdict-is-scoped-to-its-basin) | both re-opened after the equilibrium moved |

---

## Using this page

```sh
decomp-workbench guide laws ido71
```

The field guide answers "what do I change" -- levers 34–39 are this campaign's.
This page answers "what will the compiler do about it". When they disagree, the
guide is the one that gets edited: a lever is a hypothesis about mechanism, and
mechanism is measured here.
