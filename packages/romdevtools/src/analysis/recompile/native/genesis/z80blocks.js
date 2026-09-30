// The Mega Drive's Z80 sound driver, recompiled to C for the sync32 runtime.
//
// A Genesis game uploads its Z80 driver into Z80 RAM once and then leaves it
// alone, so the code the Z80 runs is a fixed image per game. This takes that
// image (Z80 RAM as the exact wasmcart holds it after the coverage run),
// walks it statically from the reset and interrupt vectors, and emits one C
// function per entry point that runs the instructions in a straight line
// through gpgx's own z80.c opcode functions (the file is #included into
// z80.c, so every op_xx inlines): no opcode fetch, no dispatch switch, loops
// inside a function become gotos.
//
// Exactness: a function runs only while the interpreter would run the same
// instructions:
//   - it is entered only with no interrupt pending-and-enabled; EI, DI,
//     RETI/RETN and HALT end a function, so none can become pending inside;
//   - before every instruction it checks the cycle target, as z80_run's loop
//     condition does, and returns with PC on that instruction;
//   - per instruction it does what ROP() + EXEC do: R++, PC past the opcode,
//     z80_last_fetch, the cycle table charge; operands are still read from
//     Z80 RAM by the op functions;
//   - the code bytes are checked against the image before a function first
//     runs and again whenever a write has touched a compiled byte (a 1 KB
//     bitmap in flash, a generation counter bumped by the Z80 RAM writers);
//     a mismatch sends that entry back to the interpreter;
//   - DJNZ $ keeps the interpreter's arithmetic fast-forward (same code), and
//     the LD A,(HL) / OR A / JP cc,$ polling idiom is left to the interpreter
//     (its fast-forward is there).
//
// Plain JS ESM + JSDoc.

const hex4 = (v) => v.toString(16).padStart(4, "0");
const hex2 = (v) => "0x" + v.toString(16).padStart(2, "0");

// unprefixed opcode lengths
const LEN2 = new Set([0x06, 0x0e, 0x16, 0x1e, 0x26, 0x2e, 0x36, 0x3e, 0xc6, 0xce, 0xd6, 0xde, 0xe6, 0xee, 0xf6, 0xfe, 0xd3, 0xdb, 0x10, 0x18, 0x20, 0x28, 0x30, 0x38]);
const LEN3 = new Set([0x01, 0x11, 0x21, 0x31, 0x22, 0x2a, 0x32, 0x3a, 0xc2, 0xc3, 0xca, 0xd2, 0xda, 0xe2, 0xea, 0xf2, 0xfa, 0xc4, 0xcc, 0xcd, 0xd4, 0xdc, 0xe4, 0xec, 0xf4, 0xfc]);
// ops whose (HL) operand becomes (IX+d) under DD/FD
const HLMEM = new Set([0x34, 0x35, 0x36, 0x46, 0x4e, 0x56, 0x5e, 0x66, 0x6e, 0x7e, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x77, 0x86, 0x8e, 0x96, 0x9e, 0xa6, 0xae, 0xb6, 0xbe]);
const ED4 = new Set([0x43, 0x4b, 0x53, 0x5b, 0x63, 0x6b, 0x73, 0x7b]);
const RETN = new Set([0x45, 0x4d, 0x55, 0x5d, 0x65, 0x6d, 0x75, 0x7d]);
const JPCC = new Set([0xc2, 0xca, 0xd2, 0xda, 0xe2, 0xea, 0xf2, 0xfa]);
const CALLCC = new Set([0xc4, 0xcc, 0xd4, 0xdc, 0xe4, 0xec, 0xf4, 0xfc]);
const RETCC = new Set([0xc0, 0xc8, 0xd0, 0xd8, 0xe0, 0xe8, 0xf0, 0xf8]);
const RST = new Set([0xc7, 0xcf, 0xd7, 0xdf, 0xe7, 0xef, 0xf7, 0xff]);
const JRCC = new Set([0x20, 0x28, 0x30, 0x38]);

/**
 * Decode one instruction.
 * @returns {{pc:number, len:number, bytes:number[], prefix:number|null, op:number,
 *   kind:'plain'|'cond'|'jump'|'call'|'ret'|'end'|'djnz$'|'idle', targets:number[]}|null}
 */
