// End-to-end full-loop test for every platform with a complete v1 stack.
//
// For each (platform, example, expected core) tuple:
//   1. Compile examples/<platform>/main.{c,asm,s} via buildForPlatform.
//   2. Load the binary into the matching libretro WASM core.
//   3. Step a handful of frames.
//   4. Capture a screenshot to /tmp/full-loop-<platform>.png for visual review.
//   5. Verify a framebuffer was produced.
//
// This is the highest-confidence single test in the suite — when it passes,
// romdev can build, run, and observe a ROM end-to-end for every
// platform it claims to support.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildForPlatform } from "../src/toolchains/index.js";
import { resolveCore } from "../src/cores/registry.js";
import { LibretroHost } from "romdev-core-host/index.js";
import { framebufferToPng } from "romdev-core-host/framebuffer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EX_DIR = path.join(__dirname, "..", "examples");

const cases = [
  // NES example uses CHR-RAM (runtime tile uploads) — needs chr-ram preset.
  { platform: "nes",       file: "nes/main.c", linkerConfig: "chr-ram" },
  { platform: "c64",       file: "c64/main.c" },
  { platform: "atari2600", file: "atari2600/main.asm" },
  { platform: "atari7800", file: "atari7800/main.c" },
  { platform: "lynx",      file: "lynx/main.c" },
  { platform: "snes",      file: "snes/main.asm" },
  { platform: "genesis",   file: "genesis/main.s" },
  { platform: "gb",        file: "gb/main.asm", language: "asm" },
  // Z80 family (SDCC + mcpp). These minimal hello-worlds don't init the
  // VDP — a real game would call e.g. SMS_init from devkitSMS — so the
  // framebuffer will likely show the core's power-on default. We only
  // assert that the toolchain pipeline + core load runs cleanly.
  { platform: "sms",        file: "sms/main.c" },
  { platform: "gg",         file: "gg/main.c" },
  // PC Engine: cc65 conio hello (single source). hello_pce.c keeps a non-empty
  // .bss so the crt0 BSS-clear doesn't underflow (see PCE TROUBLESHOOTING.md).
  // MSX is NOT here — it needs a 2nd source (msx_crt0.s) which this single-file
  // harness can't express; it's covered in test/pce-msx-tier1.test.js instead.
  { platform: "pce",        file: "pce/main.c" },
];

for (const c of cases) {
  test(`full loop: build + load + run + screenshot for ${c.platform}`, async () => {
    // 1. Build.
    const source = await readFile(path.join(EX_DIR, c.file), "utf-8");
    const build = await buildForPlatform({
      platform: c.platform,
      source,
      linkerConfig: c.linkerConfig,
      language: c.language,
    });
    assert.equal(build.ok, true, `build failed:\n${build.log}`);
    assert.ok(build.binary && build.binary.length > 0);

    // 2. Write ROM to a temp file (libretro cores generally want path-on-disk).
    const tmp = await mkdtemp(path.join(os.tmpdir(), `romdev-fl-${c.platform}-`));
    const ext = c.platform === "snes" ? ".sfc"
              : c.platform === "genesis" ? ".bin"
              : c.platform === "gb" ? ".gb"
              : c.platform === "lynx" ? ".lnx"
              : c.platform === "atari2600" ? ".a26"
              : c.platform === "atari7800" ? ".a78"
              : c.platform === "c64" ? ".prg"
              : c.platform === "sms" ? ".sms"
              : c.platform === "gg" ? ".gg"
              : c.platform === "pce" ? ".pce"
              : ".nes";
    const romPath = path.join(tmp, "example" + ext);
    await writeFile(romPath, build.binary);

    // 3. Load core + media via LibretroHost.
    const resolved = resolveCore(c.platform);
    if (!resolved) {
      // Some platforms (c64) have a toolchain but no core; skip gracefully.
      assert.ok(false, `no core for ${c.platform} (skipping is fine — fix this test if intentional)`);
      return;
    }
    const host = new LibretroHost();
    await host.loadCore(resolved.jsPath, resolved.wasmPath);
    await host.loadMedia({ platform: c.platform, path: romPath });

    // 4. Step frames.
    host.stepFrames(30);

    // 5. Screenshot for visual inspection.
    const fb = host.getFramebuffer();
    assert.ok(fb.width > 0 && fb.height > 0, `framebuffer empty: ${fb.width}x${fb.height}`);
    const png = framebufferToPng(fb.width, fb.height, fb.pixels, fb.pitch, fb.format);
    const outPath = `/tmp/full-loop-${c.platform}.png`;
    await writeFile(outPath, png);
    // Keep the size > 0 sanity check; signed PNG header.
    assert.equal(png[0], 0x89);
    assert.equal(png[1], 0x50);
  }, { timeout: 60000 });
}
