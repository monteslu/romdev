// Small helpers for MCP tool responses.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── Large-output discipline: path-required-unless-inline ──────────
// Every tool that can produce a large payload (ROM bytes, dumps, asm,
// tile blobs, PNGs, big logs) follows ONE rule:
//   • `inline` defaults to FALSE.
//   • inline:false  → the caller MUST supply an output path. We write the
//     payload there and return just { path, bytes }. No silent default
//     location → nothing ever lands somewhere the user can't find / loses.
//   • inline:true   → the payload comes back in the response, no path.
// This keeps the common call cheap on context AND prevents the "my ROM
// went to /tmp and got wiped" footgun — the agent must say where it goes.

/**
 * Enforce the path-or-inline contract and (when not inline) write to disk.
 * Throws a clear error if neither `outputPath` nor `inline` was given.
 * @param {Uint8Array|Buffer|string} data  the payload to persist when not inline
 * @param {{ outputPath?: string, inline?: boolean, what?: string, encoding?: BufferEncoding }} opts
 * @returns {{ path: string, bytes: number }} when written to disk
 */
export function writeOutput(data, { outputPath, inline = false, what = "output", encoding } = {}) {
  if (inline) {
    throw new Error("writeOutput called with inline:true — caller should return the payload inline instead of writing.");
  }
  if (!outputPath) {
    throw new Error(
      `No output path given for ${what}. Pass outputPath (absolute path / dir where it should be saved — ` +
      `e.g. your project dir) or inline:true to get it back in the response.`,
    );
  }
  const buf = typeof data === "string" ? Buffer.from(data, encoding ?? "utf8") : Buffer.from(data);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, buf);
  return { path: outputPath, bytes: buf.length };
}

/** Wrap a JSON object as an MCP tool text-content result. */
export function jsonContent(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

/** Wrap a plain string as an MCP tool text-content result. */
export function textContent(text) {
  return {
    content: [{ type: "text", text }],
  };
}

/** Build an image content block from a base64-encoded PNG. */
export function imageContent(pngBase64) {
  return {
    type: "image",
    data: pngBase64,
    mimeType: "image/png",
  };
}

/** Wrap an Error as a tool error result. */
export function errorContent(err) {
  return {
    isError: true,
    content: [{ type: "text", text: String(err?.message ?? err) }],
  };
}

/**
 * Wrap a tool implementation so any thrown error becomes a structured tool
 * error rather than a transport-layer exception.
 * @template T
 * @param {(args: T) => Promise<any> | any} fn
 */
export function safeTool(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return errorContent(err);
    }
  };
}
