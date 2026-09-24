// ledger.js - what "100% decompiled" actually means, measured per dimension.
//
// `progress` reports CPU code honestly and says outright that data and assets
// are not tracked. That is the right kind of honesty and it leaves the real
// question unanswerable: this ROM has 7,238,640 bytes inside `bin` ranges -
// 86.3% of the image - and none of it is code.
//
// TWO NUMBERS ARE BOTH WRONG. "54.4% done" ignores everything that is not CPU
// code. "86.3% undecompiled" is worse: those bin ranges are compressed assets,
// audio banks and microcode, much of which is legitimately shipped as data and
// was never going to become C.
//
// So the ledger refuses to produce one percentage. It reports independent
// dimensions, each with its own denominator and its own acceptance policy, and
// a single roll-up only when the project has declared weights. A number nobody
// defined the meaning of is the thing that lets a mixed build be called a
// finished decompilation.
//
// Range states, weakest to strongest:
//   raw                  bytes, nothing known
//   format-identified    we know what it is
//   round-trip-tool      a tool can unpack AND repack it byte-exactly
//   editable-source      it exists as editable source in the tree
//   semantically-reviewed a human has checked it means what it says
//   policy-retained      deliberately kept as-is (handwritten asm, vendor blobs)
//
// Plain JS ESM + JSDoc.


export const LEDGER_SCHEMA = "romdev-decomp-ledger-v1";

export const RANGE_STATES = Object.freeze({
  raw: "bytes only - nothing is known about this range",
  "format-identified": "the format is known; no round-trip tool yet",
  "round-trip-tool": "a tool unpacks AND repacks it byte-exactly",
  "editable-source": "present as editable source in the tree",
  "semantically-reviewed": "a human has confirmed it means what it says",
  "policy-retained": "deliberately retained as-is (handwritten asm, vendor blob)",
});

export const DIMENSIONS = Object.freeze([
  "game-cpu-code", "library-code", "handwritten-asm-retained", "rsp-code",
  "initialized-data", "bss-layout", "compressed-archives", "textures-models-animation",
  "audio-banks", "symbol-type-quality", "source-confidence-debt", "build-verification",
]);

/**
 * Build the ledger from the splat map, the linker map and the progress report.
 *
 * @param {import("./project.js").Project} project
 * @param {{progress?:object, workClasses?:object}} [ctx]
 */
