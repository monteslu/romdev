# Evidence ladder

Use the strongest available evidence and state its scope precisely.

| Evidence | Establishes | Does not establish |
|---|---|---|
| decomp.me percentage or visual diff | A direction worth investigating | Exact code, context, or ROM match |
| Normalized instruction similarity | A structural neighborhood | Literal operands, allocation, or final bytes |
| Byte-pattern search for a discriminating encoding across many objects | That a specific candidate did or did not reach a known mechanism -- instantly, across dozens of objects, with no recompiling or rescoring | Which source spelling produced the encoding, or overall exactness |
| Same opcode shape | Stable control-flow and instruction schedule | Matching registers or relocation layout |
| Region collapses under `-g0` | Debug metadata constrains the `-g3` schedule; as1 can reach that order | Original or correct source topology |
| Cross-ROM structural match | Shared compiler/source lineage evidence | Exact target object or project match |
| Force-color or pass-replay experiment | A late compiler cause is plausible | A valid C source match |
| Phase-capture decode (Ucode/Binasm) read side by side against the target's own captured streams | Which compiler pass owns a residual, attributing it to a specific record or boundary | A source-level cause, or that the boundary is reachable from any legal C |
| Ucode patch-and-replay that proves a fix at a phase boundary | That a named mechanism, if reachable from C, produces the exact object -- a real cause, isolated from source search | That the mechanism is reachable from any legal C spelling, or how to reach it |
| Frontend algorithm analysis proving a shape unreachable | That branch of source search is closed; the residual is a toolchain question | Which historical toolchain actually built it |
| Stock decomp.me compiler-ID exact match | That selected stock frontend/driver reproduces the function | That a similarly named preset uses it, or that the whole original TU used it |
| Byte-exact reproduction through an alternate authentic frontend | The historical lowering is identified behaviorally, with unmodified binaries | That the exact shipping binary or point release is found |
| Relocation-aware instruction-exact object comparison | The selected function's instructions and known relocation layout agree | Whole-project or final-ROM identity |
| Local `check-scratch` score proxy (raw words plus relocation targets exact) | The retained target/current objects predict a zero decomp.me score | The site's result, whole-project or final-ROM identity, or a stale browser metadata score |
| Normal project link and full-output verifier | The project's required final proof | A portable conclusion for another revision without comparison |

## Resolve contradictory-looking evidence

Do not assume a lower external score disproves exact object evidence. First
check whether the two comparisons use different:

- compiler versions or flags;
- selected function boundaries;
- translation-unit declarations and available prototypes;
- constant-pool, BSS, or rodata symbol spelling -- `compare --json` now resolves
  literal-pool accesses to slots and reports `pool_resolution`; a
  `pool`-classed row is an anchoring difference between the two symbol tables,
  not a code difference, while `pool_layout` is a real one;
- which register population a differing register belongs to: the uopt/ugen
  split is per compiler release, and only IDO 5.3 `-O2 -mips2` has been probed
  (`register_profile_evidence` says which table produced the lane);
- object versus linked/ROM relocation context.

The Titania campaign demonstrated this boundary: an external scratch score
could retain a tiny residual when the underlying object-level instruction
evidence was already exact, because equivalent linked addresses were printed
through different compiler-generated symbols.

The `vsprintf` campaign demonstrated a second boundary: a large region
collapsing under `-g0` did not prove the C was original. A freer scheduler had
rescued a non-original padding/length topology. The eventual match required a
different source expression shape, followed by site-faithful source-line
identity for the final scheduling tie.

## Prove at the boundary, then hunt C

When a residual is suspected to be phase-local (an assembler peephole, a
scheduler decision, a branch eliminator), do not start a source-spelling sweep
on a guess. Capture the phase streams around the boundary, decode them, and
patch-and-replay the suspected fix directly at that boundary through the stock
pass. A replay that reaches `words=0` proves the mechanism is real and exactly
where it lives, before a single C variant is written for it. In one IDO 7.1
campaign the conditional branch-to-next barrier was proven `words=0` by stream
surgery a full session before any source spelling reached it (see
`docs/compiler-laws/ido-7.1.md`). Only then search for the source shape that makes
the compiler emit the proven record on its own; a proven-but-unreachable
mechanism is still worth recording; it bounds how much source search remains
worth doing.

A patched or replayed stream is proof of a compiler-phase mechanism. It is
never itself a source match and must not be represented, promoted, or
committed as one.

## Keep heuristics in their place

Use a score to rank experiments inside one controlled campaign. Do not compare
scores across changed compiler contexts, ROM revisions, or external tools
without also preserving the comparison metrics and inputs. Prefer a candidate
that removes a structural class of difference over one that merely improves a
single score.

When a score is used, use the aligned one. `aligned_total` counts differing
rows after an LCS alignment; `words` counts positions and shifts on every
inserted or deleted instruction, which misranked candidates in six recorded
campaigns. The workbench sorts on the aligned count for this reason, and the
`aligned_*` class split says which lever family the residual belongs to.

The aligned score is comparable only across candidates the aligner treated the
same way. `gaps=` counts the rows it filled on one side only; any gap means
this candidate was aligned against a different subsequence of the target, so
its row count is a statement about *it* and not a place in a table. The report
prints an explicit `caution:` line in that case, and the ranking commands fall
back to `words`.
