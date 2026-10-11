// psx-setup.js - a PS1 decomp project's setup/extract chain as WASM + JS.
//
// The project ships its own tools, which romdev builds from the pinned tree
// (scripts/versions.json toolchains.psx_decomp_tools) and ships under neutral
// names. A recipe still invokes them by the project's own names (its tools/
// directory names, its Makefile variables and its wrapper script); those are
// mapped onto the shipped modules here:
//
//   psx-disk     (Go -> wasip1)  CD image (cue/bin) extractor
//   psx-assets   (Go -> wasip1)  asset extract/build, also reached through the
//                                 project's go-run wrapper script
//   psx-str      (Rust -> emscripten) string encoder in the compile pipeline;
//                                 dispatched by toolchain.js as a decomp tool
//
// and a few Python steps, ported here (identified by sha256 of the exact
// script, like recipe.js's PORTED_SCRIPTS):
//
//   tools/dirt_patcher.py <config/dirt.<ver>.json>   byte patches on a built file
//   tools/gfxstage.py d <F_*.BIN> <base> [--pal N]  stage graphics -> PNGs
//   tools/gfxstage.py e <base> <out>                PNGs -> stage graphics
//   tools/png2bin.py <in.png> <out>                 4bpp indexed PNG -> packed nibbles
//
// plus the shell-level forms gen.py's ninja rules write, which are plain file
// operations: `echo '{options: ...}' > $out` (dynamic splat config),
// `cat $in > $out` (concat) and `truncate -c -s N $out`.
//
// classifyPsxSetup(argv, cwd) recognises a command; runPsxSetup() runs it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readPng, writePng } from "./png-raw.js";

const HANDLER = fileURLToPath(new URL("./wasi-run.js", import.meta.url));

/** Go tools shipped as wasip1 modules in romdev-toolchain-decomp-gcc/wasm/tools. */
export const GO_TOOLS = ["psx-disk", "psx-assets"];

// The project names each Go tool <project>-disk / <project>-assets (its
// tools/<dir> and the binary its Makefile builds). A name of that shape maps to
// the shipped tool when the project has that Go package under tools/, so
// recipes that use the project's names keep working.
const PROJECT_GO_TOOL_RE = /^[a-z0-9]+-(disk|assets)$/;

/** The shipped Go tool a command name refers to (shipped or project name), or null. */
export function goToolFor(name, cwd = process.cwd()) {
  if (GO_TOOLS.includes(name)) return name;
  const m = PROJECT_GO_TOOL_RE.exec(name);
  if (m && fs.existsSync(path.join(cwd, "tools", name, "go.mod"))) return `psx-${m[1]}`;
  return null;
}

// The project's wrapper script and Python steps romdev runs, by sha256 of the
// exact bytes it was checked against.
const ASSETS_WRAPPER_SHA = ["a1afb51817ee468c46348f6322746106118ab5e47b0134dfab31643c151a1cf1"]; // go run ./tools/<assets tool> "$@"
const PORTED = {
  "dirt_patcher.py": { kind: "dirt-patcher", sha256: ["66902465b02e1675823fd97a3a481d5a285fe594d9ed572739ea47c5c7a4ca3a"] },
  "gfxstage.py": { kind: "gfxstage", sha256: ["3979f4cb0769c2a58ee42ac88bfe7f0d5525f1d29215ad4e527ba5489b4d1fc9"] },
  "png2bin.py": { kind: "png2bin", sha256: ["0f89eeb3c102972ca9ff2c19862a38f303d07ef58c06ee3b757603c471751a07"] },
};

function packageDir(pkg) {
  try {
    return path.dirname(fileURLToPath(import.meta.resolve(pkg)));
  } catch {
    const sibling = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", pkg);
    if (fs.existsSync(path.join(sibling, "package.json"))) return sibling;
    throw Object.assign(new Error(`${pkg} is not installed`), { code: "TOOLCHAIN_MISSING" });
  }
}

/** The shipped wasip1 module for a Go tool. */
export function goToolWasm(name) {
  if (!GO_TOOLS.includes(name)) throw new Error(`no WASM Go tool '${name}'`);
  const p = path.join(packageDir("romdev-toolchain-decomp-gcc"), "wasm", "tools", `${name}.wasm`);
  if (!fs.existsSync(p)) throw Object.assign(new Error(`${p} missing (scripts/build-decomp-go-tools.sh)`), { code: "TOOLCHAIN_MISSING" });
  return p;
}

