// Flat (unbanked) SMS/GG emitter for carts of 32KB or less: one arm per ROM
// byte offset in $0000-$7FFF, the ROM copied into the Z80 address space at
// init, no mapper. This is the older of the two earlier Python emitters
// and the one its verified 32KB carts were built with; its frame model is
// simpler than the banked emitter's (a fixed 228 T per line with no carry, the
// VBlank interrupt taken only at line 192, no line interrupt).
//
// Plain JS ESM + JSDoc.

import { cost } from "./cycles.js";
import { lower, m1Count, rIncWat } from "./z80.js";
import { hwWat, renderWat, psgWat, miscWat, cramBody, startBody, ggLutBytes, CRAM, GGLUT, PROBE, SMSFB } from "./hw.js";
import { watBytes, abiBlock, assertHostSpans, padAddr, WC_ABI_VERSION } from "../cart-abi.js";

// Linear memory layout.
export const FLAT = Object.freeze({
  BMAP: 0x30000, // addr -> block id + 1, u16 entries
  BTAB: 0x50000, // block index -> Z80 address (u16)
  ABI: 0x60000,
  FB: 0x61000, // RGBA framebuffer 256x192
  TRACE: 0x91000, // PC ring, 16384 x i32
  RETLOG: 0xA1000, // ret log, 2048 x 8 bytes
  AUDIO: 0xA5000,
  ROMIMG: 0xB0000, // the ROM image (copied to $0000-$7FFF at init)
  PAGES: 13,
});

const SHARD_SZ = 384;

