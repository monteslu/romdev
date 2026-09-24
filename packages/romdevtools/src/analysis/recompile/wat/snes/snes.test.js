// SNES WAT backend tests on tiny synthetic ROMs (never commercial ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describe as describeRom, emitWat, emitWatString, recompileSection, platforms, conventions,
} from "./index.js";
import { lower, decode, oplen, isopTable, modeTable, Unsupported } from "./lower.js";
import { computeLayout, WRAM, VRAM, CGRAM, PROBE, PROBE_FIELDS } from "./layout.js";
import { opcodeInfo } from "../../decode-65816.js";
import { backendFor } from "../index.js";
import { assembleWat } from "../assemble.js";

/**
 * A LoROM image: `code` at $00:8000 (file 0), reset/NMI/IRQ vectors into it,
 * and a valid header at $7FC0.
 */
function synthRom({ code = [0x80, 0xfe], banks = 1, mapMode = 0x20, chipset = 0x00, sram = 0, copier = false, nmi = null } = {}) {
  const img = new Uint8Array(banks * 0x8000).fill(0xea);
  img.set(code, 0);
  const h = 0x7fc0;
  const title = "SYNTHETIC TEST ROM   ";
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = mapMode;
  img[h + 0x16] = chipset;
  img[h + 0x17] = 0x08;
  img[h + 0x18] = sram;
  img[h + 0x19] = 0x01;
  let sum = 0;
  for (const b of img) sum = (sum + b) & 0xffff;
  const ck = sum, cm = ck ^ 0xffff;
  img[h + 0x1c] = cm & 0xff; img[h + 0x1d] = cm >> 8;
  img[h + 0x1e] = ck & 0xff; img[h + 0x1f] = ck >> 8;
  const vec = (off, a) => { img[off] = a & 0xff; img[off + 1] = a >> 8; };
  vec(0x7ffc, 0x8000);                   // RESET
  vec(0x7fea, nmi ?? 0x8000);            // native NMI
  vec(0x7fee, 0x8000);                   // native IRQ
  if (!copier) return img;
  const out = new Uint8Array(512 + img.length);
  out.set(img, 512);
  return out;
}

/** Paren balance outside strings and ;; comments. */
function checkBalanced(s) {
  let depth = 0, inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ";" && s[i + 1] === ";") { while (i < s.length && s[i] !== "\n") i++; }
    else if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth < 0) throw new Error(`unbalanced ')' at ${i}`); }
  }
  assert.equal(depth, 0, "unclosed '('");
}

test("registry resolves snes to this backend", async () => {
  const b = await backendFor("snes");
  assert.deepEqual(b.platforms, ["snes"]);
  assert.equal(typeof b.emitWat, "function");
  assert.equal(typeof b.describe, "function");
  assert.deepEqual(platforms, ["snes"]);
});

test("describe: LoROM header, copier header, SRAM mask", () => {
  const d = describeRom(synthRom({ sram: 3 }));
  assert.equal(d.mapping, "lorom");
  assert.equal(d.supported, true);
  assert.equal(d.copierHeader, 0);
  assert.equal(d.title, "SYNTHETIC TEST ROM");
  assert.equal(d.sramSize, 8192);
  assert.equal(d.sramMask, 0x1fff);     // 8KB mirrors through the $70-$7D window
  assert.equal(d.resetVector, 0x8000);
  const c = describeRom(synthRom({ copier: true }));
  assert.equal(c.copierHeader, 512);
  assert.equal(c.romSize, 0x8000);
  assert.equal(c.sramMask, 0x7fff);     // no SRAM: the 32KB scratch window
  assert.equal(c.layout.regions.sram, undefined);
});

test("describe refuses coprocessor carts and names the chip", async () => {
  for (const [chip, name] of [[0x13, "SuperFX"], [0x34, "SA-1"], [0x03, "DSP"], [0x43, "S-DD1"]]) {
    const r = synthRom({ chipset: chip });
    const d = describeRom(r);
    assert.equal(d.supported, false);
    assert.match(d.refusal, new RegExp(name.replace("-", "\\-")));
    await assert.rejects(emitWatString(r), /refused/);
  }
  // Low nibble 0-2 is ROM / RAM / battery, not a coprocessor.
  assert.equal(describeRom(synthRom({ chipset: 0x02 })).supported, true);
});

