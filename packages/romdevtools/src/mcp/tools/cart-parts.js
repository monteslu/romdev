// extractCart / wrapRomFromParts — split ROM into standard pieces, and
// glue them back together with a build-ready wrapper source + linker cfg.
//
// extractCart replaces `dd skip=16 count=16384` per-platform magic numbers
// with one structured call. wrapRomFromParts handles the reverse — emit the
// boilerplate source files (wrapper.s + linkerConfig) that buildSource
// expects so an "extract → patch → re-wrap → buildSource" cycle has zero
// hand-written glue.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { jsonContent, safeTool } from "../util.js";
import { identifyRomCore } from "./rom-id.js";
import { prgToD64, readDirectory as readD64Dir, extractFile as extractD64File } from "../../platforms/c64/d64.js";

// ─── C64 .d64 disk image ──────────────────────────────────────────
//
// The C64 world ships and loads games as .d64 disk images (the new Commodore 64
// Ultimate FPGA hardware + the homebrew/demo scene), not as bare .prg files. A
// cc65 build emits a .prg; packDisk wraps it into a distributable, autostart-able
// .d64. Extract on a .d64 lists/pulls its files back out.

/**
 * Pack a built .prg into a .d64 disk image (the distribution format).
 * @param {{prgPath?:string, bodyPath?:string, romPath?:string, base64?:string,
 *          outputPath?:string, name?:string, diskName?:string, inline?:boolean}} args
 */
export async function packDiskCore(args) {
  const src = args.prgPath || args.bodyPath || args.romPath;
  let prg;
  if (args.base64) prg = new Uint8Array(Buffer.from(args.base64, "base64"));
  else if (src) prg = new Uint8Array(await readFile(src));
  else throw new Error("cart({op:'packDisk'}): provide `prgPath` (the built .prg) or `base64`.");

  const name = (args.name || (src ? path.basename(src).replace(/\.[^.]+$/, "") : "GAME"))
    .toUpperCase().replace(/[^A-Z0-9 ]/g, "").slice(0, 16) || "GAME";
  const d64 = prgToD64(prg, { name, diskName: args.diskName || name });

  if (args.inline) {
    return { packed: true, format: "d64", name, bytes: d64.length, base64: Buffer.from(d64).toString("base64") };
  }
  const out = args.outputPath
    || (src ? src.replace(/\.[^.]+$/, "") + ".d64" : null);
  if (!out) throw new Error("cart({op:'packDisk'}): `outputPath` required (or pass `prgPath` to derive it, or inline:true).");
  await writeFile(out, Buffer.from(d64));
  return {
    packed: true, format: "d64", name, bytes: d64.length, path: out,
    note: "Autostart-able 1541 disk image. Load it with loadMedia({platform:'c64', path}) — it boots the program automatically. This is the format the Commodore 64 Ultimate hardware and the homebrew scene load.",
  };
}

/** Read a .d64's directory + (optionally) extract a file. */
export async function extractDiskCore(args) {
  const data = new Uint8Array(await readFile(args.path));
  const dir = readD64Dir(data);
  const result = { format: "d64", path: args.path, files: dir };
  // If a specific file was named, also return its bytes.
  const which = args.name;
  if (which != null) {
    const bytes = extractD64File(data, which);
    if (!bytes) throw new Error(`cart({op:'extract'}) .d64: no file '${which}' on the disk (have: ${dir.map((d) => d.name).join(", ") || "none"}).`);
    if (args.inline) result.file = { name: which, bytes: bytes.length, base64: Buffer.from(bytes).toString("base64") };
    else {
      const out = args.outputDir
        ? path.join(args.outputDir, which.replace(/[^A-Za-z0-9._-]/g, "_") + ".prg")
        : args.path.replace(/\.d64$/i, "") + "." + which.replace(/[^A-Za-z0-9._-]/g, "_") + ".prg";
      if (args.outputDir) await mkdir(args.outputDir, { recursive: true });
      await writeFile(out, Buffer.from(bytes));
      result.file = { name: which, bytes: bytes.length, path: out };
    }
  }
  return result;
}

// ─── extractCart ──────────────────────────────────────────────────

/**
 * Split an iNES file into header.bin, prg.bin, chr.bin.
 */
