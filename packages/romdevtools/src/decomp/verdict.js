// verdict.js — ONE aggregate decision for "does this candidate match", and
// the public fields are derived from it. A verifier's job is to distinguish
// evidence of equality from the absence of evidence; every required check
// therefore has an explicit state, and only positive acceptance on all of them
// yields `exact`.
//
//   exact           positive evidence of equality
//   mismatch        positive evidence of difference
//   error           the check threw / produced no usable result
//   unknown         the check could not run (missing inputs) or did not run
//   not-applicable  the tool POSITIVELY established there is nothing to compare
//
// Policy: any mismatch → mismatch; else any error → error; else any unknown →
// unknown; else exact. `not-applicable` satisfies a check. The version below is
// part of the compare cache key: a result verified under an older policy is
// never returned as a current verdict.
export const VERIFIER_VERSION = 2;
export const VERDICT_STATES = ["exact", "mismatch", "error", "unknown", "not-applicable"];
export const POLICY = "any mismatch → mismatch; else any error → error; else any unknown/not-run → unknown; else exact (not-applicable satisfies). exactFunctionMatch is true only for exact.";

/** State of the text (instruction + relocation) check. */
export function textState(strict) {
  if (!strict || typeof strict.exact !== "boolean") return { state: "error", reason: "no strict comparison result" };
  return strict.exact ? { state: "exact" } : { state: "mismatch", reason: `${strict.mismatchCount} instruction/relocation mismatches` };
}

/** State of the function-local rodata check. Failure to compare is never equality. */
export function rodataState(rodata) {
  if (rodata == null || typeof rodata !== "object") return { state: "error", reason: "missing data-comparison result" };
  if (rodata.applicable === false) return { state: "not-applicable", reason: rodata.reason ?? "no rodata references on either side (positively established)" };
  if (rodata.compared === true) {
    if (rodata.equal === true) return { state: "exact" };
    if (rodata.equal === false) return { state: "mismatch", reason: rodata.note ?? "referenced rodata differs" };
    return { state: "error", reason: "comparison reported no equality result" };
  }
  if (rodata.compared === false) {
    if (rodata.error) return { state: "error", reason: rodata.error };
    return { state: "unknown", reason: rodata.reason ?? "rodata comparison unavailable" };
  }
  return { state: "error", reason: "malformed data-comparison result" };
}

/** State of the ROM-linked word check. */
export function romLinkedState(romLinked) {
  if (romLinked == null || typeof romLinked !== "object") return { state: "error", reason: "missing ROM-linked result" };
  switch (romLinked.status) {
    case "exact": return { state: "exact" };
    case "mismatch": return { state: "mismatch", reason: `${romLinked.mismatches} words differ from the base ROM` };
    case "unresolved-relocations": return { state: "unknown", reason: `relocations against symbols with no known address: ${(romLinked.unresolvedSymbols ?? []).join(", ")}` };
    case "no-rom-offset": return { state: "unknown", reason: "the function has no ROM offset to compare against" };
    default: return { state: "error", reason: `unrecognized ROM-linked status '${romLinked.status}'` };
  }
}

/** Aggregate the required function-local checks. */
export function aggregateVerdict({ strict, rodata, romLinked }) {
  const checks = { text: textState(strict), rodata: rodataState(rodata), romLinked: romLinkedState(romLinked) };
  const states = Object.values(checks).map((c) => c.state);
  const functionLocal = states.includes("mismatch") ? "mismatch" : states.includes("error") ? "error" : states.includes("unknown") ? "unknown" : "exact";
  const reasons = Object.entries(checks).filter(([, c]) => c.state !== "exact" && c.state !== "not-applicable").map(([k, c]) => `${k}: ${c.state}${c.reason ? ` (${c.reason})` : ""}`);
  return { functionLocal, checks, reasons, exactFunctionMatch: functionLocal === "exact", verifierVersion: VERIFIER_VERSION, policy: POLICY };
}

/**
 * Assemble the public verdict fields of a compare result from its evidence.
 * THE production path calls this; tests inject failing evidence through it.
 */
export function assembleVerdictFields({ strict, rodata, romLinked, tuStatus }) {
  const v = aggregateVerdict({ strict, rodata, romLinked });
  return {
    exactFunctionMatch: v.exactFunctionMatch,
    textExact: strict?.exact === true,
    verdict: v,
    verification: { functionLocal: v.functionLocal, text: v.checks.text.state, rodata: v.checks.rodata.state, romLinkedBytes: v.checks.romLinked.state, translationUnit: tuStatus ?? "not-run", fullRom: "not-run" },
    verifierVersion: VERIFIER_VERSION,
  };
}

/** A cached compare result is only reusable when it was produced under the current verifier. */
export function cacheUsable(cached) {
  return !!cached && cached.verifierVersion === VERIFIER_VERSION && typeof cached.exactFunctionMatch === "boolean" && !!cached.verdict;
}
