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
import { addressToSymbolCore } from "./address-to-symbol.js";

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

// build({output:'romWithDebug'}) — the cc65 .dbg / sdld .map / m68k ELF-map
// build. Exported core; the `build` router (toolchain.js) calls it.
export async function buildSourceWithDebugCore({ platform, source, sources, includes, linkerConfig, crt0, codeLoc, outputPath, inline = false }) {
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
        `build({output:'romWithDebug'}) supports cc65 targets (${CC65_TARGETS.join(", ")}), ` +
        `SDCC targets (${SDCC_TARGETS.join(", ")}), and m68k targets (${M68K_TARGETS.join(", ")}); got '${platform}'`
      );
}

export function registerSymbolTools(server, z) {
  // buildSourceWithDebug is now build({output:'romWithDebug'}) — registered by
  // the `build` router in toolchain.js (imports buildSourceWithDebugCore).
  registerSymbolsTool(server, z);
}

// ── *Core functions for the `symbols` tool ──

/**
 * Load a normalized symbol list from whichever debug format the caller passed:
 * cc65 `.dbg`, SDCC sdld `.map`, OR GNU ld `.map` (Genesis/m68k). Auto-detects
 * the map flavor. Returns `{ name, addr, kind, ramOffset? }[]`. This is what
 * gave Genesis/m68k C globals a name→address path (was cc65-only before).
 */
async function loadSymbolList({ dbg, map }) {
  if (dbg) {
    const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
    const idx = new DbgIndex(parseDbg(dbg));
    return { format: "cc65-dbg", symbols: idx.listSymbols() }; // {name, addr, kind}
  }
  if (map) {
    const { isGnuLdMap, parseGnuLdMap } = await import("../../toolchains/gnu-ld-map.js");
    if (isGnuLdMap(map)) {
      // Genesis / m68k-elf. C symbols have NO leading underscore here.
      const syms = parseGnuLdMap(map).map((s) => ({
        name: s.name, addr: s.address, kind: "symbol", ramOffset: s.ramOffset,
      }));
      return { format: "gnu-ld-map", symbols: syms };
    }
    const { parseSdldMap } = await import("../../toolchains/sdcc/sdcc.js");
    const syms = parseSdldMap(map).map((s) => ({
      name: s.name.replace(/^_/, ""), addr: s.address, kind: "symbol", file: s.file,
    }));
    return { format: "sdld-map", symbols: syms };
  }
  throw new Error(
    "symbols: pass `dbg` (cc65 .dbg — NES/C64/Atari7800/Lynx/PCE) or `map` " +
    "(sdld .map for GB/GBC/SMS/GG/MSX, OR GNU ld .map for Genesis). " +
    "build({output:'romWithDebug'}) returns the right one for your platform."
  );
}

/** Format an address as `$XXXX` hex (pad to at least 4 digits). */
function hexAddr(a) {
  const w = a > 0xffff ? 8 : 4;
  return "$" + a.toString(16).toUpperCase().padStart(w, "0");
}

/** Annotate a Genesis work-RAM-mirror symbol with the system_ram read offset. */
function ramReadHint(sym) {
  if (sym.ramOffset == null) return {};
  return {
    ramOffset: sym.ramOffset,
    readHint: `Genesis work-RAM mirror — read it with memory({op:'read', region:'system_ram', offset:0x${sym.ramOffset.toString(16)}}) (the low 16 bits of the address).`,
  };
}

/** op:'resolve' — symbol name → address. cc65 .dbg, sdld .map, OR GNU ld .map (Genesis). */
export async function resolveSymbolCore({ dbg, map, name }) {
      // cc65 .dbg keeps its bespoke index (it understands the '_name' C alias).
      if (dbg && !map) {
        const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
        const idx = new DbgIndex(parseDbg(dbg));
        let addr = idx.addressOf(name);
        let resolvedName = name;
        if (addr === null && !name.startsWith("_")) {
          const a2 = idx.addressOf("_" + name);
          if (a2 !== null) { addr = a2; resolvedName = "_" + name; }
        }
        if (addr === null) throw new Error(`no symbol named '${name}' in this .dbg`);
        return {
          name: resolvedName, address: addr, hex: hexAddr(addr),
          ...(resolvedName !== name ? { note: `Resolved as cc65 C symbol '${resolvedName}' (you asked for '${name}').` } : {}),
        };
      }
      // sdld / GNU ld map path.
      const { format, symbols } = await loadSymbolList({ dbg, map });
      let hit = symbols.find((s) => s.name === name);
      // SDCC strips the leading underscore on load; a caller passing '_score' still matches.
      if (!hit && name.startsWith("_")) hit = symbols.find((s) => s.name === name.slice(1));
      if (!hit) throw new Error(`no symbol named '${name}' in this ${format}.`);
      return { name: hit.name, address: hit.addr, hex: hexAddr(hit.addr), format, ...ramReadHint(hit) };
}

