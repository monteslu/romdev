---
name: n64-decomp-campaign
description: Diagnose and finish late-stage N64 MIPS decompilation mismatches with reproducible evidence, object comparison, guided field-guide levers, IDO allocator traces, frontend-lineage checks, and source-variant campaigns. Use for near-matching functions, decomp.me score plateaus, cross-ROM comparisons, register-allocation residuals, dispatch shapes the project compiler cannot emit, or planning a decompilation campaign.
---

# N64 Decomp Campaign

Use this skill to turn a stubborn N64 decompilation residual into a sequence of
small, falsifiable experiments. Use the project's normal object or ROM build as
the final oracle. Treat a browser percentage as a lead, never as proof.

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
The `guide` command has no server op: its pages are `docs/field-guide.md` and
`docs/compiler-laws/ido-5.3.md` / `ido-7.1.md` in the workbench data shipped
with romdevtools (`src/decomp/workbench/data/`).

## Start from an evidence inventory

Before editing source, identify and preserve:

- target function object or a redistributable objdump dump;
- current source and its translation-unit context;
- compiler family/version, canonical compiler ID, language/frontend, preset,
  driver, flags, wrapper, and working directory as separate fields;
- current comparison report, candidate hash, and project build result;
- relevant trace/log only when the residual is allocation- or schedule-related.

Then prove the harness before trusting it: compare a known-matching sibling
function (or a shipped fixture) through the same compiler wrapper, flags, and
comparator invocation, and require `instruction-words-identical` before
touching the real target. Every recorded campaign that skipped this step
either chased a stale context file or credited the wrong compiler; every one
that ran it caught the problem in minutes.

Run `decomp-workbench diagnose` or `diagnose-dumps` before choosing an
experiment. It loads each input once and returns both exact comparison truth
and the decisive aligned mechanism view. Use `compare` for a compact gate and
`view --show-all` for every hunk. Record the verdict, not only a scalar score.
For a long-lived project, preview `decomp-workbench project init` and commit a
reviewed `.decomp-workbench.toml`; `project next`, `project compare`,
`project diagnose`, and `project campaign` then reuse the same resolved object,
sealed environment, and compiler lineage without guessing an objdiff unit or
Makefile target. Agents should read `commands --json` for capability/safety
metadata and execute `next --json`'s `command_argv`, not its shell-rendered
display string.

When the input is a downloaded decomp.me ZIP, start with
`decomp-workbench check-scratch SCRATCH.zip --view`. It reads the site's own
target/current objects, keeps the display score separate from object truth,
and can reproduce `ctx.c` plus the language-aware `src.c`/`src.cxx` line reset
and candidate composition with `--compile-command`. Its frontend line names
the canonical compiler ID, language, expected driver, and frontend family;
verify those before interpreting a compiler error. It never logs in or uploads.
When a project object exists, add `--project-object` and optionally
`--project-source`: report site metadata, scratch truth, and project truth as
independent layers. Treat `context-only` as a context experiment, not a source
regression. Only follow the unused-call-return occupancy hint when the command
emits it; its C89, late-call, and coherent `$v0`/`$v1` gates are what make one
scratch-only return-category probe defensible.

The `next:` footer under every verdict names the matching field-guide
levers and the exact `decomp-workbench guide <playbook|lever|verdict>` command
that prints them; heed it before inventing an experiment, and consult the
field guide's dead-families table before re-testing a family it already
buried. Heed input warnings the same way: a cross-function warning means the
comparison itself is invalid, not that the source is far. In batch loops,
`--terse` drops only the orientation lines. When `compare` reports a coarse
allocation verdict it deliberately names three candidate families without
choosing; run `view` or `diagnose` to get the committed family before
spending a variant.

Rank candidates by `aligned_total`, never by `words` -- but only across
candidates whose summary line reads `gaps=   0`. Positional word counts shift
on every inserted or deleted instruction, so the variant one edit away can
report a longer residual than one with a dozen unrelated allocation
differences. A candidate with gaps is aligned against a *different*
subsequence of the target, so its `aligned_total` can fall *below* a strictly
better candidate's: one recorded campaign built a 257-build lever table on a
candidate reporting 1435 aligned rows against a 1865-row base while holding
2918 mismatching words and 1807 opcode mismatches. `compare` prints a
`caution:` line whenever that is the case, and `rank`/`campaign` order a mixed
set on `words` instead and say so. `words=0` with `exact=true` is still the
only matching claim.

