import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as describeRom, emitWatString, recompileSection, fullBlocks, z80Length, platforms } from "./index.js";
import { lower, imm } from "./z80.js";
import { miscWat, hwWat, renderWat } from "./hw.js";
import { cost } from "./cycles.js";
import { assembleWatSync } from "../assemble.js";
import { backendFor } from "../index.js";

/** A 32KB SMS image: a tiny program at $0000 and a TMR SEGA header. */
function tinyRom() {
  const rom = new Uint8Array(0x8000);
  const prog = [
    0xF3,                   // di
    0x31, 0xF0, 0xDF,       // ld sp,$DFF0
    0x3E, 0x42,             // ld a,$42
    0x32, 0x00, 0xC0,       // ld ($C000),a
    0x06, 0x05,             // ld b,5
    0x3C,                   // loop: inc a
    0x10, 0xFD,             // djnz loop
    0x32, 0x01, 0xC0,       // ld ($C001),a
    0xCD, 0x20, 0x00,       // call $0020
    0x18, 0xFE,             // halt-loop: jr $
  ];
  rom.set(prog, 0);
  rom.set([0x21, 0x34, 0x12, 0x22, 0x02, 0xC0, 0xC9], 0x20); // ld hl,$1234; ld ($C002),hl; ret
  rom.set(Buffer.from("TMR SEGA"), 0x7FF0);
  rom[0x7FFF] = 0x4C; // SMS export, 32KB
  return rom;
}

test("registry resolves sms and gg to this backend", async () => {
  const m = await backendFor("gg");
  assert.deepEqual(m.platforms, platforms);
});

test("describe derives platform, mapper and slot-1 paging from the ROM", () => {
  const rom = tinyRom();
  const d = describeRom(rom);
  assert.equal(d.platform, "sms");
  // 48KB or less: no mapper (gpgx sms_cart_init); bigger: the Sega mapper
  assert.equal(d.mapper, "none");
  assert.equal(describeRom(rom, { legacy: true }).mapper, "sega");
  const big = new Uint8Array(0x10000); big.set(rom);
  assert.equal(describeRom(big).mapper, "sega");
  assert.equal(d.pagesSlot1, false);
  const gg = new Uint8Array(rom); gg[0x7FFF] = 0x6C;
  assert.equal(describeRom(gg).platform, "gg");
  assert.equal(describeRom(rom, { romPath: "/x/y.gg" }).platform, "gg");
  // Codemasters: checksum + its complement at $7FE6/$7FE8 sum to $10000.
  const cm = new Uint8Array(rom); cm[0x7FE6] = 0x34; cm[0x7FE7] = 0x12; cm[0x7FE8] = 0xCC; cm[0x7FE9] = 0xED;
  assert.equal(describeRom(cm).mapper, "codemasters");
  // Korean A000: bank 0 stores to $A000 and never to $FFFF.
  const kr = new Uint8Array(rom); kr.set([0x32, 0x00, 0xA0], 0x100);
  assert.equal(describeRom(kr).mapper, "korean-a000");
  // A direct store to $FFFE pages slot 1.
  const s1 = new Uint8Array(rom); s1.set([0x32, 0xFE, 0xFF], 0x200);
  assert.equal(describeRom(s1).pagesSlot1, true);
  assert.equal(describeRom(s1, { pagesSlot1: false }).pagesSlot1, false);
});

test("instruction lengths and the arm list cover every offset", () => {
  assert.equal(z80Length(Uint8Array.from([0xDD, 0xCB, 0x05, 0x46]), 0), 4);
  assert.equal(z80Length(Uint8Array.from([0xED, 0x43, 0, 0]), 0), 4);
  assert.equal(z80Length(Uint8Array.from([0xCB]), 0), -1);
  const items = fullBlocks(tinyRom(), false);
  assert.equal(items.length, 0x8000 + 2 * 0x4000);
  assert.deepEqual(items[0], [0, 0, 0, 1]);
  assert.deepEqual(items[items.length - 1], [0x1BFFF, 0xBFFF, 1, 1]);
});

test("lowering and cycle rules", () => {
  assert.equal(imm("$1F"), 31);
  assert.equal(imm("L000105"), 0x105);
  assert.throws(() => imm("12ab"));
  const [w, f] = lower("djnz", "L000100", 0x10, 2);
  assert.match(w, /global.set \$b/);
  assert.deepEqual({ kind: f.kind, target: f.target, next: f.next }, { kind: "jp_cc", target: 0x100, next: 0x12 });
  assert.deepEqual(cost("djnz", "L000100"), [13, 8]);
  assert.deepEqual(cost("ld", "(ix+$05),a"), [19, 19]);
  assert.deepEqual(cost("ret", "nz"), [11, 5]);
  assert.throws(() => lower("jp", "zz,L000100", 0, 3), /condition/);
});

