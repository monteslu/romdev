// evaluator-worker.js - one evaluation thread of the permuter@home evaluator
// (upstream: evaluator.multiprocess_worker). Holds a Permuter per job and
// evaluates seeds sent by the evaluator's main thread.
import { parentPort, workerData } from "node:worker_threads";
import { Compiler } from "../compiler.js";
import { Permuter } from "../permuter.js";
import { Scorer } from "../scorer.js";

const { compileWithScript } = await import(workerData.toolchainUrl);
const permuters = new Map();
let chain = Promise.resolve();

parentPort.on("message", (msg) => {
  chain = chain.then(async () => {
    if (msg.type === "add") {
      const cfg = msg.config;
      const compiler = new Compiler(cfg.compile_cmd, { tmpDir: cfg.tmpDir, compileFn: (c, o, script) => compileWithScript(c, o, null, script), log: () => {} });
      const scorer = await Scorer.create(cfg.scorerOpts);
      permuters.set(msg.perm_id, await Permuter.create({ ...cfg.permOpts, compiler, scorer, log: () => {} }, cfg.base));
    } else if (msg.type === "remove") {
      permuters.delete(msg.perm_id);
    } else if (msg.type === "work") {
      const t0 = performance.now();
      const permuter = permuters.get(msg.perm_id);
      const result = await permuter.try_eval_candidate(BigInt(msg.seed));
      if (!result.isEvalError && permuter.should_output(result)) permuter.record_result(result);
      if (!result.isEvalError) delete result.pass;
      if (result.seed) result.seed = null;
      parentPort.postMessage({ type: "result", perm_id: msg.perm_id, id: msg.id, time_us: Math.trunc((performance.now() - t0) * 1000), result });
    }
  });
});
