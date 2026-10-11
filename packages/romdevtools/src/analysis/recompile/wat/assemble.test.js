import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleWat, assembleWatSync, parseF32Bits, parseF64Bytes, parseI32, parseI64 } from "./assemble.js";
import { wcGetInfoWat, abiBlock, readRecompileInfo, recompileSectionBytes, watBytes, WC_INFO, padAddr, assertHostSpans } from "./cart-abi.js";

const BIG = `
(module
  ;; line comment with (parens) and "quotes"
  (; block (; nested ;) comment ;)
  (type $binop (func (param i32 i32) (result i32)))
  (memory (export "memory") 1 4)
  (global $counter (mut i32) (i32.const 0x10))
  (global $big i64 (i64.const -0x8000_0000_0000_0000))
  (global $base i32 (i32.const 0x10))
  (global $fwd (mut i32) (global.get $base))
  (table 4 funcref)
  (elem (i32.const 0) $add $sub)
  (elem (table 0) (offset (i32.const 2)) func $mul)
  (data (i32.const 16) "AB\\43\\n\\t\\22\\5c\\\\\\"\\u{e9}" "tail")
  (func $add (type $binop) (i32.add (local.get 0) (local.get 1)))
  (func $sub (param $a i32) (param $b i32) (result i32) local.get $a local.get $b i32.sub)
  (func $mul (param i32 i32) (result i32) (i32.mul (local.get 0) (local.get 1)))
  (func (export "dispatch") (param $i i32) (param $x i32) (param $y i32) (result i32)
    (call_indirect (type $binop) (local.get $x) (local.get $y) (local.get $i)))
  (func (export "later") (result i32) (call $defined_below (i32.const 5)))
  (func (export "brt") (param $i i32) (result i32)
    (block $c (block $b (block $a
      (br_table $a $b $c (local.get $i)))
      (return (i32.const 100)))
      (return (i32.const 200)))
    (i32.const 300))
  (func (export "loopsum") (param $n i32) (result i32) (local $s i32)
    (block $done (loop $top
      (br_if $done (i32.eqz (local.get $n)))
      (local.set $s (i32.add (local.get $s) (local.get $n)))
      (local.set $n (i32.sub (local.get $n) (i32.const 1)))
      (br $top)))
    (local.get $s))
  (func (export "flatif") (param $x i32) (result i32)
    local.get $x
    if $l (result i32)
      i32.const 1
    else $l
      i32.const 2
    end $l)
  (func (export "foldif") (param $x i32) (result i32)
    (if (result i32) (i32.gt_s (local.get $x) (i32.const 10))
      (then (i32.const 7))
      (else (i32.const 8))))
  (func (export "mem") (result i32)
    (i32.store offset=100 align=1 (i32.const 0) (i32.const 0x12345678))
    (i32.load16_u offset=102 (i32.const 0)))
  (func (export "bulk") (result i32)
    (memory.fill (i32.const 200) (i32.const 0x55) (i32.const 8))
    (memory.copy (i32.const 300) (i32.const 16) (i32.const 3))
    (i32.add (i32.load8_u (i32.const 207)) (i32.load8_u (i32.const 302))))
  (func (export "signext") (result i32) (i32.extend8_s (i32.const 0x80)))
  (func (export "sat") (result i32) (i32.trunc_sat_f64_s (f64.const 1e100)))
  (func (export "sel") (param $c i32) (result i32) (select (result i32) (i32.const 3) (i32.const 4) (local.get $c)))
  (func (export "multi") (result i32)
    (block (result i32 i32) (i32.const 20) (i32.const 22))
    i32.add)
  (func (export "g") (result i32) (global.set $counter (i32.add (global.get $counter) (i32.const 1))) (global.get $counter))
  (func (export "fwdg") (result i32) (global.get $fwd))
  (func (export "f32") (result f32) (f32.const 0x1.8p+1))
  (func (export "f64") (result f64) (f64.add (f64.const 0x1.8p+47) (f64.const -1.5)))
  (func (export "i64") (result i64) (i64.add (global.get $big) (i64.const 0xFFFF_FFFF_FFFF_FFFF)))
  (func (export "wrap") (result i32) (i32.wrap_i64 (i64.shr_u (i64.const 0x500044E450004400) (i64.const 32))))
  (func (export "neg") (result i32) (i32.const -2147483648))
  (func (export "u32") (result i32) (i32.const 0xFFFFFFFF))
  (func $defined_below (param $v i32) (result i32) (i32.mul (local.get $v) (i32.const 3)))
  (export "counter" (global $counter))
  (start $init)
  (func $init (global.set $counter (i32.const 0x20)))
)`;

