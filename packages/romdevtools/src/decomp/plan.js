// plan.js - work selection over the call graph, so related functions are
// decompiled together and type information is shared, and so the queue is
// ordered by expected payoff (code bytes) rather than by "shortest first",
// which inflates the function count while leaving most bytes untouched.
//
// The graph comes from the build's objects (relocation records: every
// R_MIPS_26 is a static call edge) and from the extracted asm of the
// functions still in assembly. Nothing is inferred from names.
import fs from "node:fs";
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dumpObject } from "./mips-obj.js";
import { VERIFIER_VERSION } from "./verdict.js";
import { measurementSnapshot, storedMeasurementFreshness } from "./measurement.js";
import { listExperiments, experimentCooldown } from "./experiment.js";

/** The parser/producer version baked into the call-graph fingerprint: bump it
 *  when the graph's SHAPE changes, so old caches are rejected on sight. */
export const CALLGRAPH_VERSION = 2;

/**
 * Content-addressed fingerprint of everything the call graph is derived from.
 *
 * The old stamp was the SUM of object mtimes. A sum collides trivially (two
 * files swapping timestamps, or any compensating pair of changes), carries no
 * path or size information, is blind to a file being replaced by a
 * same-length, same-time variant, and was not tied to the linker map or to the
 * parser version at all - so a graph built by an older romdev stayed "valid"
 * forever.
 *
 * This hashes the linker map's identity plus every contributing object's path,
 * size and content hash, under a version tag. Content hashing the objects of
 * one N64 game is a few hundred files and is cheap next to the objdump pass the
 * cache exists to avoid.
 */
async function callGraphFingerprint(project, ld, objects) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  h.update(`callgraph-v${CALLGRAPH_VERSION}\n`);
  // The linker map itself: a relink changes the graph even if no object did.
  const mapPath = project.m.built?.map ? project.abs(project.m.built.map) : null;
  if (mapPath && fs.existsSync(mapPath)) {
    const st = fs.statSync(mapPath);
    h.update(`map ${path.basename(mapPath)} ${st.size} ${await sha256File(mapPath)}\n`);
  } else h.update("map (none)\n");
  h.update(`symbols ${ld.symbols.size} objects ${objects.length}\n`);
  // Sorted, so the fingerprint does not depend on directory iteration order.
  const parts = [];
  for (const o of [...objects].sort()) {
    const abs = project.abs(o);
    try {
      const st = fs.statSync(abs);
      parts.push(`${o} ${st.size} ${await sha256File(abs)}`);
    } catch { parts.push(`${o} MISSING`); }
  }
  for (const line of parts) h.update(line + "\n");
  return { fingerprint: h.digest("hex").slice(0, 32), objectCount: objects.length, version: CALLGRAPH_VERSION };
}

/** sha256 of a file, streamed. */
async function sha256File(p) {
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256");
  const fd = await (await import("node:fs/promises")).open(p, "r");
  try {
    const buf = Buffer.alloc(1 << 16);
    for (;;) { const { bytesRead } = await fd.read(buf, 0, buf.length, null); if (!bytesRead) break; h.update(buf.subarray(0, bytesRead)); }
  } finally { await fd.close(); }
  return h.digest("hex").slice(0, 16);
}

