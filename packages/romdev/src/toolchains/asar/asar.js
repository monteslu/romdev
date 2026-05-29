// asar — bundled 65816 assembler (SNES).
//
// asar normally patches an existing ROM file. We give it an empty 32KB scratch
// ROM so the agent can author from scratch and asar fills it in via `org $XXXX`
// directives.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";

import { runIsolated, textFile, binaryFile, getOutputBytes, getOutputText } from "../_worker/run.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// asar's WASM ships in @romdev/platform-snes (the SNES platform is the only
// consumer). Resolve from that package; fall back to a local copy under src/
// if present (transition / dev). The package is a hard dep of romdev.
function resolveAsarGlue() {
  try {
    const u = import.meta.resolve("@romdev/platform-snes");
    const p = path.join(path.dirname(fileURLToPath(u)), "wasm", "asar.js");
    if (existsSync(p)) return p;
  } catch { /* package not resolvable — fall through to local */ }
  const local = path.join(__dirname, "wasm", "asar.js");
  if (existsSync(local)) return local;
  throw new Error("asar WASM not found — install @romdev/platform-snes");
}
// Lazy + memoized: resolve only on the first asar (SNES asm) build, not at boot.
let _gluePath;
const gluePath = () => (_gluePath ??= resolveAsarGlue());

/**
 * Assemble an asar source.
 * @param {Object} args
 * @param {string} args.source main source (asar `.asm`)
 * @param {Record<string, string>} [args.includes]
 * @param {Record<string, string|Uint8Array>} [args.binaryIncludes]
 * @param {string[]} [args.options]
 * @param {Uint8Array} [args.baseRom] optional base ROM to patch (defaults to empty 256KB)
 * @param {boolean} [args.flatBinary] strip sentinel padding (SPC700 mode)
 */