function extractNes(data) {
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
    throw new Error("extractCart[nes]: file is not iNES (missing magic at offset 0)");
  }
  const prgBanks = data[4];
  const chrBanks = data[5];
  const flags6 = data[6];
  const flags7 = data[7];
  const mapper = ((flags6 >> 4) & 0xF) | (flags7 & 0xF0);
  const mirror = (flags6 & 0x01) ? "vertical" : "horizontal";
  const hasFourScreen = !!(flags6 & 0x08);
  const hasTrainer = !!(flags6 & 0x04);
  const hasBattery = !!(flags6 & 0x02);

  const prgSize = prgBanks * 16384;
  const chrSize = chrBanks * 8192;
  const trainerSize = hasTrainer ? 512 : 0;
  const prgStart = 16 + trainerSize;
  const chrStart = prgStart + prgSize;

  const parts = {
    "header.bin": data.slice(0, 16),
    "prg.bin": data.slice(prgStart, prgStart + prgSize),
  };
  if (chrSize > 0) {
    parts["chr.bin"] = data.slice(chrStart, chrStart + chrSize);
  }
  if (hasTrainer) {
    parts["trainer.bin"] = data.slice(16, 16 + 512);
  }
  return {
    parts,
    manifest: {
      platform: "nes",
      format: "iNES",
      prgBanks, prgSize,
      chrBanks, chrSize,
      mapper,
      mirror,
      hasFourScreen,
      hasBattery,
      hasTrainer,
    },
  };
}

/**
 * Split an SNES ROM into copier-header (if present) + body. SNES doesn't
 * have a separate CHR file the way NES does — graphics live inline in PRG
 * banks — so the "parts" are minimal: just header + ROM. We pull out the
 * internal header bytes ($FFC0 / $7FC0) too for inspection.
 */
function extractSnes(data) {
  const copierOff = (data.length % 0x8000 === 0x200) ? 0x200 : 0;
  const hiMapper = data[copierOff + 0xFFC0 + 0x15];
  const isLo = !(hiMapper === 0x21 || hiMapper === 0x31);
  const internalHeaderBase = copierOff + (isLo ? 0x7FC0 : 0xFFC0);
  const parts = {};
  if (copierOff) parts["copier_header.bin"] = data.slice(0, copierOff);
  parts["rom.bin"] = data.slice(copierOff);
  parts["internal_header.bin"] = data.slice(internalHeaderBase, internalHeaderBase + 0x40);
  return {
    parts,
    manifest: {
      platform: "snes",
      format: isLo ? "LoROM" : "HiROM",
      copierHeader: copierOff > 0,
      copierHeaderBytes: copierOff,
      internalHeaderOffset: internalHeaderBase,
      romSize: data.length - copierOff,
    },
  };
}

/**
 * Split a Genesis cart into vectors + header + body.
 */
function extractGenesis(data) {
  return {
    parts: {
      "vectors.bin": data.slice(0, 0x100),
      "header.bin": data.slice(0x100, 0x200),
      "body.bin": data.slice(0x200),
    },
    manifest: {
      platform: "genesis",
      vectorTableBytes: 0x100,
      headerBytes: 0x100,
      bodyBytes: data.length - 0x200,
    },
  };
}

/**
 * Split a Game Boy / GBC cart into boot, header, body.
 */
/**
 * Split an SMS / Game Gear cart into:
 *   pre_header.bin    — first $7FF0 bytes ($0000-$7FEF)
 *   sega_header.bin   — $7FF0-$7FFF (16 bytes: "TMR SEGA", checksum, product code, region/version)
 *   body.bin          — $8000 onwards (banked region)
 * Carts under 32 KB are emitted as a single rom.bin with a note that no
 * header was detected.
 */
function extractSms(data, platform) {
  const parts = {};
  const manifest = { platform, fileBytes: data.length };
  if (data.length >= 0x8000) {
    const magic = String.fromCharCode(...data.slice(0x7FF0, 0x7FF8));
    if (magic === "TMR SEGA") {
      parts["pre_header.bin"] = data.slice(0, 0x7FF0);
      parts["sega_header.bin"] = data.slice(0x7FF0, 0x8000);
      parts["body.bin"] = data.slice(0x8000);
      // Parse header fields per SMS Power Software Reference.
      const h = data.slice(0x7FF0, 0x8000);
      manifest.hasSegaHeader = true;
      manifest.headerOffset = 0x7FF0;
      manifest.checksum = h[0x0A] | (h[0x0B] << 8);
      // Product code: 5 nibbles BCD at $7FFC-$7FFE
      const pcLo = h[0x0C], pcMid = h[0x0D], pcHi = h[0x0E] & 0x0F;
      manifest.productCode = ((pcHi << 16) | (pcMid << 8) | pcLo).toString(16).toUpperCase();
      manifest.version = (h[0x0E] >> 4) & 0x0F;
      manifest.regionRomSize = h[0x0F];
      manifest.region = ({ 3: "SMS-Japan", 4: "SMS-Export", 5: "GG-Japan", 6: "GG-Export", 7: "GG-International" })[(h[0x0F] >> 4) & 0x0F] ?? "unknown";
      return { parts, manifest };
    }
  }
  // Headerless homebrew (or sub-32KB cart).
  parts["rom.bin"] = data;
  manifest.hasSegaHeader = false;
  return { parts, manifest };
}

