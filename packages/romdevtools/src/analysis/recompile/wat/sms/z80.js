// Z80 -> WAT lowering for the SMS/GG backend.
//
// Each rule turns one disassembled instruction (mnemonic + operand text from
// the IR index) into WAT over machine state held in wasm globals:
//   $a $f $b $c $d $e $h $l $ixh $ixl $iyh $iyl $sp $pc $iff $halted
// Flags live in $f as the real F register (S Z 5 H 3 PV N C) because games
// read them through push af / pop af and conditional returns.
//
// Ported rule for rule from the earlier Python emitter; the emitted WAT is identical
// to the Python emitter's after comment/whitespace normalisation (the
// differential gate in sms.test.js / the PLAN doc).
//
// Plain JS ESM + JSDoc.

/**
 * genesis_plus_gx's accumulator ops, whose F bits 5 and 3 come from A (or the
 * rotated result) and whose CCF sets H to the old carry.
 */
const EXACT_ACC = {
  rlca: "(global.set $a (i32.and (i32.or (i32.shl (global.get $a) (i32.const 1)) (i32.shr_u (global.get $a) (i32.const 7))) (i32.const 0xFF))) " +
    "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (i32.and (global.get $a) (i32.const 0x29))))",
  rrca: "(local.set $cf (i32.and (global.get $a) (i32.const 1))) " +
    "(global.set $a (i32.or (i32.shr_u (global.get $a) (i32.const 1)) (i32.shl (local.get $cf) (i32.const 7)))) " +
    "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (local.get $cf)) (i32.and (global.get $a) (i32.const 0x28))))",
  rla: "(local.set $cf (i32.shr_u (global.get $a) (i32.const 7))) " +
    "(global.set $a (i32.and (i32.or (i32.shl (global.get $a) (i32.const 1)) (i32.and (global.get $f) (i32.const 1))) (i32.const 0xFF))) " +
    "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (local.get $cf)) (i32.and (global.get $a) (i32.const 0x28))))",
  rra: "(local.set $cf (i32.and (global.get $a) (i32.const 1))) " +
    "(global.set $a (i32.or (i32.shr_u (global.get $a) (i32.const 1)) (i32.shl (i32.and (global.get $f) (i32.const 1)) (i32.const 7)))) " +
    "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (local.get $cf)) (i32.and (global.get $a) (i32.const 0x28))))",
  cpl: "(global.set $a (i32.xor (global.get $a) (i32.const 0xFF))) " +
    "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xC5)) (i32.const 0x12)) (i32.and (global.get $a) (i32.const 0x28))))",
  scf: "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xEC)) (i32.const 1)) (i32.and (global.get $a) (i32.const 0x28))))",
  ccf: "(global.set $f (i32.xor (i32.or (i32.or (i32.and (global.get $f) (i32.const 0xED)) (i32.shl (i32.and (global.get $f) (i32.const 1)) (i32.const 4))) " +
    "(i32.and (global.get $a) (i32.const 0x28))) (i32.const 1)))",
};

/** Thrown for an instruction the lowering has no rule for (becomes a trap arm). */
export class Unsupported extends Error {}

const IDX = /^\((i[xy])[+-][^)]+\)$/;
const IDX_PARTS = /^\((i[xy])([+-])([^)]+)\)$/;
const isidx = (t) => IDX.test(t);

export const R8 = new Set(["a", "b", "c", "d", "e", "h", "l"]);
export const R16 = new Set(["bc", "de", "hl", "sp", "ix", "iy", "af"]);
const HALVES = new Set(["ixh", "ixl", "iyh", "iyl"]);

/**
 * Flag/ALU helper functions emitted once into the module ($szp, $add8,
 * $sub8, $add16). The banked emitter supplies its own memory accessors.
 */
export function flagHelpersWat(opts = {}) {
  const text = flagHelpersLegacyWat();
  if (!opts.exact) return text;
  // gpgx ADD16: F bits 5 and 3 from the high byte of the result.
  const old = "(i32.and (i32.shr_u (i32.xor (i32.xor (local.get $x) (local.get $y)) (local.get $r))\n                                  (i32.const 8)) (i32.const 0x10)))))";
  const neu = "(i32.or (i32.and (i32.shr_u (i32.xor (i32.xor (local.get $x) (local.get $y)) (local.get $r))\n                                  (i32.const 8)) (i32.const 0x10))\n                      (i32.and (i32.shr_u (local.get $r) (i32.const 8)) (i32.const 0x28))))))";
  if (!text.includes(old)) throw new Error("sms recompile: $add16 text not found");
  return text.replace(old, neu);
}

