# Late-stage doctrine

Practices earned in the last percent of a campaign, where every remaining
mechanism is small, interacting, and easy to mis-measure. Source: the IDO 7.1
campaign recorded in `docs/compiler-laws/ido-7.1.md`.

## Compose mechanisms late

Prove each lever in isolation with the smallest probe that can prove it -- a
force build, a phase-boundary replay, a single-statement source variant --
before trying to combine it with any other lever. A residual that survives
every single-lever probe is not evidence that no lever works; it can mean the
final source needs several at once.

That campaign's exact source composed four independently proven
mechanisms, no one of which produced the exact object alone: a phase-boundary branch
barrier, a goto-pair fallthrough inversion, a dispatch-layout construct, and a
selector-temp reshape. Each had its own isolated probe and its own dossier
before anyone tried them together. Compose only levers that already have an
individual proof; combining unproven levers just multiplies the search space
without telling you which one, if any, is load-bearing.

When composing, change one lever at a time on top of the best composite so
far, and keep the composite that regressed nothing -- a lever that helps in
isolation but breaks another proven lever's precondition is a real finding
(mutual exclusivity), not a bug in the harness.

## Saturation-scope hygiene

A negative result -- "this family is exhausted", "no order reaches the
target" -- is true only inside the equilibrium or basin it was measured in.
Record that scope explicitly: which schedule equilibrium, which donor basin,
which fixed statement order or layout family was held constant while the
family was swept. An unscoped exhaustion claim reads as a claim about the
whole search space and will eventually be falsified by someone who varies the
dimension you held fixed.

Re-open every closed dial after any schedule or equilibrium change, even one
that looks unrelated to the closed family. Two independently produced
"exhausted" verdicts in that campaign -- a donor-rotation sweep and an
empty-read placement sweep -- were each falsified after the surrounding
schedule shifted for an unrelated reason; the closed family was never
re-examined until it became the next attack line by accident. Treat a
schedule-equilibrium change as an event that invalidates every negative result
measured before it, not just the one under active investigation.

## Fitness design for layout-shaped candidates

A scalar metric (`words`, `opcodes`) conflates schedule and allocation
differences with pure layout differences, and it over-charges a candidate
whose only fault is a moved block. A candidate that relocates one 29-row
block can score worse by `words` than a candidate with a dozen unrelated
allocation mismatches, because `words` counts positions and shifts on every
inserted or deleted instruction. `op`-family scores have the same failure
mode from the allocation side: a variant can carry "broken" opcodes while
already holding the correct register coloring, because opcode counting
conflates the schedule question with the allocation question.

Use a per-site heal signature instead once a residual is layout- or
allocation-shaped: pick the small set of rows that discriminate between
hypotheses (a watchlist), and render each candidate as healed/broken on that
watchlist rather than as one number. A signature converges monotonically on
the mechanisms that actually matter; a scalar score on a layout-shaped
candidate can move in either direction for reasons that have nothing to do
with correctness. Prefer `align`/shift-tolerant comparison over positional
`words` for any candidate reporting a structure mismatch, and treat a
`caution:` line on `aligned_total` as a signal to switch fitness functions,
not just a caveat on the existing one.

## Target trust

A campaign target is data, not ground truth by default. Audit a target
object's section scope against the ROM (or the project's other verified
truth) at campaign registration -- rodata continuity across jump tables and
literal pools, whether function-owned data was externalized into a neighbor
symbol, whether the extraction boundary matches the function's real extent --
before spending any variant budget on it.

The same campaign reached a genuine `words=0` / `exact=true` local result
and still saw a nonzero hosted score, because the hosted target object's
`.rodata` extraction had been cut 20 bytes short of the function's real
literal pool (four identical constants belonged to the function and were
mis-attributed to an external symbol). Ten days of
prior campaigning had assumed the target's scope was correct; the mismatch
was provable in one minute against ROM bytes once anyone checked. Audit the
target before the search, not after a words=0 that still won't confirm.
