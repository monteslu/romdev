// compile.js — compile ONE candidate for ONE function inside its real
// translation unit, with the project's own compiler invocation, in an isolated
// work directory; then extract the function from the object and compare it
// against the target assembled from the extracted asm.
//
// Why the whole TU and not a snippet: IDO's output for a function depends on
// what else the TU declares (types, statics, the -G 0 globals, literal pools).
// A standalone snippet can compile to different code and then "match" a
// target the real build never would.
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { run, assembleTarget, dumpObject, findSymbol, symbolTable, trimToSize } from "./mips-obj.js";
import { strictCompare, scoreDistance, classifyDifferences, changedRanges, renderDiff } from "./diff.js";
import { parseSplatAsm } from "./splat-map.js";
import { dependencyHash, sha256Text } from "./project.js";

/**
 * Replace a function in a TU's text with candidate C. Handles both states:
 * a GLOBAL_ASM pragma for the function (asm today) or an existing C
 * definition (re-matching a function whose declaration was wrong).
 * @returns {{text:string, replaced:'pragma'|'definition', line:number}}
 */
export function spliceFunction(tuText, name, candidateText) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pragma = new RegExp(`^[ \\t]*#pragma\\s+GLOBAL_ASM\\("[^"]*\\/${esc}\\.s"\\)[ \\t]*\\r?\\n?`, "m");
  const pm = pragma.exec(tuText);
  if (pm) {
    const line = tuText.slice(0, pm.index).split("\n").length;
    return { text: tuText.slice(0, pm.index) + candidateText.replace(/\s*$/, "\n") + tuText.slice(pm.index + pm[0].length), replaced: "pragma", line };
  }
  const def = new RegExp(`^[A-Za-z_][^;{}]*?\\b${esc}\\s*\\([^;{}]*\\)\\s*\\{`, "m");
  const dm = def.exec(tuText);
  if (!dm) throw Object.assign(new Error(`function '${name}' has neither a GLOBAL_ASM pragma nor a C definition in the TU`), { code: "FUNCTION_NOT_IN_TU" });
  // Brace-match to the end of the definition (comments/strings containing braces are rare in decomp source; guard the obvious ones).
  let i = dm.index + dm[0].length, depth = 1;
  while (i < tuText.length && depth > 0) {
    const c = tuText[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === '"' || c === "'") { const q = c; i++; while (i < tuText.length && tuText[i] !== q) { if (tuText[i] === "\\") i++; i++; } }
    else if (c === "/" && tuText[i + 1] === "*") { i = tuText.indexOf("*/", i + 2); if (i < 0) break; i++; }
    else if (c === "/" && tuText[i + 1] === "/") { i = tuText.indexOf("\n", i); if (i < 0) break; }
    i++;
  }
  const line = tuText.slice(0, dm.index).split("\n").length;
  return { text: tuText.slice(0, dm.index) + candidateText.replace(/\s*$/, "") + tuText.slice(i), replaced: "definition", line };
}

/** Extract a function's C definition text from a TU (declaration through closing brace). */
export function extractFunction(tuText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const def = new RegExp(`^[A-Za-z_][^;{}]*?\\b${esc}\\s*\\([^;{}]*\\)\\s*\\{`, "m");
  const dm = def.exec(tuText);
  if (!dm) return null;
  let i = dm.index + dm[0].length, depth = 1;
  while (i < tuText.length && depth > 0) {
    const c = tuText[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === '"' || c === "'") { const q = c; i++; while (i < tuText.length && tuText[i] !== q) { if (tuText[i] === "\\") i++; i++; } }
    else if (c === "/" && tuText[i + 1] === "*") { i = tuText.indexOf("*/", i + 2); if (i < 0) break; i++; }
    else if (c === "/" && tuText[i + 1] === "/") { i = tuText.indexOf("\n", i); if (i < 0) break; }
    i++;
  }
  return tuText.slice(dm.index, i);
}

