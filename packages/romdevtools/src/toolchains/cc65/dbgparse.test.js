import { test } from "node:test";
import assert from "node:assert/strict";
import { buildC } from "./cc65.js";
import { parseDbg, DbgIndex } from "./dbgparse.js";

test("buildC: produces .dbg when debug=true", async () => {
  const r = await buildC({
    source: "unsigned char score;\nvoid main(void) { score = 42; while(1){} }\n",
    target: "nes",
    debug: true,
  });
  assert.equal(r.exitCode, 0, "build failed:\n" + r.log);
  assert.ok(r.dbg && r.dbg.length > 100, "expected non-trivial .dbg output");
  assert.ok(r.dbg.startsWith("version\t"), "first line should be version record");
}, { timeout: 30000 });

test("parseDbg: extracts files, symbols, segments", async () => {
  const r = await buildC({
    source: "unsigned char score;\nunsigned char lives;\nvoid main(void) { score=0; lives=3; while(1){} }\n",
    target: "nes",
    debug: true,
  });
  const dbg = parseDbg(r.dbg);
  assert.ok(dbg.files.size > 0, "expected files");
  assert.ok(dbg.syms.size > 0, "expected symbols");
  assert.ok(dbg.segs.size > 0, "expected segments");

  // CODE segment should be present for NES (starts at $8000 by default).
  let codeSeg = null;
  for (const seg of dbg.segs.values()) {
    if (seg.name === "CODE") { codeSeg = seg; break; }
  }
  assert.ok(codeSeg, "expected CODE segment");
}, { timeout: 30000 });

test("DbgIndex: resolves _score to its address", async () => {
  const r = await buildC({
    source: "unsigned char score;\nvoid main(void) { score = 42; while(1){} }\n",
    target: "nes",
    debug: true,
  });
  const idx = new DbgIndex(parseDbg(r.dbg));
  // C symbol 'score' becomes asm symbol '_score' in cc65.
  const addr = idx.addressOf("_score");
  assert.ok(typeof addr === "number", "expected _score to resolve to an address");
  // BSS lives in zero-page-adjacent RAM on NES; main is at $8000-ish.
  // We just sanity-check the address is a 16-bit value.
  assert.ok(addr >= 0 && addr <= 0xffff, "address out of range");
}, { timeout: 30000 });

test("DbgIndex: symbolAt finds the symbol containing an address", async () => {
  const r = await buildC({
    source: "void main(void) { while(1){} }\n",
    target: "nes",
    debug: true,
  });
  const idx = new DbgIndex(parseDbg(r.dbg));
  const mainAddr = idx.addressOf("_main");
  assert.ok(typeof mainAddr === "number");
  const sym = idx.symbolAt(mainAddr);
  assert.ok(sym);
  assert.equal(sym.name, "_main");
}, { timeout: 30000 });
