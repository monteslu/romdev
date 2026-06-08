// R55: the SDCC "xdata-copy-miscompile" lint must STOP crying wolf on every
// plain WRAM array copy. It was firing a scary "warning" on the SHAPE
// `dst[i] = src[i]` unconditionally — including for `static uint8_t rb[78];
// ... rb[i] = grid[i];` (a perfectly fine WRAM copy). A real agent building a
// GBC Columns clone reported that this trains agents to distrust the linter.
//
// Corrected severity matrix (classifyCopyDest):
//   • dst PROVABLY VRAM/__xdata (pointer decl, VRAM name, or assigned a
//     $8000-$9FFF literal/cast) → "warning"  (the real crash-class footgun)
//   • dst a plain RAM ARRAY (`type dst[N];` in this TU)  → SUPPRESSED
//   • dst unknown (bare ident, no decl here)             → "info" (visible,
//                                                            not "broken")

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintSdccSource, lintSources } from "../src/toolchains/sdcc/preflight-lint.js";

const findCopy = (issues) => issues.find((i) => i.ref === "xdata-copy-miscompile");

test("R55: plain WRAM array copy (`static uint8_t rb[78]; rb[i]=grid[i];`) produces NO warning", () => {
  const src = [
    "void snapshot(void){",
    "  static unsigned char grid[78];",
    "  static unsigned char rb[78];",
    "  unsigned char i;",
    "  for (i = 0; i < 78; i++) {",
    "    rb[i] = grid[i];",
    "  }",
    "}",
  ].join("\n");
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = findCopy(issues);
  // SUPPRESSED entirely — rb is a declared array, provably WRAM.
  assert.equal(copy, undefined, "no xdata-copy issue at all for a declared RAM array dest");
  // And definitely no "warning" of any kind from this rule.
  assert.ok(
    !issues.some((i) => i.ref === "xdata-copy-miscompile" && i.severity === "warning"),
    "must not cry wolf on a plain WRAM array copy",
  );
});

test("R55: the genre-scaffold shape `dst[i]=src[i]` (declared arrays) is suppressed", () => {
  const src = [
    "void blit(void){",
    "  unsigned char dst[64];",
    "  unsigned char src[64];",
    "  unsigned char i;",
    "  for (i = 0; i < 64; i++) dst[i] = src[i];",
    "}",
  ].join("\n");
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  assert.equal(findCopy(issues), undefined, "declared-array dest → suppressed");
});

test("R55: a VRAM pointer (`uint8_t *dst = (uint8_t*)0x8000; dst[i]=src[i];`) STILL warns", () => {
  const src = [
    "void load(void){",
    "  unsigned char *dst = (unsigned char*)0x8000;",
    "  unsigned char src[16];",
    "  unsigned char i;",
    "  for (i = 0; i < 16; i++) dst[i] = src[i];",
    "}",
  ].join("\n");
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = findCopy(issues);
  assert.ok(copy, "the real crash-class VRAM case is still detected");
  assert.equal(copy.severity, "warning", "VRAM pointer dest stays a WARNING");
  assert.notEqual(copy.critical, true, "a miscompile is not an unconditional hang → not critical");
  assert.match(copy.message, /VRAM/i, "message names VRAM so the agent knows why it fired");
});

test("R55: a pointer-typed dest (no literal) still warns — only pointers alias __xdata", () => {
  const src = [
    "void copy_tiles(unsigned char *dst, unsigned char *src, unsigned char n){",
    "  unsigned char i;",
    "  for (i = 0; i < n; i++) dst[i] = src[i];",
    "}",
  ].join("\n");
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = findCopy(issues);
  assert.ok(copy, "pointer-typed dest is the dangerous shape");
  assert.equal(copy.severity, "warning");
});

test("R55: a VRAM-named dest warns even without a visible decl", () => {
  const src = [
    "void f(void){",
    "  unsigned char i;",
    "  for (i = 0; i < 16; i++) vram_buf[i] = tiles[i];",
    "}",
  ].join("\n");
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = findCopy(issues);
  assert.ok(copy, "a *vram* name is treated as VRAM");
  assert.equal(copy.severity, "warning");
});

test("R55: a fully-unknown bare ident downgrades to INFO (visible, not scary)", () => {
  // No decl for `a` anywhere in the TU → can't prove WRAM or VRAM → info.
  const src = "void f(void){ for (i = 0; i < n; i++){ a[i] = b[i]; } }";
  const issues = lintSdccSource(src, "main.c", { port: "sm83" });
  const copy = findCopy(issues);
  assert.ok(copy, "still surfaced so it's not invisible");
  assert.equal(copy.severity, "info", "unknown dest → info, not warning");
  assert.notEqual(copy.critical, true);
});

test("R55: works the same on z80 platforms (SMS/GG/MSX)", () => {
  const ram = [
    "void f(void){",
    "  unsigned char buf[32]; unsigned char tmp[32]; unsigned char i;",
    "  for (i = 0; i < 32; i++) buf[i] = tmp[i];",
    "}",
  ].join("\n");
  assert.equal(findCopy(lintSdccSource(ram, "main.c", { port: "z80" })), undefined,
    "z80: declared array dest suppressed too");

  const vram = [
    "void f(void){",
    "  unsigned char *vp = (unsigned char*)0x9800; unsigned char s[8]; unsigned char i;",
    "  for (i = 0; i < 8; i++) vp[i] = s[i];",
    "}",
  ].join("\n");
  const c = findCopy(lintSdccSource(vram, "main.c", { port: "z80" }));
  assert.ok(c && c.severity === "warning", "z80: VRAM pointer dest still warns");
});

test("R55: lintSources threads the same classification through a sources map", () => {
  const sources = {
    "main.c": [
      "void f(void){",
      "  static unsigned char rb[78]; static unsigned char grid[78]; unsigned char i;",
      "  for (i = 0; i < 78; i++) rb[i] = grid[i];",
      "}",
    ].join("\n"),
  };
  const issues = lintSources(sources, { port: "sm83" });
  assert.ok(
    !issues.some((i) => i.ref === "xdata-copy-miscompile" && i.severity === "warning"),
    "the WRAM copy produces no warning through lintSources either",
  );
});