function flagHelpersLegacyWat() {
  return `
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
`
//---;
}

const PAIR = { bc: ["b", "c"], de: ["d", "e"], hl: ["h", "l"], ix: ["ixh", "ixl"], iy: ["iyh", "iyl"] };

function pair(p) {
  const v = Object.hasOwn(PAIR, p) ? PAIR[p] : undefined;
  if (!v) throw new Unsupported(`no register pair '${p}'`);
  return v;
}

/**
 * Operand token -> integer: $1234, 0x1234, decimal, or an Lxxxxxx label.
 * Throws on anything else (the caller turns that into a trap arm).
 * @param {string} tok
 */
export function imm(tok) {
  let t = tok.trim();
  const neg = t.startsWith("-");
  if (neg) t = t.slice(1);
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(t) && (t[0] === "L" || t[0] === "l") && /^[Ll][0-9A-Fa-f]{4,6}$/.test(t)) {
    return parseInt(t.slice(1), 16);
  }
  let v;
  if (t.startsWith("$")) {
    if (!/^[0-9A-Fa-f]+$/.test(t.slice(1))) throw new Unsupported(`bad hex operand '${tok}'`);
    v = parseInt(t.slice(1), 16);
  } else if (t.startsWith("0x")) {
    if (!/^[0-9A-Fa-f]+$/.test(t.slice(2))) throw new Unsupported(`bad hex operand '${tok}'`);
    v = parseInt(t.slice(2), 16);
  } else {
    if (!/^\+?[0-9]+$/.test(t)) throw new Unsupported(`bad operand '${tok}'`);
    v = parseInt(t, 10);
  }
  return neg ? -v : v;
}

/** WAT expression for a 16-bit register pair. */
export function get16(p) {
  if (p === "sp") return "(global.get $sp)";
  const [hi, lo] = pair(p);
  return `(i32.or (i32.shl (global.get $${hi}) (i32.const 8)) (global.get $${lo}))`;
}

/** WAT statements storing a 16-bit expression into a register pair. */
export function set16(p, expr) {
  if (p === "sp") return `(global.set $sp (i32.and ${expr} (i32.const 0xFFFF)))`;
  const [hi, lo] = pair(p);
  return `(local.set $t ${expr}) ` +
    `(global.set $${hi} (i32.and (i32.shr_u (local.get $t) (i32.const 8)) (i32.const 0xFF))) ` +
    `(global.set $${lo} (i32.and (local.get $t) (i32.const 0xFF)))`;
}

function idxDisp(r) {
  const m = IDX_PARTS.exec(r);
  if (!m) return null;
  const d = imm(m[3]) * (m[2] === "+" ? 1 : -1);
  return { p: m[1], d: d === 0 ? 0 : d };
}

/** WAT expression for an 8-bit operand. */
export function get8(r) {
  if (r === "(hl)") return "(call $rd8 " + get16("hl") + ")";
  if (R8.has(r)) return `(global.get $${r})`;
  const x = typeof r === "string" ? idxDisp(r) : null;
  if (x) return `(call $rd8 (i32.and (i32.add ${get16(x.p)} (i32.const ${x.d})) (i32.const 0xFFFF)))`;
  throw new Unsupported(`no 8-bit operand '${r}'`);
}

/** WAT statements storing into an 8-bit operand. */
export function set8(r, expr) {
  if (r === "(hl)") return `(call $wr8 ${get16("hl")} ${expr})`;
  if (R8.has(r)) return `(global.set $${r} (i32.and ${expr} (i32.const 0xFF)))`;
  const x = typeof r === "string" ? idxDisp(r) : null;
  if (x) return `(call $wr8 (i32.and (i32.add ${get16(x.p)} (i32.const ${x.d})) (i32.const 0xFFFF)) ${expr})`;
  throw new Unsupported(`no 8-bit destination '${r}'`);
}

/** Condition code -> WAT predicate on $f. */
export const COND = {
  z: "(i32.and (global.get $f) (i32.const 0x40))",
  nz: "(i32.eqz (i32.and (global.get $f) (i32.const 0x40)))",
  c: "(i32.and (global.get $f) (i32.const 0x01))",
  nc: "(i32.eqz (i32.and (global.get $f) (i32.const 0x01)))",
  pe: "(i32.and (global.get $f) (i32.const 0x04))",
  po: "(i32.eqz (i32.and (global.get $f) (i32.const 0x04)))",
  m: "(i32.and (global.get $f) (i32.const 0x80))",
  p: "(i32.eqz (i32.and (global.get $f) (i32.const 0x80)))",
};

