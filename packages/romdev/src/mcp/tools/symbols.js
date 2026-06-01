// MCP tools for cc65 .dbg-based source-aware lookups.
//
// The agent supplies the .dbg text it got back from buildSource({debug:true});
// we parse and answer name → address / address → name queries.
//
// Stateless intentionally — each call parses the .dbg fresh. cc65 .dbg files
// for typical homebrew sizes are <500KB and parse in tens of ms; not worth
// caching for v1.

import { writeFileSync } from "node:fs";
import { jsonContent, safeTool, writeOutput } from "../util.js";

// Tail length kept inline when a big log is written to a sibling file.
const LOG_TAIL = 1200;
/** Log field. Inline → full log. Not inline + small → keep inline (cheap).
 *  Not inline + large + we have a sibling path → write it, return tail+path. */
function logField(log, inline, siblingPath) {
  if (!log) return { log: null };
  if (inline || log.length <= LOG_TAIL) return { log };
  if (siblingPath) {
    writeFileSync(siblingPath, log, "utf8");
    return { logPath: siblingPath, logTail: log.slice(-LOG_TAIL), logBytes: log.length };
  }
  // No place to write (shouldn't happen — handler requires a path when not inline).
  return { logTail: log.slice(-LOG_TAIL), logBytes: log.length };
}

/** Derive sibling output paths (debug file, log) from the ROM outputPath. */
function siblings(romPath) {
  const base = romPath.replace(/\.[^./]+$/, "");
  return { dbg: `${base}.dbg`, map: `${base}.map`, log: `${base}.build.log` };
}