/**
 * Split an Atari 2600 cart. No real "header" — vectors live at the end.
 * Emit body (everything except the last 6 bytes) + vectors.bin.
 */
/** Split a C64 .prg into load_address.bin (2 bytes) + body.bin. */
function extractC64(data) {
  if (data.length < 2) {
    return { parts: { "rom.bin": data }, manifest: { platform: "c64", bytes: data.length } };
  }
  const loadAddr = data[0] | (data[1] << 8);
  return {
    parts: {
      "load_address.bin": data.slice(0, 2),
      "body.bin": data.slice(2),
    },
    manifest: {
      platform: "c64",
      bytes: data.length,
      loadAddress: "$" + loadAddr.toString(16).toUpperCase().padStart(4, "0"),
      loadAddressDec: loadAddr,
      bodyBytes: data.length - 2,
    },
  };
}

function extractAtari2600(data) {
  const parts = {};
  if (data.length >= 6) {
    parts["body.bin"] = data.slice(0, data.length - 6);
    parts["vectors.bin"] = data.slice(data.length - 6);
  } else {
    parts["rom.bin"] = data;
  }
  const off = data.length - 6;
  return {
    parts,
    manifest: {
      platform: "atari2600",
      bytes: data.length,
      bankCount: data.length / 0x1000,
      vectors: data.length >= 6 ? {
        nmi:   "$" + ((data[off + 1] << 8) | data[off + 0]).toString(16).toUpperCase().padStart(4, "0"),
        reset: "$" + ((data[off + 3] << 8) | data[off + 2]).toString(16).toUpperCase().padStart(4, "0"),
        irq:   "$" + ((data[off + 5] << 8) | data[off + 4]).toString(16).toUpperCase().padStart(4, "0"),
      } : null,
    },
  };
}

/**
 * Split an Atari 7800 cart. May have a 128-byte A78 header; if present
 * emit it as a78_header.bin and body.bin separately.
 */
function extractAtari7800(data) {
  const hasHeader = data.length >= 128 &&
    data[1] === 0x41 && data[2] === 0x54 && data[3] === 0x41 &&
    data[4] === 0x52 && data[5] === 0x49 && data[6] === 0x37 &&
    data[7] === 0x38 && data[8] === 0x30 && data[9] === 0x30;
  const parts = {};
  if (hasHeader) {
    parts["a78_header.bin"] = data.slice(0, 128);
  }
  const bodyStart = hasHeader ? 128 : 0;
  if (data.length - bodyStart >= 6) {
    parts["body.bin"] = data.slice(bodyStart, data.length - 6);
    parts["vectors.bin"] = data.slice(data.length - 6);
  } else {
    parts["rom.bin"] = data.slice(bodyStart);
  }
  const off = data.length - 6;
  return {
    parts,
    manifest: {
      platform: "atari7800",
      bytes: data.length,
      hasA78Header: hasHeader,
      bodyBytes: data.length - bodyStart,
      vectors: data.length - bodyStart >= 6 ? {
        nmi:   "$" + ((data[off + 1] << 8) | data[off + 0]).toString(16).toUpperCase().padStart(4, "0"),
        reset: "$" + ((data[off + 3] << 8) | data[off + 2]).toString(16).toUpperCase().padStart(4, "0"),
        irq:   "$" + ((data[off + 5] << 8) | data[off + 4]).toString(16).toUpperCase().padStart(4, "0"),
      } : null,
    },
  };
}

// GameTank .gtr — a flat, headerless cart whose mapper is keyed by SIZE
// (8 KB EEPROM8K / 32 KB EEPROM32K / 2 MB FLASH2M). For the single-bank 32 KB
// format the 6502 vector table (NMI/RESET/IRQ) is the last 6 bytes ($FFFA), like
// the 7800. Split into body + vectors (32 KB) or just rom.bin (other sizes), and
// decode the vectors. No header to strip.
function extractGameTank(data) {
  const n = data.length;
  const mapper = n === 0x2000 ? "EEPROM8K"
    : n === 0x8000 ? "EEPROM32K"
    : n === 0x200000 ? "FLASH2M"
    : "UNKNOWN";
  const parts = {};
  let vectors = null;
  // The 32 KB single-bank format maps at $8000-$FFFF, so the CPU vector table is
  // the last 6 bytes. (FLASH2M banks the cart — the live vectors are in bank $FF,
  // also the last 6 bytes of the 2 MB image; EEPROM8K mirrors up into $FFFA too.)
  if (n >= 6) {
    parts["body.bin"] = data.slice(0, n - 6);
    parts["vectors.bin"] = data.slice(n - 6);
    const off = n - 6;
    const w = (lo) => "$" + (((data[off + lo + 1] << 8) | data[off + lo]) & 0xFFFF)
      .toString(16).toUpperCase().padStart(4, "0");
    vectors = { nmi: w(0), reset: w(2), irq: w(4) };
  } else {
    parts["rom.bin"] = data.slice(0);
  }
  return {
    parts,
    manifest: {
      platform: "gametank",
      bytes: n,
      mapper,                          // SIZE is the mapper — keep the byte count exact on re-wrap
      bodyBytes: n >= 6 ? n - 6 : n,
      vectors,
    },
  };
}

