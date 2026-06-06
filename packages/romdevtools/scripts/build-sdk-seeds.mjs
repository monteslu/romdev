#!/usr/bin/env node
// build-sdk-seeds.mjs — (re)generate the prebuilt SDK "seed" archives + their
// source-hash files. The seed is what makes the FIRST build of a process fast:
// the build links it by default instead of recompiling the whole SDK. It is
// DERIVED from the vendored SDK source (reproducible) — anyone can regenerate
// it here and byte-compare, and `buildSource({rebuildSdk:true})` rebuilds from
// source on demand. Run after vendoring/updating any SDK source.
//
//   node scripts/build-sdk-seeds.mjs
//
// Writes, next to each SDK:
//   <sdk>.seed.a       the prebuilt archive
//   <sdk>.seed.hash    sha256 of the source it was built from
//
// Both are gitignored (shipped via npm like the wasm), regenerable here.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGbaC } from "../src/toolchains/gba-c/gba-c.js";
import { buildSnesC } from "../src/toolchains/snes-c/snes-c.js";
import { buildGenesisC } from "../src/toolchains/genesis-c/genesis-c.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Each platform's build, run with rebuildSdk:true, populates the on-disk cache
// AND (via the seed-writer hook below) the .seed.a. We trigger a from-source
// build of a trivial program, which compiles the full SDK; the build modules
// expose the resulting archive through the SEED_SINK global.
globalThis.__ROMDEV_SEED_SINK__ = {};

async function gen(label, fn) {
  process.stdout.write(`seeding ${label} … `);
  const r = await fn();
  if (!r.ok) { console.error("FAILED:", r.stage, "\n", (r.log || "").split("\n").slice(-8).join("\n")); process.exit(1); }
  console.log("ok");
}

// GBA: libtonc + maxmod
await gen("gba/libtonc+maxmod", () => buildGbaC({
  source: "#include <tonc.h>\nint main(void){tte_init_chr4c_default(0,BG_CBB(0)|BG_SBB(31));while(1)VBlankIntrWait();return 0;}",
  runtime: "libtonc", maxmod: true, rebuildSdk: true, seedWrite: true,
}));
// GBA: libgba
await gen("gba/libgba", () => buildGbaC({
  source: "#include <gba.h>\nint main(void){REG_DISPCNT=MODE_0|BG0_ON;while(1)VBlankIntrWait();return 0;}",
  runtime: "libgba", rebuildSdk: true, seedWrite: true,
}));
// SNES: pvsneslib
await gen("snes/pvsneslib", () => buildSnesC({
  source: "#include <snes.h>\nint main(void){setMode(BG_MODE1,0);setScreenOn();while(1)WaitForVBlank();return 0;}",
  pvsneslib: true, rebuildSdk: true, seedWrite: true,
}));
// Genesis: SGDK
await gen("genesis/sgdk", () => buildGenesisC({
  source: "#include <genesis.h>\nint main(){VDP_drawText(\"x\",1,1);while(1)SYS_doVBlankProcess();return 0;}",
  sgdk: true, rebuildSdk: true, seedWrite: true,
}));

console.log("\nAll SDK seeds regenerated. (gitignored; shipped via npm.)");
void writeFile; void ROOT; // referenced by the build modules' seed-writer
