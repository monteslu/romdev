// Port of m2c's run_tests.py end-to-end runner (tests/end_to_end/**).
// Each case's asm input is decompiled in-process with the JS port and compared
// byte-for-byte against upstream's committed expected output.
//
// The corpus is read from the pinned upstream checkout: $M2C_SRC, else
// ~/.romdev/tools/m2c. Filter cases with M2C_FILTER=<regex> over names like
// "e2e:loop/irix-o2.s". Set M2C_E2E_SUMMARY=1 to print a pass/fail summary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decompile } from "../src/main.js";

const SRC = process.env.M2C_SRC || path.join(os.homedir(), ".romdev", "tools", "m2c");
const E2E = path.join(SRC, "tests", "end_to_end");
const PATH_FLAGS = new Set(["--context", "--incbin-dir"]);
const CRASH_STRING = "CRASHED\n";

/** Python shlex.split (POSIX mode) for the simple flag files used by the corpus. */
export function shlex_split(s) {
  const out = [];
  let cur = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (cur !== null) out.push(cur);
      cur = null;
      i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) throw new Error("No closing quotation");
      cur = (cur ?? "") + s.slice(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\" && j + 1 < s.length && '\\"$`\n'.includes(s[j + 1])) {
          buf += s[j + 1];
          j += 2;
        } else buf += s[j++];
      }
      if (j >= s.length) throw new Error("No closing quotation");
      cur = (cur ?? "") + buf;
      i = j + 1;
    } else if (c === "\\" && i + 1 < s.length) {
      cur = (cur ?? "") + s[i + 1];
      i += 2;
    } else if (c === "#" && cur === null) {
      while (i < s.length && s[i] !== "\n") i++;
    } else {
      cur = (cur ?? "") + c;
      i++;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

function get_test_flags(flags_path) {
  if (!fs.existsSync(flags_path)) return [];
  const flags_list = shlex_split(fs.readFileSync(flags_path, "utf8"));
  for (let i = 0; i < flags_list.length; i++) {
    if (!PATH_FLAGS.has(flags_list[i])) continue;
    if (i + 1 >= flags_list.length) throw new Error(`${flags_path} contains ${flags_list[i]} without argument`);
    flags_list[i + 1] = path.join(path.dirname(flags_path), flags_list[i + 1]);
  }
  return flags_list;
}

export function collect_cases() {
  const cases = [];
  if (!fs.existsSync(E2E)) return cases;
  for (const dir of fs.readdirSync(E2E).sort()) {
    const d = path.join(E2E, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith(".s")) continue;
      const stem = f.slice(0, -2);
      cases.push({
        name: `e2e:${dir}/${f}`,
        asm_file: path.join(d, f),
        output_file: path.join(d, `${stem}-out.c`),
        flags_path: path.join(d, `${stem}-flags.txt`),
      });
    }
  }
  cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return cases;
}

export async function run_case(c) {
  const flags = ["--sanitize-tracebacks", "--stop-on-error", "--function", "test", ...get_test_flags(c.flags_path), c.asm_file];
  const r = await decompile(flags);
  const out = r.stdout.replaceAll(SRC, ".");
  return r.code === 0 ? out : `${CRASH_STRING}\n${out}`;
}

const filter = process.env.M2C_FILTER ? new RegExp(process.env.M2C_FILTER) : null;
const cases = collect_cases().filter((c) => !filter || filter.test(c.name));
const results = { pass: 0, fail: 0, failed: [] };

if (!cases.length) {
  test("m2c e2e corpus", { skip: `no upstream checkout at ${SRC}` }, () => {});
}
for (const c of cases) {
  test(c.name, async () => {
    const expected = fs.readFileSync(c.output_file, "utf8");
    let actual;
    try {
      actual = await run_case(c);
    } catch (e) {
      results.fail++;
      results.failed.push(c.name);
      throw e;
    }
    if (actual === expected) results.pass++;
    else {
      results.fail++;
      results.failed.push(c.name);
    }
    assert.equal(actual, expected);
  });
}
if (process.env.M2C_E2E_SUMMARY) {
  test("summary", () => {
    process.stdout.write(`\nm2c e2e: ${results.pass} passed, ${results.fail} failed of ${cases.length}\n`);
    for (const n of results.failed) process.stdout.write(`  FAIL ${n}\n`);
  });
}
