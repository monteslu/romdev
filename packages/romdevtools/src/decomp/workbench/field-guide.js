// field-guide.js - the verdict-to-lever index, the on-ramps each playbook
// owes its reader, and the compiler laws behind each owning pass. Pure data:
// a diagnosis prints the same footer on any machine.
//
// Plain JS ESM + JSDoc.

export const GUIDE_DOCUMENT = "docs/field-guide.md";

export const LAW_DOCUMENTS = {"ido53": ["docs/compiler-laws/ido-5.3.md", "IDO 5.3"], "ido71": ["docs/compiler-laws/ido-7.1.md", "IDO 7.1"]};

export const LAW_ERA_ALIASES = {"53": "ido53", "71": "ido71"};

export const LEVER_ACTIONS = {1: "audit the earliest immediate (lui/li/andi/ori/slti) against the target assembly, then re-derive every fake fitted to the old value", 2: "`a | b` and `b | a` canonicalize identically under cfe and `x |= b` is a distinct AST that flips the emitted order; under accom lineage `a + b` emits reversed operands, so commuting the source is free", 3: "rebuild the same candidate with -g0 and compare again; a collapse means .loc records constrain the -g3 schedule", 4: "re-check flag and ctx.c parity against the project's real preset before believing a structural residual", 5: "do not split loops or duplicate bodies to force a memory re-read; IDO's own loop-invariant motion wins (+147 words measured)", 6: "census the stack offsets on both sides and work the one value that gained a home, not the N shifted offsets", 7: "add `if (gSomeGlobal) {}` for a code-free web that takes the NEXT FREE pool slot; it cannot reach past a live web", 8: "when a plain `if (var) {}` is inert, dead-read an rvalue expression instead; intermediate values can take v0 where locals cannot", 9: "stack a second read of the losing web: uopt orders webs by accumulated benefit, so read count is a monotone priority dial", 10: "split a local's own update chain with `if (!x);` to form a short web from the intermediate value, at zero instructions and zero frame", 11: "promote the value to a named local spanning the loop (pool) or inline the expression (temp); no color force crosses that line", 12: "try `tab * 4` instead of `tab << 2` when a scaled index is near the divergence: one cheap variant, low confidence", 13: "mask into the formal parameter in place (`id &= 0xFFFF`) so the CSE web never forms; this is the delete-a-web lever", 14: "hoist a call-argument expression into a named local in the block BEFORE the divergence; that reorders the value deaths", 15: "materialize a phantom pop with `(state == -1) != 0` inside a real `if`; a bare discarded expression is dropped instead", 16: "add a redundant assembler-folded mask (`((s16)fx & 0x3fff) << 18`) for a genuinely free FIFO rotation", 17: "only with a copy-shaped residue OR check-scratch's measured late v0/v1 call-return occupancy hypothesis: test one explicit `int`/K&R return-category variant at the declaration and definition", 18: "only when the residue contains a move/copy: give a genuinely repeated expression a named intermediate so the coalesced copy lands on the other value; trace-copy-decisions names the first changing pass, but hash occupancy does not prove source repetition", 19: "the callee-saved tie-break is a uopt ordering decision: force the smallest measured causal web set (often one, sometimes a staggered blocker ladder), inspect every cascade, and compare paired formation, save/totalsave, and decision-trace order; no one scalar is priority proof", 20: "before concluding 'hand-patched object', fingerprint the other authentic frontends (accom/ccom, upas) feeding the same backend", 21: "under accom lineage source line numbers are semantic: bisect whitespace around the mis-scheduled instruction, not the expressions", 22: "classify the dispatch construct first (source order is never a switch) before spending variants on the wrong one", 23: "preprocess the TU with IDO's acpp using the project's exact defines and include paths, then compile the .i with the project's exact flags: uopt/ugen honor statement line boundaries even at -g0", 24: "run `decomp-workbench context lint` over the translation unit: an #if/#elif whose identifiers are ALL undefined evaluates a constant no one intended (0 >= 0 is true) -- define the macro, include its header, or delete the stale guard", 25: "cfe numbers statements by LOGICAL line, so ties are free: splice the block and the statement after it onto one line (trailing `\\`, or one physical line) to give that statement a line number from inside the block, and pair it with a legal statement hoist", 26: "when registers/opcodes are exact but the frame is not, preserve the winning live-range topology; first compare observed save-slot bytes with non-save frame bytes, then ablate, narrow, or reuse phantom homes only in the component that actually differs -- and move temp offsets with a split local (a pad slot), not by deleting one", 27: "after exactness, inventory suspicious constructs, compose bounded cross-family substitutions, retain every exact candidate, and gate the winner on translation-unit collateral plus project verification", 28: "when the callee-saved register is taken rather than underpriced, stop reweighting and alias the memory half of the pair (`if (&local);`): zero instructions, the local leaves web candidacy, and the slot frees -- sweep the mark's placement innermost-first (140/131/106 words on one function) and check candidate_frame_size on every variant", 29: "when one web wants the neighbouring argument register, stop pricing it and make the wrong register illegal: give the value a live range across a call that pins that register, which seeds the web's forbidden set from the hard-register conflict vector -- zero instructions, and the forbid follows the whole web, so split the roles onto two symbols if one carrier holds two", 30: "spell a value-position `a && b` the way cfe expands it -- `v = (a); if (v) { v = (b); }` -- which is byte-identical to the operator, where `v = 0; if (a && b) v = 1;`, if/else and branch-free forms cost hundreds of rows", 31: "buy a registerizable local out of an array whose base alone is addressed: shrink the array and declare the new local so the base keeps its offset, and every other home, the block length and the frame stay exactly as they were", 32: "when the residue is one repeated stack-home addend against a compiler temp's slot, empty cfe's expression-temp pool: it is one value-numbered symbol that re-mints, so enumerate its materialisation classes (call-as-non-final-argument, `&&` as a value, ternaries) and kill them in one build, and spend what it releases on a local", 33: "fold the two statements onto one physical line so their instructions tie on `lineno` and ready-list position decides -- as1's scheduler reads source line numbers, and `cc -Wa,-R` prints the selection records byte-inert", 34: "IDO 7.1: one register wrong on a fallthrough after a copy is as1's peep_reg -- write `if (x && x && x);` before the dispatch, because ugen erases one and two conditional branch-to-nexts and four is catastrophic, but the third survives to kill the copy fact and is then deleted at zero instruction cost", 35: "IDO 7.1: `if (c) goto high; goto low; high:;` makes the goto TARGET the fallthrough and inverts the branch -- that parity decides which dispatch block inherits as1's copy facts; polarity spellings (`>= N`, `> N-1`, `!(x < N)`) are byte-identical, so do not sweep them", 36: "IDO 7.1: when a zero-code barrier flips the range branch's sense and swaps the dispatch clusters, put the SAME statement on the opposing arm; the ballast restores parity and keeps the register heal, and one/two/three copies are byte-identical", 37: "IDO 7.1: jump-table bodies packed behind their own table are uopt's `num + 1` depth-first order -- nest the second switch inside the first one's body and enter it by `goto`; cheaper first tries are an empty `if (x);` on the FIRST case trampoline or on an explicit `default: goto low;` (one or two references, never three)", 38: "IDO 7.1: an exact allocation with stack homes off by a constant is a selector-temp residual, not a colouring one -- write `switch (x ? x : x)`, which moved two temp homes 4 bytes inside an unchanged frame with identical instructions, opcodes and registers", 39: "IDO 7.1: read count is arithmetic, not a search -- priority = save/units with units quantized from raw = refs + cardbits, +10 save per ref with no branch-nesting discount, +1 cardbit per spanning statement, and an empty-body `if` folds AFTER compute_save; three refs in ONE statement is the step, four collapses codegen", 40: "de-declare a value so it takes a compiler-temp home: the frame is [declared locals][cfe temps][uopt temps] and reordering declarations only permutes slots inside the first region, so a value the target homes among the temps can never be reached by declaration order", 41: "buy or sell a ring pop with a construct that costs one; levers 15 and 16 buy a pop with a mask, and three ordinary-code constructs move the same counter when a mask is not available", 42: "join an initialiser to the loop header's physical line: a loop-invariant hoisted into the preheader is stamped with the loop header's line, not its use site's, which is the recurring case behind an initialiser/loop-invariant line-order conflict", 43: "read the proof before re-deriving it: four residual classes are closed by recorded rulings, each of which cost a day and a dozen builds; they are levers in the sense that matters most, telling you what not to spend", 44: "read the pool lanes' lengths before calling a residual a rotation: equal lengths are the precondition for a rotation, unequal lengths are a population difference and no colour reaches a web that does not exist", 45: "where the target loads a field into a scratch register and copies it into a saved one, spell the later use as the field access again: uopt commons it but keeps two live carriers and emits the copy, which a single cached local never produces", 46: "count the declared locals before reading the frame as an allocation defect: the list's length sizes the local block in 8-byte steps and its order fixes every home at frame_top - 4k, so census the target's displacements and order the declarations to match", 47: "screen the per-TU compiler flag off the target's own codegen signature before searching the flag lattice by compiling, then decide it by measurement: a signature that appears in every unit cannot discriminate, and half of one such screen's predictions were wrong", 48: "cross-check a positional differing-word score against a shift-tolerant identical-row count before believing it: one insertion renumbers every row after it, so the positional metric reads a pure alignment shift as hundreds of words and can invert the true ordering of two candidates or two flag sets", 51: "replace a hand-written pointer cursor with an index over the parallel arrays: the emitted cursors are uopt's own strength-reduced induction variables, and while the source spells them out no ordering, grouping or declaration lattice can reach the register names they produce", 50: "resolve both sides' address materializations to linked addresses before scoring: splat spells an address as a literal hi/lo pair whenever it minted no symbol or the halves straddle a branch, that form carries no ELF relocation, and a comparator masking only relocations reports the difference as a real residual", 49: "capture ugen's textual output with -l and re-assemble it under the compiler path's own as1 flags: the round trip is byte-exact, which makes the assembler phase directly searchable and settles whether a residual is reachable from C at all"};

