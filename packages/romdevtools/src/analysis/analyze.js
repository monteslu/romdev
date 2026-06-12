// analyze.js — MCP-facing RE analysis ops built on the Rizin WASM engine:
// control-flow graphs, deep cross-references, auto-detected functions, and a
// one-shot structural map. Complements disasm.js (da65/native, rebuildable
// output) — rizin gives the GRAPH structure da65 can't.
//
// Address model: rizin's own bin-loader sets the load address for formats it
// recognizes (iNES → 0x8000, GBA → 0x08000000, raw → 0). For platforms whose
// flat file maps 1:1 to the CPU bus (Genesis, plain binaries) the file offset
// IS the CPU address. We pass an explicit base only where it helps; the
// reported addresses are rizin virtual addresses, which match the CPU view for
// the common (unbanked / first-bank) case. Banked carts: a bank's window is
// resolved by the existing disasm mappers — analysis here is whole-file.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runRizin, runRizinJson, RIZIN_ARCH } from "./rizin.js";
import { decompileFunction, SLEIGH_LANGID } from "./decompile.js";
import { registersForPlatform } from "../platforms/common/registers.js";

/** B2: name hardware-register MMIO in decompiler output. Ghidra emits raw memory
 * refs like `xRAM2001` / `uRAM400e` for $2001 / $400E; replace those whose
 * address is a known platform register with the register NAME (a valid C
 * identifier) so the C reads `PPUMASK = ...` instead of `xRAM2001 = ...`. Plus a
 * one-line legend comment listing the substitutions made. */
export function nameHardwareRegisters(code, platform) {
  const regs = registersForPlatform(platform);
  if (!regs || !Object.keys(regs).length) return code;
  const used = new Map();
  // Match Ghidra's mem-ref identifiers: a few lowercase type-prefix letters,
  // then RAM, then the hex address. e.g. xRAM2001, uRAM400e, cRAM00ff.
  const out = code.replace(/\b[a-z]{1,3}RAM([0-9a-fA-F]{2,6})\b/g, (m, hex) => {
    const addr = parseInt(hex, 16);
    const name = regs[addr];
    if (!name) return m;
    used.set(addr, name);
    return name;
  });
  if (!used.size) return code;
  const legend = "/* hw registers: " +
    [...used.entries()].map(([a, n]) => `${n}=$${a.toString(16).toUpperCase()}`).join(", ") +
    " */\n";
  return legend + out;
}

/** The 6502-family platforms whose SLEIGH (Ghidra) output carries the
 * characteristic 8-bit clutter the B1 fold cleans up. */
const SIXTY_FIVE_OH_TWO = new Set(["nes", "atari2600", "atari7800", "c64", "lynx", "pce"]);

/** B1: 6502 idiom-folding post-pass (deterministic half). The 6502's 8-bit ALU
 * lowers to literal noise in SLEIGH output — awkward width types (`uint1`,
 * `xunknown1`), redundant nested width casts (`(uint2)(uint1)x`), and raw
 * zero-page byte refs (`cRAM00fd`). This pass folds the SAFE, mechanical ones
 * into readable C99 so the remaining logic is what an LLM (or human) reads:
 *   - SLEIGH width types → C99 stdint: uint1/int1/xunknown1 → uint8_t/int8_t,
 *     uint2 → uint16_t, uint4 → uint32_t (Ghidra's `uintN`/`undefinedN` are
 *     N-BYTE widths, not bit widths).
 *   - redundant nested width casts `(uint16_t)(uint8_t)expr` → `(uint8_t)expr`
 *     (the inner cast already narrows; the outer widen is noise).
 *   - zero-page byte refs `cRAM00fd` / `uRAM0012` → `zp_FD` / `zp_12` (a stable
 *     name for the ZP slot — the 6502's "fast RAM / pseudo-registers"). Only the
 *     $00xx page; MMIO was already named by nameHardwareRegisters (run first).
 * It does NOT attempt the carry-flag 16-bit add/sub or BCD reconstruction the
 * plan also lists — Ghidra usually already folds those into `+`/`uint2`, and a
 * textual rewrite of what survives risks changing semantics. Those are left to
 * the LLM cleanup half (the decompile output is read by an agent). Emits a
 * leading "6502 fold:" legend comment noting what was applied. */
