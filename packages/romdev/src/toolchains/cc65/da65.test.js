import { test } from "node:test";
import assert from "node:assert/strict";
import { runDa65 } from "./da65.js";

test("da65 disassembles a tiny 6502 sequence", async () => {
  // LDA #$42 ; STA $0200 ; JMP $8000
  const bytes = new Uint8Array([0xa9, 0x42, 0x8d, 0x00, 0x02, 0x4c, 0x00, 0x80]);
  const r = await runDa65({ bytes, startAddress: 0x8000, cpu: "6502" });
  assert.equal(r.exitCode, 0, "asm:\n" + r.asm);
  assert.match(r.asm, /lda\s+#\$42/i);
  assert.match(r.asm, /sta\s+\$0200/i);
  // da65 generates a label (L8000) for branch targets in range, so the
  // operand is the label name, not the literal $8000.
  assert.match(r.asm, /jmp\s+(L8000|\$8000)/i);
}, { timeout: 15000 });

test("da65 disassembles a PRG segment of a real cc65 NES ROM", async () => {
  const { buildC } = await import("./cc65.js");
  const built = await buildC({
    source: "void main(void) { while(1){} }\n",
    target: "nes",
  });
  assert.equal(built.exitCode, 0);
  const prg = built.binary.slice(16, 16 + 256);
  const r = await runDa65({ bytes: prg, startAddress: 0x8000, cpu: "6502" });
  assert.equal(r.exitCode, 0, "asm:\n" + r.asm);
  assert.ok(r.asm.length > 100, "expected non-trivial disassembly");
  assert.match(r.asm, /sei|cld|ldx|txs/i);
}, { timeout: 30000 });