/** Build (and cache, keyed by a content-addressed fingerprint) the static call graph. */
export async function callGraph(project, { force = false } = {}) {
  const ld = await project.linkerMap();
  if (!ld) throw Object.assign(new Error("no linker map - build the project first"), { code: "NO_BUILD" });
  const cache = path.join(project.ws, "callgraph.json");
  const objects = [...ld.objects.keys()].filter((o) => o.startsWith(project.m.splat.buildPath + "/" + project.m.splat.srcPath + "/"));
  const fp = await callGraphFingerprint(project, ld, objects);
  if (!force && fs.existsSync(cache)) {
    try {
      const c = JSON.parse(await readFile(cache, "utf8"));
      // Fingerprint AND version must both match: a graph written by an older
      // producer is rejected even if the inputs are byte-identical.
      if (c.fingerprint === fp.fingerprint && c.callgraphVersion === CALLGRAPH_VERSION) return c;
    } catch {}
  }
  const objdump = project.m.toolchain.objdump?.path ?? "mips-linux-gnu-objdump";
  const edges = new Map(); // caller → Set(callee)
  const sizes = new Map(), state = new Map(), objOf = new Map();
  const nonMatching = new Set([...ld.symbols.keys()].filter((n) => n.endsWith(".NON_MATCHING")).map((n) => n.slice(0, -13)));
  for (const s of ld.symbols.values()) if (s.section === ".text" && s.size && !s.name.endsWith(".NON_MATCHING")) { sizes.set(s.name, s.size); state.set(s.name, nonMatching.has(s.name) ? "asm" : "c"); objOf.set(s.name, s.object); }
  for (const o of objects) {
    const abs = project.abs(o);
    if (!fs.existsSync(abs)) continue;
    let dump;
    try { dump = await dumpObject({ objdump, objPath: abs, cwd: project.root, env: project.env }); } catch { continue; }
    for (const [name, sym] of dump.sections.get(".text") ?? []) {
      if (name.endsWith(".NON_MATCHING")) continue;
      for (const ins of sym.instructions) {
        if (ins.reloc && ins.reloc.type === "R_MIPS_26") { if (!edges.has(name)) edges.set(name, new Set()); edges.get(name).add(ins.reloc.symbol); }
      }
    }
  }
  const callers = new Map();
  for (const [a, set] of edges) for (const b of set) { if (!callers.has(b)) callers.set(b, new Set()); callers.get(b).add(a); }
  const out = { fingerprint: fp.fingerprint, callgraphVersion: CALLGRAPH_VERSION, objectCount: fp.objectCount, builtAt: new Date().toISOString(), functions: [...sizes.keys()].length,
    edges: Object.fromEntries([...edges].map(([k, v]) => [k, [...v]])), callers: Object.fromEntries([...callers].map(([k, v]) => [k, [...v]])),
    sizes: Object.fromEntries(sizes), state: Object.fromEntries(state), object: Object.fromEntries(objOf) };
  await mkdir(project.ws, { recursive: true });
  await writeFile(cache, JSON.stringify(out));
  return out;
}

/**
 * Rank the remaining asm functions and group them into batches that share
 * types: a batch is the asm functions of one TU that call or are called by
 * each other (connected components of the asm-only subgraph), plus their
 * already-C neighbours as context. Score = expected payoff.
 */
/**
 * Ranking objectives. §10: "A request for another 15 verified functions
 * benefits from a different queue than a request to recover the most bytes or
 * unlock a shared type."
 *
 * The default (byte coverage) is kept, because changing what an existing
 * caller's queue means would be worse than not offering the choice. Every
 * objective reports the FACTORS it used rather than inventing a completion
 * estimate, which the report explicitly did not want.
 */
export const PLAN_OBJECTIVES = Object.freeze({
  "byte-coverage": "recover the most code bytes: ranks large routines first. The default, and the right queue for a percentage goal.",
  "function-count": "finish the most FUNCTIONS: ranks small, well-constrained targets first. The right queue for 'another 15 verified functions'.",
  "shared-type": "unlock shared types: ranks functions whose typed C neighbours already pin their structs, so one type fix lands for several callers.",
  "diagnostic-research": "learn the most: ranks functions that have been ATTEMPTED and are close, where a residual diagnosis can say something concrete.",
});

