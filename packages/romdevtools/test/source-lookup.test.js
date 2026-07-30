// disasm({target:'sourceLookup'}) — address -> the project's OWN annotated source.
//
// The v0.98.0 headline ask: "show me my commented source for $E4DB" had no tool.
// target:'rom' re-decodes fresh (losing annotations, and re-decoding data as
// code), target:'source' is PICO-8-only, and symbols({op:'lookup'}) gives the
// enclosing symbol NAME rather than the text. The fallback was a hand-built
// nibble-class regex over a 7000-line bank file:
//
//     grep -n 'E4[A-C][0-9A-F] \|E4D[0-9A-F] \|E4E[0-9A-F] ' src/bank7.asm
//
// which silently truncates if a nibble class is missed and drags in data-table
// lines whose comment bytes happen to read as that address.
//
// The implementation shipped without tests; these cover the behaviours the ask
// actually depends on — range matching, annotations preserved, context, and the
// silent-truncation failure the grep had.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceLookupCore } from "../src/analysis/source-lookup.js";

// An annotated bank file in the shape disasm({target:'project'}) emits:
// instruction, then a trailing `; ADDR bytes` comment. The human comments are
// the thing that must survive — they are the reason to read source over a
// fresh decode.
const BANK7 = [
    "; ---------------------------------------------------------------",
    "; HighScoreCommit — writes the seven score digits back to $0182.",
    "; ---------------------------------------------------------------",
    "HighScoreCommit:",
    "        lda     $0182                           ; E4D8 AD 82 01",
    "        clc                                     ; E4DB 18",
    "        jsr     ScoreAdd                        ; E4DC 20 E4 D2",
    "        sta     $0182                           ; E4DF 8D 82 01",
    "        rts                                     ; E4E2 60",
    "",
    "; A data table whose bytes READ like the address above — the exact thing",
    "; that pollutes a naive grep for 'E4D'.",
    "ScoreTable:",
    "        .byte   $E4, $DB, $20, $E4              ; F100 E4 DB 20 E4",
  ].join("\n");

const BANK6 = [
    "ScoreAdd:",
    "        adc     #$01                            ; D2E4 69 01",
    "        rts                                     ; D2E6 60",
  ].join("\n");

function makeProject() {
  const dir = mkdtempSync(path.join(tmpdir(), "source-lookup-"));
  const src = path.join(dir, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "bank7.asm"), BANK7);
  writeFileSync(path.join(src, "bank6.asm"), BANK6);
  // A non-source file that must be ignored rather than scanned.
  writeFileSync(path.join(dir, "notes.md"), "; E4DB this is prose, not source\n");
  return dir;
}

const PROJECT = makeProject();

test("a single address returns the annotated line, with its comments", async () => {
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0xE4DB });
  assert.ok(r.results.length > 0, "found the line");
  const block = r.results[0];
  assert.match(block.file, /bank7\.asm$/);
  const hit = block.lines.find((l) => l.hit);
  assert.match(hit.text, /clc/);
  assert.equal(block.firstAddress, "$E4DB");
  // The whole point of reading source instead of re-decoding: the human
  // annotation is right there in the context.
  const all = block.lines.map((l) => l.text).join("\n");
  assert.match(all, /jsr     ScoreAdd/, "context includes the neighbouring instruction");
});

test("context lines surround the hit and are marked as non-hits", async () => {
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0xE4DB, context: 2 });
  const block = r.results[0];
  assert.ok(block.lines.some((l) => !l.hit), "context present");
  assert.equal(block.lines.filter((l) => l.hit).length, 1, "exactly one line matched");
});

test("a RANGE matches every address inside it — no nibble classes to get wrong", async () => {
  // The grep this replaces needed 'E4[A-C][0-9A-F] |E4D[0-9A-F] |E4E[0-9A-F] '
  // and silently truncated if a class was missed.
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0xE4D8, endAddress: 0xE4E2, context: 0 });
  const hits = r.results.flatMap((b) => b.lines.filter((l) => l.hit).map((l) => l.text));
  assert.equal(hits.length, 5, "all five instructions in the range");
  assert.ok(hits.some((t) => /lda     \$0182/.test(t)));
  assert.ok(hits.some((t) => /rts/.test(t)));
});

test("a data table whose BYTES look like the address is not a hit", async () => {
  // `.byte $E4,$DB,...` at F100 must not match a lookup for $E4DB — only the
  // line's OWN address annotation counts. The naive grep matched this.
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0xE4DB, context: 0 });
  const texts = r.results.flatMap((b) => b.lines.filter((l) => l.hit).map((l) => l.text));
  assert.ok(!texts.some((t) => /ScoreTable|\.byte/.test(t)), "data table excluded");
});

test("the search spans files and finds the callee in another bank", async () => {
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0xD2E4, context: 0 });
  assert.match(r.results[0].file, /bank6\.asm$/);
  assert.match(r.results[0].lines.find((l) => l.hit).text, /adc     #\$01/);
});

test("an address with no source coverage returns empty, not a false hit", async () => {
  const r = await sourceLookupCore({ projectDir: PROJECT, startAddress: 0x1234 });
  assert.equal(r.results.length, 0);
});

test("missing projectDir and endAddress<startAddress are rejected", async () => {
  await assert.rejects(() => sourceLookupCore({ startAddress: 0xE4DB }), /projectDir/);
  await assert.rejects(() => sourceLookupCore({ projectDir: PROJECT }), /startAddress/);
  await assert.rejects(
    () => sourceLookupCore({ projectDir: PROJECT, startAddress: 0xE4DB, endAddress: 0xE400 }),
    /endAddress must be >= startAddress/,
  );
  await assert.rejects(
    () => sourceLookupCore({ projectDir: path.join(PROJECT, "nope"), startAddress: 0xE4DB }),
    /not found/,
  );
});
