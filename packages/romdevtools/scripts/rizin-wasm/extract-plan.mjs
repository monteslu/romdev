#!/usr/bin/env node
// extract-plan.mjs - freeze a configured ninja build of rizin into plan.json.
//
// romdev builds rizin -> WASM without meson (meson is a Python program, and
// romdev's build is JS + WASM only). build.mjs drives emcc directly from
// plan.json: every compile, every archive, the final link, in order, with the
// exact flags. This script is how plan.json (and configured/) came to be: it
// reads `ninja -t commands binrz/rizin/rizin.js` from a build directory that was
// configured once for the pinned rizin commit, and writes:
//
//   plan.json     compile / archive / link steps, paths relative to the build dir
//   configured/   the configure-time headers the compiles include (plugin
//                 lists, rz_userconf.h, subproject config.h), copied verbatim
//
// It builds nothing: it only runs ninja's query tools (-t commands/deps/targets)
// and reads the files named above. Keep the output reviewable: a rizin bump
// shows up as a diff of plan.json + configured/ against the previous pin.
//
//   node scripts/rizin-wasm/extract-plan.mjs <configured-build-dir>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const buildDir = process.argv[2];
if (!buildDir || !existsSync(path.join(buildDir, "build.ninja"))) {
  console.error("usage: extract-plan.mjs <configured-build-dir containing build.ninja>");
  process.exit(2);
}

const TARGET = "binrz/rizin/rizin.js";
const cmds = execFileSync("ninja", ["-C", buildDir, "-t", "commands", TARGET], { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n").filter(Boolean);

// Archive members come from build.ninja (the _RSP rules hide them in an @file).
const ninja = readFileSync(path.join(buildDir, "build.ninja"), "utf8").replace(/\$\n\s*/g, "");
const archiveMembers = new Map();
for (const m of ninja.matchAll(/^build (\S+\.a): STATIC_LINKER(?:_RSP)? ([^|\n]*)/gm)) {
  archiveMembers.set(m[1], m[2].trim().split(/\s+/));
}

const flagSets = [];
const flagIndex = new Map();
const compile = [];
const archives = [];
let link = null;
const generated = [];

for (const line of cmds) {
  const argv = line.trim().split(/\s+/);
  if (argv[0] === "emcc" && argv.includes("-c")) {
    const flags = [];
    let out = null, src = null;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === "-MD") continue;
      if (a === "-MQ" || a === "-MF") { i++; continue; }
      if (a === "-o") { out = argv[++i]; continue; }
      if (a === "-c") { src = argv[++i]; continue; }
      flags.push(a);
    }
    const key = flags.join("\u0000");
    if (!flagIndex.has(key)) { flagIndex.set(key, flagSets.length); flagSets.push(flags); }
    compile.push({ src, out, flags: flagIndex.get(key) });
  } else if (argv[0] === "rm" && argv.includes("emar")) {
    const ar = argv.slice(argv.indexOf("emar"));
    const out = ar[2];
    const members = archiveMembers.get(out);
    if (!members) throw new Error(`no build.ninja edge for archive ${out}`);
    archives.push({ out, args: ar[1], members });
  } else if (argv[0] === "emcc" && argv.includes("-o")) {
    // Final link. The emscripten sysroot libz.a is found by path; keep it as a
    // placeholder so the plan carries no machine-specific path.
    link = argv.slice(1).filter((a) => a !== "").map((a) =>
      /\/sysroot\/lib\/wasm32-emscripten\/(lib[^/]+\.a)$/.test(a) ? `@SYSROOT_LIB@/${a.split("/").pop()}` : a);
  } else if (/cmd_descs_generate/.test(line)) {
    // rizin keeps the generated cmd_descs.[ch] checked in; the build copies them.
    generated.push({ kind: "copy", from: "../librz/core/cmd_descs/cmd_descs.c", to: "librz/core/cmd_descs/cmd_descs.c" });
    generated.push({ kind: "copy", from: "../librz/core/cmd_descs/cmd_descs.h", to: "librz/core/cmd_descs/cmd_descs.h" });
  } else if (/create_zip_err_str/.test(line)) {
    const [out, zipH, zipintH] = argv.slice(-3);
    generated.push({ kind: "zip_err_str", to: out, zipH, zipintH });
  } else {
    throw new Error(`unrecognised build step: ${line.slice(0, 200)}`);
  }
}
if (!link) throw new Error("no link step found");

// Configure-time files the compiles include (not ninja outputs). Found via the
// deps log: every build-dir-relative header a compile read.
const deps = execFileSync("ninja", ["-C", buildDir, "-t", "deps"], { encoding: "utf8", maxBuffer: 1 << 28 });
const ninjaOutputs = new Set(execFileSync("ninja", ["-C", buildDir, "-t", "targets", "all"], { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n").map((l) => l.replace(/: .*/, "")));
const genTargets = new Set(generated.map((g) => g.to));
const configured = [...new Set(deps.split("\n").filter((l) => /^ {4}[^/.]/.test(l)).map((l) => l.trim()))]
  .filter((f) => !ninjaOutputs.has(f) && !genTargets.has(f) && !f.includes("cross_native"))
  .sort();

// pcre2_chartables.c is meson's configure_file copy of the .dist table.
const copies = [];
for (const f of configured.filter((f) => f.endsWith("pcre2_chartables.c"))) {
  const dist = path.join("..", path.dirname(f), "src", "pcre2_chartables.c.dist");
  if (readFileSync(path.join(buildDir, f)).equals(readFileSync(path.join(buildDir, dist)))) copies.push({ kind: "copy", from: dist, to: f });
}
const vendored = configured.filter((f) => !copies.some((c) => c.to === f));

const CONF = path.join(HERE, "configured");
for (const f of vendored) {
  mkdirSync(path.dirname(path.join(CONF, f)), { recursive: true });
  copyFileSync(path.join(buildDir, f), path.join(CONF, f));
}

const emccVersion = execFileSync("emcc", ["--version"], { encoding: "utf8" }).split("\n")[0];
writeFileSync(path.join(HERE, "plan.json"), JSON.stringify({
  note: "rizin -> WASM build plan driven by build.mjs (no meson). Paths are relative to the build dir, which sits inside the rizin checkout. Regenerate with extract-plan.mjs only for a rizin pin bump. configured/ holds configure-time headers generated from the rizin (LGPL-3.0), libzip (BSD-3-Clause) and pcre2 (BSD-3-Clause) templates, under those projects' licenses.",
  target: TARGET,
  emcc: emccVersion,
  configured: vendored,
  generated: [...copies, ...generated],
  flagSets,
  compile,
  archives,
  link,
}, null, 0).replace(/\{"src"/g, "\n{\"src\"").replace(/\{"out"/g, "\n{\"out\"") + "\n");
console.log(`plan.json: ${compile.length} compiles, ${flagSets.length} flag sets, ${archives.length} archives; configured/ ${vendored.length} files; ${copies.length + generated.length} generated`);
