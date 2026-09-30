// The differential-shift referee (`shift rehearse`): anchor derivation, the
// movement audit, the word census, the stale merge, the checksum rule, the
// symbol-side census, padded scripts, cross-delta consistency and both
// command modes (analyze, and orchestrate through a fake relink wrapper).
// Ported from the workbench's own tests; every fixture is a handcrafted map
// pair and a 256-byte image pair. The upstream conformance classes replay
// commercial projects' relinks and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SHN_ABS, parseElfSymbols, parseLdMap } from "../src/decomp/workbench/ldmap.js";
import { bootGlobalsWhitelist, defaultPinModel } from "../src/decomp/workbench/pins.js";
import { SHIFT_CENSUS_KEYS, SHIFT_METRICS_BY_KEY, explainKeysText } from "../src/decomp/workbench/schema.js";
import { resolveBlobs } from "../src/decomp/workbench/shift-audit.js";
import { CHECKSUM_RULES, MERGE_TIERS, SHADOWING_PIN, SHIFT_REHEARSE_SCHEMA, SYMBOL_RULES, SYMBOL_STALE, buildRehearsal, crossDeltaDisagreements,
  deriveAnchor, padLdScript, rehearseLines, symbolCensus, symbolExtent } from "../src/decomp/workbench/shift-rehearse.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { ValueError, splitlines } from "../src/decomp/workbench/py.js";
import { buildElf } from "./fixtures/workbench/elf-symtab.js";
import { INSERTION_VRAM, INSERTION_ROM, CHECKSUM_PAIRS, CRC_WORDS, BLOBS, renderMap, baseWords, shiftedWords, pack, baseImage, shiftedImage, baseMap, shiftedMap,
  rehearse, rehearseTracking, statusFor } from "./fixtures/workbench/rehearse-fixtures.js";

const raisesValue = (fn, check = () => true) => assert.throws(fn, (e) => (e instanceof ValueError || e.name === "ValueError") && check(e.message));

test("blob names are validated through the shared region table", () => {
  rehearse();
  raisesValue(() => buildRehearsal({ base_ldmap: baseMap(), base_image: baseImage(), shifted_ldmap: shiftedMap(0x10), shifted_image: shiftedImage(0x10), delta: 0x10,
    blobs: [".boot1"], model: defaultPinModel() }), (m) => m.includes("--blob names a section this map does not have: .boot1"));
});

test("anchor: auto derivation finds the lowest moved symbol and reports the boundary", () => {
  const f = rehearse();
  assert.deepEqual([f.anchor.vram, f.anchor.rom, f.anchor.source, f.anchor.symbol], [INSERTION_VRAM, INSERTION_ROM, "auto", "func_a"]);
  assert.deepEqual([f.anchor.highest_unmoved, f.anchor.lowest_moved], [0x80000400, INSERTION_VRAM]);
  const s = rehearse(0x10, { anchor: "func_a" });
  assert.deepEqual([s.anchor.source, s.anchor.vram], ["symbol", INSERTION_VRAM]);
  raisesValue(() => rehearse(0x10, { anchor: "nope" }), (m) => m.includes("nope"));
});

test("anchor: size symbols outside the window never anchor; a delta nothing moved by is refused", () => {
  const b = parseLdMap(renderMap(0) + "                0x000d08e0                main_TEXT_SIZE\n");
  const s = parseLdMap(renderMap(0x10) + "                0x000d08f0                main_TEXT_SIZE\n");
  assert.equal(deriveAnchor(b, s, { delta: 0x10, window_lo: 0x80000400, window_hi: 0x80000500 }).vram, INSERTION_VRAM);
  raisesValue(() => deriveAnchor(baseMap(), shiftedMap(0x10), { delta: 0x20, window_lo: 0x80000400, window_hi: 0x80000500 }), (m) => m.includes("0x20"));
});

