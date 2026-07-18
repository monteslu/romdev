// pure-util.js — environment-free helpers for the isomorphic core.
//
// This module (and everything LibretroHost statically imports) must stay free
// of top-level `node:` imports: it is part of the browser surface enforced by
// romdevtools/test/browser-surface-imports.test.js. Node-only I/O lives in
// io-node.js, loaded lazily on the path-based code paths only.

/** Last ".ext" of a path-ish string ("" when none) — node:path-free. */
export function extnameOf(p) {
  const base = String(p).split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

/** Is this a Node.js runtime (vs a browser/worker bundle)? */
export function isNodeEnv() {
  return typeof globalThis.process?.versions?.node === "string";
}

/**
 * Encode a JS string as NUL-terminated bytes without Buffer.
 * utf-8 (default) covers paths and cheat codes; latin1 is byte-per-char for
 * the helpers that feed 8-bit cores (C64 keyboard text, state names).
 * @param {string} str
 * @param {"utf-8"|"latin1"} [encoding]
 * @returns {Uint8Array} encoded bytes + trailing NUL
 */
export function encodeCString(str, encoding = "utf-8") {
  const s = String(str);
  if (encoding === "latin1") {
    const out = new Uint8Array(s.length + 1); // zero-filled → trailing NUL free
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(enc.length + 1);
  out.set(enc, 0);
  return out;
}

/**
 * Write an in-memory file tree into the wasm FS, creating directories.
 * The isomorphic alternative to mirroring a host-disk dir.
 * @param {any} FS emscripten FS
 * @param {string} root destination dir inside the wasm FS (e.g. "/system")
 * @param {Record<string, Uint8Array>} files relPath → bytes
 */
export function writeFsTree(FS, root, files) {
  try { FS.mkdir(root); } catch { /* exists */ }
  for (const [rel, bytes] of Object.entries(files)) {
    const parts = rel.split("/").filter(Boolean);
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      dir += "/" + part;
      try { FS.mkdir(dir); } catch { /* exists */ }
    }
    try { FS.writeFile(root + "/" + parts.join("/"), bytes); } catch { /* skip */ }
  }
}