export async function buildLedger(project, { progress, workClasses } = {}) {
  const map = await project.map();
  const romBytes = project.m.rom?.bytes ?? null;

  // ── ROM ranges, by subsegment type ──
  const byType = new Map();
  let mapped = 0;
  const add = (type, size, name) => {
    if (!size) return;
    const t = type || "(untyped)";
    const e = byType.get(t) ?? { type: t, bytes: 0, count: 0, examples: [] };
    e.bytes += size; e.count++;
    if (e.examples.length < 4) e.examples.push(name);
    byType.set(t, e);
    mapped += size;
  };
  for (const seg of map.segments) {
    const subs = seg.subsegments ?? [];
    if (subs.length) {
      for (const sub of subs) add(sub.type, Math.max(0, (sub.romEnd ?? 0) - (sub.romStart ?? 0)), sub.name);
      // A segment's own bytes beyond what its subsegments cover.
      const covered = subs.reduce((a, x) => a + Math.max(0, (x.romEnd ?? 0) - (x.romStart ?? 0)), 0);
      const own = Math.max(0, (seg.romEnd ?? 0) - (seg.romStart ?? 0)) - covered;
      if (own > 0) add(seg.type, own, `${seg.name} (uncovered)`);
    } else {
      // A TOP-LEVEL SEGMENT WITH NO SUBSEGMENTS STILL HAS BYTES. Walking only
      // subsegments lost 4,890,448 of them here - every large `bin` asset
      // segment - and the ledger then under-reported the opaque bucket by more
      // than half the ROM while calling the remainder "unmapped".
      add(seg.type, Math.max(0, (seg.romEnd ?? 0) - (seg.romStart ?? 0)), seg.name);
    }
  }

  // A state per range TYPE, with the reason it is in that state.
  const STATE_OF = {
    c: ["editable-source", "compiled from C in the tree"],
    hasm: ["policy-retained", "handwritten assembly the project deliberately keeps"],
    hcode: ["policy-retained", "handwritten code the project deliberately keeps"],
    hdata: ["policy-retained", "handwritten data the project deliberately keeps"],
    asm: ["raw", "extracted assembly still awaiting decompilation"],
    bin: ["raw", "opaque bytes: format not identified by this tool"],
    ".data": ["format-identified", "linked data, structure not necessarily named"],
    ".rodata": ["format-identified", "linked rodata, structure not necessarily named"],
    ".bss": ["format-identified", "zero-initialised; layout known, ownership may not be"],
    bss: ["format-identified", "zero-initialised; layout known, ownership may not be"],
    rodata: ["format-identified", "linked rodata"],
    data: ["format-identified", "linked data"],
  };

  const ranges = [...byType.values()].map((e) => {
    const [state, why] = STATE_OF[e.type] ?? ["raw", "no policy recorded for this subsegment type"];
    return { type: e.type, bytes: e.bytes, subsegments: e.count, state, stateMeaning: RANGE_STATES[state], why, examples: e.examples };
  }).sort((a, b) => b.bytes - a.bytes);

  const byState = {};
  for (const r of ranges) {
    byState[r.state] = byState[r.state] ?? { bytes: 0, types: [] };
    byState[r.state].bytes += r.bytes;
    byState[r.state].types.push(r.type);
  }

  // ── dimensions ──
  const g = progress?.game, lib = progress?.library, hasm = progress?.handwrittenAsm;
  const pct = (c, a) => ((c + a) ? Math.round((c / (c + a)) * 1000) / 10 : null);

  const dims = {
    "game-cpu-code": g ? {
      unit: "code bytes", inC: g.cBytes, inAsm: g.asmBytes, percentInC: pct(g.cBytes, g.asmBytes),
      functionsRemaining: g.asmFunctions,
      policy: "the decompilation target; this is the number that means 'decompiled'",
    } : { unavailable: "no progress report" },
    "library-code": lib ? {
      unit: "code bytes", inC: lib.cBytes, inAsm: lib.asmBytes, percentInC: pct(lib.cBytes, lib.asmBytes),
      functionsRemaining: lib.asmFunctions,
      policy: "SDK code: published sources exist. Matching known source counts as done; hand-decompiling is the fallback.",
    } : { unavailable: "no progress report" },
    "handwritten-asm-retained": hasm ? {
      unit: "code bytes", bytes: hasm.asmBytes + hasm.cBytes, functions: hasm.functions,
      state: "policy-retained",
      policy: "counts in completion accounting and is NEVER a C-recovery task. Excluded from the decompilation denominator by project policy.",
    } : { unavailable: "no progress report" },
    "rsp-code": { unit: "bytes", bytes: workClasses?.counts?.["rsp-source"]?.bytes ?? 0,
      state: "raw", policy: "RSP microcode: a different ISA and toolchain. Needs exact assembly + boundary validation, not C." },
    "initialized-data": { unit: "ROM bytes", bytes: (byType.get(".data")?.bytes ?? 0) + (byType.get("data")?.bytes ?? 0) + (byType.get(".rodata")?.bytes ?? 0) + (byType.get("rodata")?.bytes ?? 0),
      state: "format-identified", policy: "linked and byte-exact, but symbol OWNERSHIP and structure are a separate question this tool does not answer." },
    "bss-layout": { unit: "ROM bytes", bytes: (byType.get(".bss")?.bytes ?? 0) + (byType.get("bss")?.bytes ?? 0),
      state: "format-identified", policy: "layout is known from the map; named ownership is not tracked here." },
    "compressed-archives": { unit: "ROM bytes", bytes: byType.get("bin")?.bytes ?? 0,
      state: "raw", policy: "OPAQUE to this tool. This is the number that must NOT be called 'undecompiled': it includes compressed assets, "
        + "audio banks and microcode, much of which legitimately ships as data. Identifying formats moves bytes out of this bucket." },
    "textures-models-animation": { unit: "ROM bytes", bytes: null, state: "raw",
      policy: "not separable from `compressed-archives` until an asset round-trip tool identifies the formats." },
    "audio-banks": { unit: "ROM bytes", bytes: null, state: "raw",
      policy: "not separable until the audio bank/sequence formats are identified." },
    "symbol-type-quality": { unit: "judgement", policy: "how many symbols and struct fields carry real names and types rather than unk_/D_ placeholders. Not a byte count and must not be folded into one." },
    "source-confidence-debt": { unit: "judgement",
      policy: "explicit FAKE constructs, overwritten-assignment matches, opaque struct fields. A byte-exact build does NOT settle these - "
        + "that is precisely why exactness and source quality are separate dimensions." },
    "build-verification": {
      builtRomMatchesBase: progress?.builtRomMatchesBase ?? null,
      policy: "a matching ROM proves the MIXED C/asm build is byte-exact. It does not prove the game is decompiled, and the two must never "
        + "be reported as the same fact." },
  };

  return {
    schema: LEDGER_SCHEMA, project: project.id, builtAt: new Date().toISOString(),
    rom: { bytes: romBytes, mappedBytes: mapped, unmappedBytes: romBytes != null ? romBytes - mapped : null },
    dimensions: dims,
    romRanges: { byType: ranges, byState },
    rangeStates: RANGE_STATES,
    rollUp: null,
    policy: "NO single percentage is produced. Each dimension has its own denominator and acceptance policy, and collapsing them requires "
      + "weights the PROJECT must declare - a number whose meaning nobody defined is what lets a matching mixed build be called a finished "
      + "decompilation. '54.4% of code bytes are C' and '86.3% of the ROM is bin ranges' are both true and neither is a completion figure.",
  };
}
