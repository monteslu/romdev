import { mkdir, mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOLCHAINS } from "../../toolchains/registry.js";
import { buildForPlatform } from "../../toolchains/index.js";
import { resolveLinkerConfig } from "../../toolchains/cc65/preset-resolver.js";
import { resolveCore } from "../../cores/registry.js";
import { resetHost, getDisclosure } from "../state.js";
import { imageContent, jsonContent, safeTool, textContent } from "../util.js";
import { isPlaytestRunning } from "./playtest.js";

// One-shot "open playtest" hint state — per MCP session, set after the
// hint has been delivered once so we don't keep nagging legitimate
// headless flows (CI, automated tests, batch RE work). Keyed by the
// opaque sessionKey passed in to registerToolchainTools so two MCP
// sessions don't share state.
//
// Cleared when the module is reloaded (server restart). That's fine —
// the hint is meant to be a gentle one-time nudge, not durable state.
/** @type {Set<string>} */
const playtestHintGiven = new Set();
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-log gating (mirrors symbols.js logField). A failing/verbose build
// log can be huge and explodes the response. Small logs stay inline; large
// logs are written to a sibling path (when one exists) and only a tail comes
// back; inline:true returns the full log regardless.
const LOG_TAIL = 1200;
/**
 * Fold the build log into a response payload per the gating rule.
 * @param {string|undefined|null} log
 * @param {boolean} inline  caller asked for the full log inline
 * @param {string|null} siblingPath  where to write a large log (e.g. ROM path + ".build.log"); null = nowhere
 * @returns {object} fields to spread into the response
 */
async function logField(log, inline, siblingPath) {
  if (!log) return { log: null };
  if (inline || log.length <= LOG_TAIL) return { log };
  if (siblingPath) {
    await writeFile(siblingPath, log, "utf8");
    return { logPath: siblingPath, logTail: log.slice(-LOG_TAIL), logBytes: log.length };
  }
  // No place to write — the log is a byproduct, not a primary artifact, so
  // return the tail + size rather than throwing.
  return { logTail: log.slice(-LOG_TAIL), logBytes: log.length };
}

// SDCC platforms whose stock-SDCC crt0 doesn't actually boot the target
// hardware. We bundle a working crt0 in lib/c/ for each — when the
// agent calls buildSource without an explicit crt0, auto-inject the
// bundled one so "createProject + buildSource" Just Works.
//
// Paths are relative to src/, resolved against this module's location.
// GB/GBC also ship gb_crt0.s but require codeLoc:0x150 (cart header
// reserves $0100-$014F) — keep them opt-in to avoid breaking scripts
// that don't pass codeLoc.
const AUTO_CRT0_PLATFORMS = {
  sms: "platforms/sms/lib/c/sms_crt0.s",
  gg:  "platforms/gg/lib/c/gg_crt0.s",
};

async function resolveAutoCrt0(platform) {
  const rel = AUTO_CRT0_PLATFORMS[platform];
  if (!rel) return null;
  const abs = path.resolve(__dirname, "..", "..", rel);
  return await readFile(abs, "utf-8");
}

/**
 * Describe a built ROM's on-disk layout in human terms. Surfaces the
 * "why is this 40976 bytes when my code is 200 lines?" question so the
 * agent doesn't have to discover NROM/LoROM padding empirically. Returns
 * null when the platform/binary doesn't have a recognizable header.
 *
 * @param {string} platform
 * @param {Uint8Array | Buffer | null | undefined} bin
 * @returns {string | null}
 */
