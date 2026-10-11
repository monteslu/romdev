// SNES WAT backend tests on tiny synthetic ROMs (never commercial ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describe as describeRom, emitWat, emitWatString, recompileSection, platforms, conventions,
} from "./index.js";
import { lower, decode, oplen, isopTable, modeTable } from "./lower.js";
import { computeLayout, WRAM, VRAM, CGRAM, OAM, PROBE, PROBE_FIELDS, INPUT } from "./layout.js";
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
  assert.equal(c.sramMask, 0);          // no SRAM: snes9x SRAMMask 0 (reads byte 0, writes dropped)
  assert.equal(c.layout.regions.sram, undefined);
  assert.equal(d.layout.diagnosticRegions.sram.length, 8192);
});

test("describe refuses coprocessor carts and names the chip (snes9x InitROM's ROMType/ROMSpeed detection)", async () => {
  // (the DSP-n, SETA, OBC1 and S-RTC chips are modelled: chips.test.js)
  // (the SA-1 is modelled: sa1.test.js)
  // (the SuperFX is modelled: superfx.test.js)
  for (const [chip, mapMode, name] of /** @type {Array<[number, number, string]>} */ ([])) {
    const r = synthRom({ chipset: chip, mapMode });
    const d = describeRom(r);
    assert.equal(d.supported, false);
    assert.match(d.refusal, new RegExp(name.replace("-", "\\-")));
    await assert.rejects(emitWatString(r), /refused/);
  }
  // Low nibble 0-2 is ROM / RAM / battery, not a coprocessor.
  assert.equal(describeRom(synthRom({ chipset: 0x02 })).supported, true);
});

test("describe detects HiROM and accepts it", () => {
  const img = new Uint8Array(0x10000).fill(0);
  const h = 0xffc0;
  for (let i = 0; i < 21; i++) img[h + i] = "HIROM SYNTH          ".charCodeAt(i);
  img[h + 0x15] = 0x21; img[h + 0x17] = 0x09;
  img[h + 0x1c] = 0xff; img[h + 0x1d] = 0x00; img[h + 0x1e] = 0x00; img[h + 0x1f] = 0xff;
  img[0xfffc] = 0x00; img[0xfffd] = 0x80;
  const d = describeRom(img);
  assert.equal(d.mapping, "hirom");
  assert.equal(d.supported, true);
  assert.equal(d.resetVector, 0x8000);
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
  assert.equal((0x8010 + Number(/(-?\d+)\)$/.exec(flow.delta)[1])) & 0xffff, 0x800e);
  // jsl pushes the bank and the address of its last byte.
  rom[0x20] = 0x22; rom[0x21] = 0x56; rom[0x22] = 0x34; rom[0x23] = 0x82;
  const [body, jf] = lower(rom, 0x20, 4, 0, 0x8020);
  assert.deepEqual(jf, { kind: "jp", bank: 0x82, addr: 0x3456 });
  // The pushed bank and return address come from the LIVE pc (the arm also
  // runs at the $80 mirror): PB = pc >> 16, return = pc + 3.
  assert.match(body, /\(i32\.shr_u \(global\.get \$pc\) \(i32\.const 16\)\)\)\(global\.set \$s/);
  assert.match(body, /\(i32\.add \(global\.get \$pc\) \(i32\.const 3\)\)/);
  // BRK lowers to the snes9x interrupt sequence through $FFE6 / $FFFE.
  const [brk, bf] = lower(Uint8Array.of(0x00, 0x00), 0, 2, 0, 0x8000);
  assert.equal(bf.kind, "jp_expr");
  assert.match(brk, /i32\.const 65510/);
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

test("BRK and COP vector, push PB/PC+2/P and clear D, as snes9x does", async () => {
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x30, 0xa2, 0xf0, 0x01, 0x9a, 0xe2, 0x30, // native, S=$01F0, 8-bit
    0xf8,                           // sed
    0x00, 0x11,                     // brk #$11
    0x8d, 0x10, 0x01,               // sta $0110 (A from the handler)
    0x08, 0x68, 0x8d, 0x11, 0x01,   // P after rti (D back on)
    0x02, 0x22,                     // cop #$22
    0x8d, 0x12, 0x01, 0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  // BRK handler $8100: copy the 4 stacked bytes and its own P, return $AB.
  rom.set([0xba, 0xbd, 0x01, 0x01, 0x8d, 0x20, 0x01, 0xbd, 0x02, 0x01, 0x8d, 0x21, 0x01, 0xbd, 0x03, 0x01, 0x8d, 0x22, 0x01,
    0xbd, 0x04, 0x01, 0x8d, 0x23, 0x01, 0x08, 0x68, 0x8d, 0x24, 0x01, 0xa9, 0xab, 0x40], 0x100);
  rom.set([0xa9, 0xcd, 0x40], 0x140);   // COP handler $8140
  rom[0x7fe6] = 0x00; rom[0x7fe7] = 0x81; rom[0x7fe4] = 0x40; rom[0x7fe5] = 0x81;
  const { mem, ex } = await runCart(rom, 8);
  assert.equal(ex.dbg_trapped(), 0);
  // snes9x: A $AB / P $3D / A $CD; stacked P $3D, PC $800E, PB $00; handler P $37.
  assert.deepEqual([...mem.subarray(WRAM + 0x110, WRAM + 0x113)], [0xab, 0x3d, 0xcd]);
  assert.deepEqual([...mem.subarray(WRAM + 0x120, WRAM + 0x125)], [0x3d, 0x0e, 0x80, 0x00, 0x37]);
});

test("options.traceEntries records the 65816 registers per ROM instruction; breakArm flips A after one", async () => {
  const code = [
    0x78,                         // $8000 sei
    0x18, 0xfb,                   // $8001 clc / $8002 xce
    0xc2, 0x30,                   // $8003 rep #$30: 16-bit A, X, Y
    0xa9, 0x34, 0x12,             // $8005 lda #$1234
    0xa2, 0x78, 0x56,             // $8008 ldx #$5678
    0x80, 0xfe,                   // $800B bra *
  ];
  const rom = synthRom({ code });
  const opts = { traceEntries: 1 << 18, breakArm: "$808005" };
  const stats = {};
  const { bytes } = await assembleWat(emitWat(rom, { ...opts, stats }));
  assert.equal(stats.brokenArms, 1);
  const sec = recompileSection(rom, "00", opts).json;
  assert.equal(recompileSection(rom, "00", {}).json.trace.fields, undefined, "the default ring has no registers");
  assert.notEqual(recompileSection(rom, "00", {}).json.trace.offset, sec.trace.offset);
  assert.equal(describeRom(rom).memory.pages + Math.ceil((1 << 18) * 32 / 0x10000), describeRom(rom, opts).memory.pages, "the ring is added above the default map");
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init(); ex.wc_render();
  const dv = new DataView(ex.memory.buffer);
  const t = sec.trace;
  const e = (k, f) => dv.getUint32(t.offset + k * t.stride + f, true);
  assert.ok(dv.getUint32(t.cursor.offset, true) <= t.entries, "one frame fits the ring");
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((k) => e(k, 0) & 0xffff), [0x8000, 0x8001, 0x8002, 0x8003, 0x8005, 0x8008]);
  assert.equal(e(5, 4) & 0xffff, 0x1235, "A after the broken lda #$1234 has bit 0 flipped");
  assert.equal(e(2, 16) >> 8, 1, "emulation flag set before xce");
  assert.equal(e(6, 16) >> 8, 0, "native mode after xce");
  assert.equal(e(6, 4) >>> 16, 0x5678, "X loaded");
});

/**
 * 65816 code that uploads `prog` to ARAM $0200 through the IPL boot protocol,
 * starts it, waits for $2141 == $77 and copies $2142/$2143 to $7E0010/11.
 * The program bytes sit at ROM $8200.
 */
function uploadRom(prog, tail = [0x80, 0xfe], sram = 0) {
  const len = prog.length;
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,       // sei, native, 16-bit X, 8-bit A
    0xa9, 0xaa, 0xcd, 0x40, 0x21, 0xd0, 0xfb,       // wait $2140 == $AA
    0xa9, 0xbb, 0xcd, 0x41, 0x21, 0xd0, 0xfb,       // wait $2141 == $BB
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21,             // destination $0200
    0xa9, 0x01, 0x8d, 0x41, 0x21, 0xa9, 0xcc, 0x8d, 0x40, 0x21,
    0xcd, 0x40, 0x21, 0xd0, 0xfb,                   // wait echo $CC
    0xa2, 0x00, 0x00,
    0xbd, 0x00, 0x82, 0x8d, 0x41, 0x21, 0x8a, 0x8d, 0x40, 0x21,   // lda prog,x / sta $2141 / txa / sta $2140
    0xcd, 0x40, 0x21, 0xd0, 0xfb,
    0xe8, 0xe0, len & 0xff, len >> 8, 0xd0, 0xeb,   // inx / cpx #len / bne
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21, 0x9c, 0x41, 0x21,       // entry $0200
    0xa9, (len + 1) & 0xff, 0x8d, 0x40, 0x21,
    0xa9, 0x77, 0xcd, 0x41, 0x21, 0xd0, 0xfb,       // wait for the program's $77
    0xad, 0x42, 0x21, 0x8f, 0x10, 0x00, 0x7e,
    0xad, 0x43, 0x21, 0x8f, 0x11, 0x00, 0x7e,
    ...tail,
  ];
  const rom = synthRom({ code, sram });
  rom.set(prog, 0x200);
  return rom;
}

test("APU: the uploaded SPC700 program runs and answers through the ports", async () => {
  // mov a,#$12 / mov y,#$34 / mul ya / mov $f6,a / mov $f7,y / mov $f5,#$77 / bra *
  const prog = [0xe8, 0x12, 0x8d, 0x34, 0xcf, 0xc4, 0xf6, 0xcb, 0xf7, 0x8f, 0x77, 0xf5, 0x2f, 0xfe];
  const rom = uploadRom(prog);
  const { mem, ex } = await runCart(rom, 10);
  assert.equal(ex.dbg_trapped(), 0);
  assert.deepEqual([mem[WRAM + 0x10], mem[WRAM + 0x11]], [0xa8, 0x03], "$12 * $34 = $03A8 computed by the SPC700");
  const lay = describeRom(rom).memory;
  assert.deepEqual([...mem.subarray(lay.ARAM + 0x200, lay.ARAM + 0x200 + prog.length)], prog, "the IPL copied the program");
  assert.equal(ex.dbg_spcpc(), 0x20c, "the SPC700 parks on its bra *");
});

