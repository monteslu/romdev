// getRenderingContext — decode the current PPU/VDP state into structured
// fields + a universal English summary. The big win: tell the agent which
// CHR bank the BG and sprites are fetching from RIGHT NOW, plus the file
// offset so direct patchFile works first-try.
//
// NES uses fceumm's `nes_ppu_regs` 4-byte region (PPU[0..3] = PPUCTRL,
// PPUMASK, PPUSTATUS, OAMADDR). Other platforms TBD — the call shape is
// already universal, so adding SNES/Genesis/GB is a future incremental.

import { readFileSync } from "node:fs";
import { getHost } from "../state.js";
import { jsonContent, safeTool, unsupported } from "../util.js";
import { inspectBackgroundMapCore } from "./platform-tools.js";
import { whichTilesAreRenderedCore } from "./which-tiles.js";

/**
 * Decode the active rendering context for NES. Returns {nes: {...}, summary, area}.
 */
function nesContext(host, area) {
  // PPU[4]: byte 0 = PPUCTRL, byte 1 = PPUMASK, byte 2 = PPUSTATUS, byte 3 = OAMADDR.
  const ppu = host.readMemory("nes_ppu_regs", 0, 4);
  const ppuctrl = ppu[0];
  const ppumask = ppu[1];
  const ppustatus = ppu[2];
  const oamaddr = ppu[3];

  // PPUCTRL bits:
  //   0-1: base nametable address (00=$2000, 01=$2400, 10=$2800, 11=$2C00)
  //   2:   VRAM increment (0 = +1 across, 1 = +32 down)
  //   3:   sprite pattern table base (0 = $0000, 1 = $1000) — for 8x8 sprites only
  //   4:   BG pattern table base (0 = $0000, 1 = $1000)
  //   5:   sprite size (0 = 8x8, 1 = 8x16; for 8x16 the bit is per-tile)
  //   7:   NMI enable on vblank
  const baseNametable = ppuctrl & 0x03;
  const vramIncrement = (ppuctrl & 0x04) ? 32 : 1;
  const spritePatternBank = (ppuctrl & 0x08) ? 1 : 0;
  const bgPatternBank = (ppuctrl & 0x10) ? 1 : 0;
  const spriteHeight = (ppuctrl & 0x20) ? 16 : 8;
  const nmiEnabled = !!(ppuctrl & 0x80);

  // PPUMASK bits:
  //   0: grayscale
  //   1: show BG in leftmost 8px
  //   2: show sprites in leftmost 8px
  //   3: BG visible
  //   4: sprites visible
  //   5-7: emphasis bits (red/green/blue)
  const grayscale = !!(ppumask & 0x01);
  const bgLeftmost = !!(ppumask & 0x02);
  const spritesLeftmost = !!(ppumask & 0x04);
  const bgVisible = !!(ppumask & 0x08);
  const spritesVisible = !!(ppumask & 0x10);
  const emphasisBits = (ppumask >> 5) & 0x07;
  const emphasisNames = ["red", "green", "blue"];
  const emphasis = emphasisBits === 0
    ? "none"
    : emphasisNames.filter((_, i) => emphasisBits & (1 << i)).join("+");

  // PPUSTATUS bits (read-only state, useful for "where in the frame are we"):
  //   5: sprite overflow
  //   6: sprite 0 hit
  //   7: vblank flag
  const spriteOverflow = !!(ppustatus & 0x20);
  const sprite0Hit = !!(ppustatus & 0x40);
  const vblank = !!(ppustatus & 0x80);

  // CHR file offset math — works for NROM (mapper 0) directly. For banked
  // mappers (MMC1/MMC3/etc.) the agent should treat this as the offset
  // RELATIVE to whatever CHR bank is currently mapped; the live bytes
  // returned by readMemory("nes_chr", ...) already reflect banking.
  const status = host.getStatus();
  let chrBaseInFile = null;
  let mapperNum = null;
  if (status.mediaPath) {
    try {
      // Sniff iNES header from disk to compute CHR base offset.
      const data = readFileSync(status.mediaPath);
      if (data[0] === 0x4e && data[1] === 0x45 && data[2] === 0x53 && data[3] === 0x1a) {
        const prgBanks = data[4];
        const chrBanks = data[5];
        mapperNum = ((data[6] >> 4) & 0xF) | (data[7] & 0xF0);
        if (chrBanks > 0) {
          chrBaseInFile = 16 + prgBanks * 16384;
        }
      }
    } catch {
      // Bytes-loaded ROM (no path) — leave file offset null.
    }
  }

  const bgPatternPpuBase = bgPatternBank * 0x1000;
  const spritePatternPpuBase = spritePatternBank * 0x1000;
  const bgChrFileOffset = chrBaseInFile != null ? chrBaseInFile + bgPatternPpuBase : null;
  const spriteChrFileOffset = chrBaseInFile != null ? chrBaseInFile + spritePatternPpuBase : null;

  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `BG is fetching from CHR bank ${bgPatternBank} (PPU $${bgPatternPpuBase.toString(16).toUpperCase().padStart(4,"0")}` +
      (bgChrFileOffset != null
        ? `, file offset 0x${bgChrFileOffset.toString(16).toUpperCase()}`
        : `, file offset unknown — no mediaPath or CHR-RAM cart`) +
      `)`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Sprites are fetching from CHR bank ${spritePatternBank} (PPU $${spritePatternPpuBase.toString(16).toUpperCase().padStart(4,"0")}` +
      (spriteChrFileOffset != null
        ? `, file offset 0x${spriteChrFileOffset.toString(16).toUpperCase()}`
        : `, file offset unknown`) +
      `, ${spriteHeight}px tall)`
    );
  }
  if (area === "all") {
    const ntAddr = 0x2000 + baseNametable * 0x400;
    summary.push(
      `Active nametable: $${ntAddr.toString(16).toUpperCase()} (index ${baseNametable})`
    );
    summary.push(
      `BG ${bgVisible ? "visible" : "OFF"}, sprites ${spritesVisible ? "visible" : "OFF"}, NMI ${nmiEnabled ? "enabled" : "off"}` +
      (vblank ? ", currently in vblank" : "")
    );
    if (mapperNum != null && mapperNum !== 0) {
      summary.push(
        `iNES mapper ${mapperNum} — for banked-CHR mappers (MMC1/MMC3/etc.), the file-offset answer above ` +
        `assumes the active CHR bank covers PPU $0000-$1FFF. If your mapper does 1KB/2KB bank switching, ` +
        `treat the live readMemory('nes_chr', 0, 8192) bytes as authoritative.`
      );
    }
  }

  return {
    platform: "nes",
    area,
    nes: {
      ppuctrl: {
        hex: "0x" + ppuctrl.toString(16).toUpperCase().padStart(2, "0"),
        baseNametable: "$" + (0x2000 + baseNametable * 0x400).toString(16).toUpperCase(),
        vramIncrement,
        spritePatternTable: "$" + spritePatternPpuBase.toString(16).toUpperCase().padStart(4, "0"),
        bgPatternTable: "$" + bgPatternPpuBase.toString(16).toUpperCase().padStart(4, "0"),
        spriteHeight,
        nmiEnabled,
      },
      ppumask: {
        hex: "0x" + ppumask.toString(16).toUpperCase().padStart(2, "0"),
        bgVisible,
        spritesVisible,
        bgLeftmost,
        spritesLeftmost,
        grayscale,
        emphasis,
      },
      ppustatus: {
        hex: "0x" + ppustatus.toString(16).toUpperCase().padStart(2, "0"),
        spriteOverflow,
        sprite0Hit,
        vblank,
      },
      oamaddr: "0x" + oamaddr.toString(16).toUpperCase().padStart(2, "0"),
      activeBgPatternBank: bgPatternBank,
      activeSpritePatternBank: spritePatternBank,
      activeNametable: baseNametable,
      chrFileOffsetForActiveBgBank: bgChrFileOffset,
      chrFileOffsetForActiveSpriteBank: spriteChrFileOffset,
      mapper: mapperNum,
    },
    summary,
  };
}

/**
 * SNES rendering-context decoder. Reads INIDISP/BGMODE/BGxSC/BGxNBA/OBSEL/
 * TM/TS/color-math from the snes_fillram register shadow (snes9x mirrors the
 * write-only $2100-$213f register file into Memory.FillRAM, indexed by full
 * register address) and derives the active BG tilemap + char bases per layer
 * and the OBJ tile base — the same answer NES/GB/Genesis give.
 */
async function snesContext(host, area) {
  const { decodePpuRegs, ppuRegsPopulated } = await import("../../platforms/snes/ppu.js");
  const cgram = host.readMemory("snes_cgram", 0, 512);
  const oam = host.readMemory("snes_oam", 0, 544);
  const vram = host.readMemory("video_ram", 0, 0x10000);
  const fillram = host.readMemory("snes_fillram", 0, 0x8000);

  const regsLive = ppuRegsPopulated(fillram);
  const ppu = regsLive ? decodePpuRegs(fillram) : null;

  // How much CGRAM / VRAM is non-zero — a cheap "has the game set things up
  // yet?" signal so the agent knows whether to step more frames.
  const cgramNonZero = cgram.some((b) => b !== 0);
  let vramNonZero = 0;
  for (let i = 0; i < vram.length; i++) if (vram[i] !== 0) vramNonZero++;
  // Count on-screen sprites (Y<0xE0 is not parked off-screen-top).
  let onscreenSprites = 0;
  for (let i = 0; i < 128; i++) {
    const y = oam[i * 4 + 1];
    if (y < 0xE0) onscreenSprites++;
  }

  // Per-BG bytes the agent feeds straight into inspectBackgroundMap. bpp
  // depends on BG mode/layer; default Mode-1 mapping (BG1/2 = 4bpp, BG3 =
  // 2bpp) when we know the mode.
  const bppForBg = (mode, layer) => {
    if (mode === 0) return 2;
    if (mode === 1) return layer === 2 ? 2 : 4; // BG3 (layer index 2) is 2bpp
    if (mode === 3) return layer === 0 ? 8 : 4;
    if (mode === 7) return 8;
    return 4;
  };
  const layers = ppu ? ppu.bg.map((b, i) => ({
    bg: i + 1,
    enabledMain: ppu.mainScreen[`bg${i + 1}`],
    enabledSub: ppu.subScreen[`bg${i + 1}`],
    tilemapBaseByte: b.scBaseByte,
    tileBaseByte: b.charBaseByte,
    mapWidth: b.mapWidth,
    mapHeight: b.mapHeight,
    bpp: bppForBg(ppu.bgMode, i),
  })) : null;

  const summary = [];
  if (area === "all" || area === "bg") {
    if (ppu) {
      const active = layers.filter((l) => l.enabledMain || l.enabledSub)
        .map((l) => `BG${l.bg}@map0x${l.tilemapBaseByte.toString(16)}/tiles0x${l.tileBaseByte.toString(16)}(${l.bpp}bpp)`)
        .join(", ") || "none enabled";
      summary.push(
        `SNES BG mode ${ppu.bgMode}. Active layers: ${active}. ` +
        `Brightness ${ppu.brightness}/15${ppu.forcedBlank ? " (FORCED BLANK — screen off!)" : ""}. ` +
        `Feed a layer's tilemapBaseByte/tileBaseByte/bpp/mapWidth/mapHeight straight into ` +
        `inspectBackgroundMap({platform:'snes', ...}).`
      );
    } else {
      summary.push(
        "SNES PPU registers not yet populated (FillRAM shadow is empty/uniform) — step more " +
        "frames so the game writes $2100-$213f, then the BG mode / tilemap base / char base will decode."
      );
    }
    summary.push(
      `VRAM has ${vramNonZero} non-zero bytes / 65536 — ${vramNonZero === 0 ? "EMPTY (step more frames; the game hasn't uploaded tiles yet)" : "populated"}. ` +
      `CGRAM (palette) is ${cgramNonZero ? "set" : "all zero (no palette uploaded yet — step more frames)"}.`
    );
  }
  if (area === "all" || area === "sprites") {
    if (ppu) {
      summary.push(
        `OAM: ${onscreenSprites} of 128 slots on-screen (Y<0xE0). OBSEL=$${ppu.obsel.toString(16)} → ` +
        `OBJ sizes ${JSON.stringify(ppu.objSize.small)}/${JSON.stringify(ppu.objSize.large)}, ` +
        `OBJ tile base 0x${ppu.objNameBaseByte.toString(16)}, OBJ layer ` +
        `${ppu.mainScreen.obj ? "ON" : "OFF"} (TM=$${ppu.tm.toString(16)}). ` +
        `inspectSprites({platform:'snes'}) resolves per-sprite tileVramAddr + palette range + uninitialized-palette warnings.`
      );
    } else {
      summary.push(
        `OAM: ${onscreenSprites} of 128 slots on-screen (Y<0xE0). OBSEL not populated yet — step more frames. ` +
        `inspectSprites({platform:'snes'}) gives the full decoded list.`
      );
    }
  }
  if (area === "all") {
    summary.push(
      "Readable SNES regions: snes_cgram (512B palette), snes_oam (544B), video_ram (64KB VRAM), " +
      "snes_aram (64KB SPC700), snes_fillram (32KB PPU/DMA register shadow — $2100-$213f decoded above). " +
      "For CPU/audio state use getCPUState / getAudioState."
    );
  }

  return {
    platform: "snes",
    area,
    snes: {
      ppuRegistersAvailable: regsLive,
      ppuRegistersNote: regsLive
        ? "Decoded from snes_fillram ($2100-$213f shadow). bgMode/layers/obj below are live."
        : "snes_fillram register shadow is empty/uniform — step more frames so the game writes the PPU registers.",
      bgMode: ppu ? ppu.bgMode : null,
      brightness: ppu ? ppu.brightness : null,
      forcedBlank: ppu ? ppu.forcedBlank : null,
      layers,
      obj: ppu ? {
        obsel: ppu.obsel,
        size: ppu.objSize,
        tileBaseByte: ppu.objNameBaseByte,
        secondPageGapByte: ppu.objGapByte,
        enabledMain: ppu.mainScreen.obj,
      } : null,
      colorMath: ppu ? ppu.colorMath : null,
      cgramPopulated: cgramNonZero,
      vramNonZeroBytes: vramNonZero,
      onscreenSprites,
      readableRegions: ["snes_cgram", "snes_oam", "video_ram", "snes_aram", "snes_fillram"],
      rawRegs: ppu ? ppu.raw : null,
    },
    summary,
  };
}

