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
    } else if (/^dasm$/.test(baseStage)) {
      issues.push(...parseDasm(text));
    } else if (/^asar$/.test(baseStage)) {
      issues.push(...parseAsar(text));
    } else if (/^rgbasm$|^rgblink$|^rgbfix$/.test(baseStage)) {
      issues.push(...parseRgbds(text, baseStage));
    } else if (/^vasm/.test(baseStage)) {
      issues.push(...parseVasm(text));
    } else if (/^sdcc$|^sdasz80$|^sdasgb$|^sdld$|^mcpp$/.test(baseStage)) {
      // SDCC family: sdcc / sdasz80 / sdasgb / sdld / mcpp emit cc65-style
      // `file:line: severity: msg` errors. Tag with the actual originating
      // tool, not "asar" (the old fallback was wrong).
      issues.push(...parseCc65Like(text, baseStage));
    } else if (/^wla|^wlalink|^wladx/.test(baseStage)) {
      // SNES C path: wla-65816 assembler + wlalink linker. wlalink floods a
      // symbol-table dump on failure — parseWla extracts just the diagnostics.
      issues.push(...parseWla(text, baseStage));
    } else {
      // Unknown stage — try every parser, accept anything that yields hits.
      // Tag everything with the (possibly empty) actual stage name so an
      // assembler error doesn't mistakenly report as "asar" on a non-SNES
      // build.
      const tag = baseStage || "unknown";
      issues.push(...parseCc65Like(text, tag));
      issues.push(...parseDasm(text));
      issues.push(...parseAsar(text, tag));
      issues.push(...parseRgbds(text, tag));
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
    out.push({
      severity: "error",
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: `${m.groups.phase}: ${m.groups.msg.trim()}`,
      stage: stage === "wla" ? "wlalink" : stage,
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
function parseVasm(text) {
  const out = [];
  const re = /^(?<sev>error|warning)\s+\d+\s+in\s+line\s+(?<line>\d+)\s+of\s+"(?<file>[^"]+)":\s*(?<msg>.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      severity: m.groups.sev,
      file: m.groups.file,
      line: parseInt(m.groups.line, 10),
      message: m.groups.msg.trim(),
      stage: "vasm",
    });
  }
  return out;
}
