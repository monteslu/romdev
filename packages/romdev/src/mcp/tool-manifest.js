// Tool manifest — the SINGLE SOURCE OF TRUTH for the consolidated tool surface.
//
// The 132→34 consolidation (see internal CONSOLIDATION_PLAN) merges narrow tools
// into domain tools with a typed operation axis. This manifest records, for each
// consolidated tool, the OLD tools it absorbs and the axis it routes on — so:
//   1. a coverage-gate test can assert every old tool name maps to exactly one
//      new tool (no capability silently dropped, no dupe);
//   2. a tool-count budget test can fail the build if the surface regrows;
//   3. docs + the rename map for downstream agents derive from one place.
//
// GOVERNANCE: a new capability is a new PARAMETER/op-value on an existing tool by
// default — NOT a new top-level tool. Adding an entry here is a deliberate act the
// budget test surfaces at PR time.
//
// Each MERGE_MAP entry: newTool → { absorbs:[...oldNames], axis:'op'|'as'|... }.
// `absorbs: []` + `unchanged:true` means the tool kept its name (no merge).
// This map grows one domain at a time as each consolidated tool lands.

export const MERGE_MAP = {
  // ── files (generic disk I/O) ──
  files: { absorbs: ["writeAsset", "readAsset", "listAssets"], axis: "op" },
};

/** Every OLD tool name that the consolidation removes (absorbed into a new tool). */
export function absorbedToolNames() {
  const names = [];
  for (const entry of Object.values(MERGE_MAP)) {
    if (entry.absorbs) names.push(...entry.absorbs);
  }
  return names;
}

/** The consolidated (new) tool names this manifest defines. */
export function consolidatedToolNames() {
  return Object.keys(MERGE_MAP);
}
