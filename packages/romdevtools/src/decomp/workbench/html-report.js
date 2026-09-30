// html-report.js - self-contained, accessible HTML reports built from the
// same view model the terminal renders: hunks, lanes and webs, inline CSS, no
// script, no network. Anchors and <details> carry the interactivity.
//
// Plain JS ESM + JSDoc.

import { MATCH } from "./view.js";
import { dumps } from "./pyjson.js";
import { hex, fixed, sorted } from "./py.js";

export const WEB_HUES = ["#1f8a8a", "#a8760a", "#9333a8", "#2f8a3c", "#2563c7", "#c0392b"];

export const STYLE = `
:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
body { max-width: 92rem; margin: 0 auto 4rem; padding: 0 1rem 2rem; line-height: 1.45; }
h1, h2, h3 { line-height: 1.15; scroll-margin-top: 6rem; }
a { color: inherit; text-underline-offset: .15em; }
a:focus-visible, summary:focus-visible {
  outline: 3px solid Highlight;
  outline-offset: 3px;
}
.skip-link {
  position: absolute;
  left: .75rem;
  top: -4rem;
  z-index: 20;
  background: Canvas;
  padding: .5rem;
}
.skip-link:focus { top: .75rem; }
.verdict-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  background: Canvas;
  border-bottom: 1px solid #8886;
  padding: .75rem 0 .5rem;
  margin-bottom: 1rem;
}
.verdict { font-size: 1.15rem; font-weight: 700; margin: 0; }
.summary { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .4rem; }
.chip {
  border: 1px solid #8888;
  border-radius: 999px;
  padding: .1rem .6rem;
  font-size: .85rem;
}
.chip.score { border-color: #2f8a3c; }
.proof {
  border-left: .25rem solid #b76b20;
  padding: .4rem 1rem;
  background: #b76b2012;
}
.warning {
  border-left: .25rem solid #c0392b;
  background: #c0392b18;
  padding: .5rem 1rem;
  font-weight: 600;
}
.table-scroll { max-width: 100%; overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1.5rem; }
th, td {
  border-bottom: 1px solid #8885;
  padding: .3rem .45rem;
  text-align: left;
  vertical-align: top;
}
th { background: Canvas; font-size: .85rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
pre { overflow: auto; padding: 1rem; background: #8881; }
td.num {
  text-align: right;
  width: 4rem;
  opacity: .55;
  font-variant-numeric: tabular-nums;
}
td.asm { white-space: pre; }
tr.context td.asm { opacity: .6; }
tr.diverge { background: #d77b1614; }
tr.diverge td.num { opacity: 1; font-weight: 700; }
.hunk { margin: 0 0 2rem; }
.hunk h3 { margin-bottom: .2rem; }
.meta { font-size: .85rem; opacity: .8; margin: 0 0 .4rem; }
.lanes { overflow-x: auto; }
.lanes table { width: auto; }
.lanes td, .lanes th { border: 0; padding: .1rem .35rem; white-space: pre; }
.lanes td.slot-diverge { outline: 2px solid #c0392b; border-radius: .2rem; }
.lanes tr.caret td { font-size: .8rem; opacity: .85; }
.web { font-weight: 700; text-decoration: none; }
.swatch {
  display: inline-block;
  width: .7rem;
  height: .7rem;
  border-radius: .15rem;
  margin-right: .35rem;
}
.annot { font-size: .85rem; white-space: nowrap; }
li.lever code { background: #8881; padding: .1rem .35rem; border-radius: .2rem; }
ol li { margin-bottom: .3rem; }
@media print {
  details > * { display: block !important; }
  details > summary { display: none !important; }
  .verdict-bar { position: static; }
}
`;