test("describe detects HiROM and refuses it with the reason", () => {
  const img = new Uint8Array(0x10000).fill(0);
  const h = 0xffc0;
  for (let i = 0; i < 21; i++) img[h + i] = "HIROM SYNTH          ".charCodeAt(i);
  img[h + 0x15] = 0x21; img[h + 0x17] = 0x09;
  img[h + 0x1c] = 0xff; img[h + 0x1d] = 0x00; img[h + 0x1e] = 0x00; img[h + 0x1f] = 0xff;
  img[0xfffc] = 0x00; img[0xfffd] = 0x80;
  const d = describeRom(img);
  assert.equal(d.mapping, "hirom");
  assert.equal(d.supported, false);
  assert.match(d.refusal, /HiROM/);
});

test("the lowerer's opcode grid IS romdev's 65816 decoder table", () => {
  let n = 0;
  for (let op = 0; op < 256; op++) {
    const e = opcodeInfo(op);
    assert.ok(e, `opcode ${op} decodes`);
    assert.deepEqual(decode(Uint8Array.of(op, 0, 0, 0), 0), { mnem: e.mnem, mode: e.mode, op });
    n++;
  }
  assert.equal(n, 256);
  const it = isopTable(), mt = modeTable();
  assert.equal(it.length, 256);
  assert.equal(it[0xa9], 1);           // lda #imm -> lda
  assert.equal(it[0x1a], 0);           // inc a is handled before the grid
  assert.equal(mt[0xa2], 2);           // ldx #imm -> immX
  assert.equal(mt[0xb7], 10);          // lda [dp],y
});

test("M/X immediates: length follows the flag, both readings lower", () => {
  assert.equal(oplen("immM", 1, 1), 2);
  assert.equal(oplen("immM", 0, 1), 3);
  assert.equal(oplen("immX", 1, 0), 3);
  const rom = Uint8Array.of(0xa9, 0x34, 0x12);
  const [b8] = lower(rom, 0, 2, 0, 0x8000);
  const [b16] = lower(rom, 0, 3, 0, 0x8000);
  assert.match(b8, /\(i32\.const 52\)/);
  assert.match(b8, /0xFF00/);           // an 8-bit load keeps B
  assert.match(b16, /\(global\.set \$a \(i32\.const 4660\)\)/);
});

test("relative branches resolve in file-offset space inside their own bank", () => {
  // bra -2 at $01:8010 (file 0x8010) lands on $01:800E.
  const rom = new Uint8Array(0x10000);
  rom[0x8010] = 0x80; rom[0x8011] = 0xfc;
  const [, flow] = lower(rom, 0x8010, 2, 1, 0x8010);
  assert.equal(flow.kind, "jp_file");
  assert.equal((0x8010 + flow.delta) & 0xffff, 0x800e);
  // jsl pushes the bank and the address of its last byte.
  rom[0x20] = 0x22; rom[0x21] = 0x56; rom[0x22] = 0x34; rom[0x23] = 0x82;
  const [body, jf] = lower(rom, 0x20, 4, 0, 0x8020);
  assert.deepEqual(jf, { kind: "jp", bank: 0x82, addr: 0x3456 });
  assert.match(body, /\(i32\.const 0\)\)\(global\.set \$s/);
  assert.match(body, /\(i32\.const 32803\)/);   // $8023
  assert.throws(() => lower(Uint8Array.of(0x00, 0x00), 0, 2, 0, 0x8000), Unsupported);
});

test("layout places every region clear of its neighbours and follows the ROM size", () => {
  for (const size of [0x8000, 0x80000, 0x300000]) {
    const lay = computeLayout(size, 0x7fff, size);
    assert.ok(lay.PCTAB >= 0x100000 + size);
    assert.ok(lay.FB >= lay.PACKED + 8 * size);
    assert.ok(lay.ARAM >= lay.ABI + 0x1000);
    assert.ok(lay.pages * 65536 >= lay.ARAM + 0x10000);
  }
});

test("recompileSection carries the region map, probe and conventions", () => {
  const s = recompileSection(synthRom(), "ab".repeat(20));
  assert.equal(s.name, "romdev.recompile");
  const j = s.json;
  assert.equal(j.version, 1);
  assert.equal(j.platform, "snes");
  assert.equal(j.reference, "snes");
  assert.equal(j.romSha1, "ab".repeat(20));
  assert.deepEqual(j.regions.vram, { offset: VRAM, length: 0x10000, ref: "video_ram" });
  assert.deepEqual(j.regions.cgram, { offset: CGRAM, length: 0x200, ref: "snes_cgram" });
  assert.deepEqual(j.regions.wram, { offset: WRAM, length: 0x20000, ref: "system_ram" });
  assert.equal(j.probe.trapped.offset, PROBE + PROBE_FIELDS.trapped);
  assert.deepEqual(j.vramZero, ["vram"]);
  assert.equal(j.conventions, conventions);
});

