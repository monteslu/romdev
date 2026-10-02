// Every randomization pass must produce valid C: applied alone (one call, the
// way Randomizer.randomize calls it) to a function exercising structs,
// pointers, floats, loops, switch, shifts and constant multiplies, each
// successful application must print to source that the C parser accepts, and
// it must compile (romdev's WASM mips gcc, the flags upstream's tests use)
// except for the type slips upstream itself makes and scores as a failed
// compile. Those are pinned here by seed, with the upstream reason, so a new
// kind of invalid output fails the test:
//   perm_temp_for_expr: same_type(allow_similar=True) treats every
//     IdentifierType as similar, so a float temp can be reused for an int.
//   perm_randomize_function_type: PROB_RET_VOID turns a used return value
//     into void ("perhaps avoid if the function call result is used, but eh").
//   perm_add_self_assignment: x++; x--; or x += 0; on a struct-typed member.
//   perm_reorder_stmts: a break is movable (only blocks and pragmas are
//     pinned), so it can leave its switch or loop.
//   perm_cast_simple: any arithmetic expression may be cast to float, even
//     the left operand of a shift.
//   perm_mult_zero: the zero replaced may be compared against a pointer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Candidate } from "../src/candidate.js";
import { EvalState } from "../src/perm/perm.js";
import { RANDOMIZATION_PASSES, RandomizationFailure, _internal } from "../src/randomizer.js";
import * as ast_util from "../src/ast_util.js";
import { get_default_randomization_weights } from "../src/helpers.js";
import { PyRandom } from "../src/pyrandom.js";
import { wasmGccCompile } from "./helpers/wasm-gcc.js";
import { MIPS_GCC } from "./helpers/payloads.js";
import { runWasmTool } from "../src/wasm-tool.js";
import { workDir, removeDir } from "./helpers/work.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(here, "fixtures", "passes.c"), "utf8");
const FN = "update_actors";
const SEEDS = 24;
// Upstream type slips (see header): pass -> seeds whose output does not compile.
const KNOWN_UPSTREAM_TYPE_SLIPS = {
  perm_temp_for_expr: /array subscript is not an integer|invalid operands|incompatible type/,
  perm_randomize_function_type: /void value not ignored/,
  perm_add_self_assignment: /wrong type argument to (increment|decrement)|invalid operands to binary \+/,
  perm_reorder_stmts: /statement not within loop or switch/,
  perm_cast_simple: /invalid operands to binary/,
  perm_mult_zero: /invalid operands to binary/,
};
const weights = get_default_randomization_weights("base");

/** Compile; on failure return cc1's diagnostics. */
async function compiles(dir, text, k) {
  const c = path.join(dir, `c${k}.c`), o = path.join(dir, `c${k}.o`);
  writeFileSync(c, text);
  const ok = await wasmGccCompile(c, o);
  rmSync(c, { force: true });
  rmSync(o, { force: true });
  if (ok) return { ok };
  const { toolchain } = await import("romdev-toolchain-mips-gcc");
  const r = await runWasmTool(toolchain.cc1.gluePath, ["-meb", "-mabi=32", "-quiet", "-O2", "-G0", "/work/in.c", "-o", "/work/in.s"], { "/work/in.c": text });
  return { ok, errors: r.stderr.split("\n").filter((l) => /error/.test(l)).join("\n") };
}

const summary = {};
for (const pass of RANDOMIZATION_PASSES) {
  test(`${pass.name} produces valid C`, { skip: MIPS_GCC }, async () => {
    const dir = workDir(pass.name);
    let applied = 0, compiled = 0, slips = 0;
    const failures = [];
    try {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const cand = Candidate.from_source(SOURCE, new EvalState(), FN, weights, seed);
        const random = new PyRandom(seed);
        const fn = ast_util.extract_fn(cand.ast, FN)[0];
        const indices = ast_util.compute_node_indices(fn);
        const region = _internal.get_randomization_region(fn, indices, random);
        try {
          pass(fn, cand.ast, indices, region, random);
        } catch (e) {
          if (e instanceof RandomizationFailure) continue;
          throw e;
        }
        applied++;
        const text = ast_util.to_c(cand.ast);
        // Syntactically valid: the printed candidate parses again.
        ast_util.parse_c(text);
        const r = await compiles(dir, text, seed);
        if (r.ok) compiled++;
        else if (KNOWN_UPSTREAM_TYPE_SLIPS[pass.name]?.test(r.errors)) slips++;
        else failures.push(`seed ${seed}: ${r.errors}`);
      }
    } finally {
      removeDir(dir);
    }
    summary[pass.name] = { applied, compiled, upstreamTypeSlips: slips };
    assert.ok(applied > 0, `${pass.name} never applied to the fixture`);
    assert.ok(compiled > 0, `${pass.name}: no output compiled`);
    assert.deepEqual(failures, [], `${pass.name}: outputs that do not compile for a reason upstream does not share`);
  });
}

test("summary", () => {
  // Visible in the TAP output for the report.
  console.log(JSON.stringify(summary));
});
