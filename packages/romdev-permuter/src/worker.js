// worker.js - a candidate-evaluation worker thread (upstream's
// multiprocess_worker). It rebuilds the parent's permuters from plain config
// (reusing the parent's base score instead of recompiling the base), then
// loops: ask for a seed, evaluate it, send the result back.
import { parentPort, workerData } from "node:worker_threads";
import { Compiler } from "./compiler.js";
import { Permuter } from "./permuter.js";
import { Scorer } from "./scorer.js";
import { setObjdumpGlue } from "./objdump.js";
import { loadCompileModule } from "./main.js";

const { configs, glue } = workerData;
for (const [arch, g] of Object.entries(glue)) setObjdumpGlue(arch, g);

// Seeds arrive in batches; ask for more before the local queue runs dry.
const BATCH = 8;
let finishing = false;
let exhausted = false;
let requested = false;
const queue = [];
let wake = null;
parentPort.on("message", (msg) => {
  if (msg.type === "finish") finishing = true;
  else if (msg.type === "tasks") { queue.push(...msg.tasks); requested = false; if (msg.exhausted) exhausted = true; }
  if (wake) { const p = wake; wake = null; p(); }
});
function topUp() {
  if (!requested && !finishing && !exhausted && queue.length < BATCH / 2) {
    requested = true;
    parentPort.postMessage({ type: "need", count: BATCH - queue.length });
  }
}
async function nextTask() {
  for (;;) {
    if (finishing) return null;
    topUp();
    if (queue.length) return queue.shift();
    if (exhausted) return null;
    await new Promise((resolve) => { wake = resolve; });
  }
}

const silent = () => {};

async function main() {
  const permuters = [];
  for (const cfg of configs) {
    const compileFn = cfg.compileModule ? await loadCompileModule(cfg.compileModule) : null;
    const compiler = new Compiler(cfg.compile_cmd, { ...cfg.compilerOpts, compileFn, log: silent });
    const scorer = await Scorer.create(cfg.scorerOpts);
    permuters.push(await Permuter.create({ ...cfg.permOpts, compiler, scorer, log: silent }, cfg.base));
  }
  for (;;) {
    const msg = await nextTask();
    if (!msg) break;
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