async function inst(bytes) {
  assert.ok(WebAssembly.validate(bytes), "module validates");
  const { instance } = await WebAssembly.instantiate(bytes);
  return instance.exports;
}

test("assembles a feature-rich module that validates and runs", async () => {
  const bytes = assembleWatSync(BIG);
  const e = await inst(bytes);
  assert.equal(e.dispatch(0, 5, 3), 8);
  assert.equal(e.dispatch(1, 5, 3), 2);
  assert.equal(e.dispatch(2, 5, 3), 15);
  assert.equal(e.later(), 15);
  assert.equal(e.brt(0), 100);
  assert.equal(e.brt(1), 200);
  assert.equal(e.brt(2), 300);
  assert.equal(e.brt(9), 300);
  assert.equal(e.loopsum(10), 55);
  assert.equal(e.flatif(1), 1);
  assert.equal(e.flatif(0), 2);
  assert.equal(e.foldif(11), 7);
  assert.equal(e.foldif(3), 8);
  assert.equal(e.mem(), 0x1234);
  assert.equal(e.bulk(), 0x55 + 0x43);
  assert.equal(e.signext(), -128);
  assert.equal(e.sat(), 2147483647);
  assert.equal(e.sel(1), 3);
  assert.equal(e.sel(0), 4);
  assert.equal(e.multi(), 42);
  assert.equal(e.counter.value, 0x20, "start function ran");
  assert.equal(e.g(), 0x21);
  assert.equal(e.fwdg(), 0x10, "global init from another global");
  assert.equal(e.f32(), 3);
  assert.equal(e.f64(), 1.5 * 2 ** 47 - 1.5);
  assert.equal(e.i64(), 0x7fffffffffffffffn);
  assert.equal(e.wrap(), 0x500044e4);
  assert.equal(e.neg(), -2147483648);
  assert.equal(e.u32(), -1);
  const mem = new Uint8Array(e.memory.buffer);
  const want = Buffer.concat([Buffer.from('ABC\n\t"\\\\"'), Buffer.from("é", "utf8"), Buffer.from("tail")]);
  assert.deepEqual(Buffer.from(mem.subarray(16, 16 + want.length)), want);
});

test("streaming at any chunk size gives the same bytes as one string", async () => {
  const whole = assembleWatSync(BIG);
  for (const size of [1, 2, 3, 7, 64, 1000]) {
    const chunks = [];
    for (let i = 0; i < BIG.length; i += size) chunks.push(BIG.slice(i, i + size));
    async function* gen() { for (const c of chunks) yield c; }
    const r = await assembleWat(gen());
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(whole), `chunk size ${size}`);
  }
});

test("a bare field list (no (module ...) wrapper) assembles", async () => {
  const b = assembleWatSync(`(func (export "f") (result i32) (i32.const 9))`);
  assert.equal((await inst(b)).f(), 9);
});

test("streams to a file with the code section spilled and relocations resolved", async (t) => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(import.meta.dirname, ".asmtest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Many functions, each calling the NEXT one (forward references only).
  const N = 300;
  async function* gen() {
    yield "(module\n";
    for (let i = 0; i < N; i++) {
      yield i < N - 1
        ? `(func $f${i} (export "f${i}") (param $x i32) (result i32) (call $f${i + 1} (i32.add (local.get $x) (i32.const 1))))\n`
        : `(func $f${i} (export "f${i}") (param $x i32) (result i32) (local.get $x))\n`;
    }
    yield ")";
  }
  const out = join(dir, "chain.wasm");
  const r = await assembleWat(gen(), { outputPath: out });
  assert.equal(r.bytes, null);
  assert.equal(r.definedFunctions, N);
  assert.ok(!existsSync(out + ".code.tmp"), "spill file removed");
  const e = await inst(readFileSync(out));
  assert.equal(e.f0(0), N - 1);
});

