// diffRoms — compare two ROMs of the same platform, return per-region
// change summary with mapper-aware CPU address translation.
//
// Why this is more than `cmp -l`: `cmp` reports octal file offsets and
// nothing else. ROM hackers need CPU addresses (so the diff is meaningful
// against a disassembly), region labels (PRG vs CHR vs header), and tile
// indices (so sprite hacks are immediately recognizable).
//
// Per-platform region detection lives here; CPU-address translation
// reuses the same logic as disassembleRom's mapper math.

import { readFile } from "node:fs/promises";

const MAX_CONTIGUOUS_GAP = 16;

/**
 * Compute per-region byte ranges for a ROM. Returns an array of
 * { region, fileStart, fileEnd, kind, mapper? } where `region` is a label
 * and `kind` is "header" | "code" | "graphics" | "data".
 *
 * The CPU-address translator (cpuAddressFor) is region-aware: it uses
 * the iNES/SNES/Genesis convention for the matching region.
 */
function regionMapForRom(platform, data) {
  switch (platform) {
    case "nes": return regionMapNes(data);
    case "snes": return regionMapSnes(data);
    case "genesis":
    case "megadrive":
    case "md": return regionMapGenesis(data);
    case "gb":
    case "gbc": return regionMapGb(data);
    case "sms":
    case "gg": return regionMapSms(data, platform);
    case "atari2600":
    case "a2600": return regionMapA2600(data);
    case "atari7800":
    case "a7800": return regionMapA7800(data);
    case "c64":  return regionMapC64(data);
    default:
      return [{ region: "ROM", fileStart: 0, fileEnd: data.length, kind: "rom" }];
  }
}

/**
 * SMS / Game Gear cart region map. Most carts use the Sega mapper —
 * the cartridge header lives at $7FF0-$7FFF (last 16 bytes of the first
 * 32 KB bank). No fixed CHR/PRG split — code + tile data + tilemaps
 * live anywhere the developer wants. We tag the header so diffs there
 * are obvious.
 */
function regionMapSms(data, _platform) {
  const regions = [];
  // Header lives at $7FF0 IF the file is at least 32 KB. Some homebrew
  // skips the header entirely (just runs from $0000) — flag with kind
  // "code" then.
  if (data.length >= 0x8000) {
    const magic = String.fromCharCode(data[0x7FF0], data[0x7FF1], data[0x7FF2], data[0x7FF3],
                                       data[0x7FF4], data[0x7FF5], data[0x7FF6], data[0x7FF7]);
    const hasHeader = magic === "TMR SEGA";
    if (hasHeader) {
      regions.push({ region: "code_pre_header", fileStart: 0, fileEnd: 0x7FF0, kind: "code" });
      regions.push({ region: "sega_header", fileStart: 0x7FF0, fileEnd: 0x8000, kind: "header" });
      regions.push({ region: "ROM", fileStart: 0x8000, fileEnd: data.length, kind: "code" });
      return regions;
    }
  }
  regions.push({ region: "ROM", fileStart: 0, fileEnd: data.length, kind: "code", note: "no SEGA header detected" });
  return regions;
}

function regionMapNes(data) {
  if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) {
    return [{ region: "ROM", fileStart: 0, fileEnd: data.length, kind: "rom" }];
  }
  const prgBanks = data[4];
  const chrBanks = data[5];
  const prgSize = prgBanks * 16384;
  const chrSize = chrBanks * 8192;
  const regions = [
    { region: "header", fileStart: 0, fileEnd: 16, kind: "header" },
    { region: "PRG", fileStart: 16, fileEnd: 16 + prgSize, kind: "code", mapper: prgSize === 16384 ? "NROM-128" : "NROM-256" },
  ];
  if (chrSize > 0) {
    regions.push({ region: "CHR", fileStart: 16 + prgSize, fileEnd: 16 + prgSize + chrSize, kind: "graphics" });
  }
  return regions;
}

function regionMapSnes(data) {
  const copierOff = (data.length % 0x8000 === 0x200) ? 0x200 : 0;
  const loMapper = data[copierOff + 0x7FC0 + 0x15];
  const hiMapper = data[copierOff + 0xFFC0 + 0x15];
  const isLo = loMapper === 0x20 || loMapper === 0x30 || loMapper === 0x32;
  const isHi = hiMapper === 0x21 || hiMapper === 0x31;
  const mapper = isLo ? "LoROM" : isHi ? "HiROM" : "LoROM (assumed)";
  const regions = [];
  if (copierOff) {
    regions.push({ region: "copier_header", fileStart: 0, fileEnd: copierOff, kind: "header" });
  }
  regions.push({ region: "ROM", fileStart: copierOff, fileEnd: data.length, kind: "code", mapper });
  return regions;
}

