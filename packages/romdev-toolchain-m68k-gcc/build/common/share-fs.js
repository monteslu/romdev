// share-fs.js — the "share tree" seam for the C build drivers (0.95.0).
//
// The GBA/Genesis drivers read their SDK library trees (headers, crt0, link
// scripts, seeds, target archives) from their package's share/. In node
// that's the filesystem; in a browser Web Worker there is no filesystem — the
// host fetches the tree as static assets and hands the driver a MANIFEST
// (a plain {relPath: string|Uint8Array} object). Both are wrapped in the
// same accessor so the drivers never touch fs/path directly:
//
//   share.text(rel)   → Promise<string>       (utf-8)
//   share.bytes(rel)  → Promise<Uint8Array>
//   share.list(prefix)→ Promise<string[]>     (recursive file rel-paths)
//
// rel paths always use "/" and are relative to the share LIB root (e.g.
// "libtonc/gba_crt0.s", "sgdk/md.ld").
//
// ⚠ ORDER MATTERS: list() order feeds SDK compile order → ar member order →
// ROM bytes, and the sdk-cache hash keys. dirShare preserves the readdir
// walk order the drivers always used; buildShareManifest() materializes a
// manifest with the SAME walk, so a browser host that stages its manifest
// with it gets byte-identical ROMs. Only this module may define that walk.
//
// No top-level node imports — dirShare/buildShareManifest lazy-import fs so
// a browser bundle importing this module (for mapShare) stays node-free.

/** Wrap a {relPath: string|Uint8Array} manifest (browser hosts). */
export function mapShare(manifest) {
  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  const get = (rel) => {
    if (!(rel in manifest)) throw new Error(`share manifest missing "${rel}"`);
    return manifest[rel];
  };
  return {
    async text(rel) {
      const v = get(rel);
      if (typeof v === "string") return v;
      return dec ? dec.decode(v) : Buffer.from(v).toString("utf-8");
    },
    async bytes(rel) {
      const v = get(rel);
      if (typeof v === "string") return enc ? enc.encode(v) : new Uint8Array(Buffer.from(v, "utf-8"));
      return v;
    },
    async list(prefix = "") {
      const p = prefix && !prefix.endsWith("/") ? prefix + "/" : prefix;
      return Object.keys(manifest).filter((k) => k.startsWith(p));
    },
    /** true when a rel path exists (drivers use this for optional files). */
    async has(rel) {
      return rel in manifest;
    },
  };
}

/** Wrap a real directory (node hosts). All fs access is lazy. */
export function dirShare(rootDir) {
  let fsp = null;
  const load = async () => (fsp ??= await import("node:fs/promises"));
  const abs = (rel) => rootDir + "/" + rel;
  async function walk(fs, dir, rel, out) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const subRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(fs, dir + "/" + ent.name, subRel, out);
      else if (ent.isFile()) out.push(subRel);
    }
  }
  return {
    async text(rel) {
      const fs = await load();
      return fs.readFile(abs(rel), "utf-8");
    },
    async bytes(rel) {
      const fs = await load();
      return new Uint8Array(await fs.readFile(abs(rel)));
    },
    async list(prefix = "") {
      const fs = await load();
      const p = prefix.replace(/\/$/, "");
      const out = [];
      await walk(fs, p ? abs(p) : rootDir, "", out);
      return out.map((r) => (p ? `${p}/${r}` : r));
    },
    async has(rel) {
      const fs = await load();
      try { await fs.access(abs(rel)); return true; } catch { return false; }
    },
  };
}

/**
 * Materialize a share tree into a manifest object — the helper a browser
 * host's build step uses to stage the tree as static assets. Uses the SAME
 * walk as dirShare so manifest key order (→ SDK compile order → ROM bytes)
 * matches node exactly. Text extensions load as strings, the rest as bytes.
 * Node-only (lazy fs).
 *
 * @param {string} rootDir  the share lib root (e.g. .../share/gba/lib)
 * @param {RegExp} [textExts]  which extensions are text
 * @returns {Promise<Record<string, string|Uint8Array>>}
 */
export async function buildShareManifest(rootDir, textExts = /\.(c|h|s|inc|i|i80|s80|ld|lst|txt|md|res|hash)$/i) {
  const share = dirShare(rootDir);
  const out = {};
  for (const rel of await share.list("")) {
    out[rel] = textExts.test(rel) ? await share.text(rel) : await share.bytes(rel);
  }
  return out;
}
