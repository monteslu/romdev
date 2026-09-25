// SuperFX (GSU) tests on tiny synthetic ROMs (never commercial ones). The
// expected states are snes9x's (romdev's pinned core: loadMedia + N frames,
// then system_ram, save_ram and FillRAM $3000-$32FF hashed), which
// frame({op:'verifyRecompile'}) also found byte-identical to these carts.
// The cart is compared N + 5 renders in: the wasmcart host's settle frame
// plus the reference's 5 settle frames against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe as describeRom, emitWat, emitWatString, recompileSection } from "./index.js";
import { assembleWat } from "../assemble.js";
import { burstLengths, bankTables, superfxSram, GSU_OFF, GSU_PAGES } from "./superfx.js";
import { MAPTAB } from "./layout.js";
import { MAP_TYPE } from "./memmap.js";

// ---------------------------------------------------------------- a GSU assembler
const R = (s) => { const m = /^r(\d+)$/.exec(s); if (!m) throw new Error(`reg ${s}`); return +m[1]; };
const ALT1 = 0x3d, ALT2 = 0x3e, ALT3 = 0x3f;
const BR = { bra: 5, bge: 6, blt: 7, bne: 8, beq: 9, bpl: 10, bmi: 11, bcc: 12, bcs: 13, bvc: 14, bvs: 15 };

/** Assemble [mnemonic, ...operands] lines ("label:" strings) at `org`. */
function gsuAsm(prog, org = 0x8000) {
  const labels = {};
  const pass = (emitLabels) => {
    const out = [];
    for (const ins of prog) {
      if (typeof ins === "string") { labels[ins.replace(/:$/, "")] = org + out.length; continue; }
      const [m, a, b] = ins;
      const n = (x) => (typeof x === "number" ? x : x in labels ? labels[x] : (emitLabels ? (() => { throw new Error(`label ${x}`); })() : 0));
      switch (m) {
        case "stop": out.push(0x00); break;
        case "nop": out.push(0x01); break;
        case "cache": out.push(0x02); break;
        case "lsr": out.push(0x03); break;
        case "hib": out.push(0xc0); break;
        case "sub": out.push(0x60 | R(a)); break;
        case "to": out.push(0x10 | R(a)); break;
        case "with": out.push(0x20 | R(a)); break;
        case "from": out.push(0xb0 | R(a)); break;
        case "stw": out.push(0x30 | R(a)); break;
        case "loop": out.push(0x3c); break;
        case "alt1": out.push(ALT1); break;
        case "plot": out.push(0x4c); break;
        case "rpix": out.push(ALT1, 0x4c); break;
        case "color": out.push(0x4e); break;
        case "cmode": out.push(ALT1, 0x4e); break;
        case "add": typeof a === "number" ? out.push(ALT2, 0x50 | a) : out.push(0x50 | R(a)); break;
        case "merge": out.push(0x70); break;
        case "link": out.push(0x90 | a); break;
        case "jmp": out.push(0x90 | R(a)); break;
        case "ljmp": out.push(ALT1, 0x90 | R(a)); break;
        case "ibt": out.push(0xa0 | R(a), b & 0xff); break;
        case "lms": out.push(ALT1, 0xa0 | R(a), (b >> 1) & 0xff); break;
        case "sms": out.push(ALT2, 0xa0 | R(a), (b >> 1) & 0xff); break;
        case "inc": out.push(0xd0 | R(a)); break;
        case "getc": out.push(0xdf); break;
        case "iwt": { const v = n(b); out.push(0xf0 | R(a), v & 0xff, (v >> 8) & 0xff); break; }
        case "lm": out.push(ALT1, 0xf0 | R(a), b & 0xff, (b >> 8) & 0xff); break;
        case "sm": out.push(ALT2, 0xf0 | R(a), b & 0xff, (b >> 8) & 0xff); break;
        case "db": out.push(...a); break;
        default: {
          if (!(m in BR)) throw new Error(`gsu asm: ${m}`);
          const d = n(a) - (org + out.length + 2);
          if (emitLabels && (d < -128 || d > 127)) throw new Error(`branch range ${m} ${a}`);
          out.push(BR[m], d & 0xff);
        }
      }
    }
    return out;
  };
  pass(false);
  return Uint8Array.from(pass(true));
}

/**
 * A SuperFX LoROM: 65816 `code` at $00:8000, GSU programs and data at file
 * offsets, the SuperFX header (map $20, ROM type $15 = GSU + RAM + battery,
 * $7FDA = $33 so $7FBD is the RAM size: 7 = 128KB).
 */
