// The Z80 interpreter of the SMS / Game Gear WAT backend: runs any
// instruction whose pc has no compiled arm (code the game writes into RAM,
// RAM code whose bytes changed since it was compiled, a slot paged to a bank
// its arms were not compiled for). No discovery run and no per-game option is
// needed for that code to run exactly.
//
// The interpreter is not a second Z80. Each of its arms is the COMPILED arm
// for one encoding, abstracted over the instruction's address and operand
// bytes:
//
//   1. For every encoding key (opcode, CB xx, ED xx, DD xx, FD xx, DD CB d xx,
//      FD CB d xx: 1792 keys) sample instructions with random operand bytes
//      at random addresses are decoded by the same Z80 IR decode the ROM arms
//      come from, and lowered by the same Emitter.body() (z80.js lower(),
//      cycles.js costExact(), the R-register, IN/OUT timing and flow code).
//   2. The arm texts of one key must be identical except for (i32.const N)
//      operands. Each varying constant is fitted to ONE expression over the
//      runtime values: the address A, the three bytes after the opcode
//      B1..B3, the words they form and the signed displacements (jr targets
//      are A + len + d, ld (ix+d),n is d and B3, jp nn is B1 | B2 << 8, ...).
//   3. Every fitted template is then instantiated on further random and edge
//      samples (operands $00/$7F/$80/$FF, addresses that wrap at $FFFF) and
//      must reproduce the directly lowered arm exactly; a key with no exact
//      template fails the build instead of guessing.
//
// So an interpreted instruction is, by construction, the arm the backend
// would have compiled for those bytes at that address.
//
// Plain JS ESM + JSDoc.

/** Encoding keys: 0-255 main, 256 + op CB, 512 + op ED, 768 + op DD, 1024 + op DD CB, 1280 + op FD, 1536 + op FD CB. */
export const NKEYS = 1792;

/**
 * The first bytes of an instruction with encoding `key` (operand bytes left
 * for the caller to fill): [prefix bytes, position of the fixed opcode byte
 * after a displacement (DD CB d op) or -1].
 * @param {number} key
 * @returns {number[]} four bytes, null where an operand byte goes
 */
function keyBytes(key) {
  const op = key & 0xFF;
  switch (key >> 8) {
    case 0: return [op, null, null, null];
    case 1: return [0xCB, op, null, null];
    case 2: return [0xED, op, null, null];
    case 3: return [0xDD, op, null, null];
    case 4: return [0xDD, 0xCB, null, op];
    case 5: return [0xFD, op, null, null];
    default: return [0xFD, 0xCB, null, op];
  }
}

/** Keys whose leading bytes would be read as a different key (main CB/ED/DD/FD, DD CB / FD CB as DD/FD keys). */
function keyAliased(key) {
  const op = key & 0xFF, hi = key >> 8;
  if (hi === 0) return op === 0xCB || op === 0xED || op === 0xDD || op === 0xFD;
  if (hi === 3 || hi === 5) return op === 0xCB;
  return false;
}

const sx8 = (v) => (v & 0x80 ? v - 0x100 : v);

/**
 * Candidate expressions for an operand-dependent constant: [name, value(s), wat].
 * s = {a, b1, b2, b3}.
 */