export async function runAsar(args) {
  const { source, flatBinary } = args;
  const includes = args.includes ?? {};
  const binaryIncludes = args.binaryIncludes ?? {};
  const opts = [...(args.options ?? [])];
  // If symbols requested, append asar's WLA-format symbol-file flags. We
  // read the .sym back out of MEMFS after the build.
  const wantSymbols = args.symbols !== false; // default ON
  if (wantSymbols && !opts.some((o) => o.startsWith("--symbols"))) {
    opts.push("--symbols=wla");
    opts.push("--symbols-path=/work/out.sym");
  }
  // Default base ROM is 256 KB (matches LoROM header byte $08 = 2^8 KB).
  // For flat-binary mode (SPC700, raw blobs), use a 64KB scratch filled
  // with a sentinel byte so we can detect which region asar actually wrote
  // to and trim the rest.
  const FLAT_SENTINEL = 0xAA;
  const baseRom = args.baseRom ?? (flatBinary
    ? new Uint8Array(64 * 1024).fill(FLAT_SENTINEL)
    : new Uint8Array(256 * 1024));

  // Preflight: catch known asar 1.x landmines that crash the assembler
  // silently (exits with a heap pointer, empty stderr). Better to surface
  // them as a wrapper-side error than to hand the user a useless exit code.
  const preflight = asarPreflight(source, { binaryIncludes, includes });
  if (preflight) {
    return { binary: null, log: preflight, exitCode: 1 };
  }

  const first = await assembleOnce({
    source, includes, binaryIncludes, baseRom, extraOpts: opts,
  });
  let { binary, log, exitCode } = first;

  // Silent-fail recovery. When asar throws a numeric value through Emscripten's
  // C++-exception path, that "number" is a heap pointer to the thrown object,
  // not an exit code — and we've lost the actual error message. Under
  // subprocess isolation the throw kills the worker entirely, and the pool
  // surfaces a synthetic `[crash]` log; treat that the same as the legacy
  // empty-log case so the verbose-retry path still runs.
  const isCrashLog = (s) => /^\s*\[crash\]/.test(s) || /^\s*\[worker\] Abort in WASM/.test(s);
  if (exitCode !== 0 && (log.trim() === "" || isCrashLog(log))) {
    // Re-run on a FRESH WASM module with --verbose so we surface the last
    // pass log asar emitted before the abort. Heap is corrupt after the
    // throw, so we cannot reuse the previous module. Cost: one extra cold
    // start (~50 ms) only on the crash path.
    let verboseLog = "";
    let verboseBinary = binary;
    try {
      const retry = await assembleOnce({
        source, includes, binaryIncludes, baseRom,
        extraOpts: [...opts, "--verbose"],
      });
      verboseLog = retry.log;
      if (retry.binary) verboseBinary = retry.binary;
    } catch (e) {
      verboseLog = `[verbose retry threw] ${e && e.message ? e.message : e}`;
    }

    const hex = "0x" + (exitCode >>> 0).toString(16).toUpperCase();
    const looksLikeHeapPointer = exitCode > 1024;
    const hint = looksLikeHeapPointer
      ? "Exit code looks like a heap pointer, not a real exit code — likely a C++ exception that escaped without writing to stderr. Common causes: bank-border-crossed, section overlap, ROM size exceeded, or out-of-memory while assembling."
      : "asar exited non-zero with no output.";

    const layoutText = formatLayout(summarizeWrittenRegions(verboseBinary, baseRom, { flatBinary }));

    log =
      `[asar wrapper] asar aborted with code ${exitCode} (${hex}); no diagnostic output captured.\n` +
      `[asar wrapper] argv: ${JSON.stringify(["--no-title-check", "/work/main.asm", "/work/rom.sfc", ...opts])}\n` +
      `[asar wrapper] hint: ${hint}\n` +
      (verboseLog.trim()
        ? `[asar wrapper] retry with --verbose:\n${verboseLog}\n`
        : `[asar wrapper] (verbose retry also produced no output)\n`) +
      (layoutText
        ? `[asar wrapper] partial ROM layout when asar died:\n${layoutText}\n`
        : "");
  }

  // Flat-binary mode: trim the sentinel-filled regions from both ends so
  // callers get just the bytes asar actually wrote. Pre-fill was $AA, so
  // the first and last non-$AA bytes mark the real boundaries of the
  // assembled blob. Also return the start address (file offset) so callers
  // can sanity-check it matches their `org`.
  let flatStartOffset = 0;
  if (flatBinary && binary) {
    let first = 0, last = binary.length - 1;
    while (first < binary.length && binary[first] === FLAT_SENTINEL) first++;
    while (last >= 0 && binary[last] === FLAT_SENTINEL) last--;
    if (first > last) {
      binary = new Uint8Array(0);
    } else {
      binary = binary.slice(first, last + 1);
      flatStartOffset = first;
    }
  }

  // On a successful SNES build, also return the layout summary so agents
  // can sanity-check that incbin'd data landed where they expected without
  // disassembling the ROM. Skip in flat-binary mode (no CPU mapping applies).
  let layout = null;
  if (exitCode === 0 && binary && !flatBinary) {
    layout = summarizeWrittenRegions(binary, baseRom, { flatBinary: false });
  }

  // Summarize binaryIncludes by name → byte length. The workaround for
  // asar's label-arith-across-banks bug requires the agent to hardcode
  // asset sizes; surface them here so they don't need a separate `stat`
  // call. Cheap — we already have the bytes in hand.
  const includesInfo = {};
  for (const [name, blob] of Object.entries(binaryIncludes)) {
    const size = blob instanceof Uint8Array ? blob.length : Buffer.from(blob, "base64").length;
    includesInfo[name] = { size };
  }

  // Try to read the symbol file that asar emitted, if any.
  let symbolsText = null;
  if (wantSymbols) {
    // The .sym lives in the same MEMFS we discarded with the WASM module
    // after the build, so we need to surface it from `first`'s collect step.
    // To keep the diff small, recover via the freshly-staged first.symbols.
    symbolsText = first.symbols ?? null;
  }

  return {
    binary,
    log,
    exitCode,
    flatStartOffset,
    layout,
    includes: includesInfo,
    symbols: symbolsText,
  };
}

