// LR35902 (Game Boy) -> WAT lowering, one instruction at a time.
//
// Design rule: throw `Unsupported` rather than guess. A wrong instruction that
// runs is far worse than a trap at a known pc; the emitter turns a throw into
// a trapping arm.
//
// The LR35902 is a cut-down Z80: no IX/IY, no shadow registers, no ED block.
// What it adds is the $FF00 page (`ldh`), `ld (hl+)/(hl-)`, `ld hl,sp+n`, and
// `stop`. Flags are Z N H C in bits 7-4 of F; the low nibble is always 0.
//
// `ei` takes effect one instruction late (the interrupt is taken AFTER the
// instruction that follows it): `ei; halt` is the idiom that needs it, since
// taking a pending interrupt before the `halt` sleeps a whole extra frame.
//
// Ported from the earlier Python emitter; the text this produces is byte-identical to
// it (the differential gate compares the whole cart's WAT).

export class Unsupported extends Error {}

const R8 = new Set(["b", "c", "d", "e", "h", "l", "a"]);
const R16 = new Set(["bc", "de", "hl", "sp"]);

/** Registers are globals $b,$c,... each holding 0..255; $sp and $pc are 16-bit. */
const r = (n) => `(global.get $${n})`;
const setr = (n, expr) => `(global.set $${n} (i32.and ${expr} (i32.const 0xFF)))`;
const hl = () => `(i32.or (i32.shl ${r("h")} (i32.const 8)) ${r("l")})`;

/** Character at i, throwing like a Python index would. */
function at(s, i) {
  if (i >= s.length) throw new Unsupported(`operand '${s}' too short`);
  return s[i];
}

function pair(p) {
  if (p === "sp") return "(global.get $sp)";
  if (p === "af") return `(i32.or (i32.shl ${r("a")} (i32.const 8)) ${r("f")})`;
  return `(i32.or (i32.shl ${r(at(p, 0))} (i32.const 8)) ${r(at(p, 1))})`;
}

function setpair(p, expr) {
  if (p === "sp") return `(global.set $sp (i32.and ${expr} (i32.const 0xFFFF)))`;
  if (p === "af") {
    return `(global.set $tmp (i32.and ${expr} (i32.const 0xFFFF)))`
      + setr("a", "(i32.shr_u (global.get $tmp) (i32.const 8))")
      // the low nibble of F is hardwired to 0
      + "(global.set $f (i32.and (global.get $tmp) (i32.const 0xF0)))";
  }
  const hi = at(p, 0), lo = at(p, 1);
  return `(global.set $tmp (i32.and ${expr} (i32.const 0xFFFF)))`
    + setr(hi, "(i32.shr_u (global.get $tmp) (i32.const 8))")
    + setr(lo, "(global.get $tmp)");
}

// ---- flags -------------------------------------------------------------
// F bits: Z=0x80 N=0x40 H=0x20 C=0x10
/**
 * Build F from parts. undefined PRESERVES that bit; 0 / 1 are constants; a
 * string is a WAT expression yielding 0/1.
 */
function setf({ z, n, h, c } = {}) {
  let keep = 0;
  if (z === undefined) keep |= 0x80;
  if (n === undefined) keep |= 0x40;
  if (h === undefined) keep |= 0x20;
  if (c === undefined) keep |= 0x10;
  const parts = keep ? [`(i32.and (global.get $f) (i32.const ${keep}))`] : [];
  for (const [bit, shift, val] of [[0x80, 7, z], [0x40, 6, n], [0x20, 5, h], [0x10, 4, c]]) {
    if (val === undefined || val === 0) continue;
    if (val === 1) parts.push(`(i32.const ${bit})`);
    else parts.push(`(i32.shl ${val} (i32.const ${shift}))`);
  }
  if (!parts.length) return "(global.set $f (i32.const 0))";
  let expr = parts[0];
  for (const p of parts.slice(1)) expr = `(i32.or ${expr} ${p})`;
  return `(global.set $f ${expr})`;
}

const zof = (expr) => `(i32.eqz (i32.and ${expr} (i32.const 0xFF)))`;