function extractGb(data, platform) {
  return {
    parts: {
      "boot.bin": data.slice(0, 0x100),
      "header.bin": data.slice(0x100, 0x150),
      "body.bin": data.slice(0x150),
    },
    manifest: {
      platform,
      // Cartridge info from the header at $0143-$0149.
      cgbFlag: data[0x143],
      cartType: data[0x147],
      romSize: data[0x148],
      ramSize: data[0x149],
    },
  };
}

export async function extractCartCore({ path: romPath, platform, outputDir, inline }) {
  const data = new Uint8Array(await readFile(romPath));
  const resolved = platform ?? (
    /\.nes$/i.test(romPath) ? "nes" :
    /\.(sfc|smc)$/i.test(romPath) ? "snes" :
    /\.(bin|md|gen)$/i.test(romPath) ? "genesis" :
    /\.gb$/i.test(romPath) ? "gb" :
    /\.gbc$/i.test(romPath) ? "gbc" :
    /\.sms$/i.test(romPath) ? "sms" :
    /\.gg$/i.test(romPath) ? "gg" :
    /\.a26$/i.test(romPath) ? "atari2600" :
    /\.a78$/i.test(romPath) ? "atari7800" :
    /\.prg$/i.test(romPath) ? "c64" :
    null
  );
  if (!resolved) {
    throw new Error(`extractCart: could not detect platform for '${romPath}'. Pass platform explicitly.`);
  }
  let result;
  switch (resolved) {
    case "nes": result = extractNes(data); break;
    case "snes": result = extractSnes(data); break;
    case "genesis":
    case "megadrive":
    case "md": result = extractGenesis(data); break;
    case "gb":
    case "gbc": result = extractGb(data, resolved); break;
    case "sms":
    case "gg": result = extractSms(data, resolved); break;
    case "atari2600":
    case "a2600": result = extractAtari2600(data); break;
    case "atari7800":
    case "a7800": result = extractAtari7800(data); break;
    case "c64":   result = extractC64(data); break;
    case "gametank":
    case "gtr":   result = extractGameTank(data); break;
    default:
      throw new Error(`extractCart: platform '${resolved}' not supported`);
  }

  // Default: write parts to disk. outputDir is REQUIRED unless inline:true.
  if (!inline) {
    if (!outputDir) {
      throw new Error("extractCart: pass outputDir (write the parts to disk, returns file paths) or inline:true (return the parts as base64 in the response).");
    }
    await mkdir(outputDir, { recursive: true });
    const filePaths = {};
    for (const [name, bytes] of Object.entries(result.parts)) {
      const out = path.join(outputDir, name);
      await writeFile(out, bytes);
      filePaths[name] = out;
    }
    await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(result.manifest, null, 2));
    filePaths["manifest.json"] = path.join(outputDir, "manifest.json");
    return {
      platform: resolved,
      sourcePath: romPath,
      sourceBytes: data.length,
      outputDir,
      files: filePaths,
      manifest: result.manifest,
    };
  }

  // Inline mode — return parts as base64.
  const inlineParts = {};
  for (const [name, bytes] of Object.entries(result.parts)) {
    inlineParts[name] = {
      bytes: Buffer.from(bytes).toString("base64"),
      length: bytes.length,
    };
  }
  return {
    platform: resolved,
    sourcePath: romPath,
    sourceBytes: data.length,
    parts: inlineParts,
    manifest: result.manifest,
  };
}

// ─── wrapRomFromParts ─────────────────────────────────────────────

/**
 * NES wrapper.s + linkerConfig template. Emits an iNES header + segments
 * for PRG (path) + CHR (path). Uses cc65's ld65 with three MEMORY blocks:
 * HEADER, PRG, CHR; one SEGMENT each.
 *
 * Caller passes:
 *   prgPath  — file path to the PRG-ROM bytes (gets INCBIN'd)
 *   chrPath  — file path to the CHR-ROM bytes (or null for CHR-RAM)
 *   mapper   — iNES mapper number (default 0 / NROM)
 *   mirror   — "horizontal" | "vertical" | "four-screen" (default horizontal)
 *   prgBanks — count of 16KB banks (default infer from prgPath size)
 *   chrBanks — count of 8KB banks (default infer; 0 for CHR-RAM)
 *   hasBattery — battery-backed SRAM (iNES flags6 bit 1); preserved on round-trip
 */