function superfxRom({ code, nmi = null, irq = null, banks = 4, blobs = [], ramSize = 7, chipset = 0x15 }) {
  const img = new Uint8Array(banks * 0x8000).fill(0x01);
  img.fill(0xea, 0, 0x8000);
  img.set(code, 0);
  for (const [off, bytes] of blobs) img.set(bytes, off);
  const h = 0x7fc0;
  const title = "SUPERFX SYNTH TEST   ";
  for (let i = 0; i < 21; i++) img[h + i] = title.charCodeAt(i);
  img[h + 0x15] = 0x20; img[h + 0x16] = chipset; img[h + 0x17] = 0x0a; img[h + 0x18] = 0x00;
  img[h + 0x19] = 0x01; img[h + 0x1a] = 0x33;
  img[0x7fbd] = ramSize;
  const vec = (off, a) => { img[off] = a & 0xff; img[off + 1] = a >> 8; };
  vec(0x7ffc, 0x8000); vec(0x7fea, nmi ?? 0x8000); vec(0x7fee, irq ?? 0x8000);
  let sum = 0;
  for (const b of img) sum = (sum + b) & 0xffff;
  img[h + 0x1c] = (sum ^ 0xffff) & 0xff; img[h + 0x1d] = (sum ^ 0xffff) >> 8;
  img[h + 0x1e] = sum & 0xff; img[h + 0x1f] = sum >> 8;
  return img;
}

/** xorshift32 over a seed, as the ROM generators draw from it. */
const rng = (seed) => {
  let s = seed >>> 0 || 1;
  return (k) => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s % k; };
};
const ROM_DEFAULT = 0x9000;
/** The S-CPU's setup: native mode, 8-bit A / 16-bit X, $0010/$0020 cleared. */
const PRELUDE = [0x78, 0x18, 0xfb, 0xc2, 0x10, 0xe2, 0x20, 0xa2, 0x00, 0x00, 0x8e, 0x10, 0x00];
const sta = (v, lo, hi = 0x30) => [0xa9, v & 0xff, 0x8d, lo, hi];
/** NMI: $3000-$303F appended to $7E:2000 each frame (registers saved). */
const NMI_LOG = [
  0xc2, 0x30, 0x48, 0xda, 0x5a, 0xae, 0x10, 0x00, 0xa0, 0x00, 0x00,
  0xb9, 0x00, 0x30, 0x9f, 0x00, 0x20, 0x7e, 0xe8, 0xe8, 0xc8, 0xc8, 0xc0, 0x40, 0x00, 0xd0, 0xf0,
  0xe0, 0x00, 0x60, 0x90, 0x03, 0xa2, 0x00, 0x00, 0x8e, 0x10, 0x00, 0x7a, 0xfa, 0x68, 0xe2, 0x20, 0x40,
];
/** Opcodes the random streams leave out: STOP, branches, LOOP, JMP/LJMP, writes to R15. */
const FLOW = new Set([0x00, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x1f, 0x2f, 0x3c,
  0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0xaf, 0xff]);

/** t1: an endless counter loop; the NMI logs R0, R2 and SFR each frame. */
function romT1() {
  const code = [...PRELUDE, ...sta(0, 0x34), ...sta(0, 0x38), ...sta(0x19, 0x3a), ...sta(0x80, 0x37),
    0x9c, 0x39, 0x30, ...sta(0, 0x1e), ...sta(0x90, 0x1f), ...sta(0x80, 0x00, 0x42), 0x80, 0xfe];
  const nmi = [
    0xc2, 0x30, 0xae, 0x10, 0x00,
    0xad, 0x00, 0x30, 0x9f, 0x00, 0x20, 0x7e, 0xe8, 0xe8,
    0xad, 0x04, 0x30, 0x9f, 0x00, 0x20, 0x7e, 0xe8, 0xe8,
    0xad, 0x30, 0x30, 0x9f, 0x00, 0x20, 0x7e, 0xe8, 0xe8,
    0x8e, 0x10, 0x00, 0xe2, 0x20, 0x40,
  ];
  const gsu = gsuAsm([["iwt", "r1", 0x0100], "loop:", ["inc", "r0"], ["stw", "r1"], ["with", "r2"], ["add", "r0"], ["bra", "loop"], ["nop"]], ROM_DEFAULT);
  const c = new Uint8Array(0x200).fill(0xea); c.set(code, 0); c.set(nmi, 0x100);
  return superfxRom({ code: c, nmi: 0x8100, blobs: [[0x1000, gsu]] });
}

/**
 * t2: a seeded random stream of every non-flow opcode, each behind a random
 * register-select prefix (WITH / TO / FROM / MOVE) and ALT1-3 in either
 * order, looping forever (933 of the 1024 opcode-table entries).
 */