export function decodeZ80(img, pc) {
  const b = (i) => img[(pc + i) & 0x1fff];
  const op0 = b(0);
  let len, prefix = null, op = op0, kind = "plain";
  const targets = [];
  if (op0 === 0xcb) { len = 2; prefix = 0xcb; op = b(1); }
  else if (op0 === 0xed) {
    prefix = 0xed; op = b(1); len = ED4.has(op) ? 4 : 2;
    if (RETN.has(op)) kind = "end";
    else if ([0xb0, 0xb1, 0xb2, 0xb3, 0xb8, 0xb9, 0xba, 0xbb].includes(op)) { kind = "cond"; targets.push(pc); }
  } else if (op0 === 0xdd || op0 === 0xfd) {
    prefix = op0; op = b(1);
    if (op === 0xdd || op === 0xfd || op === 0xed) return null; // prefix chains: the interpreter
    if (op === 0xcb) len = 4;
    else {
      len = 1 + (LEN3.has(op) ? 3 : LEN2.has(op) ? 2 : 1) + (HLMEM.has(op) ? 1 : 0);
      if (op === 0xe9) kind = "jump";
      else if (op === 0x76 || op === 0xfb || op === 0xf3) kind = "end";
      else if (op === 0xc3 || op === 0x18 || op === 0xcd || op === 0xc9 || RST.has(op) || JPCC.has(op) || JRCC.has(op) || op === 0x10 || CALLCC.has(op) || RETCC.has(op)) return null; // DD-prefixed control flow: rare, interpreter
    }
  } else {
    len = LEN3.has(op0) ? 3 : LEN2.has(op0) ? 2 : 1;
    const a16 = () => b(1) | (b(2) << 8);
    const rel = () => (pc + 2 + ((b(1) << 24) >> 24)) & 0xffff;
    if (op0 === 0xc3) { kind = "jump"; targets.push(a16()); }
    else if (op0 === 0x18) { kind = "jump"; targets.push(rel()); }
    else if (JPCC.has(op0)) { kind = "cond"; targets.push(a16()); }
    else if (JRCC.has(op0)) { kind = "cond"; targets.push(rel()); }
    else if (op0 === 0x10) { kind = b(1) === 0xfe ? "djnz$" : "cond"; targets.push(rel()); }
    else if (op0 === 0xcd) { kind = "call"; targets.push(a16()); }
    else if (CALLCC.has(op0)) { kind = "cond"; targets.push(a16()); }
    else if (RST.has(op0)) { kind = "call"; targets.push(op0 & 0x38); }
    else if (op0 === 0xc9 || op0 === 0xe9) kind = "jump";
    else if (RETCC.has(op0)) kind = "cond";
    else if (op0 === 0x76 || op0 === 0xfb || op0 === 0xf3) kind = "end";
    else if (op0 === 0x7e && b(1) === 0xb7 && [0xf2, 0xfa, 0xca, 0xc2].includes(b(2)) && (b(3) | (b(4) << 8)) === pc) kind = "idle";
  }
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(b(i));
  return { pc, len, bytes, prefix, op, kind, targets };
}

/**
 * Walk the driver from its vectors (plus `extraEntries`), collecting every
 * reachable instruction start and the entry points (leaders).
 */
export function walkZ80(img, extraEntries = []) {
  const insns = new Map();
  const leaders = new Set([0x0000, 0x0038, 0x0066, ...extraEntries]);
  const work = [...leaders];
  while (work.length) {
    let pc = work.pop() & 0xffff;
    while (pc < 0x2000 && !insns.has(pc)) {
      const d = decodeZ80(img, pc);
      if (!d) break;
      insns.set(pc, d);
      for (const t of d.targets) if (t < 0x2000 && t !== pc) { leaders.add(t); work.push(t); }
      const next = (pc + d.len) & 0xffff;
      if (d.kind === "call") { leaders.add(next); work.push(next); break; }
      if (d.kind === "jump" || d.kind === "end") break;
      if (d.kind === "idle") { const after = (pc + 5) & 0xffff; leaders.add(after); work.push(after); break; }
      pc = next;
    }
  }
  return { insns, leaders: [...leaders].filter((p) => insns.has(p)).sort((a, b) => a - b) };
}