export function foldSixtyFiveOhTwoIdioms(code, platform) {
  if (!SIXTY_FIVE_OH_TWO.has(platform)) return code;
  const applied = [];
  let out = code;

  // 1) SLEIGH width types to C99 stdint. Each is a whole-word match. xunknown1
  // and undefined1 are Ghidra's "1 byte, unknown signedness" - map to uint8_t.
  const TYPES = [
    [/\buint1\b/g, "uint8_t"], [/\bint1\b/g, "int8_t"],
    [/\buint2\b/g, "uint16_t"], [/\bint2\b/g, "int16_t"],
    [/\buint4\b/g, "uint32_t"], [/\bint4\b/g, "int32_t"],
    [/\bxunknown1\b/g, "uint8_t"], [/\bundefined1\b/g, "uint8_t"],
    [/\bxunknown2\b/g, "uint16_t"], [/\bundefined2\b/g, "uint16_t"],
    [/\bxunknown4\b/g, "uint32_t"], [/\bundefined4\b/g, "uint32_t"],
  ];
  let typeFolds = 0;
  for (const [re, to] of TYPES) {
    out = out.replace(re, () => { typeFolds++; return to; });
  }
  if (typeFolds) applied.push("SLEIGH width types → stdint");

  // 2) Redundant nested width casts: `(uint16_t)(uint8_t)X` → `(uint8_t)X`. The
  // inner narrowing cast governs; the outer widen back is pure noise SLEIGH emits
  // around zero-page index math. Run a couple of passes to collapse triples.
  let castFolds = 0;
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out.replace(/\((uint(?:8|16|32)_t)\)\((uint8_t)\)/g, (_m, _wide, narrow) => {
      castFolds++; return `(${narrow})`;
    });
    if (out === before) break;
  }
  if (castFolds) applied.push("redundant width casts collapsed");

  // 3) Zero-page byte refs → zp_XX. Only the $00 page (cRAM00fd etc.); the
  // 2-hex-after-00 form. A bare 4-hex like RAM0312 is not ZP — leave it.
  const zp = new Set();
  out = out.replace(/\b[a-z]{1,3}RAM00([0-9a-fA-F]{2})\b/g, (_m, hex) => {
    const name = "zp_" + hex.toUpperCase();
    zp.add(name);
    return name;
  });
  if (zp.size) applied.push(`${zp.size} zero-page slot${zp.size > 1 ? "s" : ""} named zp_XX`);

  if (!applied.length) return code;
  return `/* 6502 fold: ${applied.join("; ")} */\n` + out;
}

/** Readability post-passes applied to every decompiler C body, in order:
 * B2 hardware-register naming first (so MMIO becomes PPUMASK etc. before B1's
 * zero-page labeler could touch it), then B1 6502 idiom folding. Both are no-ops
 * off their target platforms, so this is safe to call unconditionally. */
export function prettyDecompile(code, platform) {
  return foldSixtyFiveOhTwoIdioms(nameHardwareRegisters(code, platform), platform);
}

/** Sniff platform from a ROM extension (mirrors disasm.js). */
export function sniffPlatform(p) {
  if (/\.nes$/i.test(p)) return "nes";
  if (/\.(sfc|smc)$/i.test(p)) return "snes";
  if (/\.gbc$/i.test(p)) return "gbc";
  if (/\.gb$/i.test(p)) return "gb";
  if (/\.sms$/i.test(p)) return "sms";
  if (/\.gg$/i.test(p)) return "gg";
  if (/\.a26$/i.test(p)) return "atari2600";
  if (/\.a78$/i.test(p)) return "atari7800";
  if (/\.prg$/i.test(p)) return "c64";
  if (/\.(lnx|lyx)$/i.test(p)) return "lynx";
  if (/\.gba$/i.test(p)) return "gba";
  if (/\.pce$/i.test(p)) return "pce";
  if (/\.(gen|md|bin)$/i.test(p)) return "genesis";
  return null;
}

/** rizin asm.bits per arch (analysis defaults; rizin's loader usually sets
 * these for recognized formats, but raw blobs need a hint). */
const BITS = { arm: 32, m68k: 32, snes: 16 };

/** Build the common rizin invocation context for a ROM + platform. Returns
 * { romBytes, arch, bits, note } — arch null means let rizin sniff. */