/** The flat emitter's full helper set: memory accessors (with a write watch), stack, flags. */
function helpersWat() {
  return `

  (func $rd8 (param $addr i32) (result i32)
    (i32.load8_u (i32.and (local.get $addr) (i32.const 0xFFFF))))

  (global $wwaddr (mut i32) (i32.const 0))
  (global $wwval (mut i32) (i32.const 0))
  (global $wwhit (mut i32) (i32.const 0))
  (global $wwpc (mut i32) (i32.const 0))
  (func $wr8 (param $addr i32) (param $v i32)
    (local $a i32)
    (if (i32.eq (i32.and (local.get $addr) (i32.const 0xFFFF)) (global.get $wwaddr))
      (then (global.set $wwval (local.get $v))
            (global.set $wwpc (global.get $curblk))
            (global.set $wwhit (i32.add (global.get $wwhit) (i32.const 1)))))
    (local.set $a (i32.and (local.get $addr) (i32.const 0xFFFF)))
    (if (i32.ge_u (local.get $a) (i32.const 0xC000))
      (then
        (i32.store8 (i32.or (i32.and (local.get $a) (i32.const 0x1FFF)) (i32.const 0xC000))
                    (i32.and (local.get $v) (i32.const 0xFF))))))

  (func $rd16 (param $addr i32) (result i32)
    (i32.or (call $rd8 (local.get $addr))
            (i32.shl (call $rd8 (i32.add (local.get $addr) (i32.const 1))) (i32.const 8))))

  (func $wr16 (param $addr i32) (param $v i32)
    (call $wr8 (local.get $addr) (i32.and (local.get $v) (i32.const 0xFF)))
    (call $wr8 (i32.add (local.get $addr) (i32.const 1))
               (i32.shr_u (local.get $v) (i32.const 8))))

  (func $push16 (param $v i32)
    (global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (call $wr16 (global.get $sp) (local.get $v)))

  (func $pop16_logged (param $frompc i32) (result i32)
    (local $v i32)
    (local.set $v (call $pop16))
    (i32.store (i32.add (i32.const 0xA1000)
                 (i32.mul (i32.and (global.get $retn) (i32.const 2047)) (i32.const 8)))
               (local.get $frompc))
    (i32.store (i32.add (i32.const 0xA1004)
                 (i32.mul (i32.and (global.get $retn) (i32.const 2047)) (i32.const 8)))
               (local.get $v))
    (global.set $retn (i32.add (global.get $retn) (i32.const 1)))
    (local.get $v))

  (func $pop16 (result i32)
    (local $v i32)
    (local.set $v (call $rd16 (global.get $sp)))
    (global.set $sp (i32.and (i32.add (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))
    (local.get $v))

  (func $szp (param $v i32) (result i32)
    (local $f i32) (local $p i32) (local $x i32)
    (local.set $x (i32.and (local.get $v) (i32.const 0xFF)))
    (if (i32.eqz (local.get $x)) (then (local.set $f (i32.const 0x40))))
    (local.set $f (i32.or (local.get $f) (i32.and (local.get $x) (i32.const 0x80))))
    (local.set $f (i32.or (local.get $f) (i32.and (local.get $x) (i32.const 0x28))))
    (local.set $p (i32.and (i32.popcnt (local.get $x)) (i32.const 1)))
    (if (i32.eqz (local.get $p)) (then (local.set $f (i32.or (local.get $f) (i32.const 0x04)))))
    (local.get $f))

  (func $add8 (param $x i32) (param $y i32) (param $carry i32) (result i32)
    (local $r i32) (local $f i32)
    (local.set $r (i32.add (i32.add (local.get $x) (local.get $y)) (local.get $carry)))
    (local.set $f (i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 1)))
    (local.set $f (i32.or (local.get $f)
      (i32.and (i32.add (i32.add (i32.and (local.get $x) (i32.const 0xF))
                                 (i32.and (local.get $y) (i32.const 0xF)))
                        (local.get $carry)) (i32.const 0x10))))
    (local.set $f (i32.or (local.get $f) (i32.and (local.get $r) (i32.const 0xA8))))
    (if (i32.eqz (i32.and (local.get $r) (i32.const 0xFF)))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x40)))))
    (if (i32.and (i32.const 0x80)
          (i32.and (i32.xor (local.get $x) (i32.xor (local.get $y) (i32.const 0x80)))
                   (i32.xor (local.get $x) (local.get $r))))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x04)))))
    (global.set $f (local.get $f))
    (i32.and (local.get $r) (i32.const 0xFF)))

  (func $sub8 (param $x i32) (param $y i32) (param $carry i32) (result i32)
    (local $r i32) (local $f i32)
    (local.set $r (i32.sub (i32.sub (local.get $x) (local.get $y)) (local.get $carry)))
    (local.set $f (i32.const 0x02))
    (local.set $f (i32.or (local.get $f)
      (i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 1))))
    (local.set $f (i32.or (local.get $f)
      (i32.and (i32.sub (i32.sub (i32.and (local.get $x) (i32.const 0xF))
                                 (i32.and (local.get $y) (i32.const 0xF)))
                        (local.get $carry)) (i32.const 0x10))))
    (local.set $f (i32.or (local.get $f) (i32.and (local.get $r) (i32.const 0xA8))))
    (if (i32.eqz (i32.and (local.get $r) (i32.const 0xFF)))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x40)))))
    (if (i32.and (i32.const 0x80)
          (i32.and (i32.xor (local.get $x) (local.get $y))
                   (i32.xor (local.get $x) (local.get $r))))
      (then (local.set $f (i32.or (local.get $f) (i32.const 0x04)))))
    (global.set $f (local.get $f))
    (i32.and (local.get $r) (i32.const 0xFF)))

  (func $add16 (param $x i32) (param $y i32) (result i32)
    (local $r i32)
    (local.set $r (i32.add (local.get $x) (local.get $y)))
    (global.set $f (i32.or
      (i32.and (global.get $f) (i32.const 0xC4))
      (i32.or (i32.and (i32.shr_u (local.get $r) (i32.const 16)) (i32.const 1))
              (i32.and (i32.shr_u (i32.xor (i32.xor (local.get $x) (local.get $y)) (local.get $r))
                                  (i32.const 8)) (i32.const 0x10)))))
    (i32.and (local.get $r) (i32.const 0xFFFF)))
`;
}

function charge(n) {
  return n ? `(local.set $budget (i32.sub (local.get $budget) (i32.const ${n})))` : "";
}

