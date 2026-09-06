// progress.js — honest progress from the SELECTED BUILD's actual objects, not
// from pragma counts or a README badge. States are reported separately and
// never collapsed into one percentage:
//   asm            GLOBAL_ASM functions (the .NON_MATCHING symbol exists)
//   c              C functions in the verified build (no .NON_MATCHING twin)
//   hasm           handwritten-asm subsegments (policy: not decompilation targets)
//   library        libultra objects (reported apart from game code)
//   data           data/rodata/bss bytes, and GLOBAL_ASM data references
// Denominators are code bytes from the map's .text symbols per object.
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";

export async function computeProgress(project) {
  const ld = await project.linkerMap();
  if (!ld) return { ok: false, error: "no linker map — build the project first", map: project.m.built?.map };
  const map = await project.map();
  const srcRoot = project.m.splat.srcPath;
  const buildPath = project.m.splat.buildPath;
  // Which subsegments are hasm (policy) / library / data.
  const hasmObjs = new Set(), subTypes = new Map();
  for (const seg of map.segments) for (const sub of seg.subsegments) { subTypes.set(path.basename(sub.name), sub.type); if (sub.type === "hasm") hasmObjs.add(path.basename(sub.name)); }
  const perObject = new Map();
  const nonMatching = new Set([...ld.symbols.keys()].filter((n) => n.endsWith(".NON_MATCHING")).map((n) => n.slice(0, -".NON_MATCHING".length)));
  for (const s of ld.symbols.values()) {
    if (s.section !== ".text" || !s.size || s.name.endsWith(".NON_MATCHING")) continue;
    if (!s.object.startsWith(buildPath + "/" + srcRoot + "/") && !s.object.startsWith(buildPath + "/asm/")) continue;
    const obj = s.object;
    if (!perObject.has(obj)) perObject.set(obj, { object: obj, functions: 0, asmFunctions: 0, cBytes: 0, asmBytes: 0, asmList: [] });
    const o = perObject.get(obj);
    o.functions++;
    if (nonMatching.has(s.name)) { o.asmFunctions++; o.asmBytes += s.size; o.asmList.push({ symbol: s.name, bytes: s.size }); } else o.cBytes += s.size;
  }
  const classify = (obj) => {
    const base = path.basename(obj, ".o");
    if (obj.includes("/libultra/")) return "library";
    if (hasmObjs.has(base) || obj.startsWith(buildPath + "/asm/")) return "hasm";
    return "game";
  };
  const groups = { game: { objects: 0, functions: 0, cFunctions: 0, asmFunctions: 0, cBytes: 0, asmBytes: 0 }, library: { objects: 0, functions: 0, cFunctions: 0, asmFunctions: 0, cBytes: 0, asmBytes: 0 }, hasm: { objects: 0, functions: 0, cFunctions: 0, asmFunctions: 0, cBytes: 0, asmBytes: 0 } };
  const objects = [];
  for (const o of perObject.values()) {
    const g = groups[classify(o.object)];
    g.objects++; g.functions += o.functions; g.asmFunctions += o.asmFunctions; g.cFunctions += o.functions - o.asmFunctions; g.cBytes += o.cBytes; g.asmBytes += o.asmBytes;
    objects.push({ object: o.object, group: classify(o.object), functions: o.functions, asmFunctions: o.asmFunctions, cBytes: o.cBytes, asmBytes: o.asmBytes, largestAsm: o.asmList.sort((a, b) => b.bytes - a.bytes).slice(0, 3) });
  }
  // Data references still in GLOBAL_ASM (pragmas whose .s has no glabel).
  let dataRefs = 0, funcRefs = 0, conditionalRefs = 0;
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".c")) scan(f); } };
  const scan = (f) => {
    const text = fs.readFileSync(f, "utf8");
    let depth = 0;
    for (const line of text.split("\n")) {
      if (/^\s*#\s*if/.test(line)) depth++;
      else if (/^\s*#\s*endif/.test(line)) depth = Math.max(0, depth - 1);
      const m = /^\s*#pragma\s+GLOBAL_ASM\("([^"]+)"\)/.exec(line);
      if (!m) continue;
      if (depth > 0) conditionalRefs++;
      const asm = project.abs(m[1]);
      let isFunc = false;
      try { isFunc = /^glabel\s/m.test(fs.readFileSync(asm, "utf8")); } catch {}
      if (isFunc) funcRefs++; else dataRefs++;
    }
  };
  if (fs.existsSync(project.abs(srcRoot))) walk(project.abs(srcRoot));
  // C functions that keep assembly inside them are NOT recovered C: count them apart.
  const inlineAsm = [];
  const walk2 = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk2(f); else if (e.name.endsWith(".c")) { const t = fs.readFileSync(f, "utf8"); if (/\b(__asm__|asm)\s*(volatile\s*)?\(/.test(t)) inlineAsm.push(path.relative(project.root, f)); } } };
  if (fs.existsSync(project.abs(srcRoot))) walk2(project.abs(srcRoot));
  const romBuilt = project.m.built?.rom ? project.abs(project.m.built.rom) : null;
  let romMatches = null;
  if (romBuilt && fs.existsSync(romBuilt)) { const { sha1File } = await import("./project.js"); romMatches = (await sha1File(romBuilt)) === project.m.rom.sha1; }
  const pct = (c, a) => (c + a) ? Math.round((c / (c + a)) * 1000) / 10 : null;
  return {
    ok: true, source: { linkerMap: project.m.built.map, method: "per-object .text symbol sizes from the linker map; a function is 'asm' when its .NON_MATCHING twin symbol exists (GLOBAL_ASM)" },
    builtRomMatchesBase: romMatches, caveat: "a matching ROM can still contain assembly: builtRomMatchesBase says the mixed C/asm build is byte-exact, NOT that the game is decompiled",
    game: { ...groups.game, codeBytesInC_percent: pct(groups.game.cBytes, groups.game.asmBytes) },
    library: { ...groups.library, codeBytesInC_percent: pct(groups.library.cBytes, groups.library.asmBytes) },
    handwrittenAsm: { ...groups.hasm, policy: "hasm subsegments are excluded from the decompilation denominator" },
    pragmas: { functionReferences: funcRefs, dataReferences: dataRefs, insideConditionalBlocks: conditionalRefs, note: "pragma counts are a WORK QUEUE (conditional references included), not a completion percentage" },
    retainedAssemblyInC: { files: inlineAsm, note: inlineAsm.length ? "these TUs keep inline asm: their functions count as C in the byte totals above but are NOT recovered C" : "no inline asm in any TU" },
    states: { asm: "GLOBAL_ASM (the .NON_MATCHING twin exists)", pseudocodeDraft: "candidates/<func>/gen-*.c in the workspace (never in the tree)", compilableC: "a compare result with compileSucceeded and no exact match", functionMatchingC: "exactFunctionMatch + romLinked exact", integratedRomVerified: "integrate apply:true with fullRom byte-exact", reviewedTypes: "the project's headers (not tracked here)", data: "dataReferences above + bin/ assets (not tracked here)" },
    objects: objects.sort((a, b) => b.asmBytes - a.asmBytes).slice(0, 40),
  };
}
