# N64 matching decompilation with romdev

Read this when the task is "recover C that compiles to the original bytes"
for a splat-based project (IDO or GCC). It is a different job from
`disasm({target:'decompile'})`, which gives Ghidra pseudocode for
understanding: nothing there is compiled or compared, and it is never counted
as matched.

## The loop, in the calls you actually make

```
decomp({op:'import',   project:'wr64', root:'/abs/checkout'})          once
decomp({op:'resolve',  project:'wr64', symbol:'func_801DEB08'})         segment, ROM offset, TU, target asm
decomp({op:'generate', project:'wr64', symbol:'func_801DEB08'})         m2c draft with the TU's real type context
decomp({op:'compare',  project:'wr64', symbol:'func_801DEB08', candidatePath:'…/gen-1.c'})
decomp({op:'search',   project:'wr64', symbol:'func_801DEB08', candidatePath:'…'})   bounded permuter job
decomp({op:'job',      project:'wr64', jobId:'…', action:'best'})
decomp({op:'integrate',project:'wr64', symbol:'func_801DEB08', candidatePath:'…', apply:true})
decomp({op:'progress', project:'wr64'})
```

`compare` is the operation that matters. It compiles the candidate INSIDE
its real translation unit with the exact per-file flags captured from the
project's make, then reports three independent verdicts:

| field | what it proves |
|---|---|
| `exactFunctionMatch` | every instruction word AND every relocation (type + symbol + addend) equals the target assembled from the extracted asm |
| `romLinked.status` | the candidate's words, linked with the project's symbol addresses, equal the base ROM's bytes at the resolved offset (independent of the asm) |
| `verification.translationUnit` | every OTHER function in the TU's object is unchanged (a local match must not hide a side effect) |

`distance` is a documented edit distance for RANKING candidates. It is not
proof. A compile failure has no distance.

The verdict contract: every required check (text, rodata, romLinked) has a
state — `exact`, `mismatch`, `error`, `unknown`, `not-applicable` — and
`verdict.functionLocal` aggregates them: any mismatch → mismatch, else any
error → error, else any unknown → unknown, else exact. `exactFunctionMatch`
is true ONLY for exact; `verification.functionLocal` is the same aggregate;
`textExact` is the text check alone. A data comparison that threw, could not
locate its bytes, or is missing is never equality. `not-applicable` is
granted only when neither side references rodata at all. The verifier
version is part of the compare cache key; results from an older verifier
are ignored (`candidates` marks them `stale-verifier`).

## Addresses

The project's splat yaml is the only resolver. The ROM header's entry point
maps the boot segment and nothing else; a relocated code segment or an
overlay resolves to wrong bytes that still lie inside the image, so a bounds
check cannot save you. An overlay VA is AMBIGUOUS by construction: the
resolver returns the candidate segments and refuses to pick. Pass
`segment:'ovl_i8'`.

`disasm({target:'decompile', platform:'n64', project:'wr64', address:…})`
uses the same resolver, loads only that segment's bytes AT ITS TRUE VA (so
absolute calls, globals and jump tables resolve during analysis), returns
`provenance` (segment, ROM offset, loadedAt, bytes hash) and swaps in the
project's symbol names. Without `project` it falls back to the header formula and
says so in `provenance.warning`.

## What generate can and cannot know

m2c honours the prototype the TU declares. If the TU declares
`void f(f32*, u8*, u8*)` as a placeholder, the draft dereferences `u8*` as
a struct and the compare fails with "Selector requires struct/union"; the
result carries `contextPrototype.placeholderPointerTypes:true` and a hint.
Fix the prototype in the header, `generate` again (the context cache
invalidates on any header change).

`typeHypotheses` are guesses with offsets, not facts. `missingDeclarations`
are the symbols m2c had to invent. Keep both out of the source until the
compare says exact.

## Search honesty

A search job ends `complete-zero` (a zero-score candidate exists — confirm it
with `compare`, the permuter's score is not romdev's strict test),
`complete-budget` (time ran out; `best` is the closest candidate, not a
match), `cancelled`, or `failed`. Resume from a job's best with
`decomp({op:'search', resumeFrom:'<jobId>'})`. The permuter mutates C
syntactically; it will not invent a struct copy from three assignments.

## Progress

`progress` counts code bytes per object from the linker map: a function is
"asm" when its `.NON_MATCHING` twin symbol exists. Game code, libultra and
handwritten-asm subsegments are reported apart, data references apart, and
`builtRomMatchesBase:true` only says the mixed build is byte-exact, never
that the game is decompiled.

## Picking work, sharing types

`decomp({op:'plan'})` ranks the remaining asm functions by expected payoff
(bytes, discounted by what earlier attempts learned, boosted by typed C
neighbours) and groups functions that call each other inside one TU into
batches. `decomp({op:'batch', symbols:[…]})` runs generate → compare for a
batch under a time budget and names the shared blocker (usually a
placeholder prototype in one header). `decomp({op:'types'})` is the
accumulated evidence: offsets with the access widths the asm uses. None of
it is a confirmed type until it is in a header and the compare says exact.

## Runtime

- `decomp({op:'overlays', session})` says which overlay is resident at
  0x802C5800 by comparing RAM with every candidate's ROM bytes.
- `decomp({op:'symbolize', session, va})` resolves a live address through
  that; an address in the exception vectors is labelled as the interrupt
  handler, never as the main loop.
- `decomp({op:'state', session})` says whether the emulator is still there
  and, if not, why (`never-loaded`, `evicted`, `server-restart`) and how to
  recover (reload + replay the persisted input script).
- `decomp({op:'trace', session, symbol})` stops the CPU at the function's
  entry (a real PC break: parallel_n64 0.3.0 hooks the cached interpreter
  and yields to the frontend at the hit), reads a0-a3/f12/f14 and the stack
  arguments, then stops at the return address and reads v0/v1/f0. Every
  result carries the live core probe; on a core that cannot stop it says
  `PC_BREAK_UNSUPPORTED` with the evidence instead of inventing values.
- `decomp({op:'coverage', session, frames, inputs})` is instruction-exact:
  the core's PC log over the code window in short chunks, unioned, then
  attributed to functions and basic blocks (leaders from branch targets and
  delay slots). Observed / unobserved (has a static caller) / unreferenced
  (no static caller) are kept apart; `truncatedChunks` says when a chunk
  overflowed the core's distinct-PC cap (shorten `chunkFrames`).

## Types without hand recovery

`decomp({op:'types', propose:true})` turns the evidence into struct
typedefs (field types from the asm access widths, `s32*` where the draft
dereferences or indexes a field, byte arrays for gaps) plus a prototype
with the placeholder pointer parameters replaced. Pass the text to
`generate` as `extraContext` and to `compare` as `declarations`: the draft
is regenerated with those types and compiled with them, the TU's own
prototype rewritten in the work copy. The compare decides; a proposal is
never written to a header by the tool.

## Rodata

`compare` compares the function's own jump tables and literals by
reference order — against the target object when the extracted asm exists,
against the base ROM bytes at the object's `.rodata` VA when it does not.
A differing jump table or literal makes `verdict.functionLocal` mismatch and
`exactFunctionMatch` false even when the text is identical; `textExact`
keeps the text-only verdict. A rodata comparison that could not run is
`unknown`/`error`, never exact.

## Workspace

Everything durable lives in `~/.romdev/decomp/<project>/` (manifest,
contexts, targets, every candidate with its result JSON, jobs, patches).
Nothing is written into the checkout except by `integrate` with `apply:true`,
which restores the TU if the full ROM does not reproduce.