There is one explicit late-stage exception: after instruction counts and
positional opcodes agree and `pool_exact=true`, run an allocation family with
`campaign --rank-by temp-prefix`. It keeps a candidate whose first ugen-temp
divergence moves later even if unrelated tail rows make `words` worse. Read
`temp_prefix_exact`, `first_temp_divergence`, and `first_divergent_row`; do not
substitute a scalar score for that trajectory. If an experiment declares
`homologous_parameters`, follow a `campaign status` sibling suggestion only
when it cites the measured one-parameter prefix gain that earned it.

## Choose the next experiment from the residual

| Evidence | Work on | Do not start with |
|---|---|---|
| Instruction count, opcode sequence, or frame differs | Control flow, loop form, calls, expression tree, declaration form | Register forcing or fake locals |
| Opcode shape is stable but registers differ | Lifetimes, variable reuse, declaration order, and one allocator web | Broad source rewrites |
| Only relocation-controlled raw words differ | Translation-unit context and final linked/ROM output | Chasing a display percentage |
| Same instruction multiset, different order | Expression/statement topology, then frontend-specific statement line assignment -- moves change which numbers a statement can carry and logical-line ties change the relations -- then as1 scheduling | Assuming cfe and EDG attribute a backslash splice identically; calling `-g0` collapse source proof |
| Cross-ROM structure matches | Shared lineage as a structural witness | Calling it target-object exact |
| A local forced/unrolled loop looks good but the function does not | Whole-function roles and liveness | More local fakes or manual unrolling |
| A dispatch shape the project frontend provably cannot emit, clustering by translation unit | Frontend lineage: alternate authentic frontends, dispatch-construct discrimination | More source spellings against the impossible shape |

Read [references/evidence-ladder.md](references/evidence-ladder.md) when
interpreting comparison evidence or external scores. Read
[references/ido-late-stage-patterns.md](references/ido-late-stage-patterns.md)
when the mismatch is caused by IDO code generation or register allocation.

When a residual routes `permuter-first`, run the measured loop rather than
concluding a wall from prose:

1. `decomp-workbench ranking check RANKING` before ordering work by a closeness
   ranking. A ranking measures one tree and decays as that tree moves;
   `ranking stamp` records the tree it was measured on.
2. `decomp-workbench permute-doctor FUNCTION --queue QUEUE` before searching.
   A scratch that is not the object the build produces searches the wrong
   thing, and reports it as a wall.
3. `decomp-workbench permute-sweep QUEUE --minutes N --require-fresh` for the
   bounded search itself.
4. `decomp-workbench permute classify SUMMARY` afterwards. Only
   `P_STUCK_DESCENDING` earns trace levers or a human; `P_STUCK_FLAT` is the
   pool that argues for deeper instrumentation; `IMPORT_FAULT` routes back to
   step 2 and is not a result about the function.
5. `decomp-workbench diagnose ... --trace TRACE --trace-proc N` when a trace
   exists. The `ownership:` line names `owning_pass`, `reachability`, and
   `ownership_basis`; report which of `trace` or `heuristic` the basis was, and
   never present a heuristic ownership claim as a measurement.

Never report an exactness result without naming what each side was built from:
`--built-from` on `compare`/`diagnose`, or `check-staleness` over the chain. A
comparison against a stale object reports zero differing words for an edit that
was never compiled.

## Run a controlled campaign

1. State one causal hypothesis with `campaign note` and in the experiment
   manifest when a generator produced the family.
2. Change one family at a time: declaration order, carrier reuse, expression
   tree, loop spelling, literal type, or live-range boundary.
3. Validate a `decomp-workbench-experiment-v1` sidecar when descriptive
   parameters suffice. Use v2 for target-relative signals, serial absolute or
   differential controls, and declared coverage. A required FAIL/UNKNOWN
   control must stop before ordinary candidates; never bypass it.