function romT2(seed, scmr, clsr) {
  const rnd = rng(seed);
  const bytes = [];
  for (let r = 0; r < 15; r++) bytes.push(0xf0 | r, rnd(256), rnd(256));
  const body = bytes.length;
  const reg = () => rnd(15);
  for (let i = 0; i < 3000; i++) {
    const sel = rnd(10), alt = rnd(4), pre = [];
    if (sel === 1) pre.push(0x20 | reg());
    else if (sel === 2) pre.push(0x10 | reg());
    else if (sel === 3) pre.push(0xb0 | rnd(16));
    else if (sel === 4) pre.push(0x20 | reg(), 0x10 | reg());
    if (alt) { if (rnd(2)) pre.push(0x3c + alt); else pre.unshift(0x3c + alt); }
    bytes.push(...pre);
    let op;
    do op = rnd(256); while (FLOW.has(op) || (op >= 0x10 && op <= 0x2f) || (op >= 0x3d && op <= 0x3f) || (op >= 0xb0 && op <= 0xbf && rnd(2)));
    bytes.push(op);
    if (op >= 0xa0 && op <= 0xaf) bytes.push(rnd(256));
    if (op >= 0xf0) bytes.push(rnd(256), rnd(256));
  }
  const tail = gsuAsm([["nop"], ["iwt", "r15", ROM_DEFAULT + body], ["nop"]], ROM_DEFAULT + bytes.length);
  const code = [...PRELUDE, ...sta(0, 0x34), ...sta(0x08, 0x38), ...sta(scmr, 0x3a), ...sta(0x80, 0x37), ...sta(clsr, 0x39),
    ...sta(0, 0x1e), ...sta(0x90, 0x1f), ...sta(0x80, 0x00, 0x42), 0x80, 0xfe];
  const nmi = [
    0xc2, 0x30, 0xae, 0x10, 0x00, 0xa0, 0x00, 0x00, 0xb9, 0x00, 0x30, 0x9f, 0x00, 0x20, 0x7e,
    0xe8, 0xe8, 0xc8, 0xc8, 0xc0, 0x40, 0x00, 0xd0, 0xf0, 0xe0, 0x00, 0x60, 0x90, 0x03, 0xa2, 0x00, 0x00,
    0x8e, 0x10, 0x00, 0xe2, 0x20, 0x40,
  ];
  const c = new Uint8Array(0x200).fill(0xea); c.set(code, 0); c.set(nmi, 0x100);
  const data = Uint8Array.from({ length: 0x8000 }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
  return superfxRom({ code: c, nmi: 0x8100, blobs: [[0x1000, Uint8Array.from([...bytes, ...tail])], [0x10000, data]] });
}

/**
 * t3: a seeded random STRUCTURED program: blocks of random units, each
 * ending in control flow (every branch, taken or not, JMP, LOOP, LINK +
 * LJMP to LoROM bank 1 / the HiROM view / GSU RAM and back through R11,
 * MOVE / IWT / LMS / LM to R15) with a random one-byte delay slot (ALT and
 * register-select prefixes included), then STOP with the IRQ unmasked. The
 * S-CPU waits in WAI and restarts the GSU from its IRQ handler, acknowledging
 * through $3031 and changing CLSR and the SCMR mode each time.
 */
function romT3(seed) {
  const rnd = rng(seed);
  const reg = () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 14][rnd(12)];
  const dst = (op) => {
    const n = op & 15;
    return ((op >= 0xa0 && op <= 0xae) || (op >= 0xf0 && op <= 0xfe) || (op >= 0xd0 && op <= 0xde) || (op >= 0xe0 && op <= 0xee)) && n >= 11 && n <= 13;
  };
  const unit = () => {
    const b = [];
    const sel = rnd(10), alt = rnd(4);
    if (sel === 1) b.push(0x20 | reg()); else if (sel === 2) b.push(0x10 | reg()); else if (sel === 3) b.push(0xb0 | rnd(16));
    if (alt) { if (rnd(2)) b.push(0x3c + alt); else b.unshift(0x3c + alt); }
    let op;
    do op = rnd(256); while (FLOW.has(op) || (op >= 0x10 && op <= 0x2f) || (op >= 0x3d && op <= 0x3f) || dst(op) || op === 0x91 || op === 0x92 || op === 0x93 || op === 0x94);
    b.push(op);
    if (op >= 0xa0 && op <= 0xaf) b.push(rnd(256));
    if (op >= 0xf0) b.push(rnd(256), rnd(256));
    return b;
  };
  const slot = () => {
    const o = [0x01, 0x03, 0x04, 0x3d, 0x3e, 0x3f, 0x4d, 0x4f, 0x95, 0x96, 0x97, 0x9e, 0xc0, 0x70, 0x50 | rnd(15), 0x60 | rnd(15), 0x80 | rnd(15), 0x20 | reg(), 0x10 | reg(), 0xb0 | rnd(16), 0xd0 | reg(), 0xe0 | reg()];
    return o[rnd(o.length)];
  };
  const N = 24;
  const prog = [["iwt", "r13", 0], ["iwt", "r12", 0]];
  const far = [], hi = [], ram = [];
  const units = (k) => { const o = []; for (let i = 0; i < k; i++) o.push(["db", unit()]); return o; };
  for (let i = 0; i < N; i++) {
    prog.push(`b${i}:`, ...units(3 + rnd(12)));
    const next = `b${i + 1}`, skip = i + 2 <= N ? `b${i + 2}` : next;
    const kind = rnd(10);
    if (kind <= 3) {
      const br = ["bra", "bge", "blt", "bne", "beq", "bpl", "bmi", "bcc", "bcs", "bvc", "bvs"][rnd(11)];
      prog.push([br, skip], ["db", [slot()]]);
    } else if (kind === 4) {
      const r = [8, 9, 10][rnd(3)];
      prog.push(["iwt", `r${r}`, next], ["jmp", `r${r}`], ["db", [slot()]]);
    } else if (kind === 5) {
      prog.push(["iwt", "r12", 1 + rnd(5)], ["iwt", "r13", `l${i}`], `l${i}:`, ...units(2), ["loop"], ["db", [slot()]]);
    } else if (kind === 6) {
      const where = rnd(3);
      const tgt = where === 0 ? far : where === 1 ? hi : ram;
      const bank = where === 0 ? 0x01 : where === 1 ? 0x41 : 0x70;
      const lbl = `f${i}`;
      tgt.push(lbl + ":", ...units(4), ["iwt", "r8", 0x00], ["from", "r11"], ["alt1"], ["ljmp", "r8"], ["db", [0x01]]);
      prog.push(["iwt", "r9", bank], ["iwt", "r1", lbl], ["link", 4], ["from", "r1"], ["alt1"], ["ljmp", "r9"], ["db", [0x01]]);
      prog.push(["nop"]);
    } else if (kind === 7) {
      prog.push(["iwt", "r3", next], ["with", "r3"], ["to", "r15"], ["db", [slot()]]);
    } else if (kind === 8) {
      const k2 = rnd(3);
      if (k2 === 0) prog.push(["iwt", "r15", next], ["db", [slot()]]);
      else if (k2 === 1) prog.push(["iwt", "r4", next], ["sms", "r4", 0x40], ["lms", "r15", 0x40], ["db", [slot()]]);
      else prog.push(["iwt", "r4", next], ["sm", "r4", 0x1234], ["lm", "r15", 0x1234], ["db", [slot()]]);
    } else {
      prog.push(["sms", "r15", 0x50], ["sm", "r15", 0x2222]);
    }
  }
  prog.push(`b${N}:`, ["stop"], ["nop"]);
  const lab = (arr, org) => { const L = {}; let a = org; for (const x of arr) { if (typeof x === "string") L[x.replace(":", "")] = a; else a += gsuAsm([x], a).length; } return L; };
  const farBytes = gsuAsm(far.length ? far : [["nop"]], 0x8000), hiBytes = gsuAsm(hi.length ? hi : [["nop"]], 0x2000), ramBytes = gsuAsm(ram.length ? ram : [["nop"]], 0x4000);
  const labels = { ...lab(far, 0x8000), ...lab(hi, 0x2000), ...lab(ram, 0x4000) };
  const main = gsuAsm(prog.map((x) => (Array.isArray(x) && x[0] === "iwt" && labels[x[2]] !== undefined ? ["iwt", x[1], labels[x[2]]] : x)), ROM_DEFAULT);
  const code = [...PRELUDE, 0x8e, 0x20, 0x00,
    // copy the RAM block: $01:C000 -> $70:4000, 1KB
    0xa2, 0x00, 0x00, 0xbf, 0x00, 0xc0, 0x01, 0x9f, 0x00, 0x40, 0x70, 0xe8, 0xe0, 0x00, 0x04, 0xd0, 0xf2,
    ...sta(0, 0x34), ...sta(0x10, 0x38), ...sta(0x19, 0x3a), ...sta(0, 0x37), 0x9c, 0x39, 0x30,
    ...sta(0, 0x1e), ...sta(0x90, 0x1f), ...sta(0x80, 0x00, 0x42), 0x58, 0xcb, 0x80, 0xfd];
  const irq = [
    0x48, 0xad, 0x31, 0x30, 0xee, 0x20, 0x00,
    0xad, 0x20, 0x00, 0x29, 0x01, 0x8d, 0x39, 0x30,
    0xad, 0x20, 0x00, 0x29, 0x03, 0x09, 0x18, 0x8d, 0x3a, 0x30,
    0xa9, 0x00, 0x8d, 0x1e, 0x30, 0xa9, 0x90, 0x8d, 0x1f, 0x30,
    0x68, 0x40,
  ];
  const c = new Uint8Array(0x200).fill(0xea); c.set(code, 0); c.set(NMI_LOG, 0x100); c.set(irq, 0x180);
  const data = Uint8Array.from({ length: 0x4000 }, (_, i) => (i * 13 + (i >> 7)) & 0xff);
  return superfxRom({ code: c, nmi: 0x8100, irq: 0x8180, banks: 8,
    blobs: [[0x1000, main], [0x8000, farBytes], [0xc000, ramBytes], [0x12000, hiBytes], [0x20000, data]] });
}