const CANDIDATES = (() => {
  const L = (n) => `(local.get $${n})`;
  const w12 = `(i32.or ${L("b1")} (i32.shl ${L("b2")} (i32.const 8)))`;
  const w23 = `(i32.or ${L("b2")} (i32.shl ${L("b3")} (i32.const 8)))`;
  const c = [
    ["b1", (s) => s.b1, L("b1")],
    ["b2", (s) => s.b2, L("b2")],
    ["b3", (s) => s.b3, L("b3")],
    ["w12", (s) => s.b1 | (s.b2 << 8), w12],
    ["w23", (s) => s.b2 | (s.b3 << 8), w23],
    ["w12+1", (s) => (s.b1 | (s.b2 << 8)) + 1, `(i32.add ${w12} (i32.const 1))`],
    ["w23+1", (s) => (s.b2 | (s.b3 << 8)) + 1, `(i32.add ${w23} (i32.const 1))`],
    ["w12+1&ffff", (s) => ((s.b1 | (s.b2 << 8)) + 1) & 0xFFFF, `(i32.and (i32.add ${w12} (i32.const 1)) (i32.const 0xFFFF))`],
    ["w23+1&ffff", (s) => ((s.b2 | (s.b3 << 8)) + 1) & 0xFFFF, `(i32.and (i32.add ${w23} (i32.const 1)) (i32.const 0xFFFF))`],
    ["b1+1&ff", (s) => (s.b1 + 1) & 0xFF, `(i32.and (i32.add ${L("b1")} (i32.const 1)) (i32.const 0xFF))`],
    ["b2+1&ff", (s) => (s.b2 + 1) & 0xFF, `(i32.and (i32.add ${L("b2")} (i32.const 1)) (i32.const 0xFF))`],
    ["sx1", (s) => sx8(s.b1), `(i32.extend8_s ${L("b1")})`],
    ["sx2", (s) => sx8(s.b2), `(i32.extend8_s ${L("b2")})`],
  ];
  for (let k = 0; k <= 4; k++) {
    c.push([`a+${k}`, (s) => (s.a + k) & 0xFFFF, k ? `(i32.and (i32.add ${L("ia")} (i32.const ${k})) (i32.const 0xFFFF))` : L("ia")]);
    c.push([`a+${k}+sx1`, (s) => (s.a + k + sx8(s.b1)) & 0xFFFF, `(i32.and (i32.add ${L("ia")} (i32.add (i32.const ${k}) (i32.extend8_s ${L("b1")}))) (i32.const 0xFFFF))`]);
  }
  return c;
})();

const CONST_RE = /\(i32\.const (-?(?:0x[0-9A-Fa-f]+|\d+))\)/g;

/** Split arm text into [literal segments], [constant values]. */
function tokens(text) {
  const segs = [], vals = [];
  let last = 0;
  for (const m of text.matchAll(CONST_RE)) {
    segs.push(text.slice(last, m.index));
    const s = m[1];
    vals.push(s.startsWith("-") ? -parseInt(s.slice(1)) : parseInt(s));
    last = m.index + m[0].length;
  }
  segs.push(text.slice(last));
  return { segs, vals };
}

/** A deterministic PRNG so a template build is reproducible. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}

/**
 * Build the interpreter templates.
 * @param {object} o
 * @param {(bytes: Uint8Array) => Promise<Map<number, [number, string]>>} o.decode  the ROM arms' instruction index over a 16KB image
 * @param {(addr: number, size: number, ins: Array<[number, number, string]>, byteAt: (k: number) => number) => string} o.body  the ROM arms' lowering of one instruction
 * @param {(img: Uint8Array, i: number) => number} o.length  the ROM arms' instruction length (block size)
 * @returns {Promise<{templates: Array<{segs: string[], exprs: string[], len: number}|null>, stats: object}>}
 */