function regionMapGenesis(data) {
  // Genesis: $0000-$00FF = M68K vector table; $0100-$01FF = ROM header;
  // $0200+ = code/data. No header byte we can rely on for size; entire
  // file is mapped 1:1 to CPU $000000-$3FFFFF (up to 4MB).
  const regions = [
    { region: "vectors", fileStart: 0, fileEnd: 0x100, kind: "header" },
    { region: "header", fileStart: 0x100, fileEnd: 0x200, kind: "header" },
    { region: "ROM", fileStart: 0x200, fileEnd: data.length, kind: "code" },
  ];
  return regions;
}

/**
 * Atari 2600 cart region map. Bare cart image — no header. 2K/4K/8K/16K/
 * 32K carts are common; bank switching ($F8/$E0/etc) is handled by the
 * mapper at runtime, not in the file. Tag the last 6 bytes as the
 * vector table.
 */
/**
 * C64 .prg region map: 2-byte load address + program body. .crt cart format
 * is not yet handled (would need to parse the C64 cartridge header).
 */
function regionMapC64(data) {
  if (data.length < 2) {
    return [{ region: "ROM", fileStart: 0, fileEnd: data.length, kind: "code" }];
  }
  const loadAddr = data[0] | (data[1] << 8);
  return [
    { region: "load_address", fileStart: 0, fileEnd: 2, kind: "header",
      note: "C64 .prg: 2-byte little-endian load address = $" + loadAddr.toString(16).toUpperCase() },
    { region: "ROM", fileStart: 2, fileEnd: data.length, kind: "code" },
  ];
}

function regionMapA2600(data) {
  const regions = [];
  if (data.length >= 6) {
    regions.push({ region: "ROM", fileStart: 0, fileEnd: data.length - 6, kind: "code" });
    regions.push({ region: "vectors", fileStart: data.length - 6, fileEnd: data.length, kind: "header" });
  } else {
    regions.push({ region: "ROM", fileStart: 0, fileEnd: data.length, kind: "code" });
  }
  return regions;
}

/**
 * Atari 7800 cart region map. May have a 128-byte "A78" header. The body
 * is straight ROM mapped at the top of the 6502 address space.
 */
function regionMapA7800(data) {
  const hasHeader = data.length >= 128 &&
    data[1] === 0x41 && data[2] === 0x54 && data[3] === 0x41 &&
    data[4] === 0x52 && data[5] === 0x49 && data[6] === 0x37 &&
    data[7] === 0x38 && data[8] === 0x30 && data[9] === 0x30;
  const regions = [];
  const dataStart = hasHeader ? 128 : 0;
  if (hasHeader) {
    regions.push({ region: "a78_header", fileStart: 0, fileEnd: 128, kind: "header" });
  }
  if (data.length - dataStart >= 6) {
    regions.push({ region: "ROM", fileStart: dataStart, fileEnd: data.length - 6, kind: "code" });
    regions.push({ region: "vectors", fileStart: data.length - 6, fileEnd: data.length, kind: "header" });
  } else {
    regions.push({ region: "ROM", fileStart: dataStart, fileEnd: data.length, kind: "code" });
  }
  return regions;
}

function regionMapGb(data) {
  // Game Boy: $0000-$3FFF = bank 0 fixed; $4000+ = bankable. Header at
  // $0100-$014F (logo + title + cart info).
  const regions = [
    { region: "header", fileStart: 0x100, fileEnd: 0x150, kind: "header" },
  ];
  // Wrap the rest as ROM with implicit bank boundary at $4000.
  regions.unshift({ region: "boot", fileStart: 0, fileEnd: 0x100, kind: "code" });
  regions.push({ region: "ROM", fileStart: 0x150, fileEnd: data.length, kind: "code" });
  return regions;
}

/**
 * Given a file offset and the region map, return the matching region +
 * the CPU address for the offset (or null if region has no CPU mapping).
 */
