// SNES WAT backend: statically recompile a whole LoROM SNES cartridge into
// one WAT module (a wasmcart), ported from sms-wat's emit_snes.py.
//
// SHAPE. One dispatch ARM PER ROM FILE OFFSET (every byte, not just the ones
// a static walk reaches), 1024 arms per br_table shard, and a binary search
// over shards. A packed (offset, arm) table expands into PCTAB at wc_init;
// $step maps the 24-bit pc through the LoROM rule to a file offset and
// dispatches. PCs in WRAM ($7E/$7F, or below $8000) go to a small RAM
// interpreter that shares every register and memory routine with the arms.
//
// M/X WIDTH IS DECIDED AT RUNTIME. Only the nine immediate forms whose
// length depends on M or X are ambiguous statically, and each such arm is
// emitted with BOTH readings, selected on the live flag. No block map, no
// flag walk: a new ROM needs nothing but its bytes.
//
// RELATIVE BRANCH TARGETS are computed in file-offset space (where they are
// exact) and converted back through the instruction's own bank, since a
// relative branch cannot leave its bank.
//
// STREAMING. A 3MB ROM emits ~2.1GB of WAT text, so emitWat yields chunks
// (module prologue, one chunk per shard, data segments in pieces) and never
// builds the module as one string. The concatenation of the chunks is the
// module text, byte-identical to the Python emitter's output.
//
// Plain JS ESM + JSDoc.

import { decode, lower, oplen, isopTable, modeTable } from "./lower.js";
import {
  computeLayout, FB_W, FB_H, WRAM, VRAM, CGRAM, OAM, SRAMB, OPTAB, MODTAB, PROBE,
  PROBE_FIELDS, INPUT, ROM, PCRING, PCRING_N,
} from "./layout.js";
import { globalsWat, memWat, interpWat, interpTablesWat } from "./cpu-wat.js";
import { apuWat, ppuDataWat, ppuWat, renderWat } from "./ppu-wat.js";
import { regwatchWat, stepHeadWat, frameWat } from "./frame-wat.js";

/** Platform ids this backend accepts. */
export const platforms = ["snes"];

/** Arms per br_table shard. */
const SH = 1024;

/**
 * Ranges (16-bit ROM addresses, inclusive) the ROM pc ring never records:
 * tight boot loops that would fill it by themselves. These three are Super
 * Mario World's ($8034-$8048 the $7F8000 OAM-clear builder, $8079-$80E7 the
 * APU upload loop, $8A4E-$8A64 its RAM clear); `options.pcSkip` appends more.
 * Emitted into every cart so the output matches the Python emitter's.
 */
const PCRING_SKIP_DEFAULT = [[0x8034, 0x8048], [0x8079, 0x80e7], [0x8a4e, 0x8a64]];

// Coprocessor type by the chipset byte's high nibble (when the low nibble
// says a coprocessor is present).
const COPROCESSORS = {
  0x0: "DSP", 0x1: "SuperFX (GSU)", 0x2: "OBC1", 0x3: "SA-1", 0x4: "S-DD1",
  0x5: "S-RTC", 0xe: "Super Game Boy / Satellaview", 0xf: "custom (SPC7110 / ST01x / CX4)",
};

const MAPPINGS = { lorom: 0x7fc0, hirom: 0xffc0, exhirom: 0x40ffc0 };

/**
 * @typedef {object} SnesOptions
 * @property {number} [regwatchPc]  16-bit ROM address for the REGISTER WATCH probe (0/absent = off)
 * @property {Array<[number, number]>|string} [pcSkip]  extra pc-ring skip ranges, [[lo,hi],...] or "806B-806D,9A74-9A8A"
 * @property {number} [limit]  emit arms only for ROM offsets below this (tests / debugging)
 * @property {object} [stats]  filled with {arms, lowered, interpreted, dual, reasons}
 */

/** @param {Uint8Array} rom */
function toBytes(rom) {
  if (rom instanceof Uint8Array) return rom;
  if (ArrayBuffer.isView(rom)) return new Uint8Array(rom.buffer, rom.byteOffset, rom.byteLength);
  if (rom instanceof ArrayBuffer) return new Uint8Array(rom);
  throw new TypeError("snes: rom must be a Uint8Array/Buffer");
}