function cond(k) {
  if (!Object.hasOwn(COND, k)) throw new Unsupported(`no condition '${k}'`);
  return COND[k];
}

function need(o, n, what) {
  if (o.length < n) throw new Unsupported(`${what}: missing operand`);
}

/**
 * Lower one instruction.
 * @param {string} mnem
 * @param {string} ops
 * @param {number} addr  CPU address of the instruction
 * @param {number} size  its length in bytes
 * @param {{exact?: boolean}} [mode]  exact: genesis_plus_gx semantics where
 *   the earlier lowering differed: `ei` also arms the one-instruction EI delay
 *   ($eidelay), DI/EI set IFF2 as well as IFF1, reti/retn copy IFF2 into
 *   IFF1 (the pause NMI clears IFF1 only), and `adc hl,rr` adds the carry
 *   (the earlier lowering routed it through the add path). The banked emitter uses it
 *   unless `legacy`.
 * @returns {[string, object|null]} [wat, flow]; flow says how control leaves the block
 */
export function lower(mnem, ops, addr, size, mode = {}) {
  const r = lowerInner(mnem, ops, addr, size, mode);
  return mode.exact ? withMemptr(mnem, ops, addr, r) : r;
}

/**
 * genesis_plus_gx's internal WZ (MEMPTR) register, kept in $wz: every
 * instruction that sets it in z80.c sets it here, because BIT n,(HL) copies
 * its high byte into F bits 5 and 3 and games push F. Control-flow updates
 * are annotated on the flow (wzAlways / wzTaken / wzPop) for emitFlow.
 * @param {string} mnem @param {string} ops @param {number} addr
 * @param {[string, object|null]} r
 */
function withMemptr(mnem, ops, addr, r) {
  let [wat, flow] = r;
  const o = ops ? ops.split(",").map((x) => x.trim()) : [];
  const set = (e) => `(global.set $wz (i32.and ${e} (i32.const 0xFFFF)))`;
  const inc = (e) => set(`(i32.add ${e} (i32.const 1))`);
  const hiA = (lo) => set(`(i32.or (i32.and ${lo} (i32.const 0xFF)) (i32.shl (global.get $a) (i32.const 8)))`);
  let pre = "", post = "";
  // (IX+d)/(IY+d): EAX/EAY set WZ to the effective address
  const idx = o.map((x) => idxDisp(x)).find(Boolean);
  if (idx) pre = set(`(i32.add ${get16(idx.p)} (i32.const ${idx.d}))`);
  const nn = (x) => imm(x.slice(1, -1));
  const isAbs = (x) => x.startsWith("(") && !isidx(x) && !["(hl)", "(bc)", "(de)", "(sp)", "(c)", "(ix)", "(iy)"].includes(x);
  if (mnem === "ld" && o.length === 2) {
    const [d, s] = o;
    if (d === "a" && (s === "(bc)" || s === "(de)")) post = inc(get16(s.slice(1, -1)));
    else if ((d === "(bc)" || d === "(de)") && s === "a") post = hiA(`(i32.add ${get16(d.slice(1, -1))} (i32.const 1))`);
    else if (d === "a" && isAbs(s)) post = set(`(i32.const ${nn(s) + 1})`);
    else if (isAbs(d) && s === "a") post = hiA(`(i32.const ${nn(d) + 1})`);
    else if ((R16.has(d) && isAbs(s)) || (isAbs(d) && R16.has(s))) post = set(`(i32.const ${nn(isAbs(d) ? d : s) + 1})`);
  } else if ((mnem === "add" || mnem === "adc" || mnem === "sbc") && o.length === 2 && ["hl", "ix", "iy"].includes(o[0]) && R16.has(o[1])) {
    pre = inc(get16(o[0]));
  } else if (mnem === "ex" && o[0] === "(sp)") {
    post = set(get16(o[1]));
  } else if (mnem === "in" && o.length === 2 && o[0] === "a") {
    pre = o[1] === "(c)" ? inc(get16("bc")) : inc(`(i32.or (i32.shl (global.get $a) (i32.const 8)) (i32.const ${nn(o[1]) & 0xFF}))`);
  } else if (mnem === "out" && o.length === 2 && o[1] === "a") {
    pre = o[0] === "(c)" ? inc(get16("bc")) : hiA(`(i32.const ${(nn(o[0]) + 1) & 0xFF})`);
  } else if (mnem === "rld" || mnem === "rrd") {
    pre = inc(get16("hl"));
  }
  if (flow) {
    flow = { ...flow };
    if (mnem === "jp" && flow.target !== undefined) flow.wzAlways = flow.target;
    else if (mnem === "call" || mnem === "rst") flow.wzAlways = flow.target;
    else if (mnem === "jr" || mnem === "djnz") flow.wzTaken = flow.target;
    else if (mnem === "ret" || mnem === "reti" || mnem === "retn") flow.wzPop = true;
    else if (["ldir", "lddr", "cpir", "cpdr"].includes(mnem)) flow.wzTaken = (addr + 1) & 0xFFFF;
  }
  return [[pre, wat, post].filter(Boolean).join(" "), flow];
}

