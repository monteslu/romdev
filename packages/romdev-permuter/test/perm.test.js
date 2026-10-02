// Port of upstream test/test_perm.py: PERM macro behaviour end to end. Each
// case compiles a target, writes base.c, runs the permuter with
// --stop-on-zero and checks the best score. Upstream compiles with a host
// mips-linux-gnu-gcc (test/compile.sh); this runs the same flags through
// romdev's WASM mips gcc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { run } from "../src/main.js";
import { Compiler } from "../src/compiler.js";
import { wasmGccCompile } from "./helpers/wasm-gcc.js";
import { workDir, removeDir } from "./helpers/work.js";
import { MIPS_GCC_SCORER } from "./helpers/payloads.js";

// Every case compiles through the WASM mips gcc and scores with its objdump;
// without that payload they skip with the reason.
const skip = MIPS_GCC_SCORER;

async function go(intro, outro, base, target, { fn_name = null, ...kwargs } = {}) {
  base = intro + "\n" + base + "\n" + outro;
  target = intro + "\n" + target + "\n" + outro;
  const dir = workDir("perm");
  try {
    const compiler = new Compiler(null, { show_errors: true, tmpDir: path.join(dir, ".cc"), compileFn: wasmGccCompile });
    writeFileSync(path.join(dir, "base.c"), base);
    const target_o = await compiler.compile(target, { show_errors: true });
    assert.ok(target_o != null, "target compiles");
    copyFileSync(target_o, path.join(dir, "target.o"));
    if (fn_name) writeFileSync(path.join(dir, "function.txt"), fn_name);
    const r = await run({ directories: [dir], stop_on_zero: true, compileModule: { url: new URL("./helpers/wasm-gcc.js", import.meta.url).href, name: "wasmGccCompile" }, out: () => {}, ...kwargs });
    return r.bestScores[0];
  } finally {
    removeDir(dir);
  }
}

test("general", { skip }, async () => {
  assert.equal(await go("int test() {", "}", "return PERM_GENERAL(32,64);", "return 64;"), 0);
});

test("not_found", { skip }, async () => {
  assert.notEqual(await go("int test() {", "}", "return PERM_GENERAL(32,64);", "return 92;"), 0);
});

test("multiple_functions", { skip }, async () => {
  const score = await go("", "", `
            int ignoreme() {}
            int foo() { return PERM_GENERAL(32,64); }
            int ignoreme2() {}
            `, "int foo() { return 64; }", { fn_name: "foo" });
  assert.equal(score, 0);
});

test("general_multiple", { skip }, async () => {
  assert.equal(await go("int test() {", "}", "return PERM_GENERAL(1,2,3) + PERM_GENERAL(3,6,9);", "return 9;"), 0);
});

test("general_nested", { skip }, async () => {
  assert.equal(await go("int test() {", "}", "return PERM_GENERAL(1,PERM_GENERAL(100,101),3) + PERM_GENERAL(3,6,9);", "return 110;"), 0);
});

test("cast", { skip }, async () => {
  assert.equal(await go("int test(int a, int b) {", "}", "return a / PERM_GENERAL(,(unsigned int),(float)) b;", "return a / (float) b;"), 0);
});

test("cast_threaded", { skip }, async () => {
  assert.equal(await go("int test(int a, int b) {", "}", "return a / PERM_GENERAL(,(unsigned int),(float)) b;", "return a / (float) b;", { threads: 2 }), 0);
});

test("ignore", { skip }, async () => {
  assert.equal(await go("int test(int a, int b) {", "}", "PERM_IGNORE( return a / PERM_GENERAL(a, b); )", "return a / b;"), 0);
});

test("pretend", { skip }, async () => {
  const score = await go("int global;", "", `
            PERM_IGNORE( inline void foo() { )
            PERM_PRETEND( void foo(); void bar() { )
                PERM_RANDOMIZE(
                    global = 1;
                )
            PERM_IGNORE( } void bar() { )
                PERM_RANDOMIZE(
                    global = 2; foo();
                )
            }
            `, `
            inline void foo() { global = 1; }
            void bar() { foo(); global = 2; }
            `, { fn_name: "bar" });
  assert.equal(score, 0);
});

test("once1", { skip }, async () => {
  const score = await go("volatile int A, B, C; void test() {", "}", `
                PERM_ONCE(B = 2;)
                A = 1;
                PERM_ONCE(B = 2;)
                C = 3;
                PERM_ONCE(B = 2;)
            `, "A = 1; B = 2; C = 3;");
  assert.equal(score, 0);
});

test("once2", { skip }, async () => {
  const score = await go("volatile int A, B, C; void test() {", "}", `
                PERM_VAR(emit,)
                PERM_VAR(bademit,)
                PERM_ONCE(1, PERM_VAR(bademit, A = 7;) A = 2;)
                PERM_ONCE(1, PERM_VAR(emit, A = 1;))
                PERM_VAR(emit)
                PERM_VAR(bademit)
                PERM_ONCE(2, B = 2;)
                PERM_ONCE(2, B = 1;)
                PERM_ONCE(2,)
                PERM_ONCE(3, PERM_VAR(bademit, A = 9))
                PERM_ONCE(3, PERM_VAR(bademit, A = 9))
                C = 3;
            `, "A = 1; B = 2; C = 3;");
  assert.equal(score, 0);
});

test("lineswap", { skip }, async () => {
  const score = await go("void a(); void b(); void c(); void test(void) {", "}", `
            PERM_LINESWAP(
                a();
                b();
                c();
            )
            `, "b(); a(); c();");
  assert.equal(score, 0);
});

test("lineswap_text", { skip }, async () => {
  const score = await go("void a(); void b(); void c(); void test(void) {", "}", `
            PERM_LINESWAP_TEXT(
                a();
                b();
                c();
            )
            `, "b(); a(); c();");
  assert.equal(score, 0);
});

test("randomizer", { skip }, async () => {
  assert.equal(await go("void foo(); void bar(); void test(void) {", "}", "PERM_RANDOMIZE(bar(); foo();)", "foo(); bar();"), 0);
});

test("auto_randomizer", { skip }, async () => {
  assert.equal(await go("void foo(); void bar(); void test(void) {", "}", "bar(); foo();", "foo(); bar();"), 0);
});

test("randomizer_threaded", { skip }, async () => {
  assert.equal(await go("void foo(); void bar(); void test(void) {", "}", "PERM_RANDOMIZE(bar(); foo();)", "foo(); bar();", { threads: 2 }), 0);
});
