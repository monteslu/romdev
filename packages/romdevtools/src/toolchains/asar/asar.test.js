import { test } from "node:test";
import assert from "node:assert/strict";
import { runAsar } from "./asar.js";

const SNES_HELLO = `
lorom

org $008000
START:
  sei
  clc
  xce
  rep #$30
  ldx #$1FFF
  txs

LOOP:
  bra LOOP

org $00FFFC
  dw START   ; reset vector
`;

test("asar assembles a minimal SNES program", async () => {
  const r = await runAsar({ source: SNES_HELLO });
  assert.equal(r.exitCode, 0, "log:\n" + r.log);
  assert.ok(r.binary);
  // LoROM reset vector at file $7FFC = $00:FFFC should be $8000 (start of bank 0 code).
  assert.equal(r.binary[0x7ffc], 0x00);
  assert.equal(r.binary[0x7ffd], 0x80);
});

test("asar returns a layout summary on success", async () => {
  const r = await runAsar({ source: SNES_HELLO });
  assert.equal(r.exitCode, 0);
  assert.ok(Array.isArray(r.layout), "layout should be an array of written runs");
  assert.ok(r.layout.length > 0, "at least one written run expected");
  // Verify the format: {fileStart, fileEnd} numbers.
  for (const run of r.layout) {
    assert.equal(typeof run.fileStart, "number");
    assert.equal(typeof run.fileEnd, "number");
    assert.ok(run.fileEnd >= run.fileStart);
  }
});

test("preflight: bank-rewind detection rejects org going $00 → $01 → $00", async () => {
  const src = `lorom
org $008000
  rti
org $018000
  db $00
org $00FFC0
  db "GAME                 "
`;
  const r = await runAsar({ source: src });
  assert.equal(r.exitCode, 1);
  assert.match(r.log, /bank-tracking|rewind/i);
});

test("preflight: header-overlap rejects an incbin that would clobber $XXFFC0", async () => {
  const big = new Uint8Array(40000); // > 32704 bytes available before header
  const r = await runAsar({
    source: `lorom
org $008000
incbin "big.bin"
`,
    binaryIncludes: { "big.bin": big },
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.log, /overlap/i);
  assert.match(r.log, /FFC0/i);
});

test("preflight: missing-include flags incbin pointing at a nonexistent file", async () => {
  const r = await runAsar({
    source: `lorom
org $008000
incbin "nope.bin"
`,
    binaryIncludes: { "yep.bin": new Uint8Array([1, 2, 3]) },
  });
  assert.equal(r.exitCode, 1);
  assert.match(r.log, /not present in binaryIncludes/);
  assert.match(r.log, /yep\.bin/);
});

test("preflight: detects label-arith # immediate across bank boundary", async () => {
  // a_label in bank $00, b_label in bank $01, sz computed from their
  // difference, then used as `ldx #sz`. This is the exact pattern
  // (devnote.md 2026-05-23 round 2) that crashes asar 1.x silently.
  // Header at $00FFC0 must come FIRST to avoid the bank-rewind preflight.
  const src = `lorom
org $00FFC0
  db "GAME                 "
org $008000
a_label:
  ldx #sz
  rti
org $018000
b_label:
  db $00, $00, $00
b_end:
sz = b_end - b_label
`;
  const r = await runAsar({ source: src });
  assert.equal(r.exitCode, 1);
  assert.match(r.log, /label-arithmetic constant/);
  assert.match(r.log, /span different banks/);
  assert.match(r.log, /#sz/);
});

test("success: includes asset sizes in response", async () => {
  const src = `lorom
org $008000
start:
  rti
incbin "asset.bin"
org $00FFC0
  db "GAME                 "
  db $20, $00, $08, $00, $01, $00, $00
  dw $0000, $0000
org $00FFFC
  dw start
`;
  const asset = new Uint8Array(123).fill(0x42);
  const r = await runAsar({
    source: src,
    binaryIncludes: { "asset.bin": asset },
  });
  assert.equal(r.exitCode, 0, "log:\n" + r.log);
  assert.deepEqual(r.includes, { "asset.bin": { size: 123 } });
});

test("silent-fail recovery: wrapper retries with --verbose and dumps partial layout", async () => {
  // `BOGUSOP` is invalid; asar 1.91's WASM build throws a C++ exception
  // through Emscripten that surfaces as a heap-pointer exit code with no
  // log. The wrapper should retry on a fresh module with --verbose and
  // include the verbose output + a (possibly empty) layout dump.
  const r = await runAsar({
    source: `lorom
org $008000
  BOGUSOP
  rti
`,
  });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.log, /retry with --verbose/);
  // The verbose banner from asar 1.91 should now show up in the log.
  assert.match(r.log, /Asar 1\.\d+/);
  assert.match(r.log, /partial ROM layout/);
});

// ── v0.70.0 feedback fixes ────────────────────────────────────────────────

test("v0.70.0 #5: a clean asar error exit is NOT mislabeled 'Abort in WASM'", async () => {
  const r = await runAsar({ source: "lorom\norg $008000\n  jmp UndefinedLabelXYZ\norg $00FFFC\ndw $8000\n" });
  assert.equal(r.exitCode, 1);
  assert.ok(/Elabel_not_found|wasn't found/i.test(r.log), "should keep the real diagnostic");
  assert.ok(!/Abort in WASM/.test(r.log), "should strip the misleading abort line on a clean error:\n" + r.log);
});

test("v0.70.0 #6: bankcross preflight only flags bank $00 + honors 'check bankcross off'", async () => {
  const big = Buffer.alloc(0x8000).toString("base64"); // 32KB fills a whole bank window
  // bank $08 crossing $08FFC0 is ordinary ROM — must NOT be rejected
  const a = await runAsar({ source: "lorom\norg $088000\nincbin \"g.bin\"\n", binaryIncludes: { "g.bin": big } });
  assert.ok(!/preflight/.test(a.log), "bank $08 cross should NOT be a preflight rejection:\n" + a.log);
  // bank $00 crossing $00FFC0 SHOULD be flagged (real header overlap)
  const b = await runAsar({ source: "lorom\norg $008000\nincbin \"g.bin\"\n", binaryIncludes: { "g.bin": big } });
  assert.ok(/preflight.*\$00FFC0/.test(b.log), "bank $00 cross should be flagged:\n" + b.log);
  // `check bankcross off` suppresses even bank $00
  const c = await runAsar({ source: "lorom\ncheck bankcross off\norg $008000\nincbin \"g.bin\"\n", binaryIncludes: { "g.bin": big } });
  assert.ok(!/preflight/.test(c.log), "'check bankcross off' should suppress:\n" + c.log);
});

test("v0.70.0 #1: a source reading many distinct files via readfile gets an advisory", async () => {
  const bins = {};
  let src = "lorom\norg $008000\n";
  for (let i = 0; i < 82; i++) { bins[`f${i}.bin`] = Buffer.from([i & 0xff, 1, 2]).toString("base64"); src += `db readfile1("f${i}.bin",0)\n`; }
  src += "org $00FFFC\ndw $8000\n";
  const r = await runAsar({ source: src, binaryIncludes: bins });
  assert.ok(/asar advisory.*82 distinct/.test(r.log), "should warn about 82 distinct readfile targets:\n" + r.log.slice(0, 400));
  // a small build (1 file) must NOT carry the advisory
  const r2 = await runAsar({ source: 'lorom\norg $008000\ndb readfile1("f0.bin",0)\norg $00FFFC\ndw $8000\n', binaryIncludes: { "f0.bin": "AAEC" } });
  assert.ok(!/asar advisory/.test(r2.log), "small build should not warn");
});