/**
 * Apply MIPS relocations to a relocatable instruction stream given symbol VAs
 * (linker map + symbol_addrs) and the function's own VA, producing the words
 * the linked ROM holds. HI16/LO16 pair by the standard rule (carry from the
 * low half). Unknown symbols leave the word as-is and are reported.
 */
export function applyRelocations(stream, symbolVa, baseVa) {
  const out = [];
  const unresolved = new Set();
  for (let i = 0; i < stream.length; i++) {
    const ins = stream[i];
    let word = ins.word >>> 0;
    if (ins.reloc) {
      const sv = symbolVa(ins.reloc.symbol);
      if (sv == null) unresolved.add(ins.reloc.symbol);
      else {
        const target = (sv + (ins.reloc.addend | 0)) >>> 0;
        switch (ins.reloc.type) {
          case "R_MIPS_26": word = ((word & 0xfc000000) | ((target >>> 2) & 0x03ffffff)) >>> 0; break;
          case "R_MIPS_HI16": {
            // The addend for a HI16 lives in the following LO16's immediate (GNU as convention): find it.
            let lo = 0;
            for (let j = i + 1; j < stream.length; j++) { const r = stream[j].reloc; if (r && r.type === "R_MIPS_LO16" && r.symbol === ins.reloc.symbol) { lo = (stream[j].word << 16) >> 16; break; } }
            const full = (sv + lo + (ins.reloc.addend | 0)) >>> 0;
            const hi = ((full + 0x8000) >>> 16) & 0xffff;
            word = ((word & 0xffff0000) | hi) >>> 0; break;
          }
          case "R_MIPS_LO16": { const lo = ((word << 16) >> 16); const full = (sv + lo + (ins.reloc.addend | 0)) >>> 0; word = ((word & 0xffff0000) | (full & 0xffff)) >>> 0; break; }
          case "R_MIPS_GPREL16": case "R_MIPS_LITERAL": default: unresolved.add(`${ins.reloc.type}:${ins.reloc.symbol}`); break;
        }
      }
    }
    out.push({ ...ins, linkedWord: word });
  }
  return { stream: out, unresolved: [...unresolved] };
}

/** Substitute the TU input path and the object output path in a captured argv. */
function retargetArgv(argv, { tuRel, objRel, newTu, newObj }) {
  return argv.map((a) => (a === tuRel ? newTu : a === objRel ? newObj : a));
}

/**
 * Assemble (and cache) the target object for a function from its extracted asm.
 */
export async function ensureTarget(project, fn) {
  const asmRel = fn.targetAsm?.path ?? fn.source?.asmPath ?? null;
  if (!asmRel) {
    // ROM-only target: the linked words at the resolved offset. No relocation
    // records, so the strict compare is word-for-word against the LINKED
    // candidate (compareAgainstRom); the relocatable compare is skipped.
    if (fn.romOffset == null || !fn.sizeBytes) throw Object.assign(new Error(`function '${fn.symbol}' has no extracted asm and no ROM offset/size to take the target from`), { code: "NO_TARGET" });
    return { key: "rom", symbol: fn.symbol, asmPath: null, targetO: null, romOnly: true, instructions: fn.sizeBytes / 4, sizeBytes: fn.sizeBytes, rodata: [] };
  }
  const asmAbs = project.abs(asmRel);
  const asmText = await readFile(asmAbs, "utf8");
  const dir = path.join(project.ws, "targets", fn.symbol);
  const key = sha256Text(asmText).slice(0, 16);
  const meta = path.join(dir, "target.json");
  if (fs.existsSync(meta)) {
    try { const m = JSON.parse(await readFile(meta, "utf8")); if (m.key === key && fs.existsSync(m.targetO)) return m; } catch {}
  }
  const tc = project.m.toolchain;
  const as = tc.assembler?.path ?? "mips-linux-gnu-as";
  const inc = [project.abs("include"), path.dirname(asmAbs)];
  const t = await assembleTarget({ asmText, outDir: dir, as, asFlags: ["-march=vr4300", "-32", "-G0", "-EB"], includeDirs: inc, cwd: project.root, env: project.env });
  const parsed = parseSplatAsm(asmText);
  const m = { key, symbol: fn.symbol, asmPath: asmRel, targetFrom: fn.targetAsm?.from ?? "pragma", targetO: t.targetO, targetS: t.targetS, instructions: parsed.instructions.length, sizeBytes: parsed.sizeBytes, rodata: parsed.rodataSymbols.map((r) => r.name) };
  await writeFile(meta, JSON.stringify(m, null, 2));
  return m;
}

