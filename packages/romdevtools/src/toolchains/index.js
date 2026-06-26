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
  pce: "pce",
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
    basic:  { toolchain: "batariBasic",  available: false, note: "BASIC for 2600 via batariBasic — not bundled. bB's transpiler is written in Perl, which we don't ship as WASM. A port to C or JS would be a multi-day project. For now, write 2600 games in 6507 asm via dasm — the bundled example games (default, paddle, single_screen) show the canonical race-the-beam pattern, and an LLM agent writes 2600 asm fluently." },
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
    c:   { toolchain: "tcc816+wladx", available: true, note: "C for SNES via tcc-65816 + wla-65816 + wlalink. The PVSnesLib runtime IS bundled (built from source) and auto-linked — #include <snes.h> gives you consoleDrawText, setMode, oamSet, WaitForVBlank, etc. out of the box. `examples({op:'fork'})` gives you a complete working PVSnesLib C project. Pass options.pvsneslib:false for the bare-main minimum-viable path." },
  },
  genesis: {
    asm: { toolchain: "vasm68k",      available: true },
    c:   { toolchain: "m68k-elf-gcc", available: true, note: "C for Genesis via gcc 14.2.0 + binutils + newlib, all compiled to WASM. The SGDK runtime IS bundled (built from source) and auto-linked — sprite engine, VDP, controller, PSG/Z80 sound, resource helpers all work; #include <genesis.h>. `examples({op:'fork'})` gives you a complete working SGDK C project (the recommended path). Pass options.sgdk:false for the bare-gcc minimum-viable path." },
  },
  gba: {
    c: { toolchain: "arm-none-eabi-gcc", available: true, note: "C for GBA via gcc 14.2.0 + binutils + newlib + libtonc 1.4.5 (default) OR libgba 0.5.4 (opt-in via runtime:\"libgba\"), all compiled to WASM (R24 + R28). #include <tonc.h> + tte_write/tte_printf works out of the box — that's the canonical Tonc-tutorial API every published GBA C resource uses. Caveat: tte_iohook (libtonc) and console.c (libgba) — the libsysbase-backed iprintf bridges — are NOT bundled. Use tte_printf directly, which is what the Tonc tutorial actually does." },
  },
  sms:    { c: { toolchain: "sdcc", available: true }, asm: { toolchain: "sdcc", available: true } },
  gg:     { c: { toolchain: "sdcc", available: true }, asm: { toolchain: "sdcc", available: true } },
  spc700: { asm: { toolchain: "asar", available: true } },
  pce: {
    c:   { toolchain: "cc65", available: true, note: "C for PC Engine via cc65's huc6280 target — crt0 + pce.lib (VDC/VCE/PSG/joypad helpers) auto-linked. #include <pce.h>." },
    asm: { toolchain: "cc65", available: true },
  },
  msx: {
    c:   { toolchain: "sdcc", available: true, note: "C for MSX via SDCC's z80 port. Cartridge ROM with the 'AB' header + INIT pointer at $4000; boots on C-BIOS (open MSX BIOS). MSX2 by default (runs MSX1 carts too)." },
    asm: { toolchain: "sdcc", available: true },
  },
  ps1: {
    c: { toolchain: "mips-elf-gcc", available: true, note: "C for PS1 via gcc 14.2.0 + binutils + newlib (mips-elf, little-endian R3000), compiled to WASM. The bare path: a minimal crt0 sets the stack + clears .bss + calls main(); the output is a PS-EXE the HLE BIOS loads (load at 0x80010000). No SDK (PSn00bSDK) yet — bring your own GPU/SPU register writes, or use this for logic. write to GPU ports 0x1F801810/0x1F801814." },
  },
  n64: {
    c: { toolchain: "mips-elf-gcc", available: true, note: "C for N64 via gcc 14.2.0 + binutils + newlib (mips-elf, big-endian R4300), compiled to WASM. Bare path: minimal crt0 (stack + .bss + main()) → flat code image at 0x80000400. NOTE: a fully bootable N64 ROM needs the IPL3 bootcode + a libdragon-style header (libdragon SDK forthcoming) — this path exercises the toolchain + is the basis for the SDK." },
  },
  dreamcast: {
    c: { toolchain: "sh-elf-gcc", available: true, note: "C for Dreamcast via gcc 14.2.0 + binutils + newlib (sh-elf, little-endian SH-4, m4-single-only FP), compiled to WASM. Bare path: a minimal crt0 sets the stack + clears .bss + calls main(); the output is an ELF that Flycast's reios HLE BIOS boots DIRECTLY (no GD-ROM/CDI image, no firmware). No KallistiOS yet — bring up the PowerVR2 framebuffer yourself: program FB_R_CTRL/FB_R_SIZE/FB_R_SOF1 + SPG for 640x480 RGB565 at VRAM 0xA5000000, then write pixels (see the dc.h helper). With flycast_emulate_framebuffer on, a plain pixel-writing program presents — no TA list needed." },
  },
};