function emitFlow(f, extra = 0) {
  switch (f.kind) {
    case "jp": return `    (global.set $pc (i32.const ${f.target}))`;
    case "jp_ind": return `    (global.set $pc ${f.expr})`;
    case "jp_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (global.set $pc (i32.const ${f.target})))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "call": return `    (call $push16 (i32.const ${f.ret}))\n` +
      `    (global.set $pc (i32.const ${f.target}))`;
    case "call_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (call $push16 (i32.const ${f.ret}))\n` +
      `            (global.set $pc (i32.const ${f.target})))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "ret": return `    (global.set $pc (call $pop16_logged (i32.const ${f.at ?? 0})))`;
    case "ret_cc": return `    (if ${f.cond}\n` +
      `      (then ${charge(extra)} (global.set $pc (call $pop16_logged (i32.const ${f.at ?? 0}))))\n` +
      `      (else (global.set $pc (i32.const ${f.next}))))`;
    case "halt": return `    (global.set $pc (i32.const ${f.next}))`;
    default: throw new Error(`sms recompile: unknown flow kind ${f.kind}`);
  }
}

function splitMnem(s) {
  const t = s.replace(/^\s+/, "");
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  return m ? [m[1], m[2] || ""] : ["", ""];
}

/** One arm. Returns [wat, lowered]. */
function armWat(img, idx, addr, size, counts) {
  const ent = idx.get(addr);
  if (!ent) { counts.missing++; return "    (local.set $budget (i32.sub (local.get $budget) (i32.const 1)))\n    (call $trap)"; }
  const ins = [[addr, ent[0], ent[1]]];
  let c = 0;
  for (const [, , s] of ins) { const [m, o] = splitMnem(s); c += cost(m, o)[1]; }
  c = Math.max(1, c);
  const parts = [`    (local.set $budget (i32.sub (local.get $budget) (i32.const ${c})))`];
  for (const [a, n, s] of ins) {
    const [mn, ops] = splitMnem(s);
    let wat, flow;
    try {
      [wat, flow] = lower(mn, ops, a, n);
    } catch {
      counts.unsupported++;
      parts.push(`    ;; UNSUPPORTED ${s}\n    (call $trap)`);
      return parts.join("\n");
    }
    parts.push("    " + rIncWat(m1Count(a < img.length ? img[a] : 0)));
    if (wat) parts.push("    " + wat);
    if (flow) {
      const [tk, nt] = cost(mn, ops);
      parts.push(emitFlow(flow, tk - nt));
      return parts.join("\n");
    }
  }
  parts.push(`    (global.set $pc (i32.const ${(addr + size) & 0xFFFF}))`);
  return parts.join("\n");
}

function abiWat(nblocks, platform) {
  const { BMAP, BTAB, ABI, FB, AUDIO, ROMIMG } = FLAT;
  const AB = abiBlock(ABI);
  assertHostSpans({ who: "sms flat", info: AB.info, input: AB.input, time: AB.time, hostInfo: AB.hostInfo, audioWrite: AB.audioWrite,
    audio: AUDIO, audioBytes: 4096 * 8, others: [["FB", FB, 256 * 192 * 4], ["TRACE", FLAT.TRACE, 16384 * 4], ["BTAB", BTAB, ABI - BTAB]] });
  const CRAMBODY = cramBody(platform, CRAM);
  const STARTBTN = startBody(platform);
  return `
  (global $frames (mut i32) (i32.const 0))
  (global $irqs (mut i32) (i32.const 0))
  (global $clr163 (mut i32) (i32.const 0))
  (global $snap300 (mut i32) (i32.const 0))
  (global $retn (mut i32) (i32.const 0))
  (global $hit6e6 (mut i32) (i32.const 0))
  (global $hit6e9 (mut i32) (i32.const 0))
  (global $hit788 (mut i32) (i32.const 0))
  (global $curblk (mut i32) (i32.const 0))
  (global $hit6f2 (mut i32) (i32.const 0))
  (global $hit2c6 (mut i32) (i32.const 0))
  (global $hit218 (mut i32) (i32.const 0))
  (global $retlog (mut i32) (i32.const 0))
  (global $s_a (mut i32) (i32.const 0)) (global $s_f (mut i32) (i32.const 0))
  (global $s_b (mut i32) (i32.const 0)) (global $s_c (mut i32) (i32.const 0))
  (global $s_d (mut i32) (i32.const 0)) (global $s_e (mut i32) (i32.const 0))
  (global $s_h (mut i32) (i32.const 0)) (global $s_l (mut i32) (i32.const 0))
  (global $hit15e (mut i32) (i32.const 0))

  (func $blockmap_init
    (local $i i32)
    (local.set $i (i32.const 0))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const ${nblocks})))
      (i32.store16
        (i32.add (i32.const ${BMAP})
          (i32.mul (i32.load16_u (i32.add (i32.const ${BTAB}) (i32.mul (local.get $i) (i32.const 2))))
                   (i32.const 2)))
        (i32.add (local.get $i) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $rom_init
    (local $i i32)
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (i32.const 32768)))
      (i32.store8 (local.get $i)
        (i32.load8_u (i32.add (i32.const ${ROMIMG}) (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func $cram_rgba (param $i i32) (result i32)
    (local $c i32) (local $r i32) (local $g i32) (local $b i32)
${CRAMBODY}
    (i32.or (i32.const 0xFF000000)
      (i32.or (i32.shl (local.get $r) (i32.const 16))
        (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))

  (func $present
    (local $i i32) (local $n i32)
    (local.set $n (i32.const 49152))
    (block $d (loop $l
      (br_if $d (i32.ge_u (local.get $i) (local.get $n)))
      (i32.store (i32.add (i32.const ${FB}) (i32.mul (local.get $i) (i32.const 4)))
        (call $cram_rgba (i32.load8_u (i32.add (i32.const ${SMSFB}) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l))))

  (func (export "wc_get_info") (result i32)
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 0))  (i32.const ${WC_ABI_VERSION}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 4))  (i32.const 256))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 8))  (i32.const 192))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 12)) (i32.const ${FB}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 16)) (i32.const ${AUDIO}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 20)) (i32.const 4096))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 24)) (i32.add (i32.const ${ABI}) (i32.const 256)))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 28)) (i32.const ${AB.input}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 32)) (i32.const 0))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 36)) (i32.const 0))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 40)) (i32.const ${AB.time}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 44)) (i32.const ${AB.hostInfo}))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 48)) (i32.const 1))
    (i32.store (i32.add (i32.const ${ABI}) (i32.const 52)) (i32.const 48000))
    (i32.const ${ABI}))

  (func (export "wc_init")
    (call $rom_init)
    (call $blockmap_init)
    (global.set $pc (i32.const 0))
    (global.set $sp (i32.const 0xDFF0)))

  (func (export "wc_render")
    (local $ln i32) (local $btn i32) (local $k i32)
    (global.set $frames (i32.add (global.get $frames) (i32.const 1)))

    (local.set $btn (i32.load16_u (i32.const ${padAddr(AB.input, 0)})))
    (global.set $joy1 (i32.const 0xFF))
    (if (i32.and (local.get $btn) (i32.const 256))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFE)))))
    (if (i32.and (local.get $btn) (i32.const 512))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFD)))))
    (if (i32.and (local.get $btn) (i32.const 1024))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xFB)))))
    (if (i32.and (local.get $btn) (i32.const 2048))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xF7)))))
    (if (i32.and (local.get $btn) (i32.const 1))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xEF)))))
    (if (i32.and (local.get $btn) (i32.const 2))
      (then (global.set $joy1 (i32.and (global.get $joy1) (i32.const 0xDF)))))
