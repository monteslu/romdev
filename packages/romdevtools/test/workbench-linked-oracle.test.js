// `reloc-surface`, `linked-compare` and `reloc-proof` end to end: real files
// in a temporary directory, run through the in-process command surface.
// Ported from the workbench's own linked-oracle CLI and relocation-proof
// tests. Synthetic bytes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync, realpathSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { LINKED_COMPARE_SCHEMA, RANGES_SCHEMA, ImageRange, compareImages } from "../src/decomp/workbench/linked-compare.js";
import { MODULE_MAP_SCHEMA, SURFACE_SCHEMA, parseModuleMap, synthesize } from "../src/decomp/workbench/reloc-surface.js";
import { IDENTITY_PROVIDER_SCHEMA, identityReport, parseIdentityProvider } from "../src/decomp/workbench/relocation-identity.js";
import { EVIDENCE_SCHEMA, buildRelocationProof, verifyRelocationProof } from "../src/decomp/workbench/relocation-proof.js";
import { artifactRecord } from "../src/decomp/workbench/evidence.js";
import { readElf } from "../src/decomp/workbench/elf.js";
import { MODULE_START, TU_OFFSET, candidateObject, moduleDocument, shippedImage } from "./fixtures/workbench/reloc-fixtures.js";

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), "romdev-wb-oracle-")));

function surfaceFixture() {
  const root = tmp();
  const f = { root, object: path.join(root, "tu.c.o"), image: path.join(root, "target.bin"), map: path.join(root, "module.json") };
  writeFileSync(f.object, candidateObject());
  writeFileSync(f.image, shippedImage());
  writeFileSync(f.map, JSON.stringify(moduleDocument()));
  f.args = (...extra) => ["reloc-surface", f.object, "--module-map", f.map, "--image", f.image, ...extra];
  f.done = () => rmSync(root, { recursive: true, force: true });
  return f;
}

test("the block is printed and is a linker script", async () => {
  const f = surfaceFixture();
  const r = await runCommand(f.args());
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("callee = 0xF000048C;"));
  assert.ok(r.stdout.includes("gBase = 0x00018010;"));
  assert.equal(JSON.parse(readFileSync(f.map, "utf8")).schema, MODULE_MAP_SCHEMA);
  f.done();
});

test("JSON carries the schema, values and conflicts; sites only when asked", async () => {
  const f = surfaceFixture();
  const r = await runCommand(f.args("--json"));
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.schema, SURFACE_SCHEMA);
  assert.deepEqual(Object.fromEntries(payload.values.map((v) => [v.name, v.value])), { callee: 0xF000048C, gBase: 0x18010 });
  assert.deepEqual(payload.conflicts, []);
  assert.ok(!("sites" in payload));
  assert.equal(JSON.parse((await runCommand(f.args("--json", "--sites"))).stdout).sites.length, 3);
  f.done();
});

test("an identity provider is joined and hash-bound", async () => {
  const f = surfaceFixture();
  const sites = JSON.parse((await runCommand(f.args("--json", "--sites"))).stdout).sites;
  const provider = path.join(f.root, "identities.json");
  writeFileSync(provider, JSON.stringify({ schema: IDENTITY_PROVIDER_SCHEMA, entries: sites.map((s) => ({ object: s.object, section: s.section,
    object_offset: s.object_offset, type: s.type, symbol: s.symbol, status: "resolved",
    identity: { namespace: "test-module-offset", module: "overlay1", section: ".text", offset: s.module_offset, addend: 0 }, evidence: "test fixture ownership" })) }));
  const r = await runCommand(f.args("--identity-provider", provider, "--json"));
  assert.deepEqual([r.code, r.stderr], [0, ""]);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.identities.complete, true);
  assert.ok(payload.evidence.artifacts.map((a) => a.role).includes("identity-provider"));
  f.done();
});

test("--out writes the block a link can include", async () => {
  const f = surfaceFixture();
  const destination = path.join(f.root, "generated.ld");
  assert.equal((await runCommand(f.args("--out", destination))).code, 0);
  assert.ok(readFileSync(destination, "utf8").includes("callee = 0xF000048C;"));
  f.done();
});

test("an audit that agrees exits zero and says so; one that disagrees exits one", async () => {
  const f = surfaceFixture();
  const tracked = path.join(f.root, "tracked.ld");
  writeFileSync(tracked, "callee = 0xF000048C;\n");
  let r = await runCommand(f.args("--audit", tracked));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("agree           1/1"));
  assert.ok(r.stdout.includes("verdict         agrees"));
  writeFileSync(tracked, "callee = 0x1;\n");
  r = await runCommand(f.args("--audit", tracked));
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("MISMATCH        callee"));
  assert.ok(r.stdout.includes("0xf000048c"));
  f.done();
});