function cpuAddressFor(platform, data, fileOffset, regions) {
  const region = regions.find((r) => fileOffset >= r.fileStart && fileOffset < r.fileEnd);
  if (!region) return { region: null, cpu: null };
  switch (platform) {
    case "nes": {
      if (region.region === "PRG") {
        const prgSize = region.fileEnd - region.fileStart;
        const offInPrg = fileOffset - region.fileStart;
        // NROM-128 mirrors at $C000; we report the canonical address
        // (the upper bank for 16KB carts, since that's where the reset
        // vector at $FFFC points). NROM-256 → linear $8000-$FFFF.
        const cpu = prgSize === 16384
          ? 0xC000 + offInPrg
          : 0x8000 + offInPrg;
        return { region: region.region, kind: region.kind, cpu, mapper: region.mapper };
      }
      if (region.region === "CHR") {
        const offInChr = fileOffset - region.fileStart;
        // CHR is at PPU $0000+, addressed via PPU, but most useful for
        // ROM hackers as "tile index" — each tile is 16 bytes.
        const tile = Math.floor(offInChr / 16);
        return { region: region.region, kind: region.kind, cpu: null, ppu: offInChr, tile };
      }
      return { region: region.region, kind: region.kind, cpu: null };
    }
    case "snes": {
      if (region.region !== "ROM") return { region: region.region, kind: region.kind, cpu: null };
      const copierOff = regions.find((r) => r.region === "copier_header")?.fileEnd ?? 0;
      const rel = fileOffset - copierOff;
      const isLo = region.mapper.startsWith("LoROM");
      let cpu;
      if (isLo) {
        const bank = Math.floor(rel / 0x8000) & 0xFF;
        const addr = 0x8000 + (rel & 0x7FFF);
        cpu = (bank << 16) | addr;
      } else {
        const bank = (Math.floor(rel / 0x10000) | 0xC0) & 0xFF;
        const addr = rel & 0xFFFF;
        cpu = (bank << 16) | addr;
      }
      return { region: region.region, kind: region.kind, cpu, mapper: region.mapper };
    }
    case "genesis":
    case "megadrive":
    case "md": {
      return { region: region.region, kind: region.kind, cpu: fileOffset };
    }
    case "gb":
    case "gbc": {
      if (fileOffset < 0x4000) return { region: region.region, kind: region.kind, cpu: fileOffset };
      const bank = Math.floor(fileOffset / 0x4000);
      const addr = 0x4000 + (fileOffset & 0x3FFF);
      return { region: region.region, kind: region.kind, cpu: addr, bank };
    }
    case "c64": {
      // .prg: file[0..1] = load address, body starts at file[2].
      if (fileOffset < 2) return { region: region.region, kind: region.kind, cpu: null };
      const loadAddr = data[0] | (data[1] << 8);
      return { region: region.region, kind: region.kind, cpu: loadAddr + (fileOffset - 2) };
    }
    case "atari2600":
    case "a2600": {
      // 2600 cart maps to top of 4 KB bank ($F000-$FFFF). For 4 KB carts
      // file offset 0 = $F000. For larger banked carts each 4 KB bank also
      // sits at $F000 when switched in; we report the canonical
      // "as-if-bank-0" CPU address.
      const off = fileOffset & 0x0FFF;
      const cpu = 0xF000 + off;
      const bank = Math.floor(fileOffset / 0x1000);
      return { region: region.region, kind: region.kind, cpu, bank };
    }
    case "atari7800":
    case "a7800": {
      // 7800: cart sits at top of 64KB. Header (if any) is skipped.
      const hasHeader = regions[0]?.region === "a78_header";
      const dataStart = hasHeader ? 128 : 0;
      const rel = fileOffset - dataStart;
      if (rel < 0) return { region: region.region, kind: region.kind, cpu: null };
      // Cart mapped at $C000-$FFFF for 16 KB, $8000-$FFFF for 32 KB,
      // $4000-$FFFF for 48 KB. We anchor to the end of address space.
      const totalRom = data.length - dataStart;
      const cpu = (0x10000 - totalRom) + rel;
      return { region: region.region, kind: region.kind, cpu };
    }
    case "sms":
    case "gg": {
      // SMS sega mapper: file offset 0..$3FFF maps 1:1 to CPU $0000-$3FFF
      // (slot 0 — typically bank 0 fixed). File offset $4000..$7FFF maps
      // to CPU $4000-$7FFF (slot 1, swappable but bank 1 by default).
      // Above $8000, file offset corresponds to slot 2 (CPU $8000-$BFFF,
      // 16 KB bank-switched) — we report the slot-2 CPU address with the
      // bank index so the agent can compute.
      if (fileOffset < 0x4000) {
        return { region: region.region, kind: region.kind, cpu: fileOffset };
      }
      if (fileOffset < 0x8000) {
        return { region: region.region, kind: region.kind, cpu: fileOffset };
      }
      const bank = Math.floor(fileOffset / 0x4000);
      const addr = 0x8000 + (fileOffset & 0x3FFF);
      return { region: region.region, kind: region.kind, cpu: addr, bank };
    }
    default:
      return { region: region.region, kind: region.kind, cpu: fileOffset };
  }
}