async function loadContext(romPath, platformOverride) {
  const platform = platformOverride ?? sniffPlatform(romPath);
  if (!platform) {
    throw new Error(
      `analyze: could not determine platform from '${path.basename(romPath)}' — pass platform explicitly`
    );
  }
  if (!(platform in RIZIN_ARCH)) {
    throw new Error(`analyze: unsupported platform '${platform}'`);
  }
  const arch = RIZIN_ARCH[platform];
  if (arch == null) {
    throw new Error(`analyze: no Rizin arch mapping for platform '${platform}'`);
  }
  let romBytes = new Uint8Array(await readFile(romPath));
  // PCE: rizin's 6502 plugin drives the loader + standard control flow for
  // function detection, but mis-decodes HuC6280 custom opcodes — CFG/xrefs are
  // approximate. Accurate HuC6280 decode is the decompiler's job (SLEIGH spec).
  const approx = platform === "pce";

  // Address-space prep (A2): some formats carry a header and load at a CPU base
  // that isn't 0. Strip the header and report `loadBase` so rizin's functions
  // (and the decompiler image) speak CPU addresses, not raw file offsets.
  //   c64 .prg — 2-byte little-endian LOAD ADDRESS header, code at that address
  //   (typically $0801 = BASIC start). Without this, rizin analyzes the header
  //   bytes as code at offset 0 and every address is a file offset, not a CPU
  //   address — functions→decompile round-trip lands on garbage.
  let loadBase = 0;
  if (platform === "c64" && romBytes.length >= 2) {
    loadBase = romBytes[0] | (romBytes[1] << 8);
    romBytes = romBytes.subarray(2);
  }

  // A6: container/format sniff. Some dumps are interleaved/headered such that a
  // FLAT read scrambles every byte → fake "bad instruction" noise everywhere.
  // Detect + auto-correct, and warn so a flat disasm isn't silently wrong.
  const warnings = [];
  if (platform === "genesis") {
    const smd = deinterleaveSmd(romBytes);
    if (smd) {
      romBytes = smd;
      warnings.push("Genesis ROM was SMD-INTERLEAVED (512-byte header + byte-swapped 16KB blocks) — " +
        "auto-deinterleaved before analysis. A flat read of the original would scramble every instruction.");
    }
  }
  return { platform, romBytes, arch, bits: BITS[arch], approx, loadBase, warnings };
}

/** Detect + reverse Sega Mega Drive SMD interleaving. An .smd dump is a 512-byte
 * header followed by 16KB blocks where each block's first 8KB holds the ODD
 * bytes and the second 8KB the EVEN bytes (interleaved). Returns the
 * deinterleaved ROM, or null if the image isn't SMD-interleaved. */
export function deinterleaveSmd(bytes) {
  // SMD: (N * 16KB) + 512-byte header. The header's byte 8 = 0xAA, byte 9 = 0xBB
  // is the classic SMD magic; also the body length must be a multiple of 16KB.
  if (bytes.length < 512 + 0x4000) return null;
  const bodyLen = bytes.length - 512;
  if (bodyLen % 0x4000 !== 0) return null;
  const isSmdMagic = bytes[8] === 0xaa && bytes[9] === 0xbb;
  // A plain .bin that happens to be (N*16KB)+512 is unusual; require the magic to
  // avoid false positives on legitimately-sized flat ROMs.
  if (!isSmdMagic) return null;

  const body = bytes.subarray(512);
  const out = new Uint8Array(bodyLen);
  const blocks = bodyLen / 0x4000;
  for (let b = 0; b < blocks; b++) {
    const base = b * 0x4000;
    for (let i = 0; i < 0x2000; i++) {
      out[base + i * 2 + 1] = body[base + i];           // odd bytes (first 8KB)
      out[base + i * 2] = body[base + 0x2000 + i];       // even bytes (second 8KB)
    }
  }
  return out;
}

/** Hex-format an address the way agents expect for the platform width. */
function hx(n) { return "0x" + (n >>> 0).toString(16); }

/**
 * Auto-detected function list for a ROM.
 * @returns {{platform, count, functions: Array<{address, name, size, nbbs, cc, callers, callees}>}}
 */