test("APU: romdev's boot ROM takes two blocks (one past 256 bytes) and starts the program with A = X = Y = 0, SP = $EF, PSW = $02", async () => {
  // The boot ROM is romdev's own (scripts/spc700-ipl/ipl.asm); the cart's
  // copy is the one build-ipl.mjs assembled.
  const { readFileSync } = await import("node:fs");
  const header = readFileSync(new URL("../../../../../scripts/spc700-ipl/romdev_iplrom.h", import.meta.url), "utf8");
  const ipl = [...header.replace(/\/\/[^\n]*/g, "").matchAll(/0x([0-9a-f]{2})/g)].map((m) => parseInt(m[1], 16));
  const { default: apu } = await import("./snes9x-apu.json", { with: { type: "json" } });
  assert.deepEqual(apu.iplrom, ipl);
  assert.deepEqual(ipl.slice(62), [0xc0, 0xff], "reset vector $FFC0");
  // the program at $0200 stores A, X, Y, PSW, SP at $20-$24, then says $77
  const prog = [0xc4, 0x20, 0xd8, 0x21, 0xcb, 0x22, 0x0d, 0xae, 0xc4, 0x23, 0x9d, 0xd8, 0x24, 0x8f, 0x77, 0xf5, 0x2f, 0xfe];
  const data = Array.from({ length: 300 }, (_, i) => (i * 37 + 11) & 0xff);
  const wait = [0xcd, 0x40, 0x21, 0xd0, 0xfb];                 // cmp $2140 / bne: the echo
  const send = (src, len) => [0xa2, 0x00, 0x00,                // ldx #0
    0xbd, src & 0xff, src >> 8, 0x8d, 0x41, 0x21, 0x8a, 0x8d, 0x40, 0x21, ...wait,
    0xe8, 0xe0, len & 0xff, len >> 8, 0xd0, 0xeb];             // inx / cpx #len / bne
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0xa9, 0xaa, 0xcd, 0x40, 0x21, 0xd0, 0xfb, 0xa9, 0xbb, 0xcd, 0x41, 0x21, 0xd0, 0xfb,
    // block 1: 300 bytes to $0300, kicked with $CC
    0xa2, 0x00, 0x03, 0x8e, 0x42, 0x21, 0xa9, 0x01, 0x8d, 0x41, 0x21, 0xa9, 0xcc, 0x8d, 0x40, 0x21, ...wait,
    ...send(0x8400, data.length),
    // block 2: the program to $0200, kicked with the last index + 2
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21, 0xa9, 0x01, 0x8d, 0x41, 0x21, 0xa9, (data.length + 1) & 0xff, 0x8d, 0x40, 0x21, ...wait,
    ...send(0x8200, prog.length),
    // start at $0200
    0xa2, 0x00, 0x02, 0x8e, 0x42, 0x21, 0x9c, 0x41, 0x21, 0xa9, (prog.length + 1) & 0xff, 0x8d, 0x40, 0x21,
    0xa9, 0x77, 0xcd, 0x41, 0x21, 0xd0, 0xfb, 0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  rom.set(prog, 0x200);
  rom.set(data, 0x400);
  const { mem, ex } = await runCart(rom, 10);
  assert.equal(ex.dbg_trapped(), 0);
  const aram = mem.subarray(describeRom(rom).memory.ARAM);
  assert.deepEqual([...aram.subarray(0x300, 0x300 + data.length)], data, "block 1, across the index wrap");
  assert.deepEqual([...aram.subarray(0x200, 0x200 + prog.length)], prog, "block 2");
  assert.deepEqual([...aram.subarray(0x20, 0x25)], [0x00, 0x00, 0x00, 0x02, 0xef], "A, X, Y, PSW, SP at the program's first instruction");
  assert.deepEqual([...aram.subarray(0x00, 0x02)], [0x00, 0x02], "$00-$01 hold the entry address");
  assert.equal(ex.dbg_spcpc(), 0x200 + prog.length - 2, "the program parks on its bra *");
});

/** The DSP test program (voice 0 keyed on with ADSR and echo) as an upload ROM. */
function dspRom() {
  const pairs = [[0x00, 0x40], [0x01, 0x00], [0x02, 0x40], [0x03, 0x00],
    [0x40, 0xb3], [0x41, 0x77], [0x42, 0x77], [0x43, 0x77], [0x44, 0x77], [0x45, 0x99], [0x46, 0x99], [0x47, 0x99], [0x48, 0x99]];
  const dsp = [[0x5d, 0x00], [0x6d, 0x80], [0x7d, 0x01], [0x6c, 0x00], [0x0d, 0x40], [0x4d, 0x01], [0x0c, 0x7f], [0x1c, 0x7f],
    [0x2c, 0x40], [0x3c, 0x40], [0x0f, 0x7f], [0x00, 0x7f], [0x01, 0x60], [0x02, 0x00], [0x03, 0x10], [0x04, 0x00],
    [0x05, 0x8f], [0x06, 0xe0], [0x4c, 0x01]];
  for (const [r, v] of dsp) pairs.push([0xf2, r], [0xf3, v]);
  const tab = pairs.flat();
  const code = [
    0xcd, 0x00, 0xf5, 0x80, 0x02, 0xfd, 0x3d, 0xf5, 0x80, 0x02, 0xd6, 0x00, 0x00, 0x3d, 0xc8, tab.length, 0xd0, 0xf0,
    0xcd, 0x00, 0x8d, 0x00, 0xfe, 0xfe, 0x1d, 0xd0, 0xfb,
    0x8f, 0x08, 0xf2, 0xe4, 0xf3, 0xc4, 0xf6, 0x8f, 0x09, 0xf2, 0xe4, 0xf3, 0xc4, 0xf7,
    0x8f, 0x7c, 0xf2, 0xe4, 0xf3, 0xc4, 0x20, 0x8f, 0x77, 0xf5, 0x2f, 0xfe,
  ];
  const prog = new Array(0x80 + tab.length).fill(0);
  prog.splice(0, code.length, ...code);
  prog.splice(0x80, tab.length, ...tab);
  return uploadRom(prog);
}

test("APU: S-DSP voice, envelope and echo writes match snes9x's ARAM byte for byte", async () => {
  // A table-driven SPC program: page-0 writes build a one-block looping BRR
  // sample and its DIR entry, then DSP register writes through $F2/$F3 key
  // voice 0 on with ADSR and echo into $8000 (EDL 1). After a delay loop it
  // reads ENVX, OUTX and ENDX back through $F3.
  const rom = dspRom();
  // snes9x (romdev's pinned core) after loadMedia + 60 frames: ENVX $7F,
  // OUTX $C7, ENDX bit 0, 2016 nonzero echo bytes, and this ARAM sha1. The
  // cart is compared 65 frames in (the reference's 5 settle frames).
  const { mem, ex } = await runCart(rom, 65);
  assert.equal(ex.dbg_trapped(), 0);
  const lay = describeRom(rom).memory;
  const aram = mem.subarray(lay.ARAM, lay.ARAM + 0x10000);
  assert.deepEqual([mem[WRAM + 0x10], mem[WRAM + 0x11], aram[0x20]], [0x7f, 0xc7, 0x01]);
  assert.equal(aram.subarray(0x8000, 0x8800).filter((x) => x).length, 2016, "echo buffer written");
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(aram).digest("hex"), "a66773a52eceb7452859063b3197e11334e4151e");
  // The DSP's output reaches the wasmcart host: a 32040 Hz int16 stereo ring.
  const info = new Uint32Array(mem.buffer, ex.wc_get_info(), 18);
  assert.equal(info[13], 32040);
  assert.ok(info[4] && info[5] && info[6], "audioPtr, audioCap, audioWritePtr");
  const ring = new Int16Array(mem.buffer, info[4], info[5] * 2);
  assert.ok(ring.some((v) => v !== 0), "the keyed-on voice is audible");
});

test("power-on: work RAM reads $55 before it is written, as snes9x fills it", async () => {
  // sei / clc xce / rep #$30 / tsc / sta $7E0020 / sep #$20 / lda $7E1000 / sta $7E0010 / bra *
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x30, 0x3b, 0x8f, 0x20, 0x00, 0x7e, 0xe2, 0x20, 0xaf, 0x00, 0x10, 0x7e, 0x8f, 0x10, 0x00, 0x7e, 0x80, 0xfe];
  const { mem } = await runCart(synthRom({ code }), 1);
  // snes9x after loadMedia: $7E0010 = $55, S = $01FF.
  assert.equal(mem[WRAM + 0x10], 0x55);
  assert.equal(mem[WRAM + 0x20] | (mem[WRAM + 0x21] << 8), 0x01ff);
  assert.equal(mem[WRAM + 0x1ffff], 0x55);
});

test("controllers: automatic read into $4218/$4219 and the serial $4016 port, pads read by position", async () => {
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30,                 // sei, native, 8-bit A/X/Y
    0xa9, 0x01, 0x8d, 0x00, 0x42,                 // $4200 = $01: auto joypad read on
    0xad, 0x19, 0x42, 0x8d, 0x11, 0x00,           // L: lda $4219 / sta $0011
    0xad, 0x18, 0x42, 0x8d, 0x10, 0x00,           //    lda $4218 / sta $0010
    0xa9, 0x01, 0x8d, 0x16, 0x40, 0x9c, 0x16, 0x40, // latch pulse on $4016
    0xa2, 0x00,                                   //    ldx #0
    0xad, 0x16, 0x40, 0x9d, 0x20, 0x00, 0xe8, 0xe0, 0x12, 0xd0, 0xf5, // M: 18 serial reads to $0020,x
    0x80, 0xdd,                                   //    bra L
  ];
  const rom = synthRom({ code });
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const mem = new Uint8Array(ex.memory.buffer);
  const dv = new DataView(ex.memory.buffer);
  // wasmcart A (south) + START + RIGHT + LEFT: SNES B, Start, Right (Left dropped).
  for (let f = 0; f < 3; f++) { dv.setUint16(INPUT, 1 | 64 | 2048 | 1024, true); ex.wc_render(); }
  assert.deepEqual([mem[WRAM + 0x10], mem[WRAM + 0x11]], [0x00, 0x91], "JOY1 = $9100 (B, Start, Right)");
  // Bits 7-2 are open bus: the $40 of the \`lda $4016\` operand (snes9x reads $40/$41).
  assert.deepEqual([...mem.subarray(WRAM + 0x20, WRAM + 0x32)], [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1].map((b) => 0x40 | b));
  // wasmcart B (east) is SNES A: JOY1L bit 7.
  for (let f = 0; f < 2; f++) { dv.setUint16(INPUT, 2, true); ex.wc_render(); }
  assert.deepEqual([mem[WRAM + 0x10], mem[WRAM + 0x11]], [0x80, 0x00]);
});

test("HDMA: a $420C write takes effect mid-frame (snes9x PPU.HDMA = Byte & ~HDMAEnded)", async () => {
  // Channel 0 streams a repeat-mode table into the WRAM port ($2180), one
  // byte per line, from the frame after it is enabled in vblank. A V-IRQ at
  // line 100 turns HDMA off on its second firing. snes9x: exactly bytes
  // 1..100 land at $7E2000 (lines 0-99), the rest of the buffer is untouched.
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30,
    0x9c, 0x81, 0x21, 0xa9, 0x20, 0x8d, 0x82, 0x21, 0x9c, 0x83, 0x21,
    0x9c, 0x00, 0x43, 0xa9, 0x80, 0x8d, 0x01, 0x43,
    0x9c, 0x02, 0x43, 0xa9, 0x84, 0x8d, 0x03, 0x43, 0x9c, 0x04, 0x43,
    0xa9, 0x64, 0x8d, 0x09, 0x42, 0x9c, 0x0a, 0x42, 0xa9, 0x20, 0x8d, 0x00, 0x42,
    0x64, 0x00, 0xad, 0x12, 0x42, 0x10, 0xfb,
    0xa9, 0x01, 0x8d, 0x0c, 0x42, 0x58, 0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  rom.set([0xad, 0x11, 0x42, 0xe6, 0x00, 0xa5, 0x00, 0xc9, 0x02, 0xd0, 0x03, 0x9c, 0x0c, 0x42, 0x40], 0x100);
  rom.set([0xff, ...Array.from({ length: 127 }, (_, i) => i + 1), 0xff, ...Array.from({ length: 127 }, (_, i) => 128 + i), 0x00], 0x400);
  rom[0x7fee] = 0x00; rom[0x7fef] = 0x81;
  const { mem } = await runCart(rom, 11);
  assert.deepEqual([...mem.subarray(WRAM + 0x2000, WRAM + 0x2064)], Array.from({ length: 100 }, (_, i) => i + 1));
  assert.equal(mem[WRAM + 0x2064], 0x55, "nothing after line 99");
});

test("decimal mode: ADC/SBC 8- and 16-bit results and flags match snes9x exhaustively", async () => {
  // 8-bit: every (A, operand) pair with C = bit 0 of A (X = operand<<8 | A,
  // 32768 pairs); 16-bit: 16384 A values against A ^ $9696. Results land at
  // $7E8000+X and P at $7F0000+X; the sha1 of $7E8000-$7FFFFF is snes9x's
  // after loadMedia + 65 frames (the cart runs 70).
  const rom8 = (op) => synthRom({ code: [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xf8, 0xa2, 0x00, 0x00,
    0x86, 0x00, 0xa5, 0x00, 0x4a, 0xa5, 0x00, op, 0x01,
    0x9f, 0x00, 0x80, 0x7e, 0x08, 0x68, 0x9f, 0x00, 0x00, 0x7f,
    0xe8, 0xe0, 0x00, 0x80, 0xd0, 0xe7, 0xd8, 0x80, 0xfe] });
  const rom16 = (op) => synthRom({ code: [
    0x78, 0x18, 0xfb, 0xc2, 0x30, 0xf8, 0xa2, 0x00, 0x00,
    0x8a, 0x49, 0x96, 0x96, 0x85, 0x00, 0x8a, 0x4a, 0x8a, op, 0x00,
    0x9f, 0x00, 0x80, 0x7e, 0x08, 0xe2, 0x20, 0x68, 0x9f, 0x00, 0x00, 0x7f, 0xc2, 0x20,
    0xe8, 0xe8, 0xe0, 0x00, 0x80, 0xd0, 0xe0, 0xd8, 0x80, 0xfe] });
  const { createHash } = await import("node:crypto");
  const cases = [
    [rom8(0x65), "0aacba4bc87ef5b7e31d42c5827f1c52c9781580"],
    [rom8(0xe5), "feb5dd71aaf774c8acdfa3f70ecd5e8a3996579e"],
    [rom16(0x65), "3b4a0db8643962c5aab9916bdd1fd4b5176ef63f"],
    [rom16(0xe5), "d0a40d92ae4beb4cbfb704e58023bccfefbad035"],
  ];
  for (const [rom, sha] of cases) {
    const { mem } = await runCart(rom, 70);
    assert.equal(createHash("sha1").update(mem.subarray(WRAM + 0x8000, WRAM + 0x18000)).digest("hex"), sha);
  }
});

