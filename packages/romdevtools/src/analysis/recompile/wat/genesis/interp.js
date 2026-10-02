// The 68000 interpreter of the Genesis WAT backend: runs any instruction
// whose pc has no compiled arm (code the game builds or copies into work RAM
// that no scan or trace found, RAM code whose words changed since it was
// compiled, a cartridge bank a mapper re-based to something the reference was
// not seen running, any other non-ROM pc). No discovery run and no per-game
// option is needed for that code to run exactly.
//
// The interpreter is the backend's own arms, one per OPCODE WORD (65536),
// each the gpgx Musashi handler partially evaluated by ctrans.js exactly as a
// ROM arm is, with two things left to run time:
//
//   - the extension words: read at run time through $ifetch16 (gpgx's
//     m68ki_read_imm_16: the word the bank's memory_map base holds), so an
//     immediate, an absolute address or a displacement is whatever the code
//     holds when it runs;
//   - the instruction's address: each handler is translated at two
//     different addresses and every constant that differs between the two
//     must differ by exactly the address difference (a return address, a
//     branch target, a PC-relative effective address, the next pc); it is
//     rewritten as $curpc + offset. Anything else that depends on the address
//     fails the build.
//
// Every relocated handler is then checked against direct translations at
// two more addresses (a low ROM address and a sign-extended work RAM address,
// $FFFFxxxx): the instantiated template must equal the directly translated
// arm text exactly, or the build fails.
//
// The one ctrans.js extension it needs (Arm.dynReg, opt-in) is a register
// READ whose number comes from a run-time extension word: the index register
// of d8(An,Xn) / d8(PC,Xn), through $dar_get.
//
// LICENSE: carts built by this backend contain code transpiled from Genesis
// Plus GX and are NON-COMMERCIAL (see NOTICE and gpgx-derived.json.gz).
//
// Plain JS ESM + JSDoc.

import { translateM68k, TrError } from "./ctrans.js";
import { SRAMBUF } from "./runtime.js";

/** Handlers per interpreter shard (64 shards cover the 65536 opcode words). */
const ISH = 1024;
/** Translation addresses: two to relocate from, two to check against (even, distinct high bits). */
const PA = 0x00F05A00, PB = 0x00E1C300;
const CHECK_AT = [0x00000400, 0xFFFFF200];

const CONST_RE = /\(i32\.const (-?(?:0x[0-9A-Fa-f]+|\d+))\)/g;

function tokens(text) {
  const segs = [], vals = [];
  let last = 0;
  for (const m of text.matchAll(CONST_RE)) {
    segs.push(text.slice(last, m.index));
    const s = m[1];
    vals.push((s.startsWith("-") ? -parseInt(s.slice(1)) : parseInt(s)) >>> 0);
    last = m.index + m[0].length;
  }
  segs.push(text.slice(last));
  return { segs, vals };
}

/** The extension word at instruction address + k, read when the handler runs. */
const fetchAt = (P) => (p) => `(call $ifetch16 (i32.add (global.get $curpc) (i32.const ${(p - P) | 0})))`;

/**
 * One opcode word's interpreter handler, or null when the backend cannot
 * translate that opcode at all (its ROM arm would be a trap too).
 * @param {object} m68k  hydrated gpgx data (gpgx-data.js loadGpgxData().m68k)
 * @param {number} ir
 * @returns {{body: string, nlocals: number}|null}
 */
export function interpHandler(m68k, ir) {
  const tr = (P) => translateM68k(m68k, ir, P, fetchAt(P), { dynReg: true });
  let a, b;
  try {
    a = tr(PA);
    b = tr(PB);
  } catch (e) {
    if (e instanceof TrError) return null;
    throw e;
  }
  const ta = tokens(a.body), tb = tokens(b.body);
  if (ta.segs.length !== tb.segs.length || ta.segs.some((s, i) => s !== tb.segs[i])) {
    throw new Error(`genesis interpreter: opcode $${ir.toString(16)}: the handler's structure depends on its address`);
  }
  const d = (PB - PA) >>> 0;
  const rel = ta.vals.map((v, i) => {
    if (v === tb.vals[i]) return null;
    if (((tb.vals[i] - v) >>> 0) !== d) throw new Error(`genesis interpreter: opcode $${ir.toString(16)}: constant #${i} (${v} / ${tb.vals[i]}) is not address-relative`);
    return (v - PA) | 0;
  });
  let body = ta.segs[0];
  ta.vals.forEach((v, i) => {
    body += (rel[i] === null ? `(i32.const ${v})` : rel[i] === 0 ? "(global.get $curpc)" : `(i32.add (global.get $curpc) (i32.const ${rel[i]}))`) + ta.segs[i + 1];
  });
  // check: the template at other addresses IS the directly translated arm
  for (const P of CHECK_AT) {
    const c = tokens(tr(P).body);
    const ok = c.segs.length === ta.segs.length && c.segs.every((s, i) => s === ta.segs[i]) &&
      c.vals.every((v, i) => (rel[i] === null ? v === ta.vals[i] : v === ((P + rel[i]) >>> 0)));
    if (!ok) throw new Error(`genesis interpreter: opcode $${ir.toString(16)}: the relocated handler does not reproduce the arm translated at $${(P >>> 0).toString(16)}`);
  }
  return { body, nlocals: Math.max(a.nlocals, b.nlocals) };
}

