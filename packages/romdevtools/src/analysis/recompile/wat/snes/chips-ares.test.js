// ares's firmware chips as recompiled-cart units (ares-chips.json,
// chips-ares.js): the units run tiny synthetic firmware, and the timing is
// ares's scheduler (each thread's clock steps by 2^63 / frequency per clock of
// its own; the chip runs while it is behind the S-CPU). No commercial firmware
// or ROM is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { placeUnit } from "../wasm-unit.js";
import { assembleWatSync } from "../assemble.js";
import { describe } from "./index.js";

const UNITS = JSON.parse(readFileSync(new URL("./ares-chips.json", import.meta.url), "utf8")).units;
const BASE = 0x10000;

/** One unit alone in a module, its exports exported, the firmware at `fw`. */
async function instance(name, firmware) {
  const u = UNITS[name];
  const pages = Math.ceil((BASE + u.size) / 0x10000) + Math.ceil(firmware.length / 0x10000) + 2;
  const fw = (Math.ceil((BASE + u.size) / 0x10000)) * 0x10000;
  const exp = Object.entries(u.exports).map(([k, v]) => `  (export "${k}" (func ${v}))`).join("\n");
  const wat = `(module\n  (memory (export "memory") ${pages})\n${placeUnit(u, BASE, name)}\n${exp}\n)`;
  const { instance: inst } = await WebAssembly.instantiate(assembleWatSync(wat));
  new Uint8Array(inst.exports.memory.buffer, fw, firmware.length).set(firmware);
  return { x: inst.exports, fw, mem: inst.exports.memory };
}

test("uPD96050 unit: ares's instructions, DR / SR / data RAM ports, one instruction per S-CPU master clock step at 15 MHz", async () => {
  const fw = new Uint8Array(UNITS.necdsp.firmware);
  const word = (n, v) => { fw[n * 3] = v & 0xff; fw[n * 3 + 1] = (v >> 8) & 0xff; fw[n * 3 + 2] = (v >> 16) & 0xff; };
  word(0, (3 << 22) | (0xbeef << 6) | 6);   // LD #$BEEF -> DR (RQM = 1)
  word(1, (3 << 22) | (0x1234 << 6) | 15);  // LD #$1234 -> RAM[DP]
  word(2, (2 << 22) | (0x100 << 13) | (2 << 2)); // LJMP 2
  const { x, fw: at } = await instance("necdsp", fw);
  x.romdev_necdsp_init(11, at);
  assert.equal(x.romdev_necdsp_read(0x600001, 0), 0x00, "SR before the chip ran: RQM clear");
  // one master clock (2^63 / 21477273) is less than one chip clock at 15 MHz
  // (2^63 / 15000000): one instruction puts the chip ahead
  x.romdev_necdsp_line(1);
  assert.equal(x.romdev_necdsp_read(0x600001, 0) & 0x80, 0x80, "RQM after LD -> DR");
  assert.equal(x.romdev_necdsp_read(0x680000, 0), 0x00, "the second instruction has not run yet");
  x.romdev_necdsp_line(1);
  assert.equal(x.romdev_necdsp_read(0x680000, 0), 0x34, "RAM low byte");
  assert.equal(x.romdev_necdsp_read(0x680001, 0), 0x12, "RAM high byte");
  assert.equal(x.romdev_necdsp_read(0x600000, 0), 0xef, "DR low");
  assert.equal(x.romdev_necdsp_read(0x600000, 0), 0xbe, "DR high");
  const n = x.romdev_necdsp_chipstate(0x100);
  assert.equal(n, UNITS.necdsp.chipstate.romdev_necdsp_chipstate);
});

test("ARM unit: a cothread that yields inside its boot delay and its stores, the bridge as the S-CPU sees it", async () => {
  const fw = new Uint8Array(UNITS.armdsp.firmware);
  const put = (a, v) => { fw[a] = v & 0xff; fw[a + 1] = (v >>> 8) & 0xff; fw[a + 2] = (v >>> 16) & 0xff; fw[a + 3] = (v >>> 24) & 0xff; };
  put(0x0, 0xe3a00101);  // mov r0, #0x40000000
  put(0x4, 0xe3a0105a);  // mov r1, #0x5a
  put(0x8, 0xe5c01000);  // strb r1, [r0]   (bridge armtocpu)
  put(0xc, 0xeafffffe);  // b .
  const { x, fw: at } = await instance("armdsp", fw);
  x.romdev_armdsp_init(at);
  assert.equal(x.romdev_armdsp_read(0x3804, 0), 0x00, "status at power-on: not ready");
  // the reset sequence delay is step(65536): ready only after the S-CPU has
  // run 65536 ARM clocks' worth (about 65536 * 21477273 / 21440000 master clocks)
  x.romdev_armdsp_line(60000);
  assert.equal(x.romdev_armdsp_read(0x3804, 0), 0x00, "still in the boot delay");
  x.romdev_armdsp_line(10000);
  assert.equal(x.romdev_armdsp_read(0x3804, 0), 0x81, "ready, and the ARM's byte is waiting");
  assert.equal(x.romdev_armdsp_read(0x3800, 0), 0x5a, "the byte");
  assert.equal(x.romdev_armdsp_read(0x3804, 0), 0x80, "taken");
  assert.equal(x.romdev_armdsp_read(0x3000, 0), -1, "outside $3800-$38FF is not the chip's");
  const n = x.romdev_armdsp_chipstate(0x100);
  assert.equal(n, UNITS.armdsp.chipstate.romdev_armdsp_chipstate);
});

/** A 64KB LoROM image whose header names a SETA chip. */
function setaRom(romType, speed, sizeByte) {
  const img = new Uint8Array(0x10000);
  img.set(Buffer.from("SETA CHIP TEST       "), 0x7fc0);
  img[0x7fd5] = speed; img[0x7fd6] = romType; img[0x7fd7] = sizeByte; img[0x7fd8] = 0x02;
  img[0x7ffc] = 0x00; img[0x7ffd] = 0x80;
  img[0x8000 - 0x8000] = 0x80; img[1] = 0xfe;  // bra -2 at $8000
  let sum = 0;
  for (const b of img) sum += b;
  sum = (sum + 0x1fe) & 0xffff;
  img[0x7fde] = sum & 0xff; img[0x7fdf] = sum >> 8; img[0x7fdc] = ~sum & 0xff; img[0x7fdd] = (~sum >> 8) & 0xff;
  return img;
}

test("an ST011 / ST018 cart without options.firmware is refused, naming the file it needs", () => {
  const d18 = describe(setaRom(0xf5, 0x30, 0x09));
  assert.equal(d18.coprocessor, "ST018");
  assert.equal(d18.supported, false);
  assert.match(d18.refusal, /options\.firmware.*st018\.rom.*163840 bytes/);
  const d11 = describe(setaRom(0xf6, 0x30, 0x09));
  assert.equal(d11.coprocessor, "ST011");
  assert.match(d11.refusal, /st011\.rom.*53248 bytes/);
  // the ST010 keeps snes9x's own chip
  const d10 = describe(setaRom(0xf6, 0x30, 0x0a));
  assert.equal(d10.coprocessor, "ST010");
  assert.equal(d10.chipImpl, null);
});