test("bus: open bus, the LoROM holes and mirrors, SRAM rules and the running program bank match snes9x", async () => {
  // Runs from the $80 FastROM mirror; every result is stored at $0110+.
  let n = 0;
  const st = () => [0x8d, (0x10 + n++) & 0xff, 0x01];
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30, 0x5c, 0x0b, 0x80, 0x80, 0xea, 0xea,
    0x4b, 0x68, ...st(),             // phk: $80, not the ROM offset's bank $00
    0x22, 0x40, 0x81, 0x80,          // jsl $808140: the pushed bank is $80
    0xad, 0x00, 0x20, ...st(),       // lda $2000: open bus = operand high byte $20
    0xad, 0x00, 0x40, ...st(),       // lda $4000: $40
    0xad, 0x00, 0x60, ...st(),       // lda $6000: LoROM hole, $60
    0xad, 0x10, 0x42, ...st(),       // lda $4210: NMI flag | $02 | open bus bits 6-4
    0xad, 0x16, 0x40, ...st(),       // lda $4016: open bus $40 | pad bit
    0xad, 0x81, 0x21, ...st(),       // lda $2181: write-only, CPU open bus $21
    0xad, 0x04, 0x21, ...st(),       // lda $2104: PPU1 open bus
    0xaf, 0x00, 0x00, 0x40, ...st(), // lda $400000: banks $40+ map ROM in both halves
    0xaf, 0x05, 0x80, 0x40, ...st(), // lda $408005
    0xaf, 0x00, 0x00, 0x70, ...st(), // lda $700000: no SRAM, byte 0 of the $60-filled buffer
    0xa9, 0x12, 0x8f, 0x00, 0x00, 0x70, 0xaf, 0x00, 0x00, 0x70, ...st(), // that write is dropped
    0xaf, 0x00, 0x80, 0x71, ...st(), // lda $718000: small carts map SRAM up to $FFFF
    0xc2, 0x20, 0xad, 0xff, 0x1f, 0xe2, 0x20, 0xeb, ...st(), // 16-bit lda $1FFF: high byte from open bus
    0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  rom.set([0xba, 0xbd, 0x01, 0x01, 0x8d, 0x20, 0x01, 0xbd, 0x02, 0x01, 0x8d, 0x21, 0x01, 0xbd, 0x03, 0x01, 0x8d, 0x22, 0x01, 0x6b], 0x140);
  const { mem } = await runCart(rom, 8);
  // snes9x after loadMedia + 3 frames
  assert.deepEqual([...mem.subarray(WRAM + 0x110, WRAM + 0x11e)],
    [0x80, 0x20, 0x40, 0x60, 0x42, 0x40, 0x21, 0x00, 0x78, 0x5c, 0x60, 0x60, 0x60, 0x55]);
  assert.deepEqual([...mem.subarray(WRAM + 0x120, WRAM + 0x123)], [0x13, 0x80, 0x80], "jsl frame: return $8012+1-1, bank $80");
});

test("HiROM: 64KB banks, $40/$C0/$00/$80 mirrors, $20:6000 SRAM, write-protected ROM, running bank", async () => {
  const img = new Uint8Array(0x20000).fill(0xea);
  let n = 0;
  const st = () => [0x8d, (0x10 + n++) & 0xff, 0x01];
  img.set([0x78, 0x18, 0xfb, 0xe2, 0x30, 0x5c, 0x10, 0x80, 0xc0], 0x8000);   // jml $C08010
  img.set([
    0x4b, 0x68, ...st(),
    0xaf, 0x00, 0x00, 0xc1, ...st(), 0xaf, 0x05, 0x00, 0x41, ...st(),
    0xaf, 0x02, 0x80, 0x01, ...st(), 0xaf, 0x02, 0x80, 0x81, ...st(),
    0xa9, 0x5a, 0x8f, 0x00, 0x60, 0x20, 0xaf, 0x00, 0x60, 0x30, ...st(),
    0xaf, 0x00, 0x60, 0x00, ...st(),
    0xa9, 0x99, 0x8f, 0x00, 0x00, 0xc1, 0xaf, 0x00, 0x00, 0xc1, ...st(),
    0x22, 0x00, 0x90, 0xc1, 0x20, 0x00, 0xa0, 0x80, 0xfe,
  ], 0x8010);
  img.set([0x4b, 0x68, 0x8d, 0x30, 0x01, 0xba, 0xbd, 0x03, 0x01, 0x8d, 0x31, 0x01, 0x6b], 0x19000);
  img.set([0x4b, 0x68, 0x8d, 0x32, 0x01, 0x60], 0xa000);
  img.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66], 0x10000);
  img.set([0x77, 0x88, 0x99], 0x18000);
  const h = 0xffc0;
  for (let i = 0; i < 21; i++) img[h + i] = "HIROM SYNTH TEST     ".charCodeAt(i);
  img[h + 0x15] = 0x21; img[h + 0x16] = 0x02; img[h + 0x17] = 0x07; img[h + 0x18] = 0x01; img[h + 0x19] = 1;
  img[0xfffc] = 0x00; img[0xfffd] = 0x80; img[0xffea] = 0x00; img[0xffeb] = 0x80; img[0xffee] = 0x00; img[0xffef] = 0x80;
  let sum = 0; for (const b of img) sum = (sum + b) & 0xffff;
  img[h + 0x1c] = (sum ^ 0xffff) & 0xff; img[h + 0x1d] = (sum ^ 0xffff) >> 8; img[h + 0x1e] = sum & 0xff; img[h + 0x1f] = sum >> 8;
  const d = describeRom(img);
  assert.equal(d.mapping, "hirom");
  assert.equal(d.sramMask, 0x7ff);
  const { mem, ex } = await runCart(img, 8);
  assert.equal(ex.dbg_trapped(), 0);
  // snes9x after loadMedia + 3 frames
  assert.deepEqual([...mem.subarray(WRAM + 0x110, WRAM + 0x118)], [0xc0, 0x11, 0x66, 0x99, 0x99, 0x5a, 0x00, 0x11]);
  assert.deepEqual([...mem.subarray(WRAM + 0x130, WRAM + 0x133)], [0xc1, 0xc0, 0xc0]);
});

test("PPU status: $2137 latch, OPVCT/OPHCT flip-flops, STAT78 latch flag and field, STAT77 range over", async () => {
  let n = 0;
  const st = () => [0x8d, (0x10 + n++) & 0xff, 0x01];
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30,
    0xad, 0x12, 0x42, 0x30, 0xfb, 0xad, 0x12, 0x42, 0x10, 0xfb,   // to the start of vblank
    0xad, 0x37, 0x21,
    0xad, 0x3f, 0x21, ...st(), 0xad, 0x3d, 0x21, ...st(), 0xad, 0x3d, 0x21, ...st(),
    0xad, 0x3f, 0x21, ...st(), 0xad, 0x3c, 0x21, ...st(), 0xad, 0x3c, 0x21, ...st(),
    0xad, 0x3e, 0x21, ...st(),
    0xa2, 0x00,                                                    // then STAT78 once per frame
    0xad, 0x12, 0x42, 0x30, 0xfb, 0xad, 0x12, 0x42, 0x10, 0xfb, 0xad, 0x3f, 0x21, 0x9d, 0x20, 0x01,
    0xe8, 0xe0, 0x08, 0xd0, 0xeb, 0x80, 0xfe,
  ];
  const { mem } = await runCart(synthRom({ code }), 14);
  const r = [...mem.subarray(WRAM + 0x110, WRAM + 0x117)];
  // snes9x: STAT78 $43 (latched), V = 225, high byte $E0 (PPU2 open bus
  // $E1 & $FE), STAT78 $23 (flag cleared, bit 5 from open bus), STAT77 $41
  // (the all-zero OAM puts 128 sprites on row 0: range over).
  assert.deepEqual([r[0], r[1], r[2], r[3], r[6]], [0x43, 0xe1, 0xe0, 0x23, 0x41]);
  assert.equal(r[5] & 0xfe, r[4] & 0xfe, "OPHCT high byte carries PPU2 open bus");
  assert.equal(r[4], 0x12, "H latch: dot 18, as snes9x");
  const f = [...mem.subarray(WRAM + 0x120, WRAM + 0x128)];
  assert.ok(f.every((v, i) => (v & 0x7f) === 0x03 && (i === 0 || (v ^ f[i - 1]) === 0x80)), `field bit flips every frame: ${f}`);
});

test("CPU timing: per-access memory speeds, internal cycles and DRAM refresh give snes9x's instructions per frame", async () => {
  // Count `inx / lda $4210 / bpl` iterations over one frame: an opcode
  // fetch and two operand fetches at 8 (SlowROM), a $4210 read at 6, an
  // internal cycle each for inx and the taken branch, less 40 clocks of
  // DRAM refresh per line. snes9x counts 5256.
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa2, 0x00, 0x00,
    0xad, 0x10, 0x42, 0xad, 0x10, 0x42, 0x10, 0xfb,     // clear, then wait for the NMI flag
    0xad, 0x10, 0x42,                                   // clear it
    0xe8, 0xad, 0x10, 0x42, 0x10, 0xfa,                 // L: inx / lda $4210 / bpl L
    0x8e, 0x20, 0x01, 0x80, 0xfe];
  const { mem } = await runCart(synthRom({ code }), 8);
  const n = mem[WRAM + 0x120] | (mem[WRAM + 0x121] << 8);
  assert.equal(n, 5256, "loop iterations per frame, as snes9x");
});

test("DMA: WRAM to the WRAM port $2180 is dropped and leaves the port address alone (snes9x inWRAM_DMA)", async () => {
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0xa9, 0x77, 0x8f, 0x00, 0x10, 0x7e, 0x8f, 0x01, 0x10, 0x7e,
    0x9c, 0x81, 0x21, 0xa9, 0x20, 0x8d, 0x82, 0x21, 0x9c, 0x83, 0x21,
    0x9c, 0x00, 0x43, 0xa9, 0x80, 0x8d, 0x01, 0x43,
    0xa2, 0x00, 0x10, 0x8e, 0x02, 0x43, 0xa9, 0x7e, 0x8d, 0x04, 0x43,
    0xa2, 0x02, 0x00, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42,   // $7E1000 -> $2180: dropped
    0xa2, 0x00, 0x81, 0x8e, 0x02, 0x43, 0x9c, 0x04, 0x43,
    0xa2, 0x02, 0x00, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42,   // $008100 -> $2180: lands at $2000
    0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  rom.set([0x11, 0x22], 0x100);
  const { mem } = await runCart(rom, 3);
  assert.deepEqual([...mem.subarray(WRAM + 0x2000, WRAM + 0x2003)], [0x11, 0x22, 0x55]);
});

test("code in RAM: a store does not read its target first (the WRAM port address does not move)", async () => {
  // RAM routine at $7E1000: lda #$AA / sta $2180 / sta $2180 / rtl
  const routine = [0xa9, 0xaa, 0x8d, 0x80, 0x21, 0x8d, 0x80, 0x21, 0x6b];
  const code = [0x78, 0x18, 0xfb, 0xe2, 0x30,
    0x9c, 0x81, 0x21, 0xa9, 0x30, 0x8d, 0x82, 0x21, 0x9c, 0x83, 0x21];   // WRAM port -> $003000
  routine.forEach((b, i) => code.push(0xa9, b, 0x8f, i & 0xff, 0x10, 0x7e));   // copy the routine
  code.push(0x22, 0x00, 0x10, 0x7e, 0x80, 0xfe);                           // jsl $7E1000 / bra *
  const { mem, ex } = await runCart(synthRom({ code }), 3);
  assert.equal(ex.dbg_trapped(), 0);
  assert.deepEqual([...mem.subarray(WRAM + 0x3000, WRAM + 0x3003)], [0xaa, 0xaa, 0x55]);
});

