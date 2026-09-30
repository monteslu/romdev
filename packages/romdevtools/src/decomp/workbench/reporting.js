// reporting.js - versioned JSON reports and structured command failures.
// A caller that asks for JSON always receives one parseable, schema-named
// document: handlers render domain payloads, and runJsonHandler supplies the
// envelope (schema identity, or the decomp-workbench-error-v1 document when a
// handler only wrote to stderr).
//
// Plain JS ESM + JSDoc.

import { renderJson } from "./pyjson.js";

export const ERROR_SCHEMA = "decomp-workbench-error-v1";

/** Report schema per command name. */
export const SCHEMAS = Object.freeze({
  "bundle-scratch": "decomp-workbench-scratch-bundle-v1",
  "align": "decomp-workbench-shift-diff-v1",
  "align-dumps": "decomp-workbench-shift-diff-v1",
  "audit-handoff": "decomp-workbench-handoff-audit-v1",
  "campaign": "decomp-workbench-campaign-v1",
  "capture-make": "decomp-workbench-capture-toolchain-v1",
  "capture-runs": "decomp-workbench-capture-runs-v1",
  "campaign-export": "decomp-workbench-campaign-export-result-v1",
  "campaign-finish": "decomp-workbench-campaign-finish-result-v1",
  "campaign-checkpoint": "decomp-workbench-campaign-checkpoint-v1",
  "campaign-restore-best": "decomp-workbench-campaign-restore-v1",
  "campaign-accept": "decomp-workbench-campaign-accept-v1",
  "campaign-dossier-add": "decomp-workbench-dossier-add-v1",
  "campaign-dossier-list": "decomp-workbench-dossier-v1",
  "campaign-note": "decomp-workbench-campaign-note-v1",
  "campaign-package": "decomp-workbench-campaign-package-result-v1",
  "campaign-resume": "decomp-workbench-campaign-status-v1",
  "campaign-status": "decomp-workbench-campaign-status-v1",
  "campaign-survey": "decomp-workbench-campaign-survey-v1",
  "cache-prune": "decomp-workbench-cache-prune-v1",
  "cache-restore": "decomp-workbench-cache-restore-v1",
  "cache-status": "decomp-workbench-cache-status-v1",
  "check-scratch": "decomp-workbench-scratch-check-v1",
  "check-staleness": "decomp-workbench-staleness-v1",
  "compare": "decomp-workbench-comparison-v1",
  "compare-dumps": "decomp-workbench-comparison-v1",
  "compile-rank": "decomp-workbench-compile-rank-v1",
  "commands": "decomp-workbench-command-map-v1",
  "context-lint": "decomp-workbench-context-lint-v1",
  "context-duplicates": "decomp-workbench-context-duplicates-v1",
  "doctor": "decomp-workbench-doctor-v1",
  "experiment-validate": "decomp-workbench-experiment-v1",
  "experiment-compose": "decomp-workbench-composition-v1",
  "experiment-inspect-source": "decomp-workbench-source-inspection-v1",
  "experiment-review-mutation": "decomp-workbench-mutation-review-v1",
  "fetch-scratch": "decomp-workbench-scratch-fetch-v1",
  "fingerprint-toolchain": "decomp-workbench-toolchain-fingerprint-v1",
  "force-rows": "decomp-workbench-force-rows-v1",
  "force-rows-dumps": "decomp-workbench-force-rows-v1",
  "fidelity": "decomp-workbench-object-fidelity-v1",
  "diagnose": "decomp-workbench-diagnosis-v3",
  "diagnose-dumps": "decomp-workbench-diagnosis-v3",
  "install-skill": "decomp-workbench-skill-install-v1",
  "instrument-gate": "decomp-workbench-instrument-gate-v1",
  "instrument-scheduler": "decomp-workbench-scheduler-instrument-v1",
  "instrument-pre": "decomp-workbench-pre-instrument-v1",
  "binasm-window": "decomp-workbench-stream-window-v1",
  "inspect-binasm": "decomp-workbench-binasm-boundary-v1",
  "inspect-ucode": "decomp-workbench-ucode-xjp-v1",
  "lineage": "decomp-workbench-cross-rom-lineage-v1",
  "linked-compare": "decomp-workbench-linked-compare-v1",
  "matrix": "decomp-workbench-matrix-v1",
  "next": "decomp-workbench-next-v1",
  "next-dumps": "decomp-workbench-next-v1",
  "note-add": "decomp-workbench-note-add-v1",
  "note-list": "decomp-workbench-note-list-v1",
  "note-merge": "decomp-workbench-note-merge-v1",
  "note-reserve": "decomp-workbench-note-reserve-v1",
  "oracle-diff": "decomp-workbench-oracle-diff-v1",
  "oracle-export": "decomp-workbench-oracle-export-v1",
  "oracle-plan": "decomp-workbench-oracle-plan-v1",
  "oracle-status": "decomp-workbench-oracle-sweep-v1",
  "oracle-sweep": "decomp-workbench-oracle-sweep-v1",
  "object-collateral": "decomp-workbench-object-collateral-v1",
  "public-match-check": "decomp-workbench-public-match-check-v1",
  "probe-deadread": "decomp-workbench-dead-read-v1",
  "probe-equiv": "decomp-workbench-value-equality-v1",
  "probe-lines": "decomp-workbench-line-probe-v1",
  "project-init": "decomp-workbench-project-v1",
  "project-show": "decomp-workbench-project-v1",
  "rank": "decomp-workbench-rank-v1",
  "window": "decomp-workbench-window-v1",
  "window-dumps": "decomp-workbench-window-v1",
  "relocation-aliases": "decomp-workbench-relocation-aliases-v1",
  "reloc-surface": "decomp-workbench-reloc-surface-v1",
  "reloc-proof": "decomp-workbench-relocation-proof-v1",
  "permute-sweep": "decomp-workbench-permute-sweep-v1",
  "ranking-stamp": "decomp-workbench-ranking-stamp-v1",
  "ranking-check": "decomp-workbench-ranking-stamp-v1",
  "permute-doctor": "decomp-workbench-permute-doctor-v1",
  "permute-classify": "decomp-workbench-permute-classify-v1",
  "pass-diff": "decomp-workbench-original-pass-diff-v1",
  "phase": "decomp-workbench-phase-v1",
  "phase-dumps": "decomp-workbench-phase-v1",
  "replay-as1": "decomp-workbench-pass-replay-v1",
  "replay-ugen": "decomp-workbench-replay-ugen-v1",
  "stream-diff": "decomp-workbench-stream-diff-v1",
  "ucode-patch": "decomp-workbench-stream-patch-v1",
  "ucode-window": "decomp-workbench-stream-window-v1",
  "score": "decomp-workbench-score-v1",
  "shift-audit": "decomp-workbench-shift-audit-v1",
  "shift-config-verify": "decomp-workbench-shift-config-v1",
  "shift-plan": "decomp-workbench-shift-plan-v1",
  "shift-rehearse": "decomp-workbench-shift-rehearse-v1",
  "shift-orchestrate": "decomp-workbench-shift-rehearse-v1",
  "slots": "decomp-workbench-stack-slots-v1",
  "sweep-build": "decomp-workbench-sweep-build-v1",
  "sweep-carriers": "decomp-workbench-carrier-pool-v1",
  "sweep-commute": "decomp-workbench-sweep-v1",
  "sweep-copies": "decomp-workbench-sweep-v1",
  "sweep-donors": "decomp-workbench-fusion-donors-v1",
  "sweep-fuse": "decomp-workbench-sweep-v1",
  "sweep-hoist": "decomp-workbench-sweep-v1",
  "sweep-ingest": "decomp-workbench-sweep-ingest-v1",
  "sweep-regress": "decomp-workbench-sweep-v1",
  "instrument-drop-in": "decomp-workbench-drop-in-plan-v1",
  "check-drop-in": "decomp-workbench-drop-in-audit-v1",
  "trace-alias": "decomp-workbench-trace-alias-v1",
  "trace-a71": "decomp-workbench-trace-a71-v1",
  "trace-blocks": "decomp-workbench-web-blocks-v1",
  "trace-cascade": "decomp-workbench-cascade-v1",
  "trace-order": "decomp-workbench-color-order-v1",
  "trace-copy-decisions": "decomp-workbench-copy-decisions-v1",
  "trace-fifo": "decomp-workbench-trace-fifo-v1",
  "trace-frame": "decomp-workbench-frame-ladder-v1",
  "trace-globalcolor": "decomp-workbench-trace-globalcolor-v1",
  "trace-origin-probe": "decomp-workbench-origin-probe-v1",
  "trace-scheduler": "decomp-workbench-scheduler-trace-v1",
  "trace-emit": "decomp-workbench-ugen-emit-trace-v1",
  "trace-pre": "decomp-workbench-pre-trace-v1",
  "trace-source": "decomp-workbench-trace-source-v1",
  "trace-stack-homes": "decomp-workbench-stack-homes-v1",
  "trace-summary": "decomp-workbench-trace-summary-v1",
  "trace-webs": "decomp-workbench-allocator-webs-v2",
  "toolchain-init": "decomp-workbench-toolchain-v1",
  "toolchain-calibrate": "decomp-workbench-toolchain-v1",
  "toolchain-status": "decomp-workbench-toolchain-v1",
  "target-audit": "decomp-workbench-target-audit-v1",
  "target-readiness": "decomp-workbench-target-readiness-v1",
  "view": "decomp-workbench-view-v3",
  "view-dumps": "decomp-workbench-view-v3",
});

