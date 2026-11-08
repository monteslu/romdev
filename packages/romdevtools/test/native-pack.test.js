// pack - the "build" (zip) step for the native-runtime kinds. Round-trips: pack a dir
// into a .wasc/.jsgame, then confirm the host loads the packed archive back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { unzipSync } from "fflate";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import { packWasc, packJsgame } from "../src/mcp/tools/native-pack.js";
import { WasmcartHost } from "../src/host/WasmcartHost.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELLO_WASC = path.join(HERE, "fixtures", "hello.wasc");
const SIMPLE_JSGAME = path.join(HERE, "fixtures", "simple.jsgame");

/** Explode a zip archive into a fresh temp dir; returns the dir path. */
function explode(archivePath, tag) {
  const dir = path.join(os.tmpdir(), `romdev-pack-test-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = unzipSync(readFileSync(archivePath));
  for (const [name, data] of Object.entries(files)) {
    if (name.endsWith("/")) continue;
    const p = path.join(dir, name);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(data));
  }
  return dir;
}

test("pack wasc: dir → .wasc round-trips (packed archive loads + runs)", async () => {
  const src = explode(HELLO_WASC, "wasc");
  const out = path.join(os.tmpdir(), "romdev-pack-out.wasc");
  const r = packWasc({ source: src, outputPath: out });
  assert.ok(r.entries >= 2, "packed manifest.json + cart.wasm");
  assert.ok(r.bytes > 0);

  // The packed .wasc must load + run through the host.
  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: out });
  host.stepFrames(3);
  assert.ok(host.status.fbWidth > 0 && host.status.fbHeight > 0, "packed .wasc runs");
  host.destroy();
});

test("pack wasc: bare .wasm → .wasc generates a manifest", async () => {
  const src = explode(HELLO_WASC, "wasc-bare");
  const wasm = path.join(src, "cart.wasm");
  const out = path.join(os.tmpdir(), "romdev-pack-bare.wasc");
  const r = packWasc({ wasm, outputPath: out, name: "Test Cart" });
  assert.ok(r.entries >= 2);

  // Confirm the generated manifest points at cart.wasm.
  const files = unzipSync(readFileSync(out));
  assert.ok(files["manifest.json"], "generated a manifest");
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString());
  assert.equal(manifest.entry, "cart.wasm");
  assert.equal(manifest.name, "Test Cart");

  const host = new WasmcartHost();
  await host.loadMedia({ platform: "wasmcart", path: out });
  host.stepFrames(2);
  host.destroy();
});

test("pack jsgame: dir → .jsgame round-trips (valid archive with entry)", () => {
  const src = explode(SIMPLE_JSGAME, "jsgame");
  const out = path.join(os.tmpdir(), "romdev-pack-out.jsgame");
  const r = packJsgame({ source: src, outputPath: out });
  assert.ok(r.entries > 0);
  assert.ok(r.bytes > 0);

  // The archive must contain a rungame-resolvable entry.
  const files = unzipSync(readFileSync(out));
  const names = Object.keys(files);
  const hasEntry = names.includes("package.json") || names.includes("index.html") ||
    names.some((n) => n.endsWith("main.js"));
  assert.ok(hasEntry, "packed archive has an entry point");
});

test("pack: rejects a non-directory source + a jsgame with no entry", () => {
  assert.throws(() => packWasc({ source: "/no/such/dir", outputPath: "/tmp/x.wasc" }), /not a directory/);
  const empty = path.join(os.tmpdir(), "romdev-pack-empty");
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(path.join(empty, "readme.txt"), "no game here");
  assert.throws(() => packJsgame({ source: empty, outputPath: "/tmp/x.jsgame" }), /no entry/);
});

test("pack wasc: the same inputs pack to the same bytes (fixed entry time, sorted dir order)", () => {
  const src = explode(HELLO_WASC, "wasc-repro");
  const a = path.join(os.tmpdir(), "romdev-pack-repro-a.wasc");
  const b = path.join(os.tmpdir(), "romdev-pack-repro-b.wasc");
  packWasc({ source: src, outputPath: a, name: "repro" });
  packWasc({ source: src, outputPath: b, name: "repro" });
  const bytes = readFileSync(a);
  assert.deepEqual(bytes, readFileSync(b));
  // Two packs inside one second can match by luck; the stored DOS time and
  // date pin it. Local file header: time at offset 10, date at 12. 1980-01-01
  // 00:00 is time 0, date (0 << 9) | (1 << 5) | 1 = 0x21.
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, "zip local file header");
  assert.equal(bytes.readUInt16LE(10), 0, "entry time is the fixed 00:00:00");
  assert.equal(bytes.readUInt16LE(12), 0x21, "entry date is the fixed 1980-01-01");
});

// ---- the cart's version: `version`, else the source's git checkout (same rule
// as wasmcart-pack and cartwheel's build), else the source manifest's, else 0.1.0

import { execFileSync } from "node:child_process";

function git(dir, ...a) {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...a], { encoding: "utf8" }).trim();
}
function packedVersion(out) {
  return JSON.parse(Buffer.from(unzipSync(readFileSync(out))["manifest.json"]).toString()).version;
}

test("pack wasc: version from git, `version` wins, non-semver refused", () => {
  const src = explode(HELLO_WASC, "wasc-version");      // a source dir whose manifest has its own version
  const out = path.join(os.tmpdir(), "romdev-pack-version.wasc");
  const bare = path.join(os.tmpdir(), "romdev-pack-version-bare.wasc");
  const placeholder = JSON.parse(readFileSync(path.join(src, "manifest.json"), "utf8")).version;

  // outside git: the manifest's own version; a bare wasm gets 0.1.0
  packWasc({ source: src, outputPath: out });
  assert.equal(packedVersion(out), placeholder);
  packWasc({ wasm: path.join(src, "cart.wasm"), outputPath: bare });
  assert.equal(packedVersion(bare), "0.1.0");

  git(src, "init", "-q");
  git(src, "add", ".");
  git(src, "commit", "-q", "-m", "one");
  const sha = git(src, "rev-parse", "--short=7", "HEAD");
  packWasc({ source: src, outputPath: out });
  assert.equal(packedVersion(out), `0.0.0-dev.g${sha}`, "untagged");

  git(src, "tag", "v2.3.4");
  packWasc({ source: src, outputPath: out });
  assert.equal(packedVersion(out), "2.3.4", "clean at the tag, over the manifest's placeholder");
  packWasc({ wasm: path.join(src, "cart.wasm"), outputPath: bare });
  assert.equal(packedVersion(bare), "2.3.4", "a bare wasm in the checkout too");

  writeFileSync(path.join(src, "manifest.json"), readFileSync(path.join(src, "manifest.json"), "utf8") + "\n");
  packWasc({ source: src, outputPath: out });
  assert.equal(packedVersion(out), `2.3.4-dev.g${sha}`, "a tracked change makes it a dev build");

  packWasc({ source: src, outputPath: out, version: "5.0.0-rc.1" });
  assert.equal(packedVersion(out), "5.0.0-rc.1", "`version` wins");
  assert.throws(() => packWasc({ source: src, outputPath: out, version: "1.0" }), /is not semver/);
  rmSync(src, { recursive: true, force: true });
});