/**
 * Genesis / Mega Drive rendering context decoder. Reads the 32-byte
 * genesis_vdp_regs region (gpgx mirror of the VDP's write-only register
 * file) and decodes plane A/B/window name-table bases, sprite-attribute
 * table base, h-scroll table base, plane size, backdrop, and display mode.
 *
 * Unlike the NES, the Genesis has no "CHR bank" — tiles are addressed by
 * a flat 11-bit index into VRAM (tileIndex × 32 bytes). So the useful
 * answer here is WHERE each plane's name table lives and how big the
 * plane is, which is exactly what inspectBackgroundMap consumes.
 */
async function genesisContext(host, area) {
  const regs = host.readMemory("genesis_vdp_regs", 0, 32);
  const { decodeVDPRegs } = await import("../../platforms/genesis/vdp.js");
  const vdp = decodeVDPRegs(regs);
  const { wCells, hCells } = vdp.planeSize;
  const hx = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");

  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `Plane A name table: ${hx(vdp.nameTableA)} (VRAM). ` +
      `Plane B name table: ${hx(vdp.nameTableB)}. ` +
      `Plane size: ${wCells}×${hCells} cells (${wCells * 8}×${hCells * 8}px). ` +
      `Window plane name table: ${hx(vdp.nameTableW)}.`
    );
    summary.push(
      `Tiles are a flat 11-bit index into VRAM (tile N = VRAM offset 0x${(0).toString(16)} + N×32, 4bpp). ` +
      `There is no CHR bank — a name-table entry's low 11 bits ARE the VRAM tile address. ` +
      `Use inspectBackgroundMap({plane:'A'|'B'}) to render either plane's composite.`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Sprite attribute table (SAT): ${hx(vdp.spriteTable)} (VRAM, 80 entries × 8 bytes). ` +
      `Use inspectSprites() to decode it.`
    );
  }
  if (area === "all") {
    summary.push(
      `H-scroll table: ${hx(vdp.hScrollTable)}. ` +
      `Backdrop color: palette ${vdp.bgColor.palette}, index ${vdp.bgColor.index}.`
    );
    summary.push(
      `Display ${vdp.displayEnabled ? "ENABLED" : "OFF"}, mode ${vdp.hMode}/${vdp.vMode}, ` +
      `vblank IRQ ${vdp.vblankInt ? "on" : "off"}, hblank IRQ ${vdp.hblankInt ? "on" : "off"}. ` +
      `(${vdp.mode5 ? "Mode 5 — Genesis native" : "Mode 4 — SMS-compat"}.)`
    );
    summary.push(
      "NOTE: gpgx snapshots the VDP register file at save-state time. Step the " +
      "ROM past startup (stepFrames(120)+) before calling — power-on register " +
      "state won't match what the title screen renders."
    );
  }

  return {
    platform: "genesis",
    area,
    genesis: {
      displayEnabled: vdp.displayEnabled,
      hMode: vdp.hMode,
      vMode: vdp.vMode,
      mode: vdp.mode5 ? "mode5" : "mode4",
      vblankInt: vdp.vblankInt,
      hblankInt: vdp.hblankInt,
      extInt: vdp.extInt,
      planeA: { nameTableBase: hx(vdp.nameTableA), nameTableBaseDec: vdp.nameTableA },
      planeB: { nameTableBase: hx(vdp.nameTableB), nameTableBaseDec: vdp.nameTableB },
      window: { nameTableBase: hx(vdp.nameTableW), nameTableBaseDec: vdp.nameTableW },
      planeSize: { wCells, hCells, widthPx: wCells * 8, heightPx: hCells * 8 },
      spriteAttrTableBase: hx(vdp.spriteTable),
      spriteAttrTableBaseDec: vdp.spriteTable,
      hScrollTableBase: hx(vdp.hScrollTable),
      hScrollTableBaseDec: vdp.hScrollTable,
      backdrop: vdp.bgColor,
      vramRegion: "video_ram",
    },
    summary,
  };
}

/**
 * SMS / Game Gear context decoder. Reads sms_vdp_regs (16 bytes) and
 * produces structured + summary output.
 */
async function smsContext(host, area, platform) {
  const regs = host.readMemory("sms_vdp_regs", 0, 16);
  const { decodeSmsVdpRegs } = await import("../../platforms/sms/vdp.js");
  const vdp = decodeSmsVdpRegs(regs);

  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `BG tile data base: ${vdp.bgTileDataBase} (VRAM offset 0x${vdp.bgTileDataBaseDec.toString(16).toUpperCase()}). ` +
      `BG tiles 0..255 live here.`
    );
    summary.push(
      `Name table base: ${vdp.nameTableBase} (VRAM offset 0x${vdp.nameTableBaseDec.toString(16).toUpperCase()}).`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Sprite tile data base: ${vdp.spriteTileDataBase} (VRAM offset 0x${vdp.spriteTileDataBaseDec.toString(16).toUpperCase()}). ` +
      `Sprite size ${vdp.mode2.spriteSize8x16 ? "8x16" : "8x8"}${vdp.mode2.spriteMag2x ? ", 2x magnification" : ""}.`
    );
    summary.push(
      `Sprite attribute table (SAT): ${vdp.spriteAttrTableBase} (VRAM offset 0x${vdp.spriteAttrTableBaseDec.toString(16).toUpperCase()}).`
    );
  }
  if (area === "all") {
    summary.push(
      `BG scroll: (${vdp.bgScrollX}, ${vdp.bgScrollY}). ` +
      `Display ${vdp.mode2.displayEnabled ? "ENABLED" : "OFF"}, vblank IRQ ${vdp.mode2.vblankInterruptEnable ? "on" : "off"}.`
    );
  }

  return {
    platform,
    area,
    sms: {
      ...vdp,
      // VRAM offset is the file/ram offset the agent can pass to readMemory("sms_vram").
      // Direct splice targets:
      vramRegionForBgTiles: platform === "gg" ? "gg_vram" : "sms_vram",
      vramRegionForSpriteTiles: platform === "gg" ? "gg_vram" : "sms_vram",
    },
    summary,
  };
}

