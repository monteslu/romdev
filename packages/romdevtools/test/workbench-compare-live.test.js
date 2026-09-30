// Opt-in: the comparison half of every retained `object diagnose` report in
// the local wr64-us-rev1 workspace must be reproduced byte for byte from its
// recorded target and candidate objects. Reads only; writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dumpObject, selectionWarnings } from "../src/decomp/workbench/objdump.js";
import { compareInstructions, resolveTrueInstructions } from "../src/decomp/workbench/compare.js";
import { displayPath } from "../src/decomp/workbench/model.js";
import { dumps } from "../src/decomp/workbench/pyjson.js";
import { projectEnv } from "../src/decomp/project.js";

const WS = path.join(os.homedir(), ".romdev", "decomp", "wr64-us-rev1");
const enabled = process.env.ROMDEV_DECOMP_INTEGRATION === "1" && fs.existsSync(path.join(WS, "workbench"));

test("retained diagnosis comparisons reproduce byte for byte", { skip: !enabled }, () => {
  const m = JSON.parse(fs.readFileSync(path.join(WS, "manifest.json"), "utf8"));
  const env = { ...process.env, ...projectEnv(m) }, cwd = m.root, objdump = m.toolchain.objdump.path;
  let checked = 0;
  for (const f of fs.readdirSync(path.join(WS, "workbench"))) {
    const saved = JSON.parse(fs.readFileSync(path.join(WS, "workbench", f), "utf8"));
    if (saved.schema !== "decomp-workbench-diagnosis-v3") continue;
    const { target, candidate, symbol } = saved.comparison;
    if (!fs.existsSync(target) || !fs.existsSync(candidate)) continue;
    const [tt, ti] = dumpObject(target, { objdump, symbol, cwd, env });
    const [ct, ci] = dumpObject(candidate, { objdump, symbol, cwd, env });
    const tn = displayPath(target, cwd), cn = displayPath(candidate, cwd);
    const tTrue = resolveTrueInstructions(target, { symbol, section: ".text", cwd }), cTrue = resolveTrueInstructions(candidate, { symbol, section: ".text", cwd });
    const c = compareInstructions(ti, ci, { target_name: tn, candidate_name: cn, symbol, warnings: selectionWarnings(tt, ct, { symbol, target_name: tn, candidate_name: cn }),
      target_true_instructions: tTrue, candidate_true_instructions: cTrue, instruction_count_verified: tTrue !== null && cTrue !== null });
    const d = { ...c.asDict(), accepted: c.exact, acceptance_basis: c.exact ? "function-exact" : "mismatch" };
    assert.equal(JSON.stringify(JSON.parse(dumps(d)), null, 2), JSON.stringify(saved.comparison, null, 2), f);
    checked++;
  }
  assert.ok(checked > 0, "no retained diagnosis report was checked");
});