export const PLAYBOOK_LEVERS = {"register-role-audit": [], "constant-audit": [1], "ast-shape": [2], "g0-schedule-probe": [3, 4, 23, 24], "line-assignment-probe": [23, 25, 33, 4], "structure-buckets": [1, 4, 24, 5, 6], "temp-fifo-phase": [14, 15, 16], "pool-position": [39, 7, 8, 9, 10, 11, 12, 13, 28, 29, 30], "forced-color-oracle": [17, 18, 19], "stack-frame-recovery": [26, 31, 32, 38], "copy-propagation-barrier": [34, 35, 36, 38], "dispatch-layout": [37, 35, 36, 34], "post-match-cleanup": [27], "frontend-lineage": [20, 22, 21]};

export const VERDICT_PLAYBOOKS = {"allocation": "pool-position", "commutative-order": "ast-shape", "constant": "constant-audit", "frame-layout": "stack-frame-recovery", "phase-shift": "temp-fifo-phase", "register-permutation": "forced-color-oracle", "schedule": "g0-schedule-probe", "structure": "structure-buckets", "words-identical": "relocation-only", "allocation-mismatch": "pool-position", "constant-mismatch": "constant-audit", "frame-layout-mismatch": "stack-frame-recovery", "operand-mismatch": "constant-audit", "relocation-layout-mismatch": "relocation-only", "schedule-mismatch": "g0-schedule-probe", "structure-mismatch": "structure-buckets", "unknown-relocation": "relocation-only"};