test("a missing image is a usage error, not a traceback", async () => {
  const f = surfaceFixture();
  const r = await runCommand(["reloc-surface", f.object, "--module-map", f.map, "--image", path.join(f.root, "absent.bin")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith("error: "));
  f.done();
});

test("a malformed module map names the problem", async () => {
  const f = surfaceFixture();
  const bad = path.join(f.root, "bad.json");
  writeFileSync(bad, JSON.stringify({ module: { image_start: 0 } }));
  const r = await runCommand(["reloc-surface", f.object, "--module-map", bad, "--image", f.image]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("image_end"));
  f.done();
});

test("a refused symbol makes the command exit one", async () => {
  const f = surfaceFixture();
  writeFileSync(f.map, JSON.stringify(moduleDocument({ relocation_sites: [{ offset: TU_OFFSET + 8, type: "R_MIPS_HI16" }] })));
  const r = await runCommand(f.args());
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("UNRESOLVED gBase: no-corroborated-site"));
  f.done();
});

// linked-compare

function compareFixture() {
  const root = tmp();
  const target = path.join(root, "target.z64"), built = path.join(root, "built.z64");
  const bytes = Buffer.concat(Array.from({ length: 16 }, () => Buffer.from(Array.from({ length: 256 }, (_, i) => i))));
  writeFileSync(target, bytes);
  return { root, target, built, bytes, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("an identical image is exact and exits zero", async () => {
  const f = compareFixture();
  writeFileSync(f.built, f.bytes);
  const r = await runCommand(["linked-compare", f.built, f.target, "--range", "draw:0x100:0x140"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("verdict         exact"));
  f.done();
});

test("collateral outside the range still exits zero", async () => {
  const f = compareFixture();
  const image = Buffer.from(f.bytes); image[0x800] ^= 0xFF;
  writeFileSync(f.built, image);
  const r = await runCommand(["linked-compare", f.built, f.target, "--range", "draw:0x100:0x140", "--json"]);
  assert.equal(r.code, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.schema, LINKED_COMPARE_SCHEMA);
  assert.equal(payload.ranges[0].class, "text-exact");
  assert.equal(payload.ranges[0].out_of_range_bytes, 1);
  f.done();
});

test("a residual in range exits one with a word count", async () => {
  const f = compareFixture();
  const image = Buffer.from(f.bytes); image[0x104] ^= 0xFF;
  writeFileSync(f.built, image);
  const r = await runCommand(["linked-compare", f.built, f.target, "--range", "draw:0x100:0x140"]);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes("text-differs"));
  assert.ok(r.stdout.includes("0x104"));
  f.done();
});

test("a ranges file classifies a whole trial's worth", async () => {
  const f = compareFixture();
  const image = Buffer.from(f.bytes); image[0x104] ^= 0xFF;
  writeFileSync(f.built, image);
  const ranges = path.join(f.root, "ranges.json");
  writeFileSync(ranges, JSON.stringify({ ranges: [{ name: "draw", start: "0x100", size: "0x40" }, { name: "step", start: "0x200", size: "0x40" }] }));
  const r = await runCommand(["linked-compare", f.built, f.target, "--ranges", ranges, "--json"]);
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.stdout).ranges.map((x) => x.class), ["text-differs", "text-exact"]);
  f.done();
});

test("a bad range argument is a usage error", async () => {
  const f = compareFixture();
  writeFileSync(f.built, f.bytes);
  const r = await runCommand(["linked-compare", f.built, f.target, "--range", "draw:0x140:0x100"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("not past start"));
  f.done();
});

// reloc-proof

function proofFixture() {
  const root = tmp();
  const f = { root, source: path.join(root, "candidate.c"), candidate: path.join(root, "tu.c.o"), target: path.join(root, "target.z64"),
    built: path.join(root, "built.z64"), moduleMap: path.join(root, "module.json"), identityProvider: path.join(root, "identities.json"),
    rangeMap: path.join(root, "ranges.json"), fallbackPath: path.join(root, "fallback.json"), linkedPath: path.join(root, "linked.json"),
    receiptPath: path.join(root, "receipt.json") };
  writeFileSync(f.source, "void draw(void) {}\n");
  writeFileSync(f.candidate, candidateObject());
  writeFileSync(f.target, shippedImage());
  writeFileSync(f.built, shippedImage());
  writeFileSync(f.moduleMap, JSON.stringify(moduleDocument()));
  f.writeReports = (identitiesComplete = true) => {
    const module = parseModuleMap(moduleDocument());
    const surface = synthesize([[f.candidate, readElf(f.candidate)]], module, readFileSync(f.target));
    const provider = { schema: IDENTITY_PROVIDER_SCHEMA, entries: surface.sites.map((s) => ({ object: s.object, section: s.section, object_offset: s.object_offset,
      type: s.type, symbol: s.symbol, status: identitiesComplete ? "resolved" : "unknown",
      ...(identitiesComplete ? { identity: { namespace: "test-module-offset", module: module.name, section: s.section, offset: s.module_offset, addend: 0 } } : {}),
      evidence: "synthetic fixture ownership" })) };
    writeFileSync(f.identityProvider, JSON.stringify(provider));
    const fallback = surface.asDict();
    fallback.identities = identityReport(surface.sites, parseIdentityProvider(provider));
    fallback.evidence = { schema: EVIDENCE_SCHEMA, module: module.asDict(), artifacts: [artifactRecord(f.moduleMap, { role: "module-map" }),
      artifactRecord(f.target, { role: "target-image" }), artifactRecord(f.candidate, { role: "candidate-object" }), artifactRecord(f.identityProvider, { role: "identity-provider" })] };
    const ranges = [new ImageRange({ name: "draw", start: MODULE_START + TU_OFFSET, end: MODULE_START + TU_OFFSET + 16 })];
    writeFileSync(f.rangeMap, JSON.stringify({ schema: RANGES_SCHEMA, ranges: ranges.map((r) => r.asDict()) }));
    const linked = compareImages(readFileSync(f.built), readFileSync(f.target), ranges, { built_name: f.built, target_name: f.target }).asDict();
    linked.evidence = { schema: EVIDENCE_SCHEMA, artifacts: [artifactRecord(f.built, { role: "built-image" }), artifactRecord(f.target, { role: "target-image" }),
      artifactRecord(f.rangeMap, { role: "range-map" })] };
    writeFileSync(f.fallbackPath, JSON.stringify(fallback));
    writeFileSync(f.linkedPath, JSON.stringify(linked));
  };
  f.writeReports();
  f.build = () => buildRelocationProof({ fallback_report: f.fallbackPath, linked_report: f.linkedPath, symbol: "draw", source: f.source, candidate_object: f.candidate });
  f.done = () => rmSync(root, { recursive: true, force: true });
  return f;
}

test("two surfaces remain named and the owner is derived", () => {
  const f = proofFixture();
  const receipt = f.build();
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.owner.module, "m1");
  assert.equal(receipt.owner.offset, TU_OFFSET);
  assert.deepEqual(Object.keys(receipt.surfaces).sort(), ["fallback_static", "promoted_linked"]);
  assert.ok(receipt.surfaces.fallback_static.claim.includes("does not claim"));
  f.done();
});