/**
 * GB / GBC rendering context decoder. Reads gb_io (128 B at $FF00-$FF7F)
 * and produces structured + summary output.
 */
async function gbContext(host, area, platform) {
  const io = host.readMemory("gb_io", 0, 0x80);
  const { decodeLcdc } = await import("../../platforms/gb/ppu.js");
  const lcdc = decodeLcdc(io[0x40]);
  const stat = io[0x41];
  const scy = io[0x42];
  const scx = io[0x43];
  const ly = io[0x44];
  const lyc = io[0x45];
  const wy = io[0x4A];
  const wx = io[0x4B];
  const bgp = io[0x47];
  const obp0 = io[0x48];
  const obp1 = io[0x49];
  // GBC extras
  const vbk = io[0x4F] & 0x01;        // current VRAM bank
  const key1 = io[0x4D];               // double-speed switch ($FF4D)
  const bgpi = io[0x68];               // BG palette index/auto-increment
  const obpi = io[0x6A];               // OBJ palette index/auto-increment
  const isCgb = platform === "gbc";

  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `BG tile data: ${lcdc.bgTileDataBase} (${lcdc.bgTileDataMode === "8000_unsigned" ? "unsigned indexing — 256 tiles 0..255" : "signed indexing — tile id is int8, so 0..127 maps to $9000+, 128..255 to $8800+"}).`
    );
    summary.push(
      `BG tile map: ${lcdc.bgTileMapBase} (32×32 = 1024 byte indices). BG ${lcdc.bgEnable ? "visible" : "OFF"}, scroll (${scx}, ${scy}).`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Sprites ${lcdc.spritesEnable ? "visible" : "OFF"}, size ${lcdc.spriteSize8x16 ? "8x16" : "8x8"}. ` +
      `Sprite tile data is always at $8000 (unsigned).`
    );
  }
  if (area === "all" || area === "window") {
    summary.push(
      `Window ${lcdc.windowEnable ? "visible" : "OFF"} at tile map ${lcdc.windowTileMapBase}, position (${wx}, ${wy}). ` +
      `WX is offset by 7 — WX=7 means window starts at screen x=0.`
    );
  }
  if (area === "all") {
    summary.push(
      `LCD ${lcdc.lcdEnable ? "ENABLED" : "OFF"}. Currently scanning LY=${ly}` +
      (lyc !== 0 ? ` (LYC=${lyc} ${ly === lyc ? "MATCH" : "no match"})` : "") +
      `. STAT=0x${stat.toString(16).toUpperCase().padStart(2, "0")}.`
    );
    if (isCgb) {
      const speed = (key1 & 0x80) ? "double-speed (CGB)" : "normal";
      summary.push(`GBC: VRAM bank ${vbk} active, ${speed} mode${(key1 & 0x01) ? " — speed switch pending" : ""}.`);
      summary.push(`GBC BG palette index: $${bgpi.toString(16).toUpperCase().padStart(2, "0")} (auto-inc ${(bgpi & 0x80) ? "on" : "off"}). OBJ palette index: $${obpi.toString(16).toUpperCase().padStart(2, "0")}.`);
    }
  }

  return {
    platform,
    area,
    gb: {
      lcdc,
      stat: "0x" + stat.toString(16).toUpperCase().padStart(2, "0"),
      scrollX: scx,
      scrollY: scy,
      ly,
      lyc,
      windowY: wy,
      windowX: wx,
      palettes: isCgb
        ? { mode: "cgb", bgpi, obpi, vramBank: vbk }
        : { mode: "dmg", bgp, obp0, obp1 },
      ...(isCgb ? { key1: { hex: "0x" + key1.toString(16).toUpperCase().padStart(2, "0"), doubleSpeed: !!(key1 & 0x80), switchArmed: !!(key1 & 0x01) } } : {}),
    },
    summary,
  };
}

export async function getRenderingContextCore({ platform, area = "all", sessionKey }) {
  const host = getHost(sessionKey);
  const p = platform ?? host.getStatus().platform;
  switch (p) {
    case "nes": return nesContext(host, area);
    case "snes": return snesContext(host, area);
    case "genesis":
    case "megadrive":
    case "md": return genesisContext(host, area);
    case "gb":
    case "gbc": return gbContext(host, area, p);
    case "sms":
    case "gg": return smsContext(host, area, p);
    case "atari2600":
    case "a2600": return atari2600Context(host, area);
    case "atari7800":
    case "a7800": return atari7800Context(host, area);
    case "c64":   return c64Context(host, area);
    case "gba":   return gbaContext(host, area);
    case "lynx":  return lynxContext(host, area);
    case "pce":   return pceContext(host, area);
    case "msx":   return msxContext(host, area);
    default:
      unsupported(p, "renderingContext", {
        reason: "no rendering-context decoder for this platform",
        alternative: "platform({op:'capabilities'}) to see what's wired",
      });
  }
}

async function gbaContext(host, area) {
  const { decodeGbaRenderingContext } = await import("../../host/gba-video-state.js");
  const io = host.readMemory("gba_io_regs", 0, 0x400);
  const ctx = decodeGbaRenderingContext(io);
  const summary = [];
  if (ctx.forcedBlank) summary.push("FORCED BLANK is on (DISPCNT bit7) — the screen is white; clear it to see output.");
  summary.push(`BG mode ${ctx.bgMode}. BG layers enabled: ${ctx.displayBg.map((on, i) => on ? i : null).filter((x) => x != null).join(",") || "none"}. OBJ ${ctx.displayObj ? "on" : "off"}.`);
  for (const bg of ctx.bgLayers.filter((b) => b.enabled)) {
    summary.push(`BG${bg.bg}: priority ${bg.priority}, charBase block ${bg.charBase} ($${(0x6000000 + bg.charBase * 0x4000).toString(16)}), mapBase block ${bg.mapBase} ($${(0x6000000 + bg.mapBase * 0x800).toString(16)}), ${bg.colorMode ? "256-color" : "16-color"}, size code ${bg.size}.`);
  }
  return { platform: "gba", area, ...ctx, summary };
}

async function lynxContext(host, area) {
  const { decodeLynxRenderingContext } = await import("../../host/lynx-mikey-state.js");
  const hw = host.readMemory("lynx_hw_regs", 0, 0x200);
  const ctx = decodeLynxRenderingContext(hw);
  const summary = [];
  if (!ctx.displayDmaEnable) summary.push("Display DMA is OFF (DISPCTL bit0) — Mikey isn't refreshing the LCD from the display buffer; nothing will show.");
  else summary.push(`Display DMA on. Buffer at ${ctx.displayAddress}. ${ctx.fourColour ? "4-color" : "4bpp/16-color"} mode${ctx.flip ? ", flipped" : ""}.`);
  summary.push("Lynx has no tilemap/nametable — the framebuffer is a linear bitmap in RAM at displayAddress; sprites are SCB-drawn into it by Suzy (see inspectSprites).");
  return { platform: "lynx", area, ...ctx, summary };
}

async function pceContext(host, area) {
  // HuC6270 VDC register file (m_register[20], u16 each). R5 = control register:
  // bit7 = BG enable, bit6 = SP enable, bits3-2 = raster/vblank IRQ enable.
  const regs = host.readMemory("pce_vdc_regs", 0, 40);
  const u16 = (i) => regs[i * 2] | (regs[i * 2 + 1] << 8);
  const cr = u16(5);
  const bgEnable = !!(cr & 0x80);
  const spEnable = !!(cr & 0x40);
  const mwr = u16(9);
  const bgScrollX = u16(7) & 0x3ff;
  const bgScrollY = u16(8) & 0x1ff;
  const satbSrc = u16(19);
  const summary = [];
  if (!bgEnable && !spEnable) summary.push("BG and SPR are BOTH disabled (VDC R5 bits 7/6 clear) — the screen shows only the backdrop color; enable them to see output.");
  else summary.push(`BG ${bgEnable ? "on" : "off"}, SPR ${spEnable ? "on" : "off"} (VDC R5=$${cr.toString(16)}). BG scroll (${bgScrollX},${bgScrollY}). SATB DMA src $${satbSrc.toString(16)}.`);
  summary.push("PCE has no nametable region — the BG map lives in VRAM (pce_vdc_vram); MWR (R9) selects the virtual screen size. Sprites are in the SATB (inspectSprites).");
  return {
    platform: "pce", area,
    screenEnabled: bgEnable || spEnable,
    bgEnable, spEnable,
    control: cr, memoryWidth: mwr,
    bgScrollX, bgScrollY, satbSource: satbSrc,
    summary,
  };
}

async function msxContext(host, area) {
  const { decodeMsxVideoMode } = await import("../../platforms/msx/vdp.js");
  const regs = host.readMemory("msx_vdp_regs", 0, 64);
  const status = host.readMemory("msx_vdp_status", 0, 16);
  const m = decodeMsxVideoMode(regs);
  const summary = [];
  if (!m.screenEnabled) summary.push("Display is DISABLED (VDP R1 bit6 / BLANK) — the screen is the border color; set R1 bit6 to enable.");
  else summary.push(`Display on, ${m.mode}. R0=$${m.regs.r0.toString(16)} R1=$${m.regs.r1.toString(16)}.`);
  // Table base addresses (× their alignment) — the agent needs these to find tiles/map in VRAM.
  const r2 = regs[2] ?? 0, r3 = regs[3] ?? 0, r4 = regs[4] ?? 0, r5 = regs[5] ?? 0, r6 = regs[6] ?? 0;
  const patternName = (r2 & 0x7f) << 10;
  const colorTable = ((r3 & 0xff) | ((r10(regs) & 0x07) << 8)) << 6;
  const patternGen = (r4 & 0x3f) << 11;
  const spriteAttr = ((r5 & 0x7f) | ((regs[11] & 0x03) << 7)) << 7;
  const spriteGen = (r6 & 0x3f) << 11;
  summary.push(`VRAM tables: name=$${patternName.toString(16)} colors=$${colorTable.toString(16)} patterns=$${patternGen.toString(16)} sprAttr=$${spriteAttr.toString(16)} sprGen=$${spriteGen.toString(16)}.`);
  return {
    platform: "msx", area,
    screenEnabled: m.screenEnabled,
    mode: m.mode, modeNumber: m.modeNumber,
    registers: { r0: m.regs.r0, r1: m.regs.r1, r2, r3, r4, r5, r6 },
    tables: { patternName, colorTable, patternGen, spriteAttr, spriteGen },
    statusReg0: status[0] ?? 0,
    summary,
  };
}

/** V9938 R10 (color-table high bits) — index 10 in vdpRegs. */
function r10(regs) { return regs[10] ?? 0; }

async function c64Context(host, area) {
  const { decodeViciiRegs, decodeSprites } = await import("../../platforms/c64/vic.js");
  const regs = host.readMemory("c64_vic_regs", 0, 0x2F);
  const vic = decodeViciiRegs(regs);
  const sprites = decodeSprites(regs);
  // IO port at $0001 controls ROM banking. CIA2 PA bits 0-1 select VIC bank.
  const ioPort = host.readMemory("system_ram", 1, 1)[0];
  const cia2 = host.readMemory("c64_cia2_regs", 0, 16);
  const vicBank = (~cia2[0]) & 0x03;            // CIA2 PA bits 0-1 (inverted)
  const vicBankBase = vicBank * 0x4000;
  // Resolve absolute addresses from the VIC-bank-relative base.
  const screenRamAbs = vicBankBase + parseInt(vic.memPointers.screenRamBaseInVicBank.replace("$", ""), 16);
  const charBaseAbs  = vicBankBase + parseInt(vic.memPointers.charBaseInVicBank.replace("$", ""), 16);
  const summary = {
    screenOn: vic.ctrl1.screenOn,
    mode: vic.ctrl1.bitmapMode
      ? (vic.ctrl2.multicolorMode ? "multicolor-bitmap" : "hires-bitmap")
      : (vic.ctrl1.extendedColorMode ? "extended-bg-text"
          : vic.ctrl2.multicolorMode ? "multicolor-text" : "standard-text"),
    cols: vic.ctrl2.cols40 ? 40 : 38,
    rows: vic.ctrl1.rows25 ? 25 : 24,
    scroll: { x: vic.ctrl2.xScroll, y: vic.ctrl1.yScroll },
    border: vic.borderColor,
    background: vic.backgroundColor,
    rasterLine: vic.rasterLine,
    spritesEnabled: sprites.filter((s) => s.visible).length,
  };
  return {
    platform: "c64",
    area,
    c64: {
      vic,
      sprites,
      memory: {
        vicBank,
        vicBankBase: "$" + vicBankBase.toString(16).toUpperCase().padStart(4, "0"),
        screenRamAbs: "$" + screenRamAbs.toString(16).toUpperCase().padStart(4, "0"),
        charBaseAbs:  "$" + charBaseAbs.toString(16).toUpperCase().padStart(4, "0"),
        ioPortHex:    "0x" + ioPort.toString(16).toUpperCase().padStart(2, "0"),
        kernalVisible: !!(ioPort & 0x02),
        basicVisible:  !!(ioPort & 0x01),
        charRomVisible: !(ioPort & 0x04),   // CHAREN=0 → char ROM at $D000
      },
    },
    summary,
  };
}

/**
 * Atari 2600 rendering context — TIA snapshot decoded into structured form.
 * The 2600 has no persistent "rendering setup" the way other platforms do;
 * the kernel re-writes TIA per scanline. This is a moment-in-time snapshot.
 */
async function atari2600Context(host, area) {
  const { snapshotTia } = await import("../../platforms/atari2600/tia.js");
  const tia = snapshotTia(host);
  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `Playfield colors: PF=${tia.colors.pf.hex}, BK=${tia.colors.bk.hex}. ` +
      `Pattern (20 cols): 0x${tia.playfield.pattern20bit.toString(16).toUpperCase().padStart(5, "0")}. ` +
      `Reflection: ${tia.ctrlpf.reflect ? "ON" : "off"}, score mode: ${tia.ctrlpf.score ? "ON" : "off"}.`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Player 0: gfx=${tia.sprites.p0.graphicsBin}, color=${tia.colors.p0.hex}, ` +
      `${tia.sprites.p0.reflected ? "reflected, " : ""}HM=${tia.sprites.p0.horizMotion}. ` +
      `NUSIZ0=${tia.nusiz0.playerCopies}.`
    );
    summary.push(
      `Player 1: gfx=${tia.sprites.p1.graphicsBin}, color=${tia.colors.p1.hex}, ` +
      `${tia.sprites.p1.reflected ? "reflected, " : ""}HM=${tia.sprites.p1.horizMotion}. ` +
      `NUSIZ1=${tia.nusiz1.playerCopies}.`
    );
    summary.push(
      `Missiles: M0=${tia.sprites.missile0.enabled ? "on" : "off"}, ` +
      `M1=${tia.sprites.missile1.enabled ? "on" : "off"}; ball=${tia.sprites.ball.enabled ? "on" : "off"}.`
    );
  }
  if (area === "all") {
    summary.push(
      `VSYNC ${tia.vsync ? "active" : "off"}, VBLANK disable=${tia.vblank.disable ? "on" : "off"}. ` +
      `Audio ch0: ctrl=${tia.audio.ch0.control}/freq=${tia.audio.ch0.frequency}/vol=${tia.audio.ch0.volume}, ` +
      `ch1: ctrl=${tia.audio.ch1.control}/freq=${tia.audio.ch1.frequency}/vol=${tia.audio.ch1.volume}.`
    );
    summary.push(
      "NOTE: 2600 'rendering state' is per-scanline. The kernel changes TIA " +
      "registers as the beam scans — this is the state at the moment of " +
      "capture, not the per-frame composition. To watch a specific scanline, " +
      "pause + step + sample at that beam position."
    );
  }
  return { platform: "atari2600", area, atari2600: tia, summary };
}

