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

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

/** Stable hash of a {name: text|bytes} source map (order-independent). */
export function hashSources(srcMap) {
  const h = createHash("sha256");
  for (const name of Object.keys(srcMap).sort()) {
    const v = srcMap[name];
    h.update(name);
    h.update("\0");
    h.update(typeof v === "string" ? v : Buffer.from(v));
    h.update("\0");
  }
  return h.digest("hex");
}

// On-disk cache for rebuilt-from-source archives, so a `rebuildSdk` result is
// reused across processes/sessions (not just within one). Keyed by source hash.
function cacheDir() {
  return path.join(os.tmpdir(), "romdev-sdk-cache");
}
async function readDiskCache(key) {
  try { return new Uint8Array(await readFile(path.join(cacheDir(), key + ".a"))); }
  catch { return null; }
}
async function writeDiskCache(key, bytes) {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(path.join(cacheDir(), key + ".a"), bytes);
  } catch { /* cache is best-effort */ }
}

/**
 * Resolve an SDK archive for a build, honoring the seed/rebuild policy.
 *
 * @param {Object} a
 * @param {string} a.name          SDK name (for messages), e.g. "libtonc"
 * @param {Record<string,string>} a.sources  the vendored SDK source map (for hashing)
 * @param {string} a.seedPath       absolute path to the prebuilt seed .a
 * @param {string} a.seedHashPath   absolute path to the seed's source-hash file
 * @param {boolean} a.rebuild       caller asked to compile from source
 * @param {() => Promise<{ok:boolean, archive?:Uint8Array, stage?:string, log?:string}>} a.compileFromSource
 * @returns {Promise<{ok:boolean, archive?:Uint8Array, fromSource:boolean,
 *   sdkEditIgnored?:{sdk:string, message:string}, stage?:string, log?:string}>}
 */
export async function resolveSdkArchive(a) {
  const srcHash = hashSources(a.sources);

  // Explicit rebuild → compile from source (disk-cached by hash).
  if (a.rebuild) {
    // When writeSeed is set (the seed generator), always recompile + persist
    // the seed; don't short-circuit on the disk cache.
    if (!a.writeSeed) {
      const cached = await readDiskCache(srcHash);
      if (cached) return { ok: true, archive: cached, fromSource: true };
    }
    const r = await a.compileFromSource();
    if (!r.ok) return { ok: false, fromSource: true, stage: r.stage, log: r.log };
    await writeDiskCache(srcHash, r.archive);
    if (a.writeSeed && a.seedPath) {
      await writeFile(a.seedPath, r.archive);
      await writeFile(a.seedHashPath, srcHash + "\n");
    }
    return { ok: true, archive: r.archive, fromSource: true };
  }

  // Default → use the prebuilt seed.
  let seed = null;
  try { seed = new Uint8Array(await readFile(a.seedPath)); } catch { /* no seed */ }

  // Compare the seed's source-hash to the current vendored source.
  let seedHash = null;
  try { seedHash = (await readFile(a.seedHashPath, "utf-8")).trim(); } catch { /* no hash */ }

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
  await writeDiskCache(srcHash, r.archive);
  return { ok: true, archive: r.archive, fromSource: true };
}