/** Score how plausible a header at `base` is (higher is better). */
function scoreHeader(img, base, mapping) {
  if (img.length < base + 0x40) return -1;
  let s = 0;
  const mapMode = img[base + 0x15];
  const want = { lorom: [0x20, 0x30, 0x23, 0x32], hirom: [0x21, 0x31, 0x35], exhirom: [0x25, 0x35] }[mapping];
  if (want.includes(mapMode)) s += 4;
  const ck = img[base + 0x1e] | (img[base + 0x1f] << 8);
  const cm = img[base + 0x1c] | (img[base + 0x1d] << 8);
  if (((ck + cm) & 0xffff) === 0xffff && ck !== 0 && cm !== 0) s += 4;
  const reset = img[base + 0x3c] | (img[base + 0x3d] << 8);
  if (reset >= 0x8000) s += 2;
  let printable = 0;
  for (let i = 0; i < 21; i++) { const c = img[base + i]; if (c >= 0x20 && c < 0x7f) printable++; }
  if (printable >= 18) s += 1;
  if (img[base + 0x17] >= 0x07 && img[base + 0x17] <= 0x0d) s += 1;   // ROM size byte
  return s;
}

/**
 * Header-derived configuration: mapping, copier header, sizes, SRAM mask,
 * coprocessor refusal, and the cart layout the verify op compares.
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 */
export function describe(rom, opts = {}) {
  const raw = toBytes(rom);
  // A copier .smc carries 512 bytes in front of the image; the test is the
  // file size, there is no magic number.
  const copierHeader = raw.length % 1024 === 512 ? 512 : 0;
  const img = raw.subarray(copierHeader);
  let best = null;
  for (const [mapping, base] of Object.entries(MAPPINGS)) {
    const sc = scoreHeader(img, base, mapping);
    if (sc >= 0 && (!best || sc > best.score)) best = { mapping, base, score: sc };
  }
  if (!best) best = { mapping: "lorom", base: 0x7fc0, score: 0 };
  const h = best.base;
  const byte = (o) => (img.length > h + o ? img[h + o] : 0);
  const title = Array.from(img.subarray(h, Math.min(img.length, h + 21)), (c) =>
    c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ").join("").trimEnd();
  const mapMode = byte(0x15);
  const chipset = byte(0x16);
  const sramByte = byte(0x18);
  // SRAM decodes only log2(size) address lines, so it MIRRORS through the
  // $70-$7D window; Super Metroid checks exactly that and shows its
  // anti-copier screen on a flat 32KB window. 0 (or nonsense) = no SRAM:
  // keep the 32KB scratch window rather than invent open-bus behaviour.
  // (The Python emitter reads the byte at $7FD8 whatever the mapping.)
  const sramLow = img.length > 0x7fd8 ? img[0x7fd8] : 0;
  const sramMask = sramLow === 0 || sramLow > 5 ? 0x7fff : (1024 << sramLow) - 1;
  const sramSize = sramByte === 0 || sramByte > 7 ? 0 : 1024 << sramByte;
  const hasCoproc = (chipset & 0x0f) >= 3;
  const coprocessor = hasCoproc ? (COPROCESSORS[chipset >> 4] ?? `unknown (chipset $${chipset.toString(16)})`) : null;
  const reset = img.length > 0x7ffd ? img[0x7ffc] | (img[0x7ffd] << 8) : 0;

  let refusal = null;
  if (img.length < 0x8000) refusal = `ROM image is ${img.length} bytes; a LoROM cart needs at least one 32KB bank`;
  else if (coprocessor) refusal = `cart uses the ${coprocessor} coprocessor (chipset byte $${chipset.toString(16).padStart(2, "0")}); the SNES recompiler models the base console only`;
  else if (best.mapping !== "lorom") refusal = `cart is ${best.mapping === "hirom" ? "HiROM" : "ExHiROM"} (map mode $${mapMode.toString(16)}); the SNES recompiler implements the LoROM memory map only`;

  const layout = computeLayout(img.length, sramMask, Math.max(1, opts.limit ? Math.min(opts.limit, img.length) : img.length));
  return {
    platform: "snes",
    referenceCore: "snes9x",
    supported: !refusal,
    refusal,
    title,
    mapping: best.mapping,
    headerOffset: h,
    fastRom: (mapMode & 0x10) !== 0,
    mapMode,
    chipset,
    coprocessor,
    romSize: img.length,
    copierHeader,
    sramSize,
    sramMask,
    region: byte(0x19),
    resetVector: reset,
    layout: cartLayout(layout, sramSize),
    memory: layout,
    conventions,
  };
}

/** loadMedia platform id of the reference core. */
export const REFERENCE_CORE = "snes9x";

/**
 * Frame / input conventions the verify op needs. The cart does not model
 * the APU's timing, so it boots ahead of snes9x by a game-dependent number
 * of frames (Super Mario World 56, Zelda LTTP 82, Super Metroid 39-41 at
 * the verified pairs): the reference frame is SEARCHED over a window, never
 * assumed. The controller ports read "nothing pressed" (the cart ignores
 * wasmcart pad input), so verification runs are input-free.
 */
export const conventions = {
  frameAxis: "total",
  settleFrames: { cart: 1, reference: 5 },
  frameAlignment: { mode: "search", window: [0, 120] },
  warmupFrames: 0,
  input: false,
};

/**
 * The region map + probe fields the verify op reads (the cart's
 * `romdev.recompile` custom section carries it).
 * @param {import("./layout.js").SnesLayout} lay
 * @param {number} sramSize
 */
function cartLayout(lay, sramSize) {
  const regions = {
    wram: { offset: WRAM, length: 0x20000, ref: "system_ram" },
    vram: { offset: VRAM, length: 0x10000, ref: "video_ram" },
    cgram: { offset: CGRAM, length: 0x200, ref: "snes_cgram" },
    oam: { offset: OAM, length: 0x220, ref: "snes_oam" },
  };
  if (sramSize) regions.sram = { offset: SRAMB, length: Math.min(sramSize, 0x8000), ref: "save_ram" };
  return {
    regions,
    // ARAM holds what the IPL boot protocol uploaded. No SPC700 runs the
    // driver, so once it starts snes9x's ARAM moves on and this does not:
    // diagnostic, not a pass/fail region.
    diagnosticRegions: {
      aram: { offset: lay.ARAM, length: 0x10000, ref: "snes_aram" },
    },
    probe: {
      offset: PROBE,
      fields: Object.fromEntries(Object.entries(PROBE_FIELDS).map(([k, o]) => [k, { offset: PROBE + o, size: 4 }])),
    },
    trap: { flag: "trapped", pc: "trappc" },
    pcRing: { offset: PCRING, entries: PCRING_N, stride: 4, cursorField: "npc", format: "u32 pc24, circular" },
    framebuffer: { offset: lay.FB, width: FB_W, height: FB_H, format: "bgra8888", note: "u32 words 0xAARRGGBB" },
    input: { offset: INPUT, length: 64 },
  };
}

/**
 * The `romdev.recompile` custom section (schema in ../../recompile-section.js).
 * @param {Uint8Array} rom
 * @param {string} [sha1]  sha1 of the ROM file (hex), if the caller has it
 * @param {SnesOptions} [opts]
 */
export function recompileSection(rom, sha1, opts = {}) {
  const d = describe(rom, opts);
  const L = d.layout;
  return {
    name: "romdev.recompile",
    json: {
      version: 1,
      platform: "snes",
      reference: "snes",
      referenceCore: REFERENCE_CORE,
      romSha1: sha1 || null,
      mapping: d.mapping,
      warmupFrames: 0,
      regions: L.regions,
      diagnosticRegions: L.diagnosticRegions,
      probe: L.probe.fields,
      trap: L.trap,
      pcRing: L.pcRing,
      framebuffer: L.framebuffer,
      vramZero: ["vram"],
      conventions,
    },
  };
}

/** ROM offset -> [bank, 16-bit address] under the LoROM map. */
const loromAddr = (off) => [off >> 15, 0x8000 + (off & 0x7fff)];

const HEXESC = Array.from({ length: 256 }, (_, i) => "\\" + i.toString(16).padStart(2, "0"));

/**
 * Yield a WAT string literal's escaped bytes in pieces.
 * @param {Uint8Array} bytes
 */
function* escChunks(bytes, piece = 1 << 20) {
  for (let i = 0; i < bytes.length; i += piece) {
    const end = Math.min(bytes.length, i + piece);
    const buf = Buffer.allocUnsafe((end - i) * 3);
    let o = 0;
    for (let j = i; j < end; j++) {
      const v = bytes[j];
      buf[o++] = 0x5c;
      const hi = v >> 4, lo = v & 15;
      buf[o++] = hi < 10 ? 0x30 + hi : 0x57 + hi;
      buf[o++] = lo < 10 ? 0x30 + lo : 0x57 + lo;
    }
    yield buf.toString("latin1");
  }
}

/** @param {SnesOptions["pcSkip"]} v */
function parsePcSkip(v) {
  if (!v) return [];
  if (typeof v === "string") {
    return v.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
      const [lo, hi] = p.split("-");
      return [parseInt(lo, 16), parseInt(hi || lo, 16)];
    });
  }
  return v.map(([lo, hi]) => [lo, hi ?? lo]);
}

