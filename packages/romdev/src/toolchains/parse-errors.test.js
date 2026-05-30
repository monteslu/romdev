import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuildLog } from "./parse-errors.js";

test("cc65/ca65/ld65 errors are parsed with file/line", () => {
  const log = `
--- ca65 ---
/work/main.s:12: Error: Cannot open include file 'longbranch.mac'
/work/main.c:3:9: Warning: Symbol 'x' is unused
`;
  const issues = parseBuildLog(log);
  assert.ok(issues.length >= 2);
  const err = issues.find((i) => i.severity === "error");
  assert.ok(err);
  assert.equal(err.file, "/work/main.s");
  assert.equal(err.line, 12);
  assert.equal(err.stage, "ca65");
  const warn = issues.find((i) => i.severity === "warning");
  assert.ok(warn);
  assert.equal(warn.col, 9);
});

test("dasm errors parse cleanly", () => {
  const log = `
main.asm (1): error: Unknown Mnemonic 'is'.
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].line, 1);
  assert.equal(issues[0].stage, "dasm");
});

test("asar bare error without file/line still captured", () => {
  const log = `
error: The ROM title appears to be garbage.
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.match(issues[0].message, /garbage/);
});

test("wlalink unresolved-label error is extracted from the symbol-table flood", () => {
  // Real wlalink output: a huge `stack_item:`/`id:` dump, then the real error.
  const log = `
--- wlalink ---
stack_item: label (+)          : pad_keysdown
stack_item: value (+)          : 4.000000/$4 (RAM) 4.000000/$4 (ROM)
id: 502 file: /work/libc.obj line: 198 type: 1 bank: 0 position: 1 section_status: 1
----------------------------------------------------------------------
/work/main.obj: /work/main.asm:18: FIX_REFERENCES: Reference to an unknown label "this_symbol_does_not_exist".
`;
  const issues = parseBuildLog(log);
  // Exactly ONE issue — the flood lines must NOT become issues.
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].file, "/work/main.asm");
  assert.equal(issues[0].line, 18);
  assert.equal(issues[0].stage, "wlalink");
  assert.match(issues[0].message, /unknown label "this_symbol_does_not_exist"/);
});

test("wla-65816 assembler error parses with file/line", () => {
  const log = `
--- wla-65816 (main.c → .obj) ---
/work/main.asm:12: ERROR: Unknown instruction "lda#".
`;
  const issues = parseBuildLog(log);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "error");
  assert.equal(issues[0].line, 12);
  assert.match(issues[0].message, /Unknown instruction/);
});
