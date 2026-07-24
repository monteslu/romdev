// Workspace-contract guards. Born 2026-07-23, the day romdevtools 0.105.1
// shipped importing `effectiveAspect` from romdev-core-runner while the
// runner's version (and therefore the registry tarball an npx install
// resolves) stayed at 0.1.1 — every fresh install died opening the playtest
// window on an import error the monorepo (workspace-linked) suite could not
// see. Two of the three guards live here; the third — "package content
// changed but its version already exists on the registry" — needs the
// registry and runs as a hard preflight inside publish-all.mjs instead.
//
//   1. Every named import from a workspace romdev-* package must resolve
//      against that package's real export surface (catches a renamed/missing
//      re-export the moment the suite runs, not at window-open time).
//   2. Every exact pin on a workspace sibling must equal that sibling's
//      in-tree version, and every range pin must still cover it (catches
//      "bumped the package, forgot the repin" — the reverse miss).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");          // packages/romdevtools
const PACKAGES = path.resolve(PKG_ROOT, "..");      // packages/

/** name → version for every workspace package. */
function workspaceVersions() {
  const map = new Map();
  for (const d of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const pkg = JSON.parse(readFileSync(path.join(PACKAGES, d.name, "package.json"), "utf8"));
      if (pkg.name) map.set(pkg.name, pkg.version);
    } catch { /* not a package dir */ }
  }
  return map;
}

function* walkJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "wasm") continue;
      yield* walkJs(p);
    } else if (entry.name.endsWith(".js") && statSync(p).size < 2_000_000) {
      yield p;
    }
  }
}

test("every named import from a workspace romdev-* package resolves", async () => {
  const ws = workspaceVersions();
  // specifier → Set(imported names), only for workspace-owned packages
  const wanted = new Map();
  const importRe = /import\s+(?:[\w$]+\s*,\s*)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  for (const file of walkJs(path.join(PKG_ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(importRe)) {
      const spec = m[2];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const rootName = spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0];
      if (!ws.has(rootName)) continue; // external dep — not this contract
      const names = m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      if (!wanted.has(spec)) wanted.set(spec, new Set());
      for (const n of names) wanted.get(spec).add(n);
    }
  }
  assert.ok(wanted.size > 0, "scanner found workspace imports (romdev-core-runner etc.)");

  const missing = [];
  for (const [spec, names] of wanted) {
    const mod = await import(spec);
    for (const n of names) {
      if (!(n in mod)) missing.push(`${spec} has no export "${n}"`);
    }
  }
  assert.deepEqual(missing, [], `unresolved named imports:\n  ${missing.join("\n  ")}`);
});

test("workspace sibling pins match the in-tree versions", () => {
  const ws = workspaceVersions();
  const problems = [];
  for (const d of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let pkg;
    try { pkg = JSON.parse(readFileSync(path.join(PACKAGES, d.name, "package.json"), "utf8")); }
    catch { continue; }
    for (const depMap of [pkg.dependencies, pkg.optionalDependencies]) {
      for (const [dep, range] of Object.entries(depMap ?? {})) {
        const inTree = ws.get(dep);
        if (!inTree) continue; // external
        if (/^\d+\.\d+\.\d+$/.test(range)) {
          if (range !== inTree) {
            problems.push(`${pkg.name} pins ${dep}@${range} but the workspace has ${inTree} — bump-and-repin`);
          }
        } else if (/^\^\d+\.\d+\.\d+$/.test(range)) {
          const [rMaj, rMin, rPat] = range.slice(1).split(".").map(Number);
          const [tMaj, tMin, tPat] = inTree.split(".").map(Number);
          // npm caret semantics: 0.x pins the minor; >=1 pins the major.
          const compatible = rMaj === 0
            ? tMaj === 0 && tMin === rMin && tPat >= rPat
            : tMaj === rMaj && (tMin > rMin || (tMin === rMin && tPat >= rPat));
          if (!compatible) {
            problems.push(`${pkg.name} depends on ${dep}@${range} but the workspace has ${inTree} — a fresh install resolves a DIFFERENT copy than the monorepo runs`);
          }
        }
      }
    }
  }
  assert.deepEqual(problems, [], `pin drift:\n  ${problems.join("\n  ")}`);
});