/**
 * t4: PLOT / RPIX / COLOR / GETC / CMODE / MERGE heavy random programs; on
 * each stop IRQ the S-CPU restarts the GSU with the next SCMR mode x height,
 * SCBR (bases past the 128KB RAM included, which snes9x clamps) and CLSR.
 */
function romT4(seed) {
  const rnd = rng(seed);
  const reg = () => [0, 3, 4, 5, 6, 7, 8, 9, 10, 14][rnd(10)];
  const prog = [];
  for (let i = 0; i < 700; i++) {
    const k = rnd(20);
    if (k < 6) prog.push(["plot"]);
    else if (k < 8) prog.push(["to", `r${reg()}`], ["rpix"], ["from", "r0"], ["stw", "r10"], ["inc", "r10"], ["inc", "r10"]);
    else if (k === 8) prog.push(["ibt", "r0", rnd(256)], ["cmode"]);
    else if (k === 9) prog.push(["ibt", "r0", rnd(256)], ["color"]);
    else if (k === 10) prog.push(["getc"]);
    else if (k === 11) prog.push(["iwt", "r14", rnd(65536)]);
    else if (k === 12) prog.push(["ibt", "r1", rnd(256)]);
    else if (k === 13) prog.push(["iwt", "r2", rnd(65536)]);
    else if (k === 14) prog.push(["inc", "r2"]);
    else if (k === 15) prog.push(["from", `r${reg()}`], ["color"]);
    else if (k === 16) prog.push(["iwt", "r7", rnd(65536)], ["iwt", "r8", rnd(65536)], ["merge"], ["color"]);
    else if (k === 17) prog.push(["ibt", "r1", rnd(256)], ["ibt", "r2", rnd(256)]);
    else if (k === 18) prog.push(["ibt", "r0", 0x10 | rnd(16)], ["cmode"]);
    else prog.push(["with", "r1"], ["add", rnd(16)]);
  }
  const gsu = gsuAsm([["iwt", "r10", 0xe000], ...prog, ["stop"], ["nop"]], ROM_DEFAULT);
  const code = [...PRELUDE, 0x8e, 0x20, 0x00, ...sta(0, 0x34), ...sta(0, 0x38), ...sta(0x18, 0x3a), ...sta(0, 0x37),
    0x9c, 0x39, 0x30, ...sta(0, 0x1e), ...sta(0x90, 0x1f), ...sta(0x80, 0x00, 0x42), 0x58, 0xcb, 0x80, 0xfd];
  const irq = [
    0x48, 0xda, 0xad, 0x31, 0x30, 0xee, 0x20, 0x00,
    0xad, 0x20, 0x00, 0x29, 0x07, 0x09, 0x18, 0x2c, 0x20, 0x00,
    0x48, 0xad, 0x20, 0x00, 0x29, 0x08, 0xf0, 0x04, 0x68, 0x09, 0x20, 0x48, 0x68,
    0x8d, 0x3a, 0x30,
    0xad, 0x20, 0x00, 0x4a, 0x4a, 0x4a, 0x4a, 0x29, 0x07, 0xaa, 0xbf, 0x00, 0x81, 0x00, 0x8d, 0x38, 0x30,
    0xad, 0x20, 0x00, 0x0a, 0xa9, 0x00, 0x2a, 0x8d, 0x39, 0x30,
    0xa9, 0x00, 0x8d, 0x1e, 0x30, 0xa9, 0x90, 0x8d, 0x1f, 0x30,
    0xfa, 0x68, 0x40,
  ];
  const c = new Uint8Array(0x200).fill(0xea);
  c.set(code, 0); c.set(NMI_LOG, 0x40); c.set(irq, 0x180); c.set([0x00, 0x08, 0x20, 0x3f, 0x60, 0x70, 0x7c, 0xff], 0x100);
  const data = Uint8Array.from({ length: 0x8000 }, (_, i) => (i * 29 + (i >> 5)) & 0xff);
  return superfxRom({ code: c, nmi: 0x8040, irq: 0x8180, banks: 4, blobs: [[0x1000, gsu], [0x8000, data]] });
}