4. Compile variants through `decomp-workbench campaign` with an explicit
   compiler wrapper, working directory, and environment. The identity-checked
   manifest and append-only ledger are created under `.decomp-workbench/` by
   default.
   Campaigns use a sealed environment: pass fixed values with `--env` and opt
   specific host values in with repeatable `--inherit-env`. Unnamed host state
   must not reach the compiler or its cache identity. Keep the default
   `--retain-sources leaders` unless the experiment needs `exact`, `all`, or
   `none`; retained candidates are content-addressed so a finish/package step
   does not depend on a mutable source glob still existing.
   When one wrapper exposes multiple lineages, record `--compiler-id`,
   `--frontend`, `--language`, `--driver`, and `--backend`. Keep IRIX 4
   `accom`, later `cfe`, and hybrid frontend/backend cells distinct.
5. Compare every successful object; inspect `campaign status` so trajectory,
   failures, family space, and object basins survive interruption. Identical
   compiler outcomes do not masquerade as independent discoveries.
   Filter a large sweep with `compare --census KEY=VALUE` (exit 0 when every
   predicate holds, 3 when one fails) rather than writing another objdump and
   regular-expression layer.
   Read required/optional signal transitions separately from the acceptance
   trajectory. A mechanism signal can make a dominated result valuable; it
   cannot make that result exact. Scope every negative to the printed coverage
   conclusion and control state.
6. Keep promising source/object pairs and the associated trace evidence.
   Treat a variant that fixes any subset of the residual as a new baseline
   and re-run the layout levers on top of it, even when its own score is
   dominated -- the recorded `unref_800036B4` match was two edits from
   variants already on disk in a campaign that had scored them "partial,
   dominated" and moved on.
7. Use `campaign resume` for work absent from the validated ledger; do not
   reconstruct the source glob by hand.
8. Return to a readable, source-level explanation after a force probe or fake
   demonstrates causality.

**A mutation-sweep winner is never adopted on its score.** An automated
source-mutation sweep proposes edits by shape, not by meaning, so a variant
that compiles and scores better may not be the same program. One recorded
sweep grouped a local's occurrences by line proximity and renamed a whole
group; a group holding only reads became a read of an uninitialised variable,
and the top-scoring row deleted a live first store. Before adopting any
winner from any generated set:

- run `decomp-workbench experiment review-mutation BASELINE.c VARIANT.c`, which
  prints the diff and flags a use that no earlier line writes to plus a
  removed write to a value still read;
- read that diff and justify **every** changed line as a C transformation,
  independently of what it scored. A clean report is not a validity claim --
  the check is textual, builds no control-flow graph, and says so.

An unjustified line is a reason to drop the variant, not a reason to keep
searching around it.

When an exact source still contains fake-match scaffolding, exactness starts a
cleanup phase. Run `experiment inspect-source`, encode only measured mechanisms
as exact-text transformations, and use `experiment compose` with an explicit
order and candidate cap. Compile the bounded interaction set with
`--no-stop-on-exact`; this is where independently useful families are tested
together instead of being abandoned on different parent sources. If two traces
have different semantic-web alignment but an identical decision-outcome
schedule, report carrier substitution rather than pretending the web identities
match.

Use `trace-globalcolor --proc PROC --web WEB` only after the comparator has
isolated an allocation residual. Use `trace-webs --against` to align variants
by semantic provenance and `trace-source` to map a logical line through
retained `#line`/`.loc` evidence without guessing. Plan a force grid with
`oracle plan`, which always reports p1 and p2 and excludes forbidden colors.
`oracle force/sweep` requires an intact, fully calibrated real-copy toolchain;
reopen results with `oracle status`. A forced exact build tests a cause; it is
not a source match.

For ugen-local allocation, instrumented free-list events carry an emitted
ordinal. Use `trace fifo --emission-map MAP.json` to join it to object row and
source line. Never read the emitted ordinal itself as an object row: assembler
folding makes that inference false, and the command reports missing calibration
instead of making it.

For a schedule residual, rebuilding with `-g0` is a layer-ownership probe. A
collapse proves debug metadata constrains the `-g3` schedule and as1 can reach
the target order; it does not prove the source shape is original. A freer
scheduler can rescue a wrong topology. Compare topology and line tags before
capturing the smallest possible as1 ready-set trace.