/** Score one row under an objective. Factors are reported, never hidden. */
function objectiveScore(r, objective) {
  const size = r.sizeBytes ?? 0;
  const typed = (r.cCallees ?? 0) + (r.cCallers ?? 0);
  const attempted = (r.attempts ?? 0) > 0;
  const near = r.lastDistance != null ? r.lastDistance : null;
  switch (objective) {
    case "function-count": {
      // Smaller is better, but a target with NO evidence is a coin flip, so a
      // known-close one outranks an unmeasured one of the same size.
      const sizeTerm = 1 / Math.max(1, size);
      const evidenceTerm = near != null ? 1 / (1 + near) : 0.15;
      const score = Math.round(1e6 * sizeTerm * (1 + 2 * evidenceTerm) * (1 + 0.1 * Math.min(typed, 5)));
      return { score, factors: { sizeBytes: size, lastDistance: near, typedNeighbours: typed,
        note: "smaller first, with a measured-close target preferred over an unmeasured one of the same size" } };
    }
    case "shared-type": {
      const score = Math.round(typed * 1000 + size / 100);
      return { score, factors: { typedNeighbours: typed, sizeBytes: size,
        note: "typed C neighbours already pin this function's structs, so the type work is shared with them" } };
    }
    case "diagnostic-research": {
      // Only attempted functions can teach anything: an unmeasured one has no
      // residual to diagnose.
      const score = attempted && near != null ? Math.round(10000 / (1 + near)) : 0;
      return { score, factors: { attempts: r.attempts ?? 0, lastDistance: near,
        note: attempted ? "a measured residual can be diagnosed; closer residuals are usually more informative" : "never measured: nothing to diagnose yet, so it ranks last under this objective" } };
    }
    default:
      return { score: r.payoff, factors: { sizeBytes: size, payoff: r.payoff, note: "expected recovered bytes, discounted by uncertainty" } };
  }
}

