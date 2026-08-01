import { mkdir, mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOLCHAINS } from "../../toolchains/registry.js";
import { buildForPlatform, rankIssues } from "../../toolchains/index.js";
import { resolveLinkerConfig } from "../../toolchains/cc65/preset-resolver.js";
import { parseBuildLog } from "../../toolchains/parse-errors.js";
import { inesHeaderSource, charsSource, nromFlatCfg } from "../../toolchains/cc65/ines.js";
import { resolveCore } from "../../cores/registry.js";
import { resetHost, getDisclosure } from "../state.js";
import { PLATFORM_VIRTUAL_EXT } from "romdev-core-host/LibretroHost.js";
import { imageContent, jsonContent, safeTool } from "../util.js";
import { isPlaytestRunning } from "./playtest.js";
import { buildSourceWithDebugCore } from "./symbols.js";
import { log as serverLog } from "../log.js";

// crt0 (the per-platform startup stub) is assembled BEHIND the user's build.
// When it fails the agent gets a raw assembler log — route it through the same
// parser build() uses so the error leads with the first file:line: message
// (the issues[]-style surfacing), full log appended for fallback.
function crt0AssemblyError(log) {
  const issues = parseBuildLog(log ?? "");
  const first = issues.find((i) => i.severity === "error") ?? issues[0];
  const headline = first
    ? `${first.file ? first.file + ":" : ""}${first.line ? first.line + ": " : ""}${first.message}`
    : "no structured diagnostic found";
  return new Error(
    `crt0 (startup stub) assembly failed: ${headline}` +
    (issues.length > 1 ? ` (+${issues.length - 1} more)` : "") +
    `\nThis is the bundled startup code, not your source — if it's the only error, ` +
    `report it. Full assembler log:\n${log ?? ""}`,
  );
}

// Record a build outcome into the /log ring buffer so a failed build's stage +
// error tail are diagnosable later (the request was already traced; this adds
// the RESULT). On failure we keep a chunk of the build log; on success just the
// shape. Always recorded; only printed to stdout in verbose mode.
function logBuildResult(verb, platform, result) {
  if (result?.ok) {
    serverLog.debug(`[build] ${verb} ${platform} OK ${result.binary ? result.binary.length + "B" : ""}`.trim());
  } else {
    const errTail = (result?.log || result?.err || "").slice(-1500);
    serverLog.debug(`[build] ${verb} ${platform} FAILED stage=${result?.stage ?? "?"}${errTail ? "\n" + errTail : ""}`);
  }
}

/**
 * Apply the `inesHeader` NES NROM-rebuild convenience: synthesize the iNES HEADER
 * segment (+ CHARS segment that .incbins the CHR blob when chrBanks>0) into the
 * sources map and set a flat NROM linker .cfg. The agent supplies only the PRG
 * disassembly + the CHR blob — no glue .s/.cfg, no hand-derived header bytes.
 * Shared by build({output:'rom'|'run'}). See toolchains/cc65/ines.js.
 *
 * @param {{platform:string, inesHeader:any, sources:Record<string,string>|null|undefined, source:string|null|undefined, linkerConfig:string|undefined, mergedBinaryIncludes:Record<string,string>}} a
 * @returns {{sources:Record<string,string>, source:null, linkerConfig:string}}
 */
function applyInesHeader({ platform, inesHeader, sources, source, linkerConfig, mergedBinaryIncludes }) {
  if (platform !== "nes") {
    throw new Error(`inesHeader is NES-only (iNES is the NES cartridge format); platform was '${platform}'.`);
  }
  if (linkerConfig) {
    throw new Error("Pass either `inesHeader` (auto-generates the NROM .cfg) OR `linkerConfig`, not both.");
  }
  const chr = inesHeader.chrBanks ?? 0;
  // A rebuild is always multi-source (PRG disassembly + synthesized header), so
  // normalize a lone `source` into the sources map.
  const out = sources == null
    ? (source != null ? { "main.s": source } : {})
    : { ...sources };
  if (out["ines_header.s"] == null) out["ines_header.s"] = inesHeaderSource(inesHeader);
  if (chr > 0) {
    const binNames = Object.keys(mergedBinaryIncludes);
    const chrName = inesHeader.chrIncbin ?? (binNames.length === 1 ? binNames[0] : undefined);
    if (!chrName) {
      throw new Error(
        `inesHeader.chrBanks=${chr} needs the CHR-ROM blob: pass it via binaryIncludePaths ` +
        `(e.g. {"chr.bin":"/path/chr.bin"}). With more than one binary include, set inesHeader.chrIncbin to its name.`
      );
    }
    if (mergedBinaryIncludes[chrName] == null) {
      throw new Error(`inesHeader.chrIncbin '${chrName}' is not among the binary includes (${binNames.join(", ") || "none"}).`);
    }
    if (out["ines_chars.s"] == null) out["ines_chars.s"] = charsSource(chrName);
  }
  return { sources: out, source: null, linkerConfig: nromFlatCfg(inesHeader) };
}

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

/**
 * Make a projectName safe to use as a virtual ROM filename (drives the
 * playtest window title). Strip path separators / control chars, collapse
 * whitespace, cap length. Never returns "" — falls back to "game".
 * @param {string} name
 * @returns {string}
 */
