// sdk-cache.js — "prebuilt seed + opt-in rebuild" for SDK libraries.
//
// Compiling a whole SDK (libtonc, SGDK, pvsneslib) from source on every build
// is slow on the FIRST build of a process (GBA ~42s, Genesis ~18s). But linking
// a prebuilt black-box .a is the trust problem we removed. The compromise:
//
//   - Ship a prebuilt SEED .a derived from the vendored source (fast default).
//   - Let the caller pass `rebuildSdk:true` to compile the SDK from source
//     instead (slow once, then disk-cached by source hash).
//   - The seed is reproducible from the shipped source — nobody is forced to
//     trust it; they can rebuild and byte-compare.
//   - If the vendored source no longer matches the seed (the agent edited it)
//     AND they didn't ask for a rebuild, we still use the fast seed but return
//     a loud `sdkEditIgnored` warning naming the changed file — so an edit is
//     never SILENTLY dropped (the trap we eliminated stays eliminated).
//
// This module is platform-agnostic: each toolchain passes in how to hash its
// source, where its seed lives, and how to compile from source.
//
// ENV INJECTION (0.95.0, browser IDEs): NO top-level node imports. The node
// bits (fs seed reads, the os.tmpdir() disk cache, node:crypto hashing) load
// lazily; a caller may inject `io` — { readSeed, readSeedHash, cacheGet,
// cachePut, hash } — and the node defaults are skipped entirely. A browser
// host supplies seed/hash bytes from its fetched share manifest and an
// IndexedDB (or no-op) cache.

/** Stable hash of a {name: text|bytes} source map (order-independent).
 *  Node-only convenience (uses node:crypto synchronously via the lazy import
 *  in resolveSdkArchive's default io); kept for existing callers/scripts. */
export async function hashSources(srcMap) {
  const { createHash } = await import("node:crypto");
  return hashWith((data) => {
    const h = createHash("sha256");
    for (const chunk of data) h.update(chunk);
    return h.digest("hex");
  }, srcMap);
}

/** Feed the canonical (sorted, NUL-delimited) source-map byte stream to a
 *  caller-supplied digest fn. Shared by the node and injected hash paths so
 *  both produce identical keys for identical sources. */
function hashWith(digest, srcMap) {
  const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  const toBytes = (v) =>
    typeof v === "string"
      ? (enc ? enc.encode(v) : Buffer.from(v))
      : v instanceof Uint8Array ? v : new Uint8Array(v);
  const chunks = [];
  const NUL = new Uint8Array([0]);
  for (const name of Object.keys(srcMap).sort()) {
    chunks.push(toBytes(name), NUL, toBytes(srcMap[name]), NUL);
  }
  return digest(chunks);
}

/** Default node io: fs seed reads + os.tmpdir() disk cache + node:crypto
 *  hashing. All imports lazy so a browser bundle that injects io never
 *  touches a node builtin through this module. Exported so the drivers can
 *  compose a share-addressed io from these pieces (cacheGet/cachePut/hash). */
export async function nodeSdkIo() {
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const path = (await import("node:path")).default;
  const os = (await import("node:os")).default;
  const cacheDir = () => path.join(os.tmpdir(), "romdev-sdk-cache");
  return {
    readSeed: async (seedPath) => {
      try { return new Uint8Array(await readFile(seedPath)); } catch { return null; }
    },
    readSeedHash: async (seedHashPath) => {
      try { return (await readFile(seedHashPath, "utf-8")).trim(); } catch { return null; }
    },
    writeSeed: async (seedPath, bytes, seedHashPath, hash) => {
      await writeFile(seedPath, bytes);
      await writeFile(seedHashPath, hash + "\n");
    },
    cacheGet: async (key) => {
      try { return new Uint8Array(await readFile(path.join(cacheDir(), key + ".a"))); }
      catch { return null; }
    },
    cachePut: async (key, bytes) => {
      try {
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(path.join(cacheDir(), key + ".a"), bytes);
      } catch { /* cache is best-effort */ }
    },
    hash: async (srcMap) => hashWith((data) => {
      const h = createHash("sha256");
      for (const chunk of data) h.update(chunk);
      return h.digest("hex");
    }, srcMap),
  };
}

/**
 * Resolve an SDK archive for a build, honoring the seed/rebuild policy.
 *
 * @param {Object} a
 * @param {string} a.name          SDK name (for messages), e.g. "libtonc"
 * @param {Record<string,string>} a.sources  the vendored SDK source map (for hashing)
 * @param {string} a.seedPath       seed .a location (absolute path, or a share-relative
 *                                  key when an injected io resolves it)
 * @param {string} a.seedHashPath   the seed's source-hash file (same addressing)
 * @param {boolean} a.rebuild       caller asked to compile from source
 * @param {() => Promise<{ok:boolean, archive?:Uint8Array, stage?:string, log?:string}>} a.compileFromSource
 * @param {{readSeed?:Function, readSeedHash?:Function, writeSeed?:Function,
 *          cacheGet?:Function, cachePut?:Function, hash:Function}} [a.io]
 *   injected environment (browser hosts). When io is given the node defaults
 *   are NOT loaded at all — `hash` is required, everything else optional
 *   (a missing cacheGet/cachePut just means no cross-process cache)
 * @returns {Promise<{ok:boolean, archive?:Uint8Array, fromSource:boolean,
 *   sdkEditIgnored?:{sdk:string, message:string}, stage?:string, log?:string}>}
 */
export async function resolveSdkArchive(a) {
  const io = { ...(a.io ? {} : await nodeSdkIo()), ...(a.io ?? {}) };
  const srcHash = await io.hash(a.sources);

  // Explicit rebuild → compile from source (disk-cached by hash).
  if (a.rebuild) {
    // When writeSeed is set (the seed generator), always recompile + persist
    // the seed; don't short-circuit on the disk cache.
    if (!a.writeSeed) {
      const cached = io.cacheGet ? await io.cacheGet(srcHash) : null;
      if (cached) return { ok: true, archive: cached, fromSource: true };
    }
    const r = await a.compileFromSource();
    if (!r.ok) return { ok: false, fromSource: true, stage: r.stage, log: r.log };
    if (io.cachePut) await io.cachePut(srcHash, r.archive);
    if (a.writeSeed && a.seedPath && io.writeSeed) {
      await io.writeSeed(a.seedPath, r.archive, a.seedHashPath, srcHash);
    }
    return { ok: true, archive: r.archive, fromSource: true };
  }

  // Default → use the prebuilt seed.
  const seed = io.readSeed ? await io.readSeed(a.seedPath) : null;

  // Compare the seed's source-hash to the current vendored source.
  const seedHash = io.readSeedHash ? await io.readSeedHash(a.seedHashPath) : null;

  if (seed) {
    const edited = seedHash && seedHash !== srcHash;
    const result = { ok: true, archive: seed, fromSource: false };
    if (edited) {
      result.sdkEditIgnored = {
        sdk: a.name,
        message:
          `Your changes to the bundled ${a.name} source were NOT compiled into ` +
          `this build — it linked the prebuilt ${a.name} cache. To build your ` +
          `edits, pass rebuildSdk:true.`,
      };
    }
    return result;
  }

  // No seed shipped (dev / first build before seeding) → compile from source.
  const r = await a.compileFromSource();
  if (!r.ok) return { ok: false, fromSource: true, stage: r.stage, log: r.log };
  if (io.cachePut) await io.cachePut(srcHash, r.archive);
  return { ok: true, archive: r.archive, fromSource: true };
}