/**
 * t5: directed edge values. DIV2 and ASR of -1, -2, 1, $8000, $7FFF, 0, -3
 * (snes9x's DIV2 makes -1 into 0 where ASR gives -1); registers past 16 bits
 * inside a burst (INC of $FFFF, ADD of the result to itself, SUB going
 * negative, then LSR / HIB of it); R15 running past $FFFF in LoROM bank 1
 * (the fetch wraps to $0000) with CACHE and LINK there, R11 and R15 stored.
 */
function romT5() {
  const div = [];
  let a = 0x0100;
  for (const v of [0xffff, 0xfffe, 0x0001, 0x8000, 0x7fff, 0x0000, 0xfffd]) {
    div.push(["iwt", "r0", v], ["alt1"], ["db", [0x96]], ["sm", "r0", a], ["iwt", "r0", v], ["db", [0x96]], ["sm", "r0", a + 2]);
    a += 4;
  }
  const main = gsuAsm([
    ...div,
    ["iwt", "r3", 0xffff], ["inc", "r3"], ["from", "r3"], ["sm", "r3", 0x0200], ["with", "r3"], ["add", "r3"], ["sm", "r3", 0x0202],
    ["iwt", "r4", 0x0001], ["iwt", "r5", 0x0003], ["from", "r4"], ["to", "r6"], ["sub", "r5"], ["sm", "r6", 0x0204],
    ["from", "r6"], ["to", "r7"], ["lsr"], ["sm", "r7", 0x0206], ["from", "r6"], ["to", "r8"], ["hib"], ["sm", "r8", 0x0208],
    ["iwt", "r9", 0x01], ["iwt", "r1", 0xfff8], ["from", "r1"], ["alt1"], ["ljmp", "r9"], ["nop"],
  ], ROM_DEFAULT);
  const top = gsuAsm([["nop"], ["nop"], ["nop"], ["nop"], ["nop"], ["nop"], ["nop"], ["nop"]], 0xfff8);
  const wrap = new Uint8Array(0x40).fill(0x01);
  wrap.set(gsuAsm([["cache"], ["link", 3], ["iwt", "r15", 0x0010], ["nop"]], 0), 0);
  wrap.set(gsuAsm([["sm", "r11", 0x020a], ["cache"], ["sm", "r15", 0x020c], ["iwt", "r0", 0x1234], ["sm", "r0", 0x020e],
    "spin:", ["inc", "r2"], ["bra", "spin"], ["nop"]], 0x10), 0x10);
  const code = [...PRELUDE, ...sta(0, 0x34), ...sta(0, 0x38), ...sta(0x19, 0x3a), ...sta(0x80, 0x37), 0x9c, 0x39, 0x30,
    ...sta(0, 0x1e), ...sta(0x90, 0x1f), ...sta(0x80, 0x00, 0x42), 0x80, 0xfe];
  const c = new Uint8Array(0x200).fill(0xea); c.set(code, 0); c.set(NMI_LOG, 0x100);
  return superfxRom({ code: c, nmi: 0x8100, blobs: [[0x1000, main], [0x8000, wrap], [0xfff8, top]] });
}