/** op:'lookup' — address → the symbol whose value is closest at-or-below it. cc65 .dbg, sdld/GNU .map. */
export async function lookupAddressCore({ dbg, map, address }) {
      if (dbg && !map) {
        const { parseDbg, DbgIndex } = await import("../../toolchains/cc65/dbgparse.js");
        const idx = new DbgIndex(parseDbg(dbg));
        const sym = idx.symbolAt(address);
        if (!sym) throw new Error(`no symbol at-or-below address ${address}`);
        return {
          address, hex: hexAddr(address),
          symbol: sym.name, symbolAddress: sym.addr, offset: address - sym.addr,
        };
      }
      const { format, symbols } = await loadSymbolList({ dbg, map });
      // Nearest symbol at-or-below `address`.
      let best = null;
      for (const s of symbols) {
        if (s.addr <= address && (!best || s.addr > best.addr)) best = s;
      }
      if (!best) throw new Error(`no symbol at-or-below address ${address} in this ${format}.`);
      return {
        address, hex: hexAddr(address), format,
        symbol: best.name, symbolAddress: best.addr, offset: address - best.addr,
      };
}

/** op:'map' — categorized layout of where the linker placed code+vars (cc65 .dbg OR sdld .map). */
export async function getMemoryMapCore({ dbg, map, platform }) {
      // Per-platform region boundaries (CPU memory map). cc65 6502 targets +
      // the Z80 family (SDCC) — both keyed the same way.
      const regionsByPlatform = {
        nes:       [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0x7ff},{name:"ppu_regs",lo:0x2000,hi:0x2007},{name:"apu_input",lo:0x4000,hi:0x401f},{name:"sram",lo:0x6000,hi:0x7fff},{name:"prg_rom",lo:0x8000,hi:0xffff}],
        c64:       [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0x9fff},{name:"basic_rom",lo:0xa000,hi:0xbfff},{name:"io",lo:0xd000,hi:0xdfff},{name:"kernal",lo:0xe000,hi:0xffff}],
        atari7800: [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x1800,hi:0x27ff},{name:"cart_rom",lo:0x4000,hi:0xffff}],
        lynx:      [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x100,hi:0x1ff},{name:"system_ram",lo:0x200,hi:0xfbff},{name:"hw_regs",lo:0xfc00,hi:0xffff}],
        // PC Engine (cc65 pce target): ZP + 8KB work RAM at $2200 (the pce.cfg
        // MAIN segment), HuCard ROM mapped high. The HuC6280 stack lives in the
        // $21xx page via the MPR mapping.
        pce:       [{name:"zeropage",lo:0,hi:0xff},{name:"stack",lo:0x2100,hi:0x21ff},{name:"system_ram",lo:0x2200,hi:0x3fff},{name:"hucard_rom",lo:0xe000,hi:0xffff}],
        // Z80 family (SDCC + sdld .map). Cartridge ROM in the low half, work RAM high.
        gb:        [{name:"rom",lo:0,hi:0x7fff},{name:"vram",lo:0x8000,hi:0x9fff},{name:"cart_ram",lo:0xa000,hi:0xbfff},{name:"work_ram",lo:0xc000,hi:0xdfff},{name:"oam",lo:0xfe00,hi:0xfe9f},{name:"io_hram",lo:0xff00,hi:0xffff}],
        gbc:       [{name:"rom",lo:0,hi:0x7fff},{name:"vram",lo:0x8000,hi:0x9fff},{name:"cart_ram",lo:0xa000,hi:0xbfff},{name:"work_ram",lo:0xc000,hi:0xdfff},{name:"oam",lo:0xfe00,hi:0xfe9f},{name:"io_hram",lo:0xff00,hi:0xffff}],
        sms:       [{name:"rom",lo:0,hi:0xbfff},{name:"work_ram",lo:0xc000,hi:0xdfff},{name:"ram_mirror",lo:0xe000,hi:0xffff}],
        gg:        [{name:"rom",lo:0,hi:0xbfff},{name:"work_ram",lo:0xc000,hi:0xdfff},{name:"ram_mirror",lo:0xe000,hi:0xffff}],
        // MSX cartridge: BIOS low, cart at $4000-$BFFF, work RAM $C000-$FFFF.
        msx:       [{name:"bios",lo:0,hi:0x3fff},{name:"cart_rom",lo:0x4000,hi:0xbfff},{name:"work_ram",lo:0xc000,hi:0xffff}],
        // Genesis (m68k-elf GNU ld map): ROM low, work-RAM mirror at $E0FF0000
        // (= the emulator's `system_ram`, offset = low 16 bits of the symbol addr).
        genesis:   [{name:"rom",lo:0,hi:0x3fffff},{name:"work_ram_mirror",lo:0xe0ff0000,hi:0xe0ffffff}],
      };

      // Parse symbols from whichever format was supplied (auto-detects sdld vs GNU ld).
      const { format, symbols: all } = await loadSymbolList({ dbg, map });

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

      return {
        platform: platform ?? null,
        format,
        regions: regions.map((r) => ({
          name: r.name,
          range: "$" + r.lo.toString(16).padStart(4, "0").toUpperCase() + "-$" + r.hi.toString(16).padStart(4, "0").toUpperCase(),
        })),
        symbolsByRegion: grouped,
        totalSymbols: all.length,
      };
}