function wrapNes({ prgPath, chrPath, mapper, mirror, prgBanks, chrBanks, hasBattery }) {
  const m = mapper ?? 0;
  const mirrorFlag = mirror === "vertical" ? 1 : mirror === "four-screen" ? 8 : 0;
  const batteryFlag = hasBattery ? 0x02 : 0;
  const prg = prgPath;
  const chr = chrPath ?? null;

  // ld65 MEMORY `size` is BYTE COUNT (exclusive), not "last valid address."
  // A 16KB region is $4000 bytes, not $3FFF. NROM-128 (1 PRG bank) anchors
  // at CPU $C000 with hardware mirroring to $8000-$BFFF — vectors at
  // $FFFA-$FFFF only resolve when the bank is loaded at $C000.
  const banks = prgBanks ?? 1;
  let prgStart, prgSize;
  if (banks === 1) {
    prgStart = 0xC000;
    prgSize = 0x4000; // 16 KB
  } else if (banks === 2) {
    prgStart = 0x8000;
    prgSize = 0x8000; // 32 KB — NROM-256
  } else {
    throw new Error(
      `wrapRomFromParts[nes]: prgBanks=${banks} requires mapper-specific banking config ` +
      `that this tool doesn't synthesize yet. Supported: prgBanks=1 (NROM-128) or 2 ` +
      `(NROM-256). For larger / banked carts, write a custom linker config (and update ` +
      `wrapRomFromParts to support that mapper).`
    );
  }
  const chrBanksNum = chrBanks ?? (chr ? 1 : 0);
  const chrSize = chrBanksNum * 0x2000; // 8 KB per bank

  const hex4 = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
  const hex2 = (n) => "$" + n.toString(16).toUpperCase().padStart(2, "0");

  const wrapperSource =
`.segment "HEADER"
  .byte $4E, $45, $53, $1A     ; "NES\\x1a"
  .byte $${banks.toString(16).toUpperCase().padStart(2, "0")}    ; PRG-ROM banks (16KB each)
  .byte $${chrBanksNum.toString(16).toUpperCase().padStart(2, "0")}    ; CHR-ROM banks (8KB each; 0 = CHR-RAM)
  .byte ${hex2((m << 4 | mirrorFlag | batteryFlag) & 0xFF)}    ; mapper-lo + mirroring + battery
  .byte ${hex2(m & 0xF0)}    ; mapper-hi + NES 2.0 flags
  .byte $00, $00, $00, $00, $00, $00, $00, $00

.segment "PRG"
  .incbin "${prg}"
${chr ? `\n.segment "CHR"\n  .incbin "${chr}"\n` : ""}
`;
  // Every MEMORY block needs `file = %O` so the linked region writes to the
  // output ROM (rather than being implicitly RAM-only). cc65's stock nes.cfg
  // has this on every line; we mirrored that.
  const lines = [
    `MEMORY {`,
    `  HEADER: file = %O, start = $0000, size = $0010, fill = yes, fillval = $00;`,
    `  PRG:    file = %O, start = ${hex4(prgStart)}, size = ${hex4(prgSize)}, fill = yes, fillval = $FF;`,
  ];
  if (chrSize > 0) {
    lines.push(`  CHR:    file = %O, start = $0000, size = ${hex4(chrSize)}, fill = yes, fillval = $00;`);
  }
  lines.push(`}`);
  lines.push(`SEGMENTS {`);
  lines.push(`  HEADER: load = HEADER, type = ro;`);
  lines.push(`  PRG:    load = PRG, type = ro;`);
  if (chrSize > 0) lines.push(`  CHR:    load = CHR, type = ro;`);
  lines.push(`}`);
  const linkerConfig = lines.join("\n") + "\n";
  return { wrapperSource, linkerConfig };
}

/**
 * Genesis wrapper template. Genesis just needs vectors + header + body
 * concatenated in a flat ROM. We emit a vasm68k wrapper that incbins each.
 */
function wrapGenesis({ vectorsPath, headerPath, bodyPath }) {
  const wrapperSource =
`\torg $000000
\tincbin "${vectorsPath}"
\torg $000100
\tincbin "${headerPath}"
\torg $000200
\tincbin "${bodyPath}"
`;
  return { wrapperSource, linkerConfig: null };
}

/**
 * SNES wrapper template. Just concatenate the copier_header (if any) + the
 * rom body. Emit an asar wrapper that uses incbin.
 */
function wrapSnes({ copierHeaderPath, romPath }) {
  let src = "";
  if (copierHeaderPath) src += `incbin "${copierHeaderPath}"\n`;
  src += `incbin "${romPath}"\n`;
  return { wrapperSource: src, linkerConfig: null };
}

