// Platform-aware inspection tools. The MCP surface stays generic — every
// tool takes a `platform` argument (or auto-detects from the loaded host)
// and dispatches to the right per-platform decoder under src/platforms/.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { getHost } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";

// Image-output contract: a PNG image goes to disk (path) OR comes back
// inline (inline:true). No path + not inline → error. The structured
// JSON (palette/sprite/tile data) is ALWAYS returned regardless.
function requireImageTarget(outPath, inline, tool) {
  if (!outPath && !inline) {
    throw new Error(`${tool}: pass outputPath (write the image to disk, returns {imagePath}) or inline:true (return the image in the response).`);
  }
}
import { getCPUState } from "../../host/cpu-state.js";
import { getDspState } from "../../host/dsp-state.js";
import { getNesApuState } from "../../host/nes-apu-state.js";
import { decodeGenesisPSG, decodeGenesisYM2612 } from "../../host/gpgx-state.js";

/** Resolve the platform to inspect: explicit arg → currently loaded host. */
function resolvePlatform(host, requested) {
  const p = requested ?? host.status.platform;
  if (!p) throw new Error("no platform specified and no host loaded");
  return p;
}

export function registerPlatformTools(server, z, sessionKey) {
  server.tool(
    "inspectPatternTiles",
    "Render tile/sprite art (pattern tables, CHR, tile RAM — terminology varies per platform) as " +
    "a PNG. NES: returns 256×128 of both 4KB CHR banks.\n\n" +
    "Source selection (cross-tool consistent with getTile / extractSpriteSheet):\n" +
    "  • No `path` set → reads from the running emulator. CHR-ROM cores read the iNES file " +
    "    on disk; CHR-RAM cores read the live VRAM (whatever the game has uploaded).\n" +
    "  • `path` set → reads directly from a ROM file on disk (no running emulator needed). " +
    "    Use this for surveying assets BEFORE loading.\n\n" +
    "Response includes `source: \"file\" | \"emulator\"` and a textual note so you always know which. " +
    "DEFAULT writes the PNG to outputPath and returns the JSON + {imagePath}; pass inline:true to get the image " +
    "in the response (you must pass one or the other). The structured JSON is always returned.",
    {
      platform: z.string().optional().describe("Override platform; defaults to currently loaded."),
      path: z.string().optional().describe("Optional ROM file. If set, reads CHR from disk instead of the running emulator."),
      bpp: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4).describe("SNES only: bits-per-pixel of the tiles (2/4/8). Mode 1 BG1/BG2 are 4bpp (default), BG3 is 2bpp. snes9x doesn't expose PPU regs so this can't be auto-detected."),
      tileBaseByte: z.number().int().min(0).default(0).describe("SNES only: byte offset into VRAM of tile 0 (the BG's character base). Default 0."),
      paletteBase: z.number().int().min(0).max(255).default(0).describe("SNES only: CGRAM index of color 0 of the sub-palette used to colorize the sheet. Default 0."),
      paletteIndex: z.number().int().min(0).max(3).default(0).describe("Genesis only: which CRAM sub-palette (0-3) to colorize the tile sheet with. Default 0."),
      tileCount: z.number().int().min(0).default(0).describe("SNES/Genesis only: how many tiles to render. 0 (default) fills VRAM from tileBaseByte."),
      outputPath: z.string().optional().describe("Absolute path to write the PNG to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the image in the response instead of writing to disk. Default false — then outputPath is required."),
    },
    safeTool(async ({ platform, path: romPath, bpp, tileBaseByte, paletteBase, paletteIndex, tileCount, outputPath, inline }) => {
      requireImageTarget(outputPath, inline, "inspectPatternTiles");
      // Emit the PNG + structured JSON per the contract: inline returns the
      // image in content[]; otherwise write to disk and return {imagePath}.
      const emit = async (pngBuf, structured) => {
        if (inline) {
          return {
            content: [
              imageContent(pngBuf.toString("base64")),
              { type: "text", text: JSON.stringify(structured) },
            ],
          };
        }
        await writeFile(outputPath, pngBuf);
        const json = jsonContent({ ...structured, imagePath: outputPath });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBuf.toString("base64") }];
        return json;
      };
      // File-source path: read iNES directly from disk.
      if (romPath) {
        const p = platform ?? (/\.nes$/i.test(romPath) ? "nes" : null);
        if (!p) throw new Error("inspectPatternTiles: pass platform explicitly when reading from a non-.nes file.");
        if (p !== "nes") throw new Error(`inspectPatternTiles[file mode]: platform '${p}' not yet supported`);
        const { readFile } = await import("node:fs/promises");
        const bytes = new Uint8Array(await readFile(romPath));
        const { chrFromINes } = await import("../../platforms/nes/ppu.js");
        const { width, height, png, hasChr } = chrFromINes(bytes);
        if (!hasChr) throw new Error(`'${romPath}' is a CHR-RAM cart — no graphics in the ROM file. Load it and call inspectPatternTiles without path.`);
        return emit(png, { platform: p, source: "file", sourcePath: romPath, width, height });
      }
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      if (p === "nes") {
        const { snapshotPatternTables } = await import("../../platforms/nes/ppu.js");
        const { width, height, png, source, hasChr } = await snapshotPatternTables(host);
        const note = source === "ines"
          ? `CHR pattern tables (${width}×${height}, both 4KB banks). Source: iNES file CHR-ROM bank — these tiles are baked into the ROM and never change at runtime.`
          : hasChr === null
            ? `CHR pattern tables (${width}×${height}, live from CHR-RAM). Source: emulator's live CHR-RAM — these change as the game writes to PPU $0000-$1FFF. If you see blank tiles, your game hasn't uploaded tiles yet.`
            : `CHR pattern tables (${width}×${height}, both 4KB banks, live from emulator).`;
        const structuredSource = source === "ines" ? "file" : "emulator";
        return emit(png, { platform: p, source: structuredSource, width, height, note });
      }
      if (p === "sms" || p === "gg") {
        // SMS tiles live in VRAM at runtime — the cart has no fixed CHR
        // region. Render all 448 tiles (the entire 16KB VRAM mapped to
        // tiles), using the live first-BG-palette so colors look right.
        const { snapshotPatternTiles, snapshotPalette } = await import("../../platforms/sms/vdp.js");
        const { colors } = snapshotPalette(host, p);
        // Use BG palette (entries 0..15) for rendering.
        const bgPal = colors.slice(0, 16).map((c) => [c.r, c.g, c.b]);
        const vramRegion = p === "gg" ? "gg_vram" : "sms_vram";
        const vram = host.readMemory(vramRegion, 0, 0x4000);
        const { renderSmsTilesheet } = await import("../../platforms/sms/vdp.js");
        const { width, height, png, tileCount } = renderSmsTilesheet(vram, bgPal);
        return emit(png, {
          platform: p, source: "emulator", width, height, tileCount,
          note: `${tileCount} tiles from 16 KB VRAM (covers tiles + name table + SAT — late ` +
            `tiles will be noise from those regions). For the active BG pattern range, check ` +
            `getRenderingContext().sms.bgTileDataBase.`,
        });
      }
      if (p === "gb" || p === "gbc") {
        const { snapshotPatternTiles } = await import("../../platforms/gb/ppu.js");
        const { width, height, png, tileCount } = snapshotPatternTiles(host, p);
        return emit(png, {
          platform: p, source: "emulator", width, height, tileCount,
          note: `${tileCount} tiles from VRAM $8000-$97FF (the entire tile region). ` +
            `Active BG/Window/sprite tile data area is selected by LCDC bit 4 — check ` +
            `getRenderingContext().gb.bgTileDataBase.`,
        });
      }
      if (p === "snes") {
        const { renderSnesTilesheet, decodeCGRAM } = await import("../../platforms/snes/ppu.js");
        const vram = host.readMemory("video_ram", 0, 0x10000);
        const cgram = host.readMemory("snes_cgram", 0, 512);
        const colors = decodeCGRAM(cgram);
        const r = renderSnesTilesheet(vram, colors, {
          bpp, tileBaseByte, paletteBase, tileCount: tileCount || undefined,
        });
        return emit(r.png, {
          platform: p, source: "emulator", width: r.width, height: r.height,
          tileCount: r.tileCount, bpp: r.bpp, note: r.note,
        });
      }
      if (p === "genesis") {
        const { snapshotPatternTiles } = await import("../../platforms/genesis/vdp.js");
        const r = snapshotPatternTiles(host, { paletteIndex, tileCount: tileCount || undefined });
        return emit(r.png, {
          platform: p, source: "emulator", width: r.width, height: r.height,
          tileCount: r.tileCount, paletteIndex: r.paletteIndex, note: r.note,
        });
      }
      throw new Error(`inspectPatternTiles not yet implemented for platform '${p}'`);
    }),
  );

  server.tool(
    "inspectPalette",
    "Read the loaded ROM's active color palette as a normalized {index,r,g,b,rawWord}[] list AND a PNG swatch sheet. Supported: NES (32 entries: 16 BG + 16 sprite), SNES (256 entries: BGR555 → expanded to 8bpc RGB), Genesis (64 entries: BGR XX nybbles → 8bpc), GB/GBC (4 grayscale shades for DMG; 32 colors for CGB). All return the same generic shape. " +
    "The color list is ALWAYS returned. DEFAULT writes the swatch PNG to outputPath and returns {imagePath}; pass inline:true to get the image in the response (you must pass one or the other).",
    {
      platform: z.string().optional(),
      outputPath: z.string().optional().describe("Absolute path to write the swatch PNG to. Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the swatch image in the response instead of writing to disk. Default false — then outputPath is required."),
    },
    safeTool(async ({ platform, outputPath, inline }) => {
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      requireImageTarget(outputPath, inline, "inspectPalette");
      // The JSON (colors etc.) is ALWAYS returned; only the swatch PNG is gated.
      const emit = async (structured, pngBuf) => {
        if (inline) {
          return {
            content: [
              { type: "text", text: JSON.stringify(structured) },
              imageContent(pngBuf.toString("base64")),
            ],
          };
        }
        await writeFile(outputPath, pngBuf);
        const json = jsonContent({ ...structured, imagePath: outputPath });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBuf.toString("base64") }];
        return json;
      };

      if (p === "nes") {
        const palette = host.readMemory("nes_palette", 0, 32);
        const { renderPalettePng, paletteToGenericColors } = await import("../../platforms/nes/ppu.js");
        const png = renderPalettePng(palette);
        const colors = paletteToGenericColors(palette);
        return emit({ platform: p, colors }, png);
      }

      if (p === "snes") {
        const cgram = host.readMemory("snes_cgram", 0, 512);
        const { decodeCGRAM } = await import("../../platforms/snes/ppu.js");
        const colors = decodeCGRAM(cgram);
        const png = renderColorsAsPng(colors, 16); // 16x16 swatch grid
        return emit({ platform: p, colors }, png);
      }

      if (p === "genesis") {
        const cram = host.readMemory("genesis_cram", 0, 128);
        const { decodeGenesisCRAM } = await import("../../host/gpgx-state.js");
        const colors = decodeGenesisCRAM(cram);
        // 4 palettes × 16 entries = 64 colors; render as 4 rows of 16.
        const png = renderColorsAsPng(colors, 16);
        return emit({ platform: p, colors }, png);
      }

      if (p === "sms" || p === "gg") {
        const { snapshotPalette } = await import("../../platforms/sms/vdp.js");
        const { colors, png } = snapshotPalette(host, p);
        return emit({ platform: p, colors }, png);
      }

      if (p === "gb" || p === "gbc") {
        const { snapshotPalette } = await import("../../platforms/gb/ppu.js");
        const { colors, png, raw } = snapshotPalette(host, p);
        return emit({ platform: p, colors, raw }, png);
      }

      if (p === "atari2600") {
        const { snapshotPaletteSwatch } = await import("../../platforms/atari2600/tia.js");
        const { colors, png } = snapshotPaletteSwatch(host);
        return emit({ platform: p, colors,
          note: "2600 has only 4 active colors at any moment (P0/P1/PF/BK). The TIA color regs change frequently as the kernel races the beam — this is a snapshot of the current state, NOT the full frame's colors." }, png);
      }

      if (p === "atari7800") {
        const { snapshotPalette } = await import("../../platforms/atari7800/maria.js");
        const { colors, png, regs } = snapshotPalette(host);
        return emit({ platform: p, colors, mariaRegs: regs }, png);
      }

      if (p === "c64") {
        const { snapshotPalette } = await import("../../platforms/c64/vic.js");
        const { colors, png, current } = snapshotPalette(host);
        return emit({
          platform: p, colors, current,
          note: "C64 palette is hardware-fixed (16 colors). `current` shows which indices the VIC-II is using right now for border/background/extra-bg. Programs can only choose indices, not RGB.",
        }, png);
      }

      throw new Error(`inspectPalette not yet wired for platform '${p}'. Supported: nes, snes, genesis, sms, gg, gb, gbc, atari2600, atari7800, c64.`);
    }),
  );

  server.tool(
    "getCPUState",
    "Use this to read a CPU's {pc, registers, flags, sp}. Main CPU is wired for nes, snes, genesis, " +
    "sms, gg, gb, gbc, atari2600, atari7800, c64. Secondary CPUs via `cpu`: `spc700` (SNES audio — tells " +
    "'stuck in IPL' vs 'running' vs 'crashed into garbage ARAM') and `z80` (Genesis sound — held in reset " +
    "until the 68k releases it via $A11100, so a fresh boot reads all-zero).",
    {
      platform: z.string().optional(),
      cpu: z.enum(["main", "spc700", "z80"]).default("main").describe("Which CPU to inspect. main = platform's primary CPU. spc700 = SNES audio CPU (SNES only). z80 = Genesis sound CPU (Genesis only — held in reset until the 68k releases it, so may read all-zero on a fresh boot)."),
    },
    safeTool(async ({ platform, cpu }) => {
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      const state = getCPUState(host, p, cpu);
      if (!state) {
        throw new Error(`getCPUState: no decoder for platform '${p}' cpu '${cpu}'. Main CPU is wired for nes, snes, genesis, sms, gg, gb, gbc, atari2600, atari7800, c64. Secondary CPUs: snes 'spc700' (genesis 'z80' not yet decoded).`);
      }
      return jsonContent({ platform: p, cpu, ...state });
    }),
  );

  // ── getAudioState — unified sound-chip introspection ──────────────
  // One tool, `chip` enum discriminator (mirrors getCPUState({cpu})).
  // Subsumes the old getDspState / getPsgState / getYm2612State, which
  // remain as thin deprecated aliases below for back-compat.
  /** Run the chip decoder for one chip; returns the structured JSON object. */
  function readAudioChip(chip) {
    const host = getHost(sessionKey);
    if (chip === "dsp") {
      const p = resolvePlatform(host, "snes");
      const dsp = getDspState(host, p);
      if (!dsp) throw new Error("getAudioState chip:'dsp' is SNES only.");
      const { regs, ...rest } = dsp;
      return { platform: p, chip, ...rest, regsHex: Array.from(regs, (b) => b.toString(16).padStart(2, "0")).join("") };
    }
    if (chip === "ym2612") {
      const blob = host.readMemory("genesis_ym2612", 0, 4096);
      return { platform: "genesis", chip, ...decodeGenesisYM2612(blob) };
    }
    if (chip === "psg") {
      const blob = host.readMemory("genesis_psg", 0, 1024);
      return { platform: "genesis", chip, ...decodeGenesisPSG(blob) };
    }
    if (chip === "nes") {
      const p = resolvePlatform(host, "nes");
      const apu = getNesApuState(host, p);
      if (!apu) throw new Error("getAudioState chip:'nes' is NES only.");
      return { platform: p, chip, ...apu };
    }
    throw new Error(`getAudioState: unknown chip '${chip}'. Use 'nes' (NES 2A03), 'dsp' (SNES), 'psg' (Genesis/SMS), or 'ym2612' (Genesis).`);
  }

  server.tool(
    "getAudioState",
    "Use this to debug sound or transcribe music: decode a sound chip's live state. `chip:'nes'` (NES 2A03) " +
    "returns per-channel {pulse1, pulse2, triangle, noise, dmc} with timer→freq→midi note name, duty, volume, " +
    "and `playing` — decodes the $4000-$4017 register file directly, so you get a frame-accurate note timeline " +
    "for ANY NES game without reverse-engineering its private sound driver. `chip:'dsp'` (SNES S-DSP) returns " +
    "per-voice vol/pitch/adsr + `env` (internal envelope — 0 = silent regardless of vol) + `bufLastSamples` " +
    "(nonzero proves the voice is producing audio) + `flg`; distinguishes 'never produced output' from 'muted " +
    "by mixer.' GOTCHA: S-DSP FLG is $6C, KOFF is $5C (many refs swap them); power-on FLG=$E0 means your driver " +
    "MUST clear bit 6. `chip:'psg'` (Genesis/SMS SN76489) returns 3 tone + 1 noise channel state. " +
    "`chip:'ym2612'` (Genesis FM) returns a raw-blob snapshot (gpgx's struct isn't safely per-channel " +
    "decodable) — useful for frame-to-frame diffing. Mirrors getCPUState({cpu}). To capture a note timeline " +
    "over time, pair with watchMemory (region:'nes_apu_regs', onChange:'reset') or recordSession.",
    {
      chip: z.enum(["nes", "dsp", "psg", "ym2612"]).describe("Which sound chip: 'nes' (NES 2A03 APU), 'dsp' (SNES S-DSP), 'psg' (Genesis/SMS SN76489), 'ym2612' (Genesis FM)."),
    },
    safeTool(async ({ chip }) => jsonContent(readAudioChip(chip))),
  );


  server.tool(
    "inspectSprites",
    "List the loaded ROM's active sprite table in a generic {slot,x,y,tile,palette,priority,flipH,flipV,size:{w,h},visible}[] shape. Supported: NES (64 sprites), SNES (128 sprites with hi-table X/size). Generic across platforms — each platform's adapter reads its native OAM and normalizes to this shape so cross-platform sprite debugging is one tool call. " +
    "Use `maxSlots` to return only the first N slots (e.g. maxSlots:8 for the active-piece + preview sprites) — shrinks the response when you don't need all 64/128. " +
    "The sprite JSON is ALWAYS returned. On platforms that also render a sprite PNG (sms/gg, gb/gbc, atari2600/7800): DEFAULT writes the PNG to outputPath and returns {imagePath}; pass inline:true to get the image in the response (you must pass one or the other on those platforms). NES/SNES/Genesis/C64 are JSON-only — no path needed.",
    {
      platform: z.string().optional(),
      maxSlots: z.number().int().min(1).max(128).optional().describe("Return only the first N sprite slots (in OAM order). Omit for all slots. The JSON includes `slotsReturned`/`slotsTotal` so you know if it was clipped."),
      outputPath: z.string().optional().describe("Absolute path to write the sprite PNG to (only platforms that produce one). Required on those platforms unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the sprite image in the response instead of writing to disk (only platforms that produce one). Default false."),
    },
    safeTool(async ({ platform, maxSlots, outputPath, inline }) => {
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      // Generic slot clamp, applied by each platform branch before returning.
      const clampSlots = (sprites) => {
        const slotsTotal = sprites.length;
        const clipped = maxSlots != null ? sprites.slice(0, maxSlots) : sprites;
        return { sprites: clipped, slotsTotal, slotsReturned: clipped.length };
      };
      // Gate the PNG for platforms that render one. JSON is always returned.
      const emitImage = async (pngBuf, structured) => {
        requireImageTarget(outputPath, inline, "inspectSprites");
        if (inline) {
          return {
            content: [
              imageContent(pngBuf.toString("base64")),
              { type: "text", text: JSON.stringify(structured) },
            ],
          };
        }
        await writeFile(outputPath, pngBuf);
        const json = jsonContent({ ...structured, imagePath: outputPath });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBuf.toString("base64") }];
        return json;
      };

      if (p === "nes") {
        const oam = host.readMemory("nes_oam", 0, 256);
        const sprites = [];
        for (let i = 0; i < 64; i++) {
          const o = i * 4;
          const y = oam[o + 0];
          const tile = oam[o + 1];
          const attr = oam[o + 2];
          const x = oam[o + 3];
          sprites.push({
            slot: i,
            x, y, tile,
            palette: attr & 0x3,
            priority: (attr >> 5) & 0x1, // NES is 1-bit priority
            flipH: !!((attr >> 6) & 0x1),
            flipV: !!((attr >> 7) & 0x1),
            size: { w: 8, h: 8 }, // NES sprites are 8x8 or 8x16 (PPUCTRL bit) — default to 8x8
            visible: y < 0xF0,
            raw: { byte0: y, byte1: tile, byte2: attr, byte3: x },
          });
        }
        return jsonContent({ platform: p, ...clampSlots(sprites) });
      }

      if (p === "snes") {
        const oam = host.readMemory("snes_oam", 0, 544);
        const fillram = host.readMemory("snes_fillram", 0, 0x8000);
        const cgram = host.readMemory("snes_cgram", 0, 512);
        const { decodeOAM, decodePpuRegs, ppuRegsPopulated, decodeCGRAM, checkObjPalettes } =
          await import("../../platforms/snes/ppu.js");
        // snes9x mirrors $2100-$213f into FillRAM (by full reg address), so we
        // can read OBSEL and resolve real OBJ size + tile-base addressing.
        const regsLive = ppuRegsPopulated(fillram);
        const ppu = regsLive ? decodePpuRegs(fillram) : null;
        const sprites = decodeOAM(oam, ppu ? {
          smallSize: ppu.objSize.small,
          largeSize: ppu.objSize.large,
          objNameBaseByte: ppu.objNameBaseByte,
          objGapByte: ppu.objGapByte,
        } : {});
        const colors = decodeCGRAM(cgram);
        const { uninitializedPalettes, suspiciousPalettes, paletteReport, warnings } =
          checkObjPalettes(sprites, colors);
        const renderableCount = sprites.filter((s) => s.renderable).length;
        const summary = [
          `${renderableCount} of 128 OBJ slots are renderable on-screen` +
            ` (the other ${128 - renderableCount} are parked off-screen/hidden — not drawn).`,
          regsLive
            ? `OBSEL=$${ppu.obsel.toString(16)}: OBJ size pair ${JSON.stringify(ppu.objSize.small)}/` +
              `${JSON.stringify(ppu.objSize.large)}, OBJ tile base VRAM 0x${ppu.objNameBaseByte.toString(16)}, ` +
              `OBJ layer ${ppu.mainScreen.obj ? "ENABLED" : "DISABLED"} on main screen (TM=$${ppu.tm.toString(16)}). ` +
              `Each sprite's tileVramAddr + cgramPaletteRange are resolved from this.`
            : `PPU registers not yet populated (step more frames before trusting OBJ size/base — ` +
              `sizes assume the {8×8,16×16} default and tileVramAddr is null).`,
        ];
        if (warnings.length) summary.push(...warnings);
        // Clamp only the per-sprite list; renderableCount/warnings stay
        // computed over all 128 slots so the summary remains accurate.
        const { sprites: spritesOut, slotsTotal, slotsReturned } = clampSlots(sprites);
        return jsonContent({
          platform: p,
          sprites: spritesOut,
          slotsTotal,
          slotsReturned,
          renderableCount,
          ppuRegsLive: regsLive,
          ppu: ppu && {
            obsel: ppu.obsel, objSize: ppu.objSize, objNameBaseByte: ppu.objNameBaseByte,
            mainScreenObjEnabled: ppu.mainScreen.obj, tm: ppu.tm, ts: ppu.ts,
          },
          uninitializedObjPalettes: uninitializedPalettes,
          suspiciousObjPalettes: suspiciousPalettes,
          objPaletteReport: paletteReport,
          warnings,
          summary,
        });
      }

      if (p === "genesis") {
        const vram = host.readMemory("video_ram", 0, 65536);
        const vdpRegs = host.readMemory("genesis_vdp_regs", 0, 32);
        const { decodeGenesisSprites } = await import("../../host/gpgx-state.js");
        const sprites = decodeGenesisSprites(vram, vdpRegs);
        return jsonContent({ platform: p, sprites });
      }

      if (p === "sms" || p === "gg") {
        const { snapshotSprites } = await import("../../platforms/sms/vdp.js");
        const snap = snapshotSprites(host, p);
        return emitImage(snap.png, {
          platform: p,
          sprites: snap.sprites,
          vdp: snap.vdp,
          spriteHeight: snap.spriteHeight,
          width: snap.width,
          height: snap.height,
        });
      }

      if (p === "gb" || p === "gbc") {
        const { snapshotSprites } = await import("../../platforms/gb/ppu.js");
        const snap = snapshotSprites(host, p);
        return emitImage(snap.png, {
          platform: p,
          sprites: snap.sprites,
          lcdc: snap.lcdc,
          spriteHeight: snap.spriteHeight,
          width: snap.width,
          height: snap.height,
        });
      }

      if (p === "atari2600") {
        // 2600 has no traditional "sprite list" — instead the TIA holds 5
        // graphics objects (P0/P1/M0/M1/Ball) whose state we sample. The
        // kernel re-positions them per-scanline; this is a snapshot.
        const { snapshotTia, snapshotScanline } = await import("../../platforms/atari2600/tia.js");
        const tia = snapshotTia(host);
        const scan = snapshotScanline(host);
        return emitImage(scan.png, {
          platform: p,
          note: scan.note,
          sprites: [
            { name: "player0", ...tia.sprites.p0, color: tia.colors.p0 },
            { name: "player1", ...tia.sprites.p1, color: tia.colors.p1 },
            { name: "missile0", ...tia.sprites.missile0, color: tia.colors.p0 },
            { name: "missile1", ...tia.sprites.missile1, color: tia.colors.p1 },
            { name: "ball", ...tia.sprites.ball, color: tia.colors.pf },
          ],
          playfield: tia.playfield,
          ctrlpf: tia.ctrlpf,
          nusiz0: tia.nusiz0,
          nusiz1: tia.nusiz1,
        });
      }

      if (p === "atari7800") {
        // 7800 sprites are driven by MARIA's display list, which lives in
        // RAM at addresses chosen by the game — there's no fixed OAM. We
        // return MARIA regs (background, 8 palettes, control) so the
        // agent can locate the display list via DPP and parse from there.
        const { snapshotPalette } = await import("../../platforms/atari7800/maria.js");
        const { regs, png } = snapshotPalette(host);
        const ram = host.readMemory("system_ram", 0x0080, 0x10);
        const dpp = ram[0x04] | (ram[0x05] << 8);  // DPPH/DPPL at $84/$85
        return emitImage(png, {
          platform: p,
          note: "7800 has no fixed OAM. MARIA reads a display list from RAM (pointed at by DPP at $84/$85) each scanline — each entry describes one drawable. To enumerate sprites for the current frame, parse the DL starting at the dpp address. This snapshot shows MARIA's control regs + palette state.",
          dpp: "0x" + dpp.toString(16).toUpperCase().padStart(4, "0"),
          maria: regs,
        });
      }

      if (p === "c64") {
        const { snapshotSprites } = await import("../../platforms/c64/vic.js");
        const { sprites, vic } = snapshotSprites(host);
        // Sprite pixel-data pointers live at screen[$3F8 + N] × 64. Read
        // them from current screen RAM so the agent can locate sprite art.
        const screenRamBase = parseInt(vic.memPointers.screenRamBaseInVicBank.replace("$", ""), 16);
        const ram = host.readMemory("system_ram", screenRamBase + 0x3F8, 8);
        const spriteDataPointers = Array.from(ram, (b, i) => ({
          slot: i,
          pointerByte: b,
          dataAddr: "$" + (b * 64).toString(16).toUpperCase().padStart(4, "0"),
          dataAddrDec: b * 64,
        }));
        return {
          content: [
            { type: "text", text: JSON.stringify({
              platform: p, sprites, vic, spriteDataPointers,
              note: "VIC-II has 8 hardware sprites (MOBs). Sprite pixel data lives in main RAM at (screen[$3F8 + N] × 64). spriteDataPointers gives you the address for each.",
            }) },
          ],
        };
      }

      throw new Error(`inspectSprites not yet wired for platform '${p}'. Supported: nes, snes, genesis, sms, gg, gb, gbc, atari2600, atari7800, c64.`);
    }),
  );

  server.tool(
    "inspectBackgroundMap",
    "Use this to see the loaded ROM's background tile map. NES returns raw CIRAM bytes (or `render:true` " +
    "for a PNG); GB/GBC/SMS/GG/Genesis return a PNG composite of the full BG plane/nametable (scroll is " +
    "shown but NOT applied). `which`/`window`/`plane` select the map. SNES needs you to pass the BG params " +
    "(`tilemapBaseByte`/`tileBaseByte`/`bpp`/`mapWidth`/`mapHeight`) because snes9x doesn't expose PPU " +
    "registers — they default to a Mode-1 BG1 best-guess. See param hints for the rest. " +
    "For platforms/paths that render a PNG (NES render:true, GB/GBC/Genesis/SMS/GG/SNES): DEFAULT writes the PNG to outputPath and returns {imagePath}; pass inline:true to get the image in the response (you must pass one or the other). NES render:false returns raw bytes only — no path needed.",
    {
      platform: z.string().optional(),
      outputPath: z.string().optional().describe("Absolute path to write the BG composite PNG to (image-producing paths only). Required on those paths unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return the BG image in the response instead of writing to disk (image-producing paths only). Default false."),
      render: z.boolean().default(false).describe("NES: if true, return a rendered PNG composite instead of raw bytes. GB/GBC/Genesis: always renders a PNG; this flag is ignored."),
      which: z.number().int().min(0).max(1).default(0).describe("NES: which 1KB nametable (0 = $2000, 1 = $2400). GB/GBC: 0 = $9800 (default), 1 = $9C00."),
      window: z.boolean().default(false).describe("GB/GBC only: if true, render the Window tile map base (follows LCDC.6) instead of the BG map base."),
      plane: z.enum(["A", "B"]).default("A").describe("Genesis only: which scroll plane to render — 'A' (default) or 'B'."),
      tilemapBaseByte: z.number().int().min(0).default(0).describe("SNES only: byte offset into VRAM of the BG tilemap (BGxSC base). Default 0. snes9x doesn't expose PPU regs so this can't be auto-detected — pass your game's BG1 tilemap address."),
      tileBaseByte: z.number().int().min(0).default(0).describe("SNES only: byte offset into VRAM of tile 0 (the BG character base / BGxNBA). Default 0."),
      bpp: z.union([z.literal(2), z.literal(4), z.literal(8)]).default(4).describe("SNES only: tile bit-depth. Mode 1 BG1/BG2 = 4bpp (default), BG3 = 2bpp."),
      mapWidth: z.union([z.literal(32), z.literal(64)]).default(32).describe("SNES only: tilemap width in tiles (32 or 64, per BGxSC size bits)."),
      mapHeight: z.union([z.literal(32), z.literal(64)]).default(32).describe("SNES only: tilemap height in tiles (32 or 64)."),
    },
    safeTool(async ({ platform, render, which, window, plane, tilemapBaseByte, tileBaseByte, bpp, mapWidth, mapHeight, outputPath, inline }) => {
      const host = getHost(sessionKey);
      const p = resolvePlatform(host, platform);
      // Gate the PNG; the textual note travels alongside it. Used by every
      // image-producing path. NES render:false stays JSON-only (no image).
      const emitImage = async (pngBuf, note) => {
        requireImageTarget(outputPath, inline, "inspectBackgroundMap");
        if (inline) {
          return {
            content: [
              imageContent(pngBuf.toString("base64")),
              { type: "text", text: note },
            ],
          };
        }
        await writeFile(outputPath, pngBuf);
        const json = jsonContent({ platform: p, imagePath: outputPath, note });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: pngBuf.toString("base64") }];
        return json;
      };
      if (p === "nes") {
        if (render) {
          const { snapshotNametable } = await import("../../platforms/nes/ppu.js");
          const png = snapshotNametable(host, { which });
          return emitImage(png, `Background composite (nametable ${which}, 256×240).`);
        }
        const nt = host.readMemory("nes_nametables", 0, 2048);
        return jsonContent({
          bytes: 2048,
          hex: Array.from(nt, (b) => b.toString(16).padStart(2, "0")).join(""),
        });
      }
      if (p === "gb" || p === "gbc") {
        const { snapshotBackgroundMap } = await import("../../platforms/gb/ppu.js");
        const snap = snapshotBackgroundMap(host, { which, window, platform: p });
        const label = window ? "Window map" : "BG map";
        return emitImage(snap.png, `${p.toUpperCase()} ${label} composite (${snap.width}×${snap.height}, base=${snap.mapBase}, mode=${snap.mode}, scroll=(${snap.scx},${snap.scy})). ${snap.note}`);
      }
      if (p === "genesis") {
        const { snapshotPlaneMap } = await import("../../platforms/genesis/vdp.js");
        const snap = snapshotPlaneMap(host, { plane });
        return emitImage(snap.png, `Genesis ${snap.plane === "B" ? "Plane B" : "Plane A"} composite (${snap.width}×${snap.height}, base=${snap.baseAddr}, ${snap.wCells}×${snap.hCells} cells). ${snap.note}`);
      }
      if (p === "sms" || p === "gg") {
        const { snapshotBackgroundMap } = await import("../../platforms/sms/vdp.js");
        const snap = snapshotBackgroundMap(host, p);
        return emitImage(snap.png, `${p.toUpperCase()} BG map composite (${snap.width}×${snap.height}, base=${snap.mapBase}, scroll=(${snap.scrollX},${snap.scrollY})). ${snap.note}`);
      }
      if (p === "snes") {
        const { renderSnesTilemap, decodeCGRAM } = await import("../../platforms/snes/ppu.js");
        const vram = host.readMemory("video_ram", 0, 0x10000);
        const cgram = host.readMemory("snes_cgram", 0, 512);
        const colors = decodeCGRAM(cgram);
        const r = renderSnesTilemap(vram, colors, {
          tilemapBaseByte, tileBaseByte, bpp, mapWidth, mapHeight,
        });
        return emitImage(r.png, `SNES BG map composite (${r.width}×${r.height}, ${r.mapWidth}×${r.mapHeight} tiles, ${r.bpp}bpp, tilemap@0x${tilemapBaseByte.toString(16)}, tiles@0x${tileBaseByte.toString(16)}). ${r.note}`);
      }
      throw new Error(`inspectBackgroundMap not yet implemented for platform '${p}'`);
    }),
  );

  server.tool(
    "convertImageToTiles",
    "Use this to convert a PNG to a platform's native tile-byte format — raw tiles, no tilemap (use " +
    "imageToTilemap for a full picture with screen/attribute data). Supported: nes, gb, gbc, sms, gg, " +
    "snes, genesis, atari7800, c64 — each with its native bit-depth/layout; programmable-palette " +
    "platforms also return a suggested palette. Image width/height must be multiples of 8. Good for " +
    "demakes (rip art from one platform, re-encode for another) — combine with patchRom or your source. " +
    "DEFAULT writes tiles.bin (+ palette.bin if a palette is produced) into outputDir and returns paths; pass " +
    "inline:true to get tilesBase64/paletteHex in the response (you must pass one or the other).",
    {
      platform: z.string(),
      pngBase64: z.string(),
      maxTiles: z.number().int().min(1).max(8192).default(512),
      outputDir: z.string().optional().describe("Directory to write tiles.bin (+ palette.bin). Required unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return tilesBase64/paletteBase64/paletteHex in the response instead of writing to disk. Default false — then outputDir is required."),
    },
    safeTool(async ({ platform, pngBase64, maxTiles, outputDir, inline }) => {
      if (!inline && !outputDir) {
        throw new Error("convertImageToTiles: pass outputDir (write tiles.bin/palette.bin to disk, returns paths) or inline:true (return base64 in the response).");
      }
      const { imageToTiles } = await import("../../platforms/common/image-to-tiles.js");
      const png = Buffer.from(pngBase64, "base64");
      const r = imageToTiles(platform, png, { maxTiles });
      // Indexed-PNG / palette validation. Catches the most common
      // newbie failure mode: paint in 24-bit RGB → silent color shift.
      const warnings = await validateImagePalette(platform, png);
      const out = {
        platform: r.platform,
        tilesAcross: r.tilesAcross,
        tilesDown: r.tilesDown,
        totalTiles: r.totalTiles,
        tilesBytes: r.tiles.length,
      };
      if (inline) {
        out.tilesBase64 = Buffer.from(r.tiles).toString("base64");
        if (r.palette) {
          out.paletteBase64 = Buffer.from(r.palette).toString("base64");
          out.paletteBytes = r.palette.length;
          out.paletteHex = Array.from(r.palette, (b) => b.toString(16).padStart(2, "0")).join("");
        }
      } else {
        await mkdir(outputDir, { recursive: true });
        out.tilesPath = path.join(outputDir, "tiles.bin");
        await writeFile(out.tilesPath, Buffer.from(r.tiles));
        if (r.palette) {
          out.palettePath = path.join(outputDir, "palette.bin");
          await writeFile(out.palettePath, Buffer.from(r.palette));
          out.paletteBytes = r.palette.length;
          out.paletteHex = Array.from(r.palette, (b) => b.toString(16).padStart(2, "0")).join("");
        }
      }
      if (warnings.length) out.warnings = warnings;
      if (platform === "nes") {
        out.note = "Use patchRom to write the tile bytes (tilesPath / tilesBase64) to the CHR region of an iNES file (offset 16 + prgBanks*16384).";
      } else if (platform === "gb" || platform === "gbc") {
        out.note = "Game Boy uses fixed grayscale (DMG) or runtime palettes (CGB). Tiles are in 'interleaved' bitplane order. Inject into your VRAM via the rgbasm `INCBIN` directive or load via DMA at runtime.";
      } else if (platform === "snes") {
        out.note = "SNES 4bpp 'planar-pairs' layout (32 B/tile). `paletteHex` is a suggested 16-color sub-palette (BGR555 words you'd DMA into CGRAM). DMA the tile bytes to VRAM at your BG/OBJ char base.";
      } else if (platform === "genesis") {
        out.note = "Genesis 4bpp 'packed' layout (32 B/tile, high nibble = left pixel). DMA the tile bytes to VRAM; `paletteHex` is a suggested CRAM sub-palette (write to one of the 4 16-color banks).";
      } else if (platform === "sms" || platform === "gg") {
        out.note = "SMS/GG 4bpp 'interleaved' layout (32 B/tile, per-row [p0,p1,p2,p3]). Write tiles to VRAM tile data base (VDP reg 4); `paletteHex` is a suggested CRAM palette.";
      } else if (platform === "c64") {
        out.note = "C64 hi-res charset: each tile is one 8×8 char (8 B, 1bpp — bit set = foreground in the cell's Color-RAM color, clear = shared background). Load the tile bytes (tilesPath / tilesBase64) into your char base ($0800/$1000/etc.). For a full picture with per-cell colors + screen RAM, use imageToTilemap({platform:'c64'}) instead.";
      }
      return jsonContent(out);
    }),
  );

  // ---- Background image conversion (platform-generic) -------------------
  // Convention: caller already resized + dithered the image into the
  // platform's native palette using the PNG returned by getPlatformPalettePng.
  // The MCP tool then does the platform-specific tile/attribute encoding.

  server.tool(
    "getPlatformPalettePng",
    "Return the target platform's master palette in one of three formats:\n" +
    "  - `png` (default): PNG swatch sheet — every distinct color the hardware can display.\n" +
    "     Use as the ImageMagick -remap target: `magick in.png -dither FloydSteinberg -remap palette.png out.png`.\n" +
    "  - `lospec`: Lospec JSON `{name, author, colors:[hex_no_hash]}` — drops straight into LibreSprite / lospec.com.\n" +
    "  - `hex`: text, one `#RRGGBB` per line — universal interchange.\n" +
    "Pass `outputPath` to write the result to disk and skip the inline base64 / JSON.",
    {
      platform: z.string().describe("Target platform id (e.g. 'nes')."),
      format: z.enum(["png", "lospec", "hex"]).default("png").describe("Output format. 'png' = swatch sheet for ImageMagick dithering (default). 'lospec' = Lospec-compatible JSON for LibreSprite import. 'hex' = one #RRGGBB per line."),
      outputPath: z.string().optional().describe("If given, write the result to this absolute path. Skips inline payload in the response."),
    },
    safeTool(async ({ platform, format, outputPath }) => {
      const { getPlatformPaletteRgb, rgbHex, rgbHexLospec } = await import("../../platforms/common/platform-palette.js");
      if (format === "lospec") {
        const colors = getPlatformPaletteRgb(platform).map(([r, g, b]) => rgbHexLospec(r, g, b));
        const json = {
          name: `${platform} master palette`,
          author: "romdev",
          colors,
        };
        if (outputPath) {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, JSON.stringify(json, null, 2));
          return jsonContent({ platform, format, path: outputPath, colors: colors.length });
        }
        return jsonContent({ platform, format, json });
      }
      if (format === "hex") {
        const lines = getPlatformPaletteRgb(platform).map(([r, g, b]) => rgbHex(r, g, b));
        const text = lines.join("\n") + "\n";
        if (outputPath) {
          await mkdir(path.dirname(outputPath), { recursive: true });
          await writeFile(outputPath, text);
          return jsonContent({ platform, format, path: outputPath, colors: lines.length });
        }
        return jsonContent({ platform, format, text });
      }
      // format === "png"
      const png = await getPlatformPalettePng(platform);
      if (outputPath) {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, png);
        return jsonContent({
          platform,
          format: "png",
          path: outputPath,
          bytes: png.length,
          note: "Use this PNG as the ImageMagick -remap target. The dithered output is what imageToTilemap expects.",
        });
      }
      return jsonContent({
        platform,
        format: "png",
        pngBase64: Buffer.from(png).toString("base64"),
        note: "Save these bytes to a .png and pass it to ImageMagick as the -remap target. The resulting dithered image is what imageToTilemap expects. (Pass outputPath next time to skip the inline base64.)",
      });
    }),
  );

  server.tool(
    "imageToTilemap",
    "Use this to render a large PNG (title screen, cutscene, status panel, world map) from tiles: returns " +
    "tile graphics + tilemap (NES nametable / SNES tilemap / GB BG map / C64 screen RAM) + per-cell " +
    "palette/attribute + palette table, with tile dedup (h/v-flip aware). Supported: nes, snes, genesis, " +
    "sms, gg, gb, gbc, c64. PREREQUISITE: the PNG must already be sized to the platform's native screen and " +
    "quantized to its palette (see getPlatformPalettePng) — per-platform cell/bpp details are in the " +
    "platform's MENTAL_MODEL.md. Pass `pngPath` (preferred) or `pngBase64`; pass `outputDir` to write " +
    "chr/nametable/attr/palette/preview to disk instead of base64-inlining them.",
    {
      platform: z.string().describe("Target platform id."),
      pngBase64: z.string().optional().describe("Base64-encoded PNG. Use `pngPath` instead when the image is already on disk to keep your context small."),
      pngPath: z.string().optional().describe("Absolute path to a PNG file on disk. Preferred over pngBase64 — server reads the file directly."),
      outputDir: z.string().optional().describe("Directory to write chr.bin, nametable.bin, attr.bin, palette.bin, preview.png into. When set, the response omits the base64 fields and returns paths instead. Created if it doesn't exist."),
      maxTiles: z.number().int().min(1).max(4096).optional().describe("Cap on unique tiles (only used when dedup=true). Defaults to the platform's pattern-table limit (NES: 256)."),
      backdrop: z.number().int().min(0).optional().describe("Force a specific master-palette index for the universal backdrop. If omitted, the most-common color is used."),
      dedup: z.boolean().default(true).describe("If true (default), collapse identical tile bitmaps to one CHR entry."),
      singlePalette: z.boolean().default(false).describe("If true, every attribute cell uses one identical palette. Limits the image to 4 total colors."),
    },
    safeTool(async ({ platform, pngBase64, pngPath, outputDir, maxTiles, backdrop, dedup, singlePalette }) => {
      let pngBytes;
      if (pngPath) {
        pngBytes = await readFile(pngPath);
      } else if (pngBase64) {
        pngBytes = Buffer.from(pngBase64, "base64");
      } else {
        throw new Error("imageToTilemap: must provide either pngBase64 or pngPath");
      }

      const r = await imageToTilemap(platform, {
        pngBytes,
        maxTiles,
        backdrop,
        dedup,
        singlePalette,
      });

      if (outputDir) {
        await mkdir(outputDir, { recursive: true });
        const chrPath        = path.join(outputDir, "chr.bin");
        const nametablePath  = path.join(outputDir, "nametable.bin");
        const attrPath       = path.join(outputDir, "attr.bin");
        const palettePath    = path.join(outputDir, "palette.bin");
        const previewPath    = path.join(outputDir, "preview.png");
        await writeFile(chrPath,       r.chr);
        await writeFile(nametablePath, r.nametable);
        await writeFile(attrPath,      r.attr);
        await writeFile(palettePath,   r.palette);
        await writeFile(previewPath,   r.previewPng);
        return jsonContent({
          platform,
          chrPath,
          chrBytes: r.chr.length,
          nametablePath,
          attrPath,
          palettePath,
          paletteHex: Array.from(r.palette, (b) => b.toString(16).padStart(2, "0")).join(""),
          previewPath,
          uniqueTilesBeforeMerge: r.uniqueTilesBeforeMerge,
          uniqueTiles: r.uniqueTiles,
          ...(r._c64 ? { c64: r._c64 } : {}),
          ...(r._genesis ? { genesis: r._genesis } : {}),
          note: platform === "c64"
            ? `C64 hi-res char mode: chr.bin = charset (${r.uniqueTiles} chars × 8B, load into your char base), ` +
              `nametable.bin = screen RAM (1000 B of char codes → $0400), attr.bin = Color RAM (1000 B, low nibble = ` +
              `per-cell fg color → $D800), palette.bin = 1 byte shared background color → $D021.` +
              (r._c64?.warnings?.length ? " WARNINGS: " + r._c64.warnings.join(" ") : "")
            : platform === "genesis"
            ? `Genesis VDP: chr.bin = ${r.uniqueTiles} deduped 4bpp tiles (32 B each, DMA to VRAM). ` +
              `nametable.bin = ${40 * 28} 16-bit BE name-table entries (40×28 cells; tile idx + palette line + h/v flip). ` +
              `palette.bin = 4 lines × 16 colors (128 B BE CRAM words; ${r._genesis?.paletteLines} line(s) used). ` +
              `Set plane width to 64 cells and write the nametable to your Plane A base.` +
              (r._genesis?.warnings?.length ? " WARNINGS: " + r._genesis.warnings.slice(0, 3).join(" ") : "")
            : "Paths written. Pass them as binaryIncludePaths into buildSource.",
        });
      }

      return jsonContent({
        platform,
        chrBase64: Buffer.from(r.chr).toString("base64"),
        chrBytes: r.chr.length,
        nametableBase64: Buffer.from(r.nametable).toString("base64"),
        attrBase64: Buffer.from(r.attr).toString("base64"),
        paletteBase64: Buffer.from(r.palette).toString("base64"),
        paletteHex: Array.from(r.palette, (b) => b.toString(16).padStart(2, "0")).join(""),
        uniqueTilesBeforeMerge: r.uniqueTilesBeforeMerge,
        uniqueTiles: r.uniqueTiles,
        previewPngBase64: Buffer.from(r.previewPng).toString("base64"),
        ...(r._c64 ? { c64: r._c64 } : {}),
        ...(r._genesis ? { genesis: r._genesis } : {}),
        note: platform === "c64"
          ? `C64 hi-res char mode: chrBase64 = charset (${r.uniqueTiles} chars × 8B), nametableBase64 = screen RAM ` +
            `(char codes → $0400), attrBase64 = Color RAM (low nibble = per-cell fg → $D800), paletteBase64 = ` +
            `shared background color byte → $D021.` +
            (r._c64?.warnings?.length ? " WARNINGS: " + r._c64.warnings.join(" ") : "")
          : platform === "genesis"
          ? `Genesis VDP: chrBase64 = ${r.uniqueTiles} deduped 4bpp tiles (32 B each). nametableBase64 = 40×28 ` +
            `16-bit BE entries (tile + palette line + flip). paletteBase64 = 4×16 CRAM words (${r._genesis?.paletteLines} used). ` +
            `Pass outputDir to get .bin files instead of base64.` +
            (r._genesis?.warnings?.length ? " WARNINGS: " + r._genesis.warnings.slice(0, 3).join(" ") : "")
          : "Pass outputDir next call to skip inline base64 and get back paths instead.",
      });
    }),
  );
}

