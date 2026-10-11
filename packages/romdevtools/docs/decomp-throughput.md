# Measured decompilation, bounded search and Z80 IR export

How to work a matching-decompilation residual with measured evidence, how to
keep permuter searches bounded, and how to export decoded SMS/GG instructions
for bulk analysis. Everything here goes through existing tools: `decomp`,
`disasm`, `frame` and `catalog`.

## Matching workflow

1. Compile a baseline with `decomp({op:'compare', project, symbol,
   candidatePath, detail:true})`. Require `measurementValidity.state:'valid'`.
   Missing evidence is unknown, not zero. Exactness and source quality are
   independent, and function exactness is not full-ROM verification.
2. Pass its `artifacts.diff` as `artifactId` to `diagnose`. A symbol-only
   diagnosis requires current evidence instead of silently picking a
   historical score.
3. Test a bounded `variants` batch with one specific hypothesis. Put the
   diagnosis experiment id in each variant's `lever`, such as
   `declaration-order`. The experiment store records the measured inputs and
   outcomes. A declaration permutation that did not improve is evidence about
   that exact input, not proof that every declaration order is exhausted.
4. Check `snapshotStable`, per-row input identities, failures and truncation.
   `instructionIdenticalTo` covers function instruction bytes and relocations;
   it does not establish identical rodata, whole objects or semantics.
5. For a persistent residue, run the workbench on the stored artifact:

```js
decomp({op:'workbench', project, symbol, artifactId,
        wbGroup:'object', wbCommand:'diagnose'})
decomp({op:'workbench', project, symbol, artifactId,
        wbGroup:'trace', wbCommand:'scheduler'})
```

The second call captures native IDO `-Wa,-R` output from the retained
compiled translation unit. The compiler and optimization flags are never
substituted. Invocation, trace hash, ordered instruction and relocation
identity and whole-object equality must all agree before the trace is used for
attribution; a trace that fails that check is reported as unavailable. Loose
external logs need their verified `.manifest.json` bundle. Scheduler evidence
does not explain allocator decisions. An artifact from before objects were
retained needs a fresh `compare` with `noCache:true`.

For allocator decisions, opt into the workbench's pinned IDO 5.3
instrumentation profile:

```js
decomp({op:'workbench', project, artifactId,
        wbGroup:'trace', wbCommand:'globalcolor', traceMode:'globalcolor',
        wbArgs:['--proc','19','--web','40']}) // ordinals must come from THIS build
```

This uses a diagnostic WASM IDO 5.3 in which only the uopt pass is replaced by
the trace profile. Build that module once with `scripts/build-ido-globalcolor.sh`
from a romdev source checkout; it never replaces the project's compiler. The
profile rejects unknown source hashes. Both the tracing-disabled and the
tracing-enabled objects must equal the original whole object. Forced colouring
is not enabled. Procedure ordinals are local to one run: retained Ucode gives
names, but do not reuse an ordinal from another translation unit or treat the
UGEN and UOPT namespaces as one mapping.

Large workbench reports are written to disk with a bounded inline projection.
`outputPath` chooses the destination and `detail:true` requests full inline
output. With `artifactId`, `wbArgs` accepts only paired report filters, not
replacement inputs.

`variants` takes `threads`: 1 by default, 2 at most. The baseline runs first
and results keep request order. Two workers cut batch wall time by about 30%
in one fixed-workload evaluation with identical per-input results; that is
throughput, not a better recovery rate. Use one worker on a busy machine.
Experiment updates are serialized across processes; a crashed writer's lock
produces an `EXPERIMENT_LOCKED` error naming the lock file. Confirm its owner
is no longer running before clearing the lock by hand.

`plan` temporarily lowers the rank of a target after repeated independent
no-progress batches on the same measured baseline. `ignoreCooldown:true`
allows deliberate work on a hard target, `proposedLever` allows a new lever,
and `cooldownBatches` / `cooldownMinutes` set the threshold and expiry. The
reasons stay visible and no target is excluded.

## Comparison rules

ROM-linked comparison resolves expression aliases and defined `PROVIDE`
symbols from GNU ld's evaluated address column; it does not evaluate linker
expressions itself. A relocation word that cannot be resolved stays unknown,
even when its unlinked placeholder happens to equal the ROM bytes. For a
partial comparison, `romLinked.mismatches` and `linkedMismatches` are `null`
and `romLinked.knownMismatches` is a lower bound. A known differing word
establishes a mismatch; unknown words never establish exactness.