test("a size mismatch beats anchor derivation, with or without --anchor", () => {
  const mismatched = (anchor) => buildRehearsal({ base_ldmap: baseMap(), base_image: baseImage(), shifted_ldmap: shiftedMap(0x40), shifted_image: shiftedImage(0x40),
    delta: 0x10, anchor, blobs: BLOBS, model: defaultPinModel() });
  raisesValue(() => mismatched(null), (m) => m.includes("shifted image is +64 bytes longer than base, not the declared delta +16") && !m.includes("no object-backed symbol"));
  raisesValue(() => mismatched("func_a"), (m) => m.includes("shifted image is +64 bytes longer than base, not the declared delta +16"));
});

test("movement: a clean relink has no anomaly; a third value is a finding that does not stop the census", () => {
  const f = rehearse();
  assert.deepEqual([f.movement_anomalies, f.movement.only_in_base, f.movement.only_in_shifted], [[], [], []]);
  const a = rehearse(0x10, { anomaly: "gTail" });
  assert.deepEqual(a.movement_anomalies.map((m) => m.name), ["gTail"]);
  assert.equal(a.movement_anomalies[0].delta, 8);
  assert.equal(a.census.differing_total, 14);
  assert.ok(a.findings >= 1);
});

test("census classes: one word per class, totals add up, generated spans published, second delta agrees", () => {
  const f = rehearse();
  assert.deepEqual(f.census.counts, { "abs32-tracks": 3, "checksum-gen": 2, "crc-header": 2, "hi16-adjust": 1, "j26-tracks": 3, "lo16-tracks": 2, unexplained: 1 });
  assert.equal(f.unexplained_changed, 1);
  assert.equal(f.census.unexplained[0].offset, 0x60);
  assert.equal(f.census.differing_total, Object.values(f.census.counts).reduce((a, b) => a + b, 0));
  assert.equal(f.census.total_words, 64);
  assert.deepEqual(new Set(f.generated.map((g) => g.label)), new Set(["crc-header", "checksum-gen"]));
  assert.deepEqual(f.generated.map((g) => g.start).sort((a, b) => a - b), [0x10, 0x14, 0xE0, 0xE4, 0xE8, 0xEC]);
  assert.deepEqual(rehearse(0x40).census.counts, f.census.counts);
});

test("stale merge: the tier x moved matrix, the headline, noise, tracking words, reconciliation, the merge table", () => {
  const f = rehearse();
  assert.deepEqual(f.tier_verdicts, { high: { moved: 3, unmoved: 1, "changed-other": 0 }, medium: { moved: 0, unmoved: 2, "changed-other": 0 }, low: { moved: 0, unmoved: 1, "changed-other": 0 } });
  assert.equal(f.reconciled_total, 7);
  assert.equal(f.stale_confirmed, 1);
  const confirmed = f.reconciliation.filter((r) => r.outcome === "stale-confirmed");
  assert.deepEqual(confirmed.map((r) => r.rom), [0xA8]);
  assert.equal(confirmed[0].target_symbol, "gLater");
  assert.deepEqual([f.stale_noise, f.stale_review], [1, 2]);
  const moved = f.reconciliation.filter((r) => r.verdict === "moved");
  assert.deepEqual(moved.map((r) => r.rom).sort((a, b) => a - b), [0x18, 0xA0, 0xB0]);
  assert.deepEqual(new Set(moved.map((r) => r.outcome)), new Set(["tracks"]));
  assert.deepEqual([f.census.stale_total, f.unmoved_total, f.stale_unattributed], [4, 4, 0]);
  assert.equal(MERGE_TIERS.high, "stale-confirmed");
  assert.equal(MERGE_TIERS.low, "noise");
  assert.deepEqual(f.asDict({ limit: 4 }).merge_tiers, { ...MERGE_TIERS });
});