const PFX = { 0xcb: ["cb", "cc_cb"], 0xed: ["ed", "cc_ed"], 0xdd: ["dd", "cc_xy"], 0xfd: ["fd", "cc_xy"] };
/** R increments an instruction makes (one per opcode fetch, ROP). */
const rIncs = (d) => (d.prefix == null ? 1 : 2);
/** Does the op read PC (operands via ARG, branches, pushes, HALT, block repeats)? */
const needsPc = (d) => d.kind !== "plain" || d.len > (d.prefix == null ? 1 : 2);
/** Does the op read or write R itself (LD A,R / LD R,A)? */
const touchesR = (d) => d.prefix === 0xed && (d.op === 0x5f || d.op === 0x4f);

/**
 * C for one instruction. R is kept lazily: the increments since the last
 * write are a compile-time count (pend), written back on every way out and
 * before an op that uses R; PC is written only before an op that reads it
 * and on the way out.
 * @param {object} d  decoded instruction
 * @param {number} pend  R increments pending at its start
 * @param {Map<number,number>} kAt  pending count at each label of the function
 */
function emitInsn(d, pend, kAt) {
  const pc = d.pc, next = (pc + d.len) & 0xffff;
  const L = [];
  const radd = (k) => (k ? `R += ${k}; ` : "");
  L.push(`  if (Z80.cycles >= cyc) { ${radd(pend)}PCD = 0x${hex4(pc)}; return 1; }`);
  if (d.kind === "djnz$") L.push(`  if (rd_z80_ff_djnz(cyc)) goto L_${hex4(pc)};`);
  const n = rIncs(d);
  let after = pend + n;
  const pre = [];
  if (touchesR(d)) { pre.push(radd(pend + n).trim()); after = 0; }
  if (needsPc(d)) pre.push(`PCD = 0x${hex4((pc + (d.prefix == null ? 1 : 2)) & 0xffff)};`);
  const opn = (x) => x.toString(16).padStart(2, "0");
  if (d.prefix == null) pre.push(`Z80.cycles += cc_op[${hex2(d.op)}]; op_${opn(d.op)}();`);
  else { const [p, tab] = PFX[d.prefix]; pre.push(`Z80.cycles += cc_op[${hex2(d.prefix)}] + ${tab}[${hex2(d.op)}]; ${p}_${opn(d.op)}();`); }
  L.push("  " + pre.filter(Boolean).join(" "));
  const jump = () => {
    const cases = [...kAt].map(([t, k]) => `case 0x${hex4(t)}: ${k ? `R -= ${k}; ` : ""}goto L_${hex4(t)};`).join(" ");
    return `${radd(after)}switch (PCD) { ${cases} default: return 1; }`;
  };
  if (d.kind === "cond" || d.kind === "djnz$") L.push(`  if (PCD != 0x${hex4(next)}) { ${jump()} }`);
  else if (d.kind === "jump" || d.kind === "call") { L.push(`  ${jump()}`); after = null; }
  else if (d.kind === "end") { L.push(`  ${radd(after)}${needsPc(d) ? "" : `PCD = 0x${hex4(next)}; `}return 1;`); after = null; }
  return { code: L.join("\n"), after };
}

/**
 * The C include for z80.c and its stats.
 * @param {Uint8Array} img  Z80 RAM (8 KB) with the driver in it
 * @param {{maxInsns?:number}} [o]
 */
