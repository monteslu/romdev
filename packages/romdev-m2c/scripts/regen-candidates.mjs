#!/usr/bin/env node
// Regenerate recorded m2c candidates (romdev decomp workspaces: candidates/<fn>/gen-N.{c,json})
// with the JS port, using the exact args recorded in each sidecar, and compare byte-for-byte.
// Usage: node scripts/regen-candidates.mjs <workspace-dir> [--verbose]
import fs from "node:fs";
import path from "node:path";
import { decompile } from "../src/main.js";

const root = process.argv[2];
const verbose = process.argv.includes("--verbose");
if (!root) {
  console.error("usage: regen-candidates.mjs <workspace-dir>");
  process.exit(2);
}

// Same split as romdevtools src/decomp/m2c.js splitM2cOutput
function splitM2cOutput(text) {
  const lines = text.split("\n");
  const declarations = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^\?\s+\w+\s*\(.*\)\s*;/.test(l) || /^extern\s+\?/.test(l) || (/^extern\s+[^(]*;$/.test(l) && /\?/.test(l))) {
      declarations.push(l);
      continue;
    }
    break;
  }
  return { declarations, body: lines.slice(i).join("\n") };
}

const candDir = path.join(root, "candidates");
let same = 0;
let differ = 0;
let skipped = 0;
const diffs = [];
for (const fn of fs.readdirSync(candDir).sort()) {
  const dir = path.join(candDir, fn);
  for (const f of fs.readdirSync(dir).filter((x) => /^gen-\d+\.json$/.test(x)).sort()) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const cfile = path.join(dir, f.replace(/\.json$/, ".c"));
    const args = (meta.args ?? []).slice(1); // drop m2c.py
    const missing = args.filter((a, k) => (k === args.length - 1 || args[k - 1] === "--context") && !fs.existsSync(a));
    if (!fs.existsSync(cfile) || missing.length) {
      skipped++;
      if (verbose) console.log(`SKIP ${fn}/${f}: missing ${missing.join(", ") || cfile}`);
      continue;
    }
    const r = await decompile(args);
    const parsed = splitM2cOutput(r.stdout);
    const text = parsed.body.trim() + "\n";
    const expected = fs.readFileSync(cfile, "utf8");
    const declsOk = JSON.stringify(parsed.declarations) === JSON.stringify(meta.declarations ?? parsed.declarations);
    if (text === expected && declsOk) same++;
    else {
      differ++;
      diffs.push(`${fn}/${f}${declsOk ? "" : " (declarations)"}`);
    }
  }
}
console.log(`candidates: ${same} identical, ${differ} different, ${skipped} skipped (inputs gone)`);
for (const d of diffs) console.log(`  DIFF ${d}`);
process.exit(differ ? 1 : 0);
