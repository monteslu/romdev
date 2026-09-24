// replay.js - a public-API replay suite over preserved candidates.
//
// §12 of the 2026-09-15 report: "Build a small, public-API replay suite from
// preserved candidates, using isolated worktrees or fixture snapshots. Do not
// mutate the production checkout or treat already-integrated current C as the
// original assembly fixture."
//
// That second clause is the one that bites. An accepted candidate is already
// in the tree, so re-splicing it into the CURRENT owner yields `redeclaration
// of ...` and a compile failure that looks like the candidate's fault. Every
// case that names an integrated function therefore carries `ownerPath`: the
// pre-integration backup, which is what makes an accepted recovery
// re-verifiable at all.
//
// What this measures, and what it deliberately does not:
//
//   MEASURED    whether each case reproduces its expected outcome, and how
//               long the public call took.
//   NOT CLAIMED any speedup multiple. The report says plainly: "No controlled
//               before/after throughput benchmark has been run. I cannot
//               substantiate a promised 5x or 10x speedup." A suite that
//               invented one would be the same failure it was written to
//               catch. p50/p95 are reported only when there are enough runs.

export const REPLAY_SCHEMA = "romdev-decomp-replay-suite-v1";

/**
 * The evaluation set from §12, keyed to the fixtures that exist on disk.
 *
 * Each case states the EXPECT up front, so a run that merely completes cannot
 * be read as a run that passed.
 */