function describeRomLayout(platform, bin) {
  if (!bin || bin.length < 16) return null;
  const total = bin.length;
  // NES iNES header: "NES\x1A" + prgBanks(16K) + chrBanks(8K) + flags
  if (platform === "nes" && bin[0] === 0x4E && bin[1] === 0x45 && bin[2] === 0x53 && bin[3] === 0x1A) {
    const prgBanks = bin[4];
    const chrBanks = bin[5];
    const flags6 = bin[6];
    const flags7 = bin[7];
    const mapper = (flags6 >> 4) | (flags7 & 0xF0);
    const prgK = prgBanks * 16;
    const chrK = chrBanks * 8;
    const chrKind = chrBanks === 0 ? "CHR-RAM (no CHR data in ROM)" : `${chrK}KB CHR-ROM`;
    return `${total}B = 16B iNES header + ${prgK}KB PRG-ROM + ${chrKind}, mapper ${mapper}` +
      (mapper === 0 ? " (NROM — fixed size; padding is normal)" : "");
  }
  // SNES LoROM/HiROM: size is always 32KB-aligned (LoROM banks) or 64KB-aligned (HiROM).
  if (platform === "snes") {
    const k = Math.floor(total / 1024);
    const layout = total % 32768 === 0 ? "LoROM (32KB banks)" : "HiROM (64KB banks)";
    return `${total}B = ${k}KB, ${layout}`;
  }
  // Genesis: flat 68k binary, finalized like SGDK (padded to a 128KB
  // boundary, min 512KB, with the $18E checksum fixed) so it loads on
  // strict cores (RetroArch Genesis Plus GX, BlastEm) and flashcarts —
  // not just gpgx-WASM.
  if (platform === "genesis") {
    const k = Math.floor(total / 1024);
    const aligned = total % 131072 === 0;
    return `${total}B = ${k}KB 68k ROM (padded to 128KB boundary${aligned ? "" : " — WARN: not aligned"}, $18E checksum fixed; loads on real cores/flashcarts)`;
  }
  // GB / GBC: 32KB minimum (one ROM bank).
  if (platform === "gb" || platform === "gbc") {
    const k = Math.floor(total / 1024);
    return `${total}B = ${k}KB Game Boy ROM (${total >= 32768 ? "≥1 ROM bank" : "smaller than min bank — may not boot"})`;
  }
  return null;
}

