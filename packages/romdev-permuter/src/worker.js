// worker.js - a candidate-evaluation worker thread (upstream's
// multiprocess_worker). It rebuilds the parent's permuters from plain config
// (reusing the parent's base score instead of recompiling the base), then
// loops: ask for a seed, evaluate it, send the result back.
import { parentPort, workerData } from "node:worker_threads";
import { Compiler } from "./compiler.js";
import { Permuter } from "./permuter.js";
import { Scorer } from "./scorer.js";
import { setObjdumpGlue } from "./objdump.js";

const { configs, glue } = workerData;
for (const [arch, g] of Object.entries(glue)) setObjdumpGlue(arch, g);

let finishing = false;
let pending = null;
parentPort.on("message", (msg) => {
  if (msg.type === "finish") finishing = true;
  if (pending) { const p = pending; pending = null; p(msg); }
});
const nextMessage = () => new Promise((resolve) => { pending = resolve; });

const silent = () => {};

async function main() {
  const permuters = [];
  for (const cfg of configs) {
    const compileFn = cfg.compileModule ? (await import(cfg.compileModule.url))[cfg.compileModule.name] : null;
    const compiler = new Compiler(cfg.compile_cmd, { ...cfg.compilerOpts, compileFn, log: silent });
    const scorer = await Scorer.create(cfg.scorerOpts);
    permuters.push(await Permuter.create({ ...cfg.permOpts, compiler, scorer, log: silent }, cfg.base));
  }
  for (;;) {
    if (finishing) break;
    parentPort.postMessage({ type: "need" });
    const msg = await nextMessage();
    if (msg.type !== "task") break;
    const permuter = permuters[msg.perm_index];
    const start = performance.now();
    const result = await permuter.try_eval_candidate(msg.seed);
    if (!result.isEvalError && permuter.should_output(result)) permuter.record_result(result);
    if (permuter.speed !== 100) {
      const ms = (performance.now() - start) * (100 / permuter.speed - 1);
      await new Promise((r) => setTimeout(r, ms));
    }
    parentPort.postMessage({ type: "done", perm_index: msg.perm_index, result });
  }
}

main().then(() => process.exit(0), (e) => {
  parentPort.postMessage({ type: "fatal", error: String(e?.stack ?? e) });
  process.exit(1);
});