export async function analyzeFunctions(romPath, platformOverride) {
  const { platform, romBytes, arch, bits, loadBase, warnings } = await loadContext(romPath, platformOverride);
  const fns = await runRizinJson({ romBytes, arch, bits, baddr: loadBase || undefined, commands: "aaa; aflj" });
  const functions = fns.map((f) => ({
    address: f.offset,
    addressHex: hx(f.offset),
    name: f.name,
    size: f.size,
    nbbs: f.nbbs,           // basic-block count
    cc: f.cc,               // cyclomatic complexity
    callers: f.indegree ?? (f.codexrefs?.length ?? 0),
    callees: f.outdegree ?? 0,
    // A3: rizin's flat sweep folds DATA regions into pseudo-functions with absurd
    // `size` (megabyte "functions", phantoms exceeding the ROM). The honest
    // signal is the BYTES-PER-BLOCK ratio, not raw size: real code averages tens
    // of bytes per basic block; a "function" of thousands of bytes per block (or
    // a single huge block with no control flow) is a data table / graphics blob
    // mis-detected as a function. Flag it so agents don't waste a decompile on
    // it. (A 16KB function with 35 blocks + cc 19 is a real big dispatcher — NOT
    // flagged; size alone is the lie, the ratio isn't.)
    looksLikeData:
      (f.size ?? 0) > 0x400 &&
      ((f.nbbs ?? 0) <= 1 || (f.size ?? 0) / Math.max(1, f.nbbs ?? 1) > 1024),
  }));
  // Real code first: highest nbbs/cc, then smaller size — so the actual routines
  // surface above the data-fold noise without the agent having to learn the rule.
  functions.sort((a, b) =>
    (a.looksLikeData ? 1 : 0) - (b.looksLikeData ? 1 : 0) ||
    (b.nbbs ?? 0) - (a.nbbs ?? 0) ||
    (b.cc ?? 0) - (a.cc ?? 0) ||
    (a.size ?? 0) - (b.size ?? 0)
  );
  const dataCount = functions.filter((f) => f.looksLikeData).length;
  return { platform, arch, count: functions.length, dataCount, functions,
    ...(warnings?.length ? { warnings } : {}) };
}

/**
 * Control-flow graph for the function containing `address`.
 * @returns {{platform, address, nodes: Array<{id,address,size,instructions,jump,fail,out}>, edges}}
 */
export async function analyzeCfg(romPath, address, platformOverride) {
  if (address == null) throw new Error("analyze cfg: address required");
  const { platform, romBytes, arch, bits, loadBase } = await loadContext(romPath, platformOverride);
  // afbj = basic blocks of the function as JSON: each block has addr/size/jump/
  // fail/ninstr. `jump` is the taken edge; `fail` (present only on conditional
  // blocks) is the fall-through. This is the structured CFG source — `agf json`
  // only gives a text body blob with untyped out_nodes.
  const blocks = await runRizinJson({
    romBytes, arch, bits, baddr: loadBase || undefined,
    commands: `aaa; af @ ${hx(address)}; afbj @ ${hx(address)}`,
  });
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { platform, arch, address, addressHex: hx(address), nodes: [], edges: [], note: "no function/blocks at address" };
  }
  const nodes = blocks.map((b) => ({
    id: b.addr,
    address: b.addr,
    addressHex: hx(b.addr),
    size: b.size,
    ninstr: b.ninstr,
  }));
  const edges = [];
  for (const b of blocks) {
    const conditional = b.fail != null;
    if (b.jump != null) edges.push({ from: b.addr, to: b.jump, type: conditional ? "branch_true" : "jump_or_fall" });
    if (b.fail != null) edges.push({ from: b.addr, to: b.fail, type: "branch_false" });
  }
  return {
    platform, arch,
    address, addressHex: hx(address),
    blockCount: nodes.length,
    nodes, edges,
  };
}

/**
 * All cross-references TO `address` across the ROM.
 * @returns {{platform, address, count, refs: Array<{from, to, type}>}}
 */
export async function analyzeXrefs(romPath, address, platformOverride) {
  if (address == null) throw new Error("analyze xrefs: address required");
  const { platform, romBytes, arch, bits, loadBase } = await loadContext(romPath, platformOverride);
  let refs;
  try {
    refs = await runRizinJson({ romBytes, arch, bits, baddr: loadBase || undefined, commands: `aaa; axtj @ ${hx(address)}` });
  } catch (e) {
    // axtj prints nothing (not even `[]`) when there are zero refs → our JSON
    // guard throws. Treat "no JSON" as "no refs".
    if (/no JSON/.test(e.message)) refs = [];
    else throw e;
  }
  const out = (refs ?? []).map((r) => ({
    from: r.from,
    fromHex: hx(r.from),
    to: r.to,
    type: (r.type || "").toLowerCase(), // CALL / CODE / DATA / STRING
    opcode: r.opcode,
  }));
  return { platform, arch, address, addressHex: hx(address), count: out.length, refs: out };
}