test("numeric literal forms", () => {
  assert.equal(parseI32("0xFFFF_FFFF"), -1);
  assert.equal(parseI32("-0x80000000"), -2147483648);
  assert.equal(parseI32("+42"), 42);
  assert.throws(() => parseI32("0x1_0000_0000"));
  assert.equal(parseI64("-1"), -1n);
  assert.equal(parseI64("0xFFFFFFFFFFFFFFFF"), -1n);
  assert.equal(parseF32Bits("0.062069"), new Uint32Array(new Float32Array([0.062069]).buffer)[0]);
  assert.equal(parseF32Bits("-0"), 0x80000000);
  assert.equal(parseF32Bits("inf"), 0x7f800000);
  assert.equal(parseF32Bits("nan:0x200000"), 0x7fa00000);
  assert.equal(parseF32Bits("0x1p-149"), 1);
  // Double rounding trap: 1 + 2^-24 + 2^-60 must round UP to 1 + 2^-23 in f32;
  // through a double it lands exactly on the f32 midpoint and would round to even (1).
  assert.equal(parseF32Bits("1.00000005960464477550"), 0x3f800001);
  const d = new DataView(parseF64Bytes("0x1.c6af84b912394p-5").buffer);
  assert.equal(d.getBigUint64(0, true), 0x3FAc6af84b912394n);
  assert.equal(new DataView(parseF64Bytes("-nan").buffer).getUint32(4, true), 0xfff80000);
  assert.equal(new DataView(parseF64Bytes("1_000.5").buffer).getFloat64(0, true), 1000.5);
});

test("errors name the problem and the function", () => {
  assert.throws(() => assembleWatSync("(module (func $f (br $nope)))"), /unknown label \$nope.*\$f/);
  assert.throws(() => assembleWatSync("(module (func $f (call $missing)))"), /unknown func '\$missing'/);
  assert.throws(() => assembleWatSync("(module (func $f (i32.bogus)))"), /unknown instruction 'i32.bogus'/);
  assert.throws(() => assembleWatSync("(module (func $f (v128.const i32x4 0 0 0 0) drop))"), /SIMD/);
  assert.throws(() => assembleWatSync("(module (func $f)"), /unbalanced|end of input/);
});

test("function names land in the name section; custom sections round-trip", async () => {
  const sec = recompileSectionBytes({ platform: "sms", referenceCore: "genesis_plus_gx", romSha1: null, regions: { vram: { offset: 0x10000, length: 16384, ref: "sms_vram" } } });
  const r = await assembleWat('(module (func $hello (export "h")) )', { customSections: [sec] });
  const mod = new WebAssembly.Module(r.bytes);
  assert.equal(WebAssembly.Module.customSections(mod, "name").length, 1);
  const info = readRecompileInfo(r.bytes);
  assert.equal(info.platform, "sms");
  assert.equal(info.regions.vram.ref, "sms_vram");
  assert.equal(info.version, 1);
});

test("wcGetInfoWat fills inputPtr and timePtr and refuses the known footguns", async () => {
  const b = abiBlock(0x1000);
  const fn = wcGetInfoWat({ info: b.info, width: 256, height: 192, fb: 0x2000, input: b.input, time: b.time, audio: 0x3000, audioCap: 4096, audioWrite: b.audioWrite, flags: 1, sampleRate: 48000 });
  const bytes = assembleWatSync(`(module (memory (export "memory") 1) ${fn} (func (export "wc_init")) (func (export "wc_render")))`);
  const e = await inst(bytes);
  const p = e.wc_get_info();
  const u32 = new Uint32Array(e.memory.buffer, p, 18);
  assert.equal(u32[WC_INFO.inputPtr / 4], b.input);
  assert.equal(u32[WC_INFO.timePtr / 4], b.time);
  assert.equal(u32[WC_INFO.timePtr / 4] % 8, 0);
  assert.equal(u32[WC_INFO.version / 4], 4); // wasmcart >= 0.31 refuses a cart below ABI v4
  assert.throws(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120 }), /time/);
  assert.throws(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120, time: 0x1164 }), /8-byte aligned/);
  assert.throws(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120, time: 0x1140 }), /overlaps/);
  // ABI v4: the pad block is 80 bytes. A clock right after 64 bytes of pads
  // (legal under v3) is now under pad 3, and the build must refuse it.
  assert.throws(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120, time: 0x1160 }), /input .*overlaps time/);
  assert.doesNotThrow(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120, time: 0x1170 }));
  assert.throws(() => wcGetInfoWat({ info: 0x1000, width: 1, height: 1, fb: 0x2000, input: 0x1120, time: 0x1170, version: 3 }), /below ABI v4/);
  // the shared block itself is v4-sized, and pads are 20 bytes apart
  assert.ok(b.time >= b.input + 80 && b.hostInfo >= b.time + 20);
  assert.equal(padAddr(b.input, 1) - b.input, 20);
  assert.throws(() => assertHostSpans({ info: 0x1000, input: 0x2000, time: 0x2100, others: [["RAM", 0x2040, 0x100]] }), /input .*overlaps RAM/);
});

test("watBytes matches the earlier emitter's escaping", () => {
  assert.equal(watBytes(Uint8Array.from([0x41, 0x22, 0x5c, 0x00, 0x7f, 0xff, 0x20])), "A\\22\\5c\\00\\7f\\ff ");
});
