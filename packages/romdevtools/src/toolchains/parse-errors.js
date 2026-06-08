// Parse toolchain logs into a uniform structured-error shape.
//
// Each toolchain has its own format. Agents can match against `severity`,
// `file`, `line` without grepping the raw log.
//
// Output shape:
//   { file, line, col?, severity: "error" | "warning" | "info", message, stage }

/**
 * @typedef {Object} BuildIssue
 * @property {string} severity  "error" | "warning" | "info"
 * @property {string} message
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [col]
 * @property {string} stage  e.g. "cc65", "ca65", "ld65", "dasm", "asar"
 */

/**
 * Parse a combined toolchain log. Tries each known parser and returns issues.
 * @param {string} log
 * @returns {BuildIssue[]}
 */
export function parseBuildLog(log) {
  const issues = [];
  if (!log) return issues;
  // The log is typically composed of stages separated by `--- <stage> ---`.
  const stages = splitByStage(log);
  for (const { stage, text } of stages) {
    // Normalize the stage name. SDCC emits markers like "sdcc (main.c)" and
    // "sdcc --c1mode" — strip parens/args so we can pattern-match the bare tool.
    const baseStage = stage.split(/\s|\(/)[0].toLowerCase();
    if (/^cc65$|^ca65$|^ld65$/.test(baseStage)) {
      issues.push(...parseCc65Like(text, baseStage));
      // ld65's linker-level errors (segment-missing / memory-overflow) carry no
      // file:line and slip past parseCc65Like — pick them up too.
      if (baseStage === "ld65") issues.push(...parseLd65Linker(text, baseStage));
    } else if (/^dasm$/.test(baseStage)) {
      issues.push(...parseDasm(text));
    } else if (/^asar$/.test(baseStage)) {
      issues.push(...parseAsar(text));
    } else if (/^rgbasm$|^rgblink$|^rgbfix$/.test(baseStage)) {
      issues.push(...parseRgbds(text, baseStage));
    } else if (/^vasm/.test(baseStage)) {
      issues.push(...parseVasm(text));
    } else if (/^sdcc$|^sdasz80$|^sdasgb$|^sdld$|^mcpp$/.test(baseStage)) {
      // SDCC family: sdcc / sdasz80 / sdasgb / sdld / mcpp. Some diagnostics use
      // the cc65-style `file:line: Error: msg`; SDCC's frontend ALSO emits a
      // keyword-less form — `main.c:2: syntax error: token -> ';' ; column 44`
      // and `main.c:N: warning NNN: msg` — which parseCc65Like misses. Run both.
      issues.push(...parseCc65Like(text, baseStage));
      issues.push(...parseSdcc(text, baseStage));
    } else if (/^wla|^wlalink|^wladx/.test(baseStage)) {
      // SNES C path: wla-65816 assembler + wlalink linker. wlalink floods a
      // symbol-table dump on failure — parseWla extracts just the diagnostics.
      issues.push(...parseWla(text, baseStage));
    } else if (/^gcc$|^cc1$|^as$|^ld$|^m68k$|^objcopy$/.test(baseStage)) {
      // Genesis/GBA C path: GNU m68k/arm toolchain. ld emits "multiple
      // definition" / "undefined reference" that the cc65 parser misses;
      // parseGnuLd extracts them and adds Genesis-specific guidance for the
      // classic rom_header collision.
      issues.push(...parseGnuToolchain(text, baseStage));
    } else {
      // Unknown stage — try every parser, accept anything that yields hits.
      // Tag everything with the (possibly empty) actual stage name so an
      // assembler error doesn't mistakenly report as "asar" on a non-SNES
      // build.
      // Try EVERY parser — some toolchains (vasm genesis-asm) emit no
      // "--- stage ---" marker, so the whole log lands here unnamed; if we skip
      // a parser the error is silently swallowed (issues[] empty on a real
      // failure). Include vasm + sdcc + wla, which the old fallback omitted.
      const tag = baseStage || "unknown";
      issues.push(...parseCc65Like(text, tag));
      issues.push(...parseLd65Linker(text, tag));
      issues.push(...parseSdcc(text, tag));
      issues.push(...parseDasm(text));
      issues.push(...parseAsar(text, tag));
      issues.push(...parseRgbds(text, tag));
      issues.push(...parseVasm(text));
      issues.push(...parseWla(text, tag));
      issues.push(...parseGnuToolchain(text, tag));
    }
  }
  return issues;
}

// The tool names our dispatchers emit as "--- <tool> ---" stage markers.
// Matching only these prevents a TOOL's OWN "--- SECTIONS ---" / "------"
// banners (wlalink prints a 26k-line dump full of them) from being mistaken
// for our markers and splitting the real error away from its stage.
const KNOWN_STAGE_RE =
  /^(cc65|ca65|ld65|dasm|asar|rgbasm|rgblink|rgbfix|vasm|sdcc|sdasz80|sdasgb|sdld|mcpp|tcc-65816|wla-65816|wla|wlalink|wladx|gcc|cc1|as|ld|objcopy|m68k|sjasm|bintos|tcc)\b/i;

function splitByStage(log) {
  // Markers like "--- ca65 ---" OR with parenthesized args like
  // "--- wla-65816 (main.c → .obj) ---" / "--- tcc-65816 (main.c) ---"
  // produced by our build dispatchers. Capture the leading tool token; ignore
  // any "(...)" detail and trailing dashes so the stage name is just the tool.
  const stages = [];
  const re = /^---\s*([^\s(-][^\s(]*).*?---$/gm;
  let cursor = 0;
  let currentStage = "build";
  let m;
  while ((m = re.exec(log))) {
    // Only OUR known tool markers split the log; a tool's internal banner
    // (e.g. wlalink's "--- SECTIONS ---") is left inside the current stage.
    if (!KNOWN_STAGE_RE.test(m[1])) continue;
    stages.push({ stage: currentStage, text: log.slice(cursor, m.index) });
    currentStage = m[1];
    cursor = m.index + m[0].length;
  }
  stages.push({ stage: currentStage, text: log.slice(cursor) });
  return stages;
}

// ld65 LINKER diagnostics have NO file:line — parseCc65Like (which requires a
// `file:line:` lead) misses them entirely, so a failed link returned issues[]
// EMPTY even though the real error sat in the log. The common ones on a
// mis-wired NES rebuild (wrong/absent linker config for the project's segments):
//   ld65: Warning: Segment 'HEADER' does not exist
//   ld65: Error: Memory area overflow in 'ROM0', segment 'CODE' (6 bytes)
//   Error: Cannot generate most of the files due to memory area overflow
// They appear either bare or with an `ld65:`/`ld65.exe:` tool prefix. We add a
// short hint on the segment/overflow case (the linker config doesn't match the
// project's segments — the exact CHR-ROM-vs-CHR-RAM mismatch agents hit).
function parseLd65Linker(text, stage) {
  const out = [];
  const re = /^(?:ld65(?:\.exe)?:\s*)?(?<sev>Error|Warning):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const msg = m.groups.msg.trim().replace(/\x1b\[[0-9;]*m/g, "");
    // Skip the file:line form — parseCc65Like already owns those (and a leading
    // path would have been consumed as the message here, doubling the issue).
    if (/^[^\s:]+:\d+:/.test(msg)) continue;
    // Actionable hint in a SEPARATE field (matching GNU ld / sdld), not glued
    // onto the message — two common ld65 link failures:
    let hint;
    if (/does not exist|overflow|Cannot generate/i.test(msg)) {
      hint =
        "The linker config's segments don't match the project. For an NROM " +
        "rebuild use build({inesHeader:{...}}) or linkerConfig:'chr-rom'; otherwise " +
        "check that your .cfg's SEGMENTS match the .segment names in your source.";
    } else if (/unresolved external|undefined symbol/i.test(msg)) {
      const sym = msg.match(/['"`]?(?<s>[A-Za-z_]\w*)['"`]?\s*$/)?.groups?.s;
      hint =
        `${sym ? `\`${sym}'` : "That symbol"} is referenced but never defined or linked. ` +
        "Add the source/object that defines it (or the right cc65 lib for this platform) " +
        "to your build, or check for a typo.";
    }
    out.push({
      severity: m.groups.sev.toLowerCase() === "error" ? "error" : "warning",
      message: msg,
      stage: stage || "ld65",
      ...(hint ? { hint } : {}),
    });
  }
  return out;
}

// cc65, ca65, ld65 all use the gcc-style `file:line:col?: severity: message`.
// Example:
//   /work/main.s:12: Error: Cannot open include file 'longbranch.mac'
//   /work/main.c:3:9: Warning: Symbol 'x' is unused
function parseCc65Like(text, stage) {
  const out = [];
  const re = /^(?<file>[^\n:]+):(?<line>\d+)(?::(?<col>\d+))?:?\s+(?<sev>Error|Warning|Note|error|warning|note):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const sev = m.groups.sev.toLowerCase();
    out.push({
      severity: sev === "error" ? "error" : sev === "warning" ? "warning" : "info",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      col: m.groups.col ? parseInt(m.groups.col, 10) : undefined,
      message: m.groups.msg.trim().replace(/\x1b\[[0-9;]*m/g, ""),
      stage,
    });
  }
  return out;
}

// SDCC's keyword-less diagnostics that parseCc65Like (which requires an explicit
// "Error:"/"Warning:" word) doesn't catch:
//   /work/main.c:2: syntax error: token -> ';' ; column 44
//   /work/main.c:7: warning 112: function 'foo' implicit declaration
//   /work/main.c:9: error 20: undefined identifier 'x'
// We classify by the leading word after `file:line:` (syntax error / error / warning).
function parseSdcc(text, stage) {
  const out = [];
  const re = /^(?<file>[^\n:]+):(?<line>\d+):\s*(?<kind>syntax error|error(?:\s+\d+)?|warning(?:\s+\d+)?):?\s*(?<msg>.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const kind = m.groups.kind.toLowerCase();
    // Skip the forms parseCc65Like already caught ("Error:" capitalized w/ colon)
    // — this regex is case-insensitive on `error`/`warning`, but parseCc65Like
    // only matches when a colon immediately follows the keyword AND it's
    // capitalized; SDCC's lowercase keyword-less form is what we add here.
    const severity = kind.startsWith("warning") ? "warning"
      : (kind.startsWith("error") || kind === "syntax error") ? "error" : "info";
    const message = kind === "syntax error"
      ? ("syntax error: " + m.groups.msg).trim().replace(/\s*;\s*$/, "")
      : m.groups.msg.trim();
    out.push({
      severity,
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: message.replace(/\x1b\[[0-9;]*m/g, ""),
      stage,
    });
  }
  // sdld/ASlink linker diagnostics have NO file:line — they reference a symbol +
  // module. The most common is an undefined symbol (a call to a function that was
  // never defined/linked). Without parsing these the agent sees "build failed"
  // with no reason in issues[] (the error lived only in the raw log).
  //   ?ASlink-Warning-Undefined Global '_foo' referenced by module '_main'
  //   ?ASlink-Error-...
  const linkRe = /^\?ASlink-(?<sev>Warning|Error)-(?<msg>.+)$/gm;
  let lm;
  while ((lm = linkRe.exec(text))) {
    const msg = lm.groups.msg.trim();
    // An "Undefined Global" is effectively an error even though ASlink labels it
    // a warning — the ROM won't run. Promote it so the agent treats it as fatal.
    const isUndef = /undefined\s+global/i.test(msg);
    // Give the same actionable hint GNU ld's undefined-reference path gets, so
    // the SDCC platforms (GB/GBC/SMS/GG/MSX) reach parity on the single most
    // common link failure (forgot to include the source/runtime that defines it).
    // SDCC mangles C symbols with a leading '_' — show the C name too.
    let hint;
    if (isUndef) {
      const sym = msg.match(/global\s+['"]?(?<s>\w+)['"]?/i)?.groups?.s;
      const cName = sym && sym.startsWith("_") ? sym.slice(1) : sym;
      hint =
        `${sym ? `\`${sym}'` : "That symbol"} is called but never defined or linked` +
        `${cName && cName !== sym ? ` (the C name is \`${cName}'; SDCC prefixes an underscore)` : ""}. ` +
        "Add the source file (or runtime/library) that defines it to your build's sources/includes, " +
        "or check for a typo in the name.";
    }
    out.push({
      severity: lm.groups.sev === "Error" || isUndef ? "error" : "warning",
      message: "linker: " + msg,
      stage: "sdld",
      ...(hint ? { hint } : {}),
    });
  }
  return out;
}

// dasm example:
//   main.asm (1): error: Unknown Mnemonic 'is'.
function parseDasm(text) {
  const out = [];
  const re = /^(?<file>\S+)\s*\((?<line>\d+)\):\s*(?<sev>error|warning):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      severity: m.groups.sev,
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: m.groups.msg.trim(),
      stage: "dasm",
    });
  }
  return out;
}

// asar example (rough):
//   /work/main.asm:5: error: 'foo' not defined
//   error: (Lexer) Some message
function parseAsar(text, stage = "asar") {
  const out = [];
  const reFL = /^(?<file>\S+):(?<line>\d+):\s*(?<sev>error|warning):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = reFL.exec(text))) {
    out.push({
      severity: m.groups.sev,
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: m.groups.msg.trim(),
      stage,
    });
  }
  // Plain "error: ..." without file/line.
  const reBare = /^(?<sev>error|warning):\s*(?<msg>.+)$/gm;
  while ((m = reBare.exec(text))) {
    if (!out.some((i) => i.message === m.groups.msg.trim())) {
      out.push({
        severity: m.groups.sev,
        message: m.groups.msg.trim(),
        stage,
      });
    }
  }
  return out;
}

// RGBDS example:
//   ERROR: main.asm(15) -> /work/main.asm(15):
//       Some message
//   warning: file.asm(3): something
function parseRgbds(text, stage) {
  const out = [];
  // ERROR/WARNING in caps, with file(line)
  const re = /^(?<sev>ERROR|WARNING|error|warning):\s*(?<file>\S+?)\((?<line>\d+)\)(?::\s*)?(?<msg>.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      severity: m.groups.sev.toLowerCase(),
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: m.groups.msg.trim() || "(see following lines)",
      stage,
    });
  }
  return out;
}

// wla-dx (wla-65816 assembler + wlalink linker — the SNES C path).
//
// wlalink floods stdout with a `stack_item:` / `id: N file: ...` symbol-table
// dump on link failure; the ACTUAL error is one line, e.g.:
//   /work/main.obj: /work/main.asm:18: FIX_REFERENCES: Reference to an unknown label "foo".
//   /work/main.obj: ERROR: SECTIONS: section "bar" wasn't found.
// wla-65816 assembler errors look like one of:
//   /work/main.asm:12: ERROR: Unknown instruction "lda#".
//   ERROR: Couldn't open file "x.asm".
// We extract just the diagnostic lines so an agent sees a clean issues[] and
// isn't asked to read the symbol-table flood.
function parseWla(text, stage = "wla") {
  const out = [];
  // wlalink: "<obj>: <file>:<line>: <PHASE>: <message>"  (file:line present)
  const reLink = /^(?<obj>\S+\.obj):\s*(?<file>[^\s:]+):(?<line>\d+):\s*(?<phase>[A-Z_]+):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = reLink.exec(text))) {
    const rawMsg = m.groups.msg.trim();
    // An "unknown label" reference is SNES's undefined-symbol failure — give it
    // the same actionable hint ld65/sdld/GNU ld carry, so SNES reaches parity.
    let hint;
    const lbl = /unknown label\s+["'`]?(?<l>[A-Za-z_]\w*)/i.exec(rawMsg)?.groups?.l;
    if (lbl || /reference to an unknown/i.test(rawMsg)) {
      hint =
        `${lbl ? `\`${lbl}'` : "That label"} is referenced but never defined or linked. ` +
        "Add the source/object that defines it (or the right PVSnesLib runtime) to your build, " +
        "or check for a typo.";
    }
    out.push({
      severity: "error",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      // Keep the wla internal phase name (FIX_REFERENCES, etc.) out of the
      // agent-facing message — it's noise; the message + hint say what to do.
      message: rawMsg,
      stage: stage === "wla" ? "wlalink" : stage,
      ...(hint ? { hint } : {}),
    });
  }
  // wla-65816 assembler: "<file>:<line>: ERROR|WARNING: <message>"
  const reAsm = /^(?<file>[^\s:]+):(?<line>\d+):\s*(?<sev>ERROR|WARNING):\s*(?<msg>.+)$/gm;
  while ((m = reAsm.exec(text))) {
    const msg = m.groups.msg.trim();
    if (out.some((i) => i.line === parseInt(m.groups.line, 10) && i.message.includes(msg))) continue;
    out.push({
      severity: m.groups.sev === "WARNING" ? "warning" : "error",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: msg,
      stage,
    });
  }
  // Bare "ERROR: ..." / "<obj>: ERROR: ..." with no file:line (e.g. missing
  // section / file). Skip the noisy "stack_item:"/"id:" dump lines entirely.
  const reBare = /^(?:\S+:\s*)?(?<sev>ERROR|WARNING):\s*(?<msg>.+)$/gm;
  while ((m = reBare.exec(text))) {
    const msg = m.groups.msg.trim();
    if (/^stack_item|^id:\s/.test(msg)) continue;
    if (out.some((i) => i.message.includes(msg))) continue;
    out.push({
      severity: m.groups.sev === "WARNING" ? "warning" : "error",
      message: msg,
      stage,
    });
  }
  return out;
}

// vasm example:
//   error 22 in line 5 of "/work/main.s": ...
//   warning 1003 in line 8 of "main.s": ...
//   fatal error 13 in line 1 of "/work/main.s": could not open <x.bin> for input
//     (← a MISSING incbin asset: the #1 thing an agent forgets to pass)
function parseVasm(text) {
  const out = [];
  const re = /^(?<sev>fatal error|error|warning)\s+\d+\s+in\s+line\s+(?<line>\d+)\s+of\s+"(?<file>[^"]+)":\s*(?<msg>.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      severity: m.groups.sev === "warning" ? "warning" : "error",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: m.groups.msg.trim(),
      stage: "vasm",
    });
  }
  return out;
}

// GNU toolchain (m68k for Genesis, arm for GBA): gcc / cc1 / as / ld / objcopy.
// Two shapes worth catching:
//   1. compiler diagnostics:  main.c:12:5: error: 'foo' undeclared
//   2. LINKER diagnostics from ld, which the cc65 parser misses entirely:
//        rom_header.o:(.text+0x0): multiple definition of `rom_header'
//        sega.o:(.text+0x100): first defined here
//        main.o: in function `main': undefined reference to `VDP_init'
// The Genesis sega.s startup the build auto-assembles ALREADY defines
// rom_header at .text.keepboot+0x100. If the agent also compiles SGDK's
// rom_header.c (a common copy-paste from SGDK examples) the link dies on a
// duplicate symbol with no hint about WHY. We special-case it.
function parseGnuToolchain(text, stage = "ld") {
  const out = [];
  const seen = new Set();
  const add = (issue) => {
    const key = `${issue.message}@${issue.file ?? ""}:${issue.line ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(issue);
  };

  // 1. gcc/cc1 compiler diagnostics (file:line:col: severity: message).
  const ccRe = /^(?<file>[^\n:]+\.[chsCHS]):(?<line>\d+)(?::(?<col>\d+))?:\s*(?<sev>error|warning|note):\s*(?<msg>.+)$/gm;
  let m;
  while ((m = ccRe.exec(text))) {
    const sev = m.groups.sev.toLowerCase();
    add({
      severity: sev === "error" ? "error" : sev === "warning" ? "warning" : "info",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      col: m.groups.col ? parseInt(m.groups.col, 10) : undefined,
      message: m.groups.msg.trim().replace(/\x1b\[[0-9;]*m/g, ""),
      stage,
    });
  }

  // 2. ld "multiple definition of `sym'" — with the rom_header special case.
  const multiRe = /multiple definition of [`'"]?(?<sym>[A-Za-z_]\w*)['"`]?/g;
  while ((m = multiRe.exec(text))) {
    const sym = m.groups.sym;
    const isRomHeader = sym === "rom_header";
    add({
      severity: "error",
      message: `multiple definition of \`${sym}'`,
      stage: "ld",
      hint: isRomHeader
        ? "The Genesis startup `sega.s` that romdev auto-assembles already " +
          "defines `rom_header` (at .text.keepboot+0x100). You also compiled a " +
          "`rom_header.c` (commonly copied from SGDK examples) which defines it " +
          "AGAIN — so the link fails. FIX: remove rom_header.c from your build's " +
          "source list. The build supplies the header itself; you do not need to. " +
          "(If you need custom header fields, edit them in your build config, not " +
          "by re-defining the symbol.)"
        : `\`${sym}' is defined in more than one object file. Remove the duplicate ` +
          "definition, or mark one as a declaration (extern) instead of a definition.",
    });
  }

  // 3. ld "undefined reference to `sym'".
  const undefRe = /undefined reference to [`'"]?(?<sym>[A-Za-z_]\w*)['"`]?/g;
  while ((m = undefRe.exec(text))) {
    add({
      severity: "error",
      message: `undefined reference to \`${m.groups.sym}'`,
      stage: "ld",
      hint: `\`${m.groups.sym}' is called/used but never defined or linked. Add the ` +
        "source file that defines it to your build, or check for a typo in the name.",
    });
  }

  return out;
}