${STARTBTN}

    (local.set $k (i32.const 0))
    (block $fd (loop $fl
      (br_if $fd (i32.ge_u (local.get $k) (i32.const 262)))
      (local.set $ln (i32.rem_u (i32.add (local.get $k) (i32.const 192)) (i32.const 262)))
      (global.set $line (local.get $ln))
      (call $run (i32.const 228))
      (if (i32.lt_u (local.get $ln) (i32.const 192))
        (then (call $render_line (local.get $ln))))
      (if (i32.eq (local.get $ln) (i32.const 192))
        (then
          (global.set $vdp_status (i32.or (global.get $vdp_status) (i32.const 0x80)))
          (if (i32.and (i32.ne (global.get $iff) (i32.const 0))
                       (i32.ne (i32.and (call $vreg (i32.const 1)) (i32.const 0x20)) (i32.const 0)))
            (then
              (global.set $irqs (i32.add (global.get $irqs) (i32.const 1)))
              (global.set $iff (i32.const 0))
              (global.set $halted (i32.const 0))
              (call $push16 (global.get $pc))
              (global.set $pc (i32.const 0x38))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $fl)))
    (call $present)
    (call $psg_render)
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 0))  (global.get $frames))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 4))  (global.get $trapped))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 8))  (global.get $trappc))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 12)) (global.get $pc))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 16)) (global.get $vdpwn))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 20)) (global.get $irqs))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 24)) (global.get $vdp_status))
    (i32.store (i32.add (i32.const ${PROBE}) (i32.const 28)) (global.get $sp))
  )

  (export "dbg_pc" (global $pc))
  (export "dbg_trapped" (global $trapped))
  (export "dbg_joy1" (global $joy1))
  (export "dbg_trappc" (global $trappc))
  (export "dbg_frames" (global $frames))
  (export "dbg_sp" (global $sp))
  (export "dbg_iff" (global $iff))
  (export "dbg_irqs" (global $irqs))
  (export "dbg_clr163" (global $clr163))
  (export "dbg_retn" (global $retn))
  (export "hit6e6" (global $hit6e6)) (export "hit6e9" (global $hit6e9)) (export "hit788" (global $hit788))
  (export "hit6f2" (global $hit6f2)) (export "hit2c6" (global $hit2c6)) (export "hit218" (global $hit218))
  (export "s_a" (global $s_a)) (export "s_f" (global $s_f))
  (export "s_b" (global $s_b)) (export "s_c" (global $s_c))
  (export "s_d" (global $s_d)) (export "s_e" (global $s_e))
  (export "s_h" (global $s_h)) (export "s_l" (global $s_l))
  (export "dbg_hit15e" (global $hit15e))
  (export "dbg_halted" (global $halted))
  (export "dbg_a" (global $a))
  (export "dbg_h" (global $h))
  (export "dbg_l" (global $l))
  (export "dbg_c" (global $c))
  (export "dbg_f" (global $f))
  (export "dbg_b" (global $b))
  (export "p_t0" (global $p_t0)) (export "p_t1" (global $p_t1)) (export "p_t2" (global $p_t2))
  (export "p_v0" (global $p_v0)) (export "p_v1" (global $p_v1)) (export "p_v2" (global $p_v2))
  (export "p_nreg" (global $nreg)) (export "p_nvol" (global $nvol))
  (export "ww_addr" (global $wwaddr)) (export "ww_val" (global $wwval)) (export "ww_hit" (global $wwhit))
  (export "ww_pc" (global $wwpc)) (export "curblk" (global $curblk))
  (export "dbg_iyh" (global $iyh)) (export "dbg_iyl" (global $iyl))
  (export "dbg_a2" (global $a))
  (export "dbg_d" (global $d))
  (export "dbg_e" (global $e))
  (export "dbg_hl_h" (global $h))
  (export "dbg_line" (global $line))
  (export "dbg_tracei" (global $tracei))
