// Port of pycparser tests/test_general.py.
//
// Upstream's c_files fixtures and utils/fake_libc_include (pycparser b5c6024)
// are copied under fixtures/. use_cpp cases run through romdev's WASM cpp
// (see cpp.js); nothing is spawned on the host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse_file, c_ast } from "../src/index.js";
import { parse_file_with_cpp, C_FILES, FAKE_LIBC, CPP_SKIP } from "./cpp.js";

const cFile = (name) => fileURLToPath(new URL("./fixtures/c_files/" + name, import.meta.url));
const missing = (name) => (existsSync(cFile(name)) ? false : `upstream fixture c_files/${name} is not shipped with the vendored fork`);

test("without cpp", { skip: missing("example_c_file.c") }, () => {
  const ast = parse_file(cFile("example_c_file.c"));
  assert.ok(ast instanceof c_ast.FileAST);
});

test("with cpp", { skip: CPP_SKIP }, async () => {
  const ast = await parse_file_with_cpp(cFile("memmgr.c"), ["-I" + C_FILES]);
  assert.ok(ast instanceof c_ast.FileAST);
  const ast2 = await parse_file_with_cpp(cFile("year.c"), ["-I" + FAKE_LIBC]);
  assert.ok(ast2 instanceof c_ast.FileAST);
});

test("cpp funkydir", async () => {
  // Upstream: "This test contains Windows specific path escapes" and returns
  // early on every other platform; mirrored exactly.
  if (process.platform !== "win32") return;
  const ast = await parse_file_with_cpp(cFile("simplemain.c"), ["-I" + C_FILES]);
  assert.ok(ast instanceof c_ast.FileAST);
});

test("no real content after cpp", { skip: CPP_SKIP }, async () => {
  const ast = await parse_file_with_cpp(cFile("empty.h"));
  assert.ok(ast instanceof c_ast.FileAST);
});

test("c11 with cpp", { skip: CPP_SKIP }, async () => {
  const ast = await parse_file_with_cpp(cFile("c11.c"), ["-I" + FAKE_LIBC]);
  assert.ok(ast instanceof c_ast.FileAST);
});

test("use_cpp without a preprocess function is refused", () => {
  assert.throws(() => parse_file(cFile("empty.h"), { use_cpp: true }), /preprocess/);
});