/** snes9x's state (16 hex digits of sha1: WRAM, GSU RAM, $3000-$32FF) at reference frames. */
const SNES9X = {
  t1: { 10: ["bb6dc42ac58815ef", "585482152da0d155", "00686f242bf52064"], 60: ["cc74b07ab00b9802", "7e736ddbbe9e207b", "7c6ae226716cb3f2"] },
  t2a: { 30: ["719d6d784af15ab1", "263b99b97af13e16", "d8163a1d1727bea7"], 90: ["58b97723ce219ed9", "28ed651f267afe97", "237e32a3f69b4480"] },
  t2b: { 30: ["902f48aa808c310e", "600d7830346d012c", "3240eab11b043684"], 90: ["37d83cded03383f5", "c638420ebdbb869f", "ad3fe26a7ac828b6"] },
  t2c: { 30: ["79013d0aa974756e", "d22708ba10158c3a", "995b4b238586f5cd"], 90: ["077aee64075af60f", "4c47f771290239bd", "0a20c332a75f5cd8"] },
  t2d: { 30: ["a8ddebba981a2677", "d795ac54bbc6c5c7", "ca654c41ce757145"], 90: ["7208d07b035155c4", "d496dc2e21d91753", "98ba763a866ee8bf"] },
  t3_1: { 30: ["fb287f67c8128a9e", "c634701fa38f1c57", "94c93fe0de0e7f4c"], 90: ["d2a9192971b62457", "c634701fa38f1c57", "94c93fe0de0e7f4c"] },
  t3_2: { 30: ["6e4ab2fe6a02cd91", "f310df738d2b69f5", "965d847ce0f4144d"], 90: ["d6ac5b7c4cbf04ab", "f310df738d2b69f5", "965d847ce0f4144d"] },
  t3_3: { 30: ["24cac5cd4b847a1b", "d4af28c01df5c7b0", "a44a62d8374a753d"], 90: ["c796cb0ada91f0c0", "d4af28c01df5c7b0", "a44a62d8374a753d"] },
  t3_4: { 30: ["463dad0e0135dbbd", "d1ec3fa63e130288", "d3b79895623a5d9d"], 90: ["988c64db2e10815d", "d1ec3fa63e130288", "d3b79895623a5d9d"] },
  t3_5: { 30: ["60822da0b15a6dbf", "028a790f45464f93", "760082956960e804"], 90: ["19373f1fb5548b66", "028a790f45464f93", "760082956960e804"] },
  t3_6: { 30: ["25c95c47da30cf2a", "ba5526a52a745eb4", "ec3baab32dfe6657"], 90: ["c13cd4423c324df3", "ba5526a52a745eb4", "006db1652a2eea56"] },
  t4_1: { 30: ["2c28a35295a9f2fc", "3e0ad6b7da03779a", "9a10379ddc2356d2"], 90: ["6d625b53bd6318b1", "3e0ad6b7da03779a", "9a10379ddc2356d2"] },
  t4_2: { 30: ["a6bc11652771cfb1", "f62af43340e19485", "0769dbc5364e733e"], 90: ["8e6709a1a2feeb67", "f62af43340e19485", "0769dbc5364e733e"] },
  t5: { 30: ["4c5b382346fe1080", "bd219c44247e30a4", "6dfdd6e20f745be3"], 90: ["841c43f6e639fdad", "bd219c44247e30a4", "e51ab2561c919d97"] },
  t4_3: { 30: ["455ed1a3e5dd29f7", "0d5763a698c94470", "53b72b5cdda522ff"], 90: ["2abf050bd390f545", "0d5763a698c94470", "53b72b5cdda522ff"] },
};