const CC = {
  nz: "(i32.eqz (i32.and (global.get $f) (i32.const 0x80)))",
  z: "(i32.ne (i32.and (global.get $f) (i32.const 0x80)) (i32.const 0))",
  nc: "(i32.eqz (i32.and (global.get $f) (i32.const 0x10)))",
  c: "(i32.ne (i32.and (global.get $f) (i32.const 0x10)) (i32.const 0))",
};
const isCC = (s) => Object.prototype.hasOwnProperty.call(CC, s);

/**
 * Integer literal parse with Python int(s, base) acceptance: optional sign,
 * optional 0x prefix in base 16, single underscores between digits.
 */
function pyInt(s, base) {
  const t = s.trim();
  const re = base === 16
    ? /^([+-]?)(?:0[xX])?_?([0-9a-fA-F](?:_?[0-9a-fA-F])*)$/
    : /^([+-]?)([0-9](?:_?[0-9])*)$/;
  const m = re.exec(t);
  if (!m) throw new Unsupported(`not a number: '${s}'`);
  const v = parseInt(m[2].replace(/_/g, ""), base);
  return m[1] === "-" ? -v : v;
}

/** Operand number: `L000038` label, `$hex`, `0xhex` or decimal. */
function num(s) {
  s = s.trim();
  // `L000038` is the block map's spelling for an intra-ROM target; the label
  // IS the address in hex (every RST vector on a real cart).
  if (s.length > 1 && (s[0] === "L" || s[0] === "l") && /^[0-9a-fA-F]+$/.test(s.slice(1))) {
    return parseInt(s.slice(1), 16);
  }
  if (s.startsWith("$")) return pyInt(s.slice(1), 16);
  if (s.toLowerCase().startsWith("0x")) return pyInt(s, 16);
  return pyInt(s, 10);
}

function isNum(s) {
  try { num(s); return true; } catch { return false; }
}

const seq = (parts) => parts.filter(Boolean).join(" ");

// ---- operands ----------------------------------------------------------
/** 8-bit source operand -> WAT expression. */
function load8(t) {
  t = t.trim();
  if (R8.has(t)) return r(t);
  if (t === "(hl)") return `(call $rd8 ${hl()})`;
  if (t === "(bc)" || t === "(de)") return `(call $rd8 ${pair(t.slice(1, 3))})`;
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    if (isNum(inner)) return `(call $rd8 (i32.const ${num(inner)}))`;
    if (inner === "c") return `(call $rd8 (i32.add (i32.const 0xFF00) ${r("c")}))`;   // ld a,(c) is the $FF00 page
    throw new Unsupported(`load8 ${t}`);
  }
  if (isNum(t)) return `(i32.const ${num(t) & 0xFF})`;
  throw new Unsupported(`load8 ${t}`);
}

function store8(t, expr) {
  t = t.trim();
  if (R8.has(t)) return setr(t, expr);
  if (t === "(hl)") return `(call $wr8 ${hl()} ${expr})`;
  if (t === "(bc)" || t === "(de)") return `(call $wr8 ${pair(t.slice(1, 3))} ${expr})`;
  if (t.startsWith("(") && t.endsWith(")")) {
    const inner = t.slice(1, -1);
    if (isNum(inner)) return `(call $wr8 (i32.const ${num(inner)}) ${expr})`;
    if (inner === "c") return `(call $wr8 (i32.add (i32.const 0xFF00) ${r("c")}) ${expr})`;
    throw new Unsupported(`store8 ${t}`);
  }
  throw new Unsupported(`store8 ${t}`);
}

/** Push a 16-bit constant, low byte first (the GB stack grows down). */
// Multi-access instructions touch memory at gambatte's cycles, not all at
// the one access offset $ioff assumes (opcode + operand fetches): $accx is
// added to it for the later accesses (cpu.cpp PUSH / pop_rr / RMW macros).
const accx = (n, body) => `(global.set $accx (i32.const ${n})) ${body} (global.set $accx (i32.const 0))`;

