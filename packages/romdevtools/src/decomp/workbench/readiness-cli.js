// readiness-cli.js - `target-readiness` (campaign readiness): proof-aware
// target queue classification.
//
// Plain JS ESM + JSDoc.

import { dumps } from "./pyjson.js";
import { loadJsonObject } from "./evidence.js";
import { readinessReport } from "./readiness.js";
import { osErrorText } from "./py.js";

export async function targetReadinessCommand(args, io) {
  let report;
  try { report = await readinessReport(loadJsonObject(args.queue, { where: "target queue" })); }
  catch (e) {
    if (!(e?.name === "ValueError" || (e && typeof e.code === "string"))) throw e;
    io.eprint(`error: ${e.code && !e.kind ? osErrorText(e) : e.message}`);
    return 2;
  }
  if (args.json) io.print(dumps(report));
  else {
    io.print("target readiness: " + Object.entries(report.counts).map(([n, c]) => `${n}=${c}`).join(" "));
    for (const row of report.targets) io.print(`${String(row.class).padEnd(20)} ${row.symbol}: ${row.next}`);
  }
  return 0;
}

export const COMMAND_SPECS = [
  { path: ["target-readiness"], handler: targetReadinessCommand, defaults: { report_command: "target-readiness" },
    help: "separate fresh source targets from identity and remeasurement work",
    description: "Re-hash every artifact in a target queue, reject stale measurements, and split codegen-ready, identity-maintenance, remeasurement, and promotion-ready work before lanes are assigned.",
    arguments: [{ dest: "queue", help: "decomp-workbench-target-queue-v1 JSON" }, { flags: ["--json"], action: "store_true", help: "emit JSON" }] },
];
