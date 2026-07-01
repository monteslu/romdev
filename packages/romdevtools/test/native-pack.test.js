// pack — the "build" (zip) step for the native-runtime kinds. Round-trips: pack a dir
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