Results from an older verifier version stay readable for diagnosis but need a
fresh comparison before they can drive selection or search preflight. A
resolved alias does not relax raw symbolic-relocation equality, so an alias can
have exact ROM-linked bytes while the strict local verdict stays nonexact.

Diagnosis checks small instruction permutations before register mappings. It
requires equal stream lengths and identical instructions and relocations, and
does not cross branch or jump boundaries. A hit shows reordered instructions;
it does not prove a particular source-level cause.

## Bounded search

```js
decomp({op:'search', project, symbol, candidatePath,
        purpose:'Test whether declaration ordering changes this register residue',
        family:'declaration-order', mutationPasses:['perm_reorder_decls'],
        seed:'73', threads:1, timeLimitS:30, noImprovementS:5})
```

- `purpose` is required: name the residual or hypothesis that justifies the
  budget.
- `mutationPasses` are validated against the installed decomp-permuter.
  Selecting passes sets every other randomization weight to zero; a `family`
  label alone does not constrain the backend.
- The baseline must compile with a valid identity. `preflight:false` is
  refused. Repeating an identical scope that already ended without progress
  needs `repeatSearch:true`.
- `noImprovementS` stops a run that has not improved for that many seconds.
  The watchdog is per process; after a server restart the total time budget
  still applies.
- A backend score of zero is never an integration verdict. A zero-scoring
  baseline that romdev's comparison calls nonexact is reported as a scorer
  blind spot. Cancelling keeps the artifacts and never integrates code.

`decomp({op:'job', project, jobId, action:'report', maxFunctions:12})`
rechecks a bounded number of saved outputs through the real comparison
pipeline. It reports verified saved outputs and residual improvements apart
from backend score improvements, and counts the outputs it did not check. The
backend does not publish every discarded compilation, so totals across all
backend compilations are reported as unknown.

## SMS/GG decoded IR

```js
disasm({target:'recompile', platform:'sms', path:'/abs/path/game.sms',
        emit:'ir', allOffsets:true, outputPath:'/abs/path/game.jsonl'})
```

The response is a small manifest. Each JSONL record holds the physical `off`,
the CPU `addr`, bank and slot, bytes, mnemonic, operands, length, cycles,
flags, control-flow edges and the lifted IR. Cycle counts come from the
bundled Genesis Plus GX tables, ordered taken-or-repeat then
not-taken-or-final. Unknown and data opcodes are marked explicitly. Linear
decoding does not establish reachability.

`fileOffset` selects physical ROM bytes; `startAddress` is a CPU address.
`allOffsets` walks the whole cartridge in 16KB banks: bank 0 at $0000, bank 1
at $4000 and later banks at $8000 unless `slot` overrides it. Absolute branch
and call operands are never rebased as file offsets, and no instruction is
decoded across a bank boundary without the adjacent mapped bank.

For static SMS/GG CPU windows, `mapper` accepts `sega`, `codemasters`,
`korean` (A000 16KB paging) and `korean-16k-v2` (4000/8000 paging).
`mapperState.pages` gives three 16KB physical page indices; `control` models
the Sega control byte and `ramEnabled` models Codemasters cartridge RAM. A ROM
request against mapped cartridge RAM fails. These options configure static
analysis only; the emulator detects supported mappers from its own database.

## Comparing an emulator run with a recompiled cart

Load the SMS ROM in slot A and the wasmcart in slot B with `loadMedia`. For
`frame({op:'findDiverge', ...})`, set `regionB:'linear_memory'`, `offsetA`,
`offsetB` and `compareLength` explicitly. WASM carts have no complete state
snapshot, so `restore:false` is required and both hosts advance. Equal idle
memory is inconclusive, and a bounded window matching for a bounded number of
frames is not whole-game equivalence or proof of identical timing.

`findDiverge` compares from wherever the two slots currently stand. Warm both
sides first, `frame({op:'step', frames:60})` for slot A and
`frame({op:'step', slot:'b', frames:60})` for slot B, so the search does not
start from a point where both trivially agree. If the slots already differ at
frame 0 the search returns without stepping, with `activity.framesStepped: 0`
and an `activity.activityNote`; the `changedFramesA/B` counts are then 0 by
construction. To check that a slot executes, step it alone and watch
`frameCount`.

`catalog({op:'status'})` reports `serverHealth.requestTelemetry`: per-session
completed-call counts, error rates, recent errors and error-storm warnings.
The counts reset when the server restarts.