// One assemble pass on a fresh WASM module. Returns { binary, log, exitCode }.
// Heap is single-use after a throw, so each retry must call this again with
// a different argv.
async function assembleOnce({ source, includes, binaryIncludes, baseRom, extraOpts }) {
  /** @type {import("../_worker/run.js").InputFile[]} */
  const inputFiles = [textFile("/work/main.asm", source), binaryFile("/work/rom.sfc", baseRom)];
  for (const [name, content] of Object.entries(includes)) {
    inputFiles.push(textFile("/work/" + name, content));
  }
  for (const [name, b64] of Object.entries(binaryIncludes)) {
    const bytes = b64 instanceof Uint8Array ? b64 : Buffer.from(b64, "base64");
    inputFiles.push(binaryFile("/work/" + name, bytes));
  }
  const argv = ["--no-title-check", ...extraOpts, "/work/main.asm", "/work/rom.sfc"];
  const r = await runIsolated({
    gluePath: gluePath(),
    argv,
    inputFiles,
    outputFiles: [
      { vfsPath: "/work/rom.sfc", encoding: "base64" },
      { vfsPath: "/work/out.sym", encoding: "utf8" },
    ],
  });
  return {
    binary: getOutputBytes(r, "/work/rom.sfc"),
    log: r.log,
    exitCode: r.exitCode,
    symbols: getOutputText(r, "/work/out.sym") || null,
    crash: r.crash,
  };
}

// Walk the ROM byte-for-byte vs the baseRom and emit contiguous runs where
// asar wrote something different. For LoROM, map file offsets to CPU
// addresses ($00:8000..$00:FFFF = file 0..$7FFF, $01:8000..$01:FFFF =
// file $8000..$FFFF, etc). Skip in flat-binary mode — sentinel-trim later
// handles that case and CPU addressing doesn't apply.
function summarizeWrittenRegions(binary, baseRom, { flatBinary }) {
  if (!binary || !baseRom || flatBinary) return null;
  const n = Math.min(binary.length, baseRom.length);
  const runs = [];
  let i = 0;
  // Allow small gaps of unchanged bytes inside a run so we don't emit a
  // hundred 1-byte regions when asar sparsely fills a header.
  const GAP_TOLERANCE = 16;
  while (i < n) {
    if (binary[i] !== baseRom[i]) {
      const start = i;
      let lastDiff = i;
      while (i < n && i - lastDiff <= GAP_TOLERANCE) {
        if (binary[i] !== baseRom[i]) lastDiff = i;
        i++;
      }
      runs.push({ fileStart: start, fileEnd: lastDiff });
    } else {
      i++;
    }
  }
  return runs;
}

function formatLayout(runs) {
  if (!runs) return "";
  if (runs.length === 0) {
    return "  (no bytes differ from base ROM — asar may have died before writing anything)";
  }
  return runs.map((r) => {
    const len = r.fileEnd - r.fileStart + 1;
    const cpu = lorom(r.fileStart, r.fileEnd);
    return `  file 0x${r.fileStart.toString(16).padStart(6, "0")}..0x${r.fileEnd.toString(16).padStart(6, "0")} ` +
           `(LoROM ${cpu}) — ${len} bytes`;
  }).join("\n");
}

function lorom(fileStart, fileEnd) {
  // LoROM: each 32 KB file chunk maps to $XX:8000..$XX:FFFF.
  const bankStart = (fileStart >>> 15) & 0xFF;
  const bankEnd = (fileEnd >>> 15) & 0xFF;
  const offStart = 0x8000 + (fileStart & 0x7FFF);
  const offEnd = 0x8000 + (fileEnd & 0x7FFF);
  const fmt = (b, o) => `$${b.toString(16).padStart(2, "0").toUpperCase()}:${o.toString(16).padStart(4, "0").toUpperCase()}`;
  if (bankStart === bankEnd) return `${fmt(bankStart, offStart)}..${fmt(bankEnd, offEnd)}`;
  return `${fmt(bankStart, offStart)}..${fmt(bankEnd, offEnd)} (spans banks)`;
}

function ensureDir(FS, dir) {
  const parts = dir.split("/").filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    try { FS.mkdir(cur); } catch {}
  }
}