export async function planWork(project, { limit = 40, offset = 0, objective = "byte-coverage", tu, evidence, forceGraph = false, workClass, includeAllClasses = false,
  ignoreCooldown = false, cooldownBatches = 3, cooldownMinutes = 60, proposedLever } = {}) {
  if (!PLAN_OBJECTIVES[objective]) {
    throw Object.assign(new Error(`unknown plan objective '${objective}'. Choose one of: ${Object.keys(PLAN_OBJECTIVES).join(", ")}.`), { code: "BAD_ARGS" });
  }
  const g = await callGraph(project, { force: forceGraph });
  const { makeWorkClassifier, DEFAULT_QUEUE_CLASSES, WORK_CLASSES, WORK_CLASS_POLICY, emptyClassTally } = await import("./work-class.js");
  const classify = makeWorkClassifier(await project.map(), project.m);

  const allAsm = Object.keys(g.state).filter((n) => g.state[n] === "asm" && (!tu || objectToTu(g.object[n], project) === tu));

  // WHAT KIND OF WORK IS THIS. The queue used to collapse game C targets,
  // libultra routines and handwritten assembly into one list, which contradicts
  // the project's own policy (handwritten asm is excluded from the
  // decompilation denominator) and makes the count unreadable.
  const classOf = new Map(allAsm.map((n) => [n, classify(g.object[n], n)]));
  const byClass = emptyClassTally();
  for (const n of allAsm) {
    const c = byClass[classOf.get(n)];
    if (c) { c.functions++; c.bytes += g.sizes[n] ?? 0; }
  }

  const wanted = new Set(
    includeAllClasses ? WORK_CLASSES
      : workClass ? (Array.isArray(workClass) ? workClass : [workClass])
      : DEFAULT_QUEUE_CLASSES);
  const asm = allAsm.filter((n) => wanted.has(classOf.get(n)));
  // Compute the CURRENT dependency hash of every TU that owns a remaining
  // function, so evidence is matched against the source tree as it is now
  // rather than against whichever result file was written most recently.
  // One hash per TU, not per function - the TUs are far fewer.
  const currentDependencyHashes = await currentDepHashes(project, asm, g);
  const hints = evidence ?? (await loadCandidateEvidence(project, { currentDependencyHashes }));
  const experiments = await listExperiments(project);
  // PRIOR ART. A queue row showing `attempts: 0` next to 54 drafts on disk is
  // what sent an agent to rebuild a function from scratch that was already one
  // difference away. Imported research never affects payoff or ranking - it is
  // a CLAIM, not a measurement - but the row must not imply the work is
  // untouched when it is not.
  let researchLeads = new Map();
  try { researchLeads = await (await import("./research.js")).researchBySymbol(project); } catch {}
  const rows = asm.map((n) => {
    const size = g.sizes[n] ?? 0;
    const callees = g.edges[n] ?? [], callersOf = g.callers[n] ?? [];
    const asmCallees = callees.filter((c) => g.state[c] === "asm"), cCallees = callees.filter((c) => g.state[c] === "c");
    const asmCallers = callersOf.filter((c) => g.state[c] === "asm"), cCallers = callersOf.filter((c) => g.state[c] === "c");
    const h = hints[n] ?? {};
    // Uncertainty: what the last attempts told us (0 = never tried).
    const uncertainty = h.lastDistance == null ? 0.5 : Math.min(1, h.lastDistance / Math.max(1, size / 4)) ;
    const typedNeighbours = cCallees.length + cCallers.length;
    // Payoff: bytes recovered, discounted by uncertainty, boosted when typed C neighbours already pin the types.
    const payoff = Math.round(size * (1 - 0.5 * uncertainty) * (1 + 0.1 * Math.min(typedNeighbours, 5)));
    // The overlay this function belongs to, when it has one. A bare symbol is
    // ambiguous where overlays share VAs, so every row carries its own half of
    // the identity rather than making the caller reconstruct it.
    // Comparison identity names ordinary segments too (e.g. main_segment).
    // A path-only overlay heuristic erased that identity and disconnected
    // otherwise-current measured experiments from the planner's cooldown.
    const segment = h.latestSegment ?? segmentOfObject(g.object[n]);
    return { symbol: n, ...(segment ? { segment } : {}), sizeBytes: size, object: g.object[n], tu: objectToTu(g.object[n], project), asmCallees, cCallees: cCallees.length, asmCallers, cCallers: cCallers.length, statically: callersOf.length === 0 ? "unreferenced (no static caller: a table/pointer target or dead)" : `${callersOf.length} static callers`,
      attempts: h.attempts ?? 0, lastDistance: h.lastDistance ?? null, lastCompile: h.lastCompile ?? null, placeholderPrototype: h.placeholderPrototype ?? null, payoff,
      workClass: classOf.get(n),
      // Evidence identity, so a score can be traced to the tree it was measured on.
      evidenceDependencyHash: h.dependencyHash ?? null,
      evidenceFreshness: h.freshness ?? "unmeasured",
      ...(h.historicalAttempts ? { historicalAttempts: h.historicalAttempts, historicalBestDistance: h.historicalBestDistance ?? null } : {}),
      ...(h.staleEvidenceWarning ? { staleEvidenceWarning: h.staleEvidenceWarning } : {}),
      // §10: four DIFFERENT states, previously collapsed into `attempts: 0`.
      // "Avoid treating low numerical distance as automatically easy: a
      // one-word branch residue can require deeper work than a larger
      // structural mismatch." So this states what is KNOWN, not how hard it is.
      evidenceState: h.freshness === "unknown" ? "current-identity-unavailable" : (h.attempts ?? 0) > 0 ? "active-current-tree-candidate"
        : h.historicalAttempts ? "historical-candidate-needs-refresh"
        : researchLeads.has(n) ? "research-drafts-exist-unmeasured"
        : "no-api-measurement",
      evidenceStateMeaning: h.freshness === "unknown" ? "current input identity could not be established; stored measurements are not current ranking evidence" : (h.attempts ?? 0) > 0
        ? "measured against the CURRENT tree: lastDistance is a real number for this source"
        : h.historicalAttempts
          ? "measured, but against a DIFFERENT tree: the numbers do not apply until refreshed"
          : researchLeads.has(n)
            ? "drafts exist on disk that romdev has never compiled: unknown, not untouched"
            : "no measurement and no known draft: genuinely unexplored as far as anything on this machine records",
      ...(researchLeads.has(n) ? { priorArt: {
        drafts: researchLeads.get(n).drafts.length,
        claimedBestDistance: researchLeads.get(n).claimedBestDistance ?? null,
        state: researchLeads.get(n).state,
        note: (h.attempts ?? 0) === 0
          ? "this row has no API-measured attempt, but prior drafts/notes EXIST on disk - decomp({op:'research', action:'status', symbol}) lists them. Do not treat it as never attempted."
          : "prior research exists alongside the measured attempts; the numbers in notes are claims until refreshed",
      } } : {}) };
  }).map((r) => {
    // The objective's score and the FACTORS behind it, so a caller can see why
    // a row ranks where it does instead of trusting an opaque number.
    const o = objectiveScore(r, objective);
    const hint = hints[r.symbol];
    const cooldown = experimentCooldown(experiments, { symbol: r.symbol, segment: r.segment,
      snapshot: hint?.latestSnapshot,
      ignore: ignoreCooldown, threshold: cooldownBatches, durationMs: cooldownMinutes * 60_000, proposedLever });
    return { ...r, cooldown, objectiveScore: o.score * cooldown.factor,
      objectiveFactors: { ...o.factors, beforeCooldown: o.score, cooldownFactor: cooldown.factor } };
  }).sort((a, b) => b.objectiveScore - a.objectiveScore || b.payoff - a.payoff);
  // Batches: connected components over asm↔asm edges within one TU.
  const byName = new Map(rows.map((r) => [r.symbol, r]));
  const seen = new Set(); const batches = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    const comp = []; const stack = [r.symbol];
    while (stack.length) {
      const n = stack.pop(); if (seen.has(n) || !byName.has(n)) continue;
      seen.add(n); comp.push(n);
      const row = byName.get(n);
      for (const m of [...row.asmCallees, ...row.asmCallers]) if (byName.has(m) && byName.get(m).tu === row.tu) stack.push(m);
    }
    const bytes = comp.reduce((s, n) => s + byName.get(n).sizeBytes, 0);
    // `targets` carries the SEGMENT alongside each name so a batch can be fed
    // straight back to op:'batch'. `functions` stays as bare names for
    // backwards compatibility, but it cannot identify an overlay function.
    const targets = comp.map((n) => {
      const seg = byName.get(n).segment;
      return seg ? { symbol: n, segment: seg } : { symbol: n };
    });
    batches.push({ tu: r.tu, functions: comp, targets, bytes, payoff: comp.reduce((s, n) => s + byName.get(n).payoff, 0), reason: comp.length > 1 ? "call each other inside one TU - decompile together so the shared struct/prototype fixes land once" : "isolated in its TU" });
  }
  batches.sort((a, b) => b.payoff - a.payoff);
  // PAGINATION. §10: "selecting the 100 highest-payoff functions cannot
  // accidentally exclude all the smaller targets before sorting them locally."
  // The full ranked set is paged, and the response says how much is beyond the
  // window rather than letting a truncated queue look like the whole list.
  const page = rows.slice(offset, offset + limit);
  return { functionsRemaining: rows.length, bytesRemaining: rows.reduce((s, r) => s + r.sizeBytes, 0),
    objective, objectiveMeaning: PLAN_OBJECTIVES[objective],
    objectivesAvailable: PLAN_OBJECTIVES,
    page: { offset, limit, returned: page.length, total: rows.length, hasMore: offset + page.length < rows.length,
      ...(offset + page.length < rows.length ? { nextOffset: offset + page.length, note: `${rows.length - offset - page.length} more function(s) rank below this window. They are NOT excluded from the work, only from this page - raise offset to see them.` } : {}) },
    queue: page, batches: batches.slice(0, Math.max(10, Math.ceil(limit / 3))),
    workClasses: { selected: [...wanted], counts: byClass, policy: WORK_CLASS_POLICY,
      allRemainingFunctions: allAsm.length, allRemainingBytes: allAsm.reduce((s, n) => s + (g.sizes[n] ?? 0), 0),
      note: "functionsRemaining/queue cover the SELECTED classes only. Pass workClass:'libultra-known-source' (or includeAllClasses:true) to see the others; `counts` is every class regardless of selection." },
    callGraph: { fingerprint: g.fingerprint, version: g.callgraphVersion, objects: g.objectCount, builtAt: g.builtAt,
      note: "content-addressed over the linker map + every contributing object's path/size/content hash. Pass forceGraph:true to rebuild it." },
    evidencePolicy: `Ranking uses ONLY evidence whose dependency hash matches the TU's CURRENT hash (${currentDependencyHashes.size} live TU hashes). Attempts measured against a different source tree appear as historicalAttempts/historicalBestDistance and never affect payoff - a stale best that still looks good is what misranks a queue. \`lastCompile\` is the newest compatible attempt, not the last file read.`,
    scoring: "payoff = bytes × (1 − 0.5 × uncertainty) × (1 + 0.1 × min(typed C neighbours, 5)); uncertainty = 0.5 untried, else lastDistance / instruction count. Static caller counts come from R_MIPS_26 relocations in the built objects; 'unreferenced' means no static jal - a jump-table or function-pointer target, or dead code - NOT proof of unreachability." };
}