function hex(n, width) {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

function bytesHex(arr) {
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

/**
 * Group per-byte differences into contiguous runs. Runs separated by
 * fewer than MAX_CONTIGUOUS_GAP unchanged bytes are merged so the
 * output stays compact for noisy diffs.
 */
function groupChanges(a, b, length) {
  const changes = [];
  let i = 0;
  while (i < length) {
    if (a[i] === b[i]) { i++; continue; }
    let start = i;
    let end = i + 1;
    let gap = 0;
    while (end < length && gap < MAX_CONTIGUOUS_GAP) {
      if (a[end] !== b[end]) { gap = 0; end++; }
      else { gap++; end++; }
    }
    end -= gap;
    changes.push({ start, end });
    i = end;
  }
  return changes;
}

export async function diffRomsCore({ platform, aPath, bPath, maxChangesReturned = 256 }) {
  const a = new Uint8Array(await readFile(aPath));
  const b = new Uint8Array(await readFile(bPath));
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  const sameSize = a.length === b.length;
  const regions = regionMapForRom(platform, a);

  const runs = groupChanges(a, b, minLen);
  const totalBytesDifferent = runs.reduce((acc, r) => acc + (r.end - r.start), 0);

  const changes = runs.slice(0, maxChangesReturned).map(({ start, end }) => {
    const before = a.slice(start, end);
    const after = b.slice(start, end);
    const map = cpuAddressFor(platform, a, start, regions);
    return {
      fileOffset: hex(start, 6),
      length: end - start,
      ...(map.region ? { region: map.region } : {}),
      ...(map.kind ? { kind: map.kind } : {}),
      ...(map.cpu != null ? { cpuAddress: hex(map.cpu, platform === "snes" ? 6 : 4) } : {}),
      ...(map.bank != null ? { bank: map.bank } : {}),
      ...(map.ppu != null ? { ppuAddress: hex(map.ppu, 4) } : {}),
      ...(map.tile != null ? { tile: map.tile } : {}),
      ...(map.mapper ? { mapper: map.mapper } : {}),
      before: bytesHex(before),
      after: bytesHex(after),
    };
  });

  // Per-region change tallies for quick "where's the action" overview.
  const byRegion = {};
  for (const run of runs) {
    const r = regions.find((reg) => run.start >= reg.fileStart && run.start < reg.fileEnd);
    const name = r?.region ?? "unknown";
    byRegion[name] = (byRegion[name] ?? 0) + (run.end - run.start);
  }

  return {
    platform,
    a: { path: aPath, size: a.length },
    b: { path: bPath, size: b.length },
    sameSize,
    sizeDelta: b.length - a.length,
    totalRunsDifferent: runs.length,
    totalBytesDifferent,
    bytesByRegion: byRegion,
    regions: regions.map((r) => ({
      region: r.region,
      fileStart: hex(r.fileStart, 6),
      fileEnd: hex(r.fileEnd, 6),
      kind: r.kind,
      ...(r.mapper ? { mapper: r.mapper } : {}),
    })),
    changes,
    truncated: runs.length > maxChangesReturned
      ? `${runs.length - maxChangesReturned} more change runs not shown (raise maxChangesReturned to see them).`
      : undefined,
    notes: minLen < maxLen
      ? `ROMs differ in size (${a.length} vs ${b.length} bytes); diff stops at the shorter length. ${maxLen - minLen} trailing bytes in the larger ROM are not compared.`
      : undefined,
  };
}

// diffRoms folded into the `romPatch` tool (romPatch({op:'diff'}), rom-id.js,
// which imports diffRomsCore). Nothing registered here.
export function registerDiffRomsTools() {}