`;
}

/**
 * Emit a flat cart. `idx` is the instruction index (file offset -> [len, text]).
 * @param {Uint8Array} IMG
 * @param {{platform: 'sms'|'gg'}} cfg
 * @param {Map<number, [number, string]>} idx
 * @param {object} stats filled in
 */
export async function* emitFlatWat(IMG, cfg, idx, stats) {
  const { BMAP, BTAB, TRACE, AUDIO, ABI, ROMIMG } = FLAT;
  const PLATFORM = cfg.platform;
  // One arm per byte offset of $0000-$7FFF, sized by the decoded instruction.
  const addrs = [];
  const sizes = new Map();
  for (let a = 0; a < Math.min(0x8000, IMG.length); a++) {
    const ent = idx.get(a);
    if (!ent) throw new Error(`sms recompile (flat): no decoded instruction at $${a.toString(16)}; refusing a partial index`);
    addrs.push(a);
    sizes.set(a, ent[0]);
  }
  const counts = { unsupported: 0, missing: 0 };
  const head = ["(module", `  (memory (export "memory") ${FLAT.PAGES})`];
  for (const g of ["a", "f", "b", "c", "d", "e", "h", "l", "ixh", "ixl", "iyh", "iyl", "rreg", "ireg",
    "a2", "f2", "b2", "c2", "d2", "e2", "h2", "l2"]) head.push(`  (global $${g} (mut i32) (i32.const 0))`);
  head.push("  (global $sp (mut i32) (i32.const 0xDFF0))",
    "  (global $pc (mut i32) (i32.const 0))",
    "  (global $iff (mut i32) (i32.const 0))",
    "  (global $halted (mut i32) (i32.const 0))",
    "  (global $joy1 (mut i32) (i32.const 0xFF))",
    "  (global $joy2 (mut i32) (i32.const 0xFF))",
    "  (global $trapped (mut i32) (i32.const 0))",
    "  (global $trappc (mut i32) (i32.const 0))",
    "  (global $steps (mut i32) (i32.const 0))");
  head.push(helpersWat(), hwWat(PLATFORM), renderWat(), psgWat(AUDIO, ABI), miscWat());
  head.push(`
  (func $blockid (param $pc i32) (result i32)
    (i32.load16_u (i32.add (i32.const ${BMAP}) (i32.mul (i32.and (local.get $pc) (i32.const 0xFFFF)) (i32.const 2)))))

  (func $trap
    (global.set $trapped (i32.const 1))
    (global.set $trappc (global.get $pc)))

  (global $tracei (mut i32) (i32.const 0))
  (func $trace (param $pc i32)
    (i32.store (i32.add (i32.const ${TRACE})
                 (i32.mul (i32.and (global.get $tracei) (i32.const 16383)) (i32.const 4)))
               (local.get $pc))
    (global.set $tracei (i32.add (global.get $tracei) (i32.const 1))))