/**
 * The dependency hash each remaining function's TU hashes to RIGHT NOW.
 *
 * compile.js keys every stored result on this hash, so it is the only honest
 * way to ask "was this evidence measured against the tree I have?". Computed
 * per TU (there are far fewer TUs than functions) and best-effort: a TU whose
 * hash cannot be computed has UNKNOWN freshness. Historical results never
 * stand in for a measurement against an unidentified tree.
 */
async function currentDepHashes(project, symbols, g) {
  const { dependencyHash } = await import("./project.js");
  const tus = new Set();
  for (const n of symbols) { const t = objectToTu(g.object[n], project); if (t) tus.add(t); }
  const hashes = new Map();
  await Promise.all([...tus].map(async (tuRel) => {
    try {
      const inv = await project.compileInvocation(tuRel);
      const dep = await dependencyHash(project, tuRel, inv);
      if (dep?.hash && dep.depsOk) hashes.set(tuRel, dep.hash);
    } catch { /* unbuildable/missing TU: no current hash to match against */ }
  }));
  return new Map(symbols.map((symbol) => [symbol, hashes.get(objectToTu(g.object[symbol], project)) ?? null]));
}

function objectToTu(obj, project) {
  if (!obj) return null;
  const b = project.m.splat.buildPath + "/";
  return obj.startsWith(b) ? obj.slice(b.length).replace(/\.o$/, ".c") : obj;
}

