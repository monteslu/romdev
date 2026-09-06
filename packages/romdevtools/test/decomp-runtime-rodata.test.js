// decomp-runtime-rodata.test.js — synthetic checks for basic-block derivation,
// the rodata word view (jump-table entries as function-relative offsets),
// pointer-aware type proposals, and the decompiler's split VMA adjust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { basicBlocks } from "../src/decomp/runtime.js";

test("basicBlocks: entry, branch target, post-delay-slot and jal-target leaders", () => {
  // 0: addiu sp,sp,-24 ; 4: bne v0,zero,+2 (→ 16) ; 8: nop (delay) ; 12: addiu v0,v0,1 ; 16: jr ra ; 20: nop
  const w = (x) => ({ word: x >>> 0 });
  const stream = [w(0x27bdffe8), w(0x14400002), w(0x00000000), w(0x24420001), w(0x03e00008), w(0x00000000)];
  const bb = basicBlocks(stream, 0x80001000);
  assert.deepEqual(bb.map((b) => [b.start - 0x80001000, b.instructions]), [[0, 3], [12, 1], [16, 2]]);
  // a jal into the same function adds a leader at the target
  const s2 = [w(0x0c000402), w(0x00000000), w(0x24420001), w(0x03e00008), w(0x00000000)]; // jal 0x80001008
  const bb2 = basicBlocks(s2, 0x80001000);
  assert.ok(bb2.some((b) => b.start === 0x80001008));
});

test("decompileFunction script: a base >= 0x80000000 is applied as two halves (32-bit long in WASM)", async () => {
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/analysis/decompile.js", import.meta.url), "utf8");
  assert.ok(/adjust vma/.test(src), "the REPL adjust vma command is used");
  assert.ok(/Math\.floor\(base \/ 2\)/.test(src), "the adjustment is split in halves");
});

test("proposeTypes text: pointer-used fields become pointers and gaps become byte arrays", async () => {
  // Drive the proposal builder with a synthetic types record.
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "romdev-types-"));
  process.env.ROMDEV_DECOMP_HOME = dir;
  const { proposeTypes } = await import("../src/decomp/types.js?" + Date.now());
  const { workspaceDir } = await import("../src/decomp/project.js?" + Date.now());
  const ws = workspaceDir("synthetic");
  await mkdir(path.join(ws, "types"), { recursive: true });
  await writeFile(path.join(ws, "types", "func_X.json"), JSON.stringify({ symbol: "func_X", tu: "src/x.c", bases: { arg1: { fields: {
    "0": { offset: 0, widths: [4], types: ["s32/u32/ptr"], evidence: [{ source: "m2c" }] },
    "8": { offset: 8, widths: [4], types: ["s32/u32/ptr"], pointer: true, evidence: [{ source: "m2c", pointer: true }] },
    "16": { offset: 16, widths: [4], types: ["f32"], evidence: [{ source: "m2c" }] },
  } } } }));
  const fakeProject = { id: "synthetic", ws, resolveFunction: async () => { throw new Error("no project"); } };
  const r = await proposeTypes(fakeProject, { symbol: "func_X" });
  assert.equal(r.structs.length, 1);
  const t = r.structs[0].text;
  assert.ok(/s32 unk0;/.test(t)); assert.ok(/u8 unk_4\[0x4\];/.test(t)); assert.ok(/s32\* unk8;/.test(t)); assert.ok(/f32 unk10;/.test(t));
});
