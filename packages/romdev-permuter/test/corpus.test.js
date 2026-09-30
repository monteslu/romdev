// Oracle replay against upstream's own recorded outputs. A romdev decomp
// workspace keeps every search job the Python permuter ran: permuter.log
// ("base score = N"), and output-*/{source.c,score.txt,diff.txt}. Those files
// are upstream's answers, so this port must reproduce them:
//   1. the "before" side of each diff.txt (upstream's pretty-printed base
//      source, with line numbers) equals this port's printed base,
//   2. the whole diff.txt is reproduced byte for byte from the candidate,
//   3. (in romdevtools: test/decomp-permuter-corpus.test.js) compiling each
//      candidate through romdev's WASM toolchain and scoring it gives
//      upstream's score.txt / logged base score.
// The corpus is local data (never committed); without one the test skips.
// ROMDEV_PERMUTER_CORPUS may name a jobs directory; otherwise every
// ~/.romdev/decomp/<project>/jobs is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { perm_parse } from "../src/perm/parse.js";
import { perm_evaluate_one } from "../src/perm/eval.js";
import { Candidate } from "../src/candidate.js";
import { unified_diff } from "../src/difflib.js";
import { trim_source, get_default_randomization_weights, get_settings } from "../src/helpers.js";

function jobDirs() {
  const roots = process.env.ROMDEV_PERMUTER_CORPUS ? [process.env.ROMDEV_PERMUTER_CORPUS]
    : (() => {
      const base = path.join(os.homedir(), ".romdev", "decomp");
      if (!existsSync(base)) return [];
      return readdirSync(base).map((p) => path.join(base, p, "jobs")).filter(existsSync);
    })();
  const out = [];
  for (const r of roots) {
    for (const j of readdirSync(r)) {
      const pd = path.join(r, j, "permuter");
      if (existsSync(path.join(pd, "base.c")) && existsSync(path.join(pd, "settings.toml"))) out.push({ job: path.join(r, j), pd });
    }
  }
  return out;
}

const JOBS = jobDirs();
const strip = (s) => s.replace(/^\s+|\s+$/g, "");
const printed = new Map();

function baseSource(pd) {
  if (printed.has(pd)) return printed.get(pd);
  const settings = get_settings(pd);
  const fn = settings.func_name;
  const weights = get_default_randomization_weights(settings.compiler_type ?? "base");
  const [text, st] = perm_evaluate_one(perm_parse(readFileSync(path.join(pd, "base.c"), "utf8"), () => {}));
  const v = { fn, source: Candidate.from_source(text, st, fn, weights, 0).get_source() };
  printed.set(pd, v);
  return v;
}

/** The candidate upstream scored: source.c is either whole or trimmed at the function (--no-context-output). */
function reconstruct(base, fn, outputSource) {
  if (outputSource.startsWith(base.slice(0, 300))) return outputSource;
  const tail = trim_source(base, fn);
  return base.slice(0, base.length - tail.length) + outputSource;
}

const outputs = () => JOBS.flatMap(({ pd }) => readdirSync(pd).filter((d) => /^output-\d+-\d+$/.test(d)).map((o) => ({ pd, o })));

test("upstream's printed base source (diff.txt 'before' lines) is reproduced line for line", { skip: !JOBS.length && "no decomp corpus" }, () => {
  let checked = 0;
  for (const { pd, o } of outputs()) {
    const lines = baseSource(pd).source.split("\n");
    let a = null;
    for (const line of readFileSync(path.join(pd, o, "diff.txt"), "utf8").split("\n")) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
      if (h) { a = Number(h[1]) - (h[2] === "0" ? 0 : 1); continue; }
      if (a == null || line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith(" ") || line.startsWith("-")) {
        assert.equal(lines[a], line.slice(1), `${pd}/${o} line ${a + 1}`);
        a++;
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
});

test("upstream's diff.txt is reproduced byte for byte", { skip: !JOBS.length && "no decomp corpus" }, () => {
  let n = 0;
  for (const { pd, o } of outputs()) {
    const { fn, source } = baseSource(pd);
    const cand = reconstruct(source, fn, readFileSync(path.join(pd, o, "source.c"), "utf8"));
    const mine = unified_diff(source.split("\n"), cand.split("\n"), { fromfile: "before", tofile: "after", lineterm: "", key: strip }).join("\n") + "\n";
    assert.equal(mine, readFileSync(path.join(pd, o, "diff.txt"), "utf8"), `${pd}/${o}`);
    n++;
  }
  assert.ok(n > 0);
});