test("a synthetic cart assembles, validates and runs the program", async () => {
  const rom = tinyRom();
  const stats = {};
  const text = await emitWatString(rom, { stats });
  // no mapper: compiled from the 48KB the CPU sees (slots 0, 1 and one page of slot 2)
  assert.equal(stats.arms, 0x14000);
  assert.equal(stats.trapped, stats.unsupported + stats.noInstruction);
  const sec = recompileSection(rom, "00", {});
  assert.equal(sec.json.regions.vram.ref, "sms_vram");
  const bytes = assembleWatSync(text);
  assert.ok(WebAssembly.validate(bytes));
  const { instance } = await WebAssembly.instantiate(bytes);
  const e = instance.exports;
  e.wc_get_info();
  e.wc_init();
  e.wc_render();
  const mem = new Uint8Array(e.memory.buffer);
  assert.equal(mem[0xC000], 0x42);
  assert.equal(mem[0xC001], 0x47);
  assert.equal(mem[0xC002] | (mem[0xC003] << 8), 0x1234);
  assert.equal(e.dbg_trapped.value, 0);
});

test("exact mode fixes the earlier semantics that differed from genesis_plus_gx", () => {
  // adc hl,rr adds the carry (the earlier lowering took the add path)
  assert.match(lower("adc", "hl,de", 0, 2, { exact: true })[0], /\$adc16/);
  assert.match(lower("adc", "hl,de", 0, 2)[0], /\$add16/);
  // EI arms the one-instruction delay; RETI/RETN copy IFF2 into IFF1
  assert.match(lower("ei", "", 0, 1, { exact: true })[0], /\$eidelay/);
  assert.equal(lower("reti", "", 0, 2, { exact: true })[0], "(global.set $iff (global.get $iff2))");
  // CP takes F bits 5/3 from the operand
  assert.match(lower("cp", "$28", 0, 2, { exact: true })[0], /0xD7/);
  // INI/IND read the port (the earlier emitter ran OUTI/OUTD)
  const misc = miscWat({ exact: true });
  assert.match(misc, /\(func \$ini \(call \$ini_step \(i32\.const 1\)\)\)/);
  assert.match(miscWat(), /\(func \$ini \(call \$outi_step\)\)/);
  // I/O decoded by port & $C1 with GG registers; sprite flags in the renderer
  assert.match(hwWat("gg", { exact: true }), /\$vcounter/);
  assert.match(renderWat({ exact: true }), /\$parse_satb/);
});

test("region comes from the header region code", () => {
  const rom = tinyRom();
  assert.equal(describeRom(rom).region, "export");
  const jp = new Uint8Array(rom); jp[0x7FFF] = 0x3C;
  assert.equal(describeRom(jp).region, "japan");
});

test("options.traceEntries records every instruction with the Z80 registers; breakArm flips A after one", async () => {
  const rom = tinyRom();
  const plain = await emitWatString(rom, {});
  const opts = { traceEntries: 1024, breakArm: "$0004" };
  const stats = {};
  const text = await emitWatString(rom, { ...opts, stats });
  assert.notEqual(text, plain);
  assert.equal(stats.brokenArms, 1);
  const sec = recompileSection(rom, "00", opts).json;
  const { validateRecompileLayout } = await import("../../recompile-section.js");
  validateRecompileLayout(sec);
  assert.equal(recompileSection(rom, "00", {}).json.trace, undefined, "the default cart declares no register ring");
  assert.ok(sec.warning.includes("breakArm"));
  const { instance } = await WebAssembly.instantiate(assembleWatSync(text));
  const e = instance.exports;
  e.wc_get_info(); e.wc_init(); e.wc_render();
  const dv = new DataView(e.memory.buffer);
  const t = sec.trace;
  const base = dv.getUint32(t.baseField.offset, true);
  const count = dv.getUint32(t.cursor.offset, true);
  assert.ok(count > 10, `ring recorded ${count}`);
  const entry = (k) => ({ pc: dv.getUint32(base + k * t.stride, true) & 0xFFFF, af: dv.getUint32(base + k * t.stride + 4, true) & 0xFFFF, sp: dv.getUint32(base + k * t.stride + 16, true) & 0xFFFF });
  assert.deepEqual([0, 1, 2, 3].map((k) => entry(k).pc), [0x0000, 0x0001, 0x0004, 0x0006]);
  assert.equal(entry(2).sp, 0xDFF0, "registers are the state BEFORE the instruction (sp set by the previous one)");
  assert.equal(entry(3).af >> 8, 0x43, "ld a,$42 at the broken arm left A with bit 0 flipped");
  assert.throws(() => describeRom(rom, { traceEntries: 1000 }), /power of two/);
});