function lowerInner(mnem, ops, addr, size, mode = {}) {
  const o = ops ? ops.split(",").map((x) => x.trim()) : [];
  const nxt = (addr + size) & 0xFFFF;

  if (mnem === "ld") {
    need(o, 2, "ld");
    const d = o[0], s = o[1];
    if (d === "a" && (s === "(bc)" || s === "(de)")) return [`(global.set $a (call $rd8 ${get16(s.slice(1, -1))}))`, null];
    if ((d === "(bc)" || d === "(de)") && s === "a") return [`(call $wr8 ${get16(d.slice(1, -1))} (global.get $a))`, null];
    // ld a,r / ld a,i: S Z (and bits 5/3) from the value, H=N=0, P/V = IFF2,
    // C preserved. R is the refresh counter the emitter bumps per fetch.
    if (d === "a" && (s === "r" || s === "i")) {
      const src = s === "r" ? "(global.get $rreg)" : "(global.get $ireg)";
      // P/V is IFF2 (gpgx LD_A_I/LD_A_R), which only differs from IFF1 inside an NMI handler.
      const iff2 = mode.exact ? "$iff2" : "$iff";
      return [`(global.set $a (i32.and ${src} (i32.const 0xFF))) ` +
        "(global.set $f (i32.or (i32.or (i32.and (global.get $f) (i32.const 1)) " +
        "(i32.and (global.get $a) (i32.const 0xA8))) (i32.or " +
        "(select (i32.const 0x40) (i32.const 0) (i32.eqz (global.get $a))) " +
        `(select (i32.const 4) (i32.const 0) (i32.ne (global.get ${iff2}) (i32.const 0))))))`, null];
    }
    if (d === "r" && s === "a") return ["(global.set $rreg (global.get $a))", null];
    if (d === "i" && s === "a") return ["(global.set $ireg (global.get $a))", null];
    // Undocumented IX/IY halves behave as plain 8-bit registers.
    if (HALVES.has(d) || HALVES.has(s)) {
      const gv = HALVES.has(s) ? `(global.get $${s})`
        : (R8.has(s) || s === "(hl)" || isidx(s)) ? get8(s)
          : `(i32.const ${imm(s) & 0xFF})`;
      if (HALVES.has(d)) return [`(global.set $${d} (i32.and ${gv} (i32.const 0xFF)))`, null];
      return [set8(d, gv), null];
    }
    if (R8.has(d) || d === "(hl)" || isidx(d)) {
      if (R8.has(s) || s === "(hl)" || isidx(s)) return [set8(d, get8(s)), null];
      if (s.startsWith("(")) return [set8(d, `(call $rd8 (i32.const ${imm(s.slice(1, -1))}))`), null];
      return [set8(d, `(i32.const ${imm(s) & 0xFF})`), null];
    }
    if (R16.has(d)) {
      if (R16.has(s)) return [set16(d, get16(s)), null];
      if (s.startsWith("(")) return [set16(d, `(call $rd16 (i32.const ${imm(s.slice(1, -1))}))`), null];
      return [set16(d, `(i32.const ${imm(s) & 0xFFFF})`), null];
    }
    if (d.startsWith("(")) {
      const a = d.slice(1, -1);
      if (a === "hl" || a === "bc" || a === "de") {
        return [`(call $wr8 ${get16(a)} ${R8.has(s) ? get8(s) : `(i32.const ${imm(s) & 0xFF})`})`, null];
      }
      if (R8.has(s)) return [`(call $wr8 (i32.const ${imm(a)}) ${get8(s)})`, null];
      if (R16.has(s)) return [`(call $wr16 (i32.const ${imm(a)}) ${get16(s)})`, null];
    }
    throw new Unsupported(`ld ${ops}`);
  }

  if (mnem === "add" || mnem === "adc" || mnem === "sub" || mnem === "sbc" || mnem === "and" || mnem === "or" || mnem === "xor" || mnem === "cp") {
    if ((mnem === "add" || (mnem === "adc" && !mode.exact)) && (o[0] === "hl" || o[0] === "ix" || o[0] === "iy") && o.length === 2 && R16.has(o[1])) {
      return [set16(o[0], `(call $add16 ${get16(o[0])} ${get16(o[1])})`), null];
    }
    if (mnem === "sbc" && o[0] === "hl" && o.length === 2 && R16.has(o[1])) return [set16("hl", `(call $sbc16 ${get16("hl")} ${get16(o[1])})`), null];
    if (mnem === "adc" && o[0] === "hl" && o.length === 2 && R16.has(o[1])) return [set16("hl", `(call $adc16 ${get16("hl")} ${get16(o[1])})`), null];
    need(o, 1, mnem);
    const src = (o.length === 2 && o[0] === "a") ? o[1] : o[0];
    let sv;
    if (HALVES.has(src)) sv = `(global.get $${src})`;
    else sv = (R8.has(src) || src === "(hl)" || isidx(src)) ? get8(src) : `(i32.const ${imm(src) & 0xFF})`;
    const cy = "(i32.and (global.get $f) (i32.const 1))";
    if (mnem === "add") return [`(global.set $a (call $add8 (global.get $a) ${sv} (i32.const 0)))`, null];
    if (mnem === "adc") return [`(global.set $a (call $add8 (global.get $a) ${sv} ${cy}))`, null];
    if (mnem === "sub") return [`(global.set $a (call $sub8 (global.get $a) ${sv} (i32.const 0)))`, null];
    if (mnem === "sbc") return [`(global.set $a (call $sub8 (global.get $a) ${sv} ${cy}))`, null];
    if (mnem === "cp") {
      // gpgx CP: F bits 5 and 3 come from the OPERAND, not the result.
      if (mode.exact) return [`(local.set $t ${sv}) (drop (call $sub8 (global.get $a) (local.get $t) (i32.const 0))) ` +
        "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xD7)) (i32.and (local.get $t) (i32.const 0x28))))", null];
      return [`(drop (call $sub8 (global.get $a) ${sv} (i32.const 0)))`, null];
    }
    const op = { and: "i32.and", or: "i32.or", xor: "i32.xor" }[mnem];
    const h = mnem === "and" ? "0x10" : "0x00";
    return [`(global.set $a (${op} (global.get $a) ${sv})) ` +
      `(global.set $f (i32.or (call $szp (global.get $a)) (i32.const ${h})))`, null];
  }

  if (mnem === "inc" || mnem === "dec") {
    need(o, 1, mnem);
    const r = o[0];
    if (HALVES.has(r)) {
      const op = mnem === "inc" ? "add8" : "sub8";
      return [`(local.set $cf (i32.and (global.get $f) (i32.const 1))) ` +
        `(global.set $${r} (i32.and (call $${op} (global.get $${r}) ` +
        "(i32.const 1) (i32.const 0)) (i32.const 0xFF))) " +
        "(global.set $f (i32.or (i32.and (global.get $f) " +
        "(i32.const 0xFE)) (local.get $cf)))", null];
    }
    if (R16.has(r)) {
      const delta = mnem === "inc" ? 1 : -1;
      return [set16(r, `(i32.add ${get16(r)} (i32.const ${delta}))`), null];
    }
    const body = mnem === "inc" ? `(call $add8 ${get8(r)} (i32.const 1) (i32.const 0))` : `(call $sub8 ${get8(r)} (i32.const 1) (i32.const 0))`;
    return ["(local.set $cf (i32.and (global.get $f) (i32.const 1))) " +
      `${set8(r, body)} ` +
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xFE)) (local.get $cf)))", null];
  }

  if (mode.exact && EXACT_ACC[mnem]) return [EXACT_ACC[mnem], null];
  if (mnem === "rlca") {
    return ["(global.set $a (i32.and (i32.or (i32.shl (global.get $a) (i32.const 1)) " +
      "(i32.shr_u (global.get $a) (i32.const 7))) (i32.const 0xFF))) " +
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) " +
      "(i32.and (global.get $a) (i32.const 1))))", null];
  }
  if (mnem === "rrca") {
    return ["(local.set $cf (i32.and (global.get $a) (i32.const 1))) " +
      "(global.set $a (i32.or (i32.shr_u (global.get $a) (i32.const 1)) " +
      "(i32.shl (local.get $cf) (i32.const 7)))) " +
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (local.get $cf)))", null];
  }
  if (mnem === "rla") {
    return ["(local.set $cf (i32.and (global.get $f) (i32.const 1))) " +
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) " +
      "(i32.shr_u (global.get $a) (i32.const 7)))) " +
      "(global.set $a (i32.and (i32.or (i32.shl (global.get $a) (i32.const 1)) " +
      "(local.get $cf)) (i32.const 0xFF)))", null];
  }
  if (mnem === "rra") {
    return ["(local.set $cf (i32.and (global.get $f) (i32.const 1))) " +
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) " +
      "(i32.and (global.get $a) (i32.const 1)))) " +
      "(global.set $a (i32.or (i32.shr_u (global.get $a) (i32.const 1)) " +
      "(i32.shl (local.get $cf) (i32.const 7))))", null];
  }
  if (mnem === "cpl") {
    return ["(global.set $a (i32.and (i32.xor (global.get $a) (i32.const 0xFF)) (i32.const 0xFF))) " +
      "(global.set $f (i32.or (global.get $f) (i32.const 0x12)))", null];
  }
  if (mnem === "scf") return ["(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0xC4)) (i32.const 1)))", null];
  if (mnem === "ccf") {
    return ["(global.set $f (i32.xor (i32.or (i32.and (global.get $f) (i32.const 0xC5)) " +
      "(i32.const 0)) (i32.const 1)))", null];
  }
  if (mnem === "nop") return ["(nop)", null];
  if (mnem === "neg") return ["(global.set $a (call $sub8 (i32.const 0) (global.get $a) (i32.const 0)))", null];
  if (mnem === "daa") return ["(call $daa)", null];

  if (mnem === "ex") {
    if (o.length === 2 && o[0] === "de" && o[1] === "hl") {
      // Two independent temps: set16() reuses $t, so building both halves
      // with it would read back the value it had just stored.
      return ["(local.set $t " + get16("de") + ") " +
        "(local.set $t2 " + get16("hl") + ") " +
        "(global.set $d (i32.and (i32.shr_u (local.get $t2) (i32.const 8)) (i32.const 0xFF))) " +
        "(global.set $e (i32.and (local.get $t2) (i32.const 0xFF))) " +
        "(global.set $h (i32.and (i32.shr_u (local.get $t) (i32.const 8)) (i32.const 0xFF))) " +
        "(global.set $l (i32.and (local.get $t) (i32.const 0xFF)))", null];
    }
    need(o, 1, "ex");
    if (o[0] === "af" || (o.length === 2 && o[0] === "af" && o[1] === "af'")) return ["(call $ex_af)", null];
    if (o[0] === "(sp)") {
      need(o, 2, "ex");
      const p = o[1];
      const [hi, lo] = pair(p);
      return ["(local.set $t2 (call $rd16 (global.get $sp))) " +
        `(call $wr16 (global.get $sp) ${get16(p)}) ` +
        `(global.set $${hi} (i32.and (i32.shr_u (local.get $t2) (i32.const 8)) (i32.const 0xFF))) ` +
        `(global.set $${lo} (i32.and (local.get $t2) (i32.const 0xFF)))`, null];
    }
    throw new Unsupported(`ex ${ops}`);
  }
  if (mnem === "exx") return ["(call $exx)", null];

  if (mnem === "bit" || mnem === "set" || mnem === "res") {
    need(o, 2, mnem);
    const n = imm(o[0]), r = o[1];
    const mask = n >= 0 && n < 31 ? (1 << n) : 2 ** n;
    if (mnem === "bit" && mode.exact) {
      // gpgx BIT: F bits 5 and 3 from the register tested, or for (ix+d)
      // from the high byte of the address. BIT n,(hl) takes them from the
      // high byte of the internal WZ (MEMPTR) register (withMemptr).
      const x = typeof r === "string" ? idxDisp(r) : null;
      const xy = r === "(hl)" ? "(i32.and (i32.shr_u (global.get $wz) (i32.const 8)) (i32.const 0x28))"
        : x ? `(i32.and (i32.shr_u (i32.and (i32.add ${get16(x.p)} (i32.const ${x.d})) (i32.const 0xFFFF)) (i32.const 8)) (i32.const 0x28))`
          : `(i32.and ${get8(r)} (i32.const 0x28))`;
      return [`(local.set $t (i32.and ${get8(r)} (i32.const ${mask}))) ` +
        "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0x01)) " +
        "(i32.or (i32.const 0x10) " +
        "(select (i32.const 0) (i32.const 0x44) (local.get $t))))) " +
        `(global.set $f (i32.or (i32.or (global.get $f) (i32.and (local.get $t) (i32.const 0x80))) ${xy}))`, null];
    }
    if (mnem === "bit") {
      return [`(local.set $t (i32.and ${get8(r)} (i32.const ${mask}))) ` +
        "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0x01)) " +
        "(i32.or (i32.const 0x10) " +
        "(select (i32.const 0) (i32.const 0x44) (local.get $t))))) " +
        "(global.set $f (i32.or (global.get $f) (i32.and (local.get $t) (i32.const 0x80))))", null];
    }
    if (mnem === "set") return [set8(r, `(i32.or ${get8(r)} (i32.const ${mask}))`), null];
    return [set8(r, `(i32.and ${get8(r)} (i32.const ${(~mask) & 0xFF}))`), null];
  }

  if (mnem === "rl" || mnem === "rr" || mnem === "sla" || mnem === "sra" || mnem === "srl" || mnem === "rlc" || mnem === "rrc" || mnem === "sll" || mnem === "sli") {
    need(o, 1, mnem);
    // sli is the common disassembler spelling of the undocumented sll.
    const fn = (mnem === "sll" || mnem === "sli") ? "sll" : mnem;
    return [set8(o[0], `(call $${fn} ${get8(o[0])})`), null];
  }

  if (mnem === "push") {
    need(o, 1, "push");
    const p = o[0];
    if (p === "af") return ["(call $push16 (i32.or (i32.shl (global.get $a) (i32.const 8)) (global.get $f)))", null];
    return [`(call $push16 ${get16(p)})`, null];
  }
  if (mnem === "pop") {
    need(o, 1, "pop");
    const p = o[0];
    if (p === "af") {
      return ["(local.set $t (call $pop16)) " +
        "(global.set $a (i32.and (i32.shr_u (local.get $t) (i32.const 8)) (i32.const 0xFF))) " +
        "(global.set $f (i32.and (local.get $t) (i32.const 0xFF)))", null];
    }
    return [set16(p, "(call $pop16)"), null];
  }

  if (mnem === "out") {
    need(o, 2, "out");
    const port = o[0], src = o[1];
    const pe = port === "(c)" ? "(global.get $c)" : `(i32.const ${imm(port.slice(1, -1))})`;
    // Undocumented ED 71 `out (c),0` writes a literal 0 (NMOS Z80).
    const se = src === "0" ? "(i32.const 0)" : get8(src);
    return [`(call $io_write ${pe} ${se})`, null];
  }
  if (mnem === "in") {
    need(o, 2, "in");
    const dst = o[0], port = o[1];
    const pe = port === "(c)" ? "(global.get $c)" : `(i32.const ${imm(port.slice(1, -1))})`;
    // Undocumented ED 70 `in f,(c)`: the read is for its FLAGS only.
    if (dst === "f") {
      return ["(local.set $t (call $io_read " + pe + ")) " +
        "(global.set $f (i32.or (call $szp (local.get $t)) " +
        "(i32.and (global.get $f) (i32.const 1))))", null];
    }
    // gpgx IN r,(C) sets S Z 5 3 P from the value, clears H and N, keeps C.
    if (mode.exact && port === "(c)") {
      return ["(local.set $t (call $io_read " + pe + ")) " + set8(dst, "(local.get $t)") + " " +
        "(global.set $f (i32.or (call $szp (local.get $t)) (i32.and (global.get $f) (i32.const 1))))", null];
    }
    return [set8(dst, `(call $io_read ${pe})`), null];
  }
  // DI/EI set both flip-flops (IFF2 is what an NMI saves and RETN restores).
  if (mnem === "di") return [mode.exact ? "(global.set $iff (i32.const 0)) (global.set $iff2 (i32.const 0))" : "(global.set $iff (i32.const 0))", null];
  // ei: see `mode.exact` above for the EI delay.
  if (mnem === "ei") return [mode.exact ? "(global.set $iff (i32.const 1)) (global.set $iff2 (i32.const 1)) (global.set $eidelay (i32.const 1))" : "(global.set $iff (i32.const 1))", null];
  // Interrupt mode: only IM 2 differs on this bus (IM 0 reads $FF = RST $38).
  if (mnem === "im") return [mode.exact ? `(global.set $im (i32.const ${imm(o[0] ?? "0") & 3}))` : "(nop)", null];
  // HALT: park until an interrupt, PC at the next instruction so the
  // handler returns past the halt.
  if (mnem === "halt") return ["(global.set $halted (i32.const 1))", { kind: "jp", target: nxt }];

  // Repeating block ops run ONE iteration per execution and branch back to
  // themselves (PC -= 2 while repeating): 21 T repeating, 16 T last, and an
  // interrupt can be taken between iterations.
  const REP = {
    ldir: ["(call $ldi_step (i32.const 1))", "(i32.or (global.get $b) (global.get $c))"],
    lddr: ["(call $ldi_step (i32.const -1))", "(i32.or (global.get $b) (global.get $c))"],
    cpir: ["(call $cpi_step (i32.const 1))",
      "(i32.and (i32.ne (i32.and (global.get $f) (i32.const 4)) (i32.const 0)) " +
      "(i32.eqz (i32.and (global.get $f) (i32.const 0x40))))"],
    cpdr: ["(call $cpi_step (i32.const -1))",
      "(i32.and (i32.ne (i32.and (global.get $f) (i32.const 4)) (i32.const 0)) " +
      "(i32.eqz (i32.and (global.get $f) (i32.const 0x40))))"],
    otir: ["(call $outi_step)", "(global.get $b)"],
    otdr: ["(call $outd_step)", "(global.get $b)"],
    inir: ["(call $ini)", "(global.get $b)"],
    indr: ["(call $ind)", "(global.get $b)"],
  };
  if (Object.hasOwn(REP, mnem)) {
    const [body, c] = REP[mnem];
    return [body, { kind: "jp_cc", cond: c, target: addr & 0xFFFF, next: nxt }];
  }
  if (["ldi", "ldd", "outi", "ini", "cpi", "outd", "ind", "rld", "rrd", "cpd"].includes(mnem)) return [`(call $${mnem})`, null];

  if (mnem === "jp") {
    need(o, 1, "jp");
    if (o.length === 1) {
      if (o[0] === "(hl)") return ["", { kind: "jp_ind", expr: get16("hl") }];
      if (o[0] === "(ix)" || o[0] === "(iy)") return ["", { kind: "jp_ind", expr: get16(o[0].slice(1, -1)) }];
      return ["", { kind: "jp", target: imm(o[0]) }];
    }
    return ["", { kind: "jp_cc", cond: cond(o[0]), target: imm(o[1]), next: nxt }];
  }
  if (mnem === "jr") {
    need(o, 1, "jr");
    if (o.length === 1) return ["", { kind: "jp", target: imm(o[0]) }];
    return ["", { kind: "jp_cc", cond: cond(o[0]), target: imm(o[1]), next: nxt }];
  }
  if (mnem === "djnz") {
    need(o, 1, "djnz");
    return ["(global.set $b (i32.and (i32.sub (global.get $b) (i32.const 1)) (i32.const 0xFF)))",
      { kind: "jp_cc", cond: "(global.get $b)", target: imm(o[0]), next: nxt }];
  }
  if (mnem === "call") {
    need(o, 1, "call");
    if (o.length === 1) return ["", { kind: "call", target: imm(o[0]), ret: nxt }];
    return ["", { kind: "call_cc", cond: cond(o[0]), target: imm(o[1]), ret: nxt, next: nxt }];
  }
  if (mnem === "rst") {
    need(o, 1, "rst");
    return ["", { kind: "call", target: imm(o[0]), ret: nxt }];
  }
  if (mnem === "ret") {
    if (!o.length) return ["", { kind: "ret", at: addr }];
    return ["", { kind: "ret_cc", cond: cond(o[0]), next: nxt, at: addr }];
  }
  // gpgx RETN and RETI both copy IFF2 into IFF1 (the pause NMI's return).
  if (mnem === "reti" || mnem === "retn") return [mode.exact ? "(global.set $iff (global.get $iff2))" : "(global.set $iff (i32.const 1))", { kind: "ret", at: addr }];
  if (mnem === "defb" || mnem === ".byte") return ["(nop)", null];
  throw new Unsupported(`${mnem} ${ops}`);
}

/**
 * Opcode fetches (M1 cycles) for an instruction starting with byte b0 - what
 * the refresh register R counts. CB/ED/DD/FD prefixes fetch twice.
 */
export function m1Count(b0) {
  return (b0 === 0xCB || b0 === 0xED || b0 === 0xDD || b0 === 0xFD) ? 2 : 1;
}

/** R += k in its low 7 bits, bit 7 preserved. */
export function rIncWat(k) {
  return "(global.set $rreg (i32.or (i32.and (global.get $rreg) (i32.const 0x80)) " +
    `(i32.and (i32.add (global.get $rreg) (i32.const ${k})) (i32.const 0x7F))))`;
}
