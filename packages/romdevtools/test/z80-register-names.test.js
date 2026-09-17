// The Z80 8-bit register table must survive whatever we do to the shipped
// binaries.
//
// A release-prep pass that rewrote builder paths inside prebuilt wasm padded
// each replacement to the original byte length with "/" characters. On
// z80-elf-objdump that padding ran past a path string and overwrote the "h"
// entry of binutils' r_str[] table, so EVERY 8-bit H operand disassembled as
// "/": `ld d,/`, `xor /`, `ld /,l`. It reached the IR too, so consumers got
// `{"operand":"d,/"}` - 20,490 corrupted records on one 512KB cart.
//
// Nothing in romdev's JS was wrong; the disassembler binary itself was. A test
// that only exercised our code would not have caught it, so this one asserts on
// the decoded TEXT for a synthetic blob covering every H encoding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runObjdump } from "../src/toolchains/objdump.js";

// ld d,h | ld b,h | xor h | or h | ld h,l | inc h | dec h | ld h,h | halt
const PROBE = Buffer.from([0x54, 0x44, 0xac, 0xb4, 0x65, 0x24, 0x25, 0x64, 0x76]);

test("Z80 disassembly names the H register 'h', never '/'", async () => {
  const r = await runObjdump({ arch: "z80", bytes: new Uint8Array(PROBE), startAddress: 0 });
  assert.notEqual(r.available, false, "z80 objdump not available");
  const asm = String(r.asm || r.raw || "");

  // The failure mode, stated directly: a bare "/" as an operand.
  assert.doesNotMatch(asm, /\s\/(\s|,|$)/m, `H register printed as '/':\n${asm}`);
  assert.doesNotMatch(asm, /,\//m, `H register printed as '/':\n${asm}`);

  // And the decodes that must be present.
  for (const want of ["ld d,h", "ld b,h", "xor h", "or h", "ld h,l", "inc h", "dec h", "ld h,h", "halt"]) {
    assert.ok(asm.includes(want), `expected '${want}' in:\n${asm}`);
  }
});