/**
 * Game Boy wrapper template. Concatenate boot + header + body. Emit an
 * rgbasm wrapper using INCBIN.
 */
/**
 * SMS / Game Gear wrapper template. Emits sdasz80 source that concats the
 * pre-header code + sega header + body via .incbin into a flat output.
 *
 *   preHeaderPath  — code in $0000-$7FEF
 *   headerPath     — 16-byte sega header at $7FF0
 *   bodyPath       — banked region from $8000 onwards
 *
 * Sub-32KB carts can pass `rom.bin` as `bodyPath` and omit preHeader/header.
 */
function wrapSms({ preHeaderPath, headerPath, bodyPath, romPath }) {
  if (romPath) {
    // Headerless / sub-32KB path.
    const wrapperSource =
`\t.module sms_wrap
\t.area _CODE (ABS)
\t.org 0x0000
\t.incbin "${romPath}"
`;
    return { wrapperSource, linkerConfig: null };
  }
  const wrapperSource =
`\t.module sms_wrap
\t.area _CODE (ABS)
\t.org 0x0000
\t.incbin "${preHeaderPath ?? "pre_header.bin"}"
\t.org 0x7FF0
\t.incbin "${headerPath ?? "sega_header.bin"}"
\t.org 0x8000
\t.incbin "${bodyPath ?? "body.bin"}"
`;
  return { wrapperSource, linkerConfig: null };
}

/**
 * Atari 2600 wrapper. Just concatenate body + vectors at the right org
 * (top of 4KB bank). Caller can pass bodyPath + vectorsPath (from
 * extractCart) OR romPath for a one-shot incbin.
 */
function wrapAtari2600({ bodyPath, vectorsPath, romPath }) {
  if (romPath) {
    const wrapperSource =
`\t.org $F000
\t.incbin "${romPath}"
`;
    return { wrapperSource, linkerConfig: null };
  }
  const wrapperSource =
`\t.org $F000
\t.incbin "${bodyPath ?? "body.bin"}"
\t.org $FFFA
\t.incbin "${vectorsPath ?? "vectors.bin"}"
`;
  return { wrapperSource, linkerConfig: null };
}

/**
 * Atari 7800 wrapper. Optional 128-byte A78 header (kept if extractCart
 * found one), then body anchored to (0x10000 - bodyBytes), then vectors
 * at $FFFA.
 */
function wrapAtari7800({ a78HeaderPath, bodyPath, vectorsPath, romPath, bodyBytes }) {
  if (romPath) {
    const wrapperSource =
`\t.org $4000
\t.incbin "${romPath}"
`;
    return { wrapperSource, linkerConfig: null };
  }
  const bodyOrg = 0x10000 - 6 - (bodyBytes ?? 0xC000);
  const hexOrg = "$" + bodyOrg.toString(16).toUpperCase().padStart(4, "0");
  let src = "";
  if (a78HeaderPath) {
    src += `\t; A78 header (not part of the 6502 image — emitted at file start)\n`;
    src += `\t.incbin "${a78HeaderPath}"\n`;
  }
  src += `\t.org ${hexOrg}\n`;
  src += `\t.incbin "${bodyPath ?? "body.bin"}"\n`;
  src += `\t.org $FFFA\n`;
  src += `\t.incbin "${vectorsPath ?? "vectors.bin"}"\n`;
  return { wrapperSource: src, linkerConfig: null };
}

function wrapGb({ bootPath, headerPath, bodyPath }) {
  const wrapperSource =
`SECTION "boot", ROM0[$0000]
  INCBIN "${bootPath}"
SECTION "header", ROM0[$0100]
  INCBIN "${headerPath}"
SECTION "body", ROM0[$0150]
  INCBIN "${bodyPath}"
`;
  return { wrapperSource, linkerConfig: null };
}

export async function wrapRomFromPartsCore(args) {
  const { platform } = args;
  switch (platform) {
    case "nes": return wrapNes(args);
    case "snes": return wrapSnes(args);
    case "genesis":
    case "megadrive":
    case "md": return wrapGenesis(args);
    case "gb":
    case "gbc": return wrapGb(args);
    case "sms":
    case "gg": return wrapSms(args);
    case "atari2600":
    case "a2600": return wrapAtari2600(args);
    case "atari7800":
    case "a7800": return wrapAtari7800(args);
    case "c64":   return wrapC64(args);
    case "gametank":
    case "gtr":   return wrapGameTank(args);
    default:
      throw new Error(`wrapRomFromParts: platform '${platform}' not supported`);
  }
}

/**
 * Wrap C64 parts back into a .prg. Just emits a vasm/ca65 wrapper that
 * sets the load address and includes the body.
 */