/**
 * One-shot structural map: functions + strings + entrypoints from a full
 * analysis pass. The "give me the shape of this ROM" call.
 */
export async function analyzeStructure(romPath, platformOverride) {
  const { platform, romBytes, arch, bits, loadBase } = await loadContext(romPath, platformOverride);
  const baddr = loadBase || undefined;
  const [fns, strings, entries] = await Promise.all([
    runRizinJson({ romBytes, arch, bits, baddr, commands: "aaa; aflj" }).catch(() => []),
    runRizinJson({ romBytes, arch, bits, baddr, commands: "aaa; izj" }).catch(() => []),
    runRizinJson({ romBytes, arch, bits, baddr, commands: "aaa; iej" }).catch(() => []),
  ]);
  return {
    platform, arch,
    functionCount: Array.isArray(fns) ? fns.length : 0,
    stringCount: Array.isArray(strings) ? strings.length : 0,
    entrypoints: (Array.isArray(entries) ? entries : []).map((e) => ({ address: e.vaddr, addressHex: hx(e.vaddr) })),
    functions: (Array.isArray(fns) ? fns : []).slice(0, 512).map((f) => ({
      address: f.offset, addressHex: hx(f.offset), name: f.name, size: f.size, callers: f.indegree ?? 0,
    })),
    strings: (Array.isArray(strings) ? strings : []).slice(0, 256).map((s) => ({
      address: s.vaddr, addressHex: hx(s.vaddr), value: s.string,
    })),
  };
}

/** Look up rizin's IO map (omlj) for the segment containing `vaddr`. Each map
 * entry carries {from (vaddr base), delta (vaddr-paddr), to}. Returns
 * { paddr, vbase } where paddr = vaddr-delta is the raw-file offset and vbase
 * (= delta) is the address byte 0 of the file maps to on the CPU bus. */
/** Platforms whose cartridge maps 1:1 to the CPU bus (file offset == CPU
 * address, base 0). For these we DISTRUST Rizin's IO-map delta: some of Rizin's
 * loaders (notably the Mega Drive loader) split the image into vtable/header/
 * text SEGMENTS and report a non-zero delta on the code segment (e.g. 0x200 for
 * Genesis), but the raw file we hand the decompiler loads flat at VMA 0 — so the
 * vaddr IS the file offset and any delta is a lie for our purposes. Forcing
 * identity here fixes the "+0x200 shifted decompile" bug (a code vaddr would
 * otherwise resolve to vaddr-0x200, the WRONG function). */
export const FLAT_CPU_MAP = new Set(["genesis", "sms", "gg", "msx", "gb", "gbc"]);

export async function vaMapping(romBytes, arch, bits, vaddr, platform) {
  // Flat-cartridge platforms: file offset == CPU address. Ignore Rizin's
  // segment deltas entirely.
  if (FLAT_CPU_MAP.has(platform)) return { paddr: vaddr, vbase: 0 };
  let maps;
  try {
    maps = await runRizinJson({ romBytes, arch, bits, commands: "omlj" });
  } catch { maps = []; }
  for (const m of (Array.isArray(maps) ? maps : [])) {
    const from = m.from ?? m.vaddr ?? 0;
    const to = m.to ?? (from + (m.size ?? 0));
    if (vaddr >= from && vaddr < to) return { paddr: vaddr - (m.delta ?? 0), vbase: m.delta ?? 0 };
  }
  return { paddr: vaddr, vbase: 0 };
}

/** Build a CPU-ADDRESSED sparse image of a SNES cart for the decompiler.
 *
 * SNES is banked: the langid is `65816:LE:24:snes` (24-bit space). If we hand
 * the decompiler the flat file, a LoROM function at CPU $00:8000 lives at file
 * 0, but its in-bank `jsr $80xx` operands resolve to file 0x80xx — bank-1 code,
 * a plausible-but-WRONG body. So we lay each ROM chunk at its CPU address
 * (sparse, zero-filled between), making BOTH the function address and every
 * in-bank/JSL operand resolve. ~2x ROM size; fine at SNES cart sizes.
 *
 * Mirrors the detection/fold in disasm.js's mapSnesAddress (kept local to avoid
 * a circular import: disasm.js imports analyze.js).
 *
 * The image is laid out BY CPU address, so the decompiler offset for a CPU
 * address is the address itself (24-bit). @returns {{ image: Uint8Array, isLo:boolean }}
 */
