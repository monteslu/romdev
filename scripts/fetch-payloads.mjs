#!/usr/bin/env node
// fetch-payloads.mjs — fill a clean checkout's gitignored payloads from npm.
//
// The binary packages (romdev-core-*, romdev-toolchain-*, …) gitignore their
// wasm/share payloads: too big for git, built out of band, shipped to npm via
// each package's `files` allowlist. A fresh `git clone` therefore has the full
// SOURCE tree but none of the artifacts, and the test suite — which boots
// cores and builds real ROMs — cannot run. CI used to cope by hand-picking a
// list of "pure JS" test files, and the list went stale the day it was
// written.
//
// This script downloads each workspace package's PUBLISHED tarball at the
// version pinned in the tree (a unit test asserts romdevtools' dependency pins
// equal the in-tree versions, so tree and npm agree by construction) and
// copies in ONLY the files the checkout is missing. Tracked sources always win
// — a tarball can never overwrite the code under test — and the payloads land
// exactly where the workspace resolver already looks for them.
//
// A package whose in-tree version is not on npm (mid-development bump) is a
// HARD ERROR by default: silently skipping it would run the suite against a
// half-empty tree and report the gaps as green. Pass --allow-missing to
// downgrade that to a warning for local experiments.
//
// Usage:
//   node scripts/fetch-payloads.mjs             # fill every workspace package
//   node scripts/fetch-payloads.mjs --dry-run   # report what would be copied
//   node scripts/fetch-payloads.mjs --allow-missing

import { execFileSync } from "node:child_process";
import {
  readdirSync, readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync,
  copyFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = path.join(ROOT, "packages");
const DRY = process.argv.includes("--dry-run");
const ALLOW_MISSING = process.argv.includes("--allow-missing");

/** Every file in the tarball, extracted to `dir`, relative paths. */
function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

const failures = [];
let filled = 0;
let copiedTotal = 0;

for (const name of readdirSync(PKGS).sort()) {
  const pkgDir = path.join(PKGS, name);
  const manifest = path.join(pkgDir, "package.json");
  if (!existsSync(manifest)) continue;
  const meta = JSON.parse(readFileSync(manifest, "utf8"));
  if (meta.private) continue;
  // romdevtools is the package under test: all of its runtime artifacts
  // resolve from the satellite packages (import.meta.resolve with a dev-dir
  // fallback), its own tarball ships only tracked source, and its version
  // legitimately runs AHEAD of npm between publishes — fetching it would both
  // fail spuriously and risk testing published code instead of the checkout.
  if (meta.name === "romdevtools") continue;

  const spec = `${meta.name}@${meta.version}`;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "romdev-payload-"));
  try {
    let tarball;
    try {
      // npm pack downloads through the local npm cache, so repeat runs (and
      // CI runs behind actions/setup-node's cache) don't refetch.
      tarball = execFileSync("npm", ["pack", spec, "--pack-destination", tmp],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop();
    } catch (err) {
      const msg = `${spec}: not on npm (${String(err.stderr || err.message).split("\n")[0]})`;
      if (ALLOW_MISSING) { console.warn(`SKIP ${msg}`); continue; }
      failures.push(msg);
      continue;
    }

    const ex = path.join(tmp, "x");
    mkdirSync(ex);
    execFileSync("tar", ["-xzf", path.join(tmp, tarball), "-C", ex, "--strip-components=1"]);

    let copied = 0;
    for (const rel of walk(ex)) {
      const dest = path.join(pkgDir, rel);
      if (existsSync(dest)) continue;          // tracked source wins, always
      if (DRY) { copied++; continue; }
      mkdirSync(path.dirname(dest), { recursive: true });
      copyFileSync(path.join(ex, rel), dest);
      copied++;
    }
    if (copied) {
      filled++;
      copiedTotal += copied;
      console.log(`${DRY ? "would fill" : "filled"} ${name}: ${copied} files from ${spec}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (failures.length) {
  console.error("\nUnpublished in-tree versions — the suite would run against a half-empty tree:");
  for (const f of failures) console.error(`  ${f}`);
  console.error("Publish them, or pass --allow-missing to proceed without.");
  process.exit(1);
}
console.log(`${DRY ? "Would fill" : "Filled"} ${filled} packages (${copiedTotal} files).`);
