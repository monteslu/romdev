// io-node.js — the Node I/O adapter for romdev-core-host.
//
// Everything that touches the host machine (disk, temp dirs, installed-package
// resolution) lives here. LibretroHost lazily `await import()`s this module on
// the PATH-BASED code paths only — a bytes-based session (the browser
// contract) never loads it, which is what keeps LibretroHost.js itself free of
// top-level `node:` imports (romdevtools/test/browser-surface-imports.test.js
// enforces that). This module may import node builtins freely.

import { readFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCString } from "./pure-util.js";

/** @param {string} p @returns {Promise<Uint8Array>} */
export async function readFileBytes(p) {
  return new Uint8Array(await readFile(p));
}

/** Create a real temp dir (default system/save dirs, NODERAWFS spill). */
export function makeTmpDir(prefix = "romdev-") {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Spill in-memory ROM bytes to a real temp file. NODERAWFS cores (flycast)
 * fopen media off Node's real fs, so an in-memory `bytes` load (a freshly
 * built ELF in tests/runSource) must become a real path first.
 * @returns {string} the temp file path
 */
export function writeNoderawfsTmp(bytes, ext) {
  const tmpFile = path.join(makeTmpDir("romdev-dc-"), "rom" + (ext || ".bin"));
  writeFileSync(tmpFile, bytes);
  return tmpFile;
}

/**
 * Detect a NODERAWFS core build: its WASM FS is Node's REAL fs, so a write to
 * a real temp path via FS lands on the host disk. MEMFS builds throw or write
 * nowhere real. (The build still registers FS.filesystems either way, so
 * that's not a tell — this probe is the reliable one.)
 * @param {any} FS the core module's FS
 */
export function probeNoderawfs(FS) {
  const probe = path.join(os.tmpdir(), `.romdev-noderawfs-probe-${process.pid}`);
  try {
    FS.writeFile(probe, "");
    if (existsSync(probe)) {
      try { unlinkSync(probe); } catch { /* best effort */ }
      return true;
    }
  } catch { /* MEMFS: the temp path isn't real → not NODERAWFS */ }
  return false;
}

/**
 * Resolve an installed package's bundled subdir (BIOS / machine-config trees),
 * or null. Best-effort: any failure falls back to null (the core then boots
 * with whatever default it has).
 * @param {string} pkg package name (e.g. "romdev-core-bluemsx")
 * @param {string} subdir subdir inside the package (e.g. "bios")
 * @returns {string | null}
 */
export function resolveBundledDir(pkg, subdir) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.resolve(pkg)));
    const sub = path.join(dir, subdir);
    if (existsSync(sub)) return sub;
  } catch { /* package not resolvable */ }
  return null;
}

/**
 * Recursively copy a host directory into the emscripten virtual FS so a core's
 * fopen() can read it (BIOS / machine-config trees). emscripten FILESYSTEM=1
 * MEMFS is enough — no NODEFS rebuild needed.
 * @param {any} FS the core module's FS
 * @param {string} hostDir absolute host path
 * @param {string} fsDir destination path inside the wasm FS (e.g. "/system")
 */
export function mirrorDirToFS(FS, hostDir, fsDir) {
  try { FS.mkdir(fsDir); } catch { /* exists */ }
  for (const name of readdirSync(hostDir)) {
    const hostPath = path.join(hostDir, name);
    const fsPath = fsDir + "/" + name;
    const st = statSync(hostPath);
    if (st.isDirectory()) {
      mirrorDirToFS(FS, hostPath, fsPath);
    } else if (st.isFile()) {
      try { FS.writeFile(fsPath, readFileSync(hostPath)); } catch { /* skip */ }
    }
  }
}

/** Mirror a host dir into a PROXIED core's APP-THREAD MEMFS (a per-thread JS heap, invisible to
 *  the main-thread FS). Each file's bytes go through shared WASM memory; romdev_app_fs_write does
 *  the FS.writeFile on the app thread, where the core's fopen runs. */
export function mirrorDirToAppFS(mod, hostDir, fsDir) {
  for (const name of readdirSync(hostDir)) {
    const hostPath = path.join(hostDir, name);
    const fsPath = fsDir + "/" + name;
    const st = statSync(hostPath);
    if (st.isDirectory()) {
      mirrorDirToAppFS(mod, hostPath, fsPath);
    } else if (st.isFile()) {
      const bytes = readFileSync(hostPath);
      const dataPtr = mod._malloc(bytes.length || 1);
      mod.HEAPU8.set(bytes, dataPtr);
      const pb = encodeCString(fsPath);
      const pathPtr = mod._malloc(pb.length);
      mod.HEAPU8.set(pb, pathPtr);
      try { mod._romdev_app_fs_write(pathPtr, dataPtr, bytes.length); } catch { /* skip */ }
      mod._free(dataPtr); mod._free(pathPtr);
    }
  }
}
