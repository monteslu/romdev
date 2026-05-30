// Toolchain dispatcher: build a project for a given platform using the right
// bundled assembler/compiler.

import { runDasm } from "./dasm/dasm.js";
import { buildC, buildAsm } from "./cc65/cc65.js";
import { runAsar } from "./asar/asar.js";
import { runVasm68k } from "./vasm68k/vasm68k.js";
import { finalizeGenesisRom } from "./genesis-c/genesis-c.js";
import { buildGB, runRgbfix } from "./rgbds/rgbds.js";
import { buildZ80C, SDCC_PORTS } from "./sdcc/sdcc.js";
import { parseBuildLog } from "./parse-errors.js";

/** Map our platform ids to cc65 target ids. */
const CC65_TARGET = {
  nes: "nes",
  c64: "c64",
  atari7800: "atari7800",
  lynx: "lynx",
};

/**
 * (platform, language) → toolchain dispatch.
 *
 * `language` is optional on buildSource; each platform has a documented
 * default (see PLATFORM_DEFAULT_LANGUAGE). Defaults reflect the best
 * choice for vibe-coding: smallest toolchain footprint, fastest build,
 * highest LLM fluency. Picky users override via `language: "c"` etc.
 *
 * Adding a new language for a platform = add a row here + ship the
 * toolchain wasm. The `available: false` entries declare future
 * intent but don't yet ship a toolchain — listPlatforms surfaces them
 * so the discoverability story is honest.
 *
 * @type {Record<string, Record<string, { toolchain: string, available: boolean, note?: string }>>}
 */
const LANGUAGE_TOOLCHAIN = {
  atari2600: {
    asm:    { toolchain: "dasm",         available: true },
    basic:  { toolchain: "batariBasic",  available: false, note: "BASIC for 2600 via batariBasic — not bundled. bB's transpiler is written in Perl, which we don't ship as WASM. A port to C or JS would be a multi-day project. For now, write 2600 games in 6507 asm via dasm — the bundled scaffolds (default, paddle, single_screen) show the canonical race-the-beam pattern, and an LLM agent writes 2600 asm fluently." },
  },
  nes: {
    asm: { toolchain: "cc65",  available: true },
    c:   { toolchain: "cc65",  available: true },
  },
  c64: {
    c:   { toolchain: "cc65",  available: true },
    asm: { toolchain: "cc65",  available: true },
  },
  atari7800: {
    c:   { toolchain: "cc65",  available: true },
    asm: { toolchain: "cc65",  available: true },
  },
  lynx: {
    c:   { toolchain: "cc65",  available: true },
    asm: { toolchain: "cc65",  available: true },
  },
  gb: {
    asm: { toolchain: "rgbds", available: true },
    c:   { toolchain: "sdcc",  available: true, note: "C for GB via SDCC's sm83 port (GBDK-style)" },
  },
  gbc: {
    asm: { toolchain: "rgbds", available: true },
    c:   { toolchain: "sdcc",  available: true, note: "C for GBC via SDCC's sm83 port (GBDK-style)" },
  },
  snes: {
    asm: { toolchain: "asar",       available: true },
    c:   { toolchain: "tcc816+wladx", available: true, note: "C for SNES via tcc-65816 + wla-65816 + wlalink (R15). Minimum-viable runtime — bare main() compiles. No PVSnesLib helpers (console, sprites) bundled yet." },
  },
  genesis: {
    asm: { toolchain: "vasm68k",      available: true },
    c:   { toolchain: "m68k-elf-gcc", available: true, note: "C for Genesis via gcc 14.2.0 + binutils + newlib, all compiled to WASM (R20). Minimum-viable runtime — bare main() works. SGDK helpers (sprite engine, VDP, sound) pending bundling." },
  },
  gba: {
    c: { toolchain: "arm-none-eabi-gcc", available: true, note: "C for GBA via gcc 14.2.0 + binutils + newlib + libtonc 1.4.5 (default) OR libgba 0.5.4 (opt-in via runtime:\"libgba\"), all compiled to WASM (R24 + R28). #include <tonc.h> + tte_write/tte_printf works out of the box — that's the canonical Tonc-tutorial API every published GBA C resource uses. Caveat: tte_iohook (libtonc) and console.c (libgba) — the libsysbase-backed iprintf bridges — are NOT bundled. Use tte_printf directly, which is what the Tonc tutorial actually does." },
  },
  sms:    { c: { toolchain: "sdcc", available: true }, asm: { toolchain: "sdcc", available: true } },
  gg:     { c: { toolchain: "sdcc", available: true }, asm: { toolchain: "sdcc", available: true } },
  spc700: { asm: { toolchain: "asar", available: true } },
};

