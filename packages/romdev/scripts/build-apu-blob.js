#!/usr/bin/env node
// build-apu-blob.js — rebuild src/platforms/snes/lib/audio/apu_blob.bin
//
// The SNES C templates ship a prebuilt apu_blob.bin (SPC700 driver +
// sample bank + R46 music data) which gets .incbin'd into the ROM at
// build time. Whenever you edit:
//   - src/platforms/snes/lib/audio/apu_blob.asm  (driver / song table)
//   - src/platforms/snes/lib/audio/sample_bank.bin (BRR samples)
// run this script to regenerate apu_blob.bin from source.
//
// Implementation: stages apu_blob.asm + sample_bank.bin through the
// bundled asar.wasm in `arch spc700` flat-binary mode. Asar writes
// only the ARAM regions covered by the `org` directives; we trim the
// sentinel padding to get the final upload payload.
//
// Usage:  node scripts/build-apu-blob.js

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { runAsar } from "../src/toolchains/asar/asar.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const AUDIO_DIR = join(ROOT, "src/platforms/snes/lib/audio");

async function main() {
  const source = await readFile(join(AUDIO_DIR, "apu_blob.asm"), "utf-8");
  const sampleBank = await readFile(join(AUDIO_DIR, "sample_bank.bin"));

  const r = await runAsar({
    source,
    binaryIncludes: { "sample_bank.bin": new Uint8Array(sampleBank) },
    flatBinary: true,
    symbols: false,
  });

  if (r.exitCode !== 0) {
    console.error("[build-apu-blob] asar failed (exit", r.exitCode, "):\n" + r.log);
    process.exit(1);
  }

  // flatBinary mode trims sentinel ($AA) padding from both ends. asar's
  // base ROM is a 64 KB scratch — we want all the bytes from the start
  // of the driver ($0200) through the last byte of music data, which is
  // exactly what flat-binary mode returns.
  const bytes = r.binary;
  const outPath = join(AUDIO_DIR, "apu_blob.bin");
  await writeFile(outPath, bytes);

  console.log(`[build-apu-blob] wrote ${outPath} (${bytes.length} bytes)`);
  console.log(`[build-apu-blob] flatStartOffset = 0x${r.flatStartOffset.toString(16)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
