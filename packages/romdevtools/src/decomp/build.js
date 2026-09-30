// build.js - build a decomp project's targets from its own Makefile, entirely
// through romdev's WASM/JS toolchain: makefile.js reads the rules, recipe.js
// runs each step. Used for one TU's object (compile/compare), and for the full
// ROM (integrate/verify): every object, the link, objcopy and the checksum.
//
// A target that IS a build tool romdev provides as WASM/JS (a project rule
// that clones and compiles armips, say) is not built: every later step that
// names it runs romdev's module instead. It is reported in `providedByRomdev`.
//
// Policy for recipes romdev cannot run (a Python asset packer, armips): the
// step is never handed to a host program. If its output already exists it is
// kept and listed in `keptPrebuilt` (so a verdict can say exactly which inputs
// were not rebuilt); if it does not exist the build fails with the reason.
import fs from "node:fs";
import path from "node:path";
import { Makefile } from "./makefile.js";
import { runRecipeLine, classifyCommand } from "./recipe.js";

/** Load the project's Makefile with the variables a quiet, uncoloured build uses. */
export async function loadMakefile(root, { makefile = "Makefile", overrides = {} } = {}) {
  return Makefile.load(root, { makefile, overrides: { VERBOSE: "1", COLOR: "0", ...overrides } });
}

/**
 * Run one target's recipe (not its prerequisites).
 * @returns {Promise<{ok:boolean, target:string, code:number, log:string, commands:string[], unsupported?:string, skipped?:string[]}>}
 */
export async function runTargetRecipe(mk, target, { cwd = mk.root, tmpRoot, lines = null, always = false } = {}) {
  const r = lines ? { lines } : mk.recipeFor(target);
  if (!r) return { ok: false, target, code: 2, log: `no rule to make target '${target}'`, commands: [] };
  let log = "";
  const commands = [], skipped = [];
  for (const l of r.lines) {
    commands.push(l.command);
    const x = await runRecipeLine(l.command, { cwd, tmpRoot, always });
    log += x.log;
    if (x.skipped) skipped.push(...x.skipped);
    if (x.unsupported) return { ok: false, target, code: 127, log, commands, unsupported: x.unsupported, skipped };
    if (x.code !== 0 && !l.ignoreErrors) return { ok: false, target, code: x.code, log, commands, skipped };
  }
  return { ok: true, target, code: 0, log, commands, ...(skipped.length ? { skipped: [...new Set(skipped)] } : {}) };
}

/**
 * Build `goal` and everything it depends on.
 * @param {{always?:boolean, jobs?:number, tmpRoot:string, onProgress?:(e:object)=>void}} o
 *   always: rebuild every target that has a runnable recipe (make --always-make)
 * @returns {Promise<{ok:boolean, goal:string, built:string[], keptPrebuilt:Array<{target:string, reason:string}>, providedByRomdev:Array<{target:string, runsAs:string}>, failed:object|null, ms:number, logs:Record<string,string>}>}
 */
export async function buildGoal(mkIn, goal, { always = false, jobs = 8, tmpRoot, onProgress } = {}) {
  const t0 = Date.now();
  let mk = mkIn;
  const root = mk.root;
  const exists = (p) => fs.existsSync(path.resolve(root, p));
  const mtime = (p) => { try { return fs.statSync(path.resolve(root, p)).mtimeMs; } catch { return -1; } };
  const state = new Map(); // target -> Promise<{changed:boolean}>
  const built = [], keptPrebuilt = [], providedByRomdev = [], logs = {};
  let failed = null;
  let active = 0;
  const queue = [];
  const slot = async (fn) => {
    if (active >= jobs) await new Promise((res) => queue.push(res));
    active++;
    try { return await fn(); } finally { active--; queue.shift()?.(); }
  };

  const make = (target) => {
    if (state.has(target)) return state.get(target);
    const p = (async () => {
      const rule = mk.findRule(target);
      // A build tool romdev provides (a prebuilt binary a sub-make downloads,
      // say) is never built, with or without a rule in this Makefile.
      const tool = classifyCommand([target], root);
      if (["armips", "binutils", "ido", "n64crc", "iconv", "cpp", "decomp-tool", "decomp-gcc"].includes(tool.kind)) {
        providedByRomdev.push({ target, runsAs: tool.kind });
        return { changed: false };
      }
      if (!rule) {
        if (exists(target) || mk.phony.has(target)) return { changed: false };
        throw Object.assign(new Error(`no rule to make target '${target}'`), { target });
      }
      const deps = [...rule.prereqs, ...rule.orderOnly];
      const results = await Promise.all(deps.map((d) => make(d)));
      if (!rule.recipe.length) return { changed: results.some((r) => r.changed) };
      const phony = mk.phony.has(target);
      const tm = mtime(target);
      const need = always || phony || tm < 0 || rule.prereqs.some((d) => mtime(d) > tm) || results.some((r, i) => r.changed && i < rule.prereqs.length);
      if (!need) return { changed: false };
      const r = await slot(() => runTargetRecipe(mk, target, { tmpRoot, always }));
      if (r.unsupported) {
        if (exists(target) && !phony) { keptPrebuilt.push({ target, reason: r.unsupported }); return { changed: false }; }
        throw Object.assign(new Error(`cannot build '${target}': ${r.unsupported}`), { target, result: r });
      }
      if (r.log) logs[target] = r.log;
      if (!r.ok) throw Object.assign(new Error(`'${target}' failed (exit ${r.code})`), { target, result: r });
      built.push(target);
      onProgress?.({ target, built: built.length });
      return { changed: true };
    })();
    state.set(target, p);
    return p;
  };

  try {
    // GNU make's "remaking makefiles": an included makefile with an explicit
    // rule (a dependency file a generator writes, say) is brought up to date
    // first, and the Makefile is read again if any was remade.
    const remakable = [...new Set(mk.includes ?? [])].filter((f) => mk.rules.some((r) => !r.pattern && r.targets.includes(f) && r.recipe.length));
    if (remakable.length) {
      const res = await Promise.all(remakable.map((f) => make(f)));
      if (res.some((r) => r.changed)) {
        const { makefile, overrides, env } = mk.loadOptions;
        // Targets already brought up to date stay done.
        mk = await Makefile.load(root, { makefile, overrides, env });
      }
    }
    await make(goal);
  }
  catch (e) {
    failed = { target: e.target ?? goal, message: e.message, code: e.result?.code ?? null, log: (e.result?.log ?? "").slice(-4000), commands: e.result?.commands ?? [] };
  }
  // Let in-flight jobs settle before reporting.
  await Promise.allSettled([...state.values()]);
  return { ok: !failed, goal, built, keptPrebuilt, providedByRomdev, failed, ms: Date.now() - t0, logs };
}