/**
 * Push a 16-bit value, high byte first (gambatte PUSH): the high byte at
 * `hiAt` cycles past $ioff, the low byte 4 later. `v` is a WAT expression
 * or a constant.
 */
export function pushWat(v, hiAt) {
  const e = typeof v === "number" ? null : "(global.get $pushv)";
  const hi = e ? `(i32.shr_u (i32.and ${e} (i32.const 0xFFFF)) (i32.const 8))` : `(i32.const ${(v >> 8) & 0xFF})`;
  const lo = e ? `(i32.and ${e} (i32.const 0xFF))` : `(i32.const ${v & 0xFF})`;
  return (e ? `(global.set $pushv ${v})` : "")
    + "(global.set $sp (i32.and (i32.sub (global.get $sp) (i32.const 2)) (i32.const 0xFFFF)))"
    + accx(hiAt, `(call $wr8 (i32.and (i32.add (global.get $sp) (i32.const 1)) (i32.const 0xFFFF)) ${hi})`)
    + accx(hiAt + 4, `(call $wr8 (global.get $sp) ${lo})`);
}

function push16(v, hiAt) {
  return pushWat(v, hiAt);
}

/** Pop into $tmp: the low byte at `loAt` cycles past $ioff, the high 4 later. */
export function popWat(loAt) {
  return accx(loAt, "(global.set $tmp (call $rd8 (global.get $sp)))")
    + accx(loAt + 4, "(global.set $tmp (i32.or (global.get $tmp) (i32.shl (call $rd8 (i32.and (i32.add (global.get $sp) "
    + "(i32.const 1)) (i32.const 0xFFFF))) (i32.const 8))))")
    + "(global.set $sp (i32.and (i32.add (global.get $sp) "
    + "(i32.const 2)) (i32.const 0xFFFF)))";
}
const POP16 = popWat(0);

/** Read-modify-write store: the value first, then the write 4 cycles after the read. */
function rmwStore(t, expr) {
  if (t.trim() !== "(hl)") return store8(t, expr);
  return `(global.set $rmwv ${expr}) ` + accx(4, `(call $wr8 ${hl()} (global.get $rmwv))`);
}

const CIN = "(i32.shr_u (i32.and (global.get $f) (i32.const 0x10)) (i32.const 4))";

/**
 * Lower one instruction.
 * @param {string} mnem
 * @param {string} ops operand text (`$XXXX` / `$XX` / `L0000NN` / decimal)
 * @param {number} addr CPU address of the instruction
 * @param {number} nxt CPU address of the next instruction
 * @returns {[string, object|null]} [body WAT, control flow or null]
 */
