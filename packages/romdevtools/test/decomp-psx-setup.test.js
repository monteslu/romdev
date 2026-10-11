// A PS1 decomp project's setup chain in romdev: its Go tools as wasip1 WASM
// (shipped as psx-disk, psx-assets; recipes use the project names) run under
// node:wasi, its Rust string encoder (psx-str) as WASM in
// the compile pipeline, and JS ports of its Python steps (dirt_patcher,
// gfxstage, png2bin), all reached through recipe.js.
//
// The mechanisms are pinned here on synthetic inputs. The real chain (disc
// extraction checked against the project's config/check.<ver>.sha, asset
// extraction, every TU) needs the project and its disc, so those steps skip
// when PSX_DECOMP_TREE (a checkout with disks/us extracted) is not set.
process.env.ROM_DEV_WASM_POOL_SIZE ??= "3";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, "..", "build", "test-tmp", `decomp-psx-setup-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

const { classifyPsxSetup, dirtPatch, gfxstageDecode, gfxstageEncode, png2bin, goToolWasm } = await import("../src/decomp/psx-setup.js");
const { readPng, writePng } = await import("../src/decomp/png-raw.js");
const { runRecipeLine, classifyCommand } = await import("../src/decomp/recipe.js");
const { decompToolGlue } = await import("../src/decomp/toolchain.js");
const { shutdown } = await import("../src/toolchains/_worker/pool.js");

after(async () => { await shutdown(); if (!process.env.KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true }); });

function dir(name) { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; }
// The project's Go packages, which make its <project>-disk / <project>-assets names map to the shipped tools.
function projectTools(d, project) { for (const t of ["disk", "assets"]) { fs.mkdirSync(path.join(d, "tools", `${project}-${t}`), { recursive: true }); fs.writeFileSync(path.join(d, "tools", `${project}-${t}`, "go.mod"), "module x\n"); } }
const has = (f) => { try { f(); return true; } catch { return false; } };
const sha1 = (b) => createHash("sha1").update(b).digest("hex");

test("classify: the project's wrapper and scripts are recognised by content", () => {
  const d = dir("classify");
  projectTools(d, "sotn");
  fs.writeFileSync(path.join(d, "sotn.sh"), '#!/usr/bin/env sh\ngo run ./tools/sotn-assets "$@"');
  assert.deepEqual(classifyPsxSetup(["./sotn.sh", "extract-assets", "config/assets.us.yaml"], d), { kind: "go-tool", tool: "psx-assets", args: ["extract-assets", "config/assets.us.yaml"] });
  assert.equal(classifyPsxSetup(["go", "run", "./tools/sotn-assets", "build-assets", "x"], d).tool, "psx-assets");
  assert.equal(classifyPsxSetup(["bin/sotn-disk", "extract", "a.cue", "out"], d).tool, "psx-disk");
  assert.equal(classifyPsxSetup(["go", "build", "-C", "tools/sotn-disk", "-o", "../../bin/sotn-disk", "."], d).kind, "go-build-shipped");
  // a different wrapper is a different program
  fs.writeFileSync(path.join(d, "sotn.sh"), "#!/bin/sh\nexec something-else\n");
  assert.notEqual(classifyPsxSetup(["./sotn.sh", "x"], d)?.kind, "go-tool");
  // a name of the project shape without the project's Go package is not a shipped tool
  assert.equal(classifyPsxSetup(["bin/other-disk", "x"], d), null);
  // a script whose bytes differ from the ported one is not assumed to match it
  fs.mkdirSync(path.join(d, "tools"), { recursive: true });
  fs.writeFileSync(path.join(d, "tools/gfxstage.py"), "print('not it')\n");
  assert.equal(classifyPsxSetup([".venv/bin/python3", "tools/gfxstage.py", "d", "a", "b"], d).kind, "unsupported"); // no-python-guard: classifier fixture - a changed project script must classify as unsupported, never launched
  assert.equal(classifyPsxSetup(["python3", "tools/unrelated.py"], d), null); // no-python-guard: classifier fixture - an unknown script is not this module's to classify
  // the compile pipeline's encoder is a decomp tool
  assert.deepEqual(classifyCommand(["tools/sotn_str/target/release/sotn_str", "process"], d), { kind: "decomp-tool", tool: "psx-str" });
});

test("dirt_patcher: bytes at hex offsets, extending like seek+write", () => {
  const d = dir("dirt");
  fs.writeFileSync(path.join(d, "A.BIN"), Buffer.alloc(8, 0xee));
  fs.writeFileSync(path.join(d, "dirt.json"), JSON.stringify([{ name: "A.BIN", "0x2": 41, "0xA": 7, comment: "ignored" }]));
  dirtPatch(path.join(d, "dirt.json"), d);
  assert.deepEqual([...fs.readFileSync(path.join(d, "A.BIN"))], [0xee, 0xee, 41, 0xee, 0xee, 0xee, 0xee, 0xee, 0, 0, 7]);
  fs.writeFileSync(path.join(d, "bad.json"), JSON.stringify([{ name: "A.BIN", "0x0": 256 }]));
  assert.throws(() => dirtPatch(path.join(d, "bad.json"), d), /not a byte/);
});

test("png-raw: pypng's raw view (indexed + tRNS palette, RGBA, every row filter)", async () => {
  const pal = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i, i, i === 3 ? 0 : 255]);
  const px = Uint8Array.from({ length: 32 * 4 }, (_, i) => (i * 7) & 15);
  const r = readPng(writePng({ width: 32, height: 4, pixels: px, palette: pal }));
  assert.equal(r.info.bitdepth, 8); assert.equal(r.info.planes, 1);
  assert.deepEqual(r.info.palette, pal);
  assert.deepEqual(r.rows.flat(), [...px]);
  const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => i * 9);
  const q = readPng(writePng({ width: 3, height: 2, pixels: rgba, alpha: true }));
  assert.equal(q.info.planes, 4); assert.deepEqual(q.rows.flat(), [...rgba]);
  // rows written with each PNG filter by another encoder (pngjs)
  const { PNG } = await import("pngjs");
  const data = Buffer.from(Array.from({ length: 9 * 5 * 4 }, (_, i) => (i * 37 + (i >> 3) * 11) & 255));
  for (const filterType of [0, 1, 2, 3, 4]) {
    const buf = PNG.sync.write(Object.assign(new PNG({ width: 9, height: 5 }), { data }), { filterType, colorType: 6 });
    assert.deepEqual(readPng(buf).rows.flat(), [...data], `filter ${filterType}`);
  }
});

test("gfxstage: decode then encode reproduces a full 8-tileset stage graphics file; one pixel changes it", () => {
  const d = dir("gfx");
  const src = randomBytes(0x40000);
  fs.writeFileSync(path.join(d, "F_X.BIN"), src);
  gfxstageDecode(path.join(d, "F_X.BIN"), path.join(d, "out/x"), -1);
  for (let i = 0; i < 8; i++) assert.ok(fs.existsSync(path.join(d, `out/x_${i}.png`)));
  const clut = readPng(fs.readFileSync(path.join(d, "out/x_clut.png")));
  assert.equal(clut.width, 16); assert.equal(clut.height, 256); assert.equal(clut.info.planes, 4);
  assert.equal(gfxstageEncode(path.join(d, "out/x"), path.join(d, "F_X.out")), null);
  assert.equal(sha1(fs.readFileSync(path.join(d, "F_X.out"))), sha1(src));
  // the check can fail: flip one pixel of one tileset
  const t = readPng(fs.readFileSync(path.join(d, "out/x_5.png")));
  const px = Uint8Array.from(t.rows.flat()); px[1000] ^= 1;
  fs.writeFileSync(path.join(d, "out/x_5.png"), writePng({ width: t.width, height: t.height, pixels: px, palette: t.info.palette }));
  gfxstageEncode(path.join(d, "out/x"), path.join(d, "F_X.out"));
  const diff = [...fs.readFileSync(path.join(d, "F_X.out"))].filter((b, i) => b !== src[i]).length;
  assert.equal(diff, 1);
  // the script's input errors are reported and write nothing
  fs.writeFileSync(path.join(d, "out/x_2.png"), writePng({ width: 8, height: 8, pixels: new Uint8Array(64), palette: t.info.palette }));
  assert.match(gfxstageEncode(path.join(d, "out/x"), path.join(d, "F_Y.out")), /width must be 256 but found 8/);
  assert.ok(!fs.existsSync(path.join(d, "F_Y.out")));
});

test("png2bin: 256x128 indexed PNG to low-nibble-first packed bytes", () => {
  const d = dir("png2bin");
  const pal = Array.from({ length: 16 }, (_, i) => [i, i, i]);
  const px = Uint8Array.from({ length: 256 * 128 }, (_, i) => (i * 5 + (i >> 8)) & 15);
  fs.writeFileSync(path.join(d, "w.png"), writePng({ width: 256, height: 128, pixels: px, palette: pal }));
  const out = png2bin(path.join(d, "w.png"));
  assert.equal(out.length, 256 * 128 / 2);
  for (let i = 0; i < out.length; i++) assert.equal(out[i], px[i * 2] | (px[i * 2 + 1] << 4));
  fs.writeFileSync(path.join(d, "h.png"), writePng({ width: 256, height: 64, pixels: new Uint8Array(256 * 64), palette: pal }));
  assert.throws(() => png2bin(path.join(d, "h.png")), /height must be 128/);
});

test("recipe: gen.py's shell forms (cat > out, truncate -c -s, echo a dynamic splat config)", async () => {
  const d = dir("shell");
  fs.writeFileSync(path.join(d, "a"), "AA"); fs.writeFileSync(path.join(d, "b"), "BBB");
  assert.equal((await runRecipeLine("cat a b > ab && truncate -c -s 4 ab", { cwd: d, tmpRoot: d })).code, 0);
  assert.equal(fs.readFileSync(path.join(d, "ab"), "latin1"), "AABB");
  assert.equal((await runRecipeLine("truncate -c -s 16 nothere", { cwd: d, tmpRoot: d })).code, 0);
  assert.ok(!fs.existsSync(path.join(d, "nothere")));
  assert.equal((await runRecipeLine("echo '{options: { symbol_addrs_path: [ 'build/us/config/dyn_syms.dra.txt']}}' > dyn.yaml", { cwd: d, tmpRoot: d })).code, 0);
  assert.equal(fs.readFileSync(path.join(d, "dyn.yaml"), "utf8"), "{options: { symbol_addrs_path: [ build/us/config/dyn_syms.dra.txt]}}\n");
});

const havePsxStr = has(() => decompToolGlue("psx-str"));
test("psx-str (WASM) in a pipeline encodes _S/_S2 strings like its own unit tests", { skip: !havePsxStr && "psx-str WASM not built (scripts/build-decomp-rust-tools.sh psx-str)" }, async () => {
  const d = dir("sotnstr");
  fs.writeFileSync(path.join(d, "in.c"), '{_S("すで"), 1},\n_S2("ＡＴＴ")\nint x = 1;\n');
  const r = await runRecipeLine("cat in.c | tools/sotn_str/target/release/sotn_str process > out.c", { cwd: d, tmpRoot: d });
  assert.equal(r.code, 0, r.log);
  assert.equal(fs.readFileSync(path.join(d, "out.c"), "utf8"), '{"\\xBD\\xC3\\xFF\\x9E\\xFF", 1},\n"\\x00\\x01\\x01\\xFF"\nint x = 1;\n');
});

const haveGo = has(() => goToolWasm("psx-disk")) && has(() => goToolWasm("psx-assets"));
test("Go tools (wasip1) run under node:wasi in the project directory", { skip: !haveGo && "Go tools not built (scripts/build-decomp-go-tools.sh)" }, async () => {
  const d = dir("go");
  projectTools(d, "sotn");
  const r = await runRecipeLine("bin/sotn-disk list missing.cue", { cwd: d, tmpRoot: d });
  assert.notEqual(r.code, 0); // a missing image is an error, raised from inside the WASM tool
  assert.match(r.log, /missing\.cue/);
  const h = await runRecipeLine("./sotn.sh --help", { cwd: d, tmpRoot: d });
  assert.equal(h.code, 127); // no sotn.sh here: unreadable wrapper is unsupported
  fs.writeFileSync(path.join(d, "sotn.sh"), '#!/usr/bin/env sh\ngo run ./tools/sotn-assets "$@"');
  const h2 = await runRecipeLine("./sotn.sh --help", { cwd: d, tmpRoot: d });
  assert.equal(h2.code, 0, h2.log);
  assert.match(h2.log, /extract-assets/);
});

const TREE = process.env.PSX_DECOMP_TREE;
test("real project: extracted disc files match the project's check.us.sha", { skip: !TREE && "set PSX_DECOMP_TREE to a checkout with disks/sotn.us.cue" }, async () => {
  const out = path.join(TMP, "disc-us");
  const r = await runRecipeLine(`bin/sotn-disk extract disks/sotn.us.cue ${out}`, { cwd: TREE, tmpRoot: TMP });
  assert.equal(r.code, 0, r.log);
  const bySha = new Set();
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) e.isDirectory() ? walk(path.join(p, e.name)) : bySha.add(sha1(fs.readFileSync(path.join(p, e.name)))); };
  walk(out);
  const want = fs.readFileSync(path.join(TREE, "config/check.us.sha"), "utf8").split("\n").map((l) => l.split(/\s+/)[0]).filter((h) => /^[0-9a-f]{40}$/i.test(h));
  assert.ok(want.length > 100 && bySha.size > 200);
  assert.deepEqual(want.filter((h) => !bySha.has(h.toLowerCase())), []);
});
