// Every shipped prebuilt binary must match its recorded hash.
//
// This guards the CLASS of bug that shipped a corrupted Z80 disassembler: a
// path-rewriting pass edited bytes inside prebuilt wasm, and nothing caught it
// because the modules still validated and the compilers still worked. Only one
// tool's OUTPUT was wrong, and only where a test happened to look.
//
// These are prebuilt artifacts. Their bytes should change only when a build
// script regenerates them - at which point the manifest is refreshed on
// purpose (`node scripts/binary-manifest.mjs --write`). Anything else is drift
// and should fail loudly here rather than silently in a user's disassembly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, shippedBinaries } from "../scripts/binary-manifest.mjs";

test("every shipped binary matches the recorded hash", () => {
  const r = verify();
  assert.notEqual(r.reason, "no manifest", "binary-manifest.json is missing - run scripts/binary-manifest.mjs --write");
  assert.deepEqual(r.changed, [],
    "shipped binaries changed without a manifest update. If a build script rebuilt them, refresh with "
    + "`node scripts/binary-manifest.mjs --write`; if not, something edited a prebuilt artifact.");
  assert.deepEqual(r.missing, [], "manifest lists binaries that are gone");
});

test("new shipped binaries are added to the manifest, not left untracked", () => {
  const r = verify();
  assert.deepEqual(r.added, [],
    "these shipped binaries have no recorded hash - add them with `node scripts/binary-manifest.mjs --write`");
});

test("the manifest covers every shipped binary", () => {
  const r = verify();
  assert.equal(r.count, shippedBinaries().length);
  assert.ok(r.count > 100, `expected the full prebuilt set, got ${r.count}`);
});