/** op:'list' — every symbol sorted by address. cc65 .dbg, sdld .map, OR GNU ld .map (Genesis). */
export async function listSymbolsCore({ dbg, map, max = 200 }) {
      const { format, symbols } = await loadSymbolList({ dbg, map });
      const all = symbols.slice().sort((a, b) => a.addr - b.addr);
      return {
        format,
        total: all.length,
        returned: Math.min(max, all.length),
        symbols: all.slice(0, max).map((s) => ({
          name: s.name,
          address: s.addr,
          hex: hexAddr(s.addr),
          kind: s.kind,
          ...(s.ramOffset != null ? { ramOffset: s.ramOffset } : {}),
        })),
      };
}

function registerSymbolsTool(server, z) {
  server.tool(
    "symbols",
    "Symbol/linker-map lookups for C/asm-built ROMs — resolve names ↔ addresses and see the memory layout, on EVERY " +
    "platform with a debug build. `op`: 'resolve' | 'lookup' | 'map' | 'list' | 'addr'.\n" +
    "DEBUG SOURCE (pass ONE; build({output:'romWithDebug'}) returns the right one): `dbg` = cc65 `.dbg` " +
    "(NES/C64/Atari7800/Lynx/PCE); `map` = a linker map — auto-detects sdld `.map` (GB/GBC/SMS/GG/MSX) vs GNU ld `.map` " +
    "(Genesis/m68k, the `mapText`/`symbols` field). So resolve/lookup/list/map all work across ALL 14 platforms now.\n" +
    "'resolve' (name→address): the 1-call headless-assertion enabler — resolve a C global, then memory({op:'read'}) it. " +
    "**GENESIS: a work-RAM symbol comes back with `ramOffset` (the low 16 bits) + a `readHint` — read it via " +
    "memory({op:'read', region:'system_ram', offset:ramOffset}).** cc65 C symbols become '_score' in the .dbg (tried automatically).\n" +
    "'lookup' (address→symbol): which function/variable does this address fall inside?\n" +
    "'map' (categorized layout): groups symbols by memory region (zeropage / system RAM / work_ram_mirror / code / data) " +
    "so you find where variables landed without probing RAM. NES: cc65 reserves ZP $00-$01, so your first .res var lands at $02.\n" +
    "'list': every symbol sorted by address — a layout overview.\n" +
    "'addr' (PC→nearest preceding symbol): closes 'cpu({op:'read'}) gave me $01A7 — which C function?' on EVERY platform. " +
    "Pass `symbolsText` (inline, from build({includeSymbols:true}) or the romWithDebug map) or `symbolsPath`. Auto-detects sdld " +
    "(`XXXX  _name`, GB/GBC/SMS/GG/MSX), ld65 VICE (`al XXXX .name`, cc65), and GNU ld maps (Genesis/m68k + GBA/ARM).",
    {
      op: z.enum(["resolve", "lookup", "map", "list", "addr"]).describe("resolve name→addr; lookup addr→sym; map = layout by region; list all; addr = PC→nearest symbol."),
      dbg: z.string().optional().describe("op=resolve/lookup/list/map (cc65 path): contents of the .dbg from build({output:'romWithDebug'}) — NES/C64/Atari7800/Lynx/PCE. Pass this OR `map`."),
      map: z.string().optional().describe("op=resolve/lookup/list/map (linker-map path): the .map text — auto-detects sdld (GB/GBC/SMS/GG/MSX) vs GNU ld (Genesis/m68k). The `mapText`/`symbols` field on build({output:'romWithDebug'}). Pass this OR `dbg`."),
      name: z.string().optional().describe("op=resolve: the symbol name to look up (C name — no leading underscore needed; both spellings tried)."),
      address: z.number().int().min(0).optional().describe("op=lookup: the address to find the enclosing symbol for."),
      max: z.number().int().min(1).max(10000).default(200).describe("op=list: maximum symbols to return."),
      platform: z.string().optional().describe("op=map: platform id — adds region labels per platform conventions (incl. genesis work-RAM mirror)."),
      // addr
      pc: z.number().int().min(0).max(0xFFFFFF).optional().describe("op=addr: CPU address to look up (e.g. 0x01A7)."),
      symbolsText: z.string().optional().describe("op=addr: inline .map/.sym text (from build response.symbols)."),
      symbolsPath: z.string().optional().describe("op=addr: absolute path to a .map/.sym file. Mutually exclusive with symbolsText."),
    },
    safeTool(async (args) => {
      switch (args.op) {
        case "resolve": return jsonContent(await resolveSymbolCore(args));
        case "lookup":  return jsonContent(await lookupAddressCore(args));
        case "map":     return jsonContent(await getMemoryMapCore(args));
        case "list":    return jsonContent(await listSymbolsCore(args));
        case "addr":    return jsonContent(await addressToSymbolCore(args));
        default: throw new Error(`symbols: unknown op '${args.op}'`);
      }
    }),
  );
}