test("DMA: events happen inside a transfer (an HDMA on its channel ends it; the frame's audio stops at vblank)", async () => {
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0x9c, 0x10, 0x43, 0xa9, 0x26, 0x8d, 0x11, 0x43,             // HDMA ch1: mode 0 -> $2126
    0xa2, 0x00, 0x81, 0x8e, 0x12, 0x43, 0x9c, 0x14, 0x43,       // table $00:8100
    0xa9, 0x02, 0x8d, 0x0c, 0x42,                               // $420C = ch1
    0x2c, 0x12, 0x42, 0x10, 0xfb, 0x2c, 0x12, 0x42, 0x30, 0xfb, // wait for vblank, then its end
    0xa9, 0x80, 0x8d, 0x15, 0x21, 0x9c, 0x16, 0x21, 0x9c, 0x17, 0x21,
    0xa9, 0x01, 0x8d, 0x10, 0x43, 0xa9, 0x18, 0x8d, 0x11, 0x43, // ch1 DMA mode 1 -> $2118
    0xa2, 0x00, 0x80, 0x8e, 0x12, 0x43, 0x9c, 0x14, 0x43,
    0xa2, 0x00, 0x80, 0x8e, 0x15, 0x43, 0xa9, 0x02, 0x8d, 0x0b, 0x42, // 32KB: the line's HDMA on ch1 ends it
    0xae, 0x12, 0x43, 0x8e, 0x00, 0x10, 0xae, 0x15, 0x43, 0x8e, 0x02, 0x10,
    0xad, 0x37, 0x21, 0xad, 0x3d, 0x21, 0x8d, 0x04, 0x10, 0xad, 0x3d, 0x21, 0x8d, 0x05, 0x10,
    0xa9, 0x01, 0x8d, 0x00, 0x43, 0xa9, 0x18, 0x8d, 0x01, 0x43, // ch0 DMA mode 1 -> $2118
    0xa2, 0x00, 0x80, 0x8e, 0x02, 0x43, 0x9c, 0x04, 0x43,
    0xa2, 0x00, 0x00, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42, // 64KB, across the frame end
    0xae, 0x02, 0x43, 0x8e, 0x06, 0x10, 0xae, 0x05, 0x43, 0x8e, 0x08, 0x10,
    0xad, 0x37, 0x21, 0xad, 0x3d, 0x21, 0x8d, 0x0a, 0x10, 0xad, 0x3d, 0x21, 0x8d, 0x0b, 0x10,
    0x80, 0xfe,
  ];
  const rom = synthRom({ code });
  rom.set([0x7f, 0x11, 0x7f, 0x22, 0x7f, 0x33, 0x00], 0x100);
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const counts = [];
  let last = 0;
  for (let i = 0; i < 6; i++) {
    ex.wc_render();
    const dv = new DataView(ex.memory.buffer);
    const w = dv.getUint32(dv.getUint32(ex.wc_get_info() + 24, true), true);
    counts.push((w - last + 4096) % 4096);
    last = w;
  }
  // snes9x: ch1 moved $4B bytes before line 0's HDMA ended it ($4312 = $804B,
  // $4315 = $7FB5 left); the 64KB ch0 transfer ends on line 143 of the next
  // frame (the values read back from snes9x's WRAM after the same code).
  const mem = new Uint8Array(ex.memory.buffer);
  assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x100c)],
    [0x4b, 0x80, 0xb5, 0x7f, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x8f, 0x8e]);
  // The frame the transfer runs across still hands over only the samples
  // made up to its vblank (S9xSyncSpeed at V=225): one frame's worth.
  for (const n of counts.slice(1)) assert.ok(n === 533 || n === 534, `per-frame samples ${counts}`);
});

test("16-bit immediates: the operand fetch that crosses a line end sets the APU catch-up point, in ROM and in RAM", async () => {
  // snes9x Immediate16 is one AddCycles(MemSpeedx2): a line end crossed by
  // the opcode or operand fetch is processed after both operand bytes. The
  // per-frame sample counts (set by the APU catch-up at the vblank line end)
  // and the RAM loop's iteration count are snes9x's.
  const loop = [0x69, 0x01, 0x00, 0x69, 0x01, 0x00, 0xa9, 0x34, 0x12, 0xa2, 0x00, 0x10, 0xe6, 0x10];
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x30, 0xe2, 0x20];
  [...loop, 0x80, 0x100 - (loop.length + 2)].forEach((b, i) => code.push(0xa9, b, 0x8f, i & 0xff, 0x20, 0x7e));
  code.push(0xc2, 0x20);
  const top = code.length;
  code.push(...loop, 0xa5, 0x10, 0xc9, 0x00, 0x40, 0x90);
  code.push(0x100 - (code.length - top + 1));
  code.push(0x64, 0x10, 0x5c, 0x00, 0x20, 0x7e);   // stz $10 / jml $7E2000
  const { bytes } = await assembleWat(emitWat(synthRom({ code })));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const counts = [];
  let last = 0;
  for (let f = 0; f < 155; f++) {
    ex.wc_render();
    const dv = new DataView(ex.memory.buffer);
    const w = dv.getUint32(dv.getUint32(ex.wc_get_info() + 24, true), true);
    counts.push((w - last + 4096) % 4096);
    last = w;
    // snes9x's $10 after 40 frames (cart frame 45)
    if (f === 44) assert.equal(new DataView(ex.memory.buffer).getUint16(WRAM + 0x10, true), 0x615e);
  }
  // snes9x frames 1-150 (cart frames 6-155): 533 samples, 534 at these.
  const at534 = new Set([4, 12, 20, 28, 37, 45, 53, 60, 70, 77, 85, 93, 102, 110, 118, 126, 135, 143]);
  assert.deepEqual(counts.slice(5), Array.from({ length: 150 }, (_, i) => (at534.has(i) ? 534 : 533)));
});

test("an event inside an instruction happens at snes9x's next AddCycles: fetches, TWO_CYCLES chunks, trailing internal cycles", async () => {
  // Where snes9x processes an event (here the vblank line end, whose
  // position is where the APU catches up) that falls inside each
  // instruction of this loop: after the operand bytes (one AddCycles), after
  // each internal-cycle AddCycles (PLx/RTS/RTL/XBA add TWO_CYCLES at once,
  // RTS's last cycle and MVN's two come after the accesses), after each
  // memory access (a stack or WRAM word is one access). Offsets are master
  // clocks from the instruction start, SlowROM code, WRAM data.
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa9, 0x0f, 0x8d, 0x00, 0x21,
    0x48, 0x68, 0x20, 0x40, 0x80, 0xeb, 0xeb, 0x8b, 0xab, 0x0b, 0x2b, 0x22, 0x41, 0x80, 0x00,
    0xc2, 0x20, 0xa9, 0x03, 0x00, 0xa2, 0x00, 0x10, 0xa0, 0x00, 0x11,
    0x54, 0x7e, 0x7e, 0xe2, 0x20, 0xee, 0x00, 0x12, 0x80, 0xdc,
  ];
  const rom = synthRom({ code });
  rom.set([0x60, 0x6b], 0x40);
  const points = {
    0x800c: [14, 22], 0x800d: [20, 28], 0x800e: [24, 30, 46], 0x8011: [20], 0x8012: [20],
    0x8013: [14, 22], 0x8014: [20, 28], 0x8015: [14, 30], 0x8016: [20, 36], 0x8017: [32, 38, 46, 62],
    0x801b: [16, 22], 0x801d: [24], 0x8020: [24], 0x8023: [24], 0x8026: [16, 24, 32, 40, 52],
    0x8029: [16, 22], 0x802b: [24, 32, 38, 46], 0x802e: [16, 22], 0x8040: [20, 36, 42], 0x8041: [20, 36, 44],
  };
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const seen = new Set();
  for (let f = 0; f < 400; f++) {
    ex.wc_render();
    if (f < 2) continue;
    const dv = new DataView(ex.memory.buffer);
    const p = dv.getInt32(PROBE + PROBE_FIELDS.vblankpos, true);
    const st = dv.getInt32(PROBE + PROBE_FIELDS.vblankistart, true);
    const pc = dv.getUint32(PROBE + PROBE_FIELDS.vblankpc, true) & 0xffff;
    const pts = points[pc];
    assert.ok(pts, `line end inside $${pc.toString(16)}`);
    const want = st + pts.find((o) => st + o >= 1364);
    assert.equal(p, want, `frame ${f}: $${pc.toString(16)} from ${st}, line end at +${1364 - st}`);
    seen.add(pc);
  }
  assert.ok(seen.size >= 12, `covered ${seen.size} instructions`);
});

test("an interrupt's entry cycles are one AddCycles: a line end they cross happens before the pushes", async () => {
  // H+V IRQ at V 224, HTIME 333 (HC 1350): taken at the first boundary at
  // or past it, and S9xOpcode_IRQ's AddCycles(MemSpeed + ONE_CYCLE) carries
  // the clock over the line end at 1364, which is processed right there.
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0xa9, 0xe0, 0x8d, 0x09, 0x42, 0x9c, 0x0a, 0x42,   // VTIME 224
    0xa9, 0x4d, 0x8d, 0x07, 0x42, 0xa9, 0x01, 0x8d, 0x08, 0x42, // HTIME 333
    0xa9, 0x30, 0x8d, 0x00, 0x42, 0x58,               // H+V IRQ on, cli
    0xea, 0xea, 0xea, 0x80, 0xfb,                     // nop loop @ $801F
  ];
  const rom = synthRom({ code });
  rom.set([0xad, 0x11, 0x42, 0x40], 0x100);           // lda $4211 / rti
  rom[0x7fee] = 0x00; rom[0x7fef] = 0x81;
  const len = { 0x801f: 14, 0x8020: 14, 0x8021: 14, 0x8022: 22 };
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  let checked = 0;
  for (let f = 0; f < 60; f++) {
    ex.wc_render();
    if (f < 2) continue;
    const dv = new DataView(ex.memory.buffer);
    const p = dv.getInt32(PROBE + PROBE_FIELDS.vblankpos, true);
    const st = dv.getInt32(PROBE + PROBE_FIELDS.vblankistart, true);
    const pc = dv.getUint32(PROBE + PROBE_FIELDS.vblankpc, true) & 0xffff;
    assert.ok(len[pc], `frame ${f}: line end reached in $${pc.toString(16)}`);
    if (st + len[pc] >= 1364) continue;   // the instruction itself crossed it
    assert.equal(p, st + len[pc] + 14, `frame ${f}: IRQ entry after $${pc.toString(16)} at ${st + len[pc]}`);
    checked++;
  }
  assert.ok(checked > 40, `IRQ entries checked: ${checked}`);
});

/** snes9x frames the SPC700 count is compared over, and what it read. */
const WORD_ACCESS_FRAMES = 600;
const WORD_ACCESS_ROM_SHA1 = "5e890018ffe831cefbd4f128577f6c85087e5572";
const WORD_ACCESS_ARAM_SHA1 = "68af28b2f2193b0daa053eb0d4e143a2d0609782";

/**
 * A cart whose SPC700 counts in ARAM $10/$11 (incw $10, 6 SPC clocks each)
 * while the 65816 loops over 16-bit accesses of every grouping: MAP_NONE
 * ($00:6000) read and write, a write to write-protected ROM, LoROM SRAM
 * read and write, and a MAP_CPU word ($4218, byte by byte).
 */
function wordAccessRom() {
  const prog = [0x8f, 0x77, 0xf5, ...Array.from({ length: 60 }, () => [0x3a, 0x10]).flat(), 0x2f, 0x100 - 122];
  const loop = [
    0xad, 0x00, 0x60,         // lda $6000      MAP_NONE word read
    0x8d, 0x00, 0x60,         // sta $6000      MAP_NONE word write
    0x8d, 0x00, 0x80,         // sta $8000      ROM (write-protected: MAP_NONE on writes)
    0xaf, 0x00, 0x00, 0x70,   // lda $700000    MAP_LOROM_SRAM word read
    0x8f, 0x02, 0x00, 0x70,   // sta $700002    MAP_LOROM_SRAM word write
    0xad, 0x18, 0x42,         // lda $4218      MAP_CPU: byte by byte
  ];
  return uploadRom(prog, [0xc2, 0x20, ...loop, 0x80, 0x100 - (loop.length + 2)], 1);
}

