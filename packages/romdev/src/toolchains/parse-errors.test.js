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
