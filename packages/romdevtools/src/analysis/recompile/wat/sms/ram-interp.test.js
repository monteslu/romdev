// The SMS / Game Gear Z80 interpreter (interp.js): code no compiled arm
// covers runs exactly, with default build options, and the same carts built
// with ramInterpreter:false (the must-fail control) trap and diverge. Checked
// against genesis_plus_gx frame by frame (gpgx-parity.js). Tiny synthetic
// ROMs only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gpgxParity, divergenceText } from "./gpgx-parity.js";
import { buildZ80Templates, NKEYS } from "./interp.js";
import { interpTemplates, instructionIndex, Emitter, z80Length } from "./index.js";

/** Mini Z80 assembler: byte arrays, "label:" strings, ["jr", cond|null, label] / ["djnz", label] / ["call"|"jp", label]. */
function z80(items, org = 0) {
  const labels = {}, fix = [], out = [];
  for (const it of items) {
    if (typeof it === "string") { labels[it.replace(/:$/, "")] = org + out.length; continue; }
    if (Array.isArray(it) && typeof it[0] === "string") {
      const [op, a, b] = it;
      if (op === "jr") { out.push(a ? { nz: 0x20, z: 0x28, nc: 0x30, c: 0x38 }[a] : 0x18, 0); fix.push([out.length - 1, b, "rel"]); }
      else if (op === "djnz") { out.push(0x10, 0); fix.push([out.length - 1, a, "rel"]); }
      else { out.push(op === "jp" ? 0xC3 : 0xCD, 0, 0); fix.push([out.length - 2, a, "abs"]); }
      continue;
    }
    out.push(...it);
  }
  for (const [at, l, kind] of fix) {
    if (kind === "rel") out[at] = (labels[l] - (org + at + 1)) & 0xFF;
    else { out[at] = labels[l] & 0xFF; out[at + 1] = labels[l] >> 8; }
  }
  return out;
}

function smsImage(code, { size = 0x8000, at = [] } = {}) {
  const rom = new Uint8Array(size);
  rom.set(code, 0);
  for (const [off, bytes] of at) rom.set(bytes, off);
  for (const [i, ch] of [..."TMR SEGA"].entries()) rom[0x7FF0 + i] = ch.charCodeAt(0);
  rom[0x7FFF] = 0x40 | (size >= 0x10000 ? 0xE : 0xC);
  return rom;
}

/**
 * Code for $C100 using every prefix group (DD, FD, CB, ED, DD CB), relative
 * and absolute flow, a call/ret pair, LDIR and RLD; $C105 is the operand of
 * `ld a,n`, which the main loop bumps before every call.
 */
const payload = z80([
  [0xDD, 0x21, 0x00, 0xC2], [0x3E, 0x05], [0xDD, 0x86, 0x03], [0xDD, 0x77, 0x04],
  [0x21, 0x10, 0xC2], [0x34], [0xCB, 0x26], [0xED, 0x44], [0x06, 0x04],
  "l1:", [0x23], [0x86], [0x77], ["djnz", "l1"],
  [0x32, 0x20, 0xC2], [0xED, 0x6F], [0xF5], [0xE1], [0x22, 0x22, 0xC2],
  [0xDD, 0x36, 0x06, 0x77], [0xFD, 0x21, 0x30, 0xC2], [0xFD, 0xCB, 0x00, 0x06], [0xFD, 0x34, 0x01],
  [0x11, 0x40, 0xC2], [0x21, 0x00, 0xC2], [0x01, 0x08, 0x00], [0xED, 0xB0],
  ["jr", "z", "l2"], [0x3C], [0x3C], "l2:", ["call", "sub"], [0xED, 0x5F], [0x32, 0x23, 0xC2], [0xC9],
  "sub:", [0x3A, 0x20, 0xC2], [0xC6, 0x11], [0x32, 0x21, 0xC2], [0xD9], [0x08], [0xC9],
], 0xC100);

/**
 * Waits for button 1, then writes the payload to $C100 (kept XOR $A5 in the
 * ROM, so no scan of the image can find it, and no reference run without
 * that press executes it) and calls it forever, patching it between calls.
 */
