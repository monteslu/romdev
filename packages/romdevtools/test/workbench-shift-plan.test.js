// The ranked, gated remediation queue (`shift plan`): routing, merging,
// ordering, the report and the Markdown work order, and the command.
// Ported from the workbench's own tests; the reports are hand-written
// payloads. The upstream live-conformance classes build reports from
// commercial projects' artifacts and are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SHIFT_METRICS_BY_KEY } from "../src/decomp/workbench/schema.js";
import { AUDIT_SCHEMA, DELETE_REDUNDANT_PIN, DERIVE_PIN, DUAL_SPELLING_RISK, INVESTIGATE, MIGRATE_SYMBOL, PLAN_RULES, REHEARSE_SCHEMA,
  REMEDIATION_CLASSES, SHIFT_PLAN_SCHEMA, STRUCTURAL, WHITELIST_CANDIDATE, buildPlan, planLines, planMarkdown } from "../src/decomp/workbench/shift-plan.js";
import { runCommand } from "../src/decomp/workbench/cli.js";
import { sorted } from "../src/decomp/workbench/py.js";

const REGIONS = [
  { output_section: ".header", kind: "header", vram: 0, size: 0x40, rom: 0 },
  { output_section: ".assets", kind: "blob", vram: 0x80200000, size: 0x1000, rom: 0x5E90 },
  { output_section: ".main", kind: "text", vram: 0x80000400, size: 0x100, rom: 0x40 },
  { output_section: ".main_bss", kind: "bss", vram: 0x80000500, size: 0x100, rom: null },
  { output_section: ".ovl_a", kind: "text", vram: 0x80010000, size: 0x80, rom: 0x2000 },
  { output_section: ".ovl_b", kind: "text", vram: 0x80010000, size: 0x80, rom: 0x3000 },
  { output_section: ".empty_bss", kind: "bss", vram: 0x80000500, size: 0, rom: null },
];
const pin = (name, value, classification, extra = {}) => ({ name, value, classification, window: "kseg0", source: "syms.txt", line: 1, form: "absolute", ...extra });

const AUDIT = {
  schema: AUDIT_SCHEMA, map: "build/game.map", image: "build/game.z64", elf: "build/game.elf", regions: REGIONS, blobs: [".assets"], pin_sources: ["syms.txt"],
  window_lo: 0x80000400, text_words: 1024, text_regions: 2, pins_total: 7, pins_shown: 7, scan_high: 1, hits_shown: 1,
  pins: [pin("D_80000540", 0x80000540, "shadowing-pin"), pin("D_5E90", 0x5E90, "rom-offset", { window: null }), pin("D_DEADBEEF", 0xDEADBEEF, "rom-offset", { window: null }),
    pin("D_80000560", 0x80000560, "artifact-suspect"), pin("D_80000600", 0x80000600, "artifact-suspect"), pin("D_A4040010", 0xA4040010, "artifact-suspect", { window: "kseg1" }),
    pin("osTvType", 0x80000300, "artifact-suspect"), pin("SP_STATUS", 0xA4040000, "authentic-fixed", { window: "kseg1" })],
  hits: [{ rom: 0xA0, value: 0x80000560, tier: "high", region: ".main", resident_symbol: "gTable", target_symbol: "gThing" }, { rom: 0xB0, value: 0x80000560, tier: "low", region: ".main" }],
};

