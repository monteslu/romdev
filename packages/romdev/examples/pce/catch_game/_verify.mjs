import fs from "node:fs";
import { buildForPlatform } from "/home/monteslu/code/cliemu/romdev/packages/romdev/src/toolchains/index.js";
import { resolveCore } from "/home/monteslu/code/cliemu/romdev/packages/romdev/src/cores/registry.js";
import { LibretroHost } from "/home/monteslu/code/cliemu/romdev/packages/romdev/src/host/LibretroHost.js";

const LIB = "/home/monteslu/code/cliemu/romdev/packages/romdev/src/platforms/pce/lib/c";
const DIR = "/home/monteslu/code/cliemu/romdev/packages/romdev/examples/pce/catch_game";

const read = (p) => fs.readFileSync(p, "utf8");

const sources = {
  "main.c": read(DIR + "/main.c"),
  "pce_video.c": read(LIB + "/pce_video.c"),
  "pce_input.c": read(LIB + "/pce_input.c"),
  "pce_sound.c": read(LIB + "/pce_sound.c"),
};
const headers = { "pce_hw.h": read(LIB + "/pce_hw.h") };

console.log("Building catch_game...");
const build = await buildForPlatform({
  platform: "pce",
  sources,
  headers,
  includes: headers,
  sourceName: "main.c",
});

if (!build || !build.binary) {
  console.log("BUILD FAILED");
  console.log(JSON.stringify(build, null, 2));
  process.exit(1);
}
console.log("BUILD OK, binary bytes =", build.binary.length);
if (build.log) console.log("log tail:", String(build.log).slice(-400));

const PLATFORM = "pce";
const h = new LibretroHost();
const c = resolveCore(PLATFORM);
await h.loadCore(c.jsPath, c.wasmPath);
await h.loadMedia({ platform: PLATFORM, bytes: build.binary });

// boot
for (let i = 0; i < 120; i++) h.stepFrames(1);

function nonBlack(shot) {
  const buf = Buffer.from(shot.pngBase64, "base64");
  // crude: count distinct-ish bytes; rely on file size + later pixel scan
  return buf.length;
}

// screenshot BEFORE input
let shotA = h.screenshot();
fs.writeFileSync(DIR + "/shot_before.png", Buffer.from(shotA.pngBase64, "base64"));
console.log("before:", shotA.width, "x", shotA.height, "png bytes", nonBlack(shotA));

// drive RIGHT for ~60 frames to move catcher and let fruit fall/catch
for (let i = 0; i < 90; i++) {
  h.setInput({ ports: [{ right: true }] });
  h.stepFrames(1);
}
// then LEFT for a bit
for (let i = 0; i < 60; i++) {
  h.setInput({ ports: [{ left: true }] });
  h.stepFrames(1);
}

let shotB = h.screenshot();
fs.writeFileSync(DIR + "/shot_after.png", Buffer.from(shotB.pngBase64, "base64"));
console.log("after:", shotB.width, "x", shotB.height, "png bytes", nonBlack(shotB));

// pixel diff: decode both PNGs to raw via the host's framebuffer if available
const same = shotA.pngBase64 === shotB.pngBase64;
console.log("identical PNG?", same);

console.log("done — see shot_before.png / shot_after.png");