test("emitWat streams chunks that concatenate to one balanced module", async () => {
  const rom = synthRom({ banks: 2 });
  const chunks = [];
  const stats = {};
  for await (const c of emitWat(rom, { stats })) chunks.push(c);
  assert.ok(chunks.length > 20, "emitted as many chunks, not one string");
  const text = chunks.join("");
  assert.ok(text.startsWith("(module\n"));
  assert.ok(text.endsWith("\n)"));
  checkBalanced(text);
  assert.equal(stats.arms, 0x10000);
  assert.equal(stats.lowered + stats.interpreted, stats.arms);
  // 64 shards of 1024 arms, dispatched by binary search.
  assert.match(text, /\(func \$shard63 /);
  assert.doesNotMatch(text, /\(func \$shard64 /);
  // regwatch and pcSkip are options now, not env knobs.
  const w = await emitWatString(rom, { regwatchPc: 0x8123, pcSkip: "806B-806D", limit: 2048 });
  assert.match(w, /REGISTER WATCH at \$8123/);
  assert.match(w, /\(i32\.const 0x806B\)/);
});

/** Run a synthetic cart for `frames` frames; returns the memory. */
async function runCart(rom, frames = 2) {
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  for (let i = 0; i < frames; i++) ex.wc_render();
  return { mem: new Uint8Array(ex.memory.buffer), ex };
}

test("a synthetic cart runs: runtime M/X width, CGRAM, backdrop colour, NMI", async () => {
  const code = [
    0x78,                         // sei
    0x18, 0xfb,                   // clc / xce: native mode
    0xc2, 0x20,                   // rep #$20: 16-bit A
    0xa9, 0x34, 0x12,             // lda #$1234  (3 bytes because M=0)
    0x8f, 0x10, 0x00, 0x7e,       // sta $7E0010
    0xe2, 0x20,                   // sep #$20: 8-bit A
    0xa9, 0x56,                   // lda #$56    (2 bytes because M=1)
    0x8f, 0x12, 0x00, 0x7e,       // sta $7E0012
    0x9c, 0x21, 0x21,             // stz $2121: CGRAM address 0
    0xa9, 0x1f, 0x8d, 0x22, 0x21, // lda #$1F / sta $2122 (low byte: red 31)
    0x9c, 0x22, 0x21,             // stz $2122            (high byte)
    0xa9, 0x0f, 0x8d, 0x00, 0x21, // lda #$0F / sta $2100: display on, full brightness
    0xa9, 0x80, 0x8d, 0x00, 0x42, // lda #$80 / sta $4200: NMI on
    0x80, 0xfe,                   // bra *
  ];
  // NMI handler at $8100: inc $7E0020 / rti
  const rom = synthRom({ code, nmi: 0x8100 });
  rom.set([0xee, 0x20, 0x00, 0x40], 0x100);   // inc $0020 (DB=0 -> WRAM mirror), rti
  const { mem, ex } = await runCart(rom, 3);
  assert.equal(ex.dbg_trapped(), 0, `trapped at ${ex.dbg_trappc().toString(16)}`);
  assert.equal(mem[WRAM + 0x10], 0x34);
  assert.equal(mem[WRAM + 0x11], 0x12);
  assert.equal(mem[WRAM + 0x12], 0x56);
  assert.equal(mem[CGRAM], 0x1f);
  assert.ok(mem[WRAM + 0x20] >= 2, `NMI ran each frame (count ${mem[WRAM + 0x20]})`);
  const lay = describeRom(rom).memory;
  // Backdrop is CGRAM 0 = pure red at full brightness. Framebuffer words
  // are 0xAARRGGBB, i.e. bytes B, G, R, A.
  const px = lay.FB + (100 * 256 + 128) * 4;
  assert.ok(mem[px + 2] > 0xf0 && mem[px + 1] < 0x10 && mem[px] < 0x10 && mem[px + 3] === 0xff,
    `pixel rgba ${[...mem.subarray(px, px + 4)]}`);
  const dv = new DataView(mem.buffer);
  assert.ok(dv.getUint32(PROBE + PROBE_FIELDS.nnmi, true) >= 2);
  assert.equal(dv.getUint32(PROBE + PROBE_FIELDS.trapped, true), 0);
});

test("a cart that executes BRK falls to the interpreter, which traps", async () => {
  const rom = synthRom({ code: [0x18, 0xfb, 0x00, 0x00] });
  const { ex } = await runCart(rom, 1);
  assert.equal(ex.dbg_trapped(), 1);
});
