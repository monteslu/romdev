import { imageContent, jsonContent, safeTool } from "../util.js";
import { intentZod, resolveIntent } from "../../platforms/common/intent.js";
import { getDefaultPalette, DEFAULT_PALETTES } from "../../platforms/common/default-palette.js";
import { spliceChrCore } from "./splice-chr.js";
import { relocateBlockCore, makeStoredBlockCore, findPointerToCore, PLATFORM_REGISTRY } from "./reinject.js";
import { findFreeSpaceCore } from "./free-space.js";
import { diffRomsCore } from "./diff-roms.js";

/** cart({op:'identify'}) — sniff an unknown ROM/zip's platform. Returns jsonContent. */
export async function identifyRomCore({ path: filePath, base64, hint }) {
    if (!filePath && !base64) throw new Error("identifyRom: provide either `path` (file on disk) or `base64` (ROM bytes).");
    if (filePath && base64) throw new Error("identifyRom: provide `path` OR `base64`, not both.");
    const mod = await import("../../rom-id/identifier.js");
    if (base64) {
      const bytes = new Uint8Array(Buffer.from(base64, "base64"));
      return jsonContent(mod.identifyBytes(bytes, hint ?? ""));
    }
    return jsonContent(await mod.identifyFile(filePath));
}

// romPatch({op:'write'}) — write N bytes into a file at an offset.
export async function patchFileCore({ path: filePath, offset, hex, base64, expect, outputPath, allowExpand }) {
  const { patchFile } = await import("../../rom-id/patch.js");
  return await patchFile({ path: filePath, outputPath, offset, hex, base64, expect, allowExpand });
}

// romPatch({op:'writeMany'}) — apply a list of writes to a ROM file.
export async function patchRomCore({ input, output, writes, allowExpand }) {
  const { patchRomFile } = await import("../../rom-id/patch.js");
  return await patchRomFile({ input, output, writes, allowExpand });
}