When `-g0` has nothing left to collapse, `decomp-workbench probe-lines UNIT.i
--compile-command '... {input} -o {output}' --target-object TARGET.o` decides
whether statement line assignment owns the order: a token-identical reflow
plus a mandatory blank-line control, so a `NONDETERMINISTIC` result invalidates
the run instead of being read as a finding. A `LINE-SENSITIVE` verdict earns
the follow-up question, and `--tie STATEMENT=LINE` (repeatable) answers it --
one statement's line number reassigned via a `#line` pair, scored toward and
away from the target. A tie is a probe, not a publishable spelling: once it
confirms the mechanism, find the natural layout that carries the same
assignment (field-guide lever 25).

Read [references/campaign-hygiene.md](references/campaign-hygiene.md) when
creating candidates, scratch artifacts, commits, or a public progress repo --
including the fan-out pattern for asserted-anchor generators, waved sweeps
with interim standings, and mid-flight steering. Read
[references/frontend-lineage.md](references/frontend-lineage.md) when a
residual survives every source family and the shape looks impossible for the
project compiler -- the frontend is a variable, not a constant, and hundreds of
variants against an unreachable shape are the most expensive way to learn
that.

Read [references/late-stage-doctrine.md](references/late-stage-doctrine.md)
when composing more than one independently proven mechanism, judging whether
a saturation or exhaustion verdict measured earlier still holds, choosing a
fitness metric for a layout- or allocation-shaped candidate instead of a
scalar score, or auditing a campaign target's section scope before trusting
it at registration.

Before calling a compiler path patched or impossible, run
`fingerprint-toolchain` through every plausible stock driver. Its dense-four
and dense-five switch cells report `chain` versus `table`; record the driver
and frontend with the result. A backend shared by two drivers does not imply
the drivers hand it the same control-flow IR, so source-level lowering remains
a frontend question until pass-boundary evidence proves otherwise.

## Validate in the right order

1. Accept `instruction-words-identical` or `instruction-exact` only as
   function-level object evidence. If the deliverable is a zero decomp.me
   score, additionally require `check-scratch` to report
   `decomp_me_score_proxy_exact=true`, with both
   `raw_instruction_words_exact=true` and `relocation_targets_exact=true`;
   `instruction-exact` alone can hide a scored relocation spelling.
2. If local and browser results disagree, run `check-scratch` and reproduce the
   site's context/line reset before editing C.
3. Compare exact candidates with `object collateral`. Fewer artificial locals
   can reduce `.bss` while leaving relocation, symbol, or GP-linker collateral;
   selected-function exactness does not settle the containing object.
4. Run the project's normal build and whole-ROM or project-level verifier.
5. Preserve the exact command, inputs, output hash, and commit that produced
   the final result.
6. Before publishing a proof repository, run:
   `decomp-workbench handoff audit PATH --dependency-root PROJECT`. Resolve
   every missing or untracked dependency; a file on the author's machine is
   not a reproducible handoff.
7. Use `campaign package` to promote the recorded winner into the standard
   checksummed scratch bundle; it revalidates campaign identities and refuses
   a non-accepted candidate unless the mismatch override is explicit.
8. Prefer `campaign finish` before promotion. It freshly rebuilds the immutable
   winner and records function, required-signal, optional scratch, collateral,
   handoff, and project gates independently. Omitted gates must remain
   `NOT RUN`. When required by the handoff, pass the resulting PASS receipt to
   `campaign package --finish-receipt`.

Do not claim completion from normalized distance, a register-only report,
cross-ROM structural evidence, a forced compiler result, or a decomp.me score.

## Report the result

Report: final oracle and result; comparator verdict; the hypothesis confirmed
or rejected; the smallest source-level explanation; exact commands or manifest
location; and any tool gap discovered. A clean negative on a callee-saved
tie-break (field-guide lever 19) is a legitimate terminal result: record it,
bundle the scratch, and take the next function rather than grinding variants
past the point the evidence supports. Scope every negative or impossibility
claim to the space actually searched -- statement order, physical layout,
frontend, flag set. "No layout reaches the target" published without the
fixed-statement-order caveat was falsified within a day by a natural-source
match built from ties the sweep never varied. Keep ROMs, proprietary compiler
binaries, and non-redistributable target objects out of public artifacts.