export function defaultCases({ researchRoot }) {
  const R = (p) => `${researchRoot}/parallel-candidates/${p}`;
  return [
    {
      id: "i2-exact-with-contradictory-rodata",
      why: "§12.1 - an exact recovery whose function-local rodata check found 0 target references against 1 candidate reference. The verdict must be exact; the rodata check must report a LIMITATION, not a mismatch.",
      op: "compare",
      symbol: "func_i2_802C7C50", segment: "ovl_i2",
      candidatePath: R("i2-detail7C50-297/variant.c"),
      // Integrated: the current owner already contains it.
      ownerPathHint: "patches/func_i2_802C7C50.*.orig.c",
      expect: { compileSucceeded: true, exactFunctionMatch: true, rodataState: "not-applicable" },
    },
    {
      id: "i3-five-word-scheduling-group",
      why: "§12.2 - five words of setup that are a scheduling permutation, plus a separate reversed branch pair. Diagnosis must report them as DIFFERENT groups.",
      op: "diagnose",
      symbol: "func_i3_802C5800", segment: "ovl_i3",
      candidatePath: R("i3-init5800-299/candidate.c"),
      traceMode: "scheduler", // capture and verify this build; do not trust a nearby historical log
      expect: { mechanisms: ["scheduling-permutation", "branch-lowering"], traceAccepted: true },
    },
    {
      id: "i3-reversed-branch-operands",
      why: "§12.3 - reversing the literal equality does NOT fix the branch pair. A variant batch must show it moving nothing.",
      op: "variants",
      symbol: "func_i3_802C5800", segment: "ovl_i3",
      candidatePath: R("i3-init5800-300/candidate.c"),
      variants: [
        { id: "reversed-equality", hypothesis: "swapping the equality operands flips the branch order",
          find: "if (courseId == D_i3_802C6FE4[difficulty]) {", replace: "if (D_i3_802C6FE4[difficulty] == courseId) {" },
      ],
      expect: { variantDeltaLinked: 0 },
    },
    {
      id: "i15-ceremony-frame-and-registers",
      why: "§12.5 - frame size restored, two matrix homes four bytes high, and an s5/s6/s7 rotation. The layout report must call the two homes a UNIFORM SHIFT rather than two unrelated problems.",
      op: "layout",
      symbol: "func_i15_802C5800", segment: "ovl_i15",
      candidatePath: R("i15-init5800-305/candidate.c"),
      expect: { frameDelta: 0, layoutShape: "uniform-shift", movedSlots: 2 },
    },
    {
      id: "two-overlays-one-virtual-address",
      why: "§12.7 - two functions at VA 0x802C5800 in different overlays must resolve to different targets, bytes and TUs.",
      op: "batch",
      symbols: [
        { symbol: "func_i3_802C5800", segment: "ovl_i3" },
        { symbol: "func_1B1FB0_802C5800", segment: "segment_1B1FB0" },
      ],
      expect: { distinctTargets: 2, distinctTus: 2 },
    },
    {
      // §12.4. The first pass skipped this for "no .c fixture in the 303
      // directory" -- which was giving up one step early: the drafts sit at
      // the parallel-candidates ROOT under nonstandard names, and the research
      // index that ships in this same release finds them. Locating prior art
      // under unusual filenames is a capability being advertised; not using it
      // to resolve a fixture was the wrong call.
      id: "number-renderer-one-branch-vs-five-schedule",
      why: "§12.4 - the one-difference draft's residual is a single ENTRY BRANCH (BEQ where the target has BLEZ), a different mechanism from the five-word tail scheduling residue in the blez-correct draft. Diagnosis must not describe them the same way.",
      op: "diagnose",
      symbol: "func_1B1FB0_802C6C1C", segment: "segment_1B1FB0",
      candidatePath: R("func_1B1FB0_802C6C1C.one-difference.c.txt"),
      // Asserts the MECHANISM, not merely "something other than scheduling":
      // a control feeding `unclassified` slipped past the weaker form, which
      // would have let a shrug count as a correct diagnosis.
      expect: { mechanisms: ["branch-lowering"], mechanismsNotAll: ["scheduling-permutation"] },
    },
    {
      id: "number-renderer-five-word-tail-schedule",
      why: "§12.4 - the companion draft: correct entry branch, five differences confined to tail scheduling. Its groups must differ from the one-difference draft's.",
      op: "diagnose",
      symbol: "func_1B1FB0_802C6C1C", segment: "segment_1B1FB0",
      candidatePath: R("func_1B1FB0_802C6C1C.blez-correct-5diff.c.txt"),
      expect: { mechanisms: ["register-assignment"], groupCountAtLeast: 2 },
    },
    {
      id: "stale-near-match-absent-from-api-history",
      why: "§12.8 - a better historical candidate that the API never measured. Research import must surface it and must NOT describe the target as never attempted.",
      op: "research-status",
      symbol: "func_1B1FB0_802C6C1C",
      expect: { hasDrafts: true, claimedBestDistanceAtMost: 1 },
    },
    {
      // §12.6. The bounded search itself is NOT re-run: it costs 300s of the
      // client's hardware and re-running it proves only what the recorded job
      // already proved. What IS exercised is the accounting over that real
      // job - which is a narrower claim, and the matrix labels it `partial`
      // rather than letting it stand in for the search behaviour.
      id: "i5-no-improvement-search-accounting",
      why: "§12.6 - a correct-size residual whose bounded search returned no improvement. Exercises the report's accounting over the recorded 300s job: termination reason, mutation family, and the recommendation to switch mechanism rather than re-run.",
      op: "job-accounting",
      // PIN THE JOB, not a prefix. `jobPrefix` matched the NEWEST job with that
      // prefix, which turned out to be a 10s/2-thread job created while testing
      // seeds -- so a case named for the recorded 300-second run passed against
      // a different job entirely. A fixture that can be silently substituted is
      // not a fixture.
      jobId: "search-func_i5_802C5DC0-mu3bsfrq2",
      expect: { jobId: "search-func_i5_802C5DC0-mu3bsfrq2", timeLimitS: 300, threads: 8,
        hasAccounting: true, terminationReasonPresent: true, recommendsSwitchingMechanism: true },
    },
    {
      // The half that was labelled `unexercised` while this case sat at
      // `partial`. Re-running the client's 300-second search would only
      // re-derive a recorded result, but a SHORT bounded launch proves the
      // path end to end for a fraction of the cost: preflight, seed mapping,
      // budget, termination and accounting.
      id: "bounded-search-launch-end-to-end",
      why: "§12.6 (second half) - a fresh bounded search, launched through the public API on a 20s budget: the preflight must run and be recorded, a descriptive seed must map deterministically, and the job must terminate on its budget with accounting and no backend traceback.",
      op: "search-launch",
      symbol: "func_i3_802C5800", segment: "ovl_i3",
      candidatePath: R("i3-init5800-300/candidate.c"),
      timeLimitS: 20, threads: 2, seed: "replay-bounded-probe",
      expect: { preflightRan: true, seedMapped: true, terminatedOnBudget: true, backendTraceback: false },
    },
    {
      // §12.9 asks specifically about REMOVING A REQUIRED OUTPUT ARGUMENT.
      // The first version asserted `pointer-cast` and `global-write-added`,
      // which are two other checks firing on an unrelated candidate - green,
      // and no evidence at all that the missing output was detected. The gate
      // could not detect it; it can now, and this asserts THAT.
      id: "semantically-wrong-but-plausible",
      why: "§12.9 - a candidate that gives a required output pointer as NULL. Baseline and candidate differ ONLY in that argument, so the finding cannot come from anything else.",
      op: "gate",
      symbol: "func_i15_802C5800", segment: "ovl_i15",
      baselineText: "void f(Mtx *out) { guMtxIdent(out); use(out); }",
      candidateText: "void f(Mtx *out) { guMtxIdent(NULL); use(out); }",
      expect: { findingIds: ["output-argument-nulled"] },
    },
    {
      // The CONTROL for the case above: the unchanged baseline against itself.
      // Without it, a gate that flagged everything would pass §12.9.
      id: "semantically-wrong-control-unchanged-baseline",
      why: "§12.9 control - the baseline compared against itself must raise NOTHING. A finding here would mean the detection above is noise.",
      op: "gate",
      symbol: "func_i15_802C5800", segment: "ovl_i15",
      baselineText: "void f(Mtx *out) { guMtxIdent(out); use(out); }",
      candidateText: "void f(Mtx *out) { guMtxIdent(out); use(out); }",
      expect: { noFindings: true },
    },
  ];
}