test("calm output: a confirmed row keeps the table; healthy runs collapse to one line; empty tables say none", () => {
  let text = rehearseLines(rehearse(), { limit: 40 }).join("\n");
  assert.ok(text.includes("stale (4 of 4, --limit)") && text.includes("stale-confirmed") && text.includes("gLater") && !text.includes("stale candidates:"));
  let f = rehearseTracking(0x10, [0xA8]);
  assert.deepEqual([f.stale_confirmed, f.stale_review], [0, 2]);
  text = rehearseLines(f, { limit: 40 }).join("\n");
  assert.ok(text.includes("stale candidates: 3, none confirmed (2 review, 1 noise) -- pass --limit 3 to list them"));
  assert.ok(!text.includes("stale (") && !text.includes("gLater"));
  f = rehearseTracking(0x10, [0xA8, 0xA4, 0x24]);
  assert.deepEqual([f.stale_confirmed, f.stale_review, f.stale_noise], [0, 0, 1]);
  text = rehearseLines(f, { limit: 40 }).join("\n");
  assert.ok(text.includes("stale candidates: 1, all noise -- pass --limit 1 to list them") && !text.includes("stale ("));
  const lines = rehearseLines(rehearse(), { limit: 40 });
  const i = lines.indexOf("movement anomalies (0 of 0, --limit)");
  assert.deepEqual(lines.slice(i, i + 3), ["movement anomalies (0 of 0, --limit)", "name base_address shifted_address delta", "none"]);
});

test("checksum rule: inert, tracked, stale, orphan, unresolved; extents; the rule table", () => {
  const f = rehearse();
  const v = (fn) => f.checksums.find((c) => c.function === fn);
  assert.deepEqual([v("fn_inert").status, v("fn_inert").basis, v("fn_inert").body_changed, v("fn_inert").variable_changed], ["pass", "inert", 0, false]);
  assert.deepEqual([v("fn_tracked").status, v("fn_tracked").basis, v("fn_tracked").body_changed, v("fn_tracked").variable_changed], ["pass", "tracked", 1, true]);
  assert.deepEqual([v("fn_stale").status, v("fn_stale").body_changed, v("fn_stale").variable_changed], ["checksum-stale", 1, false]);
  assert.deepEqual([v("fn_orphan").status, v("fn_orphan").body_changed, v("fn_orphan").variable_changed], ["checksum-orphan", 0, true]);
  assert.deepEqual([f.checksums.length, f.checksum_pass, f.checksum_findings], [4, 2, 2]);
  const u = rehearse(0x10, { checksum_pairs: [["nope", "gInertSum"], ["fn_inert", "nope2"]] });
  assert.deepEqual(u.checksums.map((c) => c.status), ["unresolved", "unresolved"]);
  assert.ok((u.checksums[0].note || "").includes("nope"));
  assert.deepEqual(symbolExtent(baseMap(), "fn_stale"), [0x80000440, 0x80000448]);
  assert.deepEqual(symbolExtent(baseMap(), "fn_orphan"), [0x80000448, 0x80000460]);
  assert.equal(symbolExtent(baseMap(), "absent"), null);
  assert.deepEqual(new Set(CHECKSUM_RULES.map((r) => r.name)), new Set(["pass", "checksum-stale", "checksum-orphan", "unresolved"]));
  for (const r of CHECKSUM_RULES) assert.ok(r.evidence);
});

function walkKeys(v) {
  const out = new Set();
  const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { out.add(k); walk(y); } };
  walk(v);
  return out;
}

