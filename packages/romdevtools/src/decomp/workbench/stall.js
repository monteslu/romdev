// stall.js - read a series of already-measured attempts, so stopping is
// measured rather than counted: a series stalls when consecutive attempts
// move neither the residual nor the hypothesis set, and a target whose
// recorded history already closes every mechanism reads "closed by evidence"
// before any attempt. A falling residual is progress for stopping, never
// grounds for adopting a nonexact candidate; a stall is not a reachability
// claim.
//
// Plain JS ESM + JSDoc.

import { ValueError } from "./py.js";

/** Consecutive attempts that must buy nothing before a series reads stalled. */
export const DEFAULT_THRESHOLD = 3;

/** One already-measured attempt (residual: lower is closer). */
export class Attempt {
  constructor({ residual, eliminated = false, label = "" }) { Object.assign(this, { residual, eliminated, label }); Object.freeze(this); }
}

/** How a series reads, and the lines that say so. */
export class StallReading {
  constructor({ state, stalled_for, best_residual, last_progress, lines }) {
    Object.assign(this, { state, stalled_for, best_residual, last_progress, lines });
    Object.freeze(this);
  }
  get should_continue() { return this.state === "improving"; }
}

/** Positions that bought something: a new best residual, or an elimination. */
function progressIndices(attempts) {
  const progressed = [];
  let best = null;
  attempts.forEach((a, i) => {
    const gained = best === null || a.residual < best;
    if (gained) best = a.residual;
    if (gained || a.eliminated) progressed.push(i);
  });
  return progressed;
}

/** Return how this series reads. */
export function readSeries(attempts, { threshold = DEFAULT_THRESHOLD, closed_by_evidence = false } = {}) {
  if (threshold < 1) throw new ValueError("threshold must be at least one attempt");
  const progressed = progressIndices(attempts);
  const best = attempts.length ? Math.min(...attempts.map((a) => a.residual)) : null;
  const lastProgress = progressed.length ? progressed[progressed.length - 1] : null;
  const stalledFor = lastProgress !== null ? attempts.length - 1 - lastProgress : attempts.length;
  if (closed_by_evidence) {
    return new StallReading({ state: "closed-by-evidence", stalled_for: stalledFor, best_residual: best, last_progress: lastProgress, lines: [
      "stop: the target's recorded history already rules out the mechanisms still available here.",
      "  verifying exhaustion is a result; re-deriving a known-flat answer is not.",
      "  file the plateau against the existing evidence, and say the resumption bar was tested and not met.",
    ] });
  }
  if (stalledFor >= threshold) {
    const moved = lastProgress !== null ? `attempt ${lastProgress + 1}` : "no attempt in this series";
    return new StallReading({ state: "stalled", stalled_for: stalledFor, best_residual: best, last_progress: lastProgress, lines: [
      `stop: ${stalledFor} consecutive attempts moved neither the residual nor the hypothesis set.`,
      `  last attempt that bought something: ${moved}.`,
      "  record that as the stopping evidence, not the attempt count.",
      "  a stall is not a reachability claim: for 'no source reaches this', use the permuter or a force proof.",
    ] });
  }
  const detail = lastProgress !== null && stalledFor === 0 && attempts.length > 1
    ? "the series is still moving; the wall clock is the limit, not a count."
    : "no stall yet; keep going while attempts still buy something.";
  return new StallReading({ state: "improving", stalled_for: stalledFor, best_residual: best, last_progress: lastProgress, lines: [
    `continue: ${stalledFor} attempt(s) since the last one that bought something (stall at ${threshold}).`,
    `  ${detail}`,
    "  a falling residual is progress for stopping, never grounds for adopting a nonexact candidate.",
  ] });
}