let runIsolated = null;
/**
 * Run a Go tool (wasip1) in romdev's worker with `cwd` preopened at its own
 * path (plus `preopens`). Scratch stdio files go under tmpRoot.
 * @returns {Promise<{exitCode:number, stdout:string|Buffer, stderr:string, log:string, crash?:any}>}
 */
export async function goTool(name, args, { cwd, tmpRoot, env = {}, stdin, preopens = [], stdoutBinary = false, timeoutMs = 1_800_000 } = {}) {
  if (!runIsolated) ({ runIsolated } = await import("../toolchains/_worker/run.js"));
  const r = await runIsolated({
    handler: HANDLER, wasm: goToolWasm(name), argv: [name, ...args], cwd: path.resolve(cwd), env, preopens,
    tmpDir: path.resolve(tmpRoot ?? path.join(cwd, ".romdev-tmp")),
    stdinBase64: stdin ? Buffer.from(stdin).toString("base64") : undefined, stdoutBase64: stdoutBinary, timeoutMs,
  });
  if (r.crash || r.timedOut) return { exitCode: r.exitCode ?? -1, stdout: stdoutBinary ? Buffer.alloc(0) : "", stderr: r.log ?? "", log: r.log ?? "", crash: r.crash ?? { timedOut: true } };
  return { ...r, stdout: stdoutBinary ? Buffer.from(r.stdout ?? "", "base64") : r.stdout };
}

const sha256 = (f) => { try { return createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } catch { return null; } };
const PYTHON_RE = /(^|\/)(python[0-9.]*|pypy[0-9.]*)$/;

/**
 * Recognise a setup command of the PS1 project; null when it is not one.
 * @returns {null | {kind:string, tool?:string, args?:string[], script?:string, reason?:string}}
 */
