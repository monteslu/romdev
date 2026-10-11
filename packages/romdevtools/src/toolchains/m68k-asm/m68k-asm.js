// m68k-asm - assemble Motorola-syntax 68k source into a flat binary with GNU as.
//
// Pipeline (all WASM, from romdev-toolchain-m68k-gcc):
//   translateMotorola()  Motorola syntax → GNU as source + linker script layout
//   m68k-elf-as          → main.o
//   m68k-elf-ld          one output section per `org` block, each at its address
//   m68k-elf-objcopy     -O binary → the flat image (gaps zero-filled), trimmed
//                        to the last byte the source emitted
//
// Used by build({platform:'genesis'}) for assembly sources and by
// assembleSnippet for cpu:'68k'. Diagnostics from every stage are reported as
// `file:line: error: message` against the ORIGINAL source lines.
//
// Plain JS ESM + JSDoc.

import { translateMotorola } from "./motorola.js";
import { runM68kAs, runM68kLd, runM68kObjcopy } from "../m68k-elf-gcc/gcc.js";
import { readElfSymbols } from "./elf.js";

/** GNU as flags for the translated source. */
const AS_FLAGS = ["--register-prefix-optional", "--bitwise-or"];
/** Upper bound on layout passes (see runM68kAsm). */
const MAX_LAYOUT_PASSES = 8;

/**
 * Sort caller options into defines, include dirs, a CPU choice and flags this
 * build ignores (it always produces a flat binary).
 * @param {string[]} options
 */
function readOptions(options) {
  const defines = {};
  const incdirs = [];
  const asFlags = [];
  const ignored = [];
  for (let i = 0; i < options.length; i++) {
    const o = String(options[i]);
    let m;
    if ((m = /^(?:-D|--define(?:=|$)|--defsym(?:=|$))(.*)$/.exec(o))) {
      let spec = m[1];
      if (spec === "" && i + 1 < options.length) spec = String(options[++i]);
      const eq = spec.indexOf("=");
      const name = eq < 0 ? spec : spec.slice(0, eq);
      const valText = eq < 0 ? "1" : spec.slice(eq + 1);
      const v = /^\$[0-9A-Fa-f]+$/.test(valText) ? parseInt(valText.slice(1), 16)
        : /^0x[0-9A-Fa-f]+$/i.test(valText) ? parseInt(valText, 16)
        : Number(valText);
      if (name && Number.isFinite(v)) defines[name] = v | 0;
      else ignored.push(o);
      continue;
    }
    if ((m = /^-I(.*)$/.exec(o))) {
      incdirs.push(m[1] || String(options[++i] ?? ""));
      continue;
    }
    if ((m = /^-m(680[0-6]0|cpu32)$/.exec(o))) { asFlags.push(`-march=${m[1]}`); continue; }
    if (/^-march=/.test(o) || /^--pcrel$/.test(o)) { asFlags.push(o); continue; }
    ignored.push(o);
  }
  return { defines, incdirs, asFlags, ignored };
}

/** Map `/work/main.s:N: Error: msg` lines onto the original source. */
function mapGasLog(log, lineMap) {
  const out = [];
  for (const line of String(log ?? "").split("\n")) {
    if (/^\/work\/main\.s: Assembler messages:$/.test(line)) continue;
    const m = /^\/work\/main\.s:(\d+): (Error|Warning|Info): (.*)$/.exec(line);
    if (m) {
      const loc = lineMap[+m[1] - 1];
      const sev = m[2].toLowerCase();
      const msg = demangle(m[3]);
      if (loc && loc.file) out.push(`${loc.file}:${loc.line}: ${sev}: ${msg}${loc.where ? ` (${loc.where})` : ""}`);
      else out.push(`${sev}: ${msg}`);
      continue;
    }
    if (line.trim()) out.push(demangle(line));
  }
  return out.join("\n");
}

/** Make internal symbol names readable in messages: `glob$loop` → `.loop`. */
function demangle(text) {
  return text
    .replace(/\(0x[0-9a-f]+\+\(([A-Za-z_][\w$]*)-__rd_s\d+\)\)/g, "$1")
    .replace(/\b([A-Za-z_][\w]*)\$([A-Za-z_][\w]*)(?![\w$])/g, "$1\\.$2");
}