export async function buildZ80Templates({ decode, body, length }) {
  const FIT = 8, CHECK = 12;
  const rand = rng(0x5A80C0DE);
  // samples per key: FIT random + CHECK random + 4 edge cases
  const EDGE = [[0x00, 0x00, 0x00, 0xFFFF], [0x7F, 0x7F, 0x7F, 0xFFFE], [0x80, 0x80, 0x80, 0x0000], [0xFF, 0xFF, 0xFF, 0xFFFD]];
  const samples = [];
  for (let key = 0; key < NKEYS; key++) {
    if (keyAliased(key)) continue;
    const kb = keyBytes(key);
    for (let i = 0; i < FIT + CHECK + EDGE.length; i++) {
      const e = i >= FIT + CHECK ? EDGE[i - FIT - CHECK] : null;
      const bytes = kb.map((b, j) => (b !== null ? b : e ? e[j - 1] : rand() & 0xFF));
      const a = e ? e[3] : rand() & 0xFFFF;
      // fitted on the random FIT samples plus the edges (which separate a byte
      // from its sign extension and a masked address from an unmasked one),
      // checked on the CHECK samples it never saw
      samples.push({ key, bytes, a, check: i >= FIT && !e });
    }
  }
  // decode: 4 bytes per sample, packed back to back in 16KB images (each
  // offset decodes independently; an instruction is at most 4 bytes)
  const PER = 0x4000 / 4 - 1;
  for (let c = 0; c * PER < samples.length; c++) {
    const img = new Uint8Array(0x4000);
    const part = samples.slice(c * PER, (c + 1) * PER);
    part.forEach((s, i) => img.set(s.bytes, i * 4));
    const idx = await decode(img);
    part.forEach((s, i) => {
      const ent = idx.get(i * 4);
      if (!ent) throw new Error(`z80 interpreter: no decode for ${s.bytes.map((b) => b.toString(16)).join(" ")}`);
      const bytes = Uint8Array.from(s.bytes);
      const size = length(bytes, 0);
      s.len = size;
      s.text = body(s.a, size, [[0, ent[0], ent[1]]], (k) => (k < 4 ? bytes[k] : 0));
    });
  }
  const templates = new Array(NKEYS).fill(null);
  const stats = { keys: 0, constantOnly: 0, fitted: 0, operands: {} };
  const byKey = new Map();
  for (const s of samples) {
    let v = byKey.get(s.key);
    if (!v) byKey.set(s.key, (v = []));
    v.push(s);
  }
  for (const [key, ss] of byKey) {
    const fit = ss.filter((s) => !s.check);
    const toks = fit.map((s) => tokens(s.text));
    const t0 = toks[0];
    for (const t of toks) {
      if (t.segs.length !== t0.segs.length || t.segs.some((x, i) => x !== t0.segs[i])) {
        throw new Error(`z80 interpreter: key ${key.toString(16)}: the lowered arm's structure depends on its operand bytes (${fit[0].text.slice(0, 200)} / ${fit[toks.indexOf(t)].text.slice(0, 200)})`);
      }
    }
    if (fit.some((s) => s.len !== fit[0].len)) throw new Error(`z80 interpreter: key ${key.toString(16)}: length depends on the operands`);
    const vals = fit.map((s) => ({ a: s.a, b1: s.bytes[1], b2: s.bytes[2], b3: s.bytes[3] }));
    const exprs = [];
    for (let i = 0; i < t0.vals.length; i++) {
      const col = toks.map((t) => t.vals[i]);
      if (col.every((v) => v === col[0])) { exprs.push(null); continue; }
      const cand = CANDIDATES.find(([, f]) => vals.every((s, j) => f(s) === col[j]));
      if (!cand) {
        throw new Error(`z80 interpreter: key ${key.toString(16)}: constant #${i} (${col.join(",")}) fits no operand expression in ${fit[0].text.slice(0, 300)}`);
      }
      exprs.push(cand);
      stats.operands[cand[0]] = (stats.operands[cand[0]] || 0) + 1;
    }
    // check: every sample (fit, random and edge) is reproduced exactly
    for (const s of ss) {
      const t = tokens(s.text);
      const sv = { a: s.a, b1: s.bytes[1], b2: s.bytes[2], b3: s.bytes[3] };
      const ok = t.segs.length === t0.segs.length && t.segs.every((x, i) => x === t0.segs[i]) && s.len === fit[0].len &&
        t.vals.every((v, i) => (exprs[i] ? exprs[i][1](sv) === v : t0.vals[i] === v));
      if (!ok) {
        const bad = t.vals.findIndex((v, i) => (exprs[i] ? exprs[i][1](sv) !== v : t0.vals[i] !== v));
        throw new Error(`z80 interpreter: key ${key.toString(16)}: the template does not reproduce the arm lowered for ${s.bytes.map((b) => b.toString(16)).join(" ")} at ${s.a.toString(16)} (constant #${bad}: ${exprs[bad] ? exprs[bad][0] : "fixed " + t0.vals[bad]} vs ${t.vals[bad]})`);
      }
    }
    let text = t0.segs[0];
    for (let i = 0; i < t0.vals.length; i++) {
      text += (exprs[i] ? exprs[i][2] : `(i32.const ${t0.vals[i]})`) + t0.segs[i + 1];
    }
    templates[key] = { text, len: fit[0].len };
    stats.keys++;
    if (exprs.every((e) => e === null)) stats.constantOnly++;
    else stats.fitted++;
  }
  return { templates, stats };
}