function afterPressCart() {
  const ENC = 0x400;
  const main = z80([
    [0xF3], [0x31, 0xF0, 0xDF],
    "wait:", [0xDB, 0xDC], [0xCB, 0x67], ["jr", "nz", "wait"],
    [0x21, ENC & 0xFF, ENC >> 8], [0x11, 0x00, 0xC1], [0x01, payload.length & 0xFF, payload.length >> 8],
    "cp:", [0x7E], [0xEE, 0xA5], [0x12], [0x23], [0x13], [0x0B], [0x78], [0xB1], ["jr", "nz", "cp"],
    "loop:", [0xCD, 0x00, 0xC1], [0x21, 0x05, 0xC1], [0x34], ["jr", null, "loop"],
  ]);
  return smsImage(main, { at: [[ENC, payload.map((b) => b ^ 0xA5)]] });
}

const T = { timeout: 300000 };

test("Z80 interpreter templates: one per encoding key, each reproducing the compiled arm", T, async () => {
  const { templates, stats } = await interpTemplates();
  // every key but the six that are prefixes of other keys (CB/ED/DD/FD, DD CB, FD CB)
  assert.equal(stats.keys, NKEYS - 6);
  assert.equal(templates.filter(Boolean).length, NKEYS - 6);
  // jr: the target is the instruction address + 2 + the signed displacement
  assert.match(templates[0x18].text, /\(global\.set \$pc \(i32\.and \(i32\.add \(local\.get \$ia\) \(i32\.add \(i32\.const 2\) \(i32\.extend8_s \(local\.get \$b1\)\)\)\) \(i32\.const 0xFFFF\)\)\)/);
  // ld (ix+d),n: the displacement is the sign-extended third byte, the value the fourth
  assert.match(templates[0x300 + 0x36].text, /\(i32\.extend8_s \(local\.get \$b2\)\)[\s\S]*\(local\.get \$b3\)/);
});

test("Z80 interpreter templates: a lowering whose constant fits no operand expression fails the build (must-fail control)", T, async () => {
  const em = new Emitter(new Uint8Array(0), { legacy: false, breakArm: null, ramRegions: [], ramInterpreter: true }, new Map(), [], null);
  // a corrupted lowering: `ld a,n` also stores 3*n somewhere
  const body = (a, size, ins, byteAt) => em.body(a, 0, size, ins, byteAt, undefined) +
    (byteAt(0) === 0x3E ? ` (global.set $a (i32.const ${(byteAt(1) * 3) & 0xFF}))` : "");
  await assert.rejects(buildZ80Templates({ decode: async (img) => (await instructionIndex(img, "sms")).idx, body, length: z80Length }),
    /key 3e: constant #\d+ .* fits no operand expression/);
});

test("code written to RAM only after a button press runs exactly with default options; ramInterpreter:false diverges", T, async () => {
  const rom = afterPressCart();
  const r = await gpgxParity({ platform: "sms", rom, input: "10:b:5", maxFrames: 60 });
  assert.equal(r.diverged, false, divergenceText(r));
  // must-fail control: the same cart and input with the interpreter off
  const c = await gpgxParity({ platform: "sms", rom, input: "10:b:5", maxFrames: 60, options: { ramInterpreter: false } });
  assert.equal(c.diverged, true, "the control must diverge: without the interpreter the RAM code has no arm");
  assert.ok(c.atRefFrame >= 10, `diverges once the code runs (ref frame ${c.atRefFrame})`);
});

test("a slot paged by a store the ROM scan cannot see runs the paged bank's code in the interpreter", T, async () => {
  // ld hl,$FFFE; ld (hl),3 pages bank 3 into slot 1 (no direct store to
  // $FFFE in the ROM, so pagesSlot1 is false and only bank 1 has arms there)
  const main = z80([[0xF3], [0x31, 0xF0, 0xDF], [0x21, 0xFE, 0xFF], [0x36, 0x03],
    "loop:", [0xCD, 0x00, 0x40], [0x21, 0x30, 0xC0], [0x34], ["jr", null, "loop"]]);
  const bank3 = z80([[0x3A, 0x30, 0xC0], [0xC6, 0x42], [0x32, 0x10, 0xC0], [0xDD, 0x21, 0x20, 0xC0], [0xDD, 0x77, 0x05], [0xC9]], 0x4000);
  const bank1 = z80([[0x3E, 0x99], [0x32, 0x10, 0xC0], [0xC9]], 0x4000);
  const rom = smsImage(main, { size: 0x10000, at: [[0x4000, bank1], [0xC000, bank3]] });
  const r = await gpgxParity({ platform: "sms", rom, maxFrames: 20 });
  assert.equal(r.diverged, false, divergenceText(r));
  const c = await gpgxParity({ platform: "sms", rom, maxFrames: 20, options: { ramInterpreter: false } });
  assert.equal(c.diverged, true, "the control must diverge: without the interpreter slot 1 has no arm for bank 3");
});