export function buildSnesCpuImage(romBytes, mapperHint) {
  const copierOff = (romBytes.length % 0x8000 === 0x200) ? 0x200 : 0;
  let isLo;
  if (mapperHint === "lorom") isLo = true;
  else if (mapperHint === "hirom") isLo = false;
  else {
    const loByte = romBytes[copierOff + 0x7FC0 + 0x15];
    const hiByte = romBytes[copierOff + 0xFFC0 + 0x15];
    const detLo = loByte === 0x20 || loByte === 0x30 || loByte === 0x32;
    const detHi = hiByte === 0x21 || hiByte === 0x31;
    isLo = detHi && !detLo ? false : true; // default LoROM when ambiguous
  }
  const body = romBytes.subarray(copierOff);

  if (isLo) {
    // LoROM: 32KB file chunk N maps to CPU bank N, $8000-$FFFF. Banks $80-$FF
    // MIRROR $00-$7F (the FastROM image), and code commonly runs there (a JML to
    // $F9xxxx is bank 0x79's ROM via the $80+ mirror). So we lay the full 16MB
    // 24-bit space and mirror each chunk into BOTH its $00-$7F home and its
    // $80-$FF twin — otherwise a reference into the high half "can't load N
    // bytes" and the decompiler bails.
    const fileBanks = Math.ceil(body.length / 0x8000); // ROM chunks (≤128)
    const image = new Uint8Array(0x1000000); // full 16MB CPU space
    for (let b = 0; b < fileBanks; b++) {
      const src = body.subarray(b * 0x8000, (b + 1) * 0x8000);
      const lo = (b & 0x7F);          // home bank $00-$7F
      image.set(src, lo * 0x10000 + 0x8000);          // $lo:8000
      image.set(src, (lo | 0x80) * 0x10000 + 0x8000); // $(lo|80):8000 mirror
    }
    return { image, isLo: true };
  }
  // HiROM: file 64KB chunk N is CPU bank $C0+N ($0000-$FFFF, the primary image),
  // mirrored to bank $40+N. The upper half of each chunk also appears at
  // $00-$3F:$8000-$FFFF and $80-$BF:$8000-$FFFF. Lay the full 16MB space and
  // mirror so any of those references resolve.
  const fileBanks = Math.ceil(body.length / 0x10000); // 64KB chunks
  const image = new Uint8Array(0x1000000);
  for (let b = 0; b < fileBanks; b++) {
    const src = body.subarray(b * 0x10000, (b + 1) * 0x10000);
    image.set(src, (0xC0 + b) * 0x10000);             // $C0+b: full bank (primary)
    image.set(src, (0x40 + b) * 0x10000);             // $40+b: mirror
    const upper = src.subarray(0x8000);               // $8000-$FFFF half
    image.set(upper, b * 0x10000 + 0x8000);           // $00+b:8000 mirror
    image.set(upper, (0x80 + b) * 0x10000 + 0x8000);  // $80+b:8000 mirror
  }
  return { image, isLo: false };
}

/** Bank-aware NES image for the decompiler (A1).
 *
 * Rizin maps an iNES PRG as ONE flat $8000-based segment, so a `functions`
 * address is a FLAT-PRG VA ($8000 + flat offset) — bank 0 at $8000-$BFFF, bank 1
 * at $C000-$FFFF, bank 2 at $10000+, etc. Decompiling that flat image is
 * bank-blind: an in-code `JSR $9123` (a real CPU address) resolves to flat
 * $9123 = bank 0, even when the calling code lives in bank 3 → halt_baddata /
 * garbage (11/12 top functions on a banked cart, empirically).
 *
 * Fix: from the flat VA, recover which 16KB PRG bank the function is in, then
 * build a real 32KB 6502 CPU image — that bank at $8000-$BFFF, the FIXED top
 * bank at $C000-$FFFF — and decompile at the function's REAL CPU address. Now
 * in-bank calls AND fixed-bank ($C000+) calls both resolve.
 *
 * @returns {{ image: Uint8Array, cpuAddr: number, bank: number } | null} null if
 *   not a banked iNES (caller falls back to the flat path; NROM is fine flat).
 */
