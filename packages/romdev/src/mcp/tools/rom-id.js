import { imageContent, jsonContent, safeTool } from "../util.js";
import { intentZod, resolveIntent } from "../../platforms/common/intent.js";
import { getDefaultPalette, DEFAULT_PALETTES } from "../../platforms/common/default-palette.js";

export function registerRomIdTools(server, z, sessionKey) {
  async function doIdentify({ path: filePath, base64, hint }) {
    if (!filePath && !base64) throw new Error("identifyRom: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (filePath && base64) throw new Error("identifyRom: provide `path` OR `base64`, not both.");
    const mod = await import("../../rom-id/identifier.js");
    if (base64) {
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      return jsonContent(mod.identifyBytes(bytes, hint ?? ""));
    }
    return jsonContent(await mod.identifyFile(filePath));
  }

  server.tool(
    "identifyRom",
    "Use this on an unknown ROM/zip to figure out which platform it's for (and decide which core to load). " +
    "Handles zip-wrapped ROMs. Pass `path` (file on disk) OR `base64` (bytes, no disk). Returns " +
    "{ platform, format, title, mapper, region, sizes, notes, confidence, source }. " +
    "ROMHACKING/RE NEXT STEP: once you know the ROM, call `gameCheats({path})` — the bundled cheat DB is a " +
    "FREE, crowd-sourced labeled memory map (each cheat names a RAM address or code site, e.g. \"Infinite " +
    "Lives\" → $00C5). It answers the single most expensive RE question — 'which byte/routine holds X?' — " +
    "for free, before you disassemble or hunt with watchMemory. Do this FIRST on any romhacking task.",
    {
      path: z.string().optional().describe("Absolute path to a .nes/.gb/.sfc/.bin/.zip/etc. file. Provide this OR `base64`."),
      base64: z.string().optional().describe("Base64-encoded ROM bytes. Provide this OR `path`."),
      hint: z.string().optional().describe("With `base64`: filename extension (e.g. '.nes') to disambiguate headerless formats."),
    },
    safeTool(doIdentify),
  );


  server.tool(
    "patchFile",
    "Use this to write N bytes into any binary file at a byte offset — the generic ROM-hack splicer " +
    "(PRG patches, CHR splices, SNES tile/sample injection, etc.). Pass `expect` (the bytes you think " +
    "are there now) and the write is refused on mismatch — catches the classic \"patched the wrong " +
    "region/revision\" silent-corruption footgun; highly recommended. `allowExpand:true` to grow the file. " +
    "TIP: before patching, prove the byte matters by forcing it live with writeMemory on the running " +
    "emulator (or find the writer via watchMemory/runUntilWrite) — static disasm can't tell \"matches the " +
    "pattern\" from \"actually runs.\"",
    {
      path: z.string().describe("Absolute path to the file to modify."),
      offset: z.number().int().min(0).describe("Byte offset where the write begins (file offset, not CPU address)."),
      hex: z.string().optional().describe("Bytes to write, as hex (e.g. 'EA EA' or 'EAEA' — whitespace + commas tolerated)."),
      base64: z.string().optional().describe("Bytes to write, as base64. Use this for large payloads."),
      expect: z.string().optional().describe("Hex of the bytes you EXPECT to find at `offset` right now. If they don't match, the write is refused with a diff. Highly recommended for any patch you want to be re-runnable safely."),
      outputPath: z.string().optional().describe("Write result to a different path (preserves the original). If omitted, the file is modified in place."),
      allowExpand: z.boolean().default(false).describe("Permit the write to extend past EOF (file grows). Default false — most ROM hacks must NOT change size or the headers + mapper layout break."),
    },
    safeTool(async ({ path: filePath, offset, hex, base64, expect, outputPath, allowExpand }) => {
      const { patchFile } = await import("../../rom-id/patch.js");
      const r = await patchFile({ path: filePath, outputPath, offset, hex, base64, expect, allowExpand });
      return jsonContent(r);
    }),
  );

  server.tool(
    "patchRom",
    "Apply a list of byte writes to a ROM file on disk and write the result. Use for agent-authored ROM hacks: read an existing ROM, decide what to change, patch it out. By default, writes past EOF error; pass allowExpand:true to grow the ROM.",
    {
      input: z.string().describe("Source ROM path."),
      output: z.string().describe("Destination path for the patched ROM."),
      writes: z.array(
        z.object({
          offset: z.number().int().min(0).describe("Absolute byte offset into the ROM."),
          hex: z.string().optional().describe("Hex string of bytes to write."),
          base64: z.string().optional().describe("Base64-encoded bytes to write."),
        }),
      ).min(1).describe("One or more {offset, hex|base64} writes to apply."),
      allowExpand: z.boolean().default(false).describe("Allow the ROM to grow if writes extend past EOF."),
    },
    safeTool(async ({ input, output, writes, allowExpand }) => {
      const { patchRomFile } = await import("../../rom-id/patch.js");
      const r = await patchRomFile({ input, output, writes, allowExpand });
      return jsonContent(r);
    }),
  );

  server.tool(
    "assembleSnippet",
    "Use this to assemble a tiny chunk of asm to raw bytes — no header/linker/segments, just the bytes " +
    "at `origin`. With patchFile this is the whole byte-patch workflow in 2 calls. `cpu` routes to the " +
    "right assembler (6502/65c02/huc6280→ca65, 65816→asar, 68k→vasm, z80→sdasz80, sm83→rgbasm; spc700 " +
    "unsupported). Set `origin` to where the code will live so branches/absolute refs encode right. " +
    "GOTCHA: z80 immediates need a `#` prefix (`ld a,#5`, not `ld a,5`). Returns `{hex, bytes(base64), " +
    "log}` — feed `bytes` straight into patchFile.base64.",
    {
      cpu: z.enum(["6502", "65c02", "huc6280", "65816", "68k", "m68k", "z80", "sm83", "gb", "gbc", "spc700"]).describe("Target CPU dialect — picks the assembler."),
      origin: z.number().int().min(0).default(0).describe("CPU address where the code will live. Required for any code with absolute addressing or relative branches that need real targets."),
      code: z.string().describe("Raw asm source — no header, no segments, no .org / org directive (we add one). Just the instructions."),
    },
    safeTool(async ({ cpu, origin, code }) => {
      const { assembleSnippet } = await import("../../toolchains/assemble-snippet.js");
      const r = await assembleSnippet({ cpu, origin, code });
      return jsonContent({
        cpu: r.cpu,
        origin: r.origin,
        length: r.length,
        hex: r.hex,
        bytes: Buffer.from(r.bytes).toString("base64"),
        log: r.log,
      });
    }),
  );

  server.tool(
    "extractSpriteSheet",
    "Use this to render tiles FROM A ROM FILE ON DISK as a PNG sheet. Point at the tile data with `bank` " +
    "(NES, easiest) or a raw `offset` (SNES/GB/others — graphics can live anywhere; scan in 1-4 KB steps). " +
    "Default palette is grayscale; `paletteFromEmulator:true` (+ `paletteIndex`) colors it like the real " +
    "in-game art for editing. `outputPath` writes the PNG to disk instead of inline. For LIVE graphics " +
    "from a running emulator (or CHR-RAM carts, which have no graphics in the file), use inspectPatternTiles.",
    {
      platform: z.string().describe("Platform id (nes, gb, gbc, snes, genesis, sms, gg, gba, atari7800, lynx)."),
      path: z.string().describe("Absolute path to the ROM file."),
      offset: z.number().int().min(0).optional().describe("Raw byte offset in the ROM file. Use `bank` instead when possible — it's much easier."),
      bank: z.number().int().min(0).max(127).optional().describe("NES: 4 KB CHR bank index (0 = first 4 KB of CHR, 1 = next, ...). Translates to the right file offset for you. Conflicts with `offset` — use one or the other."),
      count: z.number().int().min(1).max(8192).default(256),
      tilesPerRow: z.number().int().min(1).max(64).default(16),
      paletteFromEmulator: z.boolean().optional().describe("Color the export using the live emulator palette (NES/SNES/Genesis). Requires a loaded ROM. Default comes from `intent`: homebrew → true if a ROM is loaded, fall back to per-platform default palette otherwise; rom-hack → false (grayscale)."),
      paletteIndex: z.number().int().min(0).max(15).default(0).describe("Subpalette index when paletteFromEmulator is true. NES: 0-7 (0-3 = BG, 4-7 = sprite); SNES: 0-15; Genesis: 0-3."),
      outputPath: z.string().optional().describe("If set, write the sprite-sheet PNG to this absolute path and return `path` instead of the inline image. Useful when you'll just `extractSpriteSheet → patchRom` without ever viewing the PNG."),
      intent: intentZod(z),
    },
    safeTool(async ({ platform, path: romPath, offset, bank, count, tilesPerRow, paletteFromEmulator, paletteIndex, outputPath, intent }) => {
      const d = resolveIntent(intent);
      const { readFile } = await import("node:fs/promises");
      // R15: atari2600 has no tile region — sprites are raw bitmap rows scattered
      // through code (LDA imm / STA GRP0|GRP1). Refusing here saves a wasted
      // call that would otherwise return 4 KB of noise.
      if (platform === "atari2600") {
        throw new Error(
          "atari2600 has no tile region — sprites are encoded as 1-byte-per-row " +
          "bitmap strips inlined in code (typically LDA imm / STA GRP0/GRP1 sequences). " +
          "Use `disassembleRom` + `findReferences({symbol:'GRP0'})` to locate the strips, " +
          "then read the byte sequences directly with `readMemory` or by inspecting the ROM bytes."
        );
      }
      const bytes = new Uint8Array(await readFile(romPath));

      let tileBytes;
      let note;
      const useOffset = bank !== undefined ? bankToFileOffset(platform, bytes, bank) : offset;
      if (platform === "nes" && useOffset === undefined) {
        const { extractChrFromINes } = await import("../../rom-id/patch.js");
        const chr = extractChrFromINes(bytes);
        if (!chr) {
          throw new Error("CHR-RAM cart — no graphics in the ROM file. Load it and use inspectPatternTiles on the running emulator.");
        }
        tileBytes = chr;
        note = `NES CHR (${chr.length} bytes from iNES file).`;
      } else {
        const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
        const spec = TILE_SPECS[platform];
        if (!spec) throw new Error(`unknown platform '${platform}' — supported: ${Object.keys(TILE_SPECS).join(", ")}`);
        const bytesPerTile = (8 * 8 * spec.bpp) / 8;
        const off = useOffset ?? 0;
        const endOffset = off + count * bytesPerTile;
        if (endOffset > bytes.length) {
          throw new Error(`offset+count exceeds file size (${endOffset} > ${bytes.length})`);
        }
        tileBytes = bytes.slice(off, endOffset);
        note = bank !== undefined
          ? `${platform} bank ${bank} (file offset 0x${off.toString(16)}, ${count} tiles × ${bytesPerTile}B each).`
          : `${platform} tiles at offset 0x${off.toString(16)} (${count} tiles × ${bytesPerTile}B each). Try other offsets if this looks like noise.`;
      }

      // ── Resolve palette per intent ──────────────────────────────
      // Intent dictates whether to pull the live emulator palette (homebrew
      // default) or stay grayscale (rom-hack default). Explicit
      // paletteFromEmulator wins over the intent default.
      let resolvedPaletteFromEmulator = paletteFromEmulator;
      if (resolvedPaletteFromEmulator === undefined) {
        resolvedPaletteFromEmulator = d.colorMode === "live-or-platform";
      }
      let paletteOverride = undefined;
      let paletteSource = "default (grayscale)";
      if (resolvedPaletteFromEmulator) {
        try {
          const { decodeLivePalette } = await import("./preview-tile.js");
          const { TILE_SPECS } = await import("../../platforms/common/image-to-tiles.js");
          const spec = TILE_SPECS[platform];
          const { getHostOrNull } = await import("../state.js");
          const host = getHostOrNull(sessionKey);
          if (host) {
            paletteOverride = decodeLivePalette(host, platform, paletteIndex, spec);
            paletteSource = `emulator (subpalette ${paletteIndex})`;
          } else if (d.colorMode === "live-or-platform" && DEFAULT_PALETTES[platform]) {
            // intent:homebrew with no loaded ROM — fall back to the per-platform
            // default palette so the agent still gets COLOR, not grayscale.
            paletteOverride = getDefaultPalette(platform);
            paletteSource = `per-platform default (no ROM loaded; ${paletteOverride.length}-color)`;
          } else if (paletteFromEmulator === true) {
            // Caller explicitly asked for emulator palette but there's no ROM.
            // Don't silently fall back — surface the issue.
            throw new Error("paletteFromEmulator:true requires a loaded ROM. Call loadMedia first.");
          }
        } catch (e) {
          note = `${note} Palette-from-emulator failed: ${e.message}. Falling back to grayscale.`;
        }
      }

      const { renderTilesGrid } = await import("../../platforms/common/render-tiles.js");
      const png = renderTilesGrid({ platform, tileBytes, tilesPerRow, paletteOverride });
      if (outputPath) {
        const { mkdir, writeFile } = await import("node:fs/promises");
        const path = await import("node:path");
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, png);
        return jsonContent({
          path: outputPath,
          intent: d.intent,
          bytes: png.length,
          paletteSource,
          note,
        });
      }
      return {
        content: [
          imageContent(png.toString("base64")),
          { type: "text", text: `${note} Palette: ${paletteSource}. Intent: ${d.intent}.` },
        ],
      };
    }),
  );
}

