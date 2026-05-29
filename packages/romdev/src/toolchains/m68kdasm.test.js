import { test } from "node:test";
import assert from "node:assert/strict";
import { runM68kdasm } from "./m68kdasm.js";

function disasmLines(bytes, start = 0x200) {
  const { asm } = runM68kdasm({ bytes: new Uint8Array(bytes), startAddress: start });
  // Strip header + blank lines; return the instruction text (no comment).
  return asm.split("\n")
    .filter((l) => l.startsWith("        ") && !l.trim().startsWith(".setcpu"))
    .map((l) => l.trim().replace(/\s*;.*$/, ""))
    .filter((l) => l.length > 0);
}

test("decodes nop / rts / moveq", () => {
  const l = disasmLines([0x4E, 0x71, 0x4E, 0x75, 0x70, 0x05]);
  assert.deepEqual(l, ["nop", "rts", "moveq #$05,d0"]);
});

test("decodes move.l immediate and reg-to-reg", () => {
  const l = disasmLines([0x22, 0x3C, 0x00, 0x00, 0x00, 0xFF, 0x22, 0x00]);
  assert.equal(l[0], "move.l #$000000FF,d1");
  assert.equal(l[1], "move.l d0,d1");
});

test("decodes bra/jsr to absolute label", () => {
  // bra +4, then jsr $1234
  const l = disasmLines([0x60, 0x00, 0x00, 0x04, 0x4E, 0xB9, 0x00, 0x00, 0x12, 0x34], 0x200);
  // 16-bit disp form: target = addr(0x200) + 2 + disp(4) = 0x206.
  assert.equal(l[0], "bra L000206");
  assert.equal(l[1], "jsr L001234");
});

test("decodes add.w / cmp.l", () => {
  const l = disasmLines([0xD0, 0x41, 0xB2, 0x80]);
  assert.equal(l[0], "add.w d1,d0");
  assert.equal(l[1], "cmp.l d0,d1");
});

test("decodes movem.l predecrement register list", () => {
  // 48E7 FFFE = movem.l d0-d7/a0-a6,-(sp)
  const l = disasmLines([0x48, 0xE7, 0xFF, 0xFE]);
  assert.equal(l[0], "movem.l d0-d7/a0-a6,-(a7)");
});

test("decodes the SEGA TMSS write (real Genesis boot)", () => {
  // 23FC 53454741 00A14000 = move.l #$53454741,($00A14000).l
  const l = disasmLines([0x23, 0xFC, 0x53, 0x45, 0x47, 0x41, 0x00, 0xA1, 0x40, 0x00]);
  assert.equal(l[0], "move.l #$53454741,($00A14000).l");
});

test("decodes andi.b / beq", () => {
  const l = disasmLines([0x02, 0x00, 0x00, 0x0F, 0x67, 0x0A], 0x200);
  assert.equal(l[0], "andi.b #$0F,d0");
  // beq is at 0x204; target = 0x204 + 2 + 0x0A = 0x210.
  assert.equal(l[1], "beq L000210");
});

test("unknown opcode emits .dc.w and stays aligned", () => {
  // 46FC (move to SR, privileged — not decoded) then nop
  const l = disasmLines([0x46, 0xFC, 0x4E, 0x71]);
  assert.equal(l[0], ".dc.w $46FC");
  assert.equal(l[1], "nop");
});