/**
 * Default language per platform. The choice reflects what's fastest /
 * smallest / best-matched to LLM fluency, NOT "what's friendliest to
 * humans." Most platforms default to asm because LLMs write retro asm
 * fluently and the resulting binaries are smaller + faster to build.
 * cc65-targeted platforms default to C because cc65 was originally a
 * C compiler and the C path is the canonical workflow there.
 *
 * @type {Record<string, string>}
 */
const PLATFORM_DEFAULT_LANGUAGE = {
  atari2600:  "asm",
  nes:        "c",
  c64:        "c",
  atari7800:  "c",
  lynx:       "c",
  gb:         "c",
  gbc:        "c",
  snes:       "asm",
  genesis:    "asm",
  gba:        "c",
  sms:        "c",
  gg:         "c",
  spc700:     "asm",
};

/**
 * Public API for the platforms tool to discover the language matrix.
 * Returns `{defaultLanguage, languages: [{language, toolchain, available, note?}]}`.
 * Returns null for platforms with no language entries (shouldn't
 * happen for any supported platform — fallback safety).
 */
export function getLanguageOptions(platform) {
  const langs = LANGUAGE_TOOLCHAIN[platform];
  if (!langs) return null;
  return {
    defaultLanguage: PLATFORM_DEFAULT_LANGUAGE[platform] ?? Object.keys(langs)[0],
    languages: Object.entries(langs).map(([language, info]) => ({
      language,
      ...info,
    })),
  };
}

/**
 * Per-platform ROM size for Z80 (SDCC) targets. Cores expect the binary
 * padded to a specific size; agents shouldn't have to know this.
 * @type {Record<string, number>}
 */
const SDCC_ROM_SIZE = {
  sms:        32 * 1024,  // Master System min cartridge size
  gg:         32 * 1024,  // Game Gear same
  gb:         32 * 1024,  // Game Boy 32 KB ROM (no MBC needed)
  gbc:        32 * 1024,
};

/**
 * @typedef {Object} BuildArgs
 * @property {string} platform target platform id
 * @property {string} [language] optional language override (e.g. "c", "asm", "basic"). Each platform has a documented default; only pass this when you specifically want a non-default language. Use listPlatforms() to see the matrix.
 * @property {string} [source] main source contents (single-file shortcut)
 * @property {Record<string, string>} [sources] multi-file project: {name: contents}.
 *   For cc65, each entry becomes its own translation unit (ca65 .o or cc65→ca65→.o).
 *   Files with .s/.asm extensions go straight to ca65; others are treated as C.
 * @property {Record<string, string>} [includes] virtual filename → contents (for `.include`d files)
 * @property {string[]} [options] extra toolchain flags
 * @property {string} [linkerConfig] custom ld65 .cfg (cc65-targets only)
 */

/**
 * @typedef {Object} BuildResult
 * @property {boolean} ok
 * @property {Uint8Array | null} binary the assembled ROM (or null on failure)
 * @property {string} listing optional listing file content
 * @property {string} symbols optional symbol table
 * @property {string} log compiler log (stdout+stderr merged)
 * @property {number} exitCode
 * @property {string} toolchain
 */

/**
 * Fill the SNES internal checksum ($FFDE) + complement ($FFDC). The SNES
 * has no boot-ROM gate, so this isn't needed to run on bare hardware — but
 * emulators and flashcarts read it (some flashcarts use it to tell LoROM
 * from HiROM), so a zeroed checksum can cause RetroArch / flashcart load
 * failures or mapper mis-detection. Mirrors pvsneslib's snestools algorithm.
 *
 * Detect LoROM vs HiROM from the map-mode byte at header+$15 (bit0 set =
 * HiROM). Header is at file $7FC0 (LoROM) or $FFC0 (HiROM); checksum fields
 * are at header+$1C (complement) and header+$1E (checksum). Sum every byte
 * but treat the 4 checksum bytes as $FF,$FF,$00,$00 (= the +$1FE constant),
 * which is their value once complement=$FFFF and checksum=$0000. Assumes a
 * power-of-2 ROM (asar/pvsneslib pad to 32KB+); skips finalize otherwise.
 *
 * @param {Uint8Array} bin
 * @returns {{ bin: Uint8Array, note: string }}
 */