export const PLAYBOOK_ONRAMPS = {"register-role-audit": ["read the capability/role distinction: decomp-workbench guide register-role-audit", "separate possible colors, per-procedure reservations, and actual temporary returns before choosing a register lever; t0-t5 can serve either role under IDO 5.3, not both at an inferred fixed boundary.", "a rotation of visible registers does not establish a changed demand order or one extra pop. Compare independently authenticated reservation state first; identical demands can emit different registers when the available pool changes.", "trace-fifo --registers/--initial is a conditional replay: a subset of observed returns is not proof of the complete available pool. Preserve excluded events and unknown target state; do not manufacture a target trace from the candidate or prescribe a buy/sell-pop edit from this view."], "constant-audit": ["see every differing immediate side by side: decomp-workbench diagnose TARGET.o CANDIDATE.o --show-diff"], "structure-buckets": ["bucket the hunks before choosing one: decomp-workbench view TARGET.o CANDIDATE.o --show-all"], "g0-schedule-probe": ["have a calibrated toolchain? docs/pass-replay.md, then decomp-workbench replay-as1 LISTING.s OUT.o --as0-command ... --as1-command ... tests whether as1 owns the ordering.", "don't have one? the -g0 rebuild is levers 3 and 4 and needs only your normal compiler; run it before anything else.", "already building -g0, so the probe has nothing to collapse? that is lever 23: statement line boundaries constrain uopt/ugen at -g0 too. decomp-workbench diagnose ... --candidate-listing LISTING.s measures it before you spend a build, and decomp-workbench probe-lines proves ownership with one token-identical variant plus a control."], "line-assignment-probe": ["no acpp in your toolchain? reflow the divergent statements onto their own source lines - token-identical, newlines only - and rebuild; same experiment, coarser dial.", "have IDO's acpp? follow docs/line-assignment-probe.md's array-safe recipe with the translation unit's exact defines, includes, and compiler flags, then diagnose again against the new listing.", "measure it instead of guessing: decomp-workbench probe-lines UNIT.i --compile-command '... {input} -o {output}' --target-object TARGET.o compiles that reflow and a mandatory control, and scores both against the target.", "already know line assignment owns it, and need to know WHICH line a statement wants? probe-lines ... --tie STATEMENT=LINE (repeatable) scores that one reassignment toward and away from the target.", "swept the line numbers and the one you need is unreachable one statement per line? that is lever 25: cfe numbers by LOGICAL line, so splicing a block onto the next statement (trailing `\\`) ties them to one number - and the plateau you measured is scoped to the statement order you swept."], "temp-fifo-phase": ["don't have an instrumented toolchain? levers 14-16 are pure source and are the first move; the lane rotation above already locates the preceding block to perturb.", "given independently established available-pool membership, the register at a site follows the alloc/free event sequence before it (ugen pops the head of a per-class free list and frees to its tail - a least-recently-freed ring, re-seeded once per procedure). So do not chase the phase: chase the CLASS-CROSSING sites, where one side leaves as a ugen temp what the other colored. Each one re-phases everything downstream.", "score on the site count, not on raw words: partial closure is not monotone (a recorded run went 1416 -> 1413 -> 1445 -> 1477 -> 572 as sites closed). Confirm on words only at full closure.", "which registers are available temps also depends on per-procedure reservations. Under IDO 5.3 -O2 -mips2, t0-t5 are possible UOPT colors and possible UGEN temps; other releases are unverified. decomp-workbench guide temp-fifo-phase carries the table.", "the float ring is FOUR wide. ugen's ffree initializer also lists f16/f18, but both are withdrawn before the first allocation and never handed out (1460/1460 measured in f4-f10); they are uopt colors. A float-site metric that counts them as temps reports closures that are really coloring changes.", "have one, and those levers are spent? decomp-workbench trace-fifo TRACE.log replays the pool get/put schedule."], "pool-position": ["don't have an instrumented toolchain? levers 7-13 are all source-only and are the first move; read lever 9 before building any search - it is a dial, not a permutation.", "reweighted everything and the value still loses the register? the register may be TAKEN rather than underpriced - a `decision=split` with `regsleft` exhausted, or a `force_declined` on a callee-saved color. That is lever 28: alias the memory half (`if (&local);`) so the local leaves web candidacy and frees the slot.", "have one, and those levers are spent? docs/compiler-instrumentation.md, then decomp-workbench instrument-uopt-globalcolor and decomp-workbench trace-globalcolor TRACE.log --proc N."], "forced-color-oracle": ["have an instrumented toolchain? docs/compiler-instrumentation.md, then decomp-workbench diagnose ... --emit-force-spec force.json and decomp-workbench oracle plan TRACE.log to build the two-phase grid.", "a one-bijection assembly residue is one downstream outcome, not proof of one source web; use forbidden-color producers to count the blockers.", "don't have one? first inspect the residue for an actual move/copy site, or run check-scratch --view with a project object to test the strict late v0/v1 call-return occupancy shape. If either gate fires, lever 17 is one variant; lever 18 still requires a visible copy and repeated source expression. Otherwise go directly to lever 19; a clean forced-color cascade is a legitimate stopping point for HAND search - and hand search is not the whole search: run permute-doctor and a sweep before recording a wall, then bundle the scratch and take the next function.", "when source variants plateau, use campaign --show-basins; hundreds of spellings collapsing to a few objects is a negative result, not a reason to keep permuting declarations."], "stack-frame-recovery": ["compare the allocator-exact candidate against one-local ablations; keep both normalized residue and candidate_frame_size in the ledger.", "if narrower and register-qualified types plateau, reuse existing locals or split one source local into staggered webs at the same CFG boundaries instead of adding another stack home."], "post-match-cleanup": ["start with decomp-workbench experiment inspect-source exact.c; its findings are syntactic candidates, not declarations of dead code.", "encode related deletions/substitutions as one mechanism each, then use experiment compose with an explicit order and candidate cap.", "compile with --no-stop-on-exact and finish with object collateral; a function-only zero can still add BSS or linker metadata."], "relocation-only": ["prove the spellings are linked-address equivalent: decomp-workbench relocation-aliases TARGET.o CANDIDATE.o"], "copy-propagation-barrier": ["these levers are IDO 7.1 only - the same Binasm through 5.3's as1 produces a 321-word object, so do not port them to a 5.3 project.", "prove it at the phase boundary first: decomp-workbench pass binasm on the captured ugen-to-as1 stream shows whether your copy fact reaches the divergent block at all, and as1's own -peepdbg prints the rewrite (`Peepreg (INST n) changed rs A => B`, n is BLOCK-local).", "the mechanism is update_ctnt: a content fact reaches the next block only through a single-predecessor fallthrough, and is then filtered against the taken target's live-in mask. Three ways to win - put the alias source in that mask, redefine it before the use, or fail the single-predecessor gate. decomp-workbench guide laws ido71 L2.", "score candidates on their pre-as1 Binasm, not on the object: as1 mutates its content state BEFORE it deletes redundant code, so the instruction you need may be invisible in the final text."], "dispatch-layout": ["these levers are IDO 7.1 only, and they are layout: run decomp-workbench align first - `words` over-charges a moved block (1,791 words for a one-block edit script, measured), so rank permutation candidates on the edit script, never on the scalar.", "the predicate is uopt's depth_first_order: it always takes the successor whose original lexical number is node->num + 1. Placement follows that literally - 'first' and 'middle' move the layout, 'last' is inert. decomp-workbench guide laws ido71 L8.", "prove levers in isolation and compose late: on the function these came from, the layout alone was 9 words, the layout plus an unballasted barrier 13, the selector without the ballast 5, the ballast without the selector 8 - and all four together 0. A lever that does not improve the score is a component, not a refutation."], "frontend-lineage": ["fingerprint the frontends before porting anything: docs/alternate-frontends.md, then decomp-workbench fingerprint-toolchain to compare the microcases.", "this family is reached by evidence, not by a verdict - a dispatch shape the project compiler cannot emit, or a residual hundreds of spellings never move."]};