/** The cart's (WRAM, GSU RAM, $3000-$32FF) hashes at each reference frame. */
async function cartHashes(rom, frames) {
  // arms only for the S-CPU code: the GSU code and data are not 65816 code
  const opts = { armRanges: [[0, 0x200]] };
  const d = describeRom(rom, opts);
  const { bytes } = await assembleWat(emitWat(rom, opts));
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const ex = instance.exports;
  ex.wc_init();
  const h = (b) => createHash("sha1").update(b).digest("hex").slice(0, 16);
  const out = {};
  let n = 0;
  for (const f of frames) {
    while (n < f + 5) { ex.wc_render(); n++; }
    const m = new Uint8Array(ex.memory.buffer);
    out[f] = [h(m.subarray(0, 0x20000)), h(m.subarray(d.memory.SRAM, d.memory.SRAM + 0x20000)), h(m.subarray(d.memory.CHIP, d.memory.CHIP + 0x300))];
  }
  return { out, ex, d };
}

const ROMS = {
  t1: romT1,
  t2a: () => romT2(1, 0x18 | 1, 0), t2b: () => romT2(2, 0x18 | 3 | 0x04, 1),
  t2c: () => romT2(3, 0x18 | 0 | 0x20, 0), t2d: () => romT2(4, 0x18 | 3 | 0x24, 1),
  t3_1: () => romT3(1), t3_2: () => romT3(2), t3_3: () => romT3(3), t3_4: () => romT3(4), t3_5: () => romT3(5), t3_6: () => romT3(6),
  t4_1: () => romT4(1), t4_2: () => romT4(2), t4_3: () => romT4(3),
  t5: romT5,
};

// ---------------------------------------------------------------- tests

test("SuperFX carts load: Map_SuperFXLoROMMap board, the SRAM size rule, the chip block, the compared regions", () => {
  const rom = romT1();
  const d = describeRom(rom);
  assert.equal(d.supported, true, d.refusal);
  assert.equal(d.coprocessor, "SuperFX (GSU)");
  assert.equal(d.board, "SuperFXLoROM");
  // InitROM: ROM[$7FDA] == $33 -> SRAMSize = ROM[$7FBD] (7: 128KB), else 5
  assert.equal(d.sramSizeByte, 7);
  assert.equal(superfxSram(rom).bytes, 0x20000);
  const r2 = romT1(); r2[0x7fda] = 0x01;
  assert.equal(superfxSram(r2).sramSize, 5);
  assert.equal(d.memory.CHIP % 0x10000, 0);
  assert.ok(d.memory.pages >= d.memory.CHIP / 0x10000 + GSU_PAGES);
  const sec = recompileSection(rom).json;
  assert.deepEqual(sec.regions.gsureg, { offset: d.memory.CHIP + GSU_OFF.FXREG, length: 0x300, ref: "snes_fillram", refOffset: 0x3000 });
  assert.deepEqual(sec.regions.gsuram, { offset: d.memory.SRAM, length: 0x20000, ref: "save_ram" });
  assert.equal(sec.diagnosticRegions.sram, undefined, "the GSU RAM is compared, not diagnostic");
  // A HiROM-scored SuperFX image is not given the SuperFX map (snes9x takes it only for LoROM).
});

test("burst lengths are snes9x's speedPerLine (5823405 * (1/fps) / V_Max), 2.5x with CLSR", () => {
  assert.deepEqual(burstLengths(false), { speedPerLine: 370, slow: 370, fast: 925 });
  assert.deepEqual(burstLengths(true), { speedPerLine: 373, slow: 373, fast: 932 });
});

test("FxReset's bank tables: replicated LoROM halves below $40, HiROM banks mod nRomBanks, RAM at $70-$73", () => {
  const t = bankTables(0x1000000, 0x800000, 0x100000);   // a 1MB image: 32 banks of 32KB
  const view = 0x1000000 + GSU_OFF.ROMVIEW;
  assert.equal(t.nRomBanks, 32);
  assert.deepEqual([t.rom[0], t.rom[1]], [view, 0x7fff]);
  assert.deepEqual([t.rom[2 * 0x21], t.rom[2 * 0x21 + 1]], [view + 0x21 * 0x8000, 0x7fff]);
  assert.deepEqual([t.rom[2 * 0x41], t.rom[2 * 0x41 + 1]], [view + 0x10000, 0xffff]);
  assert.deepEqual([t.rom[2 * 0x60]], [view + 0]);          // $60 % 32 = 0
  assert.deepEqual([t.rom[2 * 0x71], t.rom[2 * 0x72]], [0x810000, 0x800000]);   // nRamBanks 2
  assert.deepEqual([...t.ram], [0x800000, 0x810000, 0x800000, 0x810000]);
  assert.equal(bankTables(0, 0, 0x400000).nRomBanks, 0x20, "FxReset caps nRomBanks at $20");
});