/**
 * Default language per platform. The choice reflects what's fastest /
 * smallest / best-matched to LLM fluency. Every platform that has a bundled
 * C compiler + runtime defaults to C — that's the canonical, productive path
 * and what `examples({op:'fork'})` projects use (cc65 for NES/C64/Atari7800/
 * Lynx, SDCC for GB/GBC/SMS/GG, gcc+SGDK for Genesis, tcc+PVSnesLib for SNES,
 * gcc+libtonc for GBA). Platforms whose only bundled toolchain is an assembler
 * default to asm (Atari 2600 → dasm; SNES/Genesis keep an asm option too, but
 * C is now the default since the SDKs are bundled from source).
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
  snes:       "c",
  genesis:    "c",
  gba:        "c",
  sms:        "c",
  gg:         "c",
  spc700:     "asm",
  pce:        "c",
  msx:        "c",
  ps1:        "c",
  n64:        "c",
  dreamcast:  "c",
};

/**
 * Order build issues by DANGER so the agent reads the lethal ones first:
 *   critical (crash-class, e.g. the uint8 infinite-loop)  →  error  →  warning  →  info.
 * Stable within a rank (preserves source order / file:line). Pure; no dedup.
 * @param {Array<{severity?:string, critical?:boolean}>} issues
 * @returns {Array} the same issues, ranked
 */
export function rankIssues(issues) {
  const rank = (i) =>
    i?.critical ? 0
    : i?.severity === "error" ? 1
    : i?.severity === "warning" ? 2
    : 3;
  // map→sort→unmap keeps it stable (Array.prototype.sort is stable in V8, but
  // tie-break on original index to be explicit and portable).
  return issues
    .map((issue, idx) => ({ issue, idx }))
    .sort((a, b) => rank(a.issue) - rank(b.issue) || a.idx - b.idx)
    .map((x) => x.issue);
}

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
  msx:        32 * 1024,  // 32KB MSX cartridge ($4000-$BFFF, 2 pages)
};

// MSX cartridge ROMs map into the $4000-$BFFF region and begin with a 16-byte
// ROM header at $4000: "AB" magic + an INIT routine pointer (the BIOS calls it
// at boot). The code therefore links at $4010 (right after the header). We
// build the SDCC image based at $4000 then strip the linker's $0000-$3FFF
// padding so the .rom starts at the header.
const MSX_CODE_LOC = 0x4010;
const MSX_ROM_BASE = 0x4000;

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
/**
 * Decide which language a build should use when the caller didn't pass one.
 * Explicit `language` always wins. Otherwise we infer ONLY from a POSITIVE
 * signal — a C filename (`sources` key ending .c/.h/.cpp) or unambiguous C
 * content (`#include`, a `/* *​/` block comment, `int/void main(`) ⇒ "c"; an
 * asm filename or a clear asm tell (leading `;` comment, `.org`/`dc.x`/`equ`/
 * `arch` directives, `$`-hex with no C tokens) ⇒ "asm". When nothing points
 * either way we return `undefined` and leave the historical dispatch alone
 * (which falls to the platform's first/asm toolchain) — so this is a strict
 * IMPROVEMENT, never a behavior change for inputs that already worked.
 *
 * This fixes the genesis foot-gun: `runSource({platform:"genesis", source:
 * cCode})` with no `language` used to assemble C as 68k via vasm68k; the C
 * content tell now routes it to m68k-elf-gcc + SGDK (the advertised default).
 * Only relevant for platforms with BOTH a C and an asm toolchain producing
 * different binaries (genesis, gba, gb/gbc, snes); cc65/sdcc platforms route
 * by extension further down regardless.
 *
 * @param {{platform:string, language?:string, source?:string, sources?:Record<string,string>}} args
 * @returns {string | undefined} the resolved language, or undefined to leave
 *   the existing dispatch untouched (no positive signal / no language matrix)
 */