export const PLAYBOOK_CAVEATS = {"pool-position": "This is one of three unresolved allocation families - temp-FIFO phase, pool position, or coalescing. `view`'s footer says which one the lanes support; the levers below cover the pool family, and levers 14-16 and 17-18 cover the other two."};

export const AMBIGUOUS_PLAYBOOK_FAMILIES = {"pool-position": [["temp-fifo-phase", "temp-FIFO phase - ugen's block-local queue"], ["pool-position", "pool position - uopt's coloring order"], ["forced-color-oracle", "coalescing and callee-saved tie-breaks"]]};

export const AMBIGUOUS_ONRAMPS = ["don't have an instrumented toolchain? inspect `view` first, but it may leave the family unresolved. A source-only edit still needs evidence that its mechanism applies; do not try every family by default.", "have one? use it when the missing ownership evidence requires it: docs/compiler-instrumentation.md, then decomp-workbench instrument-uopt-globalcolor and decomp-workbench trace-globalcolor TRACE.log --proc N.", "the trace shows your web `decision=split` with `regsleft` exhausted, or a `force_declined` on a callee-saved color? then the register is taken, not underpriced, and no reweighting lever can win it: decomp-workbench guide 28."];

export const COARSE_ALLOCATION_LEAD_IN = "(compare cannot see which of the three it is - run `view` first to inspect the pattern; ownership may remain unresolved before spending a variant.)";