/** Return the stable report schema for one command. */
export function schemaFor(command) { return SCHEMAS[command] ?? `decomp-workbench-${command}-v1`; }

/** One top-level object carrying a schema identity; lists wrap under results. */
export function withSchema(command, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return "schema" in value ? { ...value } : { ...value, schema: schemaFor(command) };
  return { schema: schemaFor(command), results: value };
}

/** Classify a user-facing failure without guessing domain internals. */
export function classifyError(message, status) {
  const lowered = message.toLowerCase();
  if (lowered.includes("timeout") || lowered.includes("exceeded --timeout")) return "timeout";
  if (lowered.includes("does not exist") || lowered.includes("no such file")) return "not-found";
  if (lowered.includes("failed with exit") || lowered.includes("objdump failed")) return "process-failed";
  if (status === 2) return "usage";
  if (status === 1) return "no-result";
  return "command-failed";
}

/** The shared error envelope. */
export function errorReport(command, { status, message, stage = "command", details = null }) {
  const error = { kind: classifyError(message, status), message };
  if (details && Object.keys(details).length) error.details = details;
  return { schema: ERROR_SCHEMA, command, stage, status, error };
}

export { renderJson };

/**
 * The JSON contract over a handler run already captured as text: parse the
 * payload and add a schema, or turn a stderr-only failure into the error
 * document. Returns { code, stdout }.
 */
export function jsonEnvelope(command, status, stdout, stderr) {
  const output = stdout.trim(), diagnostic = stderr.trim();
  if (output) {
    let value;
    try { value = JSON.parse(output); } catch {
      return { code: 2, stdout: renderJson(errorReport(command, { status: 2, message: diagnostic || "command emitted invalid JSON" })) };
    }
    return { code: status, stdout: renderJson(withSchema(command, value)) };
  }
  const message = diagnostic.replace(/^error: /, "").trim() || "command produced no result";
  return { code: status || 2, stdout: renderJson(errorReport(command, { status: status || 2, message })) };
}