test("16-bit accesses group their cycles as snes9x's S9xGetWord / S9xSetWord do: a line end between the bytes moves the APU catch-up", async () => {
  // snes9x adds both bytes' cycles at once (addCyclesInMemoryAccess_x2) for
  // plain memory, the SRAM windows and MAP_NONE (which is also what a write
  // to write-protected ROM sees), and per byte for MAP_CPU / MAP_PPU / chip
  // windows. The vblank line end inside each instruction of the loop is
  // processed at these offsets from the instruction start (SlowROM code):
  // the operand fetch (one AddCycles), then the access(es).
  const rom = wordAccessRom();
  const lay = describeRom(rom).memory;
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(rom).digest("hex"), WORD_ACCESS_ROM_SHA1, "the image snes9x was run with");
  const loopAt = 0x8000 + rom.findIndex((b, i) => b === 0xc2 && rom[i + 1] === 0x20 && rom[i + 2] === 0xad && rom[i + 3] === 0x00 && rom[i + 4] === 0x60) + 2;
  const points = {
    [loopAt]: [24, 40], [loopAt + 3]: [24, 40], [loopAt + 6]: [24, 40],
    [loopAt + 9]: [32, 48], [loopAt + 13]: [32, 48], [loopAt + 17]: [24, 30, 36], [loopAt + 20]: [16, 22],
  };
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const seen = new Set();
  const counts = [];
  for (let f = 1; f <= WORD_ACCESS_FRAMES + 5; f++) {
    ex.wc_render();
    const mem = new Uint8Array(ex.memory.buffer);
    // snes9x frame F (stepped after loadMedia) is cart frame F + 5
    if (f > 5) counts.push(mem[lay.ARAM + 0x10], mem[lay.ARAM + 0x11]);
    const dv = new DataView(ex.memory.buffer);
    const pc = dv.getUint32(PROBE + PROBE_FIELDS.vblankpc, true) & 0xffff;
    const pts = points[pc];
    if (!pts) continue;   // still uploading
    const p = dv.getInt32(PROBE + PROBE_FIELDS.vblankpos, true);
    const st = dv.getInt32(PROBE + PROBE_FIELDS.vblankistart, true);
    assert.equal(p, st + pts.find((o) => st + o >= 1364), `frame ${f}: ${pc.toString(16)} from ${st}, line end at +${1364 - st}`);
    seen.add(pc);
  }
  assert.equal(seen.size, 7, "the line end fell inside every instruction of the loop");
  assert.equal(ex.dbg_trapped(), 0);
  // The SPC700's count at every frame end is snes9x's (romdev's pinned core,
  // the same image, frames 1..WORD_ACCESS_FRAMES after loadMedia).
  assert.equal(createHash("sha1").update(Uint8Array.from(counts)).digest("hex"), WORD_ACCESS_ARAM_SHA1);
});

test("BRL costs its one internal cycle and no taken-branch extra (snes9x Op82)", async () => {
  // inc $10 / brl back: snes9x's loop count after 3 frames (cart frame 8).
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x30, 0xe6, 0x10, 0x82, 0xfb, 0xff];
  const { mem } = await runCart(synthRom({ code }), 8);
  assert.equal(mem[WRAM + 0x10] | (mem[WRAM + 0x11] << 8), 0xd418);
});

test("an NMI raised during a DMA comes Timings.NMIDMADelay after the transfer ends (S9xDoDMA)", async () => {
  // NMI on, a 40KB DMA running across vblank every frame; the NMI handler
  // latches and stores the H/V counters. Values are snes9x's after 20
  // frames (cart frame 25).
  const code = [
    0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0xa9, 0x80, 0x8d, 0x15, 0x21,
    0xa9, 0x01, 0x8d, 0x00, 0x43, 0xa9, 0x18, 0x8d, 0x01, 0x43,
    0xa9, 0x80, 0x8d, 0x00, 0x42,
    0xa2, 0x00, 0x80, 0x8e, 0x02, 0x43, 0x9c, 0x04, 0x43,
    0xa2, 0x00, 0xa0, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42,
    0x80, 0xed,
  ];
  const rom = synthRom({ code, nmi: 0x8100 });
  rom.set([0xad, 0x37, 0x21, 0xad, 0x3c, 0x21, 0x8d, 0x00, 0x10, 0xad, 0x3c, 0x21, 0x8d, 0x01, 0x10,
    0xad, 0x3d, 0x21, 0x8d, 0x02, 0x10, 0xad, 0x3d, 0x21, 0x8d, 0x03, 0x10, 0xee, 0x04, 0x10, 0x40], 0x100);
  const { mem } = await runCart(rom, 25);
  assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x1005)], [0x44, 0x44, 0x9f, 0x9e, 0x6d]);
});

test("enabling NMI during vblank: the NMI is taken after the NEXT instruction (snes9x IRQ_TRIGGER_NMI)", async () => {
  // Wait for vblank ($4212, leaving $4210 set), write $4200 = $80, then
  // inc $10. The handler copies $10 to $11: snes9x runs the inc first.
  const code = [
    0x78, 0x18, 0xfb, 0xe2, 0x30, 0x64, 0x10, 0x64, 0x11,
    0x2c, 0x12, 0x42, 0x10, 0xfb,
    0xa9, 0x80, 0x8d, 0x00, 0x42,
    0xe6, 0x10,
    0x80, 0xfe,
  ];
  const rom = synthRom({ code, nmi: 0x8100 });
  rom.set([0xa5, 0x10, 0x85, 0x11, 0x9c, 0x00, 0x42, 0x40], 0x100);
  const { mem } = await runCart(rom, 10);
  assert.deepEqual([mem[WRAM + 0x10], mem[WRAM + 0x11]], [1, 1]);
});

test("over 4MB: ExHiROM and the jumbo LoROM load and map as snes9x's (LoadROMInt ExtendedFormat, Map_ExtendedHiROMMap, Map_JumboLoROMMap)", async () => {
  // 6MB images whose bytes differ per bank; code reads a long address in
  // every window into $7E1000+ and round-trips SRAM. Expected bytes are
  // snes9x's WRAM after the same program.
  function mk(kind, copier = false) {
    const size = 0x600000;
    const img = new Uint8Array(size);
    for (let i = 0; i < size; i++) img[i] = ((i >> 16) * 7 + (i >> 8) * 3 + i) & 0xff;
    const hdr = kind === "exhi" ? 0x40ffc0 : 0x407fc0;
    const codeOff = kind === "exhi" ? 0x408000 : 0x400000;
    const title = kind === "exhi" ? "SYNTHETIC EXHIROM    " : "SYNTHETIC JUMBO LOROM";
    for (let i = 0; i < 21; i++) img[hdr + i] = title.charCodeAt(i);
    img[hdr + 0x15] = kind === "exhi" ? 0x35 : 0x30;
    img[hdr + 0x16] = 0x02; img[hdr + 0x17] = 0x0d; img[hdr + 0x18] = 0x03; img[hdr + 0x19] = 1; img[hdr + 0x1a] = 0x33;
    const addrs = kind === "exhi"
      ? [0xc00000, 0xc11234, 0xffffff, 0xbf8000, 0x808123, 0x400000, 0x5fffff, 0x7d4321, 0x608000, 0x008000, 0x3fffff, 0x20ff00]
      : [0x808000, 0xbfffff, 0xc00000, 0xdfffff, 0xe00000, 0xff8000, 0x008000, 0x3fffff, 0x400000, 0x5f1234, 0x7d0000];
    const code = [0x78, 0x18, 0xfb, 0xe2, 0x30];
    addrs.forEach((a, i) => code.push(0xaf, a & 0xff, (a >> 8) & 0xff, a >> 16, 0x8f, i, 0x10, 0x7e));
    const sram = kind === "exhi" ? [0x00, 0x60, 0x20] : [0x00, 0x00, 0x70];
    code.push(0xa9, 0x5a, 0x8f, ...sram, 0xaf, ...sram, 0x8f, 0x80, 0x10, 0x7e, 0x80, 0xfe);
    img.set(code, codeOff);
    img[hdr + 0x3c] = 0x00; img[hdr + 0x3d] = 0x80;
    let sum = 0; for (const b of img) sum = (sum + b) & 0xffff;
    img[hdr + 0x1c] = ~sum & 0xff; img[hdr + 0x1d] = (~sum >> 8) & 0xff; img[hdr + 0x1e] = sum & 0xff; img[hdr + 0x1f] = sum >> 8;
    if (!copier) return img;
    const c = new Uint8Array(512 + size); c.set(img, 512); return c;
  }
  const want = {
    exhi: [0x00, 0x71, 0xb5, 0x39, 0xa6, 0xc0, 0x95, 0x75, 0x78, 0x78, 0x95, 0xbd],
    jumbo: [0x00, 0xd5, 0xe0, 0x45, 0x50, 0x39, 0x78, 0x95, 0x00, 0x00, 0x60],
  };
  for (const [kind, copier] of [["exhi", false], ["jumbo", false], ["exhi", true]]) {
    const rom = mk(kind, copier);
    const d = describeRom(rom);
    assert.equal(d.supported, true, d.refusal);
    assert.equal(d.board, kind === "exhi" ? "ExtendedHiROM" : "JumboLoROM");
    assert.equal(d.copierHeader, copier ? 512 : 0);
    const armRanges = [[0x408000, 0x408100], [0x400000, 0x400100]];
    const { bytes } = await assembleWat(emitWat(rom, { armRanges }));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    ex.wc_init();
    for (let i = 0; i < 3; i++) ex.wc_render();
    const mem = new Uint8Array(ex.memory.buffer);
    assert.equal(ex.dbg_trapped(), 0);
    assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x1000 + want[kind].length)], want[kind], kind);
    assert.equal(mem[WRAM + 0x1080], 0x5a);
  }
});

test("board maps snes9x picks by header name: SRAM512K, ROM24MBS, NoMAD1 (InitROM, from the generated table)", async () => {
  function mk(title, size, code) {
    const img = new Uint8Array(size);
    for (let i = 0; i < size; i++) img[i] = ((i >> 15) * 11 + (i >> 8) + i * 3) & 0xff;
    const h = 0x7fc0, t = title.padEnd(21, " ");
    for (let i = 0; i < 21; i++) img[h + i] = t.charCodeAt(i);
    img[h + 0x15] = 0x20; img[h + 0x16] = 0x02; img[h + 0x17] = 0x0b; img[h + 0x18] = 3; img[h + 0x19] = 1; img[h + 0x1a] = 0x33;
    img.set(code, 0);
    img[0x7ffc] = 0x00; img[0x7ffd] = 0x80;
    let sum = 0; for (const b of img) sum = (sum + b) & 0xffff;
    img[h + 0x1c] = ~sum & 0xff; img[h + 0x1d] = (~sum >> 8) & 0xff; img[h + 0x1e] = sum & 0xff; img[h + 0x1f] = sum >> 8;
    return img;
  }
  const ld = (addrs, c = [0x78, 0x18, 0xfb, 0xe2, 0x30]) => {
    addrs.forEach((a, i) => c.push(0xaf, a & 0xff, (a >> 8) & 0xff, a >> 16, 0x8f, i, 0x10, 0x7e));
    c.push(0x80, 0xfe);
    return c;
  };
  const st = (pairs) => {
    const c = [0x78, 0x18, 0xfb, 0xe2, 0x30];
    for (const [a, v] of pairs) c.push(0xa9, v, 0x8f, a & 0xff, (a >> 8) & 0xff, a >> 16);
    return c;
  };
  const cases = [
    ["RPG-TCOOL 2", 0x100000, "SRAM512KLoROM",
      ld([0x700000, 0x708000, 0x710000, 0x718000, 0x71ffff, 0x72c000, 0x734000, 0x73ffff, 0x740000, 0x7d0000],
        st([[0x700000, 0x11], [0x708000, 0x22], [0x710000, 0x33], [0x71ffff, 0x44], [0x72c000, 0x55], [0x73ffff, 0x66]])),
      [0x11, 0x33, 0x33, 0x60, 0x44, 0x55, 0x55, 0x66, 0xdc, 0xbf]],
    ["SOUND NOVEL-TCOOL", 0x300000, "ROM24MBSLoROM",
      ld([0x008000, 0x1f8000, 0x208000, 0x3fffff, 0x808000, 0x9fffff, 0xa08000, 0xbfffff, 0x408000, 0xc08000, 0x700000]),
      [0x78, 0xd5, 0x60, 0xb1, 0xc0, 0x11, 0x60, 0xb1, 0x40, 0xc0, 0x60]],
    ["WANDERERS FROM YS", 0x100000, "NoMAD1LoROM",
      ld([0x708000, 0x700000, 0xf01234, 0x7d8000, 0xff0000], st([[0x708000, 0x77], [0xf01234, 0x88]])),
      [0x77, 0x77, 0x88, 0x77, 0x77]],
  ];
  for (const [title, size, board, code, want] of cases) {
    const rom = mk(title, size, code);
    const d = describeRom(rom);
    assert.equal(d.board, board);
    const { bytes } = await assembleWat(emitWat(rom, { armRanges: [[0, 0x100]] }));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    ex.wc_init();
    for (let i = 0; i < 3; i++) ex.wc_render();
    const mem = new Uint8Array(ex.memory.buffer);
    assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x1000 + want.length)], want, board);
  }
});