/**
 * The interpreter function: one instruction at $pc, through the template of
 * its encoding. Same contract as a dispatch shard: takes and returns the
 * line budget.
 * @param {Array<{text: string, len: number}|null>} templates
 * @param {string} trapWat  WAT for an encoding with no template (never, once built)
 */
export function z80InterpWat(templates) {
  const live = [];
  for (let k = 0; k < NKEYS; k++) if (templates[k]) live.push(k);
  const lines = [
    "  ;; the Z80 interpreter (interp.js): any pc with no compiled arm runs here,",
    "  ;; through the arm the backend compiles for that encoding, with the",
    "  ;; address and operand bytes read at run time",
    "  (func $z80_interp (param $budget i32) (result i32)",
    "    (local $t i32) (local $t2 i32) (local $cf i32) (local $ia i32) (local $b1 i32) (local $b2 i32) (local $b3 i32) (local $k i32)",
    "    (local.set $ia (i32.and (global.get $pc) (i32.const 0xFFFF)))",
    "    (local.set $k (call $rd8 (local.get $ia)))",
    "    (local.set $b1 (call $rd8 (i32.add (local.get $ia) (i32.const 1))))",
    "    (local.set $b2 (call $rd8 (i32.add (local.get $ia) (i32.const 2))))",
    "    (local.set $b3 (call $rd8 (i32.add (local.get $ia) (i32.const 3))))",
    "    ;; the encoding key (NKEYS); each test sees a value below 256 only before its own prefix is resolved",
    "    (if (i32.eq (local.get $k) (i32.const 0xCB)) (then (local.set $k (i32.add (i32.const 256) (local.get $b1)))))",
    "    (if (i32.eq (local.get $k) (i32.const 0xED)) (then (local.set $k (i32.add (i32.const 512) (local.get $b1)))))",
    "    (if (i32.eq (local.get $k) (i32.const 0xDD)) (then (local.set $k (i32.add (i32.const 768) (select (i32.add (i32.const 256) (local.get $b3)) (local.get $b1) (i32.eq (local.get $b1) (i32.const 0xCB)))))))",
    "    (if (i32.eq (local.get $k) (i32.const 0xFD)) (then (local.set $k (i32.add (i32.const 1280) (select (i32.add (i32.const 256) (local.get $b3)) (local.get $b1) (i32.eq (local.get $b1) (i32.const 0xCB)))))))",
    "    (global.set $interps (i32.add (global.get $interps) (i32.const 1)))",
  ];
  for (let i = live.length - 1; i >= 0; i--) lines.push(`    (block $i${i}`);
  lines.push("    (block $idef");
  const sel = new Array(NKEYS).fill("$idef");
  live.forEach((k, i) => { sel[k] = `$i${i}`; });
  lines.push("      (br_table " + sel.join(" ") + " $idef (local.get $k)))");
  lines.push("    (call $trap) (return (local.get $budget))");
  live.forEach((k, i) => {
    lines.push(`    ) ;; key ${k.toString(16)}`);
    lines.push(templates[k].text);
    lines.push("    (return (local.get $budget))");
  });
  lines.push("    (local.get $budget))");
  return lines.join("\n") + "\n";
}

let memo = null;

/**
 * The templates, built once per process (they depend only on the lowering).
 * @param {Parameters<typeof buildZ80Templates>[0]} o
 */
export function z80Templates(o) {
  if (!memo) memo = buildZ80Templates(o).catch((e) => { memo = null; throw e; });
  return memo;
}
