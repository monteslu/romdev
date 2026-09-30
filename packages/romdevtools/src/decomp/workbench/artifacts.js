// artifacts.js - bounded process streams with explicit, durable full-output
// artifacts.
//
// Plain JS ESM + JSDoc.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ValueError } from "./py.js";

export const DEFAULT_STREAM_LIMIT = 64 * 1024;

/** A bounded pair of streams and the metadata needed to find full output. */
export class StreamCapture {
  constructor({ stdout, stderr, stdout_bytes, stderr_bytes, stdout_truncated, stderr_truncated, artifacts }) {
    Object.assign(this, { stdout, stderr, stdout_bytes, stderr_bytes, stdout_truncated, stderr_truncated, artifacts });
    Object.freeze(this);
  }
}

function preview(value, limit) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= limit) return [value, encoded.length, false];
  // decode(errors="ignore") on a byte prefix: drop a split trailing sequence.
  let prefix = new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, limit));
  prefix = prefix.replace(/\ufffd+$/u, "");
  const omitted = encoded.length - Buffer.byteLength(prefix, "utf8");
  return [prefix + `\n\u2026 ${omitted} byte(s) omitted; retain artifacts for full output\n`, encoded.length, true];
}

const expandUser = (p) => (p === "~" || p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

/** Bound process output and optionally retain its complete contents. */
export function captureStreams(stdout, stderr, { limit = DEFAULT_STREAM_LIMIT, artifact_dir = null, stem }) {
  if (limit < 0) throw new ValueError("stream limit must be non-negative");
  const [so, sob, sot] = preview(stdout, limit);
  const [se, seb, set] = preview(stderr, limit);
  const artifacts = {};
  if (artifact_dir !== null && artifact_dir !== undefined) {
    const root = path.resolve(expandUser(String(artifact_dir)));
    fs.mkdirSync(root, { recursive: true });
    for (const [name, value] of [["stdout", stdout], ["stderr", stderr]]) {
      if (!value) continue;
      let suffix = 0, p;
      for (;;) {
        p = path.join(root, `${stem}${suffix === 0 ? "" : `.${suffix}`}.${name}.txt`);
        try { fs.writeFileSync(p, value, { encoding: "utf8", flag: "wx" }); break; }
        catch (e) { if (e.code === "EEXIST") { suffix += 1; continue; } throw e; }
      }
      artifacts[name] = p;
    }
  }
  return new StreamCapture({ stdout: so, stderr: se, stdout_bytes: sob, stderr_bytes: seb, stdout_truncated: sot, stderr_truncated: set, artifacts });
}