export const PASS_LAWS = {"cfe-spelling": [["ido53", "L75", "at a pointer add, commutations, casts and assignment forms are exhausted and the byte-offset rewrite that does move the temp order is already spent"], ["ido53", "L67", "a comparison prints its copy-propagated variable first, so operand order is a readout of the carrier and not a lever"], ["ido53", "L68", "a compiler-owned jump table's bytes are the case mapping; matching .text is not evidence that the mapping is right"]], "rodata-load-form": [["ido53", "L62", "a float scalar takes the rodata lwc1 form iff its low halfword is non-zero, and only that form joins the invariant-load group"]], "stack-home-assignment": [["ido53", "L63", "declared locals take descending stack homes in declaration order, so a declaration reorder places a call-crossing spill"], ["ido53", "L72", "the declared block rounds to 8, so a declaration can be free: read the frame, do not count the declarations"], ["ido53", "L73", "a home below the declared block is reached by de-declaring the value, never by reordering -- reordering stays inside a region"]], "uopt-globalcolor": [["ido53", "L83", "p2 visits webs in ascending web number and ignores the save, so nothing that changes a use count or loop depth moves a web there -- which is what it orders on, not that a rotation is reachable"], ["ido53", "L84", "p1 takes the largest save each round and reads the web number only inside a tie group, so a rotation across a save boundary needs the cost changed instead"], ["ido53", "L85", "a truncation written at the store, not as an expression cast, numbers its synthetic temp one place later -- confirm it with a second capture, not with the diff"], ["ido53", "L81", "an address fold follows what is live where the value is formed, not where the defining statement is written"], ["ido53", "L66", "a web feeding a call argument inherits that argument register at cost 0, so a redundant-looking re-cache is what rides it"]], "ugen-temp-ring": [["ido53", "L64", "the integer ring is seeded t6 t7 t8 t9 t0..t5, so a one-pop phase error rotates by that order and not by register number"], ["ido53", "L65", "a folded redundant mask emits no instruction and still pops the ring once -- the phantom pop, and it works in both directions"], ["ido53", "L76", "a struct field read through a local costs one ring pop that a direct read does not, and emits the same instructions"], ["ido53", "L77", "an index scaled twice burns an invisible temp: one more pop than the same access scaled once, at no visible cost"]], "g0-scheduler": [["ido53", "L70", "measure on the project path, never on an isolated cc -c: the same source compiled 56 instructions one way and 58 the other"], ["ido53", "L79", "lineno is the last key in as1's chain, so a selection decided above it is decided by readiness and no placement reaches it"], ["ido53", "L80", "a loop-invariant hoist carries the loop header's line, so the lever is to join the initialiser to that physical line"]]};

export const PLAYBOOK_PASSES = {"ast-shape": ["cfe-spelling"], "constant-audit": ["cfe-spelling", "rodata-load-form"], "g0-schedule-probe": ["g0-scheduler", "rodata-load-form"], "line-assignment-probe": ["g0-scheduler"], "structure-buckets": ["cfe-spelling"], "temp-fifo-phase": ["ugen-temp-ring"], "pool-position": ["uopt-globalcolor"], "forced-color-oracle": ["uopt-globalcolor"], "stack-frame-recovery": ["stack-home-assignment"]};

