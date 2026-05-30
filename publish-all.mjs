#!/usr/bin/env node
// publish-all.mjs — publish the romdev packages to npm in dependency order.
//
// The 14 binary packages (romdev-core-*, romdev-platform-*, romdev-toolchain-*)
// MUST publish BEFORE the main `romdev` package: romdev hard-pins each of them
// at an exact version, so if romdev goes up first, `npx romdev` is broken until
// the deps exist. This script enforces that order, waits for each binary to be
// live on the registry, then publishes romdev last.
//
// Usage:
//   node publish-all.mjs --dry-run     # rehearse: runs `npm publish --dry-run`
//                                      # on every package, publishes nothing.
//   node publish-all.mjs               # the real thing (needs `npm login`).
//
// Safe to re-run: a package whose exact version is already on the registry is
// skipped, so if a run dies partway you can just run it again.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKGS = path.join(ROOT, "packages");
const DRY = process.argv.includes("--dry-run");
const REGISTRY = "https://registry.npmjs.org";

const read = (dir) => JSON.parse(readFileSync(path.join(PKGS, dir, "package.json"), "utf8"));

// Discover the publishable packages: every packages/* that isn't private.
const dirs = readdirSync(PKGS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const all = dirs.map((dir) => ({ dir, pkg: read(dir) })).filter((p) => !p.pkg.private);

// Binaries first (everything except the main `romdev`), then romdev last.
const binaries = all.filter((p) => p.pkg.name !== "romdev");
const main = all.find((p) => p.pkg.name === "romdev");
if (!main) { console.error("FATAL: main `romdev` package not found under packages/"); process.exit(1); }
const ordered = [...binaries, main];

/** Is this exact name@version already on the registry? */
function alreadyPublished(name, version) {
  try {
    const body = execFileSync("curl", ["-sf", `${REGISTRY}/${name}/${version}`], { encoding: "utf8" });
    return body.includes(`"version"`);
  } catch { return false; } // 404 / curl non-zero → not published
}

/** Poll the registry until name@version is visible (npm propagation isn't instant). */
function waitForLive(name, version, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (alreadyPublished(name, version)) return true;
    execFileSync("sleep", ["2"]);
  }
  return false;
}

function publishOne({ dir, pkg }) {
  const { name, version } = pkg;
  const cwd = path.join(PKGS, dir);
  if (!DRY && alreadyPublished(name, version)) {
    console.log(`  ↷ ${name}@${version} already on registry — skip`);
    return;
  }
  const args = ["publish", ...(DRY ? ["--dry-run"] : [])];
  console.log(`  ${DRY ? "▷ dry-run" : "↑ publish"} ${name}@${version}`);
  execFileSync("npm", args, { cwd, stdio: "inherit" });
}

// --- preflight ---------------------------------------------------------------
// Guard against shipping a package whose gitignored wasm was never built/staged
// (a fresh clone or a wiped wasm/ dir would publish empty + break at runtime).
// Runs even on --dry-run so a rehearsal catches a missing artifact too.
console.log("== verifying wasm artifacts ==");
try {
  execFileSync("node", [path.join(ROOT, "scripts", "verify-wasm.mjs"), "--all", PKGS], { stdio: "inherit" });
} catch {
  console.error("\nAborting publish — build/stage the wasm first (scripts/build-*.sh).");
  process.exit(1);
}

if (!DRY) {
  let who = "";
  try { who = execFileSync("npm", ["whoami"], { encoding: "utf8" }).trim(); }
  catch {
    console.error("Not logged in to npm. Run `npm login` first, then re-run.");
    process.exit(1);
  }
  console.log(`npm user: ${who}`);
}

console.log(`\n${DRY ? "DRY RUN — nothing will be published.\n" : ""}Publish order (${ordered.length} packages): binaries first, romdev last.\n`);

// --- binaries ----------------------------------------------------------------
console.log("== binary packages ==");
for (const p of binaries) publishOne(p);

if (!DRY) {
  console.log("\n== waiting for binaries to be live on the registry ==");
  for (const { pkg } of binaries) {
    process.stdout.write(`  ${pkg.name}@${pkg.version} … `);
    console.log(waitForLive(pkg.name, pkg.version) ? "live" : "TIMEOUT (check manually before continuing)");
  }
}

// --- main --------------------------------------------------------------------
console.log("\n== main package ==");
publishOne(main);

console.log(`\n${DRY ? "Dry run complete — re-run without --dry-run to publish for real." : "Done. `npx romdev` should now install the full set."}`);
