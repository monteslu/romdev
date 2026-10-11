// Regression guard for the genesis "silent asm default" foot-gun reported by an
// agent: runSource/buildSource with an OMITTED `language` used to fall to the
// platform's first (asm) toolchain, so a Genesis .c file got assembled as 68k
// by the 68k assembler ("identifier expected" / "missing reset vector"). The language
// resolver now routes by source filename/content when no language is given.
//
// These tests assert TOOLCHAIN SELECTION only (the `result.toolchain` field) so
// they stay fast and don't depend on a full successful compile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForPlatform } from "../src/toolchains/index.js";

const C_SOURCE = `#include <genesis.h>
int main() {
    while (1) { SYS_doVBlankProcess(); }
    return 0;
}`;

const ASM_SOURCE = `; Genesis asm - minimal
    org $200
    dc.l 0x00FF0000
reset:
    nop
    bra reset`;

test("genesis: omitted language + C source → m68k-elf-gcc (the foot-gun fix)", async () => {
  const r = await buildForPlatform({ platform: "genesis", source: C_SOURCE });
  assert.equal(r.toolchain, "m68k-elf-gcc",
    `C source must route to gcc, not the asm assembler (got ${r.toolchain})`);
});

test("genesis: omitted language + asm source → m68k-elf-as (backward compatible)", async () => {
  const r = await buildForPlatform({ platform: "genesis", source: ASM_SOURCE });
  assert.equal(r.toolchain, "m68k-elf-as",
    `asm source must still route to the 68k assembler (got ${r.toolchain})`);
});

test("genesis: sourceName extension wins - main.c → gcc even if content is ambiguous", async () => {
  const r = await buildForPlatform({ platform: "genesis", source: "int x;", sourceName: "main.c" });
  assert.equal(r.toolchain, "m68k-elf-gcc");
});

test("genesis: sourceName main.s → m68k-elf-as", async () => {
  const r = await buildForPlatform({ platform: "genesis", source: ASM_SOURCE, sourceName: "main.s" });
  assert.equal(r.toolchain, "m68k-elf-as");
});

test("genesis: explicit language:'asm' is always honored, even on C-looking source", async () => {
  const r = await buildForPlatform({ platform: "genesis", language: "asm", source: C_SOURCE });
  assert.equal(r.toolchain, "m68k-elf-as");
});

test("genesis: a /* */ inside an asm ; comment does NOT trip the C heuristic", async () => {
  // This is the exact false-positive that broke examples/genesis/main.s:
  // an asm doc-comment that embeds "buildSource({ source: /* this file */ })".
  const asmWithBlockCommentProse = `; Hello - scaffold.\n; usage: buildSource({ source: /* this file */ });\n    org $200\n    nop`;
  const r = await buildForPlatform({ platform: "genesis", source: asmWithBlockCommentProse });
  assert.equal(r.toolchain, "m68k-elf-as",
    "asm prose containing /* */ must NOT be misread as C");
});

test("genesis: asm failure on C-looking source gets the teach-the-fix note", async () => {
  // Force the asm path on C source; the failed log must point at language:"c".
  const r = await buildForPlatform({ platform: "genesis", language: "asm", source: C_SOURCE });
  assert.equal(r.ok, false, "C-as-asm should fail to build");
  assert.match(r.log, /looks like C .* assembled as 68000|pass language:"c"/i,
    "failed asm build on C source should teach the language:'c' fix");
});
