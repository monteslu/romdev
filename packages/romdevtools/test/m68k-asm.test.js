// m68k-asm: Motorola-syntax 68k assembly through GNU as.
//
// The golden cases (test/fixtures/m68k-asm-golden.json) are byte images that
// Genesis assembly sources produced with the assembler romdev shipped before
// 0.150.0. They cover the syntax (org blocks in any order, dc/dcb/ds, equ/set/=,
// rs/offset structures, rept, macros with \1..\9 \@ \# NARG and mexit,
// conditional assembly, include/incdir/incbin, .local and 1$ labels, equr/reg,
// strings, cnop/align/even) and the encoding choices (moveq/addq/lea forms,
// branch sizing, short absolute addresses for labels in the first 32KB,
// constant branch targets). Every case must stay byte-identical; the
// shipped example (examples/genesis/main.s) is read from disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runM68kAsm } from "../src/toolchains/m68k-asm/m68k-asm.js";
import { translateMotorola } from "../src/toolchains/m68k-asm/motorola.js";
import { parseBuildLog } from "../src/toolchains/parse-errors.js";

const golden = JSON.parse(await readFile(new URL("./fixtures/m68k-asm-golden.json", import.meta.url), "utf8"));
const hex = (b) => Buffer.from(b).toString("hex");
const asm = (source, extra = {}) => runM68kAsm({ source, ...extra });

for (const c of golden) {
  test(`golden: ${c.name}`, { timeout: 60000 }, async () => {
    const binaryIncludes = c.binaryIncludes
      ? Object.fromEntries(Object.entries(c.binaryIncludes).map(([k, h]) => [k, new Uint8Array(Buffer.from(h, "hex"))]))
      : undefined;
    const source = c.file ? await readFile(new URL("../" + c.file, import.meta.url), "utf8") : c.source;
    const r = await runM68kAsm({ source, includes: c.includes, binaryIncludes });
    assert.equal(r.exitCode, 0, r.log);
    assert.equal(hex(r.binary), c.expect);
  });
}

test("diagnostics name the original file and line", async () => {
  const r = await asm(" org $200\nstart:\n nop\n move.w plyer_x,d0\n bogus d0,d1\n");
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /main\.s:4: error: undefined symbol plyer_x/);
  const iss = parseBuildLog(r.log);
  assert.ok(iss.some((i) => i.file === "main.s" && i.line === 4 && i.severity === "error"), JSON.stringify(iss));
});

test("GNU as errors are mapped back through includes and macros", async () => {
  const r = await asm(" org $200\n include \"sub.s\"\n", {
    includes: { "sub.s": "M macro\n bogus \\1\n endm\n nop\n M d0\n" },
  });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /sub\.s:2: error: .*\(in macro M called from sub\.s:5\)/);
});

test("missing include and incbin files are reported at their line", async () => {
  const r1 = await asm(" nop\n include \"nope.s\"\n");
  assert.match(r1.log, /main\.s:2: error: could not open <nope\.s>/);
  const r2 = await asm(" nop\n incbin \"art.bin\"\n");
  assert.match(r2.log, /main\.s:2: error: could not open <art\.bin>/);
});

test("overlapping org blocks fail the link with a readable message", async () => {
  const r = await asm(" org $100\n dcb.b $200,0\n org $200\n nop\n");
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /org blocks overlap/);
});

test("a value too big for its field is reported at its line", async () => {
  const r = await asm(" org $10000\nx: dc.w x\n nop\n");
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /main\.s:2: error: relocation truncated to fit/);
  const r2 = await asm(" dc.b 300\n");
  assert.match(r2.log, /main\.s:1: error: data out of range/);
});

test("fail/assert/echo directives", async () => {
  assert.match((await asm(" ifeq 1\n fail never\n endc\n fail \"stop here\"\n")).log, /main\.s:4: error: stop here/);
  assert.match((await asm("N equ 3\n assert N=4,\"N must be 4\"\n")).log, /main\.s:2: error: N must be 4/);
  const ok = await asm(" echo \"hello from the source\"\n dc.b 1\n");
  assert.equal(ok.exitCode, 0, ok.log);
  assert.match(ok.log, /hello from the source/);
});

test("-D / --define predefine constants", async () => {
  const r = await asm(" ifd DEBUG\n dc.w VER\n endc\n dc.b 1\n", { options: ["-DDEBUG", "--define", "VER=$1234"] });
  assert.equal(r.exitCode, 0, r.log);
  assert.equal(hex(r.binary), "123401");
});

test("digit separators and 0x hex are read as numbers", async () => {
  const r = await asm(" move.l #$7000_0083,$C00004\n dc.l 0x00FF0000\n dc.w %1010_1010\n");
  assert.equal(r.exitCode, 0, r.log);
  assert.equal(hex(r.binary), "23fc7000008300c00004" + "00ff0000" + "00aa");
});

test("suba.w #$8000 keeps its meaning (subtracting -32768 adds 32768)", async () => {
  const r = await asm(" suba.w #$8000,a0\n");
  assert.equal(hex(r.binary), "90fc8000");
});

test("labels come back as a symbol map", async () => {
  const r = await asm(" org $200\nStart:\n nop\n.loop bra.s .loop\nData: dc.w 1\n");
  assert.equal(r.exitCode, 0, r.log);
  assert.match(r.symbols, /0x00000200\s+Start$/m);
  assert.match(r.symbols, /0x00000202\s+Start\.loop$/m);
  assert.match(r.symbols, /0x00000204\s+Data$/m);
});

test("translator: one org block per section, placed by the generated layout", () => {
  const t = translateMotorola({ source: " org $400\n nop\n org 0\n dc.l 0\n" });
  assert.deepEqual(t.sections.map((s) => s.base), [0x400, 0]);
  assert.equal(t.errors.length, 0);
});