test("report shape: headline scalars, census keys, caps, ranking, stable JSON, registered keys and labels", () => {
  const f = rehearse(), p = f.asDict({ limit: 3 });
  assert.deepEqual([p.unexplained_changed, p.stale_confirmed], [1, 1]);
  for (const k of ["delta", "anchor_vram", "anchor_rom", "total_words", "differing_total", "unexplained_changed", "stale_total", "stale_confirmed", "stale_review",
    "stale_noise", "movement_shared", "movement_anomaly_total", "checksum_total", "checksum_pass", "checksum_findings", "findings"]) assert.ok(Number.isInteger(p[k]), k);
  assert.deepEqual([p.limit, p.stale_shown, p.stale.length, p.stale[0].tier], [3, 3, 3, "high"]);
  assert.equal(JSON.stringify(p), JSON.stringify(rehearse().asDict({ limit: 3 })));
  const emitted = walkKeys(p);
  emitted.delete("schema");
  for (const g of [p.classes, p.merge_tiers, p.tier_verdicts, ...Object.values(p.tier_verdicts)]) for (const k of Object.keys(g)) emitted.delete(k);
  const text = explainKeysText();
  for (const k of emitted) { assert.ok(k in SHIFT_METRICS_BY_KEY, `unregistered ${k}`); assert.ok(text.includes(k), `unexplained ${k}`); }
  const headers = ["name base_address shifted_address delta", "label count", "start end label", "function variable status basis body_words body_changed",
    "tier verdict count outcome", "rom value tier rule outcome region target_symbol", "offset old new label"];
  const lines = rehearseLines(f, { limit: 8 });
  for (const row of headers) {
    for (const l of row.split(" ")) assert.ok(l in SHIFT_METRICS_BY_KEY, l);
    assert.ok(lines.some((line) => line.split(/\s+/).filter(Boolean).join(" ") === row), `no table with header ${row}`);
  }
  let t = rehearseLines(f, { limit: 1 }).join("\n");
  assert.ok(t.includes("unexplained_changed=1") && t.includes("stale_confirmed=1") && t.includes("1 of 4"));
  t = rehearseLines(f, { limit: 4 }).join("\n");
  assert.ok(t.includes("checksum-stale") && t.includes("did not move"));
  assert.deepEqual(new Set(Object.keys(SHIFT_CENSUS_KEYS)), new Set(Object.keys(SHIFT_METRICS_BY_KEY)));
});

const LD_SCRIPT = "SECTIONS\n{\n    .main 0x80000400 : AT(main_ROM_START) SUBALIGN(16)\n    {\n        main_TEXT_START = .;\n        build/src/hasm/entrypoint.s.o(.text);\n        build/src*.o(.text);\n    }\n}\n";

test("padded scripts: the pad lands after the anchor line with its indentation; zero or two matches fail loudly", () => {
  const p = padLdScript(LD_SCRIPT, { anchor_object: "build/src/hasm/entrypoint.s.o", delta: 0x10 });
  const lines = splitlines(p.text);
  const i = lines.indexOf("        build/src/hasm/entrypoint.s.o(.text);");
  assert.equal(lines[i + 1], "        . += 0x10;");
  assert.equal(p.line, i + 1);
  assert.equal(padLdScript("  build/a.o(.text);\n", { anchor_object: "build/a.o", delta: 0x40 }).text, "  build/a.o(.text);\n  . += 0x40;\n");
  raisesValue(() => padLdScript(LD_SCRIPT, { anchor_object: "build/absent.o", delta: 0x10 }), (m) => m.includes("build/absent.o") && m.includes("no line"));
  raisesValue(() => padLdScript(LD_SCRIPT + "        build/src/hasm/entrypoint.s.o(.data);\n", { anchor_object: "build/src/hasm/entrypoint.s.o", delta: 0x10 }),
    (m) => m.includes("2 lines") && m.includes("6"));
});

test("cross-delta consistency: agreement, a differing class and headline, a single delta", () => {
  assert.deepEqual(crossDeltaDisagreements([rehearse(0x10), rehearse(0x40)]), []);
  const found = crossDeltaDisagreements([rehearse(0x10), rehearse(0x40, { extra_unexplained: true })]);
  const names = found.map((d) => d.name);
  assert.ok(names.includes("unexplained") && names.includes("unexplained_changed"));
  assert.deepEqual(found.find((d) => d.name === "unexplained").values, { "0x10": 1, "0x40": 2 });
  assert.deepEqual(crossDeltaDisagreements([rehearse(0x10)]), []);
});

