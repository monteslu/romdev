// re-register-naming.test.js — B2: name hardware-register MMIO in decompiler
// output. Ghidra emits raw memory refs like `xRAM2001` for $2001; the post-pass
// rewrites those whose address is a known platform register to the register
// NAME (PPUMASK), and prepends a one-line legend of the substitutions.

import { test } from "node:test";
import assert from "node:assert/strict";

import { nameHardwareRegisters } from "../src/analysis/analyze.js";

test("B2: NES PPU/APU registers are named in the C output", () => {
  const c =
    "void fn(void) {\n" +
    "  xRAM2001 = 0x1e;\n" +     // PPUMASK
    "  uRAM4015 = 0x0f;\n" +     // SND_CHN
    "  return;\n}\n";
  const out = nameHardwareRegisters(c, "nes");
  assert.match(out, /\bPPUMASK = 0x1e;/, "$2001 → PPUMASK");
  assert.match(out, /\bSND_CHN = 0x0f;/, "$4015 → SND_CHN");
  assert.doesNotMatch(out, /xRAM2001|uRAM4015/, "raw mem-refs are gone");
  assert.match(out, /^\/\* hw registers:.*PPUMASK=\$2001.*SND_CHN=\$4015.*\*\/\n/,
    "legend lists every substitution with its address");
});

test("B2: an unknown address is left untouched", () => {
  // $0300 is plain RAM on the NES — NOT a register — so it must stay as-is.
  const c = "void fn(void) { xRAM0300 = 1; return; }\n";
  const out = nameHardwareRegisters(c, "nes");
  assert.equal(out, c, "no known register → code unchanged, no legend added");
});

test("B2: a platform with no register table is a no-op", () => {
  // gba has no register table wired (registersForPlatform → null); the pass must
  // pass the code through verbatim rather than throw.
  const c = "void fn(void) { uRAM4000000 = 0x80; return; }\n";
  assert.equal(nameHardwareRegisters(c, "gba"), c);
});

test("B2: the type-prefix variations Ghidra emits all resolve", () => {
  // Ghidra prefixes the mem-ref with a few type letters (b/u/c/x...). Each must
  // resolve to the same register name.
  for (const pre of ["b", "u", "c", "x", "cu"]) {
    const out = nameHardwareRegisters(`${pre}RAM2000 = 0;\n`, "nes");
    assert.match(out, /\bPPUCTRL = 0;/, `prefix '${pre}' → PPUCTRL`);
  }
});
