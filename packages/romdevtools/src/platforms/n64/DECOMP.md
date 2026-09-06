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

## Addresses

The project's splat yaml is the only resolver. The ROM header's entry point
maps the boot segment and nothing else; a relocated code segment or an
overlay resolves to wrong bytes that still lie inside the image, so a bounds
check cannot save you. An overlay VA is AMBIGUOUS by construction: the
resolver returns the candidate segments and refuses to pick. Pass
`segment:'ovl_i8'`.

`disasm({target:'decompile', platform:'n64', project:'wr64', address:…})`
uses the same resolver, analyzes only that segment's bytes, returns
`provenance` (segment, ROM offset, bytes hash) and swaps in the project's
symbol names. Without `project` it falls back to the header formula and
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

## Workspace

Everything durable lives in `~/.romdev/decomp/<project>/` (manifest,
contexts, targets, every candidate with its result JSON, jobs, patches).
Nothing is written into the checkout except by `integrate` with `apply:true`,
which restores the TU if the full ROM does not reproduce.
