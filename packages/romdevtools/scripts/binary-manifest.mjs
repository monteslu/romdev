#!/usr/bin/env node
// binary-manifest.mjs - record/verify a hash for every shipped prebuilt binary.
//
// WHY THIS EXISTS. A release-prep pass rewrote builder-absolute paths inside
// prebuilt wasm/.a files, padding replacements to the original byte length with
// "/". On z80-elf-objdump that padding overran a path string and overwrote
// binutils' 8-bit register table, so every Z80 "h" operand disassembled as "/".
// It shipped. Nothing in romdev's JS was wrong, every wasm module still passed
// WebAssembly.validate, and the compilers still produced working ROMs - the
// damage was only visible in one tool's OUTPUT.
//
// A decode test catches that instance. This catches the CLASS: any byte of any
// shipped binary changing without someone intending it. These files are
// prebuilt artifacts, so their bytes should only ever change when a build
// script regenerates them - and then the manifest is updated deliberately.
//
//   node scripts/binary-manifest.mjs --write    refresh after a real rebuild
//   node scripts/binary-manifest.mjs            verify (exit 1 on drift)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(ROOT, "romdevtools", "binary-manifest.json");

export function shippedBinaries() {
  const out = execFileSync("find", [ROOT, "-name", "*.wasm", "-o", "-name", "*.a"], { encoding: "utf8", maxBuffer: 1 << 28 });
  return out.split("\n").filter(Boolean)
    // build/ holds intermediate output from the toolchain builds; node_modules is not ours.
    .filter((f) => !f.includes("node_modules") && !f.includes("/build/"))
    .map((f) => path.relative(ROOT, f))
    .sort();
}

export function hashOf(rel) {
  return createHash("sha256").update(readFileSync(path.join(ROOT, rel))).digest("hex");
}

export function verify() {
  if (!existsSync(MANIFEST)) return { ok: false, reason: "no manifest", changed: [], missing: [], added: [] };
  const man = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const now = shippedBinaries();
  const changed = [], missing = [], added = [];
  for (const [rel, want] of Object.entries(man.binaries)) {
    if (!existsSync(path.join(ROOT, rel))) { missing.push(rel); continue; }
    if (hashOf(rel) !== want) changed.push(rel);
  }
  for (const rel of now) if (!(rel in man.binaries)) added.push(rel);
  return { ok: !changed.length && !missing.length, changed, missing, added, count: Object.keys(man.binaries).length };
}

function write() {
  const binaries = {};
  for (const rel of shippedBinaries()) binaries[rel] = hashOf(rel);
  writeFileSync(MANIFEST, JSON.stringify({
    note: "sha256 of every shipped prebuilt binary. Regenerate ONLY when a build script legitimately rebuilds one: node scripts/binary-manifest.mjs --write",
    generated: new Date().toISOString().slice(0, 10),
    binaries,
  }, null, 2) + "\n");
  console.log(`wrote ${Object.keys(binaries).length} hashes to ${path.relative(ROOT, MANIFEST)}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  if (process.argv.includes("--write")) write();
  else {
    const r = verify();
    if (r.ok && !r.added.length) { console.log(`ok - ${r.count} binaries match the manifest`); process.exit(0); }
    if (r.changed.length) console.error(`CHANGED (${r.changed.length}):\n  ` + r.changed.join("\n  "));
    if (r.missing.length) console.error(`MISSING (${r.missing.length}):\n  ` + r.missing.join("\n  "));
    if (r.added.length) console.error(`UNTRACKED (${r.added.length}):\n  ` + r.added.join("\n  "));
    console.error("\nIf a build script legitimately rebuilt these, refresh with --write.");
    process.exit(1);
  }
}