test("a per-title APU speedup (snes9x Timings.APUSpeedup) runs the SPC slower and resamples through the Hermite interpolator", async () => {
  // The DSP program under a header name snes9x applies APUSpeedup = 3 to:
  // the clock ratio's denominator becomes 328125 * 253 / 256 and the
  // resampler's time ratio 256/253, so each frame hands over 532-534
  // interpolated samples. Counts and the sample hash are snes9x's.
  const rom = dspRom();
  const t = "CIRCUIT USA".padEnd(21, " ");
  for (let i = 0; i < 21; i++) rom[0x7fc0 + i] = t.charCodeAt(i);
  assert.deepEqual(describeRom(rom).romFixes, ["Timings.APUSpeedup = 3"]);
  if (process.env.SNES_DUMP_ROM) (await import("node:fs")).writeFileSync(process.env.SNES_DUMP_ROM, rom);
  const { bytes } = await assembleWat(emitWat(rom));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const counts = [], samples = [];
  let last = 0;
  for (let f = 0; f < 65; f++) {
    ex.wc_render();
    const dv = new DataView(ex.memory.buffer);
    const info = new Uint32Array(ex.memory.buffer, ex.wc_get_info(), 18);
    const w = dv.getUint32(info[6], true);
    const n = (w - last + 4096) % 4096;
    if (f >= 5) {   // wc_render call 6 = reference frame 1
      counts.push(n);
      const ring = new Int16Array(ex.memory.buffer, info[4], info[5] * 2);
      for (let k = 0; k < n; k++) { const at = ((last + k) % 4096) * 2; samples.push(ring[at], ring[at + 1]); }
    }
    last = w;
  }
  const { createHash } = await import("node:crypto");
  assert.deepEqual(counts.slice(0, 20), SPEEDUP_COUNTS);
  assert.equal(createHash("sha1").update(new Uint8Array(Int16Array.from(samples).buffer)).digest("hex"), SPEEDUP_SHA1);
});
// snes9x, reference frames 1-20 (counts) and 1-60 (sample sha1)
const SPEEDUP_COUNTS = [532, 534, 533, 533, 533, 533, 534, 532, 534, 533, 533, 533, 534, 532, 534, 533, 532, 534, 533, 533];
const SPEEDUP_SHA1 = "afb7775b56164dca190e6d8994186b069c25c542";

/** A synthetic cart under a given header name (and SRAM size byte). */
function titled(rom, name, sram) {
  const t = name.padEnd(21, " ");
  for (let i = 0; i < 21; i++) rom[0x7fc0 + i] = t.charCodeAt(i);
  if (sram != null) rom[0x7fd8] = sram;
  return rom;
}

test("per-title fixes from the generated table: SRAM fill value, SRAM size, DMA/CPU sync, Uniracers OAM", async () => {
  // Values are snes9x's (WRAM / OAM after 10 reference frames = 15 cart frames).
  const sramCode = [0x78, 0x18, 0xfb, 0xe2, 0x30,
    0xaf, 0x00, 0x00, 0x70, 0x8f, 0x00, 0x10, 0x7e, 0xa9, 0x12, 0x8f, 0x00, 0x00, 0x70,
    0xaf, 0x00, 0x08, 0x70, 0x8f, 0x01, 0x10, 0x7e, 0xaf, 0x00, 0x20, 0x70, 0x8f, 0x02, 0x10, 0x7e, 0x80, 0xfe];
  for (const [name, sram, want] of [["SUPER DRIFT OUT", 3, [0x00, 0x00, 0x12]], ["HITOMI3", 0, [0x60, 0x12, 0x12]], ["PLAIN SRAM CART", 3, [0x60, 0x60, 0x12]]]) {
    const { mem } = await runCart(titled(synthRom({ code: sramCode }), name, sram), 15);
    assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x1003)], want, name);
  }
  // 1-byte DMAs in a loop, counted: DMACPUSync 20 instead of 18 per $420B.
  const dmaCode = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0x9c, 0x00, 0x43, 0xa9, 0x18, 0x8d, 0x01, 0x43, 0xa2, 0x00, 0x80, 0x8e, 0x02, 0x43, 0x9c, 0x04, 0x43,
    0xa2, 0x01, 0x00, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42, 0xee, 0x00, 0x10, 0xd0, 0xf0, 0xee, 0x01, 0x10, 0x80, 0xeb];
  for (const [name, want] of [["BATTLE GRANDPRIX", [0x17, 0xb5]], ["NOT A HACKED TITLE", [0x02, 0xb6]]]) {
    const { mem } = await runCart(titled(synthRom({ code: dmaCode }), name), 15);
    assert.deepEqual([...mem.subarray(WRAM + 0x1000, WRAM + 0x1002)], want, name);
  }
  // HDMA to $2104 every 16 lines: Uniracers' fix resets the OAM address to $10C first.
  const uniCode = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0x9c, 0x10, 0x43, 0xa9, 0x04, 0x8d, 0x11, 0x43, 0xa2, 0x00, 0x81, 0x8e, 0x12, 0x43, 0x9c, 0x14, 0x43,
    0xa9, 0x02, 0x8d, 0x0c, 0x42, 0x80, 0xfe];
  const tab = [];
  for (let i = 0; i < 8; i++) tab.push(0x10, 0x40 + i);
  tab.push(0);
  for (const name of ["UNIRACERS", "NOT UNIRACERS"]) {
    const rom = titled(synthRom({ code: uniCode }), name);
    rom.set(tab, 0x100);
    const { mem } = await runCart(rom, 15);
    const oam = mem.subarray(OAM, OAM + 544);
    if (name === "UNIRACERS") {
      assert.deepEqual([...oam].map((v, i) => (v ? `${i}:${v}` : null)).filter(Boolean), ["536:71"]);
    } else {
      assert.deepEqual([...oam.subarray(0, 9)], [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x55]);
      assert.equal(oam[0x218], 0);
    }
  }
});

test("forced blank is re-read from $2100 at vblank, and a VRAM write dropped in active display steps the address when VMAIN increments on the low byte", async () => {
  // A cart that never writes $2100 leaves the power-on forced blank at its
  // first vblank (snes9x PPU.ForcedBlanking = FillRAM[0x2100] >> 7), so
  // later active-display VRAM writes are dropped (CHECK_INBLANK), each still
  // stepping VMADD. 1-byte DMAs to $2118 in a loop; snes9x's VRAM sha1 after
  // 10 reference frames.
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    0x9c, 0x00, 0x43, 0xa9, 0x18, 0x8d, 0x01, 0x43, 0xa2, 0x00, 0x80, 0x8e, 0x02, 0x43, 0x9c, 0x04, 0x43,
    0xa2, 0x01, 0x00, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42, 0xee, 0x00, 0x10, 0xd0, 0xf0, 0xee, 0x01, 0x10, 0x80, 0xeb];
  const { mem } = await runCart(titled(synthRom({ code }), "NOT A HACKED TITLE"), 15);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(mem.subarray(VRAM, VRAM + 0x10000)).digest("hex"), "484a7a18029bee608ddab7dbba4ade4576c4ea61");
});

test("the H/V timer as snes9x's NextIRQTimer: HTIME/VTIME/$4200 rewrites, dots 0/323/339, lines 0/225/240/261", async () => {
  // Every frame the main loop rewrites HTIME, VTIME and the $4200 mode; the
  // IRQ handler logs the latched H/V counters and the frame number into a
  // 1024-entry ring. sha1 of the ring and the cursor are snes9x's after 60
  // reference frames (65 cart frames).
  const main = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa2, 0x00, 0x00, 0x86, 0x10,
    0xad, 0x10, 0x42, 0x10, 0xfb,
    0xe6, 0x12, 0xa5, 0x12, 0x29, 0x07, 0x0a, 0xaa,
    0xbd, 0x00, 0x82, 0x8d, 0x07, 0x42, 0xbd, 0x01, 0x82, 0x8d, 0x08, 0x42,
    0xbd, 0x10, 0x82, 0x8d, 0x09, 0x42, 0xbd, 0x11, 0x82, 0x8d, 0x0a, 0x42,
    0xa5, 0x12, 0x29, 0x03, 0xaa, 0xbd, 0x20, 0x82, 0x8d, 0x00, 0x42,
    0x58, 0x80, 0xd7];
  const rom = synthRom({ code: main });
  rom.set([0x00, 0x00, 0x43, 0x01, 0x53, 0x01, 0x64, 0x00, 0xff, 0x00, 0x00, 0x00, 0x20, 0x00, 0x10, 0x01], 0x200);
  rom.set([0xf0, 0x00, 0x10, 0x00, 0xe1, 0x00, 0x00, 0x00, 0x05, 0x01, 0x64, 0x00, 0xe0, 0x00, 0x30, 0x00], 0x210);
  rom.set([0x10, 0x20, 0x30, 0x30], 0x220);
  rom.set([0xad, 0x11, 0x42, 0xad, 0x37, 0x21, 0xa6, 0x10, 0xad, 0x3c, 0x21, 0x9d, 0x00, 0x10, 0xad, 0x3d, 0x21, 0x9d, 0x01, 0x10,
    0xa5, 0x12, 0x9d, 0x02, 0x10, 0xe8, 0xe8, 0xe8, 0xe0, 0x00, 0x0c, 0xd0, 0x03, 0xa2, 0x00, 0x00, 0x86, 0x10, 0x40], 0x100);
  rom[0x7fee] = 0x00; rom[0x7fef] = 0x81;
  const { mem } = await runCart(rom, 65);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(mem.subarray(WRAM + 0x1000, WRAM + 0x1c00)).digest("hex"), "8048fa6a65ae17b298c54f0a76abf68abba4a658");
  assert.deepEqual([...mem.subarray(WRAM + 0x10, WRAM + 0x13)], [33, 0, 89]);
});

test("STP re-executes with no cycles of its own: no events, the machine freezes past CPU.Cycles 1000000; a timer IRQ still breaks it", async () => {
  // NMI enabled then STP: snes9x never reaches another event (no vblank,
  // no NMI, no APU time, no audio).
  const rom = synthRom({ code: [0x78, 0x18, 0xfb, 0xe2, 0x30, 0xa9, 0x80, 0x8d, 0x00, 0x42, 0xdb, 0xee, 0x02, 0x10, 0x80, 0xfe], nmi: 0x8100 });
  rom.set([0xee, 0x00, 0x10, 0xad, 0x10, 0x42, 0x40], 0x100);
  const { mem, ex } = await runCart(rom, 25);
  assert.equal(mem[WRAM + 0x1000], 0x55, "no NMI");
  const lay = describeRom(rom).memory;
  assert.equal(mem[lay.ARAM + 0xf4], 0, "the APU never ran (the IPL's $AA is not there)");
  assert.equal(ex.dbg_trapped(), 0);
  // H-IRQ every line with I clear, then STP: counters and the V latch are snes9x's.
  const r3 = synthRom({ code: [0x78, 0x18, 0xfb, 0xe2, 0x30, 0xa9, 0x64, 0x8d, 0x07, 0x42, 0x9c, 0x08, 0x42, 0xa9, 0x10, 0x8d, 0x00, 0x42, 0x58, 0xdb, 0x80, 0xfe] });
  r3.set([0xee, 0x00, 0x10, 0xd0, 0x03, 0xee, 0x01, 0x10, 0xad, 0x11, 0x42, 0xad, 0x37, 0x21, 0xad, 0x3d, 0x21, 0x8d, 0x02, 0x10, 0x40], 0x100);
  r3[0x7fee] = 0x00; r3[0x7fef] = 0x81;
  const m3 = (await runCart(r3, 25)).mem;
  assert.deepEqual([...m3.subarray(WRAM + 0x1000, WRAM + 0x1003)], [198, 110, 224]);
});