// Static analyzer for known asar landmines. Runs before the WASM call so
// we can return a helpful error instead of letting asar abort silently.
// Returns null when source looks clean, or a string with the diagnostic.
function asarPreflight(source, { binaryIncludes = {}, includes = {} } = {}) {
  if (typeof source !== "string") return null;
  const lines = source.split("\n");
  const issues = [];

  // Strip a trailing line comment but keep string-literal contents.
  const stripComment = (s) => s.replace(/;.*$/, "");

  // -----------------------------------------------------------------------
  // Landmine 1: `STA SYMBOL + N` where SYMBOL was `=`-defined (not a label).
  // Verified-by-bisection in real homebrew. Plain `STA SYMBOL` works, plain
  // `STA $0401` works, but the operand-arithmetic form trips a parser bug
  // that exits asar with a heap-pointer exit code and no diagnostic.
  // -----------------------------------------------------------------------
  const opcodes = new Set([
    "STA", "LDA", "STZ", "LDX", "LDY", "STX", "STY",
    "CMP", "ADC", "SBC", "AND", "ORA", "EOR", "BIT",
    "INC", "DEC", "ASL", "LSR", "ROL", "ROR",
    "JMP", "JSR",
  ]);
  const operandArith = /^\s*([A-Z]{3})\s+([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*\d+/i;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const m = line.match(operandArith);
    if (!m) continue;
    const op = m[1].toUpperCase();
    if (!opcodes.has(op)) continue;
    issues.push(
      `[asar preflight] line ${i + 1}: '${m[0].trim()}' uses operand arithmetic ` +
      `(opcode + SYMBOL + N). asar 1.x crashes silently on this pattern when SYMBOL ` +
      `is an =-defined constant. Workaround: precompute the address as its own ` +
      `equ/= definition, or use a real label. Source line:\n  ${raw}`,
    );
  }

  // -----------------------------------------------------------------------
  // Collect `org $XXxxxx` directives once and use for bank-rewind detection
  // and the header-overlap check.
  //
  // Bank-rewind: scan all `org` bank bytes. If the bank goes UP and then
  // DOWN later in the file (e.g. $00 → $01 → $00), asar 1.x can corrupt
  // its bank-tracking and crash silently writing the rewound region.
  // Bisected to this exact configuration in the rom-games/snes/invaders
  // build session (devnote.md, 2026-05-23).
  // -----------------------------------------------------------------------
  const orgDirective = /^\s*org\s+\$([0-9A-Fa-f]+)\b/;
  const orgs = []; // { line, addr, bank }
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const m = line.match(orgDirective);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    if (!Number.isFinite(addr)) continue;
    const bank = (addr >>> 16) & 0xFF;
    orgs.push({ line: i + 1, addr, bank });
  }

  if (orgs.length >= 2) {
    let maxBankSeen = orgs[0].bank;
    let maxBankLine = orgs[0].line;
    for (let i = 1; i < orgs.length; i++) {
      const cur = orgs[i];
      if (cur.bank > maxBankSeen) {
        maxBankSeen = cur.bank;
        maxBankLine = cur.line;
      } else if (cur.bank < maxBankSeen) {
        const fmtAddr = (a) => "$" + a.toString(16).padStart(6, "0").toUpperCase();
        issues.push(
          `[asar preflight] line ${cur.line}: 'org ${fmtAddr(cur.addr)}' rewinds to bank ` +
          `$${cur.bank.toString(16).padStart(2, "0").toUpperCase()} after a previous ` +
          `'org' on line ${maxBankLine} reached bank ` +
          `$${maxBankSeen.toString(16).padStart(2, "0").toUpperCase()}. asar 1.x has a ` +
          `bank-tracking bug that crashes silently on this layout. Workaround: put the ` +
          `lower-bank directives (e.g. the LoROM header at $00FFC0) BEFORE any org that ` +
          `crosses into a higher bank.`,
        );
        break; // one warning is enough; the user will reorder once
      }
    }
  }

  // -----------------------------------------------------------------------
  // Header-overlap detection: if an `incbin "foo.bin"` lands in a 32 KB
  // bank window starting at $XX8000 and the file size would extend past
  // $XXFFC0 (16 KB of usable area before the LoROM header), warn the user
  // BEFORE asar happily clobbers the header during pass 2.
  //
  // We only check incbin's pointing at files in binaryIncludes (where we
  // know the size). We assume each incbin is preceded by an `org $XX8000`
  // and that the file fits or doesn't from that base.
  // -----------------------------------------------------------------------
  const incbinDirective = /^\s*incbin\s+"([^"]+)"/;
  // Walk top-to-bottom, tracking the most recent org as the "cursor".
  let cursor = null;
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const orgMatch = line.match(orgDirective);
    if (orgMatch) {
      cursor = parseInt(orgMatch[1], 16);
      continue;
    }
    const incMatch = line.match(incbinDirective);
    if (!incMatch || cursor === null) continue;
    const name = incMatch[1];
    const blob = binaryIncludes[name] ?? binaryIncludes[name.replace(/^\.\//, "")];
    if (blob === undefined) continue; // missing-include reported below
    const size = blob instanceof Uint8Array ? blob.length : Buffer.from(blob, "base64").length;
    const bank = (cursor >>> 16) & 0xFF;
    const off = cursor & 0xFFFF;
    const headerStart = 0xFFC0; // LoROM header lives at $XXFFC0..$XXFFFF
    if (off >= 0x8000 && off + size > headerStart) {
      const fmtAddr = (a) => "$" + a.toString(16).padStart(6, "0").toUpperCase();
      const endAddr = (bank << 16) | (off + size - 1);
      issues.push(
        `[asar preflight] line ${i + 1}: 'incbin "${name}"' (${size} bytes) starting at ` +
        `${fmtAddr(cursor)} would extend to ${fmtAddr(endAddr)}, overlapping the LoROM ` +
        `header at $${bank.toString(16).padStart(2, "0").toUpperCase()}FFC0. Move this data ` +
        `to a higher bank (e.g. 'org $018000') or shrink it below ${headerStart - off} bytes.`,
      );
    }
    // Advance cursor so consecutive incbins in the same bank stack.
    cursor += size;
  }

  // -----------------------------------------------------------------------
  // Landmine 5 (devnote.md 2026-05-23 round 2): `<opcode> #<symbol>` where
  // <symbol> is an `=`-defined label-arithmetic constant whose operand
  // labels live in DIFFERENT banks. asar 1.x crashes silently in pass 1
  // when this is used as an immediate (`#`); using the same constant as
  // a non-immediate operand is fine. Workaround: hardcode as a literal.
  //
  // Detection passes:
  //   A. Find `<name> = <expr>` definitions where <expr> references at
  //      least one identifier (label). Two forms matter:
  //         <label_a> - <label_b>
  //         <label_a> + <number>
  //   B. For each label referenced, find the bank it falls under by
  //      scanning preceding `org $XXyyyy` directives.
  //   C. If the labels in a single definition come from different banks
  //      (or one label is in a higher bank than the definition's own org
  //      cursor), mark the constant as cross-bank.
  //   D. Flag any `<opcode> #<name>` use of a cross-bank constant.
  // -----------------------------------------------------------------------
  const labelDef = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/; // bare label line
  const equDef = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/; // name = expr
  /** @type {Map<string, number>} bank-byte per label identifier */
  const labelBanks = new Map();
  /** @type {Map<string, Set<number>>} per label-arith constant, the set of banks its operand labels live in */
  const labelArithConstants = new Map();
  // Pass over the source tracking the current bank cursor as we go and
  // recording bank of each declared label.
  {
    let bankCursor = null;
    for (let i = 0; i < lines.length; i++) {
      const line = stripComment(lines[i]);
      if (!line.trim()) continue;
      const orgM = line.match(orgDirective);
      if (orgM) {
        const addr = parseInt(orgM[1], 16);
        if (Number.isFinite(addr)) bankCursor = (addr >>> 16) & 0xFF;
        continue;
      }
      const lblM = line.match(labelDef);
      if (lblM && bankCursor !== null) {
        labelBanks.set(lblM[1], bankCursor);
      }
    }
  }
  // Now scan for `name = expr` lines that reference labels we just mapped.
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const m = line.match(equDef);
    if (!m) continue;
    const name = m[1];
    const expr = m[2].trim();
    // Skip if this is actually an opcode like `STA = something` (asar isn't
    // ambiguous like that, but be defensive).
    if (opcodes.has(name.toUpperCase())) continue;
    const idents = (expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      .filter((id) => labelBanks.has(id));
    if (idents.length === 0) continue;
    const banks = new Set(idents.map((id) => labelBanks.get(id)));
    labelArithConstants.set(name, banks);
  }
  // Flag any `<opcode> #<symbol>` immediate use where the symbol is a
  // label-arith constant whose operand labels live in a DIFFERENT bank
  // from the use site. (Same-bank uses appear safe in our bisection.)
  const immediateUse = /^\s*([A-Za-z]{3})\s+#([A-Za-z_][A-Za-z0-9_]*)\b/;
  {
    let bankCursor = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = stripComment(raw);
      const orgM = line.match(orgDirective);
      if (orgM) {
        const addr = parseInt(orgM[1], 16);
        if (Number.isFinite(addr)) bankCursor = (addr >>> 16) & 0xFF;
        continue;
      }
      const m = line.match(immediateUse);
      if (!m) continue;
      const op = m[1].toUpperCase();
      const sym = m[2];
      if (!opcodes.has(op)) continue;
      const operandBanks = labelArithConstants.get(sym);
      if (!operandBanks) continue;
      // Crash trigger: operand labels are in a bank that differs from the
      // use-site bank (OR operand labels themselves span multiple banks).
      const useBank = bankCursor;
      const crossesBoundary =
        operandBanks.size > 1 ||
        (useBank !== null && !operandBanks.has(useBank));
      if (!crossesBoundary) continue;
      issues.push(
        `[asar preflight] line ${i + 1}: '${op} #${sym}' references a label-arithmetic ` +
        `constant whose operand labels span different banks from the use site. asar 1.x ` +
        `crashes silently (heap-pointer exit code, no diagnostic) on this pattern. ` +
        `Workaround: replace the '${sym} = <label_a> - <label_b>' definition with a ` +
        `hardcoded literal, e.g. '${sym} = <known_size>'. Source line:\n  ${raw}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Missing-include detection: an `incbin "foo.bin"` whose path isn't in
  // binaryIncludes (or includes) will cause asar to fail mid-pass with a
  // confusing error. Catch it up front.
  //
  // (Same for `incsrc "foo.asm"` against the text includes map.)
  // -----------------------------------------------------------------------
  const haveBinary = new Set(Object.keys(binaryIncludes));
  const haveText = new Set(Object.keys(includes));
  const incsrcDirective = /^\s*incsrc\s+"([^"]+)"/;
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    const bin = line.match(incbinDirective);
    if (bin) {
      const name = bin[1];
      const normalized = name.replace(/^\.\//, "");
      if (!haveBinary.has(name) && !haveBinary.has(normalized)) {
        const avail = [...haveBinary].join(", ") || "(none)";
        issues.push(
          `[asar preflight] line ${i + 1}: 'incbin "${name}"' references a file not ` +
          `present in binaryIncludes. asar will fail mid-pass with a confusing error. ` +
          `Available binaryIncludes: ${avail}.`,
        );
      }
    }
    const src = line.match(incsrcDirective);
    if (src) {
      const name = src[1];
      const normalized = name.replace(/^\.\//, "");
      if (!haveText.has(name) && !haveText.has(normalized)) {
        const avail = [...haveText].join(", ") || "(none)";
        issues.push(
          `[asar preflight] line ${i + 1}: 'incsrc "${name}"' references a file not ` +
          `present in includes. Available includes: ${avail}.`,
        );
      }
    }
  }

  if (issues.length) {
    return "error: asar preflight rejected source\n" + issues.join("\n");
  }
  return null;
}
