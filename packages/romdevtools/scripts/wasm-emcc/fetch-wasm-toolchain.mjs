#!/usr/bin/env node
// fetch-wasm-toolchain.mjs - set up the Python-free emcc toolchain under
// build/wasm-toolchain (gitignored), from the pins in scripts/versions.json
// (wasm_toolchain):
//   node_modules/@yowasp/clang   LLVM (clang, wasm-ld, llvm-ar, nm) as WASM
//   node_modules/binaryen        wasm-opt / wasm-metadce as WASM
//   emscripten/                  emscripten's tree at the emsdk pin: its JS
//                                compiler, libraries, system/ sources, headers
//                                (its .py files are never run)
//   sysroot/                     headers + system libraries + zlib port, built
//                                by system-libs.mjs with the WASM toolchain
//
//   node fetch-wasm-toolchain.mjs [--no-libs]

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { toolchainDir } from "./llvm.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const pins = JSON.parse(fs.readFileSync(path.join(here, "../versions.json"), "utf8")).wasm_toolchain;
const tc = toolchainDir();
fs.mkdirSync(tc, { recursive: true });

async function download(url, sha256, dest) {
  if (fs.existsSync(dest) && createHash("sha256").update(fs.readFileSync(dest)).digest("hex") === sha256) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`${url}: sha256 ${got} does not match the pin ${sha256}`);
  fs.writeFileSync(dest, buf);
  return dest;
}

// 1. npm packages (standalone project: not part of the romdev workspace)
fs.writeFileSync(path.join(tc, "package.json"), JSON.stringify({ name: "romdev-wasm-toolchain", private: true, type: "module", dependencies: pins.npm }, null, 2) + "\n");
execFileSync("npm", ["install", "--no-workspaces", "--no-audit", "--no-fund", "--no-save"], { cwd: tc, stdio: "inherit" });

// 2. emscripten tree at the pinned tag (+ acorn for its JS optimizer)
const ver = pins.emscripten.url.match(/tags\/([^/]+)\.tar\.gz$/)[1];
const emTar = await download(pins.emscripten.url, pins.emscripten.sha256, path.join(tc, `emscripten-${ver}.tar.gz`));
const emDir = path.join(tc, `emscripten-${ver}`);
if (!fs.existsSync(path.join(emDir, "emscripten-version.txt"))) execFileSync("tar", ["xzf", emTar, "-C", tc]);
fs.mkdirSync(path.join(emDir, "node_modules"), { recursive: true });
fs.cpSync(path.join(tc, "node_modules/acorn"), path.join(emDir, "node_modules/acorn"), { recursive: true });
const link = path.join(tc, "emscripten");
try { fs.unlinkSync(link); } catch {}
fs.symlinkSync(path.basename(emDir), link);

// 3. sysroot: headers, then libraries (unless --no-libs)
execFileSync(process.execPath, [path.join(here, "build-sysroot.mjs"), "headers"], { stdio: "inherit" });
if (!process.argv.includes("--no-libs")) {
  const zlibTar = await download(pins.zlib.url, pins.zlib.sha256, path.join(tc, "zlib-1.3.1.tar.gz"));
  execFileSync(process.execPath, [path.join(here, "system-libs.mjs"), "zlib", zlibTar], { stdio: "inherit" });
  execFileSync(process.execPath, [path.join(here, "system-libs.mjs"), "p4"], { stdio: "inherit" });
}
console.log(`wasm toolchain ready in ${tc}; put ${path.join(here, "bin")} on PATH (emcc, em++, emar, emranlib, emmake, emconfigure)`);
