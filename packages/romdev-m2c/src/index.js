// romdev-m2c - m2c ported to JS ESM (GPL-3.0; see NOTICE).
//
//   import { decompile } from "romdev-m2c";
//   const { code, stdout, stderr } = await decompile(["--target", "mips-ido-c", "--context", ctx, "func.s"]);
//
// `decompile` takes the same flags as upstream m2c's CLI and returns what it would have
// printed. Asm inputs may also be passed inline as { name, text } objects.
export { decompile, parse_flags, run, ArgumentError } from "./main.js";
export const UPSTREAM = { repo: "https://github.com/matt-kempster/m2c", commit: "1d1c4454a445326541305f83f2b0cb680a9ecb2d" };

import { Worker } from "node:worker_threads";

/**
 * decompile() in a worker thread. Resolves to { code, stdout, stderr, timedOut }.
 * On timeout the worker is terminated and code is null.
 */
export function decompileInWorker(flags, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { flags } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve({ code: null, stdout: "", stderr: `m2c timed out after ${timeoutMs} ms\n`, timedOut: true });
    }, timeoutMs);
    worker.once("message", (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (m.ok) resolve({ code: m.code, stdout: m.stdout, stderr: m.stderr, timedOut: false });
      else reject(new Error(m.error));
    });
    worker.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}