async function withRoot(files, fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-rehearse-"));
  try {
    for (const [n, c] of Object.entries(files)) writeFileSync(path.join(root, n), c);
    return await fn(root, (n) => path.join(root, n));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const analyzeFiles = () => ({ "base.map": renderMap(0), "base.z64": baseImage(), "shifted.map": renderMap(0x10), "shifted.z64": shiftedImage(0x10) });
const analyzeArgs = (p) => ["shift", "rehearse", "analyze", "--base-map", p("base.map"), "--base-image", p("base.z64"), "--shifted-map", p("shifted.map"),
  "--shifted-image", p("shifted.z64"), "--delta", "0x10", "--blob", ".boot", "--crc-words", "0x10,0x14", ...CHECKSUM_PAIRS.flatMap(([f, v]) => ["--checksum-pair", `${f}=${v}`])];
const withoutBlob = (a) => { const i = a.indexOf("--blob"); return [...a.slice(0, i), ...a.slice(i + 2)]; };

test("analyze command: headline, JSON identity, auto and named anchors", () => withRoot(analyzeFiles(), async (root, p) => {
  let r = await runCommand(analyzeArgs(p));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("shift rehearse") && r.stdout.includes("stale_confirmed=1"));
  r = await runCommand([...analyzeArgs(p), "--json"]);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.schema, j.mode, j.unexplained_changed, j.stale_confirmed, j.anchor_source, j.anchor_vram],
    [0, SHIFT_REHEARSE_SCHEMA, "analyze", 1, 1, "auto", INSERTION_VRAM]);
  r = await runCommand([...analyzeArgs(p), "--anchor", "func_a", "--json"]);
  assert.equal(JSON.parse(r.stdout).anchor_source, "symbol");
}));