export function classifyPsxSetup(argv, cwd = process.cwd()) {
  const prog = argv[0] ?? "", base = path.basename(prog);
  // the wrapper script ...  (checked by content: it must be the go-run wrapper)
  if (base.endsWith(".sh") && ASSETS_WRAPPER_SHA.includes(sha256(path.resolve(cwd, prog)))) {
    return { kind: "go-tool", tool: "psx-assets", args: argv.slice(1) };
  }
  if ((prog === "sh" || prog === "bash" || /\/(ba)?sh$/.test(prog)) && argv[1]?.endsWith(".sh") && ASSETS_WRAPPER_SHA.includes(sha256(path.resolve(cwd, argv[1])))) return classifyPsxSetup(argv.slice(1), cwd);
  // go run ./tools/<tool> ...  /  go run -C ... is not used by the project
  if (base === "go" && argv[1] === "run") {
    const pkg = argv[2] ?? "";
    const tool = goToolFor(path.basename(pkg.replace(/\/+$/, "")), cwd);
    if (tool && /^(\.\/)?tools\//.test(pkg)) return { kind: "go-tool", tool, args: argv.slice(3) };
    return { kind: "unsupported", reason: `go run ${pkg}: no WASM build of that package` };
  }
  // go build -C tools/<tool> -o <out> .  (the Makefile's disk-tool rule): the tool is shipped as WASM
  if (base === "go" && argv[1] === "build") {
    const c = argv.indexOf("-C");
    const tool = c > 0 ? goToolFor(path.basename(argv[c + 1] ?? ""), cwd) : null;
    if (tool) return { kind: "go-build-shipped", tool };
    return { kind: "unsupported", reason: `go build: no WASM build of ${argv.slice(2).join(" ")}` };
  }
  if (goToolFor(base, cwd)) return { kind: "go-tool", tool: goToolFor(base, cwd), args: argv.slice(1) };
  if (PYTHON_RE.test(prog)) {
    const script = argv.find((a, i) => i > 0 && !a.startsWith("-")) ?? "";
    const spec = PORTED[path.basename(script)];
    if (!spec) return null;
    const got = sha256(path.resolve(cwd, script));
    if (!spec.sha256.includes(got)) return { kind: "unsupported", reason: `${script} (sha256 ${got ?? "unreadable"}) is not the version romdev ported` };
    return { kind: spec.kind, script, args: argv.slice(argv.indexOf(script) + 1) };
  }
  if (base === "cat") return { kind: "psx-cat" };
  if (base === "truncate") return { kind: "psx-truncate" };
  return null;
}

/** Kinds classifyPsxSetup can return (recipe.js routes these to runPsxSetup). */
export const PSX_SETUP_KINDS = new Set(["go-tool", "go-build-shipped", "dirt-patcher", "gfxstage", "png2bin", "psx-cat", "psx-truncate"]);

/**
 * Run a classified setup command. Same result shape as recipe.js's runOne.
 * @returns {Promise<{code:number, log?:string, stdout?:Buffer}>}
 */
export async function runPsxSetup(argv, cls, { cwd, tmpRoot, stdin, env = {} }) {
  switch (cls.kind) {
    case "go-tool": {
      // A recipe may name paths outside the project (an absolute output
      // directory); the native tool reaches them, so the WASM one sees the
      // host tree too, at the same paths.
      const r = await goTool(cls.tool, cls.args, { cwd, tmpRoot, env, stdin, preopens: ["/"], stdoutBinary: true });
      return { code: r.exitCode, log: r.stderr ?? r.log, stdout: r.stdout };
    }
    case "go-build-shipped": return { code: 0, log: `${cls.tool}: shipped as WASM (romdev-toolchain-decomp-gcc), not built\n` };
    case "dirt-patcher": {
      const pos = cls.args.filter((a) => !a.startsWith("-"));
      if (pos.length !== 1) return { code: 2, log: `${cls.script}: expected 1 argument (config), got ${pos.length}\n` };
      try { dirtPatch(path.resolve(cwd, pos[0]), cwd); return { code: 0 }; }
      catch (e) { return { code: 1, log: `${cls.script}: ${e.message}\n` }; }
    }
    case "gfxstage": {
      // argparse: mode {e,d}, input, output, --pal N (default -1)
      const a = [...cls.args];
      let pal = -1;
      const pi = a.findIndex((x) => x === "--pal" || x.startsWith("--pal="));
      if (pi >= 0) { const v = a[pi].includes("=") ? a[pi].split("=")[1] : a[pi + 1]; pal = Number.parseInt(v, 10); a.splice(pi, a[pi].includes("=") ? 1 : 2); }
      if (a.length !== 3 || !["e", "d"].includes(a[0]) || Number.isNaN(pal)) return { code: 2, log: "usage: gfxstage.py [-h] [--pal PAL] {e,d} input output\n" };
      try {
        if (a[0] === "d") { gfxstageDecode(path.resolve(cwd, a[1]), path.resolve(cwd, a[2]), pal); return { code: 0 }; }
        // An input error is printed and the script still exits 0 without output.
        const err = gfxstageEncode(path.resolve(cwd, a[1]), path.resolve(cwd, a[2]));
        return { code: 0, log: err ? `ERROR: ${err}` : "" };
      } catch (e) { return { code: 1, log: `${cls.script}: ${e.message}\n` }; }
    }
    case "png2bin": {
      const pos = cls.args.filter((x) => !x.startsWith("-"));
      if (pos.length !== 2) return { code: 2, log: "usage: png2bin.py [-h] input output\n" };
      try { fs.writeFileSync(path.resolve(cwd, pos[1]), png2bin(path.resolve(cwd, pos[0]))); return { code: 0 }; }
      catch (e) { return { code: 1, log: `${cls.script}: ${e.message}\n` }; }
    }
    case "psx-cat": {
      const files = argv.slice(1).filter((a) => a !== "-");
      if (!files.length) return { code: 0, stdout: stdin ?? Buffer.alloc(0) };
      try { return { code: 0, stdout: Buffer.concat(files.map((f) => fs.readFileSync(path.resolve(cwd, f)))) }; }
      catch (e) { return { code: 1, log: `cat: ${e.message}\n` }; }
    }
    case "psx-truncate": return truncate(argv.slice(1), cwd);
    default: throw new Error(`psx-setup: no runner for ${cls.kind}`);
  }
}

/**
 * tools/dirt_patcher.py: for each patch {name, "0x<hex offset>": byte, ...}
 * write the byte at the offset of `name` (opened r+b: the file must exist;
 * an offset past the end extends it, the gap zero-filled, as a seek+write does).
 */
export function dirtPatch(configPath, cwd) {
  const patches = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const p of patches) {
    const file = path.resolve(cwd, p.name);
    const fd = fs.openSync(file, "r+");
    try {
      for (const [k, v] of Object.entries(p)) {
        if (!k.startsWith("0x")) continue;
        const off = parseInt(k.slice(2), 16);
        if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${p.name} ${k}: bytes([${v}]) is not a byte`);
        fs.writeSync(fd, Buffer.from([v]), 0, 1, off);
      }
    } finally { fs.closeSync(fd); }
  }
}

/** coreutils truncate: -s SIZE (absolute), -c/--no-create. */
function truncate(args, cwd) {
  let size = null, noCreate = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-c" || a === "--no-create") noCreate = true;
    else if (a === "-s") size = args[++i];
    else if (a.startsWith("--size=")) size = a.slice(7);
    else if (/^-s\d/.test(a)) size = a.slice(2);
    else if (a.startsWith("-")) return { code: 1, log: `truncate: unsupported option ${a}\n` };
    else files.push(a);
  }
  if (size == null || !/^\d+$/.test(size)) return { code: 1, log: `truncate: only an absolute -s SIZE is supported\n` };
  for (const f of files) {
    const p = path.resolve(cwd, f);
    if (!fs.existsSync(p)) { if (noCreate) continue; fs.writeFileSync(p, ""); }
    fs.truncateSync(p, Number(size));
  }
  return { code: 0 };
}

// -- tools/gfxstage.py -------------------------------------------------------
const CLUT_INDICES = [];
for (let k = 0; k < 4; k++) for (const base of [0x5c00, 0x7c00]) for (let j = 0; j < 2; j++) CLUT_INDICES.push(0x8000 * k + base + 0x20 * j);
const clutPosStart = (i) => CLUT_INDICES[i % 16] + 0x40 * Math.floor(i / 16);

/** A bytearray write that raises like Python's on an out-of-range index or value. */
function put(dst, i, v) {
  if (i < 0 || i >= dst.length) throw new Error("bytearray index out of range");
  if (v < 0 || v > 255) throw new Error("byte must be in range(0, 256)");
  dst[i] = v;
}

export function gfxstageDecode(inputFile, outputBase, palIdx = -1) {
  const src = fs.readFileSync(inputFile);
  const maxTilesets = src.length === 0x40000 ? 8 : 6;
  let pal;
  if (palIdx == null || palIdx < 0) pal = Array.from({ length: 16 }, (_, i) => [0x11 * i, 0x11 * i, 0x11 * i, 255]);
  else {
    const at = clutPosStart(palIdx);
    pal = Array.from({ length: 16 }, (_, i) => {
      const c = src[at + i * 2] | (src[at + i * 2 + 1] << 8);
      if (Number.isNaN(c)) throw new Error("index out of range");
      return [(c & 0x1f) << 3, ((c >> 5) & 0x1f) << 3, ((c >> 10) & 0x1f) << 3, ((c ^ 0x8000) >> 15) * 255];
    });
  }
  const copyQuadrant = (dst, h, srcIdx, dstQuad) => {
    const q = src.subarray(srcIdx * 128 * 64, srcIdx * 128 * 64 + 128 * 64);
    const dstIdx = (dstQuad & 1) * 64 + Math.floor(dstQuad / 2) * 128 * 128;
    for (let y = 0; y < h; y++) for (let x = 0; x < 64; x++) {
      const k = y * 0x40 + x;
      if (k >= q.length) throw new Error("index out of range");
      const ch = q[k];
      put(dst, dstIdx + y * 128 + x, ((ch & 0xf) << 4) | (ch >> 4));
    }
  };
  const tileset = (out, idx, hasClut) => {
    const width = 256, height = hasClut ? 240 : 256;
    const data = new Uint8Array(Math.ceil(width * height * 0.5));
    const hhh = hasClut ? 112 : 128;
    copyQuadrant(data, 128, idx * 4 + 0, 0);
    copyQuadrant(data, 128, idx * 4 + 1, 1);
    copyQuadrant(data, hhh, idx * 4 + 2, 2);
    copyQuadrant(data, hhh, idx * 4 + 3, 3);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // n64img CI4 (big-endian nibble order: high nibble is the left pixel)
    const px = new Uint8Array(width * height);
    for (let i = 0; i < data.length; i++) { px[i * 2] = data[i] >> 4; px[i * 2 + 1] = data[i] & 0xf; }
    fs.writeFileSync(out, writePng({ width, height, pixels: px, palette: pal }));
  };
  for (let i = 0; i < 4; i++) tileset(`${outputBase}_${i}.png`, i, true);
  for (let i = 4; i < maxTilesets; i++) tileset(`${outputBase}_${i}.png`, i, false);
  // the CLUT page as an n64img RGBA16 image, 16x256
  const img = new Uint8Array(16 * 256 * 2);
  for (let i = 0; i < 16; i++) for (let k = 0; k < 16; k++) {
    const at = CLUT_INDICES[k] + 0x40 * i, start = (i * 0x10 + k) * 32;
    for (let j = 0; j < 16; j++) {
      let c = src[at + j * 2] | (src[at + j * 2 + 1] << 8);
      c = ((c & 0x1f) << 11) | ((c & 0x3e0) << 1) | ((c & 0x7c00) >> 9) | ((c ^ 0x8000) >> 15);
      put(img, start + j * 2 + 1, c & 0xff);
      put(img, start + j * 2 + 0, (c >> 8) & 0xff);
    }
  }
  const px = new Uint8Array(16 * 256 * 4);
  for (let p = 0; p < 16 * 256; p++) {
    const v = (img[p * 2] << 8) | img[p * 2 + 1];
    const r = (v >> 11) & 0x1f, g = (v >> 6) & 0x1f, b = (v >> 1) & 0x1f;
    px[p * 4] = (r << 3) | (r >> 2); px[p * 4 + 1] = (g << 3) | (g >> 2); px[p * 4 + 2] = (b << 3) | (b >> 2); px[p * 4 + 3] = 255 * (v & 1);
  }
  fs.writeFileSync(`${outputBase}_clut.png`, writePng({ width: 16, height: 256, pixels: px, alpha: true }));
}

/** @returns {string|null} the script's error message (it prints it and writes nothing), or null. */
export function gfxstageEncode(inputBase, outputFile) {
  const data = new Uint8Array(0x40000);
  const encodeQuadrant = (start, rows, quad) => {
    const startRow = quad & 2 ? 128 : 0, startCol = quad & 1 ? 128 : 0;
    let y = 0;
    for (const full of rows.slice(startRow)) {
      const row = full.slice(startCol);
      for (let x = 0; x < 64; x++) {
        if (x * 2 + 1 >= row.length) throw new Error("list index out of range");
        put(data, start + y * 0x40 + x, (row[x * 2] & 0xf) | ((row[x * 2 + 1] & 0xf) << 4));
      }
      y++;
    }
  };
  for (let i = 0; i < 8; i++) {
    const file = `${inputBase}_${i}.png`;
    const { width, height, rows, info } = readPng(fs.readFileSync(file));
    const palette = info.palette;
    if (!palette) throw new Error("KeyError: 'palette'");
    if (width !== 256) return `'${file}' width must be 256 but found ${width} instead`;
    if (height !== 240 && height !== 256) return `'${file}' height must be 240 or 256 but found ${height} instead`;
    if (info.planes !== 1 || info.bitdepth !== 8) return `'${file}' must be an indexed image`;
    if (palette.length !== 16) return `'${file}' palette must be of 16 colors but found ${palette.length} colors instead`;
    for (let q = 0; q < 4; q++) encodeQuadrant((i * 4 + q) * 0x2000, rows, q);
  }
  const clut = `${inputBase}_clut.png`;
  const { width, height, rows, info } = readPng(fs.readFileSync(clut));
  if (width !== 16) return `'${clut}' width must be 16 but found ${width} instead`;
  if (height !== 256) return `'${clut}' width must be 256 but found ${height} instead`;
  if (info.planes !== 4 || info.bitdepth !== 8) return `'${clut}' must be a 32-bit RGBA image`;
  for (let i = 0; i < 16; i++) for (let k = 0; k < 16; k++) {
    const idx = CLUT_INDICES[k] + 0x40 * i, row = rows[i * 16 + k];
    for (let j = 0; j < 16; j++) {
      const r = row[j * 4], g = row[j * 4 + 1], b = row[j * 4 + 2];
      const a = row[j * 4 + 3] >= 64 ? 0 : 0x8000;
      const c = (r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10) | a;
      put(data, idx + j * 2, c & 0xff);
      put(data, idx + j * 2 + 1, (c >> 8) & 0xff);
    }
  }
  fs.writeFileSync(outputFile, data);
  return null;
}

// -- tools/png2bin.py --------------------------------------------------------
export function png2bin(file) {
  const { width, height, rows, info } = readPng(fs.readFileSync(file));
  const palette = info.palette;
  if (!palette) throw new Error("KeyError: 'palette'");
  // The script returns an error string and then fails writing it as bytes.
  const fail = (m) => { throw new Error(`${m} (TypeError: a bytes-like object is required, not 'str')`); };
  if (width !== 256) fail(`'${file}' width must be 256 but found ${width} instead`);
  if (height !== 128) fail(`'${file}' height must be 128 but found ${height} instead`);
  if (info.planes !== 1 || info.bitdepth !== 8) fail(`'${file}' must be an indexed image`);
  if (palette.length !== 16) fail(`'${file}' palette must be of 16 colors but found ${palette.length} colors instead`);
  const data = new Uint8Array((width * height) >> 1);
  let idx = 0, nibble = false;
  for (const row of rows) for (const ch of row) {
    if (!nibble) { nibble = true; put(data, idx, ch); }
    else { nibble = false; put(data, idx, data[idx] | (ch << 4)); idx++; }
  }
  return data;
}