test("RAM code runs the arms' own lowering: page-cross and DL cycles, emulation-mode stack wraps and quirks, MVN, BRL (ROM and WRAM agree with snes9x)", async () => {
  // One program assembled for ROM $8200 (arms) and for $7E:0400 (the
  // interpreter, copied there by MVN). Whole-WRAM sha1 after 30 reference
  // frames is snes9x's for each.
  function asm(org) {
    const c = [];
    const at = () => org + c.length;
    const lo = (v) => v & 0xff, hi = (v) => (v >> 8) & 0xff;
    // native, A8 X16
    c.push(0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20);
    const top = at();
    c.push(0xe6, 0x10, 0xd0, 0x02, 0xe6, 0x11);                  // inc $10 (16-bit counter)
    c.push(0xa2, 0xf0, 0x00, 0xbd, 0x20, 0x81);                  // ldx #$00F0 / lda $8120,x (page cross, X16)
    c.push(0xe2, 0x10, 0xa2, 0xf8, 0xbd, 0x10, 0x81, 0xbc, 0x01, 0x80, 0xc2, 0x10); // X8 page-cross reads
    c.push(0xa9, 0xfe, 0x85, 0x20, 0xa9, 0x80, 0x85, 0x21, 0x64, 0x22);            // $20 = $80FE ptr
    c.push(0xa0, 0x05, 0x00, 0xb1, 0x20, 0xe2, 0x10, 0xa0, 0x01, 0xb1, 0x20, 0xc2, 0x10); // (dp),y cross / no cross
    c.push(0xa9, 0x01, 0xeb, 0xa9, 0x05, 0xc2, 0x20, 0x5b, 0xe2, 0x20);            // D = $0105 (DL != 0)
    c.push(0xa5, 0x03, 0xb5, 0x04, 0xc2, 0x20, 0xa9, 0x00, 0x00, 0x5b, 0xe2, 0x20); // dp reads, D back 0
    c.push(0xc2, 0x30, 0xa9, 0x03, 0x00, 0xa2, 0x00, 0x10, 0xa0, 0x00, 0x11, 0x54, 0x7e, 0x7e, 0xe2, 0x20); // mvn 4 bytes
    // emulation mode block: S = $0101
    c.push(0xc2, 0x30, 0xa9, 0x01, 0x01, 0x1b, 0x38, 0xfb);      // tcs; sec xce (E)
    c.push(0x48, 0x08, 0x48, 0x68, 0x28, 0x68);                  // pha php pha pla plp pla (wrap via $0100/$01FF)
    const jsrAt = at();
    c.push(0x20, 0, 0);                                          // jsr sub1 (patched)
    c.push(0x0b, 0x2b, 0xf4, 0x34, 0x12, 0x68, 0x68, 0x8b, 0xab, 0x4b, 0xab); // phd pld pea pla pla phb plb phk plb (wrap quirks)
    c.push(0x18, 0xfb, 0xc2, 0x30, 0xa9, 0x00, 0x00, 0x5b, 0xa9, 0xf0, 0x01, 0x1b, 0x38, 0xfb); // D=0, S=$01F0, back to E
    const jslAt = at();
    c.push(0x22, 0, 0, 0);                                       // jsl sub2 (patched)
    c.push(0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20);                  // back to native
    c.push(0xc2, 0x30, 0xa9, 0xff, 0x01, 0x1b, 0xe2, 0x20);      // S = $01FF
    c.push(0x82, 0x00, 0x00);                                    // brl +0
    const back = at();
    c.push(0x82, lo(top - (back + 3)), hi(top - (back + 3)));    // brl top
    const sub1 = at();
    c.push(0x48, 0x68, 0x60);                                    // pha pla rts
    const sub2 = at();
    c.push(0x0b, 0x2b, 0x6b);                                    // phd pld rtl (S away from the page edge)
    c[jsrAt - org + 1] = lo(sub1); c[jsrAt - org + 2] = hi(sub1);
    c[jslAt - org + 1] = lo(sub2); c[jslAt - org + 2] = hi(sub2); c[jslAt - org + 3] = org >= 0x7e0000 ? 0x7e : 0x00;
    return c;
  }
  const data = Array.from({ length: 0x80 }, (_, i) => (i * 37) & 0xff);
  const rom1 = synthRom({ code: [0x78, 0x5c, 0x00, 0x82, 0x00] });
  rom1.set(asm(0x008200), 0x200);
  rom1.set(data, 0x100);
  const ramCode = asm(0x7e0400);
  const n = ramCode.length;
  const rom2 = synthRom({ code: [0x78, 0x18, 0xfb, 0xc2, 0x30, 0xa9, (n - 1) & 0xff, (n - 1) >> 8, 0xa2, 0x00, 0x84, 0xa0, 0x00, 0x04, 0x54, 0x7e, 0x00, 0xe2, 0x30, 0x5c, 0x00, 0x04, 0x7e] });
  rom2.set(ramCode, 0x400);
  rom2.set(data, 0x100);
  const { createHash } = await import("node:crypto");
  for (const [rom, want] of [[rom1, "b1bda5e2b348a089adea5e38f706b158e8802a22"], [rom2, "81f13cfc623a3772ac0e68354f4e64e1e40aeade"]]) {
    const { mem, ex } = await runCart(rom, 35);
    assert.equal(ex.dbg_trapped(), 0);
    assert.equal(createHash("sha1").update(mem.subarray(WRAM, WRAM + 0x20000)).digest("hex"), want);
  }
});

test("a VRAM write dropped in active display steps the address only on the byte VMAIN increments on ($2118 low / $2119 high)", async () => {
  // Never writes $2100 (forced blank ends at the first vblank); a CPU loop
  // writes $2118 and/or $2119 forever. VRAM sha1 after 10 reference frames
  // is snes9x's.
  const { createHash } = await import("node:crypto");
  for (const [vmain, regs, want] of [[0x00, [0x18, 0x19], "0f4eb4ef919e2b85bf2e3fd5762bc1afacd39e4c"], [0x80, [0x19], "41aaf96099c6735ac27eccc459af611c805997ae"]]) {
    const code = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa9, vmain, 0x8d, 0x15, 0x21, 0xa9, 0x11];
    const top = code.length;
    for (const r of regs) code.push(0x8d, r, 0x21);
    code.push(0x80, 0x100 - (code.length + 2 - top));
    const { mem } = await runCart(synthRom({ code }), 15);
    assert.equal(createHash("sha1").update(mem.subarray(VRAM, VRAM + 0x10000)).digest("hex"), want, `VMAIN ${vmain} regs ${regs}`);
  }
});

test("HDMA and the WRAM port: from WRAM to $2180 is dropped, from ROM lands; $2181-$2183 hold during WRAM (H)DMA; (H)DMA reads leave the data bus alone", async () => {
  // snes9x InWRAMDMAorHDMA per channel / byte, HDMAMemPointers reads. WRAM
  // $2000-$21FF sha1 after 10 reference frames is snes9x's.
  const code = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20,
    // WRAM table
    0xa9, 0x01, 0x8f, 0x00, 0x30, 0x7e, 0xa9, 0xaa, 0x8f, 0x01, 0x30, 0x7e, 0xa9, 0x01, 0x8f, 0x02, 0x30, 0x7e, 0xa9, 0xbb, 0x8f, 0x03, 0x30, 0x7e, 0xa9, 0x00, 0x8f, 0x04, 0x30, 0x7e,
    // WRAM port -> $7E:2000
    0x9c, 0x81, 0x21, 0xa9, 0x20, 0x8d, 0x82, 0x21, 0x9c, 0x83, 0x21,
    // ch1 mode 0 -> $2180 from $7E:3000
    0x9c, 0x10, 0x43, 0xa9, 0x80, 0x8d, 0x11, 0x43, 0xa2, 0x00, 0x30, 0x8e, 0x12, 0x43, 0xa9, 0x7e, 0x8d, 0x14, 0x43,
    // ch2 mode 0 -> $2180 from $00:8100
    0x9c, 0x20, 0x43, 0xa9, 0x80, 0x8d, 0x21, 0x43, 0xa2, 0x00, 0x81, 0x8e, 0x22, 0x43, 0x9c, 0x24, 0x43,
    // ch3 mode 1 -> $2126/$2127 from $00:8110 (sets open bus to the 2nd byte)
    0xa9, 0x01, 0x8d, 0x30, 0x43, 0xa9, 0x26, 0x8d, 0x31, 0x43, 0xa2, 0x10, 0x81, 0x8e, 0x32, 0x43, 0x9c, 0x34, 0x43,
    0xa9, 0x0e, 0x8d, 0x0c, 0x42,
    // loop: after vblank, read an unmapped address (open bus) and log it
    0x2c, 0x12, 0x42, 0x10, 0xfb, 0x2c, 0x12, 0x42, 0x30, 0xfb,
    0xaf, 0x00, 0x60, 0x00, 0x8f, 0x00, 0x10, 0x7e,   // lda $00:6000 (open bus: the operand's bank byte)
    0x80, 0xe8];
  const rom = synthRom({ code });
  rom.set([0x01, 0x11, 0x01, 0x22, 0x01, 0x33, 0x00], 0x100);
  rom.set([0x01, 0x44, 0x55, 0x01, 0x66, 0x77, 0x00], 0x110);
  const { mem } = await runCart(rom, 15);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(mem.subarray(WRAM + 0x2000, WRAM + 0x2200)).digest("hex"), "bd3b5f2a0bf3257c3eea22893fef0e27e3c2aa44");
});

/** Synthetic graphics carts: pseudo-random tiles, maps, OAM and palette by DMA, then register writes. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1103515245 + 12345) >>> 0; return s >>> 16 & 0xff; }; }
function header(img, title, mapMode = 0x20) {
  const h = 0x7fc0, t = title.padEnd(21, " ");
  for (let i = 0; i < 21; i++) img[h + i] = t.charCodeAt(i);
  img[h + 0x15] = mapMode; img[h + 0x16] = 0; img[h + 0x17] = 0x0b; img[h + 0x18] = 0; img[h + 0x19] = 1; img[h + 0x1a] = 0x33;
  img[0x7ffc] = 0x00; img[0x7ffd] = 0x80;
}
/**
 * regs: [[addr, value], ...] PPU/CPU register writes after the uploads (8-bit)
 * nmi: optional handler bytes placed at $9000 (vector set)
 * irq: optional handler bytes at $9100
 * main: bytes appended after the setup (default: bra *)
 */