export function registerRomIdTools(server, z, sessionKey) {
  // identifyRom folded into `cart`; patchFile/patchRom/spliceCHR/relocate/etc.
  // folded into the `romPatch` tool (router below).
  const PLATFORMS = Object.keys(PLATFORM_REGISTRY);

  server.tool(
    "romPatch",
    "Patch / re-inject / inspect a ROM file on disk, one tool keyed by `op`. The ROM-hack toolkit. " +
    "**`expect=` (the bytes you think are there now) on every write guards the classic wrong-revision-corruption footgun — highly recommended.** " +
    "Spine: `{path, platform}`. **TIP: before patching, prove the byte matters by forcing it live with memory({op:'write'}) on the running emulator (static disasm can't tell 'matches the pattern' from 'actually runs').**\n" +
    "OP CHEAT-SHEET (the params each op uses, beyond the {path, platform} spine): " +
    "write → {offset, hex|base64, expect?, outputPath?, allowExpand?}; " +
    "writeMany → {input, output, writes[]}; " +
    "spliceCHR → {pngBase64, tileIndex, bank?|chrFileOffset?, paletteHint?, expect?}; " +
    "relocate → {newHex|newBase64, toOffset, pointerOffset?, pointerWidth?, pointerEndian?, pointerValue?, dryRun?}; " +
    "makeStored → {rawHex|rawBytes, format, interleave?}; " +
    "findFree → {minLength, fillBytes?, start?, end?}; " +
    "findPointer → {romOffset, mapper?, widths?, suppressShadows?, maxHitsReturned?}; " +
    "diff → {a, b, maxChangesReturned?}.\n" +
    "• op:'write' — write N bytes into any binary file at `offset` (the generic splicer: PRG patches, CHR splices, SNES tile/sample injection). `hex`|`base64`, `expect`, `allowExpand` (grow the file — default OFF; most hacks must NOT change size or headers/mapper break), `outputPath` (else in place).\n" +
    "• op:'writeMany' — apply a LIST of {offset, hex|base64} `writes` from `input` ROM to `output`.\n" +
    "• op:'spliceCHR' — inject a PNG's tiles into a CHR region (`pngBase64`, `tileIndex`, `bank`, `chrFileOffset`, `paletteHint`, `expect`).\n" +
    "• op:'relocate' — write an edited block to free ROM space and repoint a pointer at it (the safe 'don't overwrite in place' move when an edit changes size). `newHex`|`newBase64`, `toOffset` (from op:'findFree'), `pointerOffset` (from op:'findPointer'), `pointerWidth`/`pointerEndian`/`pointerValue`, `dryRun`.\n" +
    "• op:'makeStored' — wrap raw bytes so the game's OWN decompressor expands them VERBATIM (edit tiles → makeStored → write, no compressor needed). `rawHex`|`rawBytes`, `format` (raw/lz77-literal/lz2-direct/sega-rle/konami-rle/...), `interleave`. ALWAYS verify via cpu({op:'call'}) on the game's decompressor.\n" +
    "• op:'findFree' — find a run of free space to relocate into. `minLength`, `fillBytes`, `start`, `end`.\n" +
    "• op:'findPointer' — find every pointer in the ROM that references `romOffset` (platform-correct encoding), the missing piece for redirecting a loader. `mapper` (SNES). On wide systems (Genesis/GBA) a 32-bit hit's low bytes also match the narrower form one byte over — those tail SHADOWS are suppressed by default (see `shadowsSuppressed`); pass `suppressShadows:false` for raw, or `widths:[4]` to search only 32-bit forms. On banked 8-bit systems a 16-bit pointer is page-ambiguous — correlate with the bank-set instruction.\n" +
    "• op:'diff' — diff two ROMs (`a`, `b`) → the changed byte ranges. `maxChangesReturned`.",
    {
      op: z.enum(["write", "writeMany", "spliceCHR", "relocate", "makeStored", "findFree", "findPointer", "diff"])
        .describe("write=N bytes at an offset; writeMany=a list of writes; spliceCHR=PNG tiles into CHR; relocate=write a block to free space + repoint; makeStored=wrap bytes for the game's decompressor; findFree=find free space; findPointer=find pointers to an offset; diff=diff two ROMs."),
      path: z.string().optional().describe("op:write/spliceCHR/relocate/findFree/findPointer — absolute path to the ROM/file."),
      platform: z.enum(PLATFORMS).optional().describe("op:findPointer/relocate/makeStored/findFree/spliceCHR/diff — platform (often inferred from extension where optional)."),
      offset: z.number().int().min(0).optional().describe("op:write — byte offset where the write begins (file offset, not CPU address)."),
      hex: z.string().optional().describe("op:write — bytes to write as hex (whitespace/commas tolerated)."),
      base64: z.string().optional().describe("op:write — bytes to write as base64 (large payloads)."),
      expect: z.string().optional().describe("op:write/spliceCHR — hex of the bytes you EXPECT at the target now; the write is refused on mismatch (wrong-revision guard)."),
      outputPath: z.string().optional().describe("op:write/relocate — write the result here instead of in place."),
      allowExpand: z.boolean().default(false).describe("op:write/writeMany — permit the write to extend past EOF (file grows). Default false."),
      // writeMany
      input: z.string().optional().describe("op:writeMany — source ROM path."),
      output: z.string().optional().describe("op:writeMany — destination path for the patched ROM."),
      writes: z.array(z.object({
        offset: z.number().int().min(0),
        hex: z.string().optional(),
        base64: z.string().optional(),
      })).min(1).optional().describe("op:writeMany — one or more {offset, hex|base64} writes."),
      // spliceCHR
      pngBase64: z.string().optional().describe("op:spliceCHR — base64 PNG whose tiles to inject."),
      tileIndex: z.number().int().min(0).optional().describe("op:spliceCHR — first CHR tile slot to write."),
      bank: z.number().int().min(0).optional().describe("op:spliceCHR — NES CHR bank index."),
      chrFileOffset: z.number().int().min(0).optional().describe("op:spliceCHR — explicit CHR region file offset (overrides bank)."),
      paletteHint: z.array(z.any()).optional().describe("op:spliceCHR — palette to map the PNG colors to indices."),
      // relocate
      newHex: z.string().optional().describe("op:relocate — edited block bytes as hex. Pass this OR newBase64."),
      newBase64: z.string().optional().describe("op:relocate — edited block bytes as base64."),
      toOffset: z.number().int().min(0).optional().describe("op:relocate — file offset to WRITE the block at (a run from op:'findFree')."),
      pointerOffset: z.number().int().min(0).optional().describe("op:relocate — file offset of the pointer to REWRITE (from op:'findPointer'). Omit to only write the block."),
      pointerWidth: z.number().int().min(2).max(4).optional().describe("op:relocate — pointer byte width (default 4 for Genesis/GBA, 2 otherwise)."),
      pointerEndian: z.enum(["le", "be"]).optional().describe("op:relocate — pointer endianness (default 'be' for Genesis, 'le' otherwise)."),
      pointerValue: z.number().int().min(0).optional().describe("op:relocate — override the pointer value to write (else derived from toOffset). Needed when the loader expects a CPU address."),
      dryRun: z.boolean().default(false).describe("op:relocate — preview the writes without modifying any file."),
      // makeStored
      rawHex: z.string().optional().describe("op:makeStored — bytes to store as hex. Pass this OR rawBytes."),
      rawBytes: z.array(z.number().int().min(0).max(255)).optional().describe("op:makeStored — bytes to store as a number array."),
      format: z.string().optional().describe("op:makeStored — stored-block format (default 'raw'; lz77-literal/lz2-direct/sega-rle/konami-rle/packbits/kosinski-literal). Call with an invalid format to see the platform's list."),
      interleave: z.number().int().min(1).max(8).optional().describe("op:makeStored — SMS/GG sega-rle only: deinterleave factor (4 for tiles)."),
      // findFree
      minLength: z.number().int().min(1).optional().describe("op:findFree — minimum free-run length to find."),
      fillBytes: z.array(z.number().int().min(0).max(255)).optional().describe("op:findFree — the filler byte(s) that mark free space (default platform-typical)."),
      start: z.number().int().min(0).optional().describe("op:findFree — restrict the search to start at this offset."),
      end: z.number().int().min(0).optional().describe("op:findFree — restrict the search to end at this offset."),
      maxRunsReturned: z.number().int().min(1).max(2048).default(256).describe("op:findFree — cap the free-runs returned (sorted longest-first)."),
      // findPointer
      romOffset: z.number().int().min(0).optional().describe("op:findPointer — the ROM FILE offset you want to find pointers TO."),
      mapper: z.enum(["lorom", "hirom"]).optional().describe("op:findPointer — SNES only: override mapper detection."),
      maxHitsReturned: z.number().int().min(1).max(2048).default(256).describe("op:findPointer — cap the hits returned."),
      widths: z.array(z.number().int().min(2).max(4)).optional().describe("op:findPointer — only search these pointer byte-widths (e.g. [4] = 32-bit only, skipping the narrower forms that mostly produce shadow hits on Genesis/GBA)."),
      suppressShadows: z.boolean().default(true).describe("op:findPointer — drop a narrower hit when it's the TAIL of a wider hit at the same pointer (e.g. the 24-bit shadow at N+1 of a 32-bit hit at N). Default true; pass false to see every raw form hit. `shadowsSuppressed` reports the count."),
      // diff
      a: z.string().optional().describe("op:diff — path to ROM A."),
      b: z.string().optional().describe("op:diff — path to ROM B."),
      maxChangesReturned: z.number().int().min(1).max(2048).default(256).describe("op:diff — cap the change ranges returned."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "write": {
          if (!args.path || args.offset == null) throw new Error("romPatch({op:'write'}): `path` and `offset` are required.");
          return jsonContent(await patchFileCore(args));
        }
        case "writeMany": {
          if (!args.input || !args.output || !args.writes) throw new Error("romPatch({op:'writeMany'}): `input`, `output`, and `writes` are required.");
          return jsonContent(await patchRomCore(args));
        }
        case "spliceCHR":   return jsonContent(await spliceChrCore(args));
        case "relocate":    return jsonContent(await relocateBlockCore(args));
        case "makeStored":  return jsonContent(await makeStoredBlockCore(args));
        case "findFree":    return jsonContent(await findFreeSpaceCore(args));
        case "findPointer": {
          if (!args.path || args.romOffset == null) throw new Error("romPatch({op:'findPointer'}): `path` and `romOffset` are required.");
          return jsonContent(await findPointerToCore(args));
        }
        case "diff": {
          if (!args.a || !args.b) throw new Error("romPatch({op:'diff'}): `a` and `b` (the two ROM paths) are required.");
          return jsonContent(await diffRomsCore({ ...args, aPath: args.a, bPath: args.b }));
        }
        default: throw new Error(`romPatch: unknown op '${args.op}'`);
      }
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

  // extractSpriteSheet folded into the `tiles` tool (tiles({op:'png', source:'path'})).
}

/**
 * tiles({op:'png'}) over a ROM FILE ON DISK — render tiles to a PNG sheet.
 * Exported so the `tiles` router (tile-inspect.js) can call it. The live-VRAM
 * PNG path is inspectPatternTilesCore; this is the file-source path.
 */
export async function extractSpriteSheetCore({ platform, path: romPath, offset, bank, count = 256, tilesPerRow = 16, paletteFromEmulator, paletteIndex = 0, outputPath, intent }, sessionKey) {
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