/**
 * Translate a "bank N" reference for a platform into a file offset. NES is
 * the well-defined case (4 KB CHR banks immediately after the iNES header
 * + PRG). For other platforms there's no universal "bank N" concept since
 * cart layouts are mapper-specific — throw with a helpful note.
 */
export function bankToFileOffset(platform, bytes, bank) {
  if (platform === "nes") {
    // iNES: header(16) + PRG(prgBanks*16K) + CHR(chrBanks*8K).
    // CHR is the graphics region. Each 4 KB CHR "page" = one bank in the
    // PPU's pattern-table sense (0x0000 or 0x1000). For 8 KB CHR carts
    // bank 0 = first 4 KB, bank 1 = next 4 KB.
    if (bytes[0] !== 0x4E || bytes[1] !== 0x45 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) {
      throw new Error("bank arg requires an iNES file; got something else. Pass `offset` instead.");
    }
    const prgSize = bytes[4] * 16384;
    const chrSize = bytes[5] * 8192;
    if (chrSize === 0) {
      throw new Error("CHR-RAM cart — no CHR in the ROM file. Load it and use inspectPatternTiles instead.");
    }
    const chrBase = 16 + prgSize;
    const offset = chrBase + bank * 4096;
    if (offset >= chrBase + chrSize) {
      const maxBank = Math.floor(chrSize / 4096) - 1;
      throw new Error(`bank ${bank} out of range — this cart has ${chrSize / 4096} CHR banks (0..${maxBank}).`);
    }
    return offset;
  }
  throw new Error(`bank arg not yet supported for platform '${platform}' — pass an explicit \`offset\` for now (or use inspectPatternTiles on a running emulator).`);
}