/**
 * Emit the whole module as WAT text chunks.
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* emitWat(rom, opts = {}) {
  const d = describe(rom, opts);
  if (!d.supported) throw new Error(`snes recompile refused: ${d.refusal}`);
  const img = toBytes(rom).subarray(d.copierHeader);
  const lay = d.memory;
  const narms = lay.narms;
  const stats = opts.stats ?? {};
  Object.assign(stats, { arms: narms, lowered: 0, interpreted: 0, dual: 0, reasons: {} });

  yield `(module\n  (memory (export "memory") ${lay.pages})`;
  yield "\n" + globalsWat(lay);
  yield "\n" + memWat(lay);
  // The interpreter's opcode tables come from the same decoder table the
  // arms are lowered from, so the two cannot drift.
  yield "\n" + `  (data (i32.const ${OPTAB}) "` + [...escChunks(isopTable())].join("") + '")';
  yield "\n" + `  (data (i32.const ${MODTAB}) "` + [...escChunks(modeTable())].join("") + '")';
  yield "\n" + interpTablesWat(lay, OPTAB, MODTAB);
  yield "\n" + interpWat(lay);
  yield "\n" + apuWat(lay);
  yield "\n" + ppuDataWat();
  yield "\n" + ppuWat(lay);
  yield "\n" + renderWat(lay);

  const nshards = Math.ceil(narms / SH);
  for (let si = 0; si < nshards; si++) {
    const lo = si * SH, hi = Math.min(narms, lo + SH), cnt = hi - lo;
    const lines = [`  (func $shard${si} (param $id i32)`];
    for (let i = cnt - 1; i >= 0; i--) lines.push(`    (block $s${i}`);
    lines.push("    (block $sdef");
    const labels = new Array(cnt);
    for (let i = 0; i < cnt; i++) labels[i] = `$s${i}`;
    lines.push("      (br_table " + labels.join(" ") + " $sdef (local.get $id))");
    // $sdef's body comes FIRST: `br $sN` resumes just after $sN closes.
    lines.push("    ) (call $trap) (return)");
    for (let i = 0; i < cnt; i++) {
      const a = lo + i;
      lines.push(`    ) ;; $s${i} @ ${a.toString(16).toUpperCase().padStart(6, "0")}`);
      lines.push(`    ${armCode(img, a, stats)} (return)`);
    }
    lines.push("    (call $trap))");
    yield "\n" + lines.join("\n");
  }

  const skip = [...PCRING_SKIP_DEFAULT, ...parsePcSkip(opts.pcSkip)];
  const pcv = "(i32.and (global.get $pc) (i32.const 0xFFFF))";
  const h4 = (v) => v.toString(16).toUpperCase().padStart(4, "0");
  const terms = skip.map(([lo, hi]) =>
    `(i32.or (i32.lt_u ${pcv} (i32.const 0x${h4(lo)}))` +
    ` (i32.gt_u ${pcv} (i32.const 0x${h4(hi)})))`);
  let excl = terms[0];
  for (const t of terms.slice(1)) excl = `(i32.and ${excl} ${t})`;
  const rw = opts.regwatchPc ? regwatchWat(opts.regwatchPc) : "";
  yield "\n" + stepHeadWat(rw, excl, lay) + shardDispatch(nshards) + "\n    (call $trap))";

  // PACKED: (offset, arm + 1) pairs, little-endian i32s. Arm i IS offset i.
  yield "\n" + `  (data (i32.const ${lay.PACKED}) "`;
  const PER = 1 << 17;
  for (let i = 0; i < narms; i += PER) {
    const end = Math.min(narms, i + PER);
    const tab = new Uint8Array((end - i) * 8);
    const dv = new DataView(tab.buffer);
    for (let k = i; k < end; k++) {
      dv.setUint32((k - i) * 8, k, true);
      dv.setUint32((k - i) * 8 + 4, k + 1, true);
    }
    yield* escChunks(tab);
  }
  yield '")';
  yield "\n" + frameWat(lay);
  yield "\n" + `  (data (i32.const ${ROM}) "`;
  yield* escChunks(img);
  yield '")';
  yield "\n)";
}

/**
 * One arm body: the lowered instruction plus its pc/cycle tail, or a call
 * into the RAM interpreter for bytes the lowerer refuses (brk/cop/stp).
 * The nine M/X-dependent immediates carry BOTH readings.
 * @param {Uint8Array} img
 * @param {number} a
 * @param {any} stats
 */