/**
 * Compile a candidate and compare. Returns a structured result and writes
 * artifacts under the candidate's directory.
 * @param {import('./project.js').Project} project
 * @param {object} fn resolved function (from Project.resolveFunction)
 * @param {{candidateText:string, candidatePath?:string, label?:string, maxDiffInstructions?:number, verifyTu?:boolean}} opts
 */
export async function compileAndCompare(project, fn, opts) {
  const startedAt = Date.now();
  const tuRel = fn.source?.tu;
  if (!tuRel) throw Object.assign(new Error(`function '${fn.symbol}' was not found in any TU under ${project.m.splat.srcPath}/`), { code: "FUNCTION_NOT_IN_TU" });
  const objRel = path.join(project.m.splat.buildPath, tuRel.replace(/\.c$/, ".o"));
  const inv = await project.compileInvocation(tuRel);
  const dep = await dependencyHash(project, tuRel, inv);
  const candSha = sha256Text(opts.candidateText).slice(0, 16);
  const candDir = path.join(project.ws, "candidates", fn.symbol);
  await mkdir(candDir, { recursive: true });
  const cacheKey = `${dep.hash}-${candSha}`;
  const cachedPath = path.join(candDir, `${cacheKey}.result.json`);
  if (fs.existsSync(cachedPath) && !opts.noCache) {
    const cached = JSON.parse(await readFile(cachedPath, "utf8"));
    return { ...cached, cacheHit: true, elapsedMs: Date.now() - startedAt };
  }
  // Isolated work dir mirroring the TU's relative path (asm-processor mangles statics with the file name).
  const workId = randomUUID().slice(0, 8);
  const work = path.join(project.ws, "work", workId);
  const newTuAbs = path.join(work, tuRel);
  const newObjAbs = path.join(work, path.basename(objRel));
  await mkdir(path.dirname(newTuAbs), { recursive: true });
  const tuText = await readFile(project.abs(tuRel), "utf8");
  // m2c drafts use M2C_* helper macros; supply the ones the candidate references
  // (from m2c's own m2c_macros.h semantics) so a draft can compile as-is. They are
  // recorded in the result — a matched function must not keep them.
  const injected = m2cMacroDefinitions(opts.candidateText);
  const candidateForTu = injected.text + opts.candidateText;
  const spliced = spliceFunction(tuText, fn.symbol, candidateForTu);
  await writeFile(newTuAbs, spliced.text);
  const compileArgv = retargetArgv(inv.compile, { tuRel, objRel, newTu: newTuAbs, newObj: newObjAbs });
  const t0 = Date.now();
  const cr = await run(compileArgv[0], compileArgv.slice(1), { cwd: project.root, env: project.env, timeoutMs: 180_000 });
  const compileMs = Date.now() - t0;
  const log = [`$ ${compileArgv.join(" ")}`, cr.stdout, cr.stderr].join("\n");
  const logPath = path.join(candDir, `${cacheKey}.build.log`);
  await writeFile(logPath, log);
  const result = {
    project: project.id, function: { symbol: fn.symbol, segment: fn.segment, va: fn.vaHex, tu: tuRel, replaced: spliced.replaced, atLine: spliced.line },
    candidate: { sha256: candSha, path: opts.candidatePath ?? null, label: opts.label ?? null, storedAt: path.join(candDir, `${cacheKey}.c`) },
    compiler: { invocation: compileArgv, fingerprint: inv.fingerprint, compiler: project.m.toolchain.compiler, dependencyHash: dep.hash, dependencyCount: dep.deps.length },
    compileSucceeded: cr.code === 0 && fs.existsSync(newObjAbs), compileMs, diagnostics: extractDiagnostics(cr.stdout + "\n" + cr.stderr),
    injectedMacros: injected.names.length ? injected.names : undefined,
    artifacts: { log: logPath }, cacheHit: false,
  };
  await writeFile(result.candidate.storedAt, opts.candidateText);
  if (!result.compileSucceeded) {
    if (result.diagnostics.some((d) => /Selector requires struct\/union/.test(d.message))) result.hint = "a field access through a non-struct pointer: the TU's prototype for this function (or a callee) types the argument as u8*/void*; declare the real struct type in the TU/header and regenerate";
    else if (/->unk-\d|\.unk-\d/.test(opts.candidateText)) result.hint = "m2c emitted a NEGATIVE field offset (`->unk-N`): the draft advanced a typed pointer and then indexed behind it — rewrite as an array/index expression before compiling";
    else if (/M2C_ERROR\(/.test(opts.candidateText)) result.hint = "the draft contains M2C_ERROR(...) markers: m2c could not translate those instructions; each needs a hand rewrite";
    // A clearer parse error from the host syntax check, when the project has one.
    const check = inv.steps.find((s) => s.role === "syntax-check");
    if (check) {
      const ca = retargetArgv(check.argv, { tuRel, objRel, newTu: newTuAbs, newObj: path.join(work, "check.o") });
      const chk = await run(ca[0], ca.slice(1), { cwd: project.root, env: project.env, timeoutMs: 60_000 });
      result.diagnostics.push(...extractDiagnostics(chk.stderr).map((d) => ({ ...d, from: "host-syntax-check" })));
    }
    result.exactFunctionMatch = false;
    result.distance = null;
    result.verification = { functionLocal: "compile-failed", translationUnit: "not-run", fullRom: "not-run" };
    await rm(work, { recursive: true, force: true });
    await writeFile(cachedPath, JSON.stringify(result, null, 2));
    return { ...result, elapsedMs: Date.now() - startedAt };
  }
  for (const post of inv.post) {
    const pa = retargetArgv(post, { tuRel, objRel, newTu: newTuAbs, newObj: newObjAbs });
    await run(pa[0], pa.slice(1), { cwd: project.root, env: project.env });
  }
  // Extract + compare.
  const tc = project.m.toolchain;
  const objdump = tc.objdump?.path ?? "mips-linux-gnu-objdump";
  const target = await ensureTarget(project, fn);
  let tstream = [];
  if (!target.romOnly) {
    const tdump = await dumpObject({ objdump, objPath: target.targetO, cwd: project.root, env: project.env });
    tstream = trimToSize(findSymbol(tdump, fn.symbol)?.instructions ?? [], target.sizeBytes);
  }
  const cdump = await dumpObject({ objdump, objPath: newObjAbs, cwd: project.root, env: project.env });
  const csyms = await symbolTable({ objdump, objPath: newObjAbs, cwd: project.root, env: project.env });
  const csym = findSymbol(cdump, fn.symbol);
  if (!csym) {
    result.exactFunctionMatch = false; result.distance = null;
    result.verification = { functionLocal: "symbol-missing", translationUnit: "not-run", fullRom: "not-run" };
    result.error = { code: "SYMBOL_NOT_EMITTED", message: `the compiled object has no symbol '${fn.symbol}' (did the candidate define it with that exact name? static? a different name?)`, symbolsInText: [...(cdump.sections.get(".text")?.keys() ?? [])].slice(0, 20) };
    await rm(work, { recursive: true, force: true });
    await writeFile(cachedPath, JSON.stringify(result, null, 2));
    return { ...result, elapsedMs: Date.now() - startedAt };
  }
  const cstream = trimToSize(csym.instructions, csyms.get(fn.symbol)?.size ?? 0);
  // Ground truth: link the candidate's words with the project's symbol addresses and compare to the ROM bytes.
  const romLinked = await compareAgainstRom(project, fn, cstream, csyms);
  let strict;
  if (target.romOnly) {
    // No relocatable target: strict = the ROM-linked word compare, expressed in the same shape.
    const romStream = romLinked.romStream ?? [];
    strict = strictCompare(romStream, romLinked.linkedStream ?? []);
    tstream = romStream;
  } else strict = strictCompare(tstream, cstream);
  const distance = scoreDistance(tstream, cstream);
  const classes = classifyDifferences(tstream, cstream, strict);
  const ranges = changedRanges(strict);
  const diffText = renderDiff(tstream, cstream, strict, opts.maxDiffInstructions ?? 40);
  const diffPath = path.join(candDir, `${cacheKey}.diff.json`);
  await writeFile(diffPath, JSON.stringify({ target: tstream, candidate: cstream, strict, classes }, null, 1));
  const diffTxt = path.join(candDir, `${cacheKey}.diff.txt`);
  await writeFile(diffTxt, renderDiff(tstream, cstream, strict, 100000));
  // Translation-unit verification: every OTHER function in the object must be unchanged vs the verified build object.
  let tu = { status: "not-run" };
  if (opts.verifyTu !== false) tu = await verifyTranslationUnit(project, fn, { objdump, candidateObj: newObjAbs, buildObj: project.abs(objRel), csyms });
  const { romStream: _rs, linkedStream: _ls, ...romLinkedOut } = romLinked;
  Object.assign(result, {
    targetFrom: target.romOnly ? "rom-bytes" : `asm:${target.targetFrom ?? "pragma"}`,
    exactFunctionMatch: strict.exact, targetBytes: strict.targetBytes, candidateBytes: strict.candidateBytes,
    distance, differenceKinds: classes.kinds, evidence: classes.evidence, changedRanges: ranges, strictMismatches: strict.mismatchCount,
    rodata: target.rodata.length ? { targetSymbols: target.rodata, compared: false, note: "the function's .rodata/.late_rodata is verified by the TU + full-ROM steps, not by the function-local text compare" } : { compared: true, note: "target carries no rodata" },
    romLinked: romLinkedOut,
    verification: { functionLocal: strict.exact ? "exact" : "mismatch", romLinkedBytes: romLinked.status, translationUnit: tu.status, fullRom: "not-run" }, translationUnitCheck: tu,
    diffPreview: diffText,
  });
  result.artifacts.diff = diffPath; result.artifacts.diffText = diffTxt; result.artifacts.object = null;
  await rm(work, { recursive: true, force: true });
  await writeFile(cachedPath, JSON.stringify(result, null, 2));
  return { ...result, elapsedMs: Date.now() - startedAt };
}

/**
 * Link the candidate's instruction words (symbol VAs from the linker map +
 * symbol_addrs, addends from the relocs) and compare them with the bytes the
 * base ROM holds at the function's resolved offset. This is independent of
 * the extracted asm and catches a changed call target or global reference
 * that word-equal relocatable objects could hide.
 */
async function compareAgainstRom(project, fn, cstream, csyms) {
  if (fn.romOffset == null) return { status: "no-rom-offset" };
  const ld = await project.linkerMap();
  const sa = await project.symbolAddrs();
  const local = new Map();
  // Symbols local to the candidate object (its own functions/data) sit at fn VA-relative offsets we cannot know
  // without the link; use the linker map's VA for them (same object in the verified build).
  const symbolVa = (name) => ld?.symbols.get(name)?.va ?? sa.get(name)?.va ?? local.get(name) ?? null;
  const linked = applyRelocations(cstream, symbolVa, fn.va);
  const size = cstream.length * 4;
  const rom = await project.romSlice(fn.romOffset, Math.max(size, (fn.sizeBytes ?? size)));
  const romWords = [];
  for (let i = 0; i + 4 <= rom.bytes.length; i += 4) romWords.push(rom.bytes.readUInt32BE(i));
  const n = Math.max(romWords.length, linked.stream.length);
  let mismatches = 0; const first = [];
  for (let i = 0; i < n; i++) {
    const a = romWords[i], b = linked.stream[i]?.linkedWord;
    if (a === b) continue;
    mismatches++;
    if (first.length < 8) first.push({ index: i, rom: a == null ? null : "0x" + a.toString(16).padStart(8, "0"), candidate: b == null ? null : "0x" + b.toString(16).padStart(8, "0"), mnemonic: linked.stream[i]?.mnemonic ?? null, reloc: linked.stream[i]?.reloc ?? null });
  }
  const exact = mismatches === 0 && linked.unresolved.length === 0;
  const romStream = romWords.map((w, i) => ({ offset: i * 4, word: w, mnemonic: linked.stream[i]?.mnemonic ?? "?", operands: linked.stream[i]?.operands ?? "", reloc: null }));
  const linkedStream = linked.stream.map((s) => ({ offset: s.offset, word: s.linkedWord, mnemonic: s.mnemonic, operands: s.operands, reloc: null }));
  return { romStream, linkedStream, status: exact ? "exact" : linked.unresolved.length && mismatches === 0 ? "unresolved-relocations" : "mismatch", romOffset: fn.romOffsetHex, romBytesSha1: rom.sha1, romWords: romWords.length, candidateWords: linked.stream.length, mismatches, first, unresolvedSymbols: linked.unresolved.slice(0, 12),
    note: "candidate words linked with the project's symbol addresses vs the base ROM bytes at the resolved offset; independent of the extracted asm" };
}

/** Compare every other .text symbol of the candidate object with the verified build object. */
async function verifyTranslationUnit(project, fn, { objdump, candidateObj, buildObj, csyms }) {
  if (!fs.existsSync(buildObj)) return { status: "no-build-object", note: `${path.relative(project.root, buildObj)} does not exist; run the project build first` };
  const bdump = await dumpObject({ objdump, objPath: buildObj, cwd: project.root, env: project.env });
  const cdump = await dumpObject({ objdump, objPath: candidateObj, cwd: project.root, env: project.env });
  const bsyms = await symbolTable({ objdump, objPath: buildObj, cwd: project.root, env: project.env });
  const btext = bdump.sections.get(".text") ?? new Map();
  const ctext = cdump.sections.get(".text") ?? new Map();
  const changed = [], missing = [], added = [];
  for (const [name, b] of btext) {
    if (name === fn.symbol || name.endsWith(".NON_MATCHING")) continue;
    const c = ctext.get(name);
    if (!c) { missing.push(name); continue; }
    const bs = trimToSize(b.instructions, bsyms.get(name)?.size ?? 0), cs = trimToSize(c.instructions, csyms.get(name)?.size ?? 0);
    const s = strictCompare(bs, cs);
    if (!s.exact) changed.push({ symbol: name, mismatches: s.mismatchCount, targetBytes: s.targetBytes, candidateBytes: s.candidateBytes });
  }
  for (const name of ctext.keys()) if (!btext.has(name) && name !== fn.symbol && !name.endsWith(".NON_MATCHING")) added.push(name);
  // Section sizes as evidence for rodata/data effects.
  const sec = async (o) => { const r = await run(objdump, ["-h", o], { cwd: project.root, env: project.env }); const out = {}; for (const m of r.stdout.matchAll(/^\s*\d+\s+(\.\S+)\s+([0-9a-f]+)/gm)) out[m[1]] = parseInt(m[2], 16); return out; };
  const bsec = await sec(buildObj), csec = await sec(candidateObj);
  const sizeDiffs = Object.keys({ ...bsec, ...csec }).filter((k) => /^\.(rodata|data|bss|sdata|sbss|text)$/.test(k) && bsec[k] !== csec[k]).map((k) => ({ section: k, build: bsec[k] ?? 0, candidate: csec[k] ?? 0 }));
  const ok = changed.length === 0 && missing.length === 0 && added.length === 0;
  return { status: ok ? "other-functions-unchanged" : "side-effects", otherFunctionsChanged: changed.slice(0, 20), missingSymbols: missing.slice(0, 20), addedSymbols: added.slice(0, 20), sectionSizeDifferences: sizeDiffs,
    note: ok ? (sizeDiffs.length ? "no other .text symbol changed; section sizes differ (expected when the candidate's rodata/text replaces the asm's) — full-ROM verify is the final word" : "no other .text symbol changed and section sizes are identical") : "the candidate changed code OUTSIDE the target function — a local match would hide this" };
}

/** Pull file:line: message diagnostics out of compiler output (IDO + gcc shapes). */
function extractDiagnostics(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^"?([^":\s]+\.[ch])"?,? line (\d+): (\w+)?:?\s*(.*)$/.exec(line))) out.push({ file: m[1], line: Number(m[2]), severity: (m[3] ?? "error").toLowerCase(), message: m[4].trim() });
    else if ((m = /^([^:\s]+\.[ch]):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.*)$/.exec(line))) out.push({ file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, severity: m[4], message: m[5].trim() });
    else if (/^cfe: (Error|Warning)/.test(line)) out.push({ severity: /Error/.test(line) ? "error" : "warning", message: line.trim() });
  }
  return out.slice(0, 40);
}

