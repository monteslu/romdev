// Worker-thread entry: runs one decompile() so a slow function cannot block the
// caller's event loop, and so callers can enforce a timeout.
import { parentPort, workerData } from "node:worker_threads";
import { decompile } from "./main.js";

try {
  const r = await decompile(workerData.flags);
  parentPort.postMessage({ ok: true, ...r });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.stack ? e.stack : e) });
}