/** One footer line pointing a residual at the law under it. */
export function lawCitation(era, law, summary) {
  return `law ${law}: ${summary} -- decomp-workbench guide laws ${era} ${law}`;
}

/** The law citations one owning pass owes its reader. */
export function passLawSteps(owningPass) {
  return (PASS_LAWS[owningPass] ?? []).map(([era, law, summary]) => lawCitation(era, law, summary));
}

/** The law citations for every pass one lever family aims at. */
export function playbookLawSteps(playbook) {
  const seen = [];
  for (const owner of PLAYBOOK_PASSES[playbook] ?? []) {
    for (const line of passLawSteps(owner)) if (!seen.includes(line)) seen.push(line);
  }
  return seen;
}

/**
 * The on-ramp lines appended to one verdict's guidance.
 * @param {string} playbook
 * @param {{lead_in?: string[]}} [opts]
 */
export function nextSteps(playbook, { lead_in = [] } = {}) {
  const lines = [...lead_in];
  const families = Object.prototype.hasOwnProperty.call(AMBIGUOUS_PLAYBOOK_FAMILIES, playbook) ? AMBIGUOUS_PLAYBOOK_FAMILIES[playbook] : undefined;
  if (families !== undefined) {
    lines.push("field guide: this residual is one of three allocation families and this verdict cannot choose between them:");
    for (const [name, label] of families) lines.push(`  ${label}: decomp-workbench guide ${name}`);
    lines.push(...AMBIGUOUS_ONRAMPS);
    return lines;
  }
  const levers = Object.prototype.hasOwnProperty.call(PLAYBOOK_LEVERS, playbook) ? PLAYBOOK_LEVERS[playbook] : [];
  if (levers.length) {
    lines.push(`field guide levers for playbook=${playbook}:`);
    for (const n of levers) lines.push(`  lever ${n}: ${LEVER_ACTIONS[n]}`);
    lines.push(`read them: decomp-workbench guide ${playbook}`);
  }
  lines.push(...(Object.prototype.hasOwnProperty.call(PLAYBOOK_ONRAMPS, playbook) ? PLAYBOOK_ONRAMPS[playbook] : []));
  return lines;
}

// ---------------------------------------------------------------------------
// The documents themselves: the field guide's numbered levers and the
// era-scoped compiler-laws pages, read from the copies shipped under data/.
// ---------------------------------------------------------------------------

import { readFileSync as _readFileSync } from "node:fs";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { FileNotFoundError as _FileNotFoundError } from "./py-extra.js";
import { ValueError as _ValueError, strRepr as _strRepr, splitlines as _splitlines, strip as _strip, sorted as _sorted } from "./py.js";

/** Where the guide lives inside this package. */
export const PACKAGED_GUIDE = ["docs", "field-guide.md"];

function _dataText(relative) {
  return _readFileSync(_fileURLToPath(new URL(`./data/${relative}`, import.meta.url)), "utf8");
}

/** One numbered lever, with the family heading it sits under. */
export class GuideSection {
  constructor({ number, title, family, lines }) { Object.assign(this, { number, title, family, lines }); Object.freeze(this); }
}

/** A resolved `guide` argument: what the reader asked for, and which levers. */
export class Topic {
  constructor({ name, kind, levers, playbook }) { Object.assign(this, { name, kind, levers, playbook }); Object.freeze(this); }
}

/** One numbered law, with the pass heading it sits under. */
export class Law {
  constructor({ name, title, section, lines }) { Object.assign(this, { name, title, section, lines }); Object.freeze(this); }
}

export const SECTION_RE = /^###\s+(\d+)\.\s+(.+?)\s*$/;
export const FAMILY_RE = /^##\s+(.+?)\s*$/;
export const LAW_HEADING_RE = /^###\s+(L\d+)\.\s+(.+?)\s*$/;

/** The era tokens `guide laws` accepts. */
export function lawEras() { return _sorted(Object.keys(LAW_DOCUMENTS)); }

/** The canonical era token for one of its spellings. */
export function normalizeEra(era) {
  const token = [..._strip(era).toLowerCase()].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("");
  return Object.prototype.hasOwnProperty.call(LAW_ERA_ALIASES, token) ? LAW_ERA_ALIASES[token] : token;
}