export function lower(mnem, ops, addr, nxt) {
  const m = mnem.toLowerCase();
  const o = ops.trim() ? ops.split(",").map((x) => x.trim()) : [];

  if (m === "nop") return ["", null];
  if (m === "ei") return ["(global.set $eipend (i32.const 1))", null];
  if (m === "di") return ["(global.set $ime (i32.const 0)) (global.set $eipend (i32.const 0))", null];
  // $halt_op: the DMG halt bug when an interrupt is already pending with IME off
  if (m === "halt") return ["(call $halt_op)", null];
  // $stop is the CGB speed switch when KEY1 is armed, and the timed sleep.
  if (m === "stop") return ["(call $stop)", null];
  if (m === "ccf") {
    return [seq([setf({ n: 0, h: 0,
      c: "(i32.xor (i32.shr_u (i32.and (global.get $f) "
        + "(i32.const 0x10)) (i32.const 4)) (i32.const 1))" })]), null];
  }
  if (m === "scf") return [setf({ n: 0, h: 0, c: 1 }), null];

  // ---- 8-bit loads ---------------------------------------------------
  if (m === "ld" && o.length === 2) {
    const [d, s] = o;
    // 16-bit pair forms first
    if (R16.has(d) || d === "af") {
      if (s === "hl" && d === "sp") return [setpair("sp", hl()), null];
      if (isNum(s)) return [setpair(d, `(i32.const ${num(s) & 0xFFFF})`), null];
      throw new Unsupported(`${m} ${ops}`);
    }
    if (R16.has(s) && d.startsWith("(") && isNum(d.slice(1, -1))) {
      // ld (nn),sp
      const a = num(d.slice(1, -1));
      return [`(call $wr8 (i32.const ${a}) `
        + `(i32.and ${pair(s)} (i32.const 0xFF)))`
        + accx(4, `(call $wr8 (i32.const ${(a + 1) & 0xFFFF}) `
        + `(i32.shr_u ${pair(s)} (i32.const 8)))`), null];
    }
    // (hl+)/(hl-) post-inc/dec
    for (const [tok, delta] of [["(hl+)", 1], ["(hl-)", -1], ["(hli)", 1], ["(hld)", -1]]) {
      if (d === tok) {
        return [seq([`(call $wr8 ${hl()} ${load8(s)})`,
          setpair("hl", `(i32.add ${hl()} (i32.const ${delta}))`)]), null];
      }
      if (s === tok) {
        return [seq([setr("tmp8", `(call $rd8 ${hl()})`),
          setpair("hl", `(i32.add ${hl()} (i32.const ${delta}))`),
          store8(d, r("tmp8"))]), null];
      }
    }
    return [store8(d, load8(s)), null];
  }

  if (m === "ldh" && o.length === 2) {
    const [d, s] = o;
    const ff = (t) => {
      const inner = t.slice(1, -1);
      if (isNum(inner)) return `(i32.const ${0xFF00 | (num(inner) & 0xFF)})`;
      if (inner === "c") return `(i32.add (i32.const 0xFF00) ${r("c")})`;
      throw new Unsupported(`ldh ${ops}`);
    };
    if (d.startsWith("(")) return [`(call $wr8 ${ff(d)} ${load8(s)})`, null];
    return [store8(d, `(call $rd8 ${ff(s)})`), null];
  }

  if (m === "ldhl" && o.length === 2 && o[0] === "sp") {
    // ld hl,sp+n - flags from the low-byte carry, Z and N cleared
    const n = num(o[1]) & 0xFF;
    const sn = n > 127 ? n - 256 : n;
    return [seq([
      "(global.set $tmp (i32.and (i32.add (global.get $sp) "
        + `(i32.const ${sn})) (i32.const 0xFFFF)))`,
      setf({ z: 0, n: 0,
        h: "(i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xF)) "
          + `(i32.const ${n & 0xF})) (i32.const 0xF))`,
        c: "(i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xFF)) "
          + `(i32.const ${n})) (i32.const 0xFF))` }),
      setpair("hl", "(global.get $tmp)")]), null];
  }

  // ---- 8-bit ALU -----------------------------------------------------
  if (["add", "adc", "sub", "sbc", "and", "or", "xor", "cp"].includes(m)) {
    // `add a,x` / `add x` both occur; `add hl,rr` / `add sp,n` are 16-bit
    // forms that share the mnemonic.
    if (m === "add" && o.length === 2 && o[0] === "hl") {
      if (!R16.has(o[1])) throw new Unsupported(`${mnem} ${ops}`);
      const src = pair(o[1]);
      return [seq([
        `(global.set $tmp (i32.add ${hl()} ${src}))`,
        setf({ n: 0,
          h: `(i32.gt_u (i32.add (i32.and ${hl()} (i32.const 0xFFF)) `
            + `(i32.and ${src} (i32.const 0xFFF))) (i32.const 0xFFF))`,
          c: "(i32.gt_u (global.get $tmp) (i32.const 0xFFFF))" }),
        setpair("hl", "(global.get $tmp)")]), null];
    }
    if (m === "add" && o.length === 2 && o[0] === "sp") {
      const n = num(o[1]) & 0xFF;
      const sn = n > 127 ? n - 256 : n;
      return [seq([
        setf({ z: 0, n: 0,
          h: "(i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xF)) "
            + `(i32.const ${n & 0xF})) (i32.const 0xF))`,
          c: "(i32.gt_u (i32.add (i32.and (global.get $sp) (i32.const 0xFF)) "
            + `(i32.const ${n})) (i32.const 0xFF))` }),
        "(global.set $sp (i32.and (i32.add (global.get $sp) "
          + `(i32.const ${sn})) (i32.const 0xFFFF)))`]), null];
    }
    const srcT = o.length === 2 ? o[1] : (o.length ? o[0] : null);
    if (srcT === null) throw new Unsupported(`${mnem} ${ops}`);
    const src = load8(srcT);
    const a = r("a");
    if (m === "add" || m === "adc") {
      const carry = m === "adc" ? CIN : "(i32.const 0)";
      return [seq([
        `(global.set $tmp (i32.add (i32.add ${a} ${src}) ${carry}))`,
        setf({ z: zof("(global.get $tmp)"), n: 0,
          h: `(i32.gt_u (i32.add (i32.add (i32.and ${a} (i32.const 0xF)) `
            + `(i32.and ${src} (i32.const 0xF))) ${carry}) (i32.const 0xF))`,
          c: "(i32.gt_u (global.get $tmp) (i32.const 0xFF))" }),
        setr("a", "(global.get $tmp)")]), null];
    }
    if (m === "sub" || m === "sbc" || m === "cp") {
      const carry = m === "sbc" ? CIN : "(i32.const 0)";
      const body = [
        `(global.set $tmp2 ${src})`,
        `(global.set $tmp (i32.sub (i32.sub ${a} (global.get $tmp2)) ${carry}))`,
        setf({ z: zof("(global.get $tmp)"), n: 1,
          h: `(i32.lt_s (i32.sub (i32.sub (i32.and ${a} (i32.const 0xF)) `
            + `(i32.and (global.get $tmp2) (i32.const 0xF))) ${carry}) (i32.const 0))`,
          c: "(i32.lt_s (global.get $tmp) (i32.const 0))" })];
      if (m !== "cp") body.push(setr("a", "(global.get $tmp)"));
      return [seq(body), null];
    }
    // and / or / xor
    const op = { and: "i32.and", or: "i32.or", xor: "i32.xor" }[m];
    return [seq([
      `(global.set $tmp (${op} ${a} ${src}))`,
      setf({ z: zof("(global.get $tmp)"), n: 0, h: m === "and" ? 1 : 0, c: 0 }),
      setr("a", "(global.get $tmp)")]), null];
  }

  if ((m === "inc" || m === "dec") && o.length === 1) {
    const t = o[0];
    if (R16.has(t) || t === "sp") {
      const d = m === "inc" ? 1 : -1;
      return [setpair(t, `(i32.add ${pair(t)} (i32.const ${d}))`), null];
    }
    const cur = load8(t);
    let body;
    if (m === "inc") {
      body = [`(global.set $tmp (i32.add ${cur} (i32.const 1)))`,
        setf({ z: zof("(global.get $tmp)"), n: 0,
          h: "(i32.eqz (i32.and (global.get $tmp) (i32.const 0xF)))" })];
    } else {
      body = [`(global.set $tmp (i32.sub ${cur} (i32.const 1)))`,
        setf({ z: zof("(global.get $tmp)"), n: 1,
          h: "(i32.eq (i32.and (global.get $tmp) (i32.const 0xF)) "
            + "(i32.const 0xF))" })];
    }
    body.push(rmwStore(t, "(global.get $tmp)"));
    return [seq(body), null];
  }

  if (m === "cpl") {
    return [seq([setr("a", `(i32.xor ${r("a")} (i32.const 0xFF))`), setf({ n: 1, h: 1 })]), null];
  }
  if (m === "daa") {
    // BCD adjust. Kept explicit rather than clever: the adjustment depends on
    // N, H and C together, and getting it subtly wrong is silent.
    return [seq([
      "(global.set $tmp (global.get $a))",
      "(if (i32.eqz (i32.and (global.get $f) (i32.const 0x40)))"
      + " (then"
      + "  (if (i32.or (i32.ne (i32.and (global.get $f) (i32.const 0x10)) (i32.const 0))"
      + "              (i32.gt_u (global.get $tmp) (i32.const 0x99)))"
      + "    (then (global.set $tmp (i32.add (global.get $tmp) (i32.const 0x60)))"
      + "          (global.set $f (i32.or (global.get $f) (i32.const 0x10)))))"
      + "  (if (i32.or (i32.ne (i32.and (global.get $f) (i32.const 0x20)) (i32.const 0))"
      + "              (i32.gt_u (i32.and (global.get $tmp) (i32.const 0xF)) (i32.const 9)))"
      + "    (then (global.set $tmp (i32.add (global.get $tmp) (i32.const 6))))))"
      + " (else"
      + "  (if (i32.ne (i32.and (global.get $f) (i32.const 0x10)) (i32.const 0))"
      + "    (then (global.set $tmp (i32.sub (global.get $tmp) (i32.const 0x60)))))"
      + "  (if (i32.ne (i32.and (global.get $f) (i32.const 0x20)) (i32.const 0))"
      + "    (then (global.set $tmp (i32.sub (global.get $tmp) (i32.const 6)))))))",
      setr("a", "(global.get $tmp)"),
      "(global.set $f (i32.or (i32.and (global.get $f) (i32.const 0x50))"
      + ` (i32.shl ${zof("(global.get $tmp)")} (i32.const 7))))`]), null];
  }

  // ---- rotates on A (fixed, always clear Z) ---------------------------
  if (["rlca", "rrca", "rla", "rra"].includes(m)) {
    const a = r("a");
    let nv, c;
    if (m === "rlca") {
      nv = `(i32.or (i32.shl ${a} (i32.const 1)) (i32.shr_u ${a} (i32.const 7)))`;
      c = `(i32.shr_u ${a} (i32.const 7))`;
    } else if (m === "rrca") {
      nv = `(i32.or (i32.shr_u ${a} (i32.const 1)) (i32.shl ${a} (i32.const 7)))`;
      c = `(i32.and ${a} (i32.const 1))`;
    } else if (m === "rla") {
      nv = `(i32.or (i32.shl ${a} (i32.const 1)) ${CIN})`;
      c = `(i32.shr_u ${a} (i32.const 7))`;
    } else {
      nv = `(i32.or (i32.shr_u ${a} (i32.const 1)) (i32.shl ${CIN} (i32.const 7)))`;
      c = `(i32.and ${a} (i32.const 1))`;
    }
    return [seq([`(global.set $tmp2 ${c})`, `(global.set $tmp ${nv})`,
      setf({ z: 0, n: 0, h: 0, c: "(global.get $tmp2)" }),
      setr("a", "(global.get $tmp)")]), null];
  }

  // ---- stack ----------------------------------------------------------
  if (m === "push" && o.length === 1) {
    return [pushWat(pair(o[0]), 0), null];
  }
  if (m === "pop" && o.length === 1) {
    return [seq([popWat(0), setpair(o[0], "(global.get $tmp)")]), null];
  }

  // ---- control flow ----------------------------------------------------
  if (m === "jp") {
    if (o.length === 1) {
      const t = o[0];
      if (t === "(hl)" || t === "hl") return ["", { kind: "jp_ind", expr: hl() }];
      if (isNum(t)) return ["", { kind: "jp", target: num(t) }];
      throw new Unsupported(`${mnem} ${ops}`);
    }
    if (o.length === 2 && isCC(o[0]) && isNum(o[1])) {
      return ["", { kind: "jp_cc", cond: CC[o[0]], target: num(o[1]), next: nxt }];
    }
    throw new Unsupported(`${mnem} ${ops}`);
  }

  if (m === "jr") {
    if (o.length === 1 && isNum(o[0])) return ["", { kind: "jp", target: num(o[0]) }];
    if (o.length === 2 && isCC(o[0]) && isNum(o[1])) {
      return ["", { kind: "jp_cc", cond: CC[o[0]], target: num(o[1]), next: nxt }];
    }
    throw new Unsupported(`${mnem} ${ops}`);
  }

  if (m === "call") {
    const push = push16(nxt, 4);
    if (o.length === 1 && isNum(o[0])) return [push, { kind: "jp", target: num(o[0]) }];
    if (o.length === 2 && isCC(o[0]) && isNum(o[1])) {
      return ["", { kind: "call_cc", cond: CC[o[0]], push, target: num(o[1]), next: nxt }];
    }
    throw new Unsupported(`${mnem} ${ops}`);
  }

  if (m === "rst" && o.length === 1 && isNum(o[0])) {
    return [push16(nxt, 0), { kind: "jp", target: num(o[0]) & 0x38 }];
  }

  if (m === "ret" || m === "reti") {
    const pre = m === "reti" ? "(global.set $ime (i32.const 1))" : "";
    if (o.length === 1 && isCC(o[0])) {
      return ["", { kind: "ret_cc", cond: CC[o[0]], pop: pre + popWat(4), next: nxt }];
    }
    return [pre + POP16, { kind: "ret_expr" }];
  }

  // ---- CB-prefixed: rotates, shifts, bit ops --------------------------
  if (["rlc", "rrc", "rl", "rr", "sla", "sra", "swap", "srl"].includes(m) && o.length === 1) {
    const t = o[0];
    const cur = load8(t);
    const v = "(global.get $tmp2)";
    let nv, c;
    if (m === "rlc") {
      nv = `(i32.or (i32.shl ${v} (i32.const 1)) (i32.shr_u ${v} (i32.const 7)))`;
      c = `(i32.shr_u ${v} (i32.const 7))`;
    } else if (m === "rrc") {
      nv = `(i32.or (i32.shr_u ${v} (i32.const 1)) (i32.shl ${v} (i32.const 7)))`;
      c = `(i32.and ${v} (i32.const 1))`;
    } else if (m === "rl") {
      nv = `(i32.or (i32.shl ${v} (i32.const 1)) ${CIN})`;
      c = `(i32.shr_u ${v} (i32.const 7))`;
    } else if (m === "rr") {
      nv = `(i32.or (i32.shr_u ${v} (i32.const 1)) (i32.shl ${CIN} (i32.const 7)))`;
      c = `(i32.and ${v} (i32.const 1))`;
    } else if (m === "sla") {
      nv = `(i32.shl ${v} (i32.const 1))`;
      c = `(i32.shr_u ${v} (i32.const 7))`;
    } else if (m === "sra") {
      // arithmetic shift: bit 7 is preserved
      nv = `(i32.or (i32.shr_u ${v} (i32.const 1)) (i32.and ${v} (i32.const 0x80)))`;
      c = `(i32.and ${v} (i32.const 1))`;
    } else if (m === "swap") {
      nv = `(i32.or (i32.shr_u ${v} (i32.const 4)) (i32.shl ${v} (i32.const 4)))`;
      c = "(i32.const 0)";
    } else {  // srl
      nv = `(i32.shr_u ${v} (i32.const 1))`;
      c = `(i32.and ${v} (i32.const 1))`;
    }
    return [seq([
      `(global.set $tmp2 ${cur})`,
      `(global.set $tmp ${nv})`,
      `(global.set $tmp3 ${c})`,
      setf({ z: zof("(global.get $tmp)"), n: 0, h: 0, c: "(global.get $tmp3)" }),
      rmwStore(t, "(global.get $tmp)")]), null];
  }

  if ((m === "bit" || m === "set" || m === "res") && o.length === 2 && isNum(o[0])) {
    const n = num(o[0]) & 7;
    const t = o[1];
    const cur = load8(t);
    if (m === "bit") {
      return [setf({ z: `(i32.eqz (i32.and ${cur} (i32.const ${1 << n})))`, n: 0, h: 1 }), null];
    }
    if (m === "set") return [rmwStore(t, `(i32.or ${cur} (i32.const ${1 << n}))`), null];
    return [rmwStore(t, `(i32.and ${cur} (i32.const ${(~(1 << n)) & 0xFF}))`), null];
  }

  throw new Unsupported(`${mnem} ${ops}`);
}