export function buildNesBankImage(romBytes, flatVa) {
  if (romBytes[0] !== 0x4e || romBytes[1] !== 0x45 || romBytes[2] !== 0x53 || romBytes[3] !== 0x1a) {
    return null; // not iNES
  }
  const prgBanks16k = romBytes[4];
  const prgSize = prgBanks16k * 0x4000;
  if (prgSize <= 0x8000) return null; // NROM-128/256 — flat is correct
  const prgStart = 16;
  const prg = romBytes.subarray(prgStart, prgStart + prgSize);

  // rizin flat VA → flat PRG offset (segment based at $8000).
  const flatOff = (flatVa >>> 0) - 0x8000;
  if (flatOff < 0 || flatOff >= prgSize) return null;
  const bank = Math.floor(flatOff / 0x4000);          // which 16KB bank
  const inBank = flatOff % 0x4000;                     // offset within it
  const topBank = prgBanks16k - 1;                     // fixed top bank

  // 32KB CPU window: chosen bank at $8000, fixed top bank at $C000.
  const image = new Uint8Array(0x10000);
  image.set(prg.subarray(bank * 0x4000, bank * 0x4000 + 0x4000), 0x8000);
  image.set(prg.subarray(topBank * 0x4000, topBank * 0x4000 + 0x4000), 0xC000);

  // The function's real CPU address: if it's the fixed top bank, it's at
  // $C000+inBank; otherwise it's the switchable slot at $8000+inBank.
  const cpuAddr = bank === topBank ? 0xC000 + inBank : 0x8000 + inBank;
  return { image, cpuAddr, bank };
}

/**
 * Decompile the function containing `address` to C pseudocode (Ghidra).
 * @returns {{platform, langid, address, code, warnings, qualityNote, bank?}}
 */