function finalizeSnesRom(bin) {
  // Need at least a 32KB LoROM to have a header.
  if (!bin || bin.length < 0x8000) return { bin, note: "too small for a SNES header — checksum skipped" };
  // Pad to the next power of two (min 32KB). asar already pads; pvsneslib's
  // C output does NOT (e.g. 35136 bytes), and flashcarts/emulators expect a
  // power-of-2 image — and the simple sum-all-bytes checksum below is only
  // correct for power-of-2 sizes. So pad first, then checksum.
  let padNote = "";
  if ((bin.length & (bin.length - 1)) !== 0) {
    let target = 0x8000;
    while (target < bin.length) target <<= 1;
    const padded = new Uint8Array(target); // zero-filled
    padded.set(bin);
    padNote = ` (padded ${bin.length}→${target})`;
    bin = padded;
  }
  const loHdr = 0x7FC0, hiHdr = 0xFFC0;
  // Map-mode byte sits at header+$15. Prefer LoROM detection: read both
  // candidates; bit0 set = HiROM. Default to LoROM (asar/pvsneslib default).
  let hdr = loHdr;
  const loMode = bin[loHdr + 0x15];
  const hiMode = bin.length > hiHdr + 0x15 ? bin[hiHdr + 0x15] : undefined;
  // If the LoROM map byte doesn't look like a valid mode (0x20/0x30) but the
  // HiROM one does (0x21/0x31), treat as HiROM.
  const looksLo = (loMode & 0x0F) === 0x00 || loMode === 0x20 || loMode === 0x30;
  if (hiMode !== undefined && ((hiMode & 0x01) === 1) && !((loMode & 0x01) === 0 && looksLo)) {
    hdr = hiHdr;
  } else if ((loMode & 0x01) === 1) {
    hdr = hiHdr;
  }
  const compOff = hdr + 0x1C; // $FFDC / $7FDC
  const sumOff  = hdr + 0x1E; // $FFDE / $7FDE
  // Sum all bytes, counting the 4 checksum bytes as their finalized values
  // ($FF,$FF,$00,$00) regardless of what's there now.
  let sum = 0;
  for (let i = 0; i < bin.length; i++) {
    if (i >= compOff && i < compOff + 4) continue; // skip the 4 cksum bytes
    sum = (sum + bin[i]) & 0xFFFF;
  }
  sum = (sum + 0x1FE) & 0xFFFF; // = 0xFF+0xFF+0x00+0x00 for the skipped bytes
  const comp = sum ^ 0xFFFF;
  bin[compOff]     = comp & 0xFF;
  bin[compOff + 1] = (comp >> 8) & 0xFF;
  bin[sumOff]      = sum & 0xFF;
  bin[sumOff + 1]  = (sum >> 8) & 0xFF;
  return { bin, note: `SNES checksum ${sum.toString(16).toUpperCase().padStart(4,"0")} written (${hdr === hiHdr ? "HiROM" : "LoROM"} header @ $${hdr.toString(16).toUpperCase()})${padNote}` };
}

/**
 * @param {BuildArgs} args
 * @returns {Promise<BuildResult>}
 */
