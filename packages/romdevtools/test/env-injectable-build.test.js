// env-injectable-build — proves the browser-IDE seam (0.95.0) is COMPLETE:
// with a fully injected env (runTool + share manifest + hash + sdkCache +
// loadGlue), buildGbaC/buildGenesisC never touch their node defaults, and the
// ROM comes out BYTE-IDENTICAL to the default node path. This is the same
// contract the gtlua web IDE proved for cc65: injected env, byte-identical
// CLI vs browser.
//
// The injected runTool here still executes the WASM via the worker pool
// (we're in node), but it receives ONLY the logical ToolJob the browser
// would get ({tool, glueFile, pkg, argv, inputFiles, outputFiles}) and
// resolves the glue itself — exactly what a Web Worker host does with its
// staged assets. The share manifest is materialized UP FRONT with
// buildShareManifest (what a browser build step stages as static files);
// after that the pipeline gets no filesystem access through the seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildGbaC } from "romdev-platform-gba";
import { buildGenesisC } from "romdev-toolchain-m68k-gcc";
import { buildShareManifest } from "../src/toolchains/common/share-fs.js";
import { hashSources } from "../src/toolchains/common/sdk-cache.js";
import { runIsolated } from "../src/toolchains/_worker/run.js";
import { makeGlueResolver } from "../src/toolchains/common/wasm-tool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKGS = path.join(__dirname, "..", "..");
const sha = (u8) => createHash("sha256").update(Buffer.from(u8)).digest("hex");

/** A browser-shaped env, hosted in node: every seam injected. */
function makeEnv(pkg, manifest) {
  const glue = makeGlueResolver({ pkg, localDir: path.join(PKGS, pkg), label: pkg });
  const cache = new Map();
  return {
    runTool: (job) => runIsolated({
      gluePath: glue(job.glueFile),
      argv: job.argv,
      inputFiles: job.inputFiles,
      outputFiles: job.outputFiles,
    }),
    loadGlue: async (file) => (await import(glue(file))).default,
    share: manifest,
    hash: hashSources,
    sdkCache: { get: (k) => cache.get(k) ?? null, put: (k, b) => cache.set(k, b) },
  };
}

const GBA_SRC = "#include <tonc.h>\nint main(){ REG_DISPCNT = DCNT_MODE3|DCNT_BG2; m3_plot(120,80,CLR_RED); while(1){} }";
const GEN_SRC = "#include <genesis.h>\nint main(){ VDP_drawText(\"HI\", 10, 10); while(1){ SYS_doVBlankProcess(); } return 0; }";

test("GBA: injected env is byte-identical to the node default", { timeout: 300000 }, async () => {
  const native = await buildGbaC({ source: GBA_SRC });
  assert.equal(native.ok, true, "default build ok");
  const manifest = await buildShareManifest(path.join(PKGS, "romdev-platform-gba", "share", "gba", "lib"));
  const injected = await buildGbaC({ source: GBA_SRC, env: makeEnv("romdev-platform-gba", manifest) });
  assert.equal(injected.ok, true, `env build ok (stage=${injected.stage})`);
  assert.equal(sha(injected.binary), sha(native.binary), "ROM bytes identical through the env seam");
  assert.equal(injected.sdkEditIgnored, undefined, "seed hash verifies through the manifest");
});

test("Genesis: injected env is byte-identical to the node default", { timeout: 300000 }, async () => {
  const native = await buildGenesisC({ source: GEN_SRC, sgdk: true });
  assert.equal(native.ok, true, "default build ok");
  const manifest = await buildShareManifest(path.join(PKGS, "romdev-toolchain-m68k-gcc", "share", "genesis", "lib"));
  const injected = await buildGenesisC({ source: GEN_SRC, sgdk: true, env: makeEnv("romdev-toolchain-m68k-gcc", manifest) });
  assert.equal(injected.ok, true, `env build ok (stage=${injected.stage})`);
  assert.equal(sha(injected.binary), sha(native.binary), "ROM bytes identical through the env seam");
  assert.equal(injected.sdkEditIgnored, undefined, "seed hash verifies through the manifest");
});