const REHEARSE = {
  schema: REHEARSE_SCHEMA, mode: "analyze", base_map: "build/game.map", base_image: "build/game.z64", shifted_map: "shift/game.map", shifted_image: "shift/game.z64",
  base_elf: "build/game.elf", shifted_elf: "shift/game.elf", delta: 0x10, regions: REGIONS, symbol_census: true, stale_shown: 2, stale_confirmed: 2,
  symbol_findings_shown: 4, symbol_stale: 3, shadowing_pins: 1, stale_unattributed: 5,
  stale: [{ rom: 0xC0, value: 0x80000540, outcome: "stale-confirmed", region: ".main", target_symbol: "D_80000540" },
    { rom: 0xC4, value: 0x80000570, outcome: "stale-confirmed", region: ".main", target_symbol: "gOther" }, { rom: 0xC8, value: 0x80000578, outcome: "noise", region: ".main" }],
  symbol_findings: [{ name: "D_80000540", value: 0x80000540, classification: "shadowing-pin", size: 4, owning_section: ".main_bss" },
    { name: "D_80000600", value: 0x80000600, classification: "symbol-stale", size: 0, owning_section: null },
    { name: "D_80000560", value: 0x80000560, classification: "symbol-stale", size: 0, owning_section: ".main_bss" },
    { name: "D_C0FFEE00", value: 0xC0FFEE00, classification: "symbol-stale", size: 0, owning_section: null }],
};

const plan = ({ rehearsals = [REHEARSE] } = {}) => buildPlan({ audit: AUDIT, rehearsals, audit_path: "audit.json", rehearse_paths: ["rehearse.json"] });
const bySubject = (p) => new Map(p.items.map((i) => [`${i.remediation}|${i.subject}`, i]));

test("routing: every published rule fires once, each to its class", () => {
  const p = plan(), by = bySubject(p);
  assert.deepEqual(new Set(p.items.flatMap((i) => i.rules)), new Set(PLAN_RULES.map((r) => r.name)));
  let i = by.get(`${DELETE_REDUNDANT_PIN}|D_80000540`);
  assert.ok(i.conviction && i.rank.kind === "match-preserving");
  i = by.get(`${DERIVE_PIN}|D_5E90`);
  assert.ok(i.exemplar && i.evidence[0].includes("ROM start of .assets") && i.section === ".assets");
  i = by.get(`${DERIVE_PIN}|D_DEADBEEF`);
  assert.ok(!i.exemplar && i.evidence[0].includes("raw cartridge offset"));
  assert.equal(by.get(`${MIGRATE_SYMBOL}|D_80000560`).section, ".main_bss");
  assert.equal(by.get(`${WHITELIST_CANDIDATE}|D_A4040010`).rank.kind, "declaration");
  assert.ok(by.has(`${WHITELIST_CANDIDATE}|osTvType`));
  assert.ok(!p.items.some((x) => x.subject === "SP_STATUS"));
  assert.ok(by.has(`${INVESTIGATE}|rom:0x0000a0`) && !by.has(`${INVESTIGATE}|rom:0x0000b0`));
  assert.ok(by.get(`${INVESTIGATE}|rom:0x0000c4`).conviction);
  i = by.get(`${DERIVE_PIN}|D_80000600`);
  assert.ok(i.exemplar && i.evidence[0].includes("VRAM end of .main_bss"));
  assert.ok(by.has(`${INVESTIGATE}|D_C0FFEE00`));
  assert.ok(by.get(`${DUAL_SPELLING_RISK}|text-regions`).evidence[0].includes("lui/%lo"));
  assert.ok(by.has(`${DUAL_SPELLING_RISK}|stale-unattributed`));
  i = by.get(`${STRUCTURAL}|vram:0x80010000`);
  assert.ok(i.rank.kind === "parked" && i.evidence[0].includes(".ovl_a, .ovl_b"));
  assert.ok(!by.has(`${STRUCTURAL}|vram:0x80000500`));
  assert.ok(by.get(`${STRUCTURAL}|blob-segments`).evidence[0].includes(".assets"));
});

test("merging: one subject in one class is one job; statics convicted by a relink; deltas and gates collapse", () => {
  const p = plan();
  const m = p.items.filter((i) => i.subject === "D_80000540");
  assert.equal(m.length, 1);
  assert.deepEqual([...m[0].sources].sort(), ["audit-pin", "rehearse-stale", "shadowing"]);
  const s = p.items.find((i) => i.subject === "D_80000560");
  assert.ok(s.sources.includes("audit-pin") && s.sources.includes("rehearse-symbol") && s.conviction);
  const doubled = plan({ rehearsals: [REHEARSE, { ...REHEARSE, delta: 0x40 }] });
  const d = doubled.items.find((i) => i.subject === "D_80000540");
  assert.deepEqual(d.deltas, [0x10, 0x40]);
  assert.ok(d.evidence.some((l) => l.includes("confirmed at deltas 0x10, 0x40")));
  assert.equal(d.gates.length, 3);
  for (const g of ["shift config verify", "shift rehearse analyze", "shift audit"]) assert.ok(d.gates.some((x) => x.includes(g)), g);
});

