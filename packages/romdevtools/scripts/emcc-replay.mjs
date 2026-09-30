#!/usr/bin/env node
// emcc-replay.mjs - rebuild a native build with emcc by replaying its log.
//
// Old toolchains (gcc 2.7.2, binutils 2.6) cannot be configured for an
// emscripten host: their build runs generator programs it just compiled, and
// libiberty probes the C library by linking test programs. So the build
// scripts configure and build them NATIVELY once (a build-time step only),
// which produces every generated source, and then this script replays the
// logged compile / archive commands with emcc and links the requested
// programs as WASM. Nothing native ships.
//
//   node emcc-replay.mjs --log make.log --native-cc "gcc <flags>" \
//        --emcc "emcc <flags>" --skip-source 'gen[a-z]*\.c' \
//        --link 'cc1=<dir>/out/cc1.js' ...
//
// The log must contain make's "Entering directory" lines (or --dir for a
// single-directory build). Compile lines are `<native-cc> ... -c ...`; archive
// lines are `ar ...`/`ranlib ...`; a link line is `<native-cc> ... -o NAME ...`
// for a NAME passed with --link (its output is renamed to the given path).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = { links: {}, skip: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--log") opt.log = args[++i];
  else if (a === "--native-cc") opt.nativeCc = args[++i];
  else if (a === "--emcc") opt.emcc = args[++i];
  else if (a === "--emcc-link") opt.emccLink = args[++i];
  else if (a === "--dir") opt.dir = args[++i];
  else if (a === "--skip-source") opt.skip.push(new RegExp(args[++i]));
  else if (a === "--link") { const [n, out] = args[++i].split("="); opt.links[n] = out; }
  else throw new Error(`unknown argument ${a}`);
}
for (const k of ["log", "nativeCc", "emcc"]) if (!opt[k]) throw new Error(`--${k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} is required`);

// Logical lines (backslash continuations joined) with the directory they ran in.
const raw = fs.readFileSync(opt.log, "utf8").split("\n");
const lines = [];
let dirStack = [opt.dir ?? process.cwd()];
for (let i = 0; i < raw.length; i++) {
  let l = raw[i];
  while (l.endsWith("\\") && i + 1 < raw.length) l = l.slice(0, -1) + " " + raw[++i].trim();
  const m = /^make(?:\[\d+\])?: (Entering|Leaving) directory [`'"](.*)['"]$/.exec(l.trim());
  if (m) { if (m[1] === "Entering") dirStack.push(m[2]); else dirStack.pop(); continue; }
  lines.push({ cmd: l.trim(), dir: dirStack[dirStack.length - 1] });
}

const run = (cmd, dir) => execFileSync("bash", ["-c", cmd], { cwd: dir, stdio: ["ignore", "inherit", "inherit"] });
const nat = opt.nativeCc.trim();
let compiled = 0, archived = 0;
const linked = new Set();
for (const { cmd, dir } of lines) {
  if (cmd.startsWith(nat + " ")) {
    // -g in a replayed line would carry DWARF into the shipped module.
    const rest = cmd.slice(nat.length).replace(/(\s)-g(?=\s|$)/g, "$1");
    if (/(^|\s)-c(\s|$)/.test(rest)) {
      const src = rest.split(/\s+/).find((w) => /\.c$/.test(w)) ?? "";
      if (opt.skip.some((re) => re.test(path.basename(src)))) continue;
      run(`${opt.emcc} ${rest}`, dir);
      compiled++;
      continue;
    }
    const out = /(?:^|\s)-o\s+(\S+)/.exec(rest)?.[1];
    if (out && opt.links[out] !== undefined) {
      const target = path.resolve(dir, opt.links[out]);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      run(`${opt.emccLink ?? opt.emcc} ${rest.replace(/(^|\s)-o\s+\S+/, ` -o ${JSON.stringify(target)}`)}`, dir);
      linked.add(out);
    }
    continue;
  }
  if (/^(ar|ranlib)\s/.test(cmd)) { run(cmd.replace(/^ar\s/, "emar ").replace(/^ranlib\s/, "emranlib "), dir); archived++; }
}
const missing = Object.keys(opt.links).filter((n) => !linked.has(n));
if (missing.length) { console.error(`emcc-replay: no link line found for ${missing.join(", ")}`); process.exit(1); }
console.log(`emcc-replay: ${compiled} compiled, ${archived} archive steps, linked ${[...linked].join(", ")}`);
