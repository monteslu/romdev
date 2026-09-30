// context-truth.js - project, scratch, and site truth kept as independent
// evidence layers, plus the one tightly gated context hypothesis a scratch
// check may raise: an unused call return occupying v0/v1 because the scratch
// declares the callee void. Its output says "test", never "is": object shape
// is not proof of historical source spelling.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import { scratchScoreAcceptance } from "./comparison-render.js";
import { resolvePath } from "./py-path.js";
import { formatG } from "./globalcolor.js";
import { splitWs } from "./py.js";

const CALL_TARGET_RE = /<(?<name>[A-Za-z_][A-Za-z0-9_]*)[^>]*>/;
const DECLARATION_RE = /^\s*(?:extern\s+)?(?<type>void|int|signed\s+int|unsigned\s+int)\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*;/gm;

function acceptance(comparison) {
  if (comparison === null || comparison === undefined) return ["UNKNOWN", null];
  const [accepted] = scratchScoreAcceptance(comparison);
  return [accepted ? "PASS" : "FAIL", comparison.raw_word_mismatches];
}

function declarations(text) {
  const out = new Map();
  for (const m of text.matchAll(DECLARATION_RE)) out.set(m.groups.name, splitWs(m.groups.type).join(" ").toLowerCase());
  return out;
}

const scratchSource = (pkg) => ["ctx.c", "code.c"].filter((n) => pkgHas(pkg, n)).map((n) => pkg.text(n)).join("\n");
const pkgHas = (pkg, name) => (pkg.files instanceof Map || pkg.files instanceof Set ? pkg.files.has(name) : Array.isArray(pkg.files) ? pkg.files.includes(name) : !!pkg.files && Object.prototype.hasOwnProperty.call(pkg.files, name));

function c89Capable(frontend) {
  const language = (frontend.language || "").toLowerCase();
  const family = (frontend.frontend || "").toLowerCase();
  return !language.includes("++") && !family.includes("++") && ["c", "c89", "c90", "gnu89"].includes(language);
}

/** A tightly gated unused-return occupancy probe. */
export function callContractHypotheses({ package: pkg, scratch, view, project, project_source, frontend }) {
  if (scratch === null || scratch === undefined || view === null || view === undefined || scratch.exact || !c89Capable(frontend)
    || view.verdict !== "register-permutation" || scratch.aligned_register === 0
    || [scratch.aligned_structural, scratch.aligned_schedule, scratch.aligned_constant, scratch.aligned_commutative].some(Boolean)
    || view.webs.length !== 1) return [];
  const web = view.webs[0];
  const pair = new Set([web.target.replace(/^\$/, ""), web.candidate.replace(/^\$/, "")]);
  if (pair.size !== 2 || !pair.has("v0") || !pair.has("v1")) return [];
  const firstRow = web.rows.length ? Math.min(...web.rows) : -1;
  if (firstRow < 0 || firstRow < Math.max(1, Math.floor((view.aligned_rows * 2) / 3))) return [];
  let preceding = null;
  for (const row of view.rows) {
    if (row.index >= firstRow) break;
    const assembly = row.candidate || row.target || "";
    const opcode = assembly ? (splitWs(assembly, 1)[0] ?? "").toLowerCase() : "";
    const m = CALL_TARGET_RE.exec(assembly);
    if ((opcode === "jal" || opcode === "bal") && m) preceding = [row.index, m.groups.name];
  }
  if (preceding === null || firstRow - preceding[0] > 24) return [];
  const [callRow, callee] = preceding;
  if (declarations(scratchSource(pkg)).get(callee) !== "void") return [];
  const [projectStatus] = acceptance(project);
  let projectCategory = null;
  if (project_source !== null && project_source !== undefined) {
    const decls = declarations(fs.readFileSync(resolvePath(project_source), "utf8"));
    projectCategory = decls.get(callee) ?? "not-visible";
  }
  const evidence = [
    "scratch residual is register-only and opcode/temp-shape stable",
    `one coherent ${web.target}->${web.candidate} pool web spans ${web.count} row(s)`,
    `the web begins after direct call ${callee} at aligned row ${callRow}`,
    `scratch context declares ${callee} with return category void`,
  ];
  if (projectStatus === "PASS") evidence.push("the supplied project object is target-exact");
  if (projectCategory !== null) evidence.push(`project source declaration category is ${projectCategory}`);
  return [{
    kind: "unused-call-return-occupancy", status: "HYPOTHESIS",
    confidence: projectStatus === "PASS" && projectCategory !== null ? "measured-shape-and-context" : "measured-shape",
    callee, scratch_return_category: "void", project_return_category: projectCategory, register_web: web.asDict(), evidence,
    action: `Test one scratch-only \`int ${callee}();\` declaration variant; do not edit the project or infer the historical prototype unless the object result confirms it.`,
  }];
}

/** The concise three-layer truth report used by terminal and JSON. */
export function buildTruthStack({ external_score, scratch, project, hypotheses }) {
  const [scratchStatus, scratchWords] = acceptance(scratch);
  const [projectStatus, projectWords] = acceptance(project);
  const contextOnly = projectStatus === "PASS" && scratchStatus === "FAIL";
  const classification = contextOnly ? "context-only"
    : projectStatus === "PASS" && scratchStatus === "PASS" ? "both-exact"
    : projectStatus === "FAIL" ? "source-or-project-mismatch"
    : scratchStatus === "FAIL" ? "scratch-mismatch" : "unmeasured";
  return {
    classification,
    layers: [
      { id: "site-metadata", status: external_score !== null && external_score !== undefined ? "CONTEXT" : "NOT RUN", score: external_score ?? null },
      { id: "scratch-object", status: scratchStatus, raw_words: scratchWords },
      { id: "project-object", status: project !== null && project !== undefined ? projectStatus : "NOT RUN", raw_words: projectWords },
    ],
    context_differential: contextOnly
      ? { status: "MEASURED", classification: "context-only", raw_words: scratchWords,
        aligned_register: scratch ? scratch.aligned_register : null, aligned_structural: scratch ? scratch.aligned_structural : null }
      : { status: project === null || project === undefined || scratch === null || scratch === undefined ? "UNKNOWN" : "MEASURED", classification },
    context_hypotheses: hypotheses,
    next_action: hypotheses.length ? hypotheses[0].action : null,
  };
}

/** The compact truth stack printed before expert comparison details. */
export function truthStackLines(report) {
  const lines = [`truth: ${report.classification}`];
  const labels = { "site-metadata": "site metadata", "scratch-object": "scratch object", "project-object": "project object" };
  for (const layer of report.layers) {
    let detail = "";
    if (layer.id === "site-metadata" && layer.score) detail = ` score=${formatG(layer.score.score)}/${formatG(layer.score.max_score)}`;
    else if (layer.raw_words !== null && layer.raw_words !== undefined) detail = ` raw words=${layer.raw_words}`;
    lines.push(`  ${labels[layer.id].padEnd(15)} ${layer.status}${detail}`);
  }
  for (const h of report.context_hypotheses ?? []) {
    lines.push(`context hypothesis: unused call return occupancy (${h.callee}, confidence=${h.confidence})`);
    lines.push(`next: ${h.action}`);
  }
  return lines;
}