export function emitZ80Blocks(img, o = {}) {
  if (!(img instanceof Uint8Array) || img.length < 0x2000) throw new Error("z80 blocks: need the 8 KB Z80 RAM image");
  const maxInsns = o.maxInsns ?? 160;
  const { insns, leaders } = walkZ80(img, o.entries ?? []);
  const fns = [];
  const codeMap = new Uint8Array(0x2000 / 8);
  for (const start of leaders) {
    // linear run from the leader
    const run = [];
    let pc = start;
    while (run.length < maxInsns) {
      const d = insns.get(pc);
      if (!d) break;
      if (d.kind === "idle") break;
      run.push(d);
      if (d.kind === "jump" || d.kind === "call" || d.kind === "end") break;
      pc = (pc + d.len) & 0xffff;
    }
    if (!run.length) continue;
    const inRun = new Set(run.map((d) => d.pc));
    const labels = [...new Set(run.flatMap((d) => d.targets).filter((t) => inRun.has(t)).concat([start]))].sort((a, b) => a - b);
    const lo = run[0].pc, last = run[run.length - 1], hi = last.pc + last.len;
    for (let a = lo; a < hi; a++) codeMap[a >> 3] |= 1 << (a & 7);
    fns.push({ start, run, labels, lo, hi, entries: [start] });
  }
  // pc -> function index + 1 (0 = none), for the whole 8 KB
  const tab = new Uint8Array(0x2000);
  if (fns.length > 255) throw new Error("z80 blocks: more than 255 entry points");
  // every compiled instruction is an entry: the function that starts there,
  // else the first one whose run holds it
  fns.forEach((f, i) => { tab[f.start] = i + 1; });
  fns.forEach((f, i) => { for (const d of f.run) if (!tab[d.pc]) { tab[d.pc] = i + 1; f.entries.push(d.pc); } });
  const out = [];
  out.push("/* Generated by romdev (native/genesis/z80blocks.js): the game's Z80 driver");
  out.push("   recompiled per entry point through gpgx opcode functions. Included");
  out.push("   at the end of z80.c. Derived from Genesis Plus GX (non-commercial). */");
  out.push("");
  out.push("const unsigned char rd_z80_codemap[1024] = {" + Array.from(codeMap).join(",") + "};");
  out.push("unsigned int rd_zgen = 1;");
  out.push("#ifdef Z80_OVERCLOCK_SHIFT\n#error the recompiled Z80 driver charges cc_* cycles directly\n#endif");
  out.push("");
  for (let k = 0; k < fns.length; k++) {
    const f = fns[k];
    const bytes = Array.from(img.subarray(f.lo, f.hi));
    out.push(`static const unsigned char rdz_img_${hex4(f.start)}[${bytes.length}] = {${bytes.join(",")}};`);
    out.push(`static unsigned int rdz_gen_${hex4(f.start)};`);
    out.push(`static int rdz_${hex4(f.start)}(unsigned int cyc)`);
    out.push("{");
    out.push(`  if (rdz_gen_${hex4(f.start)} != rd_zgen) { if (memcmp(&zram[0x${hex4(f.lo)}], rdz_img_${hex4(f.start)}, ${bytes.length})) return 0; rdz_gen_${hex4(f.start)} = rd_zgen; }`);
    // entered at any of its instructions: a Z80 slice (one scanline) often ends mid-loop
    if (f.entries.length > 1) { let k = 0; const kk = new Map(); for (const d of f.run) { kk.set(d.pc, k); k = touchesR(d) ? 0 : k + rIncs(d); } out.push(`  switch (PCD) { ${f.entries.filter((p) => p !== f.start).map((p) => `case 0x${hex4(p)}: ${kk.get(p) ? `R -= ${kk.get(p)}; ` : ""}goto L_${hex4(p)};`).join(" ")} default: break; }`); }
    // R increments pending at each instruction (fallthrough order)
    const kOf = new Map();
    { let k = 0; for (const d of f.run) { kOf.set(d.pc, k); k = touchesR(d) ? 0 : k + rIncs(d); } }
    const kAt = new Map(f.labels.map((p) => [p, kOf.get(p)]));
    let lastAfter = 0;
    for (const d of f.run) {
      out.push(`L_${hex4(d.pc)}:`);
      const r = emitInsn(d, kOf.get(d.pc), kAt);
      out.push(r.code);
      lastAfter = r.after;
    }
    const last = f.run[f.run.length - 1];
    if (lastAfter != null) out.push(`  ${lastAfter ? `R += ${lastAfter}; ` : ""}PCD = 0x${hex4((last.pc + last.len) & 0xffff)}; return 1;`);
    out.push("}");
    out.push("");
  }
  // labels a function never jumps to are fine for C except as warnings
  out.push(`const unsigned short rd_z80_fn_pc[${Math.max(1, fns.length)}] = {${fns.map((f) => "0x" + hex4(f.start)).join(",") || "0xffff"}};`);
  out.push(`int (*const rd_z80_fn[${Math.max(1, fns.length)}])(unsigned int) = {${fns.map((f) => "rdz_" + hex4(f.start)).join(",") || "0"}};`);
  out.push(`const unsigned int rd_z80_fn_count = ${fns.length};`);
  out.push("const unsigned char rd_z80_fn_at[0x2000] = {" + Array.from(tab).join(",") + "};");
  const n = fns.reduce((s, f) => s + f.run.length, 0);
  return { source: out.join("\n") + "\n", stats: { entries: fns.length, instructions: insns.size, emittedInstructions: n, codeBytes: codeMap.reduce((s, v) => s + popcount(v), 0) } };
}

function popcount(v) { let c = 0; while (v) { c += v & 1; v >>= 1; } return c; }