function wrapC64({ loadAddress, bodyPath, romPath }) {
  if (romPath) {
    const wrapperSource =
`; C64 .prg wrapper — reassembles a prebuilt body.
        .org    $${(loadAddress ?? 0x0801).toString(16).toUpperCase()}
        .incbin "${romPath}"
`;
    return { wrapperSource, linkerConfig: null };
  }
  const wrapperSource =
`; C64 .prg wrapper — load_address.bin is the 2-byte little-endian
; load address, body.bin is the program bytes that follow.
        .incbin "load_address.bin"
        .incbin "${bodyPath ?? "body.bin"}"
`;
  return { wrapperSource, linkerConfig: null };
}

/**
 * Wrap GameTank parts back into a flat .gtr. body.bin + vectors.bin (6 bytes at
 * the end) → a size-keyed image (default 32 KB EEPROM32K). The mapper IS the
 * size, so the wrapper PADS to exactly romSize (default $8000) with the vectors
 * forced to the last 6 bytes. Emits a ca65 source that .incbin's the body, pads,
 * then .incbin's the vectors at $FFFA — assemble+link with the gametank preset,
 * or just `cat body.bin <pad> vectors.bin` to the exact size.
 */
function wrapGameTank({ bodyPath, vectorsPath, romPath, romSize }) {
  if (romPath) {
    // already-flat image — just (re)assert the size by including it verbatim.
    const wrapperSource =
`; GameTank .gtr wrapper — a prebuilt flat image (size = mapper).
        .incbin "${romPath}"
`;
    return { wrapperSource, linkerConfig: null };
  }
  const size = romSize ?? 0x8000;          // default EEPROM32K
  const body = bodyPath ?? "body.bin";
  const vecs = vectorsPath ?? "vectors.bin";
  // ca65: body at the start of the ROM segment, the 6-byte vector table pinned to
  // $FFFA. The gametank single-bank linker cfg (or a flat cat) places these so the
  // final image is exactly `size` bytes with the vectors last.
  const wrapperSource =
`; GameTank .gtr wrapper (size-keyed mapper; default EEPROM32K = $${size.toString(16).toUpperCase()} bytes).
; body.bin = code/data ($8000..), vectors.bin = the 6-byte NMI/RESET/IRQ table at $FFFA.
.segment "STARTUP"
        .incbin "${body}"
.segment "VECTORS"
        .incbin "${vecs}"
`;
  return { wrapperSource, linkerConfig: "single-bank", romSize: size };
}

// ─── MCP registration ─────────────────────────────────────────────