export function registerSymbolTools(server, z) {
  server.tool(
    "buildSourceWithDebug",
    "Like buildSource but also returns linker debug info for resolveSymbol / lookupAddress / getMemoryMap. " +
    "cc65 platforms (NES, C64, Atari 7800, Lynx) produce a `.dbg`; SDCC platforms (GB, GBC, SMS, GG, " +
    "MSX, Coleco, ZXSpectrum) produce an sdld `.map` (grep `AAAAAAAA  _symbol_name`). " +
    "DEFAULT writes the ROM + debug file + (large) log to disk and returns `{binaryPath, dbgPath|mapPath, " +
    "logPath}`; pass `inline:true` to get `binaryBase64` + the debug text + full log in context instead. " +
    "Accepts `source` (single) or `sources` (multi-file map).",
    {
      platform: z.string(),
      source: z.string().optional(),
      sources: z.record(z.string(), z.string()).optional(),
      includes: z.record(z.string(), z.string()).optional(),
      linkerConfig: z.string().optional(),
      crt0: z.string().optional().describe("SDCC platforms only — custom crt0 .s source. Mirror of buildSource's crt0 arg."),
      codeLoc: z.number().optional().describe("SDCC platforms only — code segment address. Default 0x150 on GB/GBC, 0x0000 on others."),
      outputPath: z.string().optional().describe("Absolute path to write the ROM (e.g. your project dir). The .dbg/.map and build log are written alongside it. REQUIRED unless inline:true."),
      inline: z.boolean().default(false).describe("If true, return binaryBase64 + the debug text (dbg/mapText) + full log in the response instead of writing to disk. Default false — and then outputPath is required."),
    },
    safeTool(async ({ platform, source, sources, includes, linkerConfig, crt0, codeLoc, outputPath, inline }) => {
      const CC65_TARGETS = ["nes", "c64", "atari7800", "lynx"];
      const SDCC_TARGETS = ["gb", "gbc", "sms", "gg"];
      const M68K_TARGETS = ["genesis"];
      if (!inline && !outputPath) {
        throw new Error("buildSourceWithDebug: pass outputPath (where to save the ROM; .dbg/.map/log land alongside it) or inline:true to get everything in the response.");
      }
      const sib = outputPath ? siblings(outputPath) : null;

      if (CC65_TARGETS.includes(platform)) {
        const { buildC, buildAsm } = await import("../../toolchains/cc65/cc65.js");
        // Choose builder: if any source filename ends in .c/.h, use buildC; else buildAsm.
        // For single-source we fall back to the content heuristic.
        let useC;
        if (sources) {
          useC = Object.keys(sources).some((n) => /\.(c|h)$/i.test(n));
        } else {
          const looksLikeAsm = /^\s*\.(segment|proc|byte|word|repeat|res|setcpu|export|import|zeropage|code|macro|include)\b/m.test(source);
          useC = !looksLikeAsm && /\b(int|void|return|#include|main\s*\()/.test(source);
        }
        const builder = useC ? buildC : buildAsm;
        const r = await builder({
          source,
          sources,
          target: platform,
          [useC ? "headers" : "includes"]: includes,
          linkerConfig,
          debug: true,
        });
        const out = {
          ok: r.exitCode === 0 && r.binary !== null,
          toolchain: useC ? "cc65" : "ca65+ld65",
          exitCode: r.exitCode,
          binaryBytes: r.binary ? r.binary.length : 0,
          ...logField(r.log, inline, sib?.log),
        };
        if (r.binary) {
          if (inline) out.binaryBase64 = Buffer.from(r.binary).toString("base64");
          else out.binaryPath = writeOutput(r.binary, { outputPath, what: "ROM" }).path;
        }
        if (r.dbg) {
          if (inline) out.dbg = r.dbg;
          else out.dbgPath = writeOutput(r.dbg, { outputPath: sib.dbg, what: ".dbg" }).path;
        }
        return jsonContent(out);
      }

      if (SDCC_TARGETS.includes(platform)) {
        // Route through buildForPlatform so we get the existing SDCC pipeline
        // (lint, crt0, codeLoc defaults, ROM padding) for free. The result
        // shape includes `symbols` which is the sdld .map text.
        const { buildForPlatform } = await import("../../toolchains/index.js");
        const r = await buildForPlatform({
          platform,
          language: "c",
          source,
          sources,
          includes,
          crt0,
          codeLoc,
        });
        const out = {
          ok: r.ok,
          toolchain: r.toolchain || "sdcc",
          exitCode: r.exitCode,
          stage: r.stage,
          binaryBytes: r.binary ? r.binary.length : 0,
          issues: r.issues,
          ...logField(r.log, inline, sib?.log),
          // sdld .map format: lines like `AAAAAAAA  _symbol_name  _source_unit`.
          // Regex /^\s*([0-9A-F]+)\s+(_\S+)/ extracts hex address + symbol.
          // C functions/globals carry a leading underscore; asm symbols don't.
          mapHint: "sdld .map: lines like `AAAAAAAA  _symbol_name  _source_unit`. Regex /^\\s*([0-9A-F]+)\\s+(_\\S+)/ extracts address + symbol; C symbols carry a leading underscore.",
        };
        if (r.binary) {
          if (inline) out.binaryBase64 = Buffer.from(r.binary).toString("base64");
          else out.binaryPath = writeOutput(r.binary, { outputPath, what: "ROM" }).path;
        }
        if (r.symbols) {
          if (inline) out.mapText = r.symbols;
          else out.mapPath = writeOutput(r.symbols, { outputPath: sib.map, what: ".map" }).path;
        }
        return jsonContent(out);
      }

      if (M68K_TARGETS.includes(platform)) {
        // Genesis (m68k-elf gcc/ld). The linker now emits a GNU ld map
        // (symbol → final address) which buildForPlatform surfaces as
        // `symbols`. That's how you find where a RAM variable like `well`
        // landed, then writeMemory to it.
        const { buildForPlatform } = await import("../../toolchains/index.js");
        const r = await buildForPlatform({ platform, language: "c", source, sources, includes });
        const out = {
          ok: r.ok,
          toolchain: r.toolchain || "m68k-elf-gcc",
          exitCode: r.exitCode,
          stage: r.stage,
          binaryBytes: r.binary ? r.binary.length : 0,
          issues: r.issues,
          ...logField(r.log, inline, sib?.log, r.ok),
          mapHint:
            "GNU ld .map: find your symbol in the 'Linker script and memory map' section — lines " +
            "like `0xe0ff0048                well`. SGDK links 68k work-RAM through its mirror at " +
            "0xE0FF0000 (hardware mirrors $FF0000 across the high bus). The work-RAM region is " +
            "exposed as `system_ram` (64KB); the OFFSET into it is the low 16 bits of the symbol " +
            "address — e.g. 0xE0FF0048 → writeMemory({region:'system_ram', offset:0x0048, ...}). " +
            "C symbols have NO leading underscore in the m68k ELF (unlike SDCC's .map).",
        };
        if (r.binary) {
          if (inline) out.binaryBase64 = Buffer.from(r.binary).toString("base64");
          else out.binaryPath = writeOutput(r.binary, { outputPath, what: "ROM" }).path;
        }
        if (r.symbols) {
          if (inline) out.mapText = r.symbols;
          else out.mapPath = writeOutput(r.symbols, { outputPath: sib.map, what: ".map" }).path;
        } else {
          out.mapNote = "No linker map produced (link likely failed — check exitCode/log).";
        }
        return jsonContent(out);
      }

      throw new Error(
        `buildSourceWithDebug supports cc65 targets (${CC65_TARGETS.join(", ")}), ` +
        `SDCC targets (${SDCC_TARGETS.join(", ")}), and m68k targets (${M68K_TARGETS.join(", ")}); got '${platform}'`
      );
    }),
  );

  server.tool(
    "resolveSymbol",
    "Look up the memory address of a C or assembly symbol in a cc65 .dbg file. C symbols (e.g. 'score') become '_score' in the .dbg, so try both spellings. Returns the address (decimal) and a few neighbors for context.",
    {
      dbg: z.string().describe("Contents of the .dbg file (from buildSourceWithDebug)."),
      name: z.string().describe("Symbol name to look up."),
    },
    safeTool(async ({ dbg, name }) => {
      const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
      const idx = new DbgIndex(parseDbg(dbg));
      const addr = idx.addressOf(name);
      if (addr === null && !name.startsWith("_")) {
        const cAlt = "_" + name;
        const a2 = idx.addressOf(cAlt);
        if (a2 !== null) {
          return jsonContent({
            name: cAlt,
            address: a2,
            hex: "$" + a2.toString(16).padStart(4, "0").toUpperCase(),
            note: `Resolved as cc65 C symbol '${cAlt}' (you asked for '${name}').`,
          });
        }
      }
      if (addr === null) {
        throw new Error(`no symbol named '${name}' in this .dbg`);
      }
      return jsonContent({
        name,
        address: addr,
        hex: "$" + addr.toString(16).padStart(4, "0").toUpperCase(),
      });
    }),
  );

  server.tool(
    "lookupAddress",
    "Find the symbol whose value is closest at-or-below the given address — i.e. 'which function/variable does this address fall inside?'.",
    {
      dbg: z.string(),
      address: z.number().int().min(0),
    },
    safeTool(async ({ dbg, address }) => {
      const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
      const idx = new DbgIndex(parseDbg(dbg));
      const sym = idx.symbolAt(address);
      if (!sym) throw new Error(`no symbol at-or-below address ${address}`);
      return jsonContent({
        address,
        hex: "$" + address.toString(16).padStart(4, "0").toUpperCase(),
        symbol: sym.name,
        symbolAddress: sym.addr,
        offset: address - sym.addr,
      });
    }),
  );

  server.tool(
    "getMemoryMap",
    "Categorized layout of where the linker placed your variables and code. Groups symbols by memory region (zeropage / system RAM / code / data) and lists each one with its address. Use this AFTER buildSourceWithDebug to find out where your variables landed — saves you from probing system_ram empirically. NES example: cc65 reserves zeropage bytes $00-$01 for its runtime, so your first .res variable lands at $02.",
    {
      dbg: z.string().describe("Contents of the .dbg file from buildSourceWithDebug."),
      platform: z.string().optional().describe("Platform id — adds region labels (zeropage, system RAM, etc.) per platform conventions."),
    },
    safeTool(async ({ dbg, platform }) => {
      const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
      const idx = new DbgIndex(parseDbg(dbg));
      const all = idx.listSymbols();

      // Per-platform region boundaries. Most cc65 targets follow the
      // host machine's natural CPU memory map.
      const regionsByPlatform = {
        nes:       [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0x7ff},{name:"ppu_regs",lo:0x2000,hi:0x2007},{name:"apu_input",lo:0x4000,hi:0x401f},{name:"sram",lo:0x6000,hi:0x7fff},{name:"prg_rom",lo:0x8000,hi:0xffff}],
        c64:       [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0x9fff},{name:"basic_rom",lo:0xa000,hi:0xbfff},{name:"io",lo:0xd000,hi:0xdfff},{name:"kernal",lo:0xe000,hi:0xffff}],
        atari7800: [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x1800,hi:0x27ff},{name:"cart_rom",lo:0x4000,hi:0xffff}],
        lynx:      [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0xfbff},{name:"hw_regs",lo:0xfc00,hi:0xffff}],
      };
      const regions = (platform && regionsByPlatform[platform]) || [];

      const labelFor = (addr) => {
        for (const r of regions) {
          if (addr >= r.lo && addr <= r.hi) return r.name;
        }
        return "other";
      };

      const grouped = {};
      for (const s of all) {
        const region = labelFor(s.addr);
        if (!grouped[region]) grouped[region] = [];
        grouped[region].push({
          name: s.name,
          address: s.addr,
          hex: "$" + s.addr.toString(16).padStart(4, "0").toUpperCase(),
          kind: s.kind,
        });
      }

      return jsonContent({
        platform: platform ?? null,
        regions: regions.map((r) => ({
          name: r.name,
          range: "$" + r.lo.toString(16).padStart(4, "0").toUpperCase() + "-$" + r.hi.toString(16).padStart(4, "0").toUpperCase(),
        })),
        symbolsByRegion: grouped,
        totalSymbols: all.length,
      });
    }),
  );

  server.tool(
    "listSymbols",
    "List every symbol with an address in a cc65 .dbg, sorted by address. Useful for getting an overview of memory layout — where CODE, BSS, and individual variables live.",
    {
      dbg: z.string(),
      max: z.number().int().min(1).max(10000).default(200).describe("Maximum number of symbols to return."),
    },
    safeTool(async ({ dbg, max }) => {
      const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
      const idx = new DbgIndex(parseDbg(dbg));
      const all = idx.listSymbols();
      return jsonContent({
        total: all.length,
        returned: Math.min(max, all.length),
        symbols: all.slice(0, max).map((s) => ({
          name: s.name,
          address: s.addr,
          hex: "$" + s.addr.toString(16).padStart(4, "0").toUpperCase(),
          kind: s.kind,
        })),
      });
    }),
  );
}
