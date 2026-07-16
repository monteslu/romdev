// io.js — PURE input-file marshalling for the WASM toolchains. No node
// imports, no worker imports: this is the part of the pipeline a browser
// bundle (Web Worker IDE) loads verbatim, so it must stay environment-free.
// textFile/binaryFile/marshalInputs historically lived in _worker/run.js and
// common/wasm-tool.js; both re-export from here so existing imports keep
// working (run.js and wasm-tool.js stay node-only — nothing browser-bound
// may import them).

/** Convert text → InputFile spec. */
export function textFile(vfsPath, content) {
  return { vfsPath, encoding: "utf8", data: content };
}

/** Bytes → base64 without assuming node's Buffer (pure fallback for browsers). */
function bytesToBase64(u8) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");
  }
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < u8.length; i += 3) {
    const b0 = u8[i], b1 = u8[i + 1], b2 = u8[i + 2];
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : CHARS[b2 & 63];
  }
  return out;
}

/** Convert binary (Uint8Array / Buffer / base64 string) → InputFile spec. */
export function binaryFile(vfsPath, bytes) {
  // Accept EITHER raw bytes OR a base64 STRING — the same either/or contract the
  // toolchain wrappers honor individually (asar/cc65/vasm68k/wladx all guard with
  // `x instanceof Uint8Array ? x : Buffer.from(x, "base64")`). The MCP
  // `binaryIncludes` schema delivers base64 STRINGS; decoding them as UTF-8 (the
  // old bug) made the base64 TEXT itself the file bytes — .incbin then embedded
  // base64 text into the ROM (the GBA maxmod "silent without print()" hunt).
  if (typeof bytes === "string") return { vfsPath, encoding: "base64", data: bytes };
  const u8 = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
  return { vfsPath, encoding: "base64", data: bytesToBase64(u8) };
}

/**
 * Marshal text + binary virtual-file maps into the runTool() inputFiles[]
 * array, all rooted at /work. Order: the primary source first (if given), then
 * text entries, then binary entries — matching what the wrappers built by hand.
 *
 * @param {Object} a
 * @param {{name: string, text: string}} [a.primary]   the main source (e.g. main.c → /work/main.c)
 * @param {Record<string,string>} [a.text]             virtual text files (headers, includes, link scripts)
 * @param {Record<string,Uint8Array>} [a.binary]       virtual binary files (objects, archives, binary includes)
 * @returns {Array<{vfsPath:string, encoding:"utf8"|"base64", data:string}>}
 */
export function marshalInputs({ primary, text = {}, binary = {} } = {}) {
  const files = [];
  if (primary) files.push(textFile("/work/" + primary.name, primary.text));
  for (const [name, content] of Object.entries(text))
    files.push(textFile("/work/" + name, content));
  for (const [name, bytes] of Object.entries(binary))
    files.push(binaryFile("/work/" + name, bytes));
  return files;
}

/** Convenience: get bytes (Uint8Array) for an output file from a tool result. */
export function getOutputBytes(result, vfsPath) {
  const data = result.outputs?.[vfsPath];
  if (!data) return null;
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(data, "base64"));
  const bin = atob(data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** Convenience: get text for an output file from a tool result. */
export function getOutputText(result, vfsPath) {
  return result.outputs?.[vfsPath] ?? "";
}
