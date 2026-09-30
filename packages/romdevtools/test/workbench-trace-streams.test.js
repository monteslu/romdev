// What a trace command says when it is handed a pass-boundary stream. Every
// stream is synthesized from the published record formats. Ported from the
// workbench's own trace-streams tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { binasmRecord, binasmStream, ucodeStream } from "./fixtures/workbench/phase-streams.js";
import { BinaryTraceStreamError, classifyTraceBytes, readTraceSource, readTraceText } from "../src/decomp/workbench/trace-source.js";
import { parseTrace } from "../src/decomp/workbench/trace.js";
import { runCommand, resolveCommand } from "../src/decomp/workbench/cli.js";
import { parseArgs } from "../src/decomp/workbench/argparse.js";
import { shlexSplit } from "../src/decomp/workbench/command-line.js";

const TEXT_TRACE = "CODEX-UGEN-APPEND line=182 list=10019da4 reg=14\nCODEX-UGEN-ALLOC serial=1 line=700 reg=14\n";
const refusal = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof BinaryTraceStreamError, String(e)); return e; } assert.fail("expected a refusal"); };

test("names each pass-boundary stream; text is not a stream", () => {
  assert.equal(classifyTraceBytes(ucodeStream()), "ucode");
  assert.equal(classifyTraceBytes(binasmStream()), "binasm");
  assert.equal(classifyTraceBytes(Buffer.from(TEXT_TRACE)), null);
});

test("text passes through unchanged", () => {
  const s = readTraceSource(Buffer.from(TEXT_TRACE));
  assert.equal(s.text, TEXT_TRACE);
  assert.equal(s.encoding, "utf-8");
  assert.equal(s.recovered, false);
  assert.deepEqual(s.notes, []);
});

test("untagged text still passes through", () => {
  const s = readTraceSource(Buffer.from("p1dec proc=1 web=3 color=c17\n"));
  assert.equal(s.encoding, "utf-8");
  assert.deepEqual(s.notes, []);
});

test("refuses ucode by name", () => {
  const e = refusal(() => readTraceSource(ucodeStream(), { name: "before-7-ctmoA0r9Qp" }));
  assert.equal(e.stream_format, "ucode");
  for (const s of ["before-7-ctmoA0r9Qp", "Ucode", "record(s)", "ucode window before-7-ctmoA0r9Qp --at 0", "docs/compiler-instrumentation.md"]) assert.ok(e.message.includes(s), s);
});

test("refuses binasm by name", () => {
  const e = refusal(() => readTraceSource(binasmStream(), { name: "after-9-ctmc2PdRlS" }));
  assert.equal(e.stream_format, "binasm");
  for (const s of ["after-9-ctmc2PdRlS", "16-byte", "binasm window after-9-ctmc2PdRlS --at 0", "docs/compiler-instrumentation.md"]) assert.ok(e.message.includes(s), s);
});

test("refuses a stream that decodes as utf-8", () => {
  const data = Buffer.concat([binasmRecord(0, 0x002A0000, 7, 0xA), binasmRecord(0, 0x00150000, 0, 0), binasmRecord(0, 0x001C0000, 28, 85), binasmRecord(0, 0x00170062, 0x040D4000, 0)]);
  new TextDecoder("utf-8", { fatal: true }).decode(data);
  assert.equal(refusal(() => readTraceSource(data, { name: "after-13-ctmgtUjPyVL" })).stream_format, "binasm");
});

test("recovers diagnostic lines from a mixed file", () => {
  const data = Buffer.concat([Buffer.from(TEXT_TRACE), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(TEXT_TRACE)]);
  const notes = [];
  const text = readTraceText(data, { name: "mixed.log", warn: (n) => notes.push(n) });
  assert.equal(parseTrace(text).length, 4);
  assert.equal(notes.length, 1);
  for (const s of ["mixed.log", "2 byte(s) were replaced", "4 diagnostic line(s)"]) assert.ok(notes[0].includes(s), s);
});

const mystery = () => Buffer.concat(Array(3).fill(Buffer.from(Array.from({ length: 0xFF - 0xC0 }, (_, i) => 0xC0 + i))));

test("unframed binary names the stream reader and tier two", () => {
  const e = refusal(() => readTraceSource(mystery(), { name: "mystery.bin" }));
  assert.equal(e.stream_format, null);
  for (const s of ["mystery.bin", "neither Ucode nor Binasm", "binasm window mystery.bin --at 0 --format binasm", "docs/compiler-instrumentation.md"]) assert.ok(e.message.includes(s), s);
});

async function assertParses(message) {
  const found = [...message.matchAll(/`decomp-workbench ([^`]+)`/g)].map((m) => shlexSplit(m[1]));
  assert.ok(found.length, message);
  for (const argv of found) {
    const r = await resolveCommand(argv);
    assert.ok(r, argv.join(" "));
    parseArgs(r.spec, r.rest, { prog: "decomp-workbench" });
  }
}

test("a stream refusal names a command that runs", async () => {
  for (const [stream, name] of [[ucodeStream(), "before-7-ctmoA0r9Qp"], [binasmStream(), "after-9-ctmc2PdRlS"]]) {
    await assertParses(refusal(() => readTraceSource(stream, { name })).message);
  }
});

test("an unframed refusal names a command that runs", async () => {
  await assertParses(refusal(() => readTraceSource(mystery(), { name: "mystery.bin" })).message);
});

test("every trace command refuses a stream the same way", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-trace-streams-"));
  try {
    const p = path.join(dir, "after-9-ctmc2PdRlS");
    writeFileSync(p, binasmStream());
    for (const command of ["trace-summary", "trace-fifo", "trace-alias"]) {
      const r = await runCommand([command, p]);
      assert.equal(r.code, 2, command);
      for (const s of ["Binasm", "binasm window", "docs/compiler-instrumentation.md"]) assert.ok(r.stderr.includes(s), `${command}: ${s}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a mixed file warns on stderr and still reports", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-trace-streams-"));
  try {
    const p = path.join(dir, "ugen.log");
    writeFileSync(p, Buffer.concat([Buffer.from(TEXT_TRACE), Buffer.from([0xff, 0x0a])]));
    const r = await runCommand(["trace-summary", p]);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes("events: 2"));
    assert.ok(r.stderr.includes("warning:"));
    assert.ok(r.stderr.includes("ugen.log"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