test("ordering: convictions lead, class order holds, structural last, sections grouped, exemplars lead, stable", () => {
  const p = plan();
  const flags = p.items.map((i) => i.conviction);
  assert.deepEqual(flags, [...flags].sort((a, b) => Number(b) - Number(a)));
  const ranks = p.items.filter((i) => i.conviction).map((i) => i.rank.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(p.items[p.items.length - 1].remediation, STRUCTURAL);
  const sections = p.items.filter((i) => i.remediation === MIGRATE_SYMBOL).map((i) => i.section);
  assert.deepEqual(sections, sorted(sections, (x) => x || "~"));
  const ex = p.items.filter((i) => i.remediation === DERIVE_PIN).map((i) => i.exemplar);
  assert.deepEqual(ex, [...ex].sort((a, b) => Number(b) - Number(a)));
  assert.deepEqual(p.items.map((i) => i.subject), plan().items.map((i) => i.subject));
});

test("report shape: census keys add up, every class present, tables travel, caps and the loop printed", () => {
  const p = plan(), j = p.asDict({ limit: 5 });
  const counts = j.plan_by_class;
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), j.plan_total);
  assert.equal(j.plan_free_wins, counts[DELETE_REDUNDANT_PIN]);
  assert.equal(j.plan_structural, counts[STRUCTURAL]);
  assert.deepEqual(new Set(Object.keys(counts)), new Set(REMEDIATION_CLASSES.map((r) => r.name)));
  assert.deepEqual(j.remediation_classes.map((r) => r.name), REMEDIATION_CLASSES.map((r) => r.name));
  assert.deepEqual(j.plan_rules.map((r) => r.name), PLAN_RULES.map((r) => r.name));
  const text = planLines(p, { limit: 3 }).join("\n");
  assert.ok(text.includes(`queue (3 of ${p.total}, --limit)`) && text.includes("the loop:") && text.includes("shift config verify"));
  const emitted = new Set(Object.keys(j));
  for (const k of ["plan_items", "remediation_classes", "plan_rules"]) for (const row of j[k]) for (const x of Object.keys(row)) emitted.add(x);
  for (const k of emitted) assert.ok(k in SHIFT_METRICS_BY_KEY, k);
});

test("capped reports say which part they planned; a report without the symbol census is a gap", () => {
  const capped = buildPlan({ audit: { ...AUDIT, pins_shown: 3, hits_shown: 0, scan_high: 9 }, rehearsals: [{ ...REHEARSE, stale_shown: 0 }] });
  assert.ok(capped.capped.length);
  const text = planLines(capped, { limit: 3 }).join("\n");
  assert.ok(text.includes("plan_capped") && text.includes("larger --limit"));
  const without = buildPlan({ audit: AUDIT, rehearsals: [{ ...REHEARSE, symbol_census: false }] });
  assert.ok(without.capped.some((c) => c.includes("symbol census")));
});

test("markdown work order: loop and placeholders on top, headings with gates, checkboxes, subheads, convictions, closing note", () => {
  const text = planMarkdown(plan());
  const head = text.split("\n");
  assert.ok(head.slice(0, 5).some((l) => l.includes("**The loop.**")));
  const items = plan().items;
  for (const r of REMEDIATION_CLASSES) if (items.some((i) => i.remediation === r.name)) assert.ok(text.includes(`## ${r.name}`), r.name);
  assert.ok(text.includes("**Gate:**") && text.includes("- [ ] **#1 ") && text.includes("### .main_bss"));
  assert.ok(text.includes("  - gate: `decomp-workbench shift config verify") && text.includes("**(conviction)**"));
  assert.ok(head.slice(0, 8).some((l) => l.includes("**Placeholders.**")) && head.slice(0, 8).some((l) => l.includes("<rebuilt>")));
  assert.ok(text.includes("evidence with coordinates attached"));
});