export async function buildForPlatform(args) {
  // ---- language axis: validate before dispatching to toolchain ----
  // Optional. When omitted, falls through to the existing per-platform
  // dispatch (which has its own source-content heuristic for cc65).
  // When specified, we check that the (platform, language) pair is
  // supported AND available; reject with a structured error if not.
  if (args.language) {
    const langs = LANGUAGE_TOOLCHAIN[args.platform];
    const entry = langs?.[args.language];
    if (!entry) {
      const available = langs ? Object.keys(langs) : [];
      throw new Error(
        `language '${args.language}' not supported for platform '${args.platform}'. ` +
        `Supported: ${available.join(", ") || "(none)"}. ` +
        `Call listPlatforms() to see the full matrix.`
      );
    }
    if (!entry.available) {
      throw new Error(
        `language '${args.language}' for platform '${args.platform}' is planned but not yet bundled. ` +
        `${entry.note ?? ""} ` +
        `Default for this platform is '${PLATFORM_DEFAULT_LANGUAGE[args.platform]}'; omit the language parameter to use it.`
      );
    }
    // entry.available === true — continue with existing dispatch.
    // The dispatch is keyed on platform alone today; future expansion
    // would route within a platform by language. For now the asserted
    // language matches what the platform's single toolchain produces,
    // so we proceed unchanged.
  }

  if (args.platform === "atari2600") {
    const r = await runDasm({
      source: args.source,
      includes: args.includes,
      options: args.options,
      outputFormat: "f3",
    });
    return {
      ok: r.exitCode === 0 && r.binary !== null,
      binary: r.binary,
      listing: r.listing,
      symbols: r.symbols,
      log: r.log,
      issues: parseBuildLog(r.log),
      exitCode: r.exitCode,
      toolchain: "dasm",
    };
  }

  const cc65Target = CC65_TARGET[args.platform];
  if (cc65Target) {
    // For multi-file projects, route by extension. If even one source has a
    // C-looking name (.c / .h) we use buildC (which can mix .c and .s files);
    // otherwise everything goes through buildAsm.
    /** @type {Record<string, string>} */
    let sources = args.sources;
    if (!sources) {
      // single-source: route by heuristic on the contents
      const looksLikeAsm = /^\s*\.(segment|proc|byte|word|repeat|res|setcpu|export|import|zeropage|code|macro|include)\b/m.test(args.source);
      const looksLikeC = !looksLikeAsm && /\b(int|void|return|#include|main\s*\()/.test(args.source);
      sources = { [looksLikeC ? "main.c" : "main.s"]: args.source };
    }
    const anyC = Object.keys(sources).some((n) => /\.(c|h)$/i.test(n));

    // Resolve preset linkerConfig (e.g. "chr-ram") into the actual .cfg
    // contents + any companion support sources (custom crt0, etc.).
    // Caller passes either a preset name or the .cfg contents directly;
    // the build pipeline does NOT auto-select presets based on source
    // contents — every byte that compiles must be visible to the caller.
    const { resolveLinkerConfig } = await import("./cc65/preset-resolver.js");
    const { cfg, supportSources } = await resolveLinkerConfig(args.platform, args.linkerConfig);

    // Splice in any preset support sources (crt0, etc.). User sources win
    // if there's a name collision, but the preset uses `_preset_*` so it
    // wouldn't normally collide.
    sources = { ...supportSources, ...sources };

    const builder = anyC ? buildC : buildAsm;
    const r = await builder({
      sources,
      target: cc65Target,
      [anyC ? "headers" : "includes"]: args.includes,
      binaryIncludes: args.binaryIncludes,
      linkerConfig: cfg,
    });
    return {
      ok: r.exitCode === 0 && r.binary !== null,
      binary: r.binary,
      listing: "",
      symbols: "",
      log: r.log,
      issues: parseBuildLog(r.log),
      exitCode: r.exitCode,
      toolchain: anyC ? "cc65" : "ca65+ld65",
      ...(r.ramUsage ? { ramUsage: r.ramUsage } : {}),
    };
  }

  if (args.platform === "gb" || args.platform === "gbc") {
    // Default is C (sdcc sm83 port) — matches how LLMs naturally think
    // about game logic, same default we use on NES/SMS. Pass
    // `language:"asm"` to route through RGBDS for hand-tuned binaries.
    // C-mode requires the sm83 SDCC port libs (share/sdcc/lib/sm83/*)
    // — built by scripts/build-sdcc.sh.
    if (args.language === "asm") {
      const r = await buildGB({
        source: args.source,
        includes: args.includes,
      });
      return {
        ok: r.exitCode === 0 && r.binary !== null,
        binary: r.binary,
        listing: "",
        symbols: "",
        log: r.log,
        issues: parseBuildLog(r.log),
        exitCode: r.exitCode,
        toolchain: "rgbds",
      };
    }
    // language === "c" or undefined → fall through to the sdcc dispatch
    // below (SDCC_PORTS["gb"] = sm83 port).
  }

  if (args.platform === "gba") {
    // R24 + R28: language:"c" routes through the arm-none-eabi gcc +
    // binutils WASM toolchain (cc1-arm → as → ld → objcopy). Three
    // runtime modes:
    //   - "libtonc" (default) — Tonc tutorial-aligned. `#include <tonc.h>`,
    //     TTE for text, tonccpy/toncset, OBJ_ATTR sprite API.
    //   - "libgba"            — devkitPro's official SDK. `#include <gba.h>`.
    //   - "none"              — bare gcc + newlib only.
    // Legacy `libgba: true|false` flag still accepted for R24 callers.
    // language defaults to "c" since no asm path is wired yet — saves
    // every caller from having to spell it out.
    if (args.language === "c" || args.language == null) {
      const { buildGbaC } = await import("./gba-c/gba-c.js");
      const r = await buildGbaC({
        source: args.source,
        sources: args.sources,
        headers: args.includes,
        binaryIncludes: args.binaryIncludes,  // R34 — soundbank.bin et al.
        runtime: args.runtime,    // explicit wins
        libgba:  args.libgba,     // legacy R24 flag (undef passes through)
        maxmod:  args.maxmod,     // R33 — opt-in maxmod music link
      });
      return {
        ok: r.ok,
        binary: r.binary,
        listing: "",
        symbols: "",
        log: r.log,
        issues: parseBuildLog(r.log),
        exitCode: r.exitCode,
        toolchain: "arm-none-eabi-gcc",
        stage: r.stage,
        ...(r.crash ? { crash: r.crash } : {}),
      };
    }
    // GBA without language:"c" — no asm fallback yet; surface the error
    throw new Error("gba: only language:\"c\" supported today; asm path not yet wired");
  }

  if (args.platform === "genesis") {
    // R20: language:"c" routes through the m68k-elf gcc + binutils WASM
    // toolchain (cc1 → as → ld → objcopy) with our minimum-viable sega.s
    // crt0 + genesis.ld linker script. Bare `int main(void)` produces a
    // runnable Genesis ROM. SGDK runtime helpers (sprite engine, VDP,
    // sound) follow in stage 3 of R20.
    if (args.language === "c") {
      const { buildGenesisC } = await import("./genesis-c/genesis-c.js");
      const r = await buildGenesisC({
        source: args.source,
        sources: args.sources,
        headers: args.includes,
        // R42: binaryIncludes lets data.s siblings .incbin music/sample
        // blobs (e.g. demo.xgc for XGM2) without going through rescomp.
        binaryIncludes: args.binaryIncludes,
        // Default: link against bundled SGDK runtime. Pass sgdk:false in
        // `options` for the bare-gcc minimum-viable path.
        sgdk: args.sgdk !== false,
      });
      return {
        ok: r.ok,
        // Finalize like SGDK's makefile (pad to 128KB boundary, min 512KB,
        // fix the $18E checksum) so the ROM loads on strict cores
        // (RetroArch Genesis Plus GX / BlastEm) and flashcarts.
        binary: r.ok && r.binary ? finalizeGenesisRom(r.binary) : r.binary,
        listing: "",
        symbols: "",
        log: r.log,
        issues: parseBuildLog(r.log),
        exitCode: r.exitCode,
        toolchain: "m68k-elf-gcc",
        stage: r.stage,
        ...(r.crash ? { crash: r.crash } : {}),
      };
    }

    // Default (language:"asm" or undefined): vasm68k path.
    // vasm68k is single-source. Accept either `source` (preferred) or
    // `sources` (multi-file shortcut) — when given the latter, pick a
    // canonical entry-point and write the rest into includes so the
    // entry can `incsrc "other.s"` them.
    //
    // Without this resolution, passing `sources` left args.source as
    // undefined, which crashed Emscripten with "Unsupported data type"
    // when MEMFS.writeFile got handed undefined.
    let source = args.source;
    let extraIncludes = {};
    if (!source && args.sources) {
      const entries = Object.entries(args.sources);
      if (entries.length === 0) throw new Error("vasm68k: sources is empty");
      // Pick main.s if present, else first key.
      const mainKey = args.sources["main.s"] != null ? "main.s" : entries[0][0];
      source = args.sources[mainKey];
      // Stage the others as text includes so the agent can `incsrc` them.
      for (const [name, content] of entries) {
        if (name !== mainKey) extraIncludes[name] = content;
      }
    }
    if (!source) {
      throw new Error("vasm68k requires `source` or `sources` with at least one entry");
    }
    const r = await runVasm68k({
      source,
      includes: { ...(args.includes ?? {}), ...extraIncludes },
      binaryIncludes: args.binaryIncludes,
      options: args.options,
    });
    const vasmOk = r.exitCode === 0 && r.binary !== null;
    return {
      ok: vasmOk,
      // Same SGDK-style finalize (pad + $18E checksum) for hand-written
      // asm ROMs — they hit the exact same strict-core load failure.
      binary: vasmOk && r.binary ? finalizeGenesisRom(r.binary) : r.binary,
      listing: "",
      symbols: "",
      log: r.log,
      issues: parseBuildLog(r.log),
      exitCode: r.exitCode,
      toolchain: "vasm68k",
    };
  }

  // SPC700: same asar WASM, but produce a flat raw binary (no SNES header,
  // no 256KB ROM padding). Lets agents author standalone SPC programs as
  // separate inputs that get .incbin'd into a SNES main.asm.
  if (args.platform === "spc700") {
    const r = await runAsar({
      source: args.source,
      includes: args.includes,
      binaryIncludes: args.binaryIncludes,
      options: args.options,
      flatBinary: true,
    });
    const ok = r.exitCode === 0 && r.binary !== null && r.binary.length > 0;
    let issues = parseBuildLog(r.log);
    if (!ok && issues.length === 0) {
      issues = [{
        severity: "error",
        stage: "asar",
        message: r.log.trim() ||
          `asar (spc700 mode) failed with exit code ${r.exitCode} and no diagnostic. ` +
          `Make sure your source starts with \`arch spc700\` and an \`org $XXXX\` directive.`,
      }];
    }
    return {
      ok,
      binary: r.binary,
      listing: "",
      symbols: "",
      log: r.log,
      issues,
      exitCode: r.exitCode,
      toolchain: "asar-spc700",
      flatStartOffset: r.flatStartOffset ?? 0,
    };
  }

  if (args.platform === "snes") {
    // R15: language:"c" routes through the tcc-65816 + wla-65816 + wlalink
    // pipeline, with our minimum-viable crt0 + hdr.asm bundled. Bare
    // `int main(void) { ... }` produces a runnable 32 KB LoROM. Anything
    // beyond that (graphics, sound, console helpers) the agent writes in
    // C against direct SNES hardware addresses or in a sibling .asm file.
    if (args.language === "c") {
      const { buildSnesC } = await import("./snes-c/snes-c.js");
      const r = await buildSnesC({
        source: args.source,
        sources: args.sources,
        headers: args.includes,
        binaryIncludes: args.binaryIncludes,
      });
      let snesLog = r.log;
      let snesBin = r.binary;
      if (r.ok && snesBin) {
        const fin = finalizeSnesRom(snesBin);
        snesBin = fin.bin;
        snesLog += "\n--- " + fin.note + " ---";
      }
      return {
        ok: r.ok,
        binary: snesBin,
        listing: "",
        symbols: "",
        log: snesLog,
        issues: parseBuildLog(r.log),
        exitCode: r.exitCode,
        toolchain: "tcc816+wladx",
        stage: r.stage,
        ...(r.crash ? { crash: r.crash } : {}),
      };
    }
    const r = await runAsar({
      source: args.source,
      includes: args.includes,
      binaryIncludes: args.binaryIncludes,
      options: args.options,
    });
    const ok = r.exitCode === 0 && r.binary !== null;
    let issues = parseBuildLog(r.log);
    // If asar failed but we couldn't parse anything useful, synthesize a
    // catch-all issue so the caller never sees `{ok:false, issues:[]}` and
    // has SOMETHING to act on. (asar's WASM build sometimes throws C++
    // exceptions without writing diagnostics; see asar wrapper for detail.)
    if (!ok && issues.length === 0) {
      issues = [{
        severity: "error",
        stage: "asar",
        message: r.log.trim() ||
          `asar failed with exit code ${r.exitCode} but produced no diagnostic output. ` +
          `This usually means a C++ exception (bank border, section overlap, ROM size) ` +
          `escaped silently. Reduce the source size or move data to a different bank, ` +
          `then bisect to isolate the offending directive.`,
      }];
    }
    let asarBin = r.binary;
    let asarLog = r.log;
    if (ok && asarBin) {
      const fin = finalizeSnesRom(asarBin);
      asarBin = fin.bin;
      asarLog += "\n--- " + fin.note + " ---";
    }
    return {
      ok,
      binary: asarBin,
      listing: "",
      symbols: r.symbols ?? "",
      log: asarLog,
      issues,
      exitCode: r.exitCode,
      toolchain: "asar",
      layout: r.layout ?? null,
      includes: r.includes ?? {},
    };
  }

  // Z80 family (SMS, GG) — sdcc.
  const sdccPort = SDCC_PORTS[args.platform];
  if (sdccPort) {
    const sources = args.sources ?? { "main.c": args.source };
    // GB/GBC: _CODE goes at $0150 — the area $0000-$014F is reserved for
    // the cartridge header + reset vectors which the custom crt0 provides.
    const codeLoc = args.codeLoc ?? 0x0000;
    const romSize = SDCC_ROM_SIZE[args.platform] ?? 32 * 1024;

    // crt0 + headers + sources come straight from the caller. The build
    // pipeline does NOT auto-inject platform runtimes, custom crt0s,
    // or post-link header patches. Every byte that compiles is visible
    // to the caller's repo. Use `createProject({platform, template})`
    // to scaffold a self-contained project with the runtime files
    // copied in, or call `getStarterSnippet` / `getAllStarterSnippets`
    // to fetch individual pieces.
    const crt0 = args.crt0;

    // Pre-flight lint: scan the C sources for known SDCC C89 violations
    // so agents see actionable warnings before SDCC's misleading parser
    // errors. See src/platforms/gb/lib/c/SDCC_GOTCHAS.md.
    //
    // Pass `port` so message text says the right port — SDCC sm83 on GB/GBC,
    // SDCC z80 on SMS/GG. Pre-r26 it always said
    // "SDCC sm83" regardless of the actual port (a copy-paste bug).
    const { lintSources } = await import("./sdcc/preflight-lint.js");
    const lintIssues = lintSources(sources, { port: sdccPort.marg });

    const r = await buildZ80C({
      sources,
      port: sdccPort.marg,
      romSize,
      headers: args.includes,
      codeLoc,
      dataLoc: args.dataLoc,
      libraries: args.libraries,
      crt0,
    });
    let binary = r.binary;
    // GB/GBC via SDCC: the C path produces a raw .gb with an UNPATCHED
    // header — no Nintendo logo at $0104, no header checksum at $014D. The
    // boot ROM on real Game Boy hardware (and strict emulators) LOCKS UP on
    // that. The asm path runs rgbfix; the C path didn't, so a C-built GB ROM
    // ran fine in our lenient WASM gambatte but white-screened / hung on
    // hardware. Run rgbfix here so buildSource always returns a bootable ROM.
    // (-v = valid logo + header/global checksums; -p 0xFF = pad; -C marks a
    // CGB-only ROM so .gbc builds set the $0143 CGB flag correctly.)
    if (binary && r.exitCode === 0 && (args.platform === "gb" || args.platform === "gbc")) {
      // -v: valid logo + header/global checksums. -p 0xFF: pad. -C: CGB-only
      // ($0143=$C0) for .gbc. CRITICAL: also set the cartridge-type ($0147)
      // and RAM-size ($0149) bytes — without -m/-r, -v leaves them at the
      // linker's garbage pad (e.g. type $3C), and emulators/hardware reject
      // an unknown MBC type with "retro_load_game failed". -m 0x00 = ROM ONLY
      // (no mapper), -r 0x00 = no cart RAM — correct for these 32KB scaffolds.
      const fixOpts = args.platform === "gbc"
        ? ["-v", "-p", "0xFF", "-C", "-m", "0x00", "-r", "0x00"]
        : ["-v", "-p", "0xFF", "-m", "0x00", "-r", "0x00"];
      const fix = await runRgbfix({ rom: binary, options: fixOpts });
      if (fix.exitCode === 0 && fix.binary) {
        binary = fix.binary;
        // rgbfix has no "force DMG" flag — without -c/-C it leaves $0143 at
        // whatever the linker padded ($FF here). $FF has bit 7 set, so a
        // DMG (.gb) ROM would wrongly trip CGB mode → BGP/OBP writes ignored
        // → white screen on a CGB-capable emulator. Force $0143 = $00 for
        // .gb. (.gbc already got $C0 from -C.)
        if (args.platform === "gb" && binary.length > 0x143) {
          binary[0x143] = 0x00;
          // $0143 is inside the header-checksum range ($0134..$014C), so
          // recompute that 8-bit checksum at $014D after editing it.
          let x = 0;
          for (let i = 0x134; i <= 0x14C; i++) x = (x - binary[i] - 1) & 0xFF;
          binary[0x14D] = x;
        }
        r.log += "\n--- rgbfix (auto header fix) ---\n" + (fix.log || "(ok)");
      } else {
        r.log += "\n--- rgbfix FAILED (header left unpatched — may not boot on hardware) ---\n" + (fix.log || "");
      }
    }
    // SMS/GG: if the ROM carries a "TMR SEGA" header at $7FF0, fill its
    // checksum word at $7FFA. The export (US/EU) SMS BIOS verifies it and
    // shows "SOFTWARE ERROR" if it's wrong — our header.s ships a $00,$00
    // placeholder, so a real Master System (and RetroDECK with the SMS BIOS)
    // rejected it. Checksum = sum of bytes $0000..$7FEF (everything before
    // the header), stored little-endian. GG BIOS doesn't check, but writing
    // it is harmless. Only touches ROMs that actually have the header.
    if (binary && r.exitCode === 0 && (args.platform === "sms" || args.platform === "gg") && binary.length >= 0x8000) {
      const hdr = 0x7FF0;
      const hasHeader = String.fromCharCode(...binary.slice(hdr, hdr + 8)) === "TMR SEGA";
      if (!hasHeader) {
        // No header emitted by the crt0 → write a complete TMR SEGA header
        // into the last 16 bytes of bank 0 ($7FF0-$7FFF). Without this the
        // export (US/EU) SMS BIOS shows "SOFTWARE ERROR" and refuses to run.
        // $7FF0-$7FF7 "TMR SEGA"; $7FF8-$7FF9 reserved ($00); $7FFA-$7FFB
        // checksum (filled below); $7FFC-$7FFE product code/version (zeros
        // ok for homebrew); $7FFF region+size = $4C (region 4 = export,
        // size $C = 32KB, the checksum range that covers $0000-$7FEF).
        const TMR = [0x54,0x4D,0x52,0x20,0x53,0x45,0x47,0x41]; // "TMR SEGA"
        for (let i = 0; i < 8; i++) binary[hdr + i] = TMR[i];
        binary[hdr + 8] = 0x00; binary[hdr + 9] = 0x00;   // reserved
        binary[hdr + 12] = 0x00; binary[hdr + 13] = 0x00; // product code lo
        binary[hdr + 14] = 0x00;                          // product/version
        binary[hdr + 15] = 0x4C;                          // region 4 (export) + size $C (32KB)
      }
      // Checksum = sum of bytes $0000..$7FEF (everything before the header),
      // stored little-endian at $7FFA. Region/size $4C declares the 32KB
      // range, so the BIOS checksums $0000-$7FEF.
      let sum = 0;
      for (let i = 0; i < 0x7FF0; i++) sum = (sum + binary[i]) & 0xFFFF;
      binary[0x7FFA] = sum & 0xFF;
      binary[0x7FFB] = (sum >> 8) & 0xFF;
      r.log += `\n--- SMS header ${hasHeader ? "checksum fixed" : "written + checksummed"} ($7FFA=${sum.toString(16).toUpperCase().padStart(4,"0")}, region/size=$4C) ---`;
    }
    // Combine lint warnings with parsed build log. Lint comes first so
    // agents see them at the top of the issues array.
    const buildIssues = parseBuildLog(r.log);
    const issues = [...lintIssues, ...buildIssues];
    return {
      ok: r.exitCode === 0 && binary !== null,
      binary,
      listing: "",
      symbols: r.map ?? "",
      log: r.log,
      issues,
      exitCode: r.exitCode,
      toolchain: "sdcc",
      stage: r.stage,
      failedTU: r.failedTU,        // which .c/.s file killed the build (if any)
      compiledOK: r.compiledOK,    // ordered list of TUs that DID compile
    };
  }

  throw new Error(
    `no bundled toolchain for platform '${args.platform}' yet. v1 supports: atari2600 (dasm), nes/c64/atari7800/lynx (cc65), snes (asar), genesis (vasm68k), gb/gbc (rgbds), sms/gg (sdcc).`,
  );
}

export { runDasm, buildC, buildAsm, runAsar, runVasm68k, buildGB };