/** What every stored compare result says about a function, in one line per function. */
export async function loadCandidateEvidence(project, { currentDependencyHashes } = {}) {
  const dir = path.join(project.ws, "candidates");
  const out = {};
  if (!fs.existsSync(dir)) return out;
  // A result's identity lives in its FILENAME: `<dependencyHash>-<candidateSha>-v<verifier>`.
  // (compile.js builds exactly that key, so the cache already honours it.)
  const ID = /^([0-9a-f]+)-([0-9a-f]+)(?:-i[0-9a-f]+-q[0-9a-f]+)?-v(\d+)(?:-r[0-9a-f-]+)?\.result\.json$/;
  const currentMap = currentDependencyHashes instanceof Map ? currentDependencyHashes : null;
  const currentSet = currentDependencyHashes && !currentMap ? new Set(currentDependencyHashes) : null;
  const freshnessMemo = new Map();

  for (const sym of fs.readdirSync(dir)) {
    const d = path.join(dir, sym);
    let placeholder = null;
    // Per dependency hash, so evidence from a different source tree can never
    // be mixed into the current score.
    const byDep = new Map();
    let unidentified = 0;

    for (const f of fs.readdirSync(d)) {
      if (f.endsWith(".result.json")) {
        const m = ID.exec(f);
        let mtime = 0;
        try { mtime = fs.statSync(path.join(d, f)).mtimeMs; } catch {}
        try {
          const r = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
          const dep = r.compiler?.dependencyHash ?? m?.[1] ?? null;
          if (!dep) { unidentified++; continue; }   // pre-identity file: countable, never rankable
          const expected = currentMap?.get(sym) ?? (currentSet?.has(dep) ? dep : null);
          const freshness = await storedMeasurementFreshness(project, r, { dependencyHash: expected, memo: freshnessMemo });
          const eligible = freshness.state === "current" && r.inputIdentity?.schema === "romdev-compilation-input-v1"
            && r.inputIdentity.ownerMode === "live" && r.measurementValidity?.state === "valid"
            && r.verifierVersion === VERIFIER_VERSION;
          const groupKey = `${dep}:${eligible ? "live" : "historical"}`;
          if (!byDep.has(groupKey)) byDep.set(groupKey, { dep, eligible, attempts: 0, best: null, lastCompile: null, newestMs: 0 });
          const e = byDep.get(groupKey);
          e.attempts++;
          // `lastCompile` must be the NEWEST attempt, not whichever file the
          // directory happened to yield last.
          if (mtime >= e.newestMs) { e.newestMs = mtime; e.lastCompile = r.compileSucceeded;
            e.latestInput = r.inputIdentity?.sha256 ?? null; e.latestSegment = r.inputIdentity?.segment ?? null;
            e.latestSnapshot = measurementSnapshot(r); }
          if (r.distance && (e.best == null || r.distance.value < e.best)) e.best = r.distance.value;
          if (r.verdict?.functionLocal === "exact" && r.verifierVersion === VERIFIER_VERSION) e.best = 0;
        } catch {}
      } else if (/^gen-\d+\.json$/.test(f)) {
        try { const g = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); if (g.contextPrototype?.placeholderPointerTypes != null) placeholder = g.contextPrototype.placeholderPointerTypes; } catch {}
      }
    }

    const groups = [...byDep.values()].sort((a, b) => b.newestMs - a.newestMs);
    // Unknown or unmatched current identities have no current measurement.
    // Recency is not a substitute for identity, including after a tree edit.
    const expectedHash = currentMap?.get(sym) ?? null;
    const current = groups.find((g) => g.eligible && (currentMap ? expectedHash && g.dep === expectedHash : currentSet?.has(g.dep))) ?? null;
    const historical = groups.filter((g) => g !== current);

    out[sym] = {
      // Ranking fields describe the CURRENT tree only.
      attempts: current?.attempts ?? 0,
      lastDistance: current?.best ?? null,
      lastCompile: current?.lastCompile ?? null,
      placeholderPrototype: placeholder,
      dependencyHash: current?.dep ?? null,
      latestInput: current?.latestInput ?? null, latestSnapshot: current?.latestSnapshot ?? null,
      latestSegment: current?.latestSegment ?? null,
      expectedDependencyHash: expectedHash,
      freshness: current ? "current" : expectedHash || currentSet?.size ? "current-unmeasured" : "unknown",
      // Everything else stays VISIBLE but out of the score. A stale best that
      // still looks good is exactly what misranks the queue: on this workspace
      // func_801EB4F4 scored 6.8 from an old header layout while the current
      // tree gives 82.45 - a 12x misranking that would send a permuter budget
      // at a function that is not close.
      historicalAttempts: historical.reduce((s, g) => s + g.attempts, 0),
      historicalBestDistance: historical.some((g) => g.best != null) ? Math.min(...historical.map((g) => g.best).filter((v) => v != null)) : null,
      dependencyHashesSeen: groups.length,
      ...(unidentified ? { unidentifiedResults: unidentified } : {}),
      ...(historical.length && current?.best != null
        && historical.some((g) => g.best != null && g.best < current.best)
        ? { staleEvidenceWarning: "an OLDER dependency hash scored better; that evidence is excluded from ranking because it was measured against a different source tree" }
        : {}),
    };
  }
  return out;
}