/**
 * Atari 7800 rendering context — MARIA registers decoded.
 */
async function atari7800Context(host, area) {
  const { decodeMariaRegs } = await import("../../platforms/atari7800/maria.js");
  const ram = host.readMemory("system_ram", 0x0020, 0x20);
  const maria = decodeMariaRegs(ram);
  // DPP (display list pointer) at $84/$85.
  const dpp_ram = host.readMemory("system_ram", 0x0084, 2);
  const dpp = dpp_ram[0] | (dpp_ram[1] << 8);
  // CHARBASE at $87.
  const charBase = host.readMemory("system_ram", 0x0087, 1)[0];

  const summary = [];
  if (area === "all" || area === "bg") {
    summary.push(
      `Background color: ${maria.background.byte.toString(16).toUpperCase().padStart(2, "0")} (RGB ${maria.background.rgb.join("/")}). ` +
      `8 palettes × 4 colors active. Color 0 of every palette is the background color (shared).`
    );
  }
  if (area === "all" || area === "sprites") {
    summary.push(
      `Display list pointer (DPP @ $84/$85): $${dpp.toString(16).toUpperCase().padStart(4, "0")}. ` +
      `CHARBASE @ $87: $${charBase.toString(16).toUpperCase().padStart(2, "0")} (high byte of character pattern base address). ` +
      `Sprites are emitted via the display list at this pointer — parse it to enumerate active drawables for the current zone.`
    );
  }
  if (area === "all") {
    summary.push(
      `MARIA CTRL ($3C): ${maria.ctrl.hex}. ` +
      `DMA ${maria.ctrl.dmaDisable ? "DISABLED" : "enabled"}, ` +
      `${maria.ctrl.colorKill ? "color kill on, " : ""}` +
      `${maria.ctrl.borderControl}-mode border, ` +
      `${maria.ctrl.kangarooMode ? "kangaroo mode, " : ""}` +
      `read mode ${maria.ctrl.readMode}, character width ${maria.ctrl.characterWidth}.`
    );
  }
  return {
    platform: "atari7800",
    area,
    atari7800: {
      ...maria,
      dpp: "0x" + dpp.toString(16).toUpperCase().padStart(4, "0"),
      dppDec: dpp,
      charBase: "0x" + charBase.toString(16).toUpperCase().padStart(2, "0"),
    },
    summary,
  };
}