function armCode(img, a, stats) {
  const [pb, pc16] = loromAddr(a);
  let mode = null;
  try { mode = decode(img, a).mode; } catch { mode = null; }
  try {
    let code;
    if ((mode === "immM" || mode === "immX") && a + 3 <= img.length) {
      const fl = mode === "immM" ? "fm" : "fx";
      code = `(if (global.get $${fl}) (then ${arm(img, a, 2, pb, pc16)}) (else ${arm(img, a, 3, pb, pc16)}))`;
      stats.dual++;
    } else {
      code = arm(img, a, mode ? oplen(mode, 1, 1) : 1, pb, pc16);
    }
    stats.lowered++;
    return code;
  } catch (e) {
    const r = String(e.message);
    stats.reasons[r] = (stats.reasons[r] ?? 0) + 1;
    stats.interpreted++;
    return "(call $interp) (global.set $cyc (i32.sub (global.get $cyc) (i32.const 6)))";
  }
}

/** Lower one instruction of length n and append its pc/cycle tail. */
function arm(img, a, n, pb, pc16) {
  const [body, flow, cyc] = lower(img, a, n, pb, pc16);
  const nxt24 = (pb << 16) | ((pc16 + n) & 0xffff);
  let tail;
  if (flow === null) tail = `(global.set $pc (i32.const ${nxt24}))`;
  else if (flow.kind === "jp") tail = `(global.set $pc (i32.const ${((flow.bank & 0xff) << 16) | (flow.addr & 0xffff)}))`;
  else if (flow.kind === "jp_expr") tail = "(global.set $pc (global.get $t))";
  else {
    // A relative branch cannot leave its bank: the target is this
    // instruction's bank plus the 16-bit address the delta lands on.
    const tgt24 = (pb << 16) | ((pc16 + flow.delta) & 0xffff);
    tail = flow.kind === "jp_file"
      ? `(global.set $pc (i32.const ${tgt24}))`
      : `(if ${flow.cond} (then (global.set $pc (i32.const ${tgt24}))) (else (global.set $pc (i32.const ${nxt24}))))`;
  }
  return `${body} ${tail} (global.set $cyc (i32.sub (global.get $cyc) (i32.const ${cyc})))`;
}

/**
 * Binary search over shard index (a linear `if` chain cost ~137M compares
 * per frame at Super Metroid's 3,072 shards and looked like a hang).
 */
function shardDispatch(nshards, lo = 0, hi = nshards, indent = 4) {
  const pad = " ".repeat(indent);
  if (hi - lo === 1) return `${pad}(call $shard${lo} (i32.sub (local.get $id) (i32.const ${lo * SH}))) (return)`;
  const mid = (lo + hi) >> 1;
  return `${pad}(if (i32.lt_u (local.get $id) (i32.const ${mid * SH}))\n` +
    `${pad}  (then\n` +
    shardDispatch(nshards, lo, mid, indent + 4) + `\n${pad}  )\n` +
    `${pad}  (else\n` +
    shardDispatch(nshards, mid, hi, indent + 4) + `\n${pad}  ))`;
}

/**
 * Convenience: the whole module as one string (small carts, tests, debugging;
 * a commercial ROM's module is hundreds of MB to GBs, stream it instead).
 * @param {Uint8Array} rom
 * @param {SnesOptions} [opts]
 */
export async function emitWatString(rom, opts) {
  const parts = [];
  for await (const c of emitWat(rom, opts)) parts.push(c);
  return parts.join("");
}