export function registerToolchainTools(server, z, sessionKey) {
  server.tool(
    "listToolchains",
    "List all homebrew toolchains romdev ships with. Tier-1 toolchains are bundled WASM (no install required).",
    {},
    safeTool(async () => {
      return jsonContent({
        toolchains: Object.values(TOOLCHAINS).map((t) => ({
          id: t.id,
          displayName: t.displayName,
          platforms: t.platforms,
          tier: t.tier,
          installed: t.tier === 1, // Tier-1 is always bundled
        })),
      });
    }),
  );

  server.tool(
    "installToolchain",
    "Confirm a toolchain is available. In v1 all toolchains are bundled WASM, so this is a no-op that returns the installation status.",
    {
      id: z.string().describe("Toolchain id (e.g. 'cc65', 'rgbds')."),
    },
    safeTool(async ({ id }) => {
      const t = TOOLCHAINS[id];
      if (!t) throw new Error(`unknown toolchain '${id}'. Use listToolchains() to see available ids.`);
      if (t.tier === 1) {
        return textContent(`toolchain '${id}' is bundled — nothing to install`);
      }
      throw new Error(`toolchain '${id}' is tier-2 and not yet implemented in v1`);
    }),
  );

  server.tool(
    "buildSource",
    "Assemble or compile source code for a target platform. Pass either `source` (single file) or `sources` (multi-file project as {name: contents}). With `sources`, each entry becomes its own translation unit — for cc65 platforms (NES/C64/Atari7800/Lynx), .s/.asm files go to ca65 and .c files go to cc65; everything is linked together. Pass `linkerConfig` to override the default ld65 .cfg (useful when you need a larger ZP segment, custom mappers, or extra named segments). Returns the ROM bytes (base64) and the build log. Optionally writes the ROM to `outputPath`.",
    {
      platform: z.string().describe("Target platform id (e.g. 'nes', 'atari2600')."),
      language: z.string().optional().describe("Optional language override (e.g. 'c', 'asm', 'basic'). Each platform has a documented default — omit to use it. Call listPlatforms() to see {defaultLanguage, languages:[...]} per platform. Most agents shouldn't set this; defaults are tuned for vibe-coding (smallest toolchain, fastest build, best LLM fluency). Use only when you specifically need a non-default language."),
      source: z.string().optional().describe("Single source file contents (shortcut). PREFER `sourcePath` for files already on disk — keeps your context small across iterations."),
      sourcePath: z.string().optional().describe("Absolute path to a single source file on disk. Server reads from disk; you don't need to pump the file's contents through your context window. Mutually exclusive with `source`."),
      sources: z
        .record(z.string(), z.string())
        .optional()
        .describe("Multi-file project: filename → source. e.g. {'main.s': '...', 'aliens.s': '...'}"),
      sourcesPaths: z
        .record(z.string(), z.string())
        .optional()
        .describe("Path-based equivalent of `sources`: map of virtual filename → absolute file path. Server reads each from disk. Mutually exclusive with `sources` (mix-and-match across the two not supported)."),
      includes: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional virtual filename → contents map for `.include`d files (NOT separate translation units)."),
      binaryIncludes: z
        .record(z.string(), z.string())
        .optional()
        .describe("Like `includes` but for binary blobs (CHR ROM, music data, etc.). Each value is base64-encoded bytes. Use this for files referenced by `.incbin` so they survive transport without UTF-8 mangling. PREFER `binaryIncludePaths` for files already on disk — avoids loading the base64 into your context."),
      binaryIncludePaths: z
        .record(z.string(), z.string())
        .optional()
        .describe("Path-based equivalent of binaryIncludes: map of virtual filename → absolute file path. The server reads the file directly. Use this instead of binaryIncludes when the source is already on disk — the agent doesn't have to read the bytes into its own context just to forward them."),
      includePaths: z
        .record(z.string(), z.string())
        .optional()
        .describe("Path-based equivalent of `includes` (text files). Server reads from disk and writes into the build sandbox as UTF-8."),
      crt0: z.string().optional().describe("SDCC platforms only. Source contents of a custom crt0.s — server assembles it via sdasgb/sdasz80 and links INSTEAD of SDCC's stock crt0.rel. For SMS and GG, the bundled platform crt0 (src/platforms/<plat>/lib/c/<plat>_crt0.s) is auto-injected when this arg is omitted (stock SDCC crt0 halts before reaching main on those targets). For GB/GBC pass `gb_crt0` contents explicitly + codeLoc:0x150. Provide your own here when you want a project-specific reset vector / IRQ handler."),
      crt0Path: z.string().optional().describe("Path-based equivalent of `crt0` — server reads the .s file from disk."),
      codeLoc: z.coerce.number().int().optional().describe("SDCC platforms: the load address for _CODE. Defaults to $0000. The bundled GB/GBC `gb_crt0.s` reserves $0100-$014F for the cartridge header window and expects _CODE at $0150 — pass `codeLoc: 336` (0x150) when using it. ZX Spectrum default is $8000."),
      dataLoc: z.coerce.number().int().optional().describe("SDCC platforms: the load address for _DATA (WRAM)."),
      options: z.array(z.string()).optional().describe("Extra toolchain CLI options."),
      linkerConfig: z
        .string()
        .optional()
        .describe("ld65 linker config (cc65 platforms only). Either:\n" +
          "  - NES named preset: 'chr-ram-runtime' (RECOMMENDED — bundles the full crt0 with iNES header, NMI handler with OAM DMA + scroll setup, and defines `_shadow_oam` at $0200. Pair with nes_runtime.c). 'chr-ram' is the bare-bones variant with a `nmi: rti` stub and no `_shadow_oam` — only use if you're providing your own NMI handler AND your own shadow OAM definition.\n" +
          "  - Full .cfg contents as a string (overrides per-target default).\n" +
          "Leave empty for the default config (NES default = CHR-ROM with bundled NESfont)."),
      outputPath: z.string().optional().describe("Absolute path. If given, the ROM is written here AND returned by path (not inline). When omitted, the ROM is written to a temp file and that path is returned; pass `inline: true` to instead get the base64 in the response."),
      inline: z.boolean().default(false).describe("If true, include the full ROM as binaryBase64 in the response. Default false — agents pay context for big payloads, and the ROM is on local disk anyway."),
      includeSymbols: z.boolean().default(false).describe("If true, include the toolchain's symbol/map output in the response (e.g. sdld's .map for SDCC builds, ld65's .sym for cc65). When false, only `symbolsBytes` is reported and the actual symbol text is dropped — call `addressToSymbol` to look up specific PCs without loading the whole map. Maps can be 30+ KB on real games."),
      lint: z.enum(["advisory", "strict"]).default("advisory").describe("How to treat pre-flight lint warnings (SDCC platforms only). 'advisory' (default): warnings appear in `issues[]` but the build proceeds normally. 'strict': any lint warning fails the build with ok:false + stage:'lint', forcing you to fix patterns BEFORE the compiler runs. Use 'strict' when you want SDCC crash patterns to be hard errors instead of advisory hints."),
      runtime: z.string().optional().describe("GBA only: runtime selector — 'libtonc' (default), 'libgba' (devkitPro SDK), or 'none' (bare gcc + newlib). See src/platforms/gba/MENTAL_MODEL.md."),
      maxmod: z.boolean().optional().describe("GBA only: link against maxmod for music tracks (libmm.a). Default false. Caller must still call mmInit(...) + mmStart(...) + hook mmVBlank in the IRQ table."),
    },
    safeTool(async ({ platform, language, source, sourcePath, sources, sourcesPaths, includes, binaryIncludes, binaryIncludePaths, includePaths, crt0, crt0Path, codeLoc, dataLoc, options, linkerConfig, outputPath, inline, includeSymbols, lint, runtime, maxmod }) => {
      // Reject conflicting inline vs path args — fail loud, not silent.
      if (source != null && sourcePath != null) {
        throw new Error("buildSource: pass either `source` OR `sourcePath`, not both.");
      }
      if (sources != null && sourcesPaths != null) {
        throw new Error("buildSource: pass either `sources` OR `sourcesPaths`, not both.");
      }
      if (crt0 != null && crt0Path != null) {
        throw new Error("buildSource: pass either `crt0` OR `crt0Path`, not both.");
      }
      // crt0Path → crt0 source.
      if (crt0Path) {
        crt0 = await readFile(crt0Path, "utf-8");
      }
      // Auto-inject the bundled crt0 for SMS/GG when caller didn't pass
      // one. Stock SDCC crt0 doesn't boot these targets; without this,
      // user main() is never called → black screen. See AUTO_CRT0_PLATFORMS.
      if (crt0 == null) {
        crt0 = await resolveAutoCrt0(platform);
      }
      // Resolve sourcePath → source.
      if (sourcePath) {
        source = await readFile(sourcePath, "utf-8");
      }
      // Resolve sourcesPaths → sources.
      if (sourcesPaths) {
        sources = {};
        for (const [name, p] of Object.entries(sourcesPaths)) {
          sources[name] = await readFile(p, "utf-8");
        }
      }
      // Resolve path-based includes by reading from disk. Lets agents skip
      // pumping big binary blobs through their own context window.
      const mergedIncludes = { ...(includes ?? {}) };
      if (includePaths) {
        for (const [name, p] of Object.entries(includePaths)) {
          mergedIncludes[name] = await readFile(p, "utf-8");
        }
      }
      const mergedBinaryIncludes = { ...(binaryIncludes ?? {}) };
      if (binaryIncludePaths) {
        for (const [name, p] of Object.entries(binaryIncludePaths)) {
          const bytes = await readFile(p);
          mergedBinaryIncludes[name] = bytes.toString("base64");
        }
      }
      const { cfg: resolvedLinkerConfig, supportSources } = await resolveLinkerConfig(platform, linkerConfig);
      // Splice preset support sources (e.g. custom crt0) into the project.
      // User sources take precedence — never overwrite a source the agent
      // explicitly provided.
      const mergedSources = sources
        ? { ...supportSources, ...sources }
        : Object.keys(supportSources).length
          ? { ...supportSources, ...(source ? { "main.c": source } : {}) }
          : undefined;
      const useSource = mergedSources ? undefined : source;
      // Assemble caller-supplied crt0 (SDCC platforms). sm83 → sdasgb,
      // everything else → sdasz80.
      let crt0Rel;
      if (crt0) {
        const isSm83 = platform === "gb" || platform === "gbc";
        const { runSdasgb, runSdasz80 } = await import("../../toolchains/sdcc/sdcc.js");
        const asm = isSm83 ? await runSdasgb({ source: crt0 }) : await runSdasz80({ source: crt0 });
        if (!asm.rel) {
          throw new Error(`crt0 assembly failed:\n${asm.log}`);
        }
        crt0Rel = asm.rel;
      }
      const result = await buildForPlatform({
        platform,
        language,
        runtime,
        maxmod,
        source: useSource,
        sources: mergedSources,
        includes: Object.keys(mergedIncludes).length ? mergedIncludes : undefined,
        binaryIncludes: Object.keys(mergedBinaryIncludes).length ? mergedBinaryIncludes : undefined,
        options,
        linkerConfig: resolvedLinkerConfig,
        crt0: crt0Rel,
        codeLoc,
        dataLoc,
      });
      // lint:"strict" — if any lint warning fired, fail the build with
      // stage:"lint" so the agent must fix patterns before iterating.
      // We mutate the result rather than re-running because the lint
      // already ran inside buildForPlatform.
      if (lint === "strict" && result.issues) {
        const lintHits = result.issues.filter((x) => x.stage === "lint");
        if (lintHits.length > 0) {
          result.ok = false;
          result.binary = null;          // refuse to ship a binary in strict mode
          result.stage = "lint";
          result.exitCode = result.exitCode || 1;
          result.lintStrictBlocked = lintHits.length;
        }
      }
      let finalPath = null;
      if (result.binary) {
        if (outputPath) {
          await writeFile(outputPath, result.binary);
          finalPath = outputPath;
        } else if (!inline) {
          // Default: write to a temp file so the response stays tiny.
          const tmpDir = await mkdtemp(path.join(tmpdir(), "romdev-"));
          finalPath = path.join(tmpDir, "out.bin");
          await writeFile(finalPath, result.binary);
        }
      }
      // One-shot session hint: nudge the agent toward playtest the first
      // time a build succeeds, IF the show category isn't already loaded.
      // Fires once per session so it isn't spam on every iteration.
      const d = getDisclosure();
      const showHint = result.ok && d && !d.isLoaded("show")
        ? d.consumeHint(
            "show-after-first-build",
            "Build succeeded — your user can watch the game live by calling " +
            "loadCategory({category:'show'}) then playtestStart({}). The emulator " +
            "stays available to all other tools (screenshot, readMemory, saveState, " +
            "pause, stepFrames, ...) — playtest just opens a native window so a human " +
            "can see what you're building. Recommended early in any session where a " +
            "user is watching."
          )
        : null;
      // Gate the build log: small → inline; large → sibling file next to the
      // ROM (or its tail when there's nowhere to write); inline:true → full.
      const logSibling = finalPath ? `${finalPath}.build.log` : null;
      const payload = {
        ok: result.ok,
        toolchain: result.toolchain,
        exitCode: result.exitCode,
        binaryBytes: result.binary ? result.binary.length : 0,
        binaryPath: finalPath,
        outputPath: outputPath && result.binary ? outputPath : null,
        romLayout: describeRomLayout(platform, result.binary),
        ...(result.ramUsage ? { ramUsage: result.ramUsage } : {}),
        ...(result.stage ? { stage: result.stage } : {}),
        ...(await logField(result.log, inline, logSibling)),
        issues: result.issues ?? [],
        ...(showHint ? { hint: showHint } : {}),
      };
      // When a build failed on a specific TU (multi-source SDCC build),
      // surface that explicitly so the agent doesn't have to grep the
      // log for "FAILED on TU 'name'". If sourcesPaths was used, also
      // include the host path so the agent can open the right file.
      if (result.failedTU) {
        payload.failedTU = result.failedTU;
        payload.compiledOK = result.compiledOK ?? [];
        if (sourcesPaths && sourcesPaths[result.failedTU]) {
          payload.failedTUHostPath = sourcesPaths[result.failedTU];
        }
      }
      // lint:"strict" — surface the count of lint hits that blocked the
      // build so the agent immediately knows WHY ok:false (vs. a real
      // compiler error).
      if (result.lintStrictBlocked) {
        payload.lintStrictBlocked = result.lintStrictBlocked;
        payload.note = `Build failed in lint:"strict" mode — ${result.lintStrictBlocked} pattern(s) flagged. ` +
                       `Fix the issues[] entries with stage:"lint" and rebuild. Pass lint:"advisory" (default) to treat them as warnings instead.`;
      }
      // Only include binaryBase64 when the caller actually wants the
      // bytes inline. Otherwise it's just a confusing `null` field on
      // every response.
      if (inline && result.binary) {
        payload.binaryBase64 = Buffer.from(result.binary).toString("base64");
      }
      // Symbols/map info: only include when the underlying toolchain
      // produced something. SDCC stuffs the .map file here; cc65 writes
      // a .sym table; vasm68k emits a listing. Keep it small.
      if (result.symbols && result.symbols.length > 0) {
        payload.symbolsBytes = result.symbols.length;
        // Don't embed the whole map by default — it can be 30+ KB on
        // bigger games and explodes the response. Caller passes
        // `includeSymbols:true` to opt in.
        if (includeSymbols) {
          payload.symbols = result.symbols;
        } else {
          payload.symbolsHint = "Pass `includeSymbols: true` to get the full .map/.sym text inline. Or call `addressToSymbol({pc})` to look up a single address without loading it.";
        }
      }
      return jsonContent(payload);
    }),
  );

  server.tool(
    "runSource",
    "BUILD + LOAD + RUN + SCREENSHOT in one round trip — the fastest agent iteration loop. Pass `source` (single file) or `sources` (multi-file project); compiles for `platform`, loads the binary into the matching core without touching disk, runs `frames` frames, and returns the screenshot INLINE (this tool's whole point is to show you the result). Optionally hold controller input via `holdInputs`. If your client can't display inline images, pass `screenshotPath` to write the PNG to disk and get a path back instead.",
    {
      platform: z.string(),
      language: z.string().optional().describe("See buildSource — 'c' or 'asm'. GBA only supports 'c' today."),
      source: z.string().optional(),
      sourcePath: z.string().optional().describe("Path-based equivalent of `source`. See buildSource."),
      sources: z.record(z.string(), z.string()).optional(),
      sourcesPaths: z.record(z.string(), z.string()).optional().describe("Path-based equivalent of `sources`."),
      includes: z.record(z.string(), z.string()).optional(),
      binaryIncludes: z.record(z.string(), z.string()).optional(),
      binaryIncludePaths: z.record(z.string(), z.string()).optional().describe("Path-based binaryIncludes — see buildSource."),
      includePaths: z.record(z.string(), z.string()).optional(),
      runtime: z.string().optional().describe("See buildSource — GBA runtime selector: 'libtonc' (default), 'libgba', or 'none'."),
      maxmod: z.boolean().optional().describe("GBA only: link against maxmod for music tracks (libmm.a). Default false. Caller must still call mmInit(...) + mmStart(...) + hook mmVBlank in the IRQ table."),
      crt0: z.string().optional().describe("See buildSource — custom crt0.s contents (SDCC platforms only)."),
      crt0Path: z.string().optional().describe("Path-based crt0 — see buildSource."),
      codeLoc: z.coerce.number().int().optional().describe("See buildSource — _CODE load address (SDCC platforms)."),
      dataLoc: z.coerce.number().int().optional().describe("See buildSource — _DATA load address (SDCC platforms)."),
      linkerConfig: z.string().optional(),
      frames: z.number().int().min(1).max(100000).default(60),
      holdInputs: z
        .array(
          z.object({
            up: z.boolean().optional(), down: z.boolean().optional(),
            left: z.boolean().optional(), right: z.boolean().optional(),
            a: z.boolean().optional(), b: z.boolean().optional(),
            x: z.boolean().optional(), y: z.boolean().optional(),
            l: z.boolean().optional(), r: z.boolean().optional(),
            l2: z.boolean().optional(), r2: z.boolean().optional(),
            l3: z.boolean().optional(), r3: z.boolean().optional(),
            start: z.boolean().optional(), select: z.boolean().optional(),
          }),
        )
        .max(2)
        .optional()
        .describe("Per-port input state to hold during the run. Index 0 = port 0."),
      screenshotPath: z.string().optional().describe("If set, write the result screenshot to this path and return {screenshotPath} instead of the inline image. Use this if your client can't display inline images. Default: the screenshot comes back inline (runSource's whole point is to show you the result)."),
    },
    safeTool(async ({ platform, language, source, sourcePath, sources, sourcesPaths, includes, binaryIncludes, binaryIncludePaths, includePaths, runtime, maxmod, crt0, crt0Path, codeLoc, dataLoc, linkerConfig, frames, holdInputs, screenshotPath }) => {
      const { buildForPlatform } = await import("../../toolchains/index.js");
      const resolved = resolveCore(platform);
      if (!resolved) throw new Error(`no core available for platform '${platform}'`);

      if (source != null && sourcePath != null) {
        throw new Error("runSource: pass either `source` OR `sourcePath`, not both.");
      }
      if (sources != null && sourcesPaths != null) {
        throw new Error("runSource: pass either `sources` OR `sourcesPaths`, not both.");
      }
      if (crt0 != null && crt0Path != null) {
        throw new Error("runSource: pass either `crt0` OR `crt0Path`, not both.");
      }
      if (crt0Path) {
        crt0 = await readFile(crt0Path, "utf-8");
      }
      // Auto-inject bundled crt0 for SMS/GG when caller didn't pass one
      // (stock SDCC crt0 doesn't boot these targets — see buildSource).
      if (crt0 == null) {
        crt0 = await resolveAutoCrt0(platform);
      }
      if (sourcePath) {
        source = await readFile(sourcePath, "utf-8");
      }
      if (sourcesPaths) {
        sources = {};
        for (const [name, p] of Object.entries(sourcesPaths)) {
          sources[name] = await readFile(p, "utf-8");
        }
      }
      const mergedIncludes = { ...(includes ?? {}) };
      if (includePaths) {
        for (const [name, p] of Object.entries(includePaths)) {
          mergedIncludes[name] = await readFile(p, "utf-8");
        }
      }
      const mergedBinaryIncludes = { ...(binaryIncludes ?? {}) };
      if (binaryIncludePaths) {
        for (const [name, p] of Object.entries(binaryIncludePaths)) {
          const bytes = await readFile(p);
          mergedBinaryIncludes[name] = bytes.toString("base64");
        }
      }
      const { cfg: resolvedLinkerConfig2, supportSources: supportSources2 } = await resolveLinkerConfig(platform, linkerConfig);
      const mergedSources2 = sources
        ? { ...supportSources2, ...sources }
        : Object.keys(supportSources2).length
          ? { ...supportSources2, ...(source ? { "main.c": source } : {}) }
          : undefined;
      const useSource2 = mergedSources2 ? undefined : source;
      // Assemble caller-supplied crt0 (SDCC platforms).
      let crt0Rel2;
      if (crt0) {
        const isSm83 = platform === "gb" || platform === "gbc";
        const { runSdasgb, runSdasz80 } = await import("../../toolchains/sdcc/sdcc.js");
        const asm = isSm83 ? await runSdasgb({ source: crt0 }) : await runSdasz80({ source: crt0 });
        if (!asm.rel) {
          throw new Error(`crt0 assembly failed:\n${asm.log}`);
        }
        crt0Rel2 = asm.rel;
      }
      const build = await buildForPlatform({
        platform,
        language,
        runtime,
        maxmod,
        source: useSource2,
        sources: mergedSources2,
        includes: Object.keys(mergedIncludes).length ? mergedIncludes : undefined,
        binaryIncludes: Object.keys(mergedBinaryIncludes).length ? mergedBinaryIncludes : undefined,
        linkerConfig: resolvedLinkerConfig2,
        crt0: crt0Rel2,
        codeLoc,
        dataLoc,
      });
      if (!build.ok || !build.binary) {
        // runSource builds in-memory (no ROM path), so a large failure log
        // has nowhere to land — gate it to a tail + size rather than dumping
        // the whole thing. No `inline` param here; the tail is the contract.
        return jsonContent({
          ok: false,
          stage: "build",
          toolchain: build.toolchain,
          exitCode: build.exitCode,
          ...(await logField(build.log, false, null)),
          issues: build.issues ?? [],
        });
      }

      const host = resetHost(sessionKey);
      await host.loadCore(resolved.jsPath, resolved.wasmPath);
      await host.loadMedia({ platform, bytes: build.binary });
      if (holdInputs && holdInputs.length > 0) {
        host.setInput({ ports: holdInputs });
      }
      host.stepFrames(frames);
      // NES: the NMI handler DMAs shadow OAM → real OAM at the START of each
      // vblank, so sprites the game staged on frame N only become visible
      // when frame N+1 renders. Without this, the screenshot looks "one frame
      // behind" the staged OAM (a real surprise agents hit during debugging).
      // Step one extra frame on NES so the screenshot matches staged sprites.
      if (platform === "nes") host.stepFrames(1);
      const shot = host.screenshot();

      // One-shot "open playtest" hint. Conditions to attach:
      //   - the run succeeded (we only got here on success)
      //   - no playtest window is currently open
      //   - we haven't already delivered the hint in this MCP session
      // Repeated hints would be annoying for legitimate headless flows
      // (CI, automated tests, agent working alone). Once is a nudge;
      // repeated is friction.
      let hint;
      if (!isPlaytestRunning() && !playtestHintGiven.has(sessionKey)) {
        playtestHintGiven.add(sessionKey);
        hint = "No playtest window is open. If a human is watching, consider " +
               "`loadCategory({category:\"show\"})` then `playtest()` so they can " +
               "play this ROM live while you keep iterating with runSource " +
               "(rebuilds update the live game in place). Skip if this session " +
               "is headless (CI / batch / automated).";
      }

      const summary = {
        ok: true,
        platform,
        core: resolved.coreName,
        toolchain: build.toolchain,
        binaryBytes: build.binary.length,
        romLayout: describeRomLayout(platform, build.binary),
        ...(build.ramUsage ? { ramUsage: build.ramUsage } : {}),
        framesRun: frames,
        framebuffer: { width: shot.width, height: shot.height },
        // Surface lint/build issues even on successful runs so agents see
        // linter warnings BEFORE the next iteration (was: runSource silently
        // ran with warnings, agent missed them, hit the crash 100 functions later).
        ...((build.issues ?? []).length > 0 ? { issues: build.issues } : {}),
        ...(hint ? { hint } : {}),
      };

      // Default: screenshot comes back inline (runSource is the "show me the
      // result" loop). If screenshotPath is set, write it there instead —
      // for clients that can't display inline images.
      if (screenshotPath) {
        await writeFile(screenshotPath, Buffer.from(shot.pngBase64, "base64"));
        const json = jsonContent({ ...summary, screenshotPath });
        json._observerImages = [{ kind: "image", mimeType: "image/png", base64: shot.pngBase64 }];
        return json;
      }
      return {
        content: [
          imageContent(shot.pngBase64),
          { type: "text", text: JSON.stringify(summary, null, 2) },
        ],
      };
    }),
  );

  server.tool(
    "buildProject",
    "Build all source files in a project directory and produce a ROM. Reads `main.asm` (or `main.s`) plus all `.asm`/`.s`/`.inc` files in the directory as includes.",
    {
      path: z.string().describe("Absolute path to the project directory."),
      platform: z.string().describe("Target platform id."),
      outputPath: z.string().optional().describe("Absolute path for the output ROM."),
    },
    safeTool(async ({ path: projPath, platform, outputPath }) => {
      const entries = await readdir(projPath, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile());

      const sourceCandidates = ["main.asm", "main.s"];
      const mainEntry = files.find((f) => sourceCandidates.includes(f.name));
      if (!mainEntry) {
        throw new Error(
          `no main.asm or main.s found in ${projPath}. v1 looks for one of those as the entry point.`,
        );
      }
      const source = await readFile(path.join(projPath, mainEntry.name), "utf-8");
      /** @type {Record<string, string>} */
      const includes = {};
      for (const f of files) {
        if (f.name === mainEntry.name) continue;
        if (/\.(asm|s|inc|h)$/i.test(f.name)) {
          includes[f.name] = await readFile(path.join(projPath, f.name), "utf-8");
        }
      }

      const result = await buildForPlatform({ platform, source, includes });
      if (outputPath && result.binary) {
        await writeFile(outputPath, result.binary);
      }
      // Gate the log next to the output ROM when one exists; otherwise return
      // its tail + size (the log is a byproduct — never throw over it).
      const logSibling = outputPath && result.binary ? `${outputPath}.build.log` : null;
      return jsonContent({
        ok: result.ok,
        toolchain: result.toolchain,
        exitCode: result.exitCode,
        binaryBytes: result.binary ? result.binary.length : 0,
        outputPath: outputPath && result.binary ? outputPath : null,
        ...(await logField(result.log, false, logSibling)),
        issues: result.issues ?? [],
      });
    }),
  );
}