test("analyze command: refusals (pair shape, unknown blob, blob and no-blob, missing image, wrong delta)", () => withRoot(analyzeFiles(), async (root, p) => {
  let r = await runCommand([...analyzeArgs(p), "--checksum-pair", "oops"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
  r = await runCommand([...analyzeArgs(p), "--blob", ".nope"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--blob names a section this map does not have: .nope"));
  r = await runCommand([...analyzeArgs(p), "--no-blob", ".boot"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--blob and --no-blob name the same section: .boot"));
  r = await runCommand([...analyzeArgs(p).slice(0, -10), "--shifted-image", p("absent.z64")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
  r = await runCommand([...analyzeArgs(p).slice(0, 11), "--delta", "0x20", "--blob", ".boot"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("error:"));
}));

test("analyze command: --blobs auto reproduces the explicit set; --no-blob subtracts from it", () => withRoot(analyzeFiles(), async (root, p) => {
  const explicit = await runCommand([...analyzeArgs(p), "--json"]);
  const auto = await runCommand([...withoutBlob(analyzeArgs(p)), "--blobs", "auto", "--json"]);
  assert.deepEqual([explicit.code, auto.code], [0, 0]);
  assert.deepEqual(JSON.parse(explicit.stdout), JSON.parse(auto.stdout));
  const excluded = await runCommand([...withoutBlob(analyzeArgs(p)), "--blobs", "auto", "--no-blob", ".boot", "--json"]);
  assert.equal(excluded.code, 0);
  assert.notDeepEqual(JSON.parse(auto.stdout), JSON.parse(excluded.stdout));
}));

test("analyze command: census exit codes, unknown key first, explain-keys, group listings", () => withRoot(analyzeFiles(), async (root, p) => {
  assert.equal((await runCommand([...analyzeArgs(p), "--census", "unexplained_changed=1"])).code, 0);
  let r = await runCommand([...analyzeArgs(p), "--census", "unexplained_changed=0"]);
  assert.equal(r.code, 3);
  assert.ok(r.stdout.includes("census: FAIL"));
  r = await runCommand(["shift", "rehearse", "analyze", "--base-map", "absent.map", "--base-image", "absent.z64", "--shifted-map", "absent.map",
    "--shifted-image", "absent.z64", "--delta", "0x10", "--census", "x=1"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("unknown census key 'x'"));
  assert.equal((await runCommand(["shift", "rehearse", "analyze", "--explain-keys"])).code, 0);
  r = await runCommand(["shift", "rehearse"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("analyze") && r.stdout.includes("orchestrate"));
  r = await runCommand(["shift"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("rehearse"));
}));

// Orchestrate, through a stand-in relink wrapper (node, by its shebang) that
// reads the delta out of the padded script it is handed and copies the
// matching prebuilt fixture into place.
const FAKE_WRAPPER = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const [script, out] = process.argv.slice(2);
const m = /\\. \\+= (0x[0-9a-fA-F]+);/.exec(fs.readFileSync(script, "utf8"));
const source = path.join(__dirname, "fixtures", m ? m[1] : "base");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(source, "image"), path.join(out, "image"));
fs.copyFileSync(path.join(source, "map"), path.join(out, "map"));
`;
const FAILING_WRAPPER = "#!/usr/bin/env node\nprocess.stderr.write(\"relink failed: no toolchain\\n\");\nprocess.exit(3);\n";

function orchestrateRoot(root, { disagree = false } = {}) {
  const fixture = (name, delta, image) => {
    const dir = path.join(root, "fixtures", name);
    mkdirp(dir);
    writeFileSync(path.join(dir, "image"), image);
    writeFileSync(path.join(dir, "map"), renderMap(delta));
  };
  fixture("base", 0, baseImage());
  fixture("0x10", 0x10, shiftedImage(0x10));
  fixture("0x40", 0x40, shiftedImage(0x40, { extra_unexplained: disagree }));
  writeFileSync(path.join(root, "project.ld"), LD_SCRIPT);
  for (const [n, body] of [["relink.cjs", FAKE_WRAPPER], ["broken.cjs", FAILING_WRAPPER]]) {
    writeFileSync(path.join(root, n), body);
    chmodSync(path.join(root, n), 0o755);
  }
}
const mkdirp = (d) => mkdirSync(d, { recursive: true });
const orchestrateArgs = (p, wrapper = "relink.cjs") => ["shift", "rehearse", "orchestrate", "--wrapper", p(wrapper), "--ld-script", p("project.ld"),
  "--anchor-object", "build/src/hasm/entrypoint.s.o", "--deltas", "0x10,0x40", "--workdir", p("work"), "--blob", ".boot", "--crc-words", "0x10,0x14",
  ...CHECKSUM_PAIRS.flatMap(([f, v]) => ["--checksum-pair", `${f}=${v}`])];

test("orchestrate: builds every delta and analyzes each; padded scripts readable; help documents the contract", () => withRoot({}, async (root, p) => {
  orchestrateRoot(root);
  let r = await runCommand([...orchestrateArgs(p), "--json"]);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual([j.mode, j.deltas, j.analyses.length, j.analyses[0].unexplained_changed], ["orchestrate", ["0x10", "0x40"], 2, 1]);
  assert.ok(readFileSync(p("work/shifted-0x10.ld"), "utf8").includes("        . += 0x10;"));
  assert.ok(j.classes_agree);
  assert.deepEqual(j.disagreements, []);
  assert.deepEqual(j.runs.map((x) => x.label), ["base", "0x10", "0x40"]);
  for (const run of j.runs) assert.ok(existsSync(run.image) && existsSync(run.map));
  const emitted = walkKeys(j);
  emitted.delete("schema");
  for (const a of j.analyses) for (const g of [a.classes, a.merge_tiers, a.tier_verdicts, ...Object.values(a.tier_verdicts)]) for (const k of Object.keys(g)) emitted.delete(k);
  for (const d of j.disagreements) for (const k of Object.keys(d.values)) emitted.delete(k);
  for (const k of emitted) assert.ok(k in SHIFT_METRICS_BY_KEY, k);
  r = await runCommand(["shift", "rehearse", "orchestrate", "--help"]);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("SCRIPT LDSCRIPT_PATH OUT_DIR"));
}));

test("orchestrate: a disagreeing delta is a finding", () => withRoot({}, async (root, p) => {
  orchestrateRoot(root, { disagree: true });
  const j = JSON.parse((await runCommand([...orchestrateArgs(p), "--json"])).stdout);
  assert.equal(j.classes_agree, false);
  assert.ok(j.disagreements.map((d) => d.name).includes("unexplained"));
}));

test("orchestrate refusals: an anchor object matching nothing fails before building; a failing wrapper reports its exit; unknown blob", () => withRoot({}, async (root, p) => {
  orchestrateRoot(root);
  let r = await runCommand([...orchestrateArgs(p).slice(0, 5), "--ld-script", p("project.ld"), "--anchor-object", "build/absent.o", "--deltas", "0x10", "--workdir", p("work")]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("build/absent.o"));
  assert.ok(!existsSync(p("work/delta-0x10")));
  r = await runCommand(orchestrateArgs(p, "broken.cjs"));
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("exit"));
  r = await runCommand([...orchestrateArgs(p), "--blob", ".nope"]);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("--blob names a section this map does not have: .nope"));
}));

test("orchestrate: --blobs auto reproduces the explicit blob set", () => withRoot({}, async (root, p) => {
  orchestrateRoot(root);
  const explicit = await runCommand([...orchestrateArgs(p), "--json"]);
  assert.equal(explicit.code, 0, explicit.stderr);
  const auto = await runCommand([...withoutBlob(orchestrateArgs(p)), "--blobs", "auto", "--json"]);
  assert.equal(auto.code, 0, auto.stderr);
  assert.deepEqual(JSON.parse(explicit.stdout), JSON.parse(auto.stdout));
}));

// WB-142: an assignment names a boundary; only an object names a byte

const h8 = (v) => (v >>> 0).toString(16).padStart(8, "0");
const wb142Map = (delta) => ["", "Linker script and memory map", "", ".header         0x00000000       0x40", " .data          0x00000000       0x40 build/header.o", "",
  `.pre_bss        0x${h8(0x80000380 + delta)}       0x80`, ` .bss           0x${h8(0x80000380 + delta)}       0x80 build/pre.o`,
  `                0x${h8(0x80000380 + delta)}                pre_VRAM_END = 0x${h8(0x80000380 + delta)}`, "",
  `.main           0x${h8(0x80000400 + delta)}       0x100 load address 0x00000040`, ` .text          0x${h8(0x80000400 + delta)}       0x100 build/code.o`,
  `                0x${h8(0x80000400 + delta)}                main_TEXT_START = 0x${h8(0x80000400 + delta)}`,
  `                0x${h8(0x80000410 + delta)}                func_a`, `                0x${h8(0x80000440 + delta)}                func_b`, ""].join("\n");

test("WB-142: auto derives the first object-backed symbol, which translates to a ROM offset", () => {
  const base = parseLdMap(wb142Map(0), { path: "base.map" }), shifted = parseLdMap(wb142Map(0x10), { path: "shifted.map" });
  const f = deriveAnchor(base, shifted, { delta: 0x10, window_lo: 0x80000380, window_hi: 0x80000500 });
  assert.deepEqual([f.vram, f.symbol, f.source, f.lowest_moved, f.rom], [0x80000410, "func_a", "auto", 0x80000410, 0x50]);
  assert.equal(base.romForVram(0x80000380), null);
  const sn = shifted.symbolNames();
  const moved = [...base.symbolNames()].filter((n) => sn.has(n)).map((n) => [base.symbol(n), shifted.symbol(n)])
    .filter(([b, s]) => b.address >= 0x80000380 && b.address < 0x80000500 && s.address - b.address === 0x10).map(([b]) => b.address).sort((a, b) => a - b);
  assert.equal(moved[0], 0x80000380);
  assert.equal(base.symbol("pre_VRAM_END").is_assignment, true);
  assert.equal(base.symbol("func_a").is_assignment, false);
  assert.equal(deriveAnchor(base, shifted, { delta: 0x10, window_lo: 0, window_hi: 0x80000500 }).vram, 0x80000410);
});

test("WB-142: a map with only assignments refuses and says why", () => {
  const text = ["", "Linker script and memory map", "", ".main           0x80000400       0x100 load address 0x00000040", " .text          0x80000400       0x100 build/code.o",
    "                0x80000400                main_TEXT_START = 0x80000400", ""].join("\n");
  const shiftedText = text.replaceAll("0x80000400 ", "0x80000410 ").replaceAll("= 0x80000400", "= 0x80000410");
  raisesValue(() => deriveAnchor(parseLdMap(text), parseLdMap(shiftedText), { delta: 0x10, window_lo: 0x80000000, window_hi: 0x80001000 }),
    (m) => m.includes("object-backed") && m.includes("linker-script assignments") && m.includes("--anchor"));
});

// WB-143a: the symbol-side census

const CENSUS_SECTIONS = [[".text", 0x80000400, 0x100, 6], [".bss", 0x80000500, 0x80, 3]];
function censusElf(delta) {
  const moved = (a) => (a >= 0x80000410 ? a + delta : a);
  return buildElf(CENSUS_SECTIONS.map(([n, a, s, f]) => [n, a >= 0x80000410 ? moved(a) : a, s, f]), [
    ["below_pad", 0x80000404, 4, 1, 1, 1], ["func_a", moved(0x80000410), 0x40, 2, 1, 1], ["gTracked", moved(0x80000500), 4, 1, 1, 2],
    ["D_80000510", 0x80000510, 8, 1, 1, SHN_ABS], ["D_80000520", 0x80000520, 0, 0, 1, SHN_ABS], ["D_80000580", 0x80000580, 0, 0, 1, SHN_ABS]]);
}

test("symbol census: boundary excluded and counted, below not judged, shadowing apart from stale, top bound inclusive", () => {
  const c = symbolCensus(parseElfSymbols(censusElf(0), { path: "base.elf" }), parseElfSymbols(censusElf(0x10), { path: "shifted.elf" }),
    { delta: 0x10, anchor_vram: 0x80000410, window_hi: 0x80000580 });
  const names = c.findings.map((f) => f.name);
  assert.equal(c.boundary_symbols, 1);
  assert.ok(!names.includes("func_a") && !names.includes("below_pad"));
  assert.deepEqual([c.checked, c.moved, c.shadowing_pins, c.symbol_stale], [4, 1, 1, 2]);
  const cls = Object.fromEntries(c.findings.map((f) => [f.name, f.classification]));
  assert.deepEqual([cls.D_80000510, cls.D_80000520], [SHADOWING_PIN, SYMBOL_STALE]);
  assert.ok(names.includes("D_80000580"));
  const own = Object.fromEntries(c.findings.map((f) => [f.name, f.owning_section]));
  assert.deepEqual([own.D_80000510, own.D_80000520, own.D_80000580], [".bss", ".bss", null]);
  assert.equal(c.findings[0].name, "D_80000510");
  const p = c.asDict({ limit: 10 });
  assert.deepEqual(p.symbol_rules.map((r) => r.name), SYMBOL_RULES.map((r) => r.name));
  assert.deepEqual([p.symbol_range_lo, p.symbol_range_hi], [0x80000410, 0x80000580]);
});

const wiring = (extra = {}) => buildRehearsal({ base_ldmap: baseMap(), base_image: baseImage(), shifted_ldmap: shiftedMap(0x10), shifted_image: shiftedImage(0x10),
  delta: 0x10, blobs: BLOBS, crc_words: CRC_WORDS, ...extra });

test("symbol census wiring: off by default and says how to turn it on; one ELF refused; both count toward findings", () => {
  const off = wiring();
  assert.equal(off.symbols, null);
  assert.equal(off.symbol_stale, 0);
  const p = off.asDict({ limit: 5 });
  assert.equal(p.symbol_census, false);
  assert.ok(!("symbol_stale" in p));
  const text = rehearseLines(off, { limit: 5 }).join("\n");
  assert.ok(text.includes("symbol_census=off") && text.includes("--base-elf"));
  raisesValue(() => wiring({ base_elf: parseElfSymbols(censusElf(0)) }), (m) => m.includes("go together"));
  const on = wiring({ base_elf: parseElfSymbols(censusElf(0), { path: "base.elf" }), shifted_elf: parseElfSymbols(censusElf(0x10), { path: "shifted.elf" }) });
  const q = on.asDict({ limit: 5 });
  assert.equal(q.symbol_census, true);
  assert.equal(q.base_elf, "base.elf");
  assert.equal(on.findings, on.unexplained_changed + on.stale_confirmed + on.movement_anomalies.length + on.checksum_findings + on.symbol_stale + on.shadowing_pins);
  const emitted = new Set(Object.keys(q));
  for (const row of [...q.symbol_findings, ...q.symbol_rules]) for (const k of Object.keys(row)) emitted.add(k);
  for (const k of emitted) assert.ok(k in SHIFT_METRICS_BY_KEY, k);
});
