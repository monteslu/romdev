// The Genesis 68000 interpreter (interp.js): code no compiled arm covers runs
// exactly with default build options, and the same cart built with
// ramInterpreter:false (the must-fail control) traps and diverges. Checked
// against genesis_plus_gx frame by frame (../sms/gpgx-parity.js). Tiny
// synthetic ROMs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "../sms/gpgx-parity.js";
import { loadGpgxData } from "./gpgx-data.js";
import { m68kInterpHandlers, interpHandler } from "./interp.js";
import { translateM68k } from "./ctrans.js";
import { discoverRamCode } from "./index.js";

const W = (...ws) => ws.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
const L = (v) => W((v >>> 16) & 0xffff, v & 0xffff);

function mdImage(code, { size = 0x10000, at = [] } = {}) {
  const rom = new Uint8Array(size);
  rom.set(L(0x00fffe00), 0);
  rom.set(L(0x200), 4);
  const rte = size - 0x10;
  for (let v = 2; v < 64; v++) rom.set(L(rte), v * 4);
  rom.set(W(0x4e73), rte);
  const text = (off, s) => { for (let i = 0; i < s.length; i++) rom[off + i] = s.charCodeAt(i); };
  text(0x100, "SEGA MEGA DRIVE ");
  text(0x150, "SYNTHETIC TEST CART");
  text(0x190, "J".padEnd(16, " "));
  text(0x1f0, "JUE".padEnd(16, " "));
  rom.set(code, 0x200);
  for (const [off, bytes] of at) rom.set(bytes, off);
  return rom;
}

/**
 * 68000 code for $FF0100: an immediate the main loop patches ($FF0102),
 * PC-relative lea, d8(An,Xn) with the index register named by the extension
 * word, movem both ways, dbf, bsr/rts and a Bcc.
 */
const payload = W(
  0x363C, 0x0005,            // move.w #5,d3
  0x41FA, 0x00FA,            // lea $FF0200(pc),a0
  0x7202,                    // moveq #2,d1
  0x3030, 0x1004,            // move.w 4(a0,d1.w),d0
  0xD043,                    // add.w d3,d0
  0x3140, 0x0010,            // move.w d0,16(a0)
  0x48E7, 0xC0C0,            // movem.l d0-d1/a0-a1,-(sp)
  0x4CDF, 0x0303,            // movem.l (sp)+,d0-d1/a0-a1
  0x7403,                    // moveq #3,d2
  0x5268, 0x0012,            // l2: addq.w #1,18(a0)
  0x51CA, 0xFFFA,            // dbf d2,l2
  0x6100, 0x0006,            // bsr.w sub
  0x4E75,                    // rts
  0x4E71,                    // nop
  0x317C, 0x1234, 0x0014,    // sub: move.w #$1234,20(a0)
  0x4A40,                    // tst.w d0
  0x6702,                    // beq.s +2
  0x5240,                    // addq.w #1,d0
  0x33C0, 0x00FF, 0x0220,    // move.w d0,$FF0220
  0x4E75);                   // rts

/**
 * Waits for B on pad 1, then decodes the payload (kept XOR $A55A in the ROM,
 * through a loop the copy-loop scan does not match) to $FF0100 and calls it
 * forever, bumping its first immediate between calls.
 */
function afterPressCart() {
  const ENC = 0x400;
  const code = [
    ...W(0x13FC, 0x0040), ...L(0xA10009), ...W(0x13FC, 0x0040), ...L(0xA10003),
    ...W(0x1039), ...L(0xA10003), ...W(0x0800, 0x0004, 0x66F4),             // wait: btst #4 (B)
    ...W(0x41F9), ...L(ENC), ...W(0x43F9), ...L(0xFF0100), ...W(0x323C, payload.length / 2 - 1),
    ...W(0x3418, 0x0A42, 0xA55A, 0x32C2, 0x51C9, 0xFFF6),                    // move.w (a0)+,d2; eori; move.w d2,(a1)+; dbf
    ...W(0x4EB9), ...L(0xFF0100), ...W(0x5279), ...L(0xFF0102), ...W(0x60F2), // jsr; addq.w #1,$FF0102; bra
  ];
  const enc = [];
  for (let i = 0; i < payload.length; i += 2) enc.push(...W(((payload[i] << 8) | payload[i + 1]) ^ 0xA55A));
  return mdImage(code, { at: [[ENC, enc]] });
}

const T = { timeout: 300000 };

test("68000 interpreter: every opcode word has a handler; relocated handlers reproduce the arm translated at other addresses", T, () => {
  const D = loadGpgxData();
  const { handlers, stats } = m68kInterpHandlers(D);
  assert.equal(handlers.length, 0x10000);
  assert.equal(stats.translated + stats.untranslatable, 0x10000);
  assert.equal(stats.untranslatable, 0);
  // bra.w: pc = curpc + 2 + the extension word, read at run time
  assert.match(handlers[0x6000].body, /\(global\.set \$pc \(i32\.add \(i32\.add \(global\.get \$curpc\) \(i32\.const 2\)\) \(i32\.extend16_s/);
  // move.w d8(a0,Xn),d0: the index register comes from the extension word
  assert.match(handlers[0x3030].body, /\(call \$dar_get /);
  // the ROM arm of a jsr abs.l at $1000 is the template with $curpc = $1000 and the words of that ROM
  const words = { 0x1002: 0x0001, 0x1004: 0x2340 };
  const rom = translateM68k(D.m68k, 0x4EB9, 0x1000, (p) => words[p]).body;
  const h = interpHandler(D.m68k, 0x4EB9).body;
  assert.ok(rom.includes("(i32.const 4102)") && h.includes("(i32.add (global.get $curpc) (i32.const 6))"), "the return address is relocated");
});

test("the payload is not found by the copy-loop scan (so the test exercises the interpreter, not a compiled RAM arm)", () => {
  assert.deepEqual(discoverRamCode(afterPressCart()), []);
});

test("68000 code written to work RAM only after a button press runs exactly with default options; ramInterpreter:false diverges", T, async () => {
  const rom = afterPressCart();
  const r = await gpgxParity({ platform: "genesis", rom, input: "10:b:5", maxFrames: 40 });
  assert.equal(r.diverged, false, divergenceText(r));
  const c = await gpgxParity({ platform: "genesis", rom, input: "10:b:5", maxFrames: 40, options: { ramInterpreter: false } });
  assert.equal(c.diverged, true, "the control must diverge: without the interpreter the RAM code has no arm");
  assert.ok(c.atRefFrame >= 10, `diverges once the code runs (ref frame ${c.atRefFrame})`);
});
