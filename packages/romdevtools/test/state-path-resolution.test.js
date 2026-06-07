// v0.15.0 feedback #1: state(op:'load'/'save'/'export') with a RELATIVE `path`
// used to resolve against the server CWD (opaque to the caller) → silent ENOENT,
// and the docs use relative paths. A relative path now resolves against the
// LOADED ROM's directory; absolute is used as-is; base64-loaded ROMs (no real
// dir) fall back to CWD.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveStatePath } from "../src/mcp/tools/state.js";

const hostWithRom = (mediaPath) => ({ status: { mediaPath } });

test("relative path resolves against the loaded ROM's directory", () => {
  const host = hostWithRom("/home/me/games/rygar.nes");
  assert.equal(
    resolveStatePath("states/start.state", host),
    path.resolve("/home/me/games", "states/start.state"),
  );
});

test("absolute path is used as-is (ROM dir irrelevant)", () => {
  const host = hostWithRom("/home/me/games/rygar.nes");
  assert.equal(resolveStatePath("/tmp/x.state", host), "/tmp/x.state");
});

test("base64-loaded ROM (<memory…>) falls back to CWD-resolution", () => {
  const host = hostWithRom("<memory.nes>");
  assert.equal(resolveStatePath("x.state", host), path.resolve("x.state"));
});

test("no host / no mediaPath falls back to CWD-resolution (never throws)", () => {
  assert.equal(resolveStatePath("x.state", undefined), path.resolve("x.state"));
  assert.equal(resolveStatePath("x.state", { status: {} }), path.resolve("x.state"));
});

test("empty/undefined path passes through unchanged", () => {
  assert.equal(resolveStatePath("", hostWithRom("/a/b.nes")), "");
  assert.equal(resolveStatePath(undefined, hostWithRom("/a/b.nes")), undefined);
});