/** #defines for the M2C_* macros a candidate uses (m2c_macros.h semantics; only the referenced ones). */
const M2C_MACROS = {
  M2C_FIELD: "#define M2C_FIELD(expr, type_ptr, offset) (*(type_ptr)((s8 *)(expr) + (offset)))",
  M2C_BITWISE: "#define M2C_BITWISE(type, expr) ((type)(expr))",
  M2C_LWL: "#define M2C_LWL(expr) (expr)",
  M2C_FIRST3BYTES: "#define M2C_FIRST3BYTES(expr) (expr)",
  M2C_UNALIGNED32: "#define M2C_UNALIGNED32(expr) (expr)",
  M2C_ERROR: "#define M2C_ERROR(desc) (0)",
  M2C_TRAP_IF: "#define M2C_TRAP_IF(cond) (0)",
  M2C_BREAK: "#define M2C_BREAK() (0)",
  M2C_SYNC: "#define M2C_SYNC() (0)",
  M2C_CARRY: "#define M2C_CARRY 0",
  M2C_OVERFLOW: "#define M2C_OVERFLOW(a) (0)",
  M2C_MEMCPY_ALIGNED: "#define M2C_MEMCPY_ALIGNED memcpy",
  M2C_MEMCPY_UNALIGNED: "#define M2C_MEMCPY_UNALIGNED memcpy",
  M2C_STRUCT_COPY: "#define M2C_STRUCT_COPY memcpy",
};
export function m2cMacroDefinitions(candidateText) {
  const names = [...new Set((candidateText.match(/\bM2C_[A-Z0-9_]+\b/g) ?? []))].filter((n) => M2C_MACROS[n]);
  const needMemcpy = names.some((n) => /MEMCPY|STRUCT_COPY/.test(n)) && !/\bmemcpy\s*\(/.test(candidateText) ? false : false;
  const lines = names.map((n) => M2C_MACROS[n]);
  if (names.some((n) => /MEMCPY|STRUCT_COPY/.test(n))) lines.push("void* memcpy(void*, const void*, unsigned int);");
  return { names, text: lines.length ? lines.join("\n") + "\n" : "" };
}
