// Round-trip every shipped Genesis starter snippet through build({output:'rom'})
// to guarantee they're vasm68k-valid. vasm rejects subtle syntax (e.g.
// space after comma in operands); without this test we'd happily ship
// snippets that don't assemble — bug #48 from the rom-games agent.
//
// header.s is a full ROM on its own; the others are subroutine snippets
// that need a minimal preamble (vector table + reset) so vasm has
// something to bracket them with. We provide one and concatenate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../../toolchains/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// The Genesis lib tree moved to romdev-toolchain-m68k-gcc/share/genesis/lib/
// (a sibling package). __dirname is src/platforms/genesis/ inside romdevtools.
const LIB_DIR = path.resolve(__dirname, "..", "..", "..", "..", "romdev-toolchain-m68k-gcc", "share", "genesis", "lib");

// Each snippet is included as a TEXT include via `incsrc` from a minimal
// driver program. This validates syntax without forcing layout — vasm
// errors on bad syntax inside the include even though the include's own
// `org`s aren't enforced relative to the driver. Stubs cover labels the
// snippets reference but the driver doesn't define.
// Stub symbols the other snippets may reference but not define
// themselves. Each entry: { name, defn }. We filter out stubs the
// snippet itself defines (avoids "repeatedly defined symbol" errors
// when e.g. wram.s defines vblank_ready).
const ALL_STUBS = [
  { name: "vblank_ready",         defn: "vblank_ready equ $00FFFF00" },
  { name: "_reset",               defn: "_reset equ _entry" },
  { name: "_exception_handler",   defn: "_exception_handler equ _entry" },
  { name: "ROM_END",              defn: "ROM_END equ $00100000" },
  { name: "pad1_held",            defn: "pad1_held equ $00FF0002" },
  { name: "pad1_pressed",         defn: "pad1_pressed equ $00FF0004" },
  { name: "pad1_released",        defn: "pad1_released equ $00FF0006" },
];

function stubsForSnippet(snippetSource) {
  // Skip any stub whose symbol the snippet defines via `equ` or a label.
  return ALL_STUBS
    .filter((s) => {
      const equPattern = new RegExp(`^\\s*${s.name}\\s+equ\\b`, "m");
      const labelPattern = new RegExp(`^${s.name}\\s*:`, "m");
      return !equPattern.test(snippetSource) && !labelPattern.test(snippetSource);
    })
    .map((s) => s.defn)
    .join("\n");
}

test("Genesis starter snippets all assemble cleanly", async () => {
  const files = (await readdir(LIB_DIR)).filter((n) => n.endsWith(".s"));
  assert.ok(files.length > 0, "no snippet files found");

  for (const file of files) {
    const src = await readFile(path.join(LIB_DIR, file), "utf-8");
    if (file === "header.s") {
      // header.s IS a full ROM (defines its own vector table + _reset).
      // Compile standalone.
      const r = await buildForPlatform({ platform: "genesis", source: src });
      assert.ok(r.ok, `${file} failed to assemble:\n${r.log}`);
      assert.ok(r.binary && r.binary.length > 0, `${file} produced empty binary`);
    } else {
      // Other snippets are subroutines/templates. Provide via includes so
      // they get parsed (syntax-checked) without their `org`s clashing
      // with the driver's layout. Per-snippet stub filtering avoids
      // "repeatedly defined" errors when a snippet (e.g. wram.s)
      // defines symbols other snippets only reference.
      const stubs = stubsForSnippet(src);
      const driver = stubs + `
  org $00000000
  dc.l $00FFE000
  dc.l _entry
  org $00000200
_entry:
  bra.s _entry
  include "snippet.s"
`;
      const r = await buildForPlatform({
        platform: "genesis",
        source: driver,
        includes: { "snippet.s": src },
      });
      assert.ok(r.ok, `${file} failed to assemble:\n${r.log}`);
      assert.ok(r.binary && r.binary.length > 0, `${file} produced empty binary`);
    }
  }
});