/** One era's compiler-laws document. */
export function readLaws(era) {
  const token = normalizeEra(era);
  const entry = Object.prototype.hasOwnProperty.call(LAW_DOCUMENTS, token) ? LAW_DOCUMENTS[token] : undefined;
  if (entry === undefined) throw new _ValueError(`unknown compiler era ${_strRepr(era)}; this package carries laws for: ${lawEras().join(", ")}`);
  const [document] = entry;
  try { return _dataText(document); } catch {
    throw new _FileNotFoundError(`the ${token} compiler-laws document is not installed with this package (${document}); read it at ${document} in a checkout, or at https://github.com/akratch/n64-decomp-workbench/blob/main/${document}`);
  }
}

/** The canonical `Ln` spelling for one of its spellings. */
export function normalizeLaw(law) {
  let token = _strip(law).toLowerCase();
  if (token.startsWith("law")) token = token.slice(3);
  token = _strip(token);
  if (token.startsWith("l")) token = token.slice(1);
  return /^\d+$/.test(token) ? `L${token}` : _strip(law);
}

function _splitDocument(text, headingRe, make) {
  const found = new Map();
  let section = "", name = null, title = "", body = [];
  const flush = () => {
    if (name === null) return;
    const kept = [...body];
    while (kept.length && ["", "---"].includes(_strip(kept[kept.length - 1]))) kept.pop();
    found.set(name, make(name, title, section, kept));
  };
  for (const line of _splitlines(text)) {
    const heading = headingRe.exec(line);
    if (heading) { flush(); name = heading[1]; title = heading[2]; body = [line]; continue; }
    const family = FAMILY_RE.exec(line);
    if (family) { flush(); name = null; body = []; section = family[1]; continue; }
    if (name !== null) body.push(line);
  }
  flush();
  return found;
}

/** Split a laws document into its `### Ln. Title` sections (Map keyed by Ln). */
export function parseLaws(text) {
  return _splitDocument(text, LAW_HEADING_RE, (name, title, section, lines) => new Law({ name, title, section, lines }));
}

export function laws(era) { return parseLaws(readLaws(era)); }

/** One law of one era; an unknown number names the range that exists. */
export function readLaw(era, law) {
  const available = laws(era);
  const name = normalizeLaw(law);
  const found = available.get(name);
  if (found === undefined) {
    const numbers = [...available.keys()].map((k) => parseInt(k.slice(1), 10)).sort((a, b) => a - b);
    const span = numbers.length ? `L${numbers[0]}-L${numbers[numbers.length - 1]}` : "none";
    throw new _ValueError(`unknown law ${_strRepr(law)} for era ${normalizeEra(era)}; that page carries ${span}`);
  }
  return found;
}

/** The printable form of one law, with its address and its page. */
export function renderLaw(era, law) {
  const [document, label] = LAW_DOCUMENTS[normalizeEra(era)];
  return [
    `COMPILER LAWS  ${label}  ${law.name}`,
    `source: ${document}` + (law.section ? `  [${law.section}]` : ""),
    "",
    ...law.lines,
    "", "-".repeat(72), "", "NEXT",
    `  the whole page: decomp-workbench guide laws ${normalizeEra(era)}`,
    "  what to change about it: decomp-workbench guide",
  ];
}

/** The listing printed by `guide laws` with no era. */
export function lawIndexLines() {
  const lines = ["Compiler laws: what the compiler does, as opposed to what to do about it.", "", "eras"];
  const width = Math.max(...Object.keys(LAW_DOCUMENTS).map((t) => t.length));
  for (const token of _sorted(Object.keys(LAW_DOCUMENTS))) {
    const [document, label] = LAW_DOCUMENTS[token];
    lines.push(`  ${token.padEnd(width)}  ${label}  (${document})`);
  }
  lines.push("", "Example: decomp-workbench guide laws ido53", "One law: decomp-workbench guide laws ido53 L64", "Levers, as opposed to mechanism: decomp-workbench guide");
  return lines;
}

/** The packaged field-guide Markdown. */
export function readFieldGuide() {
  try { return _dataText(PACKAGED_GUIDE.join("/")); } catch {
    throw new _FileNotFoundError(`the field guide is not installed with this package (${PACKAGED_GUIDE.join("/")}); read it at ${GUIDE_DOCUMENT} in a checkout, or at https://github.com/akratch/n64-decomp-workbench/blob/main/${GUIDE_DOCUMENT}`);
  }
}

/** Split the guide into its `### N. Title` sections (Map keyed by number). */
export function parseSections(text) {
  const byName = _splitDocument(text, SECTION_RE, (name, title, family, lines) => new GuideSection({ number: parseInt(name, 10), title, family, lines }));
  return new Map([...byName.values()].map((s) => [s.number, s]));
}

/** The document reader, replaceable by tests that simulate a stripped install. */
export const guideSeams = { readFieldGuide };

/** The parsed shipped guide, keyed by lever number. */
export function sections() { return parseSections(guideSeams.readFieldGuide()); }

const _leverNumbers = () => Object.keys(LEVER_ACTIONS).map(Number).sort((a, b) => a - b);

