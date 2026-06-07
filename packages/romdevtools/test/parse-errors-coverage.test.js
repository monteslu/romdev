// Compiler diagnostics must reach the agent as STRUCTURED issues[] — not be
// swallowed in the raw log. Agents can only fix what the toolchain tells them,
// where it tells them. This locks in the formats the audit found were dropped:
//   - SDCC's keyword-less `file:line: syntax error: …` and `warning NNN:`
//   - sdld/ASlink `?ASlink-Warning-Undefined Global '_x' referenced by …`
//   - cc65/ca65/ld65 `file:line: Error: …`
//   - gcc/cc1 `file:line:col: error|warning: …`
// (Live end-to-end coverage across all 14 platforms is exercised by the build
//  tests; this is the fast, format-level regression guard for the PARSER.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBuildLog } from "../src/toolchains/parse-errors.js";

function find(issues, pred) { return issues.find(pred); }

test("SDCC keyword-less syntax error → structured error", () => {
  const log = "--- sdcc (main.c) ---\n/work/main.c:2: syntax error: token -> ';' ; column 44\n";
  const iss = parseBuildLog(log);
  const e = find(iss, (i) => i.severity === "error" && i.stage === "sdcc");
  assert.ok(e, "SDCC syntax error not parsed: " + JSON.stringify(iss));
  assert.equal(e.file, "/work/main.c");
  assert.equal(e.line, 2);
  assert.match(e.message, /syntax error/);
});

test("SDCC `warning NNN:` → structured warning", () => {
  const log = "--- sdcc (main.c) ---\n/work/main.c:7: warning 112: function 'foo' implicit declaration\n";
  const iss = parseBuildLog(log);
  const w = find(iss, (i) => i.severity === "warning" && i.line === 7);
  assert.ok(w, "SDCC warning not parsed: " + JSON.stringify(iss));
  assert.match(w.message, /implicit declaration/);
});

test("sdld/ASlink undefined-symbol → structured error (was log-only)", () => {
  const log = "--- sdld ---\n?ASlink-Warning-Undefined Global '_undeclared_fn' referenced by module '_main'\n";
  const iss = parseBuildLog(log);
  const e = find(iss, (i) => i.severity === "error" && i.stage === "sdld");
  assert.ok(e, "ASlink undefined-global not parsed as error: " + JSON.stringify(iss));
  assert.match(e.message, /Undefined Global '_undeclared_fn'/);
});

test("cc65 Error → structured", () => {
  const log = "--- cc65 (main.c) ---\n/work/main.c:1: Error: Undeclared identifier 'x'\n";
  const iss = parseBuildLog(log);
  const e = find(iss, (i) => i.severity === "error" && i.stage === "cc65");
  assert.ok(e && e.line === 1 && /Undeclared identifier/.test(e.message), JSON.stringify(iss));
});

test("gcc/cc1 error WITH column → structured", () => {
  const log = "--- cc1 (main.c) ---\n/work/main.c:2:26: error: 'q' undeclared (first use in this function)\n";
  const iss = parseBuildLog(log);
  const e = find(iss, (i) => i.severity === "error" && i.stage === "cc1");
  assert.ok(e, JSON.stringify(iss));
  assert.equal(e.line, 2);
  assert.equal(e.col, 26);
});

test("gcc/cc1 unused-variable warning (needs -Wall) → structured", () => {
  const log = "--- cc1 (main.c) ---\n/work/main.c:2:9: warning: unused variable 'u' [-Wunused-variable]\n";
  const iss = parseBuildLog(log);
  const w = find(iss, (i) => i.severity === "warning" && /unused variable/.test(i.message));
  assert.ok(w, "gcc unused-var warning not parsed: " + JSON.stringify(iss));
});

test("dasm assembler error → structured (dasm's `file (line): error:` format)", () => {
  const log = "--- dasm ---\nmain.asm (2): error: Unknown Mnemonic 'BOGUS'.\n";
  const iss = parseBuildLog(log);
  const e = find(iss, (i) => i.severity === "error" && i.stage === "dasm");
  assert.ok(e && e.line === 2, JSON.stringify(iss));
});
