// Worker side of the GB lockstep tests: runs one lockstep and posts the
// result (see gb-lockstep.js for why it is a worker).
import { parentPort, workerData } from "node:worker_threads";
import { lockstep } from "./gb-lockstep.js";

try {
  const r = await lockstep(new Uint8Array(workerData.rom), workerData.frames);
  parentPort.postMessage({ ok: true, r });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.stack || e) });
}