/**
 * Render a generic color list as a PNG swatch grid. Each color becomes
 * a `swatchSize`-pixel square. `cols` controls grid width. Used by the
 * generic inspectPalette path so SNES/Genesis/GB get the same visual.
 *
 * @param {Array<{ r: number, g: number, b: number }>} colors
 * @param {number} [cols=16]
 * @param {number} [swatchSize=12]
 */
function renderColorsAsPng(colors, cols = 16, swatchSize = 12) {
  const rows = Math.ceil(colors.length / cols);
  const width = cols * swatchSize;
  const height = rows * swatchSize;
  const png = new PNG({ width, height });
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (idx >= colors.length) break;
      const { r, g, b } = colors[idx];
      for (let py = 0; py < swatchSize; py++) {
        for (let px = 0; px < swatchSize; px++) {
          const x = cx * swatchSize + px;
          const y = cy * swatchSize + py;
          const o = (y * width + x) * 4;
          png.data[o] = r;
          png.data[o + 1] = g;
          png.data[o + 2] = b;
          png.data[o + 3] = 0xFF;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

/**
 * Platform-generic dispatcher for background palette PNG. Adding a new
 * platform means adding one branch here.
 * @param {string} platform
 */
async function getPlatformPalettePng(platform) {
  if (platform === "nes") {
    const { nesPalettePng } = await import("../../platforms/nes/image-to-tilemap.js");
    return nesPalettePng();
  }
  if (platform === "snes") {
    const { snesPalettePng } = await import("../../platforms/snes/image-to-tilemap.js");
    return snesPalettePng();
  }
  if (platform === "genesis") {
    const { genesisPalettePng } = await import("../../platforms/genesis/image-to-tilemap.js");
    return genesisPalettePng();
  }
  if (platform === "sms" || platform === "gg") {
    const { smsPalettePng } = await import("../../platforms/sms/image-to-tilemap.js");
    return smsPalettePng();
  }
  if (platform === "gb" || platform === "gbc") {
    const { gbPalettePng } = await import("../../platforms/gb/image-to-tilemap.js");
    return gbPalettePng();
  }
  if (platform === "atari2600" || platform === "a2600") {
    const { renderNtscPalettePng } = await import("../../platforms/atari2600/tia.js");
    return renderNtscPalettePng();
  }
  if (platform === "atari7800" || platform === "a7800") {
    const { renderA78MasterPalettePng } = await import("../../platforms/atari7800/maria.js");
    return renderA78MasterPalettePng();
  }
  if (platform === "c64") {
    const { renderC64PalettePng } = await import("../../platforms/c64/vic.js");
    return renderC64PalettePng();
  }
  throw new Error(`getPlatformPalettePng not implemented for '${platform}'. Currently supported: nes, snes, genesis, sms, gg, gb, gbc, atari2600, atari7800, c64.`);
}

/**
 * Platform-generic dispatcher for image-to-tilemap conversion.
 * @param {string} platform
 * @param {{ pngBytes: Buffer | Uint8Array, maxTiles?: number, backdrop?: number, numPalettes?: number }} args
 */
async function imageToTilemap(platform, args) {
  if (platform === "nes") {
    const { nesImageToTilemap } = await import("../../platforms/nes/image-to-tilemap.js");
    return nesImageToTilemap(args);
  }
  if (platform === "snes") {
    const { snesImageToTilemap } = await import("../../platforms/snes/image-to-tilemap.js");
    const r = snesImageToTilemap(args);
    // Normalize return shape: SNES returns `tilemap` instead of `nametable`/`attr`.
    return {
      chr: r.chr,
      nametable: r.tilemap,     // SNES tilemap goes where NES nametable goes
      attr: new Uint8Array(0),  // SNES has no separate attr table (per-tile bits)
      palette: r.palette,
      uniqueTilesBeforeMerge: r.uniqueTiles,
      uniqueTiles: r.uniqueTiles,
      previewPng: r.previewPng,
    };
  }
  if (platform === "sms" || platform === "gg") {
    const { smsImageToTilemap } = await import("../../platforms/sms/image-to-tilemap.js");
    return smsImageToTilemap(args);
  }
  if (platform === "genesis") {
    const { genesisImageToTilemap } = await import("../../platforms/genesis/image-to-tilemap.js");
    const r = genesisImageToTilemap(args);
    return {
      chr: r.chr,
      nametable: r.nametable,
      attr: r.attr,
      palette: r.palette,
      uniqueTilesBeforeMerge: r.uniqueTilesBeforeMerge,
      uniqueTiles: r.uniqueTiles,
      previewPng: r.previewPng,
      _genesis: { paletteLines: r.paletteLines, imageColors: r.imageColors, warnings: r.warnings },
    };
  }
  if (platform === "gb" || platform === "gbc") {
    const { gbImageToTilemap } = await import("../../platforms/gb/image-to-tilemap.js");
    return gbImageToTilemap(args);
  }
  if (platform === "c64") {
    const { c64ImageToTilemap } = await import("../../platforms/c64/image-to-tilemap.js");
    const r = c64ImageToTilemap(args);
    // Normalize to the dispatcher's expected field names. C64 "chr" is the
    // charset, "nametable" is screen RAM, "attr" is color RAM.
    return {
      chr: r.chr,
      nametable: r.nametable,
      attr: r.attr,
      palette: r.palette,
      uniqueTilesBeforeMerge: r.uniqueTilesBeforeMerge,
      uniqueTiles: r.uniqueTiles,
      previewPng: r.previewPng,
      _c64: { backgroundColor: r.backgroundColor, imageColors: r.imageColors, warnings: r.warnings },
    };
  }
  if (platform === "atari2600" || platform === "a2600") {
    throw new Error(
      `imageToTilemap[2600]: the 2600 has no tile/tilemap concept. The playfield ` +
      `is 20 mirrored bits (PF0/PF1/PF2) that change every scanline, plus 5 ` +
      `sprite objects. Pictures must be hand-authored as per-scanline byte ` +
      `streams. There is no automated PNG → 2600 path.`
    );
  }
  if (platform === "atari7800" || platform === "a7800") {
    throw new Error(
      `imageToTilemap[7800]: MARIA reads "display lists" — variable-width sprite/ ` +
      `character chunks at user-defined RAM addresses — instead of a fixed tilemap. ` +
      `Converting an arbitrary PNG would require generating a per-zone display list ` +
      `tuned to the cart, which is game-specific. Not auto-implemented.`
    );
  }
  throw new Error(`imageToTilemap not implemented for '${platform}'. Currently supported: nes, snes, sms, gg, gb, gbc.`);
}

/**
 * Scan a PNG buffer against the platform's master palette and return
 * an array of human-readable warnings (empty array = OK). Never throws.
 * Indexed PNGs are validated via their PLTE chunk; truecolor PNGs are
 * validated by scanning distinct RGB pixels (capped at 256 for cost).
 *
 * @param {string} platform
 * @param {Buffer} pngBuf
 * @returns {Promise<string[]>}
 */
async function validateImagePalette(platform, pngBuf) {
  const warnings = [];
  let pal;
  try {
    const { getPlatformPaletteRgb, paletteContains, rgbHex } =
      await import("../../platforms/common/platform-palette.js");
    pal = getPlatformPaletteRgb(platform);
    // Tolerance: 8 per channel covers LibreSprite sRGB drift. NES/Genesis
    // strict palettes still match within this.
    const TOL = 8;
    const decoded = PNG.sync.read(pngBuf);
    const plte = decoded.palette; // [[r,g,b,a],...] when PLTE present
    if (plte && plte.length) {
      const oob = [];
      for (let i = 0; i < plte.length; i++) {
        const [r, g, b] = plte[i];
        if (!paletteContains(pal, r, g, b, TOL)) {
          oob.push(rgbHex(r, g, b));
        }
      }
      if (oob.length) {
        warnings.push(
          `PNG PLTE has ${oob.length}/${plte.length} colors outside the ${platform} palette` +
          ` (tolerance ±${TOL}/channel): ` +
          oob.slice(0, 8).join(", ") + (oob.length > 8 ? `, ... (+${oob.length - 8} more)` : "") +
          `. Re-export from your editor using getPlatformPalettePng({platform:"${platform}", format:"hex"|"lospec"}) as the source palette.`
        );
      }
    } else {
      // Truecolor — scan distinct RGB triples (cap at 256 for cost).
      const seen = new Map();
      const buf = decoded.data;
      const MAX_DISTINCT = 256;
      for (let i = 0; i < buf.length; i += 4) {
        const a = buf[i + 3];
        if (a === 0) continue;  // skip fully transparent
        const key = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
        if (!seen.has(key)) {
          seen.set(key, [buf[i], buf[i + 1], buf[i + 2]]);
          if (seen.size > MAX_DISTINCT) break;
        }
      }
      const oob = [];
      for (const [r, g, b] of seen.values()) {
        if (!paletteContains(pal, r, g, b, TOL)) {
          oob.push(rgbHex(r, g, b));
        }
      }
      if (oob.length) {
        warnings.push(
          `PNG has ${oob.length}/${seen.size} distinct colors outside the ${platform} palette` +
          ` (tolerance ±${TOL}/channel): ` +
          oob.slice(0, 8).join(", ") + (oob.length > 8 ? `, ... (+${oob.length - 8} more)` : "") +
          `. Quantize to the platform palette first — call getPlatformPalettePng({platform:"${platform}"}) and use the PNG as ImageMagick's -remap target.`
        );
      }
    }
  } catch (e) {
    // Never block the build over a validator hiccup.
    warnings.push(`palette-validation skipped: ${e.message}`);
  }
  return warnings;
}