/**
 * Run generate → compare for every function of a batch (bounded), sharing
 * one context. Returns per-function verdicts; never integrates.
 */
/**
 * A STABLE IDENTITY for one target, carried through plan -> generate -> compare
 * -> experiment -> search -> integrate.
 *
 * A bare symbol name is not an identity in a split overlay build: 20 segments
 * map VA 0x802C5800 in this project, so `func_i3_802C5800` and
 * `func_1B1FB0_802C5800` both resolved to AMBIGUOUS_OVERLAY when a batch could
 * only carry names. `segment` is the missing half, and it is never
 * reconstructible from the address.
 */
/**
 * The overlay segment a build object belongs to, or null for a non-overlay.
 * `build/src/overlays/ovl_i3/ovl_1B1FB0.o` -> `ovl_i3`. Derived from the path
 * because that is where splat puts an overlay's sources; a function outside an
 * overlay has an unambiguous VA and needs no segment.
 */
export function segmentOfObject(object) {
  const m = /(?:^|\/)overlays\/([A-Za-z0-9_]+)\//.exec(String(object ?? ""));
  return m ? m[1] : null;
}

export function targetId(fn) {
  return `${fn.segment ?? "?"}:${fn.symbol}@${fn.vaHex ?? (fn.va != null ? "0x" + (fn.va >>> 0).toString(16) : "?")}`;
}

