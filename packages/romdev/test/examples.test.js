// Smoke-test every bundled example by building it with the matching toolchain.
// Each one must produce a non-empty binary. The example dir is also the
// reference any agent can fork from.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildForPlatform } from "../src/toolchains/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EX_DIR = path.join(__dirname, "..", "examples");

const cases = [
  // NES example uses CHR-RAM (writes tiles at runtime via PPUADDR/PPUDATA)
  // so it needs the chr-ram linker preset — OAM segment + ROM2 removal +
  // companion crt0 are all bundled into that preset.
  { platform: "nes", file: "nes/main.c", toolchain: "cc65", linkerConfig: "chr-ram" },
  { platform: "c64", file: "c64/main.c", toolchain: "cc65" },
  { platform: "atari2600", file: "atari2600/main.asm", toolchain: "dasm" },
  { platform: "atari7800", file: "atari7800/main.c", toolchain: "cc65" },
  { platform: "lynx", file: "lynx/main.c", toolchain: "cc65" },
  { platform: "snes", file: "snes/main.asm", toolchain: "asar" },
  { platform: "genesis", file: "genesis/main.s", toolchain: "vasm68k" },
  // GB has two examples: main.c (default) via SDCC sm83, main.asm via RGBDS.
  { platform: "gb", file: "gb/main.c",   toolchain: "sdcc",  language: "c" },
  { platform: "gb", file: "gb/main.asm", toolchain: "rgbds", language: "asm" },
];

for (const c of cases) {
  test(`example builds: ${c.platform}`, async () => {
    const source = await readFile(path.join(EX_DIR, c.file), "utf-8");
    const result = await buildForPlatform({
      platform: c.platform,
      source,
      linkerConfig: c.linkerConfig,
      language: c.language,
    });
    assert.equal(result.ok, true, `${c.platform} build failed:\n${result.log}`);
    assert.equal(result.toolchain, c.toolchain);
    assert.ok(result.binary && result.binary.length > 0, "empty binary");
  }, { timeout: 30000 });
}