test("markdown gates: re-audit and re-rehearse point at the rebuild; the identity gate keeps its baseline", () => {
  const text = planMarkdown(plan());
  const pre = ["build/game.map", "build/game.z64", "build/game.elf", "shift/game.map", "shift/game.z64", "shift/game.elf"];
  let sawAudit = false, sawRehearse = false;
  for (const line of text.split("\n")) {
    if (line.includes("gate: `decomp-workbench shift audit")) {
      sawAudit = true;
      assert.ok(line.includes("<rebuilt>.map") && line.includes("<rebuilt>.z64") && line.includes("<rebuilt>.elf"));
      for (const p of pre) assert.ok(!line.includes(p));
    } else if (line.includes("gate: `decomp-workbench shift rehearse analyze") && !line.includes("--delta 0x")) {
      continue;
    } else if (line.includes("gate: `decomp-workbench shift rehearse analyze")) {
      sawRehearse = true;
      for (const s of ["<rebuilt-base>.map", "<rebuilt-base>.z64", "<rebuilt-shifted>.map", "<rebuilt-shifted>.z64"]) assert.ok(line.includes(s));
      for (const p of pre) assert.ok(!line.includes(p));
    }
  }
  assert.ok(sawAudit && sawRehearse);
  const identity = text.split("\n").filter((l) => l.includes("gate: `decomp-workbench shift config verify"));
  assert.ok(identity.length);
  for (const l of identity) for (const s of ["--pinned-map build/game.map", "--pinned-image build/game.z64", "--candidate-map <rebuilt>.map", "--candidate-image <rebuilt>.z64"]) assert.ok(l.includes(s), s);
});

async function withReports(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "romdev-wb-plan-"));
  try {
    writeFileSync(path.join(root, "audit.json"), JSON.stringify(AUDIT));
    writeFileSync(path.join(root, "rehearse.json"), JSON.stringify(REHEARSE));
    writeFileSync(path.join(root, "junk.json"), "not json");
    return await fn((n) => path.join(root, n));
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const runPlan = (...a) => runCommand(["shift", "plan", "--pager", "never", "--width", "unlimited", ...a]);

test("command: audit alone, repeatable rehearsals, wrong schema and non-JSON refused, markdown export, census", () => withReports(async (p) => {
  let r = await runPlan("--audit", p("audit.json"));
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("plan_total="));
  r = await runPlan("--audit", p("audit.json"), "--rehearse", p("rehearse.json"), "--rehearse", p("rehearse.json"), "--json");
  const j = JSON.parse(r.stdout);
  assert.deepEqual([r.code, j.schema, j.rehearse_reports.length], [0, SHIFT_PLAN_SCHEMA, 2]);
  r = await runPlan("--audit", p("rehearse.json"));
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("carries schema") && r.stderr.includes(AUDIT_SCHEMA));
  r = await runPlan("--audit", p("junk.json"));
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("is not JSON"));
  r = await runPlan("--audit", p("audit.json"), "--rehearse", p("rehearse.json"), "--markdown", p("WORK-ORDER.md"));
  assert.equal(r.code, 0);
  assert.ok(r.stderr.includes("wrote work order"));
  assert.ok(readFileSync(p("WORK-ORDER.md"), "utf8").includes("# Shift remediation work order"));
  r = await runPlan("--audit", p("audit.json"), "--census", "plan_free_wins=99");
  assert.equal(r.code, 3);
  assert.ok(r.stdout.includes("census: FAIL"));
  r = await runPlan("--audit", p("audit.json"), "--rehearse", p("rehearse.json"), "--census", "plan_convictions=6,plan_free_wins=1,plan_structural=2");
  assert.equal(r.code, 0, r.stdout + r.stderr);
}));