/** Normalize a batch entry: a bare name, or a {symbol, segment, va} record. */
export function normalizeTarget(entry) {
  if (typeof entry === "string") return { symbol: entry, segment: undefined, va: undefined };
  if (entry && typeof entry === "object" && entry.symbol) {
    const va = typeof entry.va === "string" ? parseInt(entry.va, 16) : entry.va;
    return { symbol: entry.symbol, segment: entry.segment, va: Number.isFinite(va) ? va : undefined };
  }
  throw Object.assign(new Error(`batch entry must be a symbol name or a {symbol, segment} record, got ${JSON.stringify(entry)?.slice(0, 80)}`), { code: "BAD_ARGS" });
}

export async function runBatch(project, symbols, { maxFunctions = 12, timeBudgetS = 600 } = {}) {
  const { generateCandidate } = await import("./m2c.js");
  const { compileAndCompare } = await import("./compile.js");
  const started = Date.now();
  const results = [];
  for (const entry of symbols.slice(0, maxFunctions)) {
    const t = normalizeTarget(entry);
    const sym = t.symbol;
    if ((Date.now() - started) / 1000 > timeBudgetS) { results.push({ symbol: sym, segment: t.segment ?? null, skipped: "time budget exhausted" }); continue; }
    const t0 = Date.now();
    try {
      const fn = await project.resolveFunction({ symbol: sym, segment: t.segment, va: t.va });
      const g = await generateCandidate(project, fn);
      const r = await compileAndCompare(project, fn, { candidateText: g.code, candidatePath: g.candidatePath, label: "batch" });
      results.push({ symbol: sym, targetId: targetId(fn), segment: fn.segment ?? null, va: fn.vaHex ?? null, tu: fn.source?.tu ?? null,
        romOffset: fn.romOffset ?? null, romEnd: fn.romOffset != null && fn.sizeBytes ? fn.romOffset + fn.sizeBytes : null,
        sizeBytes: fn.sizeBytes, candidatePath: g.candidatePath, compileSucceeded: r.compileSucceeded, exactFunctionMatch: r.exactFunctionMatch, functionLocal: r.verdict?.functionLocal ?? r.verification?.functionLocal ?? null, verdictReasons: r.verdict?.reasons ?? [], romLinked: r.romLinked?.status ?? null, distance: r.distance?.value ?? null, kinds: r.differenceKinds ?? [], hint: r.hint, placeholderPrototype: g.contextPrototype?.placeholderPointerTypes ?? null, missingDeclarations: g.missingDeclarations.map((m) => m.name), ms: Date.now() - t0, cacheHit: r.cacheHit });
    } catch (e) {
      // An ambiguous overlay is the caller missing a `segment`, not a defect.
      // Say so, and name the segments, so the retry is one edit away.
      const hint = e.code === "AMBIGUOUS_OVERLAY"
        ? ` Pass a target record instead of a bare name: {"symbol":"${sym}","segment":"<one of the above>"}.`
        : "";
      results.push({ symbol: sym, segment: t.segment ?? null, error: `${e.code ?? "ERROR"}: ${e.message.slice(0, 200)}${hint}`, ms: Date.now() - t0 });
    }
  }
  const exact = results.filter((r) => r.exactFunctionMatch && r.functionLocal === "exact").length;
  return { functions: results.length, exactMatches: exact, compiled: results.filter((r) => r.compileSucceeded).length, elapsedMs: Date.now() - started, results,
    sharedBlockers: summarizeBlockers(results) };
}

function summarizeBlockers(results) {
  const counts = {};
  for (const r of results) {
    const k = r.error ? "error" : r.functionLocal === "exact" ? "exact" : r.compileSucceeded ? (r.functionLocal ?? "mismatch") : r.hint ? "compile-failed: " + r.hint.split(":")[0] : r.missingDeclarations?.length ? "compile-failed: undeclared symbols the draft needs (missingDeclarations)" : "compile-failed";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
