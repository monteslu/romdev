#!/usr/bin/env node
// Runs upstream rabbitizer's instruction_checks test tables (dumped to JSON
// lines by scripts/build-rabbitizer.sh --test) through the JS binding:
// Instruction(word, 0, category).disassemble(immOverride) must equal the
// expected string, with config.toolchainTweaks_gnuMode set per entry exactly
// as upstream's check_expected_output() does.
//
// usage: node test/upstream-entries.mjs <version> <dir with *.jsonl>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRabbitizerSync } from "../src/index.js";

const [version, dir] = process.argv.slice(2);
if (!version || !dir) {
  console.error("usage: upstream-entries.mjs <version> <entries dir>");
  process.exit(2);
}

const rab = loadRabbitizerSync(version);
const categories = Object.values(rab.InstrCategory).filter((v) => v instanceof rab.Enum);
const byValue = new Map(categories.map((c) => [c.value, c]));

let total = 0;
let failed = 0;
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
if (files.length === 0) {
  console.error(`no .jsonl files in ${dir}`);
  process.exit(1);
}
for (const f of files) {
  const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
  let fileFailed = 0;
  for (const line of lines) {
    const e = JSON.parse(line);
    total++;
    rab.config.toolchainTweaks_gnuMode = e.gnuMode;
    const instr = new rab.Instruction(e.word, 0, byValue.get(e.category));
    const got = instr.disassemble(e.immOverride);
    if (e.expected === null || got !== e.expected) {
      fileFailed++;
      if (fileFailed <= 5) {
        console.error(`  ${f}: word 0x${e.word.toString(16).padStart(8, "0")} expected ${JSON.stringify(e.expected)} got ${JSON.stringify(got)}`);
      }
    }
  }
  rab.config.toolchainTweaks_gnuMode = true;
  failed += fileFailed;
  console.log(`  ${fileFailed === 0 ? "PASS" : "FAIL"} ${f}: ${lines.length - fileFailed}/${lines.length}`);
}
console.log(`  rabbitizer ${version} via JS binding: ${total - failed}/${total} upstream entries identical`);
if (total === 0 || failed !== 0) process.exit(1);