export function registerCartPartsTools(server, z) {
  server.tool(
    "cart",
    "Cartridge container ops — identify / split / reassemble a ROM file. `op`: 'identify' | 'extract' | 'wrap' | 'packDisk'.\n" +
    "'identify': sniff an unknown ROM/zip's platform (which core to load). Handles zip-wrapped ROMs; `path` OR " +
    "`base64` (+`hint` ext for headerless). Returns {platform, format, title, mapper, region, sizes, confidence}. " +
    "RE next steps: cheats({op:'lookup'}) is a free labeled memory/code map; disasm is how you change behavior.\n" +
    "'extract': split a ROM into its standard parts + a manifest (auto-detects format from extension, no `dd skip=`). " +
    "Per platform: NES header/prg/chr/trainer (+mapper/mirroring); SNES copier-header/rom/internal-header; " +
    "Genesis vectors/header/body; GB/GBC boot/header/body; SMS/GG pre-header/sega-header/body; " +
    "Atari 2600/7800 body/vectors (7800 +A78 header); C64 load-address/body. path-or-inline. " +
    "Round-trips with 'wrap' (extract → romPatch a part → wrap → build).\n" +
    "'wrap': generate a build-ready wrapper source (+ NES linker config; null for other platforms) that reassembles " +
    "parts back into a cart. NES auto-generates the iNES header from mapper+mirror (chrPath:null for CHR-RAM; only " +
    "prgBanks 1/2 = NROM-128/256). Per-platform part paths in the param hints (pass `romPath` for a one-shot whole-body incbin).\n" +
    "'packDisk' (C64): wrap a built `.prg` (`prgPath` or `base64`) into a distributable, autostart-able `.d64` disk " +
    "image — the format the new Commodore 64 Ultimate hardware and the homebrew/demo scene actually load. " +
    "Writes `<prg>.d64` (or `outputPath`/`inline`). loadMedia({platform:'c64', path:<.d64>}) boots it directly. " +
    "(extract on a `.d64` lists its directory; pass `name` to pull one file off the disk.)",
    {
      op: z.enum(["identify", "extract", "wrap", "packDisk"]).describe("identify the ROM's platform; extract into parts (or list/pull files from a C64 .d64); wrap parts back into a cart; packDisk wraps a C64 .prg into a distributable .d64 disk image."),
      // identify
      path: z.string().optional().describe("op=identify/extract: absolute path to the ROM file."),
      base64: z.string().optional().describe("op=identify: base64 ROM bytes (OR path)."),
      hint: z.string().optional().describe("op=identify: with base64, filename extension (e.g. '.nes') to disambiguate headerless formats."),
      // extract / wrap
      platform: z.enum(["nes", "snes", "genesis", "megadrive", "md", "gb", "gbc", "sms", "gg", "atari2600", "a2600", "atari7800", "a7800", "c64"]).optional().describe("op=extract: override detection. op=wrap: REQUIRED — the target platform."),
      outputDir: z.string().optional().describe("op=extract: directory to write the parts (+ manifest.json). Required unless inline:true."),
      inline: z.boolean().default(false).describe("op=extract: return the parts as base64 instead of writing to disk."),
      // wrap — NES
      prgPath: z.string().optional().describe("op=wrap NES: path to PRG bytes."),
      chrPath: z.string().nullable().optional().describe("op=wrap NES: path to CHR bytes; null for CHR-RAM carts."),
      mapper: z.number().int().min(0).max(255).optional().describe("op=wrap NES: iNES mapper number (default 0 NROM)."),
      mirror: z.enum(["horizontal", "vertical", "four-screen"]).optional().describe("op=wrap NES: nametable mirroring."),
      prgBanks: z.number().int().min(1).max(255).optional().describe("op=wrap NES: PRG bank count (16KB each); only 1 (NROM-128) or 2 (NROM-256) supported, default 1."),
      chrBanks: z.number().int().min(0).max(255).optional().describe("op=wrap NES: CHR bank count (8KB each); 0 = CHR-RAM."),
      hasBattery: z.boolean().optional().describe("op=wrap NES: set the iNES battery-backed-SRAM flag (flags6 bit 1). Pass the value from extractCart's manifest.hasBattery for a byte-exact round-trip."),
      // wrap — SNES
      romPath: z.string().optional().describe("op=wrap SNES/SMS/GG/Atari 2600/Atari 7800/C64: whole-ROM body for a one-shot incbin (skips the per-part paths)."),
      copierHeaderPath: z.string().optional().describe("op=wrap SNES: path to a 512B copier header to prepend."),
      // wrap — Genesis / GB / SMS-GG / Atari / C64
      headerPath: z.string().optional().describe("op=wrap Genesis/GB/SMS/GG: header bytes."),
      bodyPath: z.string().optional().describe("op=wrap Genesis/GB/SMS/GG/Atari 2600/Atari 7800/C64: ROM body."),
      bootPath: z.string().optional().describe("op=wrap GB/GBC: boot/jump bytes at $0000-$00FF."),
      preHeaderPath: z.string().optional().describe("op=wrap SMS/GG: code in $0000-$7FEF (required for 32KB+ standard-header carts)."),
      vectorsPath: z.string().optional().describe("op=wrap Genesis (256B vector table) / Atari 2600,7800 (6-byte vectors at $FFFA-$FFFF)."),
      a78HeaderPath: z.string().optional().describe("op=wrap Atari 7800: the 128-byte A78 header (if present)."),
      bodyBytes: z.number().int().min(1).optional().describe("op=wrap Atari 7800: size of the 6502 image body (computes the cart origin; default 0xC000)."),
      loadAddress: z.number().int().min(0).max(0xFFFF).optional().describe("op=wrap C64: load address (default 0x0801)."),
      // packDisk (C64 .d64)
      name: z.string().optional().describe("op=packDisk: disk file name (PETSCII, ≤16 chars; default from prgPath). op=extract .d64: a file to pull off the disk."),
      diskName: z.string().optional().describe("op=packDisk: disk label (≤16 chars; default = name)."),
      outputPath: z.string().optional().describe("op=extract: dir for parts (+ manifest.json). op=packDisk: .d64 output path (default: prgPath with a .d64 extension). Required unless inline:true."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "identify": return await identifyRomCore(args);
        case "extract": {
          if (!args.path) throw new Error("cart({op:'extract'}): `path` is required.");
          // A .d64 is a disk image (a container of files), not a flat cart —
          // route it to the disk reader so extract lists/pulls its contents.
          if (/\.d64$/i.test(args.path)) return jsonContent(await extractDiskCore(args));
          return jsonContent(await extractCartCore(args));
        }
        case "wrap": {
          if (!args.platform) throw new Error("cart({op:'wrap'}): `platform` is required.");
          return jsonContent(await wrapRomFromPartsCore(args));
        }
        case "packDisk": return jsonContent(await packDiskCore(args));
        default: throw new Error(`cart: unknown op '${args.op}'`);
      }
    }),
  );
}

