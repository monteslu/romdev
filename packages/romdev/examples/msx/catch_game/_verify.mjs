import { readFileSync, writeFileSync } from "node:fs";
import { buildForPlatform } from "/home/_romdev_/code/cliemu/romdev/packages/romdev/src/toolchains/index.js";
import { resolveCore } from "/home/_romdev_/code/cliemu/romdev/packages/romdev/src/cores/registry.js";
import { LibretroHost } from "/home/_romdev_/code/cliemu/romdev/packages/romdev/src/host/LibretroHost.js";

const LIBDIR = "/home/_romdev_/code/cliemu/romdev/packages/romdev/src/platforms/msx/lib/c";
const DIR = "/home/_romdev_/code/cliemu/romdev/packages/romdev/examples/msx/catch_game";

const SRC  = readFileSync(`${DIR}/main.c`, "utf8");
const LIB  = readFileSync(`${LIBDIR}/msx_vdp.c`, "utf8");
const CRT0 = readFileSync(`${LIBDIR}/msx_crt0.s`, "utf8");
const HDR  = readFileSync(`${LIBDIR}/msx_hw.h`, "utf8");

const PLATFORM = "msx";

console.log("== building ==");
const build = await buildForPlatform({
  platform: PLATFORM,
  sources: { "main.c": SRC, "msx_vdp.c": LIB, "msx_crt0.s": CRT0 },
  includes: { "msx_hw.h": HDR },
  crt0: ".module empty\n",
  sourceName: "main.c",
});

if (!build.binary) {
  console.log(build.log || build.stderr || JSON.stringify(build));
  console.log("BUILD FAILED stage=", build.stage, "exit=", build.exitCode);
  process.exit(1);
}
console.log("build OK, bytes=", build.binary.length);

const c = resolveCore(PLATFORM);
const h = new LibretroHost();
await h.loadCore(c.jsPath, c.wasmPath);
await h.loadMedia({ platform: PLATFORM, bytes: build.binary });

// ---- honest pixel helpers over raw RGBA ----
function nonBlackFraction(rgba) {
  let nb = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > 16 || rgba[i + 1] > 16 || rgba[i + 2] > 16) nb++;
  }
  return nb / (rgba.length / 4);
}
// Find the brightest-pixel X centroid in a horizontal band of rows (the basket
// rides near the bottom; the basket sprite is white). Returns -1 if no bright px.
function brightCentroidX(frame, y0, y1) {
  const { width, height, rgba } = frame;
  let sx = 0, n = 0;
  for (let y = y0; y < Math.min(y1, height); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // white basket: all channels high
      if (rgba[i] > 180 && rgba[i + 1] > 180 && rgba[i + 2] > 180) { sx += x; n++; }
    }
  }
  return n ? sx / n : -1;
}

// boot past the C-BIOS logo + a few game frames
for (let i = 0; i < 320; i++) h.stepFrames(1);

const sa = h.screenshotRgba();
writeFileSync(`${DIR}/shot_before.png`, Buffer.from(h.screenshot().pngBase64, "base64"));
// basket band: BASKET_Y=160 in a 192-tall internal buffer; band 150..180
const fracA = nonBlackFraction(sa.rgba);
const basketA = brightCentroidX(sa, Math.floor(sa.height * 0.78), Math.floor(sa.height * 0.95));
console.log(`before: ${sa.width}x${sa.height} nonBlack=${(fracA*100).toFixed(2)}% basketX=${basketA.toFixed(1)}`);

// Drive RIGHT for many frames
for (let i = 0; i < 120; i++) { h.setInput({ ports: [{ right: true }] }); h.stepFrames(1); }
const sb = h.screenshotRgba();
writeFileSync(`${DIR}/shot_after_right.png`, Buffer.from(h.screenshot().pngBase64, "base64"));
const basketB = brightCentroidX(sb, Math.floor(sb.height * 0.78), Math.floor(sb.height * 0.95));
console.log(`after RIGHT: basketX=${basketB.toFixed(1)}`);

// Drive LEFT for many frames
for (let i = 0; i < 200; i++) { h.setInput({ ports: [{ left: true }] }); h.stepFrames(1); }
const sc = h.screenshotRgba();
writeFileSync(`${DIR}/shot_after_left.png`, Buffer.from(h.screenshot().pngBase64, "base64"));
const basketC = brightCentroidX(sc, Math.floor(sc.height * 0.78), Math.floor(sc.height * 0.95));
console.log(`after LEFT: basketX=${basketC.toFixed(1)}`);

// ---- verdict ----
const visible = fracA > 0.005;            // playfield is not black
const movedRight = basketB > basketA + 5; // basket moved right with input
const movedLeft  = basketC < basketB - 5; // basket moved back left
console.log("VISIBLE:", visible, "MOVED_RIGHT:", movedRight, "MOVED_LEFT:", movedLeft);
if (visible && movedRight && movedLeft) {
  console.log("VERIFIED_OK");
} else {
  console.log("VERIFY_INCOMPLETE");
}
