// Trace-to-source correlation keeps line-marker evidence and ambiguity
// honest. Ported from the workbench's source-correlation tests, plus the
// trace-source command.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGlobalcolorTrace } from "../src/decomp/workbench/globalcolor.js";
import { correlateTraceSource, parseLineMarkedSource, parseListingLocations } from "../src/decomp/workbench/source-correlation.js";
import { runCommand } from "../src/decomp/workbench/cli.js";

const TRACE = "[CDX] webdetail proc=7 web=9 role=target dtype=13 bb=4 line=2\n[CDX] p1dec phase=p1 proc=7 web=9 bestcolor=1 forbidden0=0 forbidden1=0\n";

test("line markers apply to the following physical line", () => {
  const lines = parseLineMarkedSource('# 40 "first.c" 1\nalpha\n#line 7 "second.c"\nbeta\n', { origin: "combined.i" });
  assert.deepEqual(lines.map((l) => [l.file, l.line, l.physical_line, l.text]), [["first.c", 40, 2, "alpha"], ["second.c", 7, 4, "beta"]]);
});

test("listing locations decode the file table without guessing unknowns", () => {
  const locs = parseListingLocations('.file 1 "candidate.c"\n.loc 1 12 3\n.loc 8 20\n');
  assert.equal(locs[0].file, "candidate.c");
  assert.equal(locs[0].column, 3);
  assert.equal(locs[1].file, null);
});

test("a duplicate include line is ambiguous until the file is selected", () => {
  const source = '# 2 "first.h"\nint first;\n# 2 "candidate.c"\nint candidate;\n';
  const trace = parseGlobalcolorTrace(TRACE);
  const ambiguous = correlateTraceSource(trace, { source_text: source, source_origin: "combined.i" });
  assert.equal(ambiguous.states.ambiguous, 1);
  assert.equal(ambiguous.correlated_webs, 0);
  const selected = correlateTraceSource(trace, { source_text: source, source_origin: "combined.i", source_file: "candidate.c", listing_text: '.file 1 "candidate.c"\n.loc 1 2 0\n' });
  const row = selected.webs[0];
  assert.equal(row.state, "selected");
  assert.equal(row.source_candidates[0].text, "int candidate;");
  assert.equal(row.listing_locations[0].file, "candidate.c");
  assert.ok(selected.proof.includes("never promoted"));
});

test("trace-source reports correlation, and exits 1 when nothing correlates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "romdev-wb-tsrc-"));
  try {
    const t = path.join(dir, "trace.log"), s = path.join(dir, "combined.i"), l = path.join(dir, "cand.s");
    fs.writeFileSync(t, TRACE);
    fs.writeFileSync(s, '# 2 "first.h"\nint first;\n# 2 "candidate.c"\nint candidate;\n');
    fs.writeFileSync(l, '.file 1 "candidate.c"\n.loc 1 2 0\n');
    const amb = await runCommand(["trace-source", t, s]);
    assert.equal(amb.code, 1);
    assert.ok(amb.stdout.includes("trace source: 0/1 web(s) correlated; 1 ambiguous, 0 unresolved"));
    const sel = await runCommand(["trace", "source", t, s, "--source-file", "candidate.c", "--listing", l]);
    assert.equal(sel.code, 0);
    assert.ok(sel.stdout.includes("state=selected"));
    assert.ok(sel.stdout.includes("  source candidate.c:2 int candidate;"));
    assert.ok(sel.stdout.includes("  listing line 2: candidate.c:2"));
    const json = await runCommand(["trace-source", t, s, "--json"]);
    assert.equal(JSON.parse(json.stdout).schema, "decomp-workbench-trace-source-v1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
