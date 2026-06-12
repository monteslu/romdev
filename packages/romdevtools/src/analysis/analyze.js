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
  const romBytes = new Uint8Array(await readFile(romPath));
  // PCE: rizin's 6502 plugin drives the loader + standard control flow for
  // function detection, but mis-decodes HuC6280 custom opcodes — CFG/xrefs are
  // approximate. Accurate HuC6280 decode is the decompiler's job (SLEIGH spec).
  const approx = platform === "pce";
  return { platform, romBytes, arch, bits: BITS[arch], approx };
}

/** Hex-format an address the way agents expect for the platform width. */
function hx(n) { return "0x" + (n >>> 0).toString(16); }

/**
 * Auto-detected function list for a ROM.
 * @returns {{platform, count, functions: Array<{address, name, size, nbbs, cc, callers, callees}>}}
 */
export async function analyzeFunctions(romPath, platformOverride) {
  const { platform, romBytes, arch, bits } = await loadContext(romPath, platformOverride);
  const fns = await runRizinJson({ romBytes, arch, bits, commands: "aaa; aflj" });
  const functions = fns.map((f) => ({
    address: f.offset,
    addressHex: hx(f.offset),
    name: f.name,
    size: f.size,
    nbbs: f.nbbs,           // basic-block count
    cc: f.cc,               // cyclomatic complexity
    callers: f.indegree ?? (f.codexrefs?.length ?? 0),
    callees: f.outdegree ?? 0,
  }));
  return { platform, arch, count: functions.length, functions };
}

/**
 * Control-flow graph for the function containing `address`.
 * @returns {{platform, address, nodes: Array<{id,address,size,instructions,jump,fail,out}>, edges}}
 */
export async function analyzeCfg(romPath, address, platformOverride) {
  if (address == null) throw new Error("analyze cfg: address required");
  const { platform, romBytes, arch, bits } = await loadContext(romPath, platformOverride);
  // afbj = basic blocks of the function as JSON: each block has addr/size/jump/
  // fail/ninstr. `jump` is the taken edge; `fail` (present only on conditional
  // blocks) is the fall-through. This is the structured CFG source — `agf json`
  // only gives a text body blob with untyped out_nodes.
  const blocks = await runRizinJson({
    romBytes, arch, bits,
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
  const { platform, romBytes, arch, bits } = await loadContext(romPath, platformOverride);
  let refs;
  try {
    refs = await runRizinJson({ romBytes, arch, bits, commands: `aaa; axtj @ ${hx(address)}` });
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
  const { platform, romBytes, arch, bits } = await loadContext(romPath, platformOverride);
  const [fns, strings, entries] = await Promise.all([
    runRizinJson({ romBytes, arch, bits, commands: "aaa; aflj" }).catch(() => []),
    runRizinJson({ romBytes, arch, bits, commands: "aaa; izj" }).catch(() => []),
    runRizinJson({ romBytes, arch, bits, commands: "aaa; iej" }).catch(() => []),
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

/**
 * Decompile the function containing `address` to C pseudocode (Ghidra).
 * @returns {{platform, langid, address, code, warnings, qualityNote}}
 */
export async function analyzeDecompile(romPath, address, platformOverride) {
  if (address == null) throw new Error("analyze decompile: address required");
  const platform = platformOverride ?? sniffPlatform(romPath);
  if (!platform) throw new Error(`analyze decompile: unknown platform for '${path.basename(romPath)}'`);
  if (!SLEIGH_LANGID[platform]) throw new Error(`analyze decompile: unsupported platform '${platform}'`);
  const romBytes = new Uint8Array(await readFile(romPath));

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
      code: rs.code, warnings: rs.warnings,
      qualityNote: "medium (65816 variable register width)",
    };
  }

  // Use rizin's loader mapping to turn the VA (what the user sees from
  // target='functions') into the file offset the raw decompiler image needs.
  // PCE uses the 6502 plugin only for the map/loader (HuC6280 decode is the
  // decompiler's job via SLEIGH) — its flat image bases at 0 either way.
  const arch = RIZIN_ARCH[platform] ?? "6502";
  const bits = { arm: 32, m68k: 32, snes: 16 }[arch];
  const { paddr, vbase } = await vaMapping(romBytes, arch, bits, address, platform);
  if (paddr < 0 || paddr >= romBytes.length) {
    throw new Error(
      `decompile: address ${hx(address)} maps to file offset ${paddr}, outside the ` +
      `${romBytes.length}-byte image for ${platform}.`
    );
  }
  // The raw decompiler loads byte 0 at VMA 0. Code that references absolute CPU
  // addresses (typical 6502: JSR/JMP to $Fxxx) only resolves if the image sits
  // at the right CPU base. Rizin's map gives `vbase` when it knows the base;
  // some headerless carts (2600/7800) it loads at 0, so we supply the base from
  // a per-platform table. Left-pad the image by the base so file offset == CPU
  // address, then decompile at the function's CPU address. Capped at 64KB (the
  // 6502 family's whole address space) so a large base never over-allocates.
  // Atari 2600/7800 are headerless 6502 dumps rizin loads at 0; supply the real
  // CPU base so absolute references ($8000/$C000/$F000) resolve. 7800's base is
  // size-dependent (16KB→$C000, 32KB→$8000); 7800 carts may carry a 128-byte
  // header before the body.
  let forcedBase = 0, bodyStart = 0;
  if (platform === "atari2600") {
    forcedBase = 0xf000;
  } else if (platform === "atari7800") {
    const hasHdr = romBytes.length > 128 &&
      romBytes[1] === 0x41 && romBytes[2] === 0x54; // "AT"
    bodyStart = hasHdr ? 128 : 0;
    const body = romBytes.length - bodyStart;
    forcedBase = body <= 0x4000 ? 0xc000 : body <= 0x8000 ? 0x8000 : 0x4000;
  }
  const base = vbase > 0 ? vbase : forcedBase;
  let image = romBytes, decompAddr = paddr;
  if (base > 0 && base <= 0x10000) {
    const body = romBytes.subarray(bodyStart);
    const padded = new Uint8Array(base + body.length);
    padded.set(body, base);
    image = padded;
    decompAddr = base + (paddr - bodyStart); // CPU address of the function
  }
  const r = await decompileFunction({ platform, romBytes: image, fileOffset: decompAddr });
  const QUALITY = {
    gba: "excellent (ARM)", genesis: "excellent (M68K)",
    gb: "good (SM83)", gbc: "good (SM83)", sms: "good (Z80)", gg: "good (Z80)", msx: "good (Z80)",
    snes: "medium (65816 variable register width)", pce: "medium (HuC6280)",
    nes: "rough (6502 architecture limit)", atari2600: "rough (6502)", atari7800: "rough (6502)",
    c64: "rough (6502)", lynx: "rough (65C02)",
  };
  return {
    platform, langid: r.langid,
    address, addressHex: hx(address),
    code: r.code,
    warnings: r.warnings,
    qualityNote: QUALITY[platform] ?? "unknown",
  };
}