let memo = null;

/**
 * Every opcode word's handler, built once per process (they depend only on
 * the gpgx data, not on the cart).
 * @param {object} D loadGpgxData()
 * @returns {{handlers: Array<{body: string, nlocals: number}|null>, stats: {translated: number, untranslatable: number, relocated: number}}}
 */
export function m68kInterpHandlers(D) {
  if (memo) return memo;
  const handlers = new Array(0x10000);
  const stats = { translated: 0, untranslatable: 0, relocated: 0 };
  for (let ir = 0; ir < 0x10000; ir++) {
    const h = interpHandler(D.m68k, ir);
    handlers[ir] = h;
    if (!h) stats.untranslatable++;
    else {
      stats.translated++;
      if (h.body.includes("(global.get $curpc)")) stats.relocated++;
    }
  }
  memo = { handlers, stats };
  return memo;
}

/**
 * The interpreter: $dar_get, $ifetch16, 64 handler shards and $m68k_interp
 * (one instruction at $curpc, called from $step and from guarded RAM arms
 * whose variants all fail).
 * @param {object} D loadGpgxData()
 * @returns {Generator<string>}
 */
export function* m68kInterpWat(D) {
  const { handlers } = m68kInterpHandlers(D);
  yield `
  ;; ---- the 68000 interpreter (interp.js) ----
  (global $interps (mut i32) (i32.const 0))
  (func $dar_get (param $i i32) (result i32)
    (block $d15 (block $d14 (block $d13 (block $d12 (block $d11 (block $d10 (block $d9 (block $d8
    (block $d7 (block $d6 (block $d5 (block $d4 (block $d3 (block $d2 (block $d1 (block $d0
      (br_table $d0 $d1 $d2 $d3 $d4 $d5 $d6 $d7 $d8 $d9 $d10 $d11 $d12 $d13 $d14 $d15 (local.get $i)))
${Array.from({ length: 15 }, (_, i) => `      (return (global.get $r${i})))`).join("\n")}
      (global.get $r15))
  ;; m68ki_read_imm_16: the word the bank's memory_map base holds. Backup RAM
  ;; is fetched byte-swapped (gpgx keeps sram.sram in 68000 byte order and
  ;; reads it as a host-order word); everything else as $raw16 sees it.
  (func $ifetch16 (param $a i32) (result i32)
    (local $e i32) (local $o i32)
    (local.set $a (i32.and (local.get $a) (i32.const 0xFFFFFE)))
    (if (i32.lt_u (local.get $a) (i32.const 0x400000))
      (then
        (local.set $e (call $cartmap (local.get $a)))
        (if (i32.or (i32.eq (local.get $e) (i32.const -1)) (i32.eq (local.get $e) (i32.const -2)))
          (then
            (local.set $o (i32.add (i32.const ${SRAMBUF}) (i32.and (local.get $a) (i32.const 0xFFFE))))
            (return (i32.or (i32.load8_u (local.get $o)) (i32.shl (i32.load8_u offset=1 (local.get $o)) (i32.const 8))))))))
    (call $raw16 (local.get $a)))
`;
  for (let sh = 0; sh < 0x10000 / ISH; sh++) {
    let nl = 1;
    const bodies = [];
    for (let i = 0; i < ISH; i++) {
      const h = handlers[sh * ISH + i];
      if (h && h.nlocals > nl) nl = h.nlocals;
      bodies.push(`      ) ;; $${(sh * ISH + i).toString(16).toUpperCase().padStart(4, "0")}\n    ${h ? h.body : "(call $trap)"} (return)\n`);
    }
    const parts = [`  (func $ishard${sh} (param $id i32)\n`];
    parts.push("    " + Array.from({ length: nl }, (_, i) => `(local $t${i + 1} i32)`).join(" ") + "\n");
    let open = "    (block $sdef ";
    for (let i = ISH - 1; i >= 0; i--) open += `(block $s${i} `;
    parts.push(open + "\n");
    parts.push("      (br_table " + Array.from({ length: ISH }, (_, i) => `$s${i}`).join(" ") + " $sdef (local.get $id))\n");
    parts.push("      (call $trap) (return)\n");
    parts.push(bodies.join(""));
    parts.push("    ) (call $trap))\n");
    yield parts.join("");
  }
  const nsh = 0x10000 / ISH;
  let d = "  (func $m68k_interp\n    (local $op i32)\n" +
    "    (local.set $op (call $ifetch16 (global.get $curpc)))\n" +
    "    (global.set $interps (i32.add (global.get $interps) (i32.const 1)))\n";
  for (let i = nsh - 1; i >= 0; i--) d += `    (block $k${i}\n`;
  d += "    (block $kdef\n      (br_table " + Array.from({ length: nsh }, (_, i) => `$k${i}`).join(" ") + ` $kdef (i32.shr_u (local.get $op) (i32.const ${Math.log2(ISH)}))))\n`;
  d += "    (call $trap) (return)\n";
  for (let i = 0; i < nsh; i++) d += `    ) (call $ishard${i} (i32.and (local.get $op) (i32.const ${ISH - 1}))) (return)\n`;
  d += "  )\n  (func (export \"dbg_interps\") (result i32) (global.get $interps))\n";
  yield d;
}