export async function analyzeDecompile(romPath, address, platformOverride) {
  if (address == null) throw new Error("analyze decompile: address required");
  const platform = platformOverride ?? sniffPlatform(romPath);
  if (!platform) throw new Error(`analyze decompile: unknown platform for '${path.basename(romPath)}'`);
  if (!SLEIGH_LANGID[platform]) throw new Error(`analyze decompile: unsupported platform '${platform}'`);
  let romBytes = new Uint8Array(await readFile(romPath));
  // A6: deinterleave SMD Genesis dumps here too (analyzeDecompile reads the file
  // directly, not via loadContext) — a flat read of an interleaved ROM decodes
  // to pure garbage.
  if (platform === "genesis") romBytes = deinterleaveSmd(romBytes) ?? romBytes;

  // SNES: banked 24-bit space. `address` is a LoROM/HiROM CPU address (what
  // target='functions'/'cfg' report). Lay the cart out by CPU address so BOTH
  // the function address AND its in-bank/JSL operands resolve, then decompile at
  // the CPU address directly. (Flat-at-0 would decompile file[address] — the
  // wrong bank — and mis-label every operand.)
  if (platform === "snes") {
    const { image } = buildSnesCpuImage(romBytes);
    // The image is laid out by CPU address, so the file offset IS the address.
    const imgOff = address >>> 0;
    if (imgOff < 0 || imgOff >= image.length) {
      throw new Error(
        `decompile: SNES address ${hx(address)} is outside the ${image.length}-byte CPU image ` +
        `(is it a valid LoROM/HiROM code address?).`
      );
    }
    const rs = await decompileFunction({ platform, romBytes: image, fileOffset: imgOff });
    return {
      platform, langid: rs.langid,
      address, addressHex: hx(address),
      code: prettyDecompile(rs.code, platform), warnings: rs.warnings,
      qualityNote: "medium (65816 variable register width)",
    };
  }

  // NES banked carts (A1): rizin reports flat-PRG VAs ($8000-based); decompiling
  // that flat image is bank-blind (cross-bank JSR/JMP land on the wrong bank).
  // Build a real 32KB CPU window (this bank @ $8000 + fixed top bank @ $C000) so
  // in-bank AND fixed-bank calls resolve. NROM falls through to the flat path.
  if (platform === "nes") {
    const banked = buildNesBankImage(romBytes, address);
    if (banked) {
      const rn = await decompileFunction({ platform, romBytes: banked.image, fileOffset: banked.cpuAddr });
      return {
        platform, langid: rn.langid,
        address, addressHex: hx(address),
        bank: banked.bank,
        code: prettyDecompile(rn.code, platform), warnings: rn.warnings,
        qualityNote: "rough (6502 architecture limit)",
      };
    }
  }

  // Use rizin's loader mapping to turn the VA (what the user sees from
  // target='functions') into the file offset the raw decompiler image needs.
  // PCE uses the 6502 plugin only for the map/loader (HuC6280 decode is the
  // decompiler's job via SLEIGH) — its flat image bases at 0 either way.
  const arch = RIZIN_ARCH[platform] ?? "6502";
  const bits = { arm: 32, m68k: 32, snes: 16 }[arch];

  const QUALITY = {
    gba: "excellent (ARM)", genesis: "excellent (M68K)",
    gb: "good (SM83)", gbc: "good (SM83)", sms: "good (Z80)", gg: "good (Z80)", msx: "good (Z80)",
    snes: "medium (65816 variable register width)", pce: "medium (HuC6280)",
    nes: "rough (6502 architecture limit)", atari2600: "rough (6502)", atari7800: "rough (6502)",
    c64: "rough (6502)", lynx: "rough (65C02)",
  };

  // FORCED-BASE platforms (headerless/load-header 6502 carts): rizin/our
  // analysis bases these at a known CPU address, so `address` IS a CPU address
  // and `functions` already reported it as such. Strip any header, left-pad the
  // body so file offset == CPU address, and decompile at `address` directly.
  //   2600 → $F000; 7800 → size-dependent $8000-$C000 (+128B header if "AT…");
  //   c64 .prg → the 2-byte load-address header's value (e.g. $0801).
  let forcedBase = 0, bodyStart = 0;
  if (platform === "atari2600") {
    forcedBase = 0xf000;
  } else if (platform === "atari7800") {
    const hasHdr = romBytes.length > 128 &&
      romBytes[1] === 0x41 && romBytes[2] === 0x54; // "AT"
    bodyStart = hasHdr ? 128 : 0;
    const body = romBytes.length - bodyStart;
    forcedBase = body <= 0x4000 ? 0xc000 : body <= 0x8000 ? 0x8000 : 0x4000;
  } else if (platform === "c64" && romBytes.length >= 2) {
    bodyStart = 2;
    forcedBase = romBytes[0] | (romBytes[1] << 8);
  }
  if (forcedBase > 0 && forcedBase <= 0x10000) {
    const body = romBytes.subarray(bodyStart);
    // Accept `address` as EITHER a CPU address (≥ forcedBase, what functions
    // reports once baddr is applied) OR a raw body file-offset (< forcedBase,
    // legacy callers / direct offsets). Normalize to a CPU address.
    const a = address >>> 0;
    const cpuAddr = a >= forcedBase ? a : forcedBase + a;
    if (cpuAddr < forcedBase || cpuAddr >= forcedBase + body.length) {
      throw new Error(
        `decompile: address ${hx(a)} is outside the ${platform} CPU image ` +
        `($${forcedBase.toString(16)}-$${(forcedBase + body.length).toString(16)}).`
      );
    }
    const padded = new Uint8Array(forcedBase + body.length);
    padded.set(body, forcedBase);
    const rf = await decompileFunction({ platform, romBytes: padded, fileOffset: cpuAddr });
    return {
      platform, langid: rf.langid, address, addressHex: hx(address),
      code: prettyDecompile(rf.code, platform), warnings: rf.warnings, qualityNote: QUALITY[platform] ?? "unknown",
    };
  }

  // Other platforms: use rizin's loader mapping to turn the CPU VA into the file
  // offset the raw decompiler image needs. Rizin's map gives `vbase` when it
  // knows the base; left-pad by it so file offset == CPU address for the cases
  // where the code references absolute addresses.
  const { paddr, vbase } = await vaMapping(romBytes, arch, bits, address, platform);
  if (paddr < 0 || paddr >= romBytes.length) {
    throw new Error(
      `decompile: address ${hx(address)} maps to file offset ${paddr}, outside the ` +
      `${romBytes.length}-byte image for ${platform}.`
    );
  }
  const base = vbase;
  let image = romBytes, decompAddr = paddr;
  if (base > 0 && base <= 0x10000) {
    const padded = new Uint8Array(base + romBytes.length);
    padded.set(romBytes, base);
    image = padded;
    decompAddr = base + paddr; // CPU address of the function
  }
  const r = await decompileFunction({ platform, romBytes: image, fileOffset: decompAddr });
  return {
    platform, langid: r.langid,
    address, addressHex: hx(address),
    code: prettyDecompile(r.code, platform),
    warnings: r.warnings,
    qualityNote: QUALITY[platform] ?? "unknown",
  };
}