function sanitizeProjectName(name) {
  const clean = String(name)
    .replace(/[/\\<>:"|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
  return clean || "game";
}
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build-log gating (mirrors symbols.js logField). A failing/verbose build
// log can be huge and explodes the response. Small logs stay inline; large
// logs are written to a sibling path (when one exists) and only a tail comes
// back; inline:true returns the full log regardless.
const LOG_TAIL = 1200;

// On a SUCCESSFUL build the GCC LTO path (Genesis/GBA m68k/arm) prints
// interprocedural-optimization phase banners and a per-pass timing table that
// carry no diagnostic value — they just crowd the linker-map / objcopy
// confirmation out of the tail. Strip those blocks on success so the signal
// stays visible. Left intact on failure (timing can matter when diagnosing a
// hang/OOM). The full untrimmed log is still written to logPath when spilled.
export function denoiseSuccessLog(log) {
  if (typeof log !== "string") return log ?? "";
  const lines = log.split("\n");
  const kept = [];
  let inTiming = false;
  for (const line of lines) {
    // GCC `-ftime-report` table: starts at a "Time variable" header and runs
    // through the "TOTAL ... GGC" row. Drop the whole block.
    if (/^\s*Time variable\b/.test(line)) { inTiming = true; continue; }
    if (inTiming) {
      if (/^\s*TOTAL\b/.test(line)) inTiming = false;
      continue;
    }
    // LTO interprocedural-optimization phase dump:
    //   "Performing interprocedural optimizations"
    //   " <*free_lang_data> {heap 32M} <visibility> {heap 32M} ..."
    if (/^\s*Performing interprocedural optimizations\s*$/.test(line)) continue;
    if (/^\s*<[\w*][^>]*>\s*\{heap\b/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Fold the build log into a response payload per the gating rule.
 * @param {string|undefined|null} log
 * @param {boolean} inline  caller asked for the full log inline
 * @param {string|null} siblingPath  where to write a large log (e.g. ROM path + ".build.log"); null = nowhere
 * @param {boolean} [ok=false]  whether the build succeeded — denoise LTO/timing on success
 * @returns {object} fields to spread into the response
 */
async function logField(log, inline, siblingPath, ok = false) {
  if (!log) return { log: null };
  // Always write the FULL untrimmed log to disk (it's the forensic record);
  // only the inline/tail view is denoised on success.
  const view = ok ? denoiseSuccessLog(log) : log;
  if (inline || view.length <= LOG_TAIL) return { log: view };
  if (siblingPath) {
    await writeFile(siblingPath, log, "utf8");
    return { logPath: siblingPath, logTail: view.slice(-LOG_TAIL), logBytes: log.length };
  }
  // No place to write — the log is a byproduct, not a primary artifact, so
  // return the tail + size rather than throwing.
  return { logTail: view.slice(-LOG_TAIL), logBytes: log.length };
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

/** platform({op:'toolchains'}) without an id — list bundled toolchains. */
export function listToolchainsCore() {
  return {
    toolchains: Object.values(TOOLCHAINS).map((t) => ({
      id: t.id,
      displayName: t.displayName,
      platforms: t.platforms,
      tier: t.tier,
      installed: t.tier === 1, // Tier-1 is always bundled
    })),
  };
}

/** platform({op:'toolchains', id}) — confirm one toolchain's install status (no-op in v1). */
export function installToolchainCore({ id }) {
  const t = TOOLCHAINS[id];
  if (!t) throw new Error(`unknown toolchain '${id}'. Use platform({op:'toolchains'}) to see available ids.`);
  if (t.tier === 1) return { id, installed: true, note: `toolchain '${id}' is bundled — nothing to install` };
  throw new Error(`toolchain '${id}' is tier-2 and not yet implemented in v1`);
}

export function registerToolchainTools(server, z, sessionKey) {
  async function buildSourceImpl({ platform, language, source, sourcePath, sources, sourcesPaths, includes, binaryIncludes, binaryIncludePaths, includePaths, crt0, crt0Path, codeLoc, dataLoc, options, linkerConfig, linkerConfigPath, inesHeader, outputPath, inline = false, includeSymbols = false, lint = "advisory", runtime, maxmod, rebuildSdk }) {
      // Reject conflicting inline vs path args — fail loud, not silent.
      if (source != null && sourcePath != null) {
        throw new Error("build({output:'rom'}): pass either `source` OR `sourcePath`, not both.");
      }
      if (sources != null && sourcesPaths != null) {
        throw new Error("build({output:'rom'}): pass either `sources` OR `sourcesPaths`, not both.");
      }
      if (crt0 != null && crt0Path != null) {
        throw new Error("build({output:'rom'}): pass either `crt0` OR `crt0Path`, not both.");
      }
      // crt0Path → crt0 source.
      if (crt0Path) {
        crt0 = await readFile(crt0Path, "utf-8");
      }
      // linkerConfigPath: read the .cfg from disk so a large multi-bank
      // config (e.g. a disasm'd mapper-2 rebuild) isn't re-streamed through
      // context on every build (0.27.0 feedback #2).
      if (linkerConfigPath && linkerConfig == null) {
        linkerConfig = await readFile(linkerConfigPath, "utf-8");
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
      // inesHeader — NES NROM rebuild convenience (see applyInesHeader).
      if (inesHeader) {
        ({ sources, source, linkerConfig } = applyInesHeader({
          platform, inesHeader, sources, source, linkerConfig, mergedBinaryIncludes,
        }));
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
      // Assemble caller-supplied crt0 (SDCC platforms ONLY). sm83 → sdasgb,
      // everything else → sdasz80.
      //
      // GATED on the platform actually using SDCC. This used to run for every
      // platform, so a cc65/ca65 crt0 on a 6502 target was fed to sdasz80 and
      // came back as a wall of `?ASxxxx-Error-<o> .org in REL area` -- with a
      // message blaming "the bundled startup code", which sent the agent
      // debugging a file that was never the problem. A 6502 platform should
      // never reach the Z80 assembler.
      let crt0Rel;
      if (crt0) {
        const { SDCC_PORTS, runSdasgb, runSdasz80 } = await import("../../toolchains/sdcc/sdcc.js");
        if (!SDCC_PORTS[platform]) {
          throw new Error(
            `build: crt0/crt0Path is an SDCC-platform option (${Object.keys(SDCC_PORTS).join(", ")}); `
            + `'${platform}' builds with a different toolchain and assembles its startup code as part of the project. `
            + `Put your startup code in the project's own sources instead.`);
        }
        const isSm83 = platform === "gb" || platform === "gbc";
        const asm = isSm83 ? await runSdasgb({ source: crt0 }) : await runSdasz80({ source: crt0 });
        if (!asm.rel) {
          throw crt0AssemblyError(asm.log);
        }
        crt0Rel = asm.rel;
      }
      const result = await buildForPlatform({
        platform,
        language,
        runtime,
        maxmod,
        rebuildSdk,
        source: useSource,
        // Basename of the on-disk source, when given — lets language inference
        // route by extension (main.c → C, main.s → asm) so an omitted
        // `language` doesn't fall to the wrong toolchain (the genesis foot-gun).
        sourceName: sourcePath ? path.basename(sourcePath) : undefined,
        sources: mergedSources,
        includes: Object.keys(mergedIncludes).length ? mergedIncludes : undefined,
        binaryIncludes: Object.keys(mergedBinaryIncludes).length ? mergedBinaryIncludes : undefined,
        options,
        linkerConfig: resolvedLinkerConfig,
        crt0: crt0Rel,
        codeLoc,
        dataLoc,
      });
      logBuildResult("build:rom", platform, result);
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
          await mkdir(path.dirname(outputPath), { recursive: true });
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
            "loadCategory({category:'show'}) then playtest({}). It returns immediately " +
            "and the window follows your rebuilds, so the emulator stays available to " +
            "all other tools (screenshot, readMemory, saveState, pause, stepFrames, ...) " +
            "while the human plays — screenshot() shows the same frame the human sees. " +
            "Recommended early in any session where a user is watching."
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
        ...(result.sdkEditIgnored ? { sdkEditIgnored: result.sdkEditIgnored } : {}),
        ...(await logField(result.log, inline, logSibling, result.ok)),
        issues: rankIssues(result.issues ?? []),
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
  }

  async function runSourceImpl({ platform, language, source, sourcePath, sources, sourcesPaths, includes, binaryIncludes, binaryIncludePaths, includePaths, runtime, maxmod, rebuildSdk, crt0, crt0Path, codeLoc, dataLoc, linkerConfig, linkerConfigPath, inesHeader, options, defines, entry, path: projPath, frames = 60, holdInputs, screenshotPath, projectName }) {
      const { buildForPlatform } = await import("../../toolchains/index.js");
      // Merge `defines` ({_VER:1}) into `options` (--define) just like the project/rom paths,
      // so a project-dir RUN honors them too.
      const mergedOptions = [
        ...(Array.isArray(options) ? options : []),
        ...(defines && typeof defines === "object"
          ? Object.entries(defines).flatMap(([k, v]) => ["--define", `${k}=${v}`])
          : []),
      ];
      const resolved = resolveCore(platform);
      if (!resolved) throw new Error(`no core available for platform '${platform}'`);

      // PROJECT-DIR run: `build({output:'run', path})` with no explicit sources →
      // read the scaffolded dir via the per-platform recipe (same as
      // output:'project'), then run it. This is the documented "iterate on a dir"
      // happy path; without it, output:'run' + path errored ("requires source").
      const noExplicitSources = source == null && sourcePath == null && sources == null && sourcesPaths == null;
      if (projPath && noExplicitSources) {
        const r = await readProjectDir(projPath, platform, { entry });
        includes = { ...(includes ?? {}), ...r.includes };
        binaryIncludes = { ...(binaryIncludes ?? {}), ...r.binaryIncludes };
        if (r.crt0 != null) crt0 = r.crt0;
        if (r.codeLoc != null) codeLoc = r.codeLoc;
        if (r.dataLoc != null && dataLoc == null) dataLoc = r.dataLoc;
        if (r.linkerConfig != null && linkerConfig == null) linkerConfig = r.linkerConfig;
        if (r.runtime != null && runtime == null) runtime = r.runtime;
        if (r.maxmod != null && maxmod == null) maxmod = r.maxmod;
        // Single-source toolchains (dasm/atari2600, vasm/asm) need `source`, not
        // a `sources` map. Collapse a lone source so those targets build via the
        // dir path too. (resolveLinkerConfig support-sources, if any, force the
        // map form below.)
        const srcNames = Object.keys(r.sources);
        if (srcNames.length === 1 && r.crt0 == null && r.linkerConfig == null) {
          // Leave `source` null and set sourcePath — runSourceImpl reads it +
          // derives sourceName (extension) for language inference. Single-source
          // targets (dasm/vasm) require this form, not a `sources` map.
          sourcePath = path.join(projPath, srcNames[0]);
        } else {
          sources = r.sources;
        }
      }

      if (source != null && sourcePath != null) {
        throw new Error("build({output:'run'}): pass either `source` OR `sourcePath`, not both.");
      }
      if (sources != null && sourcesPaths != null) {
        throw new Error("build({output:'run'}): pass either `sources` OR `sourcesPaths`, not both.");
      }
      if (crt0 != null && crt0Path != null) {
        throw new Error("build({output:'run'}): pass either `crt0` OR `crt0Path`, not both.");
      }
      if (crt0Path) {
        crt0 = await readFile(crt0Path, "utf-8");
      }
      if (linkerConfigPath && linkerConfig == null) {
        linkerConfig = await readFile(linkerConfigPath, "utf-8");
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
      // inesHeader — NES NROM rebuild convenience (see applyInesHeader).
      if (inesHeader) {
        ({ sources, source, linkerConfig } = applyInesHeader({
          platform, inesHeader, sources, source, linkerConfig, mergedBinaryIncludes,
        }));
      }
      const { cfg: resolvedLinkerConfig2, supportSources: supportSources2 } = await resolveLinkerConfig(platform, linkerConfig);
      const mergedSources2 = sources
        ? { ...supportSources2, ...sources }
        : Object.keys(supportSources2).length
          ? { ...supportSources2, ...(source ? { "main.c": source } : {}) }
          : undefined;
      const useSource2 = mergedSources2 ? undefined : source;
      // Assemble caller-supplied crt0 (SDCC platforms ONLY) -- same gate as
      // buildSource above; see the comment there for why an ungated version
      // sent 6502 crt0 files into sdasz80.
      let crt0Rel2;
      if (crt0) {
        const { SDCC_PORTS, runSdasgb, runSdasz80 } = await import("../../toolchains/sdcc/sdcc.js");
        if (!SDCC_PORTS[platform]) {
          throw new Error(
            `build: crt0/crt0Path is an SDCC-platform option (${Object.keys(SDCC_PORTS).join(", ")}); `
            + `'${platform}' builds with a different toolchain and assembles its startup code as part of the project. `
            + `Put your startup code in the project's own sources instead.`);
        }
        const isSm83 = platform === "gb" || platform === "gbc";
        const asm = isSm83 ? await runSdasgb({ source: crt0 }) : await runSdasz80({ source: crt0 });
        if (!asm.rel) {
          throw crt0AssemblyError(asm.log);
        }
        crt0Rel2 = asm.rel;
      }
      const build = await buildForPlatform({
        platform,
        language,
        runtime,
        maxmod,
        rebuildSdk,
        source: useSource2,
        sourceName: sourcePath ? path.basename(sourcePath) : undefined,
        sources: mergedSources2,
        includes: Object.keys(mergedIncludes).length ? mergedIncludes : undefined,
        binaryIncludes: Object.keys(mergedBinaryIncludes).length ? mergedBinaryIncludes : undefined,
        linkerConfig: resolvedLinkerConfig2,
        crt0: crt0Rel2,
        codeLoc,
        dataLoc,
        options: mergedOptions.length ? mergedOptions : undefined,
      });
      logBuildResult("build:run", platform, build);
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
          issues: rankIssues(build.issues ?? []),
        });
      }

      const host = resetHost(sessionKey);
      await host.loadCore(resolved.jsPath, resolved.wasmPath, { hwRender: resolved.hwRender });
      // Pass projectName as a virtualName so the playtest window titles itself
      // with the game name (the SDL window reads host.status.mediaPath). Keep
      // a platform-correct extension so shared cores still resolve the system.
      const virtualName = projectName
        ? sanitizeProjectName(projectName) + (PLATFORM_VIRTUAL_EXT[platform] ?? "")
        : undefined;
      await host.loadMedia({ platform, bytes: build.binary, virtualName });
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
      if (!isPlaytestRunning(sessionKey) && !playtestHintGiven.has(sessionKey)) {
        playtestHintGiven.add(sessionKey);
        hint = "No playtest window is open. If a human is watching, consider " +
               "`playtest({op:\"open\"})` so they can play this ROM live while you " +
               "keep iterating with build({output:\"run\"}) (rebuilds update the " +
               "live game in place). Skip if this session is headless " +
               "(CI / batch / automated).";
      }

      const summary = {
        ok: true,
        platform,
        core: resolved.coreName,
        toolchain: build.toolchain,
        binaryBytes: build.binary.length,
        romLayout: describeRomLayout(platform, build.binary),
        ...(build.ramUsage ? { ramUsage: build.ramUsage } : {}),
        ...(build.sdkEditIgnored ? { sdkEditIgnored: build.sdkEditIgnored } : {}),
        framesRun: frames,
        framebuffer: { width: shot.width, height: shot.height },
        // Surface lint/build issues even on successful runs so agents see
        // linter warnings BEFORE the next iteration (was: runSource silently
        // ran with warnings, agent missed them, hit the crash 100 functions later).
        ...((build.issues ?? []).length > 0 ? { issues: rankIssues(build.issues) } : {}),
        ...(hint ? { hint } : {}),
      };

      // Default: screenshot comes back inline (runSource is the "show me the
      // result" loop). If screenshotPath is set, write it there instead —
      // for clients that can't display inline images.
      if (screenshotPath) {
        // Create the parent dir if missing so a path like ".../shots/title.png"
        // doesn't ENOENT when the agent hasn't pre-made the folder.
        await mkdir(path.dirname(screenshotPath), { recursive: true });
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
  }

  // build({output:'project'}) — build a project DIRECTORY (no per-call manifest).
  // Discovers main.c (C/SGDK/GBA/cc65 C) or main.s/main.asm (asm) and links
  // every source in the dir. Delegates to the module-scope buildProjectCore.
  const buildProjectImpl = (args) => buildProjectCore(args);

  // ── the `build` router ──────────────────────────────────────────────────
  const sourcesShape = z.record(z.string(), z.string());
  const holdInputShape = z.object({
    up: z.boolean().optional(), down: z.boolean().optional(),
    left: z.boolean().optional(), right: z.boolean().optional(),
    a: z.boolean().optional(), b: z.boolean().optional(),
    x: z.boolean().optional(), y: z.boolean().optional(),
    l: z.boolean().optional(), r: z.boolean().optional(),
    l2: z.boolean().optional(), r2: z.boolean().optional(),
    l3: z.boolean().optional(), r3: z.boolean().optional(),
    start: z.boolean().optional(), select: z.boolean().optional(),
  });

  server.tool(
    "build",
    "Compile/assemble source for a target platform; one tool keyed by `output`.\n" +
    "ON FAILURE (ok:false): READ `issues[]` FIRST — it's the structured error list ({file,line,col,severity,message,stage}) and usually names the exact line to fix. Only fall back to the raw `log` if `issues[]` is empty. Don't guess or rebuild blindly before reading it.\n" +
    "• output:'rom' (default) — assemble or compile `source` (single) / `sources` ({name:contents}) / `sourcePath` / `sourcesPaths`. Returns the ROM (path by default; `inline:true` for binaryBase64) + build log. **`binaryIncludes`/`binaryIncludePaths` (base64/path CHR-ROM, music blobs for `.incbin`) — WITHOUT them no game with external assets builds.** `includes`/`includePaths` for `.include`d text. `linkerConfig` (cc65; NES preset 'chr-ram-runtime' RECOMMENDED). `crt0`/`crt0Path`/`codeLoc`/`dataLoc` (SDCC). `runtime`/`maxmod`/`rebuildSdk` (GBA/Genesis SDK). **`lint:'strict'` fails the build (stage:'lint', no binary) if the pre-flight SDCC crash-pattern scan flags anything (e.g. the uint8 loop-bound trap); 'advisory' (default) just lists hits in issues[].** **`includeSymbols:true` returns the .map text inline on a PLAIN rom build — distinct from output:'romWithDebug' which writes .dbg/.map FILES.** Language is inferred from extension/content — usually OMIT `language`.\n" +
    "• output:'romWithDebug' — like 'rom' but also emits linker debug info for the `symbols` tool: cc65 → `.dbg`, SDCC → sdld `.map`, Genesis m68k → GNU ld map (find where a RAM var landed). DEFAULT writes ROM + debug file + log to disk (`outputPath` required unless `inline:true`). **`resolveSymbols:['grid','score']` folds those names' addresses ({resolvedSymbols:{grid:{address,hex,region?,ramOffset?}}}) straight into the result — the cheap way to a WRAM variable's address without loading the whole map (or round-tripping it through `symbols`).**\n" +
    "• output:'run' — BUILD + LOAD + RUN + SCREENSHOT in one round trip — the fastest iteration loop. Same build args; runs `frames` frames and returns the screenshot INLINE. `holdInputs` holds controller state; `screenshotPath` writes the PNG to disk instead; `projectName` titles the playtest window.\n" +
    "• output:'project' — build a project DIRECTORY (`path`) without re-passing the file manifest each call. Entry point auto-detects `main.c` (C/SGDK Genesis, GBA, cc65/SDCC C) OR `main.s`/`main.asm` (asm); pass `entry:'smw.asm'` to point at a differently-named top-level file (e.g. an existing disassembly). Every `.c`/`.s`/`.asm` in the dir is a translation unit (linked together), every `.h`/`.inc` an include, and `.bin/.chr/.pcm/.brr/.vgm/...` (recursively, including subdirectories) become binaryIncludes (for `.incbin`). `options` (e.g. asar `--define _VER=1`) and `defines` are honored here too. Iterate an on-disk project by re-calling with just `{path, platform}`. **This is the no-boilerplate path for an examples({op:'fork'}) dir: the per-platform recipe auto-supplies the crt0 + load address — GB/GBC default `gb_crt0.s` + `codeLoc:0x150` (don't hand-pass them!), MSX routes `msx_crt0.s` + `codeLoc:0x4010`, SMS/GG auto-inject their bundled crt0, NES applies the chr-ram-runtime preset. PREFER this over re-passing `crt0Path`/`codeLoc` to output:'rom' for a forked project.**\n" +
    "• output:'reassemble' — **the UNIFORM byte-exact ROUND-TRIP**: rebuild a `disasm({target:'project'})` output dir (`path`) into a byte-identical ROM in ONE call, on EVERY classic platform (NES/SNES/Genesis/GB/GBC/SMS/GG/MSX/GBA/C64/Atari/PCE/Lynx) — not just the cc65-native subset that `rebuild.json` covers. It reads the `reassemble.json` manifest disasm wrote, ASSEMBLES each region `.asm` with the platform's native assembler (ca65 for 6502/65816, GNU-as for m68k/arm/z80/sm83), and SPLICES each result into a copy of the original ROM (`original.rom`, kept in the dir) at its file offset — so the cartridge header, inter-region gaps, and trailing pad return verbatim. Returns `{ok, byteExact, outputPath, regions:[{file,byteExact,...}]}` (a failed region carries structured `issues[]` — {file,line,message} pointing at the REGION'S source file, ANSI-free); writes the ROM to `outputPath` (or `<dir>/rebuilt.<ext>` by default). **This is the 'cmp before commit' gate for a ROM-hacking / annotation workflow: edit a region `.asm`, call this, get a byte-identical ROM back (or a precise per-region mismatch if your edit changed a region's length).** `byteExact:true` = the rebuild equals `original.rom` exactly.",
    {
      output: z.enum(["rom", "romWithDebug", "run", "project", "reassemble"])
        .describe("rom=produce a ROM (default); romWithDebug=ROM + .dbg/.map debug files; run=build+load+run+screenshot; project=build a project directory; reassemble=rebuild a disasm({target:'project'}) dir into a byte-identical ROM (uniform across ALL platforms)."),
      platform: z.string().describe("Target platform id (e.g. 'nes', 'genesis')."),
      language: z.string().optional().describe("Language override ('c'/'asm'/'basic'). USUALLY OMIT — inferred from source extension/content; only the ambiguous case falls to the platform default. Ignored by output:'romWithDebug' (C only)."),
      // source inputs (rom/romWithDebug/run)
      source: z.string().optional().describe("Single source file contents. PREFER `sourcePath` for on-disk files."),
      sourcePath: z.string().optional().describe("Absolute path to a single source file (server reads it). Mutually exclusive with `source`. NOT read by output:'romWithDebug' — use `source` there."),
      sources: sourcesShape.optional().describe("Multi-file project: filename → contents ({'main.s':'...', 'aliens.s':'...'})."),
      sourcesPaths: sourcesShape.optional().describe("Path-based `sources`: virtual filename → absolute path. Mutually exclusive with `sources`. NOT read by output:'romWithDebug'."),
      includes: sourcesShape.optional().describe("Virtual filename → contents for `.include`d files (NOT separate translation units)."),
      includePaths: sourcesShape.optional().describe("Path-based `includes` (text files; server reads them). NOT read by output:'romWithDebug'."),
      binaryIncludes: sourcesShape.optional().describe("Like `includes` but BINARY blobs (CHR ROM, music) as base64, for `.incbin`. PREFER `binaryIncludePaths`. NOT read by output:'romWithDebug'."),
      binaryIncludePaths: sourcesShape.optional().describe("Path-based `binaryIncludes`: virtual filename → absolute path (server reads the bytes). NOT read by output:'romWithDebug'."),
      crt0: z.string().optional().describe("SDCC platforms — custom crt0.s source (assembled via sdasgb/sdasz80, linked instead of the stock crt0). SMS/GG auto-inject the bundled crt0 when omitted; GB/GBC pass gb_crt0 + codeLoc:0x150. (romWithDebug reads `crt0` but NOT `crt0Path`.)"),
      crt0Path: z.string().optional().describe("Path-based `crt0`. NOT read by output:'romWithDebug' — pass `crt0` there."),
      codeLoc: z.coerce.number().int().optional().describe("SDCC — _CODE load address (default $0000; GB/GBC bundled crt0 wants 0x150)."),
      dataLoc: z.coerce.number().int().optional().describe("SDCC — _DATA (WRAM) load address (default $C000 on Z80). NOT read by output:'romWithDebug'."),
      options: z.array(z.string()).optional().describe("Extra toolchain CLI options. Honored by output:'rom' AND output:'project' (e.g. asar `--define _VER=1`, `--fix-checksum=off`, `-wno…`)."),
      defines: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("Assembler defines as a map ({_VER:1}) — convenience for asar's `--define NAME=VALUE`. Merged into `options` for output:'rom'/'project'. (Equivalent to passing `--define _VER=1` yourself.)"),
      linkerConfig: z.string().optional().describe("ld65 linker config (cc65). NES presets: 'chr-ram-runtime' (RECOMMENDED for homebrew C — full crt0 + iNES header + NMI w/ OAM DMA + `_shadow_oam` at $0200), 'chr-ram' (bare nmi:rti stub), 'chr-rom' (cc65-C with FIXED CHR-ROM art — segment split + CHARS segment; supply CHR via binaryIncludePaths into a CHARS source + the header via `inesHeader`). Or full .cfg contents. Preset NAMES only resolve on output:'rom'/'run'; output:'romWithDebug' takes raw .cfg contents only. **For rebuilding a commercial NROM game from its disassembly, prefer `inesHeader` over a raw .cfg.**"),
      linkerConfigPath: z.string().optional().describe("Path-based `linkerConfig`: absolute path to a .cfg file on disk (the server reads it — the cfg never enters your context; e.g. the multi-bank cfg a banked-NES disasm project ships). Ignored when `linkerConfig` is passed inline."),
      inesHeader: z.object({
        prgBanks: z.coerce.number().int().min(1).max(255).describe("16KB PRG-ROM banks (1 = NROM-128, 2 = NROM-256)."),
        chrBanks: z.coerce.number().int().min(0).max(255).optional().describe("8KB CHR-ROM banks (0 = CHR-RAM, no CHARS segment). Default 0."),
        mapper: z.coerce.number().int().min(0).max(255).optional().describe("iNES mapper number. Default 0 (NROM)."),
        mirroring: z.enum(["horizontal", "vertical"]).optional().describe("Nametable mirroring. Default 'horizontal'."),
        battery: z.boolean().optional().describe("PRG-RAM battery (flags6 bit 1). Default false."),
        chrIncbin: z.string().optional().describe("Name of the binaryInclude holding the CHR-ROM blob to .incbin (only needed when chrBanks>0 AND there's more than one binary include; else the sole include is used)."),
      }).optional().describe("NES iNES-header + NROM-rebuild convenience. Auto-emits the 16-byte iNES HEADER segment + (for chrBanks>0) a CHARS segment that .incbins the CHR blob (from binaryIncludePaths), and sets a flat NROM linker .cfg (HEADER+PRG+CHARS). The agent supplies ONLY the PRG disassembly source(s) + the CHR blob — no glue .s/.cfg files, no hand-derived header bytes. THE shape for rebuilding an NROM commercial game from `disasm({target:'project'})`. Mutually exclusive with `linkerConfig`."),
      runtime: z.string().optional().describe("GBA — runtime: 'libtonc' (default), 'libgba', or 'none'."),
      maxmod: z.boolean().optional().describe("GBA — link maxmod for music (libmm.a). You still call mmInit/mmStart + hook mmVBlank."),
      rebuildSdk: z.boolean().optional().describe("GBA + Genesis — rebuild the bundled SDK (libtonc/libgba/maxmod/SGDK) from vendored source instead of the prebuilt seed (~20-40s). Only if you edited SDK source (else an `sdkEditIgnored` warning fires)."),
      lint: z.enum(["advisory", "strict"]).default("advisory").describe("output:'rom' SDCC — 'advisory' (default, warnings in issues[]) or 'strict' (any lint warning fails the build with stage:'lint' before the compiler runs — the SDCC crash-pattern guard)."),
      includeSymbols: z.boolean().default(false).describe("output:'rom' — return the toolchain's symbol/map text inline (sdld .map / cc65 .sym). False = only symbolsBytes (call symbols/addressToSymbol to look up a PC). Maps can be 30+ KB."),
      resolveSymbols: z.array(z.string()).optional().describe("output:'romWithDebug' — resolve just these symbol NAMES (e.g. ['grid','score']) off the freshly-produced .dbg/.map and fold {resolvedSymbols:{grid:{address,hex,region?,ramOffset?}}} into the result. The CHEAP path to a WRAM variable's address: you get the addresses you asked for WITHOUT the 30-60KB map entering your context. Genesis work-RAM symbols come back with `ramOffset` for memory({region:'system_ram', offset}). Names that don't resolve are listed in `unresolvedSymbols`."),
      // run-only
      frames: z.number().int().min(1).max(100000).default(60).describe("output:'run' — frames to run before the screenshot (default 60)."),
      holdInputs: z.array(holdInputShape).max(2).optional().describe("output:'run' — per-port input state to hold during the run (index 0 = port 0)."),
      screenshotPath: z.string().optional().describe("output:'run' — write the screenshot here and return {screenshotPath} instead of the inline image (for clients that can't show inline images)."),
      projectName: z.string().optional().describe("output:'run' — playtest window title (no effect on the ROM)."),
      // project-only
      path: z.string().optional().describe("output:'project' — absolute path to the project directory."),
      entry: z.string().optional().describe("output:'project' — name of the top-level source file when it isn't main.c/main.s/main.asm (e.g. 'smw.asm' for an existing disassembly). Project-relative or a bare filename. Default: auto-detect main.c / main.s / main.asm."),
      // shared output
      outputPath: z.string().optional().describe("output:'rom'/'romWithDebug'/'project' — absolute path to write the ROM (romWithDebug writes .dbg/.map/.log alongside; REQUIRED for romWithDebug unless inline:true). output:'rom' omitted → temp-file path returned (or inline:true for base64)."),
      inline: z.boolean().default(false).describe("output:'rom'/'romWithDebug' — return binaryBase64 (+ debug text for romWithDebug) in the response instead of writing to disk."),
    },
    safeTool(async (args) => {
      switch (args.output) {
        case "rom": {
          // `build({output:'rom', path})` (a project dir, no explicit sources) is
          // the natural "build my scaffolded dir to a ROM file" call. Route it to
          // the dir builder (same recipe as output:'project'/'run') — otherwise it
          // fell into buildSourceImpl with no source and crashed on an undefined
          // log. With path AND explicit sources, the sources win (manual build).
          if (args.path && args.source == null && args.sources == null &&
              args.sourcePath == null && args.sourcesPaths == null) {
            return await buildProjectImpl(args);
          }
          return await buildSourceImpl(args);
        }
        case "run":          return await runSourceImpl(args);
        case "project": {
          if (!args.path) throw new Error("build({output:'project'}): `path` (the project directory) is required.");
          return await buildProjectImpl(args);
        }
        case "reassemble": {
          if (!args.path) throw new Error("build({output:'reassemble'}): `path` (the disasm project directory) is required.");
          return await reassembleProjectCore(args);
        }
        case "romWithDebug": return await buildSourceWithDebugCore(args);
        default: throw new Error(`build: unknown output '${args.output}'`);
      }
    }),
  );
}

/**
 * build({output:'project'}) — build a project DIRECTORY (no per-call manifest).
 * Module-scope + exported so it's unit-testable. Discovers main.c (C/SGDK/GBA/
 * cc65 C) or main.s/main.asm (asm) and links every source in the dir. Returns
 * a jsonContent payload (the router calls it via safeTool, which turns a throw —
 * e.g. no entry point — into an {isError:true} result).
 */
/**
 * Per-platform recipe for building a SCAFFOLDED project directory. Given the
 * platform + the list of filenames present, decide which file (if any) is a crt0
 * that must be routed via `crt0`/`codeLoc` (not linked as a plain TU), which
 * linker preset to apply, which SDK runtime to select, and which files to SKIP
 * (preset-supplied crt0s, SDK intermediates). This is the single source of truth
 * that makes `build({output:'project'|'run', path})` match what the scaffold
 * README's hand-written build call does.
 * @param {string} platform
 * @param {string[]} names  filenames present in the project dir
 */
export function projectBuildRecipe(platform, names) {
  const has = (n) => names.includes(n);
  /** @type {{crt0File:string|null, codeLoc:number|undefined, dataLoc:number|undefined, linkerConfig:string|undefined, runtime:string|undefined, maxmod:boolean|undefined, skip:Set<string>, includeAsC:Set<string>}} */
  const r = { crt0File: null, codeLoc: undefined, dataLoc: undefined, linkerConfig: undefined, runtime: undefined, maxmod: undefined, skip: new Set(), includeAsC: new Set() };

  // Reference/upstream sources ship for grepping, not compiling (e.g. GB
  // music_demo's hUGEDriver.upstream.asm — the .c port is what builds). Skip
  // any *.upstream.* on every platform.
  for (const n of names) if (/\.upstream\./i.test(n)) r.skip.add(n);

  if (platform === "gb" || platform === "gbc") {
    // GB/GBC ship gb_crt0.s — it MUST go via crt0+codeLoc:0x150, never as a
    // source (SDCC emits its own gsinit → "Multiple definition of gsinit").
    // dataLoc 0xC200: statics start ABOVE shadow_oam ($C100-$C19F, fixed by
    // the runtime). The sdld default of $C000 let any project with >256 bytes
    // of statics silently overlap the OAM shadow — oam_clear() then zeroed
    // game state (grid/RNG seed). 512 bytes of 8KB WRAM is cheap insurance.
    if (has("gb_crt0.s")) { r.crt0File = "gb_crt0.s"; r.codeLoc = 0x150; r.dataLoc = 0xC200; }
  } else if (platform === "nes") {
    // A SCAFFOLDED NES project needs the chr-ram-runtime preset (it defines the
    // OAM/CHARS segments + a NMI with OAM-DMA; without it: "Missing memory area
    // 'OAM'"). The preset SUPPLIES its own crt0, so skip any the project ships.
    // A BARE hand-rolled NES dir is left alone — forcing the preset there would
    // demand runtime symbols it doesn't have.
    //
    // "Scaffolded" means a crt0/.cfg OR nes_runtime.c. The nes_runtime.c case
    // is the one that matters and used to be missed: that file references
    // _shadow_oam, which ONLY the preset's crt0 exports, so a project shipping
    // it without its own crt0 -- exactly what examples/nes/space-shooter is --
    // failed to link with "Unresolved external '_shadow_oam'" while the
    // equivalent `sources:{...}` call with linkerConfig:'chr-ram-runtime'
    // built fine. Detecting on the crt0 alone asked the wrong question: what
    // decides this is whether the project uses the runtime, not whether it
    // brought its own startup code.
    const looksScaffolded = names.some((n) =>
      /crt0.*\.s$/i.test(n) || /\.cfg$/i.test(n) || /^nes_runtime\.c$/i.test(n));
    if (looksScaffolded) {
      r.linkerConfig = "chr-ram-runtime";
      for (const n of names) {
        if (/crt0.*\.s$/i.test(n) || /\.cfg$/i.test(n)) r.skip.add(n);
      }
    }
  } else if (platform === "msx") {
    // MSX ships msx_crt0.s — it MUST be passed AS the crt0 (replacing the stock
    // SDCC z80 crt0.rel), NOT compiled as a plain source. The stock crt0 is a
    // CP/M-style $0000 runtime with no MSX cartridge header; if it links, IT
    // provides the $4010 entry (an SDCC gsinit stub = `nop nop nop ret`) and our
    // msx_crt0.s _HEADER ("AB" + INIT pointer) gets dropped. The toolchain then
    // synthesizes a header pointing INIT at $4010 = that stub, so the BIOS CALLs
    // a no-op that returns immediately → "No cartridge found" (proven: real
    // commercial ROMs boot in the same host; only our scaffolds failed). Routing
    // msx_crt0.s through crt0 makes ITS header + init the cartridge entry.
    if (has("msx_crt0.s")) { r.crt0File = "msx_crt0.s"; r.codeLoc = 0x4010; }
  } else if (platform === "pce") {
    // PCE example projects (they ship pce_hw.h) build on the 'rom32k' preset:
    // a 32KB HuCard with bank 0 (STARTUP/VECTORS) FIRST in the file at $E000
    // and banks 1-3 (CODE/RODATA) at $8000-$DFFF, where cc65's pce crt0 TAMs
    // them before main(). cc65's stock pce.cfg is an 8KB boot bank — too small
    // for a complete example game — and its documented 32K variant places the
    // vectors in the LAST file bank, which a HuCard never maps at reset
    // (verified black screen on geargrafx). An 8KB-sized program still links
    // and boots identically under this preset, so it's safe for every
    // pce_hw.h-style project. Bare hand-rolled dirs are left alone.
    if (has("pce_hw.h")) r.linkerConfig = "rom32k";
  } else if (platform === "sms" || platform === "gg") {
    // SMS/GG: route the project's *_crt0.s through the crt0 channel (like
    // GB/MSX), NOT as a plain source TU. The OLD recipe skipped it on the
    // belief that "buildForPlatform auto-injects the bundled crt0" — IT DOES
    // NOT (only the output:'rom'/'run' MCP handlers auto-inject). So every
    // output:'project' SMS/GG build linked SDCC's STOCK z80 crt0, whose boot
    // is `ld a,#2 / rst $08 / halt` — main() never ran and every scaffold
    // booted to a BLACK SCREEN (the RetroDECK "all broken" report; our
    // output:'run' verifications were false-green via the other path).
    // readProjectDir falls back to the bundled crt0 when the dir has none.
    const crt0Name = names.find((n) => /_crt0\.s$/i.test(n));
    if (crt0Name) r.crt0File = crt0Name;
  } else if (platform === "genesis" || platform === "megadrive" || platform === "md") {
    // SGDK supplies sega startup + rom header. The scaffold dir may contain
    // generated intermediates (sega.s, sega.preprocessed.s, rom_header.*, and an
    // out/ build dir) that must NOT be recompiled — sega.preprocessed.s refs a
    // missing out/rom_header.bin and aborts the build.
    for (const n of names) {
      if (/^sega(\.preprocessed)?\.s$/i.test(n) || /^rom_header\./i.test(n) || /\.preprocessed\.s$/i.test(n)) r.skip.add(n);
    }
  } else if (platform === "snes") {
    const asmEntry = has("main.asm") && !has("main.c"); // asar asm template
    if (asmEntry) {
      // SNES asar asm template: main.asm `.include`s its siblings
      // (lorom_header/reset_init/cgram_upload.asm). asar takes ONE source +
      // resolves .include from the includes mount — so route non-main .asm as
      // includes, leaving main.asm the single source.
      for (const n of names) {
        if (/\.asm$/i.test(n) && n !== "main.asm") r.includeAsC.add(n);
      }
    } else {
      // SNES (PVSnesLib/tcc) C scaffolds combine C via `#include "snes_sfx.c"`
      // from main.c — a single TU. A non-main .c is an INCLUDE (tcc must find it
      // for the #include), NOT a separate source TU (which would double-define).
      // (data.asm / snes_sfx_data.asm stay real wla sources, compiled + linked.)
      for (const n of names) {
        if (/\.c$/i.test(n) && n !== "main.c") r.includeAsC.add(n);
      }
    }
    // The SPC700 audio driver sources (spc_driver.asm, apu_blob.asm) are 65816-
    // INCOMPATIBLE SPC700 asm used OFFLINE to regenerate apu_blob.bin — the
    // scaffold already ships the built .bin (incbin'd by snes_sfx_data.asm).
    // Compiling them as 65816 sources fails ("Cannot process spc700"). Skip them.
    for (const n of names) {
      if (n === "spc_driver.asm" || n === "apu_blob.asm") r.skip.add(n);
    }
  } else if (platform === "gba") {
    // GBA: default runtime is libtonc; a soundbank.bin means the maxmod path.
    // The libgba-vs-libtonc choice needs the source CONTENT (which header it
    // includes), so buildProjectCore refines r.runtime after reading main.c.
    r.runtime = "libtonc";
    if (has("soundbank.bin")) r.maxmod = true;
  }
  return r;
}

/**
 * Recursively collect files in SUBDIRECTORIES of a project (top-level files are
 * handled by the recipe). Returns {rel, abs} with `rel` POSIX-relative to root
 * (e.g. "col/misc/x.pal"), so the asar/incbin mount resolves the same path the
 * source references. Skips dot-dirs and common build/VCS dirs to avoid hauling
 * in junk. Caps total files to keep a pathological tree from blowing up.
 * @param {string} root
 * @returns {Promise<Array<{rel:string, abs:string}>>}
 */
async function walkSubdirAssets(root) {
  /** @type {Array<{rel:string, abs:string}>} */
  const out = [];
  const SKIP_DIR = new Set([".git", ".svn", "node_modules", "out", "build", "obj", ".vscode"]);
  const MAX = 5000;
  async function walk(dir, rel) {
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (out.length >= MAX) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIR.has(e.name)) continue;
        await walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        out.push({ rel: childRel, abs: path.join(dir, e.name) });
      }
    }
  }
  // Only descend into subdirectories (top-level handled by the flat loop/recipe).
  let top;
  try { top = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of top) {
    if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIR.has(e.name)) {
      await walk(path.join(root, e.name), e.name);
    }
  }
  return out;
}

/**
 * Read a scaffolded project DIRECTORY into the build inputs, applying the
 * per-platform recipe (crt0 routing, linker preset, runtime, skip-list) and
 * the GBA runtime content-sniff. The SINGLE source of truth shared by
 * build({output:'project'}) and build({output:'run', path}) — so the two paths
 * can never drift. Returns crt0 as RAW source text (callers assemble it).
 * @param {string} projPath
 * @param {string} platform
 * @param {{entry?: string}} [opts]  entry: name of the top-level source when it isn't main.*
 */
export async function readProjectDir(projPath, platform, opts = {}) {
  const entries = await readdir(projPath, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile());

  // Subdirectory assets — a real disassembly keeps palettes/gfx in nested dirs
  // (e.g. col/misc/back_area.pal) and `.incbin`s them by relative path. The old
  // flat readdir never saw them → "file not found". Walk recursively and add any
  // binary asset (regardless of extension/double-extension) keyed by its path
  // RELATIVE to the project root, so the asar/incbin mount resolves it.
  const subAssets = await walkSubdirAssets(projPath);

  // Entry override: an existing project whose top file isn't main.* (e.g.
  // smw.asm) OR is nested (e.g. src/main.c — common for decomps/SDK projects).
  // Accept a project-relative path or a bare name; it becomes the single entry
  // source. Resolve against BOTH the top-level files AND the recursively staged
  // subdir set, with POSIX slashes (`path.normalize` may emit `\` on Windows).
  const entryName = opts.entry
    ? path.normalize(opts.entry).replace(/\\/g, "/").replace(/^[./]+/, "")
    : null;
  // The resolved {rel, abs} for the entry when it's nested in a subdirectory.
  let entrySubAsset = null;
  if (entryName) {
    const topMatch = files.some((f) => f.name === entryName);
    entrySubAsset = subAssets.find((a) => a.rel === entryName) || null;
    // Bare-filename fallback: `entry:'main.c'` matches `src/main.c` if unique.
    if (!topMatch && !entrySubAsset && !entryName.includes("/")) {
      const byBase = subAssets.filter((a) => a.rel.split("/").pop() === entryName);
      if (byBase.length === 1) entrySubAsset = byBase[0];
    }
    if (!topMatch && !entrySubAsset) {
      const nearby = subAssets
        .filter((a) => a.rel.split("/").pop() === entryName.split("/").pop())
        .map((a) => a.rel).slice(0, 8);
      throw new Error(
        `entry '${entryName}' not found in ${projPath}. ` +
        (nearby.length
          ? `Did you mean: ${nearby.join(", ")}? (entry is project-relative — e.g. 'src/main.c'.)`
          : `Top-level: ${files.map((f) => f.name).join(", ") || "(none)"}. ` +
            `entry is project-relative — pass the path under the repo root (e.g. 'src/main.c').`)
      );
    }
  }

  const hasC = files.some((f) => f.name === "main.c");
  const hasAsm = files.some((f) => f.name === "main.s" || f.name === "main.asm");
  if (!entryName && !hasC && !hasAsm) {
    throw new Error(
      `no entry point in ${projPath}: expected main.c (C/SGDK/GBA/cc65 project) or main.s / main.asm (asm project), ` +
      `or pass entry:'<top-file>'. Found: ${files.map((f) => f.name).join(", ") || "(empty)"}.`
    );
  }

  // Per-platform PROJECT RECIPE — see projectBuildRecipe. Globbing every file as
  // a source is what broke GB (gsinit double-def), NES (no OAM/CHARS), Genesis
  // (sega.preprocessed.s). The recipe routes crt0 / preset / runtime / skips so
  // the dir build matches the hand-written build({output:'run'}) call.
  const recipe = projectBuildRecipe(platform, files.map((f) => f.name));

  // With a custom ASM entry, the entry is the ONE source; every OTHER top-level
  // .asm/.s/.c routes as an include (asar/wla resolve `.include`/`#include`
  // from the includes mount), matching the single-source asm model.
  if (entryName && /\.(asm|s)$/i.test(entryName)) {
    for (const f of files) {
      if (/\.(c|s|asm)$/i.test(f.name) && f.name !== entryName) recipe.includeAsC.add(f.name);
    }
  }

  /** @type {Record<string,string>} */ const sources = {};
  /** @type {Record<string,string>} */ const includes = {};
  /** @type {Record<string,string>} */ const binaryIncludes = {};
  let crt0 = null;
  for (const f of files) {
    const n = f.name;
    if (recipe.skip.has(n)) continue;
    if (recipe.crt0File === n) { crt0 = await readFile(path.join(projPath, n), "utf-8"); continue; }
    // includeAsC: a .c that's `#include`d by another TU (e.g. SNES main.c
    // includes snes_sfx.c) — make it an include, NOT a separate source TU.
    if (recipe.includeAsC.has(n)) { includes[n] = await readFile(path.join(projPath, n), "utf-8"); continue; }
    if (/\.(c|s|asm)$/i.test(n))    sources[n] = await readFile(path.join(projPath, n), "utf-8");
    else if (/\.(h|inc)$/i.test(n)) includes[n] = await readFile(path.join(projPath, n), "utf-8");
    else if (/\.(bin|chr|pcm|brr|vgm|vgz|xgm|xgc|xgm2|esf|tfi|eif|nsf|raw|pal|map|tmx|spc|wav|gbs)$/i.test(n)) {
      // Any binary asset an .incbin might reference. (.xgc = compiled XGM2 blob,
      // .vgz/.esf/etc = music driver inputs.) Missing one = "file not found: X".
      binaryIncludes[n] = (await readFile(path.join(projPath, n))).toString("base64");
    }
  }

  // Stage subdirectory assets (any extension) keyed by their path relative to the
  // project root, so `incbin "col/misc/X.pal"` / `.incbin "gfx/a.bin"` resolve in
  // the mount. Text-ish includes (.asm/.s/.h/.inc) found in subdirs go to includes
  // (so `incsrc "lib/foo.asm"` works); everything else is a binary asset.
  for (const a of subAssets) {
    if (recipe.skip.has(a.rel) || a.rel === entrySubAsset?.rel) continue;
    if (/\.(h|inc|asm|s)$/i.test(a.rel)) {
      includes[a.rel] = (await readFile(a.abs)).toString("utf-8");
    } else {
      binaryIncludes[a.rel] = (await readFile(a.abs)).toString("base64");
    }
  }

  // A NESTED entry (e.g. src/main.c) is read here as the entry SOURCE — the
  // top-level loop above only sees root files, so a subdir entry would otherwise
  // never compile. Keyed by its relative path so #include/.include resolution
  // from the same subdir works.
  if (entrySubAsset) {
    sources[entrySubAsset.rel] = (await readFile(entrySubAsset.abs)).toString("utf-8");
  }

  // SMS/GG with no crt0 file in the dir → fall back to the bundled crt0,
  // exactly like the output:'rom'/'run' handlers do. Without this the link
  // silently uses SDCC's stock z80 crt0, which never calls main() (black
  // screen at boot). The SMS scaffold historically shipped without a crt0
  // file, so this fallback is load-bearing for existing project dirs.
  if (crt0 == null && (platform === "sms" || platform === "gg")) {
    crt0 = await resolveAutoCrt0(platform);
  }

  // GBA runtime refinement: libgba if the entry includes <gba.h>, else the
  // libtonc default the recipe set.
  let runtime = recipe.runtime;
  if (platform === "gba" && sources["main.c"] && /#\s*include\s*[<"]gba\.h[>"]/.test(sources["main.c"])) {
    runtime = "libgba";
  }

  return { sources, includes, binaryIncludes, crt0, codeLoc: recipe.codeLoc, dataLoc: recipe.dataLoc, linkerConfig: recipe.linkerConfig, runtime, maxmod: recipe.maxmod };
}

export async function buildProjectCore({ path: projPath, platform, outputPath, options, defines, entry }) {
  const { sources, includes, binaryIncludes, crt0, codeLoc, dataLoc, linkerConfig, runtime, maxmod } = await readProjectDir(projPath, platform, { entry });

  // Thread `options` (e.g. asar `--define _VER=1`, `--fix-checksum=off`) + the `defines`
  // convenience map through to the toolchain — project mode used to silently drop them.
  const mergedOptions = [
    ...(Array.isArray(options) ? options : []),
    ...(defines && typeof defines === "object"
      ? Object.entries(defines).flatMap(([k, v]) => ["--define", `${k}=${v}`])
      : []),
  ];

  // Linker preset: the recipe names it (e.g. NES 'chr-ram-runtime', which ships
  // the OAM/CHARS segments + its own crt0). resolveLinkerConfig also returns any
  // preset support sources (the preset crt0) — those merge into the sources.
  const { cfg: resolvedLinkerConfig, supportSources } = await resolveLinkerConfig(platform, linkerConfig);
  const mergedSources = Object.keys(supportSources).length ? { ...supportSources, ...sources } : sources;

  // Assemble a routed crt0 (SDCC sm83/z80) into a .rel, exactly like the
  // output:'rom'/'run' path — passing it as `crt0` (NOT a source TU) is what
  // avoids the gsinit double-definition on GB/GBC.
  let crt0Rel;
  if (crt0) {
    const isSm83 = platform === "gb" || platform === "gbc";
    const { runSdasgb, runSdasz80 } = await import("../../toolchains/sdcc/sdcc.js");
    const asm = isSm83 ? await runSdasgb({ source: crt0 }) : await runSdasz80({ source: crt0 });
    if (!asm.rel) throw crt0AssemblyError(asm.log);
    crt0Rel = asm.rel;
  }

  // Single-source toolchains (dasm/atari2600, vasm/asm) take `source`, not the
  // multi-TU `sources` map. When the dir has exactly one source file and no
  // preset support sources, pass it as `source` so those targets still build
  // (the original asm-only buildProject behavior).
  const srcNames = Object.keys(sources);
  const singleSource = srcNames.length === 1 && Object.keys(supportSources).length === 0 && !crt0Rel;
  const result = await buildForPlatform({
    platform,
    runtime,
    maxmod,
    ...(singleSource
      ? { source: sources[srcNames[0]], sourceName: srcNames[0] }
      : { sources: mergedSources }),
    includes: Object.keys(includes).length ? includes : undefined,
    binaryIncludes: Object.keys(binaryIncludes).length ? binaryIncludes : undefined,
    linkerConfig: resolvedLinkerConfig,
    crt0: crt0Rel,
    codeLoc,
    dataLoc,
    options: mergedOptions.length ? mergedOptions : undefined,
  });
  if (outputPath && result.binary) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.binary);
  }
  const logSibling = outputPath && result.binary ? `${outputPath}.build.log` : null;
  return jsonContent({
    ok: result.ok,
    toolchain: result.toolchain,
    exitCode: result.exitCode,
    binaryBytes: result.binary ? result.binary.length : 0,
    outputPath: outputPath && result.binary ? outputPath : null,
    sourcesBuilt: Object.keys(sources),
    ...(Object.keys(binaryIncludes).length ? { binaryIncludes: Object.keys(binaryIncludes) } : {}),
    romLayout: describeRomLayout(platform, result.binary),
    ...(result.stage ? { stage: result.stage } : {}),
    ...(await logField(result.log, false, logSibling, result.ok)),
    issues: rankIssues(result.issues ?? []),
  });
}

/**
 * build({output:'reassemble'}) — the UNIFORM byte-exact round-trip.
 *
 * Rebuild a `disasm({target:'project'})` output dir into a byte-identical ROM,
 * on EVERY platform. Reads the `reassemble.json` manifest disasm wrote, then for
 * each region assembles its (possibly hand-edited) `.asm` with the platform's
 * native assembler and SPLICES the result into a copy of the original ROM
 * (`original.rom`, kept in the dir) at the region's file offset — so the header,
 * inter-region gaps, and trailing pad come back verbatim. The result equals the
 * original exactly when no region was edited; an edit that keeps a region's
 * length rebuilds a modified-but-valid ROM; an edit that CHANGES a region's
 * length is reported as a per-region mismatch (splicing would corrupt offsets).
 *
 * This is the "cmp before commit" gate a ROM-hacking / annotation workflow needs,
 * and unlike rebuild.json it exists for ALL classic platforms, not just the
 * cc65-native subset.
 */
export async function reassembleProjectCore({ path: projPath, platform, outputPath }) {
  const { assembleRegionText } = await import("../../toolchains/common/reassemble.js");
  const manifestPath = path.join(projPath, "reassemble.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    // Before claiming this was never a disasm project, check for the LEGACY
    // manifest. Early disasm({target:'project'}) (v0.2x era) wrote rebuild.json,
    // so a mature annotated project can sit right here and still miss the file
    // this op looks for — and the old message read as "wrong directory", which
    // points at the wrong fix.
    //
    // The advice mattered more than the diagnosis: telling someone to re-run
    // disasm({target:'project'}) on an ANNOTATED project would regenerate the
    // sources and, done into the same directory, destroy months of annotations.
    // That was actively dangerous on exactly the projects most likely to hit
    // this error, so the safe hand-maintained path is named first.
    let legacy = null;
    try { legacy = JSON.parse(await readFile(path.join(projPath, "rebuild.json"), "utf8")); } catch { /* absent */ }
    if (legacy) {
      throw new Error(
        `build({output:'reassemble'}): found a LEGACY rebuild.json in '${projPath}' (early disasm({target:'project'}) wrote that name; this op wants reassemble.json). ` +
        "Do NOT re-run disasm({target:'project'}) on an annotated project — it regenerates the sources and would overwrite your annotations. " +
        "Rebuild this project with build({output:'rom', sourcesPaths:{…}, linkerConfigPath:'…'}) instead, passing the file list from its BUILD docs. " +
        "Note that a legacy rebuild.json's recorded call is often stale (a single source entry, or the wrong mapper), so validate it against the files actually on disk rather than trusting it. " +
        "To adopt this op, regenerate into a SCRATCH directory and copy reassemble.json + original.rom across, leaving your sources untouched.",
      );
    }
    throw new Error(
      `build({output:'reassemble'}): no reassemble.json in '${projPath}'. This op rebuilds a ` +
      "disasm({target:'project'}) directory — run that first (it writes reassemble.json + original.rom). " +
      "If this IS an existing annotated project, do NOT regenerate over it: build it with " +
      "build({output:'rom', sourcesPaths, linkerConfigPath}), or regenerate into a scratch dir and copy the manifest across.",
    );
  }
  const plat = platform ?? manifest.platform;
  if (platform && manifest.platform && platform !== manifest.platform) {
    throw new Error(`build({output:'reassemble'}): platform '${platform}' ≠ manifest platform '${manifest.platform}'.`);
  }

  // The gap template: a copy of the original ROM. Reassembled regions overwrite
  // their ranges; everything else (header, vectors, inter-region gaps, pad) is
  // preserved byte-for-byte from here.
  const templatePath = path.isAbsolute(manifest.romTemplate)
    ? manifest.romTemplate
    : path.join(projPath, manifest.romTemplate);
  let template;
  try {
    template = new Uint8Array(await readFile(templatePath));
  } catch {
    throw new Error(`build({output:'reassemble'}): missing ROM template '${templatePath}' (the original.rom disasm kept). Re-run disasm({target:'project'}).`);
  }
  if (manifest.romLength != null && template.length !== manifest.romLength) {
    throw new Error(`build({output:'reassemble'}): original.rom is ${template.length} bytes but manifest says ${manifest.romLength} — stale project.`);
  }

  const rom = template.slice(); // mutable copy — splice regions into it
  const regionResults = [];
  let anyEditKeptExact = false;

  for (const reg of manifest.regions) {
    const asmText = await readFile(path.join(projPath, reg.file), "utf8");
    const r = await assembleRegionText({
      platform: plat,
      asmText,
      startAddress: reg.startAddress,
      byteLength: reg.byteLength,
    });
    if (!r.ok || !r.bytes) {
      // Structured failure (v0.94.0 round 2): strip the assembler's ANSI color
      // codes, parse the log into the standard issues[] contract, and remap the
      // internal concatenation name (main.s) + line numbers to the REGION'S
      // real source file — reassemble is the hottest call in an annotation
      // project, so its errors must point at the file the agent actually edits.
      const cleanLog = (r.log || "assemble failed").replace(/\x1b\[[0-9;]*m/g, "");
      const lineShift = r.prependedLines ?? 0;
      const issues = parseBuildLog(cleanLog).map((iss) => ({
        ...iss,
        ...(iss.file === "main.s" || iss.file == null ? { file: reg.file } : {}),
        ...(iss.line != null && lineShift ? { line: iss.line - lineShift } : {}),
      }));
      regionResults.push({
        file: reg.file, ok: false, byteExact: false,
        ...(issues.length ? { issues } : {}),
        error: cleanLog.split("\n").filter((l) => l.trim()).slice(-3).join(" | ")
          .replace(/main\.s:(\d+)/g, (_, n) => `${reg.file}:${Number(n) - lineShift}`)
          .slice(0, 400),
      });
      continue;
    }
    // A length-changing edit can't be spliced without shifting every later byte —
    // refuse rather than silently corrupt the ROM. `producedLength` (GNU path) is
    // the true assembled size BEFORE the byteLength slice; without it fall back to
    // the sliced length (the cc65 path errors at ld65 on overflow, so it's safe).
    const producedLen = r.producedLength ?? r.bytes.length;
    if (producedLen !== reg.byteLength) {
      regionResults.push({
        file: reg.file, ok: false, byteExact: false,
        error: `region reassembled to ${producedLen} bytes but must be ${reg.byteLength} (a length-changing edit can't be spliced back — keep the region's byte count, or use build({output:'rom'}) with a full linker recipe).`,
      });
      continue;
    }
    // Compare against the original bytes at this offset to report whether THIS
    // region matches the source ROM (edited-but-valid regions differ, that's ok).
    const orig = template.slice(reg.fileOffset, reg.fileOffset + reg.byteLength);
    let regionExact = true;
    for (let i = 0; i < reg.byteLength; i++) {
      rom[reg.fileOffset + i] = r.bytes[i];
      if (r.bytes[i] !== orig[i]) regionExact = false;
    }
    if (!regionExact) anyEditKeptExact = true;
    regionResults.push({
      file: reg.file, ok: true, byteExact: regionExact,
      startAddress: "$" + reg.startAddress.toString(16).toUpperCase(),
      fileOffset: "0x" + reg.fileOffset.toString(16).toUpperCase(),
      bytes: reg.byteLength,
    });
  }

  // Whole-ROM byte-exact vs the original template.
  let romExact = rom.length === template.length;
  if (romExact) for (let i = 0; i < rom.length; i++) if (rom[i] !== template[i]) { romExact = false; break; }

  const anyRegionFailed = regionResults.some((r) => !r.ok);
  const ext = PLATFORM_VIRTUAL_EXT[plat] ?? ".bin";
  const outPath = outputPath ?? path.join(projPath, "rebuilt" + ext);
  // Only write when every region assembled (a failed region means the ROM is
  // incomplete/garbage — don't hand back a broken image).
  let wrote = null;
  if (!anyRegionFailed) {
    await writeFile(outPath, rom);
    wrote = outPath;
  }

  const note = anyRegionFailed
    ? `Reassembly INCOMPLETE — ${regionResults.filter((r) => !r.ok).length} region(s) failed (see regions[].error). No ROM written.`
    : romExact
      ? `Byte-IDENTICAL to the original ROM (${rom.length} bytes). Round-trip verified — safe to commit.`
      : anyEditKeptExact
        ? `Rebuilt ${rom.length} bytes with edited region(s) (regions[].byteExact=false = your changes). Not identical to the original — that's expected for an intentional edit.`
        : `Rebuilt ${rom.length} bytes but NOT byte-identical to the original despite no reported region edits — investigate regions[] before trusting this.`;

  // Region output: when the whole ROM is byte-identical, the per-region array is
  // pure boilerplate (the top-level byteExact + note carry the signal), and on a
  // 32-bank cart that's ~2.5KB of repeated tokens per rebuild. Collapse to a
  // count summary on full success; list the ACTIONABLE rows (failed or edited/
  // mismatched) otherwise — which is exactly when the detail matters. (Field
  // report: reassemble echoed all 32 regions on every success.)
  const allClean = !anyRegionFailed && regionResults.every((r) => r.byteExact !== false);
  const regionsOut = allClean
    ? { count: regionResults.length, allByteExact: true }
    : regionResults.filter((r) => !r.ok || r.byteExact === false);

  return jsonContent({
    ok: !anyRegionFailed,
    output: "reassemble",
    platform: plat,
    byteExact: !anyRegionFailed && romExact,
    outputPath: wrote,
    romLength: rom.length,
    regions: regionsOut,
    note,
  });
}
