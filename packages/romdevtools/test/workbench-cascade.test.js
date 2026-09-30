// The parts of the workbench's CDX cascade reader that romdev's diagnose
// path uses: frame-offset spellings, CdxLog indexing, and the refusals that
// name the missing instrument. The per-round cascade construction and the
// trace-cascade / trace-order / trace-blocks commands are not ported.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CascadeError, CdxLog, formatFrameOffset, parseFrameOffset } from "../src/decomp/workbench/cascade.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "workbench");
const log = () => new CdxLog(fs.readFileSync(path.join(FIX, "cascade.trace"), "utf8"), { name: "cascade.log" });

test("a frame offset parses from every spelling a trace or reader uses", () => {
  assert.equal(parseFrameOffset("0xfffffdf8"), -520);
  assert.equal(parseFrameOffset("-520"), -520);
  assert.equal(parseFrameOffset(" 0XFFFFFDF8 "), -520);
  assert.equal(parseFrameOffset("16"), 16);
  assert.throws(() => parseFrameOffset("slot"), (e) => e instanceof CascadeError && /not a frame offset/.test(e.message));
  assert.equal(formatFrameOffset(-520), "0xfffffdf8 (-520)");
  assert.equal(formatFrameOffset(16), "0x00000010 (+16)");
});

test("the log is indexed by record kind, frame offset, symbol and web", () => {
  const l = log();
  assert.equal(l.kinds.get("webdetail"), 3);
  assert.deepEqual(l.missing(["p1dec", "symtab"]), ["symtab"]);
  const offsets = l.frameOffsets();
  assert.deepEqual([...offsets.get(-520)], [1039]);
  assert.deepEqual([...offsets.get(-788)], [255]);
  assert.deepEqual(l.websOfSymbol(1039), [1039, 3059]);
  assert.equal(l.symbolOfWeb(3059), 1039);
  assert.equal(l.webDetail(255).raw10, "0xfffffcec");
  assert.deepEqual(l.webDetail(99999), {});
});

test("a missing record kind is refused by name, with what is present", () => {
  assert.throws(() => log().require(["symtab"], { purpose: "a frame ladder" }),
    (e) => e instanceof CascadeError && e.message.includes("carries no symtab record(s), which a frame ladder needs") && e.message.includes("Present: globalcolor"));
  log().require(["p1dec", "webdetail"], { purpose: "a cascade" });
});

test("allocator decisions reach the colouring sweep records", () => {
  const webs = log().trace.allocatorWebs({ proc: 0 });
  assert.ok(webs.length >= 3);
  assert.ok(webs.every((w) => w.phase_tag === "p1"));
});