/** Read `0x<addr>  __rd_eN` definitions from the ld map. */
function mapSymbols(map) {
  const out = new Map();
  for (const line of String(map ?? "").split("\n")) {
    const m = /^\s+0x([0-9a-fA-F]+)\s+(__rd_e\d+)\s*$/.exec(line);
    if (m) out.set(m[2], parseInt(m[1], 16));
  }
  return out;
}

/** Linker script: one output section per org block, at its address. */
function linkScript(sections) {
  const lines = ['OUTPUT_FORMAT("elf32-m68k")', "OUTPUT_ARCH(m68k)", "SECTIONS", "{"];
  for (const s of sections) {
    lines.push(`  ${s.name} 0x${s.base.toString(16)} : { *(${s.name}) }`);
  }
  lines.push("  /DISCARD/ : { *(.comment) *(.note*) *(.m68k.attributes) }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * Assemble once more with a listing to learn which translated line produced
 * each (section, offset), so link errors can name a source line.
 * @returns {Promise<(section:string, offset:number) => number|null>} translated line (1-based)
 */
async function listingLocator(text, binaryIncludes, asFlags) {
  const { runIsolated } = await import("../_worker/run.js");
  const { resolveGlueFile } = await import("../common/wasm-tool.js");
  const { marshalInputs } = await import("../common/io.js");
  const gluePath = resolveGlueFile({
    pkg: "romdev-toolchain-m68k-gcc",
    file: "m68k-elf-as.mjs",
    localDir: new URL("../m68k-elf-gcc/", import.meta.url).pathname,
    label: "m68k-elf-as",
  });
  const r = await runIsolated({
    gluePath,
    argv: ["-march=68000", ...AS_FLAGS, ...asFlags, "-al=/work/main.lst", "/work/main.s", "-o", "/work/main.o"],
    inputFiles: marshalInputs({ primary: { name: "main.s", text }, binary: binaryIncludes }),
    outputFiles: [{ vfsPath: "/work/main.lst", encoding: "utf8" }],
  });
  const lst = r.outputs?.["/work/main.lst"] ?? "";
  const bySec = new Map();
  let sec = null;
  for (const line of lst.split("\n")) {
    const m = /^\s*(\d+) ([0-9a-f]{4,8}) [0-9A-F]/.exec(line);
    const sm = /^\s*\d+\s+\t?\s*\.section\s+(\.rd\d+)/.exec(line);
    if (sm) { sec = sm[1]; continue; }
    if (m && sec) {
      if (!bySec.has(sec)) bySec.set(sec, []);
      bySec.get(sec).push([parseInt(m[2], 16), +m[1]]);
    }
  }
  return (section, offset) => {
    const rows = bySec.get(section);
    if (!rows) return null;
    let best = null;
    for (const [off, ln] of rows) { if (off <= offset) best = ln; else break; }
    return best;
  };
}

/** Readable form of ld diagnostics; `locate` maps (section, offset) to a source line. */
function explainLd(log, sections, locate) {
  return String(log ?? "")
    .split("\n")
    .map((l) => {
      const m = /section (\.rd\d+) (?:LMA|VMA) \[([0-9a-f]+),([0-9a-f]+)\] overlaps section (\.rd\d+) (?:LMA|VMA) \[([0-9a-f]+),([0-9a-f]+)\]/.exec(l);
      if (m) {
        const h = (x) => "$" + parseInt(x, 16).toString(16).toUpperCase();
        return `error: org blocks overlap: ${h(m[2])}-${h(m[3])} and ${h(m[5])}-${h(m[6])} (an org block ran past the start of the next one)`;
      }
      if (/: in function `/.test(l)) return "";
      const r = /^\((\.rd\d+)\+0x([0-9a-f]+)\): (.*)$/.exec(l.replace(/^.*wasm-worker\.js: /, ""));
      if (r) {
        let msg = demangle(r[3]).replace(/ against `\.rd\d+'/, "");
        if (/relocation truncated to fit/.test(msg)) msg += " (the value does not fit the operand size)";
        const loc = locate?.(r[1], parseInt(r[2], 16));
        if (loc) return `${loc.file}:${loc.line}: error: ${msg}${loc.where ? ` (${loc.where})` : ""}`;
        const s = sections.find((x) => x.name === r[1]);
        return `error: ${msg} at $${((s?.base ?? 0) + parseInt(r[2], 16)).toString(16)}`;
      }
      return demangle(l.replace(/^.*wasm-worker\.js: /, ""));
    })
    .filter((l) => l.trim())
    .join("\n");
}

/**
 * Assemble Motorola-syntax 68k source to a flat binary.
 *
 * @param {Object} args
 * @param {string} args.source                         main source
 * @param {Record<string,string>} [args.includes]      text files for `include`
 * @param {Record<string,string|Uint8Array>} [args.binaryIncludes] files for `incbin` (base64 strings or bytes)
 * @param {string[]} [args.options]                    -D NAME=VALUE, -I dir, -m68000..-m68060; other flags are ignored with a note
 * @param {string} [args.mainName]                     file name used in diagnostics (default main.s)
 * @returns {Promise<{binary:Uint8Array|null, log:string, exitCode:number, stage?:string, gasSource?:string, map?:string|null, crash?:unknown}>}
 */
export async function runM68kAsm(args) {
  const opts = readOptions(args.options ?? []);
  const notes = [];
  if (opts.ignored.length) notes.push(`note: ignored assembler option(s) ${opts.ignored.join(" ")} (this build always writes a flat binary)`);

  const translate = (hints, frozen = null) => translateMotorola({
    source: args.source,
    mainName: args.mainName ?? "main.s",
    includes: args.includes ?? {},
    binaryIncludes: args.binaryIncludes ?? {},
    defines: opts.defines,
    incdirs: opts.incdirs,
    hints,
    frozen,
  });
  const fmt = (d, sev) => `${d.file}:${d.line}: ${sev}: ${d.message}${d.where ? ` (${d.where})` : ""}`;

  let tr = translate(null);
  const head = [
    ...notes,
    ...tr.messages,
    ...tr.warnings.map((w) => fmt(w, "warning")),
  ];
  if (tr.errors.length) {
    return {
      binary: null,
      log: withStage([...head, ...tr.errors.map((e) => fmt(e, "error"))].join("\n")),
      exitCode: 1,
      stage: "translate",
      gasSource: tr.text,
    };
  }

  // GNU as. Text includes are already inlined; binaries (and text files used
  // with incbin) are written to /work for .incbin.
  const binaryIncludes = { ...(args.binaryIncludes ?? {}) };
  for (const [k, v] of Object.entries(args.includes ?? {})) {
    if (!(k in binaryIncludes)) binaryIncludes[k] = new TextEncoder().encode(String(v));
  }

  /** Assemble + link one translation. */
  const build = async (t) => {
    const as = await runM68kAs({ source: t.text, binaryIncludes, options: [...AS_FLAGS, ...opts.asFlags] });
    const asLog = mapGasLog(as.log, t.lineMap);
    if (as.exitCode !== 0 || !as.object) {
      return { ok: false, stage: "as", exitCode: as.exitCode || 1, log: asLog, crash: as.crash };
    }
    if (t.sections.length === 0) return { ok: true, empty: true, asLog, ldLog: "" };
    const ld = await runM68kLd({ objects: { "main.o": as.object }, linkScript: linkScript(t.sections), options: ["--no-warn-rwx-segments"] });
    let ldLog = explainLd(ld.log, t.sections);
    if (ld.exitCode !== 0 || !ld.elf) {
      if (/\(\.rd\d+\+0x/.test(ld.log ?? "")) {
        const find = await listingLocator(t.text, binaryIncludes, opts.asFlags);
        ldLog = explainLd(ld.log, t.sections, (sec, off) => {
          const n = find(sec, off);
          return n ? t.lineMap[n - 1] : null;
        });
      }
      return { ok: false, stage: "ld", exitCode: ld.exitCode || 1, log: [asLog, ldLog].filter(Boolean).join("\n"), crash: ld.crash };
    }
    return { ok: true, asLog, ldLog, ld, syms: readElfSymbols(ld.elf) };
  };

  /** Label addresses from a translation that does not assemble cleanly (a
   *  short displacement that only fits once the layout tightens): GNU as -Z
   *  still writes the object, ld --noinhibit-exec still links it. */
  const salvageSyms = async (t) => {
    const as = await runM68kAs({ source: t.text, binaryIncludes, options: [...AS_FLAGS, ...opts.asFlags, "-Z"] });
    if (!as.object || t.sections.length === 0) return null;
    const ld = await runM68kLd({ objects: { "main.o": as.object }, linkScript: linkScript(t.sections), options: ["--no-warn-rwx-segments", "--noinhibit-exec"] });
    return ld.elf ? readElfSymbols(ld.elf) : null;
  };

  // Layout passes. The first pass knows no label addresses; when an encoding
  // choice depends on one (a label in the first 32KB takes the short absolute
  // form, a constant built from labels may fit moveq, ...), translate again
  // with the addresses the previous link produced, until the source GNU as
  // sees stops changing. Every pass that links is a correct program; the
  // passes make the layout match the classic Motorola-syntax assemblers byte
  // for byte (and let a source whose short displacements only fit in that
  // tighter layout assemble at all).
  let res = await build(tr);
  const first = res.ok ? { tr, res } : null;
  if (tr.hintSensitive && !res.empty) {
    let syms = res.ok ? res.syms : await salvageSyms(tr);
    let converged = false;
    // A statement whose encoding keeps flipping between passes (a constant
    // computed from labels that is even in one layout and odd in the next)
    // is frozen to its address-free encoding so the passes settle.
    const frozen = new Set();
    const flips = new Map();
    for (let pass = 1; syms && pass <= MAX_LAYOUT_PASSES; pass++) {
      const next = translate(syms, frozen);
      if (next.text === tr.text) { converged = res.ok; break; }
      next.stmtText.forEach((t, i) => {
        if (t === tr.stmtText[i]) return;
        const n = (flips.get(i) ?? 0) + 1;
        flips.set(i, n);
        if (n >= 2) frozen.add(i);
      });
      const r2 = await build(next);
      if (!r2.ok && res.ok) break;
      tr = next;
      res = r2;
      syms = r2.ok ? r2.syms : await salvageSyms(next);
    }
    if (res.ok && !converged) {
      // the layout never settled: the address-free first pass is the safe choice
      const check = translate(res.syms, frozen);
      if (check.text !== tr.text && first) { tr = first.tr; res = first.res; }
    }
  }
  if (!res.ok) {
    return {
      binary: null,
      log: withStage([...head, res.log].filter(Boolean).join("\n")),
      exitCode: res.exitCode,
      stage: res.stage,
      gasSource: tr.text,
      ...(res.crash ? { crash: res.crash } : {}),
    };
  }
  const asLog = res.asLog, ldLog = res.ldLog;
  if (res.empty) {
    return { binary: new Uint8Array(0), log: withStage([...head, asLog].filter(Boolean).join("\n")), exitCode: 0, gasSource: tr.text, map: null, symbols: "" };
  }
  const ld = res.ld;

  const oc = await runM68kObjcopy({ elf: ld.elf });
  if (oc.exitCode !== 0 || !oc.binary) {
    return {
      binary: null,
      log: withStage([...head, asLog, ldLog, oc.log].filter(Boolean).join("\n")),
      exitCode: oc.exitCode || 1,
      stage: "objcopy",
      gasSource: tr.text,
      ...(oc.crash ? { crash: oc.crash } : {}),
    };
  }

  // objcopy starts at the lowest block and may carry section padding past the
  // last emitted byte; trim to the highest block end.
  const ends = mapSymbols(ld.map);
  let lo = Infinity, hi = 0;
  for (const s of tr.sections) {
    const end = ends.get(s.end);
    if (end === undefined) continue;
    if (end > s.base) { lo = Math.min(lo, s.base); hi = Math.max(hi, end); }
  }
  let binary = oc.binary;
  if (hi > 0 && Number.isFinite(lo) && hi - lo <= binary.length) binary = binary.slice(0, hi - lo);
  if (!Number.isFinite(lo)) binary = new Uint8Array(0);

  return {
    binary,
    log: withStage([...head, asLog, ldLog].filter(Boolean).join("\n")),
    exitCode: 0,
    gasSource: tr.text,
    map: ld.map ?? null,
    symbols: symbolLines(tr, res.syms),
    origin: Number.isFinite(lo) ? lo : 0,
  };
}

/** Prefix a non-empty log with the stage marker parseBuildLog keys on. */
function withStage(log) {
  return log ? `--- m68k-as ---\n${log}` : log;
}

/**
 * Label addresses in the GNU ld map's symbol-definition shape
 * ("    0x00000200    Start"), so the symbols tool reads them like a C build's
 * map. Local labels are listed as `global.local`.
 */
function symbolLines(tr, syms) {
  const out = [];
  for (const name of tr.labels.keys()) {
    if (name.startsWith("__rd_") || !syms.has(name)) continue;
    const shown = name.replace(/\$(?=[A-Za-z_])/, ".");
    out.push(`                0x${syms.get(name).toString(16).padStart(8, "0")}                ${shown}`);
  }
  return out.join("\n");
}