export function registerRenderingContextTools(server, z, sessionKey) {
  // rect shape for view:'map' region clipping (NES).
  const regionShape = z.object({
    x: z.number().int().min(0).max(31),
    y: z.number().int().min(0).max(29),
    w: z.number().int().min(1).max(32),
    h: z.number().int().min(1).max(30),
  });

  server.tool(
    "background",
    "Background/tilemap inspection + render state, one tool keyed by `view`.\n" +
    "• view:'map' — the loaded ROM's background tile map. NES render:false returns DECODED structured data: " +
    "a per-tile `tiles` grid, a per-tile `subPaletteGrid` (BG sub-palette 0-3, already decoded from the attribute " +
    "table so you never hand-decode the 2-bit-per-16×16-block format), and `distinctTiles`. `region:{x,y,w,h}` " +
    "(tiles) clips it; `attributesOnly:true` returns just the sub-palette grid + raw attr bytes; `tilesOnly:true` " +
    "just the tile grid (mutually exclusive). NES render:true returns a PNG composite. GB/GBC/SMS/GG/Genesis " +
    "return a PNG of the full BG plane/nametable (scroll shown but NOT applied); `which`/`window`/`plane` select " +
    "the map. SNES returns a PNG but needs the BG params (`tilemapBaseByte`/`tileBaseByte`/`bpp`/`mapWidth`/`mapHeight`); " +
    "they default to a Mode-1 BG1 best-guess — get the real ones from view:'renderState' first. " +
    "Image paths require `outputPath` (or `inline:true`).\n" +
    "• view:'renderState' — decode the current PPU/VDP rendering state into structured fields + a plain-English " +
    "`summary[]`, including WHICH CHR/tile bank BG and sprites are fetching from right now plus the file offset " +
    "ready for patchFile (so you don't patch the wrong half of CHR). NES decodes PPUCTRL/MASK/STATUS bit-by-bit + " +
    "derived `chrFileOffsetForActiveBgBank` (for banked mappers, live `readMemory('nes_chr',...)` is authoritative). " +
    "SNES decodes BG mode/layer tilemap+char bases/OBSEL from the snes_fillram register shadow. `area` limits the " +
    "summary (bg/sprites/window/all). GOTCHA: step past startup (stepFrames(120)+) first — power-on PPU/VDP state " +
    "won't match the title screen.\n" +
    "• view:'rendered' — map tile IDs → game assets: walk the current frame's BG nametable + OAM and return the set " +
    "of tile IDs actually being drawn ({background, sprite, combined}, each with ids/idsHex/ranges). ROM-hack trick: " +
    "call it at the title screen, then again in gameplay, and SUBTRACT the sets — what's unique to gameplay is your " +
    "in-game art. SNES auto-scans every enabled BG layer from the live PPU registers; pass `snesTilemapBaseByte` " +
    "(+`snesMapWidth`/`snesMapHeight`) only to scan one specific tilemap instead.",
    {
      view: z.enum(["map", "renderState", "rendered"])
        .describe("map=BG tilemap (decoded grid or PNG); renderState=decoded PPU/VDP state + which CHR bank is active; rendered=tile IDs actually drawn this frame."),
      platform: z.string().optional().describe("Override platform; defaults to the loaded ROM's."),
      // view:'renderState'
      area: z.enum(["bg", "sprites", "window", "all"]).default("all").describe("view:renderState — limit the summary to one area (honored on NES/SNES/Genesis/SMS/GG/GB/GBC; other platforms always return the full summary)."),
      // view:'map' shared
      outputPath: z.string().optional().describe("view:map — absolute path for the composite PNG (required unless inline). NES render:false: writes the full decoded JSON (tiles+subPaletteGrid) here and returns a compact summary + distinctTiles."),
      inline: z.boolean().default(false).describe("view:map — return the BG image in the response instead of writing to disk (image-producing paths only)."),
      render: z.boolean().default(false).describe("view:map NES only: true returns a rendered PNG composite instead of decoded structured data. Ignored on GB/GBC/SMS/GG/Genesis/SNES — those always render a PNG."),
      region: regionShape.optional().describe("view:map NES render:false only: clip to this tile sub-rectangle (clamped to 32×30). Omit for the whole nametable."),
      attributesOnly: z.boolean().default(false).describe("view:map NES render:false only: return just the decoded subPaletteGrid + raw attribute table. Mutually exclusive with tilesOnly."),
      tilesOnly: z.boolean().default(false).describe("view:map NES render:false only: return just the tile-index grid + distinctTiles. Mutually exclusive with attributesOnly."),
      which: z.number().int().min(0).max(1).default(0).describe("view:map — which BG map. NES: 1KB nametable (0=$2000, 1=$2400). GB/GBC: 0=$9800, 1=$9C00. Default 0."),
      window: z.boolean().default(false).describe("view:map GB/GBC only: render the Window tile map (LCDC.6 base) instead of the BG map."),
      plane: z.enum(["A", "B"]).default("A").describe("view:map Genesis only: which scroll plane to render. Default A."),
      // view:'map' SNES + view:'rendered' SNES
      tilemapBaseByte: z.number().int().min(0).default(0).describe("view:map SNES only: VRAM byte offset of the BG tilemap (BGxSC base). Default 0. This path doesn't auto-detect — pass your game's BG1 tilemap address (get it from view:renderState)."),
      tileBaseByte: z.number().int().min(0).default(0).describe("view:map SNES only: VRAM byte offset of tile 0 (BG character base / BGxNBA). Default 0."),
      bpp: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4).describe("view:map SNES only: tile bit-depth. Mode 1 BG1/BG2 = 4bpp (default), BG3 = 2bpp."),
      mapWidth: z.union([z.literal(32), z.literal(64)]).default(32).describe("view:map SNES only: tilemap width in tiles. Default 32."),
      mapHeight: z.union([z.literal(32), z.literal(64)]).default(32).describe("view:map SNES only: tilemap height in tiles. Default 32."),
      snesTilemapBaseByte: z.number().int().min(0).optional().describe("view:rendered SNES only: VRAM byte offset of one BG tilemap (BGxSC base) to scan; its tile IDs are added to `background`. Omit to auto-scan every enabled layer from the live PPU registers."),
      snesMapWidth: z.union([z.literal(32), z.literal(64)]).default(32).describe("view:rendered SNES only: tilemap width in tiles (only used with snesTilemapBaseByte). Default 32."),
      snesMapHeight: z.union([z.literal(32), z.literal(64)]).default(32).describe("view:rendered SNES only: tilemap height in tiles (only used with snesTilemapBaseByte). Default 32."),
    },
    safeTool(async (args) => {
      switch (args.view) {
        case "map":         return await inspectBackgroundMapCore(args, sessionKey);
        case "renderState": {
          // Pass sessionKey through so getRenderingContextCore can resolve the
          // per-session host (round 26 fix; was `sessionKey is not defined`).
          const r = await getRenderingContextCore({ ...args, sessionKey });
          return jsonContent(r);
        }
        case "rendered":    return await whichTilesAreRenderedCore({ ...args, sessionKey });
        default: throw new Error(`background: unknown view '${args.view}'`);
      }
    }),
  );
}
