// Port of pycparser tests/test_general.py.
//
// Every upstream case either reads a c_files fixture the vendored fork does
// not ship (example_c_file.c, memmgr.c, year.c, simplemain.c, c11.c) or runs
// `cpp`. This port spawns no host cpp and no JS C preprocessor is committed
// in the repo yet, so those cases are skipped with the reason. The shipped
// c_files (empty.h, memmgr.h, hdir/) are copied under fixtures/ for when a
// preprocessor lands; fake_libc_include is only used by the cpp cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse_file, c_ast } from "../src/index.js";

const cFile = (name) => fileURLToPath(new URL("./fixtures/c_files/" + name, import.meta.url));
const NO_CPP = "needs cpp; this port spawns no host cpp and no JS C preprocessor is committed in the repo";
const missing = (name) => (existsSync(cFile(name)) ? false : `upstream fixture c_files/${name} is not shipped with the vendored fork`);

test("without cpp", { skip: missing("example_c_file.c") }, () => {
  const ast = parse_file(cFile("example_c_file.c"));
  assert.ok(ast instanceof c_ast.FileAST);
});

test("with cpp", { skip: NO_CPP }, () => {});

test("cpp funkydir", { skip: "upstream only runs this on win32" }, () => {});

test("no real content after cpp", { skip: NO_CPP }, () => {});

test("c11 with cpp", { skip: NO_CPP }, () => {});

test("use_cpp without a preprocess function is refused", () => {
  assert.throws(() => parse_file(cFile("empty.h"), { use_cpp: true }), /preprocess/);
});