`);
  yield head.join("\n") + "\n";

  const n = addrs.length;
  const nshard = Math.ceil(n / SHARD_SZ);
  for (let sh = 0; sh < nshard; sh++) {
    const lo = sh * SHARD_SZ, hi = Math.min(n, lo + SHARD_SZ), cnt = hi - lo;
    const p = [`  (func $shard${sh} (param $id i32) (param $budget i32) (result i32)`,
      "    (local $t i32) (local $t2 i32) (local $cf i32)"];
    for (let i = cnt - 1; i >= 0; i--) p.push(`      (block $s${i}`);
    p.push("        (block $sdef");
    const labels = [];
    for (let i = 0; i < cnt; i++) labels.push(`$s${i}`);
    p.push("          (br_table " + labels.join(" ") + " $sdef (local.get $id)))");
    p.push("        (call $trap) (return (local.get $budget))");
    for (let i = 0; i < cnt; i++) {
      const a = addrs[lo + i];
      p.push(`      ) ;; ---- arm ${lo + i} @ $${a.toString(16).toUpperCase().padStart(4, "0")}`);
      p.push(`    (global.set $curblk (i32.const ${a}))`);
      p.push(armWat(IMG, idx, a, sizes.get(a), counts));
      p.push("      (return (local.get $budget))");
    }
    p.push("    (local.get $budget))");
    yield p.join("\n") + "\n";
  }

  const r = ["  (func $run (param $budget i32)",
    "    (local $id i32) (local $sh i32)",
    "    (block $exit (loop $next",
    "      (br_if $exit (i32.le_s (local.get $budget) (i32.const 0)))",
    "      (br_if $exit (global.get $trapped))",
    "      (br_if $exit (global.get $halted))",
    "      (call $trace (global.get $pc))",
    "      (local.set $id (call $blockid (global.get $pc)))",
    "      (if (i32.eqz (local.get $id)) (then (call $trap) (br $exit)))",
    "      (local.set $id (i32.sub (local.get $id) (i32.const 1)))",
    `      (local.set $sh (i32.div_u (local.get $id) (i32.const ${SHARD_SZ})))`,
    `      (local.set $id (i32.rem_u (local.get $id) (i32.const ${SHARD_SZ})))`];
  for (let sh = nshard - 1; sh >= 0; sh--) r.push(`      (block $k${sh}`);
  r.push("        (block $kdef");
  const kl = [];
  for (let i = 0; i < nshard; i++) kl.push(`$k${i}`);
  r.push("          (br_table " + kl.join(" ") + " $kdef (local.get $sh)))");
  r.push("        (call $trap) (br $exit)");
  for (let sh = 0; sh < nshard; sh++) {
    r.push(`      ) ;; shard ${sh}`);
    r.push(`      (local.set $budget (call $shard${sh} (local.get $id) (local.get $budget)))`);
    r.push("      (br $next)");
  }
  r.push("    ))", "  )");
  r.push(abiWat(n, PLATFORM));
  yield r.join("\n") + "\n";

  const btab = new Uint8Array(n * 2);
  addrs.forEach((a, i) => { btab[i * 2] = a & 0xFF; btab[i * 2 + 1] = (a >> 8) & 0xFF; });
  yield `  (data (i32.const ${BTAB}) "${watBytes(btab)}")\n`;
  yield `  (data (i32.const ${GGLUT}) "${watBytes(ggLutBytes())}")\n`;
  yield `  (data (i32.const ${ROMIMG}) "${watBytes(IMG)}")\n`;
  yield ")";
  const trapped = counts.unsupported + counts.missing;
  Object.assign(stats, { emitter: "flat", arms: n, lowered: n - trapped, trapped, unsupported: counts.unsupported, noInstruction: counts.missing, shards: nshard });
}
