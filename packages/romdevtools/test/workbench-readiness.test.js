// Readiness classification keeps stale and identity work out of source
// lanes. Ported from the workbench's test_readiness.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { candidateObject, moduleDocument, shippedImage } from "./fixtures/workbench/reloc-fixtures.js";
import { readElf } from "../src/decomp/workbench/elf.js";
import { artifactRecord } from "../src/decomp/workbench/evidence.js";
import { QUEUE_SCHEMA, readinessReport } from "../src/decomp/workbench/readiness.js";
import { parseModuleMap, synthesize } from "../src/decomp/workbench/reloc-surface.js";
import { IDENTITY_PROVIDER_SCHEMA, identityReport, parseIdentityProvider } from "../src/decomp/workbench/relocation-identity.js";
import { EVIDENCE_SCHEMA } from "../src/decomp/workbench/relocation-proof.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

let root, source, target, candidate, image, moduleMap;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-readiness-"));
  source = path.join(root, "candidate.c"); target = path.join(root, "target.o"); candidate = path.join(root, "tu.c.o");
  writeFileSync(source, "int candidate;\n"); writeFileSync(target, "target"); writeFileSync(candidate, candidateObject());
  image = path.join(root, "target.z64"); writeFileSync(image, shippedImage());
  moduleMap = path.join(root, "module.json"); writeFileSync(moduleMap, JSON.stringify(moduleDocument()));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function entry(symbol, extra = {}) {
  const artifacts = [artifactRecord(source, { role: "source" }), artifactRecord(target, { role: "target-object" }), artifactRecord(candidate, { role: "candidate-object" })];
  return { symbol, artifacts, measurement: { exact: false, words: 6, verdict: "schedule",
    artifact_sha256: { "target-object": artifacts[1].sha256, "candidate-object": artifacts[2].sha256 } }, ...extra };
}

function relocationReport({ complete }) {
  const p = path.join(root, `reloc-${complete}.json`), providerPath = path.join(root, `provider-${complete}.json`);
  const module = parseModuleMap(moduleDocument());
  const surface = synthesize([[path.resolve(candidate), readElf(candidate)]], module, readFileSync(image));
  const provider = { schema: IDENTITY_PROVIDER_SCHEMA, entries: surface.sites.map((site) => ({ object: site.object, section: site.section, object_offset: site.object_offset,
    type: site.type, symbol: site.symbol, status: complete ? "resolved" : "unknown",
    ...(complete ? { identity: { namespace: "test-module-offset", module: module.name, section: site.section, offset: site.module_offset, addend: 0 } } : {}),
    evidence: "synthetic fixture ownership" })) };
  writeFileSync(providerPath, JSON.stringify(provider));
  const report = surface.asDict();
  report.evidence = { schema: EVIDENCE_SCHEMA, module: module.asDict(), artifacts: [artifactRecord(moduleMap, { role: "module-map" }),
    artifactRecord(image, { role: "target-image" }), artifactRecord(candidate, { role: "candidate-object" }), artifactRecord(providerPath, { role: "identity-provider" })] };
  report.identities = identityReport(surface.sites, parseIdentityProvider(provider));
  writeFileSync(p, JSON.stringify(report));
  return p;
}

test("the queue is split by actual readiness", async () => {
  const incomplete = relocationReport({ complete: false }), complete = relocationReport({ complete: true });
  const promotion = entry("promotion", { relocation_required: true, relocation_report: artifactRecord(complete, { role: "relocation-report" }) });
  Object.assign(promotion.measurement, { exact: true, words: 0 });
  const report = await readinessReport({ schema: QUEUE_SCHEMA, entries: [entry("source"),
    entry("identity", { relocation_required: true, relocation_report: artifactRecord(incomplete, { role: "relocation-report" }) }), promotion, entry("plateau", { plateau: true })] });
  assert.deepEqual(report.source_queue, ["source", "plateau"]);
  assert.deepEqual(report.maintenance_queue, ["identity"]);
  assert.deepEqual(report.promotion_queue, ["promotion"]);
  assert.ok(report.targets.find((r) => r.symbol === "plateau").next.includes("new evidence-producing mechanism"));
});

test("a changed artifact routes to remeasurement", async () => {
  const e = entry("stale");
  writeFileSync(candidate, "changed");
  const report = await readinessReport({ schema: QUEUE_SCHEMA, entries: [e] });
  assert.deepEqual(report.maintenance_queue, ["stale"]);
  assert.equal(report.targets[0].class, "remeasure");
  assert.ok(report.targets[0].reasons[0].includes("stale"));
});

test("missing, unbound, roleless and mistyped measurements are never current", async () => {
  const unmeasured = entry("unmeasured"); delete unmeasured.measurement;
  const unbound = entry("unbound"); unbound.measurement = { exact: true, words: 0 };
  const roleless = entry("roleless"); delete roleless.artifacts[1].role;
  const malformed = entry("malformed"); malformed.measurement.exact = "false"; malformed.relocation_required = "false";
  const report = await readinessReport({ schema: QUEUE_SCHEMA, entries: [unmeasured, unbound, roleless, malformed] });
  assert.ok(report.targets.every((r) => r.class === "remeasure"));
  assert.ok(report.targets[1].reasons[0].includes("artifact_sha256"));
  assert.ok(report.targets[2].reasons[0].includes("role"));
  assert.ok(report.targets[3].reasons.join(" ").includes("must be a boolean"));
});

test("a changed relocation report routes to remeasurement", async () => {
  const relocation = relocationReport({ complete: true });
  const e = entry("stale-relocation", { relocation_required: true, relocation_report: artifactRecord(relocation, { role: "relocation-report" }) });
  writeFileSync(relocation, "{}\n");
  const report = await readinessReport({ schema: QUEUE_SCHEMA, entries: [e] });
  assert.equal(report.targets[0].class, "remeasure");
  assert.ok(report.targets[0].reasons[0].includes("relocation report cannot be trusted"));
});

test("target-readiness and campaign readiness print the classes and exit 2 on a bad queue", async () => {
  const queue = path.join(root, "queue.json");
  writeFileSync(queue, JSON.stringify({ schema: QUEUE_SCHEMA, entries: [entry("source")] }));
  let r = await runCommand(["campaign", "readiness", queue]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith("target readiness: promotion-ready=0 codegen-ready=1 identity-maintenance=0 remeasure=0"));
  assert.ok(r.stdout.includes("codegen-ready        source: assign source/codegen work"));
  r = await runCommand(["target-readiness", queue, "--json"]);
  assert.equal(JSON.parse(r.stdout).schema, "decomp-workbench-target-readiness-v1");
  writeFileSync(queue, "{}");
  r = await runCommand(["target-readiness", queue]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("target queue schema must be"));
});
