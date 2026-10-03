// state's `path` is a disk file for nine ops, but its description only named
// save/load/export/dump, so the per-op scope checker refused
// state({op:'importSram', path}) before the handler ran. That broke every
// caller that wipes or restores SRAM from a .sav (formix's drive.mjs: 21 of 21
// suites errored). Read the REAL registered shape so the test tracks the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { makeScopeChecker } from "../src/mcp/util.js";
import { registerStateTools } from "../src/mcp/tools/state.js";

function stateShape() {
  let shape;
  registerStateTools({ tool: (name, _desc, s) => { if (name === "state") shape = s; } }, z, "test");
  return shape;
}

const PATH_OPS = ["save", "load", "export", "dump", "exportSram", "importSram", "exportDisk", "importDisk", "putDiskFile"];

test("path is accepted on every op that reads or writes a disk file", () => {
  const check = makeScopeChecker(stateShape(), "state");
  assert.ok(check);
  for (const op of PATH_OPS) assert.equal(check({ op, path: "/x/save.sav" }), null, op);
});

test("path is still refused on ops that take no file", () => {
  const check = makeScopeChecker(stateShape(), "state");
  for (const op of ["list", "diff"]) {
    assert.match(check({ op, path: "/x/save.sav" }), new RegExp(`'path' does not apply to op:'${op}'`));
  }
});