/** Every accepted topic, in the order the index prints them. */
export function topicNames() {
  return [
    ...Object.keys(PLAYBOOK_LEVERS),
    ...Object.keys(PLAYBOOK_ONRAMPS).filter((n) => !Object.prototype.hasOwnProperty.call(PLAYBOOK_LEVERS, n)),
    ..._sorted(Object.keys(VERDICT_PLAYBOOKS)),
    ..._leverNumbers().map(String),
  ];
}

/** Resolve a playbook name, a verdict, or a lever number to its levers. */
export function resolveTopic(topic) {
  const name = _strip(topic);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  if (/^\d+$/.test(name)) {
    const number = parseInt(name, 10);
    if (!has(LEVER_ACTIONS, number)) throw new _ValueError(`unknown lever ${name}; the guide numbers ${_leverNumbers().join(", ")}`);
    return new Topic({ name, kind: "lever", levers: [number], playbook: null });
  }
  if (has(PLAYBOOK_LEVERS, name)) return new Topic({ name, kind: "playbook", levers: PLAYBOOK_LEVERS[name], playbook: name });
  if (has(PLAYBOOK_ONRAMPS, name)) return new Topic({ name, kind: "playbook", levers: [], playbook: name });
  if (has(VERDICT_PLAYBOOKS, name)) {
    const playbook = VERDICT_PLAYBOOKS[name];
    return new Topic({ name, kind: "verdict", levers: has(PLAYBOOK_LEVERS, playbook) ? PLAYBOOK_LEVERS[playbook] : [], playbook });
  }
  throw new _ValueError(`unknown guide topic ${_strRepr(topic)}; run \`decomp-workbench guide\` for the topic index`);
}

/** The `guide` listing, which never needs the document. */
export function topicIndexLines() {
  const lines = [`Field guide topics (${GUIDE_DOCUMENT})`, "Pass a playbook, a verdict, or a lever number.", "", "playbooks"];
  const width = Math.max(...Object.keys(PLAYBOOK_LEVERS).map((n) => n.length));
  for (const [playbook, levers] of Object.entries(PLAYBOOK_LEVERS)) lines.push(`  ${playbook.padEnd(width)}  levers ${levers.join(", ")}`);
  lines.push("", "verdicts");
  const vw = Math.max(...Object.keys(VERDICT_PLAYBOOKS).map((n) => n.length));
  for (const verdict of _sorted(Object.keys(VERDICT_PLAYBOOKS))) lines.push(`  ${verdict.padEnd(vw)}  ${VERDICT_PLAYBOOKS[verdict]}`);
  lines.push("", "levers");
  for (const number of _leverNumbers()) lines.push(`  ${String(number).padStart(2)}  ${LEVER_ACTIONS[number]}`);
  lines.push("", "Example: decomp-workbench guide forced-color-oracle", "Worked end to end: docs/from-verdict-to-edit.md",
    `Compiler mechanism, not levers: decomp-workbench guide laws (${lawEras().join(", ")})`);
  return lines;
}

/** One lever, degrading to its one-liner when the section is absent. */
export function leverLines(number, available) {
  const section = available.get(number);
  if (section === undefined) {
    return [`### ${number}. (not in the shipped field guide)`, "", LEVER_ACTIONS[number], "",
      `This lever's section is not in this installation's ${GUIDE_DOCUMENT}, which is older than this command. The one-line action above is complete on its own.`];
  }
  return [`[${section.family}]`, ...section.lines];
}

/** Every section a topic maps to, plus the on-ramp for its playbook. */
export function renderTopic(topic, available) {
  const numbers = topic.levers.join(", ");
  let header = `FIELD GUIDE  ${topic.kind}=${topic.name}`;
  if (topic.playbook !== null && topic.kind === "verdict") header += `  playbook=${topic.playbook}`;
  if (numbers) header += `  levers ${numbers}`;
  const lines = [header, `source: ${GUIDE_DOCUMENT}`];
  const caveat = PLAYBOOK_CAVEATS[topic.playbook ?? ""];
  if (caveat !== undefined) lines.push("", caveat);
  for (const number of topic.levers) {
    lines.push("", "-".repeat(72), "");
    lines.push(...leverLines(number, available));
  }
  const footer = [];
  if (topic.playbook !== null) footer.push(...(PLAYBOOK_ONRAMPS[topic.playbook] ?? []));
  else {
    const want = new Set(topic.levers);
    for (const [playbook, levers] of Object.entries(PLAYBOOK_LEVERS)) {
      if (levers.some((n) => want.has(n))) footer.push(`in playbook ${playbook}: decomp-workbench guide ${playbook}`);
    }
  }
  if (topic.playbook !== null) footer.push(...playbookLawSteps(topic.playbook));
  if (footer.length) { lines.push("", "-".repeat(72), "", "NEXT"); lines.push(...footer.map((s) => `  ${s}`)); }
  return lines;
}
