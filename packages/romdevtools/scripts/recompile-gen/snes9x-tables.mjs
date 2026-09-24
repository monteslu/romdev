#!/usr/bin/env node
// Extract the two snes9x tables the SNES WAT recompiler's renderer needs,
// from the snes9x source romdev builds its reference core from, and write
// them as committed data (src/analysis/recompile/wat/snes/snes9x-tables.json).
//
//   mulBrightness  globals.cpp `uint8 mul_brightness[16][32]`. Brightness is
//                  NOT c*b/15 rounded any single way; a strict per-pixel
//                  score needs the exact table the reference uses.
//   objSizes       gfx.cpp SetupOBJ's `switch (PPU.OBJSizeSelect)`:
//                  (small w, small h, large w, large h) per OBSEL bits 7-5.
//
// Recompile time never needs the snes9x source; only this script does.
//
// usage: snes9x-tables.mjs [<snes9x src dir>] [<out.json>]
//   default src: ${ROMDEV_BUILD_DIR:-<pkg>/build}/snes9x/src (build-snes9x.sh's clone)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..", "..");
const srcDir = process.argv[2] ||
  path.join(process.env.ROMDEV_BUILD_DIR || path.join(pkg, "build"), "snes9x", "src");
const out = process.argv[3] ||
  path.join(pkg, "src", "analysis", "recompile", "wat", "snes", "snes9x-tables.json");

const versions = JSON.parse(readFileSync(path.join(pkg, "scripts", "versions.json"), "utf8"));
const pin = versions.cores?.snes9x ?? versions.snes9x;

const sha = (t) => createHash("sha256").update(t).digest("hex");

// ---- mul_brightness[16][32]
const globals = readFileSync(path.join(srcDir, "globals.cpp"), "utf8");
const at = globals.indexOf("mul_brightness[16][32]");
if (at < 0) throw new Error("mul_brightness[16][32] not found in globals.cpp");
const open = globals.indexOf("{", at);
let depth = 0, close = -1;
for (let i = open; i < globals.length; i++) {
  if (globals[i] === "{") depth++;
  else if (globals[i] === "}" && --depth === 0) { close = i; break; }
}
const rows = [...globals.slice(open + 1, close).matchAll(/\{([^}]*)\}/g)]
  .map((m) => m[1].split(",").map((t) => t.trim()).filter(Boolean).map((t) => Number(t)));
if (rows.length !== 16 || rows.some((r) => r.length !== 32 || r.some((v) => !Number.isInteger(v)))) {
  throw new Error("mul_brightness did not parse as 16 rows of 32 integers");
}
// Structural invariants: row 0 is black, row 15 is the identity, every row
// is monotonic non-decreasing and never exceeds its input.
if (rows[0].some((v) => v !== 0)) throw new Error("mul_brightness row 0 is not all zero");
if (rows[15].some((v, i) => v !== i)) throw new Error("mul_brightness row 15 is not the identity");
for (const r of rows) {
  for (let i = 1; i < 32; i++) if (r[i] < r[i - 1] || r[i] > i) throw new Error("mul_brightness row not monotonic/bounded");
}

// ---- SetupOBJ sizes
const gfx = readFileSync(path.join(srcDir, "gfx.cpp"), "utf8");
const fnAt = gfx.indexOf("static void SetupOBJ (void)\n{");
if (fnAt < 0) throw new Error("SetupOBJ definition not found in gfx.cpp");
const sw = gfx.slice(gfx.indexOf("switch (PPU.OBJSizeSelect)", fnAt));
const body = sw.slice(0, sw.indexOf("\n\t}\n"));
const objSizes = [];
for (const m of body.matchAll(/case (\d+):([\s\S]*?)break;/g)) {
  const k = Number(m[1]);
  const v = {};
  // Each assignment chain `A = B = n;` sets every name in it.
  for (const st of m[2].split(";")) {
    const parts = st.split("=").map((s) => s.trim());
    const n = Number(parts.at(-1));
    if (!Number.isInteger(n) || parts.length < 2) continue;
    for (const name of parts.slice(0, -1)) v[name.split(/\s+/).at(-1)] = n;
  }
  objSizes[k] = [v.SmallWidth, v.SmallHeight, v.LargeWidth, v.LargeHeight];
}
if (objSizes.length !== 8 || objSizes.some((r) => !r || r.some((x) => ![8, 16, 32, 64].includes(x)))) {
  throw new Error("SetupOBJ sizes did not parse as 8 cases of 4 sizes");
}

const data = {
  provenance: {
    source: "snes9x",
    url: pin?.url ?? "https://github.com/libretro/snes9x.git",
    commit: pin?.commit ?? null,
    files: {
      "globals.cpp": { symbol: "mul_brightness[16][32]", sha256: sha(globals) },
      "gfx.cpp": { symbol: "SetupOBJ switch (PPU.OBJSizeSelect)", sha256: sha(gfx) },
    },
    generator: "scripts/recompile-gen/snes9x-tables.mjs",
  },
  mulBrightness: rows,
  objSizes,
};
writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
console.log(`wrote ${out}`);