test("incomplete identity never promotes", () => {
  const f = proofFixture();
  f.writeReports(false);
  assert.throws(() => f.build(), /identities are incomplete/);
  f.done();
});

test("different target images are refused", () => {
  const f = proofFixture();
  const other = path.join(f.root, "other.z64");
  writeFileSync(other, "different");
  const linked = JSON.parse(readFileSync(f.linkedPath, "utf8"));
  linked.evidence.artifacts[1] = artifactRecord(other, { role: "target-image" });
  writeFileSync(f.linkedPath, JSON.stringify(linked));
  assert.throws(() => f.build(), /different target images/);
  f.done();
});

test("a fabricated identity claim is refused", () => {
  const f = proofFixture();
  const fallback = JSON.parse(readFileSync(f.fallbackPath, "utf8"));
  fallback.identities.entries[0].identity.offset += 4;
  writeFileSync(f.fallbackPath, JSON.stringify(fallback));
  assert.throws(() => f.build(), /identities disagree/);
  f.done();
});

test("a fabricated linked verdict is refused", () => {
  const f = proofFixture();
  const linked = JSON.parse(readFileSync(f.linkedPath, "utf8"));
  linked.ranges[0].class = "text-exact";
  writeFileSync(f.linkedPath, JSON.stringify(linked));
  assert.throws(() => f.build(), /bound inputs/);
  f.done();
});

test("a cropped linked range is refused", () => {
  const f = proofFixture();
  const linked = JSON.parse(readFileSync(f.linkedPath, "utf8"));
  linked.ranges[0].start += 4;
  writeFileSync(f.linkedPath, JSON.stringify(linked));
  assert.throws(() => f.build(), /bound range map/);
  f.done();
});

test("receipt verification re-hashes every input", () => {
  const f = proofFixture();
  writeFileSync(f.receiptPath, JSON.stringify(f.build()));
  assert.equal(verifyRelocationProof(f.receiptPath).pass, true);
  writeFileSync(f.candidate, "changed");
  assert.throws(() => verifyRelocationProof(f.receiptPath), /stale/);
  f.done();
});

test("receipt identity is content-based, not timestamp-based", () => {
  const f = proofFixture();
  writeFileSync(f.receiptPath, JSON.stringify(f.build()));
  const st = statSync(f.source);
  utimesSync(f.source, st.atime, new Date(st.mtimeMs + 1));
  assert.equal(verifyRelocationProof(f.receiptPath).pass, true);
  f.done();
});

test("reloc-proof through the command: build, write, verify", async () => {
  const f = proofFixture();
  let r = await runCommand(["reloc-proof", "--fallback", f.fallbackPath, "--linked", f.linkedPath, "--symbol", "draw", "--source", f.source,
    "--candidate-object", f.candidate, "--out", f.receiptPath]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith("relocation proof: PASS -> "));
  r = await runCommand(["reloc-proof", "--verify", f.receiptPath, "--json"]);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.stdout).verification, "AGREES");
  r = await runCommand(["reloc-proof", "--fallback", f.fallbackPath]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("requires --linked, --symbol, --source, --candidate-object"));
  r = await runCommand(["reloc-proof", "--symbol", "draw"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("one of the arguments --fallback --verify is required"));
  f.done();
});