test("the S-CPU map: $3000-$3FFF is the chip's window, GSU RAM at $70/$71 and $6000-$7FFF, HiROM view at $40", async () => {
  const rom = romT1();
  const { ex, d } = await cartHashes(rom, []);
  const dv = new DataView(ex.memory.buffer);
  const blk = (bank, a) => [dv.getUint32(MAPTAB + (((bank << 4) | (a >> 12)) * 8), true), dv.getUint32(MAPTAB + (((bank << 4) | (a >> 12)) * 8) + 4, true)];
  assert.equal(blk(0x00, 0x3000)[0], MAP_TYPE.CHIP);
  assert.equal(blk(0x80, 0x3000)[0], MAP_TYPE.CHIP);
  assert.deepEqual(blk(0x70, 0x2000), [MAP_TYPE.RAM, d.memory.SRAM + 0x2000]);
  assert.deepEqual(blk(0x71, 0x0000), [MAP_TYPE.RAM, d.memory.SRAM + 0x10000]);
  assert.deepEqual(blk(0x00, 0x6000), [MAP_TYPE.RAM, d.memory.SRAM]);
  assert.deepEqual(blk(0xf1, 0x0000), [MAP_TYPE.RAM, d.memory.SRAM + 0x10000], "GSU-1 sized images also map $F0/$F1");
  assert.equal(blk(0x40, 0x8000)[0], MAP_TYPE.ROM);
});

test("the GSU runs in snes9x's per-line bursts: an endless counter loop logged at every NMI matches snes9x", async () => {
  const { out, ex } = await cartHashes(romT1(), [10, 60]);
  assert.deepEqual(out, SNES9X.t1);
  // 6 instructions per turn, 370 per line, 262 lines: R0 moves 16156 or 16157 a frame
  const log = new Uint16Array(ex.memory.buffer, 0x2000, 3 * 20);
  for (let i = 3; i + 3 < 60; i += 3) {
    const d = (log[i + 3] - log[i]) & 0xffff;
    assert.ok(d === 16156 || d === 16157, `R0 step ${d}`);
  }
});

test("random instruction streams (every non-flow opcode in every ALT state, WITH/TO/FROM/MOVE) match snes9x", async () => {
  for (const k of ["t2a", "t2b", "t2c", "t2d"]) {
    const { out } = await cartHashes(ROMS[k](), [30, 90]);
    assert.deepEqual(out, SNES9X[k], k);
  }
});

test("control flow: branches, delay slots, JMP, LJMP to other banks and GSU RAM, LOOP, LINK, R15 writes, STOP and the IRQ restart match snes9x", async () => {
  for (const k of ["t3_1", "t3_2", "t3_3", "t3_4", "t3_5", "t3_6"]) {
    const { out } = await cartHashes(ROMS[k](), [30, 90]);
    assert.deepEqual(out, SNES9X[k], k);
  }
});

test("PLOT / RPIX in every mode and height, CMODE options, COLOR / GETC / MERGE, SCBR clamping match snes9x", async () => {
  for (const k of ["t4_1", "t4_2", "t4_3"]) {
    const { out } = await cartHashes(ROMS[k](), [30, 90]);
    assert.deepEqual(out, SNES9X[k], k);
  }
});

test("edge values: DIV2 of -1 is 0 (ASR keeps -1), registers past 16 bits inside a burst, R15 past $FFFF with CACHE and LINK, as snes9x", async () => {
  const { out, ex, d } = await cartHashes(ROMS.t5(), [30, 90]);
  assert.deepEqual(out, SNES9X.t5);
  const ram = new Uint16Array(ex.memory.buffer, d.memory.SRAM + 0x100, 14);
  assert.deepEqual([ram[0], ram[1]], [0x0000, 0xffff], "DIV2 / ASR of -1");
  assert.deepEqual([ram[2], ram[3]], [0xffff, 0xffff], "DIV2 / ASR of -2");
  const hi = new Uint16Array(ex.memory.buffer, d.memory.SRAM + 0x200, 8);
  assert.deepEqual([...hi], [0x0000, 0x0000, 0xfffe, 0x7fff, 0x00ff, 0x0005, 0x0017, 0x1234]);
});

test("a plain cart carries no GSU and keeps its PPU window", async () => {
  const img = romT1();
  img[0x7fd6] = 0x02;   // ROM type 2: ROM + RAM + battery, no chip
  img[0x7fd5] = 0x20;
  const d = describeRom(img);
  assert.equal(d.coprocessor, null);
  assert.equal(d.memory.CHIP, undefined);
  const w = await emitWatString(img, { limit: 16 });
  assert.doesNotMatch(w, /\$fx_dispatch/);
});
