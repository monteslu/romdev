// The reorder weights `(dist + 1) ** -1.5` must be the doubles CPython gets
// from the C library's pow(). pow.js ports glibc/musl's pow (ARM
// optimized-routines) with both of its builds: the generic one, and the
// x86-64 FMA build glibc selects on FMA+AVX2 CPUs (explicit fmas plus the
// multiply-adds GCC contracts under -mfma).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { libmPow, fma, powNeg15, hostUsesFma } from "../src/pow.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const b = new DataView(new ArrayBuffer(8));
const d = (h) => { b.setBigUint64(0, BigInt(h)); return b.getFloat64(0); };

test("fma rounds once", () => {
  // (1 + 2^-52)^2 - 1 = 2^-51 + 2^-104: separate rounding loses the 2^-104 term.
  const a = 1 + 2 ** -52;
  assert.equal(a * a - 1, 2 ** -51);
  assert.equal(fma(a, a, -1), 2 ** -51 + 2 ** -104);
  assert.equal(fma(2, 3, 4), 10);
  assert.equal(fma(0.1, 10, -1), 5.551115123125783e-17);
});

test("both pow builds reproduce the oracle rows (musl-in-WASM generic, host glibc FMA)", () => {
  const { rows } = JSON.parse(readFileSync(path.join(here, "fixtures", "pow-oracle.json"), "utf8"));
  let gen = 0, fm = 0;
  for (const [x, y, g, f] of rows) {
    if (libmPow(d(x), d(y), { fma: false }) === d(g)) gen++;
    if (libmPow(d(x), d(y), { fma: true }) === d(f)) fm++;
  }
  assert.equal(gen, rows.length);
  assert.equal(fm, rows.length);
  assert.ok(rows.some(([, , g, f]) => g !== f), "the fixture must contain inputs where the builds differ");
});

let gawk = null;
try { execFileSync("gawk", ["BEGIN{}"]); gawk = "gawk"; } catch { /* no gawk */ }

test("powNeg15 equals the host C library's pow for every weight input 2..200000", { skip: !gawk && "gawk (the host libm probe) not installed" }, () => {
  const host = execFileSync(gawk, ["BEGIN{for(x=2;x<=200000;x++) printf \"%.17g\\n\", x^-1.5}"], { maxBuffer: 1 << 24 })
    .toString().trim().split("\n").map(Number);
  let diff = 0;
  for (let x = 2; x <= 200000; x++) if (powNeg15(x) !== host[x - 2]) diff++;
  assert.equal(diff, 0, `host FMA build: ${hostUsesFma()}`);
});