function resolveEffectiveLanguage(args) {
  if (args.language) return args.language;
  const langs = LANGUAGE_TOOLCHAIN[args.platform];
  if (!langs) return undefined;

  // 1) Filenames are the strongest signal. `sourceName` (single-file, threaded
  //    from sourcePath's basename or the synthetic name) and the `sources` keys.
  const names = [
    ...(args.sourceName ? [args.sourceName] : []),
    ...(args.sources ? Object.keys(args.sources) : []),
  ];
  if (names.some((n) => /\.(c|h|cpp|cc|cxx)$/i.test(n))) return langs.c?.available ? "c" : undefined;
  if (names.length && names.every((n) => /\.(s|asm)$/i.test(n))) return langs.asm?.available ? "asm" : undefined;

  // 2) Single-source content sniff — a LAST resort when no filename is known.
  //    Require an unambiguous C tell that can't appear in an asm `;` comment.
  //    (We deliberately do NOT trust a `/* */` block — asm doc-comments embed
  //    them as prose, e.g. "buildSource({ source: /* this file */ })".) A C
  //    preprocessor directive must be the first non-space on its line, which a
  //    `;`-commented asm line never satisfies.
  const body = args.source || "";
  if (!body) return undefined;
  const cTell = /^[ \t]*#[ \t]*(include|define|ifdef|ifndef|pragma)\b/m.test(body) ||
                /^[ \t]*(?:int|void)\s+main\s*\(/m.test(body);
  if (cTell && langs.c?.available) return "c";
  // No clear signal → leave the historical default alone (asm-first dispatch).
  return undefined;
}

/**
 * Heuristic "is this C source?" for error messaging only (not dispatch). Looser
 * than the dispatch sniff on purpose: here we WANT to catch a C file that ended
 * up at an assembler so we can tell the agent to pass language:"c". Used to
 * annotate a failed vasm68k/asm build with the real fix.
 * @param {string} [src]
 */
function looksLikeCSource(src) {
  if (!src) return false;
  return /^[ \t]*#[ \t]*(include|define|ifdef|ifndef|pragma)\b/m.test(src) ||
         /^[ \t]*(?:int|void|char|short|long|unsigned|static|const)\b.*\b\w+\s*\(/m.test(src) ||
         /\b(?:int|void)\s+main\s*\(/.test(src) ||
         (/\/\*[\s\S]*?\*\//.test(src) && /[;{}]\s*$/m.test(src) && !/^\s*;/m.test(src));
}

export async function buildForPlatform(args) {
  // Resolve an omitted language from source filenames/content when there's a
  // clear signal. Without this, genesis/gba/etc. silently fell to their FIRST
  // (asm) toolchain instead of `defaultLanguage` — so a bare
  // `runSource({platform:"genesis", source:cCode})` assembled C as 68k.
  args = { ...args, language: resolveEffectiveLanguage(args) };

  // ---- language axis: validate before dispatching to toolchain ----
  // When specified, we check that the (platform, language) pair is supported
  // AND available; reject with a structured error if not. (When still omitted
  // — no positive signal — the per-platform dispatch below applies its own
  // historical default.)
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

  if (args.platform === "ps1" || args.platform === "n64") {
    // MIPS C: the bare gcc+newlib+libgcc path (no SDK yet). cc1→as→ld→objcopy
    // through the mips-elf-gcc WASM toolchain; PS1 (R3000, little-endian) wraps the
    // image in a PS-EXE the HLE BIOS loads; N64 (R4300, big-endian) emits a flat
    // .bin (real N64 boot needs libdragon — forthcoming). language defaults to "c".
    const { buildMipsC } = await import("./mips-c/mips-c.js");
    const r = await buildMipsC({
      source: args.source,
      sources: args.sources,
      headers: args.includes,
      platform: args.platform,
      cc1Options: args.options,
    });
    return {
      ok: r.ok,
      binary: r.binary,
      listing: "",
      symbols: r.symbols ?? "",
      log: r.log,
      issues: parseBuildLog(r.log),
      exitCode: r.exitCode,
      toolchain: "mips-elf-gcc",
      stage: r.stage,
      ...(r.crash ? { crash: r.crash } : {}),
    };
  }

  if (args.platform === "dreamcast") {
    // Dreamcast SH-4 C: the bare gcc+newlib+libgcc path through the sh-elf-gcc WASM
    // toolchain (cc1→as→ld). The output is an ELF that Flycast's reios HLE BIOS boots
    // directly (no GD-ROM/CDI image). Bring up the PowerVR2 framebuffer yourself (see
    // the dc.h helper); language defaults to "c".
    const { buildShC } = await import("./sh-c/sh-c.js");
    const r = await buildShC({
      source: args.source,
      sources: args.sources,
      headers: args.includes,
      cc1Options: args.options,
    });
    return {
      ok: r.ok,
      binary: r.binary,
      listing: "",
      symbols: r.symbols ?? "",
      log: r.log,
      issues: parseBuildLog(r.log),
      exitCode: r.exitCode,
      toolchain: "sh-elf-gcc",
      stage: r.stage,
      ...(r.crash ? { crash: r.crash } : {}),
    };
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
        rebuildSdk: args.rebuildSdk, // compile SDK from source vs seed
      });
      return {
        ok: r.ok,
        binary: r.binary,
        listing: "",
        // GNU ld map (name→address) so symbols({op:'resolve'/...}) works on GBA
        // too — same as Genesis/m68k. buildGbaC returns it from runArmLd.
        symbols: r.symbols ?? "",
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
        rebuildSdk: args.rebuildSdk, // compile SGDK from source vs seed
      });
      return {
        ok: r.ok,
        // Finalize like SGDK's makefile (pad to 128KB boundary, min 512KB,
        // fix the $18E checksum) so the ROM loads on strict cores
        // (RetroArch Genesis Plus GX / BlastEm) and flashcarts.
        binary: r.ok && r.binary ? finalizeGenesisRom(r.binary) : r.binary,
        listing: "",
        // The m68k-elf-ld map (symbol → final address) when the link produced
        // one — used by buildSourceWithDebug / addressToSymbol for Genesis.
        symbols: r.symbols ?? "",
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
    // If vasm68k FAILED on what is obviously C source, say so — don't let the
    // agent read "missing reset vector / identifier expected" and conclude
    // "Genesis wants hand-written asm." (Belt-and-suspenders: the language
    // resolver above already routes C to gcc; this only fires if someone forced
    // language:"asm" on a C file, or an exotic C file dodged every tell.)
    let log = r.log;
    if (!vasmOk && looksLikeCSource(source)) {
      log = "[romdev] This source looks like C but was assembled as 68000 by vasm68k, " +
        "which is why you're seeing 'identifier expected' / 'missing reset vector'. " +
        "Genesis C builds through m68k-elf-gcc + SGDK — pass language:\"c\" (or give the " +
        "file a .c name). You do NOT need to write 68k assembly.\n\n" + r.log;
    }
    return {
      ok: vasmOk,
      // Same SGDK-style finalize (pad + $18E checksum) for hand-written
      // asm ROMs — they hit the exact same strict-core load failure.
      binary: vasmOk && r.binary ? finalizeGenesisRom(r.binary) : r.binary,
      listing: "",
      symbols: "",
      log,
      issues: parseBuildLog(log),
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
    // MSX: _CODE goes at $4010 — a cartridge maps at $4000-$BFFF and the first
    // 16 bytes are the ROM header ("AB" + INIT vector) the crt0 emits.
    // SMS/GG: _CODE goes at $0100 — $0000-$00FF belongs to the crt0's ABS
    // _HEADER area (reset + RST/IRQ/NMI vectors + _boot). The old default of
    // $0000 linked _CODE ON TOP of the vector table: makebin emitted gsinit
    // at $0000 and the di/im 1/SP-init/ISR vectors were GONE — it booted in a
    // BIOS-less emulator by accident (gsinit happened to sit at the reset
    // vector) but had no working IRQ/NMI/pause handling and was one EI away
    // from jumping into garbage on real hardware.
    const codeLoc = args.codeLoc ?? (
      args.platform === "msx" ? MSX_CODE_LOC
      : (args.platform === "sms" || args.platform === "gg") ? 0x0100
      : 0x0000);
    const romSize = SDCC_ROM_SIZE[args.platform] ?? 32 * 1024;

    // crt0 + headers + sources come straight from the caller. The build
    // pipeline does NOT auto-inject platform runtimes, custom crt0s,
    // or post-link header patches. Every byte that compiles is visible
    // to the caller's repo. Use `examples({op:'fork'})` to get a
    // self-contained project with the runtime files copied in, or
    // `examples({op:'snippets'/'copySnippets'})` to fetch individual pieces.
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
      // MSX cartridges map at $4000 — produce a $4000-based page image so the
      // "AB" header lands at offset 0 (not offset $4000 of a $0000-based image).
      romBase: args.platform === "msx" ? MSX_ROM_BASE : undefined,
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
      // (no mapper), -r 0x00 = no cart RAM — correct for plain 32KB builds.
      //
      // Battery-cart passthrough (0.29.0 examples): a crt0 may DECLARE the
      // cart in the header window (the GB equivalent of the NES crt0's iNES
      // BATTERY bit — see the gbc lib gb_crt0.s, which emits $0147=$03 /
      // $0149=$02 for MBC1+RAM+BATTERY so hi-scores persist in SAVE_RAM).
      // If the linked image carries a KNOWN battery-MBC type byte with a
      // sane RAM size, pass those through to rgbfix instead of stomping
      // them to ROM-only; anything unrecognized (linker pad garbage) still
      // falls back to the safe ROM-only default, so crt0s that don't
      // declare a cart behave exactly as before.
      const BATTERY_CART_TYPES = new Set([0x03, 0x06, 0x0F, 0x10, 0x13, 0x1B, 0x1E]); // MBC1/2/3/5 +BATTERY variants
      const declType = binary.length > 0x149 ? binary[0x147] : 0x00;
      const declRam = binary.length > 0x149 ? binary[0x149] : 0x00;
      const cartByte = BATTERY_CART_TYPES.has(declType) ? declType : 0x00;
      const ramByte = cartByte !== 0x00 && declRam >= 0x01 && declRam <= 0x05 ? declRam : 0x00;
      const mArg = "0x" + cartByte.toString(16).padStart(2, "0").toUpperCase();
      const rArg = "0x" + ramByte.toString(16).padStart(2, "0").toUpperCase();
      const fixOpts = args.platform === "gbc"
        ? ["-v", "-p", "0xFF", "-C", "-m", mArg, "-r", rArg]
        : ["-v", "-p", "0xFF", "-m", mArg, "-r", rArg];
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
    if (binary && r.exitCode === 0 && (args.platform === "sms" || args.platform === "gg")) {
      // Pad to a full 32KB bank FIRST. sdld emits up to the highest used
      // address, so a small program can come out under $8000 — which (a)
      // skipped this whole header block before (the header guard required
      // 32KB) and (b) odd-size ROMs misbehave on real mappers/flashcarts.
      if (binary.length < 0x8000) {
        const padded = new Uint8Array(0x8000);
        padded.set(binary);
        binary = padded;
      }
      const hdr = 0x7FF0;
      const hasHeader = String.fromCharCode(...binary.slice(hdr, hdr + 8)) === "TMR SEGA";
      // Region nibble is PLATFORM-SPECIFIC and load-bearing: 4 = SMS export,
      // 7 = GG international. A .gg ROM stamped with an SMS region (3/4) makes
      // Genesis Plus GX (RetroArch/RetroDECK's SMS+GG core) boot it in "GG
      // running SMS software" COMPATIBILITY mode — wrong video mode + wrong
      // CRAM format for a native-GG program → black/garbled screen on the
      // user's device while our BIOS-less host looked fine. Size nibble $C =
      // 32KB checksum range ($0000-$7FEF).
      const regionSize = args.platform === "gg" ? 0x7C : 0x4C;
      if (!hasHeader) {
        // No header emitted by the crt0 → write a complete TMR SEGA header
        // into the last 16 bytes of bank 0 ($7FF0-$7FFF). Without this the
        // export (US/EU) SMS BIOS shows "SOFTWARE ERROR" and refuses to run.
        // $7FF0-$7FF7 "TMR SEGA"; $7FF8-$7FF9 reserved ($00); $7FFA-$7FFB
        // checksum (filled below); $7FFC-$7FFE product code/version (zeros
        // ok for homebrew); $7FFF region+size (see regionSize above).
        const TMR = [0x54,0x4D,0x52,0x20,0x53,0x45,0x47,0x41]; // "TMR SEGA"
        for (let i = 0; i < 8; i++) binary[hdr + i] = TMR[i];
        binary[hdr + 8] = 0x00; binary[hdr + 9] = 0x00;   // reserved
        binary[hdr + 12] = 0x00; binary[hdr + 13] = 0x00; // product code lo
        binary[hdr + 14] = 0x00;                          // product/version
      }
      // Always stamp the platform-correct region/size — a crt0-provided header
      // with an SMS region on a .gg build has the same compat-mode problem.
      binary[hdr + 15] = regionSize;
      // Checksum = sum of bytes $0000..$7FEF (everything before the header),
      // stored little-endian at $7FFA. Size nibble $C declares the 32KB
      // range, so the BIOS checksums $0000-$7FEF. (The GG BIOS doesn't
      // checksum, but writing it is harmless and correct.)
      let sum = 0;
      for (let i = 0; i < 0x7FF0; i++) sum = (sum + binary[i]) & 0xFFFF;
      binary[0x7FFA] = sum & 0xFF;
      binary[0x7FFB] = (sum >> 8) & 0xFF;
      r.log += `\n--- ${args.platform.toUpperCase()} header ${hasHeader ? "checksum fixed" : "written + checksummed"} ($7FFA=${sum.toString(16).toUpperCase().padStart(4,"0")}, region/size=$${regionSize.toString(16).toUpperCase()}) ---`;
    }
    // MSX: the binary built with codeLoc=$4010 is a $4000-based page image.
    // SDCC/sdldz80 emit an ihx that, converted to bin, starts at the lowest
    // used address. Ensure the output is exactly the $4000-$BFFF cartridge image
    // and that the first 16 bytes are a valid ROM header ("AB" + INIT pointer).
    // The crt0 (msx_crt0.s) normally writes the header; if a bare build skipped
    // it, synthesize a minimal one pointing INIT at $4010.
    if (binary && r.exitCode === 0 && args.platform === "msx") {
      if (!(binary[0] === 0x41 && binary[1] === 0x42)) { // not "AB"
        // Synthesize: "AB", INIT=$4010 (LE), STATEMENT/DEVICE/TEXT = 0.
        const hdr = new Uint8Array(16);
        hdr[0] = 0x41; hdr[1] = 0x42;            // "AB"
        hdr[2] = MSX_CODE_LOC & 0xFF;            // INIT lo
        hdr[3] = (MSX_CODE_LOC >> 8) & 0xFF;     // INIT hi
        // bytes 4-15 (STATEMENT/DEVICE/TEXT/reserved) stay zero.
        binary.set(hdr, 0);
        r.log += "\n--- MSX ROM header synthesized (\"AB\" + INIT=$4010) ---";
      } else {
        r.log += "\n--- MSX ROM header present (\"AB\") ---";
      }
    }
    // Combine lint warnings with parsed build log, then RANK so an agent
    // triaging issues[] sees the dangerous ones first: crash-class (critical)
    // → errors → plain warnings. Without this, a "WILL HANG" infinite-loop
    // warning sits among unused-variable noise and gets skipped (the exact
    // "agent missed the warning, hit the crash 100 functions later" failure).
    const buildIssues = parseBuildLog(r.log);
    const issues = rankIssues([...lintIssues, ...buildIssues]);
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
    `no bundled toolchain for platform '${args.platform}'. Supported: atari2600 (dasm), nes/c64/atari7800/lynx (cc65), snes (C via tcc-65816+wla+PVSnesLib, or asm via asar), genesis (C via m68k-gcc+SGDK, or asm via vasm68k), gba (C via arm-gcc+libtonc/libgba), gb/gbc (sdcc sm83 / rgbds), sms/gg (sdcc). Call listPlatforms for the live matrix.`,
  );
}

export { runDasm, buildC, buildAsm, runAsar, runVasm68k, buildGB };