/** html.escape(text, quote=True). */
export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** Wrap one report in the shared accessible, offline document shell. */
export function documentShell(title, body, payload, { evidence_label = "Machine-readable evidence", extra_style = "" } = {}) {
  const serialized = escapeHtml(dumps(payload));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#202124">
<title>${escapeHtml(title)}</title>
<style>${STYLE}\n${extra_style}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to report</a>
<main id="main-content">
${body}
<details open><summary>${escapeHtml(evidence_label)}</summary>
<pre id="report">${serialized}</pre>
</details>
</main>
</body>
</html>
`;
}

const hue = (n) => WEB_HUES[(((n - 1) % WEB_HUES.length) + WEB_HUES.length) % WEB_HUES.length];
const swatch = (n) => `<span aria-hidden="true" class="swatch" style="background:${hue(n)}"></span>`;
const rng = (v) => (v === null || v === undefined ? "none" : `${v[0]}..${v[1]}`);
const bytes = (v) => (v === null || v === undefined ? "none" : `0x${hex(v[0])}..0x${hex(v[1])}`);
const pairKey = (p) => `${p[0]}\u0000${p[1]}`;

function annotationCell(row, webs) {
  if (row.classification === MATCH) return "";
  const parts = [];
  for (const pair of row.substitutions) {
    const number = webs.get(pairKey(pair));
    const label = escapeHtml(`${pair[0]}->${pair[1]}`);
    if (number === undefined) { parts.push(`<span>${label}</span>`); continue; }
    parts.push(`<a href="#web-${number}" class="web" style="color:${hue(number)}">${swatch(number)}${label} [w${number}]</a>`);
  }
  return parts.join(" ") || escapeHtml(row.classification);
}

function hunkSection(view, hunk, webs, { context }) {
  const low = Math.max(0, hunk.start - context);
  const high = Math.min(view.rows.length - 1, hunk.end + context);
  const rows = view.rows.slice(low, high + 1).map((row) => {
    const inside = hunk.start <= row.index && row.index <= hunk.end;
    return `<tr class="${inside ? "diverge" : "context"}"><td class="num">${row.index}</td>`
      + `<td class="asm"><code>${escapeHtml(row.target || "-")}</code></td>`
      + `<td class="asm"><code>${escapeHtml(row.candidate || "-")}</code></td>`
      + `<td class="annot">${annotationCell(row, webs)}</td></tr>`;
  });
  const meta = [`class=${escapeHtml(hunk.classification)}`, `rows=${hunk.start}..${hunk.end}`, `target=${rng(hunk.target_range)}`,
    `candidate=${rng(hunk.candidate_range)}`, `target_bytes=${bytes(hunk.target_bytes)}`].join(" &middot; ");
  return `<section class="hunk" id="hunk-${hunk.hunk}">
<h3><a href="#hunk-${hunk.hunk}">Hunk ${hunk.hunk}</a></h3>
<p class="meta">${meta}</p>
<div class="table-scroll"><table>
<caption>Aligned instructions for hunk ${hunk.hunk}</caption>
<thead><tr>
<th scope="col">#</th><th scope="col">Target</th>
<th scope="col">Candidate</th><th scope="col">Substitution</th>
</tr></thead>
<tbody>${rows.join("")}</tbody>
</table></div>
</section>`;
}

function laneCells(values, total, diverge) {
  const cells = [];
  for (let slot = 0; slot < total; slot++) {
    const text = slot < values.length ? values[slot] : "-";
    cells.push(`<td${slot === diverge ? ' class="slot-diverge"' : ""}>${escapeHtml(text)}</td>`);
  }
  return cells.join("");
}

function lanesSection(view) {
  if (!view.lanes.length) return "";
  const blocks = view.lanes.map((lane) => {
    const total = Math.max(lane.target.length, lane.candidate.length, 1);
    let detail;
    if (lane.divergence === null || lane.divergence === undefined) detail = `identical ${lane.target.length}/${total}`;
    else {
      detail = `slot=${lane.divergence} aligned_row=${lane.divergence_row}`;
      if (lane.rotation) detail += ` rotation=+${lane.rotation}`;
    }
    return `<h3>${escapeHtml(lane.classification)}</h3>
<div class="lanes"><table>
<caption>${escapeHtml(lane.classification)} register lane</caption>
<tbody>
<tr><th scope="row">target</th>
${laneCells(lane.target, total, lane.divergence)}</tr>
<tr><th scope="row">candidate</th>
${laneCells(lane.candidate, total, lane.divergence)}</tr>
<tr class="caret"><th scope="row"></th>
<td colspan="${total}">${escapeHtml(detail)}</td></tr>
</tbody>
</table></div>`;
  });
  return '<h2>Register lanes</h2><p class="meta">Per-class assignment sequences, matching instructions included.</p>' + blocks.join("");
}

function websSection(view, hunkOfRow) {
  if (!view.webs.length) return "";
  const rows = view.webs.map((web, i) => {
    const number = i + 1;
    const hunks = sorted([...new Set(web.rows.filter((r) => hunkOfRow.has(r)).map((r) => hunkOfRow.get(r)))]);
    const links = hunks.map((h) => `<a href="#hunk-${h}">hunk ${h}</a>`).join(", ") || "context only";
    return `<tr id="web-${number}"><td class="web" style="color:${hue(number)}">${swatch(number)}${escapeHtml(web.web)}</td>`
      + `<td><code>${escapeHtml(web.target)} &rarr; ${escapeHtml(web.candidate)}</code></td>`
      + `<td class="num">${web.count}</td><td>${links}</td><td class="annot">${escapeHtml(web.rows.join(","))}</td></tr>`;
  });
  return `<h2>Webs</h2>
<p class="meta">One consistent substitution may explain many sites.</p>
<div class="table-scroll"><table>
<caption>Consistent register substitutions</caption>
<thead><tr>
<th scope="col">Web</th><th scope="col">Substitution</th>
<th scope="col">Sites</th><th scope="col">Hunks</th><th scope="col">Rows</th>
</tr></thead>
<tbody>${rows.join("")}</tbody>
</table></div>`;
}

export const LEVER_RE = /^\s*lever (\d+):\s*(.+)$/;
export const COMMAND_RE = /decomp-workbench [a-z0-9 <>|\-]+/g;

function guidanceItem(line) {
  const lever = LEVER_RE.exec(line);
  if (lever) return `<li class="lever"><code>decomp-workbench guide ${lever[1]}</code> &mdash; ${escapeHtml(lever[2])}</li>`;
  return `<li>${escapeHtml(line).replace(COMMAND_RE, (m) => `<code>${m}</code>`)}</li>`;
}

function identityChip(view) {
  const total = view.aligned_rows;
  if (!total) return "";
  const identical = view.counts[MATCH] ?? 0;
  return `<span class="chip score">aligned identical ${identical}/${total} (${fixed(100.0 * identical / total, 1)}%; not decomp.me&rsquo;s score)</span>`;
}

/** Render the aligned view and optional exact comparator in one file. */
export function renderDiagnosisHtml(view, { comparison = null, report_regs = false, context = 2 } = {}) {
  const payload = { schema: "decomp-workbench-html-diagnosis-v1", view: view.asDict({ report_regs }), comparison: comparison ? comparison.asDict() : null };
  const webs = new Map(view.webs.map((w, i) => [pairKey([w.target, w.candidate]), i + 1]));
  const hunkOfRow = new Map();
  for (const hunk of view.hunks) for (let r = hunk.start; r <= hunk.end; r++) hunkOfRow.set(r, hunk.hunk);
  const guidance = view.guidance.map(guidanceItem).join("");
  const chips = Object.entries(view.counts).filter(([, c]) => c).map(([n, c]) => `<span class="chip">${escapeHtml(n)}=${c}</span>`).join("");
  const warnings = view.warnings.map((w) => `<p class="warning">warning: ${escapeHtml(w)}</p>`).join("");
  const exact = comparison ? comparison.exact : view.verdict === "exact";
  const proof = exact ? "Function-level exact object evidence. Whole-project link, ROM, and collateral verification still remain."
    : "Diagnostic evidence only; this report does not claim a source match.";
  const webSummary = view.webs.map((web, i) => `<a href="#web-${i + 1}" class="web" style="color:${hue(i + 1)}">${swatch(i + 1)}${escapeHtml(web.web)} `
    + `${escapeHtml(web.target)}&rarr;${escapeHtml(web.candidate)} &times;${web.count}</a>`).join(" &middot; ");
  const hunks = view.hunks.map((h) => hunkSection(view, h, webs, { context })).join("");
  const signature = escapeHtml(view.signature.join(" ")) || "none";
  const body = `
<div class="verdict-bar">
<p class="verdict">verdict: ${escapeHtml(view.verdict)}
&middot; playbook=${escapeHtml(view.playbook)}</p>
<div class="summary">
${identityChip(view)}${chips}
<span class="chip">signature: ${signature}</span>
</div>
</div>
<h1>${escapeHtml(view.symbol || "Aligned function diagnosis")}</h1>
${warnings}
<p><code>${escapeHtml(view.target)}</code> &harr;
<code>${escapeHtml(view.candidate)}</code></p>
${webSummary ? `<p class="meta">webs: ${webSummary}</p>` : ""}
<p class="proof">${escapeHtml(proof)}</p>
${lanesSection(view)}
<h2>Aligned hunks</h2>
${hunks || '<p class="meta">No hunks: nothing diverged.</p>'}
${websSection(view, hunkOfRow)}
<h2>Next actions</h2><ol>${guidance}</ol>
`;
  return documentShell("decomp-workbench diagnosis", body, payload);
}