/** Percentiles, only once there are enough samples to mean anything. */
export function timings(samples) {
  const xs = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (xs.length < 5) {
    return { n: xs.length, min: xs[0] ?? null, max: xs[xs.length - 1] ?? null,
      note: "fewer than 5 samples: p50/p95 are NOT reported. The report asked for percentiles only after enough runs, and extrapolating from a handful is how a single compare becomes a claimed speedup." };
  }
  const at = (q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  return { n: xs.length, min: xs[0], p50: at(0.5), p95: at(0.95), max: xs[xs.length - 1] };
}

/**
 * Check one case's actual result against its stated expectation.
 * Returns the reasons it failed, so "passed" is never merely "did not throw".
 */
export function checkExpectations(kase, actual) {
  const fails = [];
  const e = kase.expect ?? {};
  const eq = (name, got, want) => { if (got !== want) fails.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

  if (e.compileSucceeded != null) eq("compileSucceeded", actual.compileSucceeded, e.compileSucceeded);
  if (e.exactFunctionMatch != null) eq("exactFunctionMatch", actual.exactFunctionMatch, e.exactFunctionMatch);
  if (e.rodataState) eq("rodata state", actual.rodataState, e.rodataState);
  if (e.traceAccepted != null) eq("trace accepted", actual.traceAccepted, e.traceAccepted);
  if (e.mechanisms) {
    for (const m of e.mechanisms) {
      if (!(actual.mechanisms ?? []).includes(m)) fails.push(`mechanism '${m}' not reported (got: ${(actual.mechanisms ?? []).join(", ") || "none"})`);
    }
  }
  if (e.mechanismsNotAll) {
    // A residual that is NOT merely scheduling must not be described as if it
    // were: that is the misdirection this suite exists to catch.
    const got = actual.mechanisms ?? [];
    if (got.length && got.every((m) => e.mechanismsNotAll.includes(m))) {
      fails.push(`every group was classified as ${e.mechanismsNotAll.join("/")}, which does not distinguish this residual from a pure scheduling one`);
    }
  }
  if (e.groupCountAtLeast != null && !((actual.groupCount ?? 0) >= e.groupCountAtLeast)) {
    fails.push(`groupCount: expected at least ${e.groupCountAtLeast}, got ${JSON.stringify(actual.groupCount)}`);
  }
  if (e.variantDeltaLinked != null) eq("variant linked delta", actual.variantDeltaLinked, e.variantDeltaLinked);
  if (e.frameDelta != null) eq("frame delta", actual.frameDelta, e.frameDelta);
  if (e.layoutShape) eq("layout shape", actual.layoutShape, e.layoutShape);
  if (e.movedSlots != null) eq("moved slots", actual.movedSlots, e.movedSlots);
  if (e.distinctTargets != null) eq("distinct targets", actual.distinctTargets, e.distinctTargets);
  if (e.distinctTus != null) eq("distinct TUs", actual.distinctTus, e.distinctTus);
  if (e.hasDrafts != null) eq("has drafts", actual.hasDrafts, e.hasDrafts);
  if (e.claimedBestDistanceAtMost != null) {
    const d = actual.claimedBestDistance;
    if (!(d != null && d <= e.claimedBestDistanceAtMost)) fails.push(`claimedBestDistance: expected <= ${e.claimedBestDistanceAtMost}, got ${JSON.stringify(d)}`);
  }
  if (e.preflightRan != null) eq("preflight ran", actual.preflightRan, e.preflightRan);
  if (e.seedMapped != null) eq("seed mapped", actual.seedMapped, e.seedMapped);
  if (e.terminatedOnBudget != null) eq("terminated on budget", actual.terminatedOnBudget, e.terminatedOnBudget);
  if (e.backendTraceback != null) eq("backend traceback", actual.backendTraceback, e.backendTraceback);
  if (e.jobId != null) eq("job id", actual.jobId, e.jobId);
  if (e.timeLimitS != null) eq("configured time budget", actual.timeLimitS, e.timeLimitS);
  if (e.threads != null) eq("configured threads", actual.threads, e.threads);
  if (e.hasAccounting != null) eq("has accounting", actual.hasAccounting, e.hasAccounting);
  if (e.terminationReasonPresent != null) eq("termination reason present", actual.terminationReasonPresent, e.terminationReasonPresent);
  if (e.recommendsSwitchingMechanism != null) eq("recommends switching mechanism", actual.recommendsSwitchingMechanism, e.recommendsSwitchingMechanism);
  if (e.noFindings) {
    const got = actual.findingIds ?? [];
    if (got.length) fails.push(`expected NO findings on an unchanged baseline, got: ${got.join(", ")} - the detection this controls for is firing on noise`);
  }
  if (e.findingIds) {
    for (const id of e.findingIds) {
      if (!(actual.findingIds ?? []).includes(id)) fails.push(`gate finding '${id}' not raised (got: ${(actual.findingIds ?? []).join(", ") || "none"})`);
    }
  }
  return fails;
}

/**
 * Summarize a completed run. Reports what was measured and refuses to turn it
 * into a throughput claim.
 */
/**
 * The ACCEPTANCE MATRIX the client asked for.
 *
 * "Publish an acceptance matrix with `passed`, `failed`, `partial`, `not run`,
 * and `unsupported` where appropriate. Tie each claim to an actual request and
 * response, identified candidate, and asserted outcome. Seven passing cases
 * prove those seven cases, not universal closure of the report."
 *
 * `partial` is the important state and the one the previous summary lacked: a
 * case where something real was exercised but a named part of the requirement
 * was not. Folding those into `passed` is how a summary outruns its evidence.
 */
export function statusOf(result, kase) {
  if (result.skipped) return "not run";
  if (result.unsupported) return "unsupported";
  if (!result.passed) return "failed";
  return kase?.status === "partial" || result.unexercised ? "partial" : "passed";
}

export function summarize(results, cases = []) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const rows = results.map((r) => {
    const kase = byId.get(r.id);
    const status = statusOf(r, kase);
    return {
      id: r.id, status,
      requirement: r.why ?? kase?.why ?? null,
      // Every row names what was actually driven and what came back, so a
      // claim can be checked rather than taken on trust.
      request: kase ? { op: kase.op, symbol: kase.symbol ?? null, segment: kase.segment ?? null,
        candidate: kase.candidatePath ?? (kase.candidateText ? "(inline)" : null),
        artifact: r.actual?.artifact ?? null } : null,
      asserted: kase?.expect ?? null,
      observed: r.actual ?? null,
      ms: r.ms,
      ...(r.failures ? { failures: r.failures } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(kase?.unexercised || r.unexercised ? { unexercised: kase?.unexercised ?? r.unexercised } : {}),
    };
  });
  const count = (st) => rows.filter((r) => r.status === st).length;
  const tally = { passed: count("passed"), partial: count("partial"), failed: count("failed"),
    "not run": count("not run"), unsupported: count("unsupported") };

  return {
    schema: REPLAY_SCHEMA,
    cases: rows.length,
    // Kept for callers reading the old shape, but the matrix is authoritative.
    passed: tally.passed, failed: tally.failed, skipped: tally["not run"],
    matrix: tally,
    coverage: `${tally.passed} of ${rows.length} cases fully passed`
      + (tally.partial ? `; ${tally.partial} PARTIAL (something real was exercised, but a named part of the requirement was not - see each row's \`unexercised\`)` : "")
      + (tally.failed ? `; ${tally.failed} failed` : "")
      + (tally["not run"] ? `; ${tally["not run"]} not run` : "")
      + ".",
    timings: timings(results.map((r) => r.ms)),
    rows,
    results,
    interpretation:
      "This suite measures whether each listed bottleneck reproduces its expected OUTCOME through the public API. It proves THOSE cases and nothing wider. "
      + "It is not a throughput benchmark: no baseline workflow was run alongside it, so it cannot support a speedup figure, and none is stated. "
      + "A case that merely completed is not a case that passed - every row carries its request, its asserted outcome, what was observed, and any part of the requirement left unexercised.",
  };
}