function gfxRom({ title = "SYNTH GFX", regs = [], nmi = null, irq = null, main = null, seed = 1 }) {
  const img = new Uint8Array(0x40000).fill(0);   // 256KB: 8 banks
  const r = rng(seed);
  // bank 1 ($01:8000, file 0x8000): 32KB tile data; bank 2 (file 0x10000): 2 tilemaps x 2KB + OAM 544 + CGRAM 512
  for (let i = 0; i < 0x8000; i++) img[0x8000 + i] = r();
  for (let i = 0; i < 0x1000; i += 2) { const t = r() | (r() << 8); img[0x10000 + i] = t & 0xff; img[0x10000 + i + 1] = (t >> 8) & 0xff; }
  for (let i = 0; i < 0x1000; i++) img[0x11000 + i] = r();
  for (let i = 0; i < 0x220; i++) img[0x12000 + i] = r();
  for (let i = 0; i < 0x200; i++) img[0x12400 + i] = r() & (i & 1 ? 0x7f : 0xff);
  const c = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa9, 0x80, 0x8d, 0x00, 0x21];   // native, force blank
  const dma = (src, bank, bport, len, mode, vaddr) => {
    if (vaddr != null) c.push(0xa2, vaddr & 0xff, vaddr >> 8, 0x8e, 0x16, 0x21);
    c.push(0xa9, mode, 0x8d, 0x00, 0x43, 0xa9, bport, 0x8d, 0x01, 0x43,
      0xa2, src & 0xff, src >> 8, 0x8e, 0x02, 0x43, 0xa9, bank, 0x8d, 0x04, 0x43,
      0xa2, len & 0xff, len >> 8, 0x8e, 0x05, 0x43, 0xa9, 0x01, 0x8d, 0x0b, 0x42);
  };
  c.push(0xa9, 0x80, 0x8d, 0x15, 0x21);          // VMAIN: increment after $2119
  dma(0x8000, 0x01, 0x18, 0x8000, 0x01, 0x0000);  // tiles -> VRAM word 0
  dma(0x8000, 0x02, 0x18, 0x1000, 0x01, 0x7000);  // tilemap A -> word $7000
  dma(0x9000, 0x02, 0x18, 0x1000, 0x01, 0x7800);  // tilemap B -> word $7800
  c.push(0x9c, 0x02, 0x21, 0x9c, 0x03, 0x21);     // OAM address 0
  dma(0xa000, 0x02, 0x04, 0x220, 0x00, null);     // OAM
  c.push(0x9c, 0x21, 0x21);                       // CGRAM address 0
  dma(0xa400, 0x02, 0x22, 0x200, 0x00, null);     // CGRAM
  // default layout: BG1 map $7000 (64x32), BG2 map $7800, BG3/4 maps $7000, tiles at 0
  const base = [[0x2107, 0x71], [0x2108, 0x79], [0x2109, 0x70], [0x210a, 0x78], [0x210b, 0x00], [0x210c, 0x00]];
  for (const [a, v] of [...base, ...regs]) {
    if (a >= 0x10000) c.push(0xa9, v, 0x8f, a & 0xff, (a >> 8) & 0xff, a >> 16);   // long
    else c.push(0xa9, v, 0x8d, a & 0xff, a >> 8);
  }
  c.push(...(main ?? [0x80, 0xfe]));
  img.set(c, 0);
  if (nmi) { img.set(nmi, 0x1000); img[0x7fea] = 0x00; img[0x7feb] = 0x90; }
  if (irq) { img.set(irq, 0x1100); img[0x7fee] = 0x00; img[0x7fef] = 0x91; }
  header(img, title);
  return img;
}

test("hires (modes 5/6, pseudo-hires, mosaic, a mid-frame switch), interlace (BG and OBJ), overscan, OPT's first column and the rotated-OBJ scan render as snes9x's frames", async () => {
  // sha1 of the RGB frame (as the libretro core hands it over, after the
  // overscan crop) at reference frames 10 and 11 (cart calls 15 and 16);
  // the expected values are snes9x's.
  const { createHash } = await import("node:crypto");
  const on = [[0x2100, 0x0f]];
  const cases = [
    ["g_m5math", { regs: [[0x2105, 0x05], [0x212c, 0x03], [0x212d, 0x02], [0x2130, 0x02], [0x2131, 0x41], [0x2126, 0x30], [0x2127, 0xa0], [0x2123, 0x02], [0x212e, 0x01], [0x2132, 0xe8], ...on] }, [512,224], "b0893c2dd5be098a08dc476eedd98f625fc8ecbd", "b0893c2dd5be098a08dc476eedd98f625fc8ecbd"],
    ["g_m6", { regs: [[0x2105, 0x06], [0x212c, 0x01], [0x212d, 0x00], [0x2111, 0x08], [0x2111, 0x00], ...on] }, [512,224], "864fb721754743246acb714832b55069d8804e00", "864fb721754743246acb714832b55069d8804e00"],
    ["g_phires", { regs: [[0x2105, 0x01], [0x2133, 0x08], [0x212c, 0x11], [0x212d, 0x02], [0x2130, 0x02], [0x2131, 0x43], ...on] }, [512,224], "041041104a57985f2ca6081ca7ea2b3d1afd5d56", "041041104a57985f2ca6081ca7ea2b3d1afd5d56"],
    ["g_m5int", { regs: [[0x2105, 0x05], [0x2133, 0x01], [0x212c, 0x03], [0x212d, 0x02], ...on] }, [512,448], "5bac6a8d06210a1fe8fabdf8ed5388f1d1879dbe", "5bac6a8d06210a1fe8fabdf8ed5388f1d1879dbe"],
    ["g_m1int", { regs: [[0x2105, 0x01], [0x2133, 0x01], [0x212c, 0x13], [0x212d, 0x00], ...on] }, [256,448], "6ca67e1791b31ec9c370767d1fa1027a4ffd7178", "6ca67e1791b31ec9c370767d1fa1027a4ffd7178"],
    ["g_objint", { regs: [[0x2105, 0x01], [0x2133, 0x03], [0x2101, 0x62], [0x212c, 0x11], ...on] }, [256,448], "95de7088d5b0313a8ea082e0ec6a5fd6caaa5604", "95de7088d5b0313a8ea082e0ec6a5fd6caaa5604"],
    ["g_m5mos", { regs: [[0x2105, 0x05], [0x2106, 0x31], [0x212c, 0x01], [0x212d, 0x02], ...on] }, [512,224], "1c9dde8ea9782dcba674fc024bc6ce45d34a0af9", "1c9dde8ea9782dcba674fc024bc6ce45d34a0af9"],
    ["g_mid", { regs: [[0x2105, 0x01], [0x212c, 0x03], [0x212d, 0x02], [0x4209, 100], [0x420a, 0], [0x4207, 0x20], [0x4208, 0], [0x4200, 0xb0], ...on],
  main: [0x58, 0x80, 0xfe],
  irq: [0x48, 0xa9, 0x05, 0x8d, 0x05, 0x21, 0xad, 0x11, 0x42, 0x68, 0x40],
  nmi: [0x48, 0xa9, 0x01, 0x8d, 0x05, 0x21, 0xad, 0x10, 0x42, 0x68, 0x40] }, [512,224], "9046cb22cd2b2373ad361d61fb015e796b46c3e4", "9046cb22cd2b2373ad361d61fb015e796b46c3e4"],
    ["g_os4", { regs: [[0x2105, 0x01], [0x2133, 0x04], [0x212c, 0x13], [0x4209, 235], [0x420a, 0], [0x4200, 0x20], ...on],
  main: [0x58, 0xe6, 0x10, 0xd0, 0xfc, 0xe6, 0x11, 0x80, 0xf8],
  irq: [0x48, 0xad, 0x11, 0x42, 0x9c, 0x21, 0x21, 0xa5, 0x10, 0x8d, 0x22, 0x21, 0x8d, 0x22, 0x21, 0x68, 0x40] }, [256,224], "b4079c8923ca7c8c71254b64e2e4fa1ec6d92d45", "a151aa996328ed9e46894ea21b6d3bf995be8089"],
    ["g_m2s", { regs: [[0x2105, 0x02], [0x210d, 0x03], [0x210d, 0x00], [0x212c, 0x03], ...on] }, [256,224], "03a35f6a27ea2f539f92f029e37a32ea102849b1", "03a35f6a27ea2f539f92f029e37a32ea102849b1"],
    // OAM priority rotation with an odd OAM address and the byte flip set in
    // the NMI: SetupOBJ's FirstSprite + Y scan for the whole frame
    ["g_evil", { regs: [[0x2105, 0x01], [0x2101, 0x60], [0x212c, 0x10], [0x4200, 0x80], ...on],
  main: [0x80, 0xfe],
  nmi: [0x48, 0xa9, 0x07, 0x8d, 0x02, 0x21, 0xa9, 0x80, 0x8d, 0x03, 0x21, 0xa9, 0x33, 0x8d, 0x04, 0x21, 0xad, 0x10, 0x42, 0x68, 0x40] }, [256,224], "eecb83100a22555df0d30fe3e3f6925adf864872", "eecb83100a22555df0d30fe3e3f6925adf864872"],
  ];
  for (const [name, opts, [w, h], want10, want11] of cases) {
    const rom = gfxRom(opts);
    const { bytes } = await assembleWat(emitWat(rom));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const ex = instance.exports;
    ex.wc_init();
    for (let f = 1; f <= 16; f++) {
      ex.wc_render();
      if (f < 15) continue;
      const dv = new DataView(ex.memory.buffer);
      const info = ex.wc_get_info();
      const fw = dv.getUint32(info + 4, true), fh = dv.getUint32(info + 8, true), fb = dv.getUint32(info + 12, true);
      assert.deepEqual([fw, fh], [w, h], name);
      const rgb = new Uint8Array(fw * fh * 3);
      for (let i = 0; i < fw * fh; i++) {
        const px = dv.getUint32(fb + i * 4, true);
        rgb[i * 3] = (px >> 16) & 255; rgb[i * 3 + 1] = (px >> 8) & 255; rgb[i * 3 + 2] = px & 255;
      }
      assert.equal(createHash("sha1").update(rgb).digest("hex"), f === 15 ? want10 : want11, `${name} reference frame ${f - 5}`);
    }
  }
});

test("PAL carts (region byte): 312 lines, the PAL APU clock ratio, as snes9x runs them", async () => {
  // The H/V-timer program under a PAL header: the IRQ log is snes9x's after
  // 60 reference frames; the DSP program's per-frame sample counts
  // (34176/709379 of the master clock) are snes9x's for frames 1-20.
  const main = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa2, 0x00, 0x00, 0x86, 0x10,
    0xad, 0x10, 0x42, 0x10, 0xfb,
    0xe6, 0x12, 0xa5, 0x12, 0x29, 0x07, 0x0a, 0xaa,
    0xbd, 0x00, 0x82, 0x8d, 0x07, 0x42, 0xbd, 0x01, 0x82, 0x8d, 0x08, 0x42,
    0xbd, 0x10, 0x82, 0x8d, 0x09, 0x42, 0xbd, 0x11, 0x82, 0x8d, 0x0a, 0x42,
    0xa5, 0x12, 0x29, 0x03, 0xaa, 0xbd, 0x20, 0x82, 0x8d, 0x00, 0x42,
    0x58, 0x80, 0xd7];
  const rom = synthRom({ code: main });
  rom.set([0x00, 0x00, 0x43, 0x01, 0x53, 0x01, 0x64, 0x00, 0xff, 0x00, 0x00, 0x00, 0x20, 0x00, 0x10, 0x01], 0x200);
  rom.set([0xf0, 0x00, 0x10, 0x00, 0xe1, 0x00, 0x00, 0x00, 0x05, 0x01, 0x64, 0x00, 0xe0, 0x00, 0x30, 0x00], 0x210);
  rom.set([0x10, 0x20, 0x30, 0x30], 0x220);
  rom.set([0xad, 0x11, 0x42, 0xad, 0x37, 0x21, 0xa6, 0x10, 0xad, 0x3c, 0x21, 0x9d, 0x00, 0x10, 0xad, 0x3d, 0x21, 0x9d, 0x01, 0x10,
    0xa5, 0x12, 0x9d, 0x02, 0x10, 0xe8, 0xe8, 0xe8, 0xe0, 0x00, 0x0c, 0xd0, 0x03, 0xa2, 0x00, 0x00, 0x86, 0x10, 0x40], 0x100);
  rom[0x7fee] = 0x00; rom[0x7fef] = 0x81;
  rom[0x7fd9] = 2;
  assert.equal(describeRom(rom).pal, true);
  const { mem } = await runCart(rom, 65);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha1").update(mem.subarray(WRAM + 0x1000, WRAM + 0x1c00)).digest("hex"), "592d435206dee790715182337cbc43faa378b2d4");
  assert.deepEqual([...mem.subarray(WRAM + 0x10, WRAM + 0x13)], [18, 0, 93]);
  const dsp = dspRom();
  dsp[0x7fd9] = 2;
  const { bytes } = await assembleWat(emitWat(dsp));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const counts = [];
  let last = 0;
  for (let f = 0; f < 25; f++) {
    ex.wc_render();
    const dv = new DataView(ex.memory.buffer);
    const w = dv.getUint32(dv.getUint32(ex.wc_get_info() + 24, true), true);
    if (f >= 5) counts.push((w - last + 4096) % 4096);
    last = w;
  }
  assert.deepEqual(counts, [640, 641, 641, 640, 641, 641, 641, 640, 641, 641, 640, 641, 641, 640, 641, 641, 641, 640, 641, 641]);
});
